// Employee self-evaluation & performance appraisal (owner, 2026-11-06). REPLACES the old "Performance reviews"
// HR section (forms.ts performance_review → movedTo; its records stay readable). Owner's answers: replace the old
// form; the reporting manager's "Approve & Finalize" is the last step (HR may reopen with a reason).
//
// The default form is the owner's "Employee Self-Evaluation" Word file: 7 sections (profile, self-rating, overall
// self-assessment, 3 achievements, strengths / development, goals & support, acknowledgement) and 9 performance
// areas with fixed weights (STANDARD_AREAS). A CYCLE (HR) is a review period with its areas + weights (basis
// points, sum 10000) and the self / manager split of the final score (default 30 / 70). The REPORTING MANAGER —
// the employee's manager in the HR reporting line (HrEmployee.managerId → that employee's login; the company CEO for
// someone who reports to the CEO) — assigns an evaluation with their own questions per area (or a template), the
// employee rates every question 1–5 (an area with no questions gets one rating), the manager rates every area 1–5
// independently (never touching the employee's part), then returns it for revision (note ≥10) or approves, which
// FINALIZES it and computes the scores:
//   area score  = rating ÷ 5 × weight   (an area's employee rating = mean of its question ratings)
//   self / manager score = Σ area scores (hundredths of a percent: 9250 = 92.50%)
//   final       = self × selfWeight + manager × (1 − selfWeight)
//   category    ≥90 Exceptional · ≥80 Exceeds Expectations · ≥70 Meets Expectations · ≥60 Needs Improvement · else
//               Unsatisfactory
// Statuses: pending_employee → draft → submitted → manager_in_progress → finalized; returned → resubmitted. "Not
// assigned" is computed for active employees with no evaluation in the cycle. Every submission is kept in
// `history`; the employee sees the manager's assessment only once finalized.
//
// Who may do what (company = the EMPLOYEE's; another company's evaluation or employee is 404):
//   employee   their own evaluations: read, save draft, submit, acknowledge the final result
//   manager    evaluations where managerUserId is them (assigned while they were the reporting manager): assign
//              (their direct reports only — 403 NOT_YOUR_REPORT), edit questions before the employee submits,
//              review / return / approve, cancel one not yet submitted
//   HR         HR_ADMIN holding staff_hr, companies they belong to: cycles, company templates, every evaluation,
//              reopen a finalized one (reason ≥10), the Results dashboard and exports, assign on a manager's behalf
// Routes: /hr/performance/* (self-service, ungated like /hr/me) and /hr/performance/admin/* (gated staff_hr in
// lib/moduleAccess.ts). Bell notices (kind hr.performance) at assign, submit, return, finalize, reopen.
// Tests: tests/performanceEvaluation.test.ts.
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { HrEmployee, PerformanceEvaluation, Prisma, UserRole } from '@prisma/client'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { serviceClient as prisma } from '../../lib/prisma.js'
import { requireAuth, ALL_STAFF } from '../auth/middleware.js'
import { AppError, ForbiddenError, NotFoundError } from '../../lib/errors.js'
import { audit } from '../../lib/audit.js'
import { effectiveModulesForUser } from '../../lib/moduleAccess.js'
import { notifyStaffMany, queueStaffNotify, type NotifyInput } from '../../lib/staffNotify.js'
import { exportFormatOf, sendReportFor, type ReportRow } from '../../lib/reportExport.js'
import { companyCeo, employeeLabelsAcross } from './service.js'

const HR_ADMIN = ['admin', 'owner', 'management', 'hr'] as UserRole[]

// ─── The standard form (the owner's Word file) ──────────────────────────────

export interface Area { key: string; label: string; weightBp: number }
export const STANDARD_AREAS: Area[] = [
  { key: 'job_knowledge', label: 'Job Knowledge & Technical Skills', weightBp: 1500 },
  { key: 'quality', label: 'Quality of Work', weightBp: 1500 },
  { key: 'productivity', label: 'Productivity & Timeliness', weightBp: 1500 },
  { key: 'attendance', label: 'Attendance & Punctuality', weightBp: 1000 },
  { key: 'communication', label: 'Communication', weightBp: 1000 },
  { key: 'teamwork', label: 'Teamwork & Collaboration', weightBp: 1000 },
  { key: 'initiative', label: 'Initiative & Ownership', weightBp: 1000 },
  { key: 'discipline', label: 'Discipline & Professional Conduct', weightBp: 1000 },
  { key: 'problem_solving', label: 'Problem Solving & Adaptability', weightBp: 500 },
]

/** The built-in template: the Word file's prompts, worded for any role. */
export const STANDARD_QUESTIONS: Record<string, string[]> = {
  job_knowledge: ['How well do I know the tools, systems and processes my role uses? Where have I applied this knowledge well?'],
  quality: ['Is my work accurate, to standard and error-free? How much rework or correction has it needed?'],
  productivity: ['Have I delivered the agreed volume of work? How often did I meet or miss deadlines, and why?'],
  attendance: ['Have I been regularly present and on time, including for meetings, shifts and events?'],
  communication: ['Do I keep my manager and other teams updated clearly and on time?'],
  teamwork: ['How well have I worked with my team and other departments?'],
  initiative: ['Which ideas or improvements did I bring without being asked? Did I see tasks through to the end?'],
  discipline: ['Have I followed company rules, approval processes and standards?'],
  problem_solving: ['Describe a problem or last-minute change I handled. What did I do?'],
}

export const RATING_LABEL: Record<number, string> = { 5: 'Exceptional', 4: 'Exceeds Expectations', 3: 'Meets Expectations', 2: 'Needs Improvement', 1: 'Unsatisfactory' }
export const CATEGORIES = ['exceptional', 'exceeds', 'meets', 'needs_improvement', 'unsatisfactory'] as const
export type Category = typeof CATEGORIES[number]
export const CATEGORY_LABEL: Record<Category, string> = {
  exceptional: 'Exceptional', exceeds: 'Exceeds Expectations', meets: 'Meets Expectations',
  needs_improvement: 'Needs Improvement', unsatisfactory: 'Unsatisfactory',
}
export const STATUS_LABEL: Record<string, string> = {
  not_assigned: 'Not Assigned', pending_employee: 'Pending Employee Evaluation', draft: 'Draft', submitted: 'Submitted',
  resubmitted: 'Resubmitted', manager_in_progress: 'Manager Assessment in Progress', returned: 'Returned for Revision',
  finalized: 'Finalized',
}
const EMPLOYEE_EDITABLE = ['pending_employee', 'draft', 'returned']
const AWAITING_MANAGER = ['submitted', 'resubmitted', 'manager_in_progress']

/** Hundredths of a percent → category. */
export function categoryOf(score: number): Category {
  if (score >= 9000) return 'exceptional'
  if (score >= 8000) return 'exceeds'
  if (score >= 7000) return 'meets'
  if (score >= 6000) return 'needs_improvement'
  return 'unsatisfactory'
}

// ─── Shapes ─────────────────────────────────────────────────────────────────

export interface Question { id: string; text: string }
type Questions = Record<string, Question[]>
const rating = z.number().int().min(1).max(5)
const text = (max = 4000) => z.string().trim().max(max).optional().nullable()

const selfSchema = z.object({
  areas: z.record(z.object({
    rating: rating.optional().nullable(),
    comment: text(),
    evidence: text(),
    answers: z.record(z.object({ rating: rating.optional().nullable(), answer: text() })).optional(),
  })).default({}),
  overallRating: rating.optional().nullable(),
  overallWhy: text(),
  achievements: z.array(z.object({ achievement: text(1000), impact: text(1000), evidence: text(1000) })).max(3).default([]),
  strengths: text(), improve: text(),
  develop: text(), training: text(), goals: text(), support: text(), challenges: text(), other: text(),
}).strict()
type Self = z.infer<typeof selfSchema>

const managerSchema = z.object({
  areas: z.record(z.object({
    rating: rating.optional().nullable(),
    agree: z.enum(['agree', 'disagree']).optional().nullable(),
    comment: text(),
  })).default({}),
  overall: text(), gaps: text(), training: text(), agreeOverall: z.enum(['agree', 'disagree']).optional().nullable(),
}).strict()
type Manager = z.infer<typeof managerSchema>

const areasSchema = z.array(z.object({
  key: z.string().trim().regex(/^[a-z][a-z0-9_]{1,40}$/, 'Area keys are lower-case letters, digits and _'),
  label: z.string().trim().min(2).max(80),
  weightBp: z.number().int().min(1).max(10000),
})).min(1).max(20)
  .refine((a) => new Set(a.map((x) => x.key)).size === a.length, 'Each area once')
  .refine((a) => a.reduce((s, x) => s + x.weightBp, 0) === 10000, 'The area weights must add up to 100%')

