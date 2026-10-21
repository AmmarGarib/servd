'use client'
// The days a full & final's salary pays for (owner, 2026-10-21: "Full and
// final form does not show number of days worked for which payment /
// settlement is being made"). Read-only: it is what "Calculate" worked out
// (backend POST /hr/final-settlement/calculate → payBasis, stored on the
// settlement as data._payBasis), one line per month.

import { rs } from '../../lib/hr'

/** One month a settlement pays salary for (backend hr/logic.ts SettlementPayBasis). */
export interface SettlementPayBasis {
  period: string; from: string; to: string
  daysInMonth: number; employedDays: number; absentDays: number; unpaidLeaveDays: number; paidDays: number
  dailyRateCents: number; monthlyGrossCents: number; salaryCents: number
}

export function payBasisOf(v: unknown): SettlementPayBasis[] {
  return Array.isArray(v) ? (v as SettlementPayBasis[]).filter((b) => b && typeof b.period === 'string' && typeof b.paidDays === 'number') : []
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
function rangeText(from: string, to: string): string {
  const [y, m, d1] = from.split('-').map(Number)
  const d2 = Number(to.slice(8, 10))
  return `${d1 === d2 ? d1 : `${d1}–${d2}`} ${MONTHS[(m ?? 1) - 1]} ${y}`
}

/** "Salary for 1–3 Sep 2026: 3 days employed − 0 absent − 0 unpaid leave = 3 paid days of 30 → Rs 9,000" */
export function payBasisLine(b: SettlementPayBasis): string {
  return `Salary for ${rangeText(b.from, b.to)}: ${b.employedDays} days employed − ${b.absentDays} absent − ${b.unpaidLeaveDays} unpaid leave = ${b.paidDays} paid days of ${b.daysInMonth} → ${rs(b.salaryCents)}`
}

export function FnfPayBasis({ basis, salaryPayable }: { basis: SettlementPayBasis[]; salaryPayable: unknown }) {
  const worked = basis.reduce((s, b) => s + b.salaryCents, 0)
  // HR typed a different salary after "Calculate": the days no longer explain it.
  const edited = typeof salaryPayable === 'number' && salaryPayable !== worked
  return (
    <div className="rounded-xl p-3 text-xs space-y-1" style={{ background: 'rgb(var(--fg-rgb) / 0.04)' }}>
      <p className="text-[10px] font-bold uppercase tracking-wider text-white/40">Days paid</p>
      {basis.length === 0
        ? <p className="text-white/60">No salary days in this settlement — payroll has already paid up to the last working day.</p>
        : basis.map((b) => <p key={b.period} className="text-white/80">{payBasisLine(b)}{edited ? ' (salary edited by hand)' : ''}</p>)}
      <p className="text-white/45">Weekly offs, holidays and paid leave are paid days; absences and unpaid leave are not.</p>
    </div>
  )
}
