'use client'
// Shared parts of the self-evaluation & appraisal screens (spec: backend/src/modules/hr/performance.ts).
// Scores are HUNDREDTHS of a percent (9250 = 92.50%); weights are basis points (1500 = 15%).

import { useQuery } from '@tanstack/react-query'
import { api } from '../../../lib/api'

export interface PerfArea { key: string; label: string; weightBp: number }
export interface PerfQuestion { id: string; text: string }
export type PerfQuestions = Record<string, PerfQuestion[]>
export type PromptMap = Record<string, string[]>

export interface SelfData {
  areas: Record<string, { rating?: number | null; comment?: string | null; evidence?: string | null; answers?: Record<string, { rating?: number | null; answer?: string | null }> }>
  overallRating?: number | null
  overallWhy?: string | null
  achievements: Array<{ achievement?: string | null; impact?: string | null; evidence?: string | null }>
  strengths?: string | null; improve?: string | null
  develop?: string | null; training?: string | null; goals?: string | null; support?: string | null; challenges?: string | null; other?: string | null
}
export interface ManagerData {
  areas: Record<string, { rating?: number | null; agree?: 'agree' | 'disagree' | null; comment?: string | null }>
  overall?: string | null; gaps?: string | null; training?: string | null; agreeOverall?: 'agree' | 'disagree' | null
}
export interface AreaScore { key: string; label: string; weightBp: number; selfRating: number | null; managerRating: number | null; selfWeighted: number | null; managerWeighted: number | null }

export interface PerfView {
  id: string
  status: string
  statusLabel: string
  cycle: { id: string; name: string; periodFrom: string; periodTo: string } | null
  dueDate: string | null
  roles: Array<'employee' | 'manager' | 'hr'>
  profile: { employeeId: string; employeeCode: string; fullName: string; department: string | null; designation: string | null; branch: string | null; joiningDate: string | null; employmentType: string | null; status: string | null; reportingManager: string | null }
  areas: PerfArea[]
  questions: PerfQuestions
  selfWeightBp: number
  self: SelfData
  manager: ManagerData | null
  scores: { areas: AreaScore[]; selfScore: number | null; managerScore: number | null; finalScore: number | null; category: string | null; categoryLabel: string | null }
  returnNote: string | null
  returnCount: number
  history: unknown
  dates: { assignedAt: string | null; submittedAt: string | null; managerStartedAt: string | null; managerReviewedAt: string | null; approvedAt: string | null; finalizedAt: string | null; employeeAckAt: string | null; reopenedAt: string | null }
  can: { editSelf: boolean; editQuestions: boolean; review: boolean; acknowledge: boolean; reopen: boolean; cancel: boolean }
}

export interface PerfCycle { id: string; tenantId: string; name: string; periodFrom: string; periodTo: string; dueDate: string | null; areas: PerfArea[]; selfWeightBp: number; status: string }
export interface PerfCyclesResponse { cycles: PerfCycle[]; standardAreas: PerfArea[]; ratingLabels: Record<string, string>; categoryLabels: Record<string, string>; statusLabels: Record<string, string> }

export interface TeamData {
  reports: Array<{ id: string; tenantId: string; code: string; name: string; department: string | null; designation: string | null }>
  evaluations: Array<{ id: string; cycleId: string; cycle: string; employeeId: string; employee: string; code: string; status: string; statusLabel: string; dueDate: string | null; finalScore: number | null; categoryLabel: string | null; submittedAt: string | null; updatedAt: string }>
}

export function usePerfCycles() {
  return useQuery({ queryKey: ['perf-cycles'], queryFn: () => api.get<PerfCyclesResponse>('/hr/performance/cycles'), staleTime: 30_000 })
}

export const RATING_LABELS: Record<number, string> = { 5: 'Exceptional', 4: 'Exceeds Expectations', 3: 'Meets Expectations', 2: 'Needs Improvement', 1: 'Unsatisfactory' }
export const RATING_BANDS: Record<number, string> = { 5: '90–100%', 4: '80–89%', 3: '70–79%', 2: '60–69%', 1: 'below 60%' }

