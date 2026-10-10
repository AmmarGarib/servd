// The P&L, the transaction feed, the sales KPIs and the daily sales email,
// each reconciled onto one implementation.
//
// What this guards:
//   - ONE P&L, from the ledger: GET /accounting/pl (the FinancialEntry "P&L")
//     is gone, /accounting/pl-ledger/brands gives the by-brand view, and the
//     CEO executive overview takes brand AND company revenue from the ledger
//     (no silent fallback to order gross), net revenue = revenue − contra,
//     and "tax collected" = ledger output tax (what the return files).
//   - ONE transaction feed: GET /accounting/ledger with ?id= and a cursor that
//     pages in (date, id) order; the activity feed only shows the books' own
//     trail, of the companies in view, to the roles allowed to read it.
//   - ONE implementation of each sales KPI (reports/service.ts) behind /reports
//     and /management: top-item revenue is Σ price × qty, not SUM × SUM. Sales
//     are the completed ORDERS (the FinancialEntry register has had no writer
//     since decision 39 — BOOKS-01; tests/auditReports.test.ts ties them to
//     the ledger P&L).
//   - ONE daily sales email (the scheduled report): per company, PKT day,
//     same figures as /reports/sales, with top items and channels.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { postJournalEntry } from '../src/modules/accounting/journal.js'
import { enforceModuleAccess } from '../src/lib/moduleAccess.js'
import { buildDailySalesReport, carryOverDigestRecipient } from '../src/workers/scheduledReports.js'
import { accountingRoutes } from '../src/modules/accounting/routes.js'
import { managementRoutes } from '../src/modules/management/routes.js'
import { reportRoutes } from '../src/modules/reports/routes.js'

let tenantA: string
let tenantB: string
let conceptA: string
let conceptA2: string
let conceptB: string
let app: FastifyInstance
const users: Record<string, { id: string; token: string }> = {}

async function mkUser(key: string, role: string, primary: string, members: string[]) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.reportstest@gsfoods.pk`, password: await bcrypt.hash('x-Password-1', 4), role: role as never, isActive: true, accountStatus: 'active', tenantId: primary },
  })
  for (const t of members) await prisma.tenantMember.create({ data: { tenantId: t, userId: u.id } as never }).catch(() => {})
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}

const get = (who: string, url: string) =>
  app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${users[who]!.token}` } })

// A period far from "now" so other suites' postings never land in it.
const DAY = '2026-06-10'
const AT = new Date(`${DAY}T12:00:00+05:00`)
const RANGE = `dateFrom=${DAY}&dateTo=${DAY}`
const ISO_RANGE = `dateFrom=${DAY}T00:00:00%2B05:00&dateTo=${DAY}T23:59:59%2B05:00`

// A completed order — what every sales figure reads (BOOKS-01).
async function sale(conceptId: string, grossCents: number, taxCents: number, discountCents: number, completedAt = AT, channel: 'pos' | 'servd' = 'pos') {
  return prisma.order.create({ data: { conceptId, source: channel, status: 'completed', totalCents: grossCents, taxCents, discountCents, placedAt: completedAt, completedAt } })
}

