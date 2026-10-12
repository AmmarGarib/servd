// POS shift close → journal posting.
//
// Per-order JE posting is skipped for `source = pos` (orderPosting.ts) — POS
// sales close out at shift end. One journal entry per shift, keyed on shiftId
// for idempotency.
//
// THE SALE SIDE uses the one sale-to-ledger formula, computeSaleAccounting
// (orderPosting.ts), applied to every till order the shift books and summed
// per brand: item revenue to the brand's 4xxx, service charge to 4100, tips to
// 2095 (FOH-14: the till puts a tip on Order.tipCents and its total), output
// tax to the brand's authority (2032 SRB for a Sindh kitchen, else 2030 —
// outputTaxCodeFor, BOOKS-10), discounts to 7010, wallet to 2050, and what a
// gift card paid to 2080 (ONL-05 — one line per order, naming it, so a refund
// can tell the card was booked). This shift close used
// to carry its own inline copy, which credited POS service charge to food
// revenue, and which balanced only when an order's payments on the drawer
// equalled its total to the paisa — a card still awaiting the gateway, a
// split across drawers or a rounding paisa made the entry unbalanced, and the
// WHOLE shift was then refused by postJournalEntry and never reached the books.
//
// Which orders a shift books, and how the money side is debited:
//   • A till order (source 'pos') is booked ONCE, by its home shift: the
//     drawer that holds its earliest receipt. Receipts on this drawer are
//     debited — cash 1015, card / QR 1030, comp 7030. Every till card / QR
//     tender carries the terminal's reference and settles at the till (owner
//     decision 4), so it is 1030 from the moment of sale; an older row still
//     'pending' with a reference is debited to 1030 too (memo'd "awaiting
//     gateway confirmation"), and postPosCardFailure moves a tender the
//     gateway fails after the close to 1110.
//   • Whatever of the order was NOT received on its home drawer (a split
//     still open, a failed card, a part paid on another drawer) is debited to
//     1110 Customer receivable; a receipt for that order on another drawer
//     credits 1110 back. A difference within the till's 2-paisa tender
//     tolerance is rounding, to 8010.
//   • An online / non-till order paid at the drawer is already booked by its
//     own order.complete entry, so the shift books only the cash moving into
//     the drawer (Dr 1015 / Cr 1010) — it used to book that sale a second time.
//   • A CANCELLED or REJECTED order was never sold (FOH-09): money taken on
//     one is not revenue or tax. It is debited where it sits (1015 / 1030) and
//     credited to 1110 Customer accounts receivable — a credit balance there is
//     the customer's money we owe back ("refund due"), one line per order
//     naming it — until it is handed back: the refund row on the cancelled
//     order books Dr 1110 / Cr 1015 or 1030 (postRefundPayment, LEDGER-R5).
//     It used to be booked as a sale and its tax.
//
// The drawer side uses the ONE expected-cash formula (lib/drawer.ts), the same
// figure the cashier counted against. Every movement of cash in or out of the
// drawer that is not a sale gets its own balanced pair, so the 8010 line is
// the true over/short only:
//
//   drop            Dr 1010 Cash on hand      / Cr 1015 Drawer
//   add, pay-in     Dr 1015 Drawer            / Cr 1010 Cash on hand
//   cash refund     Dr 7040 Refunds issued    / Cr 1015 Drawer
//   card refund     Dr 7040 Refunds issued    / Cr 1030 Card receivable
//   pay-out         Dr 8010 (unclassified)    / Cr 1015 Drawer
//   over / short    Dr/Cr 8010                / Cr/Dr 1015
//
// Refunds and pay-outs post their OWN entries, at the moment they happen:
//   • every refund row → 'order.refund:<paymentId>' (orderPosting.ts
//     postRefundPayment, written by the one refund engine), on the drawer
//     that is open when the cash leaves (owner decision 3);
//   • every vendor pay-out → 'pos.payout:<movementId>' (pos/service.ts
//     recordCashMovement), to its expense category or supplier bill (owner
//     decision 5).
// A refund or pay-out that has its own entry is skipped here. Only rows from
// before those postings existed are still booked by the close — refunds gross
// to 7040 without their GST share, pay-outs to 8010 memo'd for the accountant
// to reclassify — so a legacy drawer still balances.

import { prisma } from '../../lib/prisma.js'
import { ACCT, postJournalEntry, revenueCodeForConcept, type JournalLineInput } from './journal.js'
import {
  computeSaleAccounting, giftCardAppliedOf, GATEWAY_METHODS, giftCardSaleMemo, homeShiftOf, isShiftReceipt, outputTaxCodeFor, withTenderTips,
  GIFT_CARD_LIABILITY, REFUND_DUE_PREFIX, refundDueMemo, type SaleOrderFields, type TaxJurisdiction,
} from './orderPosting.js'
import { drawerExpectationOf } from '../../lib/drawer.js'
import { cogsForSoldLines } from '../../lib/recipeCost.js'
import { SHIFT_COMPANY_INCLUDE, shiftTenantId } from '../../lib/tenantScope.js'

