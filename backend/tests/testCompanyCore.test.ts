// Test company — core (owner, 2026-10-14; lib/testCompany.ts):
//   • POST /tenants { isTest: true } — the CEO only (403 TEST_COMPANY_CEO_ONLY
//     otherwise); fiscal reporting is switched off on create (audited).
//   • PUT /connectors/fiscal/reporting-required { required: true } on a test
//     company → 409 TEST_COMPANY_NO_FISCAL.
//   • PATCH /tenants/:id/test-mode — CEO only, reason ≥10, membership-checked;
//     OFF makes fiscal reporting required again.
//   • "All companies" (portfolio) reports leave the test company out, while
//     the test company's own view includes its sales (sales report + P&L).
//   • /tenants/mine, /tenants and /tenants/me carry isTest.
//   • A test company is never merged with a real one (422 TEST_COMPANY_MERGE).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import type { UserRole } from '@prisma/client'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { postJournalEntry } from '../src/modules/accounting/journal.js'
import { fiscalReportingRequired } from '../src/connectors/config.js'
import { isTestTenant, testTenantIds, invalidateTestTenants } from '../src/lib/testCompany.js'
import { tenantRoutes } from '../src/modules/tenants/routes.js'
import { connectorRoutes } from '../src/modules/connectors/routes.js'
import { reportRoutes } from '../src/modules/reports/routes.js'
import { accountingRoutes } from '../src/modules/accounting/routes.js'

let realCo: string
let otherCo: string
let realConcept: string
let app: FastifyInstance
const users: Record<string, { id: string; token: string }> = {}

const DAY = '2026-05-21'
const at = (hhmm: string) => new Date(`${DAY}T${hhmm}:00+05:00`)
const RANGE = `dateFrom=${DAY}&dateTo=${DAY}`

