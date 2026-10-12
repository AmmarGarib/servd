// Orders / kitchen review follow-ups (2026-10-10, second pass on the audit
// fixes). What this guards:
//   - R1: expo's paid-order and ready columns drop handed-off orders INSIDE the
//     query, so 120+ handed-off till sales (or 60+ handed-off ready orders)
//     can't push a fresh order off the pass. Company-scoped.
//   - R2: the stock only auto-86s a dish when a sale took an ingredient down
//     to zero (never for stock that was already 0 / never counted); the till
//     still sells a dish the STOCK 86'd, but not one a person 86'd; the
//     storefront refuses both.
//   - R3: a paid till sale with nothing to cook (no station, no recipe steps)
//     never joins expo and is not an "unrouted" ticket.
//   - R4: Bump on a recalled line walks it through 'preparing' (the tablet
//     has only Bump); a held line is off the tablet's queue (only
//     ?states=all lists it) and a Bump on it is refused until resumed; the
//     tablet's READY on a paid till sale bumps its fired lines; Reject on one
//     says why not.
//   - R5: only a RETIRED station (and a custom line) falls back to the pass;
//     a step-routed dish with no station stays unrouted until it is fired and
//     is never a bumpable card on the pass or on /kds/unrouted before that.
//   - R6: the back-in-stock list skips a dish a person switched on/off after
//     its auto-86.
//   - R7: the pacing worker never fires a later course, and clears the stale
//     fire time pre-course-pacing rows carry.
//   - R8: hold is refused once the food has left; an ended order's lines are
//     off the station screen.
//   - F1: ingestOrder writes tip_cents in the same insert as the total.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import type { OrderDTO } from '@servd/types'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { invalidateSetupCache } from '../src/lib/setup-config.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import {
  ingestOrder, updateOrderStatus, cancelOrder, processCoursePacingTick, type IngestOrderDTO,
} from '../src/modules/orders/service.js'
import { createPosOrder, processPayment } from '../src/modules/pos/service.js'
import { expoRoutes } from '../src/modules/expo/routes.js'
import { orderRoutes, orderItemRoutes, orderCourseRoutes } from '../src/modules/orders/routes.js'
import { kdsRoutes } from '../src/modules/kds/routes.js'
import { menuRoutes } from '../src/modules/menu/routes.js'

let app: FastifyInstance
let tenantA: string
let tenantB: string
let conceptA: string
let conceptB: string
let grillId: string
let passId: string
let retiredId: string
let burgerId: string
let friesId: string
let sliderId: string
let zingerId: string
let waterId: string
let oldFryId: string
let pattyId: string
let oilId: string
let adminA: string
let tokenA: string
let tokenB: string
let shiftId: string

function dto(items: Array<{ id: string | null; name: string; course?: number }>, over: Partial<IngestOrderDTO> = {}): IngestOrderDTO {
  return {
    source: 'servd',
    external_id: `direct-${randomUUID()}`,
    concept_id: conceptA,
    placed_at: new Date().toISOString(),
    customer_id: null,
    customer_name: 'Guest',
    loyalty_points_earned: null,
    delivery_notes: null,
    estimated_pickup: null,
    fulfilment_type: 'takeout',
    items: items.map((i) => ({ externalItemId: i.id ?? randomUUID(), menuItemId: i.id, name: i.name, quantity: 1, unitPriceCents: 50_000, modifiers: [], course: i.course })),
    payment: { provider: null, amountCents: 50_000 * items.length, status: 'pending' },
    ...over,
  }
}

async function waitFor<T>(read: () => Promise<T>, done: (v: T) => boolean, ms = 4000): Promise<T> {
  const until = Date.now() + ms
  let v = await read()
  while (!done(v) && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 50))
    v = await read()
  }
  return v
}
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms))

const req = (method: 'GET' | 'POST' | 'PATCH', url: string, token: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as never, headers: { authorization: `Bearer ${token}` } })
const orderOf = (id: string) => prisma.order.findUniqueOrThrow({ where: { id }, include: { items: true } })
const menuItem = (id: string) => prisma.menuItem.findUniqueOrThrow({ where: { id } })

