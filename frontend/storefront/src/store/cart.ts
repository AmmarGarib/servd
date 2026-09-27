'use client'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { emitCrowd } from '../components/characters/crowdBus'
import { haptic } from '../lib/haptics'
import { sfx } from '../lib/film/sfx'

export interface CartItemModifier {
  modifierId?: string
  name: string
  priceDeltaCents: number
}

export interface CartItem {
  /** Unique per cart line — same menuItem with different modifier picks
   *  gets a different lineId so they list separately and remove/update
   *  target the right row. */
  lineId: string
  menuItemId: string
  name: string
  priceCents: number
  quantity: number
  notes?: string
  modifiers?: CartItemModifier[]
}

function modifierKey(mods?: CartItemModifier[]): string {
  if (!mods || mods.length === 0) return ''
  return mods
    .map((m) => m.modifierId ?? m.name)
    .filter(Boolean)
    .sort()
    .join('|')
}

/** Film feedback for an add: client-only, and never allowed to throw into
 *  the cart update (each call is isolated). */
function bagFeedback(): void {
  if (typeof window === 'undefined') return
  try { emitCrowd({ type: 'catch' }) } catch { /* decorative */ }
  try { haptic(10) } catch { /* decorative */ }
  try { sfx('pop') } catch { /* decorative */ }
}

function genCartId() {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36)
}

interface CartStore {
  cartId: string
  conceptSlug: string | null
  items: CartItem[]
  setConceptSlug: (slug: string) => void
  /** Caller passes the item without quantity AND without lineId — store
   *  computes the lineId from menuItemId + modifier hash so repeated adds
   *  of the same combination land on the same line. */
  addItem: (item: Omit<CartItem, 'quantity' | 'lineId'>) => void
  removeItem: (lineId: string) => void
  updateQty: (lineId: string, qty: number) => void
  clearCart: () => void
  // Replaces the entire cart with the given items, scoped to a concept. Used
  // by Reorder to bulk-load items from a past order.
  /** Replaces the entire cart with the given items, scoped to a concept.
   *  Items may arrive without a lineId (e.g. from the reorder API or the
   *  cross-domain cart handoff token) — the store assigns lineIds based on
   *  the same menuItemId+modifiers hash used by addItem. */
  hydrateFromReorder: (slug: string, items: Array<Omit<CartItem, 'lineId'> & { lineId?: string }>) => void
  itemCount: () => number
  subtotalCents: () => number
  taxCents: () => number
  totalCents: () => number
}

// Tax is payment-method-aware (8% on card-rails, 15% on cash per the
// admin config) and the customer hasn't picked a payment method yet
// at this point in the funnel, so the cart store reports 0 tax. The
// checkout page recomputes taxCents itself once paymentMethod is known
// and the basket drawer hides the GST line entirely pre-checkout.
const TAX_RATE = 0

export const useCart = create<CartStore>()(
  persist(
    (set, get) => ({
      cartId: genCartId(),
      conceptSlug: null,
      items: [],

      setConceptSlug: (slug) => set({ conceptSlug: slug }),

      addItem: (item) => {
        set((state) => {
          // Two cart entries for the same menu item with DIFFERENT modifier
          // picks are distinct lines. Hash the modifier set (sorted by id
          // so insertion order doesn't create false negatives) and combine
          // with menuItemId to form the lineId.
          const lineId = `${item.menuItemId}#${modifierKey(item.modifiers)}`
          const existing = state.items.find((i) => i.lineId === lineId)
          if (existing) {
            return {
              items: state.items.map((i) =>
                i.lineId === lineId ? { ...i, quantity: i.quantity + 1 } : i,
              ),
            }
          }
          return { items: [...state.items, { ...item, lineId, quantity: 1 }] }
        })
        // The item has landed in the bag: the companion catches it, the
        // phone ticks, and (only if sound is on) a pop. Decorative only.
        bagFeedback()
      },

      removeItem: (lineId) =>
        set((state) => ({ items: state.items.filter((i) => i.lineId !== lineId) })),

      updateQty: (lineId, qty) =>
        set((state) => ({
          items:
            qty <= 0
              ? state.items.filter((i) => i.lineId !== lineId)
              : state.items.map((i) => (i.lineId === lineId ? { ...i, quantity: qty } : i)),
        })),

      clearCart: () => set({ items: [], conceptSlug: null, cartId: genCartId() }),

      hydrateFromReorder: (slug, items) =>
        set({
          conceptSlug: slug,
          items: items.map((i) => ({
            ...i,
            lineId: i.lineId ?? `${i.menuItemId}#${modifierKey(i.modifiers)}`,
          })),
          cartId: genCartId(),
        }),


      itemCount: () => get().items.reduce((s, i) => s + i.quantity, 0),
      subtotalCents: () => get().items.reduce((s, i) => s + i.priceCents * i.quantity, 0),
      taxCents: () => Math.round(get().subtotalCents() * TAX_RATE),
      totalCents: () => get().subtotalCents() + get().taxCents(),
    }),
    {
      name: 'servd-cart',
      // Bump version when shape changes. v1 added `lineId` per cart line —
      // legacy v0 entries get one assigned from menuItemId + modifier hash
      // so existing browser carts keep working after the upgrade.
      version: 1,
      migrate: (persisted, fromVersion) => {
        const state = persisted as { items?: Array<Omit<CartItem, 'lineId'> & { lineId?: string }> } | null
        if (fromVersion < 1 && state?.items) {
          state.items = state.items.map((i) => ({
            ...i,
            lineId: i.lineId ?? `${i.menuItemId}#${modifierKey(i.modifiers)}`,
          }))
        }
        return state as never
      },
    },
  ),
)
