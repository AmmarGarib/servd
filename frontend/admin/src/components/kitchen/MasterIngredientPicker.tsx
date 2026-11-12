'use client'
// Picks an ingredient from servd's ONE ingredient master (owner, 2026-10-26 — kitchen flow K1–K3).
//
// Server-side search (GET /ingredient-master?q=), never the full list. Picking one makes sure the ACTIVE company has
// its stock item (POST /inventory/from-master — the master's unit, category, allergens, yield and buying unit fill
// it, K3) and hands that item back. "Add new ingredient" puts a name that is not there yet into servd's master at
// once, flagged for review (K2), then does the same. Prices are servd's (Operations → Ingredients); supplier and par stay the company's.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
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
  pieceGrams?: number | null
  pieceLabel?: string | null
  spec: string | null
  specFields: Record<string, string> | null
  status: 'approved' | 'needs_review'
  companyItemId: string | null
  /** Item group under the category (owner, 2026-11-07: Sea food, Meat, …). */
  groupId?: string | null
  group?: { id: string; name: string; category: string } | null
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

export interface IngredientGroup { id: string; name: string; category: string; active: boolean; ingredients?: number }

const categoryLabel = (c: string) => INVENTORY_CATEGORY_OPTIONS.find((o) => o.value === c)?.label ?? c.replace(/_/g, ' ')

export interface PickedItem { id: string; name: string; unit: string; category: string | null; yieldPct: number; masterIngredientId: string }

const UNITS = ['g', 'ml', 'pcs', 'kg', 'litres', 'each']
/** servd prices are per kg / litre / pcs whatever the stock unit (lib/ingredientPrices.ts). */
const priceUnitOf = (u: string) => (u === 'g' || u === 'kg' ? 'kg' : u === 'ml' || u === 'litres' ? 'litre' : 'pcs')
const inputCls = 'rounded-md border border-s-border bg-s-bg px-2 py-1 text-sm text-s-text focus:border-primary focus:outline-none'