function ringUp(items: Array<{ id: string; name: string }>) {
  return createPosOrder({
    conceptId: conceptA, staffId: adminA, staffRole: 'admin', shiftId, paymentMethod: 'cash',
    items: items.map((i) => ({ menuItemId: i.id, name: i.name, quantity: 1, unitPriceCents: 50_000, modifiers: [] })),
  })
}
const pay = (o: { id: string; totalCents: number }) =>
  processPayment({ orderId: o.id, shiftId, payments: [{ method: 'cash', amountCents: o.totalCents, tenderedCents: o.totalCents }] })
/** Wait until the order's fire-and-forget stock depletion has run (and its auto-86, if any). */
async function depleted(orderId: string) {
  await waitFor(() => prisma.auditLog.count({ where: { entity: 'Order', entityId: orderId, action: 'stock.sale_deplete' } }), (n) => n > 0)
  await settle(200)
}

type Card = { id: string; paid: boolean }
type Queue = { awaitingFire: Card[]; inProgress: Card[]; ready: Card[] }
const queue = async (token = tokenA) => (await req('GET', '/expo/queue', token)).json() as Queue
const column = (q: Queue, id: string) =>
  q.awaitingFire.some((o) => o.id === id) ? 'awaitingFire'
    : q.inProgress.some((o) => o.id === id) ? 'inProgress'
      : q.ready.some((o) => o.id === id) ? 'ready' : null
const code = (r: { json: () => unknown }) => (r.json() as { error: { code: string } }).error.code

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'Follow A', slug: 'follow-a' } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'Follow B', slug: 'follow-b' } })).id
  await ensureChartOfAccounts(tenantA)
  conceptA = (await prisma.concept.create({
    data: { name: 'Follow Flipd', slug: 'follow-flipd', type: 'restaurant', tenantId: tenantA, taxRateCash: 0, taxRateCard: 0, isActive: true },
  })).id
  conceptB = (await prisma.concept.create({
    data: { name: 'Follow Other', slug: 'follow-other', type: 'restaurant', tenantId: tenantB, taxRateCash: 0, taxRateCard: 0, isActive: true },
  })).id
  const cat = (await prisma.category.create({ data: { conceptId: conceptA, name: 'Mains' } })).id
  grillId = (await prisma.station.create({ data: { conceptId: conceptA, name: 'Grill', displayOrder: 1 } })).id
  passId = (await prisma.station.create({ data: { conceptId: conceptA, name: 'Expo / Pass', displayOrder: 9 } })).id
  retiredId = (await prisma.station.create({ data: { conceptId: conceptA, name: 'Old Fryer', isActive: false } })).id

  pattyId = (await prisma.inventoryItem.create({ data: { tenantId: tenantA, name: 'Patty', unit: 'pcs', currentStock: 100 } })).id
  // Never counted in: currentStock is the default 0.
  oilId = (await prisma.inventoryItem.create({ data: { tenantId: tenantA, name: 'Frying oil', unit: 'pcs' } })).id

  const menu = async (name: string, stationId: string | null, labor: number, ingredients: string[] = []) => {
    const id = (await prisma.menuItem.create({ data: { conceptId: conceptA, categoryId: cat, name, priceCents: 50_000, stationId } })).id
    await prisma.recipe.create({
      data: {
        kind: 'plate', menuItemId: id, laborMinutes: labor, servings: 1,
        ingredients: { create: ingredients.map((inventoryItemId) => ({ inventoryItemId, quantity: 1, yieldPct: 1, unit: 'pcs' })) },
      },
    })
    return id
  }
  burgerId = await menu('Classic', grillId, 8, [pattyId])
  sliderId = await menu('Slider', grillId, 4, [pattyId])
  friesId = await menu('Fries', grillId, 3, [oilId])
  oldFryId = await menu('Onion rings', retiredId, 3)
  // Reaches the line only through its recipe steps — no menu station.
  zingerId = (await prisma.menuItem.create({ data: { conceptId: conceptA, categoryId: cat, name: 'Zinger', priceCents: 50_000 } })).id
  const zr = await prisma.recipe.create({ data: { kind: 'plate', menuItemId: zingerId, laborMinutes: 0 } })
  await prisma.recipeStep.create({ data: { recipeId: zr.id, phase: 'service_cook', stationId: grillId, instruction: 'Fry the zinger', ordinal: 1 } })
  // Chiller water: nothing to cook — no station, no recipe.
  waterId = (await prisma.menuItem.create({ data: { conceptId: conceptA, categoryId: cat, name: 'Water', priceCents: 50_000 } })).id

  const mk = async (email: string, tenantId: string) => prisma.user.create({
    data: { name: email, email, password: 'x', role: 'admin', isActive: true, accountStatus: 'active', tenantId } as never,
  })
  const admin = await mk('follow-admin-a@test.local', tenantA)
  adminA = admin.id
  tokenA = (issueStaffSession(admin) as { accessToken: string }).accessToken
  tokenB = (issueStaffSession(await mk('follow-admin-b@test.local', tenantB)) as { accessToken: string }).accessToken
  shiftId = (await prisma.shift.create({ data: { userId: adminA, openingFloatCents: 0, status: 'open', tenantId: tenantA } })).id

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(expoRoutes, { prefix: '/expo' })
  await app.register(orderRoutes, { prefix: '/orders' })
  await app.register(orderItemRoutes, { prefix: '/order-items' })
  await app.register(orderCourseRoutes, { prefix: '/orders' })
  await app.register(kdsRoutes, { prefix: '/kds' })
  await app.register(menuRoutes, { prefix: '/menu' })
  await app.ready()
})

