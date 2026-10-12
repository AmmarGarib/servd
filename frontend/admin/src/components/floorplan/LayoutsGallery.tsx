'use client'
// Layouts gallery — pre-built table arrangements the operator can drop on
// any floor. Each template is a static array of relative positions (for a
// 1200×800 canvas); the apply button calls /floors/:id/apply-layout.

import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { api } from '../../lib/api'

interface TableTemplate {
  label: string
  capacity: number
  shape: 'rectangle' | 'square' | 'round' | 'banquette' | 'counter'
  x: number
  y: number
  width?: number
  height?: number
  rotation?: number
  floorSection?: string
}

interface Layout {
  id: string
  name: string
  emoji: string
  description: string
  bestFor: string
  tables: TableTemplate[]
}

// 1200 × 800 canvas convention — matches Floor defaults.
const LAYOUTS: Layout[] = [
  {
    id: 'qsr-counter',
    name: 'QSR — Counter & 8-tops',
    emoji: '🍔',
    description: '8 four-tops in two rows + a counter strip',
    bestFor: 'Stax · Smash burger · Café',
    tables: [
      // 2 rows of 4 four-tops
      ...Array.from({ length: 4 }, (_, i) => ({
        label: `T${i + 1}`,    capacity: 4, shape: 'rectangle' as const,
        x: 80 + i * 240, y: 200, width: 160, height: 90,
      })),
      ...Array.from({ length: 4 }, (_, i) => ({
        label: `T${i + 5}`,    capacity: 4, shape: 'rectangle' as const,
        x: 80 + i * 240, y: 380, width: 160, height: 90,
      })),
      // Counter strip
      { label: 'C1', capacity: 1, shape: 'square', x: 100, y: 600, width: 60, height: 60, floorSection: 'counter' },
      { label: 'C2', capacity: 1, shape: 'square', x: 180, y: 600, width: 60, height: 60, floorSection: 'counter' },
      { label: 'C3', capacity: 1, shape: 'square', x: 260, y: 600, width: 60, height: 60, floorSection: 'counter' },
      { label: 'C4', capacity: 1, shape: 'square', x: 340, y: 600, width: 60, height: 60, floorSection: 'counter' },
    ],
  },
  {
    id: 'cafe-mixed',
    name: 'Café — Mixed seating',
    emoji: '☕',
    description: '6 round 2-tops, 3 four-tops, 4 high-tops',
    bestFor: 'Coffee · Bakery · Brunch',
    tables: [
      // 6 round 2-tops along the wall
      ...Array.from({ length: 6 }, (_, i) => ({
        label: `R${i + 1}`, capacity: 2, shape: 'round' as const,
        x: 100 + (i % 3) * 200, y: 100 + Math.floor(i / 3) * 180, width: 100, height: 100,
      })),
      // 3 four-tops
      ...Array.from({ length: 3 }, (_, i) => ({
        label: `T${i + 1}`, capacity: 4, shape: 'rectangle' as const,
        x: 750 + i * 0, y: 100 + i * 180, width: 180, height: 100,
      })),
      // 4 high-tops at bar
      ...Array.from({ length: 4 }, (_, i) => ({
        label: `H${i + 1}`, capacity: 2, shape: 'square' as const,
        x: 200 + i * 130, y: 620, width: 80, height: 80, floorSection: 'bar',
      })),
    ],
  },
  {
    id: 'fine-dining',
    name: 'Fine dining — 12 covers',
    emoji: '🍽',
    description: '8 four-tops + 4 two-tops, generously spaced',
    bestFor: 'Strata · Tasting menu · Anniversary spot',
    tables: [
      // 4 round 4-tops centre
      ...Array.from({ length: 4 }, (_, i) => ({
        label: `T${i + 1}`, capacity: 4, shape: 'round' as const,
        x: 200 + (i % 2) * 280, y: 100 + Math.floor(i / 2) * 220, width: 140, height: 140,
      })),
      // 4 round 4-tops right
      ...Array.from({ length: 4 }, (_, i) => ({
        label: `T${i + 5}`, capacity: 4, shape: 'round' as const,
        x: 800 + (i % 2) * 200, y: 100 + Math.floor(i / 2) * 220, width: 140, height: 140,
      })),
      // 4 intimate 2-tops along window
      ...Array.from({ length: 4 }, (_, i) => ({
        label: `W${i + 1}`, capacity: 2, shape: 'rectangle' as const,
        x: 80, y: 80 + i * 160, width: 80, height: 100, floorSection: 'window',
      })),
    ],
  },
  {
    id: 'cloud-kitchen',
    name: 'Cloud kitchen — Pickup only',
    emoji: '🛵',
    description: 'No seating · 4 pickup pickup-stations',
    bestFor: 'Delivery-only · Ghost kitchen · Own-fleet dispatch',
    tables: [
      ...Array.from({ length: 4 }, (_, i) => ({
        label: `P${i + 1}`, capacity: 0, shape: 'square' as const,
        x: 200 + i * 200, y: 350, width: 100, height: 100, floorSection: 'pickup',
      })),
    ],
  },
  {
    id: 'food-court',
    name: 'Food court — Communal',
    emoji: '🥡',
    description: '6 communal long tables + 4 stand-up bars',
    bestFor: 'Multi-brand kitchen · Mall location',
    tables: [
      ...Array.from({ length: 3 }, (_, i) => ({
        label: `L${i + 1}`, capacity: 8, shape: 'rectangle' as const,
        x: 150, y: 100 + i * 200, width: 400, height: 100, floorSection: 'communal',
      })),
      ...Array.from({ length: 3 }, (_, i) => ({
        label: `L${i + 4}`, capacity: 8, shape: 'rectangle' as const,
        x: 650, y: 100 + i * 200, width: 400, height: 100, floorSection: 'communal',
      })),
      ...Array.from({ length: 4 }, (_, i) => ({
        label: `B${i + 1}`, capacity: 2, shape: 'square' as const,
        x: 250 + i * 200, y: 720, width: 70, height: 70, floorSection: 'standup',
      })),
    ],
  },
  {
    id: 'mixed-dine-takeaway',
    name: 'Mixed — Dine-in + Takeaway',
    emoji: '🥡',
    description: '6 dine-in tables + 3 takeaway pickup spots',
    bestFor: 'QSR + dining · Hybrid concept',
    tables: [
      // Dine-in
      ...Array.from({ length: 6 }, (_, i) => ({
        label: `T${i + 1}`, capacity: 4, shape: 'rectangle' as const,
        x: 100 + (i % 3) * 220, y: 120 + Math.floor(i / 3) * 200, width: 160, height: 90,
      })),
      // Takeaway counter
      ...Array.from({ length: 3 }, (_, i) => ({
        label: `TA${i + 1}`, capacity: 0, shape: 'square' as const,
        x: 200 + i * 250, y: 600, width: 100, height: 80, floorSection: 'takeaway',
      })),
    ],
  },
]

