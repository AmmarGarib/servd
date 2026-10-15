// Head office guards on the company routes (D1 spec §6.7; owner 2026-10-15:
// creating companies is the CEO's only).
//
//   - POST /tenants is ADMIN_ONLY (finance → 403) and always makes kind 'company';
//   - GET /tenants/mine carries `kind` on every row (array shape unchanged);
//   - POST /tenants/merge refuses a head office and a company it serves
//     (422 MERGE_HAS_HEAD_OFFICE), and a submitted journal request or POS
//     connector change (422 MERGE_HAS_PENDING_REQUESTS); draft ones move;
//   - POST /tenants/apply-template and POST /concepts in a head office → 422
//     HEAD_OFFICE_HAS_NO_BRANDS;
//   - PATCH /tenants/:id/test-mode on a tenant with a live link → 422
//     TEST_COMPANY_MIX; once the link ended it flips.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { prisma, mkUser, type Who } from './connectorsFixtures.js'
import { AppError } from '../src/lib/errors.js'
import { runWithRlsContext } from '../src/lib/rlsContext.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { invalidateTestTenants } from '../src/lib/testCompany.js'
import { tenantRoutes } from '../src/modules/tenants/routes.js'
import { conceptRoutes } from '../src/modules/concepts/routes.js'

const RUN = Date.now().toString(36)
let app: FastifyInstance
let seq = 0
let ceo: Who
let fin: Who

async function tenant(name: string, kind: 'company' | 'head_office' = 'company'): Promise<string> {
  const id = (await prisma.tenant.create({ data: { name: `${name} ${RUN}`, slug: `hotg-${++seq}-${RUN}`, kind } })).id
  await ensureChartOfAccounts(id)
  await prisma.tenantMember.create({ data: { tenantId: id, userId: ceo.id } })
  return id
}
async function link(hoId: string, companyId: string) {
  return prisma.headOfficeLink.create({ data: { tenantId: hoId, companyTenantId: companyId, createdById: ceo.id } })
}
type Method = 'GET' | 'POST' | 'PATCH'
const call = (who: Who, method: Method, url: string, payload?: unknown, activeTenant?: string) =>
  app.inject({
    method, url,
    headers: { authorization: `Bearer ${who.token}`, ...(activeTenant ? { 'x-servd-active-tenant': activeTenant } : {}) },
    ...(payload !== undefined ? { payload: payload as never } : {}),
  })
const code = (res: { json: () => unknown }) => (res.json() as { error?: { code?: string } }).error?.code

let A: string

beforeAll(async () => {
  ceo = await mkUser('hotg-ceo', 'admin', null)
  A = await tenant('Home Co')
  await prisma.user.update({ where: { id: ceo.id }, data: { tenantId: A } })
  fin = await mkUser('hotg-fin', 'finance', A)
  app = Fastify()
  app.addHook('onRequest', (_req, _reply, done) => { runWithRlsContext({}, () => done()) })
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: err.message } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(tenantRoutes, { prefix: '/tenants' })
  await app.register(conceptRoutes, { prefix: '/concepts' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  await app?.close()
})

describe('creating a company', () => {
  it('finance gets 403 and nothing is created', async () => {
    const before = await prisma.tenant.count()
    const res = await call(fin, 'POST', '/tenants', { name: `Finance Co ${RUN}` })
    expect(res.statusCode).toBe(403)
    expect(await prisma.tenant.count()).toBe(before)
  })

  it('the CEO creates a trading company (kind company)', async () => {
    const res = await call(ceo, 'POST', '/tenants', { name: `New Co ${RUN}` })
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json().kind).toBe('company')
    const t = await prisma.tenant.findUniqueOrThrow({ where: { id: res.json().id } })
    expect(t.kind).toBe('company')
    // POST /tenants switched the CEO's active company; switch back for the rest.
    await prisma.user.update({ where: { id: ceo.id }, data: { tenantId: A } })
  })
})

describe('GET /tenants/mine', () => {
  it('is still an array, and every row carries kind', async () => {
    const ho = await tenant('Mine HO', 'head_office')
    const res = await call(ceo, 'GET', '/tenants/mine')
    expect(res.statusCode).toBe(200)
    const rows = res.json() as Array<{ id: string; kind: string; role: string; isActive: boolean }>
    expect(Array.isArray(rows)).toBe(true)
    expect(rows.find((r) => r.id === ho)?.kind).toBe('head_office')
    expect(rows.find((r) => r.id === A)?.kind).toBe('company')
    expect(rows.every((r) => r.kind === 'company' || r.kind === 'head_office')).toBe(true)
  })
})

