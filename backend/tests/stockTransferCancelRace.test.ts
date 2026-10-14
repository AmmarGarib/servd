// A stock transfer's status moves are conditional (W3 gate finding stock-04) —
// PATCH /stock-transfers/:id/cancel and the approve / ship transitions.
//
// The cancel used to read the status and then write 'cancelled' with an
// unconditional update, so a receive that committed in between (with its
// transit-loss waste and Dr 1290 / Cr 12x0) was overwritten: the shortfall's
// cost ended up on a transfer showing as cancelled. Now the cancel only moves
// a transfer still in the status it read (409 BAD_STATE otherwise), and so do
// approve and ship. Company B gets 404 on A's transfer.
// Requires a disposable database (DATABASE_URL must contain "test").
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { AppError } from '../src/lib/errors.js'
import { addLotTx, ensureFifoReady } from '../src/lib/stockLedger.js'
import { stockTransferRoutes } from '../src/modules/stockTransfers/routes.js'
import { mkCompany, mkUser, type Company, type Who } from './connectorsFixtures.js'

let app: FastifyInstance
let A: Company
let B: Company
let A2: string
const u: Record<string, Who> = {}
const stamp = Date.now()

const call = (who: Who, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}), headers: { authorization: `Bearer ${who.token}` } })

async function shippedTransfer(): Promise<string> {
  await ensureFifoReady(A.tenantId)
  const it = await prisma.inventoryItem.create({ data: { name: `Race item ${Math.random().toString(36).slice(2, 7)}`, unit: 'kg', tenantId: A.tenantId, unitCostCents: 10_000, category: 'protein' } })
  await prisma.$transaction((tx) => addLotTx(tx, {
    tenantId: A.tenantId, inventoryItemId: it.id, qty: 10, unitCostCents: 10_000, kind: 'fifo_cutover', lotSourceType: 'fifo_cutover',
    lotSourceId: `seed:${it.id}`, movementSourceType: 'test.seed', movementSourceId: it.id, receivedAt: new Date(Date.now() - 86_400_000),
  }))
  const created = await call(u.mgrA!, 'POST', '/stock-transfers', { inventoryItemId: it.id, fromLocationId: A.locationId, toLocationId: A2, quantity: 4, unit: 'kg' })
  expect(created.statusCode, created.body).toBe(201)
  const id = created.json().id as string
  expect((await call(u.mgrA!, 'PATCH', `/stock-transfers/${id}/approve`)).statusCode).toBe(200)
  expect((await call(u.mgrA!, 'PATCH', `/stock-transfers/${id}/ship`)).statusCode).toBe(200)
  return id
}

/** Waits until `n` sessions are blocked on a row lock. */
async function waiting(n: number) {
  for (let i = 0; i < 200; i++) {
    const r = await prisma.$queryRaw<Array<{ c: bigint }>>`SELECT count(*)::bigint AS c FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()`
    if (Number(r[0]!.c) >= n) return
    await new Promise((res) => setTimeout(res, 50))
  }
  throw new Error('nothing queued on the row lock')
}

beforeAll(async () => {
  A = await mkCompany(`xrace-a-${stamp}`)
  B = await mkCompany(`xrace-b-${stamp}`)
  A2 = (await prisma.location.create({ data: { slug: `loc-xrace-a2-${stamp}`, name: 'Outlet A2', tenantId: A.tenantId } })).id
  u.mgrA = await mkUser('xrace-mgrA', 'manager', A.tenantId)
  u.mgrB = await mkUser('xrace-mgrB', 'manager', B.tenantId)
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(stockTransferRoutes, { prefix: '/stock-transfers' })
  await app.ready()
}, 60_000)

afterAll(async () => { await app?.close() })

describe('cancelling a transfer while it is being received', () => {
  it('the receive that committed first stands; the cancel that read "shipped" gets 409 BAD_STATE', async () => {
    const id = await shippedTransfer()
    let release!: () => void
    const gate = new Promise<void>((res) => { release = res })
    // The "receiver": holds the row, then commits status 'received'.
    const receiver = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM stock_transfers WHERE id = ${id} FOR UPDATE`
      await gate
      await tx.stockTransfer.update({ where: { id }, data: { status: 'received', receivedAt: new Date(), receivedQuantity: 4 } })
    }, { timeout: 60_000, maxWait: 10_000 })
    const cancel = call(u.mgrA!, 'PATCH', `/stock-transfers/${id}/cancel`, { reason: 'changed plan' })
    await waiting(1)
    release()
    await receiver
    const r = await cancel
    expect(r.statusCode, r.body).toBe(409)
    expect(r.json().error.code).toBe('BAD_STATE')
    expect((await prisma.stockTransfer.findUniqueOrThrow({ where: { id } })).status).toBe('received')
  })

  it('a plain cancel of a shipped transfer still works; a second ship is 409; B gets 404', async () => {
    const id = await shippedTransfer()
    expect((await call(u.mgrA!, 'PATCH', `/stock-transfers/${id}/ship`)).statusCode).toBe(409)
    expect((await call(u.mgrB!, 'PATCH', `/stock-transfers/${id}/cancel`, {})).statusCode).toBe(404)
    const ok = await call(u.mgrA!, 'PATCH', `/stock-transfers/${id}/cancel`, { reason: 'not needed' })
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json().status).toBe('cancelled')
  })
})
