// Cost of sales in the sale postings (finance wave B, H16): order completion
// and the till's shift close book the value of the FIFO lots the orders
// actually relieved, one balanced pair per class (accounting/cogs.ts
// cogsLinesForOrders — the one cost-of-sales function):
//
//   food       Dr 5010 / Cr 1210      drinks     Dr 5020 / Cr 1220
//   packaging  Dr 5030 / Cr 1230
//
//   - order.complete posts one pair per class, tagged with the brand, memo
//     'COGS (<class>) <slug> #<ref>' — packaging to 5030 / 1230 for a DINE-IN
//     order too (a box given on a dine-in line relieves packaging lots);
//   - the shift close books per brand per class;
//   - an order placed before its company's FIFO cut-over (no movements) falls
//     back to the old plate cost, 5010 / 1210 memo'd 'pre-FIFO order';
//   - another company's lots never cost in this company's entry.
//
// Requires a disposable database (DATABASE_URL must contain "test").
import { describe, it, expect, beforeAll } from 'vitest'
import type { Prisma } from '@prisma/client'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { addLotTx, consumeFifoTx, fifoCutoverKey, STOCK_SOURCE } from '../src/lib/stockLedger.js'
import { PRE_FIFO_MEMO } from '../src/modules/accounting/cogs.js'
import { postOrderCompletion } from '../src/modules/accounting/orderPosting.js'
import { postShiftClose } from '../src/modules/accounting/shiftPosting.js'
import { orderRefOf } from '../src/lib/orderRef.js'

const RUN = Math.random().toString(36).slice(2, 8)
const DAY = 86_400_000
let A: string, B: string
let conceptA1: string, conceptA2: string, conceptB: string
let slugA1: string, slugA2: string
let menuB: string
let seq = 0
const tx = <T>(fn: (t: Prisma.TransactionClient) => Promise<T>) => prisma.$transaction(fn)

type Line = { code: string; type: string; amount: number; memo: string; conceptId: string | null }
async function entry(tenantId: string, reference: string): Promise<Line[] | null> {
  const je = await prisma.journalEntry.findFirst({
    where: { tenantId, reference },
    include: { lines: { include: { account: { select: { code: true } } } } },
  })
  return je ? je.lines.map((l) => ({ code: l.account.code, type: l.type, amount: l.amountCents, memo: l.memo ?? '', conceptId: l.conceptId })) : null
}
const amt = (lines: Line[], code: string, type: 'debit' | 'credit', conceptId?: string) =>
  lines.filter((l) => l.code === code && l.type === type && (conceptId === undefined || l.conceptId === conceptId)).reduce((t, l) => t + l.amount, 0)
const side = (lines: Line[], type: string) => lines.filter((l) => l.type === type).reduce((t, l) => t + l.amount, 0)

/** An item with one lot of 100 units at PKR 1 each. */
async function mkItem(tenantId: string, category: string) {
  const item = await prisma.inventoryItem.create({ data: { name: `Cogs post item ${RUN}-${++seq}`, unit: 'kg', tenantId, category } })
  const src = `cp-lot-${RUN}-${seq}`
  await tx((t) => addLotTx(t, {
    tenantId, inventoryItemId: item.id, qty: 100, unitCostCents: 100, kind: 'count_gain', lotSourceType: 'count_gain',
    lotSourceId: src, movementSourceType: 'test', movementSourceId: src, receivedAt: new Date(Date.now() - 5 * DAY),
  }))
  return item
}

async function mkOrder(conceptId: string, o: {
  source?: 'pos' | 'servd'; fulfilmentType?: 'dine_in' | 'takeout' | 'delivery'; total?: number; placedAt?: Date; menuItemId?: string | null; lines?: number
} = {}) {
  const total = o.total ?? 5_000
  const n = o.lines ?? 1
  return prisma.order.create({
    data: {
      conceptId, source: o.source ?? 'servd', fulfilmentType: o.fulfilmentType ?? 'delivery', status: 'completed', completedAt: new Date(),
      totalCents: total, placedAt: o.placedAt ?? new Date(),
      items: { create: Array.from({ length: n }, (_, i) => ({ name: `Dish ${i + 1}`, quantity: 1, unitPriceCents: Math.floor(total / n), menuItemId: o.menuItemId ?? null })) },
    },
    include: { items: { orderBy: { name: 'asc' } } },
  })
}

