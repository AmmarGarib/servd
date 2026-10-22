// Bulk approval of HR requests (owner, 2026-10-22: "It should go for approval
// in bulk, not individually"). POST /hr/records/decide-many decides each
// record through the single route's own rules:
//   - HR keys several attendance days by hand (they wait for the CEO); the
//     CEO approves them all in one call
//   - another company's CEO gets nothing decided (each item 404, nothing moves)
//   - a loan is never decided in bulk
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { hrRoutes } from '../src/modules/hr/routes.js'

const P = `hbd${Date.now()}`
let app: FastifyInstance
const T: Record<string, string> = {}
const users: Record<string, string> = {}
let empId = ''
async function mkUser(key: string, role: string, tenantId: string) {
  const u = await prisma.user.create({
    data: {
      name: key, email: `${P}.${key}@hbd.pk`, password: await bcrypt.hash('x-Password-1', 4), role: role as never, isActive: true,
      accountStatus: 'active', tenantId, tenantMemberships: { create: [{ tenant: { connect: { id: tenantId } }, role: 'member' }] },
    },
  })
  users[key] = (issueStaffSession(u) as { accessToken: string }).accessToken
}
const call = (who: string, url: string, payload: unknown) =>
  app.inject({ method: 'POST', url: `/hr${url}`, payload: payload as never, headers: { authorization: `Bearer ${users[who]}` } })

beforeAll(async () => {
  T.A = (await prisma.tenant.create({ data: { name: 'HBD A', slug: `${P}-a` } })).id
  T.B = (await prisma.tenant.create({ data: { name: 'HBD B', slug: `${P}-b` } })).id
  await mkUser('ceoA', 'admin', T.A)
  await mkUser('ceoB', 'admin', T.B)
  await mkUser('hrA', 'hr', T.A)
  empId = (await prisma.hrEmployee.create({ data: { tenantId: T.A, employeeCode: `${P}-1`, fullName: 'Line Cook', status: 'active' } })).id
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

describe('bulk decide', () => {
  const ids: string[] = []
  it('HR keys three days by hand; another company\'s CEO decides none; the CEO approves all three in one call', async () => {
    for (const d of ['2026-10-13', '2026-10-14', '2026-10-15']) {
      const r = await call('hrA', '/records/attendance', { data: { employee: empId, date: d, status: 'present', checkIn: '11:00', checkOut: '19:00', remarks: 'Not checked in' } })
      expect(r.statusCode, r.body).toBe(201)
      expect(r.json().status).toBe('submitted')
      ids.push(r.json().id)
    }
    const items = ids.map((id) => ({ section: 'attendance', id }))
    const foreign = await call('ceoB', '/records/decide-many', { decision: 'approved', items })
    expect(foreign.statusCode, foreign.body).toBe(200)
    expect(foreign.json()).toMatchObject({ decided: 0, failed: 3 })
    expect(await prisma.hrRecord.count({ where: { id: { in: ids }, status: 'submitted' } })).toBe(3)

    const r = await call('ceoA', '/records/decide-many', { decision: 'approved', items })
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json()).toMatchObject({ decided: 3, failed: 0 })
    expect(await prisma.hrRecord.count({ where: { id: { in: ids }, status: 'approved' } })).toBe(3)
    // Twice: nothing left to decide, said per item.
    const again = (await call('ceoA', '/records/decide-many', { decision: 'approved', items })).json()
    expect(again).toMatchObject({ decided: 0, failed: 3 })
    expect(again.results[0].code).toBe('NOT_PENDING')
  })

  it('a loan is never decided in bulk', async () => {
    const r = (await call('ceoA', '/records/decide-many', { decision: 'approved', items: [{ section: 'loan', id: ids[0] }] })).json()
    expect(r.results[0]).toMatchObject({ ok: false, code: 'LOAN_NOT_IN_BULK' })
  })
})
