// A line voided on a PAID, still-open order (TILL-R3) is refunded with the
// exact split the void took off the bill — never pro rata (W3 gate finding
// till-void-fee-share).
//
// pos/service voidOrderItem gives the line's value back as a refund row and
// does not lower the bill; the order's completion then books the bill as
// charged. The refund entry used to take a pro-rata share of the DELIVERY FEE
// (Dr 4110) and of the bill's GST, so a dish void on a delivery order moved fee
// income into food revenue, and a zero-rated line's refund reclaimed GST it
// never carried. Now:
//   - the refund row stores gatewayMeta.refund.split (revenue = line value −
//     its discount, its own GST and service charge, fee 0, tip 0) and its
//     'order.refund' entry books exactly that — no 4110 line;
//   - every later refund values the order net of the void (netOfVoidRefunds),
//     so a full refund nets 4110, the brand's revenue and the output tax to 0;
//   - the sales report subtracts the same split (deliveryFees keeps the fee);
//   - the fiscal return document puts the value and GST on the voided line,
//     never on the DELIVERY-CHARGE line;
//   - a legacy void row with no stored split keeps the pro-rata rule.
// Two companies: B's books are never touched by A's order.
// Requires a disposable database (DATABASE_URL must contain "test").
import { describe, it, expect, beforeAll } from 'vitest'
import { randomBytes } from 'node:crypto'
import { prisma, mkCompany, mkUser, type Company, type Who } from './connectorsFixtures.js'
import { voidOrderItem } from '../src/modules/pos/service.js'
import {
  postOrderCompletion, postRefundPayment, voidSplitOf, netOfVoidRefunds, refundShareOf,
} from '../src/modules/accounting/orderPosting.js'
import { revenueCodeForConcept } from '../src/modules/accounting/journal.js'
import { salesTotals } from '../src/modules/reports/service.js'
import { buildFiscalSaleTx, buildRefundPayload, totalsCheck, totalsOf, isDeliveryChargeLine } from '../src/connectors/fiscal/payload.js'
import { voidRefundShape } from '../src/connectors/fiscal/outbox.js'
import { DEFAULT_FISCAL_SETTINGS } from '../src/connectors/config.js'

let A: Company, B: Company
let mgrA: Who
let dish45: string
const stamp = Date.now()

/** Net (debit − credit) per account code over the company's entries whose reference contains the order id or one of `refs`. */
async function net(tenantId: string, refs: string[]): Promise<Record<string, number>> {
  const lines = await prisma.journalLine.findMany({
    where: { journalEntry: { tenantId, reference: { in: refs } } },
    select: { type: true, amountCents: true, account: { select: { code: true } } },
  })
  const out: Record<string, number> = {}
  for (const l of lines) out[l.account.code] = (out[l.account.code] ?? 0) + (l.type === 'debit' ? 1 : -1) * Number(l.amountCents)
  return out
}

async function entryLines(tenantId: string, ref: string): Promise<Array<[string, string, number]>> {
  const e = await prisma.journalEntry.findFirst({
    where: { tenantId, reference: ref },
    select: { lines: { select: { type: true, amountCents: true, account: { select: { code: true } } } } },
  })
  return (e?.lines ?? []).map((l) => [l.account.code, l.type, Number(l.amountCents)] as [string, string, number])
    .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]))
}

/** An online delivery order paid by card at 8 %: 55,000 + 45,000, fee 20,000 + 1,600 GST — 129,600. */
async function deliveryOrder(co: Company, dishId: string) {
  const o = await prisma.order.create({
    data: {
      conceptId: co.conceptId, source: 'servd', fulfilmentType: 'delivery', status: 'preparing',
      totalCents: 129_600, taxCents: 9_600, taxRatePct: 8, deliveryFeeCents: 20_000, deliveryFeeTaxCents: 1_600,
      items: { create: [
        { name: 'Kheer', menuItemId: co.items.kheer, quantity: 1, unitPriceCents: 55_000 },
        { name: 'Dish 45', menuItemId: dishId, quantity: 1, unitPriceCents: 45_000 },
      ] },
    },
    include: { items: true },
  })
  await prisma.payment.create({ data: { orderId: o.id, method: 'card', amountCents: 129_600, status: 'paid', processedAt: new Date() } })
  return o
}

async function complete(orderId: string) {
  await prisma.order.update({ where: { id: orderId }, data: { status: 'completed', completedAt: new Date() } })
  return postOrderCompletion(orderId)
}

beforeAll(async () => {
  A = await mkCompany(`vrs-a-${stamp}`)
  B = await mkCompany(`vrs-b-${stamp}`)
  mgrA = await mkUser('vrs-mgr-a', 'fnb_manager', A.tenantId)
  const cat = await prisma.category.findFirstOrThrow({ where: { conceptId: A.conceptId } })
  dish45 = (await prisma.menuItem.create({ data: { conceptId: A.conceptId, categoryId: cat.id, name: 'Dish 45', priceCents: 45_000 } })).id
}, 60_000)

