'use client'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'

/**
 * GET /permissions/me — the signed-in user's role and EFFECTIVE modules (role
 * override ?? role default, plus their own moduleAllow, minus moduleDeny), as
 * resolved by the same code the API enforces with.
 *
 * useCan()/useCanLazy() and the view-as matrix lookup are gone with the
 * per-action permission matrix (owner decision 34): the matrix enforced
 * nothing, and module access is the control. Gate UI on modules instead.
 */
export interface MePermissions {
  role: string
  modules: string[]
  /**
   * The workspaces the caller can open (decision 47), sections filtered to
   * their modules; `owner` = the caller owns it. Shape in hooks/useWorkspaces.
   */
  workspaces?: Array<{
    id: string
    title: string
    owner: boolean
    sections: Array<{ key: string; title: string; modules: string[] }>
  }>
  /** Roles this user may add logins for (POST /auth/staff/invite). */
  childRoles?: string[]
}

export function usePermissions() {
  return useQuery<MePermissions>({
    queryKey: ['permissions', 'me'],
    queryFn: () => api.get<MePermissions>('/permissions/me'),
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: 1,                              // gracefully degrade if endpoint fails
  })
}
