'use client'
import { useState } from 'react'
import Link from 'next/link'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { formatDistanceToNowStrict } from 'date-fns'
import { api } from '../../lib/api'

/**
 * Expo — the pass-station's screen. Owns two responsibilities:
 *
 *   1. Confirm incoming orders. Every external order (storefront / Foodpanda
 *      / Careem) lands as `received`. Expo reviews → "Confirm & Fire" routes
 *      each item to its first recipe-step station; that's the moment line
 *      cooks actually see the ticket. The CEO explicitly does NOT want
 *      auto-accept — every order goes through the human gate.
 *
 *   2. Watch station load. A live count of items in flight at each station,
 *      so expo can see grill backing up before the floor manager notices.
 *
 * Per-station KDS screens (Grill, Fry, Cold-Line, Bar) read the same data
 * and filter to the items currently routed to them. The cook sees what they
 * need to do; the expo sees the whole picture.
 */

interface QueueOrder {
  id: string
  status: string
  source: string
  placedAt: string
  customerName: string | null
  totalCents: number
  taxCents: number
  concept: { id: string; name: string; slug: string }
  customer: { id: string; name: string; phone: string | null } | null
  items: Array<{ id: string; name: string; quantity: number; notes: string | null; status: string }>
}

interface StationLoad {
  id: string
  name: string
  conceptSlug: string
  activeItems: number
}

interface ExpoQueue {
  queue: QueueOrder[]
  stations: StationLoad[]
}

const SOURCE_BADGE: Record<string, { label: string; bg: string; fg: string }> = {
  servd:     { label: 'Storefront', bg: 'rgba(99,102,241,0.15)',  fg: '#A5B4FC' },
  foodpanda: { label: 'Foodpanda',  bg: 'rgba(236,72,153,0.18)',  fg: '#F9A8D4' },
  careem:    { label: 'Careem',     bg: 'rgba(34,197,94,0.15)',   fg: '#86EFAC' },
  pos:       { label: 'POS',        bg: 'rgba(245,158,11,0.15)',  fg: '#FCD34D' },
  cart:      { label: 'Cart',       bg: 'rgba(0,212,177,0.15)',   fg: '#5EEAD4' },
  manual:    { label: 'Manual',     bg: 'rgba(255,255,255,0.06)', fg: 'rgba(255,255,255,0.55)' },
}

function fmt(c: number) { return `PKR ${(c / 100).toFixed(0)}` }