/** 9250 -> "92.50%" */
export const pctOf = (v: number | null | undefined) => (v == null ? '—' : `${(v / 100).toFixed(2)}%`)
/** 1500 -> "15%" */
export const bpOf = (v: number) => `${Math.round(v) / 100}%`
export const ratingText = (v: number | null | undefined) => (v == null ? '—' : (Math.round(v * 100) / 100).toString())

export function categoryOf(score: number): { key: string; label: string } {
  if (score >= 9000) return { key: 'exceptional', label: 'Exceptional' }
  if (score >= 8000) return { key: 'exceeds', label: 'Exceeds Expectations' }
  if (score >= 7000) return { key: 'meets', label: 'Meets Expectations' }
  if (score >= 6000) return { key: 'needs_improvement', label: 'Needs Improvement' }
  return { key: 'unsatisfactory', label: 'Unsatisfactory' }
}
/** Token colour per category: green = good, purple = middle, amber/red = weak. */
export const CATEGORY_TONE: Record<string, string> = {
  exceptional: 'var(--erp-success)', exceeds: 'var(--erp-accent)', meets: 'var(--erp-primary)',
  needs_improvement: 'var(--erp-warning)', unsatisfactory: 'var(--erp-danger)',
}

/** An area's employee rating: mean of its question ratings, or the single area rating. null while unrated. */
export function selfAreaRating(areaKey: string, questions: PerfQuestions, self: SelfData): number | null {
  const qs = questions[areaKey] ?? []
  const a = self.areas?.[areaKey]
  if (qs.length === 0) return a?.rating ?? null
  const rs = qs.map((q) => a?.answers?.[q.id]?.rating).filter((r): r is number => typeof r === 'number')
  return rs.length === 0 ? null : rs.reduce((s, r) => s + r, 0) / rs.length
}
export function areaMissing(areaKey: string, questions: PerfQuestions, self: SelfData): boolean {
  const qs = questions[areaKey] ?? []
  const a = self.areas?.[areaKey]
  if (qs.length === 0) return !a?.rating
  return qs.some((q) => !a?.answers?.[q.id]?.rating)
}
/** Σ rating ÷ 5 × weight. Areas not yet rated count 0. */
export function weightedScore(areas: PerfArea[], ratingOf: (key: string) => number | null): number {
  return Math.round(areas.reduce((s, a) => s + ((ratingOf(a.key) ?? 0) / 5) * a.weightBp, 0))
}
export const finalOf = (self: number, mgr: number, selfWeightBp: number) => Math.round((self * selfWeightBp) / 10000 + (mgr * (10000 - selfWeightBp)) / 10000)

export function emptySelf(s?: Partial<SelfData> | null): SelfData {
  const ach = [...(s?.achievements ?? [])]
  while (ach.length < 3) ach.push({ achievement: '', impact: '', evidence: '' })
  return { ...(s ?? {}), areas: s?.areas ?? {}, achievements: ach.slice(0, 3) }
}
export function emptyManager(m?: Partial<ManagerData> | null): ManagerData {
  return { ...(m ?? {}), areas: m?.areas ?? {} }
}

/** Strip empty strings / unrated rows before sending (the API trims and accepts nulls). */
export function cleanSelf(s: SelfData): SelfData {
  return { ...s, achievements: s.achievements.filter((a) => a.achievement?.trim() || a.impact?.trim() || a.evidence?.trim()) }
}

// ── Small UI parts ───────────────────────────────────────────────────────────

const STATUS_BADGE_CLASS: Record<string, string> = {
  not_assigned: 's-badge-muted', pending_employee: 's-badge-muted', draft: 's-badge-muted',
  submitted: 's-badge-amber', resubmitted: 's-badge-amber', manager_in_progress: 's-badge-purple',
  returned: 's-badge-red', finalized: 's-badge-green',
}
export function StatusChip({ status, label }: { status: string; label?: string }) {
  return <span className={`${STATUS_BADGE_CLASS[status] ?? 's-badge-muted'} whitespace-nowrap`}>{label ?? status.replace(/_/g, ' ')}</span>
}

