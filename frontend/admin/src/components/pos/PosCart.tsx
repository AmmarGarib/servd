'use client'
import { useState } from 'react'
import { X } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { usePosStore } from '../../store/pos'
import { fmtPkrWhole } from '../../lib/money'
import { orderRef } from '../../lib/orderRef'
import { boxGiven, boxGivenErrorMessage, boxGivenOffer, useCartQuote, useOpenTickets, type TillOrder, type TillOrderItem } from './tillApi'

interface PosCartProps {
  conceptId: string | null
  onCheckout: () => void
  /** Phone drawer: the one header gets the close button. Absent on the side rail. */
  onClose?: () => void
}

// The cart shows the food value and, when the API can quote a cart, the
// server's bill for cash and for card / Raast QR (one digital tax group at
// the card rate). It never works out GST itself (FOH-02):
// the bill that is charged is the one the server returns at ring-up.
//
// Below the cart, "Box given" lists the brand's OPEN dine-in tickets (the same
// tickets as "Open tickets") with a Box given toggle on each plate line: tap it
// when a table takes leftovers home, so the dish's packaging is counted
// (packaging rule, owner 2026-10-13). A line that already counts its packaging
// (takeaway, delivery, a packaging-vessel brand like Stackd) shows nothing.
// The cart itself has no order yet, so it has nothing to box.
export function PosCart({ conceptId, onCheckout, onClose }: PosCartProps) {
  const { cart, removeItem, updateItemQty, updateItemNotes, discountCents, itemTotalCents, lines } = usePosStore()
  const items = itemTotalCents()
  const cartLines = lines()
  const cashQuote = useCartQuote(conceptId, cartLines, discountCents, 'cash')
  const cardQuote = useCartQuote(conceptId, cartLines, discountCents, 'card')
  const cash = cashQuote.data ?? null
  const card = cardQuote.data ?? null

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-kds-border py-3 pl-4 pr-1">
        <div>
          <h2 className="font-bold text-kds-text">Current Order</h2>
          <p className="text-xs text-kds-subtext">{cart.length} item{cart.length !== 1 ? 's' : ''}</p>
        </div>
        {onClose && (
          <button type="button" data-dialog-close onClick={onClose} aria-label="Close order"
            className="flex h-11 w-11 shrink-0 items-center justify-center text-kds-subtext hover:text-kds-text"><X size={20} aria-hidden="true" /></button>
        )}
      </div>

      {/* Items */}
      <div className="flex-1 overflow-y-auto">
        {cart.length === 0 ? (
          <div className="flex h-full items-center justify-center text-kds-subtext">
            <p className="text-center text-sm">Tap an item to add it</p>
          </div>
        ) : (
          <div className="divide-y divide-kds-border">
            {cart.map((item) => (
              <div key={item.id} className="px-4 py-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1">
                    <p className="font-semibold text-kds-text leading-tight">{item.name}</p>
                    {item.modifiers.map((m, i) => (
                      <p key={i} className="text-xs text-kds-subtext">+ {m.name}</p>
                    ))}
                  </div>
                  <div className="text-right text-sm font-bold text-kds-green">
                    {fmtPkrWhole((item.unitPriceCents + item.modifiers.reduce((s, m) => s + m.priceDeltaCents, 0)) * item.quantity)}
                  </div>
                </div>

                {/* Qty controls — F13: bumped from h-8 to h-11 (44px Apple HIG
                    minimum) so adjacent buttons no longer mistap on iPad. Added
                    aria-labels so VoiceOver reads each button distinctly. */}
                <div className="mt-2 flex items-center gap-2">
                  <button
                    onClick={() => updateItemQty(item.id, item.quantity - 1)}
                    aria-label={`Decrease quantity of ${item.name}`}
                    className="h-11 w-11 shrink-0 rounded-lg bg-kds-border text-base font-bold text-kds-text active:bg-kds-border/70"
                  >
                    −
                  </button>
                  <span className="w-8 shrink-0 text-center font-bold text-kds-text text-base" aria-live="polite">{item.quantity}</span>
                  <button
                    onClick={() => updateItemQty(item.id, item.quantity + 1)}
                    aria-label={`Increase quantity of ${item.name}`}
                    className="h-11 w-11 shrink-0 rounded-lg bg-kds-border text-base font-bold text-kds-text active:bg-kds-border/70"
                  >
                    +
                  </button>
                  <button
                    onClick={() => removeItem(item.id)}
                    className="ml-auto h-11 w-11 shrink-0 rounded-lg bg-kds-red/20 text-kds-red font-bold active:bg-kds-red/30"
                    aria-label={`Remove ${item.name} from cart`}
                  >
                    <X size={18} aria-hidden="true" className="mx-auto" />
                  </button>
                </div>
                <input
                  type="text"
                  placeholder="Note…"
                  aria-label={`Note for ${item.name}`}
                  value={item.notes}
                  onChange={(e) => updateItemNotes(item.id, e.target.value)}
                  className="mt-2 w-full rounded border border-kds-border bg-transparent px-2 py-2 text-xs text-kds-text placeholder:text-kds-subtext"
                />
              </div>
            ))}
          </div>
        )}
      </div>

      <BoxGivenTickets conceptId={conceptId} />

      {/* Totals — food value here; GST and service charge are the server's */}
      <div className="border-t border-kds-border px-4 py-3 space-y-1">
        <div className="flex justify-between text-sm text-kds-subtext">
          <span>Items</span>
          <span>{fmtPkrWhole(items)}</span>
        </div>
        {discountCents > 0 && (
          <div className="flex justify-between text-sm text-kds-amber">
            <span>Discount</span>
            <span>−{fmtPkrWhole(discountCents)}</span>
          </div>
        )}
        {cart.length > 0 && cash && (
          <>
            <div className="flex justify-between text-sm text-kds-subtext">
              <span>GST, cash ({cash.taxRatePct}%)</span>
              <span>{fmtPkrWhole(cash.taxCents)}</span>
            </div>
            {cash.serviceChargeCents > 0 && (
              <div className="flex justify-between text-sm text-kds-subtext">
                <span>Service charge</span>
                <span>{fmtPkrWhole(cash.serviceChargeCents)}</span>
              </div>
            )}
            <div className="flex justify-between font-bold text-kds-text text-base">
              <span>Total, cash</span>
              <span className="text-kds-green">{fmtPkrWhole(cash.totalCents)}</span>
            </div>
            {card && (
              <div className="flex justify-between text-sm text-kds-subtext">
                <span>Card / Raast total ({card.taxRatePct}% GST)</span>
                <span>{fmtPkrWhole(card.totalCents)}</span>
              </div>
            )}
          </>
        )}
        {cart.length > 0 && !cash && (
          cashQuote.isError ? (
            <p className="pt-1 text-xs font-semibold text-kds-amber">
              {cashQuote.error instanceof Error ? cashQuote.error.message : 'The server could not price this order'}
            </p>
          ) : (
            <p className="pt-1 text-xs text-kds-subtext">
              {cashQuote.isFetching
                ? 'Getting the bill from the server…'
                : 'GST (cash, or card / Raast rate) and any service charge are added by the server when you ring this up.'}
            </p>
          )
        )}
      </div>

      {/* Checkout */}
      <div className="border-t border-kds-border p-4">
        <button
          onClick={onCheckout}
          disabled={cart.length === 0 || !conceptId}
          className="w-full rounded-xl bg-kds-green py-4 text-lg font-bold text-primary-on disabled:opacity-30 active:scale-95"
        >
          {cash ? `Charge ${fmtPkrWhole(cash.totalCents)}` : 'Charge'}
        </button>
      </div>
    </div>
  )
}

