// The sale side of the books — regression tests for the simulated-shift findings.
//
//   ONL-05  a gift card used at checkout never reached the ledger: revenue was
//       computed from the post-card total (short by the card) and 2080 Gift
//       Card Liability was never discharged. The sale now debits 2080 for the
//       order's redemptions and takes revenue from the pre-card total; a
//       refund that re-credits the card books the mirror once; a cancel books
//       nothing; a till bill a card paid in full is still booked.
//   BOOKS-10  Sindh restaurant tax went to 2030 "Payable to FBR". Output tax now
//       follows the brand's province (SD → 2032 SRB) on sales, refunds and the
//       shift close, and the return gives each authority its own net and a
//       per-rate (15% cash / 8% card) breakdown without netting FBR input tax
//       against SRB output tax.
//   FOH-09  money taken on a cancelled ticket was booked at the close as sales
//       and tax. It is now held as a refund due (Dr drawer / Cr 1110).
//   FOH-14  a till tip (Order.tipCents, and on the tender's gatewayMeta) is
//       credited to 2095 Tips Payable, never read as an overpayment.
//
// Requires a disposable database (DATABASE_URL must contain "test").
import { describe, it, expect, beforeAll } from 'vitest'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { postJournalEntry } from '../src/modules/accounting/journal.js'
import {
  postOrderCompletion, postOrderRefund, postRefundPayment, outputTaxCodeFor, computeSaleAccounting,
} from '../src/modules/accounting/orderPosting.js'
import { postShiftClose, summariseShiftSales, SHIFT_SALE_PAYMENT_INCLUDE } from '../src/modules/accounting/shiftPosting.js'
import { salesTaxReturn } from '../src/modules/accounting/salesTaxReturn.js'
import { redeemGiftCard } from '../src/modules/giftCards/service.js'

const RUN = Math.random().toString(36).slice(2, 8)
let tenantA: string, tenantB: string, tenantC: string
let conceptA: string, conceptSD: string, conceptSrbOnly: string, conceptC: string, conceptB: string
const DAY = 86_400_000

type Line = { code: string; type: string; amount: number; memo: string }
async function entry(tenantId: string, reference: string): Promise<Line[] | null> {
  const je = await prisma.journalEntry.findFirst({
    where: { tenantId, reference },
    include: { lines: { include: { account: { select: { code: true } } } } },
  })
  return je ? je.lines.map((l) => ({ code: l.account.code, type: l.type, amount: l.amountCents, memo: l.memo ?? '' })) : null
}
const amt = (lines: Line[], code: string, type: 'debit' | 'credit') =>
  lines.filter((l) => l.code === code && l.type === type).reduce((t, l) => t + l.amount, 0)
const side = (lines: Line[], type: string) => lines.filter((l) => l.type === type).reduce((t, l) => t + l.amount, 0)
const balanced = (lines: Line[]) => side(lines, 'debit') === side(lines, 'credit')
const codes = (lines: Line[]) => [...new Set(lines.map((l) => l.code))].sort()

async function netCredit(tenantId: string, code: string, where: Record<string, unknown> = {}): Promise<number> {
  const lines = await prisma.journalLine.findMany({
    where: { account: { tenantId, code }, journalEntry: { tenantId, ...where } },
    select: { type: true, amountCents: true },
  })
  return lines.reduce((t, l) => t + (l.type === 'credit' ? l.amountCents : -l.amountCents), 0)
}

async function mkOrder(conceptId: string, o: {
  source?: 'servd' | 'pos'; status?: string; items: number; tax: number; ratePct?: number | null; tip?: number; pending?: 'cash' | 'card' | null
}) {
  const total = o.items + o.tax + (o.tip ?? 0)
  const order = await prisma.order.create({
    data: {
      conceptId, source: o.source ?? 'servd', status: (o.status ?? 'received') as never,
      totalCents: total, taxCents: o.tax, taxRatePct: o.ratePct ?? null, tipCents: o.tip ?? 0,
      completedAt: o.status === 'completed' ? new Date() : null,
      items: { create: [{ name: 'Plate', quantity: 1, unitPriceCents: o.items }] },
    },
  })
  if (o.pending) await prisma.payment.create({ data: { orderId: order.id, method: o.pending, amountCents: total, status: 'pending' } })
  return order
}
const complete = (id: string) => prisma.order.update({ where: { id }, data: { status: 'completed', completedAt: new Date() } })

