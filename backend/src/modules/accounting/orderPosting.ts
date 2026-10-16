// Order → journal posting.
//
// Every completed order posts ONE journal entry capturing: payment receipts,
// gross revenue (per concept), the delivery fee (4110 Delivery Fee Income —
// finance wave B, H9), output tax (food GST + the fee's GST, to the brand's
// authority — taxAuthorities.ts), contra-revenue (discounts/promos),
// wallet/loyalty liability movements, and cost of sales by class from the FIFO
// lots the order relieved (accounting/cogs.ts cogsLinesForOrders — food
// 5010/1210, drinks 5020/1220, packaging 5030/1230; a pre-cut-over order books
// its old plate cost to 5010/1210 memo'd 'pre-FIFO order').
//
// The delivery fee is charged ON TOP of the food and carries sales tax at the
// order's tender rate (H9): Order.deliveryFeeCents (ex-tax) is credited to
// 4110, tagged with the brand, and its GST (Order.deliveryFeeTaxCents) is
// already inside Order.taxCents, so the one output-tax credit carries both. An
// order placed before the fee had its own column (deliveryFeeCents 0) books
// exactly as before: its fee stays inside brand revenue.
//
// Posting is idempotent on (sourceType, sourceId) — see journal.ts. Replays
// from concurrent KDS bumps, retried webhooks, or worker reruns are no-ops.

import type { Order, Payment, Concept, Prisma, PrismaClient } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { ACCT, ON_ACCOUNT_MEMO, TILL_CLEARING_CODES, postJournalEntry, revenueCodeForConcept, withLateNote, type JournalLineInput, type RepostOptions } from './journal.js'
import { tillClearingCodeTx } from './tillClearingCode.js'
import { salesPostingDate } from '../nightAudit/lock.js'
import { cogsLinesForOrders } from './cogs.js'
import { postLoyaltyReversal } from './loyaltyPosting.js'
import { restoreOrderWallet } from '../wallet/service.js'
import { orderRefOf } from '../../lib/orderRef.js'
import { sumCents } from '../../lib/money.js'
import { AppError } from '../../lib/errors.js'
import { outputTaxCodeFor, OUTPUT_TAX_ACCOUNTS, type TaxJurisdiction } from './taxAuthorities.js'

// ─── Output tax: which authority the sale's tax is owed to (BOOKS-10) ───────
//
// Restaurant services are taxed by the PROVINCE the kitchen is in, not by FBR.
// THE table (province → authority → output / input account) is
// accounting/taxAuthorities.ts; these names are re-exported so every importer
// of this file keeps working. Never keep a second province map here.
export { OUTPUT_TAX_BY_PROVINCE, OUTPUT_TAX_ACCOUNTS, outputTaxCodeFor, type TaxJurisdiction } from './taxAuthorities.js'

/** Gift Card Liability — credited when a card is sold (giftCards/routes.ts). */
export const GIFT_CARD_LIABILITY = '2080'

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

/**
 * Tenders settled through a card processor (they carry the terminal's
 * reference): a pending row of one may still be confirmed by the processor.
 * NOT Raast QR (2026-10-12): a Raast transfer lands straight in the
 * company's bank and is recorded 'paid' at the till (reference typed on the
 * counter device, or the bank SMS) or not at all — no processor ever
 * confirms it, so a pending Raast row (an open check-split portion) is not a
 * receipt. The retired Keenu QR stays here for its old rows.
 */
export const GATEWAY_METHODS: ReadonlySet<string> = new Set(['card', 'keenu_qr'])

// ─── Raast QR: the receiving bank's own chart code (2026-10-12) ────────────
//
// A Raast payment is money in the company's BANK account, not money a card
// processor owes: the ledger debits the receiving account's chart code
// (BankAccount.accountCode, snapshotted on the RaastReceipt as ledgerCode
// when the tender was recorded), and a Raast refund credits that code
// (gatewayMeta.raast.ledgerCode on the refund row, from the receipt it went
// back against). Never 1030. A Raast row whose code is not on record is
// refused (RAAST_ACCOUNT_UNKNOWN) — the posting fails loudly and is flagged
// posting_failed, it is never booked to a guessed account.

/**
 * Memo prefix of every line that books Raast money on a receiving bank's code
 * from a sale-side posting (the shift close's per-bank totals, a non-till
 * order's receipt, a cancelled ticket's refund due) and of finance's Raast
 * write-offs. Bank reconciliation never pairs a statement line with a journal
 * line whose memo starts with it: a Raast credit is matched to its
 * RaastReceipt (one transfer, one bill), never to an aggregate.
 */
export const RAAST_RECEIPTS_MEMO = 'RAAST RECEIPTS'

