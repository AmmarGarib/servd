'use client'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface StaffUser {
  id: string
  name: string
  role: string
}

interface AuthState {
  user: StaffUser | null
  token: string | null
  refreshToken: string | null
  setAuth: (user: StaffUser, token: string, refreshToken?: string) => void
  clearAuth: () => void
  isRole: (...roles: string[]) => boolean
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      token: null,
      refreshToken: null,
      // F43: zustand-persist already mirrors `token` to localStorage under
      // `servd-auth`. The duplicate mirror at `servd_token` was creating split
      // sources of truth — code that read from one and code that wrote to the
      // other could disagree across refresh-token rotations. We remove the
      // legacy key on setAuth so any stale value goes away on next login.
      setAuth: (user, token, refreshToken) => {
        if (typeof window !== 'undefined') {
          localStorage.removeItem('servd_token')           // cleanup legacy
          localStorage.removeItem('servd_refresh_token')   // cleanup legacy
        }
        set({ user, token, refreshToken: refreshToken ?? null })
      },
      clearAuth: () => {
        if (typeof window !== 'undefined') {
          // Belt-and-braces: nuke any pre-F43 keys too so a half-logged-out
          // session doesn't linger after the user clicks "sign out".
          localStorage.removeItem('servd_token')
          localStorage.removeItem('servd_refresh_token')
        }
        set({ user: null, token: null, refreshToken: null })
      },
      isRole: (...roles) => {
        const { user } = get()
        return user ? roles.includes(user.role) : false
      },
    }),
    // SECURITY: persist ONLY the user identity — never the tokens. The access
    // token now lives in an httpOnly cookie the browser sends automatically, so
    // it's no longer readable by JS / stealable from localStorage by XSS. Any
    // in-memory token (kept this session for the WS handshake) is gone on
    // reload, where the cookie re-authenticates instead.
    { name: 'servd-auth', partialize: (s) => ({ user: s.user }) },
  ),
)
