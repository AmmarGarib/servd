'use client'
// "Is the signed-in user a manager?" for the till's approval prompts — voids,
// order cancels, card-machine refunds. The list is the server's own
// (OVERRIDE_APPROVERS in backend lib/roles.ts, served by GET
// /permissions/role-modules → roles.overrideApprovers); the admin keeps no
// copy. While the list is loading, or on an API without it, the answer is
// "not a manager": the dialog then asks for a manager PIN, which a manager
// can simply type too (the server is the judge either way).

import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { useAuthStore } from '../../store/auth'

interface RoleModules { roles?: { overrideApprovers?: string[] } }

export function useOverrideApprovers() {
  return useQuery({
    queryKey: ['permissions', 'role-modules'],
    queryFn: () => api.get<RoleModules>('/permissions/role-modules'),
    staleTime: 5 * 60_000,
    retry: false,
    select: (d) => d.roles?.overrideApprovers ?? [],
  })
}

/** True when the signed-in user may approve voids / cancels with their own session. */
export function useIsManager(): boolean {
  const role = useAuthStore((s) => s.user?.role ?? null)
  const approvers = useOverrideApprovers()
  return !!role && (approvers.data ?? []).includes(role)
}
