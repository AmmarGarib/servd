'use client'

// Curbside / car-hopping queue. Two-column layout:
//   - LEFT: cars that have ARRIVED — staff runs food out
//   - RIGHT: cars en-route — order is placed but customer hasn't tapped "I'm here"
//
// Auto-refreshes every 15s; new arrivals also flash via the WebSocket.
// Hitting "Running it out" stamps curbsideRunnerOutAt and the row drops off.

import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { getSocket } from '../../../lib/socket'

interface CurbsideOrder {
  id: string; status: string; totalCents: number; placedAt: string
  customerName: string | null
  curbsideVehicle: string | null
  curbsidePlate: string | null
  curbsideSpot: string | null
  curbsideArrivedAt: string | null
  concept: { name: string; slug: string }
}

interface CurbsideResponse {
  arrived: CurbsideOrder[]
  enRoute: CurbsideOrder[]
}

export default function CurbsidePage() {
  const qc = useQueryClient()

  const { data, isLoading } = useQuery<CurbsideResponse>({
    queryKey: ['curbside-queue'],
    queryFn: () => api.get<CurbsideResponse>('/orders/curbside'),
    refetchInterval: 15_000,
  })

  // Live updates: a customer arriving fires `order:curbsideArrived`. Refetch.
  useEffect(() => {
    const sock = getSocket()
    const handler = () => qc.invalidateQueries({ queryKey: ['curbside-queue'] })
    sock.on('order:curbsideArrived', handler)
    sock.on('order:updated', handler)
    return () => {
      sock.off('order:curbsideArrived', handler)
      sock.off('order:updated', handler)
    }
  }, [qc])

  const runOut = useMutation({
    mutationFn: (id: string) => api.post(`/orders/${id}/curbside/running-out`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['curbside-queue'] }),
  })

  return (
    <div className="flex h-screen flex-col bg-s-bg text-s-text">
      <div className="flex items-center justify-between border-b border-s-border bg-s-surface px-6 py-3">
        <div className="flex items-center gap-4">
          <h1 className="text-xl font-bold tracking-wide">CURBSIDE / CAR-HOPPING</h1>
          <span className="text-xs text-s-muted">
            🚗 {data?.arrived.length ?? 0} here · {data?.enRoute.length ?? 0} en route
          </span>
        </div>
      </div>

      {isLoading && (
        <div className="flex-1 flex items-center justify-center text-s-muted text-sm">Loading…</div>
      )}

      {data && (
        <div className="flex-1 grid grid-cols-1 lg:grid-cols-2 gap-4 p-4 overflow-y-auto">
          {/* ── ARRIVED — needs runner ─────────────────────────────────── */}
          <Column title="🚨 Cars here" subtitle="Run the food out NOW" accent="amber">
            {data.arrived.length === 0 && (
              <Empty msg="No cars waiting. Quiet so far." />
            )}
            {data.arrived.map((o) => (
              <CurbsideCard key={o.id} o={o} kind="arrived"
                onRunOut={() => runOut.mutate(o.id)}
                disabled={runOut.isPending} />
            ))}
          </Column>

          {/* ── EN ROUTE — order placed, awaiting "I'm here" ─────────── */}
          <Column title="On the way" subtitle="Order placed, customer hasn't arrived yet" accent="muted">
            {data.enRoute.length === 0 && (
              <Empty msg="No incoming curbside orders." />
            )}
            {data.enRoute.map((o) => (
              <CurbsideCard key={o.id} o={o} kind="enRoute" />
            ))}
          </Column>
        </div>
      )}
    </div>
  )
}

function Column({ title, subtitle, accent, children }: {
  title: string; subtitle: string; accent: 'amber' | 'muted'; children: React.ReactNode
}) {
  const headerColor = accent === 'amber' ? 'text-amber-700' : 'text-s-muted'
  return (
    <div className="flex flex-col gap-3 min-h-0">
      <div className="px-2">
        <div className={`text-sm font-bold uppercase tracking-[0.2em] ${headerColor}`}>{title}</div>
        <div className="text-[11px] text-s-muted mt-0.5">{subtitle}</div>
      </div>
      <div className="flex-1 overflow-y-auto flex flex-col gap-2 pr-1">
        {children}
      </div>
    </div>
  )
}

function CurbsideCard({
  o, kind, onRunOut, disabled,
}: {
  o: CurbsideOrder
  kind: 'arrived' | 'enRoute'
  onRunOut?: () => void
  disabled?: boolean
}) {
  const waitMin = o.curbsideArrivedAt
    ? Math.floor((Date.now() - new Date(o.curbsideArrivedAt).getTime()) / 60000)
    : null
  const placedAgoMin = Math.floor((Date.now() - new Date(o.placedAt).getTime()) / 60000)

  // Wait time accents — under 2 min cool, 2-5 OK, 5+ urgent.
  const waitColor = waitMin == null ? '' :
    waitMin >= 5 ? 'bg-rose-500/15 border-rose-500/40' :
    waitMin >= 2 ? 'bg-amber-500/10 border-amber-500/30' :
                   'bg-s-surface border-s-border'

  return (
    <div className={`rounded-lg border p-3 ${kind === 'arrived' ? waitColor : 'bg-s-surface border-s-border/60'}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-base font-bold">{o.curbsideVehicle ?? 'No vehicle info'}</span>
            {o.curbsidePlate && <span className="text-xs font-mono text-s-muted">{o.curbsidePlate}</span>}
            {o.curbsideSpot && (
              <span className="text-[10px] font-bold uppercase px-1.5 rounded bg-indigo-500/20 text-indigo-700">
                Spot {o.curbsideSpot}
              </span>
            )}
          </div>
          <div className="text-[11px] text-s-muted mt-0.5">
            {o.concept.name} · {o.customerName ?? 'Guest'} · Rs. {(o.totalCents / 100).toFixed(0)}
          </div>
          {kind === 'arrived' && (
            <div className="mt-2 text-xs font-bold tabular-nums">
              <span className={waitMin != null && waitMin >= 5 ? 'text-rose-700' : waitMin != null && waitMin >= 2 ? 'text-amber-700' : 'text-emerald-700'}>
                ⏱ {waitMin}m waiting
              </span>
            </div>
          )}
          {kind === 'enRoute' && (
            <div className="mt-2 text-[11px] text-s-muted">
              Placed {placedAgoMin}m ago
            </div>
          )}
        </div>

        {kind === 'arrived' && onRunOut && (
          <button onClick={onRunOut} disabled={disabled}
            className="rounded-lg bg-primary hover:bg-primary-hover px-3 py-2 text-xs font-bold text-primary-on whitespace-nowrap disabled:opacity-50">
            ↗ Running it out
          </button>
        )}
      </div>
    </div>
  )
}

function Empty({ msg }: { msg: string }) {
  return (
    <div className="rounded-lg border border-dashed border-s-border p-8 text-center text-xs text-s-muted">
      {msg}
    </div>
  )
}
