'use client'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { formatDistanceToNowStrict } from 'date-fns'
import { api } from '../../../lib/api'
import { useKdsSocket } from '../../../hooks/useKdsSocket'
import { KdsHeader } from '../../../components/kds/KdsHeader'
import { NewOrderFlash } from '../../../components/kds/NewOrderFlash'

/**
 * Per-station KDS — only what THIS station needs to cook right now.
 *
 * Two data sources unioned by /expo/station/:id/queue:
 *
 *   1. Step-level tickets: items whose recipe has steps configured. Each
 *      card is one step (e.g. "Sear steak" on Grill, "Boil rice" on Rice).
 *      Bumping fires the cascade — downstream steps appear on their station
 *      automatically.
 *
 *   2. Legacy items: menu items that don't have recipe steps yet still flow
 *      through the old per-item routing. Bumping uses the existing item
 *      status endpoint. As recipes get their steps, items naturally migrate.
 */

type FulfilmentType = 'dine_in' | 'takeout' | 'delivery'

// Loud per-card badge so the line cook sees plate-vs-package at a glance.
const FULFILMENT_META: Record<FulfilmentType, { emoji: string; label: string; short: string; accent: string; bg: string }> = {
  dine_in:  { emoji: '🍽',  label: 'Dine-in',  short: 'PLATE',    accent: '#22c55e', bg: 'rgba(34,197,94,0.12)' },
  takeout:  { emoji: '🥡', label: 'Takeout',  short: 'PACK',     accent: '#f59e0b', bg: 'rgba(245,158,11,0.12)' },
  delivery: { emoji: '🛵', label: 'Delivery', short: 'PACK+LBL', accent: '#ec4899', bg: 'rgba(236,72,153,0.12)' },
}

interface StepTicket {
  stepId:    string
  itemId:    string
  itemName:  string
  qty:       number
  itemNotes: string | null
  status:    'preparing' | 'waiting'
  firedAt:   string | null
  instruction:      string
  phase:            string
  estimatedSeconds: number
  order: {
    id: string; customerName: string | null; source: string; placedAt: string
    fulfilmentType: FulfilmentType
    tableLabel: string | null
    concept: { name: string; slug: string }
  }
}

interface LegacyTicket {
  itemId:    string
  itemName:  string
  qty:       number
  itemNotes: string | null
  status:    string
  firedAt:   string | null
  order: {
    id: string; customerName: string | null; source: string; placedAt: string
    fulfilmentType: FulfilmentType
    tableLabel: string | null
    concept: { name: string; slug: string }
  }
}

interface QueuePayload {
  steps:  StepTicket[]
  legacy: LegacyTicket[]
}

