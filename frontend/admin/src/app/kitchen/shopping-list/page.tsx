'use client'
// Shopping list (owner, 2026-10-26 — kitchen flow, part E): the raw stock the prep list and the forecast dishes need
// for the next day(s), minus this outlet's stock and what is already on order, by supplier — with each ingredient's
// SPEC (what we buy). "Create draft POs" makes one draft purchase order per supplier through procurement's own PO
// (they are then submitted, approved and sent there). GET /kitchen/shopping-list, POST …/draft-pos.
// Planned dishes (owner, 2026-11-13: "Can po auto pickup items from recipe?"): instead of expected sales, the kitchen
// types the dishes it means to make (dish × quantity) — same engine (recipes broken down, stock and orders taken off,
// by supplier). GET /kitchen/outlet-dishes for the picker; `plan=` on the list, `planned` on draft POs.
import { useState } from 'react'
import Link from 'next/link'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { stockErrorText } from '../../../lib/stockUi'
import { fmtUnitCost } from '../../../lib/unitCost'
import { CompactEmptyState } from '../../../components/ui/CompactEmptyState'
import { todayIso } from '../../../components/kitchen/useOutlet'
import { useActiveBranchId, useScopeBranches } from '../../../components/ui/BrandPicker'

interface Group {
  supplierId: string | null; supplierName: string; estimatedTotalCents: number | null
  lines: Array<{ inventoryItemId: string; name: string; unit: string; currentStock: number; onOrder: number; neededQty?: number; suggestedQty: number; unitCostCents: number | null; spec: string | null }>
}
interface NotStocked { masterIngredientId: string | null; name: string; unit: string; qty: number }
interface OutletOption { groupId: string; name: string; isRequired: boolean; choices: Array<{ modifierId: string; name: string; isDefault: boolean; hasRecipe: boolean }> }
interface OutletDish { menuItemId: string; name: string; brand: string; hasRecipe: boolean; options?: OutletOption[] }
/** `mods`: the option picked per option group (e.g. Patty → Double); its ingredients join the plan. */
interface PlanRow { key: number; menuItemId: string; qty: string; mods: Record<string, string> }
const n = (v: number | null | undefined) => (v == null ? '—' : v.toLocaleString('en', { maximumFractionDigits: 3 }))

