// Staff without a login (owner, 2026-10-27). The kiosk PIN is gone: every staff
// member clocks in with their own login, and from 1 Nov a working day with no
// punch is absent. GET /hr/staff-without-login lists the current employees
// (active / on leave) with no linked login in the companies in view, for HR to
// give each a login. Two companies: B never sees A's people; leavers and linked
// employees are not listed; staff_hr is required.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import type { UserRole } from '@prisma/client'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { hrRoutes } from '../src/modules/hr/routes.js'

const stamp = Date.now()
let app: FastifyInstance
let tenantA: string, tenantB: string
const users: Record<string, { id: string; token: string }> = {}
const emps: Record<string, string> = {}

async function mkUser(key: string, role: string, tenantId: string, alsoIn: string[] = []) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${stamp}@nologin.pk`, password: await bcrypt.hash('x-Password-1', 4), role: role as UserRole, isActive: true, accountStatus: 'active', tenantId },
  })
  for (const t of [tenantId, ...alsoIn]) await prisma.tenantMember.create({ data: { tenantId: t, userId: u.id } })
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
  return u.id
}
async function mkEmp(key: string, tenantId: string, extra: Record<string, unknown> = {}) {
  const e = await prisma.hrEmployee.create({
    data: { tenantId, employeeCode: `NL-${stamp % 100000}-${Object.keys(emps).length + 1}`, fullName: `${key} ${stamp}`, ...extra } as never,
  })
  emps[key] = e.id
}
const call = (who: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url: '/hr/staff-without-login', headers: { authorization: `Bearer ${users[who]!.token}`, ...headers } })
const idsOf = (body: { employees: Array<{ id: string }> }) => new Set(body.employees.map((e) => e.id))

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: `NL A ${stamp}`, slug: `nl-a-${stamp}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: `NL B ${stamp}`, slug: `nl-b-${stamp}` } })).id
  await mkUser('hrA', 'hr', tenantA)
  await mkUser('hrB', 'hr', tenantB)
  await mkUser('ceo', 'admin', tenantA, [tenantB])
  await mkUser('cashierA', 'cashier', tenantA)
  const linkedLogin = await mkUser('cookLogin', 'kitchen', tenantA)
  await mkEmp('a-nologin', tenantA)
  await mkEmp('a-onleave', tenantA, { status: 'on_leave' })
  await mkEmp('a-left', tenantA, { status: 'left' })
  await mkEmp('a-linked', tenantA, { userId: linkedLogin })
  await mkEmp('b-nologin', tenantB)

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
    await prisma.hrEmployee.deleteMany({ where: { tenantId: t } })
    await prisma.auditLog.deleteMany({ where: { tenantId: t } }).catch(() => {})
    await prisma.tenantMember.deleteMany({ where: { tenantId: t } }).catch(() => {})
  }
  await prisma.user.deleteMany({ where: { id: { in: Object.values(users).map((u) => u.id) } } })
  await prisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } })
  await app.close()
})

describe('GET /hr/staff-without-login', () => {
  it('lists the active company\'s current employees with no login — not leavers, not linked ones', async () => {
    const r = await call('hrA')
    expect(r.statusCode, r.body).toBe(200)
    expect(idsOf(r.json())).toEqual(new Set([emps['a-nologin'], emps['a-onleave']]))
    expect(r.json().count).toBe(2)
    const row = r.json().employees.find((e: { id: string }) => e.id === emps['a-nologin'])
    expect(row).toMatchObject({ tenantId: tenantA, company: `NL A ${stamp}` })
    expect(row).not.toHaveProperty('grossSalaryCents')
  })

  it('company B never sees company A\'s people', async () => {
    const r = await call('hrB')
    expect(r.statusCode).toBe(200)
    expect(idsOf(r.json())).toEqual(new Set([emps['b-nologin']]))
  })

  it('a portfolio view spans the companies in view', async () => {
    const r = await call('ceo', { 'x-servd-portfolio': '1' })
    expect(r.statusCode, r.body).toBe(200)
    const ids = idsOf(r.json())
    expect(ids.has(emps['a-nologin']!) && ids.has(emps['b-nologin']!)).toBe(true)
    expect(ids.has(emps['a-linked']!)).toBe(false)
  })

  it('needs the HR back office', async () => {
    expect((await call('cashierA')).statusCode).toBe(403)
  })
})
