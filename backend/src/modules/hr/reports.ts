// HR reports — Danish's four formats (owner, 2026-10-15: "kill old stuff ...
// And put danish formats in"). The catalogue is EXACTLY these four, with his
// column order and labels; nothing else. The HR dashboard is not a report.
//
//   employee_master   Employee Master
//   lifecycle_dues    Lifecycle & Dues
//   attendance_leaves Attendance & Leaves   (month)
//   payroll_report    Payroll Report        (month)
//
// Every format reads across the companies the operator is viewing (the
// portfolio header, `readTenants` in routes.ts) and never outside them. Each
// is a JSON table for the screen and an .xlsx laid out like Danish's
// workbook: the sheet title on row 1 (merged over rows 1–2), the header on
// row 4, data from row 5 (`reportXlsx`).
//
// One source per number:
//  - attendance comes from the HR attendance records the time clock writes,
//    read through logic.ts `attendanceInputs` — the same reading payroll uses,
//    so the format's Absents / Unpaid Leaves are what payroll docks;
//  - pay comes ONLY from the month's payroll run (its payslips' lines). This
//    file never works pay out again.
//
// No person's data lives in code: Danish's workbook rows were his test data.

import type { HrEmployee, HrRecord } from '@prisma/client'
import { serviceClient as prisma } from '../../lib/prisma.js'
import { AppError } from '../../lib/errors.js'
import { buildXlsx, colName, type XlsxCell } from '../../lib/xlsxWriter.js'
import { employeeLabelsAcross, managerLabelOf, getSettings, leaveBalancesFor, payableEmployees, STANDING_ATTENDANCE, payslipLoanLines } from './service.js'
import { attendanceInputs, daysInPeriod, inclusiveDays, leaveDaysWithin, periodOf, periodStart, periodEnd, pktToday, type HrSettings } from './logic.js'
import { noPunchWorkingDays, punchOvertimeRows } from './attendanceDays.js'
import type { HrField } from './forms.js'

export type ReportParam = 'month' | 'status' | 'department' | 'location'
/** How a column is shown: text as is, money in rupees (2 dp), a percent as "12.5%". */
export type ColumnKind = 'text' | 'date' | 'number' | 'money' | 'percent'

export interface ReportDef {
  key: string
  title: string
  description: string
  params: ReportParam[]
  /** Danish's columns, in his order (a format may add a trailing column, see each builder). */
  columns: string[]
}

const MASTER_COLS = ['Emp ID', 'Full Name', 'Father Name', 'CNIC Number', 'DOB', 'Gender', 'Contact No', 'Email Address', 'Branch Location', 'Department', 'Designation', 'Employment Type', 'DOJ', 'Reporting Manager', 'Status', 'Mode of Payment', 'Bank Name', 'Bank Account No', 'Account Title']
const MASTER_KINDS: ColumnKind[] = ['text', 'text', 'text', 'text', 'date', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'date', 'text', 'text', 'text', 'text', 'text', 'text']

const LIFECYCLE_COLS = ['Emp ID', 'Full Name', 'Department', 'DOJ', 'Employment Type', 'Confirmation / Expiry Date', 'Days Remaining', 'Review Status', 'CNIC Expiry Date', 'CNIC Days Remaining', 'CNIC Alert']
const LIFECYCLE_KINDS: ColumnKind[] = ['text', 'text', 'text', 'date', 'text', 'date', 'number', 'text', 'date', 'number', 'text']

/** The owner's out-of-area flag is the ONE column added to Danish's format, at the end. */
export const OUT_OF_AREA_COL = 'Out-of-area punches'
// Owner, 2026-10-22: leave AVAILED this month beside each balance (Casual / Annual / Sick Availed).
const ATTENDANCE_COLS = ['Emp ID', 'Full Name', 'Department', 'Total Days in Month', 'Days Worked', 'Unpaid Leaves', 'Absents', 'Late Arrivals', 'OT Hours', 'Casual Availed', 'Casual Balance', 'Annual Availed', 'Annual Balance', 'Sick Availed', 'Sick Balance', 'Absenteeism %', OUT_OF_AREA_COL]
const ATTENDANCE_KINDS: ColumnKind[] = ['text', 'text', 'text', 'number', 'number', 'number', 'number', 'number', 'number', 'number', 'number', 'number', 'number', 'number', 'number', 'percent', 'number']

