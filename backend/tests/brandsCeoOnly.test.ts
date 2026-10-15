// Brands is the CEO's (owner, 2026-10-14: "the brand editor needs to be moved
// to CEO stuff, because a lot of this stuff is not marketing related").
//
// What this guards (two companies):
//   - 'brands' sits in the CEO workspace (its own section), not Marketing;
//   - no role but admin holds it by default; GET /permissions/me drops it for
//     marketing, brand_manager, management and owner, the CEO keeps it;
//   - the ONE-TIME revoke (MODULE_REVOKES 'brands-ceo-only-20261014') strips
//     it from saved Module Access rows and users' moduleAllow once, and a
//     second run is a no-op;
//   - a stale or re-added grant (saved row, per-user allow, the CEO ticking it
//     in Module Access) never re-opens it: the saves strip it, the resolver
//     drops it, and PATCH /concepts checks role admin itself;
//   - the brand-editor writes: marketing / brand_manager / management /
//     owner 403 BRAND_CEO_ONLY, the CEO 200; company B's CEO 404 on A's brand;
//   - the operational brand writers keep their own routes and roles
//     (PUT /connectors/fiscal/brand-pos-ids — unchanged, not exercised here).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { prisma, mkCompany, mkUser, type Company, type Who } from './connectorsFixtures.js'
import { AppError, errorResponse } from '../src/lib/errors.js'
import { conceptRoutes } from '../src/modules/concepts/routes.js'
import { permissionRoutes } from '../src/modules/permissions/routes.js'
import { authRoutes } from '../src/modules/auth/routes.js'
import {
  DEFAULT_MODULE_ACCESS, CEO_ONLY_MODULES, MODULE_REVOKES, MODULE_REVOKES_MARKER_KEY,
  applyModuleRevokes, effectiveModulesForUser, invalidateModuleAccessCache,
} from '../src/lib/moduleAccess.js'
import { WORKSPACES, WORKSPACE_OF_MODULE } from '../src/lib/workspaces.js'

let app: FastifyInstance
let A: Company
let B: Company
let ceoA: Who, ceoB: Who, mktA: Who, brandMgrA: Who, mgmtA: Who, ownerA: Who
const stamp = Date.now()

const call = (who: Who, method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: unknown) =>
  app.inject({ method, url, ...(payload !== undefined && { payload: payload as Record<string, unknown> }), headers: { authorization: `Bearer ${who.token}` } })

beforeAll(async () => {
  A = await mkCompany(`bco-a-${stamp}`)
  B = await mkCompany(`bco-b-${stamp}`)
  ceoA = await mkUser('bco-ceo-a', 'admin', A.tenantId)
  ceoB = await mkUser('bco-ceo-b', 'admin', B.tenantId)
  mktA = await mkUser('bco-mkt-a', 'marketing', A.tenantId)
  brandMgrA = await mkUser('bco-bm-a', 'brand_manager', A.tenantId)
  mgmtA = await mkUser('bco-mgmt-a', 'management', A.tenantId)
  ownerA = await mkUser('bco-owner-a', 'owner', A.tenantId)
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: 'ERR', message: (err as Error).message } })
  })
  await app.register(conceptRoutes, { prefix: '/concepts' })
  await app.register(permissionRoutes, { prefix: '/permissions' })
  await app.register(authRoutes, { prefix: '/auth' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  await prisma.roleModuleAccess.deleteMany({ where: { role: { in: ['marketing', 'brand_manager', 'management'] } } })
  invalidateModuleAccessCache()
  await app?.close()
})

