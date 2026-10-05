'use client'
// Attendance for a day: every punch (time clock, tablet, kiosk PIN) next to
// the attendance record it produced. Punches write attendance on their own —
// present or late against the roster — so HR works only the exceptions here:
// a missing punch, a late that needs regularising, a day nobody punched.
// Replaces the old /settings "Shift Report", which was not company-scoped.

import { useState } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { card, inp, human, localDate, type PunchRow } from '../../../lib/hr'
import { HrShell } from '../../../components/hr/HrShell'

const STATUS_TONE: Record<string, string> = {
  present: '#3f7d20', late: '#a15c00', missing_punch: '#b42318', absent: '#b42318', half_day: '#a15c00',
}

const time = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })

export default function HrAttendancePage() {
  const [date, setDate] = useState(localDate())
  const [onlyExceptions, setOnlyExceptions] = useState(false)
  const { data, error, isLoading } = useQuery({
    queryKey: ['time-clock-logs', date],
    queryFn: () => api.get<{ date: string; rows: PunchRow[] }>(`/time-clock/logs?date=${date}`),
  })
  const rows = (data?.rows ?? []).filter((r) => !onlyExceptions || !r.attendance || !['present'].includes(r.attendance.status ?? ''))
  return (
    <HrShell title="Attendance" subtitle="Punches from the time clock, the tablet and the kiosk PIN, and the attendance each one wrote. Correct an exception with an attendance correction; a row you edit by hand is never overwritten by a punch.">
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
                  title={p.geofenceDistanceM != null ? `${p.geofenceDistanceM} m from the nearest branch` : undefined}>
                  {p.type.toUpperCase()} {time(p.at)}
                  <span className="font-normal text-white/40">{p.source === 'kiosk' ? 'kiosk' : 'clock'}</span>
                  {p.geofenceMatched === false && <span className="text-amber-700">off-site</span>}
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
    </HrShell>
  )
}
