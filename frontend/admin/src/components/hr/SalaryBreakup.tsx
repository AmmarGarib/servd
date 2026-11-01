'use client'
// A payslip's salary breakup (owner, 2026-10-31: "Allowances and all → Total Amount → deduction on attendance →
// gross → Other deductions → Net"). The figures come from the server (backend hr/payslipBreakup.ts, the ONE
// reading shared with the run table and the payroll register); this file only shows them — on screen
// (<SalaryBreakupView>); the PDF is made by the server (backend hr/payslipPdf.ts).

import { useState } from 'react'
import { rs } from '@/lib/hr'
import { api } from '@/lib/api'
import { FileViewModal } from '@/components/files/FileViewModal'

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

// ─── The payslip document (owner, 2026-10-31: "let's build Payslip now") ─────────────────────────────────────────
// The company's header image, the particulars, then the breakup. The same layout on screen and in print.

export interface PayslipParticulars {
  employeeName: string
  employeeCode: string
  joiningDate: string | null
  department: string | null
  designation: string | null
  employmentType: string | null
  cnic: string | null
  monthDays: number | null
  paidDays: number | null
}

const fmtDay = (d: string | null) => {
  if (!d) return '—'
  const [y, m, dd] = d.split('-').map(Number)
  return new Date(Date.UTC(y!, (m ?? 1) - 1, dd ?? 1)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
}
/** The particulars in the owner's order. */
export function particularRows(p: PayslipParticulars): Array<[string, string]> {
  return [
    ['Employee name', p.employeeName],
    ['Employee ID', p.employeeCode],
    ['Date of joining', fmtDay(p.joiningDate)],
    ['Department', p.department ?? '—'],
    ['Designation', p.designation ?? '—'],
    ['Employment type', p.employmentType ?? '—'],
    ['CNIC number', p.cnic ?? '—'],
    ['Month days', p.monthDays == null ? '—' : String(p.monthDays)],
    ['Paid days', p.paidDays == null ? '—' : String(p.paidDays)],
  ]
}

/** Only a stored image data URL is ever used as the header (never a link). */
const safeHeader = (h: string | null | undefined) => (h && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(h) ? h : null)

export function PayslipParticularsView({ particulars, header }: { particulars: PayslipParticulars; header?: string | null }) {
  const img = safeHeader(header)
  return (
    <div className="mb-3">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {img && <img src={img} alt="Company header" className="w-full rounded-lg mb-3 object-contain" />}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        {particularRows(particulars).map(([k, v]) => (
          <div key={k} className="min-w-0">
            <dt className="text-white/45">{k}</dt>
            <dd className="font-bold text-white/85 break-words">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

/** The payslip PDF the server makes (owner, 2026-11-01: A4, navy and light grey — backend hr/payslipPdf.ts):
 *  View opens it here, Download saves it. `path` is the API path of the PDF. */
export function PayslipPdfButtons({ path, filename, className, label = 'payslip' }: { path: string; filename: string; className: string; label?: string }) {
  const [viewing, setViewing] = useState(false)
  const [err, setErr] = useState('')
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button type="button" className={className} onClick={() => setViewing(true)}>View {label} (PDF)</button>
      <button type="button" className={className} onClick={() => { setErr(''); api.download(`${path}?download=1`, `${filename}.pdf`).catch((e: Error) => setErr(e.message)) }}>Download PDF</button>
      {err && <span role="alert" className="text-xs" style={{ color: 'var(--erp-danger)' }}>{err}</span>}
      {viewing && <FileViewModal path={path} mime="application/pdf" name={`${filename}.pdf`} onClose={() => setViewing(false)} />}
    </span>
  )
}