describe('a dish voided on a paid delivery order', () => {
  it('books exactly the line: no 4110; completion and a later full refund net 4110, revenue and GST to zero; the report keeps the fee', async () => {
    const slug = (await prisma.concept.findUniqueOrThrow({ where: { id: A.conceptId }, select: { slug: true } })).slug
    const rev = revenueCodeForConcept(slug)
    const bTax0 = await prisma.journalLine.count({ where: { journalEntry: { tenantId: B.tenantId } } })
    const o = await deliveryOrder(A, dish45)
    const dish = o.items.find((i) => i.name === 'Dish 45')!

    const v = await voidOrderItem({ orderId: o.id, orderItemId: dish.id, reason: 'out of stock', actorId: mgrA.id, actorRole: 'fnb_manager' })
    expect(v.removedCents).toBe(48_600)
    expect(v.refund?.amountCents).toBe(48_600)
    const row = await prisma.payment.findUniqueOrThrow({ where: { id: v.refund!.id } })
    expect(voidSplitOf(row)).toEqual({ revenueCents: 45_000, taxCents: 3_600, serviceChargeCents: 0, tipCents: 0, deliveryFeeCents: 0 })

    const voidEntry = await entryLines(A.tenantId, `order.refund:${row.id}`)
    expect(voidEntry.find((l) => l[0] === '4110')).toBeUndefined()
    expect(voidEntry).toEqual(expect.arrayContaining([['1030', 'credit', 48_600], [rev, 'debit', 45_000]]))
    expect(voidEntry.filter((l) => l[1] === 'debit' && l[0] !== rev).map((l) => l[2])).toEqual([3_600])

    expect((await complete(o.id)).posted).toBe(true)
    const afterSale = await net(A.tenantId, [`order.complete:${o.id}`, `order.refund:${row.id}`])
    expect(afterSale['4110']).toBe(-20_000)           // the whole fee charged
    expect(afterSale[rev]).toBe(-55_000)              // the dish actually sold
    const taxCode = Object.keys(afterSale).find((c) => c.startsWith('20') && c !== '2095')!
    expect(afterSale[taxCode]).toBe(-6_000)           // 4,400 food + 1,600 fee

    const day = { from: new Date(Date.now() - 86_400_000), to: new Date(Date.now() + 86_400_000) }
    const t1 = await salesTotals({ company: { tenantId: A.tenantId }, conceptId: A.conceptId, ...day })
    expect(t1.deliveryFees).toBe(20_000)
    expect(t1.tax).toBe(6_000)

    // The rest goes back later: everything nets to zero.
    const rest = await prisma.payment.create({
      data: { orderId: o.id, method: 'card', amountCents: -81_000, status: 'refunded', processedAt: new Date(), gatewayMeta: { refund: { reason: 'complaint' } } },
    })
    expect((await postRefundPayment(rest.id)).posted).toBe(true)
    const all = await net(A.tenantId, [`order.complete:${o.id}`, `order.refund:${row.id}`, `order.refund:${rest.id}`])
    expect(all['4110']).toBe(0)
    expect(all[rev]).toBe(0)
    expect(all[taxCode]).toBe(0)
    expect(all['1030']).toBe(0)
    const t2 = await salesTotals({ company: { tenantId: A.tenantId }, conceptId: A.conceptId, ...day })
    expect(t2.deliveryFees).toBe(0)
    expect(t2.tax).toBe(0)

    // Company B: nothing booked.
    expect(await prisma.journalLine.count({ where: { journalEntry: { tenantId: B.tenantId } } })).toBe(bTax0)
    expect(await prisma.journalEntry.count({ where: { tenantId: B.tenantId, reference: { contains: o.id } } })).toBe(0)
  })

  it('the return document puts the value and GST on the voided line, never on the delivery charge', async () => {
    const o = await deliveryOrder(A, dish45)
    const dish = o.items.find((i) => i.name === 'Dish 45')!
    const v = await voidOrderItem({ orderId: o.id, orderItemId: dish.id, reason: 'oops', actorId: mgrA.id, actorRole: 'fnb_manager' })
    await prisma.order.update({ where: { id: o.id }, data: { status: 'completed', completedAt: new Date() } })
    const sale = await prisma.$transaction((tx) => buildFiscalSaleTx(tx, o.id, `doc_${randomBytes(4).toString('hex')}`, DEFAULT_FISCAL_SETTINGS))
    expect(sale.payload.lines.some(isDeliveryChargeLine)).toBe(true)
    const row = await prisma.payment.findUniqueOrThrow({ where: { id: v.refund!.id } })
    const ret = buildRefundPayload(sale.payload, { documentId: 'r-void', refundAmountCents: 48_600, issuedAt: new Date(), original: null, ...voidRefundShape(row) })
    expect(totalsCheck(ret).ok).toBe(true)
    expect(ret.lines).toHaveLength(1)
    expect(ret.lines[0]!.lineId).toBe(dish.id)
    expect(ret.lines[0]!.taxableCents).toBe(45_000)
    expect(ret.lines[0]!.taxCents).toBe(3_600)
    expect(totalsOf(ret).tipCents).toBe(0)
    expect(totalsOf(ret).deliveryChargeCents ?? 0).toBe(0)
    // Without the split (a legacy void row) the old pro-rata rule still adds up.
    const legacy = buildRefundPayload(sale.payload, { documentId: 'r-legacy', refundAmountCents: 48_600, issuedAt: new Date(), original: null, tipShareCents: 0 })
    expect(totalsCheck(legacy).ok).toBe(true)
  })
})