/** Added after Net Salary Payable only when some payslip has a deduction with no column of its own. */
export const OTHER_DEDUCTIONS_COL = 'Other deductions'
const PAYROLL_COLS = ['Emp ID', 'Full Name', 'Department', 'Location', 'Cost Center', 'DOJ', 'Gross Salary', 'Days Worked', 'Salary Earned', 'Arrears / Discrepancy', 'OT Amount', 'Total Earned', 'Late Deduction', 'Loan Deduction', 'Unpaid Leave Ded.', 'Advance Salary', 'Income Tax', 'Total Deductions', 'Net Salary Payable']
const PAYROLL_KINDS: ColumnKind[] = ['text', 'text', 'text', 'text', 'text', 'date', 'money', 'number', 'money', 'money', 'money', 'money', 'money', 'money', 'money', 'money', 'money', 'money', 'money']

export const REPORTS: ReportDef[] = [
  { key: 'employee_master', title: 'Employee Master', description: 'Every employee: personal, job and payment details (the ERP primary table).', params: ['status', 'department', 'location'], columns: MASTER_COLS },
  { key: 'lifecycle_dues', title: 'Lifecycle & Dues', description: 'Probation, contract and confirmation dates with days remaining and review status; CNIC expiry alerts.', params: [], columns: LIFECYCLE_COLS },
  { key: 'attendance_leaves', title: 'Attendance & Leaves', description: 'Monthly time, attendance, overtime and leave per employee, from the time clock and HR attendance — plus out-of-area punches.', params: ['month'], columns: ATTENDANCE_COLS },
  { key: 'payroll_report', title: 'Payroll Report', description: 'The month\'s payroll sheet, read from the payroll run.', params: ['month'], columns: PAYROLL_COLS },
]

export interface ReportQuery { month?: string; status?: string; department?: string; location?: string }
export interface ReportTable {
  key: string
  title: string
  /** Row 1 of the .xlsx, as in Danish's workbook. */
  sheetTitle: string
  header: string[]
  /** One per header column. */
  kinds: ColumnKind[]
  rows: unknown[][]
  /** The last row is a totals row (payroll). */
  totalsRow?: boolean
  note?: string
  month?: string
}

export const rupees = (c: number | null | undefined) => (c == null ? null : (c / 100).toFixed(2))
/** Paisa → rupees as a number with 2 decimals (what the sheet sums). */
const rs = (c: number) => Math.round(c) / 100
const d10 = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null)
const DAY = 86_400_000
const dayOf = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
const r2 = (n: number) => Math.round(n * 100) / 100

const MONTHS = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER']
/** "2026-09" → "SEPTEMBER 2026". */
export function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return `${MONTHS[m! - 1]} ${y}`
}
const titleCase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase()

function monthOf(q: ReportQuery): string {
  const month = q.month ?? periodOf(pktToday())
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new AppError('BAD_MONTH', 'Month must be YYYY-MM', 400)
  return month
}

// ─── Labels as Danish writes them ───────────────────────────────────────────

const EMPLOYMENT_TYPE: Record<string, string> = { probation: 'On Probation', permanent: 'Permanent', contract: 'Contract', temporary: 'Temporary', intern: 'Intern' }
const STATUS: Record<string, string> = { active: 'Active', on_leave: 'On Leave', resigned: 'Resigned', terminated: 'Terminated', separated: 'Separated', transferred: 'Transferred' }
const PAYMENT: Record<string, string> = { bank: 'Bank Transfer', cash: 'Cash', cheque: 'Cheque' }
const label = (map: Record<string, string>, v: string | null | undefined) =>
  (v == null || v === '' ? null : map[v] ?? v.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()))
export const employmentTypeLabel = (v: string | null | undefined) => label(EMPLOYMENT_TYPE, v)

/** Danish's rule (Lifecycle & Dues, "Review Status"). */
export function reviewStatus(employmentType: string, daysRemaining: number | null): string {
  if (employmentType !== 'probation') return 'Confirmed'
  if (daysRemaining == null) return 'Under Probation'
  if (daysRemaining <= 0) return 'Confirmation Due'
  if (daysRemaining <= 30) return 'Review Pending'
  return 'Under Probation'
}

/** Danish's rule (Lifecycle & Dues, "CNIC Alert"); blank with no expiry on file. */
export function cnicAlert(daysRemaining: number | null): string | null {
  if (daysRemaining == null) return null
  if (daysRemaining <= 0) return 'Expired'
  if (daysRemaining <= 90) return 'Expiring Soon'
  return 'Valid'
}

/** Days from today (Karachi) to a date; null with no date. */
function daysUntil(d: Date | null | undefined, today: Date): number | null {
  return d ? Math.round((dayOf(d) - dayOf(today)) / DAY) : null
}

// ─── Shared look-ups ────────────────────────────────────────────────────────

/** Each employee's Branch Location: the primary work location's name, else
 *  their `locationId`'s (kept in step with the primary by the work-location API). */
