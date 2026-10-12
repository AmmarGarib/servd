// Order → journal posting.
//
// Every completed order posts ONE journal entry capturing: payment receipts,
// gross revenue (per concept), GST output, contra-revenue (discounts/promos),
// wallet/loyalty liability movements, and COGS / inventory derecognition.
//
// Posting is idempotent on (sourceType, sourceId) — see journal.ts. Replays
// from concurrent KDS bumps, retried webhooks, or worker reruns are no-ops.

import type { Order, OrderItem, Payment, Concept, Prisma, PrismaClient } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { ACCT, postJournalEntry, revenueCodeForConcept, type JournalLineInput } from './journal.js'
import { cogsForSoldLines } from '../../lib/recipeCost.js'
import { postLoyaltyReversal } from './loyaltyPosting.js'
import { restoreOrderWallet } from '../wallet/service.js'

/** Gift Card Liability — credited when a card is sold (giftCards/routes.ts). */
export const GIFT_CARD_LIABILITY = '2080'

// ─── Output tax: which authority the sale's tax is owed to (BOOKS-10) ───────
//
// Restaurant services are taxed by the PROVINCE the kitchen is in, not by FBR:
// a Karachi brand's 15% cash / 8% card tax is Sindh sales tax on services,
// payable to the Sindh Revenue Board (2032). Every sale, refund and shift
// close used to credit 2030 "GST Output (Payable to FBR)" whatever the brand's
// province, so the SRB line of the return was always zero. The brand's
// Concept.province decides the account; a brand registered with SRB (srbPosId)
// but with no province set is a Sindh kitchen. Islamabad (ICT) services tax is
// collected by FBR, and a brand with no province stays on 2030 — the return
// flags it (salesTaxReturn.ts).
const OUTPUT_TAX_BY_PROVINCE: Record<string, string> = {
  SD: ACCT.SRB_TAX_OUTPUT,   // 2032 Sindh Revenue Board
  PB: ACCT.PRA_TAX_OUTPUT,   // 2031 Punjab Revenue Authority
  KP: ACCT.KPRA_TAX_OUTPUT,  // 2033 KP Revenue Authority
  BL: ACCT.BRA_TAX_OUTPUT,   // 2034 Balochistan Revenue Authority
}

export interface TaxJurisdiction { province?: string | null; srbPosId?: number | null }

/**
 * The output-tax account a brand's sales tax is credited to today. A refund
 * debits the account its SALE credited while that account still holds the
 * brand's tax (refundTaxAccountFor, below) — the brand's authority at the
 * time of the refund only when the sale's account has been reclassed away.
 */
export function outputTaxCodeFor(concept: TaxJurisdiction | null | undefined): string {
  const province = concept?.province?.trim().toUpperCase() || null
  if (province) return OUTPUT_TAX_BY_PROVINCE[province] ?? ACCT.GST_OUTPUT
  if (concept?.srbPosId != null) return ACCT.SRB_TAX_OUTPUT
  return ACCT.GST_OUTPUT
}

/** Every output sales-tax account: FBR 2030 and the four provincial ones. */
export const OUTPUT_TAX_ACCOUNTS: readonly string[] = [
  ACCT.GST_OUTPUT, ACCT.PRA_TAX_OUTPUT, ACCT.SRB_TAX_OUTPUT, ACCT.KPRA_TAX_OUTPUT, ACCT.BRA_TAX_OUTPUT,
]

/**
 * Memo prefix of the 1110 credit a shift close books for money taken on a
 * cancelled / rejected order (FOH-09). One line per order, naming the FULL
 * order id — the refund engine looks for it (refundDueMemo / saleBookingOf).
 */
export const REFUND_DUE_PREFIX = 'REFUND DUE'
export function refundDueMemo(orderId: string, tag: string): string {
  return `${REFUND_DUE_PREFIX} — paid on cancelled order ${orderId}, not a sale ${tag}`
}

// ─── Receipts and the drawer that books a till order ────────────────────────
// (Here rather than in shiftPosting.ts so the refund engine below can use them
// without a circular import; shiftPosting re-exports both.)

/** Tenders settled through a card processor (they carry the terminal's reference). */
export const GATEWAY_METHODS: ReadonlySet<string> = new Set(['card', 'keenu_qr'])

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
export function homeShiftOf(order: { payments: Array<{ id: string; shiftId: string | null; method: string; status: string; gatewayRef: string | null; createdAt: Date }> }): string | null {
  const receipts = order.payments
    .filter((p) => p.shiftId && isShiftReceipt(p))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
  return receipts[0]?.shiftId ?? null
}

/**
 * LEDGER-R5 — money taken AT THE TILL on a cancelled / rejected order that is
 * still owed back to the customer: its drawer receipts (isShiftReceipt with a
 * shift, comps excluded — a comp is not money) less the refunds already
 * handed back on it. 0 for any other status. This is what the refund engine
 * may refund on a cancelled ticket (postRefundPayment books it Dr 1110 refund
 * due / Cr drawer or card, never revenue and tax), and what a cancel must not
 * leave stranded: the shift close holds it in 1110 until it is handed back.
 * (Money an online gateway took is not here — it never reached a drawer, and
 * goes back through the gateway's own refund.)
 */
export function refundDueCents(order: {
  status: string
  payments: Array<{ method: string; status: string; amountCents: number; gatewayRef: string | null; shiftId: string | null }>
}): number {
  if (order.status !== 'cancelled' && order.status !== 'rejected') return 0
  const taken = order.payments
    .filter((p) => p.amountCents > 0 && !!p.shiftId && p.method !== 'comp' && isShiftReceipt(p))
    .reduce((t, p) => t + p.amountCents, 0)
  const handedBack = order.payments
    .filter((p) => p.status === 'refunded' && p.amountCents < 0)
    .reduce((t, p) => t + Math.abs(p.amountCents), 0)
  return Math.max(0, taken - handedBack)
}

