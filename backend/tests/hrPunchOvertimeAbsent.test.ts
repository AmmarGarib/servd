// Absent without a punch, and punch overtime (owner, 2026-10-22).
//
//   Rule A: from the HR setting absentWithoutPunchFrom (default 2026-11-01), a
//     rota working day with no standing attendance record is absent and docked;
//     weekly offs, holidays, approved leave, days with no rota and today / later
//     never are; any standing record (an HR correction) wins. October pays as is.
//   Rule B: overtime = time worked after the rota shift's end (or beyond the
//     standard day, 9 h, with no shift); under 30 minutes ignored.
//   Rule C: punch OT is only AVAILABLE — paid once HR adds it to that
//     employee's draft payslip (or full & final); an approved request on the
//     same day wins; paid once; another company's item is refused.
//   The Attendance & Leaves report and the attendance register agree.
//   Two companies; settings per company.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import type { UserRole } from '@prisma/client'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { hrRoutes } from '../src/modules/hr/routes.js'
import { punchOvertimeMinutes } from '../src/modules/hr/attendanceDays.js'
import { DEFAULT_HR_SETTINGS, mergeSettings } from '../src/modules/hr/logic.js'
import { saveSettings } from '../src/modules/hr/service.js'
import { rotaFor } from '../src/modules/hr/rota.js'

const RS = (r: number) => r * 100
const stamp = Date.now()
const D = (s: string) => new Date(`${s}T00:00:00.000Z`)
/** A Karachi wall-clock time on a day, as the instant a punch stores. */
const PKT = (day: string, hhmm: string) => new Date(Date.parse(`${day}T${hhmm}:00.000Z`) - 5 * 3_600_000).toISOString()
const nov = (n: number) => `2026-11-${String(n).padStart(2, '0')}`

let app: FastifyInstance
let tenantA: string, tenantB: string
const users: Record<string, { id: string; token: string }> = {}
const emps: Record<string, string> = {}
const att: Record<string, string> = {} // day → A1's attendance record id
let approvedOt12: string, punchB: string

