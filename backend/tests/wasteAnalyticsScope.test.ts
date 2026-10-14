// GET /inventory/waste-analytics — company scope (finance wave B).
//
// What this guards:
//   - The view-aware company scope: a single-company view sees only that
//     company's waste; the portfolio header widens to the operator's own
//     companies; company-less items' waste is never included.
//   - An empty scope sees nothing (never "no filter").
//   - Finance reads it; the line cook does not (UI-10).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { AppError } from '../src/lib/errors.js'
import { inventoryRoutes } from '../src/modules/inventory/routes.js'
import { mkCompany, mkUser, type Company, type Who } from './connectorsFixtures.js'

let app: FastifyInstance
let A: Company
let B: Company
const u: Record<string, Who> = {}

const call = (who: Who, url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${who.token}`, ...headers } })

async function waste(tenantId: string | null, name: string, costCents: number, reason = 'spoilage') {
  const item = await prisma.inventoryItem.create({ data: { name, unit: 'kg', tenantId } })
  await prisma.wasteLog.create({ data: { inventoryItemId: item.id, tenantId, quantity: 1, unit: 'kg', reason, estimatedCostCents: costCents } })
  return item
}
type Analytics = { totals: { logs: number; totalCostCents: number | null }; topItems: Array<{ id: string; name: string }> }

beforeAll(async () => {
  A = await mkCompany('wastean-a')
  B = await mkCompany('wastean-b')
  u.finA = await mkUser('finA', 'finance', A.tenantId)
  u.finB = await mkUser('finB', 'finance', B.tenantId)
  u.finAB = await mkUser('finAB', 'finance', B.tenantId)
  await prisma.tenantMember.create({ data: { tenantId: A.tenantId, userId: u.finAB.id } })
  u.nobody = await mkUser('nobody', 'finance', null)
  u.cookA = await mkUser('cookA', 'boh', A.tenantId)
  u.mgrA = await mkUser('mgrA', 'manager', A.tenantId)
  await waste(A.tenantId, 'A beef', 30_000)
  await waste(B.tenantId, 'B chicken', 7_000, 'expired')
  await waste(null, 'Orphan ghee', 99_000)
  // A pre-wave-B log with no company of its own: its item's company decides.
  const legacy = await prisma.inventoryItem.create({ data: { name: 'B legacy rice', unit: 'kg', tenantId: B.tenantId } })
  await prisma.wasteLog.create({ data: { inventoryItemId: legacy.id, quantity: 1, unit: 'kg', reason: 'other', estimatedCostCents: 1_000 } })
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(inventoryRoutes, { prefix: '/inventory' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  await app?.close()
})

describe('waste analytics scope', () => {
  it('B\'s finance sees only B\'s waste — never A\'s or a company-less item\'s', async () => {
    const res = await call(u.finB!, '/inventory/waste-analytics')
    expect(res.statusCode, res.body).toBe(200)
    const body = res.json() as Analytics
    expect(body.topItems.map((i) => i.name).sort()).toEqual(['B chicken', 'B legacy rice'])
    expect(body.totals).toMatchObject({ logs: 2, totalCostCents: 8_000 })
  })

  it('a member of both, in single-company view of B, sees B only; the portfolio view adds A, never the orphan', async () => {
    const single = (await call(u.finAB!, '/inventory/waste-analytics')).json() as Analytics
    expect(single.topItems.map((i) => i.name).sort()).toEqual(['B chicken', 'B legacy rice'])
    const portfolio = (await call(u.finAB!, '/inventory/waste-analytics', { 'x-servd-portfolio': '1' })).json() as Analytics
    expect(portfolio.topItems.map((i) => i.name).sort()).toEqual(['A beef', 'B chicken', 'B legacy rice'])
    expect(portfolio.totals.totalCostCents).toBe(38_000)
    const mgr = (await call(u.mgrA!, '/inventory/waste-analytics')).json() as Analytics
    expect(mgr.topItems.map((i) => i.name)).toEqual(['A beef'])
  })

  it('an empty scope sees nothing; the line cook is refused', async () => {
    const res = await call(u.nobody!, '/inventory/waste-analytics')
    expect(res.statusCode).toBe(200)
    expect((res.json() as Analytics).totals).toMatchObject({ logs: 0, totalCostCents: 0 })
    expect((await call(u.cookA!, '/inventory/waste-analytics')).statusCode).toBe(403)
    expect((await call(u.finA!, '/inventory/waste-analytics?from=nonsense')).statusCode).toBe(400)
  })
})
