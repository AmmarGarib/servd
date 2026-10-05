'use client'
import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { formatDistanceToNowStrict } from 'date-fns'
import { api } from '../../lib/api'

/**
 * Kitchen dashboard — the line cook's home page.
 *
 * Different from /kds/config (the admin's station-management surface) and
 * different from /kds/<id> (the full-screen single-station view the cook
 * runs on the dedicated kitchen tablet). This page is for the cook who's
 * roaming with a tablet: it lists the stations they're assigned to as
 * collapsible cards. Tap a card → the live queue for that station expands
 * inline, ready to bump. No edit, no add-station, no toggle. That's all
 * upstream in /kds/config.
 *
 * Stations come from /kds/my-stations which scopes by User.stationIds.
 * Roles without an assignment list (admin/management/expediter) see every
 * active station so a head chef can still oversee the floor.
 */

interface MyStation {
  id: string
  conceptId: string
  name: string
  displayOrder: number
  isActive: boolean
  concept: { id: string; name: string; slug: string }
  liveLoad: number
}

// Endpoint returns the station list plus a flag telling us whether the
// caller's scope was *restricted* by their User.stationIds roster. The flag
// drives the empty-state copy: "ask your manager" only fires when the cook
// is genuinely unassigned, not when the tenant has zero active stations.
interface MyStationsResponse {
  restricted: boolean
  stations: MyStation[]
}

