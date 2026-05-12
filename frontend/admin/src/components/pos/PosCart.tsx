'use client'
import { usePosStore } from '../../store/pos'

interface PosCartProps {
  taxRate: number
  onCheckout: () => void
}

export function PosCart({ taxRate, onCheckout }: PosCartProps) {
  const { cart, removeItem, updateItemQty, updateItemNotes, discountCents, subtotalCents, totalCents } = usePosStore()
  const sub = subtotalCents()
  const total = totalCents(taxRate)
  const tax = total - sub

  function fmt(cents: number) {
    return `PKR ${(cents / 100).toFixed(0)}`
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b border-kds-border px-4 py-3">
        <h2 className="font-bold text-kds-text">Current Order</h2>
        <p className="text-xs text-kds-subtext">{cart.length} item{cart.length !== 1 ? 's' : ''}</p>
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
                    {fmt((item.unitPriceCents + item.modifiers.reduce((s, m) => s + m.priceDeltaCents, 0)) * item.quantity)}
                  </div>
                </div>

                {/* Qty controls — F13: bumped from h-8 to h-11 (44px Apple HIG
                    minimum) so adjacent buttons no longer mistap on iPad. Added
                    aria-labels so VoiceOver reads each button distinctly. */}
                <div className="mt-2 flex items-center gap-2">
                  <button
                    onClick={() => updateItemQty(item.id, item.quantity - 1)}
                    aria-label={`Decrease quantity of ${item.name}`}
                    className="h-11 w-11 rounded-lg bg-kds-border text-base font-bold text-kds-text active:bg-kds-border/70"
                  >
                    −
                  </button>
                  <span className="w-8 text-center font-bold text-kds-text text-base" aria-live="polite">{item.quantity}</span>
                  <button
                    onClick={() => updateItemQty(item.id, item.quantity + 1)}
                    aria-label={`Increase quantity of ${item.name}`}
                    className="h-11 w-11 rounded-lg bg-kds-border text-base font-bold text-kds-text active:bg-kds-border/70"
                  >
                    +
                  </button>
                  <input
                    type="text"
                    placeholder="Note…"
                    aria-label={`Note for ${item.name}`}
                    value={item.notes}
                    onChange={(e) => updateItemNotes(item.id, e.target.value)}
                    className="flex-1 rounded border border-kds-border bg-transparent px-2 py-1 text-xs text-kds-text placeholder:text-kds-subtext"
                  />
                  <button
                    onClick={() => removeItem(item.id)}
                    className="h-11 w-11 rounded-lg bg-kds-red/20 text-kds-red font-bold active:bg-kds-red/30"
                    aria-label={`Remove ${item.name} from cart`}
                  >
                    ✕
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Totals */}
      <div className="border-t border-kds-border px-4 py-3 space-y-1">
        <div className="flex justify-between text-sm text-kds-subtext">
          <span>Subtotal</span>
          <span>{fmt(sub)}</span>
        </div>
        {discountCents > 0 && (
          <div className="flex justify-between text-sm text-kds-amber">
            <span>Discount</span>
            <span>−{fmt(discountCents)}</span>
          </div>
        )}
        <div className="flex justify-between text-sm text-kds-subtext">
          <span>Tax (GST {taxRate}%)</span>
          <span>{fmt(tax)}</span>
        </div>
        <div className="flex justify-between font-bold text-kds-text text-base">
          <span>Total</span>
          <span className="text-kds-green">{fmt(total)}</span>
        </div>
      </div>

      {/* Checkout */}
      <div className="border-t border-kds-border p-4">
        <button
          onClick={onCheckout}
          disabled={cart.length === 0}
          className="w-full rounded-xl bg-kds-green py-4 text-lg font-bold text-white disabled:opacity-30 active:scale-95"
        >
          Charge {fmt(total)}
        </button>
      </div>
    </div>
  )
}
