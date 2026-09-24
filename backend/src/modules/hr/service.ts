// HR data layer: formats, approvals and their effects, leave balances, loans,
// payroll runs, the dashboard. The arithmetic lives in logic.ts; this file
// fetches the numbers and puts the results back.

import type { Prisma, HrEmployee, HrRecord } from '@prisma/client'
import { serviceClient as prisma } from '../../lib/prisma.js'
import { AppError } from '../../lib/errors.js'
import {
  HR_SECTIONS, sectionByKey, EMPLOYEE_MASTER_FIELDS,
  type HrField, type HrSection, type WorkflowStep,
} from './forms.js'
import {
  mergeSettings, type HrSettings, type PayrollInputs, EMPTY_INPUTS,
  computePayslip, overtimeCents, hourlyRateCents, periodStart, periodEnd, periodOf,
  inclusiveDays, leaveYear, leaveBalance, loanInstallmentCents, isDueWithin,
} from './logic.js'

type Tx = Prisma.TransactionClient
const db = (tx?: Tx) => tx ?? prisma

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
  return {
    section, version: row.version, title: row.title,
    fields: row.fields as unknown as HrField[],
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
    out[sec.key] = row
      ? { section: sec.key, version: row.version, title: row.title, fields: row.fields as unknown as HrField[], workflow: row.workflow as unknown as WorkflowStep[], stages: row.stages as unknown as string[], isDefault: false }
      : defaultFormat(sec)
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

// ─── Approval effects ───────────────────────────────────────────────────────
//
// What an approved record does to the employee. Applied exactly once
// (appliedAt), and not before its effective date: a salary revision approved
// today for next month must not change this month's payroll.

const EFFECT_SECTIONS = ['promotion', 'transfer', 'salary_revision', 'probation_review', 'resignation', 'termination']

async function applyEffect(tx: Tx, rec: HrRecord, emp: HrEmployee): Promise<void> {
  const d = (rec.data ?? {}) as Record<string, unknown>
  const upd: Prisma.HrEmployeeUpdateInput = {}
  switch (rec.section) {
    case 'promotion':
      if (typeof d['newDesignation'] === 'string') upd.designationId = d['newDesignation']
      if (rec.amountCents && rec.amountCents > 0) upd.grossSalaryCents = rec.amountCents
      break
    case 'transfer':
      if (typeof d['newLocation'] === 'string') upd.locationId = d['newLocation']
      if (typeof d['newDepartment'] === 'string') upd.departmentId = d['newDepartment']
      if (typeof d['newManager'] === 'string' && d['newManager'] !== emp.id) upd.managerId = d['newManager']
      break
    case 'salary_revision':
      if (rec.amountCents && rec.amountCents > 0) upd.grossSalaryCents = rec.amountCents
      if (typeof d['revisedBasic'] === 'number' && d['revisedBasic'] > 0) upd.basicSalaryCents = d['revisedBasic']
      break
    case 'probation_review':
      if (rec.category === 'confirm') {
        upd.employmentType = 'permanent'
        upd.confirmationDate = rec.effectiveDate ?? new Date()
      } else if (rec.category === 'extend' && rec.effectiveDate) {
        upd.probationEnd = rec.effectiveDate
      }
      // 'terminate' is deliberately not automatic: it starts a termination,
      // which has its own approval.
      break
    case 'resignation':
      upd.status = 'resigned'
      if (rec.endDate) upd.lastWorkingDay = rec.endDate
      break
    case 'termination':
      upd.status = 'terminated'
      if (rec.endDate) upd.lastWorkingDay = rec.endDate
      break
  }
  if (Object.keys(upd).length) await tx.hrEmployee.update({ where: { id: emp.id }, data: upd })
  await tx.hrRecord.update({ where: { id: rec.id }, data: { appliedAt: new Date() } })
}

/** The date an effect should take hold. Separations apply at approval — the
 *  status is what starts the notice period — everything else at its effective date. */
function effectDue(rec: HrRecord, now: Date): boolean {
  if (rec.section === 'resignation' || rec.section === 'termination') return true
  const on = rec.effectiveDate
  return !on || on.getTime() <= now.getTime()
}

/** Apply every approved effect that has come due. Cheap and idempotent; runs
 *  before anything that reads salaries or statuses. */
export async function applyDueEffects(tenantId: string, now = new Date()): Promise<number> {
  const due = await prisma.hrRecord.findMany({
    where: { tenantId, section: { in: EFFECT_SECTIONS }, status: 'approved', appliedAt: null, employeeId: { not: null } },
    orderBy: { effectiveDate: 'asc' },
  })
  let n = 0
  for (const rec of due) {
    if (!effectDue(rec, now)) continue
    await prisma.$transaction(async (tx) => {
      // Claim first: two requests racing here must not both apply it.
      const claimed = await tx.hrRecord.updateMany({ where: { id: rec.id, appliedAt: null }, data: { appliedAt: new Date() } })
      if (claimed.count === 0) return
      const emp = await tx.hrEmployee.findUnique({ where: { id: rec.employeeId! } })
      if (emp) await applyEffect(tx, rec, emp)
      n++
    })
  }
  return n
}

/** Work done at the moment of final approval, before effects. */
export async function onFinalApproval(tx: Tx, rec: HrRecord, emp: HrEmployee | null, s: HrSettings, extra: { approvedHours?: number | null }) {
  const d = { ...((rec.data ?? {}) as Record<string, unknown>) }
  if (rec.section === 'overtime' && emp) {
    const hours = extra.approvedHours ?? (typeof d['approvedHours'] === 'number' ? d['approvedHours'] as number : rec.quantity ?? 0)
    const mult = typeof d['multiplier'] === 'number' && d['multiplier'] > 0 ? d['multiplier'] as number : s.otMultiplier
    const amount = overtimeCents(hours, emp.grossSalaryCents, s, mult)
    d['approvedHours'] = hours
    d['multiplier'] = mult
    d['otRate'] = Math.round(hourlyRateCents(emp.grossSalaryCents, s))
    d['otAmount'] = amount
    await tx.hrRecord.update({ where: { id: rec.id }, data: { amountCents: amount, data: d as Prisma.InputJsonValue } })
  }
}

// ─── Leave ──────────────────────────────────────────────────────────────────

export async function leaveBalancesFor(tenantId: string, employeeId: string, on = new Date()) {
  const s = await getSettings(tenantId)
  const [from, to] = leaveYear(on, s.leaveYearStartMonth)
  const [types, leaves, adjustments] = await Promise.all([
    prisma.hrRecord.findMany({ where: { tenantId, section: 'leave_type', status: 'approved' }, orderBy: { createdAt: 'asc' } }),
    prisma.hrRecord.findMany({ where: { tenantId, section: 'leave', employeeId, status: { in: ['approved', 'submitted'] }, startDate: { gte: from, lte: to } } }),
    prisma.hrRecord.findMany({ where: { tenantId, section: 'leave_adjustment', employeeId, status: 'approved' } }),
  ])
  return types.map((t) => {
    const data = t.data as Record<string, unknown>
    const mine = leaves.filter((l) => l.refId === t.id)
    const taken = mine.filter((l) => l.status === 'approved').reduce((a, l) => a + (l.quantity ?? 0), 0)
    const pending = mine.filter((l) => l.status === 'submitted').reduce((a, l) => a + (l.quantity ?? 0), 0)
    const adj = adjustments
      .filter((a) => a.refId === t.id && (a.effectiveDate ?? a.createdAt) >= from && (a.effectiveDate ?? a.createdAt) <= to)
      .reduce((a, x) => a + (x.quantity ?? 0), 0)
    return {
      leaveTypeId: t.id,
      name: String(data['name'] ?? 'Leave'),
      paid: t.category !== 'unpaid',
      yearFrom: from, yearTo: to,
      ...leaveBalance(t.quantity ?? 0, taken, adj, pending),
    }
  })
}

/** Before a leave application is submitted: fill in days, and refuse paid
 *  leave beyond the balance. Unpaid leave has no balance to exceed. */
export async function checkLeave(tenantId: string, rec: { employeeId: string | null; refId: string | null; startDate: Date | null; endDate: Date | null; quantity: number | null; id?: string }) {
  if (!rec.employeeId || !rec.refId || !rec.startDate || !rec.endDate) return { quantity: rec.quantity }
  if (rec.endDate < rec.startDate) throw new AppError('BAD_DATES', 'Leave cannot end before it starts', 400)
  const quantity = rec.quantity && rec.quantity > 0 ? rec.quantity : inclusiveDays(rec.startDate, rec.endDate)
  const type = await prisma.hrRecord.findFirst({ where: { id: rec.refId, tenantId, section: 'leave_type' } })
  if (!type) throw new AppError('BAD_LEAVE_TYPE', 'That leave type does not exist', 400)
  if (type.category !== 'unpaid') {
    const bal = (await leaveBalancesFor(tenantId, rec.employeeId, rec.startDate)).find((b) => b.leaveTypeId === type.id)
    // Pending includes this record if it was already submitted — don't count it twice.
    const self = rec.id ? await prisma.hrRecord.findUnique({ where: { id: rec.id }, select: { status: true, quantity: true } }) : null
    const pendingOthers = (bal?.pending ?? 0) - (self?.status === 'submitted' ? self.quantity ?? 0 : 0)
    const available = (bal?.balance ?? 0) - pendingOthers
    if (quantity > available) {
      throw new AppError('LEAVE_BALANCE', `Only ${Math.max(0, available)} day(s) of ${String((type.data as Record<string, unknown>)['name'] ?? 'this leave')} available`, 400)
    }
  }
  return { quantity }
}

// ─── Loans ──────────────────────────────────────────────────────────────────

/** Loans with how much has been recovered through LOCKED payroll runs. */
export async function loansFor(tenantId: string, employeeId?: string) {
  const loans = await prisma.hrRecord.findMany({
    where: { tenantId, section: 'loan', status: 'approved', ...(employeeId && { employeeId }) },
    orderBy: { createdAt: 'asc' },
  })
  if (loans.length === 0) return []
  const slips = await prisma.hrPayslip.findMany({
    where: { tenantId, run: { status: 'locked' }, ...(employeeId && { employeeId }) },
    select: { inputs: true },
  })
  const recovered = new Map<string, number>()
  for (const sl of slips) {
    for (const l of ((sl.inputs as Record<string, unknown>)['loans'] as Array<{ loanId: string; cents: number }> | undefined) ?? []) {
      recovered.set(l.loanId, (recovered.get(l.loanId) ?? 0) + l.cents)
    }
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

function overlapDays(aFrom: Date, aTo: Date, bFrom: Date, bTo: Date): number {
  const from = aFrom > bFrom ? aFrom : bFrom
  const to = aTo < bTo ? aTo : bTo
  return to < from ? 0 : inclusiveDays(from, to)
}

/** The month's payroll inputs for one employee, read from HR records. */
export async function prefillInputs(tenantId: string, emp: HrEmployee, period: string) {
  const from = periodStart(period)
  const to = periodEnd(period)
  const [attendance, leaves, unpaidTypes, ot, adjustments, loans] = await Promise.all([
    prisma.hrRecord.findMany({ where: { tenantId, section: 'attendance', employeeId: emp.id, startDate: { gte: from, lte: to } }, select: { category: true } }),
    prisma.hrRecord.findMany({ where: { tenantId, section: 'leave', employeeId: emp.id, status: 'approved', startDate: { lte: to }, endDate: { gte: from } } }),
    prisma.hrRecord.findMany({ where: { tenantId, section: 'leave_type', category: 'unpaid' }, select: { id: true } }),
    prisma.hrRecord.findMany({ where: { tenantId, section: 'overtime', employeeId: emp.id, status: 'approved', startDate: { gte: from, lte: to } } }),
    prisma.hrRecord.findMany({ where: { tenantId, section: 'payroll_adjustment', employeeId: emp.id, status: 'approved', effectiveDate: { gte: from, lte: to } } }),
    loansFor(tenantId, emp.id),
  ])
  const unpaid = new Set(unpaidTypes.map((t) => t.id))
  const inputs: PayrollInputs & { loans: Array<{ loanId: string; cents: number }> } = { ...EMPTY_INPUTS, loans: [] }
  for (const a of attendance) {
    if (a.category === 'absent') inputs.absentDays += 1
    else if (a.category === 'half_day') inputs.absentDays += 0.5
    else if (a.category === 'late') inputs.lateCount += 1
  }
  for (const l of leaves) {
    if (l.refId && unpaid.has(l.refId) && l.startDate && l.endDate) inputs.unpaidLeaveDays += overlapDays(l.startDate, l.endDate, from, to)
  }
  for (const o of ot) {
    const d = o.data as Record<string, unknown>
    inputs.otHours += typeof d['approvedHours'] === 'number' ? d['approvedHours'] as number : o.quantity ?? 0
    inputs.otCents += o.amountCents ?? 0
  }
  for (const a of adjustments) {
    if (a.category === 'deduction' || a.category === 'other_deduction') inputs.deductionAdjustmentsCents += a.amountCents ?? 0
    else inputs.earningAdjustmentsCents += a.amountCents ?? 0
  }
  for (const l of loans) {
    const cents = loanInstallmentCents({ amountCents: l.amountCents, installments: l.installments, firstPeriod: l.firstPeriod }, period, l.recoveredCents)
    if (cents > 0) { inputs.loans.push({ loanId: l.id, cents }); inputs.loanInstallmentsCents += cents }
  }
  return inputs
}

/** Who is paid for `period`: anyone employed for at least one day of it. */
export async function payableEmployees(tenantId: string, period: string) {
  const from = periodStart(period)
  const to = periodEnd(period)
  return prisma.hrEmployee.findMany({
    where: {
      tenantId,
      OR: [{ joiningDate: null }, { joiningDate: { lte: to } }],
      AND: [{ OR: [{ lastWorkingDay: null }, { lastWorkingDay: { gte: from } }] }],
      NOT: { status: 'separated' },
    },
    orderBy: { employeeCode: 'asc' },
  })
}

export async function calculateRun(tenantId: string, runId: string) {
  const run = await prisma.hrPayrollRun.findUniqueOrThrow({ where: { id: runId } })
  if (run.status !== 'draft') throw new AppError('RUN_NOT_DRAFT', 'Only a draft payroll can be recalculated', 409)
  await applyDueEffects(tenantId, periodEnd(run.period))
  const s = await getSettings(tenantId)
  const emps = await payableEmployees(tenantId, run.period)
  const warnings = new Set<string>()
  await prisma.hrPayslip.deleteMany({ where: { runId } })
  for (const emp of emps) {
    const inputs = await prefillInputs(tenantId, emp, run.period)
    const r = computePayslip(emp, run.period, inputs, s)
    r.warnings.forEach((w) => warnings.add(w))
    await prisma.hrPayslip.create({
      data: {
        runId, tenantId, employeeId: emp.id,
        inputs: { ...inputs, warnings: r.warnings } as unknown as Prisma.InputJsonValue,
        lines: r.lines as unknown as Prisma.InputJsonValue,
        grossCents: r.grossCents, earningsCents: r.earningsCents, deductionsCents: r.deductionsCents,
        eobiEmployeeCents: r.eobiEmployeeCents, eobiEmployerCents: r.eobiEmployerCents, netCents: r.netCents,
      },
    })
  }
  return refreshRunTotals(runId, s, Array.from(warnings))
}

export async function refreshRunTotals(runId: string, s?: HrSettings, warnings?: string[]) {
  const slips = await prisma.hrPayslip.findMany({ where: { runId } })
  const sum = (k: 'grossCents' | 'earningsCents' | 'deductionsCents' | 'eobiEmployeeCents' | 'eobiEmployerCents' | 'netCents') => slips.reduce((a, x) => a + x[k], 0)
  const totals = {
    employees: slips.length,
    grossCents: sum('grossCents'), earningsCents: sum('earningsCents'), deductionsCents: sum('deductionsCents'),
    eobiEmployeeCents: sum('eobiEmployeeCents'), eobiEmployerCents: sum('eobiEmployerCents'), netCents: sum('netCents'),
    ...(warnings && { warnings }),
  }
  return prisma.hrPayrollRun.update({
    where: { id: runId },
    data: { totals: totals as Prisma.InputJsonValue, ...(s && { settings: s as unknown as Prisma.InputJsonValue }) },
  })
}

/** Recompute one payslip after HR edits its inputs. */
export async function recalcPayslip(payslipId: string, overrides: Partial<PayrollInputs>) {
  const slip = await prisma.hrPayslip.findUniqueOrThrow({ where: { id: payslipId }, include: { run: true, employee: true } })
  if (slip.run.status !== 'draft') throw new AppError('RUN_NOT_DRAFT', 'This payroll is no longer a draft', 409)
  const s = await getSettings(slip.tenantId)
  const cur = slip.inputs as unknown as PayrollInputs & { loans?: Array<{ loanId: string; cents: number }> }
  const inputs = { ...cur, ...overrides, edited: true }
  // An edited loan total is honoured, but the per-loan split must still add up
  // to it — otherwise the recovered balance drifts from what was deducted.
  if (overrides.loanInstallmentsCents !== undefined && cur.loans?.length) {
    let left = overrides.loanInstallmentsCents
    inputs.loans = cur.loans.map((l) => { const c = Math.min(l.cents, Math.max(0, left)); left -= c; return { ...l, cents: c } })
  }
  const r = computePayslip(slip.employee, slip.run.period, inputs, s)
  await prisma.hrPayslip.update({
    where: { id: payslipId },
    data: {
      inputs: { ...inputs, warnings: r.warnings } as unknown as Prisma.InputJsonValue,
      lines: r.lines as unknown as Prisma.InputJsonValue,
      grossCents: r.grossCents, earningsCents: r.earningsCents, deductionsCents: r.deductionsCents,
      eobiEmployeeCents: r.eobiEmployeeCents, eobiEmployerCents: r.eobiEmployerCents, netCents: r.netCents,
    },
  })
  await refreshRunTotals(slip.runId)
}

// ─── Dashboard ──────────────────────────────────────────────────────────────

export async function dashboard(tenantIds: string[]) {
  const now = new Date()
  const month = periodOf(now)
  const mFrom = periodStart(month)
  const mTo = periodEnd(month)
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const tomorrow = new Date(today.getTime() + 86_400_000)
  const within30 = new Date(today.getTime() + 30 * 86_400_000)
  const T = { tenantId: { in: tenantIds } }

  const [emps, docsExpiring, onLeave, todayAttendance, otMonth, resignations, terminations, lastRun] = await Promise.all([
    prisma.hrEmployee.findMany({ where: T }),
    prisma.hrDocument.count({ where: { ...T, expiryDate: { not: null, lte: within30 } } }),
    prisma.hrRecord.count({ where: { ...T, section: 'leave', status: 'approved', startDate: { lte: today }, endDate: { gte: today } } }),
    prisma.hrRecord.groupBy({ by: ['category'], where: { ...T, section: 'attendance', startDate: { gte: today, lt: tomorrow } }, _count: { _all: true } }),
    prisma.hrRecord.aggregate({ where: { ...T, section: 'overtime', status: 'approved', startDate: { gte: mFrom, lte: mTo } }, _sum: { quantity: true, amountCents: true } }),
    prisma.hrRecord.count({ where: { ...T, section: 'resignation', status: { in: ['submitted', 'approved'] }, createdAt: { gte: mFrom } } }),
    prisma.hrRecord.count({ where: { ...T, section: 'termination', status: { in: ['submitted', 'approved'] }, createdAt: { gte: mFrom } } }),
    prisma.hrPayrollRun.findFirst({ where: T, orderBy: { period: 'desc' } }),
  ])
  const att = (k: string) => todayAttendance.find((a) => a.category === k)?._count._all ?? 0
  const active = emps.filter((e) => e.status === 'active' || e.status === 'on_leave')
  const count = (arr: typeof emps, key: 'departmentId' | 'locationId') => {
    const m = new Map<string, number>()
    for (const e of arr) m.set(e[key] ?? '', (m.get(e[key] ?? '') ?? 0) + 1)
    return m
  }
  const label = await employeeLabels(tenantIds[0] ?? '', active)
  const toList = (m: Map<string, number>) => Array.from(m.entries()).map(([id, n]) => ({ id: id || null, name: label(id) ?? 'Unassigned', count: n })).sort((a, b) => b.count - a.count)

  return {
    totalEmployees: emps.length,
    activeEmployees: active.length,
    inactiveEmployees: emps.length - active.length,
    newJoiners: emps.filter((e) => e.joiningDate && e.joiningDate >= mFrom && e.joiningDate <= mTo).length,
    resignations, terminations,
    onLeaveToday: onLeave,
    attendanceToday: { present: att('present'), absent: att('absent'), late: att('late'), recorded: todayAttendance.reduce((a, x) => a + x._count._all, 0) },
    overtimeThisMonth: { hours: otMonth._sum.quantity ?? 0, amountCents: otMonth._sum.amountCents ?? 0 },
    payroll: lastRun ? { period: lastRun.period, status: lastRun.status, totals: lastRun.totals } : null,
    probationDue: active.filter((e) => e.employmentType === 'probation' && isDueWithin(e.probationEnd, 30, now)).length,
    confirmationDue: active.filter((e) => e.employmentType === 'probation' && e.probationEnd && e.probationEnd < now && !e.confirmationDate).length,
    contractExpiry: active.filter((e) => e.employmentType === 'contract' && isDueWithin(e.contractEnd, 30, now)).length,
    documentExpiry: docsExpiring + active.filter((e) => isDueWithin(e.cnicExpiry, 30, now)).length,
    byDepartment: toList(count(active, 'departmentId')),
    byBranch: toList(count(active, 'locationId')),
  }
}

/** Everything due soon, for the dashboard's alert list and the due reports. */
export async function dueList(tenantIds: string[], days = 30) {
  const now = new Date()
  const T = { tenantId: { in: tenantIds } }
  const until = new Date(now.getTime() + days * 86_400_000)
  const [emps, docs, compliance] = await Promise.all([
    prisma.hrEmployee.findMany({ where: { ...T, status: { in: ['active', 'on_leave'] } } }),
    prisma.hrDocument.findMany({ where: { ...T, expiryDate: { not: null, lte: until } }, include: { employee: { select: { fullName: true, employeeCode: true } } } }),
    prisma.hrRecord.findMany({ where: { ...T, section: 'compliance_item', endDate: { not: null, lte: until } } }),
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
      prisma.hrOrgUnit.findMany({ where: { id: { in: refIds } }, select: { id: true, name: true } }),
      prisma.location.findMany({ where: { id: { in: refIds } }, select: { id: true, name: true } }),
      prisma.department.findMany({ where: { id: { in: refIds } }, select: { id: true, name: true } }),
      prisma.hrEmployee.findMany({ where: { id: { in: refIds } }, select: { id: true, fullName: true } }),
    ])
    const names = new Map<string, string>([...units, ...locs, ...depts].map((x) => [x.id, x.name]))
    for (const e of emps) names.set(e.id, e.fullName)
    for (const fl of fmt?.fields ?? []) {
      const v = data[fl.key]
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