beforeAll(async () => {
  tenantB = (await prisma.tenant.create({ data: { name: 'Rep B', slug: 'rep-b' } })).id
  tenantA = (await prisma.tenant.create({ data: { name: 'Rep A', slug: 'rep-a' } })).id
  await ensureChartOfAccounts(tenantA)
  await ensureChartOfAccounts(tenantB)
  conceptA  = (await prisma.concept.create({ data: { name: 'Rep Cafe',  slug: 'simmer', type: 'restaurant', tenantId: tenantA } })).id
  conceptA2 = (await prisma.concept.create({ data: { name: 'Rep Diner', slug: 'flipd',  type: 'restaurant', tenantId: tenantA } })).id
  conceptB  = (await prisma.concept.create({ data: { name: 'Rep Grill', slug: 'rep-grill-b', type: 'restaurant', tenantId: tenantB } })).id
  await mkUser('ceo', 'admin', tenantA, [tenantA])
  await mkUser('mgmt', 'management', tenantA, [tenantA])
  await mkUser('fin', 'finance', tenantA, [tenantA])
  await mkUser('fnb', 'fnb_manager', tenantA, [tenantA])

  // Ledger for A on DAY: simmer sells 10,000 (discount 1,000, GST 1,500,
  // COGS 3,000); flipd sells 5,000; 2,000 of shared rent.
  await postJournalEntry({
    tenantId: tenantA, sourceType: 'test.sale', sourceId: 'simmer-1', description: 'simmer sale', entryDate: AT,
    lines: [
      { accountCode: '1010', type: 'debit',  amountCents: 10_500, conceptId: conceptA },
      { accountCode: '7010', type: 'debit',  amountCents:  1_000, conceptId: conceptA },
      { accountCode: '4001', type: 'credit', amountCents: 10_000, conceptId: conceptA },
      { accountCode: '2030', type: 'credit', amountCents:  1_500, conceptId: conceptA },
      { accountCode: '5010', type: 'debit',  amountCents:  3_000, conceptId: conceptA },
      { accountCode: '1210', type: 'credit', amountCents:  3_000, conceptId: conceptA },
    ],
  })
  await postJournalEntry({
    tenantId: tenantA, sourceType: 'test.sale', sourceId: 'flipd-1', description: 'flipd sale', entryDate: AT,
    lines: [
      { accountCode: '1010', type: 'debit',  amountCents: 5_000, conceptId: conceptA2 },
      { accountCode: '4004', type: 'credit', amountCents: 5_000, conceptId: conceptA2 },
    ],
  })
  await postJournalEntry({
    tenantId: tenantA, sourceType: 'test.rent', sourceId: 'rent-1', description: 'rent', entryDate: AT,
    lines: [
      { accountCode: '6010', type: 'debit',  amountCents: 2_000 },
      { accountCode: '1020', type: 'credit', amountCents: 2_000 },
    ],
  })
  // B's books on the same day must never show up in A.
  await postJournalEntry({
    tenantId: tenantB, sourceType: 'test.sale', sourceId: 'b-1', description: 'B sale', entryDate: AT,
    lines: [
      { accountCode: '1010', type: 'debit',  amountCents: 99_000, conceptId: conceptB },
      { accountCode: '4090', type: 'credit', amountCents: 99_000, conceptId: conceptB },
    ],
  })

  // Orders for A on DAY (deliberately NOT the ledger's figures).
  await sale(conceptA, 50_000, 6_000, 2_000)
  await sale(conceptA2, 20_000, 2_000, 0, AT, 'servd')
  await sale(conceptB, 70_000, 9_000, 0)

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(accountingRoutes, { prefix: '/accounting' })
  await app.register(managementRoutes, { prefix: '/management' })
  await app.register(reportRoutes, { prefix: '/reports' })
  await app.ready()
})

afterAll(async () => {
  await app.close()
})

// ─── One P&L ─────────────────────────────────────────────────────────────────

