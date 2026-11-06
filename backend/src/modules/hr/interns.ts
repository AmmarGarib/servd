// Intern Management (owner, 2026-11-06) — HR → Interns. Interns are a SEPARATE category from employees: their own
// register (Intern, codes INT-0001 per company), history, attendance, stipend payroll, certificates and reports. An
// intern is never an HrEmployee, never on employee lists, /hr/team, headcount, employee payroll, labour % or the
// head-office pool, and is never turned into an employee automatically. The old 'intern' employment type is RETIRED
// (forms.ts EMPLOYMENT_TYPES; an employee create / edit naming it → 422 INTERN_NOT_AN_EMPLOYEE); existing intern
// employees were moved here by the boot step internsMigration.ts migrateLegacyInterns.
//
// WHO (internAccess.ts): HR = HR_ADMIN (admin, owner, management, hr) holding staff_hr, the CEO always — 403
// INTERN_HR_ONLY otherwise. Finance = role finance holding accounting (the CEO always). Supervisor = the login of the
// intern's supervisorEmployeeId. Company scope: lists read the companies in view (active company / portfolio);
// a record is any company the caller belongs to — another company's intern, run, slip or certificate is 404; a new
// intern / run binds to the ACTIVE company. Module gate (lib/moduleAccess.ts): /hr/interns/payroll → staff_hr |
// accounting; the rest of /hr/interns → staff_hr; /hr/my-interns is self-service (checked here).
//
// ── Register ───────────────────────────────────────────────────────────────
// Statuses: draft → pending_approval → active → completed | terminated (draft / pending may be terminated too).
// "Not Issued" etc. for certificates is computed (certificateStatus).
//   GET    /hr/interns/lookups                      { departments:[{id,name}], supervisors:[{id,fullName,employeeCode,designation}],
//                                                     statuses, statusLabels, attendanceStatuses, attendanceLabels, weekdays }
//   GET    /hr/interns?status=&departmentId=&supervisorEmployeeId=&internshipType=&joinedFrom=&joinedTo=&q=
//                                                   { items: InternRow[] }   (q: name, code, CNIC, phone, institution)
//   POST   /hr/interns  InternBody (+ saveAsDraft?) → 201 InternDetail. HR: pending_approval (draft with saveAsDraft);
//                                                     the CEO's own enrolment is active at once.
//   GET    /hr/interns/:id                          InternDetail (+ events, certificates, login, attendance summary of this month)
//   PATCH  /hr/interns/:id  Partial<InternBody>     → InternDetail. A completed / terminated intern: personal, academic and
//                                                     remarks only (409 INTERN_CLOSED). Department, supervisor, dates and
//                                                     stipend changes are logged as their own history events.
//   POST   /hr/interns/:id/submit                   draft → pending_approval (the CEO: → active)
//   POST   /hr/interns/:id/approve                  the CEO (approval type intern_enrollment): pending_approval → active
//   POST   /hr/interns/:id/reject {note ≥10}        the CEO: pending_approval → draft with rejectionNote (HR fixes, resubmits)
//   POST   /hr/interns/:id/extend {endDate, reason ≥10}            active only; a later end date (422 EXTENSION_NOT_LATER)
//   POST   /hr/interns/:id/complete {completedOn?, remarks?}      active → completed (completedOn default today)
//   POST   /hr/interns/:id/terminate {reason ≥10, effectiveDate}  draft | pending_approval | active → terminated
//   PUT    /hr/interns/:id/login {userId | null}                 links a login of the intern's company (409 LOGIN_TAKEN)
//   GET    /hr/interns/:id/history                  { events } — the complete internship history
// Body checks: departmentId = a Department of the intern's company (or a shared one) — 422 DEPARTMENT_NOT_IN_COMPANY;
// supervisorEmployeeId = an active HrEmployee of the same company — 422 SUPERVISOR_NOT_IN_COMPANY; paid needs a
// stipend > 0 (422 STIPEND_REQUIRED), unpaid has none (422 STIPEND_ON_UNPAID); end ≥ start (422 BAD_DATES); the
// same CNIC open in the company → 409 INTERN_CNIC_EXISTS.
// Documents: the ONE record-files store, owner type intern_document (modules/recordFiles/providers.ts) —
// /record-files/intern_document/:internId. No URL fields.
//
// ── Attendance (marked by HR or the supervisor; interns do not clock in) ──
// Statuses: present, absent, late, half_day, leave, weekly_off. One row per intern per day.
//   GET  /hr/interns/attendance?month=YYYY-MM&internId=&departmentId=   { month, days, interns:[{…, days:{date:{status,…}}, summary}] }
//   POST /hr/interns/attendance/bulk {internIds[1..500], from, to (≤62 days), status, checkIn?, checkOut?, note?, overwrite?}
//        → { created, updated, skipped:[{internId, date, reason}] }. Skipped: NOT_ENROLLED, OUTSIDE_INTERNSHIP, FUTURE,
//        NOT_A_WORKING_DAY (unless status weekly_off), IN_PAYROLL, ALREADY_MARKED (unless overwrite). An intern
//        outside the caller's companies → 404 for the whole call.
//   PUT  /hr/interns/:id/attendance/:date {status, checkIn?, checkOut?, note?}   one day (audited before → after).
//        409 IN_PAYROLL (the month's stipend payroll has left draft), 422 OUTSIDE_INTERNSHIP / FUTURE_DATE.
// Supervisor (self-service, /hr/my-interns — never stipend or CNIC):
//   GET  /hr/my-interns                       { items }
//   GET  /hr/my-interns/:id?month=            { intern, attendance:{month, days:{…}, summary} }
//   PUT  /hr/my-interns/:id/attendance/:date  as above (source 'supervisor')
//   PUT  /hr/my-interns/:id/remarks {performanceRemarks}
//
// ── Stipend payroll (internPayroll.ts — separate from employee payroll) ──
// draft → finance_review → finance_checked → approved → paid. Only PAID interns enrolled during the month.
// stipend ÷ calendar days × paid days (absent 1, half day 0.5, leave 1 — unpaid), ± HR's adjustments.
//   GET  /hr/interns/payroll/runs?status=&period=        { items }            HR + finance
//   POST /hr/interns/payroll/runs {period}               201 run view          HR (409 RUN_EXISTS, 422 FUTURE_PERIOD)
//   GET  /hr/interns/payroll/runs/:id                    run view {…run, statusLabel, people, slips:[{…slip, intern}]}
//   POST /hr/interns/payroll/runs/:id/recalculate        HR, draft (adjustments kept)
//   PUT  /hr/interns/payroll/slips/:id/adjustments {items:[{id?, kind: addition|deduction, label, amountCents, note?}]}  HR, draft
//   POST /hr/interns/payroll/runs/:id/send-to-finance    HR, draft → finance_review (409 RUN_INCOMPLETE: no slips / a negative slip)
//   POST /hr/interns/payroll/runs/:id/finance-pass {note?}            finance → finance_checked   (approval type intern_payroll_finance)
//   POST /hr/interns/payroll/runs/:id/finance-return {note ≥10}       finance → draft
//   POST /hr/interns/payroll/runs/:id/approve                         the CEO → approved; books Dr 6038 / Cr 2025
//                                                                     (approval type intern_payroll; response .accrual)
//   POST /hr/interns/payroll/runs/:id/return {note ≥10, to: hr|finance}   the CEO
//   POST /hr/interns/payroll/runs/:id/paid {method: cash|bank_transfer|cheque, bankAccountId?, reference (not cash),
//        paidOn?, classification?, taxStatus?, nonDeductionReason?}   finance → paid; books Dr 2025 / Cr cash | bank
//   GET  /hr/interns/payroll/runs/:id/sheet?format=csv|xlsx|pdf      the stipend sheet
//   GET  /hr/interns/payroll/slips/:id/pdf?download=1 · /runs/:id/slips.pdf   STIPEND SLIP PDF
// Separation of duties: whoever created, prepared or sent the run never passes it at finance (403
// SELF_APPROVAL_BLOCKED; the CEO excepted); nobody pays a run carrying their own stipend (403 OWN_PAY_IN_RUN).
// Accounts: 6038 Intern Stipends (expense) and 2025 Stipends Payable (liability), lib/chartOfAccounts.ts.
//
// ── Certificates (HR or the CEO; completed interns only) ──
//   GET  /hr/interns/:id/certificates                   { certificateStatus, items }
//   POST /hr/interns/:id/certificates {remarks?}        201 (status generated). 409 INTERN_NOT_COMPLETED, 409 CERTIFICATE_EXISTS
//   POST /hr/interns/certificates/:certId/issue         generated → issued
//   POST /hr/interns/:id/certificates/reissue {reason ≥10, remarks?}   201 a new certificate (status reissued, issued at
//                                                       once); the old one is superseded. 409 NO_CERTIFICATE
//   GET  /hr/interns/certificates/:certId/pdf?download=1    the Certificate of Internship (application/pdf)
// Numbers IC-<year>-0001 per company (year of generation), under an advisory lock; one live certificate per intern
// (SQL partial unique intern_certificates_one_live).
//
// ── Reports & dashboard (HR; each ?format=csv|xlsx|pdf, JSON without) ──
//   GET /hr/interns/reports/:key   key = register (department-wise) | active | completions (?from&to) |
//                                  attendance (?month) | payroll (?month) | stipend_by_department (?from&to months) |
//                                  certificates. Filters: departmentId, supervisorEmployeeId, status, joinedFrom,
//                                  joinedTo, q. JSON: { key, title, period, columns:[{key,label,type}], rows }
//   GET /hr/interns/dashboard?month=   { total, byStatus, paid, unpaid, byDepartment:[{departmentId,name,count}],
//                                       stipend:{period, runStatus, netCents}, certificatesIssued, endingSoon:[…] }
//
// Approval types (lib/approvalRights.ts): intern_enrollment (ceo), intern_payroll_finance (finance), intern_payroll
// (ceo) — never handed over. Audit (lib/audit.ts): hr.intern.*, hr.intern_payroll.*, hr.intern_certificate.*.
// Tests: tests/internManagement.test.ts.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Intern, Prisma } from '@prisma/client'
import { z } from 'zod'
import { serviceClient as prisma } from '../../lib/prisma.js'
import { requireAuth, ALL_STAFF } from '../auth/middleware.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { audit } from '../../lib/audit.js'
import { INT4_MAX_CENTS } from '../../lib/money.js'
import { exportFormatOf, sendReportFor, type ReportColumn, type ReportRow } from '../../lib/reportExport.js'
import { approvalInputOf, approvalSubject, assertCanApprove, auditApproval } from '../../lib/approvalRights.js'
import { approvalWaiting } from '../approvals/notify.js'
import { nextPeriod, periodOf, periodStart, pktToday } from './logic.js'
import {
  ATTENDANCE_LABEL, ATTENDANCE_STATUSES, DAY_MS, ENROLLED, INTERN_STATUSES, INTERN_STATUS_LABEL, WEEKDAY_LABEL, YMD,
  assertInternHr, createTenant, internInScope, lastDayOf, logInternEvent, memberTenants, ownEmployeeIds, parseYmd,
  supervisedIntern, viewTenants, withinInternship, workingDaysOf, ymdOf, type Db,
} from './internAccess.js'
import { attendanceLocked, internPayrollRoutes } from './internPayroll.js'
import { certificatePdf, durationText } from './internPdf.js'

