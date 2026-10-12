'use client'
// Physical count — periodic spot-check. Manager picks items, enters physical
// quantity, system shows variance vs DB. Variance > 2% fires shrinkage flag.
// Inventory is auto-adjusted to physical truth on submit.
//
// This is the ONLY way to set stock on hand by hand (owner decision 28): the
// Inventory page's +/- and bulk "set to" are gone, and every change comes from
// a count (this page, which keeps the PhysicalCount record), a waste log or a
// delivery. Opening stock for a new item is its first count.

import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../../lib/api'
import { useStockActions } from '../kitchenView'

interface InventoryItem { id: string; name: string; unit: string; currentStock: number }
interface DraftLine { inventoryItemId: string; physicalQty: number | ''; reason: string }

export default function PhysicalCountPage() {
  const qc = useQueryClient()
  // Counting is managers + boh (POST /crosschecks/physical-counts). Anyone
  // else who opens this page by URL reads stock but gets no submit button.
  const { canCount } = useStockActions()
  const { data: items = [] } = useQuery<InventoryItem[]>({ queryKey: ['inventory'], queryFn: () => api.get('/inventory') })
  const [search, setSearch] = useState('')
  const [lines, setLines] = useState<Record<string, DraftLine>>({})
  const [notes, setNotes] = useState('')
  const [feedback, setFeedback] = useState<string | null>(null)

  // /inventory/count?item=<id> — opened from an item's "count" link.
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('item')
    const it = id ? items.find((i) => i.id === id) : undefined
    if (it) setSearch(it.name)
  }, [items])

  const submit = useMutation({
    mutationFn: () => api.post('/crosschecks/physical-counts', {
      lines: Object.values(lines)
        .filter((l) => l.physicalQty !== '')
        .map((l) => ({
          inventoryItemId: l.inventoryItemId,
          physicalQty: +l.physicalQty,
          reason: l.reason || null,
        })),
      notes: notes || null,
    }),
    onSuccess: (res: unknown) => {
      qc.invalidateQueries({ queryKey: ['inventory'] })
      qc.invalidateQueries({ queryKey: ['exceptions'] })
      const r = res as { lines: { variancePct: number | null }[] }
      const flagged = r.lines.filter((l) => l.variancePct != null && Math.abs(l.variancePct) > 0.02).length
      setFeedback(flagged > 0 ? `⚠️ Count saved — ${flagged} item${flagged === 1 ? '' : 's'} flagged for shrinkage.` : '✓ Count saved, inventory aligned to physical.')
      setLines({}); setNotes('')
      setTimeout(() => setFeedback(null), 6000)
    },
  })

  const filtered = items.filter((i) => i.name.toLowerCase().includes(search.toLowerCase()))

  function setQty(item: InventoryItem, qty: number | '') {
    setLines((prev) => ({ ...prev, [item.id]: { inventoryItemId: item.id, physicalQty: qty, reason: prev[item.id]?.reason ?? '' } }))
  }
  function setReason(item: InventoryItem, reason: string) {
    setLines((prev) => ({ ...prev, [item.id]: prev[item.id] ? { ...prev[item.id]!, reason } : { inventoryItemId: item.id, physicalQty: '', reason } }))
  }

  const lineCount = Object.values(lines).filter((l) => l.physicalQty !== '').length

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <header className="px-7 py-6 border-b border-white/[0.05]">
        <Link href="/inventory" className="text-xs text-white/40 hover:text-white/70">← Inventory</Link>
        <h1 className="text-2xl font-black text-white/90 mt-2">📋 Physical count</h1>
        <p className="text-sm text-white/40 mt-1 max-w-2xl">
          Spot-count any number of items. System shows variance vs current stock; saving aligns DB to physical. &gt; 2% variance flags for review.
        </p>
      </header>

      <div className="px-7 py-6 max-w-4xl mx-auto space-y-5">
        {feedback && (
          <div className="rounded-xl px-4 py-3 text-sm font-bold"
            style={{
              background: feedback.startsWith('⚠') ? 'rgba(245,158,11,0.1)' : 'rgb(135 197 64 / 0.1)',
              color: feedback.startsWith('⚠') ? '#a15c00' : 'var(--erp-primary-ink)',
              border: `1px solid ${feedback.startsWith('⚠') ? 'rgba(245,158,11,0.3)' : 'rgb(135 197 64 / 0.3)'}`,
            }}>{feedback}</div>
        )}

        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search items…"
          className="w-full rounded-xl bg-white/[0.04] border border-white/[0.08] px-4 py-3 text-sm text-white/85 focus:border-primary focus:outline-none" />

        <div className="rounded-2xl overflow-hidden" style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
          {filtered.length === 0 && <p className="p-5 text-xs text-white/35 italic">No items match.</p>}
          {filtered.map((item) => {
            const line = lines[item.id]
            const physical = line && line.physicalQty !== '' ? +line.physicalQty : null
            const variance = physical != null && item.currentStock > 0 ? ((physical - item.currentStock) / item.currentStock) * 100 : null
            const flag = variance != null && Math.abs(variance) > 2

            return (
              <div key={item.id} className="px-4 py-3 border-b border-white/[0.04] last:border-b-0 hover:bg-white/[0.015]">
                <div className="grid grid-cols-[1fr_100px_120px_120px] gap-3 items-center">
                  <div>
                    <p className="text-sm font-bold text-white/85">{item.name}</p>
                    <p className="text-xs text-white/45 font-mono">System: {item.currentStock} {item.unit}</p>
                  </div>
                  <input type="number" step="0.01" value={line?.physicalQty ?? ''}
                    onChange={(e) => setQty(item, e.target.value === '' ? '' : parseFloat(e.target.value))}
                    placeholder="Counted"
                    className="rounded-lg bg-white/[0.04] border border-white/[0.08] px-3 py-2 text-sm text-white/85 focus:border-primary focus:outline-none" />
                  <span className="text-xs font-bold" style={{ color: variance == null ? 'rgb(var(--fg-rgb) / 0.3)' : flag ? '#a15c00' : 'var(--erp-primary-ink)' }}>
                    {variance != null ? `${variance > 0 ? '+' : ''}${variance.toFixed(1)}%` : '—'}
                    {flag && <span className="ml-1">⚠</span>}
                  </span>
                  {flag ? (
                    <input value={line?.reason ?? ''} onChange={(e) => setReason(item, e.target.value)}
                      placeholder="Reason (optional)"
                      className="rounded-lg bg-white/[0.04] border border-white/[0.08] px-3 py-2 text-xs text-white/85" />
                  ) : <span />}
                </div>
              </div>
            )
          })}
        </div>

        <div>
          <label className="text-xs text-white/55">Count notes</label>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="Spot-check Friday morning, line cooks present, freezer #2 inspected." className="w-full rounded-lg bg-white/[0.03] border border-white/[0.08] px-3 py-2 text-sm text-white/85 mt-1 focus:border-primary focus:outline-none" />
        </div>

        {submit.error && <div className="rounded-xl px-4 py-3 text-sm text-red-700" style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)' }}>Save failed: {(submit.error as Error).message}</div>}

        {!canCount && (
          <p className="text-xs text-white/45">Stock counts are taken by the kitchen and its managers. You can read stock here, but not submit a count.</p>
        )}
        <div className="flex justify-end pt-2">
          {canCount && <button onClick={() => submit.mutate()} disabled={submit.isPending || lineCount === 0}
            className="rounded-xl bg-primary px-6 py-3 text-sm font-black text-primary-on hover:opacity-90 disabled:opacity-50">
            {submit.isPending ? 'Saving…' : `Submit count (${lineCount} item${lineCount === 1 ? '' : 's'}) →`}
          </button>}
        </div>
      </div>
    </div>
  )
}
