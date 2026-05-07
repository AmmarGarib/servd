'use client'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../../lib/api'

interface Hook {
  id: string
  url: string
  events: string[]
  secret: string
  isActive: boolean
  lastSentAt: string | null
  lastStatus: string | null
  failureCount: number
  notes: string | null
}

const EVENTS = [
  'order.placed', 'order.confirmed', 'order.dispatched', 'order.delivered', 'order.refunded',
  'shift.opened', 'shift.closed', 'inventory.low_stock', 'reservation.confirmed', 'reservation.no_show',
  'payment.completed', 'payment.failed',
]

export default function WebhooksPage() {
  const qc = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [showSecret, setShowSecret] = useState<{ id: string; secret: string } | null>(null)
  const { data = [] } = useQuery<Hook[]>({ queryKey: ['webhooks'], queryFn: () => api.get('/setup/webhooks') })
  const del = useMutation({ mutationFn: (id: string) => api.delete(`/setup/webhooks/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['webhooks'] }) })
  const toggle = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) => api.patch(`/setup/webhooks/${id}`, { isActive }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['webhooks'] }),
  })

  return (
    <div className="min-h-screen" style={{ background: '#090a0e' }}>
      <header className="px-7 py-6 border-b border-white/[0.05]">
        <Link href="/configuration" className="text-xs text-white/40 hover:text-white/70">← Configuration Hub</Link>
        <div className="flex items-start justify-between gap-4 mt-2">
          <div>
            <h1 className="text-2xl font-black text-white/90">🪝 Outbound webhooks</h1>
            <p className="text-sm text-white/40 mt-1 max-w-2xl">
              Push events to your accountant's software, BI tool, or in-house Slack bot. We sign every payload with HMAC-SHA256.
            </p>
          </div>
          <button onClick={() => setAdding(true)} className="rounded-xl bg-kds-green px-4 py-2.5 text-sm font-black text-black hover:opacity-90">+ New webhook</button>
        </div>
      </header>

      <div className="px-7 py-6 max-w-4xl space-y-2">
        {data.length === 0 && (
          <div className="rounded-2xl p-10 text-center" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)' }}>
            <p className="font-bold text-white/85">No webhooks configured</p>
            <p className="text-sm text-white/45 mt-1">Subscribe an external system to platform events.</p>
          </div>
        )}
        {data.map((h) => (
          <div key={h.id} className="rounded-2xl p-5"
            style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}>
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <p className="font-mono text-sm text-white/85 truncate">{h.url}</p>
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {h.events.map((e) => (
                    <span key={e} className="text-[10px] font-bold px-2 py-0.5 rounded-full" style={{ background: 'rgba(0,212,177,0.1)', color: '#00D4B1' }}>{e}</span>
                  ))}
                </div>
                <p className="text-xs text-white/40 mt-2">
                  Secret: <code className="text-white/60">{h.secret}</code>
                  {h.lastSentAt && <span> · Last sent {new Date(h.lastSentAt).toLocaleString()} ({h.lastStatus})</span>}
                  {h.failureCount > 0 && <span className="text-red-400"> · {h.failureCount} failures</span>}
                </p>
              </div>
              <div className="flex flex-col gap-2 shrink-0">
                <button onClick={() => toggle.mutate({ id: h.id, isActive: !h.isActive })}
                  className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-white/55 hover:text-white">
                  {h.isActive ? 'Pause' : 'Resume'}
                </button>
                <button onClick={() => { if (confirm('Delete webhook?')) del.mutate(h.id) }} className="rounded-lg border border-red-500/20 text-red-400/70 px-3 py-1.5 text-xs">Delete</button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {adding && (
        <Modal onClose={() => setAdding(false)} onCreated={(secret, id) => {
          setAdding(false)
          setShowSecret({ id, secret })
          void qc.invalidateQueries({ queryKey: ['webhooks'] })
        }} />
      )}

      {showSecret && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={() => setShowSecret(null)}>
          <div className="w-full max-w-md rounded-2xl overflow-hidden" style={{ background: '#14161e', border: '1px solid rgba(245,158,11,0.4)' }} onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-white/[0.05]">
              <h2 className="font-black text-amber-400">⚠ Save this secret now</h2>
              <p className="text-xs text-white/55 mt-1">It won't be shown again.</p>
            </div>
            <div className="p-5">
              <code className="block bg-white/[0.04] rounded-lg p-3 text-xs font-mono break-all text-[#00D4B1]">{showSecret.secret}</code>
            </div>
            <div className="flex justify-end p-4 border-t border-white/[0.05]">
              <button onClick={() => setShowSecret(null)} className="rounded-xl bg-amber-400 px-4 py-2 text-xs font-black text-black">I've saved it</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Modal({ onClose, onCreated }: { onClose: () => void; onCreated: (secret: string, id: string) => void }) {
  const [url, setUrl] = useState('')
  const [events, setEvents] = useState<string[]>([])
  const [notes, setNotes] = useState('')
  const save = useMutation({
    mutationFn: () => api.post<Hook>('/setup/webhooks', { url, events, notes: notes || null }),
    onSuccess: (created) => onCreated(created.secret, created.id),
  })
  function toggle(e: string) { setEvents((p) => p.includes(e) ? p.filter((x) => x !== e) : [...p, e]) }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-2xl overflow-hidden" style={{ background: '#14161e', border: '1px solid rgba(255,255,255,0.08)' }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-white/[0.05] px-5 py-3">
          <h2 className="font-black text-white/90">New webhook</h2>
          <button onClick={onClose} className="text-white/40 text-xl">✕</button>
        </div>
        <div className="p-5 space-y-3 max-h-[70vh] overflow-y-auto">
          <div><label className="text-xs text-white/55">Endpoint URL *</label><input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://hooks.example.com/servd" className={fieldCls + ' mt-1'} autoFocus /></div>
          <div>
            <label className="text-xs text-white/55">Events *</label>
            <div className="grid grid-cols-2 gap-1.5 mt-2">
              {EVENTS.map((e) => (
                <button key={e} type="button" onClick={() => toggle(e)}
                  className="text-xs font-semibold px-2 py-1.5 rounded-lg text-left"
                  style={events.includes(e)
                    ? { background: 'rgba(0,212,177,0.1)', color: '#00D4B1', border: '1px solid rgba(0,212,177,0.35)' }
                    : { background: 'rgba(255,255,255,0.025)', color: 'rgba(255,255,255,0.55)', border: '1px solid rgba(255,255,255,0.05)' }}>
                  {e}
                </button>
              ))}
            </div>
          </div>
          <div><label className="text-xs text-white/55">Notes</label><input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Why this exists" className={fieldCls + ' mt-1'} /></div>
        </div>
        <div className="flex justify-between gap-3 border-t border-white/[0.05] p-4 bg-white/[0.01]">
          <button onClick={onClose} className="rounded-xl border border-white/10 px-4 py-2.5 text-sm text-white/55 hover:text-white">Cancel</button>
          <button onClick={() => save.mutate()} disabled={save.isPending || !url || events.length === 0}
            className="rounded-xl bg-kds-green px-5 py-2.5 text-sm font-black text-black hover:opacity-90 disabled:opacity-50">
            {save.isPending ? 'Creating…' : 'Create webhook'}
          </button>
        </div>
      </div>
    </div>
  )
}

const fieldCls = "w-full rounded-lg bg-white/[0.03] border border-white/[0.08] px-3 py-2 text-sm text-white/85 focus:border-kds-green focus:outline-none"
