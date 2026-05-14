'use client'
import { useState, useCallback, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { formatDistanceToNowStrict } from 'date-fns'
import Link from 'next/link'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Concept {
  id: string
  name: string
  primaryColor: string | null
}

interface Station {
  id: string
  name: string
  displayOrder: number
  isActive: boolean
  conceptId: string
  liveLoad: number
}

interface QueueModifier {
  id: string
  name: string
  priceDeltaCents: number
}

interface QueueItem {
  id: string
  name: string
  orderId: string
  orderRef: string
  placedAt: string
  modifiers: QueueModifier[]
  firedAt: string | null
}

interface KdsMetrics {
  avgBumpSeconds: number | null
  firedToday: number
  pendingNow: number
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const sel =
  'rounded-lg border border-kds-border bg-kds-card px-3 py-2 text-sm text-kds-text focus:border-kds-green focus:outline-none'

function ageColor(placedAt: string): string {
  const mins = (Date.now() - new Date(placedAt).getTime()) / 60_000
  if (mins < 5) return 'text-kds-green'
  if (mins < 10) return 'text-kds-amber'
  return 'text-kds-red'
}

function fmtSeconds(s: number | null): string {
  if (s === null) return '—'
  const m = Math.floor(s / 60)
  const sec = Math.round(s % 60)
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`
}

// ─── Tab: Stations ────────────────────────────────────────────────────────────

function StationsTab() {
  const qc = useQueryClient()
  const [conceptId, setConceptId] = useState<string>('all')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')
  const [draftOrder, setDraftOrder] = useState<number>(0)
  // Which concept groups are expanded. Defaults to "all open" — operator
  // can collapse the ones they're not actively configuring.
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())

  const { data: concepts = [] } = useQuery({
    queryKey: ['concepts'],
    queryFn: () => api.get<Concept[]>('/concepts'),
  })

  const { data: stations = [], isLoading } = useQuery({
    queryKey: ['kds-stations', conceptId],
    queryFn: () =>
      api.get<Station[]>(
        conceptId === 'all' ? '/kds/stations' : `/kds/stations?conceptId=${conceptId}`,
      ),
  })

  // Group stations by concept so duplicate names (Prep on Bukhari, Prep on
  // Clifton, etc.) are visually disambiguated. Concepts with no stations
  // are omitted entirely.
  const groupedStations = useMemo(() => {
    const conceptName = new Map<string, string>()
    for (const c of concepts) conceptName.set(c.id, c.name)
    const groups = new Map<string, { name: string; stations: Station[] }>()
    for (const s of stations) {
      const key  = s.conceptId
      const name = conceptName.get(s.conceptId) ?? 'Unknown concept'
      const arr  = groups.get(key) ?? { name, stations: [] }
      arr.stations.push(s)
      groups.set(key, arr)
    }
    // Order each concept's stations by displayOrder then name.
    for (const g of groups.values()) {
      g.stations.sort((a, b) => a.displayOrder - b.displayOrder || a.name.localeCompare(b.name))
    }
    return Array.from(groups.entries()).map(([id, g]) => ({ id, ...g }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [stations, concepts])

  function toggleGroup(id: string) {
    setCollapsedGroups((cur) => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const patchStation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<Station> }) =>
      api.patch<Station>(`/stations/${id}`, body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['kds-stations'] }),
  })

  function startEdit(s: Station) {
    setEditingId(s.id)
    setDraftName(s.name)
    setDraftOrder(s.displayOrder)
  }

  function cancelEdit() {
    setEditingId(null)
  }

  function saveEdit(id: string) {
    patchStation.mutate({ id, body: { name: draftName, displayOrder: draftOrder } })
    setEditingId(null)
  }

  function toggleActive(s: Station) {
    patchStation.mutate({ id: s.id, body: { isActive: !s.isActive } })
  }

  return (
    <div className="space-y-4">
      {/* Concept filter */}
      <div className="flex items-center gap-3">
        <label className="text-sm text-kds-subtext">Concept</label>
        <select
          value={conceptId}
          onChange={(e) => setConceptId(e.target.value)}
          className={sel}
        >
          <option value="all">All concepts</option>
          {concepts.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      {/* Stations — grouped by concept as collapsible drop-downs. Each
          concept card shows the per-station rows when expanded. */}
      {isLoading ? (
        <p className="rounded-xl border border-kds-border bg-kds-card px-4 py-10 text-center text-sm text-kds-subtext">
          Loading stations…
        </p>
      ) : groupedStations.length === 0 ? (
        <p className="rounded-xl border border-kds-border bg-kds-card px-4 py-10 text-center text-sm text-kds-subtext">
          No stations found. Create stations in Brands &amp; Stations.
        </p>
      ) : (
        <div className="space-y-3">
          {groupedStations.map((group) => {
            const isCollapsed = collapsedGroups.has(group.id)
            const activeCount = group.stations.filter((s) => s.isActive).length
            const totalLoad   = group.stations.reduce((sum, s) => sum + s.liveLoad, 0)
            return (
              <div key={group.id} className="rounded-xl border border-kds-border bg-kds-card overflow-hidden">
                {/* Concept header — click to expand/collapse */}
                <button onClick={() => toggleGroup(group.id)}
                  className="w-full flex items-center gap-3 px-4 py-3 hover:bg-kds-bg/40 transition-colors">
                  <span className="text-kds-subtext text-xs"
                    style={{ display: 'inline-block', transition: 'transform 120ms', transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}>
                    ▼
                  </span>
                  <span className="font-bold text-kds-text">{group.name}</span>
                  <span className="text-xs text-kds-subtext">
                    {group.stations.length} station{group.stations.length === 1 ? '' : 's'} ·
                    <span className={activeCount === group.stations.length ? ' text-kds-green' : ' text-kds-amber'}>
                      {' '}{activeCount} active
                    </span>
                  </span>
                  {totalLoad > 0 && (
                    <span className="ml-auto inline-flex items-center justify-center h-5 min-w-[1.25rem] rounded-full text-[10px] font-bold px-1.5 bg-kds-amber/20 text-kds-amber">
                      {totalLoad}
                    </span>
                  )}
                </button>

                {/* Station rows — hidden when the concept is collapsed */}
                {!isCollapsed && (
                  <div className="border-t border-kds-border divide-y divide-kds-border/70">
                    {group.stations.map((s) => {
                      const isEditing = editingId === s.id
                      return (
                        <div key={s.id} className="px-4 py-3 hover:bg-kds-bg/20 transition-colors">
                          {isEditing ? (
                            /* Edit mode — inline form */
                            <div className="flex items-center gap-3 flex-wrap">
                              <input
                                value={draftName}
                                onChange={(e) => setDraftName(e.target.value)}
                                placeholder="Station name"
                                className="rounded border border-kds-green bg-kds-bg px-2 py-1 text-sm text-kds-text focus:outline-none w-44"
                                autoFocus
                              />
                              <label className="text-[11px] text-kds-subtext flex items-center gap-1.5">
                                Order
                                <input
                                  type="number"
                                  value={draftOrder}
                                  onChange={(e) => setDraftOrder(Number(e.target.value))}
                                  className="rounded border border-kds-green bg-kds-bg px-2 py-1 text-sm text-kds-text focus:outline-none w-16"
                                />
                              </label>
                              <div className="ml-auto flex items-center gap-2">
                                <button
                                  onClick={() => saveEdit(s.id)}
                                  disabled={patchStation.isPending || !draftName.trim()}
                                  className="rounded-lg bg-kds-green px-3 py-1 text-xs font-bold text-black hover:opacity-90 disabled:opacity-50">
                                  Save
                                </button>
                                <button
                                  onClick={cancelEdit}
                                  className="rounded-lg border border-kds-border px-3 py-1 text-xs font-medium text-kds-subtext hover:text-kds-text">
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : (
                            /* Read mode — compact row */
                            <div className="flex items-center gap-3 flex-wrap">
                              <span className="font-medium text-kds-text">{s.name}</span>
                              <span className="text-[11px] text-kds-subtext">order {s.displayOrder}</span>
                              <span className={`inline-flex items-center justify-center h-5 min-w-[1.25rem] rounded-full text-[10px] font-bold px-1.5 ${
                                s.liveLoad > 0 ? 'bg-kds-amber/20 text-kds-amber' : 'bg-kds-bg text-kds-subtext'
                              }`}>
                                load {s.liveLoad}
                              </span>
                              <button
                                onClick={() => toggleActive(s)}
                                disabled={patchStation.isPending}
                                title={s.isActive ? 'Deactivate' : 'Activate'}
                                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none disabled:opacity-50 ${
                                  s.isActive ? 'bg-kds-green' : 'bg-kds-border'
                                }`}>
                                <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${
                                  s.isActive ? 'translate-x-4' : 'translate-x-1'
                                }`} />
                              </button>
                              <div className="ml-auto flex items-center gap-2">
                                <Link
                                  href={`/kds/${s.id}`}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="rounded-lg bg-kds-green px-3 py-1 text-xs font-bold text-black hover:opacity-90 inline-flex items-center gap-1">
                                  ▶ Open KDS
                                </Link>
                                <button
                                  onClick={() => startEdit(s)}
                                  className="rounded-lg border border-kds-border px-3 py-1 text-xs font-medium text-kds-subtext hover:border-kds-green hover:text-kds-green transition-colors">
                                  Edit
                                </button>
                              </div>
                            </div>
                          )}
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
  )
}

// ─── Tab: Live Queue ──────────────────────────────────────────────────────────

function LiveQueueTab() {
  const qc = useQueryClient()
  const [stationId, setStationId] = useState<string>('')

  const { data: allStations = [] } = useQuery({
    queryKey: ['kds-stations', 'all'],
    queryFn: () => api.get<Station[]>('/kds/stations'),
  })

  // Default to first station once loaded
  const effectiveStation = stationId || allStations[0]?.id || ''

  const { data: queue = [], isFetching } = useQuery({
    queryKey: ['kds-queue', effectiveStation],
    queryFn: () => api.get<QueueItem[]>(`/kds/queue/${effectiveStation}`),
    enabled: !!effectiveStation,
    refetchInterval: 10_000,
  })

  const { data: metrics } = useQuery({
    queryKey: ['kds-metrics', effectiveStation],
    queryFn: () => api.get<KdsMetrics>(`/kds/metrics/${effectiveStation}`),
    enabled: !!effectiveStation,
    refetchInterval: 10_000,
  })

  const fireItem = useMutation({
    mutationFn: (itemId: string) => api.post<void>(`/kds/items/${itemId}/fire`, {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['kds-queue', effectiveStation] }),
  })

  const bumpItem = useMutation({
    mutationFn: (itemId: string) => api.post<void>(`/kds/items/${itemId}/bump`, {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['kds-queue', effectiveStation] }),
  })

  const recallItem = useMutation({
    mutationFn: (itemId: string) => api.post<void>(`/kds/items/${itemId}/recall`, {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['kds-queue', effectiveStation] }),
  })

  const stationName = allStations.find((s) => s.id === effectiveStation)?.name ?? 'Station'

  return (
    <div className="space-y-6">
      {/* Station selector */}
      <div className="flex items-center gap-3">
        <label className="text-sm text-kds-subtext">Station</label>
        <select
          value={effectiveStation}
          onChange={(e) => setStationId(e.target.value)}
          className={sel}
        >
          {allStations.length === 0 && (
            <option value="">No stations available</option>
          )}
          {allStations.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        {isFetching && (
          <span className="text-xs text-kds-subtext animate-pulse">Refreshing…</span>
        )}
        <span className="ml-auto text-xs text-kds-subtext">Auto-refreshes every 10s</span>
      </div>

      {/* Metrics strip */}
      {metrics && (
        <div className="grid grid-cols-3 gap-3">
          <MetricCard
            label="Avg bump time"
            value={fmtSeconds(metrics.avgBumpSeconds)}
          />
          <MetricCard
            label="Fired today"
            value={String(metrics.firedToday)}
            accent="text-kds-green"
          />
          <MetricCard
            label="Pending now"
            value={String(metrics.pendingNow)}
            accent={metrics.pendingNow > 5 ? 'text-kds-amber' : 'text-kds-text'}
          />
        </div>
      )}

      {/* Queue */}
      {!effectiveStation ? (
        <div className="rounded-xl border border-dashed border-kds-border py-16 text-center">
          <p className="text-kds-subtext">Select a station to view its queue</p>
        </div>
      ) : queue.length === 0 ? (
        <div className="rounded-xl border border-dashed border-kds-border py-16 text-center">
          <p className="text-2xl mb-2">✅</p>
          <p className="font-semibold text-kds-text">Queue clear</p>
          <p className="text-sm text-kds-subtext mt-1">
            {stationName} has nothing pending right now
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {queue.map((item) => (
            <QueueCard
              key={item.id}
              item={item}
              onFire={() => fireItem.mutate(item.id)}
              onBump={() => bumpItem.mutate(item.id)}
              onRecall={() => recallItem.mutate(item.id)}
              pending={
                fireItem.isPending || bumpItem.isPending || recallItem.isPending
              }
            />
          ))}
        </div>
      )}
    </div>
  )
}

function MetricCard({
  label,
  value,
  accent = 'text-kds-text',
}: {
  label: string
  value: string
  accent?: string
}) {
  return (
    <div className="rounded-xl border border-kds-border bg-kds-card p-4">
      <p className="text-xs text-kds-subtext mb-1">{label}</p>
      <p className={`text-2xl font-black ${accent}`}>{value}</p>
    </div>
  )
}

function QueueCard({
  item,
  onFire,
  onBump,
  onRecall,
  pending,
}: {
  item: QueueItem
  onFire: () => void
  onBump: () => void
  onRecall: () => void
  pending: boolean
}) {
  const age = ageColor(item.placedAt)
  const timeLabel = formatDistanceToNowStrict(new Date(item.placedAt))
  const orderRef = (item.orderRef ?? item.orderId).slice(0, 8).toUpperCase()

  return (
    <div className="rounded-xl border border-kds-border bg-kds-card p-4 flex flex-col gap-3">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <p className="font-semibold text-kds-text leading-snug flex-1">{item.name}</p>
        <span className="font-mono text-[11px] text-kds-subtext shrink-0">
          #{orderRef}
        </span>
      </div>

      {/* Modifiers */}
      {item.modifiers.length > 0 && (
        <ul className="space-y-0.5">
          {item.modifiers.map((m) => (
            <li key={m.id} className="text-xs text-kds-subtext">
              + {m.name}
            </li>
          ))}
        </ul>
      )}

      {/* Age */}
      <div className="flex items-center gap-1.5">
        <div
          className={`h-2 w-2 rounded-full ${
            age === 'text-kds-green'
              ? 'bg-kds-green'
              : age === 'text-kds-amber'
                ? 'bg-kds-amber'
                : 'bg-kds-red'
          }`}
        />
        <span className={`text-xs font-semibold ${age}`}>{timeLabel} ago</span>
      </div>

      {/* Actions */}
      <div className="flex gap-1.5 mt-auto">
        <button
          onClick={onFire}
          disabled={pending}
          className="flex-1 rounded-lg bg-kds-green/10 border border-kds-green/30 text-kds-green text-xs font-bold py-1.5 hover:bg-kds-green/20 disabled:opacity-50 transition-colors"
        >
          Fire
        </button>
        <button
          onClick={onBump}
          disabled={pending}
          className="flex-1 rounded-lg bg-kds-blue/10 border border-kds-blue/30 text-kds-blue text-xs font-bold py-1.5 hover:bg-kds-blue/20 disabled:opacity-50 transition-colors"
        >
          Bump
        </button>
        <button
          onClick={onRecall}
          disabled={pending}
          className="flex-1 rounded-lg bg-kds-subtext/10 border border-kds-border text-kds-subtext text-xs font-bold py-1.5 hover:bg-kds-card disabled:opacity-50 transition-colors"
        >
          Recall
        </button>
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

type Tab = 'stations' | 'queue'

export default function KdsConfigPage() {
  const [tab, setTab] = useState<Tab>('stations')

  return (
    <div className="h-screen flex flex-col bg-kds-bg overflow-hidden">
      <header className="border-b border-kds-border px-6 py-4 flex items-center justify-between gap-3 shrink-0">
        <div>
          <Link href="/expo" className="text-sm text-gray-500 hover:text-gray-300 flex items-center gap-1 mb-1 transition-colors">
            ← Back to Expo
          </Link>
          <h1 className="text-2xl font-black text-kds-text">KDS Config</h1>
          <p className="text-sm text-kds-subtext">Manage kitchen stations and monitor live queues</p>
        </div>
      </header>

      {/* Tabs */}
      <div className="flex gap-1 px-6 pt-4 border-b border-kds-border pb-0 shrink-0">
        {(['stations', 'queue'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium rounded-t-lg border-b-2 transition-colors ${
              tab === t
                ? 'border-kds-green text-kds-green bg-kds-card'
                : 'border-transparent text-kds-subtext hover:text-kds-text'
            }`}
          >
            {t === 'stations' ? 'Stations' : 'Live Queue'}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {tab === 'stations' && <StationsTab />}
        {tab === 'queue' && <LiveQueueTab />}
      </div>
    </div>
  )
}