describe('where Brands lives', () => {
  it('in the CEO workspace (its own section), not Marketing', () => {
    expect(WORKSPACE_OF_MODULE.get('brands')).toBe('ceo')
    const ceo = WORKSPACES.find((w) => w.id === 'ceo')!
    expect(ceo.sections.find((s) => s.key === 'brands')?.modules).toEqual(['brands'])
    const mkt = WORKSPACES.find((w) => w.id === 'marketing')!
    expect(mkt.sections.flatMap((s) => s.modules)).not.toContain('brands')
    expect(mkt.sections.flatMap((s) => s.modules)).toContain('storefront')
  })

  it('only the CEO holds it by default', () => {
    expect(CEO_ONLY_MODULES).toEqual(['brands'])
    for (const [role, mods] of Object.entries(DEFAULT_MODULE_ACCESS)) {
      if (role === 'admin') expect(mods, role).toContain('brands')
      else expect(mods, role).not.toContain('brands')
    }
  })

  it('GET /permissions/me: marketing, brand_manager, management and owner lose it; the CEO keeps it', async () => {
    for (const who of [mktA, brandMgrA, mgmtA, ownerA]) {
      const me = await call(who, 'GET', '/permissions/me')
      expect(me.statusCode).toBe(200)
      expect(me.json().modules, who.role).not.toContain('brands')
      const sections = (me.json().workspaces as Array<{ sections: Array<{ modules: string[] }> }>).flatMap((w) => w.sections.flatMap((s) => s.modules))
      expect(sections, who.role).not.toContain('brands')
    }
    // Marketing still has its Storefront.
    expect((await call(mktA, 'GET', '/permissions/me')).json().modules).toContain('storefront')
    const ceo = (await call(ceoA, 'GET', '/permissions/me')).json()
    expect(ceo.modules).toContain('brands')
    const ceoWs = (ceo.workspaces as Array<{ id: string; sections: Array<{ key: string; modules: string[] }> }>).find((w) => w.id === 'ceo')!
    expect(ceoWs.sections.find((s) => s.key === 'brands')?.modules).toEqual(['brands'])
  })
})

describe('the one-time revoke of saved grants', () => {
  it('strips brands from saved role rows and users\' moduleAllow once; a second run changes nothing', async () => {
    await prisma.roleModuleAccess.upsert({
      where: { role: 'marketing' },
      create: { role: 'marketing', modules: ['crm', 'brands', 'storefront'] },
      update: { modules: ['crm', 'brands', 'storefront'] },
    })
    await prisma.roleModuleAccess.upsert({
      where: { role: 'management' },
      create: { role: 'management', modules: ['orders', 'brands'] },
      update: { modules: ['orders', 'brands'] },
    })
    await prisma.user.update({ where: { id: brandMgrA.id }, data: { moduleAllow: ['brands', 'crm'] } })
    await prisma.setting.deleteMany({ where: { key: MODULE_REVOKES_MARKER_KEY } })

    const first = await applyModuleRevokes()
    expect(first.applied).toEqual(MODULE_REVOKES.map((r) => r.key))
    expect(first.applied).toContain('brands-ceo-only-20261014')
    expect(first.roleRows).toBe(2)
    expect(first.users).toBeGreaterThanOrEqual(1)
    expect((await prisma.roleModuleAccess.findUniqueOrThrow({ where: { role: 'marketing' } })).modules).toEqual(['crm', 'storefront'])
    expect((await prisma.roleModuleAccess.findUniqueOrThrow({ where: { role: 'management' } })).modules).toEqual(['orders'])
    expect((await prisma.user.findUniqueOrThrow({ where: { id: brandMgrA.id } })).moduleAllow).toEqual(['crm'])
    const marker = await prisma.setting.findUniqueOrThrow({ where: { key: MODULE_REVOKES_MARKER_KEY } })
    expect(JSON.parse(marker.value)).toContain('brands-ceo-only-20261014')

    // Once: a row that lists it again afterwards is not touched by a re-run …
    await prisma.roleModuleAccess.update({ where: { role: 'marketing' }, data: { modules: ['crm', 'brands', 'storefront'] } })
    const second = await applyModuleRevokes()
    expect(second).toEqual({ applied: [], roleRows: 0, users: 0 })
    expect((await prisma.roleModuleAccess.findUniqueOrThrow({ where: { role: 'marketing' } })).modules).toContain('brands')

    // … but it still grants nothing: the resolver drops CEO-only modules.
    invalidateModuleAccessCache()
    expect((await effectiveModulesForUser({ role: 'marketing' })).has('brands')).toBe(false)
    expect((await effectiveModulesForUser({ role: 'management', moduleAllow: ['brands'] })).has('brands')).toBe(false)
    expect((await effectiveModulesForUser({ role: 'admin' })).has('brands')).toBe(true)
    expect((await call(mktA, 'GET', '/permissions/me')).json().modules).not.toContain('brands')
    expect((await call(mktA, 'PATCH', `/concepts/${A.conceptId}`, { description: 'stale grant' })).statusCode).toBe(403)
    expect((await call(mktA, 'GET', '/concepts?view=brand')).statusCode).toBe(403)

    await prisma.roleModuleAccess.deleteMany({ where: { role: { in: ['marketing', 'management'] } } })
    invalidateModuleAccessCache()
  })

  it('the CEO ticking Brands for a role in Module Access saves the rest without it', async () => {
    const r = await call(ceoA, 'PUT', '/permissions/role-modules', { role: 'brand_manager', modules: ['crm', 'brands', 'storefront'] })
    expect(r.statusCode, r.body).toBe(200)
    expect((await prisma.roleModuleAccess.findUniqueOrThrow({ where: { role: 'brand_manager' } })).modules.sort()).toEqual(['crm', 'storefront'])
    const rm = (await call(ceoA, 'GET', '/permissions/role-modules')).json()
    expect(rm.ceoOnlyModules).toEqual(['brands'])
    expect(rm.overrides.brand_manager).not.toContain('brands')
    // Still CEO only after the "re-grant": the editor stays closed to brand_manager.
    invalidateModuleAccessCache()
    expect((await call(brandMgrA, 'PATCH', `/concepts/${A.conceptId}`, { description: 're-granted' })).statusCode).toBe(403)
    await prisma.roleModuleAccess.deleteMany({ where: { role: 'brand_manager' } })
    invalidateModuleAccessCache()
  })

  it('a per-user allow of Brands on the staff screen is dropped', async () => {
    const r = await call(ceoA, 'PATCH', `/auth/users/${mktA.id}`, { moduleAllow: ['brands', 'crm'] })
    expect(r.statusCode, r.body).toBe(200)
    expect((await prisma.user.findUniqueOrThrow({ where: { id: mktA.id } })).moduleAllow).toEqual(['crm'])
    await prisma.user.update({ where: { id: mktA.id }, data: { moduleAllow: [] } })
  })
})

