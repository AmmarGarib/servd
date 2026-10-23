'use client'
// Night audit — lock each business day, close it when its money settles.
// Contract: backend/src/modules/nightAudit/README.md. Finance runs it, the CEO
// pushes through a block with a reason. Month close needs every sales day closed.
import { Button, FieldLabel, Input } from '@/components/finance/ui'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Suspense, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { api } from '../../../lib/api'
import { useAuthStore } from '../../../store/auth'
import { DayPanel } from './DayPanel'
import { MonthCalendar } from './MonthCalendar'
import { type MonthState, MIN_REASON, monthLabel, shiftMonth } from './types'

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

export default function NightAuditPage() {
  return (
    <Suspense fallback={<div className="p-8 text-sm text-s-muted">Loading…</div>}>
      <NightAudit />
    </Suspense>
  )
}

function NightAudit() {
  const router = useRouter()
  const pathname = usePathname()
  const sp = useSearchParams()
  const qc = useQueryClient()
  const isAdmin = useAuthStore((s) => s.isRole('admin'))
  const qMonth = sp.get('month')
  const qDay = sp.get('day')
  const day = qDay && DAY_RE.test(qDay) ? qDay : null
  const month = qMonth && MONTH_RE.test(qMonth) ? qMonth : day ? day.slice(0, 7) : null
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(null)
  const [startDay, setStartDay] = useState('')
  const [startReason, setStartReason] = useState('')

  const { data, isLoading, error } = useQuery({
    queryKey: ['night-audit', 'month', month],
    queryFn: () => api.get<MonthState>(`/accounting/night-audit${month ? `?month=${month}` : ''}`),
  })
  const shownMonth = data?.month ?? month ?? ''

  const go = (m: string, d?: string | null) => {
    const p = new URLSearchParams()
    p.set('month', m)
    if (d) p.set('day', d)
    router.replace(`${pathname}?${p.toString()}`)
  }

  const saveStart = useMutation({
    mutationFn: () => api.put('/accounting/night-audit/settings', { startDay: startDay || null, reason: startReason.trim() }),
    onSuccess: () => {
      setFeedback({ ok: true, msg: startDay ? `Month close now requires night audits from ${startDay}.` : 'Night audit start day cleared.' })
      setStartReason('')
      void qc.invalidateQueries({ queryKey: ['night-audit'] })
    },
    onError: (e: Error) => setFeedback({ ok: false, msg: e.message || 'Could not save the start day' }),
  })

  const s = data?.summary
  return (
    <div className="min-h-screen bg-s-bg">
      <style>{`@media print { .na-noprint, nav, aside, header { display: none !important; } #na-day-panel { border: 0; box-shadow: none; } }`}</style>
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-4 sm:px-6 py-4 na-noprint">
        <p className="text-xs font-medium text-success">Books</p>
        <h1 className="text-xl font-bold text-s-text">Night audit</h1>
        <p className="text-xs text-s-muted mt-0.5">Covers sales only: customer bills, payments and tenders, till shifts and cash drops. Other modules keep their own rules.</p>
      </header>

      <div className="p-4 sm:p-6 max-w-5xl mx-auto space-y-4">
        {feedback && (
          <div role={feedback.ok ? 'status' : 'alert'} className={`s-card p-3 text-sm na-noprint ${feedback.ok ? 'text-success' : 'text-s-red'}`}>{feedback.msg}</div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 na-noprint">
          <div className="flex items-center gap-2">
            <Button variant="secondary" type="button"  disabled={!shownMonth} onClick={() => go(shiftMonth(shownMonth, -1))} aria-label="Previous month">‹</Button>
            <span className="text-base font-semibold text-s-text min-w-[9rem] text-center">{shownMonth ? monthLabel(shownMonth) : ''}</span>
            <Button variant="secondary" type="button"  disabled={!shownMonth} onClick={() => go(shiftMonth(shownMonth, 1))} aria-label="Next month">›</Button>
          </div>
          <p className="text-xs text-s-muted">
            Month close needs every sales day closed. <Link href="/accounting/period-close" className="text-primary-ink underline">Period close</Link>
          </p>
        </div>

        {s && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 na-noprint">
            {[
              ['Active days', s.activeDays, ''],
              ['Closed', s.closed, 'text-success'],
              ['Awaiting settlement', s.awaitingSettlement, 'text-primary-ink'],
              ['Not run', s.overdue, s.overdue > 0 ? 'text-s-red' : ''],
            ].map(([k, v, cls]) => (
              <div key={k as string} className="s-card p-3">
                <p className="text-xs text-s-muted">{k}</p>
                <p className={`text-xl font-bold tabular-nums ${cls || 'text-s-text'}`}>{v}</p>
              </div>
            ))}
          </div>
        )}

        {data && (
          <p className="text-xs text-s-muted na-noprint">
            {data.startDay ? `Month close requires sales night audits from ${data.startDay}.` : 'Night audit has not started for this company. The first run sets the start day, and month close does not require it until then.'}
            {data.periodLockedThrough ? ` Books closed through ${data.periodLockedThrough}.` : ''}
          </p>
        )}

        <div className="s-card p-3 sm:p-4 na-noprint">
          {isLoading && <p className="text-xs text-s-muted">Loading…</p>}
          {error && <p role="alert" className="text-xs text-s-red">{(error as Error).message}</p>}
          {data && <MonthCalendar month={data.month} days={data.days} selected={day} onSelect={(d) => go(data.month, d)} />}
        </div>

        {day && <DayPanel key={day} day={day} onClose={() => go(shownMonth)} notify={setFeedback} />}

        {isAdmin && data && (
          <div className="s-card p-4 space-y-2 na-noprint">
            <h3 className="text-sm font-semibold text-s-text">Start day (CEO)</h3>
            <p className="text-xs text-s-muted">Month close only requires days from this date. Move it back only to bring older days under the audit. It cannot be after the earliest audited day.</p>
            <div className="flex flex-col sm:flex-row gap-2 sm:items-end">
              <div>
                <FieldLabel htmlFor="na-start" className="block">Start day</FieldLabel>
                <Input className="w-auto px-3 py-2 text-sm" id="na-start" type="date" value={startDay || data.startDay || ''} onChange={(e) => setStartDay(e.target.value)}
                   />
              </div>
              <div className="flex-1">
                <FieldLabel htmlFor="na-start-reason" className="block">Reason (at least {MIN_REASON} characters)</FieldLabel>
                <Input id="na-start-reason" type="text" value={startReason} onChange={(e) => setStartReason(e.target.value)}
                  className="w-full" />
              </div>
              <Button variant="secondary" type="button"  disabled={saveStart.isPending || startReason.trim().length < MIN_REASON || !(startDay || data.startDay)}
                onClick={() => saveStart.mutate()}>
                {saveStart.isPending ? 'Saving…' : 'Save start day'}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
