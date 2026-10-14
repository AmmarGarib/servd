// Integration pass 2 — orders and kitchen (stream OK2).
//
//   NEEDS 5 (O-RV-3) pre-orders: an order scheduled beyond the prep window
//     (PRE_ORDER_PREP_MS, 60 min) stays off expo's awaiting-fire / in-progress
//     columns (listed under `upcoming`), off the station queues and loads, out
//     of rider dispatch and out of the pacing worker. ingestOrder takes no
//     stock for it; the release worker (per company, idempotent) takes it at
//     scheduledFor − window, and expo firing it early releases it on the spot.
//     The storefront stores is_pre_order / scheduled_for only for a time that
//     is really in the future.
//   NEEDS 16 (K-RV-01/02) course pacing: POST /orders/:id/fire-course on the
//     FIRST course fires only the lines due now and returns the rest as
//     `paced`; `fireAll` is managers + expediter only (403
//     FIRE_ALL_NOT_ALLOWED), audited with the ORDER's company; the first
//     course of an order expo has not fired is refused (409 FIRE_FROM_EXPO);
//     a till sale paid after its creation-time schedule expired is
//     re-anchored by the pacing worker, not fired all at once.
//
// Two companies throughout: B never sees, fires or releases A's orders.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import jwt from 'jsonwebtoken'
import type { OrderDTO } from '@servd/types'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError, errorResponse } from '../src/lib/errors.js'
import { invalidateSetupCache } from '../src/lib/setup-config.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { addLotTx, fifoCutoverKey } from '../src/lib/stockLedger.js'
import {
  ingestOrder, processCoursePacingTick, updateOrderStatus, releaseDuePreOrders,
  PRE_ORDER_PREP_MS, PRE_ORDER_RELEASE,
} from '../src/modules/orders/service.js'
import { createPosOrder, processPayment } from '../src/modules/pos/service.js'
import { expoRoutes } from '../src/modules/expo/routes.js'
import { orderCourseRoutes } from '../src/modules/orders/routes.js'
import { kdsRoutes } from '../src/modules/kds/routes.js'
import { storefrontRoutes } from '../src/modules/storefront/routes.js'
import { runDispatchSweep } from '../src/workers/riderDispatch.js'
import { runPreOrderReleaseTick } from '../src/workers/preOrderRelease.js'

const MIN = 60_000
let app: FastifyInstance
let tenantA: string
let tenantB: string
let conceptA: string
let conceptB: string
let slugA: string
let burgerId: string
let friesId: string
let grillA: string
let beefId: string
let kebabB: string
let naanB: string
let adminA: string
let shiftId: string
const tok: Record<string, string> = {}

function dto(items: Array<{ id: string; name: string; course?: number }>, extra: Partial<OrderDTO> = {}): OrderDTO {
  return {
    source: 'servd',
    external_id: `direct-${crypto.randomUUID()}`,
    concept_id: conceptA,
    placed_at: new Date().toISOString(),
    customer_id: null,
    customer_name: 'Guest',
    loyalty_points_earned: null,
    delivery_notes: null,
    estimated_pickup: null,
    fulfilment_type: 'takeout',
    items: items.map((i) => ({ externalItemId: i.id, menuItemId: i.id, name: i.name, quantity: 1, unitPriceCents: 50_000, modifiers: [], course: i.course })),
    payment: { provider: null, amountCents: 50_000 * items.length, status: 'pending' },
    ...extra,
  }
}
const preOrder = (inMs: number, extra: Partial<OrderDTO> = {}) =>
  dto([{ id: burgerId, name: 'Classic' }, { id: friesId, name: 'Fries' }], {
    scheduled_for: new Date(Date.now() + inMs).toISOString(), is_pre_order: true, ...extra,
  })

