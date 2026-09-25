// POS shift close → journal posting.
//
// Per-order JE posting is skipped for `source = pos` (orderPosting.ts) — POS
// sales close out at shift end. One journal entry per shift, keyed on shiftId
// for idempotency.
//
// THE SALE SIDE uses the one sale-to-ledger formula, computeSaleAccounting
// (orderPosting.ts), applied to every till order the shift books and summed
// per brand: item revenue to the brand's 4xxx, service charge to 4100, tips to
// 2095, GST to 2030, discounts to 7010, wallet to 2050. This shift close used
// to carry its own inline copy, which credited POS service charge to food
// revenue, and which balanced only when an order's payments on the drawer
// equalled its total to the paisa — a card still awaiting the gateway, a
// split across drawers or a rounding paisa made the entry unbalanced, and the
// WHOLE shift was then refused by postJournalEntry and never reached the books.
//
// Which orders a shift books, and how the money side is debited:
//   • A till order (source 'pos') is booked ONCE, by its home shift: the
//     drawer that holds its earliest receipt. Receipts on this drawer are
//     debited — cash 1015, card / QR 1030, comp 7030. A card / QR tender taken
//     at the till but not yet confirmed by the gateway is a receivable from
//     the processor from the moment of sale, so it is debited to 1030 too
//     (memo'd "awaiting gateway confirmation"); nothing needs posting when
//     the gateway later confirms it, and postPosCardFailure moves it to 1110
//     if the gateway fails it after the close.
//   • Whatever of the order was NOT received on its home drawer (a split
//     still open, a failed card, a part paid on another drawer) is debited to
//     1110 Customer receivable; a receipt for that order on another drawer
//     credits 1110 back. A difference within the till's 2-paisa tender
//     tolerance is rounding, to 8010.
//   • An online / non-till order paid at the drawer is already booked by its
//     own order.complete entry, so the shift books only the cash moving into
//     the drawer (Dr 1015 / Cr 1010) — it used to book that sale a second time.
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
// Interim lines, until their own postings exist (see the owner questions on
// the refund and pay-out duplicates):
//   • refunds are booked here, gross, to 7040 — without the GST share. A
//     refund payment that already has its own journal entry (reference
//     `<type>:<paymentId>`) is skipped, so a refund-time posting added later
//     cannot double-book it. A refund attached to a drawer that is already
//     closed is not booked by anyone yet — whose cash pays it is the open
//     owner question.
//   • pay-outs keep today's account (8010) on their own line, memo'd for the
//     accountant to reclassify; a pay-out with its own entry is skipped too.

import { prisma } from '../../lib/prisma.js'
import { ACCT, postJournalEntry, revenueCodeForConcept, type JournalLineInput } from './journal.js'
import { computeSaleAccounting, type SaleOrderFields } from './orderPosting.js'
import { drawerExpectationOf } from '../../lib/drawer.js'
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
}

export interface ShiftSaleOrder extends SaleOrderFields {
  id: string
  source: string
  conceptId: string
  concept: { id: string; slug: string }
  /** Every payment of the order, on any drawer. */
  payments: ShiftOrderPaymentRow[]
}

export interface ShiftPaymentRow extends ShiftOrderPaymentRow {
  orderId: string
  order: ShiftSaleOrder | null
}

/** The select that loads what summariseShiftSales needs for a shift's payments. */
export const SHIFT_SALE_PAYMENT_INCLUDE = {
  order: {
    select: {
      id: true, source: true, conceptId: true,
      totalCents: true, walletAmountCents: true, taxCents: true, discountCents: true,
      promoDiscountCents: true, serviceChargeCents: true, tipCents: true,
      concept: { select: { id: true, slug: true } },
      payments: { select: { id: true, shiftId: true, method: true, status: true, amountCents: true, gatewayRef: true, createdAt: true } },
    },
  },
} as const

const GATEWAY_METHODS = new Set(['card', 'keenu_qr'])

/**
 * Is this payment money received (or receivable from a processor)? Paid, or a
 * card / QR tender the till took (it carries the terminal's reference) that
 * the gateway has not confirmed yet. Refund rows, failed tenders and open
 * check-split portions (pending, no reference) are not.
 */
export function isShiftReceipt(p: { method: string; status: string; gatewayRef: string | null }): boolean {
  if (p.status === 'paid') return true
  return p.status === 'pending' && GATEWAY_METHODS.has(p.method) && !!p.gatewayRef
}

