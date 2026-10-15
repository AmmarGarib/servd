// Loyalty — THE earn, redeem and tier engine.
//
// Before this file there were six places that minted points (order
// completion, POST /loyalty/earn, reservations, reviews, spend milestones,
// referrals), two redeem paths that valued a point differently (checkout at
// 10 paisa, /loyalty/redeem at the admin setting's PKR 1) while the books
// valued it at 1 paisa, and a customer-facing tier ladder hardcoded on points
// that nothing ever assigned. Everything that moves points goes through here:
//
//   creditPoints / creditPointsTx  every earn (order, reservation, review,
//                                  milestone, referral, birthday). Books the
//                                  liability (postLoyaltyEarn) once per earn.
//   awardOrderPoints               the ONE order earn, called when an order
//                                  completes (orders/service transition; the
//                                  till must call it too — see report).
//   quoteRedemption / claimRedemption / redeemPointsOnOrder
//                                  the ONE redeem, used by storefront checkout
//                                  and POST /loyalty/redeem. Value from the
//                                  company's setting (owner decision 12: one
//                                  point = PKR 0.10), min_redeem_points
//                                  enforced, the discount recorded on the
//                                  order (discountCents) and the liability
//                                  discharged (postLoyaltyRedeem).
//   tierStatus / syncTier          the ladder is TierConfig, unlocked on the
//                                  customer's lifetime spend at the company
//                                  (owner decision 13).
//
// Accounts are PER COMPANY (ONL-04): LoyaltyAccount is keyed by (tenantId,
// customerId). Points earned at one company's brands are spent, expired and
// clawed back only at that company, whose books carry the liability. The one
// shared account let a customer earn at GS Foods and spend at another company,
// which then booked a redemption against a liability it never raised. Use
// loyaltyAccountOf / ensureLoyaltyAccountTx — never look an account up by
// customer alone.

import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { primaryTenantId } from '../../lib/setup-config.js'
import { calculatePointsEarned, loadLoyaltySettings, POINT_VALUE_CENTS } from '../../lib/loyaltySettings.js'
// guard.ts imports only lib/prisma and lib/errors, so a static import is cycle-free.
import { assertNoActiveTerminalChargeTx } from '../../connectors/terminal/guard.js'
import { orderRefOf } from '../../lib/orderRef.js'

type Tx = Prisma.TransactionClient

/** Prefix every order earn carries; the once-per-order guard matches on it. */
export const ORDER_EARN_PREFIX = 'Earned '

// ─── Accounts: one per customer per company ──────────────────────────────────

/** The customer's account at `tenantId`, created on first use, inside `tx`. */
export async function ensureLoyaltyAccountTx(tx: Tx, customerId: string, tenantId: string) {
  return tx.loyaltyAccount.upsert({
    where: { tenantId_customerId: { tenantId, customerId } },
    create: { tenantId, customerId, stampCounts: {} },
    update: {},
  })
}

/** The customer's account at `tenantId`, or null (no company → no account). */
export async function loyaltyAccountOf(customerId: string, tenantId: string | null | undefined) {
  if (!tenantId) return null
  return prisma.loyaltyAccount.findUnique({ where: { tenantId_customerId: { tenantId, customerId } } })
}

/** Every account the customer holds — one per company they have points with. */
export async function loyaltyAccountsOf(customerId: string) {
  return prisma.loyaltyAccount.findMany({ where: { customerId }, orderBy: { createdAt: 'asc' } })
}

// ─── Which company a customer's points belong to ──────────────────────────────

/**
 * The company whose settings value a customer's points and whose books carry
 * the liability: the order's brand's company when there is an order, else the
 * company of their most recent order, else the primary company. Mirrors
 * accounting/loyaltyPosting.ts so the value quoted and the value booked agree.
 */
export async function loyaltyCompanyOf(customerId: string | null, orderId?: string | null): Promise<string | null> {
  if (orderId) {
    const o = await prisma.order.findUnique({ where: { id: orderId }, select: { concept: { select: { tenantId: true } } } })
    if (o?.concept.tenantId) return o.concept.tenantId
  }
  if (customerId) {
    const last = await prisma.order.findFirst({
      where: { customerId, deletedAt: null, concept: { tenantId: { not: null } } },
      orderBy: { placedAt: 'desc' },
      select: { concept: { select: { tenantId: true } } },
    })
    if (last?.concept.tenantId) return last.concept.tenantId
  }
  return primaryTenantId()
}

