// A staff sign-in lasts ONE SHIFT, and two-step sign-in is retired (owner B1,
// 2026-10-26: "Signin can last 1 shift … at shift close servd should auto sign
// u out no matter who u are. However people can login to servd outside the
// office").
//   - the session's end per case: a rota shift, the company default rota,
//     a day off / no HR record → midnight PKT, an overnight shift, the 24 h cap
//   - the tokens carry it; refresh is refused after it (401 SESSION_ENDED),
//     and a refresh token from before this release (no end) signs in again
//   - closing a till drawer ends its cashier's sessions (after the Z-report
//     grace); a session started after the close is untouched; the sweep stamps
//     drawers closed any other way
//   - /auth/2fa/* answers 410; password sign-in never asks for a code
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { AppError } from '../src/lib/errors.js'
import { issueStaffSession, refreshStaffToken, staffLogin } from '../src/modules/auth/service.js'
import { staffSessionEndsAt, endOfKarachiDay, sweepClosedDrawerSessions, SHIFT_CLOSE_GRACE_MS } from '../src/modules/auth/sessionEnd.js'
import { authRoutes } from '../src/modules/auth/routes.js'
import { posRoutes } from '../src/modules/pos/routes.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'

const P = `shs${Date.now()}`
let app: FastifyInstance
const T: Record<string, string> = {}
const U: Record<string, { id: string; email: string }> = {}
const PKT = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00.000+05:00`)
let empSeq = 0

async function mkUser(key: string, role: string, tenantId: string) {
  const email = `${P}.${key}@gsfoods.pk`
  const u = await prisma.user.create({
    data: {
      name: key, email, password: await bcrypt.hash('x-Password-12', 4), role: role as never, isActive: true, accountStatus: 'active', tenantId,
      tenantMemberships: { create: [{ tenant: { connect: { id: tenantId } }, role: 'member' }] },
    },
  })
  U[key] = { id: u.id, email }
  return u
}
async function mkEmp(userKey: string, tenantId: string) {
  return prisma.hrEmployee.create({
    data: {
      tenantId, userId: U[userKey]!.id, employeeCode: `${P}-${++empSeq}`, fullName: userKey,
      grossSalaryCents: 5_000_000, monthlyTaxCents: 0, joiningDate: new Date('2025-01-01'), paymentMethod: 'bank',
    },
  })
}
const rec = (tenantId: string, section: string, employeeId: string | null, data: Record<string, unknown>) =>
  prisma.hrRecord.create({ data: { tenantId, section, formVersion: 0, employeeId, status: 'approved', ...data } as never })

beforeAll(async () => {
  T.A = (await prisma.tenant.create({ data: { name: 'SHS A', slug: `${P}-a` } })).id
  T.B = (await prisma.tenant.create({ data: { name: 'SHS B', slug: `${P}-b` } })).id
  await ensureChartOfAccounts(T.A)
  await ensureChartOfAccounts(T.B)
  await mkUser('ceo', 'admin', T.A)          // no HR record
  await mkUser('dflt', 'foh', T.A)           // HR record, no roster → company default rota 11:00–19:00, Monday off
  await mkUser('rost', 'boh', T.A)           // roster 09:00–17:00
  await mkUser('night', 'kitchen', T.B)      // roster 18:00–02:00, company B
  await mkUser('cashier', 'cashier', T.A)
  await mkUser('mgrB', 'admin', T.B)
  await mkEmp('dflt', T.A)
  const r = await mkEmp('rost', T.A)
  const day = await rec(T.A, 'shift', null, { data: { name: 'Day', start: '09:00', end: '17:00' } })
  await rec(T.A, 'roster', r.id, { startDate: new Date('2026-01-01'), refId: day.id, data: { weeklyOff: [] } })
  const n = await mkEmp('night', T.B)
  const late = await rec(T.B, 'shift', null, { data: { name: 'Late', start: '18:00', end: '02:00' } })
  await rec(T.B, 'roster', n.id, { startDate: new Date('2026-01-01'), refId: late.id, data: { weeklyOff: [] } })

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(authRoutes, { prefix: '/auth' })
  await app.register(posRoutes, { prefix: '/pos' })
  await app.ready()
}, 60_000)

afterAll(async () => { await app?.close() })

describe('when a sign-in ends', () => {
  // 2026-10-27 is a Tuesday, 2026-10-26 a Monday.
  it('a rota shift: the end of that shift', async () => {
    expect((await staffSessionEndsAt(U.rost!.id, PKT('2026-10-27', '08:30'))).toISOString()).toBe(PKT('2026-10-27', '17:00').toISOString())
    expect((await staffSessionEndsAt(U.rost!.id, PKT('2026-10-27', '12:00'))).toISOString()).toBe(PKT('2026-10-27', '17:00').toISOString())
  })

  it('the company default rota (11:00–19:00) for a person with no roster', async () => {
    expect((await staffSessionEndsAt(U.dflt!.id, PKT('2026-10-27', '10:45'))).toISOString()).toBe(PKT('2026-10-27', '19:00').toISOString())
  })

  it('a day off (Monday on the default rota), signing in after the shift, or no HR record (the CEO): midnight PKT', async () => {
    const midnightMon = PKT('2026-10-27', '00:00').toISOString()
    expect((await staffSessionEndsAt(U.dflt!.id, PKT('2026-10-26', '10:00'))).toISOString()).toBe(midnightMon)
    expect((await staffSessionEndsAt(U.rost!.id, PKT('2026-10-27', '20:00'))).toISOString()).toBe(PKT('2026-10-28', '00:00').toISOString())
    expect((await staffSessionEndsAt(U.ceo!.id, PKT('2026-10-26', '09:00'))).toISOString()).toBe(midnightMon)
    expect(endOfKarachiDay(PKT('2026-10-26', '23:59')).toISOString()).toBe(midnightMon)
  })

  it('an overnight shift ends the next morning — also when signing in after midnight', async () => {
    expect((await staffSessionEndsAt(U.night!.id, PKT('2026-10-27', '17:30'))).toISOString()).toBe(PKT('2026-10-28', '02:00').toISOString())
    expect((await staffSessionEndsAt(U.night!.id, PKT('2026-10-28', '01:00'))).toISOString()).toBe(PKT('2026-10-28', '02:00').toISOString())
  })

  it('never longer than 24 hours', async () => {
    const now = new Date()
    const end = await staffSessionEndsAt(U.ceo!.id, now)
    expect(end.getTime()).toBeLessThanOrEqual(now.getTime() + 24 * 3600_000)
    expect(end.getTime()).toBeGreaterThan(now.getTime())
  })
})

describe('the tokens carry the end; refresh stops at it', () => {
  it('refresh and access tokens expire no later than the session end', () => {
    const end = new Date(Date.now() + 90 * 60_000)
    const s = issueStaffSession({ id: U.ceo!.id, name: 'ceo', email: U.ceo!.email, role: 'admin' }, end)
    const rt = jwt.decode(s.refreshToken) as { exp: number; se: number }
    const at = jwt.decode(s.accessToken) as { exp: number; se: number }
    expect(rt.se).toBe(Math.floor(end.getTime() / 1000))
    expect(rt.exp).toBeLessThanOrEqual(rt.se + 1)
    expect(at.exp).toBeLessThanOrEqual(rt.se)
    expect(s.sessionEndsAt).toBe(new Date(rt.se * 1000).toISOString())
    // An access token never outlives a session ending in 2 minutes.
    const soon = issueStaffSession({ id: U.ceo!.id, name: 'ceo', email: U.ceo!.email, role: 'admin' }, new Date(Date.now() + 120_000))
    expect((jwt.decode(soon.accessToken) as { exp: number }).exp).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 121)
  })

  it('password sign-in issues a shift session (no code step)', async () => {
    const r = await staffLogin(U.ceo!.email, 'x-Password-12')
    expect('twoFactorRequired' in r).toBe(false)
    expect(new Date(r.sessionEndsAt).getTime()).toBeLessThanOrEqual(Date.now() + 24 * 3600_000)
  })

  it('refresh works inside the session, and is refused after it with SESSION_ENDED', async () => {
    const s = issueStaffSession({ id: U.ceo!.id, name: 'ceo', email: U.ceo!.email, role: 'admin' }, new Date(Date.now() + 3600_000))
    const ok = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: s.refreshToken } })
    expect(ok.statusCode).toBe(200)
    expect((jwt.decode(ok.json().accessToken) as { exp: number }).exp).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 3601)

    const nowSec = Math.floor(Date.now() / 1000)
    const ended = jwt.sign({ sub: U.ceo!.id, email: U.ceo!.email, role: 'admin', type: 'refresh', se: nowSec - 10, iat: nowSec - 3600, exp: nowSec - 10 }, process.env['JWT_REFRESH_SECRET']!)
    const r = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: ended } })
    expect(r.statusCode).toBe(401)
    expect(r.json().error.code).toBe('SESSION_ENDED')

    // A refresh token minted before sign-ins lasted one shift carries no end: sign in again.
    const legacy = jwt.sign({ sub: U.ceo!.id, email: U.ceo!.email, role: 'admin', type: 'refresh' }, process.env['JWT_REFRESH_SECRET']!, { expiresIn: '7d' })
    await expect(refreshStaffToken(legacy)).rejects.toMatchObject({ code: 'SESSION_ENDED' })
  })
})

describe('closing a till drawer signs its cashier out', () => {
  it('the close stamps the cashier; after the Z-report grace their old session is refused, a new one works', async () => {
    // A session signed in 10 minutes ago.
    const nowSec = Math.floor(Date.now() / 1000)
    const claims = { sub: U.cashier!.id, email: U.cashier!.email, role: 'cashier', se: nowSec + 3600, iat: nowSec - 600 }
    const old = {
      accessToken: jwt.sign({ ...claims, type: 'access', exp: nowSec + 900 }, process.env['JWT_SECRET']!),
      refreshToken: jwt.sign({ ...claims, type: 'refresh', exp: nowSec + 3600 }, process.env['JWT_REFRESH_SECRET']!),
    }
    const shift = await prisma.shift.create({ data: { userId: U.cashier!.id, openingFloatCents: 0, status: 'open', tenantId: T.A } })
    const auth = { authorization: `Bearer ${old.accessToken}` }
    // Another company's manager cannot close it (404) — and nobody is signed out.
    const mgrB = issueStaffSession({ id: U.mgrB!.id, name: 'mgrB', email: U.mgrB!.email, role: 'admin' })
    const foreign = await app.inject({ method: 'POST', url: `/pos/shifts/${shift.id}/close`, headers: { authorization: `Bearer ${mgrB.accessToken}` }, payload: { closingFloatCents: 0 } })
    expect(foreign.statusCode).toBe(404)
    expect((await prisma.user.findUniqueOrThrow({ where: { id: U.cashier!.id } })).sessionsEndedAt).toBeNull()

    const closed = await app.inject({ method: 'POST', url: `/pos/shifts/${shift.id}/close`, headers: auth, payload: { closingFloatCents: 0 } })
    expect(closed.statusCode).toBe(200)
    const stamped = (await prisma.user.findUniqueOrThrow({ where: { id: U.cashier!.id } })).sessionsEndedAt
    expect(stamped).not.toBeNull()

    // Within the grace the Z-report screen still works.
    expect((await app.inject({ method: 'GET', url: '/pos/shifts/current', headers: auth })).statusCode).toBe(200)

    // The grace is over (as if 6 minutes later): the old session is refused, refresh too.
    await prisma.user.update({ where: { id: U.cashier!.id }, data: { sessionsEndedAt: new Date(Date.now() - SHIFT_CLOSE_GRACE_MS - 60_000) } })
    const refused = await app.inject({ method: 'GET', url: '/pos/shifts/current', headers: auth })
    expect(refused.statusCode).toBe(401)
    expect(refused.json().error.code).toBe('SESSION_ENDED')
    const rr = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: old.refreshToken } })
    expect(rr.statusCode).toBe(401)
    expect(rr.json().error.code).toBe('SESSION_ENDED')

    // Signing in again (a token issued after the close) works.
    const fresh = issueStaffSession({ id: U.cashier!.id, name: 'cashier', email: U.cashier!.email, role: 'cashier' })
    expect((await app.inject({ method: 'GET', url: '/pos/shifts/current', headers: { authorization: `Bearer ${fresh.accessToken}` } })).statusCode).toBe(200)
  })

  it('the sweep stamps a drawer closed any other way, and only moves the stamp forward', async () => {
    const closedAt = new Date(Date.now() - 2 * 60_000)
    await prisma.user.update({ where: { id: U.rost!.id }, data: { sessionsEndedAt: null } })
    await prisma.shift.create({ data: { userId: U.rost!.id, openingFloatCents: 0, status: 'closed', closedAt, tenantId: T.A } })
    expect(await sweepClosedDrawerSessions()).toBeGreaterThanOrEqual(1)
    expect((await prisma.user.findUniqueOrThrow({ where: { id: U.rost!.id } })).sessionsEndedAt?.toISOString()).toBe(closedAt.toISOString())
    const later = new Date()
    await prisma.user.update({ where: { id: U.rost!.id }, data: { sessionsEndedAt: later } })
    await sweepClosedDrawerSessions()
    expect((await prisma.user.findUniqueOrThrow({ where: { id: U.rost!.id } })).sessionsEndedAt?.toISOString()).toBe(later.toISOString())
  })
})

describe('two-step sign-in is gone', () => {
  it('every /auth/2fa route answers 410, and the CEO reset too', async () => {
    const s = issueStaffSession({ id: U.ceo!.id, name: 'ceo', email: U.ceo!.email, role: 'admin' })
    for (const [method, url] of [['POST', '/auth/2fa/verify'], ['POST', '/auth/2fa/start'], ['POST', '/auth/2fa/enable'], ['POST', '/auth/2fa/disable'], ['GET', '/auth/2fa/status'], ['POST', `/auth/users/${U.rost!.id}/2fa/reset`]] as const) {
      const r = await app.inject({ method, url, headers: { authorization: `Bearer ${s.accessToken}` }, payload: method === 'POST' ? {} : undefined })
      expect(r.statusCode, url).toBe(410)
      expect(r.json().error.code).toBe('TWO_STEP_RETIRED')
    }
  })

  it('a login that was enrolled signs straight in with its password', async () => {
    await prisma.user.update({ where: { id: U.ceo!.id }, data: { twoFactorPhone: '923001110000', twoFactorEnabledAt: new Date() } })
    const r = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: U.ceo!.email, password: 'x-Password-12' } })
    expect(r.statusCode).toBe(200)
    expect(r.json().accessToken).toBeTruthy()
    expect(r.json().twoFactorRequired).toBeUndefined()
    expect(r.json().sessionEndsAt).toBeTruthy()
  })
})
