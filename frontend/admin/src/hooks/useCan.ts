'use client'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'

interface MePermissions {
  role: string
  permissions: string[]
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
 */
export function useCan(permission: string): boolean {
  const { data } = usePermissions()
  if (!data) return false
  if (data.role === 'admin') return true
  return data.permissions.includes(permission)
}

/** Like useCan but defaults to true while loading (sidebar-friendly). */
export function useCanLazy(permission: string): boolean {
  const { data, isLoading } = usePermissions()
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