afterAll(async () => {
  invalidateSetupCache()
  await app?.close()
})

// ─── R1 ───────────────────────────────────────────────────────────────────────

/** `n` orders of company A in `status`, one grill line each, every one already handed off by expo. */
async function handedOffOrders(n: number, status: 'completed' | 'ready', minutesAgo: number) {
  const ids = Array.from({ length: n }, () => randomUUID())
  const placedAt = new Date(Date.now() - minutesAgo * 60_000)
  await prisma.order.createMany({
    data: ids.map((id) => ({
      id, conceptId: conceptA, source: 'pos' as const, status, totalCents: 50_000, placedAt,
      externalId: `pos-${randomUUID()}`, ...(status === 'completed' && { completedAt: placedAt }),
    })),
  })
  await prisma.orderItem.createMany({
    data: ids.map((orderId) => ({ orderId, menuItemId: burgerId, stationId: grillId, name: 'Classic', quantity: 1, unitPriceCents: 50_000, status: 'bumped' as const })),
  })
  await prisma.auditLog.createMany({
    data: ids.map((entityId) => ({ entity: 'Order', entityId, action: 'expo.handoff', tenantId: tenantA })),
  })
  return ids
}

describe('R1 — handed-off orders never push a fresh one off the pass', () => {
  it('125 handed-off paid till sales: the one a customer just paid for is on expo', async () => {
    const old = await handedOffOrders(125, 'completed', 120)
    const fresh = await ringUp([{ id: burgerId, name: 'Classic' }])
    await pay(fresh)
    const q = await queue()
    expect(column(q, fresh.id)).toBe('awaitingFire')
    expect(q.awaitingFire.find((o) => o.id === fresh.id)!.paid).toBe(true)
    expect([...q.awaitingFire, ...q.inProgress, ...q.ready].some((o) => old.includes(o.id))).toBe(false)
    // Company B's expo sees none of it.
    expect(column(await queue(tokenB), fresh.id)).toBeNull()

    // Expo fires it and it walks on through the columns.
    expect((await req('POST', `/expo/orders/${fresh.id}/fire`, tokenA, {})).statusCode).toBe(200)
    await req('PATCH', `/order-items/${fresh.items[0]!.id}/status`, tokenA, { status: 'bumped' })
    expect(column(await queue(), fresh.id)).toBe('ready')
    expect((await req('POST', `/expo/orders/${fresh.id}/handoff`, tokenA, {})).statusCode).toBe(200)
    expect(column(await queue(), fresh.id)).toBeNull()
  })

  it('65 handed-off ready orders (deliveries with their riders): a fresh ready order still shows', async () => {
    await handedOffOrders(65, 'ready', 600)
    const { order } = await ingestOrder(dto([{ id: burgerId, name: 'Classic' }]))
    await req('POST', `/expo/orders/${order.id}/fire`, tokenA, {})
    await req('PATCH', `/order-items/${order.items[0]!.id}/status`, tokenA, { status: 'bumped' })
    expect((await orderOf(order.id)).status).toBe('ready')
    expect(column(await queue(), order.id)).toBe('ready')
    expect(column(await queue(tokenB), order.id)).toBeNull()
  })
})

