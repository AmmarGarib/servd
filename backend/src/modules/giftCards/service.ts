// Gift cards — THE redeem engine.
//
// There used to be two: POST /gift-cards/redeem drained a card with no order
// attached (the admin form never sent one), so a card "spent" at the till left
// the whole bill still due; storefront checkout had its own inline copy that
// ignored nothing but the card's company. Both now come here, and so does the
// till's gift-card tender (pos/service.applyGiftCardTender).
//
// Rules (owner decision 14):
//   - a card is spent only against an ORDER, at any brand of the company that
//     sold it (GiftCard.tenantId); another company's card is "not found";
//   - it pays at most what is still owed on the order (total − paid);
//   - the order's bill and its pending payment come down by what the card
//     paid, in the same transaction as the balance decrement, so the guest is
//     never charged twice and the card is never drained for nothing;
//   - expiry is enforced (and recorded), redeemed_full is set at zero.
//
// The ledger side (ONL-05): the redemption row IS the card-paid share. The
// sale that the order becomes — its 'order.complete' entry, or the shift close
// for a till bill — debits 2080 Gift Card Liability for the order's
// redemptions and computes revenue from the PRE-card total
// (accounting/orderPosting.ts computeSaleAccounting / giftCardAppliedOf). A
// refund that re-credits the card books the mirror ('order.refund_giftcard':
// Dr revenue / tax shares, Cr 2080); a cancel re-credits it with no entry,
// because a cancelled order never booked a sale.

import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
// guard.ts imports only lib/prisma and lib/errors, so a static import is cycle-free.
import { assertNoActiveTerminalChargeTx } from '../../connectors/terminal/guard.js'

type Tx = Prisma.TransactionClient

export interface RedeemGiftCardInput {
  code: string
  orderId: string
  /** Amount to take; omitted = as much as the card and the bill allow. */
  amountCents?: number
  redeemedById?: string | null
}

export interface RedeemGiftCardResult {
  appliedCents: number
  remainingDueCents: number
  cardBalanceCents: number
  redemptionId: string
  orderTenantId: string
}

/** Lower the order's bill and what is still pending on it by `cents`, inside `tx`. */
async function lowerBillTx(tx: Tx, orderId: string, cents: number): Promise<void> {
  await tx.order.update({ where: { id: orderId }, data: { totalCents: { decrement: cents } } })
  const pending = await tx.payment.findMany({
    where: { orderId, status: 'pending' },
    orderBy: { createdAt: 'asc' },
    select: { id: true, amountCents: true },
  })
  let left = cents
  for (const p of pending) {
    if (left <= 0) break
    const take = Math.min(left, p.amountCents)
    if (take > 0) await tx.payment.update({ where: { id: p.id }, data: { amountCents: { decrement: take } } })
    left -= take
  }
}

/**
 * THE redeem, inside the caller's transaction (TILL-R2).
 *
 * Its first statement takes the order's row lock — the same lock every till
 * tender takes (pos/service lockOrderTx: processPayment, settle, comp, void) —
 * and only THEN reads the order's status, total and paid payments. Before
 * this, the bill was read unlocked: a cash tender committing alongside left
 * the bill paid in full AND the card drained (the guest charged twice, 2080
 * cleared for nothing). Under the lock the redeem either sees the cash first
 * (ORDER_NOT_OPEN / NOTHING_DUE, card untouched) or the cash tender sees the
 * lowered bill and is asked only for the rest.
 *
 * The lock SQL is inlined on purpose: importing lockOrderTx from pos/service
 * would be a circular import (pos/service imports this module).
 *
 * Right after the lock, no card-machine charge may be in flight on the bill
 * (spec §7.10, W4-MONEY-1): the machine was sent an amount, and lowering the
 * bill under it would make the settle mismatch. 409 TERMINAL_CHARGE_ACTIVE,
 * card and bill untouched. Every caller gets this — the admin redeem, the
 * storefront checkout and the till (which also checks it itself).
 */
