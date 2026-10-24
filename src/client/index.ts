import {
  createFunctionHandle,
  type FunctionReference,
  type FunctionVisibility,
  type GenericActionCtx,
  type GenericDataModel,
  type GenericMutationCtx,
  type GenericQueryCtx,
} from 'convex/server'
import { v, type VString } from 'convex/values'
import type { ComponentApi } from '../component/_generated/component.js'
import { vEmailEvent, type EmailEvent, type Status } from '../component/shared.js'

export type GroundmailComponent = ComponentApi

export type EmailId = string & { __isEmailId: true }
export const vEmailId = v.string() as VString<EmailId>
export { vEmailEvent, vStatus } from '../component/shared.js'
export type { EmailEvent, Status } from '../component/shared.js'

/** Validator for the arguments of your `onEmailEvent` mutation. */
export const vOnEmailEventArgs = v.object({
  id: vEmailId,
  event: vEmailEvent,
})

export const DEFAULT_API_BASE_URL = 'https://api.groundmail.dev'

type RunQueryCtx = Pick<GenericQueryCtx<GenericDataModel>, 'runQuery'>
type RunMutationCtx = Pick<GenericMutationCtx<GenericDataModel>, 'runMutation'>
type RunActionCtx = Pick<GenericActionCtx<GenericDataModel>, 'runMutation'>

export type OnEmailEvent = FunctionReference<'mutation', FunctionVisibility, { id: EmailId; event: EmailEvent }>

export type GroundmailOptions = {
  /** Your `gm_…` API key. Defaults to the `GROUNDMAIL_API_KEY` environment variable. */
  apiKey?: string
  /**
   * The signing secret of your webhook endpoint (`whsec_…`). Defaults to the
   * `GROUNDMAIL_WEBHOOK_SECRET` environment variable.
   */
  webhookSecret?: string
  /** Defaults to `https://api.groundmail.dev`. */
  baseUrl?: string
  /**
   * How many times to retry a send that failed for a temporary reason (network
   * error, rate limit, server error). Every retry reuses the same
   * `Idempotency-Key`, so an email is never sent twice. Default 5.
   */
  retryAttempts?: number
  /** Wait before the first retry; doubles on each retry. Default 10 seconds. */
  initialBackoffMs?: number
  /** A mutation run for every delivery event of an email sent by this component. */
  onEmailEvent?: OnEmailEvent | null
}

export type EmailAddress = string | { email: string; name?: string }

type EmailBase = {
  from: EmailAddress
  to: string | string[]
  cc?: string | string[]
  bcc?: string | string[]
  replyTo?: string | string[]
  /** Up to 9 tags. They come back on every webhook event for the email. */
  tags?: Array<{ name: string; value: string }> | Record<string, string>
  headers?: Record<string, string>
  /** Base64 file content. Keep the total small: the email is stored in your Convex database first. */
  attachments?: Array<{
    filename: string
    content: string
    /** MIME type. Inferred from the filename's extension when left out. */
    contentType?: string
    contentId?: string
  }>
  /** Send later: an ISO 8601 date-time, or a Date. */
  scheduledAt?: string | Date
  category?: 'transactional' | 'product' | 'newsletter'
  /** Send as one of your tenants (its external id). */
  tenant?: string
  /** Add managed unsubscribe to this email. */
  unsubscribe?: boolean
  /**
   * Dedupes sends. A second `sendEmail` with the same key returns the first
   * email's id and sends nothing. Use something tied to the event, such as
   * `welcome:${userId}`. Max 200 characters.
   */
  idempotencyKey?: string
}

export type SendEmailOptions =
  | (EmailBase & { subject: string; html?: string; text?: string; template?: never })
  | (EmailBase & {
      subject?: string
      template: { id: string; variables?: Record<string, string | number | boolean> }
      html?: never
      text?: never
    })

export type EmailStatus = {
  status: Status
  /** Why it bounced, failed or was held, when known. */
  errorMessage: string | null
  /** `hard` or `block` on a bounce. */
  bounceType: string | null
  complained: boolean
  opened: boolean
  clicked: boolean
  /** Groundmail's email id (`msg_…`), once the send is accepted. */
  groundmailId: string | null
}

/**
 * Send transactional email from Convex with Groundmail.
 *
 * ```ts
 * export const groundmail = new Groundmail(components.groundmail);
 * await groundmail.sendEmail(ctx, { from, to, subject, html });
 * ```
 */
export class Groundmail {
  constructor(
    public component: GroundmailComponent,
    public options: GroundmailOptions = {},
  ) {}

  /**
   * Store the email and send it in the background. Call it from a mutation: if
   * the mutation fails, nothing is sent. Returns an id to look the email up by.
   */
  async sendEmail(ctx: RunMutationCtx | RunActionCtx, email: SendEmailOptions): Promise<EmailId> {
    const apiKey = this.options.apiKey ?? process.env.GROUNDMAIL_API_KEY
    if (!apiKey) {
      throw new Error('Set GROUNDMAIL_API_KEY in your Convex environment, or pass apiKey to new Groundmail()')
    }
    const id = await ctx.runMutation(this.component.lib.sendEmail, {
      from: email.from,
      to: toList(email.to),
      cc: email.cc === undefined ? undefined : toList(email.cc),
      bcc: email.bcc === undefined ? undefined : toList(email.bcc),
      replyTo: email.replyTo === undefined ? undefined : toList(email.replyTo),
      subject: email.subject,
      html: email.html,
      text: email.text,
      template: email.template,
      tags: toTags(email.tags),
      headers: email.headers,
      attachments: email.attachments,
      scheduledAt: email.scheduledAt instanceof Date ? email.scheduledAt.toISOString() : email.scheduledAt,
      category: email.category,
      tenant: email.tenant,
      unsubscribe: email.unsubscribe,
      idempotencyKey: email.idempotencyKey,
      options: {
        apiKey,
        baseUrl: this.options.baseUrl ?? DEFAULT_API_BASE_URL,
        retryAttempts: this.options.retryAttempts ?? 5,
        initialBackoffMs: this.options.initialBackoffMs ?? 10_000,
        onEmailEvent: this.options.onEmailEvent
          ? { fnHandle: await createFunctionHandle(this.options.onEmailEvent) }
          : undefined,
      },
    })
    return id as EmailId
  }