const questionsSchema = z.record(z.array(z.string().trim().min(3).max(600)).max(10))

/** Questions as stored, keyed by the cycle's areas only (unknown areas dropped; ids kept for matching answers). */
function normaliseQuestions(areas: Area[], raw: Record<string, string[]> | undefined, prior?: Questions): Questions {
  const out: Questions = {}
  for (const a of areas) {
    const list = (raw?.[a.key] ?? STANDARD_QUESTIONS[a.key] ?? []).filter(Boolean)
    out[a.key] = list.map((t, i) => {
      const same = prior?.[a.key]?.find((q) => q.text === t)
      return { id: same?.id ?? `${a.key}_${i}_${randomUUID().slice(0, 8)}`, text: t }
    })
  }
  return out
}

// ─── Scoring ────────────────────────────────────────────────────────────────

/** The employee's rating for an area: the mean of its question ratings, or the area rating when it has none. */
export function selfAreaRating(area: string, questions: Questions, self: Self): number | null {
  const qs = questions[area] ?? []
  const a = self.areas?.[area]
  if (qs.length === 0) return a?.rating ?? null
  const rated = qs.map((q) => a?.answers?.[q.id]?.rating).filter((r): r is number => typeof r === 'number')
  if (rated.length !== qs.length) return null
  return rated.reduce((s, r) => s + r, 0) / rated.length
}

/** Σ rating ÷ 5 × weight, in hundredths of a percent — null while any area is unrated. */
export function weightedScore(areas: Area[], ratingOf: (key: string) => number | null): number | null {
  let total = 0
  for (const a of areas) {
    const r = ratingOf(a.key)
    if (r == null) return null
    total += (r / 5) * a.weightBp
  }
  return Math.round(total)
}

export function finalScoreOf(self: number, manager: number, selfWeightBp: number): number {
  return Math.round((self * selfWeightBp + manager * (10000 - selfWeightBp)) / 10000)
}

// ─── Who is asking ──────────────────────────────────────────────────────────

async function holdsStaffHr(req: FastifyRequest): Promise<boolean> {
  const su = req.staffUser!
  if (su.role === 'admin') return true
  if (!HR_ADMIN.includes(su.role as UserRole)) return false
  const u = await prisma.user.findUnique({ where: { id: su.id }, select: { moduleAllow: true, moduleDeny: true } })
  const modules = await effectiveModulesForUser({ role: su.role as UserRole, moduleAllow: u?.moduleAllow ?? [], moduleDeny: u?.moduleDeny ?? [] })
  return modules.has('staff_hr')
}
async function isHrFor(req: FastifyRequest, tenantId: string): Promise<boolean> {
  return req.staffUser!.memberTenantIds.includes(tenantId) && holdsStaffHr(req)
}
async function assertHr(req: FastifyRequest): Promise<void> {
  if (!(await holdsStaffHr(req))) throw new ForbiddenError('Only HR manages evaluation cycles and results')
}
/** Companies an HR reader sees: the portfolio set, else the active company. */
function hrTenants(req: FastifyRequest): string[] {
  const su = req.staffUser!
  if (req.headers['x-servd-portfolio'] === '1' && su.memberTenantIds.length) {
    const f = su.tenantFilter
    if (f && typeof f === 'object' && 'in' in f) return f.in.filter((id) => su.memberTenantIds.includes(id))
    return su.memberTenantIds
  }
  return su.tenantId ? [su.tenantId] : []
}
async function ownEmployeeIds(req: FastifyRequest): Promise<string[]> {
  return (await prisma.hrEmployee.findMany({ where: { userId: req.staffUser!.id }, select: { id: true } })).map((e) => e.id)
}

type Role = 'employee' | 'manager' | 'hr'
/** The evaluation and the caller's roles on it; 404 when they have none. */
async function loadFor(req: FastifyRequest, id: string): Promise<{ ev: PerformanceEvaluation; roles: Set<Role> }> {
  const ev = await prisma.performanceEvaluation.findUnique({ where: { id } })
  if (!ev) throw new NotFoundError('Evaluation', id)
  const roles = new Set<Role>()
  if ((await ownEmployeeIds(req)).includes(ev.employeeId)) roles.add('employee')
  if (ev.managerUserId === req.staffUser!.id) roles.add('manager')
  if (await isHrFor(req, ev.tenantId)) roles.add('hr')
  if (!roles.size) throw new NotFoundError('Evaluation', id)
  return { ev, roles }
}

/**
 * The reporting manager of an employee, from the HR reporting line: the manager employee's login; for someone who
 * reports to the CEO (reportsToCeo, no manager) the company's CEO login. Null = nobody to assign it to.
 */
export async function reportingManagerOf(emp: Pick<HrEmployee, 'tenantId' | 'managerId' | 'data'>): Promise<{ userId: string; employeeId: string | null } | null> {
  if (emp.managerId) {
    const m = await prisma.hrEmployee.findUnique({ where: { id: emp.managerId }, select: { id: true, userId: true, tenantId: true } })
    if (m?.userId && m.tenantId === emp.tenantId) {
      const u = await prisma.user.findUnique({ where: { id: m.userId }, select: { isActive: true } })
      if (u?.isActive) return { userId: m.userId, employeeId: m.id }
    }
    return null
  }
  if ((emp.data as Record<string, unknown> | null)?.['reportsToCeo'] === true) {
    const ceo = await companyCeo(emp.tenantId)
    if (ceo.userIds[0]) return { userId: ceo.userIds[0], employeeId: ceo.employee?.id ?? null }
  }
  return null
}

// ─── Notices ────────────────────────────────────────────────────────────────

function notify(rows: Array<Omit<NotifyInput, 'kind'> | null>): void {
  const list = rows.filter((r): r is Omit<NotifyInput, 'kind'> => !!r && !!r.userId).map((r) => ({ ...r, kind: 'hr.performance' as const }))
  if (list.length) queueStaffNotify(() => notifyStaffMany(list))
}
async function employeeLogin(employeeId: string): Promise<string | null> {
  return (await prisma.hrEmployee.findUnique({ where: { id: employeeId }, select: { userId: true } }))?.userId ?? null
}

// ─── Views ──────────────────────────────────────────────────────────────────

async function profileOf(ev: Pick<PerformanceEvaluation, 'employeeId' | 'managerEmployeeId' | 'managerUserId'>) {
  const emp = await prisma.hrEmployee.findUniqueOrThrow({ where: { id: ev.employeeId } })
  const label = await employeeLabelsAcross([emp])
  const mgr = ev.managerEmployeeId
    ? await prisma.hrEmployee.findUnique({ where: { id: ev.managerEmployeeId }, select: { fullName: true } })
    : null
  const mgrUser = mgr ? null : await prisma.user.findUnique({ where: { id: ev.managerUserId }, select: { name: true } })
  return {
    employeeId: emp.id, employeeCode: emp.employeeCode, fullName: emp.fullName,
    department: label(emp.departmentId), designation: label(emp.designationId), branch: label(emp.locationId),
    joiningDate: emp.joiningDate, employmentType: emp.employmentType, status: emp.status,
    reportingManager: mgr?.fullName ?? mgrUser?.name ?? null,
  }
}

function scoresOf(ev: PerformanceEvaluation) {
  const areas = ev.areas as unknown as Area[]
  const questions = ev.questions as unknown as Questions
  const self = ev.self as unknown as Self
  const manager = ev.manager as unknown as Manager
  const selfRating = (k: string) => selfAreaRating(k, questions, self)
  const mgrRating = (k: string) => manager.areas?.[k]?.rating ?? null
  return {
    areas: areas.map((a) => {
      const s = selfRating(a.key), m = mgrRating(a.key)
      return {
        key: a.key, label: a.label, weightBp: a.weightBp,
        selfRating: s == null ? null : Math.round(s * 100) / 100,
        managerRating: m,
        selfWeighted: s == null ? null : Math.round((s / 5) * a.weightBp),
        managerWeighted: m == null ? null : Math.round((m / 5) * a.weightBp),
      }
    }),
    selfScore: weightedScore(areas, selfRating),
    managerScore: weightedScore(areas, mgrRating),
  }
}

