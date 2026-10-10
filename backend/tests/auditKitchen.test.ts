// Kitchen (BOH) shift-audit fixes, 2026-10-10 — regression suite.
//
// What this guards:
//   BOH-01  Expo "Fire" only fires pending, never-voided lines: a line voided
//           before firing stays voided and never reaches a station screen.
//   BOH-05  Expo "Fire" fires the first open course only (no course = 1);
//           later courses stay pending for "fire course N"; a named course
//           fires just that course.
//   BOH-03  A station that still routes work (menu items, recipe steps, open
//           tickets) can't be deleted (409 STATION_IN_USE); expo fire reports
//           lines routed to a retired station as unrouted.
//   BOH-07  Waste cost is the server's (moving-average cost × quantity): a
//           typed cost is ignored, the photo rule runs on the real value, and
//           the ledger books the real value in the item's company.
//   BOH-08  A food-safety temperature breach raises its exception in the
//           unit's company — in that company's inbox only.
//   BOH-12  A stock count's shortage / surplus posts a balanced entry
//           (5050 Inventory Variance vs 1210 Inventory — Food) in the count's
//           company, idempotent on the count id.
//   BOOKS-02 The finance role reaches the exceptions inbox (it holds the
//           `exceptions` module), scoped to its own company.
// Every route test is two-company: company B gets 404 on company A's rows.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { invalidateSetupCache } from '../src/lib/setup-config.js'
import { expoRoutes } from '../src/modules/expo/routes.js'
import { fireOrderItems, firstOpenCourse } from '../src/modules/expo/fire.js'
import { orderCourseRoutes } from '../src/modules/orders/routes.js'
import { stationRoutes } from '../src/modules/stations/routes.js'
import { inventoryRoutes } from '../src/modules/inventory/routes.js'
import { foodSafetyRoutes } from '../src/modules/foodSafety/routes.js'
import { crosschecksRoutes } from '../src/modules/crosschecks/routes.js'
import { postStockCount } from '../src/modules/crosschecks/countPosting.js'

let app: FastifyInstance
let tenantA: string
let tenantB: string
let conceptA: string
let categoryA: string
let grillA: string
let fryA: string
let friesId: string
let burgerId: string
let conceptB: string
const users: Record<string, { id: string; token: string }> = {}
const PHOTO = 'https://example.com/waste.jpg'

async function mkUser(key: string, role: string, tenantId: string) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.kitchenaudit@test.local`, password: await bcrypt.hash('x-Password-1', 4), role: role as never, isActive: true, accountStatus: 'active', tenantId },
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } as never }).catch(() => {})
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}

const call = (who: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${users[who]!.token}` }, ...(payload !== undefined ? { payload: payload as object } : {}) })

async function waitFor<T>(read: () => Promise<T>, done: (v: T) => boolean, ms = 4000): Promise<T> {
  const until = Date.now() + ms
  let v = await read()
  while (!done(v) && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 50))
    v = await read()
  }
  return v
}

type Line = { menuItemId?: string; name: string; course?: number | null; status?: 'pending' | 'voided' | 'bumped' | 'preparing'; stationId?: string | null }
let n = 0
async function order(lines: Line[], conceptId = conceptA) {
  n += 1
  return prisma.order.create({
    data: {
      conceptId, source: 'pos', status: 'received', fulfilmentType: 'dine_in', totalCents: 100_000, placedAt: new Date(),
      externalId: `kitchen-audit-${n}-${Date.now()}`,
      items: {
        create: lines.map((l) => ({
          menuItemId: l.menuItemId ?? null,
          name: l.name,
          quantity: 1,
          unitPriceCents: 50_000,
          course: l.course ?? null,
          stationId: l.stationId === undefined ? (l.menuItemId === burgerId ? grillA : l.menuItemId === friesId ? fryA : null) : l.stationId,
          status: l.status ?? 'pending',
          ...(l.status === 'voided' ? { voidedAt: new Date(), voidReason: 'rang twice' } : {}),
        })),
      },
    },
    include: { items: true },
  })
}

