'use client'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../../lib/api'

interface Device { id: string; name: string; stationId: string | null; conceptId: string | null; deviceFingerprint: string | null; lastSeenAt: string | null; isActive: boolean; notes: string | null }
interface Station { id: string; name: string }
interface Concept { id: string; name: string }

export default function KdsDevicesPage() {
  const qc = useQueryClient()
  const [editing, setEditing] = useState<Device | null>(null)
  const [adding, setAdding] = useState(false)
  const { data: devices = [] } = useQuery<Device[]>({ queryKey: ['kds-devices'], queryFn: () => api.get('/setup/kds-devices') })
  const { data: stations = [] } = useQuery<Station[]>({ queryKey: ['stations'], queryFn: () => api.get('/stations') })
  const { data: concepts = [] } = useQuery<Concept[]>({ queryKey: ['concepts'], queryFn: () => api.get('/concepts') })
  const del = useMutation({ mutationFn: (id: string) => api.delete(`/setup/kds-devices/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['kds-devices'] }) })

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <header className="px-7 py-6 border-b border-white/[0.05]">
        <Link href="/configuration" className="text-xs text-white/40 hover:text-white/70">← Configuration Hub</Link>
        <div className="flex items-start justify-between gap-4 mt-2">
          <div>
            <h1 className="text-2xl font-black text-white/90">📺 KDS devices</h1>
            <p className="text-sm text-white/40 mt-1 max-w-2xl">
              Physical screens registered to display kitchen tickets. Bind a device to a station + concept so it only shows tickets it should.
            </p>
          </div>
          <button onClick={() => setAdding(true)} className="rounded-xl bg-primary px-4 py-2.5 text-sm font-black text-primary-on hover:opacity-90">+ Register device</button>
        </div>
      </header>

      <div className="px-7 py-6 max-w-4xl mx-auto space-y-2">
        {devices.length === 0 && (
          <div className="rounded-2xl p-10 text-center" style={{ background: 'rgb(var(--fg-rgb) / 0.02)', border: '1px solid rgb(var(--fg-rgb) / 0.05)' }}>
            <p className="font-bold text-white/85">No KDS devices registered</p>
            <p className="text-sm text-white/45 mt-1">Register each kitchen tablet/TV so you can monitor connectivity.</p>
          </div>
        )}
        {devices.map((d) => {
          const station = stations.find((s) => s.id === d.stationId)
          const concept = concepts.find((c) => c.id === d.conceptId)
          return (
            <div key={d.id} className="rounded-2xl p-5"
              style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="text-lg font-black text-white/90">{d.name}</h3>
                    {!d.isActive && <span className="text-[10px] font-bold text-white/30 px-1.5 py-0.5 rounded bg-white/5">PAUSED</span>}
                    {station && <span className="text-[10px] font-bold px-2 py-0.5 rounded-full" style={{ background: 'rgb(135 197 64 / 0.1)', color: 'var(--erp-primary-ink)' }}>{station.name}</span>}
                    {concept && <span className="text-[10px] font-bold px-2 py-0.5 rounded-full" style={{ background: 'rgb(61 31 59 / 0.12)', color: '#6b2f68' }}>{concept.name}</span>}
                  </div>
                  <p className="text-xs text-white/40 mt-1">
                    {d.lastSeenAt ? `Last seen ${new Date(d.lastSeenAt).toLocaleString()}` : 'Never connected'}
                  </p>
                  {d.notes && <p className="text-xs text-white/50 mt-1">{d.notes}</p>}
                </div>
                <div className="flex flex-col gap-2 shrink-0">
                  <button onClick={() => setEditing(d)} className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-white/55 hover:text-white">Edit</button>
                  <button onClick={() => { if (confirm(`Delete device "${d.name}"?`)) del.mutate(d.id) }} className="rounded-lg border border-red-500/20 text-red-700/70 px-3 py-1.5 text-xs">Delete</button>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {(adding || editing) && (
        <Modal device={editing} stations={stations} concepts={concepts}
          onClose={() => { setAdding(false); setEditing(null) }}
          onSaved={() => { setAdding(false); setEditing(null); void qc.invalidateQueries({ queryKey: ['kds-devices'] }) }} />
      )}
    </div>
  )
}

function Modal({ device, stations, concepts, onClose, onSaved }: { device: Device | null; stations: Station[]; concepts: Concept[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(device?.name ?? '')
  const [stationId, setStationId] = useState(device?.stationId ?? '')
  const [conceptId, setConceptId] = useState(device?.conceptId ?? '')
  const [notes, setNotes] = useState(device?.notes ?? '')
  const save = useMutation({
    mutationFn: () => {
      const payload = { name: name.trim(), stationId: stationId || null, conceptId: conceptId || null, notes: notes || null }
      if (device) return api.patch(`/setup/kds-devices/${device.id}`, payload)
      return api.post('/setup/kds-devices', payload)
    },
    onSuccess: () => onSaved(),
  })
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-secondary/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl overflow-hidden"
        style={{ background: 'var(--surface)', border: '1px solid rgb(var(--fg-rgb) / 0.08)' }}
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-white/[0.05] px-5 py-3">
          <h2 className="font-black text-white/90">{device ? 'Edit device' : 'Register device'}</h2>
          <button onClick={onClose} className="text-white/40 text-xl">✕</button>
        </div>
        <div className="p-5 space-y-3 max-h-[70vh] overflow-y-auto">
          <Field label="Device name *"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Grill Tablet" className={fieldCls} autoFocus /></Field>
          <Field label="Station">
            <select value={stationId} onChange={(e) => setStationId(e.target.value)} className={fieldCls}>
              <option value="">Any</option>
              {stations.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Field>
          <Field label="Concept">
            <select value={conceptId} onChange={(e) => setConceptId(e.target.value)} className={fieldCls}>
              <option value="">All brands</option>
              {concepts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <Field label="Notes"><textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={fieldCls} placeholder="Location, asset tag, etc" /></Field>
        </div>
        <div className="flex justify-between gap-3 border-t border-white/[0.05] p-4 bg-white/[0.01]">
          <button onClick={onClose} className="rounded-xl border border-white/10 px-4 py-2.5 text-sm text-white/55 hover:text-white">Cancel</button>
          <button onClick={() => save.mutate()} disabled={save.isPending || !name.trim()}
            className="rounded-xl bg-primary px-5 py-2.5 text-sm font-black text-primary-on hover:opacity-90 disabled:opacity-50">
            {save.isPending ? 'Saving…' : device ? 'Save' : 'Register'}
          </button>
        </div>
      </div>
    </div>
  )
}

const fieldCls = "w-full rounded-lg bg-white/[0.03] border border-white/[0.08] px-3 py-2 text-sm text-white/85 focus:border-primary focus:outline-none"
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <div><label className="text-xs text-white/55">{label}</label><div className="mt-1">{children}</div></div> }
