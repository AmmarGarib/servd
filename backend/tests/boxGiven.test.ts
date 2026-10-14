// "Box given" through the till's door (finance wave B, w3-till):
// POST /pos/orders/:orderId/items/:itemId/box-given { undo? } — the route
// pos/boxGivenRoutes.ts in front of markBoxGiven (lib/recipeCost.ts →
// modules/orders/stock.ts). The owner's FINAL packaging rule: a dine-in line
// at a PLATE brand uses its packaging only when staff tap "Box given".
//
// What this guards (two companies):
//   - company B's staff get 404 on A's line, and a line that is not on the
//     order named is 404 too — nothing moves;
//   - a Simmer-style (plate) dine-in line: boxGiven true, its packaging taken
//     out of the lot once (a second tap writes nothing); an undo before
//     completion puts it back; an undo after completion → 409 ORDER_COMPLETED
//     in words;
//   - a takeaway line or a packaging-vessel (Stackd) line → 409 BOX_NOT_NEEDED;
//   - the pass (expediter) may tap; a role outside the till / floor / pass may not;
//   - a tap after the order's cost of sales was booked (an online order
//     completed at the hand-off) books its own Dr 5030 / Cr 1230 — the GL
//     packaging account moves exactly as the packaging lots do.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { randomUUID } from 'node:crypto'
import { AppError, errorResponse } from '../src/lib/errors.js'
import posBoxGivenRoutes from '../src/modules/pos/boxGivenRoutes.js'
import { addLotTx, fifoCutoverKey } from '../src/lib/stockLedger.js'
import { ingestOrder, deductInventoryForOrder } from '../src/modules/orders/service.js'
import { postOrderCompletion } from '../src/modules/accounting/orderPosting.js'
import { setFiscalKicker } from '../src/connectors/fiscal/outbox.js'
import { prisma, mkCompany, mkUser, caller, type Company, type Who } from './connectorsFixtures.js'

const DAY = 86_400_000
let app: FastifyInstance
let call: ReturnType<typeof caller>
let A: Company, B: Company
let cashierA: Who, expoA: Who, financeA: Who, cashierB: Who
let stackdConcept: string
let stackdDish: string
let beef: string
let box: string
let boxLot: string
let seq = 0

async function lot(tenantId: string, itemId: string, qty: number, unitCostCents: number) {
  const src = `bg-lot-${++seq}-${randomUUID().slice(0, 6)}`
  return prisma.$transaction((tx) => addLotTx(tx, {
    tenantId, inventoryItemId: itemId, qty, unitCostCents, kind: 'count_gain', lotSourceType: 'count_gain', lotSourceId: src,
    movementSourceType: 'test', movementSourceId: src, receivedAt: new Date(Date.now() - 5 * DAY),
  }))
}

/** One line of `menuItemId` rung up as `fulfilment` and its stock taken (as the kitchen fire would). */
async function ring(conceptId: string, menuItemId: string, fulfilment: 'dine_in' | 'takeout' | 'delivery') {
  const { order } = await ingestOrder({
    source: 'manual', external_id: randomUUID(), concept_id: conceptId, placed_at: new Date().toISOString(),
    customer_id: null, customer_name: null, loyalty_points_earned: null, delivery_notes: null, estimated_pickup: null,
    fulfilment_type: fulfilment,
    items: [{ externalItemId: '', menuItemId, name: 'Dish', quantity: 1, unitPriceCents: 100_000, modifiers: [] }],
    payment: { provider: null, amountCents: 100_000, status: 'pending' },
  })
  await deductInventoryForOrder(order.id)
  const line = await prisma.orderItem.findFirstOrThrow({ where: { orderId: order.id } })
  return { orderId: order.id, line }
}

const tap = (who: Who, orderId: string, itemId: string, body: Record<string, unknown> = {}) =>
  call(who, 'POST', `/pos/orders/${orderId}/items/${itemId}/box-given`, body)

