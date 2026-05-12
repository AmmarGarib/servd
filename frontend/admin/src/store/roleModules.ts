'use client'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { type AppRole, type ModuleId, DEFAULT_MODULE_ACCESS } from '../lib/appRoles'

/**
 * Persisted overrides to the role → modules map.
 *
 *   • `overrides[role]` is the FULL allow-list for that role when set.
 *   • Roles not in the override map fall back to `DEFAULT_MODULE_ACCESS`.
 *   • Admin + CEO are immutable — they always see every module, regardless
 *     of what's stored here, so they can never lock themselves out.
 *
 * Stored client-side in localStorage for now. Future work: persist to the
 * server so every operator's browser sees the same rules. The key includes
 * a version suffix so we can migrate the schema later without breaking old
 * stored data.
 */

interface State {
  overrides: Partial<Record<AppRole, ModuleId[]>>
  setRoleModules: (role: AppRole, modules: ModuleId[]) => void
  resetRole: (role: AppRole) => void
  resetAll: () => void
}

export const useRoleModules = create<State>()(
  persist(
    (set) => ({
      overrides: {},
      setRoleModules: (role, modules) =>
        set((s) => {
          if (role === 'admin') return s                     // CEO is immutable
          return { overrides: { ...s.overrides, [role]: modules } }
        }),
      resetRole: (role) =>
        set((s) => {
          const next = { ...s.overrides }
          delete next[role]
          return { overrides: next }
        }),
      resetAll: () => set({ overrides: {} }),
    }),
    { name: 'servd-role-modules-v1' },
  ),
)

/** Returns the effective module list for a role, merging defaults + overrides. */
export function modulesForRole(role: AppRole, overrides: Partial<Record<AppRole, ModuleId[]>>): ModuleId[] {
  if (role === 'admin') return DEFAULT_MODULE_ACCESS[role]
  return overrides[role] ?? DEFAULT_MODULE_ACCESS[role]
}
