// The brand's public profiles (SEO round 1, owner 2026-10-14):
// Concept.sameAs (https profile URLs, ≤ 12) + Concept.googleMapsUrl, edited in
// CEO → Brands (CEO only since 2026-10-14).
//
// What this guards (two companies):
//   - company A's CEO saves A's links; blanks and repeats are dropped, ''
//     clears the Maps link; the write is audited; marketing / management 403;
//   - company B's CEO cannot set A's links → 404 (B's marketing 403);
//   - a link that is not https (http:, javascript:, a bare word, credentials)
//     or more than 12 links → 422 INVALID_PROFILE_LINK, nothing changes;
//   - POST /concepts with links binds the brand to the ACTIVE company;
//   - the public payloads (/storefront/concepts, /storefront/:slug/menu)
//     carry both fields.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { prisma, mkCompany, mkUser, type Company, type Who } from './connectorsFixtures.js'
import { AppError, errorResponse } from '../src/lib/errors.js'
import { conceptRoutes } from '../src/modules/concepts/routes.js'
import { storefrontRoutes } from '../src/modules/storefront/routes.js'

let app: FastifyInstance
let A: Company
let B: Company
let ceoA: Who
let mgrA: Who
let mktA: Who
let ceoB: Who
let mktB: Who
const stamp = Date.now()

const call = (who: Who, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url, ...(payload !== undefined && { payload: payload as Record<string, unknown> }), headers: { authorization: `Bearer ${who.token}` } })

const links = (id: string) => prisma.concept.findUniqueOrThrow({ where: { id }, select: { sameAs: true, googleMapsUrl: true } })

