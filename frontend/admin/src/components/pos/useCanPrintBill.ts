'use client'
// "May the signed-in user print / reprint a bill?" — the bill and pre-bill
// routes are CASHIERS-only on the server, so the Print / Reprint buttons show
// only to those roles (see canPrintBill in ./handBack). Reads the server's
// role lists (GET /permissions/role-modules, the same cached query the
// manager check uses) and the user's modules (GET /permissions/me). While
// either is loading the answer is "no": the button appears once known.

import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { useAuthStore } from '../../store/auth'
import { usePermissions } from '../../hooks/useCan'
import { canPrintBill } from './handBack'

interface RoleModules { roles?: { overrideApprovers?: string[]; cashiers?: string[] } }

export function useCanPrintBill(): boolean {
  const role = useAuthStore((s) => s.user?.role ?? null)
  const roleModules = useQuery({
    queryKey: ['permissions', 'role-modules'],
    queryFn: () => api.get<RoleModules>('/permissions/role-modules'),
    staleTime: 5 * 60_000,
    retry: false,
  })
  const { data: me } = usePermissions()
  if (!roleModules.data) return false
  const roles = roleModules.data.roles
  if (!roles?.cashiers?.length && !me) return false
  return canPrintBill(role, {
    cashierRoles: roles?.cashiers ?? null,
    overrideApprovers: roles?.overrideApprovers ?? null,
    modules: me?.modules ?? [],
  })
}
