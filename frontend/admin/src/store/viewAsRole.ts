'use client'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { AppRole } from '../lib/appRoles'

/**
 * CEO / admin role-impersonation. When set, the sidebar + permission gates
 * behave as if the user had that role. Only admin/ceo may set this; the UI
 * in AppShell hides the switcher for non-superusers.
 *
 *   null = no impersonation; the real role is in effect.
 */
export type ViewAsRole = null | AppRole

interface State {
  role: ViewAsRole
  setRole: (role: ViewAsRole) => void
  clear: () => void
}

export const useViewAsRole = create<State>()(
  persist(
    (set) => ({
      role: null,
      setRole: (role) => set({ role }),
      clear: () => set({ role: null }),
    }),
    { name: 'servd-view-as-role' },
  ),
)