/** The evaluation as the caller may see it: the manager's part only to the manager / HR, or once finalized. */
async function viewOf(ev: PerformanceEvaluation, roles: Set<Role>) {
  const cycle = await prisma.performanceCycle.findUnique({ where: { id: ev.cycleId }, select: { id: true, name: true, periodFrom: true, periodTo: true } })
  const seesManager = roles.has('manager') || roles.has('hr') || ev.status === 'finalized'
  const live = scoresOf(ev)
  return {
    id: ev.id, tenantId: ev.tenantId, status: ev.status, statusLabel: STATUS_LABEL[ev.status] ?? ev.status,
    cycle, dueDate: ev.dueDate, roles: [...roles],
    profile: await profileOf(ev),
    areas: ev.areas, questions: ev.questions, selfWeightBp: ev.selfWeightBp,
    self: ev.self,
    manager: seesManager ? ev.manager : null,
    scores: {
      areas: live.areas.map((a) => (seesManager ? a : { ...a, managerRating: null, managerWeighted: null })),
      selfScore: live.selfScore,
      managerScore: seesManager ? live.managerScore : null,
      finalScore: ev.status === 'finalized' || roles.has('hr') || roles.has('manager') ? ev.finalScore : null,
      category: ev.status === 'finalized' ? ev.category : null,
      categoryLabel: ev.status === 'finalized' && ev.category ? CATEGORY_LABEL[ev.category as Category] : null,
    },
    returnNote: ev.returnNote, returnCount: ev.returnCount,
    history: roles.has('hr') || roles.has('manager') ? ev.history : (ev.history as unknown[]).length,
    dates: {
      assignedAt: ev.createdAt, submittedAt: ev.submittedAt, managerStartedAt: ev.managerStartedAt,
      managerReviewedAt: ev.finalizedAt, approvedAt: ev.finalizedAt, finalizedAt: ev.finalizedAt,
      employeeAckAt: ev.employeeAckAt, reopenedAt: ev.reopenedAt,
    },
    can: {
      editSelf: roles.has('employee') && EMPLOYEE_EDITABLE.includes(ev.status),
      editQuestions: (roles.has('manager') || roles.has('hr')) && ['pending_employee', 'draft'].includes(ev.status),
      review: roles.has('manager') && AWAITING_MANAGER.includes(ev.status),
      acknowledge: roles.has('employee') && ev.status === 'finalized' && !ev.employeeAckAt,
      reopen: roles.has('hr') && ev.status === 'finalized',
      cancel: (roles.has('manager') || roles.has('hr')) && ['pending_employee', 'draft'].includes(ev.status),
    },
  }
}

// ─── Validation on submit / approve ─────────────────────────────────────────

function assertSelfComplete(ev: PerformanceEvaluation, self: Self) {
  const areas = ev.areas as unknown as Area[]
  const questions = ev.questions as unknown as Questions
  const gaps = areas.filter((a) => selfAreaRating(a.key, questions, self) == null)
  if (gaps.length) throw new AppError('RATINGS_MISSING', `Rate every question in: ${gaps.map((a) => a.label).join(', ')}`, 422, { missing: gaps.map((a) => a.label), missingKeys: gaps.map((a) => a.key) })
  if (!self.overallRating) throw new AppError('OVERALL_MISSING', 'Pick your overall self-rating', 422)
  if (!self.overallWhy?.trim()) throw new AppError('OVERALL_WHY_MISSING', 'Say why you chose your overall rating', 422)
}
function assertManagerComplete(ev: PerformanceEvaluation, m: Manager) {
  const areas = ev.areas as unknown as Area[]
  const gaps = areas.filter((a) => !m.areas?.[a.key]?.rating)
  if (gaps.length) throw new AppError('RATINGS_MISSING', `Give your rating for: ${gaps.map((a) => a.label).join(', ')}`, 422, { missing: gaps.map((a) => a.label), missingKeys: gaps.map((a) => a.key) })
  if (!m.overall?.trim()) throw new AppError('OVERALL_MISSING', 'Write your overall assessment', 422)
}

// ─── Results (analytics) ────────────────────────────────────────────────────

const resultsQuery = z.object({
  cycleId: z.string().uuid().optional(), departmentId: z.string().optional(), designationId: z.string().optional(),
  managerUserId: z.string().optional(), locationId: z.string().optional(), category: z.enum(CATEGORIES).optional(),
  status: z.string().optional(), q: z.string().trim().max(80).optional(), employeeId: z.string().uuid().optional(),
  format: z.string().optional(),
})

const STOP = new Set(['the', 'and', 'for', 'with', 'to', 'of', 'in', 'on', 'a', 'an', 'my', 'more', 'i', 'is', 'be', 'on', 'at', 'from', 'need', 'would', 'help', 'want', 'like', 'some', 'better', 'training', 'skills', 'skill', 'how', 'our', 'me', 'it', 'as', 'by', 'that', 'this', 'will', 'or', 'any', 'have'])
function topTerms(texts: string[], n = 12): Array<{ term: string; count: number }> {
  const counts = new Map<string, number>()
  for (const t of texts) {
    const seen = new Set<string>()
    for (const w of t.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)) {
      if (w.length < 3 || STOP.has(w) || seen.has(w)) continue
      seen.add(w)
      counts.set(w, (counts.get(w) ?? 0) + 1)
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([term, count]) => ({ term, count }))
}
const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((s, x) => s + x, 0) / xs.length) : null)