// ─── Tips taken on a tender (FOH-14) ────────────────────────────────────────
//
// The till records a tip on the order (Order.tipCents, and on its total) AND
// on the tender that carried it (Payment.gatewayMeta.tipCents). The order is
// the source of truth; a tip found only on the tenders (a path that did not
// raise the order) is added to the order's tip and charged total here, so it
// is credited to 2095 Tips Payable rather than read as an overpayment.

/** The tip a payment row carries, if any. */
export function paymentTipCents(p: { tipCents?: unknown; gatewayMeta?: unknown }): number {
  if (typeof p.tipCents === 'number' && p.tipCents > 0) return Math.round(p.tipCents)
  const meta = p.gatewayMeta
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
    const t = (meta as Record<string, unknown>)['tipCents']
    if (typeof t === 'number' && Number.isFinite(t) && t > 0) return Math.round(t)
  }
  return 0
}

/**
 * The order's sale fields with any tender-only tip folded in. `receipts` are
 * the order's money-in rows (refund rows are ignored). A no-op when the order
 * already carries at least the tenders' tips — the normal till path.
 */
export function withTenderTips<T extends SaleOrderFields>(
  order: T,
  receipts: Array<{ status: string; amountCents: number; tipCents?: unknown; gatewayMeta?: unknown }>,
): T {
  const onTenders = receipts
    .filter((p) => p.status !== 'refunded' && p.status !== 'failed' && p.amountCents > 0)
    .reduce((t, p) => t + paymentTipCents(p), 0)
  const extra = onTenders - (order.tipCents ?? 0)
  if (extra <= 0) return order
  return { ...order, tipCents: (order.tipCents ?? 0) + extra, totalCents: order.totalCents + extra }
}

interface OrderForPosting extends Order {
  concept:  Concept
  payments: Payment[]
  items: OrderItem[]
  giftCardRedemptions: Array<{ id: string; amountCents: number; reversedAt: Date | null }>
}

async function loadOrderForPosting(orderId: string): Promise<OrderForPosting | null> {
  return prisma.order.findUnique({
    where: { id: orderId },
    include: {
      concept: true, payments: true, items: true,
      giftCardRedemptions: { select: { id: true, amountCents: true, reversedAt: true } },
    },
  })
}

/**
 * What gift cards paid of an order's bill (ONL-05). The redeem engine
 * (giftCards/service.ts) lowers Order.totalCents by each redemption, so the
 * sale formula adds it back as a debit to 2080. Every redemption counts — a
 * refund re-credits the card only after the sale, and books that separately
 * ('order.refund_giftcard', below).
 */
export function giftCardAppliedOf(redemptions: Array<{ amountCents: number }> | null | undefined): number {
  return (redemptions ?? []).reduce((t, r) => t + Math.max(0, r.amountCents), 0)
}

// Theoretical food cost for the order: THE plate cost (lib/recipeCost.ts —
// the same number the recipe and menu-engineering screens price against, and
// the same explosion that took the stock out at sale) × quantity, over the
// non-voided items. That means each recipe's own Q factor (default 10%, not
// the old fixed 5%), applied once — the old copy applied it again on top of
// sub-recipe lines — sub-recipes costed at any depth, and no kitchen labour
// (owner decision 26). Items without a recipe contribute 0: their cost is
// recognised when their inventory is counted or wasted, not at sale time.
function computeOrderCogsCents(order: OrderForPosting): Promise<number> {
  return cogsForSoldLines(order.items)
}

export interface SaleAccounting {
  // Customer-facing money flow (charged to a payment instrument)
  totalChargedCents:   number   // hits cash drawer / card receivable
  walletAppliedCents:  number   // dr wallet liability
  giftCardAppliedCents: number  // dr 2080 gift card liability (ONL-05)
  // (Loyalty redemption is currently captured as discountCents — kept here in
  //  case we split the field later; default 0.)
  loyaltyRedeemedCents: number

  // Pricing breakdown
  taxCents:        number       // cr output tax (2030 FBR / 2032 SRB … — outputTaxCodeFor)
  discountCents:   number       // dr contra-revenue (discounts + promo)
  grossRevenueCents: number     // cr revenue (subtotal before discount, ex-tax)
  serviceChargeCents: number    // cr 4100 service charge revenue
  tipCents:        number       // cr 2095 tips payable to staff
}

/** The order columns the sale formula reads. */
export type SaleOrderFields = Pick<
  Order,
  'totalCents' | 'walletAmountCents' | 'taxCents' | 'discountCents' | 'promoDiscountCents' | 'serviceChargeCents' | 'tipCents'
> & {
  /**
   * What gift cards paid (giftCardAppliedOf). Not an Order column: the redeem
   * engine LOWERS totalCents by it, so without it the formula computed revenue
   * from the post-card total — revenue short by the card, 2080 never cleared.
   */
  giftCardAppliedCents?: number
}

/**
 * THE sale-to-ledger formula — one order's split into charged money, wallet,
 * gift card, discount, GST, service charge, tip and item revenue. Used per
 * order by the order-completion posting (online / non-till orders) AND,
 * summed per brand, by the POS shift close (shiftPosting.ts). The shift close
 * used to carry its own inline copy that never split out the service charge,
 * so POS service charge was credited to the brand's food revenue while every
 * other order credited 4100.
 *
 * By construction it balances: charged + wallet + gift card + loyalty + discount
 *   = revenue + tax + service charge + tip.
 */