let cardSeq = 0
async function mkCard(tenantId: string, cents: number) {
  cardSeq += 1
  const card = await prisma.giftCard.create({
    data: { tenantId, code: `GS-${RUN.toUpperCase()}-${String(cardSeq).padStart(4, '0')}`, issuedAmountCents: cents, balanceCents: cents },
  })
  // What POST /gift-cards books when the card is sold: Dr cash / Cr 2080.
  await postJournalEntry({
    tenantId, sourceType: 'giftcard.issue', sourceId: card.id, description: 'card sold', postedBy: 'test',
    lines: [{ accountCode: '1010', type: 'debit', amountCents: cents }, { accountCode: '2080', type: 'credit', amountCents: cents }],
  })
  return card
}

async function refundRow(orderId: string, cents: number, method: 'cash' | 'card' = 'cash') {
  const p = await prisma.payment.create({
    data: { orderId, method, amountCents: -cents, status: 'refunded', processedAt: new Date(), gatewayRef: method === 'card' ? 'RF-1' : null },
  })
  const r = await postRefundPayment(p.id)
  expect(r.posted).toBe(true)
  return p
}

let cashierSeq = 0
async function freshShift(tenantId: string) {
  const u = await prisma.user.create({
    data: { name: `till${++cashierSeq}`, email: `till${cashierSeq}.${RUN}@ledgersales.test`, password: 'x', role: 'cashier', isActive: true, accountStatus: 'active', tenantId },
  })
  return prisma.shift.create({ data: { userId: u.id, openingFloatCents: 0, status: 'open', tenantId } })
}
async function pay(orderId: string, shiftId: string, method: 'cash' | 'card', amountCents: number, gatewayMeta?: Record<string, unknown>) {
  return prisma.payment.create({
    data: {
      orderId, shiftId, method, amountCents, status: 'paid', processedAt: new Date(),
      gatewayRef: method === 'card' ? `T-${RUN}` : null, ...(gatewayMeta && { gatewayMeta: gatewayMeta as never }),
    },
  })
}
async function closeAndPost(shiftId: string, countedCents: number) {
  await prisma.shift.update({ where: { id: shiftId }, data: { status: 'closed', closedAt: new Date(), closingFloatCents: countedCents } })
  const r = await postShiftClose(shiftId)
  expect(r.posted).toBe(true)
  const shift = await prisma.shift.findUniqueOrThrow({ where: { id: shiftId } })
  return (await entry(shift.tenantId!, `shift.close:${shiftId}`))!
}

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'Sales A', slug: `ls-a-${RUN}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'Sales B', slug: `ls-b-${RUN}` } })).id
  tenantC = (await prisma.tenant.create({ data: { name: 'Sales C', slug: `ls-c-${RUN}` } })).id
  for (const t of [tenantA, tenantB, tenantC]) await ensureChartOfAccounts(t)
  conceptA = (await prisma.concept.create({ data: { name: 'No province', slug: `ls-np-${RUN}`, type: 'restaurant', tenantId: tenantA } })).id
  conceptSD = (await prisma.concept.create({ data: { name: 'Karachi', slug: `ls-sd-${RUN}`, type: 'restaurant', tenantId: tenantA, province: 'SD' } })).id
  conceptSrbOnly = (await prisma.concept.create({ data: { name: 'SRB POS only', slug: `ls-srb-${RUN}`, type: 'restaurant', tenantId: tenantA, srbPosId: 123 } })).id
  conceptB = (await prisma.concept.create({ data: { name: 'Other co', slug: `ls-b-${RUN}`, type: 'restaurant', tenantId: tenantB, province: 'SD' } })).id
  conceptC = (await prisma.concept.create({ data: { name: 'Return brand', slug: `ls-c-${RUN}`, type: 'restaurant', tenantId: tenantC, province: 'SD' } })).id
}, 60_000)

// ─── ONL-05 ───────────────────────────────────────────────────────────────────

describe('a gift card spent at checkout is in the books', () => {
  it('the sale debits 2080 for the card and takes revenue from the pre-card total (the finding\'s numbers)', async () => {
    const card = await mkCard(tenantA, 100_000)
    const o = await mkOrder(conceptA, { items: 230_000, tax: 34_500, pending: 'cash' })      // 264,500 due
    const applied = await redeemGiftCard({ code: card.code, orderId: o.id })
    expect(applied.appliedCents).toBe(100_000)
    await complete(o.id)
    expect((await postOrderCompletion(o.id)).posted).toBe(true)

    const je = (await entry(tenantA, `order.complete:${o.id}`))!
    expect(balanced(je)).toBe(true)
    expect(amt(je, '1010', 'debit')).toBe(164_500)
    expect(amt(je, '2080', 'debit')).toBe(100_000)
    expect(amt(je, '4090', 'credit')).toBe(230_000)
    expect(amt(je, '2030', 'credit')).toBe(34_500)
    expect(je.find((l) => l.code === '2080')!.memo).toContain(o.id)
    // The card's liability is discharged: issued 100,000, spent 100,000.
    expect(await netCredit(tenantA, '2080', { reference: { in: [`giftcard.issue:${card.id}`, `order.complete:${o.id}`] } })).toBe(0)
  })

  it('a full refund re-credits the card and books the mirror once; revenue, tax and 2080 net to zero', async () => {
    const card = await mkCard(tenantA, 100_000)
    const o = await mkOrder(conceptA, { items: 230_000, tax: 34_500, pending: 'cash' })
    await redeemGiftCard({ code: card.code, orderId: o.id })
    await complete(o.id)
    await postOrderCompletion(o.id)
    const tender = await refundRow(o.id, 164_500)
    await prisma.order.update({ where: { id: o.id }, data: { status: 'refunded' } })
    await postOrderRefund(o.id, 'Order refunded')

    expect((await prisma.giftCard.findUniqueOrThrow({ where: { id: card.id } })).balanceCents).toBe(100_000)
    const red = await prisma.giftCardRedemption.findFirstOrThrow({ where: { orderId: o.id } })
    const mirror = (await entry(tenantA, `order.refund_giftcard:${red.id}`))!
    expect(balanced(mirror)).toBe(true)
    expect(amt(mirror, '2080', 'credit')).toBe(100_000)
    const refs = [`giftcard.issue:${card.id}`, `order.complete:${o.id}`, `order.refund:${tender.id}`, `order.refund_giftcard:${red.id}`]
    expect(await netCredit(tenantA, '4090', { reference: { in: refs } })).toBe(0)
    expect(await netCredit(tenantA, '2030', { reference: { in: refs } })).toBe(0)
    expect(await netCredit(tenantA, '2080', { reference: { in: refs } })).toBe(100_000)   // = the card's balance again

    await postOrderRefund(o.id, 'Order refunded')                      // replay
    expect((await prisma.giftCard.findUniqueOrThrow({ where: { id: card.id } })).balanceCents).toBe(100_000)
    expect(await prisma.journalEntry.count({ where: { tenantId: tenantA, reference: `order.refund_giftcard:${red.id}` } })).toBe(1)
  })

  it('a cancel re-credits the card with no entry (no sale was booked)', async () => {
    const card = await mkCard(tenantA, 50_000)
    const o = await mkOrder(conceptA, { items: 40_000, tax: 6_000, pending: 'cash' })
    await redeemGiftCard({ code: card.code, orderId: o.id })
    await prisma.order.update({ where: { id: o.id }, data: { status: 'cancelled' } })
    await postOrderRefund(o.id, 'Order cancelled')
    expect((await prisma.giftCard.findUniqueOrThrow({ where: { id: card.id } })).balanceCents).toBe(50_000)
    const red = await prisma.giftCardRedemption.findFirstOrThrow({ where: { orderId: o.id } })
    expect(await entry(tenantA, `order.refund_giftcard:${red.id}`)).toBeNull()
  })

  it('a sale booked before the 2080 debit existed is not credited to 2080 a second time on refund', async () => {
    const card = await mkCard(tenantA, 20_000)
    const o = await mkOrder(conceptA, { items: 40_000, tax: 6_000, pending: 'cash' })
    await redeemGiftCard({ code: card.code, orderId: o.id })
    await complete(o.id)
    // The old posting: revenue from the post-card total, no 2080 line.
    await postJournalEntry({
      tenantId: tenantA, sourceType: 'order.complete', sourceId: o.id, description: 'legacy', postedBy: 'test',
      lines: [{ accountCode: '1010', type: 'debit', amountCents: 26_000 }, { accountCode: '4090', type: 'credit', amountCents: 20_000 }, { accountCode: '2030', type: 'credit', amountCents: 6_000 }],
    })
    await refundRow(o.id, 26_000)
    await prisma.order.update({ where: { id: o.id }, data: { status: 'refunded' } })
    const results = await postOrderRefund(o.id, 'Order refunded')
    expect(results).toContainEqual(expect.objectContaining({ reason: 'sale_booked_without_gift_card' }))
    expect((await prisma.giftCard.findUniqueOrThrow({ where: { id: card.id } })).balanceCents).toBe(20_000)
    const red = await prisma.giftCardRedemption.findFirstOrThrow({ where: { orderId: o.id } })
    expect(await entry(tenantA, `order.refund_giftcard:${red.id}`)).toBeNull()
  })

  it('a till bill a gift card paid in full (no drawer receipt) is booked on completion', async () => {
    const card = await mkCard(tenantA, 100_000)
    const o = await mkOrder(conceptA, { source: 'pos', items: 50_000, tax: 7_500 })
    await redeemGiftCard({ code: card.code, orderId: o.id })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).totalCents).toBe(0)
    await complete(o.id)
    expect((await postOrderCompletion(o.id)).posted).toBe(true)
    const je = (await entry(tenantA, `order.complete:${o.id}`))!
    expect(balanced(je)).toBe(true)
    expect(amt(je, '2080', 'debit')).toBe(57_500)
    expect(amt(je, '4090', 'credit')).toBe(50_000)
  })

  it('a till bill part-paid by card is booked by the shift close with its 2080 line, and only there', async () => {
    const card = await mkCard(tenantA, 40_000)
    const shift = await freshShift(tenantA)
    const o = await mkOrder(conceptA, { source: 'pos', items: 100_000, tax: 15_000 })     // 115,000
    await redeemGiftCard({ code: card.code, orderId: o.id })                              // → 75,000
    await pay(o.id, shift.id, 'cash', 75_000)
    await complete(o.id)
    expect(await postOrderCompletion(o.id)).toMatchObject({ posted: false, reason: 'pos_skipped' })
    const lines = await closeAndPost(shift.id, 75_000)
    expect(balanced(lines)).toBe(true)
    expect(amt(lines, '1015', 'debit')).toBe(75_000)
    expect(amt(lines, '2080', 'debit')).toBe(40_000)
    expect(lines.find((l) => l.code === '2080')!.memo).toContain(o.id)
    expect(amt(lines, '4090', 'credit')).toBe(100_000)
    expect(amt(lines, '2030', 'credit')).toBe(15_000)
    expect(amt(lines, '1110', 'debit') + amt(lines, '1110', 'credit')).toBe(0)
  })
})

// ─── BOOKS-10 ─────────────────────────────────────────────────────────────────

describe('restaurant sales tax goes to the brand\'s authority', () => {
  it('maps province to the output account', () => {
    expect(outputTaxCodeFor({ province: 'SD' })).toBe('2032')
    // GS Foods is registered only with FBR and SRB (owner, 2026-10-15): a
    // brand still set to Punjab / KP / Balochistan is refused, never booked to FBR.
    for (const province of ['PB', 'KP', 'BL', 'pb ']) {
      expect(() => outputTaxCodeFor({ province })).toThrow(expect.objectContaining({ code: 'PROVINCE_NOT_REGISTERED', statusCode: 422 }))
    }
    expect(outputTaxCodeFor({ province: 'ICT' })).toBe('2030')
    expect(outputTaxCodeFor({ province: null, srbPosId: 7 })).toBe('2032')
    expect(outputTaxCodeFor({ province: null })).toBe('2030')
  })

  it('a Sindh brand\'s sale and refund use 2032, never 2030', async () => {
    const o = await mkOrder(conceptSD, { items: 100_000, tax: 15_000, ratePct: 15, pending: 'cash' })
    await complete(o.id)
    await postOrderCompletion(o.id)
    const sale = (await entry(tenantA, `order.complete:${o.id}`))!
    expect(amt(sale, '2032', 'credit')).toBe(15_000)
    expect(amt(sale, '2030', 'credit')).toBe(0)
    const r = await refundRow(o.id, 57_500)
    const refund = (await entry(tenantA, `order.refund:${r.id}`))!
    expect(amt(refund, '2032', 'debit')).toBe(7_500)
    expect(amt(refund, '2030', 'debit')).toBe(0)

    const s = await mkOrder(conceptSrbOnly, { items: 10_000, tax: 800, ratePct: 8, pending: 'card' })
    await complete(s.id)
    await postOrderCompletion(s.id)
    expect(amt((await entry(tenantA, `order.complete:${s.id}`))!, '2032', 'credit')).toBe(800)
  })

  it('the shift close credits each brand\'s tax to its own authority', async () => {
    const shift = await freshShift(tenantA)
    const sd = await mkOrder(conceptSD, { source: 'pos', items: 20_000, tax: 3_000, ratePct: 15 })
    const np = await mkOrder(conceptA, { source: 'pos', items: 10_000, tax: 1_500, ratePct: 15 })
    await pay(sd.id, shift.id, 'cash', 23_000)
    await pay(np.id, shift.id, 'cash', 11_500)
    await complete(sd.id); await complete(np.id)
    const lines = await closeAndPost(shift.id, 34_500)
    expect(balanced(lines)).toBe(true)
    expect(amt(lines, '2032', 'credit')).toBe(3_000)
    expect(amt(lines, '2030', 'credit')).toBe(1_500)
  })

  it('the return: per authority, per rate, refunds netted, FBR input never set off against SRB output', async () => {
    const from = new Date(Date.now() - DAY)
    const to = new Date(Date.now() + DAY)
    // 15% cash sale, half refunded.
    const cash = await mkOrder(conceptC, { items: 100_000, tax: 15_000, ratePct: 15, pending: 'cash' })
    await complete(cash.id); await postOrderCompletion(cash.id)
    await refundRow(cash.id, 57_500)
    // 8% card sale online …
    const card = await mkOrder(conceptC, { items: 50_000, tax: 4_000, ratePct: 8, pending: 'card' })
    await complete(card.id); await postOrderCompletion(card.id)
    // … and 8% card at the till, booked by the shift close.
    const shift = await freshShift(tenantC)
    const till = await mkOrder(conceptC, { source: 'pos', items: 20_000, tax: 1_600, ratePct: 8 })
    await pay(till.id, shift.id, 'card', 21_600)
    await complete(till.id)
    await closeAndPost(shift.id, 0)
    // Federal input tax on a goods bill (1320), and a pre-routing sale's tax still in 2030.
    await postJournalEntry({ tenantId: tenantC, sourceType: 'test.bill', sourceId: `bill-${RUN}`, description: 'flour', postedBy: 'test',
      lines: [{ accountCode: '1320', type: 'debit', amountCents: 1_800 }, { accountCode: '5010', type: 'debit', amountCents: 10_000 }, { accountCode: '2010', type: 'credit', amountCents: 11_800 }] })
    await postJournalEntry({ tenantId: tenantC, sourceType: 'test.legacy', sourceId: `legacy-${RUN}`, description: 'legacy sale', postedBy: 'test',
      lines: [{ accountCode: '1010', type: 'debit', amountCents: 6_900 }, { accountCode: '4090', type: 'credit', amountCents: 6_000, conceptId: conceptC }, { accountCode: '2030', type: 'credit', amountCents: 900, conceptId: conceptC }] })
    // Another company's SRB sale must not appear in C's return.
    const other = await mkOrder(conceptB, { items: 90_000, tax: 13_500, ratePct: 15, pending: 'cash' })
    await complete(other.id); await postOrderCompletion(other.id)

    const r = await salesTaxReturn(tenantC, from, to)
    const srb = r.byAuthority.find((a) => a.authority === 'SRB')!
    const fbr = r.byAuthority.find((a) => a.authority === 'FBR')!
    expect(srb.output).toMatchObject({ code: '2032', totalCents: 15_000 - 7_500 + 4_000 + 1_600 })
    expect(srb.netPayableCents).toBe(13_100)
    expect(srb.otherOutputCents).toBe(0)                // every rupee explained by the orders
    expect(fbr.output.totalCents).toBe(900)
    expect(fbr.input.totalCents).toBe(1_800)
    expect(fbr.netPayableCents).toBe(-900)
    expect(r.netPayableCents).toBe(13_100)             // the old return said 14,000 − 1,800 = 12,200
    expect(r.carryForwardCents).toBe(900)
    expect(r.outputTax.srb.totalCents).toBe(13_100)

    const cash15 = r.byRate.find((x) => x.authority === 'SRB' && x.ratePct === 15)!
    expect(cash15).toMatchObject({ tender: 'cash', orders: 1, salesValueCents: 100_000, salesTaxCents: 15_000, refundTaxCents: 7_500, refundValueCents: 50_000, taxableValueCents: 50_000, taxCents: 7_500 })
    const card8 = r.byRate.find((x) => x.authority === 'SRB' && x.ratePct === 8)!
    expect(card8).toMatchObject({ tender: 'card', orders: 2, salesValueCents: 70_000, salesTaxCents: 5_600, taxCents: 5_600 })
    expect(r.byRate.reduce((t, x) => t + x.taxCents, 0)).toBe(srb.output.totalCents)

    expect(r.reclassification).toEqual([expect.objectContaining({ conceptSlug: `ls-c-${RUN}`, fromAccount: '2030', toAccount: '2032', amountCents: 900 })])
  })
})

// ─── FOH-09 ───────────────────────────────────────────────────────────────────

describe('money taken on a cancelled ticket is not a sale', () => {
  it('is held as a refund due (Dr drawer / Cr 1110), with no revenue or tax', async () => {
    const shift = await freshShift(tenantA)
    const sold = await mkOrder(conceptA, { source: 'pos', items: 50_000, tax: 7_500, ratePct: 15 })
    const voided = await mkOrder(conceptA, { source: 'pos', status: 'cancelled', items: 55_000, tax: 8_250, ratePct: 15 })
    await pay(sold.id, shift.id, 'cash', 57_500)
    await pay(voided.id, shift.id, 'cash', 63_250)
    await complete(sold.id)

    const payments = await prisma.payment.findMany({ where: { shiftId: shift.id }, include: SHIFT_SALE_PAYMENT_INCLUDE })
    const sales = summariseShiftSales(shift.id, payments)
    expect(sales.totals).toMatchObject({ orders: 1, revenueCents: 50_000, taxCents: 7_500 })
    expect(sales.cancelledPaid).toMatchObject({ cashCents: 63_250, cardCents: 0, orderIds: [voided.id] })

    const lines = await closeAndPost(shift.id, 57_500 + 63_250)
    expect(balanced(lines)).toBe(true)
    expect(amt(lines, '4090', 'credit')).toBe(50_000)
    expect(amt(lines, '2030', 'credit')).toBe(7_500)
    expect(amt(lines, '1015', 'debit')).toBe(57_500 + 63_250)
    const due = lines.filter((l) => l.code === '1110' && l.type === 'credit')
    expect(due.reduce((t, l) => t + l.amount, 0)).toBe(63_250)
    expect(due[0]!.memo).toContain('REFUND DUE')
    expect(amt(lines, '8010', 'debit') + amt(lines, '8010', 'credit')).toBe(0)
  })
})

// ─── FOH-14 ───────────────────────────────────────────────────────────────────

describe('a till tip is a liability to staff', () => {
  it('a tip on the order and its tender is credited to 2095', async () => {
    const shift = await freshShift(tenantA)
    const o = await mkOrder(conceptA, { source: 'pos', items: 100_000, tax: 8_000, ratePct: 8, tip: 20_000 })   // total 128,000
    await pay(o.id, shift.id, 'card', 128_000, { tipCents: 20_000 })
    await complete(o.id)
    const lines = await closeAndPost(shift.id, 0)
    expect(balanced(lines)).toBe(true)
    expect(amt(lines, '1030', 'debit')).toBe(128_000)
    expect(amt(lines, '2095', 'credit')).toBe(20_000)
    expect(amt(lines, '4090', 'credit')).toBe(100_000)
    expect(amt(lines, '2030', 'credit')).toBe(8_000)
    expect(codes(lines)).not.toContain('1110')
  })

  it('a tip found only on the tender is still a tip, not an overpayment to 1110', async () => {
    const shift = await freshShift(tenantA)
    const o = await mkOrder(conceptA, { source: 'pos', items: 100_000, tax: 8_000, ratePct: 8 })                 // total 108,000
    await pay(o.id, shift.id, 'card', 128_000, { tipCents: 20_000 })
    await complete(o.id)
    const lines = await closeAndPost(shift.id, 0)
    expect(balanced(lines)).toBe(true)
    expect(amt(lines, '2095', 'credit')).toBe(20_000)
    expect(amt(lines, '4090', 'credit')).toBe(100_000)
    expect(codes(lines)).not.toContain('1110')
  })

  it('the one sale formula still balances with a gift card in it', () => {
    const sa = computeSaleAccounting({ totalCents: 164_500, walletAmountCents: 0, giftCardAppliedCents: 100_000, taxCents: 34_500, discountCents: 0, promoDiscountCents: 0, serviceChargeCents: 0, tipCents: 0 })
    expect(sa.grossRevenueCents).toBe(230_000)
    expect(sa.totalChargedCents + sa.walletAppliedCents + sa.giftCardAppliedCents + sa.discountCents)
      .toBe(sa.grossRevenueCents + sa.taxCents + sa.serviceChargeCents + sa.tipCents)
  })
})
