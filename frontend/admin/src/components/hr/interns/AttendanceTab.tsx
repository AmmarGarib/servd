'use client'
// HR → Interns → Attendance: a month grid (interns × days). Click a day to set its status; "Mark in bulk" fills a date
// range for many interns at once. Interns do not clock in — HR (and the supervisor) mark them. Server rules (not
// enrolled / outside the internship / future / payroll left draft) come back as messages.

import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { btnGhost, card, inp } from '../../../lib/hr'
import {
  ATTENDANCE_CODE, ATTENDANCE_FALLBACK_LABEL, ATTENDANCE_STATUS_ORDER, ATTENDANCE_TONE, addMonths, daysOfMonth, errText, monthLabel, pktToday,
  thisMonth, useInternLookups, weekdayShort, ymd, type AttendanceStatus, type DayMark,
} from '../../../lib/interns'
import { AnchoredMenu } from '@/components/ui/AnchoredMenu'
import { Select } from '@/components/ui/Select'
import { BulkInternAttendance } from './BulkInternAttendance'
import { ErrorBox, LoadState } from './ui'

export interface AttendanceIntern {
  id: string; internCode: string; fullName: string; department: string | null; startDate: string | null; lastDay: string | null
  workingDays: number[]; status: string; days: Record<string, DayMark>; summary: Record<string, number>
}
interface AttendanceData { month: string; days: string[]; interns: AttendanceIntern[] }

export const cellTint = (s: AttendanceStatus) => `color-mix(in srgb, ${ATTENDANCE_TONE[s]} 16%, transparent)`

export function AttendanceLegend({ labels }: { labels?: Record<string, string> }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-white/65" aria-label="Legend">
      {ATTENDANCE_STATUS_ORDER.map((s) => (
        <li key={s} className="flex items-center gap-1.5">
          <span aria-hidden="true" className="inline-flex h-5 min-w-[1.5rem] items-center justify-center rounded text-[10px] font-black px-1" style={{ color: ATTENDANCE_TONE[s], background: cellTint(s) }}>{ATTENDANCE_CODE[s]}</span>
          {labels?.[s] ?? ATTENDANCE_FALLBACK_LABEL[s]}
        </li>
      ))}
    </ul>
  )
}

