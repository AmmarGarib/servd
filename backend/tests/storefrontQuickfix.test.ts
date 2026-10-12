// Storefront "doesn't work" quick fixes (map-storefront-bug, option A):
//  - Marketing (any role holding the 'storefront' module) can READ its own
//    companies' brands through the Storefront editor's list —
//    GET /concepts?view=storefront and GET /concepts/:id?view=storefront,
//    narrow fields, active only — so the Pages tab, Library brand picker and
//    pop-up brand targeting are no longer empty. Never another company's
//    brands; no write widening. Plain GET /concepts stays 403 for them
//    (SFQ-RV-2): the Brand Editor (/marketing/brands) fills its whole form
//    from it, and a narrow row there reads as a wiped brand.
//  - With no R2 account the presigned upload host is
//    `<bucket>.undefined.r2.cloudflarestorage.com` (SFQ-RV-1) — the shape the
//    Library's "storage not configured" guard keys on.
//  - Discard draft (DELETE /site-layouts/:slug/draft, sent by the admin with
//    Content-Type: application/json and no body) reaches the route.
//
// Drives the real route handlers through Fastify inject against the
// disposable test database (DATABASE_URL must contain "test").
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'

const { serviceClient: prisma } = await import('../src/lib/prisma.js')
const { issueStaffSession } = await import('../src/modules/auth/service.js')
const { AppError } = await import('../src/lib/errors.js')
const { conceptRoutes } = await import('../src/modules/concepts/routes.js')
const { siteLayoutRoutes } = await import('../src/modules/siteLayouts/routes.js')
const { registerEmptyJsonBody } = await import('../src/lib/jsonBody.js')
const { invalidateModuleAccessCache } = await import('../src/lib/moduleAccess.js')

const PREFIX = 'sfq'
const STAMP = Date.now()
let app: FastifyInstance
let bare: FastifyInstance
let tenantA = ''
let tenantB = ''
let brandA = ''
let brandA2 = ''
let brandAOff = ''
let brandB = ''
const slugs: string[] = []
type U = { id: string; name: string; email: string; role: string }
const users: Record<string, U> = {}
const userIds: string[] = []

async function makeUser(label: string, role: string, primary: string, memberOf: string[], extra: { moduleDeny?: string[] } = {}): Promise<U> {
  const u = await prisma.user.create({
    data: {
      name: `${PREFIX} ${label}`,
      email: `${PREFIX}.${label}.${STAMP}@gsfoods.pk`,
      password: await bcrypt.hash('NotUsedInThisTest123', 4),
      role: role as never,
      tenantId: primary,
      isActive: true,
      accountStatus: 'active',
      ...(extra.moduleDeny ? { moduleDeny: extra.moduleDeny } : {}),
      tenantMemberships: { create: memberOf.map((t) => ({ tenant: { connect: { id: t } }, role: 'member' })) },
    },
    select: { id: true, name: true, email: true, role: true },
  })
  userIds.push(u.id)
  return u as U
}

function auth(u: U) {
  const s = issueStaffSession({ id: u.id, name: u.name, email: u.email, role: u.role as never })
  return { authorization: `Bearer ${s.accessToken}` }
}

async function makeBrand(label: string, tenantId: string, isActive = true): Promise<string> {
  const slug = `${PREFIX}-${label}-${STAMP}`
  slugs.push(slug)
  const c = await prisma.concept.create({
    data: { name: `SFQ ${label}`, slug, type: 'restaurant', tenantId, isActive, primaryColor: '#7C2946', logoUrl: 'https://media.example/logo.png', taxRate: 17 },
  })
  return c.id
}

function buildApp(withHook: boolean): FastifyInstance {
  const a = Fastify()
  if (withHook) registerEmptyJsonBody(a)
  a.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', details: err.issues } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    if (status >= 500) console.error('[storefrontQuickfix] 500:', err)
    return reply.status(status).send({ error: { code: (err as { code?: string }).code ?? 'ERR', message: String((err as Error).message) } })
  })
  return a
}

