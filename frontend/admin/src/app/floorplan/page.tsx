'use client'

// Floorplan page — top-level container. Loads concepts + floors, lets the
// operator switch between Edit mode and Live mode, and per-concept floor
// tabs (Main / Patio / Bar etc.).
//
// This is THE table editor (D10). The old list page at /tables edited the same
// Table rows and now redirects here, so this page also carries what only it
// had: tables created without a floor (they are listed under "Not on a floor
// yet" and can be placed), capacity edits that persist, and the status toggle
// (in the live panel).

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { CompactEmptyState } from '../../components/ui/CompactEmptyState'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { api, deleteWithUndo } from '../../lib/api'
import { FloorPlanEditor } from '../../components/floorplan/FloorPlanEditor'
import type { FloorTable } from '../../components/floorplan/FloorCanvas'
import { LiveFloor } from './LiveFloor'
import { LayoutsGallery } from '../../components/floorplan/LayoutsGallery'
import { useBrandFilter } from '../../store/brandFilter'
import { Select } from '@/components/ui/Select'

interface Concept { id: string; name: string; slug: string }
interface BrandTable { id: string; label: string; capacity: number | null; floorId: string | null }

interface Floor {
  id: string
  conceptId: string
  name: string
  width: number
  height: number
  backgroundUrl: string | null
  tables: FloorTable[]
}

