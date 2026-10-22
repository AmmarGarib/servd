// Geo-fenced attendance (owner's card + answers, 2026-10-22) — two companies.
//
//   - the time clock measures from the pin + radius the CEO APPROVED; a new / moved pin waits (approval type
//     location_pin, CEO only, never another company's: 404); a stale decision is 409 PIN_CHANGED; a rejected pin
//     leaves the queue until it is changed again; the CEO's own edit is the approval;
//   - a reading less accurate than 50 m cannot place a punch inside ('poor_fix');
//   - an out-of-area punch is saved and the DAY waits for the person's HOD (status submitted, out of payroll) —
//     the person adds a reason (POST /time-clock/hold-reason, own day only), the HOD approves / rejects through the
//     HR decide route; the person can never approve their own day;
//   - an office network that names a location places the punch there (owner: "Office Wi-Fi = Head Office
//     location"): in area for staff of that location, held for everyone else; HR settings refuse another
//     company's location (422).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { prisma, mkUser, type Who } from './connectorsFixtures.js'
import { AppError } from '../src/lib/errors.js'
import { invalidateSetupCache } from '../src/lib/setup-config.js'
import { hrRoutes } from '../src/modules/hr/routes.js'
import { timeClockRoutes } from '../src/modules/timeclock/routes.js'
import { locationRoutes } from '../src/modules/locations/routes.js'
import { STANDING_ATTENDANCE } from '../src/modules/hr/service.js'
import { pktToday } from '../src/modules/hr/logic.js'

const RUN = Date.now().toString(36)
let app: FastifyInstance
let seq = 0

// 0.001° ≈ 100 m here.
const SHOP = { lat: 24.8607, lng: 67.0011 }
const FAR = { lat: 24.8707, lng: 67.0011 } // ≈ 1.1 km north
const OFFICE_IP = '203.0.113.45'
const HOME_IP = '198.51.100.7'

let A: string, B: string
let shop: string, office: string, shopB: string
let ceoA: Who, ceoB: Who, hrA: Who, mgrA: Who, bossA: Who
const staff: Record<string, Who> = {}
const emps: Record<string, string> = {}

const call = (who: Who, method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown, ip = HOME_IP) =>
  app.inject({ method, url, payload: payload as never, remoteAddress: ip, headers: { authorization: `Bearer ${who.token}` } })

async function setOps(tenantId: string, data: Record<string, unknown>) {
  const cur = await prisma.operationsConfig.findFirst({ where: { tenantId, scope: 'global', scopeId: null } })
  if (cur) await prisma.operationsConfig.update({ where: { id: cur.id }, data })
  else await prisma.operationsConfig.create({ data: { tenantId, scope: 'global', scopeId: null, ...data } })
  invalidateSetupCache()
}
async function emp(tenantId: string, key: string, userId: string | null, managerId: string | null = null) {
  const e = await prisma.hrEmployee.create({
    data: { tenantId, employeeCode: `GF-${++seq}-${RUN}`, fullName: `${key} ${RUN}`, grossSalaryCents: 5_000_000, joiningDate: new Date('2025-01-01'), userId, managerId },
  })
  emps[key] = e.id
  return e.id
}
const today = (employeeId: string) =>
  prisma.hrRecord.findFirst({ where: { section: 'attendance', employeeId, startDate: pktToday() }, orderBy: { createdAt: 'desc' } })
const workAt = (employeeId: string, tenantId: string, locationId: string) =>
  prisma.hrWorkLocation.create({ data: { tenantId, employeeId, locationId, isPrimary: true } })