// ─── Shapes ─────────────────────────────────────────────────────────────────

const opt = (max = 200) => z.string().trim().max(max).nullish().transform((v) => (v ? v : null))
const ymd = z.string().regex(YMD, 'A date as YYYY-MM-DD')
const CNIC = /^\d{5}-?\d{7}-?\d$/

const internFields = {
  fullName: z.string().trim().min(2).max(120),
  fatherName: opt(120),
  cnic: z.string().trim().regex(CNIC, 'CNIC / B-form as 12345-1234567-1').nullish().transform((v) => (v ? v.replace(/-/g, '').replace(/^(\d{5})(\d{7})(\d)$/, '$1-$2-$3') : null)),
  dateOfBirth: ymd.nullish(),
  gender: z.enum(['male', 'female', 'other']).nullish(),
  phone: opt(30), email: z.string().trim().email().max(160).nullish().transform((v) => v || null), address: opt(400),
  emergencyContactName: opt(120), emergencyContactPhone: opt(30),
  institution: opt(160), degree: opt(120), fieldOfStudy: opt(120), semester: opt(40), studentRegNo: opt(60),
  departmentId: z.string().min(1).max(64).nullish(), designation: opt(120), supervisorEmployeeId: z.string().min(1).max(64).nullish(),
  startDate: ymd, endDate: ymd.nullish(),
  internshipType: z.enum(['paid', 'unpaid']),
  monthlyStipendCents: z.number().int().min(0).max(INT4_MAX_CENTS),
  workingDays: z.array(z.number().int().min(0).max(6)).min(1).max(7).refine((a) => new Set(a).size === a.length, 'Each weekday once'),
  workingHours: opt(80),
  performanceRemarks: opt(2000),
}
const createBody = z.object({
  ...internFields,
  internshipType: internFields.internshipType.default('unpaid'),
  monthlyStipendCents: internFields.monthlyStipendCents.default(0),
  workingDays: internFields.workingDays.default([1, 2, 3, 4, 5, 6]),
  saveAsDraft: z.boolean().default(false),
}).strict()
const patchBody = z.object(internFields).partial().strict()
type InternData = Partial<z.infer<typeof patchBody>>

/** Fields that are the internship itself — fixed once the intern is completed / terminated. */
const INTERNSHIP_FIELDS = ['departmentId', 'designation', 'supervisorEmployeeId', 'startDate', 'endDate', 'internshipType', 'monthlyStipendCents', 'workingDays', 'workingHours'] as const

const DATE_FIELDS = ['dateOfBirth', 'startDate', 'endDate'] as const

/** Body → columns (dates parsed), plus the company checks. */
async function columnsFor(db: Db, tenantId: string, d: InternData, current?: Intern): Promise<Prisma.InternUncheckedUpdateInput> {
  const out: Record<string, unknown> = { ...d }
  for (const k of DATE_FIELDS) if (k in d) out[k] = d[k] ? parseYmd(d[k]!, k) : null
  const start = (out['startDate'] as Date | undefined) ?? current?.startDate
  const end = 'endDate' in out ? (out['endDate'] as Date | null) : current?.endDate ?? null
  if (start && end && end < start) throw new AppError('BAD_DATES', 'The end date is before the start date', 422)
  const type = d.internshipType ?? current?.internshipType ?? 'unpaid'
  let stipend = d.monthlyStipendCents ?? current?.monthlyStipendCents ?? 0
  // Switching to unpaid without naming a stipend drops it.
  if (d.internshipType === 'unpaid' && d.monthlyStipendCents === undefined) stipend = 0
  if (type === 'paid' && !(stipend > 0)) throw new AppError('STIPEND_REQUIRED', 'A paid internship needs a monthly stipend', 422)
  if (type === 'unpaid' && stipend !== 0) throw new AppError('STIPEND_ON_UNPAID', 'An unpaid internship has no stipend — set it to paid or the stipend to 0', 422)
  if ('internshipType' in d || 'monthlyStipendCents' in d) { out['internshipType'] = type; out['monthlyStipendCents'] = stipend }
  if (d.departmentId) {
    const dep = await db.department.findFirst({ where: { id: d.departmentId, archivedAt: null, OR: [{ tenantId }, { tenantId: null }] }, select: { id: true } })
    if (!dep) throw new AppError('DEPARTMENT_NOT_IN_COMPANY', "That department is not one of this company's departments", 422)
  }
  if (d.supervisorEmployeeId) {
    const sup = await db.hrEmployee.findFirst({ where: { id: d.supervisorEmployeeId, tenantId, status: { in: ['active', 'on_leave'] } }, select: { id: true } })
    if (!sup) throw new AppError('SUPERVISOR_NOT_IN_COMPANY', "The supervisor must be a current employee of this company", 422)
  }
  return out as Prisma.InternUncheckedUpdateInput
}

async function assertCnicFree(db: Db, tenantId: string, cnic: string | null | undefined, exceptId?: string) {
  if (!cnic) return
  const dup = await db.intern.findFirst({ where: { tenantId, cnic, status: { in: ['draft', 'pending_approval', 'active'] }, ...(exceptId && { NOT: { id: exceptId } }) }, select: { id: true, internCode: true } })
  if (dup) throw new AppError('INTERN_CNIC_EXISTS', `An open intern record (${dup.internCode}) already carries this CNIC / B-form`, 409, { id: dup.id })
}

