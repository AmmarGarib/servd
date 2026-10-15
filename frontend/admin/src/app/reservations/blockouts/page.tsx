'use client'

// Closures + private events. Operator marks dates the restaurant won't accept
// public bookings, with a reason. Public availability search respects these
// (closure → no slots; reduced_capacity → fewer slots).

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import Link from 'next/link'
import { api, deleteWithUndo } from '../../../lib/api'
import { todayPktIso } from '../../../lib/money'
import { useBrandFilter } from '../../../store/brandFilter'
import { Select } from '@/components/ui/Select'
import { NumberField } from '@/components/ui/NumberField'
import { useConfirm } from '@/components/ui/ConfirmDialog'

interface Concept { id: string; name: string }
interface Blockout {
  id: string; conceptId: string; kind: 'closure' | 'private_event' | 'reduced_capacity' | 'custom'
  startTime: string; endTime: string; capacityCap: number | null; reason: string | null
}

export default function BlockoutsPage() {
  const qc = useQueryClient()
  const confirm = useConfirm()
  const [conceptId, setConceptId] = useState<string>(() => useBrandFilter.getState().brandId ?? '')
  const [showNew, setShowNew] = useState(false)

  const concepts = useQuery({ queryKey: ['concepts'], queryFn: () => api.get<Concept[]>('/concepts') })
  if (!conceptId && concepts.data && concepts.data.length > 0) setConceptId(concepts.data[0]!.id)

  const list = useQuery({
    queryKey: ['blockouts', conceptId],
    queryFn: () => api.get<Blockout[]>(`/reservations/blockouts?conceptId=${conceptId}`),
    enabled: !!conceptId,
  })

  const remove = useMutation({
    mutationFn: (id: string) => deleteWithUndo(`/reservations/blockouts/${id}`, { trashType: 'blockout', id, onRestored: () => void qc.invalidateQueries({ queryKey: ['blockouts', conceptId] }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['blockouts', conceptId] }),
  })

  const KIND_LABEL: Record<Blockout['kind'], { label: string; tone: string }> = {
    closure:          { label: 'Closed',          tone: 'bg-s-red text-[#fff]' },
    private_event:    { label: 'Private event',   tone: 'bg-secondary text-secondary-on' },
    reduced_capacity: { label: 'Reduced',         tone: 'bg-s-amber text-[#fff]' },
    custom:           { label: 'Custom',          tone: 'bg-s-elevated text-s-text' },
  }

  return (
    <div className="min-h-full bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-6 py-4 flex items-center justify-between flex-wrap gap-3">
        <div>
          <Link href="/reservations" className="text-xs text-s-muted hover:text-s-text">← Reservations</Link>
          <h1 className="text-xl font-bold text-s-text">Closures & blockouts</h1>
        </div>
        <div className="flex items-center gap-2">
          <Select value={conceptId} onChange={(e) => setConceptId(e.target.value)} className="bg-s-surface border border-s-border rounded px-2 py-1 text-sm">
            {concepts.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <button onClick={() => setShowNew(true)} className="s-btn-primary text-xs">+ New blockout</button>
        </div>
      </header>

      <div className="p-6 max-w-3xl mx-auto space-y-3">
        <div className="s-card overflow-hidden">
          <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-s-bg-soft text-xs text-s-muted">
              <tr>
                <th className="px-4 py-2 text-left">Period</th>
                <th className="px-4 py-2 text-left">Kind</th>
                <th className="px-4 py-2 text-left">Reason</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {list.data?.map((b) => (
                <tr key={b.id} className="border-t border-s-border">
                  <td className="px-4 py-2 text-xs">
                    <p className="text-s-text">{new Date(b.startTime).toLocaleString()}</p>
                    <p className="text-s-muted">→ {new Date(b.endTime).toLocaleString()}</p>
                  </td>
                  <td className="px-4 py-2">
                    <span className={`text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full ${KIND_LABEL[b.kind].tone}`}>
                      {KIND_LABEL[b.kind].label}
                    </span>
                    {b.capacityCap && <p className="text-[11px] text-s-muted mt-1">Cap: {b.capacityCap}</p>}
                  </td>
                  <td className="px-4 py-2 text-xs text-s-text">{b.reason ?? '—'}</td>
                  <td className="px-4 py-2 text-right">
                    <button onClick={async () => {
                      const ok = await confirm({ title: 'Delete this blockout?', body: 'Bookings will open up again for this period.', confirmLabel: 'Delete', danger: true })
                      if (ok) remove.mutate(b.id)
                    }} className="min-h-11 px-3 text-xs text-s-red hover:underline">Delete</button>
                  </td>
                </tr>
              ))}
              {list.data && list.data.length === 0 && (
                <tr><td colSpan={4} className="px-4 py-8 text-center text-xs text-s-muted">No blockouts. Brand is open as scheduled.</td></tr>
              )}
            </tbody>
          </table>
          </div>
        </div>
      </div>

      {showNew && conceptId && (
        <NewBlockoutModal conceptId={conceptId} onClose={() => setShowNew(false)} onCreated={() => {
          void qc.invalidateQueries({ queryKey: ['blockouts', conceptId] })
          setShowNew(false)
        }} />
      )}
    </div>
  )
}

function NewBlockoutModal({ conceptId, onClose, onCreated }: { conceptId: string; onClose: () => void; onCreated: () => void }) {
  const [kind, setKind] = useState<'closure' | 'private_event' | 'reduced_capacity' | 'custom'>('closure')
  const [startTime, setStartTime] = useState(`${todayPktIso()}T18:00`)
  const [endTime, setEndTime] = useState(`${todayPktIso()}T23:00`)
  const [capacityCap, setCapacityCap] = useState<number | null>(null)
  const [reason, setReason] = useState('')
  const [err, setErr] = useState<string | null>(null)

  const create = useMutation({
    mutationFn: () => api.post('/reservations/blockouts', {
      conceptId, kind,
      startTime: new Date(`${startTime}:00+05:00`).toISOString(),
      endTime:   new Date(`${endTime}:00+05:00`).toISOString(),
      capacityCap: kind === 'reduced_capacity' ? capacityCap : null,
      reason: reason.trim() || null,
    }),
    onSuccess: onCreated,
    onError: (e: { message?: string }) => setErr(e.message ?? 'Failed'),
  })

  return (
    <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 bg-secondary/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-s-surface rounded-2xl max-w-md w-full" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-s-border flex justify-between">
          <h2 className="text-lg font-bold">New blockout</h2>
          <button onClick={onClose} className="text-2xl leading-none text-s-muted">×</button>
        </div>
        <div className="p-5 space-y-3 text-sm">
          <label className="block">
            <span className="text-xs text-s-muted">Kind</span>
            <Select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} className="w-full mt-1 bg-s-surface border border-s-border rounded px-2 py-1.5">
              <option value="closure">Closure (no bookings)</option>
              <option value="private_event">Private event</option>
              <option value="reduced_capacity">Reduced capacity</option>
              <option value="custom">Custom note</option>
            </Select>
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="text-xs text-s-muted">Start</span>
              <input type="datetime-local" value={startTime} onChange={(e) => setStartTime(e.target.value)} className="w-full mt-1 bg-s-surface border border-s-border rounded px-2 py-1.5" />
            </label>
            <label className="block">
              <span className="text-xs text-s-muted">End</span>
              <input type="datetime-local" value={endTime} onChange={(e) => setEndTime(e.target.value)} className="w-full mt-1 bg-s-surface border border-s-border rounded px-2 py-1.5" />
            </label>
          </div>
          {kind === 'reduced_capacity' && (
            <label className="block">
              <span className="text-xs text-s-muted">Tables available</span>
              <NumberField min={1} value={capacityCap} onValueChange={setCapacityCap} className="w-full mt-1 bg-s-surface border border-s-border rounded px-2 py-1.5" />
            </label>
          )}
          <label className="block">
            <span className="text-xs text-s-muted">Reason / note (optional)</span>
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Eid closure, full buyout for company X" className="w-full mt-1 bg-s-surface border border-s-border rounded px-2 py-1.5" />
          </label>
          {err && <p className="text-xs text-s-red">{err}</p>}
        </div>
        <div className="px-5 py-3 border-t border-s-border flex justify-end gap-2">
          <button onClick={onClose} className="s-btn-secondary text-sm">Cancel</button>
          <button onClick={() => create.mutate()} disabled={create.isPending} className="s-btn-primary text-sm">
            {create.isPending ? 'Saving…' : 'Block these dates'}
          </button>
        </div>
      </div>
    </div>
  )
}
