// reports/foodCost.ts — THE food-cost variance report (finance wave B).
//
// What this guards:
//   - the identity theoretical + explained + unexplained + alignment + timing
//     == the ledger's cost of sales (5010–5060), per company and per brand;
//     an open ticket booked by its closed drawer shows as timing;
//   - packaging is in the theoretical for a Simmer takeaway and delivery
//     order, a Stackd dine-in order and a Simmer dine-in line marked "Box
//     given" — NOT for a plain Simmer dine-in order; MC by order type;
//   - a staff meal is its own bucket, a refunded order stays in theoretical;
//   - revenue is brand sales only: service charge (4100), delivery fees
//     (4110) and other income (4200) never move it;
//   - waste by reason (measured vs usage-allocated), count variance and 5060
//     from the stock documents / ledger;
//   - an order completed at 23:30 PKT falls on its PKT day;
//   - zero revenue → 'no_data'; a null-cost lot → 'incomplete';
//   - the valuation ties to the GL when everything is posted (incl. an open
//     ticket whose home drawer closed);
//   - inventoryCloseChecks warn on a stale GRNI line;
//   - management (close-06): 42xx other income raises a brand's net profit,
//     never its revenue; costOfSalesPct + food / drinks / packaging split.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { prisma, mkCompany, mkUser, type Company, type Who } from './connectorsFixtures.js'
import { AppError, errorResponse } from '../src/lib/errors.js'
import { addLotTx, consumeFifoTx, fifoCutoverKey, STOCK_SOURCE } from '../src/lib/stockLedger.js'
import { markBoxGiven } from '../src/lib/recipeCost.js'
import { ingestOrder, deductInventoryForOrder } from '../src/modules/orders/service.js'
import { postOrderCompletion } from '../src/modules/accounting/orderPosting.js'
import { postJournalEntry } from '../src/modules/accounting/journal.js'
import { postWasteLog, postStockCount } from '../src/modules/accounting/inventoryPosting.js'
import { postShiftClose } from '../src/modules/accounting/shiftPosting.js'
import { brandSalesRevenueCents } from '../src/modules/accounting/reports.js'
import { fmtPktDate, parsePktStartOfDay, parsePktEndOfDay } from '../src/modules/accounting/dates.js'
import { managementRoutes } from '../src/modules/management/routes.js'
import { listStockDifferences } from '../src/modules/stockDifferences/service.js'
import {
  foodCostSummary, inventoryValuation, ingredientVariance, inventoryCloseChecks, type FoodCostCompanyBlock,
} from '../src/modules/reports/foodCost.js'

const DAY = 86_400_000
const NOW = Date.now()
const dayAgo = (n: number) => fmtPktDate(new Date(NOW - n * DAY))
const WIN = { from: parsePktStartOfDay(dayAgo(2)), to: parsePktEndOfDay(dayAgo(0)) }

let A: Company
let B: Company
let ceo: Who
let cashier: Who
let stackd: string
let club: string
let beef: string
let cola: string
let box: string
let seq = 0

async function lot(tenantId: string, itemId: string, qty: number, unitCostCents: number) {
  const src = `fc-open-${++seq}`
  await prisma.$transaction((tx) => addLotTx(tx, {
    tenantId, inventoryItemId: itemId, qty, unitCostCents, kind: 'opening', lotSourceType: 'opening', lotSourceId: src,
    movementSourceType: 'test.opening', movementSourceId: src, receivedAt: new Date(NOW - 5 * DAY),
  }))
}

/** Ring a 1 × dish order through ingestOrder and deplete it (the real packaging rule). */
async function ring(conceptId: string, menuItemId: string, fulfilment: 'dine_in' | 'takeout' | 'delivery', source: 'manual' | 'pos' = 'manual') {
  const { order } = await ingestOrder({
    source, external_id: randomUUID(), concept_id: conceptId, placed_at: new Date().toISOString(),
    customer_id: null, customer_name: null, loyalty_points_earned: null, delivery_notes: null, estimated_pickup: null,
    fulfilment_type: fulfilment,
    items: [{ externalItemId: '', menuItemId, name: 'Dish', quantity: 1, unitPriceCents: 100_000, modifiers: [] }],
    payment: { provider: null, amountCents: 100_000, status: 'pending' },
  })
  await deductInventoryForOrder(order.id)
  const line = await prisma.orderItem.findFirstOrThrow({ where: { orderId: order.id } })
  return { orderId: order.id, lineId: line.id }
}