async function branchNames(emps: HrEmployee[], tenantIds: string[], labelOf: (id: string | null | undefined) => string | null) {
  const rows = emps.length ? await prisma.hrWorkLocation.findMany({
    where: { tenantId: { in: tenantIds }, employeeId: { in: emps.map((e) => e.id) }, isPrimary: true },
    select: { employeeId: true, label: true, location: { select: { name: true } } },
  }) : []
  // A primary that is the employee's own map pin shows its label (owner, 2026-10-27).
  const primary = new Map(rows.map((r) => [r.employeeId, r.location?.name ?? r.label ?? null]))
  return (e: HrEmployee) => primary.get(e.id) ?? labelOf(e.locationId)
}

// ─── 1. Employee Master ─────────────────────────────────────────────────────

async function employeeMaster(def: ReportDef, tenantIds: string[], q: ReportQuery): Promise<ReportTable> {
  const where = {
    tenantId: { in: tenantIds },
    ...(q.status && { status: q.status }),
    ...(q.department && { departmentId: q.department }),
    ...(q.location && { OR: [{ locationId: q.location }, { workLocations: { some: { locationId: q.location } } }] }),
  }
  const emps = await prisma.hrEmployee.findMany({ where, orderBy: { employeeCode: 'asc' } })
  const labelOf = await employeeLabelsAcross(emps)
  const branch = await branchNames(emps, tenantIds, labelOf)
  return {
    key: def.key, title: def.title, sheetTitle: 'EMPLOYEE MASTER DATABASE (ERP PRIMARY TABLE)',
    header: MASTER_COLS, kinds: MASTER_KINDS,
    rows: emps.map((e) => {
      const data = (e.data ?? {}) as Record<string, unknown>
      const accountTitle = typeof data['accountTitle'] === 'string' ? data['accountTitle'] : null
      return [
        e.employeeCode, e.fullName, e.fatherHusbandName, e.cnic, d10(e.dateOfBirth), e.gender, e.phone, e.personalEmail,
        branch(e), labelOf(e.departmentId), labelOf(e.designationId), employmentTypeLabel(e.employmentType), d10(e.joiningDate),
        managerLabelOf(labelOf, e), label(STATUS, e.status), label(PAYMENT, e.paymentMethod), e.bankName, e.iban, accountTitle,
      ]
    }),
  }
}

// ─── 2. Lifecycle & Dues ────────────────────────────────────────────────────

/** The date Danish's "Confirmation / Expiry Date" column shows. */
function lifecycleDate(e: HrEmployee): Date | null {
  if (e.employmentType === 'probation') return e.probationEnd
  if (e.employmentType === 'contract') return e.contractEnd
  return e.confirmationDate
}

async function lifecycleDues(def: ReportDef, tenantIds: string[]): Promise<ReportTable> {
  const today = pktToday()
  const emps = await prisma.hrEmployee.findMany({ where: { tenantId: { in: tenantIds }, status: { in: ['active', 'on_leave'] } }, orderBy: { employeeCode: 'asc' } })
  const labelOf = await employeeLabelsAcross(emps)
  return {
    key: def.key, title: def.title, sheetTitle: 'EMPLOYEE LIFECYCLE & EXPIRY TRACKER (PROBATION, CONTRACTS, SEPARATIONS)',
    header: LIFECYCLE_COLS, kinds: LIFECYCLE_KINDS,
    rows: emps.map((e) => {
      const due = lifecycleDate(e)
      const days = daysUntil(due, today)
      const cnicDays = daysUntil(e.cnicExpiry, today)
      return [
        e.employeeCode, e.fullName, labelOf(e.departmentId), d10(e.joiningDate), employmentTypeLabel(e.employmentType),
        d10(due), days, reviewStatus(e.employmentType, days), d10(e.cnicExpiry), cnicDays, cnicAlert(cnicDays),
      ]
    }),
  }
}

// ─── 3. Attendance & Leaves ─────────────────────────────────────────────────

export interface MonthAttendance {
  /** The month's calendar days (28–31), always (owner, 2026-10-22). */
  totalDays: number
  /** Days with attendance in the month: present / late / early departure /
   *  missing punch 1, half day 0.5 (owner, 2026-10-22: "as per attendance"). */
  daysWorked: number
  /** The days payroll pays (employed − absents − unpaid leave, to today). */
  paidDays: number
  unpaidLeaves: number
  absents: number
  lateArrivals: number
  otHours: number
  casual: number | null
  annual: number | null
  sick: number | null
  /** Approved leave of that type taken in the month (days); null with no such leave type. */
  casualAvailed: number | null
  annualAvailed: number | null
  sickAvailed: number | null
  /** Absents ÷ the days employed so far; null when the person had no days in the month. */
  absenteeism: number | null
  outOfArea: number
}

/** How many out-of-area punches an attendance record notes (the time clock's
 *  flag, written for kiosk punches by staff without a login). */
