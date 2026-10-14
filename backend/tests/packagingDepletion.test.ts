// The owner's FINAL packaging rule (2026-10-13) on the sale side:
// lib/recipeCost.ts packagingApplies + modules/orders/stock.ts.
//
// What this guards:
//   - a plate brand (Simmer) DINE-IN sale depletes NO packaging and its target
//     MC excludes it; the same dish takeaway or delivery depletes the box;
//   - a packaging-vessel brand (Stackd) dine-in sale depletes it;
//   - "Box given" on a Simmer dine-in line depletes the box once (a second tap
//     and a replay write nothing), an undo before completion returns it to the
//     same lot, a tap after the undo takes it again, an undo after completion
//     is 409; a tap BEFORE the depletion is taken by the depletion itself;
//   - "Box given" on a takeaway line (or at Stackd) → 409 BOX_NOT_NEEDED;
//     company B → 404 on A's line;
//   - changing the brand's vessel later does not change a line already rung
//     up (the vessel is snapshotted on the line).
import { describe, it, expect, beforeAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma, mkCompany, mkUser, type Company, type Who } from './connectorsFixtures.js'
import { addLotTx, fifoCutoverKey } from '../src/lib/stockLedger.js'
import { markBoxGiven, menuItemPlateCosts, packagingApplies } from '../src/lib/recipeCost.js'
import { ingestOrder, deductInventoryForOrder } from '../src/modules/orders/service.js'

const DAY = 86_400_000
let A: Company
let B: Company
let staffA: Who
let staffB: Who
let stackdConcept: string
let stackdDish: string
let beef: string
let box: string
let boxLot: string
let seq = 0

async function lot(tenantId: string, itemId: string, qty: number, unitCostCents: number) {
  const src = `pkg-lot-${++seq}`
  return prisma.$transaction((tx) => addLotTx(tx, {
    tenantId, inventoryItemId: itemId, qty, unitCostCents, kind: 'count_gain', lotSourceType: 'count_gain', lotSourceId: src,
    movementSourceType: 'test', movementSourceId: src, receivedAt: new Date(Date.now() - 5 * DAY),
  }))
}

async function ring(conceptId: string, menuItemId: string, fulfilment: 'dine_in' | 'takeout' | 'delivery', o: { deduct?: boolean } = {}) {
  const { order } = await ingestOrder({
    source: 'manual', external_id: randomUUID(), concept_id: conceptId, placed_at: new Date().toISOString(),
    customer_id: null, customer_name: null, loyalty_points_earned: null, delivery_notes: null, estimated_pickup: null,
    fulfilment_type: fulfilment,
    items: [{ externalItemId: '', menuItemId, name: 'Dish', quantity: 1, unitPriceCents: 100_000, modifiers: [] }],
    payment: { provider: null, amountCents: 100_000, status: 'pending' },
  })
  if (o.deduct !== false) await deductInventoryForOrder(order.id)
  const line = await prisma.orderItem.findFirstOrThrow({ where: { orderId: order.id } })
  return { orderId: order.id, line }
}

