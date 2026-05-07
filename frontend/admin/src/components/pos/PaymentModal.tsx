'use client'
import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { posApi } from '../../lib/api'
import { usePosStore } from '../../store/pos'

interface PaymentModalProps {
  taxRate: number
  onClose: () => void
}

type PaymentMethod = 'cash' | 'card' | 'jazzcash_wallet' | 'easypaisa_wallet' | 'keenu_qr' | 'comp'

export function PaymentModal({ taxRate, onClose }: PaymentModalProps) {
  const { cart, totalCents, discountCents, discountReason, conceptId, shiftId, tableId, customerId, clearCart } = usePosStore()
  const total = totalCents(taxRate)

  const [method, setMethod] = useState<PaymentMethod>('cash')
  const [tendered, setTendered] = useState('')
  const [compReason, setCompReason] = useState('')
  const [createdOrderId, setCreatedOrderId] = useState<string | null>(null)

  const fmt = (cents: number) => `PKR ${(cents / 100).toFixed(0)}`

  const tenderedCents = method === 'cash' ? Math.round(parseFloat(tendered || '0') * 100) : 0
  const changeCents = method === 'cash' ? Math.max(0, tenderedCents - total) : 0

  const createAndPay = useMutation({
    mutationFn: async () => {
      // 1. Create POS order
      const order = await posApi.createOrder({
        conceptId,
        tableId,
        customerId,
        shiftId,
        discountCents,
        discountReason,
        items: cart.map((i) => ({
          menuItemId: i.menuItemId,
          name: i.name,
          quantity: i.quantity,
          unitPriceCents: i.unitPriceCents,
          notes: i.notes,
          course: i.course,
          modifiers: i.modifiers,
        })),
      })

      setCreatedOrderId(order.id)

      // 2. Process payment
      return posApi.processPayment({
        orderId: order.id,
        shiftId: shiftId!,
        payments: [
          {
            method,
            amountCents: method === 'comp' ? 0 : total,
            ...(method === 'cash' && { tenderedCents }),
            ...(method === 'comp' && { gateway: 'none' }),
          },
        ],
        complimentaryReason: compReason || undefined,
      })
    },
    onSuccess: () => {
      clearCart()
    },
  })

  const API_URL = process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3001'

  function printReceipt() {
    if (!createdOrderId) return
    const token = typeof window !== 'undefined' ? localStorage.getItem('servd_token') : null
    const win = window.open('', '_blank', 'width=400,height=600')
    if (!win) return
    win.document.write('<p style="font-family:monospace;padding:20px">Loading receipt…</p>')
    fetch(`${API_URL}/api/v1/pos/receipt/${createdOrderId}`, {
      headers: { ...(token && { Authorization: `Bearer ${token}` }) },
    })
      .then(r => r.text())
      .then(html => {
        win.document.open()
        win.document.write(html)
        win.document.close()
        win.focus()
        setTimeout(() => win.print(), 500)
      })
      .catch(() => win.close())
  }

  const METHODS: Array<{ id: PaymentMethod; label: string; emoji: string }> = [
    { id: 'cash', label: 'Cash', emoji: '💵' },
    { id: 'card', label: 'Card / Keenu', emoji: '💳' },
    { id: 'jazzcash_wallet', label: 'JazzCash', emoji: '📱' },
    { id: 'easypaisa_wallet', label: 'Easypaisa', emoji: '📲' },
    { id: 'keenu_qr', label: 'Keenu QR', emoji: '⬜' },
    { id: 'comp', label: 'Comp', emoji: '🎁' },
  ]

  if (!shiftId) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 px-4">
        <div className="w-full max-w-sm rounded-2xl bg-kds-card p-6 text-center space-y-4">
          <div className="text-4xl">⚠️</div>
          <h2 className="text-lg font-bold text-kds-text">No Shift Open</h2>
          <p className="text-sm text-kds-subtext">You need to open a shift before processing payments.</p>
          <div className="flex gap-3">
            <button onClick={onClose} className="flex-1 rounded-xl border border-kds-border py-3 text-kds-subtext">
              Cancel
            </button>
            <a href="/pos/shift" className="flex-1 rounded-xl bg-kds-green py-3 font-bold text-white text-center">
              Open Shift
            </a>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/80 sm:items-center">
      <div className="w-full max-w-sm rounded-t-2xl bg-kds-card p-5 sm:rounded-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold">Payment — {fmt(total)}</h2>
          <button onClick={onClose} className="text-kds-subtext text-xl">✕</button>
        </div>

        {/* Payment method selector */}
        <div className="mb-4 grid grid-cols-3 gap-2">
          {METHODS.map((m) => (
            <button
              key={m.id}
              onClick={() => setMethod(m.id)}
              className={`rounded-lg border py-3 text-center text-sm font-semibold transition-colors ${
                method === m.id
                  ? 'border-kds-green bg-kds-green/20 text-kds-green'
                  : 'border-kds-border text-kds-subtext'
              }`}
            >
              <div className="text-xl">{m.emoji}</div>
              <div>{m.label}</div>
            </button>
          ))}
        </div>

        {/* Cash tendered input */}
        {method === 'cash' && (
          <div className="mb-4">
            <label className="mb-1 block text-sm text-kds-subtext">Tendered Amount (PKR)</label>
            <input
              type="number"
              value={tendered}
              onChange={(e) => setTendered(e.target.value)}
              placeholder={`${total / 100}`}
              className="w-full rounded-lg border border-kds-border bg-kds-bg px-4 py-3 text-xl font-bold text-kds-green"
              autoFocus
            />
            {tenderedCents >= total && (
              <p className="mt-2 text-center text-lg font-bold text-kds-amber">
                Change: {fmt(changeCents)}
              </p>
            )}
          </div>
        )}

        {/* Comp reason */}
        {method === 'comp' && (
          <div className="mb-4">
            <label className="mb-1 block text-sm text-kds-subtext">Reason (required)</label>
            <input
              type="text"
              value={compReason}
              onChange={(e) => setCompReason(e.target.value)}
              placeholder="Staff meal, customer complaint…"
              className="w-full rounded-lg border border-kds-border bg-kds-bg px-3 py-2 text-kds-text"
            />
          </div>
        )}

        {/* Error */}
        {createAndPay.isError && (
          <p className="mb-3 text-sm text-kds-red">
            {createAndPay.error instanceof Error ? createAndPay.error.message : 'Payment failed'}
          </p>
        )}

        {/* Success state */}
        {createAndPay.isSuccess ? (
          <div className="space-y-3">
            <div className="rounded-xl bg-kds-green/10 border border-kds-green/30 py-3 text-center">
              <div className="text-2xl mb-1">✓</div>
              <p className="font-bold text-kds-green">Payment Complete</p>
              {method === 'cash' && changeCents > 0 && (
                <p className="text-sm text-kds-amber mt-1">Change: {fmt(changeCents)}</p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <button onClick={printReceipt}
                className="rounded-xl border border-kds-border py-3 text-sm font-bold text-kds-text hover:bg-kds-border/30">
                🖨 Print Receipt
              </button>
              <button onClick={onClose}
                className="rounded-xl bg-kds-green py-3 text-sm font-bold text-white">
                Done →
              </button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => createAndPay.mutate()}
            disabled={
              createAndPay.isPending ||
              (method === 'cash' && tenderedCents < total) ||
              (method === 'comp' && !compReason.trim())
            }
            className="w-full rounded-xl bg-kds-green py-4 text-lg font-bold text-white disabled:opacity-30 active:scale-95"
          >
            {createAndPay.isPending
              ? 'Processing…'
              : method === 'comp'
              ? 'Mark Complimentary'
              : `Confirm — ${fmt(total)}`}
          </button>
        )}
      </div>
    </div>
  )
}
