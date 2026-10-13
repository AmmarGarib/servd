// PATCH /setup/operations-config after finance wave B:
//   • withholdingTaxPct is no longer written here — its ONE writer is
//     PUT /accounting/withholding/rates (it stays equal to the 153(1)(a)
//     filer rate). A body that still sends it is accepted, the % is ignored.
//   • withholdingTaxEnabled / withholdingTaxRecoverable stay here.
//   • cashAdvanceSettleDays (H3, 1–365) is saved for the ACTIVE company only
//     and audited by name.
//
// Requires a disposable database (DATABASE_URL must contain "test").
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import type { UserRole } from '@prisma/client'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { setupRoutes } from '../src/modules/setup/routes.js'

const RUN = Math.random().toString(36).slice(2, 8)
let app: FastifyInstance
const staff: Record<string, { id: string; token: string }> = {}
let tenantA: string, tenantB: string

async function mkStaff(key: string, role: string, tenantId: string, alsoIn: string[] = []) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${RUN}@opscfg.test`, password: await bcrypt.hash('x-Password-1', 4), role: role as UserRole, isActive: true, accountStatus: 'active', tenantId },
  })
  for (const t of [tenantId, ...alsoIn]) await prisma.tenantMember.create({ data: { tenantId: t, userId: u.id } })
  staff[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}
const patch = (who: string, payload: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: 'PATCH', url: '/setup/operations-config', payload: payload as never, headers: { authorization: `Bearer ${staff[who]!.token}`, ...headers } })
const ops = (tenantId: string) => prisma.operationsConfig.findFirstOrThrow({ where: { tenantId, scope: 'global', scopeId: null } })

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'Ops A', slug: `ops-a-${RUN}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'Ops B', slug: `ops-b-${RUN}` } })).id
  await prisma.operationsConfig.create({ data: { tenantId: tenantA, scope: 'global', scopeId: null, withholdingTaxEnabled: true, withholdingTaxPct: 0.05 } })
  await prisma.operationsConfig.create({ data: { tenantId: tenantB, scope: 'global', scopeId: null } })
  await mkStaff('adminAB', 'admin', tenantA, [tenantB])
  await mkStaff('finA', 'finance', tenantA)

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(setupRoutes, { prefix: '/setup' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  await app?.close()
})

describe('PATCH /setup/operations-config (wave B)', () => {
  it('withholdingTaxPct is ignored; the cash-request days are saved for the ACTIVE company only and audited by name', async () => {
    const res = await patch('adminAB', { withholdingTaxPct: 0.2, cashAdvanceSettleDays: 45 })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ tenantId: tenantA, withholdingTaxPct: 0.05, cashAdvanceSettleDays: 45 })
    const a = await ops(tenantA)
    expect(a.withholdingTaxPct).toBe(0.05)
    expect(a.cashAdvanceSettleDays).toBe(45)
    expect((await ops(tenantB)).cashAdvanceSettleDays).toBe(30)

    const trail = await prisma.auditLog.findMany({ where: { action: 'operations_config.update', tenantId: tenantA } })
    expect(trail).toHaveLength(1)
    expect(trail[0]!.metadata).toMatchObject({ fields: ['cashAdvanceSettleDays'] })
    expect(trail[0]!.before).toEqual({ cashAdvanceSettleDays: 30 })
    expect(trail[0]!.after).toEqual({ cashAdvanceSettleDays: 45 })
  })

  it('a body with only the % changes nothing and audits nothing', async () => {
    const res = await patch('adminAB', { withholdingTaxPct: 0.3 })
    expect(res.statusCode).toBe(200)
    expect((await ops(tenantA)).withholdingTaxPct).toBe(0.05)
    expect(await prisma.auditLog.count({ where: { action: 'operations_config.update', tenantId: tenantA } })).toBe(1)
  })

  it('switching to B writes B only', async () => {
    const res = await patch('adminAB', { cashAdvanceSettleDays: 10 }, { 'x-servd-active-tenant': tenantB })
    expect(res.statusCode).toBe(200)
    expect((await ops(tenantB)).cashAdvanceSettleDays).toBe(10)
    expect((await ops(tenantA)).cashAdvanceSettleDays).toBe(45)
    expect(await prisma.auditLog.count({ where: { action: 'operations_config.update', tenantId: tenantB } })).toBe(1)
  })

  it('1–365 whole days only (400 otherwise); the withholding switch stays here', async () => {
    for (const bad of [0, 366, 1.5, -3]) {
      const res = await patch('adminAB', { cashAdvanceSettleDays: bad })
      expect(res.statusCode).toBe(400)
    }
    expect((await ops(tenantA)).cashAdvanceSettleDays).toBe(45)
    expect((await patch('adminAB', { cashAdvanceSettleDays: 365 })).statusCode).toBe(200)
    expect((await patch('adminAB', { cashAdvanceSettleDays: 1, withholdingTaxEnabled: false })).statusCode).toBe(200)
    const a = await ops(tenantA)
    expect(a).toMatchObject({ cashAdvanceSettleDays: 1, withholdingTaxEnabled: false, withholdingTaxPct: 0.05 })
  })

  it('finance cannot change the company\'s operations rules', async () => {
    const res = await patch('finA', { cashAdvanceSettleDays: 20 })
    expect(res.statusCode).toBe(403)
    expect((await ops(tenantA)).cashAdvanceSettleDays).toBe(1)
  })
})
