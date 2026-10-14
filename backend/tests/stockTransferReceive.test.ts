// Stock transfers on FIFO lots (finance wave B) — PATCH /stock-transfers/:id/receive.
//
// What this guards:
//   - Stock is one pool per company: a full receipt moves no lot.
//   - Received above sent → 422 OVER_RECEIVED; a shortfall needs a reason
//     (422 SHORTFALL_REASON_REQUIRED) — nothing changes on a refusal.
//   - A shortfall is booked as waste reason 'transit_loss': drawn FIFO, a
//     WasteLog in the item's company tagged with the sending outlet, and
//     'inventory.waste:<id>' Dr 5040 / Cr 1210, once (a second receive is 409).
//   - Two companies: another company's transfer is 404; a company-less item
//     cannot be transferred.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { AppError } from '../src/lib/errors.js'
import { addLotTx, ensureFifoReady } from '../src/lib/stockLedger.js'
import { stockTransferRoutes } from '../src/modules/stockTransfers/routes.js'
import { mkCompany, mkUser, type Company, type Who } from './connectorsFixtures.js'

const DAY = 86_400_000
let app: FastifyInstance
let A: Company
let B: Company
let A2: string
const u: Record<string, Who> = {}
let seq = 0

const call = (who: Who, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}), headers: { authorization: `Bearer ${who.token}` } })

async function item(co: Company, qty: number, cost: number) {
  await ensureFifoReady(co.tenantId)
  const it = await prisma.inventoryItem.create({ data: { name: `Transfer item ${++seq}`, unit: 'kg', tenantId: co.tenantId, unitCostCents: cost, category: 'protein' } })
  await prisma.$transaction((tx) => addLotTx(tx, {
    tenantId: co.tenantId, inventoryItemId: it.id, qty, unitCostCents: cost, kind: 'fifo_cutover', lotSourceType: 'fifo_cutover',
    lotSourceId: `seed:${it.id}`, movementSourceType: 'test.seed', movementSourceId: it.id, receivedAt: new Date(Date.now() - DAY),
  }))
  return it
}

/** A transfer of `qty` from A's outlet to A2, approved and shipped. */
async function shipped(itemId: string, qty: number, unit = 'kg') {
  const created = await call(u.mgrA!, 'POST', '/stock-transfers', { inventoryItemId: itemId, fromLocationId: A.locationId, toLocationId: A2, quantity: qty, unit })
  expect(created.statusCode, created.body).toBe(201)
  const id = created.json().id as string
  expect((await call(u.mgrA!, 'PATCH', `/stock-transfers/${id}/approve`)).statusCode).toBe(200)
  expect((await call(u.mgrA!, 'PATCH', `/stock-transfers/${id}/ship`)).statusCode).toBe(200)
  return id
}
const stockOf = async (id: string) => (await prisma.inventoryItem.findUniqueOrThrow({ where: { id } })).currentStock