export async function buildResults(tenantIds: string[], q: z.infer<typeof resultsQuery>) {
  const cycles = await prisma.performanceCycle.findMany({ where: { tenantId: { in: tenantIds } }, orderBy: [{ periodTo: 'desc' }, { createdAt: 'desc' }] })
  const cycle = q.cycleId ? cycles.find((c) => c.id === q.cycleId) : cycles[0]
  if (q.cycleId && !cycle) throw new NotFoundError('Evaluation cycle', q.cycleId)
  const emps = await prisma.hrEmployee.findMany({
    where: { tenantId: cycle ? cycle.tenantId : { in: tenantIds } },
    select: { id: true, tenantId: true, employeeCode: true, fullName: true, departmentId: true, designationId: true, gradeId: true, locationId: true, managerId: true, status: true, joiningDate: true },
  })
  const label = await employeeLabelsAcross(emps)
  const empById = new Map(emps.map((e) => [e.id, e]))
  const evs = cycle ? await prisma.performanceEvaluation.findMany({ where: { cycleId: cycle.id } }) : []
  const managerIds = [...new Set(evs.map((e) => e.managerUserId))]
  const managers = new Map((managerIds.length ? await prisma.user.findMany({ where: { id: { in: managerIds } }, select: { id: true, name: true } }) : []).map((u) => [u.id, u.name ?? 'Manager']))
  const evByEmp = new Map(evs.map((e) => [e.employeeId, e]))

  const matchEmp = (e: (typeof emps)[number]) =>
    (!q.departmentId || e.departmentId === q.departmentId) && (!q.designationId || e.designationId === q.designationId)
    && (!q.locationId || e.locationId === q.locationId) && (!q.employeeId || e.id === q.employeeId)
    && (!q.q || `${e.fullName} ${e.employeeCode}`.toLowerCase().includes(q.q.toLowerCase()))
  const eligible = emps.filter((e) => ['active', 'on_leave'].includes(e.status) && matchEmp(e))
  const rows = evs.filter((ev) => {
    const e = empById.get(ev.employeeId)
    if (!e || !matchEmp(e)) return false
    if (q.managerUserId && ev.managerUserId !== q.managerUserId) return false
    if (q.category && ev.category !== q.category) return false
    if (q.status && q.status !== 'not_assigned' && ev.status !== q.status) return false
    return true
  })
  const scored = rows.map((ev) => ({ ev, s: scoresOf(ev), e: empById.get(ev.employeeId)! }))
  const final = scored.filter((x) => x.ev.status === 'finalized')
  const areas = (cycle?.areas as unknown as Area[] | undefined) ?? STANDARD_AREAS

  const overview = {
    eligible: eligible.length,
    assigned: rows.length,
    notAssigned: eligible.filter((e) => !evByEmp.has(e.id)).length,
    submitted: rows.filter((r) => r.submittedAt).length,
    pendingEmployee: rows.filter((r) => EMPLOYEE_EDITABLE.includes(r.status)).length,
    pendingManager: rows.filter((r) => AWAITING_MANAGER.includes(r.status)).length,
    finalized: final.length,
    averageFinal: avg(final.map((x) => x.ev.finalScore!)),
    averageSelf: avg(final.map((x) => x.ev.selfScore!)),
    averageManager: avg(final.map((x) => x.ev.managerScore!)),
  }
  const distribution = CATEGORIES.map((c) => {
    const n = final.filter((x) => x.ev.category === c).length
    return { category: c, label: CATEGORY_LABEL[c], count: n, pct: final.length ? Math.round((n / final.length) * 1000) / 10 : 0 }
  })
  const groupBy = <K extends string>(keyOf: (x: (typeof final)[number]) => K | null) => {
    const m = new Map<K, typeof final>()
    for (const x of final) { const k = keyOf(x); if (!k) continue; m.set(k, [...(m.get(k) ?? []), x]) }
    return m
  }
  const departments = [...groupBy((x) => (x.e.departmentId ?? '__none') as string).entries()].map(([id, xs]) => ({
    departmentId: id === '__none' ? null : id, name: id === '__none' ? 'No department' : label(id) ?? 'Department',
    count: xs.length, averageFinal: avg(xs.map((x) => x.ev.finalScore!)), averageSelf: avg(xs.map((x) => x.ev.selfScore!)), averageManager: avg(xs.map((x) => x.ev.managerScore!)),
  })).sort((a, b) => (b.averageFinal ?? 0) - (a.averageFinal ?? 0))
  const selfVsManager = final.map((x) => ({
    evaluationId: x.ev.id, employeeId: x.e.id, name: x.e.fullName, code: x.e.employeeCode,
    selfScore: x.ev.selfScore!, managerScore: x.ev.managerScore!, gap: x.ev.selfScore! - x.ev.managerScore!,
  })).sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap))
  const areaStats = areas.map((a) => {
    const self = final.map((x) => x.s.areas.find((y) => y.key === a.key)?.selfRating).filter((r): r is number => r != null)
    const mgr = final.map((x) => x.s.areas.find((y) => y.key === a.key)?.managerRating).filter((r): r is number => r != null)
    const r2 = (xs: number[]) => (xs.length ? Math.round((xs.reduce((s, v) => s + v, 0) / xs.length) * 100) / 100 : null)
    return { key: a.key, label: a.label, weightBp: a.weightBp, averageSelf: r2(self), averageManager: r2(mgr) }
  })
  const ranked = [...areaStats].filter((a) => a.averageManager != null).sort((a, b) => b.averageManager! - a.averageManager!)
  const textsOf = (pick: (x: (typeof scored)[number]) => Array<string | null | undefined>) =>
    scored.flatMap(pick).filter((t): t is string => !!t && !!t.trim()).map((t) => t.trim())
  const development = {
    trainingRequests: topTerms(textsOf((x) => [(x.ev.self as Self).training, (x.ev.manager as Manager).training])),
    skillsToDevelop: topTerms(textsOf((x) => [(x.ev.self as Self).develop, (x.ev.self as Self).improve, (x.ev.manager as Manager).gaps])),
    challenges: topTerms(textsOf((x) => [(x.ev.self as Self).challenges])),
    responses: scored.slice(0, 200).map((x) => ({
      name: x.e.fullName, department: label(x.e.departmentId),
      training: (x.ev.self as Self).training ?? null, develop: (x.ev.self as Self).develop ?? null,
      challenges: (x.ev.self as Self).challenges ?? null, managerTraining: (x.ev.manager as Manager).training ?? null,
    })).filter((r) => r.training || r.develop || r.challenges || r.managerTraining),
  }
  const managersProgress = [...new Set(rows.map((r) => r.managerUserId))].map((uid) => {
    const mine = rows.filter((r) => r.managerUserId === uid)
    return {
      managerUserId: uid, name: managers.get(uid) ?? 'Manager', assigned: mine.length,
      submitted: mine.filter((r) => r.submittedAt).length,
      pendingReview: mine.filter((r) => AWAITING_MANAGER.includes(r.status)).length,
      finalized: mine.filter((r) => r.status === 'finalized').length,
    }
  }).sort((a, b) => a.name.localeCompare(b.name))

  // History: every cycle of these companies, finalized evaluations of the filtered employees.
  const allFinal = await prisma.performanceEvaluation.findMany({
    where: { tenantId: { in: tenantIds }, status: 'finalized', employeeId: { in: eligible.map((e) => e.id).concat(rows.map((r) => r.employeeId)) } },
    select: { cycleId: true, employeeId: true, finalScore: true },
  })
  const history = cycles.slice().reverse().map((c) => {
    const xs = allFinal.filter((x) => x.cycleId === c.id)
    const byDept = new Map<string, number[]>()
    for (const x of xs) {
      const d = empById.get(x.employeeId)?.departmentId ?? '__none'
      byDept.set(d, [...(byDept.get(d) ?? []), x.finalScore!])
    }
    return {
      cycleId: c.id, name: c.name, periodTo: c.periodTo, count: xs.length, averageFinal: avg(xs.map((x) => x.finalScore!)),
      departments: [...byDept.entries()].map(([d, s]) => ({ departmentId: d === '__none' ? null : d, name: d === '__none' ? 'No department' : label(d) ?? 'Department', averageFinal: avg(s) })),
    }
  })
  const employeeTrend = q.employeeId
    ? cycles.slice().reverse().map((c) => ({ cycleId: c.id, name: c.name, finalScore: allFinal.find((x) => x.cycleId === c.id && x.employeeId === q.employeeId)?.finalScore ?? null }))
    : null

  const list = [
    ...rows.map((ev) => {
      const e = empById.get(ev.employeeId)!
      return {
        evaluationId: ev.id, employeeId: e.id, code: e.employeeCode, name: e.fullName,
        departmentId: e.departmentId, designationId: e.designationId, locationId: e.locationId, managerUserId: ev.managerUserId,
        department: label(e.departmentId), designation: label(e.designationId), branch: label(e.locationId),
        manager: managers.get(ev.managerUserId) ?? null, status: ev.status, statusLabel: STATUS_LABEL[ev.status],
        selfScore: ev.selfScore, managerScore: ev.managerScore, finalScore: ev.finalScore,
        category: ev.category, categoryLabel: ev.category ? CATEGORY_LABEL[ev.category as Category] : null,
      }
    }),
    ...(!q.status || q.status === 'not_assigned') && !q.category && !q.managerUserId
      ? eligible.filter((e) => !evByEmp.has(e.id)).map((e) => ({
        evaluationId: null, employeeId: e.id, code: e.employeeCode, name: e.fullName,
        departmentId: e.departmentId, designationId: e.designationId, locationId: e.locationId, managerUserId: null,
        department: label(e.departmentId), designation: label(e.designationId), branch: label(e.locationId),
        manager: null, status: 'not_assigned', statusLabel: STATUS_LABEL['not_assigned'],
        selfScore: null, managerScore: null, finalScore: null, category: null, categoryLabel: null,
      }))
      : [],
  ].filter((r) => q.status !== 'not_assigned' || r.status === 'not_assigned')
  return {
    cycles: cycles.map((c) => ({ id: c.id, name: c.name, periodFrom: c.periodFrom, periodTo: c.periodTo, status: c.status, tenantId: c.tenantId })),
    cycle: cycle ? { id: cycle.id, name: cycle.name, periodFrom: cycle.periodFrom, periodTo: cycle.periodTo, selfWeightBp: cycle.selfWeightBp } : null,
    overview, distribution, departments, selfVsManager, areas: areaStats,
    strongest: ranked.slice(0, 3), weakest: ranked.slice(-3).reverse(),
    development, managers: managersProgress, history, employeeTrend, list,
  }
}

const pct = (v: number | null | undefined) => (v == null ? '' : `${(v / 100).toFixed(2)}%`)

// ─── Routes ─────────────────────────────────────────────────────────────────

