// The ingredient master on FIFO lots (finance wave B) — POST/PATCH/GET /inventory.
//
// What this guards:
//   - category is the fixed list (400 otherwise); a change that moves the item
//     to another cost class moves its open lots' value with it, once:
//     'inventory.item_reclass:<itemId>:<auditLogId>' Dr new class / Cr old.
//   - unitCostCents is a typed estimate only while the item has no lots (422
//     COST_FROM_DELIVERIES after that); costSource follows.
//   - issue-on-receipt: managers only, audited.
//   - GET: onHandValueCents for the financial viewers and stock keepers only;
//     the line cook sees no cost; B gets 404 on A's item.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { AppError } from '../src/lib/errors.js'
import { addLotTx, ensureFifoReady } from '../src/lib/stockLedger.js'
import { inventoryRoutes } from '../src/modules/inventory/routes.js'
import { mkCompany, mkUser, type Company, type Who } from './connectorsFixtures.js'

const DAY = 86_400_000
let app: FastifyInstance
let A: Company
let B: Company
const u: Record<string, Who> = {}
let seq = 0

const call = (who: Who, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}), headers: { authorization: `Bearer ${who.token}` } })

async function item(co: Company, o: { qty?: number; cost?: number; category?: string } = {}) {
  await ensureFifoReady(co.tenantId)
  const it = await prisma.inventoryItem.create({ data: { name: `Master item ${++seq}`, unit: 'kg', tenantId: co.tenantId, unitCostCents: o.cost ?? 10_000, category: o.category ?? 'protein' } })
  if (o.qty) {
    await prisma.$transaction((tx) => addLotTx(tx, {
      tenantId: co.tenantId, inventoryItemId: it.id, qty: o.qty!, unitCostCents: o.cost ?? 10_000, kind: 'fifo_cutover', lotSourceType: 'fifo_cutover',
      lotSourceId: `seed:${it.id}`, movementSourceType: 'test.seed', movementSourceId: it.id, receivedAt: new Date(Date.now() - DAY),
    }))
  }
  return it
}
const reclassEntries = (itemId: string) => prisma.journalEntry.findMany({
  where: { reference: { startsWith: `inventory.item_reclass:${itemId}:` } },
  include: { lines: { include: { account: { select: { code: true } } } } },
  orderBy: { createdAt: 'asc' },
})

