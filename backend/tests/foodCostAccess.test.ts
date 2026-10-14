// /reports/food-cost — who reads it, and company separation (finance wave B).
//
// What this guards (every route of reports/foodCostRoutes.ts):
//   - company B gets 404 on company A's conceptId, locationId, tenantId and
//     inventoryItemId; the portfolio view returns one block per company;
//     an empty scope is refused (403), never read unscoped;
//   - roles and the module gate: foh_management (no food_cost) 403;
//     boh_management 200 with revenueHidden and no revenue / % fields;
//     finance and fnb_manager 200 with revenue; a CEO untick (moduleDeny) →
//     403; an 'accounting'-only finance reads the summary (the hub gauge) but
//     cannot POST align; align is the CEO's only (404 foreign, 409
//     CUTOVER_NOT_RUN / ALREADY_ALIGNED, dry run first);
//   - dates are PKT YYYY-MM-DD (400 BAD_DATE); CSV export hides revenue too.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import type { UserRole } from '@prisma/client'
import { prisma, mkCompany, type Company } from './connectorsFixtures.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError, errorResponse } from '../src/lib/errors.js'
import { invalidateModuleAccessCache } from '../src/lib/moduleAccess.js'
import { addLotTx, fifoCutoverKey } from '../src/lib/stockLedger.js'
import foodCostRoutes from '../src/modules/reports/foodCostRoutes.js'

const RUN = Date.now()
let app: FastifyInstance
let A: Company
let B: Company
let C: Company
let itemA: string
const tokens: Record<string, string> = {}

async function mkUser(key: string, role: UserRole, tenantId: string | null, o: { moduleDeny?: string[]; also?: string[] } = {}) {
  const u = await prisma.user.create({
    data: {
      name: key, email: `${key}.${RUN}@fcaccess.test`, password: await bcrypt.hash('x-Password-1', 4),
      role, isActive: true, accountStatus: 'active', tenantId, moduleDeny: o.moduleDeny ?? [],
    },
  })
  for (const t of [tenantId, ...(o.also ?? [])]) if (t) await prisma.tenantMember.create({ data: { tenantId: t, userId: u.id } })
  tokens[key] = `Bearer ${(issueStaffSession(u) as { accessToken: string }).accessToken}`
}
const call = (who: string, method: 'GET' | 'POST', url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { authorization: tokens[who]!, ...headers }, ...(payload !== undefined ? { payload: payload as object } : {}) })
const get = (who: string, url: string, headers: Record<string, string> = {}) => call(who, 'GET', url, undefined, headers)

const GET_ROUTES = () => [
  '/reports/food-cost/summary',
  '/reports/food-cost/ingredients',
  `/reports/food-cost/ingredients/${itemA}/movements`,
  '/reports/food-cost/valuation',
  '/reports/food-cost/flags',
  '/reports/food-cost/export.csv?view=summary',
]

beforeAll(async () => {
  invalidateModuleAccessCache()
  A = await mkCompany(`fca-a-${RUN}`)
  B = await mkCompany(`fca-b-${RUN}`)
  C = await mkCompany(`fca-c-${RUN}`)
  for (const t of [A.tenantId, B.tenantId]) await prisma.setting.create({ data: { key: fifoCutoverKey(t), value: new Date(RUN - 30 * 86_400_000).toISOString() } })
  itemA = (await prisma.inventoryItem.create({ data: { tenantId: A.tenantId, name: 'Rice A', unit: 'kg', category: 'dry_goods' } })).id
  // A lot the books never saw — the CEO's alignment has something to align.
  await prisma.$transaction((tx) => addLotTx(tx, {
    tenantId: A.tenantId, inventoryItemId: itemA, qty: 10, unitCostCents: 20_000, kind: 'opening', lotSourceType: 'opening', lotSourceId: `fca-${RUN}`,
    movementSourceType: 'test.opening', movementSourceId: `fca-${RUN}`, receivedAt: new Date(RUN - 2 * 86_400_000),
  }))
  await prisma.exceptionFlag.create({ data: { tenantId: A.tenantId, kind: 'stock_shortfall', title: 'Rice A sold beyond the lots', description: 'x', entityType: 'InventoryItem', entityId: itemA } })

  await mkUser('ceo', 'admin', A.tenantId, { also: [B.tenantId, C.tenantId] })
  await mkUser('finance', 'finance', A.tenantId)
  await mkUser('financeB', 'finance', B.tenantId)
  await mkUser('fnb', 'fnb_manager', A.tenantId)
  await mkUser('boh', 'boh_management', A.tenantId)
  await mkUser('bohB', 'boh_management', B.tenantId)
  await mkUser('foh', 'foh_management', A.tenantId)
  await mkUser('bohUnticked', 'boh_management', A.tenantId, { moduleDeny: ['food_cost'] })
  await mkUser('financeAcct', 'finance', A.tenantId, { moduleDeny: ['food_cost'] })
  await mkUser('cashier', 'cashier', A.tenantId)
  await mkUser('nobody', 'finance', null)

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(foodCostRoutes, { prefix: '/reports/food-cost' })
  await app.ready()
}, 60_000)