/** processPayment accepts a tender within 2 paisa of what is due. */
export const TENDER_ROUNDING_CENTS = 2

// ─── The sale side, shared with the Z-report ────────────────────────────────

export interface ShiftOrderPaymentRow {
  id: string
  shiftId: string | null
  method: string
  status: string
  amountCents: number
  gatewayRef: string | null
  createdAt: Date
  /** The till records a tender's tip here as { tipCents } (FOH-14). */
  gatewayMeta?: unknown
}

export interface ShiftSaleOrder extends SaleOrderFields {
  id: string
  source: string
  /** Order status — a cancelled / rejected order is never a sale (FOH-09). */
  status?: string
  conceptId: string
  concept: { id: string; slug: string } & TaxJurisdiction
  /** Every payment of the order, on any drawer. */
  payments: ShiftOrderPaymentRow[]
  /** What gift cards paid of the bill (ONL-05). */
  giftCardRedemptions?: Array<{ amountCents: number }>
}

export interface ShiftPaymentRow extends ShiftOrderPaymentRow {
  orderId: string
  order: ShiftSaleOrder | null
}

/** The select that loads what summariseShiftSales needs for a shift's payments. */
export const SHIFT_SALE_PAYMENT_INCLUDE = {
  order: {
    select: {
      id: true, source: true, status: true, conceptId: true,
      totalCents: true, walletAmountCents: true, taxCents: true, discountCents: true,
      promoDiscountCents: true, serviceChargeCents: true, tipCents: true,
      concept: { select: { id: true, slug: true, province: true, srbPosId: true } },
      payments: { select: { id: true, shiftId: true, method: true, status: true, amountCents: true, gatewayRef: true, gatewayMeta: true, createdAt: true } },
      giftCardRedemptions: { select: { amountCents: true } },
    },
  },
} as const

// The receipt rule and the home-drawer rule live with the sale formula
// (orderPosting.ts) so the refund engine can use them too.
export { isShiftReceipt, homeShiftOf }

/** Order statuses that were never a sale: money taken on them is owed back. */
const NEVER_SOLD = new Set(['cancelled', 'rejected'])

export interface ShiftBrandSales {
  conceptId: string
  conceptSlug: string
  /** The output-tax account this brand's tax is owed on (outputTaxCodeFor). */
  taxAccountCode: string
  /** Till orders this drawer books for the brand — what its COGS is costed from. */
  orderIds: string[]
  /** Gift-card value per order (Dr 2080, one line each). */
  giftCards: Array<{ orderId: string; cents: number }>
  orders: number
  revenueCents: number
  serviceChargeCents: number
  tipCents: number
  taxCents: number
  discountCents: number
  walletAppliedCents: number
  giftCardAppliedCents: number
}

export interface ShiftSales {
  byConcept: Map<string, ShiftBrandSales>
  totals: Omit<ShiftBrandSales, 'conceptId' | 'conceptSlug' | 'orderIds' | 'giftCards' | 'taxAccountCode'>
  /** Receipts on this drawer for the till orders it books or clears. */
  cashCents: number
  cardPaidCents: number
  cardAwaitingCents: number
  compCents: number
  /** Home orders not fully received on this drawer (Dr 1110). */
  unsettledCents: number
  /** Receipts here for till orders booked by another drawer (Cr 1110). */
  settledElsewhereCents: number
  /** Net sub-tolerance differences (+ = received more than billed). */
  roundingCents: number
  /** Cash for non-till orders, already booked on their own entries (Dr 1015 / Cr 1010). */
  nonTillCashCents: number
  /**
   * Money taken here on cancelled / rejected orders (FOH-09) — not a sale:
   * Dr 1015 (cash) / 1030 (card, QR), Cr 1110 refund due to the customer.
   */
  cancelledPaid: {
    cashCents: number
    cardCents: number
    orderIds: string[]
    /** Per order — one Cr 1110 line each, naming the order (the refund engine looks for it). */
    byOrder: Array<{ orderId: string; cents: number }>
  }
}

/**
 * The shift's sales, from its payment rows — pure. The ledger post and the
 * Z-report both read these totals, so the Z-report's tax, discount and tips
 * are the figures the shift actually booked.
 */
