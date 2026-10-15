// People ↔ HR reconciliation (items 62–64, 73–76).
//
//   Pure:      lateness against the rota, shifts past midnight, who has left,
//              the nearest branch for the geofence, tip weights.
//   Real DB:   the rota generated from HR roster + swaps + exceptions; punches
//              writing attendance (late, missing punch, hand-keyed rows left
//              alone, a correction rewriting the day); the time clock through
//              HTTP with the company geofence; the kiosk PIN; the /scheduling
//              grid and its HR-salary costing; tip pools on company rules;
//              logins linked per company; departments written in HR only;
//              budgeted labour without frozen seats; leavers' logins.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { invalidateSetupCache, tipPoolWeights, TIP_POOL_DEFAULT_WEIGHTS } from '../src/lib/setup-config.js'
import { budgetedLabour } from '../src/lib/labour-budget.js'
import { hrRoutes } from '../src/modules/hr/routes.js'
import { timeClockRoutes } from '../src/modules/timeclock/routes.js'
import { schedulingRoutes } from '../src/modules/scheduling/routes.js'
import { tipPoolRoutes } from '../src/modules/tipPools/routes.js'
import { positionRoutes } from '../src/modules/positions/routes.js'
import { minutesLate, statusFor, recordPunch, flagMissingPunches } from '../src/modules/hr/attendance.js'
import { rotaFor, segmentMinutes, cellMinutes } from '../src/modules/hr/rota.js'
import { hasLeft, deactivateLeftLogins } from '../src/modules/hr/separations.js'
import { nearestAnchor, enforceClockInPolicy } from '../src/modules/timeclock/policy.js'
import { prefillInputs } from '../src/modules/hr/service.js'

const RS = (r: number) => r * 100
/** A Karachi wall-clock time as an instant (PKT = UTC+5). */
const pkt = (date: string, hhmm: string) => new Date(new Date(`${date}T${hhmm}:00.000Z`).getTime() - 5 * 3_600_000)

// ─── pure ───────────────────────────────────────────────────────────────────

describe('rota and lateness arithmetic', () => {
  it('measures lateness the short way round the clock', () => {
    expect(minutesLate('09:40', '09:00')).toBe(40)
    expect(minutesLate('08:55', '09:00')).toBe(-5)
    expect(minutesLate('23:50', '00:00')).toBe(-10)
    expect(minutesLate('00:20', '23:00')).toBe(80)
  })
  it('is late only past the grace minutes, and present with no rostered shift', () => {
    const cell = { employeeId: 'e', date: '2026-09-21', kind: 'shift' as const, source: 'roster' as const, offExceptionId: null,
      segments: [{ start: '09:00', end: '17:00', shiftId: null, shiftName: null, breakMinutes: 0, exceptionId: null, conceptId: null, role: null, notes: null }] }
    expect(statusFor('09:15', cell, 15)).toEqual({ status: 'present', lateMinutes: null })
    expect(statusFor('09:16', cell, 15)).toEqual({ status: 'late', lateMinutes: 16 })
    expect(statusFor('11:00', { ...cell, kind: 'none', segments: [] }, 15)).toEqual({ status: 'present', lateMinutes: null })
  })
  it('runs a shift past midnight', () => {
    expect(segmentMinutes('18:00', '02:00')).toBe(480)
    expect(segmentMinutes('09:00', '17:00')).toBe(480)
  })
  it('switches a leaver off only once they have gone', () => {
    const now = new Date('2026-09-27T06:00:00Z')
    expect(hasLeft({ status: 'terminated', lastWorkingDay: new Date('2026-09-26T00:00:00Z') }, now)).toBe(true)
    expect(hasLeft({ status: 'resigned', lastWorkingDay: new Date('2026-09-27T00:00:00Z') }, now)).toBe(false) // their last day
    expect(hasLeft({ status: 'resigned', lastWorkingDay: null }, now)).toBe(false) // serving notice
    expect(hasLeft({ status: 'terminated', lastWorkingDay: null }, now)).toBe(true)
    expect(hasLeft({ status: 'active', lastWorkingDay: null }, now)).toBe(false)
  })
  it('anchors the geofence on the nearest of the company\'s branches', () => {
    const a = { locationId: 'a', name: 'A', lat: 24.8607, lng: 67.0011 }
    const b = { locationId: 'b', name: 'B', lat: 24.9, lng: 67.1 }
    const n = nearestAnchor([a, b], 24.9001, 67.1001)!
    expect(n.anchor.name).toBe('B')
    expect(n.distanceM).toBeLessThan(30)
  })
  it('weights the tip pool servers 1.0, cashiers and baristas 0.75, kitchen 0.5 — the company\'s own weights win', () => {
    expect(TIP_POOL_DEFAULT_WEIGHTS).toMatchObject({ foh: 1, cashier: 0.75, barista: 0.75, kitchen: 0.5 })
    const w = tipPoolWeights({ tipPoolRoleWeights: { kitchen: 0.6, manager: 0.25, bad: -1 } })
    expect(w['kitchen']).toBe(0.6)
    expect(w['manager']).toBe(0.25)
    expect(w['bad']).toBeUndefined()
    expect(w['foh']).toBe(1)
  })
})

