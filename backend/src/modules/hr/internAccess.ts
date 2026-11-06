// Intern Management — who may do what, and the shared readers (owner, 2026-11-06). The contract is the header of
// ./interns.ts; this file holds the pieces both interns.ts and internPayroll.ts use.
//
//   HR        HR_ADMIN (admin, owner, management, hr) holding staff_hr — the CEO always. Enrols, edits, attendance,
//             stipend payroll preparation, certificates, reports.
//   finance   role finance holding accounting (the CEO always): reads the stipend payroll, passes / returns it, pays it.
//   supervisor the login linked to the intern's supervisorEmployeeId: views their interns, marks attendance, remarks.
//
// Company scope: lists read the companies in view (the active company, or every member company in the portfolio
// view); a single record is any company the caller belongs to (another company's → 404); a new intern / run binds to
// the ACTIVE company.
import type { FastifyRequest } from 'fastify'
import type { Intern, Prisma, UserRole } from '@prisma/client'
import { serviceClient as prisma } from '../../lib/prisma.js'
import { AppError, ForbiddenError, NotFoundError } from '../../lib/errors.js'
import { effectiveModulesForUser } from '../../lib/moduleAccess.js'
import { activeTenantId } from '../../lib/tenantScope.js'

export type Db = Prisma.TransactionClient | typeof prisma

export const INTERN_HR_ROLES = ['admin', 'owner', 'management', 'hr'] as UserRole[]

export const INTERN_STATUSES = ['draft', 'pending_approval', 'active', 'completed', 'terminated'] as const
export type InternStatus = (typeof INTERN_STATUSES)[number]
export const INTERN_STATUS_LABEL: Record<InternStatus, string> = {
  draft: 'Draft', pending_approval: 'Pending Approval', active: 'Active', completed: 'Completed', terminated: 'Terminated',
}
export const ATTENDANCE_STATUSES = ['present', 'absent', 'late', 'half_day', 'leave', 'weekly_off'] as const
export type InternAttendanceStatus = (typeof ATTENDANCE_STATUSES)[number]
export const ATTENDANCE_LABEL: Record<InternAttendanceStatus, string> = {
  present: 'Present', absent: 'Absent', late: 'Late', half_day: 'Half day', leave: 'Leave', weekly_off: 'Weekly off',
}
/** Statuses whose interns can have attendance and stipend (they were enrolled and approved). */
export const ENROLLED: InternStatus[] = ['active', 'completed', 'terminated']

const modulesCache = new WeakMap<FastifyRequest, Promise<Set<string>>>()
/** The caller's effective modules (once per request). */
export function modulesOf(req: FastifyRequest): Promise<Set<string>> {
  let p = modulesCache.get(req)
  if (!p) {
    const su = req.staffUser!
    p = (async () => {
      const u = await prisma.user.findUnique({ where: { id: su.id }, select: { moduleAllow: true, moduleDeny: true } })
      return effectiveModulesForUser({ role: su.role as UserRole, moduleAllow: u?.moduleAllow ?? [], moduleDeny: u?.moduleDeny ?? [] })
    })()
    modulesCache.set(req, p)
  }
  return p
}

/** HR back office: HR_ADMIN holding staff_hr; the CEO always. */
export async function isInternHr(req: FastifyRequest): Promise<boolean> {
  const su = req.staffUser
  if (!su) return false
  if (su.role === 'admin') return true
  if (!INTERN_HR_ROLES.includes(su.role as UserRole)) return false
  return (await modulesOf(req)).has('staff_hr')
}
export async function assertInternHr(req: FastifyRequest): Promise<void> {
  if (!(await isInternHr(req))) throw new AppError('INTERN_HR_ONLY', 'Only HR (with the HR module) or the CEO manages interns', 403)
}

/** Finance's review / payment: role finance holding accounting; the CEO always. */
export async function isInternFinance(req: FastifyRequest): Promise<boolean> {
  const su = req.staffUser
  if (!su) return false
  if (su.role === 'admin') return true
  return su.role === 'finance' && (await modulesOf(req)).has('accounting')
}

/** Who reads the stipend payroll: HR or finance (as above). */
export async function assertPayrollReader(req: FastifyRequest): Promise<void> {
  if (!(await isInternHr(req)) && !(await isInternFinance(req))) {
    throw new ForbiddenError('Only HR and finance read the intern stipend payroll')
  }
}

