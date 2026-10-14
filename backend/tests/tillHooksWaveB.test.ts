// The till's wave-B hooks in pos/service.ts (finance wave B, w3-till):
//
//   - Delivery-fee GST on top (H9): a till re-price for the tender carries the
//     fee's GST at the new tender's rate (Order.deliveryFeeTaxCents), and the
//     quote shows it — exactly what the payment then demands.
//   - The cancelled-ticket unwind (LEDGER R5-C): a delivery ticket whose home
//     drawer close booked it as a live sale (Cr 4110 for the fee) and that is
//     then cancelled has the fee undone too (Dr 4110) — every sale line nets
//     to zero, only the money owed back is left on 1110. Company B's unwind
//     never touches company A's books.
//   - Raast "void, never booked": a Raast receipt the CEO voided is no money
//     taken — it is left out of what the ticket owes back (the till's figure
//     equals orderPosting.refundDueCents), out of the Z-report's cancelledPaid
//     and refund due, and it is no hand-back option (by Raast: 422).
//
// Two companies. Requires a disposable database (DATABASE_URL must contain "test").
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { randomBytes } from 'node:crypto'
import { quoteOrderForTender, getZReport } from '../src/modules/pos/service.js'
import { cancelOrder } from '../src/modules/orders/service.js'
import { refundDueCents } from '../src/modules/accounting/orderPosting.js'
import { postShiftClose } from '../src/modules/accounting/shiftPosting.js'
import { voidNeverBooked } from '../src/modules/reconciliation/raast.js'
import { priceOrder } from '../src/lib/pricing.js'
import { setFiscalKicker } from '../src/connectors/fiscal/outbox.js'
import {
  prisma, mkCompany, mkUser, buildApp, caller, openDrawer, mkRaastAccount, resetConnectorCache,
  type Company, type Who,
} from './connectorsFixtures.js'

let app: FastifyInstance
let call: ReturnType<typeof caller>
let A: Company, B: Company
let cashierA: Who, mgrA: Who, ceoA: Who, cashierB: Who, mgrB: Who
let bankA: { bankAccountId: string; ledgerCode: string }

const FEE = 20_000
const KHEER = 55_000

type Line = { code: string; type: string; amount: number; tenantId: string }
async function linesOf(tenantId: string, references: string[]): Promise<Line[]> {
  const rows = await prisma.journalLine.findMany({
    where: { journalEntry: { tenantId, reference: { in: references } } },
    select: { type: true, amountCents: true, account: { select: { code: true, tenantId: true } } },
  })
  return rows.map((r) => ({ code: r.account.code, type: r.type, amount: Number(r.amountCents), tenantId: r.account.tenantId! }))
}
const amt = (lines: Line[], code: string, type: 'debit' | 'credit') =>
  lines.filter((l) => l.code === code && l.type === type).reduce((t, l) => t + l.amount, 0)
/** Accounts that do not net to zero (debit +). */
const nonZero = (lines: Line[]) => {
  const net = new Map<string, number>()
  for (const l of lines) net.set(l.code, (net.get(l.code) ?? 0) + (l.type === 'debit' ? l.amount : -l.amount))
  return Object.fromEntries([...net].filter(([, v]) => v !== 0))
}

beforeAll(async () => {
  setFiscalKicker(async () => {})
  const run = randomBytes(3).toString('hex')
  A = await mkCompany(`thw-a-${run}`)
  B = await mkCompany(`thw-b-${run}`)
  cashierA = await mkUser(`thw-cashier-a-${run}`, 'cashier', A.tenantId)
  mgrA = await mkUser(`thw-mgr-a-${run}`, 'foh_management', A.tenantId)
  ceoA = await mkUser(`thw-ceo-a-${run}`, 'admin', A.tenantId)
  cashierB = await mkUser(`thw-cashier-b-${run}`, 'cashier', B.tenantId)
  mgrB = await mkUser(`thw-mgr-b-${run}`, 'foh_management', B.tenantId)
  bankA = await mkRaastAccount(A)
  app = await buildApp()
  call = caller(app)
}, 60_000)