export function summariseShiftSales(shiftId: string, payments: ShiftPaymentRow[]): ShiftSales {
  const out: ShiftSales = {
    byConcept: new Map(),
    totals: { orders: 0, revenueCents: 0, serviceChargeCents: 0, tipCents: 0, taxCents: 0, discountCents: 0, walletAppliedCents: 0, giftCardAppliedCents: 0 },
    cashCents: 0, cardPaidCents: 0, cardAwaitingCents: 0, compCents: 0,
    unsettledCents: 0, settledElsewhereCents: 0, roundingCents: 0, nonTillCashCents: 0,
    cancelledPaid: { cashCents: 0, cardCents: 0, orderIds: [], byOrder: [] },
  }

  const orders = new Map<string, ShiftSaleOrder>()
  for (const p of payments) if (p.order && !orders.has(p.order.id)) orders.set(p.order.id, p.order)

  for (const order of orders.values()) {
    const here = order.payments.filter((p) => p.shiftId === shiftId && isShiftReceipt(p))
    if (here.length === 0) continue

    if (order.status && NEVER_SOLD.has(order.status)) {
      // FOH-09: a cancelled ticket that took money is not a sale — every
      // drawer holds its own receipts for it as a refund due. (A comp is not
      // money; there is nothing to give back.)
      let cents = 0
      for (const p of here) {
        if (p.method === 'comp') continue
        if (p.method === 'cash') out.cancelledPaid.cashCents += p.amountCents
        else out.cancelledPaid.cardCents += p.amountCents
        cents += p.amountCents
      }
      if (cents > 0) {
        out.cancelledPaid.orderIds.push(order.id)
        out.cancelledPaid.byOrder.push({ orderId: order.id, cents })
      }
      continue
    }

    if (order.source !== 'pos') {
      // Booked by its own order.complete entry; only its cash moved into
      // this drawer.
      out.nonTillCashCents += here.filter((p) => p.method === 'cash').reduce((t, p) => t + p.amountCents, 0)
      continue
    }

    let receivedHere = 0
    for (const p of here) {
      receivedHere += p.amountCents
      if (p.method === 'cash') out.cashCents += p.amountCents
      else if (p.method === 'comp') out.compCents += p.amountCents
      else if (p.status === 'paid') out.cardPaidCents += p.amountCents
      else out.cardAwaitingCents += p.amountCents
    }

    if (homeShiftOf(order) !== shiftId) {
      // Booked by its home drawer, which left the unreceived part in 1110.
      out.settledElsewhereCents += receivedHere
      continue
    }

    // A tip found only on the tenders is folded into the order (FOH-14), and
    // what a gift card paid is added back to the sale (ONL-05).
    const sa = computeSaleAccounting(withTenderTips(
      { ...order, giftCardAppliedCents: giftCardAppliedOf(order.giftCardRedemptions) },
      order.payments,
    ))
    const brand = out.byConcept.get(order.conceptId) ?? {
      conceptId: order.conceptId, conceptSlug: order.concept.slug, taxAccountCode: outputTaxCodeFor(order.concept),
      orderIds: [], giftCards: [], orders: 0,
      revenueCents: 0, serviceChargeCents: 0, tipCents: 0, taxCents: 0, discountCents: 0, walletAppliedCents: 0, giftCardAppliedCents: 0,
    }
    brand.orders             += 1
    brand.orderIds.push(order.id)
    brand.revenueCents       += sa.grossRevenueCents
    brand.serviceChargeCents += sa.serviceChargeCents
    brand.tipCents           += sa.tipCents
    brand.taxCents           += sa.taxCents
    brand.discountCents      += sa.discountCents
    brand.walletAppliedCents += sa.walletAppliedCents
    brand.giftCardAppliedCents += sa.giftCardAppliedCents
    if (sa.giftCardAppliedCents > 0) brand.giftCards.push({ orderId: order.id, cents: sa.giftCardAppliedCents })
    out.byConcept.set(order.conceptId, brand)

    const gap = sa.totalChargedCents - receivedHere
    if (Math.abs(gap) <= TENDER_ROUNDING_CENTS) out.roundingCents -= gap
    else if (gap > 0) out.unsettledCents += gap
    else out.settledElsewhereCents += -gap   // received more here than billed: credit 1110
  }

  for (const b of out.byConcept.values()) {
    out.totals.orders             += b.orders
    out.totals.revenueCents       += b.revenueCents
    out.totals.serviceChargeCents += b.serviceChargeCents
    out.totals.tipCents           += b.tipCents
    out.totals.taxCents           += b.taxCents
    out.totals.discountCents      += b.discountCents
    out.totals.walletAppliedCents += b.walletAppliedCents
    out.totals.giftCardAppliedCents += b.giftCardAppliedCents
  }
  return out
}

