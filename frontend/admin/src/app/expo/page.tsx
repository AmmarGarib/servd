'use client'
import { useState } from 'react'
import Link from 'next/link'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { formatDistanceToNowStrict } from 'date-fns'
import { api } from '../../lib/api'

/**
 * Expo — the pass-station's screen. Three columns:
 *
 *   1. Awaiting Fire (received) — confirm/reject. Each card shows
 *      fulfilmentType prominently so expo knows whether to expect a
 *      plate or a package coming out the other end.
 *   2. In Progress (preparing)  — live step counters (e.g. 3/5). Cards
 *      let expo glance the floor and know which orders are about to land.
 *   3. Ready                    — single big handoff button. Copy switches
 *      by fulfilmentType: "Serve to table", "Hand to rider", "Customer
 *      pickup".
 *
 * Per-station KDS screens (Grill, Fry, Pass) still drive the cook side;
 * Expo lives one level up.
 */

const FULFILMENT_META = {
  dine_in:  { label: 'Dine-in',  emoji: '🍽',  short: 'PLATE',   accent: '#22c55e', bg: 'rgba(34,197,94,0.10)' },
  takeout:  { label: 'Takeout',  emoji: '🥡', short: 'PACK',    accent: '#f59e0b', bg: 'rgba(245,158,11,0.10)' },
  delivery: { label: 'Delivery', emoji: '🛵', short: 'PACK+LBL',accent: '#ec4899', bg: 'rgba(236,72,153,0.10)' },
} as const
type FulfilmentType = keyof typeof FULFILMENT_META

const HANDOFF_LABEL: Record<FulfilmentType, string> = {
  dine_in:  '🍽 Serve to table',
  takeout:  '✓ Customer pickup',
  delivery: '🛵 Hand to rider',
}

// Quick-pick rejection reasons. Ordered by frequency — 86 (out of an
// ingredient) is by far the most common, followed by kitchen overload
// and customer-side flags. Operator can still type a custom reason.
const REJECT_REASONS = [
  '86 — out of ingredient',
  '86 — out of dish',
  'Kitchen at capacity',
  'Allergen risk',
  'Wrong concept',
  'Closed for service',
  'Customer cancelled',
  'Suspected bad order',
] as const

const SOURCE_BADGE: Record<string, { label: string; bg: string; fg: string }> = {
  servd:     { label: 'Storefront', bg: 'rgba(99,102,241,0.15)',  fg: '#A5B4FC' },
  foodpanda: { label: 'Foodpanda',  bg: 'rgba(236,72,153,0.18)',  fg: '#F9A8D4' },
  careem:    { label: 'Careem',     bg: 'rgba(34,197,94,0.15)',   fg: '#86EFAC' },
  pos:       { label: 'POS',        bg: 'rgba(245,158,11,0.15)',  fg: '#FCD34D' },
  cart:      { label: 'Cart',       bg: 'rgba(0,212,177,0.15)',   fg: '#5EEAD4' },
  manual:    { label: 'Manual',     bg: 'rgba(255,255,255,0.06)', fg: 'rgba(255,255,255,0.55)' },
}

interface ExpoOrder {
  id: string
  status: string
  source: string
  fulfilmentType: FulfilmentType
  placedAt: string
  customerName: string | null
  totalCents: number
  taxCents: number
  totalSteps: number
  doneSteps: number
  concept: { id: string; name: string; slug: string }
  customer: { id: string; name: string; phone: string | null } | null
  table:    { id: string; label: string } | null
  rider:    { id: string; name: string; phone: string | null } | null
  items: Array<{ id: string; name: string; quantity: number; notes: string | null; status: string }>
}

interface StationLoad {
  id: string
  name: string
  conceptSlug: string
  activeItems: number
}

interface ExpoQueue {
  awaitingFire: ExpoOrder[]
  inProgress:   ExpoOrder[]
  ready:        ExpoOrder[]
  stations:     StationLoad[]
}

function fmt(c: number) { return `PKR ${(c / 100).toFixed(0)}` }