export function MasterIngredientPicker({ label, onPicked, className = '', tenantId }: {
  /** What the control shows while closed (the line's current ingredient). */
  label: string
  /** `price` = servd's price of the picked ingredient (per kg / litre / pcs), when the search row carried one. */
  onPicked: (item: PickedItem, price?: MasterPrice | null) => void
  className?: string
  /** The company the stock item must be in (e.g. a PO's supplier's company); default the active company. */
  tenantId?: string | null
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [debounced, setDebounced] = useState('')
  const [adding, setAdding] = useState<{ unit: string; category: string; price: string; groupId: string; newGroup: string | null } | null>(null)
  // Browse by group (owner, 2026-11-07: "Sea food will contain all types of fish").
  const [groupFilter, setGroupFilter] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const btn = useRef<HTMLInputElement>(null)
  const closeMenu = useCallback(() => setOpen(false), [])

  useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 150); return () => clearTimeout(t) }, [q])

  // No lag while typing (owner, 2026-11-12): the last answer stays on screen while the next one loads, narrowed at
  // once to what is typed now, so the list never blanks between keystrokes.
  const { data: fetched = [], isFetching } = useQuery<MasterRow[]>({
    queryKey: ['ingredient-master', 'search', debounced, groupFilter],
    queryFn: ({ signal }) => api.get<MasterRow[]>(`/ingredient-master?q=${encodeURIComponent(debounced)}&limit=${groupFilter ? 200 : 25}${groupFilter ? `&groupId=${encodeURIComponent(groupFilter)}` : ''}`, { signal }),
    enabled: open,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  })
  const typed = q.trim().toLowerCase().replace(/\s+/g, ' ')
  const rows = typed && typed !== debounced.toLowerCase().replace(/\s+/g, ' ')
    ? fetched.filter((r) => r.name.toLowerCase().replace(/\s+/g, ' ').includes(typed))
    : fetched
  const { data: groups = [], refetch: refetchGroups } = useQuery<IngredientGroup[]>({
    queryKey: ['ingredient-master', 'groups'],
    queryFn: () => api.get<IngredientGroup[]>('/ingredient-master/groups'),
    enabled: open,
    staleTime: 60_000,
  })
  const groupsByCategory = INVENTORY_CATEGORY_OPTIONS
    .map((o) => ({ ...o, groups: groups.filter((g) => g.category === o.value) }))
    .filter((c) => c.groups.length > 0)

  async function pick(masterId: string, typedPrice?: MasterPrice | null) {
    setBusy(true); setErr('')
    try {
      const item = await api.post<PickedItem & { masterIngredientId: string }>('/inventory/from-master', { masterIngredientId: masterId }, tenantId ? { tenantId } : undefined)
      onPicked(item, typedPrice ?? rows.find((r) => r.id === masterId)?.price ?? null)
      setOpen(false); setQ(''); setAdding(null)
    } catch (e) {
      setErr(stockErrorText(e))
    } finally { setBusy(false) }
  }

  async function addNew() {
    if (!adding || !q.trim()) return
    setBusy(true); setErr('')
    try {
      // A new group typed here is saved first (owner, 2026-11-07: "Give option to add categories to PO maker").
      let groupId = adding.groupId || null
      if (adding.newGroup !== null) {
        const name = adding.newGroup.trim()
        if (name.length < 2) { setErr('Type the new group\'s name'); setBusy(false); return }
        if (!adding.category) { setErr('Pick the category the new group sits under'); setBusy(false); return }
        const g = await api.post<IngredientGroup>('/ingredient-master/groups', { name, category: adding.category })
        groupId = g.id
        void refetchGroups()
      }
      const m = await api.post<MasterRow>('/ingredient-master', { name: q.trim(), unit: adding.unit, category: adding.category || null, ...(groupId ? { groupId } : {}) })
      // The price typed with it (owner, 2026-11-03: "Adding here should allow me to add price too") — servd's ONE
      // price, per kg / litre / pcs (PUT /ingredient-master/:id/price, the same as the Ingredients sheet).
      const price = Number(adding.price)
      if (adding.price.trim() && Number.isFinite(price) && price > 0) {
        await api.put(`/ingredient-master/${m.id}/price`, { priceCents: Math.round(price * 100) })
      }
      await pick(m.id, adding.price.trim() && Number.isFinite(price) && price > 0
        ? { displayUnit: priceUnitOf(adding.unit), latestCents: Math.round(price * 100), latestAt: null, latestSource: 'sheet', latestSupplier: null, latestCompany: null, averageCents: null, averageDays: 90, averageDeliveries: 0 }
        : null)
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
    else if (e.key === 'Enter') {
      e.preventDefault()
      const r = rows[active]
      if (open && r && !busy) void pick(r.id)
      // Nothing matches: Enter opens "Add new" so a typed item is saved, never lost (owner, 2026-11-07).
      else if (open && !r && q.trim() && !adding) setAdding({ unit: 'kg', category: '', price: '', groupId: groupFilter, newGroup: null })
    }
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
          {groupsByCategory.length > 0 && (
            <select value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)} aria-label="Group"
              onMouseDown={(e) => e.stopPropagation()} className={`${inputCls} mb-2 w-full`}>
              <option value="">All groups</option>
              {groupsByCategory.map((c) => (
                <optgroup key={c.value} label={c.label}>
                  {c.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </optgroup>
              ))}
              <option value="none">Not in a group</option>
            </select>
          )}
          <ul role="listbox" className="max-h-64 overflow-y-auto">
            {rows.map((r, i) => (
              <li key={r.id}>
                <button type="button" disabled={busy} onMouseDown={(e) => e.preventDefault()} onMouseEnter={() => setActive(i)} onClick={() => void pick(r.id)}
                  className={`flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-s-bg-soft disabled:opacity-50 ${i === active ? 'bg-s-bg-soft' : ''}`}>
                  <span className="truncate text-s-text">{r.name} <span className="text-xs text-s-muted">({r.stockUnit}{r.price?.latestCents != null ? ` · PKR ${(r.price.latestCents / 100).toLocaleString('en-PK')}/${r.price.displayUnit}` : ''}){r.group ? ` · ${r.group.name}` : ''}</span></span>
                  <span className="shrink-0 text-[11px] text-s-muted">
                    {r.status === 'needs_review' ? 'needs review' : r.companyItemId ? 'in stock list' : 'not stocked yet'}
                  </span>
                </button>
              </li>
            ))}
            {!isFetching && debounced === q.trim() && rows.length === 0 && <li className="px-2 py-1.5 text-xs text-s-muted">{q.trim() ? 'No ingredient by that name yet.' : 'Nothing in this group yet.'}</li>}
          </ul>
          {q.trim() && !exact && (
            <div className="mt-2 border-t border-s-border pt-2">
              {!adding ? (
                <button type="button" onClick={() => {
                  const g = groups.find((x) => x.id === groupFilter)
                  setAdding({ unit: 'kg', category: g?.category ?? '', price: '', groupId: g?.id ?? '', newGroup: null })
                }} className="text-xs font-semibold text-primary-ink hover:underline">
                  Add new ingredient &ldquo;{q.trim()}&rdquo;
                </button>
              ) : (
                <div className="space-y-2">
                  <p className="text-[11px] text-s-muted">Joins servd&rsquo;s ingredients now, marked for review.</p>
                  <div className="flex gap-2">
                    <select value={adding.unit} onChange={(e) => setAdding({ ...adding, unit: e.target.value })} className={inputCls} aria-label="Stock unit">
                      {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
                    </select>
                    <select value={adding.category} onChange={(e) => {
                      const category = e.target.value
                      const keep = groups.find((g) => g.id === adding.groupId)?.category === category
                      setAdding({ ...adding, category, groupId: keep ? adding.groupId : '' })
                    }} className={`${inputCls} flex-1`} aria-label="Category">
                      <option value="">Category…</option>
                      {INVENTORY_CATEGORY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </div>
                  <select value={adding.newGroup !== null ? '__new' : adding.groupId} aria-label="Group"
                    onChange={(e) => {
                      const v = e.target.value
                      if (v === '__new') { setAdding({ ...adding, groupId: '', newGroup: '' }); return }
                      const g = groups.find((x) => x.id === v)
                      setAdding({ ...adding, groupId: v, newGroup: null, category: g ? g.category : adding.category })
                    }} className={`${inputCls} w-full`}>
                    <option value="">Group (optional)…</option>
                    {groupsByCategory.filter((c) => !adding.category || c.value === adding.category).map((c) => (
                      <optgroup key={c.value} label={c.label}>
                        {c.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                      </optgroup>
                    ))}
                    <option value="__new">+ New group…</option>
                  </select>
                  {adding.newGroup !== null && (
                    <div className="space-y-1">
                      <input type="text" value={adding.newGroup} maxLength={60} placeholder="New group name, e.g. Sea food" aria-label="New group name"
                        onChange={(e) => setAdding({ ...adding, newGroup: e.target.value })} className={`${inputCls} w-full`} />
                      <p className="text-[11px] text-s-muted">{adding.category ? `Saved under ${categoryLabel(adding.category)} for everyone to use.` : 'Pick the category it sits under first.'}</p>
                    </div>
                  )}
                  <label className="flex items-center gap-2 text-xs text-s-muted">
                    <span className="shrink-0">Price PKR per {priceUnitOf(adding.unit)}</span>
                    <input type="text" inputMode="decimal" value={adding.price} placeholder="optional"
                      onChange={(e) => setAdding({ ...adding, price: e.target.value.replace(/[^0-9.]/g, '') })} className={`${inputCls} w-full min-w-0`} />
                  </label>
                  {Number(adding.price) > 0 && (
                    <p className="text-[11px] text-s-muted">Saves as PKR {Number(adding.price).toLocaleString('en-PK', { maximumFractionDigits: 2 })} per {priceUnitOf(adding.unit)}</p>
                  )}
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
