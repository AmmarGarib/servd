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
  let namedSum = named.reduce((a, x) => a + x.cents, 0)
  // Allowances typed as rounded rupees can add up to a rupee or so more than gross − basic (Anusha: 23,704 + 5,926 +
  // 11,852 = 41,482 against 41,481). Up to one rupee per allowance is rounding: the largest allowance gives it back,
  // so the breakdown still shows and still adds up to the salary. Anything bigger is a real mismatch (one line).
  const excess = namedSum - left
  if (excess > 0 && excess <= 100 * named.length && named.length > 0) {
    const big = named.reduce((m, x) => (x.cents > m.cents ? x : m), named[0]!)
    big.cents -= excess
    namedSum -= excess
  }
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

// ── One column per allowance across a run (owner, 2026-11-01: "Duplication" — "Medical Allowane" on one record made a
// second Medical column). Names are typed per employee, so a run's allowances are grouped by a key that ignores case,
// spaces and punctuation, and a slip within two letters of a longer, more-used name joins it. Each group takes its
// most-used spelling. Display only: the employee records are unchanged (fix the typo there too).
const keyOf = (n: string) => n.toLowerCase().replace(/[^a-z0-9]+/g, '')
function editDistance(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]!
    d[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cur = d[j]!
      d[j] = Math.min(d[j]! + 1, d[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = cur
    }
  }
  return d[b.length]!
}
export function unifyAllowanceNames(breakups: SalaryBreakup[]): void {
  const count = new Map<string, Map<string, number>>() // key → spelling → uses
  for (const k of breakups) for (const a of k.allowances) {
    const key = keyOf(a.name)
    const m = count.get(key) ?? new Map<string, number>()
    m.set(a.name, (m.get(a.name) ?? 0) + 1)
    count.set(key, m)
  }
  const uses = (key: string) => [...count.get(key)!.values()].reduce((a, b) => a + b, 0)
  // Most-used keys first: a rarer key within 2 letters of one (both ≥ 6 letters) joins it.
  const keys = [...count.keys()].sort((a, b) => uses(b) - uses(a) || b.length - a.length)
  const into = new Map<string, string>()
  for (const k of keys) {
    const host = keys.find((h) => h !== k && into.get(h) === h && uses(h) >= uses(k) && h.length >= 6 && k.length >= 6 && editDistance(h, k) <= 2 && keys.indexOf(h) < keys.indexOf(k))
    into.set(k, host ?? k)
  }
  const label = new Map<string, string>()
  for (const k of keys) {
    if (into.get(k) !== k) continue
    let best = '', n = -1
    for (const [key, m] of count) if (into.get(key) === k) for (const [sp, c] of m) if (c > n) { best = sp; n = c }
    label.set(k, best)
  }
  for (const b of breakups) {
    const merged = new Map<string, number>()
    for (const a of b.allowances) {
      const name = label.get(into.get(keyOf(a.name))!) ?? a.name
      merged.set(name, (merged.get(name) ?? 0) + a.cents)
    }
    b.allowances = [...merged].map(([name, cents]) => ({ name, cents }))
  }
}
