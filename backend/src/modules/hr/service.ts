// HR data layer: formats, approvals and their effects, leave balances, loans,
// payroll runs, the dashboard. The arithmetic lives in logic.ts; this file
// fetches the numbers and puts the results back.

import type { Prisma, PrismaClient, HrEmployee, HrRecord } from '@prisma/client'
import { serviceClient as prisma } from '../../lib/prisma.js'
import { AppError } from '../../lib/errors.js'
import { accountStateOf } from '../auth/accountStatus.js'
import {
  HR_SECTIONS, sectionByKey, EMPLOYEE_MASTER_FIELDS, withSystemFields,
  type HrField, type HrSection, type WorkflowStep,
} from './forms.js'
import {
  mergeSettings, type HrSettings, type PayrollInputs, EMPTY_INPUTS,
  computePayslip, overtimeCents, otMultiplierFor, hourlyRateCents, periodStart, periodEnd, periodOf, pktToday,
  leaveYear, leaveBalance, leaveQuantity, leaveDaysWithin, leaveYearsBetween, carriedForwardDays, attendanceInputs,
  loanInstallmentCents, allocateLoanCents, isDueWithin, salaryInForce, EOBI_NOT_CALCULATED, settledFromPeriod, settlementParts,
  type SalaryChange,
} from './logic.js'

type Tx = Prisma.TransactionClient
/** A transaction, or the service client — what a reader may be handed (a
 *  close check runs inside the period close's own transaction). */
export type Db = Tx | PrismaClient
const db = (tx?: Db) => tx ?? prisma

// ─── Settings ───────────────────────────────────────────────────────────────

const settingsKey = (tenantId: string) => `hr.settings.${tenantId}`

export async function getSettings(tenantId: string): Promise<HrSettings> {
  const row = await prisma.setting.findUnique({ where: { key: settingsKey(tenantId) } })
  let stored: Partial<HrSettings> | null = null
  try { stored = row ? JSON.parse(row.value) as Partial<HrSettings> : null } catch { stored = null }
  return mergeSettings(stored)
}

export async function saveSettings(tenantId: string, s: HrSettings): Promise<void> {
  const value = JSON.stringify(s)
  await prisma.setting.upsert({ where: { key: settingsKey(tenantId) }, create: { key: settingsKey(tenantId), value }, update: { value } })
}

// ─── Formats ────────────────────────────────────────────────────────────────

export interface ActiveFormat {
  section: string
  version: number        // 0 = the built-in default, never saved
  title: string
  fields: HrField[]
  workflow: WorkflowStep[]
  stages: string[]
  isDefault: boolean
}

export function defaultFormat(sec: HrSection): ActiveFormat {
  return {
    section: sec.key, version: 0, title: sec.title,
    fields: sec.key === 'employees' ? EMPLOYEE_MASTER_FIELDS : sec.fields ?? [],
    workflow: sec.workflow ?? [], stages: sec.stages ?? [], isDefault: true,
  }
}

export async function getFormat(tenantId: string, section: string, version?: number): Promise<ActiveFormat> {
  const sec = sectionByKey(section)
  if (!sec) throw new AppError('UNKNOWN_SECTION', `No HR section "${section}"`, 404)
  const row = await prisma.hrFormDefinition.findFirst({
    where: { tenantId, section, ...(version !== undefined ? { version } : { isActive: true }) },
    orderBy: { version: 'desc' },
  })
  if (!row) return defaultFormat(sec)
  return savedFormat(sec, row)
}

/** A company's saved format as logic reads it: with any default SYSTEM field
 *  added since it was saved (forms.ts withSystemFields — a full & final's
 *  gratuity), so a value logic writes is never dropped on save. */
function savedFormat(sec: HrSection, row: { version: number; title: string; fields: Prisma.JsonValue; workflow: Prisma.JsonValue; stages: Prisma.JsonValue }): ActiveFormat {
  return {
    section: sec.key, version: row.version, title: row.title,
    fields: withSystemFields(sec, row.fields as unknown as HrField[]),
    workflow: row.workflow as unknown as WorkflowStep[],
    stages: row.stages as unknown as string[],
    isDefault: false,
  }
}

export async function getAllFormats(tenantId: string): Promise<Record<string, ActiveFormat>> {
  const rows = await prisma.hrFormDefinition.findMany({ where: { tenantId, isActive: true }, orderBy: { version: 'desc' } })
  const out: Record<string, ActiveFormat> = {}
  for (const sec of HR_SECTIONS) {
    const row = rows.find((r) => r.section === sec.key)
    out[sec.key] = row ? savedFormat(sec, row) : defaultFormat(sec)
  }
  return out
}

// ─── Employees ──────────────────────────────────────────────────────────────

/** Display names for the ids on an employee — department, designation, … */
export async function employeeLabels(tenantId: string, emps: Array<Pick<HrEmployee, 'departmentId' | 'designationId' | 'gradeId' | 'locationId' | 'managerId'>>) {
  const ids = (k: keyof (typeof emps)[number]) => Array.from(new Set(emps.map((e) => e[k]).filter(Boolean) as string[]))
  const [depts, units, locs, mgrs] = await Promise.all([
    prisma.department.findMany({ where: { id: { in: ids('departmentId') } }, select: { id: true, name: true } }),
    prisma.hrOrgUnit.findMany({ where: { tenantId, id: { in: [...ids('designationId'), ...ids('gradeId')] } }, select: { id: true, name: true } }),
    prisma.location.findMany({ where: { id: { in: ids('locationId') } }, select: { id: true, name: true } }),
    prisma.hrEmployee.findMany({ where: { tenantId, id: { in: ids('managerId') } }, select: { id: true, fullName: true } }),
  ])
  const m = new Map<string, string>()
  for (const d of depts) m.set(d.id, d.name)
  for (const u of units) m.set(u.id, u.name)
  for (const l of locs) m.set(l.id, l.name)
  for (const e of mgrs) m.set(e.id, e.fullName)
  return (id: string | null | undefined) => (id ? m.get(id) ?? null : null)
}

/** employeeLabels for rows that can span companies (the portfolio view): each
 *  employee's ids resolve in their own company. */
export async function employeeLabelsAcross(emps: Array<Pick<HrEmployee, 'tenantId' | 'departmentId' | 'designationId' | 'gradeId' | 'locationId' | 'managerId'>>) {
  const byTenant = new Map<string, typeof emps>()
  for (const e of emps) {
    const list = byTenant.get(e.tenantId) ?? []
    list.push(e)
    byTenant.set(e.tenantId, list)
  }
  const labels = await Promise.all(Array.from(byTenant.entries()).map(([t, list]) => employeeLabels(t, list)))
  return (id: string | null | undefined) => {
    for (const label of labels) {
      const name = label(id)
      if (name != null) return name
    }
    return null
  }
}

// ─── Reporting line ─────────────────────────────────────────────────────────
//
// The team is the HR reporting line (HrEmployee.managerId, decision 47) — the
// ONE hierarchy. HR approvals, /hr/team and the cash-request HOD signature all
// read it through these helpers; don't build another.

