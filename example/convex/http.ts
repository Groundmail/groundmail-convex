import { httpRouter } from 'convex/server'
import { httpAction } from './_generated/server.js'
import { groundmail } from './example.js'

const http = httpRouter()

http.route({
  path: '/groundmail-webhook',
  method: 'POST',
  handler: httpAction((ctx, req) => groundmail.handleGroundmailEventWebhook(ctx, req)),
})

export default http
