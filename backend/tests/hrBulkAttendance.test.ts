// Attendance in bulk (owner, 2026-10-22): "Build the mark-present-for-a-date-
// range option" and "HR could enter an employee's manual data in one go,
// instead of one by one for each day".
//   - bulk-days: one employee, many days, each its own status / times — every
//     day a hand-keyed record waiting for the CEO; a day already recorded is
//     refused per day, the rest go in
//   - preview: every day of the range with the rota's hours (default rota
//     11:00–19:00, Monday off) and what is already recorded
//   - mark-present: working days only (Monday off skipped), already-recorded
//     days skipped; dryRun creates nothing
//   - another company's HR: 404 on the employee, nothing created
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { hrRoutes } from '../src/modules/hr/routes.js'

const P = `hba${Date.now()}`
let app: FastifyInstance
const T: Record<string, string> = {}
const users: Record<string, string> = {}
const E: Record<string, string> = {}
async function mkUser(key: string, role: string, tenantId: string) {
  const u = await prisma.user.create({
    data: {
      name: key, email: `${P}.${key}@hba.pk`, password: await bcrypt.hash('x-Password-1', 4), role: role as never, isActive: true,
      accountStatus: 'active', tenantId, tenantMemberships: { create: [{ tenant: { connect: { id: tenantId } }, role: 'member' }] },
    },
  })
  users[key] = (issueStaffSession(u) as { accessToken: string }).accessToken
}
const call = (who: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url: `/hr${url}`, payload: payload as never, headers: { authorization: `Bearer ${users[who]}` } })
const manualDays = (employeeId: string) => prisma.hrRecord.findMany({ where: { section: 'attendance', employeeId }, orderBy: { startDate: 'asc' } })

beforeAll(async () => {
  T.A = (await prisma.tenant.create({ data: { name: 'HBA A', slug: `${P}-a` } })).id
  T.B = (await prisma.tenant.create({ data: { name: 'HBA B', slug: `${P}-b` } })).id
  await mkUser('hrA', 'hr', T.A)
  await mkUser('hrB', 'hr', T.B)
  for (const [k, n] of [['cook', 1], ['server', 2]] as const) {
    E[k] = (await prisma.hrEmployee.create({ data: { tenantId: T.A, employeeCode: `${P}-${n}`, fullName: k, status: 'active', joiningDate: new Date('2026-01-01') } })).id
  }
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(hrRoutes, { prefix: '/hr' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  await prisma.hrRecord.deleteMany({ where: { tenantId: { in: [T.A!, T.B!] } } })
  await prisma.hrEmployee.deleteMany({ where: { tenantId: { in: [T.A!, T.B!] } } })
  await app?.close()
})

describe('one employee, many days', () => {
  it('previews the range from the default rota', async () => {
    const r = await call('hrA', 'GET', `/attendance/bulk-days/preview?employeeId=${E.cook}&from=2026-10-12&to=2026-10-18`)
    expect(r.statusCode, r.body).toBe(200)
    const days = r.json().days as Array<{ date: string; kind: string; start: string | null; end: string | null }>
    expect(days).toHaveLength(7)
    expect(days[0]).toMatchObject({ date: '2026-10-12', kind: 'off' }) // Monday
    expect(days[1]).toMatchObject({ date: '2026-10-13', kind: 'working', start: '11:00', end: '19:00' })
  })

  it('enters several days in one go, each its own status; a day already recorded is refused, the rest go in', async () => {
    const r = await call('hrA', 'POST', '/attendance/bulk-days', {
      employeeId: E.cook, remarks: 'Not checked in - servd release',
      days: [
        { date: '2026-10-13', status: 'present', checkIn: '11:00', checkOut: '19:00' },
        { date: '2026-10-14', status: 'late', checkIn: '11:40', checkOut: '19:00' },
        { date: '2026-10-15', status: 'absent' },
      ],
    })
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json()).toMatchObject({ created: 3, failed: [] })
    const rows = await manualDays(E.cook!)
    expect(rows.map((x) => [x.category, x.status, x.tenantId])).toEqual([
      ['present', 'submitted', T.A], ['late', 'submitted', T.A], ['absent', 'submitted', T.A],
    ])
    expect((rows[1]!.data as Record<string, unknown>)).toMatchObject({ checkIn: '11:40', _manual: true })

    const again = (await call('hrA', 'POST', '/attendance/bulk-days', {
      employeeId: E.cook, remarks: 'Not checked in - servd release',
      days: [{ date: '2026-10-15', status: 'present' }, { date: '2026-10-16', status: 'present', checkIn: '11:00', checkOut: '19:00' }],
    })).json()
    expect(again.created).toBe(1)
    expect(again.failed).toEqual([{ date: '2026-10-15', message: expect.stringMatching(/Already recorded/) }])
  })

  it('a day still to come is refused', async () => {
    const r = await call('hrA', 'POST', '/attendance/bulk-days', { employeeId: E.cook, remarks: 'Not checked in', days: [{ date: '2099-01-01', status: 'present' }] })
    expect(r.statusCode).toBe(400)
  })

  it("another company's HR gets 404 and creates nothing", async () => {
    const before = (await manualDays(E.server!)).length
    expect((await call('hrB', 'POST', '/attendance/bulk-days', { employeeId: E.server, remarks: 'Not checked in', days: [{ date: '2026-10-13', status: 'present' }] })).statusCode).toBe(404)
    expect((await call('hrB', 'GET', `/attendance/bulk-days/preview?employeeId=${E.server}&from=2026-10-12&to=2026-10-18`)).statusCode).toBe(404)
    expect((await call('hrB', 'POST', '/attendance/mark-present', { employeeIds: [E.server], from: '2026-10-12', to: '2026-10-18', remarks: 'Not checked in' })).statusCode).toBe(404)
    expect((await manualDays(E.server!)).length).toBe(before)
  })
})

describe('mark present for a date range', () => {
  it('dry run plans working days only and skips days already recorded; the real run creates them', async () => {
    const body = { employeeIds: [E.cook, E.server], from: '2026-10-12', to: '2026-10-18', remarks: 'Not checked in - servd release' }
    const dry = await call('hrA', 'POST', '/attendance/mark-present', { ...body, dryRun: true })
    expect(dry.statusCode, dry.body).toBe(200)
    const people = dry.json().people as Array<{ employeeId: string; days: number; alreadyRecorded: number }>
    // Tue–Sun = 6 working days; the cook already has 13, 14, 15, 16.
    expect(people.find((p) => p.employeeId === E.server)).toMatchObject({ days: 6, alreadyRecorded: 0 })
    expect(people.find((p) => p.employeeId === E.cook)).toMatchObject({ days: 2, alreadyRecorded: 4 })
    expect(dry.json().toMark).toBe(8)
    expect((await manualDays(E.server!)).length).toBe(0)

    const r = await call('hrA', 'POST', '/attendance/mark-present', body)
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json()).toMatchObject({ created: 8, failed: [] })
    const server = await manualDays(E.server!)
    expect(server).toHaveLength(6)
    expect(server.every((x) => x.status === 'submitted' && x.category === 'present')).toBe(true)
    expect(server.map((x) => x.startDate!.toISOString().slice(0, 10))).not.toContain('2026-10-12')
    expect((server[0]!.data as Record<string, unknown>)).toMatchObject({ checkIn: '11:00', checkOut: '19:00', _manual: true })
  })
})