afterAll(async () => { await app?.close() })

describe('roles and the module gate', () => {
  it('finance and fnb_manager read every route, with revenue', async () => {
    for (const who of ['finance', 'fnb']) {
      for (const url of GET_ROUTES()) expect((await get(who, url)).statusCode, `${who} ${url}`).toBe(200)
      const s = (await get(who, '/reports/food-cost/summary')).json() as { revenueHidden: boolean; companies: Array<Record<string, unknown>> }
      expect(s.revenueHidden).toBe(false)
      expect(s.companies).toHaveLength(1)
      expect(s.companies[0]).toHaveProperty('revenueCents')
      expect(s.companies[0]).toHaveProperty('actualPct')
    }
  })

  it('boh_management reads it with revenueHidden and no revenue or % fields (CSV too)', async () => {
    for (const url of GET_ROUTES()) expect((await get('boh', url)).statusCode, url).toBe(200)
    const s = (await get('boh', '/reports/food-cost/summary')).json() as { revenueHidden: boolean; companies: Array<Record<string, unknown> & { brands: Array<Record<string, unknown>>; mcByOrderType: Array<Record<string, unknown>> }> }
    expect(s.revenueHidden).toBe(true)
    const c = s.companies[0]!
    for (const k of ['revenueCents', 'targetPct', 'theoreticalPct', 'actualPct', 'avtPoints']) expect(k in c, k).toBe(false)
    for (const b of c.brands) expect('revenueCents' in b).toBe(false)
    for (const m of c.mcByOrderType) expect('itemSalesCents' in m).toBe(false)
    expect(c).toHaveProperty('theoretical')
    const csv = (await get('boh', '/reports/food-cost/export.csv?view=summary')).body
    expect(csv.split('\n')[0]).not.toContain('Brand sales')
    const finCsv = await get('finance', '/reports/food-cost/export.csv?view=summary')
    expect(finCsv.headers['content-type']).toContain('text/csv')
    expect(finCsv.body.split('\n')[0]).toContain('Brand sales')
  })

  it('foh_management (no food_cost), a CEO untick and the cashier get 403', async () => {
    for (const who of ['foh', 'bohUnticked', 'cashier']) {
      for (const url of GET_ROUTES()) expect((await get(who, url)).statusCode, `${who} ${url}`).toBe(403)
    }
  })

  it('an accounting-only finance reads the summary (the hub gauge) but cannot align; align is the CEO\'s', async () => {
    expect((await get('financeAcct', '/reports/food-cost/summary')).statusCode).toBe(200)
    for (const who of ['financeAcct', 'finance', 'fnb', 'boh']) {
      expect((await call(who, 'POST', '/reports/food-cost/align-inventory', { tenantId: A.tenantId })).statusCode, who).toBe(403)
    }
  })

  it('an operator with no company is refused, never read unscoped', async () => {
    const r = await get('nobody', '/reports/food-cost/summary')
    expect(r.statusCode).toBe(403)
    expect(r.json().error.code).toBe('NO_COMPANY_SCOPE')
  })

  it('dates are PKT days: a bad date is 400 BAD_DATE', async () => {
    for (const q of ['from=2026-02-30', 'to=yesterday', 'from=2026-10-10&to=2026-10-01']) {
      const r = await get('finance', `/reports/food-cost/summary?${q}`)
      expect(r.statusCode, q).toBe(400)
      expect(r.json().error.code).toBe('BAD_DATE')
    }
    expect((await get('finance', '/reports/food-cost/summary?from=2026-10-01&to=2026-10-10')).statusCode).toBe(200)
  })
})