beforeAll(async () => {
  A = await mkCompany(`pl-a-${stamp}`)
  B = await mkCompany(`pl-b-${stamp}`)
  ceoA = await mkUser('pl-ceo-a', 'admin', A.tenantId)
  mgrA = await mkUser('pl-mgr-a', 'manager', A.tenantId)
  mktA = await mkUser('pl-mkt-a', 'marketing', A.tenantId)
  ceoB = await mkUser('pl-ceo-b', 'admin', B.tenantId)
  mktB = await mkUser('pl-mkt-b', 'marketing', B.tenantId)
  app = Fastify()
  // The production handler's shapes: AppError as-is, ZodError 400.
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode
    if (status && status >= 400 && status < 500) return reply.status(status).send({ error: { code: 'BAD_REQUEST', message: (err as Error).message } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(conceptRoutes, { prefix: '/concepts' })
  await app.register(storefrontRoutes, { prefix: '/storefront' })
  await app.ready()
}, 60_000)

afterAll(async () => { await app?.close() })

describe('company A edits its own brand profiles (CEO → Brands, CEO only)', () => {
  it('the CEO saves them (cleaned) and the change is audited on the brand\'s company', async () => {
    const r = await call(ceoA, 'PATCH', `/concepts/${A.conceptId}`, {
      sameAs: [' https://instagram.com/brand_a ', '', 'https://facebook.com/branda', 'https://instagram.com/brand_a'],
      googleMapsUrl: 'https://maps.app.goo.gl/abc123',
    })
    expect(r.statusCode).toBe(200)
    expect(r.json().sameAs).toEqual(['https://instagram.com/brand_a', 'https://facebook.com/branda'])
    expect(await links(A.conceptId)).toEqual({
      sameAs: ['https://instagram.com/brand_a', 'https://facebook.com/branda'],
      googleMapsUrl: 'https://maps.app.goo.gl/abc123',
    })
    const log = await prisma.auditLog.findFirst({
      where: { action: 'concept.update', entityId: A.conceptId },
      orderBy: { createdAt: 'desc' },
    })
    expect(log?.tenantId).toBe(A.tenantId)
  })

  it('the brand editor read (?view=brand) returns them to the CEO', async () => {
    const r = await call(ceoA, 'GET', `/concepts/${A.conceptId}?view=brand`)
    expect(r.statusCode).toBe(200)
    expect(r.json().sameAs).toHaveLength(2)
    expect(r.json().googleMapsUrl).toBe('https://maps.app.goo.gl/abc123')
  })

  it('an empty Maps link clears it', async () => {
    const r = await call(ceoA, 'PATCH', `/concepts/${A.conceptId}`, {
      sameAs: ['https://www.tiktok.com/@branda'], googleMapsUrl: '',
    })
    expect(r.statusCode).toBe(200)
    expect(await links(A.conceptId)).toEqual({ sameAs: ['https://www.tiktok.com/@branda'], googleMapsUrl: null })
  })

  it('marketing and management are refused (403 BRAND_CEO_ONLY), nothing applied', async () => {
    for (const who of [mktA, mgrA]) {
      const r = await call(who, 'PATCH', `/concepts/${A.conceptId}`, { sameAs: ['https://x.com/branda'] })
      expect(r.statusCode).toBe(403)
      expect(r.json().error.code).toBe('BRAND_CEO_ONLY')
      expect((await call(who, 'GET', `/concepts/${A.conceptId}?view=brand`)).statusCode).toBe(403)
    }
    expect((await links(A.conceptId)).sameAs).toEqual(['https://www.tiktok.com/@branda'])
  })
})

describe('company B cannot set A\'s links', () => {
  it('B\'s CEO → 404, nothing changes', async () => {
    const before = await links(A.conceptId)
    const r = await call(ceoB, 'PATCH', `/concepts/${A.conceptId}`, { sameAs: ['https://instagram.com/hijack'], googleMapsUrl: 'https://maps.app.goo.gl/hijack' })
    expect(r.statusCode).toBe(404)
    expect(await links(A.conceptId)).toEqual(before)
  })

  it('B\'s marketing → 403 (never the editor), nothing changes', async () => {
    const before = await links(A.conceptId)
    const r = await call(mktB, 'PATCH', `/concepts/${A.conceptId}`, { sameAs: ['https://instagram.com/hijack'] })
    expect(r.statusCode).toBe(403)
    expect(await links(A.conceptId)).toEqual(before)
  })

  it('B\'s CEO saves on B\'s own brand', async () => {
    const r = await call(ceoB, 'PATCH', `/concepts/${B.conceptId}`, { sameAs: ['https://instagram.com/brand_b'] })
    expect(r.statusCode).toBe(200)
    expect((await links(B.conceptId)).sameAs).toEqual(['https://instagram.com/brand_b'])
    expect((await links(A.conceptId)).sameAs).toEqual(['https://www.tiktok.com/@branda'])
  })
})

describe('only https links, at most 12', () => {
  const bad: Array<[string, Record<string, unknown>]> = [
    ['http link', { sameAs: ['http://instagram.com/branda'] }],
    ['javascript link', { sameAs: ['javascript:alert(1)'] }],
    ['bare word', { sameAs: ['instagram'] }],
    ['credentials in the link', { sameAs: ['https://user:pw@instagram.com/branda'] }],
    ['no real host', { sameAs: ['https://localhost/branda'] }],
    ['13 links', { sameAs: Array.from({ length: 13 }, (_, i) => `https://instagram.com/branda${i}`) }],
    ['Maps link not https', { googleMapsUrl: 'http://maps.google.com/?cid=1' }],
    ['Maps link data:', { googleMapsUrl: 'data:text/html,hi' }],
  ]
  for (const [label, body] of bad) {
    it(`${label} → 422 INVALID_PROFILE_LINK, nothing changes`, async () => {
      const before = await links(A.conceptId)
      for (const who of [ceoA]) {
        const r = await call(who, 'PATCH', `/concepts/${A.conceptId}`, body)
        expect(r.statusCode).toBe(422)
        expect(r.json().error.code).toBe('INVALID_PROFILE_LINK')
      }
      expect(await links(A.conceptId)).toEqual(before)
    })
  }

  it('a bad link on create → 422, no brand made', async () => {
    const slug = `pl-bad-${stamp}`
    const r = await call(ceoA, 'POST', '/concepts', { name: 'Bad', slug, type: 'restaurant', serviceVessel: 'plate', sameAs: ['ftp://x.y/z'] })
    expect(r.statusCode).toBe(422)
    expect(await prisma.concept.count({ where: { slug } })).toBe(0)
  })
})

describe('create binds to the active company', () => {
  it('POST /concepts with links → stored on a brand of A', async () => {
    const r = await call(ceoA, 'POST', '/concepts', {
      name: 'Links brand', slug: `pl-new-${stamp}`, type: 'restaurant', serviceVessel: 'plate',
      sameAs: ['https://instagram.com/newbrand'], googleMapsUrl: 'https://maps.app.goo.gl/new',
    })
    expect(r.statusCode).toBe(201)
    const row = await prisma.concept.findUniqueOrThrow({ where: { id: r.json().id } })
    expect(row.tenantId).toBe(A.tenantId)
    expect(row.sameAs).toEqual(['https://instagram.com/newbrand'])
    expect(row.googleMapsUrl).toBe('https://maps.app.goo.gl/new')
  })
})

describe('public payloads carry the links', () => {
  beforeAll(async () => {
    await prisma.concept.update({
      where: { id: A.conceptId },
      data: { sameAs: ['https://instagram.com/brand_a'], googleMapsUrl: 'https://maps.app.goo.gl/abc123', storefrontVisible: true, isActive: true },
    })
  })

  it('/storefront/concepts includes sameAs + googleMapsUrl per brand', async () => {
    const r = await app.inject({ method: 'GET', url: '/storefront/concepts' })
    expect(r.statusCode).toBe(200)
    const rows = r.json() as Array<{ id: string; sameAs?: string[]; googleMapsUrl?: string | null }>
    const a = rows.find((c) => c.id === A.conceptId)
    const b = rows.find((c) => c.id === B.conceptId)
    expect(a?.sameAs).toEqual(['https://instagram.com/brand_a'])
    expect(a?.googleMapsUrl).toBe('https://maps.app.goo.gl/abc123')
    // Each brand carries only its own links.
    expect(b?.sameAs).toEqual(['https://instagram.com/brand_b'])
    expect(b?.googleMapsUrl).toBeNull()
  })

  it('/storefront/:slug/menu includes them on the concept', async () => {
    const slug = (await prisma.concept.findUniqueOrThrow({ where: { id: A.conceptId }, select: { slug: true } })).slug
    const r = await app.inject({ method: 'GET', url: `/storefront/${slug}/menu` })
    expect(r.statusCode).toBe(200)
    expect(r.json().concept.sameAs).toEqual(['https://instagram.com/brand_a'])
    expect(r.json().concept.googleMapsUrl).toBe('https://maps.app.goo.gl/abc123')
  })
})
