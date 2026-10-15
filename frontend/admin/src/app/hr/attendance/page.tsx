'use client'
// Attendance for a day: every punch (time clock, tablet, kiosk PIN) next to
// the attendance record it produced. Punches write attendance on their own —
// present or late against the roster — so HR works only the exceptions here:
// a missing punch, a late that needs regularising, a day nobody punched.
// Replaces the old /settings "Shift Report", which was not company-scoped.
//
// Attendance tracking (owner, 2026-10-15): the Today board (who is in, by work
// location), the Punch log (with out-of-area punches flagged — never refused)
// and this day view. Month totals are the Attendance & Leaves format in Reports.

import { useState } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { card, inp, btnGhost, human, localDate, type PunchRow } from '../../../lib/hr'
import { HrShell } from '../../../components/hr/HrShell'
import { Select } from '@/components/ui/Select'

const STATUS_TONE: Record<string, string> = {
  present: '#3f7d20', late: '#a15c00', missing_punch: '#b42318', absent: '#b42318', half_day: '#a15c00',
}

const time = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })

function DayTab() {
  const [date, setDate] = useState(localDate())
  const [onlyExceptions, setOnlyExceptions] = useState(false)
  const { data, error, isLoading } = useQuery({
    queryKey: ['time-clock-logs', date],
    queryFn: () => api.get<{ date: string; rows: PunchRow[] }>(`/time-clock/logs?date=${date}`),
  })
  const rows = (data?.rows ?? []).filter((r) => !onlyExceptions || !r.attendance || !['present'].includes(r.attendance.status ?? ''))
  return (
    <>
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <input type="date" className={`${inp} max-w-[180px]`} value={date} onChange={(e) => setDate(e.target.value)} aria-label="Day" />
        <label className="flex items-center gap-2 text-xs text-white/60">
          <input type="checkbox" checked={onlyExceptions} onChange={(e) => setOnlyExceptions(e.target.checked)} /> Exceptions only
        </label>
        <span className="ml-auto flex gap-3 text-xs">
          <Link href="/hr/s/attendance" className="text-primary-ink hover:underline">All attendance records</Link>
          <Link href="/hr/s/attendance_correction" className="text-primary-ink hover:underline">Corrections</Link>
          <Link href="/hr/s/roster" className="text-primary-ink hover:underline">Roster</Link>
        </span>
      </div>
      {error && <p className="text-sm text-red-700 mb-3">{(error as Error).message}</p>}
      {isLoading && <p className="text-sm text-white/40">Loading…</p>}
      <div className="rounded-2xl overflow-hidden" style={card}>
        {!isLoading && rows.length === 0 && <p className="p-6 text-sm text-white/40 text-center">No punches or attendance on this day.</p>}
        {rows.map((r) => (
          <div key={r.key} className="px-4 py-3 border-t border-white/[0.05] first:border-t-0 grid md:grid-cols-[220px_1fr_220px] gap-3 items-start text-sm">
            <div>
              {r.employeeId ? <Link href={`/hr/employees/${r.employeeId}`} className="font-bold text-white/85 hover:underline">{r.name}</Link> : <span className="font-bold text-white/85">{r.name}</span>}
              <p className="text-[11px] text-white/40">{r.employeeCode ?? 'No HR record'}{r.role ? ` · ${human(r.role)}` : ''}</p>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {r.punches.length === 0 && <span className="text-xs text-white/35">No punches</span>}
              {r.punches.map((p, i) => (
                <span key={i} className="rounded-full px-2 py-0.5 text-[11px] font-bold inline-flex items-center gap-1"
                  style={{ background: p.type === 'in' ? 'rgba(52,211,153,0.12)' : 'rgb(var(--fg-rgb) / 0.06)', color: p.type === 'in' ? '#3f7d20' : 'rgb(var(--fg-rgb) / 0.7)' }}
                  title={p.geofenceDistanceM != null ? `${p.geofenceDistanceM} m from the nearest work location` : undefined}>
                  {p.type.toUpperCase()} {time(p.at)}
                  <span className="font-normal text-white/40">{p.source === 'kiosk' ? 'kiosk' : 'clock'}</span>
                  {(p.outOfArea || p.geofenceMatched === false) && <span className="text-amber-700">out of area</span>}
                  {p.selfieUrl && <a href={p.selfieUrl} target="_blank" rel="noreferrer" className="underline font-normal">selfie</a>}
                </span>
              ))}
            </div>
            <div className="text-right">
              {r.attendance ? (
                <>
                  <p className="text-xs font-black" style={{ color: STATUS_TONE[r.attendance.status ?? ''] ?? 'rgb(var(--fg-rgb) / 0.7)' }}>
                    {human(r.attendance.status)}{r.attendance.status === 'late' && r.attendance.lateMinutes ? ` · ${r.attendance.lateMinutes} min` : ''}
                  </p>
                  <p className="text-[11px] text-white/40">{r.attendance.checkIn ?? '—'} → {r.attendance.checkOut ?? '—'} · {r.attendance.source === 'hr' ? 'keyed by HR' : r.attendance.source === 'correction' ? 'corrected' : 'from punches'}</p>
                </>
              ) : (
                <p className="text-[11px] text-white/40">{r.employeeId ? 'No attendance record' : 'Not linked to an HR record — no attendance'}</p>
              )}
            </div>
          </div>
        ))}
      </div>
    </>
  )
}