describe('one P&L, from the ledger', () => {
  it('the FinancialEntry P&L is gone', async () => {
    expect((await get('ceo', `/accounting/pl?${RANGE}`)).statusCode).toBe(404)
    expect((await get('ceo', `/management/brand-pl?${RANGE}`)).statusCode).toBe(404)
  })

  it('the by-brand tab measures each brand and keeps the shared bucket apart', async () => {
    const res = await get('fin', `/accounting/pl-ledger/brands?${RANGE}`)
    expect(res.statusCode).toBe(200)
    const r = res.json() as { brands: Array<{ conceptId: string; revenueCents: number; contraRevenueCents: number; cogsCents: number; netProfitCents: number }>; shared: { opexCents: number } | null; totals: { revenueCents: number; netProfitCents: number } }
    const simmer = r.brands.find((b) => b.conceptId === conceptA)!
    expect(simmer).toMatchObject({ revenueCents: 10_000, contraRevenueCents: 1_000, cogsCents: 3_000, netProfitCents: 6_000 })
    expect(r.brands.find((b) => b.conceptId === conceptA2)!.revenueCents).toBe(5_000)
    expect(r.brands.some((b) => b.conceptId === conceptB)).toBe(false)
    expect(r.shared?.opexCents).toBe(2_000)
    expect(r.totals.revenueCents).toBe(15_000)
    expect(r.totals.netProfitCents).toBe(15_000 - 1_000 - 3_000 - 2_000)
  })

  it('P&L access: the P&L module alone opens the P&L, not the rest of the books', async () => {
    const plOnly = { role: 'foh_management' as const, moduleAllow: ['finance_pl'] }
    await expect(enforceModuleAccess('/api/v1/accounting/pl-ledger?x=1', plOnly)).resolves.toBeUndefined()
    await expect(enforceModuleAccess('/api/v1/accounting/pl-ledger/brands', plOnly)).resolves.toBeUndefined()
    await expect(enforceModuleAccess('/api/v1/accounting/trial-balance', plOnly)).rejects.toThrow()
  })

  it('the CEO overview takes revenue, net revenue and tax from the ledger; sales come from the orders and say so', async () => {
    const res = await get('ceo', `/management/executive-overview?${ISO_RANGE}`)
    expect(res.statusCode).toBe(200)
    const ov = res.json() as {
      pl: { company: { revenueCents: number; netRevenueCents: number; grossProfitCents: number }; brands: Array<{ conceptId: string; revenueCents: number; grossProfitCents: number; opexCents: number }> }
      netRevenueCents: number; taxCollectedCents: number
      sales: { totals: { gross: number; orders: number }; basis: string }
    }
    expect(ov.pl.company.revenueCents).toBe(15_000)
    expect(ov.netRevenueCents).toBe(15_000 - 1_000)
    expect(ov.taxCollectedCents).toBe(1_500)
    const simmer = ov.pl.brands.find((b) => b.conceptId === conceptA)!
    // Ledger revenue, not order gross (50,000); discount taken once.
    expect(simmer.revenueCents).toBe(10_000)
    expect(simmer.grossProfitCents).toBe(10_000 - 1_000 - 3_000)
    // Shared rent is spread by LEDGER revenue share: 10,000 / 15,000.
    expect(simmer.opexCents).toBe(Math.round(2_000 * (10_000 / 15_000)))
    expect(ov.sales).toMatchObject({ basis: 'completed_orders', totals: { gross: 70_000, orders: 2 } })
  })

  it('a brand view reports that brand\'s ledger net revenue', async () => {
    const res = await get('ceo', `/management/executive-overview?${ISO_RANGE}&conceptId=${conceptA}`)
    expect((res.json() as { netRevenueCents: number }).netRevenueCents).toBe(9_000)
  })

  it('no ledger revenue means zero revenue — never the orders\' gross', async () => {
    const res = await get('ceo', '/management/executive-overview?dateFrom=2026-01-01T00:00:00Z&dateTo=2026-01-02T00:00:00Z')
    const ov = res.json() as { pl: { company: { revenueCents: number } } }
    expect(ov.pl.company.revenueCents).toBe(0)
  })
})

// ─── One transaction feed ────────────────────────────────────────────────────

