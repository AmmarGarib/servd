// Head-office reach (D1, spec §6 + amendments A1, A2, A3) — the lens, the
// submit / passthrough allow-lists and tenant scope, through the real auth
// middleware (attachStaffPrincipal) on Fastify inject.
//
// Fixtures create HeadOfficeLink rows directly (the /head-offices routes are
// another stream). Probe routes sit at the REAL route patterns of the allow-
// lists (under '/api/v1', so the prefix strip is exercised) and echo what the
// middleware and lib/tenantScope.ts resolved.
//
//   HO  (head office) ── live link ──▶ A (company), T (test company)
//   HO2 (head office) ── live link ──▶ C (company)        (another HO's company)
//   HO  ── bogus link ──▶ HO2 (a head office: never reached — no chaining)
//   B   (company, not linked)
//
//   hod     finance, member of HO only            → reaches A, T (lens)
//   proc    procurement, member of HO only        → reaches A, T
//   bMember management, member of B only          → no reach
//   bHod    finance, member of B and HO           → member B, reaches A, T
//   dual    finance, member of HO and A           → member A (not reach-only), via HO
//   ceo     admin, member of HO                   → reaches A, T
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import type { UserRole } from '@prisma/client'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession, } from '../src/modules/auth/service.js'
import { requireAuth } from '../src/modules/auth/middleware.js'
import { AppError } from '../src/lib/errors.js'
import { runWithRlsContext, getRlsContext } from '../src/lib/rlsContext.js'
import { resolveTenantScope, scopeTenantWhere, assertConceptOwned } from '../src/lib/tenantScope.js'
import { invalidateTestTenants } from '../src/lib/testCompany.js'
import {
  HO_SUBMIT_ROUTES, HO_PASSTHROUGH, isHoSubmitRoute, isHoPassthrough,
  viaHeadOfficeForSubmit, assertHoMayPropose, reachTenantIds, isReachOnly, viaHeadOffice,
} from '../src/lib/headOffice.js'
import { tenantRoutes } from '../src/modules/tenants/routes.js'
import { permissionRoutes } from '../src/modules/permissions/routes.js'

const P = `hor-${Date.now()}`
let app: FastifyInstance
let HO: string, HO2: string, A: string, B: string, C: string, T: string
let conceptA: string, conceptB: string
let linkA: string
const users: Record<string, { id: string; token: string }> = {}

async function tenant(name: string, kind: 'company' | 'head_office', isTest = false) {
  return (await prisma.tenant.create({ data: { name, slug: `${P}-${name.toLowerCase().replace(/\W+/g, '-')}`, kind, isTest } })).id
}

