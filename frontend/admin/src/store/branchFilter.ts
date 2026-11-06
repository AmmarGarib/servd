'use client'
import { create } from 'zustand'

// Global branch (outlet) filter — the third row of the top scope bar (owner, 2026-11-06: "for companies that have
// multiple brands/branches they can have a separate switcher"). Sent as `x-servd-location` on reads (lib/api.ts);
// the API defaults `?locationId` from it and answers `x-servd-location-applied: 1` when a route used it, so the bar
// can say "not filtered on this page". The same shape as store/brandFilter.ts.

export const BRANCH_KEY = 'servd_branch_filter'

function readStored(): string | null {
  if (typeof window === 'undefined') return null
  try { return localStorage.getItem(BRANCH_KEY) } catch { return null }
}

interface State {
  locationId: string | null
  seen: Record<string, true>
  applied: Record<string, true>
  setLocation: (id: string | null) => void
  record: (pathname: string, applied: boolean) => void
}

export const useBranchFilter = create<State>((set, get) => ({
  locationId: readStored(),
  seen: {},
  applied: {},
  setLocation: (id) => {
    try { id ? localStorage.setItem(BRANCH_KEY, id) : localStorage.removeItem(BRANCH_KEY) } catch { /* private mode */ }
    set({ locationId: id, seen: {}, applied: {} })
  },
  record: (pathname, applied) => {
    const s = get()
    if (!s.locationId) return
    if (s.seen[pathname] && (!applied || s.applied[pathname])) return
    set({
      seen: { ...s.seen, [pathname]: true },
      applied: applied ? { ...s.applied, [pathname]: true } : s.applied,
    })
  },
}))
