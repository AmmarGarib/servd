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

import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { primaryTenantId } from '../../lib/setup-config.js'
import { calculatePointsEarned, calculatePointsValue, loadLoyaltySettings, POINT_VALUE_CENTS } from '../../lib/loyaltySettings.js'

type Tx = Prisma.TransactionClient

/** Prefix every order earn carries; the once-per-order guard matches on it. */
export const ORDER_EARN_PREFIX = 'Earned '

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

  const account = await tx.loyaltyAccount.upsert({
    where: { customerId: input.customerId },
    create: { customerId: input.customerId, stampCounts: {} },
    update: {},
  })
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

/** Book the loyalty liability for an earn (Dr 6060 / Cr 2060). Never throws. */
export async function bookEarn(txId: string | null): Promise<void> {
  if (!txId) return
  try {
    const { postLoyaltyEarn } = await import('../accounting/loyaltyPosting.js')
    const r = await postLoyaltyEarn(txId)
    if (!r.posted && r.reason) console.warn(`[loyalty] earn ${txId} not booked: ${r.reason}`)
  } catch (err) {
    console.error(`[loyalty] postLoyaltyEarn failed for ${txId}:`, (err as Error).message)
  }
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
      select: { id: true, status: true, customerId: true, totalCents: true, concept: { select: { slug: true, tenantId: true } } },
    })
    if (!order || !order.customerId || order.status !== 'completed') return null
    const tenantId = order.concept.tenantId
    const settings = await loadLoyaltySettings(tenantId)
    const points = await calculatePointsEarned(order.totalCents, tenantId)
    const result = await creditPoints({
      customerId: order.customerId,
      points,
      orderId: order.id,
      description: `${ORDER_EARN_PREFIX}${points} pts — order #${order.id.slice(0, 8)} completed`,
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
 * customer's balance; points are rounded up to cover a capped discount exactly.
 */
export async function quoteRedemption(args: {
  customerId: string
  requestedPoints: number
  tenantId: string | null
  capCents: number
}): Promise<RedemptionQuote> {
  const settings = await loadLoyaltySettings(args.tenantId)
  const value = settings['loyalty.point_value_cents'] || POINT_VALUE_CENTS
  const zero = { points: 0, discountCents: 0, pointValueCents: value }
  const requested = Math.max(0, Math.floor(args.requestedPoints))
  if (requested === 0 || args.capCents <= 0) return zero

  const min = settings['loyalty.min_redeem_points'] ?? 0
  if (requested < min) {
    throw new AppError('LOYALTY_BELOW_MINIMUM', `At least ${min} points are needed to redeem`, 400)
  }
  const account = await prisma.loyaltyAccount.findUnique({ where: { customerId: args.customerId }, select: { pointsBalance: true } })
  const available = account?.pointsBalance ?? 0
  if (available < min) {
    throw new AppError('LOYALTY_BELOW_MINIMUM', `At least ${min} points are needed to redeem`, 400)
  }
  const usable = Math.min(requested, available)
  const discountCents = Math.min(await calculatePointsValue(usable, args.tenantId), args.capCents)
  const points = Math.min(usable, Math.ceil(discountCents / value))
  return { points, discountCents, pointValueCents: value }
}

/**
 * Take quoted points for an order whose bill ALREADY excludes the discount.
 * Atomic on the balance; records the redeem transaction, adds the discount to
 * order.discountCents (the order posting books it as contra-revenue, the
 * redeem posting discharges the liability against it) and books the
 * redemption. Returns false when the balance moved and nothing was taken —
 * the caller must then put the discount back on the bill.
 */
export async function claimRedemption(args: { customerId: string; orderId: string; quote: RedemptionQuote }): Promise<boolean> {
  const { customerId, orderId, quote } = args
  if (quote.points <= 0 || quote.discountCents <= 0) return false
  const txId = await prisma.$transaction(async (tx) => {
    const took = await tx.loyaltyAccount.updateMany({
      where: { customerId, pointsBalance: { gte: quote.points } },
      data: { pointsBalance: { decrement: quote.points } },
    })
    if (took.count === 0) return null
    const account = await tx.loyaltyAccount.findUniqueOrThrow({ where: { customerId }, select: { id: true } })
    const ltx = await tx.loyaltyTransaction.create({
      data: {
        loyaltyAccountId: account.id,
        orderId,
        type: 'redeem',
        pointsDelta: -quote.points,
        description: `Redeemed ${quote.points} pts for PKR ${(quote.discountCents / 100).toFixed(2)} off order #${orderId.slice(0, 8)}`,
      },
    })
    await tx.order.update({ where: { id: orderId }, data: { discountCents: { increment: quote.discountCents } } })
    return ltx.id
  })
  if (!txId) return false
  try {
    const { postLoyaltyRedeem } = await import('../accounting/loyaltyPosting.js')
    const r = await postLoyaltyRedeem(txId)
    if (!r.posted && r.reason) console.warn(`[loyalty] redeem ${txId} not booked: ${r.reason}`)
  } catch (err) {
    console.error(`[loyalty] postLoyaltyRedeem failed for ${txId}:`, (err as Error).message)
  }
  return true
}

/** Lower an order's bill (and what is still pending on it) by `cents`, or raise it back with a negative amount. */
export async function adjustOrderBill(orderId: string, cents: number): Promise<void> {
  if (cents === 0) return
  await prisma.order.update({ where: { id: orderId }, data: { totalCents: { decrement: cents } } })
  const pending = await prisma.payment.findMany({ where: { orderId, status: 'pending' }, orderBy: { createdAt: 'asc' }, select: { id: true, amountCents: true } })
  if (cents < 0) {
    if (pending[0]) await prisma.payment.update({ where: { id: pending[0].id }, data: { amountCents: { increment: -cents } } })
    return
  }
  let left = cents
  for (const p of pending) {
    if (left <= 0) break
    const take = Math.min(left, p.amountCents)
    if (take > 0) await prisma.payment.update({ where: { id: p.id }, data: { amountCents: { decrement: take } } })
    left -= take
  }
}

/**
 * Redeem points against an existing, still-open order of this customer
 * (POST /loyalty/redeem). Once per order. The bill and the pending payment
 * come down by the discount — the old endpoint only raised discountCents and
 * left the guest owing the full amount.
 */
export async function redeemPointsOnOrder(args: { customerId: string; orderId: string; points: number }) {
  const order = await prisma.order.findFirst({
    where: { id: args.orderId, customerId: args.customerId, deletedAt: null },
    select: { id: true, status: true, totalCents: true, concept: { select: { tenantId: true } } },
  })
  if (!order) throw new NotFoundError('Order', args.orderId)
  if (['completed', 'cancelled', 'rejected', 'refunded'].includes(order.status)) {
    throw new AppError('ORDER_NOT_OPEN', 'That order is already closed — points cannot be redeemed against it.', 422)
  }
  const already = await prisma.loyaltyTransaction.findFirst({ where: { orderId: order.id, type: 'redeem' }, select: { id: true } })
  if (already) throw new AppError('ALREADY_REDEEMED', 'Points have already been redeemed on this order.', 409)

  const quote = await quoteRedemption({
    customerId: args.customerId,
    requestedPoints: args.points,
    tenantId: order.concept.tenantId,
    capCents: order.totalCents,
  })
  if (quote.points === 0) throw new AppError('INSUFFICIENT_POINTS', 'Not enough points', 400)
  const ok = await claimRedemption({ customerId: args.customerId, orderId: order.id, quote })
  if (!ok) throw new AppError('INSUFFICIENT_POINTS', 'Not enough points', 400)
  await adjustOrderBill(order.id, quote.discountCents)
  const account = await prisma.loyaltyAccount.findUnique({ where: { customerId: args.customerId }, select: { pointsBalance: true } })
  return { pointsRedeemed: quote.points, discountCents: quote.discountCents, newBalance: account?.pointsBalance ?? 0 }
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
 * Write the tier the customer has unlocked at `tenantId` onto the account so
 * the perk lookups (lib/tierPerks.ts) and the admin member counts see it.
 * Tiers only move up here; a paid tier assigned by staff is never overwritten.
 * One account spans companies, so the stored tier is the one earned at the
 * company of the latest completed order (report: a per-company tier table).
 */
export async function syncTier(customerId: string, tenantId: string): Promise<string | null> {
  const status = await tierStatus(customerId, tenantId)
  const account = await prisma.loyaltyAccount.findUnique({ where: { customerId }, select: { id: true, tier: true } })
  if (!account) return null
  const held = await prisma.tierConfig.findFirst({ where: { tenantId, tier: account.tier }, select: { isPaid: true, rank: true } })
  if (account.tier === status.tier.slug || held?.isPaid || (held && held.rank >= status.tier.rank)) return account.tier
  await prisma.loyaltyAccount.update({ where: { id: account.id }, data: { tier: status.tier.slug } })
  return status.tier.slug
}
