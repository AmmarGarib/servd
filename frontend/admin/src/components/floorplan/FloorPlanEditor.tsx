'use client'

// FloorPlanEditor — editable canvas for tables. Drag to move, click to
// select, then use the side panel to rotate / resize / change shape /
// add/remove tables. Snap-to-grid configurable.
//
// Persistence: caller provides onSave(tables) which posts to PUT /floors/layout.

import { useEffect, useRef, useState } from 'react'
import { FloorCanvas } from './FloorCanvas'
import type { FloorTable, FloorViewport } from './FloorCanvas'
import { Select } from '@/components/ui/Select'

const SHAPES = ['rectangle', 'square', 'round', 'banquette', 'counter', 'barstool'] as const

interface Props {
  floor: FloorViewport & { id: string; name: string }
  initialTables: FloorTable[]
  conceptId: string
  onSave: (tables: FloorTable[]) => Promise<void>
  onAddTable: (input: { label: string; capacity: number; shape: FloorTable['shape']; x: number; y: number }) => Promise<FloorTable>
  onDeleteTable?: (id: string) => Promise<void>
}

export function FloorPlanEditor({ floor, initialTables, conceptId, onSave, onAddTable, onDeleteTable }: Props) {
  const [tables, setTables] = useState(initialTables)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [snap, setSnap] = useState(20)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)

  // New-table form
  const [newLabel, setNewLabel] = useState('T')
  const [newCapacity, setNewCapacity] = useState(4)
  const [newShape, setNewShape] = useState<FloorTable['shape']>('rectangle')

  // Drag state held in ref (we don't want React re-renders on every pointer move).
  const dragRef = useRef<{ id: string; offsetX: number; offsetY: number } | null>(null)
  const svgRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => setTables(initialTables), [initialTables])

  function snapTo(v: number): number {
    if (snap <= 1) return Math.round(v)
    return Math.round(v / snap) * snap
  }

  function pointerToFloorCoords(e: { clientX: number; clientY: number; currentTarget?: EventTarget | null }) {
    // Convert screen coords to SVG coords using viewport scaling
    const svg = (e.currentTarget as Element | null)?.closest('svg') ?? (svgRef.current?.querySelector('svg') ?? null)
    if (!svg) return { x: 0, y: 0 }
    const rect = svg.getBoundingClientRect()
    const sx = floor.width / rect.width
    const sy = floor.height / rect.height
    return {
      x: (e.clientX - rect.left) * sx,
      y: (e.clientY - rect.top) * sy,
    }
  }

  function onTableDown(t: FloorTable, e: React.PointerEvent<SVGGElement>) {
    e.preventDefault()
    setSelectedId(t.id)
    const { x, y } = pointerToFloorCoords(e)
    dragRef.current = { id: t.id, offsetX: x - t.x, offsetY: y - t.y }
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current
    if (!drag) return
    const { x, y } = pointerToFloorCoords(e)
    setTables((prev) => prev.map((t) => {
      if (t.id !== drag.id) return t
      const nx = clamp(snapTo(x - drag.offsetX), 0, floor.width  - t.width)
      const ny = clamp(snapTo(y - drag.offsetY), 0, floor.height - t.height)
      return { ...t, x: nx, y: ny }
    }))
    setDirty(true)
  }

  function onPointerUp() {
    dragRef.current = null
  }

  const selected = tables.find((t) => t.id === selectedId) ?? null

  function patchSelected(patch: Partial<FloorTable>) {
    if (!selected) return
    setTables((prev) => prev.map((t) => t.id === selected.id ? { ...t, ...patch } : t))
    setDirty(true)
  }

  async function handleSave() {
    setSaving(true)
    setFeedback(null)
    try {
      await onSave(tables)
      setDirty(false)
      setFeedback(`Saved · ${tables.length} table${tables.length === 1 ? '' : 's'}`)
      setTimeout(() => setFeedback(null), 3000)
    } catch (err) {
      setFeedback((err as Error).message ?? 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  async function handleAddTable() {
    if (!newLabel.trim()) return
    try {
      const created = await onAddTable({
        label: newLabel.trim(),
        capacity: newCapacity,
        shape: newShape,
        x: snapTo(40 + (tables.length * 30) % (floor.width  - 200)),
        y: snapTo(40 + (tables.length * 20) % (floor.height - 200)),
      })
      setTables((prev) => [...prev, created])
      setSelectedId(created.id)
      // Auto-increment label suggestion
      const m = newLabel.match(/^(.*?)(\d+)$/)
      setNewLabel(m ? `${m[1]}${parseInt(m[2]!, 10) + 1}` : `${newLabel}2`)
    } catch (e) {
      setFeedback((e as Error).message ?? 'Could not add table')
    }
  }

  async function handleDelete() {
    if (!selected || !onDeleteTable) return
    if (!confirm(`Delete table "${selected.label}"? This cannot be undone.`)) return
    try {
      await onDeleteTable(selected.id)
      setTables((prev) => prev.filter((t) => t.id !== selected.id))
      setSelectedId(null)
    } catch (e) {
      setFeedback((e as Error).message ?? 'Delete failed')
    }
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-4">
      {/* Canvas */}
      <div
        ref={svgRef}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <FloorCanvas
          floor={floor}
          tables={tables}
          selectedId={selectedId}
          gridSize={snap > 0 ? snap : 0}
          onTablePointerDown={onTableDown}
          colorFor={() => ({ fill: 'rgba(34,197,94,0.18)', stroke: 'rgba(22,163,74,0.6)', text: 'var(--bg)' })}
          ariaLabel={`Editing ${floor.name}`}
        />
        <div className="mt-2 flex items-center justify-between text-xs text-s-muted flex-wrap gap-2">
          <span>Drag tables to move · click to select · Tab key cycles selection</span>
          <span>{tables.length} table{tables.length === 1 ? '' : 's'} · {floor.width}×{floor.height}px</span>
        </div>
      </div>

      {/* Side panel */}
      <aside className="space-y-3">
        <div className="s-card p-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-s-muted mb-2">Layout</h3>
          <label className="block text-xs text-s-muted mb-1">Snap to grid</label>
          <Select value={snap} onChange={(e) => setSnap(parseInt(e.target.value, 10))} className="w-full bg-s-surface border border-s-border rounded px-2 py-1 text-sm text-s-text">
            <option value="0">Off (1px)</option>
            <option value="10">10px</option>
            <option value="20">20px</option>
            <option value="40">40px</option>
          </Select>
          <div className="mt-3 flex gap-2">
            <button
              onClick={handleSave}
              disabled={!dirty || saving}
              className="flex-1 py-1.5 rounded font-bold text-sm bg-primary text-primary-on disabled:opacity-50"
            >
              {saving ? 'Saving…' : dirty ? 'Save layout' : 'Saved'}
            </button>
          </div>
          {feedback && <p className="text-xs text-s-muted mt-2">{feedback}</p>}
        </div>

        {/* Selected-table panel */}
        {selected ? (
          <div className="s-card p-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-s-muted mb-2">{selected.label}</h3>
            <Field label="Shape">
              <Select value={selected.shape} onChange={(e) => patchSelected({ shape: e.target.value as FloorTable['shape'] })} className="w-full bg-s-surface border border-s-border rounded px-2 py-1 text-sm">
                {SHAPES.map((s) => <option key={s} value={s}>{s}</option>)}
              </Select>
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Width">
                <input type="number" min={20} max={800} value={selected.width} onChange={(e) => patchSelected({ width: snapTo(parseInt(e.target.value, 10) || 20) })} className="w-full bg-s-surface border border-s-border rounded px-2 py-1 text-sm" />
              </Field>
              <Field label="Height">
                <input type="number" min={20} max={800} value={selected.height} onChange={(e) => patchSelected({ height: snapTo(parseInt(e.target.value, 10) || 20) })} className="w-full bg-s-surface border border-s-border rounded px-2 py-1 text-sm" />
              </Field>
              <Field label="Rotation°">
                <input type="number" min={0} max={359} value={selected.rotation} onChange={(e) => patchSelected({ rotation: ((parseInt(e.target.value, 10) || 0) % 360 + 360) % 360 })} className="w-full bg-s-surface border border-s-border rounded px-2 py-1 text-sm" />
              </Field>
              <Field label="Capacity">
                <input type="number" min={1} max={50} value={selected.capacity} onChange={(e) => patchSelected({ capacity: parseInt(e.target.value, 10) || 1 })} className="w-full bg-s-surface border border-s-border rounded px-2 py-1 text-sm" />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-2 mt-1">
              <Field label="X">
                <input type="number" value={selected.x} onChange={(e) => patchSelected({ x: snapTo(parseInt(e.target.value, 10) || 0) })} className="w-full bg-s-surface border border-s-border rounded px-2 py-1 text-sm" />
              </Field>
              <Field label="Y">
                <input type="number" value={selected.y} onChange={(e) => patchSelected({ y: snapTo(parseInt(e.target.value, 10) || 0) })} className="w-full bg-s-surface border border-s-border rounded px-2 py-1 text-sm" />
              </Field>
            </div>
            {onDeleteTable && (
              <button onClick={handleDelete} className="mt-3 w-full py-1.5 rounded font-bold text-xs bg-s-red text-[#fff]">
                Delete table
              </button>
            )}
          </div>
        ) : (
          <div className="s-card p-3 text-center text-xs text-s-muted">
            Click a table to edit it.
          </div>
        )}

        {/* Add new table */}
        <div className="s-card p-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-s-muted mb-2">Add table</h3>
          <Field label="Label">
            <input value={newLabel} onChange={(e) => setNewLabel(e.target.value)} className="w-full bg-s-surface border border-s-border rounded px-2 py-1 text-sm" />
          </Field>
          <Field label="Capacity">
            <input type="number" min={1} max={50} value={newCapacity} onChange={(e) => setNewCapacity(parseInt(e.target.value, 10) || 1)} className="w-full bg-s-surface border border-s-border rounded px-2 py-1 text-sm" />
          </Field>
          <Field label="Shape">
            <Select value={newShape} onChange={(e) => setNewShape(e.target.value as FloorTable['shape'])} className="w-full bg-s-surface border border-s-border rounded px-2 py-1 text-sm">
              {SHAPES.map((s) => <option key={s} value={s}>{s}</option>)}
            </Select>
          </Field>
          <button onClick={handleAddTable} className="mt-2 w-full py-1.5 rounded font-bold text-xs bg-secondary text-secondary-on">
            + Add to {floor.name}
          </button>
        </div>
      </aside>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block mt-2">
      <span className="block text-[11px] text-s-muted mb-1">{label}</span>
      {children}
    </label>
  )
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}