async function complete(orderId: string, at: Date = new Date(NOW - 60_000), post = true) {
  await prisma.order.update({ where: { id: orderId }, data: { status: 'completed', completedAt: at } })
  if (post) expect((await postOrderCompletion(orderId)).posted).toBe(true)
}

const block = async (tenantId: string, w = WIN, extra: { conceptId?: string; revenueVisible?: boolean } = {}): Promise<FoodCostCompanyBlock> =>
  (await foodCostSummary(prisma, { tenantIds: [tenantId], from: w.from, to: w.to, revenueVisible: extra.revenueVisible ?? true, ...(extra.conceptId ? { conceptId: extra.conceptId } : {}) }))[0]!

let openTicketCost = 0

beforeAll(async () => {
  A = await mkCompany(`fcr-a-${NOW}`)
  B = await mkCompany(`fcr-b-${NOW}`)
  for (const t of [A.tenantId, B.tenantId]) await prisma.setting.create({ data: { key: fifoCutoverKey(t), value: new Date(NOW - 30 * DAY).toISOString() } })
  ceo = await mkUser('fcr-ceo', 'admin', A.tenantId)
  cashier = await mkUser('fcr-cashier', 'cashier', A.tenantId)

  stackd = (await prisma.concept.create({
    data: { name: `Stackd ${NOW}`, slug: `fcr-stackd-${NOW}`, type: 'restaurant', tenantId: A.tenantId, serviceVessel: 'packaging', taxRateCash: 15, taxRateCard: 8 },
  })).id
  const cat = await prisma.category.create({ data: { conceptId: stackd, name: 'Sandwiches' } })
  club = (await prisma.menuItem.create({ data: { conceptId: stackd, categoryId: cat.id, name: 'Club', priceCents: 100_000 } })).id

  beef = (await prisma.inventoryItem.create({ data: { tenantId: A.tenantId, name: 'FC Beef', unit: 'kg', category: 'protein' } })).id
  cola = (await prisma.inventoryItem.create({ data: { tenantId: A.tenantId, name: 'FC Cola', unit: 'pcs', category: 'beverage' } })).id
  box = (await prisma.inventoryItem.create({ data: { tenantId: A.tenantId, name: 'FC Box', unit: 'pcs', category: 'packaging' } })).id
  await lot(A.tenantId, beef, 100, 150_000)     // PKR 1,500 / kg
  await lot(A.tenantId, cola, 200, 5_000)
  await lot(A.tenantId, box, 200, 3_000)
  // The opening stock is on the books (so the valuation can tie).
  await postJournalEntry({
    tenantId: A.tenantId, sourceType: 'test.opening', sourceId: A.tenantId, description: 'Opening stock', entryDate: new Date(NOW - 5 * DAY),
    lines: [
      { accountCode: '1210', type: 'debit', amountCents: 15_000_000 },
      { accountCode: '1220', type: 'debit', amountCents: 1_000_000 },
      { accountCode: '1230', type: 'debit', amountCents: 600_000 },
      { accountCode: '3010', type: 'credit', amountCents: 16_600_000 },
    ],
  })

  for (const menuItemId of [A.items.nihari, club]) {
    await prisma.recipe.create({
      data: {
        kind: 'plate', menuItemId, servings: 1, qFactorPct: 10, status: 'production', targetFoodCostPct: 30,
        ingredients: { create: [
          { inventoryItemId: beef, quantity: 100, unit: 'kg' },
          { inventoryItemId: box, quantity: 1, unit: 'pcs', section: 'packaging' },
        ] },
      },
    })
  }
  await prisma.recipe.create({
    data: { kind: 'plate', menuItemId: A.items.kheer, servings: 1, status: 'production', targetFoodCostPct: 30, ingredients: { create: [{ inventoryItemId: cola, quantity: 1, unit: 'pcs' }] } },
  })

  // Sold in the window.
  for (const f of ['takeout', 'delivery', 'dine_in'] as const) await complete((await ring(A.conceptId, A.items.nihari, f)).orderId)
  const boxed = await ring(A.conceptId, A.items.nihari, 'dine_in')
  expect(await markBoxGiven(boxed.lineId, { id: ceo.id })).toEqual({ boxGiven: true, depleted: true })
  await complete(boxed.orderId)
  await complete((await ring(stackd, club, 'dine_in')).orderId)
  await complete((await ring(A.conceptId, A.items.kheer, 'dine_in')).orderId)
  // A staff meal: comped in full (gatewayMeta.comp.kind 'staff_meal').
  const meal = await ring(A.conceptId, A.items.nihari, 'dine_in')
  const mealOrder = await prisma.order.findUniqueOrThrow({ where: { id: meal.orderId } })
  await prisma.payment.deleteMany({ where: { orderId: meal.orderId } })
  await prisma.payment.create({ data: { orderId: meal.orderId, method: 'comp', amountCents: mealOrder.totalCents, status: 'paid', gateway: 'none', gatewayMeta: { comp: { kind: 'staff_meal', reason: 'lunch' } } } })
  await complete(meal.orderId)
  // Refunded after it was sold: still cooked and eaten.
  const refunded = await ring(A.conceptId, A.items.nihari, 'takeout')
  await complete(refunded.orderId)
  await prisma.order.update({ where: { id: refunded.orderId }, data: { status: 'refunded' } })

  // Still open (received): out of the lots, not in cost of sales.
  await ring(A.conceptId, A.items.nihari, 'takeout')
  // A till ticket still open whose home drawer has closed and posted: booked by that close.
  const shift = await prisma.shift.create({ data: { userId: cashier.id, tenantId: A.tenantId, openingFloatCents: 0 } })
  const ticket = await ring(A.conceptId, A.items.nihari, 'dine_in', 'pos')
  await prisma.payment.deleteMany({ where: { orderId: ticket.orderId } })
  await prisma.order.update({ where: { id: ticket.orderId }, data: { status: 'preparing', shiftId: shift.id } })
  await prisma.payment.create({ data: { orderId: ticket.orderId, shiftId: shift.id, method: 'cash', amountCents: 50_000, status: 'paid', processedAt: new Date() } })
  await prisma.shift.update({ where: { id: shift.id }, data: { status: 'closed', closedAt: new Date(), closingFloatCents: 50_000 } })
  expect((await postShiftClose(shift.id)).posted).toBe(true)
  openTicketCost = 15_000

  // Waste: spoilage charged to Simmer (measured); over-prep with no brand (usage-allocated).
  for (const [reason, qty, conceptId] of [['spoilage', 1, A.conceptId], ['over_prep', 0.5, null]] as const) {
    const log = await prisma.wasteLog.create({ data: { inventoryItemId: beef, quantity: qty, unit: 'kg', reason, tenantId: A.tenantId, conceptId, recordedById: ceo.id } })
    const r = await prisma.$transaction((tx) => consumeFifoTx(tx, {
      tenantId: A.tenantId, inventoryItemId: beef, qty, kind: 'waste', sourceType: STOCK_SOURCE.wasteLog, sourceId: log.id, clamp: false,
      conceptId, occurredAt: new Date(),
    }))
    await prisma.wasteLog.update({ where: { id: log.id }, data: { estimatedCostCents: r.valueCents } })
    expect((await postWasteLog(log.id)).posted).toBe(true)
  }
  // A spot count: 2 colas short.
  const colaNow = (await prisma.inventoryItem.findUniqueOrThrow({ where: { id: cola } })).currentStock
  const count = await prisma.physicalCount.create({ data: { tenantId: A.tenantId, countedById: ceo.id, kind: 'spot', status: 'completed' } })
  const cline = await prisma.physicalCountLine.create({ data: { countId: count.id, inventoryItemId: cola, systemQty: colaNow, physicalQty: colaNow - 2 } })
  const loss = await prisma.$transaction((tx) => consumeFifoTx(tx, {
    tenantId: A.tenantId, inventoryItemId: cola, qty: 2, kind: 'count_loss', sourceType: STOCK_SOURCE.countLine, sourceId: cline.id, clamp: false, occurredAt: new Date(),
  }))
  await prisma.physicalCountLine.update({ where: { id: cline.id }, data: { valueCents: -loss.valueCents } })
  expect((await postStockCount(count.id)).posted).toBe(true)
  // A bill priced above its receipt, the stock already used: 5060 on Simmer.
  await postJournalEntry({
    tenantId: A.tenantId, sourceType: 'supplier.bill', sourceId: `fc-bill-${NOW}`, description: 'Bill price difference', entryDate: new Date(NOW - 60_000),
    lines: [
      { accountCode: '5060', type: 'debit', amountCents: 7_000, conceptId: A.conceptId },
      { accountCode: '2010', type: 'credit', amountCents: 7_000 },
    ],
  })
}, 120_000)