export function AttendanceTab() {
  const qc = useQueryClient()
  const { data: lk } = useInternLookups()
  const [month, setMonth] = useState(thisMonth())
  const [departmentId, setDepartmentId] = useState('')
  const [bulk, setBulk] = useState(false)
  const [err, setErr] = useState('')
  const [pick, setPick] = useState<{ intern: AttendanceIntern; date: string } | null>(null)
  const anchor = useRef<HTMLElement | null>(null)
  const key = ['intern-attendance', month, departmentId]
  const { data, error, isLoading, refetch } = useQuery({
    queryKey: key,
    queryFn: () => api.get<AttendanceData>(`/hr/interns/attendance?${new URLSearchParams({ month, ...(departmentId && { departmentId }) })}`),
  })
  const mark = useMutation({
    mutationFn: (v: { id: string; date: string; status: AttendanceStatus }) => api.put(`/hr/interns/${v.id}/attendance/${v.date}`, { status: v.status }),
    onSuccess: () => { setErr(''); void qc.invalidateQueries({ queryKey: ['intern-attendance'] }); void qc.invalidateQueries({ queryKey: ['intern'] }) },
    onError: (e) => setErr(errText(e)),
  })
  const today = pktToday()
  const labels = lk?.attendanceLabels
  const days = data?.days ?? daysOfMonth(month)
  const label = (s: AttendanceStatus) => labels?.[s] ?? ATTENDANCE_FALLBACK_LABEL[s]

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex items-end gap-1">
          <button type="button" className={`${btnGhost} !px-3`} aria-label="Previous month" onClick={() => setMonth(addMonths(month, -1))}>‹</button>
          <label className="text-[11px] text-white/55">Month<input type="month" className={`${inp} mt-0.5`} value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} /></label>
          <button type="button" className={`${btnGhost} !px-3`} aria-label="Next month" disabled={month >= thisMonth()} onClick={() => setMonth(addMonths(month, 1))}>›</button>
        </div>
        <Select className={`${inp} !w-auto min-w-[11rem]`} aria-label="Department" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
          <option value="">All departments</option>
          {(lk?.departments ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </Select>
        <button type="button" className={`${btnGhost} ml-auto`} onClick={() => setBulk(true)} disabled={!data || data.interns.length === 0}>Mark in bulk</button>
      </div>
      <AttendanceLegend labels={labels} />
      <ErrorBox message={err} />
      <LoadState loading={isLoading} error={error} onRetry={() => void refetch()} />
      {data && data.interns.length === 0 && (
        <div className="rounded-2xl p-8 text-center text-sm text-white/60" style={card}>No approved interns were engaged in {monthLabel(month)}{departmentId ? ' in this department' : ''}.</div>
      )}
      {data && data.interns.length > 0 && (
        <div className="rounded-2xl overflow-x-auto" style={card}>
          <table className="text-xs border-separate border-spacing-0">
            <thead>
              <tr>
                <th className="sticky left-0 z-[1] bg-s-surface text-left px-3 py-2 font-bold text-white/55 min-w-[10rem]">Intern</th>
                {days.map((d) => (
                  <th key={d} scope="col" className="px-0.5 py-1 font-bold text-white/55 text-center min-w-[32px] [@media(pointer:coarse)]:min-w-[44px]">
                    <span className="block text-[10px] font-normal">{weekdayShort(d)}</span>{Number(d.slice(8))}
                  </th>
                ))}
                <th className="px-3 py-2 text-left font-bold text-white/55 whitespace-nowrap">Summary</th>
              </tr>
            </thead>
            <tbody>
              {data.interns.map((i) => (
                <tr key={i.id}>
                  <th scope="row" className="sticky left-0 z-[1] bg-s-surface text-left px-3 py-1.5 border-t border-white/[0.05] font-normal">
                    <span className="block font-bold text-white/90 break-words">{i.fullName}</span>
                    <span className="block text-[10px] text-white/50">{i.internCode}{i.department ? ` · ${i.department}` : ''}</span>
                  </th>
                  {days.map((d) => {
                    const m = i.days[d]
                    const outside = d < ymd(i.startDate) || (!!i.lastDay && d > i.lastDay) || d > today
                    const workDay = i.workingDays.includes(new Date(`${d}T00:00:00Z`).getUTCDay())
                    return (
                      <td key={d} className="border-t border-white/[0.05] p-0.5 text-center">
                        {outside && !m ? <span aria-hidden="true" className="text-white/20">·</span> : (
                          <button type="button" disabled={mark.isPending}
                            aria-label={`${i.fullName}, ${d}: ${m ? label(m.status) : 'not marked'}${m?.source === 'supervisor' ? ' (by supervisor)' : ''}`}
                            title={m ? `${label(m.status)}${m.note ? ` — ${m.note}` : ''}` : workDay ? 'Not marked' : 'Not a working day'}
                            onClick={(e) => { anchor.current = e.currentTarget; setPick({ intern: i, date: d }) }}
                            className="h-7 w-full min-w-[28px] rounded text-[10px] font-black [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:min-w-[40px]"
                            style={m ? { color: ATTENDANCE_TONE[m.status], background: cellTint(m.status) } : { color: 'rgb(var(--fg-rgb) / 0.3)', border: '1px dashed rgb(var(--fg-rgb) / 0.12)' }}>
                            {m ? ATTENDANCE_CODE[m.status] : workDay ? '+' : '–'}
                          </button>
                        )}
                      </td>
                    )
                  })}
                  <td className="border-t border-white/[0.05] px-3 py-1.5 whitespace-nowrap text-white/75">
                    {ATTENDANCE_STATUS_ORDER.filter((s) => i.summary[s]).map((s) => (
                      <span key={s} className="mr-2" title={label(s)}><span style={{ color: ATTENDANCE_TONE[s] }} className="font-black">{ATTENDANCE_CODE[s]}</span> {i.summary[s]}</span>
                    ))}
                    {!Object.values(i.summary).some(Boolean) && <span className="text-white/40">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <AnchoredMenu anchor={anchor} open={!!pick} onClose={() => setPick(null)} align="start">
        {pick && (
          <>
            <p className="px-3 pt-2 pb-1 text-[11px] text-s-muted max-w-[14rem] break-words">{pick.intern.fullName} · {pick.date}</p>
            {ATTENDANCE_STATUS_ORDER.map((s) => (
              <button key={s} type="button" role="menuitem" onClick={() => { const p = pick; setPick(null); mark.mutate({ id: p.intern.id, date: p.date, status: s }) }}
                className="flex w-full items-center gap-2 whitespace-nowrap px-3 py-2 text-left text-sm text-s-text hover:bg-s-bg-soft">
                <span aria-hidden="true" className="inline-flex h-5 min-w-[1.5rem] items-center justify-center rounded text-[10px] font-black px-1" style={{ color: ATTENDANCE_TONE[s], background: cellTint(s) }}>{ATTENDANCE_CODE[s]}</span>
                {label(s)}{pick.intern.days[pick.date]?.status === s ? ' ✓' : ''}
              </button>
            ))}
          </>
        )}
      </AnchoredMenu>
      {bulk && data && <BulkInternAttendance interns={data.interns} month={month} onClose={() => setBulk(false)} />}
    </div>
  )
}
