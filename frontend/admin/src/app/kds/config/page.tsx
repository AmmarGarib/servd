'use client'
import { useState, useMemo } from 'react'
import { ArrowLeft, ChevronDown, Maximize2, Plus } from 'lucide-react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api, deleteWithUndo } from '../../../lib/api'
import Link from 'next/link'
import { Select } from '@/components/ui/Select'
import { CompactEmptyState } from '../../../components/ui/CompactEmptyState'
import { usePermissions } from '../../../hooks/useCan'
import { useAuthStore } from '../../../store/auth'

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
  /** Order cards the station screen shows at once, 4–6 (owner B12). */
  visibleCards?: number
}

/** A station add / change the F&B manager or the chef raised, waiting for the CEO (owner C3, 2026-10-26). */
interface StationRequest {
  id: string
  kind: 'create' | 'update'
  changes: { name?: string; displayOrder?: number; isActive?: boolean; conceptId?: string }
  requestedById: string
  requestedAt: string
  brandName: string | null
  moveToBrandName: string | null
  station: { name: string } | null
  requestedByName: string | null
}

function requestSummary(r: StationRequest): string {
  const c = r.changes
  if (r.kind === 'create') return `Add "${c.name ?? ''}" to ${r.brandName ?? 'the brand'}`
  const parts = [
    c.name !== undefined ? `rename to "${c.name}"` : null,
    c.displayOrder !== undefined ? `order ${c.displayOrder}` : null,
    c.isActive !== undefined ? (c.isActive ? 'switch on' : 'switch off') : null,
    c.conceptId !== undefined ? `move to ${r.moveToBrandName ?? 'another brand'}` : null,
  ].filter(Boolean)
  return `${r.station?.name ?? 'Station'} (${r.brandName ?? 'brand'}): ${parts.join(', ')}`
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const sel =
  'rounded-lg border border-kds-border bg-kds-card px-3 py-2 text-sm text-kds-text focus:border-kds-green focus:outline-none'

// ─── Stations Tab ─────────────────────────────────────────────────────────────
//
// Admin-only configuration surface. Add / rename / reorder / activate / delete
// stations. The line-cook surface that *consumes* this — clicking a station
// card to see its live queue — moved to /kds. KDS Config stays the source
// of truth: every station the kitchen view picks up is created here.

function StationsTab() {
  const qc = useQueryClient()
  const [conceptId, setConceptId] = useState<string>('all')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')
  const [draftOrder, setDraftOrder] = useState<number>(0)
  // Defaults to "all open" — operator can collapse the concepts they're not
  // actively configuring. Add-station form sits inside each concept group.
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  // Per-concept "new station" draft. Keyed by concept id so opening the form
  // on one brand doesn't lose the typed name on another.
  const [newStationDraft, setNewStationDraft] = useState<Record<string, string>>({})
  // Owner C3: the CEO's add / change applies at once; the F&B manager's and the chef's waits for the CEO.
  const { data: me } = usePermissions()
  const isCeo = me?.role === 'admin'
  const myId = useAuthStore((st) => st.user?.id)
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null)
  const { data: requests } = useQuery({
    queryKey: ['station-requests', 'pending'],
    queryFn: () => api.get<{ items: StationRequest[] }>('/stations/requests?status=pending'),
  })
  const pending = requests?.items ?? []
  const cancelRequest = useMutation({
    mutationFn: (id: string) => api.post(`/stations/requests/${id}/cancel`, {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['station-requests'] }),
    onError: (e: Error) => setNotice({ text: e.message, error: true }),
  })
  const afterSave = (r: unknown) => {
    if (r && typeof r === 'object' && 'pendingApproval' in r) {
      setNotice({ text: 'Sent to the CEO for approval — the station changes once it is approved.' })
      void qc.invalidateQueries({ queryKey: ['station-requests'] })
    } else setNotice(null)
  }

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
  // still appear so the admin has an "Add station" entry point on every brand.
  const groupedStations = useMemo(() => {
    const byConcept = new Map<string, { id: string; name: string; stations: Station[] }>()
    // Seed with every concept (so empty brands still get a card)
    for (const c of concepts) {
      if (conceptId !== 'all' && c.id !== conceptId) continue
      byConcept.set(c.id, { id: c.id, name: c.name, stations: [] })
    }
    for (const s of stations) {
      const g = byConcept.get(s.conceptId)
      if (g) g.stations.push(s)
    }
    for (const g of byConcept.values()) {
      g.stations.sort((a, b) => a.displayOrder - b.displayOrder || a.name.localeCompare(b.name))
    }
    return Array.from(byConcept.values()).sort((a, b) => a.name.localeCompare(b.name))
  }, [stations, concepts, conceptId])

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
    onSuccess: (r) => { afterSave(r); void qc.invalidateQueries({ queryKey: ['kds-stations'] }) },
    onError: (e: Error) => setNotice({ text: e.message, error: true }),
  })

  // How many order cards the station screen shows (4–6) — a screen setting,
  // applied at once (PUT /expo/stations/:id/display; owner B12, 2026-10-26).
  const setDisplay = useMutation({
    mutationFn: ({ id, visibleCards }: { id: string; visibleCards: number }) =>
      api.put(`/expo/stations/${id}/display`, { visibleCards }),
    onSuccess: () => { setNotice(null); void qc.invalidateQueries({ queryKey: ['kds-stations'] }) },
    onError: (e: Error) => setNotice({ text: e.message, error: true }),
  })

  const createStation = useMutation({
    mutationFn: (body: { conceptId: string; name: string; displayOrder: number }) =>
      api.post<Station>('/stations', body),
    onError: (e: Error) => setNotice({ text: e.message, error: true }),
    onSuccess: (r, vars) => {
      afterSave(r)
      setNewStationDraft((d) => ({ ...d, [vars.conceptId]: '' }))
      void qc.invalidateQueries({ queryKey: ['kds-stations'] })
      void qc.invalidateQueries({ queryKey: ['nav-stations'] })
    },
  })

  const deleteStation = useMutation({
    mutationFn: (id: string) => deleteWithUndo(`/stations/${id}`, { trashType: 'station', id, onRestored: () => { void qc.invalidateQueries({ queryKey: ['kds-stations'] }); void qc.invalidateQueries({ queryKey: ['nav-stations'] }) } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['kds-stations'] })
      void qc.invalidateQueries({ queryKey: ['nav-stations'] })
    },
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

  function addStation(group: { id: string; stations: Station[] }) {
    const name = (newStationDraft[group.id] ?? '').trim()
    if (!name) return
    const nextOrder = group.stations.length
      ? Math.max(...group.stations.map((s) => s.displayOrder)) + 1
      : 0
    createStation.mutate({ conceptId: group.id, name, displayOrder: nextOrder })
  }

  return (
    <div className="space-y-4">
      {notice && (
        <p role={notice.error ? 'alert' : 'status'} className={`rounded-lg border border-kds-border bg-kds-card px-3 py-2 text-sm ${notice.error ? 'text-red-700' : 'text-kds-text'}`}>
          {notice.text}
        </p>
      )}
      {pending.length > 0 && (
        <div className="rounded-xl border border-kds-border bg-kds-card px-4 py-3 space-y-2">
          <p className="text-sm font-bold text-kds-text">Waiting for the CEO ({pending.length})</p>
          {pending.map((r) => (
            <div key={r.id} className="flex items-center gap-3 flex-wrap text-sm">
              <span className="text-kds-text">{requestSummary(r)}</span>
              <span className="text-xs text-kds-subtext">{r.requestedByName ?? ''}</span>
              {isCeo ? (
                <Link href="/ceo/approvals?type=station_change" className="ml-auto text-xs font-bold text-kds-green underline">Decide</Link>
              ) : r.requestedById === myId ? (
                <button onClick={() => cancelRequest.mutate(r.id)} disabled={cancelRequest.isPending}
                  className="ml-auto min-h-11 rounded-lg border border-kds-border px-3 text-xs font-medium text-kds-subtext hover:text-kds-text disabled:opacity-50">
                  Withdraw
                </button>
              ) : null}
            </div>
          ))}
        </div>
      )}
      {/* Concept filter */}
      <div className="flex items-center gap-3">
        <label className="text-sm text-kds-subtext">Concept</label>
        <Select
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
        </Select>
      </div>

      {isLoading ? (
        <p className="rounded-xl border border-kds-border bg-kds-card px-4 py-10 text-center text-sm text-kds-subtext">
          Loading stations…
        </p>
      ) : groupedStations.length === 0 ? (
        <CompactEmptyState tone="dark" message="No brands yet"
          detail={<>Create one in <Link href="/settings" className="underline text-kds-green">Brands &amp; Stations</Link>.</>} />
      ) : (
        <div className="space-y-3">
          {groupedStations.map((group) => {
            const isCollapsed = collapsedGroups.has(group.id)
            const activeCount = group.stations.filter((s) => s.isActive).length
            const draft = newStationDraft[group.id] ?? ''
            const isCreating = createStation.isPending && createStation.variables?.conceptId === group.id
            return (
              <div key={group.id} className="rounded-xl border border-kds-border bg-kds-card overflow-hidden">
                <button onClick={() => toggleGroup(group.id)}
                  className="w-full min-h-11 flex items-center gap-3 px-4 py-3 hover:bg-kds-bg/40 transition-colors">
                  <span className="text-kds-subtext text-xs"
                    style={{ display: 'inline-block', transition: 'transform 120ms', transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}>
                    <ChevronDown size={16} aria-hidden="true" />
                  </span>
                  <span className="font-bold text-kds-text">{group.name}</span>
                  <span className="text-xs text-kds-subtext">
                    {group.stations.length} station{group.stations.length === 1 ? '' : 's'}
                    {group.stations.length > 0 && (
                      <>
                        {' · '}
                        <span className={activeCount === group.stations.length ? 'text-kds-green' : 'text-kds-amber'}>
                          {activeCount} active
                        </span>
                      </>
                    )}
                  </span>
                </button>

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
                                className="min-h-11 rounded-lg border border-kds-green bg-kds-bg px-3 text-sm text-kds-text focus:outline-none w-44"
                                autoFocus
                              />
                              <label className="text-xs text-kds-subtext flex items-center gap-1.5">
                                Order
                                <input
                                  type="number"
                                  value={draftOrder}
                                  onChange={(e) => setDraftOrder(Number(e.target.value))}
                                  className="min-h-11 rounded-lg border border-kds-green bg-kds-bg px-3 text-sm text-kds-text focus:outline-none w-20"
                                />
                              </label>
                              <div className="ml-auto flex items-center gap-2">
                                <button
                                  onClick={() => saveEdit(s.id)}
                                  disabled={patchStation.isPending || !draftName.trim()}
                                  className="min-h-11 rounded-lg bg-kds-green px-4 text-sm font-bold text-primary-on hover:opacity-90 disabled:opacity-50">
                                  Save
                                </button>
                                <button
                                  onClick={cancelEdit}
                                  className="min-h-11 rounded-lg border border-kds-border px-4 text-sm font-medium text-kds-subtext hover:text-kds-text">
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : (
                            /* Read mode — compact row */
                            <div className="flex items-center gap-3 flex-wrap">
                              <span className="font-medium text-kds-text">{s.name}</span>
                              <span className="text-xs text-kds-subtext">order {s.displayOrder}</span>
                              <span className={`inline-flex items-center justify-center h-5 min-w-[1.25rem] rounded-full text-xs font-bold px-1.5 ${
                                s.liveLoad > 0 ? 'bg-kds-amber/20 text-kds-amber' : 'bg-kds-bg text-kds-subtext'
                              }`}>
                                load {s.liveLoad}
                              </span>
                              <span className="inline-flex items-center gap-1 text-xs text-kds-subtext" role="group" aria-label={`Cards on ${s.name}'s screen`}>
                                Cards on screen
                                {[4, 5, 6].map((n) => (
                                  <button key={n} type="button"
                                    onClick={() => setDisplay.mutate({ id: s.id, visibleCards: n })}
                                    disabled={setDisplay.isPending}
                                    aria-pressed={(s.visibleCards ?? 5) === n}
                                    className={`min-h-10 min-w-10 rounded-lg border text-sm font-bold disabled:opacity-50 ${
                                      (s.visibleCards ?? 5) === n ? 'border-kds-green bg-kds-green/20 text-kds-green' : 'border-kds-border text-kds-subtext hover:text-kds-text'
                                    }`}>
                                    {n}
                                  </button>
                                ))}
                              </span>
                              <button
                                onClick={() => toggleActive(s)}
                                disabled={patchStation.isPending}
                                title={s.isActive ? 'Deactivate' : 'Activate'}
                                className={`relative inline-flex h-7 w-12 items-center rounded-full transition-colors focus:outline-none disabled:opacity-50 ${
                                  s.isActive ? 'bg-kds-green' : 'bg-kds-border'
                                }`}>
                                <span className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${
                                  s.isActive ? 'translate-x-6' : 'translate-x-1.5'
                                }`} />
                              </button>
                              <div className="ml-auto flex items-center gap-2">
                                {/* Preview the station's live screen — same
                                    URL the kitchen iPad uses. Read-only check
                                    that the routing is wired right. */}
                                <Link
                                  href={`/kds/${s.id}`}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="min-h-11 rounded-lg border border-kds-border px-4 text-sm font-medium text-kds-subtext hover:border-kds-green hover:text-kds-green transition-colors inline-flex items-center gap-1.5">
                                  <Maximize2 size={14} aria-hidden="true" /> Preview
                                </Link>
                                <button
                                  onClick={() => startEdit(s)}
                                  className="min-h-11 rounded-lg border border-kds-border px-4 text-sm font-medium text-kds-subtext hover:border-kds-green hover:text-kds-green transition-colors">
                                  Edit
                                </button>
                                {isCeo && <button
                                  onClick={() => {
                                    if (s.liveLoad > 0) {
                                      alert('This station has live tickets — bump or reassign them before deleting.')
                                      return
                                    }
                                    if (confirm(`Delete station "${s.name}"? This is a soft delete — historical orders keep referencing it.`)) {
                                      deleteStation.mutate(s.id)
                                    }
                                  }}
                                  disabled={deleteStation.isPending && deleteStation.variables === s.id}
                                  className="min-h-11 rounded-lg border border-red-500/40 px-4 text-sm font-medium text-red-700 hover:bg-red-500/10 transition-colors disabled:opacity-50">
                                  Delete
                                </button>}
                              </div>
                            </div>
                          )}
                        </div>
                      )
                    })}

                    {/* Add-station row — always at the bottom of the concept
                        group. Inline so the operator doesn't lose their place
                        navigating to a separate page. */}
                    <div className="px-4 py-3 bg-kds-bg/20">
                      <form
                        onSubmit={(e) => { e.preventDefault(); addStation(group) }}
                        className="flex items-center gap-2 flex-wrap">
                        <Plus size={20} aria-hidden="true" className="text-kds-green" />
                        <input
                          value={draft}
                          onChange={(e) => setNewStationDraft((d) => ({ ...d, [group.id]: e.target.value }))}
                          placeholder={`New ${group.name} station — e.g. "Grill", "Cold prep"`}
                          className="flex-1 min-w-[12rem] min-h-11 rounded-lg border border-kds-border bg-kds-bg px-3 text-sm text-kds-text focus:border-kds-green focus:outline-none"
                        />
                        <button
                          type="submit"
                          disabled={!draft.trim() || isCreating}
                          className="min-h-11 rounded-lg bg-kds-green px-4 text-sm font-bold text-primary-on hover:opacity-90 disabled:opacity-50">
                          {isCreating ? 'Adding…' : 'Add station'}
                        </button>
                      </form>
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
}


// ─── Page ─────────────────────────────────────────────────────────────────────
//
// Admin / boh-management configuration surface. Read-only "view what's
// cooking right now" duties live on /kds (line cook dashboard) and /expo
// (pass station overview) — this page only does CRUD on the station list.
//
// Module gate: `kds_config` (admin + boh_management by default). The kitchen
// role can't reach this page; the sidebar hides it and any direct nav fails
// the requireAuth(...ADMIN_ONLY) gate on PATCH/POST/DELETE.

export default function KdsConfigPage() {
  return (
    <div className="h-screen flex flex-col bg-kds-bg overflow-hidden">
      <header className="border-b border-kds-border px-6 py-4 flex items-center justify-between gap-3 shrink-0">
        <div>
          <Link href="/kds" className="min-h-11 text-sm text-kds-subtext hover:text-kds-text flex items-center gap-1.5 mb-1 transition-colors">
            <ArrowLeft size={16} aria-hidden="true" /> Back to Kitchen view
          </Link>
          <h1 className="text-2xl font-black text-kds-text">KDS Config</h1>
          <p className="text-sm text-kds-subtext">
            Add, rename and order the kitchen stations. Cooks see the result in <Link href="/kds" className="underline text-kds-green">Kitchen view</Link>;
            you assign cooks to stations in <Link href="/workforce" className="underline text-kds-green">Workforce</Link>.
          </p>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        <StationsTab />
      </div>
    </div>
  )
}
