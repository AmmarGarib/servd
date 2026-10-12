// People audit, tips and the time clock (scratchpad audit/people/report.json).
//
//   PPL-01  two pools over the same brand and window both took the same tips
//           and both paid: PKR 500 of tips cost PKR 1,000.
//   PPL-02  a Stackd pool paid a cook who works the Flipd kitchen.
//   PPL-03  a forgotten clock-out blocked the next day's clock-in, status said
//           "not clocked in", and the late out booked a 25-hour shift that took
//           the whole by-hours pool.
//   HR-R7   a kitchen helper who punches only at the kiosk (no login) was never
//           a pool member, so the login holders split the whole pot. Staff
//           with no login are members now (employeeId).
//
// Two companies throughout: company B never sees or touches A's pools.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import type { UserRole } from '@prisma/client'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { invalidateSetupCache } from '../src/lib/setup-config.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { tipPoolRoutes, pairSpans } from '../src/modules/tipPools/routes.js'
import { timeClockRoutes } from '../src/modules/timeclock/routes.js'
import { recordPunch, isMissedClockOut } from '../src/modules/hr/attendance.js'

const H = 3_600_000
const stamp = Date.now()
/** A Karachi wall-clock time as an instant (PKT = UTC+5). */
const pkt = (date: string, hhmm: string) => new Date(new Date(`${date}T${hhmm}:00.000Z`).getTime() - 5 * H)

let app: FastifyInstance
let tenantA: string, tenantB: string
let stackd: string, flipd: string, bunKebab: string
let clifton: string, dha: string, saddar: string
const users: Record<string, { id: string; token: string }> = {}
const emps: Record<string, string> = {}