const itemsOf = (orderId: string) => prisma.orderItem.findMany({ where: { orderId }, orderBy: { name: 'asc' } })

async function entry(tenantId: string, reference: string) {
  return prisma.journalEntry.findFirst({
    where: { tenantId, reference },
    include: { lines: { include: { account: { select: { code: true, tenantId: true } } } } },
  })
}

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'Kitchen A', slug: 'kitchen-audit-a' } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'Kitchen B', slug: 'kitchen-audit-b' } })).id
  await ensureChartOfAccounts(tenantA)
  await ensureChartOfAccounts(tenantB)
  invalidateSetupCache()

  conceptA = (await prisma.concept.create({ data: { name: 'Kitchen Diner', slug: 'kitchen-audit-diner', type: 'restaurant', tenantId: tenantA } })).id
  conceptB = (await prisma.concept.create({ data: { name: 'Other Diner', slug: 'kitchen-audit-other', type: 'restaurant', tenantId: tenantB } })).id
  categoryA = (await prisma.category.create({ data: { conceptId: conceptA, name: 'Mains' } })).id
  grillA = (await prisma.station.create({ data: { conceptId: conceptA, name: 'Grill' } })).id
  fryA = (await prisma.station.create({ data: { conceptId: conceptA, name: 'Fry' } })).id
  friesId = (await prisma.menuItem.create({ data: { conceptId: conceptA, categoryId: categoryA, name: 'Fries', priceCents: 45_000, stationId: fryA } })).id
  burgerId = (await prisma.menuItem.create({ data: { conceptId: conceptA, categoryId: categoryA, name: 'Smash Burger', priceCents: 145_000, stationId: grillA } })).id

  await mkUser('ceoA', 'admin', tenantA)
  await mkUser('ceoB', 'admin', tenantB)
  await mkUser('expoA', 'expediter', tenantA)
  await mkUser('expoB', 'expediter', tenantB)
  await mkUser('cookA', 'kitchen', tenantA)
  await mkUser('cookB', 'kitchen', tenantB)
  await mkUser('chefA', 'boh_management', tenantA)
  await mkUser('financeA', 'finance', tenantA)
  await mkUser('financeB', 'finance', tenantB)

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(expoRoutes, { prefix: '/expo' })
  await app.register(orderCourseRoutes, { prefix: '/orders' })
  await app.register(stationRoutes, { prefix: '/stations' })
  await app.register(inventoryRoutes, { prefix: '/inventory' })
  await app.register(foodSafetyRoutes, { prefix: '/food-safety' })
  await app.register(crosschecksRoutes, { prefix: '/crosschecks' })
  await app.ready()
})

afterAll(async () => {
  await app.close()
  invalidateSetupCache()
})

// ─── BOH-01: Fire never un-voids a line ──────────────────────────────────────