export function computeSaleAccounting(order: SaleOrderFields): SaleAccounting {
  const totalChargedCents   = order.totalCents
  const walletAppliedCents  = order.walletAmountCents
  const giftCardAppliedCents = Math.max(0, order.giftCardAppliedCents ?? 0)
  const loyaltyRedeemedCents = 0
  const taxCents            = order.taxCents
  const discountCents        = order.discountCents + order.promoDiscountCents
  const serviceChargeCents  = order.serviceChargeCents ?? 0
  const tipCents            = order.tipCents ?? 0

  // Items-side gross subtotal (excludes service charge + tip, both modelled
  // separately so they hit dedicated accounts). Computed from the PRE-card
  // total: the card paid part of the bill, it did not discount it.
  // gross_subtotal = charged + wallet + gift card + loyalty + discount − tax − svc − tip
  const grossRevenueCents =
    totalChargedCents +
    walletAppliedCents +
    giftCardAppliedCents +
    loyaltyRedeemedCents +
    discountCents -
    taxCents -
    serviceChargeCents -
    tipCents

  return {
    totalChargedCents,
    walletAppliedCents,
    giftCardAppliedCents,
    loyaltyRedeemedCents,
    taxCents,
    discountCents,
    grossRevenueCents,
    serviceChargeCents,
    tipCents,
  }
}

/** The memo on a sale's 2080 debit. It names the full order id: the refund engine looks for it. */
export function giftCardSaleMemo(slug: string, orderId: string): string {
  return `Gift card redeemed on ${slug} order ${orderId}`
}

function buildSaleLines(order: OrderForPosting, sa: SaleAccounting, cogsCents: number): JournalLineInput[] {
  const lines: JournalLineInput[] = []
  const conceptMemo = `${order.concept.slug} #${order.id.slice(0, 8)}`

  // ── Debits: where the money / value moved TO ───────────────────────────
  if (sa.totalChargedCents > 0) {
    // Determine if cash or card from the payment record(s). A storefront
    // cash-on-delivery row is still 'pending' when the rider hands the food
    // over — the cash is with the rider, not with a card processor — so it is
    // cash on hand (1010), and moves to the drawer (Dr 1015 / Cr 1010, on the
    // shift close) when the rider pays it into a till (owner decision 4). It
    // used to fall through to 1030 card receivable, so every COD sale sat in
    // the books as money owed by a card processor that never owed it.
    const isCashReceipt = (p: Payment) =>
      p.method === 'cash' && (p.status === 'paid' || (order.source !== 'pos' && p.status === 'pending'))
    const cashPayments = order.payments.filter(isCashReceipt)
    const cashTotal = Math.min(sa.totalChargedCents, cashPayments.reduce((s, p) => s + p.amountCents, 0))
    const cardTotal = sa.totalChargedCents - cashTotal

    if (cashTotal > 0) {
      const cashAccount = order.source === 'pos' ? ACCT.CASH_DRAWER : ACCT.CASH_ON_HAND
      lines.push({ accountCode: cashAccount, type: 'debit', amountCents: cashTotal, memo: conceptMemo })
    }
    if (cardTotal > 0) {
      lines.push({ accountCode: ACCT.CARD_RECEIVABLE, type: 'debit', amountCents: cardTotal, memo: conceptMemo })
    }
  }

  if (sa.walletAppliedCents > 0) {
    lines.push({ accountCode: ACCT.WALLET_LIABILITY, type: 'debit', amountCents: sa.walletAppliedCents, memo: `Wallet applied to ${conceptMemo}` })
  }
  if (sa.giftCardAppliedCents > 0) {
    // The card's balance was a liability since it was sold (Cr 2080 at
    // issue); spending it on this meal discharges that liability into the
    // sale's revenue and tax.
    lines.push({ accountCode: GIFT_CARD_LIABILITY, type: 'debit', amountCents: sa.giftCardAppliedCents, memo: giftCardSaleMemo(order.concept.slug, order.id) })
  }
  if (sa.loyaltyRedeemedCents > 0) {
    lines.push({ accountCode: ACCT.LOYALTY_LIABILITY, type: 'debit', amountCents: sa.loyaltyRedeemedCents, memo: `Loyalty redeemed on ${conceptMemo}` })
  }
  if (sa.discountCents > 0) {
    lines.push({ accountCode: ACCT.DISCOUNTS, type: 'debit', amountCents: sa.discountCents, memo: `Discount on ${conceptMemo}` })
  }

  // ── Credits: revenue + tax + service charge + tip ──────────────────────
  if (sa.grossRevenueCents > 0) {
    lines.push({
      accountCode: revenueCodeForConcept(order.concept.slug),
      type: 'credit',
      amountCents: sa.grossRevenueCents,
      memo: conceptMemo,
    })
  }
  if (sa.serviceChargeCents > 0) {
    lines.push({ accountCode: ACCT.SERVICE_CHARGE_REVENUE, type: 'credit', amountCents: sa.serviceChargeCents, memo: `Service charge on ${conceptMemo}` })
  }
  if (sa.tipCents > 0) {
    lines.push({ accountCode: ACCT.TIPS_PAYABLE, type: 'credit', amountCents: sa.tipCents, memo: `Tip received on ${conceptMemo}` })
  }
  if (sa.taxCents > 0) {
    lines.push({ accountCode: outputTaxCodeFor(order.concept), type: 'credit', amountCents: sa.taxCents, memo: `Sales tax output on ${conceptMemo}` })
  }

  // ── COGS leg (separate balanced pair appended to the same entry) ───────
  if (cogsCents > 0) {
    lines.push({ accountCode: ACCT.FOOD_COST,      type: 'debit',  amountCents: cogsCents, memo: `COGS for ${conceptMemo}` })
    lines.push({ accountCode: ACCT.INVENTORY_FOOD, type: 'credit', amountCents: cogsCents, memo: `Inventory derecognised for ${conceptMemo}` })
  }

  // Every line on this entry belongs to a single order → tag with its brand so
  // per-brand revenue AND cost are measured (not estimated) in the brand P&L.
  return lines.map((l) => ({ ...l, conceptId: order.conceptId }))
}

export interface PostOrderResult {
  posted: boolean
  entryId: string | null
  reason?: string
}

