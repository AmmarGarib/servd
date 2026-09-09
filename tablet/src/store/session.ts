// Session store — current signed-in staff user + JWT token, persisted to
// SecureStore. Single source of truth used by api.ts and the auth gate.
//
// Design note: we use the zustand vanilla store (`createStore` + manual
// subscribe) so it's reachable from outside React (the api wrapper, the socket
// reconnect logic). React components consume via `useSessionStore` below.

import { createStore } from 'zustand/vanilla'
import { useStore } from 'zustand'
import * as SecureStore from 'expo-secure-store'

const TOKEN_KEY   = 'servd_staff_token'
const REFRESH_KEY = 'servd_staff_refresh'
const USER_KEY    = 'servd_staff_user'

export interface StaffUser {
  id:   string
  name: string
  role: string
  email?: string
}

interface SessionState {
  token: string | null
  // Access tokens last 15 minutes. Without a refresh token the tablet dropped
  // the whole session on the first 401, which meant re-typing the credential
  // roughly every quarter of an hour, mid-service. That was survivable when
  // the credential was a 4-digit PIN on a numpad; with email + a 12-character
  // password it is not.
  refreshToken: string | null
  user:  StaffUser | null
  ready: boolean
  hydrate: () => Promise<void>
  setSession: (token: string, user: StaffUser, refreshToken?: string | null) => Promise<void>
  setAccessToken: (token: string) => Promise<void>
  clear: () => Promise<void>
}

export const sessionStore = createStore<SessionState>((set) => ({
  token: null,
  refreshToken: null,
  user:  null,
  ready: false,

  hydrate: async () => {
    try {
      const [token, refreshToken, userRaw] = await Promise.all([
        SecureStore.getItemAsync(TOKEN_KEY),
        SecureStore.getItemAsync(REFRESH_KEY),
        SecureStore.getItemAsync(USER_KEY),
      ])
      set({
        token: token ?? null,
        refreshToken: refreshToken ?? null,
        user:  userRaw ? (JSON.parse(userRaw) as StaffUser) : null,
        ready: true,
      })
    } catch {
      set({ token: null, refreshToken: null, user: null, ready: true })
    }
  },

  setSession: async (token, user, refreshToken) => {
    await Promise.all([
      SecureStore.setItemAsync(TOKEN_KEY, token),
      SecureStore.setItemAsync(USER_KEY,  JSON.stringify(user)),
      refreshToken
        ? SecureStore.setItemAsync(REFRESH_KEY, refreshToken)
        : Promise.resolve(),
    ])
    set({ token, user, ...(refreshToken ? { refreshToken } : {}) })
  },

  // Swap just the access token after a refresh, leaving the refresh token and
  // the signed-in user in place.
  setAccessToken: async (token) => {
    await SecureStore.setItemAsync(TOKEN_KEY, token)
    set({ token })
  },

  clear: async () => {
    await Promise.all([
      SecureStore.deleteItemAsync(TOKEN_KEY).catch(() => undefined),
      SecureStore.deleteItemAsync(REFRESH_KEY).catch(() => undefined),
      SecureStore.deleteItemAsync(USER_KEY ).catch(() => undefined),
    ])
    set({ token: null, refreshToken: null, user: null })
  },
}))

export function useSessionStore<T>(selector: (s: SessionState) => T): T {
  return useStore(sessionStore, selector)
}
