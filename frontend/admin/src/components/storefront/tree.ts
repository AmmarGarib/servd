// Pure helpers for the builder's element tree: a flat Block[] where a
// `columns` element holds Block[][] (one level deep; no columns in columns).

import { canNest, cloneBlock, columnsOf, type Block } from '../../lib/blocks'

/** Where an element sits / should go: top level (parentId null) or column `col` of a columns element. */
export interface Slot { parentId: string | null; col: number; index: number }

export function findBlock(blocks: Block[], id: string): Block | null {
  for (const b of blocks) {
    if (b.id === id) return b
    const cols = columnsOf(b)
    if (cols) for (const col of cols) for (const c of col) if (c.id === id) return c
  }
  return null
}

export function locate(blocks: Block[], id: string): Slot | null {
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!
    if (b.id === id) return { parentId: null, col: 0, index: i }
    const cols = columnsOf(b)
    if (cols) {
      for (let c = 0; c < cols.length; c++) {
        const j = cols[c]!.findIndex((x) => x.id === id)
        if (j >= 0) return { parentId: b.id, col: c, index: j }
      }
    }
  }
  return null
}

function containerLength(blocks: Block[], slot: Slot): number {
  if (slot.parentId === null) return blocks.length
  const parent = blocks.find((b) => b.id === slot.parentId)
  return parent ? columnsOf(parent)?.[slot.col]?.length ?? 0 : 0
}

export function updateBlock(blocks: Block[], next: Block): Block[] {
  return blocks.map((b) => {
    if (b.id === next.id) return next
    const cols = columnsOf(b)
    if (!cols) return b
    return { ...b, columns: cols.map((col) => col.map((c) => (c.id === next.id ? next : c))) }
  })
}

export function removeBlock(blocks: Block[], id: string): Block[] {
  return blocks.filter((b) => b.id !== id).map((b) => {
    const cols = columnsOf(b)
    if (!cols) return b
    return { ...b, columns: cols.map((col) => col.filter((c) => c.id !== id)) }
  })
}

/** Insert at a slot. Refuses (returns the input) when the element may not nest there. */
export function insertAt(blocks: Block[], slot: Slot, block: Block): Block[] {
  if (slot.parentId === null) {
    const next = [...blocks]
    next.splice(Math.max(0, Math.min(slot.index, next.length)), 0, block)
    return next
  }
  if (!canNest(block.type)) return blocks
  return blocks.map((b) => {
    if (b.id !== slot.parentId) return b
    const cols = columnsOf(b)
    if (!cols || !cols[slot.col]) return b
    const col = [...cols[slot.col]!]
    col.splice(Math.max(0, Math.min(slot.index, col.length)), 0, block)
    return { ...b, columns: cols.map((c, i) => (i === slot.col ? col : c)) }
  })
}

/** Move an element to a slot (drag and drop). */
export function moveTo(blocks: Block[], id: string, target: Slot): Block[] {
  const from = locate(blocks, id)
  const block = findBlock(blocks, id)
  if (!from || !block) return blocks
  if (target.parentId === id) return blocks                       // into itself
  if (target.parentId !== null && !canNest(block.type)) return blocks
  const t = { ...target }
  if (from.parentId === t.parentId && from.col === t.col && from.index < t.index) t.index -= 1
  if (from.parentId === t.parentId && from.col === t.col && from.index === t.index) return blocks
  return insertAt(removeBlock(blocks, id), t, block)
}

/** Up/down within the element's own container. */
export function nudge(blocks: Block[], id: string, delta: -1 | 1): Block[] {
  const from = locate(blocks, id)
  if (!from) return blocks
  const target = from.index + delta
  if (target < 0 || target >= containerLength(blocks, from)) return blocks
  // moveTo adjusts for the removal, so moving down means index + 2.
  return moveTo(blocks, id, { ...from, index: delta === 1 ? from.index + 2 : target })
}

/** Lift an element out of its columns parent, placing it right after the parent. */
export function moveOut(blocks: Block[], id: string): Block[] {
  const from = locate(blocks, id)
  if (!from || from.parentId === null) return blocks
  const parentIndex = blocks.findIndex((b) => b.id === from.parentId)
  return moveTo(blocks, id, { parentId: null, col: 0, index: parentIndex + 1 })
}

export function duplicate(blocks: Block[], id: string): { blocks: Block[]; newId: string | null } {
  const from = locate(blocks, id)
  const block = findBlock(blocks, id)
  if (!from || !block) return { blocks, newId: null }
  const copy = cloneBlock(block)
  return { blocks: insertAt(blocks, { ...from, index: from.index + 1 }, copy), newId: copy.id }
}

/** Change a columns element's column count, folding dropped columns into the last kept one. */
export function setColumnCount(block: Block, count: number): Block {
  const cols = columnsOf(block) ?? []
  const n = Math.max(2, Math.min(4, count))
  let next: Block[][]
  if (cols.length <= n) next = [...cols, ...Array.from({ length: n - cols.length }, () => [] as Block[])]
  else next = [...cols.slice(0, n - 1), cols.slice(n - 1).flat()]
  return { ...block, columns: next }
}