// ─── Attendance tracking: Today board + Punch log ───────────────────────────

type TodayStatus = 'in' | 'out' | 'not_in' | 'missing_punch' | 'on_leave' | 'recorded'
interface TodayRow {
  employeeId: string; employeeCode: string; fullName: string; department: string | null
  workLocations: Array<{ locationId: string; name: string; isPrimary: boolean; hasPin: boolean }>
  status: TodayStatus; checkIn: string | null; checkOut: string | null; outOfArea: boolean
  punches: Array<{ type: 'in' | 'out'; at: string; location: string | null; distanceM: number | null; outOfArea: boolean }>
}
interface TodayData {
  date: string
  totals: { employees: number; in: number; out: number; notIn: number; missingPunch: number; onLeave: number; recorded: number; outOfArea: number }
  rows: TodayRow[]
}
interface LogRow {
  id: string; date: string; employeeId: string | null; employeeCode: string | null; fullName: string
  type: 'in' | 'out'; at: string; source: string; location: string | null; distanceM: number | null; outOfArea: boolean; attendanceStatus: string | null
}
interface LogData { total: number; page: number; pageSize: number; rows: LogRow[] }
interface LocationLite { id: string; name: string }

const STATUS_LABEL: Record<TodayStatus, string> = { in: 'In', out: 'Out', not_in: 'Not in yet', missing_punch: 'Missing punch', on_leave: 'On leave', recorded: 'Recorded by HR' }
const STATUS_COLOR_T: Record<TodayStatus, string> = {
  in: 'var(--erp-success)', out: 'rgb(var(--fg-rgb) / 0.6)', not_in: 'rgb(var(--fg-rgb) / 0.45)',
  missing_punch: 'var(--erp-danger)', on_leave: 'rgb(var(--fg-rgb) / 0.6)', recorded: 'rgb(var(--fg-rgb) / 0.6)',
}
const OUT_OF_AREA_STYLE = { background: 'rgb(var(--fg-rgb) / 0.06)', color: 'var(--erp-danger)' } as const

function OutOfAreaBadge() {
  return <span className="rounded-full px-2 py-0.5 text-[10px] font-black uppercase tracking-wider" style={OUT_OF_AREA_STYLE}>Out of area</span>
}