/**
 * The login of an employee's DIRECT reporting manager in their company — who
 * signs an HOD step (logic.ts canActOnStep('hod')). Null when the employee has
 * no manager or the manager has no login: then HR acts for the HOD, so a
 * request never gets stuck.
 */
export async function managerUserIdOfEmployee(tenantId: string, employeeId: string, q: Db = prisma): Promise<string | null> {
  const emp = await q.hrEmployee.findFirst({ where: { id: employeeId, tenantId }, select: { managerId: true } })
  if (!emp?.managerId) return null
  const mgr = await q.hrEmployee.findFirst({ where: { id: emp.managerId, tenantId }, select: { userId: true } })
  return mgr?.userId ?? null
}

/**
 * The same rule for a LOGIN: the direct reporting manager's login of the
 * employee record `userId` is linked to in `tenantId` (one record per login
 * per company, decision 31). Null when the login is not an employee of that
 * company, or has no manager with a login — the caller's fallback applies
 * (HR for an HR request; the cash keepers for a cash request). Another
 * company's reporting line is never read.
 */
export async function directManagerUserIdOf(tenantId: string, userId: string, q: Db = prisma): Promise<string | null> {
  const emp = await q.hrEmployee.findFirst({ where: { tenantId, userId }, select: { id: true } })
  return emp ? managerUserIdOfEmployee(tenantId, emp.id, q) : null
}

export interface TeamMember {
  id: string; fullName: string; employeeCode: string; status: string; phone: string | null
  employmentType: string; probationEnd: Date | null; managerId: string | null; userId: string | null
  /** 1 = a direct report, 2 = their reports, … */
  depth: number
}

/**
 * Everyone under `managerEmployeeId` in `tenantId` — the WHOLE reporting tree,
 * indirect reports too (decision 47) — who is current (active or on leave).
 * Cycle-safe (a manager loop in the data stops at the first repeat) and capped
 * at depth 10. Names and status only, never pay.
 */
export async function teamUnder(tenantId: string, managerEmployeeId: string, q: Db = prisma): Promise<TeamMember[]> {
  const MAX_DEPTH = 10
  const seen = new Set<string>([managerEmployeeId])
  const team: TeamMember[] = []
  let frontier = [managerEmployeeId]
  for (let depth = 1; depth <= MAX_DEPTH && frontier.length; depth++) {
    const rows = await q.hrEmployee.findMany({
      where: { tenantId, managerId: { in: frontier }, status: { in: ['active', 'on_leave'] } },
      select: { id: true, fullName: true, employeeCode: true, status: true, phone: true, employmentType: true, probationEnd: true, managerId: true, userId: true },
      orderBy: { fullName: 'asc' },
    })
    const next: string[] = []
    for (const r of rows) {
      if (seen.has(r.id)) continue
      seen.add(r.id)
      next.push(r.id)
      team.push({ ...r, depth })
    }
    frontier = next
  }
  return team
}

/**
 * The logins of everyone under `managerUserId` in `tenantId` (teamUnder from
 * the manager's own employee record there). Empty when that login is not an
 * employee of the company. The cash requests' "waiting for my signature" list
 * reads it.
 */
export async function teamUserIdsUnder(tenantId: string, managerUserId: string, q: Db = prisma): Promise<string[]> {
  const me = await q.hrEmployee.findFirst({ where: { tenantId, userId: managerUserId }, select: { id: true } })
  if (!me) return []
  const team = await teamUnder(tenantId, me.id, q)
  return Array.from(new Set(team.map((t) => t.userId).filter((u): u is string => !!u && u !== managerUserId)))
}

// ─── Approval effects ───────────────────────────────────────────────────────
//
// What an approved record does to the employee. Applied exactly once
// (appliedAt), and not before its effective date: a salary revision approved
// today for next month must not change this month's payroll.

const EFFECT_SECTIONS = ['promotion', 'transfer', 'salary_revision', 'probation_review', 'resignation', 'termination']

/** What an approved record writes to the employee master. */
function effectUpdate(rec: HrRecord, emp: HrEmployee): Record<string, unknown> {
  const d = (rec.data ?? {}) as Record<string, unknown>
  const upd: Record<string, unknown> = {}
  switch (rec.section) {
    case 'promotion':
      if (typeof d['newDesignation'] === 'string') upd['designationId'] = d['newDesignation']
      if (rec.amountCents && rec.amountCents > 0) upd['grossSalaryCents'] = rec.amountCents
      break
    case 'transfer':
      if (typeof d['newLocation'] === 'string') upd['locationId'] = d['newLocation']
      if (typeof d['newDepartment'] === 'string') upd['departmentId'] = d['newDepartment']
      if (typeof d['newManager'] === 'string' && d['newManager'] !== emp.id) upd['managerId'] = d['newManager']
      break
    case 'salary_revision':
      if (rec.amountCents && rec.amountCents > 0) upd['grossSalaryCents'] = rec.amountCents
      if (typeof d['revisedBasic'] === 'number' && d['revisedBasic'] > 0) upd['basicSalaryCents'] = d['revisedBasic']
      break
    case 'probation_review':
      if (rec.category === 'confirm') {
        upd['employmentType'] = 'permanent'
        upd['confirmationDate'] = rec.effectiveDate ?? new Date()
      } else if (rec.category === 'extend' && rec.effectiveDate) {
        upd['probationEnd'] = rec.effectiveDate
      }
      // 'terminate' is deliberately not automatic: it starts a termination,
      // which has its own approval.
      break
    case 'resignation':
      upd['status'] = 'resigned'
      if (rec.endDate) upd['lastWorkingDay'] = rec.endDate
      break
    case 'termination':
      upd['status'] = 'terminated'
      if (rec.endDate) upd['lastWorkingDay'] = rec.endDate
      break
  }
  return upd
}

/**
 * Write an approved record to the employee. A field that an already-applied
 * record with a LATER effective date set is left alone — a backdated revision
 * approved after a newer one must not undo it. What each field held before is
 * kept on the record (data._before), so payroll can tell the salary in force
 * on an earlier date.
 */
async function applyEffect(tx: Tx, rec: HrRecord, emp: HrEmployee): Promise<void> {
  const upd = effectUpdate(rec, emp)
  if (rec.effectiveDate && Object.keys(upd).length) {
    const later = await tx.hrRecord.findMany({
      where: { tenantId: rec.tenantId, employeeId: emp.id, section: { in: EFFECT_SECTIONS }, status: 'approved', appliedAt: { not: null }, effectiveDate: { gt: rec.effectiveDate }, id: { not: rec.id } },
    })
    for (const l of later) {
      const before = ((l.data ?? {}) as Record<string, unknown>)['_before'] as Record<string, unknown> | undefined
      for (const k of Object.keys(before ?? effectUpdate(l, emp))) delete upd[k]
    }
  }
  const before: Record<string, unknown> = {}
  for (const k of Object.keys(upd)) before[k] = (emp as unknown as Record<string, unknown>)[k] ?? null
  if (Object.keys(upd).length) await tx.hrEmployee.update({ where: { id: emp.id }, data: upd as Prisma.HrEmployeeUpdateInput })
  await tx.hrRecord.update({
    where: { id: rec.id },
    data: { appliedAt: new Date(), data: { ...((rec.data ?? {}) as Record<string, unknown>), _before: before } as Prisma.InputJsonValue },
  })
}

