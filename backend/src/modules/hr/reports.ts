// HR reports — spec §30. Every report in the spec, as a table the admin can
// preview and download as CSV.
//
// Reports read across the companies the operator is viewing (the portfolio
// header), but formats come from the active company: a record report's columns
// are that company's current format for the section, so when HR changes a
// format the report follows without a code change.

import type { HrEmployee, HrRecord, Prisma } from '@prisma/client'
import { serviceClient as prisma } from '../../lib/prisma.js'
import { AppError } from '../../lib/errors.js'
import { getFormat, employeeLabelsAcross, leaveBalancesFor, STANDING_ATTENDANCE } from './service.js'
import { employedOn, onBooksAt, exitDay, pktToday, periodOf } from './logic.js'
import type { HrField } from './forms.js'

export type ReportParam = 'range' | 'asOf' | 'days' | 'period'

export interface ReportDef {
  key: string
  title: string
  group: string
  description: string
  params: ReportParam[]
}

export const REPORTS: ReportDef[] = [
  { key: 'employee_master', title: 'Employee master report', group: 'People', description: 'Every employee with personal, job, pay and statutory details.', params: [] },
  { key: 'headcount', title: 'Headcount report', group: 'People', description: 'Employed on a date, by department, branch, designation and type.', params: ['asOf'] },
  { key: 'branch_headcount', title: 'Branch-wise headcount', group: 'People', description: 'Employed on a date, per branch.', params: ['asOf'] },
  { key: 'department_headcount', title: 'Department-wise headcount', group: 'People', description: 'Employed on a date, per department.', params: ['asOf'] },
  { key: 'new_joiners', title: 'New joiner report', group: 'People', description: 'Joined within the dates.', params: ['range'] },
  { key: 'separations', title: 'Separation report', group: 'People', description: 'Last working day within the dates.', params: ['range'] },
  { key: 'turnover', title: 'Turnover report', group: 'People', description: 'Opening and closing headcount, joiners, leavers and turnover % per month.', params: ['range'] },
  { key: 'movement', title: 'Employee movement report', group: 'People', description: 'Approved promotions, transfers and salary revisions effective within the dates.', params: ['range'] },

  { key: 'attendance', title: 'Attendance report', group: 'Time', description: 'Every attendance entry within the dates.', params: ['range'] },
  { key: 'absenteeism', title: 'Absenteeism report', group: 'Time', description: 'Absences and half days per employee within the dates.', params: ['range'] },
  { key: 'late_coming', title: 'Late coming report', group: 'Time', description: 'Late arrivals and minutes lost per employee within the dates.', params: ['range'] },
  { key: 'overtime', title: 'OT report', group: 'Time', description: 'Overtime requests within the dates, with approved hours and amount.', params: ['range'] },
  { key: 'leave', title: 'Leave report', group: 'Time', description: 'Leave requests starting within the dates.', params: ['range'] },
  { key: 'leave_balance', title: 'Leave balance report', group: 'Time', description: 'Entitlement, taken, pending and balance per leave type, current leave year.', params: [] },

  { key: 'payroll', title: 'Payroll report', group: 'Pay', description: 'Payroll register for a month: gross, deductions, EOBI and net per employee.', params: ['period'] },
  { key: 'salary', title: 'Salary report', group: 'Pay', description: 'Current salary structure and payment details of every active employee.', params: [] },
  { key: 'eobi', title: 'EOBI report', group: 'Pay', description: 'Employee and employer EOBI contributions for a month.', params: ['period'] },
  { key: 'sessi', title: 'SESSI report', group: 'Pay', description: 'Employer SESSI contributions for a month.', params: ['period'] },
  { key: 'statutory', title: 'Statutory: accrued vs paid', group: 'Pay', description: 'EOBI, SESSI and salary tax owed, paid and still due each month — kept by Accounting → Statutory payments.', params: [] },
  { key: 'final_settlement', title: 'F&F report', group: 'Pay', description: 'Full and final settlements within the dates.', params: ['range'] },

  { key: 'probation_due', title: 'Probation due report', group: 'Due dates', description: 'Probation ending within the next N days (and already ended, unconfirmed).', params: ['days'] },
  { key: 'confirmation_due', title: 'Confirmation due report', group: 'Due dates', description: 'Probation over but not yet confirmed.', params: [] },
  { key: 'contract_expiry', title: 'Contract expiry report', group: 'Due dates', description: 'Contracts ending within the next N days.', params: ['days'] },
  { key: 'document_expiry', title: 'Document expiry report', group: 'Due dates', description: 'Documents and CNICs expiring within the next N days, or already expired.', params: ['days'] },

  { key: 'training', title: 'Training report', group: 'Development', description: 'Training programs and requests within the dates.', params: ['range'] },
  { key: 'performance', title: 'Performance report', group: 'Development', description: 'Performance reviews within the dates.', params: ['range'] },
]

