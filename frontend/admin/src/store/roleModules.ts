'use client'
import { useEffect } from 'react'
import { create } from 'zustand'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { type AppRole, type ModuleId } from '../lib/appRoles'

/**
 * Role → modules, as the SERVER holds it. In-memory only.
 *
 *   • `defaults` and `overrides` both come from GET /permissions/role-modules
 *     — the same values the API enforces with (backend/src/lib/moduleAccess.ts).
 *     There is no browser-side copy of the defaults any more, and nothing is
 *     persisted to localStorage: a stale browser used to re-upload old
 *     overrides after a reset, and a failed save used to "keep locally" an
 *     override the server never enforced.
 *   • `overrides[role]` is the FULL allow-list for that role when set.
 *   • Admin/CEO always sees every module.
 *   • Edits write through PUT /permissions/role-modules and then re-read the
 *     server; a failed save is thrown to the caller, not swallowed.
 *
 * For the SIGNED-IN user's own sidebar, prefer GET /permissions/me → modules,
 * which also applies that user's moduleAllow / moduleDeny. modulesForRole()
 * is for "what does role X see" — the view-as switcher and the editor.
 */

interface RoleModulesResponse {
  defaults: Partial<Record<AppRole, ModuleId[]>>
  overrides: Partial<Record<AppRole, ModuleId[]>>
  modules: ModuleId[]
}

interface State {
  defaults: Partial<Record<AppRole, ModuleId[]>>
  overrides: Partial<Record<AppRole, ModuleId[]>>
  allModules: ModuleId[]
  hydrate: (r: RoleModulesResponse) => void
  setRoleModules: (role: AppRole, modules: ModuleId[]) => Promise<void>
  resetRole: (role: AppRole) => Promise<void>
  resetAll: () => Promise<void>
}

const QUERY_KEY = ['permissions', 'role-modules'] as const
let refetch: (() => Promise<unknown>) | null = null

async function putRole(role: AppRole, modules: ModuleId[] | null) {
  await api.put('/permissions/role-modules', { role, modules })
  await refetch?.()
}

export const useRoleModules = create<State>()((set, get) => ({
  defaults: {},
  overrides: {},
  allModules: [],
  hydrate: (r) => set({ defaults: r.defaults ?? {}, overrides: r.overrides ?? {}, allModules: r.modules ?? [] }),
  setRoleModules: async (role, modules) => {
    if (role === 'admin') return                          // CEO is immutable
    await putRole(role, modules)
  },
  resetRole: async (role) => { await putRole(role, null) },
  resetAll: async () => {
    for (const role of Object.keys(get().overrides) as AppRole[]) await putRole(role, null)
  },
}))

/** Effective module list for a ROLE (server override ?? server default). */
export function modulesForRole(role: AppRole, overrides: Partial<Record<AppRole, ModuleId[]>>): ModuleId[] {
  const { defaults, allModules } = useRoleModules.getState()
  if (role === 'admin') return allModules
  return overrides[role] ?? defaults[role] ?? []
}

/** Pulls the server's role-module map into the store. Mount once (AppShell). */
export function useSyncRoleModules() {
  const hydrate = useRoleModules((s) => s.hydrate)
  const qc = useQueryClient()
  const { data } = useQuery<RoleModulesResponse>({
    queryKey: QUERY_KEY,
    queryFn: () => api.get('/permissions/role-modules'),
    staleTime: 60_000,
  })
  useEffect(() => {
    refetch = () => qc.invalidateQueries({ queryKey: QUERY_KEY })
  }, [qc])
  useEffect(() => {
    if (data) hydrate(data)
  }, [data, hydrate])
}