const call = (who: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as never, headers: { authorization: `Bearer ${tok[who]}` } })
const lines = async (orderId: string) => {
  const rows = await prisma.orderItem.findMany({ where: { orderId } })
  return Object.fromEntries(rows.map((r) => [r.name, r]))
}
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms))
const beef = async () => Number((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: beefId } })).currentStock)
const depleted = (orderId: string) => prisma.auditLog.count({ where: { entity: 'Order', entityId: orderId, action: 'stock.sale_deplete' } })
const releases = (orderId: string) => prisma.auditLog.findMany({ where: { entity: 'Order', entityId: orderId, action: PRE_ORDER_RELEASE } })

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'IP2 O A', slug: 'ip2-o-a' } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'IP2 O B', slug: 'ip2-o-b' } })).id
  await ensureChartOfAccounts(tenantA)
  slugA = 'ip2-o-flipd'
  conceptA = (await prisma.concept.create({
    data: { name: 'O Flipd', slug: slugA, type: 'restaurant', tenantId: tenantA, taxRateCash: 0, taxRateCard: 0, isActive: true },
  })).id
  conceptB = (await prisma.concept.create({
    data: { name: 'O Viva', slug: 'ip2-o-viva', type: 'restaurant', tenantId: tenantB, taxRateCash: 0, taxRateCard: 0, isActive: true },
  })).id
  const cat = (await prisma.category.create({ data: { conceptId: conceptA, name: 'Mains' } })).id
  grillA = (await prisma.station.create({ data: { conceptId: conceptA, name: 'Grill', displayOrder: 1 } })).id
  const fry = (await prisma.station.create({ data: { conceptId: conceptA, name: 'Fry', displayOrder: 2 } })).id
  // Company A's stock is on FIFO lots (finance wave B): cut over, 100 kg of beef in one lot.
  await prisma.setting.create({ data: { key: fifoCutoverKey(tenantA), value: new Date(Date.now() - 30 * 86_400_000).toISOString() } })
  beefId = (await prisma.inventoryItem.create({ data: { tenantId: tenantA, name: 'Beef', unit: 'kg' } })).id
  await prisma.$transaction((tx) => addLotTx(tx, {
    tenantId: tenantA, inventoryItemId: beefId, qty: 100, unitCostCents: 150_000, kind: 'count_gain', lotSourceType: 'count_gain',
    lotSourceId: 'ip2-beef', movementSourceType: 'test', movementSourceId: 'ip2-beef', receivedAt: new Date(Date.now() - 86_400_000),
  }))
  const menu = async (name: string, stationId: string, labor: number, withBeef = false) => {
    const id = (await prisma.menuItem.create({ data: { conceptId: conceptA, categoryId: cat, name, priceCents: 50_000, stationId } })).id
    await prisma.recipe.create({
      data: {
        kind: 'plate', menuItemId: id, laborMinutes: labor,
        ...(withBeef && { ingredients: { create: [{ inventoryItemId: beefId, quantity: 1, unit: 'kg' }] } }),
      },
    })
    return id
  }
  burgerId = await menu('Classic', grillA, 8, true)
  friesId = await menu('Fries', fry, 3)

  const catB = (await prisma.category.create({ data: { conceptId: conceptB, name: 'Mains B' } })).id
  const grillB = (await prisma.station.create({ data: { conceptId: conceptB, name: 'Grill B', displayOrder: 1 } })).id
  const mkB = async (name: string, labor: number) => {
    const id = (await prisma.menuItem.create({ data: { conceptId: conceptB, categoryId: catB, name, priceCents: 50_000, stationId: grillB } })).id
    await prisma.recipe.create({ data: { kind: 'plate', menuItemId: id, laborMinutes: labor } })
    return id
  }
  kebabB = await mkB('Kebab', 8)
  naanB = await mkB('Naan', 3)

  const mk = async (key: string, tenantId: string, role: string, members: string[] = []) => {
    const u = await prisma.user.create({
      data: { name: key, email: `ip2-o-${key}@test.local`, password: 'x', role, isActive: true, accountStatus: 'active', tenantId } as never,
    })
    for (const t of members) await prisma.tenantMember.create({ data: { userId: u.id, tenantId: t } })
    tok[key] = (issueStaffSession(u) as { accessToken: string }).accessToken
    return u.id
  }
  adminA = await mk('adminA', tenantA, 'admin')
  await mk('expoA', tenantA, 'expediter')
  await mk('cookA', tenantA, 'kitchen')
  await mk('cashierA', tenantA, 'cashier')
  await mk('mgrA', tenantA, 'boh_management')
  await mk('expoB', tenantB, 'expediter')
  await mk('mgrB', tenantB, 'boh_management')
  // A manager in both companies, A active.
  await mk('both', tenantA, 'boh_management', [tenantA, tenantB])
  shiftId = (await prisma.shift.create({ data: { userId: adminA, openingFloatCents: 0, status: 'open', tenantId: tenantA } })).id

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(expoRoutes, { prefix: '/expo' })
  await app.register(orderCourseRoutes, { prefix: '/orders' })
  await app.register(kdsRoutes, { prefix: '/kds' })
  await app.register(storefrontRoutes, { prefix: '/storefront' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  invalidateSetupCache()
  await app?.close()
})

type FireResp = { fired: number; course: number; paced: Array<{ id: string; name: string; scheduledFireAt: string }> }

// ─── NEEDS 16 — course pacing outside expo's own route ───────────────────────

