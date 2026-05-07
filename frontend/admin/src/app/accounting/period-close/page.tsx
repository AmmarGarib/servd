'use client'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../../lib/api'
import { todayPktIso } from '../../../lib/money'
import Link from 'next/link'

interface CurrentLock {
  lockedThrough: string | null
  lockedAt: string | null
  lockedBy: string | null
  note: string | null
}

export default function PeriodClosePage() {
  const qc = useQueryClient()
  const [lockedThrough, setLockedThrough] = useState(todayPktIso())
  const [note, setNote] = useState('')
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(null)

  const { data: current } = useQuery({
    queryKey: ['period-close'],
    queryFn: () => api.get<CurrentLock>('/accounting/period-close'),
  })

  const close = useMutation({
    mutationFn: (input: { lockedThrough: string; note?: string }) =>
      api.post('/accounting/period-close', input),
    onSuccess: () => {
      setFeedback({ ok: true, msg: `Period closed through ${lockedThrough}` })
      void qc.invalidateQueries({ queryKey: ['period-close'] })
      setNote('')
    },
    onError: (err: { message?: string }) => {
      setFeedback({ ok: false, msg: err.message ?? 'Failed to close period' })
    },
  })

  const lockedThroughDisplay = current?.lockedThrough
    ? new Date(current.lockedThrough).toISOString().slice(0, 10)
    : 'Open'

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-6 py-4">
        <Link href="/accounting" className="text-xs text-s-muted hover:text-s-text">← Accounting</Link>
        <h1 className="text-xl font-bold text-s-text">Period Close</h1>
      </header>

      <div className="p-6 max-w-2xl space-y-4">
        <div className="s-card p-4">
          <p className="text-xs text-s-muted">Books are currently closed through</p>
          <p className="text-2xl font-bold text-s-text">{lockedThroughDisplay}</p>
          {current?.lockedAt && (
            <p className="text-xs text-s-muted mt-2">
              Locked at {new Date(current.lockedAt).toLocaleString()} by {current.lockedBy}
              {current.note && <> — {current.note}</>}
            </p>
          )}
        </div>

        <div className="s-card p-4 space-y-3">
          <h3 className="text-sm font-semibold text-s-text">Close a new period</h3>
          <p className="text-xs text-s-muted">
            After closing, postings dated on or before this date will be rejected. Lock dates can only move forward.
          </p>
          <div className="space-y-2">
            <label className="block text-xs text-s-muted">Lock through (inclusive)</label>
            <input type="date" value={lockedThrough} onChange={(e) => setLockedThrough(e.target.value)}
              className="w-full bg-s-card border border-s-border rounded px-3 py-2 text-sm text-s-text" />
          </div>
          <div className="space-y-2">
            <label className="block text-xs text-s-muted">Note (optional)</label>
            <input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. April month-end signed off"
              className="w-full bg-s-card border border-s-border rounded px-3 py-2 text-sm text-s-text" />
          </div>
          <button
            onClick={() => close.mutate({ lockedThrough, ...(note ? { note } : {}) })}
            disabled={close.isPending}
            className="s-btn-primary text-sm w-full"
          >
            {close.isPending ? 'Closing…' : 'Close Period'}
          </button>
          {feedback && (
            <p className={`text-xs ${feedback.ok ? 'text-s-teal' : 'text-s-red'}`}>{feedback.msg}</p>
          )}
        </div>
      </div>
    </div>
  )
}