async function mkUser(key: string, role: string, tenantId: string) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${stamp}@punchot.pk`, password: await bcrypt.hash('x-Password-1', 4), role: role as UserRole, isActive: true, accountStatus: 'active', tenantId },
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } })
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}
async function mkEmp(key: string, tenantId: string, grossRs: number) {
  const e = await prisma.hrEmployee.create({
    data: { tenantId, employeeCode: `PO-${stamp % 100000}-${Object.keys(emps).length + 1}`, fullName: key, grossSalaryCents: RS(grossRs), monthlyTaxCents: 0, joiningDate: D('2025-01-01'), paymentMethod: 'bank' },
  })
  emps[key] = e.id
  return e.id
}
const rec = (tenantId: string, section: string, employeeId: string | null, data: Record<string, unknown>) =>
  prisma.hrRecord.create({ data: { tenantId, section, formVersion: 0, employeeId, status: 'approved', ...data } as never })
/** A punched day: in and out at Karachi times. `kiosk` = a day punched at the old shared kiosk (PIN clock-in removed
 *  2026-10-27) — such days must keep counting exactly like a login's. */
const punched = (tenantId: string, employeeId: string, day: string, inT: string, outT: string, source: 'clock' | 'kiosk' = 'clock') =>
  rec(tenantId, 'attendance', employeeId, {
    startDate: D(day), category: 'present',
    data: { status: 'present', checkIn: inT, checkOut: outT, _source: source, _punches: [{ type: 'in', at: PKT(day, inT), source }, { type: 'out', at: PKT(day, outT), source }] },
  })

const call = (who: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
  app.inject({ method, url: `/hr${url}`, payload: payload as never, headers: { authorization: `Bearer ${users[who]!.token}` } })

type Slip = { id: string; employeeId: string; lines: Array<{ code: string; amountCents: number }>; inputs: Record<string, any> }
async function newRun(who: string, period: string): Promise<string> {
  const r = await call(who, 'POST', '/payroll/runs', { period })
  expect(r.statusCode, r.body).toBe(201)
  return r.json().id
}
async function slipOf(who: string, runId: string, employeeId: string): Promise<Slip> {
  const r = await call(who, 'GET', `/payroll/runs/${runId}`)
  expect(r.statusCode, r.body).toBe(200)
  return (r.json().payslips as Slip[]).find((s) => s.employeeId === employeeId)!
}
const line = (s: Slip, code: string) => s.lines.find((l) => l.code === code)?.amountCents ?? 0

beforeAll(async () => {
  // "Today" is 5 Dec 2026 (Karachi): November is over.
  vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-12-05T07:00:00.000Z'), shouldAdvanceTime: true })
  tenantA = (await prisma.tenant.create({ data: { name: `PO A ${stamp}`, slug: `po-a-${stamp}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: `PO B ${stamp}`, slug: `po-b-${stamp}` } })).id
  // These cases test people with and without their own roster, so the company default rota (on by default) starts off; the 'default rota' test switches it on.
  for (const t of [tenantA, tenantB]) await saveSettings(t, mergeSettings({ defaultRota: null }))
  for (const t of [tenantA, tenantB]) await ensureChartOfAccounts(t)
  await mkUser('hrA', 'hr', tenantA)
  await mkUser('hrB', 'hr', tenantB)

  // A1: Rs 240,000 → November Rs 8,000 a day, Rs 1,000 an hour (8 h), OT at 2× = Rs 2,000 an hour.
  const a1 = await mkEmp('a1', tenantA, 240000)
  await mkEmp('a-norota', tenantA, 90000)
  const b1 = await mkEmp('b1', tenantB, 240000)
  const dayA = (await rec(tenantA, 'shift', null, { data: { name: 'Day', start: '09:00', end: '17:00' } })).id
  const dayB = (await rec(tenantB, 'shift', null, { data: { name: 'Day', start: '09:00', end: '17:00' } })).id
  await rec(tenantA, 'roster', a1, { refId: dayA, startDate: D('2026-09-01'), data: { employee: a1, shift: dayA, weeklyOff: ['sunday'] } })
  await rec(tenantB, 'roster', b1, { refId: dayB, startDate: D('2026-09-01'), data: { employee: b1, shift: dayB, weeklyOff: ['sunday'] } })
  await rec(tenantA, 'holiday', null, { startDate: D(nov(20)), data: { name: 'Company day', type: 'company' } })
  const casual = (await rec(tenantA, 'leave_type', null, { quantity: 10, category: 'paid', data: { name: 'Casual Leave' } })).id
  await rec(tenantA, 'leave', a1, { refId: casual, startDate: D(nov(4)), endDate: D(nov(4)), quantity: 1 })
  // HR's allotment: +2 casual days.
  await rec(tenantA, 'leave_adjustment', a1, { refId: casual, quantity: 2, effectiveDate: D('2026-11-01') })

  // November: a punched 09:00–17:00 day on every working day except the 3rd
  // (no punch → absent), the 4th (casual leave), the 20th (holiday); Sundays off.
  for (let n = 1; n <= 30; n++) {
    const day = nov(n)
    if (D(day).getUTCDay() === 0 || [3, 4, 5, 10, 11, 12, 20].includes(n)) continue
    // The 2nd was punched at the old kiosk: it is a worked day like any other (never absent).
    att[day] = (await punched(tenantA, a1, day, '09:00', '17:00', n === 2 ? 'kiosk' : 'clock')).id
  }
  // 5th: no punch, but HR corrected it (an approved hand-keyed day) — wins.
  att[nov(5)] = (await rec(tenantA, 'attendance', a1, { startDate: D(nov(5)), category: 'present', data: { status: 'present', checkIn: '09:00', checkOut: '17:00', _source: 'correction' } })).id
  // Overtime days: 10th to 19:00 (2 h after the shift), 11th to 17:20 (20 min — ignored),
  // 12th to 20:00 with an approved 1 h request (the request wins), Sunday 8th 08:00–19:00
  // on the weekly off (11 h, 2 h beyond the 9-hour standard day).
  // The 10th was punched at the old kiosk too: its punch OT is offered like a login's.
  att[nov(10)] = (await punched(tenantA, a1, nov(10), '09:00', '19:00', 'kiosk')).id
  att[nov(11)] = (await punched(tenantA, a1, nov(11), '09:00', '17:20')).id
  att[nov(12)] = (await punched(tenantA, a1, nov(12), '09:00', '20:00')).id
  att[nov(8)] = (await punched(tenantA, a1, nov(8), '08:00', '19:00')).id
  approvedOt12 = (await rec(tenantA, 'overtime', a1, { startDate: D(nov(12)), quantity: 1, amountCents: RS(2000), data: { approvedHours: 1, otAmount: RS(2000) } })).id

  // B1: no punches in November at all; one long day on the 10th.
  punchB = `punch:${(await punched(tenantB, b1, nov(10), '09:00', '19:00')).id}`

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(hrRoutes, { prefix: '/hr' })
  await app.ready()
})