describe('NEEDS 16 — POST /orders/:id/fire-course paces the first course', () => {
  it('K-RV-01: a line cook\'s fire-course {course:1} after expo Fire leaves the paced dish pending (200 with `paced`)', async () => {
    const { order } = await ingestOrder(dto([{ id: burgerId, name: 'Classic' }, { id: friesId, name: 'Fries' }]))
    await settle()
    expect((await call('expoA', 'POST', `/expo/orders/${order.id}/fire`, {})).json()).toMatchObject({ fired: 1 })

    const res = await call('cookA', 'POST', `/orders/${order.id}/fire-course`, { course: 1 })
    expect(res.statusCode).toBe(200)
    const body = res.json() as FireResp
    expect(body.fired).toBe(0)
    expect(body.paced.map((p) => p.name)).toEqual(['Fries'])
    expect((await lines(order.id)).Fries!.status).toBe('pending')
    expect(await prisma.auditLog.count({ where: { entity: 'Order', entityId: order.id, action: 'expo.fire_all' } })).toBe(0)
  })

  it('fireAll: a line cook and a cashier get 403 FIRE_ALL_NOT_ALLOWED; the expediter fires it, audited with the order\'s company', async () => {
    const { order } = await ingestOrder(dto([{ id: burgerId, name: 'Classic' }, { id: friesId, name: 'Fries' }]))
    await settle()
    await call('expoA', 'POST', `/expo/orders/${order.id}/fire`, {})
    for (const who of ['cookA', 'cashierA']) {
      const r = await call(who, 'POST', `/orders/${order.id}/fire-course`, { course: 1, fireAll: true })
      expect(r.statusCode).toBe(403)
      expect(r.json().error.code).toBe('FIRE_ALL_NOT_ALLOWED')
    }
    expect((await lines(order.id)).Fries!.status).toBe('pending')

    const all = await call('expoA', 'POST', `/orders/${order.id}/fire-course`, { course: 1, fireAll: true })
    expect(all.statusCode).toBe(200)
    expect(all.json()).toMatchObject({ fired: 1, paced: [] })
    expect((await lines(order.id)).Fries!.status).toBe('preparing')
    const rows = await prisma.auditLog.findMany({ where: { entity: 'Order', entityId: order.id, action: 'expo.fire_all' } })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.tenantId).toBe(tenantA)
  })

  it('fireAll by an operator in both companies (A active) on B\'s order is audited to B; company B alone gets 404 on A\'s order', async () => {
    const d = dto([{ id: kebabB, name: 'Kebab' }, { id: naanB, name: 'Naan' }])
    const { order } = await ingestOrder({ ...d, concept_id: conceptB })
    await settle()
    expect((await call('expoB', 'POST', `/expo/orders/${order.id}/fire`, {})).json()).toMatchObject({ fired: 1 })
    const res = await call('both', 'POST', `/orders/${order.id}/fire-course`, { course: 1, fireAll: true })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ fired: 1 })
    const rows = await prisma.auditLog.findMany({ where: { entity: 'Order', entityId: order.id, action: 'expo.fire_all' } })
    expect(rows.map((r) => r.tenantId)).toEqual([tenantB])

    const { order: a } = await ingestOrder(dto([{ id: burgerId, name: 'Classic' }, { id: friesId, name: 'Fries' }]))
    await settle()
    await call('expoA', 'POST', `/expo/orders/${a.id}/fire`, {})
    expect((await call('mgrB', 'POST', `/orders/${a.id}/fire-course`, { course: 1, fireAll: true })).statusCode).toBe(404)
    expect((await call('expoB', 'POST', `/orders/${a.id}/fire-course`, { course: 1 })).statusCode).toBe(404)
    expect((await lines(a.id)).Fries!.status).toBe('pending')
  })

  it('the first course of an order expo has not fired is refused (409 FIRE_FROM_EXPO); nothing fires', async () => {
    const { order } = await ingestOrder(dto([{ id: burgerId, name: 'Classic' }, { id: friesId, name: 'Fries' }]))
    await settle()
    const res = await call('expoA', 'POST', `/orders/${order.id}/fire-course`, { course: 1 })
    expect(res.statusCode).toBe(409)
    expect(res.json().error.code).toBe('FIRE_FROM_EXPO')
    const l = await lines(order.id)
    expect(l.Classic!.status).toBe('pending')
    expect(l.Fries!.status).toBe('pending')
  })

  it('a later course still fires whole', async () => {
    const { order } = await ingestOrder(dto([
      { id: friesId, name: 'Fries', course: 1 },
      { id: burgerId, name: 'Classic', course: 2 },
    ]))
    await settle()
    await call('expoA', 'POST', `/expo/orders/${order.id}/fire`, {})
    expect((await lines(order.id)).Classic!.status).toBe('pending')
    const r = await call('cookA', 'POST', `/orders/${order.id}/fire-course`, { course: 2 })
    expect(r.statusCode).toBe(200)
    expect(r.json()).toMatchObject({ fired: 1, paced: [] })
    expect((await lines(order.id)).Classic!.status).toBe('preparing')
    // Nothing left at course 2.
    expect((await call('cookA', 'POST', `/orders/${order.id}/fire-course`, { course: 2 })).statusCode).toBe(404)
  })

  it('a paid till sale not fired yet: fire-course re-anchors, fires the longest dish, paces the rest', async () => {
    const o = await createPosOrder({
      conceptId: conceptA, staffId: adminA, staffRole: 'admin', shiftId, paymentMethod: 'cash',
      items: [
        { menuItemId: burgerId, name: 'Classic', quantity: 1, unitPriceCents: 50_000, modifiers: [] },
        { menuItemId: friesId, name: 'Fries', quantity: 1, unitPriceCents: 50_000, modifiers: [] },
      ],
    })
    await settle()
    await prisma.orderItem.updateMany({ where: { orderId: o.id }, data: { scheduledFireAt: new Date(Date.now() - 600_000) } })
    await processPayment({ orderId: o.id, shiftId, payments: [{ method: 'cash', amountCents: o.totalCents, tenderedCents: o.totalCents }] })
    await settle()
    const res = await call('cookA', 'POST', `/orders/${o.id}/fire-course`, { course: 1 })
    expect(res.statusCode).toBe(200)
    const body = res.json() as FireResp
    expect(body.fired).toBe(1)
    expect(body.paced.map((p) => p.name)).toEqual(['Fries'])
    const l = await lines(o.id)
    expect(l.Classic!.status).toBe('preparing')
    expect(l.Fries!.scheduledFireAt!.getTime()).toBeGreaterThan(Date.now() + 4 * MIN)
  })

  it('K-RV-02: a till sale paid after its creation-time schedule expired is re-anchored by the worker, not fired all at once', async () => {
    const o = await createPosOrder({
      conceptId: conceptA, staffId: adminA, staffRole: 'admin', shiftId, paymentMethod: 'cash',
      items: [
        { menuItemId: burgerId, name: 'Classic', quantity: 1, unitPriceCents: 50_000, modifiers: [] },
        { menuItemId: friesId, name: 'Fries', quantity: 1, unitPriceCents: 50_000, modifiers: [] },
      ],
    })
    await settle()
    await prisma.orderItem.updateMany({ where: { orderId: o.id }, data: { scheduledFireAt: new Date(Date.now() - 600_000) } })
    await processPayment({ orderId: o.id, shiftId, payments: [{ method: 'cash', amountCents: o.totalCents, tenderedCents: o.totalCents }] })
    await settle()
    await processCoursePacingTick()
    let l = await lines(o.id)
    expect(l.Classic!.status).toBe('preparing')
    expect(l.Fries!.status).toBe('pending')
    expect(l.Fries!.scheduledFireAt!.getTime()).toBeGreaterThan(Date.now() + 4 * MIN)

    // Its own time comes: the worker fires it (no second re-anchor — the course has started).
    await prisma.orderItem.update({ where: { id: l.Fries!.id }, data: { scheduledFireAt: new Date(Date.now() - 1000) } })
    await processCoursePacingTick()
    l = await lines(o.id)
    expect(l.Fries!.status).toBe('preparing')
  })
})

