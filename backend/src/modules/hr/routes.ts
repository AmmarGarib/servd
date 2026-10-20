// /hr — the HR module API.
//
// Access. HR data is the most sensitive in the system: salaries, CNICs, family
// details, disciplinary cases. The admin surfaces are for HR_ADMIN only (CEO,
// co-owner, exec, HR). Everyone else reaches HR through two narrow doors:
//   /hr/me         their own record, payslips and requests (self-service)
//   /hr/approvals  requests waiting on THEM, as a reporting manager
// Neither can read anyone else's salary.

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { classificationOf, classifyPaymentTx, classificationsOfReferences, type ClassificationInput } from '../accounting/paymentsRegister.js'
import type { Prisma, UserRole, HrEmployee, HrRecord } from '@prisma/client'
import { z } from 'zod'
import { serviceClient as prisma } from '../../lib/prisma.js'
import { requireAuth, ALL_STAFF, MANAGERS } from '../auth/middleware.js'
import { AppError, NotFoundError, ForbiddenError } from '../../lib/errors.js'
import { activeTenantId } from '../../lib/tenantScope.js'
import { normalisePhone } from '../auth/otp.js'
import { csv } from '../accounting/csv.js'
import { exportFormatOf, fromMatrix, sendReportFor, type ReportColumnType, type ReportRow } from '../../lib/reportExport.js'
import { audit } from '../../lib/audit.js'
import { moveToTrash, trashReasonOf } from '../../lib/trash.js'
import { takeSnapshot } from '../trash/snapshot.js'
import { assertInt4Fits } from '../../lib/money.js'
import {
  HR_SECTIONS, RECORD_SECTIONS, ESS_SECTIONS, sectionByKey, validateAgainst, checkFormat, withSystemFields, ORG_UNIT_KINDS, DOCUMENT_TYPES,
  EMPLOYEE_COLUMN_TYPES, negativeMoney, parseHrDate, BANK_ACCOUNT_REF, transferTargetsOutsideCompany, REPORTS_TO_CEO, type HrField, type HrSection, type WorkflowStep, type RecordSlot,
} from './forms.js'
import {
  getSettings, saveSettings, getFormat, getAllFormats, defaultFormat, employeeLabels, employeeLabelsAcross,
  applyDueEffects, onFinalApproval, leaveBalancesFor, checkLeave, lockEmployeeLeave, loansFor, loanStatement, settlementLoansOf,
  calculateRun, recalcPayslip, dashboard, dueList, letterContext, payableEmployees, managerUserIdOfEmployee, teamUnder, companyCeo, managerLabelOf,
  salaryForPeriod, unpaidOvertime, firstPayrollStart, runBlocker, settlementAttendance, STANDING_ATTENDANCE, ALL_RUN_STATUSES, type TeamMember,
} from './service.js'
import {
  mergeSettings, decideRight, mayReachForDecision, finalSettlement, gratuityFor, accruedLeaveDays, nextEmployeeCode, periodOf, periodStart, periodEnd, pktToday,
  nextPeriod, settlementParts, settlementNet,
  type ApprovalEntry, type HrSettings,
} from './logic.js'
import { DEFAULT_LETTERS, renderLetter, placeholdersIn, sanitizeLetterHtml, withLetterSystemRows } from './letters.js'
import { CASH_REQUEST_PAID_FROM } from './advanceLoan.js'
import { REPORTS, buildReport, reportXlsx, resolver, type ReportQuery } from './reports.js'
import {
  postPayrollAccrual, postPayrollPayment, postLoanDisbursement, postFinalSettlementAccrual, postFinalSettlementPayment,
  lockSettlement, FNF_ACCRUAL, FNF_PAYMENT, type PayrollPayFrom,
} from './ledger.js'
import { reverseJournalEntry } from '../accounting/journal.js'
import { applyAttendanceCorrection, flagMissingPunches } from './attendance.js'
import { approvedLeaveOn, leaveSpan, isHalfDayLeave, OFF_MARK, ymd as rotaYmd } from './rota.js'
import { hasKioskPin, setKioskPin, clearKioskPin } from './kioskPin.js'
import { loginsToDeactivate, deactivateLeftLogins } from './separations.js'
import { accountStateOf } from '../auth/accountStatus.js'
import { TRANSFERRED_STATUS } from './transfer.js'
import { requireModule } from '../notifications/requireModule.js'
import { effectiveModulesForUser } from '../../lib/moduleAccess.js'
import { assertHoMayPropose, isHeadOfficeTenant, isReachOnly, viaHeadOfficeForSubmit } from '../../lib/headOffice.js'
import {
  approvalSubject as approvalSubjectOf, approvalInputOf, assertCanApprove, auditApproval, delegatedTenantsByType,
  throughHeadOfficeBatch, type ApprovalGrant,
} from '../../lib/approvalRights.js'
import { approvalWaiting } from '../approvals/notify.js'
import { headOfficeSetupApplied } from '../headOffices/books.js'
import { workLocationRoutes, syncPrimaryWorkLocation } from './workLocations.js'
import { attendanceTrackingRoutes } from './attendanceTracking.js'

export const HR_ADMIN = ['admin', 'owner', 'management', 'hr'] as UserRole[]
/** The HR back office under /hr/records (audit PPL-R2-01). lib/moduleAccess.ts
 *  cannot gate that prefix — self-service and HOD steps share it — so the
 *  admin handlers carry the module check themselves: the CEO's Module Access
 *  untick of 'staff_hr' really closes the record lists, exports and edits. */
const HR_BACK_OFFICE = [requireAuth(...HR_ADMIN), requireModule('staff_hr')]
/** Who may see which logins are linked to which employee (names, designation
 *  and status — never pay): HR and the managers who run Workforce. */
const PEOPLE_READERS = Array.from(new Set([...HR_ADMIN, ...MANAGERS])) as UserRole[]
const PAYROLL_APPROVERS = ['admin', 'owner', 'management'] as UserRole[]
/** Who may MARK PAID a locked payroll run or an approved full & final, and
 *  book approved settlements that never reached the books (owner, 2026-10-16:
 *  finance pays): the approvers plus finance — finance with its 'accounting'
 *  module. Approving, locking and reopening stay with PAYROLL_APPROVERS.
 *  Nobody marks paid a run (or a settlement) that carries their own pay
 *  (403 OWN_PAY_IN_RUN). */
const PAYROLL_PAYERS = [...PAYROLL_APPROVERS, 'finance'] as UserRole[]
const financeNeedsAccounting = async (req: FastifyRequest) => {
  if (req.staffUser?.role === 'finance') await requireModule('accounting')(req)
}
const PAYROLL_PAYER_GUARD = [requireAuth(...PAYROLL_PAYERS), financeNeedsAccounting]
/** Who may READ the payroll register (runs, payslips, the bank file): HR,
 *  and finance, who pay it and reconcile Wages Payable (audit BOOKS-02).
 *  Narrowed by module: /hr/payroll needs staff_hr or payroll. Preparing
 *  and approving stay with HR_ADMIN / PAYROLL_APPROVERS; paying is
 *  PAYROLL_PAYERS (finance included). */
const PAYROLL_READERS = [...HR_ADMIN, 'finance'] as UserRole[]
/** Who may edit the Employee Master record linked to their own login. */
const SELF_EDITORS = ['admin', 'owner'] as UserRole[]

/** Values only logic or an approver writes. Never taken from a create or an
 *  edit, whatever the format says: approved OT hours come from /decide, the
 *  rate and amount from final approval. */
const SERVER_OWNED: Record<string, string[]> = { overtime: ['approvedHours', 'otRate', 'otAmount'] }
/** Values on a self-service request that drive pay and are HR's to set, not
 *  the employee's. Hidden from the self-service form and dropped on the way in. */
const ESS_HIDDEN: Record<string, string[]> = { overtime: ['multiplier'], loan: ['paidFrom', 'bankAccount'] }

type Tx = Prisma.TransactionClient

// ─── helpers ────────────────────────────────────────────────────────────────

const activeTenant = (req: FastifyRequest): string => activeTenantId(req, 'HR records belong to one company')
/** Companies this operator can read HR for. Portfolio view spans all of them,
 *  minus every test company (the active one only when nothing else is left):
 *  on a portfolio GET the auth
 *  middleware's `tenantFilter` is already that set (lib/testCompany.ts), so it
 *  is the source here; anything else falls back to every member company. */
function readTenants(req: FastifyRequest): string[] {
  const su = req.staffUser!
  const wantsAll = req.headers['x-servd-portfolio'] === '1'
  if (wantsAll && su.memberTenantIds.length) {
    // Head office (D1): a portfolio read also spans the companies reached
    // through a head office (read only; empty unless a live link exists).
    const seen = new Set([...su.memberTenantIds, ...(su.reachTenantIds ?? [])])
    const f = su.tenantFilter
    if (f && typeof f === 'object' && 'in' in f) return f.in.filter((id) => seen.has(id))
    return su.memberTenantIds
  }
  return su.tenantId ? [su.tenantId] : []
}
const inTenants = (req: FastifyRequest) => ({ tenantId: { in: readTenants(req) } })
/** The company a picker list or a format is read for. ?tenantId= asks for a
 *  particular one — an employee of another company opened in portfolio view,
 *  or a self-service form, which belongs to the employee's own company — and
 *  is honoured only for a company the caller belongs to, or the one their own
 *  employee record is in. Otherwise the active company. */
async function pickerTenant(req: FastifyRequest): Promise<string> {
  const want = (req.query as { tenantId?: string } | undefined)?.tenantId
  if (!want) return activeTenant(req)
  if (req.staffUser!.memberTenantIds.includes(want)) return want
  const own = await prisma.hrEmployee.findFirst({ where: { userId: req.staffUser!.id, tenantId: want }, select: { id: true } })
  if (own) return want
  throw new ForbiddenError('You do not belong to that company')
}
/** Companies a write may touch: every member company, plus — on a
 *  head-office submit route through the lens (HO_SUBMIT_ROUTES) — the lens
 *  company, where each route then allows only a proposal (assertHoMayPropose). */
const writeTenants = (req: FastifyRequest) => {
  const su = req.staffUser!
  const ids = su.memberTenantIds.length ? [...su.memberTenantIds] : [activeTenant(req)]
  if (su.submitTenantId && !ids.includes(su.submitTenantId)) ids.push(su.submitTenantId)
  return { tenantId: { in: ids } }
}

/** Head office (D1, A3): the head office this proposal goes through, stamped
 *  on the record / run as viaHeadOfficeId — null for everyone else. */
const viaFor = (req: FastifyRequest, tenantId: string) => viaHeadOfficeForSubmit(req, tenantId)

/** Nobody has acted on this record yet: still a draft or waiting at its first
 *  step with no decision recorded. */
const notActedOn = (rec: Pick<HrRecord, 'status' | 'approvals'>) =>
  (rec.status === 'draft' || rec.status === 'submitted') && (rec.approvals as unknown as ApprovalEntry[]).length === 0

/** Through the head-office lens a caller may only touch their OWN record that
 *  nobody has acted on (D1 §6.4). No-op for members of the company. */
async function assertLensOwnRecord(req: FastifyRequest, rec: Pick<HrRecord, 'tenantId' | 'createdById' | 'status' | 'approvals'>, what: string) {
  if (!isReachOnly(req, rec.tenantId)) return
  await assertHoMayPropose(req, rec.tenantId, rec.createdById === req.staffUser!.id && notActedOn(rec), what)
}

/** A payroll step through head office stamps the run (A3), so its approval
 *  goes to the CEO or a hand-over — never to a company approver. */
async function stampRunVia(req: FastifyRequest, run: { id: string; tenantId: string; viaHeadOfficeId: string | null }) {
  if (run.viaHeadOfficeId) return
  const via = await viaFor(req, run.tenantId)
  if (via) await prisma.hrPayrollRun.updateMany({ where: { id: run.id, viaHeadOfficeId: null, status: 'draft' }, data: { viaHeadOfficeId: via } })
}

/**
 * Payroll approve / lock / reopen (D3 §7.3, A5, A14, A19). The run is found by
 * id on its own (serviceClient), then the approval rights decide: the role path
 * (admin, owner, management of the run's company — and, for a non-CEO, not a
 * run prepared through head office) or a live HR hand-over covering it.
 * Anyone who cannot see the company gets 404, a member without the right 403.
 * `preparer` runs the route's own separation-of-duties rule first (approve).
 *
 * OWN_PAY_IN_RUN (A14, v1): on the hand-over path, and on any run of a head
 * office, a non-CEO whose own payslip is on the run may not decide it — the
 * head office's own payroll goes to the CEO. A company approver deciding
 * their company's run is unchanged (owner question before widening it).
 */
async function payrollDecision(
  req: FastifyRequest, id: string, action: 'approve' | 'lock' | 'reopen',
  preparer?: (run: { createdById: string | null; preparedByIds: string[] }) => void,
) {
  const subj = await approvalSubjectOf('payroll_run', id)
  if (!subj) throw new NotFoundError('Payroll', id)
  const found = await prisma.hrPayrollRun.findUnique({ where: { id } })
  if (!found) throw new NotFoundError('Payroll', id)
  const su = req.staffUser!
  const sees = su.memberTenantIds.includes(found.tenantId) || (su.reachTenantIds ?? []).includes(found.tenantId)
    || !!(await delegatedTenantsByType(su.id)).get('payroll_run')?.has(found.tenantId)
  if (!sees) throw new NotFoundError('Payroll', id)
  preparer?.(found)
  // Lock and reopen keep today's rule (no preparer check); the run's
  // head-office stamp still routes an HOD-prepared run away from company
  // approvers. Approve also names every preparer.
  const grant = await assertCanApprove(req, approvalInputOf('payroll_run', id, subj, {
    entity: 'HrPayrollRun', action: `${action} a payroll`,
    ...(action === 'approve' ? {} : { submittedByIds: [] }),
  }))
  if (su.role !== 'admin' && (grant.via === 'delegation' || (await isHeadOfficeTenant(found.tenantId)))) {
    const mine = await prisma.hrPayslip.count({ where: { runId: id, employee: { userId: su.id } } })
    if (mine > 0) {
      throw new AppError('OWN_PAY_IN_RUN', 'Your own pay is on this payroll — the CEO decides it', 403)
    }
  }
  return { run: found, grant }
}

/** approval.decide for every payroll decision (payroll_run is delegable,
 *  spec §7.8) — in the run's company (A19). */
async function auditPayrollDecision(req: FastifyRequest, run: { id: string; tenantId: string; period: string; viaHeadOfficeId: string | null }, grant: ApprovalGrant, decision: string) {
  await auditApproval(req, {
    type: 'payroll_run', id: run.id, tenantId: run.tenantId, decision, grant, entity: 'HrPayrollRun',
    metadata: { period: run.period, ...(run.viaHeadOfficeId && { viaHeadOfficeId: run.viaHeadOfficeId }) },
  })
}

/**
 * Department.isHeadOffice is retired once a head office is set up (spec §8:
 * "head office" is then a kind of company, not a department flag). Until the
 * setup wizard has run (headOfficeSetupApplied) it is kept exactly as today;
 * after it, writes ignore it and responses leave it out.
 */
function withoutRetiredFlag<T extends { isHeadOffice?: boolean }>(row: T, retired: boolean): T | Omit<T, 'isHeadOffice'> {
  if (!retired) return row
  const { isHeadOffice: _gone, ...rest } = row
  return rest
}

/** A16: refuse a transfer that names another company's department or manager. */
async function assertTransferInCompany(db: Tx | typeof prisma, section: string, tenantId: string, data: Record<string, unknown>) {
  if (section !== 'transfer') return
  const bad = await transferTargetsOutsideCompany(db, tenantId, data)
  if (bad.length) {
    throw new AppError('TRANSFER_OTHER_COMPANY', `${bad.map((b) => b.label).join(' and ')}: must be in this company — moving someone to another company is "Move to head office" (CEO)`, 422)
  }
}

/** The caller's own employee record. One login may be an employee in each
 *  company (decision 31): the active company's record wins, else the one
 *  they are employed in now, else any. */
async function ownEmployee(req: FastifyRequest): Promise<HrEmployee | null> {
  const mine = await prisma.hrEmployee.findMany({ where: { userId: req.staffUser!.id }, orderBy: { createdAt: 'asc' } })
  if (mine.length <= 1) return mine[0] ?? null
  return mine.find((e) => e.tenantId === req.staffUser!.tenantId)
    ?? mine.find((e) => ['active', 'on_leave'].includes(e.status))
    ?? mine[0]!
}

/** A day's attendance category, reduced to the five states /hr/team shows. */
function todayStatusOf(category: string | null | undefined): 'present' | 'late' | 'absent' | 'off' | null {
  switch (category) {
    case 'present': case 'early_departure': case 'half_day': case 'missing_punch': return 'present'
    case 'late': return 'late'
    case 'absent': return 'absent'
    case 'off_day': case 'holiday': return 'off'
    default: return null
  }
}

/** Does the caller hold the HR back-office module ('staff_hr')? The CEO always
 *  does. Same source of truth as the central gate (role override ?? default,
 *  + moduleAllow − moduleDeny). */
async function holdsStaffHr(req: FastifyRequest): Promise<boolean> {
  const su = req.staffUser!
  if (su.role === 'admin') return true
  const u = await prisma.user.findUnique({ where: { id: su.id }, select: { moduleAllow: true, moduleDeny: true } })
  const modules = await effectiveModulesForUser({ role: su.role as UserRole, moduleAllow: u?.moduleAllow ?? [], moduleDeny: u?.moduleDeny ?? [] })
  return modules.has('staff_hr')
}

/** HR back-office powers on a record (cancel anyone's, submit anyone's
 *  draft): an HR_ADMIN role that still holds 'staff_hr'. Without the module
 *  they act on their own requests like everyone else (PPL-R2-01). */
async function hrBackOffice(req: FastifyRequest): Promise<boolean> {
  return HR_ADMIN.includes(req.staffUser!.role) && holdsStaffHr(req)
}

/** Deciding this step is the HR back office at work — an 'hr' step, or an HOD
 *  step HR takes because the employee has no manager with a login — rather
 *  than a reporting manager's own call. Such a decision needs 'staff_hr'
 *  (PPL-R2-01); a real HOD's step and a management step never do. */
function stepIsHrWork(stepRole: WorkflowStep['role'], actor: { id: string; role: string }, managerUserId: string | null): boolean {
  if (actor.role === 'admin') return false
  if (stepRole === 'hr') return true
  if (stepRole === 'hod') return !(managerUserId && managerUserId === actor.id)
  return false
}

/** Canonical phone key (auth/otp normalisePhone — 0300…, +92300… and 92300… all agree); null when too short to match on. */
const phoneKey = (p: string | null | undefined) => {
  const n = normalisePhone(p ?? '')
  return n.length >= 10 ? n : null
}

function recordSection(key: string) {
  const sec = sectionByKey(key)
  if (!sec || sec.kind !== 'record') throw new AppError('UNKNOWN_SECTION', `No HR record section "${key}"`, 404)
  return sec
}

/** 409 SECTION_MOVED for a section whose work is done elsewhere now. */
function sectionMoved(sec: HrSection): AppError {
  return new AppError('SECTION_MOVED', sec.movedTo?.message ?? `${sec.title} is no longer recorded in HR`, 409, { path: sec.movedTo?.path ?? null })
}

/** An HR staff advance moved from an unsettled cash request (advanceLoan.ts). */
const fromCashRequest = (rec: Pick<HrRecord, 'section' | 'data'>) =>
  rec.section === 'loan' && ((rec.data ?? {}) as Record<string, unknown>)['paidFrom'] === CASH_REQUEST_PAID_FROM

const EMP_DATE_COLS = ['cnicExpiry', 'dateOfBirth', 'joiningDate', 'probationEnd', 'confirmationDate', 'contractEnd', 'lastWorkingDay']
const EMP_INT_COLS = ['noticePeriodDays', 'basicSalaryCents', 'grossSalaryCents', 'monthlyTaxCents']
const EMP_COLS = new Set([
  'employeeCode', 'fullName', 'fatherHusbandName', 'cnic', 'gender', 'phone', 'personalEmail',
  'departmentId', 'designationId', 'gradeId', 'locationId', 'managerId', 'employmentType', 'status',
  'paymentMethod', 'bankName', 'iban', 'eobiNo', 'sessiNo', 'ntn', 'photoUrl', ...EMP_DATE_COLS, ...EMP_INT_COLS,
])

// Columns that always hold a value. A blank field must fall back to the
// column's default on create and leave it alone on edit — never write null.
const EMP_NOT_NULL = new Set(['employeeCode', 'fullName', 'employmentType', 'status', 'basicSalaryCents', 'grossSalaryCents', 'monthlyTaxCents'])

function toEmployeeColumns(bound: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(bound)) {
    if (!EMP_COLS.has(k)) continue
    if (EMP_NOT_NULL.has(k) && (v === null || v === undefined || v === '')) continue
    if (EMP_DATE_COLS.includes(k)) out[k] = v ? new Date(String(v)) : null
    else if (EMP_INT_COLS.includes(k)) out[k] = v == null ? (k.endsWith('Cents') ? 0 : null) : Math.round(Number(v))
    else out[k] = v ?? null
  }
  return out
}

function slotColumns(slots: Partial<Record<RecordSlot, unknown>>) {
  const d = (v: unknown) => (v ? new Date(String(v)) : null)
  return {
    ...('employeeId' in slots && { employeeId: (slots.employeeId as string) ?? null }),
    ...('startDate' in slots && { startDate: d(slots.startDate) }),
    ...('endDate' in slots && { endDate: d(slots.endDate) }),
    ...('effectiveDate' in slots && { effectiveDate: d(slots.effectiveDate) }),
    ...('quantity' in slots && { quantity: slots.quantity == null ? null : Number(slots.quantity) }),
    ...('amountCents' in slots && { amountCents: slots.amountCents == null ? null : Math.round(Number(slots.amountCents)) }),
    ...('refId' in slots && { refId: (slots.refId as string) ?? null }),
    ...('category' in slots && { category: (slots.category as string) ?? null }),
  }
}

const omitKeys = (o: Record<string, unknown>, keys: string[]) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)))

/** A payment date as the money screens send it — YYYY-MM-DD, the day in
 *  Karachi — default today, never in the future. Stored as that day's UTC
 *  midnight, the way HR keeps every date, so the period lock reads its day. */