async function mkUser(key: string, role: UserRole, primary: string, members: string[]) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${P}@gsfoods.pk`, password: await bcrypt.hash('x-Password-1', 4), role, isActive: true, accountStatus: 'active', tenantId: primary },
  })
  for (const t of members) await prisma.tenantMember.create({ data: { tenantId: t, userId: u.id } })
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}

async function link(hoId: string, companyId: string) {
  return (await prisma.headOfficeLink.create({ data: { tenantId: hoId, companyTenantId: companyId, createdById: users.ceo?.id ?? 'seed' } })).id
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
function call(who: string, method: Method, url: string, opts: { lens?: string; portfolio?: boolean; payload?: unknown } = {}) {
  const headers: Record<string, string> = { authorization: `Bearer ${users[who]!.token}` }
  if (opts.lens) headers['x-servd-active-tenant'] = opts.lens
  if (opts.portfolio) headers['x-servd-portfolio'] = '1'
  return app.inject({ method, url: `/api/v1${url}`, headers, ...(opts.payload !== undefined ? { payload: opts.payload as never } : {}) })
}

/** Everything the middleware and tenantScope resolved for this request. */
async function echo(req: FastifyRequest) {
  const su = req.staffUser!
  const scope = await resolveTenantScope(req)
  return {
    tenantId: su.tenantId,
    tenantFilter: su.tenantFilter,
    memberTenantIds: [...su.memberTenantIds].sort(),
    reachTenantIds: [...su.reachTenantIds].sort(),
    viaHeadOfficeIds: su.viaHeadOfficeIds ?? null,
    submitTenantId: su.submitTenantId ?? null,
    rls: [...(getRlsContext()?.tenantIds ?? [])].sort(),
    readScope: [...scope.tenantIds].sort(),
    write: await scopeTenantWhere(req, 'write'),
    create: await scopeTenantWhere(req, 'create'),
  }
}

const sortIds = (...ids: string[]) => [...ids].sort()
const inIds = (f: unknown) => (f && typeof f === 'object' && 'in' in (f as object) ? [...(f as { in: string[] }).in].sort() : f)

beforeAll(async () => {
  HO = await tenant('GS Head Office', 'head_office')
  HO2 = await tenant('Other Head Office', 'head_office')
  A = await tenant('Company A', 'company')
  B = await tenant('Company B', 'company')
  C = await tenant('Company C', 'company')
  T = await tenant('Practice Co', 'company', true)
  invalidateTestTenants()
  conceptA = (await prisma.concept.create({ data: { name: 'A Cafe', slug: `${P}-a-cafe`, type: 'restaurant', tenantId: A } })).id
  conceptB = (await prisma.concept.create({ data: { name: 'B Cafe', slug: `${P}-b-cafe`, type: 'restaurant', tenantId: B } })).id

  await mkUser('ceo', 'admin', HO, [HO])
  await mkUser('hod', 'finance', HO, [HO])
  await mkUser('proc', 'procurement', HO, [HO])
  await mkUser('bMember', 'management', B, [B])
  await mkUser('bHod', 'finance', B, [B, HO])
  await mkUser('dual', 'finance', HO, [HO, A])
  await mkUser('plain', 'finance', B, [B, C])   // two companies, no head office at all

  linkA = await link(HO, A)
  await link(HO, T)
  await link(HO2, C)
  await link(HO, HO2)   // bogus: links only ever reach a company — never chains

  app = Fastify()
  app.addHook('onRequest', (_req, _reply, done) => { runWithRlsContext({}, () => done()) })
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR' } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(async (api) => {
    const auth = { preHandler: requireAuth() }
    api.get('/probe/scope', auth, echo)
    api.get('/procurement/lens-probe', auth, echo)          // module-gated: /procurement → procurement
    api.get<{ Params: { id: string } }>('/probe/concepts/:id', auth, async (req) => assertConceptOwned(req, req.params.id, 'read'))
    api.post<{ Params: { id: string } }>('/probe/concepts/:id', auth, async (req) => assertConceptOwned(req, req.params.id, 'read'))
    api.post('/recipes', auth, echo)                         // HO_SUBMIT_ROUTES
    api.put('/recipes/:id', auth, echo)                      // HO_SUBMIT_ROUTES
    api.post('/recipes/:id/approve', auth, echo)             // HO_PASSTHROUGH
    api.post('/auth/logout', auth, echo)                     // HO_PASSTHROUGH (personal)
    api.post('/stock-transfers', auth, echo)                 // removed from the submit list (A1)
    api.post('/probe/write', auth, echo)                     // an ordinary write
    await api.register(tenantRoutes, { prefix: '/tenants' })
    await api.register(permissionRoutes, { prefix: '/permissions' })
  }, { prefix: '/api/v1' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  await app?.close()
})

describe('lens reads', () => {
  it('a head-office member sees a reached company through the lens header (GET single)', async () => {
    const res = await call('hod', 'GET', '/probe/scope', { lens: A })
    expect(res.statusCode).toBe(200)
    const b = res.json()
    expect(b.tenantId).toBe(A)
    expect(b.tenantFilter).toBe(A)
    expect(b.viaHeadOfficeIds).toEqual([HO])
    expect(b.submitTenantId).toBeNull()
    expect(b.reachTenantIds).toEqual(sortIds(A, T))
    expect(b.rls).toEqual([A])
    expect(b.readScope).toEqual([A])
    // A read never widens what a write could touch.
    expect(b.write).toEqual({ tenantId: HO })
  })

  it("reads a reached company's row through the lens; without the header it is not in scope", async () => {
    expect((await call('hod', 'GET', `/probe/concepts/${conceptA}`, { lens: A })).statusCode).toBe(200)
    expect((await call('hod', 'GET', `/probe/concepts/${conceptA}`)).statusCode).toBe(404)
  })

  it('portfolio = members ∪ reach, minus test companies (a test company never appears in portfolio reach)', async () => {
    const b = (await call('hod', 'GET', '/probe/scope', { portfolio: true })).json()
    expect(inIds(b.tenantFilter)).toEqual(sortIds(HO, A))
    expect(b.rls).toEqual(sortIds(HO, A))
    expect(b.readScope).toEqual(sortIds(HO, A))
    expect(b.readScope).not.toContain(T)
    // Its own lens view still works (explicit pick).
    expect((await call('hod', 'GET', '/probe/scope', { lens: T })).json().tenantId).toBe(T)
  })

  it('stays within the caller\'s modules: the lens never widens Module Access', async () => {
    expect((await call('hod', 'GET', '/procurement/lens-probe', { lens: A })).statusCode).toBe(403)   // finance: no procurement
    expect((await call('proc', 'GET', '/procurement/lens-probe', { lens: A })).statusCode).toBe(200)
  })
})

describe('lens writes', () => {
  it('an unlisted write through the lens → 403 HEAD_OFFICE_SUBMIT_ONLY naming the company and head office', async () => {
    const res = await call('hod', 'POST', '/probe/write', { lens: A, payload: {} })
    expect(res.statusCode).toBe(403)
    expect(res.json().error.code).toBe('HEAD_OFFICE_SUBMIT_ONLY')
    expect(res.json().error.message).toContain('Company A')
    expect(res.json().error.message).toContain('GS Head Office')
  })

  it('a lens POST /stock-transfers → 403 (A1: not a head-office submit route)', async () => {
    const res = await call('hod', 'POST', '/stock-transfers', { lens: A, payload: {} })
    expect(res.statusCode).toBe(403)
    expect(res.json().error.code).toBe('HEAD_OFFICE_SUBMIT_ONLY')
  })

  it('a submit route binds to the lens company: create = A, write = members ∪ [A], RLS includes A', async () => {
    for (const [method, url] of [['POST', '/recipes'], ['PUT', '/recipes/r1']] as const) {
      const res = await call('hod', method, url, { lens: A, payload: {} })
      expect(res.statusCode).toBe(200)
      const b = res.json()
      expect(b.tenantId).toBe(A)
      expect(b.submitTenantId).toBe(A)
      expect(b.viaHeadOfficeIds).toEqual([HO])
      expect(b.create).toEqual({ tenantId: A })
      expect(inIds(b.write.tenantId)).toEqual(sortIds(HO, A))
      expect(inIds(b.tenantFilter)).toEqual(sortIds(HO, A))
      expect(b.rls).toEqual(sortIds(HO, A))
    }
  })

  it('a passthrough route ignores the lens header (personal + approve routes run as the caller\'s own company)', async () => {
    for (const url of ['/auth/logout', '/recipes/r1/approve']) {
      const res = await call('hod', 'POST', url, { lens: A, payload: {} })
      expect(res.statusCode).toBe(200)
      const b = res.json()
      expect(b.tenantId).toBe(HO)
      expect(b.submitTenantId).toBeNull()
      expect(b.create).toEqual({ tenantId: HO })
      expect(b.write).toEqual({ tenantId: HO })
      expect(b.rls).toEqual([HO])
    }
  })
})

describe('forged headers', () => {
  it('a member of B forging header = A: GET is ignored (404 on A\'s rows)', async () => {
    const res = await call('bMember', 'GET', `/probe/concepts/${conceptA}`, { lens: A })
    expect(res.statusCode).toBe(404)
    const b = (await call('bMember', 'GET', '/probe/scope', { lens: A })).json()
    expect(b.tenantId).toBe(B)
    expect(b.reachTenantIds).toEqual([])
  })

  it('no reach: a non-GET with a foreign header is ignored as today (lands in the caller\'s own company)', async () => {
    const res = await call('bMember', 'POST', '/probe/write', { lens: A, payload: {} })
    expect(res.statusCode).toBe(200)
    expect(res.json().tenantId).toBe(B)
    expect(res.json().create).toEqual({ tenantId: B })
  })

  it('with reach: a non-GET naming a company that is neither a member nor reached → 403 COMPANY_HEADER_NOT_ALLOWED', async () => {
    const res = await call('bHod', 'POST', '/probe/write', { lens: C, payload: {} })
    expect(res.statusCode).toBe(403)
    expect(res.json().error.code).toBe('COMPANY_HEADER_NOT_ALLOWED')
    // …but a personal route with a stale header still works.
    expect((await call('bHod', 'POST', '/auth/logout', { lens: C, payload: {} })).statusCode).toBe(200)
    // A member header is unchanged.
    expect((await call('bHod', 'POST', '/probe/write', { lens: B, payload: {} })).json().create).toEqual({ tenantId: B })
  })

  it('A2: a POST with x-servd-portfolio: 1 from a reach-only user cannot resolve a reached row through a read-mode lookup', async () => {
    const res = await call('hod', 'POST', `/probe/concepts/${conceptA}`, { portfolio: true, payload: {} })
    expect(res.statusCode).toBe(404)
    const b = (await call('hod', 'POST', '/recipes', { portfolio: true, payload: {} })).json()
    expect(b.readScope).toEqual([HO])
    expect(b.readScope).not.toContain(A)
    // Same for a member of B with reach: B's own row still resolves, A's does not.
    expect((await call('bHod', 'POST', `/probe/concepts/${conceptB}`, { portfolio: true, payload: {} })).statusCode).toBe(200)
    expect((await call('bHod', 'POST', `/probe/concepts/${conceptA}`, { portfolio: true, payload: {} })).statusCode).toBe(404)
  })
})

describe('reach limits', () => {
  it('reach never chains and never reaches another head office\'s companies', async () => {
    const b = (await call('hod', 'GET', '/probe/scope')).json()
    expect(b.reachTenantIds).toEqual(sortIds(A, T))
    expect(b.reachTenantIds).not.toContain(C)
    expect(b.reachTenantIds).not.toContain(HO2)
    // A header naming HO2's company is not a lens: ignored on GET…
    expect((await call('hod', 'GET', '/probe/scope', { lens: C })).json().tenantId).toBe(HO)
    expect((await call('hod', 'GET', `/probe/concepts/${conceptB}`, { lens: B })).statusCode).toBe(404)
  })

  it('/tenants/switch to a reached company → 403 NOT_A_MEMBER (with or without the lens header)', async () => {
    const r1 = await call('hod', 'POST', `/tenants/switch/${A}`, { payload: {} })
    expect(r1.statusCode).toBe(403)
    expect(r1.json().error.code).toBe('NOT_A_MEMBER')
    const r2 = await call('hod', 'POST', `/tenants/switch/${A}`, { lens: A, payload: {} })
    expect(r2.statusCode).toBe(403)
    expect(r2.json().error.code).toBe('NOT_A_MEMBER')
    expect((await prisma.user.findUniqueOrThrow({ where: { id: users.hod!.id } })).tenantId).toBe(HO)
  })

  it('no TenantMember rows are ever created by reach', async () => {
    expect(await prisma.tenantMember.count({ where: { userId: users.hod!.id } })).toBe(1)
    expect(await prisma.tenantMember.count({ where: { tenantId: { in: [A, T] }, userId: { in: [users.hod!.id, users.proc!.id, users.bHod!.id, users.ceo!.id] } } })).toBe(0)
  })

  it('a caller with no head office is exactly as before (empty reach, members-only scopes)', async () => {
    const g = (await call('plain', 'GET', '/probe/scope', { portfolio: true })).json()
    expect(g.reachTenantIds).toEqual([])
    expect(inIds(g.tenantFilter)).toEqual(sortIds(B, C))
    const w = (await call('plain', 'POST', '/probe/write', { payload: {} })).json()
    expect(inIds(w.tenantFilter)).toEqual(sortIds(B, C))
    expect(inIds(w.write.tenantId)).toEqual(sortIds(B, C))
    expect(w.create).toEqual({ tenantId: B })
  })

  it('GET /permissions/me carries headOffices, reach (with via), delegations and headOfficeSetupApplied', async () => {
    const me = (await call('hod', 'GET', '/permissions/me')).json()
    expect(me.headOffices).toEqual([{ id: HO, name: 'GS Head Office' }])
    expect(me.reach.map((r: { companyId: string }) => r.companyId).sort()).toEqual(sortIds(A, T))
    expect(me.reach.find((r: { companyId: string }) => r.companyId === A)).toEqual({ companyId: A, name: 'Company A', via: [{ id: HO, name: 'GS Head Office' }] })
    expect(Array.isArray(me.delegations)).toBe(true)
    expect(me.headOfficeSetupApplied).toBe(false)
    const plain = (await call('plain', 'GET', '/permissions/me')).json()
    expect(plain.headOffices).toEqual([])
    expect(plain.reach).toEqual([])
  })

  it('unlinking ends reach on the very next request', async () => {
    await prisma.headOfficeLink.update({ where: { id: linkA }, data: { endedAt: new Date() } })
    const b = (await call('hod', 'GET', '/probe/scope', { lens: A })).json()
    expect(b.tenantId).toBe(HO)                 // header ignored: no longer a lens
    expect(b.reachTenantIds).toEqual([T])
    expect((await call('hod', 'GET', `/probe/concepts/${conceptA}`, { lens: A })).statusCode).toBe(404)
    linkA = await link(HO, A)                  // re-link (a new row) for the helper tests below
  })
})

describe('request helpers (lib/headOffice.ts)', () => {
  // Run a helper inside a real authenticated request.
  async function inRequest<T>(who: string, lens: string | undefined, fn: (req: FastifyRequest) => Promise<T> | T): Promise<{ status: number; body: T }> {
    const a = Fastify()
    a.addHook('onRequest', (_req, _reply, done) => { runWithRlsContext({}, () => done()) })
    a.setErrorHandler((err, _req, reply) => reply.status((err as AppError).statusCode ?? 500).send({ code: (err as AppError).code }))
    a.post('/probe/write', { preHandler: requireAuth() }, async (req) => ({ v: await fn(req) }))
    a.get('/probe/read', { preHandler: requireAuth() }, async (req) => ({ v: await fn(req) }))
    await a.ready()
    const res = await a.inject({ method: 'GET', url: '/probe/read', headers: { authorization: `Bearer ${users[who]!.token}`, ...(lens ? { 'x-servd-active-tenant': lens } : {}) } })
    await a.close()
    return { status: res.statusCode, body: (res.json() as { v: T }).v }
  }

  it('reachTenantIds / isReachOnly / viaHeadOffice read the middleware\'s result', async () => {
    const r = await inRequest('hod', A, (req) => ({ reach: reachTenantIds(req).sort(), onlyA: isReachOnly(req, A), onlyHO: isReachOnly(req, HO), via: viaHeadOffice(req, A), viaB: viaHeadOffice(req, B) }))
    expect(r.body).toEqual({ reach: sortIds(A, T), onlyA: true, onlyHO: false, via: HO, viaB: null })
    // A dual member (HO + A) is not reach-only in A, but A is still served through HO.
    const d = await inRequest('dual', undefined, (req) => ({ onlyA: isReachOnly(req, A), via: viaHeadOffice(req, A), reach: reachTenantIds(req) }))
    expect(d.body).toEqual({ onlyA: false, via: HO, reach: [T] })
  })

  it('viaHeadOfficeForSubmit (A3): the HO for a non-admin HO member — dual members included; never the CEO; null when unlinked', async () => {
    expect((await inRequest('hod', undefined, (req) => viaHeadOfficeForSubmit(req, A))).body).toBe(HO)
    expect((await inRequest('dual', undefined, (req) => viaHeadOfficeForSubmit(req, A))).body).toBe(HO)
    expect((await inRequest('ceo', undefined, (req) => viaHeadOfficeForSubmit(req, A))).body).toBeNull()
    expect((await inRequest('bMember', undefined, (req) => viaHeadOfficeForSubmit(req, B))).body).toBeNull()
    expect((await inRequest('hod', undefined, (req) => viaHeadOfficeForSubmit(req, C))).body).toBeNull()   // another HO's company
  })

  it('assertHoMayPropose refuses only a reach-only caller whose action is not a proposal', async () => {
    const run = (who: string, company: string, ok: boolean) =>
      inRequest(who, undefined, async (req) => { await assertHoMayPropose(req, company, ok, 'Approving a PO'); return 'ok' })
    expect((await run('hod', A, false)).status).toBe(403)
    expect((await run('hod', A, true)).status).toBe(200)
    expect((await run('dual', A, false)).status).toBe(200)       // a member of A: the route's own rules apply
    expect((await run('bMember', B, false)).status).toBe(200)
  })
})

describe('allow-lists match registered routes', () => {
  // Routes another stream adds in wave 2 (or later): an entry for them is a
  // .todo until the route exists, then the collector checks it.
  const LATER = [
    /^\/accounting\/journal-requests/,
    /^\/connectors\/(:kind\/)?change-requests/,
    /^\/head-offices\//,
    /^\/approvals\//,
  ]
  let registered: Array<{ method: string; path: string }> = []

  beforeAll(async () => {
    const mods: Array<[string, string, string]> = [
      ['procurement/routes.js', 'procurementRoutes', '/procurement'],
      ['recipes/routes.js', 'recipeRoutes', '/recipes'],
      ['hr/routes.js', 'hrRoutes', '/hr'],
      ['auth/routes.js', 'authRoutes', '/auth'],
      ['tenants/routes.js', 'tenantRoutes', '/tenants'],
      ['siteLayouts/routes.js', 'siteLayoutRoutes', '/site-layouts'],
      ['stockTransfers/routes.js', 'stockTransferRoutes', '/stock-transfers'],
      ['tipPools/routes.js', 'tipPoolRoutes', '/tip-pools'],
      ['notifications/routes.js', 'notificationRoutes', '/notifications'],
      ['timeclock/routes.js', 'timeClockRoutes', '/time-clock'],
      ['intercompany/routes.js', 'intercompanyRoutes', '/accounting/intercompany'],
      ['accounting/routes.js', 'accountingRoutes', '/accounting'],
      ['connectors/routes.js', 'connectorRoutes', '/connectors'],
    ]
    const a = Fastify()
    a.addHook('onRoute', (r) => {
      const ms = Array.isArray(r.method) ? r.method : [r.method]
      for (const m of ms) registered.push({ method: String(m).toUpperCase(), path: r.url.length > 1 ? r.url.replace(/\/$/, '') : r.url })
    })
    await a.register(async (api) => {
      for (const [file, name, prefix] of mods) {
        const mod = await import(`../src/modules/${file}`) as Record<string, Parameters<typeof api.register>[0]>
        await api.register(mod[name]!, { prefix })
      }
      const ap = await import('../src/modules/approvals/index.js')
      await ap.registerApprovalsPlugin(api as never)
    }, { prefix: '/api/v1' })
    await a.ready()
    await a.close()
    registered = registered.map((r) => ({ method: r.method, path: r.path.replace(/^\/api\/v1/, '') }))
  }, 60_000)

  const check = (e: { method: string; path: string }) => {
    if (e.path.endsWith('/*')) {
      const base = e.path.slice(0, -2)
      return registered.some((r) => r.path.startsWith(base + '/'))
    }
    return registered.some((r) => r.method === e.method && r.path === e.path)
  }

  for (const [listName, list] of [['HO_SUBMIT_ROUTES', HO_SUBMIT_ROUTES], ['HO_PASSTHROUGH', HO_PASSTHROUGH]] as const) {
    for (const e of list) {
      const title = `${listName}: ${e.method} ${e.path}`
      if (LATER.some((re) => re.test(e.path))) it.todo(`${title} (route added in wave 2)`)
      else it(title, () => { expect(check(e)).toBe(true) })
    }
  }

  it('POST /stock-transfers is NOT a submit route (A1); the matchers strip nothing they should not', () => {
    expect(isHoSubmitRoute('POST', '/stock-transfers')).toBe(false)
    expect(isHoSubmitRoute('POST', '/recipes')).toBe(true)
    expect(isHoSubmitRoute('GET', '/recipes')).toBe(false)
    expect(isHoPassthrough('POST', '/accounting/intercompany/transfers/:id/approve')).toBe(true)
    expect(isHoPassthrough('POST', '/accounting/intercompanyX')).toBe(false)
    expect(isHoPassthrough('POST', null)).toBe(false)
    // The two lists never overlap.
    for (const e of HO_SUBMIT_ROUTES) expect(isHoPassthrough(e.method, e.path)).toBe(false)
  })
})