describe('the identity and the buckets', () => {
  it('theoretical + explained + unexplained + alignment + timing == ledger cost of sales, per company and per brand', async () => {
    const c = await block(A.tenantId)
    expect(c.identityDiffCents).toBe(0)
    for (const b of c.brands) expect(b.identityDiffCents, b.name).toBe(0)
    const sum = c.theoretical.totalCents + c.explainedCents + c.unexplainedCents + c.alignmentCents + c.timing!.totalCents
    expect(sum).toBe(c.actual!.totalCents)
    // The timing: the open ticket its closed drawer booked before the sale completed, and (H20) the waste and
    // count differences still waiting in 1290 for the CEO — explained by their documents, not yet cost of sales.
    const waiting = (await listStockDifferences({ tenantIds: [A.tenantId], status: 'pending' })).totals.netCents
    expect(waiting).toBeGreaterThan(0)
    expect(c.timing!.stockDocsCents).toBe(-waiting)
    expect(c.timing!.salesCents).toBe(openTicketCost)
    expect(c.alignmentCents).toBe(0)
    expect(c.warnings.find((w) => w.code === 'open_orders')).toMatchObject({ severity: 'timing' })
  })

  it('packaging follows the order type and the brand vessel; MC by order type', async () => {
    const c = await block(A.tenantId)
    const simmer = c.brands.find((b) => b.conceptId === A.conceptId)!
    const st = c.brands.find((b) => b.conceptId === stackd)!
    // Simmer: takeaway, delivery, the boxed dine-in and the refunded takeaway take a box; the plain dine-in does not.
    expect(simmer.theoretical.packagingCents).toBe(4 * 3_000)
    expect(simmer.theoretical.foodCents).toBe(5 * 15_000)
    expect(simmer.theoretical.drinksCents).toBe(5_000)
    // Stackd serves in packaging: its dine-in takes the box.
    expect(st.theoretical).toEqual({ foodCents: 15_000, drinksCents: 0, packagingCents: 3_000, totalCents: 18_000 })
    const byType = Object.fromEntries(c.mcByOrderType.map((m) => [m.fulfilmentType, m]))
    expect(byType['takeout']!.actualMc.packagingCents).toBe(2 * 3_000)
    expect(byType['delivery']!.actualMc.packagingCents).toBe(3_000)
    // Dine-in: Stackd's box and the "Box given" box — never the plain Simmer dine-in or the staff meal.
    expect(byType['dine_in']!.actualMc.packagingCents).toBe(2 * 3_000)
    // Target MC leaves the box out of a Simmer dine-in (Box given is an actual) and keeps Stackd's.
    expect(byType['dine_in']!.targetMcCents).toBe(4 * 15_000 + 3_000 + 5_000)
    expect(byType['takeout']!.targetMcCents).toBe(2 * 18_000)
  })

  it('a staff meal is its own bucket; a refunded order stays in theoretical', async () => {
    const c = await block(A.tenantId)
    expect(c.buckets.staffMeals.totalCents).toBe(15_000)
    expect(c.buckets.comps.totalCents).toBe(0)
    // The refunded takeaway is one of Simmer's four boxes and five beefs above.
    const simmer = c.brands.find((b) => b.conceptId === A.conceptId)!
    expect(simmer.theoretical.totalCents).toBe(5 * 15_000 + 4 * 3_000 + 5_000)
  })

  it('waste by reason (measured vs allocated), count variance and price adjustments', async () => {
    const c = await block(A.tenantId)
    expect(c.buckets.waste.byReason.spoilage).toMatchObject({ measuredCents: 150_000, allocatedCents: 0, totalCents: 150_000 })
    expect(c.buckets.waste.byReason.over_prep.totalCents).toBe(75_000)
    expect(c.buckets.waste.byReason.over_prep.allocatedCents).toBe(75_000)
    expect(c.buckets.waste.byReason.returned_food.totalCents).toBe(0)
    const st = c.brands.find((b) => b.conceptId === stackd)!
    const simmer = c.brands.find((b) => b.conceptId === A.conceptId)!
    expect(st.buckets.waste.byReason.over_prep.allocatedCents).toBeGreaterThan(0)
    expect(st.buckets.waste.byReason.over_prep.allocatedCents + simmer.buckets.waste.byReason.over_prep.allocatedCents).toBe(75_000)
    expect(c.buckets.countVariance.totalCents).toBe(10_000)
    expect(simmer.buckets.countVariance.allocatedCents).toBe(10_000)   // only Simmer uses cola
    expect(c.buckets.priceAdjustments).toBe(7_000)
    expect(c.unexplainedCents).toBe(10_000)
    expect(c.allowance.label).toBe('in menu pricing, not stock')
    expect(c.allowance.qFactorCents).toBeGreaterThan(0)
  })

  it('revenue is brand sales only: 4100, 4110 and 4200 never move it; revenue hidden on request', async () => {
    const before = await block(A.tenantId)
    const simmerBefore = before.brands.find((b) => b.conceptId === A.conceptId)!.revenueCents!
    expect(simmerBefore).toBe(await brandSalesRevenueCents(prisma, A.tenantId, { ...WIN, conceptId: A.conceptId }))
    expect(simmerBefore).toBeGreaterThan(0)
    await postJournalEntry({
      tenantId: A.tenantId, sourceType: 'test.other_income', sourceId: `fc-oi-${NOW}`, description: 'Service charge, fee, breakage', entryDate: new Date(NOW - 60_000),
      lines: [
        { accountCode: '1010', type: 'debit', amountCents: 6_000, conceptId: A.conceptId },
        { accountCode: '4100', type: 'credit', amountCents: 1_000, conceptId: A.conceptId },
        { accountCode: '4110', type: 'credit', amountCents: 2_000, conceptId: A.conceptId },
        { accountCode: '4200', type: 'credit', amountCents: 3_000, conceptId: A.conceptId },
      ],
    })
    const after = await block(A.tenantId)
    expect(after.brands.find((b) => b.conceptId === A.conceptId)!.revenueCents).toBe(simmerBefore)
    expect(after.revenueCents).toBe(before.revenueCents)
    const hidden = await block(A.tenantId, WIN, { revenueVisible: false })
    expect(hidden.revenueHidden).toBe(true)
    for (const k of ['revenueCents', 'targetPct', 'theoreticalPct', 'actualPct', 'avtPoints']) expect(k in hidden, k).toBe(false)
    for (const b of hidden.brands) expect('revenueCents' in b).toBe(false)
    for (const i of hidden.items) expect('revenueCents' in i).toBe(false)
    expect(['good', 'warning', 'critical']).toContain(after.status)
  })

  it('one brand narrows the block to that brand', async () => {
    const c = await block(A.tenantId, WIN, { conceptId: stackd })
    expect(c.brands.map((b) => b.conceptId)).toEqual([stackd])
    expect(c.theoretical.totalCents).toBe(18_000)
    expect(c.identityDiffCents).toBe(0)
  })
})

