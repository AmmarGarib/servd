// Brand info is marketing's (owner, 2026-10-20: "create a company can lie
// with CEO, but adding brand info etc can go to marketing manager") — this
// REPLACES the CEO-only rule of 2026-10-14.
//
// What this guards (two companies):
//   - 'brands' sits in Marketing → Brand & site; the CEO workspace keeps
//     companies (tenants / onboarding) and logins & module access;
//   - marketing and brand_manager hold it by default (and through the
//     one-time grant on saved rows); management and owner do not by default;
//     the CEO may tick it for a person on Workforce, which opens the editor;
//   - marketing edits brand info (description, contact, brief, profiles…) of
//     its own companies' brands; a CHANGE to a CEO field (tax rates, legal /
//     invoice details, POS ids, switching off, vessel, the look) is 403
//     BRAND_FIELD_CEO_ONLY, an unchanged value in a full save passes;
//   - creating and deleting a brand stay the CEO's; company B 404.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { prisma, mkCompany, mkUser, type Company, type Who } from './connectorsFixtures.js'
import { AppError, errorResponse } from '../src/lib/errors.js'
import { conceptRoutes } from '../src/modules/concepts/routes.js'
import { permissionRoutes } from '../src/modules/permissions/routes.js'
import { authRoutes } from '../src/modules/auth/routes.js'
import {
  DEFAULT_MODULE_ACCESS, CEO_ONLY_MODULES, MODULE_GRANTS, MODULE_GRANT_ROLES, effectiveModulesForUser, invalidateModuleAccessCache,
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
  it('in Marketing → Brand & site; not in the CEO workspace', () => {
    expect(WORKSPACE_OF_MODULE.get('brands')).toBe('marketing')
    const mkt = WORKSPACES.find((w) => w.id === 'marketing')!
    expect(mkt.sections.find((s) => s.key === 'brand')?.modules).toEqual(['brands', 'storefront'])
    const ceo = WORKSPACES.find((w) => w.id === 'ceo')!
    expect(ceo.sections.flatMap((s) => s.modules)).not.toContain('brands')
    expect(ceo.sections.flatMap((s) => s.modules)).toEqual(expect.arrayContaining(['tenants', 'onboarding', 'role_management', 'configuration']))
  })

  it('marketing and brand_manager hold it by default (and through the grant); management and owner do not', () => {
    expect(CEO_ONLY_MODULES).toEqual([])
    for (const r of ['admin', 'marketing', 'brand_manager'] as const) expect(DEFAULT_MODULE_ACCESS[r], r).toContain('brands')
    for (const r of ['management', 'owner', 'manager', 'hr', 'finance', 'fnb_manager'] as const) expect(DEFAULT_MODULE_ACCESS[r], r).not.toContain('brands')
    expect(MODULE_GRANTS).toContain('brands')
    expect(MODULE_GRANT_ROLES['brands']).toEqual(['marketing', 'brand_manager'])
  })

  it('GET /permissions/me: marketing has it under Marketing; management does not', async () => {
    const me = (await call(mktA, 'GET', '/permissions/me')).json()
    expect(me.modules).toContain('brands')
    const mws = (me.workspaces as Array<{ id: string; sections: Array<{ key: string; modules: string[] }> }>).find((w) => w.id === 'marketing')!
    expect(mws.sections.find((s) => s.key === 'brand')?.modules).toContain('brands')
    expect((await call(mgmtA, 'GET', '/permissions/me')).json().modules).not.toContain('brands')
  })
})