export default function ExpoPage() {
  const qc = useQueryClient()
  const [rejecting, setRejecting] = useState<string | null>(null)
  const [rejectReason, setRejectReason] = useState('')

  const { data, isLoading } = useQuery<ExpoQueue>({
    queryKey: ['expo', 'queue'],
    queryFn:  () => api.get<ExpoQueue>('/expo/queue'),
    refetchInterval: 5_000,
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

  const handoff = useMutation({
    mutationFn: (orderId: string) => api.post(`/expo/orders/${orderId}/handoff`, {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['expo'] }),
  })

  const awaitingFire = data?.awaitingFire ?? []
  const inProgress   = data?.inProgress ?? []
  const ready        = data?.ready ?? []
  const stations     = data?.stations ?? []

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
              Confirm incoming → watch progress → hand off ready.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Stat label="Awaiting" count={awaitingFire.length} color="#FCD34D" />
            <Stat label="In progress" count={inProgress.length} color="#A5B4FC" />
            <Stat label="Ready" count={ready.length} color="#5EEAD4" />
          </div>
        </div>
      </header>

      <div className="px-6 py-5 grid grid-cols-1 xl:grid-cols-[1fr_1fr_1fr_280px] gap-4">

        {/* ── Awaiting Fire ───────────────────────────────────────────── */}
        <section className="space-y-3">
          <SectionHeader title="Awaiting Fire" count={awaitingFire.length} color="#FCD34D" />

          {isLoading && <div className="text-sm text-white/40">Loading…</div>}

          {!isLoading && awaitingFire.length === 0 && (
            <EmptyState emoji="✓" text="Queue clear" sub="New orders appear here for confirmation." />
          )}

          {awaitingFire.map((order) => {
            const fm = FULFILMENT_META[order.fulfilmentType]
            const src = SOURCE_BADGE[order.source] ?? SOURCE_BADGE.manual!
            const isRejecting = rejecting === order.id
            return (
              <article key={order.id} className="rounded-2xl p-4"
                style={{ background: 'rgba(255,255,255,0.025)', border: `1px solid ${fm.accent}30` }}>

                {/* Fulfilment banner — the loudest thing on the card */}
                <div className="flex items-center justify-between mb-3 -mt-1 -mx-1">
                  <span className="text-xs font-black uppercase tracking-[0.2em] px-3 py-1 rounded-md"
                    style={{ background: fm.bg, color: fm.accent }}>
                    {fm.emoji} {fm.label} · {fm.short}
                  </span>
                  <span className="text-[10px] text-white/35">
                    {formatDistanceToNowStrict(new Date(order.placedAt), { addSuffix: true })}
                  </span>
                </div>

                {/* Source + table + customer */}
                <div className="flex items-center gap-2 mb-2 flex-wrap">
                  <span className="text-[10px] font-black uppercase tracking-wider px-2 py-0.5 rounded-md"
                    style={{ background: src.bg, color: src.fg }}>
                    {src.label}
                  </span>
                  <span className="text-xs text-white/45">{order.concept.name}</span>
                  {order.table && (
                    <span className="text-[10px] font-bold rounded-md px-2 py-0.5"
                      style={{ background: 'rgba(34,197,94,0.12)', color: '#86EFAC' }}>
                      🪑 {order.table.label}
                    </span>
                  )}
                  <span className="text-[10px] text-white/30 font-mono ml-auto">#{order.id.slice(-6).toUpperCase()}</span>
                </div>

                <div className="flex items-baseline gap-3 mb-2">
                  <p className="font-bold text-white/90">{order.customer?.name ?? order.customerName ?? 'Walk-in'}</p>
                  {order.customer?.phone && <p className="text-[11px] text-white/40">{order.customer.phone}</p>}
                  <p className="ml-auto text-sm font-black" style={{ color: '#00D4B1' }}>{fmt(order.totalCents)}</p>
                </div>

                <div className="space-y-1 mb-4">
                  {order.items.map((it) => (
                    <div key={it.id} className="flex items-baseline gap-2 text-[13px]">
                      <span className="font-bold text-white/55 tabular-nums w-6">{it.quantity}×</span>
                      <span className="text-white/85 flex-1">{it.name}</span>
                      {it.notes && <span className="text-[11px] text-amber-300/80 italic">{it.notes}</span>}
                    </div>
                  ))}
                </div>

                {!isRejecting ? (
                  <div className="flex gap-2">
                    <button onClick={() => setRejecting(order.id)} disabled={reject.isPending}
                      className="rounded-xl px-3 py-2.5 text-xs font-bold transition-colors disabled:opacity-40"
                      style={{ background: 'rgba(255,77,79,0.08)', color: '#FF7B7D', border: '1px solid rgba(255,77,79,0.18)' }}>
                      Reject
                    </button>
                    <button onClick={() => fire.mutate(order.id)} disabled={fire.isPending}
                      className="flex-1 rounded-xl py-2.5 text-sm font-black transition-all disabled:opacity-40"
                      style={{ background: 'linear-gradient(135deg, #00D4B1 0%, #6366F1 100%)', color: '#000' }}>
                      {fire.isPending && fire.variables === order.id ? 'Firing…' : 'Fire 🔥'}
                    </button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {/* Quick-reason chips — most rejects on the pass fall into
                        a handful of buckets. Tap a chip → the reason fills in,
                        edit before confirming if needed. Saves the expo from
                        typing "86 sea bass" 12 times a service. */}
                    <div className="flex flex-wrap gap-1.5">
                      {REJECT_REASONS.map((preset) => (
                        <button
                          key={preset}
                          type="button"
                          onClick={() => setRejectReason(preset)}
                          className="text-[11px] font-bold rounded-full px-2.5 py-1 transition-colors"
                          style={rejectReason === preset
                            ? { background: 'rgba(255,77,79,0.22)', color: '#FF8A8C', border: '1px solid rgba(255,77,79,0.5)' }
                            : { background: 'rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.6)', border: '1px solid rgba(255,255,255,0.08)' }}>
                          {preset}
                        </button>
                      ))}
                    </div>
                    <input value={rejectReason} onChange={(e) => setRejectReason(e.target.value)}
                      placeholder="…or type a custom reason"
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
              </article>
            )
          })}
        </section>

        {/* ── In Progress ─────────────────────────────────────────────── */}
        <section className="space-y-3">
          <SectionHeader title="In Progress" count={inProgress.length} color="#A5B4FC" />

          {!isLoading && inProgress.length === 0 && (
            <EmptyState emoji="…" text="Nothing cooking" sub="Fired orders appear here with live step counts." />
          )}

          {inProgress.map((order) => {
            const fm = FULFILMENT_META[order.fulfilmentType]
            const pct = order.totalSteps > 0 ? Math.round((order.doneSteps / order.totalSteps) * 100) : 0
            return (
              <article key={order.id} className="rounded-2xl p-3.5"
                style={{ background: 'rgba(255,255,255,0.02)', border: `1px solid ${fm.accent}25` }}>
                <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
                  <span className="text-[10px] font-black uppercase tracking-wider px-2 py-0.5 rounded-md"
                    style={{ background: fm.bg, color: fm.accent }}>
                    {fm.emoji} {fm.short}
                  </span>
                  {order.table && (
                    <span className="text-[10px] font-bold" style={{ color: '#86EFAC' }}>🪑 {order.table.label}</span>
                  )}
                  <span className="text-[10px] text-white/40 ml-auto">
                    {formatDistanceToNowStrict(new Date(order.placedAt), { addSuffix: false })}
                  </span>
                </div>
                <p className="font-bold text-white/90 text-sm mb-1">
                  {order.customer?.name ?? order.customerName ?? 'Walk-in'} · {order.concept.name}
                </p>
                <p className="text-[11px] text-white/45 mb-2">
                  {order.items.length} item{order.items.length === 1 ? '' : 's'} · #{order.id.slice(-5).toUpperCase()}
                </p>

                {/* Step progress */}
                <div className="space-y-1.5">
                  <div className="flex items-baseline justify-between text-[10px] font-bold">
                    <span className="text-white/55">Steps</span>
                    <span className="tabular-nums" style={{ color: fm.accent }}>
                      {order.doneSteps} / {order.totalSteps}
                    </span>
                  </div>
                  <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'rgba(255,255,255,0.06)' }}>
                    <div className="h-full transition-all duration-500"
                      style={{ width: `${pct}%`, background: fm.accent }} />
                  </div>
                </div>
              </article>
            )
          })}
        </section>

        {/* ── Ready ────────────────────────────────────────────────────── */}
        <section className="space-y-3">
          <SectionHeader title="Ready" count={ready.length} color="#5EEAD4" />

          {!isLoading && ready.length === 0 && (
            <EmptyState emoji="—" text="Nothing ready yet" sub="Completed cooks land here for handoff." />
          )}

          {ready.map((order) => {
            const fm = FULFILMENT_META[order.fulfilmentType]
            return (
              <article key={order.id} className="rounded-2xl p-4"
                style={{ background: `${fm.bg}`, border: `2px solid ${fm.accent}` }}>
                {/* Loud fulfilment banner — cook + expo + server all see this */}
                <div className="flex items-center justify-between mb-3">
                  <span className="text-sm font-black uppercase tracking-[0.18em]" style={{ color: fm.accent }}>
                    {fm.emoji} {fm.label}
                  </span>
                  <span className="text-[10px] text-white/40">#{order.id.slice(-5).toUpperCase()}</span>
                </div>

                <p className="font-bold text-white/95 text-base mb-1">
                  {order.customer?.name ?? order.customerName ?? 'Walk-in'}
                </p>
                <div className="text-[11px] text-white/55 mb-3 space-y-0.5">
                  <p>{order.concept.name} · {order.items.length} item{order.items.length === 1 ? '' : 's'}</p>
                  {order.fulfilmentType === 'dine_in' && order.table && (
                    <p style={{ color: '#86EFAC' }}>→ Table {order.table.label}</p>
                  )}
                  {order.fulfilmentType === 'delivery' && order.rider && (
                    <p style={{ color: '#F9A8D4' }}>→ {order.rider.name} ({order.rider.phone ?? 'no phone'})</p>
                  )}
                  {order.fulfilmentType === 'delivery' && !order.rider && (
                    <p style={{ color: '#FF7B7D' }}>⚠ no rider assigned yet</p>
                  )}
                </div>

                <button onClick={() => handoff.mutate(order.id)} disabled={handoff.isPending}
                  className="w-full rounded-xl py-3 text-sm font-black transition-all disabled:opacity-40"
                  style={{ background: fm.accent, color: '#0A0B0F' }}>
                  {handoff.isPending && handoff.variables === order.id ? 'Handing off…' : HANDOFF_LABEL[order.fulfilmentType]}
                </button>
              </article>
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
                      <span className="text-sm font-black tabular-nums" style={{ color: busy ? '#FCD34D' : 'rgba(255,255,255,0.3)' }}>
                        {s.activeItems}
                      </span>
                    </Link>
                  )
                })}
              </div>
            </div>
          ))}
        </aside>
      </div>
    </div>
  )
}