afterAll(async () => {
  for (const t of [tenantA, tenantB]) {
    await prisma.hrPayrollRun.deleteMany({ where: { tenantId: t } })
    await prisma.hrRecord.deleteMany({ where: { tenantId: t } })
    await prisma.hrEmployee.deleteMany({ where: { tenantId: t } })
    await prisma.setting.deleteMany({ where: { key: `hr.settings.${t}` } })
    await prisma.auditLog.deleteMany({ where: { tenantId: t } }).catch(() => {})
    await prisma.tenantMember.deleteMany({ where: { tenantId: t } }).catch(() => {})
    await prisma.user.deleteMany({ where: { tenantId: t } })
    await prisma.account.updateMany({ where: { tenantId: t }, data: { controlledBy: null } })
    await prisma.tenant.deleteMany({ where: { id: t } })
  }
  await app.close()
  vi.useRealTimers()
})

describe('the overtime minutes rule', () => {
  const shift = { employeeId: 'e', date: '2026-11-10', kind: 'shift' as const, source: 'roster' as const, offExceptionId: null, segments: [{ start: '09:00', end: '17:00', shiftId: null, shiftName: null, breakMinutes: 0, exceptionId: null, conceptId: null, role: null, notes: null }] }
  const s = DEFAULT_HR_SETTINGS
  it('counts time after the shift end only, ignores under 30 minutes, and uses 9 h with no shift', () => {
    expect(punchOvertimeMinutes([{ start: 8 * 60, end: 19 * 60 }], shift, s)).toEqual({ minutes: 120, basis: 'after_shift' }) // early start not OT
    expect(punchOvertimeMinutes([{ start: 9 * 60, end: 17 * 60 + 29 }], shift, s).minutes).toBe(0)
    expect(punchOvertimeMinutes([{ start: 9 * 60, end: 17 * 60 + 30 }], shift, s).minutes).toBe(30)
    expect(punchOvertimeMinutes([{ start: 8 * 60, end: 19 * 60 }], null, s)).toEqual({ minutes: 120, basis: 'beyond_standard_day' })
    // A closing shift past midnight: 18:00–02:00, out at 03:00 → 1 h.
    const late = { ...shift, segments: [{ ...shift.segments[0]!, start: '18:00', end: '02:00' }] }
    expect(punchOvertimeMinutes([{ start: 18 * 60, end: 27 * 60 }], late, s).minutes).toBe(60)
  })
})

describe('rule A — absent without a punch', () => {
  it('October pays as is: no punches, nothing docked', async () => {
    const oct = await newRun('hrA', '2026-10')
    const s = await slipOf('hrA', oct, emps['a1']!)
    expect(s.inputs['absentDays']).toBe(0)
    expect(s.inputs['payBasis']).toMatchObject({ daysInMonth: 31, employedDays: 31, absentDays: 0, paidDays: 31 })
    await prisma.hrPayrollRun.update({ where: { id: oct }, data: { status: 'locked' } })
  })

  it('November docks the working day with no punch — not the weekly off, holiday, leave day or corrected day', async () => {
    const run = await newRun('hrA', '2026-11')
    const s = await slipOf('hrA', run, emps['a1']!)
    expect(s.inputs['absentDays']).toBe(1) // the 3rd only
    expect(s.inputs['payBasis']).toMatchObject({ daysInMonth: 30, employedDays: 30, absentDays: 1, paidDays: 29 })
    expect(line(s, 'salary')).toBe(Math.round(RS(240000) * 29 / 30))
    // Someone with no rota is never absent by rule A (their weekly off is unknown).
    expect((await slipOf('hrA', run, emps['a-norota']!)).inputs['absentDays']).toBe(0)
  })

  it('the company default rota (11:00–19:00, Monday off) puts someone with no roster on the rota', async () => {
    const cur = (await call('hrA', 'GET', '/settings')).json()
    expect(cur.defaultRota).toBeNull()
    const put = await call('hrA', 'PUT', '/settings', { ...cur, defaultRota: { start: '11:00', end: '19:00', breakMinutes: 0, weeklyOff: ['monday'] } })
    expect(put.statusCode, put.body).toBe(200)
    const emp = await prisma.hrEmployee.findUniqueOrThrow({ where: { id: emps['a-norota']! } })
    const cells = await rotaFor(tenantA, [emp], '2026-11-02', '2026-11-03') // Monday, Tuesday
    expect(cells.map((c) => [c.kind, c.source])).toEqual([['off', 'default'], ['shift', 'default']])
    expect(cells[1]!.segments[0]).toMatchObject({ start: '11:00', end: '19:00' })
    // Now the November run docks their working days with no punch (Mondays are off).
    const run = (await prisma.hrPayrollRun.findFirstOrThrow({ where: { tenantId: tenantA, period: '2026-11' } })).id
    const recalc = async () => expect((await call('hrA', 'POST', `/payroll/runs/${run}/recalculate`)).statusCode).toBe(200)
    await recalc()
    expect(Number((await slipOf('hrA', run, emps['a-norota']!)).inputs['absentDays'])).toBeGreaterThan(0)
    // Company B is untouched; switch A back off (and recalculate) for the cases below.
    expect((await call('hrB', 'GET', '/settings')).json().defaultRota).toBeNull()
    expect((await call('hrA', 'PUT', '/settings', { ...cur, defaultRota: null })).statusCode).toBe(200)
    await recalc()
    expect((await slipOf('hrA', run, emps['a-norota']!)).inputs['absentDays']).toBe(0)
  })

  it('only days already over count; a company that switched it off docks nothing', async () => {
    // December so far (today is the 5th): the 1st–4th are working days with no punch.
    const dec = await newRun('hrA', '2026-12')
    expect((await slipOf('hrA', dec, emps['a1']!)).inputs['absentDays']).toBe(4)
    await prisma.hrPayrollRun.delete({ where: { id: dec } })

    const cur = (await call('hrB', 'GET', '/settings')).json()
    const put = await call('hrB', 'PUT', '/settings', { ...cur, absentWithoutPunchFrom: null })
    expect(put.statusCode, put.body).toBe(200)
    expect(put.json().absentWithoutPunchFrom).toBeNull()
    expect(put.json().standardDayHours).toBe(9)
    const runB = await newRun('hrB', '2026-11')
    expect((await slipOf('hrB', runB, emps['b1']!)).inputs['absentDays']).toBe(0)
    // Company A's setting is untouched.
    expect((await call('hrA', 'GET', '/settings')).json().absentWithoutPunchFrom).toBe('2026-11-01')
  })
})

