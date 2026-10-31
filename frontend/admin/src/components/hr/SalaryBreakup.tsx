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
/** "2026-10" → "October 2026". */
export const payslipMonth = (period: string) => {
  const [y, m] = period.split('-').map(Number)
  return y && m ? new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }) : period
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

/** Opens the payslip in a new window and prints it. */
export function printPayslip(o: { period: string; header?: string | null; particulars: PayslipParticulars; breakup: SalaryBreakup; employerNote?: string }) {
  const esc = (x: string) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const img = safeHeader(o.header)
  const parts = particularRows(o.particulars)
  const grid = `<table class="p">${Array.from({ length: Math.ceil(parts.length / 2) }, (_, i) => {
    const a = parts[i * 2]!, b = parts[i * 2 + 1]
    return `<tr><td class="k">${esc(a[0])}</td><td class="v">${esc(a[1])}</td>${b ? `<td class="k">${esc(b[0])}</td><td class="v">${esc(b[1])}</td>` : '<td></td><td></td>'}</tr>`
  }).join('')}</table>`
  const body = `${img ? `<img class="hdr" src="${img}" alt="">` : ''}
    <h2>Payslip — ${esc(payslipMonth(o.period))}</h2>
    ${grid}
    <h4>Salary</h4>
    ${breakupHtml(o.breakup)}
    ${o.employerNote ? `<p class="note">${esc(o.employerNote)}</p>` : ''}
    <p class="note">This is a computer-generated payslip.</p>`
  const w = window.open('', '_blank'); if (!w) return
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Payslip ${esc(o.particulars.employeeCode)} ${esc(o.period)}</title><style>
    body{font-family:system-ui,Arial,sans-serif;max-width:720px;margin:24px auto;color:#111;padding:0 16px}
    .hdr{width:100%;display:block;margin-bottom:16px}
    h2{margin:8px 0 12px}h4{margin:18px 0 6px;text-transform:uppercase;font-size:12px;letter-spacing:.06em;color:#555}
    table{width:100%;border-collapse:collapse}td{padding:5px 0;border-bottom:1px solid #eee;vertical-align:top}
    table.p td{border:1px solid #ddd;padding:6px 8px;font-size:13px}table.p td.k{color:#555;width:18%}table.p td.v{font-weight:600;width:32%}
    .note{font-size:12px;color:#666}
    @media print{body{margin:0}}
  </style></head><body>${body}</body></html>`)
  w.document.close(); setTimeout(() => w.print(), 400)
}
