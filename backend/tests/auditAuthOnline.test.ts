// Auth audit fixes, customer side (2026-10-10):
//
//   ONL-10  POST /auth/customer/request (sign-in link) normalises the phone, so
//           0300… finds the 92300… account instead of creating an empty twin;
//           creates NO account on request (a contact with none gets a signed,
//           single-use link and the account is made when it is followed); and
//           is capped per contact per day, whatever IP asks.
//   ONL-11  with WhatsApp / email not configured, the dropped message is
//           logged as channel + masked recipient + purpose — never the body,
//           so sign-in links and booking tokens stay out of the server log.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'

const sent: Array<{ to: string; text: string }> = []
const mailed: Array<{ to: string; html: string }> = []
const waOn = { value: true }
const mailOn = { value: true }

vi.mock('../src/lib/whatsapp.js', async (orig) => {
  const real = await orig<typeof import('../src/lib/whatsapp.js')>()
  return {
    ...real,
    whatsappConfigured: vi.fn(async () => waOn.value),
    sendText: vi.fn(async (to: string, text: string) => { sent.push({ to, text }) }),
  }
})
vi.mock('../src/lib/mailer.js', async (orig) => {
  const real = await orig<typeof import('../src/lib/mailer.js')>()
  return {
    ...real,
    emailConfigured: vi.fn(async () => mailOn.value),
    sendEmail: vi.fn(async (o: { to: string; html: string }) => { mailed.push({ to: o.to, html: o.html }) }),
  }
})

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { authRoutes } = await import('../src/modules/auth/routes.js')
const { sendPhoneMessage, sendEmail } = await import('../src/lib/notify.js')
const { normalisePhone } = await import('../src/modules/auth/otp.js')
const { AppError } = await import('../src/lib/errors.js')

const STAMP = Date.now()
let seq = 0
// Unique per run: the per-contact cap lives in Redis and outlasts a run.
function uniquePhone(): string {
  const n = ((STAMP % 900_000_000) + 100_000_000 + seq++ * 104_729) % 1_000_000_000
  return `03${String(n).padStart(9, '0')}`
}
const uniqueEmail = (tag: string) => `onl.${tag}.${STAMP}.${seq++}@example.pk`

let app: FastifyInstance
const touchedPhones: string[] = []
const touchedEmails: string[] = []

const request = (payload: object, ip = '10.20.0.1') =>
  app.inject({ method: 'POST', url: '/api/v1/auth/customer/request', payload, remoteAddress: ip })
const verify = (token: string, ip = '10.20.0.9') =>
  app.inject({ method: 'POST', url: '/api/v1/auth/customer/verify', payload: { token }, remoteAddress: ip })

function lastLinkToken(): string {
  const text = sent.at(-1)?.text ?? mailed.at(-1)?.html ?? ''
  const m = /token=([^\s"<]+)/.exec(text)
  if (!m) throw new Error(`no link in: ${text}`)
  return decodeURIComponent(m[1]!)
}

async function customersFor(phone: string) {
  const n = normalisePhone(phone)
  return prisma.customer.findMany({ where: { phone: { in: [n, `+${n}`, `0${n.slice(2)}`, n.slice(2)] } } })
}

beforeAll(async () => {
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR' } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: 'ERR', message: String((err as Error).message) } })
  })
  await app.register(authRoutes, { prefix: '/api/v1/auth' })
  await app.ready()
})

afterAll(async () => {
  await app?.close()
  const phones = touchedPhones.flatMap((p) => { const n = normalisePhone(p); return [n, `+${n}`, `0${n.slice(2)}`] })
  const rows = await prisma.customer.findMany({ where: { OR: [{ phone: { in: phones } }, { email: { in: touchedEmails } }] }, select: { id: true } })
  await prisma.magicLink.deleteMany({ where: { customerId: { in: rows.map((r) => r.id) } } })
  await prisma.customer.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } })
})

beforeEach(() => {
  sent.length = 0
  mailed.length = 0
  waOn.value = true
  mailOn.value = true
})

// ─── ONL-10 ──────────────────────────────────────────────────────────────────