describe('days, status', () => {
  it('an order completed at 23:30 PKT falls on that PKT day', async () => {
    const d = dayAgo(6)
    const late = await ring(A.conceptId, A.items.kheer, 'dine_in')
    await complete(late.orderId, new Date(`${d}T23:30:00+05:00`))
    const day = (s: string) => ({ from: parsePktStartOfDay(s), to: parsePktEndOfDay(s) })
    const onDay = await block(A.tenantId, day(d))
    expect(onDay.theoretical.drinksCents).toBe(5_000)
    expect(onDay.actual!.totalCents).toBe(5_000)
    const next = fmtPktDate(new Date(new Date(`${d}T12:00:00Z`).getTime() + DAY))
    expect((await block(A.tenantId, day(next))).theoretical.totalCents).toBe(0)
  })

  it('zero revenue → no_data', async () => {
    const quiet = { from: parsePktStartOfDay(dayAgo(20)), to: parsePktEndOfDay(dayAgo(19)) }
    const c = await block(A.tenantId, quiet)
    expect(c.status).toBe('no_data')
    expect(c.statusLabel).toBe('No sales')
  })

  it('a null-cost lot → incomplete', async () => {
    const salt = (await prisma.inventoryItem.create({ data: { tenantId: B.tenantId, name: 'Salt', unit: 'kg', category: 'dry_goods' } })).id
    await lot(B.tenantId, salt, 10, 0)
    await prisma.recipe.create({ data: { kind: 'plate', menuItemId: B.items.nihari, servings: 1, status: 'production', ingredients: { create: [{ inventoryItemId: salt, quantity: 10, unit: 'kg' }] } } })
    await complete((await ring(B.conceptId, B.items.nihari, 'takeout')).orderId)
    const c = await block(B.tenantId)
    expect(c.revenueCents).toBeGreaterThan(0)
    expect(c.warnings.map((w) => w.code)).toContain('null_cost_lot')
    expect(c.status).toBe('incomplete')
    expect(c.statusLabel).toBe('Incomplete data')
  })

  it('companies are never blended: one block each', async () => {
    const both = await foodCostSummary(prisma, { tenantIds: [A.tenantId, B.tenantId], ...WIN, revenueVisible: true })
    expect(both.map((x) => x.tenantId)).toEqual([A.tenantId, B.tenantId])
    expect(both[1]!.brands.every((b) => b.conceptId === null || b.conceptId === B.conceptId)).toBe(true)
  })
})

