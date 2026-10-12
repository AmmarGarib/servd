// Kitchen flow audit (2026-10-10 kitchen shift + admin click-through).
//
// What this guards:
//   - BOH-04: hold and recall keep the line on its station's screen with its
//     state; a recall reopens a 'ready' order (expo can't hand it off until
//     the remake is bumped) and is refused once the food has left / on an
//     order that ended; the KDS "recently bumped" list (company-scoped)
//     offers only what the server will accept.
//   - BOH-06: course pacing never fires a later course before an earlier one
//     and never fires anything on an order expo hasn't fired.
//   - BOH-16: "Fire course" goes through the one firing engine: each station
//     room and the company's order room hear item:updated (no other
//     company's room), and a step-routed dish gets its recipe steps.
//   - UI-05: a till sale paid before its hand-off stays on expo (awaiting fire
//     → in progress → ready by its lines) until expo hands it off, pay-first
//     and pay-later; payment's completion side effects still run once.
//   - UI-14: a line cook with no stations on their roster sees every active
//     station of their company on /kds (Workforce: "Empty = not restricted").
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import http from 'node:http'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import type { OrderDTO } from '@servd/types'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { invalidateSetupCache } from '../src/lib/setup-config.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { initWebSocket, getIO } from '../src/lib/ws.js'
import {
  ingestOrder, updateOrderStatus, cancelOrder, scheduleCoursePacing, processCoursePacingTick,
} from '../src/modules/orders/service.js'
import { createPosOrder, processPayment } from '../src/modules/pos/service.js'
import { expoRoutes } from '../src/modules/expo/routes.js'
import { orderItemRoutes, orderCourseRoutes } from '../src/modules/orders/routes.js'
import { kdsRoutes } from '../src/modules/kds/routes.js'

let app: FastifyInstance
let tenantA: string
let tenantB: string
let conceptA: string
let conceptB: string
let grillId: string
let fryId: string
let grillB: string
let burgerId: string
let friesId: string
let wingsId: string
let stackId: string
let stackStepId: string
let adminA: string
let tokenExpo: string
let tokenB: string
let tokenCook: string
let tokenCookRostered: string
let shiftId: string

const sent: Array<{ room: string; event: string; data: Record<string, unknown> }> = []

function dto(items: Array<{ id: string; name: string; course?: number }>, over: Partial<OrderDTO> = {}): OrderDTO {
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
    ...over,
  }
}

const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms))
async function waitFor<T>(read: () => Promise<T>, done: (v: T) => boolean, ms = 4000): Promise<T> {
  const until = Date.now() + ms
  let v = await read()
  while (!done(v) && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 50))
    v = await read()
  }
  return v
}

