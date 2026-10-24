import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'
import { emailFields, vOptions, vStatus } from './shared.js'

export default defineSchema({
  emails: defineTable({
    ...emailFields,
    /** Sent as the `Idempotency-Key` header, on the first attempt and every retry. */
    idempotencyKey: v.string(),
    status: vStatus,
    /** Groundmail's email id (`msg_…`), once the send is accepted. */
    groundmailId: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
    errorCode: v.optional(v.string()),
    /** Recipients Groundmail validation held back while the email went to the rest. */
    heldBack: v.optional(v.array(v.object({ email: v.string(), reason: v.string() }))),
    /** True on a test send: a `gm_test_…` key, or only simulator addresses. */
    test: v.optional(v.boolean()),
    attempts: v.number(),
    bounceType: v.optional(v.string()),
    complained: v.boolean(),
    opened: v.boolean(),
    clicked: v.boolean(),
    /** Set once the email can no longer change status, for cleanup. */
    finalizedAt: v.optional(v.number()),
    /**
     * While `queued`: when the next delivery attempt is due. While `sending`:
     * when the attempt started. The recovery cron uses it to find stalled emails.
     */
    deliveryDueAt: v.optional(v.number()),
    /** The send settings, stored once per distinct set rather than on every email. */
    optionsId: v.id('options'),
  })
    .index('by_idempotencyKey', ['idempotencyKey'])
    .index('by_groundmailId', ['groundmailId'])
    .index('by_finalizedAt', ['finalizedAt'])
    .index('by_status_deliveryDueAt', ['status', 'deliveryDueAt']),
  options: defineTable({
    ...vOptions.fields,
    /** The settings serialized, to find an existing row for the same settings. */
    fingerprint: v.string(),
  }).index('by_fingerprint', ['fingerprint']),
})
