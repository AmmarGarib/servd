'use client'

// Dispatch board — every active rider, their assigned orders, last GPS fix
// age, and a stale indicator. Polls every 8s.

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../lib/api'
import { fmtPkrShort } from '../../lib/money'

interface RiderRow {
  id: string; name: string; phone: string
  vehicleType: string; status: 'available' | 'busy' | 'offline'
  lastLat: number | null; lastLng: number | null; lastReportedAt: string | null
  lastFixAgeMs: number | null; stale: boolean
  orders: Array<{
    id: string; status: string; totalCents: number; customerName: string | null
    deliveryNotes: string | null; placedAt: string
    concept: { name: string; slug: string }
  }>
}

const STATUS_DOT: Record<RiderRow['status'], string> = {
  available: 'bg-s-teal',
  busy:      'bg-s-amber',
  offline:   'bg-gray-400',
}

function fmtAge(ms: number | null): string {
  if (ms == null) return 'never'
  if (ms < 60_000)    return `${Math.round(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
  return `${Math.round(ms / 3_600_000)}h`
}

export default function DispatchPage() {
  const qc = useQueryClient()

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['dispatch-board'],
    queryFn: () => api.get<RiderRow[]>('/dispatch/board'),
    refetchInterval: 8000,
  })

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: RiderRow['status'] }) =>
      api.post(`/dispatch/riders/${id}/status`, { status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['dispatch-board'] }),
  })

  const unassign = useMutation({
    mutationFn: (orderId: string) => api.post(`/dispatch/orders/${orderId}/unassign`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['dispatch-board'] }),
  })

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-6 py-4 flex items-center justify-between">
        <div>
          <p className="text-xs text-s-muted">Operations</p>
          <h1 className="text-xl font-bold text-s-text">Dispatch board</h1>
        </div>
        <div className="text-xs text-s-muted flex items-center gap-3">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-s-teal animate-pulse" />
            polling every 8s
          </span>
          <button onClick={() => refetch()} className="s-btn-secondary text-xs">Refresh</button>
        </div>
      </header>

      <div className="p-6 max-w-6xl space-y-3">
        {isLoading && <p className="text-s-muted text-sm">Loading…</p>}
        {data && data.length === 0 && (
          <div className="s-card p-12 text-center">
            <h3 className="text-lg font-semibold mb-2">No riders configured.</h3>
            <p className="text-s-muted text-sm">Add a rider via /riders to get started.</p>
          </div>
        )}
        {data?.map((r) => (
          <div key={r.id} className="s-card overflow-hidden">
            <div className="px-4 py-3 border-b border-s-border bg-s-bg-soft flex items-center justify-between flex-wrap gap-3">
              <div className="flex items-center gap-3">
                <span className={`h-3 w-3 rounded-full ${STATUS_DOT[r.status]}`} />
                <div>
                  <p className="text-sm font-bold">{r.name}</p>
                  <p className="text-[11px] text-s-muted">{r.phone} · {r.vehicleType}</p>
                </div>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`text-[11px] ${r.stale ? 'text-s-red' : 'text-s-muted'}`}>
                  fix: {fmtAge(r.lastFixAgeMs)}{r.stale && r.lastFixAgeMs != null ? ' (stale)' : ''}
                </span>
                {r.lastLat != null && r.lastLng != null && (
                  <a target="_blank" rel="noopener noreferrer"
                    href={`https://www.google.com/maps?q=${r.lastLat},${r.lastLng}`}
                    className="text-[11px] text-s-teal hover:underline">map ↗</a>
                )}
                <select
                  value={r.status}
                  onChange={(e) => setStatus.mutate({ id: r.id, status: e.target.value as RiderRow['status'] })}
                  className="text-xs bg-white border border-s-border rounded px-2 py-1"
                >
                  <option value="available">available</option>
                  <option value="busy">busy</option>
                  <option value="offline">offline</option>
                </select>
              </div>
            </div>

            <div className="p-3">
              {r.orders.length === 0 ? (
                <p className="text-xs text-s-muted text-center py-3">No active deliveries.</p>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {r.orders.map((o) => (
                    <div key={o.id} className="rounded-lg border border-s-border p-2 bg-s-bg-soft">
                      <div className="flex justify-between items-baseline mb-1">
                        <span className="text-xs font-mono text-s-muted">#{o.id.slice(0, 6)}</span>
                        <span className="text-[10px] uppercase tracking-wider font-bold text-s-muted">{o.status}</span>
                      </div>
                      <p className="text-sm font-semibold">{o.concept.name}</p>
                      <p className="text-[11px] text-s-muted">{o.customerName ?? 'Walk-in'} · {fmtPkrShort(o.totalCents)}</p>
                      {o.deliveryNotes && <p className="text-[11px] italic text-s-muted mt-1">{o.deliveryNotes}</p>}
                      <button onClick={() => unassign.mutate(o.id)} className="mt-2 text-[11px] text-s-red hover:underline">Unassign</button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
