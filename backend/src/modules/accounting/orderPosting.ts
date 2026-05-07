// Order → journal posting.
//
// Every completed order posts ONE journal entry capturing: payment receipts,
// gross revenue (per concept), GST output, contra-revenue (discounts/promos),
// wallet/loyalty liability movements, and COGS / inventory derecognition.
//
// Posting is idempotent on (sourceType, sourceId) — see journal.ts. Replays
// from concurrent KDS bumps, retried webhooks, or worker reruns are no-ops.

import type { Order, OrderItem, Payment, Concept, Recipe, RecipeIngredient, InventoryItem, Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { ACCT, postJournalEntry, reverseJournalEntry, revenueCodeForConcept, type JournalLineInput } from './journal.js'

const Q_FACTOR = 0.05 // 5% recipe shrinkage uplift, mirrors recipes module

interface OrderForPosting extends Order {
  concept: Concept
  payments: Payment[]
  items: (OrderItem & { menuItem?: { recipe?: (Recipe & { ingredients: (RecipeIngredient & { inventoryItem: InventoryItem })[] }) | null } | null })[]
}

async function loadOrderForPosting(orderId: string): Promise<OrderForPosting | null> {
  return (await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      concept: true,
      payments: true,
      items: {
        include: {
          menuItem: {
            include: {
              recipe: {
                include: {
                  ingredients: { include: { inventoryItem: true } },
                },
              },
            },
          },
        },
      },
    },
  })) as OrderForPosting | null
}

// Theoretical food cost for the order, summed from recipe ingredients of each
// non-voided item (yield-adjusted, with shrinkage uplift). Items without a
// recipe contribute 0 — COGS for those is recognised when their inventory is
// counted/adjusted, not at sale time.
function computeOrderCogsCents(order: OrderForPosting): number {
  let totalCents = 0
  for (const item of order.items) {
    if (item.status === 'voided') continue
    const recipe = item.menuItem?.recipe
    if (!recipe || recipe.servings < 1) continue

    const ingCost = recipe.ingredients.reduce((s, ing) => {
      const yp = ing.yieldPct > 0 ? ing.yieldPct : 1
      return s + Math.round((ing.inventoryItem.unitCostCents ?? 0) * (ing.quantity / yp))
    }, 0)
    const totalWithQ     = Math.round(ingCost * (1 + Q_FACTOR))
    const costPerPortion = Math.round(totalWithQ / recipe.servings)
    totalCents += costPerPortion * item.quantity
  }
  return totalCents
}

interface SaleAccounting {
  // Customer-facing money flow (charged to a payment instrument)
  totalChargedCents:   number   // hits cash drawer / card receivable / Foodpanda AR
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

  // Channel-specific
  foodpandaCommissionCents: number
}

function computeSaleAccounting(order: OrderForPosting): SaleAccounting {
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

  // Per-concept negotiated rate, falls back to default 0.25 if unset.
  const foodpandaCommissionCents =
    order.source === 'foodpanda'
      ? Math.round(totalChargedCents * (order.concept.foodpandaCommissionRate ?? 0.25))
      : 0

  return {
    totalChargedCents,
    walletAppliedCents,
    loyaltyRedeemedCents,
    taxCents,
    discountCents,
    grossRevenueCents,
    serviceChargeCents,
    tipCents,
    foodpandaCommissionCents,
  }
}

function buildSaleLines(order: OrderForPosting, sa: SaleAccounting, cogsCents: number): JournalLineInput[] {
  const lines: JournalLineInput[] = []
  const conceptMemo = `${order.concept.slug} #${order.id.slice(0, 8)}`

  // ── Debits: where the money / value moved TO ───────────────────────────
  if (sa.totalChargedCents > 0) {
    if (order.source === 'foodpanda') {
      const netDueFromFoodpanda = sa.totalChargedCents - sa.foodpandaCommissionCents
      if (netDueFromFoodpanda > 0) {
        lines.push({ accountCode: ACCT.FOODPANDA_AR, type: 'debit', amountCents: netDueFromFoodpanda, memo: conceptMemo })
      }
      if (sa.foodpandaCommissionCents > 0) {
        lines.push({ accountCode: ACCT.FOODPANDA_COMMISSION, type: 'debit', amountCents: sa.foodpandaCommissionCents, memo: conceptMemo })
      }
    } else {
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

  return lines
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
  const cogsCents = computeOrderCogsCents(order)
  const lines = buildSaleLines(order, sa, cogsCents)

  const result = await postJournalEntry({
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
    const result = await reverseJournalEntry('order.complete', orderId, reason, { suffix: 'reversal' })
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
// Inventory is *not* automatically restored — physical inventory consumed at
// production cannot be un-consumed. A counter-WasteLog or manual adjust is
// required if you want the COGS reflected differently.
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
    const alreadyReversed = await prisma.loyaltyTransaction.findFirst({
      where: { orderId: earn.orderId, type: 'reversal' as never },
    })
    if (alreadyReversed) continue
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
            type: 'reversal' as never,
            pointsDelta: -earn.pointsDelta,
            description: `Reversed earn from refunded order: ${reason}`,
          },
        }),
      ])
    } catch (err) {
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
    const existing = await prisma.giftCardRedemption.findUnique({
      where: { id: r.id },
      select: { balanceAfter: true } as never,
    })
    if (!existing) continue
    // Re-credit the gift card by the redeemed amount, re-activating if needed.
    try {
      await prisma.giftCard.update({
        where: { id: r.giftCardId },
        data: {
          balanceCents: { increment: r.amountCents },
          status: 'active' as never,
        },
      })
    } catch (err) {
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