/** INT-0001 … per company, under an advisory lock. */
export async function nextInternCode(tx: Prisma.TransactionClient, tenantId: string): Promise<string> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`intern-code:${tenantId}`}::text))`
  const codes = await tx.intern.findMany({ where: { tenantId, internCode: { startsWith: 'INT-' } }, select: { internCode: true } })
  const max = codes.reduce((m, c) => Math.max(m, Number(/^INT-(\d+)$/.exec(c.internCode)?.[1] ?? 0)), 0)
  return `INT-${String(max + 1).padStart(4, '0')}`
}

// ─── Views ──────────────────────────────────────────────────────────────────

async function namesFor(rows: Intern[]) {
  const deptIds = [...new Set(rows.map((r) => r.departmentId).filter((x): x is string => !!x))]
  const supIds = [...new Set(rows.map((r) => r.supervisorEmployeeId).filter((x): x is string => !!x))]
  const [depts, sups, certs] = await Promise.all([
    prisma.department.findMany({ where: { id: { in: deptIds } }, select: { id: true, name: true } }),
    prisma.hrEmployee.findMany({ where: { id: { in: supIds } }, select: { id: true, fullName: true, employeeCode: true, userId: true } }),
    prisma.internCertificate.findMany({ where: { internId: { in: rows.map((r) => r.id) }, supersededAt: null }, select: { internId: true, status: true, number: true } }),
  ])
  return {
    dept: new Map(depts.map((d) => [d.id, d.name])),
    sup: new Map(sups.map((s) => [s.id, s])),
    cert: new Map(certs.map((c) => [c.internId, c])),
  }
}

const CERT_LABEL: Record<string, string> = { not_issued: 'Not Issued', generated: 'Generated', issued: 'Issued', reissued: 'Re-issued' }

function rowOf(i: Intern, n: Awaited<ReturnType<typeof namesFor>>) {
  const sup = i.supervisorEmployeeId ? n.sup.get(i.supervisorEmployeeId) : null
  const cert = n.cert.get(i.id)
  const certificateStatus = cert?.status ?? 'not_issued'
  return {
    ...i,
    statusLabel: INTERN_STATUS_LABEL[i.status as keyof typeof INTERN_STATUS_LABEL] ?? i.status,
    department: i.departmentId ? n.dept.get(i.departmentId) ?? null : null,
    supervisor: sup ? { id: sup.id, fullName: sup.fullName, employeeCode: sup.employeeCode } : null,
    lastDay: ymdOf(lastDayOf(i)),
    loginLinked: !!i.userId,
    certificateStatus, certificateStatusLabel: CERT_LABEL[certificateStatus], certificateNumber: cert?.number ?? null,
  }
}

async function attendanceSummary(internId: string, month: string) {
  const rows = await prisma.internAttendance.findMany({ where: { internId, date: { gte: periodStart(month), lt: periodStart(nextPeriod(month)) } }, orderBy: { date: 'asc' } })
  const summary = Object.fromEntries(ATTENDANCE_STATUSES.map((s) => [s, 0])) as Record<string, number>
  for (const r of rows) summary[r.status] = (summary[r.status] ?? 0) + 1
  return { month, days: Object.fromEntries(rows.map((r) => [ymdOf(r.date)!, { status: r.status, checkIn: r.checkIn, checkOut: r.checkOut, note: r.note, source: r.source }])), summary }
}

async function detailOf(i: Intern) {
  const n = await namesFor([i])
  const [events, certificates, login, slips] = await Promise.all([
    prisma.internEvent.findMany({ where: { internId: i.id }, orderBy: { createdAt: 'desc' }, take: 200 }),
    prisma.internCertificate.findMany({ where: { internId: i.id }, orderBy: { createdAt: 'desc' } }),
    i.userId ? prisma.user.findUnique({ where: { id: i.userId }, select: { id: true, name: true, email: true, role: true } }) : null,
    prisma.internStipendSlip.findMany({ where: { internId: i.id }, include: { run: { select: { id: true, period: true, status: true } } }, orderBy: { createdAt: 'desc' }, take: 24 }),
  ])
  const actors = await userNames(events.map((e) => e.actorId))
  return {
    ...rowOf(i, n),
    login,
    events: events.map((e) => ({ ...e, actorName: e.actorId ? actors.get(e.actorId) ?? null : null })),
    certificates,
    stipends: slips.map((s) => ({ slipId: s.id, runId: s.run.id, period: s.run.period, runStatus: s.run.status, netCents: s.netCents, paidDays: s.paidDays })),
    attendance: await attendanceSummary(i.id, periodOf(pktToday())),
  }
}

async function userNames(ids: Array<string | null | undefined>): Promise<Map<string, string | null>> {
  const want = [...new Set(ids.filter((x): x is string => !!x))]
  if (!want.length) return new Map()
  return new Map((await prisma.user.findMany({ where: { id: { in: want } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]))
}

const auditIntern = (req: FastifyRequest, i: Pick<Intern, 'id' | 'tenantId' | 'internCode'>, action: string, e: { before?: unknown; after?: unknown } = {}) => audit({
  category: 'identity', action: `hr.intern.${action}`, entity: 'Intern', entityId: i.id, userId: req.staffUser!.id, userEmail: req.staffUser!.email ?? null,
  tenantId: i.tenantId, before: e.before as never, after: { internCode: i.internCode, ...(e.after as object ?? {}) } as never, metadata: { actorRole: req.staffUser!.role },
})

/** A conditional status move (409 STATUS_CHANGED when someone else moved it first). */
async function moveStatus(tx: Db, i: Intern, from: string[], data: Prisma.InternUncheckedUpdateManyInput): Promise<void> {
  const n = await tx.intern.updateMany({ where: { id: i.id, status: { in: from } }, data })
  if (n.count === 0) throw new AppError('STATUS_CHANGED', 'This intern record changed meanwhile — reload it', 409)
}

// ─── Filters (lists and reports) ────────────────────────────────────────────

const filterQuery = z.object({
  status: z.string().optional(), departmentId: z.string().optional(), supervisorEmployeeId: z.string().optional(),
  internshipType: z.enum(['paid', 'unpaid']).optional(), joinedFrom: ymd.optional(), joinedTo: ymd.optional(), q: z.string().trim().max(80).optional(),
}).passthrough()

function filterWhere(req: FastifyRequest, q: z.infer<typeof filterQuery>): Prisma.InternWhereInput {
  const statuses = q.status?.split(',').filter((s) => (INTERN_STATUSES as readonly string[]).includes(s))
  return {
    tenantId: { in: viewTenants(req) },
    ...(statuses?.length && { status: { in: statuses } }),
    ...(q.departmentId && { departmentId: q.departmentId }),
    ...(q.supervisorEmployeeId && { supervisorEmployeeId: q.supervisorEmployeeId }),
    ...(q.internshipType && { internshipType: q.internshipType }),
    ...((q.joinedFrom || q.joinedTo) && { startDate: { ...(q.joinedFrom && { gte: parseYmd(q.joinedFrom) }), ...(q.joinedTo && { lte: parseYmd(q.joinedTo) }) } }),
    ...(q.q && { OR: ['fullName', 'internCode', 'cnic', 'phone', 'institution', 'email'].map((f) => ({ [f]: { contains: q.q, mode: 'insensitive' } })) }),
  }
}

// ─── Attendance writes ──────────────────────────────────────────────────────

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'A time as HH:MM')
const dayBody = z.object({ status: z.enum(ATTENDANCE_STATUSES), checkIn: HHMM.nullish(), checkOut: HHMM.nullish(), note: z.string().trim().max(300).nullish() }).strict()

async function setDay(req: FastifyRequest, i: Intern, dateStr: string, b: z.infer<typeof dayBody>, source: 'hr' | 'supervisor') {
  const day = parseYmd(dateStr)
  if (!(ENROLLED as string[]).includes(i.status)) throw new AppError('NOT_ENROLLED', 'Attendance is kept for approved interns only', 409)
  if (day > pktToday()) throw new AppError('FUTURE_DATE', 'Attendance cannot be marked for a day that has not come', 422)
  if (!withinInternship(i, day)) throw new AppError('OUTSIDE_INTERNSHIP', 'That day is outside the internship', 422)
  if (await attendanceLocked(prisma, i, day)) throw new AppError('IN_PAYROLL', "That month's stipend payroll has left draft — its attendance is locked", 409)
  const before = await prisma.internAttendance.findUnique({ where: { internId_date: { internId: i.id, date: day } } })
  const data = { status: b.status, checkIn: b.checkIn ?? null, checkOut: b.checkOut ?? null, note: b.note ?? null, source, markedById: req.staffUser!.id }
  const row = await prisma.internAttendance.upsert({ where: { internId_date: { internId: i.id, date: day } }, create: { tenantId: i.tenantId, internId: i.id, date: day, ...data }, update: data })
  await audit({
    category: 'identity', action: before ? 'hr.intern.attendance_adjust' : 'hr.intern.attendance_mark', entity: 'InternAttendance', entityId: row.id,
    userId: req.staffUser!.id, userEmail: req.staffUser!.email ?? null, tenantId: i.tenantId,
    before: before ? { status: before.status, checkIn: before.checkIn, checkOut: before.checkOut, note: before.note, source: before.source } : null,
    after: { internId: i.id, date: dateStr, ...data }, metadata: { actorRole: req.staffUser!.role, source },
  })
  return row
}

// ─── Certificates ───────────────────────────────────────────────────────────

async function nextCertificateNumber(tx: Prisma.TransactionClient, tenantId: string, year: number): Promise<string> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`intern-cert:${tenantId}`}::text))`
  const prefix = `IC-${year}-`
  const rows = await tx.internCertificate.findMany({ where: { tenantId, number: { startsWith: prefix } }, select: { number: true } })
  const max = rows.reduce((m, r) => Math.max(m, Number(r.number.slice(prefix.length)) || 0), 0)
  return `${prefix}${String(max + 1).padStart(4, '0')}`
}

const certificateStatusOf = async (internId: string) => (await prisma.internCertificate.findFirst({ where: { internId, supersededAt: null }, select: { status: true } }))?.status ?? 'not_issued'

async function certificateInScope(req: FastifyRequest, id: string) {
  const c = await prisma.internCertificate.findFirst({ where: { id, tenantId: { in: memberTenants(req) } }, include: { intern: true } })
  if (!c) throw new NotFoundError('Certificate', id)
  return c
}