describe('expo fire — voided lines (BOH-01)', () => {
  it('fires only the pending lines; a voided line stays voided and off the grill screen', async () => {
    const o = await order([{ menuItemId: friesId, name: 'Fries' }, { menuItemId: burgerId, name: 'Smash Burger', status: 'voided' }])
    const res = await call('expoA', 'POST', `/expo/orders/${o.id}/fire`, {})
    expect(res.statusCode).toBe(200)
    expect(res.json().fired).toBe(1)

    const [fries, burger] = await itemsOf(o.id)
    expect(fries!.status).toBe('preparing')
    expect(burger!.status).toBe('voided')
    expect(burger!.firedAt).toBeNull()
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('preparing')

    const q = await call('cookA', 'GET', `/expo/station/${grillA}/queue`)
    expect(q.statusCode).toBe(200)
    expect((q.json().legacy as Array<{ itemId: string }>).some((l) => l.itemId === burger!.id)).toBe(false)
  })

  it('a line carrying a void stamp is never claimed, even if its status still says pending', async () => {
    const o = await order([{ menuItemId: friesId, name: 'Fries' }])
    const line = o.items[0]!
    // A void landing between expo reading the order and claiming the line.
    await prisma.orderItem.update({ where: { id: line.id }, data: { voidedAt: new Date(), voidReason: 'race' } })
    const r = await fireOrderItems(o.id, [line.id])
    expect(r.fired).toEqual([])
    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: line.id } })).status).toBe('pending')
  })

  it('refuses an order whose every line is voided, and leaves it untouched', async () => {
    const o = await order([{ menuItemId: burgerId, name: 'Smash Burger', status: 'voided' }])
    const res = await call('expoA', 'POST', `/expo/orders/${o.id}/fire`, {})
    expect(res.statusCode).toBe(409)
    expect(res.json().error.code).toBe('NOTHING_TO_FIRE')
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('received')
  })

  it('a recipe-step line that was voided gets no steps; the live one does', async () => {
    const steak = await prisma.menuItem.create({ data: { conceptId: conceptA, categoryId: categoryA, name: 'Steak', priceCents: 300_000 } })
    await prisma.recipe.create({
      data: {
        kind: 'plate', menuItemId: steak.id,
        recipeSteps: { create: [{ phase: 'service_cook', stationId: grillA, instruction: 'Sear', dependsOnIds: [] }] },
      },
    })
    const o = await order([
      { menuItemId: steak.id, name: 'Steak A', stationId: null },
      { menuItemId: steak.id, name: 'Steak B', stationId: null, status: 'voided' },
    ])
    const res = await call('expoA', 'POST', `/expo/orders/${o.id}/fire`, {})
    expect(res.statusCode).toBe(200)
    expect(res.json().fired).toBe(1)
    const [a, b] = await itemsOf(o.id)
    expect(await prisma.orderItemStep.count({ where: { orderItemId: a!.id, status: 'preparing', stationId: grillA } })).toBe(1)
    expect(await prisma.orderItemStep.count({ where: { orderItemId: b!.id } })).toBe(0)
    expect(b!.status).toBe('voided')
  })

  it('company B cannot fire company A’s order', async () => {
    const o = await order([{ menuItemId: friesId, name: 'Fries' }])
    const res = await call('expoB', 'POST', `/expo/orders/${o.id}/fire`, {})
    expect(res.statusCode).toBe(404)
    expect((await itemsOf(o.id))[0]!.status).toBe('pending')
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('received')
  })
})

// ─── BOH-05: Fire respects courses ───────────────────────────────────────────

describe('expo fire — courses (BOH-05)', () => {
  it('fires course 1 only; course 2 waits and fires with fire-course', async () => {
    const o = await order([{ menuItemId: friesId, name: 'Fries', course: 1 }, { menuItemId: burgerId, name: 'Smash Burger', course: 2 }])
    const res = await call('expoA', 'POST', `/expo/orders/${o.id}/fire`, {})
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ fired: 1, course: 1, heldCourses: [2] })
    const [fries, burger] = await itemsOf(o.id)
    expect(fries!.status).toBe('preparing')
    expect(burger!.status).toBe('pending')

    const c2 = await call('expoA', 'POST', `/orders/${o.id}/fire-course`, { course: 2 })
    expect(c2.statusCode).toBe(200)
    expect((await itemsOf(o.id))[1]!.status).toBe('preparing')
  })

  it('a line with no course belongs to course 1', async () => {
    const o = await order([{ menuItemId: friesId, name: 'Fries', course: null }, { menuItemId: burgerId, name: 'Smash Burger', course: 2 }])
    const res = await call('expoA', 'POST', `/expo/orders/${o.id}/fire`, {})
    expect(res.json()).toMatchObject({ fired: 1, course: 1, heldCourses: [2] })
    expect((await itemsOf(o.id)).map((i) => i.status)).toEqual(['preparing', 'pending'])
  })

  it('the first course is the lowest one still open — a fully voided course 1 is skipped', async () => {
    const o = await order([
      { menuItemId: friesId, name: 'Fries', course: 1, status: 'voided' },
      { menuItemId: burgerId, name: 'Smash Burger', course: 2 },
    ])
    const res = await call('expoA', 'POST', `/expo/orders/${o.id}/fire`, {})
    expect(res.json()).toMatchObject({ fired: 1, course: 2, heldCourses: [] })
    expect(firstOpenCourse([{ status: 'bumped', voidedAt: null, course: 1 }, { status: 'pending', voidedAt: null, course: 3 }])).toBe(3)
  })

  it('a named course fires just that course', async () => {
    const o = await order([{ menuItemId: friesId, name: 'Fries', course: 1 }, { menuItemId: burgerId, name: 'Smash Burger', course: 2 }])
    const res = await call('expoA', 'POST', `/expo/orders/${o.id}/fire`, { course: 2 })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ fired: 1, course: 2, heldCourses: [1] })
    expect((await itemsOf(o.id)).map((i) => i.status)).toEqual(['pending', 'preparing'])

    const empty = await order([{ menuItemId: friesId, name: 'Fries', course: 1 }])
    const none = await call('expoA', 'POST', `/expo/orders/${empty.id}/fire`, { course: 3 })
    expect(none.statusCode).toBe(409)
    expect(none.json().error.code).toBe('NO_ITEMS')
    expect((await prisma.order.findUniqueOrThrow({ where: { id: empty.id } })).status).toBe('received')
  })
})