export async function postOrderCompletion(orderId: string): Promise<PostOrderResult> {
  const order = await loadOrderForPosting(orderId)
  if (!order) return { posted: false, entryId: null, reason: 'order_not_found' }

  const giftCardAppliedCents = giftCardAppliedOf(order.giftCardRedemptions)

  // POS orders close out via the shift close (shiftPosting.ts), booked by the
  // drawer holding their earliest receipt — don't post them twice. The one
  // exception is a till bill a gift card paid in full: it has no receipt on
  // any drawer, so no shift close would ever book it, and it is posted here.
  if (order.source === 'pos') {
    const hasReceipt = order.payments.some((p) => !!p.shiftId && isShiftReceipt(p))
    if (hasReceipt || giftCardAppliedCents <= 0) return { posted: false, entryId: null, reason: 'pos_skipped' }
  }

  if (order.totalCents <= 0 && order.walletAmountCents <= 0 && giftCardAppliedCents <= 0) {
    return { posted: false, entryId: null, reason: 'zero_value_order' }
  }

  const sa = computeSaleAccounting(withTenderTips({ ...order, giftCardAppliedCents }, order.payments))
  const cogsCents = await computeOrderCogsCents(order)
  const lines = buildSaleLines(order, sa, cogsCents)

  // The order's brand decides whose books this lands in.
  const tenantId = order.concept.tenantId
  if (!tenantId) return { posted: false, entryId: null, reason: 'concept_has_no_company' }

  const result = await postJournalEntry({
    tenantId,
    sourceType: 'order.complete',
    sourceId: order.id,
    description: `Order ${order.id.slice(0, 8)} completed (${order.concept.slug} / ${order.source})`,
    entryDate: order.completedAt ?? new Date(),
    postedBy: 'system',
    lines,
  })

  return { posted: result.posted, entryId: result.entryId }
}

// ─── Refunds ────────────────────────────────────────────────────────────────
//
// ONE refund engine: refundOrder() in pos/service.ts. Every refund is a
// negative 'refunded' Payment row on the drawer the money left from, and each
// such row posts its OWN journal entry here ('order.refund', keyed on the
// refund payment id) — for every channel, till or online:
//
//   Dr brand revenue (4xxx)   the refund's ex-tax share of the item revenue
//   Dr 4100 service charge    its share of the service charge
//   Dr 2095 tips payable      its share of the tip
//   Dr output tax             its share of the tax — the brand's authority
//                             (2032 SRB for a Sindh kitchen, else 2030; see
//                             outputTaxCodeFor), the account the sale credited
//   Cr 1015 drawer            cash handed back at a till (the drawer it left)
//      1010 cash on hand      cash handed back with no drawer
//      1030 card receivable   card / QR reversed through the processor
//
// Shares are pro rata on the order's full value (charged + wallet + gift
// card) and are CUMULATIVE — each refund takes round(X·(prior+this)/V) −
// round(X·prior/V) — so the tender refunds, then the wallet restore, then the
// gift-card restore add up to exactly the order's GST, service charge and tip,
// with no rounding paisa left behind.
//
// Why a per-refund entry rather than reversing the completion entry: till
// sales never post 'order.complete' (they are booked by the shift close), so
// the reversal found nothing and no till refund ever reached the books; and a
// refunded meal was still cooked and eaten, so its COGS must stay booked —
// reversing the whole completion entry put the food back into 1210 while the
// stock stayed consumed. The shift close skips any refund row that has its
// own entry (shiftPosting.ts), so nothing is booked twice.

export interface RefundShare {
  revenueCents: number
  serviceChargeCents: number
  tipCents: number
  taxCents: number
}

/**
 * The split of one refund of `thisCents`, given `priorCents` already refunded
 * on the same order (tender refunds first, then the wallet restore). Pure.
 * revenue + serviceCharge + tip + tax === thisCents, always.
 */
export function refundShareOf(order: SaleOrderFields, priorCents: number, thisCents: number): RefundShare {
  const value = order.totalCents + (order.walletAmountCents ?? 0) + Math.max(0, order.giftCardAppliedCents ?? 0)
  if (value <= 0 || thisCents <= 0) return { revenueCents: Math.max(0, thisCents), serviceChargeCents: 0, tipCents: 0, taxCents: 0 }
  const upTo = Math.min(value, priorCents + thisCents)
  const from = Math.min(value, priorCents)
  const share = (x: number) => Math.round((x * upTo) / value) - Math.round((x * from) / value)
  const taxCents           = share(order.taxCents ?? 0)
  const serviceChargeCents = share(order.serviceChargeCents ?? 0)
  const tipCents           = share(order.tipCents ?? 0)
  return { revenueCents: thisCents - taxCents - serviceChargeCents - tipCents, serviceChargeCents, tipCents, taxCents }
}

/**
 * The debit side of a refund of `amountCents`, tagged with the brand. The tax
 * share is debited to `taxAccountCode` — the account the sale credited
 * (refundTaxAccountFor); omitted, the brand's authority today.
 */
export function refundDebitLines(
  order: SaleOrderFields & { conceptId: string; concept: { slug: string } & TaxJurisdiction; id: string },
  priorCents: number,
  amountCents: number,
  memo: string,
  taxAccountCode?: string,
): JournalLineInput[] {
  const sh = refundShareOf(order, priorCents, amountCents)
  const lines: JournalLineInput[] = []
  if (sh.revenueCents !== 0) {
    // A refund can never be mostly tax, but guard the sign anyway: a negative
    // revenue share would be a credit.
    lines.push({ accountCode: revenueCodeForConcept(order.concept.slug), type: sh.revenueCents > 0 ? 'debit' : 'credit', amountCents: Math.abs(sh.revenueCents), memo })
  }
  if (sh.serviceChargeCents > 0) lines.push({ accountCode: ACCT.SERVICE_CHARGE_REVENUE, type: 'debit', amountCents: sh.serviceChargeCents, memo: `Service charge — ${memo}` })
  if (sh.tipCents > 0)           lines.push({ accountCode: ACCT.TIPS_PAYABLE,           type: 'debit', amountCents: sh.tipCents,           memo: `Tip — ${memo}` })
  if (sh.taxCents > 0)           lines.push({ accountCode: taxAccountCode ?? outputTaxCodeFor(order.concept), type: 'debit', amountCents: sh.taxCents, memo: `Sales tax output — ${memo}` })
  return lines.map((l) => ({ ...l, conceptId: order.conceptId }))
}

