// POS cart state. Separate from the customer mobile cart because the POS:
//   - allows multiple concurrent orders (dine-in tables) — keyed by tableId
//   - supports split tender and partial refunds
//   - tracks discounts at the line level for tax-rule clarity
//
// For v1 we ship single-cart "what's on the rail right now". Multi-cart table
// switching can layer on top by serialising `state.lines` to the table row.

import { create } from 'zustand'

export interface PosLine {
  id: string
  menuItemId: string
  name: string
  unitPriceCents: number
  qty: number
  modifiers: Array<{ id: string; name: string; priceDeltaCents: number }>
  notes: string
}

interface PosState {
  conceptId: string | null
  conceptName: string | null
  channel: 'dinein' | 'takeaway'
  tableId: string | null
  customerId: string | null
  customerName: string | null
  lines: PosLine[]

  setConcept: (id: string, name: string) => void
  setChannel: (c: 'dinein' | 'takeaway') => void
  setTable: (id: string | null) => void
  setCustomer: (id: string | null, name: string | null) => void
  add: (item: Omit<PosLine, 'id' | 'qty' | 'modifiers' | 'notes'>) => void
  setQty: (id: string, qty: number) => void
  setNotes: (id: string, notes: string) => void
  remove: (id: string) => void
  clear: () => void
  subtotalCents: () => number
}

let counter = 0

export const usePos = create<PosState>((set, get) => ({
  conceptId: null,
  conceptName: null,
  channel: 'dinein',
  tableId: null,
  customerId: null,
  customerName: null,
  lines: [],

  setConcept: (id, name) => set({ conceptId: id, conceptName: name, lines: [] }),
  setChannel: (channel) => set({ channel }),
  setTable: (tableId) => set({ tableId }),
  setCustomer: (customerId, customerName) => set({ customerId, customerName }),

  add: (item) => set((s) => {
    const dupe = s.lines.find(l => l.menuItemId === item.menuItemId)
    if (dupe) return { lines: s.lines.map(l => l.id === dupe.id ? { ...l, qty: l.qty + 1 } : l) }
    return { lines: [...s.lines, { ...item, id: `pos_${++counter}`, qty: 1, modifiers: [], notes: '' }] }
  }),

  setQty: (id, qty) => set((s) => ({
    lines: qty <= 0 ? s.lines.filter(l => l.id !== id) : s.lines.map(l => l.id === id ? { ...l, qty } : l),
  })),

  setNotes: (id, notes) => set((s) => ({
    lines: s.lines.map(l => l.id === id ? { ...l, notes } : l),
  })),

  remove: (id) => set((s) => ({ lines: s.lines.filter(l => l.id !== id) })),

  clear: () => set({ lines: [], tableId: null, customerId: null, customerName: null }),

  subtotalCents: () => get().lines.reduce((s, l) => {
    const mods = l.modifiers.reduce((m, x) => m + x.priceDeltaCents, 0)
    return s + (l.unitPriceCents + mods) * l.qty
  }, 0),
}))