describe('merge', () => {
  it('a head office is never merged (either side) — 422 MERGE_HAS_HEAD_OFFICE, nothing moves', async () => {
    const ho = await tenant('Merge HO', 'head_office')
    const c = await tenant('Merge Co')
    for (const [s, d] of [[ho, c], [c, ho]] as const) {
      const res = await call(ceo, 'POST', '/tenants/merge', { sourceId: s, targetId: d })
      expect(res.statusCode).toBe(422)
      expect(code(res)).toBe('MERGE_HAS_HEAD_OFFICE')
    }
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: ho } })).deletedAt).toBeNull()
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: c } })).deletedAt).toBeNull()
  })

  it('a company a head office serves (even an ended link) is refused', async () => {
    const ho = await tenant('Serving HO', 'head_office')
    const c1 = await tenant('Served Co')
    const c2 = await tenant('Other Co')
    const l = await link(ho, c1)
    await prisma.headOfficeLink.update({ where: { id: l.id }, data: { endedAt: new Date(), endedById: ceo.id } })
    const res = await call(ceo, 'POST', '/tenants/merge', { sourceId: c1, targetId: c2 })
    expect(res.statusCode).toBe(422)
    expect(code(res)).toBe('MERGE_HAS_HEAD_OFFICE')
    expect((res.json() as { error: { details: { links: number } } }).error.details.links).toBe(1)
  })

  it('an approval hand-over naming a company is refused', async () => {
    const ho = await tenant('Delegating HO', 'head_office')
    const c1 = await tenant('Delegated Co')
    const c2 = await tenant('Delegated Co 2')
    await prisma.approvalDelegation.create({ data: { tenantId: ho, companyTenantId: c1, section: 'finance', delegateUserId: fin.id, grantedById: ceo.id } })
    const res = await call(ceo, 'POST', '/tenants/merge', { sourceId: c1, targetId: c2 })
    expect(code(res)).toBe('MERGE_HAS_HEAD_OFFICE')
  })

  it('a submitted journal request or connector change refuses the merge; drafts move with the company', async () => {
    const s = await tenant('Req Source')
    const d = await tenant('Req Target')
    const submitted = await prisma.journalRequest.create({
      data: { tenantId: s, status: 'submitted', description: 'Accrual', preparedById: fin.id, submittedById: fin.id, submittedAt: new Date() },
    })
    let res = await call(ceo, 'POST', '/tenants/merge', { sourceId: s, targetId: d })
    expect(res.statusCode).toBe(422)
    expect(code(res)).toBe('MERGE_HAS_PENDING_REQUESTS')
    await prisma.journalRequest.update({ where: { id: submitted.id }, data: { status: 'withdrawn' } })

    const change = await prisma.posConnectorChange.create({ data: { tenantId: s, kind: 'fiscal', status: 'submitted', patch: {}, preparedById: fin.id } })
    res = await call(ceo, 'POST', '/tenants/merge', { sourceId: s, targetId: d })
    expect(code(res)).toBe('MERGE_HAS_PENDING_REQUESTS')
    await prisma.posConnectorChange.update({ where: { id: change.id }, data: { status: 'rejected' } })

    // A draft naming the source's 6010 is remapped to the target's 6010.
    const srcSalaries = await prisma.account.findFirstOrThrow({ where: { tenantId: s, code: '6010' } })
    const dstSalaries = await prisma.account.findFirstOrThrow({ where: { tenantId: d, code: '6010' } })
    const draft = await prisma.journalRequest.create({
      data: { tenantId: s, status: 'draft', description: 'Draft accrual', preparedById: fin.id, lines: [{ accountId: srcSalaries.id, type: 'debit', amountCents: 1_000 }] },
    })
    res = await call(ceo, 'POST', '/tenants/merge', { sourceId: s, targetId: d })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({ journalRequestsMoved: 2, posConnectorChangesMoved: 1 })
    const moved = await prisma.journalRequest.findUniqueOrThrow({ where: { id: draft.id } })
    expect(moved.tenantId).toBe(d)
    expect((moved.lines as Array<{ accountId: string }>)[0]!.accountId).toBe(dstSalaries.id)
    expect((await prisma.journalRequest.findUniqueOrThrow({ where: { id: submitted.id } })).tenantId).toBe(d)
    expect((await prisma.posConnectorChange.findUniqueOrThrow({ where: { id: change.id } })).tenantId).toBe(d)
  })
})

describe('a head office has no brands', () => {
  it('apply-template in a head office → 422 HEAD_OFFICE_HAS_NO_BRANDS, no brand made', async () => {
    const ho = await tenant('Template HO', 'head_office')
    const res = await call(ceo, 'POST', '/tenants/apply-template', { templateKey: 'burger', serviceVessel: 'plate' }, ho)
    expect(res.statusCode).toBe(422)
    expect(code(res)).toBe('HEAD_OFFICE_HAS_NO_BRANDS')
    expect(await prisma.concept.count({ where: { tenantId: ho } })).toBe(0)
  })

  it('POST /concepts in a head office → 422; in a company it still creates', async () => {
    const ho = await tenant('Concept HO', 'head_office')
    const body = (slug: string) => ({ name: `Brand ${slug}`, slug, type: 'restaurant', serviceVessel: 'plate' })
    const res = await call(ceo, 'POST', '/concepts', body(`hotg-ho-${RUN}`), ho)
    expect(res.statusCode).toBe(422)
    expect(code(res)).toBe('HEAD_OFFICE_HAS_NO_BRANDS')
    expect(await prisma.concept.count({ where: { tenantId: ho } })).toBe(0)
    const ok = await call(ceo, 'POST', '/concepts', body(`hotg-co-${RUN}`), A)
    expect(ok.statusCode, ok.body).toBe(201)
    expect(ok.json().tenantId).toBe(A)
  })
})

describe('test mode', () => {
  it('a tenant with a live link cannot flip (either side) → 422 TEST_COMPANY_MIX; once ended it can', async () => {
    const ho = await tenant('Test HO', 'head_office')
    const c = await tenant('Test Co')
    const l = await link(ho, c)
    for (const id of [c, ho]) {
      const res = await call(ceo, 'PATCH', `/tenants/${id}/test-mode`, { isTest: true, reason: 'Trying the practice flow' })
      expect(res.statusCode).toBe(422)
      expect(code(res)).toBe('TEST_COMPANY_MIX')
      expect((await prisma.tenant.findUniqueOrThrow({ where: { id } })).isTest).toBe(false)
    }
    await prisma.headOfficeLink.update({ where: { id: l.id }, data: { endedAt: new Date(), endedById: ceo.id } })
    const res = await call(ceo, 'PATCH', `/tenants/${c}/test-mode`, { isTest: true, reason: 'Trying the practice flow' })
    expect(res.statusCode, res.body).toBe(200)
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: c } })).isTest).toBe(true)
    invalidateTestTenants()
  })
})