describe('valuation, ingredients, close checks', () => {
  it('the valuation ties to the GL when everything is posted (open order and a ticket booked by its closed drawer)', async () => {
    const v = await inventoryValuation(prisma, { tenantId: A.tenantId })
    for (const c of v.classes) expect(c.unreconciledCents, c.label).toBe(0)
    expect(v.ties).toBe(true)
    // The open (received) takeaway: beef + box out of the lots, not booked yet.
    expect(v.classes.find((c) => c.costClass === 'food')!.issuedNotBookedCents).toBe(15_000)
    expect(v.classes.find((c) => c.costClass === 'packaging')!.issuedNotBookedCents).toBe(3_000)
  })

  it('ingredients: the count shortfall is the unexplained, cola first', async () => {
    const rows = await ingredientVariance(prisma, { tenantId: A.tenantId, ...WIN })
    expect(rows[0]!.inventoryItemId).toBe(cola)
    expect(rows[0]!.unexplained).toEqual({ qty: 2, cents: 10_000 })
    const b = rows.find((r) => r.inventoryItemId === beef)!
    expect(b.wasteByReason.spoilage).toEqual({ qty: 1, cents: 150_000 })
    expect(b.costClass).toBe('food')
    const onlyPack = await ingredientVariance(prisma, { tenantId: A.tenantId, ...WIN, costClass: 'packaging' })
    expect(onlyPack.map((r) => r.inventoryItemId)).toEqual([box])
  })

  it('timing: a sale completed but not booked shows as timing, then nets once posted', async () => {
    const o = await ring(A.conceptId, A.items.kheer, 'takeout')
    await complete(o.orderId, new Date(NOW - 60_000), false)
    const c = await block(A.tenantId)
    expect(c.identityDiffCents).toBe(0)
    expect(c.timing!.salesCents).toBe(openTicketCost - 5_000)
    expect((await postOrderCompletion(o.orderId)).posted).toBe(true)
    expect((await block(A.tenantId)).timing!.salesCents).toBe(openTicketCost)
  })

  it('inventoryCloseChecks warn on a stale GRNI line (and only for its company)', async () => {
    const sup = await prisma.supplier.create({ data: { name: 'Old Veg', phone: '03001112233', tenantId: A.tenantId } })
    const r = await prisma.goodsReceipt.create({ data: { supplierId: sup.id, receivedById: ceo.id, tenantId: A.tenantId, receivedAt: new Date(NOW - 40 * DAY) } })
    await prisma.goodsReceiptLine.create({ data: { receiptId: r.id, description: 'Onions', receivedQty: 5, poUnitCostCents: 100, unit: 'kg' } })
    const check = inventoryCloseChecks.find((c) => c.key === 'grni_stale')!
    const ctx = (tenantId: string) => ({ db: prisma, tenantId, prevLock: null, newLock: new Date(NOW), months: [], isYearEnd: false })
    const p = await check.run(ctx(A.tenantId))
    expect(p).toMatchObject({ key: 'grni_stale', severity: 'warn', count: 1, cents: 500, link: '/procurement/grni', overridable: true })
    expect(await check.run(ctx(B.tenantId))).toBeNull()
    const pending = inventoryCloseChecks.find((c) => c.key === 'inventory_postings_pending')!
    expect(await pending.run(ctx(A.tenantId))).toBeNull()
  })
})

