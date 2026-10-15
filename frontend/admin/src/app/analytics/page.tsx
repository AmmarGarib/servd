'use client'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { todayPktIso } from '../../lib/money'
import { Select } from '@/components/ui/Select'

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
  // Karachi day (UTC+5), same basis as todayPktIso
  return new Date(Date.now() + 5 * 3600_000 - days * 864e5).toISOString().slice(0, 10)
}

export default function AnalyticsPage() {
  const [days, setDays] = useState(30)
  const [conceptId, setConceptId] = useState('')

  const dateFrom = isoFrom(days)
  const dateTo = todayPktIso()
  const params = `?dateFrom=${dateFrom}&dateTo=${dateTo}${conceptId ? `&conceptId=${conceptId}` : ''}`

  const { data: concepts = [] } = useQuery<Concept[]>({
    // The brand picker view (id + name, own companies, any staff role): the
    // full brand row is managers-only and this page only needs the names.
    queryKey: ['concepts', 'picker'],
    queryFn: () => api.get('/concepts?view=picker'),
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
    <div className="p-6 space-y-6 max-w-6xl mx-auto">
      {/* Header + filters */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-s-text">Storefront Analytics</h1>
          <p className="text-sm text-s-muted mt-0.5">How customers browse, search, and convert</p>
        </div>
        <div className="flex items-center gap-2">
          {/* Date range */}
          <div className="flex rounded-lg border border-s-border overflow-hidden text-sm">
            {DATE_PRESETS.map((p) => (
              <button
                key={p.days}
                onClick={() => setDays(p.days)}
                className={`px-3 py-1.5 ${days === p.days ? 'bg-primary text-primary-on' : 'bg-s-surface text-s-muted hover:bg-s-elevated'}`}
              >
                {p.label}
              </button>
            ))}
          </div>
          {/* Concept filter */}
          <Select
            value={conceptId}
            onChange={(e) => setConceptId(e.target.value)}
            className="border border-s-border rounded-lg px-3 py-1.5 text-sm bg-s-surface text-s-text"
          >
            <option value="">All brands</option>
            {concepts.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </Select>
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
            <div key={kpi.label} className="bg-s-surface rounded-xl border border-s-border p-4">
              <div className="flex items-center gap-2 text-s-muted text-sm mb-1">
                <span>{kpi.icon}</span>
                <span>{kpi.label}</span>
              </div>
              <div className="text-2xl font-bold text-s-text">{kpi.value}</div>
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Conversion funnel */}
        <div className="bg-s-surface rounded-xl border border-s-border p-5">
          <h2 className="font-semibold text-s-text mb-4">Conversion Funnel</h2>
          {funnel ? (
            <div className="space-y-3">
              {funnel.steps.map((step) => (
                <div key={step.event}>
                  <div className="flex justify-between text-sm mb-1">
                    <span className="text-s-text">{EVENT_LABELS[step.event] ?? step.event}</span>
                    <span className="font-medium text-s-text tabular-nums">{step.count.toLocaleString()}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="flex-1 bg-s-elevated rounded-full h-2 overflow-hidden">
                      <div
                        className="h-full bg-accent rounded-full transition-all"
                        style={{ width: maxFunnelCount > 0 ? `${(step.count / maxFunnelCount) * 100}%` : '0%' }}
                      />
                    </div>
                    {step.conversionRate !== null && (
                      <span className="text-xs text-s-muted w-10 text-right tabular-nums">
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
                <div key={i} className="h-8 rounded bg-s-elevated animate-pulse" />
              ))}
            </div>
          )}
        </div>

        {/* Event breakdown */}
        <div className="bg-s-surface rounded-xl border border-s-border p-5">
          <h2 className="font-semibold text-s-text mb-4">Event Breakdown</h2>
          {overview ? (
            <div className="space-y-2">
              {overview.topEvents.map((e) => (
                <div key={e.event} className="flex items-center justify-between py-1.5 border-b border-s-border">
                  <span className="text-sm text-s-text">{EVENT_LABELS[e.event] ?? e.event}</span>
                  <span className="text-sm font-medium text-s-text tabular-nums">{e.count.toLocaleString()}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="space-y-2">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="h-8 rounded bg-s-elevated animate-pulse" />
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Top items by views */}
        <div className="bg-s-surface rounded-xl border border-s-border p-5">
          <h2 className="font-semibold text-s-text mb-4">Menu Item Performance</h2>
          {items.length > 0 ? (
            <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-s-muted uppercase tracking-wide border-b border-s-border">
                  <th className="text-left pb-2 font-medium">Item</th>
                  <th className="text-right pb-2 font-medium">Views</th>
                  <th className="text-right pb-2 font-medium">Adds</th>
                  <th className="text-right pb-2 font-medium">Rate</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-s-border">
                {items.map((item) => (
                  <tr key={item.itemId ?? item.name}>
                    <td className="py-2 text-s-text truncate max-w-[160px]">{item.name || '(unnamed)'}</td>
                    <td className="py-2 text-right text-s-muted tabular-nums">{item.views.toLocaleString()}</td>
                    <td className="py-2 text-right text-s-muted tabular-nums">{item.adds.toLocaleString()}</td>
                    <td className={`py-2 text-right font-medium tabular-nums ${item.addRate >= 40 ? 'text-primary-ink' : item.addRate >= 20 ? 'text-amber-600' : 'text-red-500'}`}>
                      {item.addRate}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          ) : (
            <p className="text-sm text-s-muted text-center py-8">No item view data yet</p>
          )}
        </div>

        {/* Top searches */}
        <div className="bg-s-surface rounded-xl border border-s-border p-5">
          <h2 className="font-semibold text-s-text mb-4">Search Queries</h2>
          {searches.length > 0 ? (
            <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-s-muted uppercase tracking-wide border-b border-s-border">
                  <th className="text-left pb-2 font-medium">Query</th>
                  <th className="text-right pb-2 font-medium">Searches</th>
                  <th className="text-right pb-2 font-medium">No results</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-s-border">
                {searches.map((s) => (
                  <tr key={s.query}>
                    <td className="py-2 text-s-text">{s.query}</td>
                    <td className="py-2 text-right text-s-muted tabular-nums">{s.count.toLocaleString()}</td>
                    <td className={`py-2 text-right tabular-nums ${s.noResultRate > 50 ? 'text-red-500 font-medium' : 'text-s-muted'}`}>
                      {s.noResults > 0 ? `${s.noResultRate}%` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          ) : (
            <p className="text-sm text-s-muted text-center py-8">No search data yet</p>
          )}
        </div>
      </div>
    </div>
  )
}
