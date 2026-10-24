import { v } from 'convex/values'
import type { FunctionHandle } from 'convex/server'
import { internal } from './_generated/api.js'
import type { Doc, Id } from './_generated/dataModel.js'
import {
  internalAction,
  internalMutation,
  mutation,
  query,
  type MutationCtx,
} from './_generated/server.js'
import {
  EMAIL_ID_TAG,
  MAX_USER_TAGS,
  attachmentContentType,
  emailFields,
  vEmailEvent,
  vOptions,
  vStatus,
  type EmailEvent,
  type RuntimeOptions,
  type Status,
} from './shared.js'

const FINAL_STATUSES: ReadonlySet<Status> = new Set([
  'delivered',
  'bounced',
  'failed',
  'suppressed',
  'cancelled',
  'unknown',
])

// How far along an email is. An event never moves an email back to an earlier
// status (an `email.sent` arriving after `email.delivered` changes nothing),
// but a bounce after delivery is recorded.
const STATUS_RANK: Record<Status, number> = {
  queued: 0,
  sending: 0,
  unknown: 1,
  scheduled: 1,
  held: 1,
  sent: 2,
  delivery_delayed: 3,
  delivered: 4,
  bounced: 5,
  failed: 5,
  suppressed: 5,
  cancelled: 6,
}

const EVENT_STATUS: Record<string, Status> = {
  'email.scheduled': 'scheduled',
  'email.held': 'held',
  'email.sent': 'sent',
  'email.delivery_delayed': 'delivery_delayed',
  'email.delivered': 'delivered',
  'email.bounced': 'bounced',
  'email.failed': 'failed',
  'email.suppressed': 'suppressed',
}

// Deleting finished emails is done in batches so one call stays well inside
// Convex's per-mutation limits.
const CLEANUP_BATCH_SIZE = 100

// The recovery cron re-sends emails whose delivery stalled: a `queued` email
// whose scheduled attempt never ran, or a `sending` email whose attempt never
// recorded a result (the action crashed or timed out). Convex actions time out
// after 10 minutes, so a `sending` email older than that is no longer in flight.
export const QUEUED_STALL_MS = 5 * 60 * 1000
export const SENDING_STALL_MS = 15 * 60 * 1000
const RECOVERY_BATCH_SIZE = 100

const vPublicEmail = v.object({
  ...emailFields,
  attachments: v.optional(
    v.array(
      v.object({
        filename: v.string(),
        contentType: v.optional(v.string()),
        contentId: v.optional(v.string()),
      }),
    ),
  ),
  id: v.id('emails'),
  createdAt: v.number(),
  idempotencyKey: v.string(),
  status: vStatus,
  groundmailId: v.union(v.string(), v.null()),
  errorMessage: v.union(v.string(), v.null()),
  errorCode: v.union(v.string(), v.null()),
  heldBack: v.union(v.array(v.object({ email: v.string(), reason: v.string() })), v.null()),
  test: v.boolean(),
  bounceType: v.union(v.string(), v.null()),
  complained: v.boolean(),
  opened: v.boolean(),
  clicked: v.boolean(),
  attempts: v.number(),
})

/**
 * Store an email and hand it to Groundmail in the background. Returns the
 * email's id in this component. With an `idempotencyKey` that was already used,
 * returns the existing email's id and sends nothing.
 */