function Stat({ label, count, color }: { label: string; count: number; color: string }) {
  return (
    <div className="rounded-xl px-3 py-2 text-center min-w-[80px]"
      style={{ background: `${color}10`, border: `1px solid ${color}30` }}>
      <p className="text-[9px] uppercase tracking-wider font-black" style={{ color }}>{label}</p>
      <p className="text-xl font-black leading-none mt-0.5 tabular-nums" style={{ color }}>{count}</p>
    </div>
  )
}

function SectionHeader({ title, count, color }: { title: string; count: number; color: string }) {
  return (
    <div className="flex items-baseline justify-between">
      <h2 className="text-[10px] uppercase tracking-[0.2em] font-black" style={{ color }}>
        {title}
      </h2>
      <span className="text-[10px] font-black tabular-nums" style={{ color: `${color}AA` }}>{count}</span>
    </div>
  )
}

function EmptyState({ emoji, text, sub }: { emoji: string; text: string; sub: string }) {
  return (
    <div className="rounded-2xl p-8 text-center"
      style={{ background: 'rgba(255,255,255,0.015)', border: '1px dashed rgba(255,255,255,0.06)' }}>
      <p className="text-3xl mb-2 opacity-50">{emoji}</p>
      <p className="text-sm font-bold text-white/65">{text}</p>
      <p className="text-[11px] text-white/35 mt-1">{sub}</p>
    </div>
  )
}
