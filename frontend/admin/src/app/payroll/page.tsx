'use client'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../lib/api'
import { fmtPkr, todayPktIso, startOfMonthPktIso } from '../../lib/money'
import Link from 'next/link'

interface RunSummary {
  id: string; periodStart: string; periodEnd: string; status: 'draft'|'posted'|'paid'
  totalGrossCents: number
  _count: { lines: number }
}

interface LabourPct {
  revenueCents: number; labourCents: number; labourPct: number
  byWageAccount: Array<{ code: string; cents: number }>
}

export default function PayrollHubPage() {
  const qc = useQueryClient()
  const [from, setFrom] = useState(startOfMonthPktIso())
  const [to,   setTo]   = useState(todayPktIso())

  const { data: runs } = useQuery({
    queryKey: ['payroll-runs'],
    queryFn: () => api.get<RunSummary[]>('/payroll/runs'),
  })

  const { data: labour } = useQuery({
    queryKey: ['labour-pct', from, to],
    queryFn: () => api.get<LabourPct>(`/payroll/labour-pct?dateFrom=${from}&dateTo=${to}`),
  })

  const create = useMutation({
    mutationFn: () => api.post('/payroll/runs', { periodStart: from, periodEnd: to }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['payroll-runs'] }),
  })

  const statusColor: Record<string, string> = {
    draft: 's-badge-muted',
    posted: 's-badge-amber',
    paid: 's-badge-teal',
  }

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-6 py-4">
        <h1 className="text-xl font-bold text-s-text">Payroll</h1>
      </header>

      <div className="p-6 max-w-5xl space-y-4">
        {/* Labour KPI */}
        <div className="s-card p-4">
          <div className="flex flex-wrap items-start justify-between gap-4 mb-3">
            <div>
              <p className="text-xs text-s-muted uppercase tracking-wide font-semibold">Labour as % of revenue</p>
              {labour ? (
                <div className="flex items-end gap-3 mt-1">
                  <p className={`text-4xl font-black ${labour.labourPct > 35 ? 'text-s-red' : labour.labourPct > 28 ? 'text-s-amber' : 'text-s-teal'}`}>
                    {labour.labourPct.toFixed(1)}%
                  </p>
                  <p className="text-xs text-s-muted mb-1.5">
                    {labour.labourPct > 35 ? '⚠ Above healthy range' : labour.labourPct > 28 ? '~ Within range' : '✓ Healthy'}
                  </p>
                </div>
              ) : (
                <p className="text-3xl font-black text-s-muted mt-1">—</p>
              )}
            </div>
            <div className="flex gap-2 items-center">
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="bg-s-card border border-s-border rounded px-2 py-1 text-sm text-s-text" />
              <span className="text-s-muted text-xs">→</span>
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="bg-s-card border border-s-border rounded px-2 py-1 text-sm text-s-text" />
            </div>
          </div>
          {labour && (
            <div className="grid grid-cols-3 gap-3 text-sm border-t border-s-border pt-3 mt-1">
              <div>
                <p className="text-xs text-s-muted">Revenue</p>
                <p className="text-s-text font-semibold">{fmtPkr(labour.revenueCents)}</p>
              </div>
              <div>
                <p className="text-xs text-s-muted">Labour cost</p>
                <p className="text-s-text font-semibold">{fmtPkr(labour.labourCents)}</p>
              </div>
              {labour.byWageAccount?.length > 0 && (
                <div>
                  <p className="text-xs text-s-muted">Accounts</p>
                  <p className="text-s-text font-semibold">{labour.byWageAccount.length}</p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* New run */}
        <div className="s-card p-4 flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold text-s-text">Run payroll for selected period</p>
            <p className="text-xs text-s-muted">Computes hours from clock logs × hourly rate. Creates a draft run.</p>
          </div>
          <button onClick={() => create.mutate()} disabled={create.isPending} className="s-btn-primary text-sm">
            {create.isPending ? 'Computing…' : 'New Run'}
          </button>
        </div>

        {/* Runs list */}
        <div className="s-card overflow-hidden">
          <div className="px-4 py-2 bg-s-bg-soft border-b border-s-border text-xs font-semibold text-s-text">Runs ({runs?.length ?? 0})</div>
          <table className="w-full text-sm">
            <thead className="text-xs text-s-muted">
              <tr>
                <th className="px-4 py-2 text-left">Period</th>
                <th className="px-4 py-2 text-left">Lines</th>
                <th className="px-4 py-2 text-right">Total</th>
                <th className="px-4 py-2 text-left">Status</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {runs?.map((r) => (
                <tr key={r.id} className="border-t border-s-border">
                  <td className="px-4 py-2 text-s-text">{r.periodStart.slice(0,10)} → {r.periodEnd.slice(0,10)}</td>
                  <td className="px-4 py-2 text-xs text-s-muted">{r._count.lines}</td>
                  <td className="px-4 py-2 text-right font-mono text-xs text-s-text">{fmtPkr(r.totalGrossCents)}</td>
                  <td className="px-4 py-2"><span className={statusColor[r.status]}>{r.status}</span></td>
                  <td className="px-4 py-2 text-right">
                    <Link href={`/payroll/${r.id}`} className="text-s-teal text-xs hover:underline">Open →</Link>
                  </td>
                </tr>
              ))}
              {(!runs || runs.length === 0) && (
                <tr><td colSpan={5} className="px-4 py-3 text-xs text-s-muted">No payroll runs yet</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
