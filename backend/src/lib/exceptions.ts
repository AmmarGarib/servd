// Exception-flag central helper.
//
// Anywhere in the codebase calls `flagException(...)` when a control trigger
// fires. The owner Inbox queries `ExceptionFlag` rows and shows only what
// needs eyes — clean operations are silent.
//
// Failure isolation: flagging never blocks the underlying mutation. Errors
// log a warning and return null so the caller's transaction continues.

import { prisma } from './prisma.js'
import type { ExceptionSeverity } from '@prisma/client'

export type ExceptionKind =
  | 'receiving_variance'    // GRN qty differs from PO qty above threshold
  | 'price_drift'           // supplier invoice unit cost differs from PO above threshold
  | 'short_shipment'        // received qty < ordered qty (subset of receiving_variance, urgent)
  | 'yield_low'             // PrepBatch actual yield << expected
  | 'shrinkage'             // PhysicalCount variance > threshold
  | 'shrinkage_trend'       // cumulative shrinkage on an item over weeks
  | 'consecutive_voids'     // same cashier voided 3+ orders in last hour
  | 'high_value_void'       // single void above policy threshold
  | 'comp_above_threshold'  // comp above owner-notify threshold
  | 'refund_above_threshold'
  | 'cash_variance'         // shift-close cash differs from expected
  | 'route_variance'        // rider GPS path differs from expected route
  | 'lost_package'          // rider marked delivered but customer disputes
  | 'pii_export'            // bulk customer-list export
  | 'self_approval'         // user tried to approve their own creation
  | 'ghost_employee'        // payroll line for user with zero clock logs
  | 'manual_journal'        // manual JE entry posted (every one is reviewable)
  | 'period_reopened'       // period lock removed
  | 'wage_change'           // wage rate edited
  | 'food_safety_temperature' // a temperature check outside its limit

export interface FlagInput {
  kind:        ExceptionKind
  severity?:   ExceptionSeverity                       // default: 'medium'
  title:       string
  description: string
  entityType?: string                                  // 'Order' | 'Shift' | 'GoodsReceipt' | …
  entityId?:   string
  metadata?:   Record<string, unknown>
  conceptId?:  string | null
  actorId?:    string | null                           // user who triggered (if any)
  amountCents?: number | null                          // monetary impact (if any)
}

export async function flagException(input: FlagInput): Promise<{ id: string } | null> {
  try {
    const row = await prisma.exceptionFlag.create({
      data: {
        kind: input.kind,
        severity: input.severity ?? 'medium',
        title: input.title,
        description: input.description,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        metadata: (input.metadata ?? null) as never,
        conceptId: input.conceptId ?? null,
        actorId: input.actorId ?? null,
        amountCents: input.amountCents ?? null,
      },
      select: { id: true },
    })
    return row
  } catch (err) {
    console.warn(`[exceptions] flag failed for ${input.kind}:`, (err as Error).message)
    return null
  }
}

// Acknowledge — owner saw the flag, working on it. Doesn't close the loop.
export async function acknowledgeException(id: string, userId: string): Promise<void> {
  await prisma.exceptionFlag.update({
    where: { id },
    data: { status: 'acknowledged', acknowledgedById: userId, acknowledgedAt: new Date() },
  })
}

// Resolve — flag closed with a resolution note. The flag stays in the DB
// for audit; status filter excludes it from the open inbox.
export async function resolveException(id: string, userId: string, resolution: string): Promise<void> {
  await prisma.exceptionFlag.update({
    where: { id },
    data: { status: 'resolved', resolvedById: userId, resolvedAt: new Date(), resolution },
  })
}
