// Attendance register (owner, 2026-10-21): the 16 columns, the computed values, and company separation.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { hrRoutes } from '../src/modules/hr/routes.js'
import { ATTENDANCE_REGISTER_COLUMNS, hmm } from '../src/modules/hr/attendanceRegister.js'

const HEADINGS = ['Attendance Date', 'Attendance Day', 'Shift Code', 'Employee ID', 'Employee Name', 'Department', 'Time In', 'Time Out',
  'Late In', 'Early Out', 'OT Hours', 'Source', 'Location', 'Branch', 'Status', 'Remarks']

let app: FastifyInstance
let tA: string, tB: string, locA: string, shiftA: string
const tok: Record<string, string> = {}
const emp: Record<string, string> = {}
const rec: Record<string, string> = {}
const stamp = Date.now()

async function mkHr(key: string, tenantId: string) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.attreg.${stamp}@gsfoods.pk`, password: await bcrypt.hash('x-Password-1', 4), role: 'hr' as never, isActive: true, accountStatus: 'active', tenantId },
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } as never }).catch(() => {})
  tok[key] = (issueStaffSession(u) as { accessToken: string }).accessToken
}
const call = (who: string, url: string) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${tok[who]}` } })
const registerRows = async (who: string, qs: string) => {
  const r = await call(who, `/hr/attendance/register?${qs}`)
  expect(r.statusCode).toBe(200)
  return r.json().rows as Array<{ id: string; values: string[] }>
}
const attendance = (tenantId: string, employeeId: string, date: string, category: string, data: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  prisma.hrRecord.create({ data: { tenantId, section: 'attendance', formVersion: 0, employeeId, startDate: new Date(`${date}T00:00:00.000Z`), category, status: 'approved', data: { date, status: category, ...data } as never, ...extra } })

beforeAll(async () => {
  tA = (await prisma.tenant.create({ data: { name: 'Reg Co A', slug: `reg-a-${stamp}` } })).id
  tB = (await prisma.tenant.create({ data: { name: 'Reg Co B', slug: `reg-b-${stamp}` } })).id
  locA = (await prisma.location.create({ data: { slug: `reg-loc-${stamp}`, name: 'Reg Branch A', tenantId: tA } })).id
  shiftA = (await prisma.hrRecord.create({ data: { tenantId: tA, section: 'shift', formVersion: 0, status: 'approved', data: { name: 'Morning', start: '09:00', end: '17:00' } as never } })).id
  await mkHr('hrA', tA)
  await mkHr('hrB', tB)
  const dept = await prisma.department.create({ data: { tenantId: tA, name: 'Kitchen' } })
  const mk = (tenantId: string, code: string, name: string, extra: Record<string, unknown> = {}) =>
    prisma.hrEmployee.create({ data: { tenantId, employeeCode: code, fullName: name, grossSalaryCents: 5_000_000, joiningDate: new Date('2025-01-01'), ...extra } })
  emp['a1'] = (await mk(tA, 'RA-001', 'Alia Late', { departmentId: dept.id })).id
  emp['a2'] = (await mk(tA, 'RA-002', 'Bilal Manual')).id
  emp['b1'] = (await mk(tB, 'RB-001', 'Other Company')).id

  rec['a1'] = (await attendance(tA, emp['a1']!, '2026-10-05', 'late', {
    checkIn: '09:40', checkOut: '16:30', lateMinutes: 40, location: locA, remarks: 'Traffic', _source: 'clock',
    _punches: [{ type: 'in', at: '2026-10-05T04:40:00.000Z', source: 'clock', locationId: locA }, { type: 'out', at: '2026-10-05T11:30:00.000Z', source: 'clock', locationId: locA }],
  }, { quantity: 40, refId: shiftA })).id
  const ot = (hours: number, status: string, data: Record<string, unknown> = {}) =>
    prisma.hrRecord.create({ data: { tenantId: tA, section: 'overtime', formVersion: 0, employeeId: emp['a1']!, startDate: new Date('2026-10-05T00:00:00.000Z'), quantity: hours, status, data: { otHours: hours, ...data } as never } })
  await ot(2, 'approved', { approvedHours: 1.5 })
  await ot(1, 'approved') // no approvedHours: its quantity
  await ot(4, 'submitted') // not approved: not counted
  rec['a2'] = (await attendance(tA, emp['a2']!, '2026-10-06', 'present', { checkIn: '09:00', checkOut: '17:00', _source: 'hr', _manual: true }, { status: 'submitted' })).id
  rec['b1'] = (await attendance(tB, emp['b1']!, '2026-10-05', 'present', { checkIn: '09:00', checkOut: '17:00', _source: 'clock' })).id

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(hrRoutes, { prefix: '/hr' })
  await app.ready()
})
afterAll(async () => { await app?.close() })

describe('attendance register', () => {
  it('has the owner\'s 16 headings in order, in the JSON and the CSV', async () => {
    expect([...ATTENDANCE_REGISTER_COLUMNS]).toEqual(HEADINGS)
    const j = await call('hrA', '/hr/attendance/register?from=2026-10-01&to=2026-10-31')
    expect(j.json().columns).toEqual(HEADINGS)
    const c = await call('hrA', '/hr/attendance/register?from=2026-10-01&to=2026-10-31&format=csv')
    expect(c.statusCode).toBe(200)
    expect(c.body.replace(/^﻿/, '').split(/\r?\n/)[0]).toBe(HEADINGS.join(','))
    const g = await call('hrA', '/hr/records/attendance/export.csv?from=2026-10-01&to=2026-10-31')
    expect(g.body.replace(/^﻿/, '').split(/\r?\n/)[0]).toBe(HEADINGS.join(','))
    expect(g.body).not.toContain('Other Company')
  })

  it('computes late in, early out, source, location and the weekday', async () => {
    const rows = await registerRows('hrA', 'from=2026-10-01&to=2026-10-31')
    expect(rows.map((r) => r.values[3])).toEqual(['RA-001', 'RA-002']) // by date, then code
    const v = Object.fromEntries(HEADINGS.map((h, i) => [h, rows[0]!.values[i]]))
    expect(v).toMatchObject({
      'Attendance Date': '2026-10-05', 'Attendance Day': 'Monday', 'Shift Code': 'Morning', 'Employee Name': 'Alia Late',
      'Time In': '09:40', 'Time Out': '16:30', 'Late In': '0:40', 'Early Out': '0:30', 'OT Hours': '2.50', Department: 'Kitchen', Source: 'Time clock',
      Location: 'Reg Branch A', Branch: 'Reg Branch A', Status: 'Late', Remarks: 'Traffic',
    })
    expect(hmm(0)).toBe('')
    expect(hmm(75)).toBe('1:15')
  })

  it('shows a manual day waiting for the CEO, with no punch location', async () => {
    const rows = await registerRows('hrA', 'from=2026-10-06&to=2026-10-06')
    expect(rows).toHaveLength(1)
    const v = rows[0]!.values
    expect(v[11]).toBe('Manual (HR) — waiting for CEO')
    expect(v[1]).toBe('Tuesday')
    expect(v[12]).toBe('')
    expect(v[10]).toBe('') // OT
    expect(v[9]).toBe('') // no early out: 17:00 out against a 17:00 end or no shift
  })

  it('filters by employee and status', async () => {
    expect(await registerRows('hrA', `employeeId=${emp['a2']}`)).toHaveLength(1)
    expect(await registerRows('hrA', 'status=late')).toHaveLength(1)
    expect(await registerRows('hrA', 'status=absent')).toHaveLength(0)
  })

  it('keeps companies apart', async () => {
    const b = await registerRows('hrB', 'from=2026-10-01&to=2026-10-31')
    expect(b.map((r) => r.id)).toEqual([rec['b1']])
    expect(await registerRows('hrB', `employeeId=${emp['a1']}`)).toEqual([])
    const a = await registerRows('hrA', 'from=2026-10-01&to=2026-10-31')
    expect(a.map((r) => r.id)).not.toContain(rec['b1'])
    const csvB = await call('hrB', '/hr/records/attendance/export.csv')
    expect(csvB.body).not.toContain('Alia Late')
  })
})
