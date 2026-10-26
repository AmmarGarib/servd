// B5a (HR weekly expiry digest + 2-day request reminders) and B7a (food safety
// overdue bell + inspector printout), owner 2026-10-26.
//   - company B's HR is never told about A's people; B's managers never about A's units
//   - digest: HR gets the company list, an HOD only their department, once per week
//   - reminders: after 2 days to whoever must act next; again every 2 days; max 3
//   - overdue: once per occurrence; the inspector report is company scoped (foreign outlet 404)
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { flushNotifications } from '../src/lib/staffNotify.js'
import { runHrDigestForCompany, runHrRequestRemindersOnce } from '../src/modules/hr/expiryDigest.js'
import { runFoodSafetyOverdueForCompany } from '../src/modules/foodSafety/overdue.js'
import { foodSafetyRoutes } from '../src/modules/foodSafety/routes.js'

const P = `hfb${Date.now()}`
const T: Record<string, string> = {}
const U: Record<string, { id: string; token: string }> = {}
let app: FastifyInstance
const DAY = 86_400_000

async function mkUser(key: string, role: string, tenantId: string) {
  const u = await prisma.user.create({
    data: {
      name: key, email: `${P}.${key}@hfb.pk`, password: await bcrypt.hash('x-Password-1', 4), role: role as never, isActive: true,
      accountStatus: 'active', tenantId, tenantMemberships: { create: [{ tenant: { connect: { id: tenantId } }, role: 'member' }] },
    },
  })
  U[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}
const bell = (userId: string, kind: string) => prisma.staffNotification.findMany({ where: { userId, kind } })
const soon = (days: number) => new Date(Date.now() + days * DAY)

beforeAll(async () => {
  T.A = (await prisma.tenant.create({ data: { name: 'HFB A', slug: `${P}-a` } })).id
  T.B = (await prisma.tenant.create({ data: { name: 'HFB B', slug: `${P}-b` } })).id
  for (const [k, role, t] of [['hrA', 'hr', 'A'], ['hrB', 'hr', 'B'], ['hod', 'manager', 'A'], ['mgrA', 'manager', 'A'], ['mgrB', 'manager', 'B'], ['kit', 'kitchen', 'A']] as const) await mkUser(k, role, T[t]!)
  const dMkt = (await prisma.department.create({ data: { tenantId: T.A, name: `Mkt ${P}` } })).id
  const dOps = (await prisma.department.create({ data: { tenantId: T.A, name: `Ops ${P}` } })).id
  const dB = (await prisma.department.create({ data: { tenantId: T.B, name: `B ${P}` } })).id
  const head = await prisma.hrEmployee.create({ data: { tenantId: T.A, employeeCode: `${P}-1`, fullName: 'Head Mkt', userId: U.hod!.id, departmentId: dMkt, status: 'active' } })
  await prisma.hrEmployee.create({ data: { tenantId: T.A, employeeCode: `${P}-2`, fullName: 'Mkt Probationer', departmentId: dMkt, managerId: head.id, status: 'active', employmentType: 'probation', probationEnd: soon(10) } })
  await prisma.hrEmployee.create({ data: { tenantId: T.A, employeeCode: `${P}-3`, fullName: 'Ops Expired CNIC', departmentId: dOps, status: 'active', cnicExpiry: soon(-5) } })
  await prisma.hrEmployee.create({ data: { tenantId: T.B, employeeCode: `${P}-4`, fullName: 'B Person', departmentId: dB, status: 'active', cnicExpiry: soon(-5) } })

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR' } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(foodSafetyRoutes, { prefix: '/food-safety' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  const ids = [T.A!, T.B!]
  await prisma.staffNotification.deleteMany({ where: { tenantId: { in: ids } } })
  await prisma.hrRecord.deleteMany({ where: { tenantId: { in: ids } } })
  await prisma.hrEmployee.deleteMany({ where: { tenantId: { in: ids } } })
  await prisma.setting.deleteMany({ where: { key: { in: ids.map((t) => `hr.digest.lastWeek:${t}`) } } })
  await app?.close()
})

describe('HR weekly digest', () => {
  it('HR gets the company list, the HOD only their department, once a week; B is separate', async () => {
    await runHrDigestForCompany(T.A!); await runHrDigestForCompany(T.B!); await flushNotifications()
    const hr = await bell(U.hrA!.id, 'hr.digest')
    expect(hr).toHaveLength(1)
    expect(hr[0]!.body).toContain('Mkt Probationer'); expect(hr[0]!.body).toContain('Ops Expired CNIC')
    expect(hr[0]!.body).not.toContain('B Person')
    const hod = await bell(U.hod!.id, 'hr.digest')
    expect(hod).toHaveLength(1)
    expect(hod[0]!.body).toContain('Mkt Probationer'); expect(hod[0]!.body).not.toContain('Ops Expired')
    const hrB = await bell(U.hrB!.id, 'hr.digest')
    expect(hrB).toHaveLength(1); expect(hrB[0]!.body).toContain('B Person'); expect(hrB[0]!.body).not.toContain('Mkt Probationer')
    // Second run in the same week: nothing new.
    await runHrDigestForCompany(T.A!); await flushNotifications()
    expect(await bell(U.hrA!.id, 'hr.digest')).toHaveLength(1)
  })
})

describe('waiting-request reminders', () => {
  it('tells the next approver after 2 days, again every 2 days, max 3, only in the record company', async () => {
    const emp = await prisma.hrEmployee.findFirstOrThrow({ where: { tenantId: T.A, employeeCode: `${P}-2` } })
    const rec = await prisma.hrRecord.create({ data: { tenantId: T.A, section: 'leave', formVersion: 1, employeeId: emp.id, status: 'submitted', currentStep: 0, data: {} } })
    const age = (days: number) => prisma.$executeRaw`UPDATE hr_records SET "updatedAt" = ${new Date(Date.now() - days * DAY)} WHERE id = ${rec.id}`
    await age(1); await runHrRequestRemindersOnce(); await flushNotifications()
    const all = async () => (await prisma.staffNotification.findMany({ where: { entityType: 'hr_request', entityId: rec.id, kind: 'hr.reminder' } }))
    expect(await all()).toHaveLength(0)
    await age(2.5); await runHrRequestRemindersOnce(); await flushNotifications()
    const first = await all()
    expect(first.length).toBeGreaterThan(0)
    const recipients = new Set(first.map((n) => n.userId))
    expect(recipients.has(U.hrB!.id)).toBe(false); expect(recipients.has(U.mgrB!.id)).toBe(false)
    await runHrRequestRemindersOnce(); await flushNotifications()
    expect(await all()).toHaveLength(first.length) // same day: no repeat
    await age(4.5); await runHrRequestRemindersOnce(); await flushNotifications()
    expect((await all()).length).toBe(first.length * 2)
    await age(30); await runHrRequestRemindersOnce(); await flushNotifications()
    expect((await all()).length).toBe(first.length * 3)
    await age(60); await runHrRequestRemindersOnce(); await flushNotifications()
    expect((await all()).length).toBe(first.length * 3)
  })
})

describe('food safety overdue + inspector printout', () => {
  let unitA = '', locA = '', locB = ''
  it('one notice per overdue occurrence to A managers only', async () => {
    locA = (await prisma.location.create({ data: { tenantId: T.A, name: `LocA ${P}`, slug: `${P}-la` } as never })).id
    locB = (await prisma.location.create({ data: { tenantId: T.B, name: `LocB ${P}`, slug: `${P}-lb` } as never })).id
    const old = new Date(Date.now() - 3 * DAY)
    unitA = (await prisma.foodSafetyUnit.create({ data: { tenantId: T.A, name: 'A chiller', kind: 'fridge', minC: 0, maxC: 5, locationId: locA, createdAt: old } })).id
    await prisma.cleaningTask.create({ data: { tenantId: T.A, name: 'A hood', frequency: 'weekly', createdAt: new Date(Date.now() - 10 * DAY) } })
    await runFoodSafetyOverdueForCompany(T.A!); await runFoodSafetyOverdueForCompany(T.B!); await flushNotifications()
    expect(await bell(U.mgrA!.id, 'food_safety.overdue')).toHaveLength(2)
    expect(await bell(U.mgrB!.id, 'food_safety.overdue')).toHaveLength(0)
    expect(await bell(U.kit!.id, 'food_safety.overdue')).toHaveLength(0)
    await runFoodSafetyOverdueForCompany(T.A!); await flushNotifications()
    expect(await bell(U.mgrA!.id, 'food_safety.overdue')).toHaveLength(2)
  })
  it('inspector report is company scoped', async () => {
    await prisma.temperatureLog.create({ data: { tenantId: T.A, unitId: unitA, readingC: 4, withinRange: true } })
    const get = (who: string, qs = '') => app.inject({ method: 'GET', url: `/food-safety/inspector-report${qs}`, headers: { authorization: `Bearer ${U[who]!.token}` } })
    const a = await get('mgrA', '?format=csv')
    expect(a.statusCode, a.body).toBe(200)
    expect(a.body).toContain('A chiller')
    const b = await get('mgrB', '?format=csv')
    expect(b.statusCode).toBe(200)
    expect(b.body).not.toContain('A chiller')
    expect((await get('mgrA', `?locationId=${locA}&format=csv`)).statusCode).toBe(200)
    expect((await get('mgrA', `?locationId=${locB}&format=csv`)).statusCode).toBe(404)
    const pdf = await get('mgrA')
    expect(pdf.statusCode).toBe(200)
    expect(pdf.headers['content-type']).toContain('pdf')
  })
})
