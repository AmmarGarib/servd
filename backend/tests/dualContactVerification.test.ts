// Customer signup: ONE code, sent to WhatsApp and email at the same time.
//
// WhatsApp here is an unofficial linked-device session. When it drops, every
// WhatsApp code stops at once — so the same code also goes by email, and the
// customer types whichever copy arrives first. The properties defended:
//
//   - both channels get the SAME code, and either copy works;
//   - WhatsApp down         → the email copy carries the signup, and the phone
//     is left unverified rather than falsely marked verified;
//   - a used code cannot be replayed from the other inbox;
//   - a wrong guess does not burn the code;
//   - nothing entered       → no account;
//   - a page cached before this change (old field name) still works.
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

describe('one code goes out on both channels', () => {
  it('sends the SAME code to WhatsApp and email', async () => {
    const r = await post('/customer/request-signup-codes', { phone: PHONE, email: EMAIL })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toEqual({ phone: { status: 'sent' }, email: { status: 'sent' } })
    expect(sentPhone).toHaveLength(1)
    expect(sentEmail).toHaveLength(1)
    expect(sentPhone[0]).toBe(sentEmail[0])
  })

  it('still sends email when WhatsApp is down, and leaves no dead WhatsApp copy', async () => {
    whatsappDown.value = true
    const r = await post('/customer/request-signup-codes', { phone: PHONE, email: EMAIL })
    expect(r.json()).toEqual({ phone: { status: 'failed' }, email: { status: 'sent' } })
    expect(await prisma.phoneOtp.count({ where: { phone: PHONE_N, consumedAt: null } })).toBe(0)
  })
})

describe('register takes the one code', () => {
  it('works with the copy from either channel and marks both delivered channels verified', async () => {
    await post('/customer/request-signup-codes', { phone: PHONE, email: EMAIL })
    const r = await register({ code: sentEmail[0]! })
    expect(r.statusCode).toBe(201)
    const c = await prisma.customer.findFirst({ where: { email: EMAIL } })
    expect(c!.phoneVerifiedAt).not.toBeNull()
    expect(c!.emailVerifiedAt).not.toBeNull()
  })

  it('lets the email copy carry signup when WhatsApp is down, phone left unverified', async () => {
    whatsappDown.value = true
    await post('/customer/request-signup-codes', { phone: PHONE, email: EMAIL })
    const r = await register({ code: sentEmail[0]! })
    expect(r.statusCode).toBe(201)
    const c = await prisma.customer.findFirst({ where: { email: EMAIL } })
    expect(c!.emailVerifiedAt).not.toBeNull()
    // Not falsely verified — referral payouts are gated on this.
    expect(c!.phoneVerifiedAt).toBeNull()
  })

  it('consumes the code on both channels — it cannot be replayed from the other inbox', async () => {
    await post('/customer/request-signup-codes', { phone: PHONE, email: EMAIL })
    const code = sentPhone[0]!
    expect((await register({ code })).statusCode).toBe(201)
    expect(await prisma.phoneOtp.count({ where: { phone: PHONE_N, consumedAt: null } })).toBe(0)
    expect(await prisma.emailOtp.count({ where: { email: EMAIL, consumedAt: null } })).toBe(0)
  })

  it('does not burn the code on a wrong guess', async () => {
    await post('/customer/request-signup-codes', { phone: PHONE, email: EMAIL })
    const wrong = sentPhone[0] === '000000' ? '111111' : '000000'
    const bad = await register({ code: wrong })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().error.code).toBe('OTP_WRONG')
    expect((await register({ code: sentPhone[0]! })).statusCode).toBe(201)
  })

  it('refuses an account with no code', async () => {
    const r = await register({})
    expect(r.statusCode).toBe(400)
    expect(r.json().error.code).toBe('VERIFICATION_REQUIRED')
    expect(await prisma.customer.count({ where: { email: EMAIL } })).toBe(0)
  })

  it('still accepts the old field name from a cached page', async () => {
    await post('/customer/request-signup-codes', { phone: PHONE, email: EMAIL })
    expect((await register({ otpCode: sentPhone[0]! })).statusCode).toBe(201)
  })

  it('requires a phone number on every account', async () => {
    const r = await post('/customer/register', { name: 'x', email: EMAIL, password: 'Password123', code: '123456' })
    expect(r.statusCode).toBe(400)
  })
})

const { requestSharedCode, verifySharedCode } = await import('../src/modules/auth/otp.js')

describe('staff codes use the same one-code, two-channel delivery', () => {
  const STAFF_PHONE = '03115550199', STAFF_EMAIL = 'till.dual@gsfoods.pk'

  it('a cashier can sign in with the email copy when WhatsApp is down', async () => {
    whatsappDown.value = true
    const r = await requestSharedCode({ phone: STAFF_PHONE, email: STAFF_EMAIL, purpose: 'staff_login' })
    expect(r).toMatchObject({ phone: 'failed', email: 'sent' })
    const v = await verifySharedCode({ phone: STAFF_PHONE, email: STAFF_EMAIL, code: sentEmail.at(-1)!, purpose: 'staff_login' })
    expect(v.deliveredToEmail).toBe(true)
    await prisma.emailOtp.deleteMany({ where: { email: STAFF_EMAIL } })
  })

  it('a 2FA code is not interchangeable with a sign-in code', async () => {
    await requestSharedCode({ phone: STAFF_PHONE, email: STAFF_EMAIL, purpose: 'staff_2fa' })
    await expect(
      verifySharedCode({ phone: STAFF_PHONE, email: STAFF_EMAIL, code: sentPhone.at(-1)!, purpose: 'staff_login' }),
    ).rejects.toThrow()
    await prisma.phoneOtp.deleteMany({ where: { phone: '923115550199' } })
    await prisma.emailOtp.deleteMany({ where: { email: STAFF_EMAIL } })
  })
})
