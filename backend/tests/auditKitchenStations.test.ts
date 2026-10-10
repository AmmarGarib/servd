// Kitchen audit follow-ups (2026-10-10), station routing.
//
// What this guards:
//   - A menu item can't be created or edited onto a station that is deleted
//     or switched off (422 STATION_NOT_LIVE): no kitchen screen shows such a
//     station, so the dish would be cooked by nobody. A station of another
//     brand / company stays 422 STATION_NOT_IN_BRAND.
//   - The station edit route accepts isActive (the KDS Config on/off switch,
//     which used to be stripped silently). Switching a station off, or moving
//     it to another brand, is refused while dishes, recipe steps or open
//     tickets still route there (409 STATION_IN_USE) — the same check as
//     delete. Switching it back on is always allowed.
// Two-company: company B gets 404 on company A's stations and menu items.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { menuRoutes } from '../src/modules/menu/routes.js'
import { stationRoutes } from '../src/modules/stations/routes.js'

let app: FastifyInstance
let tenantA: string
let tenantB: string
let conceptA: string
let conceptA2: string
let categoryA: string
let conceptB: string
const users: Record<string, { id: string; token: string }> = {}

async function mkUser(key: string, role: string, tenantId: string) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.kitchenstations@test.local`, password: await bcrypt.hash('x-Password-1', 4), role: role as never, isActive: true, accountStatus: 'active', tenantId },
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } as never }).catch(() => {})
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}

const call = (who: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${users[who]!.token}` }, ...(payload !== undefined ? { payload: payload as object } : {}) })

const station = (conceptId: string, name: string, extra: { isActive?: boolean; deletedAt?: Date } = {}) =>
  prisma.station.create({ data: { conceptId, name, ...extra } }).then((s) => s.id)

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'Stations A', slug: 'kitchen-stations-a' } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'Stations B', slug: 'kitchen-stations-b' } })).id
  conceptA = (await prisma.concept.create({ data: { name: 'Station Diner', slug: 'kitchen-stations-diner', type: 'restaurant', tenantId: tenantA } })).id
  conceptA2 = (await prisma.concept.create({ data: { name: 'Station Cafe', slug: 'kitchen-stations-cafe', type: 'restaurant', tenantId: tenantA } })).id
  conceptB = (await prisma.concept.create({ data: { name: 'Station Other', slug: 'kitchen-stations-other', type: 'restaurant', tenantId: tenantB } })).id
  categoryA = (await prisma.category.create({ data: { conceptId: conceptA, name: 'Mains' } })).id

  await mkUser('ceoA', 'admin', tenantA)
  await mkUser('ceoB', 'admin', tenantB)
  await mkUser('chefA', 'boh_management', tenantA)
  await mkUser('chefB', 'boh_management', tenantB)

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(menuRoutes, { prefix: '/menu' })
  await app.register(stationRoutes, { prefix: '/stations' })
  await app.ready()
})

afterAll(async () => {
  await app.close()
})

const newItem = (name: string, stationId?: string | null) => ({
  conceptId: conceptA, categoryId: categoryA, name, priceCents: 50_000, ...(stationId !== undefined ? { stationId } : {}),
})

// ─── Menu items route only to live stations ──────────────────────────────────

describe('menu item station must be live', () => {
  it('create refuses a deleted or switched-off station, accepts a live one', async () => {
    const deleted = await station(conceptA, 'Old Grill', { isActive: false, deletedAt: new Date() })
    const off = await station(conceptA, 'Closed Fryer', { isActive: false })
    const live = await station(conceptA, 'Grill')

    const r1 = await call('chefA', 'POST', '/menu/items', newItem('Burger', deleted))
    expect(r1.statusCode).toBe(422)
    expect(r1.json().error.code).toBe('STATION_NOT_LIVE')

    const r2 = await call('chefA', 'POST', '/menu/items', newItem('Fries', off))
    expect(r2.statusCode).toBe(422)
    expect(r2.json().error.code).toBe('STATION_NOT_LIVE')
    expect(await prisma.menuItem.count({ where: { conceptId: conceptA, name: { in: ['Burger', 'Fries'] } } })).toBe(0)

    const ok = await call('chefA', 'POST', '/menu/items', newItem('Burger', live))
    expect(ok.statusCode).toBe(201)
    expect(ok.json().stationId).toBe(live)

    // No station at all is still allowed (expo is told it is unrouted).
    expect((await call('chefA', 'POST', '/menu/items', newItem('Water', null))).statusCode).toBe(201)
  })

  it('edit refuses a deleted or switched-off station and leaves the routing alone', async () => {
    const live = await station(conceptA, 'Pass')
    const off = await station(conceptA, 'Wok (off)', { isActive: false })
    const item = await prisma.menuItem.create({ data: { conceptId: conceptA, categoryId: categoryA, name: 'Noodles', priceCents: 90_000, stationId: live } })

    const r = await call('chefA', 'PATCH', `/menu/items/${item.id}`, { stationId: off })
    expect(r.statusCode).toBe(422)
    expect(r.json().error.code).toBe('STATION_NOT_LIVE')
    expect((await prisma.menuItem.findUniqueOrThrow({ where: { id: item.id } })).stationId).toBe(live)

    // Other edits are unaffected.
    expect((await call('chefA', 'PATCH', `/menu/items/${item.id}`, { priceCents: 95_000 })).statusCode).toBe(200)
  })

  it('a station of another brand or company is not this brand’s; B cannot edit A’s item', async () => {
    const otherBrand = await station(conceptA2, 'Cafe Bar')
    const otherCompany = await station(conceptB, 'B Grill')
    for (const st of [otherBrand, otherCompany]) {
      const r = await call('chefA', 'POST', '/menu/items', newItem('Salad', st))
      expect(r.statusCode).toBe(422)
      expect(r.json().error.code).toBe('STATION_NOT_IN_BRAND')
    }
    const item = await prisma.menuItem.create({ data: { conceptId: conceptA, categoryId: categoryA, name: 'Soup', priceCents: 40_000 } })
    expect((await call('chefB', 'PATCH', `/menu/items/${item.id}`, { stationId: otherCompany })).statusCode).toBe(404)
    expect((await prisma.menuItem.findUniqueOrThrow({ where: { id: item.id } })).stationId).toBeNull()
  })
})