// ─── R3 ───────────────────────────────────────────────────────────────────────

describe('R3 — a paid sale with nothing to cook leaves the pass at payment', () => {
  it('chiller water paid at the till is on no expo column and not an unrouted ticket; water + burger is', async () => {
    const water = await ringUp([{ id: waterId, name: 'Water' }])
    await pay(water)
    expect((await orderOf(water.id)).status).toBe('completed')
    expect(column(await queue(), water.id)).toBeNull()
    const unrouted = (await req('GET', '/kds/unrouted', tokenA)).json() as { items: Array<{ order: { id: string } }> }
    expect(unrouted.items.some((i) => i.order.id === water.id)).toBe(false)

    const meal = await ringUp([{ id: waterId, name: 'Water' }, { id: burgerId, name: 'Classic' }])
    await pay(meal)
    expect(column(await queue(), meal.id)).toBe('awaitingFire')
  })
})

// ─── R4 ───────────────────────────────────────────────────────────────────────

describe('R4 — a Bump-only screen can clear held and recalled lines; paid orders say why not', () => {
  it('Bump on a recalled remake goes through preparing and puts the order back to ready', async () => {
    const { order } = await ingestOrder(dto([{ id: burgerId, name: 'Classic' }]))
    await req('POST', `/expo/orders/${order.id}/fire`, tokenA, {})
    const line = order.items[0]!.id
    await req('PATCH', `/order-items/${line}/status`, tokenA, { status: 'bumped' })
    expect((await req('PATCH', `/order-items/${line}/status`, tokenA, { status: 'recalled' })).statusCode).toBe(200)
    expect((await orderOf(order.id)).status).toBe('preparing')

    const bump = await req('PATCH', `/order-items/${line}/status`, tokenA, { status: 'bumped' })
    expect(bump.statusCode).toBe(200)
    const after = await orderOf(order.id)
    expect(after.items[0]!.status).toBe('bumped')
    expect(after.status).toBe('ready')
    // Another company can't.
    expect((await req('PATCH', `/order-items/${line}/status`, tokenB, { status: 'recalled' })).statusCode).toBe(404)
  })

  it('a held line is off a Bump-only screen, a Bump on it is refused, and it bumps once resumed', async () => {
    const { order } = await ingestOrder(dto([{ id: burgerId, name: 'Classic' }]))
    await req('POST', `/expo/orders/${order.id}/fire`, tokenA, {})
    const line = order.items[0]!.id
    expect((await req('PATCH', `/order-items/${line}/status`, tokenA, { status: 'held' })).statusCode).toBe(200)

    // The tablet's queue (no ?states) leaves the paused line out; the admin's
    // (?states=all) shows it HELD. Company B sees neither.
    expect((await stationQueue(grillId)).legacy.map((l) => l.itemId)).not.toContain(line)
    const all = (await req('GET', `/expo/station/${grillId}/queue?states=all`, tokenA)).json() as { legacy: Array<{ itemId: string; status: string }> }
    expect(all.legacy.find((l) => l.itemId === line)?.status).toBe('held')
    const allB = (await req('GET', `/expo/station/${grillId}/queue?states=all`, tokenB)).json() as StationQueue
    expect(allB.legacy).toEqual([])

    // Bump straight through a hold: refused, nothing moves.
    const bump = await req('PATCH', `/order-items/${line}/status`, tokenA, { status: 'bumped' })
    expect(bump.statusCode).toBe(409)
    expect(code(bump)).toBe('ITEM_ON_HOLD')
    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: line } })).status).toBe('held')
    expect((await req('PATCH', `/order-items/${line}/status`, tokenB, { status: 'preparing' })).statusCode).toBe(404)

    // Resume → back on the tablet → Bump works.
    expect((await req('PATCH', `/order-items/${line}/status`, tokenA, { status: 'preparing' })).statusCode).toBe(200)
    expect((await stationQueue(grillId)).legacy.map((l) => l.itemId)).toContain(line)
    expect((await req('PATCH', `/order-items/${line}/status`, tokenA, { status: 'bumped' })).statusCode).toBe(200)
    expect((await orderOf(order.id)).status).toBe('ready')
  })

  it('a recalled remake stays on the Bump-only screen', async () => {
    const { order } = await ingestOrder(dto([{ id: burgerId, name: 'Classic' }]))
    await req('POST', `/expo/orders/${order.id}/fire`, tokenA, {})
    const line = order.items[0]!.id
    await req('PATCH', `/order-items/${line}/status`, tokenA, { status: 'bumped' })
    await req('PATCH', `/order-items/${line}/status`, tokenA, { status: 'recalled' })
    expect((await stationQueue(grillId)).legacy.map((l) => l.itemId)).toContain(line)
    expect((await req('PATCH', `/order-items/${line}/status`, tokenA, { status: 'bumped' })).statusCode).toBe(200)
  })

  it('Reject on a paid till sale answers PAID_AT_TILL; the tablet\'s READY bumps its fired lines and expo hands it off', async () => {
    const o = await ringUp([{ id: burgerId, name: 'Classic' }, { id: sliderId, name: 'Slider' }])
    await pay(o)
    const reject = await req('POST', `/expo/orders/${o.id}/reject`, tokenA, { reason: 'Out of stock' })
    expect(reject.statusCode).toBe(409)
    expect(code(reject)).toBe('PAID_AT_TILL')
    expect((await req('POST', `/expo/orders/${o.id}/reject`, tokenB, { reason: 'x' })).statusCode).toBe(404)

    // fireAll: Slider is paced 4 min behind Classic (BOH-R2-01); this test is about READY.
    await req('POST', `/expo/orders/${o.id}/fire`, tokenA, { fireAll: true })
    expect(column(await queue(), o.id)).toBe('inProgress')
    // Company B can't mark it ready (404, nothing bumped).
    expect((await req('PATCH', `/orders/${o.id}/status`, tokenB, { status: 'ready' })).statusCode).toBe(404)
    expect((await orderOf(o.id)).items.every((i) => i.status === 'preparing')).toBe(true)

    // A held line blocks READY (nothing bumped); resumed, READY bumps both lines.
    const [first, second] = o.items
    await req('PATCH', `/order-items/${first!.id}/status`, tokenA, { status: 'held' })
    const blocked = await req('PATCH', `/orders/${o.id}/status`, tokenA, { status: 'ready' })
    expect(blocked.statusCode).toBe(409)
    expect(code(blocked)).toBe('ITEM_ON_HOLD')
    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: second!.id } })).status).toBe('preparing')
    await req('PATCH', `/order-items/${first!.id}/status`, tokenA, { status: 'preparing' })

    const ready = await req('PATCH', `/orders/${o.id}/status`, tokenA, { status: 'ready' })
    expect(ready.statusCode).toBe(200)
    const after = await orderOf(o.id)
    expect(after.status).toBe('completed')            // paid: its status never goes back
    expect(after.items.every((i) => i.status === 'bumped')).toBe(true)
    expect(column(await queue(), o.id)).toBe('ready')
    expect((await req('POST', `/expo/orders/${o.id}/handoff`, tokenA, {})).statusCode).toBe(200)
    expect(column(await queue(), o.id)).toBeNull()
    // Any other status on a paid till sale still says why not.
    const back = await req('PATCH', `/orders/${o.id}/status`, tokenA, { status: 'preparing' })
    expect(back.statusCode).toBe(409)
    expect(code(back)).toBe('PAID_AT_TILL')
  })

  it('READY on a paid till sale with a course not fired yet is refused', async () => {
    const o = await createPosOrder({
      conceptId: conceptA, staffId: adminA, staffRole: 'admin', shiftId, paymentMethod: 'cash',
      items: [
        { menuItemId: burgerId, name: 'Classic', quantity: 1, unitPriceCents: 50_000, modifiers: [] },
        { menuItemId: sliderId, name: 'Slider', quantity: 1, unitPriceCents: 50_000, modifiers: [] },
      ],
    })
    await pay(o)
    // One line fired, one still pending (a later course).
    await req('PATCH', `/order-items/${o.items[0]!.id}/status`, tokenA, { status: 'preparing' })
    const r = await req('PATCH', `/orders/${o.id}/status`, tokenA, { status: 'ready' })
    expect(r.statusCode).toBe(409)
    expect(code(r)).toBe('ITEMS_NOT_FIRED')
    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: o.items[0]!.id } })).status).toBe('preparing')
  })
})