/** The date an effect should take hold. Separations apply at approval — the
 *  status is what starts the notice period — and so does a probation
 *  extension: its date is the NEW end of probation, which has to be on the
 *  employee from now, not from the day it arrives. Everything else at its
 *  effective date. */
export function effectDue(rec: Pick<HrRecord, 'section' | 'category' | 'effectiveDate'>, now: Date): boolean {
  if (rec.section === 'resignation' || rec.section === 'termination') return true
  if (rec.section === 'probation_review' && rec.category === 'extend') return true
  // effectiveDate is UTC midnight of its Karachi day; compare with Karachi
  // today in the same form (pktToday), so today's effects apply from 00:00 PKT.
  const on = rec.effectiveDate
  return !on || on.getTime() < pktToday(now).getTime() + 86_400_000
}

/** Apply every approved effect that has come due by today, in effective-date
 *  order. Cheap and idempotent; runs before anything that reads salaries or
 *  statuses. Never pass a future `now`: effects are permanent writes to the
 *  master — payroll for a later month works its salary out with
 *  salaryForPeriod instead. */
export async function applyDueEffects(tenantId: string, now = new Date()): Promise<number> {
  const due = await prisma.hrRecord.findMany({
    where: { tenantId, section: { in: EFFECT_SECTIONS }, status: 'approved', appliedAt: null, employeeId: { not: null } },
    orderBy: [{ effectiveDate: 'asc' }, { createdAt: 'asc' }],
  })
  let n = 0
  for (const rec of due) {
    if (!effectDue(rec, now)) continue
    await prisma.$transaction(async (tx) => {
      // Claim first: two requests racing here must not both apply it, and a
      // record cancelled since the list above was read must not apply at all.
      const claimed = await tx.hrRecord.updateMany({ where: { id: rec.id, appliedAt: null, status: 'approved' }, data: { appliedAt: new Date() } })
      if (claimed.count === 0) return
      const fresh = await tx.hrRecord.findUniqueOrThrow({ where: { id: rec.id } })
      const emp = await tx.hrEmployee.findFirst({ where: { id: fresh.employeeId!, tenantId } })
      if (emp) await applyEffect(tx, fresh, emp)
      n++
    })
  }
  return n
}

/**
 * The gross salary in force at the end of `period` — what that month is paid
 * at. A month is paid at its own salary whenever payroll is run: a revision
 * applied since is undone for it, and one approved for a date inside it that
 * has not been applied yet (a future month) is counted without applying it.
 */
export async function salaryForPeriod(emp: HrEmployee, period: string): Promise<number> {
  const recs = await prisma.hrRecord.findMany({
    where: { tenantId: emp.tenantId, employeeId: emp.id, section: { in: ['salary_revision', 'promotion'] }, status: 'approved', effectiveDate: { not: null } },
  })
  const changes: SalaryChange[] = recs.map((r) => {
    const before = ((r.data ?? {}) as Record<string, unknown>)['_before'] as Record<string, unknown> | undefined
    const applied = !!r.appliedAt
    return {
      effectiveDate: r.effectiveDate!, grossCents: r.amountCents ?? 0, applied,
      // Applied before _before was kept: assume it wrote the gross, and that
      // what it replaced is unknown.
      wroteGross: applied && (before ? 'grossSalaryCents' in before : (r.amountCents ?? 0) > 0),
      beforeCents: before && typeof before['grossSalaryCents'] === 'number' ? before['grossSalaryCents'] as number : null,
    }
  })
  return salaryInForce(emp.grossSalaryCents, changes, periodEnd(period))
}

/** Work done at the moment of final approval, before effects. */
export async function onFinalApproval(tx: Tx, rec: HrRecord, emp: HrEmployee | null, s: HrSettings, extra: { approvedHours?: number | null }) {
  const d = { ...((rec.data ?? {}) as Record<string, unknown>) }
  if (rec.section === 'overtime' && emp) {
    // approvedHours in data is only ever written by an approver (decide), and
    // the multiplier only by HR — self-service cannot set either.
    const hours = extra.approvedHours ?? (typeof d['approvedHours'] === 'number' ? d['approvedHours'] as number : rec.quantity ?? 0)
    const mult = otMultiplierFor(d['multiplier'], s)
    const amount = overtimeCents(hours, emp.grossSalaryCents, s, mult)
    d['approvedHours'] = hours
    d['multiplier'] = mult
    d['otRate'] = Math.round(hourlyRateCents(emp.grossSalaryCents, s))
    d['otAmount'] = amount
    await tx.hrRecord.update({ where: { id: rec.id }, data: { amountCents: amount, data: d as Prisma.InputJsonValue } })
  }
}

// ─── Leave ──────────────────────────────────────────────────────────────────

/**
 * Leave balances in the leave year containing `on`. A leave is charged to each
 * leave year for the days that fall in it, so one across the year end costs
 * both years their share. `excludeId` leaves one application out entirely —
 * the one being edited or submitted, which is checked on its own.
 *
 * A leave type with carry forward adds last year's unused balance (capped at
 * its max) to this year's entitlement, chained back to the first leave year
 * the type and the employee both existed in.
 */
export async function leaveBalancesFor(tenantId: string, employeeId: string, on = pktToday(), opts: { excludeId?: string; tx?: Tx } = {}) {
  const s = await getSettings(tenantId)
  const [from, to] = leaveYear(on, s.leaveYearStartMonth)
  const q = db(opts.tx)
  const [types, leaves, adjustments, emp] = await Promise.all([
    q.hrRecord.findMany({ where: { tenantId, section: 'leave_type', status: 'approved' }, orderBy: { createdAt: 'asc' } }),
    q.hrRecord.findMany({
      where: {
        tenantId, section: 'leave', employeeId, status: { in: ['approved', 'submitted'] },
        startDate: { lte: to }, endDate: { not: null },
        ...(opts.excludeId && { id: { not: opts.excludeId } }),
      },
    }),
    q.hrRecord.findMany({ where: { tenantId, section: 'leave_adjustment', employeeId, status: 'approved' } }),
    q.hrEmployee.findUnique({ where: { id: employeeId }, select: { joiningDate: true } }),
  ])
  return types.map((t) => {
    const data = t.data as Record<string, unknown>
    const mine = leaves.filter((l) => l.refId === t.id && l.startDate && l.endDate)
    const within = (status: string, yf: Date, yt: Date) => mine
      .filter((l) => l.status === status)
      .reduce((a, l) => a + leaveDaysWithin({ startDate: l.startDate!, endDate: l.endDate!, quantity: l.quantity }, yf, yt), 0)
    const adjIn = (yf: Date, yt: Date) => adjustments
      .filter((a) => a.refId === t.id && (a.effectiveDate ?? a.createdAt) >= yf && (a.effectiveDate ?? a.createdAt) <= yt)
      .reduce((a, x) => a + (x.quantity ?? 0), 0)
    const entitlement = t.quantity ?? 0
    let carried = 0
    if (data['carryForward'] === true) {
      const max = typeof data['maxCarryForward'] === 'number' ? data['maxCarryForward'] as number : null
      const first = emp?.joiningDate && emp.joiningDate > t.createdAt ? emp.joiningDate : t.createdAt
      const prior = leaveYearsBetween(first, from, s.leaveYearStartMonth).map(([yf, yt]) => ({ adjustments: adjIn(yf, yt), taken: within('approved', yf, yt) }))
      carried = carriedForwardDays(entitlement, prior, max)
    }
    return {
      leaveTypeId: t.id,
      name: String(data['name'] ?? 'Leave'),
      paid: t.category !== 'unpaid',
      yearFrom: from, yearTo: to,
      ...leaveBalance(entitlement, within('approved', from, to), adjIn(from, to), within('submitted', from, to), carried),
    }
  })
}

