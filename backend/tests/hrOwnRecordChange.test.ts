// HR edits their OWN employee record (owner, 2026-11-04: "give him access to put details of all employee including
// himself, final approval remains with CEO/HR's HOD (CEO is also HOD of HR so keep only one approval for CEO in such
// cases)").
//   - HR's save of their own record changes nothing at once: 202 + a profile_update request, one step
//   - HR's HOD (their manager's login) approves → the change lands; HR never approves their own
//   - HR who reports to the CEO (or has no manager login): ONE CEO approval, nothing else
//   - another company's HR / CEO: 404
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { hrRoutes } from '../src/modules/hr/routes.js'

const P = `hrown${Date.now()}`
let app: FastifyInstance
const T: Record<string, string> = {}
const U: Record<string, { id: string; token: string }> = {}
const E: Record<string, string> = {}

async function mkUser(key: string, role: string, tenantId: string) {
  const u = await prisma.user.create({
    data: {
      name: key, email: `${P}.${key}@gsfoods.pk`, password: await bcrypt.hash('x-Password-1', 4), role: role as never, isActive: true,
      accountStatus: 'active', tenantId, tenantMemberships: { create: [{ tenant: { connect: { id: tenantId } }, role: 'member' }] },
    },
  })
  U[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}
const call = (who: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url: `/hr${url}`, payload: payload as never, headers: { authorization: `Bearer ${U[who]!.token}` } })
const code = (r: { json(): unknown }) => (r.json() as { error?: { code?: string } }).error?.code
const decide = (who: string, id: string, decision: 'approved' | 'rejected') => call(who, 'POST', `/records/profile_update/${id}/decide`, { decision })

beforeAll(async () => {
  T.A = (await prisma.tenant.create({ data: { name: 'Own A', slug: `${P}-a` } })).id
  T.B = (await prisma.tenant.create({ data: { name: 'Own B', slug: `${P}-b` } })).id
  await mkUser('ceo', 'admin', T.A)
  await mkUser('hod', 'management', T.A)      // HR's head of department
  await mkUser('hr', 'hr', T.A)               // reports to the HOD
  await mkUser('hr2', 'hr', T.A)              // reports to the CEO
  await mkUser('ceoB', 'admin', T.B)
  await mkUser('hrB', 'hr', T.B)
  const ceoEmp = await prisma.hrEmployee.create({ data: { tenantId: T.A, employeeCode: `${P}-0`, fullName: 'The CEO', userId: U.ceo!.id, status: 'active' } })
  const hod = await prisma.hrEmployee.create({ data: { tenantId: T.A, employeeCode: `${P}-1`, fullName: 'HR HOD', userId: U.hod!.id, status: 'active' } })
  E.hr = (await prisma.hrEmployee.create({ data: { tenantId: T.A, employeeCode: `${P}-2`, fullName: 'Hasham HR', userId: U.hr!.id, managerId: hod.id, status: 'active' } })).id
  E.hr2 = (await prisma.hrEmployee.create({ data: { tenantId: T.A, employeeCode: `${P}-3`, fullName: 'Second HR', userId: U.hr2!.id, managerId: ceoEmp.id, status: 'active' } })).id
  E.other = (await prisma.hrEmployee.create({ data: { tenantId: T.A, employeeCode: `${P}-4`, fullName: 'Someone Else', status: 'active' } })).id

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(hrRoutes, { prefix: '/hr' })
  await app.ready()
}, 60_000)

afterAll(async () => { await app?.close() })

describe('HR editing their own employee record', () => {
  let reqId = ''
  it('another employee is saved at once, as before', async () => {
    const r = await call('hr', 'PATCH', `/employees/${E.other}`, { data: { fatherHusbandName: 'Updated Father' } })
    expect(r.statusCode, r.body).toBe(200)
    expect((await prisma.hrEmployee.findUniqueOrThrow({ where: { id: E.other! } })).fatherHusbandName).toBe('Updated Father')
  })

  it('their own record: 202, nothing changes yet, one HOD step', async () => {
    const r = await call('hr', 'PATCH', `/employees/${E.hr}`, { data: { fatherHusbandName: 'My Father', nationality: 'Pakistani' } })
    expect(r.statusCode, r.body).toBe(202)
    reqId = r.json().request.id
    expect(r.json().request.section).toBe('profile_update')
    const emp = await prisma.hrEmployee.findUniqueOrThrow({ where: { id: E.hr! } })
    expect(emp.fatherHusbandName).toBeNull()
    const again = await call('hr', 'PATCH', `/employees/${E.hr}`, { data: { fatherHusbandName: 'Other' } })
    expect(code(again)).toBe('PROFILE_CHANGE_PENDING')
  })

  it('HR never approves their own; their HOD does, and the change lands', async () => {
    expect((await decide('hr', reqId, 'approved')).statusCode).toBeGreaterThanOrEqual(400)
    expect((await decide('hrB', reqId, 'approved')).statusCode).toBe(404)
    const ok = await decide('hod', reqId, 'approved')
    expect(ok.statusCode, ok.body).toBe(200)
    const rec = await prisma.hrRecord.findUniqueOrThrow({ where: { id: reqId } })
    expect(rec.status).toBe('approved')
    const emp = await prisma.hrEmployee.findUniqueOrThrow({ where: { id: E.hr! } })
    expect(emp.fatherHusbandName).toBe('My Father')
    expect((emp.data as Record<string, unknown>)['nationality']).toBe('Pakistani')
  })

  it('HR who reports to the CEO: one CEO approval and done', async () => {
    const r = await call('hr2', 'PATCH', `/employees/${E.hr2}`, { data: { fatherHusbandName: 'CEO-approved' } })
    expect(r.statusCode, r.body).toBe(202)
    const id = r.json().request.id
    expect((await decide('hr', id, 'approved')).statusCode).toBeGreaterThanOrEqual(400) // another HR: not theirs
    const ok = await decide('ceo', id, 'approved')
    expect(ok.statusCode, ok.body).toBe(200)
    expect((await prisma.hrRecord.findUniqueOrThrow({ where: { id } })).status).toBe('approved')
    expect((await prisma.hrEmployee.findUniqueOrThrow({ where: { id: E.hr2! } })).fatherHusbandName).toBe('CEO-approved')
  })

  it('company B never reaches A\'s records', async () => {
    expect((await call('hrB', 'PATCH', `/employees/${E.hr}`, { data: { fatherHusbandName: 'x' } })).statusCode).toBe(404)
  })
})