export const sendEmail = mutation({
  args: {
    ...emailFields,
    idempotencyKey: v.optional(v.string()),
    options: vOptions,
  },
  returns: v.id('emails'),
  handler: async (ctx, args) => {
    const { idempotencyKey, options, ...email } = args
    if (email.to.length === 0) {
      throw new Error('`to` needs at least one recipient')
    }
    if (email.template && (email.html !== undefined || email.text !== undefined)) {
      throw new Error('Use either `template` or `html`/`text`, not both')
    }
    if (!email.template && email.html === undefined && email.text === undefined) {
      throw new Error('`html`, `text` or `template` is required')
    }
    if (!email.template && !email.subject) {
      throw new Error('`subject` is required unless a template supplies it')
    }
    if ((email.tags?.length ?? 0) > MAX_USER_TAGS) {
      throw new Error(`\`tags\` supports at most ${MAX_USER_TAGS} entries`)
    }
    if (email.tags?.some((tag) => tag.name === EMAIL_ID_TAG)) {
      throw new Error(`The \`${EMAIL_ID_TAG}\` tag is reserved`)
    }
    if (idempotencyKey !== undefined && (idempotencyKey.length === 0 || idempotencyKey.length > 200)) {
      throw new Error('`idempotencyKey` must be 1 to 200 characters')
    }

    if (idempotencyKey !== undefined) {
      const existing = await ctx.db
        .query('emails')
        .withIndex('by_idempotencyKey', (q) => q.eq('idempotencyKey', `key:${idempotencyKey}`))
        .unique()
      if (existing) return existing._id
    }

    const optionsId = await storeOptions(ctx, options)
    const emailId = await ctx.db.insert('emails', {
      ...email,
      // Without a caller key, a placeholder; replaced with one derived from the id below.
      idempotencyKey: idempotencyKey !== undefined ? `key:${idempotencyKey}` : '',
      status: 'queued',
      attempts: 0,
      complained: false,
      opened: false,
      clicked: false,
      deliveryDueAt: Date.now(),
      optionsId,
    })
    if (idempotencyKey === undefined) {
      await ctx.db.patch(emailId, { idempotencyKey: `id:${emailId}` })
    }
    await ctx.scheduler.runAfter(0, internal.lib.deliver, { emailId })
    return emailId
  },
})

/**
 * Cancel an email that has not been handed to Groundmail yet. Returns false
 * once delivery has started (`sending`), so a cancel and a send never both win.
 */
export const cancelEmail = mutation({
  args: { emailId: v.id('emails') },
  returns: v.boolean(),
  handler: async (ctx, { emailId }) => {
    const email = await ctx.db.get(emailId)
    if (!email || email.status !== 'queued') return false
    await ctx.db.patch(emailId, { status: 'cancelled', finalizedAt: Date.now() })
    return true
  },
})

export const get = query({
  args: { emailId: v.id('emails') },
  returns: v.union(vPublicEmail, v.null()),
  handler: async (ctx, { emailId }) => {
    const email = await ctx.db.get(emailId)
    return email ? toPublic(email) : null
  },
})

export const getByGroundmailId = query({
  args: { groundmailId: v.string() },
  returns: v.union(vPublicEmail, v.null()),
  handler: async (ctx, { groundmailId }) => {
    const email = await ctx.db
      .query('emails')
      .withIndex('by_groundmailId', (q) => q.eq('groundmailId', groundmailId))
      .first()
    return email ? toPublic(email) : null
  },
})

/**
 * Apply a verified webhook event to the email it belongs to, then call your
 * `onEmailEvent` mutation. Events for emails this component did not send are
 * ignored.
 */
export const handleEmailEvent = mutation({
  args: { event: vEmailEvent },
  returns: v.null(),
  handler: async (ctx, { event }) => {
    const email = await findEmailForEvent(ctx, event)
    if (!email) return null

    const data = (event.data ?? {}) as Record<string, unknown>
    const patch: Partial<Doc<'emails'>> = {}
    const groundmailId = typeof data.email_id === 'string' ? data.email_id : undefined
    if (!email.groundmailId && groundmailId) patch.groundmailId = groundmailId

    const next = EVENT_STATUS[event.type]
    if (next && email.status !== 'cancelled' && STATUS_RANK[next] >= STATUS_RANK[email.status]) {
      patch.status = next
      // An `unknown` email that turns out to be sent is in flight again.
      patch.finalizedAt = FINAL_STATUSES.has(next) ? Date.now() : undefined
    }
    if (event.type === 'email.bounced' || event.type === 'email.failed') {
      if (typeof data.bounce_type === 'string') patch.bounceType = data.bounce_type
      if (typeof data.bounce_reason === 'string') patch.errorMessage = data.bounce_reason
    }
    if (event.type === 'email.held' && typeof data.held_reason === 'string') {
      patch.errorMessage = data.held_reason
    }
    if (event.type === 'email.complained') patch.complained = true
    if (event.type === 'email.opened') patch.opened = true
    if (event.type === 'email.clicked') patch.clicked = true

    if (Object.keys(patch).length > 0) await ctx.db.patch(email._id, patch)

    await runOnEmailEvent(ctx, await ctx.db.get(email.optionsId), email._id, event)
    return null
  },
})

/**
 * Delete finished emails (delivered, bounced, failed, suppressed or cancelled)
 * that finished more than `olderThan` ms ago (default 7 days). Reschedules
 * itself until every match is gone.
 */