// ─── NEEDS 5 — pre-orders held until their prep window ───────────────────────

type Queue = {
  awaitingFire: Array<{ id: string }>
  inProgress: Array<{ id: string }>
  upcoming: Array<{ id: string; scheduledFor: string; kitchenAt: string }>
  stations: Array<{ id: string; activeItems: number }>
}

describe('NEEDS 5 — a pre-order is held off the kitchen until scheduledFor − the prep window', () => {
  it('held at creation: no stock taken; not on awaiting fire, station queues or station load — listed under upcoming; B sees none of it', async () => {
    const stock0 = await beef()
    const loadBefore = ((await call('expoA', 'GET', '/expo/queue')).json() as Queue).stations.find((s) => s.id === grillA)!.activeItems
    const { order } = await ingestOrder(preOrder(3 * 60 * MIN))
    await settle()
    expect(order.isPreOrder).toBe(true)
    expect(await depleted(order.id)).toBe(0)
    expect(await beef()).toBe(stock0)

    const q = (await call('expoA', 'GET', '/expo/queue')).json() as Queue
    expect(q.awaitingFire.map((o) => o.id)).not.toContain(order.id)
    const up = q.upcoming.find((o) => o.id === order.id)
    expect(up).toBeTruthy()
    expect(new Date(up!.kitchenAt).getTime()).toBe(new Date(up!.scheduledFor).getTime() - PRE_ORDER_PREP_MS)
    expect(q.stations.find((s) => s.id === grillA)!.activeItems).toBe(loadBefore)

    const station = (await call('cookA', 'GET', `/expo/station/${grillA}/queue`)).json() as { legacy: Array<{ order: { id: string } }> }
    expect(station.legacy.map((l) => l.order.id)).not.toContain(order.id)
    const kds = (await call('cookA', 'GET', '/kds/my-stations')).json() as { stations: Array<{ id: string; liveLoad: number }> }
    expect(kds.stations.find((s) => s.id === grillA)!.liveLoad).toBe(loadBefore)

    const qB = (await call('expoB', 'GET', '/expo/queue')).json() as Queue
    expect([...qB.upcoming, ...qB.awaitingFire].map((o) => o.id)).not.toContain(order.id)
  })

  it('the release worker takes the stock once, at the window, for the order\'s own company only', async () => {
    const stock0 = await beef()
    const { order } = await ingestOrder(preOrder(3 * 60 * MIN))
    await settle()
    // Before the window: nothing.
    expect(await releaseDuePreOrders(tenantA)).not.toContain(order.id)
    // Company B's pass never touches A's order.
    const atWindow = new Date(order.scheduledFor!.getTime() - PRE_ORDER_PREP_MS + MIN)
    expect(await releaseDuePreOrders(tenantB, atWindow)).toEqual([])
    expect(await releases(order.id)).toHaveLength(0)

    expect(await releaseDuePreOrders(tenantA, atWindow)).toContain(order.id)
    await settle()
    const stock1 = await beef()
    expect(stock1).toBeLessThan(stock0)
    const rel = await releases(order.id)
    expect(rel).toHaveLength(1)
    expect(rel[0]!.tenantId).toBe(tenantA)
    expect(rel[0]!.metadata).toMatchObject({ via: 'worker' })

    // Idempotent: a second pass (or a second box) does nothing.
    expect(await releaseDuePreOrders(tenantA, atWindow)).toEqual([])
    expect(await runPreOrderReleaseTick(atWindow)).toBe(0)
    expect(await releases(order.id)).toHaveLength(1)
    expect(await beef()).toBe(stock1)
  })

  it('inside the window it shows on expo; a cancelled pre-order is never released', async () => {
    const { order } = await ingestOrder(preOrder(3 * 60 * MIN))
    await settle()
    // Move its time into the window (as if the clock had run on).
    await prisma.order.update({ where: { id: order.id }, data: { scheduledFor: new Date(Date.now() + 30 * MIN) } })
    const q = (await call('expoA', 'GET', '/expo/queue')).json() as Queue
    expect(q.awaitingFire.map((o) => o.id)).toContain(order.id)
    expect(q.upcoming.map((o) => o.id)).not.toContain(order.id)

    const { order: gone } = await ingestOrder(preOrder(3 * 60 * MIN))
    await prisma.order.update({ where: { id: gone.id }, data: { status: 'cancelled' } })
    const at = new Date(gone.scheduledFor!.getTime() - PRE_ORDER_PREP_MS + MIN)
    expect(await releaseDuePreOrders(tenantA, at)).not.toContain(gone.id)
    expect(await depleted(gone.id)).toBe(0)
  })

  it('an order whose time is already inside the window is not held: stock at creation, never "released"', async () => {
    const stock0 = await beef()
    const { order } = await ingestOrder(preOrder(30 * MIN))
    await settle()
    expect(await depleted(order.id)).toBe(1)
    expect(await beef()).toBeLessThan(stock0)
    expect(await releaseDuePreOrders(tenantA, new Date(Date.now() + 10 * MIN))).not.toContain(order.id)
    expect(await releases(order.id)).toHaveLength(0)
  })

  it('expo firing a held pre-order early releases it then (stock once)', async () => {
    const stock0 = await beef()
    const { order } = await ingestOrder(preOrder(5 * 60 * MIN))
    await settle()
    const res = await call('expoA', 'POST', `/expo/orders/${order.id}/fire`, {})
    expect(res.statusCode).toBe(200)
    await settle()
    const stock1 = await beef()
    expect(stock1).toBeLessThan(stock0)
    const rel = await releases(order.id)
    expect(rel).toHaveLength(1)
    expect(rel[0]!.metadata).toMatchObject({ via: 'expo_fire' })
    // Fired early: it now shows in progress, and the worker never re-releases it.
    const q = (await call('expoA', 'GET', '/expo/queue')).json() as Queue
    expect(q.inProgress.map((o) => o.id)).toContain(order.id)
    expect(await releaseDuePreOrders(tenantA, new Date(order.scheduledFor!.getTime() - PRE_ORDER_PREP_MS + MIN))).toEqual([])
    expect(await beef()).toBe(stock1)
  })

  it('the pacing worker does not cook an acknowledged pre-order before its window', async () => {
    const { order } = await ingestOrder(preOrder(3 * 60 * MIN))
    await settle()
    await updateOrderStatus(order.id, 'confirmed')
    await settle()
    await prisma.orderItem.updateMany({ where: { orderId: order.id }, data: { scheduledFireAt: new Date(Date.now() - 600_000) } })
    await processCoursePacingTick()
    let l = await lines(order.id)
    expect(l.Classic!.status).toBe('pending')
    expect(l.Fries!.status).toBe('pending')
    const q = (await call('expoA', 'GET', '/expo/queue')).json() as Queue
    expect(q.inProgress.map((o) => o.id)).not.toContain(order.id)
    expect(q.upcoming.map((o) => o.id)).toContain(order.id)

    // Window opens: the worker re-anchors and starts the longest dish only.
    await prisma.order.update({ where: { id: order.id }, data: { scheduledFor: new Date(Date.now() + 30 * MIN) } })
    await processCoursePacingTick()
    l = await lines(order.id)
    expect(l.Classic!.status).toBe('preparing')
    expect(l.Fries!.status).toBe('pending')
  })

  it('rider dispatch: tomorrow\'s delivery is not offered today; a pre-order placed > 6 h ahead is offered at its time', async () => {
    const rider = await prisma.rider.create({
      data: { tenantId: tenantA, name: 'Rider A', phone: '03001112233', status: 'available', isActive: true },
    })
    const tomorrow = await prisma.order.create({
      data: {
        conceptId: conceptA, source: 'servd', status: 'confirmed', fulfilmentType: 'delivery', totalCents: 100_000,
        scheduledFor: new Date(Date.now() + 20 * 60 * MIN), isPreOrder: true,
      },
    })
    await runDispatchSweep()
    expect((await prisma.order.findUniqueOrThrow({ where: { id: tomorrow.id } })).riderId).toBeNull()

    const placedEarly = await prisma.order.create({
      data: {
        conceptId: conceptA, source: 'servd', status: 'preparing', fulfilmentType: 'delivery', totalCents: 100_000,
        placedAt: new Date(Date.now() - 8 * 60 * MIN), createdAt: new Date(Date.now() - 8 * 60 * MIN),
        scheduledFor: new Date(Date.now() + 20 * MIN), isPreOrder: true,
      },
    })
    await runDispatchSweep()
    expect((await prisma.order.findUniqueOrThrow({ where: { id: placedEarly.id } })).riderId).toBe(rider.id)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: tomorrow.id } })).riderId).toBeNull()
  })

  it('storefront: a past scheduledFor is an order for now, not a pre-order; a future one is held', async () => {
    const c = await prisma.customer.create({
      data: { name: 'Sana', email: 'ip2-o-sana@example.com', phone: '+923001234987', phoneVerifiedAt: new Date() },
    })
    const token = jwt.sign({ sub: c.id, type: 'customer' }, process.env['JWT_SECRET'] as string, { expiresIn: '2h' })
    const post = (scheduledFor: string) => app.inject({
      method: 'POST', url: '/storefront/orders', headers: { authorization: `Bearer ${token}` },
      payload: { conceptSlug: slugA, type: 'pickup', paymentGateway: 'cash', scheduledFor, items: [{ menuItemId: burgerId, quantity: 1, modifiers: [] }] },
    })

    const past = await post(new Date(Date.now() - 10 * MIN).toISOString())
    expect(past.statusCode).toBeLessThan(300)
    const pastId = (past.json() as { id: string }).id
    const pastRow = await prisma.order.findUniqueOrThrow({ where: { id: pastId } })
    expect(pastRow.isPreOrder).toBe(false)
    expect(pastRow.scheduledFor).toBeNull()
    await settle()
    expect(await depleted(pastId)).toBe(1)

    const future = await post(new Date(Date.now() + 3 * 60 * MIN).toISOString())
    expect(future.statusCode).toBeLessThan(300)
    const futureId = (future.json() as { id: string }).id
    const futureRow = await prisma.order.findUniqueOrThrow({ where: { id: futureId } })
    expect(futureRow.isPreOrder).toBe(true)
    expect(futureRow.scheduledFor).not.toBeNull()
    await settle()
    expect(await depleted(futureId)).toBe(0)
  })
})