/** Serialise leave booking per employee for the rest of the transaction: the
 *  balance check and the write that spends it must not interleave with
 *  another request for the same person. */
export async function lockEmployeeLeave(tx: Tx, employeeId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${employeeId}))`
}

/**
 * Before a leave application is saved or submitted: work out its days from the
 * dates, refuse one that overlaps the employee's other submitted or approved
 * leave, and refuse paid leave beyond the balance of each leave year it falls
 * in. Unpaid leave has no balance to exceed. Call it inside a transaction that
 * holds lockEmployeeLeave, with the same `tx`.
 */
export async function checkLeave(tenantId: string, rec: { employeeId: string | null; refId: string | null; startDate: Date | null; endDate: Date | null; quantity: number | null; id?: string }, tx?: Tx) {
  if (!rec.employeeId || !rec.refId || !rec.startDate || !rec.endDate) return { quantity: rec.quantity }
  if (rec.endDate < rec.startDate) throw new AppError('BAD_DATES', 'Leave cannot end before it starts', 400)
  const quantity = leaveQuantity(rec.startDate, rec.endDate, rec.quantity)
  const clash = await db(tx).hrRecord.findFirst({
    where: {
      tenantId, section: 'leave', employeeId: rec.employeeId, status: { in: ['submitted', 'approved'] },
      startDate: { lte: rec.endDate }, endDate: { gte: rec.startDate },
      ...(rec.id && { id: { not: rec.id } }),
    },
  })
  if (clash) {
    const d = (x: Date | null) => x?.toISOString().slice(0, 10)
    throw new AppError('LEAVE_OVERLAP', `There is already leave from ${d(clash.startDate)} to ${d(clash.endDate)} on these dates`, 409)
  }
  const type = await db(tx).hrRecord.findFirst({ where: { id: rec.refId, tenantId, section: 'leave_type' } })
  if (!type) throw new AppError('BAD_LEAVE_TYPE', 'That leave type does not exist', 400)
  if (type.category !== 'unpaid') {
    const s = await getSettings(tenantId)
    const name = String((type.data as Record<string, unknown>)['name'] ?? 'this leave')
    const years = leaveYearsBetween(rec.startDate, new Date(rec.endDate.getTime() + 1), s.leaveYearStartMonth)
    for (const [yf, yt] of years) {
      const share = leaveDaysWithin({ startDate: rec.startDate, endDate: rec.endDate, quantity }, yf, yt)
      if (share === 0) continue
      // This record is left out of the balance: an edit is checked afresh,
      // whatever type, year or employee it had before.
      const bal = (await leaveBalancesFor(tenantId, rec.employeeId, yf, { excludeId: rec.id, tx })).find((b) => b.leaveTypeId === type.id)
      const available = (bal?.balance ?? 0) - (bal?.pending ?? 0)
      if (share > available) {
        const yr = years.length > 1 ? ` in the leave year from ${yf.toISOString().slice(0, 10)}` : ''
        throw new AppError('LEAVE_BALANCE', `Only ${Math.max(0, available)} day(s) of ${name} available${yr}`, 400)
      }
    }
  }
  return { quantity }
}

// ─── Loans ──────────────────────────────────────────────────────────────────

type LoanLine = { loanId: string; cents: number }
const loanLinesOf = (inputs: unknown): LoanLine[] => ((inputs as Record<string, unknown> | null)?.['loans'] as LoanLine[] | undefined) ?? []

/** Every payroll run status — a payslip on any of them has claimed its installment. */
export const ALL_RUN_STATUSES = ['draft', 'approved', 'locked']

/** The loan recoveries an approved full & final booked (data._loans), written
 *  when its accrual posts — the same split a payslip keeps in inputs.loans. */
export const settlementLoansOf = (data: unknown): LoanLine[] => {
  const v = ((data ?? {}) as Record<string, unknown>)['_loans']
  return Array.isArray(v) ? (v as LoanLine[]).filter((l) => l && typeof l.loanId === 'string' && typeof l.cents === 'number') : []
}

/**
 * Loans with what has been recovered from them. By default `recoveredCents`
 * counts LOCKED payroll only — money actually taken. Payroll counts every run
 * but the one being calculated (`exceptRunId`), so an installment sitting on
 * last month's still-unlocked run is not taken a second time; full & final
 * counts every run it follows on from.
 *
 * An approved full & final's recovery always counts (its accrual credits
 * Staff Loans 1350), so the loan register and 1350 agree once a leaver is
 * settled. `exceptSettlementId` leaves one settlement out — the one being
 * booked, which is checked against what the others left.
 */
export async function loansFor(tenantId: string, employeeId?: string, opts: { runStatuses?: string[]; exceptRunId?: string; exceptSettlementId?: string } = {}) {
  const loans = await prisma.hrRecord.findMany({
    where: { tenantId, section: 'loan', status: 'approved', ...(employeeId && { employeeId }) },
    orderBy: { createdAt: 'asc' },
  })
  if (loans.length === 0) return []
  const [slips, settlements] = await Promise.all([
    prisma.hrPayslip.findMany({
      where: {
        tenantId, run: { status: { in: opts.runStatuses ?? ['locked'] } }, ...(employeeId && { employeeId }),
        ...(opts.exceptRunId && { runId: { not: opts.exceptRunId } }),
      },
      select: { inputs: true },
    }),
    prisma.hrRecord.findMany({
      where: {
        tenantId, section: 'final_settlement', status: 'approved', ...(employeeId && { employeeId }),
        ...(opts.exceptSettlementId && { id: { not: opts.exceptSettlementId } }),
      },
      select: { data: true },
    }),
  ])
  const recovered = new Map<string, number>()
  for (const sl of slips) {
    for (const l of loanLinesOf(sl.inputs)) recovered.set(l.loanId, (recovered.get(l.loanId) ?? 0) + l.cents)
  }
  for (const st of settlements) {
    for (const l of settlementLoansOf(st.data)) recovered.set(l.loanId, (recovered.get(l.loanId) ?? 0) + l.cents)
  }
  return loans.map((l) => {
    const rec = recovered.get(l.id) ?? 0
    return {
      id: l.id, employeeId: l.employeeId, type: l.category,
      amountCents: l.amountCents ?? 0, installments: l.quantity ?? 1,
      firstPeriod: l.effectiveDate ? periodOf(l.effectiveDate) : periodOf(l.createdAt),
      recoveredCents: rec, outstandingCents: Math.max(0, (l.amountCents ?? 0) - rec),
    }
  })
}

// ─── Payroll ────────────────────────────────────────────────────────────────

/** Attendance entries that stand. Draft, rejected and cancelled entries never
 *  reach payroll, a report or the dashboard. */
export const STANDING_ATTENDANCE = { notIn: ['draft', 'rejected', 'cancelled'] }

/** Start of the company's first payroll month here, or `fallback` when there
 *  is none yet. Overtime worked before it was paid outside this system. */
export async function firstPayrollStart(tenantId: string, fallback: Date): Promise<Date> {
  const first = await prisma.hrPayrollRun.findFirst({ where: { tenantId }, orderBy: { period: 'asc' }, select: { period: true } })
  const start = first ? periodStart(first.period) : fallback
  return start < fallback ? start : fallback
}

/**
 * Approved overtime dated from `from` up to `to` that no payslip on a run of
 * `runStatuses` has paid. OT is paid by the payslip that lists it
 * (inputs.otRecordIds), not by the month it was worked in — so OT approved
 * after its month's run was locked goes on the next one. A payslip from
 * before the ids were kept is taken to have paid the OT dated in its month.
 */
export async function unpaidOvertime(tenantId: string, employeeId: string, from: Date, to: Date, opts: { runStatuses: string[]; exceptRunId?: string }) {
  const [records, slips] = await Promise.all([
    prisma.hrRecord.findMany({ where: { tenantId, section: 'overtime', employeeId, status: 'approved', startDate: { gte: from, lte: to } } }),
    prisma.hrPayslip.findMany({
      where: { tenantId, employeeId, run: { status: { in: opts.runStatuses } }, ...(opts.exceptRunId && { runId: { not: opts.exceptRunId } }) },
      select: { inputs: true, run: { select: { period: true } } },
    }),
  ])
  const paid = new Set<string>()
  const legacyPeriods = new Set<string>()
  for (const sl of slips) {
    const ids = (sl.inputs as Record<string, unknown> | null)?.['otRecordIds']
    if (Array.isArray(ids)) ids.forEach((id) => paid.add(String(id)))
    else legacyPeriods.add(sl.run.period)
  }
  return records.filter((o) => !paid.has(o.id) && !(o.startDate && legacyPeriods.has(periodOf(o.startDate))))
}

export type PrefilledInputs = PayrollInputs & { loans: LoanLine[]; otRecordIds: string[] }

/** The month's payroll inputs for one employee, read from HR records.
 *  `runId` is the run they are for, left out of what other runs have claimed. */
export async function prefillInputs(tenantId: string, emp: HrEmployee, period: string, s?: HrSettings, runId?: string): Promise<PrefilledInputs> {
  const from = periodStart(period)
  const to = periodEnd(period)
  const settings = s ?? await getSettings(tenantId)
  const otFrom = await firstPayrollStart(tenantId, from)
  const [attendance, leaves, unpaidTypes, ot, adjustments, loans] = await Promise.all([
    prisma.hrRecord.findMany({
      where: { tenantId, section: 'attendance', employeeId: emp.id, status: STANDING_ATTENDANCE, startDate: { gte: from, lte: to } },
      select: { startDate: true, category: true, quantity: true, createdAt: true },
    }),
    prisma.hrRecord.findMany({ where: { tenantId, section: 'leave', employeeId: emp.id, status: 'approved', startDate: { lte: to }, endDate: { gte: from } } }),
    prisma.hrRecord.findMany({ where: { tenantId, section: 'leave_type', category: 'unpaid' }, select: { id: true } }),
    unpaidOvertime(tenantId, emp.id, otFrom, to, { runStatuses: ALL_RUN_STATUSES, exceptRunId: runId }),
    prisma.hrRecord.findMany({ where: { tenantId, section: 'payroll_adjustment', employeeId: emp.id, status: 'approved', effectiveDate: { gte: from, lte: to } } }),
    loansFor(tenantId, emp.id, { runStatuses: ALL_RUN_STATUSES, exceptRunId: runId }),
  ])
  const unpaid = new Set(unpaidTypes.map((t) => t.id))
  const inputs: PrefilledInputs = { ...EMPTY_INPUTS, loans: [], otRecordIds: [] }
  // Only the days the person was employed: the salary is already prorated to
  // them, so an absence or unpaid leave outside them would be charged twice.
  const wFrom = emp.joiningDate && emp.joiningDate > from ? emp.joiningDate : from
  const wTo = emp.lastWorkingDay && emp.lastWorkingDay < to ? emp.lastWorkingDay : to
  if (wFrom <= wTo) {
    Object.assign(inputs, attendanceInputs(
      wFrom, wTo,
      attendance.filter((a) => a.startDate).map((a) => ({ date: a.startDate!, status: a.category, lateMinutes: a.quantity, createdAt: a.createdAt })),
      leaves.filter((l) => l.startDate && l.endDate).map((l) => ({ startDate: l.startDate!, endDate: l.endDate!, quantity: l.quantity, unpaid: !!l.refId && unpaid.has(l.refId) })),
      settings,
    ))
  }
  for (const o of ot) {
    const d = o.data as Record<string, unknown>
    inputs.otHours += typeof d['approvedHours'] === 'number' ? d['approvedHours'] as number : o.quantity ?? 0
    inputs.otCents += o.amountCents ?? 0
    inputs.otRecordIds.push(o.id)
  }
  for (const a of adjustments) {
    if (a.category === 'deduction' || a.category === 'other_deduction') inputs.deductionAdjustmentsCents += a.amountCents ?? 0
    else inputs.earningAdjustmentsCents += a.amountCents ?? 0
  }
  for (const l of loans) {
    const cents = loanInstallmentCents({ amountCents: l.amountCents, installments: l.installments, firstPeriod: l.firstPeriod }, period, l.amountCents - l.outstandingCents)
    if (cents > 0) { inputs.loans.push({ loanId: l.id, cents }); inputs.loanInstallmentsCents += cents }
  }
  return inputs
}

/**
 * Leavers whose approved full & final settles `period` (settledFromPeriod):
 * the settlement pays from that month on, so no payroll for it or a later
 * month may pay them again (finance gaps: "F&F can pay a month twice").
 */
export async function settledEmployeeIds(tenantId: string, period: string, employeeIds?: string[], q: Db = prisma): Promise<Set<string>> {
  const recs = await q.hrRecord.findMany({
    where: { tenantId, section: 'final_settlement', status: 'approved', employeeId: employeeIds ? { in: employeeIds } : { not: null } },
    select: { employeeId: true, endDate: true, data: true },
  })
  const out = new Set<string>()
  for (const r of recs) {
    const from = settledFromPeriod(r)
    if (r.employeeId && from && from <= period) out.add(r.employeeId)
  }
  return out
}

/** Who is paid for `period`: anyone employed for at least one day of it —
 *  except a leaver whose approved full & final settles that month. */
export async function payableEmployees(tenantId: string, period: string, q: Db = prisma) {
  const from = periodStart(period)
  const to = periodEnd(period)
  const settled = await settledEmployeeIds(tenantId, period, undefined, q)
  return q.hrEmployee.findMany({
    where: {
      tenantId,
      OR: [{ joiningDate: null }, { joiningDate: { lte: to } }],
      AND: [{ OR: [{ lastWorkingDay: null }, { lastWorkingDay: { gte: from } }] }],
      NOT: { status: 'separated' },
      ...(settled.size > 0 && { id: { notIn: Array.from(settled) } }),
    },
    orderBy: { employeeCode: 'asc' },
  })
}

/**
 * Claim a draft run for a change, inside the transaction that makes it: an
 * approval landing meanwhile either waits for this to commit or has already
 * moved the run on, and then nothing is written. The person making the
 * change is recorded as one of its preparers — who may not approve it.
 */
async function claimDraft(tx: Tx, runId: string, actorId?: string) {
  const n = await tx.hrPayrollRun.updateMany({
    where: { id: runId, status: 'draft' },
    data: actorId ? { preparedByIds: { push: actorId } } : { updatedAt: new Date() },
  })
  if (n.count === 0) throw new AppError('RUN_NOT_DRAFT', 'This payroll is no longer a draft', 409)
}

function payslipData(r: ReturnType<typeof computePayslip>) {
  return {
    lines: r.lines as unknown as Prisma.InputJsonValue,
    grossCents: r.grossCents, earningsCents: r.earningsCents, deductionsCents: r.deductionsCents,
    eobiEmployeeCents: r.eobiEmployeeCents, eobiEmployerCents: r.eobiEmployerCents, netCents: r.netCents,
  }
}

/**
 * Warnings about WHO is being paid, by name (audit PPL-10): a login switched
 * off in Workforce while HR still has the person as current — a leaver handled
 * only in Workforce kept being paid in full with no word — and a termination
 * with no last working day, which pays the whole month.
 */
export async function staffingWarnings(emps: Array<Pick<HrEmployee, 'id' | 'userId' | 'fullName' | 'status' | 'lastWorkingDay'>>): Promise<Map<string, string[]>> {
  const userIds = emps.map((e) => e.userId).filter((u): u is string => !!u)
  const users = userIds.length
    ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, isActive: true, accountStatus: true, deletedAt: true } })
    : []
  const switchedOff = new Set(users.filter((u) => u.deletedAt || accountStateOf(u) === 'suspended').map((u) => u.id))
  const out = new Map<string, string[]>()
  for (const e of emps) {
    const w: string[] = []
    if (e.userId && switchedOff.has(e.userId) && ['active', 'on_leave'].includes(e.status)) {
      w.push(`${e.fullName}: their login is switched off in Workforce but HR still has them as ${e.status.replace('_', ' ')} — if they have left, record the separation in HR before paying`)
    }
    if (e.status === 'terminated' && !e.lastWorkingDay) {
      w.push(`${e.fullName}: terminated with no last working day, so paid for the whole month — set the last working day`)
    }
    if (w.length) out.set(e.id, w)
  }
  return out
}

export async function calculateRun(tenantId: string, runId: string, actorId?: string) {
  const run = await prisma.hrPayrollRun.findUniqueOrThrow({ where: { id: runId } })
  if (run.status !== 'draft') throw new AppError('RUN_NOT_DRAFT', 'Only a draft payroll can be recalculated', 409)
  // Due as of today — never the period end: a run for a later month must not
  // bring a revision forward. The month's own salary comes from salaryForPeriod.
  await applyDueEffects(tenantId)
  const s = await getSettings(tenantId)
  const emps = await payableEmployees(tenantId, run.period)
  const staffing = await staffingWarnings(emps)
  const slips: Prisma.HrPayslipCreateManyInput[] = []
  for (const emp of emps) {
    const inputs = await prefillInputs(tenantId, emp, run.period, s, runId)
    const salaryCents = await salaryForPeriod(emp, run.period)
    const r = computePayslip({ ...emp, grossSalaryCents: salaryCents }, run.period, inputs, s)
    slips.push({
      runId, tenantId, employeeId: emp.id,
      // How this person is paid, as it stood when the month was worked out:
      // paying the run credits cash slips to the safe and bank / cheque slips
      // to the bank picked (finance gaps #9) — a later change on the master
      // must not move a month already calculated.
      inputs: { ...inputs, salaryCents, paymentMethod: emp.paymentMethod ?? 'bank', warnings: [...r.warnings, ...(staffing.get(emp.id) ?? [])] } as unknown as Prisma.InputJsonValue,
      ...payslipData(r),
    })
  }
  // All or nothing: a failure part way must not leave a run missing people.
  return prisma.$transaction(async (tx) => {
    await claimDraft(tx, runId, actorId)
    await tx.hrPayslip.deleteMany({ where: { runId } })
    await tx.hrPayslip.createMany({ data: slips })
    return refreshRunTotals(runId, s, tx)
  })
}

/** Re-add the run's totals. Warnings are rebuilt from its payslips every time,
 *  so one edited payslip never clears a warning the others still carry. */
export async function refreshRunTotals(runId: string, s?: HrSettings, tx?: Tx) {
  const slips = await db(tx).hrPayslip.findMany({ where: { runId } })
  const sum = (k: 'grossCents' | 'earningsCents' | 'deductionsCents' | 'eobiEmployeeCents' | 'eobiEmployerCents' | 'netCents') => slips.reduce((a, x) => a + x[k], 0)
  const warnings = new Set<string>()
  for (const sl of slips) for (const w of ((sl.inputs as Record<string, unknown>)['warnings'] as string[] | undefined) ?? []) warnings.add(w)
  const totals = {
    employees: slips.length,
    grossCents: sum('grossCents'), earningsCents: sum('earningsCents'), deductionsCents: sum('deductionsCents'),
    eobiEmployeeCents: sum('eobiEmployeeCents'), eobiEmployerCents: sum('eobiEmployerCents'), netCents: sum('netCents'),
    warnings: Array.from(warnings),
  }
  return db(tx).hrPayrollRun.update({
    where: { id: runId },
    data: { totals: totals as Prisma.InputJsonValue, ...(s && { settings: s as unknown as Prisma.InputJsonValue }) },
  })
}

/** Why a run can't be approved or locked yet, or null. */
export async function runBlocker(runId: string): Promise<string | null> {
  const run = await prisma.hrPayrollRun.findUniqueOrThrow({ where: { id: runId }, select: { tenantId: true, period: true } })
  const slips = await prisma.hrPayslip.findMany({ where: { runId }, select: { inputs: true, employeeId: true, netCents: true, lines: true, employee: { select: { fullName: true } } } })
  // A payslip that pays less than nothing — a negative salary, or deductions
  // above earnings — is never approved, locked or paid (audit PPL-07: one was,
  // and the ledger's Wages Payable ended up wrong).
  const negative = slips.filter((sl) => sl.netCents < 0 || ((sl.lines as unknown as Array<{ amountCents: number }> | null) ?? []).some((l) => l.amountCents < 0))
  if (negative.length > 0) {
    return `${negative.length} payslip(s) come to less than nothing (${negative.map((sl) => sl.employee.fullName).join(', ')}) — correct the salary or the deductions and recalculate`
  }
  const noEobi = slips.filter((sl) => (((sl.inputs as Record<string, unknown>)['warnings'] as string[] | undefined) ?? []).includes(EOBI_NOT_CALCULATED)).length
  if (noEobi > 0) return `EOBI is not calculated on ${noEobi} payslip(s) — set the EOBI wage base in HR settings and recalculate`
  // Calculated before their full & final was approved: the settlement pays it.
  const settled = (await settledEmployeeIds(run.tenantId, run.period, slips.map((sl) => sl.employeeId))).size
  if (settled > 0) return `${settled} employee(s) on this payroll have been paid in a full & final settlement since it was calculated — recalculate it`
  return null
}

/** Recompute one payslip after HR edits its inputs. */
export async function recalcPayslip(payslipId: string, overrides: Partial<PayrollInputs>, actorId?: string) {
  const slip = await prisma.hrPayslip.findUniqueOrThrow({ where: { id: payslipId }, include: { run: true, employee: true } })
  if (slip.run.status !== 'draft') throw new AppError('RUN_NOT_DRAFT', 'This payroll is no longer a draft', 409)
  const s = await getSettings(slip.tenantId)
  const cur = slip.inputs as unknown as PrefilledInputs & { salaryCents?: number }
  const inputs = { ...cur, ...overrides, edited: true }
  const salaryCents = typeof cur.salaryCents === 'number' ? cur.salaryCents : await salaryForPeriod(slip.employee, slip.run.period)
  // New OT hours are paid at the OT rate — unless HR typed the amount too.
  const hoursEdited = overrides.otHours !== undefined && overrides.otHours !== cur.otHours
  const centsEdited = overrides.otCents !== undefined && overrides.otCents !== cur.otCents
  if (hoursEdited && !centsEdited) inputs.otCents = overtimeCents(overrides.otHours!, salaryCents, s)
  // An edited loan total is spread over the employee's loans, oldest first and
  // never beyond what each still owes — so what is recovered from each loan
  // is exactly what was deducted.
  if (overrides.loanInstallmentsCents !== undefined && overrides.loanInstallmentsCents !== cur.loanInstallmentsCents) {
    const loans = await loansFor(slip.tenantId, slip.employeeId, { runStatuses: ALL_RUN_STATUSES, exceptRunId: slip.runId })
    const split = allocateLoanCents(loans.map((l) => ({ loanId: l.id, outstandingCents: l.outstandingCents })), overrides.loanInstallmentsCents)
    if (!split) {
      const owed = loans.reduce((a, l) => a + l.outstandingCents, 0)
      throw new AppError('LOAN_OVER_OUTSTANDING', owed > 0
        ? `The loan deduction is more than the Rs ${(owed / 100).toFixed(2)} this employee still owes`
        : 'This employee has no loan outstanding to deduct', 400)
    }
    inputs.loans = split
  }
  const r = computePayslip({ ...slip.employee, grossSalaryCents: salaryCents }, slip.run.period, inputs, s)
  const staffing = (await staffingWarnings([slip.employee])).get(slip.employeeId) ?? []
  await prisma.$transaction(async (tx) => {
    await claimDraft(tx, slip.runId, actorId)
    await tx.hrPayslip.update({
      where: { id: payslipId },
      data: { inputs: { ...inputs, salaryCents, warnings: [...r.warnings, ...staffing] } as unknown as Prisma.InputJsonValue, ...payslipData(r) },
    })
    await refreshRunTotals(slip.runId, undefined, tx)
  })
}

// ─── Dashboard ──────────────────────────────────────────────────────────────

export async function dashboard(tenantIds: string[]) {
  const now = new Date()
  // Today and this month are Karachi's, not the server's UTC date.
  const today = pktToday(now)
  const month = periodOf(today)
  const mFrom = periodStart(month)
  const mTo = periodEnd(month)
  const mFromInstant = new Date(mFrom.getTime() - 5 * 3_600_000) // 00:00 PKT on the 1st, for timestamps
  const tomorrow = new Date(today.getTime() + 86_400_000)
  const within30 = new Date(today.getTime() + 30 * 86_400_000)
  const T = { tenantId: { in: tenantIds } }

  const [emps, docsExpiring, onLeave, todayAttendance, otMonth, resignations, terminations, lastRun] = await Promise.all([
    prisma.hrEmployee.findMany({ where: T }),
    prisma.hrDocument.count({ where: { ...T, expiryDate: { not: null, lte: within30 }, employee: { status: { in: ['active', 'on_leave'] } } } }),
    prisma.hrRecord.count({ where: { ...T, section: 'leave', status: 'approved', startDate: { lte: today }, endDate: { gte: today } } }),
    prisma.hrRecord.groupBy({ by: ['category'], where: { ...T, section: 'attendance', status: STANDING_ATTENDANCE, startDate: { gte: today, lt: tomorrow } }, _count: { _all: true } }),
    prisma.hrRecord.findMany({ where: { ...T, section: 'overtime', status: 'approved', startDate: { gte: mFrom, lte: mTo } }, select: { quantity: true, amountCents: true, data: true } }),
    prisma.hrRecord.count({ where: { ...T, section: 'resignation', status: { in: ['submitted', 'approved'] }, createdAt: { gte: mFromInstant } } }),
    prisma.hrRecord.count({ where: { ...T, section: 'termination', status: { in: ['submitted', 'approved'] }, createdAt: { gte: mFromInstant } } }),
    prisma.hrPayrollRun.findFirst({ where: T, orderBy: { period: 'desc' } }),
  ])
  const att = (k: string) => todayAttendance.find((a) => a.category === k)?._count._all ?? 0
  const active = emps.filter((e) => e.status === 'active' || e.status === 'on_leave')
  const count = (arr: typeof emps, key: 'departmentId' | 'locationId') => {
    const m = new Map<string, number>()
    for (const e of arr) m.set(e[key] ?? '', (m.get(e[key] ?? '') ?? 0) + 1)
    return m
  }
  const label = await employeeLabelsAcross(active)
  // The hours the approver approved, which is what the amount was priced on —
  // not the hours asked for.
  const otHours = otMonth.reduce((a, r) => {
    const approved = (r.data as Record<string, unknown>)['approvedHours']
    return a + (typeof approved === 'number' ? approved : r.quantity ?? 0)
  }, 0)
  const toList = (m: Map<string, number>) => Array.from(m.entries()).map(([id, n]) => ({ id: id || null, name: label(id) ?? 'Unassigned', count: n })).sort((a, b) => b.count - a.count)

  return {
    totalEmployees: emps.length,
    activeEmployees: active.length,
    inactiveEmployees: emps.length - active.length,
    newJoiners: emps.filter((e) => e.joiningDate && e.joiningDate >= mFrom && e.joiningDate <= mTo).length,
    resignations, terminations,
    onLeaveToday: onLeave,
    attendanceToday: { present: att('present'), absent: att('absent'), late: att('late'), recorded: todayAttendance.reduce((a, x) => a + x._count._all, 0) },
    overtimeThisMonth: { hours: otHours, amountCents: otMonth.reduce((a, r) => a + (r.amountCents ?? 0), 0) },
    payroll: lastRun ? { period: lastRun.period, status: lastRun.status, totals: lastRun.totals } : null,
    probationDue: active.filter((e) => e.employmentType === 'probation' && isDueWithin(e.probationEnd, 30, today)).length,
    confirmationDue: active.filter((e) => e.employmentType === 'probation' && e.probationEnd && e.probationEnd < now && !e.confirmationDate).length,
    contractExpiry: active.filter((e) => e.employmentType === 'contract' && isDueWithin(e.contractEnd, 30, today)).length,
    documentExpiry: docsExpiring + active.filter((e) => isDueWithin(e.cnicExpiry, 30, today)).length,
    byDepartment: toList(count(active, 'departmentId')),
    byBranch: toList(count(active, 'locationId')),
  }
}

/** Everything due soon, for the dashboard's alert list and the due reports. */
export async function dueList(tenantIds: string[], days = 30) {
  const now = pktToday()
  const T = { tenantId: { in: tenantIds } }
  const until = new Date(now.getTime() + days * 86_400_000)
  // Only people still here, and compliance items nobody cancelled.
  const [emps, docs, compliance] = await Promise.all([
    prisma.hrEmployee.findMany({ where: { ...T, status: { in: ['active', 'on_leave'] } } }),
    prisma.hrDocument.findMany({ where: { ...T, expiryDate: { not: null, lte: until }, employee: { status: { in: ['active', 'on_leave'] } } }, include: { employee: { select: { fullName: true, employeeCode: true } } } }),
    prisma.hrRecord.findMany({ where: { ...T, section: 'compliance_item', status: { not: 'cancelled' }, endDate: { not: null, lte: until } } }),
  ])
  const items: Array<{ kind: string; date: Date; employeeId?: string; who?: string; what: string }> = []
  for (const e of emps) {
    const who = `${e.fullName} (${e.employeeCode})`
    if (e.employmentType === 'probation' && isDueWithin(e.probationEnd, days, now)) items.push({ kind: 'probation', date: e.probationEnd!, employeeId: e.id, who, what: 'Probation ends' })
    if (e.employmentType === 'contract' && isDueWithin(e.contractEnd, days, now)) items.push({ kind: 'contract', date: e.contractEnd!, employeeId: e.id, who, what: 'Contract ends' })
    if (isDueWithin(e.cnicExpiry, days, now)) items.push({ kind: 'document', date: e.cnicExpiry!, employeeId: e.id, who, what: 'CNIC expires' })
  }
  for (const d of docs) items.push({ kind: 'document', date: d.expiryDate!, employeeId: d.employeeId, who: `${d.employee.fullName} (${d.employee.employeeCode})`, what: `${d.title || d.docType} expires` })
  for (const c of compliance) items.push({ kind: 'compliance', date: c.endDate!, what: `${String((c.data as Record<string, unknown>)['name'] ?? 'Compliance item')} expires` })
  return items.sort((a, b) => a.date.getTime() - b.date.getTime())
}

// ─── Letters ────────────────────────────────────────────────────────────────

const pkr = (c: unknown) => typeof c === 'number' ? `Rs ${(c / 100).toLocaleString('en-PK', { maximumFractionDigits: 0 })}` : c
const dt = (d: unknown) => {
  if (!d) return d
  const x = d instanceof Date ? d : new Date(String(d))
  return Number.isNaN(x.getTime()) ? d : x.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
}

/** Everything a letter can print. `tenantId` is the company issuing it — the
 *  employee's own — so names resolve in that company only. */
export async function letterContext(tenantId: string, emp: HrEmployee | null, rec: HrRecord | null) {
  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } })
  const label = emp ? await employeeLabels(tenantId, [emp]) : () => null
  const fmt = await (rec ? getFormat(tenantId, rec.section, rec.formVersion).catch(() => null) : null)
  const recordCtx: Record<string, unknown> = {}
  if (rec) {
    // Record values are printed the way their field type reads: money as
    // rupees, dates in words, references by name.
    const data = rec.data as Record<string, unknown>
    const refIds: string[] = []
    for (const fl of fmt?.fields ?? []) if (['orgunit', 'location', 'department', 'employee'].includes(fl.type) && typeof data[fl.key] === 'string') refIds.push(data[fl.key] as string)
    const [units, locs, depts, emps] = await Promise.all([
      prisma.hrOrgUnit.findMany({ where: { tenantId, id: { in: refIds } }, select: { id: true, name: true } }),
      prisma.location.findMany({ where: { tenantId, id: { in: refIds } }, select: { id: true, name: true } }),
      prisma.department.findMany({ where: { id: { in: refIds }, OR: [{ tenantId }, { tenantId: null }] }, select: { id: true, name: true } }),
      prisma.hrEmployee.findMany({ where: { tenantId, id: { in: refIds } }, select: { id: true, fullName: true } }),
    ])
    const names = new Map<string, string>([...units, ...locs, ...depts].map((x) => [x.id, x.name]))
    for (const e of emps) names.set(e.id, e.fullName)
    // A full & final's figures read as the books do (settlementParts): one it
    // never had — gratuity on a settlement made before it existed — is Rs 0,
    // not a blank in the statement.
    const parts = rec.section === 'final_settlement' ? settlementParts(data) as unknown as Record<string, number> : null
    for (const fl of fmt?.fields ?? []) {
      const v = parts && fl.key in parts && (data[fl.key] === undefined || data[fl.key] === null) ? parts[fl.key] : data[fl.key]
      if (fl.type === 'money') recordCtx[fl.key] = pkr(v)
      else if (fl.type === 'date' || fl.type === 'datetime') recordCtx[fl.key] = dt(v)
      else if (typeof v === 'string' && names.has(v)) recordCtx[fl.key] = names.get(v)
      else recordCtx[fl.key] = Array.isArray(v) ? v.join(', ') : v
    }
  }
  return {
    today: dt(new Date()),
    company: { name: tenant?.name ?? '' },
    employee: emp ? {
      ...((emp.data ?? {}) as Record<string, unknown>),
      fullName: emp.fullName, employeeCode: emp.employeeCode, cnic: emp.cnic,
      designation: label(emp.designationId), department: label(emp.departmentId), branch: label(emp.locationId), manager: label(emp.managerId),
      joiningDate: dt(emp.joiningDate), confirmationDate: dt(emp.confirmationDate), lastWorkingDay: dt(emp.lastWorkingDay),
      grossSalary: pkr(emp.grossSalaryCents), basicSalary: pkr(emp.basicSalaryCents),
      employmentType: emp.employmentType,
    } : {},
    record: recordCtx,
  }
}
