'use client'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../../lib/api'
import { useBrandFilter } from '../../../store/brandFilter'

interface Concept { id: string; name: string }
interface MenuEngineeringItem {
  menuItemId: string | null
  name: string
  orderCount: number
  popularity: 'high' | 'low'
  foodCostCents: number
  revenueCents: number
  marginPct: number
  margin: 'high' | 'low'
  quadrant: 'star' | 'plowHorse' | 'puzzle' | 'dog'
}
interface MenuEngineeringData {
  period: { from: string; to: string }
  totals: { avgPopularity: number; avgMarginPct: number }
  items: MenuEngineeringItem[]
}

const QUADRANT_META = {
  star:      { label: 'Stars',       color: '#00D4B1', bg: 'rgba(0,212,177,0.08)',  border: 'rgba(0,212,177,0.25)', desc: 'High popularity · High margin — promote & protect' },
  plowHorse: { label: 'Plowhorses', color: '#6366F1', bg: 'rgba(99,102,241,0.08)', border: 'rgba(99,102,241,0.25)', desc: 'High popularity · Low margin — reduce cost or reprice' },
  puzzle:    { label: 'Puzzles',    color: '#F59E0B', bg: 'rgba(245,158,11,0.08)',  border: 'rgba(245,158,11,0.25)', desc: 'Low popularity · High margin — reposition or bundle' },
  dog:       { label: 'Dogs',       color: '#FF4D4F', bg: 'rgba(255,77,79,0.08)',   border: 'rgba(255,77,79,0.25)',  desc: 'Low popularity · Low margin — consider removing' },
}

function toDateInput(d: Date) { return d.toISOString().split('T')[0]! }