function recordOutOfArea(data: unknown): number {
  const d = (data ?? {}) as Record<string, unknown>
  // Count punches, like the ClockLog count for logins: each punch copy in
  // _punches carries its own outOfArea (timeclock → attendance.ts recordPunch).
  const punches = Array.isArray(d['_punches']) ? (d['_punches'] as Array<Record<string, unknown> | null>) : []
  const n = punches.filter((p) => p && p['outOfArea'] === true).length
  if (n) return n
  return d['_outOfArea'] === true ? 1 : 0
}

/**
 * The month for each employee (owner, 2026-10-22).
 *
 * Total Days = the month's calendar days. Days Worked = days with attendance
 * (present / late / early departure / missing punch 1, half day 0.5; the
 * latest record of a day stands). Absents and Unpaid Leaves are logic.ts
 * `attendanceInputs` over the days employed up to today — exactly what payroll
 * docks: an absent record = 1, a half day = 0.5, and from the HR setting
 * `absentWithoutPunchFrom` a working day with no record (attendanceDays.ts
 * rule A); a day covered by leave is never an absence. OT Hours = approved
 * overtime + punch overtime (attendanceDays.ts rule B) on days with no
 * approved request — whether or not payroll has paid it. Availed = approved
 * leave of the type taken in the month; balances (leave_adjustment = HR's
 * allotment) are on the month's last day (today for the month in progress).
 */