async function mkUser(key: string, role: UserRole, primary: string, members: string[]) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.testco@gsfoods.pk`, password: await bcrypt.hash('x-Password-1', 4), role, isActive: true, accountStatus: 'active', tenantId: primary },
  })
  for (const t of members) await prisma.tenantMember.create({ data: { tenantId: t, userId: u.id } }).catch(() => {})
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT'
const call = (who: string, method: Method, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url, payload: payload as never, headers: { authorization: `Bearer ${users[who]!.token}`, ...headers } })

async function sale(conceptId: string, tenantId: string, totalCents: number, ref: string) {
  const o = await prisma.order.create({
    data: {
      conceptId, source: 'servd', status: 'completed', totalCents, taxCents: 0,
      placedAt: at('12:00'), completedAt: at('12:20'),
      items: { create: [{ name: 'Club sandwich', quantity: 1, unitPriceCents: totalCents }] },
    },
  })
  await postJournalEntry({
    tenantId, sourceType: 'order.complete', sourceId: `${ref}-${o.id}`, description: `Order ${ref}`, entryDate: at('12:20'),
    lines: [{ accountCode: '1010', type: 'debit', amountCents: totalCents }, { accountCode: '4001', type: 'credit', amountCents: totalCents }],
  })
  return o
}

beforeAll(async () => {
  realCo = (await prisma.tenant.create({ data: { name: 'Real Foods', slug: 'testco-real' } })).id
  otherCo = (await prisma.tenant.create({ data: { name: 'Other Foods', slug: 'testco-other' } })).id
  await ensureChartOfAccounts(realCo)
  realConcept = (await prisma.concept.create({ data: { name: 'Real Cafe', slug: 'testco-real-cafe', type: 'restaurant', tenantId: realCo } })).id

  await mkUser('ceo', 'admin', realCo, [realCo, otherCo])     // the CEO, in both real companies
  await mkUser('mgr', 'management', realCo, [realCo])
  await mkUser('ceoB', 'admin', otherCo, [otherCo])            // CEO of company B only

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(tenantRoutes, { prefix: '/tenants' })
  await app.register(connectorRoutes, { prefix: '/connectors' })
  await app.register(reportRoutes, { prefix: '/reports' })
  await app.register(accountingRoutes, { prefix: '/accounting' })
  await app.ready()
})

afterAll(async () => {
  await app.close()
})

let testCo: string

describe('creating a test company', () => {
  it('a manager cannot make any company, test or not (CEO only, owner 2026-10-15) and nothing is created', async () => {
    const before = await prisma.tenant.count()
    const res = await call('mgr', 'POST', '/tenants', { name: 'Sneaky Test', isTest: true })
    expect(res.statusCode).toBe(403)
    expect((await call('mgr', 'POST', '/tenants', { name: 'Ordinary Co' })).statusCode).toBe(403)
    expect(await prisma.tenant.count()).toBe(before)
  })

  it('the CEO makes one: flagged, fiscal reporting off at once, both audited', async () => {
    const res = await call('ceo', 'POST', '/tenants', { name: 'Practice Kitchen', isTest: true })
    expect(res.statusCode).toBe(201)
    const t = res.json() as { id: string; isTest: boolean }
    expect(t.isTest).toBe(true)
    testCo = t.id
    expect(await isTestTenant(testCo)).toBe(true)
    expect((await testTenantIds()).has(testCo)).toBe(true)
    expect(await fiscalReportingRequired(testCo, prisma)).toBe(false)
    const fiscalAudit = await prisma.auditLog.findFirst({ where: { tenantId: testCo, action: 'fiscal.reporting_required' } })
    expect(fiscalAudit).not.toBeNull()
    expect((fiscalAudit!.metadata as { reason: string }).reason).toBe('Test company')
    expect(await prisma.auditLog.count({ where: { tenantId: testCo, action: 'tenant.test_mode' } })).toBe(1)
    // The creator is a member, and the creation switched them into it.
    expect((await prisma.user.findUniqueOrThrow({ where: { id: users.ceo!.id } })).tenantId).toBe(testCo)
  })

  it('a plain company is not a test company and keeps fiscal reporting required', async () => {
    const res = await call('ceo', 'POST', '/tenants', { name: 'Ordinary Co' })
    expect(res.statusCode).toBe(201)
    const id = (res.json() as { id: string; isTest: boolean }).id
    expect(res.json().isTest).toBe(false)
    expect(await isTestTenant(id)).toBe(false)
    expect(await fiscalReportingRequired(id, prisma)).toBe(true)
    // creating it switched the CEO into it — back to the test company the next checks expect
    await prisma.user.update({ where: { id: users.ceo!.id }, data: { tenantId: testCo } })
  })

  it('/tenants/mine, /tenants and /tenants/me carry isTest', async () => {
    const mine = (await call('ceo', 'GET', '/tenants/mine')).json() as Array<{ id: string; isTest: boolean }>
    expect(mine.find((t) => t.id === testCo)?.isTest).toBe(true)
    expect(mine.find((t) => t.id === realCo)?.isTest).toBe(false)
    const all = (await call('ceo', 'GET', '/tenants')).json() as Array<{ id: string; isTest: boolean }>
    expect(all.find((t) => t.id === testCo)?.isTest).toBe(true)
    const me = (await call('ceo', 'GET', '/tenants/me')).json() as { id: string; isTest: boolean }
    expect(me.id).toBe(testCo)
    expect(me.isTest).toBe(true)
  })
})

describe('fiscal reporting on a test company', () => {
  it('switching reporting back ON is refused (409 TEST_COMPANY_NO_FISCAL); OFF is still allowed', async () => {
    const on = await call('ceo', 'PUT', '/connectors/fiscal/reporting-required', { required: true, reason: 'Try to file' }, { 'x-servd-active-tenant': testCo })
    expect(on.statusCode).toBe(409)
    expect(on.json().error.code).toBe('TEST_COMPANY_NO_FISCAL')
    expect(await fiscalReportingRequired(testCo, prisma)).toBe(false)
    const off = await call('ceo', 'PUT', '/connectors/fiscal/reporting-required', { required: false, reason: 'Keep it off' }, { 'x-servd-active-tenant': testCo })
    expect(off.statusCode).toBe(200)
  })

  it('a real company can still switch reporting on and off', async () => {
    const off = await call('ceo', 'PUT', '/connectors/fiscal/reporting-required', { required: false, reason: 'Home kitchen' }, { 'x-servd-active-tenant': otherCo })
    expect(off.statusCode).toBe(200)
    const on = await call('ceo', 'PUT', '/connectors/fiscal/reporting-required', { required: true, reason: 'Selling again' }, { 'x-servd-active-tenant': otherCo })
    expect(on.statusCode).toBe(200)
    expect(await fiscalReportingRequired(otherCo, prisma)).toBe(true)
  })
})

describe('"All companies" leaves the test company out; its own view does not', () => {
  let testConcept: string
  beforeAll(async () => {
    await ensureChartOfAccounts(testCo)
    testConcept = (await prisma.concept.create({ data: { name: 'Practice Cafe', slug: 'testco-practice-cafe', type: 'restaurant', tenantId: testCo } })).id
    await sale(realConcept, realCo, 10_000, 'real')
    await sale(testConcept, testCo, 70_000, 'test')
    // The CEO looks from the real company.
    await prisma.user.update({ where: { id: users.ceo!.id }, data: { tenantId: realCo } })
  })

  it('sales report: portfolio from the real company excludes the test company\'s order', async () => {
    const res = await call('ceo', 'GET', `/reports/sales?${RANGE}`, undefined, { 'x-servd-portfolio': '1' })
    expect(res.statusCode).toBe(200)
    const t = (res.json() as { totals: { orders: number; gross: number } }).totals
    expect(t.orders).toBe(1)
    expect(t.gross).toBe(10_000)
  })

  it('sales report: the test company\'s own view includes its order', async () => {
    const own = await call('ceo', 'GET', `/reports/sales?${RANGE}`, undefined, { 'x-servd-active-tenant': testCo })
    expect((own.json() as { totals: { orders: number; gross: number } }).totals).toMatchObject({ orders: 1, gross: 70_000 })
    // …and while the ACTIVE company is the test company, "All companies"
    // still leaves it out (fr-1: never counted in All companies totals).
    const asActive = await call('ceo', 'GET', `/reports/sales?${RANGE}`, undefined, { 'x-servd-portfolio': '1', 'x-servd-active-tenant': testCo })
    expect((asActive.json() as { totals: { orders: number; gross: number } }).totals).toMatchObject({ orders: 1, gross: 10_000 })
  })

  it('portfolio while the user\'s saved active company is the test company still leaves it out', async () => {
    await prisma.user.update({ where: { id: users.ceo!.id }, data: { tenantId: testCo } })
    try {
      const res = await call('ceo', 'GET', `/reports/sales?${RANGE}`, undefined, { 'x-servd-portfolio': '1' })
      expect((res.json() as { totals: { orders: number; gross: number } }).totals).toMatchObject({ orders: 1, gross: 10_000 })
      const pl = await call('ceo', 'GET', `/accounting/pl-ledger?${RANGE}`, undefined, { 'x-servd-portfolio': '1' })
      expect((pl.json() as { totals: { revenueCents: number } }).totals.revenueCents).toBe(10_000)
    } finally {
      await prisma.user.update({ where: { id: users.ceo!.id }, data: { tenantId: realCo } })
    }
  })

  it('a login that belongs only to test companies falls back to its active company in portfolio', async () => {
    await mkUser('testOnly', 'admin', testCo, [testCo])
    const res = await call('testOnly', 'GET', `/reports/sales?${RANGE}`, undefined, { 'x-servd-portfolio': '1' })
    expect(res.statusCode).toBe(200)
    expect((res.json() as { totals: { orders: number; gross: number } }).totals).toMatchObject({ orders: 1, gross: 70_000 })
  })

  it('P&L (ledger): portfolio excludes the test company; its own P&L has its sale', async () => {
    const port = await call('ceo', 'GET', `/accounting/pl-ledger?${RANGE}`, undefined, { 'x-servd-portfolio': '1' })
    expect(port.statusCode).toBe(200)
    expect((port.json() as { totals: { revenueCents: number } }).totals.revenueCents).toBe(10_000)
    const own = await call('ceo', 'GET', `/accounting/pl-ledger?${RANGE}`, undefined, { 'x-servd-active-tenant': testCo })
    expect((own.json() as { totals: { revenueCents: number } }).totals.revenueCents).toBe(70_000)
  })

  it('test mode off: the company counts in "All companies" again', async () => {
    const off = await call('ceo', 'PATCH', `/tenants/${testCo}/test-mode`, { isTest: false, reason: 'Trial finished, going live' })
    expect(off.statusCode).toBe(200)
    const port = await call('ceo', 'GET', `/reports/sales?${RANGE}`, undefined, { 'x-servd-portfolio': '1' })
    expect((port.json() as { totals: { orders: number } }).totals.orders).toBe(2)
    // back on for the rest of the file
    const on = await call('ceo', 'PATCH', `/tenants/${testCo}/test-mode`, { isTest: true, reason: 'Back to practice mode' })
    expect(on.statusCode).toBe(200)
    expect(await fiscalReportingRequired(testCo, prisma)).toBe(false)
  })
})

describe('PATCH /tenants/:id/test-mode', () => {
  it('a manager is refused (403); a short reason is 400; a foreign company is 404', async () => {
    expect((await call('mgr', 'PATCH', `/tenants/${realCo}/test-mode`, { isTest: true, reason: 'Just trying things' })).statusCode).toBe(403)
    expect((await call('ceo', 'PATCH', `/tenants/${testCo}/test-mode`, { isTest: false, reason: 'short' })).statusCode).toBe(400)
    // ceoB is not a member of the test company
    expect((await call('ceoB', 'PATCH', `/tenants/${testCo}/test-mode`, { isTest: false, reason: 'Not my company at all' })).statusCode).toBe(404)
    expect(await isTestTenant(testCo)).toBe(true)
  })

  it('turning test OFF makes fiscal reporting required again (audited); ON switches it off', async () => {
    const off = await call('ceo', 'PATCH', `/tenants/${testCo}/test-mode`, { isTest: false, reason: 'Opening for real sales' })
    expect(off.statusCode).toBe(200)
    expect(off.json()).toMatchObject({ isTest: false, fiscalReportingRequired: true })
    expect(await isTestTenant(testCo)).toBe(false)
    expect(await fiscalReportingRequired(testCo, prisma)).toBe(true)
    const audits = await prisma.auditLog.findMany({ where: { tenantId: testCo, action: 'tenant.test_mode' }, orderBy: { createdAt: 'asc' } })
    const last = audits[audits.length - 1]!
    expect(last.before).toEqual({ isTest: true })
    expect(last.after).toEqual({ isTest: false })
    expect((last.metadata as { reason: string }).reason).toBe('Opening for real sales')

    const on = await call('ceo', 'PATCH', `/tenants/${testCo}/test-mode`, { isTest: true, reason: 'Practice again please' })
    expect(on.statusCode).toBe(200)
    expect(on.json()).toMatchObject({ isTest: true, fiscalReportingRequired: false })
    expect(await fiscalReportingRequired(testCo, prisma)).toBe(false)
  })
})

describe('merging', () => {
  it('a test company is never merged with a real one, either way (422 TEST_COMPANY_MERGE)', async () => {
    const a = await call('ceo', 'POST', '/tenants/merge', { sourceId: testCo, targetId: realCo })
    expect(a.statusCode).toBe(422)
    expect(a.json().error.code).toBe('TEST_COMPANY_MERGE')
    const b = await call('ceo', 'POST', '/tenants/merge', { sourceId: otherCo, targetId: testCo })
    expect(b.statusCode).toBe(422)
    expect(b.json().error.code).toBe('TEST_COMPANY_MERGE')
    expect(await prisma.tenant.count({ where: { id: { in: [testCo, realCo, otherCo] }, deletedAt: null } })).toBe(3)
  })
})

describe('the predicate', () => {
  it('null / unknown ids are not test companies; invalidation re-reads', async () => {
    expect(await isTestTenant(null)).toBe(false)
    expect(await isTestTenant(undefined)).toBe(false)
    expect(await isTestTenant('no-such-company')).toBe(false)
    await prisma.tenant.update({ where: { id: otherCo }, data: { isTest: true } })
    invalidateTestTenants()
    expect(await isTestTenant(otherCo)).toBe(true)
    expect(await isTestTenant(otherCo, prisma)).toBe(true)
    await prisma.tenant.update({ where: { id: otherCo }, data: { isTest: false } })
    invalidateTestTenants()
    expect(await isTestTenant(otherCo)).toBe(false)
  })
})
