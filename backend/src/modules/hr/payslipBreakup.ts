// The salary breakup of a payslip, as the owner reads it (2026-10-31: "Allowances and all → Total Amount → deduction
// on attendance → gross → Other deductions → Net"; "show the same breakup on the payslip and register"):
//
//   Basic + Allowances                         = Total salary (the full monthly salary)
//   − Attendance deduction (days not paid + lates)
//   + Overtime and other earnings              = Gross
//   − Income tax − Other deductions − EOBI     = Net
//
// The ONE reading for the run table, the payslip (HR's and the employee's own) and the payroll register. Display
// only: the payslip engine's lines and totals (hr/logic.ts computePayslip) are never changed, and Net here is always
// the payslip's own net. Basic and the named allowances come from the employee master (read live); whatever of the
// monthly salary they do not cover shows as "Other allowances".

interface Line { kind: string; code: string; label: string; amountCents: number }
interface SlipLike {
  lines: unknown
  inputs: unknown
  earningsCents: number
  eobiEmployeeCents: number
  netCents: number
}
interface EmployeeLike { basicSalaryCents?: number | null; data?: unknown }

export interface SalaryBreakup {
  basicCents: number
  allowances: Array<{ name: string; cents: number }>
  allowancesCents: number
  totalSalaryCents: number
  daysNotPaidCents: number
  lateCents: number
  attendanceDeductionCents: number
  /** Earnings other than the salary (overtime, bonuses), each with its payslip label. */
  otherEarnings: Array<{ label: string; cents: number }>
  overtimeCents: number
  grossCents: number
  taxCents: number
  /** Deductions other than income tax, EOBI and lates, each with its payslip label. */
  otherDeductions: Array<{ label: string; cents: number }>
  otherDeductionsCents: number
  eobiCents: number
  netCents: number
  basis: { daysInMonth: number; paidDays: number; absentDays: number; unpaidLeaveDays: number; employedDays: number; dailyRateCents: number } | null
}

/** The employee master's named allowances (`data.allowances`), positive amounts only. */
export function allowancesOf(data: unknown): Array<{ name: string; amountCents: number }> {
  const raw = (data as Record<string, unknown> | null)?.['allowances']
  if (!Array.isArray(raw)) return []
  return raw.flatMap((a) => {
    const r = (a ?? {}) as Record<string, unknown>
    const cents = Number(r['amountCents'])
    return Number.isFinite(cents) && cents > 0 ? [{ name: String(r['name'] ?? '').trim() || 'Allowance', amountCents: Math.round(cents) }] : []
  })
}

export function salaryBreakup(slip: SlipLike, emp: EmployeeLike): SalaryBreakup {
  const lines = (Array.isArray(slip.lines) ? slip.lines : []) as Line[]
  const sum = (f: (l: Line) => boolean) => lines.filter(f).reduce((a, l) => a + l.amountCents, 0)
  const b = ((slip.inputs as Record<string, unknown> | null)?.['payBasis'] ?? null) as Record<string, number> | null
  const salaryEarned = sum((l) => l.kind === 'earning' && l.code === 'salary')
  const totalSalaryCents = typeof b?.['monthlyGrossCents'] === 'number' ? b['monthlyGrossCents'] : salaryEarned
  const basicCents = Math.max(0, Math.min(emp.basicSalaryCents ?? 0, totalSalaryCents))
  const left = totalSalaryCents - basicCents
  const named = allowancesOf(emp.data).map((x) => ({ name: x.name, cents: x.amountCents }))
  const namedSum = named.reduce((a, x) => a + x.cents, 0)
  const allowances = namedSum > left
    ? (left > 0 ? [{ name: 'Allowances', cents: left }] : [])
    : [...named, ...(left - namedSum > 0 ? [{ name: named.length ? 'Other allowances' : 'Allowances', cents: left - namedSum }] : [])]
  const lateCents = sum((l) => l.kind === 'deduction' && l.code === 'late')
  const daysNotPaidCents = totalSalaryCents - salaryEarned
  const otherEarnings = lines.filter((l) => l.kind === 'earning' && l.code !== 'salary' && l.amountCents !== 0).map((l) => ({ label: l.label, cents: l.amountCents }))
  const grossCents = slip.earningsCents - lateCents
  const taxCents = sum((l) => l.kind === 'deduction' && l.code === 'tax')
  const otherDeductions = lines
    .filter((l) => l.kind === 'deduction' && !['tax', 'eobi_employee', 'late'].includes(l.code) && l.amountCents !== 0)
    .map((l) => ({ label: l.label, cents: l.amountCents }))
  return {
    basicCents,
    allowances,
    allowancesCents: left,
    totalSalaryCents,
    daysNotPaidCents,
    lateCents,
    attendanceDeductionCents: daysNotPaidCents + lateCents,
    otherEarnings,
    overtimeCents: sum((l) => l.kind === 'earning' && l.code === 'overtime'),
    grossCents,
    taxCents,
    otherDeductions,
    // So the breakup always lands on the payslip's own net.
    otherDeductionsCents: grossCents - taxCents - slip.eobiEmployeeCents - slip.netCents,
    eobiCents: slip.eobiEmployeeCents,
    netCents: slip.netCents,
    basis: b && typeof b['paidDays'] === 'number'
      ? { daysInMonth: b['daysInMonth'], paidDays: b['paidDays'], absentDays: b['absentDays'] ?? 0, unpaidLeaveDays: b['unpaidLeaveDays'] ?? 0, employedDays: b['employedDays'] ?? 0, dailyRateCents: b['dailyRateCents'] ?? 0 }
      : null,
  }
}
