// accounting/cogs.ts — cost of sales from the FIFO lots, by class.
//
// What this guards:
//   - One Dr 50x0 / Cr 12x0 pair per class from the lots the orders relieved,
//     both lines tagged with the brand; balanced.
//   - A line wasted after firing (sale_void rows) nets out of the order's cost.
//   - An order placed before the company's FIFO cut-over with no movements
//     books the legacy plate cost to 5010 / 1210 ('pre-FIFO order'); one placed
//     after it with no movements costs nothing.
//   - orderStockCostCents = the order's net lot value; unbooked cost counts
//     open orders and till orders whose home drawer close is not posted.
//   - Company: another company's orders never cost in this company's books.
import { describe, it, expect, beforeAll } from 'vitest'
import type { Prisma } from '@prisma/client'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { addLotTx, consumeFifoTx, relabelToWasteTx, fifoCutoverKey, STOCK_SOURCE } from '../src/lib/stockLedger.js'
import { cogsLinesForOrders, orderStockCostCents, unbookedSalesCostByClass, PRE_FIFO_MEMO } from '../src/modules/accounting/cogs.js'
import { postShiftClose } from '../src/modules/accounting/shiftPosting.js'

const DAY = 86_400_000
let A: string
let B: string
let conceptA: string
let conceptB: string
let menuA: string
let seq = 0
const tx = <T>(fn: (t: Prisma.TransactionClient) => Promise<T>) => prisma.$transaction(fn)

async function mkItem(tenantId: string, category: string, unitCostCents?: number) {
  const item = await prisma.inventoryItem.create({ data: { name: `Cogs item ${++seq}`, unit: 'kg', tenantId, category, unitCostCents: unitCostCents ?? null } })
  const src = `lot-${seq}`
  await tx((t) => addLotTx(t, {
    tenantId, inventoryItemId: item.id, qty: 100, unitCostCents: 100, kind: 'count_gain', lotSourceType: 'count_gain',
    lotSourceId: src, movementSourceType: 'test', movementSourceId: src, receivedAt: new Date(Date.now() - 5 * DAY),
  }))
  return item
}

async function mkOrder(conceptId: string, o: { placedAt?: Date; status?: 'received' | 'completed' | 'preparing'; source?: 'pos' | 'servd'; menuItemId?: string; qty?: number } = {}) {
  return prisma.order.create({
    data: {
      conceptId, source: o.source ?? 'servd', status: o.status ?? 'completed', totalCents: 5000, placedAt: o.placedAt ?? new Date(),
      items: { create: [{ name: 'Dish', quantity: o.qty ?? 1, unitPriceCents: 5000, menuItemId: o.menuItemId ?? null }] },
    },
    include: { items: true },
  })
}

function sell(tenantId: string, order: { id: string; conceptId: string; items: Array<{ id: string }> }, itemId: string, qty: number) {
  const line = order.items[0]!
  return tx((t) => consumeFifoTx(t, {
    tenantId, inventoryItemId: itemId, qty, kind: 'sale', sourceType: STOCK_SOURCE.orderItemSale, sourceId: line.id, clamp: true,
    orderId: order.id, orderItemId: line.id, conceptId: order.conceptId, theoreticalQty: qty, occurredAt: new Date(),
  }))
}

const sumOf = (lines: Array<{ type: string; amountCents: number }>, type: string) => lines.filter((l) => l.type === type).reduce((s, l) => s + l.amountCents, 0)