beforeAll(async () => {
  A = (await prisma.tenant.create({ data: { name: `GF A ${RUN}`, slug: `gf-a-${RUN}` } })).id
  B = (await prisma.tenant.create({ data: { name: `GF B ${RUN}`, slug: `gf-b-${RUN}` } })).id
  ceoA = await mkUser(`gf-ceoa-${RUN}`, 'admin', A)
  ceoB = await mkUser(`gf-ceob-${RUN}`, 'admin', B)
  hrA = await mkUser(`gf-hra-${RUN}`, 'hr', A)
  mgrA = await mkUser(`gf-mgra-${RUN}`, 'manager', A)
  bossA = await mkUser(`gf-boss-${RUN}`, 'manager', A)
  const bossEmp = await emp(A, 'boss', bossA.id)
  for (const k of ['cook', 'clerk', 'rough']) {
    staff[k] = await mkUser(`gf-${k}-${RUN}`, 'cashier', A)
    await emp(A, k, staff[k]!.id, bossEmp)
  }
  staff['bee'] = await mkUser(`gf-bee-${RUN}`, 'cashier', B)
  await emp(B, 'bee', staff['bee']!.id)
  await setOps(A, { geofenceEnforced: true, geofenceRadiusMetres: 100 })
  await setOps(B, { geofenceEnforced: true, geofenceRadiusMetres: 100 })

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(hrRoutes, { prefix: '/hr' })
  await app.register(timeClockRoutes, { prefix: '/time-clock' })
  await app.register(locationRoutes, { prefix: '/locations' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  await app?.close()
})

describe('the CEO approves each time-clock pin', () => {
  it('a manager\'s new pin waits; the clock does not measure from it yet', async () => {
    const r = await call(mgrA, 'POST', '/locations', { name: `Shop ${RUN}`, latitude: SHOP.lat, longitude: SHOP.lng, geofenceRadiusMetres: 120 })
    expect(r.statusCode).toBe(201)
    shop = r.json().id
    const row = await prisma.location.findUniqueOrThrow({ where: { id: shop } })
    expect(row.fenceLatitude).toBeNull()
    const pending = await call(ceoA, 'GET', '/locations/fence-pins?status=pending')
    expect(pending.json().items.map((i: { id: string }) => i.id)).toContain(shop)

    await workAt(emps['cook']!, A, shop)
    const p = await call(staff['cook']!, 'POST', '/time-clock/clock-in', { ...SHOP, accuracyM: 10 })
    expect(p.statusCode).toBe(201)
    expect(p.json().where).toMatchObject({ outOfArea: true, reason: 'no_anchor' })
    expect(p.json().attendance).toMatchObject({ held: true })
    await call(staff['cook']!, 'POST', '/time-clock/clock-out', {})
  })

  it('only the CEO of the location\'s company decides; a stale pin is refused', async () => {
    const body = { latitude: SHOP.lat, longitude: SHOP.lng, radiusMetres: 120 }
    expect((await call(mgrA, 'POST', `/locations/${shop}/fence-pin/approve`, body)).statusCode).toBe(403)
    expect((await call(ceoB, 'POST', `/locations/${shop}/fence-pin/approve`, body)).statusCode).toBe(404)
    const stale = await call(ceoA, 'POST', `/locations/${shop}/fence-pin/approve`, { ...body, radiusMetres: 300 })
    expect(stale.statusCode).toBe(409)
    expect(stale.json().error.code).toBe('PIN_CHANGED')
    const ok = await call(ceoA, 'POST', `/locations/${shop}/fence-pin/approve`, body)
    expect(ok.statusCode).toBe(200)
    const row = await prisma.location.findUniqueOrThrow({ where: { id: shop } })
    expect(row).toMatchObject({ fenceLatitude: SHOP.lat, fenceLongitude: SHOP.lng, fenceRadiusMetres: 120, fencePinApprovedById: ceoA.id })
    expect(await prisma.auditLog.count({ where: { action: 'approval.decide', entityId: shop } })).toBe(1)
    expect((await call(ceoA, 'POST', `/locations/${shop}/fence-pin/approve`, body)).json().error.code).toBe('PIN_NOT_PENDING')
  })

  it('a moved pin waits while the approved one stays in force; a rejected pin leaves the queue', async () => {
    const moved = await call(mgrA, 'PATCH', `/locations/${shop}`, { latitude: FAR.lat, longitude: FAR.lng })
    expect(moved.statusCode).toBe(200)
    expect((await prisma.location.findUniqueOrThrow({ where: { id: shop } })).fenceLatitude).toBe(SHOP.lat)
    const rej = await call(ceoA, 'POST', `/locations/${shop}/fence-pin/reject`, { latitude: FAR.lat, longitude: FAR.lng, radiusMetres: 120, note: 'That is the market, not the shop' })
    expect(rej.statusCode).toBe(200)
    const pending = await call(ceoA, 'GET', '/locations/fence-pins?status=pending')
    expect(pending.json().items.map((i: { id: string }) => i.id)).not.toContain(shop)
    // The CEO's own edit is the approval.
    const back = await call(ceoA, 'PATCH', `/locations/${shop}`, { latitude: SHOP.lat, longitude: SHOP.lng })
    expect(back.statusCode).toBe(200)
    const row = await prisma.location.findUniqueOrThrow({ where: { id: shop } })
    expect(row).toMatchObject({ fenceLatitude: SHOP.lat, fenceLongitude: SHOP.lng })
    expect((await call(ceoA, 'GET', '/locations/fence-pins')).json().items.find((i: { id: string }) => i.id === shop).pending).toBe(false)
  })
})

describe('outside the fence → the HOD', () => {
  it('inside the approved fence with a good reading: accepted, counts', async () => {
    await prisma.hrRecord.deleteMany({ where: { employeeId: emps['clerk']!, section: 'attendance' } })
    await workAt(emps['clerk']!, A, shop)
    const p = await call(staff['clerk']!, 'POST', '/time-clock/clock-in', { ...SHOP, accuracyM: 15 })
    expect(p.json().where).toMatchObject({ matched: true, outOfArea: false })
    expect((await today(emps['clerk']!))!.status).toBe('approved')
    await call(staff['clerk']!, 'POST', '/time-clock/clock-out', { ...SHOP, accuracyM: 15 })
  })

  it('a reading worse than 50 m is out of area (poor_fix) and held', async () => {
    await workAt(emps['rough']!, A, shop)
    const p = await call(staff['rough']!, 'POST', '/time-clock/clock-in', { ...SHOP, accuracyM: 80 })
    expect(p.json().where).toMatchObject({ outOfArea: true, reason: 'poor_fix' })
    expect((await today(emps['rough']!))!.status).toBe('submitted')
    await call(staff['rough']!, 'POST', '/time-clock/clock-out', {})
  })

  it('an out-of-area day is out of payroll until the HOD approves; the person says why', async () => {
    await prisma.hrRecord.deleteMany({ where: { employeeId: emps['cook']!, section: 'attendance' } })
    const p = await call(staff['cook']!, 'POST', '/time-clock/clock-in', { ...FAR, accuracyM: 10, reason: 'At the market' })
    expect(p.json().attendance).toMatchObject({ held: true })
    const recId = p.json().attendance.recordId as string
    const rec = await prisma.hrRecord.findUniqueOrThrow({ where: { id: recId } })
    expect(rec.status).toBe('submitted')
    const hold = (rec.data as Record<string, unknown>)['_outOfAreaHold'] as { punches: Array<{ reason: string; why: string; distanceM: number }> }
    expect(hold.punches[0]).toMatchObject({ reason: 'At the market', why: 'outside' })
    expect(hold.punches[0]!.distanceM).toBeGreaterThan(900)
    // Out of payroll / tip pools / overtime: not a standing day.
    expect(await prisma.hrRecord.count({ where: { id: recId, status: STANDING_ATTENDANCE } })).toBe(0)

    // The clock-out from outside again: the reason is added later by the person, own day only.
    const out = await call(staff['cook']!, 'POST', '/time-clock/clock-out', { ...FAR, accuracyM: 10 })
    expect(out.json().attendance).toMatchObject({ held: true })
    const status = await call(staff['cook']!, 'GET', '/time-clock/status')
    expect(status.json().heldDay).toMatchObject({ recordId: recId, hasReason: false })
    expect((await call(staff['bee']!, 'POST', '/time-clock/hold-reason', { recordId: recId, reason: 'Not mine' })).statusCode).toBe(404)
    expect((await call(staff['clerk']!, 'POST', '/time-clock/hold-reason', { recordId: recId, reason: 'Not mine' })).statusCode).toBe(404)
    const why = await call(staff['cook']!, 'POST', '/time-clock/hold-reason', { recordId: recId, reason: 'Carried the supplies back' })
    expect(why.statusCode).toBe(200)
    expect((await call(staff['cook']!, 'GET', '/time-clock/status')).json().heldDay).toMatchObject({ hasReason: true })

    // Waiting on the HOD — not on HR, never on the person.
    const bossList = await call(bossA, 'GET', '/hr/approvals')
    expect(bossList.json().map((r: { id: string }) => r.id)).toContain(recId)
    expect((await call(hrA, 'GET', '/hr/approvals')).json().map((r: { id: string }) => r.id)).not.toContain(recId)
    expect((await call(staff['cook']!, 'POST', `/hr/records/attendance/${recId}/decide`, { decision: 'approved' })).statusCode).toBe(403)
    expect((await call(hrA, 'POST', `/hr/records/attendance/${recId}/decide`, { decision: 'approved' })).statusCode).toBe(403)
    const ok = await call(bossA, 'POST', `/hr/records/attendance/${recId}/decide`, { decision: 'approved' })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().status).toBe('approved')
    expect(await prisma.hrRecord.count({ where: { id: recId, status: STANDING_ATTENDANCE } })).toBe(1)
  })

  it('a rejected day does not count', async () => {
    await prisma.hrRecord.deleteMany({ where: { employeeId: emps['rough']!, section: 'attendance' } })
    const p = await call(staff['rough']!, 'POST', '/time-clock/clock-in', { ...FAR, accuracyM: 10 })
    const recId = p.json().attendance.recordId as string
    const no = await call(bossA, 'POST', `/hr/records/attendance/${recId}/decide`, { decision: 'rejected', note: 'Was not at work' })
    expect(no.json().status).toBe('rejected')
    expect(await prisma.hrRecord.count({ where: { id: recId, status: STANDING_ATTENDANCE } })).toBe(0)
  })
})

describe('office Wi-Fi = the Head Office location', () => {
  it('HR names the location of an office network; another company\'s location is refused', async () => {
    office = (await prisma.location.create({ data: { slug: `gf-ho-${RUN}`, name: `Head Office ${RUN}`, tenantId: A } })).id
    shopB = (await prisma.location.create({ data: { slug: `gf-b-${RUN}`, name: `B Shop ${RUN}`, tenantId: B } })).id
    const cur = (await call(hrA, 'GET', '/hr/settings')).json()
    const bad = await call(hrA, 'PUT', '/hr/settings', { ...cur, officeNetworks: [{ address: OFFICE_IP, label: 'Office', locationId: shopB }] })
    expect(bad.statusCode).toBe(422)
    const ok = await call(hrA, 'PUT', '/hr/settings', { ...cur, officeNetworks: [{ address: OFFICE_IP, label: 'Office', locationId: office }] })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().officeNetworks[0]).toMatchObject({ locationId: office })
  })

  it('a check-in on the office network with no map reading is at the Head Office: in area for its staff, held for others', async () => {
    await prisma.hrRecord.deleteMany({ where: { employeeId: { in: [emps['clerk']!, emps['boss']!] }, section: 'attendance' } })
    await workAt(emps['boss']!, A, office)
    const atHo = await call(bossA, 'POST', '/time-clock/clock-in', {}, OFFICE_IP)
    expect(atHo.json().where).toMatchObject({ matched: true, outOfArea: false, location: `Head Office ${RUN}` })
    expect((await today(emps['boss']!))!.status).toBe('approved')

    const shopStaff = await call(staff['clerk']!, 'POST', '/time-clock/clock-in', {}, OFFICE_IP)
    expect(shopStaff.json().where).toMatchObject({ outOfArea: true })
    expect((await today(emps['clerk']!))!.status).toBe('submitted')
  })
})
