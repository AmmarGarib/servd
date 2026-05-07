'use client'
import { create } from 'zustand'
import type { Order } from '../lib/api'

export type KdsLang = 'en' | 'ur'

interface KdsState {
  orders: Order[]
  filter86dItems: Set<string>
  lang: KdsLang
  showImages: boolean
  soundEnabled: boolean
  voiceEnabled: boolean
  newOrderPulse: number          // increments each time a new order arrives — drives flash overlay
  setOrders: (orders: Order[]) => void
  addOrder: (order: Order) => void
  updateOrderStatus: (orderId: string, status: string) => void
  updateItemStatus: (itemId: string, status: string) => void
  mark86d: (menuItemId: string) => void
  unmark86d: (menuItemId: string) => void
  setLang: (lang: KdsLang) => void
  setShowImages: (v: boolean) => void
  setSoundEnabled: (v: boolean) => void
  setVoiceEnabled: (v: boolean) => void
  triggerNewOrderPulse: () => void
}

function loadPref<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback
  try {
    const v = localStorage.getItem(key)
    return v !== null ? (JSON.parse(v) as T) : fallback
  } catch { return fallback }
}

function savePref(key: string, v: unknown) {
  try { localStorage.setItem(key, JSON.stringify(v)) } catch { /* */ }
}

export const useKdsStore = create<KdsState>()((set) => ({
  orders: [],
  filter86dItems: new Set(),
  lang: loadPref<KdsLang>('kds_lang', 'en'),
  showImages: loadPref<boolean>('kds_images', false),
  soundEnabled: loadPref<boolean>('kds_sound', true),
  voiceEnabled: loadPref<boolean>('kds_voice', false),
  newOrderPulse: 0,

  setOrders: (orders) => set({ orders }),

  addOrder: (order) =>
    set((state) => {
      const exists = state.orders.some((o) => o.id === order.id)
      if (exists) return state
      return { orders: [order, ...state.orders] }
    }),

  updateOrderStatus: (orderId, status) =>
    set((state) => ({
      orders: state.orders
        .map((o) => (o.id === orderId ? { ...o, status } : o))
        .filter((o) => !['completed', 'cancelled'].includes(o.status)),
    })),

  updateItemStatus: (itemId, status) =>
    set((state) => ({
      orders: state.orders.map((o) => ({
        ...o,
        items: o.items.map((i) => (i.id === itemId ? { ...i, status } : i)),
      })),
    })),

  mark86d: (menuItemId) =>
    set((state) => {
      const next = new Set(state.filter86dItems)
      next.add(menuItemId)
      return { filter86dItems: next }
    }),

  unmark86d: (menuItemId) =>
    set((state) => {
      const next = new Set(state.filter86dItems)
      next.delete(menuItemId)
      return { filter86dItems: next }
    }),

  setLang: (lang) => { savePref('kds_lang', lang); set({ lang }) },
  setShowImages: (v) => { savePref('kds_images', v); set({ showImages: v }) },
  setSoundEnabled: (v) => { savePref('kds_sound', v); set({ soundEnabled: v }) },
  setVoiceEnabled: (v) => { savePref('kds_voice', v); set({ voiceEnabled: v }) },
  triggerNewOrderPulse: () => set((s) => ({ newOrderPulse: s.newOrderPulse + 1 })),
}))