afterAll(async () => {
  // Every entry this suite wrote, in either company, balances, on its own company's chart.
  const entries = await prisma.journalEntry.findMany({
    where: { tenantId: { in: [A.tenantId, B.tenantId] } },
    include: { lines: { include: { account: { select: { tenantId: true } } } } },
  })
  for (const e of entries) {
    const d = e.lines.filter((l) => l.type === 'debit').reduce((t, l) => t + Number(l.amountCents), 0)
    const c = e.lines.filter((l) => l.type === 'credit').reduce((t, l) => t + Number(l.amountCents), 0)
    expect(d, `entry ${e.reference} balances`).toBe(c)
    for (const l of e.lines) expect(l.account.tenantId, `entry ${e.reference} stays in its company`).toBe(e.tenantId)
  }
  setFiscalKicker(null)
  resetConnectorCache()
  await app?.close()
})

/** A till ticket for delivery: 1 × Kheer + the delivery fee, priced through lib/pricing at `tender`. */
async function deliveryTicket(co: Company, tender: 'cash' | 'card') {
  const concept = await prisma.concept.findUniqueOrThrow({ where: { id: co.conceptId }, select: { id: true, tenantId: true, taxRateCash: true, taxRateCard: true } })
  const lines = [{ menuItemId: co.items.kheer, unitPriceCents: KHEER, quantity: 1, modifiers: [] }]
  const price = await priceOrder(lines, tender, 'pos', concept, { deliveryFeeCents: FEE })
  const order = await prisma.order.create({
    data: {
      conceptId: co.conceptId, locationId: co.locationId, source: 'pos', fulfilmentType: 'delivery', status: 'received',
      totalCents: price.totalCents, taxCents: price.taxCents, taxRatePct: price.taxRatePct, serviceChargeCents: price.serviceChargeCents,
      deliveryFeeCents: price.deliveryFeeCents, deliveryFeeTaxCents: price.deliveryFeeTaxCents,
      items: { create: [{ menuItemId: co.items.kheer, name: 'Kheer', quantity: 1, unitPriceCents: KHEER, serviceVessel: 'plate' }] },
    },
  })
  return { order, price, concept, lines }
}

// ─── Delivery-fee GST on a till re-price ────────────────────────────────────

describe('a till re-price for the tender carries the delivery fee\'s GST', () => {
  it('priced at the card rate, paid in cash: the quote and the payment re-price the fee GST at 15%', async () => {
    const { order, price: card, concept, lines } = await deliveryTicket(A, 'card')
    expect(card.taxRatePct).toBe(8)
    expect(card.deliveryFeeTaxCents).toBe(1_600)
    const cash = await priceOrder(lines, 'cash', 'pos', concept, { deliveryFeeCents: FEE })
    expect(cash.deliveryFeeTaxCents).toBe(3_000)

    // The quote shows what the payment will demand, the fee's GST with it.
    const q = await quoteOrderForTender(order.id, 'cash')
    expect(q.repriced).toBe(true)
    expect(q.taxRatePct).toBe(15)
    expect(q.deliveryFeeCents).toBe(FEE)
    expect(q.deliveryFeeTaxCents).toBe(3_000)
    expect(q.taxCents).toBe(cash.taxCents)
    expect(q.totalCents).toBe(cash.totalCents)
    // The card quote is the stored bill.
    const qc = await quoteOrderForTender(order.id, 'card')
    expect(qc.repriced).toBe(false)
    expect(qc.deliveryFeeTaxCents).toBe(1_600)

    // Paid in cash at the till: the order is re-priced and stores the fee's GST.
    const drawer = await openDrawer(A, cashierA)
    const r = await call(cashierA, 'POST', '/pos/payments', {
      orderId: order.id, shiftId: drawer, payments: [{ method: 'cash', amountCents: cash.totalCents, tenderedCents: cash.totalCents }],
    })
    expect(r.statusCode, r.body).toBe(201)
    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
    expect(after.taxRatePct).toBe(15)
    expect(after.deliveryFeeCents).toBe(FEE)
    expect(after.deliveryFeeTaxCents).toBe(3_000)
    expect(after.taxCents).toBe(cash.taxCents)
    expect(after.totalCents).toBe(cash.totalCents)
    expect(after.totalCents).toBe(KHEER + cash.itemTaxCents + FEE + 3_000 + cash.serviceChargeCents)
  })

  it("company B's cashier cannot quote or pay A's ticket", async () => {
    const { order } = await deliveryTicket(A, 'card')
    expect((await call(cashierB, 'GET', `/pos/orders/${order.id}/quote?method=cash`)).statusCode).toBe(404)
    const drawerB = await openDrawer(B, cashierB)
    const r = await call(cashierB, 'POST', '/pos/payments', { orderId: order.id, shiftId: drawerB, payments: [{ method: 'cash', amountCents: 1_000 }] })
    expect([403, 404]).toContain(r.statusCode)
    const untouched = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
    expect(untouched.taxRatePct).toBe(8)
    expect(untouched.deliveryFeeTaxCents).toBe(1_600)
  })
})