describe('a zero-rated line voided on a paid order', () => {
  it('debits no output tax', async () => {
    // Kheer 55,000 at 8 % (4,400) + zero-rated water 10,000 = 69,400, paid by card.
    const o = await prisma.order.create({
      data: {
        conceptId: A.conceptId, source: 'servd', fulfilmentType: 'takeout', status: 'preparing',
        totalCents: 69_400, taxCents: 4_400, taxRatePct: 8,
        items: { create: [
          { name: 'Kheer', menuItemId: A.items.kheer, quantity: 1, unitPriceCents: 55_000 },
          { name: 'Water', menuItemId: A.items.water, quantity: 1, unitPriceCents: 10_000 },
        ] },
      },
      include: { items: true },
    })
    await prisma.payment.create({ data: { orderId: o.id, method: 'card', amountCents: 69_400, status: 'paid', processedAt: new Date() } })
    const water = o.items.find((i) => i.name === 'Water')!
    const v = await voidOrderItem({ orderId: o.id, orderItemId: water.id, reason: 'spilt', actorId: mgrA.id, actorRole: 'fnb_manager' })
    expect(v.removedCents).toBe(10_000)
    const lines = await entryLines(A.tenantId, `order.refund:${v.refund!.id}`)
    expect(lines).toHaveLength(2)
    expect(lines.map((l) => l[2])).toEqual([10_000, 10_000])
    expect(lines.find((l) => l[0].startsWith('203'))).toBeUndefined()
  })
})

describe('the pure rules', () => {
  const order = { totalCents: 129_600, walletAmountCents: 0, taxCents: 9_600, discountCents: 0, promoDiscountCents: 0, serviceChargeCents: 0, tipCents: 0, deliveryFeeCents: 20_000 }
  const split = { revenueCents: 45_000, taxCents: 3_600, serviceChargeCents: 0, tipCents: 0, deliveryFeeCents: 0 }
  const voidRow = { status: 'refunded', amountCents: -48_600, gatewayMeta: { refund: { voidedItemId: 'x', split } } }

  it('voidSplitOf reads only a well-formed split that adds up to the row', () => {
    expect(voidSplitOf(voidRow)).toEqual(split)
    expect(voidSplitOf({ amountCents: -48_600, gatewayMeta: { refund: { voidedItemId: 'x' } } })).toBeNull()          // legacy row
    expect(voidSplitOf({ amountCents: -48_600, gatewayMeta: { refund: { split } } })).toBeNull()                        // not a void
    expect(voidSplitOf({ amountCents: -48_000, gatewayMeta: { refund: { voidedItemId: 'x', split } } })).toBeNull()     // does not add up
    expect(voidSplitOf({ amountCents: -48_600, gatewayMeta: { refund: { voidedItemId: 'x', split: { ...split, taxCents: -1, revenueCents: 45_001 } } } })).toBeNull()
  })

  it('netOfVoidRefunds takes the exact voids off the bill; a legacy void row changes nothing', () => {
    expect(netOfVoidRefunds(order, [voidRow])).toMatchObject({ totalCents: 81_000, taxCents: 6_000, deliveryFeeCents: 20_000 })
    expect(netOfVoidRefunds(order, [{ status: 'refunded', amountCents: -48_600, gatewayMeta: { refund: { voidedItemId: 'x' } } }])).toEqual(order)
    // A full refund of what is left takes all of the fee and the remaining GST.
    expect(refundShareOf(netOfVoidRefunds(order, [voidRow]), 0, 81_000)).toEqual({ revenueCents: 55_000, taxCents: 6_000, serviceChargeCents: 0, tipCents: 0, deliveryFeeCents: 20_000 })
  })
})