// ─── Management dashboards (close-06 + the cost-of-sales split) ─────────────

describe('management: other income and the cost-of-sales ratios', () => {
  let app: FastifyInstance
  beforeAll(async () => {
    app = Fastify()
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
      return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
    })
    await app.register(managementRoutes, { prefix: '/management' })
    await app.ready()
  })
  afterAll(async () => { await app?.close() })

  it('a tagged Cr 4200 raises that brand\'s net profit, never its revenue; costOfSalesPct over brand sales with a food / drinks / packaging split', async () => {
    const range = `dateFrom=${dayAgo(2)}&dateTo=${dayAgo(0)}`
    const get = async () => {
      const res = await app.inject({ method: 'GET', url: `/management/executive-overview?${range}`, headers: { authorization: `Bearer ${ceo.token}` } })
      expect(res.statusCode).toBe(200)
      return res.json() as { pl: { company: Record<string, unknown>; brands: Array<Record<string, number | string | null> & { conceptId: string }> } }
    }
    const before = (await get()).pl.brands.find((b) => b.conceptId === A.conceptId)!
    await postJournalEntry({
      tenantId: A.tenantId, sourceType: 'test.breakage', sourceId: `fc-brk-${NOW}`, description: 'Breakage', entryDate: new Date(NOW - 60_000),
      lines: [
        { accountCode: '2080', type: 'debit', amountCents: 10_000, conceptId: A.conceptId },
        { accountCode: '4200', type: 'credit', amountCents: 10_000, conceptId: A.conceptId },
      ],
    })
    const ov = await get()
    const after = ov.pl.brands.find((b) => b.conceptId === A.conceptId)!
    expect(after.netProfitCents).toBe((before.netProfitCents as number) + 10_000)
    expect(after.revenueCents).toBe(before.revenueCents)
    expect(after.otherIncomeCents).toBe((before.otherIncomeCents as number) + 10_000)
    expect('foodCostPct' in after).toBe(false)
    const sales = await brandSalesRevenueCents(prisma, A.tenantId, { from: WIN.from, to: WIN.to, conceptId: A.conceptId })
    expect(after.brandSalesCents).toBe(sales)
    const cos = (after.foodCents as number) + (after.drinksCents as number) + (after.packagingCents as number)
    expect(after.costOfSalesPct).toBeCloseTo((cos / sales) * 100, 1)
    expect(after.packagingPct).toBeCloseTo(((after.packagingCents as number) / sales) * 100, 1)
    expect(ov.pl.company).toHaveProperty('costOfSalesPct')
    expect(ov.pl.company).not.toHaveProperty('foodCostPct')
  })
})
