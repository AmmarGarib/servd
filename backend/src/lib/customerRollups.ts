// Cross-module customer rollup maintenance.
//
// Many features need to know things like "how many no-shows?", "have they
// complained recently?", "what's their average review?" without joining four
// tables on every render. We denormalize these on Customer and bump them
// from the relevant write paths.
//
// Idempotency: each function reads the truth from the underlying table, so
// re-running a bump after a crash is safe — values converge to the truth.

import type { PrismaClient } from '@prisma/client'
import { prisma as defaultPrisma } from './prisma.js'
import { realCompanyOrderWhere } from './testCompany.js'

type Tx = PrismaClient | Parameters<Parameters<PrismaClient['$transaction']>[0]>[0]

/**
 * Recompute and write the rollups for one customer based on the source-of-truth
 * tables. Cheap (a handful of indexed counts/aggregates), called
 * fire-and-forget from status-change handlers.
 *
 * firstOrderAt / lastOrderAt / totalSpentCents were previously declared on
 * Customer and read in several places but never written by anything, so they
 * stayed NULL and 0 for every customer in the system. The consequences were
 * not cosmetic:
 *
 *   - The referral reward worker selects on `firstOrderAt: { not: null }`, so
 *     it matched nothing and NO referral bonus was ever paid — to either side.
 *     The /account referrals box showed every referral as forever "pending".
 *   - The first-order welcome message never fired.
 *   - The activation nag selects on `firstOrderAt: null`, which was true for
 *     everyone, so customers who had already ordered kept being told to place
 *     their first order.
 *   - The lapsed and at-risk CRM segments compare against lastOrderAt, and a
 *     NULL never satisfies `<`, so both were permanently empty.
 *   - The customer list showed every customer as having spent zero.
 *
 * They are computed here rather than incremented at the till, so a re-run after
 * a crash still converges on the truth, exactly like the other rollups.
 */
export async function recomputeCustomerRollups(
  customerId: string,
  tx: Tx = defaultPrisma,
): Promise<void> {
  const [noShows, complaints, reviewAgg, lastSeated, orderAgg, firstOrder] = await Promise.all([
    tx.reservation.aggregate({
      where: { customerId, status: 'no_show' },
      _count: { _all: true },
      _max: { updatedAt: true },
    }),
    tx.orderComplaint.aggregate({
      where: { customerId, kind: 'complaint' }, // ban appeals are not complaints
      _count: { _all: true },
      _max: { createdAt: true },
    }),
    tx.orderReview.aggregate({
      where: { customerId },
      _count: { _all: true },
      _max: { createdAt: true },
      _avg: { rating: true },
    }),
    tx.reservation.findFirst({
      where: { customerId, seatedAt: { not: null } },
      select: { seatedAt: true },
      orderBy: { seatedAt: 'desc' },
    }),
    // Order history. Only COMPLETED orders count: a cancelled or rejected
    // order is not a visit and its total is not revenue, and "completed their
    // first order" is what the referral reward is supposed to mean.
    // A test company's orders never count (lib/testCompany.ts — fr-4).
    tx.order.aggregate({
      where: { customerId, status: 'completed', deletedAt: null, ...realCompanyOrderWhere() },
      _count: { _all: true },
      _sum: { totalCents: true },
      _max: { completedAt: true },
    }),
    tx.order.findFirst({
      where: { customerId, status: 'completed', deletedAt: null, ...realCompanyOrderWhere() },
      select: { completedAt: true },
      orderBy: { completedAt: 'asc' },
    }),
  ])

  const lastOrder = orderAgg._max.completedAt ?? null

  const lastVisitAt =
    lastOrder && lastSeated?.seatedAt
      ? (lastOrder > lastSeated.seatedAt ? lastOrder : lastSeated.seatedAt)
      : (lastOrder ?? lastSeated?.seatedAt ?? null)

  await tx.customer.update({
    where: { id: customerId },
    data: {
      noShowCount:     noShows._count._all,
      lastNoShowAt:    noShows._max.updatedAt,
      complaintCount:  complaints._count._all,
      lastComplaintAt: complaints._max.createdAt,
      reviewCount:     reviewAgg._count._all,
      lastReviewedAt:  reviewAgg._max.createdAt,
      avgReviewRating: reviewAgg._avg.rating,
      lastVisitAt,
      // These three were declared on Customer and read in half a dozen places
      // — the referral reward, the first-order welcome trigger, the "never
      // ordered" activation nag, the lapsed/at-risk CRM segments, the customer
      // list's spend column — but nothing ever wrote them. See the note above
      // recomputeCustomerRollups.
      firstOrderAt:    firstOrder?.completedAt ?? null,
      lastOrderAt:     lastOrder,
      totalSpentCents: orderAgg._sum.totalCents ?? 0,
    },
  })
}

/**
 * Fire-and-forget rollup refresh. Logs but doesn't throw — never let a
 * rollup failure break a real customer-facing flow.
 */
export function bumpCustomerRollups(customerId: string | null | undefined): void {
  if (!customerId) return
  recomputeCustomerRollups(customerId).catch((err: Error) => {
    console.warn(`[customerRollups] bump failed for ${customerId}:`, err.message)
  })
}
