// Night audit types (owner, 2026-10-16; SALES module only). Contract: ./README.md.

import type { CloseCheckDb, CloseProblem, CloseCheckSeverity } from '../accounting/closeCheckTypes.js'

export type { CloseProblem }

/** 'night' = the same-night run (open → audited); 'settlement' = audited → closed. */
export type NightPhase = 'night' | 'settlement'

export interface NightCheckContext {
  db: CloseCheckDb
  /** The company being audited — the only company a check may read. */
  tenantId: string
  /** The Karachi business date 'YYYY-MM-DD'. */
  day: string
  /** 00:00:00.000 PKT of `day`. */
  from: Date
  /** 23:59:59.999 PKT of `day`. */
  to: Date
  /** Per-run memo (the backfill dry runs). */
  cache: Map<string, Promise<unknown>>
}

export interface NightCheck {
  key: string
  phase: NightPhase
  severity: CloseCheckSeverity
  /** Only the CEO pushes past an overridable block, with a reason. */
  overridable: boolean
  run(ctx: NightCheckContext): Promise<CloseProblem | null>
}

/** A block as stored on the row / shown on the calendar. */
export interface CheckLine { key: string; title: string; count: number; cents?: number }

export interface LastCheck {
  phase: NightPhase
  at: string
  blocks: CheckLine[]
  warnings: Array<{ key: string; title: string; count: number }>
}

export interface HistoryEntry {
  at: string
  byId: string | null
  action: string
  from: string | null
  to: string | null
  reason?: string
  keys?: string[]
}

export const NIGHT_AUDIT_STATUSES = ['open', 'audited', 'closed'] as const
export type NightAuditStatus = (typeof NIGHT_AUDIT_STATUSES)[number]

/** Who may run the night audit and settle a day (finance runs, the CEO overrides). */
export const NIGHT_AUDIT_RUNNERS = ['admin', 'finance'] as const
/** The minimum length of an override / reopen / settings reason. */
export const MIN_REASON = 10
