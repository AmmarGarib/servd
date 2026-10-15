'use client'

// Builder Layers: the page's elements in order, with native HTML5 drag and
// drop (reorder, drag from the Add palette, drag into / out of a columns
// element) plus button fallbacks (up, down, move out, duplicate, hide,
// delete). The real page is the live frame in the middle of the builder
// (LiveCanvas); this list stays the place to reorder and pick elements, and
// its selection and hover follow the frame's both ways.
//
// `compact` is the 260 px Layers pane: one line per element (the summary is
// its tooltip), actions on hover or when selected, column children indented.

import { useEffect, useRef, useState } from 'react'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import { ChevronDown, ChevronUp, Copy, CornerLeftUp, Eye, EyeOff, GripVertical, Trash2 } from 'lucide-react'
import { blockSpec, blockSummary, canNest, columnsOf, MOTION_UI, motionPresetOf, type Block } from '../../lib/blocks'
import { makeBlock, sectionSpec, sectionSummary, type PaletteItem } from '../../lib/sections'
import { duplicate, findBlock, insertAt, moveOut, moveTo, nudge, removeBlock, updateBlock, type Slot } from './tree'
import { Select } from '@/components/ui/Select'

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

// ─── Palette (the Layers pane's "Add" tab) ─────────────────────────────────

export function Palette({ items, onAdd, empty }: { items: PaletteItem[]; onAdd: (key: string) => void; empty?: string }) {
  const specs = items
  const groups = Array.from(new Set(specs.map((s) => s.group)))
  return (
    <div className="space-y-4">
      <p className="text-[11px] text-s-dim">Click to add after the selected element, or drag into Layers.</p>
      {specs.length === 0 && empty && <p className="text-xs text-s-muted">{empty}</p>}
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

// ─── Layers ────────────────────────────────────────────────────────────────

interface CanvasProps {
  blocks: Block[]
  onChange: (next: Block[]) => void
  selectedId: string | null
  onSelect: (id: string | null) => void
  items: PaletteItem[]
  /** The narrow Layers pane (one line per element). */
  compact?: boolean
  /** The element hovered here or in the live page. */
  hoverId?: string | null
  onHover?: (id: string | null) => void
  /** Scroll this row into view (a selection made in the live page). */
  reveal?: { id: string; nonce: number } | null
  /** Shown, but the live page drew nothing for them. */
  missingIds?: ReadonlySet<string> | null
  /** Screen-reader announcement (aria-live) for add / move. */
  onAnnounce?: (text: string) => void
}

function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let n = el?.parentElement ?? null; n; n = n.parentElement) {
    const oy = getComputedStyle(n).overflowY
    if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight) return n
  }
  return null
}