const req = (method: 'GET' | 'POST' | 'PATCH', url: string, token: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as never, headers: { authorization: `Bearer ${token}` } })
const item = (id: string) => prisma.orderItem.findUniqueOrThrow({ where: { id } })
const orderOf = (id: string) => prisma.order.findUniqueOrThrow({ where: { id } })

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'Kitchen A', slug: 'kitchen-a' } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'Kitchen B', slug: 'kitchen-b' } })).id
  await ensureChartOfAccounts(tenantA)
  conceptA = (await prisma.concept.create({
    data: { name: 'Kitchen Flipd', slug: 'kitchen-flipd', type: 'restaurant', tenantId: tenantA, taxRateCash: 0, taxRateCard: 0, isActive: true },
  })).id
  conceptB = (await prisma.concept.create({
    data: { name: 'Kitchen Other', slug: 'kitchen-other', type: 'restaurant', tenantId: tenantB, taxRateCash: 0, taxRateCard: 0, isActive: true },
  })).id
  const cat = (await prisma.category.create({ data: { conceptId: conceptA, name: 'Mains' } })).id
  grillId = (await prisma.station.create({ data: { conceptId: conceptA, name: 'Grill', displayOrder: 1 } })).id
  fryId = (await prisma.station.create({ data: { conceptId: conceptA, name: 'Fry', displayOrder: 2 } })).id
  grillB = (await prisma.station.create({ data: { conceptId: conceptB, name: 'Grill' } })).id
  const menu = async (name: string, stationId: string, labor: number) => {
    const id = (await prisma.menuItem.create({ data: { conceptId: conceptA, categoryId: cat, name, priceCents: 50_000, stationId } })).id
    await prisma.recipe.create({ data: { kind: 'plate', menuItemId: id, laborMinutes: labor } })
    return id
  }
  burgerId = await menu('Classic', grillId, 8)
  friesId = await menu('Fries', fryId, 3)
  wingsId = await menu('Wings', grillId, 6)
  // A dish that reaches the line ONLY through its recipe steps.
  stackId = (await prisma.menuItem.create({ data: { conceptId: conceptA, categoryId: cat, name: 'Smash stack', priceCents: 50_000 } })).id
  const stackRecipe = await prisma.recipe.create({ data: { kind: 'plate', menuItemId: stackId, laborMinutes: 0 } })
  stackStepId = (await prisma.recipeStep.create({
    data: { recipeId: stackRecipe.id, phase: 'service_cook', stationId: grillId, instruction: 'Smash two patties', ordinal: 1 },
  })).id

  const mk = async (email: string, tenantId: string, role: string, stationIds: string[] = []) => prisma.user.create({
    data: { name: email, email, password: 'x', role, isActive: true, accountStatus: 'active', tenantId, stationIds } as never,
  })
  const admin = await mk('kitchen-admin-a@test.local', tenantA, 'admin')
  adminA = admin.id
  tokenExpo = (issueStaffSession(await mk('kitchen-expo-a@test.local', tenantA, 'expediter')) as { accessToken: string }).accessToken
  tokenB = (issueStaffSession(await mk('kitchen-admin-b@test.local', tenantB, 'admin')) as { accessToken: string }).accessToken
  tokenCook = (issueStaffSession(await mk('kitchen-cook-a@test.local', tenantA, 'kitchen')) as { accessToken: string }).accessToken
  tokenCookRostered = (issueStaffSession(await mk('kitchen-cook-a2@test.local', tenantA, 'kitchen', [fryId])) as { accessToken: string }).accessToken
  shiftId = (await prisma.shift.create({ data: { userId: adminA, openingFloatCents: 0, status: 'open', tenantId: tenantA } })).id

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(expoRoutes, { prefix: '/expo' })
  await app.register(orderItemRoutes, { prefix: '/order-items' })
  await app.register(orderCourseRoutes, { prefix: '/orders' })
  await app.register(kdsRoutes, { prefix: '/kds' })
  await app.ready()

  // A live socket.io server whose room emits are recorded: what each station
  // screen / company feed would receive.
  const noop = () => {}
  initWebSocket({ server: http.createServer(), log: { info: noop, warn: noop, error: noop } } as never)
  vi.spyOn(getIO(), 'to').mockImplementation(((room: string) => ({
    emit: (event: string, data: Record<string, unknown>) => { sent.push({ room, event, data }); return true },
  })) as never)
})

afterAll(async () => {
  invalidateSetupCache()
  await app?.close()
  getIO().close()
})

// ─── BOH-04 ───────────────────────────────────────────────────────────────────

