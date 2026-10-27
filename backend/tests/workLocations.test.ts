// Attendance by work location (owner, 2026-10-15) — two companies.
//
//   - a punch is measured against the employee's OWN work locations (none → the company's), the nearest decides,
//     a work location's radius overrides the company's;
//   - out of area is NEVER refused: recorded on the ClockLog (company, location, outOfArea) and the day's
//     attendance, and flagged for HR once per employee per Karachi day while the geofence is on — not when off;
//   - no location fix while enforced → allowed + flagged; old kiosk punches (route removed 2026-10-27) still read;
//   - PUT /hr/employees/:id/work-locations: another company's location 422, another company's employee 404,
//     exactly one primary, the primary is the Branch Location;
//   - /hr/attendance-tracking: today board and punch log, company-scoped;
//   - POST /tenants/merge moves hr_work_locations and clock_logs.tenantId.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { prisma, mkUser, type Who } from './connectorsFixtures.js'
import { AppError } from '../src/lib/errors.js'
import { invalidateSetupCache } from '../src/lib/setup-config.js'
import { hrRoutes } from '../src/modules/hr/routes.js'
import { timeClockRoutes } from '../src/modules/timeclock/routes.js'
import { tenantRoutes } from '../src/modules/tenants/routes.js'
import { enforceClockInPolicy } from '../src/modules/timeclock/policy.js'
import { recordPunch } from '../src/modules/hr/attendance.js'
import { pktToday } from '../src/modules/hr/logic.js'

const RUN = Date.now().toString(36)
let app: FastifyInstance
let seq = 0

// Branch pins (Karachi). 0.001° ≈ 100 m here.
const P1 = { lat: 24.8607, lng: 67.0011 }
const P2 = { lat: 24.9, lng: 67.1 }
const P3 = { lat: 24.95, lng: 67.2 }

let A: string, B: string
let a1: string, a2: string, a3: string, aNoPin: string, b1: string
let hrA: Who, hrB: Who, bossA: Who, kioskA: Who, ceo: Who
const users: Record<string, Who> = {}
const emps: Record<string, string> = {}

const call = (who: Who, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as never, headers: { authorization: `Bearer ${who.token}` } })

async function setOps(tenantId: string, data: Record<string, unknown>) {
  const cur = await prisma.operationsConfig.findFirst({ where: { tenantId, scope: 'global', scopeId: null } })
  if (cur) await prisma.operationsConfig.update({ where: { id: cur.id }, data })
  else await prisma.operationsConfig.create({ data: { tenantId, scope: 'global', scopeId: null, ...data } })
  invalidateSetupCache()
}
async function loc(tenantId: string, name: string, at: { lat: number; lng: number } | null) {
  return (await prisma.location.create({ data: { slug: `wl-${++seq}-${RUN}`, name, tenantId, latitude: at?.lat ?? null, longitude: at?.lng ?? null, fenceLatitude: at?.lat ?? null, fenceLongitude: at?.lng ?? null } })).id
}
async function emp(tenantId: string, key: string, userId: string | null = null) {
  const e = await prisma.hrEmployee.create({
    data: { tenantId, employeeCode: `WL-${++seq}`, fullName: `${key} ${RUN}`, grossSalaryCents: 5_000_000, joiningDate: new Date('2025-01-01'), userId },
  })
  emps[key] = e.id
  return e.id
}
const flagsFor = (tenantId: string, employeeId: string) =>
  prisma.exceptionFlag.findMany({ where: { tenantId, kind: 'attendance_out_of_area', entityId: employeeId } })
const dayRecord = (tenantId: string, employeeId: string) =>
  prisma.hrRecord.findFirst({ where: { tenantId, section: 'attendance', employeeId, startDate: pktToday() }, orderBy: { createdAt: 'desc' } })

