'use client'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useParams } from 'next/navigation'
import { api, ApiError, ordersApi } from '../../../lib/api'
import { useAuthStore } from '../../../store/auth'
import { formatDistanceToNowStrict, format } from 'date-fns'
import Link from 'next/link'
import { fmtPkrWhole } from '../../../lib/money'

const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

// ─── Types ────────────────────────────────────────────────────────────────────

interface OrderDetail {
  id: string
  source: string
  status: string
  totalCents: number
  discountCents: number
  taxCents: number
  tipCents: number
  serviceChargeCents: number
  walletAmountCents: number
  loyaltyPointsEarned: number | null
  placedAt: string
  completedAt: string | null
  cancelledAt: string | null
  cancellationReason: string | null
  deliveryNotes: string | null
  curbsideVehicle: string | null
  curbsidePlate: string | null
  curbsideSpot: string | null
  curbsideArrivedAt: string | null
  concept: { name: string; slug: string }
  table: { label: string } | null
  customer: {
    id: string; name: string; phone: string | null; email: string | null
  } | null
  customerName: string | null
  rider: { id: string; name: string; phone: string } | null
  posStaff: { name: string } | null
  items: Array<{
    id: string
    name: string
    quantity: number
    unitPriceCents: number
    status: string
    course: number | null
    notes: string | null
    modifiers: Array<{ id: string; name: string; priceDeltaCents: number }>
    station: { name: string } | null
    menuItem: { imageUrl: string | null; nameUrdu: string | null } | null
  }>
  payments: Array<{
    id: string
    method: string
    amountCents: number
    status: string
    changeCents: number | null
  }>
  taxInvoices?: Array<{ id: string; invoiceNumber: string; type: 'invoice' | 'credit_note'; issuedAt: string }>
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function reprintReceipt(orderId: string) {
  const token = useAuthStore.getState().token   // F43
  const res = await fetch(`${API_URL}/api/v1/pos/receipt/${orderId}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) { alert('Receipt not available for this order'); return }
  const html = await res.text()
  const blob = new Blob([html], { type: 'text/html' })
  const url = URL.createObjectURL(blob)
  const win = window.open(url, '_blank', 'width=420,height=600')
  if (win) {
    win.addEventListener('load', () => { win.print(); URL.revokeObjectURL(url) })
  } else {
    URL.revokeObjectURL(url)
  }
}

// The numbered tax invoice / credit note, as issued (backend invoices/service).
async function openInvoice(invoiceId: string) {
  const token = useAuthStore.getState().token
  const res = await fetch(`${API_URL}/api/v1/invoices/${invoiceId}/html`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) { alert('Invoice not available'); return }
  const blob = new Blob([await res.text()], { type: 'text/html' })
  const url = URL.createObjectURL(blob)
  const win = window.open(url, '_blank', 'width=720,height=900')
  if (!win) URL.revokeObjectURL(url)
}

const STATUS_COLORS: Record<string, string> = {
  received:  'bg-kds-blue/20 text-kds-blue',
  confirmed: 'bg-kds-amber/20 text-kds-amber',
  preparing: 'bg-kds-amber/20 text-kds-amber',
  ready:     'bg-kds-green/20 text-kds-green',
  completed: 'bg-kds-subtext/20 text-kds-subtext',
  cancelled: 'bg-kds-red/20 text-kds-red',
  rejected:  'bg-kds-red/30 text-kds-red',
  refunded:  'bg-purple-900/20 text-purple-400',
}

const SOURCE_COLORS: Record<string, string> = {
  pos:       'bg-purple-900/40 text-purple-400',
  servd:     'bg-blue-900/40 text-kds-blue',
  cart:      'bg-orange-900/40 text-orange-400',
  manual:    'bg-kds-card text-kds-subtext',
}

const ITEM_STATUS_COLORS: Record<string, string> = {
  pending:   'text-kds-subtext bg-kds-bg',
  preparing: 'text-kds-amber bg-kds-amber/10',
  ready:     'text-kds-green bg-kds-green/10',
  bumped:    'text-kds-subtext/60 bg-kds-bg',
  held:      'text-kds-blue bg-kds-blue/10',
  recalled:  'text-kds-amber bg-kds-amber/10',
  voided:    'text-kds-red bg-kds-red/10',
}

const PAYMENT_COLORS: Record<string, string> = {
  cash:             'text-kds-green bg-kds-green/10',
  card:             'text-kds-blue bg-kds-blue/10',
  // F-PAY02: jazzcash/easypaisa keys kept here only for historical rows that
  // existed before the enum drop — the map is a defensive lookup, dead values
  // are harmless. New rows can only land as cash/card/keenu_qr/split/comp.
  jazzcash:         'text-orange-400 bg-orange-900/20',
  easypaisa:        'text-green-400 bg-green-900/20',
  keenu_qr:         'text-purple-400 bg-purple-900/20',
  comp:             'text-kds-subtext bg-kds-card',
  wallet:           'text-kds-amber bg-kds-amber/10',
}

const STATUS_NEXT: Record<string, string> = {
  received: 'confirmed',
  confirmed: 'preparing',
  preparing: 'ready',
  ready: 'completed',
}
const STATUS_CTA: Record<string, string> = {
  received: 'Confirm',
  confirmed: 'Fire to Kitchen',
  preparing: 'Mark Ready',
  ready: 'Complete',
}

// ─── Refund modal ─────────────────────────────────────────────────────────────

function RefundModal({
  orderId,
  onClose,
  onDone,
}: { orderId: string; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('')
  const [mode, setMode] = useState<'refund' | 'cancel'>('refund')

  const refund = useMutation({
    // Refund in full through the ONE refund engine (caps, manager PIN prompt
    // above your limit, cash out of your open drawer); part refunds are on /refunds.
    mutationFn: async () => {
      if (mode === 'cancel') return ordersApi.cancel(orderId, reason)
      const { refundThroughEngine } = await import('../../refunds/refundEngine')
      const order = await api.get<{ totalCents: number }>(`/orders/${orderId}`)
      return refundThroughEngine(orderId, { amountCents: order.totalCents, reason: reason.trim() })
    },
    onSuccess: () => { onDone(); onClose() },
  })

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
      <div className="bg-kds-card border border-kds-border rounded-2xl p-6 max-w-sm w-full space-y-4">
        <p className="font-bold text-kds-text text-lg">Refund / Cancel Order</p>
        <div className="flex gap-2">
          {(['refund', 'cancel'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`flex-1 py-2 rounded-lg text-sm font-semibold border transition-colors ${
                mode === m
                  ? 'bg-kds-green text-black border-kds-green'
                  : 'border-kds-border text-kds-subtext hover:text-kds-text'
              }`}>
              {m === 'refund' ? 'Refund' : 'Cancel (no refund)'}
            </button>
          ))}
        </div>
        <div>
          <label className="text-xs text-kds-subtext block mb-1">Reason (required)</label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder="Explain the reason for this refund/cancellation…"
            className="w-full rounded-lg border border-kds-border bg-kds-bg px-3 py-2 text-sm text-kds-text focus:border-kds-green focus:outline-none resize-none"
          />
        </div>
        {refund.isError && (
          <p className="text-sm text-kds-red">{(refund.error as Error).message}</p>
        )}
        <div className="flex gap-3">
          <button
            onClick={() => refund.mutate()}
            disabled={refund.isPending || reason.trim().length < 3}
            className="flex-1 rounded-xl bg-kds-red text-white text-sm font-bold py-2 hover:opacity-90 disabled:opacity-40">
            {refund.isPending ? 'Processing…' : mode === 'refund' ? 'Refund' : 'Cancel order'}
          </button>
          <button onClick={onClose} className="flex-1 rounded-xl border border-kds-border text-kds-subtext text-sm py-2 hover:border-kds-text">
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function OrderDetailPage() {
  const { id } = useParams<{ id: string }>()
  const qc = useQueryClient()

  const [refundOpen, setRefundOpen] = useState(false)
  const [noteOpen, setNoteOpen] = useState(false)
  const [noteDraft, setNoteDraft] = useState('')

  const { data: order, isLoading, isError } = useQuery<OrderDetail>({
    queryKey: ['order-detail', id],
    queryFn: () => api.get<OrderDetail>(`/orders/${id}`),
  })

  const updateStatus = useMutation({
    mutationFn: (status: string) => api.patch(`/orders/${id}/status`, { status }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['order-detail', id] }),
  })

  // Void one line through the POS void — the only void path: it enforces the
  // void caps at /configuration/refund-policy, asks for a manager PIN above
  // the cashier cap, requires a reason and is audited.
  const voidLine = useMutation({
    mutationFn: async ({ itemId, reason }: { itemId: string; reason: string }) => {
      const send = (managerOverridePin?: string) =>
        api.post(`/pos/orders/${id}/void`, { orderItemId: itemId, reason, ...(managerOverridePin && { managerOverridePin }) })
      try {
        return await send()
      } catch (err) {
        if (err instanceof ApiError && err.code === 'MANAGER_OVERRIDE_REQUIRED') {
          const pin = window.prompt(`${err.message}. Manager PIN:`)?.trim()
          if (!pin) return null
          return send(pin)
        }
        throw err
      }
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['order-detail', id] }),
    onError: (err: Error) => alert(err.message),
  })

  function promptVoid(itemId: string, name: string) {
    const reason = window.prompt(`Reason for voiding "${name}" (required):`)?.trim() ?? ''
    if (!reason) return
    voidLine.mutate({ itemId, reason })
  }

  const saveNote = useMutation({
    mutationFn: (note: string) => api.patch(`/orders/${id}/notes`, { notes: note }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['order-detail', id] })
      setNoteOpen(false)
    },
  })

  if (isLoading) {
    return (
      <div className="min-h-screen bg-kds-bg flex items-center justify-center">
        <p className="text-kds-subtext">Loading order…</p>
      </div>
    )
  }

  if (isError || !order) {
    return (
      <div className="min-h-screen bg-kds-bg flex items-center justify-center">
        <div className="text-center space-y-2">
          <p className="text-kds-red font-semibold">Order not found</p>
          <Link href="/orders" className="text-sm text-kds-subtext hover:text-kds-text">
            ← Back to orders
          </Link>
        </div>
      </div>
    )
  }

  // Compute financials
  const itemsSubtotal = order.items.reduce(
    (s, item) =>
      s + item.unitPriceCents * item.quantity +
      item.modifiers.reduce((ms, m) => ms + m.priceDeltaCents * item.quantity, 0),
    0,
  )
  const nextStatus = STATUS_NEXT[order.status]

  // Timeline events
  const timeline: { label: string; time: string | null }[] = [
    { label: 'Placed', time: order.placedAt },
    { label: 'Completed', time: order.completedAt ?? null },
    { label: 'Cancelled', time: order.cancelledAt ?? null },
  ].filter((e) => e.time !== null)

  return (
    <div className="min-h-screen bg-kds-bg">
      {refundOpen && (
        <RefundModal
          orderId={id}
          onClose={() => setRefundOpen(false)}
          onDone={() => void qc.invalidateQueries({ queryKey: ['order-detail', id] })}
        />
      )}

      {/* ── Header ── */}
      <header className="sticky top-0 z-10 bg-kds-bg/80 backdrop-blur border-b border-kds-border px-6 py-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <Link href="/orders" className="text-xs text-kds-subtext hover:text-kds-text">
              ← Orders
            </Link>
            <div className="flex items-center gap-3 mt-0.5">
              <h1 className="text-xl font-bold text-kds-text font-mono">
                #{order.id.slice(0, 8).toUpperCase()}
              </h1>
              <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold uppercase ${STATUS_COLORS[order.status] ?? ''}`}>
                {order.status}
              </span>
              <span className={`rounded px-2 py-0.5 text-xs font-bold uppercase ${SOURCE_COLORS[order.source] ?? ''}`}>
                {order.source}
              </span>
            </div>
            <p className="text-xs text-kds-subtext mt-0.5">
              {order.concept.name} ·{' '}
              {formatDistanceToNowStrict(new Date(order.placedAt))} ago ·{' '}
              {format(new Date(order.placedAt), 'dd MMM yyyy, HH:mm')}
            </p>
          </div>

          {/* Action buttons */}
          <div className="flex gap-2 flex-wrap justify-end">
            {nextStatus && (
              <button
                onClick={() => updateStatus.mutate(nextStatus)}
                disabled={updateStatus.isPending}
                className="rounded-xl bg-kds-green text-black text-sm font-bold px-4 py-2 hover:opacity-90 disabled:opacity-50">
                {updateStatus.isPending ? '…' : STATUS_CTA[order.status]}
              </button>
            )}
            <button
              onClick={() => {
                setNoteDraft(order.deliveryNotes ?? '')
                setNoteOpen(!noteOpen)
              }}
              className="rounded-xl border border-kds-border text-kds-subtext text-sm px-4 py-2 hover:border-kds-green hover:text-kds-green transition-colors">
              {order.deliveryNotes ? 'Edit Note' : '+ Note'}
            </button>
            <button
              onClick={() => void reprintReceipt(order.id)}
              className="rounded-xl border border-kds-border text-kds-subtext text-sm px-4 py-2 hover:border-purple-400 hover:text-purple-400 transition-colors">
              Print Receipt
            </button>
            {!['cancelled', 'refunded'].includes(order.status) && (
              <button
                onClick={() => setRefundOpen(true)}
                className="rounded-xl border border-kds-red/40 bg-kds-red/10 text-kds-red text-sm font-semibold px-4 py-2 hover:bg-kds-red/20 transition-colors">
                Refund
              </button>
            )}
          </div>
        </div>

        {/* Inline note editor */}
        {noteOpen && (
          <div className="mt-3 flex items-center gap-3">
            <input
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              placeholder="Add a note about this order…"
              className="flex-1 rounded-lg border border-kds-border bg-kds-bg px-3 py-2 text-sm text-kds-text focus:border-kds-green focus:outline-none"
              autoFocus
            />
            <button
              onClick={() => saveNote.mutate(noteDraft)}
              disabled={saveNote.isPending}
              className="rounded-lg bg-kds-green text-black font-bold px-4 py-2 text-xs hover:opacity-90 disabled:opacity-50">
              {saveNote.isPending ? 'Saving…' : 'Save'}
            </button>
            <button
              onClick={() => setNoteOpen(false)}
              className="text-xs text-kds-subtext hover:text-kds-text">
              Cancel
            </button>
          </div>
        )}
      </header>

      <div className="p-6 max-w-5xl mx-auto space-y-5">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">

          {/* ── Left column: Customer + Fulfilment + Timeline ── */}
          <div className="space-y-5">

            {/* Customer */}
            <div className="rounded-xl border border-kds-border bg-kds-card p-4">
              <p className="text-xs font-bold text-kds-subtext uppercase tracking-widest mb-3">Customer</p>
              {order.customer ? (
                <div className="space-y-1">
                  <Link
                    href={`/crm?customer=${order.customer.id}`}
                    className="text-sm font-semibold text-kds-green hover:underline">
                    {order.customer.name}
                  </Link>
                  {order.customer.phone && (
                    <p className="text-sm text-kds-subtext">{order.customer.phone}</p>
                  )}
                  {order.customer.email && (
                    <p className="text-xs text-kds-subtext">{order.customer.email}</p>
                  )}
                  {order.loyaltyPointsEarned != null && (
                    <p className="text-xs text-kds-amber mt-1">
                      +{order.loyaltyPointsEarned} loyalty pts earned
                    </p>
                  )}
                </div>
              ) : (
                <div className="space-y-1">
                  <p className="text-sm font-semibold text-kds-text">
                    {order.customerName ?? order.table?.label ?? 'Guest'}
                  </p>
                  <p className="text-xs text-kds-subtext">No linked account</p>
                </div>
              )}
              {order.posStaff && (
                <p className="text-xs text-kds-subtext mt-2">
                  Served by: <span className="text-kds-text">{order.posStaff.name}</span>
                </p>
              )}
            </div>

            {/* Fulfilment */}
            <div className="rounded-xl border border-kds-border bg-kds-card p-4">
              <p className="text-xs font-bold text-kds-subtext uppercase tracking-widest mb-3">Fulfilment</p>
              {order.curbsideVehicle ? (
                <div className="space-y-1.5 text-sm">
                  <p className="font-semibold text-kds-green">Curbside pickup</p>
                  <p className="text-kds-subtext">Vehicle: {order.curbsideVehicle}</p>
                  {order.curbsidePlate && <p className="text-kds-subtext">Plate: {order.curbsidePlate}</p>}
                  {order.curbsideSpot && <p className="text-kds-subtext">Spot: {order.curbsideSpot}</p>}
                  {order.curbsideArrivedAt ? (
                    <p className="text-xs text-kds-green">
                      Arrived {formatDistanceToNowStrict(new Date(order.curbsideArrivedAt))} ago
                    </p>
                  ) : (
                    <p className="text-xs text-kds-amber">En route</p>
                  )}
                </div>
              ) : order.rider ? (
                <div className="space-y-1 text-sm">
                  <p className="font-semibold text-kds-text">Delivery</p>
                  {order.deliveryNotes && <p className="text-kds-subtext text-xs">{order.deliveryNotes}</p>}
                  <div className="pt-2 border-t border-kds-border/50 mt-2">
                    <p className="text-xs text-kds-subtext">Rider: <span className="text-kds-text font-semibold">{order.rider.name}</span></p>
                    <p className="text-xs text-kds-subtext">{order.rider.phone}</p>
                  </div>
                </div>
              ) : order.table ? (
                <div className="text-sm">
                  <p className="font-semibold text-kds-text">Dine-in</p>
                  <p className="text-kds-subtext">Table {order.table.label}</p>
                </div>
              ) : (
                <p className="text-sm text-kds-subtext capitalize">{order.source === 'pos' ? 'Point of sale' : 'Takeaway / pickup'}</p>
              )}
              {order.deliveryNotes && (
                <div className="mt-3 pt-3 border-t border-kds-border/50">
                  <p className="text-xs text-kds-subtext">Note:</p>
                  <p className="text-sm text-kds-text mt-0.5">{order.deliveryNotes}</p>
                </div>
              )}
            </div>

            {/* Timeline */}
            {timeline.length > 0 && (
              <div className="rounded-xl border border-kds-border bg-kds-card p-4">
                <p className="text-xs font-bold text-kds-subtext uppercase tracking-widest mb-3">Timeline</p>
                <div className="relative pl-4">
                  {timeline.map((ev, i) => (
                    <div key={ev.label} className="relative mb-3 last:mb-0">
                      {/* Line */}
                      {i < timeline.length - 1 && (
                        <div className="absolute left-[-9px] top-4 w-px h-full bg-kds-border" />
                      )}
                      {/* Dot */}
                      <div className="absolute left-[-13px] top-1.5 h-2 w-2 rounded-full bg-kds-green" />
                      <p className="text-xs font-semibold text-kds-text">{ev.label}</p>
                      <p className="text-[11px] text-kds-subtext">
                        {ev.time ? format(new Date(ev.time), 'dd MMM yyyy, HH:mm') : '—'}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* ── Right column: Items + Financials ── */}
          <div className="lg:col-span-2 space-y-5">

            {/* Items table */}
            <div className="rounded-xl border border-kds-border overflow-hidden">
              <div className="px-4 py-3 bg-kds-card border-b border-kds-border flex items-center justify-between">
                <p className="text-xs font-bold text-kds-subtext uppercase tracking-widest">
                  Items ({order.items.length})
                </p>
              </div>
              <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-kds-card/50 border-b border-kds-border">
                  <tr>
                    {['Item', 'Qty', 'Unit Price', 'Subtotal', 'Status', ''].map((h) => (
                      <th key={h} className="px-4 py-2.5 text-left text-xs font-semibold text-kds-subtext">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-kds-border">
                  {order.items.map((item) => {
                    const modifiersTotal = item.modifiers.reduce((s, m) => s + m.priceDeltaCents, 0)
                    const effectivePrice = item.unitPriceCents + modifiersTotal
                    const lineTotal = effectivePrice * item.quantity
                    return (
                      <tr key={item.id} className="hover:bg-kds-card/40">
                        <td className="px-4 py-3">
                          <p className="font-medium text-kds-text">{item.name}</p>
                          {item.modifiers.length > 0 && (
                            <p className="text-xs text-kds-subtext mt-0.5">
                              {item.modifiers.map((m) =>
                                `${m.name}${m.priceDeltaCents !== 0 ? ` (${m.priceDeltaCents > 0 ? '+' : ''}${fmtPkrWhole(m.priceDeltaCents)})` : ''}`
                              ).join(', ')}
                            </p>
                          )}
                          {item.notes && (
                            <p className="text-xs text-kds-amber mt-0.5 italic">{item.notes}</p>
                          )}
                          {item.station && (
                            <p className="text-[10px] text-kds-subtext/60 mt-0.5">{item.station.name}</p>
                          )}
                        </td>
                        <td className="px-4 py-3 text-kds-subtext">{item.quantity}</td>
                        <td className="px-4 py-3 font-mono text-xs text-kds-text">{fmtPkrWhole(effectivePrice)}</td>
                        <td className="px-4 py-3 font-mono text-xs font-bold text-kds-green">{fmtPkrWhole(lineTotal)}</td>
                        <td className="px-4 py-3">
                          <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${ITEM_STATUS_COLORS[item.status] ?? 'text-kds-subtext'}`}>
                            {item.status}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right">
                          {item.status !== 'voided' && !['cancelled', 'rejected', 'refunded'].includes(order.status) && (
                            <button
                              onClick={() => promptVoid(item.id, item.name)}
                              disabled={voidLine.isPending}
                              className="rounded-lg border border-kds-red/40 text-kds-red text-[11px] font-semibold px-2 py-1 hover:bg-kds-red/10 transition-colors disabled:opacity-50">
                              Void
                            </button>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
              </div>
            </div>

            {/* Financials */}
            <div className="rounded-xl border border-kds-border bg-kds-card p-4">
              <p className="text-xs font-bold text-kds-subtext uppercase tracking-widest mb-3">Financials</p>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-kds-subtext">Items subtotal</span>
                  <span className="font-mono text-kds-text">{fmtPkrWhole(itemsSubtotal)}</span>
                </div>
                {order.taxCents > 0 && (
                  <div className="flex justify-between">
                    <span className="text-kds-subtext">Tax</span>
                    <span className="font-mono text-kds-text">{fmtPkrWhole(order.taxCents)}</span>
                  </div>
                )}
                {order.tipCents > 0 && (
                  <div className="flex justify-between">
                    <span className="text-kds-subtext">Tip</span>
                    <span className="font-mono text-kds-text">{fmtPkrWhole(order.tipCents)}</span>
                  </div>
                )}
                {order.serviceChargeCents > 0 && (
                  <div className="flex justify-between">
                    <span className="text-kds-subtext">Service charge</span>
                    <span className="font-mono text-kds-text">{fmtPkrWhole(order.serviceChargeCents)}</span>
                  </div>
                )}
                {order.discountCents > 0 && (
                  <div className="flex justify-between">
                    <span className="text-kds-subtext">Discount</span>
                    <span className="font-mono text-kds-red">-{fmtPkrWhole(order.discountCents)}</span>
                  </div>
                )}
                {order.walletAmountCents > 0 && (
                  <div className="flex justify-between">
                    <span className="text-kds-subtext">Wallet used</span>
                    <span className="font-mono text-kds-amber">-{fmtPkrWhole(order.walletAmountCents)}</span>
                  </div>
                )}
                <div className="flex justify-between pt-2 border-t border-kds-border">
                  <span className="font-bold text-kds-text">Total</span>
                  <span className="font-mono font-bold text-kds-green text-base">{fmtPkrWhole(order.totalCents)}</span>
                </div>
              </div>

              {/* Payments */}
              {order.payments.length > 0 && (
                <div className="mt-4 pt-4 border-t border-kds-border space-y-2">
                  <p className="text-xs font-bold text-kds-subtext uppercase tracking-widest mb-2">Payments</p>
                  {order.payments.map((p) => (
                    <div key={p.id} className="flex items-center justify-between">
                      <span className={`rounded px-2 py-0.5 text-xs font-bold uppercase ${PAYMENT_COLORS[p.method] ?? 'text-kds-subtext bg-kds-bg'}`}>
                        {p.method.replace('_', ' ')}
                      </span>
                      <div className="text-right">
                        <span className="font-mono text-sm font-bold text-kds-green">{fmtPkrWhole(p.amountCents)}</span>
                        {p.changeCents != null && p.changeCents > 0 && (
                          <p className="text-xs text-kds-subtext">Change: {fmtPkrWhole(p.changeCents)}</p>
                        )}
                        <p className="text-[10px] text-kds-subtext capitalize">{p.status}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Tax documents — the numbered invoice and any credit notes */}
              {(order.taxInvoices?.length ?? 0) > 0 && (
                <div className="mt-4 pt-4 border-t border-kds-border space-y-2">
                  <p className="text-xs font-bold text-kds-subtext uppercase tracking-widest mb-2">Tax documents</p>
                  {order.taxInvoices!.map((inv) => (
                    <div key={inv.id} className="flex items-center justify-between gap-3">
                      <div>
                        <p className="font-mono text-sm text-kds-text">{inv.invoiceNumber}</p>
                        <p className="text-[10px] text-kds-subtext">
                          {inv.type === 'credit_note' ? 'Credit note' : 'Tax invoice'} · {format(new Date(inv.issuedAt), 'dd MMM yyyy, HH:mm')}
                        </p>
                      </div>
                      <button
                        onClick={() => void openInvoice(inv.id)}
                        className="rounded-lg border border-kds-border text-kds-subtext text-xs px-3 py-1.5 hover:border-kds-green hover:text-kds-green transition-colors">
                        View
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

          </div>
        </div>
      </div>
    </div>
  )
}