beforeAll(async () => {
  A = await mkCompany('master-a')
  B = await mkCompany('master-b')
  u.mgrA = await mkUser('mgrA', 'manager', A.tenantId)
  u.buyerA = await mkUser('buyerA', 'procurement', A.tenantId)
  u.cookA = await mkUser('cookA', 'boh', A.tenantId)
  u.finA = await mkUser('finA', 'finance', A.tenantId)
  u.mgrB = await mkUser('mgrB', 'manager', B.tenantId)
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

describe('category and cost class', () => {
  it('a class-crossing change moves the lots\' value once; inside a class nothing posts', async () => {
    const it0 = await item(A, { qty: 5, cost: 10_000 })
    const same = await call(u.mgrA!, 'PATCH', `/inventory/${it0.id}`, { category: 'produce' })
    expect(same.statusCode, same.body).toBe(200)
    expect(await reclassEntries(it0.id)).toHaveLength(0)

    const toDrinks = await call(u.mgrA!, 'PATCH', `/inventory/${it0.id}`, { category: 'beverage' })
    expect(toDrinks.statusCode, toDrinks.body).toBe(200)
    let es = await reclassEntries(it0.id)
    expect(es).toHaveLength(1)
    expect(es[0]!.tenantId).toBe(A.tenantId)
    expect(es[0]!.lines.map((l) => [l.account.code, l.type, Number(l.amountCents)]).sort()).toEqual([['1210', 'credit', 50_000], ['1220', 'debit', 50_000]])
    expect((await prisma.stockLot.findFirstOrThrow({ where: { inventoryItemId: it0.id } })).costClass).toBe('beverage')
    const auditRow = await prisma.auditLog.findFirstOrThrow({ where: { action: 'inventory.category_change', entityId: it0.id } })
    expect(es[0]!.reference).toBe(`inventory.item_reclass:${it0.id}:${auditRow.id}`)

    // The same category again: no change, nothing posts.
    expect((await call(u.mgrA!, 'PATCH', `/inventory/${it0.id}`, { category: 'beverage' })).statusCode).toBe(200)
    expect(await reclassEntries(it0.id)).toHaveLength(1)

    expect((await call(u.buyerA!, 'PATCH', `/inventory/${it0.id}`, { category: 'packaging' })).statusCode).toBe(200)
    es = await reclassEntries(it0.id)
    expect(es).toHaveLength(2)
    expect(es[1]!.lines.map((l) => [l.account.code, l.type, Number(l.amountCents)]).sort()).toEqual([['1220', 'credit', 50_000], ['1230', 'debit', 50_000]])
  })

  it('a category off the list is 400 on create and edit', async () => {
    const it0 = await item(A)
    expect((await call(u.mgrA!, 'PATCH', `/inventory/${it0.id}`, { category: 'drinks' })).statusCode).toBe(400)
    expect((await call(u.mgrA!, 'POST', '/inventory', { name: 'Odd thing', unit: 'kg', category: 'misc' })).statusCode).toBe(400)
    const ok = await call(u.mgrA!, 'POST', '/inventory', { name: 'Cola cans', unit: 'pcs', category: 'beverage' })
    expect(ok.statusCode).toBe(201)
    expect(ok.json()).toMatchObject({ tenantId: A.tenantId, category: 'beverage' })
  })

  it('the estimate is editable only while the item has no lots', async () => {
    const fresh = await item(A, { cost: 5_000 })
    const edit = await call(u.buyerA!, 'PATCH', `/inventory/${fresh.id}`, { unitCostCents: 6_000 })
    expect(edit.statusCode, edit.body).toBe(200)
    expect(edit.json().unitCostCents).toBe(6_000)
    const listed = (await call(u.mgrA!, 'GET', `/inventory/${fresh.id}`)).json()
    expect(listed.costSource).toBe('opening')

    const held = await item(A, { qty: 2, cost: 5_000 })
    const refused = await call(u.buyerA!, 'PATCH', `/inventory/${held.id}`, { unitCostCents: 1 })
    expect(refused.statusCode).toBe(422)
    expect(refused.json().error.code).toBe('COST_FROM_DELIVERIES')
    expect((await call(u.mgrA!, 'GET', `/inventory/${held.id}`)).json().costSource).toBe('deliveries')
  })

  it('issue-on-receipt: managers only, audited', async () => {
    const oil = await item(A)
    expect((await call(u.buyerA!, 'PATCH', `/inventory/${oil.id}`, { issueOnReceipt: true })).statusCode).toBe(403)
    const res = await call(u.mgrA!, 'PATCH', `/inventory/${oil.id}`, { issueOnReceipt: true })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().issueOnReceipt).toBe(true)
    const row = await prisma.auditLog.findFirstOrThrow({ where: { action: 'inventory.issue_on_receipt', entityId: oil.id } })
    expect(row).toMatchObject({ tenantId: A.tenantId, userId: u.mgrA!.id })
  })
})

describe('reading the master', () => {
  it('on-hand value for managers and finance only; the cook sees no cost; B gets 404', async () => {
    const it0 = await item(A, { qty: 3, cost: 20_000 })
    const mgr = (await call(u.mgrA!, 'GET', `/inventory/${it0.id}`)).json()
    expect(mgr).toMatchObject({ onHandValueCents: 60_000, unitCostCents: 20_000, currentStock: 3 })
    const fin = await call(u.finA!, 'GET', '/inventory')
    expect(fin.statusCode).toBe(200)
    expect((fin.json() as Array<{ id: string; onHandValueCents?: number }>).find((r) => r.id === it0.id)!.onHandValueCents).toBe(60_000)
    const buyer = (await call(u.buyerA!, 'GET', `/inventory/${it0.id}`)).json()
    expect(buyer.unitCostCents).toBe(20_000)
    expect(buyer.onHandValueCents).toBeUndefined()
    const cook = (await call(u.cookA!, 'GET', `/inventory/${it0.id}`)).json()
    expect(cook).toMatchObject({ unitCostCents: null, costsHidden: true })
    expect(cook.onHandValueCents).toBeUndefined()

    expect((await call(u.mgrB!, 'GET', `/inventory/${it0.id}`)).statusCode).toBe(404)
    expect((await call(u.mgrB!, 'PATCH', `/inventory/${it0.id}`, { category: 'dairy' })).statusCode).toBe(404)
    expect(await reclassEntries(it0.id)).toHaveLength(0)
    expect((await call(u.finA!, 'PATCH', `/inventory/${it0.id}`, { category: 'dairy' })).statusCode).toBe(403)
  })
})