beforeAll(async () => {
  A = (await prisma.tenant.create({ data: { name: `WL A ${RUN}`, slug: `wl-a-${RUN}` } })).id
  B = (await prisma.tenant.create({ data: { name: `WL B ${RUN}`, slug: `wl-b-${RUN}` } })).id
  a1 = await loc(A, 'A One', P1)
  a2 = await loc(A, 'A Two', P2)
  a3 = await loc(A, 'A Three', P3)
  aNoPin = await loc(A, 'A No Pin', null)
  b1 = await loc(B, 'B One', P1)

  hrA = await mkUser(`wl-hra-${RUN}`, 'hr', A)
  hrB = await mkUser(`wl-hrb-${RUN}`, 'hr', B)
  bossA = await mkUser(`wl-boss-${RUN}`, 'manager', A)
  kioskA = await mkUser(`wl-kiosk-${RUN}`, 'manager', A)
  ceo = await mkUser(`wl-ceo-${RUN}`, 'admin', A)
  await prisma.tenantMember.create({ data: { tenantId: B, userId: ceo.id } })
  for (const k of ['far', 'near', 'radius', 'off', 'nofix']) {
    users[k] = await mkUser(`wl-${k}-${RUN}`, 'cashier', A)
    await emp(A, k, users[k]!.id)
  }
  await emp(A, 'kiosk')
  await emp(B, 'bee')
  await setOps(A, { geofenceEnforced: true, geofenceRadiusMetres: 150 })

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(hrRoutes, { prefix: '/hr' })
  await app.register(timeClockRoutes, { prefix: '/time-clock' })
  await app.register(tenantRoutes, { prefix: '/tenants' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  await app?.close()
})

describe('work locations on the employee profile', () => {
  it('sets one or more work locations; the primary becomes the Branch Location', async () => {
    const r = await call(hrA, 'PUT', `/hr/employees/${emps['far']}/work-locations`, { items: [{ locationId: a1, isPrimary: true }] })
    expect(r.statusCode).toBe(200)
    expect(r.json().items).toEqual([expect.objectContaining({ locationId: a1, isPrimary: true, hasPin: true })])
    expect((await prisma.hrEmployee.findUniqueOrThrow({ where: { id: emps['far']! } })).locationId).toBe(a1)

    const two = await call(hrA, 'PUT', `/hr/employees/${emps['near']}/work-locations`, { items: [{ locationId: a1 }, { locationId: a3, isPrimary: true }, { locationId: aNoPin }] })
    expect(two.statusCode).toBe(200)
    expect(two.json().items.map((i: { locationId: string }) => i.locationId)[0]).toBe(a3) // primary first
    expect(two.json().items.find((i: { locationId: string }) => i.locationId === aNoPin).hasPin).toBe(false)
    expect((await prisma.hrEmployee.findUniqueOrThrow({ where: { id: emps['near']! } })).locationId).toBe(a3)

    const got = await call(hrA, 'GET', `/hr/employees/${emps['near']}/work-locations`)
    expect(got.json().items).toHaveLength(3)

    // Replacing the set drops what is not listed.
    const one = await call(hrA, 'PUT', `/hr/employees/${emps['near']}/work-locations`, { items: [{ locationId: a1 }, { locationId: a3, isPrimary: true }] })
    expect(one.json().items).toHaveLength(2)
    expect(await prisma.auditLog.count({ where: { action: 'hr.work_locations.update', entityId: emps['near'] } })).toBe(2)
  })

  it('needs exactly one primary', async () => {
    const none = await call(hrA, 'PUT', `/hr/employees/${emps['far']}/work-locations`, { items: [{ locationId: a1 }, { locationId: a2 }] })
    expect(none.json().error.code).toBe('PRIMARY_REQUIRED')
    const both = await call(hrA, 'PUT', `/hr/employees/${emps['far']}/work-locations`, { items: [{ locationId: a1, isPrimary: true }, { locationId: a2, isPrimary: true }] })
    expect(both.json().error.code).toBe('PRIMARY_REQUIRED')
    const bad = await call(hrA, 'PUT', `/hr/employees/${emps['far']}/work-locations`, { items: [{ locationId: a1, isPrimary: true, radiusMetres: 5 }] })
    expect(bad.statusCode).toBe(400)
  })

  it('refuses another company\'s location (422) and another company\'s employee (404)', async () => {
    const foreignLoc = await call(hrA, 'PUT', `/hr/employees/${emps['far']}/work-locations`, { items: [{ locationId: b1, isPrimary: true }] })
    expect(foreignLoc.statusCode).toBe(422)
    expect(foreignLoc.json().error.code).toBe('LOCATION_NOT_IN_COMPANY')
    expect((await prisma.hrWorkLocation.findMany({ where: { employeeId: emps['far']! } })).map((w) => w.locationId)).toEqual([a1])

    expect((await call(hrB, 'PUT', `/hr/employees/${emps['far']}/work-locations`, { items: [{ locationId: b1, isPrimary: true }] })).statusCode).toBe(404)
    expect((await call(hrB, 'GET', `/hr/employees/${emps['far']}/work-locations`)).statusCode).toBe(404)
    // B's HR works on B's employee with B's location; an A location is foreign there.
    expect((await call(hrB, 'PUT', `/hr/employees/${emps['bee']}/work-locations`, { items: [{ locationId: a1, isPrimary: true }] })).statusCode).toBe(422)
    expect((await call(hrB, 'PUT', `/hr/employees/${emps['bee']}/work-locations`, { items: [{ locationId: b1, isPrimary: true }] })).statusCode).toBe(200)
    // A manager is not the HR team.
    expect((await call(bossA, 'PUT', `/hr/employees/${emps['far']}/work-locations`, { items: [] })).statusCode).toBe(403)
  })
})

describe('the punch is measured, never refused', () => {
  it('outside the employee\'s own work location (though at another company branch): allowed, recorded and flagged once a day', async () => {
    // far's only work location is A One; they punch at A Two — a company branch, but not theirs.
    const inn = await call(users['far']!, 'POST', '/time-clock/punch-in', P2)
    expect(inn.statusCode).toBe(201)
    expect(inn.json().where).toMatchObject({ locationId: a1, matched: false, outOfArea: true, reason: 'outside', flagged: true })
    const log = await prisma.clockLog.findFirstOrThrow({ where: { userId: users['far']!.id, type: 'in' } })
    expect(log).toMatchObject({ tenantId: A, locationId: a1, outOfArea: true, geofenceMatched: false })
    expect(log.geofenceDistanceM).toBeGreaterThan(10_000)
    const day = await dayRecord(A, emps['far']!)
    expect((day!.data as Record<string, unknown>)['_outOfArea']).toBe(true)
    expect(((day!.data as Record<string, unknown>)['_punches'] as Array<{ outOfArea?: boolean }>)[0]!.outOfArea).toBe(true)

    // A second out-of-area punch the same day: still ONE flag, its counts bumped.
    const out = await call(users['far']!, 'POST', '/time-clock/punch-out', P2)
    expect(out.statusCode).toBe(200)
    expect(out.json().where).toMatchObject({ outOfArea: true })
    const flags = await flagsFor(A, emps['far']!)
    expect(flags).toHaveLength(1)
    expect(flags[0]!.metadata).toMatchObject({ punches: 2, ins: 1, outs: 1, firstReason: 'outside' })
    // Counts and distances only — never coordinates.
    expect(JSON.stringify(flags[0]!.metadata)).not.toMatch(/lat|lng|24\.9/)
  })

  it('the nearest of the employee\'s work locations decides', async () => {
    // near works at A One and A Three; a punch at A Three is inside A Three.
    const r = await call(users['near']!, 'POST', '/time-clock/punch-in', { lat: P3.lat + 0.0003, lng: P3.lng })
    expect(r.statusCode).toBe(201)
    expect(r.json()).toMatchObject({ location: 'A Three', geofenceMatched: true })
    expect(r.json().where).toMatchObject({ locationId: a3, outOfArea: false, flagged: false })
    expect(await flagsFor(A, emps['near']!)).toHaveLength(0)
  })

  it('a work location\'s own radius overrides the company\'s', async () => {
    await call(hrA, 'PUT', `/hr/employees/${emps['radius']}/work-locations`, { items: [{ locationId: a1, isPrimary: true, radiusMetres: 20 }] })
    const v = await enforceClockInPolicy(A, 'cashier', { lat: P1.lat + 0.00045, lng: P1.lng }, { employeeId: emps['radius']! })
    expect(v).toMatchObject({ locationId: a1, radiusM: 20, geofenceMatched: false, outOfArea: true, fromWorkLocations: true })
    // With no work locations the company's branches and radius apply (150 m).
    const company = await enforceClockInPolicy(A, 'cashier', { lat: P1.lat + 0.00045, lng: P1.lng }, { employeeId: emps['nofix']! })
    expect(company).toMatchObject({ locationId: a1, radiusM: 150, geofenceMatched: true, outOfArea: false, fromWorkLocations: false })
  })

  it('with the geofence off the verdict is stored but nothing is flagged', async () => {
    await setOps(A, { geofenceEnforced: false })
    try {
      const r = await call(users['off']!, 'POST', '/time-clock/punch-in', { lat: 25.5, lng: 68.0 })
      expect(r.statusCode).toBe(201)
      expect(r.json()).toMatchObject({ geofenceMatched: false })
      expect(r.json().where).toMatchObject({ outOfArea: false, flagged: false })
      expect(await prisma.clockLog.findFirstOrThrow({ where: { userId: users['off']!.id } })).toMatchObject({ tenantId: A, outOfArea: false, geofenceMatched: false })
      expect(await flagsFor(A, emps['off']!)).toHaveLength(0)
      expect(((await dayRecord(A, emps['off']!))!.data as Record<string, unknown>)['_outOfArea']).toBeUndefined()
    } finally {
      await setOps(A, { geofenceEnforced: true })
    }
  })

  it('no location fix while enforced: allowed and flagged', async () => {
    const r = await call(users['nofix']!, 'POST', '/time-clock/punch-in', {})
    expect(r.statusCode).toBe(201)
    expect(r.json().where).toMatchObject({ outOfArea: true, reason: 'no_fix', flagged: true })
    const flags = await flagsFor(A, emps['nofix']!)
    expect(flags).toHaveLength(1)
    expect(flags[0]!.metadata).toMatchObject({ firstReason: 'no_fix' })
    // Logging out with no fix is not judged (the admin's logout sends none) and does not bump the flag.
    const out = await call(users['nofix']!, 'POST', '/time-clock/punch-out', {})
    expect(out.json().where).toBeNull()
    expect((await flagsFor(A, emps['nofix']!))[0]!.metadata).toMatchObject({ punches: 1 })
  })

  it('kiosk PIN clock-in is gone (owner, 2026-10-27); an old kiosk day keeps its punches and verdicts', async () => {
    const code = (await prisma.hrEmployee.findUniqueOrThrow({ where: { id: emps['kiosk']! } })).employeeCode
    expect((await call(kioskA, 'POST', '/time-clock/kiosk/punch', { employeeCode: code, pin: '4827', ...P2 })).statusCode).toBe(404)
    expect((await call(hrA, 'POST', `/hr/employees/${emps['kiosk']}/kiosk-pin`, { pin: '4827' })).statusCode).toBe(404)
    // A punch taken at the kiosk before the removal (written as it was then).
    const at = new Date()
    await recordPunch({ tenantId: A, employeeId: emps['kiosk']!, kind: 'in', at: new Date(at.getTime() - 60_000), source: 'kiosk', locationId: a2, geofenceMatched: true, outOfArea: false })
    await recordPunch({
      tenantId: A, employeeId: emps['kiosk']!, kind: 'out', at, source: 'kiosk', locationId: a2, geofenceMatched: false, outOfArea: true,
      outOfAreaReason: 'outside', outOfAreaWhere: { distanceM: 9000, location: 'A Two', radiusM: 100 },
    })
    const day = (await dayRecord(A, emps['kiosk']!))!.data as Record<string, unknown>
    expect(day['_source']).toBe('kiosk')
    expect(day['_outOfArea']).toBe(true)
    const punches = day['_punches'] as Array<{ type: string; locationId: string; outOfArea?: boolean }>
    expect(punches.map((p) => [p.type, p.locationId, !!p.outOfArea])).toEqual([['in', a2, false], ['out', a2, true]])
    // …and the today board still shows the day.
    const board = await call(hrA, 'GET', '/hr/attendance-tracking/today')
    expect((board.json().rows as Array<{ employeeId: string }>).some((x) => x.employeeId === emps['kiosk'])).toBe(true)
  })
})

describe('HR attendance tracking', () => {
  it('today board: status, punches, work locations, out-of-area badge — company-scoped', async () => {
    const r = await call(hrA, 'GET', '/hr/attendance-tracking/today')
    expect(r.statusCode).toBe(200)
    const row = (key: string) => (r.json().rows as Array<Record<string, unknown>>).find((x) => x.employeeId === emps[key])
    expect(row('far')).toMatchObject({ status: 'out', outOfArea: true })
    expect(row('near')).toMatchObject({ status: 'in', outOfArea: false })
    expect((row('near')!.workLocations as unknown[]).length).toBe(2)
    expect((row('near')!.punches as Array<{ location: string }>)[0]!.location).toBe('A Three')
    expect(row('prep')).toBeUndefined()
    expect(row('bee')).toBeUndefined() // another company
    expect(r.json().totals.outOfArea).toBeGreaterThanOrEqual(3)

    // Filter by location: work-location holders only.
    const at3 = await call(bossA, 'GET', `/hr/attendance-tracking/today?locationId=${a3}`)
    expect(at3.statusCode).toBe(200)
    expect((at3.json().rows as Array<{ employeeId: string }>).map((x) => x.employeeId)).toEqual([emps['near']])

    const other = await call(hrB, 'GET', '/hr/attendance-tracking/today')
    expect((other.json().rows as Array<{ employeeId: string }>).map((x) => x.employeeId)).toEqual([emps['bee']])
  })

  it('punch log: login and kiosk punches, out-of-area filter, pagination, company-scoped', async () => {
    const all = await call(hrA, 'GET', '/hr/attendance-tracking/punches')
    expect(all.statusCode).toBe(200)
    expect(all.json().total).toBeGreaterThanOrEqual(8)
    const flagged = await call(hrA, 'GET', '/hr/attendance-tracking/punches?outOfArea=1')
    const rows = flagged.json().rows as Array<{ employeeId: string; outOfArea: boolean; source: string; location: string | null }>
    expect(rows.every((x) => x.outOfArea)).toBe(true)
    expect(new Set(rows.map((x) => x.employeeId))).toEqual(new Set([emps['far'], emps['nofix'], emps['kiosk']]))
    expect(rows.some((x) => x.source === 'kiosk')).toBe(true)
    const one = await call(hrA, 'GET', `/hr/attendance-tracking/punches?employeeId=${emps['far']}&pageSize=1&page=2`)
    expect(one.json()).toMatchObject({ total: 2, page: 2, pageSize: 1 })
    expect(one.json().rows).toHaveLength(1)
    // B sees none of A's punches, even naming A's employee.
    expect((await call(hrB, 'GET', `/hr/attendance-tracking/punches?employeeId=${emps['far']}`)).json().total).toBe(0)
    expect((await call(hrA, 'GET', '/hr/attendance-tracking/punches?from=2026-01-01&to=2026-06-01')).statusCode).toBe(400)
    // A cashier is not a reader.
    expect((await call(users['far']!, 'GET', '/hr/attendance-tracking/today')).statusCode).toBe(403)
  })
})

describe('combining companies', () => {
  it('moves work locations and the punch log\'s company', async () => {
    const S = (await prisma.tenant.create({ data: { name: `WL S ${RUN}`, slug: `wl-s-${RUN}` } })).id
    const D = (await prisma.tenant.create({ data: { name: `WL D ${RUN}`, slug: `wl-d-${RUN}` } })).id
    for (const t of [S, D]) await prisma.tenantMember.create({ data: { tenantId: t, userId: ceo.id } })
    const sLoc = await loc(S, 'S One', P1)
    const sEmp = await emp(S, 'mover')
    const wl = await prisma.hrWorkLocation.create({ data: { tenantId: S, employeeId: sEmp, locationId: sLoc, isPrimary: true } })
    const cl = await prisma.clockLog.create({ data: { userId: ceo.id, type: 'in', tenantId: S, locationId: sLoc, outOfArea: false } })
    const res = await call(ceo, 'POST', '/tenants/merge', { sourceId: S, targetId: D })
    expect(res.statusCode).toBe(200)
    expect((await prisma.hrWorkLocation.findUniqueOrThrow({ where: { id: wl.id } })).tenantId).toBe(D)
    expect((await prisma.clockLog.findUniqueOrThrow({ where: { id: cl.id } })).tenantId).toBe(D)
  })
})
