'use client'
import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../../lib/api'

interface Concept { id: string; name: string; slug: string }
interface ServiceHour {
  id?: string
  conceptId: string
  dayOfWeek: number
  openMin: number
  closeMin: number
  isReservable: boolean
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

interface DayState {
  dayOfWeek: number
  isOpen: boolean
  openMin: number
  closeMin: number
  isReservable: boolean
}

const DEFAULT_OPEN = 11 * 60
const DEFAULT_CLOSE = 23 * 60

export default function HoursPage() {
  const qc = useQueryClient()
  const { data: concepts = [] } = useQuery<Concept[]>({ queryKey: ['concepts'], queryFn: () => api.get('/concepts') })
  const [conceptId, setConceptId] = useState<string>('')
  useEffect(() => { if (!conceptId && concepts.length > 0) setConceptId(concepts[0]!.id) }, [concepts, conceptId])

  const { data: hours = [], isLoading } = useQuery<ServiceHour[]>({
    queryKey: ['hours', conceptId],
    queryFn: () => api.get(`/setup/hours/${conceptId}`),
    enabled: !!conceptId,
  })

  const [days, setDays] = useState<DayState[]>(
    DAY_LABELS.map((_, i) => ({ dayOfWeek: i, isOpen: true, openMin: DEFAULT_OPEN, closeMin: DEFAULT_CLOSE, isReservable: true })),
  )

  // Hydrate from server when hours load — days that aren't in the response
  // are marked closed.
  useEffect(() => {
    if (!conceptId) return
    const map = new Map<number, ServiceHour>()
    for (const h of hours) map.set(h.dayOfWeek, h)
    setDays(DAY_LABELS.map((_, i) => {
      const h = map.get(i)
      if (h) return { dayOfWeek: i, isOpen: true, openMin: h.openMin, closeMin: h.closeMin, isReservable: h.isReservable }
      return { dayOfWeek: i, isOpen: false, openMin: DEFAULT_OPEN, closeMin: DEFAULT_CLOSE, isReservable: true }
    }))
  }, [hours, conceptId])

  const save = useMutation({
    mutationFn: () => api.put(`/setup/hours/${conceptId}`, {
      hours: days.filter((d) => d.isOpen).map((d) => ({
        dayOfWeek: d.dayOfWeek, openMin: d.openMin, closeMin: d.closeMin, isReservable: d.isReservable,
      })),
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hours', conceptId] }),
  })

  function patch(i: number, p: Partial<DayState>) {
    setDays((prev) => prev.map((d, idx) => idx === i ? { ...d, ...p } : d))
  }
  function applyToAll(openMin: number, closeMin: number) {
    setDays((prev) => prev.map((d) => ({ ...d, openMin, closeMin, isOpen: true })))
  }
  function fmtMin(min: number) { const h = Math.floor(min / 60); const m = min % 60; return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}` }
  function parseMin(v: string) { const [h, m] = v.split(':').map(Number); return ((h ?? 0) * 60 + (m ?? 0)) }

  const concept = concepts.find((c) => c.id === conceptId)

  return (
    <div className="min-h-screen" style={{ background: '#090a0e' }}>
      <header className="px-7 py-6 border-b border-white/[0.05]">
        <Link href="/configuration" className="text-xs text-white/40 hover:text-white/70">← Configuration Hub</Link>
        <h1 className="text-2xl font-black text-white/90 mt-2">🕒 Hours of operation</h1>
        <p className="text-sm text-white/40 mt-1 max-w-2xl">
          Per-brand open/close windows. Storefront refuses orders outside these hours; reservations only land in slots marked reservable.
        </p>
      </header>

      <div className="px-7 py-7 max-w-3xl mx-auto space-y-6">
        {concepts.length === 0 ? (
          <div className="rounded-2xl p-10 text-center"
            style={{ background: 'rgba(245,158,11,0.05)', border: '1px solid rgba(245,158,11,0.2)' }}>
            <p className="font-bold text-amber-400">Add a brand first</p>
            <p className="text-sm text-white/45 mt-1">
              Hours attach to a brand. <Link href="/onboarding" className="text-amber-400 hover:underline">Run setup wizard</Link>.
            </p>
          </div>
        ) : (
          <>
            <div>
              <label className="text-xs text-white/55">Brand</label>
              <select value={conceptId} onChange={(e) => setConceptId(e.target.value)} className={fieldCls + ' mt-1 max-w-sm'}>
                {concepts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>

            {isLoading && <p className="text-xs text-white/40">Loading hours…</p>}

            <div className="rounded-2xl p-5"
              style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}>
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-sm font-black uppercase tracking-[0.18em] text-white/65">{concept?.name ?? 'Brand'} weekly hours</h2>
                <div className="flex gap-1.5">
                  <button onClick={() => applyToAll(11 * 60, 23 * 60)}
                    className="text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded border border-white/10 text-white/55 hover:text-white">
                    11–23 all
                  </button>
                  <button onClick={() => applyToAll(9 * 60, 22 * 60)}
                    className="text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded border border-white/10 text-white/55 hover:text-white">
                    9–22 all
                  </button>
                </div>
              </div>

              <div className="space-y-2">
                {days.map((d, i) => (
                  <div key={i} className="flex items-center gap-3 rounded-lg p-3"
                    style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}>
                    <label className="flex items-center gap-2 cursor-pointer w-20">
                      <input type="checkbox" checked={d.isOpen} onChange={(e) => patch(i, { isOpen: e.target.checked })} className="accent-kds-green" />
                      <span className="text-sm font-bold text-white/85">{DAY_LABELS[i]}</span>
                    </label>
                    <input type="time" value={fmtMin(d.openMin)} onChange={(e) => patch(i, { openMin: parseMin(e.target.value) })}
                      disabled={!d.isOpen} className={fieldCls + ' w-32 disabled:opacity-40'} />
                    <span className="text-white/40 text-sm">→</span>
                    <input type="time" value={fmtMin(d.closeMin)} onChange={(e) => patch(i, { closeMin: parseMin(e.target.value) })}
                      disabled={!d.isOpen} className={fieldCls + ' w-32 disabled:opacity-40'} />
                    {d.isOpen ? (
                      <label className="flex items-center gap-1.5 ml-auto cursor-pointer">
                        <input type="checkbox" checked={d.isReservable}
                          onChange={(e) => patch(i, { isReservable: e.target.checked })}
                          className="accent-kds-green" />
                        <span className="text-[10px] font-bold uppercase tracking-wider text-white/50">Reservable</span>
                      </label>
                    ) : (
                      <span className="text-xs text-white/35 italic ml-auto">Closed</span>
                    )}
                  </div>
                ))}
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-4 border-t border-white/[0.05]">
              <button onClick={() => save.mutate()} disabled={save.isPending || !conceptId}
                className="rounded-xl bg-kds-green px-5 py-2.5 text-sm font-black text-black hover:opacity-90 disabled:opacity-50">
                {save.isPending ? 'Saving…' : 'Save hours'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

const fieldCls = "w-full rounded-lg bg-white/[0.03] border border-white/[0.08] px-3 py-2 text-sm text-white/85 focus:border-kds-green focus:outline-none"