// ─── R5 ───────────────────────────────────────────────────────────────────────

type StationQueue = { steps: Array<{ itemId: string }>; legacy: Array<{ itemId: string }> }
const stationQueue = async (id: string, token = tokenA) => (await req('GET', `/expo/station/${id}/queue`, token)).json() as StationQueue

describe('R5 — only a retired station falls back to the pass', () => {
  it('a step-routed dish with no station stays unrouted, is on no screen until fired, then reaches its step station', async () => {
    const { order } = await ingestOrder(dto([
      { id: zingerId, name: 'Zinger' },
      { id: oldFryId, name: 'Onion rings' },
      { id: null, name: 'Custom: extra sauce' },
    ]))
    const byName = Object.fromEntries(order.items.map((i) => [i.name, i]))
    expect(byName.Zinger!.stationId).toBeNull()
    expect(byName['Onion rings']!.stationId).toBe(passId)          // retired station → pass
    expect(byName['Custom: extra sauce']!.stationId).toBe(passId)  // custom line → pass

    const pass = await stationQueue(passId)
    expect(pass.legacy.map((l) => l.itemId)).not.toContain(byName.Zinger!.id)
    expect(pass.legacy.map((l) => l.itemId)).toContain(byName['Onion rings']!.id)
    const unrouted = (await req('GET', '/kds/unrouted', tokenA)).json() as { items: Array<{ itemId: string }> }
    expect(unrouted.items.map((i) => i.itemId)).not.toContain(byName.Zinger!.id)

    // fireAll: the 0-minute Zinger is paced behind the onion rings (BOH-R2-01); this test is about routing.
    expect((await req('POST', `/expo/orders/${order.id}/fire`, tokenA, { fireAll: true })).statusCode).toBe(200)
    const grill = await stationQueue(grillId)
    expect(grill.steps.map((s) => s.itemId)).toContain(byName.Zinger!.id)
    // Company B can't read A's station.
    expect((await stationQueue(grillId, tokenB)).steps).toEqual([])
  })

  it('a step-routed dish that also has a menu station is not a bumpable legacy card before it is fired', async () => {
    const stackId = (await prisma.menuItem.create({
      data: { conceptId: conceptA, categoryId: (await prisma.category.findFirstOrThrow({ where: { conceptId: conceptA } })).id, name: 'Stack', priceCents: 50_000, stationId: grillId },
    })).id
    const r = await prisma.recipe.create({ data: { kind: 'plate', menuItemId: stackId, laborMinutes: 0 } })
    await prisma.recipeStep.create({ data: { recipeId: r.id, phase: 'service_assemble', stationId: passId, instruction: 'Build', ordinal: 1 } })
    const { order } = await ingestOrder(dto([{ id: stackId, name: 'Stack' }]))
    expect((await stationQueue(grillId)).legacy.map((l) => l.itemId)).not.toContain(order.items[0]!.id)
    await req('POST', `/expo/orders/${order.id}/fire`, tokenA, {})
    expect((await stationQueue(passId)).steps.map((s) => s.itemId)).toContain(order.items[0]!.id)
  })
})