  /**
   * Cancel an email that is still `queued`. Returns false once sending has
   * started, so an email is never both sent and recorded as cancelled.
   */
  async cancelEmail(ctx: RunMutationCtx | RunActionCtx, emailId: EmailId): Promise<boolean> {
    return ctx.runMutation(this.component.lib.cancelEmail, { emailId })
  }

  /** The stored email with its current status, or null. */
  async get(ctx: RunQueryCtx, emailId: EmailId) {
    return ctx.runQuery(this.component.lib.get, { emailId })
  }

  /** Look an email up by Groundmail's email id (`msg_…`). */
  async getByGroundmailId(ctx: RunQueryCtx, groundmailId: string) {
    return ctx.runQuery(this.component.lib.getByGroundmailId, { groundmailId })
  }

  /** The delivery status of an email, or null. */
  async status(ctx: RunQueryCtx, emailId: EmailId): Promise<EmailStatus | null> {
    const email = await this.get(ctx, emailId)
    if (!email) return null
    return {
      status: email.status,
      errorMessage: email.errorMessage,
      bounceType: email.bounceType,
      complained: email.complained,
      opened: email.opened,
      clicked: email.clicked,
      groundmailId: email.groundmailId,
    }
  }

  /**
   * Handle a Groundmail webhook delivery in an HTTP action: checks the
   * `Groundmail-Signature` header, updates the email's status and runs your
   * `onEmailEvent` mutation.
   *
   * ```ts
   * http.route({
   *   path: "/groundmail-webhook",
   *   method: "POST",
   *   handler: httpAction((ctx, req) => groundmail.handleGroundmailEventWebhook(ctx, req)),
   * });
   * ```
   */
  async handleGroundmailEventWebhook(ctx: RunActionCtx, req: Request): Promise<Response> {
    const secret = this.options.webhookSecret ?? process.env.GROUNDMAIL_WEBHOOK_SECRET
    if (!secret) {
      throw new Error(
        'Set GROUNDMAIL_WEBHOOK_SECRET in your Convex environment, or pass webhookSecret to new Groundmail()',
      )
    }
    const body = await req.text()
    if (!(await verifyWebhookSignature(secret, body, req.headers.get('groundmail-signature')))) {
      return new Response('Invalid signature', { status: 401 })
    }

    let event: { type?: unknown; created_at?: unknown; data?: unknown }
    try {
      event = JSON.parse(body)
    } catch {
      return new Response('Invalid JSON', { status: 400 })
    }
    if (typeof event.type !== 'string') {
      return new Response('Missing event type', { status: 400 })
    }

    // Inbound mail, unsubscribes and automation events are not about an email this component sent.
    if (event.type.startsWith('email.') && event.type !== 'email.received') {
      await ctx.runMutation(this.component.lib.handleEmailEvent, {
        event: {
          type: event.type,
          created_at: typeof event.created_at === 'string' ? event.created_at : new Date().toISOString(),
          data: event.data ?? {},
        },
      })
    }
    return new Response(null, { status: 200 })
  }

  /**
   * Delete emails that finished (delivered, bounced, failed, suppressed or
   * cancelled) more than `olderThan` ms ago. Default 7 days. Run it from a cron.
   */
  async cleanupOldEmails(ctx: RunMutationCtx | RunActionCtx, olderThan?: number): Promise<void> {
    await ctx.runMutation(this.component.lib.cleanupOldEmails, { olderThan })
  }
}

/**
 * Check a `Groundmail-Signature` header (`t=…,v1=…`): HMAC-SHA256 over
 * `${t}.${rawBody}` with the endpoint secret, at most `toleranceSec` old.
 * Uses Web Crypto, so it runs in Convex's default runtime.
 */
export async function verifyWebhookSignature(
  secret: string,
  payload: string,
  header: string | null | undefined,
  toleranceSec = 300,
): Promise<boolean> {
  if (!header) return false
  const parts = Object.fromEntries(
    header.split(',').map((part) => {
      const [key, value] = part.trim().split('=')
      return [key, value]
    }),
  ) as Record<string, string | undefined>
  const timestamp = Number(parts.t)
  const signature = parts.v1
  if (!timestamp || !signature || !/^[0-9a-f]{64}$/i.test(signature)) return false
  if (Math.abs(Math.floor(Date.now() / 1000) - timestamp) > toleranceSec) return false

  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'verify',
  ])
  const bytes = new Uint8Array(32)
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(signature.slice(i * 2, i * 2 + 2), 16)
  return crypto.subtle.verify('HMAC', key, bytes, encoder.encode(`${timestamp}.${payload}`))
}

function toList(value: string | string[]): string[] {
  return Array.isArray(value) ? value : [value]
}

function toTags(tags: SendEmailOptions['tags']): Array<{ name: string; value: string }> | undefined {
  if (tags === undefined) return undefined
  return Array.isArray(tags) ? tags : Object.entries(tags).map(([name, value]) => ({ name, value }))
}