/** Companies a list reads: the portfolio set, else the active company. */
export function viewTenants(req: FastifyRequest): string[] {
  const su = req.staffUser!
  if (req.headers['x-servd-portfolio'] === '1' && su.memberTenantIds.length) {
    const f = su.tenantFilter
    if (f && typeof f === 'object' && 'in' in f) return f.in.filter((id) => su.memberTenantIds.includes(id))
    return su.memberTenantIds
  }
  return su.tenantId ? [su.tenantId] : []
}
/** Companies a single record may be in: every company the caller belongs to. */
export const memberTenants = (req: FastifyRequest): string[] => req.staffUser!.memberTenantIds ?? []
/** The company a new intern / run binds to. */
export const createTenant = (req: FastifyRequest): string => activeTenantId(req, 'An intern belongs to one company — pick the company first')

/** An intern of a company the caller belongs to, or 404. */
export async function internInScope(req: FastifyRequest, id: string, db: Db = prisma): Promise<Intern> {
  const i = await db.intern.findFirst({ where: { id, tenantId: { in: memberTenants(req) } } })
  if (!i) throw new NotFoundError('Intern', id)
  return i
}

/** The HR employee records linked to the caller's login (any company). */
export async function ownEmployeeIds(req: FastifyRequest): Promise<string[]> {
  return (await prisma.hrEmployee.findMany({ where: { userId: req.staffUser!.id }, select: { id: true } })).map((e) => e.id)
}

/** An intern the caller supervises (their own employee record is its supervisor), or 404. */
export async function supervisedIntern(req: FastifyRequest, id: string): Promise<Intern> {
  const mine = await ownEmployeeIds(req)
  const i = mine.length ? await prisma.intern.findFirst({ where: { id, supervisorEmployeeId: { in: mine } } }) : null
  if (!i) throw new NotFoundError('Intern', id)
  return i
}

/** Append one history row (never edited). */
export async function logInternEvent(db: Db, intern: Pick<Intern, 'id' | 'tenantId'>, kind: string, e: {
  actorId?: string | null; note?: string | null; before?: unknown; after?: unknown; effectiveDate?: Date | null
} = {}): Promise<void> {
  await db.internEvent.create({
    data: {
      tenantId: intern.tenantId, internId: intern.id, kind, note: e.note ?? null,
      before: (e.before ?? undefined) as Prisma.InputJsonValue | undefined,
      after: (e.after ?? undefined) as Prisma.InputJsonValue | undefined,
      effectiveDate: e.effectiveDate ?? null, actorId: e.actorId ?? null,
    },
  })
}

// ─── Dates ──────────────────────────────────────────────────────────────────

export const YMD = /^\d{4}-\d{2}-\d{2}$/
export function parseYmd(v: string, label = 'date'): Date {
  if (!YMD.test(v)) throw new AppError('BAD_DATE', `The ${label} must be a date (YYYY-MM-DD)`, 422)
  const d = new Date(`${v}T00:00:00.000Z`)
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw new AppError('BAD_DATE', `The ${label} is not a real date`, 422)
  return d
}
export const ymdOf = (d: Date | null | undefined): string | null => (d ? d.toISOString().slice(0, 10) : null)
export const DAY_MS = 86_400_000

/** The intern's last day in the internship: completion day, termination day, else the planned end (null = open). */
export function lastDayOf(i: Pick<Intern, 'status' | 'endDate' | 'completedOn' | 'terminationEffectiveDate'>): Date | null {
  if (i.status === 'completed' && i.completedOn) return i.completedOn
  if (i.status === 'terminated' && i.terminationEffectiveDate) return i.terminationEffectiveDate
  return i.endDate ?? null
}

/** Is the day inside the internship window (start … last day)? */
export function withinInternship(i: Pick<Intern, 'startDate' | 'status' | 'endDate' | 'completedOn' | 'terminationEffectiveDate'>, day: Date): boolean {
  if (day < i.startDate) return false
  const last = lastDayOf(i)
  return !last || day <= last
}

/** The intern's working weekdays (0 = Sunday … 6 = Saturday). */
export function workingDaysOf(i: Pick<Intern, 'workingDays'>): number[] {
  const v = i.workingDays
  return Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number' && x >= 0 && x <= 6) : [1, 2, 3, 4, 5, 6]
}

export const WEEKDAY_LABEL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