/** A row of 5 big buttons (tap-friendly), 5 = best. */
export function RatingPicker({ value, onChange, disabled, label, invalid, labels = RATING_LABELS }: {
  value: number | null | undefined; onChange?: (v: number) => void; disabled?: boolean; label: string; invalid?: boolean; labels?: Record<number, string>
}) {
  return (
    <div>
      <div role="radiogroup" aria-label={label} className="grid grid-cols-5 gap-1.5 sm:gap-2 max-w-md">
        {[5, 4, 3, 2, 1].map((n) => {
          const on = value === n
          return (
            <button key={n} type="button" role="radio" aria-checked={on} aria-pressed={on} aria-label={`${n} — ${labels[n] ?? ''}`} disabled={disabled}
              onClick={() => onChange?.(n)}
              className={`min-h-[44px] rounded-lg border text-base font-black transition-colors disabled:cursor-default ${on ? 'bg-primary text-primary-on border-transparent' : 'text-white/70 hover:text-white'}`}
              style={on ? undefined : { borderColor: invalid ? 'var(--erp-danger)' : 'rgb(var(--fg-rgb) / 0.15)', opacity: disabled ? 0.55 : 1 }}>
              {n}
            </button>
          )
        })}
      </div>
      <p className="text-[11px] mt-1 h-4" style={{ color: 'rgb(var(--fg-rgb) / 0.6)' }}>{value ? `${value} — ${labels[value] ?? ''}` : invalid ? <span style={{ color: 'var(--erp-danger)' }}>Pick a rating</span> : 'Not rated yet'}</p>
    </div>
  )
}

export function PerfSection({ n, title, hint, children }: { n: number; title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl p-4 sm:p-5" style={{ background: 'rgb(var(--fg-rgb) / 0.03)', border: '1px solid rgb(var(--fg-rgb) / 0.07)' }}>
      <h2 className="text-base font-black text-white/90"><span className="text-success mr-2">{n}</span>{title}</h2>
      {hint && <p className="text-xs text-white/55 mt-0.5">{hint}</p>}
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  )
}

export function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="block text-xs font-bold text-white/70 mb-1">{label}</span>
      {children}
      {hint && <span className="block text-[11px] text-white/50 mt-1">{hint}</span>}
    </label>
  )
}

export function ScoreBanner({ self, manager, final, selfWeightBp, categoryLabel, categoryKey, provisional }: {
  self: number | null; manager: number | null; final: number | null; selfWeightBp: number; categoryLabel?: string | null; categoryKey?: string | null; provisional?: boolean
}) {
  const tone = categoryKey ? CATEGORY_TONE[categoryKey] : 'var(--erp-primary-ink)'
  return (
    <div className="rounded-2xl p-4 sm:p-5" style={{ background: 'rgb(var(--fg-rgb) / 0.03)', border: `1px solid ${tone}` }} role="status">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[11px] font-black uppercase tracking-wider text-white/55">{provisional ? 'Provisional final score' : 'Final score'}</p>
          <p className="text-3xl font-black" style={{ color: tone }}>{pctOf(final)}</p>
          {categoryLabel && <p className="text-sm font-bold mt-0.5" style={{ color: tone }}>{categoryLabel}</p>}
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
          <dt className="text-white/60">Self ({bpOf(selfWeightBp)})</dt><dd className="font-black text-white/90 text-right">{pctOf(self)}</dd>
          <dt className="text-white/60">Manager ({bpOf(10000 - selfWeightBp)})</dt><dd className="font-black text-white/90 text-right">{pctOf(manager)}</dd>
        </dl>
      </div>
    </div>
  )
}

export function ProgressBar({ value, max, tone = 'var(--erp-primary)', label }: { value: number; max: number; tone?: string; label?: string }) {
  const w = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0
  return (
    <div role="progressbar" aria-valuenow={Math.round(w)} aria-valuemin={0} aria-valuemax={100} aria-label={label} className="h-2 rounded-full overflow-hidden" style={{ background: 'rgb(var(--fg-rgb) / 0.08)' }}>
      <div className="h-full rounded-full" style={{ width: `${w}%`, background: tone }} />
    </div>
  )
}

export const textareaCls = 'w-full rounded-lg px-3 py-2 text-sm bg-white/[0.04] border border-white/10 text-white/90 focus:outline-none focus:border-primary disabled:opacity-70 min-h-[72px]'
export const inputCls = 'w-full rounded-lg px-3 py-2 text-sm bg-white/[0.04] border border-white/10 text-white/90 focus:outline-none focus:border-primary disabled:opacity-70'
export const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong')
