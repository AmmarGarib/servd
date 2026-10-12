'use client'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ordersApi, api, type Order } from '../../lib/api'
import { useAuthStore } from '../../store/auth'
import { canOpenPath } from '../../lib/moduleCatalog'
import { usePermissions } from '../../hooks/useCan'
import { formatDistanceToNowStrict } from 'date-fns'
import Link from 'next/link'
import { fmtPkrWhole } from '../../lib/money'
import {
  fetchReceiptHtml, isPreBillRequired, preBillErrorMessage, printHtml, printPreBill, tillErrorMessage,
} from '../../components/pos/tillApi'
import { useCanPrintBill } from '../../components/pos/useCanPrintBill'
import { orderRef } from '../../lib/orderRef'

// The full & final bill exists only once an order reached it (spec §17.1):
// completed, or since refunded / cancelled / rejected (bannered so), or paid
// in full and waiting for its hand-off. Anything else prints a PRE-BILL —
// the server answers 409 PRE_BILL_REQUIRED, the same rule (pos/receipt.ts
// isFinalBill).
const FINAL_STATUSES = new Set(['completed', 'refunded', 'cancelled', 'rejected'])
function hasFinalBill(order: Order): boolean {
  if (FINAL_STATUSES.has(order.status)) return true
  const paid = order.payments
    .filter((p) => p.status === 'paid' && p.amountCents > 0)
    .reduce((t, p) => t + p.amountCents, 0)
  return paid > 0 && paid >= order.totalCents
}

/** Reprint the full & final bill (a DUPLICATE); an order still open is offered its pre-bill instead. */
async function reprintReceipt(orderId: string) {
  const token = useAuthStore.getState().token       // F43
  try {
    await printHtml(() => fetchReceiptHtml(orderId, token, { duplicate: true }), { width: 420, height: 600 })
  } catch (e) {
    if (isPreBillRequired(e)) {
      if (!window.confirm('This order isn’t paid yet, so it has no full & final bill. Print a pre-bill instead? (Not a tax invoice.)')) return
      try {
        await printPreBill(orderId, 'cash', token)
      } catch (err) {
        alert(preBillErrorMessage(err))
      }
      return
    }
    alert(tillErrorMessage(e, 'The bill is not available for this order'))
  }
}

const STATUS_COLORS: Record<string, string> = {
  received:  'bg-s-blue/20 text-s-blue',
  confirmed: 'bg-s-amber/20 text-s-amber',
  preparing: 'bg-s-amber/20 text-s-amber',
  ready:     'bg-primary/20 text-primary-ink',
  completed: 'bg-s-muted/20 text-s-muted',
  cancelled: 'bg-s-red/20 text-s-red',
  rejected:  'bg-s-red/30 text-s-red',
  refunded:  'bg-s-indigo/20 text-s-indigo',
}

const SOURCE_COLORS: Record<string, string> = {
  pos:        'bg-purple-100/40 text-purple-700',
  servd:      'bg-blue-100/40 text-s-blue',
  cart:       'bg-orange-100 text-orange-700',
  manual:     'bg-s-surface text-s-muted',
}

// Three live columns, not four. The CEO's flow has just two human actions on
// any external order:
//   1. Expo "Fire" — moves received straight to preparing (no separate confirm
//      step; confirming an order IS firing it).
//   2. Stations bump steps on per-station KDS — the cascade walks the order
//      through ready → completed. The Orders page doesn't drive that path.
const LIVE_STATUSES = ['received', 'preparing', 'ready'] as const
const STATUS_LABEL: Record<string, string> = { received: 'Awaiting Fire', preparing: 'Preparing', ready: 'Ready' }
// Only the Fire CTA lives on this screen. Preparing/Ready are info-only —
// progression happens via station bumps on /kds/[station].
const STATUS_NEXT:  Record<string, string> = { received: 'preparing' }
const STATUS_CTA:   Record<string, string> = { received: 'Fire' }