// ─── How an order's sale was booked ─────────────────────────────────────────
//
// A refund mirrors the sale it undoes, so it reads the sale's own entry rather
// than re-deriving it from today's rules:
//   • LEDGER-R1 — a sale booked before ONL-05 took revenue from the post-card
//     total and had no 2080 line. Its refunds must be priced on that same
//     basis (no gift card in the order's value), or a full refund reverses
//     only part of the revenue and tax and leaves output tax payable.
//   • LEDGER-R2 — the tax share is debited to the account the sale credited
//     (2030 for a pre-routing Sindh sale), not the brand's authority today —
//     until that account no longer holds the brand's tax (the one-off reclass
//     Dr 2030 / Cr 2032, tagged with the brand, has moved it), after which
//     the authority's account carries it.
//   • LEDGER-R5 — money taken on a cancelled ticket that a shift close held as
//     a refund due (Cr 1110) is handed back against 1110, not revenue.

export interface SaleBooking {
  /** The sale is on the books: the order's 'order.complete' or its home drawer's 'shift.close' (not as a refund due). */
  booked: boolean
  /** Booked without a 2080 debit naming the order although gift cards paid part of it (before ONL-05). */
  legacyGiftCard: boolean
  /** The output-tax account the sale credited for the order's brand, if any. */
  saleTaxAccount: string | null
  /** A shift close held money taken on the (cancelled) order as a refund due: Cr 1110 naming the order. */
  refundDue: boolean
}

type Db = typeof prisma
type BookingOrder = {
  id: string
  conceptId: string
  source: string
  payments: Parameters<typeof homeShiftOf>[0]['payments']
  giftCardRedemptions: Array<{ amountCents: number }>
}

export async function saleBookingOf(db: Db, tenantId: string, order: BookingOrder): Promise<SaleBooking> {
  const completeRef = `order.complete:${order.id}`
  const refs = [completeRef]
  const home = order.source === 'pos' ? homeShiftOf(order) : null
  if (home) refs.push(`shift.close:${home}`)
  const [entries, dueLine] = await Promise.all([
    db.journalEntry.findMany({ where: { tenantId, reference: { in: refs } }, select: { id: true, reference: true } }),
    db.journalLine.findFirst({
      where: {
        type: 'credit',
        account: { tenantId, code: ACCT.CUSTOMER_AR },
        journalEntry: { tenantId, reference: { startsWith: 'shift.close:' } },
        AND: [{ memo: { startsWith: REFUND_DUE_PREFIX } }, { memo: { contains: order.id } }],
      },
      select: { id: true },
    }),
  ])
  const refundDue = !!dueLine
  const booked = !refundDue && entries.length > 0
  if (!booked) return { booked: false, legacyGiftCard: false, saleTaxAccount: null, refundDue }

  // The tax the sale credited for this brand. An order's own entry is all
  // this order; a shift close carries one tax line per brand.
  const taxLine = await db.journalLine.findFirst({
    where: {
      journalEntryId: { in: entries.map((e) => e.id) },
      type: 'credit',
      conceptId: order.conceptId,
      account: { tenantId, code: { in: [...OUTPUT_TAX_ACCOUNTS] } },
    },
    select: { account: { select: { code: true } } },
  })

  // A 2080 debit naming the order, ANYWHERE in the company's books: the sale's
  // own line, or a backfill journal for a pre-ONL-05 sale whose memo names the
  // order (giftCardSaleMemo) — either way the card's liability was discharged.
  let legacyGiftCard = false
  if (giftCardAppliedOf(order.giftCardRedemptions) > 0) {
    const cardLine = await db.journalLine.findFirst({
      where: { type: 'debit', account: { tenantId, code: GIFT_CARD_LIABILITY }, journalEntry: { tenantId }, memo: { contains: order.id } },
      select: { id: true },
    })
    legacyGiftCard = !cardLine
  }
  return { booked, legacyGiftCard, saleTaxAccount: taxLine?.account.code ?? null, refundDue }
}

/**
 * The output-tax account a refund's tax share is debited to (LEDGER-R2): the
 * account the sale credited, while the brand's net balance there still covers
 * the share; otherwise (not booked yet, booked to today's account, or the
 * balance reclassed away) the brand's authority today.
 */
export async function refundTaxAccountFor(
  db: Db,
  tenantId: string,
  order: { conceptId: string; concept: TaxJurisdiction },
  saleTaxAccount: string | null,
  taxShareCents: number,
): Promise<string> {
  const current = outputTaxCodeFor(order.concept)
  if (!saleTaxAccount || saleTaxAccount === current || taxShareCents <= 0) return current
  const sums = await db.journalLine.groupBy({
    by: ['type'],
    _sum: { amountCents: true },
    where: { conceptId: order.conceptId, account: { tenantId, code: saleTaxAccount }, journalEntry: { tenantId } },
  })
  const credit = sums.find((s) => s.type === 'credit')?._sum.amountCents ?? 0
  const debit  = sums.find((s) => s.type === 'debit')?._sum.amountCents ?? 0
  return credit - debit >= taxShareCents ? saleTaxAccount : current
}

/** The order as a refund should value it: without its gift cards when the sale was booked without them. */
function asBooked<T extends SaleOrderFields>(order: T, giftCardAppliedCents: number, booking: SaleBooking | null): T {
  return { ...order, giftCardAppliedCents: booking?.legacyGiftCard ? 0 : giftCardAppliedCents }
}

