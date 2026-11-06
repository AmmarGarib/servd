'use client'
// One intern's month as a calendar of day cells (Monday first). With `onSet` a day can be marked (HR on the profile,
// the supervisor on My interns); without it the month is read-only. Days outside the internship or in the future are
// not clickable. The server still decides (payroll left draft, not enrolled …) and its message is shown by the caller.

import { useRef, useState } from 'react'
import { AnchoredMenu } from '@/components/ui/AnchoredMenu'
import {
  ATTENDANCE_CODE, ATTENDANCE_FALLBACK_LABEL, ATTENDANCE_STATUS_ORDER, ATTENDANCE_TONE, daysOfMonth, pktToday, ymd, type AttendanceStatus, type DayMark,
} from '../../../lib/interns'
import { cellTint } from './AttendanceTab'

const HEAD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

export function MonthDays({ month, days, startDate, lastDay, workingDays, labels, onSet, busy }: {
  month: string
  days: Record<string, DayMark>
  startDate: string | null
  lastDay: string | null
  workingDays: number[]
  labels?: Record<string, string>
  onSet?: (date: string, status: AttendanceStatus) => void
  busy?: boolean
}) {
  const today = pktToday()
  const list = daysOfMonth(month)
  const lead = (new Date(`${list[0]}T00:00:00Z`).getUTCDay() + 6) % 7
  const [pick, setPick] = useState<string | null>(null)
  const anchor = useRef<HTMLElement | null>(null)
  const label = (s: AttendanceStatus) => labels?.[s] ?? ATTENDANCE_FALLBACK_LABEL[s]
  return (
    <div>
      <div className="grid grid-cols-7 gap-1 text-center text-[10px] font-bold uppercase tracking-wider text-white/50 mb-1" aria-hidden="true">{HEAD.map((h) => <span key={h}>{h}</span>)}</div>
      <div className="grid grid-cols-7 gap-1">
        {Array.from({ length: lead }, (_, k) => <span key={`pad-${k}`} aria-hidden="true" />)}
        {list.map((d) => {
          const m = days[d]
          const outside = d < ymd(startDate) || (!!lastDay && d > lastDay) || d > today
          const workDay = workingDays.includes(new Date(`${d}T00:00:00Z`).getUTCDay())
          const canSet = !!onSet && !outside
          const style = m ? { color: ATTENDANCE_TONE[m.status], background: cellTint(m.status) } : { color: 'rgb(var(--fg-rgb) / 0.4)', border: '1px dashed rgb(var(--fg-rgb) / 0.12)' }
          const inner = (
            <>
              <span className="block text-[10px] font-normal text-white/60">{Number(d.slice(8))}</span>
              <span className="block text-xs font-black">{m ? ATTENDANCE_CODE[m.status] : outside || workDay ? '' : '–'}</span>
            </>
          )
          const aria = `${d}: ${m ? label(m.status) : outside ? 'outside the internship' : 'not marked'}`
          return canSet ? (
            <button key={d} type="button" disabled={busy} aria-label={aria} title={m?.note ?? undefined}
              onClick={(e) => { anchor.current = e.currentTarget; setPick(d) }}
              className="rounded-lg py-1.5 min-h-[44px] sm:min-h-[48px] text-center" style={style}>{inner}</button>
          ) : (
            <div key={d} aria-label={aria} role="img" className="rounded-lg py-1.5 min-h-[44px] sm:min-h-[48px] text-center" style={outside && !m ? { color: 'rgb(var(--fg-rgb) / 0.25)' } : style}>{inner}</div>
          )
        })}
      </div>
      <AnchoredMenu anchor={anchor} open={!!pick} onClose={() => setPick(null)} align="start">
        {pick && (
          <>
            <p className="px-3 pt-2 pb-1 text-[11px] text-s-muted">{pick}</p>
            {ATTENDANCE_STATUS_ORDER.map((s) => (
              <button key={s} type="button" role="menuitem" onClick={() => { const d = pick; setPick(null); onSet?.(d, s) }}
                className="flex w-full items-center gap-2 whitespace-nowrap px-3 py-2 text-left text-sm text-s-text hover:bg-s-bg-soft">
                <span aria-hidden="true" className="inline-flex h-5 min-w-[1.5rem] items-center justify-center rounded text-[10px] font-black px-1" style={{ color: ATTENDANCE_TONE[s], background: cellTint(s) }}>{ATTENDANCE_CODE[s]}</span>
                {label(s)}{days[pick]?.status === s ? ' ✓' : ''}
              </button>
            ))}
          </>
        )}
      </AnchoredMenu>
    </div>
  )
}