beforeAll(async () => {
  invalidateModuleAccessCache()
  tenantA = (await prisma.tenant.create({ data: { name: 'SFQ Co A', slug: `${PREFIX}-a-${STAMP}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'SFQ Co B', slug: `${PREFIX}-b-${STAMP}` } })).id
  brandA = await makeBrand('a1', tenantA)
  brandA2 = await makeBrand('a2', tenantA)
  brandAOff = await makeBrand('a-off', tenantA, false)
  brandB = await makeBrand('b1', tenantB)

  users.mktA = await makeUser('mkta', 'marketing', tenantA, [tenantA])
  users.mktB = await makeUser('mktb', 'marketing', tenantB, [tenantB])
  users.bmA = await makeUser('bma', 'brand_manager', tenantA, [tenantA])
  users.finA = await makeUser('fina', 'finance', tenantA, [tenantA])
  users.mktDenied = await makeUser('mktdeny', 'marketing', tenantA, [tenantA], { moduleDeny: ['storefront'] })
  users.mgmtA = await makeUser('mgmta', 'management', tenantA, [tenantA])

  app = buildApp(true)
  await app.register(async (api) => {
    await api.register(conceptRoutes, { prefix: '/concepts' })
    await api.register(siteLayoutRoutes, { prefix: '/site-layouts' })
  }, { prefix: '/api/v1' })
  await app.ready()

  bare = buildApp(false)
  await bare.register(async (api) => {
    await api.register(siteLayoutRoutes, { prefix: '/site-layouts' })
  }, { prefix: '/api/v1' })
  await bare.ready()
}, 60_000)

afterAll(async () => {
  await app?.close()
  await bare?.close()
  if (!tenantA || !tenantB) return
  await prisma.siteLayout.deleteMany({ where: { tenantId: { in: [tenantA, tenantB] } } })
  await prisma.auditLog.deleteMany({ where: { userId: { in: userIds } } })
  await prisma.tenantMember.deleteMany({ where: { userId: { in: userIds } } })
  await prisma.user.deleteMany({ where: { id: { in: userIds } } })
  await prisma.concept.deleteMany({ where: { slug: { in: slugs } } })
  await prisma.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } })
})

const get = (url: string, u: U) => app.inject({ method: 'GET', url: `/api/v1/concepts${url}`, headers: auth(u) })
// The Storefront editor's list (frontend/admin/src/lib/content.ts contentApi.brands).
const sf = (path: string, u: U, extra = '') => get(`${path}?view=storefront${extra}`, u)
const NARROW_KEYS = ['id', 'isActive', 'logoUrl', 'name', 'primaryColor', 'slug', 'tenantId']

describe('GET /concepts for Storefront editors', () => {
  it("marketing lists its own company's active brands, narrow fields only", async () => {
    const r = await sf('', users.mktA!)
    expect(r.statusCode).toBe(200)
    const rows = r.json() as Array<Record<string, unknown>>
    const ids = rows.map((c) => c.id)
    expect(ids).toContain(brandA)
    expect(ids).toContain(brandA2)
    expect(ids).not.toContain(brandAOff)
    expect(ids).not.toContain(brandB)
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(NARROW_KEYS)
    expect(rows.find((c) => c.id === brandA)).toMatchObject({ primaryColor: '#7C2946', logoUrl: 'https://media.example/logo.png', tenantId: tenantA })
  })

  it('company B sees only its own brands', async () => {
    const r = await sf('', users.mktB!)
    expect(r.statusCode).toBe(200)
    const ids = (r.json() as Array<{ id: string }>).map((c) => c.id)
    expect(ids).toContain(brandB)
    expect(ids).not.toContain(brandA)
    expect(ids).not.toContain(brandA2)
  })

  it('includeInactive does not widen a Storefront editor', async () => {
    const r = await sf('', users.mktA!, '&includeInactive=1')
    expect(r.statusCode).toBe(200)
    expect((r.json() as Array<{ id: string }>).map((c) => c.id)).not.toContain(brandAOff)
  })

  it('brand_manager (also holds storefront) gets the same narrow list', async () => {
    const r = await sf('', users.bmA!)
    expect(r.statusCode).toBe(200)
    const rows = r.json() as Array<Record<string, unknown>>
    expect(rows.map((c) => c.id)).toContain(brandA)
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(NARROW_KEYS)
  })

  it('a role without the storefront module stays 403', async () => {
    expect((await sf('', users.finA!)).statusCode).toBe(403)
    expect((await sf(`/${brandA}`, users.finA!)).statusCode).toBe(403)
    expect((await get('', users.finA!)).statusCode).toBe(403)
  })

  it('a marketer whose storefront module is denied is 403', async () => {
    expect((await sf('', users.mktDenied!)).statusCode).toBe(403)
  })

  it("GET /concepts/:id — own brand narrow, other company's brand 404, retired brand 404", async () => {
    const own = await sf(`/${brandA}`, users.mktA!)
    expect(own.statusCode).toBe(200)
    expect(Object.keys(own.json()).sort()).toEqual(NARROW_KEYS)
    expect((await sf(`/${brandB}`, users.mktA!)).statusCode).toBe(404)
    expect((await sf(`/${brandA}`, users.mktB!)).statusCode).toBe(404)
    expect((await sf(`/${brandAOff}`, users.mktA!)).statusCode).toBe(404)
  })

  it('plain GET /concepts (the Brand Editor) stays 403 for Storefront-only roles — no narrow row there', async () => {
    for (const u of [users.mktA!, users.bmA!]) {
      expect((await get('', u)).statusCode).toBe(403)
      expect((await get('?includeInactive=1', u)).statusCode).toBe(403)
      expect((await get(`/${brandA}`, u)).statusCode).toBe(403)
    }
  })

  it('management gets the narrow Storefront list too, scoped to its company', async () => {
    const r = await sf('', users.mgmtA!)
    expect(r.statusCode).toBe(200)
    const rows = r.json() as Array<Record<string, unknown>>
    expect(rows.map((c) => c.id)).toContain(brandA)
    expect(rows.map((c) => c.id)).not.toContain(brandB)
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(NARROW_KEYS)
  })

  it('management still gets the full row', async () => {
    const r = await get(`/${brandA}`, users.mgmtA!)
    expect(r.statusCode).toBe(200)
    expect(r.json()).toHaveProperty('taxRate', 17)
    expect(r.json()).toHaveProperty('taxRateCash')
  })

  it('no write widening: marketing cannot create, edit or delete a brand', async () => {
    const h = auth(users.mktA!)
    const post = await app.inject({ method: 'POST', url: '/api/v1/concepts', headers: h, payload: { name: 'X', slug: `${PREFIX}-x-${STAMP}`, type: 'restaurant' } })
    expect(post.statusCode).toBe(403)
    const patch = await app.inject({ method: 'PATCH', url: `/api/v1/concepts/${brandA}`, headers: h, payload: { name: 'Hijacked' } })
    expect(patch.statusCode).toBe(403)
    const del = await app.inject({ method: 'DELETE', url: `/api/v1/concepts/${brandA}`, headers: { ...h, 'content-type': 'application/json' } })
    expect(del.statusCode).toBe(403)
    expect((await prisma.concept.findUniqueOrThrow({ where: { id: brandA } })).name).toBe('SFQ a1')
  })
})

describe('Discard draft with the admin client headers', () => {
  const slug = () => `brand:${slugs[0]}:about`
  const url = () => `/api/v1/site-layouts/${encodeURIComponent(slug())}/draft`

  it('without the empty-JSON hook Fastify refuses the DELETE (the bug)', async () => {
    const r = await bare.inject({ method: 'DELETE', url: url(), headers: { ...auth(users.mktA!), 'content-type': 'application/json' } })
    expect(r.statusCode).toBe(400)
    expect(r.json().error.code).toBe('FST_ERR_CTP_EMPTY_JSON_BODY')
  })

  it('with it, the DELETE reaches the route and discards the draft (204)', async () => {
    const h = auth(users.mktA!)
    const put = await app.inject({ method: 'PUT', url: url(), headers: h, payload: { blocks: [{ id: 'b1', type: 'text', body: 'hello' }] } })
    expect(put.statusCode).toBe(200)
    const del = await app.inject({ method: 'DELETE', url: url(), headers: { ...h, 'content-type': 'application/json' } })
    expect(del.statusCode).toBe(204)
    // Never published, so the row is gone.
    expect(await prisma.siteLayout.findUnique({ where: { slug: slug() } })).toBeNull()
  })

  it("company B can't discard company A's draft (404)", async () => {
    const put = await app.inject({ method: 'PUT', url: url(), headers: auth(users.mktA!), payload: { blocks: [{ id: 'b1', type: 'text', body: 'again' }] } })
    expect(put.statusCode).toBe(200)
    const del = await app.inject({ method: 'DELETE', url: url(), headers: { ...auth(users.mktB!), 'content-type': 'application/json' } })
    expect(del.statusCode).toBe(404)
    expect(await prisma.siteLayout.findUnique({ where: { slug: slug() } })).not.toBeNull()
  })
})

describe('Upload URL signed with no R2 account (SFQ-RV-1)', () => {
  // Same pattern as presignedWithoutAccount() in
  // frontend/admin/src/components/storefront/LibraryPanel.tsx.
  const NO_ACCOUNT_HOST = /(^|\.)(undefined|null)\.r2\.cloudflarestorage\.com$/i

  it("the presigner puts the bucket in front: <bucket>.undefined.r2.cloudflarestorage.com, which the Library's guard matches", async () => {
    // storage.ts reads the R2 env when it loads: clear it, load it fresh.
    const KEYS = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_PUBLIC_URL', 'R2_BUCKET_NAME']
    const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
    for (const k of KEYS) delete process.env[k]
    vi.resetModules()
    try {
      const { getSignedUploadUrl } = await import('../src/lib/storage.js')
      const { uploadUrl } = await getSignedUploadUrl('a.png', 'image/png', 'marketing')
      const host = new URL(uploadUrl).hostname
      expect(host).toBe('servd-media.undefined.r2.cloudflarestorage.com')
      expect(NO_ACCOUNT_HOST.test(host)).toBe(true)
      // The old pattern missed it.
      expect(/^(undefined|null)?\.?r2\.cloudflarestorage\.com$/i.test(host)).toBe(false)
    } finally {
      for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
      vi.resetModules()
    }
  })

  it('a configured account is not flagged', () => {
    expect(NO_ACCOUNT_HOST.test('servd-media.abc123.r2.cloudflarestorage.com')).toBe(false)
    expect(NO_ACCOUNT_HOST.test('notundefined.r2.cloudflarestorage.com')).toBe(false)
    expect(NO_ACCOUNT_HOST.test('undefined.r2.cloudflarestorage.com')).toBe(true)
  })
})
