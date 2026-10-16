// HR calculations. Pure functions over plain values — no database here — so
// each rule can be tested on its own and read in one place.
//
// All money is integer paisa. Rounding happens once per line, at the line.
//
// Rates that are a matter of law or company policy are SETTINGS, not
// constants: they change, they differ between provinces, and the HR team is
// the authority on them. Defaults are starting points, each marked where it
// needs confirming.
//
// decideRight (head office, D3) is the one exception: it reads hand-overs and
// head-office links, through lazy imports, so nothing here loads the database
// unless it is called.

import type { FastifyRequest } from 'fastify'

export interface HrSettings {
  // Pay basis (owner HR-1, 2026-10-16): a month's salary is divided by the
  // ACTUAL calendar days of that month (28–31) and paid for the days worked —
  // company policy, not a setting. The old `workingDaysPerMonth` divisor (26)
  // is retired: mergeSettings drops it from stored rows (the stored JSON is
  // left as it is) and nothing reads it.
  hoursPerDay: number
  /** OT multiplier when a request doesn't specify one. Sindh's shops &
   *  establishments law pays overtime at twice the ordinary rate — confirm. */
  otMultiplier: number
  eobi: {
    /** EOBI is compulsory from 10 employees; a smaller company can leave it
     *  off and payroll runs without it. */
    enabled: boolean
    employeePct: number   // spec: 1%
    employerPct: number   // spec: 5%
    /** What the percentages apply to. EOBI contributions are normally on the
     *  notified minimum wage, not actual salary — hence `fixed` by default. */
    base: 'fixed' | 'gross'
    fixedWageCents: number | null
  }
  sessi: { employerPct: number; wageCeilingCents: number | null }
  /** Every N lates in a month deduct one day. 0 = lates are never deducted. */
  latesPerDeductionDay: number
  lateGraceMinutes: number
  deductAbsences: boolean
  /** Leave year starts in this month (1 = January). */
  leaveYearStartMonth: number
  /** Paid leave balance is paid out in full & final. */
  encashLeaveOnExit: boolean
  employeeCodePrefix: string
  /** Gratuity paid at exit (accountant default H6) — see gratuityFor. */
  gratuity: GratuitySettings
}

/**
 * Gratuity at exit (accountant default H6, 2026-10-13; Hasnain may change it —
 * this block is the one switch point): 30 days of the last gross salary for
 * every counted year of service, a part year of MORE than 6 months counting
 * as a year, for permanent staff with at least one full year. Booked with the
 * full & final when it is approved (Dr 6036 Gratuity, inside the Cr 2020 net).
 */
export interface GratuitySettings {
  enabled: boolean
  /** Employment types that earn it (HrEmployee.employmentType). */
  eligibleTypes: string[]
  /** Full months of service before any gratuity is due. */
  minServiceMonths: number
  /** A remainder of MORE than this many months counts as a whole year. */
  partYearOverMonths: number
  /** Days of last gross per counted year (last gross ÷ 30 × this). */
  daysPerYear: number
}

export const DEFAULT_GRATUITY: GratuitySettings = {
  enabled: true,
  eligibleTypes: ['permanent'],
  minServiceMonths: 12,
  partYearOverMonths: 6,
  daysPerYear: 30,
}

export const DEFAULT_HR_SETTINGS: HrSettings = {
  hoursPerDay: 8,
  otMultiplier: 2,
  eobi: { enabled: false, employeePct: 1, employerPct: 5, base: 'fixed', fixedWageCents: null },
  sessi: { employerPct: 0, wageCeilingCents: null },
  latesPerDeductionDay: 0,
  lateGraceMinutes: 15,
  deductAbsences: true,
  leaveYearStartMonth: 1,
  encashLeaveOnExit: true,
  employeeCodePrefix: 'EMP-',
  gratuity: DEFAULT_GRATUITY,
}

export function mergeSettings(stored: Partial<HrSettings> | null | undefined): HrSettings {
  // A row saved before HR-1 may still carry workingDaysPerMonth: retired, dropped.
  const { workingDaysPerMonth: _retired, ...s } = (stored ?? {}) as Partial<HrSettings> & { workingDaysPerMonth?: unknown }
  const g = { ...DEFAULT_GRATUITY, ...(s.gratuity ?? {}) }
  return {
    ...DEFAULT_HR_SETTINGS,
    ...s,
    eobi: { ...DEFAULT_HR_SETTINGS.eobi, ...(s.eobi ?? {}) },
    sessi: { ...DEFAULT_HR_SETTINGS.sessi, ...(s.sessi ?? {}) },
    // A stored list replaces the default one; a missing or broken one keeps it.
    gratuity: { ...g, eligibleTypes: Array.isArray(g.eligibleTypes) ? [...g.eligibleTypes] : [...DEFAULT_GRATUITY.eligibleTypes] },
  }
}

// ─── Rates ──────────────────────────────────────────────────────────────────

/** The days a month's salary is divided by: the actual calendar days of
 *  `period` (YYYY-MM; default this month) — 28, 29, 30 or 31 (owner HR-1). */
export function payDaysFor(_s: HrSettings, period?: string | null): number {
  return daysInPeriod(period ?? periodOf(new Date()))
}

/** One day's pay (unrounded paisa): gross ÷ the month's calendar days. */
export function dailyRateCents(grossCents: number, s: HrSettings, period?: string | null): number {
  const days = payDaysFor(s, period)
  return days > 0 ? grossCents / days : 0
}

export function hourlyRateCents(grossCents: number, s: HrSettings, period?: string | null): number {
  return s.hoursPerDay > 0 ? dailyRateCents(grossCents, s, period) / s.hoursPerDay : 0
}

/** The OT multiplier a record is paid at: the one HR set on it, held to the
 *  same 1–5 range as the setting, or the HR setting when none was set. */
export function otMultiplierFor(recordValue: unknown, s: HrSettings): number {
  if (typeof recordValue !== 'number' || !(recordValue > 0)) return s.otMultiplier
  return Math.min(5, Math.max(1, recordValue))
}

export function overtimeCents(hours: number, grossCents: number, s: HrSettings, multiplier?: number | null, period?: string | null): number {
  if (!(hours > 0)) return 0
  return Math.round(hours * hourlyRateCents(grossCents, s, period) * (multiplier ?? s.otMultiplier))
}

export interface EobiResult { employeeCents: number; employerCents: number; problem?: string }

