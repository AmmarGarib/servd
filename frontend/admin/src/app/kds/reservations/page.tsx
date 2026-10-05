'use client'

// Kitchen reservation tracker.
//
// Live view of incoming bookings grouped by 15-minute arrival buckets so the
// line cooks see pacing at a glance: "we have 3 parties hitting at 7:30 = 12
// covers, one VIP, two have notes". Auto-refreshes every 30s; will eventually
// hook into the websocket `reservations.changed` channel for instant updates.
//
// Read-only. Status changes happen on /reservations (the host's day view).

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { useReservationSocket } from '../../../hooks/useReservationSocket'

interface Bucket {
  slot: string         // ISO timestamp at the floor of the quarter-hour
  slotLabel: string    // "19:30" PKT
  parties: number
  covers: number
  vip: number
  hasNotes: boolean
  rows: Array<{
    id: string
    partySize: number
    startTime: string
    guestName: string
    notes: string | null
    isVip: boolean
    status: 'booked' | 'confirmed' | 'seated'
    source: 'staff' | 'website' | 'phone' | 'walkin'
    table: { id: string; label: string } | null
    concept: { id: string; name: string }
  }>
}

interface TrackerResponse {
  now: string
  horizonH: number
  totalParties: number
  totalCovers: number
  buckets: Bucket[]
}

const HORIZON_OPTIONS = [2, 4, 6, 8] as const

export default function KitchenReservationTracker() {
  const [horizon, setHorizon] = useState<number>(4)

  const { data, isLoading, isError, refetch, dataUpdatedAt } = useQuery<TrackerResponse>({
    queryKey: ['kitchen-tracker', horizon],
    queryFn: () => api.get<TrackerResponse>(`/reservations/kitchen-tracker?hours=${horizon}`),
    refetchInterval: 30_000,
  })

  // Live-refresh on any reservation event. The 30s polling above is a fallback
  // for when the websocket dies; under normal conditions, new bookings flash
  // in immediately.
  useReservationSocket({ queryKeys: [['kitchen-tracker', horizon]] })

  return (
    <div className="flex h-screen flex-col bg-kds-bg text-kds-text">
      {/* ── Header ────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between border-b border-kds-border bg-kds-card px-6 py-3">
        <div className="flex items-center gap-4">
          <h1 className="text-xl font-bold tracking-wide">RESERVATIONS — Kitchen view</h1>
          <span className="text-xs text-kds-subtext">
            Next {horizon}h · {data?.totalParties ?? 0} parties · {data?.totalCovers ?? 0} covers
          </span>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex rounded border border-kds-border overflow-hidden">
            {HORIZON_OPTIONS.map((h) => (
              <button
                key={h}
                onClick={() => setHorizon(h)}
                className={`px-3 py-1 text-xs font-bold ${
                  h === horizon
                    ? 'bg-kds-green text-black'
                    : 'bg-kds-bg text-kds-subtext hover:text-kds-text'
                }`}>
                {h}h
              </button>
            ))}
          </div>
          <button
            onClick={() => refetch()}
            className="rounded border border-kds-border px-2 py-1 text-xs text-kds-subtext hover:text-kds-text">
            ↻ refresh
          </button>
          {dataUpdatedAt > 0 && (
            <span className="text-[10px] text-kds-subtext">
              updated {new Date(dataUpdatedAt).toLocaleTimeString('en-GB', { hour12: false })}
            </span>
          )}
        </div>
      </div>

      {/* ── Body ──────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto p-4">
        {isLoading && <Empty msg="Loading…" />}
        {isError && <Empty msg="Couldn't load tracker. Check API." err />}
        {data && data.buckets.length === 0 && (
          <Empty msg={`No reservations in the next ${horizon} hours. 🌿`} />
        )}
        <div className="flex flex-col gap-4">
          {data?.buckets.map((b) => <SlotCard key={b.slot} bucket={b} />)}
        </div>
      </div>
    </div>
  )
}

function SlotCard({ bucket }: { bucket: Bucket }) {
  // Visual weight scales with cover count so the kitchen sees big arrivals.
  const isHeavy = bucket.covers >= 8
  const isMedium = bucket.covers >= 4 && bucket.covers < 8

  return (
    <div className={`rounded-lg border ${
      isHeavy ? 'border-amber-500/60 bg-amber-500/5' :
      isMedium ? 'border-kds-border bg-kds-card' :
      'border-kds-border/60 bg-kds-bg'
    }`}>
      <div className="flex items-center justify-between border-b border-kds-border px-4 py-2">
        <div className="flex items-baseline gap-3">
          <span className={`text-2xl font-bold tabular-nums ${
            isHeavy ? 'text-amber-700' : 'text-kds-text'
          }`}>
            {bucket.slotLabel}
          </span>
          <span className="text-sm font-bold text-kds-text">
            {bucket.covers} cover{bucket.covers === 1 ? '' : 's'}
          </span>
          <span className="text-xs text-kds-subtext">
            {bucket.parties} part{bucket.parties === 1 ? 'y' : 'ies'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {bucket.vip > 0 && (
            <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-bold uppercase text-amber-700">
              ★ {bucket.vip} VIP
            </span>
          )}
          {bucket.hasNotes && (
            <span className="rounded-full bg-rose-500/20 px-2 py-0.5 text-[10px] font-bold uppercase text-rose-700">
              ⚑ notes
            </span>
          )}
        </div>
      </div>

      <ul className="divide-y divide-kds-border/40">
        {bucket.rows.map((r) => (
          <li key={r.id} className="flex items-start justify-between gap-3 px-4 py-2 text-sm">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-bold">{r.guestName}</span>
                <span className="text-kds-subtext">·</span>
                <span className="font-bold text-kds-green">×{r.partySize}</span>
                {r.isVip && (
                  <span className="rounded-full bg-amber-500/20 px-1.5 text-[10px] font-bold text-amber-700">★</span>
                )}
                <span className={`rounded-full px-1.5 text-[10px] font-bold uppercase ${
                  r.status === 'confirmed' ? 'bg-teal-500/20 text-teal-700' :
                  r.status === 'seated'    ? 'bg-indigo-500/20 text-indigo-700' :
                                             'bg-blue-500/20 text-blue-700'
                }`}>
                  {r.status}
                </span>
              </div>
              {r.notes && (
                <div className="mt-0.5 text-xs italic text-rose-700">⚑ {r.notes}</div>
              )}
              <div className="mt-0.5 text-[11px] text-kds-subtext">
                {r.concept.name}
                {r.table && <> · table {r.table.label}</>}
                {' · '}
                <span className="opacity-60">{r.source}</span>
              </div>
            </div>
            <div className="shrink-0 text-right">
              <div className="text-xs tabular-nums text-kds-subtext">
                {new Date(r.startTime).toLocaleTimeString('en-GB', {
                  timeZone: 'Asia/Karachi',
                  hour: '2-digit',
                  minute: '2-digit',
                  hour12: false,
                })}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

function Empty({ msg, err = false }: { msg: string; err?: boolean }) {
  return (
    <div className={`rounded-lg border border-dashed border-kds-border p-12 text-center text-sm ${
      err ? 'text-rose-700' : 'text-kds-subtext'
    }`}>
      {msg}
    </div>
  )
}
