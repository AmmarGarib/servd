// The servd.pk/rider session (docs/rider-app.md) — its own store, separate
// from the customer's (store/customerAuth.ts). A rider is not a customer and
// a rider token is refused everywhere a customer or staff token is expected,
// so the two must never share a slot.
//
// Persisted in localStorage so a rider who closes the tab mid-shift is still
// signed in when they open it again (the refresh token lasts 30 days; the
// access token 15 minutes). lib/riderApi.ts owns refreshing it.
//
// `activeOrderId` is the job the rider is carrying (stage picked_up / arrived);
// location fixes are tagged with it so the client company's dispatch board
// sees the rider moving. The screens set it from the jobs they load.

import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type { RiderPublic } from './riderApi'

export const RIDER_SESSION_KEY = 'servd-rider-session'

export interface RiderSessionState {
  accessToken: string | null
  refreshToken: string | null
  rider: RiderPublic | null
  activeOrderId: string | null
  setSession: (s: { accessToken: string; refreshToken: string; rider: RiderPublic }) => void
  setTokens: (accessToken: string, refreshToken: string) => void
  setRider: (rider: RiderPublic) => void
  setActiveOrderId: (orderId: string | null) => void
  clear: () => void
}

type Persisted = Pick<RiderSessionState, 'accessToken' | 'refreshToken' | 'rider' | 'activeOrderId'>

const EMPTY: Persisted = { accessToken: null, refreshToken: null, rider: null, activeOrderId: null }

export const useRiderSession = create<RiderSessionState>()(
  persist(
    (set) => ({
      ...EMPTY,
      setSession: ({ accessToken, refreshToken, rider }) => set({ accessToken, refreshToken, rider, activeOrderId: null }),
      setTokens: (accessToken, refreshToken) => set({ accessToken, refreshToken }),
      setRider: (rider) => set({ rider }),
      setActiveOrderId: (activeOrderId) => set({ activeOrderId }),
      clear: () => set({ ...EMPTY }),
    }),
    {
      name: RIDER_SESSION_KEY,
      version: 1,
      storage: createJSONStorage(() => localStorage),
      partialize: (s): Persisted => ({
        accessToken: s.accessToken,
        refreshToken: s.refreshToken,
        rider: s.rider,
        activeOrderId: s.activeOrderId,
      }),
    },
  ),
)

/**
 * The tokens as another tab last wrote them — read straight from storage,
 * not from this tab's store. The refresh uses it to adopt a pair another tab
 * already rotated to. Null when storage is empty, blocked or unreadable.
 */
export function readPersistedRiderTokens(): { accessToken: string | null; refreshToken: string | null } | null {
  try {
    const raw = window.localStorage.getItem(RIDER_SESSION_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { state?: Partial<Persisted> } | null
    const s = parsed?.state
    if (!s) return null
    return {
      accessToken: typeof s.accessToken === 'string' ? s.accessToken : null,
      refreshToken: typeof s.refreshToken === 'string' ? s.refreshToken : null,
    }
  } catch {
    return null
  }
}

/**
 * Follow sign-in, sign-out and token rotation done in another tab. Returns the
 * unsubscribe function.
 */
export function syncRiderSessionAcrossTabs(): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key !== RIDER_SESSION_KEY && e.key !== null) return
    // Removed (or all storage cleared) in the other tab: signed out there.
    if (e.key === null || e.newValue === null) {
      useRiderSession.getState().clear()
      return
    }
    // `persist` is missing when the browser refused storage at start-up.
    void useRiderSession.persist?.rehydrate()
  }
  window.addEventListener('storage', onStorage)
  return () => window.removeEventListener('storage', onStorage)
}
