// Manpower requisition by a head of department (owner, 2026-10-22: "Give
// manpower requisition option on screen of all HODs, for their own department
// only, not for all departments").
//
//   - an HOD (own employee record with a department and ≥1 direct report) sees
//     'requisition' in /hr/me canRequest and gets the form without a Department
//     field; anyone else does not, and is 403 on the form and the POST
//   - the department is the HOD's own, whatever the client sends
//   - the HOD step is signed by raising (auto), the record waits on HR
//   - two companies: B's HR never reaches A's requisition (404); the record is
//     filed in the HOD's own company
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

const P = `hodr${Date.now()}`
let app: FastifyInstance
const T: Record<string, string> = {}
const D: Record<string, string> = {}
const users: Record<string, { id: string; token: string }> = {}

async function mkUser(key: string, role: string, tenantId: string) {
  const u = await prisma.user.create({
    data: {
      name: key, email: `${P}.${key}@hodr.pk`, password: await bcrypt.hash('x-Password-1', 4), role: role as never, isActive: true,
      accountStatus: 'active', tenantId, tenantMemberships: { create: [{ tenant: { connect: { id: tenantId } }, role: 'member' }] },
    },
  })
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}
const call = (who: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url: `/hr${url}`, payload: payload as never, headers: { authorization: `Bearer ${users[who]!.token}` } })

beforeAll(async () => {
  T.A = (await prisma.tenant.create({ data: { name: 'HOD A', slug: `${P}-a` } })).id
  T.B = (await prisma.tenant.create({ data: { name: 'HOD B', slug: `${P}-b` } })).id
  D.mkt = (await prisma.department.create({ data: { tenantId: T.A, name: `Marketing ${P}` } })).id
  D.ops = (await prisma.department.create({ data: { tenantId: T.A, name: `Operations ${P}` } })).id
  await mkUser('hod', 'manager', T.A)
  await mkUser('staff', 'kitchen', T.A)
  await mkUser('hrA', 'hr', T.A)
  await mkUser('hrB', 'hr', T.B)
  const hod = await prisma.hrEmployee.create({ data: { tenantId: T.A, employeeCode: `${P}-1`, fullName: 'Head of Marketing', userId: users.hod!.id, departmentId: D.mkt, status: 'active' } })
  await prisma.hrEmployee.create({ data: { tenantId: T.A, employeeCode: `${P}-2`, fullName: 'Marketing Exec', userId: users.staff!.id, departmentId: D.mkt, managerId: hod.id, status: 'active' } })

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

describe('manpower requisition by an HOD', () => {
  let recId = ''

  it('only an HOD is offered it; the form has no Department field', async () => {
    const me = (await call('hod', 'GET', '/me')).json()
    expect(me.canRequest).toContain('requisition')
    expect(me.hodDepartment).toBe(`Marketing ${P}`)
    const form = await call('hod', 'GET', '/me/forms/requisition')
    expect(form.statusCode, form.body).toBe(200)
    expect(form.json().fields.map((f: { key: string }) => f.key)).not.toContain('department')

    const staff = (await call('staff', 'GET', '/me')).json()
    expect(staff.canRequest).not.toContain('requisition')
    expect((await call('staff', 'GET', '/me/forms/requisition')).statusCode).toBe(403)
    expect((await call('staff', 'POST', '/me/records/requisition', { data: { position: 'Designer', headcount: 1 } })).statusCode).toBe(403)
  })

  it('files it for the HOD\'s own department (never the one sent), HOD step signed, waiting on HR', async () => {
    const r = await call('hod', 'POST', '/me/records/requisition', { data: { position: 'Designer', headcount: 2, department: D.ops } })
    expect(r.statusCode, r.body).toBe(201)
    const rec = r.json()
    recId = rec.id
    expect(rec.tenantId).toBe(T.A)
    expect(rec.data.department).toBe(D.mkt)
    expect(rec.status).toBe('submitted')
    expect(rec.currentStep).toBe(1)
    expect(rec.approvals[0]).toMatchObject({ role: 'hod', decision: 'approved', byUserId: users.hod!.id, auto: true })
    // It shows in the HOD's own requests.
    expect((await call('hod', 'GET', '/me')).json().records.map((x: { id: string }) => x.id)).toContain(recId)
  })

  it('HR of the same company decides it; another company\'s HR gets 404', async () => {
    expect((await call('hrB', 'POST', `/records/requisition/${recId}/decide`, { decision: 'approved' })).statusCode).toBe(404)
    const ok = await call('hrA', 'POST', `/records/requisition/${recId}/decide`, { decision: 'approved' })
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json()).toMatchObject({ status: 'submitted', currentStep: 2 })
  })
})
