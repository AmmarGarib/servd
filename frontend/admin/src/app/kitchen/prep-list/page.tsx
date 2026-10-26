'use client'
// Prep list (owner, 2026-10-26 — kitchen flow, part D): ONE prep list, from ONE engine (GET /kitchen/prep-list —
// modules/kitchen/prepPlan.ts). For an outlet and a day: the dishes the forecast expects (same weekday, last 4 weeks),
// the preps they need in portions, the par, what is on hand, and what to prep (portions and batches); then the raw
// stock those batches draw and what the dishes draw directly. Replaces /ops/prep-list and the par sheet's list.
import { useState } from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { stockErrorText } from '../../../lib/stockUi'
import { CompactEmptyState } from '../../../components/ui/CompactEmptyState'
import { OutletPicker, todayIso, useOutlet } from '../../../components/kitchen/useOutlet'

interface Plan {
  date: string
  dishes: Array<{ menuItemId: string; name: string; brand: string; forecast: number; hasRecipe: boolean }>
  components: Array<{
    recipeId: string; name: string; unit: string; portionLabel: string | null; portionSize: number | null
    needQty: number; targetQty: number; onHandQty: number; toPrepQty: number
    needPortions: number | null; parPortions: number | null; targetPortions: number | null; onHandPortions: number | null; toPrepPortions: number | null; batches: number | null
  }>
  rawForPrep: Array<{ inventoryItemId: string; name: string; unit: string; qty: number }>
  directRaw: Array<{ inventoryItemId: string; name: string; unit: string; qty: number }>
  notStocked: Array<{ masterIngredientId: string | null; name: string; unit: string; qty: number }>
}
const n = (v: number | null | undefined) => (v == null ? '—' : v.toLocaleString('en', { maximumFractionDigits: 2 }))