// ─── BOH-03: retiring a station ──────────────────────────────────────────────

describe('station delete (BOH-03)', () => {
  it('is refused while a menu item routes there, and allowed once it is moved', async () => {
    const pass = (await prisma.station.create({ data: { conceptId: conceptA, name: 'Pass' } })).id
    const salad = await prisma.menuItem.create({ data: { conceptId: conceptA, categoryId: categoryA, name: 'Salad', priceCents: 60_000, stationId: pass } })

    const res = await call('ceoA', 'DELETE', `/stations/${pass}`)
    expect(res.statusCode).toBe(409)
    expect(res.json().error.code).toBe('STATION_IN_USE')
    expect(res.json().error.details).toMatchObject({ menuItems: 1, recipeSteps: 0, openTickets: 0 })
    expect((await prisma.station.findUniqueOrThrow({ where: { id: pass } })).deletedAt).toBeNull()

    await prisma.menuItem.update({ where: { id: salad.id }, data: { stationId: fryA } })
    expect((await call('ceoA', 'DELETE', `/stations/${pass}`)).statusCode).toBe(204)
    expect((await prisma.station.findUniqueOrThrow({ where: { id: pass } })).deletedAt).not.toBeNull()
  })

  it('is refused while a recipe step or an open ticket routes there', async () => {
    const wok = (await prisma.station.create({ data: { conceptId: conceptA, name: 'Wok' } })).id
    const noodles = await prisma.menuItem.create({ data: { conceptId: conceptA, categoryId: categoryA, name: 'Noodles', priceCents: 90_000 } })
    const recipe = await prisma.recipe.create({
      data: { kind: 'plate', menuItemId: noodles.id, recipeSteps: { create: [{ phase: 'service_cook', stationId: wok, instruction: 'Toss', dependsOnIds: [] }] } },
    })
    const r1 = await call('ceoA', 'DELETE', `/stations/${wok}`)
    expect(r1.statusCode).toBe(409)
    expect(r1.json().error.details).toMatchObject({ recipeSteps: 1 })

    await prisma.recipeStep.updateMany({ where: { recipeId: recipe.id }, data: { stationId: grillA } })
    const o = await order([{ name: 'Leftover ticket', stationId: wok }])
    const r2 = await call('ceoA', 'DELETE', `/stations/${wok}`)
    expect(r2.statusCode).toBe(409)
    expect(r2.json().error.details).toMatchObject({ openTickets: 1 })

    await prisma.orderItem.updateMany({ where: { orderId: o.id }, data: { status: 'bumped' } })
    expect((await call('ceoA', 'DELETE', `/stations/${wok}`)).statusCode).toBe(204)
  })

  it('company B cannot delete company A’s station', async () => {
    const spare = (await prisma.station.create({ data: { conceptId: conceptA, name: 'Spare' } })).id
    expect((await call('ceoB', 'DELETE', `/stations/${spare}`)).statusCode).toBe(404)
    expect((await prisma.station.findUniqueOrThrow({ where: { id: spare } })).deletedAt).toBeNull()
  })

  it('expo fire reports a line routed to a retired station as unrouted', async () => {
    const old = (await prisma.station.create({ data: { conceptId: conceptA, name: 'Old Line', deletedAt: new Date(), isActive: false } })).id
    const o = await order([{ name: 'Pulao', stationId: old }, { menuItemId: friesId, name: 'Fries' }])
    const res = await call('expoA', 'POST', `/expo/orders/${o.id}/fire`, {})
    expect(res.statusCode).toBe(200)
    const pulao = o.items.find((i) => i.name === 'Pulao')!
    expect(res.json().unroutedItems).toEqual([{ id: pulao.id, name: 'Pulao', reason: 'station_retired' }])
  })
})