/** The company of an order's brand, or null. */
async function orderCompanyOf(orderId: string): Promise<string | null> {
  const o = await prisma.order.findUnique({ where: { id: orderId }, select: { concept: { select: { tenantId: true } } } })
  return o?.concept.tenantId ?? null
}

/** The company behind a brand slug, or null. */
export async function companyOfConceptSlug(slug: string | null | undefined): Promise<string | null> {
  if (!slug) return null
  const c = await prisma.concept.findFirst({ where: { slug, deletedAt: null }, select: { tenantId: true } })
  return c?.tenantId ?? null
}

/** The programme numbers a customer-facing page needs, for one company. */
export async function loyaltyProgram(tenantId: string | null) {
  const s = await loadLoyaltySettings(tenantId)
  return {
    pointValueCents:     s['loyalty.point_value_cents'],
    earnCentsPerPoint:   s['loyalty.earn_cents_per_point'],
    minRedeemPoints:     s['loyalty.min_redeem_points'],
    birthdayBonusPoints: s['loyalty.birthday_bonus_points'],
    expiryMonths:        s['loyalty.expiry_months'],
  }
}

// ─── Earn ─────────────────────────────────────────────────────────────────────

export interface CreditInput {
  customerId: string
  points: number
  description: string
  /**
   * The company whose programme the points are in — the company that is
   * giving them. Omitted: the order's brand's company. With neither, nothing
   * is credited: a bonus is never parked at a guessed company (the customer's
   * latest-order company or the oldest company — LEDGER-R8).
   */
  tenantId?: string | null
  orderId?: string | null
  /** Brand slug whose stamp card advances by one visit (order earns only). */
  stampConceptSlug?: string | null
  stampThreshold?: number
}

export interface CreditResult {
  credited: boolean
  txId: string | null
  earnedFreeItem: boolean
  stamps: Record<string, number> | null
}

/**
 * Credit points inside the caller's transaction. Creates the loyalty account
 * when missing. For an order earn (orderId + ORDER_EARN_PREFIX description) it
 * is once per order: the account row is locked and an existing order earn
 * makes this a no-op. The liability is NOT booked here — call bookEarn(txId)
 * after the transaction commits (postJournalEntry runs on its own client).
 */
export async function creditPointsTx(tx: Tx, input: CreditInput): Promise<CreditResult> {
  const none: CreditResult = { credited: false, txId: null, earnedFreeItem: false, stamps: null }
  const points = Math.max(0, Math.floor(input.points))
  if (points <= 0 && !input.stampConceptSlug) return none

  const tenantId = input.tenantId ?? (input.orderId ? await orderCompanyOf(input.orderId) : null)
  if (!tenantId) {
    console.warn(`[loyalty] ${points} pts for customer ${input.customerId} not credited: no company given ("${input.description}")`)
    return none
  }
  const account = await ensureLoyaltyAccountTx(tx, input.customerId, tenantId)
  // Serialise earns on this account so the once-per-order check below can't
  // be raced by a second completion of the same order.
  await tx.$queryRaw`SELECT id FROM loyalty_accounts WHERE id = ${account.id} FOR UPDATE`

  const isOrderEarn = !!input.orderId && input.description.startsWith(ORDER_EARN_PREFIX)
  if (isOrderEarn) {
    const already = await tx.loyaltyTransaction.findFirst({
      where: { orderId: input.orderId!, type: 'earn', description: { startsWith: ORDER_EARN_PREFIX } },
      select: { id: true },
    })
    if (already) return none
  }

  let stamps: Record<string, number> | null = null
  let earnedFreeItem = false
  if (input.stampConceptSlug) {
    const threshold = input.stampThreshold && input.stampThreshold > 0 ? input.stampThreshold : 9
    const fresh = await tx.loyaltyAccount.findUniqueOrThrow({ where: { id: account.id }, select: { stampCounts: true } })
    stamps = fresh.stampCounts && typeof fresh.stampCounts === 'object' && !Array.isArray(fresh.stampCounts)
      ? { ...(fresh.stampCounts as Record<string, number>) }
      : {}
    const current = stamps[input.stampConceptSlug] ?? 0
    const next = (current + 1) % (threshold + 1)
    earnedFreeItem = next === 0 && current === threshold
    stamps[input.stampConceptSlug] = next
  }

  await tx.loyaltyAccount.update({
    where: { id: account.id },
    data: {
      ...(points > 0 && { pointsBalance: { increment: points }, lifetimePoints: { increment: points } }),
      ...(stamps && { stampCounts: stamps }),
    },
  })
  if (points <= 0) return { credited: false, txId: null, earnedFreeItem, stamps }

  const ltx = await tx.loyaltyTransaction.create({
    data: {
      loyaltyAccountId: account.id,
      orderId: input.orderId ?? null,
      type: 'earn',
      pointsDelta: points,
      description: input.description,
    },
  })
  return { credited: true, txId: ltx.id, earnedFreeItem, stamps }
}

