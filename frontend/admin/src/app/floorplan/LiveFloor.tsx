'use client'

// Live floor plan — same canvas, polls /floors/status every 8s, color-codes
// each table by status, lets the host click a table to see who's seated /
// what's on the bill / when the next reservation arrives.

import { useQuery, useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { api } from '../../lib/api'
import { FloorCanvas } from '../../components/floorplan/FloorCanvas'
import type { FloorTable } from '../../components/floorplan/FloorCanvas'
import { fmtPkr } from '../../lib/money'
import { orderRef } from '../../lib/orderRef'

interface LiveTable extends FloorTable {
  status: string
  openOrders: Array<{ id: string; status: string; totalCents: number; placedAt: string; customerName: string | null }>
  reservations: Array<{ id: string; partySize: number; startTime: string; endTime: string; status: string; guestName: string; isVip: boolean }>
}

interface Floor {
  id: string
  width: number; height: number
  backgroundUrl: string | null
  name: string
}

const STATUS_COLORS: Record<string, { fill: string; stroke: string; text: string; label: string }> = {
  available:      { fill: 'rgba(34,197,94,0.16)',   stroke: 'rgba(22,163,74,0.55)',  text: 'var(--text)', label: 'Available' },
  reserved:       { fill: 'rgba(59,130,246,0.16)',  stroke: 'rgba(59,130,246,0.55)', text: 'var(--text)', label: 'Reserved'  },
  seated:         { fill: 'rgb(61 31 59 / 0.18)',  stroke: 'rgb(61 31 59 / 0.6)',  text: 'var(--text)', label: 'Seated'    },
  ordered:        { fill: 'rgba(245,158,11,0.18)',  stroke: 'rgba(245,158,11,0.7)',  text: 'var(--text)', label: 'Ordered'   },
  eating:         { fill: 'rgba(245,158,11,0.18)',  stroke: 'rgba(245,158,11,0.7)',  text: 'var(--text)', label: 'Eating'    },
  check:          { fill: 'rgba(217,119,6,0.22)',   stroke: 'rgba(217,119,6,0.8)',   text: 'var(--text)', label: 'Check'     },
  cleaning:       { fill: 'rgba(168,85,247,0.16)',  stroke: 'rgba(168,85,247,0.6)',  text: 'var(--text)', label: 'Cleaning'  },
  out_of_service: { fill: 'rgba(0,0,0,0.08)',       stroke: 'rgba(0,0,0,0.3)',       text: 'var(--text)', label: 'OOS'       },
}

function statusOf(t: LiveTable): string {
  if (t.openOrders.length > 0) {
    const top = t.openOrders[0]!.status
    if (top === 'ready') return 'check'
    if (top === 'preparing') return 'ordered'
    return 'seated'
  }
  if (t.reservations.some((r) => r.status === 'seated')) return 'seated'
  if (t.reservations.length > 0) return 'reserved'
  return t.status || 'available'
}

export function LiveFloor({ floor, conceptId }: { floor: Floor; conceptId: string }) {
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const { data, refetch } = useQuery({
    queryKey: ['floor-status', conceptId, floor.id],
    queryFn: () => api.get<LiveTable[]>(`/floors/status?conceptId=${conceptId}&floorId=${floor.id}`),
    refetchInterval: 8000,
  })

  const tables = (data ?? []).map((t) => ({ ...t, status: statusOf(t) }))
  const selected = tables.find((t) => t.id === selectedId)

  const counts: Record<string, number> = {}
  for (const t of tables) counts[t.status] = (counts[t.status] ?? 0) + 1

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4">
      <div>
        <FloorCanvas
          floor={floor}
          tables={tables}
          selectedId={selectedId}
          onTableClick={(t) => setSelectedId(t.id)}
          colorFor={(t) => STATUS_COLORS[(t as LiveTable).status] ?? STATUS_COLORS.available!}
          ariaLabel={`Live ${floor.name}`}
        />

        <div className="mt-3 flex items-center gap-3 flex-wrap text-xs">
          {Object.entries(STATUS_COLORS).map(([k, v]) => (
            <span key={k} className="inline-flex items-center gap-1.5 text-s-muted">
              <span className="w-3 h-3 rounded" style={{ background: v.fill, border: `1px solid ${v.stroke}` }} />
              {v.label} {counts[k] ? <span className="text-s-text font-bold">{counts[k]}</span> : null}
            </span>
          ))}
          <button onClick={() => refetch()} className="ml-auto s-btn-secondary text-xs">Refresh</button>
        </div>
      </div>

      <aside>
        {selected ? (
          <TableDetailPanel table={selected} onChanged={() => void refetch()} />
        ) : (
          <div className="s-card p-6 text-center text-sm text-s-muted">
            Click a table for details.<br />
            <span className="text-xs">Live updates every 8s.</span>
          </div>
        )}
      </aside>
    </div>
  )
}