export async function monthAttendance(emps: HrEmployee[], month: string): Promise<Map<string, MonthAttendance>> {
  const out = new Map<string, MonthAttendance>()
  if (!emps.length) return out
  const mStart = periodStart(month)
  const mEnd = periodEnd(month)
  const today = pktToday()
  const ids = emps.map((e) => e.id)
  const tenantIds = Array.from(new Set(emps.map((e) => e.tenantId)))
  const userIds = emps.map((e) => e.userId).filter((u): u is string => !!u)

  const [attendance, leaves, leaveTypes, overtime, clockOut] = await Promise.all([
    prisma.hrRecord.findMany({
      where: { tenantId: { in: tenantIds }, section: 'attendance', employeeId: { in: ids }, status: STANDING_ATTENDANCE, startDate: { gte: mStart, lte: mEnd } },
      select: { employeeId: true, tenantId: true, startDate: true, category: true, quantity: true, createdAt: true, data: true },
    }),
    prisma.hrRecord.findMany({
      where: { tenantId: { in: tenantIds }, section: 'leave', employeeId: { in: ids }, status: 'approved', startDate: { lte: mEnd }, endDate: { gte: mStart } },
      select: { employeeId: true, tenantId: true, startDate: true, endDate: true, quantity: true, refId: true },
    }),
    prisma.hrRecord.findMany({ where: { tenantId: { in: tenantIds }, section: 'leave_type' }, select: { id: true, category: true, data: true } }),
    prisma.hrRecord.findMany({
      where: { tenantId: { in: tenantIds }, section: 'overtime', employeeId: { in: ids }, status: 'approved', startDate: { gte: mStart, lte: mEnd } },
      select: { employeeId: true, tenantId: true, startDate: true, quantity: true, data: true },
    }),
    // Login punches outside every work location (Karachi month).
    userIds.length ? prisma.clockLog.findMany({
      where: { userId: { in: userIds }, tenantId: { in: tenantIds }, outOfArea: true, recordedAt: { gte: new Date(mStart.getTime() - 5 * 3_600_000), lt: new Date(mEnd.getTime() + 1 - 5 * 3_600_000) } },
      select: { userId: true, tenantId: true },
    }) : Promise.resolve([] as Array<{ userId: string; tenantId: string | null }>),
  ])
  const unpaid = new Set(leaveTypes.filter((t) => t.category === 'unpaid').map((t) => t.id))
  const typeName = new Map(leaveTypes.map((t) => [t.id, String(((t.data ?? {}) as Record<string, unknown>)['name'] ?? '')]))
  const settings = new Map<string, HrSettings>()
  for (const t of tenantIds) settings.set(t, await getSettings(t))
  const balanceOn = new Date(Math.min(dayOf(mEnd), dayOf(today)))
  const monthDays = daysInPeriod(month)
  // Rule A working days and rule B punch overtime, one read per company.
  const working = new Map<string, number[]>()
  const punchOt = new Map<string, Array<{ date: string; hours: number }>>()
  for (const t of tenantIds) {
    const mineT = emps.filter((e) => e.tenantId === t)
    const s = settings.get(t)!
    const [w, p] = await Promise.all([
      noPunchWorkingDays(t, mineT, mStart, mEnd, s, today),
      punchOvertimeRows(t, mineT, mStart, mEnd, s, prisma, today),
    ])
    for (const [k, v] of w) working.set(k, v)
    for (const x of p) punchOt.set(x.employeeId, [...(punchOt.get(x.employeeId) ?? []), { date: x.date, hours: x.hours }])
  }

  for (const e of emps) {
    const mine = <T extends { employeeId: string | null; tenantId: string | null }>(rows: T[]) => rows.filter((r) => r.employeeId === e.id && r.tenantId === e.tenantId)
    const wFrom = e.joiningDate && e.joiningDate > mStart ? new Date(dayOf(e.joiningDate)) : mStart
    let wTo = new Date(dayOf(mEnd))
    if (e.lastWorkingDay && dayOf(e.lastWorkingDay) < wTo.getTime()) wTo = new Date(dayOf(e.lastWorkingDay))
    if (dayOf(today) < wTo.getTime()) wTo = new Date(dayOf(today))
    const employedDays = wFrom <= wTo ? inclusiveDays(wFrom, wTo) : 0
    const att = mine(attendance)
    const myLeaves = mine(leaves).filter((l) => l.startDate && l.endDate)
    let absents = 0, unpaidLeaves = 0, lateArrivals = 0
    if (employedDays > 0) {
      const r = attendanceInputs(
        wFrom, wTo,
        att.filter((a) => a.startDate).map((a) => ({ date: a.startDate!, status: a.category, lateMinutes: a.quantity, createdAt: a.createdAt })),
        myLeaves.map((l) => ({ startDate: l.startDate!, endDate: l.endDate!, quantity: l.quantity, unpaid: !!l.refId && unpaid.has(l.refId) })),
        settings.get(e.tenantId)!,
        working.get(e.id) ?? [],
      )
      absents = r2(Math.min(r.absentDays, employedDays))
      unpaidLeaves = r2(Math.min(r.unpaidLeaveDays, Math.max(0, employedDays - absents)))
      lateArrivals = r.lateCount
    }
    // Days Worked: the latest record of each day.
    const latest = new Map<number, (typeof att)[number]>()
    for (const a of att) {
      if (!a.startDate) continue
      const cur = latest.get(dayOf(a.startDate))
      if (!cur || a.createdAt > cur.createdAt) latest.set(dayOf(a.startDate), a)
    }
    let daysWorked = 0
    for (const a of latest.values()) daysWorked += WORKED[a.category ?? ''] ?? 0
    // OT: approved overtime, plus punch OT on days with no approved request (no day counted twice).
    const approvedDays = new Set<string>()
    let otHours = 0
    for (const o of mine(overtime)) {
      const d = (o.data ?? {}) as Record<string, unknown>
      otHours += typeof d['approvedHours'] === 'number' ? d['approvedHours'] as number : o.quantity ?? 0
      if (o.startDate) approvedDays.add(o.startDate.toISOString().slice(0, 10))
    }
    for (const p of punchOt.get(e.id) ?? []) if (!approvedDays.has(p.date)) otHours += p.hours
    const balances = await leaveBalancesFor(e.tenantId, e.id, balanceOn)
    const bal = (re: RegExp) => { const b = balances.find((x) => re.test(x.name)); return b ? r2(b.balance) : null }
    const availed = (re: RegExp) => {
      if (!balances.some((x) => re.test(x.name))) return null
      return r2(myLeaves.filter((l) => l.refId && re.test(typeName.get(l.refId) ?? ''))
        .reduce((a, l) => a + leaveDaysWithin({ startDate: l.startDate!, endDate: l.endDate!, quantity: l.quantity }, mStart, mEnd), 0))
    }
    const outOfArea = e.userId
      ? clockOut.filter((c) => c.userId === e.userId && c.tenantId === e.tenantId).length
      : att.reduce((a, r) => a + recordOutOfArea(r.data), 0)
    out.set(e.id, {
      totalDays: monthDays, daysWorked: r2(daysWorked), paidDays: r2(Math.max(0, employedDays - absents - unpaidLeaves)),
      unpaidLeaves, absents, lateArrivals, otHours: r2(otHours),
      casual: bal(/casual/i), annual: bal(/annual/i), sick: bal(/sick/i),
      casualAvailed: availed(/casual/i), annualAvailed: availed(/annual/i), sickAvailed: availed(/sick/i),
      absenteeism: employedDays > 0 ? absents / employedDays : null,
      outOfArea,
    })
  }
  return out
}

/** What a day's attendance status counts towards Days Worked (owner, 2026-10-22). */
const WORKED: Record<string, number> = { present: 1, late: 1, early_departure: 1, missing_punch: 1, half_day: 0.5 }

const pct = (v: number | null) => (v == null ? null : `${(v * 100).toFixed(1)}%`)