async function mkUser(key: string, role: string, tenantId: string) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${stamp}@pplaudit.pk`, password: await bcrypt.hash('x-Password-1', 4), role: role as UserRole, isActive: true, accountStatus: 'active', tenantId },
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } })
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
  return u.id
}
async function mkEmp(key: string, tenantId: string, extra: Record<string, unknown> = {}) {
  const e = await prisma.hrEmployee.create({
    data: { tenantId, employeeCode: `T-${String(Object.keys(emps).length + 1).padStart(4, '0')}`, fullName: key, grossSalaryCents: 5_000_000, joiningDate: new Date('2025-01-01'), ...extra },
  })
  emps[key] = e.id
  return e.id
}
const call = (who: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url: `/api/v1${url}`, payload: payload as never, headers: { authorization: `Bearer ${users[who]!.token}` } })

async function setOps(tenantId: string, data: Record<string, unknown>) {
  const cur = await prisma.operationsConfig.findFirst({ where: { tenantId, scope: 'global', scopeId: null } })
  if (cur) await prisma.operationsConfig.update({ where: { id: cur.id }, data })
  else await prisma.operationsConfig.create({ data: { tenantId, scope: 'global', scopeId: null, ...data } })
  invalidateSetupCache()
}
async function tipOrder(conceptId: string, tipCents: number, at: Date) {
  return prisma.order.create({
    data: { conceptId, source: 'pos', status: 'completed', completedAt: at, totalCents: 100_000 + tipCents, tipCents },
  })
}
const memberNames = (pool: { members: Array<{ userName: string }> }) => pool.members.map((m) => m.userName).sort()

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'GS Foods (ppl)', slug: `gs-ppl-${stamp}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'Karachi Bites (ppl)', slug: `kb-ppl-${stamp}` } })).id
  await ensureChartOfAccounts(tenantA)
  await ensureChartOfAccounts(tenantB)
  stackd = (await prisma.concept.create({ data: { name: 'Stackd', slug: `stackd-ppl-${stamp}`, type: 'restaurant', tenantId: tenantA } })).id
  flipd = (await prisma.concept.create({ data: { name: 'Flipd', slug: `flipd-ppl-${stamp}`, type: 'restaurant', tenantId: tenantA } })).id
  bunKebab = (await prisma.concept.create({ data: { name: 'Bun Kebab Co', slug: `bk-ppl-${stamp}`, type: 'restaurant', tenantId: tenantB } })).id
  clifton = (await prisma.location.create({ data: { slug: `clifton-${stamp}`, name: 'Clifton Block 5', tenantId: tenantA, latitude: 24.8138, longitude: 67.0300 } })).id
  dha = (await prisma.location.create({ data: { slug: `dha-${stamp}`, name: 'DHA Phase 6 Kitchen', tenantId: tenantA, latitude: 24.7900, longitude: 67.0650 } })).id
  saddar = (await prisma.location.create({ data: { slug: `saddar-${stamp}`, name: 'Saddar', tenantId: tenantB, latitude: 24.8600, longitude: 67.0100 } })).id
  await prisma.conceptLocation.create({ data: { conceptId: stackd, locationId: clifton } })
  await prisma.conceptLocation.create({ data: { conceptId: flipd, locationId: dha } })
  await prisma.conceptLocation.create({ data: { conceptId: bunKebab, locationId: saddar } })

  await mkUser('ceo', 'admin', tenantA)
  await mkUser('omar', 'manager', tenantA) // legacy manager tier: holds the payroll module
  await mkUser('ali', 'cashier', tenantA)
  await mkUser('danish', 'foh', tenantA)
  await mkUser('ayesha', 'foh', tenantA)
  await mkUser('nobranch', 'foh', tenantA)
  await mkUser('zara', 'foh', tenantA)
  await mkUser('ceoB', 'admin', tenantB)
  await mkUser('kbCashier', 'cashier', tenantB)
  await mkEmp('Ali Raza', tenantA, { userId: users['ali']!.id, locationId: clifton })
  await mkEmp('Danish Iqbal', tenantA, { userId: users['danish']!.id, locationId: dha })
  await mkEmp('Ayesha Khan', tenantA, { userId: users['ayesha']!.id, locationId: clifton })
  await mkEmp('No Branch', tenantA, { userId: users['nobranch']!.id })
  await mkEmp('Zara', tenantA, { userId: users['zara']!.id, locationId: clifton })
  await mkEmp('KB Cashier', tenantB, { userId: users['kbCashier']!.id })
  await setOps(tenantA, { tipPoolEnabled: true, tipPoolDistribution: 'by_hours' })
  await setOps(tenantB, { tipPoolEnabled: true, tipPoolDistribution: 'equal' })

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(tipPoolRoutes, { prefix: '/api/v1/tip-pools' })
  await app.register(timeClockRoutes, { prefix: '/api/v1/time-clock' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  await app?.close()
})

// ─── PPL-03: a forgotten clock-out ───────────────────────────────────────────