export function Canvas({ blocks, onChange, selectedId, onSelect, items, compact = false, hoverId = null, onHover, reveal, missingIds, onAnnounce }: CanvasProps) {
  const root = useRef<HTMLDivElement>(null)
  const confirm = useConfirm()

  // While an element is dragged, a long list scrolls when the pointer nears the pane's top or bottom edge.
  useEffect(() => {
    const onOver = (e: DragEvent) => {
      if (!drag) return
      const sc = scrollParent(root.current)
      if (!sc) return
      const r = sc.getBoundingClientRect()
      const zone = 48
      if (e.clientX < r.left || e.clientX > r.right) return
      if (e.clientY < r.top + zone && e.clientY >= r.top - 8) sc.scrollTop -= Math.ceil((r.top + zone - e.clientY) / 3)
      else if (e.clientY > r.bottom - zone && e.clientY <= r.bottom + 8) sc.scrollTop += Math.ceil((e.clientY - (r.bottom - zone)) / 3)
    }
    document.addEventListener('dragover', onOver, true)
    return () => document.removeEventListener('dragover', onOver, true)
  }, [])

  useEffect(() => {
    if (!reveal) return
    const el = Array.from(root.current?.querySelectorAll<HTMLElement>('[data-layer-id]') ?? [])
      .find((n) => n.dataset['layerId'] === reveal.id)
    el?.scrollIntoView({ block: 'nearest' })
  }, [reveal?.id, reveal?.nonce]) // eslint-disable-line react-hooks/exhaustive-deps

  const drop = (slot: Slot) => {
    const p = drag
    drag = null
    if (!p) return
    if (p.source === 'palette') {
      const b = makeBlock(p.type)
      const next = insertAt(blocks, slot, b)
      if (next !== blocks) { onChange(next); onSelect(b.id); onAnnounce?.(`Element added at position ${slot.index + 1}.`) }
    } else {
      onChange(moveTo(blocks, p.id, slot))
      onAnnounce?.(`Element moved to position ${slot.index + 1}.`)
    }
  }

  const ops: Ops = {
    select: onSelect,
    hover: (id) => onHover?.(id),
    up: (id) => { onChange(nudge(blocks, id, -1)); onAnnounce?.('Element moved up.') },
    down: (id) => { onChange(nudge(blocks, id, 1)); onAnnounce?.('Element moved down.') },
    out: (id) => { onChange(moveOut(blocks, id)); onAnnounce?.('Element moved out of columns.') },
    dup: (id) => { const r = duplicate(blocks, id); onChange(r.blocks); if (r.newId) onSelect(r.newId) },
    toggle: (id) => { const b = findBlock(blocks, id); if (b) onChange(updateBlock(blocks, { ...b, hidden: !b.hidden || undefined })) },
    del: async (id) => {
      const b = findBlock(blocks, id)
      const kids = b ? (columnsOf(b) ?? []).flat().length : 0
      if (kids && !await confirm({ title: 'Delete these columns?', body: `The ${kids} element(s) inside are deleted too.`, confirmLabel: 'Delete', danger: true })) return
      onChange(removeBlock(blocks, id))
      onAnnounce?.('Element deleted.')
      if (selectedId === id) onSelect(null)
    },
    addInto: (parentId, col, key) => {
      const parent = blocks.find((b) => b.id === parentId)
      const len = parent ? columnsOf(parent)?.[col]?.length ?? 0 : 0
      const b = makeBlock(key)
      onChange(insertAt(blocks, { parentId, col, index: len }, b))
      onSelect(b.id)
    },
  }
  const view: View = { compact, selectedId, hoverId, missingIds: missingIds ?? null }

  if (blocks.length === 0) {
    return (
      <div ref={root}>
        <DropZone slot={{ parentId: null, col: 0, index: 0 }} onDrop={drop} nested={false} big compact={compact}>
          No elements yet. Drag one in from Add, or click one there to add it.
        </DropZone>
      </div>
    )
  }

  return (
    <div ref={root} onMouseLeave={() => onHover?.(null)}>
      {blocks.map((b, i) => (
        <div key={b.id}>
          <DropZone slot={{ parentId: null, col: 0, index: i }} onDrop={drop} nested={false} compact={compact} />
          <ElementCard block={b} first={i === 0} last={i === blocks.length - 1} nested={false}
            view={view} ops={ops} onDrop={drop} items={items} />
        </div>
      ))}
      <DropZone slot={{ parentId: null, col: 0, index: blocks.length }} onDrop={drop} nested={false} compact={compact} />
    </div>
  )
}

type Ops = {
  select: (id: string) => void
  hover: (id: string | null) => void
  up: (id: string) => void; down: (id: string) => void; out: (id: string) => void
  dup: (id: string) => void; toggle: (id: string) => void; del: (id: string) => void | Promise<void>
  addInto: (parentId: string, col: number, key: string) => void
}

type View = { compact: boolean; selectedId: string | null; hoverId: string | null; missingIds: ReadonlySet<string> | null }

function DropZone({ slot, onDrop, nested, big, compact, children }: { slot: Slot; onDrop: (s: Slot) => void; nested: boolean; big?: boolean; compact?: boolean; children?: React.ReactNode }) {
  const [over, setOver] = useState(false)
  const accepts = () => !!drag && (!nested || canNest(drag.type)) && !(drag.source === 'canvas' && drag.id === slot.parentId)
  return (
    <div
      onDragOver={(e) => { if (!accepts()) return; e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = drag?.source === 'palette' ? 'copy' : 'move'; if (!over) setOver(true) }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); setOver(false); onDrop(slot) }}
      className={big
        ? `rounded-xl border-2 border-dashed ${compact ? 'p-5 text-xs' : 'p-10 text-sm'} text-center ${over ? 'border-s-teal text-primary-ink bg-s-teal-dim/30' : 'border-s-border text-s-muted'}`
        : `transition-all rounded ${over ? `${compact ? 'h-6' : 'h-8'} my-1 border-2 border-dashed border-s-teal bg-s-teal-dim/30` : nested || compact ? 'h-1.5' : 'h-3'}`}
    >
      {children}
    </div>
  )
}

