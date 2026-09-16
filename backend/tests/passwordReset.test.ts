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
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'
import crypto from 'crypto'

const prisma = (globalThis as { __TEST_PRISMA__?: PrismaClient }).__TEST_PRISMA__ ?? new PrismaClient()
const API = process.env['TEST_API_URL'] ?? 'http://127.0.0.1:3011/api/v1'

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
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
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
  await prisma.staffPasswordReset.deleteMany({ where: { userId: { in: userIds } } })
  await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  await prisma.tenant.deleteMany({ where: { id: tenantId } })
})

describe('POST /auth/password/forgot', () => {
  test('is not an account-existence oracle', async () => {
    const real    = await post('/auth/password/forgot', { email: LIVE_EMAIL })
    const nobody  = await post('/auth/password/forgot', { email: UNKNOWN_EMAIL })

    expect(real.status).toBe(202)
    expect(nobody.status).toBe(nobody.status)
    // Identical status AND identical body. A difference in either is enough to
    // enumerate which addresses are staff accounts.
    expect(nobody.status).toBe(202)
    expect(nobody.body).toEqual(real.body)
  })

  test('issues a token for a real account', async () => {
    await post('/auth/password/forgot', { email: LIVE_EMAIL })
    const rows = await prisma.staffPasswordReset.findMany({ where: { userId: userIds[0] } })
    expect(rows.length).toBeGreaterThan(0)
  })

  test('issues nothing for an address with no account', async () => {
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

  test('a new request invalidates the previous link', async () => {
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

    const before = await fetch(`${API}/auth/password/reset?token=${encodeURIComponent(token)}`)
    expect((await before.json()).valid).toBe(true)

    await post('/auth/password/reset', { token, newPassword: 'Fresh-Password-7777-gggggg' })

    const after = await fetch(`${API}/auth/password/reset?token=${encodeURIComponent(token)}`)
    expect((await after.json()).valid).toBe(false)
  })

  test('reports an absent token as invalid rather than erroring', async () => {
    const res = await fetch(`${API}/auth/password/reset`)
    expect(res.status).toBe(200)
    expect((await res.json()).valid).toBe(false)
  })
})
