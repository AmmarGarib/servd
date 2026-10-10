// Session store — the signed-in rider + their token pair, persisted to
// SecureStore. Single source of truth for api.ts, the auth gate and the
// background location task.
//
// Same shape as the tablet's store (zustand vanilla `createStore`, so it is
// reachable outside React — the api wrapper and the TaskManager task), with
// two rider-specific differences:
//
//  1. Keychain accessibility is AFTER_FIRST_UNLOCK. The background location
//     task runs while the phone is locked in the rider's pocket; with the
//     default (WHEN_UNLOCKED) iOS refuses to hand the task the token and every
//     fix would be dropped.
//  2. It also holds `activeOrderId` — the job the rider is carrying (stage
//     picked_up / arrived). The location task tags each fix with it. On
//     Android the task can be started in a fresh headless JS context after the
//     app was swiped away, so the value lives in SecureStore, not only memory.

import { createStore } from 'zustand/vanilla'
import { useStore } from 'zustand'
import * as SecureStore from 'expo-secure-store'

import type { Rider } from '../lib/types'

const TOKEN_KEY   = 'servd_rider_token'
const REFRESH_KEY = 'servd_rider_refresh'
const RIDER_KEY   = 'servd_rider_profile'
const ACTIVE_KEY  = 'servd_rider_active_order'

const SS_OPTS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
}

function put(key: string, value: string | null): Promise<void> {
  return value === null
    ? SecureStore.deleteItemAsync(key, SS_OPTS).catch(() => undefined)
    : SecureStore.setItemAsync(key, value, SS_OPTS)
}

interface SessionState {
  token: string | null
  refreshToken: string | null
  rider: Rider | null
  activeOrderId: string | null
  ready: boolean
  hydrate: () => Promise<void>
  setSession: (token: string, refreshToken: string, rider: Rider) => Promise<void>
  setTokens: (token: string, refreshToken: string) => Promise<void>
  setRider: (rider: Rider) => Promise<void>
  setActiveOrderId: (orderId: string | null) => Promise<void>
  clear: () => Promise<void>
}

let hydrating: Promise<void> | null = null

export const sessionStore = createStore<SessionState>((set, get) => ({
  token: null,
  refreshToken: null,
  rider: null,
  activeOrderId: null,
  ready: false,

  // Idempotent: the root layout and the background task may both call it.
  hydrate: () => {
    if (get().ready) return Promise.resolve()
    if (hydrating) return hydrating
    hydrating = (async () => {
      try {
        const [token, refreshToken, riderRaw, activeOrderId] = await Promise.all([
          SecureStore.getItemAsync(TOKEN_KEY, SS_OPTS),
          SecureStore.getItemAsync(REFRESH_KEY, SS_OPTS),
          SecureStore.getItemAsync(RIDER_KEY, SS_OPTS),
          SecureStore.getItemAsync(ACTIVE_KEY, SS_OPTS),
        ])
        let rider: Rider | null = null
        try { rider = riderRaw ? (JSON.parse(riderRaw) as Rider) : null } catch { rider = null }
        set({
          token: token ?? null,
          refreshToken: refreshToken ?? null,
          rider,
          activeOrderId: activeOrderId ?? null,
          ready: true,
        })
      } catch {
        set({ token: null, refreshToken: null, rider: null, activeOrderId: null, ready: true })
      } finally {
        hydrating = null
      }
    })()
    return hydrating
  },

  setSession: async (token, refreshToken, rider) => {
    await Promise.all([
      put(TOKEN_KEY, token),
      put(REFRESH_KEY, refreshToken),
      put(RIDER_KEY, JSON.stringify(rider)),
      put(ACTIVE_KEY, null),
    ])
    set({ token, refreshToken, rider, activeOrderId: null, ready: true })
  },

  // Refresh tokens rotate: every refresh returns a new pair and revokes the
  // old refresh token, so both must be saved together.
  setTokens: async (token, refreshToken) => {
    await Promise.all([put(TOKEN_KEY, token), put(REFRESH_KEY, refreshToken)])
    set({ token, refreshToken })
  },

  setRider: async (rider) => {
    await put(RIDER_KEY, JSON.stringify(rider))
    set({ rider })
  },

  setActiveOrderId: async (orderId) => {
    if (get().activeOrderId === orderId) return
    await put(ACTIVE_KEY, orderId)
    set({ activeOrderId: orderId })
  },

  clear: async () => {
    await Promise.all([
      put(TOKEN_KEY, null),
      put(REFRESH_KEY, null),
      put(RIDER_KEY, null),
      put(ACTIVE_KEY, null),
    ])
    set({ token: null, refreshToken: null, rider: null, activeOrderId: null })
  },
}))

export function useSessionStore<T>(selector: (s: SessionState) => T): T {
  return useStore(sessionStore, selector)
}