export async function performanceRoutes(fastify: FastifyInstance) {
  const P = '/performance'
  const staff = { preHandler: requireAuth(...ALL_STAFF) }

  // Cycles the caller can assign / see (their own employee companies + member companies).
  fastify.get(`${P}/cycles`, staff, async (req) => {
    const own = await prisma.hrEmployee.findMany({ where: { userId: req.staffUser!.id }, select: { tenantId: true } })
    const tenants = [...new Set([...own.map((o) => o.tenantId), ...req.staffUser!.memberTenantIds])]
    const cycles = await prisma.performanceCycle.findMany({ where: { tenantId: { in: tenants } }, orderBy: [{ periodTo: 'desc' }] })
    return { cycles, standardAreas: STANDARD_AREAS, ratingLabels: RATING_LABEL, categoryLabels: CATEGORY_LABEL, statusLabels: STATUS_LABEL }
  })

  // Templates: built-in standard + company standards + the caller's own.
  fastify.get<{ Querystring: { tenantId?: string } }>(`${P}/templates`, staff, async (req) => {
    const own = await prisma.hrEmployee.findMany({ where: { userId: req.staffUser!.id }, select: { tenantId: true } })
    const tenants = [...new Set([...own.map((o) => o.tenantId), ...req.staffUser!.memberTenantIds])]
    const rows = await prisma.performanceTemplate.findMany({
      where: { tenantId: { in: tenants }, active: true, OR: [{ ownerUserId: null }, { ownerUserId: req.staffUser!.id }] },
      orderBy: { name: 'asc' },
    })
    return [{ id: 'standard', tenantId: null, name: 'Standard (self-evaluation form)', questions: STANDARD_QUESTIONS, ownerUserId: null, builtIn: true }, ...rows.map((r) => ({ ...r, builtIn: false }))]
  })
  const templateBody = z.object({ name: z.string().trim().min(2).max(80), questions: questionsSchema, companyStandard: z.boolean().default(false), tenantId: z.string().optional() })
  fastify.post(`${P}/templates`, staff, async (req, reply) => {
    const b = templateBody.parse(req.body)
    const own = await prisma.hrEmployee.findMany({ where: { userId: req.staffUser!.id }, select: { tenantId: true } })
    const tenantId = b.tenantId ?? req.staffUser!.tenantId ?? own[0]?.tenantId
    if (!tenantId || !(req.staffUser!.memberTenantIds.includes(tenantId) || own.some((o) => o.tenantId === tenantId))) throw new ForbiddenError('You do not belong to that company')
    if (b.companyStandard && !(await isHrFor(req, tenantId))) throw new ForbiddenError('Only HR saves a company-standard template')
    const t = await prisma.performanceTemplate.create({ data: { tenantId, name: b.name, questions: b.questions, ownerUserId: b.companyStandard ? null : req.staffUser!.id, createdById: req.staffUser!.id } })
    return reply.status(201).send(t)
  })
  fastify.patch<{ Params: { id: string } }>(`${P}/templates/:id`, staff, async (req) => {
    const b = templateBody.partial().extend({ active: z.boolean().optional() }).parse(req.body)
    const t = await prisma.performanceTemplate.findUnique({ where: { id: req.params.id } })
    if (!t) throw new NotFoundError('Template', req.params.id)
    const mine = t.ownerUserId === req.staffUser!.id
    if (!mine && !(t.ownerUserId === null && (await isHrFor(req, t.tenantId)))) throw new NotFoundError('Template', req.params.id)
    return prisma.performanceTemplate.update({ where: { id: t.id }, data: { ...(b.name && { name: b.name }), ...(b.questions && { questions: b.questions }), ...(b.active != null && { active: b.active }) } })
  })

  // ── HR: cycles ────────────────────────────────────────────────────────────
  const cycleBody = z.object({
    name: z.string().trim().min(2).max(80),
    periodFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), periodTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    areas: areasSchema.optional(),
    selfWeightBp: z.number().int().min(0).max(10000).default(3000),
  })
  fastify.get(`${P}/admin/cycles`, staff, async (req) => {
    await assertHr(req)
    const cycles = await prisma.performanceCycle.findMany({ where: { tenantId: { in: hrTenants(req) } }, orderBy: [{ periodTo: 'desc' }] })
    const counts = await prisma.performanceEvaluation.groupBy({ by: ['cycleId', 'status'], where: { cycleId: { in: cycles.map((c) => c.id) } }, _count: { _all: true } })
    return cycles.map((c) => ({ ...c, counts: Object.fromEntries(counts.filter((x) => x.cycleId === c.id).map((x) => [x.status, x._count._all])) }))
  })
  fastify.post(`${P}/admin/cycles`, staff, async (req, reply) => {
    await assertHr(req)
    const b = cycleBody.parse(req.body)
    const tenantId = req.staffUser!.tenantId
    if (!tenantId || !req.staffUser!.memberTenantIds.includes(tenantId)) throw new ForbiddenError('Pick your company first')
    if (b.periodTo < b.periodFrom) throw new AppError('BAD_PERIOD', 'The period ends before it starts', 422)
    const c = await prisma.performanceCycle.create({ data: {
      tenantId, name: b.name, periodFrom: new Date(`${b.periodFrom}T00:00:00Z`), periodTo: new Date(`${b.periodTo}T00:00:00Z`),
      dueDate: b.dueDate ? new Date(`${b.dueDate}T00:00:00Z`) : null, areas: (b.areas ?? STANDARD_AREAS) as unknown as Prisma.InputJsonValue,
      selfWeightBp: b.selfWeightBp, createdById: req.staffUser!.id,
    } })
    await audit({ category: 'identity', action: 'hr.performance.cycle_create', entity: 'PerformanceCycle', entityId: c.id, userId: req.staffUser!.id, tenantId, after: { name: c.name, areas: c.areas, selfWeightBp: c.selfWeightBp } })
    return reply.status(201).send(c)
  })
  fastify.patch<{ Params: { id: string } }>(`${P}/admin/cycles/:id`, staff, async (req) => {
    await assertHr(req)
    const b = cycleBody.partial().extend({ status: z.enum(['open', 'closed']).optional() }).parse(req.body)
    const c = await prisma.performanceCycle.findUnique({ where: { id: req.params.id } })
    if (!c || !(await isHrFor(req, c.tenantId))) throw new NotFoundError('Evaluation cycle', req.params.id)
    if ((b.areas || b.selfWeightBp != null) && (await prisma.performanceEvaluation.count({ where: { cycleId: c.id } }))) {
      throw new AppError('CYCLE_IN_USE', 'Evaluations are already assigned in this cycle — its areas and weights can no longer change', 409)
    }
    const next = await prisma.performanceCycle.update({ where: { id: c.id }, data: {
      ...(b.name && { name: b.name }),
      ...(b.periodFrom && { periodFrom: new Date(`${b.periodFrom}T00:00:00Z`) }),
      ...(b.periodTo && { periodTo: new Date(`${b.periodTo}T00:00:00Z`) }),
      ...(b.dueDate !== undefined && { dueDate: b.dueDate ? new Date(`${b.dueDate}T00:00:00Z`) : null }),
      ...(b.areas && { areas: b.areas as unknown as Prisma.InputJsonValue }),
      ...(b.selfWeightBp != null && { selfWeightBp: b.selfWeightBp }),
      ...(b.status && { status: b.status }),
    } })
    await audit({ category: 'identity', action: 'hr.performance.cycle_update', entity: 'PerformanceCycle', entityId: c.id, userId: req.staffUser!.id, tenantId: c.tenantId, before: { name: c.name, areas: c.areas, selfWeightBp: c.selfWeightBp, status: c.status }, after: { name: next.name, areas: next.areas, selfWeightBp: next.selfWeightBp, status: next.status } })
    return next
  })

  // ── Employee: my evaluations ─────────────────────────────────────────────
  fastify.get(`${P}/mine`, staff, async (req) => {
    const ids = await ownEmployeeIds(req)
    const evs = await prisma.performanceEvaluation.findMany({ where: { employeeId: { in: ids } }, include: { cycle: { select: { name: true, periodFrom: true, periodTo: true } } }, orderBy: { createdAt: 'desc' } })
    return evs.map((e) => ({
      id: e.id, cycle: e.cycle, status: e.status, statusLabel: STATUS_LABEL[e.status], dueDate: e.dueDate, returnNote: e.returnNote,
      finalScore: e.status === 'finalized' ? e.finalScore : null, categoryLabel: e.status === 'finalized' && e.category ? CATEGORY_LABEL[e.category as Category] : null,
      employeeAckAt: e.employeeAckAt,
    }))
  })

  // ── Manager: my direct reports and their evaluations ─────────────────────
  fastify.get<{ Querystring: { cycleId?: string } }>(`${P}/team`, staff, async (req) => {
    const me = await prisma.hrEmployee.findMany({ where: { userId: req.staffUser!.id }, select: { id: true, tenantId: true } })
    const su = req.staffUser!
    const ceoTenants = su.role === 'admin' ? su.memberTenantIds : []
    const reports = await prisma.hrEmployee.findMany({
      where: {
        status: { in: ['active', 'on_leave'] },
        OR: [
          ...(me.length ? [{ managerId: { in: me.map((m) => m.id) } }] : []),
          ...(ceoTenants.length ? [{ tenantId: { in: ceoTenants }, managerId: null, data: { path: ['reportsToCeo'], equals: true } }] : []),
        ],
      },
      orderBy: { fullName: 'asc' },
    })
    const label = await employeeLabelsAcross(reports)
    const evs = await prisma.performanceEvaluation.findMany({
      where: { OR: [{ managerUserId: su.id }, { employeeId: { in: reports.map((r) => r.id) } }], ...(req.query.cycleId && { cycleId: req.query.cycleId }) },
      include: { cycle: { select: { name: true } }, employee: { select: { fullName: true, employeeCode: true } } },
      orderBy: { updatedAt: 'desc' },
    })
    return {
      reports: reports.map((r) => ({ id: r.id, tenantId: r.tenantId, code: r.employeeCode, name: r.fullName, department: label(r.departmentId), designation: label(r.designationId) })),
      evaluations: evs.filter((e) => e.managerUserId === su.id).map((e) => ({
        id: e.id, cycleId: e.cycleId, cycle: e.cycle.name, employeeId: e.employeeId, employee: e.employee.fullName, code: e.employee.employeeCode,
        status: e.status, statusLabel: STATUS_LABEL[e.status], dueDate: e.dueDate, finalScore: e.finalScore,
        categoryLabel: e.category ? CATEGORY_LABEL[e.category as Category] : null, submittedAt: e.submittedAt, updatedAt: e.updatedAt,
      })),
    }
  })

  // ── Assign (the reporting manager, or HR on their behalf) ────────────────
  const assignBody = z.object({
    cycleId: z.string().uuid(),
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    assignments: z.array(z.object({ employeeId: z.string().uuid(), questions: questionsSchema.optional(), templateId: z.string().optional() })).min(1).max(200),
  })
  fastify.post(`${P}/evaluations`, staff, async (req, reply) => {
    const b = assignBody.parse(req.body)
    const cycle = await prisma.performanceCycle.findUnique({ where: { id: b.cycleId } })
    if (!cycle) throw new NotFoundError('Evaluation cycle', b.cycleId)
    const asHr = await isHrFor(req, cycle.tenantId)
    // Another company's cycle is 404: the caller must belong to its company (member or employed there).
    if (!asHr && !req.staffUser!.memberTenantIds.includes(cycle.tenantId)
      && !(await prisma.hrEmployee.count({ where: { userId: req.staffUser!.id, tenantId: cycle.tenantId } }))) {
      throw new NotFoundError('Evaluation cycle', b.cycleId)
    }
    const created: string[] = []
    const refused: Array<{ employeeId: string; code: string; message: string }> = []
    for (const a of b.assignments) {
      try {
        const emp = await prisma.hrEmployee.findUnique({ where: { id: a.employeeId } })
        if (!emp || (emp.tenantId !== cycle.tenantId && !asHr)) throw new NotFoundError('Employee', a.employeeId)
        if (emp.tenantId !== cycle.tenantId) throw new AppError('CYCLE_NOT_IN_COMPANY', 'That cycle belongs to another company', 422)
        if (cycle.status !== 'open') throw new AppError('CYCLE_CLOSED', 'That cycle is closed', 409)
        const mgr = await reportingManagerOf(emp)
        if (!asHr && mgr?.userId !== req.staffUser!.id) throw new AppError('NOT_YOUR_REPORT', `${emp.fullName} does not report to you`, 403)
        if (!mgr) throw new AppError('NO_REPORTING_MANAGER', `${emp.fullName} has no reporting manager with a servd login — set the reporting line in HR first`, 422)
        let raw = a.questions
        if (!raw && a.templateId && a.templateId !== 'standard') {
          const t = await prisma.performanceTemplate.findFirst({ where: { id: a.templateId, tenantId: emp.tenantId, active: true, OR: [{ ownerUserId: null }, { ownerUserId: req.staffUser!.id }] } })
          if (!t) throw new NotFoundError('Template', a.templateId)
          raw = t.questions as Record<string, string[]>
        }
        const areas = cycle.areas as unknown as Area[]
        const ev = await prisma.performanceEvaluation.create({ data: {
          tenantId: emp.tenantId, cycleId: cycle.id, employeeId: emp.id, managerUserId: mgr.userId, managerEmployeeId: mgr.employeeId,
          assignedById: req.staffUser!.id, dueDate: b.dueDate ? new Date(`${b.dueDate}T00:00:00Z`) : cycle.dueDate,
          areas: areas as unknown as Prisma.InputJsonValue, questions: normaliseQuestions(areas, raw) as unknown as Prisma.InputJsonValue,
          selfWeightBp: cycle.selfWeightBp,
        } }).catch((e: { code?: string }) => {
          if (e.code === 'P2002') throw new AppError('ALREADY_ASSIGNED', `${emp.fullName} already has an evaluation in ${cycle.name}`, 409)
          throw e
        })
        created.push(ev.id)
        await audit({ category: 'identity', action: 'hr.performance.assign', entity: 'PerformanceEvaluation', entityId: ev.id, userId: req.staffUser!.id, tenantId: ev.tenantId, after: { employeeId: emp.id, cycleId: cycle.id, managerUserId: mgr.userId } })
        notify([{
          userId: (await employeeLogin(emp.id)) ?? '', tenantId: emp.tenantId, title: `Self-evaluation assigned: ${cycle.name}`,
          body: 'Your reporting manager has assigned your performance self-evaluation. Open My HR → My Performance Evaluation.',
          link: `/hr/me/performance/${ev.id}`, entityType: 'performance_evaluation', entityId: ev.id, actorId: req.staffUser!.id, dedupeKey: `perf.assign:${ev.id}`,
        }])
      } catch (err) {
        if (b.assignments.length === 1) throw err
        refused.push({ employeeId: a.employeeId, code: (err as AppError).code ?? 'ERROR', message: (err as Error).message })
      }
    }
    return reply.status(201).send({ created, refused })
  })

  fastify.get<{ Params: { id: string } }>(`${P}/evaluations/:id`, staff, async (req) => {
    const { ev, roles } = await loadFor(req, req.params.id)
    return viewOf(ev, roles)
  })

  // Questions (manager / HR) — only before the employee submits.
  fastify.put<{ Params: { id: string } }>(`${P}/evaluations/:id/questions`, staff, async (req) => {
    const b = z.object({ questions: questionsSchema, dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional() }).parse(req.body)
    const { ev, roles } = await loadFor(req, req.params.id)
    if (!roles.has('manager') && !roles.has('hr')) throw new ForbiddenError('Only the reporting manager or HR sets the questions')
    const areas = ev.areas as unknown as Area[]
    const res = await prisma.performanceEvaluation.updateMany({
      where: { id: ev.id, status: { in: ['pending_employee', 'draft'] } },
      data: { questions: normaliseQuestions(areas, b.questions, ev.questions as unknown as Questions) as unknown as Prisma.InputJsonValue, ...(b.dueDate !== undefined && { dueDate: b.dueDate ? new Date(`${b.dueDate}T00:00:00Z`) : null }) },
    })
    if (!res.count) throw new AppError('ALREADY_SUBMITTED', 'The employee has submitted — the questions can no longer change', 409)
    const next = await prisma.performanceEvaluation.findUniqueOrThrow({ where: { id: ev.id } })
    return viewOf(next, roles)
  })

  // Employee: save draft / submit.
  async function saveSelf(req: FastifyRequest, id: string, submit: boolean) {
    const self = selfSchema.parse((req.body as { self?: unknown } | undefined)?.self ?? {})
    const { ev, roles } = await loadFor(req, id)
    if (!roles.has('employee')) throw new ForbiddenError('Only the employee fills in their self-evaluation')
    if (!EMPLOYEE_EDITABLE.includes(ev.status)) throw new AppError('NOT_EDITABLE', 'This evaluation has been submitted — your manager can return it for revision', 409)
    if (submit) assertSelfComplete(ev, self)
    const now = new Date()
    const status = submit ? (ev.returnCount > 0 ? 'resubmitted' : 'submitted') : ev.status === 'returned' ? 'returned' : 'draft'
    const selfScore = submit ? weightedScore(ev.areas as unknown as Area[], (k) => selfAreaRating(k, ev.questions as unknown as Questions, self)) : null
    const res = await prisma.performanceEvaluation.updateMany({
      where: { id: ev.id, status: ev.status, updatedAt: ev.updatedAt },
      data: {
        self: self as unknown as Prisma.InputJsonValue, status,
        ...(submit && {
          submittedAt: now, selfScore,
          history: [...(ev.history as unknown[]), { at: now.toISOString(), kind: status, by: req.staffUser!.id, self }] as unknown as Prisma.InputJsonValue,
        }),
      },
    })
    if (!res.count) throw new AppError('EVALUATION_CHANGED', 'This evaluation changed while you were editing — reload it', 409)
    const next = await prisma.performanceEvaluation.findUniqueOrThrow({ where: { id: ev.id } })
    if (submit) {
      await audit({ category: 'identity', action: `hr.performance.${status}`, entity: 'PerformanceEvaluation', entityId: ev.id, userId: req.staffUser!.id, tenantId: ev.tenantId, after: { selfScore } })
      notify([{ userId: ev.managerUserId, tenantId: ev.tenantId, title: `Self-evaluation ${status === 'resubmitted' ? 'resubmitted' : 'submitted'} for your review`, body: `${(await profileOf(ev)).fullName} has ${status} their self-evaluation.`, link: `/hr/me/team-evaluations/${ev.id}`, entityType: 'performance_evaluation', entityId: ev.id, actorId: req.staffUser!.id, dedupeKey: `perf.${status}:${ev.id}:${ev.returnCount}` }])
    }
    return viewOf(next, roles)
  }
  fastify.put<{ Params: { id: string } }>(`${P}/evaluations/:id/self`, staff, async (req) => saveSelf(req, req.params.id, false))
  fastify.post<{ Params: { id: string } }>(`${P}/evaluations/:id/submit`, staff, async (req) => saveSelf(req, req.params.id, true))

  // Manager: save assessment draft / return / approve & finalize.
  async function managerStep(req: FastifyRequest, id: string, action: 'save' | 'approve') {
    const m = managerSchema.parse((req.body as { manager?: unknown } | undefined)?.manager ?? {})
    const { ev, roles } = await loadFor(req, id)
    if (!roles.has('manager')) throw new AppError('NOT_YOUR_REPORT', 'Only the reporting manager assesses this evaluation', 403)
    if (!AWAITING_MANAGER.includes(ev.status)) throw new AppError('NOT_AWAITING_MANAGER', 'This evaluation is not waiting for your assessment', 409)
    const now = new Date()
    let data: Prisma.PerformanceEvaluationUpdateManyMutationInput = { manager: m as unknown as Prisma.InputJsonValue, status: 'manager_in_progress', managerStartedAt: ev.managerStartedAt ?? now }
    if (action === 'approve') {
      assertManagerComplete(ev, m)
      const areas = ev.areas as unknown as Area[]
      const selfScore = weightedScore(areas, (k) => selfAreaRating(k, ev.questions as unknown as Questions, ev.self as unknown as Self))!
      const managerScore = weightedScore(areas, (k) => m.areas[k]?.rating ?? null)!
      const finalScore = finalScoreOf(selfScore, managerScore, ev.selfWeightBp)
      data = { ...data, status: 'finalized', selfScore, managerScore, finalScore, category: categoryOf(finalScore), finalizedAt: now, returnNote: null }
    }
    const res = await prisma.performanceEvaluation.updateMany({ where: { id: ev.id, status: ev.status, updatedAt: ev.updatedAt }, data })
    if (!res.count) throw new AppError('EVALUATION_CHANGED', 'This evaluation changed while you were editing — reload it', 409)
    const next = await prisma.performanceEvaluation.findUniqueOrThrow({ where: { id: ev.id } })
    if (action === 'approve') {
      await audit({ category: 'identity', action: 'hr.performance.finalize', entity: 'PerformanceEvaluation', entityId: ev.id, userId: req.staffUser!.id, tenantId: ev.tenantId, after: { selfScore: next.selfScore, managerScore: next.managerScore, finalScore: next.finalScore, category: next.category } })
      notify([{ userId: (await employeeLogin(ev.employeeId)) ?? '', tenantId: ev.tenantId, severity: 'success', title: 'Your performance evaluation is final', body: `Final score ${pct(next.finalScore)} — ${CATEGORY_LABEL[next.category as Category]}. Open it to read your manager's assessment and acknowledge it.`, link: `/hr/me/performance/${ev.id}`, entityType: 'performance_evaluation', entityId: ev.id, actorId: req.staffUser!.id, dedupeKey: `perf.final:${ev.id}:${now.getTime()}` }])
    }
    return viewOf(next, roles)
  }
  fastify.put<{ Params: { id: string } }>(`${P}/evaluations/:id/manager`, staff, async (req) => managerStep(req, req.params.id, 'save'))
  fastify.post<{ Params: { id: string } }>(`${P}/evaluations/:id/approve`, staff, async (req) => managerStep(req, req.params.id, 'approve'))

  fastify.post<{ Params: { id: string } }>(`${P}/evaluations/:id/return`, staff, async (req) => {
    const b = z.object({ note: z.string().trim().min(10, 'Tell the employee what to revise (at least 10 characters)').max(2000), manager: z.unknown().optional() }).parse(req.body)
    const { ev, roles } = await loadFor(req, req.params.id)
    if (!roles.has('manager')) throw new AppError('NOT_YOUR_REPORT', 'Only the reporting manager returns this evaluation', 403)
    if (!AWAITING_MANAGER.includes(ev.status)) throw new AppError('NOT_AWAITING_MANAGER', 'This evaluation is not waiting for your assessment', 409)
    const m = b.manager !== undefined ? managerSchema.parse(b.manager) : (ev.manager as unknown as Manager)
    const now = new Date()
    const res = await prisma.performanceEvaluation.updateMany({
      where: { id: ev.id, status: ev.status, updatedAt: ev.updatedAt },
      data: {
        status: 'returned', returnNote: b.note, returnCount: { increment: 1 }, manager: m as unknown as Prisma.InputJsonValue,
        history: [...(ev.history as unknown[]), { at: now.toISOString(), kind: 'returned', by: req.staffUser!.id, note: b.note }] as unknown as Prisma.InputJsonValue,
      },
    })
    if (!res.count) throw new AppError('EVALUATION_CHANGED', 'This evaluation changed — reload it', 409)
    await audit({ category: 'identity', action: 'hr.performance.return', entity: 'PerformanceEvaluation', entityId: ev.id, userId: req.staffUser!.id, tenantId: ev.tenantId, after: { note: b.note } })
    notify([{ userId: (await employeeLogin(ev.employeeId)) ?? '', tenantId: ev.tenantId, severity: 'warning', title: 'Your self-evaluation was returned for revision', body: b.note, link: `/hr/me/performance/${ev.id}`, entityType: 'performance_evaluation', entityId: ev.id, actorId: req.staffUser!.id, dedupeKey: `perf.return:${ev.id}:${ev.returnCount + 1}` }])
    return viewOf(await prisma.performanceEvaluation.findUniqueOrThrow({ where: { id: ev.id } }), roles)
  })

  fastify.post<{ Params: { id: string } }>(`${P}/evaluations/:id/acknowledge`, staff, async (req) => {
    const { ev, roles } = await loadFor(req, req.params.id)
    if (!roles.has('employee')) throw new ForbiddenError('Only the employee acknowledges their evaluation')
    const res = await prisma.performanceEvaluation.updateMany({ where: { id: ev.id, status: 'finalized', employeeAckAt: null }, data: { employeeAckAt: new Date() } })
    if (!res.count) throw new AppError('NOT_FINALIZED', 'Only a finalized evaluation is acknowledged, once', 409)
    return viewOf(await prisma.performanceEvaluation.findUniqueOrThrow({ where: { id: ev.id } }), roles)
  })

  fastify.delete<{ Params: { id: string } }>(`${P}/evaluations/:id`, staff, async (req, reply) => {
    const { ev, roles } = await loadFor(req, req.params.id)
    if (!roles.has('manager') && !roles.has('hr')) throw new ForbiddenError('Only the reporting manager or HR cancels an evaluation')
    const res = await prisma.performanceEvaluation.deleteMany({ where: { id: ev.id, status: { in: ['pending_employee', 'draft'] } } })
    if (!res.count) throw new AppError('ALREADY_SUBMITTED', 'A submitted evaluation cannot be cancelled', 409)
    await audit({ category: 'identity', action: 'hr.performance.cancel', entity: 'PerformanceEvaluation', entityId: ev.id, userId: req.staffUser!.id, tenantId: ev.tenantId, before: { employeeId: ev.employeeId, cycleId: ev.cycleId, status: ev.status } })
    return reply.status(204).send()
  })

  // HR: reopen a finalized evaluation (back to the manager's assessment, scores cleared).
  fastify.post<{ Params: { id: string } }>(`${P}/admin/evaluations/:id/reopen`, staff, async (req) => {
    await assertHr(req)
    const b = z.object({ reason: z.string().trim().min(10, 'Give the reason (at least 10 characters)').max(2000) }).parse(req.body)
    const { ev, roles } = await loadFor(req, req.params.id)
    if (!roles.has('hr')) throw new NotFoundError('Evaluation', ev.id)
    const now = new Date()
    const res = await prisma.performanceEvaluation.updateMany({
      where: { id: ev.id, status: 'finalized' },
      data: {
        status: 'manager_in_progress', finalScore: null, managerScore: null, category: null, finalizedAt: null, employeeAckAt: null, reopenedAt: now,
        history: [...(ev.history as unknown[]), { at: now.toISOString(), kind: 'reopened', by: req.staffUser!.id, note: b.reason, before: { selfScore: ev.selfScore, managerScore: ev.managerScore, finalScore: ev.finalScore, category: ev.category, manager: ev.manager } }] as unknown as Prisma.InputJsonValue,
      },
    })
    if (!res.count) throw new AppError('NOT_FINALIZED', 'Only a finalized evaluation is reopened', 409)
    await audit({ category: 'identity', action: 'hr.performance.reopen', entity: 'PerformanceEvaluation', entityId: ev.id, userId: req.staffUser!.id, tenantId: ev.tenantId, before: { finalScore: ev.finalScore, category: ev.category }, after: { reason: b.reason } })
    notify([{ userId: ev.managerUserId, tenantId: ev.tenantId, severity: 'warning', title: 'HR reopened an evaluation for your assessment', body: b.reason, link: `/hr/me/team-evaluations/${ev.id}`, entityType: 'performance_evaluation', entityId: ev.id, actorId: req.staffUser!.id, dedupeKey: `perf.reopen:${ev.id}:${now.getTime()}` }])
    return viewOf(await prisma.performanceEvaluation.findUniqueOrThrow({ where: { id: ev.id } }), roles)
  })

  // HR: Results dashboard (JSON, or ?format=pdf|xlsx|csv for the list).
  fastify.get(`${P}/admin/results`, staff, async (req, reply) => {
    await assertHr(req)
    const q = resultsQuery.parse(req.query)
    const r = await buildResults(hrTenants(req), q)
    const format = exportFormatOf(q.format)
    if (!format) return r
    return sendReportFor(req, reply, format, { base: 'evaluation-results', suffix: r.cycle?.name.replace(/[^\w-]+/g, '-') ?? 'none' }, {
      title: 'Performance evaluation results', period: r.cycle ? `${r.cycle.name}` : undefined,
      rows: [
        ...r.list.map((x) => ({ section: 'Employees', code: x.code, name: x.name, department: x.department ?? '', designation: x.designation ?? '', manager: x.manager ?? '', status: x.statusLabel, self: pct(x.selfScore), manager_score: pct(x.managerScore), final: pct(x.finalScore), category: x.categoryLabel ?? '' })),
        ...r.distribution.map((d) => ({ section: 'Performance categories', code: '', name: d.label, department: `${d.count}`, designation: `${d.pct}%`, manager: '', status: '', self: '', manager_score: '', final: '', category: '' })),
        ...r.departments.map((d) => ({ section: 'Departments', code: '', name: d.name, department: `${d.count}`, designation: '', manager: '', status: '', self: pct(d.averageSelf), manager_score: pct(d.averageManager), final: pct(d.averageFinal), category: '' })),
        ...r.areas.map((a) => ({ section: 'Performance areas (average rating out of 5)', code: '', name: a.label, department: `${a.weightBp / 100}%`, designation: '', manager: '', status: '', self: a.averageSelf == null ? '' : String(a.averageSelf), manager_score: a.averageManager == null ? '' : String(a.averageManager), final: '', category: '' })),
      ] as ReportRow[],
      sectionKey: 'section',
      labels: { code: 'ID', name: 'Name', department: 'Department / count', designation: 'Designation / %', manager: 'Manager', status: 'Status', self: 'Self', manager_score: 'Manager', final: 'Final', category: 'Category' },
      wrapKeys: ['name'],
    })
  })

  // Individual report (employee once finalized, the manager, HR): ?format=pdf|xlsx|csv.
  fastify.get<{ Params: { id: string }; Querystring: { format?: string } }>(`${P}/evaluations/:id/report`, staff, async (req, reply) => {
    const { ev, roles } = await loadFor(req, req.params.id)
    const v = await viewOf(ev, roles)
    const format = exportFormatOf(req.query.format, 'pdf')!
    const self = ev.self as unknown as Self
    const m = (v.manager ?? {}) as Manager
    const p = v.profile
    const row = (section: string, item: string, employee: string, manager = '') => ({ section, item, employee, manager })
    const rows: ReportRow[] = [
      row('1. Employee profile', 'Employee', `${p.fullName} (${p.employeeCode})`),
      row('1. Employee profile', 'Department / designation', `${p.department ?? '—'} / ${p.designation ?? '—'}`),
      row('1. Employee profile', 'Date of joining', p.joiningDate ? p.joiningDate.toISOString().slice(0, 10) : '—'),
      row('1. Employee profile', 'Review period', v.cycle ? `${v.cycle.name} (${v.cycle.periodFrom.toISOString().slice(0, 10)} to ${v.cycle.periodTo.toISOString().slice(0, 10)})` : '—'),
      row('1. Employee profile', 'Employment status', `${p.employmentType} · ${p.status}`),
      row('1. Employee profile', 'Reporting manager', p.reportingManager ?? '—'),
      row('1. Employee profile', 'Status', v.statusLabel),
      ...v.scores.areas.map((a) => row('2. Ratings by performance area', `${a.label} (${a.weightBp / 100}%)`,
        `${a.selfRating ?? '—'} / 5${self.areas?.[a.key]?.comment ? ` — ${self.areas[a.key]!.comment}` : ''}${self.areas?.[a.key]?.evidence ? ` · Evidence: ${self.areas[a.key]!.evidence}` : ''}`,
        a.managerRating == null ? '' : `${a.managerRating} / 5${m.areas?.[a.key]?.agree ? ` (${m.areas[a.key]!.agree}s)` : ''}${m.areas?.[a.key]?.comment ? ` — ${m.areas[a.key]!.comment}` : ''}`)),
      row('3. Scores', 'Weighted score', pct(v.scores.selfScore), pct(v.scores.managerScore)),
      row('3. Scores', `Final score (self ${ev.selfWeightBp / 100}% · manager ${(10000 - ev.selfWeightBp) / 100}%)`, pct(v.scores.finalScore)),
      row('3. Scores', 'Performance category', v.scores.categoryLabel ?? '—'),
      row('3. Scores', 'Overall self-rating', self.overallRating ? `${self.overallRating} — ${RATING_LABEL[self.overallRating]}${self.overallWhy ? `: ${self.overallWhy}` : ''}` : '—', m.overall ?? ''),
      ...(self.achievements ?? []).map((a, i) => row('4. Key achievements', `${i + 1}. ${a.achievement ?? ''}`, [a.impact, a.evidence].filter(Boolean).join(' · '))),
      row('5. Strengths & development', 'Key strengths', self.strengths ?? ''),
      row('5. Strengths & development', 'Areas to improve', self.improve ?? '', m.gaps ?? ''),
      row('6. Development, goals & support', 'Skill to develop', self.develop ?? ''),
      row('6. Development, goals & support', 'Training / tools needed', self.training ?? '', m.training ?? ''),
      row('6. Development, goals & support', 'Goals for the next 3 months', self.goals ?? ''),
      row('6. Development, goals & support', 'Support needed', self.support ?? ''),
      row('6. Development, goals & support', 'Challenges / blockers', self.challenges ?? ''),
      row('6. Development, goals & support', 'Anything else', self.other ?? ''),
      row('7. Acknowledgement & sign-off', 'Employee submitted', ev.submittedAt?.toISOString().slice(0, 16).replace('T', ' ') ?? '—'),
      row('7. Acknowledgement & sign-off', 'Manager reviewed / approved', ev.finalizedAt?.toISOString().slice(0, 16).replace('T', ' ') ?? '—'),
      row('7. Acknowledgement & sign-off', 'Employee acknowledged', ev.employeeAckAt?.toISOString().slice(0, 16).replace('T', ' ') ?? '—'),
    ]
    return sendReportFor(req, reply, format, { base: 'performance-evaluation', suffix: p.employeeCode }, {
      title: `Performance evaluation — ${p.fullName}`, period: v.cycle?.name, rows, sectionKey: 'section',
      labels: { item: 'Item', employee: 'Employee', manager: 'Manager' }, wrapKeys: ['item', 'employee', 'manager'],
    })
  })
}