interface Props {
  floorId: string
  hasExistingTables: boolean
  onClose: () => void
  onApplied: () => void
}

export function LayoutsGallery({ floorId, hasExistingTables, onClose, onApplied }: Props) {
  const [selected, setSelected] = useState<Layout | null>(null)
  const [clearExisting, setClearExisting] = useState(false)

  const apply = useMutation({
    mutationFn: (layout: Layout) => api.post(`/floors/${floorId}/apply-layout`, {
      clearExisting,
      tables: layout.tables,
    }),
    onSuccess: () => onApplied(),
  })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-secondary/50 p-4" onClick={onClose}>
      <div className="w-full max-w-4xl rounded-2xl overflow-hidden"
        style={{ background: 'var(--surface)', border: '1px solid rgb(var(--fg-rgb) / 0.08)' }} onClick={(e) => e.stopPropagation()}>

        <div className="flex items-center justify-between border-b border-white/[0.05] px-5 py-3">
          <div>
            <h2 className="font-black text-white/90 text-lg">Layout templates</h2>
            <p className="text-xs text-white/45">Drop a pre-built arrangement onto this floor. You can drag-and-edit afterward.</p>
          </div>
          <button onClick={onClose} className="text-white/40 text-xl">✕</button>
        </div>

        <div className="p-5 max-h-[70vh] overflow-y-auto">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {LAYOUTS.map((l) => (
              <button key={l.id} onClick={() => setSelected(l)}
                className="text-left rounded-xl p-4 transition-all"
                style={selected?.id === l.id
                  ? { background: 'rgb(var(--erp-primary-rgb) / 0.08)', border: '1px solid rgb(var(--erp-primary-rgb) / 0.4)' }
                  : { background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
                <div className="flex items-start justify-between gap-2">
                  <span className="text-3xl">{l.emoji}</span>
                  <span className="text-[10px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded"
                    style={{ background: 'rgb(var(--fg-rgb) / 0.04)', color: 'rgb(var(--fg-rgb) / 0.55)' }}>
                    {l.tables.length} tables
                  </span>
                </div>
                <p className="font-bold text-white/90 text-sm mt-2">{l.name}</p>
                <p className="text-[11px] text-white/55 mt-1 leading-relaxed">{l.description}</p>
                <p className="text-[10px] text-white/35 mt-2 italic">{l.bestFor}</p>
              </button>
            ))}
          </div>

          {selected && (
            <div className="mt-5 rounded-xl p-4"
              style={{ background: 'rgb(var(--erp-primary-rgb) / 0.05)', border: '1px solid rgb(var(--erp-primary-rgb) / 0.2)' }}>
              <p className="text-sm font-bold text-primary-ink">{selected.emoji} {selected.name}</p>
              <p className="text-xs text-white/65 mt-1">{selected.description}</p>

              {hasExistingTables && (
                <label className="flex items-center gap-2 mt-3 cursor-pointer">
                  <input type="checkbox" checked={clearExisting} onChange={(e) => setClearExisting(e.target.checked)} className="accent-primary" />
                  <span className="text-xs text-white/85">
                    Clear existing tables on this floor first
                    <span className="text-amber-700/80 ml-1">⚠ destructive</span>
                  </span>
                </label>
              )}

              {apply.error && (
                <p className="text-xs text-red-700 mt-3">{(apply.error as Error).message}</p>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-white/[0.05] p-4 bg-white/[0.01]">
          <button onClick={onClose} className="rounded-xl border border-white/10 px-4 py-2.5 text-sm text-white/55 hover:text-white">Cancel</button>
          <button onClick={() => selected && apply.mutate(selected)}
            disabled={!selected || apply.isPending}
            className="rounded-xl bg-primary px-5 py-2.5 text-sm font-black text-primary-on hover:opacity-90 disabled:opacity-50">
            {apply.isPending ? 'Applying…' : selected ? `Apply layout (${selected.tables.length} tables)` : 'Pick a layout'}
          </button>
        </div>
      </div>
    </div>
  )
}
