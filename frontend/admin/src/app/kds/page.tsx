'use client'
import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { ArrowLeft, ArrowRight, ChefHat, Check, ChevronDown, Maximize2, TriangleAlert } from 'lucide-react'
import { FulfilmentIcon } from '../../components/kds/FulfilmentIcon'
import { formatDistanceToNowStrict } from 'date-fns'
import { api } from '../../lib/api'
import { useLineActions, LineStateBadge, HoldButton, RecallStrip } from '../../components/kds/LineActions'
import { orderRef } from '../../lib/orderRef'
import { CompactEmptyState } from '../../components/ui/CompactEmptyState'

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
          <Link href="/w" className="min-h-11 text-sm text-kds-subtext hover:text-kds-text inline-flex items-center gap-1.5 mb-1 transition-colors">
            <ArrowLeft size={16} aria-hidden="true" /> Back to workspace
          </Link>
          <h1 className="text-2xl font-black text-kds-text">Kitchen view</h1>
          <p className="text-sm text-kds-subtext">
            Your assigned stations. Tap a station to see the live queue and bump tickets.
          </p>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        <UnroutedPanel />
        <BackInStockPanel />
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
              <ChefHat size={32} aria-hidden="true" className="mx-auto mb-2 text-kds-subtext" />
              <p className="text-base font-bold text-kds-text">Your stations are switched off</p>
              <p className="text-sm text-kds-subtext mt-1">
                The stations on your roster aren&apos;t active. Ask your manager to update them in <Link href="/workforce" className="text-kds-green underline">Workforce</Link>.
              </p>
            </div>
          ) : (
            <CompactEmptyState tone="dark" icon={<ChefHat size={28} aria-hidden="true" />} message="No active stations yet"
              detail={<>Open <Link href="/kds/config" className="text-kds-green underline">KDS Config</Link> to add stations, then assign cooks in <Link href="/workforce" className="text-kds-green underline">Workforce</Link>.</>} />
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
                    className="w-full min-h-11 flex items-center gap-3 px-4 py-3 hover:bg-kds-bg/40 transition-colors">
                    <span className="text-kds-subtext text-xs"
                      style={{ display: 'inline-block', transition: 'transform 120ms', transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}>
                      <ChevronDown size={16} aria-hidden="true" />
                    </span>
                    <span className="font-bold text-kds-text">{group.name}</span>
                    <span className="text-xs text-kds-subtext">
                      {group.stations.length} station{group.stations.length === 1 ? '' : 's'}
                    </span>
                    {totalLoad > 0 && (
                      <span className="ml-auto inline-flex items-center justify-center h-5 min-w-[1.25rem] rounded-full text-xs font-bold px-1.5 bg-kds-amber/20 text-kds-amber">
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
                              className="w-full min-h-11 text-left px-4 py-3 hover:bg-kds-bg/20 transition-colors">
                              <div className="flex items-center gap-3 flex-wrap">
                                <span className="text-kds-subtext text-xs"
                                  style={{ display: 'inline-block', transition: 'transform 120ms', transform: isOpen ? 'rotate(0deg)' : 'rotate(-90deg)' }}>
                                  <ChevronDown size={16} aria-hidden="true" />
                                </span>
                                <span className="font-medium text-kds-text">{s.name}</span>
                                <span className={`inline-flex items-center justify-center h-5 min-w-[1.25rem] rounded-full text-xs font-bold px-1.5 ${
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
                                  className="ml-auto min-h-11 rounded-lg border border-kds-border px-3 text-xs font-medium text-kds-subtext hover:border-kds-green hover:text-kds-green transition-colors inline-flex items-center gap-1.5">
                                  <Maximize2 size={14} aria-hidden="true" /> Full screen
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

interface FulfilmentMeta { short: string; text: string; badge: string; card: string }
// kds-* tokens only (green / amber / violet), never hex.
const FULFILMENT_META: Record<string, FulfilmentMeta> = {
  dine_in:  { short: 'PLATE',    text: 'text-kds-green',     badge: 'bg-kds-green/10 border-kds-green/30',         card: 'border-kds-green/35' },
  takeout:  { short: 'PACK',     text: 'text-kds-amber',     badge: 'bg-kds-amber/10 border-kds-amber/30',         card: 'border-kds-amber/35' },
  delivery: { short: 'PACK+LBL', text: 'text-source-manual', badge: 'bg-source-manual/10 border-source-manual/30', card: 'border-source-manual/35' },
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
    queryFn:  () => api.get<QueuePayload>(`/expo/station/${stationId}/queue?states=all`),
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
      qc.invalidateQueries({ queryKey: ['station-recent-bumped', stationId] })
      qc.invalidateQueries({ queryKey: ['kds-my-stations'] })
    },
  })
  const lineActions = useLineActions(stationId)

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
      <div className="border-t border-kds-border bg-black/20 px-4 py-6 text-center space-y-3">
        <div>
          <Check size={28} aria-hidden="true" className="mx-auto mb-1 text-kds-green" />
          <p className="text-sm font-bold text-kds-text">All clear</p>
          <p className="text-xs text-kds-subtext mt-0.5">New tickets appear here when expo fires them.</p>
        </div>
        <div className="text-left"><RecallStrip stationId={stationId} actions={lineActions} /></div>
      </div>
    )
  }

  return (
    <div className="border-t border-kds-border bg-black/20 p-4 space-y-3">
      {cooking.length > 0 && (
        <div className="flex gap-2.5 overflow-x-auto snap-x snap-mandatory pb-2 pt-2">
          {cooking.map((t) => {
            const isLegacy = '__legacy' in t
            const id = isLegacy ? t.itemId : (t as StepTicket).stepId
            const lineStatus = isLegacy ? t.status : 'preparing'
            const isHeld = lineStatus === 'held'
            const isRemake = lineStatus === 'recalled'
            const onBump = () => isLegacy
              ? (isRemake ? lineActions.bumpRemake.mutate(t.itemId) : bumpLegacy.mutate(t.itemId))
              : bumpStep.mutate((t as StepTicket).stepId)
            const pending = isLegacy
              ? (bumpLegacy.isPending && bumpLegacy.variables === t.itemId)
                || (lineActions.bumpRemake.isPending && lineActions.bumpRemake.variables === t.itemId)
              : bumpStep.isPending && bumpStep.variables === (t as StepTicket).stepId
            const elapsed = t.firedAt
              ? formatDistanceToNowStrict(new Date(t.firedAt), { addSuffix: false })
              : 'just now'
            const fm: FulfilmentMeta = FULFILMENT_META[t.order.fulfilmentType] ?? FALLBACK_META
            const instruction = !isLegacy ? (t as StepTicket).instruction : null
            return (
              <div key={id} className={`w-64 shrink-0 snap-start rounded-xl relative overflow-hidden border-2 bg-kds-card ${fm.card}`}>
                <div className="p-3">
                  <div className={`absolute -top-2 left-2 px-1.5 py-0.5 rounded text-xs font-black uppercase tracking-wider border bg-kds-card ${fm.badge} ${fm.text}`}>
                    <FulfilmentIcon type={t.order.fulfilmentType} size={11} /> {fm.short}
                    {t.order.tableLabel && <span className="ml-1 opacity-80">· {t.order.tableLabel}</span>}
                  </div>
                  <div className="flex items-center justify-between mt-1 mb-1.5 text-xs uppercase tracking-wider font-bold">
                    <span className="text-kds-subtext">{t.order.concept.name}</span>
                    <span className="text-kds-amber">{elapsed}</span>
                  </div>
                  <LineStateBadge status={lineStatus} small />
                  <p className={`text-sm font-black text-kds-text leading-tight ${isHeld ? 'opacity-60' : ''}`}>
                    {t.qty > 1 && <span className="text-kds-amber mr-1">{t.qty}×</span>}
                    {t.itemName}
                  </p>
                  {instruction && (
                    <p className="text-xs font-semibold mt-1 leading-snug text-kds-green">
                      <ArrowRight size={12} aria-hidden="true" className="inline-block align-[-1px] mr-0.5" />{instruction}
                    </p>
                  )}
                  {t.itemNotes && (
                    <p className="text-xs italic mt-1 text-kds-amber">
                      <TriangleAlert size={12} aria-hidden="true" className="inline-block align-[-1px] mr-1" />{t.itemNotes}
                    </p>
                  )}
                  <p className="text-xs text-kds-subtext mt-1">
                    {t.order.customerName ?? 'Walk-in'} · #{orderRef(t.order.id)}
                  </p>
                  {!isHeld && (
                    <button
                      onClick={onBump}
                      disabled={pending}
                      className="mt-2 w-full min-h-11 rounded-xl py-2 text-sm font-black transition-all disabled:opacity-40 bg-kds-green text-primary-on inline-flex items-center justify-center gap-1.5">
                      {pending ? 'Bumping…' : (<><Check size={16} aria-hidden="true" />{isRemake ? 'Bump remake' : 'Bump'}</>)}
                    </button>
                  )}
                  {isLegacy && (
                    <div className="mt-1.5"><HoldButton itemId={t.itemId} status={lineStatus} actions={lineActions} small /></div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {lineActions.error && (
        <p className="rounded-lg border border-kds-red/50 bg-kds-red/10 px-3 py-1.5 text-xs font-semibold text-kds-red">
          {lineActions.error}
        </p>
      )}
      <RecallStrip stationId={stationId} actions={lineActions} />

      {waiting.length > 0 && (
        <div>
          <p className="text-xs uppercase tracking-[0.2em] font-black text-kds-subtext mb-1.5">
            On deck ({waiting.length})
          </p>
          <div className="flex gap-2 overflow-x-auto snap-x pb-1">
            {waiting.map((t) => (
              <div key={t.stepId} className="w-44 shrink-0 snap-start rounded-lg px-2.5 py-1.5 opacity-60"
                style={{ background: 'rgba(255,255,255,0.02)', border: '1px dashed rgba(255,255,255,0.08)' }}>
                <p className="text-xs font-bold text-kds-text/70 leading-tight">
                  {t.qty > 1 && <span className="text-kds-subtext mr-1">{t.qty}×</span>}
                  {t.itemName}
                </p>
                <p className="text-xs text-kds-subtext italic mt-0.5">{t.instruction}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── UnroutedPanel ────────────────────────────────────────────────────────────
//
// Open tickets no station screen shows (BOH-03): a line with no station, or
// one routed to a station that has since been retired. Listed here with a
// Bump so the order can still reach expo's ready column; the routing itself
// is fixed in /menu. Hidden when there are none.

interface UnroutedLine {
  itemId: string
  itemName: string
  qty: number
  status: string
  retiredStation: string | null
  order: {
    id: string; customerName: string | null; tableLabel: string | null
    concept: { id: string; name: string; slug: string }
  }
}

function UnroutedPanel() {
  const qc = useQueryClient()
  const { data } = useQuery<{ items: UnroutedLine[] }>({
    queryKey: ['kds-unrouted'],
    queryFn:  () => api.get<{ items: UnroutedLine[] }>('/kds/unrouted'),
    refetchInterval: 10_000,
    staleTime: 5_000,
  })
  const bump = useMutation({
    mutationFn: async (line: UnroutedLine) => {
      // A held or recalled line is started again before it is bumped.
      if (line.status === 'held' || line.status === 'recalled') {
        await api.patch(`/order-items/${line.itemId}/status`, { status: 'preparing' })
      }
      return api.patch(`/order-items/${line.itemId}/status`, { status: 'bumped' })
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['kds-unrouted'] }),
  })
  const items = data?.items ?? []
  if (items.length === 0) return null
  return (
    <section className="rounded-xl border border-kds-red/50 bg-kds-red/10 p-4">
      <p className="text-sm font-black text-kds-red">
        {items.length} ticket{items.length === 1 ? '' : 's'} not on any station screen
      </p>
      <p className="text-xs text-kds-subtext mt-0.5 mb-3">
        Cook these from here and bump them, then fix the item&apos;s station in Menu.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
        {items.map((it) => (
          <div key={it.itemId} className="flex items-center gap-3 rounded-lg border border-kds-border bg-kds-card px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-bold text-kds-text truncate">
                {it.qty > 1 && <span className="text-kds-amber mr-1">{it.qty}×</span>}
                {it.itemName}
              </p>
              <p className="text-xs text-kds-subtext truncate">
                {it.order.concept.name} · {it.order.tableLabel ?? it.order.customerName ?? 'Walk-in'} · #{orderRef(it.order.id)}
              </p>
              <p className="text-xs text-kds-subtext/80">
                {it.retiredStation ? `Routed to retired station "${it.retiredStation}"` : 'No station set'}
              </p>
            </div>
            <button
              type="button"
              onClick={() => bump.mutate(it)}
              disabled={bump.isPending && bump.variables?.itemId === it.itemId}
              className="shrink-0 min-h-11 rounded-lg border border-kds-green/60 px-3 py-1.5 text-xs font-black text-kds-green hover:bg-kds-green/10 disabled:opacity-40">
              Bump
            </button>
          </div>
        ))}
      </div>
    </section>
  )
}

// ─── BackInStockPanel ─────────────────────────────────────────────────────────
//
// Dishes the stock switched off (auto-86) that can be cooked again now the
// delivery is in (BOH-15). Nothing turns them back on by itself — a chef may
// have 86'd one for another reason — so each gets a one-tap "Back on".
// Hidden when there are none.

interface BackInStock {
  menuItemId: string
  name: string
  conceptName: string
  eightySixedAt: string
}

function BackInStockPanel() {
  const qc = useQueryClient()
  const { data } = useQuery<{ items: BackInStock[] }>({
    queryKey: ['kds-back-in-stock'],
    queryFn:  () => api.get<{ items: BackInStock[] }>('/kds/auto-86/back-in-stock'),
    refetchInterval: 60_000,
    staleTime: 30_000,
  })
  const backOn = useMutation({
    mutationFn: (menuItemId: string) => api.patch(`/menu/items/${menuItemId}/availability`, { isAvailable: true }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['kds-back-in-stock'] }),
  })
  const items = data?.items ?? []
  if (items.length === 0) return null
  return (
    <section className="rounded-xl border border-kds-green/50 bg-kds-green/10 p-4">
      <p className="text-sm font-black text-kds-green">Back in stock — put back on the menu?</p>
      <p className="text-xs text-kds-subtext mt-0.5 mb-3">
        These ran out and were switched off automatically. Their ingredients are in stock again.
      </p>
      <div className="flex flex-wrap gap-2">
        {items.map((it) => (
          <div key={it.menuItemId} className="flex items-center gap-3 rounded-lg border border-kds-border bg-kds-card px-3 py-2">
            <div className="min-w-0">
              <p className="text-sm font-bold text-kds-text">{it.name}</p>
              <p className="text-xs text-kds-subtext">
                {it.conceptName} · off since {formatDistanceToNowStrict(new Date(it.eightySixedAt))} ago
              </p>
            </div>
            <button
              type="button"
              onClick={() => backOn.mutate(it.menuItemId)}
              disabled={backOn.isPending && backOn.variables === it.menuItemId}
              className="shrink-0 min-h-11 rounded-lg border border-kds-green/60 px-3 py-1.5 text-xs font-black text-kds-green hover:bg-kds-green/10 disabled:opacity-40">
              Back on
            </button>
          </div>
        ))}
      </div>
    </section>
  )
}
