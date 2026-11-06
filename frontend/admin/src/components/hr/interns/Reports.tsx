'use client'
// HR → Interns → Reports: pick a report, set the filters it understands, read it here and export it (CSV / Excel / PDF)
// through the same route with ?format= (GET /hr/interns/reports/:key). The JSON is { columns, rows, sectionKey }.

import { Fragment, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { fmtPkr } from '../../../lib/money'
import { btnGhost, card, inp } from '../../../lib/hr'
import { thisMonth, useInternLookups, type ReportData } from '../../../lib/interns'
import { ExportMenu } from '@/components/ui/ExportMenu'
import { Select } from '@/components/ui/Select'
import { ErrorBox, LoadState } from './ui'

type FilterKey = 'departmentId' | 'supervisorEmployeeId' | 'status' | 'joinedFrom' | 'joinedTo' | 'q' | 'month' | 'from' | 'to' | 'fromMonth' | 'toMonth'

const REPORTS: Array<{ key: string; label: string; hint: string; filters: FilterKey[] }> = [
  { key: 'register', label: 'Intern register (by department)', hint: 'Every intern, grouped by department.', filters: ['departmentId', 'supervisorEmployeeId', 'status', 'joinedFrom', 'joinedTo', 'q'] },
  { key: 'active', label: 'Active interns', hint: 'Interns currently working.', filters: ['departmentId', 'supervisorEmployeeId', 'joinedFrom', 'joinedTo', 'q'] },
  { key: 'completions', label: 'Internship completions', hint: 'Completed internships with duration and certificate.', filters: ['from', 'to', 'departmentId', 'supervisorEmployeeId', 'q'] },
  { key: 'attendance', label: 'Attendance', hint: 'Status counts per intern for a month.', filters: ['month', 'departmentId', 'supervisorEmployeeId', 'q'] },
  { key: 'payroll', label: 'Monthly intern payroll', hint: 'Stipend slips of a month.', filters: ['month', 'departmentId', 'supervisorEmployeeId', 'q'] },
  { key: 'stipend_by_department', label: 'Stipend expense by department', hint: 'Approved and paid stipends over a range of months.', filters: ['fromMonth', 'toMonth', 'departmentId'] },
  { key: 'certificates', label: 'Certificate register', hint: 'Every certificate issued, re-issued and superseded.', filters: ['departmentId', 'supervisorEmployeeId', 'q'] },
]

const monthKeys: Record<string, string> = { fromMonth: 'from', toMonth: 'to' }

export function InternReports() {
  const { data: lk } = useInternLookups()
  const [key, setKey] = useState('register')
  const [f, setF] = useState<Record<string, string>>({ month: thisMonth(), fromMonth: thisMonth(), toMonth: thisMonth() })
  const [exportErr, setExportErr] = useState('')
  const rep = REPORTS.find((r) => r.key === key)!
  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }))
  const params = new URLSearchParams()
  for (const fk of rep.filters) if (f[fk]) params.set(monthKeys[fk] ?? fk, f[fk]!)
  const qs = params.toString()
  const path = `/hr/interns/reports/${key}${qs ? `?${qs}` : ''}`
  const { data, error, isLoading, isFetching, refetch } = useQuery({ queryKey: ['intern-report', key, qs], queryFn: () => api.get<ReportData>(path) })
  const has = (k: FilterKey) => rep.filters.includes(k)

  const cell = (type: string | undefined, v: unknown): string => {
    if (v == null || v === '') return ''
    if (type === 'cents') return fmtPkr(Number(v))
    return String(v)
  }
  const sectionKey = data?.sectionKey
  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <label className="text-[11px] font-bold text-white/55 sm:col-span-2">Report
          <Select className={`${inp} mt-1`} value={key} onChange={(e) => setKey(e.target.value)}>
            {REPORTS.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
          </Select>
          <span className="block text-[11px] font-normal text-white/50 mt-1">{rep.hint}</span>
        </label>
        {has('month') && <label className="text-[11px] font-bold text-white/55">Month<input type="month" className={`${inp} mt-1`} value={f['month']} onChange={(e) => e.target.value && set('month', e.target.value)} /></label>}
        {has('fromMonth') && <label className="text-[11px] font-bold text-white/55">From month<input type="month" className={`${inp} mt-1`} value={f['fromMonth']} onChange={(e) => e.target.value && set('fromMonth', e.target.value)} /></label>}
        {has('toMonth') && <label className="text-[11px] font-bold text-white/55">To month<input type="month" className={`${inp} mt-1`} value={f['toMonth']} onChange={(e) => e.target.value && set('toMonth', e.target.value)} /></label>}
        {has('from') && <label className="text-[11px] font-bold text-white/55">Completed from<input type="date" className={`${inp} mt-1`} value={f['from'] ?? ''} onChange={(e) => set('from', e.target.value)} /></label>}
        {has('to') && <label className="text-[11px] font-bold text-white/55">Completed to<input type="date" className={`${inp} mt-1`} value={f['to'] ?? ''} onChange={(e) => set('to', e.target.value)} /></label>}
        {has('joinedFrom') && <label className="text-[11px] font-bold text-white/55">Joined from<input type="date" className={`${inp} mt-1`} value={f['joinedFrom'] ?? ''} onChange={(e) => set('joinedFrom', e.target.value)} /></label>}
        {has('joinedTo') && <label className="text-[11px] font-bold text-white/55">Joined to<input type="date" className={`${inp} mt-1`} value={f['joinedTo'] ?? ''} onChange={(e) => set('joinedTo', e.target.value)} /></label>}
        {has('departmentId') && (
          <label className="text-[11px] font-bold text-white/55">Department
            <Select className={`${inp} mt-1`} value={f['departmentId'] ?? ''} onChange={(e) => set('departmentId', e.target.value)}>
              <option value="">All departments</option>{(lk?.departments ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </Select>
          </label>
        )}
        {has('supervisorEmployeeId') && (
          <label className="text-[11px] font-bold text-white/55">Supervisor
            <Select className={`${inp} mt-1`} value={f['supervisorEmployeeId'] ?? ''} onChange={(e) => set('supervisorEmployeeId', e.target.value)}>
              <option value="">All supervisors</option>{(lk?.supervisors ?? []).map((s) => <option key={s.id} value={s.id}>{s.fullName}</option>)}
            </Select>
          </label>
        )}
        {has('status') && (
          <label className="text-[11px] font-bold text-white/55">Status
            <Select className={`${inp} mt-1`} value={f['status'] ?? ''} onChange={(e) => set('status', e.target.value)}>
              <option value="">Any status</option>{(lk?.statuses ?? []).map((s) => <option key={s} value={s}>{lk?.statusLabels[s] ?? s}</option>)}
            </Select>
          </label>
        )}
        {has('q') && <label className="text-[11px] font-bold text-white/55">Search<input type="search" className={`${inp} mt-1`} placeholder="Name, ID, CNIC…" value={f['q'] ?? ''} onChange={(e) => set('q', e.target.value)} /></label>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <ExportMenu className={btnGhost} path={path} filename={`intern-${key.replace(/_/g, '-')}${f['month'] && has('month') ? `-${f['month']}` : ''}`} onError={setExportErr} disabled={!data} />
        <span className="text-xs text-white/50" role="status" aria-live="polite">{isFetching && !isLoading ? 'Updating…' : data ? `${data.rows.length} row${data.rows.length === 1 ? '' : 's'}` : ''}</span>
      </div>
      <ErrorBox message={exportErr ? `Export failed: ${exportErr}` : ''} />
      <LoadState loading={isLoading} error={error} onRetry={() => void refetch()} />
      {data && (
        <div>
          <h2 className="text-sm font-black text-white/90">{data.title}{data.period ? <span className="font-normal text-white/60"> · {data.period}</span> : null}</h2>
          <div className="rounded-2xl overflow-x-auto mt-2" style={card}>
            <table className="w-full text-sm">
              <thead><tr className="text-left text-xs uppercase tracking-wider text-white/55">
                {data.columns.filter((c) => c.key !== sectionKey).map((c) => <th key={c.key} className={`px-4 py-3 font-bold whitespace-nowrap${c.type === 'cents' || c.type === 'number' ? ' text-right' : ''}`}>{c.label}</th>)}
              </tr></thead>
              <tbody>
                {data.rows.length === 0 && <tr><td colSpan={data.columns.length} className="px-4 py-10 text-center text-white/50">Nothing matches these filters.</td></tr>}
                {data.rows.map((r, i) => {
                  const section = sectionKey ? String(r[sectionKey] ?? '') : ''
                  const newSection = !!sectionKey && (i === 0 || String(data.rows[i - 1]![sectionKey] ?? '') !== section)
                  const total = r['department'] === 'TOTAL'
                  return (
                    <Fragment key={i}>
                      {newSection && <tr><th colSpan={data.columns.length} scope="colgroup" className="px-4 py-2 text-left text-xs font-black text-white/85 bg-white/[0.04]">{section || '—'}</th></tr>}
                      <tr className={`border-t border-white/[0.05]${total ? ' font-black' : ''}`}>
                        {data.columns.filter((c) => c.key !== sectionKey).map((c) => (
                          <td key={c.key} className={`px-4 py-2.5 text-white/80${c.type === 'cents' || c.type === 'number' ? ' text-right whitespace-nowrap' : ''}`}>{cell(c.type, r[c.key])}</td>
                        ))}
                      </tr>
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
