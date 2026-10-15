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
import { NumberField } from '@/components/ui/NumberField'
import { useConfirm } from '@/components/ui/ConfirmDialog'

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
  const confirm = useConfirm()
  const [dragging, setDragging] = useState(false)
  const [tables, setTables] = useState(initialTables)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [snap, setSnap] = useState(20)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)

  // New-table form
  const [newLabel, setNewLabel] = useState('T')
  const [newCapacity, setNewCapacity] = useState<number | null>(4)
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
    setDragging(true)
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
    setDragging(false)
  }

  const selected = tables.find((t) => t.id === selectedId) ?? null

  // Unsaved layout: the browser asks before the tab closes or the page reloads.
  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  // Arrow keys nudge the selected table (Shift = 10). Ignored while typing in a field.
  useEffect(() => {
    if (!selectedId) return
    const onKey = (e: KeyboardEvent) => {
      const dx = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0
      const dy = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0
      if (!dx && !dy) return
      if (e.altKey || e.ctrlKey || e.metaKey) return
      const el = e.target as HTMLElement | null
      if (el && (el.closest('input,textarea,select,button,[contenteditable="true"],[role="dialog"],[role="listbox"],[role="combobox"]'))) return
      e.preventDefault()
      const step = e.shiftKey ? 10 : 1
      setTables((prev) => prev.map((t) => t.id !== selectedId ? t : {
        ...t,
        x: clamp(t.x + dx * step, 0, Math.max(0, floor.width - t.width)),
        y: clamp(t.y + dy * step, 0, Math.max(0, floor.height - t.height)),
      }))
      setDirty(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedId, floor.width, floor.height])

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
        capacity: newCapacity ?? 1,
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
    const ok = await confirm({ title: `Delete table "${selected.label}"?`, body: 'This cannot be undone.', confirmLabel: 'Delete table', danger: true })
    if (!ok) return
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
          dragging={dragging}
          onTablePointerDown={onTableDown}
          colorFor={() => ({ fill: 'rgba(34,197,94,0.18)', stroke: 'rgba(22,163,74,0.6)', text: 'var(--bg)' })}
          ariaLabel={`Editing ${floor.name}`}
        />
        <div className="mt-2 flex items-center justify-between text-xs text-s-muted flex-wrap gap-2">
          <span>Drag tables to move · click to select · arrow keys nudge (Shift = 10)</span>
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
                <CommitNumber key={`${selected.id}-w`} normalize={snapTo} value={selected.width} min={20} max={800} onCommit={(v) => patchSelected({ width: snapTo(v) })} />
              </Field>
              <Field label="Height">
                <CommitNumber key={`${selected.id}-h`} normalize={snapTo} value={selected.height} min={20} max={800} onCommit={(v) => patchSelected({ height: snapTo(v) })} />
              </Field>
              <Field label="Rotation°">
                <CommitNumber key={`${selected.id}-r`} value={selected.rotation} min={0} max={359} onCommit={(v) => patchSelected({ rotation: ((v % 360) + 360) % 360 })} />
              </Field>
              <Field label="Capacity">
                <CommitNumber key={`${selected.id}-c`} value={selected.capacity} min={1} max={50} onCommit={(v) => patchSelected({ capacity: v })} />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-2 mt-1">
              <Field label="X">
                <CommitNumber key={`${selected.id}-x`} normalize={snapTo} value={selected.x} min={0} onCommit={(v) => patchSelected({ x: snapTo(v) })} />
              </Field>
              <Field label="Y">
                <CommitNumber key={`${selected.id}-y`} normalize={snapTo} value={selected.y} min={0} onCommit={(v) => patchSelected({ y: snapTo(v) })} />
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
            <NumberField min={1} max={50} value={newCapacity} onValueChange={setNewCapacity} className="w-full bg-s-surface border border-s-border rounded px-2 py-1 text-sm" />
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

/** A number box that holds what is typed (Backspace can empty it) and applies it when the field loses focus or Enter is pressed. */
function CommitNumber({ value, min, max, normalize, onCommit }: { value: number; min?: number; max?: number; normalize?: (v: number) => number; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState<number | null>(value)
  useEffect(() => setDraft(value), [value])
  return (
    <NumberField
      value={draft} onValueChange={setDraft} min={min} max={max}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
      onBlur={() => {
        if (draft == null) { setDraft(value); return }
        let v = draft
        if (min != null && v < min) v = min
        if (max != null && v > max) v = max
        if (normalize) v = normalize(v)
        setDraft(v)
        if (v !== value) onCommit(v)
      }}
      className="w-full bg-s-surface border border-s-border rounded px-2 py-1 text-sm"
    />
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
