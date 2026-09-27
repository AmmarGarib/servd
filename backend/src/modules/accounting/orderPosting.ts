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

interface OrderForPosting extends Order {
  concept:  Concept
  payments: Payment[]
  items: OrderItem[]
}

async function loadOrderForPosting(orderId: string): Promise<OrderForPosting | null> {
  return prisma.order.findUnique({
    where: { id: orderId },
    include: { concept: true, payments: true, items: true },
  })
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
  // (Loyalty redemption is currently captured as discountCents — kept here in
  //  case we split the field later; default 0.)
  loyaltyRedeemedCents: number

  // Pricing breakdown
  taxCents:        number       // cr GST output
  discountCents:   number       // dr contra-revenue (discounts + promo)
  grossRevenueCents: number     // cr revenue (subtotal before discount, ex-tax)
  serviceChargeCents: number    // cr 4100 service charge revenue
  tipCents:        number       // cr 2095 tips payable to staff
}

/** The order columns the sale formula reads. */
export type SaleOrderFields = Pick<
  Order,
  'totalCents' | 'walletAmountCents' | 'taxCents' | 'discountCents' | 'promoDiscountCents' | 'serviceChargeCents' | 'tipCents'
>

/**
 * THE sale-to-ledger formula — one order's split into charged money, wallet,
 * discount, GST, service charge, tip and item revenue. Used per order by the
 * order-completion posting (online / non-till orders) AND, summed per brand,
 * by the POS shift close (shiftPosting.ts). The shift close used to carry its
 * own inline copy that never split out the service charge, so POS service
 * charge was credited to the brand's food revenue while every other order
 * credited 4100.
 *
 * By construction it balances: charged + wallet + loyalty + discount
 *   = revenue + tax + service charge + tip.
 */
export function computeSaleAccounting(order: SaleOrderFields): SaleAccounting {
  const totalChargedCents   = order.totalCents
  const walletAppliedCents  = order.walletAmountCents
  const loyaltyRedeemedCents = 0
  const taxCents            = order.taxCents
  const discountCents        = order.discountCents + order.promoDiscountCents
  const serviceChargeCents  = order.serviceChargeCents ?? 0
  const tipCents            = order.tipCents ?? 0

  // Items-side gross subtotal (excludes service charge + tip, both modelled
  // separately so they hit dedicated accounts).
  // gross_subtotal = charged + wallet + loyalty + discount − tax − svc − tip
  const grossRevenueCents =
    totalChargedCents +
    walletAppliedCents +
    loyaltyRedeemedCents +
    discountCents -
    taxCents -
    serviceChargeCents -
    tipCents

  return {
    totalChargedCents,
    walletAppliedCents,
    loyaltyRedeemedCents,
    taxCents,
    discountCents,
    grossRevenueCents,
    serviceChargeCents,
    tipCents,
  }
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
    lines.push({ accountCode: ACCT.GST_OUTPUT, type: 'credit', amountCents: sa.taxCents, memo: `GST output on ${conceptMemo}` })
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

  // POS orders close out via shift Z-report, not per-order. Don't post twice.
  if (order.source === 'pos') return { posted: false, entryId: null, reason: 'pos_skipped' }

  if (order.totalCents <= 0 && order.walletAmountCents <= 0) {
    return { posted: false, entryId: null, reason: 'zero_value_order' }
  }

  const sa = computeSaleAccounting(order)
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
//   Dr 2030 GST output        its share of the GST
//   Cr 1015 drawer            cash handed back at a till (the drawer it left)
//      1010 cash on hand      cash handed back with no drawer
//      1030 card receivable   card / QR reversed through the processor
//
// Shares are pro rata on the order's full value (charged + wallet) and are
// CUMULATIVE — each refund takes round(X·(prior+this)/V) − round(X·prior/V) —
// so several partial refunds add up to exactly the order's GST, service
// charge and tip, with no rounding paisa left behind.
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
  const value = order.totalCents + (order.walletAmountCents ?? 0)
  if (value <= 0 || thisCents <= 0) return { revenueCents: Math.max(0, thisCents), serviceChargeCents: 0, tipCents: 0, taxCents: 0 }
  const upTo = Math.min(value, priorCents + thisCents)
  const from = Math.min(value, priorCents)
  const share = (x: number) => Math.round((x * upTo) / value) - Math.round((x * from) / value)
  const taxCents           = share(order.taxCents ?? 0)
  const serviceChargeCents = share(order.serviceChargeCents ?? 0)
  const tipCents           = share(order.tipCents ?? 0)
  return { revenueCents: thisCents - taxCents - serviceChargeCents - tipCents, serviceChargeCents, tipCents, taxCents }
}

