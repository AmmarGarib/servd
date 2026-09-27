'use client'
import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../lib/api'
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
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['kds-stations'] }),
  })

  const createStation = useMutation({
    mutationFn: (body: { conceptId: string; name: string; displayOrder: number }) =>
      api.post<Station>('/stations', body),
    onSuccess: (_, vars) => {
      setNewStationDraft((d) => ({ ...d, [vars.conceptId]: '' }))
      void qc.invalidateQueries({ queryKey: ['kds-stations'] })
      void qc.invalidateQueries({ queryKey: ['nav-stations'] })
    },
  })

  const deleteStation = useMutation({
    mutationFn: (id: string) => api.delete(`/stations/${id}`),
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

      {isLoading ? (
        <p className="rounded-xl border border-kds-border bg-kds-card px-4 py-10 text-center text-sm text-kds-subtext">
          Loading stations…
        </p>
      ) : groupedStations.length === 0 ? (
        <p className="rounded-xl border border-kds-border bg-kds-card px-4 py-10 text-center text-sm text-kds-subtext">
          No concepts yet — create one in <Link href="/settings" className="underline text-kds-green">Brands &amp; Stations</Link>.
        </p>
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
                  className="w-full flex items-center gap-3 px-4 py-3 hover:bg-kds-bg/40 transition-colors">
                  <span className="text-kds-subtext text-xs"
                    style={{ display: 'inline-block', transition: 'transform 120ms', transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}>
                    ▼
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
                                {/* Preview the station's live screen — same
                                    URL the kitchen iPad uses. Read-only check
                                    that the routing is wired right. */}
                                <Link
                                  href={`/kds/${s.id}`}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="rounded-lg border border-kds-border px-3 py-1 text-xs font-medium text-kds-subtext hover:border-kds-green hover:text-kds-green transition-colors inline-flex items-center gap-1">
                                  ⤢ Preview
                                </Link>
                                <button
                                  onClick={() => startEdit(s)}
                                  className="rounded-lg border border-kds-border px-3 py-1 text-xs font-medium text-kds-subtext hover:border-kds-green hover:text-kds-green transition-colors">
                                  Edit
                                </button>
                                <button
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
                                  className="rounded-lg border border-red-500/40 px-3 py-1 text-xs font-medium text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50">
                                  Delete
                                </button>
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
                        <span className="text-kds-green text-lg leading-none">＋</span>
                        <input
                          value={draft}
                          onChange={(e) => setNewStationDraft((d) => ({ ...d, [group.id]: e.target.value }))}
                          placeholder={`New ${group.name} station — e.g. "Grill", "Cold prep"`}
                          className="flex-1 min-w-[12rem] rounded border border-kds-border bg-kds-bg px-2 py-1 text-sm text-kds-text focus:border-kds-green focus:outline-none"
                        />
                        <button
                          type="submit"
                          disabled={!draft.trim() || isCreating}
                          className="rounded-lg bg-kds-green px-3 py-1 text-xs font-bold text-black hover:opacity-90 disabled:opacity-50">
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
          <Link href="/kds" className="text-sm text-gray-500 hover:text-gray-300 flex items-center gap-1 mb-1 transition-colors">
            ← Back to Kitchen view
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
