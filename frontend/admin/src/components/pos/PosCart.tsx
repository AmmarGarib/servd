'use client'
import { useState } from 'react'
import { X } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { usePosStore } from '../../store/pos'
import { fmtPkr, fmtPkrWhole } from '../../lib/money'
import { orderRef } from '../../lib/orderRef'
import { boxGiven, boxGivenErrorMessage, boxGivenOffer, useOpenTickets, type TillOrder, type TillOrderItem, tableName } from './tillApi'
import { useCartTotals } from './flow/flowApi'
import { RemoveIngredientsButton } from './RemoveIngredients'

interface PosCartProps {
  conceptId: string | null
}

// The cart of the order screen (owner's flow, step 5): each line with − qty +, its unit price and
// line total, then Amount, Tax and Total(n). Every figure is the SERVER's (POST /pos/quote with the
// fulfilment and delivery zone) — the cart never works out GST itself (FOH-02).
export function PosCart({ conceptId }: PosCartProps) {
  const { cart, removeItem, updateItemQty, updateItemNotes, updateItemRemovals, discountCents } = usePosStore()
  const { cash: cashQuote, card: cardQuote } = useCartTotals(conceptId)
  const cash = cashQuote.data ?? null
  const card = cardQuote.data ?? null
  const count = cart.reduce((n, i) => n + i.quantity, 0)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {cart.length === 0 ? (
          <div className="flex h-full min-h-[96px] items-center justify-center text-kds-subtext">
            <p className="text-center text-sm">0 item(s) in cart. Tap an item to add it.</p>
          </div>
        ) : (
          <ul className="divide-y divide-kds-border">
            {cart.map((item) => {
              const unit = item.unitPriceCents + item.modifiers.reduce((s, m) => s + m.priceDeltaCents, 0)
              return (
                <li key={item.id} className="px-3 py-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold leading-tight text-kds-text">{item.name}</p>
                      {item.modifiers.map((m, i) => <p key={i} className="text-xs text-kds-subtext">+ {m.name}</p>)}
                      {(item.removedIngredients ?? []).map((r) => <p key={r.key} className="text-xs font-semibold text-kds-amber">No {r.name}</p>)}
                      <p className="text-xs text-kds-subtext">{fmtPkrWhole(unit)} each</p>
                    </div>
                    <div className="text-right text-sm font-bold text-kds-green">{fmtPkrWhole(unit * item.quantity)}</div>
                  </div>
                  {/* F13: 44px targets, labelled for screen readers. */}
                  <div className="mt-1 flex items-center gap-2">
                    <button type="button" onClick={() => updateItemQty(item.id, item.quantity - 1)} aria-label={`Decrease quantity of ${item.name}`}
                      className="h-11 w-11 shrink-0 rounded-lg bg-kds-border text-lg font-bold text-kds-text active:bg-kds-border/70">−</button>
                    <span className="w-8 shrink-0 text-center text-base font-bold text-kds-text" aria-live="polite">{item.quantity}</span>
                    <button type="button" onClick={() => updateItemQty(item.id, item.quantity + 1)} aria-label={`Increase quantity of ${item.name}`}
                      className="h-11 w-11 shrink-0 rounded-lg bg-kds-border text-lg font-bold text-kds-text active:bg-kds-border/70">+</button>
                    <input type="text" placeholder="Note…" aria-label={`Note for ${item.name}`} value={item.notes} onChange={(e) => updateItemNotes(item.id, e.target.value)}
                      className="min-h-11 min-w-0 flex-1 rounded border border-kds-border bg-transparent px-2 text-xs text-kds-text placeholder:text-kds-subtext" />
                    <RemoveIngredientsButton menuItemId={item.menuItemId} itemName={item.name} value={item.removedIngredients ?? []}
                      onChange={(next) => updateItemRemovals(item.id, next)} />
                    <button type="button" onClick={() => removeItem(item.id)} aria-label={`Remove ${item.name} from the order`}
                      className="h-11 w-11 shrink-0 rounded-lg bg-kds-red/20 font-bold text-kds-red active:bg-kds-red/30"><X size={18} aria-hidden="true" className="mx-auto" /></button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <BoxGivenTickets conceptId={conceptId} />

      {/* Amount, Tax, Total(n) — the server's figures */}
      <div className="shrink-0 space-y-1 border-t border-kds-border px-3 py-2 text-sm">
        <div className="flex justify-between text-kds-subtext"><span>Amount</span><span>{fmtPkr(cash?.itemTotalCents ?? 0)}</span></div>
        {(cash?.discountCents ?? discountCents) > 0 && <div className="flex justify-between text-kds-amber"><span>Discount</span><span>−{fmtPkr(cash?.discountCents ?? discountCents)}</span></div>}
        {cash && (cash.deliveryFeeCents ?? 0) > 0 && <div className="flex justify-between text-kds-subtext"><span>Delivery fee</span><span>{fmtPkr(cash.deliveryFeeCents!)}</span></div>}
        <div className="flex justify-between text-kds-subtext"><span>Tax{cash ? ` (cash ${cash.taxRatePct}%)` : ''}</span><span>{fmtPkr(cash?.taxCents ?? 0)}</span></div>
        {cash && cash.serviceChargeCents > 0 && <div className="flex justify-between text-kds-subtext"><span>Service charge</span><span>{fmtPkr(cash.serviceChargeCents)}</span></div>}
        <div className="flex justify-between text-base font-bold text-kds-text"><span>Total ({count})</span><span className="text-kds-green">{fmtPkr(cash?.totalCents ?? 0)}</span></div>
        {card && cart.length > 0 && <div className="flex justify-between text-xs text-kds-subtext"><span>Card / Raast total ({card.taxRatePct}% GST)</span><span>{fmtPkr(card.totalCents)}</span></div>}
        {cart.length > 0 && !cash && (
          <p className="text-xs font-semibold text-kds-amber" role={cashQuote.isError ? 'alert' : undefined}>
            {cashQuote.isError ? (cashQuote.error instanceof Error ? cashQuote.error.message : 'The server could not price this order') : 'Getting the bill from the server…'}
          </p>
        )}
      </div>
    </div>
  )
}

// ─── Box given ───────────────────────────────────────────────────────────────

export function BoxGivenTickets({ conceptId }: { conceptId: string | null }) {
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
                {order.table?.label ? `${tableName(order.table.label)}` : 'Ticket'} · {orderRef(order.id)}
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