describe('BOH-04 — hold and recall', () => {
  it('a held line stays on its station, marked held, and resumes', async () => {
    const { order } = await ingestOrder(dto([{ id: burgerId, name: 'Classic' }, { id: friesId, name: 'Fries' }]))
    expect((await req('POST', `/expo/orders/${order.id}/fire`, tokenExpo, {})).statusCode).toBe(200)
    const burger = order.items.find((i) => i.name === 'Classic')!

    expect((await req('PATCH', `/order-items/${burger.id}/status`, tokenExpo, { status: 'held' })).statusCode).toBe(200)
    // The admin KDS asks for every state (?states=all) and shows it HELD; a
    // Bump-only screen (no ?states) doesn't get the paused line at all (R4).
    const q = (await req('GET', `/expo/station/${grillId}/queue?states=all`, tokenExpo)).json() as { legacy: Array<{ itemId: string; status: string }> }
    expect(q.legacy.find((l) => l.itemId === burger.id)?.status).toBe('held')
    const plain = (await req('GET', `/expo/station/${grillId}/queue`, tokenExpo)).json() as { legacy: Array<{ itemId: string; status: string }> }
    expect(plain.legacy.map((l) => l.itemId)).not.toContain(burger.id)
    expect((await orderOf(order.id)).status).toBe('preparing')

    expect((await req('PATCH', `/order-items/${burger.id}/status`, tokenExpo, { status: 'preparing' })).statusCode).toBe(200)
    expect((await item(burger.id)).status).toBe('preparing')
  })

  it('a recall puts the line back on its station as a remake, reopens the order and blocks the hand-off until re-bumped', async () => {
    const { order } = await ingestOrder(dto([{ id: burgerId, name: 'Classic' }, { id: friesId, name: 'Fries' }]))
    await req('POST', `/expo/orders/${order.id}/fire`, tokenExpo, {})
    for (const it of order.items) {
      expect((await req('PATCH', `/order-items/${it.id}/status`, tokenExpo, { status: 'bumped' })).statusCode).toBe(200)
    }
    expect((await orderOf(order.id)).status).toBe('ready')
    const burger = order.items.find((i) => i.name === 'Classic')!

    // The station's recall strip offers it — to its own company only.
    const recent = (await req('GET', `/kds/stations/${grillId}/recent-bumped`, tokenExpo)).json() as { items: Array<{ itemId: string }> }
    expect(recent.items.map((i) => i.itemId)).toContain(burger.id)
    expect((await req('GET', `/kds/stations/${grillId}/recent-bumped`, tokenB)).statusCode).toBe(404)
    // Company B can't recall A's line.
    expect((await req('PATCH', `/order-items/${burger.id}/status`, tokenB, { status: 'recalled' })).statusCode).toBe(404)

    expect((await req('PATCH', `/order-items/${burger.id}/status`, tokenExpo, { status: 'recalled' })).statusCode).toBe(200)
    expect((await orderOf(order.id)).status).toBe('preparing')
    expect((await item(burger.id)).completedAt).toBeNull()
    const q = (await req('GET', `/expo/station/${grillId}/queue`, tokenExpo)).json() as { legacy: Array<{ itemId: string; status: string }> }
    expect(q.legacy.find((l) => l.itemId === burger.id)?.status).toBe('recalled')

    const early = await req('POST', `/expo/orders/${order.id}/handoff`, tokenExpo, {})
    expect(early.statusCode).toBe(409)
    expect((early.json() as { error: { code: string } }).error.code).toBe('NOT_READY')

    await req('PATCH', `/order-items/${burger.id}/status`, tokenExpo, { status: 'preparing' })
    await req('PATCH', `/order-items/${burger.id}/status`, tokenExpo, { status: 'bumped' })
    expect((await orderOf(order.id)).status).toBe('ready')
    expect((await req('POST', `/expo/orders/${order.id}/handoff`, tokenExpo, {})).statusCode).toBe(200)
    expect((await orderOf(order.id)).status).toBe('completed')

    // Handed over and completed: the food has gone — no recall, and the
    // recall strip no longer offers it.
    const late = await req('PATCH', `/order-items/${burger.id}/status`, tokenExpo, { status: 'recalled' })
    expect(late.statusCode).toBe(409)
    expect((late.json() as { error: { code: string } }).error.code).toBe('ORDER_ALREADY_SERVED')
    const after = (await req('GET', `/kds/stations/${grillId}/recent-bumped`, tokenExpo)).json() as { items: Array<{ itemId: string }> }
    expect(after.items.map((i) => i.itemId)).not.toContain(burger.id)
  })

  it('no hold or recall on an order that ended without a sale', async () => {
    const { order } = await ingestOrder(dto([{ id: burgerId, name: 'Classic' }]))
    await cancelOrder(order.id, { reason: 'Customer left', actor: { id: adminA, tenantId: tenantA } })
    const r = await req('PATCH', `/order-items/${order.items[0]!.id}/status`, tokenExpo, { status: 'held' })
    expect(r.statusCode).toBe(409)
    expect((r.json() as { error: { code: string } }).error.code).toBe('ORDER_ENDED')
  })
})

// ─── BOH-06 ───────────────────────────────────────────────────────────────────

describe('BOH-06 — course pacing', () => {
  it('paces only the first course, and never fires an order expo has not fired', async () => {
    const { order } = await ingestOrder(dto([
      { id: friesId, name: 'Fries', course: 1 },
      { id: wingsId, name: 'Wings', course: 1 },
      { id: burgerId, name: 'Classic', course: 2 },
    ]))
    await scheduleCoursePacing(order.id)
    const byName = async () => Object.fromEntries((await prisma.orderItem.findMany({ where: { orderId: order.id } })).map((i) => [i.name, i]))
    let items = await byName()
    expect(items.Classic!.scheduledFireAt).toBeNull()                 // course 2 waits for "Fire course"
    expect(items.Wings!.scheduledFireAt).not.toBeNull()                // longest of course 1 fires first
    expect(items.Fries!.scheduledFireAt!.getTime() - items.Wings!.scheduledFireAt!.getTime()).toBe(3 * 60_000)

    // Make everything "due"; the order is still 'received' — nothing fires.
    await prisma.orderItem.updateMany({ where: { orderId: order.id }, data: { scheduledFireAt: new Date(Date.now() - 1000) } })
    await processCoursePacingTick()
    items = await byName()
    expect(Object.values(items).every((i) => i.status === 'pending')).toBe(true)

    // Fired: course 1 goes, course 2 (a pre-fix row with a fire time) stays
    // behind its starter until course 1 has left 'pending'.
    await prisma.orderItem.updateMany({ where: { orderId: order.id, course: 1 }, data: { scheduledFireAt: new Date(Date.now() + 600_000) } })
    await updateOrderStatus(order.id, 'confirmed')
    await settle()
    await prisma.orderItem.updateMany({ where: { orderId: order.id, name: 'Wings' }, data: { scheduledFireAt: new Date(Date.now() - 1000) } })
    await processCoursePacingTick()
    items = await byName()
    expect(items.Wings!.status).toBe('preparing')
    expect(items.Fries!.status).toBe('pending')
    expect(items.Classic!.status).toBe('pending')
  })
})