describe('PPL-03 a missed clock-out is a flagged day, never a 25-hour shift', () => {
  it('knows a forgotten out from a night shift', () => {
    // 18:00 yesterday → 09:00 today: forgotten. 17:00 → 01:00: still tonight's shift.
    expect(isMissedClockOut(pkt('2026-10-09', '18:00'), pkt('2026-10-10', '09:00'))).toBe(true)
    expect(isMissedClockOut(pkt('2026-10-09', '17:00'), pkt('2026-10-10', '01:00'))).toBe(false)
    expect(isMissedClockOut(pkt('2026-10-10', '00:10'), pkt('2026-10-10', '17:00'))).toBe(true) // 16 h+
    expect(isMissedClockOut(pkt('2026-10-10', '09:00'), pkt('2026-10-10', '20:00'))).toBe(false)
  })

  it('lets today\'s clock-in through, flags yesterday for HR, and status agrees with the clock', async () => {
    const staleAt = new Date(Date.now() - 26 * H)
    const log = await prisma.clockLog.create({ data: { userId: users['ali']!.id, type: 'in', recordedAt: staleAt } })
    const day1 = await recordPunch({ tenantId: tenantA, employeeId: emps['Ali Raza']!, kind: 'in', at: staleAt, source: 'clock', clockLogId: log.id, locationId: clifton, geofenceMatched: true })

    // Before: status and clock-in disagreed (punchedIn false, clock-in "already in").
    const before = await call('ali', 'GET', '/time-clock/status')
    expect(before.json()).toMatchObject({ punchedIn: false, missedClockOut: { since: staleAt.toISOString() } })

    const inn = await call('ali', 'POST', '/time-clock/clock-in', { lat: 24.8138, lng: 67.0300 })
    expect(inn.statusCode).toBe(201)
    expect(inn.json().alreadyClockedIn).toBeUndefined()
    expect(inn.json().missedClockOut.since).toBe(staleAt.toISOString())
    expect(inn.json().attendance.recordId).not.toBe(day1.recordId)

    const flagged = await prisma.hrRecord.findUniqueOrThrow({ where: { id: day1.recordId! } })
    expect(flagged.category).toBe('missing_punch')
    expect((flagged.data as Record<string, unknown>)['_missedOut']).toBeTruthy()
    expect((flagged.data as Record<string, unknown>)['checkOut']).toBeNull()

    const during = await call('ali', 'GET', '/time-clock/status')
    expect(during.json()).toMatchObject({ punchedIn: true, missedClockOut: null })
    expect(during.json().shift.clockInAt).toBe(inn.json().clockedInAt)

    const out = await call('ali', 'POST', '/time-clock/clock-out', {})
    expect(out.statusCode).toBe(200)
    expect(out.json().attendance.recordId).toBe(inn.json().attendance.recordId) // today's day, not yesterday's
    // Yesterday stays open-ended for HR: no out was paired with it.
    const still = await prisma.hrRecord.findUniqueOrThrow({ where: { id: day1.recordId! } })
    expect((still.data as Record<string, unknown>)['checkOut']).toBeNull()
    expect(((still.data as Record<string, unknown>)['_punches'] as unknown[]).length).toBe(1)
  })

  it('a clock-out the next day does not pair with yesterday\'s in', async () => {
    const staleAt = new Date(Date.now() - 25.5 * H)
    const log = await prisma.clockLog.create({ data: { userId: users['zara']!.id, type: 'in', recordedAt: staleAt } })
    const day1 = await recordPunch({ tenantId: tenantA, employeeId: emps['Zara']!, kind: 'in', at: staleAt, source: 'clock', clockLogId: log.id, locationId: clifton, geofenceMatched: true })
    const out = await call('zara', 'POST', '/time-clock/clock-out', {})
    expect(out.json()).toMatchObject({ notClockedIn: true, missedClockOut: { since: staleAt.toISOString() } })
    expect(await prisma.clockLog.count({ where: { userId: users['zara']!.id, type: 'out' } })).toBe(0)
    const rec = await prisma.hrRecord.findUniqueOrThrow({ where: { id: day1.recordId! } })
    expect(rec.category).toBe('missing_punch')
    // …and the attendance writer refuses it on its own too (kiosk path).
    const late = await recordPunch({ tenantId: tenantA, employeeId: emps['Zara']!, kind: 'out', source: 'kiosk' })
    expect(late.skipped === 'missed_out' || late.skipped === 'no_open_day').toBe(true)
    expect(((await prisma.hrRecord.findUniqueOrThrow({ where: { id: day1.recordId! } })).data as Record<string, unknown>)['checkOut']).toBeNull()
  })

  it('a shift still in progress is still "already clocked in"', async () => {
    const recent = new Date(Date.now() - 3 * H)
    await prisma.clockLog.create({ data: { userId: users['ayesha']!.id, type: 'in', recordedAt: recent } })
    const again = await call('ayesha', 'POST', '/time-clock/clock-in', {})
    expect(again.statusCode).toBe(200)
    expect(again.json()).toMatchObject({ alreadyClockedIn: true })
    expect((await call('ayesha', 'GET', '/time-clock/status')).json().punchedIn).toBe(true)
    await prisma.clockLog.create({ data: { userId: users['ayesha']!.id, type: 'out', recordedAt: new Date(Date.now() - 2 * H) } })
  })

  it('never counts a span over 16 h as worked (legacy 25-hour pairs)', () => {
    const t0 = new Date('2026-10-09T13:00:00Z')
    expect(pairSpans([{ type: 'in', at: t0 }, { type: 'out', at: new Date(t0.getTime() + 25.5 * H) }])).toEqual([])
    expect(pairSpans([{ type: 'in', at: t0 }, { type: 'in', at: new Date(t0.getTime() + 24 * H) }, { type: 'out', at: new Date(t0.getTime() + 30 * H) }]))
      .toEqual([{ inAt: new Date(t0.getTime() + 24 * H), outAt: new Date(t0.getTime() + 30 * H), locationId: null }])
  })
})

