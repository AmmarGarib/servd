'use client'
// Picks an ingredient from servd's ONE ingredient master (owner, 2026-10-26 — kitchen flow K1–K3).
//
// Server-side search (GET /ingredient-master?q=), never the full list. Picking one makes sure the ACTIVE company has
// its stock item (POST /inventory/from-master — the master's unit, category, allergens, yield and buying unit fill
// it, K3) and hands that item back. "Add new ingredient" puts a name that is not there yet into servd's master at
// once, flagged for review (K2), then does the same. Prices are servd's (Operations → Ingredients); supplier and par stay the company's.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { INVENTORY_CATEGORY_OPTIONS } from '../../lib/stockUi'
import { stockErrorText } from '../../lib/stockUi'
import { AnchoredMenu } from '../ui/AnchoredMenu'

export interface MasterRow {
  id: string
  name: string
  stockUnit: string
  category: string | null
  allergens: string[]
  yieldPct: number
  purchaseUnit: string | null
  purchaseUnitFactor: number
  /** Use-by (owner B6, 2026-10-26): deliveries carry a use-by date; shelf life (days) defaults it. */
  perishable?: boolean
  shelfLifeDays?: number | null
  spec: string | null
  specFields: Record<string, string> | null
  status: 'approved' | 'needs_review'
  companyItemId: string | null
  /** servd's price (owner, 2026-10-29): one price across servd, per kg / litre / pcs. Null when hidden (kitchen floor). */
  price?: MasterPrice | null
}

export interface MasterPrice {
  displayUnit: string
  latestCents: number | null
  latestAt: string | null
  latestSource: 'delivery' | 'sheet' | 'bill' | 'manual' | 'estimate' | null
  latestSupplier: string | null
  latestCompany: string | null
  averageCents: number | null
  averageDays: number
  averageDeliveries: number
}

export interface PickedItem { id: string; name: string; unit: string; category: string | null; yieldPct: number; masterIngredientId: string }

const UNITS = ['g', 'ml', 'pcs', 'kg', 'litres', 'each']
const inputCls = 'rounded-md border border-s-border bg-s-bg px-2 py-1 text-sm text-s-text focus:border-primary focus:outline-none'

export function MasterIngredientPicker({ label, onPicked, className = '' }: {
  /** What the control shows while closed (the line's current ingredient). */
  label: string
  onPicked: (item: PickedItem) => void
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [debounced, setDebounced] = useState('')
  const [adding, setAdding] = useState<{ unit: string; category: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const btn = useRef<HTMLInputElement>(null)
  const closeMenu = useCallback(() => setOpen(false), [])

  useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 200); return () => clearTimeout(t) }, [q])

  const { data: rows = [], isFetching } = useQuery<MasterRow[]>({
    queryKey: ['ingredient-master', 'search', debounced],
    queryFn: () => api.get<MasterRow[]>(`/ingredient-master?q=${encodeURIComponent(debounced)}&limit=25`),
    enabled: open,
    staleTime: 30_000,
  })

  async function pick(masterId: string) {
    setBusy(true); setErr('')
    try {
      const item = await api.post<PickedItem & { masterIngredientId: string }>('/inventory/from-master', { masterIngredientId: masterId })
      onPicked(item)
      setOpen(false); setQ(''); setAdding(null)
    } catch (e) {
      setErr(stockErrorText(e))
    } finally { setBusy(false) }
  }

  async function addNew() {
    if (!adding || !q.trim()) return
    setBusy(true); setErr('')
    try {
      const m = await api.post<MasterRow>('/ingredient-master', { name: q.trim(), unit: adding.unit, category: adding.category || null })
      await pick(m.id)
    } catch (e) {
      setErr(stockErrorText(e)); setBusy(false)
    }
  }

  const exact = rows.some((r) => r.name.trim().toLowerCase() === q.trim().toLowerCase())

  // Type straight into the field (owner, 2026-10-27): matches drop down under it; Enter picks the first,
  // arrows move, Escape closes. The closed field shows the line's current ingredient.
  const [active, setActive] = useState(0)
  useEffect(() => { setActive(0) }, [debounced])
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive((a) => Math.min(a + 1, Math.max(rows.length - 1, 0))) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); const r = rows[active]; if (open && r && !busy) void pick(r.id) }
    else if (e.key === 'Escape') { setOpen(false); setQ('') }
  }

  return (
    <div className={`relative ${className}`}>
      <input ref={btn} value={open ? q : label} placeholder="Type an ingredient…" aria-label="Ingredient"
        role="combobox" aria-expanded={open} aria-autocomplete="list"
        onFocus={() => { setOpen(true); setQ('') }}
        onChange={(e) => { setQ(e.target.value); setAdding(null); setOpen(true) }}
        onKeyDown={onKey}
        className={`${inputCls} w-full truncate`} />
      <AnchoredMenu anchor={btn} open={open} onClose={closeMenu} align="start" minWidth={352} role="group" maxHeight={480} className="!bg-s-bg !p-2">
        <div>
          <ul role="listbox" className="max-h-64 overflow-y-auto">
            {rows.map((r, i) => (
              <li key={r.id}>
                <button type="button" disabled={busy} onMouseDown={(e) => e.preventDefault()} onMouseEnter={() => setActive(i)} onClick={() => void pick(r.id)}
                  className={`flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-s-bg-soft disabled:opacity-50 ${i === active ? 'bg-s-bg-soft' : ''}`}>
                  <span className="truncate text-s-text">{r.name} <span className="text-xs text-s-muted">({r.stockUnit})</span></span>
                  <span className="shrink-0 text-[11px] text-s-muted">
                    {r.status === 'needs_review' ? 'needs review' : r.companyItemId ? 'in stock list' : 'not stocked yet'}
                  </span>
                </button>
              </li>
            ))}
            {!isFetching && rows.length === 0 && <li className="px-2 py-1.5 text-xs text-s-muted">No ingredient by that name yet.</li>}
          </ul>
          {q.trim() && !exact && (
            <div className="mt-2 border-t border-s-border pt-2">
              {!adding ? (
                <button type="button" onClick={() => setAdding({ unit: 'kg', category: '' })} className="text-xs font-semibold text-primary-ink hover:underline">
                  Add new ingredient &ldquo;{q.trim()}&rdquo;
                </button>
              ) : (
                <div className="space-y-2">
                  <p className="text-[11px] text-s-muted">Joins servd&rsquo;s ingredients now, marked for review.</p>
                  <div className="flex gap-2">
                    <select value={adding.unit} onChange={(e) => setAdding({ ...adding, unit: e.target.value })} className={inputCls} aria-label="Stock unit">
                      {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                    </select>
                    <select value={adding.category} onChange={(e) => setAdding({ ...adding, category: e.target.value })} className={`${inputCls} flex-1`} aria-label="Category">
                      <option value="">Category…</option>
                      {INVENTORY_CATEGORY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </div>
                  <button type="button" disabled={busy} onClick={() => void addNew()} className="s-btn-primary px-3 py-1 text-xs font-bold disabled:opacity-50">Add and use</button>
                </div>
              )}
            </div>
          )}
          {err && <p role="alert" className="mt-2 text-xs text-s-red">{err}</p>}
        </div>
      </AnchoredMenu>
    </div>
  )
}