// ─── BOH-16 ───────────────────────────────────────────────────────────────────

describe('BOH-16 — Fire course reaches the station screens', () => {
  it('emits item:updated to the station room and the company room, and lays out a step-routed dish', async () => {
    const { order } = await ingestOrder(dto([
      { id: friesId, name: 'Fries', course: 1 },
      { id: burgerId, name: 'Classic', course: 2 },
      { id: stackId, name: 'Smash stack', course: 2 },
    ]))
    await req('POST', `/expo/orders/${order.id}/fire`, tokenExpo, {})
    const classic = order.items.find((i) => i.name === 'Classic')!
    const stack = order.items.find((i) => i.name === 'Smash stack')!
    expect((await item(classic.id)).status).toBe('pending')         // expo fired course 1 only

    // Another company can't fire it.
    expect((await req('POST', `/orders/${order.id}/fire-course`, tokenB, { course: 2 })).statusCode).toBe(404)

    sent.length = 0
    const r = await req('POST', `/orders/${order.id}/fire-course`, tokenExpo, { course: 2 })
    expect(r.statusCode).toBe(200)
    expect((r.json() as { fired: number }).fired).toBe(2)
    await settle()

    const updates = sent.filter((s) => s.event === 'item:updated' && s.data.itemId === classic.id)
    expect(updates.map((u) => u.room)).toEqual(expect.arrayContaining([`station:${grillId}`, `tenant:${tenantA}:orders`]))
    expect(sent.some((s) => s.room.includes(tenantB) || s.room === `station:${grillB}`)).toBe(false)

    // The step-routed dish has its step on the grill, and the grill hears it.
    const steps = await prisma.orderItemStep.findMany({ where: { orderItemId: stack.id } })
    expect(steps.map((s) => [s.recipeStepId, s.stationId, s.status])).toEqual([[stackStepId, grillId, 'preparing']])
    expect(sent.some((s) => s.room === `station:${grillId}` && s.event === 'expo:fire' && s.data.itemId === stack.id)).toBe(true)
    const q = (await req('GET', `/expo/station/${grillId}/queue`, tokenExpo)).json() as { steps: Array<{ itemId: string }> }
    expect(q.steps.map((s) => s.itemId)).toContain(stack.id)

    // Nothing left at course 2.
    expect((await req('POST', `/orders/${order.id}/fire-course`, tokenExpo, { course: 2 })).statusCode).toBe(404)
  })

  it('the pacing worker fires through the same engine (steps + events)', async () => {
    const { order } = await ingestOrder(dto([{ id: stackId, name: 'Smash stack' }, { id: friesId, name: 'Fries' }]))
    await updateOrderStatus(order.id, 'confirmed')
    await settle()
    const stack = order.items.find((i) => i.name === 'Smash stack')!
    await prisma.orderItem.update({ where: { id: stack.id }, data: { scheduledFireAt: new Date(Date.now() - 1000) } })
    sent.length = 0
    await processCoursePacingTick()
    expect((await item(stack.id)).status).toBe('preparing')
    expect(await prisma.orderItemStep.count({ where: { orderItemId: stack.id } })).toBe(1)
    await settle()
    expect(sent.some((s) => s.room === `tenant:${tenantA}:orders` && s.event === 'item:updated' && s.data.itemId === stack.id)).toBe(true)
  })
})

// ─── UI-05 ────────────────────────────────────────────────────────────────────

