// Intern tracker types shared by the list, a record and My progress (owner, 2026-11-03).

export interface Stats { total: number; onTime: number; late: number; open: number; publishedLate: number; revisions: number }
export interface Trackee {
  id: string; tenantId: string; roleLabel: string; startDate: string; endDate: string | null; active: boolean
  employee: { id: string; userId: string | null; fullName: string; employeeCode: string; status: string }
  loginLinked?: boolean; stats?: Stats
}

export function onTimeRate(s: Stats | undefined): string {
  if (!s) return '—'
  const done = s.onTime + s.late
  return done === 0 ? '—' : `${Math.round((s.onTime / done) * 100)}%`
}

export interface CheckIn { id: string; weekStart: string; note: string; createdAt: string; authorName: string | null }
export interface Review {
  id: string; month: string; strengths: string; improvements: string; recommendation: 'keep' | 'extend' | 'end'
  sharedAt: string | null; authorName: string | null
}
export const RECOMMENDATION_LABEL: Record<Review['recommendation'], string> = { keep: 'Keep', extend: 'Extend', end: 'End' }