export default function ExpoPage() {
  const qc = useQueryClient()
  const [rejecting, setRejecting] = useState<string | null>(null)
  const [rejectReason, setRejectReason] = useState('')

  const { data, isLoading } = useQuery<ExpoQueue>({
    queryKey: ['expo', 'queue'],
    queryFn:  () => api.get<ExpoQueue>('/expo/queue'),
    refetchInterval: 5_000,    // keep fresh during a rush
    staleTime: 2_000,
  })

  const fire = useMutation({
    mutationFn: (orderId: string) => api.post(`/expo/orders/${orderId}/fire`, {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['expo'] }),
  })

  const reject = useMutation({
    mutationFn: ({ orderId, reason }: { orderId: string; reason: string }) =>
      api.post(`/expo/orders/${orderId}/reject`, { reason }),
    onSuccess: () => {
      setRejecting(null); setRejectReason('')
      void qc.invalidateQueries({ queryKey: ['expo'] })
    },
  })

  const queue = data?.queue ?? []
  const stations = data?.stations ?? []

  // Group station load by concept slug so each kitchen reads as a column.
  const stationsByConcept = stations.reduce<Record<string, StationLoad[]>>((acc, s) => {
    (acc[s.conceptSlug] ??= []).push(s); return acc
  }, {})

  return (
    <div className="min-h-screen" style={{ background: '#0A0B0F' }}>
      <header className="px-6 py-4 border-b" style={{ borderColor: 'rgba(255,255,255,0.05)' }}>
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-black text-white/95">🪧 Expo Station</h1>
            <p className="text-xs text-white/45 mt-0.5">
              Confirm incoming orders. Watch station load. Bumps happen on the per-station KDS screens.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/kds/all" className="rounded-xl px-3 py-2 text-xs font-bold transition-colors"
              style={{ background: 'rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.65)', border: '1px solid rgba(255,255,255,0.08)' }}>
              All Stations →
            </Link>
            <div className="rounded-xl px-3 py-2 text-center"
              style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)' }}>
              <p className="text-[9px] uppercase tracking-wider font-black text-amber-400">Waiting</p>
              <p className="text-xl font-black text-amber-400 leading-none mt-0.5">{queue.length}</p>
            </div>
          </div>
        </div>
      </header>

      <div className="px-6 py-5 grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-5">

        {/* ── Queue: orders awaiting expo confirm ───────────────────────── */}
        <section className="space-y-3">
          <h2 className="text-[10px] uppercase tracking-[0.2em] font-black text-white/40">
            Awaiting confirm
          </h2>

          {isLoading && (
            <div className="text-sm text-white/40">Loading…</div>
          )}

          {!isLoading && queue.length === 0 && (
            <div className="rounded-2xl p-10 text-center"
              style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)' }}>
              <p className="text-4xl mb-2">✓</p>
              <p className="text-sm font-bold text-white/75">Queue clear</p>
              <p className="text-xs text-white/40 mt-1">New orders will appear here for confirmation.</p>
            </div>
          )}

          {queue.map((order) => {
            const src = SOURCE_BADGE[order.source] ?? SOURCE_BADGE.manual!
            const isRejecting = rejecting === order.id
            return (
              <div key={order.id} className="rounded-2xl p-4"
                style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)' }}>

                {/* Top row */}
                <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
                  <div className="flex items-center gap-2.5">
                    <span className="text-[10px] font-black uppercase tracking-wider px-2 py-1 rounded-md"
                      style={{ background: src.bg, color: src.fg }}>
                      {src.label}
                    </span>
                    <span className="text-xs text-white/45">{order.concept.name}</span>
                    <span className="text-xs text-white/30 font-mono">#{order.id.slice(-6).toUpperCase()}</span>
                  </div>
                  <div className="text-xs text-white/35">
                    {formatDistanceToNowStrict(new Date(order.placedAt), { addSuffix: true })}
                  </div>
                </div>

                {/* Customer */}
                <div className="flex items-baseline gap-3 mb-2">
                  <p className="font-bold text-white/90">{order.customer?.name ?? order.customerName ?? 'Walk-in'}</p>
                  {order.customer?.phone && <p className="text-[11px] text-white/40">{order.customer.phone}</p>}
                  <p className="ml-auto text-sm font-black" style={{ color: '#00D4B1' }}>{fmt(order.totalCents)}</p>
                </div>

                {/* Items */}
                <div className="space-y-1 mb-4">
                  {order.items.map((it) => (
                    <div key={it.id} className="flex items-baseline gap-2 text-[13px]">
                      <span className="font-bold text-white/55 tabular-nums w-6">{it.quantity}×</span>
                      <span className="text-white/85 flex-1">{it.name}</span>
                      {it.notes && <span className="text-[11px] text-amber-300/80 italic">{it.notes}</span>}
                    </div>
                  ))}
                </div>

                {/* Actions */}
                {!isRejecting ? (
                  <div className="flex gap-2">
                    <button onClick={() => setRejecting(order.id)}
                      disabled={reject.isPending}
                      className="rounded-xl px-3 py-2.5 text-xs font-bold transition-colors disabled:opacity-40"
                      style={{ background: 'rgba(255,77,79,0.08)', color: '#FF7B7D', border: '1px solid rgba(255,77,79,0.18)' }}>
                      Reject
                    </button>
                    <button onClick={() => fire.mutate(order.id)}
                      disabled={fire.isPending}
                      className="flex-1 rounded-xl py-2.5 text-sm font-black transition-all disabled:opacity-40"
                      style={{ background: 'linear-gradient(135deg, #00D4B1 0%, #6366F1 100%)', color: '#000' }}>
                      {fire.isPending && fire.variables === order.id ? 'Firing…' : 'Confirm & Fire 🔥'}
                    </button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <input value={rejectReason} onChange={(e) => setRejectReason(e.target.value)}
                      placeholder="Reason (out of stock, blacklist, etc.)"
                      autoFocus
                      className="w-full rounded-lg px-3 py-2 text-sm font-semibold focus:outline-none"
                      style={{ background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,77,79,0.2)', color: 'rgba(255,255,255,0.9)' }} />
                    <div className="flex gap-2">
                      <button onClick={() => { setRejecting(null); setRejectReason('') }}
                        className="rounded-lg px-3 py-2 text-xs font-bold transition-colors"
                        style={{ background: 'rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.6)' }}>
                        Cancel
                      </button>
                      <button onClick={() => reject.mutate({ orderId: order.id, reason: rejectReason })}
                        disabled={!rejectReason.trim() || reject.isPending}
                        className="flex-1 rounded-lg py-2 text-xs font-black transition-colors disabled:opacity-40"
                        style={{ background: '#FF4D4F', color: '#fff' }}>
                        Confirm reject
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </section>

        {/* ── Sidebar: station load ───────────────────────────────────── */}
        <aside>
          <h2 className="text-[10px] uppercase tracking-[0.2em] font-black text-white/40 mb-3">
            Station load
          </h2>
          {Object.entries(stationsByConcept).map(([slug, list]) => (
            <div key={slug} className="mb-5">
              <p className="text-[10px] uppercase tracking-wider font-black text-white/45 mb-2 capitalize">{slug}</p>
              <div className="space-y-1.5">
                {list.map((s) => {
                  const busy = s.activeItems > 0
                  return (
                    <Link key={s.id} href={`/kds/${s.id}`}
                      className="flex items-center gap-3 rounded-lg px-3 py-2 transition-colors"
                      style={{
                        background: busy ? 'rgba(245,158,11,0.06)' : 'rgba(255,255,255,0.02)',
                        border: `1px solid ${busy ? 'rgba(245,158,11,0.18)' : 'rgba(255,255,255,0.05)'}`,
                      }}>
                      <span className="text-xs font-bold flex-1" style={{ color: busy ? '#FCD34D' : 'rgba(255,255,255,0.75)' }}>
                        {s.name}
                      </span>
                      <span className="text-sm font-black tabular-nums"
                        style={{ color: busy ? '#FCD34D' : 'rgba(255,255,255,0.3)' }}>
                        {s.activeItems}
                      </span>
                    </Link>
                  )
                })}
              </div>
            </div>
          ))}

          {/* Par sheet stub — full daily-prep page lands in pass 2 */}
          <div className="rounded-xl p-4 mt-2"
            style={{ background: 'rgba(99,102,241,0.05)', border: '1px solid rgba(99,102,241,0.15)' }}>
            <p className="text-[10px] uppercase tracking-wider font-black text-indigo-300 mb-1">Par Sheet</p>
            <p className="text-xs text-white/55 leading-relaxed">
              Daily prep + component burn-down lives at <Link href="/inventory" className="text-indigo-300 underline">/inventory</Link> for now.
              Master par sheet with per-component actuals ships next pass.
            </p>
          </div>
        </aside>
      </div>
    </div>
  )
}
