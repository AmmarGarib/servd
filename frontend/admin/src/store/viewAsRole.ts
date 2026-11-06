'use client'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
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

export const useViewAsRole = create<State>()(
  persist(
    (set) => ({
      role: null,
      // RETIRED (owner, 2026-11-06: "kill the role view option"): no screen offers it any more, and a role can
      // never be set — every reader sees null, the real role.
      setRole: () => set({ role: null }),
      clear: () => set({ role: null }),
    }),
    {
      name: 'servd-view-as-role',
      // On hydrate, refuse to honour a stored impersonation if the current
      // user isn't admin — covers the case where the persisted value
      // outlived an admin-to-non-admin session change.
      onRehydrateStorage: () => (state) => {
        // A role stored before the retirement is dropped.
        if (state) state.role = null
      },
    },
  ),
)