/** The drawer that books a till order: the one holding its earliest receipt. */
export function homeShiftOf(order: { payments: ShiftOrderPaymentRow[] }): string | null {
  const receipts = order.payments
    .filter((p) => p.shiftId && isShiftReceipt(p))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
  return receipts[0]?.shiftId ?? null
}

export interface ShiftBrandSales {
  conceptId: string
  conceptSlug: string
  orders: number
  revenueCents: number
  serviceChargeCents: number
  tipCents: number
  taxCents: number
  discountCents: number
  walletAppliedCents: number
}

export interface ShiftSales {
  byConcept: Map<string, ShiftBrandSales>
  totals: Omit<ShiftBrandSales, 'conceptId' | 'conceptSlug'>
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
}

/**
 * The shift's sales, from its payment rows — pure. The ledger post and the
 * Z-report both read these totals, so the Z-report's tax, discount and tips
 * are the figures the shift actually booked.
 */
export function summariseShiftSales(shiftId: string, payments: ShiftPaymentRow[]): ShiftSales {
  const out: ShiftSales = {
    byConcept: new Map(),
    totals: { orders: 0, revenueCents: 0, serviceChargeCents: 0, tipCents: 0, taxCents: 0, discountCents: 0, walletAppliedCents: 0 },
    cashCents: 0, cardPaidCents: 0, cardAwaitingCents: 0, compCents: 0,
    unsettledCents: 0, settledElsewhereCents: 0, roundingCents: 0, nonTillCashCents: 0,
  }

  const orders = new Map<string, ShiftSaleOrder>()
  for (const p of payments) if (p.order && !orders.has(p.order.id)) orders.set(p.order.id, p.order)

  for (const order of orders.values()) {
    const here = order.payments.filter((p) => p.shiftId === shiftId && isShiftReceipt(p))
    if (here.length === 0) continue

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

    const sa = computeSaleAccounting(order)
    const brand = out.byConcept.get(order.conceptId) ?? {
      conceptId: order.conceptId, conceptSlug: order.concept.slug, orders: 0,
      revenueCents: 0, serviceChargeCents: 0, tipCents: 0, taxCents: 0, discountCents: 0, walletAppliedCents: 0,
    }
    brand.orders             += 1
    brand.revenueCents       += sa.grossRevenueCents
    brand.serviceChargeCents += sa.serviceChargeCents
    brand.tipCents           += sa.tipCents
    brand.taxCents           += sa.taxCents
    brand.discountCents      += sa.discountCents
    brand.walletAppliedCents += sa.walletAppliedCents
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

  for (const b of sales.byConcept.values()) {
    if (b.walletAppliedCents > 0) {
      lines.push({ accountCode: ACCT.WALLET_LIABILITY, type: 'debit', amountCents: b.walletAppliedCents, memo: `Wallet applied @ ${b.conceptSlug}`, conceptId: b.conceptId })
    }
    if (b.discountCents > 0) {
      lines.push({ accountCode: ACCT.DISCOUNTS, type: 'debit', amountCents: b.discountCents, memo: `Discounts @ ${b.conceptSlug}`, conceptId: b.conceptId })
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
    // GST per brand, tagged like an order's own entry, so tax is measurable
    // per brand as well as per company.
    if (b.taxCents > 0) {
      lines.push({ accountCode: ACCT.GST_OUTPUT, type: 'credit', amountCents: b.taxCents, memo: `GST output @ ${b.conceptSlug} ${tag}`, conceptId: b.conceptId })
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
    `tips=${sales.totals.tipCents} discounts=${sales.totals.discountCents} wallet=${sales.totals.walletAppliedCents}`
  return { ok: true, tenantId, entryDate: shift.closedAt ?? new Date(), lines, debits, credits, diagnostics }
}

export async function postShiftClose(shiftId: string): Promise<{ posted: boolean; entryId: string | null; reason?: string }> {
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

  const result = await postJournalEntry({
    tenantId: entry.tenantId,
    sourceType: 'shift.close',
    sourceId: shiftId,
    description: `POS shift ${shiftId.slice(0, 8)} closeout`,
    entryDate: entry.entryDate,
    postedBy: 'system',
    lines: entry.lines,
  })
  return { posted: result.posted, entryId: result.entryId }
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