/** Relieve `qty` of `itemId` from the lots for line `lineIdx` of the order (what the sale / "Box given" does). */
function sell(tenantId: string, order: { id: string; conceptId: string; items: Array<{ id: string }> }, itemId: string, qty: number, lineIdx = 0, sourceType: string = STOCK_SOURCE.orderItemSale) {
  const line = order.items[lineIdx]!
  return tx((t) => consumeFifoTx(t, {
    tenantId, inventoryItemId: itemId, qty, kind: 'sale', sourceType, sourceId: line.id, clamp: true,
    orderId: order.id, orderItemId: line.id, conceptId: order.conceptId, theoreticalQty: qty, occurredAt: new Date(),
  }))
}

let cashierSeq = 0
async function freshShift(tenantId: string) {
  const u = await prisma.user.create({
    data: { name: `cp${++cashierSeq}`, email: `cp${cashierSeq}.${RUN}@cogsposting.test`, password: 'x', role: 'cashier', isActive: true, accountStatus: 'active', tenantId },
  })
  return prisma.shift.create({ data: { userId: u.id, openingFloatCents: 0, status: 'open', tenantId } })
}

beforeAll(async () => {
  A = (await prisma.tenant.create({ data: { name: 'Cogs post A', slug: `cp-a-${RUN}` } })).id
  B = (await prisma.tenant.create({ data: { name: 'Cogs post B', slug: `cp-b-${RUN}` } })).id
  await ensureChartOfAccounts(A)
  await ensureChartOfAccounts(B)
  // A went onto FIFO lots an hour ago; B never has.
  await prisma.setting.create({ data: { key: fifoCutoverKey(A), value: new Date(Date.now() - 3_600_000).toISOString() } })
  slugA1 = `cp-a1-${RUN}`
  slugA2 = `cp-a2-${RUN}`
  conceptA1 = (await prisma.concept.create({ data: { name: 'Cogs Diner', slug: slugA1, type: 'restaurant', tenantId: A, province: 'SD' } })).id
  conceptA2 = (await prisma.concept.create({ data: { name: 'Cogs Cafe', slug: slugA2, type: 'restaurant', tenantId: A, province: 'SD', serviceVessel: 'packaging' } })).id
  conceptB = (await prisma.concept.create({ data: { name: 'Cogs Grill', slug: `cp-b1-${RUN}`, type: 'restaurant', tenantId: B } })).id
  // B's legacy dish: 250 g of flour at PKR 100 / kg, no Q factor → PKR 25 a portion.
  const cat = await prisma.category.create({ data: { conceptId: conceptB, name: 'Mains' } })
  menuB = (await prisma.menuItem.create({ data: { conceptId: conceptB, categoryId: cat.id, name: 'B Plate', priceCents: 10_000 } })).id
  const flour = await prisma.inventoryItem.create({ data: { name: `B flour ${RUN}`, unit: 'kg', tenantId: B, unitCostCents: 10_000 } })
  await prisma.recipe.create({ data: { menuItemId: menuB, servings: 1, qFactorPct: 0, ingredients: { create: [{ inventoryItemId: flour.id, quantity: 250, unit: 'g', yieldPct: 1 }] } } })
})

