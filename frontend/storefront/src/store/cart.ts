'use client'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface CartItemModifier {
  modifierId?: string
  name: string
  priceDeltaCents: number
}

export interface CartItem {
  menuItemId: string
  name: string
  priceCents: number
  quantity: number
  notes?: string
  modifiers?: CartItemModifier[]
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
  addItem: (item: Omit<CartItem, 'quantity'>) => void
  removeItem: (menuItemId: string) => void
  updateQty: (menuItemId: string, qty: number) => void
  clearCart: () => void
  // Replaces the entire cart with the given items, scoped to a concept. Used
  // by Reorder to bulk-load items from a past order.
  hydrateFromReorder: (slug: string, items: CartItem[]) => void
  itemCount: () => number
  subtotalCents: () => number
  taxCents: () => number
  totalCents: () => number
}

const TAX_RATE = 0.17

export const useCart = create<CartStore>()(
  persist(
    (set, get) => ({
      cartId: genCartId(),
      conceptSlug: null,
      items: [],

      setConceptSlug: (slug) => set({ conceptSlug: slug }),

      addItem: (item) =>
        set((state) => {
          const existing = state.items.find((i) => i.menuItemId === item.menuItemId)
          if (existing) {
            return {
              items: state.items.map((i) =>
                i.menuItemId === item.menuItemId ? { ...i, quantity: i.quantity + 1 } : i,
              ),
            }
          }
          return { items: [...state.items, { ...item, quantity: 1 }] }
        }),

      removeItem: (menuItemId) =>
        set((state) => ({ items: state.items.filter((i) => i.menuItemId !== menuItemId) })),

      updateQty: (menuItemId, qty) =>
        set((state) => ({
          items:
            qty <= 0
              ? state.items.filter((i) => i.menuItemId !== menuItemId)
              : state.items.map((i) => (i.menuItemId === menuItemId ? { ...i, quantity: qty } : i)),
        })),

      clearCart: () => set({ items: [], conceptSlug: null, cartId: genCartId() }),

      hydrateFromReorder: (slug, items) =>
        set({ conceptSlug: slug, items, cartId: genCartId() }),


      itemCount: () => get().items.reduce((s, i) => s + i.quantity, 0),
      subtotalCents: () => get().items.reduce((s, i) => s + i.priceCents * i.quantity, 0),
      taxCents: () => Math.round(get().subtotalCents() * TAX_RATE),
      totalCents: () => get().subtotalCents() + get().taxCents(),
    }),
    { name: 'servd-cart' },
  ),
)