export default function MenuEngineeringPage() {
  const today = new Date()
  const [dateFrom, setDateFrom] = useState(toDateInput(new Date(today.getFullYear(), today.getMonth(), 1)))
  const [dateTo,   setDateTo]   = useState(toDateInput(today))
  const [conceptId, setConceptId] = useState<string>(() => useBrandFilter.getState().brandId ?? '')
  const [activeQ, setActiveQ] = useState<string | null>(null)

  const { data: concepts } = useQuery({
    queryKey: ['concepts'],
    queryFn: () => api.get<Concept[]>('/concepts'),
  })

  const qs = new URLSearchParams({
    dateFrom: `${dateFrom}T00:00:00Z`,
    dateTo:   `${dateTo}T23:59:59Z`,
    ...(conceptId && { conceptId }),
  })
  const { data, isLoading } = useQuery({
    queryKey: ['menu-engineering', conceptId, dateFrom, dateTo],
    queryFn: () => api.get<MenuEngineeringData>(`/reports/menu-engineering?${qs}`),
    enabled: !!conceptId,
  })

  const items = data?.items ?? []
  const filtered = activeQ ? items.filter(i => i.quadrant === activeQ) : items

  const quadrantCounts = {
    star: items.filter(i => i.quadrant === 'star').length,
    plowHorse: items.filter(i => i.quadrant === 'plowHorse').length,
    puzzle: items.filter(i => i.quadrant === 'puzzle').length,
    dog: items.filter(i => i.quadrant === 'dog').length,
  }

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      <div>
        <h1 className="text-xl font-black" style={{ color: 'rgba(255,255,255,0.92)' }}>Menu Engineering</h1>
        <p className="text-sm mt-0.5" style={{ color: 'rgba(255,255,255,0.35)' }}>Stars · Plowhorses · Puzzles · Dogs</p>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <select value={conceptId} onChange={e => setConceptId(e.target.value)}
          className="s-input text-sm px-3 py-2 rounded-xl min-w-[180px]">
          <option value="">Select concept…</option>
          {concepts?.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="s-input text-sm px-3 py-2 rounded-xl" />
        <input type="date" value={dateTo}   onChange={e => setDateTo(e.target.value)}   className="s-input text-sm px-3 py-2 rounded-xl" />
      </div>

      {!conceptId && (
        <div className="flex items-center justify-center h-48 rounded-2xl" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
          <p className="text-sm" style={{ color: 'rgba(255,255,255,0.3)' }}>Select a concept to view menu engineering analysis</p>
        </div>
      )}

      {conceptId && isLoading && (
        <div className="flex items-center justify-center h-48">
          <div className="animate-spin h-6 w-6 rounded-full border-2" style={{ borderColor: 'rgba(0,212,177,0.3)', borderTopColor: '#00D4B1' }} />
        </div>
      )}

      {data && (
        <>
          {/* Quadrant summary cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {(Object.keys(QUADRANT_META) as (keyof typeof QUADRANT_META)[]).map(q => {
              const meta = QUADRANT_META[q]
              const count = quadrantCounts[q]
              const active = activeQ === q
              return (
                <button key={q} onClick={() => setActiveQ(active ? null : q)}
                  className="text-left p-4 rounded-2xl transition-all"
                  style={{
                    background: active ? meta.bg : 'rgba(255,255,255,0.02)',
                    border: `1px solid ${active ? meta.border : 'rgba(255,255,255,0.06)'}`,
                  }}>
                  <div className="text-2xl font-black" style={{ color: meta.color }}>{count}</div>
                  <div className="text-sm font-bold mt-1" style={{ color: 'rgba(255,255,255,0.8)' }}>{meta.label}</div>
                  <div className="text-[11px] mt-1 leading-tight" style={{ color: 'rgba(255,255,255,0.35)' }}>{meta.desc}</div>
                </button>
              )
            })}
          </div>

          {/* Matrix visualization */}
          <div className="rounded-2xl p-5" style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
            <div className="relative" style={{ height: '320px' }}>
              {/* Axes */}
              <div className="absolute inset-0 grid grid-cols-2 grid-rows-2 gap-px">
                {[
                  { q: 'puzzle',    label: 'PUZZLE',     pos: 'top-left' },
                  { q: 'star',      label: 'STAR',       pos: 'top-right' },
                  { q: 'dog',       label: 'DOG',        pos: 'bottom-left' },
                  { q: 'plowHorse', label: 'PLOWHOUSE',  pos: 'bottom-right' },
                ].map(({ q, label }) => {
                  const meta = QUADRANT_META[q as keyof typeof QUADRANT_META]
                  const qItems = items.filter(i => i.quadrant === q)
                  return (
                    <div key={q} className="relative rounded-xl flex flex-col p-3"
                      style={{ background: activeQ === q ? meta.bg : 'rgba(255,255,255,0.015)', border: `1px solid ${activeQ === q ? meta.border : 'rgba(255,255,255,0.04)'}` }}>
                      <span className="text-[9px] font-black tracking-widest" style={{ color: meta.color }}>{label}</span>
                      <div className="mt-1 space-y-1 overflow-hidden" style={{ maxHeight: '200px' }}>
                        {qItems.slice(0, 6).map(item => (
                          <div key={item.menuItemId ?? item.name} className="flex items-center gap-2">
                            <div className="h-1.5 w-1.5 rounded-full shrink-0" style={{ background: meta.color }} />
                            <span className="text-xs truncate" style={{ color: 'rgba(255,255,255,0.65)' }}>{item.name}</span>
                            <span className="text-[10px] ml-auto shrink-0" style={{ color: 'rgba(255,255,255,0.3)' }}>{item.orderCount}</span>
                          </div>
                        ))}
                        {qItems.length > 6 && <p className="text-[10px]" style={{ color: 'rgba(255,255,255,0.25)' }}>+{qItems.length - 6} more</p>}
                      </div>
                    </div>
                  )
                })}
              </div>
              {/* Axis labels */}
              <div className="absolute -bottom-5 left-0 right-0 flex justify-between text-[10px]" style={{ color: 'rgba(255,255,255,0.25)' }}>
                <span>← Low Margin</span>
                <span>High Margin →</span>
              </div>
            </div>
            <div className="mt-8 flex justify-between text-[10px]" style={{ color: 'rgba(255,255,255,0.25)' }}>
              <span>↑ High Popularity</span>
              <span>Low Popularity ↓</span>
            </div>
          </div>

          {/* Data table */}
          <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid rgba(255,255,255,0.06)' }}>
            <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ background: 'rgba(255,255,255,0.03)', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                  <th className="text-left px-4 py-3 text-[11px] font-bold uppercase tracking-wider" style={{ color: 'rgba(255,255,255,0.3)' }}>Item</th>
                  <th className="text-left px-4 py-3 text-[11px] font-bold uppercase tracking-wider" style={{ color: 'rgba(255,255,255,0.3)' }}>Quadrant</th>
                  <th className="text-right px-4 py-3 text-[11px] font-bold uppercase tracking-wider" style={{ color: 'rgba(255,255,255,0.3)' }}>Orders</th>
                  <th className="text-right px-4 py-3 text-[11px] font-bold uppercase tracking-wider" style={{ color: 'rgba(255,255,255,0.3)' }}>Margin %</th>
                  <th className="text-left px-4 py-3 text-[11px] font-bold uppercase tracking-wider" style={{ color: 'rgba(255,255,255,0.3)' }}>Recommendation</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((item, idx) => {
                  const meta = QUADRANT_META[item.quadrant]
                  const rec = item.quadrant === 'star' ? 'Feature prominently' :
                               item.quadrant === 'plowHorse' ? 'Reduce cost or reprice' :
                               item.quadrant === 'puzzle' ? 'Improve visibility' : 'Review or remove'
                  return (
                    <tr key={item.menuItemId ?? item.name}
                      style={{ borderBottom: idx < filtered.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none' }}>
                      <td className="px-4 py-3 font-medium" style={{ color: 'rgba(255,255,255,0.8)' }}>{item.name}</td>
                      <td className="px-4 py-3">
                        <span className="text-[11px] font-bold px-2 py-0.5 rounded-full"
                          style={{ background: meta.bg, color: meta.color, border: `1px solid ${meta.border}` }}>
                          {meta.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-sm" style={{ color: 'rgba(255,255,255,0.65)' }}>{item.orderCount}</td>
                      <td className="px-4 py-3 text-right font-mono text-sm" style={{ color: item.marginPct >= 0 ? '#00D4B1' : '#FF4D4F' }}>{item.marginPct.toFixed(1)}%</td>
                      <td className="px-4 py-3 text-sm" style={{ color: 'rgba(255,255,255,0.4)' }}>{rec}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            </div>
            {filtered.length === 0 && (
              <div className="flex items-center justify-center h-32">
                <p className="text-sm" style={{ color: 'rgba(255,255,255,0.3)' }}>No items in this period</p>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