export interface ReportQuery { from?: string; to?: string; asOf?: string; days?: string; period?: string }
export interface ReportTable { title: string; header: string[]; rows: unknown[][]; note?: string; link?: { path: string; label: string } }

/** Where EOBI / SESSI / salary tax accrued vs paid is worked out — ONE
 *  computation, from the books (accounting/statutory.ts statutorySummary). */
export const STATUTORY_PAGE = { path: '/accounting/statutory', label: 'Accounting → Statutory payments' }

export const rupees = (c: number | null | undefined) => (c == null ? null : (c / 100).toFixed(2))
const d10 = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null)

function parseDate(s: string | undefined, fallback: Date): Date {
  if (!s) return fallback
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) throw new AppError('BAD_DATE', `"${s}" is not a date`, 400)
  return d
}

function range(q: ReportQuery): [Date, Date] {
  const today = pktToday()
  const from = parseDate(q.from, new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1)))
  const to = parseDate(q.to, today)
  to.setUTCHours(23, 59, 59, 999)
  if (from > to) throw new AppError('BAD_RANGE', 'The start date is after the end date', 400)
  return [from, to]
}

function days(q: ReportQuery) {
  const n = parseInt(q.days ?? '30', 10)
  return Number.isFinite(n) ? Math.min(Math.max(n, 0), 730) : 30
}

/** For people marked gone with no last working day: when their approved
 *  resignation or termination said they left. */
async function exitDates(emps: HrEmployee[]): Promise<Map<string, Date>> {
  const ids = emps.filter((e) => !e.lastWorkingDay && !['active', 'on_leave'].includes(e.status)).map((e) => e.id)
  const out = new Map<string, Date>()
  if (!ids.length) return out
  const exits = await prisma.hrRecord.findMany({ where: { employeeId: { in: ids }, section: { in: ['resignation', 'termination'] }, status: 'approved' }, orderBy: { createdAt: 'asc' } })
  for (const x of exits) {
    const d = x.endDate ?? x.effectiveDate
    if (x.employeeId && d) out.set(x.employeeId, d)
  }
  return out
}

/** A record's date for reporting: its start date, else its effective date, else when it was raised. */
function inRangeWhere(from: Date, to: Date): Prisma.HrRecordWhereInput {
  const r = { gte: from, lte: to }
  return {
    OR: [
      { startDate: r },
      { startDate: null, effectiveDate: r },
      { startDate: null, effectiveDate: null, createdAt: r },
    ],
  }
}

// Record values printed the way their field reads: rupees, names for references.
export async function resolver(records: Array<Pick<HrRecord, 'data'>>, fields: HrField[]) {
  const ids = new Set<string>()
  for (const r of records) {
    const data = r.data as Record<string, unknown>
    for (const f of fields) {
      const v = data[f.key]
      if (['employee', 'location', 'department', 'orgunit', 'record'].includes(f.type) && typeof v === 'string') ids.add(v)
      if (f.type === 'employees' && Array.isArray(v)) for (const x of v) if (typeof x === 'string') ids.add(x)
    }
  }
  const list = Array.from(ids)
  const [emps, locs, depts, units] = list.length ? await Promise.all([
    prisma.hrEmployee.findMany({ where: { id: { in: list } }, select: { id: true, fullName: true } }),
    prisma.location.findMany({ where: { id: { in: list } }, select: { id: true, name: true } }),
    prisma.department.findMany({ where: { id: { in: list } }, select: { id: true, name: true } }),
    prisma.hrOrgUnit.findMany({ where: { id: { in: list } }, select: { id: true, name: true } }),
  ]) : [[], [], [], []]
  const m = new Map<string, string>()
  for (const e of emps) m.set(e.id, e.fullName)
  for (const x of [...locs, ...depts, ...units]) m.set(x.id, x.name)
  const name = (id: unknown) => (typeof id === 'string' ? m.get(id) ?? id : id)
  return (f: HrField, v: unknown): unknown => {
    if (v == null || v === '') return null
    switch (f.type) {
      case 'money': return typeof v === 'number' ? rupees(v) : v
      case 'employee': case 'location': case 'department': case 'orgunit': case 'record': return name(v)
      case 'employees': return Array.isArray(v) ? v.map(name) : v
      case 'boolean': return v ? 'Yes' : 'No'
      case 'table': return Array.isArray(v) ? `${v.length} row(s)` : v
      default: return v
    }
  }
}