describe('rule B / C — punch overtime is offered, never paid on its own', () => {
  let run: string
  it('lists punch OT (after the shift, beyond the standard day) beside approved OT; pays none', async () => {
    run = (await prisma.hrPayrollRun.findFirstOrThrow({ where: { tenantId: tenantA, period: '2026-11' } })).id
    const s = await slipOf('hrA', run, emps['a1']!)
    expect(s.inputs['otCents']).toBe(0)
    expect(line(s, 'overtime')).toBe(0)
    expect(s.inputs['otAvailable']).toEqual([
      { recordId: `punch:${att[nov(8)]}`, date: nov(8), hours: 2, amountCents: RS(4000), source: 'punch', basis: 'beyond_standard_day' },
      { recordId: `punch:${att[nov(10)]}`, date: nov(10), hours: 2, amountCents: RS(4000), source: 'punch', basis: 'after_shift' },
      // The 12th: the approved request wins over the 3 h punched.
      { recordId: approvedOt12, date: nov(12), hours: 1, amountCents: RS(2000), source: 'approved' },
    ])
  })

  it('HR adds one employee\'s punch OT to that payslip only; another company\'s is refused', async () => {
    const s = await slipOf('hrA', run, emps['a1']!)
    const add = await call('hrA', 'POST', `/payroll/payslips/${s.id}/overtime`, { recordIds: [`punch:${att[nov(10)]}`] })
    expect(add.statusCode, add.body).toBe(200)
    expect(add.json().inputs.otRecordIds).toEqual([`punch:${att[nov(10)]}`])
    expect(add.json().inputs.otHours).toBe(2)
    expect(line(add.json(), 'overtime')).toBe(RS(4000))
    expect((await slipOf('hrA', run, emps['a-norota']!)).inputs['otCents']).toBe(0)
    // The 11th's 20 minutes are not an item; B's punch OT is not A's.
    for (const id of [`punch:${att[nov(11)]}`, punchB]) {
      const bad = await call('hrA', 'POST', `/payroll/payslips/${s.id}/overtime`, { recordIds: [id] })
      expect(bad.statusCode).toBe(422)
      expect(bad.json().error.code).toBe('OT_NOT_AVAILABLE')
    }
    expect((await call('hrB', 'POST', `/payroll/payslips/${s.id}/overtime`, { recordIds: [] })).statusCode).toBe(404)
    expect((await call('hrA', 'POST', `/payroll/payslips/${s.id}/overtime`, { recordIds: ['nonsense'] })).statusCode).toBe(400)
    // Recalculating keeps it.
    expect((await call('hrA', 'POST', `/payroll/runs/${run}/recalculate`)).statusCode).toBe(200)
    expect(line(await slipOf('hrA', run, emps['a1']!), 'overtime')).toBe(RS(4000))
  })

  it('paid once: the next run offers what was not added, and never a request for a day already paid by punches', async () => {
    await prisma.hrPayrollRun.update({ where: { id: run }, data: { status: 'locked' } })
    // A request approved later for the 10th — already paid from the punches.
    await rec(tenantA, 'overtime', emps['a1']!, { startDate: D(nov(10)), quantity: 2, amountCents: RS(4000), data: { approvedHours: 2 } })
    const dec = await newRun('hrA', '2026-12')
    const s = await slipOf('hrA', dec, emps['a1']!)
    expect((s.inputs['otAvailable'] as Array<{ recordId: string }>).map((a) => a.recordId)).toEqual([`punch:${att[nov(8)]}`, approvedOt12])
    const twice = await call('hrA', 'POST', `/payroll/payslips/${s.id}/overtime`, { recordIds: [`punch:${att[nov(10)]}`] })
    expect(twice.statusCode).toBe(422)
    // "Add all" takes the available items and nothing else.
    const all = await call('hrA', 'POST', `/payroll/runs/${dec}/overtime`, { all: true })
    expect(all.statusCode, all.body).toBe(200)
    expect(line(await slipOf('hrA', dec, emps['a1']!), 'overtime')).toBe(RS(4000) + RS(2000))
    await prisma.hrPayrollRun.delete({ where: { id: dec } })
  })

  it('a full & final offers punch OT the same way', async () => {
    const r = await call('hrA', 'POST', '/final-settlement/calculate', { employeeId: emps['a1'], lastWorkingDay: '2026-12-04', otRecordIds: [`punch:${att[nov(8)]}`] })
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json().otRecordIds).toEqual([`punch:${att[nov(8)]}`])
    expect(r.json().otPayable).toBe(RS(4000))
  })
})

