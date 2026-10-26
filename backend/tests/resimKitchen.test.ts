// Kitchen re-sim fixes (2026-10-12, stream K).
//
// What this guards:
//   - BOH-R2-01: expo "Fire" respects course pacing. Only the course's lines
//     whose fire time is due (null or passed, after the schedule is re-anchored
//     to the fire) start; the shorter dishes stay pending and come back as
//     `paced` with their time, and the pacing worker fires them then. A paid
//     till sale is paced the same way. "Fire all now" (`fireAll: true`) is the
//     explicit override — manager tiers and the expediter only, audited — and
//     also finishes an order already fired. Company B can neither fire nor
//     fire-all company A's order (404).
//   - BOH-R2-04: a prep batch may cite only a sub-recipe of the ACTIVE company
//     (another company's, a plate or an unknown id → 422 RECIPE_NOT_IN_COMPANY,
//     nothing stored, no stock moved); the company's own sub-recipe still
//     records yield without drawing stock, an ad-hoc batch still draws.
//   - R2-UI-02: the buyer (role procurement, holds the module that links
//     /procurement/receiving) can READ the receiving page — receipts, open
//     POs, suppliers — scoped to its company; taking a delivery in (POST)
//     stays manager tiers (owner decision 27).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import type { OrderDTO } from '@servd/types'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { invalidateSetupCache } from '../src/lib/setup-config.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { ingestOrder, processCoursePacingTick } from '../src/modules/orders/service.js'
import { createPosOrder, processPayment } from '../src/modules/pos/service.js'
import { expoRoutes } from '../src/modules/expo/routes.js'
import { orderCourseRoutes } from '../src/modules/orders/routes.js'
import { crosschecksRoutes } from '../src/modules/crosschecks/routes.js'
import { addLotTx, ensureFifoReady } from '../src/lib/stockLedger.js'

let app: FastifyInstance
let tenantA: string
let tenantB: string
let conceptA: string
let conceptB: string
let burgerId: string
let friesId: string
let adminA: string
let shiftId: string
const tok: Record<string, string> = {}

function dto(items: Array<{ id: string; name: string; course?: number }>): OrderDTO {
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
  }
}

const call = (who: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as never, headers: { authorization: `Bearer ${tok[who]}` } })
const lines = async (orderId: string) => {
  const rows = await prisma.orderItem.findMany({ where: { orderId } })
  return Object.fromEntries(rows.map((r) => [r.name, r]))
}
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms))

/** Stock is held on FIFO lots (finance wave B): an item with stock on hand gets one lot for it. */
async function stockItem(data: { tenantId: string; name: string; unit: string; currentStock: number; unitCostCents?: number }) {
  await ensureFifoReady(data.tenantId)
  const item = await prisma.inventoryItem.create({ data: { ...data, currentStock: 0 } })
  await prisma.$transaction((tx) => addLotTx(tx, {
    tenantId: data.tenantId, inventoryItemId: item.id, qty: data.currentStock, unitCostCents: data.unitCostCents ?? 0,
    kind: 'fifo_cutover', lotSourceType: 'fifo_cutover', lotSourceId: `test-seed:${item.id}`,
    movementSourceType: 'test.seed', movementSourceId: item.id, receivedAt: new Date(Date.now() - 86_400_000),
  }))
  return item
}

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'Resim K A', slug: 'resim-k-a' } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'Resim K B', slug: 'resim-k-b' } })).id
  await ensureChartOfAccounts(tenantA)
  conceptA = (await prisma.concept.create({
    data: { name: 'K Flipd', slug: 'resim-k-flipd', type: 'restaurant', tenantId: tenantA, taxRateCash: 0, taxRateCard: 0, isActive: true },
  })).id
  conceptB = (await prisma.concept.create({
    data: { name: 'K Viva', slug: 'resim-k-viva', type: 'restaurant', tenantId: tenantB, taxRateCash: 0, taxRateCard: 0, isActive: true },
  })).id
  const cat = (await prisma.category.create({ data: { conceptId: conceptA, name: 'Mains' } })).id
  const grill = (await prisma.station.create({ data: { conceptId: conceptA, name: 'Grill', displayOrder: 1 } })).id
  const fry = (await prisma.station.create({ data: { conceptId: conceptA, name: 'Fry', displayOrder: 2 } })).id
  const menu = async (name: string, stationId: string, labor: number) => {
    const id = (await prisma.menuItem.create({ data: { conceptId: conceptA, categoryId: cat, name, priceCents: 50_000, stationId } })).id
    await prisma.recipe.create({ data: { kind: 'plate', menuItemId: id, laborMinutes: labor } })
    return id
  }
  burgerId = await menu('Classic', grill, 8)
  friesId = await menu('Fries', fry, 3)

  const mk = async (key: string, tenantId: string, role: string) => {
    const u = await prisma.user.create({
      data: { name: key, email: `resim-k-${key}@test.local`, password: 'x', role, isActive: true, accountStatus: 'active', tenantId } as never,
    })
    tok[key] = (issueStaffSession(u) as { accessToken: string }).accessToken
    return u.id
  }
  adminA = await mk('adminA', tenantA, 'admin')
  await mk('expoA', tenantA, 'expediter')
  await mk('cookA', tenantA, 'kitchen')
  await mk('expoB', tenantB, 'expediter')
  await mk('mgrB', tenantB, 'boh_management')
  await mk('cookB', tenantB, 'kitchen')
  await mk('buyerA', tenantA, 'procurement')
  await mk('buyerB', tenantB, 'procurement')
  await mk('mgrA', tenantA, 'boh_management')
  shiftId = (await prisma.shift.create({ data: { userId: adminA, openingFloatCents: 0, status: 'open', tenantId: tenantA } })).id

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(expoRoutes, { prefix: '/expo' })
  await app.register(orderCourseRoutes, { prefix: '/orders' })
  await app.register(crosschecksRoutes, { prefix: '/crosschecks' })
  await app.ready()
})