async function attendanceLeaves(def: ReportDef, tenantIds: string[], q: ReportQuery): Promise<ReportTable> {
  const month = monthOf(q)
  // Who is on the month: the payroll's own list, per company.
  const emps = (await Promise.all(tenantIds.map((t) => payableEmployees(t, month)))).flat()
    .sort((a, b) => a.employeeCode.localeCompare(b.employeeCode))
  const [labelOf, att] = await Promise.all([employeeLabelsAcross(emps), monthAttendance(emps, month)])
  const inProgress = month === periodOf(pktToday())
  return {
    key: def.key, title: `${def.title} — ${month}`, month,
    sheetTitle: `MONTHLY TIME, ATTENDANCE, OVERTIME & LEAVE REPORT (${monthLabel(month)})`,
    header: ATTENDANCE_COLS, kinds: ATTENDANCE_KINDS,
    rows: emps.map((e) => {
      const a = att.get(e.id)!
      return [e.employeeCode, e.fullName, labelOf(e.departmentId), a.totalDays, a.daysWorked, a.unpaidLeaves, a.absents, a.lateArrivals, a.otHours, a.casualAvailed, a.casual, a.annualAvailed, a.annual, a.sickAvailed, a.sick, pct(a.absenteeism), a.outOfArea]
    }),
    note: [
      inProgress ? `${titleCase(monthLabel(month).split(' ')[0]!)} is not over: absents, leave balances and overtime are counted to today.` : null,
      'Total Days in Month is the whole month. Days Worked are the days with attendance (a half day counts 0.5). Absents and Unpaid Leaves are what payroll docks: an absent day, half of a half day, and a working day on the rota with no check-in (from the date set in HR settings) — a weekly off, a holiday or a day on approved leave is never an absence. A joiner or leaver is counted only for the days employed. OT Hours are approved overtime plus overtime worked after the rota shift from the punches (they are paid only when HR adds them to payroll). Availed is approved leave taken this month; balances include HR\'s leave adjustments and are on the month\'s last day.',
    ].filter(Boolean).join(' '),
  }
}

// ─── 4. Payroll Report ──────────────────────────────────────────────────────

type Line = { kind: string; code: string; amountCents: number; posting?: string }

/**
 * Where a payslip line goes in Danish's sheet. Earnings with no column of
 * their own are "Arrears / Discrepancy"; deductions with none (absence, EOBI
 * employee share, other) go to the trailing "Other deductions" column. Loan
 * installments split into Loan Deduction and Advance Salary by the loan's
 * type. Employer contributions are not on the sheet.
 */
const EARN_COL: Record<string, string> = { salary: 'Salary Earned', overtime: 'OT Amount' }
const DED_COL: Record<string, string> = { late: 'Late Deduction', unpaid_leave: 'Unpaid Leave Ded.', tax: 'Income Tax' }