export default function StationKdsPage() {
  const { station } = useParams<{ station: string }>()
  const qc = useQueryClient()
  // Subscribe to socket events for live cascade updates.
  useKdsSocket({ stationId: station, role: 'kitchen' })

  const { data, isLoading } = useQuery<QueuePayload>({
    queryKey: ['station-queue', station],
    queryFn:  () => api.get<QueuePayload>(`/expo/station/${station}/queue`),
    refetchInterval: 5_000,
    staleTime: 2_000,
  })

  const bumpStep = useMutation({
    mutationFn: (stepId: string) => api.post(`/expo/steps/${stepId}/bump`, {}),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['station-queue', station] }),
  })

  const bumpLegacy = useMutation({
    mutationFn: (itemId: string) => api.patch(`/order-items/${itemId}/status`, { status: 'bumped' }),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['station-queue', station] }),
  })

  const steps = data?.steps ?? []
  const legacy = data?.legacy ?? []
  const total = steps.filter((s) => s.status === 'preparing').length + legacy.length
  const waitingCount = steps.filter((s) => s.status === 'waiting').length

  // Split into "ready to cook" (preparing/legacy) and "on deck" (waiting on deps)
  const cooking: Array<StepTicket | { __legacy: true } & LegacyTicket> = [
    ...steps.filter((s) => s.status === 'preparing'),
    ...legacy.map((l) => ({ __legacy: true as const, ...l })),
  ]
  const waiting = steps.filter((s) => s.status === 'waiting')

  return (
    <div className="flex h-screen flex-col bg-kds-bg">
      <NewOrderFlash />
      <div className="shrink-0 px-4 pt-3 pb-1 flex items-center justify-between">
        <Link href="/expo" className="text-sm text-gray-500 hover:text-gray-300 flex items-center gap-1 transition-colors">
          ← Expo
        </Link>
        {waitingCount > 0 && (
          <span className="text-xs font-bold rounded-full px-2.5 py-1"
            style={{ background: 'rgba(99,102,241,0.12)', color: '#A5B4FC' }}>
            {waitingCount} on deck
          </span>
        )}
      </div>
      <KdsHeader title={`Station: ${station.slice(0, 8)}`} stationId={station} />

      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        {/* Cooking right now */}
        <section>
          <p className="text-[10px] uppercase tracking-[0.2em] font-black text-kds-subtext mb-3">
            Cooking now ({cooking.length})
          </p>

          {isLoading && <p className="text-sm text-kds-subtext">Loading…</p>}

          {!isLoading && cooking.length === 0 && (
            <div className="rounded-2xl p-12 text-center"
              style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)' }}>
              <p className="text-4xl mb-2">✓</p>
              <p className="text-base font-bold text-kds-text">All clear</p>
              <p className="text-xs text-kds-subtext mt-1">New tickets will appear here when expo fires.</p>
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-3">
            {cooking.map((t) => {
              const isLegacy = '__legacy' in t
              const id = isLegacy ? t.itemId : t.stepId
              const onBump = () => isLegacy ? bumpLegacy.mutate(t.itemId) : bumpStep.mutate(t.stepId)
              const pending = isLegacy
                ? bumpLegacy.isPending && bumpLegacy.variables === t.itemId
                : bumpStep.isPending && bumpStep.variables === t.stepId
              const elapsed = t.firedAt
                ? formatDistanceToNowStrict(new Date(t.firedAt), { addSuffix: false })
                : 'just now'
              const eta = !isLegacy ? (t as StepTicket).estimatedSeconds : 0
              const fm = FULFILMENT_META[t.order.fulfilmentType] ?? FULFILMENT_META.dine_in
              return (
                <div key={id} className="rounded-2xl p-4 relative"
                  style={{ background: '#1f2230', border: `2px solid ${fm.accent}55` }}>
                  {/* Loud fulfilment badge — the first thing the cook sees on
                      every card so they know whether to plate or package. */}
                  <div className="absolute -top-2 left-3 px-2 py-0.5 rounded-md text-[10px] font-black uppercase tracking-[0.15em]"
                    style={{ background: fm.bg, color: fm.accent, border: `1px solid ${fm.accent}50` }}>
                    {fm.emoji} {fm.short}
                    {t.order.tableLabel && <span className="ml-1 opacity-80">· {t.order.tableLabel}</span>}
                  </div>
                  {/* Top row */}
                  <div className="flex items-center justify-between mb-2 mt-1 text-[10px] uppercase tracking-wider font-bold">
                    <span className="text-kds-subtext">{t.order.concept.name} · {t.order.source}</span>
                    <span className="text-kds-amber">{elapsed}</span>
                  </div>
                  {/* Item */}
                  <p className="text-lg font-black text-kds-text leading-tight mb-1">
                    {t.qty > 1 && <span className="text-kds-amber mr-1">{t.qty}×</span>}
                    {t.itemName}
                  </p>
                  {/* Instruction (step-level only) */}
                  {!isLegacy && (
                    <p className="text-sm font-semibold mt-2 leading-snug" style={{ color: '#5EEAD4' }}>
                      → {(t as StepTicket).instruction}
                    </p>
                  )}
                  {t.itemNotes && (
                    <p className="text-xs italic mt-1.5" style={{ color: '#FCD34D' }}>
                      ⚠ {t.itemNotes}
                    </p>
                  )}
                  {/* Customer + order info */}
                  <p className="text-[11px] text-kds-subtext mt-2">
                    {t.order.customerName ?? 'Walk-in'} · #{t.order.id.slice(-5).toUpperCase()}
                  </p>
                  {/* ETA */}
                  {eta > 0 && (
                    <p className="text-[10px] text-kds-subtext mt-1">
                      Target: {Math.round(eta)}s
                    </p>
                  )}
                  {/* Bump */}
                  <button onClick={onBump} disabled={pending}
                    className="w-full mt-3 rounded-xl py-3 text-base font-black transition-all disabled:opacity-40"
                    style={{ background: 'linear-gradient(135deg, #00D4B1 0%, #6366F1 100%)', color: '#000' }}>
                    {pending ? 'Bumping…' : 'Bump ✓'}
                  </button>
                </div>
              )
            })}
          </div>
        </section>

        {/* Waiting (step deps not yet clear) */}
        {waiting.length > 0 && (
          <section>
            <p className="text-[10px] uppercase tracking-[0.2em] font-black text-kds-subtext mb-3">
              On deck — waiting on prior steps ({waiting.length})
            </p>
            <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-3">
              {waiting.map((t) => {
                const fm = FULFILMENT_META[t.order.fulfilmentType] ?? FULFILMENT_META.dine_in
                return (
                  <div key={t.stepId} className="rounded-2xl p-4 opacity-50"
                    style={{ background: 'rgba(255,255,255,0.02)', border: '1px dashed rgba(255,255,255,0.08)' }}>
                    <p className="text-[10px] uppercase tracking-wider font-bold mb-2"
                      style={{ color: fm.accent }}>
                      {fm.emoji} {fm.short} · {t.order.concept.name} · waiting
                    </p>
                    <p className="text-base font-bold text-kds-text/70 leading-tight">
                      {t.qty > 1 && <span className="text-kds-subtext mr-1">{t.qty}×</span>}
                      {t.itemName}
                    </p>
                    <p className="text-sm font-semibold mt-2 text-kds-subtext italic">
                      → {t.instruction}
                    </p>
                  </div>
                )
              })}
            </div>
          </section>
        )}

        {/* Footer total */}
        <p className="text-center text-xs text-kds-subtext pt-2">
          {total} active · auto-refreshes every 5s
        </p>
      </div>
    </div>
  )
}