/**
 * Outcomes of a loyalty posting that mean "nothing to book", not a refusal:
 * the transaction is gone, is not of that kind, is worth nothing, or was
 * reversed (refund / cancel) before its posting landed — the reversal found
 * nothing booked and booked nothing, so the books already net to zero
 * (postLoyaltyEarn / postLoyaltyRedeem re-check it under a row lock).
 */
export const LOYALTY_NOTHING_TO_POST: ReadonlySet<string> = new Set(['tx_not_found', 'not_earn_tx', 'not_redeem_tx', 'zero_value', 'reversed'])

/**
 * A loyalty posting the ledger refused (BOOKS-R2-01 follow-up): raise the
 * posting_failed flag in the owning company's inbox, so it is fixed and
 * re-posted from Reconciliation → Backfill unposted instead of living only in
 * the log. The company is the points account's (else the order's brand's).
 * Keyed on the order when there is one — the same key the order-completion
 * check uses, so one refusal raises one flag. Never throws.
 */
async function flagLoyaltyRefusal(kind: 'loyalty.earn' | 'loyalty.redeem', txId: string, reason: string): Promise<void> {
  try {
    const ltx = await prisma.loyaltyTransaction.findUnique({
      where: { id: txId },
      select: {
        orderId: true,
        loyaltyAccount: { select: { tenantId: true } },
        order: { select: { conceptId: true, concept: { select: { tenantId: true } } } },
      },
    })
    const orderId = ltx?.orderId ?? null
    const { flagPostingFailed } = await import('../accounting/journal.js')
    await flagPostingFailed({
      tenantId:   ltx?.loyaltyAccount.tenantId ?? ltx?.order?.concept.tenantId ?? null,
      sourceType: kind,
      sourceId:   txId,
      entityType: orderId ? 'Order' : 'LoyaltyTransaction',
      entityId:   orderId ?? txId,
      reason,
      title: kind === 'loyalty.earn'
        ? `Loyalty points earned${orderId ? ' on an order' : ''} did not reach the ledger (2060)`
        : 'Loyalty points redeemed did not reach the ledger (2060)',
      conceptId:  ltx?.order?.conceptId ?? null,
    })
  } catch (err) {
    console.error(`[loyalty] could not flag the refused ${kind} ${txId}:`, (err as Error).message)
  }
}

/**
 * Book the loyalty liability for an earn (Dr 6060 / Cr 2060). Never throws.
 * A refusal (closed period, missing account, no company…) is flagged
 * posting_failed for the company; "nothing to post" outcomes are not.
 */
export async function bookEarn(txId: string | null): Promise<void> {
  if (!txId) return
  let reason: string | null = null
  try {
    const { postLoyaltyEarn } = await import('../accounting/loyaltyPosting.js')
    const r = await postLoyaltyEarn(txId)
    if (!r.posted && r.reason) {
      console.warn(`[loyalty] earn ${txId} not booked: ${r.reason}`)
      if (!LOYALTY_NOTHING_TO_POST.has(r.reason)) reason = r.reason
    }
  } catch (err) {
    reason = (err as Error).message
    console.error(`[loyalty] postLoyaltyEarn failed for ${txId}:`, reason)
  }
  if (reason) await flagLoyaltyRefusal('loyalty.earn', txId, reason)
}

/** Credit points in their own transaction and book the liability. */
export async function creditPoints(input: CreditInput): Promise<CreditResult> {
  const result = await prisma.$transaction((tx) => creditPointsTx(tx, input))
  await bookEarn(result.txId)
  return result
}

