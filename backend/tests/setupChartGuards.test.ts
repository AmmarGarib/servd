// Chart-of-accounts guards (finance wave B): PATCH /setup/chart-of-accounts/:id
// refuses to switch off an account the books need, and renaming stays free.
//
//   - a REQUIRED code (2210 Due to Garibsons)          → 422 ACCOUNT_IN_USE
//   - a controlled account (an inter-company Due-from)  → 422 ACCOUNT_CONTROLLED
//   - the cost / accumulated code of an ACTIVE fixed-asset class (1510, and an
//     operator's own code a class points at)            → 422 ACCOUNT_IN_USE
//     (switch the class off and an ordinary code can go)
//   - an ordinary account switches off and on; any of them can be renamed
//   - another company's account is 404; POST never sets controlledBy
//
// Real route handlers through Fastify inject; needs the disposable test DB.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { setupRoutes } from '../src/modules/setup/routes.js'

const P = `scg${Date.now()}`
let app: FastifyInstance
let tenantA = ''
let tenantB = ''
const users: Record<string, { id: string; token: string }> = {}

async function mkUser(key: string, role: string, tenants: string[]) {
  const u = await prisma.user.create({
    data: {
      name: key, email: `${P}.${key}@scg.pk`, password: await bcrypt.hash('x-Password-1', 4), role: role as never, isActive: true,
      accountStatus: 'active', tenantId: tenants[0]!,
      tenantMemberships: { create: tenants.map((id) => ({ tenant: { connect: { id } }, role: 'member' })) },
    },
  })
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}

const call = (who: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as never, headers: { authorization: `Bearer ${users[who]!.token}` } })

const accountId = async (tenantId: string, code: string) => (await prisma.account.findFirstOrThrow({ where: { tenantId, code } })).id
const off = (who: string, id: string) => call(who, 'PATCH', `/setup/chart-of-accounts/${id}`, { isActive: false })

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'Chart A', slug: `${P}-a` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'Chart B', slug: `${P}-b` } })).id
  await ensureChartOfAccounts(tenantA)
  await ensureChartOfAccounts(tenantB)
  await mkUser('ceoA', 'admin', [tenantA])
  await mkUser('ceoB', 'admin', [tenantB])

  // The register's kitchen-equipment class, active, on 1510 / 1591.
  await prisma.fixedAssetClass.create({
    data: { tenantId: tenantA, key: 'kitchen_equipment', label: 'Kitchen equipment', costAccountCode: '1510', accumAccountCode: '1591', defaultLifeMonths: 60 },
  })

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR' } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(setupRoutes, { prefix: '/setup' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  // Controlled accounts must lose controlledBy before their company could go (accounts_controlled_company_chk).
  await prisma.account.updateMany({ where: { tenantId: { in: [tenantA, tenantB] }, controlledBy: 'intercompany' }, data: { controlledBy: null, counterpartyTenantId: null } })
  await app?.close()
})

describe('PATCH /setup/chart-of-accounts/:id — switching off', () => {
  it('a REQUIRED code (2210 Due to Garibsons) → 422 ACCOUNT_IN_USE; renaming it works', async () => {
    const id = await accountId(tenantA, '2210')
    const res = await off('ceoA', id)
    expect(res.statusCode, res.body).toBe(422)
    expect(res.json().error.code).toBe('ACCOUNT_IN_USE')
    expect((await prisma.account.findUniqueOrThrow({ where: { id } })).isActive).toBe(true)
    const renamed = await call('ceoA', 'PATCH', `/setup/chart-of-accounts/${id}`, { name: 'Due to Garibsons (cashier)' })
    expect(renamed.statusCode).toBe(200)
    expect(renamed.json().name).toBe('Due to Garibsons (cashier)')
  })

  it('a controlled inter-company Due-from → 422 ACCOUNT_CONTROLLED; renaming it works', async () => {
    const due = await prisma.account.create({
      data: { tenantId: tenantA, code: '1450', name: 'Due from Chart B', type: 'asset', controlledBy: 'intercompany', counterpartyTenantId: tenantB },
    })
    const res = await off('ceoA', due.id)
    expect(res.statusCode, res.body).toBe(422)
    expect(res.json().error.code).toBe('ACCOUNT_CONTROLLED')
    expect((await call('ceoA', 'PATCH', `/setup/chart-of-accounts/${due.id}`, { description: 'Group recharges' })).statusCode).toBe(200)
    expect((await prisma.account.findUniqueOrThrow({ where: { id: due.id } })).isActive).toBe(true)
  })

  it("1510 while its class is active → 422 (the class's cost account)", async () => {
    const res = await off('ceoA', await accountId(tenantA, '1510'))
    expect(res.statusCode, res.body).toBe(422)
    expect(res.json().error.code).toBe('ACCOUNT_IN_USE')
    expect(res.json().error.message).toMatch(/Kitchen equipment/)
  })

  it("an operator's own code a class points at → 422 while the class is active; switch the class off and it can go", async () => {
    const own = await prisma.account.create({ data: { tenantId: tenantA, code: '1790', name: 'Other plant', type: 'asset' } })
    const cls = await prisma.fixedAssetClass.create({
      data: { tenantId: tenantA, key: 'other_plant', label: 'Other plant', costAccountCode: '1790', accumAccountCode: '1599', defaultLifeMonths: 84 },
    })
    const refused = await off('ceoA', own.id)
    expect(refused.statusCode).toBe(422)
    expect(refused.json().error.code).toBe('ACCOUNT_IN_USE')
    await prisma.fixedAssetClass.update({ where: { id: cls.id }, data: { isActive: false } })
    expect((await off('ceoA', own.id)).statusCode).toBe(200)
    expect((await prisma.account.findUniqueOrThrow({ where: { id: own.id } })).isActive).toBe(false)
  })

  it('an ordinary account switches off and back on', async () => {
    const created = await call('ceoA', 'POST', '/setup/chart-of-accounts', { code: '6210', name: 'Marketing software', type: 'expense' })
    expect(created.statusCode).toBe(201)
    expect((await off('ceoA', created.json().id)).statusCode).toBe(200)
    expect((await call('ceoA', 'PATCH', `/setup/chart-of-accounts/${created.json().id}`, { isActive: true })).statusCode).toBe(200)
  })

  it("another company's account is 404 — nothing changes", async () => {
    const idB = await accountId(tenantB, '4001')
    expect((await off('ceoA', idB)).statusCode).toBe(404)
    expect((await prisma.account.findUniqueOrThrow({ where: { id: idB } })).isActive).toBe(true)
  })

  it('POST never sets controlledBy (a body field is ignored)', async () => {
    const res = await call('ceoA', 'POST', '/setup/chart-of-accounts', {
      code: '1451', name: 'Sneaky due-from', type: 'asset', controlledBy: 'intercompany', counterpartyTenantId: tenantB,
    })
    expect(res.statusCode).toBe(201)
    const row = await prisma.account.findUniqueOrThrow({ where: { id: res.json().id } })
    expect(row.controlledBy).toBeNull()
    expect(row.counterpartyTenantId).toBeNull()
    expect(row.tenantId).toBe(tenantA)
  })
})