// ─── PPL-02 / PPL-01: who is in a pool, and a tip pooled once ────────────────

describe('PPL-02 a brand\'s pool holds only the hours worked at its branches', () => {
  const w0 = new Date(Date.now() - 80 * H)
  const w1 = new Date(Date.now() - 70 * H)

  it('leaves out the Flipd cook, anyone with no known branch, and a legacy 25-hour pair', async () => {
    const at = (h: number) => new Date(w0.getTime() + h * H)
    // Ali at Clifton (Stackd) 4 h, by the punch's own branch.
    await recordPunch({ tenantId: tenantA, employeeId: emps['Ali Raza']!, kind: 'in', at: at(1), source: 'clock', locationId: clifton, geofenceMatched: true })
    await recordPunch({ tenantId: tenantA, employeeId: emps['Ali Raza']!, kind: 'out', at: at(5), source: 'clock' })
    // Danish at the Flipd kitchen 4 h — by his punch and his HR branch.
    await recordPunch({ tenantId: tenantA, employeeId: emps['Danish Iqbal']!, kind: 'in', at: at(1), source: 'clock', locationId: dha, geofenceMatched: true })
    await recordPunch({ tenantId: tenantA, employeeId: emps['Danish Iqbal']!, kind: 'out', at: at(5), source: 'clock' })
    // Ayesha punched with no fix: her HR branch (Clifton) places her at Stackd, 2 h.
    await recordPunch({ tenantId: tenantA, employeeId: emps['Ayesha Khan']!, kind: 'in', at: at(2), source: 'clock' })
    await recordPunch({ tenantId: tenantA, employeeId: emps['Ayesha Khan']!, kind: 'out', at: at(4), source: 'clock' })
    // No branch at all, in a company with two brands: cannot be placed.
    await recordPunch({ tenantId: tenantA, employeeId: emps['No Branch']!, kind: 'in', at: at(1), source: 'clock' })
    await recordPunch({ tenantId: tenantA, employeeId: emps['No Branch']!, kind: 'out', at: at(5), source: 'clock' })
    // Zara: a 25-hour pair stored before the fix — counts nothing.
    const day = new Date(Date.UTC(at(0).getUTCFullYear(), at(0).getUTCMonth(), at(0).getUTCDate()))
    await prisma.hrRecord.create({
      data: {
        tenantId: tenantA, section: 'attendance', formVersion: 0, employeeId: emps['Zara']!, startDate: day, category: 'present', status: 'approved',
        data: { employee: emps['Zara'], checkIn: '09:00', checkOut: '10:00', _source: 'clock',
          _punches: [{ type: 'in', at: at(-15).toISOString(), source: 'clock', locationId: clifton, geofenceMatched: true }, { type: 'out', at: at(9.5).toISOString(), source: 'clock' }] },
      },
    })
    await tipOrder(stackd, 30_000, at(3))
    await tipOrder(flipd, 99_000, at(3)) // Flipd's tips stay Flipd's

    const pool = await call('omar', 'POST', '/tip-pools', { conceptId: stackd, name: 'Stackd Thu', periodStart: w0.toISOString(), periodEnd: w1.toISOString() })
    expect(pool.statusCode).toBe(201)
    expect(pool.json().totalTipsCents).toBe(30_000)
    expect(memberNames(pool.json())).toEqual(['ali', 'ayesha']) // not danish (Flipd), not nobranch, not zara
    const hours = Object.fromEntries((pool.json().members as Array<{ userName: string; hoursWorked: number }>).map((m) => [m.userName, m.hoursWorked]))
    expect(hours).toEqual({ ali: 4, ayesha: 2 })

    const flipdPool = await call('omar', 'POST', '/tip-pools', { conceptId: flipd, name: 'Flipd Thu', periodStart: w0.toISOString(), periodEnd: w1.toISOString() })
    expect(flipdPool.statusCode).toBe(201)
    expect(memberNames(flipdPool.json())).toEqual(['danish'])
    expect(flipdPool.json().totalTipsCents).toBe(99_000)
  })

  it('refuses a brand with no branch in a company that has several brands', async () => {
    const loose = (await prisma.concept.create({ data: { name: 'Simmer', slug: `simmer-ppl-${stamp}`, type: 'restaurant', tenantId: tenantA } })).id
    const r = await call('omar', 'POST', '/tip-pools', { conceptId: loose, name: 'Simmer', periodStart: w0.toISOString(), periodEnd: w1.toISOString() })
    expect(r.statusCode).toBe(422)
    expect(r.json().error.code).toBe('BRAND_HAS_NO_BRANCH')
    await prisma.concept.update({ where: { id: loose }, data: { deletedAt: new Date() } })
  })

  it('in a one-brand company a punch with no branch still counts', async () => {
    const t = new Date(Date.now() - 50 * H)
    await recordPunch({ tenantId: tenantB, employeeId: emps['KB Cashier']!, kind: 'in', at: t, source: 'clock' })
    await recordPunch({ tenantId: tenantB, employeeId: emps['KB Cashier']!, kind: 'out', at: new Date(t.getTime() + 3 * H), source: 'clock' })
    const r = await call('ceoB', 'POST', '/tip-pools', { conceptId: bunKebab, name: 'BK', periodStart: new Date(t.getTime() - H).toISOString(), periodEnd: new Date(t.getTime() + 5 * H).toISOString() })
    expect(r.statusCode).toBe(201)
    expect(memberNames(r.json())).toEqual(['kbCashier'])
  })
})