function paidOnOf(raw: string | undefined): Date {
  if (!raw) return pktToday()
  const d = /^\d{4}-\d{2}-\d{2}$/.test(raw.trim()) ? parseHrDate(raw) : null
  if (!d) throw new AppError('BAD_DATE', 'The payment date must be a date (YYYY-MM-DD)', 400)
  if (d.getTime() > pktToday().getTime()) throw new AppError('PAID_ON_FUTURE', 'The payment date cannot be in the future', 422)
  return d
}

function formErrors(errors: Array<{ field: string; message: string }>) {
  return new AppError('VALIDATION_ERROR', errors.map((e) => e.message).join('; '), 400)
}

const RECORD_SLOTS = ['employeeId', 'startDate', 'endDate', 'effectiveDate', 'quantity', 'amountCents', 'refId', 'category']

/** Why a format can't be used for a section — empty when it can. Run when one
 *  is saved and again when an older version is made live. */
function formatProblems(sec: HrSection, fields: HrField[], workflow: WorkflowStep[]): string[] {
  const problems: string[] = []
  // Bindings may only point at real slots, and employee bindings only exist
  // on the Employee Master.
  for (const fl of fields) {
    if (!fl.bind) continue
    const ok = sec.key === 'employees' ? fl.bind.startsWith('employee.') && EMP_COLS.has(fl.bind.slice(9)) : RECORD_SLOTS.includes(fl.bind)
    if (!ok) problems.push(`"${fl.label}" is bound to "${fl.bind}", which this section does not have`)
  }
  if (sec.key === 'employees' && !fields.some((f) => f.bind === 'employee.fullName')) problems.push('The Employee Master needs a field bound to the employee name')
  return [...problems, ...checkFormat({ ...sec, fields: sec.key === 'employees' ? [] : sec.fields }, fields, workflow)]
}

type RefKind = 'employee' | 'orgunit' | 'department' | 'location' | 'record' | 'bank_account'

/** What an id-holding field points at. Its type says — or, for a format saved
 *  before a field's type had to match its binding, what it is bound to: an id
 *  column is checked whatever kind of field fills it. */
function refTarget(fl: HrField): { kind: RefKind; ref?: string } | null {
  if (fl.ref === BANK_ACCOUNT_REF && (fl.type === 'text' || fl.type === 'select')) return { kind: 'bank_account' }
  switch (fl.type) {
    case 'employee': case 'employees': return { kind: 'employee' }
    case 'orgunit': case 'department': case 'location': case 'record': return { kind: fl.type, ref: fl.ref }
  }
  if (fl.bind === 'employeeId') return { kind: 'employee' }
  if (fl.bind === 'refId') return { kind: 'record' }
  const col = fl.bind?.startsWith('employee.') ? EMPLOYEE_COLUMN_TYPES[fl.bind.slice('employee.'.length)] : undefined
  const kind = col?.types[0]
  if (kind === 'employee' || kind === 'orgunit' || kind === 'department' || kind === 'location') return { kind, ref: col!.ref }
  return null
}

/** Every id a record's data points at — table cells included — must belong to
 *  the same company. A format is data, so a reference field is not trusted to
 *  point anywhere safe. A foreign id is refused (422). */
async function checkReferences(tenantId: string, fields: HrField[], data: Record<string, unknown>) {
  const wanted: Array<{ fl: HrField; target: { kind: RefKind; ref?: string }; ids: string[] }> = []
  const collect = (fl: HrField, v: unknown) => {
    const target = refTarget(fl)
    if (!target || v == null || v === '') return
    const ids = Array.isArray(v) ? v.map(String) : [String(v)]
    if (ids.length) wanted.push({ fl, target, ids })
  }
  for (const fl of fields) {
    const v = data[fl.key]
    if (fl.type === 'table' && Array.isArray(v)) {
      for (const col of fl.columns ?? []) for (const row of v) collect(col, (row as Record<string, unknown> | null)?.[col.key])
    } else collect(fl, v)
  }
  for (const { fl, target, ids } of wanted) {
    const uniq = Array.from(new Set(ids))
    let n = 0
    switch (target.kind) {
      case 'employee': n = await prisma.hrEmployee.count({ where: { tenantId, id: { in: uniq } } }); break
      case 'orgunit': n = await prisma.hrOrgUnit.count({ where: { tenantId, id: { in: uniq }, ...(target.ref && { kind: target.ref }) } }); break
      case 'department': n = await prisma.department.count({ where: { id: { in: uniq }, OR: [{ tenantId }, { tenantId: null }] } }); break
      case 'location': n = await prisma.location.count({ where: { id: { in: uniq }, tenantId } }); break
      case 'record': n = await prisma.hrRecord.count({ where: { tenantId, id: { in: uniq }, ...(target.ref && { section: target.ref }) } }); break
      // A live bank of the record's company, linked to its chart (the only
      // kind lib/bankAccounts moneyAccountCode will post to).
      case 'bank_account': n = await prisma.bankAccount.count({ where: { tenantId, id: { in: uniq }, deletedAt: null, isActive: true, accountCode: { not: null } } }); break
    }
    if (n !== uniq.length) throw new AppError('BAD_REFERENCE', `${fl.label}: not found in this company`, 422)
  }
}

/** An exit and everything it pays (full & final, leave encashment, gratuity). */
const SEPARATION_SECTIONS = new Set(['resignation', 'termination', 'exit_clearance', 'final_settlement'])

/**
 * 409 EMPLOYEE_TRANSFERRED when the record is a company's old record of someone
 * moved to head office (hr/transfer.ts). Their service, leave and gratuity went
 * with them: an exit, a full & final, leave encashment or gratuity is the head
 * office's, raised on the head-office record — never paid twice from here.
 * Inside a transaction it takes the employee's lock first (the one the move
 * takes), so a move and an approval cannot pass each other.
 */
async function assertNotTransferred(q: Tx | typeof prisma, tenantId: string, employeeId: string | null | undefined, lock = false) {
  if (!employeeId) return
  if (lock) await lockEmployeeLeave(q as Tx, employeeId)
  const e = await q.hrEmployee.findFirst({ where: { id: employeeId, tenantId }, select: { status: true, data: true } })
  if (e?.status !== TRANSFERRED_STATUS) return
  const to = ((e.data ?? {}) as { transferredTo?: { employeeId?: string; effectiveDate?: string } }).transferredTo
  const ho = to?.employeeId ? await q.hrEmployee.findFirst({ where: { id: to.employeeId }, select: { employeeCode: true } }) : null
  throw new AppError(
    'EMPLOYEE_TRANSFERRED',
    `This person moved to head office${to?.effectiveDate ? ` on ${to.effectiveDate}` : ''}${ho ? ` (head-office employee ${ho.employeeCode})` : ''} — their exit, full & final, leave encashment and gratuity belong to the head office: raise it on the head-office record`,
    409,
  )
}

/** Section-specific work before a record is saved. Runs inside the saving
 *  transaction: leave takes the employee's booking lock here, so its balance
 *  check and the write that follows are one step. */
async function prepareRecord(tx: Tx, tenantId: string, section: string, fields: HrField[], cols: ReturnType<typeof slotColumns>, data: Record<string, unknown>, id?: string) {
  // No negative money, whatever the format says (audit PPL-07): a bonus of
  // minus Rs 5,000 is a deduction, and has its own kind.
  const negative = negativeMoney(section, fields, data)
  if (negative.length) throw new AppError('NEGATIVE_AMOUNT', `${negative.join(', ')} cannot be negative`, 400)
  await assertTransferInCompany(tx, section, tenantId, data)
  if (SEPARATION_SECTIONS.has(section)) await assertNotTransferred(tx, tenantId, cols.employeeId, true)
  if (section === 'shift_swap' && cols.employeeId) await checkSwapPartner(tx, tenantId, cols.employeeId, data, cols.startDate as Date | null | undefined)
  if (section === 'leave') {
    if (cols.employeeId) await lockEmployeeLeave(tx, cols.employeeId)
    const r = await checkLeave(tenantId, { id, employeeId: cols.employeeId ?? null, refId: cols.refId ?? null, startDate: cols.startDate ?? null, endDate: cols.endDate ?? null, quantity: cols.quantity ?? null }, tx)
    cols.quantity = r.quantity ?? null
    data[fields.find((f) => f.bind === 'quantity')?.key ?? 'days'] = r.quantity
  }
  if (section === 'salary_revision' && cols.employeeId && cols.amountCents) {
    const emp = await prisma.hrEmployee.findFirst({ where: { id: cols.employeeId, tenantId }, select: { grossSalaryCents: true } })
    if (emp) {
      data['increaseAmount'] = cols.amountCents - emp.grossSalaryCents
      data['increasePct'] = emp.grossSalaryCents > 0 ? Math.round(((cols.amountCents - emp.grossSalaryCents) / emp.grossSalaryCents) * 10000) / 100 : null
      data['currentGross'] = emp.grossSalaryCents
    }
  }
  if (section === 'final_settlement') {
    // The one formula (logic.ts settlementNet) — the same one its accrual books.
    // Per-person HR money is INT4 (amountCents): too big is 422, not a 500.
    const parts = settlementParts(data)
    for (const [k, v] of Object.entries(parts)) assertInt4Fits(v, fields.find((f) => f.key === k)?.label ?? k)
    const net = settlementNet(parts)
    assertInt4Fits(net, 'The net settlement')
    data['netAmount'] = net
    cols.amountCents = net
  }
  if (section === 'loan' && data['paidFrom'] === 'cash' && typeof data['bankAccount'] === 'string' && data['bankAccount']) {
    throw new AppError('BANK_ACCOUNT_ON_CASH', 'A loan paid in cash does not use a bank account — clear the bank account or pay it by bank', 422)
  }
  // A loan is recovered one installment a payroll; zero, negative or part
  // installments would never recover it. Checked here whatever the format says.
  if (section === 'loan') {
    if (cols.quantity != null && !(Number.isInteger(cols.quantity) && cols.quantity >= 1)) {
      throw new AppError('BAD_INSTALLMENTS', 'The number of installments must be a whole number, 1 or more', 400)
    }
    if (cols.amountCents != null && cols.amountCents <= 0) throw new AppError('BAD_AMOUNT', 'The loan amount must be more than zero', 400)
  }
  if (section === 'overtime' && cols.quantity != null && cols.quantity <= 0) {
    throw new AppError('BAD_HOURS', 'OT hours must be more than zero', 400)
  }
}

/**
 * A shift swap is with a current colleague of the same company (checked by
 * checkReferences) and the same branch, never with yourself (audit PPL-13 —
 * staff raise swaps themselves now), and never onto a day the colleague is on
 * approved leave (HR-R5 — the rota refuses that day, so a swap must too).
 * Checked when the swap is raised and again when it is finally approved.
 */
async function checkSwapPartner(tx: Tx, tenantId: string, employeeId: string, data: Record<string, unknown>, date: Date | null | undefined) {
  const partnerId = swapPartnerOf(data)
  if (!partnerId) return
  if (partnerId === employeeId) throw new AppError('BAD_SWAP', 'You cannot swap a shift with yourself', 400)
  const [me, partner] = await Promise.all([
    tx.hrEmployee.findFirst({ where: { id: employeeId, tenantId }, select: { locationId: true } }),
    tx.hrEmployee.findFirst({ where: { id: partnerId, tenantId }, select: { locationId: true, status: true, fullName: true } }),
  ])
  if (!partner || !['active', 'on_leave'].includes(partner.status)) throw new AppError('BAD_SWAP', 'Swap with a current colleague', 422)
  if (me?.locationId && partner.locationId && me.locationId !== partner.locationId) {
    throw new AppError('BAD_SWAP', `${partner.fullName} works at another branch — swap with someone at yours`, 422)
  }
  if (date) {
    const leave = await approvedLeaveOn(tenantId, partnerId, date, tx)
    if (leave) throw new AppError('PARTNER_ON_LEAVE', `${partner.fullName} is on approved leave (${leaveSpan(leave)}) — swap with someone who is working that day`, 409, { leaveId: leave.id })
  }
}

const swapPartnerOf = (data: unknown): string | null => {
  const w = ((data ?? {}) as Record<string, unknown>)['swapWith']
  return typeof w === 'string' && w ? w : null
}

/** The colleague's answer to a swap that puts them on a shift (HR-R5).
 *  Written only by POST /hr/swaps/:id/respond — never by a form. */
interface SwapPartnerAnswer { decision: 'accepted' | 'declined'; byUserId: string; byName: string; onBehalf: boolean; at: string; note?: string }
const swapAnswerOf = (data: unknown): SwapPartnerAnswer | null =>
  (((data ?? {}) as Record<string, unknown>)['_partner'] as SwapPartnerAnswer | undefined) ?? null
/** A swap with a colleague that the colleague has not accepted yet. */
const swapAwaitsPartner = (rec: Pick<HrRecord, 'section' | 'data'>) =>
  rec.section === 'shift_swap' && !!swapPartnerOf(rec.data) && swapAnswerOf(rec.data)?.decision !== 'accepted'

function recordLabel(rec: HrRecord & { employee?: { fullName: string } | null }, fields: HrField[]): string {
  const d = rec.data as Record<string, unknown>
  const first = fields.find((f) => (f.type === 'text') && typeof d[f.key] === 'string' && d[f.key])
  const bits = [first ? String(d[first.key]) : null, rec.employee?.fullName ?? null, rec.startDate ? rec.startDate.toISOString().slice(0, 10) : null].filter(Boolean)
  return bits.join(' · ') || rec.id.slice(0, 8)
}

/** Who a record is about and who has already had a hand in it — everything
 *  canActOnStep needs to keep requester and approvers apart. */
async function approvalSubject(rec: HrRecord) {
  const done = { createdById: rec.createdById, priorApproverIds: (rec.approvals as unknown as ApprovalEntry[]).map((a) => a.byUserId) }
  if (!rec.employeeId) return { employeeUserId: null, managerUserId: null, ...done }
  // The direct reporting manager's login — service.ts managerUserIdOfEmployee,
  // the ONE HOD rule (the cash requests read it through directManagerUserIdOf).
  const [emp, managerUserId] = await Promise.all([
    prisma.hrEmployee.findFirst({ where: { id: rec.employeeId, tenantId: rec.tenantId }, select: { userId: true } }),
    managerUserIdOfEmployee(rec.tenantId, rec.employeeId),
  ])
  return { employeeUserId: emp?.userId ?? null, managerUserId, ...done }
}

/** Everything that happens when a record reaches 'approved' — whether the last
 *  approver got it there or its format has no approval steps at all. Effects
 *  (applyDueEffects) follow once the transaction commits. */
async function finalApproval(tx: Tx, rec: HrRecord, extra: { approvedHours?: number | null; actorId?: string; classification?: ClassificationInput | null } = {}) {
  // Checked again at approval (under the employee's lock): a move may have
  // landed since the record was raised.
  if (SEPARATION_SECTIONS.has(rec.section)) await assertNotTransferred(tx, rec.tenantId, rec.employeeId, true)
  const s = await getSettings(rec.tenantId)
  const emp = rec.employeeId ? await tx.hrEmployee.findFirst({ where: { id: rec.employeeId, tenantId: rec.tenantId } }) : null
  await onFinalApproval(tx, { ...rec, status: 'approved' }, emp, s, extra)
  // A correction rewrites the day it is about — the punched times give way to
  // the approved ones, and present / late is worked out again.
  if (rec.section === 'attendance_correction') await applyAttendanceCorrection(tx, { ...rec, status: 'approved' })
  // A swap moves the colleague onto the shift: they must still be current, at
  // the branch and not on leave that day (leave approved since it was raised).
  if (rec.section === 'shift_swap' && rec.employeeId) await checkSwapPartner(tx, rec.tenantId, rec.employeeId, rec.data as Record<string, unknown>, rec.startDate)
  // Approved leave takes the person off the rota for those days (audit
  // PPL-R2-02): hours a manager set on /scheduling for them on a leave day
  // are removed, and listed on the leave record (and in the audit log) so
  // the manager can see what to cover.
  if (rec.section === 'leave' && emp?.userId) await clearShiftsOnLeave(tx, rec, emp.userId)
  // …and an approved shift swap on those days, on either side, leaves a
  // shift with nobody on it (RV-P-02): listed on the leave and audited.
  if (rec.section === 'leave' && emp) await flagSwapsOnLeave(tx, rec, emp.id)
  const approvers = rec.approvals as unknown as ApprovalEntry[]
  const by = extra.actorId ?? approvers[approvers.length - 1]?.byUserId ?? rec.createdById ?? 'system'
  // A loan is paid out when it is approved: it goes on the books as owed by
  // the employee, and payroll recovers it.
  if (rec.section === 'loan') {
    const paid = await postLoanDisbursement(tx, rec, by)
    // Internal payment classification (2026-10-20), sent with the final approval: a label on the entry.
    await classifyPaymentTx(tx, { journalEntryId: paid?.entryId ?? null, input: extra.classification ?? null, setById: by })
  }
  // A full & final is booked when it is approved, and paid with "Mark paid".
  if (rec.section === 'final_settlement') await approveSettlement(tx, rec, by)
}

/** What "Calculate" worked a full & final out from, stamped on the record
 *  (POST /hr/final-settlement/calculate with its recordId). */
interface SettlementCalc { salaryFrom: string | null; lastWorkingDay: string; paidThrough: string | null; unpaidMonthSalary: boolean; at: string }

const ymdOf = (d: Date | string | null | undefined) => (d ? (typeof d === 'string' ? d : d.toISOString()).slice(0, 10) : null)

