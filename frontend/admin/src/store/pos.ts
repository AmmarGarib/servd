'use client'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { MenuItem, Modifier } from '../lib/api'
import { newIdempotencyKey, type TillLine } from '../components/pos/tillApi'

export interface CartItem {
  id: string // local ID
  menuItemId: string
  name: string
  unitPriceCents: number
  quantity: number
  notes: string
  course: number
  modifiers: Array<{ modifierId: string; name: string; priceDeltaCents: number }>
}

// The till's cart. It holds NO tax maths (FOH-02): it used to add the legacy
// concept.taxRate (17%) to the post-discount subtotal, so every payment was
// refused as the wrong amount. GST (cash 15% / card 8% on the pre-discount
// base) and the service charge are the server's — the till shows and charges
// the bill the server returns (components/pos/tillApi.ts).
interface PosState {
  conceptId: string | null
  shiftId: string | null
  tableId: string | null
  customerId: string | null
  cart: CartItem[]
  discountCents: number
  discountReason: string
  /** Idempotency key of the ring-up for THIS cart: reused on a retry of the
   *  same cart, dropped whenever the cart changes or is cleared. */
  checkoutKey: string | null

  setConceptId: (id: string) => void
  setShiftId: (id: string | null) => void
  setTableId: (id: string | null) => void
  setCustomerId: (id: string | null) => void

  addItem: (item: MenuItem, selectedModifiers: Modifier[]) => void
  removeItem: (localId: string) => void
  updateItemQty: (localId: string, qty: number) => void
  updateItemNotes: (localId: string, notes: string) => void
  updateItemCourse: (localId: string, course: number) => void
  setDiscount: (cents: number, reason?: string) => void
  clearCart: () => void
  ensureCheckoutKey: () => string

  // Derived
  /** Food value of the cart: Σ (unit + modifiers) × qty. No tax, no discount. */
  itemTotalCents: () => number
  /** The cart as POST /pos/orders lines. */
  lines: () => TillLine[]
}

let localIdCounter = 0

export const usePosStore = create<PosState>()(
  persist(
    (set, get) => ({
  conceptId: null,
  shiftId: null,
  tableId: null,
  customerId: null,
  cart: [],
  discountCents: 0,
  discountReason: '',
  checkoutKey: null,

  setConceptId: (id) => set({ conceptId: id }),
  setShiftId: (id) => set({ shiftId: id }),
  setTableId: (id) => set({ tableId: id, checkoutKey: null }),
  setCustomerId: (id) => set({ customerId: id, checkoutKey: null }),

  addItem: (item, selectedModifiers) => {
    const id = `cart-${++localIdCounter}`
    set((state) => ({
      checkoutKey: null,
      cart: [
        ...state.cart,
        {
          id,
          menuItemId: item.id,
          name: item.name,
          unitPriceCents: item.priceCents,
          quantity: 1,
          notes: '',
          course: 1,
          modifiers: selectedModifiers.map((m) => ({
            modifierId: m.id,
            name: m.name,
            priceDeltaCents: m.priceDeltaCents,
          })),
        },
      ],
    }))
  },

  removeItem: (localId) =>
    set((state) => ({ checkoutKey: null, cart: state.cart.filter((i) => i.id !== localId) })),

  updateItemQty: (localId, qty) =>
    set((state) => ({
      checkoutKey: null,
      cart:
        qty <= 0
          ? state.cart.filter((i) => i.id !== localId)
          : state.cart.map((i) => (i.id === localId ? { ...i, quantity: qty } : i)),
    })),

  updateItemNotes: (localId, notes) =>
    set((state) => ({
      checkoutKey: null,
      cart: state.cart.map((i) => (i.id === localId ? { ...i, notes } : i)),
    })),

  updateItemCourse: (localId, course) =>
    set((state) => ({
      checkoutKey: null,
      cart: state.cart.map((i) => (i.id === localId ? { ...i, course } : i)),
    })),

  setDiscount: (cents, reason = '') => set({ discountCents: cents, discountReason: reason, checkoutKey: null }),

  clearCart: () =>
    set({ cart: [], discountCents: 0, discountReason: '', tableId: null, customerId: null, checkoutKey: null }),

  ensureCheckoutKey: () => {
    const existing = get().checkoutKey
    if (existing) return existing
    const key = newIdempotencyKey()
    set({ checkoutKey: key })
    return key
  },

  itemTotalCents: () =>
    get().cart.reduce((sum, item) => {
      const modTotal = item.modifiers.reduce((ms, m) => ms + m.priceDeltaCents, 0)
      return sum + (item.unitPriceCents + modTotal) * item.quantity
    }, 0),

  lines: () =>
    get().cart.map((i) => ({
      menuItemId: i.menuItemId,
      name: i.name,
      quantity: i.quantity,
      unitPriceCents: i.unitPriceCents,
      notes: i.notes || undefined,
      course: i.course,
      modifiers: i.modifiers,
    })),
}),
    {
      name: 'servd-pos',
      partialize: (s) => ({ shiftId: s.shiftId, conceptId: s.conceptId }),
    },
  ),
)