describe('order.complete — cost of sales by class from the lots', () => {
  it('posts one pair per class, tagged with the brand, memo COGS (<class>) <slug> #<ref>', async () => {
    const food = await mkItem(A, 'protein')
    const drink = await mkItem(A, 'beverage')
    const box = await mkItem(A, 'packaging')
    const order = await mkOrder(conceptA1, { total: 5_000 })
    await sell(A, order, food.id, 3)     // PKR 3
    await sell(A, order, drink.id, 2)    // PKR 2
    await sell(A, order, box.id, 1)      // PKR 1

    expect((await postOrderCompletion(order.id)).posted).toBe(true)
    const lines = (await entry(A, `order.complete:${order.id}`))!
    expect(side(lines, 'debit')).toBe(side(lines, 'credit'))
    expect(amt(lines, '5010', 'debit')).toBe(300)
    expect(amt(lines, '1210', 'credit')).toBe(300)
    expect(amt(lines, '5020', 'debit')).toBe(200)
    expect(amt(lines, '1220', 'credit')).toBe(200)
    expect(amt(lines, '5030', 'debit')).toBe(100)
    expect(amt(lines, '1230', 'credit')).toBe(100)
    const cogs = lines.filter((l) => /^(50[123]0|12[123]0)$/.test(l.code))
    expect(cogs).toHaveLength(6)
    expect(cogs.every((l) => l.conceptId === conceptA1)).toBe(true)
    const ref = `${slugA1} #${orderRefOf(order.id)}`
    expect(lines.find((l) => l.code === '5010')!.memo).toBe(`COGS (Food) ${ref}`)
    expect(lines.find((l) => l.code === '5020')!.memo).toBe(`COGS (Drinks) ${ref}`)
    expect(lines.find((l) => l.code === '5030')!.memo).toBe(`COGS (Packaging) ${ref}`)
    expect(lines.some((l) => l.memo.includes(PRE_FIFO_MEMO))).toBe(false)
  })

  it('packaging goes to 5030 / 1230 for a DINE-IN order too (a box given on the line)', async () => {
    const food = await mkItem(A, 'protein')
    const box = await mkItem(A, 'packaging')
    // An online dine-in order (booked by its own completion entry).
    const order = await mkOrder(conceptA1, { fulfilmentType: 'dine_in', total: 4_000 })
    await sell(A, order, food.id, 4)
    // "Box given": its own stock source, so it is not the line's sale call.
    await sell(A, order, box.id, 1, 0, 'order_item.box')
    expect((await postOrderCompletion(order.id)).posted).toBe(true)
    const lines = (await entry(A, `order.complete:${order.id}`))!
    expect(side(lines, 'debit')).toBe(side(lines, 'credit'))
    expect(amt(lines, '5010', 'debit')).toBe(400)
    expect(amt(lines, '5030', 'debit', conceptA1)).toBe(100)
    expect(amt(lines, '1230', 'credit', conceptA1)).toBe(100)
  })

  it('an order with no movements placed after the cut-over costs nothing (no COGS lines)', async () => {
    const order = await mkOrder(conceptA1, { total: 3_000 })
    expect((await postOrderCompletion(order.id)).posted).toBe(true)
    const lines = (await entry(A, `order.complete:${order.id}`))!
    expect(lines.some((l) => /^50[123]0$/.test(l.code))).toBe(false)
  })

  it("a pre-cut-over order falls back to the legacy pair, 5010 / 1210 memo'd 'pre-FIFO order'", async () => {
    const order = await mkOrder(conceptB, { menuItemId: menuB, total: 10_000, placedAt: new Date(Date.now() - 2 * DAY) })
    expect((await postOrderCompletion(order.id)).posted).toBe(true)
    const lines = (await entry(B, `order.complete:${order.id}`))!
    expect(side(lines, 'debit')).toBe(side(lines, 'credit'))
    expect(amt(lines, '5010', 'debit')).toBe(2_500)
    expect(amt(lines, '1210', 'credit')).toBe(2_500)
    expect(lines.some((l) => /^(5020|5030|1220|1230)$/.test(l.code))).toBe(false)
    const pair = lines.filter((l) => l.code === '5010' || l.code === '1210')
    expect(pair.every((l) => l.memo.includes(PRE_FIFO_MEMO) && l.conceptId === conceptB)).toBe(true)
  })
})