export default function FloorplanPage() {
  const qc = useQueryClient()
  const [conceptId, setConceptId] = useState<string>(() => useBrandFilter.getState().brandId ?? '')
  const [floorId,   setFloorId]   = useState<string>('')
  const [mode,      setMode]      = useState<'edit' | 'live'>('live')
  const [showNewFloor, setShowNewFloor] = useState(false)
  const [showLayouts,  setShowLayouts]  = useState(false)

  const concepts = useQuery({
    queryKey: ['concepts'],
    queryFn: () => api.get<Concept[]>('/concepts'),
  })

  useEffect(() => {
    if (!conceptId && concepts.data && concepts.data.length > 0) {
      setConceptId(concepts.data[0]!.id)
    }
  }, [concepts.data, conceptId])

  const floors = useQuery({
    queryKey: ['floors', conceptId],
    queryFn: () => api.get<Floor[]>(`/floors?conceptId=${conceptId}`),
    enabled: !!conceptId,
  })

  useEffect(() => {
    if (!floorId && floors.data && floors.data.length > 0) {
      setFloorId(floors.data[0]!.id)
    }
    // If selected floor disappears (deleted, concept switched), clear it
    if (floorId && floors.data && !floors.data.some((f) => f.id === floorId)) {
      setFloorId(floors.data[0]?.id ?? '')
    }
  }, [floors.data, floorId])

  const createFloor = useMutation({
    mutationFn: (input: { name: string }) => api.post<Floor>('/floors', { conceptId, name: input.name }),
    onSuccess: (f) => {
      void qc.invalidateQueries({ queryKey: ['floors', conceptId] })
      setFloorId(f.id)
      setShowNewFloor(false)
    },
  })

  // Every table of the brand — the ones with no floor were made on the old
  // /tables list page (or had their floor deleted) and would otherwise be
  // invisible here.
  const brandTables = useQuery({
    queryKey: ['tables', conceptId],
    queryFn: () => api.get<BrandTable[]>(`/tables?conceptId=${conceptId}`),
    enabled: !!conceptId,
  })
  const unplaced = (brandTables.data ?? []).filter((t) => !t.floorId)

  const placeTable = useMutation({
    mutationFn: (id: string) => api.patch(`/floors/tables/${id}/position`, { floorId, x: 40, y: 40 }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['floors', conceptId] })
      void qc.invalidateQueries({ queryKey: ['tables', conceptId] })
    },
  })

  const saveLayout = useMutation({
    mutationFn: async (tables: FloorTable[]) => {
      await api.put('/floors/layout', { floorId, tables })
      // The layout save carries position and shape only; label / capacity
      // edits go through PATCH /tables/:id (the same call /tables used).
      const before = new Map((currentFloor?.tables ?? []).map((t) => [t.id, t]))
      await Promise.all(tables
        .filter((t) => { const b = before.get(t.id); return b && (b.capacity !== t.capacity || b.label !== t.label) })
        .map((t) => api.patch(`/tables/${t.id}`, { capacity: t.capacity, label: t.label })))
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['floors', conceptId] })
      void qc.invalidateQueries({ queryKey: ['tables', conceptId] })
    },
  })

  const addTable = useMutation({
    mutationFn: async (input: { label: string; capacity: number; shape: FloorTable['shape']; x: number; y: number }) => {
      const created = await api.post<{ id: string; label: string; capacity: number; shape: FloorTable['shape']; x: number; y: number; width: number; height: number; rotation: number }>(
        '/tables',
        { conceptId, label: input.label, capacity: input.capacity, floorSection: '' },
      )
      // Patch the new table with shape + position right away
      await api.patch(`/floors/tables/${created.id}/position`, {
        floorId, shape: input.shape, x: input.x, y: input.y,
      })
      return { ...created, floorId, shape: input.shape, x: input.x, y: input.y } as FloorTable
    },
  })

  const deleteTable = useMutation({
    mutationFn: (id: string) => deleteWithUndo(`/tables/${id}`, { trashType: 'table', id, onRestored: () => void qc.invalidateQueries({ queryKey: ['floors', conceptId] }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['floors', conceptId] }),
  })

  const currentFloor = floors.data?.find((f) => f.id === floorId)

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-6 py-4 flex items-center justify-between flex-wrap gap-3">
        <div>
          <p className="text-xs text-s-muted">Operations</p>
          <h1 className="text-xl font-bold text-s-text">Floor plan</h1>
        </div>
        <div className="flex gap-2 items-center flex-wrap">
          <Select value={conceptId} onChange={(e) => { setConceptId(e.target.value); setFloorId('') }}
            className="bg-s-surface border border-s-border rounded px-2 py-1 text-sm">
            {concepts.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>

          <div className="rounded-full border border-s-border bg-s-surface p-0.5 flex">
            <button onClick={() => setMode('live')}  aria-pressed={mode === 'live'}
              className={`px-3 py-1 rounded-full text-xs font-bold ${mode === 'live' ? 'bg-primary text-primary-on' : 'text-s-text'}`}>
              ● Live
            </button>
            <button onClick={() => setMode('edit')} aria-pressed={mode === 'edit'}
              className={`px-3 py-1 rounded-full text-xs font-bold ${mode === 'edit' ? 'bg-primary text-primary-on' : 'text-s-text'}`}>
              Edit
            </button>
          </div>
        </div>
      </header>

      <div className="p-6 max-w-7xl mx-auto">
        {/* Floor tabs */}
        <div className="flex items-center gap-1.5 mb-4 flex-wrap">
          {floors.data?.map((f) => (
            <button
              key={f.id}
              onClick={() => setFloorId(f.id)}
              aria-pressed={floorId === f.id}
              className={`px-3 py-1.5 rounded-full text-xs font-semibold border ${
                floorId === f.id ? 'bg-primary text-primary-on border-primary' : 'bg-s-surface border-s-border text-s-text hover:bg-s-bg-soft'
              }`}
            >
              {f.name} <span className="ml-1 opacity-60">{f.tables.length}</span>
            </button>
          ))}
          <button
            onClick={() => setShowNewFloor(true)}
            className="px-3 py-1.5 rounded-full text-xs font-semibold border bg-s-surface border-dashed border-s-border text-s-muted hover:bg-s-bg-soft"
          >
            + New floor
          </button>
          {currentFloor && (
            <button
              onClick={() => setShowLayouts(true)}
              className="px-3 py-1.5 rounded-full text-xs font-semibold border bg-s-surface border-s-border text-s-text hover:bg-s-bg-soft"
              title="Drop a pre-built table arrangement onto this floor"
            >
              📐 Layouts
            </button>
          )}
        </div>

        {showLayouts && currentFloor && (
          <LayoutsGallery
            floorId={currentFloor.id}
            hasExistingTables={currentFloor.tables.length > 0}
            onClose={() => setShowLayouts(false)}
            onApplied={() => { setShowLayouts(false); void qc.invalidateQueries({ queryKey: ['floors', conceptId] }) }}
          />
        )}

        {/* New-floor inline form */}
        {showNewFloor && (
          <div className="s-card p-3 mb-4 flex gap-2">
            <input
              autoFocus
              placeholder="Floor name (e.g. Main, Patio, Bar)"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const v = (e.target as HTMLInputElement).value.trim()
                  if (v) createFloor.mutate({ name: v })
                }
                if (e.key === 'Escape') setShowNewFloor(false)
              }}
              className="flex-1 bg-s-surface border border-s-border rounded px-2 py-1 text-sm"
            />
            <button onClick={() => setShowNewFloor(false)} className="text-xs text-s-muted">Cancel</button>
          </div>
        )}

        {/* Empty state */}
        {floors.isLoading && <p className="text-s-muted text-sm">Loading floors…</p>}
        {floors.data && floors.data.length === 0 && (
          <CompactEmptyState message="No floors yet. Create one, such as Main, Patio or Bar." action={{ label: 'Create floor', onClick: () => setShowNewFloor(true) }} />
        )}

        {/* Tables with no floor — place them on the selected floor. */}
        {unplaced.length > 0 && (
          <div className="s-card p-3 mb-4">
            <p className="text-xs font-semibold text-s-text mb-2">
              Not on a floor yet <span className="text-s-muted font-normal">— {unplaced.length} table{unplaced.length === 1 ? '' : 's'} of this brand</span>
            </p>
            <div className="flex flex-wrap gap-2">
              {unplaced.map((t) => (
                <span key={t.id} className="inline-flex items-center gap-2 rounded-full border border-s-border bg-s-surface px-3 py-1 text-xs">
                  <span className="font-semibold">{t.label}</span>
                  {t.capacity != null && <span className="text-s-muted">{t.capacity} seats</span>}
                  {currentFloor ? (
                    <button onClick={() => placeTable.mutate(t.id)} disabled={placeTable.isPending}
                      className="text-primary-ink hover:underline disabled:opacity-50">
                      Place on {currentFloor.name}
                    </button>
                  ) : (
                    <span className="text-s-muted">create a floor first</span>
                  )}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Edit / Live */}
        {currentFloor && mode === 'edit' && (
          <FloorPlanEditor
            floor={currentFloor}
            initialTables={currentFloor.tables}
            conceptId={conceptId}
            onSave={async (tables) => { await saveLayout.mutateAsync(tables) }}
            onAddTable={async (input) => addTable.mutateAsync(input)}
            onDeleteTable={async (id) => { await deleteTable.mutateAsync(id) }}
          />
        )}
        {currentFloor && mode === 'live' && (
          <LiveFloor floor={currentFloor} conceptId={conceptId} />
        )}

        <p className="text-xs text-s-muted mt-6">
          See reservations on the <Link href="/reservations" className="text-primary-ink hover:underline">reservations page</Link>.
        </p>
      </div>
    </div>
  )
}
