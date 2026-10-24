import { v, type Infer } from 'convex/values'

/**
 * Where an email is in its life:
 * - `queued`: stored in your Convex database, waiting to be handed to Groundmail.
 * - `sending`: being handed to Groundmail right now; it can no longer be cancelled.
 * - `scheduled`: Groundmail accepted it with `scheduledAt` and will send it then.
 * - `sent`: Groundmail accepted it for delivery.
 * - `delivered`: the recipient's mailbox provider accepted it.
 * - `delivery_delayed`: the receiving server deferred it; Groundmail keeps trying.
 * - `held`: held before sending (content scanning, or sending paused on the account).
 * - `bounced`: the message bounced.
 * - `failed`: it could not be sent (a rejected request, or delivery failed).
 * - `suppressed`: a recipient is on your suppression list, so it was not sent.
 * - `cancelled`: you cancelled it before it was handed to Groundmail.
 * - `unknown`: Groundmail could not confirm whether it was sent (HTTP 504), or
 *   delivery kept stalling until retries ran out. It is not retried, so it is
 *   never sent twice; a later webhook event updates it if it went out.
 */
export const vStatus = v.union(
  v.literal('queued'),
  v.literal('sending'),
  v.literal('scheduled'),
  v.literal('sent'),
  v.literal('delivered'),
  v.literal('delivery_delayed'),
  v.literal('held'),
  v.literal('bounced'),
  v.literal('failed'),
  v.literal('suppressed'),
  v.literal('cancelled'),
  v.literal('unknown'),
)
export type Status = Infer<typeof vStatus>

export const vTag = v.object({ name: v.string(), value: v.string() })

export const vTemplate = v.object({
  id: v.string(),
  variables: v.optional(v.record(v.string(), v.union(v.string(), v.number(), v.boolean()))),
})
export type Template = Infer<typeof vTemplate>

export const vAttachment = v.object({
  filename: v.string(),
  /** Base64-encoded file content. */
  content: v.string(),
  /** MIME type. When left out, it is inferred from the filename's extension. */
  contentType: v.optional(v.string()),
  contentId: v.optional(v.string()),
})

export const vCategory = v.union(v.literal('transactional'), v.literal('product'), v.literal('newsletter'))

/** The email fields sent to `POST /emails`. */
export const vFrom = v.union(v.string(), v.object({ email: v.string(), name: v.optional(v.string()) }))

export const emailFields = {
  from: vFrom,
  to: v.array(v.string()),
  cc: v.optional(v.array(v.string())),
  bcc: v.optional(v.array(v.string())),
  replyTo: v.optional(v.array(v.string())),
  subject: v.optional(v.string()),
  html: v.optional(v.string()),
  text: v.optional(v.string()),
  template: v.optional(vTemplate),
  tags: v.optional(v.array(vTag)),
  headers: v.optional(v.record(v.string(), v.string())),
  attachments: v.optional(v.array(vAttachment)),
  scheduledAt: v.optional(v.string()),
  category: v.optional(vCategory),
  tenant: v.optional(v.string()),
  unsubscribe: v.optional(v.boolean()),
}

export const vOptions = v.object({
  apiKey: v.string(),
  baseUrl: v.string(),
  retryAttempts: v.number(),
  initialBackoffMs: v.number(),
  onEmailEvent: v.optional(v.object({ fnHandle: v.string() })),
})
export type RuntimeOptions = Infer<typeof vOptions>

const CONTENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  txt: 'text/plain',
  csv: 'text/csv',
  html: 'text/html',
  htm: 'text/html',
  ics: 'text/calendar',
  json: 'application/json',
  xml: 'application/xml',
  zip: 'application/zip',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
}

/** The attachment's MIME type: `contentType` if set, else inferred from the filename. */
export function attachmentContentType(attachment: { filename: string; contentType?: string }): string {
  if (attachment.contentType?.trim()) return attachment.contentType
  const dot = attachment.filename.lastIndexOf('.')
  const extension = dot === -1 ? '' : attachment.filename.slice(dot + 1).toLowerCase()
  return CONTENT_TYPES[extension] ?? 'application/octet-stream'
}

/**
 * A Groundmail webhook event, as posted to your endpoint. `data` carries the
 * fields documented at https://docs.groundmail.dev/api/webhooks.
 */
export const vEmailEvent = v.object({
  type: v.string(),
  created_at: v.string(),
  data: v.any(),
})
export type EmailEvent = Infer<typeof vEmailEvent>

/** Tag carrying the component's email id, so webhook events match their email. */
export const EMAIL_ID_TAG = 'convex_email_id'

/** Groundmail accepts at most 10 tags; one is used for {@link EMAIL_ID_TAG}. */
export const MAX_USER_TAGS = 9