/** The payslip warning that stops a payroll being approved or locked. */
export const EOBI_NOT_CALCULATED = 'Set the EOBI wage base in HR settings — EOBI is not being calculated'

/** `grossCents` is the salary actually earned in the month — prorated for a
 *  joiner or leaver — and is only used when the base is `gross`. */
export function eobiContribution(grossCents: number, s: HrSettings): EobiResult {
  if (!s.eobi.enabled) return { employeeCents: 0, employerCents: 0 }
  const base = s.eobi.base === 'gross' ? grossCents : s.eobi.fixedWageCents
  if (base == null) {
    // Refuse to guess. A wrong base is wrong on every payslip and every challan.
    return { employeeCents: 0, employerCents: 0, problem: EOBI_NOT_CALCULATED }
  }
  return {
    employeeCents: Math.round(base * s.eobi.employeePct / 100),
    employerCents: Math.round(base * s.eobi.employerPct / 100),
  }
}

export function sessiEmployerCents(grossCents: number, s: HrSettings): number {
  if (!(s.sessi.employerPct > 0)) return 0
  const base = s.sessi.wageCeilingCents != null ? Math.min(grossCents, s.sessi.wageCeilingCents) : grossCents
  return Math.round(base * s.sessi.employerPct / 100)
}

// ─── Periods & days ─────────────────────────────────────────────────────────

/**
 * Today's calendar date in Karachi (UTC+5, no DST), as the UTC midnight HR
 * stores dates at. Between 00:00 and 05:00 PKT the UTC date is still
 * yesterday, so "today", "this month" and the leave year come from here.
 */
export function pktToday(now = new Date()): Date {
  const k = new Date(now.getTime() + 5 * 3_600_000)
  return new Date(Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate()))
}

export function periodOf(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}
export function periodStart(period: string): Date {
  const [y, m] = period.split('-').map(Number)
  return new Date(Date.UTC(y!, m! - 1, 1))
}
export function periodEnd(period: string): Date {
  const [y, m] = period.split('-').map(Number)
  return new Date(Date.UTC(y!, m!, 0, 23, 59, 59, 999))
}
export function daysInPeriod(period: string): number {
  const [y, m] = period.split('-').map(Number)
  return new Date(Date.UTC(y!, m!, 0)).getUTCDate()
}
function periodIndex(period: string): number {
  const [y, m] = period.split('-').map(Number)
  return y! * 12 + (m! - 1)
}
const dayUTC = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())

/** Inclusive calendar days between two dates. */
export function inclusiveDays(from: Date, to: Date): number {
  const n = Math.round((dayUTC(to) - dayUTC(from)) / 86_400_000) + 1
  return n > 0 ? n : 0
}

/**
 * Share of the month the person was employed: 1 for a full month, less for a
 * joiner or leaver. Calendar-day basis, so someone who joins on the 16th of a
 * 30-day month is paid 15/30.
 */
export function employedFraction(period: string, joiningDate: Date | null, lastWorkingDay: Date | null): number {
  const start = periodStart(period)
  const end = periodEnd(period)
  const from = joiningDate && joiningDate > start ? joiningDate : start
  const to = lastWorkingDay && lastWorkingDay < end ? lastWorkingDay : end
  if (to < from) return 0
  return inclusiveDays(from, to) / daysInPeriod(period)
}

export function nextPeriod(period: string): string {
  const [y, m] = period.split('-').map(Number)
  return m === 12 ? `${y! + 1}-01` : `${y}-${String(m! + 1).padStart(2, '0')}`
}

// ─── Salary history ─────────────────────────────────────────────────────────

/**
 * An approved salary revision or promotion, as payroll sees it. `applied` =
 * already written to the employee master; `wroteGross` = that write set the
 * gross (a backdated one approved after a newer one did not); `beforeCents` =
 * the gross it replaced, null when it was applied before that was recorded.
 */
export interface SalaryChange { effectiveDate: Date; grossCents: number; applied: boolean; wroteGross: boolean; beforeCents: number | null }

/**
 * The gross salary in force on `on`. Starts from the employee master and
 * undoes what was applied with a later effective date; then an approved
 * change dated on or before `on` that is newer than what the master reflects —
 * one not applied yet, or a backdated one that did not overwrite a newer
 * revision — sets it. Nothing here writes to the master: payroll for a future
 * month must not bring a revision forward.
 */
export function salaryInForce(currentCents: number, changes: SalaryChange[], on: Date): number {
  const byDate = [...changes].sort((a, b) => a.effectiveDate.getTime() - b.effectiveDate.getTime())
  let salary = currentCents
  const undo = byDate.find((c) => c.applied && c.wroteGross && c.effectiveDate > on)
  if (undo) {
    // Applied before the history was kept: the gross it replaced is unknown.
    if (undo.beforeCents == null) return currentCents
    salary = undo.beforeCents
  }
  const reflected = byDate.filter((c) => c.applied && c.wroteGross && c.effectiveDate <= on).pop()
  const newer = byDate.filter((c) => c.effectiveDate <= on && !(c.applied && c.wroteGross) && c.grossCents > 0
    && (!reflected || c.effectiveDate > reflected.effectiveDate)).pop()
  return newer ? newer.grossCents : salary
}

// ─── Leave ──────────────────────────────────────────────────────────────────

/** The leave year containing `on`, as [start, end]. */
export function leaveYear(on: Date, startMonth: number): [Date, Date] {
  const m = on.getUTCMonth() + 1
  const y = m >= startMonth ? on.getUTCFullYear() : on.getUTCFullYear() - 1
  return [new Date(Date.UTC(y, startMonth - 1, 1)), new Date(Date.UTC(y + 1, startMonth - 1, 0, 23, 59, 59, 999))]
}

export interface LeaveBalance { entitlement: number; carriedForward: number; adjustments: number; taken: number; pending: number; balance: number }

/**
 * The paid leave an employee leaving on `lastWorkingDay` has earned and not
 * taken: the year's entitlement accrues month by month — for the part of the
 * leave year they were employed — plus what they carried in and were
 * adjusted, less what they took. Never below zero.
 */