describe('shift.close — cost of sales per brand, per class', () => {
  it('books each brand its own pairs by class from the lots its orders relieved', async () => {
    const food = await mkItem(A, 'protein')
    const drink = await mkItem(A, 'beverage')
    const box = await mkItem(A, 'packaging')
    const shift = await freshShift(A)
    // Brand 1: a dine-in plate (food) + a drink. Brand 2 (packaging is its vessel): food + its box.
    const o1 = await mkOrder(conceptA1, { source: 'pos', fulfilmentType: 'dine_in', total: 6_000, lines: 2 })
    const o2 = await mkOrder(conceptA2, { source: 'pos', fulfilmentType: 'dine_in', total: 4_000 })
    const o3 = await mkOrder(conceptA1, { source: 'pos', fulfilmentType: 'takeout', total: 2_000 })
    await sell(A, o1, food.id, 5)         // A1 food 500
    await sell(A, o1, drink.id, 3, 1)     // A1 drinks 300
    await sell(A, o2, food.id, 2)         // A2 food 200
    await sell(A, o2, box.id, 2, 0, 'order_item.box')   // A2 packaging 200
    await sell(A, o3, box.id, 1)          // A1 packaging 100 (takeaway packaging)
    for (const [o, cents] of [[o1, 6_000], [o2, 4_000], [o3, 2_000]] as const) {
      await prisma.payment.create({ data: { orderId: o.id, shiftId: shift.id, method: 'cash', amountCents: cents, status: 'paid', processedAt: new Date() } })
    }
    await prisma.shift.update({ where: { id: shift.id }, data: { status: 'closed', closedAt: new Date(), closingFloatCents: 12_000 } })
    expect((await postShiftClose(shift.id)).posted).toBe(true)
    const lines = (await entry(A, `shift.close:${shift.id}`))!
    expect(side(lines, 'debit')).toBe(side(lines, 'credit'))

    expect(amt(lines, '5010', 'debit', conceptA1)).toBe(500)
    expect(amt(lines, '1210', 'credit', conceptA1)).toBe(500)
    expect(amt(lines, '5020', 'debit', conceptA1)).toBe(300)
    expect(amt(lines, '1220', 'credit', conceptA1)).toBe(300)
    expect(amt(lines, '5030', 'debit', conceptA1)).toBe(100)
    expect(amt(lines, '1230', 'credit', conceptA1)).toBe(100)

    expect(amt(lines, '5010', 'debit', conceptA2)).toBe(200)
    expect(amt(lines, '5020', 'debit', conceptA2)).toBe(0)
    expect(amt(lines, '5030', 'debit', conceptA2)).toBe(200)
    expect(amt(lines, '1230', 'credit', conceptA2)).toBe(200)

    // One pair per class per brand, memo '@ <slug> (shift …)'.
    expect(lines.filter((l) => l.code === '5010')).toHaveLength(2)
    const tag = `(shift ${shift.id.slice(0, 8)})`
    expect(lines.find((l) => l.code === '5010' && l.conceptId === conceptA2)!.memo).toBe(`COGS (Food) @ ${slugA2} ${tag}`)
    expect(lines.find((l) => l.code === '1230' && l.conceptId === conceptA1)!.memo).toBe(`Inventory used (Packaging) @ ${slugA1} ${tag}`)
  })

  it("a pre-cut-over till order books the legacy pair at the close; another company's lots never cost here", async () => {
    const shift = await freshShift(B)
    const o = await mkOrder(conceptB, { source: 'pos', fulfilmentType: 'dine_in', menuItemId: menuB, total: 10_000 })
    // A's lots relieved against B's order id are A's movements, never B's cost.
    const food = await mkItem(A, 'protein')
    await sell(A, o, food.id, 7)
    await prisma.payment.create({ data: { orderId: o.id, shiftId: shift.id, method: 'cash', amountCents: 10_000, status: 'paid', processedAt: new Date() } })
    await prisma.shift.update({ where: { id: shift.id }, data: { status: 'closed', closedAt: new Date(), closingFloatCents: 10_000 } })
    expect((await postShiftClose(shift.id)).posted).toBe(true)
    const lines = (await entry(B, `shift.close:${shift.id}`))!
    expect(side(lines, 'debit')).toBe(side(lines, 'credit'))
    // B was never cut over: the order's old plate cost.
    expect(amt(lines, '5010', 'debit', conceptB)).toBe(2_500)
    expect(lines.filter((l) => l.code === '5010').every((l) => l.memo.includes(PRE_FIFO_MEMO))).toBe(true)
  })
})
