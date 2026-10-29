'use client'
// Shopping list (owner, 2026-10-26 — kitchen flow, part E): the raw stock the prep list and the forecast dishes need
// for the next day(s), minus this outlet's stock and what is already on order, by supplier — with each ingredient's
// SPEC (what we buy). "Create draft POs" makes one draft purchase order per supplier through procurement's own PO
// (they are then submitted, approved and sent there). GET /kitchen/shopping-list, POST …/draft-pos.
import { useState } from 'react'
import Link from 'next/link'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { stockErrorText } from '../../../lib/stockUi'
import { fmtUnitCost } from '../../../lib/unitCost'
import { CompactEmptyState } from '../../../components/ui/CompactEmptyState'
import { OutletPicker, todayIso, useOutlet } from '../../../components/kitchen/useOutlet'

interface Group {
  supplierId: string | null; supplierName: string; estimatedTotalCents: number | null
  lines: Array<{ inventoryItemId: string; name: string; unit: string; currentStock: number; onOrder: number; neededQty?: number; suggestedQty: number; unitCostCents: number | null; spec: string | null }>
}
interface NotStocked { masterIngredientId: string | null; name: string; unit: string; qty: number }
const n = (v: number | null | undefined) => (v == null ? '—' : v.toLocaleString('en', { maximumFractionDigits: 3 }))

export default function ShoppingListPage() {
  const qc = useQueryClient()
  const { outlets, locationId, setLocationId } = useOutlet()
  const [date, setDate] = useState(todayIso())
  const [days, setDays] = useState(1)
  const { data, isLoading, error } = useQuery<{ groups: Group[]; notStocked: NotStocked[] }>({
    queryKey: ['kitchen', 'shopping', locationId, date, days],
    queryFn: () => api.get(`/kitchen/shopping-list?locationId=${locationId}&date=${date}&days=${days}`),
    enabled: !!locationId,
  })
  const make = useMutation({
    mutationFn: () => api.post<{ created: Array<{ purchaseOrderId: string; supplierName: string }>; unassigned: Array<{ name: string }> }>('/kitchen/shopping-list/draft-pos', { locationId, date, days }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['kitchen'] }),
  })
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
          <OutletPicker outlets={outlets} value={locationId} onChange={setLocationId} />
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="s-input w-auto" aria-label="From" />
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="s-input w-auto" aria-label="Days">
            {[1, 2, 3, 4, 5, 6, 7].map((d) => <option key={d} value={d}>{d} day{d > 1 ? 's' : ''}</option>)}
          </select>
          <button type="button" disabled={groups.length === 0 || make.isPending} onClick={() => make.mutate()} className="s-btn-primary px-4 py-2 text-sm font-bold disabled:opacity-40">Create draft POs</button>
        </div>
      </header>
      <div className="p-6 max-w-6xl mx-auto space-y-4">
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
        {!locationId ? <CompactEmptyState message="No outlet yet." />
          : isLoading ? <p className="text-sm text-s-muted">Loading…</p>
          : error ? <p className="text-sm text-s-red">{stockErrorText(error)}</p>
          : groups.length === 0 ? (notStocked.length === 0 ? <CompactEmptyState message="Nothing to buy — stock covers the prep list." /> : null)
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