type Tab = 'live' | 'history'
interface Concept { id: string; name: string; primaryColor: string | null }

export default function OrdersPage() {
  const qc = useQueryClient()
  const [tab, setTab] = useState<Tab>('live')
  const [conceptFilter, setConceptFilter] = useState('all')
  const [source, setSource] = useState('')
  const [status, setStatus] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)

  // Bulk selection state
  const [selected, setSelected] = useState<Set<string>>(new Set())

  // Per-order note state: { [orderId]: { open, draft } }
  const [notes, setNotes] = useState<Record<string, { open: boolean; draft: string }>>({})

  // The brand filter reads the picker list (every staff role; id, name,
  // colour) — the plain /concepts list is managers / till only, so it 403'd
  // for expediter and finance, who hold 'orders'. Shares the shell
  // BrandPicker's cache key and shape.
  const { data: concepts = [] } = useQuery({
    queryKey: ['concepts', 'brand-picker'],
    queryFn: () => api.get<Concept[]>('/concepts?view=picker'),
    staleTime: 60_000,
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

  // Sales by channel lives on /reports (GET /reports/by-source) — the one
  // channel breakdown. This page used to carry a second "By channel" tab that
  // called a route that never existed. Cross-module links (Reports, Expo, the
  // CRM profile) show only to a login that can open the page behind them —
  // the same rule as the sidebar and the page guard (GET /permissions/me).
  const { data: me } = usePermissions()
  const canOpen = (path: string) => !!me && canOpenPath(path, me.role, me.modules ?? [])
  const canSeeReports = canOpen('/reports')
  const canOpenExpo = canOpen('/expo')
  const canOpenCrm = canOpen('/crm')
  // The bill routes are the till's (CASHIERS): expediter and finance can read
  // orders but would only get a 403 from Reprint.
  const canPrint = useCanPrintBill()

  const updateStatus = useMutation({
    mutationFn: ({ id, s }: { id: string; s: string }) => api.patch(`/orders/${id}/status`, { status: s }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['orders'] }),
  })

  const bulkUpdate = useMutation({
    mutationFn: async ({ ids, s }: { ids: string[]; s: string }) => {
      await Promise.all(ids.map((id) => api.patch(`/orders/${id}/status`, { status: s })))
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['orders'] })
      setSelected(new Set())
    },
  })

  // Cancelling is not a status write: it goes through the one staff cancel
  // (managers, reason required, audited), which also gives back what the
  // customer paid with wallet / gift card and releases a promo.
  const bulkCancel = useMutation({
    mutationFn: async ({ ids, reason }: { ids: string[]; reason: string }) => {
      await Promise.all(ids.map((id) => ordersApi.cancel(id, reason)))
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['orders'] })
      setSelected(new Set())
    },
    onError: (err: Error) => alert(err.message),
  })

  const saveNote = useMutation({
    mutationFn: ({ id, note }: { id: string; note: string }) =>
      api.patch(`/orders/${id}/notes`, { notes: note }),
    onSuccess: (_d, vars) => {
      void qc.invalidateQueries({ queryKey: ['orders'] })
      setNotes((prev) => ({ ...prev, [vars.id]: { open: false, draft: '' } }))
    },
  })

  const liveOrders = liveData?.data ?? []
  const histOrders = historyData?.data ?? []
  const grouped: Record<string, Order[]> = {}
  for (const s of LIVE_STATUSES) grouped[s] = liveOrders.filter((o) => o.status === s)

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAll() {
    if (selected.size === histOrders.length) {
      setSelected(new Set())
    } else {
      setSelected(new Set(histOrders.map((o) => o.id)))
    }
  }

  const selCount = selected.size

  return (
    <div className="h-screen flex flex-col bg-s-bg overflow-hidden">
      <header className="border-b border-s-border px-4 py-3 md:px-6 md:py-4 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl md:text-2xl font-black text-s-text mt-0.5">Orders</h1>
          <p className="text-xs md:text-sm text-s-muted">Live pipeline and history</p>
        </div>
        {canOpenExpo && (
          <Link href="/expo"
            className="shrink-0 rounded-xl border border-s-border px-3 py-1.5 md:px-4 md:py-2 text-xs md:text-sm text-s-muted hover:border-primary hover:text-primary-ink transition-colors">
            Open Expo ↗
          </Link>
        )}
      </header>

      {/* ── Mobile concept filter strip ── */}
      <div className="lg:hidden flex gap-2 overflow-x-auto px-4 py-2.5 border-b border-s-border scrollbar-hide">
        {[{ id: 'all', name: 'All', primaryColor: null }, ...concepts].map((c) => (
          <button key={c.id} onClick={() => setConceptFilter(c.id)}
            className={`shrink-0 flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold transition-colors ${
              conceptFilter === c.id
                ? 'bg-primary text-primary-on'
                : 'bg-s-surface border border-s-border text-s-muted'
            }`}>
            {c.primaryColor && <div className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: c.primaryColor }} />}
            {c.name}
          </button>
        ))}
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* ── Concept sidebar (desktop only) ── */}
        <aside className="hidden lg:block w-52 shrink-0 border-r border-s-border overflow-y-auto">
          <p className="px-4 pt-4 pb-2 text-xs font-bold text-s-muted uppercase tracking-widest">Concept</p>
          {[{ id: 'all', name: 'All concepts', primaryColor: null }, ...concepts].map((c) => (
            <button key={c.id} onClick={() => setConceptFilter(c.id)}
              className={`w-full flex items-center gap-2 px-4 py-2.5 text-left text-sm transition-colors border-b border-s-border/40 ${
                conceptFilter === c.id
                  ? 'bg-s-surface border-l-2 border-l-primary font-semibold text-s-text'
                  : 'text-s-muted hover:bg-s-surface/50'
              }`}>
              {c.primaryColor && <div className="h-4 w-4 rounded-full shrink-0" style={{ background: c.primaryColor }} />}
              {c.name}
            </button>
          ))}
          {tab === 'live' && liveOrders.length > 0 && (
            <div className="px-4 pt-4 space-y-1">
              <p className="text-xs font-bold text-s-muted uppercase tracking-widest mb-2">Queue</p>
              {LIVE_STATUSES.map((s) => (grouped[s]?.length ?? 0) > 0 && (
                <div key={s} className="flex items-center justify-between">
                  <span className="text-xs text-s-muted capitalize">{s}</span>
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
          <div className="flex gap-1 px-6 pt-4 border-b border-s-border pb-0">
            {(['live', 'history'] as Tab[]).map((t) => (
              <button key={t} onClick={() => setTab(t)}
                className={`px-4 py-2 text-sm font-medium rounded-t-lg border-b-2 transition-colors
                  ${tab === t ? 'border-accent text-primary-ink bg-s-surface' : 'border-transparent text-s-muted hover:text-s-text'}`}>
                {t === 'live'
                  ? `Live${liveOrders.length > 0 ? ` (${liveOrders.length})` : ''}`
                  : 'History'}
              </button>
            ))}
            {canSeeReports && (
              <Link href="/reports"
                className="ml-auto px-4 py-2 text-sm font-medium text-s-muted hover:text-primary-ink transition-colors">
                Sales by channel ↗
              </Link>
            )}
          </div>

          <div className="flex-1 overflow-y-auto p-6">

            {/* ════ LIVE ════ */}
            {tab === 'live' && (
              liveOrders.length === 0 ? (
                <div className="text-center py-16">
                  <p className="font-semibold text-s-text">Queue is clear</p>
                  <p className="text-sm text-s-muted mt-1">New orders appear here automatically every 8 seconds</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 2xl:grid-cols-5">
                  {LIVE_STATUSES.map((s) => (
                    <div key={s}>
                      <div className="flex items-center gap-2 mb-3">
                        <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${STATUS_COLORS[s] ?? ''}`}>
                          {STATUS_LABEL[s]}
                        </span>
                        <span className="text-xs text-s-muted">{grouped[s]?.length ?? 0}</span>
                      </div>
                      <div className="space-y-2">
                        {(grouped[s] ?? []).map((order) => (
                          <div key={order.id}
                            onClick={() => setExpandedId(expandedId === order.id ? null : order.id)}
                            className={`rounded-xl border bg-s-surface p-3 cursor-pointer transition-colors ${
                              expandedId === order.id ? 'border-accent' : 'border-s-border hover:border-primary/50'
                            }`}>
                            <div className="flex items-start justify-between gap-1">
                              <p className="font-mono text-xs text-s-muted">#{orderRef(order.id)}</p>
                              <span className={`text-xs font-bold px-1.5 py-0.5 rounded uppercase ${SOURCE_COLORS[order.source] ?? ''}`}>
                                {order.source}
                              </span>
                            </div>
                            <p className="text-sm font-semibold text-s-text mt-1 truncate">
                              {order.customerName ?? order.table?.label ?? 'Guest'}
                            </p>
                            <div className="flex items-center justify-between mt-1.5">
                              <span className="text-xs text-s-muted">{order.items.length} item{order.items.length !== 1 ? 's' : ''}</span>
                              <span className="text-xs font-bold text-primary-ink">{fmtPkrWhole(order.totalCents)}</span>
                            </div>
                            {expandedId === order.id && (
                              <div className="mt-2 pt-2 border-t border-s-border/50 space-y-1">
                                {order.items.map((item) => (
                                  <p key={item.id} className="text-xs text-s-muted">{item.quantity}× {item.name}</p>
                                ))}
                                {STATUS_NEXT[s] && (
                                  <button onClick={(e) => { e.stopPropagation(); updateStatus.mutate({ id: order.id, s: STATUS_NEXT[s]! }) }}
                                    disabled={updateStatus.isPending}
                                    className="mt-2 w-full rounded-lg bg-primary text-primary-on text-xs font-bold py-1.5 hover:opacity-90 disabled:opacity-50">
                                    {STATUS_CTA[s]}
                                  </button>
                                )}
                              </div>
                            )}
                          </div>
                        ))}
                        {(grouped[s]?.length ?? 0) === 0 && (
                          <div className="rounded-xl border border-dashed border-s-border/40 p-4 text-center">
                            <p className="text-xs text-s-muted/40">—</p>
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
                    {['pos','servd','cart','manual'].map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                  <select value={status} onChange={(e) => setStatus(e.target.value)} className={sel}>
                    <option value="">All statuses</option>
                    {['received','confirmed','preparing','ready','completed','refunded','cancelled','rejected'].map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                  <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className={sel} />
                  {(source || status || dateFrom) && (
                    <button onClick={() => { setSource(''); setStatus(''); setDateFrom('') }}
                      className="text-xs text-s-muted hover:text-s-red">Clear filters</button>
                  )}
                </div>

                {histLoading ? (
                  <p className="text-s-muted text-sm">Loading…</p>
                ) : (
                  <div className="overflow-x-auto rounded-xl border border-s-border">
                    <table className="w-full text-sm">
                      <thead className="bg-s-surface border-b border-s-border">
                        <tr>
                          <th className="px-3 py-3 w-10">
                            <input
                              type="checkbox"
                              checked={histOrders.length > 0 && selected.size === histOrders.length}
                              onChange={toggleAll}
                              className="rounded border-s-border accent-primary cursor-pointer"
                            />
                          </th>
                          {['#', 'Source', 'Concept', 'Customer', 'Items', 'Total', 'Status', 'When', '', ''].map((h, i) => (
                            <th key={`${h}-${i}`} className="px-4 py-3 text-left font-semibold text-s-muted">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-s-border">
                        {histOrders.map((order: Order) => {
                          const noteState = notes[order.id] ?? { open: false, draft: order.deliveryNotes ?? '' }
                          const isSelected = selected.has(order.id)
                          return (
                            <>
                              <tr key={order.id}
                                className={`hover:bg-s-surface/50 cursor-pointer transition-colors ${isSelected ? 'bg-primary/5' : ''}`}
                                onClick={() => setExpandedId(expandedId === order.id ? null : order.id)}>
                                <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
                                  <input
                                    type="checkbox"
                                    checked={isSelected}
                                    onChange={() => toggleSelect(order.id)}
                                    className="rounded border-s-border accent-primary cursor-pointer"
                                  />
                                </td>
                                <td className="px-4 py-3 font-mono text-xs text-s-muted">#{orderRef(order.id)}</td>
                                <td className="px-4 py-3">
                                  <span className={`rounded px-2 py-0.5 text-xs font-bold uppercase ${SOURCE_COLORS[order.source] ?? ''}`}>
                                    {order.source}
                                  </span>
                                </td>
                                <td className="px-4 py-3 text-s-text">{order.concept.name}</td>
                                <td className="px-4 py-3">
                                  {order.customerName ? (
                                    canOpenCrm ? (
                                      <Link
                                        href={`/crm?search=${encodeURIComponent(order.customerName)}`}
                                        onClick={(e) => e.stopPropagation()}
                                        className="text-blue-700 hover:text-blue-700 hover:underline transition-colors text-sm">
                                        {order.customerName}
                                      </Link>
                                    ) : <span className="text-s-text text-sm">{order.customerName}</span>
                                  ) : (
                                    <span className="text-s-muted">{order.table?.label ?? '—'}</span>
                                  )}
                                </td>
                                <td className="px-4 py-3 text-s-muted">{order.items.length}</td>
                                <td className="px-4 py-3 font-bold text-primary-ink">{fmtPkrWhole(order.totalCents)}</td>
                                <td className="px-4 py-3">
                                  <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_COLORS[order.status] ?? ''}`}>
                                    {order.status}
                                  </span>
                                </td>
                                <td className="px-4 py-3 text-s-muted text-xs">
                                  {formatDistanceToNowStrict(new Date(order.placedAt))} ago
                                </td>
                                <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                                  <div className="flex items-center gap-1.5">
                                    <button
                                      onClick={() => setNotes((prev) => ({
                                        ...prev,
                                        [order.id]: { open: !prev[order.id]?.open, draft: prev[order.id]?.draft ?? order.deliveryNotes ?? '' },
                                      }))}
                                      className="text-xs px-2 py-1 rounded border border-s-border/50 text-s-muted hover:border-primary hover:text-primary-ink transition-colors whitespace-nowrap">
                                      {order.deliveryNotes ? 'Edit note' : '+ Note'}
                                    </button>
                                    {canPrint && hasFinalBill(order) && (
                                      <button
                                        onClick={() => void reprintReceipt(order.id)}
                                        title="Reprint the full & final bill (marked DUPLICATE)"
                                        className="text-xs px-2 py-1 rounded border border-s-border/50 text-s-muted hover:border-primary hover:text-primary-ink transition-colors whitespace-nowrap">
                                        Reprint
                                      </button>
                                    )}
                                  </div>
                                </td>
                                <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                                  <Link
                                    href={`/orders/${order.id}`}
                                    className="text-xs px-2 py-1 rounded border border-s-border/50 text-s-muted hover:border-primary hover:text-primary-ink transition-colors whitespace-nowrap">
                                    View →
                                  </Link>
                                </td>
                              </tr>
                              {/* Note inline editor */}
                              {noteState.open && (
                                <tr key={`${order.id}-note`}>
                                  <td colSpan={11} className="px-6 py-3 bg-s-surface/60 border-b border-s-border">
                                    <div className="flex items-center gap-3">
                                      <input
                                        value={noteState.draft}
                                        onChange={(e) => setNotes((prev) => ({ ...prev, [order.id]: { ...noteState, draft: e.target.value } }))}
                                        placeholder="Add a note about this order…"
                                        className="flex-1 rounded-lg bg-s-bg border border-s-border px-3 py-1.5 text-sm text-s-text focus:border-primary focus:outline-none"
                                        autoFocus
                                      />
                                      <button
                                        onClick={() => saveNote.mutate({ id: order.id, note: noteState.draft })}
                                        disabled={saveNote.isPending}
                                        className="rounded-lg bg-primary text-primary-on font-bold px-3 py-1.5 text-xs hover:opacity-90 disabled:opacity-50 whitespace-nowrap">
                                        {saveNote.isPending ? 'Saving…' : 'Save note'}
                                      </button>
                                      <button
                                        onClick={() => setNotes((prev) => ({ ...prev, [order.id]: { ...noteState, open: false } }))}
                                        className="text-xs text-s-muted hover:text-s-text">
                                        Cancel
                                      </button>
                                    </div>
                                  </td>
                                </tr>
                              )}
                              {/* Expanded items */}
                              {expandedId === order.id && (
                                <tr key={`${order.id}-x`}>
                                  <td colSpan={11} className="px-6 py-3 bg-s-surface/40 border-b border-s-border">
                                    <div className="space-y-1">
                                      {order.items.map((item) => (
                                        <div key={item.id} className="flex items-center gap-3 text-xs">
                                          <span className="text-s-muted">{item.quantity}×</span>
                                          <span className="text-s-text">{item.name}</span>
                                          <span className="ml-auto text-s-muted">{fmtPkrWhole(item.unitPriceCents * item.quantity)}</span>
                                        </div>
                                      ))}
                                      {order.deliveryNotes && (
                                        <p className="text-xs text-s-muted pt-2 border-t border-s-border/50 mt-1">
                                          Note: {order.deliveryNotes}
                                        </p>
                                      )}
                                    </div>
                                  </td>
                                </tr>
                              )}
                            </>
                          )
                        })}
                      </tbody>
                    </table>
                    {histOrders.length === 0 && !histLoading && (
                      <div className="py-12 text-center text-s-muted">No orders found</div>
                    )}
                  </div>
                )}
              </div>
            )}

          </div>
        </div>
      </div>

      {/* ════ BULK ACTION FLOATING BAR ════ */}
      {tab === 'history' && selCount >= 2 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 rounded-2xl border border-s-border bg-s-surface shadow-2xl px-5 py-3">
          <span className="text-sm font-semibold text-s-text">{selCount} selected</span>
          <div className="w-px h-5 bg-s-border" />
          <button
            onClick={() => {
              const reason = window.prompt(`Reason for cancelling ${selCount} orders (required):`)?.trim() ?? ''
              if (reason.length < 3) return
              bulkCancel.mutate({ ids: Array.from(selected), reason })
            }}
            disabled={bulkCancel.isPending || bulkUpdate.isPending}
            className="rounded-lg border border-s-red/40 bg-s-red/10 text-s-red font-semibold px-4 py-1.5 text-sm hover:bg-s-red/20 transition-colors disabled:opacity-50">
            {bulkCancel.isPending ? 'Cancelling…' : 'Cancel'}
          </button>
          <button
            onClick={() => bulkUpdate.mutate({ ids: Array.from(selected), s: 'completed' })}
            disabled={bulkUpdate.isPending}
            className="rounded-lg border border-primary/40 bg-primary/10 text-primary-ink font-semibold px-4 py-1.5 text-sm hover:bg-primary/20 transition-colors disabled:opacity-50">
            {bulkUpdate.isPending ? 'Updating…' : 'Complete'}
          </button>
          <div className="w-px h-5 bg-s-border" />
          <button
            onClick={() => setSelected(new Set())}
            className="text-xs text-s-muted hover:text-s-text transition-colors">
            Clear
          </button>
        </div>
      )}
    </div>
  )
}

const sel = 'rounded-lg border border-s-border bg-s-surface px-3 py-2 text-sm text-s-text focus:border-primary focus:outline-none'