export default function PrepListPage() {
  const { outlets, locationId, setLocationId } = useOutlet()
  const [date, setDate] = useState(todayIso())
  const { data, isLoading, error } = useQuery<Plan>({
    queryKey: ['kitchen', 'prep-list', locationId, date],
    queryFn: () => api.get(`/kitchen/prep-list?locationId=${locationId}&date=${date}`),
    enabled: !!locationId,
  })
  return (
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-6 py-4 flex flex-wrap items-center justify-between gap-3 print:static">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-success">Operations</p>
          <h1 className="text-xl font-bold text-s-text">Prep list</h1>
          <p className="text-xs text-s-muted">From the forecast and the par. Log what you made on the <Link href="/par-sheet" className="text-primary-ink underline">par board</Link>; buy what is short from the <Link href="/kitchen/shopping-list" className="text-primary-ink underline">shopping list</Link>.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 print:hidden">
          <OutletPicker outlets={outlets} value={locationId} onChange={setLocationId} />
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="s-input w-auto" aria-label="Date" />
          <button type="button" onClick={() => window.print()} className="s-btn-secondary px-3 py-1.5 text-xs">Print</button>
        </div>
      </header>
      <div className="p-6 max-w-6xl mx-auto space-y-5">
        {!locationId ? <CompactEmptyState message="No outlet yet. Add one under Locations." />
          : isLoading ? <p className="text-sm text-s-muted">Loading…</p>
          : error ? <p className="text-sm text-s-red">{stockErrorText(error)}</p>
          : data && (
            <>
              <section className="s-card overflow-x-auto">
                <h2 className="px-4 pt-3 text-sm font-bold text-s-text">To prep</h2>
                <table className="w-full text-sm">
                  <thead className="text-xs text-s-muted">
                    <tr>
                      <th className="px-3 py-2 text-left">Prep</th>
                      <th className="px-3 py-2 text-right">Needed (forecast)</th>
                      <th className="px-3 py-2 text-right">Par</th>
                      <th className="px-3 py-2 text-right">On hand</th>
                      <th className="px-3 py-2 text-right">To prep</th>
                      <th className="px-3 py-2 text-right">Batches</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.components.map((c) => {
                      const p = c.portionSize != null
                      const lbl = c.portionLabel ?? 'portions'
                      return (
                        <tr key={c.recipeId} className="border-t border-s-border">
                          <td className="px-3 py-2 text-s-text">{c.name}<span className="block text-[11px] text-s-muted">{p ? `in ${lbl} (1 = ${n(c.portionSize)} ${c.unit})` : `in ${c.unit}`}</span></td>
                          <td className="px-3 py-2 text-right font-mono">{p ? n(c.needPortions) : n(c.needQty)}</td>
                          <td className="px-3 py-2 text-right font-mono">{n(c.parPortions)}</td>
                          <td className="px-3 py-2 text-right font-mono">{p ? n(c.onHandPortions) : n(c.onHandQty)}</td>
                          <td className={`px-3 py-2 text-right font-mono font-bold ${c.toPrepQty > 0 ? 'text-s-text' : 'text-success'}`}>{p ? n(c.toPrepPortions) : n(c.toPrepQty)}</td>
                          <td className="px-3 py-2 text-right font-mono">{n(c.batches)}</td>
                        </tr>
                      )
                    })}
                    {data.components.length === 0 && <tr><td colSpan={6} className="px-3 py-6 text-center text-xs text-s-muted">No preps for this outlet&rsquo;s dishes.</td></tr>}
                  </tbody>
                </table>
              </section>
              <div className="grid gap-5 md:grid-cols-2">
                <RawTable title="Raw stock the batches draw" rows={data.rawForPrep} />
                <RawTable title="Raw stock the dishes draw directly" rows={data.directRaw} />
              </div>
              {data.notStocked.length > 0 && (
                <section className="s-card p-4">
                  <h2 className="text-sm font-bold text-s-text">Not stocked yet</h2>
                  <p className="text-xs text-s-muted">Needed, but this company has no stock item for them — create them from the <Link href="/kitchen/shopping-list" className="text-primary-ink underline">shopping list</Link>.</p>
                  <ul className="mt-2 text-sm">{data.notStocked.map((x) => <li key={x.masterIngredientId ?? x.name}>{x.name} — {n(x.qty)} {x.unit}</li>)}</ul>
                </section>
              )}
              <section className="s-card overflow-x-auto">
                <h2 className="px-4 pt-3 text-sm font-bold text-s-text">Dishes expected</h2>
                <table className="w-full text-sm">
                  <thead className="text-xs text-s-muted"><tr><th className="px-3 py-2 text-left">Dish</th><th className="px-3 py-2 text-left">Brand</th><th className="px-3 py-2 text-right">Forecast</th></tr></thead>
                  <tbody>
                    {data.dishes.map((d) => (
                      <tr key={d.menuItemId} className="border-t border-s-border">
                        <td className="px-3 py-2">{d.name}{!d.hasRecipe && <span className="ml-2 text-[11px] text-s-muted">no recipe</span>}</td>
                        <td className="px-3 py-2 text-s-muted">{d.brand}</td>
                        <td className="px-3 py-2 text-right font-mono">{n(d.forecast)}</td>
                      </tr>
                    ))}
                    {data.dishes.length === 0 && <tr><td colSpan={3} className="px-3 py-6 text-center text-xs text-s-muted">No sales on this weekday in the last 4 weeks.</td></tr>}
                  </tbody>
                </table>
              </section>
            </>
          )}
      </div>
    </div>
  )
}

function RawTable({ title, rows }: { title: string; rows: Plan['rawForPrep'] }) {
  return (
    <section className="s-card overflow-x-auto">
      <h2 className="px-4 pt-3 text-sm font-bold text-s-text">{title}</h2>
      <table className="w-full text-sm">
        <tbody>
          {rows.map((r) => (
            <tr key={r.inventoryItemId} className="border-t border-s-border">
              <td className="px-3 py-2">{r.name}</td>
              <td className="px-3 py-2 text-right font-mono">{n(r.qty)} {r.unit}</td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td className="px-3 py-4 text-center text-xs text-s-muted">Nothing.</td></tr>}
        </tbody>
      </table>
    </section>
  )
}
