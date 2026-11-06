'use client'
// Intern stipend payroll — the list of monthly runs and "New month" (POST /hr/interns/payroll/runs). HR starts a run,
// finance reviews and pays, the CEO approves; a run is opened on /hr/interns/payroll/[id].

import Link from 'next/link'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { fmtPkr } from '../../../lib/money'
import { btn, card } from '../../../lib/hr'
import { RUN_BADGE, RUN_STATUS_LABEL, monthLabel, shortDate, thisMonth, type StipendRun } from '../../../lib/interns'
import { useHrAccess } from '../HrShell'
import { ActionDialog, Badge, LoadState } from './ui'

export function StipendRuns() {
  const router = useRouter()
  const qc = useQueryClient()
  const { isHrAdmin } = useHrAccess()
  const [adding, setAdding] = useState(false)
  const { data: runs = [], error, isLoading, refetch } = useQuery({
    queryKey: ['intern-runs'],
    queryFn: () => api.get<{ items: StipendRun[] }>('/hr/interns/payroll/runs').then((r) => r.items),
  })
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-white/65 max-w-2xl">Only paid interns enrolled during the month. Stipend ÷ the month&rsquo;s days × paid days; absences and unpaid leave reduce it. HR prepares, finance checks, the CEO approves, finance pays.</p>
        {isHrAdmin && <button type="button" className={btn} onClick={() => setAdding(true)}>+ New month</button>}
      </div>
      <LoadState loading={isLoading} error={error} onRetry={() => void refetch()} />
      {!isLoading && !error && runs.length === 0 && (
        <div className="rounded-2xl p-8 text-center" style={card}>
          <p className="text-sm text-white/70 mb-3">No stipend payroll has been started yet.</p>
          {isHrAdmin && <button type="button" className={btn} onClick={() => setAdding(true)}>Start the first month</button>}
        </div>
      )}
      {runs.length > 0 && (
        <div className="rounded-2xl overflow-x-auto" style={card}>
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs uppercase tracking-wider text-white/55">
              {['Month', 'Status', 'Interns', 'Net payable', 'Paid on', ''].map((h) => <th key={h} className={`px-4 py-3 font-bold whitespace-nowrap${h === 'Net payable' ? ' text-right' : ''}`}>{h || <span className="sr-only">Open</span>}</th>)}
            </tr></thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className="border-t border-white/[0.05] hover:bg-white/[0.03]">
                  <td className="px-4 py-3 font-bold text-white/90 whitespace-nowrap">{monthLabel(r.period)}</td>
                  <td className="px-4 py-3"><Badge cls={RUN_BADGE[r.status] ?? 's-badge-muted'}>{r.statusLabel ?? RUN_STATUS_LABEL[r.status]}</Badge></td>
                  <td className="px-4 py-3 text-white/75">{r.totals.interns ?? 0}</td>
                  <td className="px-4 py-3 text-white/90 font-bold whitespace-nowrap text-right tabular-nums">{fmtPkr(r.totals.netCents ?? 0)}</td>
                  <td className="px-4 py-3 text-white/70 whitespace-nowrap">{r.paidOn ? shortDate(r.paidOn) : '—'}</td>
                  <td className="px-4 py-3 text-right"><Link href={`/hr/interns/payroll/${r.id}`} className="text-xs font-bold text-primary-ink">Open</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {adding && (
        <ActionDialog title="New stipend payroll" submitLabel="Create payroll"
          intro="Creates the month's stipend slips for every paid intern engaged in it, from their attendance. For the current month or an earlier one."
          fields={[{ key: 'period', label: 'Month', kind: 'month', required: true, initial: thisMonth(), max: thisMonth() }]}
          onClose={() => setAdding(false)}
          onSubmit={async (v) => {
            const run = await api.post<StipendRun>('/hr/interns/payroll/runs', { period: v['period'] })
            void qc.invalidateQueries({ queryKey: ['intern-runs'] })
            router.push(`/hr/interns/payroll/${run.id}`)
          }} />
      )}
    </div>
  )
}