// ─── R2 + R6 ──────────────────────────────────────────────────────────────────

describe('R2 / R6 — auto-86 only when a sale ran the stock out; the till keeps selling it, not a manual 86', () => {
  it('runs the whole day', async () => {
    // One patty left; everything on.
    await prisma.inventoryItem.update({ where: { id: pattyId }, data: { currentStock: 1 } })
    await prisma.menuItem.updateMany({ where: { id: { in: [burgerId, sliderId, friesId] } }, data: { isAvailable: true } })
    // Uncounted oil (stock 0): selling fries takes nothing and 86s nothing.
    const fries = await ringUp([{ id: friesId, name: 'Fries' }])
    await depleted(fries.id)
    expect((await menuItem(friesId)).isAvailable).toBe(true)
    expect(await prisma.auditLog.count({ where: { action: 'menu.auto_86', entityId: friesId } })).toBe(0)

    // The last patty goes: every dish on patties is auto-86'd — fries (oil) is not.
    const burger = await ringUp([{ id: burgerId, name: 'Classic' }])
    await depleted(burger.id)
    expect((await menuItem(burgerId)).isAvailable).toBe(false)
    expect((await menuItem(sliderId)).isAvailable).toBe(false)
    expect((await menuItem(friesId)).isAvailable).toBe(true)
    expect(Number((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: pattyId } })).currentStock)).toBe(0)

    // The till still sells the stock-86'd slider; the storefront does not.
    const slider = await ringUp([{ id: sliderId, name: 'Slider' }])
    expect(slider.id).toBeTruthy()
    await depleted(slider.id)
    await expect(ingestOrder(dto([{ id: sliderId, name: 'Slider' }]))).rejects.toMatchObject({ code: 'ITEM_UNAVAILABLE' })

    // A chef 86's fries by hand: refused at the till too.
    expect((await req('PATCH', `/menu/items/${friesId}/availability`, tokenA, { isAvailable: false })).statusCode).toBe(200)
    await expect(ringUp([{ id: friesId, name: 'Fries' }])).rejects.toMatchObject({ code: 'ITEM_UNAVAILABLE' })

    // Burger: a manager puts it back on, later the chef pulls it by hand.
    await settle(50)
    expect((await req('PATCH', `/menu/items/${burgerId}/availability`, tokenA, { isAvailable: true })).statusCode).toBe(200)
    expect((await req('PATCH', `/menu/items/${burgerId}/availability`, tokenA, { isAvailable: false })).statusCode).toBe(200)
    await expect(ringUp([{ id: burgerId, name: 'Classic' }])).rejects.toMatchObject({ code: 'ITEM_UNAVAILABLE' })

    // The patties arrive: only the slider (still the stock's 86) is offered
    // back — not the burger the chef pulled, not the fries.
    await prisma.inventoryItem.update({ where: { id: pattyId }, data: { currentStock: 20 } })
    const list = (await req('GET', '/kds/auto-86/back-in-stock', tokenA)).json() as { items: Array<{ menuItemId: string }> }
    expect(list.items.map((i) => i.menuItemId)).toEqual([sliderId])
    expect(((await req('GET', '/kds/auto-86/back-in-stock', tokenB)).json() as { items: unknown[] }).items).toEqual([])

    // Put everything back on for the rest of the file.
    await prisma.inventoryItem.update({ where: { id: pattyId }, data: { currentStock: 100 } })
    await prisma.menuItem.updateMany({ where: { id: { in: [burgerId, sliderId, friesId] } }, data: { isAvailable: true } })
  })
})

