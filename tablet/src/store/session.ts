// Session store — current signed-in staff user + JWT token, persisted to
// SecureStore. Single source of truth used by api.ts and the auth gate.
//
// Design note: we use the zustand vanilla store (`createStore` + manual
// subscribe) so it's reachable from outside React (the api wrapper, the socket
// reconnect logic). React components consume via `useSessionStore` below.

import { createStore } from 'zustand/vanilla'
import { useStore } from 'zustand'
import * as SecureStore from 'expo-secure-store'

const TOKEN_KEY = 'servd_staff_token'
const USER_KEY  = 'servd_staff_user'

export interface StaffUser {
  id:   string
  name: string
  role: string
  email?: string
}

interface SessionState {
  token: string | null
  user:  StaffUser | null
  ready: boolean
  hydrate: () => Promise<void>
  setSession: (token: string, user: StaffUser) => Promise<void>
  clear: () => Promise<void>
}

export const sessionStore = createStore<SessionState>((set) => ({
  token: null,
  user:  null,
  ready: false,

  hydrate: async () => {
    try {
      const [token, userRaw] = await Promise.all([
        SecureStore.getItemAsync(TOKEN_KEY),
        SecureStore.getItemAsync(USER_KEY),
      ])
      set({
        token: token ?? null,
        user:  userRaw ? (JSON.parse(userRaw) as StaffUser) : null,
        ready: true,
      })
    } catch {
      set({ token: null, user: null, ready: true })
    }
  },

  setSession: async (token, user) => {
    await Promise.all([
      SecureStore.setItemAsync(TOKEN_KEY, token),
      SecureStore.setItemAsync(USER_KEY,  JSON.stringify(user)),
    ])
    set({ token, user })
  },

  clear: async () => {
    await Promise.all([
      SecureStore.deleteItemAsync(TOKEN_KEY).catch(() => undefined),
      SecureStore.deleteItemAsync(USER_KEY ).catch(() => undefined),
    ])
    set({ token: null, user: null })
  },
}))

export function useSessionStore<T>(selector: (s: SessionState) => T): T {
  return useStore(sessionStore, selector)
}
