'use client'

// Live orders dashboard. Manager-style aggregator across every concept —
// shows incoming, in-prep, and ready orders with timers, source channel, and
// quick status actions. Polls every 10s; switches to red when an order has
// been in-prep for too long.

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../lib/api'
import { fmtPkrShort } from '../../lib/money'
import Link from 'next/link'

interface OrderItem { id: string; name: string; quantity: number; status: string }
interface LiveOrder {
  id: string; status: string; source: string; placedAt: string
  totalCents: number; customerName: string | null
  concept: { name: string; slug: string }
  items: OrderItem[]
}

const STATUS_COLUMNS = [
  { key: 'received',   label: 'Incoming',  accent: '#3b82f6' },
  { key: 'preparing',  label: 'In Kitchen', accent: '#f59e0b' },
  { key: 'ready',      label: 'Ready',      accent: '#22c55e' },
] as const

const SOURCE_BADGE: Record<string, string> = {
  servd:     'servd',
  foodpanda: 'Foodpanda',
  pos:       'POS',
  manual:    'Manual',
  cart:      'Cart',
}

function ageMinutes(iso: string): number {
  return Math.floor((Date.now() - new Date(iso).getTime()) / 60_000)
}

function ageColor(min: number, status: string): string {
  if (status === 'preparing') {
    if (min < 8)  return 'var(--s-text)'
    if (min < 15) return 'var(--s-amber)'
    return 'var(--s-red)'
  }
  if (status === 'received') {
    if (min < 3) return 'var(--s-text)'
    if (min < 6) return 'var(--s-amber)'
    return 'var(--s-red)'
  }
  return 'var(--s-text)'
}

export default function LiveOrdersPage() {
  const qc = useQueryClient()
  const [filterConcept, setFilterConcept] = useState('')

  const { data, refetch } = useQuery({
    queryKey: ['live-orders', filterConcept],
    queryFn: () => api.get<{ data: LiveOrder[] }>(
      `/orders?status=received,confirmed,preparing,ready&limit=200${filterConcept ? `&conceptId=${filterConcept}` : ''}`,
    ),
    refetchInterval: 10_000,
  })

  const advance = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      api.patch(`/orders/${id}/status`, { status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['live-orders'] }),
  })

  const orders = (data?.data ?? []).filter((o) =>
    ['received', 'confirmed', 'preparing', 'ready'].includes(o.status),
  )

  const grouped = STATUS_COLUMNS.map((col) => ({
    ...col,
    orders: orders.filter((o) => (col.key === 'received' ? ['received', 'confirmed'].includes(o.status) : o.status === col.key)),
  }))

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-6 py-4 flex items-center justify-between">
        <div>
          <p className="text-xs text-s-muted">Operations</p>
          <h1 className="text-xl font-bold text-s-text">Live orders</h1>
        </div>
        <div className="flex items-center gap-3 text-xs text-s-muted">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-s-teal animate-pulse" />
            polling every 10s
          </span>
          <button onClick={() => refetch()} className="s-btn-secondary text-xs">Refresh now</button>
        </div>
      </header>

      <div className="p-4 sm:p-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {grouped.map((col) => (
            <section key={col.key} className="s-card overflow-hidden">
              <div className="px-4 py-3 border-b border-s-border flex items-center justify-between" style={{ background: `${col.accent}15` }}>
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full" style={{ background: col.accent }} />
                  <h2 className="text-sm font-bold text-s-text">{col.label}</h2>
                </div>
                <span className="text-xs font-bold text-s-muted bg-s-bg-soft rounded-full px-2 py-0.5">
                  {col.orders.length}
                </span>
              </div>

              <div className="p-3 space-y-2 min-h-[120px]">
                {col.orders.length === 0 && (
                  <p className="text-xs text-s-muted text-center py-6">No orders</p>
                )}
                {col.orders.map((o) => {
                  const min = ageMinutes(o.placedAt)
                  return (
                    <article key={o.id} className="rounded-lg border border-s-border p-3 bg-s-bg-soft">
                      <div className="flex items-baseline justify-between mb-1.5">
                        <span className="text-[10px] font-mono uppercase tracking-wider text-s-muted">
                          {SOURCE_BADGE[o.source] ?? o.source} · #{o.id.slice(0, 6)}
                        </span>
                        <span className="text-xs font-bold" style={{ color: ageColor(min, col.key === 'received' ? 'received' : col.key) }}>
                          {min}m
                        </span>
                      </div>
                      <h3 className="text-sm font-semibold text-s-text mb-0.5">{o.concept.name}</h3>
                      <p className="text-xs text-s-muted mb-2 truncate">
                        {o.customerName ?? 'Walk-in'} · {o.items.length} item{o.items.length === 1 ? '' : 's'} · {fmtPkrShort(o.totalCents)}
                      </p>
                      <details className="mb-2">
                        <summary className="text-xs text-s-muted cursor-pointer hover:text-s-text">items</summary>
                        <ul className="mt-1.5 space-y-0.5 text-xs text-s-text">
                          {o.items.map((i) => (
                            <li key={i.id} className="flex justify-between">
                              <span>{i.quantity}× {i.name}</span>
                              {i.status !== 'pending' && <span className="text-s-muted">{i.status}</span>}
                            </li>
                          ))}
                        </ul>
                      </details>
                      <div className="flex gap-1.5 flex-wrap">
                        {col.key === 'received' && o.status === 'received' && (
                          <button onClick={() => advance.mutate({ id: o.id, status: 'confirmed' })}
                            className="text-[11px] font-semibold px-2 py-1 rounded bg-blue-500 text-white">
                            Confirm
                          </button>
                        )}
                        {col.key === 'received' && (
                          <button onClick={() => advance.mutate({ id: o.id, status: 'preparing' })}
                            className="text-[11px] font-semibold px-2 py-1 rounded bg-amber-500 text-white">
                            Fire →
                          </button>
                        )}
                        {col.key === 'preparing' && (
                          <button onClick={() => advance.mutate({ id: o.id, status: 'ready' })}
                            className="text-[11px] font-semibold px-2 py-1 rounded bg-s-teal text-white">
                            Ready ✓
                          </button>
                        )}
                        {col.key === 'ready' && (
                          <button onClick={() => advance.mutate({ id: o.id, status: 'completed' })}
                            className="text-[11px] font-semibold px-2 py-1 rounded bg-black text-white">
                            Complete
                          </button>
                        )}
                        <Link href={`/orders/${o.id}`} className="text-[11px] text-s-muted hover:text-s-text px-2 py-1">
                          Open →
                        </Link>
                      </div>
                    </article>
                  )
                })}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