// ─── BOH-07: waste cost is the server's ──────────────────────────────────────

describe('waste log cost (BOH-07)', () => {
  let beef: string
  beforeAll(async () => {
    beef = (await prisma.inventoryItem.create({ data: { name: 'Beef mince', unit: 'kg', currentStock: 10, unitCostCents: 180_000, tenantId: tenantA } })).id
  })

  it('a typed cost does not dodge the photo rule', async () => {
    const res = await call('chefA', 'POST', `/inventory/${beef}/waste`, { quantity: 5, unit: 'kg', reason: 'spoilage', estimatedCostCents: 100 })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('PHOTO_REQUIRED')
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: beef } })).currentStock).toBe(10)
  })

  it('records and books the real value (5 kg × PKR 1,800 = PKR 9,000) in the item’s company', async () => {
    const res = await call('chefA', 'POST', `/inventory/${beef}/waste`, { quantity: 5, unit: 'kg', reason: 'spoilage', estimatedCostCents: 100, photoUrl: PHOTO })
    expect(res.statusCode).toBe(201)
    expect(res.json().estimatedCostCents).toBe(900_000)

    const je = await waitFor(() => entry(tenantA, `inventory.waste:${res.json().id}`), (v) => v != null)
    expect(je).not.toBeNull()
    expect(je!.lines.map((l) => [l.type, l.account.code, l.amountCents]).sort()).toEqual([
      ['credit', '1210', 900_000],
      ['debit', '5040', 900_000],
    ])
    expect(je!.lines.every((l) => l.account.tenantId === tenantA)).toBe(true)
    expect(await prisma.journalEntry.count({ where: { tenantId: tenantB, reference: `inventory.waste:${res.json().id}` } })).toBe(0)
  })

  it('small waste under the threshold needs no photo and is valued by the server', async () => {
    const res = await call('chefA', 'POST', `/inventory/${beef}/waste`, { quantity: 0.1, unit: 'kg', reason: 'over_prep', estimatedCostCents: 999_999 })
    expect(res.statusCode).toBe(201)
    expect(res.json().estimatedCostCents).toBe(18_000)
  })

  it('company B cannot log waste on company A’s item', async () => {
    await mkUser('chefB', 'boh_management', tenantB)
    const res = await call('chefB', 'POST', `/inventory/${beef}/waste`, { quantity: 0.1, unit: 'kg', reason: 'spoilage', photoUrl: PHOTO })
    expect(res.statusCode).toBe(404)
  })
})

// ─── BOH-08: food-safety breach reaches its company's inbox ──────────────────

