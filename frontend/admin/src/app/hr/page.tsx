'use client'
// HR dashboard — spec §1.

import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { card, rs, day } from '../../lib/hr'
import { HrShell, Stat } from '../../components/hr/HrShell'

interface Dash {
  totalEmployees: number; activeEmployees: number; inactiveEmployees: number; newJoiners: number
  resignations: number; terminations: number; onLeaveToday: number
  attendanceToday: { present: number; absent: number; late: number; recorded: number }
  overtimeThisMonth: { hours: number; amountCents: number }
  payroll: { period: string; status: string; totals: { netCents?: number; employees?: number } } | null
  probationDue: number; confirmationDue: number; contractExpiry: number; documentExpiry: number
  byDepartment: Array<{ id: string | null; name: string; count: number }>
  byBranch: Array<{ id: string | null; name: string; count: number }>
  due: Array<{ kind: string; date: string; employeeId?: string; who?: string; what: string }>
}

export default function HrDashboard() {
  const { data: d, error } = useQuery({ queryKey: ['hr-dashboard'], queryFn: () => api.get<Dash>('/hr/dashboard'), refetchInterval: 60_000 })
  return (
    <HrShell title="HR dashboard" subtitle="Headcount, attendance, payroll and everything coming due.">
      {error && <p className="text-sm text-red-400 mb-4">{(error as Error).message}</p>}
      {d && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
            <Stat label="Total employees" value={d.totalEmployees} />
            <Stat label="Active" value={d.activeEmployees} tone="good" />
            <Stat label="Inactive" value={d.inactiveEmployees} />
            <Stat label="New joiners (month)" value={d.newJoiners} />
            <Stat label="Resignations (month)" value={d.resignations} tone={d.resignations ? 'warn' : undefined} />
            <Stat label="Terminations (month)" value={d.terminations} tone={d.terminations ? 'warn' : undefined} />
            <Stat label="On leave today" value={d.onLeaveToday} />
            <Stat label="Present today" value={d.attendanceToday.present} />
            <Stat label="Absent today" value={d.attendanceToday.absent} tone={d.attendanceToday.absent ? 'bad' : undefined} />
            <Stat label="Late today" value={d.attendanceToday.late} tone={d.attendanceToday.late ? 'warn' : undefined} />
            <Stat label="OT hours (month)" value={`${d.overtimeThisMonth.hours} h`} />
            <Stat label="OT cost (month)" value={rs(d.overtimeThisMonth.amountCents)} />
            <Stat label="Probation due (30d)" value={d.probationDue} tone={d.probationDue ? 'warn' : undefined} />
            <Stat label="Confirmation overdue" value={d.confirmationDue} tone={d.confirmationDue ? 'bad' : undefined} />
            <Stat label="Contracts ending (30d)" value={d.contractExpiry} tone={d.contractExpiry ? 'warn' : undefined} />
            <Stat label="Documents expiring (30d)" value={d.documentExpiry} tone={d.documentExpiry ? 'warn' : undefined} />
            <Stat label="Payroll" value={d.payroll ? `${d.payroll.period} · ${d.payroll.status}` : 'None yet'} />
            <Stat label="Last net payroll" value={d.payroll?.totals?.netCents != null ? rs(d.payroll.totals.netCents) : '—'} />
          </div>

          <div className="grid lg:grid-cols-3 gap-4">
            <Breakdown title="Department-wise headcount" rows={d.byDepartment} />
            <Breakdown title="Branch-wise headcount" rows={d.byBranch} />
            <div className="rounded-2xl p-4" style={card}>
              <p className="text-sm font-black text-white/85 mb-3">Coming due</p>
              {d.due.length === 0 && <p className="text-xs text-white/40">Nothing in the next 30 days.</p>}
              <div className="space-y-2 max-h-80 overflow-y-auto">
                {d.due.map((x, i) => (
                  <div key={i} className="flex items-baseline justify-between gap-3 text-xs">
                    <div className="min-w-0">
                      {x.employeeId ? <Link href={`/hr/employees/${x.employeeId}`} className="font-bold text-white/85 hover:underline">{x.who}</Link> : <span className="font-bold text-white/85">{x.what}</span>}
                      {x.employeeId && <span className="text-white/45"> · {x.what}</span>}
                    </div>
                    <span className="shrink-0" style={{ color: new Date(x.date) < new Date() ? '#f87171' : '#f59e0b' }}>{day(x.date)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </HrShell>
  )
}

function Breakdown({ title, rows }: { title: string; rows: Array<{ name: string; count: number }> }) {
  const max = Math.max(1, ...rows.map((r) => r.count))
  return (
    <div className="rounded-2xl p-4" style={card}>
      <p className="text-sm font-black text-white/85 mb-3">{title}</p>
      {rows.length === 0 && <p className="text-xs text-white/40">No employees yet.</p>}
      <div className="space-y-2">
        {rows.map((r) => (
          <div key={r.name} className="text-xs">
            <div className="flex justify-between text-white/70"><span>{r.name}</span><span className="font-bold">{r.count}</span></div>
            <div className="h-1.5 rounded-full bg-white/5 mt-1"><div className="h-full rounded-full bg-kds-green" style={{ width: `${(r.count / max) * 100}%` }} /></div>
          </div>
        ))}
      </div>
    </div>
  )
}