// ─── The cancelled-ticket unwind reverses 4110 ──────────────────────────────

describe('a cancelled delivery ticket whose home drawer booked it live: the unwind reverses 4110 too', () => {
  /** Part-pay the ticket in cash on a fresh drawer of `co` and post that drawer's close (it books the open ticket as a live sale). */
  async function partPayAndClose(co: Company, who: Who, orderId: string, cents: number): Promise<string> {
    const shiftId = await openDrawer(co, who)
    await prisma.payment.create({ data: { orderId, shiftId, method: 'cash', amountCents: cents, status: 'paid', processedAt: new Date() } })
    await prisma.shift.update({ where: { id: shiftId }, data: { status: 'closed', closedAt: new Date(), closingFloatCents: cents } })
    const r = await postShiftClose(shiftId)
    expect(r.posted, r.reason).toBe(true)
    return shiftId
  }

  async function cancelledDeliveryTicket(co: Company, cashier: Who, mgr: Who) {
    const { order, price } = await deliveryTicket(co, 'cash')
    const shiftId = await partPayAndClose(co, cashier, order.id, 50_000)
    const close = await linesOf(co.tenantId, [`shift.close:${shiftId}`])
    expect(amt(close, '4110', 'credit')).toBe(FEE)            // the close booked the fee as delivery revenue
    await cancelOrder(order.id, { reason: 'Customer cancelled before dispatch', actor: { id: mgr.id, tenantId: co.tenantId }, approverId: mgr.id })
    return { order, price, shiftId }
  }

  it('A: Dr 4110 for the fee with the food revenue and the GST; only the money owed back stays on 1110', async () => {
    const { order, price, shiftId } = await cancelledDeliveryTicket(A, cashierA, mgrA)
    const unwind = await linesOf(A.tenantId, [`order.cancel_unwind:${order.id}`])
    expect(unwind.length).toBeGreaterThan(0)
    expect(amt(unwind, '4110', 'debit')).toBe(FEE)
    expect(amt(unwind, '4110', 'credit')).toBe(0)
    expect(amt(unwind, '1110', 'credit')).toBe(price.totalCents)
    expect(unwind.every((l) => l.tenantId === A.tenantId)).toBe(true)
    const tagged = await prisma.journalLine.findMany({
      where: { account: { tenantId: A.tenantId, code: '4110' }, journalEntry: { tenantId: A.tenantId, reference: `order.cancel_unwind:${order.id}` } },
      select: { conceptId: true },
    })
    expect(tagged.map((l) => l.conceptId)).toEqual([A.conceptId])

    // The close and the unwind together: every sale line (revenue, 4110, GST) nets to zero;
    // the drawer holds the cash and 1110 the 50,000 owed back.
    const both = await linesOf(A.tenantId, [`shift.close:${shiftId}`, `order.cancel_unwind:${order.id}`])
    expect(nonZero(both)).toEqual({ '1015': 50_000, '1110': -50_000 })

    // Handing the cash back clears 1110 — never revenue, never 4110.
    const drawer = await openDrawer(A, mgrA)
    const r = await call(mgrA, 'POST', `/pos/orders/${order.id}/refund`, { amountCents: 50_000, reason: 'Cancelled — handed back', method: 'cash', shiftId: drawer })
    expect(r.statusCode, r.body).toBe(200)
    const refund = await prisma.payment.findFirstOrThrow({ where: { orderId: order.id, status: 'refunded' } })
    const handBack = await linesOf(A.tenantId, [`order.refund:${refund.id}`])
    expect(handBack.filter((l) => /^4/.test(l.code))).toEqual([])
    const all = await linesOf(A.tenantId, [`shift.close:${shiftId}`, `order.cancel_unwind:${order.id}`, `order.refund:${refund.id}`])
    // Drawer: 50,000 in at the close, 50,000 out at the hand-back — the ticket nets to nothing.
    expect(nonZero(all)).toEqual({})
  })

  it("B: its own unwind reverses B's 4110 on B's chart and never touches A's books", async () => {
    const aBefore = await prisma.journalEntry.count({ where: { tenantId: A.tenantId } })
    const aLinesBefore = await prisma.journalLine.count({ where: { account: { tenantId: A.tenantId } } })
    const { order } = await cancelledDeliveryTicket(B, cashierB, mgrB)
    const unwind = await linesOf(B.tenantId, [`order.cancel_unwind:${order.id}`])
    expect(amt(unwind, '4110', 'debit')).toBe(FEE)
    expect(unwind.every((l) => l.tenantId === B.tenantId)).toBe(true)
    expect(await prisma.journalEntry.count({ where: { reference: `order.cancel_unwind:${order.id}` } })).toBe(1)
    expect(await prisma.journalEntry.count({ where: { tenantId: A.tenantId } })).toBe(aBefore)
    expect(await prisma.journalLine.count({ where: { account: { tenantId: A.tenantId } } })).toBe(aLinesBefore)
    // A's manager cannot hand back B's ticket.
    expect((await call(mgrA, 'POST', `/pos/orders/${order.id}/refund`, { amountCents: 1_000, reason: 'Not mine', method: 'cash' })).statusCode).toBe(404)
  })
})