// ─── OK2 review fixes ────────────────────────────────────────────────────────

describe('OK2 review fixes', () => {
  it('OK2-RV-1: a held pre-order finished early through the status buttons has its stock out by completion; a refund keeps it; the worker never takes it twice', async () => {
    const stock0 = await beef()
    const { order } = await ingestOrder(preOrder(3 * 60 * MIN))
    await settle()
    // Acknowledging it keeps it held.
    await updateOrderStatus(order.id, 'confirmed')
    await settle()
    expect(await depleted(order.id)).toBe(0)
    expect(await beef()).toBe(stock0)
    // Ready before its window: released (stock out), no kitchen notice needed.
    await updateOrderStatus(order.id, 'ready')
    await settle()
    expect(await depleted(order.id)).toBe(1)
    const stock1 = await beef()
    expect(stock1).toBeLessThan(stock0)
    const rel = await releases(order.id)
    expect(rel).toHaveLength(1)
    expect(rel[0]!.metadata).toMatchObject({ via: 'status', status: 'ready' })
    expect(rel[0]!.tenantId).toBe(tenantA)

    await updateOrderStatus(order.id, 'completed')
    await settle()
    // Completion does not take it a second time.
    expect(await depleted(order.id)).toBe(1)
    expect(await beef()).toBe(stock1)
    await prisma.order.update({ where: { id: order.id }, data: { status: 'refunded' } })
    const atWindow = new Date(order.scheduledFor!.getTime() - PRE_ORDER_PREP_MS + MIN)
    expect(await releaseDuePreOrders(tenantA, atWindow)).not.toContain(order.id)
    expect(await depleted(order.id)).toBe(1)
    expect(await releases(order.id)).toHaveLength(1)
    // (Other tests' pre-orders may be released by this pass — the stock taken
    // for THIS order is its one depletion row, checked above.)
  })

  it('OK2-RV-1: completion itself releases a held pre-order that skipped the status hook (stock before COGS)', async () => {
    const stock0 = await beef()
    const { order } = await ingestOrder(preOrder(3 * 60 * MIN))
    await settle()
    // Readied before this release (no release marker) — completion is the backstop.
    await prisma.order.update({ where: { id: order.id }, data: { status: 'ready' } })
    await updateOrderStatus(order.id, 'completed')
    await settle()
    expect(await depleted(order.id)).toBe(1)
    expect(await beef()).toBeLessThan(stock0)
    const rel = await releases(order.id)
    expect(rel).toHaveLength(1)
    expect(rel[0]!.metadata).toMatchObject({ via: 'completion', status: 'completed' })
    // The depletion is recorded no later than the completion claim.
    const claim = await prisma.auditLog.findFirst({ where: { entity: 'Order', entityId: order.id, action: { not: PRE_ORDER_RELEASE }, category: 'order' } })
    const dep = await prisma.auditLog.findFirstOrThrow({ where: { entity: 'Order', entityId: order.id, action: 'stock.sale_deplete' } })
    if (claim) expect(dep.createdAt.getTime()).toBeLessThanOrEqual(claim.createdAt.getTime())
    // The stock came off the lots, as the order's own sale rows.
    const sale = await prisma.stockMovement.findMany({ where: { orderId: order.id, kind: 'sale' } })
    expect(sale.length).toBeGreaterThan(0)
    expect(sale.every((m) => m.tenantId === tenantA && m.inventoryItemId === beefId && m.sourceType === 'order_item.sale')).toBe(true)
    if (claim) expect(Math.max(...sale.map((m) => m.createdAt.getTime()))).toBeLessThanOrEqual(claim.createdAt.getTime())
  })

  it('OK2-RV-1: a held pre-order refunded before this release is still released (stock out) by the worker at its window', async () => {
    const stock0 = await beef()
    const { order } = await ingestOrder(preOrder(3 * 60 * MIN))
    await settle()
    await prisma.order.update({ where: { id: order.id }, data: { status: 'refunded' } })
    const atWindow = new Date(order.scheduledFor!.getTime() - PRE_ORDER_PREP_MS + MIN)
    expect(await releaseDuePreOrders(tenantB, atWindow)).toEqual([])
    expect(await releaseDuePreOrders(tenantA, atWindow)).toContain(order.id)
    await settle()
    expect(await depleted(order.id)).toBe(1)
    expect(await beef()).toBeLessThan(stock0)
    expect((await releases(order.id))[0]!.metadata).toMatchObject({ via: 'worker', status: 'refunded' })
  })

  it('OK2-RV-2: a held pre-order completed early is never sent to the kitchen again at its window', async () => {
    const { order } = await ingestOrder(preOrder(3 * 60 * MIN))
    await settle()
    await updateOrderStatus(order.id, 'confirmed')
    await updateOrderStatus(order.id, 'ready')
    await updateOrderStatus(order.id, 'completed')
    await settle()
    // Its window opens; its paced lines are long due.
    await prisma.order.update({ where: { id: order.id }, data: { scheduledFor: new Date(Date.now() + 30 * MIN) } })
    await prisma.orderItem.updateMany({ where: { orderId: order.id }, data: { scheduledFireAt: new Date(Date.now() - 600_000) } })
    expect(await releaseDuePreOrders(tenantA)).not.toContain(order.id)
    await processCoursePacingTick()
    const l = await lines(order.id)
    for (const n of ['Classic', 'Fries'] as const) {
      expect(l[n]!.status).toBe('pending')
      expect(l[n]!.firedAt).toBeNull()
      expect(l[n]!.scheduledFireAt).toBeNull()   // stale fire time cleared
    }
    expect(await releases(order.id)).toHaveLength(1)
  })

  it('OK2-RV-2: a non-till order marked ready before anything started is not fired by the worker', async () => {
    const { order } = await ingestOrder(dto([{ id: burgerId, name: 'Classic' }, { id: friesId, name: 'Fries' }]))
    await settle()
    await updateOrderStatus(order.id, 'confirmed')
    await updateOrderStatus(order.id, 'ready')
    await prisma.orderItem.updateMany({ where: { orderId: order.id }, data: { scheduledFireAt: new Date(Date.now() - 600_000) } })
    await processCoursePacingTick()
    const l = await lines(order.id)
    expect(l.Classic!.status).toBe('pending')
    expect(l.Fries!.status).toBe('pending')
  })

  it('a held pre-order fired early at expo: its paced dish follows at its own time, not at the window', async () => {
    const { order } = await ingestOrder(preOrder(5 * 60 * MIN))
    await settle()
    expect((await call('expoA', 'POST', `/expo/orders/${order.id}/fire`, {})).statusCode).toBe(200)
    let l = await lines(order.id)
    expect(l.Classic!.status).toBe('preparing')
    expect(l.Fries!.status).toBe('pending')
    await prisma.orderItem.update({ where: { id: l.Fries!.id }, data: { scheduledFireAt: new Date(Date.now() - 1000) } })
    await processCoursePacingTick()
    l = await lines(order.id)
    expect(l.Fries!.status).toBe('preparing')
  })

  it('OK2-RV-5: fire-course on ANY course of a received order is refused (409 FIRE_FROM_EXPO); nothing fires, nothing released', async () => {
    const { order } = await ingestOrder(preOrder(3 * 60 * MIN, {
      items: [
        { externalItemId: friesId, menuItemId: friesId, name: 'Fries', quantity: 1, unitPriceCents: 50_000, modifiers: [], course: 1 },
        { externalItemId: burgerId, menuItemId: burgerId, name: 'Classic', quantity: 1, unitPriceCents: 50_000, modifiers: [], course: 2 },
      ],
    }))
    await settle()
    // A manager (allowed to send a held pre-order early) still may not
    // fire a course of an order expo has not fired; a line cook is refused
    // earlier, PRE_ORDER_HELD (tested below).
    const r = await call('mgrA', 'POST', `/orders/${order.id}/fire-course`, { course: 2 })
    expect(r.statusCode).toBe(409)
    expect(r.json().error.code).toBe('FIRE_FROM_EXPO')
    expect((await lines(order.id)).Classic!.status).toBe('pending')
    expect(await releases(order.id)).toHaveLength(0)
    expect(await depleted(order.id)).toBe(0)
    // Company B: 404, never a hint.
    expect((await call('expoB', 'POST', `/orders/${order.id}/fire-course`, { course: 2 })).statusCode).toBe(404)
  })

  it('OK2-RV-6: /kds/unrouted lists a pre-order placed days ahead once its window opens; B never sees it', async () => {
    const cat = (await prisma.category.findFirstOrThrow({ where: { conceptId: conceptA } })).id
    const soda = (await prisma.menuItem.create({ data: { conceptId: conceptA, categoryId: cat, name: 'Soda', priceCents: 10_000 } })).id
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * MIN)
    const mk = (scheduledFor: Date) => prisma.order.create({
      data: {
        conceptId: conceptA, source: 'servd', status: 'confirmed', fulfilmentType: 'takeout', totalCents: 10_000,
        placedAt: twoDaysAgo, createdAt: twoDaysAgo, scheduledFor, isPreOrder: true,
        items: { create: [{ menuItemId: soda, name: 'Soda', quantity: 1, unitPriceCents: 10_000 }] },
      },
    })
    const due = await mk(new Date(Date.now() + 30 * MIN))
    const later = await mk(new Date(Date.now() + 20 * 60 * MIN))
    const ids = (r: { json: () => unknown }) => (r.json() as { items: Array<{ order: { id: string } }> }).items.map((i) => i.order.id)
    const a = await call('cookA', 'GET', '/kds/unrouted')
    expect(a.statusCode).toBe(200)
    expect(ids(a)).toContain(due.id)
    expect(ids(a)).not.toContain(later.id)
    expect(ids(await call('expoB', 'GET', '/kds/unrouted'))).not.toContain(due.id)
  })
})