/**
 * THE order earn. Called once an order has completed (any channel). Points
 * follow the company's earn rate on what the order charged; the brand's stamp
 * card advances one visit; the tier is re-evaluated on the new spend.
 * Idempotent per order. Never throws — a loyalty failure must not block the
 * pass or the till.
 */
export async function awardOrderPoints(orderId: string): Promise<CreditResult | null> {
  try {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true, status: true, customerId: true, totalCents: true, concept: { select: { slug: true, tenantId: true } },
        payments: { where: { method: 'on_account', status: 'paid' }, select: { id: true }, take: 1 },
      },
    })
    if (!order || !order.customerId || order.status !== 'completed') return null
    // Decision OA-LOYALTY: a bill charged to an on-account client earns no
    // points — the client's company pays it, not the diner.
    if (order.payments.length > 0) return null
    const tenantId = order.concept.tenantId
    const settings = await loadLoyaltySettings(tenantId)
    const points = await calculatePointsEarned(order.totalCents, tenantId)
    const result = await creditPoints({
      customerId: order.customerId,
      points,
      tenantId,
      orderId: order.id,
      description: `${ORDER_EARN_PREFIX}${points} pts — order #${orderRefOf(order.id)} completed`,
      stampConceptSlug: order.concept.slug,
      stampThreshold: settings['loyalty.stamp_threshold'],
    })
    if (tenantId) await syncTier(order.customerId, tenantId).catch(() => {})
    return result
  } catch (err) {
    console.error(`[loyalty] earn failed for order ${orderId}:`, (err as Error).message)
    return null
  }
}

// ─── Redeem ───────────────────────────────────────────────────────────────────

export interface RedemptionQuote { points: number; discountCents: number; pointValueCents: number }

/**
 * How much `requestedPoints` is worth against a bill of at most `capCents`, at
 * `tenantId`'s point value. Enforces the company's min_redeem_points and the
 * customer's balance AT THAT COMPANY (points earned at another company are
 * not spendable here — ONL-04); points are rounded up to cover a capped
 * discount exactly.
 */
export async function quoteRedemption(args: {
  customerId: string
  requestedPoints: number
  tenantId: string | null
  capCents: number
}): Promise<RedemptionQuote> {
  const settings = await loadLoyaltySettings(args.tenantId)
  return quoteWith(settings, args, async () => (await loyaltyAccountOf(args.customerId, args.tenantId))?.pointsBalance ?? 0)
}

type LoyaltySettings = Awaited<ReturnType<typeof loadLoyaltySettings>>

/**
 * The quote itself, on settings the caller already loaded and a balance read
 * the caller supplies — so a caller inside an interactive transaction makes
 * every read on its own `tx` (I1-RV-1: a read on the global client from inside
 * a transaction needs a second pool connection, and as many concurrent callers
 * as the pool has connections then starve each other until they all time out).
 */
async function quoteWith(
  settings: LoyaltySettings,
  args: { requestedPoints: number; tenantId: string | null; capCents: number },
  readBalance: () => Promise<number>,
): Promise<RedemptionQuote> {
  const value = settings['loyalty.point_value_cents'] || POINT_VALUE_CENTS
  const zero = { points: 0, discountCents: 0, pointValueCents: value }
  const requested = Math.max(0, Math.floor(args.requestedPoints))
  if (requested === 0 || args.capCents <= 0) return zero

  const min = settings['loyalty.min_redeem_points'] ?? 0
  if (requested < min) {
    throw new AppError('LOYALTY_BELOW_MINIMUM', `At least ${min} points are needed to redeem`, 400)
  }
  // No company → no account (points are held per company — ONL-04).
  const available = args.tenantId ? Math.max(0, await readBalance()) : 0
  if (available < min) {
    throw new AppError('LOYALTY_BELOW_MINIMUM', `At least ${min} points are needed to redeem`, 400)
  }
  const usable = Math.min(requested, available)
  // Same value as calculatePointsValue(usable, tenantId), on the settings in hand.
  const discountCents = Math.min(usable * value, args.capCents)
  const points = Math.min(usable, Math.ceil(discountCents / value))
  return { points, discountCents, pointValueCents: value }
}

