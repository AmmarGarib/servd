// Role presets are HR's, within safe limits (owner, 2026-10-16: "Give the
// presets thing to HR, move it out of my section then").
//
//   - PUT /permissions/role-modules admits the CEO and HR. HR must hold the
//     role_modules module in its EFFECTIVE set (the CEO's per-person untick
//     closes it).
//   - HR never edits the admin / owner / hr presets (403 PRESET_CEO_ONLY).
//   - HR never adds or removes a governance module (role_management,
//     role_modules, tenants, accounting_audit) on any preset — a save or a
//     reset that would change them is 403 PRESET_GOVERNANCE_CEO_ONLY; a save
//     that keeps them as they are works.
//   - Everyone else (cashier, finance, co-owner, management) gets 403; the CEO
//     is unchanged. GET serves presetLimits (lib/moduleAccess.ts, one copy).
//   - Presets stay servd-wide (RoleModuleAccess has no tenantId, deliberately).
//
// Real route handlers through Fastify inject; needs the disposable test DB.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import type { UserRole } from '@prisma/client'

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { issueStaffSession } = await import('../src/modules/auth/service.js')
const { AppError } = await import('../src/lib/errors.js')
const { permissionRoutes } = await import('../src/modules/permissions/routes.js')
const { DEFAULT_MODULE_ACCESS, PRESET_LIMITS, invalidateModuleAccessCache, rolePresetModules } = await import('../src/lib/moduleAccess.js')

const stamp = Date.now()
const P = `rph${stamp}`
let app: FastifyInstance
let tenantA = ''
let tenantB = ''
type U = { id: string; name: string; email: string; role: string }
const U: Record<string, U> = {}
const TOUCHED: UserRole[] = ['foh', 'management', 'hr', 'owner', 'cashier']
let savedRows: Array<{ role: UserRole; modules: string[] }> = []

async function mkUser(key: string, role: string, tenants: string[], extra: Record<string, unknown> = {}) {
  const u = await prisma.user.create({
    data: {
      name: `${P} ${key}`, email: `${P}.${key}@gsfoods.pk`, password: await bcrypt.hash('x-Password-1', 4),
      role: role as never, tenantId: tenants[0] ?? null, isActive: true, accountStatus: 'active', ...extra,
      tenantMemberships: { create: tenants.map((id) => ({ tenant: { connect: { id } }, role: 'member' })) },
    },
    select: { id: true, name: true, email: true, role: true },
  })
  U[key] = { id: u.id, name: u.name!, email: u.email!, role: u.role }
}
function auth(key: string) {
  const u = U[key]!
  const s = issueStaffSession({ id: u.id, name: u.name, email: u.email, role: u.role as never })
  return { authorization: `Bearer ${s.accessToken}` }
}
const put = (key: string, role: string, modules: string[] | null) =>
  app.inject({ method: 'PUT', url: '/api/v1/permissions/role-modules', headers: auth(key), payload: { role, modules } })
const rowOf = async (role: UserRole) => (await prisma.roleModuleAccess.findUnique({ where: { role } }))?.modules ?? null

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'Presets Co A', slug: `${P}-a` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'Presets Co B', slug: `${P}-b` } })).id
  await mkUser('ceo', 'admin', [tenantA])
  await mkUser('hrA', 'hr', [tenantA])
  await mkUser('hrB', 'hr', [tenantB])
  await mkUser('hrClosed', 'hr', [tenantA], { moduleDeny: ['role_modules'] })
  await mkUser('cashier', 'cashier', [tenantA])
  await mkUser('finance', 'finance', [tenantA])
  await mkUser('owner', 'owner', [tenantA])
  await mkUser('mgmt', 'management', [tenantA])

  // Start from the in-code defaults for the roles this file touches; put the
  // saved rows back afterwards.
  savedRows = (await prisma.roleModuleAccess.findMany({ where: { role: { in: TOUCHED } } })).map((r) => ({ role: r.role, modules: r.modules }))
  await prisma.roleModuleAccess.deleteMany({ where: { role: { in: TOUCHED } } })
  invalidateModuleAccessCache()

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR' } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: 'ERR', message: String((err as Error).message) } })
  })
  await app.register(async (api) => {
    await api.register(permissionRoutes, { prefix: '/permissions' })
  }, { prefix: '/api/v1' })
  await app.ready()
}, 120_000)

