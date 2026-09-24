// HR calculations. Pure functions over plain values — no database here — so
// each rule can be tested on its own and read in one place.
//
// All money is integer paisa. Rounding happens once per line, at the line.
//
// Rates that are a matter of law or company policy are SETTINGS, not
// constants: they change, they differ between provinces, and the HR team is
// the authority on them. Defaults are starting points, each marked where it
// needs confirming.

export interface HrSettings {
  /** Days a monthly salary is divided by for daily rate, absence and OT. */
  workingDaysPerMonth: number
  hoursPerDay: number
  /** OT multiplier when a request doesn't specify one. Sindh's shops &
   *  establishments law pays overtime at twice the ordinary rate — confirm. */
  otMultiplier: number
  eobi: {
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
}

export const DEFAULT_HR_SETTINGS: HrSettings = {
  workingDaysPerMonth: 26,
  hoursPerDay: 8,
  otMultiplier: 2,
  eobi: { employeePct: 1, employerPct: 5, base: 'fixed', fixedWageCents: null },
  sessi: { employerPct: 0, wageCeilingCents: null },
  latesPerDeductionDay: 0,
  lateGraceMinutes: 15,
  deductAbsences: true,
  leaveYearStartMonth: 1,
  encashLeaveOnExit: true,
  employeeCodePrefix: 'EMP-',
}

export function mergeSettings(stored: Partial<HrSettings> | null | undefined): HrSettings {
  const s = stored ?? {}
  return {
    ...DEFAULT_HR_SETTINGS,
    ...s,
    eobi: { ...DEFAULT_HR_SETTINGS.eobi, ...(s.eobi ?? {}) },
    sessi: { ...DEFAULT_HR_SETTINGS.sessi, ...(s.sessi ?? {}) },
  }
}

// ─── Rates ──────────────────────────────────────────────────────────────────

export function dailyRateCents(grossCents: number, s: HrSettings): number {
  return s.workingDaysPerMonth > 0 ? grossCents / s.workingDaysPerMonth : 0
}

export function hourlyRateCents(grossCents: number, s: HrSettings): number {
  return s.hoursPerDay > 0 ? dailyRateCents(grossCents, s) / s.hoursPerDay : 0
}

export function overtimeCents(hours: number, grossCents: number, s: HrSettings, multiplier?: number | null): number {
  if (!(hours > 0)) return 0
  return Math.round(hours * hourlyRateCents(grossCents, s) * (multiplier ?? s.otMultiplier))
}

export interface EobiResult { employeeCents: number; employerCents: number; problem?: string }

export function eobiContribution(grossCents: number, s: HrSettings): EobiResult {
  const base = s.eobi.base === 'gross' ? grossCents : s.eobi.fixedWageCents
  if (base == null) {
    // Refuse to guess. A wrong base is wrong on every payslip and every challan.
    return { employeeCents: 0, employerCents: 0, problem: 'Set the EOBI wage base in HR settings — EOBI is not being calculated' }
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

// ─── Leave ──────────────────────────────────────────────────────────────────

/** The leave year containing `on`, as [start, end]. */
export function leaveYear(on: Date, startMonth: number): [Date, Date] {
  const m = on.getUTCMonth() + 1
  const y = m >= startMonth ? on.getUTCFullYear() : on.getUTCFullYear() - 1
  return [new Date(Date.UTC(y, startMonth - 1, 1)), new Date(Date.UTC(y + 1, startMonth - 1, 0, 23, 59, 59, 999))]
}

export interface LeaveBalance { entitlement: number; adjustments: number; taken: number; pending: number; balance: number }

export function leaveBalance(entitlementDays: number, approvedTaken: number, adjustments: number, pending = 0): LeaveBalance {
  return {
    entitlement: entitlementDays,
    adjustments,
    taken: approvedTaken,
    pending,
    balance: entitlementDays + adjustments - approvedTaken,
  }
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
  if (outstanding <= 0 || loan.installments <= 0) return 0
  if (periodIndex(period) < periodIndex(loan.firstPeriod)) return 0
  const per = Math.floor(loan.amountCents / loan.installments)
  const n = periodIndex(period) - periodIndex(loan.firstPeriod) + 1
  if (n >= loan.installments) return outstanding // last (or overdue) installment clears it
  return Math.min(per, outstanding)
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

export interface PayslipResult {
  lines: PayLine[]
  grossCents: number
  earningsCents: number
  deductionsCents: number
  eobiEmployeeCents: number
  eobiEmployerCents: number
  netCents: number
  warnings: string[]
}

export function computePayslip(
  emp: { grossSalaryCents: number; monthlyTaxCents: number; joiningDate: Date | null; lastWorkingDay: Date | null },
  period: string,
  inputs: PayrollInputs,
  s: HrSettings,
): PayslipResult {
  const warnings: string[] = []
  const lines: PayLine[] = []
  const fraction = employedFraction(period, emp.joiningDate, emp.lastWorkingDay)
  const gross = Math.round(emp.grossSalaryCents * fraction)
  const daily = dailyRateCents(emp.grossSalaryCents, s)

  lines.push({
    kind: 'earning', code: 'salary',
    label: fraction < 1 ? `Salary (${Math.round(fraction * daysInPeriod(period))} of ${daysInPeriod(period)} days)` : 'Salary',
    amountCents: gross,
  })
  if (inputs.otCents > 0) lines.push({ kind: 'earning', code: 'overtime', label: `Overtime (${inputs.otHours} h)`, amountCents: inputs.otCents })
  if (inputs.earningAdjustmentsCents > 0) lines.push({ kind: 'earning', code: 'adjustments', label: 'Bonuses, incentives & allowances', amountCents: inputs.earningAdjustmentsCents })

  if (s.deductAbsences && inputs.absentDays > 0) {
    lines.push({ kind: 'deduction', code: 'absence', label: `Absence (${inputs.absentDays} days)`, amountCents: Math.round(inputs.absentDays * daily) })
  }
  if (inputs.unpaidLeaveDays > 0) {
    lines.push({ kind: 'deduction', code: 'unpaid_leave', label: `Unpaid leave (${inputs.unpaidLeaveDays} days)`, amountCents: Math.round(inputs.unpaidLeaveDays * daily) })
  }
  if (s.latesPerDeductionDay > 0 && inputs.lateCount >= s.latesPerDeductionDay) {
    const days = Math.floor(inputs.lateCount / s.latesPerDeductionDay)
    lines.push({ kind: 'deduction', code: 'late', label: `Late coming (${inputs.lateCount} lates = ${days} day${days === 1 ? '' : 's'})`, amountCents: Math.round(days * daily) })
  }

  const eobi = gross > 0 ? eobiContribution(emp.grossSalaryCents, s) : { employeeCents: 0, employerCents: 0 }
  if (eobi.problem) warnings.push(eobi.problem)
  if (eobi.employeeCents > 0) lines.push({ kind: 'deduction', code: 'eobi_employee', label: `EOBI employee (${s.eobi.employeePct}%)`, amountCents: eobi.employeeCents })
  if (emp.monthlyTaxCents > 0 && gross > 0) lines.push({ kind: 'deduction', code: 'tax', label: 'Income tax', amountCents: emp.monthlyTaxCents })
  if (inputs.loanInstallmentsCents > 0) lines.push({ kind: 'deduction', code: 'loan', label: 'Loan / advance installment', amountCents: inputs.loanInstallmentsCents })
  if (inputs.deductionAdjustmentsCents > 0) lines.push({ kind: 'deduction', code: 'other', label: 'Other deductions', amountCents: inputs.deductionAdjustmentsCents })

  if (eobi.employerCents > 0) lines.push({ kind: 'employer', code: 'eobi_employer', label: `EOBI employer (${s.eobi.employerPct}%)`, amountCents: eobi.employerCents })
  const sessi = gross > 0 ? sessiEmployerCents(emp.grossSalaryCents, s) : 0
  if (sessi > 0) lines.push({ kind: 'employer', code: 'sessi_employer', label: `SESSI employer (${s.sessi.employerPct}%)`, amountCents: sessi })

  const earnings = lines.filter((l) => l.kind === 'earning').reduce((a, l) => a + l.amountCents, 0)
  const deductions = lines.filter((l) => l.kind === 'deduction').reduce((a, l) => a + l.amountCents, 0)
  const net = earnings - deductions
  if (net < 0) warnings.push('Deductions are more than earnings — net pay is negative')
  if (emp.grossSalaryCents <= 0) warnings.push('No gross salary on the employee record')

  return {
    lines, grossCents: gross, earningsCents: earnings, deductionsCents: deductions,
    eobiEmployeeCents: eobi.employeeCents, eobiEmployerCents: eobi.employerCents, netCents: net, warnings,
  }
}

// ─── Full & final ───────────────────────────────────────────────────────────

export interface SettlementInputs {
  unpaidMonthSalary: boolean      // is the final month's salary still owed?
  otPayableCents: number
  leaveBalanceDays: number        // paid leave remaining
  loanOutstandingCents: number
  deductionsCents: number
  otherAdjustmentsCents: number
}

export function finalSettlement(
  emp: { grossSalaryCents: number; joiningDate: Date | null },
  lastWorkingDay: Date,
  inp: SettlementInputs,
  s: HrSettings,
) {
  const period = periodOf(lastWorkingDay)
  const salaryPayable = inp.unpaidMonthSalary
    ? Math.round(emp.grossSalaryCents * employedFraction(period, emp.joiningDate, lastWorkingDay))
    : 0
  const leaveEncashment = s.encashLeaveOnExit && inp.leaveBalanceDays > 0
    ? Math.round(inp.leaveBalanceDays * dailyRateCents(emp.grossSalaryCents, s))
    : 0
  const net = salaryPayable + inp.otPayableCents + leaveEncashment
    - inp.deductionsCents - inp.loanOutstandingCents + inp.otherAdjustmentsCents
  return {
    salaryPayable, otPayable: inp.otPayableCents, leaveEncashment,
    deductions: inp.deductionsCents, loanRecovery: inp.loanOutstandingCents,
    otherAdjustments: inp.otherAdjustmentsCents, netAmount: net,
  }
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
}

const HR_APPROVERS = ['hr', 'admin', 'owner', 'management']
const MGMT_APPROVERS = ['admin', 'owner', 'management']

/**
 * May this person act on this step? HOD means the employee's reporting
 * manager — the manager's own login. If the employee has no manager with a
 * login, HR can act for the HOD so records never get stuck. The CEO (admin)
 * can act on any step, and it is recorded as an override.
 *
 * Nobody approves their own request.
 */
export function canActOnStep(
  role: 'hod' | 'hr' | 'management',
  actor: { id: string; role: string },
  subject: { employeeUserId: string | null; managerUserId: string | null },
): { ok: boolean; override: boolean; reason?: string } {
  if (subject.employeeUserId && subject.employeeUserId === actor.id) {
    return { ok: false, override: false, reason: 'You cannot approve your own request' }
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
