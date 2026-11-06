'use client'
// HR → Interns → Dashboard: headcount by status, paid / unpaid, department-wise bars, this month's stipend, certificates,
// who is ending soon and what waits for approval. GET /hr/interns/dashboard.

import Link from 'next/link'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { fmtPkr } from '../../../lib/money'
import { btn, card, inp } from '../../../lib/hr'
import { RUN_STATUS_LABEL, monthLabel, shortDate, thisMonth, type DashboardData } from '../../../lib/interns'
import { Stat } from '../HrShell'
import { ChartCard, HBars } from '../performance/charts'
import { LoadState, Note } from './ui'

export function InternDashboard({ onEnroll }: { onEnroll: () => void }) {
  const [month, setMonth] = useState(thisMonth())
  const { data, error, isLoading, refetch } = useQuery({
    queryKey: ['intern-dashboard', month],
    queryFn: () => api.get<DashboardData>(`/hr/interns/dashboard?month=${month}`),
  })
  if (isLoading || error) return <LoadState loading={isLoading} error={error} onRetry={() => void refetch()} />
  if (!data) return null
  if (data.total === 0) {
    return (
      <div className="rounded-2xl p-8 text-center" style={card}>
        <p className="text-sm text-white/70 mb-3">No interns yet.</p>
        <button type="button" className={btn} onClick={onEnroll}>Enroll the first intern</button>
      </div>
    )
  }
  const maxDept = Math.max(1, ...data.byDepartment.map((d) => d.count))
  const run = data.stipend.runStatus
  const runText = run === 'none' ? 'No payroll yet' : run === 'mixed' ? 'Several runs' : (RUN_STATUS_LABEL[run] ?? run)
  const s = (k: string) => data.byStatus[k] ?? 0
  return (
    <div className="space-y-5">
      {data.pendingApproval > 0 && (
        <Note tone="warn">
          {data.pendingApproval} enrolment{data.pendingApproval === 1 ? ' is' : 's are'} waiting for the CEO.{' '}
          <Link href="/hr/interns?tab=register&status=pending_approval" className="font-bold underline">Show them</Link>
        </Note>
      )}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Total interns" value={data.total} />
        <Stat label="Active" value={s('active')} tone="good" />
        <Stat label="Pending approval" value={s('pending_approval')} tone={s('pending_approval') ? 'warn' : undefined} />
        <Stat label="Completed" value={s('completed')} />
        <Stat label="Terminated" value={s('terminated')} tone={s('terminated') ? 'bad' : undefined} />
        <Stat label="Paid (active)" value={data.paid} />
        <Stat label="Unpaid (active)" value={data.unpaid} />
        <Stat label="Certificates issued" value={`${data.certificatesIssued}`} />
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        <ChartCard title="Active interns by department" hint="Current headcount">
          <HBars rows={data.byDepartment.map((d) => ({ label: d.name, value: d.count, display: String(d.count) }))} max={maxDept} empty="No active interns." />
        </ChartCard>
        <ChartCard title="Stipend expense" hint={monthLabel(data.stipend.period)}>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="text-2xl font-black text-white/90">{fmtPkr(data.stipend.netCents)}</p>
              <p className="text-xs text-white/60 mt-0.5">{runText}</p>
              <p className="text-xs text-white/60">{data.certificatesIssuedThisMonth} certificate{data.certificatesIssuedThisMonth === 1 ? '' : 's'} issued this month</p>
            </div>
            <label className="text-xs text-white/60">Month
              <input type="month" className={`${inp} mt-1`} value={month} max={thisMonth()} onChange={(e) => e.target.value && setMonth(e.target.value)} />
            </label>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {data.stipend.runs.map((r) => (
              <Link key={r.id} href={`/hr/interns/payroll/${r.id}`} className="text-xs font-bold text-primary-ink underline">Open the {monthLabel(data.stipend.period)} payroll</Link>
            ))}
            <Link href="/hr/interns?tab=payroll" className="text-xs font-bold text-primary-ink underline">All stipend payrolls</Link>
          </div>
        </ChartCard>
      </div>

      <ChartCard title="Ending soon" hint="Active internships ending within 14 days (or already past their end date)">
        {data.endingSoon.length === 0 ? <p className="text-sm text-white/55">Nobody is ending soon.</p> : (
          <ul className="divide-y divide-white/[0.06]">
            {data.endingSoon.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <Link href={`/hr/interns/${i.id}`} className="text-sm font-bold text-white/90 hover:underline break-words">{i.fullName} <span className="text-xs font-normal text-white/55">· {i.internCode}</span></Link>
                <span className="text-xs text-white/70">Ends {shortDate(i.endDate)}</span>
              </li>
            ))}
          </ul>
        )}
      </ChartCard>
    </div>
  )
}