afterAll(async () => {
  await prisma.roleModuleAccess.deleteMany({ where: { role: { in: TOUCHED } } })
  for (const r of savedRows) await prisma.roleModuleAccess.create({ data: r })
  invalidateModuleAccessCache()
  await app?.close()
})

describe('Role presets are HR\'s (owner, 2026-10-16)', () => {
  it('HR holds role_modules by default; the limits are one definition', () => {
    expect(DEFAULT_MODULE_ACCESS.hr).toContain('role_modules')
    expect([...PRESET_LIMITS.ceoOnlyRoles].sort()).toEqual(['admin', 'director', 'hr', 'owner'])
    expect([...PRESET_LIMITS.governanceModules].sort()).toEqual(['accounting_audit', 'role_management', 'role_modules', 'tenants'])
  })

  it('GET serves presetLimits', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/v1/permissions/role-modules', headers: auth('hrA') })
    expect(r.statusCode).toBe(200)
    expect(r.json().presetLimits).toEqual({
      ceoOnlyRoles: [...PRESET_LIMITS.ceoOnlyRoles],
      governanceModules: [...PRESET_LIMITS.governanceModules],
    })
  })

  it('HR saves and resets the FOH preset (any company\'s HR — presets are servd-wide)', async () => {
    const ok = await put('hrA', 'foh', ['pos', 'orders', 'tables'])
    expect(ok.statusCode, ok.body).toBe(200)
    expect((await rowOf('foh'))!.sort()).toEqual(['orders', 'pos', 'tables'])
    const okB = await put('hrB', 'foh', ['pos', 'orders'])
    expect(okB.statusCode, okB.body).toBe(200)
    expect((await rowOf('foh'))!.sort()).toEqual(['orders', 'pos'])
    const reset = await put('hrA', 'foh', null)
    expect(reset.statusCode, reset.body).toBe(200)
    expect(await rowOf('foh')).toBeNull()
    const log = await prisma.auditLog.findFirst({ where: { action: 'role_modules.update', entityId: 'foh', userId: U['hrA']!.id }, orderBy: { createdAt: 'desc' } })
    expect(log).not.toBeNull()
  })

  it('HR gets 403 PRESET_CEO_ONLY on the admin, owner and hr presets', async () => {
    for (const role of ['admin', 'owner', 'hr']) {
      const r = await put('hrA', role, ['staff_hr'])
      expect(r.statusCode, role).toBe(403)
      expect(r.json().error.code, role).toBe('PRESET_CEO_ONLY')
      const reset = await put('hrA', role, null)
      expect(reset.statusCode, role).toBe(403)
    }
    expect(await rowOf('owner')).toBeNull()
    expect(await rowOf('hr')).toBeNull()
  })

  it('HR cannot add or remove a governance module, but a save that keeps them works', async () => {
    // Adding one to a role that has none.
    const add = await put('hrA', 'foh', ['pos', 'role_management'])
    expect(add.statusCode).toBe(403)
    expect(add.json().error.code).toBe('PRESET_GOVERNANCE_CEO_ONLY')
    expect(await rowOf('foh')).toBeNull()

    // management holds all four by default: removing one is refused …
    const current = await rolePresetModules('management')
    for (const g of PRESET_LIMITS.governanceModules) expect(current, g).toContain(g)
    const drop = await put('hrA', 'management', current.filter((m) => m !== 'tenants'))
    expect(drop.statusCode).toBe(403)
    expect(drop.json().error.code).toBe('PRESET_GOVERNANCE_CEO_ONLY')
    // … while an ordinary change that keeps them is saved.
    const keep = await put('hrA', 'management', current.filter((m) => m !== 'campaigns'))
    expect(keep.statusCode, keep.body).toBe(200)
    expect(await rowOf('management')).not.toContain('campaigns')

    // The CEO takes 'tenants' away; HR's reset would give it back → refused.
    expect((await put('ceo', 'management', current.filter((m) => m !== 'tenants'))).statusCode).toBe(200)
    const reset = await put('hrA', 'management', null)
    expect(reset.statusCode).toBe(403)
    expect(reset.json().error.code).toBe('PRESET_GOVERNANCE_CEO_ONLY')
    // HR may still save around the CEO's choice (tenants stays off).
    const after = (await rowOf('management'))!
    const keep2 = await put('hrA', 'management', after.filter((m) => m !== 'reviews'))
    expect(keep2.statusCode, keep2.body).toBe(200)
    expect(await rowOf('management')).not.toContain('tenants')
    // The CEO resets it.
    expect((await put('ceo', 'management', null)).statusCode).toBe(200)
    expect(await rowOf('management')).toBeNull()
  })

  it('HR whose own access to Role presets the CEO removed is refused', async () => {
    const r = await put('hrClosed', 'foh', ['pos'])
    expect(r.statusCode).toBe(403)
    expect(r.json().error.code).toBe('MODULE_NOT_ALLOWED')
    expect(await rowOf('foh')).toBeNull()
  })

  it('cashier, finance, the co-owner and management get 403', async () => {
    for (const k of ['cashier', 'finance', 'owner', 'mgmt']) {
      const r = await put(k, 'foh', ['pos'])
      expect(r.statusCode, k).toBe(403)
    }
    expect(await rowOf('foh')).toBeNull()
  })

  it('the CEO is unchanged: any role but admin, governance modules included', async () => {
    expect((await put('ceo', 'hr', ['staff_hr', 'staff_directory'])).statusCode).toBe(200)
    expect((await put('ceo', 'owner', [...DEFAULT_MODULE_ACCESS.owner, 'role_management'])).statusCode).toBe(200)
    expect((await put('ceo', 'foh', ['pos', 'tenants'])).statusCode).toBe(200)
    expect((await put('ceo', 'admin', ['pos'])).statusCode).toBe(400)
    for (const role of ['hr', 'owner', 'foh']) expect((await put('ceo', role, null)).statusCode, role).toBe(200)
  })

  it('per-person module access stays CEO only', async () => {
    const r = await app.inject({ method: 'PUT', url: `/api/v1/permissions/users/${U['cashier']!.id}/modules`, headers: auth('hrA'), payload: { modules: ['pos'] } })
    expect(r.statusCode).toBe(403)
  })
})

