'use client'
import { useEffect, useRef } from 'react'
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { type AppRole, type ModuleId, DEFAULT_MODULE_ACCESS } from '../lib/appRoles'

/**
 * Persisted overrides to the role → modules map.
 *
 *   • `overrides[role]` is the FULL allow-list for that role when set.
 *   • Roles not in the override map fall back to `DEFAULT_MODULE_ACCESS`.
 *   • Admin + CEO are immutable — they always see every module, regardless
 *     of what's stored here, so they can never lock themselves out.
 *
 * Source of truth is now the SERVER (RoleModuleAccess table, enforced by the
 * API on the finance/reports surfaces). localStorage remains as an
 * offline-first cache: `useSyncRoleModules()` (mounted in AppShell) pulls the
 * server rows on load, and every edit here writes through to
 * PUT /permissions/role-modules.
 */

interface State {
  overrides: Partial<Record<AppRole, ModuleId[]>>
  setRoleModules: (role: AppRole, modules: ModuleId[]) => void
  resetRole: (role: AppRole) => void
  resetAll: () => void
  /** Replace the whole map with server truth (no write-back). */
  hydrate: (overrides: Partial<Record<AppRole, ModuleId[]>>) => void
}

function putRole(role: AppRole, modules: ModuleId[] | null) {
  api.put('/permissions/role-modules', { role, modules })
    .catch((e) => console.warn('role-modules save failed (kept locally):', e))
}

export const useRoleModules = create<State>()(
  persist(
    (set, get) => ({
      overrides: {},
      setRoleModules: (role, modules) =>
        set((s) => {
          if (role === 'admin') return s                     // CEO is immutable
          putRole(role, modules)
          return { overrides: { ...s.overrides, [role]: modules } }
        }),
      resetRole: (role) =>
        set((s) => {
          const next = { ...s.overrides }
          delete next[role]
          putRole(role, null)
          return { overrides: next }
        }),
      resetAll: () => {
        for (const role of Object.keys(get().overrides) as AppRole[]) putRole(role, null)
        set({ overrides: {} })
      },
      hydrate: (overrides) => set({ overrides }),
    }),
    { name: 'servd-role-modules-v1' },
  ),
)

/** Returns the effective module list for a role, merging defaults + overrides. */
export function modulesForRole(role: AppRole, overrides: Partial<Record<AppRole, ModuleId[]>>): ModuleId[] {
  if (role === 'admin') return DEFAULT_MODULE_ACCESS[role]
  return overrides[role] ?? DEFAULT_MODULE_ACCESS[role]
}

/**
 * Pulls the server's role-module rows into the store. Mount once (AppShell).
 * One-time migration: if the server has NO rows yet but this browser carries
 * legacy localStorage overrides (pre-server era), push them up instead of
 * clobbering them — the CEO's old config becomes the shared server config.
 */
export function useSyncRoleModules() {
  const hydrate = useRoleModules((s) => s.hydrate)
  const migrated = useRef(false)
  const { data } = useQuery<{ defaults: Record<string, string[]>; overrides: Record<string, string[]> }>({
    queryKey: ['permissions', 'role-modules'],
    queryFn: () => api.get('/permissions/role-modules'),
    staleTime: 60_000,
  })
  useEffect(() => {
    if (!data || migrated.current) return
    migrated.current = true
    const serverOverrides = data.overrides ?? {}
    const local = useRoleModules.getState().overrides
    if (Object.keys(serverOverrides).length === 0 && Object.keys(local).length > 0) {
      for (const [role, modules] of Object.entries(local)) putRole(role as AppRole, modules as ModuleId[])
      return   // keep local view; server now matches
    }
    hydrate(serverOverrides as Partial<Record<AppRole, ModuleId[]>>)
  }, [data, hydrate])
}