export function accruedLeaveDays(
  b: { entitlement: number; carriedForward: number; adjustments: number; taken: number },
  yearFrom: Date, joiningDate: Date | null, lastWorkingDay: Date,
): number {
  const from = joiningDate && joiningDate > yearFrom ? joiningDate : yearFrom
  let months = 0
  if (from <= lastWorkingDay) {
    for (let p = periodOf(from); periodIndex(p) <= periodIndex(periodOf(lastWorkingDay)); p = nextPeriod(p)) {
      months += employedFraction(p, from, lastWorkingDay)
    }
  }
  const accrued = b.entitlement * Math.min(12, months) / 12
  return Math.max(0, days2(accrued + b.carriedForward + b.adjustments - b.taken))
}

export function leaveBalance(entitlementDays: number, approvedTaken: number, adjustments: number, pending = 0, carriedForward = 0): LeaveBalance {
  return {
    entitlement: entitlementDays,
    carriedForward,
    adjustments,
    taken: approvedTaken,
    pending,
    balance: entitlementDays + carriedForward + adjustments - approvedTaken,
  }
}

/** Days to two decimals, so a sum of shares doesn't read 4.9999…. */
const days2 = (n: number) => Math.round(n * 100) / 100

/** Calendar days two inclusive date ranges share. */
export function overlapDays(aFrom: Date, aTo: Date, bFrom: Date, bTo: Date): number {
  const from = aFrom > bFrom ? aFrom : bFrom
  const to = aTo < bTo ? aTo : bTo
  return to < from ? 0 : inclusiveDays(from, to)
}

/**
 * How many days a leave application counts for. Always the inclusive calendar
 * days of its dates — the rest of the module (balances, payroll) counts
 * calendar days — never the number the applicant typed. The one exception is
 * a half day: a single-day leave may ask for 0.5.
 */
export function leaveQuantity(start: Date, end: Date, requested: number | null | undefined): number {
  const span = inclusiveDays(start, end)
  if (span === 1 && requested === 0.5) return 0.5
  return span
}

/**
 * The part of a leave that falls inside [from, to]. A leave's quantity is
 * spread evenly over its dates, so a leave across a leave-year (or payroll
 * month) boundary is charged to each side for the days on that side, and a
 * half day stays a half day.
 */
export function leaveDaysWithin(l: { startDate: Date; endDate: Date; quantity: number | null }, from: Date, to: Date): number {
  const span = inclusiveDays(l.startDate, l.endDate)
  if (span === 0) return 0
  const inside = overlapDays(l.startDate, l.endDate, from, to)
  if (inside === 0) return 0
  const qty = l.quantity != null && l.quantity >= 0 ? l.quantity : span
  return days2(qty * inside / span)
}

/**
 * Days carried into a leave year. `priorYears` is every earlier leave year in
 * order (oldest first) with what was adjusted and taken in it; each year's
 * unused balance — entitlement + what it carried in + adjustments − taken —
 * carries into the next, capped at `max` (null = no cap). A year that ended
 * overdrawn carries nothing, and does not claw back the next year's entitlement.
 */
export function carriedForwardDays(entitlementDays: number, priorYears: Array<{ adjustments: number; taken: number }>, max: number | null): number {
  let carry = 0
  for (const y of priorYears) {
    const closing = Math.max(0, entitlementDays + carry + y.adjustments - y.taken)
    carry = max != null ? Math.min(closing, Math.max(0, max)) : closing
  }
  return days2(carry)
}

/** The leave years from the one containing `first` up to (not including) the one starting at `before`. */
export function leaveYearsBetween(first: Date, before: Date, startMonth: number): Array<[Date, Date]> {
  const out: Array<[Date, Date]> = []
  let y = leaveYear(first, startMonth)
  while (y[0] < before && out.length < 100) {
    out.push(y)
    y = leaveYear(new Date(y[1].getTime() + 1), startMonth)
  }
  return out
}

// ─── Attendance → payroll ───────────────────────────────────────────────────

export interface AttendanceEntry { date: Date; status: string | null; lateMinutes: number | null; createdAt: Date }
export interface LeaveSpan { startDate: Date; endDate: Date; quantity: number | null; unpaid: boolean }

/**
 * The attendance part of a month's payroll inputs, over [from, to] — the
 * payroll month already clipped to the employee's employment.
 *
 *  - One entry per day: when a day was recorded more than once, the latest
 *    entry is the one that stands (a correction replaces, it doesn't add).
 *  - A day covered by approved leave is not an absence or a late — the leave
 *    already accounts for it.
 *  - A late within the grace minutes is not a late.
 *  - Unpaid leave is the approved quantity, spread over its dates and counted
 *    for the days inside the window; two leaves on one day charge it once.
 *
 * Callers pass only entries that stand (not cancelled, rejected or draft) and
 * only approved leave.
 */
export function attendanceInputs(from: Date, to: Date, attendance: AttendanceEntry[], leaves: LeaveSpan[], s: HrSettings): { absentDays: number; lateCount: number; unpaidLeaveDays: number } {
  const lo = dayUTC(from)
  const hi = dayUTC(to)
  const covered = new Set<number>()
  const unpaidByDay = new Map<number, number>()
  for (const l of leaves) {
    const span = inclusiveDays(l.startDate, l.endDate)
    if (span === 0) continue
    const perDay = Math.min(1, (l.quantity != null && l.quantity >= 0 ? l.quantity : span) / span)
    for (let d = Math.max(dayUTC(l.startDate), lo); d <= Math.min(dayUTC(l.endDate), hi); d += 86_400_000) {
      covered.add(d)
      if (l.unpaid) unpaidByDay.set(d, Math.max(unpaidByDay.get(d) ?? 0, perDay))
    }
  }
  const latest = new Map<number, AttendanceEntry>()
  for (const a of attendance) {
    const d = dayUTC(a.date)
    if (d < lo || d > hi) continue
    const cur = latest.get(d)
    if (!cur || a.createdAt > cur.createdAt) latest.set(d, a)
  }
  let absentDays = 0
  let lateCount = 0
  for (const [d, a] of latest) {
    if (covered.has(d)) continue
    if (a.status === 'absent') absentDays += 1
    else if (a.status === 'half_day') absentDays += 0.5
    else if (a.status === 'late' && (a.lateMinutes ?? Infinity) > s.lateGraceMinutes) lateCount += 1
  }
  let unpaid = 0
  for (const v of unpaidByDay.values()) unpaid += v
  return { absentDays, lateCount, unpaidLeaveDays: days2(unpaid) }
}

// ─── Loans ──────────────────────────────────────────────────────────────────