/**
 * The order's row lock — the same `SELECT … FOR UPDATE` every till tender
 * takes (pos/service lockOrderTx). Inlined, not imported: pos/service imports
 * this module. Anything here that touches the order's bill or discount takes
 * it FIRST, before any loyalty-account row, so the lock order matches the
 * till (order row, then everything else) and no new deadlock is possible.
 */
async function lockOrderRowTx(tx: Tx, orderId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId} FOR UPDATE`
}

/**
 * Book the liability discharge for a redeem (Dr 2060 / Cr 4xxx). Never
 * throws. A refusal is flagged posting_failed for the company (see bookEarn).
 */
async function bookRedeem(txId: string | null): Promise<void> {
  if (!txId) return
  let reason: string | null = null
  try {
    const { postLoyaltyRedeem } = await import('../accounting/loyaltyPosting.js')
    const r = await postLoyaltyRedeem(txId)
    if (!r.posted && r.reason) {
      console.warn(`[loyalty] redeem ${txId} not booked: ${r.reason}`)
      if (!LOYALTY_NOTHING_TO_POST.has(r.reason)) reason = r.reason
    }
  } catch (err) {
    reason = (err as Error).message
    console.error(`[loyalty] postLoyaltyRedeem failed for ${txId}:`, reason)
  }
  if (reason) await flagLoyaltyRefusal('loyalty.redeem', txId, reason)
}

/**
 * claimRedemption inside the caller's transaction. Takes the order's row lock
 * first (lock order: order row, then the loyalty account). Returns the redeem
 * transaction's id, or null when the balance moved and nothing was taken. The
 * caller books it (bookRedeem) after the transaction commits.
 */
async function claimRedemptionTx(tx: Tx, args: { customerId: string; orderId: string; quote: RedemptionQuote }): Promise<string | null> {
  const { customerId, orderId, quote } = args
  if (quote.points <= 0 || quote.discountCents <= 0) return null
  await lockOrderRowTx(tx, orderId)
  // The order's brand decides whose points these are — never the caller.
  const order = await tx.order.findUnique({ where: { id: orderId }, select: { concept: { select: { tenantId: true } } } })
  const tenantId = order?.concept.tenantId
  if (!tenantId) return null
  const took = await tx.loyaltyAccount.updateMany({
    where: { tenantId, customerId, pointsBalance: { gte: quote.points } },
    data: { pointsBalance: { decrement: quote.points } },
  })
  if (took.count === 0) return null
  const account = await tx.loyaltyAccount.findUniqueOrThrow({ where: { tenantId_customerId: { tenantId, customerId } }, select: { id: true } })
  const ltx = await tx.loyaltyTransaction.create({
    data: {
      loyaltyAccountId: account.id,
      orderId,
      type: 'redeem',
      pointsDelta: -quote.points,
      description: `Redeemed ${quote.points} pts for PKR ${(quote.discountCents / 100).toFixed(2)} off order #${orderRefOf(orderId)}`,
    },
  })
  await tx.order.update({ where: { id: orderId }, data: { discountCents: { increment: quote.discountCents } } })
  return ltx.id
}

/**
 * Take quoted points for an order whose bill ALREADY excludes the discount.
 * Atomic on the balance of the customer's account AT THE ORDER'S COMPANY;
 * records the redeem transaction, adds the discount to order.discountCents
 * (the order posting books it as contra-revenue, the redeem posting
 * discharges the liability against it) and books the redemption. Returns
 * false when the balance moved and nothing was taken — the caller must then
 * put the discount back on the bill.
 */
export async function claimRedemption(args: { customerId: string; orderId: string; quote: RedemptionQuote }): Promise<boolean> {
  const txId = await prisma.$transaction((tx) => claimRedemptionTx(tx, args))
  if (!txId) return false
  await bookRedeem(txId)
  return true
}

/**
 * Move the order's bill and what is still pending on it by `cents` inside
 * `tx` (positive lowers, negative raises it back onto the first pending row).
 * Under the order's row lock, and refused with 409 TERMINAL_CHARGE_ACTIVE
 * while a card-machine charge is in flight on the bill (spec §7.10,
 * W4-MONEY-1): the machine was sent an amount, and the bill must not move
 * under it.
 */