function TodayTab() {
  const [locationId, setLocationId] = useState('')
  const [filter, setFilter] = useState<'all' | TodayStatus | 'out_of_area'>('all')
  const { data: locations = [] } = useQuery({ queryKey: ['locations'], queryFn: () => api.get<LocationLite[]>('/locations') })
  const { data, error, isLoading } = useQuery({
    queryKey: ['hr-tracking-today', locationId],
    queryFn: () => api.get<TodayData>(`/hr/attendance-tracking/today${locationId ? `?locationId=${encodeURIComponent(locationId)}` : ''}`),
    refetchInterval: 60_000,
  })
  const t = data?.totals
  const chips: Array<{ key: typeof filter; label: string; n: number | undefined }> = [
    { key: 'all', label: 'Everyone', n: t?.employees },
    { key: 'in', label: 'In', n: t?.in },
    { key: 'out', label: 'Out', n: t?.out },
    { key: 'not_in', label: 'Not in yet', n: t?.notIn },
    { key: 'missing_punch', label: 'Missing punch', n: t?.missingPunch },
    { key: 'on_leave', label: 'On leave', n: t?.onLeave },
    { key: 'out_of_area', label: 'Out of area', n: t?.outOfArea },
  ]
  const rows = (data?.rows ?? []).filter((r) => filter === 'all' ? true : filter === 'out_of_area' ? r.outOfArea : r.status === filter)
  return (
    <>
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <Select className={`${inp} max-w-[240px]`} value={locationId} onChange={(e) => setLocationId(e.target.value)} aria-label="Work location">
          <option value="">All work locations</option>
          {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </Select>
        <span className="text-xs text-white/40">{data ? `Today, ${data.date}` : ''}</span>
        <Link href="/hr/reports" className="ml-auto text-xs text-primary-ink hover:underline">Month totals: Attendance &amp; Leaves report</Link>
      </div>
      <div className="flex flex-wrap gap-1 mb-4">
        {chips.map((c) => (
          <button key={c.key} onClick={() => setFilter(c.key)}
            className={`rounded-full px-3 py-1.5 text-xs font-bold whitespace-nowrap ${filter === c.key ? 'bg-primary text-primary-on' : 'text-white/50 border border-white/10'}`}>
            {c.label}{c.n != null ? ` · ${c.n}` : ''}
          </button>
        ))}
      </div>
      {error && <p className="text-sm text-red-700 mb-3">{(error as Error).message}</p>}
      {isLoading && <p className="text-sm text-white/40">Loading…</p>}
      <div className="rounded-2xl overflow-hidden" style={card}>
        {!isLoading && rows.length === 0 && <p className="p-6 text-sm text-white/40 text-center">Nobody matches.</p>}
        {rows.map((r) => (
          <div key={r.employeeId} className="px-4 py-3 border-t border-white/[0.05] first:border-t-0 grid md:grid-cols-[220px_1fr_150px] gap-3 items-start text-sm">
            <div>
              <Link href={`/hr/employees/${r.employeeId}`} className="font-bold text-white/85 hover:underline">{r.fullName}</Link>
              <p className="text-[11px] text-white/40">{r.employeeCode}{r.department ? ` · ${r.department}` : ''}</p>
            </div>
            <div>
              <div className="flex flex-wrap gap-1.5 items-center">
                {r.punches.length === 0 && <span className="text-xs text-white/35">No punches</span>}
                {r.punches.map((p, i) => (
                  <span key={i} className="rounded-full px-2 py-0.5 text-[11px] font-bold inline-flex items-center gap-1" style={{ background: 'rgb(var(--fg-rgb) / 0.06)' }}
                    title={p.distanceM != null ? `${p.distanceM} m from the nearest work location` : undefined}>
                    {p.type.toUpperCase()} {time(p.at)}
                    {p.location && <span className="font-normal text-white/45">{p.location}</span>}
                    {p.outOfArea && <span style={{ color: 'var(--erp-danger)' }}>out of area</span>}
                  </span>
                ))}
                {r.outOfArea && <OutOfAreaBadge />}
              </div>
              <p className="text-[11px] text-white/35 mt-1">
                {r.workLocations.length === 0 ? 'No work locations set — measured against the company locations' : r.workLocations.map((w) => `${w.name}${w.isPrimary ? ' (primary)' : ''}${w.hasPin ? '' : ' — no map pin'}`).join(' · ')}
              </p>
            </div>
            <p className="text-xs font-black md:text-right" style={{ color: STATUS_COLOR_T[r.status] }}>{STATUS_LABEL[r.status]}</p>
          </div>
        ))}
      </div>
    </>
  )
}

function PunchLogTab() {
  const [from, setFrom] = useState(localDate())
  const [to, setTo] = useState(localDate())
  const [outOnly, setOutOnly] = useState(false)
  const [page, setPage] = useState(1)
  const qs = new URLSearchParams({ from, to, page: String(page), pageSize: '100', ...(outOnly && { outOfArea: '1' }) }).toString()
  const { data, error, isLoading } = useQuery({
    queryKey: ['hr-tracking-punches', qs],
    queryFn: () => api.get<LogData>(`/hr/attendance-tracking/punches?${qs}`),
  })
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1
  return (
    <>
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <input type="date" className={`${inp} max-w-[170px]`} value={from} onChange={(e) => { setFrom(e.target.value); setPage(1) }} aria-label="From" />
        <input type="date" className={`${inp} max-w-[170px]`} value={to} onChange={(e) => { setTo(e.target.value); setPage(1) }} aria-label="To" />
        <label className="flex items-center gap-2 text-xs text-white/60">
          <input type="checkbox" checked={outOnly} onChange={(e) => { setOutOnly(e.target.checked); setPage(1) }} /> Out-of-area punches only
        </label>
        {data && <span className="ml-auto text-xs text-white/40">{data.total} punch{data.total === 1 ? '' : 'es'}</span>}
      </div>
      <p className="text-[11px] text-white/40 mb-3">A punch outside the person&rsquo;s work locations is never refused — it is recorded here and flagged for HR.</p>
      {error && <p className="text-sm text-red-700 mb-3">{(error as Error).message}</p>}
      {isLoading && <p className="text-sm text-white/40">Loading…</p>}
      <div className="rounded-2xl overflow-x-auto" style={card}>
        {!isLoading && (data?.rows.length ?? 0) === 0 ? <p className="p-6 text-sm text-white/40 text-center">No punches in this range.</p> : (
          <table className="w-full text-xs">
            <thead><tr>{['Date', 'Time', 'Employee', 'In / out', 'Source', 'Location', 'Distance', ''].map((h) => <th key={h} className="px-3 py-2 text-left font-bold text-white/45 whitespace-nowrap">{h}</th>)}</tr></thead>
            <tbody>
              {data?.rows.map((r) => (
                <tr key={r.id} className="border-t border-white/[0.04]">
                  <td className="px-3 py-1.5 text-white/70 whitespace-nowrap">{r.date}</td>
                  <td className="px-3 py-1.5 text-white/80 whitespace-nowrap">{time(r.at)}</td>
                  <td className="px-3 py-1.5 whitespace-nowrap">
                    {r.employeeId ? <Link href={`/hr/employees/${r.employeeId}`} className="font-bold text-white/85 hover:underline">{r.fullName}</Link> : <span className="font-bold text-white/85">{r.fullName}</span>}
                    {r.employeeCode && <span className="text-white/40"> {r.employeeCode}</span>}
                  </td>
                  <td className="px-3 py-1.5 font-bold text-white/75">{r.type.toUpperCase()}</td>
                  <td className="px-3 py-1.5 text-white/55">{r.source === 'kiosk' ? 'Kiosk PIN' : 'Login'}</td>
                  <td className="px-3 py-1.5 text-white/70 whitespace-nowrap">{r.location ?? '—'}</td>
                  <td className="px-3 py-1.5 text-white/55 whitespace-nowrap">{r.distanceM != null ? `${r.distanceM} m` : 'no location sent'}</td>
                  <td className="px-3 py-1.5">{r.outOfArea && <OutOfAreaBadge />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {pages > 1 && (
        <div className="flex items-center gap-2 mt-3 text-xs text-white/50">
          <button className={btnGhost} disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
          <span>Page {page} of {pages}</span>
          <button className={btnGhost} disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button>
        </div>
      )}
    </>
  )
}

const TABS = [['today', 'Today'], ['punches', 'Punch log'], ['day', 'Day & corrections']] as const

export default function HrAttendancePage() {
  const [tab, setTab] = useState<(typeof TABS)[number][0]>('today')
  return (
    <HrShell title="Attendance tracking" subtitle="Punches come from the time clock (login on a phone, or the outlet tablet with a PIN), measured against each person's work locations. Out-of-area punches are allowed and flagged.">
      <div className="flex gap-1 mb-5 overflow-x-auto">
        {TABS.map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} className={`rounded-full px-3 py-1.5 text-xs font-bold whitespace-nowrap ${tab === k ? 'bg-primary text-primary-on' : 'text-white/50 border border-white/10'}`}>{label}</button>
        ))}
      </div>
      {tab === 'today' && <TodayTab />}
      {tab === 'punches' && <PunchLogTab />}
      {tab === 'day' && <DayTab />}
    </HrShell>
  )
}
