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

type Tx = PrismaClient | Parameters<Parameters<PrismaClient['$transaction']>[0]>[0]

/**
 * Recompute and write the rollups for one customer based on the source-of-truth
 * tables. Cheap (3-4 indexed counts/aggregates), called fire-and-forget from
 * status-change handlers.
 */
export async function recomputeCustomerRollups(
  customerId: string,
  tx: Tx = defaultPrisma,
): Promise<void> {
  const [noShows, complaints, reviewAgg, lastSeated] = await Promise.all([
    tx.reservation.aggregate({
      where: { customerId, status: 'no_show' },
      _count: { _all: true },
      _max: { updatedAt: true },
    }),
    tx.orderComplaint.aggregate({
      where: { customerId },
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
  ])

  const lastOrder = (await tx.customer.findUnique({
    where: { id: customerId },
    select: { lastOrderAt: true },
  }))?.lastOrderAt ?? null

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
