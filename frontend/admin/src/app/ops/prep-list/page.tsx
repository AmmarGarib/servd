'use client'
// Prep list — kept from the retired Ops Center: tomorrow's (or the next 3/7
// days') prep per station, from GET /ops/prep-list (demand forecast x recipes).
// Not the par sheet, which records what was made.
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { useBrandFilter } from '../../../store/brandFilter'

interface PrepLine {
  ingredientId: string
  ingredientName: string
  unit: string
  requiredQty: number
  currentStock: number
  shortfall: number
}
interface PrepStation {
  stationId: string
  stationName: string
  forecastedItems: string[]
  lines: PrepLine[]
}
interface PrepResp {
  byStation: PrepStation[]
  unmappedItems: Array<{ menuItemId: string; name: string; qty: number; reason: string }>
  generatedAt: string
}

interface Concept { id: string; name: string }

export default function PrepListPage() {
  const [days, setDays] = useState(1)
  const globalBrand = useBrandFilter((st) => st.brandId)
  const [pick, setPick] = useState<string | null>(null)
  const { data: concepts = [], isLoading } = useQuery<Concept[]>({
    queryKey: ['concepts'],
    queryFn: () => api.get('/concepts'),
  })
  // Every brand by default; the sidebar's brand filter or the picker here
  // narrows it to one.
  const chosen = pick ?? globalBrand
  const shown = chosen ? concepts.filter((c) => c.id === chosen) : concepts

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)' }}>
      <header className="px-7 py-7 border-b border-white/[0.05]">
        <p className="text-[10px] font-black uppercase tracking-[0.3em] text-white/30">Operations</p>
        <h1 className="text-2xl font-black text-white/90 mt-1">Prep list</h1>
        <p className="text-sm text-white/40 mt-1 max-w-2xl">
          What each station needs to prep or order, per brand, from the demand forecast and the recipes.
        </p>
      </header>

      <div className="px-7 py-7 max-w-[1200px] mx-auto space-y-7">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {[{ id: null as string | null, name: 'All brands' }, ...concepts].map((c) => {
              const on = (chosen ?? null) === c.id
              return (
                <button key={c.id ?? 'all'} onClick={() => setPick(c.id)}
                  className="rounded-md px-2.5 py-1 font-bold transition-colors"
                  style={{
                    background: on ? 'rgb(var(--erp-primary-rgb) / 0.18)' : 'rgb(var(--fg-rgb) / 0.04)',
                    color: on ? 'var(--erp-primary-ink)' : 'rgb(var(--fg-rgb) / 0.55)',
                    border: on ? '1px solid rgb(var(--erp-primary-rgb) / 0.4)' : '1px solid rgb(var(--fg-rgb) / 0.06)',
                  }}>
                  {c.name}
                </button>
              )
            })}
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span className="text-white/40 font-bold uppercase tracking-wider text-[10px]">For the next</span>
            {[1, 3, 7].map((d) => (
              <button key={d} onClick={() => setDays(d)}
                className="rounded-md px-2.5 py-1 font-bold transition-colors"
                style={{
                  background: days === d ? 'rgb(var(--erp-primary-rgb) / 0.18)' : 'rgb(var(--fg-rgb) / 0.04)',
                  color: days === d ? 'var(--erp-primary-ink)' : 'rgb(var(--fg-rgb) / 0.55)',
                  border: days === d ? '1px solid rgb(var(--erp-primary-rgb) / 0.4)' : '1px solid rgb(var(--fg-rgb) / 0.06)',
                }}>
                {d === 1 ? 'tomorrow' : `${d} days`}
              </button>
            ))}
          </div>
        </div>

        {isLoading && <p className="text-sm text-white/40">Loading brands…</p>}
        {!isLoading && shown.length === 0 && <p className="text-sm text-white/40">No brands in this company yet.</p>}
        {shown.map((c) => <BrandPrep key={c.id} concept={c} days={days} />)}
      </div>
    </div>
  )
}

function BrandPrep({ concept, days }: { concept: Concept; days: number }) {
  const { data: prepList, isLoading: prepLoading } = useQuery<PrepResp>({
    queryKey: ['ops-prep', concept.id, days],
    queryFn: () => api.get(`/ops/prep-list?conceptId=${concept.id}&days=${days}`),
  })
  return (
        <section>
          <h2 className="text-sm font-black uppercase tracking-[0.24em] text-white/60 mb-3">{concept.name}</h2>
          {prepLoading && <p className="text-sm text-white/40">Computing forecast…</p>}
          {prepList && prepList.byStation.length === 0 && (
            <div className="rounded-2xl p-8 text-center"
              style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
              <p className="font-bold text-white/85">No prep computed</p>
              <p className="text-sm text-white/45 mt-1 max-w-md mx-auto">
                The demand forecast needs ~2 weeks of completed orders before it can suggest prep quantities. Check back once you have history.
              </p>
            </div>
          )}
          {prepList && prepList.byStation.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {prepList.byStation.map((s) => (
                <div key={s.stationId}
                  className="rounded-2xl overflow-hidden"
                  style={{ background: 'rgb(var(--fg-rgb) / 0.025)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
                  <div className="px-4 py-3 border-b border-white/[0.05] flex items-center justify-between">
                    <p className="font-black text-white/90">{s.stationName}</p>
                    <span className="text-[10px] text-white/40">{s.lines.length} ingredients</span>
                  </div>
                  <div className="px-4 py-2 border-b border-white/[0.04]">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-white/40 mb-1">Forecasted items</p>
                    <p className="text-xs text-white/65">{s.forecastedItems.join(', ')}</p>
                  </div>
                  <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-[10px] font-bold uppercase tracking-wider text-white/40 border-b border-white/[0.04]">
                        <th className="px-4 py-2">Ingredient</th>
                        <th className="px-4 py-2 text-right">Need</th>
                        <th className="px-4 py-2 text-right">Have</th>
                        <th className="px-4 py-2 text-right">To prep / order</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/[0.03]">
                      {s.lines.map((l) => {
                        const short = l.shortfall > 0
                        return (
                          <tr key={l.ingredientId}>
                            <td className="px-4 py-2 text-white/85">{l.ingredientName}</td>
                            <td className="px-4 py-2 text-right text-white/65 font-mono">{l.requiredQty} {l.unit}</td>
                            <td className="px-4 py-2 text-right text-white/45 font-mono">{l.currentStock} {l.unit}</td>
                            <td className="px-4 py-2 text-right font-mono font-bold"
                              style={{ color: short ? '#a15c00' : 'var(--erp-primary-ink)' }}>
                              {short ? `+${l.shortfall} ${l.unit}` : '✓'}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                  </div>
                </div>
              ))}
            </div>
          )}
          {prepList && prepList.unmappedItems.length > 0 && (
            <div className="mt-3 rounded-xl p-3 text-xs"
              style={{ background: 'rgba(245,158,11,0.05)', border: '1px solid rgba(245,158,11,0.2)' }}>
              <p className="font-bold text-amber-700">{prepList.unmappedItems.length} forecast item{prepList.unmappedItems.length === 1 ? '' : 's'} skipped</p>
              <ul className="text-white/55 mt-1 space-y-0.5">
                {prepList.unmappedItems.slice(0, 5).map((u) => (
                  <li key={u.menuItemId}>· {u.qty}× {u.name} — {u.reason}</li>
                ))}
              </ul>
              <p className="text-white/35 mt-1.5 text-[10px]">Add a recipe + station to unlock prep suggestions for these items.</p>
            </div>
          )}
        </section>
  )
}
