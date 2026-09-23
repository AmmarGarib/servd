// The global brand filter.
//
// The property that matters most is the honest one: a page must only be
// reported as brand-filtered if the brand was actually used. "Simmer" in the
// header over every brand's numbers is worse than no filter at all.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { registerBrandScope } from '../src/lib/brandScope.js'
import { conceptIdsInScope } from '../src/lib/tenantScope.js'

const BRAND = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
let app: FastifyInstance

beforeAll(async () => {
  app = Fastify()
  registerBrandScope(app)
  app.get('/reads', async (req) => ({ conceptId: (req.query as { conceptId?: string }).conceptId ?? null }))
  app.get('/ignores', async () => ({ ok: true }))
  app.post('/writes', async (req) => ({ conceptId: (req.query as { conceptId?: string }).conceptId ?? null }))
  await app.ready()
})
afterAll(async () => { await app.close() })

const get = (url: string, brand?: string) =>
  app.inject({ method: 'GET', url, headers: brand ? { 'x-servd-brand': brand } : {} })

describe('brand filter via the default conceptId', () => {
  it('becomes the conceptId for a route that reads one, and says so', async () => {
    const r = await get('/reads', BRAND)
    expect(r.json().conceptId).toBe(BRAND)
    expect(r.headers['x-servd-brand-applied']).toBe('1')
  })

  it('does NOT claim to be applied on a route that ignores it', async () => {
    const r = await get('/ignores', BRAND)
    expect(r.headers['x-servd-brand-applied']).toBeUndefined()
  })

  it("lets a page's own brand choice win", async () => {
    const r = await get(`/reads?conceptId=${OTHER}`, BRAND)
    expect(r.json().conceptId).toBe(OTHER)
  })

  it('never touches writes', async () => {
    const r = await app.inject({ method: 'POST', url: '/writes', headers: { 'x-servd-brand': BRAND } })
    expect(r.json().conceptId).toBeNull()
  })

  it('ignores a malformed header', async () => {
    const r = await get('/reads', "x' OR 1=1")
    expect(r.json().conceptId).toBeNull()
  })

  it('does nothing when no brand is picked', async () => {
    const r = await get('/reads')
    expect(r.json().conceptId).toBeNull()
    expect(r.headers['x-servd-brand-applied']).toBeUndefined()
  })
})

describe('brand filter via the scope helper', () => {
  let tenantId: string, a: string, b: string
  beforeAll(async () => {
    tenantId = (await prisma.tenant.create({ data: { name: 'Brand Scope Co', slug: 'brand-scope-co' } })).id
    a = (await prisma.concept.create({ data: { name: 'A', slug: 'bs-a', tenantId, type: 'restaurant' } })).id
    b = (await prisma.concept.create({ data: { name: 'B', slug: 'bs-b', tenantId, type: 'restaurant' } })).id
  })
  afterAll(async () => {
    await prisma.concept.deleteMany({ where: { tenantId } })
    await prisma.tenant.deleteMany({ where: { id: tenantId } })
  })
  const fakeReq = (brand: string | null, method = 'GET') => ({
    method,
    headers: brand ? { 'x-servd-brand': brand } : {},
    staffUser: { id: 'u', tenantId, memberTenantIds: [tenantId] },
  }) as unknown as FastifyRequest

  it('narrows reads to the picked brand', async () => {
    expect(await conceptIdsInScope(fakeReq(a))).toEqual([a])
  })

  it('ignores a brand from another company instead of emptying the page', async () => {
    expect((await conceptIdsInScope(fakeReq(OTHER))).sort()).toEqual([a, b].sort())
  })

  it('does not narrow writes', async () => {
    expect((await conceptIdsInScope(fakeReq(a, 'POST'), 'write')).sort()).toEqual([a, b].sort())
  })
})