// ─── The entry ───────────────────────────────────────────────────────────────

export type ShiftCloseEntry =
  | { ok: false; reason: 'shift_not_found' | 'shift_has_no_company' | 'no_postable_activity' }
  | { ok: true; tenantId: string; entryDate: Date; lines: JournalLineInput[]; debits: number; credits: number; diagnostics: string }

/**
 * The journal entry a closed shift should post, without posting it. Used by
 * postShiftClose and by the one-off backfill (scripts/backfill-shift-close-
 * postings.ts), which must report what WOULD post before posting anything.
 */
export async function buildShiftCloseEntry(shiftId: string): Promise<ShiftCloseEntry> {
  const shift = await prisma.shift.findUnique({
    where: { id: shiftId },
    include: {
      payments: { include: SHIFT_SALE_PAYMENT_INCLUDE },
      cashMovements: { select: { id: true, type: true, amountCents: true } },
      // Whose drawer this was: Shift.tenantId, with the location / cashier as
      // the fallback ONLY for older rows (lib/tenantScope.ts).
      ...SHIFT_COMPANY_INCLUDE,
    },
  })
  if (!shift) return { ok: false, reason: 'shift_not_found' }
  const tenantId = shiftTenantId(shift)
  if (!tenantId) return { ok: false, reason: 'shift_has_no_company' }

  const sales = summariseShiftSales(shiftId, shift.payments)

  // Expected drawer — the one formula (lib/drawer.ts). Positive variance = over.
  const drawer       = drawerExpectationOf(shift)
  const expectedCash = drawer.expectedCents
  const actualCash   = shift.closingFloatCents ?? expectedCash
  const cashVariance = actualCash - expectedCash

  // Refunds / pay-outs that already carry their own journal entry are not
  // booked again here (see the header).
  const refundRows = shift.payments.filter((p) => p.status === 'refunded')
  const payoutRows = shift.cashMovements.filter((m) => m.type === 'payout')
  const ownPosted = new Set<string>()
  const sourceIds = [...refundRows.map((p) => p.id), ...payoutRows.map((m) => m.id)]
  if (sourceIds.length > 0) {
    const entries = await prisma.journalEntry.findMany({
      where: { tenantId, OR: sourceIds.map((id) => ({ reference: { endsWith: `:${id}` } })) },
      select: { reference: true },
    })
    for (const e of entries) {
      const id = e.reference?.slice(e.reference.lastIndexOf(':') + 1)
      if (id) ownPosted.add(id)
    }
  }
  const refundsToBook = refundRows.filter((p) => !ownPosted.has(p.id))
  const cashRefundsToBook = refundsToBook
    .filter((p) => p.method === 'cash')
    .reduce((t, p) => t + Math.abs(p.amountCents), 0)
  const cardRefundsToBook = refundsToBook
    .filter((p) => p.method !== 'cash' && p.method !== 'comp')
    .reduce((t, p) => t + Math.abs(p.amountCents), 0)
  const payoutsToBook = payoutRows
    .filter((m) => !ownPosted.has(m.id))
    .reduce((t, m) => t + m.amountCents, 0)

  const lines: JournalLineInput[] = []
  const tag = `(shift ${shiftId.slice(0, 8)})`

  // ── Debits: receipts on this drawer and contra-revenue ──────────────────
  if (sales.cashCents > 0) {
    lines.push({ accountCode: ACCT.CASH_DRAWER, type: 'debit', amountCents: sales.cashCents, memo: `POS cash sales ${tag}` })
  }
  if (sales.cardPaidCents > 0) {
    lines.push({ accountCode: ACCT.CARD_RECEIVABLE, type: 'debit', amountCents: sales.cardPaidCents, memo: `POS card sales ${tag}` })
  }
  if (sales.cardAwaitingCents > 0) {
    lines.push({ accountCode: ACCT.CARD_RECEIVABLE, type: 'debit', amountCents: sales.cardAwaitingCents, memo: `POS card sales awaiting gateway confirmation ${tag}` })
  }
  if (sales.compCents > 0) {
    lines.push({ accountCode: ACCT.COMPS, type: 'debit', amountCents: sales.compCents, memo: `POS comps ${tag}` })
  }
  if (sales.unsettledCents > 0) {
    lines.push({ accountCode: ACCT.CUSTOMER_AR, type: 'debit', amountCents: sales.unsettledCents, memo: `Till orders not settled on this drawer ${tag}` })
  }
  if (sales.settledElsewhereCents > 0) {
    lines.push({ accountCode: ACCT.CUSTOMER_AR, type: 'credit', amountCents: sales.settledElsewhereCents, memo: `Received for till orders booked on another drawer ${tag}` })
  }
  if (sales.roundingCents !== 0) {
    const amountCents = Math.abs(sales.roundingCents)
    const memo = `Tender rounding ${tag}`
    // + = received more than billed: a gain (credit 8010).
    lines.push({ accountCode: ACCT.CASH_VARIANCE, type: sales.roundingCents > 0 ? 'credit' : 'debit', amountCents, memo })
  }
  if (sales.nonTillCashCents > 0) {
    const memo = `Cash for online orders taken at the drawer — sale booked on the order ${tag}`
    lines.push({ accountCode: ACCT.CASH_DRAWER,  type: 'debit',  amountCents: sales.nonTillCashCents, memo })
    lines.push({ accountCode: ACCT.CASH_ON_HAND, type: 'credit', amountCents: sales.nonTillCashCents, memo })
  }
  // Money taken on cancelled / rejected orders (FOH-09): not revenue, not tax
  // — held as a refund due to the customer (credit 1110) until handed back.
  // One 1110 line per order, naming it in full: handing the money back (a
  // refund row on the cancelled order) clears exactly that line — Dr 1110 /
  // Cr drawer or card (orderPosting.ts postRefundPayment, LEDGER-R5).
  const cp = sales.cancelledPaid
  if (cp.cashCents + cp.cardCents > 0) {
    const memo = `${REFUND_DUE_PREFIX} — paid on cancelled order(s) ${cp.orderIds.map((id) => `#${id.slice(0, 8)}`).join(', ')}, not a sale ${tag}`.slice(0, 250)
    if (cp.cashCents > 0) lines.push({ accountCode: ACCT.CASH_DRAWER,     type: 'debit', amountCents: cp.cashCents, memo })
    if (cp.cardCents > 0) lines.push({ accountCode: ACCT.CARD_RECEIVABLE, type: 'debit', amountCents: cp.cardCents, memo })
    for (const o of cp.byOrder) {
      lines.push({ accountCode: ACCT.CUSTOMER_AR, type: 'credit', amountCents: o.cents, memo: refundDueMemo(o.orderId, tag) })
    }
  }

  // ── Cost of sales: what the till's orders took out of stock, per brand ──
  // Online orders book COGS as each completes (orderPosting.ts); till sales
  // reach the ledger only here, so this is where their COGS is booked, from
  // the same recipe explosion (lib/recipeCost.ts) at the same plate cost.
  for (const b of sales.byConcept.values()) {
    if (b.orderIds.length === 0) continue
    const soldLines = await prisma.orderItem.findMany({
      where: { orderId: { in: b.orderIds } },
      select: { menuItemId: true, quantity: true, status: true },
    })
    const cogsCents = await cogsForSoldLines(soldLines)
    if (cogsCents > 0) {
      lines.push({ accountCode: ACCT.FOOD_COST,      type: 'debit',  amountCents: cogsCents, memo: `COGS @ ${b.conceptSlug} ${tag}`, conceptId: b.conceptId })
      lines.push({ accountCode: ACCT.INVENTORY_FOOD, type: 'credit', amountCents: cogsCents, memo: `Inventory used @ ${b.conceptSlug} ${tag}`, conceptId: b.conceptId })
    }
  }

  for (const b of sales.byConcept.values()) {
    if (b.walletAppliedCents > 0) {
      lines.push({ accountCode: ACCT.WALLET_LIABILITY, type: 'debit', amountCents: b.walletAppliedCents, memo: `Wallet applied @ ${b.conceptSlug}`, conceptId: b.conceptId })
    }
    if (b.discountCents > 0) {
      lines.push({ accountCode: ACCT.DISCOUNTS, type: 'debit', amountCents: b.discountCents, memo: `Discounts @ ${b.conceptSlug}`, conceptId: b.conceptId })
    }
    // One 2080 line per order, naming it (the refund engine looks for it).
    for (const g of b.giftCards) {
      lines.push({ accountCode: GIFT_CARD_LIABILITY, type: 'debit', amountCents: g.cents, memo: giftCardSaleMemo(b.conceptSlug, g.orderId), conceptId: b.conceptId })
    }
  }

  // ── Drawer movements that are not sales — each a balanced pair ──────────
  if (drawer.dropsCents > 0) {
    lines.push({ accountCode: ACCT.CASH_ON_HAND, type: 'debit',  amountCents: drawer.dropsCents, memo: `Cash dropped to safe ${tag}` })
    lines.push({ accountCode: ACCT.CASH_DRAWER,  type: 'credit', amountCents: drawer.dropsCents, memo: `Cash dropped to safe ${tag}` })
  }
  const cashIn = drawer.addsCents + drawer.payinsCents
  if (cashIn > 0) {
    lines.push({ accountCode: ACCT.CASH_DRAWER,  type: 'debit',  amountCents: cashIn, memo: `Cash added / paid in to drawer ${tag}` })
    lines.push({ accountCode: ACCT.CASH_ON_HAND, type: 'credit', amountCents: cashIn, memo: `Cash added / paid in to drawer ${tag}` })
  }
  if (cashRefundsToBook > 0) {
    lines.push({ accountCode: ACCT.REFUNDS,     type: 'debit',  amountCents: cashRefundsToBook, memo: `Cash refunds from drawer ${tag}` })
    lines.push({ accountCode: ACCT.CASH_DRAWER, type: 'credit', amountCents: cashRefundsToBook, memo: `Cash refunds from drawer ${tag}` })
  }
  if (cardRefundsToBook > 0) {
    lines.push({ accountCode: ACCT.REFUNDS,         type: 'debit',  amountCents: cardRefundsToBook, memo: `Card refunds ${tag}` })
    lines.push({ accountCode: ACCT.CARD_RECEIVABLE, type: 'credit', amountCents: cardRefundsToBook, memo: `Card refunds ${tag}` })
  }
  if (payoutsToBook > 0) {
    const memo = `Drawer pay-outs, unclassified — reclassify from 8010 ${tag}`
    lines.push({ accountCode: ACCT.CASH_VARIANCE, type: 'debit',  amountCents: payoutsToBook, memo })
    lines.push({ accountCode: ACCT.CASH_DRAWER,   type: 'credit', amountCents: payoutsToBook, memo })
  }

  // Cash variance, as a BALANCED pair against the drawer. When the count is
  // short the money genuinely isn't there, so the shortfall moves off the
  // drawer and onto the variance expense; when it is over, the reverse. (A
  // one-sided variance line once made every unreconciled shift unbalanced, so
  // the whole shift never posted.)
  if (cashVariance !== 0) {
    const short = cashVariance < 0
    const amountCents = Math.abs(cashVariance)
    const memo = `Drawer ${short ? 'short' : 'over'} ${tag}`
    lines.push({ accountCode: short ? ACCT.CASH_VARIANCE : ACCT.CASH_DRAWER,   type: 'debit',  amountCents, memo })
    lines.push({ accountCode: short ? ACCT.CASH_DRAWER   : ACCT.CASH_VARIANCE, type: 'credit', amountCents, memo })
  }

  // ── Credits per brand: revenue, service charge, tips, GST output ────────
  for (const b of sales.byConcept.values()) {
    if (b.revenueCents > 0) {
      lines.push({ accountCode: revenueCodeForConcept(b.conceptSlug), type: 'credit', amountCents: b.revenueCents, memo: `Revenue @ ${b.conceptSlug}`, conceptId: b.conceptId })
    }
    if (b.serviceChargeCents > 0) {
      lines.push({ accountCode: ACCT.SERVICE_CHARGE_REVENUE, type: 'credit', amountCents: b.serviceChargeCents, memo: `Service charge @ ${b.conceptSlug}`, conceptId: b.conceptId })
    }
    if (b.tipCents > 0) {
      lines.push({ accountCode: ACCT.TIPS_PAYABLE, type: 'credit', amountCents: b.tipCents, memo: `Tips @ ${b.conceptSlug}`, conceptId: b.conceptId })
    }
    // Output tax per brand, to the brand's authority (BOOKS-10), tagged like
    // an order's own entry, so tax is measurable per brand as well as per
    // company.
    if (b.taxCents > 0) {
      lines.push({ accountCode: b.taxAccountCode, type: 'credit', amountCents: b.taxCents, memo: `Sales tax output @ ${b.conceptSlug} ${tag}`, conceptId: b.conceptId })
    }
  }

  if (lines.length < 2) return { ok: false, reason: 'no_postable_activity' }

  const debits  = lines.filter((l) => l.type === 'debit').reduce((t, l) => t + l.amountCents, 0)
  const credits = lines.filter((l) => l.type === 'credit').reduce((t, l) => t + l.amountCents, 0)
  const diagnostics =
    `cash=${sales.cashCents} card=${sales.cardPaidCents} cardAwaiting=${sales.cardAwaitingCents} comps=${sales.compCents} ` +
    `unsettled=${sales.unsettledCents} settledElsewhere=${sales.settledElsewhereCents} rounding=${sales.roundingCents} ` +
    `nonTillCash=${sales.nonTillCashCents} variance=${cashVariance} drops=${drawer.dropsCents} in=${cashIn} ` +
    `cashRefunds=${cashRefundsToBook} cardRefunds=${cardRefundsToBook} payouts=${payoutsToBook} ` +
    `tax=${sales.totals.taxCents} revenue=${sales.totals.revenueCents} svc=${sales.totals.serviceChargeCents} ` +
    `tips=${sales.totals.tipCents} discounts=${sales.totals.discountCents} wallet=${sales.totals.walletAppliedCents} ` +
    `giftCards=${sales.totals.giftCardAppliedCents} cancelledPaid=${cp.cashCents + cp.cardCents}`
  return { ok: true, tenantId, entryDate: shift.closedAt ?? new Date(), lines, debits, credits, diagnostics }
}

