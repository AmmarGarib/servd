'use client'

// Builder canvas: the page's elements in order, with native HTML5 drag and
// drop (reorder, drag from the palette, drag into / out of a columns
// element) plus button fallbacks (up, down, move out, duplicate, hide, delete).

import { useState } from 'react'
import { ChevronDown, ChevronUp, Copy, CornerLeftUp, Eye, EyeOff, GripVertical, Trash2 } from 'lucide-react'
import { blockSpec, blockSummary, canNest, columnsOf, type Block } from '../../lib/blocks'
import { makeBlock, sectionSpec, sectionSummary, type PaletteItem } from '../../lib/sections'
import { duplicate, findBlock, insertAt, moveOut, moveTo, nudge, removeBlock, updateBlock, type Slot } from './tree'

// ─── Drag payload (one drag at a time; dataTransfer is unreadable on dragover) ──

type DragPayload = { source: 'palette'; type: string } | { source: 'canvas'; id: string; type: string }
let drag: DragPayload | null = null
export function startDrag(e: React.DragEvent, payload: DragPayload) {
  e.stopPropagation()
  drag = payload
  e.dataTransfer.effectAllowed = payload.source === 'palette' ? 'copy' : 'move'
  e.dataTransfer.setData('text/plain', payload.source === 'palette' ? payload.type : payload.id)
}
export function endDrag() { drag = null }

// ─── Palette ───────────────────────────────────────────────────────────────

