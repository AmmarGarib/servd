'use client'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ordersApi, api, type Order } from '../../lib/api'
import { formatDistanceToNowStrict } from 'date-fns'
import Link from 'next/link'

function fmt(cents: number) { return `PKR ${(cents / 100).toFixed(0)}` }

const STATUS_COLORS: Record<string, string> = {
  received:  'bg-kds-blue/20 text-kds-blue',
  confirmed: 'bg-kds-amber/20 text-kds-amber',
  preparing: 'bg-kds-amber/20 text-kds-amber',
  ready:     'bg-kds-green/20 text-kds-green',
  completed: 'bg-kds-subtext/20 text-kds-subtext',
  cancelled: 'bg-kds-red/20 text-kds-red',
  rejected:  'bg-kds-red/30 text-kds-red',
}

const SOURCE_COLORS: Record<string, string> = {
  pos:        'bg-purple-900/40 text-purple-400',
  servd:      'bg-blue-900/40 text-kds-blue',
  foodpanda:  'bg-pink-900/40 text-pink-400',
  cart:       'bg-orange-900/40 text-orange-400',
  manual:     'bg-kds-card text-kds-subtext',
}

const LIVE_STATUSES = ['received', 'confirmed', 'preparing', 'ready'] as const
const STATUS_LABEL: Record<string, string> = { received: 'Received', confirmed: 'Confirmed', preparing: 'Preparing', ready: 'Ready' }
const STATUS_NEXT:  Record<string, string> = { received: 'confirmed', confirmed: 'preparing', preparing: 'ready', ready: 'completed' }
const STATUS_CTA:   Record<string, string> = { received: 'Confirm', confirmed: 'Fire →', preparing: 'Mark Ready', ready: 'Complete' }

type Tab = 'live' | 'history' | 'channel'
interface Concept { id: string; name: string; primaryColor: string | null }

