'use client'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { MenuItem, Modifier } from '../lib/api'

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

interface PosState {
  conceptId: string | null
  shiftId: string | null
  tableId: string | null
  customerId: string | null
  cart: CartItem[]
  discountCents: number
  discountReason: string

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

  // Derived
  subtotalCents: () => number
  taxCents: (rate: number) => number
  totalCents: (rate: number) => number
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

  setConceptId: (id) => set({ conceptId: id }),
  setShiftId: (id) => set({ shiftId: id }),
  setTableId: (id) => set({ tableId: id }),
  setCustomerId: (id) => set({ customerId: id }),

  addItem: (item, selectedModifiers) => {
    const id = `cart-${++localIdCounter}`
    set((state) => ({
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
    set((state) => ({ cart: state.cart.filter((i) => i.id !== localId) })),

  updateItemQty: (localId, qty) =>
    set((state) => ({
      cart:
        qty <= 0
          ? state.cart.filter((i) => i.id !== localId)
          : state.cart.map((i) => (i.id === localId ? { ...i, quantity: qty } : i)),
    })),

  updateItemNotes: (localId, notes) =>
    set((state) => ({
      cart: state.cart.map((i) => (i.id === localId ? { ...i, notes } : i)),
    })),

  updateItemCourse: (localId, course) =>
    set((state) => ({
      cart: state.cart.map((i) => (i.id === localId ? { ...i, course } : i)),
    })),

  setDiscount: (cents, reason = '') => set({ discountCents: cents, discountReason: reason }),

  clearCart: () =>
    set({ cart: [], discountCents: 0, discountReason: '', tableId: null, customerId: null }),

  subtotalCents: () => {
    const { cart, discountCents } = get()
    const itemTotal = cart.reduce((sum, item) => {
      const modTotal = item.modifiers.reduce((ms, m) => ms + m.priceDeltaCents, 0)
      return sum + (item.unitPriceCents + modTotal) * item.quantity
    }, 0)
    return Math.max(0, itemTotal - discountCents)
  },

  taxCents: (rate) => Math.round(get().subtotalCents() * (rate / 100)),

  totalCents: (rate) => {
    const sub = get().subtotalCents()
    return sub + Math.round(sub * (rate / 100))
  },
}),
    {
      name: 'servd-pos',
      partialize: (s) => ({ shiftId: s.shiftId, conceptId: s.conceptId }),
    },
  ),
)