/** What the ledger reads a Raast row's bank code from. */
export interface RaastCodeSource {
  id?: string
  method: string
  /** A Raast REFUND row carries { raast: { receiptId, bankAccountId, ledgerCode } }. */
  gatewayMeta?: unknown
  /** A Raast RECEIPT row's RaastReceipt (Payment.raastReceipt) — its ledgerCode snapshot. */
  raastReceipt?: { ledgerCode?: string | null } | null
}

/** The receiving bank's chart code of a Raast row, or null when none is on record. */
export function raastLedgerCodeOrNull(p: RaastCodeSource): string | null {
  const snapshot = p.raastReceipt?.ledgerCode?.trim()
  if (snapshot) return snapshot
  const meta = p.gatewayMeta
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
    const raast = (meta as Record<string, unknown>)['raast']
    if (raast && typeof raast === 'object' && !Array.isArray(raast)) {
      const code = (raast as Record<string, unknown>)['ledgerCode']
      if (typeof code === 'string' && code.trim()) return code.trim()
    }
  }
  return null
}

/** The refusal for a Raast row with no bank code on record. */
export function raastAccountUnknown(paymentIds: string[]): AppError {
  const ids = paymentIds.filter(Boolean)
  return new AppError(
    'RAAST_ACCOUNT_UNKNOWN',
    `Raast QR payment${ids.length === 1 ? '' : 's'}${ids.length ? ` ${ids.join(', ')}` : ''} ha${ids.length === 1 ? 's' : 've'} no receiving bank account on record, ` +
    'so the ledger does not know which bank it went to. Nothing was booked (never to 1030) — check the Raast receipt in Finance → Reconciliation → Raast.',
    422,
    { paymentIds: ids },
  )
}

/**
 * The bank code a Raast row books to: the receipt's ledgerCode snapshot
 * (a sale), else gatewayMeta.raast.ledgerCode (a refund row) — else 422
 * RAAST_ACCOUNT_UNKNOWN. Never 1030.
 */
export function raastLedgerCodeOf(p: RaastCodeSource): string {
  const code = raastLedgerCodeOrNull(p)
  if (code) return code
  throw raastAccountUnknown(p.id ? [p.id] : [])
}

/**
 * Is this payment money received (or receivable from a processor)? Paid
 * (cash, card, Raast QR, comp), or a card tender the till took (it carries
 * the terminal's reference) that the gateway has not confirmed yet. Refund
 * rows, failed tenders and open check-split portions (pending, no reference
 * — a pending Raast portion included) are not.
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
 * A Raast tender whose receipt the CEO voided as never booked (RaastReceipt
 * status 'voided', reconciliation/raast.ts voidNeverBooked): no entry ever
 * held its money, so it is no refund due.
 */
export function isVoidedRaast(p: { method: string; raastReceipt?: { status?: string | null } | null }): boolean {
  return p.method === 'raast' && p.raastReceipt?.status === 'voided'
}

// ─── On-account clients (2026-10-15) ────────────────────────────────────────
//
// A named corporate client's bill (Payment.method 'on_account', status paid,
// gatewayMeta.onAccount {accountId, number, name}) is no money in a drawer: the
// sale debits 1110 Customer receivable — the client's invoiced balance, billed
// on the monthly statement — memo'd ON_ACCOUNT_MEMO, never 1030. A refund of
// it goes back to the account (Cr 1110). It is never a refund due on a
// cancelled ticket: nothing was taken to hand back.

/** The client a payment row was charged to (gatewayMeta.onAccount {accountId, number, name}). */
export function onAccountOf(p: { id: string; gatewayMeta?: unknown }): { accountId: string; number: string; name: string } {
  const meta = p.gatewayMeta
  const oa = meta && typeof meta === 'object' && !Array.isArray(meta) ? (meta as Record<string, unknown>)['onAccount'] : null
  const o = oa && typeof oa === 'object' && !Array.isArray(oa) ? oa as Record<string, unknown> : {}
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
  // A row without its client on record still debits 1110 — grouped on its own, never dropped.
  return {
    accountId: str(o['accountId']) ?? `unknown:${p.id}`,
    number: str(o['number']) ?? 'OA-?',
    name: str(o['name']) ?? 'client not on record',
  }
}