/** The debit side of a refund of `amountCents`, tagged with the brand. */
export function refundDebitLines(
  order: SaleOrderFields & { conceptId: string; concept: { slug: string }; id: string },
  priorCents: number,
  amountCents: number,
  memo: string,
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
  if (sh.taxCents > 0)           lines.push({ accountCode: ACCT.GST_OUTPUT,             type: 'debit', amountCents: sh.taxCents,           memo: `GST output — ${memo}` })
  return lines.map((l) => ({ ...l, conceptId: order.conceptId }))
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
          id: true, conceptId: true, source: true, totalCents: true, walletAmountCents: true, taxCents: true,
          discountCents: true, promoDiscountCents: true, serviceChargeCents: true, tipCents: true,
          concept: { select: { slug: true, tenantId: true } },
          payments: { where: { status: 'refunded' }, select: { id: true, amountCents: true, createdAt: true } },
        },
      },
    },
  })
  if (!payment) return { posted: false, entryId: null, reason: 'payment_not_found' }
  if (payment.status !== 'refunded' || payment.amountCents >= 0) return { posted: false, entryId: null, reason: 'not_a_refund' }
  const order = payment.order
  const tenantId = order.concept.tenantId
  if (!tenantId) return { posted: false, entryId: null, reason: 'concept_has_no_company' }

  const amount = Math.abs(payment.amountCents)
  const before = (r: { id: string; createdAt: Date }) =>
    r.createdAt.getTime() < payment.createdAt.getTime() ||
    (r.createdAt.getTime() === payment.createdAt.getTime() && r.id < payment.id)
  const prior = order.payments.filter((r) => r.id !== payment.id && before(r)).reduce((t, r) => t + Math.abs(r.amountCents), 0)

  const memo = `Refund on ${order.concept.slug} #${order.id.slice(0, 8)}`
  const lines = [
    ...refundDebitLines(order, prior, amount, memo),
    { accountCode: refundCreditAccount(payment), type: 'credit' as const, amountCents: amount, memo, conceptId: order.conceptId },
  ]
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
// refunded in full) or a cancellation:
//   1. Loyalty earn — every LoyaltyTransaction{orderId, type='earn'} is paired
//      with a 'reversal' transaction that subtracts the same points; the
//      LoyaltyAccount balance and lifetimePoints decrement.
//   2. Wallet credit applied to the order — Order.walletAmountCents is added
//      back to Customer.walletBalance with a 'refund' WalletTransaction. On a
//      REFUND the sale had debited 2050 for it, so the restore books the
//      wallet's share back: Dr revenue / GST shares, Cr 2050 ('order.
//      refund_wallet', keyed on the order). A cancelled order never booked a
//      sale, so its restore needs no entry.
//   3. Gift card balance redeemed against the order — every GiftCardRedemption
//      adds its amountCents back to the GiftCard.balanceCents (and re-activates
//      the card if it was 'redeemed_full').
// The money handed back at the till or through the processor is NOT here —
// it is the refund payment rows, each posted by postRefundPayment. There is no
// journal REVERSAL any more: a cancelled order never completed (the state
// machine only cancels before completion), and a refund is booked per refund.
// Inventory is not restored on a refund — the food was made and eaten, and its
// COGS stays booked.
//
// Each step is idempotent: re-running it won't double-credit.
export async function postOrderRefund(
  orderId: string,
  reason: string,
  opts: { bookWalletRestore?: boolean } = {},
): Promise<PostOrderResult[]> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      customerId: true,
      conceptId: true,
      totalCents: true, walletAmountCents: true, taxCents: true, discountCents: true,
      promoDiscountCents: true, serviceChargeCents: true, tipCents: true,
      concept: { select: { slug: true, tenantId: true } },
      payments: { where: { status: 'refunded' }, select: { amountCents: true } },
      loyaltyTxs: { where: { type: 'earn' }, select: { id: true, loyaltyAccountId: true, pointsDelta: true, orderId: true } },
      giftCardRedemptions: { select: { id: true, giftCardId: true, amountCents: true } },
    },
  })
  if (!order) return [{ posted: false, entryId: null, reason: 'order_not_found' }]
  const results: PostOrderResult[] = []

  // 1) Loyalty earn reversal — idempotent per earn row (reversedAt claim).
  for (const earn of order.loyaltyTxs) {
    // Claim THIS earn, not the order. The old check asked whether the order had
    // any reversal at all, so the second earn on an order — the review bonus,
    // which carries the same orderId as the completion earn — was skipped and
    // the customer kept those points on a refunded order.
    const claimed = await prisma.loyaltyTransaction.updateMany({
      where: { id: earn.id, reversedAt: null },
      data: { reversedAt: new Date() },
    })
    if (claimed.count === 0) continue
    try {
      await prisma.$transaction([
        prisma.loyaltyAccount.update({
          where: { id: earn.loyaltyAccountId },
          data: {
            pointsBalance: { decrement: earn.pointsDelta },
            lifetimePoints: { decrement: earn.pointsDelta },
          },
        }),
        prisma.loyaltyTransaction.create({
          data: {
            loyaltyAccountId: earn.loyaltyAccountId,
            orderId: earn.orderId,
            type: 'reversal',
            pointsDelta: -earn.pointsDelta,
            description: `Reversed earn from refunded order: ${reason}`,
          },
        }),
      ])
    } catch (err) {
      // Release the claim so a retry can still claw the points back.
      await prisma.loyaltyTransaction
        .updateMany({ where: { id: earn.id }, data: { reversedAt: null } })
        .catch(() => {})
      console.error(`[refund] loyalty reversal for order ${orderId} failed:`, (err as Error).message)
    }
  }

  // 2) Wallet credit restore — idempotent on (orderId, type='refund').
  if (order.customerId && order.walletAmountCents > 0) {
    const alreadyRefunded = await prisma.walletTransaction.findFirst({
      where: { orderId, type: 'refund' },
    })
    if (!alreadyRefunded) {
      try {
        await prisma.$transaction(async (tx) => {
          const c = await tx.customer.update({
            where: { id: order.customerId! },
            data: { walletBalance: { increment: order.walletAmountCents } },
            select: { walletBalance: true },
          })
          await tx.walletTransaction.create({
            data: {
              customerId: order.customerId!,
              type: 'refund',
              amountCents: order.walletAmountCents,
              balanceAfter: c.walletBalance,
              description: `Refund of order — ${reason}`,
              orderId,
            },
          })
        })
      } catch (err) {
        console.error(`[refund] wallet restore for order ${orderId} failed:`, (err as Error).message)
      }
    }
    // The ledger side of a REFUNDED order's wallet restore (see the header).
    // Idempotent on the order id, so a replay after a failed balance restore
    // is safe either way round.
    if (opts.bookWalletRestore && order.concept.tenantId) {
      const prior = order.payments.reduce((t, p) => t + Math.abs(p.amountCents), 0)
      const memo = `Wallet restored on refund of ${order.concept.slug} #${order.id.slice(0, 8)}`
      try {
        const r = await postJournalEntry({
          tenantId: order.concept.tenantId,
          sourceType: 'order.refund_wallet',
          sourceId: order.id,
          description: `Wallet credit restored — order ${order.id.slice(0, 8)} refunded`,
          postedBy: 'system',
          lines: [
            ...refundDebitLines(order, prior, order.walletAmountCents, memo),
            { accountCode: ACCT.WALLET_LIABILITY, type: 'credit', amountCents: order.walletAmountCents, memo, conceptId: order.conceptId },
          ],
        })
        results.push({ posted: r.posted, entryId: r.entryId })
      } catch (err) {
        console.error(`[refund] wallet restore posting for order ${orderId} failed:`, (err as Error).message)
        results.push({ posted: false, entryId: null, reason: (err as Error).message })
      }
    }
  }

  // 3) Gift card redemption restore — atomic per redemption, idempotent on
  //    GiftCardRedemption.reversedAt, claimed before the balance moves.
  for (const r of order.giftCardRedemptions) {
    try {
      // Claim the reversal before touching the balance. The old code read the
      // row, ignored what it read, and incremented unconditionally — so every
      // write of status 'refunded' put the money back on the card again. Two
      // status writes doubled the customer's balance; a loop minted it. The
      // conditional update means exactly one caller can ever win.
      const claimed = await prisma.giftCardRedemption.updateMany({
        where: { id: r.id, reversedAt: null },
        data: { reversedAt: new Date() },
      })
      if (claimed.count === 0) continue   // already reversed

      await prisma.giftCard.update({
        where: { id: r.giftCardId },
        data: {
          balanceCents: { increment: r.amountCents },
          status: 'active',
        },
      })
    } catch (err) {
      // Release the claim so a retry can still restore the balance.
      await prisma.giftCardRedemption
        .updateMany({ where: { id: r.id }, data: { reversedAt: null } })
        .catch(() => {})
      console.error(`[refund] gift card restore for ${r.giftCardId} failed:`, (err as Error).message)
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