export default function KdsKitchenDashboard() {
  // Which station's queue is currently expanded. Only one open at a time so
  // the cook can focus — the same UX rule we use on the per-station view.
  const [openStationId, setOpenStationId] = useState<string | null>(null)
  // Concept groups can be collapsed when the kitchen runs many brands. Defaults
  // to all-open so a single-concept shop sees their stations immediately.
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())

  const { data, isLoading } = useQuery<MyStationsResponse>({
    queryKey: ['kds-my-stations'],
    queryFn:  () => api.get<MyStationsResponse>('/kds/my-stations'),
    refetchInterval: 10_000,    // load counters refresh while the page is open
    staleTime: 5_000,
  })
  const stations   = data?.stations ?? []
  const restricted = data?.restricted ?? false

  // Group by concept so the "Sandwich on Bukhari" vs "Sandwich on Clifton"
  // ambiguity is gone. Same shape as /kds/config so the visual language is
  // consistent.
  const grouped = useMemo(() => {
    const groups = new Map<string, { id: string; name: string; stations: MyStation[] }>()
    for (const s of stations) {
      const g = groups.get(s.conceptId) ?? { id: s.conceptId, name: s.concept.name, stations: [] }
      g.stations.push(s)
      groups.set(s.conceptId, g)
    }
    for (const g of groups.values()) {
      g.stations.sort((a, b) => a.displayOrder - b.displayOrder || a.name.localeCompare(b.name))
    }
    return Array.from(groups.values()).sort((a, b) => a.name.localeCompare(b.name))
  }, [stations])

  function toggleGroup(id: string) {
    setCollapsedGroups((cur) => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  return (
    <div className="erp-kitchen-dark h-screen flex flex-col bg-kds-bg overflow-hidden">
      <header className="border-b border-kds-border px-6 py-4 shrink-0">
        <div>
          <Link href="/w" className="text-sm text-gray-500 hover:text-gray-300 inline-flex items-center gap-1 mb-1 transition-colors">
            ← Back to workspace
          </Link>
          <h1 className="text-2xl font-black text-kds-text">Kitchen view</h1>
          <p className="text-sm text-kds-subtext">
            Your assigned stations. Tap a station to see the live queue and bump tickets.
          </p>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        {isLoading ? (
          <p className="rounded-xl border border-kds-border bg-kds-card px-4 py-10 text-center text-sm text-kds-subtext">
            Loading your stations…
          </p>
        ) : stations.length === 0 ? (
          // Empty-state copy diverges by who's looking. A line cook with an
          // empty roster (restricted = true) gets pointed at their manager;
          // an unrestricted role (admin/management/expediter) looking at a
          // tenant with zero active stations gets pointed at KDS Config to
          // create some.
          restricted ? (
            <div className="rounded-xl border border-kds-border bg-kds-card px-4 py-12 text-center">
              <p className="text-3xl mb-2">🍳</p>
              <p className="text-base font-bold text-kds-text">No stations assigned to you yet</p>
              <p className="text-sm text-kds-subtext mt-1">
                Ask your manager to add you in <Link href="/workforce" className="text-kds-green underline">Workforce</Link>.
              </p>
            </div>
          ) : (
            <div className="rounded-xl border border-kds-border bg-kds-card px-4 py-12 text-center">
              <p className="text-3xl mb-2">🍳</p>
              <p className="text-base font-bold text-kds-text">No active stations yet</p>
              <p className="text-sm text-kds-subtext mt-1">
                Open <Link href="/kds/config" className="text-kds-green underline">KDS Config</Link> to add stations,
                then assign cooks in <Link href="/workforce" className="text-kds-green underline">Workforce</Link>.
              </p>
            </div>
          )
        ) : (
          <div className="space-y-3">
            {grouped.map((group) => {
              const isCollapsed = collapsedGroups.has(group.id)
              const totalLoad = group.stations.reduce((sum, s) => sum + s.liveLoad, 0)
              return (
                <div key={group.id} className="rounded-xl border border-kds-border bg-kds-card overflow-hidden">
                  <button
                    onClick={() => toggleGroup(group.id)}
                    className="w-full flex items-center gap-3 px-4 py-3 hover:bg-kds-bg/40 transition-colors">
                    <span className="text-kds-subtext text-xs"
                      style={{ display: 'inline-block', transition: 'transform 120ms', transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}>
                      ▼
                    </span>
                    <span className="font-bold text-kds-text">{group.name}</span>
                    <span className="text-xs text-kds-subtext">
                      {group.stations.length} station{group.stations.length === 1 ? '' : 's'}
                    </span>
                    {totalLoad > 0 && (
                      <span className="ml-auto inline-flex items-center justify-center h-5 min-w-[1.25rem] rounded-full text-[10px] font-bold px-1.5 bg-kds-amber/20 text-kds-amber">
                        {totalLoad}
                      </span>
                    )}
                  </button>

                  {!isCollapsed && (
                    <div className="border-t border-kds-border divide-y divide-kds-border/70">
                      {group.stations.map((s) => {
                        const isOpen = openStationId === s.id
                        return (
                          <div key={s.id}>
                            <button
                              type="button"
                              onClick={() => setOpenStationId(isOpen ? null : s.id)}
                              className="w-full text-left px-4 py-3 hover:bg-kds-bg/20 transition-colors">
                              <div className="flex items-center gap-3 flex-wrap">
                                <span className="text-kds-subtext text-xs"
                                  style={{ display: 'inline-block', transition: 'transform 120ms', transform: isOpen ? 'rotate(0deg)' : 'rotate(-90deg)' }}>
                                  ▼
                                </span>
                                <span className="font-medium text-kds-text">{s.name}</span>
                                <span className={`inline-flex items-center justify-center h-5 min-w-[1.25rem] rounded-full text-[10px] font-bold px-1.5 ${
                                  s.liveLoad > 0 ? 'bg-kds-amber/20 text-kds-amber' : 'bg-kds-bg text-kds-subtext'
                                }`}>
                                  {s.liveLoad} ticket{s.liveLoad === 1 ? '' : 's'}
                                </span>
                                {/* "Open full screen" — same content, larger
                                    canvas. The dedicated kitchen iPad lives
                                    on this URL all shift. Stops propagation
                                    so it doesn't toggle the expand. */}
                                <Link
                                  href={`/kds/${s.id}`}
                                  onClick={(e) => e.stopPropagation()}
                                  className="ml-auto rounded-lg border border-kds-border px-3 py-1 text-xs font-medium text-kds-subtext hover:border-kds-green hover:text-kds-green transition-colors inline-flex items-center gap-1">
                                  ⤢ Full screen
                                </Link>
                              </div>
                            </button>

                            {isOpen && <StationLivePanel stationId={s.id} />}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── StationLivePanel ─────────────────────────────────────────────────────────
//
// Compact inline live queue for a single station. Same data as
// /kds/<id> (the full-screen iPad view) but stripped to the essentials:
// item name, quantity, fired-time, and a Bump button. No expanded
// instruction panel — if the cook needs the recipe they hit "Full screen"
// at the top of the row.
//
// Why duplicate this instead of reusing the per-station page component?
// Because that page owns its own layout/header/socket — embedding it
// would mean nested headers + double socket connections + scoped state
// fighting the outer scroll container. The bumping logic is small enough
// that a focused, embed-friendly version is the cleaner answer.

interface FulfilmentMeta { emoji: string; short: string; accent: string; bg: string }
const FULFILMENT_META: Record<string, FulfilmentMeta> = {
  dine_in:  { emoji: '🍽',  short: 'PLATE',    accent: '#22c55e', bg: 'rgba(34,197,94,0.12)' },
  takeout:  { emoji: '🥡', short: 'PACK',     accent: '#f59e0b', bg: 'rgba(245,158,11,0.12)' },
  delivery: { emoji: '🛵', short: 'PACK+LBL', accent: '#ec4899', bg: 'rgba(236,72,153,0.12)' },
}
// Strict fallback so TS doesn't widen the lookup to `FulfilmentMeta | undefined`
// — every fulfilment value we get from the API maps to one of the three above,
// but a future enum addition shouldn't crash the panel.
const FALLBACK_META: FulfilmentMeta = FULFILMENT_META.dine_in!

interface StepTicket {
  stepId:    string
  itemId:    string
  itemName:  string
  qty:       number
  itemNotes: string | null
  status:    'preparing' | 'waiting'
  firedAt:   string | null
  instruction: string
  order: {
    id: string; customerName: string | null; source: string; placedAt: string
    fulfilmentType: string
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
  order: StepTicket['order']
}
interface QueuePayload {
  steps:  StepTicket[]
  legacy: LegacyTicket[]
}

function StationLivePanel({ stationId }: { stationId: string }) {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery<QueuePayload>({
    queryKey: ['station-queue', stationId],
    queryFn:  () => api.get<QueuePayload>(`/expo/station/${stationId}/queue`),
    refetchInterval: 5_000,
    staleTime: 2_000,
  })

  const bumpStep = useMutation({
    mutationFn: (stepId: string) => api.post(`/expo/steps/${stepId}/bump`, {}),
    onSuccess:  () => {
      qc.invalidateQueries({ queryKey: ['station-queue', stationId] })
      qc.invalidateQueries({ queryKey: ['kds-my-stations'] })
    },
  })
  const bumpLegacy = useMutation({
    mutationFn: (itemId: string) => api.patch(`/order-items/${itemId}/status`, { status: 'bumped' }),
    onSuccess:  () => {
      qc.invalidateQueries({ queryKey: ['station-queue', stationId] })
      qc.invalidateQueries({ queryKey: ['kds-my-stations'] })
    },
  })

  const steps  = data?.steps ?? []
  const legacy = data?.legacy ?? []
  const cooking: Array<({ __legacy: true } & LegacyTicket) | StepTicket> = [
    ...steps.filter((s) => s.status === 'preparing'),
    ...legacy.map((l) => ({ __legacy: true as const, ...l })),
  ]
  const waiting = steps.filter((s) => s.status === 'waiting')

  if (isLoading) {
    return (
      <div className="border-t border-kds-border bg-black/20 p-4">
        <p className="text-xs text-kds-subtext animate-pulse">Loading queue…</p>
      </div>
    )
  }

  if (cooking.length === 0 && waiting.length === 0) {
    return (
      <div className="border-t border-kds-border bg-black/20 px-4 py-6 text-center">
        <p className="text-2xl mb-1">✓</p>
        <p className="text-sm font-bold text-kds-text">All clear</p>
        <p className="text-[11px] text-kds-subtext mt-0.5">New tickets appear here when expo fires them.</p>
      </div>
    )
  }

  return (
    <div className="border-t border-kds-border bg-black/20 p-4 space-y-3">
      {cooking.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2.5">
          {cooking.map((t) => {
            const isLegacy = '__legacy' in t
            const id = isLegacy ? t.itemId : (t as StepTicket).stepId
            const onBump = () => isLegacy
              ? bumpLegacy.mutate(t.itemId)
              : bumpStep.mutate((t as StepTicket).stepId)
            const pending = isLegacy
              ? bumpLegacy.isPending && bumpLegacy.variables === t.itemId
              : bumpStep.isPending && bumpStep.variables === (t as StepTicket).stepId
            const elapsed = t.firedAt
              ? formatDistanceToNowStrict(new Date(t.firedAt), { addSuffix: false })
              : 'just now'
            const fm: FulfilmentMeta = FULFILMENT_META[t.order.fulfilmentType] ?? FALLBACK_META
            const instruction = !isLegacy ? (t as StepTicket).instruction : null
            return (
              <div key={id} className="rounded-xl relative overflow-hidden"
                style={{ background: '#1f2230', border: `2px solid ${fm.accent}55` }}>
                <div className="p-3">
                  <div className="absolute -top-2 left-2 px-1.5 py-0.5 rounded text-[9px] font-black uppercase tracking-wider"
                    style={{ background: fm.bg, color: fm.accent, border: `1px solid ${fm.accent}50` }}>
                    {fm.emoji} {fm.short}
                    {t.order.tableLabel && <span className="ml-1 opacity-80">· {t.order.tableLabel}</span>}
                  </div>
                  <div className="flex items-center justify-between mt-1 mb-1.5 text-[9px] uppercase tracking-wider font-bold">
                    <span className="text-kds-subtext">{t.order.concept.name}</span>
                    <span className="text-kds-amber">{elapsed}</span>
                  </div>
                  <p className="text-sm font-black text-kds-text leading-tight">
                    {t.qty > 1 && <span className="text-kds-amber mr-1">{t.qty}×</span>}
                    {t.itemName}
                  </p>
                  {instruction && (
                    <p className="text-[12px] font-semibold mt-1 leading-snug" style={{ color: '#5EEAD4' }}>
                      → {instruction}
                    </p>
                  )}
                  {t.itemNotes && (
                    <p className="text-[11px] italic mt-1" style={{ color: '#FCD34D' }}>
                      ⚠ {t.itemNotes}
                    </p>
                  )}
                  <p className="text-[10px] text-kds-subtext mt-1">
                    {t.order.customerName ?? 'Walk-in'} · #{t.order.id.slice(-5).toUpperCase()}
                  </p>
                  <button
                    onClick={onBump}
                    disabled={pending}
                    className="mt-2 w-full rounded-lg py-1.5 text-xs font-black transition-all disabled:opacity-40"
                    style={{ background: 'linear-gradient(135deg, #00D4B1 0%, #6366F1 100%)', color: '#000' }}>
                    {pending ? 'Bumping…' : 'Bump ✓'}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {waiting.length > 0 && (
        <div>
          <p className="text-[9px] uppercase tracking-[0.2em] font-black text-kds-subtext mb-1.5">
            On deck ({waiting.length})
          </p>
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-2">
            {waiting.map((t) => (
              <div key={t.stepId} className="rounded-lg px-2.5 py-1.5 opacity-60"
                style={{ background: 'rgba(255,255,255,0.02)', border: '1px dashed rgba(255,255,255,0.08)' }}>
                <p className="text-[11px] font-bold text-kds-text/70 leading-tight">
                  {t.qty > 1 && <span className="text-kds-subtext mr-1">{t.qty}×</span>}
                  {t.itemName}
                </p>
                <p className="text-[9px] text-kds-subtext italic mt-0.5">→ {t.instruction}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