export interface PostShiftCloseOptions {
  /**
   * Post into the current open month instead of the shift's own close date
   * (owner decision 6 — a shift whose month is already closed). The note is
   * added to the entry's description and every line's memo.
   */
  intoCurrentMonth?: { note: string; postedBy?: string }
}

export async function postShiftClose(shiftId: string, opts: PostShiftCloseOptions = {}): Promise<{ posted: boolean; entryId: string | null; reason?: string }> {
  const entry = await buildShiftCloseEntry(shiftId)
  if (!entry.ok) return { posted: false, entryId: null, reason: entry.reason }

  // Fail loudly rather than silently. postJournalEntry rejects an unbalanced
  // entry, and the caller logs that rejection and moves on — which is how a
  // whole shift's sales went missing without anyone noticing. Check here, where
  // the shift id and the totals are in hand, so the log says which shift and by
  // how much.
  if (entry.debits !== entry.credits) {
    console.error(
      `[shiftPosting] shift ${shiftId} would post an UNBALANCED entry: debits ${entry.debits} vs credits ${entry.credits} ` +
      `(difference ${entry.debits - entry.credits}). Refusing to post — this shift's sales are NOT in the ledger. ` +
      entry.diagnostics,
    )
    return { posted: false, entryId: null, reason: 'unbalanced' }
  }

  const late = opts.intoCurrentMonth
  const result = await postJournalEntry({
    tenantId: entry.tenantId,
    sourceType: 'shift.close',
    sourceId: shiftId,
    description: late
      ? `POS shift ${shiftId.slice(0, 8)} closeout — ${late.note}`
      : `POS shift ${shiftId.slice(0, 8)} closeout`,
    entryDate: late ? new Date() : entry.entryDate,
    postedBy: late?.postedBy ?? 'system',
    lines: late
      ? entry.lines.map((l) => ({ ...l, memo: `${l.memo ?? ''} [${late.note}]`.trim().slice(0, 250) }))
      : entry.lines,
  })
  return { posted: result.posted, entryId: result.entryId }
}