const boxRows = (orderId: string) => prisma.stockMovement.findMany({ where: { orderId, inventoryItemId: box }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
const boxStock = async () => (await prisma.inventoryItem.findUniqueOrThrow({ where: { id: box } })).currentStock

/** GL net (debit − credit) of an account code in A. */
async function gl(code: string): Promise<number> {
  const ls = await prisma.journalLine.findMany({ where: { account: { tenantId: A.tenantId, code }, journalEntry: { tenantId: A.tenantId } }, select: { type: true, amountCents: true } })
  return ls.reduce((t, l) => t + (l.type === 'debit' ? 1 : -1) * Number(l.amountCents), 0)
}
async function packagingLotValue(): Promise<number> {
  const r = await prisma.stockLot.aggregate({ where: { tenantId: A.tenantId, costClass: 'packaging' }, _sum: { remainingValueCents: true } })
  return Number(r._sum.remainingValueCents ?? 0)
}

beforeAll(async () => {
  setFiscalKicker(async () => {})
  A = await mkCompany(`bg-a-${Date.now()}`)
  B = await mkCompany(`bg-b-${Date.now()}`)
  for (const t of [A.tenantId, B.tenantId]) await prisma.setting.create({ data: { key: fifoCutoverKey(t), value: new Date(Date.now() - 30 * DAY).toISOString() } })
  cashierA = await mkUser('bg-cashier-a', 'cashier', A.tenantId)
  expoA = await mkUser('bg-expo-a', 'expediter', A.tenantId)
  financeA = await mkUser('bg-finance-a', 'finance', A.tenantId)
  cashierB = await mkUser('bg-cashier-b', 'cashier', B.tenantId)
  stackdConcept = (await prisma.concept.create({
    data: { name: 'Stackd BG', slug: `bg-stackd-${Date.now()}`, type: 'restaurant', tenantId: A.tenantId, serviceVessel: 'packaging', taxRateCash: 15, taxRateCard: 8 },
  })).id
  const cat = await prisma.category.create({ data: { conceptId: stackdConcept, name: 'Sandwiches' } })
  stackdDish = (await prisma.menuItem.create({ data: { conceptId: stackdConcept, categoryId: cat.id, name: 'Club', priceCents: 100_000 } })).id
  beef = (await prisma.inventoryItem.create({ data: { tenantId: A.tenantId, name: 'Beef', unit: 'kg', category: 'protein' } })).id
  box = (await prisma.inventoryItem.create({ data: { tenantId: A.tenantId, name: 'Kraft box', unit: 'pcs', category: 'packaging' } })).id
  await lot(A.tenantId, beef, 50, 150_000)
  boxLot = (await lot(A.tenantId, box, 100, 3_000)).lotId
  for (const menuItemId of [A.items.nihari, stackdDish]) {
    await prisma.recipe.create({
      data: {
        kind: 'plate', menuItemId, servings: 1, qFactorPct: 0,
        ingredients: { create: [
          { inventoryItemId: beef, quantity: 100, unit: 'kg' },
          { inventoryItemId: box, quantity: 1, unit: 'pcs', section: 'packaging' },
        ] },
      },
    })
  }

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(posBoxGivenRoutes, { prefix: '/pos' })
  await app.ready()
  call = caller(app)
}, 60_000)

afterAll(async () => {
  setFiscalKicker(null)
  await app?.close()
})

describe('company separation', () => {
  it("company B's staff get 404 on A's line; a line not on the order named is 404; nothing moves", async () => {
    const { orderId, line } = await ring(A.conceptId, A.items.nihari, 'dine_in')
    const other = await ring(A.conceptId, A.items.nihari, 'dine_in')

    const b = await tap(cashierB, orderId, line.id)
    expect(b.statusCode, b.body).toBe(404)
    // A's own cashier, but the line belongs to another order.
    const wrong = await tap(cashierA, orderId, other.line.id)
    expect(wrong.statusCode, wrong.body).toBe(404)
    // Not an id at all.
    expect((await tap(cashierA, orderId, 'not-a-line')).statusCode).toBe(404)

    expect(await boxRows(orderId)).toHaveLength(0)
    expect(await boxRows(other.orderId)).toHaveLength(0)
    for (const id of [line.id, other.line.id]) expect((await prisma.orderItem.findUniqueOrThrow({ where: { id } })).boxGiven).toBe(false)
  })

  it('a role outside the till, the floor and the pass is refused; the pass may tap', async () => {
    const { orderId, line } = await ring(A.conceptId, A.items.nihari, 'dine_in')
    expect((await tap(financeA, orderId, line.id)).statusCode).toBe(403)
    const r = await tap(expoA, orderId, line.id)
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json()).toEqual({ boxGiven: true, depleted: true })
    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: line.id } })).boxGivenById).toBe(expoA.id)
  })
})

