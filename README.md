<p align="center">
  <a href="https://groundmail.dev">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://app.groundmail.dev/images/github/readme-logo-dark.png">
      <img alt="Groundmail" src="https://app.groundmail.dev/images/github/readme-logo-light.png" height="44">
    </picture>
  </a>
</p>

<h1 align="center">Groundmail for Convex</h1>

<p align="center">
  A <a href="https://www.convex.dev/components">Convex component</a> for sending transactional email with Groundmail.<br>
  Durable sends from mutations, idempotent retries, and delivery status from webhooks.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@groundmail/convex"><img alt="npm" src="https://img.shields.io/npm/v/@groundmail/convex?color=a3461f&label=npm"></a>
  <a href="./LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-b48f62"></a>
</p>

<p align="center">
  <a href="https://docs.groundmail.dev/frameworks/convex">Docs</a> ·
  <a href="https://app.groundmail.dev/signup">Get a free account</a> ·
  <a href="https://groundmail.dev">groundmail.dev</a>
</p>

---

[`@groundmail/convex`](https://www.npmjs.com/package/@groundmail/convex) is a [Convex component](https://www.convex.dev/components) for sending transactional email with Groundmail. Call `sendEmail` from a mutation; the component stores the email in your Convex database, sends it in the background, retries temporary failures without ever sending twice, and keeps each email's delivery status current from Groundmail webhooks.

- **Durable:** the email is queued in the same transaction as the rest of your mutation. If the mutation fails, nothing is sent.
- **Idempotent:** pass an `idempotencyKey` and a second send with the same key returns the first email. Every retry to Groundmail carries the same `Idempotency-Key` header.
- **Delivery status:** delivered, bounced, complained, opened and clicked, queryable and reactive like any Convex data.

## 1. Install

```bash
npm install @groundmail/convex
```

Add the component to your app in `convex/convex.config.ts`:

```ts
import { defineApp } from 'convex/server'
import groundmail from '@groundmail/convex/convex.config.js'

const app = defineApp()
app.use(groundmail)

export default app
```

Set your API key on the deployment (create one under **API Keys** in the dashboard; a `gm_test_…` key sends nothing, which is handy in development):

```bash
npx convex env set GROUNDMAIL_API_KEY gm_your_key_here
```

The `from` address must be on a domain you have [verified in Groundmail](https://docs.groundmail.dev/domains).

## 2. Send an email

```ts
// convex/emails.ts
import { Groundmail } from '@groundmail/convex'
import { components } from './_generated/api'
import { mutation } from './_generated/server'
import { v } from 'convex/values'

export const groundmail = new Groundmail(components.groundmail)

export const sendWelcome = mutation({
  args: { userId: v.id('users') },
  handler: async (ctx, { userId }) => {
    const user = await ctx.db.get(userId)
    if (!user) throw new Error('No such user')
    return groundmail.sendEmail(ctx, {
      from: { email: 'hello@yourdomain.com', name: 'Acme' },
      to: user.email,
      subject: 'Welcome to Acme',
      html: '<p>Thanks for signing up.</p>',
      tags: { user_id: userId },
      idempotencyKey: `welcome:${userId}`,
    })
  },
})
```

`sendEmail` returns an id for the email. You can also send a [published template](https://docs.groundmail.dev/templates) with `template: { id, variables }` instead of `html`/`text`, and set `cc`, `bcc`, `replyTo`, `headers`, `attachments`, `scheduledAt`, `category`, `tenant` and `unsubscribe` as in the [send API](https://docs.groundmail.dev/emails).

### Idempotency

With `idempotencyKey`, a second `sendEmail` with the same key returns the first email's id and sends nothing, so a retried mutation or a double-clicked button sends one email. Use a key tied to what caused the email, such as `welcome:${userId}` or `receipt:${orderId}`.

Without a key, each call is a new email, and the component still gives it its own `Idempotency-Key` so retries to Groundmail never send it twice.

### Retries

Network errors, rate limits (`429`) and server errors (`500`, `502`, `503`) are retried with backoff: 5 retries by default, starting at 10 seconds and doubling. Each retry carries the same `Idempotency-Key`, and Groundmail releases the key after these errors, so a retry really sends the email, once. A rejected request (an unverified `from` domain, a suppressed recipient, an invalid address) is not retried; the email's status becomes `failed` with Groundmail's error message and code.

A `504` means the mail server may still deliver the email. Groundmail keeps that answer under the `Idempotency-Key` and returns it again for 24 hours, so the component does not retry: the status becomes `unknown`, and a later webhook event (`email.sent`, `email.delivered`, …) moves it on if the email went out. Check `groundmailId`, or the email log in the dashboard, before sending it again yourself.

If a delivery attempt stalls (the background action crashes or times out before it records a result), a cron inside the component picks the email up after a few minutes and tries again with the same `Idempotency-Key`. Stalled attempts count toward `retryAttempts`; when they run out, the status becomes `unknown`.

```ts
const groundmail = new Groundmail(components.groundmail, {
  retryAttempts: 3,
  initialBackoffMs: 5_000,
})
```

## 3. Check delivery status

```ts
// convex/emails.ts
import type { EmailId } from '@groundmail/convex'
import { query } from './_generated/server'

export const emailStatus = query({
  args: { emailId: v.string() },
  handler: async (ctx, { emailId }) => groundmail.status(ctx, emailId as EmailId),
})
```

`status` returns `{ status, errorMessage, bounceType, complained, opened, clicked, groundmailId }`. `status` is one of:

| Status | Meaning |
|--------|---------|
| `queued` | Stored, about to be sent to Groundmail |
| `sending` | Being handed to Groundmail; can no longer be cancelled |
| `scheduled` | Accepted with `scheduledAt`; it goes out then |
| `sent` | Accepted for delivery |
| `delivery_delayed` | The receiving server deferred it; delivery continues |
| `delivered` | Accepted by the recipient's mailbox provider |
| `held` | Held before sending: by content scanning, or while sending is paused |
| `bounced` | Bounced; `bounceType` is `hard` or `block` |
| `failed` | Rejected by the API, out of retries, or delivery failed |
| `suppressed` | A recipient is on your suppression list |
| `cancelled` | Cancelled with `cancelEmail` before it was sent |
| `unknown` | Groundmail could not confirm whether it was sent (see [Retries](#retries)); webhooks update it |

`groundmail.get(ctx, emailId)` returns the whole stored email, and `groundmail.cancelEmail(ctx, emailId)` cancels one that is still `queued`. It returns `false` once sending has started, so an email is never both sent and recorded as cancelled.

Without webhooks, statuses stop at `sent`. Set up step 4 to get the rest.

## 4. Receive delivery webhooks

Add an HTTP route in `convex/http.ts`:

```ts
import { httpRouter } from 'convex/server'
import { httpAction } from './_generated/server'
import { groundmail } from './emails'

const http = httpRouter()

http.route({
  path: '/groundmail-webhook',
  method: 'POST',
  handler: httpAction((ctx, req) => groundmail.handleGroundmailEventWebhook(ctx, req)),
})

export default http
```

Then create a webhook endpoint pointing at your deployment's HTTP actions URL (it ends in `.convex.site`), in the dashboard under **Webhooks** or with the CLI:

```bash
groundmail webhooks create --url https://your-deployment.convex.site/groundmail-webhook
```

Copy the signing secret (`whsec_…`, shown once) to your deployment:

```bash
npx convex env set GROUNDMAIL_WEBHOOK_SECRET whsec_your_secret
```

The handler checks the `Groundmail-Signature` header, rejects requests older than 5 minutes, and updates the email the event belongs to. Events for email your app sent another way are ignored. See [Webhooks](https://docs.groundmail.dev/webhooks) for every event and its fields.

### React to events

Pass a mutation as `onEmailEvent` to run your own code on each event, for example to flag a user whose address hard-bounced:

```ts
import { Groundmail, vOnEmailEventArgs } from '@groundmail/convex'
import { components, internal } from './_generated/api'
import { internalMutation } from './_generated/server'

export const groundmail: Groundmail = new Groundmail(components.groundmail, {
  onEmailEvent: internal.emails.handleEmailEvent,
})

export const handleEmailEvent = internalMutation({
  args: vOnEmailEventArgs,
  handler: async (ctx, { id, event }) => {
    if (event.type === 'email.bounced' && event.data.bounce_type === 'hard') {
      // Mark the address as undeliverable in your users table.
    }
  },
})
```

`event` is the webhook payload: `{ type, created_at, data }`. `data.tags` holds the tags you sent, so a `user_id` tag tells you who the email was for. When a send is rejected or runs out of retries, `onEmailEvent` also gets an `email.failed` event with `data.bounce_reason` set to the error.

## 5. Clean up old emails

Emails stay in your Convex database until you delete them. Delete finished ones (delivered, bounced, failed, suppressed, cancelled) on a schedule:

```ts
// convex/crons.ts
import { cronJobs } from 'convex/server'
import { internal } from './_generated/api'
import { internalMutation } from './_generated/server'
import { groundmail } from './emails'

export const cleanupEmails = internalMutation({
  args: {},
  handler: async (ctx) => {
    await groundmail.cleanupOldEmails(ctx, 7 * 24 * 60 * 60 * 1000)
  },
})

const crons = cronJobs()
crons.daily('clean up sent emails', { hourUTC: 4, minuteUTC: 0 }, internal.crons.cleanupEmails)
export default crons
```

## Options

| Option | Default | |
|--------|---------|---|
| `apiKey` | `GROUNDMAIL_API_KEY` | Your `gm_…` API key |
| `webhookSecret` | `GROUNDMAIL_WEBHOOK_SECRET` | Your webhook endpoint's signing secret |
| `retryAttempts` | `5` | Retries for temporary failures |
| `initialBackoffMs` | `10000` | Wait before the first retry; doubles each time |
| `onEmailEvent` | none | A mutation run on each delivery event |

## Testing

Use a `gm_test_…` key, or send to [simulator addresses](https://docs.groundmail.dev/testing#simulator-addresses) such as `bounce@simulator.groundmail.dev`, to see the whole flow, webhooks included, without delivering anything.

To unit-test your own functions with [`convex-test`](https://www.npmjs.com/package/convex-test), register the component:

```ts
import { convexTest } from 'convex-test'
import groundmailTest from '@groundmail/convex/test'

const t = convexTest(schema, modules)
groundmailTest.register(t)
```

## Notes

- An attachment without `contentType` gets one from its filename extension (`.pdf` is `application/pdf`, and so on), or `application/octet-stream` when the extension is not recognized.
- Your API key is stored in the component's tables in your Convex deployment, once per distinct set of options rather than on every email, because sends run in the background where your environment variables are not available. It is never returned by `get` or `status`.
- Keep attachments small. The email is stored in your Convex database before it is sent, and a Convex document is limited to 1 MB.
- Up to 9 tags per email. The component adds one more to match webhook events to the email.

## License

MIT