// ─── Backfill: closed shifts that never reached the books (decision 6) ──────
//
// Shifts closed through the old /reconciliation close were never posted, and
// a close whose entry would not balance was refused. This finds every closed
// shift of the given companies with no 'shift.close' entry and (unless dry
// run) posts it:
//   • its own close date when that month is still open;
//   • otherwise into the CURRENT open month, with a memo naming the shift's
//     original close date — a locked month is never reopened for it (owner
//     decision 6);
//   • unbalanced / company-less shifts are listed, never forced.
// Idempotent: postJournalEntry is keyed on 'shift.close:<shiftId>'.

export interface BackfillRow {
  shiftId: string
  closedAt: string | null
  tenantId: string | null
  outcome: 'posted' | 'posted_into_current_month' | 'would_post' | 'would_post_into_current_month'
    | 'unbalanced' | 'shift_has_no_company' | 'no_postable_activity' | 'shift_not_found' | 'already_posted' | 'error'
  detail: string
}

export async function backfillUnpostedShifts(opts: { tenantIds: string[]; dryRun: boolean; postedBy?: string }): Promise<{ rows: BackfillRow[]; summary: Record<string, number> }> {
  const { shiftOfCompany } = await import('../../lib/tenantScope.js')
  const { fmtPktDate } = await import('./dates.js')
  const closed = await prisma.shift.findMany({
    where: { status: 'closed', ...shiftOfCompany({ tenantId: { in: opts.tenantIds } }) },
    select: { id: true, closedAt: true },
    orderBy: { closedAt: 'asc' },
  })
  const posted = new Set(
    (await prisma.journalEntry.findMany({
      where: { tenantId: { in: opts.tenantIds }, reference: { startsWith: 'shift.close:' } },
      select: { reference: true },
    })).map((e) => e.reference!.slice('shift.close:'.length)),
  )
  const locks = new Map<string, Date | null>()
  const lockedThrough = async (tenantId: string) => {
    if (!locks.has(tenantId)) {
      const lock = await prisma.periodLock.findFirst({ where: { tenantId }, orderBy: { lockedThrough: 'desc' }, select: { lockedThrough: true } })
      locks.set(tenantId, lock?.lockedThrough ?? null)
    }
    return locks.get(tenantId) ?? null
  }

  const rows: BackfillRow[] = []
  for (const s of closed) {
    if (posted.has(s.id)) continue
    const closedAt = s.closedAt?.toISOString() ?? null
    const entry = await buildShiftCloseEntry(s.id)
    if (!entry.ok) { rows.push({ shiftId: s.id, closedAt, tenantId: null, outcome: entry.reason, detail: '' }); continue }
    // Only this call's companies — the shift→company precedence can differ
    // from the query's OR in an edge case, so check the resolved company.
    if (!opts.tenantIds.includes(entry.tenantId)) continue
    if (entry.debits !== entry.credits) {
      rows.push({ shiftId: s.id, closedAt, tenantId: entry.tenantId, outcome: 'unbalanced', detail: `debits ${entry.debits} credits ${entry.credits}; ${entry.diagnostics}` })
      continue
    }
    const lock = await lockedThrough(entry.tenantId)
    const locked = !!lock && entry.entryDate <= lock
    const note = `closed ${fmtPktDate(entry.entryDate)}, posted late into the open month (books closed through ${lock ? fmtPktDate(lock) : '—'})`
    if (opts.dryRun) {
      rows.push({ shiftId: s.id, closedAt, tenantId: entry.tenantId, outcome: locked ? 'would_post_into_current_month' : 'would_post', detail: locked ? note : entry.diagnostics })
      continue
    }
    try {
      const r = await postShiftClose(s.id, locked ? { intoCurrentMonth: { note, postedBy: opts.postedBy } } : {})
      rows.push({
        shiftId: s.id, closedAt, tenantId: entry.tenantId,
        outcome: r.posted ? (locked ? 'posted_into_current_month' : 'posted') : 'already_posted',
        detail: r.entryId ?? r.reason ?? '',
      })
    } catch (err) {
      rows.push({ shiftId: s.id, closedAt, tenantId: entry.tenantId, outcome: 'error', detail: (err as Error).message })
    }
  }
  const summary: Record<string, number> = {}
  for (const r of rows) summary[r.outcome] = (summary[r.outcome] ?? 0) + 1
  return { rows, summary }
}