describe('food-safety breach flag (BOH-08)', () => {
  it('is stamped with the unit’s company and shows in that inbox only', async () => {
    const freezer = await prisma.foodSafetyUnit.create({ data: { tenantId: tenantA, name: 'Freezer', kind: 'freezer', minC: null, maxC: -18 } })
    const res = await call('cookA', 'POST', '/food-safety/temperatures', { unitId: freezer.id, readingC: -9, correctiveAction: 'moved stock to backup freezer' })
    expect(res.statusCode).toBe(201)

    const flag = await prisma.exceptionFlag.findFirst({ where: { kind: 'food_safety_temperature', entityId: res.json().id } })
    expect(flag).not.toBeNull()
    expect(flag!.tenantId).toBe(tenantA)
    expect(flag!.entityType).toBe('TemperatureLog')
    expect(flag!.severity).toBe('high')

    const inboxA = (await call('ceoA', 'GET', '/crosschecks/exceptions')).json() as Array<{ id: string }>
    expect(inboxA.some((f) => f.id === flag!.id)).toBe(true)
    const inboxB = (await call('ceoB', 'GET', '/crosschecks/exceptions')).json() as Array<{ id: string }>
    expect(inboxB.some((f) => f.id === flag!.id)).toBe(false)
  })

  it('company B cannot log a reading on company A’s unit', async () => {
    const chiller = await prisma.foodSafetyUnit.create({ data: { tenantId: tenantA, name: 'Chiller', kind: 'fridge', minC: 0, maxC: 5 } })
    const res = await call('cookB', 'POST', '/food-safety/temperatures', { unitId: chiller.id, readingC: 9, correctiveAction: 'x' })
    expect(res.statusCode).toBe(404)
    expect(await prisma.temperatureLog.count({ where: { unitId: chiller.id } })).toBe(0)
  })
})

// ─── BOH-12: stock counts reach the ledger ───────────────────────────────────

describe('stock-count adjustment posting (BOH-12)', () => {
  it('a shortage posts Dr 5050 / Cr 1210 at moving-average cost, in the count’s company', async () => {
    const bun = await prisma.inventoryItem.create({ data: { name: 'Potato bun', unit: 'pcs', currentStock: 35, unitCostCents: 6_000, tenantId: tenantA } })
    const res = await call('chefA', 'POST', '/crosschecks/physical-counts', { lines: [{ inventoryItemId: bun.id, physicalQty: 30, reason: 'end of day count' }] })
    expect(res.statusCode).toBe(201)
    expect(res.json().ledger).toMatchObject({ posted: true })
    expect(res.json().lines[0]).toMatchObject({ systemQty: 35, physicalQty: 30 })
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: bun.id } })).currentStock).toBe(30)

    const je = await entry(tenantA, `inventory.count:${res.json().id}`)
    expect(je).not.toBeNull()
    expect(je!.lines.map((l) => [l.type, l.account.code, l.amountCents]).sort()).toEqual([
      ['credit', '1210', 30_000],
      ['debit', '5050', 30_000],
    ])
    expect(je!.lines.every((l) => l.account.tenantId === tenantA)).toBe(true)

    // Idempotent on the count id.
    expect((await postStockCount(res.json().id)).posted).toBe(false)
    expect(await prisma.journalEntry.count({ where: { reference: `inventory.count:${res.json().id}` } })).toBe(1)
  })

  it('a surplus posts the other way, and a mixed count nets correctly', async () => {
    const milk = await prisma.inventoryItem.create({ data: { name: 'Milk', unit: 'litres', currentStock: 10, unitCostCents: 25_000, tenantId: tenantA } })
    const eggs = await prisma.inventoryItem.create({ data: { name: 'Eggs', unit: 'pcs', currentStock: 100, unitCostCents: 3_000, tenantId: tenantA } })
    const res = await call('chefA', 'POST', '/crosschecks/physical-counts', {
      lines: [{ inventoryItemId: milk.id, physicalQty: 12 }, { inventoryItemId: eggs.id, physicalQty: 90 }],
    })
    expect(res.statusCode).toBe(201)
    const je = await entry(tenantA, `inventory.count:${res.json().id}`)
    const sum = (type: string, code: string) => je!.lines.filter((l) => l.type === type && l.account.code === code).reduce((s, l) => s + l.amountCents, 0)
    expect(sum('debit', '1210')).toBe(50_000)   // 2 L milk over
    expect(sum('credit', '5050')).toBe(50_000)
    expect(sum('debit', '5050')).toBe(30_000)   // 10 eggs short
    expect(sum('credit', '1210')).toBe(30_000)
    const debits = je!.lines.filter((l) => l.type === 'debit').reduce((s, l) => s + l.amountCents, 0)
    const credits = je!.lines.filter((l) => l.type === 'credit').reduce((s, l) => s + l.amountCents, 0)
    expect(debits).toBe(credits)
  })

  it('a count that matches the system posts nothing', async () => {
    const salt = await prisma.inventoryItem.create({ data: { name: 'Salt', unit: 'kg', currentStock: 4, unitCostCents: 5_000, tenantId: tenantA } })
    const res = await call('chefA', 'POST', '/crosschecks/physical-counts', { lines: [{ inventoryItemId: salt.id, physicalQty: 4 }] })
    expect(res.statusCode).toBe(201)
    expect(res.json().ledger).toMatchObject({ posted: false, reason: 'no_variance' })
    expect(await prisma.journalEntry.count({ where: { reference: `inventory.count:${res.json().id}` } })).toBe(0)
  })

  it('company B cannot count company A’s item, and nothing posts in either company', async () => {
    const oil = await prisma.inventoryItem.create({ data: { name: 'Oil', unit: 'litres', currentStock: 20, unitCostCents: 50_000, tenantId: tenantA } })
    const before = await prisma.journalEntry.count({ where: { reference: { startsWith: 'inventory.count:' } } })
    const res = await call('ceoB', 'POST', '/crosschecks/physical-counts', { lines: [{ inventoryItemId: oil.id, physicalQty: 1 }] })
    expect(res.statusCode).toBe(404)
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: oil.id } })).currentStock).toBe(20)
    expect(await prisma.journalEntry.count({ where: { reference: { startsWith: 'inventory.count:' } } })).toBe(before)
  })
})

