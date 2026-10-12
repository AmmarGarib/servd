'use client'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { api } from '../../../lib/api'

interface Concept { id: string; name: string }
interface ForecastPoint { date: string; predictedQty: number }
interface ForecastItem { menuItemId: string | null; name: string; confidence: 'high' | 'medium' | 'low'; forecasts: ForecastPoint[] }
interface ForecastData { conceptId: string; generatedAt: string; items: ForecastItem[] }

const CONF_COLOR = { high: 'var(--erp-primary)', medium: '#a15c00', low: '#b42318' }

function fmtDate(iso: string) {
  const d = new Date(iso)
  return d.toLocaleDateString('en-PK', { weekday: 'short', month: 'short', day: 'numeric' })
}

export default function ForecastPage() {
  const [conceptId, setConceptId] = useState('')
  const [days, setDays] = useState(7)
  const [sortBy, setSortBy] = useState<'total' | 'name'>('total')

  // The picker list (every staff role, id + name): the plain /concepts list
  // is managers / till only and 403'd for finance. Shares the shell
  // BrandPicker's cache key and shape.
  const { data: concepts } = useQuery({
    queryKey: ['concepts', 'brand-picker'],
    queryFn: () => api.get<Concept[]>('/concepts?view=picker'),
    staleTime: 60_000,
  })

  const { data, isLoading } = useQuery({
    queryKey: ['demand-forecast', conceptId, days],
    queryFn: () => api.get<ForecastData>(`/reports/demand-forecast?conceptId=${conceptId}&days=${days}`),
    enabled: !!conceptId,
    staleTime: 5 * 60 * 1000,
  })

  const items = data?.items ?? []
  const sorted = [...items].sort((a, b) => {
    if (sortBy === 'name') return a.name.localeCompare(b.name)
    const aTotal = a.forecasts.reduce((s, f) => s + f.predictedQty, 0)
    const bTotal = b.forecasts.reduce((s, f) => s + f.predictedQty, 0)
    return bTotal - aTotal
  })

  const dates = items[0]?.forecasts.map(f => f.date) ?? []

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      <div>
        <Link href="/analytics" className="text-xs hover:opacity-70 mb-1 inline-block" style={{ color: 'rgb(var(--fg-rgb) / 0.35)' }}>← Analytics</Link>
        <h1 className="text-xl font-black" style={{ color: 'rgb(var(--fg-rgb) / 0.92)' }}>Demand Forecast</h1>
        <p className="text-sm mt-0.5" style={{ color: 'rgb(var(--fg-rgb) / 0.35)' }}>28-day rolling average by day-of-week · {days}-day projection</p>
      </div>

      <div className="flex flex-wrap gap-3">
        <select value={conceptId} onChange={e => setConceptId(e.target.value)}
          className="s-input text-sm px-3 py-2 rounded-xl min-w-[180px]">
          <option value="">Select concept…</option>
          {concepts?.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select value={days} onChange={e => setDays(Number(e.target.value))}
          className="s-input text-sm px-3 py-2 rounded-xl">
          <option value={7}>7-day forecast</option>
          <option value={14}>14-day forecast</option>
        </select>
        <select value={sortBy} onChange={e => setSortBy(e.target.value as 'total' | 'name')}
          className="s-input text-sm px-3 py-2 rounded-xl">
          <option value="total">Sort by total demand</option>
          <option value="name">Sort by name</option>
        </select>
      </div>

      {!conceptId && (
        <div className="flex items-center justify-center h-48 rounded-2xl" style={{ background: 'rgb(var(--fg-rgb) / 0.02)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
          <p className="text-sm" style={{ color: 'rgb(var(--fg-rgb) / 0.3)' }}>Select a concept to view demand forecast</p>
        </div>
      )}

      {conceptId && isLoading && (
        <div className="flex items-center justify-center h-48">
          <div className="animate-spin h-6 w-6 rounded-full border-2" style={{ borderColor: 'rgb(135 197 64 / 0.3)', borderTopColor: 'var(--erp-primary)' }} />
        </div>
      )}

      {data && sorted.length > 0 && (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {dates.slice(0, 4).map(date => {
              const dayTotal = items.reduce((s, item) => {
                const f = item.forecasts.find(x => x.date === date)
                return s + (f?.predictedQty ?? 0)
              }, 0)
              return (
                <div key={date} className="p-4 rounded-2xl" style={{ background: 'rgb(var(--fg-rgb) / 0.02)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
                  <p className="text-xs" style={{ color: 'rgb(var(--fg-rgb) / 0.35)' }}>{fmtDate(date)}</p>
                  <p className="text-2xl font-black mt-1" style={{ color: 'var(--erp-primary-ink)' }}>{dayTotal}</p>
                  <p className="text-xs" style={{ color: 'rgb(var(--fg-rgb) / 0.25)' }}>predicted items</p>
                </div>
              )
            })}
          </div>

          {/* Heatmap table */}
          <div className="rounded-2xl overflow-x-auto" style={{ border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
            <table className="w-full text-sm" style={{ minWidth: '640px' }}>
              <thead>
                <tr style={{ background: 'rgb(var(--fg-rgb) / 0.03)', borderBottom: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
                  <th className="text-left px-4 py-3 text-[11px] font-bold uppercase tracking-wider sticky left-0"
                    style={{ color: 'rgb(var(--fg-rgb) / 0.3)', background: 'rgba(13,15,21,0.95)' }}>Item</th>
                  {dates.map(d => (
                    <th key={d} className="text-center px-3 py-3 text-[11px] font-bold" style={{ color: 'rgb(var(--fg-rgb) / 0.3)', minWidth: '80px' }}>
                      {fmtDate(d)}
                    </th>
                  ))}
                  <th className="text-right px-4 py-3 text-[11px] font-bold uppercase tracking-wider" style={{ color: 'rgb(var(--fg-rgb) / 0.3)' }}>Total</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((item, idx) => {
                  const total = item.forecasts.reduce((s, f) => s + f.predictedQty, 0)
                  const maxQty = Math.max(...item.forecasts.map(f => f.predictedQty), 1)
                  return (
                    <tr key={item.menuItemId ?? item.name}
                      style={{ borderBottom: idx < sorted.length - 1 ? '1px solid rgb(var(--fg-rgb) / 0.04)' : 'none' }}>
                      <td className="px-4 py-3 font-medium sticky left-0"
                        style={{ color: 'rgb(var(--fg-rgb) / 0.8)', background: 'var(--bg)', maxWidth: '180px' }}>
                        <span className="truncate block">{item.name}</span>
                      </td>
                      {item.forecasts.map(f => {
                        const intensity = maxQty > 0 ? f.predictedQty / maxQty : 0
                        return (
                          <td key={f.date} className="px-3 py-3 text-center">
                            <div className="inline-flex flex-col items-center gap-0.5">
                              <div className="h-8 w-12 rounded-lg flex items-center justify-center text-xs font-bold"
                                style={{
                                  background: `rgba(0,212,177,${0.05 + intensity * 0.35})`,
                                  color: intensity > 0.3 ? 'var(--erp-primary-ink)' : 'rgb(var(--fg-rgb) / 0.4)',
                                  border: `1px solid rgba(0,212,177,${intensity * 0.2})`,
                                }}>
                                {f.predictedQty}
                              </div>
                              <div className="h-1 w-1 rounded-full" style={{ background: CONF_COLOR[item.confidence] }} />
                            </div>
                          </td>
                        )
                      })}
                      <td className="px-4 py-3 text-right font-mono font-bold" style={{ color: 'var(--erp-primary-ink)' }}>{total}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <div className="flex gap-4 text-xs" style={{ color: 'rgb(var(--fg-rgb) / 0.3)' }}>
            {Object.entries(CONF_COLOR).map(([k, c]) => (
              <span key={k} className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full" style={{ background: c }} />
                {k.charAt(0).toUpperCase() + k.slice(1)} confidence
              </span>
            ))}
          </div>
        </>
      )}

      {data && sorted.length === 0 && (
        <div className="flex items-center justify-center h-32 rounded-2xl" style={{ background: 'rgb(var(--fg-rgb) / 0.02)', border: '1px solid rgb(var(--fg-rgb) / 0.06)' }}>
          <p className="text-sm" style={{ color: 'rgb(var(--fg-rgb) / 0.3)' }}>No sales data available for forecasting</p>
        </div>
      )}
    </div>
  )
}
