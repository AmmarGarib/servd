// Work locations as map pins (owner, 2026-10-27: "make work locations a system in which i can add multiple pin
// locations") — two companies.
//
//   - an employee's work location is EITHER a company Location OR their own map pin (label, lat, lng, radius);
//   - a new / moved pin waits for the CEO (approval type work_pin, CEO only, never another company's: 404) and is
//     NOT measured until approved; a moved pin keeps the old approved one in force; a stale decision is 409
//     PIN_CHANGED; a reject needs a note ≥10 and leaves the queue; the CEO's own pin applies at once;
//   - a punch matched to a pin names it by its label (ClockLog.pinLabel, the attendance punch);
//   - company-Location work locations behave as before; ≤20 per employee; the row CHECK holds.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { prisma, mkUser, type Who } from './connectorsFixtures.js'
import { AppError } from '../src/lib/errors.js'
import { invalidateSetupCache } from '../src/lib/setup-config.js'
import { hrRoutes } from '../src/modules/hr/routes.js'
import { timeClockRoutes } from '../src/modules/timeclock/routes.js'
import { locationRoutes } from '../src/modules/locations/routes.js'
import { approvalSubject } from '../src/lib/approvalRights.js'
import { pktToday } from '../src/modules/hr/logic.js'

const RUN = Date.now().toString(36)
let app: FastifyInstance
let seq = 0

// 0.001° ≈ 100 m here.
const SITE = { lat: 24.9001, lng: 67.1001 }
const FAR = { lat: 24.9101, lng: 67.1001 } // ≈ 1.1 km north
const SHOP = { lat: 24.8801, lng: 67.0501 }

let A: string, B: string
let ceoA: Who, ceoB: Who, hrA: Who, hrB: Who
const staff: Record<string, Who> = {}
const emps: Record<string, string> = {}
let pinId: string

const call = (who: Who, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as never, headers: { authorization: `Bearer ${who.token}` } })

async function setOps(tenantId: string, data: Record<string, unknown>) {
  const cur = await prisma.operationsConfig.findFirst({ where: { tenantId, scope: 'global', scopeId: null } })
  if (cur) await prisma.operationsConfig.update({ where: { id: cur.id }, data })
  else await prisma.operationsConfig.create({ data: { tenantId, scope: 'global', scopeId: null, ...data } })
  invalidateSetupCache()
}
async function emp(tenantId: string, key: string, userId: string | null) {
  const e = await prisma.hrEmployee.create({
    data: { tenantId, employeeCode: `WP-${++seq}-${RUN}`, fullName: `${key} ${RUN}`, grossSalaryCents: 5_000_000, joiningDate: new Date('2025-01-01'), userId },
  })
  emps[key] = e.id
  return e.id
}
async function punch(key: string, at: { lat: number; lng: number }) {
  const r = await call(staff[key]!, 'POST', '/time-clock/clock-in', { ...at, accuracyM: 10 })
  expect(r.statusCode).toBe(201)
  await call(staff[key]!, 'POST', '/time-clock/clock-out', {})
  return r.json()
}
const pinsOf = async (who: Who, key: string) => (await call(who, 'GET', `/hr/employees/${emps[key]}/work-locations`)).json().items as Array<Record<string, unknown>>

