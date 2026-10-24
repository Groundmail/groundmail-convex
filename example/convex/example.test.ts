import { createHmac } from 'node:crypto'
import { convexTest } from 'convex-test'
import type { FunctionReference } from 'convex/server'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { verifyWebhookSignature, type EmailId } from '../../src/client/index.js'
import groundmailTest from '../../src/test.js'
import { api, components } from './_generated/api.js'
import { groundmail } from './example.js'

const modules = import.meta.glob('./**/*.ts')
const SECRET = 'whsec_test'

function setup() {
  const t = convexTest(undefined, modules)
  groundmailTest.register(t)
  return t
}

function sign(body: string, timestamp = Math.floor(Date.now() / 1000)) {
  const v1 = createHmac('sha256', SECRET).update(`${timestamp}.${body}`).digest('hex')
  return `t=${timestamp},v1=${v1}`
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function postWebhook(t: ReturnType<typeof setup>, event: unknown, signature?: string) {
  const body = JSON.stringify(event)
  return t.fetch('/groundmail-webhook', {
    method: 'POST',
    headers: { 'Groundmail-Signature': signature ?? sign(body) },
    body,
  })
}

let fetchMock: ReturnType<typeof vi.fn>
let events: Array<{ id: string; type: string }>

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubEnv('GROUNDMAIL_API_KEY', 'gm_live_test')
  vi.stubEnv('GROUNDMAIL_WEBHOOK_SECRET', SECRET)
  fetchMock = vi.fn(async () => json(200, { id: 'msg_1', status: 'queued' }))
  vi.stubGlobal('fetch', fetchMock)
  events = []
  vi.spyOn(console, 'log').mockImplementation((_label, id, type) => {
    events.push({ id, type })
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function send(t: ReturnType<typeof setup>, userId = 'u_1') {
  const id = (await t.mutation(api.example.sendWelcome, { to: 'ada@example.com', userId })) as EmailId
  await t.finishAllScheduledFunctions(vi.runAllTimers)
  return id
}

async function email(t: ReturnType<typeof setup>, id: EmailId) {
  return t.run((ctx) => groundmail.get(ctx, id))
}

describe('sendEmail', () => {
  test('posts the email with the API key, an Idempotency-Key and the email id tag', async () => {
    const t = setup()
    const id = await send(t)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.groundmail.dev/emails')
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer gm_live_test')
    expect(headers['Idempotency-Key']).toBe('key:welcome:u_1')
    expect(JSON.parse(init.body as string)).toEqual({
      from: { email: 'hello@mail.example.com', name: 'Example' },
      to: ['ada@example.com'],
      subject: 'Welcome',
      html: '<p>Thanks for signing up.</p>',
      tags: [
        { name: 'user_id', value: 'u_1' },
        { name: 'convex_email_id', value: id },
      ],
    })

    const stored = await email(t, id)
    expect(stored).toMatchObject({ status: 'sent', groundmailId: 'msg_1', attempts: 1, idempotencyKey: 'welcome:u_1' })
  })

  test('the same idempotency key returns the first email and sends once', async () => {
    const t = setup()
    const first = await send(t, 'u_2')
    const second = await send(t, 'u_2')
    expect(second).toBe(first)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('without a key, each email gets its own Idempotency-Key', async () => {
    const t = setup()
    const id = await t.run((ctx) =>
      groundmail.sendEmail(ctx, { from: 'a@mail.example.com', to: 'b@example.com', subject: 'Hi', text: 'Hi' }),
    )
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    const headers = (fetchMock.mock.calls[0] as [string, RequestInit])[1].headers as Record<string, string>
    expect(headers['Idempotency-Key']).toBe(`id:${id}`)
  })

  test('retries temporary errors with the same Idempotency-Key', async () => {
    const t = setup()
    fetchMock
      .mockImplementationOnce(async () => json(503, { error: { message: 'Try again', code: 'upstream_error' } }))
      .mockImplementationOnce(async () => {
        throw new TypeError('network down')
      })
    const id = await send(t)

    expect(fetchMock).toHaveBeenCalledTimes(3)
    const keys = fetchMock.mock.calls.map(
      (call) => ((call as [string, RequestInit])[1].headers as Record<string, string>)['Idempotency-Key'],
    )
    expect(new Set(keys)).toEqual(new Set(['key:welcome:u_1']))
    expect(await email(t, id)).toMatchObject({ status: 'sent', attempts: 3, errorMessage: null })
  })

  test('a rejected send is failed and reported to onEmailEvent', async () => {
    const t = setup()
    fetchMock.mockImplementation(async () =>
      json(403, { error: { message: 'From domain is not verified', code: 'forbidden' } }),
    )
    const id = await send(t)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(await email(t, id)).toMatchObject({
      status: 'failed',
      errorMessage: 'From domain is not verified',
      errorCode: 'forbidden',
    })
    expect(events).toEqual([{ id, type: 'email.failed' }])
  })

  test('gives up after retryAttempts temporary errors', async () => {
    const t = setup()
    fetchMock.mockImplementation(async () => json(429, { error: { message: 'Slow down', code: 'rate_limited' } }))
    const id = await send(t)
    expect(fetchMock).toHaveBeenCalledTimes(6)
    expect(await email(t, id)).toMatchObject({ status: 'failed', errorCode: 'rate_limited', attempts: 6 })
  })

  test('records recipients held back by validation', async () => {
    const t = setup()
    fetchMock.mockImplementation(async () =>
      json(200, { id: 'msg_2', status: 'queued', held_back: [{ email: 'x@nope.invalid', reason: 'no_mail_server' }] }),
    )
    const id = await send(t)
    expect((await email(t, id))?.heldBack).toEqual([{ email: 'x@nope.invalid', reason: 'no_mail_server' }])
  })

  test('rejects an email with no body', async () => {
    const t = setup()
    await expect(
      t.run((ctx) => groundmail.sendEmail(ctx, { from: 'a@mail.example.com', to: 'b@example.com', subject: 'Hi' })),
    ).rejects.toThrow('`html`, `text` or `template` is required')
  })

  test('cancels an email before it is sent', async () => {
    const t = setup()
    const id = (await t.mutation(api.example.sendWelcome, { to: 'ada@example.com', userId: 'u_9' })) as EmailId
    expect(await t.run((ctx) => groundmail.cancelEmail(ctx, id))).toBe(true)
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    expect(fetchMock).not.toHaveBeenCalled()
    expect((await email(t, id))?.status).toBe('cancelled')
  })
})

describe('attachments', () => {
  test('infers content_type from the filename when it is not set', async () => {
    const t = setup()
    await t.run((ctx) =>
      groundmail.sendEmail(ctx, {
        from: 'a@mail.example.com',
        to: 'b@example.com',
        subject: 'Files',
        text: 'Attached',
        attachments: [
          { filename: 'Invoice.PDF', content: 'aGk=' },
          { filename: 'photo.jpg', content: 'aGk=' },
          { filename: 'data.bin', content: 'aGk=' },
          { filename: 'README', content: 'aGk=' },
          { filename: 'notes.txt', content: 'aGk=', contentType: 'text/markdown' },
        ],
      }),
    )
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string)
    expect(body.attachments.map((a: { content_type: string }) => a.content_type)).toEqual([
      'application/pdf',
      'image/jpeg',
      'application/octet-stream',
      'application/octet-stream',
      'text/markdown',
    ])
  })
})

describe('delivery outcomes', () => {
  test('a 504 is recorded as unknown and not retried; a later webhook updates it', async () => {
    const t = setup()
    fetchMock.mockImplementation(async () =>
      json(504, { error: { message: 'The mail server did not answer in time', code: 'upstream_error' } }),
    )
    const id = await send(t)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(await email(t, id)).toMatchObject({ status: 'unknown', errorCode: 'upstream_error', attempts: 1 })
    expect(events).toEqual([])

    await postWebhook(t, {
      type: 'email.delivered',
      created_at: 'x',
      data: { email_id: 'msg_9', tags: [{ name: 'convex_email_id', value: id }] },
    })
    expect(await email(t, id)).toMatchObject({ status: 'delivered', groundmailId: 'msg_9' })
  })

  test('cancel returns false once an attempt has claimed the email', async () => {
    const t = setup()
    const lib = components.groundmail.lib as unknown as Record<string, FunctionReference<'mutation', 'public'>>
    const id = (await t.mutation(api.example.sendWelcome, { to: 'ada@example.com', userId: 'u_7' })) as EmailId
    // What deliver does right before the request.
    const claim = await t.mutation(lib.claimForDelivery, { emailId: id })
    expect(claim).not.toBeNull()
    expect((await email(t, id))?.status).toBe('sending')
    expect(await t.run((ctx) => groundmail.cancelEmail(ctx, id))).toBe(false)
    expect((await email(t, id))?.status).toBe('sending')
    // A second claim (a duplicate deliver) gets nothing, so it cannot send twice.
    expect(await t.mutation(lib.claimForDelivery, { emailId: id })).toBeNull()
  })
})

describe('recovering stalled deliveries', () => {
  const lib = components.groundmail.lib as unknown as Record<string, FunctionReference<'mutation', 'public'>>

  test('re-sends a queued email whose scheduled attempt never ran, once', async () => {
    const t = setup()
    const id = (await t.mutation(api.example.sendWelcome, { to: 'ada@example.com', userId: 'u_4' })) as EmailId
    vi.setSystemTime(Date.now() + 6 * 60 * 1000)
    await t.mutation(lib.recoverStalledEmails, {})
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(await email(t, id)).toMatchObject({ status: 'sent', attempts: 1 })
  })

  test('leaves recently queued emails alone', async () => {
    const t = setup()
    const id = (await t.mutation(api.example.sendWelcome, { to: 'ada@example.com', userId: 'u_5' })) as EmailId
    await t.mutation(lib.recoverStalledEmails, {})
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect((await email(t, id))?.status).toBe('sent')
  })

  test('retries an attempt stuck in sending with the same Idempotency-Key', async () => {
    const t = setup()
    const id = (await t.mutation(api.example.sendWelcome, { to: 'ada@example.com', userId: 'u_6' })) as EmailId
    // An attempt claimed the email, then its action died before recording a result.
    await t.mutation(lib.claimForDelivery, { emailId: id })
    vi.setSystemTime(Date.now() + 16 * 60 * 1000)
    await t.mutation(lib.recoverStalledEmails, {})
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const headers = (fetchMock.mock.calls[0] as [string, RequestInit])[1].headers as Record<string, string>
    expect(headers['Idempotency-Key']).toBe('key:welcome:u_6')
    expect(await email(t, id)).toMatchObject({ status: 'sent', attempts: 2 })
  })

  test('marks the email unknown once stalled attempts use up retryAttempts', async () => {
    const t = setup()
    const id = (await t.mutation(api.example.sendWelcome, { to: 'ada@example.com', userId: 'u_8' })) as EmailId
    for (let i = 0; i < 6; i++) {
      await t.mutation(lib.claimForDelivery, { emailId: id })
      vi.setSystemTime(Date.now() + 16 * 60 * 1000)
      await t.mutation(lib.recoverStalledEmails, {})
    }
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(await email(t, id)).toMatchObject({ status: 'unknown', attempts: 6 })
  })
})

describe('webhooks', () => {
  test('a signed delivery event updates the email and runs onEmailEvent', async () => {
    const t = setup()
    const id = await send(t)
    const res = await postWebhook(t, {
      type: 'email.delivered',
      created_at: '2026-10-21T12:00:00.000Z',
      data: { email_id: 'msg_1', status: 'delivered', tags: [{ name: 'convex_email_id', value: id }] },
    })
    expect(res.status).toBe(200)
    expect(await t.query(api.example.status, { emailId: id })).toMatchObject({ status: 'delivered' })
    expect(events).toEqual([{ id, type: 'email.delivered' }])
  })

  test('matches by Groundmail email id when the tag is missing', async () => {
    const t = setup()
    const id = await send(t)
    await postWebhook(t, { type: 'email.opened', created_at: 'x', data: { email_id: 'msg_1' } })
    expect((await email(t, id))?.opened).toBe(true)
  })

  test('an event that arrives before the send response is matched by tag', async () => {
    const t = setup()
    const id = (await t.mutation(api.example.sendWelcome, { to: 'ada@example.com', userId: 'u_3' })) as EmailId
    await postWebhook(t, {
      type: 'email.sent',
      created_at: 'x',
      data: { email_id: 'msg_early', tags: [{ name: 'convex_email_id', value: id }] },
    })
    expect(await email(t, id)).toMatchObject({ groundmailId: 'msg_early' })
  })

  test('never moves an email back, but records a bounce after delivery', async () => {
    const t = setup()
    const id = await send(t)
    await postWebhook(t, { type: 'email.delivered', created_at: 'x', data: { email_id: 'msg_1' } })
    await postWebhook(t, { type: 'email.delivery_delayed', created_at: 'x', data: { email_id: 'msg_1' } })
    expect((await email(t, id))?.status).toBe('delivered')
    await postWebhook(t, {
      type: 'email.bounced',
      created_at: 'x',
      data: { email_id: 'msg_1', bounce_type: 'hard', bounce_reason: '550 no such user' },
    })
    expect(await email(t, id)).toMatchObject({
      status: 'bounced',
      bounceType: 'hard',
      errorMessage: '550 no such user',
    })
  })

  test('rejects a bad signature and ignores events for other emails', async () => {
    const t = setup()
    await send(t)
    const event = { type: 'email.delivered', created_at: 'x', data: { email_id: 'msg_1' } }
    const bad = await postWebhook(t, event, sign(JSON.stringify({ other: true })))
    expect(bad.status).toBe(401)

    const other = await postWebhook(t, { type: 'email.delivered', created_at: 'x', data: { email_id: 'msg_other' } })
    expect(other.status).toBe(200)
    expect(events).toEqual([])
  })
})

describe('cleanupOldEmails', () => {
  test('deletes finished emails older than the cutoff', async () => {
    const t = setup()
    const id = await send(t)
    await postWebhook(t, { type: 'email.delivered', created_at: 'x', data: { email_id: 'msg_1' } })
    vi.advanceTimersByTime(8 * 24 * 60 * 60 * 1000)
    await t.run((ctx) => groundmail.cleanupOldEmails(ctx))
    expect(await email(t, id)).toBeNull()
  })

  test('keeps emails still in flight', async () => {
    const t = setup()
    const id = await send(t)
    vi.advanceTimersByTime(8 * 24 * 60 * 60 * 1000)
    await t.mutation(components.groundmail.lib.cleanupOldEmails, {})
    expect((await email(t, id))?.status).toBe('sent')
  })
})

describe('verifyWebhookSignature', () => {
  test("accepts the server's signature format and rejects stale or altered ones", async () => {
    const body = '{"type":"email.sent"}'
    expect(await verifyWebhookSignature(SECRET, body, sign(body))).toBe(true)
    expect(await verifyWebhookSignature(SECRET, `${body} `, sign(body))).toBe(false)
    expect(await verifyWebhookSignature('whsec_other', body, sign(body))).toBe(false)
    const stale = Math.floor(Date.now() / 1000) - 600
    expect(await verifyWebhookSignature(SECRET, body, sign(body, stale))).toBe(false)
    expect(await verifyWebhookSignature(SECRET, body, null)).toBe(false)
    expect(await verifyWebhookSignature(SECRET, body, 't=1,v1=zz')).toBe(false)
  })
})