/** The account a refund's money leaves from. */
export function refundCreditAccount(p: { method: string; shiftId: string | null }): string {
  if (p.method === 'cash') return p.shiftId ? ACCT.CASH_DRAWER : ACCT.CASH_ON_HAND
  return ACCT.CARD_RECEIVABLE
}

type Tx = Prisma.TransactionClient | PrismaClient

/**
 * Post the journal entry for ONE refund payment row. Idempotent on the refund
 * payment id. Throws JOURNAL_UNBALANCED rather than posting a lopsided entry.
 */
export async function postRefundPayment(refundPaymentId: string, options: { tx?: Tx; postedBy?: string } = {}): Promise<PostOrderResult> {
  const db = (options.tx ?? prisma) as typeof prisma
  const payment = await db.payment.findUnique({
    where: { id: refundPaymentId },
    select: {
      id: true, orderId: true, method: true, status: true, amountCents: true, shiftId: true, processedAt: true, createdAt: true,
      order: {
        select: {
          id: true, status: true, conceptId: true, source: true, totalCents: true, walletAmountCents: true, taxCents: true,
          discountCents: true, promoDiscountCents: true, serviceChargeCents: true, tipCents: true,
          concept: { select: { slug: true, tenantId: true, province: true, srbPosId: true } },
          payments: { select: { id: true, shiftId: true, method: true, status: true, amountCents: true, gatewayRef: true, createdAt: true } },
          giftCardRedemptions: { select: { amountCents: true } },
        },
      },
    },
  })
  if (!payment) return { posted: false, entryId: null, reason: 'payment_not_found' }
  if (payment.status !== 'refunded' || payment.amountCents >= 0) return { posted: false, entryId: null, reason: 'not_a_refund' }
  const tenantId = payment.order.concept.tenantId
  if (!tenantId) return { posted: false, entryId: null, reason: 'concept_has_no_company' }

  // How the sale was booked decides how its refund is split (LEDGER-R1, R2, R5).
  const booking = await saleBookingOf(db, tenantId, payment.order)
  const order = asBooked(payment.order, giftCardAppliedOf(payment.order.giftCardRedemptions), booking)

  const amount = Math.abs(payment.amountCents)
  const memo = `Refund on ${order.concept.slug} #${order.id.slice(0, 8)}`
  const creditLine = { accountCode: refundCreditAccount(payment), type: 'credit' as const, amountCents: amount, memo, conceptId: order.conceptId }

  // LEDGER-R5: money taken on a cancelled / rejected ticket was never a sale.
  // The shift close holds it as a refund due (Cr 1110); handing it back clears
  // that, not revenue and tax. The same when its drawer has not closed yet —
  // that close will hold it as a refund due. A cancelled order whose sale WAS
  // booked (cancelled after its drawer closed) is refunded like any sale.
  if (order.status === 'cancelled' || order.status === 'rejected') {
    const onDrawer = order.payments.some((p) => p.shiftId && p.amountCents > 0 && isShiftReceipt(p))
    if (booking.refundDue || (!booking.booked && onDrawer)) {
      const dueMemo = `Refund due handed back — cancelled order ${order.id}`
      const result = await postJournalEntry({
        tenantId,
        sourceType: 'order.refund',
        sourceId: payment.id,
        description: `Money taken on cancelled order ${order.id.slice(0, 8)} handed back (${order.concept.slug}, ${payment.method}) — not a sale`,
        entryDate: payment.processedAt ?? new Date(),
        postedBy: options.postedBy ?? 'system',
        lines: [
          { accountCode: ACCT.CUSTOMER_AR, type: 'debit', amountCents: amount, memo: dueMemo, conceptId: order.conceptId },
          { ...creditLine, memo: dueMemo },
        ],
      }, { tx: options.tx })
      return { posted: result.posted, entryId: result.entryId }
    }
    if (!booking.booked) return { posted: false, entryId: null, reason: 'receipt_never_booked' }
  }

  const before = (r: { id: string; createdAt: Date }) =>
    r.createdAt.getTime() < payment.createdAt.getTime() ||
    (r.createdAt.getTime() === payment.createdAt.getTime() && r.id < payment.id)
  const prior = order.payments
    .filter((r) => r.status === 'refunded' && r.id !== payment.id && before(r))
    .reduce((t, r) => t + Math.abs(r.amountCents), 0)

  const share = refundShareOf(order, prior, amount)
  const taxAccount = await refundTaxAccountFor(db, tenantId, order, booking.saleTaxAccount, share.taxCents)
  const lines = [...refundDebitLines(order, prior, amount, memo, taxAccount), creditLine]
  const result = await postJournalEntry({
    tenantId,
    sourceType: 'order.refund',
    sourceId: payment.id,
    description: `Refund of PKR ${(amount / 100).toFixed(0)} on order ${order.id.slice(0, 8)} (${order.concept.slug} / ${order.source}, ${payment.method})`,
    entryDate: payment.processedAt ?? new Date(),
    postedBy: options.postedBy ?? 'system',
    lines,
  }, { tx: options.tx })
  return { posted: result.posted, entryId: result.entryId }
}

