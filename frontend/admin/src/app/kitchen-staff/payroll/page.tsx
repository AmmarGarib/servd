'use client'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../../lib/api'
import { fmtPkr } from '../../../lib/money'

interface PayrollRun {
  id: string
  staffId: string
  month: number
  year: number
  baseSalary: number
  regularHoursWorked: number
  otHoursRegular: number
  otHoursFestival: number
  hourlyRate: number
  otPayRegular: number
  otPayFestival: number
  mealValue: number
  accommodationValue: number
  grossPay: number
  eobiEmployee: number
  eobiEmployer: number
  sessiEmployer: number
  incomeTaxWithheld: number
  netPay: number
  trueCostToCompany: number
  status: 'draft' | 'locked'
  staff: { fullName: string; kitchenRole: string }
}

const ROLE_LABELS: Record<string, string> = {
  head_chef: 'Head Chef', sous_chef: 'Sous Chef', cdp: 'CDP', demi_chef: 'Demi Chef',
  commis: 'Commis', kitchen_helper: 'Helper', dishwasher: 'Dishwasher',
  baker: 'Baker', tandoor_grill_cook: 'Tandoor/Grill',
}

function downloadCsv(runs: PayrollRun[], month: number, year: number) {
  const headers = ['Name', 'Role', 'Base (PKR)', 'Reg Hrs', 'OT Hrs', 'OT Pay (PKR)', 'Gross (PKR)', 'EOBI Emp (PKR)', 'SESSI (PKR)', 'Net (PKR)', 'True Cost (PKR)', 'Status']
  const rows = runs.map((r) => [
    r.staff.fullName,
    ROLE_LABELS[r.staff.kitchenRole] ?? r.staff.kitchenRole,
    r.baseSalary,
    r.regularHoursWorked.toFixed(1),
    (r.otHoursRegular + r.otHoursFestival).toFixed(1),
    Math.round(r.otPayRegular + r.otPayFestival),
    Math.round(r.grossPay),
    Math.round(r.eobiEmployee),
    Math.round(r.sessiEmployer),
    Math.round(r.netPay),
    Math.round(r.trueCostToCompany),
    r.status,
  ])
  const csv = [headers, ...rows].map((r) => r.map((c) => `"${c}"`).join(',')).join('\n')
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `kitchen-payroll-${year}-${String(month).padStart(2, '0')}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

export default function KitchenPayrollPage() {
  const now = new Date()
  const [month, setMonth] = useState(now.getMonth() + 1)
  const [year, setYear] = useState(now.getFullYear())
  const [confirmGen, setConfirmGen] = useState(false)
  const qc = useQueryClient()

  const { data: runs = [], isLoading } = useQuery<PayrollRun[]>({
    queryKey: ['kitchen-payroll', month, year],
    queryFn: () => api.get<PayrollRun[]>(`/kitchen-staff/payroll/runs?month=${month}&year=${year}`),
  })

  const generate = useMutation({
    mutationFn: () => api.post<PayrollRun[]>('/kitchen-staff/payroll/generate', { month, year }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['kitchen-payroll', month, year] })
      setConfirmGen(false)
    },
  })

  const lockRun = useMutation({
    mutationFn: (id: string) => api.patch(`/kitchen-staff/payroll/runs/${id}/lock`, {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['kitchen-payroll', month, year] }),
  })

  const draftRuns = runs.filter((r) => r.status === 'draft')

  // Totals
  const totals = runs.reduce(
    (acc, r) => ({
      baseSalary: acc.baseSalary + r.baseSalary,
      otPay: acc.otPay + r.otPayRegular + r.otPayFestival,
      grossPay: acc.grossPay + r.grossPay,
      netPay: acc.netPay + r.netPay,
      trueCost: acc.trueCost + r.trueCostToCompany,
      eobiEmployee: acc.eobiEmployee + r.eobiEmployee,
      sessiEmployer: acc.sessiEmployer + r.sessiEmployer,
    }),
    { baseSalary: 0, otPay: 0, grossPay: 0, netPay: 0, trueCost: 0, eobiEmployee: 0, sessiEmployer: 0 },
  )

  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-6 py-4">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <Link href="/kitchen-staff" className="text-xs text-s-muted hover:text-s-text">← Kitchen Staff</Link>
            <h1 className="text-xl font-bold text-s-text mt-0.5">Kitchen Payroll</h1>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            {/* Month / year picker */}
            <div className="flex items-center gap-1">
              <select value={month} onChange={(e) => setMonth(Number(e.target.value))}
                className="s-input text-sm px-2 py-1.5 rounded-lg">
                {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
              </select>
              <select value={year} onChange={(e) => setYear(Number(e.target.value))}
                className="s-input text-sm px-2 py-1.5 rounded-lg">
                {[2024, 2025, 2026].map((y) => <option key={y} value={y}>{y}</option>)}
              </select>
            </div>
            {runs.length > 0 && (
              <button onClick={() => downloadCsv(runs, month, year)}
                className="s-btn-secondary text-xs px-3 py-1.5">
                Export CSV
              </button>
            )}
            {draftRuns.length > 0 && (
              <button
                onClick={() => { for (const r of draftRuns) lockRun.mutate(r.id) }}
                disabled={lockRun.isPending}
                className="s-btn-secondary text-xs px-3 py-1.5">
                Lock All Drafts
              </button>
            )}
            <button onClick={() => setConfirmGen(true)} className="s-btn-primary text-sm">
              Generate Payroll
            </button>
          </div>
        </div>
      </header>

      {/* Confirm modal */}
      {confirmGen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="bg-s-card rounded-2xl p-6 w-full max-w-sm border border-s-border">
            <h2 className="text-lg font-bold text-s-text mb-2">Generate {MONTHS[month - 1]} {year} Payroll?</h2>
            <p className="text-sm text-s-muted mb-5">
              This calculates OT and deductions for all active kitchen staff based on their recorded shifts. Existing draft runs will be overwritten.
            </p>
            <div className="flex gap-3 justify-end">
              <button onClick={() => setConfirmGen(false)} className="s-btn-secondary text-sm">Cancel</button>
              <button onClick={() => generate.mutate()} disabled={generate.isPending} className="s-btn-primary text-sm">
                {generate.isPending ? 'Generating…' : 'Generate'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="px-6 py-6">
        {isLoading && <p className="text-s-muted text-sm">Loading…</p>}

        {!isLoading && runs.length === 0 && (
          <div className="rounded-2xl border border-s-border p-10 text-center">
            <p className="text-3xl mb-3">💰</p>
            <p className="text-s-text font-semibold mb-1">No payroll runs for {MONTHS[month - 1]} {year}</p>
            <p className="text-s-muted text-sm">Click "Generate Payroll" to calculate from recorded shifts.</p>
          </div>
        )}

        {runs.length > 0 && (
          <div className="rounded-2xl border border-s-border overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-s-border bg-s-card/50">
                  <th className="text-left px-4 py-3 text-s-muted font-semibold text-xs uppercase tracking-wide">Staff</th>
                  <th className="text-right px-4 py-3 text-s-muted font-semibold text-xs uppercase tracking-wide">Base</th>
                  <th className="text-right px-4 py-3 text-s-muted font-semibold text-xs uppercase tracking-wide">Reg Hrs</th>
                  <th className="text-right px-4 py-3 text-s-muted font-semibold text-xs uppercase tracking-wide">OT Hrs</th>
                  <th className="text-right px-4 py-3 text-s-muted font-semibold text-xs uppercase tracking-wide">OT Pay</th>
                  <th className="text-right px-4 py-3 text-s-muted font-semibold text-xs uppercase tracking-wide">Gross</th>
                  <th className="text-right px-4 py-3 text-s-muted font-semibold text-xs uppercase tracking-wide">EOBI</th>
                  <th className="text-right px-4 py-3 text-s-muted font-semibold text-xs uppercase tracking-wide">SESSI</th>
                  <th className="text-right px-4 py-3 text-s-muted font-semibold text-xs uppercase tracking-wide">Net Pay</th>
                  <th className="text-right px-4 py-3 text-s-muted font-semibold text-xs uppercase tracking-wide">True Cost</th>
                  <th className="text-center px-4 py-3 text-s-muted font-semibold text-xs uppercase tracking-wide">Status</th>
                  <th className="px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-s-border">
                {runs.map((run) => (
                  <tr key={run.id} className="hover:bg-s-card/30 transition-colors">
                    <td className="px-4 py-3">
                      <p className="font-semibold text-s-text">{run.staff.fullName}</p>
                      <p className="text-xs text-s-muted">{ROLE_LABELS[run.staff.kitchenRole] ?? run.staff.kitchenRole}</p>
                    </td>
                    <td className="px-4 py-3 text-right text-s-text font-mono text-xs">{fmtPkr(run.baseSalary * 100)}</td>
                    <td className="px-4 py-3 text-right text-s-muted font-mono text-xs">{run.regularHoursWorked.toFixed(1)}</td>
                    <td className="px-4 py-3 text-right font-mono text-xs">
                      <span className={(run.otHoursRegular + run.otHoursFestival) > 0 ? 'text-amber-400' : 'text-s-muted'}>
                        {(run.otHoursRegular + run.otHoursFestival).toFixed(1)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-s-text font-mono text-xs">{fmtPkr(Math.round(run.otPayRegular + run.otPayFestival) * 100)}</td>
                    <td className="px-4 py-3 text-right text-s-text font-mono text-xs font-semibold">{fmtPkr(Math.round(run.grossPay) * 100)}</td>
                    <td className="px-4 py-3 text-right text-s-muted font-mono text-xs">{fmtPkr(Math.round(run.eobiEmployee) * 100)}</td>
                    <td className="px-4 py-3 text-right text-s-muted font-mono text-xs">{fmtPkr(Math.round(run.sessiEmployer) * 100)}</td>
                    <td className="px-4 py-3 text-right font-mono text-xs font-bold text-s-teal">{fmtPkr(Math.round(run.netPay) * 100)}</td>
                    <td className="px-4 py-3 text-right font-mono text-xs text-s-muted">{fmtPkr(Math.round(run.trueCostToCompany) * 100)}</td>
                    <td className="px-4 py-3 text-center">
                      <span className={run.status === 'locked' ? 's-badge-teal' : 's-badge-amber'}>
                        {run.status}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {run.status === 'draft' && (
                        <button onClick={() => lockRun.mutate(run.id)} disabled={lockRun.isPending}
                          className="text-xs text-s-muted hover:text-s-text transition-colors">
                          Lock
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
              {/* Totals row */}
              <tfoot>
                <tr className="border-t-2 border-s-border bg-s-card/50">
                  <td className="px-4 py-3 text-s-text font-bold text-sm">Totals ({runs.length} staff)</td>
                  <td className="px-4 py-3 text-right font-mono text-xs font-bold text-s-text">{fmtPkr(totals.baseSalary * 100)}</td>
                  <td colSpan={2} className="px-4 py-3"></td>
                  <td className="px-4 py-3 text-right font-mono text-xs font-bold text-s-text">{fmtPkr(Math.round(totals.otPay) * 100)}</td>
                  <td className="px-4 py-3 text-right font-mono text-xs font-bold text-s-text">{fmtPkr(Math.round(totals.grossPay) * 100)}</td>
                  <td className="px-4 py-3 text-right font-mono text-xs text-s-muted">{fmtPkr(Math.round(totals.eobiEmployee) * 100)}</td>
                  <td className="px-4 py-3 text-right font-mono text-xs text-s-muted">{fmtPkr(Math.round(totals.sessiEmployer) * 100)}</td>
                  <td className="px-4 py-3 text-right font-mono text-sm font-black text-s-teal">{fmtPkr(Math.round(totals.netPay) * 100)}</td>
                  <td className="px-4 py-3 text-right font-mono text-xs font-bold text-s-muted">{fmtPkr(Math.round(totals.trueCost) * 100)}</td>
                  <td colSpan={2} className="px-4 py-3"></td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
