'use client'
import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../../lib/api'
import { useBrandFilter } from '../../../store/brandFilter'
import { Select } from '@/components/ui/Select'
import { useConfirm } from '@/components/ui/ConfirmDialog'

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

interface Window { openMin: number; closeMin: number; isReservable: boolean }
interface DayState {
  dayOfWeek: number
  isOpen: boolean
  // Several windows per day are allowed (split lunch / dinner service). This
  // is the one hours editor (D1) — the old /reservations/hours page, which
  // supported split windows, now redirects here, so this editor must keep them.
  windows: Window[]
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

// The server treats a close at or before the open as "closes the next day"
// (storefront/serviceHours.ts, reservations/hours.ts). So an earlier close is
// not an error — it is shown as an overnight window — but an identical open
// and close is almost certainly a slip, and windows of one day must not overlap.
function windowEnd(w: Window): number { return w.closeMin <= w.openMin ? w.closeMin + 1440 : w.closeMin }

/** Problems per window index for one day: same open/close, or overlap with another window. */
function windowProblems(windows: Window[]): Record<number, string> {
  const out: Record<number, string> = {}
  windows.forEach((w, i) => {
    if (w.closeMin === w.openMin) out[i] = 'Opening and closing time are the same.'
  })
  for (let a = 0; a < windows.length; a++) {
    for (let b = a + 1; b < windows.length; b++) {
      const x = windows[a]!, y = windows[b]!
      if (x.openMin < windowEnd(y) && y.openMin < windowEnd(x)) {
        out[a] = out[a] ?? `Overlaps window ${b + 1}.`
        out[b] = out[b] ?? `Overlaps window ${a + 1}.`
      }
    }
  }
  return out
}

const DEFAULT_OPEN = 11 * 60
const DEFAULT_CLOSE = 23 * 60
const DEFAULT_WINDOW: Window = { openMin: DEFAULT_OPEN, closeMin: DEFAULT_CLOSE, isReservable: true }

export default function HoursPage() {
  const qc = useQueryClient()
  const confirm = useConfirm()
  const { data: concepts = [] } = useQuery<Concept[]>({ queryKey: ['concepts'], queryFn: () => api.get('/concepts') })
  const [conceptId, setConceptId] = useState<string>(() => useBrandFilter.getState().brandId ?? '')
  useEffect(() => { if (!conceptId && concepts.length > 0) setConceptId(concepts[0]!.id) }, [concepts, conceptId])

  const { data: hours = [], isLoading } = useQuery<ServiceHour[]>({
    queryKey: ['hours', conceptId],
    queryFn: () => api.get(`/setup/hours/${conceptId}`),
    enabled: !!conceptId,
  })

  const [days, setDays] = useState<DayState[]>(
    DAY_LABELS.map((_, i) => ({ dayOfWeek: i, isOpen: true, windows: [{ ...DEFAULT_WINDOW }] })),
  )

  // Hydrate from server when hours load — days with no rows are closed.
  useEffect(() => {
    if (!conceptId) return
    setDays(DAY_LABELS.map((_, i) => {
      const rows = hours.filter((h) => h.dayOfWeek === i)
      return rows.length > 0
        ? { dayOfWeek: i, isOpen: true, windows: rows.map((h) => ({ openMin: h.openMin, closeMin: h.closeMin, isReservable: h.isReservable })) }
        : { dayOfWeek: i, isOpen: false, windows: [{ ...DEFAULT_WINDOW }] }
    }))
  }, [hours, conceptId])

  const save = useMutation({
    mutationFn: () => api.put(`/setup/hours/${conceptId}`, {
      hours: days.filter((d) => d.isOpen).flatMap((d) => d.windows.map((w) => ({
        dayOfWeek: d.dayOfWeek, openMin: w.openMin, closeMin: w.closeMin, isReservable: w.isReservable,
      }))),
    }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['hours', conceptId] }),
  })

