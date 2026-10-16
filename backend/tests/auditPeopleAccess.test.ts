// People audit PPL-08 / books audit BOOKS-02: the sidebar (a role's default
// modules, lib/moduleAccess.ts) and the API must agree.
//
// Before: finance and HR saw Capital, Projections and Tip pools links that
// answered 403, finance could not read payroll, and FOH/BOH managers — who
// hold none of those modules — read the capital ledger, projections and tip
// pools. Now /finance, /projections and /tip-pools are gated by module, and
// their role arrays let in the roles whose defaults hold the module.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import type { UserRole } from '@prisma/client'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { ALL_ROLES } from '../src/lib/roles.js'
import { DEFAULT_MODULE_ACCESS, enforceModuleAccess } from '../src/lib/moduleAccess.js'
import { WORKSPACE_OF_MODULE } from '../src/lib/workspaces.js'
import { projectionsRoutes } from '../src/modules/projections/routes.js'
import { financePlanningRoutes } from '../src/modules/financePlanning/routes.js'
import { tipPoolRoutes } from '../src/modules/tipPools/routes.js'
import { hrRoutes } from '../src/modules/hr/routes.js'

const stamp = Date.now()
let app: FastifyInstance
let tenantA: string, tenantB: string
const tokens: Record<string, string> = {}

/** Each module's sidebar pages, by the API read behind them. */
const MODULE_READS: Record<string, string[]> = {
  capital: ['/finance/capex', '/finance/capital-ledger'],
  projections: ['/projections'],
  payroll: ['/tip-pools'],
}

async function mkUser(key: string, role: string, tenantId: string) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${stamp}@pplaccess.pk`, password: await bcrypt.hash('x-Password-1', 4), role: role as UserRole, isActive: true, accountStatus: 'active', tenantId },
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } })
  tokens[key] = `Bearer ${(issueStaffSession(u) as { accessToken: string }).accessToken}`
}
const get = (who: string, url: string) => app.inject({ method: 'GET', url: `/api/v1${url}`, headers: { authorization: tokens[who]! } })
const post = (who: string, url: string, payload: unknown) => app.inject({ method: 'POST', url: `/api/v1${url}`, payload: payload as never, headers: { authorization: tokens[who]! } })

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'GS Foods (access)', slug: `gs-acc-${stamp}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'Karachi Bites (access)', slug: `kb-acc-${stamp}` } })).id
  for (const role of ALL_ROLES) await mkUser(role, role, tenantA)
  await mkUser('financeB', 'finance', tenantB)
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(projectionsRoutes, { prefix: '/api/v1/projections' })
  await app.register(financePlanningRoutes, { prefix: '/api/v1/finance' })
  await app.register(tipPoolRoutes, { prefix: '/api/v1/tip-pools' })
  await app.register(hrRoutes, { prefix: '/api/v1/hr' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  await app?.close()
})

describe('PPL-08 a role reaches a module\'s pages exactly when its defaults hold the module', () => {
  it('every role × capital / projections / tip pools: 200 with the module, 403 without', async () => {
    const mismatches: string[] = []
    for (const role of ALL_ROLES) {
      for (const [mod, paths] of Object.entries(MODULE_READS)) {
        const holds = role === 'admin' || (DEFAULT_MODULE_ACCESS[role] ?? []).includes(mod)
        for (const p of paths) {
          const r = await get(role, p)
          if (holds ? r.statusCode !== 200 : r.statusCode !== 403) mismatches.push(`${role} ${mod} ${p} → ${r.statusCode}`)
        }
      }
    }
    expect(mismatches).toEqual([])
  })

  it('the floor managers no longer read capital, projections or tip pools', async () => {
    for (const role of ['foh_management', 'boh_management', 'fnb_manager'] as const) {
      for (const p of ['/finance/capital-ledger', '/projections', '/tip-pools']) expect((await get(role, p)).statusCode, `${role} ${p}`).toBe(403)
    }
  })

  it('the CEO\'s Module Access toggle is the control: grant or withhold per user', async () => {
    await expect(enforceModuleAccess('/api/v1/tip-pools', { role: 'foh_management', moduleAllow: ['payroll'] })).resolves.toBeUndefined()
    await expect(enforceModuleAccess('/api/v1/projections', { role: 'finance', moduleDeny: ['projections'] })).rejects.toThrow(/module/)
    await expect(enforceModuleAccess('/api/v1/finance/capex', { role: 'finance', moduleDeny: ['capital'] })).rejects.toThrow(/module/)
  })

  it('the CEO section (D2) keeps company governance off the floor managers', () => {
    // Moving the company modules into the CEO workspace changed no default:
    // the floor managers still hold none of them.
    for (const role of ['foh_management', 'boh_management', 'fnb_manager'] as const) {
      for (const m of ['tenants', 'business_info', 'role_management', 'role_modules', 'configuration', 'settings', 'onboarding', 'approvals']) {
        expect(DEFAULT_MODULE_ACCESS[role], `${role}: ${m}`).not.toContain(m)
      }
    }
    for (const m of ['approvals', 'tenants', 'role_management', 'configuration']) expect(WORKSPACE_OF_MODULE.get(m), m).toBe('ceo')
    // Role presets moved to HR (owner, 2026-10-16).
    expect(WORKSPACE_OF_MODULE.get('role_modules')).toBe('hr')
    expect(WORKSPACE_OF_MODULE.get('menu')).toBe('operations')
  })

  it('BOH managers rota the kitchen, so the Rota is in their modules', () => {
    expect(DEFAULT_MODULE_ACCESS.boh_management).toContain('scheduling')
    // Every default module still sits in a workspace (decision 47).
    for (const role of ALL_ROLES) for (const m of DEFAULT_MODULE_ACCESS[role] ?? []) {
      if (m !== 'media') expect(WORKSPACE_OF_MODULE.has(m), `${role}: ${m}`).toBe(true)
    }
  })
})

describe('BOOKS-02 finance reaches its workspace (the parts these routes own)', () => {
  it('finance reads payroll, capital, projections and tip pools; HR reads tip pools', async () => {
    for (const p of ['/hr/payroll/runs', '/finance/capex', '/finance/capital-ledger', '/projections', '/tip-pools']) {
      expect((await get('finance', p)).statusCode, p).toBe(200)
    }
    expect((await get('hr', '/tip-pools')).statusCode).toBe(200)
    expect((await get('finance', '/hr/employees')).statusCode).toBe(403)
    // Wave 3 (UI-07): finance works the CapEx tracker too (its workspace);
    // the project binds to finance's active company. Capitalising and the
    // backfill stay the CEO's (tests/wave3Finance.test.ts).
    const capex = await post('finance', '/finance/capex', { name: 'Fit-out' })
    expect(capex.statusCode).toBe(201)
    expect(capex.json().tenantId).toBe(tenantA)
  })

  it('finance works projections for its own company only', async () => {
    const created = await post('finance', '/projections', { name: 'FY27 base' })
    expect([200, 201]).toContain(created.statusCode)
    const id = created.json().id as string
    expect((await prisma.projection.findUniqueOrThrow({ where: { id } })).tenantId).toBe(tenantA)
    expect((await get('finance', `/projections/${id}/computed`)).statusCode).toBe(200)
    expect((await get('financeB', `/projections/${id}/computed`)).statusCode).toBe(404)
    expect(((await get('financeB', '/projections')).json() as Array<{ id: string }>).some((p) => p.id === id)).toBe(false)
  })
})
