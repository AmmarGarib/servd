'use client'
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'
import { usePermissions } from './useCan'
import { useViewAsRole } from '../store/viewAsRole'
import { useRoleModules, modulesForRole } from '../store/roleModules'
import type { AppRole } from '../lib/appRoles'

/**
 * Workspaces (owner decision 47) — servd grouped by OWNER: Operations,
 * Finance, Marketing, HR, Dev. The definitions live ONLY in the backend
 * (src/lib/workspaces.ts); this file keeps no copy, it reads:
 *
 *   GET /permissions/me          → `workspaces` the caller can open (sections
 *                                  already filtered to their modules) + `owner`
 *   GET /permissions/workspaces  → every workspace in full (ownerRoles,
 *                                  memberRoles, sections) — the Modules page,
 *                                  ordering, and the CEO's view-as preview
 */

export interface WorkspaceSection { key: string; title: string; modules: string[] }

/** One workspace as GET /permissions/me returns it for the caller. */
export interface MyWorkspace {
  id: string
  title: string
  /** The caller owns this workspace. */
  owner: boolean
  sections: WorkspaceSection[]
}

/** The full definition, GET /permissions/workspaces. */
export interface WorkspaceDef {
  id: string
  title: string
  ownerRoles: string[]
  memberRoles: string[]
  sections: WorkspaceSection[]
}

export function useWorkspaceDefs() {
  return useQuery<WorkspaceDef[]>({
    queryKey: ['permissions', 'workspaces'],
    queryFn: () => api.get<WorkspaceDef[]>('/permissions/workspaces'),
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: 1,
  })
}

/** A role's "home" workspaces — the ones it owns or lives in. */
export function isHomeWorkspace(def: WorkspaceDef | undefined, role: string | undefined): boolean {
  if (!def || !role) return false
  return def.ownerRoles.includes(role) || def.memberRoles.includes(role)
}

/**
 * The workspaces the sidebar and the landing page should show, the user's own
 * first. For the CEO previewing another role (view-as), the full definitions
 * are filtered to that role's modules instead — /permissions/me is always the
 * real caller.
 */
export function useMyWorkspaces(): { workspaces: MyWorkspace[]; role: string | undefined; isLoading: boolean } {
  const { data: me, isLoading } = usePermissions()
  const { data: defs } = useWorkspaceDefs()
  const viewAs = useViewAsRole((s) => s.role)
  const overrides = useRoleModules((s) => s.overrides)
  const isSuper = me?.role === 'admin'

  const workspaces = useMemo<MyWorkspace[]>(() => {
    const role = isSuper && viewAs ? viewAs : me?.role
    let list: MyWorkspace[]
    if (isSuper && viewAs) {
      const allowed = new Set<string>(modulesForRole(viewAs as AppRole, overrides))
      list = (defs ?? [])
        .map((d) => ({
          id: d.id,
          title: d.title,
          owner: d.ownerRoles.includes(viewAs),
          sections: d.sections
            .map((s) => ({ ...s, modules: s.modules.filter((m) => allowed.has(m)) }))
            .filter((s) => s.modules.length > 0),
        }))
        .filter((w) => w.sections.length > 0)
    } else {
      list = me?.workspaces ?? []
    }
    // Own workspace(s) first, otherwise the API's order.
    const rank = (w: MyWorkspace) => (w.owner ? 0 : isHomeWorkspace(defs?.find((d) => d.id === w.id), role) ? 1 : 2)
    return list
      .map((w, i) => ({ w, i }))
      .sort((a, b) => rank(a.w) - rank(b.w) || a.i - b.i)
      .map((x) => x.w)
  }, [isSuper, viewAs, me, defs, overrides])

  return { workspaces, role: isSuper && viewAs ? viewAs : me?.role, isLoading }
}

// ─── Head office (D1/D3) — the extra fields on GET /permissions/me ───────────
// Same query key as usePermissions(), so there is ONE request; these types
// only describe the head-office part of the answer.

/** A head office the caller is a member of. */
export interface MyHeadOffice { id: string; name: string }
/** A company the caller reaches through a head office without belonging to it. */
export interface ReachEntry { companyId: string; name: string; via: Array<{ id: string; name: string }> }
/** A live approval hand-over (CEO -> this login). */
export interface MyDelegation { id: string; section: string; scopeName: string; endsAt: string | null }

export interface HeadOfficeMe {
  headOffices?: MyHeadOffice[]
  reach?: ReachEntry[]
  delegations?: MyDelegation[]
  /** The CEO's head-office setup has run (retires the old cost-share UIs). */
  headOfficeSetupApplied?: boolean
}

/** The head-office part of /permissions/me; every list is [] until a head office is linked. */
export function useHeadOfficeMe(): { headOffices: MyHeadOffice[]; reach: ReachEntry[]; delegations: MyDelegation[]; headOfficeSetupApplied: boolean; loaded: boolean } {
  const { data } = useQuery<HeadOfficeMe>({
    queryKey: ['permissions', 'me'],
    queryFn: () => api.get<HeadOfficeMe>('/permissions/me'),
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    retry: 1,
  })
  return {
    headOffices: data?.headOffices ?? [],
    reach: data?.reach ?? [],
    delegations: data?.delegations ?? [],
    headOfficeSetupApplied: data?.headOfficeSetupApplied === true,
    loaded: data !== undefined,
  }
}
