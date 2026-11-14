// GS Foods is registered only with FBR and SRB (owner, 2026-10-15): PRA
// (Punjab), KPRA (KP) and BRA (Balochistan) were removed.
//
// What this guards:
//   - POST /concepts with province PB / KP / BL → 400 VALIDATION_ERROR,
//     nothing created; SD and ICT are accepted;
//   - PATCH /concepts/:id to PB / KP / BL → 400, the brand's province is
//     unchanged; to ICT → 200;
//   - ensureChartOfAccounts never creates 1321 / 1323 / 1324 / 2031 / 2033 /
//     2034, and keeps the FBR (2030 / 1320) and SRB (2032 / 1322) accounts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { prisma, mkCompany, mkUser, type Company, type Who } from './connectorsFixtures.js'
import { AppError, errorResponse } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { conceptRoutes } from '../src/modules/concepts/routes.js'
import { AUTHORITY_BY_PROVINCE, BRAND_PROVINCES, outputTaxCodeFor } from '../src/modules/accounting/taxAuthorities.js'

let app: FastifyInstance
let A: Company
let ceoA: Who
let B: Company
let ceoB: Who
const stamp = Date.now()

const call = (who: Who, method: 'POST' | 'PATCH', url: string, payload: Record<string, unknown>) =>
  app.inject({ method, url, payload, headers: { authorization: `Bearer ${who.token}` } })

beforeAll(async () => {
  A = await mkCompany(`bpr-a-${stamp}`)
  ceoA = await mkUser('bpr-ceo-a', 'admin', A.tenantId)
  B = await mkCompany(`bpr-b-${stamp}`)
  ceoB = await mkUser('bpr-ceo-b', 'admin', B.tenantId)
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(conceptRoutes, { prefix: '/concepts' })
  await app.ready()
}, 60_000)

afterAll(async () => { await app?.close() })

describe('a brand can only be in an FBR or SRB province', () => {
  it('POST /concepts with PB / KP / BL → 400, nothing created; ICT is accepted', async () => {
    for (const province of ['PB', 'KP', 'BL']) {
      const slug = `bpr-${province.toLowerCase()}-${stamp}`
      const r = await call(ceoA, 'POST', '/concepts', { name: `Brand ${province}`, slug, type: 'restaurant', serviceVessel: 'plate', province })
      expect(r.statusCode, r.body).toBe(400)
      expect(r.json().error.code).toBe('VALIDATION_ERROR')
      expect(await prisma.concept.count({ where: { slug } })).toBe(0)
    }
    const ok = await call(ceoA, 'POST', '/concepts', { name: 'Islamabad', slug: `bpr-ict-${stamp}`, type: 'restaurant', serviceVessel: 'plate', province: 'ICT' })
    expect(ok.statusCode, ok.body).toBe(201)
    expect(await prisma.concept.findUniqueOrThrow({ where: { slug: `bpr-ict-${stamp}` } })).toMatchObject({ province: 'ICT', tenantId: A.tenantId })
  })

  it('PATCH /concepts/:id to PB / KP / BL → 400, the province is unchanged; to ICT → 200', async () => {
    for (const province of ['PB', 'KP', 'BL']) {
      const r = await call(ceoA, 'PATCH', `/concepts/${A.conceptId}`, { province })
      expect(r.statusCode, r.body).toBe(400)
      expect(r.json().error.code).toBe('VALIDATION_ERROR')
    }
    expect((await prisma.concept.findUniqueOrThrow({ where: { id: A.conceptId } })).province).toBe('SD')
    const ok = await call(ceoA, 'PATCH', `/concepts/${A.conceptId}`, { province: 'ICT' })
    expect(ok.statusCode, ok.body).toBe(200)
    expect((await prisma.concept.findUniqueOrThrow({ where: { id: A.conceptId } })).province).toBe('ICT')
  })
})

// Clean-up A7 (finance, 2026-11-14): the forms offer only what the books know (FBR, SRB). Gilgit-Baltistan and AJK
// are not offered; a brand already saved with one still loads and saves unchanged (taxed by FBR).
describe('Gilgit-Baltistan and AJK are not offered; an old value is kept', () => {
  it('the one list: Sindh → SRB, ICT → FBR, agreeing with the authority table', () => {
    expect(BRAND_PROVINCES.map((p) => p.code)).toEqual(['SD', 'ICT'])
    for (const p of BRAND_PROVINCES) expect(AUTHORITY_BY_PROVINCE[p.code] ?? 'fbr').toBe(p.authority)
  })

  it('POST with GB / AJK → 422 PROVINCE_NOT_AVAILABLE, nothing created', async () => {
    for (const province of ['GB', 'AJK']) {
      const slug = `bpr-new-${province.toLowerCase()}-${stamp}`
      const r = await call(ceoA, 'POST', '/concepts', { name: `Brand ${province}`, slug, type: 'restaurant', serviceVessel: 'plate', province })
      expect(r.statusCode, r.body).toBe(422)
      expect(r.json().error.code).toBe('PROVINCE_NOT_AVAILABLE')
      expect(await prisma.concept.count({ where: { slug } })).toBe(0)
    }
  })

  it('a brand saved with GB: a full save sending GB unchanged passes; switching to AJK is 422; to ICT is 200; it books to FBR', async () => {
    await prisma.concept.update({ where: { id: B.conceptId }, data: { province: 'GB', srbPosId: null } })
    expect(outputTaxCodeFor({ province: 'GB', srbPosId: null })).toBe('2030')
    const keep = await call(ceoB, 'PATCH', `/concepts/${B.conceptId}`, { province: 'GB', description: 'Northern kitchen' })
    expect(keep.statusCode, keep.body).toBe(200)
    expect(await prisma.concept.findUniqueOrThrow({ where: { id: B.conceptId } })).toMatchObject({ province: 'GB', description: 'Northern kitchen' })
    const ajk = await call(ceoB, 'PATCH', `/concepts/${B.conceptId}`, { province: 'AJK' })
    expect(ajk.statusCode, ajk.body).toBe(422)
    expect(ajk.json().error.code).toBe('PROVINCE_NOT_AVAILABLE')
    // Another company's CEO never reaches it.
    expect((await call(ceoA, 'PATCH', `/concepts/${B.conceptId}`, { province: 'ICT' })).statusCode).toBe(404)
    const ict = await call(ceoB, 'PATCH', `/concepts/${B.conceptId}`, { province: 'ICT' })
    expect(ict.statusCode, ict.body).toBe(200)
    expect((await prisma.concept.findUniqueOrThrow({ where: { id: B.conceptId } })).province).toBe('ICT')
  })
})

describe('the chart of accounts', () => {
  it('ensureChartOfAccounts creates no PRA / KPRA / BRA accounts; FBR and SRB stay', async () => {
    await ensureChartOfAccounts(A.tenantId)
    expect(await prisma.account.count({ where: { tenantId: A.tenantId, code: { in: ['1321', '1323', '1324', '2031', '2033', '2034'] } } })).toBe(0)
    const kept = await prisma.account.findMany({ where: { tenantId: A.tenantId, code: { in: ['1320', '1322', '2030', '2032'] } }, select: { code: true } })
    expect(kept.map((a) => a.code).sort()).toEqual(['1320', '1322', '2030', '2032'])
  })
})
