// Fiscal year and the virtual roll-forward (H29): the balance sheet splits each
// company's earnings into 'Retained earnings b/f' (P&L before its fiscal-year
// start) and 'Profit for the year to date', on the company's OWN year end and
// relative to the report's asOf; the trial balance's year basis carries one
// computed b/f row per company and still balances; the API default is
// unchanged. The year end is the CEO's (PATCH /tenants/:id), per company, and
// moving it after a year-end close needs a reason.
//
// Also the statements' revenue groups: 42xx is OTHER INCOME (never revenue or a
// sales KPI), and the ONE cost-of-sales definition — brand sales 40xx net of
// 7010 / 7020, cost of sales split food / drinks / packaging with the
// class-less 5040 / 5050 / 5060 lines split by the stock behind them.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError, errorResponse } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { postJournalEntry } from '../src/modules/accounting/journal.js'
import { parsePktEndOfDay } from '../src/modules/accounting/dates.js'
import { accountingRoutes } from '../src/modules/accounting/routes.js'
import { tenantRoutes } from '../src/modules/tenants/routes.js'
import { balanceSheet, trialBalance, profitAndLoss, brandPnl, brandSalesRevenueCents, costOfSalesSplit } from '../src/modules/accounting/reports.js'
import { labourPctReport } from '../src/lib/labour.js'
import { parsePktStartOfDay } from '../src/modules/accounting/dates.js'
import { fiscalYearOf, fiscalYearsFor, fiscalYearEndMonthOf } from '../src/modules/accounting/fiscalYear.js'

let A: string
let B: string
let C: string
let app: FastifyInstance
const users: Record<string, { id: string; token: string }> = {}