/** A section's records within the dates, one column per field of the active format. */
async function recordReport(title: string, sections: string[], tenantIds: string[], activeTenantId: string, q: ReportQuery, extra: Prisma.HrRecordWhereInput = {}): Promise<ReportTable> {
  const [from, to] = range(q)
  const fmts = await Promise.all(sections.map((s) => getFormat(activeTenantId, s)))
  // Union of the sections' fields, in order, so a combined report (training
  // programs + requests) still reads as one table.
  const cols: HrField[] = []
  for (const fmt of fmts) for (const f of fmt.fields) if (f.bind !== 'employeeId' && !cols.some((c) => c.key === f.key)) cols.push(f)
  const rows = await prisma.hrRecord.findMany({
    where: { tenantId: { in: tenantIds }, section: { in: sections }, status: { not: 'cancelled' }, ...inRangeWhere(from, to), ...extra },
    include: { employee: { select: { fullName: true, employeeCode: true } } },
    orderBy: [{ startDate: 'asc' }, { createdAt: 'asc' }],
    take: 20_000,
  })
  const show = await resolver(rows, cols)
  return {
    title,
    header: [...(sections.length > 1 ? ['Type'] : []), 'Employee ID', 'Employee', ...cols.map((c) => c.label), 'Status', 'Stage', 'Raised'],
    rows: rows.map((r) => [
      ...(sections.length > 1 ? [fmts.find((f) => f.section === r.section)?.title ?? r.section] : []),
      r.employee?.employeeCode ?? null, r.employee?.fullName ?? null,
      ...cols.map((c) => show(c, (r.data as Record<string, unknown>)[c.key])),
      r.status, r.stage, d10(r.createdAt),
    ]),
  }
}

function inputCols(inputs: unknown) {
  const i = (inputs ?? {}) as Record<string, unknown>
  return [i['absentDays'] ?? 0, i['unpaidLeaveDays'] ?? 0, i['otHours'] ?? 0]
}

async function payrollRuns(tenantIds: string[], q: ReportQuery) {
  const period = q.period ?? periodOf(pktToday())
  if (!/^\d{4}-\d{2}$/.test(period)) throw new AppError('BAD_PERIOD', 'Month must be YYYY-MM', 400)
  const runs = await prisma.hrPayrollRun.findMany({ where: { tenantId: { in: tenantIds }, period }, select: { id: true, status: true } })
  const slips = runs.length ? await prisma.hrPayslip.findMany({
    where: { runId: { in: runs.map((r) => r.id) } },
    include: { employee: true },
    orderBy: { employee: { employeeCode: 'asc' } },
  }) : []
  const note = runs.length === 0 ? `No payroll run for ${period} yet.` : runs.some((r) => r.status !== 'locked') ? `The ${period} run is not locked yet — figures can still change.` : undefined
  return { period, slips, note }
}