describe('Attendance & Leaves report and the register', () => {
  it('whole month, days with attendance, docked absents, approved + punch OT, leave availed and balance', async () => {
    const r = await call('hrA', 'GET', '/reports/attendance_leaves?month=2026-11')
    expect(r.statusCode, r.body).toBe(200)
    const t = r.json() as { header: string[]; rows: unknown[][] }
    expect(t.header).toEqual(['Emp ID', 'Full Name', 'Department', 'Total Days in Month', 'Days Worked', 'Unpaid Leaves', 'Absents', 'Late Arrivals', 'OT Hours', 'Casual Availed', 'Casual Balance', 'Annual Availed', 'Annual Balance', 'Sick Availed', 'Sick Balance', 'Absenteeism %', 'Out-of-area punches'])
    const row = Object.fromEntries(t.header.map((h, i) => [h, t.rows.find((x) => x[1] === 'a1')![i]]))
    // 25 Mon–Sat days − 3rd, 4th, 20th + Sunday the 8th = 23 days with attendance.
    expect(row).toMatchObject({
      'Total Days in Month': 30, 'Days Worked': 23, 'Unpaid Leaves': 0, Absents: 1, 'OT Hours': 5,
      'Casual Availed': 1, 'Casual Balance': 11, 'Annual Availed': null, 'Annual Balance': null,
    })
    expect(t.rows.some((x) => x[1] === 'b1')).toBe(false)
    // Exports carry the new columns.
    const csvR = await call('hrA', 'GET', '/reports/attendance_leaves.csv?month=2026-11')
    expect(csvR.statusCode).toBe(200)
    expect(csvR.body).toContain('Casual Availed')
    for (const f of ['xlsx', 'pdf']) expect((await call('hrA', 'GET', `/reports/attendance_leaves.${f}?month=2026-11`)).statusCode).toBe(200)
  })

  it('the register\'s OT Hours: approved where requested, else the punch OT', async () => {
    const r = await call('hrA', 'GET', `/attendance/register?from=${nov(8)}&to=${nov(12)}&employeeId=${emps['a1']}`)
    expect(r.statusCode, r.body).toBe(200)
    const { columns, rows } = r.json() as { columns: string[]; rows: Array<{ values: string[] }> }
    const ot = Object.fromEntries(rows.map((x) => [x.values[0], x.values[columns.indexOf('OT Hours')]]))
    expect(ot).toMatchObject({ [nov(8)]: '2.00', [nov(9)]: '', [nov(10)]: '2.00', [nov(11)]: '', [nov(12)]: '1.00' })
  })
})
