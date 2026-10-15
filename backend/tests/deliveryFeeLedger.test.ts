// The delivery fee in the books (finance wave B, H9).
//
//   - An order's completion entry credits the fee ex-tax to 4110 Delivery Fee
//     Income (tagged with the brand, memo 'Delivery fee on <slug> #<ref>'),
//     takes it out of the brand's food revenue, and credits the FULL tax (food
//     GST + the fee's GST) to the brand's authority — balanced.
//   - A refund takes its pro-rata share of the fee back off 4110 (Dr 4110).
//   - A legacy order (deliveryFeeCents 0, the fee folded into the total)
//     posts exactly as before: no 4110 line.
//   - A till sale carries no fee: the shift close books no 4110. The formula
//     is the same one, so a till order that did carry a fee is credited to 4110
//     per brand ('Delivery fees @ <slug>').
//   - Two companies: B's delivery order posts to B's 4110 and B's output
//     account; the sales report's deliveryFees is net of a refund's fee share
//     and B's report never includes A's fees.
//
// Requires a disposable database (DATABASE_URL must contain "test").
import { describe, it, expect, beforeAll } from 'vitest'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import {
  postOrderCompletion, postRefundPayment, computeSaleAccounting, refundShareOf,
} from '../src/modules/accounting/orderPosting.js'
import { postShiftClose } from '../src/modules/accounting/shiftPosting.js'
import { salesTotals } from '../src/modules/reports/service.js'
import { orderRefOf } from '../src/lib/orderRef.js'

const RUN = Math.random().toString(36).slice(2, 8)
let tenantA: string, tenantB: string
let conceptA: string, slugA: string, conceptB: string, slugB: string
const T0 = Date.now()

type Line = { code: string; type: string; amount: number; memo: string; conceptId: string | null; tenantId: string | null }
async function entry(tenantId: string, reference: string): Promise<Line[] | null> {
  const je = await prisma.journalEntry.findFirst({
    where: { tenantId, reference },
    include: { lines: { include: { account: { select: { code: true, tenantId: true } } } } },
  })
  return je ? je.lines.map((l) => ({ code: l.account.code, type: l.type, amount: l.amountCents, memo: l.memo ?? '', conceptId: l.conceptId, tenantId: l.account.tenantId })) : null
}
const amt = (lines: Line[], code: string, type: 'debit' | 'credit') =>
  lines.filter((l) => l.code === code && l.type === type).reduce((t, l) => t + l.amount, 0)
const side = (lines: Line[], type: string) => lines.filter((l) => l.type === type).reduce((t, l) => t + l.amount, 0)

/** A storefront delivery order: food + its GST, the fee + its GST on top, cash on delivery. */
async function deliveryOrder(conceptId: string, o: { food: number; foodTax: number; fee: number; feeTax: number; legacy?: boolean }) {
  const tax = o.foodTax + o.feeTax
  const total = o.food + o.fee + tax
  const order = await prisma.order.create({
    data: {
      conceptId, source: 'servd', fulfilmentType: 'delivery', status: 'completed', completedAt: new Date(),
      totalCents: total, taxCents: tax, taxRatePct: 15,
      // A legacy order carried the fee inside its total with no column of its own.
      deliveryFeeCents: o.legacy ? 0 : o.fee, deliveryFeeTaxCents: o.legacy ? 0 : o.feeTax,
      items: { create: [{ name: 'Plate', quantity: 1, unitPriceCents: o.food }] },
    },
  })
  await prisma.payment.create({ data: { orderId: order.id, method: 'cash', amountCents: total, status: 'pending' } })
  return order
}