/** 409 when another settlement of this employee is already approved (per-employee lock held for the tx). */
export async function assertOnlySettlement(tx: Tx, rec: { id: string; tenantId: string; employeeId: string | null }) {
  if (!rec.employeeId) return
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`hr.fnf.emp:${rec.tenantId}:${rec.employeeId}`}::text))`
  const other = await tx.hrRecord.findFirst({
    where: { tenantId: rec.tenantId, employeeId: rec.employeeId, section: 'final_settlement', status: 'approved', id: { not: rec.id } },
    select: { id: true },
  })
  if (other) {
    throw new AppError('FNF_ALREADY_APPROVED', 'This employee already has an approved full & final settlement — cancel that one first if it is wrong', 409)
  }
}

/**
 * A full & final reaching approval (finance gaps #2 and "F&F can pay a month
 * twice"). The settlement pays salary from the day after the last payroll the
 * leaver is on, so every payroll they are on must be final first: a draft or
 * approved one could still be recalculated or deleted, and the month would be
 * paid twice or not at all. That day is stored (data._salaryFrom) and payroll
 * leaves the leaver out of its month and every later one. If payroll moved
 * since "Calculate" (a run deleted, the last working day changed), the
 * figures are stale and the approval is refused. Then it is booked.
 */
async function approveSettlement(tx: Tx, rec: HrRecord, postedBy: string) {
  if (!rec.employeeId || !rec.endDate) throw new AppError('INCOMPLETE', 'Set the employee and the last working day first', 422)
  // ONE settlement per leaver: a second one would book (and pay) the same
  // salary and recover the same loan twice. Serialised per employee so two
  // approvals at the same moment cannot both pass.
  await assertOnlySettlement(tx, rec)
  const open = await tx.hrPayslip.findFirst({
    where: { tenantId: rec.tenantId, employeeId: rec.employeeId, run: { status: { in: ['draft', 'approved'] } } },
    select: { run: { select: { period: true, status: true } } },
    orderBy: { run: { period: 'desc' } },
  })
  if (open) {
    throw new AppError('FNF_PAYROLL_OPEN', `The ${open.run.period} payroll (${open.run.status}) includes this employee — lock it before approving the settlement, or delete it, calculate the settlement again and run that payroll after approval`, 409)
  }
  const lastRun = await tx.hrPayrollRun.findFirst({
    where: { tenantId: rec.tenantId, status: 'locked', payslips: { some: { employeeId: rec.employeeId } } },
    orderBy: { period: 'desc' }, select: { period: true },
  })
  const owedFrom = lastRun ? new Date(periodEnd(lastRun.period).getTime() + 1) : periodStart(periodOf(rec.endDate))
  const d = (rec.data ?? {}) as Record<string, unknown>
  const calc = d['_calc'] as SettlementCalc | undefined
  let salaryFrom: Date | null = owedFrom
  if (calc) {
    if (ymdOf(calc.lastWorkingDay) !== ymdOf(rec.endDate)) {
      throw new AppError('FNF_STALE', 'The last working day changed after this settlement was calculated — calculate it again', 409)
    }
    if (calc.unpaidMonthSalary === false) salaryFrom = null
    else if (ymdOf(calc.salaryFrom) !== ymdOf(owedFrom)) {
      throw new AppError('FNF_STALE', `Payroll changed after this settlement was calculated: salary is now owed from ${ymdOf(owedFrom)}, not ${ymdOf(calc.salaryFrom) ?? 'nothing'} — calculate it again`, 409)
    }
  }
  const cur = await tx.hrRecord.findUniqueOrThrow({ where: { id: rec.id }, select: { data: true } })
  const stamped = await tx.hrRecord.update({
    where: { id: rec.id },
    data: { data: { ...((cur.data ?? {}) as Record<string, unknown>), _salaryFrom: salaryFrom ? salaryFrom.toISOString() : null } as Prisma.InputJsonValue },
  })
  await postFinalSettlementAccrual(tx, stamped, postedBy)
}

interface RemovedShift { id: string; date: string; conceptId: string; startTime: string; endTime: string; role: string | null }

/** Delete the working-hour /scheduling rows on a full-day leave's days and
 *  record them on the leave as `_shiftsRemoved`. Day-off rows stay (harmless).
 *  Only this company's brands are touched. */
async function clearShiftsOnLeave(tx: Tx, rec: HrRecord, userId: string) {
  if (!rec.startDate || !rec.endDate || isHalfDayLeave(rec)) return
  const rows = await tx.scheduledShift.findMany({
    where: {
      userId, date: { gte: rec.startDate, lte: new Date(rec.endDate.getTime() + 86_399_999) },
      OR: [{ role: null }, { role: { not: OFF_MARK } }],
      concept: { tenantId: rec.tenantId },
    },
    select: { id: true, date: true, conceptId: true, startTime: true, endTime: true, role: true },
    orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
  })
  if (rows.length === 0) return
  await tx.scheduledShift.deleteMany({ where: { id: { in: rows.map((r) => r.id) } } })
  const removed: RemovedShift[] = rows.map((r) => ({ id: r.id, date: rotaYmd(r.date), conceptId: r.conceptId, startTime: r.startTime, endTime: r.endTime, role: r.role }))
  const cur = await tx.hrRecord.findUniqueOrThrow({ where: { id: rec.id }, select: { data: true } })
  await tx.hrRecord.update({
    where: { id: rec.id },
    data: { data: { ...((cur.data ?? {}) as Record<string, unknown>), _shiftsRemoved: removed } as unknown as Prisma.InputJsonValue },
  })
}

interface AffectedSwap {
  swapId: string; date: string
  /** Which side of the swap the person on leave is. */
  side: 'requester' | 'partner'
  colleagueId: string | null; colleagueName: string | null
  /** The shift that now has nobody on it: the one the person on leave took
   *  over in the swap (null when the swap named no shift). */
  shiftId: string | null; shiftName: string | null
}

/** Approved shift swaps on a full-day leave's days with the person on leave
 *  on either side (RV-P-02). The swap stays as approved — cancelling it would
 *  only move the gap to the other shift — but the shift the person on leave
 *  was swapped onto is uncovered, so each is listed on the leave as
 *  `_swapsAffected` (and audited) for the manager to cover. */
async function flagSwapsOnLeave(tx: Tx, rec: HrRecord, employeeId: string) {
  if (!rec.startDate || !rec.endDate || isHalfDayLeave(rec)) return
  const swaps = await tx.hrRecord.findMany({
    where: {
      tenantId: rec.tenantId, section: 'shift_swap', status: 'approved',
      startDate: { gte: rec.startDate, lte: new Date(rec.endDate.getTime() + 86_399_999) },
      OR: [{ employeeId }, { data: { path: ['swapWith'], equals: employeeId } }],
    },
    select: { id: true, employeeId: true, startDate: true, refId: true, data: true },
    orderBy: { startDate: 'asc' },
  })
  if (swaps.length === 0) return
  const rows = swaps.map((sw) => {
    const d = (sw.data ?? {}) as Record<string, unknown>
    const side = sw.employeeId === employeeId ? 'requester' as const : 'partner' as const
    const colleagueId = side === 'requester' ? swapPartnerOf(d) : sw.employeeId
    const from = typeof d['fromShift'] === 'string' && d['fromShift'] ? d['fromShift'] : null
    return { sw, side, colleagueId, shiftId: side === 'requester' ? sw.refId : from }
  })
  const colleagueIds = rows.map((r) => r.colleagueId).filter((x): x is string => !!x)
  const shiftIds = rows.map((r) => r.shiftId).filter((x): x is string => !!x)
  const [people, shifts] = await Promise.all([
    colleagueIds.length ? tx.hrEmployee.findMany({ where: { tenantId: rec.tenantId, id: { in: colleagueIds } }, select: { id: true, fullName: true } }) : Promise.resolve([]),
    shiftIds.length ? tx.hrRecord.findMany({ where: { tenantId: rec.tenantId, section: 'shift', id: { in: shiftIds } }, select: { id: true, data: true } }) : Promise.resolve([]),
  ])
  const nameOf = new Map(people.map((p) => [p.id, p.fullName]))
  const shiftName = new Map(shifts.map((x) => {
    const d = (x.data ?? {}) as Record<string, unknown>
    const label = [d['name'], d['start'] && d['end'] ? `${String(d['start'])}–${String(d['end'])}` : null].filter(Boolean).join(' ')
    return [x.id, label || null] as const
  }))
  const affected: AffectedSwap[] = rows.map((r) => ({
    swapId: r.sw.id, date: rotaYmd(r.sw.startDate!), side: r.side,
    colleagueId: r.colleagueId, colleagueName: r.colleagueId ? nameOf.get(r.colleagueId) ?? null : null,
    shiftId: r.shiftId, shiftName: r.shiftId ? shiftName.get(r.shiftId) ?? null : null,
  }))
  const cur = await tx.hrRecord.findUniqueOrThrow({ where: { id: rec.id }, select: { data: true } })
  await tx.hrRecord.update({
    where: { id: rec.id },
    data: { data: { ...((cur.data ?? {}) as Record<string, unknown>), _swapsAffected: affected } as unknown as Prisma.InputJsonValue },
  })
}

/** Audit the /scheduling hours an approved leave removed (PPL-R2-02) and the
 *  approved swaps it leaves a shift uncovered on (RV-P-02). */
async function auditShiftsRemoved(req: FastifyRequest, rec: HrRecord) {
  if (rec.section !== 'leave' || rec.status !== 'approved') return
  const d = (rec.data ?? {}) as Record<string, unknown>
  const removed = d['_shiftsRemoved'] as RemovedShift[] | undefined
  if (removed?.length) {
    await audit({
      category: 'identity', action: 'hr.leave.shifts_removed', entity: 'HrRecord', entityId: rec.id,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId: rec.tenantId,
      after: { employeeId: rec.employeeId, shifts: removed },
    })
  }
  const swaps = d['_swapsAffected'] as AffectedSwap[] | undefined
  if (swaps?.length) {
    await audit({
      category: 'identity', action: 'hr.leave.swaps_affected', entity: 'HrRecord', entityId: rec.id,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId: rec.tenantId,
      after: { employeeId: rec.employeeId, swaps },
    })
  }
}

// The CSV writer (with the formula-injection guard) is accounting/csv.ts — one
// copy for HR and the accountant exports (D16). Re-exported for existing callers.
export { csv }

async function createRecord(req: FastifyRequest, tenantId: string, section: string, input: Record<string, unknown>, opts: { submit: boolean; forEmployeeId?: string; viaHeadOfficeId?: string | null }) {
  const sec = recordSection(section)
  // A section whose work moved (eobi_challan → Accounting → Statutory
  // payments): its old rows stay readable, no new ones — here once, for
  // /records/:section and /me/records/:section alike.
  if (sec.movedTo) throw sectionMoved(sec)
  const fmt = await getFormat(tenantId, section)
  const selfService = !!opts.forEmployeeId
  if (selfService) {
    // A self-service request must belong to the employee and wait for someone
    // else to approve it. checkFormat refuses a format that breaks either;
    // this holds for one saved before it did.
    if (!fmt.fields.some((f) => f.bind === 'employeeId')) throw new AppError('BAD_FORMAT', 'This request type has no employee field — ask HR to fix its format', 422)
    if (fmt.workflow.length === 0) throw new AppError('NO_WORKFLOW', 'This request type has no approval steps — ask HR to fix its format', 422)
  }
  const clean = omitKeys(input, [...(SERVER_OWNED[section] ?? []), ...(selfService ? ESS_HIDDEN[section] ?? [] : [])])
  const payload = selfService ? { ...clean, ...Object.fromEntries(fmt.fields.filter((f) => f.bind === 'employeeId').map((f) => [f.key, opts.forEmployeeId])) } : clean
  const v = validateAgainst(fmt.fields, payload)
  if (v.errors.length) throw formErrors(v.errors)
  await checkReferences(tenantId, fmt.fields, v.data)
  const cols = slotColumns(v.slots)
  // Staff ask to swap a shift that is still to come — a past day is HR's to
  // correct through attendance.
  if (selfService && section === 'shift_swap' && cols.startDate && cols.startDate < pktToday()) {
    throw new AppError('BAD_SWAP', 'Pick today or a day still to come', 400)
  }
  const hasWorkflow = fmt.workflow.length > 0
  const created = await prisma.$transaction(async (tx) => {
    await prepareRecord(tx, tenantId, section, fmt.fields, cols, v.data)
    const r = await tx.hrRecord.create({
      data: {
        tenantId, section, formVersion: fmt.version, ...cols,
        status: hasWorkflow ? (opts.submit ? 'submitted' : 'draft') : 'approved',
        stage: fmt.stages[0] ?? null,
        // A day keyed by hand (owner, 2026-10-20): marked manual, HR's (a punch never rewrites it), waits for the CEO.
        data: (section === 'attendance' ? { ...v.data, _source: 'hr', _manual: true } : v.data) as Prisma.InputJsonValue,
        createdById: req.staffUser!.id,
        ...(opts.viaHeadOfficeId && { viaHeadOfficeId: opts.viaHeadOfficeId }),
      },
    })
    // No approval steps: approved on creation, through the same final-approval
    // path as a decided record — OT is priced here, not taken from the input.
    if (!hasWorkflow) await finalApproval(tx, r)
    return r
  })
  if (!hasWorkflow) await applyDueEffects(tenantId)
  const rec = await prisma.hrRecord.findUniqueOrThrow({ where: { id: created.id } })
  await auditShiftsRemoved(req, rec)
  await audit({
    category: 'identity', action: `hr.${section}.create`, entity: 'HrRecord', entityId: rec.id,
    userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId, after: { section, status: rec.status },
    ...(opts.viaHeadOfficeId && { metadata: { viaHeadOfficeId: opts.viaHeadOfficeId } }),
  })
  void sec
  // The bell (queued, after the commit): a submitted record waits on its first step
  // (covers /records/:section and self-service /me/records/:section).
  if (rec.status === 'submitted') approvalWaiting('hr_request', rec.id, { round: `step:${rec.currentStep}:${rec.updatedAt.toISOString()}`, actorId: req.staffUser!.id })
  return rec
}

// ─── routes ─────────────────────────────────────────────────────────────────

export async function hrRoutes(fastify: FastifyInstance) {
  // Work locations on the employee (/employees/:id/work-locations) and HR attendance tracking
  // (/attendance-tracking/*) — owner, 2026-10-15.
  await workLocationRoutes(fastify)
  await attendanceTrackingRoutes(fastify)

  // ── Sections & formats ────────────────────────────────────────────────────
  fastify.get('/sections', { preHandler: requireAuth(...HR_ADMIN) }, async (req) => {
    const formats = await getAllFormats(activeTenant(req))
    return HR_SECTIONS.map((s) => ({
      key: s.key, specNo: s.specNo, title: s.title, group: s.group, kind: s.kind, config: !!s.config,
      effect: s.effect ?? null, requires: s.requires ?? [], movedTo: s.movedTo ?? null,
      format: s.kind === 'record' || s.key === 'employees' ? formats[s.key] : null,
    }))
  })

  fastify.get<{ Params: { section: string }; Querystring: { tenantId?: string } }>('/forms/:section', { preHandler: requireAuth(...HR_ADMIN) }, async (req) => {
    const tenantId = await pickerTenant(req)
    const sec = sectionByKey(req.params.section)
    if (!sec) throw new NotFoundError('HR section', req.params.section)
    const [current, versions] = await Promise.all([
      getFormat(tenantId, sec.key),
      prisma.hrFormDefinition.findMany({ where: { tenantId, section: sec.key }, orderBy: { version: 'desc' }, select: { version: true, isActive: true, note: true, createdAt: true, updatedById: true } }),
    ])
    return { section: { key: sec.key, title: sec.title, requires: sec.requires ?? [], effect: sec.effect ?? null }, current, versions, default: defaultFormat(sec) }
  })

  const fieldSchema: z.ZodType<HrField> = z.lazy(() => z.object({
    key: z.string().min(1).max(60),
    label: z.string().min(1).max(160),
    type: z.string() as unknown as z.ZodType<HrField['type']>,
    required: z.boolean().optional(),
    options: z.array(z.string().max(120)).max(200).optional(),
    ref: z.string().max(60).optional(),
    bind: z.string().max(60).optional() as unknown as z.ZodType<HrField['bind']>,
    group: z.string().max(80).optional(),
    help: z.string().max(300).optional(),
    readOnly: z.boolean().optional(),
    system: z.boolean().optional(),
    min: z.number().optional(),
    integer: z.boolean().optional(),
    columns: z.array(fieldSchema).max(40).optional(),
  }))

  // PUT /hr/forms/:section — save the HR team's format as a new version.
  fastify.put<{ Params: { section: string } }>('/forms/:section', { preHandler: requireAuth(...HR_ADMIN) }, async (req) => {
    const tenantId = activeTenant(req)
    const sec = sectionByKey(req.params.section)
    if (!sec || !(sec.kind === 'record' || sec.key === 'employees')) throw new NotFoundError('HR section', req.params.section)
    const body = z.object({
      title: z.string().min(1).max(160).optional(),
      fields: z.array(fieldSchema).min(1).max(200),
      workflow: z.array(z.object({ key: z.string().min(1).max(40), label: z.string().min(1).max(80), role: z.enum(['hod', 'hr', 'management']) })).max(6).optional(),
      stages: z.array(z.string().min(1).max(60)).max(30).optional(),
      note: z.string().max(300).optional(),
    }).parse(req.body)

    const cur = await getFormat(tenantId, sec.key)
    const problems = formatProblems(sec, body.fields, body.workflow ?? cur.workflow)
    if (problems.length) throw new AppError('BAD_FORMAT', problems.join(' · '), 400)

    const last = await prisma.hrFormDefinition.findFirst({ where: { tenantId, section: sec.key }, orderBy: { version: 'desc' } })
    const version = (last?.version ?? 0) + 1
    await prisma.$transaction([
      prisma.hrFormDefinition.updateMany({ where: { tenantId, section: sec.key }, data: { isActive: false } }),
      prisma.hrFormDefinition.create({
        data: {
          tenantId, section: sec.key, version, title: body.title ?? cur.title,
          fields: body.fields as unknown as Prisma.InputJsonValue,
          workflow: (body.workflow ?? cur.workflow) as unknown as Prisma.InputJsonValue,
          stages: (body.stages ?? cur.stages) as unknown as Prisma.InputJsonValue,
          note: body.note ?? null, updatedById: req.staffUser!.id,
        },
      }),
    ])
    await audit({
      category: 'identity', action: 'hr.format.save', entity: 'HrFormDefinition', entityId: `${sec.key}:v${version}`,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId, after: { section: sec.key, version, fields: body.fields.length },
    })
    return getFormat(tenantId, sec.key)
  })

  // POST /hr/forms/:section/activate { version } — roll back to an earlier
  // version (0 = the built-in default).
  fastify.post<{ Params: { section: string } }>('/forms/:section/activate', { preHandler: requireAuth(...HR_ADMIN) }, async (req) => {
    const tenantId = activeTenant(req)
    const sec = sectionByKey(req.params.section)
    if (!sec || !(sec.kind === 'record' || sec.key === 'employees')) throw new NotFoundError('HR section', req.params.section)
    const { version } = z.object({ version: z.number().int().min(0) }).parse(req.body)
    // Find the version before anything changes: a mistyped one must leave the
    // live format live, not drop the section back to the default. And a
    // version saved before today's rules must pass them to go live again.
    const target = version > 0 ? await prisma.hrFormDefinition.findFirst({ where: { tenantId, section: sec.key, version } }) : null
    if (version > 0 && !target) throw new NotFoundError('Format version', String(version))
    if (target) {
      // Checked as it would be used: with any system field added since it
      // was saved (getFormat puts those back too).
      const problems = formatProblems(sec, withSystemFields(sec, target.fields as unknown as HrField[]), target.workflow as unknown as WorkflowStep[])
      if (problems.length) throw new AppError('BAD_FORMAT', `Version ${version} cannot be used any more: ${problems.join(' · ')}`, 400)
    }
    await prisma.$transaction([
      prisma.hrFormDefinition.updateMany({ where: { tenantId, section: sec.key }, data: { isActive: false } }),
      ...(target ? [prisma.hrFormDefinition.update({ where: { id: target.id }, data: { isActive: true } })] : []),
    ])
    await audit({
      category: 'identity', action: 'hr.format.activate', entity: 'HrFormDefinition', entityId: `${sec.key}:v${version}`,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId, after: { section: sec.key, version },
    })
    return getFormat(tenantId, sec.key)
  })

  // ── Settings ──────────────────────────────────────────────────────────────
  fastify.get('/settings', { preHandler: requireAuth(...HR_ADMIN) }, async (req) => getSettings(activeTenant(req)))

  fastify.put('/settings', { preHandler: requireAuth(...HR_ADMIN) }, async (req) => {
    const tenantId = activeTenant(req)
    const body = z.object({
      // Retired (owner HR-1, 2026-10-16): pay is gross ÷ the actual days of
      // each month × paid days — not an HR setting. Accepted and dropped so
      // older screens still save.
      workingDaysPerMonth: z.number().int().min(0).max(31).optional(),
      hoursPerDay: z.number().min(1).max(24),
      otMultiplier: z.number().min(1).max(5),
      eobi: z.object({
        enabled: z.boolean(),
        employeePct: z.number().min(0).max(100), employerPct: z.number().min(0).max(100),
        base: z.enum(['fixed', 'gross']), fixedWageCents: z.number().int().min(0).nullable(),
      }),
      sessi: z.object({ employerPct: z.number().min(0).max(100), wageCeilingCents: z.number().int().min(0).nullable() }),
      latesPerDeductionDay: z.number().int().min(0).max(31),
      lateGraceMinutes: z.number().int().min(0).max(240),
      deductAbsences: z.boolean(),
      leaveYearStartMonth: z.number().int().min(1).max(12),
      encashLeaveOnExit: z.boolean(),
      employeeCodePrefix: z.string().max(12),
      // Gratuity at exit (H6). Optional so a screen that does not send it
      // keeps what the company has.
      gratuity: z.object({
        enabled: z.boolean(),
        eligibleTypes: z.array(z.string().trim().min(1).max(40)).max(20),
        minServiceMonths: z.number().int().min(0).max(60),
        partYearOverMonths: z.number().int().min(0).max(11),
        daysPerYear: z.number().int().min(1).max(60),
      }).optional(),
    }).parse(req.body)
    const before = await getSettings(tenantId)
    const next = mergeSettings({ ...body, gratuity: body.gratuity ?? before.gratuity } as Partial<HrSettings>)
    await saveSettings(tenantId, next)
    await audit({ category: 'identity', action: 'hr.settings.update', entity: 'Setting', entityId: `hr.settings.${tenantId}`, userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId, before, after: next })
    return next
  })

  // ── Organization setup ────────────────────────────────────────────────────
  fastify.get<{ Querystring: { tenantId?: string } }>('/org', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const tenantId = await pickerTenant(req)
    const [units, rawDepartments, locations, retired] = await Promise.all([
      prisma.hrOrgUnit.findMany({ where: { tenantId }, orderBy: [{ kind: 'asc' }, { name: 'asc' }] }),
      prisma.department.findMany({ where: { tenantId }, orderBy: [{ order: 'asc' }, { name: 'asc' }], select: { id: true, name: true, emoji: true, isHeadOffice: true, order: true, archivedAt: true } }),
      prisma.location.findMany({ where: { tenantId }, orderBy: { name: 'asc' }, select: { id: true, name: true } }),
      headOfficeSetupApplied(),
    ])
    const departments = rawDepartments.map((d) => withoutRetiredFlag(d, retired))
    // Pickers get the live departments; an archived one is listed apart so
    // Org setup can bring it back and old records still show its name.
    return {
      units, locations, kinds: ORG_UNIT_KINDS,
      departments: departments.filter((d) => !d.archivedAt),
      archivedDepartments: departments.filter((d) => d.archivedAt),
    }
  })

  fastify.post('/org/units', { preHandler: requireAuth(...HR_ADMIN) }, async (req, reply) => {
    const tenantId = activeTenant(req)
    const body = z.object({ kind: z.enum(ORG_UNIT_KINDS), name: z.string().min(1).max(120), code: z.string().max(40).optional(), parentId: z.string().uuid().nullable().optional() }).parse(req.body)
    const exists = await prisma.hrOrgUnit.findFirst({ where: { tenantId, kind: body.kind, name: body.name.trim() } })
    if (exists) throw new AppError('DUPLICATE', `"${body.name}" already exists`, 409)
    const unit = await prisma.hrOrgUnit.create({ data: { tenantId, kind: body.kind, name: body.name.trim(), code: body.code || null, parentId: body.parentId ?? null } })
    return reply.status(201).send(unit)
  })

  fastify.patch<{ Params: { id: string } }>('/org/units/:id', { preHandler: requireAuth(...HR_ADMIN) }, async (req) => {
    const body = z.object({ name: z.string().min(1).max(120).optional(), code: z.string().max(40).nullable().optional(), isActive: z.boolean().optional() }).parse(req.body)
    const unit = await prisma.hrOrgUnit.findFirst({ where: { id: req.params.id, ...writeTenants(req) } })
    if (!unit) throw new NotFoundError('Org unit', req.params.id)
    return prisma.hrOrgUnit.update({ where: { id: unit.id }, data: body })
  })

  // Departments are written HERE only (item 76): Workforce → Positions reads
  // them. The name picks the wages account HR payroll posts to
  // (ledger.ts wageAccountFor), so a rename is audited.
  fastify.post('/org/departments', { preHandler: requireAuth(...HR_ADMIN) }, async (req, reply) => {
    const tenantId = activeTenant(req)
    const retired = await headOfficeSetupApplied()
    const parsed = z.object({
      name: z.string().min(1).max(120), emoji: z.string().max(8).nullable().optional(),
      isHeadOffice: z.boolean().optional(), order: z.number().int().optional(),
    }).parse(req.body)
    // Once a head office is set up the flag is retired (spec §8): stripped.
    const body = retired ? { ...parsed, isHeadOffice: undefined } : parsed
    const name = body.name.trim()
    const exists = await prisma.department.findFirst({ where: { tenantId, name: { equals: name, mode: 'insensitive' } } })
    if (exists) throw new AppError('DUPLICATE', `"${name}" already exists${exists.archivedAt ? ' (archived — bring it back instead)' : ''}`, 409)
    const dept = await prisma.department.create({ data: { tenantId, name, emoji: body.emoji ?? null, isHeadOffice: body.isHeadOffice ?? false, order: body.order ?? 0 } })
    await audit({ category: 'identity', action: 'hr.department.create', entity: 'Department', entityId: dept.id, userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId, after: { name } })
    return reply.status(201).send(withoutRetiredFlag(dept, retired))
  })

  fastify.patch<{ Params: { id: string } }>('/org/departments/:id', { preHandler: requireAuth(...HR_ADMIN) }, async (req) => {
    const retired = await headOfficeSetupApplied()
    const parsed = z.object({
      name: z.string().min(1).max(120).optional(), emoji: z.string().max(8).nullable().optional(),
      isHeadOffice: z.boolean().optional(), order: z.number().int().optional(), archived: z.boolean().optional(),
    }).parse(req.body)
    const body = retired ? { ...parsed, isHeadOffice: undefined } : parsed
    const dept = await prisma.department.findFirst({ where: { id: req.params.id, ...writeTenants(req) } })
    if (!dept || !dept.tenantId) throw new NotFoundError('Department', req.params.id)
    const name = body.name?.trim()
    if (name && name.toLowerCase() !== dept.name.toLowerCase() &&
        await prisma.department.findFirst({ where: { tenantId: dept.tenantId, name: { equals: name, mode: 'insensitive' }, NOT: { id: dept.id } } })) {
      throw new AppError('DUPLICATE', `"${name}" already exists`, 409)
    }
    if (body.archived === true && !dept.archivedAt) {
      // Archiving hides it from every picker; people and seats still in it
      // would keep pointing at a department nobody can see or pick.
      const [people, seats] = await Promise.all([
        prisma.hrEmployee.count({ where: { tenantId: dept.tenantId, departmentId: dept.id, status: { in: ['active', 'on_leave'] } } }),
        prisma.position.count({ where: { tenantId: dept.tenantId, departmentId: dept.id, status: { in: ['open', 'filled', 'frozen'] } } }),
      ])
      if (people || seats) throw new AppError('DEPARTMENT_IN_USE', `${people} current employee(s) and ${seats} position(s) are in this department — move them first`, 409)
    }
    const updated = await prisma.department.update({
      where: { id: dept.id },
      data: {
        ...(name && { name }), ...(body.emoji !== undefined && { emoji: body.emoji }),
        ...(body.isHeadOffice !== undefined && { isHeadOffice: body.isHeadOffice }), ...(body.order !== undefined && { order: body.order }),
        ...(body.archived !== undefined && { archivedAt: body.archived ? (dept.archivedAt ?? new Date()) : null }),
      },
    })
    await audit({
      category: 'identity', action: 'hr.department.update', entity: 'Department', entityId: dept.id, userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId: dept.tenantId,
      before: { name: dept.name, archivedAt: dept.archivedAt, ...(!retired && { isHeadOffice: dept.isHeadOffice }) },
      after: { name: updated.name, archivedAt: updated.archivedAt, ...(!retired && { isHeadOffice: updated.isHeadOffice }) },
    })
    return withoutRetiredFlag(updated, retired)
  })

  // ── Lookups for pickers (names only — no salaries) ────────────────────────
  fastify.get<{ Querystring: { tenantId?: string } }>('/lookups', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const tenantId = await pickerTenant(req)
    // The whole picker (every section's records, former staff) is the back
    // office's; without 'staff_hr' an HR login gets the self-service view.
    const isAdmin = await hrBackOffice(req)
    const [employees, formats] = await Promise.all([
      prisma.hrEmployee.findMany({
        where: { tenantId, ...(isAdmin ? {} : { status: { in: ['active', 'on_leave'] } }) },
        select: { id: true, fullName: true, employeeCode: true, status: true },
        orderBy: { fullName: 'asc' },
      }),
      getAllFormats(tenantId),
    ])
    // Records other sections point at (shifts, leave types, candidates, …).
    // Anyone outside HR gets only what their self-service forms pick from,
    // and only settings (leave types, shifts, holidays) — never candidates,
    // requisitions or anyone's cases, whatever a format points at.
    const refsOf = (fields: HrField[]): string[] => fields.flatMap((x) => [
      ...(x.type === 'record' && x.ref ? [x.ref] : []), ...(x.columns ? refsOf(x.columns) : []),
    ])
    const refSections = Array.from(new Set(isAdmin
      ? Object.values(formats).flatMap((f) => refsOf(f.fields))
      : ESS_SECTIONS.flatMap((k) => refsOf(formats[k]?.fields ?? [])).filter((k) => sectionByKey(k)?.config)))
    const recs = refSections.length
      ? await prisma.hrRecord.findMany({ where: { tenantId, section: { in: refSections }, status: { not: 'cancelled' } }, include: { employee: { select: { fullName: true } } }, orderBy: { createdAt: 'desc' }, take: 2000 })
      : []
    const records: Record<string, Array<{ id: string; label: string }>> = {}
    for (const r of recs) (records[r.section] ??= []).push({ id: r.id, label: recordLabel(r, formats[r.section]?.fields ?? []) })
    return { employees, records, reportingLine: isAdmin ? await reportingLineOptions(tenantId) : [] }
  })

  /**
   * The Reporting line picker (owner, 2026-10-17) — the ONE label rule, so the
   * admin shows what the server sends: "CEO" first (value REPORTS_TO_CEO;
   * `employeeId` is the CEO login's HR record in this company, or null when
   * the CEO has none), then current staff by DESIGNATION only (HR, 2026-10-19:
   * "only designations should be displayed not employee names"). Two people
   * sharing a designation, or one with none, are told apart by employee code —
   * never by name. Sorted by designation then code.
   */
  async function reportingLineOptions(tenantId: string): Promise<Array<{ id: string; label: string; employeeId: string | null; ceo?: true }>> {
    const [ceo, people] = await Promise.all([
      companyCeo(tenantId),
      prisma.hrEmployee.findMany({ where: { tenantId, status: { in: ['active', 'on_leave'] } }, select: { id: true, employeeCode: true, designationId: true } }),
    ])
    const desigIds = Array.from(new Set(people.map((p) => p.designationId).filter((d): d is string => !!d)))
    const names = new Map((desigIds.length ? await prisma.hrOrgUnit.findMany({ where: { tenantId, id: { in: desigIds } }, select: { id: true, name: true } }) : []).map((u) => [u.id, u.name]))
    const rows = people
      .filter((p) => p.id !== ceo.employee?.id)
      .map((p) => ({ id: p.id, employeeId: p.id, desig: p.designationId ? names.get(p.designationId) ?? null : null, code: p.employeeCode }))
      .sort((a, b) => (a.desig === null ? 1 : 0) - (b.desig === null ? 1 : 0) || (a.desig ?? '').localeCompare(b.desig ?? '') || a.code.localeCompare(b.code))
    const count = new Map<string, number>()
    for (const r of rows) if (r.desig) count.set(r.desig, (count.get(r.desig) ?? 0) + 1)
    const labelled = rows.map((r) => ({
      id: r.id, employeeId: r.employeeId,
      label: !r.desig ? `No designation (${r.code})` : (count.get(r.desig) ?? 0) > 1 ? `${r.desig} (${r.code})` : r.desig,
    }))
    const ceoOption = ceo.userIds.length ? [{ id: REPORTS_TO_CEO, label: 'CEO', employeeId: ceo.employee?.id ?? null, ceo: true as const }] : []
    return [...ceoOption, ...labelled]
  }

  // ── Employees ─────────────────────────────────────────────────────────────
  fastify.get<{ Querystring: { status?: string; q?: string; departmentId?: string; locationId?: string } }>(
    '/employees', { preHandler: requireAuth(...HR_ADMIN) }, async (req) => {
      await Promise.all(readTenants(req).map((t) => applyDueEffects(t)))
      const { status, q, departmentId, locationId } = req.query
      const rows = await prisma.hrEmployee.findMany({
        where: {
          ...inTenants(req),
          ...(status === 'current' ? { status: { in: ['active', 'on_leave'] } } : status ? { status } : {}),
          ...(departmentId && { departmentId }),
          ...(locationId && { locationId }),
          ...(q && { OR: [
            { fullName: { contains: q, mode: 'insensitive' } }, { employeeCode: { contains: q, mode: 'insensitive' } },
            { cnic: { contains: q } }, { phone: { contains: q } },
          ] }),
        },
        orderBy: { employeeCode: 'asc' },
      })
      const label = await employeeLabelsAcross(rows)
      return rows.map((e) => ({
        id: e.id, employeeCode: e.employeeCode, fullName: e.fullName, phone: e.phone, status: e.status,
        employmentType: e.employmentType, joiningDate: e.joiningDate, grossSalaryCents: e.grossSalaryCents,
        department: label(e.departmentId), designation: label(e.designationId), branch: label(e.locationId), manager: managerLabelOf(label, e),
        userId: e.userId, tenantId: e.tenantId,
      }))
    })

  // The employee's loans & advances statement (owner, 2026-10-20: every
  // account statement exports): ?format=csv|xlsx|pdf (default csv), same
  // HR_ADMIN readers and company scope as the employee profile (foreign 404).
  fastify.get<{ Params: { id: string }; Querystring: { format?: string } }>('/employees/:id/loan-statement', { preHandler: requireAuth(...HR_ADMIN) }, async (req, reply) => {
    const emp = await prisma.hrEmployee.findFirst({ where: { id: req.params.id, ...inTenants(req) }, select: { id: true, tenantId: true, fullName: true, employeeCode: true } })
    if (!emp) throw new NotFoundError('Employee', req.params.id)
    const loans = await loanStatement(emp.tenantId, emp.id)
    const rows: ReportRow[] = []
    for (const l of loans) {
      const loan = `${l.type ? `${l.type} ` : ''}from ${l.firstPeriod}, ${l.installments} instalment${l.installments === 1 ? '' : 's'}`
      let out = l.amountCents
      rows.push({ loan, period: l.firstPeriod, entry: 'Granted', grantedCents: l.amountCents, recoveredCents: null, outstandingCents: out })
      for (const m of l.recoveries) {
        out -= m.cents
        rows.push({ loan, period: m.when, entry: m.what, grantedCents: null, recoveredCents: m.cents, outstandingCents: Math.max(0, out) })
      }
    }
    const company = await prisma.tenant.findUnique({ where: { id: emp.tenantId }, select: { name: true } })
    return sendReportFor(req, reply, exportFormatOf(req.query.format, 'csv')!, { base: 'loan-statement', suffix: `${emp.employeeCode ?? emp.id.slice(-8)}` }, {
      title: `Loans & advances — ${emp.fullName}${emp.employeeCode ? ` (${emp.employeeCode})` : ''}`,
      companies: company ? [company.name] : [], period: 'Recoveries from locked payroll runs and approved full & final settlements',
      rows, sectionKey: 'loan', csvEmpty: 'header',
      columns: ['loan', 'period', 'entry', 'grantedCents', 'recoveredCents', 'outstandingCents'].map((key) => ({ key })),
      labels: { grantedCents: 'Granted', recoveredCents: 'Recovered', outstandingCents: 'Outstanding' },
    })
  })

  fastify.get<{ Params: { id: string } }>('/employees/:id', { preHandler: requireAuth(...HR_ADMIN) }, async (req) => {
    const emp = await prisma.hrEmployee.findFirst({ where: { id: req.params.id, ...inTenants(req) }, include: { documents: { orderBy: { createdAt: 'desc' } } } })
    if (!emp) throw new NotFoundError('Employee', req.params.id)
    await applyDueEffects(emp.tenantId)
    const fresh = await prisma.hrEmployee.findUniqueOrThrow({ where: { id: emp.id } })
    const [label, records, balances, loans, user, kioskPinSet] = await Promise.all([
      employeeLabels(emp.tenantId, [fresh]),
      prisma.hrRecord.findMany({ where: { employeeId: emp.id }, orderBy: { createdAt: 'desc' }, take: 200 }),
      leaveBalancesFor(emp.tenantId, emp.id),
      loansFor(emp.tenantId, emp.id),
      // The login's status (pending / active / suspended) for the Login tab's
      // Offboard / Reinstate (auth/offboarding.ts) — never its module access.
      fresh.userId ? prisma.user.findUnique({ where: { id: fresh.userId }, select: { id: true, name: true, email: true, role: true, accountStatus: true, isActive: true } })
        .then((u) => u && { id: u.id, name: u.name, email: u.email, role: u.role, status: accountStateOf(u) }) : null,
      hasKioskPin(emp.id),
    ])
    const salaryHistory = records
      .filter((r) => (r.section === 'salary_revision' || r.section === 'promotion') && r.status === 'approved' && r.amountCents)
      .map((r) => ({ section: r.section, effectiveDate: r.effectiveDate, grossCents: r.amountCents, applied: !!r.appliedAt }))
    return {
      employee: fresh,
      labels: { department: label(fresh.departmentId), designation: label(fresh.designationId), grade: label(fresh.gradeId), branch: label(fresh.locationId), manager: managerLabelOf(label, fresh) },
      documents: emp.documents, records, leaveBalances: balances, loans, salaryHistory, user, kioskPinSet,
    }
  })

  async function saveEmployee(req: FastifyRequest, id: string | null) {
    const target = id ? await prisma.hrEmployee.findFirst({ where: { id, ...writeTenants(req) }, select: { tenantId: true, userId: true } }) : null
    const tenantId = id ? target?.tenantId : activeTenant(req)
    if (!tenantId) throw new NotFoundError('Employee', id ?? '')
    // Nobody edits the master record linked to their own login — salary, bank
    // account and status would otherwise skip every approval. The CEO and
    // co-owner may (a one-person office), and it is recorded.
    const selfEdit = !!target?.userId && target.userId === req.staffUser!.id
    if (selfEdit && !SELF_EDITORS.includes(req.staffUser!.role)) throw new ForbiddenError('You cannot edit your own employee record — ask another HR user')
    const fmt = await getFormat(tenantId, 'employees')
    const body = z.object({ data: z.record(z.unknown()) }).parse(req.body)
    // Reporting line "CEO" (forms.ts REPORTS_TO_CEO): the CEO login's HR record
    // in this company when there is one; otherwise no person (managerId null)
    // and `reportsToCeo` on the data. Any other choice clears the flag.
    const mgrField = fmt.fields.find((fl) => fl.bind === 'employee.managerId')
    let ceoFlag: boolean | undefined
    if (mgrField && mgrField.key in body.data) {
      ceoFlag = false
      if (body.data[mgrField.key] === REPORTS_TO_CEO) {
        const ceo = await companyCeo(tenantId)
        if (ceo.employee) body.data[mgrField.key] = ceo.employee.id
        else if (ceo.userIds.length) { body.data[mgrField.key] = null; ceoFlag = true }
        else throw new AppError('NO_CEO', 'This company has no CEO login to report to — pick a person', 422)
      }
    }
    const v = validateAgainst(fmt.fields, body.data, { partial: !!id })
    if (v.errors.length) throw formErrors(v.errors)
    await checkReferences(tenantId, fmt.fields, v.data)
    const cols = toEmployeeColumns(v.employee)
    if (id && cols['managerId'] === id) throw new AppError('BAD_MANAGER', 'An employee cannot report to themselves', 400)
    // Pay is never negative, and basic is part of gross (audit PPL-07: a
    // negative salary was saved, and payroll approved, locked and paid it).
    // Checked on the columns too: an old format may fill them from any field.
    const negative = negativeMoney('employees', fmt.fields, v.data)
    for (const [col, label] of [['basicSalaryCents', 'Basic salary'], ['grossSalaryCents', 'Gross salary'], ['monthlyTaxCents', 'Monthly income tax']] as const) {
      if (typeof cols[col] === 'number' && (cols[col] as number) < 0 && !negative.some((n) => n === label)) negative.push(label)
    }
    if (negative.length) throw new AppError('NEGATIVE_AMOUNT', `${negative.join(', ')} cannot be negative`, 400)
    if (cols['basicSalaryCents'] !== undefined || cols['grossSalaryCents'] !== undefined) {
      const cur = id ? await prisma.hrEmployee.findUnique({ where: { id }, select: { basicSalaryCents: true, grossSalaryCents: true } }) : null
      const basic = (cols['basicSalaryCents'] as number | undefined) ?? cur?.basicSalaryCents ?? 0
      const gross = (cols['grossSalaryCents'] as number | undefined) ?? cur?.grossSalaryCents ?? 0
      if (basic > gross) throw new AppError('BASIC_OVER_GROSS', 'Basic salary cannot be more than gross salary', 400)
    }
    const extra = Object.fromEntries(Object.entries(v.data).filter(([k]) => !fmt.fields.find((f) => f.key === k)?.bind))
    if (ceoFlag === true) extra['reportsToCeo'] = true
    if (!id) {
      // A format may leave the name optional; the record may not.
      if (typeof cols['fullName'] !== 'string' || !cols['fullName'].trim()) throw new AppError('VALIDATION_ERROR', 'Employee name is required', 400)
      const s = await getSettings(tenantId)
      if (!cols['employeeCode']) {
        const codes = await prisma.hrEmployee.findMany({ where: { tenantId }, select: { employeeCode: true } })
        cols['employeeCode'] = nextEmployeeCode(s.employeeCodePrefix, codes.map((c) => c.employeeCode))
      }
      if (await prisma.hrEmployee.findFirst({ where: { tenantId, employeeCode: String(cols['employeeCode']) } })) {
        throw new AppError('DUPLICATE_CODE', `Employee ID ${cols['employeeCode']} is already used`, 409)
      }
      const emp = await prisma.hrEmployee.create({
        data: { tenantId, ...(cols as object), fullName: String(cols['fullName']), employeeCode: String(cols['employeeCode']), data: extra as Prisma.InputJsonValue, createdById: req.staffUser!.id } as Prisma.HrEmployeeUncheckedCreateInput,
      })
      await audit({ category: 'identity', action: 'hr.employee.create', entity: 'HrEmployee', entityId: emp.id, userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId, after: { employeeCode: emp.employeeCode, fullName: emp.fullName } })
      // The Branch Location is the primary work location (the time clock measures from it).
      await syncPrimaryWorkLocation(emp.id, tenantId, emp.locationId, req.staffUser!.id)
      return emp
    }
    const cur = await prisma.hrEmployee.findUniqueOrThrow({ where: { id } })
    if (ceoFlag === false && (cur.data as Record<string, unknown> | null)?.['reportsToCeo'] === true) extra['reportsToCeo'] = false
    if (cols['employeeCode'] && cols['employeeCode'] !== cur.employeeCode &&
        await prisma.hrEmployee.findFirst({ where: { tenantId, employeeCode: String(cols['employeeCode']), NOT: { id } } })) {
      throw new AppError('DUPLICATE_CODE', `Employee ID ${cols['employeeCode']} is already used`, 409)
    }
    // Salary on the master can be corrected by HR, but a change is recorded —
    // the salary history should not have silent gaps.
    const salaryChanged = (cols['grossSalaryCents'] !== undefined && cols['grossSalaryCents'] !== cur.grossSalaryCents)
    const emp = await prisma.hrEmployee.update({
      where: { id },
      data: { ...(cols as object), data: { ...(cur.data as object), ...extra } as Prisma.InputJsonValue } as Prisma.HrEmployeeUncheckedUpdateInput,
    })
    // A new Branch Location becomes the primary work location (work locations stay in step with it).
    if (emp.locationId && emp.locationId !== cur.locationId) await syncPrimaryWorkLocation(emp.id, tenantId, emp.locationId, req.staffUser!.id)
    await audit({
      category: 'identity', action: salaryChanged ? 'hr.employee.salary_edit' : 'hr.employee.update', entity: 'HrEmployee', entityId: id,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId,
      before: salaryChanged ? { grossSalaryCents: cur.grossSalaryCents } : undefined,
      after: { ...(salaryChanged ? { grossSalaryCents: emp.grossSalaryCents } : { fields: Object.keys(v.data) }), ...(selfEdit && { selfEdit: true }) },
    })
    return emp
  }

  fastify.post('/employees', { preHandler: requireAuth(...HR_ADMIN) }, async (req, reply) => reply.status(201).send(await saveEmployee(req, null)))
  fastify.patch<{ Params: { id: string } }>('/employees/:id', { preHandler: requireAuth(...HR_ADMIN) }, async (req) => saveEmployee(req, req.params.id))

  // Link a servd login to an employee — unlocks self-service and HOD approvals.
  fastify.post<{ Params: { id: string } }>('/employees/:id/link-user', { preHandler: requireAuth(...HR_ADMIN) }, async (req) => {
    const { userId } = z.object({ userId: z.string().uuid().nullable() }).parse(req.body)
    const emp = await prisma.hrEmployee.findFirst({ where: { id: req.params.id, ...writeTenants(req) } })
    if (!emp) throw new NotFoundError('Employee', req.params.id)
    // The link is what "your own request" is checked against, so nobody moves
    // their own: unlinking yourself would let you approve for yourself.
    if (emp.userId === req.staffUser!.id || userId === req.staffUser!.id) {
      throw new ForbiddenError('You cannot link or unlink your own login — ask another HR user')
    }
    if (userId) {
      // Only a login that belongs to the employee's company — the same
      // membership the auth middleware grants (active company or a TenantMember row).
      const u = await prisma.user.findFirst({
        where: { id: userId, deletedAt: null, OR: [{ tenantId: emp.tenantId }, { tenantMemberships: { some: { tenantId: emp.tenantId } } }] },
      })
      if (!u) throw new NotFoundError('User', userId)
      // One employee record per login PER COMPANY (decision 31): a head-office
      // person on two companies' payrolls is linked in each.
      const taken = await prisma.hrEmployee.findFirst({ where: { userId, tenantId: emp.tenantId, NOT: { id: emp.id } } })
      if (taken) throw new AppError('ALREADY_LINKED', `That login is already linked to ${taken.fullName} in this company`, 409)
    }
    let updated: HrEmployee
    try {
      updated = await prisma.hrEmployee.update({ where: { id: emp.id }, data: { userId } })
    } catch (err) {
      // Until the hr_employees.userId index is per company, the database still
      // holds one link per login across ALL companies.
      if ((err as { code?: string }).code === 'P2002') {
        throw new AppError('ALREADY_LINKED_ELSEWHERE', 'That login is linked to an employee in another company. Linking one login in two companies needs the per-company link migration — ask the admin.', 409)
      }
      throw err
    }
    // Someone with a login punches as themselves; a kiosk PIN is for staff
    // without one.
    if (userId) await clearKioskPin(emp.id)
    await audit({
      category: 'identity', action: 'hr.employee.link_user', entity: 'HrEmployee', entityId: emp.id,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId: emp.tenantId, before: { userId: emp.userId }, after: { userId },
    })
    return updated
  })

  // ── Kiosk PIN (staff without a login) ────────────────────────────────────
  // Decision 32: staff who have no servd login punch at the shared kiosk with
  // their employee code and a PIN HR sets here.
  fastify.post<{ Params: { id: string } }>('/employees/:id/kiosk-pin', { preHandler: requireAuth(...HR_ADMIN) }, async (req) => {
    const { pin } = z.object({ pin: z.string().max(12) }).parse(req.body)
    const emp = await prisma.hrEmployee.findFirst({ where: { id: req.params.id, ...writeTenants(req) } })
    if (!emp) throw new NotFoundError('Employee', req.params.id)
    if (emp.userId) throw new AppError('HAS_LOGIN', 'This employee has a servd login — they clock in with it, not a kiosk PIN', 409)
    if (!['active', 'on_leave'].includes(emp.status)) throw new AppError('NOT_EMPLOYED', 'Only a current employee can have a kiosk PIN', 409)
    await setKioskPin(emp.id, pin)
    await audit({ category: 'identity', action: 'hr.employee.kiosk_pin_set', entity: 'HrEmployee', entityId: emp.id, userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId: emp.tenantId })
    return { ok: true, kioskPinSet: true }
  })
  fastify.delete<{ Params: { id: string } }>('/employees/:id/kiosk-pin', { preHandler: requireAuth(...HR_ADMIN) }, async (req) => {
    const emp = await prisma.hrEmployee.findFirst({ where: { id: req.params.id, ...writeTenants(req) } })
    if (!emp) throw new NotFoundError('Employee', req.params.id)
    await clearKioskPin(emp.id)
    await audit({ category: 'identity', action: 'hr.employee.kiosk_pin_clear', entity: 'HrEmployee', entityId: emp.id, userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId: emp.tenantId })
    return { ok: true, kioskPinSet: false }
  })

  // ── Logins ↔ employees (decision 31) ─────────────────────────────────────
  // HR is the person master; a login is access only. Not every login has an
  // employee record (the CEO, co-owners, agency users) and not every employee
  // has a login (most kitchen staff).

  // GET /hr/logins — the link picker: this company's logins, names and roles
  // only, with who each is already linked to here. HR can use it (the full
  // /auth/users list is managers-only and carries more than HR needs).
  fastify.get<{ Querystring: { tenantId?: string } }>('/logins', { preHandler: HR_BACK_OFFICE }, async (req) => {
    const tenantId = await pickerTenant(req)
    const [users, links] = await Promise.all([
      prisma.user.findMany({
        where: { deletedAt: null, OR: [{ tenantId }, { tenantMemberships: { some: { tenantId } } }] },
        select: { id: true, name: true, email: true, role: true, isActive: true },
        orderBy: { name: 'asc' },
      }),
      prisma.hrEmployee.findMany({ where: { tenantId, userId: { not: null } }, select: { id: true, userId: true, fullName: true, employeeCode: true } }),
    ])
    const byUser = new Map(links.map((l) => [l.userId!, l]))
    return users.map((u) => ({ ...u, linkedEmployee: byUser.get(u.id) ? { id: byUser.get(u.id)!.id, fullName: byUser.get(u.id)!.fullName, employeeCode: byUser.get(u.id)!.employeeCode } : null }))
  })

  // GET /hr/people-links?userIds=a,b — for Workforce: the HR record linked to
  // each login in every company the caller belongs to. Name, phone,
  // designation, department and status — never pay. HR owns those fields;
  // Workforce shows them read-only next to the login.
  fastify.get<{ Querystring: { userIds?: string } }>('/people-links', { preHandler: requireAuth(...PEOPLE_READERS) }, async (req) => {
    const ids = (req.query.userIds ?? '').split(',').map((x) => x.trim()).filter(Boolean).slice(0, 500)
    const tenants = req.staffUser!.memberTenantIds.length ? req.staffUser!.memberTenantIds : [activeTenant(req)]
    const rows = await prisma.hrEmployee.findMany({
      where: { tenantId: { in: tenants }, userId: ids.length ? { in: ids } : { not: null } },
      select: { id: true, tenantId: true, userId: true, employeeCode: true, fullName: true, phone: true, status: true, departmentId: true, designationId: true, gradeId: true, locationId: true, managerId: true },
    })
    const label = await employeeLabelsAcross(rows)
    return rows.map((e) => ({
      userId: e.userId, employeeId: e.id, tenantId: e.tenantId, employeeCode: e.employeeCode, fullName: e.fullName, phone: e.phone,
      status: e.status, designation: label(e.designationId), department: label(e.departmentId), branch: label(e.locationId),
    }))
  })

  // GET /hr/people-reconcile — read-only: this company's active logins with
  // no employee record, employees with no login, and likely pairs by phone or
  // email for HR to confirm with link-user. Nothing is linked automatically.
  fastify.get('/people-reconcile', { preHandler: HR_BACK_OFFICE }, async (req) => {
    const tenantId = activeTenant(req)
    const [users, emps] = await Promise.all([
      prisma.user.findMany({
        where: { deletedAt: null, isActive: true, OR: [{ tenantId }, { tenantMemberships: { some: { tenantId } } }] },
        select: { id: true, name: true, email: true, phone: true, role: true },
        orderBy: { name: 'asc' },
      }),
      prisma.hrEmployee.findMany({
        where: { tenantId, status: { in: ['active', 'on_leave'] } },
        select: { id: true, employeeCode: true, fullName: true, phone: true, personalEmail: true, userId: true },
        orderBy: { employeeCode: 'asc' },
      }),
    ])
    const linked = new Set(emps.map((e) => e.userId).filter(Boolean) as string[])
    const loginsWithoutRecord = users.filter((u) => !linked.has(u.id))
    const employeesWithoutLogin = emps.filter((e) => !e.userId)
    const suggestions: Array<{ userId: string; employeeId: string; by: 'phone' | 'email' | 'name' }> = []
    for (const u of loginsWithoutRecord) {
      const hit = employeesWithoutLogin.find((e) => phoneKey(e.phone) && phoneKey(e.phone) === phoneKey(u.phone))
        ?? employeesWithoutLogin.find((e) => e.personalEmail && u.email && e.personalEmail.toLowerCase() === u.email.toLowerCase())
        ?? employeesWithoutLogin.find((e) => e.fullName.trim().toLowerCase() === u.name.trim().toLowerCase())
      if (hit) suggestions.push({ userId: u.id, employeeId: hit.id, by: phoneKey(hit.phone) && phoneKey(hit.phone) === phoneKey(u.phone) ? 'phone' : hit.personalEmail && u.email && hit.personalEmail.toLowerCase() === u.email.toLowerCase() ? 'email' : 'name' })
    }
    return { loginsWithoutRecord, employeesWithoutLogin, suggestions }
  })

  // Leavers' logins — switched off once the last working day has passed
  // (separations.ts). A daily worker should run this for every company; until
  // it is wired, the CEO can preview and run it here.
  fastify.get('/separations/logins', { preHandler: HR_BACK_OFFICE }, async (req) =>
    loginsToDeactivate(activeTenant(req)))
  fastify.post('/separations/deactivate-logins', { preHandler: requireAuth('admin' as UserRole) }, async (req) =>
    ({ deactivated: await deactivateLeftLogins(activeTenant(req)) }))

  // ── Documents ─────────────────────────────────────────────────────────────
  fastify.get<{ Querystring: { employeeId?: string; expiringDays?: string } }>('/documents', { preHandler: requireAuth(...HR_ADMIN) }, async (req) => {
    const days = req.query.expiringDays ? parseInt(req.query.expiringDays, 10) : null
    return prisma.hrDocument.findMany({
      where: {
        ...inTenants(req),
        ...(req.query.employeeId && { employeeId: req.query.employeeId }),
        ...(days != null && { expiryDate: { not: null, lte: new Date(Date.now() + days * 86_400_000) } }),
      },
      include: { employee: { select: { fullName: true, employeeCode: true } } },
      orderBy: [{ expiryDate: 'asc' }, { createdAt: 'desc' }],
      take: 1000,
    })
  })

  const docSchema = z.object({
    employeeId: z.string().uuid(),
    docType: z.string().min(1).max(60),
    title: z.string().max(160).optional(),
    fileUrl: z.string().url().max(1000).optional(),
    issueDate: z.string().optional(),
    expiryDate: z.string().optional(),
    notes: z.string().max(1000).optional(),
  })
  fastify.post('/documents', { preHandler: requireAuth(...HR_ADMIN) }, async (req, reply) => {
    const body = docSchema.parse(req.body)
    const emp = await prisma.hrEmployee.findFirst({ where: { id: body.employeeId, ...writeTenants(req) } })
    if (!emp) throw new NotFoundError('Employee', body.employeeId)
    const doc = await prisma.hrDocument.create({
      data: {
        tenantId: emp.tenantId, employeeId: emp.id, docType: body.docType, title: body.title || null, fileUrl: body.fileUrl || null,
        issueDate: body.issueDate ? new Date(body.issueDate) : null, expiryDate: body.expiryDate ? new Date(body.expiryDate) : null, notes: body.notes || null,
      },
    })
    return reply.status(201).send(doc)
  })
  fastify.post<{ Params: { id: string } }>('/documents/:id/verify', { preHandler: requireAuth(...HR_ADMIN) }, async (req) => {
    const doc = await prisma.hrDocument.findFirst({ where: { id: req.params.id, ...writeTenants(req) } })
    if (!doc) throw new NotFoundError('Document', req.params.id)
    return prisma.hrDocument.update({ where: { id: doc.id }, data: { verifiedById: req.staffUser!.id, verifiedAt: new Date() } })
  })
  fastify.delete<{ Params: { id: string } }>('/documents/:id', { preHandler: requireAuth(...HR_ADMIN) }, async (req, reply) => {
    const doc = await prisma.hrDocument.findFirst({ where: { id: req.params.id, ...writeTenants(req) }, include: { employee: { select: { fullName: true } } } })
    if (!doc) throw new NotFoundError('Document', req.params.id)
    // Trash (owner, 2026-10-15): the row is kept in the entry, then deleted.
    const { employee, ...row } = doc
    await prisma.$transaction(async (tx) => {
      await moveToTrash(tx, req, {
        type: 'hr_document', entityId: doc.id, tenantId: doc.tenantId,
        title: `${doc.title || doc.docType} — ${employee.fullName}`, subtitle: doc.docType,
        reason: trashReasonOf(req),
        snapshot: takeSnapshot('HrDocument', row),
      })
      await tx.hrDocument.delete({ where: { id: doc.id } })
    })
    return reply.status(204).send()
  })
  fastify.get('/documents/types', { preHandler: requireAuth(...HR_ADMIN) }, async () => DOCUMENT_TYPES)

  // ── Section records ───────────────────────────────────────────────────────
  fastify.get<{ Params: { section: string }; Querystring: { status?: string; employeeId?: string; stage?: string; from?: string; to?: string } }>(
    '/records/:section', { preHandler: HR_BACK_OFFICE }, async (req) => {
      const sec = recordSection(req.params.section)
      const { status, employeeId, stage, from, to } = req.query
      const formatTenantId = activeTenant(req)
      // Days punched in and never out show as missing punches, not present.
      if (sec.key === 'attendance') await Promise.all(readTenants(req).map((t) => flagMissingPunches(t)))
      const [rows, fmt] = await Promise.all([
        prisma.hrRecord.findMany({
          where: {
            ...inTenants(req), section: sec.key,
            ...(status && { status }), ...(employeeId && { employeeId }), ...(stage && { stage }),
            ...((from || to) && { startDate: { ...(from && { gte: new Date(from) }), ...(to && { lte: new Date(to) }) } }),
          },
          include: { employee: { select: { id: true, fullName: true, employeeCode: true } } },
          orderBy: { createdAt: 'desc' },
          take: 1000,
        }),
        getFormat(formatTenantId, sec.key),
      ])
      // The format is the active company's live one. A record saved under
      // another version, or another company's in portfolio view, is shown
      // with its own — GET /records/:section/:id — and the list says whose
      // format this is so the screen can tell.
      return { format: fmt, formatTenantId, records: rows.map((r) => ({ ...r, label: recordLabel(r, fmt.fields) })) }
    })

  fastify.get<{ Params: { section: string; id: string } }>('/records/:section/:id', { preHandler: HR_BACK_OFFICE }, async (req) => {
    const rec = await prisma.hrRecord.findFirst({ where: { id: req.params.id, section: req.params.section, ...inTenants(req) }, include: { employee: { select: { id: true, fullName: true, employeeCode: true } } } })
    if (!rec) throw new NotFoundError('HR record', req.params.id)
    const fmt = await getFormat(rec.tenantId, rec.section, rec.formVersion).catch(() => getFormat(rec.tenantId, rec.section))
    // What a loan or a settlement put on the books: the journal references
    // and dates, in its own company's ledger (no amounts beyond the record's).
    const refs = rec.section === 'loan'
      ? ['hr.loan.disbursement', 'hr.loan.disbursement.reversal']
      : rec.section === 'final_settlement' ? [FNF_ACCRUAL, `${FNF_ACCRUAL}.reversal`, FNF_PAYMENT] : []
    const postings = refs.length
      ? await prisma.journalEntry.findMany({
        where: { tenantId: rec.tenantId, reference: { in: refs.map((r) => `${r}:${rec.id}`) } },
        select: { id: true, reference: true, entryDate: true, description: true },
        orderBy: { createdAt: 'asc' },
      })
      : []
    return { record: rec, format: fmt, postings }
  })

  fastify.post<{ Params: { section: string } }>('/records/:section', { preHandler: HR_BACK_OFFICE }, async (req, reply) => {
    const body = z.object({ data: z.record(z.unknown()), submit: z.boolean().default(true) }).parse(req.body)
    const tenantId = activeTenant(req)
    // Through the head-office lens (D1 §6.4): only a section whose format has
    // an approval step — a section with none would approve on save.
    if (isReachOnly(req, tenantId)) {
      const sec = recordSection(req.params.section)
      const fmt = await getFormat(tenantId, sec.key)
      await assertHoMayPropose(req, tenantId, fmt.workflow.length > 0, `a ${sec.title.toLowerCase()} record (it has no approval step, so it would take effect at once)`)
    }
    const via = await viaFor(req, tenantId)
    return reply.status(201).send(await createRecord(req, tenantId, req.params.section, body.data, { submit: body.submit, viaHeadOfficeId: via }))
  })

  fastify.patch<{ Params: { section: string; id: string } }>('/records/:section/:id', { preHandler: HR_BACK_OFFICE }, async (req) => {
    const body = z.object({ data: z.record(z.unknown()) }).parse(req.body)
    const rec = await prisma.hrRecord.findFirst({ where: { id: req.params.id, section: req.params.section, ...writeTenants(req) } })
    if (!rec) throw new NotFoundError('HR record', req.params.id)
    await assertLensOwnRecord(req, rec, 'changing a record you did not raise, or one already acted on,')
    const via = await viaFor(req, rec.tenantId)
    // A moved section's old rows are kept as they were, read-only.
    const recSec = sectionByKey(rec.section)
    if (recSec?.movedTo) throw sectionMoved(recSec)
    // An advance moved from a cash request is the cash request's, not a form's.
    if (fromCashRequest(rec)) throw new AppError('LOAN_FROM_CASH_REQUEST', 'This staff advance was moved from an unsettled cash request — change it from the cash request', 409)
    const fmt = await getFormat(rec.tenantId, rec.section, rec.formVersion).catch(() => getFormat(rec.tenantId, rec.section))
    const approvals = rec.approvals as unknown as ApprovalEntry[]
    // Once an approver has acted, the content they approved is frozen. A
    // change after that is a new request, not an edit.
    // An attendance day (a punch, or one the CEO already decided) edited by hand goes back to the CEO as a manual
    // entry (owner, 2026-10-20) — it counts for payroll again only once approved.
    const attendanceResubmit = rec.section === 'attendance' && (rec.status === 'approved' || rec.status === 'rejected')
    if (!attendanceResubmit && fmt.workflow.length && (rec.status === 'approved' || rec.status === 'rejected' || approvals.length > 0)) {
      throw new AppError('LOCKED', 'This request has already been acted on and can no longer be edited', 409)
    }
    // An approved settlement is on the books with the figures it was approved
    // with (a format with no approval steps approves on save).
    if (rec.section === 'final_settlement' && rec.status === 'approved') {
      throw new AppError('LOCKED', 'This settlement is approved and booked — cancel it and raise a new one to change it', 409)
    }
    const stored = rec.data as Record<string, unknown>
    const merged = { ...stored, ...omitKeys(body.data, SERVER_OWNED[rec.section] ?? []) }
    const v = validateAgainst(fmt.fields, merged, { stored })
    if (v.errors.length) throw formErrors(v.errors)
    await checkReferences(rec.tenantId, fmt.fields, v.data)
    const cols = slotColumns(v.slots)
    // Keys starting with _ are written by logic (an effect's _before, the
    // punches an attendance day was built from) — never by a format, whose
    // keys start with a letter — so an edit keeps them. An attendance day HR
    // edits by hand is HR's from now on: a later punch will not rewrite it.
    const system = Object.fromEntries(Object.entries(stored).filter(([k2]) => k2.startsWith('_')))
    if (rec.section === 'attendance') { system['_source'] = 'hr'; system['_manual'] = true }
    // The colleague accepted THIS swap — another colleague or another day
    // needs a new answer.
    if (rec.section === 'shift_swap' && (swapPartnerOf(v.data) !== swapPartnerOf(stored) || String(cols.startDate ?? '') !== String(rec.startDate ?? ''))) delete system['_partner']
    return prisma.$transaction(async (tx) => {
      await prepareRecord(tx, rec.tenantId, rec.section, fmt.fields, cols, v.data, rec.id)
      const updated = await tx.hrRecord.update({
        where: { id: rec.id },
        data: {
          ...cols, data: { ...v.data, ...system } as Prisma.InputJsonValue, ...(via && { viaHeadOfficeId: via }),
          ...(rec.section === 'attendance' && rec.status !== 'draft' && { status: 'submitted', currentStep: 0, approvals: [] as unknown as Prisma.InputJsonValue }),
        },
      })
      return updated
    }).then((updated) => {
      // The bell: a hand-edited attendance day waits on the CEO.
      if (updated.section === 'attendance' && updated.status === 'submitted') {
        approvalWaiting('hr_request', updated.id, { round: `step:0:${updated.updatedAt.toISOString()}`, actorId: req.staffUser!.id })
      }
      return updated
    })
  })

  fastify.post<{ Params: { section: string; id: string } }>('/records/:section/:id/submit', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const rec = await prisma.hrRecord.findFirst({ where: { id: req.params.id, section: req.params.section, ...writeTenants(req) } })
    if (!rec) throw new NotFoundError('HR record', req.params.id)
    if (rec.createdById !== req.staffUser!.id && !(await hrBackOffice(req))) throw new ForbiddenError('Not your request')
    await assertLensOwnRecord(req, rec, 'submitting a record you did not raise')
    if (rec.status !== 'draft') throw new AppError('NOT_DRAFT', 'Only a draft can be submitted', 409)
    const via = await viaFor(req, rec.tenantId)
    const fmt = await getFormat(rec.tenantId, rec.section, rec.formVersion).catch(() => getFormat(rec.tenantId, rec.section))
    // With no approval steps, submitting is approving — through the same
    // final-approval path as /decide.
    const approveNow = fmt.workflow.length === 0
    // Through the lens nothing may approve on submit (its format lost its steps).
    if (approveNow) await assertHoMayPropose(req, rec.tenantId, !isReachOnly(req, rec.tenantId), 'a record with no approval step')
    await prisma.$transaction(async (tx) => {
      // A draft leave is checked again now it starts to count, under the
      // employee's booking lock, and its days are recomputed from its dates.
      let days: number | null | undefined
      if (rec.section === 'leave') {
        if (rec.employeeId) await lockEmployeeLeave(tx, rec.employeeId)
        days = (await checkLeave(rec.tenantId, rec, tx)).quantity
      }
      const leaveDays = days != null && days !== rec.quantity
        ? { quantity: days, data: { ...(rec.data as Record<string, unknown>), [fmt.fields.find((f) => f.bind === 'quantity')?.key ?? 'days']: days } as Prisma.InputJsonValue }
        : {}
      const claimed = await tx.hrRecord.updateMany({ where: { id: rec.id, status: 'draft' }, data: { status: approveNow ? 'approved' : 'submitted', ...leaveDays, ...(via && { viaHeadOfficeId: via }) } })
      if (claimed.count === 0) throw new AppError('CONFLICT', 'Someone else acted on this request first — reload', 409)
      if (approveNow) await finalApproval(tx, rec, { actorId: req.staffUser!.id, classification: classificationOf(req.body) })
    })
    if (approveNow) await applyDueEffects(rec.tenantId)
    const after = await prisma.hrRecord.findUniqueOrThrow({ where: { id: rec.id } })
    await auditShiftsRemoved(req, after)
    // The bell (queued, after the commit): the first approval step has an item to decide.
    if (after.status === 'submitted') approvalWaiting('hr_request', after.id, { round: `step:${after.currentStep}:${after.updatedAt.toISOString()}`, actorId: req.staffUser!.id })
    return after
  })

  // POST /hr/records/:section/:id/decide — approve or reject the current step.
  fastify.post<{ Params: { section: string; id: string } }>('/records/:section/:id/decide', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const body = z.object({
      decision: z.enum(['approved', 'rejected']),
      note: z.string().max(500).optional(),
      approvedHours: z.number().min(0).max(24 * 31).optional(), // overtime only
      // loan only, at its last step: where the money is paid out from (the
      // approver can see the company's banks; HR raising it may not).
      paidFrom: z.enum(['bank', 'cash']).optional(),
      bankAccountId: z.string().min(1).max(64).nullable().optional(),
    }).parse(req.body)
    // Loaded by id, then its company decides who may see it (D3 §7.4.5): a
    // member, a head-office member who reaches it, or an HR hand-over's
    // delegate. Anyone else gets 404 before anything about it is said.
    const rec = await prisma.hrRecord.findFirst({ where: { id: req.params.id, section: req.params.section } })
    if (!rec || !(await mayReachForDecision(req, rec.tenantId))) throw new NotFoundError('HR record', req.params.id)
    if (rec.status !== 'submitted') throw new AppError('NOT_PENDING', 'This request is not waiting for approval', 409)
    const fmt = await getFormat(rec.tenantId, rec.section, rec.formVersion).catch(() => getFormat(rec.tenantId, rec.section))
    const step: WorkflowStep | undefined = fmt.workflow[rec.currentStep]
    if (!step) throw new AppError('NO_STEP', 'This request has no approval step left', 409)
    const subject = await approvalSubject(rec)
    const isLast = rec.currentStep >= fmt.workflow.length - 1
    // canActOnStep plus the head-office rules (logic.ts decideRight).
    const right = await decideRight(req, rec, step, isLast, { subject, decision: body.decision })
    if (!right.ok) throw right.status === 404 ? new NotFoundError('HR record', req.params.id) : new AppError(right.code, right.message, right.status)
    const who = { ok: true, override: right.override }
    // HR's step (or HR standing in for a missing HOD) is the back office: the
    // CEO's untick of 'staff_hr' closes it (PPL-R2-01). A reporting manager's
    // own step and a management step stay with their approvers.
    if (stepIsHrWork(step.role, req.staffUser!, subject.managerUserId) && !(await holdsStaffHr(req))) {
      throw new ForbiddenError('Your account does not have access to this module (staff_hr). Ask the CEO to enable it in Module Access.')
    }
    // A swap moves a colleague's shift: it is approved only once that
    // colleague has accepted it (HR-R5). Rejecting needs no answer.
    if (body.decision === 'approved' && swapAwaitsPartner(rec)) {
      throw new AppError('PARTNER_NOT_ACCEPTED', 'The colleague this swap moves has not accepted it yet — it can be approved once they do', 409)
    }

    const entry: ApprovalEntry = {
      step: step.key, role: step.role, decision: body.decision, byUserId: req.staffUser!.id,
      byName: req.staffUser!.name ?? req.staffUser!.email ?? 'Unknown', at: new Date().toISOString(),
      ...(body.note && { note: body.note }), ...(who.override && { override: true }),
      ...(right.via !== 'member' && { via: right.via }), ...(right.delegationId && { delegationId: right.delegationId }),
    }
    const nextStatus = body.decision === 'rejected' ? 'rejected' : isLast ? 'approved' : 'submitted'
    // OT hours an approver settles on are kept on the record at every step, so
    // the next approver starts from them and the final amount pays them — not
    // the hours originally claimed.
    const hours = rec.section === 'overtime' && body.decision === 'approved' && body.approvedHours != null ? body.approvedHours : null
    // A loan's paying account, when the last approver names it.
    const payout = rec.section === 'loan' && nextStatus === 'approved' && (body.paidFrom !== undefined || body.bankAccountId !== undefined)
    if (payout && body.paidFrom === 'cash' && body.bankAccountId) throw new AppError('BANK_ACCOUNT_ON_CASH', 'A loan paid in cash does not use a bank account', 422)
    // A16: a transfer approved into another company's department or manager.
    if (nextStatus === 'approved') await assertTransferInCompany(prisma, rec.section, rec.tenantId, (rec.data ?? {}) as Record<string, unknown>)
    const data = {
      ...(rec.data as Record<string, unknown>),
      ...(hours != null && { approvedHours: hours }),
      ...(payout && body.paidFrom && { paidFrom: body.paidFrom }),
      ...(payout && (body.bankAccountId !== undefined || body.paidFrom === 'cash') && { bankAccount: body.paidFrom === 'cash' ? null : body.bankAccountId ?? null }),
    }
    const dataChanged = hours != null || payout
    const hoursOnQuantity = hours != null && fmt.fields.find((f) => f.key === 'approvedHours')?.bind === 'quantity'

    const updated = await prisma.$transaction(async (tx) => {
      // Claim the step: two approvers clicking at once must not both advance it.
      const claimed = await tx.hrRecord.updateMany({
        where: { id: rec.id, status: 'submitted', currentStep: rec.currentStep },
        data: {
          status: nextStatus,
          currentStep: body.decision === 'approved' && !isLast ? rec.currentStep + 1 : rec.currentStep,
          approvals: [...(rec.approvals as unknown as ApprovalEntry[]), entry] as unknown as Prisma.InputJsonValue,
          ...(dataChanged && { data: data as Prisma.InputJsonValue }),
          ...(hoursOnQuantity && { quantity: hours }),
        },
      })
      if (claimed.count === 0) throw new AppError('CONFLICT', 'Someone else acted on this request first — reload', 409)
      if (nextStatus === 'approved') {
        await finalApproval(tx, { ...rec, data: data as Prisma.JsonValue, ...(hoursOnQuantity && { quantity: hours }) }, { approvedHours: hours, actorId: req.staffUser!.id, classification: classificationOf(req.body) })
      }
      return tx.hrRecord.findUniqueOrThrow({ where: { id: rec.id } })
    })
    if (nextStatus === 'approved') await applyDueEffects(rec.tenantId)
    await auditShiftsRemoved(req, updated)
    await audit({
      category: 'identity', action: `hr.${rec.section}.${body.decision}`, entity: 'HrRecord', entityId: rec.id,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId: rec.tenantId,
      after: { step: step.key, status: nextStatus, override: who.override },
    })
    // D3 §7.8: every decision on a delegable type (hr_request is one) also
    // writes approval.decide — in the record's company (A19), never the
    // decider's. `path` says how the right was held (member / reach / delegation).
    {
      const grant: ApprovalGrant = right.via === 'delegation' && right.delegationId ? { via: 'delegation', delegationId: right.delegationId } : { via: 'role' }
      await auditApproval(req, {
        type: 'hr_request', id: rec.id, tenantId: rec.tenantId, decision: body.decision === 'approved' ? 'approve' : 'reject', grant, entity: 'HrRecord',
        metadata: { section: rec.section, step: step.key, path: right.via, final: nextStatus === 'approved', decidedAt: entry.at, ...(body.note && { note: body.note }), ...(rec.viaHeadOfficeId && { viaHeadOfficeId: rec.viaHeadOfficeId }) },
      })
    }
    // The bell: an approved step that has a next step is now waiting on its approver(s).
    if (updated.status === 'submitted') approvalWaiting('hr_request', updated.id, { round: `step:${updated.currentStep}:${updated.updatedAt.toISOString()}`, actorId: req.staffUser!.id })
    return updated
  })

  fastify.post<{ Params: { section: string; id: string } }>('/records/:section/:id/stage', { preHandler: HR_BACK_OFFICE }, async (req) => {
    const { stage } = z.object({ stage: z.string().min(1).max(60) }).parse(req.body)
    const rec = await prisma.hrRecord.findFirst({ where: { id: req.params.id, section: req.params.section, ...writeTenants(req) } })
    if (!rec) throw new NotFoundError('HR record', req.params.id)
    const fmt = await getFormat(rec.tenantId, rec.section)
    if (!fmt.stages.includes(stage)) throw new AppError('BAD_STAGE', `Stage must be one of: ${fmt.stages.join(', ')}`, 400)
    return prisma.hrRecord.update({ where: { id: rec.id }, data: { stage } })
  })

  // Cancel. Anyone may withdraw their own request until an approver has acted
  // on it; after that only HR can cancel, and not once it has taken effect.
  fastify.post<{ Params: { section: string; id: string } }>('/records/:section/:id/cancel', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const rec = await prisma.hrRecord.findFirst({ where: { id: req.params.id, section: req.params.section, ...writeTenants(req) } })
    if (!rec) throw new NotFoundError('HR record', req.params.id)
    // Through the head-office lens: only your own record nobody has acted on.
    await assertLensOwnRecord(req, rec, "cancelling a record you did not raise, or one already acted on,")
    const via = await viaFor(req, rec.tenantId)
    // HR's power to cancel anyone's record needs the back-office module too
    // (PPL-R2-01); without it an HR login withdraws only its own requests.
    if (!(await hrBackOffice(req))) {
      if (rec.createdById !== req.staffUser!.id) throw new ForbiddenError('Not your request')
      if (!(rec.status === 'draft' || rec.status === 'submitted') || (rec.approvals as unknown as ApprovalEntry[]).length > 0) {
        throw new AppError('ACTED_ON', 'An approver has already acted on this request — ask HR to cancel it', 409)
      }
    }
    if (rec.status === 'cancelled') throw new AppError('ALREADY_CANCELLED', 'This record is already cancelled', 409)
    if (rec.appliedAt) throw new AppError('APPLIED', 'This has already taken effect and cannot be cancelled — raise a new request to reverse it', 409)
    // A staff advance moved from an unsettled cash request: cancelling here
    // would put the advance back on 1355 while the request reads 'converted'.
    // It is reversed from the cash request (advanceLoan.ts).
    if (fromCashRequest(rec)) {
      throw new AppError('LOAN_FROM_CASH_REQUEST', 'This staff advance was moved from an unsettled cash request — reverse it from the cash request, not here', 409)
    }
    if (rec.section === 'loan' && rec.status === 'approved') {
      // Once an installment sits on any payslip — draft, approved or locked —
      // cancelling would leave that payroll deducting for a loan that no
      // longer exists. It comes off the payslip first.
      const slips = await prisma.hrPayslip.findMany({
        where: { tenantId: rec.tenantId, ...(rec.employeeId && { employeeId: rec.employeeId }) },
        select: { inputs: true, run: { select: { period: true, status: true } } },
      })
      const on = slips.find((sl) => (((sl.inputs as Record<string, unknown>)['loans'] as Array<{ loanId: string; cents: number }> | undefined) ?? [])
        .some((l) => l.loanId === rec.id && l.cents > 0))
      if (on) {
        throw new AppError('ON_PAYROLL', `An installment of this loan is on the ${on.run.period} payroll (${on.run.status}) — take it off that payroll before cancelling the loan`, 409)
      }
      // …and the same for a full & final that recovered it.
      const settlements = await prisma.hrRecord.findMany({
        where: { tenantId: rec.tenantId, section: 'final_settlement', status: 'approved', ...(rec.employeeId && { employeeId: rec.employeeId }) },
        select: { data: true },
      })
      if (settlements.some((st) => settlementLoansOf(st.data).some((l) => l.loanId === rec.id && l.cents > 0))) {
        throw new AppError('ON_SETTLEMENT', 'This loan is recovered in an approved full & final settlement — cancel that settlement before cancelling the loan', 409)
      }
    }
    // A settlement that has been paid stays: the money has left.
    const settlementBooked = rec.section === 'final_settlement' && rec.status === 'approved'
    if (settlementBooked && ((rec.data ?? {}) as Record<string, unknown>)['_paidAt']) {
      throw new AppError('FNF_PAID', 'This settlement has been paid and cannot be cancelled', 409)
    }
    // Claim: an approval or an effect landing between the read and here must
    // not end up on a record that also says cancelled.
    await prisma.$transaction(async (tx) => {
      if (settlementBooked) {
        // Serialised with "Mark paid": a payment landing meanwhile wins.
        await lockSettlement(tx, rec.id)
        const fresh = await tx.hrRecord.findUniqueOrThrow({ where: { id: rec.id }, select: { data: true } })
        if (((fresh.data ?? {}) as Record<string, unknown>)['_paidAt']) throw new AppError('FNF_PAID', 'This settlement has been paid and cannot be cancelled', 409)
      }
      const claimed = await tx.hrRecord.updateMany({
        where: { id: rec.id, status: rec.status, currentStep: rec.currentStep, appliedAt: null },
        data: { status: 'cancelled', ...(via && { viaHeadOfficeId: via }) },
      })
      if (claimed.count === 0) throw new AppError('CONFLICT', 'This record changed while you were cancelling it — reload', 409)
      // An approved loan was paid out on the books; cancelling takes it back —
      // the reversal flips its lines, so it credits back the place it was paid from.
      if (rec.section === 'loan' && rec.status === 'approved') {
        const posted = await tx.journalEntry.findFirst({ where: { tenantId: rec.tenantId, reference: `hr.loan.disbursement:${rec.id}` }, select: { id: true } })
        if (posted) await reverseJournalEntry(rec.tenantId, 'hr.loan.disbursement', rec.id, 'Loan cancelled', { tx, postedBy: req.staffUser!.id })
      }
      // An approved settlement was booked; cancelling takes it back (a closed
      // period today is 422 and nothing is cancelled).
      if (settlementBooked) {
        const posted = await tx.journalEntry.findFirst({ where: { tenantId: rec.tenantId, reference: `${FNF_ACCRUAL}:${rec.id}` }, select: { id: true } })
        if (posted) await reverseJournalEntry(rec.tenantId, FNF_ACCRUAL, rec.id, 'Full & final settlement cancelled', { tx, postedBy: req.staffUser!.id })
      }
    })
    await audit({
      category: 'identity', action: `hr.${rec.section}.cancel`, entity: 'HrRecord', entityId: rec.id,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId: rec.tenantId, before: { status: rec.status }, after: { status: 'cancelled' },
    })
    return prisma.hrRecord.findUniqueOrThrow({ where: { id: rec.id } })
  })

  fastify.get<{ Params: { section: string }; Querystring: { status?: string; from?: string; to?: string; format?: string } }>('/records/:section/export.csv', { preHandler: HR_BACK_OFFICE }, async (req, reply) => {
    const sec = recordSection(req.params.section)
    const fmt = await getFormat(activeTenant(req), sec.key)
    const { status, from, to } = req.query
    const rows = await prisma.hrRecord.findMany({ where: {
      ...inTenants(req), section: sec.key, ...(status && { status }),
      ...((from || to) && { startDate: { ...(from && { gte: new Date(from) }), ...(to && { lte: new Date(to) }) } }),
    }, include: { employee: { select: { fullName: true, employeeCode: true } } }, orderBy: { createdAt: 'asc' } })
    const cols = fmt.fields.filter((f) => f.type !== 'table')
    // Printed the way the reports print them: money in rupees, references by name.
    const show = await resolver(rows, cols)
    const head = ['Record', 'Status', 'Stage', 'Employee ID', 'Employee', ...cols.map((c) => c.label), 'Created']
    const body = rows.map((r) => [r.id, r.status, r.stage, r.employee?.employeeCode, r.employee?.fullName, ...cols.map((c) => show(c, (r.data as Record<string, unknown>)[c.key])), r.createdAt])
    const out = csv([head, ...body])
    // ?format=xlsx|pdf: the same rows through lib/reportExport.ts (the record id stays in the CSV only).
    const m = fromMatrix(head, body, head.map(() => 'text' as const))
    return sendReportFor(req, reply, exportFormatOf(req.query.format, 'csv')!, `hr-${sec.key}`, {
      title: `HR — ${sec.key.replace(/_/g, ' ')}`, ...(from || to ? { period: `${from ?? '…'} to ${to ?? '…'}` } : {}),
      ...m, hide: ['c0'], csv: out,
    })
  })

  // Offer → Employee Master.
  fastify.post<{ Params: { id: string } }>('/records/offer/:id/create-employee', { preHandler: HR_BACK_OFFICE }, async (req, reply) => {
    const rec = await prisma.hrRecord.findFirst({ where: { id: req.params.id, section: 'offer', ...writeTenants(req) } })
    if (!rec) throw new NotFoundError('Offer', req.params.id)
    // Through the head-office lens (A6): only from your own offer.
    if (isReachOnly(req, rec.tenantId)) await assertHoMayPropose(req, rec.tenantId, rec.createdById === req.staffUser!.id, "creating an employee from an offer you did not raise")
    if (rec.status !== 'approved') throw new AppError('NOT_APPROVED', 'The offer must be approved first', 409)
    const via = await viaFor(req, rec.tenantId)
    const d = rec.data as Record<string, unknown>
    if (d['acceptance'] && d['acceptance'] !== 'accepted') throw new AppError('NOT_ACCEPTED', 'The offer has not been accepted', 409)
    if (d['_employeeId']) throw new AppError('ALREADY_CREATED', 'An employee was already created from this offer', 409)
    if ((rec.amountCents ?? 0) < 0) throw new AppError('NEGATIVE_AMOUNT', 'The offered salary is negative — correct the offer first', 422)
    const s = await getSettings(rec.tenantId)
    const codes = await prisma.hrEmployee.findMany({ where: { tenantId: rec.tenantId }, select: { employeeCode: true } })
    const probMonths = typeof d['probationMonths'] === 'number' ? d['probationMonths'] as number : 0
    const joining = rec.startDate
    const emp = await prisma.hrEmployee.create({
      data: {
        tenantId: rec.tenantId,
        employeeCode: nextEmployeeCode(s.employeeCodePrefix, codes.map((c) => c.employeeCode)),
        fullName: String(d['candidateName'] ?? 'New employee'),
        designationId: typeof d['designation'] === 'string' ? d['designation'] : null,
        departmentId: typeof d['department'] === 'string' ? d['department'] : null,
        locationId: typeof d['location'] === 'string' ? d['location'] : null,
        grossSalaryCents: rec.amountCents ?? 0,
        joiningDate: joining,
        employmentType: probMonths > 0 ? 'probation' : 'permanent',
        probationEnd: joining && probMonths > 0 ? new Date(Date.UTC(joining.getUTCFullYear(), joining.getUTCMonth() + probMonths, joining.getUTCDate())) : null,
        noticePeriodDays: typeof d['noticePeriodDays'] === 'number' ? d['noticePeriodDays'] as number : null,
        createdById: req.staffUser!.id,
        data: { fromOfferId: rec.id } as Prisma.InputJsonValue,
      },
    })
    await prisma.hrRecord.update({ where: { id: rec.id }, data: { data: { ...d, _employeeId: emp.id } as Prisma.InputJsonValue, ...(via && { viaHeadOfficeId: via }) } })
    await audit({
      category: 'identity', action: 'hr.employee.create_from_offer', entity: 'HrEmployee', entityId: emp.id, userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId: rec.tenantId, after: { offerId: rec.id },
      ...(via && { metadata: { viaHeadOfficeId: via } }),
    })
    return reply.status(201).send(emp)
  })

  // Full & final — work the figures out from what HR already holds. It picks
  // up where payroll left off: salary for the days after the last payroll the
  // employee is on — whatever its status: a draft that has them will pay that
  // month, so the settlement must not (finance gaps: "F&F can pay a month
  // twice") — OT and loans net of what those runs paid and recovered, the
  // paid leave earned this leave year and not taken, and the income tax,
  // EOBI and SESSI a payslip takes for the same days. With `recordId` (the
  // settlement being worked on) what it was worked out from is stamped on it,
  // so approval can tell when payroll has moved since.
  fastify.post('/final-settlement/calculate', { preHandler: requireAuth(...HR_ADMIN) }, async (req) => {
    const body = z.object({
      employeeId: z.string().uuid(), lastWorkingDay: z.string(), unpaidMonthSalary: z.boolean().default(true),
      recordId: z.string().uuid().optional(),
    }).parse(req.body)
    const found = await prisma.hrEmployee.findFirst({ where: { id: body.employeeId, ...writeTenants(req) } })
    if (!found) throw new NotFoundError('Employee', body.employeeId)
    await assertNotTransferred(prisma, found.tenantId, found.id)
    const lwd = parseHrDate(body.lastWorkingDay)
    if (!lwd) throw new AppError('BAD_DATE', 'Last working day is not a date', 400)
    const target = body.recordId
      ? await prisma.hrRecord.findFirst({ where: { id: body.recordId, section: 'final_settlement', ...writeTenants(req) } })
      : null
    if (body.recordId && !target) throw new NotFoundError('Full & final settlement', body.recordId)
    if (target && (target.tenantId !== found.tenantId || (target.employeeId && target.employeeId !== found.id))) {
      throw new AppError('COMPANY_MISMATCH', 'That settlement is for another employee', 422)
    }
    // A revision that has come due but that nothing has applied yet.
    await applyDueEffects(found.tenantId)
    const emp = await prisma.hrEmployee.findUniqueOrThrow({ where: { id: found.id } })
    const s = await getSettings(emp.tenantId)
    const lastRun = await prisma.hrPayrollRun.findFirst({
      where: { tenantId: emp.tenantId, status: { in: ALL_RUN_STATUSES }, payslips: { some: { employeeId: emp.id } } },
      orderBy: { period: 'desc' }, select: { period: true, status: true },
    })
    const salaryFrom = !body.unpaidMonthSalary ? null : lastRun ? new Date(periodEnd(lastRun.period).getTime() + 1) : periodStart(periodOf(lwd))
    const otFrom = await firstPayrollStart(emp.tenantId, periodStart(periodOf(lwd)))
    const [ot, balances, loans, grossSalaryCents] = await Promise.all([
      unpaidOvertime(emp.tenantId, emp.id, otFrom, lwd, { runStatuses: ALL_RUN_STATUSES }),
      leaveBalancesFor(emp.tenantId, emp.id, lwd),
      loansFor(emp.tenantId, emp.id, { runStatuses: ALL_RUN_STATUSES, ...(target && { exceptSettlementId: target.id }) }),
      salaryForPeriod(emp, periodOf(lwd)),
    ])
    // Each month it pays salary for, at that month's own salary.
    const salaryByPeriod: Record<string, number> = {}
    if (salaryFrom && salaryFrom <= lwd) {
      for (let p = periodOf(salaryFrom); p <= periodOf(lwd); p = nextPeriod(p)) salaryByPeriod[p] = await salaryForPeriod(emp, p)
    }
    // The final month(s) are docked for absences and approved unpaid leave
    // exactly as payroll docks them (owner, 2026-10-16).
    const attendanceByPeriod = await settlementAttendance(emp.tenantId, emp.id, emp.joiningDate, salaryFrom, lwd, s)
    const leaveDays = Math.round(balances.filter((b) => b.paid).reduce((a, b) => a + accruedLeaveDays(b, b.yearFrom, emp.joiningDate, lwd), 0) * 100) / 100
    // Gratuity (H6) on the last gross — the gross in force at the last working
    // day, worked out above (never a second salaryForPeriod).
    const g = gratuityFor(emp, lwd, grossSalaryCents, s.gratuity)
    assertInt4Fits(g.amountCents, 'The gratuity')
    const r = finalSettlement({ ...emp, grossSalaryCents }, lwd, {
      salaryFrom,
      otPayableCents: ot.reduce((a, o) => a + (o.amountCents ?? 0), 0),
      leaveBalanceDays: leaveDays,
      loanOutstandingCents: loans.reduce((a, l) => a + l.outstandingCents, 0),
      deductionsCents: 0, otherAdjustmentsCents: 0,
      salaryByPeriod,
      attendanceByPeriod,
      gratuityCents: g.amountCents,
    }, s)
    // Stamped only while the settlement can still be edited: once an
    // approver has acted, its figures are the ones they approved.
    const approvals = (target?.approvals ?? []) as unknown as ApprovalEntry[]
    if (target && (target.status === 'draft' || target.status === 'submitted') && approvals.length === 0) {
      const calc: SettlementCalc = {
        salaryFrom: salaryFrom ? salaryFrom.toISOString() : null, lastWorkingDay: lwd.toISOString(),
        paidThrough: lastRun?.period ?? null, unpaidMonthSalary: body.unpaidMonthSalary, at: new Date().toISOString(),
      }
      await prisma.hrRecord.update({
        where: { id: target.id },
        data: { data: { ...((target.data ?? {}) as Record<string, unknown>), _calc: calc } as unknown as Prisma.InputJsonValue },
      })
    }
    return {
      ...r, leaveBalanceDays: leaveDays,
      gratuityDetail: {
        eligible: g.eligible, reason: g.reason, joiningDate: emp.joiningDate ? emp.joiningDate.toISOString() : null,
        employmentType: emp.employmentType,
        years: g.years, months: g.months, days: g.days, countedYears: g.countedYears, lastGrossCents: grossSalaryCents,
        daysPerYear: s.gratuity.daysPerYear,
      },
      salaryFrom: salaryFrom ? salaryFrom.toISOString() : null,
      paidThrough: lastRun?.period ?? null, paidThroughStatus: lastRun?.status ?? null,
      finalMonthAlreadyPaid: !!lastRun && lastRun.period >= periodOf(lwd),
    }
  })

  // POST /hr/final-settlement/:id/paid {bankAccountId? | cash, paidOn?} — the
  // leaver has been paid (finance gaps #2): Dr Wages payable / Cr the bank
  // named (it must be a live, linked bank of the settlement's own company —
  // 422 otherwise), the company's only bank, or the safe; dated paidOn
  // (default today, never in the future; a closed day is 422). Booked first if
  // its approval was not. A second call is 409, never a second entry.
  fastify.post<{ Params: { id: string } }>('/final-settlement/:id/paid', { preHandler: PAYROLL_PAYER_GUARD }, async (req) => {
    const body = z.object({
      cash: z.boolean().optional(),
      bankAccountId: z.string().min(1).max(64).nullable().optional(),
      paidOn: z.string().optional(),
    }).parse(req.body ?? {})
    const rec = await prisma.hrRecord.findFirst({ where: { id: req.params.id, section: 'final_settlement', ...writeTenants(req) } })
    if (!rec) throw new NotFoundError('Full & final settlement', req.params.id)
    // Separation of duties (owner, 2026-10-16): nobody marks their own
    // settlement paid — the CEO included.
    if (rec.employeeId && await prisma.hrEmployee.count({ where: { id: rec.employeeId, userId: req.staffUser!.id } })) {
      throw new AppError('OWN_PAY_IN_RUN', 'This is your own settlement — someone else marks it paid', 403)
    }
    // The move refuses anyone with an approved settlement (hr/transfer.ts), so
    // this only catches data from before that rule — never pay it from here.
    await assertNotTransferred(prisma, rec.tenantId, rec.employeeId)
    const paidOn = paidOnOf(body.paidOn)
    const fmt = await getFormat(rec.tenantId, rec.section, rec.formVersion).catch(() => getFormat(rec.tenantId, rec.section))
    const updated = await postFinalSettlementPayment(rec.id, req.staffUser!.id, {
      cash: body.cash === true, bankAccountId: body.bankAccountId ?? null, paidOn,
      dateKey: fmt.fields.find((f) => f.bind === 'effectiveDate')?.key ?? null,
      classification: classificationOf(req.body),
    })
    const d = (updated.data ?? {}) as Record<string, unknown>
    await audit({
      category: 'identity', action: 'hr.final_settlement.paid', entity: 'HrRecord', entityId: rec.id,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId: rec.tenantId,
      after: { paidOn: d['_paidOn'], paidFrom: d['_paidFrom'], amountCents: d['_paidCents'] },
    })
    return updated
  })

  // POST /hr/final-settlement/post-unposted — book the active company's
  // settlements approved before approval booked them, dated today. One at a
  // time: a settlement the ledger refuses is listed with the reason and the
  // rest still post.
  // GET /hr/final-settlement/to-pay — approved settlements of the companies
  // in view that are not marked paid yet (finance's "to pay" list on the
  // Payroll page; finance cannot open the HR back office).
  fastify.get('/final-settlement/to-pay', { preHandler: PAYROLL_PAYER_GUARD }, async (req) => {
    const recs = await prisma.hrRecord.findMany({
      where: { section: 'final_settlement', status: 'approved', ...inTenants(req) },
      include: { employee: { select: { id: true, fullName: true, employeeCode: true, userId: true } } },
      orderBy: { createdAt: 'asc' },
      take: 200,
    })
    const me = req.staffUser!.id
    return recs
      .filter((r) => !((r.data ?? {}) as Record<string, unknown>)['_paidAt'])
      .map(({ employee, ...r }) => ({
        ...r,
        employee: employee ? { id: employee.id, fullName: employee.fullName, employeeCode: employee.employeeCode } : null,
        ownPay: employee?.userId === me,
      }))
  })

  fastify.post('/final-settlement/post-unposted', { preHandler: PAYROLL_PAYER_GUARD }, async (req) => {
    const tenantId = activeTenant(req)
    const recs = await prisma.hrRecord.findMany({
      where: { tenantId, section: 'final_settlement', status: 'approved' },
      include: { employee: { select: { fullName: true, employeeCode: true } } },
      orderBy: { createdAt: 'asc' },
    })
    const posted = await prisma.journalEntry.findMany({
      where: { tenantId, reference: { in: recs.map((r) => `${FNF_ACCRUAL}:${r.id}`) } },
      select: { reference: true },
    })
    const done = new Set(posted.map((p) => p.reference))
    const out = { posted: [] as string[], alreadyPosted: 0, failed: [] as Array<{ id: string; employee: string | null; reason: string }> }
    for (const r of recs) {
      if (done.has(`${FNF_ACCRUAL}:${r.id}`)) { out.alreadyPosted++; continue }
      try {
        await prisma.$transaction((tx) => postFinalSettlementAccrual(tx, r, req.staffUser!.id, { entryDate: pktToday() }))
        out.posted.push(r.id)
      } catch (err) {
        out.failed.push({ id: r.id, employee: r.employee ? `${r.employee.fullName} (${r.employee.employeeCode})` : null, reason: (err as Error).message })
      }
    }
    await audit({
      category: 'identity', action: 'hr.final_settlement.backfill', entity: 'HrRecord', entityId: null,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId,
      after: { posted: out.posted.length, alreadyPosted: out.alreadyPosted, failed: out.failed.length },
    })
    return out
  })

  // ── Payroll ───────────────────────────────────────────────────────────────
  fastify.get('/payroll/runs', { preHandler: requireAuth(...PAYROLL_READERS) }, async (req) => {
    const runs = await prisma.hrPayrollRun.findMany({ where: inTenants(req), orderBy: { period: 'desc' }, take: 60 })
    // Internal payment classification (2026-10-20) of each paid run's payment entry — a reporting label (salary report).
    const classes = await classificationsOfReferences(prisma, [...new Set(runs.map((r) => r.tenantId))], runs.filter((r) => r.paidAt).map((r) => `hr.payroll.payment:${r.id}`))
    return runs.map((r) => {
      const c = classes.get(`hr.payroll.payment:${r.id}`)
      return { ...r, paymentClassification: c?.classification ?? null, paymentEntryId: c?.journalEntryId ?? null }
    })
  })

  fastify.post('/payroll/runs', { preHandler: requireAuth(...HR_ADMIN) }, async (req, reply) => {
    const tenantId = activeTenant(req)
    const { period } = z.object({ period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }).parse(req.body)
    // Through the head-office lens (A6) a run is prepared only for a month the
    // company has none for — never pre-empting or replacing the company's own.
    if (await prisma.hrPayrollRun.findFirst({ where: { tenantId, period } })) throw new AppError('EXISTS', `There is already a payroll for ${period}`, 409)
    const via = await viaFor(req, tenantId)
    const s = await getSettings(tenantId)
    const run = await prisma.hrPayrollRun.create({ data: { tenantId, period, settings: s as unknown as Prisma.InputJsonValue, createdById: req.staffUser!.id, ...(via && { viaHeadOfficeId: via }) } })
    await flagMissingPunches(tenantId)
    await calculateRun(tenantId, run.id, req.staffUser!.id)
    if (via) {
      await audit({ category: 'identity', action: 'hr.payroll.create', entity: 'HrPayrollRun', entityId: run.id, userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId, after: { period }, metadata: { viaHeadOfficeId: via } })
    }
    const created = await prisma.hrPayrollRun.findUnique({ where: { id: run.id } })
    // The bell (queued, after the commit): a draft payroll is in the approval queue.
    approvalWaiting('payroll_run', run.id, { round: `create:${(created?.updatedAt ?? new Date()).toISOString()}`, actorId: req.staffUser!.id })
    return reply.status(201).send(created)
  })

  fastify.get<{ Params: { id: string } }>('/payroll/runs/:id', { preHandler: requireAuth(...PAYROLL_READERS) }, async (req) => {
    const run = await prisma.hrPayrollRun.findFirst({ where: { id: req.params.id, ...inTenants(req) } })
    if (!run) throw new NotFoundError('Payroll', req.params.id)
    const slips = await prisma.hrPayslip.findMany({ where: { runId: run.id }, include: { employee: { select: { fullName: true, employeeCode: true, bankName: true, iban: true, paymentMethod: true, eobiNo: true } } }, orderBy: { employee: { employeeCode: 'asc' } } })
    const c = run.paidAt ? (await classificationsOfReferences(prisma, [run.tenantId], [`hr.payroll.payment:${run.id}`])).get(`hr.payroll.payment:${run.id}`) : undefined
    return { run: { ...run, paymentClassification: c?.classification ?? null, paymentEntryId: c?.journalEntryId ?? null }, payslips: slips }
  })

  fastify.post<{ Params: { id: string } }>('/payroll/runs/:id/recalculate', { preHandler: requireAuth(...HR_ADMIN) }, async (req) => {
    const run = await prisma.hrPayrollRun.findFirst({ where: { id: req.params.id, ...writeTenants(req) } })
    if (!run) throw new NotFoundError('Payroll', req.params.id)
    if (isReachOnly(req, run.tenantId)) await assertHoMayPropose(req, run.tenantId, run.status === 'draft', 'recalculating a payroll that is no longer a draft')
    await stampRunVia(req, run)
    await flagMissingPunches(run.tenantId)
    return calculateRun(run.tenantId, run.id, req.staffUser!.id)
  })

  fastify.patch<{ Params: { id: string } }>('/payroll/payslips/:id', { preHandler: requireAuth(...HR_ADMIN) }, async (req) => {
    const body = z.object({
      absentDays: z.number().min(0).max(31).optional(),
      unpaidLeaveDays: z.number().min(0).max(31).optional(),
      lateCount: z.number().int().min(0).max(62).optional(),
      otHours: z.number().min(0).optional(),
      otCents: z.number().int().min(0).optional(),
      earningAdjustmentsCents: z.number().int().min(0).optional(),
      deductionAdjustmentsCents: z.number().int().min(0).optional(),
      loanInstallmentsCents: z.number().int().min(0).optional(),
    }).parse(req.body)
    const slip = await prisma.hrPayslip.findFirst({ where: { id: req.params.id, ...writeTenants(req) }, include: { run: { select: { id: true, tenantId: true, status: true, viaHeadOfficeId: true } } } })
    if (!slip) throw new NotFoundError('Payslip', req.params.id)
    if (isReachOnly(req, slip.run.tenantId)) await assertHoMayPropose(req, slip.run.tenantId, slip.run.status === 'draft', 'editing a payslip on a payroll that is no longer a draft')
    await stampRunVia(req, slip.run)
    await recalcPayslip(slip.id, body, req.staffUser!.id)
    return prisma.hrPayslip.findUnique({ where: { id: slip.id } })
  })

  fastify.post<{ Params: { id: string } }>('/payroll/runs/:id/approve', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    // Whoever prepared payroll — created it, recalculated it or edited a
    // payslip on it — does not also approve it, except the CEO, who is
    // allowed to run a one-person office.
    const me = req.staffUser!.id
    const { run, grant } = await payrollDecision(req, req.params.id, 'approve', (r) => {
      if ((r.createdById === me || r.preparedByIds.includes(me)) && req.staffUser!.role !== 'admin') {
        throw new ForbiddenError('Payroll must be approved by someone other than the people who prepared or edited it')
      }
    })
    const blocker = await runBlocker(run.id)
    if (blocker) throw new AppError('RUN_INCOMPLETE', blocker, 409)
    // …and not in between: an edit of theirs landing after the check above.
    const unedited = req.staffUser!.role === 'admin' ? {} : { NOT: { preparedByIds: { has: me } } }
    const n = await prisma.hrPayrollRun.updateMany({ where: { id: run.id, status: 'draft', ...unedited }, data: { status: 'approved', approvedById: req.staffUser!.id, approvedAt: new Date() } })
    if (n.count === 0) throw new AppError('NOT_DRAFT', 'This payroll is not a draft', 409)
    await audit({ category: 'identity', action: 'hr.payroll.approve', entity: 'HrPayrollRun', entityId: run.id, userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId: run.tenantId, after: { period: run.period, totals: run.totals } })
    await auditPayrollDecision(req, run, grant, 'approve')
    return prisma.hrPayrollRun.findUnique({ where: { id: run.id } })
  })

  fastify.post<{ Params: { id: string } }>('/payroll/runs/:id/reopen', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const { run, grant } = await payrollDecision(req, req.params.id, 'reopen')
    const n = await prisma.hrPayrollRun.updateMany({ where: { id: run.id, status: 'approved' }, data: { status: 'draft', approvedById: null, approvedAt: null } })
    if (n.count === 0) throw new AppError('NOT_APPROVED', 'Only an approved (not locked) payroll can be reopened', 409)
    await auditPayrollDecision(req, run, grant, 'reopen')
    const reopened = await prisma.hrPayrollRun.findUnique({ where: { id: run.id } })
    // The bell: a reopened payroll is a draft in the queue again (a new round).
    approvalWaiting('payroll_run', run.id, { round: `reopen:${(reopened?.updatedAt ?? new Date()).toISOString()}`, actorId: req.staffUser!.id })
    return reopened
  })

  // Lock: final. Loans show as recovered from here (payroll already treats an
  // installment on any other run as taken), and nothing changes after.
  fastify.post<{ Params: { id: string } }>('/payroll/runs/:id/lock', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const { run, grant } = await payrollDecision(req, req.params.id, 'lock')
    const blocker = await runBlocker(run.id)
    if (blocker) throw new AppError('RUN_INCOMPLETE', blocker, 409)
    // Locking posts the month's payroll to the books, in the same transaction:
    // a payroll is never locked without its accrual, nor posted twice.
    await prisma.$transaction(async (tx) => {
      const n = await tx.hrPayrollRun.updateMany({ where: { id: run.id, status: 'approved' }, data: { status: 'locked', lockedAt: new Date() } })
      if (n.count === 0) throw new AppError('NOT_APPROVED', 'Approve the payroll before locking it', 409)
      await postPayrollAccrual(tx, run.id, req.staffUser!.id)
    })
    await audit({ category: 'identity', action: 'hr.payroll.lock', entity: 'HrPayrollRun', entityId: run.id, userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId: run.tenantId, after: { period: run.period } })
    await auditPayrollDecision(req, run, grant, 'lock')
    return prisma.hrPayrollRun.findUnique({ where: { id: run.id } })
  })

  // Wages paid out (finance gaps #9): clears wages payable — cash slips from
  // the safe (1010 — never a till drawer: drawer cash is dropped to the safe
  // first, or the drawer's close would count the wages as a shortage and
  // expense them twice), bank and cheque slips
  // from the bank named (a live, linked bank of the run's own company — 422
  // otherwise), else the company's only bank; dated paidOn (default today,
  // never in the future; a closed day is 422). The old {from: bank|cash}
  // still pays the whole run from one place.
  fastify.post<{ Params: { id: string } }>('/payroll/runs/:id/paid', { preHandler: PAYROLL_PAYER_GUARD }, async (req) => {
    const body = z.object({
      from: z.enum(['bank', 'cash']).optional(),
      bankAccountId: z.string().min(1).max(64).nullable().optional(),
      cashCode: z.literal('1010').optional(),
      paidOn: z.string().optional(),
    }).parse(req.body ?? {})
    const run = await prisma.hrPayrollRun.findFirst({ where: { id: req.params.id, ...writeTenants(req) } })
    if (!run) throw new NotFoundError('Payroll', req.params.id)
    // Separation of duties (owner, 2026-10-16): nobody pays a payroll run
    // that carries their own pay — the CEO included.
    if (await prisma.hrPayslip.count({ where: { runId: run.id, employee: { userId: req.staffUser!.id } } })) {
      throw new AppError('OWN_PAY_IN_RUN', 'Your own pay is on this payroll — someone else marks it paid', 403)
    }
    const paidOn = paidOnOf(body.paidOn)
    const from: PayrollPayFrom = body.from && body.cashCode === undefined && body.bankAccountId === undefined
      ? { mode: 'all', method: body.from }
      : { mode: 'split', bankAccountId: body.bankAccountId ?? null, cashCode: body.cashCode }
    const paid = await postPayrollPayment(run.id, req.staffUser!.id, from, paidOn, classificationOf(req.body))
    await audit({
      category: 'identity', action: 'hr.payroll.paid', entity: 'HrPayrollRun', entityId: run.id, userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId: run.tenantId,
      after: { period: run.period, paidOn: paidOn.toISOString(), payment: ((paid.totals ?? {}) as Record<string, unknown>)['payment'] ?? null, ...(body.from && { from: body.from }) },
    })
    return paid
  })

  fastify.delete<{ Params: { id: string } }>('/payroll/runs/:id', { preHandler: requireAuth(...HR_ADMIN) }, async (req, reply) => {
    const run = await prisma.hrPayrollRun.findFirst({ where: { id: req.params.id, ...writeTenants(req) } })
    if (!run) throw new NotFoundError('Payroll', req.params.id)
    // Through the head-office lens (A6): only a run you alone prepared.
    if (isReachOnly(req, run.tenantId)) {
      const me = req.staffUser!.id
      await assertHoMayPropose(req, run.tenantId, run.createdById === me && run.preparedByIds.every((id) => id === me), 'deleting a payroll someone else prepared')
    }
    if (run.status !== 'draft') throw new AppError('NOT_DRAFT', 'Only a draft payroll can be deleted', 409)
    // Trash (owner, 2026-10-15): the draft and its payslips are kept in the entry.
    const slips = await prisma.hrPayslip.findMany({ where: { runId: run.id } })
    await prisma.$transaction(async (tx) => {
      await moveToTrash(tx, req, {
        type: 'hr_payroll_run', entityId: run.id, tenantId: run.tenantId,
        title: `Payroll ${run.period} (draft)`, subtitle: `${slips.length} payslips`, reason: trashReasonOf(req),
        snapshot: takeSnapshot('HrPayrollRun', run, { HrPayslip: slips }),
        meta: { period: run.period },
      })
      await tx.hrPayrollRun.delete({ where: { id: run.id } })
    })
    return reply.status(204).send()
  })

  fastify.get<{ Params: { id: string }; Querystring: { kind?: string; format?: string } }>('/payroll/runs/:id/export.csv', { preHandler: requireAuth(...PAYROLL_READERS) }, async (req, reply) => {
    const run = await prisma.hrPayrollRun.findFirst({ where: { id: req.params.id, ...inTenants(req) } })
    if (!run) throw new NotFoundError('Payroll', req.params.id)
    const slips = await prisma.hrPayslip.findMany({ where: { runId: run.id }, include: { employee: true }, orderBy: { employee: { employeeCode: 'asc' } } })
    const kind = req.query.kind ?? 'register'
    const r = (c: number) => (c / 100).toFixed(2)
    let rows: unknown[][]
    if (kind === 'bank') {
      rows = [['Employee ID', 'Name', 'Bank', 'IBAN', 'Net pay'], ...slips.filter((s) => s.employee.paymentMethod !== 'cash').map((s) => [s.employee.employeeCode, s.employee.fullName, s.employee.bankName, s.employee.iban, r(s.netCents)])]
    } else if (kind === 'eobi') {
      rows = [['Employee ID', 'Name', 'CNIC', 'EOBI no.', 'Employee 1%', 'Employer 5%', 'Total'], ...slips.map((s) => [s.employee.employeeCode, s.employee.fullName, s.employee.cnic, s.employee.eobiNo, r(s.eobiEmployeeCents), r(s.eobiEmployerCents), r(s.eobiEmployeeCents + s.eobiEmployerCents)])]
    } else if (kind === 'deductions') {
      rows = [['Employee ID', 'Name', 'Deduction', 'Amount'], ...slips.flatMap((s) => (s.lines as Array<{ kind: string; label: string; amountCents: number }>).filter((l) => l.kind === 'deduction').map((l) => [s.employee.employeeCode, s.employee.fullName, l.label, r(l.amountCents)]))]
    } else {
      // The pay basis (HR-1): salary = monthly gross ÷ days in month × paid
      // days. Blank for a payslip from before the basis was kept.
      const basis = (inputs: unknown) => ((inputs as Record<string, unknown> | null)?.['payBasis'] ?? null) as { daysInMonth: number; paidDays: number; dailyRateCents: number; monthlyGrossCents: number } | null
      rows = [['Employee ID', 'Name', 'Monthly gross', 'Days in month', 'Paid days', 'Per-day rate', 'Gross', 'Earnings', 'Deductions', 'EOBI employee', 'EOBI employer', 'Net'], ...slips.map((s) => {
        const b = basis(s.inputs)
        return [s.employee.employeeCode, s.employee.fullName, b ? r(b.monthlyGrossCents) : null, b?.daysInMonth ?? null, b?.paidDays ?? null, b ? r(b.dailyRateCents) : null, r(s.grossCents), r(s.earningsCents), r(s.deductionsCents), r(s.eobiEmployeeCents), r(s.eobiEmployerCents), r(s.netCents)]
      })]
    }
    // ?format=xlsx|pdf: the same sheet through lib/reportExport.ts (CSV unchanged — the bank file stays CSV-exact).
    const head = rows[0] as string[]
    const MONEY = new Set(['Net pay', 'Employee 1%', 'Employer 5%', 'Total', 'Amount', 'Monthly gross', 'Per-day rate', 'Gross', 'Earnings', 'Deductions', 'EOBI employee', 'EOBI employer', 'Net'])
    const types: ReportColumnType[] = head.map((h) => (MONEY.has(h) ? 'pkr' : h === 'Days in month' || h === 'Paid days' ? 'number' : 'text'))
    const title = { register: 'Payroll register', bank: 'Payroll bank file', eobi: 'EOBI', deductions: 'Payroll deductions' }[kind] ?? `Payroll ${kind}`
    return sendReportFor(req, reply, exportFormatOf(req.query.format, 'csv')!, `payroll-${run.period}-${kind}`, {
      title: `${title} — ${run.period}`, period: `Pay period ${run.period}`, ...fromMatrix(head, rows.slice(1), types), csv: csv(rows),
    })
  })

  // ── Letters ───────────────────────────────────────────────────────────────
  fastify.get('/letters', { preHandler: requireAuth(...HR_ADMIN) }, async (req) => {
    const stored = await prisma.hrLetterTemplate.findMany({ where: { tenantId: activeTenant(req) } })
    return DEFAULT_LETTERS.map((d) => {
      const s = stored.find((x) => x.key === d.key)
      // A company's own version gets the rows its statement must show (the
      // F&F Gratuity row) — the stored template is not changed.
      const body = s ? withLetterSystemRows(d.key, sanitizeLetterHtml(s.body)) : d.body
      return { key: d.key, title: s?.title ?? d.title, body, isDefault: !s, version: s?.version ?? 0, placeholders: placeholdersIn(body) }
    })
  })

  fastify.put<{ Params: { key: string } }>('/letters/:key', { preHandler: requireAuth(...HR_ADMIN) }, async (req) => {
    const tenantId = activeTenant(req)
    if (!DEFAULT_LETTERS.some((d) => d.key === req.params.key)) throw new NotFoundError('Letter', req.params.key)
    const body = z.object({ title: z.string().min(1).max(160), body: z.string().min(1).max(100_000) }).parse(req.body)
    // Stored as formatting only — see sanitizeLetterHtml. What was cut is
    // gone; the response carries what was kept.
    const html = sanitizeLetterHtml(body.body)
    if (!html.trim()) throw new AppError('EMPTY_LETTER', 'Nothing is left of this letter once scripts and unsupported tags are removed', 400)
    const cur = await prisma.hrLetterTemplate.findUnique({ where: { tenantId_key: { tenantId, key: req.params.key } } })
    return prisma.hrLetterTemplate.upsert({
      where: { tenantId_key: { tenantId, key: req.params.key } },
      create: { tenantId, key: req.params.key, title: body.title, body: html, updatedById: req.staffUser!.id },
      update: { title: body.title, body: html, version: (cur?.version ?? 1) + 1, updatedById: req.staffUser!.id },
    })
  })

  // Back to the built-in default: the company's own version is removed.
  fastify.delete<{ Params: { key: string } }>('/letters/:key', { preHandler: requireAuth(...HR_ADMIN) }, async (req, reply) => {
    const tenantId = activeTenant(req)
    const row = await prisma.hrLetterTemplate.findUnique({ where: { tenantId_key: { tenantId, key: req.params.key } } })
    if (!row) return reply.status(204).send()
    // Trash (owner, 2026-10-15): the company's own wording is kept in the entry.
    await prisma.$transaction(async (tx) => {
      await moveToTrash(tx, req, {
        type: 'hr_letter', entityId: row.id, tenantId, title: row.title, subtitle: row.key,
        reason: trashReasonOf(req), snapshot: takeSnapshot('HrLetterTemplate', row), meta: { key: row.key },
      })
      await tx.hrLetterTemplate.delete({ where: { id: row.id } })
    })
    return reply.status(204).send()
  })

  fastify.post('/letters/render', { preHandler: requireAuth(...HR_ADMIN) }, async (req) => {
    const body = z.object({ key: z.string(), employeeId: z.string().uuid().optional(), recordId: z.string().uuid().optional() }).parse(req.body)
    const def = DEFAULT_LETTERS.find((d) => d.key === body.key)
    if (!def) throw new NotFoundError('Letter', body.key)
    const [emp, rec] = await Promise.all([
      body.employeeId ? prisma.hrEmployee.findFirst({ where: { id: body.employeeId, ...writeTenants(req) } }) : null,
      body.recordId ? prisma.hrRecord.findFirst({ where: { id: body.recordId, ...writeTenants(req) } }) : null,
    ])
    if (body.employeeId && !emp) throw new NotFoundError('Employee', body.employeeId)
    if (body.recordId && !rec) throw new NotFoundError('HR record', body.recordId)
    if (emp && rec && emp.tenantId !== rec.tenantId) throw new AppError('COMPANY_MISMATCH', 'That employee and that record belong to different companies', 422)
    // The letter is issued by the employee's own company: its name, its
    // template, its org units and the format the record was saved with —
    // whichever company happens to be active.
    const tenantId = emp?.tenantId ?? rec?.tenantId ?? activeTenant(req)
    const [tpl, employee] = await Promise.all([
      prisma.hrLetterTemplate.findUnique({ where: { tenantId_key: { tenantId, key: body.key } } }),
      emp ?? (rec?.employeeId ? prisma.hrEmployee.findFirst({ where: { id: rec.employeeId, tenantId } }) : null),
    ])
    const ctx = await letterContext(tenantId, employee, rec)
    const out = renderLetter(tpl ? withLetterSystemRows(body.key, tpl.body) : def.body, ctx)
    await audit({ category: 'identity', action: 'hr.letter.render', entity: 'HrLetterTemplate', entityId: body.key, userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId, after: { employeeId: employee?.id ?? null, recordId: rec?.id ?? null } })
    return { title: tpl?.title ?? def.title, ...out }
  })

  // ── Dashboard & reports ───────────────────────────────────────────────────
  fastify.get('/dashboard', { preHandler: requireAuth(...HR_ADMIN) }, async (req) => {
    await Promise.all(readTenants(req).map((t) => applyDueEffects(t)))
    const [d, due] = await Promise.all([dashboard(readTenants(req)), dueList(readTenants(req), 30)])
    return { ...d, due: due.slice(0, 50) }
  })

  fastify.get<{ Querystring: { days?: string } }>('/due', { preHandler: requireAuth(...HR_ADMIN) }, async (req) =>
    dueList(readTenants(req), Math.min(365, parseInt(req.query.days ?? '30', 10) || 30)))

  // Reports: Danish's four HR formats (reports.ts). JSON preview, .csv, and
  // .xlsx laid out as his workbook. /reports/employees.csv stays as an alias.
  fastify.get('/reports', { preHandler: requireAuth(...HR_ADMIN) }, async () => REPORTS)

  const reportQuery = (q: unknown): ReportQuery => z.object({
    month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
    status: z.string().max(40).optional(),
    department: z.string().uuid().optional(),
    location: z.string().uuid().optional(),
  }).parse(q ?? {})
  const sendReport = async (req: FastifyRequest, reply: FastifyReply, key: string, q: ReportQuery, as: 'csv' | 'xlsx' | 'pdf' = 'csv') => {
    const t = await buildReport(key, readTenants(req), activeTenant(req), q)
    const name = `hr-${key.replace(/_/g, '-')}${t.month ? `-${t.month}` : ''}`
    // PDF through lib/reportExport.ts; the .xlsx stays laid out as Danish's workbook.
    if (as === 'pdf') {
      const kindType: Record<string, ReportColumnType> = { money: 'pkr', number: 'number', text: 'text', date: 'text', percent: 'text' }
      const m = fromMatrix(t.header, t.rows, t.kinds.map((k) => kindType[k] ?? 'text'))
      const last = m.rows[m.rows.length - 1]
      return sendReportFor(req, reply, 'pdf', name, {
        title: t.title, ...(t.month ? { period: t.month } : {}), ...m,
        isTotal: (r) => Boolean(t.totalsRow && r === last), ...(t.note ? { notes: [t.note] } : {}),
      })
    }
    if (as === 'xlsx') {
      return reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .header('Content-Disposition', `attachment; filename="${name}.xlsx"`)
        .send(reportXlsx(t))
    }
    return reply.header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${name}.csv"`)
      .send(csv([t.header, ...t.rows]))
  }
  fastify.get('/reports/employees.csv', { preHandler: requireAuth(...HR_ADMIN) }, async (req, reply) =>
    sendReport(req, reply, 'employee_master', {}, exportFormatOf((req.query as { format?: string } | undefined)?.format, 'csv')!))

  fastify.get<{ Params: { key: string } }>('/reports/:key', { preHandler: requireAuth(...HR_ADMIN) }, async (req, reply) => {
    const q = reportQuery(req.query)
    // The HR reports' own convention (.csv / .xlsx / .pdf in the path) and the shared ?format= both work.
    const m = /^(.+)\.(csv|xlsx|pdf)$/.exec(req.params.key)
    if (m) return sendReport(req, reply, m[1]!, q, exportFormatOf((req.query as { format?: string }).format, m[2] as 'csv' | 'xlsx' | 'pdf')!)
    const asked = exportFormatOf((req.query as { format?: string }).format)
    if (asked) return sendReport(req, reply, req.params.key, q, asked)
    // On-screen preview: first 500 rows, with the full count.
    const t = await buildReport(req.params.key, readTenants(req), activeTenant(req), q)
    return { ...t, total: t.rows.length, rows: t.rows.slice(0, 500) }
  })

  // ── Manager / HOD portal ──────────────────────────────────────────────────
  fastify.get('/approvals', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => approvalsWaitingOn(req))

  // The ONE "what is waiting on me" resolver — /approvals lists it, /team
  // counts it.
  async function approvalsWaitingOn(req: FastifyRequest) {
    // The same companies /decide accepts (decideRight): members, plus — only
    // once a head office is linked or a hand-over exists — the companies
    // reached through a head office and those an HR hand-over covers.
    const su = req.staffUser!
    const delegated = await delegatedTenantsByType(su.id)
    const tenants = Array.from(new Set([...su.memberTenantIds, ...(su.reachTenantIds ?? []), ...(delegated.get('hr_request') ?? [])]))
    const pending = await prisma.hrRecord.findMany({
      where: { tenantId: { in: tenants }, status: 'submitted' },
      include: { employee: { select: { id: true, fullName: true, employeeCode: true } } },
      orderBy: { createdAt: 'asc' },
      take: 500,
    })
    // Which records came through a head office (A3), in one batch — the
    // final-step rule needs it. Nothing to read for the CEO.
    const through = su.role === 'admin' || pending.length === 0
      ? pending.map(() => [] as string[])
      : await throughHeadOfficeBatch(pending.map((r) => ({ tenantId: r.tenantId, submittedByIds: [r.createdById], submittedAt: r.createdAt, viaHeadOfficeId: r.viaHeadOfficeId })))
    const out = []
    // HR steps wait on HR only while HR holds the back-office module — the
    // same rule /decide applies (PPL-R2-01). Read once, only if needed.
    let staffHr: boolean | null = null
    for (const [i, rec] of pending.entries()) {
      const fmt = await getFormat(rec.tenantId, rec.section, rec.formVersion).catch(() => getFormat(rec.tenantId, rec.section))
      const step = fmt.workflow[rec.currentStep]
      if (!step) continue
      const subject = await approvalSubject(rec)
      const isLast = rec.currentStep >= fmt.workflow.length - 1
      const who = await decideRight(req, rec, step, isLast, { subject, decision: null, through: through[i] ?? [], delegatedTenants: delegated.get('hr_request') ?? new Set<string>() })
      // An admin override is possible on everything; only list it for the CEO
      // when it is genuinely theirs, or nothing would ever leave their queue.
      if (!who.ok || who.override) continue
      if (stepIsHrWork(step.role, req.staffUser!, subject.managerUserId)) {
        if (staffHr === null) staffHr = await holdsStaffHr(req)
        if (!staffHr) continue
      }
      out.push({ ...rec, label: recordLabel(rec, fmt.fields), sectionTitle: sectionByKey(rec.section)?.title ?? rec.section, step, format: fmt, waitingOnPartner: swapAwaitsPartner(rec) })
    }
    return out
  }

  // GET /hr/team — the caller's WHOLE reporting tree (indirect reports too,
  // decision 47), within their employee record's company. Cycle-safe (a
  // manager loop in the data stops at the first repeat) and capped at depth
  // 10. Each row: who they report to, how deep, today's attendance/leave and
  // their linked login. Never pay.
  fastify.get('/team', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const own = await ownEmployee(req)
    const pendingApprovals = (await approvalsWaitingOn(req)).length
    // A CEO with no HR record of their own (none is ever made — it would land
    // on payroll) still has the people whose Reporting line is "CEO"
    // (reportsToCeo), in the active company.
    const su = req.staffUser!
    const ceoTenant = own?.tenantId ?? (su.role === 'admin' ? activeTenant(req) : null)
    const asCeo = !!ceoTenant && su.role === 'admin' && (await companyCeo(ceoTenant)).userIds.includes(su.id)
    const me: { id: string | null; fullName: string; tenantId: string } | null = own
      ? { id: own.id, fullName: own.fullName, tenantId: own.tenantId }
      : asCeo ? { id: null, fullName: su.name ?? 'CEO', tenantId: ceoTenant! } : null
    if (!me) return { me: null, team: [], pendingApprovals }

    // The reporting tree (service.ts teamUnder — the one walk; the cash
    // requests read it through teamUserIdsUnder).
    const team: Array<TeamMember & { todayStatus: 'present' | 'late' | 'absent' | 'on_leave' | 'off' | null }> =
      (await teamUnder(me.tenantId, me.id, undefined, { asCeo })).map((t) => ({ ...t, todayStatus: null }))

    if (team.length) {
      const today = pktToday()
      const tomorrow = new Date(today.getTime() + 86_400_000)
      const ids = team.map((t) => t.id)
      const [leave, attendance] = await Promise.all([
        prisma.hrRecord.findMany({
          where: { tenantId: me.tenantId, section: 'leave', status: 'approved', employeeId: { in: ids }, startDate: { lte: today }, endDate: { gte: today } },
          select: { employeeId: true },
        }),
        prisma.hrRecord.findMany({
          where: { tenantId: me.tenantId, section: 'attendance', status: STANDING_ATTENDANCE, employeeId: { in: ids }, startDate: { gte: today, lt: tomorrow } },
          select: { employeeId: true, category: true },
          orderBy: { createdAt: 'asc' },   // latest wins below — the one payroll reads
        }),
      ])
      const onLeave = new Set(leave.map((l) => l.employeeId))
      const att = new Map(attendance.map((a) => [a.employeeId, a.category]))
      for (const t of team) t.todayStatus = onLeave.has(t.id) || t.status === 'on_leave' ? 'on_leave' : todayStatusOf(att.get(t.id))
    }
    return { me: { id: me.id, fullName: me.fullName }, team, pendingApprovals }
  })

  // ── Employee self-service ─────────────────────────────────────────────────
  async function myEmployee(req: FastifyRequest): Promise<HrEmployee> {
    const me = await ownEmployee(req)
    if (!me) throw new AppError('NOT_LINKED', 'Your login is not linked to an employee record yet — ask HR', 404)
    return me
  }

  fastify.get('/me', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const me = await myEmployee(req)
    await applyDueEffects(me.tenantId)
    const emp = await prisma.hrEmployee.findUniqueOrThrow({ where: { id: me.id } })
    const [label, balances, records, payslips, loans] = await Promise.all([
      employeeLabels(emp.tenantId, [emp]),
      leaveBalancesFor(emp.tenantId, emp.id),
      prisma.hrRecord.findMany({ where: { employeeId: emp.id, section: { in: [...ESS_SECTIONS, 'roster', 'attendance'] } }, orderBy: { createdAt: 'desc' }, take: 100 }),
      prisma.hrPayslip.findMany({ where: { employeeId: emp.id, run: { status: 'locked' } }, include: { run: { select: { period: true } } }, orderBy: { createdAt: 'desc' }, take: 24 }),
      loansFor(emp.tenantId, emp.id),
    ])
    return {
      // The company self-service pickers read from (?tenantId= on /lookups
      // and /org) — the employee's, whatever company the login has active.
      tenantId: emp.tenantId,
      profile: {
        employeeCode: emp.employeeCode, fullName: emp.fullName, phone: emp.phone, personalEmail: emp.personalEmail,
        department: label(emp.departmentId), designation: label(emp.designationId), branch: label(emp.locationId), manager: managerLabelOf(label, emp),
        employmentType: emp.employmentType, status: emp.status, joiningDate: emp.joiningDate, probationEnd: emp.probationEnd,
      },
      leaveBalances: balances,
      records,
      payslips: payslips.map((p) => ({ id: p.id, period: p.run.period, netCents: p.netCents })),
      loans,
      canRequest: ESS_SECTIONS,
    }
  })

  fastify.get<{ Params: { section: string } }>('/me/forms/:section', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    if (!ESS_SECTIONS.includes(req.params.section)) throw new ForbiddenError('Not available in self-service')
    const me = await myEmployee(req)
    const fmt = await getFormat(me.tenantId, req.params.section)
    // The employee field is filled in for them — they cannot raise a request
    // for someone else — and pay-driving values are HR's and the approver's.
    const hidden = [...(SERVER_OWNED[req.params.section] ?? []), ...(ESS_HIDDEN[req.params.section] ?? [])]
    return { ...fmt, fields: fmt.fields.filter((f) => f.bind !== 'employeeId' && !f.readOnly && !hidden.includes(f.key)) }
  })

  fastify.post<{ Params: { section: string } }>('/me/records/:section', { preHandler: requireAuth(...ALL_STAFF) }, async (req, reply) => {
    if (!ESS_SECTIONS.includes(req.params.section)) throw new ForbiddenError('Not available in self-service')
    const me = await myEmployee(req)
    const body = z.object({ data: z.record(z.unknown()) }).parse(req.body)
    // Self-service writes into the employee's own company, whatever company
    // the login happens to have active.
    return reply.status(201).send(await createRecord(req, me.tenantId, req.params.section, body.data, { submit: true, forEmployeeId: me.id }))
  })

  fastify.get<{ Params: { id: string } }>('/me/payslips/:id', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const me = await myEmployee(req)
    const slip = await prisma.hrPayslip.findFirst({ where: { id: req.params.id, employeeId: me.id, run: { status: 'locked' } }, include: { run: { select: { period: true } } } })
    if (!slip) throw new NotFoundError('Payslip', req.params.id)
    return slip
  })

  // ── Shift swaps waiting on the colleague (audit HR-R5) ────────────────────
  // A swap puts a colleague on the requester's shift, so that colleague
  // accepts it before any approver can approve it. A colleague without a
  // login (kiosk staff) is answered for by their own manager, or by HR.

  /** Swaps waiting for the caller's answer: their own, and those of their
   *  direct reports who have no login. */
  fastify.get('/me/swaps', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const mine = await prisma.hrEmployee.findMany({ where: { userId: req.staffUser!.id }, select: { id: true, tenantId: true } })
    if (mine.length === 0) return []
    const noLoginReports = await prisma.hrEmployee.findMany({
      where: { OR: mine.map((m) => ({ tenantId: m.tenantId, managerId: m.id })), userId: null },
      select: { id: true, tenantId: true },
    })
    const answerFor = [...mine, ...noLoginReports]
    const recs = await prisma.hrRecord.findMany({
      where: { section: 'shift_swap', status: 'submitted', tenantId: { in: Array.from(new Set(answerFor.map((m) => m.tenantId))) } },
      include: { employee: { select: { fullName: true } } },
      orderBy: { startDate: 'asc' },
      take: 200,
    })
    const ids = new Set(answerFor.map((m) => `${m.tenantId}:${m.id}`))
    return recs
      .filter((r) => { const w = swapPartnerOf(r.data); return !!w && ids.has(`${r.tenantId}:${w}`) && !swapAnswerOf(r.data) })
      .map((r) => ({ id: r.id, tenantId: r.tenantId, date: r.startDate, requestedBy: r.employee?.fullName ?? null, partnerId: swapPartnerOf(r.data), onBehalf: !mine.some((m) => m.id === swapPartnerOf(r.data)), data: r.data }))
  })

  fastify.post<{ Params: { id: string } }>('/me/swaps/:id/respond', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const body = z.object({ accept: z.boolean(), note: z.string().max(300).optional() }).parse(req.body)
    const rec = await prisma.hrRecord.findFirst({ where: { id: req.params.id, section: 'shift_swap' } })
    const partnerId = rec ? swapPartnerOf(rec.data) : null
    const partner = rec && partnerId ? await prisma.hrEmployee.findFirst({ where: { id: partnerId, tenantId: rec.tenantId }, select: { id: true, userId: true, managerId: true, fullName: true } }) : null
    // Who may answer: the colleague themselves; for one without a login,
    // their manager or HR of that company. Anyone else — including another
    // company — sees nothing.
    let onBehalf = false
    let allowed = !!partner && partner.userId === req.staffUser!.id
    if (!allowed && partner && !partner.userId) {
      const mgr = partner.managerId ? await prisma.hrEmployee.findFirst({ where: { id: partner.managerId, tenantId: rec!.tenantId }, select: { userId: true } }) : null
      allowed = (!!mgr?.userId && mgr.userId === req.staffUser!.id)
        || (req.staffUser!.memberTenantIds.includes(rec!.tenantId) && await hrBackOffice(req))
      onBehalf = allowed
    }
    if (!rec || !partner || !allowed) throw new NotFoundError('Shift swap', req.params.id)
    if (rec.status !== 'submitted') throw new AppError('NOT_PENDING', 'This swap is no longer waiting for an answer', 409)
    if (swapAnswerOf(rec.data)) throw new AppError('ALREADY_ANSWERED', 'This swap has already been answered', 409)
    const answer: SwapPartnerAnswer = {
      decision: body.accept ? 'accepted' : 'declined', byUserId: req.staffUser!.id,
      byName: req.staffUser!.name ?? req.staffUser!.email ?? 'Unknown', onBehalf, at: new Date().toISOString(),
      ...(body.note && { note: body.note }),
    }
    const updated = await prisma.$transaction(async (tx) => {
      // Accepting re-checks the day: leave approved since the swap was raised
      // is refused here, not at the approver's step.
      if (body.accept && rec.employeeId) await checkSwapPartner(tx, rec.tenantId, rec.employeeId, rec.data as Record<string, unknown>, rec.startDate)
      // A declined swap is over: it is rejected, with the colleague's answer.
      const claimed = await tx.hrRecord.updateMany({
        where: { id: rec.id, status: 'submitted', updatedAt: rec.updatedAt },
        data: { data: { ...(rec.data as Record<string, unknown>), _partner: { ...answer } } as Prisma.InputJsonValue, ...(!body.accept && { status: 'rejected' }) },
      })
      if (claimed.count === 0) throw new AppError('CONFLICT', 'This swap changed while you were answering — reload', 409)
      return tx.hrRecord.findUniqueOrThrow({ where: { id: rec.id } })
    })
    await audit({
      category: 'identity', action: `hr.shift_swap.partner_${answer.decision}`, entity: 'HrRecord', entityId: rec.id,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId: rec.tenantId, after: { partner: partner.fullName, onBehalf },
    })
    return updated
  })

  // Who is on the payroll for a month, before running it — a sanity check.
  fastify.get<{ Querystring: { period: string } }>('/payroll/preview', { preHandler: requireAuth(...HR_ADMIN) }, async (req) => {
    const period = /^\d{4}-\d{2}$/.test(req.query.period ?? '') ? req.query.period : periodOf(pktToday())
    const emps = await payableEmployees(activeTenant(req), period)
    return { period, employees: emps.length }
  })

  void RECORD_SECTIONS
}
