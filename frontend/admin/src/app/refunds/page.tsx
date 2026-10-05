'use client'

// Refund management. Lists recent orders the manager could refund or cancel,
// captures a reason, and calls the ONE refund engine, POST /pos/orders/:id/
// refund (a sold order — any amount up to what is still refundable, caps and
// a manager PIN above your limit, cash out of the drawer open now), or the
// one staff cancel, /orders/:id/cancel (not sold yet). The refund's own
// journal entry, the SRB return and — once refunded in full — the restores
// and the credit note all happen server-side.

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api, ordersApi } from '../../lib/api'
import { fmtPkr } from '../../lib/money'
import { refundThroughEngine } from './refundEngine'

interface Order {
  id: string
  status: string
  source: string
  totalCents: number
  customerName: string | null
  placedAt: string
  completedAt: string | null
  concept: { name: string; slug: string }
  items: Array<{ name: string; quantity: number }>
}

const REASON_PRESETS = [
  'Quality issue — food not up to standard',
  'Wrong item delivered',
  'Missing items',
  'Late delivery / customer-no-longer-wanted',
  'Customer complaint resolved with refund',
  'Duplicate order',
  'POS error',
] as const

export default function RefundsPage() {
  const qc = useQueryClient()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [mode, setMode] = useState<'refund' | 'cancel'>('refund')
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState<'' | 'cash' | 'card'>('')
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['refundable-orders'],
    queryFn: () => api.get<{ data: Order[] }>('/orders?status=completed,preparing,received,confirmed,ready&limit=100'),
  })

  const refund = useMutation({
    mutationFn: async (order: Order) => {
      if (mode === 'cancel') { await ordersApi.cancel(order.id, reason); return null }
      const amountCents = amount.trim() ? Math.round(parseFloat(amount) * 100) : order.totalCents
      return refundThroughEngine(order.id, { amountCents, reason: reason.trim(), ...(method && { method }) })
    },
    onSuccess: (r) => {
      setFeedback({
        ok: true,
        msg: mode === 'cancel'
          ? 'Order cancelled — wallet, gift card and points given back.'
          : r?.orderRefunded
            ? `Refunded in full (${fmtPkr(r.amountCents * -1)}) and booked. Credit note and customer restores issued.`
            : `Refunded ${fmtPkr((r?.amountCents ?? 0) * -1)} and booked. The rest of the order still stands.`,
      })
      setSelectedId(null); setReason(''); setAmount(''); setMethod('')
      void qc.invalidateQueries({ queryKey: ['refundable-orders'] })
    },
    onError: (err: { message?: string }) => setFeedback({ ok: false, msg: err.message ?? 'Refund failed' }),
  })

  const orders = (data?.data ?? []).filter((o) => !['refunded', 'cancelled'].includes(o.status))
  const selectedOrder = orders.find((o) => o.id === selectedId)

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-6 py-4">
        <p className="text-xs text-s-muted">Operations</p>
        <h1 className="text-xl font-bold text-s-text">Refunds & cancellations</h1>
        <p className="text-xs text-s-muted mt-1">
          A refund books its own entry (revenue and GST back), comes out of the drawer open now if paid in cash, and — once the order is refunded in full — issues the credit note and gives back points, wallet and gift-card balance. Reason required; a manager PIN above your limit.
        </p>
      </header>

      <div className="p-6 max-w-6xl mx-auto space-y-4">
        {feedback && (
          <div role={feedback.ok ? 'status' : 'alert'} className={`s-card p-3 text-sm ${feedback.ok ? 'border-l-4 border-s-teal' : 'border-l-4 border-s-red'}`}>
            <span className={feedback.ok ? 'text-primary-ink' : 'text-s-red'}>{feedback.msg}</span>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Order list */}
          <div className="lg:col-span-2 s-card overflow-hidden">
            <div className="px-4 py-3 border-b border-s-border bg-s-bg-soft">
              <h2 className="text-sm font-bold text-s-text">Refundable orders</h2>
            </div>
            <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-s-muted">
                <tr>
                  <th className="px-4 py-2 text-left">Order</th>
                  <th className="px-4 py-2 text-left">Brand</th>
                  <th className="px-4 py-2 text-left">Status</th>
                  <th className="px-4 py-2 text-right">Total</th>
                  <th className="px-4 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {isLoading && <tr><td colSpan={5} className="px-4 py-8 text-center text-xs text-s-muted">Loading…</td></tr>}
                {!isLoading && orders.length === 0 && (
                  <tr><td colSpan={5} className="px-4 py-8 text-center text-xs text-s-muted">No refundable orders right now.</td></tr>
                )}
                {orders.map((o) => (
                  <tr
                    key={o.id}
                    className={`border-t border-s-border cursor-pointer ${selectedId === o.id ? 'bg-s-bg-soft' : 'hover:bg-s-bg-soft'}`}
                    onClick={() => { setSelectedId(o.id); setFeedback(null) }}
                  >
                    <td className="px-4 py-2">
                      <p className="text-s-text">{o.customerName ?? 'Walk-in'}</p>
                      <p className="text-[11px] text-s-dim font-mono">#{o.id.slice(0, 8)} · {new Date(o.placedAt).toLocaleString()}</p>
                    </td>
                    <td className="px-4 py-2 text-xs text-s-text">{o.concept.name}</td>
                    <td className="px-4 py-2 text-xs">
                      <span className="bg-s-bg-soft border border-s-border rounded px-1.5 py-0.5 capitalize">{o.status}</span>
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-xs text-s-text">{fmtPkr(o.totalCents)}</td>
                    <td className="px-4 py-2 text-right">
                      <span className="text-xs text-primary-ink">{selectedId === o.id ? '●' : 'Select →'}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>

          {/* Refund panel */}
          <div className="s-card overflow-hidden h-fit sticky top-24">
            <div className="px-4 py-3 border-b border-s-border bg-s-bg-soft">
              <h2 className="text-sm font-bold text-s-text">Issue refund</h2>
            </div>

            {!selectedOrder ? (
              <div className="px-4 py-8 text-center text-xs text-s-muted">
                Select an order to refund.
              </div>
            ) : (
              <div className="p-4 space-y-3">
                <div className="bg-s-bg-soft border border-s-border rounded p-3 text-xs">
                  <p className="font-mono text-s-muted mb-1">#{selectedOrder.id.slice(0, 8)}</p>
                  <p className="font-semibold text-s-text">{selectedOrder.concept.name} · {fmtPkr(selectedOrder.totalCents)}</p>
                  <p className="text-s-muted mt-1">
                    {selectedOrder.items.slice(0, 3).map((i) => `${i.quantity}× ${i.name}`).join(', ')}
                    {selectedOrder.items.length > 3 && ` +${selectedOrder.items.length - 3}`}
                  </p>
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-semibold text-s-muted">Mode</label>
                  <div className="flex gap-2">
                    <button onClick={() => setMode('refund')} aria-pressed={mode === 'refund'}
                      className={`flex-1 py-1.5 rounded text-xs font-semibold border ${mode === 'refund' ? 'bg-s-red text-[#fff] border-s-red' : 'border-s-border text-s-text bg-s-surface'}`}>
                      Refund (paid)
                    </button>
                    <button onClick={() => setMode('cancel')} aria-pressed={mode === 'cancel'}
                      className={`flex-1 py-1.5 rounded text-xs font-semibold border ${mode === 'cancel' ? 'bg-s-amber text-[#fff] border-s-amber' : 'border-s-border text-s-text bg-s-surface'}`}>
                      Cancel (unpaid)
                    </button>
                  </div>
                </div>

                {mode === 'refund' && selectedOrder.status !== 'completed' && (
                  <p className="text-xs text-s-amber">This order has not been sold yet — cancel it instead.</p>
                )}
                {mode === 'refund' && (
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <label htmlFor="refund-amount" className="text-xs font-semibold text-s-muted">Amount (PKR)</label>
                      <input id="refund-amount" type="number" min="1" step="1" inputMode="decimal"
                        value={amount} onChange={(e) => setAmount(e.target.value)}
                        placeholder={(selectedOrder.totalCents / 100).toFixed(0)}
                        className="w-full bg-s-surface border border-s-border rounded px-2 py-1.5 text-sm text-s-text" />
                    </div>
                    <div className="space-y-1">
                      <label htmlFor="refund-method" className="text-xs font-semibold text-s-muted">Give back as</label>
                      <select id="refund-method" value={method} onChange={(e) => setMethod(e.target.value as '' | 'cash' | 'card')}
                        className="w-full bg-s-surface border border-s-border rounded px-2 py-1.5 text-sm text-s-text">
                        <option value="">Same as paid</option>
                        <option value="cash">Cash (from my open drawer)</option>
                        <option value="card">Card reversal</option>
                      </select>
                    </div>
                  </div>
                )}

                <div className="space-y-1">
                  <label className="text-xs font-semibold text-s-muted">Reason (required)</label>
                  <select
                    value={REASON_PRESETS.includes(reason as never) ? reason : ''}
                    onChange={(e) => setReason(e.target.value)}
                    className="w-full bg-s-surface border border-s-border rounded px-2 py-1.5 text-sm text-s-text"
                  >
                    <option value="">— Select preset or type below —</option>
                    {REASON_PRESETS.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                  <textarea
                    rows={3}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="Or describe in your own words…"
                    className="w-full bg-s-surface border border-s-border rounded px-2 py-1.5 text-sm text-s-text"
                  />
                </div>

                <button
                  onClick={() => refund.mutate(selectedOrder)}
                  disabled={refund.isPending || reason.trim().length < 3 || (mode === 'refund' && selectedOrder.status !== 'completed')}
                  className="w-full py-2 rounded font-bold text-sm bg-s-red text-[#fff] disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {refund.isPending ? 'Processing…' : `${mode === 'cancel' ? 'Cancel' : 'Refund'} this order`}
                </button>
                <p className="text-[10px] text-s-dim">
                  {mode === 'refund'
                    ? 'Leave the amount blank to refund in full. A cash refund needs an open drawer (yours).'
                    : 'Cancelling gives back what the customer spent at checkout and returns the stock.'}
                </p>
              </div>
            )}
          </div>
        </div>

        <p className="text-xs text-s-muted">
          Audit trail of every refund: <Link href="/accounting/audit-log?action=order" className="text-primary-ink hover:underline">view in audit log</Link>.
        </p>
      </div>
    </div>
  )
}