// ── Gate pass (adversarial review, 2026-10-16) ───────────────────────────────
describe('Role presets: escalation attempts by HR', () => {
  it('case, whitespace, duplicate and CEO-only-module tricks do not get round the limits', async () => {
    for (const role of ['HR', 'Owner', 'ADMIN', ' hr']) {
      const r = await put('hrA', role, ['staff_hr'])
      expect(r.statusCode, role).toBe(400)
    }
    for (const m of ['ROLE_MANAGEMENT', 'Tenants', ' role_modules', 'role_modules ']) {
      const r = await put('hrA', 'foh', ['pos', m])
      expect(r.statusCode, m).toBe(400)
      expect(r.json().error.code, m).toBe('UNKNOWN_MODULE')
    }
    const dup = await put('hrA', 'foh', ['pos', 'pos', 'tenants', 'tenants'])
    expect(dup.statusCode).toBe(403)
    expect(dup.json().error.code).toBe('PRESET_GOVERNANCE_CEO_ONLY')
    for (const g of PRESET_LIMITS.governanceModules) {
      const r = await put('hrA', 'cashier', ['pos', g])
      expect(r.statusCode, g).toBe(403)
    }
    expect(await rowOf('foh')).toBeNull()
    expect(await rowOf('cashier')).toBeNull()
    // A CEO-only module (Brands) is dropped, never granted.
    const brands = await put('hrA', 'foh', ['pos', 'brands'])
    expect(brands.statusCode, brands.body).toBe(200)
    expect(await rowOf('foh')).toEqual(['pos'])
    expect((await put('hrA', 'foh', null)).statusCode).toBe(200)
  })

  it('a company header does not widen HR: the CEO-only roles and governance modules stay locked', async () => {
    const h = { ...auth('hrA'), 'x-servd-active-tenant': tenantB }
    const r1 = await app.inject({ method: 'PUT', url: '/api/v1/permissions/role-modules', headers: h, payload: { role: 'owner', modules: ['staff_hr'] } })
    expect(r1.statusCode).not.toBe(200)
    const r2 = await app.inject({ method: 'PUT', url: '/api/v1/permissions/role-modules', headers: h, payload: { role: 'foh', modules: ['pos', 'role_modules'] } })
    expect(r2.statusCode).not.toBe(200)
    expect(await rowOf('owner')).toBeNull()
    expect(await rowOf('foh')).toBeNull()
  })

  it('HR\'s check reads the saved row live, never a stale cache (a CEO change elsewhere is not undone)', async () => {
    invalidateModuleAccessCache()
    const full = await rolePresetModules('management')   // primes the per-process cache
    expect(full).toContain('tenants')
    // The CEO takes 'tenants' away on ANOTHER API process: the row changes,
    // this process's cache is not invalidated.
    const without = full.filter((m) => m !== 'tenants')
    await prisma.roleModuleAccess.create({ data: { role: 'management', modules: without } })
    try {
      expect(await rolePresetModules('management')).toContain('tenants')  // still stale here
      const r = await put('hrA', 'management', full.filter((m) => m !== 'campaigns'))
      expect(r.statusCode, r.body).toBe(403)
      expect(r.json().error.code).toBe('PRESET_GOVERNANCE_CEO_ONLY')
      expect(await rowOf('management')).not.toContain('tenants')
    } finally {
      await prisma.roleModuleAccess.deleteMany({ where: { role: 'management' } })
      invalidateModuleAccessCache()
    }
  })

  it('MODULE_GRANTS gives role_modules to a saved hr row once, and leaves saved manager rows alone', async () => {
    const { applyModuleGrants, MODULE_GRANTS_MARKER_KEY } = await import('../src/lib/moduleAccess.js')
    const marker = await prisma.setting.findUnique({ where: { key: MODULE_GRANTS_MARKER_KEY } })
    const keepManager = await prisma.roleModuleAccess.findUnique({ where: { role: 'manager' } })
    const keepHr = await prisma.roleModuleAccess.findUnique({ where: { role: 'hr' } })
    const managerSaved = DEFAULT_MODULE_ACCESS.manager.filter((m) => m !== 'role_modules')
    try {
      await applyModuleGrants()   // everything else already applied
      const done = JSON.parse((await prisma.setting.findUnique({ where: { key: MODULE_GRANTS_MARKER_KEY } }))!.value) as string[]
      await prisma.setting.update({ where: { key: MODULE_GRANTS_MARKER_KEY }, data: { value: JSON.stringify(done.filter((m) => m !== 'role_modules')) } })
      await prisma.roleModuleAccess.deleteMany({ where: { role: { in: ['hr', 'manager'] } } })
      await prisma.roleModuleAccess.create({ data: { role: 'hr', modules: ['staff_hr', 'staff_directory'] } })
      await prisma.roleModuleAccess.create({ data: { role: 'manager', modules: managerSaved } })
      const first = await applyModuleGrants()
      expect(first.applied).toEqual(['role_modules'])
      expect(first.roles).toEqual(['hr'])
      expect((await rowOf('hr'))!.sort()).toEqual(['role_modules', 'staff_directory', 'staff_hr'])
      expect(await rowOf('manager')).not.toContain('role_modules')
      // Once: a later CEO untick on hr sticks.
      await prisma.roleModuleAccess.update({ where: { role: 'hr' }, data: { modules: ['staff_hr'] } })
      const second = await applyModuleGrants()
      expect(second.applied).toEqual([])
      expect(await rowOf('hr')).toEqual(['staff_hr'])
    } finally {
      await prisma.roleModuleAccess.deleteMany({ where: { role: { in: ['hr', 'manager'] } } })
      if (keepManager) await prisma.roleModuleAccess.create({ data: { role: 'manager', modules: keepManager.modules } })
      if (keepHr) await prisma.roleModuleAccess.create({ data: { role: 'hr', modules: keepHr.modules } })
      if (marker) await prisma.setting.update({ where: { key: MODULE_GRANTS_MARKER_KEY }, data: { value: marker.value } })
      invalidateModuleAccessCache()
    }
  })

  it('no module id sits in two workspaces; role_modules in HR only', async () => {
    const { WORKSPACES } = await import('../src/lib/workspaces.js')
    // (workspaces.test.ts proves every module id is placed; here: none twice)
    const seen = new Map<string, number>()
    for (const w of WORKSPACES) for (const s of w.sections) for (const m of s.modules) seen.set(m, (seen.get(m) ?? 0) + 1)
    for (const [m, n] of seen) expect(n, m).toBe(1)
    const where = WORKSPACES.filter((w) => w.sections.some((s) => s.modules.includes('role_modules'))).map((w) => w.id)
    expect(where).toEqual(['hr'])
  })
})
