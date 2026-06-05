'use client'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { useViewAsRole } from '../store/viewAsRole'

interface MePermissions {
  role: string
  permissions: string[]
}

interface MatrixData {
  roles: string[]
  matrix: Record<string, Record<string, boolean>>
}

/**
 * Tiny permission hook backed by GET /permissions/me. The result is cached
 * by react-query so every component that calls useCan('foo') shares one
 * network request. Cache stays fresh for 5 minutes.
 *
 *   if (useCan('orders:refund')) <RefundButton />
 *
 * Returns `false` while loading — components rendering action buttons should
 * gate on this so a brief "no, you can't" flicker is preferable to "yes you
 * can — wait, no" flash. For navigation links, use useCanLazy() which
 * defaults to `true` while loading to avoid sidebar pop-in.
 *
 * When the admin has selected a view-as role (CEO impersonation), this hook
 * derives effective permissions from the live role/permission matrix so the
 * whole UI behaves as the chosen role would see it.
 */
export function useCan(permission: string): boolean {
  const { data } = usePermissions()
  const effective = useEffectiveCan()
  if (effective) return effective.has(permission)
  if (!data) return false
  if (data.role === 'admin') return true
  return data.permissions.includes(permission)
}

/** Like useCan but defaults to true while loading (sidebar-friendly). */
export function useCanLazy(permission: string): boolean {
  const { data, isLoading } = usePermissions()
  const effective = useEffectiveCan()
  if (effective) return effective.has(permission)
  if (isLoading) return true
  if (!data) return false
  if (data.role === 'admin') return true
  return data.permissions.includes(permission)
}

/** Raw access if you need the role + permission list together. */
export function usePermissions() {
  return useQuery<MePermissions>({
    queryKey: ['permissions', 'me'],
    queryFn: () => api.get<MePermissions>('/permissions/me'),
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: 1,                              // gracefully degrade if endpoint fails
  })
}

/**
 * Returns a Set of permission keys for the impersonated role, or null when
 * impersonation is off. We only enable the underlying matrix fetch when the
 * switcher is engaged, so non-admin sessions never pay the cost.
 */
function useEffectiveCan(): Set<string> | null {
  const viewAs = useViewAsRole((s) => s.role)
  const { data: me } = usePermissions()
  const { data: matrix } = useQuery<MatrixData>({
    queryKey: ['permissions', 'matrix'],
    queryFn: () => api.get<MatrixData>('/permissions/matrix'),
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: 1,
    enabled: !!viewAs && me?.role === 'admin',
  })
  if (!viewAs) return null
  if (me?.role !== 'admin') return null      // safety: only the CEO can impersonate
  if (viewAs === 'admin') {
    // CEO viewing as themselves has every permission — derive from the matrix.
    return new Set(Object.keys(matrix?.matrix?.['manager'] ?? {}))
  }
  // The view-as role may not exist in the backend permission matrix (e.g. the
  // new BOH/FOH/marketing/procurement/etc roles only live in the frontend
  // module map). Fall back to the closest matched role's permissions.
  const fallback: Record<string, string> = {
    foh_management: 'manager',
    boh_management: 'manager',
    management:     'manager',
    foh:            'cashier',
    boh:            'kitchen',
    procurement:    'manager',
    marketing:      'manager',
    brand_manager:  'manager',
    fnb_manager:    'manager',
    finance:        'manager',
    hr:             'manager',
  }
  const sourceRole = matrix?.matrix?.[viewAs] ? viewAs : (fallback[viewAs] ?? 'cashier')
  const rolePerms = matrix?.matrix?.[sourceRole] ?? {}
  return new Set(Object.entries(rolePerms).filter(([, v]) => v).map(([k]) => k))
}
