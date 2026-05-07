'use client'

// Block-based page editor.
//
// Layout:
//   ┌────────────────────────┬──────────────────┐
//   │ block list (reorder    │ inspector form   │
//   │ + add block button)    │ for selected     │
//   │                        │ block            │
//   └────────────────────────┴──────────────────┘
//
// Save → PUT /site-layouts/:slug. Reset → DELETE.

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { api } from '../../../lib/api'
import { BLOCK_CATALOG, newBlock, type Block, type BlockType } from '../../../lib/blocks'
import { BlockInspector } from './BlockInspector'

interface Layout { slug: string; title: string | null; blocks: Block[] | null; publishedAt: string | null; updatedAt: string | null }

const STORE_FRONT_URL = process.env['NEXT_PUBLIC_STOREFRONT_URL'] ?? 'http://localhost:3002'

export default function ContentEditorPage() {
  const { slug: rawSlug } = useParams<{ slug: string }>()
  const slug = decodeURIComponent(rawSlug)
  const qc = useQueryClient()

  const { data, isLoading } = useQuery({
    queryKey: ['site-layout', slug],
    queryFn: () => api.get<Layout>(`/site-layouts/${encodeURIComponent(slug)}`),
  })

  const [blocks, setBlocks] = useState<Block[] | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showPalette, setShowPalette] = useState(false)
  const [paletteAfter, setPaletteAfter] = useState<number | null>(null)
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(null)
  const [dirty, setDirty] = useState(false)

  // Load blocks from server (or empty array)
  useEffect(() => {
    if (!data) return
    setBlocks(data.blocks ?? [])
  }, [data])

  const save = useMutation({
    mutationFn: () => api.put(`/site-layouts/${encodeURIComponent(slug)}`, { blocks: blocks ?? [], title: data?.title ?? slug }),
    onSuccess: () => {
      setDirty(false)
      setFeedback({ ok: true, msg: 'Saved. Storefront refreshes within 30s.' })
      void qc.invalidateQueries({ queryKey: ['site-layout', slug] })
      setTimeout(() => setFeedback(null), 3500)
    },
    onError: (e: { message?: string }) => setFeedback({ ok: false, msg: e.message ?? 'Save failed' }),
  })

  const reset = useMutation({
    mutationFn: () => api.delete(`/site-layouts/${encodeURIComponent(slug)}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['site-layout', slug] })
      setBlocks([])
      setDirty(false)
      setFeedback({ ok: true, msg: 'Reset to default. Storefront will use built-in layout.' })
    },
  })

  function patch(blocks: Block[]) {
    setBlocks(blocks)
    setDirty(true)
  }
  const addAt = (type: BlockType, at: number) => {
    if (!blocks) return
    const b = newBlock(type)
    const next = [...blocks]
    next.splice(at, 0, b)
    patch(next)
    setSelectedId(b.id)
    setShowPalette(false)
    setPaletteAfter(null)
  }
  const remove = (id: string) => {
    if (!blocks) return
    patch(blocks.filter((b) => b.id !== id))
    if (selectedId === id) setSelectedId(null)
  }
  const duplicate = (id: string) => {
    if (!blocks) return
    const idx = blocks.findIndex((b) => b.id === id)
    if (idx < 0) return
    const original = blocks[idx]!
    const copy = { ...original, id: Math.random().toString(36).slice(2) + Date.now().toString(36) }
    const next = [...blocks]
    next.splice(idx + 1, 0, copy)
    patch(next)
  }
  const move = (id: string, delta: -1 | 1) => {
    if (!blocks) return
    const idx = blocks.findIndex((b) => b.id === id)
    if (idx < 0) return
    const target = idx + delta
    if (target < 0 || target >= blocks.length) return
    const next = [...blocks]
    const [removed] = next.splice(idx, 1)
    next.splice(target, 0, removed!)
    patch(next)
  }
  const updateBlock = (next: Block) => {
    if (!blocks) return
    patch(blocks.map((b) => b.id === next.id ? next : b))
  }

  const selected = (blocks ?? []).find((b) => b.id === selectedId) ?? null

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-20 bg-s-bg/95 backdrop-blur border-b border-s-border px-6 py-4 flex items-center justify-between gap-3 flex-wrap">
        <div>
          <Link href="/content" className="text-xs text-s-muted hover:text-s-text">← All pages</Link>
          <h1 className="text-lg font-bold text-s-text">{data?.title ?? slug}</h1>
          <p className="text-xs text-s-muted font-mono">{slug}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {feedback && (
            <span className={`text-xs ${feedback.ok ? 'text-s-teal' : 'text-s-red'}`}>{feedback.msg}</span>
          )}
          <a target="_blank" rel="noopener noreferrer" href={previewUrl(slug)} className="s-btn-secondary text-xs">
            Preview ↗
          </a>
          <button onClick={() => { if (confirm('Reset to defaults? Custom blocks for this page will be deleted.')) reset.mutate() }} className="s-btn-secondary text-xs">
            Reset
          </button>
          <button onClick={() => save.mutate()} disabled={!dirty || save.isPending} className="s-btn-primary text-xs">
            {save.isPending ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
          </button>
        </div>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_400px] gap-4 p-6 max-w-7xl">
        {/* Block list */}
        <div className="space-y-2">
          {isLoading && <p className="text-xs text-s-muted">Loading…</p>}
          {(blocks ?? []).length === 0 && !isLoading && (
            <div className="s-card p-6 text-center">
              <p className="text-sm text-s-muted mb-3">No blocks yet — using built-in defaults on storefront.</p>
              <button onClick={() => { setShowPalette(true); setPaletteAfter(0) }} className="s-btn-primary text-sm">
                + Start building
              </button>
            </div>
          )}
          {(blocks ?? []).map((b, i) => (
            <BlockRow
              key={b.id}
              block={b}
              isFirst={i === 0}
              isLast={i === (blocks ?? []).length - 1}
              isSelected={selectedId === b.id}
              onSelect={() => setSelectedId(b.id)}
              onUp={() => move(b.id, -1)}
              onDown={() => move(b.id, 1)}
              onDuplicate={() => duplicate(b.id)}
              onRemove={() => remove(b.id)}
              onAddAfter={() => { setShowPalette(true); setPaletteAfter(i + 1) }}
              onToggleHidden={() => updateBlock({ ...b, hidden: !b.hidden })}
            />
          ))}
          {(blocks ?? []).length > 0 && (
            <button onClick={() => { setShowPalette(true); setPaletteAfter((blocks ?? []).length) }}
              className="w-full p-3 rounded-lg border border-dashed border-s-border text-s-muted text-xs hover:bg-s-bg-soft">
              + Add block at end
            </button>
          )}
        </div>

        {/* Inspector */}
        <aside>
          {selected ? (
            <div className="s-card overflow-hidden sticky top-24">
              <BlockInspector block={selected} onChange={updateBlock} />
            </div>
          ) : (
            <div className="s-card p-6 text-center text-sm text-s-muted sticky top-24">
              Select a block to edit its content.
            </div>
          )}
        </aside>
      </div>

      {showPalette && paletteAfter !== null && (
        <BlockPalette onPick={(t) => addAt(t, paletteAfter)} onClose={() => { setShowPalette(false); setPaletteAfter(null) }} />
      )}
    </div>
  )
}

function previewUrl(slug: string): string {
  if (slug === 'servd:home') return `${STORE_FRONT_URL}/`
  if (slug.startsWith('brand:')) return `${STORE_FRONT_URL}/brand/${slug.slice('brand:'.length)}`
  return STORE_FRONT_URL
}

// ── Block row in the list ─────────────────────────────────────────────────

function BlockRow({
  block, isFirst, isLast, isSelected,
  onSelect, onUp, onDown, onDuplicate, onRemove, onAddAfter, onToggleHidden,
}: {
  block: Block
  isFirst: boolean
  isLast: boolean
  isSelected: boolean
  onSelect: () => void
  onUp: () => void; onDown: () => void
  onDuplicate: () => void; onRemove: () => void
  onAddAfter: () => void
  onToggleHidden: () => void
}) {
  const spec = BLOCK_CATALOG.find((s) => s.type === block.type)
  return (
    <div className="space-y-1.5">
      <div
        onClick={onSelect}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onSelect() }}
        className={`s-card flex items-center gap-3 p-3 transition-colors cursor-pointer ${
          isSelected ? 'border-s-teal bg-s-bg-soft' : 'hover:bg-s-bg-soft'
        }`}
        style={{ borderLeftWidth: isSelected ? 4 : 1, opacity: block.hidden ? 0.5 : 1 }}
      >
        <span className="text-2xl shrink-0">{spec?.icon ?? '◻'}</span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-s-text">{spec?.label ?? block.type}</p>
          <p className="text-[11px] text-s-muted truncate font-mono">{summary(block)}</p>
        </div>
        <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
          <button onClick={onUp} disabled={isFirst} aria-label="Move up" className="text-xs px-1.5 py-0.5 disabled:opacity-30 hover:bg-s-bg-soft rounded">↑</button>
          <button onClick={onDown} disabled={isLast} aria-label="Move down" className="text-xs px-1.5 py-0.5 disabled:opacity-30 hover:bg-s-bg-soft rounded">↓</button>
          <button onClick={onToggleHidden} aria-label="Toggle visibility" className="text-xs px-1.5 py-0.5 hover:bg-s-bg-soft rounded">{block.hidden ? '○' : '●'}</button>
          <button onClick={onDuplicate} aria-label="Duplicate" className="text-xs px-1.5 py-0.5 hover:bg-s-bg-soft rounded">⧉</button>
          <button onClick={onRemove} aria-label="Remove" className="text-xs px-1.5 py-0.5 text-s-red hover:bg-red-50 rounded">×</button>
        </div>
      </div>
      <button onClick={onAddAfter}
        className="block w-full p-2 rounded text-[11px] text-s-muted hover:bg-s-bg-soft transition-colors">
        + Add block here
      </button>
    </div>
  )
}

function summary(block: Block): string {
  switch (block.type) {
    case 'hero':         return String(block.title ?? '(no title)')
    case 'cta_button':   return `${block.text} → ${block.href}`
    case 'banner':       return String(block.title ?? '(no title)')
    case 'text':         return String(block.body ?? '').slice(0, 80)
    case 'image':        return String(block.url ?? '(no image)')
    case 'gallery':      return `${(block.images as unknown[] | undefined)?.length ?? 0} images`
    case 'stat_strip':   return `${(block.stats as unknown[] | undefined)?.length ?? 0} stats`
    case 'voices':       return `${(block.voices as unknown[] | undefined)?.length ?? 0} voices`
    case 'kitchens':     return String(block.title ?? 'Kitchens grid')
    case 'featured_menu':return String(block.title ?? 'Featured items')
    case 'reviews':      return `latest ${(block.max as number | undefined) ?? 6}`
    case 'quote':        return String(block.text ?? '').slice(0, 80)
    case 'spacer':       return `size: ${block.size}`
    case 'divider':      return '—'
    default:             return ''
  }
}

// ── Block palette modal ───────────────────────────────────────────────────

function BlockPalette({ onPick, onClose }: { onPick: (t: BlockType) => void; onClose: () => void }) {
  return (
    <div role="dialog" aria-modal="true" className="fixed inset-0 z-30 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl max-w-2xl w-full max-h-[80vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-s-border flex justify-between items-center">
          <h2 className="text-lg font-bold">Add a block</h2>
          <button onClick={onClose} aria-label="Close" className="text-2xl leading-none text-s-muted">×</button>
        </div>
        <div className="overflow-y-auto p-4 grid grid-cols-2 sm:grid-cols-3 gap-2">
          {BLOCK_CATALOG.map((spec) => (
            <button key={spec.type} onClick={() => onPick(spec.type)}
              className="s-card-hover p-4 text-left rounded-lg border border-s-border hover:bg-s-bg-soft transition-colors">
              <div className="text-2xl mb-2">{spec.icon}</div>
              <p className="font-bold text-s-text">{spec.label}</p>
              <p className="text-[11px] text-s-muted leading-snug">{spec.description}</p>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