// ─── R7 ───────────────────────────────────────────────────────────────────────

describe('R7 — the pacing worker never fires a later course', () => {
  it('a course-2 line with an old fire time waits for "Fire course", and the stale time is cleared', async () => {
    const { order } = await ingestOrder(dto([
      { id: burgerId, name: 'Classic', course: 1 },
      { id: friesId, name: 'Fries', course: 1 },
      { id: sliderId, name: 'Slider', course: 2 },
    ]))
    const slider = order.items.find((i) => i.name === 'Slider')!
    const past = new Date(Date.now() - 60_000)
    // A row paced by the old code: every course carries a fire time.
    await prisma.orderItem.updateMany({ where: { orderId: order.id }, data: { scheduledFireAt: past } })

    // Re-anchoring at the fire clears course 2's time.
    await updateOrderStatus(order.id, 'confirmed')
    await waitFor(() => prisma.orderItem.findUniqueOrThrow({ where: { id: slider.id } }), (i) => i.scheduledFireAt === null)
    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: slider.id } })).scheduledFireAt).toBeNull()
    // The re-anchor runs in the background: wait until it has also re-timed
    // course 1 (fries go after the burger), or its late write races the
    // "old fire time" set below.
    const friesLine = order.items.find((i) => i.name === 'Fries')!
    await waitFor(() => prisma.orderItem.findUniqueOrThrow({ where: { id: friesLine.id } }),
      (i) => i.status !== 'pending' || (i.scheduledFireAt !== null && i.scheduledFireAt.getTime() > Date.now()))
    await settle(100)

    // The worker path on its own: course 1 fired, course 2 still carrying an old time.
    await prisma.orderItem.updateMany({ where: { orderId: order.id, course: 1 }, data: { scheduledFireAt: past } })
    await prisma.orderItem.update({ where: { id: slider.id }, data: { scheduledFireAt: past } })
    await processCoursePacingTick()
    const after = await orderOf(order.id)
    expect(after.items.filter((i) => i.course === 1).every((i) => i.status === 'preparing')).toBe(true)
    const s = after.items.find((i) => i.id === slider.id)!
    expect(s.status).toBe('pending')
    expect(s.scheduledFireAt).toBeNull()
    await processCoursePacingTick()
    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: slider.id } })).status).toBe('pending')

    // Expo fires it.
    expect((await req('POST', `/orders/${order.id}/fire-course`, tokenA, { course: 2 })).statusCode).toBe(200)
    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: slider.id } })).status).toBe('preparing')
  })
})