afterAll(async () => {
  invalidateSetupCache()
  await app?.close()
})

// ─── BOH-R2-01 ────────────────────────────────────────────────────────────────

type FireResp = { fired: number; course: number; paced: Array<{ id: string; name: string; scheduledFireAt: string }> }

describe('BOH-R2-01 — expo Fire respects course pacing', () => {
  it('fires the longest dish now; the shorter one is paced and the worker fires it at its time', async () => {
    const { order } = await ingestOrder(dto([{ id: burgerId, name: 'Classic' }, { id: friesId, name: 'Fries' }]))
    await settle()
    const t0 = Date.now()
    const res = await call('expoA', 'POST', `/expo/orders/${order.id}/fire`, {})
    expect(res.statusCode).toBe(200)
    const body = res.json() as FireResp
    expect(body.fired).toBe(1)
    expect(body.paced.map((p) => p.name)).toEqual(['Fries'])
    const at = new Date(body.paced[0]!.scheduledFireAt).getTime()
    expect(at - t0).toBeGreaterThan(4.5 * 60_000)   // 8 − 3 = 5 minutes after the fire
    expect(at - t0).toBeLessThan(5.5 * 60_000)

    let l = await lines(order.id)
    expect(l.Classic!.status).toBe('preparing')
    expect(l.Fries!.status).toBe('pending')
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('preparing')

    // Not due yet: the worker leaves it.
    await processCoursePacingTick()
    expect((await lines(order.id)).Fries!.status).toBe('pending')

    // The queue carries the fire time, so the screen can say "fires at 14:59".
    const q = (await call('expoA', 'GET', '/expo/queue')).json() as { inProgress: Array<{ id: string; items: Array<{ name: string; scheduledFireAt: string | null }> }> }
    const row = q.inProgress.find((o) => o.id === order.id)!
    expect(row.items.find((i) => i.name === 'Fries')!.scheduledFireAt).not.toBeNull()

    // A plain Fire on an order already fired is refused — the worker owns the rest.
    expect((await call('expoA', 'POST', `/expo/orders/${order.id}/fire`, {})).statusCode).toBe(409)

    // Its time comes: the worker fires it.
    await prisma.orderItem.update({ where: { id: l.Fries!.id }, data: { scheduledFireAt: new Date(Date.now() - 1000) } })
    await processCoursePacingTick()
    l = await lines(order.id)
    expect(l.Fries!.status).toBe('preparing')
  })

  it('a schedule that expired while the order waited is re-anchored, not fired all at once', async () => {
    const { order } = await ingestOrder(dto([{ id: burgerId, name: 'Classic' }, { id: friesId, name: 'Fries' }]))
    await settle()
    // The order sat in 'received' for 10 minutes: both creation-time fire times passed.
    await prisma.orderItem.updateMany({ where: { orderId: order.id }, data: { scheduledFireAt: new Date(Date.now() - 600_000) } })
    const body = (await call('expoA', 'POST', `/expo/orders/${order.id}/fire`, {})).json() as FireResp
    expect(body.fired).toBe(1)
    expect(body.paced.map((p) => p.name)).toEqual(['Fries'])
    const l = await lines(order.id)
    expect(l.Classic!.status).toBe('preparing')
    expect(l.Fries!.status).toBe('pending')
    expect(l.Fries!.scheduledFireAt!.getTime()).toBeGreaterThan(Date.now() + 4 * 60_000)
  })

  it('a paid till sale is paced too; a later Fire does not fire the paced dish early', async () => {
    const o = await createPosOrder({
      conceptId: conceptA, staffId: adminA, staffRole: 'admin', shiftId, paymentMethod: 'cash',
      items: [
        { menuItemId: burgerId, name: 'Classic', quantity: 1, unitPriceCents: 50_000, modifiers: [] },
        { menuItemId: friesId, name: 'Fries', quantity: 1, unitPriceCents: 50_000, modifiers: [] },
      ],
    })
    await processPayment({ orderId: o.id, shiftId, payments: [{ method: 'cash', amountCents: o.totalCents, tenderedCents: o.totalCents }] })
    await settle()
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('completed')

    const body = (await call('expoA', 'POST', `/expo/orders/${o.id}/fire`, {})).json() as FireResp
    expect(body.fired).toBe(1)
    expect(body.paced.map((p) => p.name)).toEqual(['Fries'])
    let l = await lines(o.id)
    expect(l.Classic!.status).toBe('preparing')
    expect(l.Fries!.status).toBe('pending')

    // Fire again (the old direct-API path): the paced dish stays paced.
    const again = await call('expoA', 'POST', `/expo/orders/${o.id}/fire`, {})
    expect(again.statusCode).toBe(200)
    expect((again.json() as FireResp).fired).toBe(0)
    l = await lines(o.id)
    expect(l.Fries!.status).toBe('pending')
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('completed')
  })

  it('"Fire all now": a line cook is refused; the expediter fires the paced dish at once (audited)', async () => {
    const { order } = await ingestOrder(dto([{ id: burgerId, name: 'Classic' }, { id: friesId, name: 'Fries' }]))
    await settle()
    expect((await call('expoA', 'POST', `/expo/orders/${order.id}/fire`, {})).json()).toMatchObject({ fired: 1 })

    const cook = await call('cookA', 'POST', `/expo/orders/${order.id}/fire`, { fireAll: true })
    expect(cook.statusCode).toBe(403)
    expect(cook.json().error.code).toBe('FIRE_ALL_NOT_ALLOWED')
    expect((await lines(order.id)).Fries!.status).toBe('pending')

    const all = await call('expoA', 'POST', `/expo/orders/${order.id}/fire`, { fireAll: true })
    expect(all.statusCode).toBe(200)
    expect(all.json()).toMatchObject({ fired: 1, paced: [] })
    expect((await lines(order.id)).Fries!.status).toBe('preparing')
    expect(await prisma.auditLog.count({ where: { entity: 'Order', entityId: order.id, action: 'expo.fire_all' } })).toBe(1)
  })

  it('"Fire all now" on a fresh order fires the whole course with nothing paced', async () => {
    const { order } = await ingestOrder(dto([{ id: burgerId, name: 'Classic' }, { id: friesId, name: 'Fries' }]))
    await settle()
    const res = await call('expoA', 'POST', `/expo/orders/${order.id}/fire`, { fireAll: true })
    expect(res.json()).toMatchObject({ fired: 2, paced: [] })
    const l = await lines(order.id)
    expect(l.Classic!.status).toBe('preparing')
    expect(l.Fries!.status).toBe('preparing')
  })

  it('company B cannot fire, or fire-all, company A\'s order (404)', async () => {
    const { order } = await ingestOrder(dto([{ id: burgerId, name: 'Classic' }, { id: friesId, name: 'Fries' }]))
    await settle()
    expect((await call('expoB', 'POST', `/expo/orders/${order.id}/fire`, {})).statusCode).toBe(404)
    expect((await call('mgrB', 'POST', `/expo/orders/${order.id}/fire`, { fireAll: true })).statusCode).toBe(404)
    const l = await lines(order.id)
    expect(l.Classic!.status).toBe('pending')
    expect(l.Fries!.status).toBe('pending')
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('received')
  })

  it('K-RV-03: an operator in both companies (A active) fire-alls B\'s order — the audit row carries B', async () => {
    // B's own menu, so B's order is wholly B's.
    const catB = (await prisma.category.create({ data: { conceptId: conceptB, name: 'Mains B' } })).id
    const grillB = (await prisma.station.create({ data: { conceptId: conceptB, name: 'Grill B', displayOrder: 1 } })).id
    const mkB = async (name: string, labor: number) => {
      const id = (await prisma.menuItem.create({ data: { conceptId: conceptB, categoryId: catB, name, priceCents: 50_000, stationId: grillB } })).id
      await prisma.recipe.create({ data: { kind: 'plate', menuItemId: id, laborMinutes: labor } })
      return id
    }
    const kebab = await mkB('Kebab', 8)
    const naan = await mkB('Naan', 3)
    const d = dto([{ id: kebab, name: 'Kebab' }, { id: naan, name: 'Naan' }])
    const { order } = await ingestOrder({ ...d, concept_id: conceptB })
    await settle()

    // A manager whose active company is A, and who is a member of A and B.
    const u = await prisma.user.create({
      data: { name: 'both', email: 'resim-k-both@test.local', password: 'x', role: 'boh_management', isActive: true, accountStatus: 'active', tenantId: tenantA } as never,
    })
    await prisma.tenantMember.createMany({ data: [{ userId: u.id, tenantId: tenantA }, { userId: u.id, tenantId: tenantB }] })
    tok.both = (issueStaffSession(u) as { accessToken: string }).accessToken

    const res = await call('both', 'POST', `/expo/orders/${order.id}/fire`, { fireAll: true })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ fired: 2, paced: [] })
    const rows = await prisma.auditLog.findMany({ where: { entity: 'Order', entityId: order.id, action: 'expo.fire_all' } })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.tenantId).toBe(tenantB)
  })
})

