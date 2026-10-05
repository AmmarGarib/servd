'use client'
// Food safety — temperature checks, cleaning, corrective action.
//
// Base layer, built for a tablet on the pass: big targets, one reading at a
// time. The rule that matters: an out-of-range reading cannot be saved without
// saying what was done about it, and it raises a flag for a manager.

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../lib/api'

interface Reading { id: string; readingC: number; withinRange: boolean; correctiveAction: string | null; takenAt: string; unit?: { name: string } }
interface Unit { id: string; name: string; kind: string; minC: number | null; maxC: number | null; lastReading: Reading | null; checkedToday: boolean }
interface Task { id: string; name: string; area: string | null; frequency: string; lastDoneAt: string | null; due: boolean }
interface Summary { units: Unit[]; readings: Reading[]; outOfRangeToday: number; cleaning: Task[]; cleaningDue: number }

const card = { background: 'rgb(var(--fg-rgb) / 0.03)', border: '1px solid rgb(var(--fg-rgb) / 0.07)' }
const inp = 'w-full rounded-xl px-3 py-3 text-base bg-white/[0.04] border border-white/10 text-white/90 focus:outline-none focus:border-primary'
const limits = (u: { minC: number | null; maxC: number | null }) =>
  u.minC !== null && u.maxC !== null ? `${u.minC} to ${u.maxC}°C` : u.minC !== null ? `at least ${u.minC}°C` : u.maxC !== null ? `at most ${u.maxC}°C` : 'no limit'
const inRange = (v: number, u: { minC: number | null; maxC: number | null }) =>
  !((u.minC !== null && v < u.minC) || (u.maxC !== null && v > u.maxC))