export default function ShoppingListPage() {
  const qc = useQueryClient()
  // The outlet = the scope bar's Branch row (owner, 2026-11-06), or the only outlet the bar lists. None → a prompt below.
  const locationId = useActiveBranchId() ?? ''
  const branches = useScopeBranches()
  const [date, setDate] = useState(todayIso())
  const [days, setDays] = useState(1)
  const [mode, setMode] = useState<'expected' | 'planned'>('expected')
  const [rows, setRows] = useState<PlanRow[]>([{ key: 1, menuItemId: '', qty: '', mods: {} }])
  const planned = rows.filter((r) => r.menuItemId && Number(r.qty) > 0).map((r) => {
    const modifierIds = Object.values(r.mods).filter(Boolean)
    return { menuItemId: r.menuItemId, qty: Number(r.qty), ...(modifierIds.length ? { modifierIds } : {}) }
  })
  const planParam = planned.map((p) => `${p.menuItemId}:${p.qty}${p.modifierIds ? `:${p.modifierIds.join('+')}` : ''}`).join(',')
  const usePlan = mode === 'planned'
  const { data: dishes = [] } = useQuery<OutletDish[]>({
    queryKey: ['kitchen', 'outlet-dishes', locationId],
    queryFn: () => api.get(`/kitchen/outlet-dishes?locationId=${locationId}`),
    enabled: !!locationId && usePlan,
  })
  const { data, isLoading, error } = useQuery<{ groups: Group[]; notStocked: NotStocked[] }>({
    queryKey: ['kitchen', 'shopping', locationId, date, days, usePlan ? planParam : ''],
    queryFn: () => api.get(`/kitchen/shopping-list?locationId=${locationId}&date=${date}&days=${days}${usePlan ? `&plan=${encodeURIComponent(planParam)}` : ''}`),
    enabled: !!locationId && (!usePlan || planned.length > 0),
  })
  const make = useMutation({
    mutationFn: () => api.post<{ created: Array<{ purchaseOrderId: string; supplierName: string }>; unassigned: Array<{ name: string }> }>('/kitchen/shopping-list/draft-pos', { locationId, date, days, ...(usePlan ? { planned } : {}) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['kitchen'] }),
  })
  const setRow = (key: number, patch: Partial<PlanRow>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  const groups = data?.groups ?? []
  const notStocked = data?.notStocked ?? []
  // "Not stocked yet — create": this company's stock item from servd's ingredient (then it can be ordered).
  const createItem = useMutation({
    mutationFn: (masterIngredientId: string) => api.post('/inventory/from-master', { masterIngredientId }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['kitchen'] }),
  })
  return (
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-6 py-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-success">Operations</p>
          <h1 className="text-xl font-bold text-s-text">Shopping list</h1>
          <p className="text-xs text-s-muted">What the <Link href="/kitchen/prep-list" className="text-primary-ink underline">prep list</Link> and the expected dishes need, less what is here and on order — with the <Link href="/kitchen/spec-list" className="text-primary-ink underline">spec</Link> of each.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select value={mode} onChange={(e) => setMode(e.target.value as 'expected' | 'planned')} className="s-input w-auto" aria-label="Based on">
            <option value="expected">Based on expected sales</option>
            <option value="planned">Based on dishes I plan to make</option>
          </select>
          {!usePlan && <>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="s-input w-auto" aria-label="From" />
            <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="s-input w-auto" aria-label="Days">
              {[1, 2, 3, 4, 5, 6, 7].map((d) => <option key={d} value={d}>{d} day{d > 1 ? 's' : ''}</option>)}
            </select>
          </>}
          <button type="button" disabled={groups.length === 0 || make.isPending} onClick={() => make.mutate()} className="s-btn-primary px-4 py-2 text-sm font-bold disabled:opacity-40">Create draft POs</button>
        </div>
      </header>
      <div className="p-4 sm:p-6 max-w-6xl mx-auto space-y-4">
        {usePlan && locationId && (
          <section className="s-card p-4 space-y-3">
            <div>
              <h2 className="text-sm font-bold text-s-text">Dishes you plan to make</h2>
              <p className="text-xs text-s-muted">Each dish is broken down into its recipe (sub-recipes included), plus the ingredients of the options you pick. What this outlet already has, and what is already on order, is taken off. Add the same dish twice for two versions (e.g. 30 single, 20 double).</p>
            </div>
            <ul className="space-y-2">
              {rows.map((r) => (
                <li key={r.key} className="flex flex-wrap items-center gap-2">
                  <select value={r.menuItemId} onChange={(e) => {
                    // A required option group starts on its default choice (e.g. Patty → Single).
                    const d = dishes.find((x) => x.menuItemId === e.target.value)
                    const mods: Record<string, string> = {}
                    for (const g of d?.options ?? []) { const def = g.choices.find((c) => c.isDefault); if (g.isRequired && def) mods[g.groupId] = def.modifierId }
                    setRow(r.key, { menuItemId: e.target.value, mods })
                  }} className="s-input w-auto min-w-0 flex-1" aria-label="Dish">
                    <option value="">— Pick a dish —</option>
                    {dishes.map((d) => <option key={d.menuItemId} value={d.menuItemId} disabled={!d.hasRecipe}>{d.name}{d.brand ? ` · ${d.brand}` : ''}{d.hasRecipe ? '' : ' (no recipe)'}</option>)}
                  </select>
                  <input inputMode="numeric" value={r.qty} onChange={(e) => setRow(r.key, { qty: e.target.value.replace(/[^0-9.]/g, '') })} placeholder="How many" className="s-input w-28" aria-label="How many" />
                  <button type="button" onClick={() => setRows((rs) => (rs.length > 1 ? rs.filter((x) => x.key !== r.key) : [{ key: r.key, menuItemId: '', qty: '', mods: {} }]))} className="text-xs text-s-red hover:underline">Remove</button>
                  {(dishes.find((x) => x.menuItemId === r.menuItemId)?.options ?? []).map((g) => (
                    <label key={g.groupId} className="flex w-full items-center gap-2 pl-2 text-xs text-s-muted sm:w-auto">
                      {g.name}
                      <select value={r.mods[g.groupId] ?? ''} onChange={(e) => setRow(r.key, { mods: { ...r.mods, [g.groupId]: e.target.value } })} className="s-input w-auto min-w-0 flex-1 text-sm" aria-label={g.name}>
                        {!g.isRequired && <option value="">None</option>}
                        {g.choices.map((c) => <option key={c.modifierId} value={c.modifierId}>{c.name}{c.hasRecipe || c.isDefault ? '' : ' (no ingredients set)'}</option>)}
                      </select>
                    </label>
                  ))}
                </li>
              ))}
            </ul>
            <button type="button" onClick={() => setRows((rs) => [...rs, { key: Math.max(...rs.map((x) => x.key)) + 1, menuItemId: '', qty: '', mods: {} }])} className="text-sm font-semibold text-primary-ink hover:underline">+ Add dish</button>
          </section>
        )}
        {make.data && (
          <div role="status" className="s-card p-3 text-sm">
            {make.data.created.length} draft PO{make.data.created.length === 1 ? '' : 's'} made ({make.data.created.map((c) => c.supplierName).join(', ') || 'none'}) — open <Link href="/procurement" className="text-primary-ink underline">Procurement</Link> to submit them.
            {make.data.unassigned.length > 0 && <span className="block text-s-muted">No supplier set for: {make.data.unassigned.map((u) => u.name).join(', ')}.</span>}
          </div>
        )}
        {make.error && <p role="alert" className="text-sm text-s-red">{stockErrorText(make.error)}</p>}
        {notStocked.length > 0 && (
          <section className="s-card p-4">
            <h2 className="text-sm font-bold text-s-text">Not stocked yet</h2>
            <p className="text-xs text-s-muted mb-2">Needed by the prep list, but this company has no stock item for them yet — create one on Inventory, set its supplier, then order.</p>
            <ul className="space-y-1">
              {notStocked.map((x) => (
                <li key={x.masterIngredientId ?? x.name} className="flex items-center justify-between text-sm">
                  <span>{x.name} <span className="text-xs text-s-muted">— {n(x.qty)} {x.unit} needed</span></span>
                  {x.masterIngredientId && (
                    <button type="button" disabled={createItem.isPending} onClick={() => createItem.mutate(x.masterIngredientId!)} className="text-xs font-semibold text-primary-ink hover:underline disabled:opacity-40">Create</button>
                  )}
                </li>
              ))}
            </ul>
            {createItem.error && <p role="alert" className="text-xs text-s-red">{stockErrorText(createItem.error)}</p>}
          </section>
        )}
        {!locationId ? <CompactEmptyState message={branches && branches.length === 0 ? 'No outlet yet.' : 'Pick a branch in the bar at the top to see its shopping list.'} />
          : isLoading ? <p className="text-sm text-s-muted">Loading…</p>
          : error ? <p className="text-sm text-s-red">{stockErrorText(error)}</p>
          : usePlan && planned.length === 0 ? <CompactEmptyState message="Pick a dish and how many you plan to make." />
          : groups.length === 0 ? (notStocked.length === 0 ? <CompactEmptyState message={usePlan ? 'Nothing to buy — stock covers these dishes.' : 'Nothing to buy — stock covers the prep list.'} /> : null)
          : groups.map((g) => (
            <section key={g.supplierId ?? 'none'} className="s-card overflow-x-auto">
              <h2 className="px-4 pt-3 text-sm font-bold text-s-text">{g.supplierName}</h2>
              <table className="w-full text-sm">
                <thead className="text-xs text-s-muted">
                  <tr>
                    <th className="px-3 py-2 text-left">Ingredient</th>
                    <th className="px-3 py-2 text-left">Spec</th>
                    <th className="px-3 py-2 text-right">Needed</th>
                    <th className="px-3 py-2 text-right">Here</th>
                    <th className="px-3 py-2 text-right">On order</th>
                    <th className="px-3 py-2 text-right">Buy</th>
                    <th className="px-3 py-2 text-right">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {g.lines.map((l) => (
                    <tr key={l.inventoryItemId} className="border-t border-s-border">
                      <td className="px-3 py-2">{l.name}</td>
                      <td className="px-3 py-2 text-xs text-s-muted max-w-xs">{l.spec ?? '—'}</td>
                      <td className="px-3 py-2 text-right font-mono">{n(l.neededQty)} {l.unit}</td>
                      <td className="px-3 py-2 text-right font-mono">{n(l.currentStock)}</td>
                      <td className="px-3 py-2 text-right font-mono">{n(l.onOrder)}</td>
                      <td className="px-3 py-2 text-right font-mono font-bold">{n(l.suggestedQty)} {l.unit}</td>
                      <td className="px-3 py-2 text-right font-mono text-xs">{fmtUnitCost(l.unitCostCents, l.unit)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ))}
      </div>
    </div>
  )
}