/**
 * A till card / QR tender the gateway FAILED after its drawer was closed.
 * The close booked it to 1030 as awaiting confirmation (see the header); the
 * processor will never pay it, so the customer owes it: Dr 1110 / Cr 1030.
 * No-op while the drawer is still open (the close will leave a failed tender
 * out) and idempotent per payment.
 */
export async function postPosCardFailure(paymentId: string): Promise<{ posted: boolean; entryId: string | null; reason?: string }> {
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    select: {
      id: true, method: true, status: true, amountCents: true, gatewayRef: true, shiftId: true,
      order: { select: { id: true, source: true, conceptId: true, concept: { select: { slug: true } } } },
      shift: { select: { id: true, tenantId: true, locationId: true, ...SHIFT_COMPANY_INCLUDE } },
    },
  })
  if (!payment) return { posted: false, entryId: null, reason: 'payment_not_found' }
  if (payment.status !== 'failed' || !GATEWAY_METHODS.has(payment.method) || !payment.gatewayRef) {
    return { posted: false, entryId: null, reason: 'not_a_failed_till_card' }
  }
  if (!payment.shift || payment.order?.source !== 'pos') return { posted: false, entryId: null, reason: 'not_a_till_payment' }
  const tenantId = shiftTenantId(payment.shift)
  if (!tenantId) return { posted: false, entryId: null, reason: 'shift_has_no_company' }
  const closePosted = await prisma.journalEntry.findFirst({
    where: { tenantId, reference: `shift.close:${payment.shift.id}` },
    select: { id: true },
  })
  if (!closePosted) return { posted: false, entryId: null, reason: 'shift_not_posted' }

  const memo = `Card ${payment.gatewayRef} failed after close — owed by the customer (order #${payment.order.id.slice(0, 8)})`
  const result = await postJournalEntry({
    tenantId,
    sourceType: 'pos.card_failed',
    sourceId: payment.id,
    description: `Till card payment failed after shift ${payment.shift.id.slice(0, 8)} closed`,
    postedBy: 'system',
    lines: [
      { accountCode: ACCT.CUSTOMER_AR,     type: 'debit',  amountCents: payment.amountCents, memo, conceptId: payment.order.conceptId },
      { accountCode: ACCT.CARD_RECEIVABLE, type: 'credit', amountCents: payment.amountCents, memo, conceptId: payment.order.conceptId },
    ],
  })
  return { posted: result.posted, entryId: result.entryId }
}
