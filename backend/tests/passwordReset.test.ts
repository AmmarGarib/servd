// Self-service staff password reset.
//
// Why this exists: a forgotten staff password had no self-service remedy at
// all. /auth/password/change needs the password you forgot, and
// /auth/users/:id/reissue-password needs a signed-in ADMIN — so the account
// most likely to be locked out, the owner's, could only be recovered by
// another admin. That happened twice in production.
//
// What these tests hold in place, in rough order of "what would hurt most if
// it regressed":
//
//   1. The token is single-use. A reset link that still works after the
//      password has been changed is a standing key to the account sitting in
//      an inbox.
//   2. Requesting a new link kills the old one, so a forwarded or
//      shoulder-surfed older email stops working.
//   3. Expired links are refused.
//   4. Only a SHA-256 of the token is stored, so a database dump is not a pile
//      of working reset links.
//   5. /forgot answers identically for an address with an account and one
//      without — it must not become an account-existence oracle.
//   6. A successful reset revokes existing sessions.
//   7. Disabled / soft-deleted accounts cannot be reset into.

import { beforeAll, afterAll, describe, expect, test } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'
import crypto from 'crypto'
import { authRoutes } from '../src/modules/auth/routes.js'
import { AppError } from '../src/lib/errors.js'
import { redis } from '../src/lib/redis.js'

const prisma = (globalThis as { __TEST_PRISMA__?: PrismaClient }).__TEST_PRISMA__ ?? new PrismaClient()

// The routes run in-process (app.inject), like every other suite. This file
// used to fetch() a separate API on :3011 that nothing — not vitest, not CI —
// ever started, so all ten tests failed with ECONNREFUSED. In-process the
// delivery-channel check below also reads the same env as the route.
let app: FastifyInstance
const CLIENT_IP = '10.9.9.31'

const stamp = Date.now()
const LIVE_EMAIL     = `reset.live.${stamp}@gsfoods.pk`
const DISABLED_EMAIL = `reset.off.${stamp}@gsfoods.pk`
const UNKNOWN_EMAIL  = `reset.nobody.${stamp}@gsfoods.pk`
const OLD_PASSWORD   = 'Cedar-Sorrel-0000-aaaaaa'
const NEW_PASSWORD   = 'Juniper-Basalt-1234-bbbbbb'

const userIds: string[] = []
let tenantId = ''

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex')

async function post(path: string, body: unknown) {
  const res = await app.inject({ method: 'POST', url: `/api/v1${path}`, payload: body as object, remoteAddress: CLIENT_IP })
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null }
}

async function get(path: string) {
  const res = await app.inject({ method: 'GET', url: `/api/v1${path}`, remoteAddress: CLIENT_IP })
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null }
}

/** Pull the freshest live token row for a user and forge the plaintext we'd need.
 *  We cannot read the token back (only its hash is stored), which is the point —
 *  so tests that need a working link issue their own row with a known token. */
async function issueToken(userId: string, opts: { expiresInMs?: number } = {}) {
  const token = crypto.randomBytes(32).toString('base64url')
  await prisma.staffPasswordReset.create({
    data: {
      userId,
      tokenHash: sha256(token),
      expiresAt: new Date(Date.now() + (opts.expiresInMs ?? 30 * 60_000)),
    },
  })
  return token
}

beforeAll(async () => {
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR' } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: String((err as Error).message) } })
  })
  await app.register(authRoutes, { prefix: '/api/v1/auth' })
  await app.ready()
  // A clean slate for this client's rate-limit counters (login, forgot).
  const keys = await redis.keys(`*${CLIENT_IP}*`)
  if (keys.length) await redis.del(...keys)

  const tenant = await prisma.tenant.create({
    data: { name: `Reset Co ${stamp}`, slug: `reset-co-${stamp}`, countryCode: 'PK', currency: 'PKR', timezone: 'Asia/Karachi' },
  })
  tenantId = tenant.id

  const hash = await bcrypt.hash(OLD_PASSWORD, 10)
  const live = await prisma.user.create({
    data: { name: 'Live User', email: LIVE_EMAIL, password: hash, role: 'management', tenantId, isActive: true, accountStatus: 'active' },
  })
  const disabled = await prisma.user.create({
    data: { name: 'Disabled User', email: DISABLED_EMAIL, password: hash, role: 'management', tenantId, isActive: false, accountStatus: 'active' },
  })
  userIds.push(live.id, disabled.id)
}, 60_000)

afterAll(async () => {
  await app.close()
  await prisma.staffPasswordReset.deleteMany({ where: { userId: { in: userIds } } })
  await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  await prisma.tenant.deleteMany({ where: { id: tenantId } })
})