// ─── BOOKS-02: finance reaches the exceptions inbox ──────────────────────────

describe('exceptions inbox for finance (BOOKS-02)', () => {
  let flagA: string
  let flagB: string
  beforeAll(async () => {
    flagA = (await prisma.exceptionFlag.create({ data: { tenantId: tenantA, kind: 'cash_variance', severity: 'high', title: 'Drawer short', description: 'A' } })).id
    flagB = (await prisma.exceptionFlag.create({ data: { tenantId: tenantB, kind: 'cash_variance', severity: 'high', title: 'Drawer short', description: 'B' } })).id
  })

  it('finance can read the inbox and stats, own company only', async () => {
    const list = await call('financeA', 'GET', '/crosschecks/exceptions')
    expect(list.statusCode).toBe(200)
    const ids = (list.json() as Array<{ id: string; tenantId: string }>).map((f) => f.id)
    expect(ids).toContain(flagA)
    expect(ids).not.toContain(flagB)
    expect((list.json() as Array<{ tenantId: string }>).every((f) => f.tenantId === tenantA)).toBe(true)

    const stats = await call('financeA', 'GET', '/crosschecks/exceptions/stats')
    expect(stats.statusCode).toBe(200)
    expect(stats.json().open).toBeGreaterThanOrEqual(1)
  })

  it('finance can acknowledge and resolve its company’s flags; another company’s are 404', async () => {
    expect((await call('financeA', 'PATCH', `/crosschecks/exceptions/${flagB}/acknowledge`)).statusCode).toBe(404)
    expect((await call('financeA', 'PATCH', `/crosschecks/exceptions/${flagB}/resolve`, { resolution: 'x' })).statusCode).toBe(404)
    expect((await prisma.exceptionFlag.findUniqueOrThrow({ where: { id: flagB } })).status).toBe('open')

    expect((await call('financeA', 'PATCH', `/crosschecks/exceptions/${flagA}/acknowledge`)).statusCode).toBe(204)
    expect((await call('financeA', 'PATCH', `/crosschecks/exceptions/${flagA}/resolve`, { resolution: 'counted the safe — float miskeyed' })).statusCode).toBe(204)
    expect((await prisma.exceptionFlag.findUniqueOrThrow({ where: { id: flagA } })).status).toBe('resolved')
  })

  it('dismissing stays CEO-only, and the kitchen still cannot open the inbox', async () => {
    expect((await call('financeB', 'DELETE', `/crosschecks/exceptions/${flagB}`)).statusCode).toBe(403)
    expect((await call('cookA', 'GET', '/crosschecks/exceptions')).statusCode).toBe(403)
  })
})
