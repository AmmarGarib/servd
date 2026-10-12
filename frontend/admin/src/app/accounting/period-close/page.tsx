'use client'
// Period close — THE one place books are closed and reopened (the old
// /configuration/period-locks page redirects here). Closing is admin only and
// moves forward only; reopening (owner decision 21) is admin only, removes the
// latest close, needs a reason, and lands on the accounting audit trail and in
// the Exceptions inbox.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../../lib/api'
import { useAuthStore } from '../../../store/auth'
import Link from 'next/link'

// The latest day that can be closed is YESTERDAY, Pakistan time — today is
// still trading, and POST /accounting/period-close refuses it with 422
// LOCK_IN_FUTURE (BOOKS-R2-01). PKT is a fixed UTC+5 (no daylight saving).
function yesterdayPktIso(): string {
  const pkt = new Date(Date.now() + 5 * 3600_000)
  pkt.setUTCDate(pkt.getUTCDate() - 1)
  return pkt.toISOString().slice(0, 10)
}

interface CurrentLock {
  lockedThrough: string | null
  lockedAt: string | null
  lockedBy: string | null
  note: string | null
}

interface HistoryLock {
  id: string
  lockedThrough: string
  lockedThroughLabel: string
  lockedAt: string
  lockedByName: string | null
  note: string | null
}