describe('the ledger feed', () => {
  it('?id= returns that one entry, in scope only', async () => {
    const one = await prisma.journalEntry.findFirstOrThrow({ where: { tenantId: tenantA, reference: 'test.rent:rent-1' } })
    const res = await get('fin', `/accounting/ledger?id=${one.id}`)
    expect((res.json() as { data: Array<{ id: string }> }).data.map((e) => e.id)).toEqual([one.id])
    const foreign = await prisma.journalEntry.findFirstOrThrow({ where: { tenantId: tenantB } })
    expect((await get('fin', `/accounting/ledger?id=${foreign.id}`)).json().data).toEqual([])
  })

  it('pages through the period without skipping or repeating', async () => {
    const seen: string[] = []
    let cursor: string | null = null
    for (let i = 0; i < 5; i++) {
      const res = await get('fin', `/accounting/ledger?${RANGE}&limit=1${cursor ? `&cursor=${cursor}` : ''}`)
      const page = res.json() as { data: Array<{ id: string }>; cursor: string | null; hasMore: boolean }
      seen.push(...page.data.map((e) => e.id))
      if (!page.hasMore) break
      cursor = page.cursor
    }
    expect(seen).toHaveLength(3)
    expect(new Set(seen).size).toBe(3)
  })

  it('the activity feed shows the books\' trail only, and only to the roles that may read it', async () => {
    await prisma.auditLog.create({ data: { category: 'accounting', action: 'period.close', entity: 'PeriodLock', tenantId: tenantA } })
    await prisma.auditLog.create({ data: { category: 'identity', action: 'user.create', entity: 'User', tenantId: tenantA } })
    await prisma.auditLog.create({ data: { category: 'accounting', action: 'journal.manual', entity: 'JournalEntry', tenantId: tenantB } })

    const mgmt = (await get('mgmt', '/accounting/activity-feed?limit=50')).json() as { feed: Array<{ kind: string; payload: { action?: string } }> }
    const actions = mgmt.feed.filter((f) => f.kind === 'audit').map((f) => f.payload.action)
    expect(actions).toEqual(['period.close'])

    const fin = (await get('fin', '/accounting/activity-feed?limit=50')).json() as { feed: Array<{ kind: string }> }
    expect(fin.feed.some((f) => f.kind === 'audit')).toBe(false)
  })
})

// ─── One implementation of each sales KPI ────────────────────────────────────

describe('sales KPIs — one implementation behind /reports and /management', () => {
  it('top-item revenue is Σ price × qty on both, and they agree', async () => {
    const at = new Date(`${DAY}T13:00:00+05:00`)
    const category = await prisma.category.create({ data: { conceptId: conceptA, name: 'Rep Drinks' } })
    const item = await prisma.menuItem.create({ data: { conceptId: conceptA, categoryId: category.id, name: 'Rep Latte', priceCents: 50_000 } })
    for (let i = 0; i < 3; i++) {
      await prisma.order.create({
        data: { conceptId: conceptA, source: 'pos', status: 'completed', totalCents: 50_000, placedAt: at,
          items: { create: [{ menuItemId: item.id, name: 'Rep Latte', quantity: 1, unitPriceCents: 50_000 }] } },
      })
    }
    const reports = (await get('fnb', `/reports/top-items?${ISO_RANGE}&conceptId=${conceptA}`)).json() as Array<{ name: string; quantity: number; revenueCents: number }>
    const fnb = (await get('fnb', `/management/fnb-metrics?${ISO_RANGE}&conceptId=${conceptA}`)).json() as { topItems: Array<{ name: string; quantity: number; revenueCents: number }>; kitchen: { stations: unknown[] } }
    const r = reports.find((x) => x.name === 'Rep Latte')!
    const f = fnb.topItems.find((x) => x.name === 'Rep Latte')!
    expect(r).toMatchObject({ quantity: 3, revenueCents: 150_000 })
    expect(f).toMatchObject({ quantity: 3, revenueCents: 150_000 })
  })

  it('station times: one rounding rule on both surfaces', async () => {
    const at = new Date(`${DAY}T14:00:00+05:00`)
    const station = await prisma.station.create({ data: { conceptId: conceptA, name: 'Rep Grill Station' } })
    const fired = new Date(at.getTime())
    await prisma.order.create({
      data: { conceptId: conceptA, source: 'pos', status: 'completed', totalCents: 1_000, placedAt: at,
        items: { create: [
          { name: 'A', quantity: 1, unitPriceCents: 1_000, stationId: station.id, status: 'bumped', firedAt: fired, completedAt: new Date(fired.getTime() + 7 * 60_000 + 20_000) },
          { name: 'B', quantity: 1, unitPriceCents: 1_000, stationId: station.id, status: 'bumped', firedAt: fired, completedAt: new Date(fired.getTime() + 4 * 60_000) },
        ] } },
    })
    const rep = (await get('fnb', `/reports/stations?${ISO_RANGE}&conceptId=${conceptA}`)).json() as Array<{ stationName: string; avgMinutes: number }>
    const fnb = (await get('fnb', `/management/fnb-metrics?${ISO_RANGE}&conceptId=${conceptA}`)).json() as { kitchen: { stations: Array<{ stationName: string; avgMinutes: number }> } }
    const a = rep.find((s) => s.stationName === 'Rep Grill Station')!.avgMinutes
    const b = fnb.kitchen.stations.find((s) => s.stationName === 'Rep Grill Station')!.avgMinutes
    expect(a).toBe(5.7)
    expect(b).toBe(a)
  })

  it('the unused copies are gone', async () => {
    expect((await get('fnb', `/reports/ticket-times?${ISO_RANGE}`)).statusCode).toBe(404)
    expect((await get('ceo', `/reports/series?${ISO_RANGE}`)).statusCode).toBe(404)
  })

  it('/reports/sales and the brand dashboard read the same totals, company-scoped', async () => {
    const sales = (await get('ceo', `/reports/sales?${ISO_RANGE}`)).json() as { totals: { gross: number; orders: number } }
    const brand = (await get('ceo', `/management/brand-metrics?${ISO_RANGE}`)).json() as { revenue: { grossCents: number; orders: number } }
    // Every completed order of A's on DAY: the two sales (70,000), the three
    // lattes (150,000) and the station ticket (1,000) — never B's 70,000.
    expect(sales.totals).toMatchObject({ gross: 221_000, orders: 6 })
    expect(brand.revenue).toMatchObject({ grossCents: 221_000, orders: 6 })
  })
})

