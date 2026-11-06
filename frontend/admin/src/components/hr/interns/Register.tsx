'use client'
// HR → Interns → Register: every intern of the company in view, with the filters HR asks for. GET /hr/interns.

import Link from 'next/link'
import { useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { btn, btnGhost, card, inp, rs } from '../../../lib/hr'
import { CERT_BADGE, INTERN_BADGE, shortDate, useInternLookups, ymd, type InternRow } from '../../../lib/interns'
import { ExportMenu } from '@/components/ui/ExportMenu'
import { Select } from '@/components/ui/Select'
import { Badge, LoadState } from './ui'

interface Filters { q: string; status: string; departmentId: string; supervisorEmployeeId: string; internshipType: string; joinedFrom: string; joinedTo: string }
const NO_FILTERS: Filters = { q: '', status: '', departmentId: '', supervisorEmployeeId: '', internshipType: '', joinedFrom: '', joinedTo: '' }

export function InternRegister({ initialStatus = '', onEnroll }: { initialStatus?: string; onEnroll: () => void }) {
  const { data: lk } = useInternLookups()
  const [f, setF] = useState<Filters>({ ...NO_FILTERS, status: initialStatus })
  const [exportErr, setExportErr] = useState('')
  const params = new URLSearchParams(Object.entries(f).filter(([, v]) => v))
  const qs = params.toString()
  const { data: rows = [], error, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['interns', qs],
    queryFn: () => api.get<{ items: InternRow[] }>(`/hr/interns${qs ? `?${qs}` : ''}`).then((r) => r.items),
    placeholderData: keepPreviousData,
  })
  const set = (k: keyof Filters, v: string) => setF((p) => ({ ...p, [k]: v }))
  const filtered = Object.values(f).some(Boolean)
  const cols = ['ID', 'Name', 'Department', 'Position', 'Supervisor', 'Start', 'End', 'Type', 'Stipend', 'Status', 'Certificate']
  return (
    <div>
      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-2 mb-4">
        <input type="search" className={`${inp} col-span-2`} placeholder="Search name, ID, CNIC, phone, institution" aria-label="Search interns" value={f.q} onChange={(e) => set('q', e.target.value)} />
        <Select className={inp} aria-label="Status" value={f.status} onChange={(e) => set('status', e.target.value)}>
          <option value="">Any status</option>
          {(lk?.statuses ?? ['draft', 'pending_approval', 'active', 'completed', 'terminated']).map((s) => <option key={s} value={s}>{lk?.statusLabels[s] ?? s}</option>)}
        </Select>
        <Select className={inp} aria-label="Department" value={f.departmentId} onChange={(e) => set('departmentId', e.target.value)}>
          <option value="">Any department</option>
          {(lk?.departments ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </Select>
        <Select className={inp} aria-label="Supervisor" value={f.supervisorEmployeeId} onChange={(e) => set('supervisorEmployeeId', e.target.value)}>
          <option value="">Any supervisor</option>
          {(lk?.supervisors ?? []).map((s) => <option key={s.id} value={s.id}>{s.fullName}</option>)}
        </Select>
        <Select className={inp} aria-label="Type" value={f.internshipType} onChange={(e) => set('internshipType', e.target.value)}>
          <option value="">Paid and unpaid</option><option value="paid">Paid</option><option value="unpaid">Unpaid</option>
        </Select>
        <label className="text-[11px] text-white/55">Joined from<input type="date" className={`${inp} mt-0.5`} value={f.joinedFrom} onChange={(e) => set('joinedFrom', e.target.value)} /></label>
        <label className="text-[11px] text-white/55">Joined to<input type="date" className={`${inp} mt-0.5`} value={f.joinedTo} onChange={(e) => set('joinedTo', e.target.value)} /></label>
        <div className="col-span-2 md:col-span-2 xl:col-span-3 flex flex-wrap items-end gap-2">
          {filtered && <button type="button" className={btnGhost} onClick={() => setF(NO_FILTERS)}>Clear filters</button>}
          <ExportMenu className={btnGhost} path={`/hr/interns/reports/register${qs ? `?${qs}` : ''}`} filename="intern-register" onError={setExportErr} />
          <button type="button" className={btn} onClick={onEnroll}>+ Enroll intern</button>
          <span className="text-xs text-white/50" role="status" aria-live="polite">{isFetching && !isLoading ? 'Updating…' : `${rows.length} intern${rows.length === 1 ? '' : 's'}`}</span>
        </div>
      </div>
      {exportErr && <p className="text-sm mb-3" role="alert" style={{ color: 'var(--erp-danger)' }}>Export failed: {exportErr}</p>}
      <LoadState loading={false} error={error} onRetry={() => void refetch()} />
      <div className="rounded-2xl overflow-x-auto" style={card}>
        <table className="w-full text-sm">
          <thead><tr className="text-left text-xs uppercase tracking-wider text-white/55">{cols.map((h) => <th key={h} className={`px-4 py-3 font-bold whitespace-nowrap${h === 'Stipend' ? ' text-right' : ''}`}>{h}</th>)}</tr></thead>
          <tbody>
            {rows.map((i) => (
              <tr key={i.id} className="border-t border-white/[0.05] hover:bg-white/[0.03]">
                <td className="px-4 py-3 text-white/55 font-mono text-xs whitespace-nowrap">{i.internCode}</td>
                <td className="px-4 py-3 min-w-[10rem]"><Link href={`/hr/interns/${i.id}`} className="font-black text-white/90 hover:underline">{i.fullName}</Link>{i.institution && <p className="text-xs text-white/55">{i.institution}</p>}</td>
                <td className="px-4 py-3 text-white/70">{i.department ?? '—'}</td>
                <td className="px-4 py-3 text-white/70">{i.designation ?? '—'}</td>
                <td className="px-4 py-3 text-white/70 whitespace-nowrap">{i.supervisor?.fullName ?? '—'}</td>
                <td className="px-4 py-3 text-white/70 whitespace-nowrap">{shortDate(i.startDate)}</td>
                <td className="px-4 py-3 text-white/70 whitespace-nowrap">{i.lastDay ? shortDate(i.lastDay) : ymd(i.endDate) ? shortDate(i.endDate) : 'Open'}</td>
                <td className="px-4 py-3 text-white/70">{i.internshipType === 'paid' ? 'Paid' : 'Unpaid'}</td>
                <td className="px-4 py-3 text-white/80 whitespace-nowrap text-right tabular-nums">{i.internshipType === 'paid' ? rs(i.monthlyStipendCents) : '—'}</td>
                <td className="px-4 py-3"><Badge cls={INTERN_BADGE[i.status] ?? 's-badge-muted'}>{i.statusLabel}</Badge></td>
                <td className="px-4 py-3"><Badge cls={CERT_BADGE[i.certificateStatus] ?? 's-badge-muted'}>{i.certificateStatusLabel}</Badge></td>
              </tr>
            ))}
            {isLoading && <tr><td colSpan={cols.length} className="px-4 py-10 text-center text-white/45">Loading interns…</td></tr>}
            {!isLoading && !error && rows.length === 0 && (
              <tr><td colSpan={cols.length} className="px-4 py-10 text-center text-white/50">
                {filtered ? <>No interns match. <button type="button" className="underline font-bold" onClick={() => setF(NO_FILTERS)}>Clear filters</button></>
                  : <>No interns yet. <button type="button" className="underline font-bold" onClick={onEnroll}>Enroll the first intern</button></>}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
