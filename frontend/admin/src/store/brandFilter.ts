'use client'
import { create } from 'zustand'

// Global brand filter. Sent as `x-servd-brand` on reads (lib/api.ts); the API
// narrows to that brand wherever the data is brand-shaped and answers
// `x-servd-brand-applied: 1` when it did. We record that per page so the
// picker can say "not filtered on this page" rather than leave a brand name in
// the sidebar over numbers for every brand.

export const BRAND_KEY = 'servd_brand_filter'

function readStored(): string | null {
  if (typeof window === 'undefined') return null
  try { return localStorage.getItem(BRAND_KEY) } catch { return null }
}

interface State {
  brandId: string | null
  /** pathname → a read has completed on this page since the brand was picked */
  seen: Record<string, true>
  /** pathname → at least one read on this page applied the brand */
  applied: Record<string, true>
  setBrand: (id: string | null) => void
  record: (pathname: string, applied: boolean) => void
}

export const useBrandFilter = create<State>((set, get) => ({
  brandId: readStored(),
  seen: {},
  applied: {},
  setBrand: (id) => {
    try { id ? localStorage.setItem(BRAND_KEY, id) : localStorage.removeItem(BRAND_KEY) } catch { /* private mode */ }
    set({ brandId: id, seen: {}, applied: {} })
  },
  record: (pathname, applied) => {
    const s = get()
    if (!s.brandId) return
    if (s.seen[pathname] && (!applied || s.applied[pathname])) return
    set({
      seen: { ...s.seen, [pathname]: true },
      applied: applied ? { ...s.applied, [pathname]: true } : s.applied,
    })
  },
}))
