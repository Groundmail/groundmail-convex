import { cronJobs } from 'convex/server'
import { internal } from './_generated/api.js'

const crons = cronJobs()

// Re-send emails whose delivery stalled (see `recoverStalledEmails`).
crons.interval('recover stalled emails', { minutes: 5 }, internal.lib.recoverStalledEmails)

export default crons
