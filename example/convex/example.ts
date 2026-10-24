import { Groundmail, vOnEmailEventArgs, type EmailId } from '../../src/client/index.js'
import { components, internal } from './_generated/api.js'
import { internalMutation, mutation, query } from './_generated/server.js'
import { v } from 'convex/values'

export const groundmail: Groundmail = new Groundmail(components.groundmail, {
  onEmailEvent: internal.example.handleEmailEvent,
})

export const sendWelcome = mutation({
  args: { to: v.string(), userId: v.string() },
  handler: async (ctx, { to, userId }) => {
    return groundmail.sendEmail(ctx, {
      from: { email: 'hello@mail.example.com', name: 'Example' },
      to,
      subject: 'Welcome',
      html: '<p>Thanks for signing up.</p>',
      tags: { user_id: userId },
      idempotencyKey: `welcome:${userId}`,
    })
  },
})

export const status = query({
  args: { emailId: v.string() },
  handler: async (ctx, { emailId }) => groundmail.status(ctx, emailId as EmailId),
})

export const handleEmailEvent = internalMutation({
  args: vOnEmailEventArgs,
  handler: async (_ctx, { id, event }) => {
    console.log('email event', id, event.type)
  },
})