describe('company separation', () => {
  it('company B gets 404 on company A\'s brand, outlet, company and item', async () => {
    for (const who of ['financeB', 'bohB']) {
      for (const url of [
        `/reports/food-cost/summary?conceptId=${A.conceptId}`,
        `/reports/food-cost/summary?locationId=${A.locationId}`,
        `/reports/food-cost/ingredients?tenantId=${A.tenantId}`,
        `/reports/food-cost/ingredients?conceptId=${A.conceptId}`,
        `/reports/food-cost/ingredients/${itemA}/movements`,
        `/reports/food-cost/valuation?tenantId=${A.tenantId}`,
        `/reports/food-cost/flags?tenantId=${A.tenantId}`,
        `/reports/food-cost/export.csv?view=ingredients&tenantId=${A.tenantId}`,
        `/reports/food-cost/export.csv?view=summary&conceptId=${A.conceptId}`,
      ]) expect((await get(who, url)).statusCode, `${who} ${url}`).toBe(404)
    }
  })

  it('each company reads only its own rows', async () => {
    const a = (await get('finance', '/reports/food-cost/flags')).json() as { tenantId: string; flags: Array<{ entityId: string }> }
    expect(a.tenantId).toBe(A.tenantId)
    expect(a.flags.map((f) => f.entityId)).toContain(itemA)
    const b = (await get('financeB', '/reports/food-cost/flags')).json() as { tenantId: string; flags: unknown[] }
    expect(b.tenantId).toBe(B.tenantId)
    expect(b.flags).toEqual([])
    const ing = (await get('financeB', '/reports/food-cost/ingredients')).json() as { rows: Array<{ inventoryItemId: string }> }
    expect(ing.rows.map((r) => r.inventoryItemId)).not.toContain(itemA)
    const s = (await get('financeB', '/reports/food-cost/summary')).json() as { companies: Array<{ tenantId: string }> }
    expect(s.companies.map((c) => c.tenantId)).toEqual([B.tenantId])
  })

  it('the portfolio view returns one block per company, never blended', async () => {
    const s = (await get('ceo', '/reports/food-cost/summary', { 'x-servd-portfolio': '1' })).json() as { companies: Array<{ tenantId: string }> }
    expect(s.companies.map((c) => c.tenantId).sort()).toEqual([A.tenantId, B.tenantId, C.tenantId].sort())
    // A brand narrows it to that brand's company.
    const one = (await get('ceo', `/reports/food-cost/summary?conceptId=${B.conceptId}`, { 'x-servd-portfolio': '1' })).json() as { companies: Array<{ tenantId: string }> }
    expect(one.companies.map((c) => c.tenantId)).toEqual([B.tenantId])
    // In portfolio view a per-company tab must name its company.
    expect((await get('ceo', '/reports/food-cost/valuation', { 'x-servd-portfolio': '1' })).statusCode).toBe(200)
    expect((await get('ceo', `/reports/food-cost/valuation?tenantId=${B.tenantId}`, { 'x-servd-portfolio': '1' })).json().tenantId).toBe(B.tenantId)
  })
})

describe('the CEO aligns inventory with the lots', () => {
  it('dry run first, then once; another company is 404; not cut over is 409', async () => {
    const dry = await call('ceo', 'POST', '/reports/food-cost/align-inventory', { tenantId: A.tenantId })
    expect(dry.statusCode).toBe(200)
    expect(dry.json()).toMatchObject({ tenantId: A.tenantId, dryRun: true, posted: false, byClass: { food: 200_000, beverage: 0, packaging: 0 } })
    expect(await prisma.journalEntry.count({ where: { tenantId: A.tenantId, reference: `inventory.fifo_align:${A.tenantId}` } })).toBe(0)

    const foreign = await prisma.tenant.create({ data: { name: 'Not mine', slug: `fca-x-${RUN}` } })
    expect((await call('ceo', 'POST', '/reports/food-cost/align-inventory', { tenantId: foreign.id })).statusCode).toBe(404)
    const notCut = await call('ceo', 'POST', '/reports/food-cost/align-inventory', { tenantId: C.tenantId })
    expect(notCut.statusCode).toBe(409)
    expect(notCut.json().error.code).toBe('CUTOVER_NOT_RUN')

    const real = await call('ceo', 'POST', '/reports/food-cost/align-inventory', { tenantId: A.tenantId, dryRun: false })
    expect(real.statusCode).toBe(200)
    expect(real.json()).toMatchObject({ posted: true, byClass: { food: 200_000 } })
    expect(await prisma.auditLog.count({ where: { action: 'inventory.fifo_align', tenantId: A.tenantId } })).toBe(1)
    const again = await call('ceo', 'POST', '/reports/food-cost/align-inventory', { tenantId: A.tenantId, dryRun: false })
    expect(again.statusCode).toBe(409)
    expect(again.json().error.code).toBe('ALREADY_ALIGNED')
    // The valuation now ties (the difference went to retained earnings, never cost of sales).
    const v = (await get('ceo', `/reports/food-cost/valuation?tenantId=${A.tenantId}`)).json() as { ties: boolean; cutover: { aligned: boolean } }
    expect(v.ties).toBe(true)
    expect(v.cutover.aligned).toBe(true)
  })
})