describe('the brand-editor writes are CEO only', () => {
  it('marketing, brand_manager, management and owner → 403 BRAND_CEO_ONLY; nothing changes', async () => {
    const before = await prisma.concept.findUniqueOrThrow({ where: { id: A.conceptId } })
    for (const who of [mktA, brandMgrA, mgmtA, ownerA]) {
      for (const body of [{ description: 'x' }, { name: 'x' }, { taxRateCash: 1 }, { reservationsEnabled: false }, { serviceVessel: 'packaging' }]) {
        const r = await call(who, 'PATCH', `/concepts/${A.conceptId}`, body)
        expect(r.statusCode, `${who.role} ${JSON.stringify(body)}`).toBe(403)
        expect(r.json().error.code).toBe('BRAND_CEO_ONLY')
      }
      // Create and delete were already CEO only.
      expect((await call(who, 'POST', '/concepts', { name: 'X', slug: `bco-x-${stamp}`, type: 'restaurant', serviceVessel: 'plate' })).statusCode).toBe(403)
    }
    expect(await prisma.concept.findUniqueOrThrow({ where: { id: A.conceptId } })).toEqual(before)
  })

  it('the CEO saves; company B\'s CEO gets 404 on A\'s brand', async () => {
    const ok = await call(ceoA, 'PATCH', `/concepts/${A.conceptId}?view=brand`, { description: 'CEO edit', reservationsEnabled: true })
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json().brandEditorAccess).toBe('full')
    expect((await prisma.concept.findUniqueOrThrow({ where: { id: A.conceptId } })).description).toBe('CEO edit')
    const foreign = await call(ceoB, 'PATCH', `/concepts/${A.conceptId}`, { description: 'B on A' })
    expect(foreign.statusCode).toBe(404)
    expect((await prisma.concept.findUniqueOrThrow({ where: { id: A.conceptId } })).description).toBe('CEO edit')
  })

  it('reads other pages use are unchanged: the picker, the storefront view, management\'s list', async () => {
    expect((await call(mktA, 'GET', '/concepts?view=picker')).statusCode).toBe(200)
    expect((await call(mktA, 'GET', '/concepts?view=storefront')).statusCode).toBe(200)
    expect((await call(mgmtA, 'GET', '/concepts')).statusCode).toBe(200)
    expect((await call(mgmtA, 'GET', `/concepts/${A.conceptId}`)).statusCode).toBe(200)
  })
})