// ─── K-RV-01 / K-RV-02 — pacing outside expo's own route ───────────────────────
//
// Both fixes landed in orders/service.ts (fireCourse paces course 1;
// processCoursePacingTick re-anchors a till sale paid after its schedule
// expired) — integration pass 2.

describe('K-RV-01/02 — pacing holds outside expo Fire', () => {
  it('K-RV-01: a line cook\'s POST /orders/:id/fire-course {course:1} does not fire the paced dish early', async () => {
    const { order } = await ingestOrder(dto([{ id: burgerId, name: 'Classic' }, { id: friesId, name: 'Fries' }]))
    await settle()
    expect((await call('expoA', 'POST', `/expo/orders/${order.id}/fire`, {})).json()).toMatchObject({ fired: 1 })
    expect((await lines(order.id)).Fries!.status).toBe('pending')

    await call('cookA', 'POST', `/orders/${order.id}/fire-course`, { course: 1 })
    expect((await lines(order.id)).Fries!.status).toBe('pending')
    expect(await prisma.auditLog.count({ where: { entity: 'Order', entityId: order.id, action: 'expo.fire_all' } })).toBe(0)
  })

  it('K-RV-02: a till sale paid after its creation-time schedule expired is re-anchored, not fired all at once', async () => {
    const o = await createPosOrder({
      conceptId: conceptA, staffId: adminA, staffRole: 'admin', shiftId, paymentMethod: 'cash',
      items: [
        { menuItemId: burgerId, name: 'Classic', quantity: 1, unitPriceCents: 50_000, modifiers: [] },
        { menuItemId: friesId, name: 'Fries', quantity: 1, unitPriceCents: 50_000, modifiers: [] },
      ],
    })
    await settle()
    // Ten minutes at the counter before the card machine: both times passed.
    await prisma.orderItem.updateMany({ where: { orderId: o.id }, data: { scheduledFireAt: new Date(Date.now() - 600_000) } })
    await processPayment({ orderId: o.id, shiftId, payments: [{ method: 'cash', amountCents: o.totalCents, tenderedCents: o.totalCents }] })
    await settle()
    await processCoursePacingTick()
    const l = await lines(o.id)
    expect(l.Classic!.status).toBe('preparing')
    expect(l.Fries!.status).toBe('pending')
    expect(l.Fries!.scheduledFireAt!.getTime()).toBeGreaterThan(Date.now() + 4 * 60_000)
  })
})