const ago = (iso: string) => {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`
}

export default function FoodSafetyPage() {
  const qc = useQueryClient()
  const { data, error } = useQuery({ queryKey: ['food-safety'], queryFn: () => api.get<Summary>('/food-safety/summary'), refetchInterval: 60_000 })
  const [logging, setLogging] = useState<Unit | null>(null)
  const refresh = () => void qc.invalidateQueries({ queryKey: ['food-safety'] })

  const presetUnits = useMutation({ mutationFn: () => api.post('/food-safety/units/presets', {}), onSuccess: refresh })
  const presetTasks = useMutation({ mutationFn: () => api.post('/food-safety/cleaning/presets', {}), onSuccess: refresh })
  const done = useMutation({ mutationFn: (id: string) => api.post(`/food-safety/cleaning/tasks/${id}/done`, {}), onSuccess: refresh })

  const checked = data?.units.filter((u) => u.checkedToday).length ?? 0
  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <header className="px-7 py-6 border-b border-white/[0.05]">
        <Link href="/modules/haccp" className="text-xs text-white/40 hover:text-white/70">← Food safety</Link>
        <h1 className="text-2xl font-black text-white/90 mt-2">Food safety logs</h1>
        <p className="text-sm text-white/40 mt-1 max-w-2xl">Check every unit each day. A reading outside its limit needs a note on what you did.</p>
      </header>

      <div className="px-7 py-6 max-w-5xl mx-auto space-y-6">
        {error && <p className="text-sm text-red-700">{(error as Error).message}</p>}
        {data && (
          <div className="grid grid-cols-3 gap-3">
            <Stat label="Checked today" value={`${checked} / ${data.units.length}`} warn={checked < data.units.length} />
            <Stat label="Out of range (24h)" value={String(data.outOfRangeToday)} warn={data.outOfRangeToday > 0} />
            <Stat label="Cleaning due" value={String(data.cleaningDue)} warn={data.cleaningDue > 0} />
          </div>
        )}

        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-black text-white/85">Temperatures</h2>
            <button onClick={() => presetUnits.mutate()} disabled={presetUnits.isPending} className="text-xs font-bold text-white/50 hover:text-white">
              + Add standard units
            </button>
          </div>
          {data && data.units.length === 0 && (
            <div className="rounded-2xl p-8 text-center" style={card}>
              <p className="font-bold text-white/85">No units set up</p>
              <p className="text-sm text-white/45 mt-1">Add the standard set (chillers, freezer, hot hold, cooking core, deliveries) and adjust the limits to your plan.</p>
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {data?.units.map((u) => {
              const bad = u.lastReading && !u.lastReading.withinRange
              return (
                <button key={u.id} onClick={() => setLogging(u)} className="text-left rounded-2xl p-4 transition-all hover:bg-white/[0.05]"
                  style={{ ...card, borderColor: bad ? 'rgba(248,113,113,0.5)' : !u.checkedToday ? 'rgba(245,158,11,0.4)' : card.border }}>
                  <p className="font-bold text-white/90">{u.name}</p>
                  <p className="text-[11px] text-white/40">{limits(u)}</p>
                  <p className="text-2xl font-black mt-2" style={{ color: bad ? '#b42318' : 'rgb(var(--fg-rgb) / 0.9)' }}>
                    {u.lastReading ? `${u.lastReading.readingC}°C` : '—'}
                  </p>
                  <p className="text-[11px] mt-1" style={{ color: u.checkedToday ? 'rgb(var(--fg-rgb) / 0.4)' : '#a15c00' }}>
                    {u.lastReading ? ago(u.lastReading.takenAt) : 'never checked'}{!u.checkedToday && ' · check due'}
                  </p>
                </button>
              )
            })}
          </div>
        </section>

        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-lg font-black text-white/85">Cleaning</h2>
            <button onClick={() => presetTasks.mutate()} disabled={presetTasks.isPending} className="text-xs font-bold text-white/50 hover:text-white">
              + Add standard schedule
            </button>
          </div>
          <div className="space-y-2">
            {data?.cleaning.map((t) => (
              <div key={t.id} className="rounded-2xl p-4 flex items-center justify-between gap-3" style={{ ...card, borderColor: t.due ? 'rgba(245,158,11,0.4)' : card.border }}>
                <div className="min-w-0">
                  <p className="font-bold text-white/90">{t.name}</p>
                  <p className="text-[11px] text-white/40">{[t.area, t.frequency].filter(Boolean).join(' · ')} · {t.lastDoneAt ? `done ${ago(t.lastDoneAt)}` : 'never done'}</p>
                </div>
                <button onClick={() => done.mutate(t.id)} disabled={done.isPending}
                  className="rounded-xl px-4 py-3 text-sm font-black shrink-0"
                  style={t.due ? { background: 'var(--erp-primary)', color: 'var(--erp-on-primary)' } : { border: '1px solid rgb(var(--fg-rgb) / 0.1)', color: 'rgb(var(--fg-rgb) / 0.5)' }}>
                  {t.due ? 'Mark done' : 'Done again'}
                </button>
              </div>
            ))}
          </div>
        </section>

        {data && data.readings.length > 0 && (
          <section>
            <h2 className="text-lg font-black text-white/85 mb-3">Last 24 hours</h2>
            <div className="rounded-2xl overflow-hidden" style={card}>
              {data.readings.map((r) => (
                <div key={r.id} className="px-4 py-2.5 border-t border-white/[0.05] first:border-t-0 text-sm flex gap-3">
                  <span className="w-20 text-white/40 shrink-0">{new Date(r.takenAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  <span className="flex-1 text-white/75">{r.unit?.name}</span>
                  <span className="font-bold" style={{ color: r.withinRange ? 'rgb(var(--fg-rgb) / 0.85)' : '#b42318' }}>{r.readingC}°C</span>
                  {r.correctiveAction && <span className="text-[11px] text-white/45 truncate max-w-[40%]">{r.correctiveAction}</span>}
                </div>
              ))}
            </div>
          </section>
        )}
      </div>

      {logging && <LogReading unit={logging} onClose={() => setLogging(null)} onSaved={refresh} />}
    </div>
  )
}

function Stat({ label, value, warn }: { label: string; value: string; warn: boolean }) {
  return (
    <div className="rounded-2xl p-4" style={card}>
      <p className="text-[10px] uppercase tracking-wider text-white/40 font-bold">{label}</p>
      <p className="text-2xl font-black mt-1" style={{ color: warn ? '#a15c00' : 'rgb(var(--fg-rgb) / 0.9)' }}>{value}</p>
    </div>
  )
}

function LogReading({ unit, onClose, onSaved }: { unit: Unit; onClose: () => void; onSaved: () => void }) {
  const [value, setValue] = useState('')
  const [action, setAction] = useState('')
  const [err, setErr] = useState('')
  const v = Number(value)
  const has = value.trim() !== '' && !Number.isNaN(v)
  const bad = has && !inRange(v, unit)
  const save = useMutation({
    mutationFn: () => api.post('/food-safety/temperatures', { unitId: unit.id, readingC: v, ...(bad && { correctiveAction: action }) }),
    onSuccess: () => { onSaved(); onClose() },
    onError: (e: Error) => setErr(e.message),
  })
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-secondary/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl p-6" style={{ background: 'var(--surface)', border: '1px solid rgb(var(--fg-rgb) / 0.08)' }} onClick={(e) => e.stopPropagation()}>
        <p className="text-lg font-black text-white/90">{unit.name}</p>
        <p className="text-sm text-white/45">Limit: {limits(unit)}</p>
        <label className="block mt-4">
          <span className="text-[11px] font-bold text-white/50">Reading (°C)</span>
          <input autoFocus type="number" inputMode="decimal" step="0.1" className={inp} value={value} onChange={(e) => setValue(e.target.value)} />
        </label>
        {bad && (
          <label className="block mt-3">
            <span className="text-[11px] font-bold" style={{ color: '#b42318' }}>Out of range — what did you do about it?</span>
            <textarea rows={3} className={inp} value={action} onChange={(e) => setAction(e.target.value)}
              placeholder="Moved stock to the walk-in, told the manager, called the engineer" />
          </label>
        )}
        {err && <p className="text-xs text-red-700 mt-3">{err}</p>}
        <div className="flex gap-2 mt-5">
          <button onClick={() => save.mutate()} disabled={save.isPending || !has || (bad && action.trim().length < 3)}
            className="flex-1 rounded-xl bg-primary py-3 text-base font-black text-primary-on disabled:opacity-50">{save.isPending ? 'Saving…' : 'Save reading'}</button>
          <button onClick={onClose} className="rounded-xl px-4 py-3 text-sm text-white/60 border border-white/10">Cancel</button>
        </div>
      </div>
    </div>
  )
}