describe('PPL-01 a tip is pooled once and paid once', () => {
  const start = new Date(Date.now() - 10 * H)
  const end = new Date(Date.now() - 4 * H)
  let poolA: string

  it('refuses a second pool over the same brand and window, and a partial overlap', async () => {
    await recordPunch({ tenantId: tenantA, employeeId: emps['Ali Raza']!, kind: 'in', at: new Date(start.getTime() + H), source: 'clock', locationId: clifton, geofenceMatched: true })
    await recordPunch({ tenantId: tenantA, employeeId: emps['Ali Raza']!, kind: 'out', at: new Date(start.getTime() + 4 * H), source: 'clock' })
    await tipOrder(stackd, 50_000, new Date(start.getTime() + 2 * H))
    const a = await call('omar', 'POST', '/tip-pools', { conceptId: stackd, name: 'Stackd weekend', periodStart: start.toISOString(), periodEnd: end.toISOString() })
    expect(a.statusCode).toBe(201)
    expect(a.json().totalTipsCents).toBe(50_000)
    poolA = a.json().id

    const dup = await call('omar', 'POST', '/tip-pools', { conceptId: stackd, name: 'Stackd weekend (dup)', periodStart: start.toISOString(), periodEnd: end.toISOString() })
    expect(dup.statusCode).toBe(409)
    expect(dup.json().error.code).toBe('POOL_OVERLAP')
    const partial = await call('omar', 'POST', '/tip-pools', { conceptId: stackd, name: 'Overlap', periodStart: new Date(start.getTime() - 2 * H).toISOString(), periodEnd: new Date(start.getTime() + H).toISOString() })
    expect(partial.statusCode).toBe(409)
    // Back to back is fine: the window is half-open.
    const next = await call('omar', 'POST', '/tip-pools', { conceptId: stackd, name: 'Next', periodStart: end.toISOString(), periodEnd: new Date(end.getTime() + H).toISOString() })
    expect(next.statusCode).toBe(201)
    expect(next.json().totalTipsCents).toBe(0)
    // Another brand's window is its own.
    expect((await call('omar', 'POST', '/tip-pools', { conceptId: flipd, name: 'Flipd', periodStart: start.toISOString(), periodEnd: end.toISOString() })).statusCode).toBe(201)
    // A draft can be thrown away; a posted one cannot.
    expect((await call('omar', 'DELETE', `/tip-pools/${next.json().id}`)).statusCode).toBe(204)
  })

  it('pays a pool once, and never pays a second pool over the same tips', async () => {
    // A duplicate left over from before the rule, written straight to the table.
    const legacy = await prisma.tipPool.create({ data: { tenantId: tenantA, conceptId: stackd, name: 'legacy dup', periodStart: start, periodEnd: end, totalTipsCents: 50_000 } })
    await prisma.tipPoolMember.create({ data: { poolId: legacy.id, userId: users['ali']!.id, userName: 'ali', hoursWorked: 3, roleWeight: 1, shareUnits: 3 } })

    expect((await call('ceo', 'POST', `/tip-pools/${poolA}/post`)).statusCode).toBe(200)
    const postDup = await call('ceo', 'POST', `/tip-pools/${legacy.id}/post`)
    expect(postDup.statusCode).toBe(409)
    expect(postDup.json().error.code).toBe('POOL_OVERLAP')

    expect((await call('ceo', 'POST', `/tip-pools/${poolA}/pay`, {})).statusCode).toBe(200)
    expect((await call('ceo', 'POST', `/tip-pools/${poolA}/pay`, {})).statusCode).toBe(422) // a second click

    // Even forced to "posted", the duplicate cannot be paid.
    await prisma.tipPool.update({ where: { id: legacy.id }, data: { status: 'posted' } })
    const payDup = await call('ceo', 'POST', `/tip-pools/${legacy.id}/pay`, {})
    expect(payDup.statusCode).toBe(409)
    expect((await prisma.tipPool.findUniqueOrThrow({ where: { id: legacy.id } })).status).toBe('posted')

    const payouts = await prisma.journalEntry.findMany({ where: { tenantId: tenantA, reference: { startsWith: 'tippool.payout:' } }, include: { lines: { include: { account: { select: { code: true } } } } } })
    expect(payouts.length).toBe(1)
    const debit2095 = payouts.flatMap((e) => e.lines).filter((l) => l.account.code === '2095' && l.type === 'debit').reduce((a, l) => a + l.amountCents, 0)
    expect(debit2095).toBe(50_000)
    expect((await call('omar', 'DELETE', `/tip-pools/${poolA}`)).statusCode).toBe(409)
  })

  it('company B never sees, posts, pays or deletes company A\'s pool, nor pools its brand', async () => {
    expect((await call('ceoB', 'GET', `/tip-pools/${poolA}`)).statusCode).toBe(404)
    expect((await call('ceoB', 'DELETE', `/tip-pools/${poolA}`)).statusCode).toBe(404)
    expect((await call('ceoB', 'POST', `/tip-pools/${poolA}/post`)).statusCode).toBe(404)
    expect((await call('ceoB', 'POST', `/tip-pools/${poolA}/pay`, {})).statusCode).toBe(404)
    const list = (await call('ceoB', 'GET', '/tip-pools')).json() as Array<{ id: string }>
    expect(list.some((p) => p.id === poolA)).toBe(false)
    expect((await call('ceoB', 'POST', '/tip-pools', { conceptId: stackd, name: 'x', periodStart: start.toISOString(), periodEnd: end.toISOString() })).statusCode).toBe(404)
  })
})