// The customer-side restores when an order ends without its sale standing —
// status 'refunded' (written only by the refund engine, once the order is
// refunded in full) or a cancellation (cancelled, rejected, auto-cancelled):
//   1. Loyalty EARN — every LoyaltyTransaction{orderId, type='earn'} is paired
//      with a 'reversal' transaction that subtracts the same points (balance
//      and lifetimePoints), and the accrual the earn booked (Dr 6060 / Cr
//      2060) is reversed in the same company: 'loyalty.earn.reversal', keyed
//      on the earn (BOOKS-08 / ONL-06 / FOH-17 — the points came off the
//      balance while 2060 and 6060 kept them).
//   2. Loyalty REDEEM — points the customer SPENT on the order are given back
//      (a positive 'reversal' row), and the discharge the redemption booked
//      (Dr 2060 / Cr 7020) is reversed: 'loyalty.redeem.reversal', keyed on
//      the redeem (ONL-07 — every cancel, reject, auto-cancel and refund
//      used to keep the customer's points).
//   3. Wallet credit applied to the order — Order.walletAmountCents is added
//      back to the customer's wallet AT THE ORDER'S COMPANY (ONL-R2-01) with a
//      'refund' WalletTransaction. On a
//      REFUND the sale had debited 2050 for it, so the restore books the
//      wallet's share back: Dr revenue / tax shares, Cr 2050 ('order.
//      refund_wallet', keyed on the order). A cancelled order never booked a
//      sale, so its restore needs no entry.
//   4. Gift card balance redeemed against the order — every GiftCardRedemption
//      adds its amountCents back to the GiftCard.balanceCents (and re-activates
//      the card if it was 'redeemed_full'). On a REFUND the sale had debited
//      2080 for it (ONL-05), so the restore books the card's share back: Dr
//      revenue / tax shares, Cr 2080 ('order.refund_giftcard', keyed on the
//      redemption). A cancelled order never booked a sale: no entry.
// Each points / card / wallet move is claimed (reversedAt; the wallet's
// 'refund' WalletTransaction) and booked in ONE database transaction with its
// journal entry, so either both happen or neither does
// (a failed posting releases the claim and a re-run can try again), and a
// replay finds the claim taken and does nothing.
//
// The money handed back at the till or through the processor is NOT here —
// it is the refund payment rows, each posted by postRefundPayment. A
// cancelled order never completed (the state machine only cancels before
// completion), and a refund is booked per refund. Inventory is not restored
// on a refund — the food was made and eaten, and its COGS stays booked.
export async function postOrderRefund(
  orderId: string,
  reason: string,
  opts: { bookWalletRestore?: boolean } = {},
): Promise<PostOrderResult[]> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      status: true,
      source: true,
      customerId: true,
      conceptId: true,
      totalCents: true, walletAmountCents: true, taxCents: true, discountCents: true,
      promoDiscountCents: true, serviceChargeCents: true, tipCents: true,
      concept: { select: { slug: true, tenantId: true, province: true, srbPosId: true } },
      payments: { select: { id: true, shiftId: true, method: true, status: true, amountCents: true, gatewayRef: true, createdAt: true } },
      loyaltyTxs: {
        where: { type: { in: ['earn', 'redeem'] } },
        orderBy: { createdAt: 'asc' },
        select: { id: true, type: true, loyaltyAccountId: true, pointsDelta: true },
      },
      giftCardRedemptions: { orderBy: { redeemedAt: 'asc' }, select: { id: true, giftCardId: true, amountCents: true } },
    },
  })
  if (!order) return [{ posted: false, entryId: null, reason: 'order_not_found' }]
  const results: PostOrderResult[] = []
  const tenantId = order.concept.tenantId
  const id8 = order.id.slice(0, 8)
  // Only a refunded order was sold — its sale is (or will be) on the books, so
  // the wallet and gift-card restores book their share of it back.
  const sold = opts.bookWalletRestore ?? order.status === 'refunded'
  // How the sale was booked (LEDGER-R1 / R2): read once, used by the wallet
  // and gift-card restores. The refund shares are pro rata on the order's
  // FULL value, gift cards included — unless the sale was booked before the
  // 2080 debit existed (ONL-05), whose value was the post-card total.
  const booking = sold && tenantId ? await saleBookingOf(prisma, tenantId, order) : null
  const valued = asBooked(order, giftCardAppliedOf(order.giftCardRedemptions), booking)
  const restoreLines = async (priorCents: number, amountCents: number, memo: string) => {
    const share = refundShareOf(valued, priorCents, amountCents)
    const taxAccount = await refundTaxAccountFor(prisma, tenantId!, valued, booking?.saleTaxAccount ?? null, share.taxCents)
    return refundDebitLines(valued, priorCents, amountCents, memo, taxAccount)
  }
  const tenderRefundedCents = order.payments
    .filter((p) => p.status === 'refunded')
    .reduce((t, p) => t + Math.abs(p.amountCents), 0)
  const fail = (what: string, err: unknown) => {
    const msg = (err as Error).message
    console.error(`[refund] ${what} for order ${orderId} failed — nothing moved, re-run to retry:`, msg)
    results.push({ posted: false, entryId: null, reason: msg })
  }

  // 1) Loyalty earn reversal — per earn row (the review bonus carries the same
  //    orderId as the completion earn, so the claim is on the ROW, not the order).
  for (const earn of order.loyaltyTxs) {
    if (earn.type !== 'earn' || earn.pointsDelta <= 0) continue
    try {
      const r = await prisma.$transaction(async (tx) => {
        const claimed = await tx.loyaltyTransaction.updateMany({
          where: { id: earn.id, reversedAt: null },
          data: { reversedAt: new Date() },
        })
        if (claimed.count === 0) return null   // already clawed back
        await tx.loyaltyAccount.update({
          where: { id: earn.loyaltyAccountId },
          data: {
            pointsBalance: { decrement: earn.pointsDelta },
            lifetimePoints: { decrement: earn.pointsDelta },
          },
        })
        await tx.loyaltyTransaction.create({
          data: {
            loyaltyAccountId: earn.loyaltyAccountId,
            orderId: order.id,
            type: 'reversal',
            pointsDelta: -earn.pointsDelta,
            description: `Reversed earn — ${reason}`,
          },
        })
        return postLoyaltyReversal(earn.id, { tx, reason })
      })
      if (r) results.push(r)
    } catch (err) {
      fail(`loyalty earn reversal ${earn.id}`, err)
    }
  }

  // 2) Loyalty redeem restore — the points the customer spent come back.
  for (const redeem of order.loyaltyTxs) {
    if (redeem.type !== 'redeem' || redeem.pointsDelta >= 0) continue
    const points = -redeem.pointsDelta
    try {
      const r = await prisma.$transaction(async (tx) => {
        const claimed = await tx.loyaltyTransaction.updateMany({
          where: { id: redeem.id, reversedAt: null },
          data: { reversedAt: new Date() },
        })
        if (claimed.count === 0) return null   // already given back
        await tx.loyaltyAccount.update({
          where: { id: redeem.loyaltyAccountId },
          data: { pointsBalance: { increment: points } },
        })
        await tx.loyaltyTransaction.create({
          data: {
            loyaltyAccountId: redeem.loyaltyAccountId,
            orderId: order.id,
            type: 'reversal',
            pointsDelta: points,
            description: `Restored ${points} pts redeemed on order #${id8} — ${reason}`,
          },
        })
        return postLoyaltyReversal(redeem.id, { tx, reason })
      })
      if (r) results.push(r)
    } catch (err) {
      fail(`loyalty redeem restore ${redeem.id}`, err)
    }
  }

  // 3) Wallet credit restore — to the wallet of the ORDER's company (ONL-R2-01:
  //    the wallet is per company; this used to credit the one servd-wide
  //    Customer.walletBalance, so a refund at company B became value spendable
  //    at company A). Idempotent on (orderId, type='refund'), checked under the
  //    order's row lock (wallet/service restoreOrderWallet). On a REFUND the
  //    Cr 2050 entry is posted inside the restore's transaction (W-RV-02):
  //    the credit and its entry happen together or not at all, and a failure
  //    is a result here, so postRefundOrFlag flags it and a re-run retries
  //    both. (It used to be logged only, while the entry posted anyway — 2050
  //    owed value no wallet held.)
  if (order.customerId && order.walletAmountCents > 0) {
    try {
      const booked: { result: PostOrderResult | null } = { result: null }
      let book: ((tx: Tx, amountCents: number) => Promise<void>) | undefined
      if (sold && tenantId) {
        const memo = `Wallet restored on refund of ${order.concept.slug} #${id8}`
        const debitLines = await restoreLines(tenderRefundedCents, order.walletAmountCents, memo)
        book = async (tx, amountCents) => {
          if (amountCents !== order.walletAmountCents) {
            throw new Error(`WALLET_SHARE_CHANGED: order ${orderId}'s wallet share changed while it was being restored — re-run`)
          }
          const r = await postJournalEntry({
            tenantId,
            sourceType: 'order.refund_wallet',
            sourceId: order.id,
            description: `Wallet credit restored — order ${id8} refunded`,
            postedBy: 'system',
            lines: [
              ...debitLines,
              { accountCode: ACCT.WALLET_LIABILITY, type: 'credit', amountCents, memo, conceptId: order.conceptId },
            ],
          }, { tx })
          booked.result = { posted: r.posted, entryId: r.entryId }
        }
      }
      await restoreOrderWallet(orderId, reason, { book })
      if (booked.result) results.push(booked.result)
    } catch (err) {
      fail('wallet restore', err)
    }
  }

  // 4) Gift card restore — atomic per redemption, idempotent on
  //    GiftCardRedemption.reversedAt, claimed before the balance moves. (The
  //    old code incremented unconditionally, so every write of status
  //    'refunded' put the money back on the card again.)
  //
  //    A sale booked before the 2080 debit existed (ONL-05) never cleared the
  //    card's liability, so crediting 2080 again on its refund would double
  //    it: such a sale's restore moves the card balance and books nothing.
  const legacyCardSale = !!booking?.legacyGiftCard
  // The card slices come after the tender refunds and the wallet restore.
  let prior = tenderRefundedCents + (sold && order.walletAmountCents > 0 ? order.walletAmountCents : 0)
  for (const r of order.giftCardRedemptions) {
    const from = prior
    prior += Math.max(0, r.amountCents)
    try {
      const out = await prisma.$transaction(async (tx) => {
        const claimed = await tx.giftCardRedemption.updateMany({
          where: { id: r.id, reversedAt: null },
          data: { reversedAt: new Date() },
        })
        if (claimed.count === 0) return null   // already reversed
        await tx.giftCard.update({
          where: { id: r.giftCardId },
          data: { balanceCents: { increment: r.amountCents }, status: 'active' },
        })
        if (!sold || !tenantId || r.amountCents <= 0) return null
        if (legacyCardSale) {
          console.warn(`[refund] gift card ${r.giftCardId} re-credited on order ${orderId}; its sale predates the 2080 debit, so no restore entry is booked`)
          return { posted: false, entryId: null, reason: 'sale_booked_without_gift_card' }
        }
        const memo = `Gift card re-credited on refund of ${order.concept.slug} #${id8}`
        const res = await postJournalEntry({
          tenantId,
          sourceType: 'order.refund_giftcard',
          sourceId: r.id,
          description: `Gift card balance restored — order ${id8} refunded`,
          postedBy: 'system',
          lines: [
            ...(await restoreLines(from, r.amountCents, memo)),
            { accountCode: GIFT_CARD_LIABILITY, type: 'credit', amountCents: r.amountCents, memo, conceptId: order.conceptId },
          ],
        }, { tx })
        return { posted: res.posted, entryId: res.entryId }
      })
      if (out) results.push(out)
    } catch (err) {
      fail(`gift card restore ${r.giftCardId}`, err)
    }
  }

  return results
}

// Single-item void on the KDS: derecognise the item's contribution. For now
// we do NOT post a partial-reversal (would require recomputing taxes/discounts
// on a per-item basis); the operator should issue a full refund + re-ring the
// remaining items. This is a known iteration-1 limitation.
export async function noteItemVoid(_itemId: string): Promise<void> {
  // intentionally no-op — see comment above
}