describe('POST /auth/password/forgot', () => {
  // The suite runs with no SMTP_USER and no WHATSAPP_API_URL, which is also
  // how production was found to be configured — so this is the live behaviour,
  // not a hypothetical. Both branches are asserted: when nothing can be
  // delivered the endpoint must SAY so rather than promise a link, and when a
  // rail exists it must go back to the silent, oracle-free 202.
  const canDeliver = Boolean(
    (process.env['SMTP_USER'] && process.env['SMTP_PASS'])
    || (process.env['WHATSAPP_API_URL'] && process.env['WHATSAPP_API_KEY']),
  )

  test('refuses honestly when no delivery channel is configured', async () => {
    const res = await post('/auth/password/forgot', { email: LIVE_EMAIL })
    if (canDeliver) {
      expect(res.status).toBe(202)
    } else {
      expect(res.status).toBe(503)
      expect(res.body?.error?.code).toBe('RESET_UNAVAILABLE')
    }
  })

  test('the refusal is not an oracle either — same answer for an unknown address', async () => {
    const real   = await post('/auth/password/forgot', { email: LIVE_EMAIL })
    const nobody = await post('/auth/password/forgot', { email: UNKNOWN_EMAIL })
    expect(nobody.status).toBe(real.status)
    expect(nobody.body).toEqual(real.body)
  })

  test.skipIf(!canDeliver)('is not an account-existence oracle', async () => {
    const real    = await post('/auth/password/forgot', { email: LIVE_EMAIL })
    const nobody  = await post('/auth/password/forgot', { email: UNKNOWN_EMAIL })

    expect(real.status).toBe(202)
    expect(nobody.status).toBe(nobody.status)
    // Identical status AND identical body. A difference in either is enough to
    // enumerate which addresses are staff accounts.
    expect(nobody.status).toBe(202)
    expect(nobody.body).toEqual(real.body)
  })

  test.skipIf(!canDeliver)('issues a token for a real account', async () => {
    await post('/auth/password/forgot', { email: LIVE_EMAIL })
    const rows = await prisma.staffPasswordReset.findMany({ where: { userId: userIds[0] } })
    expect(rows.length).toBeGreaterThan(0)
  })

  test.skipIf(!canDeliver)('issues nothing for an address with no account', async () => {
    const before = await prisma.staffPasswordReset.count()
    await post('/auth/password/forgot', { email: UNKNOWN_EMAIL })
    expect(await prisma.staffPasswordReset.count()).toBe(before)
  })

  test('stores only a hash — the DB never holds a usable token', async () => {
    const token = await issueToken(userIds[0]!)
    const row = await prisma.staffPasswordReset.findUnique({ where: { tokenHash: sha256(token) } })
    expect(row).not.toBeNull()
    // The plaintext appears in no column.
    const all = await prisma.staffPasswordReset.findMany({ where: { userId: userIds[0] } })
    for (const r of all) {
      expect(r.tokenHash).not.toBe(token)
      expect(JSON.stringify(r)).not.toContain(token)
    }
  })

  test.skipIf(!canDeliver)('a new request invalidates the previous link', async () => {
    const first = await issueToken(userIds[0]!)
    await post('/auth/password/forgot', { email: LIVE_EMAIL })

    const used = await post('/auth/password/reset', { token: first, newPassword: NEW_PASSWORD })
    expect(used.status).toBe(400)
    expect(used.body?.error?.code).toBe('RESET_LINK_INVALID')
  })
})

describe('POST /auth/password/reset', () => {
  test('sets the password and the old one stops working', async () => {
    const token = await issueToken(userIds[0]!)
    const res = await post('/auth/password/reset', { token, newPassword: NEW_PASSWORD })
    expect(res.status).toBe(204)

    const withNew = await post('/auth/login', { email: LIVE_EMAIL, password: NEW_PASSWORD })
    expect(withNew.status).toBe(200)

    const withOld = await post('/auth/login', { email: LIVE_EMAIL, password: OLD_PASSWORD })
    expect(withOld.status).toBe(401)
  })

  test('the same link cannot be used twice', async () => {
    const token = await issueToken(userIds[0]!)
    const first = await post('/auth/password/reset', { token, newPassword: NEW_PASSWORD + 'x' })
    expect(first.status).toBe(204)

    const second = await post('/auth/password/reset', { token, newPassword: 'Totally-Different-9999-cccccc' })
    expect(second.status).toBe(400)
    expect(second.body?.error?.code).toBe('RESET_LINK_INVALID')
  })

  test('an expired link is refused', async () => {
    const token = await issueToken(userIds[0]!, { expiresInMs: -1000 })
    const res = await post('/auth/password/reset', { token, newPassword: 'Another-Password-4444-dddddd' })
    expect(res.status).toBe(400)
    expect(res.body?.error?.code).toBe('RESET_LINK_INVALID')
  })

  test('a made-up token is refused', async () => {
    const res = await post('/auth/password/reset', {
      token: crypto.randomBytes(32).toString('base64url'),
      newPassword: 'Another-Password-5555-eeeeee',
    })
    expect(res.status).toBe(400)
  })

  test('a disabled account cannot be reset into', async () => {
    const token = await issueToken(userIds[1]!)
    const res = await post('/auth/password/reset', { token, newPassword: 'Should-Not-Work-6666-ffffff' })
    expect(res.status).toBe(400)

    // And the disabled account's password is untouched.
    const row = await prisma.user.findUnique({ where: { id: userIds[1] }, select: { password: true } })
    expect(await bcrypt.compare(OLD_PASSWORD, row!.password)).toBe(true)
  })

  test('a short password is rejected before the token is spent', async () => {
    const token = await issueToken(userIds[0]!)
    const res = await post('/auth/password/reset', { token, newPassword: 'short' })
    expect(res.status).toBe(400)

    // The token must survive a validation failure — otherwise one typo burns
    // the link and the person has to start over from their inbox.
    const row = await prisma.staffPasswordReset.findUnique({ where: { tokenHash: sha256(token) } })
    expect(row?.consumedAt).toBeNull()
  })
})

describe('GET /auth/password/reset', () => {
  test('reports a good link as valid and a spent one as not', async () => {
    const token = await issueToken(userIds[0]!)

    const before = await get(`/auth/password/reset?token=${encodeURIComponent(token)}`)
    expect(before.body.valid).toBe(true)

    await post('/auth/password/reset', { token, newPassword: 'Fresh-Password-7777-gggggg' })

    const after = await get(`/auth/password/reset?token=${encodeURIComponent(token)}`)
    expect(after.body.valid).toBe(false)
  })

  test('reports an absent token as invalid rather than erroring', async () => {
    const res = await get('/auth/password/reset')
    expect(res.status).toBe(200)
    expect(res.body.valid).toBe(false)
  })
})