async function mkUser(key: string, role: string, primary: string, members: string[]) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.fyr@gsfoods.pk`, password: await bcrypt.hash('x-Password-1', 4), role: role as 'admin', isActive: true, accountStatus: 'active', tenantId: primary },
  })
  for (const t of members) await prisma.tenantMember.create({ data: { tenantId: t, userId: u.id } })
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}

const call = (who: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({
    method, url, ...(payload !== undefined && { payload: payload as Record<string, unknown> }),
    headers: { authorization: `Bearer ${users[who]!.token}`, ...headers },
  })

let n = 0
async function sale(tenantId: string, at: string, cents: number) {
  await postJournalEntry({ tenantId, sourceType: 'test.sale', sourceId: `s${n++}`, description: 'Sale', entryDate: new Date(at), lines: [
    { accountCode: '1020', type: 'debit', amountCents: cents }, { accountCode: '4001', type: 'credit', amountCents: cents },
  ] })
}
async function rent(tenantId: string, at: string, cents: number) {
  await postJournalEntry({ tenantId, sourceType: 'test.rent', sourceId: `r${n++}`, description: 'Rent', entryDate: new Date(at), lines: [
    { accountCode: '6010', type: 'debit', amountCents: cents }, { accountCode: '1020', type: 'credit', amountCents: cents },
  ] })
}

beforeAll(async () => {
  A = (await prisma.tenant.create({ data: { name: 'FY Foods', slug: 'fyr-a' } })).id                                  // 30 June (default)
  B = (await prisma.tenant.create({ data: { name: 'FY Viva', slug: 'fyr-b', fiscalYearEndMonth: 12 } })).id            // 31 December
  C = (await prisma.tenant.create({ data: { name: 'FY Third', slug: 'fyr-c' } })).id
  for (const t of [A, B, C]) await ensureChartOfAccounts(t)
  await mkUser('ceo', 'admin', A, [A, B, C])
  await mkUser('adminB', 'admin', B, [B])
  await mkUser('fin', 'finance', A, [A, B])

  // A: PKR 1,000 on 30 June (PKT), PKR 2,000 on 1 July, PKR 300 rent on 2 July.
  await sale(A, '2026-06-30T13:00:00Z', 100_000)   // 18:00 PKT, 30 June
  await sale(A, '2026-06-30T19:30:00Z', 200_000)   // 00:30 PKT, 1 July
  await rent(A, '2026-07-02T07:00:00Z', 30_000)
  // B: PKR 500 on 31 December 2025, PKR 700 on 2 January 2026.
  await sale(B, '2025-12-31T07:00:00Z', 50_000)
  await sale(B, '2026-01-02T07:00:00Z', 70_000)
  // C: one sale in May, so a close through July spans 30 June.
  await sale(C, '2026-05-10T07:00:00Z', 10_000)

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(accountingRoutes, { prefix: '/accounting' })
  await app.register(tenantRoutes, { prefix: '/tenants' })
  await app.ready()
})

afterAll(async () => {
  await app.close()
})

describe('fiscalYear helpers', () => {
  it('reads each company\'s own year end and the year that contains `at`', async () => {
    expect(await fiscalYearEndMonthOf(prisma, A)).toBe(6)
    expect(await fiscalYearEndMonthOf(prisma, B)).toBe(12)
    const at = parsePktEndOfDay('2026-08-31')
    const ys = await fiscalYearsFor(prisma, [A, B], at)
    expect(ys.find((y) => y.tenantId === A)).toMatchObject({ endMonth: 6, label: 'FY2026-27', start: fiscalYearOf(6, at).start })
    expect(ys.find((y) => y.tenantId === B)).toMatchObject({ endMonth: 12, label: 'FY2026' })
  })
})

describe('balance sheet — virtual roll-forward per company', () => {
  it('30 June vs 1 July (PKT) splits brought forward vs the year to date; the difference stays 0', async () => {
    const bs = await balanceSheet([A], parsePktEndOfDay('2026-08-31'))
    const e = bs.earningsByCompany.find((x) => x.tenantId === A)!
    expect(e.fiscalYear.label).toBe('FY2026-27')
    expect(e.retainedEarningsBroughtForwardCents).toBe(100_000)
    expect(e.currentYearEarningsCents).toBe(170_000)
    expect(bs.totals.retainedEarningsBroughtForwardCents).toBe(100_000)
    expect(bs.totals.currentYearEarningsCents).toBe(170_000)
    expect(bs.totals.currentEarningsCents).toBe(270_000)
    expect(bs.totals.differenceCents).toBe(0)
  })

  it('the year is the one containing asOf, not today', async () => {
    const bs = await balanceSheet([A], parsePktEndOfDay('2026-06-30'))
    const e = bs.earningsByCompany[0]!
    expect(e.fiscalYear.label).toBe('FY2025-26')
    expect(e.retainedEarningsBroughtForwardCents).toBe(0)
    expect(e.currentYearEarningsCents).toBe(100_000)
    expect(bs.totals.differenceCents).toBe(0)
  })

  it('All companies: B (31 December year end) splits on its own boundary', async () => {
    const res = await call('ceo', 'GET', '/accounting/balance-sheet?asOf=2026-08-31', undefined, { 'x-servd-portfolio': '1' })
    expect(res.statusCode).toBe(200)
    const bs = res.json() as Awaited<ReturnType<typeof balanceSheet>>
    const a = bs.earningsByCompany.find((x) => x.tenantId === A)!
    const b = bs.earningsByCompany.find((x) => x.tenantId === B)!
    expect([a.retainedEarningsBroughtForwardCents, a.currentYearEarningsCents]).toEqual([100_000, 170_000])
    expect([b.retainedEarningsBroughtForwardCents, b.currentYearEarningsCents]).toEqual([50_000, 70_000])
    expect(b.fiscalYear).toMatchObject({ endMonth: 12, label: 'FY2026', start: '2026-01-01', end: '2026-12-31' })
    expect(bs.totals.currentEarningsCents).toBe(bs.totals.retainedEarningsBroughtForwardCents + bs.totals.currentYearEarningsCents)
    expect(bs.totals.differenceCents).toBe(0)

    const csv = await call('ceo', 'GET', '/accounting/balance-sheet?asOf=2026-08-31&format=csv', undefined, { 'x-servd-portfolio': '1' })
    expect(csv.body).toContain('Retained earnings b/f (before 2026-01-01)')
    expect(csv.body).toContain('Profit for the year to date (FY2026-27)')
  })

  it('a company outside the caller\'s scope is never in it', async () => {
    const res = await call('adminB', 'GET', '/accounting/balance-sheet?asOf=2026-08-31', undefined, { 'x-servd-portfolio': '1' })
    expect((res.json().earningsByCompany as Array<{ tenantId: string }>).map((e) => e.tenantId)).toEqual([B])
  })
})

describe('trial balance — year basis', () => {
  it('basis=year: P&L from each fiscal-year start plus one computed b/f row per company; still balances', async () => {
    const res = await call('ceo', 'GET', '/accounting/trial-balance?asOf=2026-08-31&basis=year', undefined, { 'x-servd-portfolio': '1' })
    expect(res.statusCode).toBe(200)
    const tb = res.json() as Awaited<ReturnType<typeof trialBalance>>
    expect(tb.basis).toBe('year')
    const virtual = tb.rows.filter((r) => r.virtual)
    expect(virtual.map((r) => r.tenantId).sort()).toEqual([A, B, C].sort())
    expect(virtual.find((r) => r.tenantId === A)).toMatchObject({ code: '3020*', creditCents: 100_000, debitCents: 0 })
    expect(virtual.find((r) => r.tenantId === B)).toMatchObject({ creditCents: 50_000 })
    expect(tb.rows.find((r) => r.tenantId === A && r.code === '4001')!.creditCents).toBe(200_000)
    expect(tb.rows.find((r) => r.tenantId === B && r.code === '4001')!.creditCents).toBe(70_000)
    expect(tb.totals.differenceCents).toBe(0)
    for (const c of tb.companyTotals) expect(c.differenceCents).toBe(0)
  })

  it('the default basis is unchanged: since inception, no computed rows', async () => {
    const tb = await trialBalance([A], parsePktEndOfDay('2026-08-31'))
    expect(tb.basis).toBe('inception')
    expect(tb.rows.some((r) => r.virtual)).toBe(false)
    expect(tb.rows.find((r) => r.code === '4001')!.creditCents).toBe(300_000)
    const viaRoute = await call('fin', 'GET', '/accounting/trial-balance?asOf=2026-08-31', undefined, { 'x-servd-active-tenant': A })
    expect(viaRoute.json().basis).toBe('inception')
    expect((await call('fin', 'GET', '/accounting/trial-balance?basis=quarter', undefined, { 'x-servd-active-tenant': A })).statusCode).toBe(400)
  })
})

describe('the fiscal year end — CEO only, per company', () => {
  it('GET /fiscal-year lists only the companies in view', async () => {
    const mine = await call('adminB', 'GET', '/accounting/fiscal-year', undefined, { 'x-servd-portfolio': '1' })
    expect((mine.json().companies as Array<{ tenantId: string; endMonth: number }>)).toEqual([expect.objectContaining({ tenantId: B, endMonth: 12, label: expect.stringMatching(/^FY/) })])
    const all = await call('ceo', 'GET', '/accounting/fiscal-year', undefined, { 'x-servd-portfolio': '1' })
    expect((all.json().companies as Array<{ tenantId: string }>).map((c) => c.tenantId).sort()).toEqual([A, B, C].sort())
  })

  it('PATCH /tenants/:id fiscalYearEndMonth: admin only, own companies (404), 1-12 (400)', async () => {
    expect((await call('fin', 'PATCH', `/tenants/${C}`, { fiscalYearEndMonth: 12 })).statusCode).toBe(403)
    expect((await call('adminB', 'PATCH', `/tenants/${C}`, { fiscalYearEndMonth: 12 })).statusCode).toBe(404)
    expect((await call('ceo', 'PATCH', `/tenants/${C}`, { fiscalYearEndMonth: 13 })).statusCode).toBe(400)
    expect((await call('ceo', 'PATCH', `/tenants/${C}`, { fiscalYearEndMonth: 0 })).statusCode).toBe(400)
    const ok = await call('ceo', 'PATCH', `/tenants/${C}`, { fiscalYearEndMonth: 3 })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().fiscalYearEndMonth).toBe(3)
    const audit = await prisma.auditLog.findFirst({ where: { action: 'tenant.fiscal_year_end', entityId: C }, orderBy: { createdAt: 'desc' } })
    expect(audit).toMatchObject({ category: 'accounting', tenantId: C })
    // Back to the default before the close below.
    expect((await call('ceo', 'PATCH', `/tenants/${C}`, { fiscalYearEndMonth: 6 })).statusCode).toBe(200)
  })

  it('once the books are closed across a year end, a change needs a reason (409), is audited and flagged', async () => {
    await prisma.periodLock.create({ data: { tenantId: C, lockedThrough: parsePktEndOfDay('2026-07-31'), lockedBy: users.ceo!.id } })
    const refused = await call('ceo', 'PATCH', `/tenants/${C}`, { fiscalYearEndMonth: 12 })
    expect(refused.statusCode).toBe(409)
    expect(refused.json().error.code).toBe('FY_CHANGE_AFTER_YEAR_END_CLOSE')
    expect((await call('ceo', 'PATCH', `/tenants/${C}`, { fiscalYearEndMonth: 12, reason: 'short' })).statusCode).toBe(409)
    // Other profile fields still save without one.
    expect((await call('ceo', 'PATCH', `/tenants/${C}`, { name: 'FY Third Co' })).statusCode).toBe(200)
    const ok = await call('ceo', 'PATCH', `/tenants/${C}`, { fiscalYearEndMonth: 12, reason: 'The auditors moved us to a calendar year' })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().fiscalYearEndMonth).toBe(12)
    const audit = await prisma.auditLog.findFirst({ where: { action: 'tenant.fiscal_year_end', entityId: C }, orderBy: { createdAt: 'desc' } })
    expect(audit?.metadata).toMatchObject({ reason: 'The auditors moved us to a calendar year', afterYearEndClose: true })
    const flag = await prisma.exceptionFlag.findFirst({ where: { tenantId: C, entityType: 'Tenant', entityId: C } })
    expect(flag?.severity).toBe('high')
  })
})

describe('statements: other income and THE cost-of-sales definition', () => {
  it('42xx is other income; brand sales are 40xx net of 7010/7020; 5040/5050/5060 split by the stock behind them', async () => {
    const D = (await prisma.tenant.create({ data: { name: 'Cost Foods', slug: 'fyr-d' } })).id
    await ensureChartOfAccounts(D)
    const X = (await prisma.concept.create({ data: { name: 'Cost Cafe', slug: 'fyr-cost-cafe', type: 'restaurant', tenantId: D } })).id
    const at = new Date('2026-09-10T07:00:00Z')
    let k = 0
    const je = (lines: Array<{ accountCode: string; type: 'debit' | 'credit'; amountCents: number; conceptId?: string | null }>, sourceType = 'test.cos') =>
      postJournalEntry({ tenantId: D, sourceType, sourceId: `d${k++}`, description: sourceType, entryDate: at, lines })
    await je([{ accountCode: '1020', type: 'debit', amountCents: 100_000 }, { accountCode: '4001', type: 'credit', amountCents: 100_000, conceptId: X }])
    await je([{ accountCode: '7010', type: 'debit', amountCents: 5_000, conceptId: X }, { accountCode: '1020', type: 'credit', amountCents: 5_000 }])
    await je([{ accountCode: '1020', type: 'debit', amountCents: 10_000 }, { accountCode: '4110', type: 'credit', amountCents: 10_000, conceptId: X }])
    await je([{ accountCode: '2080', type: 'debit', amountCents: 20_000 }, { accountCode: '4200', type: 'credit', amountCents: 20_000 }])
    // Direct class costs.
    await je([{ accountCode: '5010', type: 'debit', amountCents: 30_000, conceptId: X }, { accountCode: '1210', type: 'credit', amountCents: 30_000, conceptId: X }])
    await je([{ accountCode: '5030', type: 'debit', amountCents: 4_000, conceptId: X }, { accountCode: '1230', type: 'credit', amountCents: 4_000, conceptId: X }])
    // Waste of drinks (5040 against 1220).
    await je([{ accountCode: '5040', type: 'debit', amountCents: 6_000, conceptId: X }, { accountCode: '1220', type: 'credit', amountCents: 6_000, conceptId: X }], 'inventory.waste')
    // One count: packaging short 2,000 (a missed "Box given"), food over 1,000.
    await je([
      { accountCode: '5050', type: 'debit', amountCents: 2_000, conceptId: X }, { accountCode: '1230', type: 'credit', amountCents: 2_000, conceptId: X },
      { accountCode: '1210', type: 'debit', amountCents: 1_000, conceptId: X }, { accountCode: '5050', type: 'credit', amountCents: 1_000, conceptId: X },
    ], 'inventory.count')
    // An untraceable cost adjustment stays in food.
    await je([{ accountCode: '5060', type: 'debit', amountCents: 500, conceptId: X }, { accountCode: '2010', type: 'credit', amountCents: 500 }])

    const from = parsePktStartOfDay('2026-09-01'), to = parsePktEndOfDay('2026-09-30')
    expect(await brandSalesRevenueCents(prisma, D, { from, to })).toBe(95_000)
    expect(await brandSalesRevenueCents(prisma, D, { from, to, conceptId: X })).toBe(95_000)
    expect(await costOfSalesSplit(prisma, D, { from, to, conceptId: X })).toEqual({ foodCents: 29_500, drinksCents: 6_000, packagingCents: 6_000 })
    expect(await costOfSalesSplit(prisma, D, { from, to })).toEqual({ foodCents: 29_500, drinksCents: 6_000, packagingCents: 6_000 })
    // Another company sees none of it.
    expect(await brandSalesRevenueCents(prisma, A, { from, to })).toBe(0)

    const pl = await profitAndLoss([D], from, to)
    expect(pl.totals.revenueCents).toBe(110_000)
    expect(pl.otherIncome.map((r) => r.code)).toEqual(['4200'])
    expect(pl.totals.otherIncomeCents).toBe(20_000)
    expect(pl.totals.netProfitCents).toBe(110_000 - 5_000 - 41_500 + 20_000)
    expect((await labourPctReport([D], from, to)).revenueCents).toBe(110_000)

    const bp = await brandPnl([D], from, to, [{ id: X, name: 'Cost Cafe' }])
    const row = bp.brands[0]!
    expect(row).toMatchObject({ brandSalesCents: 95_000, cogsCents: 41_500, foodCents: 29_500, drinksCents: 6_000, packagingCents: 6_000 })
    expect(row.costOfSalesPct).toBeCloseTo((41_500 / 95_000) * 100, 2)
    expect(bp.headOffice.otherIncomeCents).toBe(20_000)
    expect(bp.company.netProfitCents).toBe(pl.totals.netProfitCents)
  })
})
