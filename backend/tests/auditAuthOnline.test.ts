// Auth audit fixes, customer side (2026-10-10):
//
//   ONL-10  POST /auth/customer/request (sign-in link) — RETIRED 2026-10-28: a
//           customer verifies a code once at signup, then signs in with email +
//           password; both link routes answer 410.
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

describe('ONL-10: sign-in links are retired (owner, 2026-10-28: code only at first sign-up)', () => {
  it('request and verify answer 410, send nothing and create no account', async () => {
    const phone = uniquePhone(); touchedPhones.push(phone)
    const r = await request({ phone, name: 'Anyone' })
    expect(r.statusCode).toBe(410)
    expect(r.json().error.code).toBe('CUSTOMER_LINK_LOGIN_RETIRED')
    expect((await request({ email: uniqueEmail('x') })).statusCode).toBe(410)
    const v = await verify('x'.repeat(32))
    expect(v.statusCode).toBe(410)
    expect(sent).toHaveLength(0)
    expect(mailed).toHaveLength(0)
    expect(await customersFor(phone)).toHaveLength(0)
  })
})

// ─── Forgotten customer password (owner, 2026-10-28: a code only at sign-up and to get back in) ─────────────

describe('customer forgot password: a code to the account\'s own phone + email resets it', () => {
  const post = (url: string, payload: object, ip = '10.40.0.1') =>
    app.inject({ method: 'POST', url: `/api/v1/auth/customer/password/${url}`, payload, remoteAddress: ip })

  it('answers the same for any email, sends to the account\'s own contacts, and the code sets the password', async () => {
    const phone = uniquePhone(); touchedPhones.push(phone)
    const email = uniqueEmail('reset'); touchedEmails.push(email)
    await prisma.customer.create({ data: { name: 'Reset Me', phone: normalisePhone(phone), email, password: 'x' } })

    const nobody = await post('forgot', { email: uniqueEmail('nobody') })
    expect(nobody.statusCode).toBe(202)
    const r = await post('forgot', { email: email.toUpperCase() })
    expect(r.statusCode).toBe(202)
    expect(r.json()).toEqual(nobody.json())
    for (let i = 0; i < 40 && sent.length + mailed.length < 2; i++) await new Promise((res) => setTimeout(res, 25))
    expect(sent.map((m) => m.to)).toEqual([normalisePhone(phone)])
    expect(mailed.map((m) => m.to)).toEqual([email])
    const code = sent[0]!.text.match(/\d{6}/)![0]

    const wrong = await post('reset', { email, code: code === '000000' ? '111111' : '000000', newPassword: 'NewPass123' })
    expect(wrong.statusCode).toBe(401)
    expect(wrong.json().error.code).toBe('INVALID_CODE')
    expect((await post('reset', { email, code, newPassword: 'short' })).statusCode).toBe(400)

    const ok = await post('reset', { email, code, newPassword: 'NewPass123' })
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json().token).toBeTruthy()
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/customer/login', payload: { email, password: 'NewPass123' }, remoteAddress: '10.40.0.2' })
    expect(login.statusCode).toBe(200)
    // The code is used up.
    expect((await post('reset', { email, code, newPassword: 'Other1234' })).statusCode).toBe(401)
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
})
