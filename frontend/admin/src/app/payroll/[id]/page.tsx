'use client'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useParams } from 'next/navigation'
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

export default function PayrollRunPage() {
  const { id } = useParams<{ id: string }>()
  const qc = useQueryClient()

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

  if (!data) return <div className="p-6 text-s-muted">Loading…</div>

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-6 py-4 flex items-center justify-between">
        <div>
          <Link href="/payroll" className="text-xs text-s-muted hover:text-s-text">← Payroll</Link>
          <h1 className="text-xl font-bold text-s-text">
            Run {data.periodStart.slice(0,10)} → {data.periodEnd.slice(0,10)}
          </h1>
        </div>
        <div className="flex gap-2">
          {data.status === 'draft' && (
            <button onClick={() => post.mutate()} disabled={post.isPending} className="s-btn-primary text-sm">
              {post.isPending ? 'Posting…' : 'Post Accrual'}
            </button>
          )}
          {data.status === 'posted' && (
            <button onClick={() => pay.mutate()} disabled={pay.isPending} className="s-btn-primary text-sm">
              {pay.isPending ? 'Paying…' : 'Mark Paid'}
            </button>
          )}
          {data.status === 'paid' && <span className="s-badge-teal">Paid</span>}
        </div>
      </header>

      <div className="p-6 max-w-5xl">
        <div className="s-card p-4 mb-4 grid grid-cols-3 gap-4">
          <div><p className="text-xs text-s-muted">Status</p><p className="text-s-text font-semibold capitalize">{data.status}</p></div>
          <div><p className="text-xs text-s-muted">Total Gross</p><p className="text-s-text font-semibold">{fmtPkr(data.totalGrossCents)}</p></div>
          <div><p className="text-xs text-s-muted">Lines</p><p className="text-s-text font-semibold">{data.lines.length}</p></div>
        </div>

        <div className="s-card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="text-xs text-s-muted bg-s-bg-soft">
              <tr>
                <th className="px-4 py-2 text-left">Employee</th>
                <th className="px-4 py-2 text-left">Account</th>
                <th className="px-4 py-2 text-right">Hours</th>
                <th className="px-4 py-2 text-right">Rate</th>
                <th className="px-4 py-2 text-right">Gross</th>
                <th className="px-4 py-2 text-right">Adj.</th>
                <th className="px-4 py-2 text-right">Net</th>
                <th className="px-4 py-2 text-left">Notes</th>
              </tr>
            </thead>
            <tbody>
              {data.lines.map((l) => (
                <tr key={l.id} className="border-t border-s-border">
                  <td className="px-4 py-2 text-s-text">{l.userName}</td>
                  <td className="px-4 py-2 font-mono text-xs text-s-muted">{l.wageAccountCode}</td>
                  <td className="px-4 py-2 text-right text-xs text-s-text">{l.hoursWorked.toFixed(2)}</td>
                  <td className="px-4 py-2 text-right font-mono text-xs text-s-text">{fmtPkr(l.hourlyRateCents)}/hr</td>
                  <td className="px-4 py-2 text-right font-mono text-xs text-s-text">{fmtPkr(l.grossCents)}</td>
                  <td className="px-4 py-2 text-right font-mono text-xs text-s-amber">{l.adjustmentCents !== 0 ? fmtPkr(l.adjustmentCents) : ''}</td>
                  <td className="px-4 py-2 text-right font-mono text-sm text-s-text font-semibold">{fmtPkr(l.netCents)}</td>
                  <td className="px-4 py-2 text-xs text-s-muted">{l.notes ?? ''}</td>
                </tr>
              ))}
              {data.lines.length === 0 && (
                <tr><td colSpan={8} className="px-4 py-3 text-xs text-s-muted">No billable lines</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
