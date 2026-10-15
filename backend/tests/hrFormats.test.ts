// Danish's four HR formats (owner, 2026-10-15) replace the old HR reports:
// Employee Master, Lifecycle & Dues, Attendance & Leaves, Payroll Report.
// Through the real routes (hr/routes.ts → hr/reports.ts) on Fastify inject,
// with two companies. Every person here is made up — never Danish's rows.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import type { UserRole } from '@prisma/client'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { runWithRlsContext } from '../src/lib/rlsContext.js'
import { hrRoutes } from '../src/modules/hr/routes.js'
import { REPORTS, reviewStatus, cnicAlert, OUT_OF_AREA_COL, OTHER_DEDUCTIONS_COL } from '../src/modules/hr/reports.js'
import { pktToday } from '../src/modules/hr/logic.js'

const P = `hrf-${Date.now()}`
const M = '2026-09'
const day = (d: number) => new Date(Date.UTC(2026, 8, d))
const fromToday = (n: number) => new Date(pktToday().getTime() + n * 86_400_000)

let app: FastifyInstance
let A: string, B: string, nameA: string
let deptA: string, deptB: string, locX: string, locY: string, locZ: string
const users: Record<string, { id: string; token: string }> = {}
const emp: Record<string, string> = {}

async function mkUser(key: string, role: UserRole, tenantId: string) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${P}@gsfoods.pk`, password: await bcrypt.hash('x-Password-1', 4), role, isActive: true, accountStatus: 'active', tenantId },
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } })
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
  return u.id
}

async function mkEmp(key: string, tenantId: string, extra: Record<string, unknown> = {}) {
  const e = await prisma.hrEmployee.create({
    data: {
      tenantId, employeeCode: `${P}-${key}`, fullName: `Person ${key}`, status: 'active', employmentType: 'permanent',
      joiningDate: new Date(Date.UTC(2024, 0, 1)), grossSalaryCents: 10_000_000, ...extra,
    },
  })
  emp[key] = e.id
  return e.id
}

const rec = (tenantId: string, section: string, data: Record<string, unknown>) =>
  prisma.hrRecord.create({ data: { tenantId, section, formVersion: 0, status: 'approved', ...data } as never })

const get = (who: string, url: string) =>
  app.inject({ method: 'GET', url: `/api/v1/hr${url}`, headers: { authorization: `Bearer ${users[who]!.token}` } })

type Table = { header: string[]; rows: unknown[][]; note?: string; sheetTitle: string; totalsRow?: boolean }
async function table(who: string, url: string): Promise<Table> {
  const r = await get(who, url)
  expect(r.statusCode, r.body).toBe(200)
  return r.json() as Table
}
const rowOf = (t: Table, key: string) => {
  const row = t.rows.find((r) => r[0] === `${P}-${key}`)
  expect(row, `row for ${key}`).toBeTruthy()
  return Object.fromEntries(t.header.map((h, i) => [h, row![i]])) as Record<string, unknown>
}

beforeAll(async () => {
  nameA = `Alpha Foods ${P}`
  A = (await prisma.tenant.create({ data: { name: nameA, slug: `${P}-a` } })).id
  B = (await prisma.tenant.create({ data: { name: `Beta Foods ${P}`, slug: `${P}-b` } })).id
  await mkUser('hrA', 'hr', A)
  await mkUser('hrB', 'hr', B)
  const loginA1 = await mkUser('a1', 'boh', A)

  deptA = (await prisma.department.create({ data: { tenantId: A, name: 'Kitchen' } })).id
  deptB = (await prisma.department.create({ data: { tenantId: B, name: 'Kitchen' } })).id
  await prisma.hrOrgUnit.create({ data: { tenantId: A, kind: 'cost_center', name: 'CC Kitchen', parentId: deptA } })
  const desig = (await prisma.hrOrgUnit.create({ data: { tenantId: A, kind: 'designation', name: 'Line Cook' } })).id
  locX = (await prisma.location.create({ data: { slug: `${P}-x`, name: 'Branch X', tenantId: A } })).id
  locY = (await prisma.location.create({ data: { slug: `${P}-y`, name: 'Branch Y', tenantId: A } })).id
  locZ = (await prisma.location.create({ data: { slug: `${P}-z`, name: 'Branch Z', tenantId: B } })).id

  // A1: on probation, review in 10 days, CNIC expiring in 30; works at X (primary) and Y.
  await mkEmp('a1', A, {
    userId: loginA1, departmentId: deptA, designationId: desig, locationId: locY, employmentType: 'probation',
    probationEnd: fromToday(10), cnicExpiry: fromToday(30), cnic: '00000-0000000-1', paymentMethod: 'bank',
    bankName: 'Test Bank', iban: 'PK00TEST0001', data: { accountTitle: 'Person a1' },
  })
  await prisma.hrWorkLocation.create({ data: { tenantId: A, employeeId: emp.a1!, locationId: locX, isPrimary: true } })
  await prisma.hrWorkLocation.create({ data: { tenantId: A, employeeId: emp.a1!, locationId: locY, isPrimary: false } })
  // A2: permanent, CNIC expired, no login (kiosk), no department.
  await mkEmp('a2', A, { cnicExpiry: fromToday(-1), confirmationDate: new Date(Date.UTC(2024, 6, 1)), paymentMethod: 'cash' })
  // A3: probation over yesterday; A4: probation 60 days left; A5: contract; A6: resigned.
  await mkEmp('a3', A, { employmentType: 'probation', probationEnd: fromToday(-1) })
  await mkEmp('a4', A, { employmentType: 'probation', probationEnd: fromToday(60), cnicExpiry: fromToday(200) })
  await mkEmp('a5', A, { employmentType: 'contract', contractEnd: fromToday(45) })
  await mkEmp('a6', A, { status: 'resigned', lastWorkingDay: new Date(Date.UTC(2026, 5, 30)) })
  // Company B.
  await mkEmp('b1', B, { departmentId: deptB, locationId: locZ })

  // Leave types (company A): casual 10, annual 14, sick 8, unpaid.
  const casual = (await rec(A, 'leave_type', { quantity: 10, category: 'paid', data: { name: 'Casual Leave' } })).id
  await rec(A, 'leave_type', { quantity: 14, category: 'paid', data: { name: 'Annual Leave' } })
  await rec(A, 'leave_type', { quantity: 8, category: 'paid', data: { name: 'Sick Leave' } })
  const unpaid = (await rec(A, 'leave_type', { quantity: 0, category: 'unpaid', data: { name: 'Unpaid Leave' } })).id

  // A1's September: absent 2nd, half day 3rd, late 30 min on 4th, unpaid leave 10th,
  // casual leave 15–16th (paid), 3 OT hours approved.
  const att = (employeeId: string, d: number, category: string, extra: Record<string, unknown> = {}) =>
    rec(A, 'attendance', { employeeId, startDate: day(d), category, ...extra })
  await att(emp.a1!, 2, 'absent')
  await att(emp.a1!, 3, 'half_day')
  await att(emp.a1!, 4, 'late', { quantity: 30 })
  await att(emp.a1!, 5, 'present')
  await rec(A, 'leave', { employeeId: emp.a1, refId: unpaid, startDate: day(10), endDate: day(10), quantity: 1 })
  await rec(A, 'leave', { employeeId: emp.a1, refId: casual, startDate: day(15), endDate: day(16), quantity: 2 })
  await rec(A, 'overtime', { employeeId: emp.a1, startDate: day(5), quantity: 3, amountCents: 500_000 })
  // A2 punched out of area on the kiosk once (the time clock's flag on the day's record).
  await att(emp.a2!, 8, 'present', { data: { _outOfArea: true } })

  // A1's login punches: two out of area in A, one inside, one out of area in B (not A's).
  for (const [outOfArea, tenantId] of [[true, A], [true, A], [false, A], [true, B]] as const) {
    await prisma.clockLog.create({ data: { userId: loginA1, type: 'in', recordedAt: new Date(Date.UTC(2026, 8, 7, 5)), outOfArea, tenantId } })
  }

  // September payroll (A, locked) with A1's payslip.
  const advance = (await rec(A, 'loan', { employeeId: emp.a1, category: 'advance', amountCents: 250_000, quantity: 1 })).id
  const loan = (await rec(A, 'loan', { employeeId: emp.a1, category: 'loan', amountCents: 3_500_000, quantity: 10 })).id
  const runA = await prisma.hrPayrollRun.create({ data: { tenantId: A, period: M, status: 'locked', settings: {} } })
  await prisma.hrPayslip.create({
    data: {
      runId: runA.id, tenantId: A, employeeId: emp.a1!,
      inputs: { salaryCents: 10_000_000, loans: [{ loanId: advance, cents: 250_000 }, { loanId: loan, cents: 350_000 }] },
      lines: [
        { kind: 'earning', code: 'salary', label: 'Salary', amountCents: 9_000_000 },
        { kind: 'earning', code: 'overtime', label: 'Overtime', amountCents: 500_000 },
        { kind: 'earning', code: 'adjustments', label: 'Bonus', amountCents: 100_000 },
        { kind: 'deduction', code: 'absence', label: 'Absence', amountCents: 450_000 },
        { kind: 'deduction', code: 'unpaid_leave', label: 'Unpaid leave', amountCents: 300_000 },
        { kind: 'deduction', code: 'late', label: 'Late', amountCents: 200_000 },
        { kind: 'deduction', code: 'eobi_employee', label: 'EOBI', amountCents: 37_000 },
        { kind: 'deduction', code: 'tax', label: 'Income tax', amountCents: 150_000 },
        { kind: 'deduction', code: 'loan', label: 'Loan', amountCents: 600_000 },
        { kind: 'employer', code: 'eobi_employer', label: 'EOBI employer', amountCents: 185_000 },
      ],
      grossCents: 9_000_000, earningsCents: 9_600_000, deductionsCents: 1_737_000, eobiEmployeeCents: 37_000, eobiEmployerCents: 185_000, netCents: 7_863_000,
    },
  })
  await prisma.hrPayslip.create({
    data: {
      runId: runA.id, tenantId: A, employeeId: emp.a2!, inputs: { salaryCents: 10_000_000 },
      lines: [{ kind: 'earning', code: 'salary', label: 'Salary', amountCents: 10_000_000 }],
      grossCents: 10_000_000, earningsCents: 10_000_000, deductionsCents: 0, eobiEmployeeCents: 0, eobiEmployerCents: 0, netCents: 10_000_000,
    },
  })
  const runB = await prisma.hrPayrollRun.create({ data: { tenantId: B, period: M, status: 'draft', settings: {} } })
  await prisma.hrPayslip.create({
    data: {
      runId: runB.id, tenantId: B, employeeId: emp.b1!, inputs: {}, lines: [{ kind: 'earning', code: 'salary', label: 'Salary', amountCents: 1 }],
      grossCents: 1, earningsCents: 1, deductionsCents: 0, eobiEmployeeCents: 0, eobiEmployerCents: 0, netCents: 1,
    },
  })

  app = Fastify()
  app.addHook('onRequest', (_req, _reply, done) => { runWithRlsContext({}, () => done()) })
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: err.message } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(async (api) => { await api.register(hrRoutes, { prefix: '/hr' }) }, { prefix: '/api/v1' })
  await app.ready()
}, 60_000)

afterAll(async () => { await app?.close() })

describe('the catalogue', () => {
  it('is exactly Danish\'s four formats', async () => {
    const r = await get('hrA', '/reports')
    expect(r.statusCode).toBe(200)
    expect((r.json() as Array<{ key: string; title: string }>).map((x) => [x.key, x.title])).toEqual([
      ['employee_master', 'Employee Master'], ['lifecycle_dues', 'Lifecycle & Dues'],
      ['attendance_leaves', 'Attendance & Leaves'], ['payroll_report', 'Payroll Report'],
    ])
    expect(REPORTS).toHaveLength(4)
  })
  it('an old report key is gone', async () => {
    for (const key of ['headcount', 'turnover', 'leave_balance', 'payroll', 'eobi', 'statutory']) {
      expect((await get('hrA', `/reports/${key}`)).statusCode).toBe(404)
    }
  })
})

describe('Employee Master', () => {
  it('Danish\'s columns, in order; Branch Location is the primary work location', async () => {
    const t = await table('hrA', '/reports/employee_master')
    expect(t.sheetTitle).toBe('EMPLOYEE MASTER DATABASE (ERP PRIMARY TABLE)')
    expect(t.header).toEqual(['Emp ID', 'Full Name', 'Father Name', 'CNIC Number', 'DOB', 'Gender', 'Contact No', 'Email Address', 'Branch Location', 'Department', 'Designation', 'Employment Type', 'DOJ', 'Reporting Manager', 'Status', 'Mode of Payment', 'Bank Name', 'Bank Account No', 'Account Title'])
    const a1 = rowOf(t, 'a1')
    expect(a1).toMatchObject({
      'Full Name': 'Person a1', 'CNIC Number': '00000-0000000-1', 'Branch Location': 'Branch X', Department: 'Kitchen', Designation: 'Line Cook',
      'Employment Type': 'On Probation', DOJ: '2024-01-01', Status: 'Active', 'Mode of Payment': 'Bank Transfer', 'Bank Name': 'Test Bank',
      'Bank Account No': 'PK00TEST0001', 'Account Title': 'Person a1',
    })
    expect(rowOf(t, 'a2')['Mode of Payment']).toBe('Cash')
  })
  it('filters: status, department, a (secondary) work location', async () => {
    const codes = (t: Table) => t.rows.map((r) => r[0])
    expect(codes(await table('hrA', '/reports/employee_master?status=resigned'))).toEqual([`${P}-a6`])
    expect(codes(await table('hrA', `/reports/employee_master?department=${deptA}`))).toEqual([`${P}-a1`])
    expect(codes(await table('hrA', `/reports/employee_master?location=${locY}`))).toEqual([`${P}-a1`])
  })
  it('two companies: never the other company\'s people, even by its ids', async () => {
    const a = await table('hrA', '/reports/employee_master')
    expect(a.rows.some((r) => r[0] === `${P}-b1`)).toBe(false)
    expect((await table('hrA', `/reports/employee_master?department=${deptB}`)).rows).toHaveLength(0)
    expect((await table('hrA', `/reports/employee_master?location=${locZ}`)).rows).toHaveLength(0)
    const b = await table('hrB', '/reports/employee_master')
    expect(b.rows.map((r) => r[0])).toEqual([`${P}-b1`])
  })
})

describe('Lifecycle & Dues', () => {
  it('Danish\'s rules: review status and CNIC alert', () => {
    expect(reviewStatus('probation', 0)).toBe('Confirmation Due')
    expect(reviewStatus('probation', -5)).toBe('Confirmation Due')
    expect(reviewStatus('probation', 30)).toBe('Review Pending')
    expect(reviewStatus('probation', 31)).toBe('Under Probation')
    expect(reviewStatus('permanent', -100)).toBe('Confirmed')
    expect(reviewStatus('contract', 5)).toBe('Confirmed')
    expect(cnicAlert(0)).toBe('Expired')
    expect(cnicAlert(90)).toBe('Expiring Soon')
    expect(cnicAlert(91)).toBe('Valid')
    expect(cnicAlert(null)).toBeNull()
  })
  it('columns and rows from the employee record; current staff only', async () => {
    const t = await table('hrA', '/reports/lifecycle_dues')
    expect(t.sheetTitle).toBe('EMPLOYEE LIFECYCLE & EXPIRY TRACKER (PROBATION, CONTRACTS, SEPARATIONS)')
    expect(t.header).toEqual(['Emp ID', 'Full Name', 'Department', 'DOJ', 'Employment Type', 'Confirmation / Expiry Date', 'Days Remaining', 'Review Status', 'CNIC Expiry Date', 'CNIC Days Remaining', 'CNIC Alert'])
    expect(rowOf(t, 'a1')).toMatchObject({ 'Employment Type': 'On Probation', 'Days Remaining': 10, 'Review Status': 'Review Pending', 'CNIC Days Remaining': 30, 'CNIC Alert': 'Expiring Soon' })
    expect(rowOf(t, 'a2')).toMatchObject({ 'Confirmation / Expiry Date': '2024-07-01', 'Review Status': 'Confirmed', 'CNIC Alert': 'Expired' })
    expect(rowOf(t, 'a3')).toMatchObject({ 'Days Remaining': -1, 'Review Status': 'Confirmation Due', 'CNIC Alert': null })
    expect(rowOf(t, 'a4')).toMatchObject({ 'Days Remaining': 60, 'Review Status': 'Under Probation', 'CNIC Alert': 'Valid' })
    expect(rowOf(t, 'a5')).toMatchObject({ 'Employment Type': 'Contract', 'Days Remaining': 45, 'Review Status': 'Confirmed' })
    expect(t.rows.some((r) => r[0] === `${P}-a6` || r[0] === `${P}-b1`)).toBe(false)
  })
})

describe('Attendance & Leaves', () => {
  it('Danish\'s columns + the out-of-area count at the end; his arithmetic', async () => {
    const t = await table('hrA', `/reports/attendance_leaves?month=${M}`)
    expect(t.sheetTitle).toBe('MONTHLY TIME, ATTENDANCE, OVERTIME & LEAVE REPORT (SEPTEMBER 2026)')
    expect(t.header).toEqual(['Emp ID', 'Full Name', 'Department', 'Total Days in Month', 'Days Worked', 'Unpaid Leaves', 'Absents', 'Late Arrivals', 'OT Hours', 'Casual Balance', 'Annual Balance', 'Sick Balance', 'Absenteeism %', OUT_OF_AREA_COL])
    const a1 = rowOf(t, 'a1')
    // 30 days: absent 1 + half day 0.5 = 1.5 absents, 1 unpaid → 27.5 worked.
    expect(a1).toMatchObject({
      'Total Days in Month': 30, 'Days Worked': 27.5, 'Unpaid Leaves': 1, Absents: 1.5, 'Late Arrivals': 1, 'OT Hours': 3,
      'Casual Balance': 8, 'Annual Balance': 14, 'Sick Balance': 8, 'Absenteeism %': '5.0%', [OUT_OF_AREA_COL]: 2,
    })
    expect((a1['Total Days in Month'] as number) - ((a1['Days Worked'] as number) + (a1['Unpaid Leaves'] as number))).toBe(a1['Absents'])
    expect(rowOf(t, 'a2')).toMatchObject({ 'Days Worked': 30, Absents: 0, 'Absenteeism %': '0.0%', [OUT_OF_AREA_COL]: 1 })
    // A leaver from June is not on September.
    expect(t.rows.some((r) => r[0] === `${P}-a6`)).toBe(false)
  })
  it('a company with no such leave type leaves the balance blank; B sees only B', async () => {
    const t = await table('hrB', `/reports/attendance_leaves?month=${M}`)
    expect(t.rows.map((r) => r[0])).toEqual([`${P}-b1`])
    expect(rowOf(t, 'b1')).toMatchObject({ 'Casual Balance': null, 'Annual Balance': null, 'Sick Balance': null, [OUT_OF_AREA_COL]: 0 })
    expect((await get('hrA', '/reports/attendance_leaves?month=2026-13')).statusCode).toBe(400)
  })
})

describe('Payroll Report', () => {
  it('Danish\'s columns, read from the run\'s payslips, with a totals row', async () => {
    const t = await table('hrA', `/reports/payroll_report?month=${M}`)
    expect(t.sheetTitle).toBe(`${nameA.toUpperCase()} - MONTHLY PAYROLL SHEET (SEPTEMBER 2026)`)
    expect(t.header).toEqual(['Emp ID', 'Full Name', 'Department', 'Location', 'Cost Center', 'DOJ', 'Gross Salary', 'Days Worked', 'Salary Earned', 'Arrears / Discrepancy', 'OT Amount', 'Total Earned', 'Late Deduction', 'Loan Deduction', 'Unpaid Leave Ded.', 'Advance Salary', 'Income Tax', 'Total Deductions', 'Net Salary Payable', OTHER_DEDUCTIONS_COL])
    expect(rowOf(t, 'a1')).toMatchObject({
      Department: 'Kitchen', Location: 'Branch X', 'Cost Center': 'CC Kitchen', DOJ: '2024-01-01',
      'Gross Salary': 100000, 'Days Worked': 27.5, 'Salary Earned': 90000, 'Arrears / Discrepancy': 1000, 'OT Amount': 5000, 'Total Earned': 96000,
      'Late Deduction': 2000, 'Loan Deduction': 3500, 'Unpaid Leave Ded.': 3000, 'Advance Salary': 2500, 'Income Tax': 1500,
      'Total Deductions': 17370, 'Net Salary Payable': 78630, [OTHER_DEDUCTIONS_COL]: 4870,
    })
    expect(rowOf(t, 'a2')).toMatchObject({ 'Cost Center': 'General', 'Salary Earned': 100000, 'Net Salary Payable': 100000, [OTHER_DEDUCTIONS_COL]: 0 })
    expect(t.totalsRow).toBe(true)
    const total = t.rows[t.rows.length - 1]!
    expect(total[2]).toBe('Total September 2026 Payroll')
    expect(total[t.header.indexOf('Net Salary Payable')]).toBe(178630)
    expect(total[t.header.indexOf('Gross Salary')]).toBe(200000)
    // Every row: Total Earned − Total Deductions = Net (the payslip's own figures).
    for (const r of t.rows) expect(r[11] as number - (r[17] as number)).toBeCloseTo(r[18] as number, 2)
    expect(t.rows.some((r) => r[0] === `${P}-b1`)).toBe(false)
  })
  it('no run for the month: an empty table with a note, not an error', async () => {
    const t = await table('hrA', '/reports/payroll_report?month=2026-08')
    expect(t.rows).toEqual([])
    expect(t.note).toBe('No payroll run for 2026-08 yet')
  })
  it('B sees only its own run', async () => {
    const t = await table('hrB', `/reports/payroll_report?month=${M}`)
    expect(t.rows.slice(0, -1).map((r) => r[0])).toEqual([`${P}-b1`])
    expect(t.note).toMatch(/not locked/)
  })
})

describe('Excel download', () => {
  it('each format is a valid .xlsx with Danish\'s title on row 1 and the header on row 4', async () => {
    for (const [key, title] of [
      ['employee_master', 'EMPLOYEE MASTER DATABASE (ERP PRIMARY TABLE)'],
      ['lifecycle_dues', 'EMPLOYEE LIFECYCLE &amp; EXPIRY TRACKER'],
      ['attendance_leaves', 'MONTHLY TIME, ATTENDANCE, OVERTIME &amp; LEAVE REPORT (SEPTEMBER 2026)'],
      ['payroll_report', 'MONTHLY PAYROLL SHEET (SEPTEMBER 2026)'],
    ] as const) {
      const r = await get('hrA', `/reports/${key}.xlsx?month=${M}`)
      expect(r.statusCode, r.body).toBe(200)
      expect(r.headers['content-type']).toMatch(/spreadsheetml/)
      expect(String(r.headers['content-disposition'])).toMatch(/\.xlsx"$/)
      const buf = r.rawPayload
      expect(buf.subarray(0, 2).toString()).toBe('PK')
      expect(buf.readUInt32LE(buf.length - 22)).toBe(0x06054b50) // end of central directory
      const text = buf.toString('utf8')
      expect(text).toContain('xl/worksheets/sheet1.xml')
      expect(text).toMatch(new RegExp(`<c r="A1" s="2" t="inlineStr"><is><t xml:space="preserve">[^<]*${title.replace(/[()]/g, '\\$&')}`))
      expect(text).toContain('<row r="4"><c r="A4" s="6" t="inlineStr"><is><t xml:space="preserve">Emp ID</t>')
      if (key !== 'lifecycle_dues') expect(text).toMatch(/<row r="5">/)
    }
  })
})