beforeAll(async () => {
  A = await mkCompany('xfer-a')
  B = await mkCompany('xfer-b')
  A2 = (await prisma.location.create({ data: { slug: 'loc-xfer-a2', name: 'Outlet A2', tenantId: A.tenantId } })).id
  u.mgrA = await mkUser('mgrA', 'manager', A.tenantId)
  u.mgrB = await mkUser('mgrB', 'manager', B.tenantId)
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(stockTransferRoutes, { prefix: '/stock-transfers' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  await app?.close()
})

describe('receiving a transfer', () => {
  it('in full: received, no stock moves, no waste', async () => {
    const it0 = await item(A, 10, 10_000)
    const id = await shipped(it0.id, 4)
    const res = await call(u.mgrA!, 'PATCH', `/stock-transfers/${id}/receive`, {})
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({ status: 'received', receivedQuantity: 4 })
    expect(res.json().transitLoss).toBeUndefined()
    expect(await stockOf(it0.id)).toBe(10)
    expect(await prisma.wasteLog.count({ where: { inventoryItemId: it0.id } })).toBe(0)
  })

  it('more than sent → 422 OVER_RECEIVED; a shortfall without a reason → 422 SHORTFALL_REASON_REQUIRED; nothing changes', async () => {
    const it0 = await item(A, 10, 10_000)
    const id = await shipped(it0.id, 4)
    const over = await call(u.mgrA!, 'PATCH', `/stock-transfers/${id}/receive`, { receivedQuantity: 5 })
    expect(over.statusCode).toBe(422)
    expect(over.json().error.code).toBe('OVER_RECEIVED')
    for (const body of [{ receivedQuantity: 3 }, { receivedQuantity: 3, shortfallReason: 'no' }]) {
      const r = await call(u.mgrA!, 'PATCH', `/stock-transfers/${id}/receive`, body)
      expect(r.statusCode).toBe(422)
      expect(r.json().error.code).toBe('SHORTFALL_REASON_REQUIRED')
    }
    expect((await prisma.stockTransfer.findUniqueOrThrow({ where: { id } })).status).toBe('shipped')
    expect(await stockOf(it0.id)).toBe(10)
  })

  it('a shortfall is transit-loss waste: FIFO value, the sending outlet, Dr 5040 / Cr 1210 — once', async () => {
    const it0 = await item(A, 10, 10_000)
    const id = await shipped(it0.id, 4000, 'g')
    const res = await call(u.mgrA!, 'PATCH', `/stock-transfers/${id}/receive`, { receivedQuantity: 3500, shortfallReason: 'bag split in the van' })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toMatchObject({ status: 'received', receivedQuantity: 3500, transitLoss: { quantity: 0.5, unit: 'kg', ledger: { posted: true } } })
    expect(await stockOf(it0.id)).toBe(9.5)
    const log = await prisma.wasteLog.findUniqueOrThrow({ where: { id: res.json().transitLoss.wasteLogId } })
    expect(log).toMatchObject({ tenantId: A.tenantId, locationId: A.locationId, reason: 'transit_loss', quantity: 0.5, unit: 'kg', estimatedCostCents: 5_000 })
    expect(log.notes).toContain('bag split in the van')
    const e = await prisma.journalEntry.findFirstOrThrow({ where: { tenantId: A.tenantId, reference: `inventory.waste:${log.id}` }, include: { lines: { include: { account: { select: { code: true } } } } } })
    expect(e.lines.map((l) => [l.account.code, l.type, Number(l.amountCents)]).sort()).toEqual([['1210', 'credit', 5_000], ['5040', 'debit', 5_000]])

    const again = await call(u.mgrA!, 'PATCH', `/stock-transfers/${id}/receive`, { receivedQuantity: 3000, shortfallReason: 'second try' })
    expect(again.statusCode).toBe(409)
    expect(await prisma.wasteLog.count({ where: { inventoryItemId: it0.id } })).toBe(1)
    expect(await stockOf(it0.id)).toBe(9.5)
  })
})

describe('two companies', () => {
  it('B gets 404 on A\'s transfer; a company-less item cannot be transferred', async () => {
    const it0 = await item(A, 10, 10_000)
    const id = await shipped(it0.id, 2)
    const res = await call(u.mgrB!, 'PATCH', `/stock-transfers/${id}/receive`, { receivedQuantity: 1, shortfallReason: 'stolen claim' })
    expect(res.statusCode).toBe(404)
    expect((await prisma.stockTransfer.findUniqueOrThrow({ where: { id } })).status).toBe('shipped')
    expect(await stockOf(it0.id)).toBe(10)

    const orphan = await prisma.inventoryItem.create({ data: { name: 'Transfer orphan', unit: 'kg', currentStock: 5 } })
    const create = await call(u.mgrA!, 'POST', '/stock-transfers', { inventoryItemId: orphan.id, fromLocationId: A.locationId, toLocationId: A2, quantity: 1, unit: 'kg' })
    expect(create.statusCode).toBe(422)
    expect(create.json().error.code).toBe('ITEM_HAS_NO_COMPANY')
    // B's item or B's outlet on A's transfer are refused at create.
    const itB = await item(B, 5, 1_000)
    expect((await call(u.mgrA!, 'POST', '/stock-transfers', { inventoryItemId: itB.id, fromLocationId: A.locationId, toLocationId: A2, quantity: 1, unit: 'kg' })).statusCode).toBe(404)
    expect((await call(u.mgrA!, 'POST', '/stock-transfers', { inventoryItemId: it0.id, fromLocationId: A.locationId, toLocationId: B.locationId, quantity: 1, unit: 'kg' })).statusCode).toBe(422)
  })
})