export const cleanupOldEmails = mutation({
  args: { olderThan: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, { olderThan }) => {
    await deleteFinishedBefore(ctx, Date.now() - (olderThan ?? 7 * 24 * 60 * 60 * 1000))
    return null
  },
})

export const cleanupOldEmailsBatch = internalMutation({
  args: { cutoff: v.number() },
  returns: v.null(),
  handler: async (ctx, { cutoff }) => {
    await deleteFinishedBefore(ctx, cutoff)
    return null
  },
})

/**
 * Move a `queued` email to `sending` and return it with its send settings, or
 * null if it is no longer queued (cancelled, or another attempt claimed it).
 * Runs right before the request, so `cancelEmail` can't cancel an email that
 * is being sent.
 */
export const claimForDelivery = internalMutation({
  args: { emailId: v.id('emails') },
  handler: async (ctx, { emailId }) => {
    const email = await ctx.db.get(emailId)
    if (!email || email.status !== 'queued') return null
    const options = await ctx.db.get(email.optionsId)
    if (!options) return null
    await ctx.db.patch(emailId, { status: 'sending', deliveryDueAt: Date.now() })
    return { email, options }
  },
})

/** Run by the component's cron: re-sends emails whose delivery stalled. */
export const recoverStalledEmails = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now()
    const queued = await ctx.db
      .query('emails')
      .withIndex('by_status_deliveryDueAt', (q) => q.eq('status', 'queued').lt('deliveryDueAt', now - QUEUED_STALL_MS))
      .take(RECOVERY_BATCH_SIZE)
    for (const email of queued) {
      await ctx.db.patch(email._id, { deliveryDueAt: now })
      await ctx.scheduler.runAfter(0, internal.lib.deliver, { emailId: email._id })
    }

    const sending = await ctx.db
      .query('emails')
      .withIndex('by_status_deliveryDueAt', (q) =>
        q.eq('status', 'sending').lt('deliveryDueAt', now - SENDING_STALL_MS),
      )
      .take(RECOVERY_BATCH_SIZE)
    for (const email of sending) {
      const options = await ctx.db.get(email.optionsId)
      const attempts = email.attempts + 1
      // The stalled attempt may have reached Groundmail. Retrying with the same
      // Idempotency-Key is safe: Groundmail answers with the first result.
      if (options && attempts <= options.retryAttempts) {
        await ctx.db.patch(email._id, {
          status: 'queued',
          attempts,
          deliveryDueAt: now,
          errorMessage: 'A delivery attempt did not finish; retrying',
        })
        await ctx.scheduler.runAfter(0, internal.lib.deliver, { emailId: email._id })
      } else {
        await ctx.db.patch(email._id, {
          status: 'unknown',
          attempts,
          deliveryDueAt: undefined,
          errorMessage: 'Delivery attempts did not finish, so it is not known whether the email was sent',
          finalizedAt: now,
        })
      }
    }
    return null
  },
})

const vAttemptResult = v.union(
  v.object({
    kind: v.literal('accepted'),
    groundmailId: v.string(),
    status: v.string(),
    heldBack: v.optional(v.array(v.object({ email: v.string(), reason: v.string() }))),
    test: v.optional(v.boolean()),
  }),
  v.object({
    kind: v.literal('retry'),
    message: v.string(),
    code: v.optional(v.string()),
  }),
  v.object({
    kind: v.literal('rejected'),
    message: v.string(),
    code: v.optional(v.string()),
  }),
  v.object({
    kind: v.literal('unknown'),
    message: v.string(),
    code: v.optional(v.string()),
  }),
)