// ─── BOH-R2-04 ────────────────────────────────────────────────────────────────

describe('BOH-R2-04 — a prep batch cites only the active company\'s sub-recipe', () => {
  let sauceA: string      // company A's sub-recipe (used by an A plate)
  let doughB: string      // company B's sub-recipe (used by a B plate)
  let plateA: string
  let attaB: string

  beforeAll(async () => {
    const mayoA = (await stockItem({ tenantId: tenantA, name: 'Mayo', unit: 'kg', currentStock: 10 })).id
    attaB = (await stockItem({ tenantId: tenantB, name: 'Atta', unit: 'kg', currentStock: 70, unitCostCents: 9_000 })).id
    sauceA = (await prisma.recipe.create({ data: { kind: 'component', name: 'Smash sauce', ingredients: { create: [{ inventoryItemId: mayoA, quantity: 100, unit: 'g' }] } } })).id
    doughB = (await prisma.recipe.create({ data: { kind: 'component', name: 'Viva dough', ingredients: { create: [{ inventoryItemId: attaB, quantity: 1000, unit: 'g' }] } } })).id
    // A's burger plate uses the sauce.
    plateA = (await prisma.recipe.findFirstOrThrow({ where: { menuItemId: burgerId } })).id
    await prisma.recipeIngredient.create({ data: { recipeId: plateA, prepRecipeId: sauceA, quantity: 30, unit: 'g' } })
    // B's naan plate uses the dough.
    const catB = (await prisma.category.create({ data: { conceptId: conceptB, name: 'Breads' } })).id
    const naan = (await prisma.menuItem.create({ data: { conceptId: conceptB, categoryId: catB, name: 'Naan', priceCents: 10_000 } })).id
    await prisma.recipe.create({ data: { kind: 'plate', menuItemId: naan, ingredients: { create: [{ prepRecipeId: doughB, quantity: 120, unit: 'g' }] } } })
  })

  const batch = (recipeId: string | null) => ({
    recipeId, itemName: 'dough', inputs: [{ inventoryItemId: attaB, qtyDrawn: 2, unit: 'kg' }], actualYieldQty: 3, unit: 'kg',
  })
  const stock = async () => (await prisma.inventoryItem.findUniqueOrThrow({ where: { id: attaB } })).currentStock

  it('another company\'s sub-recipe → 422, nothing stored, no stock moved', async () => {
    const before = await prisma.prepBatch.count({ where: { tenantId: tenantB } })
    const res = await call('cookB', 'POST', '/crosschecks/prep-batches', batch(sauceA))
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('RECIPE_NOT_IN_COMPANY')
    expect(await prisma.prepBatch.count({ where: { tenantId: tenantB } })).toBe(before)
    expect(await stock()).toBe(70)
  })

  it('an unknown id or a plate id → 422', async () => {
    expect((await call('cookB', 'POST', '/crosschecks/prep-batches', batch(crypto.randomUUID()))).json().error.code).toBe('RECIPE_NOT_IN_COMPANY')
    expect((await call('cookB', 'POST', '/crosschecks/prep-batches', batch(plateA))).json().error.code).toBe('RECIPE_NOT_IN_COMPANY')
    expect(await stock()).toBe(70)
  })

  it('the company\'s own sub-recipe draws its recipe and makes its prep item (prep as stock, 2026-10-24); ad hoc draws', async () => {
    const own = await call('cookB', 'POST', '/crosschecks/prep-batches', batch(doughB))
    expect(own.statusCode, own.body).toBe(201)
    expect(own.json()).toMatchObject({ recipeId: doughB, tenantId: tenantB })
    expect(await stock()).toBe(69)                    // one recipe batch: 1000 g of atta, whatever was typed
    expect((await prisma.inventoryItem.findFirstOrThrow({ where: { prepRecipeId: doughB, tenantId: tenantB } })).currentStock).toBe(3000)

    const adHoc = await call('cookB', 'POST', '/crosschecks/prep-batches', batch(null))
    expect(adHoc.statusCode, adHoc.body).toBe(201)
    expect(await stock()).toBe(67)
    // Drawn FIFO at the lot's cost (2 kg × PKR 90); a line cook sees no cost, only the ledger result.
    expect(adHoc.json()).toMatchObject({ drawValueCents: null, costsHidden: true, ledger: expect.objectContaining({ posted: expect.any(Boolean) }) })
    expect(Number((await prisma.prepBatch.findUniqueOrThrow({ where: { id: adHoc.json().id } })).drawValueCents)).toBe(18_000)

    // Company A's list never shows B's batches.
    const listA = (await call('adminA', 'GET', '/crosschecks/prep-batches')).json() as Array<{ tenantId: string }>
    expect(listA.every((b) => b.tenantId === tenantA)).toBe(true)
  })
})