// ─── Raast "void, never booked" ─────────────────────────────────────────────

describe('a Raast receipt the CEO voided as never booked is no money taken at the till', () => {
  let orderId: string
  let shiftId: string

  beforeAll(async () => {
    // A till ticket paid 50,000 by Raast + 30,000 cash on a drawer that closed
    // without its close reaching the books, then cancelled.
    shiftId = await openDrawer(A, cashierA)
    const order = await prisma.order.create({
      data: {
        conceptId: A.conceptId, source: 'pos', fulfilmentType: 'takeout', status: 'cancelled', totalCents: 80_000, taxCents: 0,
        items: { create: [{ name: 'Kheer', quantity: 1, unitPriceCents: 80_000, menuItemId: A.items.kheer }] },
      },
    })
    orderId = order.id
    const ref = `THW${randomBytes(5).toString('hex').replace(/[^0-9]/g, '7').slice(0, 9)}`
    const rp = await prisma.payment.create({
      data: { orderId, shiftId, method: 'raast', amountCents: 50_000, status: 'paid', processedAt: new Date(), gateway: 'raast', gatewayRef: ref },
    })
    await prisma.payment.create({ data: { orderId, shiftId, method: 'cash', amountCents: 30_000, status: 'paid', processedAt: new Date() } })
    const receipt = await prisma.raastReceipt.create({
      data: {
        tenantId: A.tenantId, orderId, conceptId: A.conceptId, shiftId, paymentId: rp.id,
        bankAccountId: bankA.bankAccountId, ledgerCode: bankA.ledgerCode, amountCents: 50_000, dueCents: 80_000, bankRef: ref,
        status: 'provisional', confirmedVia: 'cashier', confirmedAt: new Date(), cashierVerified: true,
        idempotencyKey: `pay:${rp.id}`, createdById: cashierA.id,
      },
    })
    await prisma.shift.update({ where: { id: shiftId }, data: { status: 'closed', closedAt: new Date(), closingFloatCents: 30_000 } })

    // Before the void the Z-report holds both as a refund due.
    const z0 = await getZReport(shiftId)
    expect(z0.cancelledPaid.raastCents).toBe(50_000)
    expect(z0.refundDueCents).toBe(80_000)

    expect((await voidNeverBooked(receipt.id, { actorId: ceoA.id, reason: 'Transfer never arrived, never booked' })).status).toBe('voided')
  })

  const orderWithReceipts = () => prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    select: { status: true, payments: { select: { method: true, status: true, amountCents: true, gatewayRef: true, shiftId: true, raastReceipt: { select: { status: true } } } } },
  })

  it("the Z-report: cancelledPaid and refund due leave the voided Raast out; it shows as voided", async () => {
    const z = await getZReport(shiftId)
    expect(z.cancelledPaid.count).toBe(1)
    expect(z.cancelledPaid.cashCents).toBe(30_000)
    expect(z.cancelledPaid.raastCents).toBe(0)
    expect(z.refundDueCents).toBe(30_000)
    expect(z.raastVoidedCents).toBe(50_000)
    expect(z.raastProvisionalCents).toBe(0)
  })

  it('no Raast hand-back is offered; the till\'s refund due equals orderPosting.refundDueCents', async () => {
    expect(refundDueCents(await orderWithReceipts())).toBe(30_000)
    const drawer = await openDrawer(A, mgrA)

    // By Raast: not a tender this ticket still owes back.
    const raast = await call(mgrA, 'POST', `/pos/orders/${orderId}/refund`, { amountCents: 10_000, reason: 'Cancelled — handed back', method: 'raast', gatewayRef: 'UBL1234567890' })
    expect(raast.statusCode, raast.body).toBe(422)
    expect(raast.json().error.code).toBe('REFUND_METHOD_NOT_TENDERED')
    // More than the cash still owed back.
    const over = await call(mgrA, 'POST', `/pos/orders/${orderId}/refund`, { amountCents: 30_001, reason: 'Cancelled — handed back', method: 'cash', shiftId: drawer })
    expect(over.statusCode, over.body).toBe(422)
    expect(over.json().error.code).toBe('REFUND_EXCEEDS_DUE')
    // With no tender named, the hand-back defaults to cash (never the voided Raast).
    const part = await call(mgrA, 'POST', `/pos/orders/${orderId}/refund`, { amountCents: 10_000, reason: 'Cancelled — handed back', shiftId: drawer })
    expect(part.statusCode, part.body).toBe(200)
    expect(part.json().method).toBe('cash')
    expect(part.json().refundDueLeftCents).toBe(20_000)
    expect(refundDueCents(await orderWithReceipts())).toBe(20_000)

    const rest = await call(mgrA, 'POST', `/pos/orders/${orderId}/refund`, { amountCents: 20_000, reason: 'Cancelled — handed back', method: 'cash', shiftId: drawer })
    expect(rest.statusCode, rest.body).toBe(200)
    expect(rest.json().refundDueLeftCents).toBe(0)
    expect(refundDueCents(await orderWithReceipts())).toBe(0)
    const none = await call(mgrA, 'POST', `/pos/orders/${orderId}/refund`, { amountCents: 1, reason: 'Cancelled — handed back', method: 'cash', shiftId: drawer })
    expect(none.statusCode).toBe(422)
    expect(none.json().error.code).toBe('NOTHING_TO_REFUND')
    // Nothing ever went back against the bank.
    const refunds = await prisma.payment.findMany({ where: { orderId, status: 'refunded' }, select: { id: true, method: true } })
    expect(refunds.map((r) => r.method)).toEqual(['cash', 'cash'])
    const books = await linesOf(A.tenantId, refunds.map((r) => `order.refund:${r.id}`))
    expect(books.some((l) => l.code === bankA.ledgerCode)).toBe(false)
  })

  it("company B's manager gets 404 on A's ticket", async () => {
    const r = await call(mgrB, 'POST', `/pos/orders/${orderId}/refund`, { amountCents: 1_000, reason: 'Not mine', method: 'cash' })
    expect(r.statusCode).toBe(404)
  })
})
