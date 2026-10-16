// The period-close checklist contract (finance wave B, people plan: ONE
// checklist with a CEO override).
//
// Closing a company's books through a date runs every CloseCheck for THAT
// company only (another company's open till or unlocked payroll never blocks
// it). Each check answers one problem or null when clear:
//   - severity 'block' stops the close (409 CLOSE_NOT_READY) unless it is
//     `overridable` and the CEO acknowledges it with a reason — recorded on
//     PeriodLock.overrides, audited and flagged 'period_close_override';
//   - 'warn' is shown and never stops the close.
// Checks live with the module that owns the data (hr/closeChecks.ts,
// fixedAssets/closeCheck.ts, …); accounting/closeChecks.ts lists them all in
// CLOSE_CHECKS. A check that throws becomes a 'check_failed' block naming it.
// Every query a check runs is filtered on ctx.tenantId.

import type { Prisma, PrismaClient } from '@prisma/client'

export type CloseCheckDb = Prisma.TransactionClient | PrismaClient

export type CloseCheckSeverity = 'block' | 'warn'

export interface CloseCheckContext {
  db: CloseCheckDb
  /** The company being closed — the only company a check may read. */
  tenantId: string
  /** The company's current lock (inclusive, PKT end of day), null when it was never closed. */
  prevLock: Date | null
  /** The lock being asked for (inclusive, PKT end of day). */
  newLock: Date
  /** The PKT months 'YYYY-MM' the close covers (after prevLock up to newLock). */
  months: string[]
  /** True when the range crosses the company's fiscal year end (fiscalYear.ts isFiscalYearEndInRange). */
  isYearEnd: boolean
  /**
   * Per-run memo shared by the checks of ONE checklist run (e.g. the backfill
   * dry run that unposted_orders and posting_failed both read). closeChecklist
   * always sets it; a check must still work without it.
   */
  cache?: Map<string, Promise<unknown>>
}

export interface CloseProblem {
  /** The check's key — what the CEO acknowledges (`acknowledge.keys`). */
  key: string
  severity: CloseCheckSeverity
  title: string
  detail: string
  /** How many documents / rows are behind it. */
  count: number
  /** Money involved, in paisa, when it has one. */
  cents?: number
  /** The months it concerns ('YYYY-MM'), when it is per month. */
  months?: string[]
  /** The admin page that shows the rows. */
  link: string
  /** A one-click fix the checklist offers (the route's own guard decides). */
  fix?: { method: 'POST'; path: string; label: string }
  overridable: boolean
}

export interface CloseCheck {
  key: string
  severity: CloseCheckSeverity
  overridable: boolean
  run(ctx: CloseCheckContext): Promise<CloseProblem | null>
}
