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
import { Prisma, type ExceptionSeverity } from '@prisma/client'
import { tenantForConcept } from './setup-config.js'
import type { TenantIdWhere } from './tenantScope.js'
import { MAX_MONEY_CENTS } from './money.js'

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
  // Raast QR (2026-10-12; connectors/raast, reconciliation/raast)
  | 'raast_unmatched'          // provisional Raast receipts not on a bank statement after N days (per bank account)
  | 'raast_unconfirmed'        // a cashier-typed Raast reference with no bank SMS (SMS matching ON)
  | 'raast_needs_attention'    // a Raast bill an SMS or a settle could not complete cleanly
  | 'raast_sms_unparsed'       // a listed bank sender's SMS matched no template
  | 'raast_sms_unmatched'      // a bank credit SMS no bill claimed
  | 'raast_statement_mismatch' // a statement line names a Raast reference but the amount differs
  | 'raast_debit_alert'        // money left a Raast receiving account
  // Kinds that were filed as a stand-in 'high_value_void' until 2026-10-12
  // (migration 20261012120000 re-kinds the old rows by title). A de-dup query
  // over one of them must match the stand-in too — see STAND_IN_KINDS.
  | 'tip_pool_outlier'       // one member takes over 40% of a tip pool of 3+ people
  | 'capex_over_budget'      // a CapEx project's commitments passed its budget envelope
  // Finance wave B (2026-10-14). Plain String column — no migration.
  // Fixed assets
  | 'depreciation_failed'        // the monthly depreciation run could not post an asset's month
  | 'capex_uncapitalised'        // CapEx paid for equipment that never reached the asset register
  | 'capex_advance_overdue'      // a CapEx supplier advance (1340) still not delivered past its date
  | 'capex_orphan_advance'       // a CapEx advance on 1340 that belongs to no live asset or project line
  | 'capex_prepaid_unscheduled'  // a prepaid CapEx/OpEx payment with no release schedule (legacy rows)
  | 'fixed_asset_gl_mismatch'    // the register and its ledger codes disagree, or a register code was posted to by hand
  | 'bill_equipment_override'    // a supplier bill line that looked like equipment was booked as an expense (finance override)
  | 'equipment_override'         // the same override anywhere other than a supplier bill (OpEx, petty cash …)
  // Food cost and stock
  | 'stock_shortfall'            // stock sold or used beyond what the lots held (cost estimated)
  | 'stock_unrecorded'           // an item counted or used with no receipt or opening cost on record
  | 'recipe_foreign_stock'       // a recipe draws an item of another company (skipped, never depleted)
  | 'stock_restore_failed'       // returning or wasting a cancelled / voided line's stock failed after commit
  | 'fifo_cutover_review'        // the FIFO cut-over met legacy bills it could not tie to receipts — the accountant reviews GRNI
  // People, close and inter-company
  | 'period_close_override'      // the CEO closed a period over a blocking close check
  | 'intercompany_mismatch'      // the two sides of a company pair's due-to / due-from disagree
  // Head office (D1; workers/headOfficeRecharge.ts). Plain String column — no migration.
  | 'recharge_missing'           // a head office's month is not recharged (not ready) on day 5 of the next month
  | 'recharge_drift'             // a recharged month's head-office cost moved after posting (a true-up is due)
  // Cash requests
  | 'cash_request_receipts_overdue' // a paid cash request past its due date with no receipt uploaded (H3: flagged, nothing booked)
  | 'stock_difference_queried'      // the CEO sent a waste / count difference back with a note (H20)
  | 'cash_advance_overdue'       // legacy (pre-H3): no longer raised; kept so old rows still read
  | 'cash_request_needs_review'  // legacy (pre-H3): no longer raised; kept so old rows still read
  // Delivery
  | 'delivery_code_rerouted'     // the hand-over code was sent to the rider's number (Emergency overrides)
  | 'food_returned'              // a rider brought a delivery back; the food was booked as waste
  | 'delivery_door_problem'      // a rider reported a problem at the door (refused, unreachable …)
  | 'cod_cash_overdue'           // delivered cash-on-delivery money not paid in by the rider in time
  | 'delivery_on_road_overdue'   // a delivery picked up hours ago, neither delivered nor returned
  // On-account clients and the till clearing account
  | 'on_account_card_revoked_used' // a revoked on-account QR card was scanned at the till
  | 'on_account_overdue'         // an on-account statement or invoice past its due date
  | 'on_account_unbilled'        // on-account charges booked but not on a statement for too long
  | 'till_clearing_unexpected'   // a 1110/1115 till-clearing line the cut-over rules do not explain
  // Tax
  | 'card_payout_unmatched'      // a card machine's sales with no matching bank payout
  | 'gift_card_breakage_held'    // a sold gift card expired but its breakage could not be booked yet
  // Attendance by work location (owner, 2026-10-15). Plain String column — no migration.
  | 'attendance_out_of_area'     // a punch outside the employee's work locations (or with no location) — allowed, flagged once a day
  // Night audit (owner, 2026-10-16; SALES module only — modules/nightAudit). Plain String column — no migration.
  | 'night_audit_override'       // the CEO ran / settled a sales day over its blocks, with a reason
  | 'night_audit_reopened'       // the CEO reopened a night-audited sales day
  | 'night_audit_pending'        // yesterday had sales and its night audit has not run (after 06:00 PKT)
  | 'backdated_sale_change'      // the CEO voided / comped / cancelled / reversed / credit-noted a bill of an earlier sales day
  // Cash vouchers (owner, 2026-10-16: 1357 retired). Plain String column — no migration.
  | 'cash_voucher_hold_unconverted' // a voucher still held on 1357 could not be booked as one expense entry — finance fixes it
  // Company-less suppliers → GS Foods, once (owner, 2026-10-16; procurement/companylessSuppliers.ts).
  | 'supplier_company_unassigned' // left company-less: it has records in another company — the CEO assigns it by hand