describe('a dine-in line at a plate brand', () => {
  it('takes the box once (a second tap writes nothing); undo before completion returns it; undo after completion → 409 ORDER_COMPLETED', async () => {
    const { orderId, line } = await ring(A.conceptId, A.items.nihari, 'dine_in')
    expect(line.serviceVessel).toBe('plate')
    expect(await boxRows(orderId)).toHaveLength(0)       // dine-in at a plate brand: no box at the fire
    const before = await boxStock()

    const first = await tap(cashierA, orderId, line.id)
    expect(first.statusCode, first.body).toBe(200)
    expect(first.json()).toEqual({ boxGiven: true, depleted: true })
    expect(await boxStock()).toBeCloseTo(before - 1, 6)
    const rows = await boxRows(orderId)
    expect(rows.map((r) => [r.kind, r.sourceType, r.lotId])).toEqual([['sale', 'order_item.box_given', boxLot]])
    const ln = await prisma.orderItem.findUniqueOrThrow({ where: { id: line.id } })
    expect(ln.boxGiven).toBe(true)
    expect(ln.boxGivenById).toBe(cashierA.id)
    expect(await prisma.auditLog.count({ where: { action: 'order.box_given', entityId: line.id, tenantId: A.tenantId } })).toBe(1)

    const second = await tap(cashierA, orderId, line.id)
    expect(second.statusCode, second.body).toBe(200)
    expect(second.json().boxGiven).toBe(true)
    expect(await boxRows(orderId)).toHaveLength(1)
    expect(await boxStock()).toBeCloseTo(before - 1, 6)
    expect(await prisma.auditLog.count({ where: { action: 'order.box_given', entityId: line.id, tenantId: A.tenantId } })).toBe(1)

    const undo = await tap(cashierA, orderId, line.id, { undo: true })
    expect(undo.statusCode, undo.body).toBe(200)
    expect(undo.json()).toEqual({ boxGiven: false, depleted: false })
    expect(await boxStock()).toBeCloseTo(before, 6)
    expect((await boxRows(orderId)).map((r) => [r.kind, r.lotId])).toEqual([['sale', boxLot], ['sale_return', boxLot]])
    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: line.id } })).boxGiven).toBe(false)

    // Boxed again, then the order completes: the undo is refused, in words.
    await new Promise((r) => setTimeout(r, 5))
    expect((await tap(cashierA, orderId, line.id)).json()).toEqual({ boxGiven: true, depleted: true })
    await prisma.order.update({ where: { id: orderId }, data: { status: 'completed', completedAt: new Date() } })
    const late = await tap(cashierA, orderId, line.id, { undo: true })
    expect(late.statusCode, late.body).toBe(409)
    expect(late.json().error.code).toBe('ORDER_COMPLETED')
    expect(late.json().error.message).toMatch(/complete/i)
    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: line.id } })).boxGiven).toBe(true)
    expect(await boxStock()).toBeCloseTo(before - 1, 6)
  })
})

describe('lines that already count their packaging', () => {
  it('a takeaway line and a packaging-vessel (Stackd) dine-in line → 409 BOX_NOT_NEEDED, in words', async () => {
    const t = await ring(A.conceptId, A.items.nihari, 'takeout')
    const tr = await tap(cashierA, t.orderId, t.line.id)
    expect(tr.statusCode, tr.body).toBe(409)
    expect(tr.json().error.code).toBe('BOX_NOT_NEEDED')
    expect(tr.json().error.message).toMatch(/packaging/i)

    const s = await ring(stackdConcept, stackdDish, 'dine_in')
    expect(s.line.serviceVessel).toBe('packaging')
    const sr = await tap(cashierA, s.orderId, s.line.id)
    expect(sr.statusCode, sr.body).toBe(409)
    expect(sr.json().error.code).toBe('BOX_NOT_NEEDED')

    // Only the sale's own packaging moved (one box each), nothing for the taps.
    expect((await boxRows(t.orderId)).map((r) => r.sourceType)).toEqual(['order_item.sale'])
    expect((await boxRows(s.orderId)).map((r) => r.sourceType)).toEqual(['order_item.sale'])
  })
})

describe('a tap after the order\'s cost of sales was booked', () => {
  it('an online order completed at the hand-off: the tap books Dr 5030 / Cr 1230 itself; ΔGL 1230 = Δ packaging lots', async () => {
    const { orderId, line } = await ring(A.conceptId, A.items.nihari, 'dine_in')
    await prisma.order.update({ where: { id: orderId }, data: { source: 'servd', status: 'completed', completedAt: new Date() } })
    expect((await postOrderCompletion(orderId)).posted).toBe(true)

    const lots0 = await packagingLotValue()
    const inv0 = await gl('1230')
    const cogs0 = await gl('5030')
    const r = await tap(cashierA, orderId, line.id)
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json()).toEqual({ boxGiven: true, depleted: true })
    expect((await tap(cashierA, orderId, line.id)).statusCode).toBe(200)    // a second tap books nothing more

    const dLots = (await packagingLotValue()) - lots0
    expect(dLots).toBe(-3_000)
    expect((await gl('1230')) - inv0).toBe(dLots)
    expect((await gl('5030')) - cogs0).toBe(3_000)
    const at = (await prisma.orderItem.findUniqueOrThrow({ where: { id: line.id } })).boxGivenAt!
    const entries = await prisma.journalEntry.findMany({
      where: { reference: { startsWith: `order_item.box_given:${line.id}@` } },
      include: { lines: { include: { account: { select: { code: true, tenantId: true } } } } },
    })
    expect(entries.map((e) => [e.reference, e.tenantId])).toEqual([[`order_item.box_given:${line.id}@${at.getTime()}`, A.tenantId]])
    expect(entries[0]!.lines.map((l) => [l.account.code, l.type, Number(l.amountCents), l.account.tenantId]).sort()).toEqual([
      ['1230', 'credit', 3_000, A.tenantId], ['5030', 'debit', 3_000, A.tenantId],
    ])
  })
})