// ─── HR-R7: staff with no login are never silently cut out of a pool ───────
// Since 2026-10-12 they are pool members (tip_pool_members.employeeId). One
// whose HR record does not say their tip-pool role stops the post until they
// are added with a weight or left out by name (tipPoolCompany.test.ts covers
// the ones whose designation does say).

describe('HR-R7 staff with no login and no known role stop a pool from paying their share to others', () => {
  const k0 = new Date(Date.now() - 44 * H)
  const k1 = new Date(Date.now() - 34 * H)
  const at = (h: number) => new Date(k0.getTime() + h * H)
  let draftId: string

  it('lists the helper\'s hours and refuses to post until they are in the pool or left out by name', async () => {
    await mkEmp('Kitchen Helper', tenantA, { locationId: clifton }) // no login, no designation: punches by PIN at the kiosk
    await mkEmp('KB Dishwasher', tenantB, { locationId: saddar })   // company B's kiosk-only staff
    await recordPunch({ tenantId: tenantA, employeeId: emps['Kitchen Helper']!, kind: 'in', at: at(1), source: 'kiosk', locationId: clifton, geofenceMatched: true })
    await recordPunch({ tenantId: tenantA, employeeId: emps['Kitchen Helper']!, kind: 'out', at: at(7), source: 'kiosk' })
    await recordPunch({ tenantId: tenantB, employeeId: emps['KB Dishwasher']!, kind: 'in', at: at(1), source: 'kiosk', locationId: saddar, geofenceMatched: true })
    await recordPunch({ tenantId: tenantB, employeeId: emps['KB Dishwasher']!, kind: 'out', at: at(7), source: 'kiosk' })
    await recordPunch({ tenantId: tenantA, employeeId: emps['Ali Raza']!, kind: 'in', at: at(2), source: 'clock', locationId: clifton, geofenceMatched: true })
    await recordPunch({ tenantId: tenantA, employeeId: emps['Ali Raza']!, kind: 'out', at: at(4), source: 'clock' })
    await tipOrder(stackd, 60_000, at(3))

    const pool = await call('omar', 'POST', '/tip-pools', { conceptId: stackd, name: 'Stackd kiosk', periodStart: k0.toISOString(), periodEnd: k1.toISOString() })
    expect(pool.statusCode).toBe(201)
    draftId = pool.json().id
    expect(memberNames(pool.json())).toEqual(['ali'])
    // Company B's dishwasher is never in company A's pool, not even as a note.
    const excluded = pool.json().excluded as Array<{ name: string; employeeId: string; hours: number; reason: string }>
    expect(excluded.map((x) => x.name)).toEqual(['Kitchen Helper'])
    expect(excluded[0]).toMatchObject({ employeeId: emps['Kitchen Helper'], hours: 6, reason: 'no_role' })
    expect(pool.json().review.staffWithoutRole.map((x: { name: string }) => x.name)).toEqual(['Kitchen Helper'])

    // Before HR-R7 this posted and gave the cashier 100% of the pot.
    const blind = await call('ceo', 'POST', `/tip-pools/${draftId}/post`, {})
    expect(blind.statusCode).toBe(409)
    expect(blind.json().error.code).toBe('STAFF_ROLE_UNKNOWN')
    expect(blind.json().error.message).toContain('Kitchen Helper')
    // Naming somebody else, or giving no real reason, does not get past it.
    const wrong = await call('ceo', 'POST', `/tip-pools/${draftId}/post`, { leaveOutStaff: { employeeIds: [emps['KB Dishwasher']], reason: 'not tip eligible' } })
    expect(wrong.statusCode).toBe(409)
    const noReason = await call('ceo', 'POST', `/tip-pools/${draftId}/post`, { leaveOutStaff: { employeeIds: [emps['Kitchen Helper']], reason: '' } })
    expect(noReason.statusCode).toBe(400)
    expect((await prisma.tipPool.findUniqueOrThrow({ where: { id: draftId } })).status).toBe('draft')
    expect(await prisma.tipPoolMember.count({ where: { poolId: draftId, shareCents: { gt: 0 } } })).toBe(0)
  })

  it('added on the draft with a weight, the helper (no login) is paid their hours\' share', async () => {
    // Company B cannot add to A's draft, nor A add B's employee.
    expect((await call('ceoB', 'POST', `/tip-pools/${draftId}/members`, { employeeId: emps['KB Dishwasher'], hoursWorked: 6, roleWeight: 0.5 })).statusCode).toBe(404)
    const foreign = await call('omar', 'POST', `/tip-pools/${draftId}/members`, { employeeId: emps['KB Dishwasher'], hoursWorked: 6, roleWeight: 0.5 })
    expect(foreign.statusCode).toBe(422)
    expect(foreign.json().error.code).toBe('MEMBER_NOT_IN_COMPANY')
    // No weight and no role to take one from: asked for, never guessed.
    expect((await call('omar', 'POST', `/tip-pools/${draftId}/members`, { employeeId: emps['Kitchen Helper'], hoursWorked: 6 })).json().error.code).toBe('ROLE_WEIGHT_REQUIRED')

    const added = await call('omar', 'POST', `/tip-pools/${draftId}/members`, { employeeId: emps['Kitchen Helper'], hoursWorked: 6, roleWeight: 0.5 })
    expect(added.statusCode).toBe(201)
    expect(added.json()).toMatchObject({ userId: null, employeeId: emps['Kitchen Helper'], userName: 'Kitchen Helper', hoursWorked: 6, roleWeight: 0.5, shareUnits: 6 })
    expect((await call('omar', 'POST', `/tip-pools/${draftId}/members`, { employeeId: emps['Kitchen Helper'], hoursWorked: 6, roleWeight: 0.5 })).statusCode).toBe(409)
    const review = (await call('omar', 'GET', `/tip-pools/${draftId}`)).json().review
    expect(review.staffWithoutRole).toEqual([])
    expect(review.blockers).toEqual([])

    const posted = await call('ceo', 'POST', `/tip-pools/${draftId}/post`, {})
    expect(posted.statusCode).toBe(200)
    const shares = Object.fromEntries((posted.json().members as Array<{ userName: string; shareCents: number }>).map((m) => [m.userName, m.shareCents]))
    expect(shares).toEqual({ ali: 15_000, 'Kitchen Helper': 45_000 }) // 2 h vs 6 h of PKR 600
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'tippool.distribute', entity: 'TipPoolMember', after: { path: ['employeeId'], equals: emps['Kitchen Helper'] } } })
    expect(log.tenantId).toBe(tenantA)
  })

  it('an approver can leave someone with no known role out by name, with a reason, and it is audited', async () => {
    const t0 = new Date(Date.now() - 33 * H)
    await mkEmp('Night Guard', tenantA, { locationId: clifton })
    await recordPunch({ tenantId: tenantA, employeeId: emps['Night Guard']!, kind: 'in', at: new Date(t0.getTime() + H), source: 'kiosk', locationId: clifton, geofenceMatched: true })
    await recordPunch({ tenantId: tenantA, employeeId: emps['Night Guard']!, kind: 'out', at: new Date(t0.getTime() + 5 * H), source: 'kiosk' })
    await recordPunch({ tenantId: tenantA, employeeId: emps['Ayesha Khan']!, kind: 'in', at: new Date(t0.getTime() + H), source: 'clock', locationId: clifton, geofenceMatched: true })
    await recordPunch({ tenantId: tenantA, employeeId: emps['Ayesha Khan']!, kind: 'out', at: new Date(t0.getTime() + 3 * H), source: 'clock' })
    await tipOrder(stackd, 10_000, new Date(t0.getTime() + 2 * H))
    const pool = await call('omar', 'POST', '/tip-pools', { conceptId: stackd, name: 'Guard night', periodStart: t0.toISOString(), periodEnd: new Date(t0.getTime() + 6 * H).toISOString() })
    expect(pool.statusCode).toBe(201)
    expect(pool.json().review.staffWithoutRole.map((x: { name: string }) => x.name)).toEqual(['Night Guard'])
    // Company B cannot post it, whatever it acknowledges.
    expect((await call('ceoB', 'POST', `/tip-pools/${pool.json().id}/post`, { leaveOutStaff: { employeeIds: [emps['Night Guard']], reason: 'security, not tipped' } })).statusCode).toBe(404)
    // The field's old name still works.
    const ok = await call('ceo', 'POST', `/tip-pools/${pool.json().id}/post`, { leaveOutKioskStaff: { employeeIds: [emps['Night Guard']], reason: 'security, not tipped' } })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().members.map((m: { userName: string; shareCents: number }) => [m.userName, m.shareCents])).toEqual([['ayesha', 10_000]])
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'tippool.post', entityId: pool.json().id } })
    expect(log.tenantId).toBe(tenantA)
    expect(log.metadata).toMatchObject({ reason: 'security, not tipped', staffLeftOut: [{ employeeId: emps['Night Guard'], name: 'Night Guard', hours: 4 }] })
  })
})
