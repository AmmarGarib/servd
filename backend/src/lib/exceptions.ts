// Exception-flag central helper.
//
// Anywhere in the codebase calls `flagException(...)` when a control trigger
// fires. The owner Inbox queries `ExceptionFlag` rows and shows only what
// needs eyes — clean operations are silent.
//
// Failure isolation: flagging never blocks the underlying mutation. Errors
// log a warning and return null so the caller's transaction continues.
//
// Company scope (2026-09-27): every flag belongs to ONE company
// (ExceptionFlag.tenantId) and the inbox only ever shows the operator's
// companies' flags. Pass `tenantId` resolved from the flagged entity's own
// company (order → concept.tenantId, shift → shiftTenantId, bill →
// supplier.tenantId, manual action → the operator's active company). It is
// optional in the type only while the remaining call sites migrate: a flag
// without it falls back to its brand's company, and failing that is written
// company-less — invisible in every inbox — with a warning naming the caller.

import { prisma } from './prisma.js'
import type { ExceptionSeverity } from '@prisma/client'
import { tenantForConcept } from './setup-config.js'
import type { TenantIdWhere } from './tenantScope.js'

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
  // Till overrides (FOH-R2-01 / FOH-R2-03). ExceptionFlag.kind is a plain
  // String column, so these need no migration.
  | 'manager_pin_failed'    // a sender (or one order) hit the wrong-manager-PIN limit — overrides locked
  | 'discount_above_cap'    // a POS discount above the cashier's cap (authorised or not, always reviewed)
  | 'price_override'        // POS line items priced away from the menu
  | 'ghost_employee'        // payroll line for user with zero clock logs
  | 'manual_journal'        // manual JE entry posted (every one is reviewable)
  | 'period_reopened'       // period lock removed
  | 'wage_change'           // wage rate edited
  | 'food_safety_temperature' // a temperature check outside its limit
  | 'posting_failed'        // a ledger posting was refused (e.g. a till close in a locked period)
  // POS connector (backend/src/connectors/alerts.ts, spec §9.3)
  | 'fiscal_failed'          // a fiscal document gave up retrying
  | 'fiscal_rejected'        // the fiscal POS rejected a document
  | 'fiscal_auth'            // the fiscal POS refused servd's API key
  | 'fiscal_manual_refund'   // a refund must be filed by hand (sale filed directly pre-cutover, or the POS cannot file refunds)
  | 'terminal_void_failed'   // card charged, servd refused it, and the automatic reversal failed
  | 'terminal_unreconciled'  // the card outcome disagrees with what servd recorded, or unknown > 24 h

export interface FlagInput {
  /** The company the flagged entity belongs to. Pass it — see the header. */
  tenantId?:   string | null
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

/**
 * The company a flag is stamped with: the caller's tenantId, else (only when
 * the caller passed none) its brand's company. Null → a warning, because a
 * company-less flag is shown in no inbox.
 */
async function flagTenantId(input: FlagInput): Promise<string | null> {
  if (input.tenantId) return input.tenantId
  const viaBrand = input.tenantId === undefined ? await tenantForConcept(input.conceptId) : null
  if (viaBrand) return viaBrand
  const caller = new Error().stack?.split('\n')[3]?.trim() ?? 'unknown caller'
  console.warn(
    `[exceptions] ${input.kind} flag has no company (entity ${input.entityType ?? '-'}:${input.entityId ?? '-'}) — `
    + `it will be invisible in every inbox. Pass tenantId from the entity's company. ${caller}`,
  )
  return null
}

export async function flagException(input: FlagInput): Promise<{ id: string } | null> {
  try {
    const tenantId = await flagTenantId(input)
    const row = await prisma.exceptionFlag.create({
      data: {
        tenantId,
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
// `scope` is the operator's companies (scopeTenantWhere): a flag outside it
// is not touched and the call returns false (the route answers 404).
export async function acknowledgeException(id: string, userId: string, scope: TenantIdWhere): Promise<boolean> {
  const r = await prisma.exceptionFlag.updateMany({
    where: { id, ...scope },
    data: { status: 'acknowledged', acknowledgedById: userId, acknowledgedAt: new Date() },
  })
  return r.count > 0
}

// Resolve — flag closed with a resolution note. The flag stays in the DB
// for audit; status filter excludes it from the open inbox. Scoped as above.
export async function resolveException(id: string, userId: string, resolution: string, scope: TenantIdWhere): Promise<boolean> {
  const r = await prisma.exceptionFlag.updateMany({
    where: { id, ...scope },
    data: { status: 'resolved', resolvedById: userId, resolvedAt: new Date(), resolution },
  })
  return r.count > 0
}