async function adjustOrderBillTx(tx: Tx, orderId: string, cents: number): Promise<void> {
  if (cents === 0) return
  await lockOrderRowTx(tx, orderId)
  await assertNoActiveTerminalChargeTx(tx, orderId)
  await tx.order.update({ where: { id: orderId }, data: { totalCents: { decrement: cents } } })
  const pending = await tx.payment.findMany({ where: { orderId, status: 'pending' }, orderBy: { createdAt: 'asc' }, select: { id: true, amountCents: true } })
  if (cents < 0) {
    if (pending[0]) await tx.payment.update({ where: { id: pending[0].id }, data: { amountCents: { increment: -cents } } })
    return
  }
  let left = cents
  for (const p of pending) {
    if (left <= 0) break
    const take = Math.min(left, p.amountCents)
    if (take > 0) await tx.payment.update({ where: { id: p.id }, data: { amountCents: { decrement: take } } })
    left -= take
  }
}

/**
 * Lower an order's bill (and what is still pending on it) by `cents`, or raise
 * it back with a negative amount — in one transaction under the order lock,
 * never while the card machine is charging the bill (409
 * TERMINAL_CHARGE_ACTIVE, nothing changed).
 */
export async function adjustOrderBill(orderId: string, cents: number): Promise<void> {
  if (cents === 0) return
  await prisma.$transaction((tx) => adjustOrderBillTx(tx, orderId, cents))
}

/**
 * Redeem points against an existing, still-open order of this customer
 * (POST /loyalty/redeem). Once per order. The bill and the pending payment
 * come down by the discount — the old endpoint only raised discountCents and
 * left the guest owing the full amount.
 *
 * One transaction under the order's row lock: the status, the once-per-order
 * check and what is still owed are read under it, the points are taken and
 * the bill lowered together, and nothing moves while a card-machine charge is
 * in flight on the bill (409 TERMINAL_CHARGE_ACTIVE — points, discount and
 * bill untouched). The discount is capped at what is still owed (total −
 * paid), so it never pushes the bill below money already taken.
 */
export async function redeemPointsOnOrder(args: { customerId: string; orderId: string; points: number }) {
  // Everything that needs the global client is read BEFORE the transaction
  // opens (I1-RV-1): the transaction holds one pool connection and the order
  // lock, so a global-client read inside it would wait on a second connection
  // — enough concurrent redeems and every one of them (and the rest of the
  // API) waits on the pool until the transaction times out. The company is
  // re-checked under the lock; the settings are its loyalty programme.
  const pre = await prisma.order.findFirst({
    where: { id: args.orderId, customerId: args.customerId, deletedAt: null },
    select: { concept: { select: { tenantId: true } } },
  })
  if (!pre) throw new NotFoundError('Order', args.orderId)
  const tenantId = pre.concept.tenantId
  const settings = await loadLoyaltySettings(tenantId)

  const done = await prisma.$transaction(async (tx) => {
    await lockOrderRowTx(tx, args.orderId)
    const order = await tx.order.findFirst({
      where: { id: args.orderId, customerId: args.customerId, deletedAt: null },
      select: {
        id: true, status: true, totalCents: true, concept: { select: { tenantId: true } },
        payments: { where: { status: 'paid' }, select: { amountCents: true } },
      },
    })
    if (!order) throw new NotFoundError('Order', args.orderId)
    if (order.concept.tenantId !== tenantId) {
      // The order moved brand between the read above and the lock — the
      // settings loaded are another company's. Never quote on them.
      throw new AppError('ORDER_CHANGED', 'This order changed while redeeming — please try again.', 409)
    }
    if (['completed', 'cancelled', 'rejected', 'refunded'].includes(order.status)) {
      throw new AppError('ORDER_NOT_OPEN', 'That order is already closed — points cannot be redeemed against it.', 422)
    }
    await assertNoActiveTerminalChargeTx(tx, order.id)
    const already = await tx.loyaltyTransaction.findFirst({ where: { orderId: order.id, type: 'redeem' }, select: { id: true } })
    if (already) throw new AppError('ALREADY_REDEEMED', 'Points have already been redeemed on this order.', 409)

    const paid = order.payments.reduce((s, p) => s + p.amountCents, 0)
    const outstanding = Math.max(0, order.totalCents - paid)
    if (outstanding <= 0) throw new AppError('NOTHING_DUE', 'Nothing is left to pay on this order', 422)
    const quote = await quoteWith(
      settings,
      { requestedPoints: args.points, tenantId, capCents: outstanding },
      async () => tenantId
        ? (await tx.loyaltyAccount.findUnique({
            where: { tenantId_customerId: { tenantId, customerId: args.customerId } },
            select: { pointsBalance: true },
          }))?.pointsBalance ?? 0
        : 0,
    )
    if (quote.points === 0) throw new AppError('INSUFFICIENT_POINTS', 'Not enough points', 400)
    const txId = await claimRedemptionTx(tx, { customerId: args.customerId, orderId: order.id, quote })
    if (!txId) throw new AppError('INSUFFICIENT_POINTS', 'Not enough points', 400)
    await adjustOrderBillTx(tx, order.id, quote.discountCents)
    return { txId, quote }
  }, { maxWait: 10_000, timeout: 15_000 })
  await bookRedeem(done.txId)
  const account = await loyaltyAccountOf(args.customerId, tenantId)
  return { pointsRedeemed: done.quote.points, discountCents: done.quote.discountCents, newBalance: account?.pointsBalance ?? 0 }
}