/** Send one email to `POST /emails`. Retries reuse the same `Idempotency-Key`. */
export const deliver = internalAction({
  args: { emailId: v.id('emails') },
  returns: v.null(),
  handler: async (ctx, { emailId }) => {
    const claim = await ctx.runMutation(internal.lib.claimForDelivery, { emailId })
    if (!claim) return null
    const { email, options } = claim

    let result: typeof vAttemptResult.type
    try {
      const response = await fetch(`${options.baseUrl.replace(/\/$/, '')}/emails`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': email.idempotencyKey,
          'User-Agent': 'groundmail-convex',
        },
        body: JSON.stringify(toRequestBody(email)),
      })
      result = await readResponse(response)
    } catch (error) {
      result = {
        kind: 'retry',
        message: `Could not reach Groundmail: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
    await ctx.runMutation(internal.lib.recordAttempt, { emailId, result })
    return null
  },
})

export const recordAttempt = internalMutation({
  args: { emailId: v.id('emails'), result: vAttemptResult },
  returns: v.null(),
  handler: async (ctx, { emailId, result }) => {
    const email = await ctx.db.get(emailId)
    if (!email) return null
    const options = await ctx.db.get(email.optionsId)
    const attempts = email.attempts + 1

    if (result.kind === 'accepted') {
      const status = acceptedStatus(result.status)
      await ctx.db.patch(emailId, {
        attempts,
        groundmailId: result.groundmailId,
        // A webhook may already have moved the email further along.
        status: STATUS_RANK[status] >= STATUS_RANK[email.status] ? status : email.status,
        heldBack: result.heldBack?.length ? result.heldBack : undefined,
        test: result.test || undefined,
        errorMessage: undefined,
        errorCode: undefined,
        deliveryDueAt: undefined,
      })
      return null
    }

    // Only the attempt that claimed the email decides what happens next. (The
    // recovery cron may have taken over a stalled attempt that later finished.)
    if (email.status !== 'sending') {
      await ctx.db.patch(emailId, { attempts })
      return null
    }

    if (result.kind === 'retry' && options && attempts <= options.retryAttempts) {
      const backoff = options.initialBackoffMs * 2 ** (attempts - 1)
      await ctx.db.patch(emailId, {
        attempts,
        status: 'queued',
        deliveryDueAt: Date.now() + backoff,
        errorMessage: result.message,
        errorCode: result.code,
      })
      await ctx.scheduler.runAfter(backoff, internal.lib.deliver, { emailId })
      return null
    }

    if (result.kind === 'unknown') {
      // Groundmail may still deliver it, and replays this answer for the same
      // Idempotency-Key, so a retry would change nothing. Webhook events update it.
      await ctx.db.patch(emailId, {
        attempts,
        status: 'unknown',
        errorMessage: result.message,
        errorCode: result.code,
        deliveryDueAt: undefined,
        finalizedAt: Date.now(),
      })
      return null
    }

    await ctx.db.patch(emailId, {
      attempts,
      status: 'failed',
      errorMessage: result.message,
      errorCode: result.code,
      deliveryDueAt: undefined,
      finalizedAt: Date.now(),
    })
    await runOnEmailEvent(ctx, options, emailId, {
      type: 'email.failed',
      created_at: new Date().toISOString(),
      data: {
        email_id: null,
        to: email.to,
        status: 'failed',
        bounce_reason: result.message,
        error_code: result.code ?? null,
      },
    })
    return null
  },
})

/** The send settings row for these options, created the first time they are used. */
async function storeOptions(ctx: MutationCtx, options: RuntimeOptions): Promise<Id<'options'>> {
  const fingerprint = JSON.stringify([
    options.apiKey,
    options.baseUrl,
    options.retryAttempts,
    options.initialBackoffMs,
    options.onEmailEvent?.fnHandle ?? null,
  ])
  const existing = await ctx.db
    .query('options')
    .withIndex('by_fingerprint', (q) => q.eq('fingerprint', fingerprint))
    .first()
  if (existing) return existing._id
  return ctx.db.insert('options', { ...options, fingerprint })
}

async function runOnEmailEvent(
  ctx: MutationCtx,
  options: Doc<'options'> | null,
  id: Id<'emails'>,
  event: EmailEvent,
) {
  if (!options?.onEmailEvent) return
  const handle = options.onEmailEvent.fnHandle as FunctionHandle<'mutation', { id: Id<'emails'>; event: EmailEvent }>
  await ctx.runMutation(handle, { id, event })
}

async function deleteFinishedBefore(ctx: MutationCtx, cutoff: number) {
  const old = await ctx.db
    .query('emails')
    .withIndex('by_finalizedAt', (q) => q.gt('finalizedAt', 0).lt('finalizedAt', cutoff))
    .take(CLEANUP_BATCH_SIZE)
  for (const email of old) await ctx.db.delete(email._id)
  if (old.length === CLEANUP_BATCH_SIZE) {
    await ctx.scheduler.runAfter(0, internal.lib.cleanupOldEmailsBatch, { cutoff })
  }
}

async function findEmailForEvent(ctx: MutationCtx, event: EmailEvent) {
  const data = (event.data ?? {}) as Record<string, unknown>
  const tags = Array.isArray(data.tags) ? (data.tags as Array<{ name?: unknown; value?: unknown }>) : []
  const tagged = tags.find((tag) => tag?.name === EMAIL_ID_TAG && typeof tag.value === 'string')
  if (tagged) {
    const id = ctx.db.normalizeId('emails', tagged.value as string)
    const email = id ? await ctx.db.get(id) : null
    if (email) return email
  }
  if (typeof data.email_id === 'string') {
    return ctx.db
      .query('emails')
      .withIndex('by_groundmailId', (q) => q.eq('groundmailId', data.email_id as string))
      .first()
  }
  return null
}

function acceptedStatus(apiStatus: string): Status {
  if (apiStatus === 'scheduled') return 'scheduled'
  if (apiStatus === 'held') return 'held'
  return 'sent'
}

function toRequestBody(email: Doc<'emails'>) {
  const body: Record<string, unknown> = {
    from: email.from,
    to: email.to,
    tags: [...(email.tags ?? []), { name: EMAIL_ID_TAG, value: email._id }],
  }
  if (email.cc?.length) body.cc = email.cc
  if (email.bcc?.length) body.bcc = email.bcc
  if (email.replyTo?.length) body.reply_to = email.replyTo
  if (email.subject !== undefined) body.subject = email.subject
  if (email.html !== undefined) body.html = email.html
  if (email.text !== undefined) body.text = email.text
  if (email.template) body.template = email.template
  if (email.headers) body.headers = email.headers
  if (email.attachments?.length) {
    body.attachments = email.attachments.map((attachment) => ({
      filename: attachment.filename,
      content: attachment.content,
      content_type: attachmentContentType(attachment),
      ...(attachment.contentId ? { content_id: attachment.contentId } : {}),
    }))
  }
  if (email.scheduledAt) body.scheduled_at = email.scheduledAt
  if (email.category) body.category = email.category
  if (email.tenant) body.tenant = email.tenant
  if (email.unsubscribe !== undefined) body.unsubscribe = email.unsubscribe
  return body
}

async function readResponse(response: Response): Promise<typeof vAttemptResult.type> {
  const text = await response.text()
  let json: Record<string, unknown> | null = null
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : null
  } catch {
    json = null
  }

  if (response.ok && json && typeof json.id === 'string') {
    const heldBack = Array.isArray(json.held_back)
      ? (json.held_back as Array<{ email: string; reason: string }>).map(({ email, reason }) => ({
          email: String(email),
          reason: String(reason),
        }))
      : undefined
    return {
      kind: 'accepted',
      groundmailId: json.id,
      status: typeof json.status === 'string' ? json.status : 'queued',
      heldBack,
      test: json.test === true ? true : undefined,
    }
  }

  const error = (json?.error ?? {}) as { message?: unknown; code?: unknown }
  const message = typeof error.message === 'string' ? error.message : `Groundmail returned HTTP ${response.status}`
  const code = typeof error.code === 'string' ? error.code : undefined
  // 504: the mail server may or may not have taken the email. Groundmail keeps
  // this answer under the Idempotency-Key and replays it, so it is not retried.
  if (response.status === 504) return { kind: 'unknown', message, code }
  // 409: the same key is still being processed. 429: rate limited. Other 5xx:
  // nothing was sent, and Groundmail releases the key, so a retry sends it.
  const retryable = response.status === 409 || response.status === 429 || response.status >= 500
  return { kind: retryable ? 'retry' : 'rejected', message, code }
}

function toPublic(email: Doc<'emails'>) {
  return {
    id: email._id,
    createdAt: email._creationTime,
    from: email.from,
    to: email.to,
    cc: email.cc,
    bcc: email.bcc,
    replyTo: email.replyTo,
    subject: email.subject,
    html: email.html,
    text: email.text,
    template: email.template,
    tags: email.tags,
    headers: email.headers,
    // File content is left out to keep reactive queries small.
    attachments: email.attachments?.map(({ filename, contentType, contentId }) => ({
      filename,
      contentType,
      contentId,
    })),
    scheduledAt: email.scheduledAt,
    category: email.category,
    tenant: email.tenant,
    unsubscribe: email.unsubscribe,
    idempotencyKey: email.idempotencyKey.replace(/^(key|id):/, ''),
    status: email.status,
    groundmailId: email.groundmailId ?? null,
    errorMessage: email.errorMessage ?? null,
    errorCode: email.errorCode ?? null,
    heldBack: email.heldBack ?? null,
    test: email.test ?? false,
    bounceType: email.bounceType ?? null,
    complained: email.complained,
    opened: email.opened,
    clicked: email.clicked,
    attempts: email.attempts,
  }
}