export async function buildReport(key: string, tenantIds: string[], activeTenantId: string, q: ReportQuery): Promise<ReportTable> {
  const def = REPORTS.find((r) => r.key === key)
  if (!def) throw new AppError('UNKNOWN_REPORT', `No HR report "${key}"`, 404)
  const T = { tenantId: { in: tenantIds } }
  const now = new Date()

  switch (key) {
    case 'employee_master': {
      const rows = await prisma.hrEmployee.findMany({ where: T, orderBy: { employeeCode: 'asc' } })
      const label = await employeeLabelsAcross(rows)
      return {
        title: def.title,
        header: ['Employee ID', 'Name', 'Father/Husband', 'CNIC', 'CNIC expiry', 'Phone', 'Department', 'Designation', 'Branch', 'Manager', 'Type', 'Status', 'Joined', 'Probation end', 'Confirmed', 'Contract end', 'Last day', 'Basic', 'Gross', 'EOBI', 'SESSI', 'NTN', 'Bank', 'IBAN'],
        rows: rows.map((e) => [e.employeeCode, e.fullName, e.fatherHusbandName, e.cnic, d10(e.cnicExpiry), e.phone, label(e.departmentId), label(e.designationId), label(e.locationId), label(e.managerId), e.employmentType, e.status, d10(e.joiningDate), d10(e.probationEnd), d10(e.confirmationDate), d10(e.contractEnd), d10(e.lastWorkingDay), rupees(e.basicSalaryCents), rupees(e.grossSalaryCents), e.eobiNo, e.sessiNo, e.ntn, e.bankName, e.iban]),
      }
    }

    case 'headcount': case 'branch_headcount': case 'department_headcount': {
      const on = parseDate(q.asOf, pktToday())
      const all = await prisma.hrEmployee.findMany({ where: T })
      const exits = await exitDates(all)
      const emps = all.filter((e) => employedOn(e, on, exits.get(e.id)))
      const label = await employeeLabelsAcross(emps)
      const keyOf = (e: HrEmployee) =>
        key === 'branch_headcount' ? [label(e.locationId) ?? 'Unassigned']
        : key === 'department_headcount' ? [label(e.departmentId) ?? 'Unassigned']
        : [label(e.departmentId) ?? 'Unassigned', label(e.locationId) ?? 'Unassigned', label(e.designationId) ?? 'Unassigned', e.employmentType]
      const counts = new Map<string, { cols: string[]; n: number }>()
      for (const e of emps) {
        const cols = keyOf(e)
        const k = cols.join('\u0000')
        const cur = counts.get(k) ?? { cols, n: 0 }
        cur.n++
        counts.set(k, cur)
      }
      const rows = Array.from(counts.values()).sort((a, b) => a.cols.join().localeCompare(b.cols.join())).map((c) => [...c.cols, c.n])
      const header = key === 'branch_headcount' ? ['Branch', 'Headcount'] : key === 'department_headcount' ? ['Department', 'Headcount'] : ['Department', 'Branch', 'Designation', 'Type', 'Headcount']
      rows.push([...header.slice(0, -1).map((_, i) => (i === 0 ? 'Total' : '')), emps.length])
      return { title: `${def.title} — ${d10(on)}`, header, rows }
    }

    case 'new_joiners': case 'separations': {
      const [from, to] = range(q)
      const col = key === 'new_joiners' ? 'joiningDate' : 'lastWorkingDay'
      const emps = await prisma.hrEmployee.findMany({ where: { ...T, [col]: { gte: from, lte: to } }, orderBy: { [col]: 'asc' } })
      const label = await employeeLabelsAcross(emps)
      if (key === 'new_joiners') {
        return {
          title: def.title,
          header: ['Employee ID', 'Name', 'Joined', 'Department', 'Designation', 'Branch', 'Type', 'Probation end', 'Gross'],
          rows: emps.map((e) => [e.employeeCode, e.fullName, d10(e.joiningDate), label(e.departmentId), label(e.designationId), label(e.locationId), e.employmentType, d10(e.probationEnd), rupees(e.grossSalaryCents)]),
        }
      }
      // The reason comes from the approved resignation / termination record.
      const exits = await prisma.hrRecord.findMany({ where: { employeeId: { in: emps.map((e) => e.id) }, section: { in: ['resignation', 'termination'] }, status: 'approved' }, orderBy: { createdAt: 'desc' } })
      return {
        title: def.title,
        header: ['Employee ID', 'Name', 'Last working day', 'Joined', 'Department', 'Designation', 'Branch', 'Status', 'Exit type', 'Reason'],
        rows: emps.map((e) => {
          const x = exits.find((r) => r.employeeId === e.id)
          const data = (x?.data ?? {}) as Record<string, unknown>
          return [e.employeeCode, e.fullName, d10(e.lastWorkingDay), d10(e.joiningDate), label(e.departmentId), label(e.designationId), label(e.locationId), e.status, x?.section ?? null, x?.category ?? data['reason'] ?? null]
        }),
      }
    }

    case 'turnover': {
      const [from, to] = range(q)
      const emps = await prisma.hrEmployee.findMany({ where: T })
      const exits = await exitDates(emps)
      const gone = (e: HrEmployee) => exitDay(e, exits.get(e.id))
      const rows: unknown[][] = []
      let cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1))
      let guard = 0
      while (cursor <= to && guard++ < 60) {
        const monthStart = cursor
        const monthEnd = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 0, 23, 59, 59, 999))
        // Opening is who was on the books as the month began, closing who still
        // was once it ended — so someone leaving on the 31st is a leaver, not closing.
        const opening = emps.filter((e) => onBooksAt(e, new Date(monthStart.getTime() - 1), exits.get(e.id))).length
        const closing = emps.filter((e) => onBooksAt(e, monthEnd, exits.get(e.id))).length
        const joiners = emps.filter((e) => e.joiningDate && e.joiningDate >= monthStart && e.joiningDate <= monthEnd).length
        const leavers = emps.filter((e) => { const g = gone(e); return g && g >= monthStart && g <= monthEnd }).length
        const avg = (opening + closing) / 2
        rows.push([monthStart.toISOString().slice(0, 7), opening, joiners, leavers, closing, avg > 0 ? `${((leavers / avg) * 100).toFixed(1)}%` : '—'])
        cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1))
      }
      return { title: def.title, header: ['Month', 'Opening', 'Joiners', 'Leavers', 'Closing', 'Turnover %'], rows, note: 'Turnover % = leavers ÷ average of opening and closing headcount.' }
    }

    case 'movement':
      return recordReport(def.title, ['promotion', 'transfer', 'salary_revision'], tenantIds, activeTenantId, q, { status: 'approved' })

    case 'attendance':
      return recordReport(def.title, ['attendance'], tenantIds, activeTenantId, q)

    case 'absenteeism': case 'late_coming': {
      const [from, to] = range(q)
      const cats = key === 'absenteeism' ? ['absent', 'half_day'] : ['late']
      const recs = await prisma.hrRecord.findMany({
        where: { ...T, section: 'attendance', status: STANDING_ATTENDANCE, category: { in: cats }, startDate: { gte: from, lte: to } },
        include: { employee: { select: { employeeCode: true, fullName: true } } },
      })
      const by = new Map<string, { code: string; name: string; a: number; b: number; mins: number; dates: string[] }>()
      for (const r of recs) {
        if (!r.employeeId) continue
        const cur = by.get(r.employeeId) ?? { code: r.employee?.employeeCode ?? '', name: r.employee?.fullName ?? '', a: 0, b: 0, mins: 0, dates: [] }
        if (r.category === 'half_day') cur.b++
        else cur.a++
        cur.mins += r.quantity ?? 0
        cur.dates.push(d10(r.startDate) ?? '')
        by.set(r.employeeId, cur)
      }
      const list = Array.from(by.values()).sort((x, y) => (y.a + y.b / 2) - (x.a + x.b / 2))
      return key === 'absenteeism'
        ? { title: def.title, header: ['Employee ID', 'Name', 'Absent days', 'Half days', 'Days lost', 'Dates'], rows: list.map((x) => [x.code, x.name, x.a, x.b, x.a + x.b / 2, x.dates.sort().join(' ')]) }
        : { title: def.title, header: ['Employee ID', 'Name', 'Times late', 'Minutes late', 'Dates'], rows: list.map((x) => [x.code, x.name, x.a, x.mins, x.dates.sort().join(' ')]) }
    }

    case 'overtime':
      return recordReport(def.title, ['overtime'], tenantIds, activeTenantId, q)

    case 'leave':
      return recordReport(def.title, ['leave'], tenantIds, activeTenantId, q)

    case 'leave_balance': {
      const emps = await prisma.hrEmployee.findMany({ where: { ...T, status: { in: ['active', 'on_leave'] } }, orderBy: { employeeCode: 'asc' } })
      const rows: unknown[][] = []
      for (const e of emps) for (const b of await leaveBalancesFor(e.tenantId, e.id)) rows.push([e.employeeCode, e.fullName, b.name, b.entitlement, b.carriedForward, b.adjustments, b.taken, b.pending, b.balance])
      return { title: def.title, header: ['Employee ID', 'Name', 'Leave type', 'Entitlement', 'Carried forward', 'Adjustments', 'Taken', 'Pending', 'Balance'], rows }
    }

    case 'payroll': {
      const { period, slips, note } = await payrollRuns(tenantIds, q)
      return {
        title: `${def.title} — ${period}`, note,
        header: ['Employee ID', 'Name', 'Absent days', 'Unpaid leave', 'OT hours', 'Gross', 'Earnings', 'Deductions', 'EOBI employee', 'EOBI employer', 'Net', 'Payment'],
        rows: slips.map((s) => [s.employee.employeeCode, s.employee.fullName, ...inputCols(s.inputs), rupees(s.grossCents), rupees(s.earningsCents), rupees(s.deductionsCents), rupees(s.eobiEmployeeCents), rupees(s.eobiEmployerCents), rupees(s.netCents), s.employee.paymentMethod]),
      }
    }

    case 'salary': {
      const emps = await prisma.hrEmployee.findMany({ where: { ...T, status: { in: ['active', 'on_leave'] } }, orderBy: { employeeCode: 'asc' } })
      const label = await employeeLabelsAcross(emps)
      return {
        title: def.title,
        header: ['Employee ID', 'Name', 'Department', 'Designation', 'Grade', 'Basic', 'Gross', 'Monthly tax', 'Payment', 'Bank', 'IBAN'],
        rows: emps.map((e) => [e.employeeCode, e.fullName, label(e.departmentId), label(e.designationId), label(e.gradeId), rupees(e.basicSalaryCents), rupees(e.grossSalaryCents), rupees(e.monthlyTaxCents), e.paymentMethod, e.bankName, e.iban]),
      }
    }

    case 'eobi': {
      const { period, slips, note } = await payrollRuns(tenantIds, q)
      const rows: unknown[][] = slips.map((s) => [s.employee.employeeCode, s.employee.fullName, s.employee.cnic, s.employee.eobiNo, rupees(s.eobiEmployeeCents), rupees(s.eobiEmployerCents), rupees(s.eobiEmployeeCents + s.eobiEmployerCents)])
      const sum = (f: (s: (typeof slips)[number]) => number) => rupees(slips.reduce((a, s) => a + f(s), 0))
      if (slips.length) rows.push(['Total', '', '', '', sum((s) => s.eobiEmployeeCents), sum((s) => s.eobiEmployerCents), sum((s) => s.eobiEmployeeCents + s.eobiEmployerCents)])
      return { title: `${def.title} — ${period}`, note, header: ['Employee ID', 'Name', 'CNIC', 'EOBI no.', 'Employee share', 'Employer share', 'Total'], rows }
    }

    case 'sessi': {
      const { period, slips, note } = await payrollRuns(tenantIds, q)
      const amt = (s: (typeof slips)[number]) => (s.lines as Array<{ code: string; amountCents: number }>).filter((l) => l.code === 'sessi_employer').reduce((a, l) => a + l.amountCents, 0)
      const rows: unknown[][] = slips.map((s) => [s.employee.employeeCode, s.employee.fullName, s.employee.cnic, s.employee.sessiNo, rupees(s.grossCents), rupees(amt(s))])
      if (slips.length) rows.push(['Total', '', '', '', rupees(slips.reduce((a, s) => a + s.grossCents, 0)), rupees(slips.reduce((a, s) => a + amt(s), 0))])
      return { title: `${def.title} — ${period}`, note: note ?? (slips.length && slips.every((s) => amt(s) === 0) ? 'SESSI is 0 — set the employer % in HR settings.' : undefined), header: ['Employee ID', 'Name', 'CNIC', 'SESSI no.', 'Gross', 'Employer SESSI'], rows }
    }

    case 'final_settlement':
      return recordReport(def.title, ['final_settlement'], tenantIds, activeTenantId, q)

    case 'statutory':
      // Not worked out here: accrued vs paid is ONE computation, from the
      // ledger's 2042 / 2043 / 2044 and the payments recorded against them
      // (accounting/statutory.ts) — a second one from payslips would disagree
      // after a reclass, an F&F reversal or a payslip edited after posting.
      return {
        title: def.title,
        header: ['What', 'Where'],
        rows: [
          ['EOBI, SESSI and salary tax: accrued, paid and owed per month', `${STATUTORY_PAGE.label} (${STATUTORY_PAGE.path})`],
          ['Record or link a challan payment', `${STATUTORY_PAGE.label} (${STATUTORY_PAGE.path})`],
          ['Per-employee contributions for a month', 'HR reports → EOBI report / SESSI report'],
        ],
        note: 'EOBI, SESSI and salary tax are booked to 2043, 2044 and 2042 when payroll is locked and a full & final is approved, and paid over in Accounting → Statutory payments.',
        link: STATUTORY_PAGE,
      }

    case 'probation_due': case 'confirmation_due': case 'contract_expiry': {
      const n = days(q)
      const until = new Date(now.getTime() + n * 86_400_000)
      const where: Prisma.HrEmployeeWhereInput =
        key === 'probation_due' ? { employmentType: 'probation', confirmationDate: null, probationEnd: { not: null, lte: until } }
        : key === 'confirmation_due' ? { employmentType: 'probation', confirmationDate: null, probationEnd: { not: null, lt: now } }
        : { employmentType: 'contract', contractEnd: { not: null, lte: until } }
      const col = key === 'contract_expiry' ? 'contractEnd' : 'probationEnd'
      const emps = await prisma.hrEmployee.findMany({ where: { ...T, status: { in: ['active', 'on_leave'] }, ...where }, orderBy: { [col]: 'asc' } })
      const label = await employeeLabelsAcross(emps)
      return {
        title: def.title,
        header: ['Employee ID', 'Name', 'Department', 'Designation', 'Manager', 'Joined', key === 'contract_expiry' ? 'Contract ends' : 'Probation ends', 'Days left'],
        rows: emps.map((e) => {
          const d = e[col]!
          return [e.employeeCode, e.fullName, label(e.departmentId), label(e.designationId), label(e.managerId), d10(e.joiningDate), d10(d), Math.ceil((d.getTime() - now.getTime()) / 86_400_000)]
        }),
      }
    }

    case 'document_expiry': {
      const until = new Date(now.getTime() + days(q) * 86_400_000)
      const [docs, cnics] = await Promise.all([
        prisma.hrDocument.findMany({ where: { ...T, expiryDate: { not: null, lte: until } }, include: { employee: { select: { employeeCode: true, fullName: true, status: true } } } }),
        prisma.hrEmployee.findMany({ where: { ...T, status: { in: ['active', 'on_leave'] }, cnicExpiry: { not: null, lte: until } } }),
      ])
      const rows = [
        ...docs.filter((d) => ['active', 'on_leave'].includes(d.employee.status)).map((d) => ({ code: d.employee.employeeCode, name: d.employee.fullName, doc: d.title || d.docType, at: d.expiryDate! })),
        ...cnics.map((e) => ({ code: e.employeeCode, name: e.fullName, doc: 'CNIC', at: e.cnicExpiry! })),
      ].sort((a, b) => a.at.getTime() - b.at.getTime())
      return {
        title: def.title,
        header: ['Employee ID', 'Name', 'Document', 'Expires', 'Days left'],
        rows: rows.map((r) => [r.code, r.name, r.doc, d10(r.at), Math.ceil((r.at.getTime() - now.getTime()) / 86_400_000)]),
      }
    }

    case 'training':
      return recordReport(def.title, ['training', 'training_request'], tenantIds, activeTenantId, q)

    case 'performance':
      return recordReport(def.title, ['performance_review'], tenantIds, activeTenantId, q)
  }
  throw new AppError('UNKNOWN_REPORT', `No HR report "${key}"`, 404)
}
