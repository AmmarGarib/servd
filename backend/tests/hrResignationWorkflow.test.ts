// Resignations: line manager → HR → the CEO's final approval (owner, 2026-11-07: "A resignation raised by an
// employee will go to Line manager for approval, after that it should go to HR, after HR submits it should go to
// CEO for final approval, should not go directly from line manager to CEO").
//
// Real route handlers through Fastify inject; needs the disposable test DB.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { hrRoutes } from '../src/modules/hr/routes.js'

const P = `resw${Date.now()}`
let app: FastifyInstance
const T: Record<string, string> = {}
const D: Record<string, string> = {}
const E: Record<string, string> = {}
const users: Record<string, { id: string; token: string }> = {}

async function mkUser(key: string, role: string, tenantId: string) {
  const u = await prisma.user.create({
    data: {
      name: key, email: `${P}.${key}@resw.pk`, password: await bcrypt.hash('x-Password-1', 4), role: role as never, isActive: true,
      accountStatus: 'active', tenantId, tenantMemberships: { create: [{ tenant: { connect: { id: tenantId } }, role: 'member' }] },
    },
  })
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}
const call = (who: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url: `/hr${url}`, payload: payload as never, headers: { authorization: `Bearer ${users[who]!.token}` } })

beforeAll(async () => {
  T.A = (await prisma.tenant.create({ data: { name: 'RES A', slug: `${P}-a` } })).id
  T.B = (await prisma.tenant.create({ data: { name: 'RES B', slug: `${P}-b` } })).id
  D.mkt = (await prisma.department.create({ data: { tenantId: T.A, name: `Marketing ${P}` } })).id
  D.ops = (await prisma.department.create({ data: { tenantId: T.A, name: `Operations ${P}` } })).id
  await mkUser('hod', 'manager', T.A)
  await mkUser('staff', 'kitchen', T.A)
  await mkUser('hrA', 'hr', T.A)
  await mkUser('hrB', 'hr', T.B)
  await mkUser('ceo', 'admin', T.A)
  const hod = await prisma.hrEmployee.create({ data: { tenantId: T.A, employeeCode: `${P}-1`, fullName: 'Head of Marketing', userId: users.hod!.id, departmentId: D.mkt, status: 'active' } })
  E.staff = (await prisma.hrEmployee.create({ data: { tenantId: T.A, employeeCode: `${P}-2`, fullName: 'Marketing Exec', userId: users.staff!.id, departmentId: D.mkt, managerId: hod.id, status: 'active', joiningDate: new Date(Date.UTC(2026, 0, 1)) } })).id

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

describe('a resignation an employee raises', () => {
  let recId = ''
  const decide = (who: string, payload: unknown = { decision: 'approved' }) => call(who, 'POST', `/records/resignation/${recId}/decide`, payload)

  it('waits on the line manager first', async () => {
    const r = await call('staff', 'POST', '/me/records/resignation', { data: { resignationDate: '2026-11-07', lastWorkingDay: '2026-12-07', reason: 'Moving cities' } })
    expect(r.statusCode, r.body).toBe(201)
    recId = r.json().id
    expect(r.json()).toMatchObject({ status: 'submitted', currentStep: 0, tenantId: T.A })
    // Neither HR nor the CEO signs the manager's step as a normal approver ahead of the manager.
    expect((await decide('hrB')).statusCode).toBe(404)
  })

  it('line manager → HR (not the CEO yet) → CEO final', async () => {
    const m = await decide('hod')
    expect(m.statusCode, m.body).toBe(200)
    expect(m.json()).toMatchObject({ status: 'submitted', currentStep: 1 })
    // The CEO step is not reached until HR signs.
    const h = await decide('hrA')
    expect(h.statusCode, h.body).toBe(200)
    expect(h.json()).toMatchObject({ status: 'submitted', currentStep: 2 })
    expect((await prisma.hrEmployee.findUnique({ where: { id: E.staff! } }))!.status).toBe('active')
    // HR cannot give the final approval.
    const again = await decide('hrA')
    expect(again.statusCode).toBe(403)
    const c = await decide('ceo')
    expect(c.statusCode, c.body).toBe(200)
    expect(c.json()).toMatchObject({ status: 'approved' })
    expect(c.json().approvals.map((a: { role: string }) => a.role)).toEqual(['hod', 'hr', 'ceo'])
  })
})
