// Customer signup verifies phone AND email.
//
// WhatsApp here is an unofficial linked-device session. When it drops, every
// WhatsApp code stops at once — so signup sends a code over both channels,
// independently, and verifies each one that arrived. The properties defended:
//
//   - both codes delivered  → both must be entered (the owner wants to own both
//     channels, not whichever one the customer finds easiest);
//   - WhatsApp down         → email alone carries the signup, and the phone is
//     left unverified rather than falsely marked verified;
//   - nothing verified      → no account;
//   - a right code and a wrong code → the right one is NOT burned, so the retry
//     works;
//   - an undelivered code never becomes a requirement.
//
// Drives the real route handlers through Fastify inject, with delivery stubbed
// at the two send functions. Needs the disposable test database and Redis.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'

const whatsappDown = { value: false }
const sentPhone: string[] = []
const sentEmail: string[] = []

vi.mock('../src/lib/whatsapp.js', async (orig) => {
  const real = await orig<typeof import('../src/lib/whatsapp.js')>()
  return {
    ...real,
    sendText: vi.fn(async (_to: string, msg: string) => {
      if (whatsappDown.value) throw new Error('WhatsApp not ready (status: INITIALIZING)')
      sentPhone.push(msg.match(/\d{6}/)![0])
    }),
  }
})
vi.mock('../src/lib/mailer.js', async (orig) => {
  const real = await orig<typeof import('../src/lib/mailer.js')>()
  return {
    ...real,
    sendEmail: vi.fn(async (o: { subject: string }) => { sentEmail.push(o.subject.match(/\d{6}/)![0]) }),
  }
})

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { authRoutes } = await import('../src/modules/auth/routes.js')
const { AppError } = await import('../src/lib/errors.js')

const PHONE = '03115550101'
const PHONE_N = '923115550101'
const EMAIL = 'dual.verify@example.com'
let app: FastifyInstance

async function cleanup() {
  await prisma.phoneOtp.deleteMany({ where: { phone: PHONE_N } })
  await prisma.emailOtp.deleteMany({ where: { email: EMAIL } })
  const c = await prisma.customer.findFirst({ where: { email: EMAIL }, select: { id: true } })
  if (c) {
    await prisma.loyaltyAccount.deleteMany({ where: { customerId: c.id } }).catch(() => {})
    await prisma.customer.delete({ where: { id: c.id } }).catch(() => {})
  }
}

const post = (url: string, payload: unknown) =>
  app.inject({ method: 'POST', url: `/api/v1/auth${url}`, payload, remoteAddress: '10.9.9.9' })

const register = (extra: Record<string, string>) => post('/customer/register', {
  name: 'Dual Verify', email: EMAIL, password: 'Password123', phone: PHONE, ...extra,
})

beforeAll(async () => {
  process.env['NODE_ENV'] = 'production' // exercise the real failure semantics
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR' } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: String((err as Error).message) } })
  })
  await app.register(authRoutes, { prefix: '/api/v1/auth' })
  await app.ready()
})

afterAll(async () => {
  process.env['NODE_ENV'] = 'test'
  await cleanup()
  await app.close()
})

beforeEach(async () => {
  whatsappDown.value = false
  sentPhone.length = 0
  sentEmail.length = 0
  await cleanup()
  // Rate limiter is real; keep each case independent of the last.
  const { redis } = await import('../src/lib/redis.js')
  const keys = await redis.keys('*10.9.9.9*')
  if (keys.length) await redis.del(...keys)
})

describe('signup codes go out on both channels independently', () => {
  it('sends to WhatsApp and email', async () => {
    const r = await post('/customer/request-signup-codes', { phone: PHONE, email: EMAIL })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ phone: { status: 'sent' }, email: { status: 'sent' } })
    expect(sentPhone).toHaveLength(1)
    expect(sentEmail).toHaveLength(1)
  })

  it('still sends email when WhatsApp is down', async () => {
    whatsappDown.value = true
    const r = await post('/customer/request-signup-codes', { phone: PHONE, email: EMAIL })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ phone: { status: 'failed' }, email: { status: 'sent' } })
    // The undelivered WhatsApp code must not linger as a requirement.
    expect(await prisma.phoneOtp.count({ where: { phone: PHONE_N, consumedAt: null } })).toBe(0)
  })
})

describe('register enforces what was delivered', () => {
  it('requires BOTH codes when both were delivered', async () => {
    await post('/customer/request-signup-codes', { phone: PHONE, email: EMAIL })
    const onlyPhone = await register({ otpCode: sentPhone[0]! })
    expect(onlyPhone.statusCode).toBe(400)
    expect(onlyPhone.json().error.code).toBe('EMAIL_CODE_REQUIRED')
    const onlyEmail = await register({ emailCode: sentEmail[0]! })
    expect(onlyEmail.json().error.code).toBe('PHONE_CODE_REQUIRED')
  })

  it('verifies both and stamps both', async () => {
    await post('/customer/request-signup-codes', { phone: PHONE, email: EMAIL })
    const r = await register({ otpCode: sentPhone[0]!, emailCode: sentEmail[0]! })
    expect(r.statusCode).toBe(201)
    const c = await prisma.customer.findFirst({ where: { email: EMAIL } })
    expect(c!.phoneVerifiedAt).not.toBeNull()
    expect(c!.emailVerifiedAt).not.toBeNull()
  })

  it('lets email alone carry signup when WhatsApp is down, phone left unverified', async () => {
    whatsappDown.value = true
    await post('/customer/request-signup-codes', { phone: PHONE, email: EMAIL })
    const r = await register({ emailCode: sentEmail[0]! })
    expect(r.statusCode).toBe(201)
    const c = await prisma.customer.findFirst({ where: { email: EMAIL } })
    expect(c!.emailVerifiedAt).not.toBeNull()
    // Not falsely verified — referral payouts are gated on this.
    expect(c!.phoneVerifiedAt).toBeNull()
    expect(c!.phone).toBe(PHONE_N)
  })

  it('refuses an account with nothing verified', async () => {
    const r = await register({})
    expect(r.statusCode).toBe(400)
    expect(r.json().error.code).toBe('VERIFICATION_REQUIRED')
    expect(await prisma.customer.count({ where: { email: EMAIL } })).toBe(0)
  })

  it('does not burn the right code when the other one is wrong', async () => {
    await post('/customer/request-signup-codes', { phone: PHONE, email: EMAIL })
    const wrongEmail = sentEmail[0] === '000000' ? '111111' : '000000'
    const bad = await register({ otpCode: sentPhone[0]!, emailCode: wrongEmail })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().error.code).toBe('EMAIL_OTP_WRONG')
    // Retry with the correct email code — the phone code must still be good.
    const good = await register({ otpCode: sentPhone[0]!, emailCode: sentEmail[0]! })
    expect(good.statusCode).toBe(201)
  })

  it('requires a phone number on every account', async () => {
    const r = await post('/customer/register', { name: 'x', email: EMAIL, password: 'Password123', emailCode: '123456' })
    expect(r.statusCode).toBe(400)
  })
})
