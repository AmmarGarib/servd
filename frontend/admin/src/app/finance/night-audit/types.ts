// Night audit — wire types, coded to the contract in
// backend/src/modules/nightAudit/README.md (GET /accounting/night-audit*).

export interface CloseProblem {
  key: string
  severity: 'block' | 'warn'
  title: string
  detail: string
  count: number
  cents?: number
  months?: string[]
  link: string
  fix?: { method: 'POST'; path: string; label: string }
  overridable: boolean
}

export type DayStatus = 'open' | 'audited' | 'closed'
export type ClosedVia = 'auto' | 'manual' | 'override'

export interface CheckLine { key: string; title: string; count: number; cents?: number }

export interface CalendarDay {
  day: string
  active: boolean
  future: boolean
  isToday: boolean
  inClosedPeriod: boolean
  beforeStart: boolean
  status: DayStatus
  locked: boolean
  auditedAt: string | null
  auditedByName: string | null
  closedAt: string | null
  closedByName: string | null
  closedVia: ClosedVia | null
  overridden: boolean
  reopenCount: number
  lastCheck: { phase: 'night' | 'settlement'; at: string; blocks: CheckLine[]; warnings: Array<{ key: string; title: string; count: number }> } | null
}

export interface MonthState {
  tenantId: string
  month: string
  today: string
  startDay: string | null
  periodLockedThrough: string | null
  canRun: boolean
  canOverride: boolean
  summary: { activeDays: number; closed: number; awaitingSettlement: number; open: number; overdue: number }
  days: CalendarDay[]
}

export interface DayChecks {
  phase: 'night' | 'settlement'
  problems: CloseProblem[]
  blocks: CloseProblem[]
  warnings: CloseProblem[]
  ready: boolean
}

export interface HistoryEntry {
  at: string
  byId: string | null
  byName: string | null
  action: string
  from: string | null
  to: string | null
  reason?: string
  keys?: string[]
}

export interface DailyReport {
  version: 1
  tenantId: string
  companyName: string
  day: string
  generatedAt: string
  generatedById: string | null
  sales: {
    orders: number; grossCents: number; discountCents: number; netSalesCents: number; taxCents: number
    serviceChargeCents: number; deliveryFeeCents: number; tipCents: number; totalCents: number
    byBrand: Array<{ conceptId: string; name: string; orders: number; netSalesCents: number; taxCents: number; totalCents: number }>
    byChannel: Array<{ source: string; orders: number; totalCents: number }>
    byFulfilment: Array<{ type: string; orders: number; totalCents: number }>
  }
  tenders: Array<{ method: string; count: number; paidCents: number; refundedCents: number; pendingCents: number }>
  cash: {
    shifts: Array<{
      shiftId: string; cashier: string; location: string | null; openedAt: string; closedAt: string | null
      openingFloatCents: number; expectedCents: number; countedCents: number | null; varianceCents: number | null
      depositDropCents: number; varianceFlag: 'open' | 'acknowledged' | 'resolved' | null
    }>
    payoutsCents: number; dropsCents: number; totalVarianceCents: number
  }
  voids: {
    itemVoids: number; itemVoidCents: number; orderCancels: number; orderCancelCents: number; comps: number; compCents: number
    byApprover: Array<{ userId: string; name: string; count: number; cents: number }>
  }
  discounts: { totalCents: number; promoCents: number; manualCents: number; loyaltyRedeemedCents: number; byReason: Array<{ reason: string; cents: number }> }
  refunds: { count: number; cents: number; byMethod: Array<{ method: string; cents: number }> }
  preBills: { printed: number; orphaned: number; finalLower: number }
  cod: { delivered: number; collectedCents: number; pendingCents: number }
  raast: { byStatus: Array<{ status: string; count: number; cents: number }> }
  card: { grossCents: number; byUnit: Array<{ unit: string; cents: number; settled: boolean }> }
  exceptions: Array<{ kind: string; count: number; cents: number }>
  checks: { night: CloseProblem[]; settlement: CloseProblem[] }
  closing?: { at: string; card: { settledCents: number; feeCents: number }; bank: { unmatchedLines: number }; raast: { matched: number; open: number } }
  previousRuns?: unknown[]
}

export interface DayDetail {
  tenantId: string
  day: string
  status: DayStatus
  locked: boolean
  active: boolean
  inClosedPeriod: boolean
  startDay: string | null
  canRun: boolean
  canOverride: boolean
  canReopen: boolean
  auditedAt: string | null
  auditedBy: { id: string; name: string } | null
  closedAt: string | null
  closedBy: { id: string; name: string } | null
  closedVia: ClosedVia | null
  nightOverrides: CheckLine[] | null
  nightOverrideReason: string | null
  settlementOverrides: CheckLine[] | null
  settlementOverrideReason: string | null
  checks: DayChecks | null
  earlierOpenDays: string[]
  history: HistoryEntry[]
  report: DailyReport | null
}

export const MIN_REASON = 10

/** [year, month 1-12, day] of a 'YYYY-MM[-DD]' string. */
export function ymd(s: string): [number, number, number] {
  const p = s.split('-').map(Number)
  return [p[0] ?? 1970, p[1] ?? 1, p[2] ?? 1]
}

export function fmtWhen(iso: string | null | undefined): string {
  if (!iso) return ''
  return new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Karachi', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}

export function fmtDayLong(day: string): string {
  const [y, m, d] = ymd(day)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
}

export function monthLabel(month: string): string {
  const [y, m] = ymd(month)
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-GB', { timeZone: 'UTC', month: 'long', year: 'numeric' })
}

export function shiftMonth(month: string, delta: number): string {
  const [y, m] = ymd(month)
  const d = new Date(Date.UTC(y, m - 1 + delta, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}