// ─── Box given ───────────────────────────────────────────────────────────────

function BoxGivenTickets({ conceptId }: { conceptId: string | null }) {
  const qc = useQueryClient()
  const tickets = useOpenTickets(conceptId)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<{ itemId: string; text: string } | null>(null)

  const rows = (tickets.data ?? [])
    .map((order) => ({
      order,
      lines: order.items
        .map((item) => ({ item, offer: boxGivenOffer(order, item) }))
        .filter((l) => l.offer !== 'hidden'),
    }))
    .filter((r) => r.lines.length > 0)
  if (rows.length === 0) return null

  async function tap(order: TillOrder, item: TillOrderItem, undo: boolean) {
    setError(null)
    setBusy(item.id)
    try {
      await boxGiven(order.id, item.id, undo)
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['pos', 'open-tickets'] }),
        qc.invalidateQueries({ queryKey: ['order-detail', order.id] }),
      ])
    } catch (e) {
      setError({ itemId: item.id, text: boxGivenErrorMessage(e) })
      // The ticket may have moved on (paid, voided): show what the server has now.
      void qc.invalidateQueries({ queryKey: ['pos', 'open-tickets'] })
    } finally {
      setBusy(null)
    }
  }

  return (
    <details className="shrink-0 border-t border-kds-border">
      <summary className="flex min-h-[44px] cursor-pointer items-center justify-between px-4 py-2 text-sm font-semibold text-kds-text">
        <span>Box given</span>
        <span className="text-xs font-normal text-kds-subtext">{rows.length} open table{rows.length !== 1 ? 's' : ''}</span>
      </summary>
      <div className="max-h-56 overflow-y-auto px-4 pb-3">
        <p className="pb-2 text-xs text-kds-subtext">
          Tap when a table takes leftovers home. The box is then counted in the dish&apos;s cost.
        </p>
        <div className="space-y-3">
          {rows.map(({ order, lines }) => (
            <div key={order.id}>
              <p className="text-xs font-bold text-kds-subtext">
                {order.table?.label ? `Table ${order.table.label}` : 'Ticket'} · {orderRef(order.id)}
              </p>
              <ul className="mt-1 divide-y divide-kds-border">
                {lines.map(({ item, offer }) => (
                  <li key={item.id} className="py-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 flex-1 text-sm text-kds-text">
                        <span className="font-semibold">{item.quantity}×</span> {item.name}
                      </span>
                      {offer === 'box' ? (
                        <button
                          onClick={() => void tap(order, item, false)}
                          disabled={busy === item.id}
                          aria-label={`Box given for ${item.name}`}
                          className="h-10 shrink-0 rounded-lg border border-kds-border px-3 text-xs font-bold text-kds-text disabled:opacity-40 active:bg-kds-border/70"
                        >
                          {busy === item.id ? 'Saving…' : 'Box given'}
                        </button>
                      ) : (
                        <span className="flex shrink-0 items-center gap-2">
                          <span className="rounded-full bg-kds-green/15 px-2 py-0.5 text-[11px] font-bold text-kds-green">Boxed</span>
                          {offer === 'boxed_undo' && (
                            <button
                              onClick={() => void tap(order, item, true)}
                              disabled={busy === item.id}
                              aria-label={`Take back Box given for ${item.name}`}
                              className="h-10 rounded-lg px-2 text-xs font-bold text-kds-subtext underline disabled:opacity-40"
                            >
                              {busy === item.id ? 'Saving…' : 'Undo'}
                            </button>
                          )}
                        </span>
                      )}
                    </div>
                    {error?.itemId === item.id && (
                      <p className="mt-1 text-xs font-semibold text-kds-red" role="alert">{error.text}</p>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </details>
  )
}