// ─── R2-UI-02 ─────────────────────────────────────────────────────────────────

describe('R2-UI-02 — the buyer can read the receiving page, scoped to its company; receiving stays manager tiers', () => {
  let supA: string
  let supB: string
  let poA: string
  let poB: string
  let grA: string
  let grB: string

  beforeAll(async () => {
    supA = (await prisma.supplier.create({ data: { tenantId: tenantA, name: 'Meat Co A' } })).id
    supB = (await prisma.supplier.create({ data: { tenantId: tenantB, name: 'Flour Co B' } })).id
    poA = (await prisma.purchaseOrder.create({ data: { supplierId: supA, status: 'sent' } })).id
    poB = (await prisma.purchaseOrder.create({ data: { supplierId: supB, status: 'sent' } })).id
    grA = (await prisma.goodsReceipt.create({ data: { supplierId: supA, receivedById: adminA } })).id
    grB = (await prisma.goodsReceipt.create({ data: { supplierId: supB, receivedById: adminA } })).id
  })

  it('reads: receipts, open POs and suppliers — own company only', async () => {
    const receipts = await call('buyerA', 'GET', '/crosschecks/receiving')
    expect(receipts.statusCode).toBe(200)
    const rIds = (receipts.json() as Array<{ id: string }>).map((r) => r.id)
    expect(rIds).toContain(grA)
    expect(rIds).not.toContain(grB)

    const pos = await call('buyerA', 'GET', '/crosschecks/receiving/open-pos')
    expect(pos.statusCode).toBe(200)
    const pIds = (pos.json() as Array<{ id: string }>).map((p) => p.id)
    expect(pIds).toContain(poA)
    expect(pIds).not.toContain(poB)

    const sups = await call('buyerA', 'GET', '/crosschecks/receiving/suppliers')
    expect(sups.statusCode).toBe(200)
    const sIds = (sups.json() as Array<{ id: string }>).map((s) => s.id)
    expect(sIds).toContain(supA)
    expect(sIds).not.toContain(supB)

    // Company B's buyer sees B's, never A's.
    const bReceipts = (await call('buyerB', 'GET', '/crosschecks/receiving')).json() as Array<{ id: string }>
    expect(bReceipts.map((r) => r.id)).toEqual([grB])
    const bPos = (await call('buyerB', 'GET', '/crosschecks/receiving/open-pos')).json() as Array<{ id: string }>
    expect(bPos.map((p) => p.id)).toEqual([poB])
  })

  it('a line cook still cannot read it', async () => {
    expect((await call('cookA', 'GET', '/crosschecks/receiving')).statusCode).toBe(403)
    expect((await call('cookA', 'GET', '/crosschecks/receiving/open-pos')).statusCode).toBe(403)
  })

  it('taking a delivery in stays manager tiers (owner decision 27)', async () => {
    const res = await call('buyerA', 'POST', '/crosschecks/receiving', {
      supplierId: supA, photoUrl: 'https://example.com/dock.jpg', lines: [{ inventoryItemId: crypto.randomUUID(), quantityReceived: 1, unitCostCents: 100 }],
    })
    expect(res.statusCode).toBe(403)
  })
})