  function patch(i: number, p: Partial<DayState>) {
    setDays((prev) => prev.map((d, idx) => idx === i ? { ...d, ...p } : d))
  }
  function patchWindow(i: number, w: number, p: Partial<Window>) {
    setDays((prev) => prev.map((d, idx) => idx !== i ? d : { ...d, windows: d.windows.map((x, wi) => wi === w ? { ...x, ...p } : x) }))
  }
  function addWindow(i: number) {
    setDays((prev) => prev.map((d, idx) => idx !== i ? d : { ...d, isOpen: true, windows: [...d.windows, { ...DEFAULT_WINDOW }] }))
  }
  function removeWindow(i: number, w: number) {
    setDays((prev) => prev.map((d, idx) => {
      if (idx !== i) return d
      const windows = d.windows.filter((_, wi) => wi !== w)
      return windows.length > 0 ? { ...d, windows } : { ...d, isOpen: false, windows: [{ ...DEFAULT_WINDOW }] }
    }))
  }
  function applyToAll(openMin: number, closeMin: number) {
    setDays((prev) => prev.map((d) => ({ ...d, isOpen: true, windows: [{ openMin, closeMin, isReservable: true }] })))
  }
  async function copyDayToOthers(i: number) {
    const src = days[i]
    if (!src) return
    const ok = await confirm({
      title: `Copy ${DAY_NAMES[i]}'s hours to every other day?`,
      body: 'This replaces the other days\' hours here. Nothing is saved until you press Save hours.',
      confirmLabel: 'Copy to other days',
    })
    if (!ok) return
    setDays((prev) => prev.map((d, idx) => idx === i ? d : { ...d, isOpen: src.isOpen, windows: src.windows.map((w) => ({ ...w })) }))
  }
  const problems = days.map((d) => (d.isOpen ? windowProblems(d.windows) : {}))
  const hasProblems = problems.some((p) => Object.keys(p).length > 0)
  function fmtMin(min: number) { const h = Math.floor(min / 60); const m = min % 60; return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}` }
  function parseMin(v: string) { const [h, m] = v.split(':').map(Number); return ((h ?? 0) * 60 + (m ?? 0)) }

  const concept = concepts.find((c) => c.id === conceptId)

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <header className="px-7 py-6 border-b border-white/[0.05]">
        <Link href="/configuration" className="text-xs text-white/40 hover:text-white/70">← Configuration Hub</Link>
        <h1 className="text-2xl font-black text-white/90 mt-2">Hours of operation</h1>
        <p className="text-sm text-white/40 mt-1 max-w-2xl">
          Per-brand open/close windows — add a second window for split lunch / dinner service. Storefront refuses orders outside these hours; reservations only land in windows marked reservable.
        </p>
      </header>

      <div className="px-7 py-7 max-w-3xl mx-auto space-y-6">
        {concepts.length === 0 ? (
          <div className="rounded-2xl p-10 text-center"
            style={{ background: 'color-mix(in srgb, var(--erp-warning) 5%, transparent)', border: '1px solid color-mix(in srgb, var(--erp-warning) 20%, transparent)' }}>
            <p className="font-bold text-amber-700">Add a brand first</p>
            <p className="text-sm text-white/45 mt-1">
              Hours attach to a brand. <Link href="/onboarding" className="text-amber-700 hover:underline">Run setup wizard</Link>.
            </p>
          </div>
        ) : (
          <>
            <div>
              <label className="text-xs text-white/55">Brand</label>
              <Select value={conceptId} onChange={(e) => setConceptId(e.target.value)} className={fieldCls + ' mt-1 max-w-sm'}>
                {concepts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </div>

            {isLoading && <p className="text-xs text-white/40">Loading hours…</p>}

            <div className="rounded-2xl p-5"
              style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-sm font-black uppercase tracking-[0.18em] text-white/65">{concept?.name ?? 'Brand'} weekly hours</h2>
                <div className="flex gap-1.5">
                  <button type="button" onClick={() => applyToAll(11 * 60, 23 * 60)}
                    className="text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded border border-white/10 text-white/55 hover:text-white">
                    11–23 all
                  </button>
                  <button type="button" onClick={() => applyToAll(9 * 60, 22 * 60)}
                    className="text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded border border-white/10 text-white/55 hover:text-white">
                    9–22 all
                  </button>
                </div>
              </div>

              <div className="space-y-2">
                {days.map((d, i) => (
                  <div key={i} className="rounded-lg p-3 space-y-2"
                    style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: d.isOpen ? '1px solid rgb(var(--erp-accent-rgb) / 0.45)' : '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
                    <div className="flex items-center gap-3">
                      <label className="flex items-center gap-2 cursor-pointer w-20">
                        <input type="checkbox" checked={d.isOpen} onChange={(e) => patch(i, { isOpen: e.target.checked })} className="accent-accent" />
                        <span className="text-sm font-bold text-white/85">{DAY_LABELS[i]}</span>
                      </label>
                      {d.isOpen ? (
                        <div className="ml-auto flex flex-wrap justify-end gap-1.5">
                          <button type="button" onClick={() => void copyDayToOthers(i)}
                            className="text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded border border-white/10 text-white/55 hover:text-white">
                            Copy to other days
                          </button>
                          <button type="button" onClick={() => addWindow(i)}
                            className="text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded border border-white/10 text-white/55 hover:text-white">
                            + Window
                          </button>
                        </div>
                      ) : (
                        <span className="text-xs text-white/35 italic ml-auto">Closed</span>
                      )}
                    </div>
                    {d.isOpen && d.windows.map((w, wi) => (
                      <div key={wi} className="pl-0 sm:pl-20">
                      <div className="flex items-center gap-x-3 gap-y-2 flex-wrap">
                        <input type="time" value={fmtMin(w.openMin)} onChange={(e) => e.target.value && patchWindow(i, wi, { openMin: parseMin(e.target.value) })}
                          aria-label={`${DAY_NAMES[i]} window ${wi + 1} opens at`} aria-invalid={!!problems[i]?.[wi]}
                          className={fieldCls + ' w-32'} />
                        <span className="text-white/40 text-sm" aria-hidden>→</span>
                        <input type="time" value={fmtMin(w.closeMin)} onChange={(e) => e.target.value && patchWindow(i, wi, { closeMin: parseMin(e.target.value) })}
                          aria-label={`${DAY_NAMES[i]} window ${wi + 1} closes at`} aria-invalid={!!problems[i]?.[wi]}
                          className={fieldCls + ' w-32'} />
                        <label className="flex items-center gap-1.5 cursor-pointer">
                          <input type="checkbox" checked={w.isReservable}
                            onChange={(e) => patchWindow(i, wi, { isReservable: e.target.checked })}
                            className="accent-accent" />
                          <span className="text-[10px] font-bold uppercase tracking-wider text-white/50">Reservable</span>
                        </label>
                        <button type="button" onClick={() => removeWindow(i, wi)} aria-label={`Remove ${DAY_NAMES[i]} window ${wi + 1}`}
                          className="ml-auto text-xs text-red-700/80 hover:text-red-700 min-h-[44px] px-2">Remove</button>
                      </div>
                      {problems[i]?.[wi] ? (
                        <p role="alert" className="text-[11px] mt-1" style={{ color: 'var(--erp-danger)' }}>{problems[i]![wi]}</p>
                      ) : w.closeMin < w.openMin ? (
                        <p className="text-[11px] mt-1 text-white/45">Closes the next day.</p>
                      ) : null}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-4 border-t border-white/[0.05]">
              <button type="button" onClick={() => save.mutate()} disabled={save.isPending || !conceptId || hasProblems}
                className="rounded-xl bg-primary px-5 py-2.5 text-sm font-black text-primary-on hover:opacity-90 disabled:opacity-50">
                {save.isPending ? 'Saving…' : 'Save hours'}
              </button>
              {hasProblems && <p role="alert" className="self-center text-xs" style={{ color: 'var(--erp-danger)' }}>Fix the highlighted windows to save.</p>}
              {save.isError && <p role="alert" className="self-center text-xs text-red-700">{(save.error as Error).message}</p>}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

const fieldCls = "w-full rounded-lg bg-white/[0.03] border border-white/[0.08] px-3 py-2 text-sm text-white/85 focus:border-primary focus:outline-none"