// ─── R8 ───────────────────────────────────────────────────────────────────────

describe('R8 — no hold once the food has left; ended orders are off the station', () => {
  it('a hold on a handed-off, completed pickup order is refused', async () => {
    const { order } = await ingestOrder(dto([{ id: burgerId, name: 'Classic' }, { id: friesId, name: 'Fries' }]))
    await req('POST', `/expo/orders/${order.id}/fire`, tokenA, {})
    const burger = order.items.find((i) => i.name === 'Classic')!
    const fries = order.items.find((i) => i.name === 'Fries')!
    await req('PATCH', `/order-items/${burger.id}/status`, tokenA, { status: 'bumped' })
    // Staff mark it ready by hand with fries still on the line, and hand it over.
    expect((await req('PATCH', `/orders/${order.id}/status`, tokenA, { status: 'ready' })).statusCode).toBe(200)
    expect((await req('POST', `/expo/orders/${order.id}/handoff`, tokenA, {})).statusCode).toBe(200)
    expect((await orderOf(order.id)).status).toBe('completed')

    const hold = await req('PATCH', `/order-items/${fries.id}/status`, tokenA, { status: 'held' })
    expect(hold.statusCode).toBe(409)
    expect(code(hold)).toBe('ORDER_ALREADY_SERVED')
  })

  it('a paid till sale can still be held', async () => {
    const o = await ringUp([{ id: burgerId, name: 'Classic' }])
    await pay(o)
    await req('POST', `/expo/orders/${o.id}/fire`, tokenA, {})
    expect((await req('PATCH', `/order-items/${o.items[0]!.id}/status`, tokenA, { status: 'held' })).statusCode).toBe(200)
  })

  it('a cancelled order\'s lines leave the station screen', async () => {
    const { order } = await ingestOrder(dto([{ id: burgerId, name: 'Classic' }]))
    expect((await stationQueue(grillId)).legacy.map((l) => l.itemId)).toContain(order.items[0]!.id)
    await cancelOrder(order.id, { reason: 'Customer left', actor: { id: adminA, tenantId: tenantA } })
    expect((await stationQueue(grillId)).legacy.map((l) => l.itemId)).not.toContain(order.items[0]!.id)
  })
})

// ─── F1 ───────────────────────────────────────────────────────────────────────

describe('F1 — the tip is written with the order', () => {
  it('tip_cents lands on Order.tipCents in the insert; a bad tip is refused; no tip is 0', async () => {
    const base = dto([{ id: burgerId, name: 'Classic' }])
    const { order } = await ingestOrder({ ...base, payment: { ...base.payment, amountCents: 55_000 }, tip_cents: 5_000 })
    expect(order.tipCents).toBe(5_000)
    expect(order.totalCents).toBe(55_000)

    const none = await ingestOrder(dto([{ id: burgerId, name: 'Classic' }]))
    expect(none.order.tipCents).toBe(0)

    await expect(ingestOrder({ ...dto([{ id: burgerId, name: 'Classic' }]), tip_cents: 999_999 })).rejects.toMatchObject({ code: 'INVALID_TIP' })
    await expect(ingestOrder({ ...dto([{ id: burgerId, name: 'Classic' }]), tip_cents: -1 })).rejects.toMatchObject({ code: 'INVALID_TIP' })
    // The plain DTO type still works.
    const plain: OrderDTO = dto([{ id: burgerId, name: 'Classic' }])
    expect((await ingestOrder(plain)).created).toBe(true)
  })
})