beforeAll(async () => {
  A = (await prisma.tenant.create({ data: { name: 'Cogs A', slug: 'cogs-class-a' } })).id
  B = (await prisma.tenant.create({ data: { name: 'Cogs B', slug: 'cogs-class-b' } })).id
  await ensureChartOfAccounts(A)
  await ensureChartOfAccounts(B)
  // A was cut over an hour ago; B never was.
  await prisma.setting.create({ data: { key: fifoCutoverKey(A), value: new Date(Date.now() - 3_600_000).toISOString() } })
  conceptA = (await prisma.concept.create({ data: { name: 'Cogs Diner', slug: 'cogs-class-a1', type: 'restaurant', tenantId: A } })).id
  conceptB = (await prisma.concept.create({ data: { name: 'Cogs Grill', slug: 'cogs-class-b1', type: 'restaurant', tenantId: B } })).id
  // A dish whose plate recipe is 100 g of an item at PKR 500 / kg (+10 % Q): PKR 55 a portion.
  const cat = await prisma.category.create({ data: { conceptId: conceptA, name: 'Mains' } })
  menuA = (await prisma.menuItem.create({ data: { conceptId: conceptA, categoryId: cat.id, name: 'Legacy Plate', priceCents: 50_000 } })).id
  const beef = await prisma.inventoryItem.create({ data: { name: 'Legacy beef', unit: 'kg', tenantId: A, unitCostCents: 50_000 } })
  await prisma.recipe.create({ data: { menuItemId: menuA, servings: 1, ingredients: { create: [{ inventoryItemId: beef.id, quantity: 100, unit: 'g', yieldPct: 1 }] } } })
})

describe('cogsLinesForOrders', () => {
  it('books one pair per class from the lots relieved, tagged with the brand; a voided line nets out', async () => {
    const food = await mkItem(A, 'protein')
    const drink = await mkItem(A, 'beverage')
    const box = await mkItem(A, 'packaging')
    const order = await mkOrder(conceptA)
    await sell(A, order, food.id, 3)     // 300
    const d = await sell(A, order, drink.id, 2)   // 200, then wasted after firing
    await sell(A, order, box.id, 1)      // 100
    const log = await prisma.wasteLog.create({ data: { inventoryItemId: drink.id, quantity: 2, unit: 'kg', reason: 'void_after_fire', tenantId: A, conceptId: conceptA, estimatedCostCents: 200 } })
    await tx((t) => relabelToWasteTx(t, { rows: d.rows, wasteLogIdByItem: { [drink.id]: log.id }, conceptId: conceptA, occurredAt: new Date(), tenantId: A }))

    const lines = await cogsLinesForOrders(A, [order.id], { conceptId: conceptA, memo: 'cogs-class-a1 #TEST' })
    expect(lines.map((l) => [l.accountCode, l.type, l.amountCents])).toEqual([
      ['5010', 'debit', 300], ['1210', 'credit', 300],
      ['5030', 'debit', 100], ['1230', 'credit', 100],
    ])
    expect(lines.every((l) => l.conceptId === conceptA)).toBe(true)
    expect(sumOf(lines, 'debit')).toBe(sumOf(lines, 'credit'))
    expect(await orderStockCostCents(order.id)).toBe(400)
  })

  it('sums several orders (a till close per brand) by class', async () => {
    const food = await mkItem(A, 'protein')
    const o1 = await mkOrder(conceptA, { source: 'pos' })
    const o2 = await mkOrder(conceptA, { source: 'pos' })
    await sell(A, o1, food.id, 1)
    await sell(A, o2, food.id, 4)
    const lines = await cogsLinesForOrders(A, [o1.id, o2.id, o1.id], { conceptId: conceptA, memo: '@ cogs-class-a1 (shift x)' })
    expect(lines.map((l) => [l.accountCode, l.amountCents])).toEqual([['5010', 500], ['1210', 500]])
  })

  it('a pre-cut-over order with no movements books the legacy plate cost to 5010 / 1210', async () => {
    const legacy = await mkOrder(conceptA, { placedAt: new Date(Date.now() - 2 * DAY), menuItemId: menuA, qty: 2 })
    const lines = await cogsLinesForOrders(A, [legacy.id], { conceptId: conceptA, memo: 'legacy' })
    expect(lines.map((l) => [l.accountCode, l.type, l.amountCents])).toEqual([['5010', 'debit', 11_000], ['1210', 'credit', 11_000]])
    expect(lines.every((l) => (l.memo ?? '').includes(PRE_FIFO_MEMO))).toBe(true)
    expect(await orderStockCostCents(legacy.id)).toBe(11_000)

    // Placed after the cut-over and nothing taken from the lots: no cost.
    const fresh = await mkOrder(conceptA, { menuItemId: menuA, qty: 2 })
    expect(await cogsLinesForOrders(A, [fresh.id], { conceptId: conceptA, memo: 'fresh' })).toEqual([])
    expect(await orderStockCostCents(fresh.id)).toBe(0)
  })

  it('a company never cut over books every order without movements the legacy way', async () => {
    const cat = await prisma.category.create({ data: { conceptId: conceptB, name: 'Mains' } })
    const menuB = (await prisma.menuItem.create({ data: { conceptId: conceptB, categoryId: cat.id, name: 'B Plate', priceCents: 10_000 } })).id
    const flour = await prisma.inventoryItem.create({ data: { name: 'B flour', unit: 'kg', tenantId: B, unitCostCents: 10_000 } })
    await prisma.recipe.create({ data: { menuItemId: menuB, servings: 1, qFactorPct: 0, ingredients: { create: [{ inventoryItemId: flour.id, quantity: 250, unit: 'g', yieldPct: 1 }] } } })
    const o = await mkOrder(conceptB, { menuItemId: menuB })
    const lines = await cogsLinesForOrders(B, [o.id], { conceptId: conceptB, memo: 'b' })
    expect(lines.map((l) => [l.accountCode, l.amountCents])).toEqual([['5010', 2500], ['1210', 2500]])
  })

  it('another company\'s orders never cost in this company\'s books', async () => {
    const food = await mkItem(A, 'protein')
    const o = await mkOrder(conceptA)
    await sell(A, o, food.id, 2)
    expect(await cogsLinesForOrders(B, [o.id], { conceptId: conceptB, memo: 'x' })).toEqual([])
    const legacy = await mkOrder(conceptA, { placedAt: new Date(Date.now() - 2 * DAY), menuItemId: menuA })
    expect(await cogsLinesForOrders(B, [legacy.id], { conceptId: conceptB, memo: 'x' })).toEqual([])
  })
})