/**
 * The installment due for a loan in `period`, given what has been recovered
 * already. Equal installments, floored; the last one takes the remainder, so
 * the total recovered is exactly the loan — never a paisa more.
 */
export function loanInstallmentCents(
  loan: { amountCents: number; installments: number; firstPeriod: string },
  period: string,
  recoveredCents: number,
): number {
  const outstanding = loan.amountCents - recoveredCents
  if (outstanding <= 0) return 0
  if (periodIndex(period) < periodIndex(loan.firstPeriod)) return 0
  // Whole installments, at least one: a loan saved with none, a negative or a
  // part installment is still recovered — never silently left unpaid.
  const installments = Number.isFinite(loan.installments) ? Math.max(1, Math.floor(loan.installments)) : 1
  const per = Math.floor(loan.amountCents / installments)
  const n = periodIndex(period) - periodIndex(loan.firstPeriod) + 1
  if (n >= installments) return outstanding // last (or overdue) installment clears it
  return Math.min(per, outstanding)
}

/**
 * Split a loan deduction HR typed on a payslip across the employee's loans,
 * oldest first, never more than a loan still owes. Null when the amount is
 * more than they owe in all — it would be deducted and credited to nothing.
 */
export function allocateLoanCents(loans: Array<{ loanId: string; outstandingCents: number }>, totalCents: number): Array<{ loanId: string; cents: number }> | null {
  let left = totalCents
  const out: Array<{ loanId: string; cents: number }> = []
  for (const l of loans) {
    if (left <= 0) break
    const c = Math.min(left, Math.max(0, l.outstandingCents))
    if (c > 0) { out.push({ loanId: l.loanId, cents: c }); left -= c }
  }
  return left > 0 ? null : out
}

// ─── Payroll ────────────────────────────────────────────────────────────────

export interface PayrollInputs {
  absentDays: number
  unpaidLeaveDays: number
  lateCount: number
  otHours: number
  otCents: number              // already-approved OT amounts, summed
  earningAdjustmentsCents: number
  deductionAdjustmentsCents: number
  loanInstallmentsCents: number
}

export const EMPTY_INPUTS: PayrollInputs = {
  absentDays: 0, unpaidLeaveDays: 0, lateCount: 0, otHours: 0, otCents: 0,
  earningAdjustmentsCents: 0, deductionAdjustmentsCents: 0, loanInstallmentsCents: 0,
}

export interface PayLine { kind: 'earning' | 'deduction' | 'employer'; code: string; label: string; amountCents: number }

/**
 * How a payslip's salary was worked out (owner HR-1 / HR-2, 2026-10-16),
 * kept on the payslip (inputs.payBasis) so the run, the payslip and the
 * Payroll Report show the same figures.
 */
export interface PayBasis {
  /** Calendar days of the month: 28, 29, 30 or 31. */
  daysInMonth: number
  /** Days of the month the person was employed (joining → last working day). */
  employedDays: number
  /** Absent days docked (0 when the company does not deduct absences). */
  absentDays: number
  unpaidLeaveDays: number
  /** employedDays − absentDays − unpaidLeaveDays: the days paid for. */
  paidDays: number
  /** One day's pay, rounded to the paisa for display: gross ÷ daysInMonth. */
  dailyRateCents: number
  /** The full monthly gross the rate is worked from. */
  monthlyGrossCents: number
}

export interface PayslipResult {
  lines: PayLine[]
  /** Salary earned this month: monthly gross ÷ days in month × paid days. */
  grossCents: number
  earningsCents: number
  deductionsCents: number
  eobiEmployeeCents: number
  eobiEmployerCents: number
  netCents: number
  warnings: string[]
  basis: PayBasis
}

