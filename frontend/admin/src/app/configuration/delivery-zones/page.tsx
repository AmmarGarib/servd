'use client'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../../lib/api'

interface Zone {
  id: string
  conceptId: string | null
  name: string
  radiusKmMin: number | null
  radiusKmMax: number | null
  feeCents: number
  freeAboveCents: number | null
  minOrderCents: number
  estimatedMinutes: number | null
  isActive: boolean
}
interface Concept { id: string; name: string }

export default function DeliveryZonesPage() {
  const qc = useQueryClient()
  const [editing, setEditing] = useState<Zone | null>(null)
  const [adding, setAdding] = useState(false)

  const { data: zones = [] } = useQuery<Zone[]>({ queryKey: ['delivery-zones'], queryFn: () => api.get('/setup/delivery-zones') })
  const { data: concepts = [] } = useQuery<Concept[]>({ queryKey: ['concepts'], queryFn: () => api.get('/concepts') })

  const del = useMutation({
    mutationFn: (id: string) => api.delete(`/setup/delivery-zones/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['delivery-zones'] }),
  })

  return (
    <div className="min-h-screen" style={{ background: '#090a0e' }}>
      <header className="px-7 py-6 border-b border-white/[0.05]">
        <Link href="/configuration" className="text-xs text-white/40 hover:text-white/70">← Configuration Hub</Link>
        <div className="flex items-start justify-between gap-4 mt-2">
          <div>
            <h1 className="text-2xl font-black text-white/90">🛵 Delivery zones</h1>
            <p className="text-sm text-white/40 mt-1 max-w-2xl">
              Radius-based delivery rings. Each zone has its own fee, minimum order, and free-delivery threshold.
            </p>
          </div>
          <button onClick={() => setAdding(true)} className="rounded-xl bg-kds-green px-4 py-2.5 text-sm font-black text-black hover:opacity-90">+ New zone</button>
        </div>
      </header>

      <div className="px-7 py-6 max-w-4xl mx-auto space-y-2">
        {zones.length === 0 && (
          <div className="rounded-2xl p-10 text-center" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)' }}>
            <p className="font-bold text-white/85">No delivery zones yet</p>
            <p className="text-sm text-white/45 mt-1">Add your first zone to start charging delivery fees correctly.</p>
          </div>
        )}
        {zones.map((z) => {
          const concept = concepts.find((c) => c.id === z.conceptId)
          return (
            <div key={z.id} className="rounded-2xl p-5"
              style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-lg font-black text-white/90">{z.name}</h3>
                    {!z.isActive && <span className="text-[10px] font-bold text-white/30 px-1.5 py-0.5 rounded bg-white/5">PAUSED</span>}
                    {concept && <span className="text-[10px] font-bold px-2 py-0.5 rounded-full" style={{ background: 'rgba(0,212,177,0.1)', color: '#00D4B1' }}>{concept.name}</span>}
                  </div>
                  <div className="text-sm text-white/55 mt-1 flex flex-wrap gap-x-4 gap-y-1">
                    <span>📍 {z.radiusKmMin ?? 0}–{z.radiusKmMax ?? '∞'} km</span>
                    <span>💸 PKR {(z.feeCents / 100).toFixed(0)}</span>
                    <span>🛒 Min order PKR {(z.minOrderCents / 100).toFixed(0)}</span>
                    {z.freeAboveCents != null && <span>🎁 Free above PKR {(z.freeAboveCents / 100).toFixed(0)}</span>}
                    {z.estimatedMinutes != null && <span>⏱ ~{z.estimatedMinutes} min</span>}
                  </div>
                </div>
                <div className="flex flex-col gap-2 shrink-0">
                  <button onClick={() => setEditing(z)} className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-white/55 hover:text-white">Edit</button>
                  <button onClick={() => { if (confirm(`Delete zone "${z.name}"?`)) del.mutate(z.id) }}
                    className="rounded-lg border border-red-500/20 text-red-400/70 px-3 py-1.5 text-xs hover:text-red-300">Delete</button>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {(adding || editing) && (
        <Modal zone={editing} concepts={concepts} onClose={() => { setAdding(false); setEditing(null) }}
          onSaved={() => { setAdding(false); setEditing(null); void qc.invalidateQueries({ queryKey: ['delivery-zones'] }) }} />
      )}
    </div>
  )
}

function Modal({ zone, concepts, onClose, onSaved }: { zone: Zone | null; concepts: Concept[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(zone?.name ?? '')
  const [conceptId, setConceptId] = useState(zone?.conceptId ?? '')
  const [radiusKmMin, setRadiusKmMin] = useState(zone?.radiusKmMin ?? 0)
  const [radiusKmMax, setRadiusKmMax] = useState(zone?.radiusKmMax ?? 5)
  const [feeCents, setFeeCents] = useState(zone?.feeCents ?? 0)
  const [freeAboveCents, setFreeAboveCents] = useState(zone?.freeAboveCents ?? 0)
  const [minOrderCents, setMinOrderCents] = useState(zone?.minOrderCents ?? 0)
  const [estimatedMinutes, setEstimatedMinutes] = useState(zone?.estimatedMinutes ?? 30)
  const [isActive, setIsActive] = useState(zone?.isActive ?? true)

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        name: name.trim(),
        conceptId: conceptId || null,
        radiusKmMin,
        radiusKmMax,
        feeCents,
        freeAboveCents: freeAboveCents > 0 ? freeAboveCents : null,
        minOrderCents,
        estimatedMinutes,
        isActive,
      }
      if (zone) return api.patch(`/setup/delivery-zones/${zone.id}`, payload)
      return api.post('/setup/delivery-zones', payload)
    },
    onSuccess: () => onSaved(),
  })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-2xl overflow-hidden"
        style={{ background: '#14161e', border: '1px solid rgba(255,255,255,0.08)' }}
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-white/[0.05] px-5 py-3">
          <h2 className="font-black text-white/90">{zone ? 'Edit zone' : 'New delivery zone'}</h2>
          <button onClick={onClose} className="text-white/40 text-xl">✕</button>
        </div>
        <div className="p-5 space-y-4 max-h-[70vh] overflow-y-auto">
          <Field label="Zone name *"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="DHA Phase 5" className={fieldCls} autoFocus /></Field>
          <Field label="Concept">
            <select value={conceptId} onChange={(e) => setConceptId(e.target.value)} className={fieldCls}>
              <option value="">All brands</option>
              {concepts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="From (km)"><input type="number" step="0.1" value={radiusKmMin} onChange={(e) => setRadiusKmMin(parseFloat(e.target.value) || 0)} className={fieldCls} /></Field>
            <Field label="To (km)"><input type="number" step="0.1" value={radiusKmMax} onChange={(e) => setRadiusKmMax(parseFloat(e.target.value) || 0)} className={fieldCls} /></Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Delivery fee (paisa)"><input type="number" value={feeCents} onChange={(e) => setFeeCents(parseInt(e.target.value) || 0)} className={fieldCls} /></Field>
            <Field label="Min order (paisa)"><input type="number" value={minOrderCents} onChange={(e) => setMinOrderCents(parseInt(e.target.value) || 0)} className={fieldCls} /></Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Free above (paisa)"><input type="number" value={freeAboveCents} onChange={(e) => setFreeAboveCents(parseInt(e.target.value) || 0)} placeholder="0 = always charge" className={fieldCls} /></Field>
            <Field label="Est. minutes"><input type="number" value={estimatedMinutes} onChange={(e) => setEstimatedMinutes(parseInt(e.target.value) || 0)} className={fieldCls} /></Field>
          </div>
          {zone && (
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} className="accent-kds-green" />
              <span className="text-xs text-white/65">Active</span>
            </label>
          )}
        </div>
        <div className="flex justify-between gap-3 border-t border-white/[0.05] p-4 bg-white/[0.01]">
          <button onClick={onClose} className="rounded-xl border border-white/10 px-4 py-2.5 text-sm text-white/55 hover:text-white">Cancel</button>
          <button onClick={() => save.mutate()} disabled={save.isPending || !name.trim()}
            className="rounded-xl bg-kds-green px-5 py-2.5 text-sm font-black text-black hover:opacity-90 disabled:opacity-50">
            {save.isPending ? 'Saving…' : zone ? 'Save changes' : 'Create zone'}
          </button>
        </div>
      </div>
    </div>
  )
}

const fieldCls = "w-full rounded-lg bg-white/[0.03] border border-white/[0.08] px-3 py-2 text-sm text-white/85 focus:border-kds-green focus:outline-none"
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><label className="text-xs text-white/55">{label}</label><div className="mt-1">{children}</div></div>
}
