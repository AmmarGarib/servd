'use client'

// Service hours editor. Defines the windows during which a brand accepts
// reservations. Public availability search reads these.
//
// One row per (day-of-week, window) — supports split lunch/dinner schedules.

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { api } from '../../../lib/api'

interface Concept { id: string; name: string }
interface Window { dayOfWeek: number; openMin: number; closeMin: number; isReservable: boolean }

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function minToTime(m: number): string {
  const h = Math.floor(m / 60), mm = m % 60
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}
function timeToMin(t: string): number {
  const [h, m] = t.split(':').map((s) => parseInt(s, 10))
  return (h ?? 0) * 60 + (m ?? 0)
}

export default function ServiceHoursPage() {
  const qc = useQueryClient()
  const [conceptId, setConceptId] = useState('')
  const [draft, setDraft] = useState<Window[]>([])
  const [feedback, setFeedback] = useState<string | null>(null)

  const concepts = useQuery({ queryKey: ['concepts'], queryFn: () => api.get<Concept[]>('/concepts') })
  if (!conceptId && concepts.data && concepts.data.length > 0) setConceptId(concepts.data[0]!.id)

  const list = useQuery({
    queryKey: ['service-hours', conceptId],
    queryFn: () => api.get<Window[]>(`/reservations/service-hours?conceptId=${conceptId}`),
    enabled: !!conceptId,
  })

  useEffect(() => {
    if (list.data) setDraft(list.data)
  }, [list.data])

  const save = useMutation({
    mutationFn: () => api.put(`/reservations/service-hours?conceptId=${conceptId}`, { windows: draft }),
    onSuccess: () => {
      setFeedback('Saved.')
      void qc.invalidateQueries({ queryKey: ['service-hours', conceptId] })
      setTimeout(() => setFeedback(null), 2500)
    },
    onError: (e: { message?: string }) => setFeedback(e.message ?? 'Save failed'),
  })

  function addWindow(dow: number) {
    setDraft((prev) => [...prev, { dayOfWeek: dow, openMin: 11 * 60, closeMin: 23 * 60, isReservable: true }])
  }
  function removeWindow(idx: number) {
    setDraft((prev) => prev.filter((_, i) => i !== idx))
  }
  function patchWindow(idx: number, patch: Partial<Window>) {
    setDraft((prev) => prev.map((w, i) => i === idx ? { ...w, ...patch } : w))
  }

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-6 py-4 flex items-center justify-between flex-wrap gap-3">
        <div>
          <Link href="/reservations" className="text-xs text-s-muted hover:text-s-text">← Reservations</Link>
          <h1 className="text-xl font-bold text-s-text">Service hours</h1>
          <p className="text-xs text-s-muted">When the brand accepts reservations.</p>
        </div>
        <div className="flex items-center gap-2">
          <select value={conceptId} onChange={(e) => setConceptId(e.target.value)} className="bg-white border border-s-border rounded px-2 py-1 text-sm">
            {concepts.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <button onClick={() => save.mutate()} disabled={save.isPending} className="s-btn-primary text-xs">
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </header>

      <div className="p-6 max-w-3xl mx-auto space-y-3">
        {feedback && <p className="text-xs text-s-teal">{feedback}</p>}
        {DAYS.map((label, dow) => {
          const dayWindows = draft.filter((w) => w.dayOfWeek === dow)
          return (
            <section key={dow} className="s-card p-4">
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-sm font-bold text-s-text">{label}</h2>
                <button onClick={() => addWindow(dow)} className="text-xs text-s-teal hover:underline">+ Add window</button>
              </div>
              {dayWindows.length === 0 && (
                <p className="text-xs text-s-muted">Closed</p>
              )}
              {dayWindows.map((w) => {
                const idx = draft.indexOf(w)
                return (
                  <div key={idx} className="flex items-center gap-2 mb-2">
                    <input
                      type="time"
                      value={minToTime(w.openMin)}
                      onChange={(e) => patchWindow(idx, { openMin: timeToMin(e.target.value) })}
                      className="bg-white border border-s-border rounded px-2 py-1 text-sm w-28"
                    />
                    <span className="text-s-muted text-xs">→</span>
                    <input
                      type="time"
                      value={minToTime(w.closeMin)}
                      onChange={(e) => patchWindow(idx, { closeMin: timeToMin(e.target.value) })}
                      className="bg-white border border-s-border rounded px-2 py-1 text-sm w-28"
                    />
                    <label className="text-xs text-s-muted inline-flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={w.isReservable}
                        onChange={(e) => patchWindow(idx, { isReservable: e.target.checked })}
                      />
                      reservable
                    </label>
                    <button onClick={() => removeWindow(idx)} className="text-xs text-s-red ml-auto">Remove</button>
                  </div>
                )
              })}
            </section>
          )
        })}
      </div>
    </div>
  )
}