// ─── The KDS Config on/off switch ────────────────────────────────────────────

describe('station isActive switch', () => {
  it('is applied (it used to be stripped), and can be switched back on', async () => {
    const st = await station(conceptA, 'Spare Line')
    const off = await call('ceoA', 'PATCH', `/stations/${st}`, { isActive: false })
    expect(off.statusCode).toBe(200)
    expect(off.json().isActive).toBe(false)
    expect((await prisma.station.findUniqueOrThrow({ where: { id: st } })).isActive).toBe(false)

    const on = await call('ceoA', 'PATCH', `/stations/${st}`, { isActive: true })
    expect(on.statusCode).toBe(200)
    expect((await prisma.station.findUniqueOrThrow({ where: { id: st } })).isActive).toBe(true)
  })

  it('switching off is refused while a dish, a recipe step or an open ticket routes there', async () => {
    const st = await station(conceptA, 'Hot Line')
    const dish = await prisma.menuItem.create({ data: { conceptId: conceptA, categoryId: categoryA, name: 'Pulao', priceCents: 120_000, stationId: st } })

    const r1 = await call('ceoA', 'PATCH', `/stations/${st}`, { isActive: false })
    expect(r1.statusCode).toBe(409)
    expect(r1.json().error.code).toBe('STATION_IN_USE')
    expect(r1.json().error.details).toMatchObject({ menuItems: 1 })
    expect(r1.json().error.message).toContain('switch it off')
    expect((await prisma.station.findUniqueOrThrow({ where: { id: st } })).isActive).toBe(true)

    // Dish moved; a recipe step still routes there.
    const other = await station(conceptA, 'Tandoor')
    await prisma.menuItem.update({ where: { id: dish.id }, data: { stationId: other } })
    const recipe = await prisma.recipe.create({
      data: { kind: 'plate', menuItemId: dish.id, recipeSteps: { create: [{ phase: 'service_cook', stationId: st, instruction: 'Steam', dependsOnIds: [] }] } },
    })
    const r2 = await call('ceoA', 'PATCH', `/stations/${st}`, { isActive: false })
    expect(r2.statusCode).toBe(409)
    expect(r2.json().error.details).toMatchObject({ menuItems: 0, recipeSteps: 1 })

    // Step moved; an open ticket is still on it.
    await prisma.recipeStep.updateMany({ where: { recipeId: recipe.id }, data: { stationId: other } })
    const order = await prisma.order.create({
      data: {
        conceptId: conceptA, source: 'pos', status: 'preparing', totalCents: 120_000, placedAt: new Date(),
        items: { create: [{ name: 'Pulao', quantity: 1, unitPriceCents: 120_000, stationId: st, status: 'preparing' }] },
      },
    })
    const r3 = await call('ceoA', 'PATCH', `/stations/${st}`, { isActive: false })
    expect(r3.statusCode).toBe(409)
    expect(r3.json().error.details).toMatchObject({ openTickets: 1 })

    // Ticket done — now it can be switched off.
    await prisma.orderItem.updateMany({ where: { orderId: order.id }, data: { status: 'bumped' } })
    const ok = await call('ceoA', 'PATCH', `/stations/${st}`, { isActive: false })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().isActive).toBe(false)

    // Renaming / re-ordering a switched-off station that still has nothing is fine.
    expect((await call('ceoA', 'PATCH', `/stations/${st}`, { name: 'Hot Line (spare)' })).statusCode).toBe(200)
  })

  it('a rename of an in-use station is not blocked; moving it to another brand is', async () => {
    const st = await station(conceptA, 'Fry')
    await prisma.menuItem.create({ data: { conceptId: conceptA, categoryId: categoryA, name: 'Wings', priceCents: 80_000, stationId: st } })
    expect((await call('ceoA', 'PATCH', `/stations/${st}`, { name: 'Fryer' })).statusCode).toBe(200)
    expect((await call('ceoA', 'PATCH', `/stations/${st}`, { isActive: true })).statusCode).toBe(200)

    const move = await call('ceoA', 'PATCH', `/stations/${st}`, { conceptId: conceptA2 })
    expect(move.statusCode).toBe(409)
    expect(move.json().error.code).toBe('STATION_IN_USE')
    expect((await prisma.station.findUniqueOrThrow({ where: { id: st } })).conceptId).toBe(conceptA)
  })

  it('company B cannot switch off company A’s station', async () => {
    const st = await station(conceptA, 'Garnish')
    expect((await call('ceoB', 'PATCH', `/stations/${st}`, { isActive: false })).statusCode).toBe(404)
    expect((await prisma.station.findUniqueOrThrow({ where: { id: st } })).isActive).toBe(true)
  })
})
