'use client'
/**
 * Role LISTS the admin gates buttons on — read from the server, never copied.
 *
 * Two different concepts live in the API and must not be mixed up:
 *
 *  1. MANAGERS — the management tier (backend modules/auth/middleware.ts
 *     `MANAGERS`): admin, owner, legacy manager, management, foh_management,
 *     boh_management, fnb_manager. It is the hard role gate on most
 *     manager-only routes (requireAuth(...MANAGERS)) and the base of the
 *     variant lists (FIRE_ALL_ROLES = MANAGERS + expediter, HR_TEAM = MANAGERS
 *     + hr, …). Served by GET /permissions/role-modules → roles.managers.
 *     → `useManagerRoles()` / `MANAGER_ROLES_FALLBACK` below.
 *
 *  2. OVERRIDE APPROVERS — who may approve an over-cap till action (void,
 *     cancel, discount, refund) with their own session or manager PIN
 *     (backend lib/roles.ts `OVERRIDE_APPROVERS`, owner decision 7). It omits
 *     the legacy 'manager' role on purpose. Served as roles.overrideApprovers.
 *     → `useIsManager()` / `useOverrideApprovers()` in
 *       components/pos/managerRole.ts (the till's approval prompts). Do not
 *       use the managers list for that decision, nor this one for a page gate.
 *
 * The server is the judge either way; these lists only decide which buttons a
 * page shows, so a role never sees a button that answers 403.
 */

import { useQuery } from '@tanstack/react-query'
import { api } from './api'

/**
 * The API's MANAGERS (backend/src/modules/auth/middleware.ts) — the static
 * fallback while GET /permissions/role-modules loads, or on an older API
 * without roles.managers. Keep in step with the server list.
 */
export const MANAGER_ROLES_FALLBACK: readonly string[] = [
  'admin', 'owner', 'manager', 'management', 'foh_management', 'boh_management', 'fnb_manager',
]

/** Extra roles on top of MANAGERS for course pacing's "Fire all now" (server FIRE_ALL_ROLES). */
export const FIRE_ALL_EXTRA_ROLES: readonly string[] = ['expediter']

interface RoleModules { roles?: { managers?: string[] } }

/**
 * The server's MANAGERS list (falls back to MANAGER_ROLES_FALLBACK). Shares the
 * ['permissions', 'role-modules'] query with the till's approver hooks, so it
 * costs no extra request.
 */
export function useManagerRoleList(): readonly string[] {
  const q = useQuery({
    queryKey: ['permissions', 'role-modules'],
    queryFn: () => api.get<RoleModules>('/permissions/role-modules'),
    staleTime: 5 * 60_000,
    retry: false,
    select: (d: RoleModules) => d.roles?.managers,
  })
  const list = q.data
  return Array.isArray(list) && list.length > 0 ? list : MANAGER_ROLES_FALLBACK
}

/**
 * MANAGERS plus any extra roles a page's server rule adds (e.g.
 * `useManagerRoles('hr')` for HR_TEAM-style gates, `useManagerRoles(...FIRE_ALL_EXTRA_ROLES)`).
 * Test with `.has(role)`.
 */
export function useManagerRoles(...extra: string[]): ReadonlySet<string> {
  return managerRoleSet(useManagerRoleList(), extra)
}

/** Pure helper behind useManagerRoles (also used by tests). */
export function managerRoleSet(managers: readonly string[], extra: readonly string[] = []): ReadonlySet<string> {
  return new Set<string>([...managers, ...extra])
}