export async function redeemGiftCardTx(tx: Tx, input: RedeemGiftCardInput): Promise<RedeemGiftCardResult> {
  await tx.$queryRaw`SELECT id FROM orders WHERE id = ${input.orderId} FOR UPDATE`
  await assertNoActiveTerminalChargeTx(tx, input.orderId)
  const code = input.code.trim().toUpperCase()
  const order = await tx.order.findFirst({
    where: { id: input.orderId, deletedAt: null },
    select: {
      id: true, status: true, totalCents: true,
      concept: { select: { tenantId: true } },
      payments: { where: { status: 'paid' }, select: { amountCents: true } },
    },
  })
  if (!order || !order.concept.tenantId) throw new NotFoundError('Order', input.orderId)
  if (['completed', 'cancelled', 'rejected', 'refunded'].includes(order.status)) {
    throw new AppError('ORDER_NOT_OPEN', 'That order is already closed — a gift card cannot be applied to it.', 422)
  }
  const tenantId = order.concept.tenantId
  const paid = order.payments.reduce((s, p) => s + p.amountCents, 0)
  const outstanding = Math.max(0, order.totalCents - paid)

  // Looked up within the order's company: another company's card is unknown.
  const card = await tx.giftCard.findFirst({ where: { code, tenantId } })
  if (!card) throw new NotFoundError('GiftCard', code)
  if (card.status !== 'active') throw new AppError('GIFTCARD_INACTIVE', `Card is ${card.status}`, 422)
  if (card.expiresAt && card.expiresAt < new Date()) {
    await tx.giftCard.update({ where: { id: card.id }, data: { status: 'expired' } })
    throw new AppError('GIFTCARD_EXPIRED', 'Gift card has expired', 422)
  }

  const wanted = input.amountCents ?? card.balanceCents
  const apply = Math.min(wanted, card.balanceCents, outstanding)
  if (apply <= 0) {
    throw new AppError(outstanding <= 0 ? 'NOTHING_DUE' : 'INSUFFICIENT_BALANCE',
      outstanding <= 0 ? 'Nothing is left to pay on this order' : 'The card has no balance left', 422)
  }
  if (input.amountCents != null && input.amountCents > card.balanceCents) {
    throw new AppError('INSUFFICIENT_BALANCE', `Card has only PKR ${(card.balanceCents / 100).toFixed(2)} remaining`, 422)
  }

  // Conditional decrement: two redemptions racing on one card cannot both pass.
  const dec = await tx.giftCard.updateMany({
    where: { id: card.id, tenantId, status: 'active', balanceCents: { gte: apply } },
    data: { balanceCents: { decrement: apply } },
  })
  if (dec.count === 0) throw new AppError('INSUFFICIENT_BALANCE', 'The card balance changed — try again', 409)
  const after = await tx.giftCard.findUniqueOrThrow({ where: { id: card.id }, select: { balanceCents: true } })
  if (after.balanceCents === 0) {
    await tx.giftCard.update({ where: { id: card.id }, data: { status: 'redeemed_full' } })
  }
  const redemption = await tx.giftCardRedemption.create({
    data: {
      giftCardId: card.id,
      orderId: order.id,
      amountCents: apply,
      balanceAfter: after.balanceCents,
      redeemedById: input.redeemedById ?? null,
    },
  })
  // The card paid this much of the bill — the bill comes down with it.
  await lowerBillTx(tx, order.id, apply)

  return {
    appliedCents: apply,
    remainingDueCents: outstanding - apply,
    cardBalanceCents: after.balanceCents,
    redemptionId: redemption.id,
    orderTenantId: tenantId,
  }
}

/** The redeem in a transaction of its own (admin redeem, storefront checkout). */
export async function redeemGiftCard(input: RedeemGiftCardInput): Promise<RedeemGiftCardResult> {
  return prisma.$transaction((tx) => redeemGiftCardTx(tx, input))
}