// ─── Reports ────────────────────────────────────────────────────────────────

const REPORT_KEYS = ['register', 'active', 'completions', 'attendance', 'payroll', 'stipend_by_department', 'certificates'] as const
type ReportKey = (typeof REPORT_KEYS)[number]
const zMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/)

async function buildInternReport(req: FastifyRequest, key: ReportKey, raw: Record<string, unknown>): Promise<{ title: string; period?: string; columns: ReportColumn[]; rows: ReportRow[]; sectionKey?: string }> {
  const q = filterQuery.parse(raw)
  const month = zMonth.safeParse(raw['month']).success ? String(raw['month']) : periodOf(pktToday())
  const from = typeof raw['from'] === 'string' && YMD.test(raw['from']) ? String(raw['from']) : null
  const to = typeof raw['to'] === 'string' && YMD.test(raw['to']) ? String(raw['to']) : null
  const base = filterWhere(req, q)
  const col = (k: string, label: string, type?: ReportColumn['type']): ReportColumn => ({ key: k, label, ...(type && { type }) })
  const internCols = [col('code', 'Intern ID'), col('name', 'Name'), col('department', 'Department'), col('designation', 'Position'), col('supervisor', 'Supervisor'), col('institution', 'Institution'), col('start', 'Start'), col('end', 'End'), col('type', 'Type'), col('stipend', 'Monthly stipend', 'cents'), col('status', 'Status')]
  const internRow = (r: ReturnType<typeof rowOf>): ReportRow => ({
    code: r.internCode, name: r.fullName, department: r.department ?? 'No department', designation: r.designation ?? '', supervisor: r.supervisor?.fullName ?? '',
    institution: r.institution ?? '', start: ymdOf(r.startDate), end: r.lastDay ?? '', type: r.internshipType, stipend: r.monthlyStipendCents, status: r.statusLabel,
  })
  const loadRows = async (where: Prisma.InternWhereInput) => {
    const rows = await prisma.intern.findMany({ where, orderBy: [{ internCode: 'asc' }] })
    const n = await namesFor(rows)
    return rows.map((r) => rowOf(r, n))
  }
  switch (key) {
    case 'register': {
      const rows = (await loadRows(base)).sort((a, b) => (a.department ?? '~').localeCompare(b.department ?? '~') || a.internCode.localeCompare(b.internCode))
      return { title: 'Intern register — by department', columns: internCols, rows: rows.map(internRow), sectionKey: 'department' }
    }
    case 'active':
      return { title: 'Active interns', columns: internCols, rows: (await loadRows({ ...base, status: 'active' })).map(internRow) }
    case 'completions': {
      const rows = await loadRows({ ...base, status: 'completed', ...((from || to) && { completedOn: { ...(from && { gte: parseYmd(from) }), ...(to && { lte: parseYmd(to) }) } }) })
      return {
        title: 'Internship completions', period: from || to ? `${from ?? '…'} to ${to ?? '…'}` : undefined,
        columns: [...internCols.filter((c) => c.key !== 'status'), col('completed', 'Completed on'), col('duration', 'Duration'), col('certificate', 'Certificate')],
        rows: rows.map((r) => ({ ...internRow(r), status: undefined, completed: ymdOf(r.completedOn), duration: r.completedOn ? durationText(r.startDate, r.completedOn) : '', certificate: r.certificateStatusLabel })),
      }
    }
    case 'attendance': {
      const interns = (await loadRows({ ...base, status: { in: ENROLLED } })).filter((r) => r.startDate < periodStart(nextPeriod(month)) && (!r.lastDay || r.lastDay >= `${month}-01`))
      const att = await prisma.internAttendance.groupBy({ by: ['internId', 'status'], where: { internId: { in: interns.map((r) => r.id) }, date: { gte: periodStart(month), lt: periodStart(nextPeriod(month)) } }, _count: { _all: true } })
      const c = (id: string, s: string) => att.find((a) => a.internId === id && a.status === s)?._count._all ?? 0
      return {
        title: 'Intern attendance', period: month,
        columns: [col('code', 'Intern ID'), col('name', 'Name'), col('department', 'Department'), ...ATTENDANCE_STATUSES.map((s) => col(s, ATTENDANCE_LABEL[s], 'number')), col('marked', 'Days marked', 'number')],
        rows: interns.map((r) => ({ code: r.internCode, name: r.fullName, department: r.department ?? '', ...Object.fromEntries(ATTENDANCE_STATUSES.map((s) => [s, c(r.id, s)])), marked: ATTENDANCE_STATUSES.reduce((t, s) => t + c(r.id, s), 0) })),
      }
    }
    case 'payroll': {
      const slips = await prisma.internStipendSlip.findMany({ where: { run: { tenantId: { in: viewTenants(req) }, period: month }, intern: base }, include: { intern: true, run: { select: { status: true } } }, orderBy: { intern: { internCode: 'asc' } } })
      const n = await namesFor(slips.map((s) => s.intern))
      return {
        title: 'Monthly intern payroll', period: month,
        columns: [col('code', 'Intern ID'), col('name', 'Name'), col('department', 'Department'), col('stipend', 'Monthly stipend', 'cents'), col('paid_days', 'Paid days', 'number'), col('base', 'Prorated', 'cents'), col('additions', 'Additions', 'cents'), col('deductions', 'Deductions', 'cents'), col('net', 'Net', 'cents'), col('run', 'Run status')],
        rows: slips.map((s) => ({ code: s.intern.internCode, name: s.intern.fullName, department: s.intern.departmentId ? n.dept.get(s.intern.departmentId) ?? '' : '', stipend: s.monthlyStipendCents, paid_days: s.paidDays, base: s.baseCents, additions: s.additionsCents, deductions: s.deductionsCents, net: s.netCents, run: s.run.status })),
      }
    }
    case 'stipend_by_department': {
      const fromM = zMonth.safeParse(raw['from']).success ? String(raw['from']) : month
      const toM = zMonth.safeParse(raw['to']).success ? String(raw['to']) : month
      const slips = await prisma.internStipendSlip.findMany({ where: { run: { tenantId: { in: viewTenants(req) }, status: { in: ['approved', 'paid'] }, period: { gte: fromM, lte: toM } }, intern: base }, include: { intern: true } })
      const n = await namesFor(slips.map((s) => s.intern))
      const by = new Map<string, { interns: Set<string>; net: number }>()
      for (const s of slips) {
        const d = s.intern.departmentId ? n.dept.get(s.intern.departmentId) ?? 'No department' : 'No department'
        const e = by.get(d) ?? { interns: new Set<string>(), net: 0 }
        e.interns.add(s.internId); e.net += s.netCents; by.set(d, e)
      }
      const rows: ReportRow[] = [...by.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([d, e]) => ({ department: d, interns: e.interns.size, net: e.net }))
      rows.push({ department: 'TOTAL', interns: new Set(slips.map((s) => s.internId)).size, net: slips.reduce((t, s) => t + s.netCents, 0) })
      return { title: 'Stipend expense by department (approved)', period: fromM === toM ? fromM : `${fromM} to ${toM}`, columns: [col('department', 'Department'), col('interns', 'Interns', 'number'), col('net', 'Stipend expense', 'cents')], rows }
    }
    case 'certificates': {
      const certs = await prisma.internCertificate.findMany({ where: { tenantId: { in: viewTenants(req) }, intern: base }, include: { intern: true }, orderBy: { createdAt: 'asc' } })
      const n = await namesFor(certs.map((c) => c.intern))
      const people = await userNames(certs.flatMap((c) => [c.issuedById, c.generatedById]))
      const numbers = new Map(certs.map((c) => [c.id, c.number]))
      return {
        title: 'Certificate issuance register',
        columns: [col('number', 'Certificate No.'), col('code', 'Intern ID'), col('name', 'Name'), col('department', 'Department'), col('status', 'Status'), col('issued', 'Issued on'), col('by', 'Issued by'), col('reissue_of', 'Re-issue of'), col('reason', 'Re-issue reason'), col('live', 'Current')],
        rows: certs.map((c) => ({
          number: c.number, code: c.intern.internCode, name: c.intern.fullName, department: c.intern.departmentId ? n.dept.get(c.intern.departmentId) ?? '' : '',
          status: CERT_LABEL[c.status] ?? c.status, issued: c.issuedAt ? c.issuedAt.toISOString().slice(0, 10) : '', by: people.get(c.issuedById ?? c.generatedById ?? '') ?? '',
          reissue_of: c.reissueOfId ? numbers.get(c.reissueOfId) ?? '' : '', reason: c.reissueReason ?? '', live: c.supersededAt ? 'Superseded' : 'Yes',
        })),
      }
    }
  }
}

// ─── Routes ─────────────────────────────────────────────────────────────────