beforeAll(async () => {
  A = (await prisma.tenant.create({ data: { name: `WP A ${RUN}`, slug: `wp-a-${RUN}` } })).id
  B = (await prisma.tenant.create({ data: { name: `WP B ${RUN}`, slug: `wp-b-${RUN}` } })).id
  ceoA = await mkUser(`wp-ceoa-${RUN}`, 'admin', A)
  ceoB = await mkUser(`wp-ceob-${RUN}`, 'admin', B)
  hrA = await mkUser(`wp-hra-${RUN}`, 'hr', A)
  hrB = await mkUser(`wp-hrb-${RUN}`, 'hr', B)
  for (const k of ['field', 'boss', 'shopper']) {
    staff[k] = await mkUser(`wp-${k}-${RUN}`, 'cashier', A)
    await emp(A, k, staff[k]!.id)
  }
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

describe('an employee\'s own map pins', () => {
  it('HR adds a pin: it waits for the CEO and a punch there is out of area', async () => {
    const r = await call(hrA, 'PUT', `/hr/employees/${emps['field']}/work-locations`, { items: [{ label: 'Client site', latitude: SITE.lat, longitude: SITE.lng, radiusMetres: 150, isPrimary: true }] })
    expect(r.statusCode).toBe(200)
    const [pin] = r.json().items
    expect(pin).toMatchObject({ kind: 'pin', label: 'Client site', status: 'pending', approved: null, isPrimary: true })
    pinId = pin.id
    const row = await prisma.hrWorkLocation.findUniqueOrThrow({ where: { id: pinId } })
    expect(row).toMatchObject({ locationId: null, tenantId: A, fenceLatitude: null })
    expect((await approvalSubject('work_pin', pinId))?.status).toBe('pending')
    const queue = await call(ceoA, 'GET', '/hr/work-pins?status=pending')
    expect(queue.json().items.map((i: { id: string }) => i.id)).toContain(pinId)
    // The bell tells the CEO (approval.waiting).
    await new Promise((res) => setTimeout(res, 300))
    expect(await prisma.staffNotification.count({ where: { userId: ceoA.id, tenantId: A } })).toBeGreaterThan(0)

    const p = await punch('field', SITE)
    expect(p.where).toMatchObject({ outOfArea: true, reason: 'no_anchor' })
  })

  it('only the CEO of the employee\'s company decides; a stale pin is refused; approved = measured', async () => {
    const body = { latitude: SITE.lat, longitude: SITE.lng, radiusMetres: 150 }
    expect((await call(hrA, 'POST', `/hr/work-pins/${pinId}/approve`, body)).statusCode).toBe(403)
    expect((await call(ceoB, 'POST', `/hr/work-pins/${pinId}/approve`, body)).statusCode).toBe(404)
    expect((await call(ceoB, 'GET', '/hr/work-pins?status=pending')).json().items.map((i: { id: string }) => i.id)).not.toContain(pinId)
    const stale = await call(ceoA, 'POST', `/hr/work-pins/${pinId}/approve`, { ...body, radiusMetres: 300 })
    expect(stale.statusCode).toBe(409)
    expect(stale.json().error.code).toBe('PIN_CHANGED')
    const ok = await call(ceoA, 'POST', `/hr/work-pins/${pinId}/approve`, body)
    expect(ok.statusCode).toBe(200)
    expect(await prisma.hrWorkLocation.findUniqueOrThrow({ where: { id: pinId } })).toMatchObject({ fenceLatitude: SITE.lat, fenceLongitude: SITE.lng, fenceRadiusMetres: 150, fencePinApprovedById: ceoA.id })
    expect(await prisma.auditLog.count({ where: { action: 'approval.decide', entityId: pinId } })).toBe(1)
    expect((await call(ceoA, 'POST', `/hr/work-pins/${pinId}/approve`, body)).json().error.code).toBe('PIN_NOT_PENDING')
    expect((await pinsOf(hrA, 'field'))[0]).toMatchObject({ status: 'approved' })

    const p = await punch('field', { lat: SITE.lat + 0.001, lng: SITE.lng }) // ≈ 110 m, inside 150 m
    expect(p.where).toMatchObject({ outOfArea: false, matched: true, location: 'Client site', workPinId: pinId, locationId: null })
    const log = await prisma.clockLog.findFirstOrThrow({ where: { userId: staff['field']!.id, type: 'in' }, orderBy: { recordedAt: 'desc' } })
    expect(log).toMatchObject({ workPinId: pinId, pinLabel: 'Client site', outOfArea: false })
    const day = await prisma.hrRecord.findFirstOrThrow({ where: { section: 'attendance', employeeId: emps['field'], startDate: pktToday() } })
    const punches = (day.data as { _punches: Array<{ pinLabel?: string }> })._punches
    expect(punches.some((x) => x.pinLabel === 'Client site')).toBe(true)
    // The punch log names it.
    const today = new Date(pktToday()).toISOString().slice(0, 10)
    const logRows = (await call(hrA, 'GET', `/hr/attendance-tracking/punches?from=${today}&to=${today}&employeeId=${emps['field']}`)).json().rows as Array<{ location: string | null }>
    expect(logRows.some((x) => x.location === 'Client site')).toBe(true)
  })

  it('moving an approved pin keeps the old one in force until the CEO decides; reject needs a note', async () => {
    const moved = await call(hrA, 'PUT', `/hr/employees/${emps['field']}/work-locations`, { items: [{ id: pinId, label: 'Client site', latitude: FAR.lat, longitude: FAR.lng, radiusMetres: 150, isPrimary: true }] })
    expect(moved.statusCode).toBe(200)
    expect(moved.json().items[0]).toMatchObject({ id: pinId, status: 'pending', approved: { latitude: SITE.lat } })
    expect((await punch('field', SITE)).where).toMatchObject({ outOfArea: false, location: 'Client site' })
    expect((await punch('field', FAR)).where).toMatchObject({ outOfArea: true, reason: 'outside' })

    const body = { latitude: FAR.lat, longitude: FAR.lng, radiusMetres: 150 }
    expect((await call(ceoA, 'POST', `/hr/work-pins/${pinId}/reject`, { ...body, note: 'no' })).statusCode).toBe(400)
    const rej = await call(ceoA, 'POST', `/hr/work-pins/${pinId}/reject`, { ...body, note: 'That is the market, not the site' })
    expect(rej.statusCode).toBe(200)
    expect((await call(ceoA, 'GET', '/hr/work-pins?status=pending')).json().items.map((i: { id: string }) => i.id)).not.toContain(pinId)
    const [view] = await pinsOf(hrA, 'field')
    expect(view).toMatchObject({ status: 'rejected', rejected: { note: 'That is the market, not the site' }, approved: { latitude: SITE.lat } })
    expect((await punch('field', SITE)).where).toMatchObject({ outOfArea: false })
    // Renaming / re-saving the same rejected pin raises nothing new.
    const again = await call(hrA, 'PUT', `/hr/employees/${emps['field']}/work-locations`, { items: [{ id: pinId, label: 'Client site (old)', latitude: FAR.lat, longitude: FAR.lng, radiusMetres: 150, isPrimary: true }] })
    expect(again.json().items[0]).toMatchObject({ status: 'rejected', label: 'Client site (old)' })
  })

  it('the CEO\'s own pin applies at once', async () => {
    const r = await call(ceoA, 'PUT', `/hr/employees/${emps['boss']}/work-locations`, { items: [{ label: 'Warehouse', latitude: SITE.lat, longitude: SITE.lng, isPrimary: true }] })
    expect(r.statusCode).toBe(200)
    expect(r.json().items[0]).toMatchObject({ status: 'approved', radiusMetres: null })
    const row = await prisma.hrWorkLocation.findUniqueOrThrow({ where: { id: r.json().items[0].id } })
    expect(row).toMatchObject({ fenceLatitude: SITE.lat, fenceRadiusMetres: null, fencePinApprovedById: ceoA.id })
    // Blank radius → the company's (100 m).
    expect((await punch('boss', { lat: SITE.lat + 0.0005, lng: SITE.lng })).where).toMatchObject({ outOfArea: false, radiusM: 100, location: 'Warehouse' })
  })

  it('another company is 404; a foreign pin id is refused; at most 20', async () => {
    expect((await call(hrB, 'GET', `/hr/employees/${emps['field']}/work-locations`)).statusCode).toBe(404)
    expect((await call(hrB, 'PUT', `/hr/employees/${emps['field']}/work-locations`, { items: [] })).statusCode).toBe(404)
    // A pin id of another employee is never trusted.
    const foreign = await call(hrA, 'PUT', `/hr/employees/${emps['boss']}/work-locations`, { items: [{ id: pinId, label: 'Steal', latitude: SITE.lat, longitude: SITE.lng, isPrimary: true }] })
    expect(foreign.statusCode).toBe(422)
    expect(foreign.json().error.code).toBe('WORK_PIN_NOT_FOUND')
    const many = Array.from({ length: 21 }, (_, i) => ({ label: `P${i}`, latitude: SITE.lat, longitude: SITE.lng + i * 0.01, isPrimary: i === 0 }))
    expect((await call(hrA, 'PUT', `/hr/employees/${emps['boss']}/work-locations`, { items: many })).statusCode).toBe(400)
    expect((await call(hrA, 'PUT', `/hr/employees/${emps['boss']}/work-locations`, { items: many.slice(0, 20) })).statusCode).toBe(200)
  })

  it('company-Location work locations work as before, beside pins', async () => {
    const loc = await call(ceoA, 'POST', '/locations', { name: `WP Shop ${RUN}`, latitude: SHOP.lat, longitude: SHOP.lng, geofenceRadiusMetres: 120 })
    expect(loc.statusCode).toBe(201)
    const shop = loc.json().id
    const r = await call(hrA, 'PUT', `/hr/employees/${emps['shopper']}/work-locations`, {
      items: [{ locationId: shop, isPrimary: true }, { label: 'Pending pin', latitude: FAR.lat, longitude: FAR.lng }],
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().items[0]).toMatchObject({ kind: 'location', locationId: shop, hasPin: true })
    expect((await prisma.hrEmployee.findUniqueOrThrow({ where: { id: emps['shopper'] } })).locationId).toBe(shop)
    const p = await punch('shopper', SHOP)
    expect(p.where).toMatchObject({ outOfArea: false, locationId: shop, workPinId: null })
    expect((await call(hrA, 'PUT', `/hr/employees/${emps['shopper']}/work-locations`, { items: [{ locationId: 'nope', isPrimary: true }] })).json().error.code).toBe('LOCATION_NOT_IN_COMPANY')
  })

  it('a row is a Location or a pin, never both', async () => {
    const loc = await prisma.location.findFirstOrThrow({ where: { tenantId: A } })
    await expect(prisma.hrWorkLocation.create({ data: { tenantId: A, employeeId: emps['boss']!, locationId: loc.id, label: 'x', latitude: 1, longitude: 1 } })).rejects.toThrow()
    await expect(prisma.hrWorkLocation.create({ data: { tenantId: A, employeeId: emps['shopper']!, label: 'x' } })).rejects.toThrow()
  })
})
