'use client'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { useAuthStore } from './auth'
import type { AppRole } from '../lib/appRoles'

/**
 * CEO / admin role-impersonation. When set, the sidebar + permission gates
 * behave as if the user had that role. Only admin/ceo may set this; the UI
 * in AppShell hides the switcher for non-superusers — but we also gate the
 * setter at the store layer so tampered localStorage can't enable
 * impersonation for a non-admin.
 *
 *   null = no impersonation; the real role is in effect.
 */
export type ViewAsRole = null | AppRole

interface State {
  role: ViewAsRole
  setRole: (role: ViewAsRole) => void
  clear: () => void
}

// Admin-only gate. Clearing (setting to null) is always allowed — anyone
// should be able to undo a stale impersonation. Setting to a non-null role
// is silently refused when the current auth user isn't admin.
function isCurrentUserAdmin(): boolean {
  if (typeof window === 'undefined') return false
  const role = useAuthStore.getState().user?.role
  return role === 'admin'
}

export const useViewAsRole = create<State>()(
  persist(
    (set) => ({
      role: null,
      setRole: (role) => {
        // Clearing always allowed.
        if (role === null) return set({ role: null })
        // Setting only allowed for admin.
        if (!isCurrentUserAdmin()) return
        set({ role })
      },
      clear: () => set({ role: null }),
    }),
    {
      name: 'servd-view-as-role',
      // On hydrate, refuse to honour a stored impersonation if the current
      // user isn't admin — covers the case where the persisted value
      // outlived an admin-to-non-admin session change.
      onRehydrateStorage: () => (state) => {
        if (state && state.role !== null && !isCurrentUserAdmin()) {
          state.role = null
        }
      },
    },
  ),
)