type Queue = { awaitingFire: Array<{ id: string; paid: boolean }>; inProgress: Array<{ id: string }>; ready: Array<{ id: string }> }
const queue = async (token = tokenExpo) => (await req('GET', '/expo/queue', token)).json() as Queue
const column = (q: Queue, id: string) =>
  q.awaitingFire.some((o) => o.id === id) ? 'awaitingFire'
    : q.inProgress.some((o) => o.id === id) ? 'inProgress'
      : q.ready.some((o) => o.id === id) ? 'ready' : null

describe('UI-05 — a paid till order stays on expo until it is handed off', () => {
  async function ringUp() {
    return createPosOrder({
      conceptId: conceptA, staffId: adminA, staffRole: 'admin', shiftId, paymentMethod: 'cash',
      items: [{ menuItemId: burgerId, name: 'Classic', quantity: 1, unitPriceCents: 50_000, modifiers: [] }],
    })
  }
  const pay = async (o: { id: string; totalCents: number }) =>
    processPayment({ orderId: o.id, shiftId, payments: [{ method: 'cash', amountCents: o.totalCents, tenderedCents: o.totalCents }] })

  it('pay first: awaiting fire → in progress → ready → handed off, completed once at payment', async () => {
    const o = await ringUp()
    await pay(o)
    expect((await orderOf(o.id)).status).toBe('completed')
    let q = await queue()
    expect(column(q, o.id)).toBe('awaitingFire')
    expect(q.awaitingFire.find((x) => x.id === o.id)!.paid).toBe(true)
    // Company B's expo never sees it.
    expect(column(await queue(tokenB), o.id)).toBeNull()

    expect((await req('POST', `/expo/orders/${o.id}/fire`, tokenExpo, {})).statusCode).toBe(200)
    expect((await orderOf(o.id)).status).toBe('completed')
    q = await queue()
    expect(column(q, o.id)).toBe('inProgress')

    const tooEarly = await req('POST', `/expo/orders/${o.id}/handoff`, tokenExpo, {})
    expect(tooEarly.statusCode).toBe(409)

    await req('PATCH', `/order-items/${o.items[0]!.id}/status`, tokenExpo, { status: 'bumped' })
    expect(column(await queue(), o.id)).toBe('ready')

    const handoff = await req('POST', `/expo/orders/${o.id}/handoff`, tokenExpo, {})
    expect(handoff.statusCode).toBe(200)
    expect((handoff.json() as { completesOn: string }).completesOn).toBe('payment')
    expect(column(await queue(), o.id)).toBeNull()
    expect(await prisma.auditLog.count({ where: { entity: 'Order', entityId: o.id, action: 'order.complete' } })).toBe(1)
  })

  it('pay later: fired, cooked, handed off, then paid — still off the pass after payment', async () => {
    const o = await ringUp()
    expect(column(await queue(), o.id)).toBe('awaitingFire')
    await req('POST', `/expo/orders/${o.id}/fire`, tokenExpo, {})
    expect(column(await queue(), o.id)).toBe('inProgress')
    await req('PATCH', `/order-items/${o.items[0]!.id}/status`, tokenExpo, { status: 'bumped' })
    expect((await orderOf(o.id)).status).toBe('ready')
    expect(column(await queue(), o.id)).toBe('ready')
    expect((await req('POST', `/expo/orders/${o.id}/handoff`, tokenExpo, {})).statusCode).toBe(200)
    expect(column(await queue(), o.id)).toBeNull()

    await pay(o)
    expect((await orderOf(o.id)).status).toBe('completed')
    expect(column(await queue(), o.id)).toBeNull()
    expect(await prisma.auditLog.count({ where: { entity: 'Order', entityId: o.id, action: 'order.complete' } })).toBe(1)
  })
})

// ─── UI-14 ────────────────────────────────────────────────────────────────────

describe('UI-14 — an empty station roster means every station of the company', () => {
  it('a cook with no stations sees all of their company\'s active stations; a rostered cook sees theirs', async () => {
    const open = (await req('GET', '/kds/my-stations', tokenCook)).json() as { restricted: boolean; stations: Array<{ id: string }> }
    expect(open.restricted).toBe(false)
    expect(open.stations.map((s) => s.id).sort()).toEqual([grillId, fryId].sort())
    expect(open.stations.map((s) => s.id)).not.toContain(grillB)

    const rostered = (await req('GET', '/kds/my-stations', tokenCookRostered)).json() as { restricted: boolean; stations: Array<{ id: string }> }
    expect(rostered.restricted).toBe(true)
    expect(rostered.stations.map((s) => s.id)).toEqual([fryId])
  })
})
