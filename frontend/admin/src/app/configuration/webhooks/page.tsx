'use client'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../../lib/api'

// Outbound webhooks — the ONE editor, over /webhooks/endpoints (company-
// scoped; https-only with a private-address block on create, edit and test).
// The /setup/webhooks copy this page used to call had no SSRF guard, no test
// ping, no delivery log and no URL editing, and was removed.

interface Hook {
  id: string
  url: string
  events: string[]
  isActive: boolean
  lastSentAt: string | null
  lastStatus: string | null
  failureCount: number
  notes: string | null
  createdAt: string
}

interface Delivery {
  id: string
  event: string
  responseCode: number | null
  status: string
  durationMs: number | null
  attemptedAt: string
  subscriptionId: string
}

// The events servd actually emits today (orders/service.ts → emitDomainEvent).
// Others are listed by the API but nothing sends them yet, so subscribing to
// one would wait for a call that never comes — they are shown, disabled.
const FIRING = new Set(['order.confirmed', 'order.dispatched', 'order.delivered', 'order.refunded'])

export default function WebhooksPage() {
  const qc = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<Hook | null>(null)
  const [logFor, setLogFor] = useState<string | null>(null)
  const [showSecret, setShowSecret] = useState<string | null>(null)
  const [pingResult, setPingResult] = useState<Record<string, string>>({})

  const { data = [] } = useQuery<Hook[]>({ queryKey: ['webhooks'], queryFn: () => api.get('/webhooks/endpoints') })
  const { data: events = { events: [] as string[] } } = useQuery<{ events: string[] }>({
    queryKey: ['webhook-events'], queryFn: () => api.get('/webhooks/events'),
  })
  const del = useMutation({
    mutationFn: (id: string) => api.delete(`/webhooks/endpoints/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['webhooks'] }),
  })
  const toggle = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) => api.patch(`/webhooks/endpoints/${id}`, { isActive }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['webhooks'] }),
  })
  const ping = useMutation({
    mutationFn: (id: string) => api.post<{ success: boolean; statusCode: number | null; responseMs: number; error?: string }>(`/webhooks/endpoints/${id}/test`, {}),
    onSuccess: (r, id) => {
      setPingResult((p) => ({
        ...p,
        [id]: r.success ? `✓ ${r.statusCode} in ${r.responseMs} ms` : `✗ ${r.statusCode ?? r.error ?? 'failed'} (${r.responseMs} ms)`,
      }))
      void qc.invalidateQueries({ queryKey: ['webhook-deliveries'] })
    },
    onError: (err, id) => setPingResult((p) => ({ ...p, [id]: `✗ ${(err as Error).message}` })),
  })

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <header className="px-7 py-6 border-b border-white/[0.05]">
        <Link href="/configuration" className="text-xs text-white/40 hover:text-white/70">← Configuration Hub</Link>
        <div className="flex items-start justify-between gap-4 mt-2">
          <div>
            <h1 className="text-2xl font-black text-white/90">🪝 Outbound webhooks</h1>
            <p className="text-sm text-white/40 mt-1 max-w-2xl">
              Push order events to your accountant's software, BI tool, or in-house Slack bot. Every payload is signed with
              HMAC-SHA256 (<code className="text-white/60">X-Servd-Signature</code>). Endpoints belong to the active company.
            </p>
          </div>
          <button onClick={() => setAdding(true)} className="rounded-xl bg-primary px-4 py-2.5 text-sm font-black text-primary-on hover:opacity-90">+ New webhook</button>
        </div>
      </header>

      <div className="px-7 py-6 max-w-4xl mx-auto space-y-2">
        {data.length === 0 && (
          <div className="rounded-2xl p-10 text-center" style={{ background: 'rgb(var(--fg-rgb) / 0.02)', border: '1px solid rgb(var(--fg-rgb) / 0.05)' }}>
            <p className="font-bold text-white/85">No webhooks configured</p>
            <p className="text-sm text-white/45 mt-1">Subscribe an external system to order events.</p>
          </div>
        )}
        {data.map((h) => (
          <div key={h.id} className="rounded-2xl p-5"
            style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <p className="font-mono text-sm text-white/85 truncate">{h.url}{!h.isActive && <span className="ml-2 text-[10px] text-amber-700">PAUSED</span>}</p>
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {h.events.map((e) => (
                    <span key={e} className="text-[10px] font-bold px-2 py-0.5 rounded-full"
                      style={FIRING.has(e)
                        ? { background: 'rgb(var(--erp-primary-rgb) / 0.1)', color: 'var(--erp-primary-ink)' }
                        : { background: 'rgba(245,158,11,0.08)', color: '#a15c00' }}
                      title={FIRING.has(e) ? undefined : 'servd does not send this event yet'}>
                      {e}{FIRING.has(e) ? '' : ' · not sent yet'}
                    </span>
                  ))}
                </div>
                <p className="text-xs text-white/40 mt-2">
                  {h.notes && <span>{h.notes} · </span>}
                  {h.lastSentAt ? <span>Last sent {new Date(h.lastSentAt).toLocaleString()} ({h.lastStatus})</span> : <span>Never sent</span>}
                  {h.failureCount > 0 && <span className="text-red-700"> · {h.failureCount} failures</span>}
                </p>
                {pingResult[h.id] && <p className="text-xs font-mono text-white/60 mt-1">Test ping: {pingResult[h.id]}</p>}
              </div>
              <div className="flex flex-col gap-2 shrink-0">
                <button onClick={() => ping.mutate(h.id)} disabled={ping.isPending}
                  className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-white/55 hover:text-white disabled:opacity-50">
                  Send test
                </button>
                <button onClick={() => setLogFor(logFor === h.id ? null : h.id)}
                  className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-white/55 hover:text-white">
                  {logFor === h.id ? 'Hide log' : 'Delivery log'}
                </button>
                <button onClick={() => setEditing(h)}
                  className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-white/55 hover:text-white">
                  Edit
                </button>
                <button onClick={() => toggle.mutate({ id: h.id, isActive: !h.isActive })}
                  className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-white/55 hover:text-white">
                  {h.isActive ? 'Pause' : 'Resume'}
                </button>
                <button onClick={() => { if (confirm('Delete webhook?')) del.mutate(h.id) }} className="rounded-lg border border-red-500/20 text-red-700/70 px-3 py-1.5 text-xs">Delete</button>
              </div>
            </div>
            {logFor === h.id && <DeliveryLog subscriptionId={h.id} />}
          </div>
        ))}
      </div>

      {(adding || editing) && (
        <EndpointModal
          existing={editing}
          allEvents={events.events}
          onClose={() => { setAdding(false); setEditing(null) }}
          onSaved={(secret) => {
            setAdding(false); setEditing(null)
            if (secret) setShowSecret(secret)
            void qc.invalidateQueries({ queryKey: ['webhooks'] })
          }}
        />
      )}

      {showSecret && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-secondary/40 p-4" onClick={() => setShowSecret(null)}>
          <div className="w-full max-w-md rounded-2xl overflow-hidden" style={{ background: 'var(--surface)', border: '1px solid rgba(245,158,11,0.4)' }} onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-white/[0.05]">
              <h2 className="font-black text-amber-700">⚠ Save this signing secret now</h2>
              <p className="text-xs text-white/55 mt-1">It won't be shown again.</p>
            </div>
            <div className="p-5">
              <code className="block bg-white/[0.04] rounded-lg p-3 text-xs font-mono break-all text-primary-ink">{showSecret}</code>
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

function DeliveryLog({ subscriptionId }: { subscriptionId: string }) {
  const { data = [], isLoading } = useQuery<Delivery[]>({
    queryKey: ['webhook-deliveries', subscriptionId],
    queryFn: () => api.get(`/webhooks/deliveries?subscriptionId=${subscriptionId}&limit=25`),
  })
  return (
    <div className="mt-4 border-t border-white/[0.05] pt-3">
      {isLoading ? <p className="text-xs text-white/40">Loading…</p> : data.length === 0 ? (
        <p className="text-xs text-white/40">No deliveries yet.</p>
      ) : (
        <table className="w-full text-xs">
          <tbody>
            {data.map((d) => (
              <tr key={d.id} className="border-b border-white/[0.04]">
                <td className="py-1.5 text-white/45 font-mono">{new Date(d.attemptedAt).toLocaleString()}</td>
                <td className="py-1.5 text-white/75">{d.event}</td>
                <td className={`py-1.5 font-mono ${d.status === 'success' ? 'text-primary-ink' : 'text-red-700'}`}>{d.status}{d.responseCode ? ` ${d.responseCode}` : ''}</td>
                <td className="py-1.5 text-white/40 font-mono text-right">{d.durationMs != null ? `${d.durationMs} ms` : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function EndpointModal({ existing, allEvents, onClose, onSaved }: {
  existing: Hook | null
  allEvents: string[]
  onClose: () => void
  onSaved: (secret: string | null) => void
}) {
  const [url, setUrl] = useState(existing?.url ?? '')
  const [events, setEvents] = useState<string[]>(existing?.events ?? [])
  const [notes, setNotes] = useState(existing?.notes ?? '')
  const [error, setError] = useState('')
  const save = useMutation({
    mutationFn: async () => {
      if (existing) {
        await api.patch(`/webhooks/endpoints/${existing.id}`, {
          ...(url !== existing.url ? { url } : {}),
          events, notes: notes || null,
        })
        return null
      }
      const created = await api.post<{ secret: string }>('/webhooks/endpoints', { url, events, notes: notes || null })
      return created.secret
    },
    onSuccess: (secret) => onSaved(secret),
    onError: (err) => setError((err as Error).message),
  })
  function toggle(e: string) { setEvents((p) => p.includes(e) ? p.filter((x) => x !== e) : [...p, e]) }
  const list = allEvents.length > 0 ? allEvents : Array.from(FIRING)
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-secondary/40 p-4" onClick={onClose}>
      <div className="w-full max-w-lg rounded-2xl overflow-hidden" style={{ background: 'var(--surface)', border: '1px solid rgb(var(--fg-rgb) / 0.08)' }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-white/[0.05] px-5 py-3">
          <h2 className="font-black text-white/90">{existing ? 'Edit webhook' : 'New webhook'}</h2>
          <button onClick={onClose} className="text-white/40 text-xl">✕</button>
        </div>
        <div className="p-5 space-y-3 max-h-[70vh] overflow-y-auto">
          <div>
            <label className="text-xs text-white/55">Endpoint URL * (https, public host)</label>
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://hooks.example.com/servd" className={fieldCls + ' mt-1'} autoFocus />
          </div>
          <div>
            <label className="text-xs text-white/55">Events *</label>
            <div className="grid grid-cols-2 gap-1.5 mt-2">
              {list.map((e) => {
                const live = FIRING.has(e)
                const on = events.includes(e)
                return (
                  <button key={e} type="button" onClick={() => toggle(e)} disabled={!live && !on}
                    title={live ? undefined : 'servd does not send this event yet'}
                    className="text-xs font-semibold px-2 py-1.5 rounded-lg text-left disabled:opacity-35 disabled:cursor-not-allowed"
                    style={on
                      ? { background: 'rgb(var(--erp-primary-rgb) / 0.1)', color: 'var(--erp-primary-ink)', border: '1px solid rgb(var(--erp-primary-rgb) / 0.35)' }
                      : { background: 'rgb(var(--fg-rgb) / 0.025)', color: 'rgb(var(--fg-rgb) / 0.55)', border: '1px solid rgb(var(--fg-rgb) / 0.05)' }}>
                    {e}{live ? '' : ' · not sent yet'}
                  </button>
                )
              })}
            </div>
          </div>
          <div><label className="text-xs text-white/55">Notes</label><input value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={200} placeholder="Why this exists" className={fieldCls + ' mt-1'} /></div>
          {error && <p className="text-xs text-red-700">{error}</p>}
        </div>
        <div className="flex justify-between gap-3 border-t border-white/[0.05] p-4 bg-white/[0.01]">
          <button onClick={onClose} className="rounded-xl border border-white/10 px-4 py-2.5 text-sm text-white/55 hover:text-white">Cancel</button>
          <button onClick={() => save.mutate()} disabled={save.isPending || !url || events.length === 0}
            className="rounded-xl bg-primary px-5 py-2.5 text-sm font-black text-primary-on hover:opacity-90 disabled:opacity-50">
            {save.isPending ? 'Saving…' : existing ? 'Save' : 'Create webhook'}
          </button>
        </div>
      </div>
    </div>
  )
}

const fieldCls = "w-full rounded-lg bg-white/[0.03] border border-white/[0.08] px-3 py-2 text-sm text-white/85 focus:border-primary focus:outline-none"
