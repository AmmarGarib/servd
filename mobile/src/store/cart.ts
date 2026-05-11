import { create } from 'zustand'

export interface CartItem {
  id: string
  menuItemId: string
  name: string
  unitPriceCents: number
  quantity: number
  notes: string
  modifiers: Array<{ modifierId: string; name: string; priceDeltaCents: number }>
}

interface CartState {
  conceptId: string | null
  items: CartItem[]
  setConceptId: (id: string) => void
  addItem: (item: Omit<CartItem, 'id' | 'quantity' | 'notes' | 'modifiers'>) => void
  removeItem: (id: string) => void
  updateQty: (id: string, qty: number) => void
  clear: () => void
  subtotalCents: () => number
}

let counter = 0

export const useCartStore = create<CartState>((set, get) => ({
  conceptId: null,
  items: [],

  setConceptId: (id) => set({ conceptId: id, items: [] }),

  addItem: (item) => set((s) => {
    const existing = s.items.find(i => i.menuItemId === item.menuItemId)
    if (existing) {
      return { items: s.items.map(i => i.id === existing.id ? { ...i, quantity: i.quantity + 1 } : i) }
    }
    return { items: [...s.items, { ...item, id: `item_${++counter}`, quantity: 1, notes: '', modifiers: [] }] }
  }),

  removeItem: (id) => set((s) => ({ items: s.items.filter(i => i.id !== id) })),

  updateQty: (id, qty) => set((s) => ({
    items: qty <= 0
      ? s.items.filter(i => i.id !== id)
      : s.items.map(i => i.id === id ? { ...i, quantity: qty } : i)
  })),

  clear: () => set({ items: [] }),

  subtotalCents: () => get().items.reduce((s, i) => {
    const modTotal = i.modifiers.reduce((ms, m) => ms + m.priceDeltaCents, 0)
    return s + (i.unitPriceCents + modTotal) * i.quantity
  }, 0),
}))
