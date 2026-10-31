'use client'
// A payslip's salary breakup (owner, 2026-10-31: "Allowances and all → Total Amount → deduction on attendance →
// gross → Other deductions → Net"). The figures come from the server (backend hr/payslipBreakup.ts, the ONE
// reading shared with the run table and the payroll register); this file only shows them — on screen
// (<SalaryBreakupView>) and in the printed payslip (breakupHtml).

import { rs } from '@/lib/hr'

export interface SalaryBreakup {
  basicCents: number
  allowances: Array<{ name: string; cents: number }>
  allowancesCents: number
  totalSalaryCents: number
  daysNotPaidCents: number
  lateCents: number
  attendanceDeductionCents: number
  otherEarnings: Array<{ label: string; cents: number }>
  overtimeCents: number
  grossCents: number
  taxCents: number
  otherDeductions: Array<{ label: string; cents: number }>
  otherDeductionsCents: number
  eobiCents: number
  netCents: number
  basis: { daysInMonth: number; paidDays: number; absentDays: number; unpaidLeaveDays: number; employedDays: number; dailyRateCents: number } | null
}

type Row = { label: string; cents: number; sign?: '+' | '−' | '='; sub?: boolean; strong?: boolean; note?: string }

/** The breakup as rows, top to bottom: basic, allowances, total salary, attendance, earnings, gross, deductions, net. */
export function breakupRows(k: SalaryBreakup): Row[] {
  const b = k.basis
  const rows: Row[] = []
  if (k.basicCents > 0) rows.push({ label: 'Basic salary', cents: k.basicCents })
  // Allowances as their own block (owner, 2026-10-31: "show allowances breakup in the payslip print too"): the total,
  // then each allowance under it.
  if (k.allowancesCents !== 0) {
    rows.push({ label: 'Allowances', cents: k.allowancesCents, sign: '+' })
    // No named allowances on the employee's record: one line, nothing to break down.
    if (!(k.allowances.length === 1 && k.allowances[0]!.name === 'Allowances')) for (const a of k.allowances) rows.push({ label: a.name, cents: a.cents, sub: true })
  }
  rows.push({ label: 'Total salary', cents: k.totalSalaryCents, sign: '=', strong: true })
  if (k.attendanceDeductionCents !== 0) {
    rows.push({
      label: 'Attendance deduction', cents: k.attendanceDeductionCents, sign: '−',
      note: b ? `paid ${b.paidDays} of ${b.daysInMonth} days · absent ${b.absentDays} · unpaid leave ${b.unpaidLeaveDays} · per-day rate ${rs(b.dailyRateCents)}` : undefined,
    })
    if (k.daysNotPaidCents !== 0) rows.push({ label: 'Days not paid', cents: k.daysNotPaidCents, sub: true })
    if (k.lateCents !== 0) rows.push({ label: 'Late coming', cents: k.lateCents, sub: true })
  }
  for (const e of k.otherEarnings) rows.push({ label: e.label, cents: e.cents, sign: '+' })
  rows.push({ label: 'Gross', cents: k.grossCents, sign: '=', strong: true })
  rows.push({ label: 'Income tax', cents: k.taxCents, sign: '−' })
  if (k.otherDeductionsCents !== 0) {
    rows.push({ label: 'Other deductions', cents: k.otherDeductionsCents, sign: '−' })
    for (const d of k.otherDeductions) rows.push({ label: d.label, cents: d.cents, sub: true })
  }
  if (k.eobiCents !== 0) rows.push({ label: 'EOBI (employee)', cents: k.eobiCents, sign: '−' })
  rows.push({ label: 'Net pay', cents: k.netCents, sign: '=', strong: true })
  return rows
}

export function SalaryBreakupView({ breakup }: { breakup: SalaryBreakup }) {
  return (
    <div>
      {breakupRows(breakup).map((r, i) => (
        <div key={`${r.label}-${i}`} className={`flex justify-between gap-3 py-1 border-b border-white/[0.04] ${r.sub ? 'pl-4 text-xs text-white/50' : 'text-sm'} ${r.strong ? 'font-black' : ''}`}>
          <span className="min-w-0 break-words text-white/80">
            {r.sign && !r.sub ? <span className="inline-block w-4 text-white/40">{r.sign === '=' ? '' : r.sign}</span> : null}
            {r.label}
            {r.note ? <span className="block text-[11px] font-normal text-white/45">{r.note}</span> : null}
          </span>
          <span className={`whitespace-nowrap ${r.strong ? 'text-white/90' : 'text-white/80'}`}>{rs(r.cents)}</span>
        </div>
      ))}
    </div>
  )
}

/** The same rows as HTML for the printed payslip (escaped). */
export function breakupHtml(k: SalaryBreakup): string {
  const esc = (x: string) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return `<table>${breakupRows(k).map((r) => `<tr><td style="${r.sub ? 'padding-left:16px;color:#666;font-size:12px' : ''}${r.strong ? 'font-weight:700' : ''}">${r.sign && !r.sub && r.sign !== '=' ? `${r.sign} ` : ''}${esc(r.label)}${r.note ? `<br><span style="color:#666;font-size:12px">${esc(r.note)}</span>` : ''}</td><td style="text-align:right;${r.strong ? 'font-weight:700' : ''}">${esc(rs(r.cents))}</td></tr>`).join('')}</table>`
}