let cashierSeq = 0
async function freshShift(tenantId: string) {
  const u = await prisma.user.create({
    data: { name: `dfl${++cashierSeq}`, email: `dfl${cashierSeq}.${RUN}@feeledger.test`, password: 'x', role: 'cashier', isActive: true, accountStatus: 'active', tenantId },
  })
  return prisma.shift.create({ data: { userId: u.id, openingFloatCents: 0, status: 'open', tenantId } })
}

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'Fee A', slug: `dfl-a-${RUN}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'Fee B', slug: `dfl-b-${RUN}` } })).id
  await ensureChartOfAccounts(tenantA)
  await ensureChartOfAccounts(tenantB)
  slugA = `dfl-sd-${RUN}`
  slugB = `dfl-ict-${RUN}`
  conceptA = (await prisma.concept.create({ data: { name: 'Karachi kitchen', slug: slugA, type: 'restaurant', tenantId: tenantA, province: 'SD' } })).id
  conceptB = (await prisma.concept.create({ data: { name: 'Islamabad kitchen', slug: slugB, type: 'restaurant', tenantId: tenantB, province: 'ICT' } })).id
})

describe('computeSaleAccounting — the delivery fee is its own revenue', () => {
  it('subtracts the fee from food revenue; charged + wallet + discount = revenue + tax + svc + tip + fee', () => {
    const sa = computeSaleAccounting({
      totalCents: 132_250, walletAmountCents: 0, taxCents: 17_250, discountCents: 0, promoDiscountCents: 0,
      serviceChargeCents: 0, tipCents: 0, deliveryFeeCents: 15_000,
    })
    expect(sa.deliveryFeeCents).toBe(15_000)
    expect(sa.grossRevenueCents).toBe(100_000)
    expect(sa.totalChargedCents + sa.walletAppliedCents + sa.giftCardAppliedCents + sa.discountCents)
      .toBe(sa.grossRevenueCents + sa.taxCents + sa.serviceChargeCents + sa.tipCents + sa.deliveryFeeCents)
  })

  it('refundShareOf shares the fee pro rata; the parts add up to the refund', () => {
    const order = { totalCents: 132_250, walletAmountCents: 0, taxCents: 17_250, discountCents: 0, promoDiscountCents: 0, serviceChargeCents: 0, tipCents: 0, deliveryFeeCents: 15_000 }
    const a = refundShareOf(order, 0, 66_125)
    expect(a).toEqual({ revenueCents: 50_000, serviceChargeCents: 0, tipCents: 0, taxCents: 8_625, deliveryFeeCents: 7_500 })
    const b = refundShareOf(order, 66_125, 66_125)
    expect(a.deliveryFeeCents + b.deliveryFeeCents).toBe(15_000)
    expect(b.revenueCents + b.taxCents + b.deliveryFeeCents).toBe(66_125)
    // No fee on the order: no fee share.
    expect(refundShareOf({ ...order, deliveryFeeCents: 0 }, 0, 10_000).deliveryFeeCents).toBe(0)
  })
})

describe('order completion and refund', () => {
  it('Cr 4110 the fee ex-tax and the full tax to the brand authority; a refund takes the 4110 share', async () => {
    // Food 1,000 + 15 % GST 150; fee 150 + 15 % GST 22.50 on top.
    const order = await deliveryOrder(conceptA, { food: 100_000, foodTax: 15_000, fee: 15_000, feeTax: 2_250 })
    const r = await postOrderCompletion(order.id)
    expect(r.posted).toBe(true)
    const lines = (await entry(tenantA, `order.complete:${order.id}`))!
    expect(side(lines, 'debit')).toBe(side(lines, 'credit'))
    expect(amt(lines, '1010', 'debit')).toBe(132_250)
    expect(amt(lines, '4110', 'credit')).toBe(15_000)
    expect(amt(lines, '2032', 'credit')).toBe(17_250)            // food GST + fee GST, SRB (Sindh)
    expect(amt(lines, '2030', 'credit')).toBe(0)
    // The brand's food revenue is the food only (the 4xxx credit that is not 4110).
    const revenue = lines.filter((l) => l.type === 'credit' && l.code.startsWith('4') && l.code !== '4110')
    expect(revenue.reduce((t, l) => t + l.amount, 0)).toBe(100_000)
    const fee = lines.find((l) => l.code === '4110')!
    expect(fee.conceptId).toBe(conceptA)
    expect(fee.memo).toBe(`Delivery fee on ${slugA} #${orderRefOf(order.id)}`)
    expect(lines.every((l) => l.tenantId === tenantA)).toBe(true)

    // Half of it handed back: half the fee comes off 4110, half the tax off 2032.
    const refund = await prisma.payment.create({ data: { orderId: order.id, method: 'cash', amountCents: -66_125, status: 'refunded', processedAt: new Date() } })
    expect((await postRefundPayment(refund.id)).posted).toBe(true)
    const rl = (await entry(tenantA, `order.refund:${refund.id}`))!
    expect(side(rl, 'debit')).toBe(side(rl, 'credit'))
    expect(amt(rl, '4110', 'debit')).toBe(7_500)
    expect(amt(rl, '2032', 'debit')).toBe(8_625)
    expect(rl.filter((l) => l.type === 'debit' && l.code.startsWith('4') && l.code !== '4110').reduce((t, l) => t + l.amount, 0)).toBe(50_000)
    expect(amt(rl, '1010', 'credit')).toBe(66_125)
    expect(rl.find((l) => l.code === '4110')!.conceptId).toBe(conceptA)
  })

  it('a legacy order (fee column 0) posts as before — the fee stays in brand revenue, no 4110', async () => {
    const order = await deliveryOrder(conceptA, { food: 50_000, foodTax: 7_500, fee: 10_000, feeTax: 0, legacy: true })
    expect((await postOrderCompletion(order.id)).posted).toBe(true)
    const lines = (await entry(tenantA, `order.complete:${order.id}`))!
    expect(side(lines, 'debit')).toBe(side(lines, 'credit'))
    expect(lines.some((l) => l.code === '4110')).toBe(false)
    expect(amt(lines, '2032', 'credit')).toBe(7_500)
    const revenue = lines.filter((l) => l.type === 'credit' && l.code.startsWith('4'))
    expect(revenue.reduce((t, l) => t + l.amount, 0)).toBe(60_000)
  })
})