/**
 * The kind a flag was filed under before it had its own. A query that looks
 * for an OPEN flag of `kind` (to avoid raising it twice) matches these too,
 * so a flag raised before the re-kind is not raised again beside it.
 */
export const STAND_IN_KINDS: Partial<Record<ExceptionKind, ExceptionKind[]>> = {
  tip_pool_outlier:  ['high_value_void'],
  capex_over_budget: ['high_value_void'],
}

/** `kind` plus its stand-ins, for a de-dup query's `kind: { in }`. */
export function kindsMatching(kind: ExceptionKind): ExceptionKind[] {
  return [kind, ...(STAND_IN_KINDS[kind] ?? [])]
}

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
    // The ONE clamp on a flag's amount (a flag must never fail to save): a
    // finite amount is rounded to whole paisa and kept up to MAX_MONEY_CENTS;
    // only a non-finite or out-of-range figure is dropped (null).
    const a = input.amountCents
    const amountCents = a != null && Number.isFinite(a) && Math.abs(Math.round(a)) <= MAX_MONEY_CENTS ? Math.round(a) : null
    const row = await prisma.exceptionFlag.create({
      data: {
        tenantId,
        kind: input.kind,
        severity: input.severity ?? 'medium',
        title: input.title,
        description: input.description,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        metadata: input.metadata ? (input.metadata as Prisma.InputJsonObject) : Prisma.DbNull,
        conceptId: input.conceptId ?? null,
        actorId: input.actorId ?? null,
        amountCents,
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
    where: { id, status: { in: ['open', 'acknowledged'] }, ...scope },
    data: { status: 'acknowledged', acknowledgedById: userId, acknowledgedAt: new Date() },
  })
  return r.count > 0
}

/**
 * Flags about the BOOKS. Resolving one takes it off the period close (a
 * posting_failed flag is a close block), so only the CEO and finance with the
 * accounting module may resolve them (PATCH /crosschecks/exceptions/:id/resolve).
 */
export const LEDGER_FLAG_KINDS: ReadonlySet<string> = new Set([
  'posting_failed', 'manual_journal', 'fixed_asset_gl_mismatch', 'cash_voucher_hold_unconverted',
  'depreciation_failed', 'intercompany_mismatch',
])
/** Review flags about a person's own action: never resolved by that person (the CEO excepted). */
export const NO_SELF_RESOLVE_KINDS: ReadonlySet<string> = new Set(['manual_journal', 'fixed_asset_gl_mismatch'])

// Resolve — flag closed with a resolution note. The flag stays in the DB
// for audit; status filter excludes it from the open inbox. Scoped as above.
// Only an open or acknowledged flag is resolved (a dismissed or already
// resolved one is left as it is — the call returns false).
export async function resolveException(id: string, userId: string, resolution: string, scope: TenantIdWhere): Promise<boolean> {
  const r = await prisma.exceptionFlag.updateMany({
    where: { id, status: { in: ['open', 'acknowledged'] }, ...scope },
    data: { status: 'resolved', resolvedById: userId, resolvedAt: new Date(), resolution },
  })
  return r.count > 0
}