export async function internRoutes(fastify: FastifyInstance) {
  const staff = { preHandler: requireAuth(...ALL_STAFF) }
  const I = '/interns'

  fastify.get(`${I}/lookups`, staff, async (req) => {
    await assertInternHr(req)
    const tenants = viewTenants(req)
    const [departments, supervisors] = await Promise.all([
      prisma.department.findMany({ where: { archivedAt: null, OR: [{ tenantId: { in: tenants } }, { tenantId: null }] }, select: { id: true, name: true, tenantId: true }, orderBy: [{ order: 'asc' }, { name: 'asc' }] }),
      prisma.hrEmployee.findMany({ where: { tenantId: { in: tenants }, status: { in: ['active', 'on_leave'] } }, select: { id: true, fullName: true, employeeCode: true, designationId: true, tenantId: true }, orderBy: { fullName: 'asc' } }),
    ])
    const designations = new Map((await prisma.hrOrgUnit.findMany({ where: { id: { in: supervisors.map((s) => s.designationId).filter((x): x is string => !!x) } }, select: { id: true, name: true } })).map((d) => [d.id, d.name]))
    return {
      departments, supervisors: supervisors.map((s) => ({ id: s.id, fullName: s.fullName, employeeCode: s.employeeCode, tenantId: s.tenantId, designation: s.designationId ? designations.get(s.designationId) ?? null : null })),
      statuses: INTERN_STATUSES, statusLabels: INTERN_STATUS_LABEL, attendanceStatuses: ATTENDANCE_STATUSES, attendanceLabels: ATTENDANCE_LABEL,
      weekdays: WEEKDAY_LABEL.map((label, value) => ({ value, label })), certificateStatusLabels: CERT_LABEL,
    }
  })

  fastify.get(`${I}`, staff, async (req) => {
    await assertInternHr(req)
    const q = filterQuery.parse(req.query)
    const rows = await prisma.intern.findMany({ where: filterWhere(req, q), orderBy: [{ createdAt: 'desc' }], take: 2000 })
    const n = await namesFor(rows)
    return { items: rows.map((r) => rowOf(r, n)) }
  })

  fastify.post(`${I}`, staff, async (req, reply) => {
    await assertInternHr(req)
    const b = createBody.parse(req.body)
    const tenantId = createTenant(req)
    const { saveAsDraft, ...fields } = b
    const ceo = req.staffUser!.role === 'admin'
    const status = saveAsDraft ? 'draft' : ceo ? 'active' : 'pending_approval'
    const now = new Date()
    const intern = await prisma.$transaction(async (tx) => {
      const cols = await columnsFor(tx, tenantId, fields)
      await assertCnicFree(tx, tenantId, fields.cnic)
      const internCode = await nextInternCode(tx, tenantId)
      const i = await tx.intern.create({
        data: {
          ...(cols as Prisma.InternUncheckedCreateInput), tenantId, internCode, fullName: fields.fullName, startDate: parseYmd(fields.startDate),
          status, createdById: req.staffUser!.id,
          ...(status !== 'draft' && { submittedById: req.staffUser!.id, submittedAt: now }),
          ...(status === 'active' && { approvedById: req.staffUser!.id, approvedAt: now }),
        },
      })
      await logInternEvent(tx, i, 'enrolled', { actorId: req.staffUser!.id, after: { status }, effectiveDate: i.startDate })
      if (status === 'active') await logInternEvent(tx, i, 'approved', { actorId: req.staffUser!.id, note: 'Enrolled by the CEO' })
      return i
    })
    await auditIntern(req, intern, 'enroll', { after: { status, fullName: intern.fullName, departmentId: intern.departmentId, internshipType: intern.internshipType, monthlyStipendCents: intern.monthlyStipendCents } })
    if (status === 'pending_approval') approvalWaiting('intern_enrollment', intern.id, { round: `submit:${now.toISOString()}`, actorId: req.staffUser!.id })
    return reply.status(201).send(await detailOf(intern))
  })

  fastify.get<{ Params: { id: string } }>(`${I}/:id`, staff, async (req) => {
    await assertInternHr(req)
    return detailOf(await internInScope(req, req.params.id))
  })

  fastify.get<{ Params: { id: string } }>(`${I}/:id/history`, staff, async (req) => {
    await assertInternHr(req)
    const i = await internInScope(req, req.params.id)
    const events = await prisma.internEvent.findMany({ where: { internId: i.id }, orderBy: { createdAt: 'asc' } })
    const actors = await userNames(events.map((e) => e.actorId))
    return { events: events.map((e) => ({ ...e, actorName: e.actorId ? actors.get(e.actorId) ?? null : null })) }
  })

  fastify.patch<{ Params: { id: string } }>(`${I}/:id`, staff, async (req) => {
    await assertInternHr(req)
    const b = patchBody.parse(req.body)
    const i = await internInScope(req, req.params.id)
    const closed = i.status === 'completed' || i.status === 'terminated'
    if (closed && INTERNSHIP_FIELDS.some((k) => k in b)) {
      throw new AppError('INTERN_CLOSED', 'This internship has ended — only personal, academic and remark details can change', 409)
    }
    const next = await prisma.$transaction(async (tx) => {
      const cols = await columnsFor(tx, i.tenantId, b, i)
      if ('cnic' in b) await assertCnicFree(tx, i.tenantId, b.cnic, i.id)
      const n = await tx.intern.updateMany({ where: { id: i.id, updatedAt: i.updatedAt }, data: cols as Prisma.InternUncheckedUpdateManyInput })
      if (n.count === 0) throw new AppError('STATUS_CHANGED', 'This intern record changed meanwhile — reload it', 409)
      const after = await tx.intern.findUniqueOrThrow({ where: { id: i.id } })
      const actorId = req.staffUser!.id
      if ('departmentId' in b && after.departmentId !== i.departmentId) await logInternEvent(tx, i, 'department_changed', { actorId, before: { departmentId: i.departmentId }, after: { departmentId: after.departmentId } })
      if ('supervisorEmployeeId' in b && after.supervisorEmployeeId !== i.supervisorEmployeeId) await logInternEvent(tx, i, 'supervisor_changed', { actorId, before: { supervisorEmployeeId: i.supervisorEmployeeId }, after: { supervisorEmployeeId: after.supervisorEmployeeId } })
      if (('monthlyStipendCents' in b || 'internshipType' in b) && (after.monthlyStipendCents !== i.monthlyStipendCents || after.internshipType !== i.internshipType)) {
        await logInternEvent(tx, i, 'stipend_changed', { actorId, before: { internshipType: i.internshipType, monthlyStipendCents: i.monthlyStipendCents }, after: { internshipType: after.internshipType, monthlyStipendCents: after.monthlyStipendCents } })
      }
      if (('startDate' in b || 'endDate' in b) && (ymdOf(after.startDate) !== ymdOf(i.startDate) || ymdOf(after.endDate) !== ymdOf(i.endDate))) {
        await logInternEvent(tx, i, 'dates_changed', { actorId, before: { startDate: ymdOf(i.startDate), endDate: ymdOf(i.endDate) }, after: { startDate: ymdOf(after.startDate), endDate: ymdOf(after.endDate) } })
      }
      const changed = Object.keys(b).filter((k) => JSON.stringify((i as Record<string, unknown>)[k]) !== JSON.stringify((after as Record<string, unknown>)[k]))
      if (changed.length) await logInternEvent(tx, i, 'edited', { actorId, after: { fields: changed } })
      return { after, changed }
    })
    const pick = (o: Intern) => Object.fromEntries(next.changed.map((k) => [k, (o as Record<string, unknown>)[k]]))
    if (next.changed.length) await auditIntern(req, i, 'edit', { before: pick(i), after: pick(next.after) })
    return detailOf(next.after)
  })

  fastify.post<{ Params: { id: string } }>(`${I}/:id/submit`, staff, async (req) => {
    await assertInternHr(req)
    const i = await internInScope(req, req.params.id)
    if (i.status !== 'draft') throw new AppError('NOT_DRAFT', 'Only a draft enrolment can be submitted', 409)
    const ceo = req.staffUser!.role === 'admin'
    const now = new Date()
    await prisma.$transaction(async (tx) => {
      await moveStatus(tx, i, ['draft'], { status: ceo ? 'active' : 'pending_approval', submittedById: req.staffUser!.id, submittedAt: now, rejectionNote: null, ...(ceo && { approvedById: req.staffUser!.id, approvedAt: now }) })
      await logInternEvent(tx, i, ceo ? 'approved' : 'submitted', { actorId: req.staffUser!.id })
    })
    await auditIntern(req, i, 'submit', { after: { status: ceo ? 'active' : 'pending_approval' } })
    if (!ceo) approvalWaiting('intern_enrollment', i.id, { round: `submit:${now.toISOString()}`, actorId: req.staffUser!.id })
    return detailOf(await prisma.intern.findUniqueOrThrow({ where: { id: i.id } }))
  })

  const decide = async (req: FastifyRequest, id: string, action: string) => {
    const i = await internInScope(req, id)
    const subj = await approvalSubject('intern_enrollment', id)
    if (!subj) throw new NotFoundError('Intern', id)
    const grant = await assertCanApprove(req, approvalInputOf('intern_enrollment', id, subj, { entity: 'Intern', action: `${action} an intern enrolment` }))
    if (i.status !== 'pending_approval') throw new AppError('NOT_PENDING', 'This enrolment is not waiting for approval', 409)
    return { i, grant }
  }
  fastify.post<{ Params: { id: string } }>(`${I}/:id/approve`, staff, async (req) => {
    const { i, grant } = await decide(req, req.params.id, 'approve')
    const now = new Date()
    await prisma.$transaction(async (tx) => {
      await moveStatus(tx, i, ['pending_approval'], { status: 'active', approvedById: req.staffUser!.id, approvedAt: now, rejectionNote: null })
      await logInternEvent(tx, i, 'approved', { actorId: req.staffUser!.id })
    })
    await auditIntern(req, i, 'approve', { after: { status: 'active' } })
    await auditApproval(req, { type: 'intern_enrollment', id: i.id, tenantId: i.tenantId, decision: 'approve', grant, entity: 'Intern', metadata: { internCode: i.internCode, decidedAt: now.toISOString() } })
    return detailOf(await prisma.intern.findUniqueOrThrow({ where: { id: i.id } }))
  })
  fastify.post<{ Params: { id: string } }>(`${I}/:id/reject`, staff, async (req) => {
    const { note } = z.object({ note: z.string().trim().max(1000).optional() }).parse(req.body ?? {})
    if (!note || note.length < 10) throw new AppError('NOTE_REQUIRED', 'Say why (at least 10 characters)', 422)
    const { i, grant } = await decide(req, req.params.id, 'reject')
    const now = new Date()
    await prisma.$transaction(async (tx) => {
      await moveStatus(tx, i, ['pending_approval'], { status: 'draft', rejectionNote: note })
      await logInternEvent(tx, i, 'rejected', { actorId: req.staffUser!.id, note })
    })
    await auditIntern(req, i, 'reject', { after: { status: 'draft', note } })
    await auditApproval(req, { type: 'intern_enrollment', id: i.id, tenantId: i.tenantId, decision: 'reject', grant, entity: 'Intern', metadata: { internCode: i.internCode, decidedAt: now.toISOString(), note } })
    return detailOf(await prisma.intern.findUniqueOrThrow({ where: { id: i.id } }))
  })

  fastify.post<{ Params: { id: string } }>(`${I}/:id/extend`, staff, async (req) => {
    await assertInternHr(req)
    const b = z.object({ endDate: ymd, reason: z.string().trim().min(10, 'Give a reason of at least 10 characters').max(500) }).strict().parse(req.body)
    const i = await internInScope(req, req.params.id)
    if (i.status !== 'active') throw new AppError('INTERN_NOT_ACTIVE', 'Only an active internship can be extended', 409)
    const end = parseYmd(b.endDate, 'end date')
    if (i.endDate && end <= i.endDate) throw new AppError('EXTENSION_NOT_LATER', 'The new end date must be after the current one', 422)
    if (end < i.startDate) throw new AppError('BAD_DATES', 'The end date is before the start date', 422)
    await prisma.$transaction(async (tx) => {
      await moveStatus(tx, i, ['active'], { endDate: end })
      await logInternEvent(tx, i, 'extended', { actorId: req.staffUser!.id, note: b.reason, before: { endDate: ymdOf(i.endDate) }, after: { endDate: b.endDate }, effectiveDate: end })
    })
    await auditIntern(req, i, 'extend', { before: { endDate: ymdOf(i.endDate) }, after: { endDate: b.endDate, reason: b.reason } })
    return detailOf(await prisma.intern.findUniqueOrThrow({ where: { id: i.id } }))
  })

  fastify.post<{ Params: { id: string } }>(`${I}/:id/complete`, staff, async (req) => {
    await assertInternHr(req)
    const b = z.object({ completedOn: ymd.optional(), remarks: z.string().trim().max(2000).optional() }).strict().parse(req.body ?? {})
    const i = await internInScope(req, req.params.id)
    if (i.status !== 'active') throw new AppError('INTERN_NOT_ACTIVE', 'Only an active internship can be completed', 409)
    const on = b.completedOn ? parseYmd(b.completedOn, 'completion date') : pktToday()
    if (on < i.startDate) throw new AppError('BAD_DATES', 'The completion date is before the start date', 422)
    if (on > pktToday()) throw new AppError('FUTURE_DATE', 'An internship is completed on or before today', 422)
    await prisma.$transaction(async (tx) => {
      await moveStatus(tx, i, ['active'], { status: 'completed', completedOn: on, completedAt: new Date(), ...(b.remarks && { performanceRemarks: b.remarks }) })
      await logInternEvent(tx, i, 'completed', { actorId: req.staffUser!.id, note: b.remarks ?? null, effectiveDate: on })
    })
    await auditIntern(req, i, 'complete', { after: { completedOn: ymdOf(on) } })
    return detailOf(await prisma.intern.findUniqueOrThrow({ where: { id: i.id } }))
  })

  fastify.post<{ Params: { id: string } }>(`${I}/:id/terminate`, staff, async (req) => {
    await assertInternHr(req)
    const b = z.object({ reason: z.string().trim().min(10, 'Give a reason of at least 10 characters').max(1000), effectiveDate: ymd }).strict().parse(req.body)
    const i = await internInScope(req, req.params.id)
    if (!['draft', 'pending_approval', 'active'].includes(i.status)) throw new AppError('INTERN_CLOSED', 'This internship has already ended', 409)
    const on = parseYmd(b.effectiveDate, 'effective date')
    if (i.status === 'active' && on < i.startDate) throw new AppError('BAD_DATES', 'The effective date is before the start date', 422)
    await prisma.$transaction(async (tx) => {
      await moveStatus(tx, i, ['draft', 'pending_approval', 'active'], { status: 'terminated', terminationReason: b.reason, terminationEffectiveDate: on })
      await logInternEvent(tx, i, 'terminated', { actorId: req.staffUser!.id, note: b.reason, effectiveDate: on, before: { status: i.status } })
    })
    await auditIntern(req, i, 'terminate', { before: { status: i.status }, after: { reason: b.reason, effectiveDate: b.effectiveDate } })
    return detailOf(await prisma.intern.findUniqueOrThrow({ where: { id: i.id } }))
  })

  fastify.put<{ Params: { id: string } }>(`${I}/:id/login`, staff, async (req) => {
    await assertInternHr(req)
    const { userId } = z.object({ userId: z.string().min(1).max(64).nullable() }).strict().parse(req.body)
    const i = await internInScope(req, req.params.id)
    if (userId) {
      const u = await prisma.user.findFirst({
        where: { id: userId, deletedAt: null, OR: [{ tenantId: i.tenantId }, { tenantMemberships: { some: { tenantId: i.tenantId } } }] },
        select: { id: true },
      })
      if (!u) throw new AppError('LOGIN_NOT_IN_COMPANY', "That login is not one of this company's", 422)
      const other = await prisma.intern.findFirst({ where: { userId, NOT: { id: i.id } }, select: { internCode: true } })
      if (other) throw new AppError('LOGIN_TAKEN', `That login is already linked to intern ${other.internCode}`, 409)
    }
    await prisma.$transaction(async (tx) => {
      await tx.intern.update({ where: { id: i.id }, data: { userId } })
      await logInternEvent(tx, i, userId ? 'login_linked' : 'login_unlinked', { actorId: req.staffUser!.id, before: { userId: i.userId }, after: { userId } })
    })
    await auditIntern(req, i, 'login', { before: { userId: i.userId }, after: { userId } })
    return detailOf(await prisma.intern.findUniqueOrThrow({ where: { id: i.id } }))
  })

  // ── Attendance (HR) ───────────────────────────────────────────────────────
  fastify.get<{ Querystring: { month?: string; internId?: string; departmentId?: string } }>(`${I}/attendance`, staff, async (req) => {
    await assertInternHr(req)
    const month = req.query.month && zMonth.safeParse(req.query.month).success ? req.query.month : periodOf(pktToday())
    const monthFrom = periodStart(month), monthEnd = new Date(periodStart(nextPeriod(month)).getTime() - DAY_MS)
    const rows = (await prisma.intern.findMany({
      where: { tenantId: { in: viewTenants(req) }, status: { in: ENROLLED }, startDate: { lte: monthEnd }, ...(req.query.internId && { id: req.query.internId }), ...(req.query.departmentId && { departmentId: req.query.departmentId }) },
      orderBy: { internCode: 'asc' },
    })).filter((i) => { const l = lastDayOf(i); return !l || l >= monthFrom })
    const n = await namesFor(rows)
    const att = await prisma.internAttendance.findMany({ where: { internId: { in: rows.map((r) => r.id) }, date: { gte: monthFrom, lte: monthEnd } } })
    const days: string[] = []
    for (let d = monthFrom.getTime(); d <= monthEnd.getTime(); d += DAY_MS) days.push(new Date(d).toISOString().slice(0, 10))
    return {
      month, days,
      interns: rows.map((i) => {
        const mine = att.filter((a) => a.internId === i.id)
        const summary = Object.fromEntries(ATTENDANCE_STATUSES.map((s) => [s, mine.filter((a) => a.status === s).length]))
        return {
          id: i.id, internCode: i.internCode, fullName: i.fullName, department: i.departmentId ? n.dept.get(i.departmentId) ?? null : null,
          startDate: ymdOf(i.startDate), lastDay: ymdOf(lastDayOf(i)), workingDays: workingDaysOf(i), status: i.status,
          days: Object.fromEntries(mine.map((a) => [ymdOf(a.date)!, { status: a.status, checkIn: a.checkIn, checkOut: a.checkOut, note: a.note, source: a.source }])),
          summary,
        }
      }),
    }
  })

  fastify.post(`${I}/attendance/bulk`, staff, async (req) => {
    await assertInternHr(req)
    const b = z.object({
      internIds: z.array(z.string().min(1).max(64)).min(1).max(500), from: ymd, to: ymd, status: z.enum(ATTENDANCE_STATUSES),
      checkIn: HHMM.nullish(), checkOut: HHMM.nullish(), note: z.string().trim().max(300).nullish(), overwrite: z.boolean().default(false),
    }).strict().parse(req.body)
    const from = parseYmd(b.from, 'from date'), to = parseYmd(b.to, 'to date')
    if (to < from) throw new AppError('BAD_RANGE', 'The end date is before the start date', 422)
    const nDays = Math.round((to.getTime() - from.getTime()) / DAY_MS) + 1
    if (nDays > 62) throw new AppError('RANGE_TOO_LONG', 'Mark at most 62 days at a time', 422)
    if (nDays * b.internIds.length > 3000) throw new AppError('TOO_MANY_DAYS', 'At most 3,000 intern-days at a time', 422)
    const ids = [...new Set(b.internIds)]
    const interns = await prisma.intern.findMany({ where: { id: { in: ids }, tenantId: { in: memberTenants(req) } } })
    if (interns.length !== ids.length) throw new NotFoundError('Intern', ids.find((id) => !interns.some((i) => i.id === id)))
    const today = pktToday()
    const existing = await prisma.internAttendance.findMany({ where: { internId: { in: ids }, date: { gte: from, lte: to } } })
    const has = new Map(existing.map((e) => [`${e.internId}:${ymdOf(e.date)}`, e]))
    const lockedMonths = new Set((await prisma.internStipendSlip.findMany({
      where: { internId: { in: ids }, run: { status: { not: 'draft' } } }, select: { internId: true, run: { select: { period: true, tenantId: true } } },
    })).map((s) => `${s.internId}:${s.run.period}`))
    let created = 0, updated = 0
    const skipped: Array<{ internId: string; date: string; reason: string }> = []
    const data = { status: b.status, checkIn: b.checkIn ?? null, checkOut: b.checkOut ?? null, note: b.note ?? null, source: 'hr', markedById: req.staffUser!.id }
    await prisma.$transaction(async (tx) => {
      for (const i of interns) {
        const working = workingDaysOf(i)
        for (let t = from.getTime(); t <= to.getTime(); t += DAY_MS) {
          const day = new Date(t), date = day.toISOString().slice(0, 10)
          const skip = (reason: string) => skipped.push({ internId: i.id, date, reason })
          if (!(ENROLLED as string[]).includes(i.status)) { skip('NOT_ENROLLED'); continue }
          if (day > today) { skip('FUTURE'); continue }
          if (!withinInternship(i, day)) { skip('OUTSIDE_INTERNSHIP'); continue }
          if (b.status !== 'weekly_off' && !working.includes(day.getUTCDay())) { skip('NOT_A_WORKING_DAY'); continue }
          if (lockedMonths.has(`${i.id}:${periodOf(day)}`)) { skip('IN_PAYROLL'); continue }
          const prev = has.get(`${i.id}:${date}`)
          if (prev && !b.overwrite) { skip('ALREADY_MARKED'); continue }
          if (prev) { await tx.internAttendance.update({ where: { id: prev.id }, data }); updated++ } else { await tx.internAttendance.create({ data: { tenantId: i.tenantId, internId: i.id, date: day, ...data } }); created++ }
        }
      }
    }, { timeout: 120_000 })
    for (const t of new Set(interns.map((i) => i.tenantId))) {
      await audit({
        category: 'identity', action: 'hr.intern.attendance_bulk', entity: 'InternAttendance', userId: req.staffUser!.id, userEmail: req.staffUser!.email ?? null, tenantId: t,
        after: { internIds: interns.filter((i) => i.tenantId === t).map((i) => i.id), from: b.from, to: b.to, status: b.status, overwrite: b.overwrite, created, updated, skipped: skipped.length }, metadata: { actorRole: req.staffUser!.role },
      })
    }
    return { created, updated, skipped }
  })

  fastify.put<{ Params: { id: string; date: string } }>(`${I}/:id/attendance/:date`, staff, async (req) => {
    await assertInternHr(req)
    const b = dayBody.parse(req.body)
    const i = await internInScope(req, req.params.id)
    return setDay(req, i, req.params.date, b, 'hr')
  })

  // ── Certificates ──────────────────────────────────────────────────────────
  fastify.get<{ Params: { id: string } }>(`${I}/:id/certificates`, staff, async (req) => {
    await assertInternHr(req)
    const i = await internInScope(req, req.params.id)
    const items = await prisma.internCertificate.findMany({ where: { internId: i.id }, orderBy: { createdAt: 'desc' } })
    const status = items.find((c) => !c.supersededAt)?.status ?? 'not_issued'
    return { certificateStatus: status, certificateStatusLabel: CERT_LABEL[status], items }
  })

  fastify.post<{ Params: { id: string } }>(`${I}/:id/certificates`, staff, async (req, reply) => {
    await assertInternHr(req)
    const b = z.object({ remarks: z.string().trim().max(600).optional() }).strict().parse(req.body ?? {})
    const i = await internInScope(req, req.params.id)
    if (i.status !== 'completed') throw new AppError('INTERN_NOT_COMPLETED', 'A certificate is generated only for a completed internship', 409)
    const cert = await prisma.$transaction(async (tx) => {
      const year = pktToday().getUTCFullYear()
      const number = await nextCertificateNumber(tx, i.tenantId, year)
      const live = await tx.internCertificate.findFirst({ where: { internId: i.id, supersededAt: null }, select: { number: true } })
      if (live) throw new AppError('CERTIFICATE_EXISTS', `Certificate ${live.number} already exists — re-issue it with a reason instead`, 409)
      const c = await tx.internCertificate.create({ data: { tenantId: i.tenantId, internId: i.id, number, status: 'generated', remarks: b.remarks ?? i.performanceRemarks ?? null, generatedById: req.staffUser!.id } })
      await logInternEvent(tx, i, 'certificate_generated', { actorId: req.staffUser!.id, after: { number } })
      return c
    })
    await audit({ category: 'identity', action: 'hr.intern_certificate.generate', entity: 'InternCertificate', entityId: cert.id, userId: req.staffUser!.id, userEmail: req.staffUser!.email ?? null, tenantId: i.tenantId, after: { number: cert.number, internId: i.id }, metadata: { actorRole: req.staffUser!.role } })
    return reply.status(201).send(cert)
  })

  fastify.post<{ Params: { certId: string } }>(`${I}/certificates/:certId/issue`, staff, async (req) => {
    await assertInternHr(req)
    const c = await certificateInScope(req, req.params.certId)
    const n = await prisma.internCertificate.updateMany({ where: { id: c.id, status: 'generated', supersededAt: null }, data: { status: 'issued', issuedById: req.staffUser!.id, issuedAt: new Date() } })
    if (n.count === 0) throw new AppError('NOT_GENERATED', 'Only a generated (not yet issued) certificate can be issued', 409)
    await logInternEvent(prisma, c.intern, 'certificate_issued', { actorId: req.staffUser!.id, after: { number: c.number } })
    await audit({ category: 'identity', action: 'hr.intern_certificate.issue', entity: 'InternCertificate', entityId: c.id, userId: req.staffUser!.id, userEmail: req.staffUser!.email ?? null, tenantId: c.tenantId, after: { number: c.number }, metadata: { actorRole: req.staffUser!.role } })
    return prisma.internCertificate.findUnique({ where: { id: c.id } })
  })

  fastify.post<{ Params: { id: string } }>(`${I}/:id/certificates/reissue`, staff, async (req, reply) => {
    await assertInternHr(req)
    const b = z.object({ reason: z.string().trim().min(10, 'Give a reason of at least 10 characters').max(500), remarks: z.string().trim().max(600).optional() }).strict().parse(req.body)
    const i = await internInScope(req, req.params.id)
    if (i.status !== 'completed') throw new AppError('INTERN_NOT_COMPLETED', 'A certificate is issued only for a completed internship', 409)
    const cert = await prisma.$transaction(async (tx) => {
      const live = await tx.internCertificate.findFirst({ where: { internId: i.id, supersededAt: null } })
      if (!live) throw new AppError('NO_CERTIFICATE', 'There is no certificate to re-issue — generate one', 409)
      const number = await nextCertificateNumber(tx, i.tenantId, pktToday().getUTCFullYear())
      const now = new Date()
      const n = await tx.internCertificate.updateMany({ where: { id: live.id, supersededAt: null }, data: { supersededAt: now, supersededById: req.staffUser!.id } })
      if (n.count === 0) throw new AppError('CERTIFICATE_CHANGED', 'The certificate changed meanwhile — reload it', 409)
      const c = await tx.internCertificate.create({
        data: { tenantId: i.tenantId, internId: i.id, number, status: 'reissued', remarks: b.remarks ?? live.remarks, generatedById: req.staffUser!.id, issuedById: req.staffUser!.id, issuedAt: now, reissueOfId: live.id, reissueReason: b.reason },
      })
      await logInternEvent(tx, i, 'certificate_reissued', { actorId: req.staffUser!.id, note: b.reason, before: { number: live.number }, after: { number } })
      return c
    })
    await audit({ category: 'identity', action: 'hr.intern_certificate.reissue', entity: 'InternCertificate', entityId: cert.id, userId: req.staffUser!.id, userEmail: req.staffUser!.email ?? null, tenantId: i.tenantId, after: { number: cert.number, reissueOfId: cert.reissueOfId, reason: b.reason }, metadata: { actorRole: req.staffUser!.role } })
    return reply.status(201).send(cert)
  })

  fastify.get<{ Params: { certId: string }; Querystring: { download?: string } }>(`${I}/certificates/:certId/pdf`, staff, async (req, reply) => {
    await assertInternHr(req)
    const c = await certificateInScope(req, req.params.certId)
    const i = c.intern
    const [company, dept, signer] = await Promise.all([
      prisma.tenant.findUnique({ where: { id: c.tenantId }, select: { name: true } }),
      i.departmentId ? prisma.department.findUnique({ where: { id: i.departmentId }, select: { name: true } }) : null,
      prisma.user.findUnique({ where: { id: c.issuedById ?? c.generatedById ?? '' }, select: { name: true } }),
    ])
    const end = lastDayOf(i) ?? pktToday()
    const pdf = await certificatePdf({
      companyName: company?.name ?? '', number: c.number, issueDate: c.issuedAt ?? c.createdAt,
      intern: { fullName: i.fullName, internCode: i.internCode, department: dept?.name ?? null, designation: i.designation, startDate: i.startDate, endDate: end },
      duration: durationText(i.startDate, end), remarks: c.remarks, signatoryName: signer?.name ?? null, reissued: c.status === 'reissued',
    })
    return sendPdf(reply, pdf, `certificate-${c.number}.pdf`, req.query.download === '1')
  })

  // ── Reports & dashboard ───────────────────────────────────────────────────
  fastify.get<{ Params: { key: string }; Querystring: Record<string, string> }>(`${I}/reports/:key`, staff, async (req, reply) => {
    await assertInternHr(req)
    if (!(REPORT_KEYS as readonly string[]).includes(req.params.key)) throw new NotFoundError('Report', req.params.key)
    const key = req.params.key as ReportKey
    const t = await buildInternReport(req, key, req.query)
    const format = exportFormatOf(req.query['format'])
    if (!format) return { key, ...t }
    return sendReportFor(req, reply, format, { base: `interns-${key.replace(/_/g, '-')}`, suffix: t.period?.replace(/\s+/g, '') }, {
      title: t.title, period: t.period, columns: t.columns, rows: t.rows, sectionKey: t.sectionKey,
      isTotal: (r) => r['department'] === 'TOTAL',
    })
  })

  fastify.get<{ Querystring: { month?: string } }>(`${I}/dashboard`, staff, async (req) => {
    await assertInternHr(req)
    const tenants = viewTenants(req)
    const month = req.query.month && zMonth.safeParse(req.query.month).success ? req.query.month : periodOf(pktToday())
    const all = await prisma.intern.findMany({ where: { tenantId: { in: tenants } } })
    const n = await namesFor(all)
    const byStatus = Object.fromEntries(INTERN_STATUSES.map((s) => [s, all.filter((i) => i.status === s).length]))
    const live = all.filter((i) => i.status === 'active')
    const byDept = new Map<string, { departmentId: string | null; name: string; count: number }>()
    for (const i of live) {
      const k = i.departmentId ?? 'none'
      const e = byDept.get(k) ?? { departmentId: i.departmentId, name: i.departmentId ? n.dept.get(i.departmentId) ?? 'Unknown' : 'No department', count: 0 }
      e.count++; byDept.set(k, e)
    }
    const runs = await prisma.internPayrollRun.findMany({ where: { tenantId: { in: tenants }, period: month } })
    const net = runs.reduce((t, r) => t + Number(((r.totals ?? {}) as Record<string, unknown>)['netCents'] ?? 0), 0)
    const certs = await prisma.internCertificate.findMany({ where: { tenantId: { in: tenants }, supersededAt: null, status: { in: ['issued', 'reissued'] } }, select: { issuedAt: true } })
    const soon = new Date(pktToday().getTime() + 14 * DAY_MS)
    return {
      month, total: all.length, byStatus, statusLabels: INTERN_STATUS_LABEL,
      active: live.length, paid: live.filter((i) => i.internshipType === 'paid').length, unpaid: live.filter((i) => i.internshipType === 'unpaid').length,
      byDepartment: [...byDept.values()].sort((a, b) => b.count - a.count),
      stipend: { period: month, runs: runs.map((r) => ({ id: r.id, tenantId: r.tenantId, status: r.status })), runStatus: runs.length === 1 ? runs[0]!.status : runs.length ? 'mixed' : 'none', netCents: net },
      certificatesIssued: certs.length,
      certificatesIssuedThisMonth: certs.filter((c) => c.issuedAt && periodOf(c.issuedAt) === month).length,
      pendingApproval: byStatus['pending_approval'] ?? 0,
      endingSoon: live.filter((i) => i.endDate && i.endDate <= soon).map((i) => ({ id: i.id, internCode: i.internCode, fullName: i.fullName, endDate: ymdOf(i.endDate) })),
    }
  })

  // ── Supervisor (self-service) ─────────────────────────────────────────────
  const supervisorRow = (i: Intern, nm: Awaited<ReturnType<typeof namesFor>>) => ({
    id: i.id, tenantId: i.tenantId, internCode: i.internCode, fullName: i.fullName, department: i.departmentId ? nm.dept.get(i.departmentId) ?? null : null,
    designation: i.designation, institution: i.institution, startDate: i.startDate, endDate: i.endDate, lastDay: ymdOf(lastDayOf(i)), status: i.status,
    statusLabel: INTERN_STATUS_LABEL[i.status as keyof typeof INTERN_STATUS_LABEL] ?? i.status, internshipType: i.internshipType,
    workingDays: workingDaysOf(i), workingHours: i.workingHours, performanceRemarks: i.performanceRemarks, phone: i.phone, email: i.email,
  })
  fastify.get('/my-interns', staff, async (req) => {
    const mine = await ownEmployeeIds(req)
    const rows = mine.length ? await prisma.intern.findMany({ where: { supervisorEmployeeId: { in: mine }, status: { in: ['active', 'completed', 'terminated'] } }, orderBy: [{ status: 'asc' }, { internCode: 'asc' }] }) : []
    const nm = await namesFor(rows)
    return { items: rows.map((r) => supervisorRow(r, nm)) }
  })
  fastify.get<{ Params: { id: string }; Querystring: { month?: string } }>('/my-interns/:id', staff, async (req) => {
    const i = await supervisedIntern(req, req.params.id)
    const month = req.query.month && zMonth.safeParse(req.query.month).success ? req.query.month : periodOf(pktToday())
    return { intern: supervisorRow(i, await namesFor([i])), attendance: await attendanceSummary(i.id, month) }
  })
  fastify.put<{ Params: { id: string; date: string } }>('/my-interns/:id/attendance/:date', staff, async (req) => {
    const b = dayBody.parse(req.body)
    const i = await supervisedIntern(req, req.params.id)
    return setDay(req, i, req.params.date, b, 'supervisor')
  })
  fastify.put<{ Params: { id: string } }>('/my-interns/:id/remarks', staff, async (req) => {
    const { performanceRemarks } = z.object({ performanceRemarks: z.string().trim().max(2000) }).strict().parse(req.body)
    const i = await supervisedIntern(req, req.params.id)
    await prisma.$transaction(async (tx) => {
      await tx.intern.update({ where: { id: i.id }, data: { performanceRemarks: performanceRemarks || null } })
      await logInternEvent(tx, i, 'remarks', { actorId: req.staffUser!.id, note: performanceRemarks || null })
    })
    await auditIntern(req, i, 'remarks', { before: { performanceRemarks: i.performanceRemarks }, after: { performanceRemarks } })
    return supervisorRow(await prisma.intern.findUniqueOrThrow({ where: { id: i.id } }), await namesFor([i]))
  })

  await internPayrollRoutes(fastify)
}

function sendPdf(reply: FastifyReply, buf: Buffer, name: string, download: boolean) {
  reply.header('Content-Type', 'application/pdf')
  reply.header('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${name}"`)
  return reply.send(buf)
}

export { certificateStatusOf }
