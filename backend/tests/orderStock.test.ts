// The sale side of food cost on FIFO lots (modules/orders/stock.ts,
// inventory/voidWaste.ts — finance wave B).
//
// What this guards (single company):
//   - a sale draws the OLDEST lot first, writes exactly its movements
//     ('order_item.sale' + line), and a replay writes nothing;
//   - an unfired void goes back to the very same lots, once;
//   - a fired void is relabelled sale_void + waste (stock unchanged), one
//     WasteLog per item with the FIFO value, Dr 5040 / Cr 1210 + Cr 1230 in the
//     order's company under 'pos.void_waste:<line>' — once;
//   - a cancel wastes the fired lines 'cancelled_after_fire' and returns the
//     unfired ones; its audit row carries the ORDER's company;
//   - a picked-up, not-delivered delivery order cancels through the same path
//     (no 409), its fired food wasted; nothing writes 'returned_food';
//   - a KDS recall books the recipe as 'remake' waste, once per recall;
//   - a pre-cut-over order (old `taken` JSON) cancels through the JSON path,
//     giving back through event-keyed 'legacy_return' lots;
//   - a staff meal is costed at the value of the lots it relieved.
// Two companies:
//   - B's order whose shared sub-recipe uses A's item (or a company-less one)
//     consumes nothing of A, writes nothing under A, one recipe_foreign_stock
//     flag in B;
//   - consumeFifoTx with a mismatched company throws;
//   - a modifierId of another dish is stored null (through ingestOrder).
import { describe, it, expect, beforeAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { prisma, mkCompany, mkUser, openDrawer, type Company, type Who } from './connectorsFixtures.js'
import { addLotTx, consumeFifoTx, fifoCutoverKey } from '../src/lib/stockLedger.js'
import {
  ingestOrder, deductInventoryForOrder, cancelOrder, updateItemStatus, returnVoidedLineStockTx,
} from '../src/modules/orders/service.js'
import { wasteSoldLineTx } from '../src/modules/inventory/voidWaste.js'
import { orderStockCostCents } from '../src/modules/accounting/cogs.js'
import { compOrder } from '../src/modules/pos/service.js'
import { setFiscalKicker } from '../src/connectors/fiscal/outbox.js'

let A: Company
let B: Company
let mgrA: Who
let mgrB: Who
let beefA: string
let boxA: string
let colaA: string
let seq = 0

const DAY = 86_400_000

async function cutOver(tenantId: string) {
  await prisma.setting.create({ data: { key: fifoCutoverKey(tenantId), value: new Date(Date.now() - 60 * DAY).toISOString() } })
}

async function lot(tenantId: string, itemId: string, qty: number, unitCostCents: number, ageDays: number) {
  const src = `ostk-lot-${++seq}`
  return prisma.$transaction((tx) => addLotTx(tx, {
    tenantId, inventoryItemId: itemId, qty, unitCostCents, kind: 'count_gain', lotSourceType: 'count_gain', lotSourceId: src,
    movementSourceType: 'test', movementSourceId: src, receivedAt: new Date(Date.now() - ageDays * DAY),
  }))
}

type Line = { menuItemId: string; name: string; quantity?: number; modifiers?: Array<{ name: string; priceDeltaCents: number; modifierId?: string | null }> }

async function ring(co: Company, lines: Line[], fulfilment: 'dine_in' | 'takeout' | 'delivery' = 'dine_in') {
  const { order } = await ingestOrder({
    source: 'manual', external_id: randomUUID(), concept_id: co.conceptId, placed_at: new Date().toISOString(),
    customer_id: null, customer_name: null, loyalty_points_earned: null, delivery_notes: null, estimated_pickup: null,
    fulfilment_type: fulfilment,
    items: lines.map((l) => ({ externalItemId: '', menuItemId: l.menuItemId, name: l.name, quantity: l.quantity ?? 1, unitPriceCents: 100_000, modifiers: l.modifiers ?? [] })),
    payment: { provider: null, amountCents: 100_000 * lines.length, status: 'pending' },
  })
  await deductInventoryForOrder(order.id)
  const items = await prisma.orderItem.findMany({ where: { orderId: order.id }, orderBy: { createdAt: 'asc' } })
  return { id: order.id, items }
}

const stockOf = async (id: string) => (await prisma.inventoryItem.findUniqueOrThrow({ where: { id } })).currentStock
const movesOf = (orderId: string) => prisma.stockMovement.findMany({ where: { orderId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
const entryOf = (reference: string) => prisma.journalEntry.findFirst({
  where: { reference }, include: { lines: { include: { account: { select: { code: true } } } } },
})

beforeAll(async () => {
  setFiscalKicker(async () => {})
  A = await mkCompany(`ostk-a-${Date.now()}`)
  B = await mkCompany(`ostk-b-${Date.now()}`)
  await cutOver(A.tenantId)
  await cutOver(B.tenantId)
  mgrA = await mkUser('ostk-mgr-a', 'foh_management', A.tenantId)
  mgrB = await mkUser('ostk-mgr-b', 'foh_management', B.tenantId)
  beefA = (await prisma.inventoryItem.create({ data: { tenantId: A.tenantId, name: 'Beef', unit: 'kg', category: 'protein', parLevel: 0 } })).id
  boxA = (await prisma.inventoryItem.create({ data: { tenantId: A.tenantId, name: 'Nihari box', unit: 'pcs', category: 'packaging' } })).id
  colaA = (await prisma.inventoryItem.create({ data: { tenantId: A.tenantId, name: 'Cola', unit: 'pcs', category: 'beverage' } })).id
  // Three beef lots: oldest PKR 1,000/kg, then 1,200, then 1,500.
  await lot(A.tenantId, beefA, 1, 100_000, 10)
  await lot(A.tenantId, beefA, 1, 120_000, 9)
  await lot(A.tenantId, beefA, 50, 150_000, 8)
  await lot(A.tenantId, boxA, 100, 3_000, 8)
  await lot(A.tenantId, colaA, 100, 8_000, 8)
  // Nihari: 150 g beef + a box in its Packaging section. Kheer stands in for a drink: 1 cola.
  await prisma.recipe.create({
    data: {
      kind: 'plate', menuItemId: A.items.nihari, servings: 1, qFactorPct: 10,
      ingredients: { create: [
        { inventoryItemId: beefA, quantity: 150, unit: 'kg' },
        { inventoryItemId: boxA, quantity: 1, unit: 'pcs', section: 'packaging' },
      ] },
    },
  })
  await prisma.recipe.create({
    data: { kind: 'plate', menuItemId: A.items.kheer, servings: 1, qFactorPct: 0, ingredients: { create: [{ inventoryItemId: colaA, quantity: 1, unit: 'pcs' }] } },
  })
}, 60_000)

describe('a sale on FIFO lots', () => {
  it('draws the oldest lot first, writes exactly its rows, and a replay writes nothing', async () => {
    const o = await ring(A, [{ menuItemId: A.items.nihari, name: 'Beef Nihari', quantity: 10 }])
    const rows = await movesOf(o.id)
    // 1.5 kg: the whole oldest lot (1 kg, PKR 1,000) then 0.5 kg of the next (PKR 600). Dine-in at a plate brand: no box.
    expect(rows.map((r) => [r.kind, r.inventoryItemId, r.qty, Number(r.valueCents), r.sourceType, r.sourceId])).toEqual([
      ['sale', beefA, -1, -100_000, 'order_item.sale', o.items[0]!.id],
      ['sale', beefA, -0.5, -60_000, 'order_item.sale', o.items[0]!.id],
    ])
    expect(rows.every((r) => r.conceptId === A.conceptId && r.orderItemId === o.items[0]!.id && r.tenantId === A.tenantId)).toBe(true)
    expect(await stockOf(beefA)).toBeCloseTo(50.5, 6)
    expect(await orderStockCostCents(o.id)).toBe(160_000)

    await deductInventoryForOrder(o.id)
    expect(await movesOf(o.id)).toHaveLength(2)
    const claim = await prisma.auditLog.findMany({ where: { entity: 'Order', entityId: o.id, action: 'stock.sale_deplete' } })
    expect(claim).toHaveLength(1)
    expect((claim[0]!.metadata as { mode: string }).mode).toBe('fifo')
  })

  it('an unfired void puts the stock back into the very same lots, once', async () => {
    const o = await ring(A, [{ menuItemId: A.items.nihari, name: 'Beef Nihari', quantity: 2 }])
    const line = o.items[0]!
    const before = await stockOf(beefA)
    const sale = (await movesOf(o.id)).filter((m) => m.kind === 'sale')
    await prisma.orderItem.update({ where: { id: line.id }, data: { status: 'voided', voidedAt: new Date() } })
    const back = () => prisma.$transaction((tx) => returnVoidedLineStockTx(tx, { orderId: o.id, tenantId: A.tenantId, line: { id: line.id, quantity: 2 } }))
    const r1 = await back()
    expect(r1.valueCents).toBe(Math.abs(sale.reduce((s, m) => s + Number(m.valueCents), 0)))
    expect(await stockOf(beefA)).toBeCloseTo(before + 0.3, 6)
    const ret = (await movesOf(o.id)).filter((m) => m.kind === 'sale_return')
    expect(ret.map((m) => m.lotId).sort()).toEqual(sale.map((m) => m.lotId).sort())
    expect(ret.every((m) => m.sourceType === 'order_item.return' && m.sourceId === line.id)).toBe(true)

    const r2 = await back()
    expect(r2.valueCents).toBe(0)
    expect(await stockOf(beefA)).toBeCloseTo(before + 0.3, 6)
    expect(await orderStockCostCents(o.id)).toBe(0)
  })

  it('a fired void is relabelled to waste: stock unchanged, a WasteLog per item, Dr 5040 / Cr 1210 + 1230 — once', async () => {
    const o = await ring(A, [{ menuItemId: A.items.nihari, name: 'Beef Nihari' }], 'takeout')
    const line = o.items[0]!
    const sale = (await movesOf(o.id)).filter((m) => m.kind === 'sale')
    expect(sale.map((m) => m.inventoryItemId).sort()).toEqual([beefA, boxA].sort())   // takeaway: the box applies
    const beefOut = await stockOf(beefA)
    const boxOut = await stockOf(boxA)
    await prisma.orderItem.update({ where: { id: line.id }, data: { status: 'voided', voidedAt: new Date() } })
    const waste = () => prisma.$transaction((tx) => wasteSoldLineTx(tx, {
      orderId: o.id, tenantId: A.tenantId, line: { id: line.id }, wasteReason: 'void_after_fire', actorId: mgrA.id, conceptId: A.conceptId,
    }))
    const w = await waste()
    expect(w.postingError).toBeUndefined()
    expect(w.wasteLogIds).toHaveLength(2)
    expect(await stockOf(beefA)).toBeCloseTo(beefOut, 6)
    expect(await stockOf(boxA)).toBeCloseTo(boxOut, 6)
    const logs = await prisma.wasteLog.findMany({ where: { orderItemId: line.id } })
    expect(logs.every((l) => l.reason === 'void_after_fire' && l.tenantId === A.tenantId && l.conceptId === A.conceptId)).toBe(true)
    const beefValue = -sale.filter((m) => m.inventoryItemId === beefA).reduce((s, m) => s + Number(m.valueCents), 0)
    expect(logs.find((l) => l.inventoryItemId === beefA)!.estimatedCostCents).toBe(beefValue)
    expect(logs.find((l) => l.inventoryItemId === boxA)!.estimatedCostCents).toBe(3_000)
    const kinds = (await movesOf(o.id)).map((m) => m.kind).sort()
    expect(kinds).toEqual(['sale', 'sale', 'sale_void', 'sale_void', 'waste', 'waste'])
    expect(await orderStockCostCents(o.id)).toBe(0)

    const je = await entryOf(`pos.void_waste:${line.id}`)
    expect(je?.tenantId).toBe(A.tenantId)
    const amt = (code: string, type: string) => je!.lines.filter((l) => l.account.code === code && l.type === type).reduce((s, l) => s + Number(l.amountCents), 0)
    expect(amt('5040', 'debit')).toBe(beefValue + 3_000)
    expect(amt('1210', 'credit')).toBe(beefValue)
    expect(amt('1230', 'credit')).toBe(3_000)

    const again = await waste()
    expect(again.wasteLogIds).toHaveLength(0)
    expect(await prisma.wasteLog.count({ where: { orderItemId: line.id } })).toBe(2)
    expect((await movesOf(o.id)).length).toBe(6)
  })
})

describe('cancel', () => {
  it('wastes the fired lines (cancelled_after_fire), returns the unfired, once; the audit row carries the order\'s company', async () => {
    const o = await ring(A, [{ menuItemId: A.items.nihari, name: 'Beef Nihari' }, { menuItemId: A.items.kheer, name: 'Kheer' }])
    const [nihari, kheer] = [o.items.find((i) => i.menuItemId === A.items.nihari)!, o.items.find((i) => i.menuItemId === A.items.kheer)!]
    await prisma.orderItem.update({ where: { id: nihari.id }, data: { status: 'bumped' } })
    const colaBefore = await stockOf(colaA)
    const beefBefore = await stockOf(beefA)
    // The operator's ACTIVE company is B; the order is A's.
    await cancelOrder(o.id, { reason: 'Guest walked out', actor: { id: mgrA.id, tenantId: B.tenantId }, approverId: mgrA.id })
    expect(await stockOf(colaA)).toBeCloseTo(colaBefore + 1, 6)
    expect(await stockOf(beefA)).toBeCloseTo(beefBefore, 6)          // fired: binned, never back on the shelf
    const logs = await prisma.wasteLog.findMany({ where: { orderItemId: nihari.id } })
    expect(logs.map((l) => l.reason)).toEqual(['cancelled_after_fire'])
    expect(await prisma.wasteLog.count({ where: { orderItemId: kheer.id } })).toBe(0)
    expect((await entryOf(`pos.void_waste:${nihari.id}`))?.tenantId).toBe(A.tenantId)
    const audit = await prisma.auditLog.findFirst({ where: { action: 'order.cancel', entityId: o.id } })
    expect(audit?.tenantId).toBe(A.tenantId)

    const n = (await movesOf(o.id)).length
    await cancelOrder(o.id, { reason: 'Again', actor: { id: mgrA.id, tenantId: A.tenantId } })
    expect((await movesOf(o.id)).length).toBe(n)
    expect(await orderStockCostCents(o.id)).toBe(0)
  })

  it('a picked-up, not-delivered delivery order cancels through the normal path — no 409, its fired food wasted', async () => {
    const o = await ring(A, [{ menuItemId: A.items.nihari, name: 'Beef Nihari' }], 'delivery')
    await prisma.orderItem.updateMany({ where: { orderId: o.id }, data: { status: 'bumped' } })
    await prisma.order.update({ where: { id: o.id }, data: { status: 'ready' } })
    const order = await cancelOrder(o.id, { reason: 'Customer refused at the door', actor: { id: mgrA.id, tenantId: A.tenantId } })
    expect(order.status).toBe('cancelled')
    const logs = await prisma.wasteLog.findMany({ where: { orderItemId: o.items[0]!.id } })
    expect(logs.map((l) => [l.inventoryItemId, l.reason]).sort()).toEqual([[beefA, 'cancelled_after_fire'], [boxA, 'cancelled_after_fire']].sort())
    expect(await prisma.wasteLog.count({ where: { reason: 'returned_food' } })).toBe(0)
  })
})

describe('KDS recall → remake', () => {
  it('books the recipe as remake waste, once per recall, at FIFO value, without the packaging', async () => {
    const o = await ring(A, [{ menuItemId: A.items.nihari, name: 'Beef Nihari', quantity: 2 }], 'takeout')
    const line = o.items[0]!
    await prisma.orderItem.update({ where: { id: line.id }, data: { status: 'bumped' } })
    await prisma.order.update({ where: { id: o.id }, data: { status: 'ready' } })
    const before = await stockOf(beefA)
    await updateItemStatus(line.id, 'recalled', mgrA.id)
    let logs = await prisma.wasteLog.findMany({ where: { orderItemId: line.id, reason: 'remake' } })
    expect(logs).toHaveLength(1)
    expect(logs[0]!.inventoryItemId).toBe(beefA)
    expect(logs[0]!.quantity).toBeCloseTo(0.3, 6)
    expect(logs[0]!.estimatedCostCents).toBe(45_000)                 // 0.3 kg at the head lot (PKR 1,500/kg)
    expect(await stockOf(beefA)).toBeCloseTo(before - 0.3, 6)
    const je = await entryOf(`inventory.waste:${logs[0]!.id}`)
    expect(je?.tenantId).toBe(A.tenantId)
    expect(je!.lines.find((l) => l.type === 'debit')!.account.code).toBe('5040')

    // Bumped again, recalled again: a second remake, its own log.
    await updateItemStatus(line.id, 'bumped', mgrA.id)
    await updateItemStatus(line.id, 'recalled', mgrA.id)
    logs = await prisma.wasteLog.findMany({ where: { orderItemId: line.id, reason: 'remake' } })
    expect(logs).toHaveLength(2)
    expect(await stockOf(beefA)).toBeCloseTo(before - 0.6, 6)
  })
})

describe('a pre-cut-over order', () => {
  it('cancels through its `taken` JSON and gives back through event-keyed legacy_return lots', async () => {
    const order = await prisma.order.create({
      data: {
        conceptId: A.conceptId, source: 'manual', status: 'received', totalCents: 100_000, placedAt: new Date(Date.now() - 90 * DAY),
        items: { create: [{ menuItemId: A.items.nihari, name: 'Beef Nihari', quantity: 2, unitPriceCents: 100_000 }] },
      },
      include: { items: true },
    })
    await prisma.auditLog.create({
      data: { category: 'stock', tenantId: A.tenantId, action: 'stock.sale_deplete', entity: 'Order', entityId: order.id, metadata: { taken: { [beefA]: 0.3 } } },
    })
    const before = await stockOf(beefA)
    await cancelOrder(order.id, { reason: 'Old ticket', actor: { id: mgrA.id, tenantId: A.tenantId } })
    expect(await stockOf(beefA)).toBeCloseTo(before + 0.3, 6)
    const lot = await prisma.stockLot.findFirstOrThrow({ where: { sourceType: 'legacy_return', sourceId: `${order.id}:cancel` } })
    expect(lot.tenantId).toBe(A.tenantId)
    expect(lot.qtyIn).toBeCloseTo(0.3, 6)
    // Replay: nothing more.
    await cancelOrder(order.id, { reason: 'Again', actor: { id: mgrA.id, tenantId: A.tenantId } })
    expect(await stockOf(beefA)).toBeCloseTo(before + 0.3, 6)
    expect(await prisma.stockLot.count({ where: { sourceType: 'legacy_return', sourceId: { startsWith: order.id } } })).toBe(1)
  })
})

describe('staff meal', () => {
  it('is costed at the value of the lots the meal relieved', async () => {
    const o = await ring(A, [{ menuItemId: A.items.kheer, name: 'Kheer', quantity: 2 }])
    const shiftId = await openDrawer(A, mgrA)
    const staff = await mkUser('ostk-staff-a', 'cashier', A.tenantId)
    const order = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })
    await prisma.order.update({ where: { id: o.id }, data: { source: 'pos', shiftId } })
    const r = await compOrder({ orderId: o.id, shiftId, amountCents: order.totalCents, reason: 'lunch', actorId: mgrA.id, actorRole: 'foh_management', staffMeal: { staffId: staff.id } })
    const meal = await prisma.staffMeal.findUniqueOrThrow({ where: { id: r.staffMealId! } })
    expect(meal.estimatedCostCents).toBe(16_000)                    // 2 colas at PKR 80 from the lot
  })
})

describe('two companies', () => {
  it('B\'s order whose sub-recipe uses A\'s (or a company-less) item consumes nothing of A, and B gets one recipe_foreign_stock flag', async () => {
    const loose = (await prisma.inventoryItem.create({ data: { tenantId: null, name: 'Loose salt', unit: 'kg', currentStock: 5 } })).id
    const shared = await prisma.recipe.create({
      data: {
        kind: 'component', name: 'Shared masala', yieldGrams: 100,
        ingredients: { create: [{ inventoryItemId: beefA, quantity: 100, unit: 'kg' }, { inventoryItemId: loose, quantity: 10, unit: 'kg' }] },
      },
    })
    await prisma.recipe.create({
      data: { kind: 'plate', menuItemId: B.items.nihari, servings: 1, ingredients: { create: [{ prepRecipeId: shared.id, quantity: 50, unit: 'g' }] } },
    })
    const beefBefore = await stockOf(beefA)
    const o1 = await ring(B, [{ menuItemId: B.items.nihari, name: 'Beef Nihari' }])
    const o2 = await ring(B, [{ menuItemId: B.items.nihari, name: 'Beef Nihari' }])
    expect(await stockOf(beefA)).toBeCloseTo(beefBefore, 6)
    expect(await stockOf(loose)).toBe(5)
    expect(await prisma.stockMovement.count({ where: { orderId: { in: [o1.id, o2.id] } } })).toBe(0)
    expect(await prisma.stockMovement.count({ where: { tenantId: A.tenantId, orderId: { in: [o1.id, o2.id] } } })).toBe(0)
    const flags = await prisma.exceptionFlag.findMany({ where: { kind: 'recipe_foreign_stock', entityId: B.items.nihari } })
    expect(flags).toHaveLength(1)
    expect(flags[0]!.tenantId).toBe(B.tenantId)
  })

  it('consumeFifoTx with another company\'s tenant throws', async () => {
    await expect(prisma.$transaction((tx) => consumeFifoTx(tx, {
      tenantId: B.tenantId, inventoryItemId: beefA, qty: 0.1, kind: 'sale', sourceType: 'order_item.sale', sourceId: randomUUID(), clamp: true, occurredAt: new Date(),
    }))).rejects.toMatchObject({ code: 'CROSS_COMPANY_STOCK' })
  })

  it('a modifierId of another dish is stored null (ingestOrder)', async () => {
    const groupA = await prisma.modifierGroup.create({ data: { menuItemId: A.items.kheer, name: 'Extras' } })
    const nuts = await prisma.modifier.create({ data: { groupId: groupA.id, name: 'Nuts', priceDeltaCents: 5_000 } })
    const groupB = await prisma.modifierGroup.create({ data: { menuItemId: B.items.kheer, name: 'Extras' } })
    const nutsB = await prisma.modifier.create({ data: { groupId: groupB.id, name: 'Nuts', priceDeltaCents: 5_000 } })
    const o = await ring(A, [
      { menuItemId: A.items.kheer, name: 'Kheer', modifiers: [{ name: 'Nuts', priceDeltaCents: 5_000, modifierId: nuts.id }] },
      { menuItemId: A.items.nihari, name: 'Beef Nihari', modifiers: [{ name: 'Nuts', priceDeltaCents: 5_000, modifierId: nuts.id }] },
      { menuItemId: A.items.kheer, name: 'Kheer', modifiers: [{ name: 'Nuts', priceDeltaCents: 5_000, modifierId: nutsB.id }] },
    ])
    const mods = await prisma.orderItemModifier.findMany({ where: { orderItem: { orderId: o.id } }, include: { orderItem: { select: { menuItemId: true, createdAt: true } } } })
    expect(mods.filter((m) => m.modifierId === nuts.id)).toHaveLength(1)                       // the kheer's own add-on only
    expect(mods.filter((m) => m.modifierId === null)).toHaveLength(2)                          // another dish's, another company's
  })

  it('every rung-up line snapshots its brand\'s vessel', async () => {
    const o = await ring(B, [{ menuItemId: B.items.kheer, name: 'Kheer' }])
    expect(o.items[0]!.serviceVessel).toBe('plate')
    void mgrB
  })
})