export default function OrdersPage() {
  const qc = useQueryClient()
  const [tab, setTab] = useState<Tab>('live')
  const [conceptFilter, setConceptFilter] = useState('all')
  const [source, setSource] = useState('')
  const [status, setStatus] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const { data: concepts = [] } = useQuery({
    queryKey: ['concepts'],
    queryFn: () => api.get<Concept[]>('/concepts'),
  })

  const { data: liveData } = useQuery({
    queryKey: ['orders', 'live', conceptFilter],
    queryFn: () => ordersApi.list({
      status: 'received,confirmed,preparing,ready',
      ...(conceptFilter !== 'all' && { conceptId: conceptFilter }),
    }),
    refetchInterval: 8_000,
    enabled: tab === 'live',
  })

  const { data: historyData, isLoading: histLoading } = useQuery({
    queryKey: ['orders', 'history', conceptFilter, source, status, dateFrom],
    queryFn: () => ordersApi.list({
      ...(source && { source }),
      ...(status && { status }),
      ...(dateFrom && { dateFrom: `${dateFrom}T00:00:00Z` }),
      ...(conceptFilter !== 'all' && { conceptId: conceptFilter }),
      limit: '50',
    }),
    refetchInterval: 30_000,
    enabled: tab === 'history',
  })

  const thirty = new Date(); thirty.setDate(thirty.getDate() - 30)
  const { data: channelData } = useQuery({
    queryKey: ['orders', 'channel', conceptFilter],
    queryFn: () => api.get<{ bySource: Record<string, { orders: number; gross: number; net: number }> }>(
      `/reports/sales/by-source?dateFrom=${thirty.toISOString()}&dateTo=${new Date().toISOString()}${conceptFilter !== 'all' ? `&conceptId=${conceptFilter}` : ''}`
    ),
    enabled: tab === 'channel',
  })

  const updateStatus = useMutation({
    mutationFn: ({ id, s }: { id: string; s: string }) => api.patch(`/orders/${id}/status`, { status: s }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['orders'] }),
  })

  const liveOrders = liveData?.data ?? []
  const grouped: Record<string, Order[]> = {}
  for (const s of LIVE_STATUSES) grouped[s] = liveOrders.filter((o) => o.status === s)

  return (
    <div className="h-screen flex flex-col bg-kds-bg overflow-hidden">
      <header className="border-b border-kds-border px-4 py-3 md:px-6 md:py-4 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl md:text-2xl font-black text-kds-text mt-0.5">Orders</h1>
          <p className="text-xs md:text-sm text-kds-subtext">Live pipeline, history and channel breakdown</p>
        </div>
        <Link href="/kds/all"
          className="shrink-0 rounded-xl border border-kds-border px-3 py-1.5 md:px-4 md:py-2 text-xs md:text-sm text-kds-subtext hover:border-kds-green hover:text-kds-green transition-colors">
          Open KDS ↗
        </Link>
      </header>

      {/* ── Mobile concept filter strip ── */}
      <div className="md:hidden flex gap-2 overflow-x-auto px-4 py-2.5 border-b border-kds-border scrollbar-hide">
        {[{ id: 'all', name: 'All', primaryColor: null }, ...concepts].map((c) => (
          <button key={c.id} onClick={() => setConceptFilter(c.id)}
            className={`shrink-0 flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold transition-colors ${
              conceptFilter === c.id
                ? 'bg-kds-green text-black'
                : 'bg-kds-card border border-kds-border text-kds-subtext'
            }`}>
            {c.primaryColor && <div className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: c.primaryColor }} />}
            {c.name}
          </button>
        ))}
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* ── Concept sidebar (desktop only) ── */}
        <aside className="hidden md:block w-52 shrink-0 border-r border-kds-border overflow-y-auto">
          <p className="px-4 pt-4 pb-2 text-xs font-bold text-kds-subtext uppercase tracking-widest">Concept</p>
          {[{ id: 'all', name: 'All concepts', primaryColor: null }, ...concepts].map((c) => (
            <button key={c.id} onClick={() => setConceptFilter(c.id)}
              className={`w-full flex items-center gap-2 px-4 py-2.5 text-left text-sm transition-colors border-b border-kds-border/40 ${
                conceptFilter === c.id
                  ? 'bg-kds-card border-l-2 border-l-kds-green font-semibold text-kds-text'
                  : 'text-kds-subtext hover:bg-kds-card/50'
              }`}>
              {c.primaryColor && <div className="h-4 w-4 rounded-full shrink-0" style={{ background: c.primaryColor }} />}
              {c.name}
            </button>
          ))}
          {tab === 'live' && liveOrders.length > 0 && (
            <div className="px-4 pt-4 space-y-1">
              <p className="text-xs font-bold text-kds-subtext uppercase tracking-widest mb-2">Queue</p>
              {LIVE_STATUSES.map((s) => (grouped[s]?.length ?? 0) > 0 && (
                <div key={s} className="flex items-center justify-between">
                  <span className="text-xs text-kds-subtext capitalize">{s}</span>
                  <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${STATUS_COLORS[s] ?? ''}`}>
                    {grouped[s]?.length}
                  </span>
                </div>
              ))}
            </div>
          )}
        </aside>

        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
          {/* ── Tabs ── */}
          <div className="flex gap-1 px-6 pt-4 border-b border-kds-border pb-0">
            {(['live', 'history', 'channel'] as Tab[]).map((t) => (
              <button key={t} onClick={() => setTab(t)}
                className={`px-4 py-2 text-sm font-medium rounded-t-lg border-b-2 transition-colors
                  ${tab === t ? 'border-kds-green text-kds-green bg-kds-card' : 'border-transparent text-kds-subtext hover:text-kds-text'}`}>
                {t === 'live'
                  ? `Live${liveOrders.length > 0 ? ` (${liveOrders.length})` : ''}`
                  : t === 'channel' ? 'By channel' : 'History'}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto p-6">

            {/* ════ LIVE ════ */}
            {tab === 'live' && (
              liveOrders.length === 0 ? (
                <div className="text-center py-16">
                  <p className="text-4xl mb-3">✅</p>
                  <p className="font-semibold text-kds-text">Queue is clear</p>
                  <p className="text-sm text-kds-subtext mt-1">New orders appear here automatically every 8 seconds</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  {LIVE_STATUSES.map((s) => (
                    <div key={s}>
                      <div className="flex items-center gap-2 mb-3">
                        <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${STATUS_COLORS[s] ?? ''}`}>
                          {STATUS_LABEL[s]}
                        </span>
                        <span className="text-xs text-kds-subtext">{grouped[s]?.length ?? 0}</span>
                      </div>
                      <div className="space-y-2">
                        {(grouped[s] ?? []).map((order) => (
                          <div key={order.id}
                            onClick={() => setExpandedId(expandedId === order.id ? null : order.id)}
                            className={`rounded-xl border bg-kds-card p-3 cursor-pointer transition-colors ${
                              expandedId === order.id ? 'border-kds-green' : 'border-kds-border hover:border-kds-green/50'
                            }`}>
                            <div className="flex items-start justify-between gap-1">
                              <p className="font-mono text-xs text-kds-subtext">#{order.id.slice(-5).toUpperCase()}</p>
                              <span className={`text-xs font-bold px-1.5 py-0.5 rounded uppercase ${SOURCE_COLORS[order.source] ?? ''}`}>
                                {order.source}
                              </span>
                            </div>
                            <p className="text-sm font-semibold text-kds-text mt-1 truncate">
                              {order.customerName ?? order.table?.label ?? 'Guest'}
                            </p>
                            <div className="flex items-center justify-between mt-1.5">
                              <span className="text-xs text-kds-subtext">{order.items.length} item{order.items.length !== 1 ? 's' : ''}</span>
                              <span className="text-xs font-bold text-kds-green">{fmt(order.totalCents)}</span>
                            </div>
                            {expandedId === order.id && (
                              <div className="mt-2 pt-2 border-t border-kds-border/50 space-y-1">
                                {order.items.map((item) => (
                                  <p key={item.id} className="text-xs text-kds-subtext">{item.quantity}× {item.name}</p>
                                ))}
                                {STATUS_NEXT[s] && (
                                  <button onClick={(e) => { e.stopPropagation(); updateStatus.mutate({ id: order.id, s: STATUS_NEXT[s]! }) }}
                                    disabled={updateStatus.isPending}
                                    className="mt-2 w-full rounded-lg bg-kds-green text-black text-xs font-bold py-1.5 hover:opacity-90 disabled:opacity-50">
                                    {STATUS_CTA[s]}
                                  </button>
                                )}
                              </div>
                            )}
                          </div>
                        ))}
                        {(grouped[s]?.length ?? 0) === 0 && (
                          <div className="rounded-xl border border-dashed border-kds-border/40 p-4 text-center">
                            <p className="text-xs text-kds-subtext/40">—</p>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )
            )}

            {/* ════ HISTORY ════ */}
            {tab === 'history' && (
              <div className="space-y-4">
                <div className="flex flex-wrap gap-3">
                  <select value={source} onChange={(e) => setSource(e.target.value)} className={sel}>
                    <option value="">All sources</option>
                    {['pos','servd','foodpanda','cart','manual'].map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                  <select value={status} onChange={(e) => setStatus(e.target.value)} className={sel}>
                    <option value="">All statuses</option>
                    {['received','confirmed','preparing','ready','completed','cancelled','rejected'].map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                  <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className={sel} />
                  {(source || status || dateFrom) && (
                    <button onClick={() => { setSource(''); setStatus(''); setDateFrom('') }}
                      className="text-xs text-kds-subtext hover:text-kds-red">Clear filters</button>
                  )}
                </div>
                {histLoading ? (
                  <p className="text-kds-subtext text-sm">Loading…</p>
                ) : (
                  <div className="overflow-x-auto rounded-xl border border-kds-border">
                    <table className="w-full text-sm">
                      <thead className="bg-kds-card border-b border-kds-border">
                        <tr>
                          {['#', 'Source', 'Concept', 'Customer', 'Items', 'Total', 'Status', 'When'].map((h) => (
                            <th key={h} className="px-4 py-3 text-left font-semibold text-kds-subtext">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-kds-border">
                        {(historyData?.data ?? []).map((order: Order) => (
                          <>
                            <tr key={order.id}
                              className="hover:bg-kds-card/50 cursor-pointer"
                              onClick={() => setExpandedId(expandedId === order.id ? null : order.id)}>
                              <td className="px-4 py-3 font-mono text-xs text-kds-subtext">#{order.id.slice(-6).toUpperCase()}</td>
                              <td className="px-4 py-3">
                                <span className={`rounded px-2 py-0.5 text-xs font-bold uppercase ${SOURCE_COLORS[order.source] ?? ''}`}>
                                  {order.source}
                                </span>
                              </td>
                              <td className="px-4 py-3 text-kds-text">{order.concept.name}</td>
                              <td className="px-4 py-3 text-kds-subtext">{order.customerName ?? order.table?.label ?? '—'}</td>
                              <td className="px-4 py-3 text-kds-subtext">{order.items.length}</td>
                              <td className="px-4 py-3 font-bold text-kds-green">{fmt(order.totalCents)}</td>
                              <td className="px-4 py-3">
                                <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_COLORS[order.status] ?? ''}`}>
                                  {order.status}
                                </span>
                              </td>
                              <td className="px-4 py-3 text-kds-subtext text-xs">
                                {formatDistanceToNowStrict(new Date(order.placedAt))} ago
                              </td>
                            </tr>
                            {expandedId === order.id && (
                              <tr key={`${order.id}-x`}>
                                <td colSpan={8} className="px-6 py-3 bg-kds-card/40 border-b border-kds-border">
                                  <div className="space-y-1">
                                    {order.items.map((item) => (
                                      <div key={item.id} className="flex items-center gap-3 text-xs">
                                        <span className="text-kds-subtext">{item.quantity}×</span>
                                        <span className="text-kds-text">{item.name}</span>
                                        <span className="ml-auto text-kds-subtext">{fmt(item.unitPriceCents * item.quantity)}</span>
                                      </div>
                                    ))}
                                    {order.deliveryNotes && (
                                      <p className="text-xs text-kds-subtext pt-2 border-t border-kds-border/50 mt-1">
                                        📍 {order.deliveryNotes}
                                      </p>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            )}
                          </>
                        ))}
                      </tbody>
                    </table>
                    {(historyData?.data.length ?? 0) === 0 && !histLoading && (
                      <div className="py-12 text-center text-kds-subtext">No orders found</div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* ════ CHANNEL ════ */}
            {tab === 'channel' && (
              <div className="space-y-4 max-w-xl">
                <p className="text-sm text-kds-subtext">Orders and revenue by source over the last 30 days.</p>
                {channelData?.bySource ? (
                  <div className="rounded-xl border border-kds-border overflow-hidden">
                    <table className="w-full text-sm">
                      <thead className="bg-kds-card border-b border-kds-border">
                        <tr>
                          {['Channel', 'Orders', 'Gross', 'Net'].map((h) => (
                            <th key={h} className="px-4 py-3 text-left font-semibold text-kds-subtext">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-kds-border">
                        {Object.entries(channelData.bySource)
                          .sort((a, b) => b[1].gross - a[1].gross)
                          .map(([src, data]) => (
                            <tr key={src} className="hover:bg-kds-card/50">
                              <td className="px-4 py-3">
                                <span className={`rounded px-2 py-0.5 text-xs font-bold uppercase ${SOURCE_COLORS[src] ?? ''}`}>{src}</span>
                              </td>
                              <td className="px-4 py-3 text-kds-subtext">{data.orders}</td>
                              <td className="px-4 py-3 text-kds-text">{fmt(data.gross)}</td>
                              <td className="px-4 py-3 font-bold text-kds-green">{fmt(data.net)}</td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="text-center py-12 text-kds-subtext">
                    <p className="text-3xl mb-2">📊</p>
                    <p>No channel data for this period</p>
                  </div>
                )}
              </div>
            )}

          </div>
        </div>
      </div>
    </div>
  )
}

const sel = 'rounded-lg border border-kds-border bg-kds-card px-3 py-2 text-sm text-kds-text focus:border-kds-green focus:outline-none'