/**
 * LEDGER-R5 — money taken AT THE TILL on a cancelled / rejected order that is
 * still owed back to the customer: its drawer receipts (isShiftReceipt with a
 * shift, comps excluded — a comp is not money) less the refunds already
 * handed back on it. 0 for any other status. An on-account charge is not
 * money taken (nothing to hand back), like a comp. This is what the refund engine
 * may refund on a cancelled ticket (postRefundPayment books it Dr 1110 refund
 * due / Cr drawer, card or the Raast receiving bank, never revenue and tax),
 * and what a cancel must not
 * leave stranded: the shift close holds it in 1110 until it is handed back.
 * (Money an online gateway took is not here — it never reached a drawer, and
 * goes back through the gateway's own refund.)
 *
 * A Raast tender whose receipt the CEO VOIDED as never booked
 * (reconciliation/raast.ts voidNeverBooked — RaastReceipt.status 'voided') is
 * not money taken either: the books never held it, so nothing is owed back on
 * the ticket for it. Pass the payment's `raastReceipt` (its status) for every
 * Raast row — a row loaded without it is counted as before.
 */
export function refundDueCents(order: {
  status: string
  payments: Array<{
    method: string; status: string; amountCents: number; gatewayRef: string | null; shiftId: string | null
    raastReceipt?: { status?: string | null } | null
  }>
}): number {
  if (order.status !== 'cancelled' && order.status !== 'rejected') return 0
  const taken = order.payments
    .filter((p) => p.amountCents > 0 && !!p.shiftId && p.method !== 'comp' && p.method !== 'on_account' && !isVoidedRaast(p) && isShiftReceipt(p))
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

/** A payment as the sale posting reads it: a Raast tender carries its receipt's bank-code snapshot. */
type PostingPayment = Payment & { raastReceipt: { ledgerCode: string; status: string } | null }

interface OrderForPosting extends Order {
  concept:  Concept
  payments: PostingPayment[]
  giftCardRedemptions: Array<{ id: string; amountCents: number; reversedAt: Date | null }>
}

async function loadOrderForPosting(orderId: string): Promise<OrderForPosting | null> {
  return prisma.order.findUnique({
    where: { id: orderId },
    include: {
      concept: true,
      // A Raast tender's receipt: the receiving bank's code it is debited to.
      payments: { include: { raastReceipt: { select: { ledgerCode: true, status: true } } } },
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
  /** cr 4110 Delivery Fee Income — the fee ex-tax (H9; its GST is inside taxCents). 0 on a till sale and on a legacy delivery. */
  deliveryFeeCents: number
}

/** The order columns the sale formula reads. */
export type SaleOrderFields = Pick<
  Order,
  'totalCents' | 'walletAmountCents' | 'taxCents' | 'discountCents' | 'promoDiscountCents' | 'serviceChargeCents' | 'tipCents'
  | 'deliveryFeeCents'
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
 *   = revenue + tax + service charge + tip + delivery fee.
 *
 * The delivery fee (Order.deliveryFeeCents, ex-tax — H9) is its own revenue,
 * 4110, never the brand's food revenue; its GST is already in taxCents (the
 * order's taxCents = food GST + deliveryFeeTaxCents), so the one output-tax
 * credit carries both. A legacy delivery order (fee column 0) and every till
 * sale book exactly as before.
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
  const deliveryFeeCents    = Math.max(0, order.deliveryFeeCents ?? 0)

  // Items-side gross subtotal (excludes service charge, tip and the delivery
  // fee, each modelled separately so they hit dedicated accounts). Computed
  // from the PRE-card total: the card paid part of the bill, it did not
  // discount it.
  // gross_subtotal = charged + wallet + gift card + loyalty + discount − tax − svc − tip − fee
  const grossRevenueCents =
    totalChargedCents +
    walletAppliedCents +
    giftCardAppliedCents +
    loyaltyRedeemedCents +
    discountCents -
    taxCents -
    serviceChargeCents -
    tipCents -
    deliveryFeeCents

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
    deliveryFeeCents,
  }
}

/** The memo on a sale's 2080 debit. It names the full order id: the refund engine looks for it. */
export function giftCardSaleMemo(slug: string, orderId: string): string {
  return `Gift card redeemed on ${slug} order ${orderId}`
}

/** The memo every line of an order's completion entry is built on: '<slug> #<ref>'. */
function saleMemoOf(order: { id: string; concept: { slug: string } }): string {
  return `${order.concept.slug} #${orderRefOf(order.id)}`
}

/**
 * The completion entry's lines. `cogsLines` are the order's cost-of-sales
 * pairs by class from its lots (accounting/cogs.ts cogsLinesForOrders), each
 * already balanced and tagged with the brand.
 */
function buildSaleLines(order: OrderForPosting, sa: SaleAccounting, cogsLines: JournalLineInput[]): JournalLineInput[] {
  const lines: JournalLineInput[] = []
  const conceptMemo = saleMemoOf(order)

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
    let left = sa.totalChargedCents - cashTotal

    if (cashTotal > 0) {
      const cashAccount = order.source === 'pos' ? ACCT.CASH_DRAWER : ACCT.CASH_ON_HAND
      lines.push({ accountCode: cashAccount, type: 'debit', amountCents: cashTotal, memo: conceptMemo })
    }

    // Raast QR: a transfer straight into the company's receiving bank account
    // — debited to that bank's chart code (the receipt's snapshot), grouped
    // per code, never 1030. A paid Raast row with no code refuses the whole
    // posting (raastLedgerCodeOf throws; postCompletionOrFlag flags it).
    // Capped at what is left of the charged total, like cash.
    const raastByCode = new Map<string, number>()
    for (const p of order.payments) {
      if (p.method !== 'raast' || p.status !== 'paid' || p.amountCents <= 0) continue
      const code = raastLedgerCodeOf(p)
      raastByCode.set(code, (raastByCode.get(code) ?? 0) + p.amountCents)
    }
    for (const code of [...raastByCode.keys()].sort()) {
      const cents = Math.min(left, raastByCode.get(code)!)
      if (cents <= 0) continue
      lines.push({ accountCode: code, type: 'debit', amountCents: cents, memo: `${RAAST_RECEIPTS_MEMO} — ${conceptMemo}` })
      left -= cents
    }

    // On-account clients: the client owes it — Dr 1110, one line per client,
    // memo'd ON_ACCOUNT_MEMO (an invoiced balance, billed on the statement;
    // the till-clearing cut-over leaves it where it is). Capped at what is
    // left, like cash and Raast. Never 1030.
    const onAccountBy = new Map<string, { number: string; name: string; cents: number }>()
    for (const p of order.payments) {
      if (p.method !== 'on_account' || p.status !== 'paid' || p.amountCents <= 0) continue
      const c = onAccountOf(p)
      const cur = onAccountBy.get(c.accountId) ?? { number: c.number, name: c.name, cents: 0 }
      cur.cents += p.amountCents
      onAccountBy.set(c.accountId, cur)
    }
    for (const key of [...onAccountBy.keys()].sort()) {
      const a = onAccountBy.get(key)!
      const cents = Math.min(left, a.cents)
      if (cents <= 0) continue
      lines.push({ accountCode: ACCT.CUSTOMER_AR, type: 'debit', amountCents: cents, memo: `${ON_ACCOUNT_MEMO} — ${a.number} ${a.name} — ${conceptMemo}`.slice(0, 250) })
      left -= cents
    }

    // The rest: card / gateway money a processor owes (1030).
    if (left > 0) {
      lines.push({ accountCode: ACCT.CARD_RECEIVABLE, type: 'debit', amountCents: left, memo: conceptMemo })
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
  // The delivery fee, ex-tax (H9): its own revenue account. Its GST is in the
  // tax credit below (taxCents = food GST + fee GST).
  if (sa.deliveryFeeCents > 0) {
    lines.push({ accountCode: ACCT.DELIVERY_FEE_REVENUE, type: 'credit', amountCents: sa.deliveryFeeCents, memo: `Delivery fee on ${conceptMemo}` })
  }
  if (sa.taxCents > 0) {
    lines.push({ accountCode: outputTaxCodeFor(order.concept), type: 'credit', amountCents: sa.taxCents, memo: `Sales tax output on ${conceptMemo}` })
  }

  // ── Cost of sales: one balanced pair per class from the lots relieved ──
  lines.push(...cogsLines)

  // Every line on this entry belongs to a single order → tag with its brand so
  // per-brand revenue AND cost are measured (not estimated) in the brand P&L.
  return lines.map((l) => ({ ...l, conceptId: order.conceptId }))
}

export interface PostOrderResult {
  posted: boolean
  entryId: string | null
  reason?: string
}

/**
 * `opts` is for the backfill only (reconciliation/backfillOrders.ts): a
 * completion whose sales day the night audit locked is posted today with a
 * note naming its own date (nightAudit/lock.ts). Same key either way.
 */
export async function postOrderCompletion(orderId: string, opts: RepostOptions = {}): Promise<PostOrderResult> {
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

  // The order's brand decides whose books this lands in — resolved before any
  // line is built: the cost of sales is read from THIS company's lots.
  const tenantId = order.concept.tenantId
  if (!tenantId) return { posted: false, entryId: null, reason: 'concept_has_no_company' }

  const sa = computeSaleAccounting(withTenderTips({ ...order, giftCardAppliedCents }, order.payments))
  const cogsLines = await cogsLinesForOrders(tenantId, [order.id], { conceptId: order.conceptId, memo: saleMemoOf(order) })
  const late = withLateNote(`Order ${orderRefOf(order.id)} completed (${order.concept.slug} / ${order.source})`, buildSaleLines(order, sa, cogsLines), opts.memoNote)

  const result = await postJournalEntry({
    tenantId,
    sourceType: 'order.complete',
    sourceId: order.id,
    description: late.description,
    entryDate: opts.entryDate ?? order.completedAt ?? new Date(),
    postedBy: opts.postedBy ?? 'system',
    lines: late.lines,
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
//   Dr 4110 delivery fee      its share of the delivery fee, ex-tax (H9)
//   Dr output tax             its share of the tax — the brand's authority
//                             (2032 SRB for a Sindh kitchen, else 2030; see
//                             outputTaxCodeFor), the account the sale credited
//   Cr 1015 drawer            cash handed back at a till (the drawer it left)
//      1010 cash on hand      cash handed back with no drawer
//      1030 card receivable   card (and the retired Keenu QR) reversed
//                             through the processor
//      the receiving bank     a Raast QR refund: sent back from the bank the
//                             money came into (gatewayMeta.raast.ledgerCode
//                             on the refund row) — never 1030
//
// Shares are pro rata on the order's full value (charged + wallet + gift
// card) and are CUMULATIVE — each refund takes round(X·(prior+this)/V) −
// round(X·prior/V) — so the tender refunds, then the wallet restore, then the
// gift-card restore add up to exactly the order's GST, service charge and tip,
// with no rounding paisa left behind. The one exception is a line voided on a
// paid, still-open order (TILL-R3): its refund books the exact split the void
// took off the bill (voidSplitOf — no fee, no tip, the line's own GST), and
// every other refund values the order net of it (netOfVoidRefunds).
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
  /** The refund's share of the delivery fee, ex-tax (Dr 4110 — H9). 0 when the order carries no fee. */
  deliveryFeeCents: number
}

/**
 * The split of one refund of `thisCents`, given `priorCents` already refunded
 * on the same order (tender refunds first, then the wallet restore). Pure.
 * revenue + serviceCharge + tip + tax + deliveryFee === thisCents, always.
 */
export function refundShareOf(order: SaleOrderFields, priorCents: number, thisCents: number): RefundShare {
  const value = order.totalCents + (order.walletAmountCents ?? 0) + Math.max(0, order.giftCardAppliedCents ?? 0)
  if (value <= 0 || thisCents <= 0) return { revenueCents: Math.max(0, thisCents), serviceChargeCents: 0, tipCents: 0, taxCents: 0, deliveryFeeCents: 0 }
  const upTo = Math.min(value, priorCents + thisCents)
  const from = Math.min(value, priorCents)
  const share = (x: number) => Math.round((x * upTo) / value) - Math.round((x * from) / value)
  const taxCents           = share(order.taxCents ?? 0)
  const serviceChargeCents = share(order.serviceChargeCents ?? 0)
  const tipCents           = share(order.tipCents ?? 0)
  const deliveryFeeCents   = share(Math.max(0, order.deliveryFeeCents ?? 0))
  return { revenueCents: thisCents - taxCents - serviceChargeCents - tipCents - deliveryFeeCents, serviceChargeCents, tipCents, taxCents, deliveryFeeCents }
}

// ─── A line voided on a paid, still-open order (TILL-R3) ────────────────────
//
// pos/service voidOrderItem gives the line's value back as a refund row
// without lowering the bill. What it gave back is EXACTLY what voidBillDeltaTx
// took off: the line's value net of its discount, its own GST and service
// charge — never a share of the delivery fee or the tip (the fee prices into
// both sides of the void, so neither it nor its GST ever comes off with a
// dish), and never GST on a zero-rated line. The pro-rata rule below got both
// wrong: a void on a delivery order took a share of the fee out of 4110 and
// left it in food revenue, and a zero-rated line's refund reclaimed GST it
// never carried. So the refund row stores that exact split
// (gatewayMeta.refund.split), its own entry books it, and every OTHER refund
// on the order values the order net of those voids (netOfVoidRefunds) — so a
// later full refund still nets 4110, the brand's revenue and the output tax
// to zero. A void refund written before the split was stored has none: it
// keeps the pro-rata rule it was booked with, both for its own entry and as
// `prior`, so entries already posted stay consistent.

/**
 * The exact split stored on a TILL-R3 void refund row, or null (not a void
 * refund, or one written before the split was stored, or a malformed one).
 * Revenue may be negative (a discount larger than the line); every other part
 * is a whole, non-negative paisa amount; the parts add up to the row's amount.
 */
export function voidSplitOf(p: { amountCents: number; gatewayMeta?: unknown }): RefundShare | null {
  const meta = p.gatewayMeta
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null
  const refund = (meta as { refund?: unknown }).refund as { voidedItemId?: unknown; split?: unknown } | undefined
  if (!refund || typeof refund !== 'object' || typeof refund.voidedItemId !== 'string') return null
  const s = refund.split
  if (!s || typeof s !== 'object' || Array.isArray(s)) return null
  const keys = ['revenueCents', 'serviceChargeCents', 'tipCents', 'taxCents', 'deliveryFeeCents'] as const
  const out = {} as RefundShare
  for (const k of keys) {
    const v = (s as Record<string, unknown>)[k] ?? 0
    if (typeof v !== 'number' || !Number.isInteger(v)) return null
    if (k !== 'revenueCents' && v < 0) return null
    out[k] = v
  }
  const sum = keys.reduce((t, k) => t + out[k], 0)
  return sum === Math.abs(p.amountCents) ? out : null
}

/** A refund row with an exact void split (voidSplitOf) — kept out of every other refund's `prior`. */
export function isSplitVoidRefund(p: { amountCents: number; gatewayMeta?: unknown }): boolean {
  return voidSplitOf(p) !== null
}

/**
 * The order as every refund that is NOT an exact void values it: the bill
 * less each exact void refund on it (its amount off the total, its GST, service
 * charge, tip and fee parts off theirs — the tip and fee parts are 0). Rows
 * without a split change nothing. Pure.
 */
export function netOfVoidRefunds<T extends SaleOrderFields>(
  order: T,
  refundRows: Array<{ status?: string; amountCents: number; gatewayMeta?: unknown }>,
): T {
  let total = 0, tax = 0, svc = 0, tip = 0, fee = 0
  for (const r of refundRows) {
    if (r.status !== undefined && r.status !== 'refunded') continue
    if (r.amountCents >= 0) continue
    const s = voidSplitOf(r)
    if (!s) continue
    total += Math.abs(r.amountCents)
    tax += s.taxCents
    svc += s.serviceChargeCents
    tip += s.tipCents
    fee += s.deliveryFeeCents
  }
  if (total === 0) return order
  return {
    ...order,
    totalCents: order.totalCents - total,
    taxCents: (order.taxCents ?? 0) - tax,
    serviceChargeCents: (order.serviceChargeCents ?? 0) - svc,
    tipCents: (order.tipCents ?? 0) - tip,
    deliveryFeeCents: (order.deliveryFeeCents ?? 0) - fee,
  }
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
  return shareDebitLines(order, refundShareOf(order, priorCents, amountCents), memo, taxAccountCode)
}

/** The debit lines of one refund split (refundShareOf, or a void's exact split), tagged with the brand. */
export function shareDebitLines(
  order: { conceptId: string; concept: { slug: string } & TaxJurisdiction },
  sh: RefundShare,
  memo: string,
  taxAccountCode?: string,
): JournalLineInput[] {
  const lines: JournalLineInput[] = []
  if (sh.revenueCents !== 0) {
    // A refund can never be mostly tax, but guard the sign anyway: a negative
    // revenue share would be a credit.
    lines.push({ accountCode: revenueCodeForConcept(order.concept.slug), type: sh.revenueCents > 0 ? 'debit' : 'credit', amountCents: Math.abs(sh.revenueCents), memo })
  }
  if (sh.serviceChargeCents > 0) lines.push({ accountCode: ACCT.SERVICE_CHARGE_REVENUE, type: 'debit', amountCents: sh.serviceChargeCents, memo: `Service charge — ${memo}` })
  if (sh.tipCents > 0)           lines.push({ accountCode: ACCT.TIPS_PAYABLE,           type: 'debit', amountCents: sh.tipCents,           memo: `Tip — ${memo}` })
  if (sh.deliveryFeeCents > 0)   lines.push({ accountCode: ACCT.DELIVERY_FEE_REVENUE,   type: 'debit', amountCents: sh.deliveryFeeCents,   memo: `Delivery fee — ${memo}` })
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
//     a refund due (Cr till clearing: 1110, or 1115 after the company's
//     cut-over) is handed back against till clearing, not revenue.

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
        // Till clearing: 1110 before the company's cut-over, 1115 after it.
        account: { tenantId, code: { in: TILL_CLEARING_CODES } },
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
  // The sale's own account is tried FIRST: a brand later set to a province we
  // are not registered with has no current account (outputTaxCodeFor throws),
  // yet a refund of a sale whose tax still sits where it was booked must work.
  if (saleTaxAccount && taxShareCents > 0) {
    const s = await db.journalLine.groupBy({
      by: ['type'],
      _sum: { amountCents: true },
      where: { conceptId: order.conceptId, account: { tenantId, code: saleTaxAccount }, journalEntry: { tenantId } },
    })
    const held = sumCents(s.find((x) => x.type === 'credit')?._sum.amountCents) - sumCents(s.find((x) => x.type === 'debit')?._sum.amountCents)
    if (held >= taxShareCents) return saleTaxAccount
  }
  return outputTaxCodeFor(order.concept)
}

/** The order as a refund should value it: without its gift cards when the sale was booked without them. */
function asBooked<T extends SaleOrderFields>(order: T, giftCardAppliedCents: number, booking: SaleBooking | null): T {
  return { ...order, giftCardAppliedCents: booking?.legacyGiftCard ? 0 : giftCardAppliedCents }
}

/**
 * The account a refund's money leaves from: the drawer (or cash on hand) for
 * cash; the receiving bank's code for Raast QR (raastLedgerCodeOf — 422
 * RAAST_ACCOUNT_UNKNOWN when the refund row carries none, never 1030); 1110
 * for an on-account client's bill (back to the client's account); 1030 for
 * card and the retired Keenu QR.
 */
export function refundCreditAccount(p: { id?: string; method: string; shiftId: string | null; gatewayMeta?: unknown; raastReceipt?: { ledgerCode?: string | null } | null }): string {
  if (p.method === 'cash') return p.shiftId ? ACCT.CASH_DRAWER : ACCT.CASH_ON_HAND
  if (p.method === 'raast') return raastLedgerCodeOf(p)
  if (p.method === 'on_account') return ACCT.CUSTOMER_AR
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
      // A Raast refund names the bank it was sent back from (gatewayMeta.raast.ledgerCode).
      gatewayMeta: true,
      order: {
        select: {
          id: true, status: true, conceptId: true, source: true, totalCents: true, walletAmountCents: true, taxCents: true,
          discountCents: true, promoDiscountCents: true, serviceChargeCents: true, tipCents: true, deliveryFeeCents: true,
          concept: { select: { slug: true, tenantId: true, province: true, srbPosId: true } },
          // gatewayMeta: a TILL-R3 void refund's exact split (voidSplitOf).
          payments: { select: { id: true, shiftId: true, method: true, status: true, amountCents: true, gatewayRef: true, gatewayMeta: true, createdAt: true } },
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
  // An on-account refund goes back to the client's account (Cr 1110), memo'd
  // ON_ACCOUNT_MEMO like the charge, so the till-clearing cut-over leaves it.
  const memo = `${payment.method === 'on_account' ? `${ON_ACCOUNT_MEMO} — ` : ''}Refund on ${order.concept.slug} #${orderRefOf(order.id)}`
  const creditLine = { accountCode: refundCreditAccount(payment), type: 'credit' as const, amountCents: amount, memo, conceptId: order.conceptId }
  // Night audit (sales only): a refund retried after its own sales day was
  // night-audited posts today with a note naming its date (never DAY_AUDITED).
  const placed = await salesPostingDate(db, tenantId, payment.processedAt ?? new Date())

  // LEDGER-R5: money taken on a cancelled / rejected ticket was never a sale.
  // The shift close holds it as a refund due (Cr 1110); handing it back clears
  // that, not revenue and tax — Cr the account it leaves by (refundCreditAccount:
  // a Raast hand-back is Cr the receiving bank). The same when its drawer has not closed yet —
  // that close will hold it as a refund due. A cancelled order whose sale WAS
  // booked (cancelled after its drawer closed) is refunded like any sale.
  if (order.status === 'cancelled' || order.status === 'rejected') {
    const onDrawer = order.payments.some((p) => p.shiftId && p.amountCents > 0 && p.method !== 'on_account' && isShiftReceipt(p))
    if (booking.refundDue || (!booking.booked && onDrawer)) {
      const dueMemo = `Refund due handed back — cancelled order ${order.id}`
      const handBack = withLateNote(
        `Money taken on cancelled order ${orderRefOf(order.id)} handed back (${order.concept.slug}, ${payment.method}) — not a sale`,
        [
          // Till clearing: 1110 until the company's cut-over, 1115 after it.
          { accountCode: await tillClearingCodeTx(db, tenantId), type: 'debit', amountCents: amount, memo: dueMemo, conceptId: order.conceptId },
          { ...creditLine, memo: dueMemo },
        ],
        placed.memoNote,
      )
      const result = await postJournalEntry({
        tenantId,
        sourceType: 'order.refund',
        sourceId: payment.id,
        description: handBack.description,
        entryDate: placed.entryDate,
        postedBy: options.postedBy ?? 'system',
        lines: handBack.lines,
      }, { tx: options.tx })
      return { posted: result.posted, entryId: result.entryId }
    }
    if (!booking.booked) return { posted: false, entryId: null, reason: 'receipt_never_booked' }
  }

  // A TILL-R3 void refund books exactly what the void took off the bill (no
  // fee, no tip, the line's own GST). Every other refund values the order net
  // of those voids, with them left out of `prior` (netOfVoidRefunds).
  const split = voidSplitOf(payment)
  let share: RefundShare
  if (split) {
    share = split
  } else {
    const before = (r: { id: string; createdAt: Date }) =>
      r.createdAt.getTime() < payment.createdAt.getTime() ||
      (r.createdAt.getTime() === payment.createdAt.getTime() && r.id < payment.id)
    const others = order.payments.filter((r) => r.status === 'refunded' && r.id !== payment.id)
    const prior = others
      .filter((r) => before(r) && !isSplitVoidRefund(r))
      .reduce((t, r) => t + Math.abs(r.amountCents), 0)
    share = refundShareOf(netOfVoidRefunds(order, others), prior, amount)
  }
  const taxAccount = await refundTaxAccountFor(db, tenantId, order, booking.saleTaxAccount, share.taxCents)
  const refund = withLateNote(
    `Refund of PKR ${(amount / 100).toFixed(0)} on order ${orderRefOf(order.id)} (${order.concept.slug} / ${order.source}, ${payment.method})`,
    [...shareDebitLines(order, share, memo, taxAccount), creditLine],
    placed.memoNote,
  )
  const result = await postJournalEntry({
    tenantId,
    sourceType: 'order.refund',
    sourceId: payment.id,
    description: refund.description,
    entryDate: placed.entryDate,
    postedBy: options.postedBy ?? 'system',
    lines: refund.lines,
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
      promoDiscountCents: true, serviceChargeCents: true, tipCents: true, deliveryFeeCents: true,
      concept: { select: { slug: true, tenantId: true, province: true, srbPosId: true } },
      payments: { select: { id: true, shiftId: true, method: true, status: true, amountCents: true, gatewayRef: true, gatewayMeta: true, createdAt: true } },
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
  const id8 = orderRefOf(order.id)
  // Only a refunded order was sold — its sale is (or will be) on the books, so
  // the wallet and gift-card restores book their share of it back.
  const sold = opts.bookWalletRestore ?? order.status === 'refunded'
  // How the sale was booked (LEDGER-R1 / R2): read once, used by the wallet
  // and gift-card restores. The refund shares are pro rata on the order's
  // FULL value, gift cards included — unless the sale was booked before the
  // 2080 debit existed (ONL-05), whose value was the post-card total.
  const booking = sold && tenantId ? await saleBookingOf(prisma, tenantId, order) : null
  // Valued net of any TILL-R3 void refunds (their exact split came off the
  // bill already), which are not part of the tender refunds' `prior` either —
  // as postRefundPayment values the tender refunds.
  const refundRows = order.payments.filter((p) => p.status === 'refunded')
  const valued = asBooked(netOfVoidRefunds(order, refundRows), giftCardAppliedOf(order.giftCardRedemptions), booking)
  const restoreLines = async (priorCents: number, amountCents: number, memo: string) => {
    const share = refundShareOf(valued, priorCents, amountCents)
    const taxAccount = await refundTaxAccountFor(prisma, tenantId!, valued, booking?.saleTaxAccount ?? null, share.taxCents)
    return refundDebitLines(valued, priorCents, amountCents, memo, taxAccount)
  }
  const tenderRefundedCents = refundRows
    .filter((p) => !isSplitVoidRefund(p))
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
        // The value goes back on the card under its row lock (the void and
        // the expiry sweep take the same lock — giftCards/books.ts). Only a
        // card that could still be spent (active, or emptied by spending)
        // becomes active again. A VOIDED card (fraud, refunded, payment never
        // received) or an EXPIRED one is never reopened — that used to put
        // spendable value back on a card a manager had closed. Its balance
        // takes the value (2080 owes it to the customer, as booked below) but
        // nobody can spend it: Gift cards → Books check lists a voided card
        // holding value and a manager settles it with Void (refund to cash /
        // card / bank); an expired card's refunded value waits for a manager
        // too (books check expiredHoldingValue) — breakage is taken once, at
        // the first expiry (H11), never on refunded value.
        await tx.$queryRaw`SELECT id FROM gift_cards WHERE id = ${r.giftCardId} FOR UPDATE`
        const card = await tx.giftCard.findUniqueOrThrow({ where: { id: r.giftCardId }, select: { status: true } })
        const reopen = card.status === 'active' || card.status === 'redeemed_full'
        await tx.giftCard.update({
          where: { id: r.giftCardId },
          data: { balanceCents: { increment: r.amountCents }, ...(reopen && { status: 'active' as const }) },
        })
        if (!reopen) console.warn(`[refund] gift card ${r.giftCardId} is ${card.status}: PKR ${(r.amountCents / 100).toFixed(2)} from order ${orderId} is held on it for a manager to settle`)
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
