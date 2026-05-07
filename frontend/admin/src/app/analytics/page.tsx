'use client'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'

interface FunnelStep {
  event: string
  count: number
  conversionRate: number | null
}

interface FunnelData {
  from: string
  to: string
  steps: FunnelStep[]
}

interface OverviewData {
  totalSessions: number
  totalEvents: number
  checkoutStarted: number
  ordersPlaced: number
  checkoutConversion: number
  topEvents: Array<{ event: string; count: number }>
}

interface ItemData {
  itemId: string
  name: string
  views: number
  adds: number
  addRate: number
}

interface SearchData {
  query: string
  count: number
  noResults: number
  noResultRate: number
}

interface Concept {
  id: string
  name: string
  slug: string
}

const EVENT_LABELS: Record<string, string> = {
  page_view: 'Page views',
  concept_view: 'Brand views',
  item_view: 'Item views',
  item_added: 'Add to cart',
  checkout_started: 'Checkout started',
  checkout_abandoned: 'Checkout abandoned',
  order_placed: 'Orders placed',
  search: 'Searches',
  filter_applied: 'Filter applied',
  promo_applied: 'Promo applied',
  promo_failed: 'Promo failed',
}

const DATE_PRESETS = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
]

function isoFrom(days: number) {
  return new Date(Date.now() - days * 864e5).toISOString().slice(0, 10)
}

