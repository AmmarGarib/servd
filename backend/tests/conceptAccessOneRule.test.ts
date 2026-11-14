// ONE brand-access rule (redundancy clean-up step 4, 2026-11-14): the old
// lib/conceptAccess.ts check (assertConceptAccess / filterConceptIdsForStaff)
// is gone; floors, orders, reservations and the till decide brand access
// through lib/tenantScope.ts alone. Two companies A and B:
//   • B's login gets 404 on A's brand rows (read and write) — never 403;
//   • a create naming A's brand from B is refused;
//   • a member of both, with A picked at the top, still edits B's rows
//     (write mode = every company the login belongs to);
//   • a login with no company is denied (an empty scope never falls open);
//   • a head-office login reaching A (not a member) still cannot read A's
//     floors / orders / reservations through the lens (the old check never
//     admitted reach on these screens; neither does the new one).
import { describe, it, expect, beforeAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { floorRoutes } from '../src/modules/floors/routes.js'
import { orderRoutes } from '../src/modules/orders/routes.js'
import { reservationRoutes } from '../src/modules/reservations/routes.js'
import { posRoutes } from '../src/modules/pos/routes.js'
import { posTillFlowRoutes } from '../src/modules/pos/tillFlowRoutes.js'

const P = `car1-${Date.now()}`
let app: FastifyInstance
let tA: string, tB: string, HO: string
let conceptA: string, conceptB: string
let floorA: string, floorB: string
let orderA: string, orderB: string
let resA: string, resB: string
const tokens: Record<string, string> = {}

async function mkUser(key: string, role: string, primary: string | null, members: string[]) {
  const u = await prisma.user.create({
    data: {
      name: key, email: `${key}.${P}@gsfoods.pk`, password: await bcrypt.hash('x-Password-1', 4),
      role: role as never, isActive: true, accountStatus: 'active', tenantId: primary,
    },
  })
  for (const t of members) await prisma.tenantMember.create({ data: { tenantId: t, userId: u.id } })
  tokens[key] = (issueStaffSession(u) as { accessToken: string }).accessToken
}

type Method = 'GET' | 'POST' | 'PATCH'
function call(who: string, method: Method, url: string, payload?: unknown, headers: Record<string, string> = {}) {
  return app.inject({
    method, url,
    headers: { authorization: `Bearer ${tokens[who]}`, ...headers },
    ...(payload !== undefined ? { payload: payload as never } : {}),
  })
}

async function mkOrder(conceptId: string) {
  return (await prisma.order.create({
    data: {
      conceptId, source: 'pos', fulfilmentType: 'takeout', status: 'received',
      totalCents: 1000, taxCents: 0, curbsideVehicle: 'White Corolla', placedAt: new Date(),
    },
  })).id
}

async function mkReservation(conceptId: string) {
  const start = new Date(Date.now() + 86_400_000)
  return (await prisma.reservation.create({
    data: { conceptId, partySize: 2, startTime: start, endTime: new Date(start.getTime() + 90 * 60_000), guestName: 'Guest' },
  })).id
}

beforeAll(async () => {
  tA = (await prisma.tenant.create({ data: { name: 'One Rule A', slug: `${P}-a` } })).id
  tB = (await prisma.tenant.create({ data: { name: 'One Rule B', slug: `${P}-b` } })).id
  HO = (await prisma.tenant.create({ data: { name: 'One Rule HO', slug: `${P}-ho`, kind: 'head_office' } })).id
  conceptA = (await prisma.concept.create({ data: { name: 'Rule Cafe A', slug: `${P}-cafe-a`, type: 'restaurant', tenantId: tA } })).id
  conceptB = (await prisma.concept.create({ data: { name: 'Rule Cafe B', slug: `${P}-cafe-b`, type: 'restaurant', tenantId: tB } })).id
  floorA = (await prisma.floor.create({ data: { conceptId: conceptA, name: 'Main A' } })).id
  floorB = (await prisma.floor.create({ data: { conceptId: conceptB, name: 'Main B' } })).id
  orderA = await mkOrder(conceptA)
  orderB = await mkOrder(conceptB)
  resA = await mkReservation(conceptA)
  resB = await mkReservation(conceptB)

  await mkUser('a', 'management', tA, [tA])
  await mkUser('b', 'management', tB, [tB])
  await mkUser('both', 'management', tA, [tA, tB]) // A is the company picked at the top
  await mkUser('nobody', 'management', null, [])
  await mkUser('hod', 'management', HO, [HO])       // head office reaching A, member of HO only
  await prisma.headOfficeLink.create({ data: { tenantId: HO, companyTenantId: tA, createdById: 'seed' } })

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR' } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(floorRoutes, { prefix: '/floors' })
  await app.register(orderRoutes, { prefix: '/orders' })
  await app.register(reservationRoutes, { prefix: '/reservations' })
  await app.register(posRoutes, { prefix: '/pos' })
  await app.register(posTillFlowRoutes, { prefix: '/pos' })
  await app.ready()
})

describe('read mode — company B never sees company A', () => {
  it('floor status / board: own brand 200, the other company 404', async () => {
    expect((await call('a', 'GET', `/floors/status?conceptId=${conceptA}`)).statusCode).toBe(200)
    expect((await call('b', 'GET', `/floors/status?conceptId=${conceptA}`)).statusCode).toBe(404)
    expect((await call('b', 'GET', `/floors/board?conceptId=${conceptA}`)).statusCode).toBe(404)
    expect((await call('b', 'GET', `/floors?conceptId=${conceptA}`)).statusCode).toBe(404)
  })

  it('an order: own 200, the other company 404; the list never carries it', async () => {
    expect((await call('a', 'GET', `/orders/${orderA}`)).statusCode).toBe(200)
    expect((await call('b', 'GET', `/orders/${orderA}`)).statusCode).toBe(404)
    expect((await call('b', 'GET', `/orders?conceptId=${conceptA}`)).statusCode).toBe(404)
    const list = await call('b', 'GET', '/orders')
    expect(list.statusCode).toBe(200)
    expect(JSON.stringify(list.json())).not.toContain(orderA)
    expect(JSON.stringify(list.json())).toContain(orderB)
  })

  it('reservations waitlist / blockouts / analytics: the other company 404', async () => {
    expect((await call('a', 'GET', `/reservations/waitlist?conceptId=${conceptA}`)).statusCode).toBe(200)
    expect((await call('b', 'GET', `/reservations/waitlist?conceptId=${conceptA}`)).statusCode).toBe(404)
    expect((await call('b', 'GET', `/reservations/blockouts?conceptId=${conceptA}`)).statusCode).toBe(404)
    expect((await call('b', 'GET', `/reservations?conceptId=${conceptA}`)).statusCode).toBe(404)
  })

  it('till lookups (waiters) for a foreign brand: 404', async () => {
    expect((await call('a', 'GET', `/pos/waiters?conceptId=${conceptA}`)).statusCode).toBe(200)
    expect((await call('b', 'GET', `/pos/waiters?conceptId=${conceptA}`)).statusCode).toBe(404)
  })
})

describe('write mode — editing an existing row', () => {
  it('B cannot edit A\'s floor, order or booking (404)', async () => {
    expect((await call('b', 'PATCH', `/floors/${floorA}`, { name: 'Hijack' })).statusCode).toBe(404)
    expect((await call('b', 'POST', `/orders/${orderA}/curbside/running-out`)).statusCode).toBe(404)
    expect((await call('b', 'POST', `/reservations/${resA}/deposit-hold`, { amountCents: 1000, gatewayRef: 'ref-123' })).statusCode).toBe(404)
  })

  it('a member of both companies with A picked still edits B\'s rows', async () => {
    expect((await call('both', 'PATCH', `/floors/${floorB}`, { name: 'Main B (edited)' })).statusCode).toBe(200)
    expect((await call('both', 'POST', `/orders/${orderB}/curbside/running-out`)).statusCode).toBe(200)
    expect((await call('both', 'POST', `/reservations/${resB}/deposit-hold`, { amountCents: 1000, gatewayRef: 'ref-456' })).statusCode).toBe(200)
  })
})

describe('create mode — a new row binds to the ACTIVE company', () => {
  it('B naming A\'s brand on a create is refused', async () => {
    expect((await call('b', 'POST', '/floors', { conceptId: conceptA, name: 'Sneaky' })).statusCode).toBe(404)
    const blockout = { conceptId: conceptA, startTime: new Date(Date.now() + 2 * 86_400_000).toISOString(), endTime: new Date(Date.now() + 3 * 86_400_000).toISOString() }
    expect((await call('b', 'POST', '/reservations/blockouts', blockout)).statusCode).toBe(404)
    const quote = { conceptId: conceptA, items: [{ menuItemId: null, name: 'Tea', quantity: 1, unitPriceCents: 100 }] }
    expect((await call('b', 'POST', '/pos/quote', quote)).statusCode).toBe(404)
    expect(await prisma.floor.count({ where: { name: 'Sneaky' } })).toBe(0)
  })

  it('a member of both with A picked cannot create under B\'s brand (create = active company only)', async () => {
    expect((await call('both', 'POST', '/floors', { conceptId: conceptB, name: 'Wrong company' })).statusCode).toBe(404)
    expect((await call('both', 'POST', '/floors', { conceptId: conceptA, name: 'Right company' })).statusCode).toBe(201)
  })
})

describe('an empty scope denies', () => {
  it('a login with no company gets nothing', async () => {
    expect((await call('nobody', 'GET', `/floors/status?conceptId=${conceptA}`)).statusCode).toBe(404)
    expect((await call('nobody', 'GET', `/orders/${orderA}`)).statusCode).toBe(404)
    expect((await call('nobody', 'PATCH', `/floors/${floorA}`, { name: 'x' })).statusCode).toBe(404)
    expect((await call('nobody', 'GET', `/reservations/waitlist?conceptId=${conceptA}`)).statusCode).toBe(404)
    const list = await call('nobody', 'GET', '/orders')
    expect(list.statusCode).toBe(200)
    expect((list.json() as { data: unknown[] }).data).toHaveLength(0)
  })
})

describe('head-office reach is not membership on these screens', () => {
  it('a head-office login looking at A through the lens is refused (as before)', async () => {
    const lens = { 'x-servd-active-tenant': tA }
    expect((await call('hod', 'GET', `/floors/status?conceptId=${conceptA}`, undefined, lens)).statusCode).toBe(404)
    expect((await call('hod', 'GET', `/orders/${orderA}`, undefined, lens)).statusCode).toBe(404)
    expect((await call('hod', 'GET', `/reservations/waitlist?conceptId=${conceptA}`, undefined, lens)).statusCode).toBe(404)
    const list = await call('hod', 'GET', '/orders', undefined, lens)
    expect(list.statusCode).toBe(200)
    expect(JSON.stringify(list.json())).not.toContain(orderA)
  })
})
