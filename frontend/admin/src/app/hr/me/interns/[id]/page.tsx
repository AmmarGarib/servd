'use client'
// One supervised intern (My HR → My interns): a summary (no stipend, no CNIC), the month's attendance — the supervisor
// may set a day — and the performance remarks. GET /hr/my-interns/:id, PUT …/attendance/:date and …/remarks.

import Link from 'next/link'
import { useParams } from 'next/navigation'
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../../../lib/api'
import { btn, btnGhost, card, inp } from '../../../../../lib/hr'
import { INTERN_BADGE, addMonths, durationLabel, errText, monthLabel, shortDate, thisMonth, type AttendanceStatus, type MonthAttendance, type SupervisedIntern } from '../../../../../lib/interns'
import { HrShell } from '../../../../../components/hr/HrShell'
import { MonthDays } from '../../../../../components/hr/interns/MonthDays'
import { AttendanceLegend } from '../../../../../components/hr/interns/AttendanceTab'
import { Badge, ErrorBox, Fact, LoadState, Note } from '../../../../../components/hr/interns/ui'
import { ATTENDANCE_FALLBACK_LABEL } from '../../../../../lib/interns'

export default function MyInternPage() {
  const { id } = useParams<{ id: string }>()
  const qc = useQueryClient()
  const [month, setMonth] = useState(thisMonth())
  const [err, setErr] = useState('')
  const [remarks, setRemarks] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const { data, error, isLoading, refetch } = useQuery({
    queryKey: ['my-intern', id, month],
    queryFn: () => api.get<{ intern: SupervisedIntern; attendance: MonthAttendance }>(`/hr/my-interns/${id}?month=${month}`),
    retry: false,
  })
  const intern = data?.intern
  useEffect(() => { if (intern && remarks === null) setRemarks(intern.performanceRemarks ?? '') }, [intern, remarks])
  const mark = useMutation({
    mutationFn: (v: { date: string; status: AttendanceStatus }) => api.put(`/hr/my-interns/${id}/attendance/${v.date}`, { status: v.status }),
    onSuccess: () => { setErr(''); void qc.invalidateQueries({ queryKey: ['my-intern', id] }) },
    onError: (e) => setErr(errText(e)),
  })
  const saveRemarks = useMutation({
    mutationFn: () => api.put(`/hr/my-interns/${id}/remarks`, { performanceRemarks: (remarks ?? '').trim() }),
    onSuccess: () => { setErr(''); setSaved(true); void qc.invalidateQueries({ queryKey: ['my-intern', id] }); void qc.invalidateQueries({ queryKey: ['my-interns'] }) },
    onError: (e) => setErr(errText(e)),
  })
  const att = data?.attendance
  const dirty = !!intern && (remarks ?? '') !== (intern.performanceRemarks ?? '')
  return (
    <HrShell title={intern?.fullName ?? 'My intern'} subtitle={intern ? `${intern.internCode}${intern.department ? ` · ${intern.department}` : ''}` : undefined}
      actions={<Link href="/hr/me/interns" className="rounded-lg px-4 py-2 text-sm text-white/60 border border-white/10 hover:text-white">My interns</Link>}>
      <LoadState loading={isLoading} error={error} onRetry={() => void refetch()} />
      {intern && att && (
        <div className="space-y-5 max-w-3xl">
          <section className="rounded-2xl p-4 sm:p-5" style={card}>
            <div className="flex flex-wrap items-center gap-2 mb-3"><Badge cls={INTERN_BADGE[intern.status] ?? 's-badge-muted'}>{intern.statusLabel}</Badge></div>
            <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
              <Fact label="Position">{intern.designation}</Fact><Fact label="Institution">{intern.institution}</Fact>
              <Fact label="Start date">{shortDate(intern.startDate)}</Fact><Fact label="End date">{intern.endDate ? shortDate(intern.endDate) : 'Open-ended'}</Fact>
              <Fact label="Duration">{durationLabel(intern.startDate, intern.lastDay)}</Fact><Fact label="Working hours">{intern.workingHours}</Fact>
              <Fact label="Phone">{intern.phone}</Fact><Fact label="Email">{intern.email}</Fact>
            </div>
          </section>

          <section className="space-y-3">
            <h2 className="text-sm font-black text-white/90">Attendance — {monthLabel(month)}</h2>
            <div className="flex flex-wrap items-end gap-1">
              <button type="button" className={`${btnGhost} !px-3`} aria-label="Previous month" onClick={() => setMonth(addMonths(month, -1))}>‹</button>
              <label className="text-[11px] text-white/55">Month<input type="month" className={`${inp} mt-0.5`} value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} /></label>
              <button type="button" className={`${btnGhost} !px-3`} aria-label="Next month" disabled={month >= thisMonth()} onClick={() => setMonth(addMonths(month, 1))}>›</button>
            </div>
            <AttendanceLegend />
            <p className="text-sm text-white/80 flex flex-wrap gap-x-4 gap-y-1">
              {Object.entries(att.summary).filter(([, n]) => n > 0).map(([s, n]) => <span key={s}><b>{n}</b> {ATTENDANCE_FALLBACK_LABEL[s as AttendanceStatus] ?? s}</span>)}
              {!Object.values(att.summary).some((n) => n > 0) && <span className="text-white/55">Nothing marked this month.</span>}
            </p>
            <ErrorBox message={err} />
            <div className="rounded-2xl p-3 sm:p-4" style={card}>
              <MonthDays month={month} days={att.days} startDate={intern.startDate} lastDay={intern.lastDay} workingDays={intern.workingDays}
                onSet={(date, status) => mark.mutate({ date, status })} busy={mark.isPending} />
            </div>
            <p className="text-[11px] text-white/50">Tap a day to set its status. A month whose stipend payroll has left draft is locked.</p>
          </section>

          <section className="rounded-2xl p-4 sm:p-5 space-y-3" style={card}>
            <h2 className="text-sm font-black text-white/90">Performance remarks</h2>
            <textarea className={`${inp} min-h-[110px]`} aria-label="Performance remarks" maxLength={2000} value={remarks ?? ''} onChange={(e) => { setRemarks(e.target.value); setSaved(false) }} />
            <div className="flex flex-wrap items-center gap-3">
              <button type="button" className={btn} disabled={!dirty || saveRemarks.isPending} onClick={() => saveRemarks.mutate()}>{saveRemarks.isPending ? 'Saving…' : 'Save remarks'}</button>
              {saved && !dirty && <span className="text-xs text-success font-bold" role="status">Saved.</span>}
            </div>
            <p className="text-[11px] text-white/50">HR sees these remarks on the intern&rsquo;s record.</p>
          </section>
          {intern.status !== 'active' && <Note tone="info">This internship has ended; attendance of the final month may still be corrected until its stipend payroll is processed.</Note>}
        </div>
      )}
    </HrShell>
  )
}