describe('unbookedSalesCostByClass', () => {
  it('counts open orders and till orders whose home drawer close is not posted, nothing already booked', async () => {
    const T = (await prisma.tenant.create({ data: { name: 'Cogs C', slug: 'cogs-class-c' } })).id
    await prisma.setting.create({ data: { key: fifoCutoverKey(T), value: new Date(Date.now() - 3_600_000).toISOString() } })
    const concept = (await prisma.concept.create({ data: { name: 'Cogs Cafe', slug: 'cogs-class-c1', type: 'restaurant', tenantId: T } })).id
    const user = await prisma.user.create({ data: { name: 'Till', email: `till.${Date.now()}@cogs.test`, password: 'x', role: 'cashier', isActive: true, accountStatus: 'active', tenantId: T } })
    const shift = await prisma.shift.create({ data: { userId: user.id, tenantId: T } })
    const food = await mkItem(T, 'protein')
    const drink = await mkItem(T, 'beverage')

    const open = await mkOrder(concept, { status: 'preparing' })
    await sell(T, open, food.id, 2)                       // 200 food, not booked yet
    const till = await mkOrder(concept, { source: 'pos', status: 'completed' })
    await prisma.payment.create({ data: { orderId: till.id, shiftId: shift.id, method: 'cash', amountCents: 5000, status: 'paid' } })
    await sell(T, till, drink.id, 1)                      // 100 drinks, drawer still open
    const done = await mkOrder(concept, { status: 'completed' })
    await sell(T, done, food.id, 5)                       // booked at completion — not counted

    expect(await unbookedSalesCostByClass(prisma, T)).toEqual({ food: 200, beverage: 100, packaging: 0 })
    // Closed but its close not posted (refused, or not yet): the cost is out of the lots and not in the GL — still counted.
    await prisma.shift.update({ where: { id: shift.id }, data: { status: 'closed', closedAt: new Date(), closingFloatCents: 5000 } })
    expect(await unbookedSalesCostByClass(prisma, T)).toEqual({ food: 200, beverage: 100, packaging: 0 })
    // Its close posted: booked — no longer a reconciling item.
    await ensureChartOfAccounts(T)
    expect((await postShiftClose(shift.id)).posted).toBe(true)
    expect(await unbookedSalesCostByClass(prisma, T)).toEqual({ food: 200, beverage: 0, packaging: 0 })
  })
})