// ─── Tiers (TierConfig, unlocked on lifetime spend — decision 13) ─────────────

export interface TierRef { slug: string; name: string; rank: number; unlockSpendCents: number }

/**
 * The free-tier ladder for a company, lowest rank first. TierConfig carries no
 * company column yet (see report), so every company reads the same rows; this
 * is the one place to narrow it once `tenantId` lands.
 */
export async function tierLadder(tenantId: string | null): Promise<TierRef[]> {
  // Each company has its own ladder (owner decision 13); no company, no ladder.
  if (!tenantId) return []
  const rows = await prisma.tierConfig.findMany({
    where: { tenantId, isActive: true, isPaid: false },
    orderBy: [{ rank: 'asc' }, { unlockSpendCents: 'asc' }],
    select: { tier: true, displayName: true, rank: true, unlockSpendCents: true },
  })
  const ladder = rows.map((r) => ({
    slug: r.tier,
    name: r.displayName ?? r.tier.charAt(0).toUpperCase() + r.tier.slice(1),
    rank: r.rank,
    unlockSpendCents: r.unlockSpendCents ?? 0,
  }))
  return ladder.length > 0 ? ladder : [{ slug: 'bronze', name: 'Bronze', rank: 0, unlockSpendCents: 0 }]
}

/** Lifetime spend at one company's brands: what completed orders charged. */
export async function companySpendCents(customerId: string, tenantId: string | null): Promise<number> {
  const agg = await prisma.order.aggregate({
    where: { customerId, status: 'completed', deletedAt: null, ...(tenantId ? { concept: { tenantId } } : {}) },
    _sum: { totalCents: true },
  })
  return agg._sum.totalCents ?? 0
}

export async function tierStatus(customerId: string, tenantId: string | null) {
  const [ladder, spend] = await Promise.all([tierLadder(tenantId), companySpendCents(customerId, tenantId)])
  let current = ladder[0]!
  for (const t of ladder) if (t.unlockSpendCents <= spend) current = t
  const next = ladder.find((t) => t.rank > current.rank && t.unlockSpendCents > spend) ?? null
  const from = current.unlockSpendCents
  const progressPct = next ? Math.max(0, Math.min(100, Math.round(((spend - from) / Math.max(1, next.unlockSpendCents - from)) * 100))) : 100
  return {
    tier: current,
    nextTier: next,
    lifetimeSpendCents: spend,
    spendToNextCents: next ? Math.max(0, next.unlockSpendCents - spend) : 0,
    progressPct,
  }
}

/**
 * Write the tier the customer has unlocked at `tenantId` onto their account
 * AT THAT COMPANY so the perk lookups (lib/tierPerks.ts) and the admin member
 * counts see it. Tiers only move up here; a paid tier assigned by staff is
 * never overwritten.
 */
export async function syncTier(customerId: string, tenantId: string): Promise<string | null> {
  const status = await tierStatus(customerId, tenantId)
  const account = await loyaltyAccountOf(customerId, tenantId)
  if (!account) return null
  const held = await prisma.tierConfig.findFirst({ where: { tenantId, tier: account.tier }, select: { isPaid: true, rank: true } })
  if (account.tier === status.tier.slug || held?.isPaid || (held && held.rank >= status.tier.rank)) return account.tier
  await prisma.loyaltyAccount.update({ where: { id: account.id }, data: { tier: status.tier.slug } })
  return status.tier.slug
}