function specFor(block: Block): { label: string; icon: string } | undefined {
  const section = block.type === 'section' ? sectionSpec(block.variant as string | undefined) : undefined
  return section
    ? { label: section.label, icon: (section.icon ?? section.label.slice(0, 2)).slice(0, 3).toUpperCase() }
    : block.type === 'section' ? { label: 'Section', icon: 'SEC' } : blockSpec(block.type)
}

function ElementCard({ block, first, last, nested, view, ops, onDrop, items }: {
  block: Block; first: boolean; last: boolean; nested: boolean
  view: View; ops: Ops; onDrop: (s: Slot) => void; items: PaletteItem[]
}) {
  const spec = specFor(block)
  const selected = view.selectedId === block.id
  const hovered = view.hoverId === block.id
  const cols = columnsOf(block)
  const summary = block.type === 'section' ? sectionSummary(block) : blockSummary(block)
  const motion = motionPresetOf(block)
  const missing = !block.hidden && !!view.missingIds?.has(block.id)
  const btn = 'p-1 rounded text-s-muted hover:text-s-text hover:bg-s-bg-soft disabled:opacity-30 disabled:hover:bg-transparent'
  const compact = view.compact

  const actions = (
    <div className="flex items-center shrink-0" onClick={(e) => e.stopPropagation()}>
      <button type="button" onClick={() => ops.up(block.id)} disabled={first} aria-label="Move up" title="Move up" className={btn}><ChevronUp size={14} /></button>
      <button type="button" onClick={() => ops.down(block.id)} disabled={last} aria-label="Move down" title="Move down" className={btn}><ChevronDown size={14} /></button>
      {nested && <button type="button" onClick={() => ops.out(block.id)} aria-label="Move out of columns" title="Move out of columns" className={btn}><CornerLeftUp size={14} /></button>}
      <button type="button" onClick={() => ops.toggle(block.id)} aria-label={block.hidden ? 'Show' : 'Hide'} title={block.hidden ? 'Show' : 'Hide'} className={btn}>{block.hidden ? <EyeOff size={14} /> : <Eye size={14} />}</button>
      <button type="button" onClick={() => ops.dup(block.id)} aria-label="Duplicate" title="Duplicate" className={btn}><Copy size={14} /></button>
      <button type="button" onClick={() => ops.del(block.id)} aria-label="Delete" title="Delete" className={`${btn} hover:text-s-red`}><Trash2 size={14} /></button>
    </div>
  )

  const badges = (
    <>
      {block.hidden && <span className="text-[10px] font-normal text-s-muted">hidden</span>}
      {block.animation && block.animation !== 'none' && <span className="text-[10px] font-normal text-s-muted" title="Entrance (plays once)">{block.animation}</span>}
      {motion && <span className="text-[10px] font-normal text-s-indigo" title="Scroll effect">{MOTION_UI[motion].label}</span>}
      {missing && <span className="text-[10px] font-normal text-s-amber" title="The live page drew nothing for this element (empty, or nothing to show yet).">not on the page</span>}
    </>
  )

  const columns = cols && (compact
    ? (
      <div className="pl-3 pr-1 pb-1.5 space-y-1.5">
        {cols.map((col, c) => (
          <div key={c} className="rounded-md border border-dashed border-s-border bg-s-bg/60 p-1">
            <p className="text-[10px] uppercase tracking-wider text-s-dim px-1">Column {c + 1}</p>
            {col.map((child, j) => (
              <div key={child.id}>
                <DropZone slot={{ parentId: block.id, col: c, index: j }} onDrop={onDrop} nested compact />
                <ElementCard block={child} first={j === 0} last={j === col.length - 1} nested
                  view={view} ops={ops} onDrop={onDrop} items={items} />
              </div>
            ))}
            <DropZone slot={{ parentId: block.id, col: c, index: col.length }} onDrop={onDrop} nested compact />
            <AddInto items={items} column={c} onAdd={(key) => ops.addInto(block.id, c, key)} compact />
          </div>
        ))}
      </div>
    )
    : (
      <div className="px-3 pb-3 grid gap-2" style={{ gridTemplateColumns: `repeat(${cols.length}, minmax(0, 1fr))` }}>
        {cols.map((col, c) => (
          <div key={c} className="rounded-lg border border-dashed border-s-border bg-s-bg/60 p-1.5 min-h-[72px]">
            <p className="text-[10px] uppercase tracking-wider text-s-dim px-1">Column {c + 1}</p>
            {col.map((child, j) => (
              <div key={child.id}>
                <DropZone slot={{ parentId: block.id, col: c, index: j }} onDrop={onDrop} nested />
                <ElementCard block={child} first={j === 0} last={j === col.length - 1} nested
                  view={view} ops={ops} onDrop={onDrop} items={items} />
              </div>
            ))}
            <DropZone slot={{ parentId: block.id, col: c, index: col.length }} onDrop={onDrop} nested />
            <AddInto items={items} column={c} onAdd={(key) => ops.addInto(block.id, c, key)} />
          </div>
        ))}
      </div>
    ))

  const frame = `border bg-s-surface transition-colors cursor-pointer ${
    selected ? 'border-s-teal ring-1 ring-s-teal/40'
      : hovered ? 'border-s-indigo/60 ring-1 ring-s-indigo/30'
        : 'border-s-border hover:border-s-border-strong'
  } ${block.hidden ? 'opacity-50' : ''}`

  if (compact) {
    return (
      <div
        data-layer-id={block.id}
        draggable
        onDragStart={(e) => startDrag(e, { source: 'canvas', id: block.id, type: block.type })}
        onDragEnd={endDrag}
        onClick={(e) => { e.stopPropagation(); ops.select(block.id) }}
        className={`rounded-lg ${frame}`}
      >
        <div className="group relative flex items-center gap-1.5 px-1.5 py-1 min-h-[30px]" title={summary || undefined}
          onMouseEnter={() => ops.hover(block.id)} onMouseLeave={() => ops.hover(null)}>
          <GripVertical size={12} className="text-s-dim shrink-0 cursor-grab" aria-hidden />
          <span className="w-8 shrink-0 text-center rounded bg-s-bg-soft text-[9px] font-bold text-s-muted py-0.5">{spec?.icon ?? '?'}</span>
          <span className="flex-1 min-w-0 flex items-baseline gap-1.5">
            <span className="text-xs font-semibold text-s-text truncate">{spec?.label ?? block.type}</span>
            <span className="flex items-baseline gap-1.5 shrink-0">{badges}</span>
          </span>
          {!selected && (
            <div className="absolute right-0.5 top-1/2 -translate-y-1/2 rounded-md bg-s-surface shadow-card opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto">
              {actions}
            </div>
          )}
        </div>
        {selected && <div className="flex justify-end border-t border-s-border px-1 py-0.5">{actions}</div>}
        {columns}
      </div>
    )
  }

  return (
    <div
      data-layer-id={block.id}
      draggable
      onDragStart={(e) => startDrag(e, { source: 'canvas', id: block.id, type: block.type })}
      onDragEnd={endDrag}
      onClick={(e) => { e.stopPropagation(); ops.select(block.id) }}
      className={`rounded-xl ${frame}`}
    >
      <div className={`flex items-center gap-2 ${nested ? 'p-2' : 'p-3'}`} onMouseEnter={() => ops.hover(block.id)} onMouseLeave={() => ops.hover(null)}>
        <GripVertical size={14} className="text-s-dim shrink-0 cursor-grab" aria-hidden />
        <span className="w-9 shrink-0 text-center rounded bg-s-bg-soft text-[10px] font-bold text-s-muted py-0.5">{spec?.icon ?? '?'}</span>
        <div className="flex-1 min-w-0">
          <p className={`${nested ? 'text-xs' : 'text-sm'} font-semibold text-s-text truncate flex items-baseline gap-2`}>
            <span className="truncate">{spec?.label ?? block.type}</span>
            {badges}
          </p>
          {!nested && <p className="text-[11px] text-s-muted truncate">{summary}</p>}
        </div>
        {actions}
      </div>
      {columns}
    </div>
  )
}

function AddInto({ items, column, onAdd, compact }: { items: PaletteItem[]; column: number; onAdd: (key: string) => void; compact?: boolean }) {
  return (
    <Select value="" onClick={(e) => e.stopPropagation()}
      onChange={(e) => { if (e.target.value) onAdd(e.target.value) }}
      className={`s-select ${compact ? 'text-[10px] py-0.5' : 'text-[11px] py-1'} mt-1`} aria-label={`Add element to column ${column + 1}`}>
      <option value="">+ Add element</option>
      {items.filter((s) => canNest(s.key)).map((s) => (
        <option key={s.key} value={s.key}>{s.label}</option>
      ))}
    </Select>
  )
}