export default function AnalyticsPage() {
  const [days, setDays] = useState(30)
  const [conceptId, setConceptId] = useState('')

  const dateFrom = isoFrom(days)
  const dateTo = new Date().toISOString().slice(0, 10)
  const params = `?dateFrom=${dateFrom}&dateTo=${dateTo}${conceptId ? `&conceptId=${conceptId}` : ''}`

  const { data: concepts = [] } = useQuery<Concept[]>({
    queryKey: ['concepts'],
    queryFn: () => api.get('/concepts'),
  })

  const { data: overview } = useQuery<OverviewData>({
    queryKey: ['analytics-overview', params],
    queryFn: () => api.get(`/analytics/overview${params}`),
  })

  const { data: funnel } = useQuery<FunnelData>({
    queryKey: ['analytics-funnel', params],
    queryFn: () => api.get(`/analytics/funnel${params}`),
  })

  const { data: items = [] } = useQuery<ItemData[]>({
    queryKey: ['analytics-items', params],
    queryFn: () => api.get(`/analytics/items${params}&limit=15`),
  })

  const { data: searches = [] } = useQuery<SearchData[]>({
    queryKey: ['analytics-search', params],
    queryFn: () => api.get(`/analytics/search${params}&limit=15`),
  })

  const maxFunnelCount = Math.max(...(funnel?.steps.map((s) => s.count) ?? [1]))

  return (
    <div className="p-6 space-y-6 max-w-6xl">
      {/* Header + filters */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-neutral-900">Storefront Analytics</h1>
          <p className="text-sm text-neutral-500 mt-0.5">How customers browse, search, and convert</p>
        </div>
        <div className="flex items-center gap-2">
          {/* Date range */}
          <div className="flex rounded-lg border border-neutral-200 overflow-hidden text-sm">
            {DATE_PRESETS.map((p) => (
              <button
                key={p.days}
                onClick={() => setDays(p.days)}
                className={`px-3 py-1.5 ${days === p.days ? 'bg-green-600 text-white' : 'bg-white text-neutral-600 hover:bg-neutral-50'}`}
              >
                {p.label}
              </button>
            ))}
          </div>
          {/* Concept filter */}
          <select
            value={conceptId}
            onChange={(e) => setConceptId(e.target.value)}
            className="border border-neutral-200 rounded-lg px-3 py-1.5 text-sm bg-white text-neutral-700"
          >
            <option value="">All brands</option>
            {concepts.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
      </div>

      {/* KPI summary row */}
      {overview && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { label: 'Sessions', value: overview.totalSessions.toLocaleString(), icon: '👤' },
            { label: 'Checkout started', value: overview.checkoutStarted.toLocaleString(), icon: '🛒' },
            { label: 'Orders placed', value: overview.ordersPlaced.toLocaleString(), icon: '✅' },
            { label: 'Checkout conversion', value: `${overview.checkoutConversion}%`, icon: '📈' },
          ].map((kpi) => (
            <div key={kpi.label} className="bg-white rounded-xl border border-neutral-200 p-4">
              <div className="flex items-center gap-2 text-neutral-500 text-sm mb-1">
                <span>{kpi.icon}</span>
                <span>{kpi.label}</span>
              </div>
              <div className="text-2xl font-bold text-neutral-900">{kpi.value}</div>
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Conversion funnel */}
        <div className="bg-white rounded-xl border border-neutral-200 p-5">
          <h2 className="font-semibold text-neutral-900 mb-4">Conversion Funnel</h2>
          {funnel ? (
            <div className="space-y-3">
              {funnel.steps.map((step) => (
                <div key={step.event}>
                  <div className="flex justify-between text-sm mb-1">
                    <span className="text-neutral-700">{EVENT_LABELS[step.event] ?? step.event}</span>
                    <span className="font-medium text-neutral-900 tabular-nums">{step.count.toLocaleString()}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="flex-1 bg-neutral-100 rounded-full h-2 overflow-hidden">
                      <div
                        className="h-full bg-green-500 rounded-full transition-all"
                        style={{ width: maxFunnelCount > 0 ? `${(step.count / maxFunnelCount) * 100}%` : '0%' }}
                      />
                    </div>
                    {step.conversionRate !== null && (
                      <span className="text-xs text-neutral-400 w-10 text-right tabular-nums">
                        {step.conversionRate}%
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="space-y-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="h-8 rounded bg-neutral-100 animate-pulse" />
              ))}
            </div>
          )}
        </div>

        {/* Event breakdown */}
        <div className="bg-white rounded-xl border border-neutral-200 p-5">
          <h2 className="font-semibold text-neutral-900 mb-4">Event Breakdown</h2>
          {overview ? (
            <div className="space-y-2">
              {overview.topEvents.map((e) => (
                <div key={e.event} className="flex items-center justify-between py-1.5 border-b border-neutral-50">
                  <span className="text-sm text-neutral-700">{EVENT_LABELS[e.event] ?? e.event}</span>
                  <span className="text-sm font-medium text-neutral-900 tabular-nums">{e.count.toLocaleString()}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="space-y-2">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="h-8 rounded bg-neutral-100 animate-pulse" />
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Top items by views */}
        <div className="bg-white rounded-xl border border-neutral-200 p-5">
          <h2 className="font-semibold text-neutral-900 mb-4">Menu Item Performance</h2>
          {items.length > 0 ? (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-neutral-500 uppercase tracking-wide border-b border-neutral-100">
                  <th className="text-left pb-2 font-medium">Item</th>
                  <th className="text-right pb-2 font-medium">Views</th>
                  <th className="text-right pb-2 font-medium">Adds</th>
                  <th className="text-right pb-2 font-medium">Rate</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-50">
                {items.map((item) => (
                  <tr key={item.itemId ?? item.name}>
                    <td className="py-2 text-neutral-700 truncate max-w-[160px]">{item.name || '(unnamed)'}</td>
                    <td className="py-2 text-right text-neutral-600 tabular-nums">{item.views.toLocaleString()}</td>
                    <td className="py-2 text-right text-neutral-600 tabular-nums">{item.adds.toLocaleString()}</td>
                    <td className={`py-2 text-right font-medium tabular-nums ${item.addRate >= 40 ? 'text-green-600' : item.addRate >= 20 ? 'text-amber-600' : 'text-red-500'}`}>
                      {item.addRate}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-sm text-neutral-400 text-center py-8">No item view data yet</p>
          )}
        </div>

        {/* Top searches */}
        <div className="bg-white rounded-xl border border-neutral-200 p-5">
          <h2 className="font-semibold text-neutral-900 mb-4">Search Queries</h2>
          {searches.length > 0 ? (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-neutral-500 uppercase tracking-wide border-b border-neutral-100">
                  <th className="text-left pb-2 font-medium">Query</th>
                  <th className="text-right pb-2 font-medium">Searches</th>
                  <th className="text-right pb-2 font-medium">No results</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-50">
                {searches.map((s) => (
                  <tr key={s.query}>
                    <td className="py-2 text-neutral-700">{s.query}</td>
                    <td className="py-2 text-right text-neutral-600 tabular-nums">{s.count.toLocaleString()}</td>
                    <td className={`py-2 text-right tabular-nums ${s.noResultRate > 50 ? 'text-red-500 font-medium' : 'text-neutral-500'}`}>
                      {s.noResults > 0 ? `${s.noResultRate}%` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-sm text-neutral-400 text-center py-8">No search data yet</p>
          )}
        </div>
      </div>
    </div>
  )
}
