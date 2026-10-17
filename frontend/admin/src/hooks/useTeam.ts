'use client'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'

/**
 * GET /hr/team — the WHOLE reporting tree under the caller's employee record
 * (indirect reports too), each row with its manager, depth, today's status
 * and linked login, plus how many HR requests are waiting on the caller.
 * `me` is null when the login is not linked to an employee record.
 */
export type TodayStatus = 'present' | 'late' | 'absent' | 'on_leave' | 'off' | null

export interface TeamMember {
  id: string
  fullName: string
  employeeCode: string
  status: string
  employmentType?: string
  probationEnd?: string | null
  managerId: string | null
  depth: number
  todayStatus: TodayStatus
  userId: string | null
}

export interface TeamResponse {
  /** `id` is null for a CEO with no HR record of their own: the team is then
   *  everyone whose Reporting line is "CEO". */
  me: { id: string | null; fullName: string } | null
  team: TeamMember[]
  pendingApprovals?: number
}

export function useTeam() {
  return useQuery<TeamResponse>({
    queryKey: ['hr-team'],
    queryFn: () => api.get<TeamResponse>('/hr/team'),
    staleTime: 60_000,
  })
}

export const TODAY_META: Record<string, { label: string; color: string }> = {
  present:  { label: 'In',        color: '#3f7d20' },
  late:     { label: 'Late',      color: '#a15c00' },
  absent:   { label: 'Absent',    color: '#b42318' },
  on_leave: { label: 'On leave',  color: '#1d4ed8' },
  off:      { label: 'Off today', color: 'rgb(var(--fg-rgb) / 0.4)' },
}

export function isInToday(m: TeamMember): boolean {
  return m.todayStatus === 'present' || m.todayStatus === 'late'
}

/** Depth-first order of the tree from managerId links (cycle-safe). */
export function treeOrder(meId: string | null, rows: TeamMember[]): Array<TeamMember & { level: number }> {
  const byManager = new Map<string, TeamMember[]>()
  const ids = new Set(rows.map((r) => r.id))
  const roots: TeamMember[] = []
  for (const r of rows) {
    if (r.managerId && r.managerId !== meId && ids.has(r.managerId)) {
      const arr = byManager.get(r.managerId) ?? []
      arr.push(r)
      byManager.set(r.managerId, arr)
    } else {
      roots.push(r)
    }
  }
  const byName = (a: TeamMember, b: TeamMember) => a.fullName.localeCompare(b.fullName)
  const out: Array<TeamMember & { level: number }> = []
  const seen = new Set<string>()
  const walk = (r: TeamMember, level: number) => {
    if (seen.has(r.id) || level > 10) return
    seen.add(r.id)
    out.push({ ...r, level })
    for (const c of (byManager.get(r.id) ?? []).sort(byName)) walk(c, level + 1)
  }
  for (const r of roots.sort(byName)) walk(r, 0)
  // Anything left (a cycle with no root) still shows, at its reported depth.
  for (const r of rows) if (!seen.has(r.id)) out.push({ ...r, level: Math.max(0, (r.depth ?? 1) - 1) })
  return out
}