async function payrollReport(def: ReportDef, tenantIds: string[], q: ReportQuery): Promise<ReportTable> {
  const month = monthOf(q)
  const runs = await prisma.hrPayrollRun.findMany({ where: { tenantId: { in: tenantIds }, period: month }, select: { id: true, status: true, tenantId: true } })
  const slips = runs.length ? await prisma.hrPayslip.findMany({
    where: { runId: { in: runs.map((r) => r.id) }, tenantId: { in: tenantIds } },
    include: { employee: true },
    orderBy: { employee: { employeeCode: 'asc' } },
  }) : []
  const companyIds = runs.length ? Array.from(new Set(runs.map((r) => r.tenantId))) : tenantIds
  const companies = await prisma.tenant.findMany({ where: { id: { in: companyIds } }, select: { name: true }, orderBy: { name: 'asc' } })
  const sheetTitle = `${companies.map((c) => c.name.toUpperCase()).join(' & ')} - MONTHLY PAYROLL SHEET (${monthLabel(month)})`

  if (!slips.length) {
    return { key: def.key, title: `${def.title} — ${month}`, month, sheetTitle, header: PAYROLL_COLS, kinds: PAYROLL_KINDS, rows: [], note: `No payroll run for ${month} yet` }
  }

  const emps = slips.map((s) => s.employee)
  const [labelOf, att, costCentres] = await Promise.all([
    employeeLabelsAcross(emps),
    monthAttendance(emps, month),
    // A cost centre is an HR org unit (kind cost_center): the one set on the
    // employee's profile (Cost center, data.costCenterId — 2026-10-17), else
    // the one whose parent is their department.
    prisma.hrOrgUnit.findMany({ where: { tenantId: { in: tenantIds }, kind: 'cost_center' }, select: { id: true, tenantId: true, parentId: true, name: true, isActive: true }, orderBy: { name: 'asc' } }),
  ])
  const branch = await branchNames(emps, tenantIds, labelOf)
  const costCentreOf = (e: HrEmployee) => {
    const own = ((e.data ?? {}) as Record<string, unknown>)['costCenterId']
    const set = typeof own === 'string' ? costCentres.find((c) => c.id === own && c.tenantId === e.tenantId) : undefined
    if (set) return set.name
    return costCentres.find((c) => c.isActive && c.parentId && c.tenantId === e.tenantId && c.parentId === e.departmentId)?.name ?? 'General'
  }

  // Which loans are salary advances (loan records, category 'advance').
  const loanIds = new Set<string>()
  for (const s of slips) for (const l of loanLinesOf(s.inputs)) loanIds.add(l.loanId)
  const advances = new Set(loanIds.size ? (await prisma.hrRecord.findMany({
    where: { id: { in: Array.from(loanIds) }, tenantId: { in: tenantIds }, section: 'loan', category: 'advance' }, select: { id: true },
  })).map((r) => r.id) : [])

  type Cents = { gross: number; earned: number; arrears: number; ot: number; totalEarned: number; late: number; loan: number; unpaid: number; advance: number; tax: number; other: number; totalDed: number; net: number }
  const perSlip: Array<{ s: (typeof slips)[number]; c: Cents }> = slips.map((s) => {
    const lines = (Array.isArray(s.lines) ? s.lines : []) as unknown as Line[]
    const inputs = (s.inputs ?? {}) as Record<string, unknown>
    const c: Cents = {
      gross: typeof inputs['salaryCents'] === 'number' ? inputs['salaryCents'] as number : s.employee.grossSalaryCents,
      earned: 0, arrears: 0, ot: 0, totalEarned: s.earningsCents, late: 0, loan: 0, unpaid: 0, advance: 0, tax: 0, other: 0,
      totalDed: s.deductionsCents, net: s.netCents,
    }
    let loanLine = 0
    for (const l of lines) {
      const amt = typeof l.amountCents === 'number' ? l.amountCents : 0
      if (l.kind === 'earning') {
        const col = EARN_COL[l.code]
        if (col === 'Salary Earned') c.earned += amt
        else if (col === 'OT Amount') c.ot += amt
        else c.arrears += amt
      } else if (l.kind === 'deduction') {
        // A typed recovery (advance / loan, owner 2026-10-30) is a loan recovery; a typed "Late" sits with lates.
        if (l.code === 'loan' || (l.code.startsWith('ded:') && l.posting === 'recovery')) loanLine += amt
        else if (l.code === 'ded:late') c.late += amt
        else if (DED_COL[l.code] === 'Late Deduction') c.late += amt
        else if (DED_COL[l.code] === 'Unpaid Leave Ded.') c.unpaid += amt
        else if (DED_COL[l.code] === 'Income Tax') c.tax += amt
        else c.other += amt
      }
    }
    const advanceCents = loanLinesOf(s.inputs).filter((l) => advances.has(l.loanId)).reduce((a, l) => a + l.cents, 0)
    c.advance = Math.min(loanLine, advanceCents)
    c.loan = loanLine - c.advance
    return { s, c }
  })
  const showOther = perSlip.some((x) => x.c.other !== 0)
  const header = showOther ? [...PAYROLL_COLS, OTHER_DEDUCTIONS_COL] : PAYROLL_COLS
  const kinds: ColumnKind[] = showOther ? [...PAYROLL_KINDS, 'money'] : PAYROLL_KINDS
  const money = (c: Cents) => [rs(c.gross)]
  const rest = (c: Cents) => [rs(c.earned), rs(c.arrears), rs(c.ot), rs(c.totalEarned), rs(c.late), rs(c.loan), rs(c.unpaid), rs(c.advance), rs(c.tax), rs(c.totalDed), rs(c.net), ...(showOther ? [rs(c.other)] : [])]

  const rows: unknown[][] = perSlip.map(({ s, c }) => [
    s.employee.employeeCode, s.employee.fullName, labelOf(s.employee.departmentId), branch(s.employee), costCentreOf(s.employee), d10(s.employee.joiningDate),
    ...money(c), paidDaysOf(s.inputs) ?? att.get(s.employee.id)?.paidDays ?? null, ...rest(c),
  ])
  const sum = (k: keyof Cents) => perSlip.reduce((a, x) => a + x.c[k], 0)
  const tot = Object.fromEntries((['gross', 'earned', 'arrears', 'ot', 'totalEarned', 'late', 'loan', 'unpaid', 'advance', 'tax', 'other', 'totalDed', 'net'] as const).map((k) => [k, sum(k)])) as Cents
  rows.push([null, null, `Total ${titleCase(monthLabel(month).split(' ')[0]!)} ${month.slice(0, 4)} Payroll`, null, null, null, ...money(tot), null, ...rest(tot)])

  const notLocked = runs.some((r) => r.status !== 'locked')
  return {
    key: def.key, title: `${def.title} — ${month}`, month, sheetTitle, header, kinds, rows, totalsRow: true,
    note: [
      notLocked ? `The ${month} run is not locked yet — figures can still change.` : null,
      'Figures are the payroll run\'s payslips. Salary Earned = Gross Salary ÷ the calendar days of the month × Days Worked (owner HR-1); Days Worked = days employed − absent days − unpaid leave days (weekly offs, holidays and paid leave are paid days), as the payslip worked them out — unpaid leave is already out of Salary Earned.',
      showOther ? `${OTHER_DEDUCTIONS_COL}: absence, EOBI (employee share) and other deductions — they have no column in this format.` : null,
    ].filter(Boolean).join(' '),
  }
}