describe('the till', () => {
  it('a till sale has no fee: the shift close books no 4110', async () => {
    const shift = await freshShift(tenantA)
    const order = await prisma.order.create({
      data: {
        conceptId: conceptA, source: 'pos', fulfilmentType: 'dine_in', status: 'completed', completedAt: new Date(),
        totalCents: 11_500, taxCents: 1_500, taxRatePct: 15,
        items: { create: [{ name: 'Plate', quantity: 1, unitPriceCents: 10_000 }] },
      },
    })
    await prisma.payment.create({ data: { orderId: order.id, shiftId: shift.id, method: 'cash', amountCents: 11_500, status: 'paid', processedAt: new Date() } })
    await prisma.shift.update({ where: { id: shift.id }, data: { status: 'closed', closedAt: new Date(), closingFloatCents: 11_500 } })
    expect((await postShiftClose(shift.id)).posted).toBe(true)
    const lines = (await entry(tenantA, `shift.close:${shift.id}`))!
    expect(side(lines, 'debit')).toBe(side(lines, 'credit'))
    expect(lines.some((l) => l.code === '4110')).toBe(false)
    expect(amt(lines, '2032', 'credit')).toBe(1_500)
  })

  it('the close uses the same formula: a till order that carried a fee is credited to 4110 per brand', async () => {
    const shift = await freshShift(tenantA)
    const order = await prisma.order.create({
      data: {
        conceptId: conceptA, source: 'pos', fulfilmentType: 'delivery', status: 'completed', completedAt: new Date(),
        totalCents: 11_500 + 5_750, taxCents: 1_500 + 750, taxRatePct: 15, deliveryFeeCents: 5_000, deliveryFeeTaxCents: 750,
        items: { create: [{ name: 'Plate', quantity: 1, unitPriceCents: 10_000 }] },
      },
    })
    await prisma.payment.create({ data: { orderId: order.id, shiftId: shift.id, method: 'cash', amountCents: 17_250, status: 'paid', processedAt: new Date() } })
    await prisma.shift.update({ where: { id: shift.id }, data: { status: 'closed', closedAt: new Date(), closingFloatCents: 17_250 } })
    expect((await postShiftClose(shift.id)).posted).toBe(true)
    const lines = (await entry(tenantA, `shift.close:${shift.id}`))!
    expect(side(lines, 'debit')).toBe(side(lines, 'credit'))
    expect(amt(lines, '4110', 'credit')).toBe(5_000)
    expect(amt(lines, '2032', 'credit')).toBe(2_250)
    const fee = lines.find((l) => l.code === '4110')!
    expect(fee.conceptId).toBe(conceptA)
    expect(fee.memo).toBe(`Delivery fees @ ${slugA}`)
    const revenue = lines.filter((l) => l.type === 'credit' && l.code.startsWith('4') && l.code !== '4110')
    expect(revenue.reduce((t, l) => t + l.amount, 0)).toBe(10_000)
  })
})

describe('two companies', () => {
  it("B's delivery order posts to B's 4110 and B's authority; the sales report keeps each company's fees apart", async () => {
    // Islamabad: FBR (2030). Card at 8 %: food 2,000 + 160; fee 200 + 16.
    const order = await deliveryOrder(conceptB, { food: 200_000, foodTax: 16_000, fee: 20_000, feeTax: 1_600 })
    expect((await postOrderCompletion(order.id)).posted).toBe(true)
    expect(await entry(tenantA, `order.complete:${order.id}`)).toBeNull()
    const lines = (await entry(tenantB, `order.complete:${order.id}`))!
    expect(lines.every((l) => l.tenantId === tenantB)).toBe(true)
    expect(amt(lines, '4110', 'credit')).toBe(20_000)
    expect(amt(lines, '2030', 'credit')).toBe(17_600)
    expect(amt(lines, '2032', 'credit')).toBe(0)
    expect(lines.find((l) => l.code === '4110')!.memo).toBe(`Delivery fee on ${slugB} #${orderRefOf(order.id)}`)

    const window = { from: new Date(T0 - 60_000), to: new Date(Date.now() + 60_000) }
    // A: 150 + the till order's 50, less the refund's 75 share; the legacy order adds nothing.
    const a = await salesTotals({ company: { tenantId: tenantA }, ...window })
    expect(a.deliveryFees).toBe(15_000 + 5_000 - 7_500)
    const b = await salesTotals({ company: { tenantId: tenantB }, ...window })
    expect(b.deliveryFees).toBe(20_000)
    // The fee is revenue: it stays inside net (gross − tax − tips − refunds …).
    expect(b.net).toBe(b.gross - b.tax - b.tips)
    expect(b.net).toBe(200_000 + 20_000)
  })
})