// ─── through the API ────────────────────────────────────────────────────────

let app: FastifyInstance
let tenantId: string
let otherTenantId: string
let conceptId: string
let locA: string
const users: Record<string, { id: string; token: string }> = {}
const emps: Record<string, string> = {}
let morning: string, evening: string

async function mkUser(key: string, role: string, tenant = tenantId) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.rota@gsfoods.pk`, password: await bcrypt.hash('x-Password-1', 4), role: role as never, isActive: true, accountStatus: 'active', tenantId: tenant },
  })
  await prisma.tenantMember.create({ data: { tenantId: tenant, userId: u.id } as never }).catch(() => {})
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
  return u.id
}
async function mkEmp(key: string, extra: Record<string, unknown> = {}) {
  const e = await prisma.hrEmployee.create({
    data: { tenantId, employeeCode: `R-${String(Object.keys(emps).length + 1).padStart(4, '0')}`, fullName: key, grossSalaryCents: RS(52000), joiningDate: new Date('2025-01-01'), ...extra },
  })
  emps[key] = e.id
  return e.id
}
const approved = (section: string, data: Record<string, unknown>, slots: Record<string, unknown>) =>
  prisma.hrRecord.create({ data: { tenantId, section, formVersion: 0, status: 'approved', data: data as never, ...slots } })

const call = (who: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as never, headers: { authorization: `Bearer ${users[who]!.token}` } })

async function setOps(data: Record<string, unknown>) {
  const cur = await prisma.operationsConfig.findFirst({ where: { tenantId, scope: 'global', scopeId: null } })
  if (cur) await prisma.operationsConfig.update({ where: { id: cur.id }, data })
  else await prisma.operationsConfig.create({ data: { tenantId, scope: 'global', scopeId: null, ...data } })
  invalidateSetupCache()
}

beforeAll(async () => {
  tenantId = (await prisma.tenant.create({ data: { name: 'Rota Co', slug: `rota-co-${Date.now()}` } })).id
  otherTenantId = (await prisma.tenant.create({ data: { name: 'Rota Other Co', slug: `rota-other-${Date.now()}` } })).id
  conceptId = (await prisma.concept.create({ data: { name: 'rota brand', slug: `rota-brand-${Date.now()}`, type: 'restaurant', tenantId } as never })).id
  locA = (await prisma.location.create({ data: { slug: `rota-a-${Date.now()}`, name: 'Branch A', tenantId, latitude: 24.8607, longitude: 67.0011 } })).id
  await prisma.location.create({ data: { slug: `rota-b-${Date.now()}`, name: 'Branch B', tenantId, latitude: 24.9, longitude: 67.1 } })
  await prisma.conceptLocation.create({ data: { conceptId, locationId: locA } })

  await mkUser('ceo', 'admin')
  await mkUser('hr', 'hr')
  await prisma.tenantMember.create({ data: { tenantId: otherTenantId, userId: users['hr']!.id } as never })
  await mkUser('mgmt', 'management')
  await mkUser('boss', 'manager')
  await mkUser('cook', 'kitchen')
  await mkUser('runner', 'cashier')

  morning = (await approved('shift', { name: 'Morning', start: '09:00', end: '17:00' }, {})).id
  evening = (await approved('shift', { name: 'Evening', start: '17:00', end: '01:00' }, {})).id
  await mkEmp('Cook', { userId: users['cook']!.id })
  await mkEmp('Prep')
  await mkEmp('Runner', { userId: users['runner']!.id })
  await mkEmp('Dishwasher')
  await approved('roster', { employee: emps['Cook'], shift: morning, weeklyOff: ['sunday'] }, { employeeId: emps['Cook'], refId: morning, startDate: new Date('2026-01-01') })
  await approved('roster', { employee: emps['Prep'], shift: evening, weeklyOff: [] }, { employeeId: emps['Prep'], refId: evening, startDate: new Date('2026-01-01') })

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(hrRoutes, { prefix: '/hr' })
  await app.register(timeClockRoutes, { prefix: '/time-clock' })
  await app.register(schedulingRoutes, { prefix: '/scheduling' })
  await app.register(tipPoolRoutes, { prefix: '/tip-pools' })
  await app.register(positionRoutes, { prefix: '/positions' })
  await app.ready()
})

afterAll(async () => {
  await app?.close()
})

describe('the rota is generated from HR', () => {
  it('gives the standing shift and the weekly off, and an approved swap moves the day', async () => {
    await approved('shift_swap', { employee: emps['Cook'], swapWith: emps['Prep'], date: '2026-09-23T00:00:00.000Z', toShift: evening }, {
      employeeId: emps['Cook'], startDate: new Date('2026-09-23'), refId: evening,
    })
    const cells = await rotaFor(tenantId, [{ id: emps['Cook']!, userId: users['cook']!.id }, { id: emps['Prep']!, userId: null }], '2026-09-21', '2026-09-27')
    const at = (e: string, d: string) => cells.find((c) => c.employeeId === emps[e] && c.date === d)!
    expect(at('Cook', '2026-09-21')).toMatchObject({ kind: 'shift', source: 'roster' })
    expect(at('Cook', '2026-09-21').segments[0]!.start).toBe('09:00')
    expect(at('Cook', '2026-09-27')).toMatchObject({ kind: 'off', source: 'roster' })
    // Wednesday: cook works the evening, prep takes the cook's morning.
    expect(at('Cook', '2026-09-23')).toMatchObject({ kind: 'shift', source: 'swap' })
    expect(at('Cook', '2026-09-23').segments[0]!.start).toBe('17:00')
    expect(at('Prep', '2026-09-23').segments[0]!.start).toBe('09:00')
    expect(cellMinutes(at('Prep', '2026-09-22'))).toBe(480) // 17:00–01:00
  })
})

describe('punches write attendance', () => {
  it('marks a check-in past the rostered start by more than the grace late, and closes the day on out', async () => {
    const r = await recordPunch({ tenantId, employeeId: emps['Cook']!, kind: 'in', at: pkt('2026-09-21', '09:40'), source: 'clock' })
    expect(r).toMatchObject({ status: 'late', lateMinutes: 40 })
    const o = await recordPunch({ tenantId, employeeId: emps['Cook']!, kind: 'out', at: pkt('2026-09-21', '17:05'), source: 'clock' })
    expect(o.recordId).toBe(r.recordId)
    const rec = await prisma.hrRecord.findUniqueOrThrow({ where: { id: r.recordId! } })
    expect(rec).toMatchObject({ section: 'attendance', status: 'approved', category: 'late', quantity: 40, refId: morning })
    expect(rec.data).toMatchObject({ checkIn: '09:40', checkOut: '17:05', _source: 'clock' })
  })

  it('closes a shift that runs past midnight on the day it started', async () => {
    const r = await recordPunch({ tenantId, employeeId: emps['Prep']!, kind: 'in', at: pkt('2026-09-21', '16:55'), source: 'kiosk' })
    expect(r.status).toBe('present')
    const o = await recordPunch({ tenantId, employeeId: emps['Prep']!, kind: 'out', at: pkt('2026-09-22', '01:10'), source: 'kiosk' })
    expect(o.recordId).toBe(r.recordId)
  })

  it('turns an in with no out into a missing punch, which the out still closes', async () => {
    const r = await recordPunch({ tenantId, employeeId: emps['Cook']!, kind: 'in', at: pkt('2026-09-22', '09:00'), source: 'clock' })
    expect(r.status).toBe('present')
    expect(await flagMissingPunches(tenantId, new Date('2026-09-23T06:00:00Z'))).toBeGreaterThanOrEqual(1)
    expect((await prisma.hrRecord.findUniqueOrThrow({ where: { id: r.recordId! } })).category).toBe('missing_punch')
  })

  it('never overwrites a day HR keyed or edited by hand', async () => {
    const keyed = await call('hr', 'POST', '/hr/records/attendance', { data: { employee: emps['Prep'], date: '2026-09-24', status: 'absent' } })
    expect(keyed.statusCode).toBe(201)
    const r = await recordPunch({ tenantId, employeeId: emps['Prep']!, kind: 'in', at: pkt('2026-09-24', '17:00'), source: 'kiosk' })
    expect(r.skipped).toBe('hand_keyed')
    expect((await prisma.hrRecord.findUniqueOrThrow({ where: { id: keyed.json().id } })).category).toBe('absent')

    // An auto day HR edits becomes HR's — and keeps its punches.
    const monday = await prisma.hrRecord.findFirstOrThrow({ where: { tenantId, section: 'attendance', employeeId: emps['Cook'], startDate: new Date('2026-09-21') } })
    const edit = await call('hr', 'PATCH', `/hr/records/attendance/${monday.id}`, { data: { remarks: 'Traffic' } })
    expect(edit.statusCode).toBe(200)
    expect(edit.json().data).toMatchObject({ _source: 'hr', remarks: 'Traffic' })
    expect((edit.json().data._punches as unknown[]).length).toBe(2)
    const again = await recordPunch({ tenantId, employeeId: emps['Cook']!, kind: 'in', at: pkt('2026-09-21', '18:00'), source: 'clock' })
    expect(again.skipped).toBe('hand_keyed')
  })

  it('an approved attendance correction rewrites the day and works late out again', async () => {
    const c = await call('ceo', 'POST', '/hr/records/attendance_correction', {
      data: { employee: emps['Cook'], date: '2026-09-22', type: 'missed_punch', correctedIn: '09:05', correctedOut: '17:00', reason: 'Forgot to punch out' },
    })
    expect(c.statusCode).toBe(201)
    const id = c.json().id
    expect((await call('hr', 'POST', `/hr/records/attendance_correction/${id}/decide`, { decision: 'approved' })).statusCode).toBe(200)
    expect((await call('mgmt', 'POST', `/hr/records/attendance_correction/${id}/decide`, { decision: 'approved' })).json().status).toBe('approved')
    const day = await prisma.hrRecord.findFirstOrThrow({ where: { tenantId, section: 'attendance', employeeId: emps['Cook'], startDate: new Date('2026-09-22') }, orderBy: { createdAt: 'desc' } })
    expect(day.category).toBe('present')
    expect(day.data).toMatchObject({ checkIn: '09:05', checkOut: '17:00', _source: 'correction', _correctionId: id })
  })

  it('feeds payroll: the late day counts, the corrected day does not', async () => {
    const emp = await prisma.hrEmployee.findUniqueOrThrow({ where: { id: emps['Cook']! } })
    const inputs = await prefillInputs(tenantId, emp, '2026-09')
    expect(inputs.lateCount).toBe(1)
    expect(inputs.absentDays).toBe(0)
  })
})

describe('the time clock', () => {
  it('measures against any of the company\'s branches (no work locations set) and never refuses', async () => {
    await setOps({ geofenceEnforced: true, geofenceRadiusMetres: 150 })
    // Owner 2026-10-15: out of area is allowed and flagged — measured, not refused (the far punch is in
    // workLocations.test.ts); here the near one.
    const near = await call('runner', 'POST', '/time-clock/punch-in', { lat: 24.9001, lng: 67.1001 })
    expect(near.statusCode).toBe(201)
    expect(near.json()).toMatchObject({ geofenceMatched: true, location: 'Branch B', hrLinked: true })
    expect(near.json().attendance.status).toMatch(/present|late/)
    const status = await call('runner', 'GET', '/time-clock/status')
    expect(status.json().punchedIn).toBe(true)
    const out = await call('runner', 'POST', '/time-clock/punch-out', {})
    expect(out.statusCode).toBe(200)
    expect(out.json().attendance.recordId).toBe(near.json().attendance.recordId)
    const logs = await call('boss', 'GET', '/time-clock/logs')
    const row = (logs.json().rows as Array<{ employeeId: string; punches: unknown[]; attendance: unknown }>).find((r) => r.employeeId === emps['Runner'])
    expect(row?.punches.length).toBe(2)
    expect(row?.attendance).toBeTruthy()
  })

  it('an enforced geofence with no located branch lets the punch through as out of area rather than waving it through unflagged', async () => {
    const lonely = (await prisma.tenant.create({ data: { name: 'No Pins Co', slug: `no-pins-${Date.now()}` } })).id
    await prisma.operationsConfig.create({ data: { tenantId: lonely, scope: 'global', scopeId: null, geofenceEnforced: true } })
    invalidateSetupCache()
    await expect(enforceClockInPolicy(lonely, 'kitchen', { lat: 24.86, lng: 67 })).resolves.toMatchObject({ outOfArea: true, outOfAreaReason: 'no_anchor' })
    // The CEO is never held to it.
    await expect(enforceClockInPolicy(lonely, 'admin', {})).resolves.toMatchObject({ geofenceMatched: null })
  })

  it('lets staff without a login punch at the kiosk with their code and PIN', async () => {
    const dish = await prisma.hrEmployee.findUniqueOrThrow({ where: { id: emps['Dishwasher']! } })
    expect((await call('hr', 'POST', `/hr/employees/${emps['Cook']}/kiosk-pin`, { pin: '4827' })).statusCode).toBe(409) // has a login
    expect((await call('hr', 'POST', `/hr/employees/${dish.id}/kiosk-pin`, { pin: '1234' })).statusCode).toBe(400) // weak
    expect((await call('hr', 'POST', `/hr/employees/${dish.id}/kiosk-pin`, { pin: '4827' })).statusCode).toBe(200)
    expect((await call('hr', 'GET', `/hr/employees/${dish.id}`)).json().kioskPinSet).toBe(true)
    const bad = await call('boss', 'POST', '/time-clock/kiosk/punch', { employeeCode: dish.employeeCode, pin: '9999', lat: 24.8607, lng: 67.0011 })
    expect(bad.statusCode).toBe(401)
    const inn = await call('boss', 'POST', '/time-clock/kiosk/punch', { employeeCode: dish.employeeCode, pin: '4827', lat: 24.8607, lng: 67.0011 })
    expect(inn.statusCode).toBe(200)
    expect(inn.json()).toMatchObject({ action: 'in', location: 'Branch A' })
    const out = await call('boss', 'POST', '/time-clock/kiosk/punch', { employeeCode: dish.employeeCode, pin: '4827' })
    expect(out.json()).toMatchObject({ action: 'out' })
    expect(out.json().attendance.recordId).toBe(inn.json().attendance.recordId)
    await setOps({ geofenceEnforced: false })
  })
})

describe('/scheduling is the generated week with exceptions', () => {
  it('shows HR employees on their roster, stores a day off as an exception, and costs from HR salary', async () => {
    const week = await call('cook', 'GET', `/scheduling?conceptId=${conceptId}&weekStart=2026-09-21`)
    expect(week.statusCode).toBe(200)
    const names = (week.json().staff as Array<{ name: string }>).map((s) => s.name)
    expect(names).toEqual(expect.arrayContaining(['Cook', 'Prep', 'Dishwasher']))

    const off = await call('boss', 'POST', '/scheduling', { employeeId: emps['Cook'], conceptId, date: '2026-09-21', off: true })
    expect(off.statusCode).toBe(201)
    const again = await call('cook', 'GET', `/scheduling?conceptId=${conceptId}&weekStart=2026-09-21`)
    const mon = (again.json().cells as Array<{ employeeId: string; date: string; kind: string; source: string }>).find((c) => c.employeeId === emps['Cook'] && c.date === '2026-09-21')
    expect(mon).toMatchObject({ kind: 'off', source: 'exception' })

    const noLogin = await call('boss', 'POST', '/scheduling', { employeeId: emps['Dishwasher'], conceptId, date: '2026-09-22', startTime: '10:00', endTime: '14:00' })
    expect(noLogin.statusCode).toBe(422)

    // Cook: Tue, Thu, Fri, Sat 8 h + Wed evening (swap) 8 h = 40 h at Rs 250/h.
    const cost = await call('boss', 'GET', `/scheduling/labor-cost?conceptId=${conceptId}&weekStart=2026-09-21`)
    const cook = (cost.json().byEmployee as Array<{ employeeId: string; hours: number; rateCents: number; totalCents: number }>).find((x) => x.employeeId === emps['Cook'])
    expect(cook).toMatchObject({ hours: 40, rateCents: RS(250), totalCents: RS(10000) })
    expect((await call('cook', 'GET', `/scheduling/labor-cost?conceptId=${conceptId}&weekStart=2026-09-21`)).statusCode).toBe(403)
  })

  it('refuses another company\'s brand', async () => {
    const foreign = (await prisma.concept.create({ data: { name: 'foreign', slug: `foreign-${Date.now()}`, type: 'restaurant', tenantId: otherTenantId } as never })).id
    expect((await call('boss', 'GET', `/scheduling?conceptId=${foreign}&weekStart=2026-09-21`)).statusCode).toBe(404)
  })
})

describe('tip pools follow the company rules', () => {
  it('needs a brand, refuses when pooling is off, and weights by role and hours', async () => {
    const barista = (await prisma.hrOrgUnit.create({ data: { tenantId, kind: 'designation', name: 'Barista' } })).id
    for (const [key, role, extra] of [['server', 'foh', {}], ['till', 'cashier', {}], ['bar', 'cashier', { designationId: barista }], ['line', 'kitchen', {}]] as const) {
      await mkUser(key, role)
      const e = await mkEmp(`tip-${key}`, { userId: users[key]!.id, ...extra })
      await recordPunch({ tenantId, employeeId: e, kind: 'in', at: new Date('2026-09-25T11:00:00Z'), source: 'clock' })
      await recordPunch({ tenantId, employeeId: e, kind: 'out', at: new Date('2026-09-25T15:00:00Z'), source: 'clock' })
    }
    const body = { name: 'Friday', periodStart: '2026-09-25T10:00:00.000Z', periodEnd: '2026-09-25T20:00:00.000Z' }
    expect((await call('boss', 'POST', '/tip-pools', body)).statusCode).toBe(400) // no brand
    await setOps({ tipPoolEnabled: false })
    expect((await call('boss', 'POST', '/tip-pools', { ...body, conceptId })).json().error.code).toBe('TIP_POOL_DISABLED')
    await setOps({ tipPoolEnabled: true, tipPoolDistribution: 'by_role_weight' })
    const pool = await call('boss', 'POST', '/tip-pools', { ...body, conceptId })
    expect(pool.statusCode).toBe(201)
    const units = Object.fromEntries((pool.json().members as Array<{ userName: string; shareUnits: number; roleWeight: number }>).map((m) => [m.userName, m.shareUnits]))
    expect(units).toEqual({ server: 4, till: 3, bar: 3, line: 2 })
    const list = await call('boss', 'GET', '/tip-pools')
    expect((list.json() as Array<{ id: string }>).some((p) => p.id === pool.json().id)).toBe(true)
  })
})

describe('logins and employees', () => {
  it('links a login once per company, and shows Workforce the HR record without pay', async () => {
    const other = await prisma.hrEmployee.create({ data: { tenantId, employeeCode: 'R-9001', fullName: 'Cook twin' } })
    const same = await call('hr', 'POST', `/hr/employees/${other.id}/link-user`, { userId: users['cook']!.id })
    expect(same.statusCode).toBe(409)
    expect(same.json().error.code).toBe('ALREADY_LINKED')
    // In another company the rule allows it; the database index is still
    // global until the migration lands, which answers a clear 409.
    await prisma.tenantMember.create({ data: { tenantId: otherTenantId, userId: users['cook']!.id } as never })
    const abroad = await prisma.hrEmployee.create({ data: { tenantId: otherTenantId, employeeCode: 'O-0001', fullName: 'Cook abroad' } })
    const cross = await call('hr', 'POST', `/hr/employees/${abroad.id}/link-user`, { userId: users['cook']!.id })
    expect([200, 409]).toContain(cross.statusCode)
    if (cross.statusCode === 409) expect(cross.json().error.code).toBe('ALREADY_LINKED_ELSEWHERE')

    const links = await call('boss', 'GET', `/hr/people-links?userIds=${users['cook']!.id}`)
    expect(links.statusCode).toBe(200)
    const cookLink = (links.json() as Array<Record<string, unknown>>).find((l) => l['employeeId'] === emps['Cook'])
    expect(cookLink).toMatchObject({ fullName: 'Cook', status: 'active' })
    expect(JSON.stringify(links.json())).not.toMatch(/Salary|salary/)

    const logins = await call('hr', 'GET', '/hr/logins')
    expect(logins.statusCode).toBe(200)
    expect((logins.json() as Array<{ id: string; linkedEmployee: { id: string } | null }>).find((u) => u.id === users['cook']!.id)?.linkedEmployee?.id).toBe(emps['Cook'])
    const rec = await call('hr', 'GET', '/hr/people-reconcile')
    expect((rec.json().employeesWithoutLogin as Array<{ id: string }>).some((e) => e.id === emps['Dishwasher'])).toBe(true)
  })

  it('switches off a leaver\'s login after the last working day, not during notice', async () => {
    const gone = await mkUser('gone', 'kitchen')
    const notice = await mkUser('notice', 'kitchen')
    const yesterday = new Date(Date.now() - 2 * 86_400_000)
    await mkEmp('Gone', { userId: gone, status: 'terminated', lastWorkingDay: new Date(Date.UTC(yesterday.getUTCFullYear(), yesterday.getUTCMonth(), yesterday.getUTCDate())) })
    await mkEmp('Notice', { userId: notice, status: 'resigned', lastWorkingDay: new Date(Date.now() + 20 * 86_400_000) })
    await deactivateLeftLogins(tenantId)
    expect((await prisma.user.findUniqueOrThrow({ where: { id: gone } })).isActive).toBe(false)
    expect((await prisma.user.findUniqueOrThrow({ where: { id: notice } })).isActive).toBe(true)
  })
})

describe('org masters and budgeted labour', () => {
  it('writes departments in HR only: no duplicates, no archiving one people are still in', async () => {
    const d = await call('hr', 'POST', '/hr/org/departments', { name: 'Pastry' })
    expect(d.statusCode).toBe(201)
    expect((await call('hr', 'POST', '/hr/org/departments', { name: 'pastry' })).statusCode).toBe(409)
    await prisma.hrEmployee.update({ where: { id: emps['Prep']! }, data: { departmentId: d.json().id } })
    expect((await call('hr', 'PATCH', `/hr/org/departments/${d.json().id}`, { archived: true })).statusCode).toBe(409)
    await prisma.hrEmployee.update({ where: { id: emps['Prep']! }, data: { departmentId: null } })
    expect((await call('hr', 'PATCH', `/hr/org/departments/${d.json().id}`, { archived: true })).json().archivedAt).toBeTruthy()
    // Positions no longer writes departments.
    expect((await call('boss', 'POST', '/positions/departments', { name: 'Shadow' })).statusCode).toBe(404)
  })

  it('titles a seat from an HR designation and leaves frozen seats out of the budget, net of contributions', async () => {
    const chef = (await prisma.hrOrgUnit.create({ data: { tenantId, kind: 'designation', name: 'Chef de Partie' } })).id
    expect((await call('boss', 'POST', '/positions', { title: 'Ninja', monthlySalaryCents: RS(100000) })).statusCode).toBe(422)
    const open = await call('boss', 'POST', '/positions', { designationId: chef, monthlySalaryCents: RS(100000), status: 'open' })
    expect(open.statusCode).toBe(200)
    expect(open.json().title).toBe('Chef de Partie')
    expect((await call('boss', 'POST', '/positions', { title: 'chef de partie', monthlySalaryCents: RS(50000), status: 'frozen' })).statusCode).toBe(200)
    await prisma.tenantContribution.create({ data: { sourceTenantId: otherTenantId, destinationTenantId: tenantId, category: 'head_office', monthlyCents: RS(30000), label: 'JV head office' } })
    const b = await budgetedLabour([tenantId])
    expect(b.shareMonthlyCents).toBe(RS(100000))
    expect(b.frozenShareMonthlyCents).toBe(RS(50000))
    expect(b.netMonthlyCents).toBe(RS(70000))
    // Both companies in one scenario: the contribution is internal and nets out.
    expect((await budgetedLabour([tenantId, otherTenantId])).netMonthlyCents).toBe(RS(100000))
    const s = await call('boss', 'GET', '/positions/summary')
    expect(s.json()).toMatchObject({ totalTenantShareMonthlyCents: RS(100000), netMonthlyCents: RS(70000), byStatus: { open: 1, frozen: 1 } })
  })
})