export function Palette({ items, onAdd }: { items: PaletteItem[]; onAdd: (key: string) => void }) {
  const specs = items
  const groups = Array.from(new Set(specs.map((s) => s.group)))
  return (
    <div className="space-y-4">
      <p className="text-[11px] text-s-dim">Click to add after the selected element, or drag onto the canvas.</p>
      {groups.map((g) => (
        <div key={g}>
          <p className="text-[11px] uppercase tracking-wider text-s-muted font-bold mb-1.5">{g}</p>
          <div className="space-y-1">
            {specs.filter((s) => s.group === g).map((s) => (
              <button key={s.key} type="button" draggable
                onDragStart={(e) => startDrag(e, { source: 'palette', type: s.key })} onDragEnd={endDrag}
                onClick={() => onAdd(s.key)} title={s.description}
                className="w-full flex items-center gap-2 rounded-lg border border-s-border bg-s-surface px-2 py-1.5 text-left hover:border-s-teal cursor-grab active:cursor-grabbing">
                <span className="w-9 shrink-0 text-center rounded bg-s-bg-soft text-[10px] font-bold text-s-muted py-0.5">{s.icon}</span>
                <span className="text-xs text-s-text truncate">{s.label}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

// ─── Canvas ────────────────────────────────────────────────────────────────

interface CanvasProps {
  blocks: Block[]
  onChange: (next: Block[]) => void
  selectedId: string | null
  onSelect: (id: string | null) => void
  items: PaletteItem[]
}

export function Canvas({ blocks, onChange, selectedId, onSelect, items }: CanvasProps) {
  const drop = (slot: Slot) => {
    const p = drag
    drag = null
    if (!p) return
    if (p.source === 'palette') {
      const b = makeBlock(p.type)
      const next = insertAt(blocks, slot, b)
      if (next !== blocks) { onChange(next); onSelect(b.id) }
    } else {
      onChange(moveTo(blocks, p.id, slot))
    }
  }

  const ops = {
    select: onSelect,
    up: (id: string) => onChange(nudge(blocks, id, -1)),
    down: (id: string) => onChange(nudge(blocks, id, 1)),
    out: (id: string) => onChange(moveOut(blocks, id)),
    dup: (id: string) => { const r = duplicate(blocks, id); onChange(r.blocks); if (r.newId) onSelect(r.newId) },
    toggle: (id: string) => { const b = findBlock(blocks, id); if (b) onChange(updateBlock(blocks, { ...b, hidden: !b.hidden || undefined })) },
    del: (id: string) => {
      const b = findBlock(blocks, id)
      const kids = b ? (columnsOf(b) ?? []).flat().length : 0
      if (kids && !confirm(`Delete these columns and the ${kids} element(s) inside?`)) return
      onChange(removeBlock(blocks, id))
      if (selectedId === id) onSelect(null)
    },
    addInto: (parentId: string, col: number, key: string) => {
      const parent = blocks.find((b) => b.id === parentId)
      const len = parent ? columnsOf(parent)?.[col]?.length ?? 0 : 0
      const b = makeBlock(key)
      onChange(insertAt(blocks, { parentId, col, index: len }, b))
      onSelect(b.id)
    },
  }

  if (blocks.length === 0) {
    return (
      <DropZone slot={{ parentId: null, col: 0, index: 0 }} onDrop={drop} nested={false} big>
        No elements yet. Drag one in from the palette, or click one to add it.
      </DropZone>
    )
  }

  return (
    <div>
      {blocks.map((b, i) => (
        <div key={b.id}>
          <DropZone slot={{ parentId: null, col: 0, index: i }} onDrop={drop} nested={false} />
          <ElementCard block={b} first={i === 0} last={i === blocks.length - 1} nested={false}
            selectedId={selectedId} ops={ops} onDrop={drop} items={items} />
        </div>
      ))}
      <DropZone slot={{ parentId: null, col: 0, index: blocks.length }} onDrop={drop} nested={false} />
    </div>
  )
}

type Ops = {
  select: (id: string) => void
  up: (id: string) => void; down: (id: string) => void; out: (id: string) => void
  dup: (id: string) => void; toggle: (id: string) => void; del: (id: string) => void
  addInto: (parentId: string, col: number, key: string) => void
}

function DropZone({ slot, onDrop, nested, big, children }: { slot: Slot; onDrop: (s: Slot) => void; nested: boolean; big?: boolean; children?: React.ReactNode }) {
  const [over, setOver] = useState(false)
  const accepts = () => !!drag && (!nested || canNest(drag.type)) && !(drag.source === 'canvas' && drag.id === slot.parentId)
  return (
    <div
      onDragOver={(e) => { if (!accepts()) return; e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = drag?.source === 'palette' ? 'copy' : 'move'; if (!over) setOver(true) }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); setOver(false); onDrop(slot) }}
      className={big
        ? `rounded-xl border-2 border-dashed p-10 text-center text-sm ${over ? 'border-s-teal text-primary-ink bg-s-teal-dim/30' : 'border-s-border text-s-muted'}`
        : `transition-all rounded ${over ? 'h-8 my-1 border-2 border-dashed border-s-teal bg-s-teal-dim/30' : nested ? 'h-2' : 'h-3'}`}
    >
      {children}
    </div>
  )
}

function ElementCard({ block, first, last, nested, selectedId, ops, onDrop, items }: {
  block: Block; first: boolean; last: boolean; nested: boolean
  selectedId: string | null; ops: Ops; onDrop: (s: Slot) => void; items: PaletteItem[]
}) {
  const section = block.type === 'section' ? sectionSpec(block.variant as string | undefined) : undefined
  const spec = section
    ? { label: section.label, icon: (section.icon ?? section.label.slice(0, 2)).slice(0, 3).toUpperCase() }
    : block.type === 'section' ? { label: 'Section', icon: 'SEC' } : blockSpec(block.type)
  const selected = selectedId === block.id
  const cols = columnsOf(block)
  const btn = 'p-1 rounded text-s-muted hover:text-s-text hover:bg-s-bg-soft disabled:opacity-30 disabled:hover:bg-transparent'
  return (
    <div
      draggable
      onDragStart={(e) => startDrag(e, { source: 'canvas', id: block.id, type: block.type })}
      onDragEnd={endDrag}
      onClick={(e) => { e.stopPropagation(); ops.select(block.id) }}
      className={`rounded-xl border bg-s-surface transition-colors cursor-pointer ${selected ? 'border-s-teal ring-1 ring-s-teal/40' : 'border-s-border hover:border-s-border-strong'} ${block.hidden ? 'opacity-50' : ''}`}
    >
      <div className={`flex items-center gap-2 ${nested ? 'p-2' : 'p-3'}`}>
        <GripVertical size={14} className="text-s-dim shrink-0 cursor-grab" aria-hidden />
        <span className="w-9 shrink-0 text-center rounded bg-s-bg-soft text-[10px] font-bold text-s-muted py-0.5">{spec?.icon ?? '?'}</span>
        <div className="flex-1 min-w-0">
          <p className={`${nested ? 'text-xs' : 'text-sm'} font-semibold text-s-text truncate`}>
            {spec?.label ?? block.type}
            {block.hidden && <span className="ml-2 text-[10px] font-normal text-s-muted">hidden</span>}
            {block.animation && block.animation !== 'none' && <span className="ml-2 text-[10px] font-normal text-s-muted">{block.animation}</span>}
          </p>
          {!nested && <p className="text-[11px] text-s-muted truncate">{block.type === 'section' ? sectionSummary(block) : blockSummary(block)}</p>}
        </div>
        <div className="flex items-center shrink-0" onClick={(e) => e.stopPropagation()}>
          <button type="button" onClick={() => ops.up(block.id)} disabled={first} aria-label="Move up" title="Move up" className={btn}><ChevronUp size={14} /></button>
          <button type="button" onClick={() => ops.down(block.id)} disabled={last} aria-label="Move down" title="Move down" className={btn}><ChevronDown size={14} /></button>
          {nested && <button type="button" onClick={() => ops.out(block.id)} aria-label="Move out of columns" title="Move out of columns" className={btn}><CornerLeftUp size={14} /></button>}
          <button type="button" onClick={() => ops.toggle(block.id)} aria-label={block.hidden ? 'Show' : 'Hide'} title={block.hidden ? 'Show' : 'Hide'} className={btn}>{block.hidden ? <EyeOff size={14} /> : <Eye size={14} />}</button>
          <button type="button" onClick={() => ops.dup(block.id)} aria-label="Duplicate" title="Duplicate" className={btn}><Copy size={14} /></button>
          <button type="button" onClick={() => ops.del(block.id)} aria-label="Delete" title="Delete" className={`${btn} hover:text-s-red`}><Trash2 size={14} /></button>
        </div>
      </div>

      {cols && (
        <div className="px-3 pb-3 grid gap-2" style={{ gridTemplateColumns: `repeat(${cols.length}, minmax(0, 1fr))` }}>
          {cols.map((col, c) => (
            <div key={c} className="rounded-lg border border-dashed border-s-border bg-s-bg/60 p-1.5 min-h-[72px]">
              <p className="text-[10px] uppercase tracking-wider text-s-dim px-1">Column {c + 1}</p>
              {col.map((child, j) => (
                <div key={child.id}>
                  <DropZone slot={{ parentId: block.id, col: c, index: j }} onDrop={onDrop} nested />
                  <ElementCard block={child} first={j === 0} last={j === col.length - 1} nested
                    selectedId={selectedId} ops={ops} onDrop={onDrop} items={items} />
                </div>
              ))}
              <DropZone slot={{ parentId: block.id, col: c, index: col.length }} onDrop={onDrop} nested />
              <select value="" onClick={(e) => e.stopPropagation()}
                onChange={(e) => { if (e.target.value) ops.addInto(block.id, c, e.target.value) }}
                className="s-select text-[11px] py-1 mt-1" aria-label={`Add element to column ${c + 1}`}>
                <option value="">+ Add element</option>
                {items.filter((s) => canNest(s.key)).map((s) => (
                  <option key={s.key} value={s.key}>{s.label}</option>
                ))}
              </select>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
