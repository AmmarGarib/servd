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
      setAuth: (user, token, refreshToken) => {
        if (typeof window !== 'undefined') {
          localStorage.setItem('servd_token', token)
          if (refreshToken) localStorage.setItem('servd_refresh_token', refreshToken)
        }
        set({ user, token, refreshToken: refreshToken ?? null })
      },
      clearAuth: () => {
        if (typeof window !== 'undefined') {
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
    { name: 'servd-auth', partialize: (s) => ({ user: s.user, token: s.token, refreshToken: s.refreshToken }) },
  ),
)