// The statuses PATCH /tables/:id accepts — the manual toggle the old /tables
// page had (e.g. clearing a table back to available after it was bussed).
const SETTABLE_STATUSES = ['available', 'seated', 'ordered', 'eating', 'check', 'reserved'] as const

function TableDetailPanel({ table, onChanged }: { table: LiveTable; onChanged: () => void }) {
  const status = statusOf(table)
  const stat = STATUS_COLORS[status] ?? STATUS_COLORS.available!
  const setStatus = useMutation({
    mutationFn: (next: string) => api.patch(`/tables/${table.id}`, { status: next }),
    onSuccess: onChanged,
  })
  return (
    <div className="s-card overflow-hidden">
      <div className="px-4 py-3 border-b border-s-border" style={{ background: stat.fill }}>
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-bold">{table.label}</h2>
          <span className="text-xs font-bold uppercase tracking-wider">{stat.label}</span>
        </div>
        <p className="text-xs text-s-muted mt-0.5">{table.capacity} seats · {table.shape}</p>
      </div>

      <div className="p-4 space-y-3 text-sm">
        {table.openOrders.length > 0 && (
          <Section title="Active orders">
            {table.openOrders.map((o) => (
              <div key={o.id} className="flex justify-between text-xs py-1">
                <span>
                  <span className="font-mono text-s-muted">#{orderRef(o.id)}</span> · {o.customerName ?? 'Walk-in'}
                </span>
                <span>
                  <span className="text-s-muted mr-1">{o.status}</span>
                  <span className="font-bold">{fmtPkr(o.totalCents)}</span>
                </span>
              </div>
            ))}
          </Section>
        )}

        {table.reservations.length > 0 && (
          <Section title="Reservations (next 2h)">
            {table.reservations.map((r) => (
              <div key={r.id} className="flex justify-between text-xs py-1">
                <span>
                  {r.isVip && <span className="mr-1">⭐</span>}
                  <span>{r.guestName}</span>
                  <span className="text-s-muted"> · {r.partySize}p</span>
                </span>
                <span className="text-s-muted">
                  {new Date(r.startTime).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })}
                </span>
              </div>
            ))}
          </Section>
        )}

        {table.openOrders.length === 0 && table.reservations.length === 0 && (
          <p className="text-xs text-s-muted text-center py-4">Nothing booked, nothing ordering. Free.</p>
        )}

        <Section title="Set status">
          <div className="flex flex-wrap gap-1.5 pt-1">
            {SETTABLE_STATUSES.map((st) => (
              <button key={st} onClick={() => setStatus.mutate(st)} disabled={setStatus.isPending || table.status === st}
                className="rounded-full border border-s-border px-2.5 py-1 text-[11px] font-semibold capitalize disabled:opacity-40 hover:bg-s-bg-soft">
                {STATUS_COLORS[st]?.label ?? st}
              </button>
            ))}
          </div>
        </Section>
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[10px] font-bold uppercase tracking-wider text-s-muted mb-1.5">{title}</p>
      <div className="divide-y divide-s-border">{children}</div>
    </div>
  )
}