describe('a held pre-order goes to the kitchen early only by a manager or the expediter', () => {
  it('a line cook gets 403 PRE_ORDER_HELD from expo Fire and fire-course; nothing is released', async () => {
    const { order } = await ingestOrder(preOrder(5 * 60 * MIN))
    await settle()
    const viaExpo = await call('cookA', 'POST', `/expo/orders/${order.id}/fire`, {})
    expect(viaExpo.statusCode).toBe(403)
    expect(viaExpo.json().error.code).toBe('PRE_ORDER_HELD')
    await updateOrderStatus(order.id, 'confirmed')
    const viaCourse = await call('cookA', 'POST', `/orders/${order.id}/fire-course`, { course: 1 })
    expect(viaCourse.statusCode).toBe(403)
    expect(viaCourse.json().error.code).toBe('PRE_ORDER_HELD')
    expect(await releases(order.id)).toHaveLength(0)
    const l = await lines(order.id)
    expect(l.Classic!.status).toBe('pending')
  })

  it('a manager may send it early (fire-course releases it once); company B cannot see it', async () => {
    const { order } = await ingestOrder(preOrder(5 * 60 * MIN))
    await settle()
    await updateOrderStatus(order.id, 'confirmed')
    expect((await call('mgrB', 'POST', `/orders/${order.id}/fire-course`, { course: 1 })).statusCode).toBe(404)
    const res = await call('mgrA', 'POST', `/orders/${order.id}/fire-course`, { course: 1 })
    expect(res.statusCode).toBe(200)
    expect(await releases(order.id)).toHaveLength(1)
  })

  it('once inside its window the line cook is not blocked', async () => {
    const { order } = await ingestOrder(preOrder(5 * 60 * MIN))
    await settle()
    await prisma.order.update({ where: { id: order.id }, data: { scheduledFor: new Date(Date.now() + 30 * MIN) } })
    expect((await call('cookA', 'POST', `/expo/orders/${order.id}/fire`, {})).statusCode).toBe(200)
  })
})
