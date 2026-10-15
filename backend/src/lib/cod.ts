// Cash on delivery — the ONE definition (H5, Delivery & customers).
//
// Read by GET /pos/cod-due (the rider pay-in screen), GET /reconciliation/cod
// (finance), salesByTender (reports), the custody worker and the rider's
// shift-off. Nothing else classifies COD money: a second copy of "what is COD
// and when is it overdue" is how two screens came to disagree.
//
//   • COD money = a CASH payment still PENDING (not yet in a drawer), with an
//     amount (a bill a gift card / wallet covered in full owes nothing,
//     ONL-R2-06), on a COMPLETED order that did not come from the till.
//   • Its status:
//       at_counter — a pickup / takeout (e.g. WhatsApp "pay at the counter")
//                    or an order no rider carried. Never a rider status, a
//                    rider debt or a rider-overdue flag.
//       rider_owes — finance booked it as owed by the rider (1351, or the
//                    inter-company 'cod' transfer for a fleet rider —
//                    accounting/codPosting.ts).
//       overdue    — COD_PAY_IN_HOURS or more since the drop-off (else the
//                    completion) and still not handed in.
//       with_rider — otherwise.

import type { Prisma, PrismaClient } from '@prisma/client'
import { toCents } from './money.js'

type Db = PrismaClient | Prisma.TransactionClient

/** Hours a rider may hold delivered COD cash before it is overdue (owner default; a per-company setting comes later). */
export const COD_PAY_IN_HOURS = 12

export type CodStatus = 'with_rider' | 'overdue' | 'rider_owes' | 'at_counter'
export const COD_STATUSES: readonly CodStatus[] = ['with_rider', 'overdue', 'rider_owes', 'at_counter'] as const

/**
 * Payments that are COD money not yet handed in, on orders whose brand matches
 * `scope` (pass the caller's company filter, e.g. `{ ...await scopeTenantWhere(req, 'read') }`;
 * add `deletedAt: null` there to hide a deleted brand's rows). `{}` = every company
 * (system paths only: the custody worker per company, a rider's own cash).
 */
export function codDueWhere(scope: Prisma.ConceptWhereInput): Prisma.PaymentWhereInput {
  return {
    method: 'cash',
    status: 'pending',
    amountCents: { gt: 0 },
    order: { source: { not: 'pos' }, status: 'completed', concept: scope },
  }
}

/** True when COD money was carried by a rider (a delivery with a rider) — the only rows that can be a rider's. */
export function isRiderCod(o: { fulfilmentType: string; riderId: string | null }): boolean {
  return o.fulfilmentType === 'delivery' && !!o.riderId
}

/** When the rider's pay-in clock starts: the drop-off, else the completion, else the payment row. */
export function codSince(
  p: { createdAt: Date },
  o: { deliveredAt?: Date | null; completedAt: Date | null },
): Date {
  return o.deliveredAt ?? o.completedAt ?? p.createdAt
}

/** Hours (one decimal, never negative) since the pay-in clock started. */
export function codHoursSince(
  p: { createdAt: Date },
  o: { deliveredAt?: Date | null; completedAt: Date | null },
  now: Date = new Date(),
): number {
  const since = codSince(p, o)
  return Math.max(0, Math.floor(((now.getTime() - since.getTime()) / 3_600_000) * 10) / 10)
}

/** The one status rule (see the header). */
export function codStatusOf(
  p: { codRiderDebtAt: Date | null; createdAt: Date },
  o: { fulfilmentType: string; riderId: string | null; deliveredAt?: Date | null; completedAt: Date | null },
  now: Date = new Date(),
): CodStatus {
  if (!isRiderCod(o)) return 'at_counter'
  if (p.codRiderDebtAt) return 'rider_owes'
  return codHoursSince(p, o, now) >= COD_PAY_IN_HOURS ? 'overdue' : 'with_rider'
}

/**
 * The COD cash a rider is holding right now (paisa): every delivered COD of
 * theirs not yet handed in, booked as owed or not, across companies (a fleet
 * rider carries other companies' orders). Used by the rider's shift-off.
 */
export async function riderCashHeldCents(db: Db, riderId: string): Promise<number> {
  if (!riderId) return 0
  const where = codDueWhere({})
  const agg = await db.payment.aggregate({
    where: { ...where, order: { ...(where.order as Prisma.OrderWhereInput), fulfilmentType: 'delivery', riderId } },
    _sum: { amountCents: true },
  })
  return toCents(agg._sum.amountCents ?? 0)
}