describe('ONL-10: sign-in links', () => {
  it('a number with no account gets a link but no account — the account is made when the link is followed, once', async () => {
    const phone = uniquePhone(); touchedPhones.push(phone)
    const r = await request({ phone, name: 'Anyone' })
    expect(r.statusCode).toBe(200)
    expect(await customersFor(phone)).toHaveLength(0)       // nothing created on request
    expect(sent).toHaveLength(1)
    expect(sent[0]!.to).toBe(normalisePhone(phone))

    const token = lastLinkToken()
    const ok = await verify(token)
    expect(ok.statusCode).toBe(200)
    const rows = await customersFor(phone)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ phone: normalisePhone(phone), name: 'Anyone' })
    expect(rows[0]!.phoneVerifiedAt).not.toBeNull()
    expect(ok.json().customer.id).toBe(rows[0]!.id)

    // Single use.
    const again = await verify(token)
    expect(again.statusCode).toBe(401)
    expect(again.json().error.code).toBe('TOKEN_USED')
    expect(await customersFor(phone)).toHaveLength(1)
  })

  it('a tampered signed link is refused', async () => {
    const phone = uniquePhone(); touchedPhones.push(phone)
    await request({ phone })
    const [h, p, s] = lastLinkToken().split('.')
    const payload = JSON.parse(Buffer.from(p!, 'base64url').toString())
    payload.c = normalisePhone(uniquePhone())
    const forged = [h, Buffer.from(JSON.stringify(payload)).toString('base64url'), s].join('.')
    expect((await verify(forged)).statusCode).toBe(401)
  })

  it('0300… finds the existing 92300… account instead of making an empty twin', async () => {
    const phone = uniquePhone(); touchedPhones.push(phone)
    const sana = await prisma.customer.create({ data: { name: 'Sana Khan', phone: normalisePhone(phone), email: uniqueEmail('sana') } })
    touchedEmails.push(sana.email!)
    expect((await request({ phone })).statusCode).toBe(200)
    expect((await request({ phone: `+92 ${phone.slice(1, 4)} ${phone.slice(4)}` }, '10.20.0.2')).statusCode).toBe(200)
    expect(await customersFor(phone)).toHaveLength(1)

    const token = lastLinkToken()
    expect(token).toHaveLength(32)                     // a link to the existing account
    const ok = await verify(token)
    expect(ok.json().customer.id).toBe(sana.id)
  })

  it('an existing account\'s link cannot be followed twice at once', async () => {
    const phone = uniquePhone(); touchedPhones.push(phone)
    await prisma.customer.create({ data: { name: 'Race', phone: normalisePhone(phone) } })
    await request({ phone })
    const token = lastLinkToken()
    const results = await Promise.all([verify(token, '10.20.1.1'), verify(token, '10.20.1.2'), verify(token, '10.20.1.3')])
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1)
  })

  it('caps links per contact per day, however the number is written and whatever IP asks', async () => {
    const phone = uniquePhone(); touchedPhones.push(phone)
    const spellings = [phone, `+92${phone.slice(1)}`, `92${phone.slice(1)}`, `${phone.slice(0, 4)}-${phone.slice(4)}`, phone]
    for (let i = 0; i < spellings.length; i++) {
      expect((await request({ phone: spellings[i]! }, `10.30.0.${i + 1}`)).statusCode).toBe(200)
    }
    const capped = await request({ phone }, '10.30.0.99')
    expect(capped.statusCode).toBe(429)
    expect(capped.json().error.code).toBe('MAGIC_LINK_LIMIT')
    expect(sent).toHaveLength(5)
    // Another contact is unaffected.
    const other = uniquePhone(); touchedPhones.push(other)
    expect((await request({ phone: other }, '10.30.0.99')).statusCode).toBe(200)
  })

  it('an emailed link for a new address makes a verified email account on follow', async () => {
    const email = uniqueEmail('new'); touchedEmails.push(email)
    expect((await request({ email: email.toUpperCase(), name: 'Mobile User' })).statusCode).toBe(200)
    expect(await prisma.customer.count({ where: { email } })).toBe(0)
    expect(mailed).toHaveLength(1)
    const ok = await verify(lastLinkToken())
    expect(ok.statusCode).toBe(200)
    const row = await prisma.customer.findFirstOrThrow({ where: { email } })
    expect(row.name).toBe('Mobile User')
    expect(row.emailVerifiedAt).not.toBeNull()
  })
})

// ─── ONL-11 ──────────────────────────────────────────────────────────────────

describe('ONL-11: unsent messages are logged without their body', () => {
  it('WhatsApp not configured: channel, masked number and purpose only', async () => {
    waOn.value = false
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      await sendPhoneMessage('03001234567', 'Reservation request received. Confirm/cancel: https://servd.pk/r/SECRET-TOKEN-123', 'reservation.request')
      const lines = log.mock.calls.map((c) => c.join(' '))
      expect(lines.some((l) => l.includes('…4567') && l.includes('reservation.request'))).toBe(true)
      for (const l of lines) {
        expect(l).not.toContain('SECRET-TOKEN-123')
        expect(l).not.toContain('03001234567')
      }
      expect(sent).toHaveLength(0)
    } finally { log.mockRestore() }
  })

  it('email not configured (non-production): masked address, no subject or body', async () => {
    mailOn.value = false
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      await sendEmail('sana.khan@example.pk', 'Reset link SUBJECT-SECRET', '<a href="https://x/reset?token=BODY-SECRET">reset</a>', 'password_reset')
      const lines = log.mock.calls.map((c) => c.join(' '))
      expect(lines.some((l) => l.includes('s***@example.pk') && l.includes('password_reset'))).toBe(true)
      for (const l of lines) {
        expect(l).not.toContain('BODY-SECRET')
        expect(l).not.toContain('SUBJECT-SECRET')
        expect(l).not.toContain('sana.khan')
      }
    } finally { log.mockRestore() }
  })

  it('a sign-in link requested while WhatsApp is down never reaches the log, and is still redeemable from the DB row', async () => {
    waOn.value = false
    const phone = uniquePhone(); touchedPhones.push(phone)
    const c = await prisma.customer.create({ data: { name: 'Logless', phone: normalisePhone(phone) } })
    const spies = (['log', 'warn', 'error', 'info'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined))
    try {
      expect((await request({ phone })).statusCode).toBe(200)
      const link = await prisma.magicLink.findFirstOrThrow({ where: { customerId: c.id }, orderBy: { createdAt: 'desc' } })
      const logged = spies.flatMap((s) => s.mock.calls.map((call) => call.map(String).join(' '))).join('\n')
      expect(logged).not.toContain(link.token)
      expect(logged).toContain('magic_link')
      // Development reads the token from the database, where it lives.
      expect((await verify(link.token)).statusCode).toBe(200)
    } finally { spies.forEach((s) => s.mockRestore()) }
  })
})
