'use client'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { MenuItem, Modifier } from '../lib/api'
import { newIdempotencyKey, type LineRemoval, type TillLine } from '../components/pos/tillApi'

export interface CartItem {
  id: string // local ID
  menuItemId: string
  name: string
  unitPriceCents: number
  quantity: number
  notes: string
  course: number
  modifiers: Array<{ modifierId: string; name: string; priceDeltaCents: number }>
  /** Ingredients the customer asked to leave out ("No onions"). Price unchanged. */
  removedIngredients?: LineRemoval[]
}

// The till's cart. It holds NO tax maths (FOH-02): it used to add the legacy
// concept.taxRate (17%) to the post-discount subtotal, so every payment was
// refused as the wrong amount. GST (cash 15% / card 8% on the pre-discount
// base) and the service charge are the server's — the till shows and charges
// the bill the server returns (components/pos/tillApi.ts).
export type Fulfilment = 'dine_in' | 'takeout' | 'delivery'
/** The waiter on the ticket (an HR employee, GET /pos/waiters). */
export interface TillWaiter { id?: string; code: string; name: string }
/** The "Order information" guest (TILL_FLOW §3): a picked customer, or typed details. */
export interface TillGuest {
  customerId: string | null
  name: string
  email: string
  mobile: string
  phone: string
  registrationNo: string
}
/** Delivery details (TILL_FLOW §7). */
export interface TillDelivery { name: string; phone: string; address: string; notes: string; zoneId: string | null; cod: boolean }

interface PosState {
  conceptId: string | null
  shiftId: string | null
  tableId: string | null
  customerId: string | null
  // The "Order information" panel, held until the first Save (TILL_FLOW §3).
  fulfilment: Fulfilment
  tableLabel: string | null
  waiter: TillWaiter | null
  partySize: number | null
  guest: TillGuest | null
  delivery: TillDelivery | null
  /** Manager PIN typed with a discount above the cashier's cap — never persisted. */
  discountPin: string
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
  setFulfilment: (f: Fulfilment) => void
  setTableLabel: (l: string | null) => void
  setWaiter: (w: TillWaiter | null) => void
  setPartySize: (n: number | null) => void
  setGuest: (g: TillGuest | null) => void
  setDelivery: (d: TillDelivery | null) => void

  addItem: (item: MenuItem, selectedModifiers: Modifier[]) => void
  removeItem: (localId: string) => void
  /** Set the ingredients left out of a line (an empty list = none). */
  updateItemRemovals: (localId: string, removals: LineRemoval[]) => void
  updateItemQty: (localId: string, qty: number) => void
  updateItemNotes: (localId: string, notes: string) => void
  updateItemCourse: (localId: string, course: number) => void
  setDiscount: (cents: number, reason?: string, pin?: string) => void
  /** Empties the lines and discount but keeps the table, waiter, pax and guest (the next round on the same table). */
  clearLines: () => void
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
  fulfilment: 'takeout',
  tableLabel: null,
  waiter: null,
  partySize: null,
  guest: null,
  delivery: null,
  discountPin: '',
  cart: [],
  discountCents: 0,
  discountReason: '',
  checkoutKey: null,

  setConceptId: (id) => set({ conceptId: id }),
  setShiftId: (id) => set({ shiftId: id }),
  setTableId: (id) => set({ tableId: id, checkoutKey: null }),
  setCustomerId: (id) => set({ customerId: id, checkoutKey: null }),
  setFulfilment: (f) => set({ fulfilment: f, checkoutKey: null }),
  setTableLabel: (l) => set({ tableLabel: l }),
  setWaiter: (w) => set({ waiter: w, checkoutKey: null }),
  setPartySize: (n) => set({ partySize: n, checkoutKey: null }),
  setGuest: (g) => set({ guest: g, checkoutKey: null }),
  setDelivery: (d) => set({ delivery: d, checkoutKey: null }),

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

  updateItemRemovals: (localId, removals) =>
    set((state) => ({
      checkoutKey: null,
      cart: state.cart.map((i) => (i.id === localId ? { ...i, removedIngredients: removals } : i)),
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

  setDiscount: (cents, reason = '', pin = '') => set({ discountCents: cents, discountReason: reason, discountPin: pin, checkoutKey: null }),

  clearLines: () => set({ cart: [], discountCents: 0, discountReason: '', discountPin: '', checkoutKey: null }),

  clearCart: () =>
    set({
      cart: [], discountCents: 0, discountReason: '', discountPin: '', tableId: null, customerId: null, checkoutKey: null,
      fulfilment: 'takeout', tableLabel: null, waiter: null, partySize: null, guest: null, delivery: null,
    }),

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
      ...(i.removedIngredients?.length && {
        removedIngredients: i.removedIngredients.map((r) => ({
          key: r.key, name: r.name, masterIngredientId: r.masterIngredientId, inventoryItemId: r.inventoryItemId, prepRecipeId: r.prepRecipeId,
        })),
      }),
    })),
}),
    {
      name: 'servd-pos',
      partialize: (s) => ({ shiftId: s.shiftId, conceptId: s.conceptId }),
    },
  ),
)
