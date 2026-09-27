// Order → journal posting.
//
// Every completed order posts ONE journal entry capturing: payment receipts,
// gross revenue (per concept), GST output, contra-revenue (discounts/promos),
// wallet/loyalty liability movements, and COGS / inventory derecognition.
//
// Posting is idempotent on (sourceType, sourceId) — see journal.ts. Replays
// from concurrent KDS bumps, retried webhooks, or worker reruns are no-ops.

import type { Order, OrderItem, Payment, Concept } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { ACCT, postJournalEntry, reverseJournalEntry, revenueCodeForConcept, type JournalLineInput } from './journal.js'
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
    // Determine if cash or card from the payment record(s)
    const cashPayments = order.payments.filter((p) => p.method === 'cash' && p.status === 'paid')
    const cashTotal = cashPayments.reduce((s, p) => s + p.amountCents, 0)
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

export async function reverseOrderCompletion(orderId: string, reason: string): Promise<PostOrderResult> {
  try {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { concept: { select: { tenantId: true } } },
    })
    const tenantId = order?.concept.tenantId
    if (!tenantId) return { posted: false, entryId: null, reason: 'order_not_found' }
    const result = await reverseJournalEntry(tenantId, 'order.complete', orderId, reason, { suffix: 'reversal' })
    return { posted: result.posted, entryId: result.entryId }
  } catch (err) {
    return { posted: false, entryId: null, reason: (err as Error).message }
  }
}

// Refund (full): reverses the original completion + every customer-side credit
// movement that was applied at order time. Specifically:
//   1. Journal entry — reversed (idempotent on sourceType+sourceId+suffix).
//   2. Loyalty earn — every LoyaltyTransaction{orderId, type='earn'} is paired
//      with a 'reversal' transaction that subtracts the same points; the
//      LoyaltyAccount balance and lifetimePoints decrement.
//   3. Wallet credit applied to the order — Order.walletAmountCents is added
//      back to Customer.walletBalance with a 'refund' WalletTransaction.
//   4. Gift card balance redeemed against the order — every GiftCardRedemption
//      adds its amountCents back to the GiftCard.balanceCents (and re-activates
//      the card if it was 'redeemed_full').
// Inventory is *not* restored on a refund — the food was made and eaten. Stock
// comes back only when an order ends WITHOUT a sale (cancelOrder →
// restoreInventoryForOrder in orders/service.ts), and such an order never
// booked COGS in the first place. KNOWN GAP: step 1 reverses the whole
// completion entry, COGS leg included, so a refunded order's food goes back
// onto INVENTORY_FOOD in the ledger while physical stock stays consumed. Until
// the refund re-books that cost (as waste), a count will show it as shrinkage.
//
// Each step is idempotent: re-running the refund won't double-debit.
export async function postOrderRefund(orderId: string, reason: string): Promise<PostOrderResult[]> {
  // Use the same prisma+ledger imports the rest of this module uses.
  const { prisma } = await import('../../lib/prisma.js')

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      customerId: true,
      walletAmountCents: true,
      loyaltyTxs: { where: { type: 'earn' as never }, select: { id: true, loyaltyAccountId: true, pointsDelta: true, orderId: true } },
      giftCardRedemptions: { select: { id: true, giftCardId: true, amountCents: true } },
    },
  })

  // 1) Journal reversal (existing behaviour)
  const reversal = await reverseOrderCompletion(orderId, reason)

  if (!order) return [reversal]

  // 2) Loyalty earn reversal — idempotent on (orderId, type='reversal')
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

  // 3) Wallet credit reversal — idempotent on (orderId, type='refund')
  if (order.customerId && order.walletAmountCents > 0) {
    const alreadyRefunded = await prisma.walletTransaction.findFirst({
      where: { orderId, type: 'refund' as never },
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
              type: 'refund' as never,
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
  }

  // 4) Gift card redemption reversal — atomic per redemption, idempotent on a
  //    flag we add to GiftCardRedemption (reversedAt). Falls back to balance
  //    restoration only if not already reversed.
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
          status: 'active' as never,
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

  return [reversal]
}

// Single-item void on the KDS: derecognise the item's contribution. For now
// we do NOT post a partial-reversal (would require recomputing taxes/discounts
// on a per-item basis); the operator should issue a full refund + re-ring the
// remaining items. This is a known iteration-1 limitation.
export async function noteItemVoid(_itemId: string): Promise<void> {
  // intentionally no-op — see comment above
}