describe('the brand editor', () => {
  it('marketing and the brand manager edit brand info of their own company\'s brand', async () => {
    const r = await call(mktA, 'PATCH', `/concepts/${A.conceptId}?view=brand`, { description: 'Marketing copy', phone: '+92 300 0000000', cuisine: 'Pakistani' })
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json().brandEditorAccess).toBe('brand')
    expect((await prisma.concept.findUniqueOrThrow({ where: { id: A.conceptId } })).description).toBe('Marketing copy')
    expect((await call(brandMgrA, 'PATCH', `/concepts/${A.conceptId}`, { heroTagline: 'Slow food' })).statusCode).toBe(200)
    expect((await call(mktA, 'GET', '/concepts?view=brand')).statusCode).toBe(200)
  })

  it('a change to a CEO field by marketing is 403 BRAND_FIELD_CEO_ONLY; the same value in a full save passes', async () => {
    const before = await prisma.concept.findUniqueOrThrow({ where: { id: A.conceptId } })
    for (const body of [{ taxRateCash: before.taxRateCash + 1 }, { ntn: 'NTN-NEW' }, { isActive: false }, { serviceVessel: before.serviceVessel === 'plate' ? 'packaging' : 'plate' }, { primaryColor: '#123456' }, { srbPosId: 999 }]) {
      const r = await call(mktA, 'PATCH', `/concepts/${A.conceptId}`, body)
      expect(r.statusCode, JSON.stringify(body)).toBe(403)
      expect(r.json().error.code).toBe('BRAND_FIELD_CEO_ONLY')
    }
    const after = await prisma.concept.findUniqueOrThrow({ where: { id: A.conceptId } })
    expect({ ...after, updatedAt: null }).toEqual({ ...before, updatedAt: null })
    // The full form sends every field: unchanged CEO fields pass with the edit.
    const full = await call(mktA, 'PATCH', `/concepts/${A.conceptId}`, {
      description: 'Full save', taxRateCash: before.taxRateCash, taxRateCard: before.taxRateCard, isActive: before.isActive,
      serviceVessel: before.serviceVessel, ntn: before.ntn, strn: before.strn, province: before.province,
    })
    expect(full.statusCode, full.body).toBe(200)
  })

  it('management (no module) is refused; the CEO ticking it for that person opens the editor', async () => {
    expect((await call(mgmtA, 'PATCH', `/concepts/${A.conceptId}`, { description: 'x' })).json().error.code).toBe('BRAND_EDITOR_ONLY')
    await prisma.user.update({ where: { id: mgmtA.id }, data: { moduleAllow: ['brands'] } })
    invalidateModuleAccessCache()
    expect((await effectiveModulesForUser({ role: 'management', moduleAllow: ['brands'] })).has('brands')).toBe(true)
    expect((await call(mgmtA, 'PATCH', `/concepts/${A.conceptId}`, { description: 'Ticked by the CEO' })).statusCode).toBe(200)
    await prisma.user.update({ where: { id: mgmtA.id }, data: { moduleAllow: [] } })
    invalidateModuleAccessCache()
  })

  it('creating and deleting a brand stay the CEO\'s; company B gets 404', async () => {
    for (const who of [mktA, brandMgrA, mgmtA, ownerA]) {
      expect((await call(who, 'POST', '/concepts', { name: 'X', slug: `bco-x-${stamp}`, type: 'restaurant', serviceVessel: 'plate' })).statusCode).toBe(403)
    }
    const mktB = await mkUser('bco-mkt-b', 'marketing', B.tenantId)
    expect((await call(mktB, 'PATCH', `/concepts/${A.conceptId}`, { description: 'B on A' })).statusCode).toBe(404)
    expect((await call(ceoB, 'PATCH', `/concepts/${A.conceptId}`, { description: 'B on A' })).statusCode).toBe(404)
    const ok = await call(ceoA, 'PATCH', `/concepts/${A.conceptId}?view=brand`, { description: 'CEO edit', taxRateCash: 15 })
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json().brandEditorAccess).toBe('full')
  })

  it('reads other pages use are unchanged: the picker, the storefront view, management\'s list', async () => {
    expect((await call(mktA, 'GET', '/concepts?view=picker')).statusCode).toBe(200)
    expect((await call(mktA, 'GET', '/concepts?view=storefront')).statusCode).toBe(200)
    expect((await call(mgmtA, 'GET', '/concepts')).statusCode).toBe(200)
  })
})
