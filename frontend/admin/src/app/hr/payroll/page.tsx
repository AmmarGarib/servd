'use client'
// Payroll runs — spec §14.

import Link from 'next/link'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { api } from '../../../lib/api'
import { card, btn, rs, human, STATUS_COLOR } from '../../../lib/hr'
import { HrShell } from '../../../components/hr/HrShell'

interface Run { id: string; period: string; status: string; totals: { employees?: number; netCents?: number; grossCents?: number; warnings?: string[] }; createdAt: string }

export default function PayrollRunsPage() {
  const router = useRouter()
  const qc = useQueryClient()
  const now = new Date()
  const [period, setPeriod] = useState(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`)
  const [err, setErr] = useState('')
  const { data: runs = [] } = useQuery({ queryKey: ['hr-payroll-runs'], queryFn: () => api.get<Run[]>('/hr/payroll/runs') })
  const create = useMutation({
    mutationFn: () => api.post<Run>('/hr/payroll/runs', { period }),
    onSuccess: (r) => { void qc.invalidateQueries(); router.push(`/hr/payroll/${r.id}`) },
    onError: (e: Error) => setErr(e.message),
  })
  return (
    <HrShell title="Payroll" subtitle="Each month is calculated from attendance, leave, approved overtime, adjustments and loans. Check it, have someone else approve it, then lock it.">
      <div className="rounded-2xl p-4 flex flex-wrap items-center gap-3 mb-5" style={card}>
        <p className="text-sm font-bold text-white/85">Run payroll for</p>
        <input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} aria-label="Month"
          className="rounded-lg px-3 py-1.5 text-sm bg-white/[0.04] border border-white/10 text-white/90" />
        <button className={btn} disabled={create.isPending} onClick={() => { setErr(''); create.mutate() }}>{create.isPending ? 'Calculating…' : 'Calculate'}</button>
        {err && <p className="text-xs text-red-700">{err}</p>}
      </div>
      <div className="rounded-2xl overflow-hidden" style={card}>
        {runs.length === 0 && <p className="p-8 text-center text-sm text-white/40">No payroll yet.</p>}
        {runs.map((r) => (
          <Link key={r.id} href={`/hr/payroll/${r.id}`} className="px-4 py-3 border-t border-white/[0.05] first:border-t-0 flex items-center gap-4 text-sm hover:bg-white/[0.03]">
            <span className="font-black text-white/90 w-24">{r.period}</span>
            <span className="text-white/60">{r.totals.employees ?? 0} employees</span>
            <span className="text-white/80">Net {rs(r.totals.netCents ?? 0)}</span>
            {(r.totals.warnings?.length ?? 0) > 0 && <span className="text-xs text-amber-700">{r.totals.warnings!.length} warning(s)</span>}
            <span className="ml-auto text-xs font-bold" style={{ color: STATUS_COLOR[r.status] ?? '#a15c00' }}>{human(r.status)}</span>
          </Link>
        ))}
      </div>
    </HrShell>
  )
}