const boxRows = (orderId: string) => prisma.stockMovement.findMany({ where: { orderId, inventoryItemId: box }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
const boxStock = async () => (await prisma.inventoryItem.findUniqueOrThrow({ where: { id: box } })).currentStock

beforeAll(async () => {
  A = await mkCompany(`pkg-a-${Date.now()}`)
  B = await mkCompany(`pkg-b-${Date.now()}`)
  for (const t of [A.tenantId, B.tenantId]) await prisma.setting.create({ data: { key: fifoCutoverKey(t), value: new Date(Date.now() - 30 * DAY).toISOString() } })
  staffA = await mkUser('pkg-server-a', 'cashier', A.tenantId)
  staffB = await mkUser('pkg-server-b', 'cashier', B.tenantId)
  stackdConcept = (await prisma.concept.create({
    data: { name: `Stackd ${seq}`, slug: `pkg-stackd-${Date.now()}`, type: 'restaurant', tenantId: A.tenantId, serviceVessel: 'packaging', taxRateCash: 15, taxRateCard: 8 },
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
        kind: 'plate', menuItemId, servings: 1, qFactorPct: 10,
        ingredients: { create: [
          { inventoryItemId: beef, quantity: 100, unit: 'kg' },
          { inventoryItemId: box, quantity: 1, unit: 'pcs', section: 'packaging' },
        ] },
      },
    })
  }
}, 60_000)

describe('packagingApplies', () => {
  it('off-premise always; dine-in only at a packaging brand or when a box was given', () => {
    expect(packagingApplies({ fulfilmentType: 'takeout' }, { serviceVessel: 'plate', boxGiven: false })).toBe(true)
    expect(packagingApplies({ fulfilmentType: 'delivery' }, { serviceVessel: 'plate', boxGiven: false })).toBe(true)
    expect(packagingApplies({ fulfilmentType: 'dine_in' }, { serviceVessel: 'plate', boxGiven: false })).toBe(false)
    expect(packagingApplies({ fulfilmentType: 'dine_in' }, { serviceVessel: 'packaging', boxGiven: false })).toBe(true)
    expect(packagingApplies({ fulfilmentType: 'dine_in' }, { serviceVessel: 'plate', boxGiven: true })).toBe(true)
    // A legacy line with no snapshot reads the brand's current vessel.
    expect(packagingApplies({ fulfilmentType: 'dine_in' }, { serviceVessel: null, boxGiven: false }, { serviceVessel: 'packaging' })).toBe(true)
  })
})

describe('sales by order type and brand', () => {
  it('Simmer (plate) dine-in: no box, and the target MC leaves it out', async () => {
    const { orderId, line } = await ring(A.conceptId, A.items.nihari, 'dine_in')
    expect(line.serviceVessel).toBe('plate')
    expect(await boxRows(orderId)).toHaveLength(0)
    const cost = (await menuItemPlateCosts([A.items.nihari])).get(A.items.nihari)!
    expect(cost.standardCents).toBeCloseTo(15_000, 6)
    expect(cost.packagingCents).toBeCloseTo(3_000, 6)
    expect(cost.targetMcCents).toEqual({ dine_in: expect.closeTo(15_000, 6), takeout: expect.closeTo(18_000, 6), delivery: expect.closeTo(18_000, 6) })
  })

  it('the same dish takeaway and delivery takes the box', async () => {
    for (const f of ['takeout', 'delivery'] as const) {
      const { orderId } = await ring(A.conceptId, A.items.nihari, f)
      const rows = await boxRows(orderId)
      expect(rows.map((r) => [r.kind, r.qty, r.costClass, r.sourceType])).toEqual([['sale', -1, 'packaging', 'order_item.sale']])
    }
  })

  it('Stackd (packaging vessel) dine-in takes the box; its target MC dine-in includes it', async () => {
    const { orderId, line } = await ring(stackdConcept, stackdDish, 'dine_in')
    expect(line.serviceVessel).toBe('packaging')
    expect(await boxRows(orderId)).toHaveLength(1)
    const cost = (await menuItemPlateCosts([stackdDish])).get(stackdDish)!
    expect(cost.targetMcCents.dine_in).toBeCloseTo(18_000, 6)
  })
})

describe('"Box given" on a dine-in line at a plate brand', () => {
  it('takes the box once; a second tap and a replay write nothing; undo returns it to the same lot; after completion → 409', async () => {
    const { orderId, line } = await ring(A.conceptId, A.items.nihari, 'dine_in')
    const before = await boxStock()
    expect(await markBoxGiven(line.id, { id: staffA.id })).toEqual({ boxGiven: true, depleted: true })
    expect(await boxStock()).toBeCloseTo(before - 1, 6)
    let rows = await boxRows(orderId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.sourceType).toBe('order_item.box_given')
    expect(rows[0]!.lotId).toBe(boxLot)
    const ln = await prisma.orderItem.findUniqueOrThrow({ where: { id: line.id } })
    expect(ln.boxGiven).toBe(true)
    expect(ln.boxGivenById).toBe(staffA.id)
    expect(await prisma.auditLog.count({ where: { action: 'order.box_given', entityId: line.id, tenantId: A.tenantId } })).toBe(1)

    await markBoxGiven(line.id, { id: staffA.id })        // second tap
    await deductInventoryForOrder(orderId)                 // replay of the depletion
    expect(await boxRows(orderId)).toHaveLength(1)
    expect(await boxStock()).toBeCloseTo(before - 1, 6)

    expect(await markBoxGiven(line.id, { id: staffA.id }, { undo: true })).toEqual({ boxGiven: false, depleted: false })
    expect(await boxStock()).toBeCloseTo(before, 6)
    rows = await boxRows(orderId)
    expect(rows.map((r) => [r.kind, r.lotId])).toEqual([['sale', boxLot], ['sale_return', boxLot]])
    expect(await prisma.auditLog.count({ where: { action: 'order.box_given_undo', entityId: line.id, tenantId: A.tenantId } })).toBe(1)

    // Boxed again after the undo: a new tap, taken again.
    await new Promise((r) => setTimeout(r, 5))
    expect(await markBoxGiven(line.id, { id: staffA.id })).toEqual({ boxGiven: true, depleted: true })
    expect(await boxStock()).toBeCloseTo(before - 1, 6)

    await prisma.order.update({ where: { id: orderId }, data: { status: 'completed' } })
    await expect(markBoxGiven(line.id, { id: staffA.id }, { undo: true })).rejects.toMatchObject({ code: 'BOX_GIVEN_FINAL', statusCode: 409 })
  })

  it('a tap before the depletion is taken by the depletion itself, under the box key', async () => {
    const order = await prisma.order.create({
      data: {
        conceptId: A.conceptId, source: 'manual', status: 'received', fulfilmentType: 'dine_in', totalCents: 100_000,
        items: { create: [{ menuItemId: A.items.nihari, name: 'Dish', quantity: 1, unitPriceCents: 100_000, serviceVessel: 'plate' }] },
      },
      include: { items: true },
    })
    expect(await markBoxGiven(order.items[0]!.id, { id: staffA.id })).toEqual({ boxGiven: true, depleted: false })
    expect(await boxRows(order.id)).toHaveLength(0)
    await deductInventoryForOrder(order.id)
    const rows = await boxRows(order.id)
    expect(rows.map((r) => [r.kind, r.sourceType])).toEqual([['sale', 'order_item.box_given']])
  })

  it('a takeaway line or a packaging-brand line → 409 BOX_NOT_NEEDED', async () => {
    const t = await ring(A.conceptId, A.items.nihari, 'takeout')
    await expect(markBoxGiven(t.line.id, { id: staffA.id })).rejects.toMatchObject({ code: 'BOX_NOT_NEEDED', statusCode: 409 })
    const s = await ring(stackdConcept, stackdDish, 'dine_in')
    await expect(markBoxGiven(s.line.id, { id: staffA.id })).rejects.toMatchObject({ code: 'BOX_NOT_NEEDED', statusCode: 409 })
  })

  it('company B gets 404 on A\'s line, and nothing moves', async () => {
    const { orderId, line } = await ring(A.conceptId, A.items.nihari, 'dine_in')
    await expect(markBoxGiven(line.id, { id: staffB.id })).rejects.toMatchObject({ statusCode: 404 })
    await expect(markBoxGiven(line.id, { id: staffB.id, tenantIds: [B.tenantId] })).rejects.toMatchObject({ statusCode: 404 })
    expect(await boxRows(orderId)).toHaveLength(0)
    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: line.id } })).boxGiven).toBe(false)
  })
})

describe('the vessel is snapshotted at ring-up', () => {
  it('changing the brand\'s vessel later does not change a line already rung up', async () => {
    const before = await ring(A.conceptId, A.items.nihari, 'dine_in')
    await prisma.concept.update({ where: { id: A.conceptId }, data: { serviceVessel: 'packaging' } })
    try {
      const after = await ring(A.conceptId, A.items.nihari, 'dine_in')
      expect(after.line.serviceVessel).toBe('packaging')
      expect(await boxRows(after.orderId)).toHaveLength(1)
      // The earlier line is still a plate line: no box, and "Box given" still applies to it.
      expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: before.line.id } })).serviceVessel).toBe('plate')
      expect(await boxRows(before.orderId)).toHaveLength(0)
      expect(await markBoxGiven(before.line.id, { id: staffA.id })).toMatchObject({ boxGiven: true, depleted: true })
    } finally {
      await prisma.concept.update({ where: { id: A.conceptId }, data: { serviceVessel: 'plate' } })
    }
  })
})