export default function PeriodClosePage() {
  const qc = useQueryClient()
  const isAdmin = useAuthStore((s) => s.isRole('admin'))
  const [lockedThrough, setLockedThrough] = useState(yesterdayPktIso())
  const [note, setNote] = useState('')
  const [reopenReason, setReopenReason] = useState('')
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(null)

  const { data: current } = useQuery({
    queryKey: ['period-close'],
    queryFn: () => api.get<CurrentLock>('/accounting/period-close'),
  })
  const { data: history } = useQuery({
    queryKey: ['period-close', 'history'],
    queryFn: () => api.get<{ locks: HistoryLock[] }>('/accounting/period-close/history'),
  })

  const refresh = () => void qc.invalidateQueries({ queryKey: ['period-close'] })

  const close = useMutation({
    mutationFn: (input: { lockedThrough: string; note?: string }) =>
      api.post('/accounting/period-close', input),
    onSuccess: () => {
      setFeedback({ ok: true, msg: `Period closed through ${lockedThrough}` })
      refresh()
      setNote('')
    },
    // The API's message is shown as-is — LOCK_IN_FUTURE names the latest
    // date that can be closed (yesterday, Pakistan time).
    onError: (err: { message?: string }) => {
      setFeedback({ ok: false, msg: err.message ?? 'Failed to close period' })
    },
  })

  const reopen = useMutation({
    mutationFn: (reason: string) => api.post<{ lockedThrough: string | null }>('/accounting/period-close/reopen', { reason }),
    onSuccess: () => {
      setFeedback({ ok: true, msg: 'Latest close reopened — the reopening is on the audit trail and in the Exceptions inbox.' })
      setReopenReason('')
      refresh()
    },
    onError: (err: { message?: string }) => setFeedback({ ok: false, msg: err.message ?? 'Failed to reopen' }),
  })

  const maxLock = yesterdayPktIso()

  const lockedThroughDisplay = current?.lockedThrough
    ? history?.locks[0]?.lockedThroughLabel ?? new Date(current.lockedThrough).toLocaleDateString('en-GB', { timeZone: 'Asia/Karachi' })
    : 'Open'

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-6 py-4">
        <Link href="/accounting" className="text-xs text-s-muted hover:text-s-text">← Accounting</Link>
        <h1 className="text-xl font-bold text-s-text">Period Close</h1>
      </header>

      <div className="p-6 max-w-2xl mx-auto space-y-4">
        {feedback && (
          <div role={feedback.ok ? 'status' : 'alert'} className={`s-card p-3 text-sm ${feedback.ok ? 'text-success' : 'text-s-red'}`}>
            {feedback.msg}
          </div>
        )}

        <div className="s-card p-4">
          <p className="text-xs text-s-muted">Books are currently closed through</p>
          <p className="text-2xl font-bold text-s-text">{lockedThroughDisplay}</p>
          {current?.lockedAt && (
            <p className="text-xs text-s-muted mt-2">
              Locked at {new Date(current.lockedAt).toLocaleString()} by {history?.locks[0]?.lockedByName ?? current.lockedBy}
              {current.note && <> — {current.note}</>}
            </p>
          )}
        </div>

        {isAdmin && (
          <div className="s-card p-4 space-y-3">
            <h3 className="text-sm font-semibold text-s-text">Close a new period</h3>
            <p className="text-xs text-s-muted">
              After closing, postings dated on or before the end of this day (Pakistan time) are rejected. Lock dates only move forward. Today is still trading, so the latest day you can close is yesterday ({maxLock}).
            </p>
            <div className="space-y-2">
              <label htmlFor="lock-through" className="block text-xs text-s-muted">Lock through (inclusive)</label>
              <input id="lock-through" type="date" value={lockedThrough} max={maxLock} onChange={(e) => setLockedThrough(e.target.value)}
                className="w-full bg-s-card border border-s-border rounded px-3 py-2 text-sm text-s-text" />
            </div>
            <div className="space-y-2">
              <label htmlFor="lock-note" className="block text-xs text-s-muted">Note (optional)</label>
              <input id="lock-note" type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. April month-end signed off"
                className="w-full bg-s-card border border-s-border rounded px-3 py-2 text-sm text-s-text" />
            </div>
            <button
              onClick={() => close.mutate({ lockedThrough, ...(note ? { note } : {}) })}
              disabled={close.isPending || !lockedThrough || lockedThrough > maxLock}
              className="s-btn-primary text-sm w-full"
            >
              {close.isPending ? 'Closing…' : 'Close Period'}
            </button>
          </div>
        )}

        {isAdmin && current?.lockedThrough && (
          <div className="s-card p-4 space-y-3 border-l-4 border-s-red">
            <h3 className="text-sm font-semibold text-s-text">Reopen the latest close</h3>
            <p className="text-xs text-s-muted">
              Removes only the most recent close. The reopening is written to the accounting audit trail and raised in the Exceptions inbox. Say why.
            </p>
            <label htmlFor="reopen-reason" className="block text-xs text-s-muted">Reason (required)</label>
            <input id="reopen-reason" type="text" value={reopenReason} onChange={(e) => setReopenReason(e.target.value)}
              placeholder="e.g. supplier bill for August arrived late"
              className="w-full bg-s-card border border-s-border rounded px-3 py-2 text-sm text-s-text" />
            <button
              onClick={() => reopen.mutate(reopenReason.trim())}
              disabled={reopen.isPending || reopenReason.trim().length < 5}
              className="w-full py-2 rounded font-bold text-sm bg-s-red text-[#fff] disabled:opacity-50"
            >
              {reopen.isPending ? 'Reopening…' : 'Reopen'}
            </button>
          </div>
        )}

        <div className="s-card overflow-hidden">
          <div className="px-4 py-3 border-b border-s-border bg-s-bg-soft">
            <h3 className="text-sm font-semibold text-s-text">Close history</h3>
          </div>
          {(history?.locks ?? []).length === 0 ? (
            <p className="px-4 py-6 text-xs text-s-muted text-center">No period has been closed for this company.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-xs text-s-muted">
                <tr>
                  <th className="px-4 py-2 text-left">Closed through</th>
                  <th className="px-4 py-2 text-left">When</th>
                  <th className="px-4 py-2 text-left">By</th>
                  <th className="px-4 py-2 text-left">Note</th>
                </tr>
              </thead>
              <tbody>
                {history!.locks.map((l) => (
                  <tr key={l.id} className="border-t border-s-border">
                    <td className="px-4 py-2 font-mono text-xs text-s-text">{l.lockedThroughLabel}</td>
                    <td className="px-4 py-2 text-xs text-s-muted">{new Date(l.lockedAt).toLocaleString()}</td>
                    <td className="px-4 py-2 text-xs text-s-text">{l.lockedByName ?? '—'}</td>
                    <td className="px-4 py-2 text-xs text-s-muted">{l.note ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}