const fmtDays = (n: number) => String(days2(n))
const fmtRs = (cents: number) => `Rs ${(cents / 100).toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/**
 * One month's payslip.
 *
 * THE RULE (owner HR-1, 2026-10-16: "we will do by actual number of days in a
 * month"; HR-2: count only the days they were employed):
 *
 *   salary = monthly gross ÷ calendar days in the month × paid days
 *   paid days = days employed in the month − absent days − unpaid leave days
 *
 * Days before joining or after the last working day are simply not employed —
 * never absences. Weekly off days, holidays, paid leave, lates, early
 * departures, missing punches and days with no attendance record are all paid
 * days: only an `absent` record (1 day; `half_day` 0.5) on a day not covered
 * by approved leave, and approved UNPAID leave, take a day out. Lates (every N
 * lates = one day at the same daily rate) stay a deduction line.
 */
export function computePayslip(
  emp: { grossSalaryCents: number; monthlyTaxCents: number; joiningDate: Date | null; lastWorkingDay: Date | null },
  period: string,
  inputs: PayrollInputs,
  s: HrSettings,
): PayslipResult {
  const warnings: string[] = []
  const lines: PayLine[] = []
  const daysInMonth = daysInPeriod(period)
  const employedDays = Math.round(employedFraction(period, emp.joiningDate, emp.lastWorkingDay) * daysInMonth)
  const monthly = emp.grossSalaryCents
  const daily = dailyRateCents(monthly, s, period)
  // Days taken out can't be more than the days employed.
  const absentDays = days2(s.deductAbsences ? Math.min(Math.max(0, inputs.absentDays || 0), employedDays) : 0)
  const unpaidDays = days2(Math.min(Math.max(0, inputs.unpaidLeaveDays || 0), Math.max(0, employedDays - absentDays)))
  const paidDays = days2(Math.max(0, employedDays - absentDays - unpaidDays))
  const gross = Math.round((monthly * paidDays) / daysInMonth)
  // What the days employed would pay with nobody absent: the base for EOBI on
  // gross and SESSI, unchanged by HR-1 (absences never lowered it).
  const employedCents = Math.round((monthly * employedDays) / daysInMonth)
  const basis: PayBasis = {
    daysInMonth, employedDays, absentDays, unpaidLeaveDays: unpaidDays, paidDays,
    dailyRateCents: Math.round(daily), monthlyGrossCents: monthly,
  }
  let docked = 0
  const dock = (cents: number) => { const c = Math.min(Math.round(cents), Math.max(0, gross - docked)); docked += c; return c }

  const out: string[] = []
  if (employedDays < daysInMonth) out.push(`${daysInMonth - employedDays} not employed`)
  if (absentDays > 0) out.push(`${fmtDays(absentDays)} absent`)
  if (unpaidDays > 0) out.push(`${fmtDays(unpaidDays)} unpaid leave`)
  lines.push({
    kind: 'earning', code: 'salary',
    label: `Salary — ${fmtDays(paidDays)} of ${daysInMonth} days × ${fmtRs(Math.round(daily))}/day${out.length ? ` (${out.join(', ')})` : ''}`,
    amountCents: gross,
  })
  if (inputs.otCents > 0) lines.push({ kind: 'earning', code: 'overtime', label: `Overtime (${inputs.otHours} h)`, amountCents: inputs.otCents })
  if (inputs.earningAdjustmentsCents > 0) lines.push({ kind: 'earning', code: 'adjustments', label: 'Bonuses, incentives & allowances', amountCents: inputs.earningAdjustmentsCents })

  if (s.latesPerDeductionDay > 0 && inputs.lateCount >= s.latesPerDeductionDay) {
    const days = Math.floor(inputs.lateCount / s.latesPerDeductionDay)
    lines.push({ kind: 'deduction', code: 'late', label: `Late coming (${inputs.lateCount} lates = ${days} day${days === 1 ? '' : 's'})`, amountCents: dock(days * daily) })
  }

  // Contributions on a gross base are on the days employed this month, not
  // the full monthly salary a joiner or leaver was never paid.
  const eobi = employedCents > 0 ? eobiContribution(employedCents, s) : { employeeCents: 0, employerCents: 0 }
  if (eobi.problem) warnings.push(eobi.problem)
  if (eobi.employeeCents > 0) lines.push({ kind: 'deduction', code: 'eobi_employee', label: `EOBI employee (${s.eobi.employeePct}%)`, amountCents: eobi.employeeCents })
  if (emp.monthlyTaxCents > 0 && employedCents > 0) lines.push({ kind: 'deduction', code: 'tax', label: 'Income tax', amountCents: emp.monthlyTaxCents })
  if (inputs.loanInstallmentsCents > 0) lines.push({ kind: 'deduction', code: 'loan', label: 'Loan / advance installment', amountCents: inputs.loanInstallmentsCents })
  if (inputs.deductionAdjustmentsCents > 0) lines.push({ kind: 'deduction', code: 'other', label: 'Other deductions', amountCents: inputs.deductionAdjustmentsCents })

  if (eobi.employerCents > 0) lines.push({ kind: 'employer', code: 'eobi_employer', label: `EOBI employer (${s.eobi.employerPct}%)`, amountCents: eobi.employerCents })
  const sessi = employedCents > 0 ? sessiEmployerCents(employedCents, s) : 0
  if (sessi > 0) lines.push({ kind: 'employer', code: 'sessi_employer', label: `SESSI employer (${s.sessi.employerPct}%)`, amountCents: sessi })

  const earnings = lines.filter((l) => l.kind === 'earning').reduce((a, l) => a + l.amountCents, 0)
  const deductions = lines.filter((l) => l.kind === 'deduction').reduce((a, l) => a + l.amountCents, 0)
  const net = earnings - deductions
  if (net < 0) warnings.push('Deductions are more than earnings — net pay is negative')
  if (emp.grossSalaryCents <= 0) warnings.push('No gross salary on the employee record')

  return {
    lines, grossCents: gross, earningsCents: earnings, deductionsCents: deductions,
    eobiEmployeeCents: eobi.employeeCents, eobiEmployerCents: eobi.employerCents, netCents: net, warnings, basis,
  }
}

// ─── Full & final ───────────────────────────────────────────────────────────

export interface SettlementInputs {
  /** First day whose salary no payroll has paid; null = nothing owed. */
  salaryFrom: Date | null
  otPayableCents: number
  leaveBalanceDays: number        // paid leave earned and not taken
  loanOutstandingCents: number
  deductionsCents: number
  otherAdjustmentsCents: number
  /** The gross in force for each month the settlement pays salary for
   *  (service salaryForPeriod). A month not listed is paid at the employee's
   *  gross — the same rule a payslip follows for its own month. */
  salaryByPeriod?: Record<string, number>
  /** Gratuity at exit (gratuityFor's amountCents); 0 when not due. */
  gratuityCents?: number
}

/** One month of salary a full & final pays, worked out as that month's
 *  payslip would have been. */
export interface SettlementMonth {
  period: string
  salaryCents: number
  taxCents: number
  eobiEmployeeCents: number
  eobiEmployerCents: number
  sessiEmployerCents: number
}

export function finalSettlement(
  emp: { grossSalaryCents: number; joiningDate: Date | null; monthlyTaxCents?: number },
  lastWorkingDay: Date,
  inp: SettlementInputs,
  s: HrSettings,
) {
  const from = inp.salaryFrom && emp.joiningDate && emp.joiningDate > inp.salaryFrom ? emp.joiningDate : inp.salaryFrom
  // Each month the settlement pays salary for is that month's payslip —
  // computePayslip, the one engine — so the leaver's last salary carries the
  // same income tax, EOBI and SESSI a payroll would have taken for those days
  // (finance gaps, extra finding "F&F has no statutory deductions"). `from`
  // stands in for the joining date, so the first month is prorated from it.
  const months: SettlementMonth[] = []
  const warnings = new Set<string>()
  if (from && from <= lastWorkingDay) {
    for (let p = periodOf(from); periodIndex(p) <= periodIndex(periodOf(lastWorkingDay)); p = nextPeriod(p)) {
      const slip = computePayslip({
        grossSalaryCents: inp.salaryByPeriod?.[p] ?? emp.grossSalaryCents,
        monthlyTaxCents: emp.monthlyTaxCents ?? 0,
        joiningDate: from, lastWorkingDay,
      }, p, EMPTY_INPUTS, s)
      const line = (code: string) => slip.lines.filter((l) => l.code === code).reduce((a, l) => a + l.amountCents, 0)
      months.push({
        period: p, salaryCents: slip.grossCents, taxCents: line('tax'),
        eobiEmployeeCents: line('eobi_employee'), eobiEmployerCents: line('eobi_employer'), sessiEmployerCents: line('sessi_employer'),
      })
      for (const w of slip.warnings) warnings.add(w)
    }
  }
  const total = (k: keyof Omit<SettlementMonth, 'period'>) => months.reduce((a, m) => a + m[k], 0)
  const leaveEncashment = s.encashLeaveOnExit && inp.leaveBalanceDays > 0
    ? Math.round(inp.leaveBalanceDays * dailyRateCents(emp.grossSalaryCents, s, periodOf(lastWorkingDay)))
    : 0
  const parts: SettlementParts = {
    salaryPayable: total('salaryCents'), otPayable: inp.otPayableCents, leaveEncashment,
    deductions: inp.deductionsCents, loanRecovery: inp.loanOutstandingCents, otherAdjustments: inp.otherAdjustmentsCents,
    // Income tax here is the monthly figure HR keeps on the employee, as on a
    // payslip. Tax on the leave encashment or another lump sum is not worked
    // out by servd (payroll has no s.149 engine either) — HR adjusts the
    // income tax figure on the settlement before approving it.
    incomeTax: total('taxCents'), eobiEmployee: total('eobiEmployeeCents'),
    eobiEmployer: total('eobiEmployerCents'), sessiEmployer: total('sessiEmployerCents'),
    // Gratuity (H6): one more earning, worked out by gratuityFor on the last
    // gross; hr/ledger.ts books it to 6036 inside the Cr 2020 net.
    gratuity: Math.max(0, Math.round(inp.gratuityCents ?? 0)),
  }
  return { ...parts, netAmount: settlementNet(parts), months, warnings: Array.from(warnings) }
}

export interface GratuityResult {
  eligible: boolean
  /** Why nothing is due, when nothing is. */
  reason: string | null
  /** Service from the joining date to the last working day, inclusive. */
  years: number
  months: number
  days: number
  /** Whole years paid for: years, plus one when the remainder is over the part-year months. */
  countedYears: number
  amountCents: number
}

const daysInMonthUTC = (y: number, m0: number) => new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate()

/**
 * Service as calendar years, months and days from `from` to `to`, both days
 * counted: joined 1 Jan 2024 and left 30 Jun 2025 is exactly 1 year 6 months.
 */
export function serviceLength(from: Date, to: Date): { years: number; months: number; days: number } {
  const end = new Date(dayUTC(to) + 86_400_000) // the day after the last day worked
  const start = new Date(dayUTC(from))
  if (end <= start) return { years: 0, months: 0, days: 0 }
  let years = end.getUTCFullYear() - start.getUTCFullYear()
  let months = end.getUTCMonth() - start.getUTCMonth()
  let days = end.getUTCDate() - start.getUTCDate()
  if (days < 0) {
    months -= 1
    // Borrow the month before the end month.
    const pm = end.getUTCMonth() === 0 ? 11 : end.getUTCMonth() - 1
    const py = end.getUTCMonth() === 0 ? end.getUTCFullYear() - 1 : end.getUTCFullYear()
    days += daysInMonthUTC(py, pm)
  }
  if (months < 0) { years -= 1; months += 12 }
  return { years, months, days }
}

/**
 * Gratuity at exit (H6): round(last gross ÷ 30 × daysPerYear) × counted years.
 * Counted years = completed years + 1 when the remainder is MORE than
 * `partYearOverMonths` months (day-precise: 1y 6m is 1, 1y 6m 1d is 2). Due
 * only to an eligible employment type with at least `minServiceMonths` full
 * months of service. `lastGrossCents` is the gross in force at the last
 * working day (service salaryForPeriod — the latest approved revision).
 */
export function gratuityFor(
  emp: { employmentType: string; joiningDate: Date | null },
  lastWorkingDay: Date,
  lastGrossCents: number,
  s: GratuitySettings,
): GratuityResult {
  const service = emp.joiningDate ? serviceLength(emp.joiningDate, lastWorkingDay) : { years: 0, months: 0, days: 0 }
  const none = (reason: string): GratuityResult => ({ eligible: false, reason, ...service, countedYears: 0, amountCents: 0 })
  if (!s.enabled) return none('Gratuity is switched off in HR settings')
  if (!s.eligibleTypes.includes(emp.employmentType)) {
    return none(`Gratuity is for ${s.eligibleTypes.join(' / ') || 'no'} staff — this employee is ${emp.employmentType}`)
  }
  if (!emp.joiningDate) return none('No joining date on the employee record')
  if (lastWorkingDay < emp.joiningDate) return none('The last working day is before the joining date')
  const fullMonths = service.years * 12 + service.months
  if (fullMonths < s.minServiceMonths) {
    const need = s.minServiceMonths % 12 === 0 ? `${s.minServiceMonths / 12} year${s.minServiceMonths === 12 ? '' : 's'}` : `${s.minServiceMonths} months`
    return none(`Less than ${need} of service (${service.years} y ${service.months} m ${service.days} d)`)
  }
  const over = service.months > s.partYearOverMonths || (service.months === s.partYearOverMonths && service.days > 0)
  const countedYears = service.years + (over ? 1 : 0)
  if (countedYears <= 0 || !(lastGrossCents > 0)) return none(lastGrossCents > 0 ? 'No counted year of service' : 'No gross salary on the employee record')
  const perYear = Math.round((lastGrossCents / 30) * s.daysPerYear)
  return { eligible: true, reason: null, ...service, countedYears, amountCents: perYear * countedYears }
}

/** The figures of a full & final, as its record holds them (data keys). The
 *  employer EOBI / SESSI are the company's cost: posted, never off the net. */
export interface SettlementParts {
  salaryPayable: number
  otPayable: number
  leaveEncashment: number
  deductions: number
  loanRecovery: number
  otherAdjustments: number   // signed
  incomeTax: number
  eobiEmployee: number
  eobiEmployer: number
  sessiEmployer: number
  /** Gratuity at exit (H6) — paid to the leaver, booked to 6036. */
  gratuity: number
}

/** A record's figures; a missing or non-numeric one is zero (a format saved
 *  before the statutory lines — or gratuity — existed has none). */
export function settlementParts(data: unknown): SettlementParts {
  const d = (data ?? {}) as Record<string, unknown>
  const n = (k: keyof SettlementParts) => (typeof d[k] === 'number' && Number.isFinite(d[k]) ? Math.round(d[k] as number) : 0)
  return {
    salaryPayable: n('salaryPayable'), otPayable: n('otPayable'), leaveEncashment: n('leaveEncashment'),
    deductions: n('deductions'), loanRecovery: n('loanRecovery'), otherAdjustments: n('otherAdjustments'),
    incomeTax: n('incomeTax'), eobiEmployee: n('eobiEmployee'), eobiEmployer: n('eobiEmployer'), sessiEmployer: n('sessiEmployer'),
    gratuity: n('gratuity'),
  }
}

/**
 * The first payroll month an approved full & final settles: payroll leaves the
 * leaver out of it and every later month, and the settlement pays it. The
 * month of `_salaryFrom` — the first day no payroll had paid, stored when the
 * settlement is approved — else (approved before that was stored, or paying
 * no salary at all) the month of the last working day.
 */
export function settledFromPeriod(rec: { endDate: Date | null; data: unknown }): string | null {
  const from = ((rec.data ?? {}) as Record<string, unknown>)['_salaryFrom']
  if (typeof from === 'string') {
    const d = new Date(from)
    if (!Number.isNaN(d.getTime())) return periodOf(d)
  }
  return rec.endDate ? periodOf(rec.endDate) : null
}

/** What the leaver is paid: the ONE formula — the record's net on save, the
 *  Wages Payable credit when it is booked. */
export function settlementNet(p: SettlementParts): number {
  return p.salaryPayable + p.otPayable + p.leaveEncashment + p.gratuity + p.otherAdjustments
    - p.deductions - p.loanRecovery - p.incomeTax - p.eobiEmployee
}

// ─── Approvals ──────────────────────────────────────────────────────────────

export interface ApprovalEntry {
  step: string
  role: string
  decision: 'approved' | 'rejected'
  byUserId: string
  byName: string
  at: string
  note?: string
  override?: boolean
  /** Head office (D3): decided through reach or an HR hand-over (absent = a member's own right). */
  via?: 'reach' | 'delegation'
  delegationId?: string
}

const HR_APPROVERS = ['hr', 'admin', 'owner', 'management']
const MGMT_APPROVERS = ['admin', 'owner', 'management']

/**
 * May this person act on this step? HOD means the employee's reporting
 * manager — the manager's own login. If the employee has no manager with a
 * login, HR can act for the HOD so records never get stuck. The CEO (admin)
 * can act on any step, and it is recorded as an override.
 *
 * Separation of duties: nobody decides a step on a request they raised or
 * that is about themselves, and nobody signs off more than one step of the
 * same request — HOD → HR → Management are separate people. The CEO may
 * still do either, and that too is recorded as an override.
 */
export function canActOnStep(
  role: 'hod' | 'hr' | 'management',
  actor: { id: string; role: string },
  subject: { employeeUserId: string | null; managerUserId: string | null; createdById?: string | null; priorApproverIds?: string[] },
): { ok: boolean; override: boolean; reason?: string } {
  const own = (subject.employeeUserId && subject.employeeUserId === actor.id) || (subject.createdById && subject.createdById === actor.id)
  const again = (subject.priorApproverIds ?? []).includes(actor.id)
  if (own || again) {
    if (actor.role === 'admin') return { ok: true, override: true }
    return { ok: false, override: false, reason: own ? 'You cannot approve your own request' : 'You have already signed off an earlier step of this request — another approver must take this one' }
  }
  if (role === 'hod') {
    if (subject.managerUserId && subject.managerUserId === actor.id) return { ok: true, override: false }
    if (!subject.managerUserId && HR_APPROVERS.includes(actor.role)) return { ok: true, override: false }
  }
  if (role === 'hr' && HR_APPROVERS.includes(actor.role)) return { ok: true, override: false }
  if (role === 'management' && MGMT_APPROVERS.includes(actor.role)) return { ok: true, override: false }
  if (actor.role === 'admin') return { ok: true, override: true }
  return { ok: false, override: false, reason: `This step needs ${role === 'hod' ? 'the reporting manager' : role === 'hr' ? 'HR' : 'management'}` }
}

// ─── Head office: who may decide a step (D3, spec §7.4.3 + A20) ─────────────
//
// decideRight wraps canActOnStep with the head-office rules. With no head
// office and no hand-over (today's live state) it IS canActOnStep for a member
// of the record's company, and "not found" for anyone else — exactly the old
// guard (the record was looked up in the caller's member companies).
//
//   member of rec.tenantId   today's rules. On the FINAL step of a record that
//                            came through a head office (A3) a non-CEO member
//                            needs a live HR hand-over instead (HODs submit to
//                            the CEO, not to a company GM).
//   reach-only (HO staff)    may APPROVE a non-final 'hr' step (HR review work,
//                            forwarding it). A reject at any step, or any
//                            action on the final step, needs a live HR
//                            hand-over covering rec.tenantId (A20); otherwise
//                            403 FINAL_STEP_NEEDS_HANDOVER.
//   anyone else              404 (the id is not confirmed).
//
// Separation of duties is canActOnStep's: never your own request, never two
// steps of one request — a hand-over does not lift it. On success the request's
// RLS context is widened to the record's company. The head-office helpers are
// imported lazily so this file stays free of database imports.

export interface DecideActor {
  id: string
  role: string
  memberTenantIds?: string[]
  reachTenantIds?: string[]
}

export type DecideRight =
  | { ok: true; override: boolean; via: 'member' | 'reach' | 'delegation'; delegationId?: string }
  | { ok: false; status: 403 | 404; code: string; message: string }

/** The facts of an HR record decideRight reads. */
export interface DecideRecord {
  id: string
  tenantId: string
  createdById: string | null
  createdAt: Date
  viaHeadOfficeId?: string | null
}

/**
 * May the caller decide this step of this record? `decision` null = "would
 * they approve it" (the waiting-on-me list). `through` = the head offices the
 * record came through (approvalRights.throughHeadOfficeBatch), when the caller
 * already has it; otherwise it is read when needed (final steps only).
 */
export async function decideRight(
  req: FastifyRequest,
  rec: DecideRecord,
  step: { role: 'hod' | 'hr' | 'management' },
  isLast: boolean,
  ctx: {
    subject: { employeeUserId: string | null; managerUserId: string | null; createdById?: string | null; priorApproverIds?: string[] }
    decision: 'approved' | 'rejected' | null
    through?: string[]
    /** The companies an hr_request hand-over of the caller covers
     *  (delegatedTenantsByType), when the caller already read it — a list
     *  pass reads it once; with it, a company outside the set skips the
     *  per-record hand-over lookup. */
    delegatedTenants?: Set<string>
  },
): Promise<DecideRight> {
  const actor: DecideActor | undefined = req.staffUser
  const notFound: DecideRight = { ok: false, status: 404, code: 'NOT_FOUND', message: 'HR record not found' }
  if (!actor) return notFound
  const isAdmin = actor.role === 'admin'
  const member = (actor.memberTenantIds ?? []).includes(rec.tenantId)
  const reachOnly = !member && (actor.reachTenantIds ?? []).includes(rec.tenantId)
  const s = ctx.subject
  const own = !!((s.employeeUserId && s.employeeUserId === actor.id) || (s.createdById && s.createdById === actor.id))
  const again = (s.priorApproverIds ?? []).includes(actor.id)
  const who = canActOnStep(step.role, actor, s)
  const rejecting = ctx.decision === 'rejected'

  const { throughHeadOfficeIds, delegationCovering } = await import('../../lib/approvalRights.js')
  const { widenRls } = await import('../../lib/headOffice.js')
  let through = ctx.through
  const throughIds = async () => (through ??= await throughHeadOfficeIds({
    tenantId: rec.tenantId, submittedByIds: [rec.createdById], submittedAt: rec.createdAt, viaHeadOfficeId: rec.viaHeadOfficeId ?? null,
  }))
  const granted = (g: Extract<DecideRight, { ok: true }>): DecideRight => {
    widenRls(req, [rec.tenantId])
    return g
  }
  // A live HR hand-over covering the record's company (and, A13, the head
  // office it came through). Never for the CEO's own login (not a delegate)
  // and never over separation of duties.
  const handover = async (): Promise<DecideRight | null> => {
    if (isAdmin || own || again) return null
    if (ctx.delegatedTenants && !ctx.delegatedTenants.has(rec.tenantId)) return null
    const d = await delegationCovering(actor.id, 'hr_request', {
      tenantId: rec.tenantId, touchesTenantIds: [rec.tenantId], throughHeadOfficeIds: await throughIds(),
    })
    return d ? granted({ ok: true, override: false, via: 'delegation', delegationId: d.id }) : null
  }

  if (member) {
    if (who.ok) {
      // The through-head-office rule (A3): the final sign-off of an HOD's
      // submission is the CEO's, or a hand-over's — never a company approver's.
      if (!isAdmin && isLast && (await throughIds()).length > 0) {
        return (await handover()) ?? {
          ok: false, status: 403, code: 'APPROVAL_NOT_YOURS',
          message: 'This request came through head office — its final sign-off needs the CEO or the HR approver',
        }
      }
      return granted({ ok: true, override: who.override, via: 'member' })
    }
    // A member who is also a head-office delegate may still take the final
    // step (or a rejection) through the hand-over.
    if ((isLast || rejecting) && !own && !again) {
      const h = await handover()
      if (h) return h
    }
    return { ok: false, status: 403, code: 'FORBIDDEN', message: who.reason ?? 'You cannot approve this step' }
  }

  if (reachOnly) {
    if (own || again) return { ok: false, status: 403, code: 'FORBIDDEN', message: who.reason ?? 'You cannot approve this step' }
    // A20: forwarding an HR review step is HR's work through head office.
    if (!rejecting && !isLast && step.role === 'hr' && who.ok && !who.override) {
      return granted({ ok: true, override: false, via: 'reach' })
    }
    if (isLast || rejecting) {
      const h = await handover()
      if (h) return h
    }
    return {
      ok: false, status: 403, code: 'FINAL_STEP_NEEDS_HANDOVER',
      message: "Through head office you can forward HR's review step only — the final sign-off or a rejection needs the CEO or an HR hand-over",
    }
  }

  // Not a member and not reached: only a hand-over could reach it (a delegate
  // is always a head-office member, so this is defensive).
  if (isLast || rejecting) {
    const h = await handover()
    if (h) return h
  }
  return notFound
}

/**
 * Can the caller see this company's HR records for a decision at all — a
 * member, a reach-only head-office member, or the delegate of a live HR
 * hand-over covering it? Anything else is 404 before any other check.
 */
export async function mayReachForDecision(req: FastifyRequest, tenantId: string): Promise<boolean> {
  const actor: DecideActor | undefined = req.staffUser
  if (!actor) return false
  if ((actor.memberTenantIds ?? []).includes(tenantId)) return true
  if ((actor.reachTenantIds ?? []).includes(tenantId)) return true
  const { delegatedTenantsByType } = await import('../../lib/approvalRights.js')
  return !!(await delegatedTenantsByType(actor.id)).get('hr_request')?.has(tenantId)
}

// ─── Headcount ──────────────────────────────────────────────────────────────

export interface Tenure { status: string; joiningDate: Date | null; lastWorkingDay: Date | null; updatedAt: Date }

/**
 * The day someone stopped working: the last working day, else — for someone
 * resigned, terminated or separated without one — the approved exit record's
 * date, else the day their status was last changed.
 */
export function exitDay(e: Tenure, exitRecordDate?: Date | null): Date | null {
  if (e.lastWorkingDay) return e.lastWorkingDay
  if (['active', 'on_leave'].includes(e.status)) return null
  const d = exitRecordDate ?? e.updatedAt
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

/** On the books at an instant: joined by then and not gone before it. Dates
 *  are that day's UTC midnight, so the last working day counts until it starts. */
export function onBooksAt(e: Tenure, at: Date, exitRecordDate?: Date | null): boolean {
  if (e.joiningDate && e.joiningDate > at) return false
  if (!e.joiningDate && !['active', 'on_leave'].includes(e.status)) return false
  const gone = exitDay(e, exitRecordDate)
  return !(gone && gone < at)
}

/** Employed on a calendar date — including someone whose last working day it is. */
export function employedOn(e: Tenure, on: Date, exitRecordDate?: Date | null): boolean {
  return onBooksAt(e, new Date(Date.UTC(on.getUTCFullYear(), on.getUTCMonth(), on.getUTCDate())), exitRecordDate)
}

// ─── Due lists ──────────────────────────────────────────────────────────────

export function isDueWithin(date: Date | null | undefined, days: number, now = new Date()): boolean {
  if (!date) return false
  const diff = (dayUTC(date) - dayUTC(now)) / 86_400_000
  return diff <= days
}

export function nextEmployeeCode(prefix: string, existing: string[]): string {
  let max = 0
  for (const c of existing) {
    if (!c.startsWith(prefix)) continue
    const n = parseInt(c.slice(prefix.length), 10)
    if (Number.isFinite(n) && n > max) max = n
  }
  return `${prefix}${String(max + 1).padStart(4, '0')}`
}
