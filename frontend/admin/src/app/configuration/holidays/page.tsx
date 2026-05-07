'use client'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../../lib/api'

interface Concept { id: string; name: string; slug: string }
interface Holiday {
  id: string
  conceptId: string
  kind: 'closure' | 'reduced_capacity' | 'special_hours'
  startTime: string
  endTime: string
  capacityCap: number | null
  reason: string | null
  concept: { id: string; name: string; slug: string }
}

export default function HolidaysPage() {
  const qc = useQueryClient()
  const [adding, setAdding] = useState(false)
  const { data: concepts = [] } = useQuery<Concept[]>({ queryKey: ['concepts'], queryFn: () => api.get('/concepts') })
  const { data: holidays = [] } = useQuery<Holiday[]>({ queryKey: ['holidays'], queryFn: () => api.get('/setup/holidays') })

  const del = useMutation({
    mutationFn: (id: string) => api.delete(`/setup/holidays/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['holidays'] }),
  })

  return (
    <div className="min-h-screen" style={{ background: '#090a0e' }}>
      <header className="px-7 py-6 border-b border-white/[0.05]">
        <Link href="/configuration" className="text-xs text-white/40 hover:text-white/70">← Configuration Hub</Link>
        <div className="flex items-start justify-between gap-4 mt-2">
          <div>
            <h1 className="text-2xl font-black text-white/90">📅 Holidays &amp; closures</h1>
            <p className="text-sm text-white/40 mt-1 max-w-2xl">
              Block out dates when a brand is closed or running reduced capacity. The storefront refuses new orders during a closure window automatically.
            </p>
          </div>
          <button onClick={() => setAdding(true)}
            disabled={concepts.length === 0}
            className="rounded-xl bg-kds-green px-4 py-2.5 text-sm font-black text-black hover:opacity-90 disabled:opacity-40">
            + Add closure
          </button>
        </div>
      </header>

      <div className="px-7 py-6 max-w-4xl space-y-2">
        {concepts.length === 0 && (
          <div className="rounded-2xl p-10 text-center"
            style={{ background: 'rgba(245,158,11,0.05)', border: '1px solid rgba(245,158,11,0.2)' }}>
            <p className="font-bold text-amber-400">Add a brand first</p>
            <p className="text-sm text-white/45 mt-1">
              Holidays attach to a brand. <Link href="/onboarding" className="text-amber-400 hover:underline">Run the setup wizard</Link> or
              add one in <Link href="/settings" className="text-amber-400 hover:underline">Settings</Link>.
            </p>
          </div>
        )}

        {concepts.length > 0 && holidays.length === 0 && (
          <div className="rounded-2xl p-10 text-center"
            style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)' }}>
            <p className="font-bold text-white/85">No closures scheduled</p>
            <p className="text-sm text-white/45 mt-1">Click + Add closure to block out a date.</p>
          </div>
        )}

        {holidays.map((h) => (
          <div key={h.id} className="rounded-2xl p-5"
            style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full"
                    style={h.kind === 'closure'
                      ? { background: 'rgba(239,68,68,0.12)', color: '#FCA5A5' }
                      : { background: 'rgba(245,158,11,0.12)', color: '#FCD34D' }}>
                    {h.kind.replace(/_/g, ' ')}
                  </span>
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded-full" style={{ background: 'rgba(0,212,177,0.1)', color: '#00D4B1' }}>
                    {h.concept.name}
                  </span>
                </div>
                <p className="text-sm font-bold text-white/85 mt-2">
                  {new Date(h.startTime).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}
                  {' '}→{' '}
                  {new Date(h.endTime).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}
                </p>
                {h.kind === 'reduced_capacity' && h.capacityCap != null && (
                  <p className="text-xs text-white/55">Cap: {h.capacityCap} tables</p>
                )}
                {h.reason && <p className="text-xs text-white/55 mt-1">{h.reason}</p>}
              </div>
              <button onClick={() => { if (confirm('Remove this closure?')) del.mutate(h.id) }}
                className="rounded-lg border border-red-500/20 text-red-400/70 px-3 py-1.5 text-xs hover:text-red-300">
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>

      {adding && (
        <Modal concepts={concepts}
          onClose={() => setAdding(false)}
          onSaved={() => { setAdding(false); qc.invalidateQueries({ queryKey: ['holidays'] }) }} />
      )}
    </div>
  )
}

function Modal({ concepts, onClose, onSaved }: { concepts: Concept[]; onClose: () => void; onSaved: () => void }) {
  const [conceptId, setConceptId] = useState(concepts[0]?.id ?? '')
  const [kind, setKind] = useState<'closure' | 'reduced_capacity' | 'special_hours'>('closure')
  const today = new Date().toISOString().slice(0, 10)
  const [startDate, setStartDate] = useState(today)
  const [endDate, setEndDate] = useState(today)
  const [allDay, setAllDay] = useState(true)
  const [startTime, setStartTime] = useState('09:00')
  const [endTime, setEndTime] = useState('23:59')
  const [capacityCap, setCapacityCap] = useState<number | ''>('')
  const [reason, setReason] = useState('')

  const save = useMutation({
    mutationFn: () => {
      const start = allDay ? `${startDate}T00:00:00` : `${startDate}T${startTime}:00`
      const end   = allDay ? `${endDate}T23:59:59` : `${endDate}T${endTime}:00`
      return api.post('/setup/holidays', {
        conceptId, kind,
        startTime: start, endTime: end,
        capacityCap: kind === 'reduced_capacity' ? (capacityCap === '' ? null : capacityCap) : null,
        reason: reason || null,
      })
    },
    onSuccess: () => onSaved(),
  })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-2xl overflow-hidden"
        style={{ background: '#14161e', border: '1px solid rgba(255,255,255,0.08)' }}
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-white/[0.05] px-5 py-3">
          <h2 className="font-black text-white/90">Add closure</h2>
          <button onClick={onClose} className="text-white/40 text-xl">✕</button>
        </div>
        <div className="p-5 space-y-3 max-h-[70vh] overflow-y-auto">
          <Field label="Brand *">
            <select value={conceptId} onChange={(e) => setConceptId(e.target.value)} className={fieldCls}>
              {concepts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <Field label="Kind">
            <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} className={fieldCls}>
              <option value="closure">Closure (no orders)</option>
              <option value="reduced_capacity">Reduced capacity</option>
              <option value="special_hours">Special hours</option>
            </select>
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="From *">
              <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className={fieldCls} />
            </Field>
            <Field label="To *">
              <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className={fieldCls} />
            </Field>
          </div>

          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} className="accent-kds-green" />
            <span className="text-xs text-white/65">All day</span>
          </label>

          {!allDay && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Start time"><input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} className={fieldCls} /></Field>
              <Field label="End time"><input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} className={fieldCls} /></Field>
            </div>
          )}

          {kind === 'reduced_capacity' && (
            <Field label="Max tables / capacity">
              <input type="number" value={capacityCap} onChange={(e) => setCapacityCap(e.target.value === '' ? '' : parseInt(e.target.value))} className={fieldCls} />
            </Field>
          )}

          <Field label="Reason / note">
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Eid holiday · staff training · maintenance" className={fieldCls} />
          </Field>
        </div>
        <div className="flex justify-between gap-3 border-t border-white/[0.05] p-4 bg-white/[0.01]">
          <button onClick={onClose} className="rounded-xl border border-white/10 px-4 py-2.5 text-sm text-white/55 hover:text-white">Cancel</button>
          <button onClick={() => save.mutate()} disabled={save.isPending || !conceptId}
            className="rounded-xl bg-kds-green px-5 py-2.5 text-sm font-black text-black hover:opacity-90 disabled:opacity-50">
            {save.isPending ? 'Saving…' : 'Add closure'}
          </button>
        </div>
      </div>
    </div>
  )
}

const fieldCls = "w-full rounded-lg bg-white/[0.03] border border-white/[0.08] px-3 py-2 text-sm text-white/85 focus:border-kds-green focus:outline-none"
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <div><label className="text-xs text-white/55">{label}</label><div className="mt-1">{children}</div></div> }