/** The paid days a payslip was calculated on (inputs.payBasis, HR-1); null
 *  for a payslip from before it was kept. */
const paidDaysOf = (inputs: unknown): number | null => {
  const b = (inputs as Record<string, unknown> | null)?.['payBasis'] as { paidDays?: unknown } | undefined
  return b && typeof b.paidDays === 'number' ? b.paidDays : null
}

// Installments AND typed recoveries (service.ts payslipLoanLines, the one reading).
const loanLinesOf = payslipLoanLines

// ─── Entry points ───────────────────────────────────────────────────────────

/** Build a format for the companies in `tenantIds` (the caller's HR read scope). */
export async function buildReport(key: string, tenantIds: string[], _activeTenantId: string, q: ReportQuery): Promise<ReportTable> {
  const def = REPORTS.find((r) => r.key === key)
  if (!def) throw new AppError('UNKNOWN_REPORT', `No HR report "${key}"`, 404)
  switch (def.key) {
    case 'employee_master': return employeeMaster(def, tenantIds, q)
    case 'lifecycle_dues': return lifecycleDues(def, tenantIds)
    case 'attendance_leaves': return attendanceLeaves(def, tenantIds, q)
    case 'payroll_report': return payrollReport(def, tenantIds, q)
  }
  throw new AppError('UNKNOWN_REPORT', `No HR report "${key}"`, 404)
}

/** Danish's widths per column (characters), from his workbook. */
const WIDTHS: Record<string, number[]> = {
  employee_master: [12, 24, 23, 19, 14, 12, 16, 30, 19, 18, 29, 19, 14, 24, 12, 19, 23, 28, 24],
  lifecycle_dues: [12, 24, 18, 13, 16, 26, 16, 20, 18, 20, 16],
  attendance_leaves: [12, 24, 18, 20, 15, 15, 12, 15, 12, 15, 16, 15, 16, 14, 14, 15, 20],
  payroll_report: [12, 24, 18, 22, 15, 13, 16, 13, 16, 20, 15, 16, 16, 16, 18, 16, 15, 18, 20, 18],
}

/** The table as Danish's sheet: title on row 1 (merged A1:<last>2), the note
 *  (if any) on row 3, header on row 4, data from row 5. */
export function reportXlsx(t: ReportTable): Buffer {
  const last = colName(t.header.length - 1)
  const cell = (v: unknown, kind: ColumnKind, bold: boolean): XlsxCell => {
    if (v == null || v === '') return null
    if (kind === 'money' && typeof v === 'number') return { v, s: bold ? 'boldAmount' : 'amount' }
    if (kind === 'percent' && typeof v === 'string' && /^-?[\d.]+%$/.test(v)) return { v: Number(v.slice(0, -1)) / 100, s: 'percent' }
    if (typeof v === 'number') return bold ? { v, s: 'bold' } : v
    const s = Array.isArray(v) ? v.join(', ') : String(v)
    return bold ? { v: s, s: 'bold' } : s
  }
  const rows: XlsxCell[][] = [
    [{ v: t.sheetTitle, s: 'title' }],
    [],
    [t.note ?? null],
    t.header.map((h) => ({ v: h, s: 'header' as const })),
    ...t.rows.map((r, i) => {
      const bold = !!t.totalsRow && i === t.rows.length - 1
      return t.header.map((_, c) => cell(r[c], t.kinds[c] ?? 'text', bold))
    }),
  ]
  const merges = [`A1:${last}2`]
  if (t.totalsRow && t.rows.length) merges.push(`C${4 + t.rows.length}:F${4 + t.rows.length}`)
  const sheetName = REPORTS.find((r) => r.key === t.key)?.title ?? 'Report'
  return buildXlsx({ name: sheetName, widths: WIDTHS[t.key]?.slice(0, t.header.length), rows, merges })
}

// Record values printed the way their field reads: rupees, names for references.
// (Used by the section export in routes.ts.)
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