// ─── One daily sales email ───────────────────────────────────────────────────

describe('the daily sales email is the scheduled report', () => {
  it('covers yesterday in PKT for one company, with top items and channels', async () => {
    // "Now" is 00:05 PKT on the 11th, so yesterday is DAY. An order completed
    // at 23:30 PKT on DAY is in; one at 00:30 PKT on the 11th is not.
    const now = new Date('2026-06-11T00:05:00+05:00')
    await sale(conceptA, 1_234_500, 0, 0, new Date(`${DAY}T23:30:00+05:00`))
    await sale(conceptA, 9_999_900, 0, 0, new Date('2026-06-11T00:30:00+05:00'))
    const { subject, html } = await buildDailySalesReport(null, tenantA, now)
    expect(subject).toContain('10 June')
    // 2 from setup + 3 lattes + the station ticket + the 23:30 one
    expect(html).toContain('<strong>7</strong> completed orders')
    expect(html).toContain('PKR 14,555')                             // 70,000 + 150,000 + 1,000 + 1,234,500 paisa
    expect(html).not.toContain('Net:')
    expect(html).toContain('Rep Latte')                              // top items
    expect(html).toMatch(/servd<\/td><td>1 orders/)                  // channel breakdown
    expect(html).not.toContain('Rep Grill')                          // never another company's
  })

  it('carries DIGEST_EMAIL over once per company, never over an operator\'s own schedule', async () => {
    await prisma.scheduledReport.create({ data: { tenantId: tenantB, name: 'Mine', reportType: 'sales_daily', cron: '0 9 * * *', recipients: ['b@x.pk'], deletedAt: new Date(), isActive: false } })
    const prev = process.env['DIGEST_EMAIL']
    process.env['DIGEST_EMAIL'] = 'owner@gsfoods.pk'
    try {
      const first = await carryOverDigestRecipient()
      const again = await carryOverDigestRecipient()
      expect(first).toContain('rep-a')
      expect(first).not.toContain('rep-b')
      expect(again).toEqual([])
      const rowA = await prisma.scheduledReport.findFirstOrThrow({ where: { tenantId: tenantA, reportType: 'sales_daily' } })
      expect(rowA).toMatchObject({ recipients: ['owner@gsfoods.pk'], cron: '5 0 * * *', conceptId: null, isActive: true })
    } finally {
      if (prev === undefined) delete process.env['DIGEST_EMAIL']; else process.env['DIGEST_EMAIL'] = prev
    }
  })
})
