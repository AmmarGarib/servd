'use client'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useParams } from 'next/navigation'
import { useState } from 'react'
import { api } from '../../../lib/api'
import { fmtPkr } from '../../../lib/money'
import Link from 'next/link'

interface RunDetail {
  id: string; periodStart: string; periodEnd: string
  status: 'draft'|'posted'|'paid'
  totalGrossCents: number
  postedAt: string | null; paidAt: string | null
  notes: string | null
  lines: Array<{
    id: string; userId: string; userName: string
    hoursWorked: number; hourlyRateCents: number
    grossCents: number; adjustmentCents: number; netCents: number
    wageAccountCode: string; notes: string | null
  }>
}

const STATUS_COLOR: Record<string, string> = {
  draft:  's-badge-muted',
  posted: 's-badge-amber',
  paid:   's-badge-teal',
}

function downloadCsv(data: RunDetail) {
  const rows = [
    ['Name', 'Hours', 'Rate (PKR/hr)', 'Gross (PKR)', 'Adjustments (PKR)', 'Net (PKR)'],
    ...data.lines.map((l) => [
      l.userName,
      l.hoursWorked.toFixed(2),
      (l.hourlyRateCents / 100).toFixed(0),
      (l.grossCents / 100).toFixed(0),
      (l.adjustmentCents / 100).toFixed(0),
      (l.netCents / 100).toFixed(0),
    ]),
  ]
  const csv = rows.map((r) => r.map((c) => `"${c}"`).join(',')).join('\n')
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `payroll-run-${data.periodStart.slice(0,10)}-${data.periodEnd.slice(0,10)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

export default function PayrollRunPage() {
  const { id } = useParams<{ id: string }>()
  const qc = useQueryClient()

  // Per-line inline adjust state: { [lineId]: { open, amount, notes } }
  const [adjusting, setAdjusting] = useState<Record<string, { open: boolean; amount: string; notes: string }>>({})

  const { data } = useQuery({
    queryKey: ['payroll-run', id],
    queryFn: () => api.get<RunDetail>(`/payroll/runs/${id}`),
  })

  const post = useMutation({
    mutationFn: () => api.post(`/payroll/runs/${id}/post`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['payroll-run', id] }),
  })
  const pay = useMutation({
    mutationFn: () => api.post(`/payroll/runs/${id}/pay`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['payroll-run', id] }),
  })
  const adjust = useMutation({
    mutationFn: ({ lineId, adjustmentCents, notes }: { lineId: string; adjustmentCents: number; notes: string }) =>
      api.patch(`/payroll/lines/${lineId}`, { adjustmentCents, notes }),
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: ['payroll-run', id] })
      setAdjusting((prev) => ({ ...prev, [vars.lineId]: { open: false, amount: '', notes: '' } }))
    },
  })

  if (!data) return <div className="p-6 text-s-muted">Loading…</div>

  const netTotal = data.lines.reduce((s, l) => s + l.netCents, 0)
  const adjTotal = data.lines.reduce((s, l) => s + l.adjustmentCents, 0)

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-6 py-4 flex items-center justify-between">
        <div>
          <Link href="/payroll" className="text-xs text-s-muted hover:text-s-text">← Payroll</Link>
          <h1 className="text-xl font-bold text-s-text mt-0.5">
            {data.periodStart.slice(0,10)} → {data.periodEnd.slice(0,10)}
          </h1>
        </div>
        <div className="flex gap-2 items-center">
          <span className={STATUS_COLOR[data.status]}>{data.status}</span>
          {data.status === 'draft' && (
            <button onClick={() => post.mutate()} disabled={post.isPending} className="s-btn-primary text-sm">
              {post.isPending ? 'Posting…' : 'Post to GL'}
            </button>
          )}
          {data.status === 'posted' && (
            <button onClick={() => pay.mutate()} disabled={pay.isPending} className="s-btn-primary text-sm">
              {pay.isPending ? 'Paying…' : 'Mark Paid'}
            </button>
          )}
          <button
            onClick={() => downloadCsv(data)}
            className="rounded-lg border border-s-border text-s-muted px-3 py-1.5 text-xs hover:text-s-text hover:border-s-teal transition-colors">
            Export CSV
          </button>
        </div>
      </header>

      <div className="p-6 max-w-5xl space-y-4">
        {/* Summary cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="s-card p-4">
            <p className="text-xs text-s-muted">Total Gross</p>
            <p className="text-xl font-bold text-s-text mt-0.5">{fmtPkr(data.totalGrossCents)}</p>
          </div>
          <div className="s-card p-4">
            <p className="text-xs text-s-muted">Adjustments</p>
            <p className={`text-xl font-bold mt-0.5 ${adjTotal < 0 ? 'text-s-red' : adjTotal > 0 ? 'text-s-amber' : 'text-s-muted'}`}>
              {adjTotal !== 0 ? fmtPkr(adjTotal) : '—'}
            </p>
          </div>
          <div className="s-card p-4">
            <p className="text-xs text-s-muted">Net Payable</p>
            <p className="text-xl font-bold text-s-teal mt-0.5">{fmtPkr(netTotal)}</p>
          </div>
          <div className="s-card p-4">
            <p className="text-xs text-s-muted">Employees</p>
            <p className="text-xl font-bold text-s-text mt-0.5">{data.lines.length}</p>
          </div>
        </div>

        {/* Lines table */}
        <div className="s-card overflow-hidden">
          <div className="px-4 py-2 bg-s-bg-soft border-b border-s-border text-xs font-semibold text-s-text">
            Payroll lines
          </div>
          <table className="w-full text-sm">
            <thead className="text-xs text-s-muted bg-s-bg-soft">
              <tr>
                <th className="px-4 py-2 text-left">Employee</th>
                <th className="px-4 py-2 text-left">Account</th>
                <th className="px-4 py-2 text-right">Hours</th>
                <th className="px-4 py-2 text-right">Rate</th>
                <th className="px-4 py-2 text-right">Gross</th>
                <th className="px-4 py-2 text-right">Adj.</th>
                <th className="px-4 py-2 text-right font-semibold">Net</th>
                <th className="px-4 py-2 text-left">Notes</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {data.lines.map((l) => {
                const adj = adjusting[l.id] ?? { open: false, amount: '', notes: '' }
                return (
                  <>
                    <tr key={l.id} className="border-t border-s-border hover:bg-s-bg-soft/40">
                      <td className="px-4 py-2.5 text-s-text font-medium">{l.userName}</td>
                      <td className="px-4 py-2.5 font-mono text-xs text-s-muted">{l.wageAccountCode}</td>
                      <td className="px-4 py-2.5 text-right text-xs text-s-text">{l.hoursWorked.toFixed(2)}</td>
                      <td className="px-4 py-2.5 text-right font-mono text-xs text-s-text">{fmtPkr(l.hourlyRateCents)}/hr</td>
                      <td className="px-4 py-2.5 text-right font-mono text-xs text-s-text">{fmtPkr(l.grossCents)}</td>
                      <td className="px-4 py-2.5 text-right font-mono text-xs text-s-amber">
                        {l.adjustmentCents !== 0 ? fmtPkr(l.adjustmentCents) : <span className="text-s-muted">—</span>}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-sm text-s-text font-semibold">{fmtPkr(l.netCents)}</td>
                      <td className="px-4 py-2.5 text-xs text-s-muted max-w-[140px] truncate">{l.notes ?? ''}</td>
                      <td className="px-4 py-2.5 text-right">
                        {data.status === 'draft' && (
                          <button
                            onClick={() => setAdjusting((prev) => ({
                              ...prev,
                              [l.id]: prev[l.id]?.open
                                ? { open: false, amount: '', notes: '' }
                                : { open: true, amount: String(l.adjustmentCents / 100), notes: l.notes ?? '' },
                            }))}
                            className="text-xs px-2 py-1 rounded border border-s-border text-s-muted hover:border-s-teal hover:text-s-teal transition-colors">
                            Adjust
                          </button>
                        )}
                      </td>
                    </tr>
                    {adj.open && (
                      <tr key={`${l.id}-adj`} className="border-t border-s-border bg-s-bg-soft/60">
                        <td colSpan={9} className="px-4 py-3">
                          <div className="flex flex-wrap items-center gap-3">
                            <div className="flex flex-col gap-0.5">
                              <label className="text-xs text-s-muted">Adjustment (PKR, can be negative)</label>
                              <input
                                type="number"
                                value={adj.amount}
                                onChange={(e) => setAdjusting((prev) => ({ ...prev, [l.id]: { ...adj, amount: e.target.value } }))}
                                placeholder="0"
                                className="w-32 rounded-lg bg-s-bg border border-s-border px-2 py-1.5 text-sm text-s-text focus:border-s-teal focus:outline-none"
                              />
                            </div>
                            <div className="flex flex-col gap-0.5 flex-1 min-w-[180px]">
                              <label className="text-xs text-s-muted">Notes / reason</label>
                              <input
                                value={adj.notes}
                                onChange={(e) => setAdjusting((prev) => ({ ...prev, [l.id]: { ...adj, notes: e.target.value } }))}
                                placeholder="Bonus, deduction reason…"
                                className="w-full rounded-lg bg-s-bg border border-s-border px-2 py-1.5 text-sm text-s-text focus:border-s-teal focus:outline-none"
                              />
                            </div>
                            <div className="flex gap-2 items-end">
                              <button
                                onClick={() => adjust.mutate({ lineId: l.id, adjustmentCents: Math.round(Number(adj.amount) * 100), notes: adj.notes })}
                                disabled={adjust.isPending}
                                className="rounded-lg bg-s-teal text-white font-bold px-3 py-1.5 text-xs hover:opacity-90 disabled:opacity-50">
                                {adjust.isPending ? 'Saving…' : 'Save'}
                              </button>
                              <button
                                onClick={() => setAdjusting((prev) => ({ ...prev, [l.id]: { open: false, amount: '', notes: '' } }))}
                                className="rounded-lg border border-s-border text-s-muted px-3 py-1.5 text-xs">
                                Cancel
                              </button>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                )
              })}
              {data.lines.length === 0 && (
                <tr><td colSpan={9} className="px-4 py-3 text-xs text-s-muted">No billable lines</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
