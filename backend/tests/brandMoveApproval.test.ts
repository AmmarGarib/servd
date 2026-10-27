// Brand moves wait for the CEO (owner, 2026-10-27: "moving stock between brands needs my approval").
//
// What this guards (stockTransfers/brandMoveApproval.ts):
//   - A manager's POST /stock-transfers/brand-move answers 202 { pendingApproval, request } and moves NOTHING (no lot,
//     no entry); the CEO's own move is at once (201).
//   - Approval type stock_brand_move: CEO only (a manager 403 BRAND_MOVE_CEO_ONLY), never in the managers'
//     stock_transfer queue; the CEO's approval re-checks stock NOW (409 INSUFFICIENT_STOCK, nothing moves) and applies
//     through brandMoveTx in the claim's transaction — 'inventory.brand_move:<id>' posted exactly once.
//   - Reject needs a note ≥10 (422 NOTE_TOO_SHORT); only the requester withdraws.
//   - The normal flow between outlets: only the CEO approves; a brand move not approved by the CEO is never shipped by
//     a manager.
//   - Two companies: company B's CEO gets 404 on company A's request.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { AppError } from '../src/lib/errors.js'
import { addLotTx, consumeFifoTx, ensureFifoReady, STOCK_SOURCE } from '../src/lib/stockLedger.js'
import { approvalSubject, approverIdsFor, APPROVAL_RIGHTS } from '../src/lib/approvalRights.js'
import { stockTransferRoutes } from '../src/modules/stockTransfers/routes.js'
import { mkCompany, mkUser, type Company, type Who } from './connectorsFixtures.js'
import { randomUUID } from 'node:crypto'

let app: FastifyInstance
let A: Company
let B: Company
let brand2: string
let outlet2: string
const u: Record<string, Who> = {}
let seq = 0

const call = (who: Who, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}), headers: { authorization: `Bearer ${who.token}` } })

async function mkItem() {
  await ensureFifoReady(A.tenantId)
  return prisma.inventoryItem.create({ data: { name: `Move item ${++seq}`, unit: 'kg', tenantId: A.tenantId, unitCostCents: 100, category: 'protein' } })
}
function lot(itemId: string, qty: number, cost: number, conceptId: string | null, locationId = A.locationId) {
  const src = `bm-lot-${++seq}`
  return prisma.$transaction((tx) => addLotTx(tx, {
    tenantId: A.tenantId, inventoryItemId: itemId, qty, unitCostCents: cost, kind: 'count_gain', lotSourceType: 'count_gain',
    lotSourceId: src, movementSourceType: 'test', movementSourceId: src, receivedAt: new Date(Date.now() - 86_400_000), locationId, conceptId,
  }))
}
const brandQty = async (itemId: string, conceptId: string | null) =>
  (await prisma.stockLot.aggregate({ where: { inventoryItemId: itemId, conceptId }, _sum: { remainingQty: true } }))._sum.remainingQty ?? 0
const entries = (id: string) => prisma.journalEntry.count({ where: { reference: `inventory.brand_move:${id}` } })
const raise = (who: Who, itemId: string, qty: number, from: string | null = brand2, to: string | null = A.conceptId) =>
  call(who, 'POST', '/stock-transfers/brand-move', { inventoryItemId: itemId, locationId: A.locationId, fromConceptId: from, toConceptId: to, quantity: qty, reason: 'Short on the line' })

beforeAll(async () => {
  A = await mkCompany('bmappr-a')
  B = await mkCompany('bmappr-b')
  brand2 = (await prisma.concept.create({ data: { name: 'Second brand', slug: 'bmappr-a-two', type: 'restaurant', tenantId: A.tenantId, taxRate: 17 } })).id
  await prisma.conceptLocation.createMany({ data: [{ conceptId: A.conceptId, locationId: A.locationId, isPrimary: true }, { conceptId: brand2, locationId: A.locationId, isPrimary: true }] })
  outlet2 = (await prisma.location.create({ data: { slug: 'loc-bmappr-a2', name: 'Outlet A2', tenantId: A.tenantId } })).id
  u.mgrA = await mkUser('bmMgrA', 'manager', A.tenantId)
  u.mgrA2 = await mkUser('bmMgrA2', 'manager', A.tenantId)
  u.ceoA = await mkUser('bmCeoA', 'admin', A.tenantId)
  u.ceoB = await mkUser('bmCeoB', 'admin', B.tenantId)
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

describe('the registry', () => {
  it('stock_brand_move is the CEO\'s, never handed over', () => {
    expect(APPROVAL_RIGHTS.stock_brand_move).toMatchObject({ section: 'ceo', delegable: false, roles: ['admin'] })
  })
})

describe('a manager\'s brand move waits for the CEO', () => {
  it('202, nothing moves; the CEO\'s approval moves it and posts the entry once', async () => {
    const it0 = await mkItem()
    await lot(it0.id, 4, 250, brand2)
    const res = await raise(u.mgrA!, it0.id, 3)
    expect(res.statusCode).toBe(202)
    const body = res.json() as { pendingApproval: boolean; request: { id: string; status: string; brandMove: boolean } }
    expect(body).toMatchObject({ pendingApproval: true, request: { status: 'requested', brandMove: true } })
    const id = body.request.id
    expect(await brandQty(it0.id, brand2)).toBe(4)
    expect(await brandQty(it0.id, A.conceptId)).toBe(0)
    expect(await entries(id)).toBe(0)
    expect(await prisma.stockMovement.count({ where: { sourceId: id } })).toBe(0)

    // The CEO's queue, never the managers'; the bell goes to the CEO only.
    expect((await approvalSubject('stock_brand_move', id))!.status).toBe('requested')
    expect((await approvalSubject('stock_transfer', id))!.status).not.toBe('requested')
    expect((await approverIdsFor('stock_brand_move', id))?.userIds).toEqual([u.ceoA!.id])
    const managersQueue = (await call(u.mgrA!, 'GET', '/stock-transfers?status=requested&brandMove=false')).json() as Array<{ id: string }>
    expect(managersQueue.map((t) => t.id)).not.toContain(id)
    const ceoQueue = (await call(u.ceoA!, 'GET', '/stock-transfers?status=requested&brandMove=true')).json() as Array<{ id: string }>
    expect(ceoQueue.map((t) => t.id)).toContain(id)

    // A manager (the raiser or another) cannot approve it, by either route.
    expect((await call(u.mgrA2!, 'POST', `/stock-transfers/${id}/brand-move/approve`)).json().error.code).toBe('BRAND_MOVE_CEO_ONLY')
    expect((await call(u.mgrA!, 'PATCH', `/stock-transfers/${id}/approve`)).json().error.code).toBe('BRAND_MOVE_CEO_ONLY')
    expect(await brandQty(it0.id, brand2)).toBe(4)

    // Company B's CEO: 404.
    expect((await call(u.ceoB!, 'POST', `/stock-transfers/${id}/brand-move/approve`)).statusCode).toBe(404)

    const ok = await call(u.ceoA!, 'POST', `/stock-transfers/${id}/brand-move/approve`)
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toMatchObject({ id, status: 'received', movedValueCents: 750 })
    expect(await brandQty(it0.id, brand2)).toBe(1)
    expect(await brandQty(it0.id, A.conceptId)).toBe(3)
    expect(await entries(id)).toBe(1)
    const row = await prisma.stockTransfer.findUniqueOrThrow({ where: { id } })
    expect(row).toMatchObject({ requestedById: u.mgrA!.id, approvedById: u.ceoA!.id })

    // Once only.
    expect((await call(u.ceoA!, 'POST', `/stock-transfers/${id}/brand-move/approve`)).statusCode).toBe(409)
    expect(await entries(id)).toBe(1)
    expect(await brandQty(it0.id, A.conceptId)).toBe(3)
  })

  it('the approval re-checks stock now: 409 INSUFFICIENT_STOCK and nothing moves', async () => {
    const it0 = await mkItem()
    await lot(it0.id, 4, 100, brand2)
    const id = ((await raise(u.mgrA!, it0.id, 3)).json() as { request: { id: string } }).request.id
    // Brand 2 sells 2 meanwhile: only 2 left.
    await prisma.$transaction((tx) => consumeFifoTx(tx, {
      tenantId: A.tenantId, inventoryItemId: it0.id, qty: 2, kind: 'sale', sourceType: STOCK_SOURCE.orderItemSale, sourceId: randomUUID(),
      clamp: true, conceptId: brand2, locationId: A.locationId, occurredAt: new Date(),
    }))
    const res = await call(u.ceoA!, 'POST', `/stock-transfers/${id}/brand-move/approve`)
    expect(res.statusCode).toBe(409)
    expect(res.json().error.code).toBe('INSUFFICIENT_STOCK')
    expect((await prisma.stockTransfer.findUniqueOrThrow({ where: { id } })).status).toBe('requested')
    expect(await brandQty(it0.id, brand2)).toBe(2)
    expect(await entries(id)).toBe(0)
  })

  it('reject needs a note of 10+ characters and the CEO; withdraw is the requester\'s only', async () => {
    const it0 = await mkItem()
    await lot(it0.id, 5, 100, brand2)
    const id = ((await raise(u.mgrA!, it0.id, 1)).json() as { request: { id: string } }).request.id
    expect((await call(u.mgrA2!, 'POST', `/stock-transfers/${id}/brand-move/reject`, { note: 'Not needed this week' })).json().error.code).toBe('BRAND_MOVE_CEO_ONLY')
    expect((await call(u.mgrA2!, 'PATCH', `/stock-transfers/${id}/cancel`, {})).json().error.code).toBe('BRAND_MOVE_CEO_ONLY')
    expect((await call(u.ceoA!, 'POST', `/stock-transfers/${id}/brand-move/reject`, { note: 'no' })).json().error.code).toBe('NOTE_TOO_SHORT')
    expect((await call(u.ceoA!, 'PATCH', `/stock-transfers/${id}/cancel`, { reason: 'no' })).json().error.code).toBe('NOTE_TOO_SHORT')
    const rej = await call(u.ceoA!, 'POST', `/stock-transfers/${id}/brand-move/reject`, { note: 'Not needed this week' })
    expect(rej.statusCode).toBe(200)
    expect(rej.json()).toMatchObject({ status: 'cancelled', cancelReason: 'Not needed this week', cancelledById: u.ceoA!.id })
    expect((await call(u.ceoA!, 'POST', `/stock-transfers/${id}/brand-move/approve`)).statusCode).toBe(409)
    expect(await brandQty(it0.id, brand2)).toBe(5)

    const id2 = ((await raise(u.mgrA!, it0.id, 1)).json() as { request: { id: string } }).request.id
    expect((await call(u.mgrA2!, 'POST', `/stock-transfers/${id2}/brand-move/withdraw`)).json().error.code).toBe('NOT_YOUR_REQUEST')
    const w = await call(u.mgrA!, 'POST', `/stock-transfers/${id2}/brand-move/withdraw`)
    expect(w.statusCode).toBe(200)
    expect(w.json()).toMatchObject({ status: 'cancelled', cancelledById: u.mgrA!.id })
    expect(await brandQty(it0.id, brand2)).toBe(5)
  })

  it('the CEO\'s own move happens at once', async () => {
    const it0 = await mkItem()
    await lot(it0.id, 2, 100, null)
    const res = await raise(u.ceoA!, it0.id, 2, null, brand2)
    expect(res.statusCode).toBe(201)
    const t = res.json() as { id: string; status: string }
    expect(t.status).toBe('received')
    expect(await brandQty(it0.id, brand2)).toBe(2)
    expect(await entries(t.id)).toBe(1)
  })

  it('a manager\'s request is still checked: another company\'s brand 422, outlet 422', async () => {
    const it0 = await mkItem()
    expect((await raise(u.mgrA!, it0.id, 1, A.conceptId, B.conceptId)).json().error.code).toBe('BRAND_NOT_IN_COMPANY')
    const r = await call(u.mgrA!, 'POST', '/stock-transfers/brand-move', { inventoryItemId: it0.id, locationId: B.locationId, fromConceptId: A.conceptId, toConceptId: brand2, quantity: 1 })
    expect(r.json().error.code).toBe('LOCATION_NOT_IN_COMPANY')
    expect(await prisma.stockTransfer.count({ where: { inventoryItemId: it0.id } })).toBe(0)
  })
})

describe('the normal flow between outlets', () => {
  it('only the CEO approves; managers then ship and receive; a move not approved by the CEO is never shipped by a manager', async () => {
    const it0 = await mkItem()
    await lot(it0.id, 5, 100, brand2)
    const created = await call(u.mgrA!, 'POST', '/stock-transfers', {
      inventoryItemId: it0.id, fromLocationId: A.locationId, toLocationId: outlet2, quantity: 2, unit: 'kg', fromConceptId: brand2, toConceptId: A.conceptId,
    })
    expect(created.statusCode).toBe(201)
    expect(created.json()).toMatchObject({ status: 'requested', pendingApproval: true })
    const id = (created.json() as { id: string }).id
    expect((await call(u.mgrA2!, 'PATCH', `/stock-transfers/${id}/approve`)).json().error.code).toBe('BRAND_MOVE_CEO_ONLY')
    const ok = await call(u.ceoA!, 'PATCH', `/stock-transfers/${id}/approve`)
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toMatchObject({ status: 'approved' })
    expect(await brandQty(it0.id, brand2)).toBe(5)
    expect((await call(u.mgrA!, 'PATCH', `/stock-transfers/${id}/ship`)).statusCode).toBe(200)
    expect((await call(u.mgrA2!, 'PATCH', `/stock-transfers/${id}/receive`, {})).statusCode).toBe(200)
    expect(await brandQty(it0.id, A.conceptId)).toBe(2)
    expect(await entries(id)).toBe(1)

    // A brand move a manager approved (before the rule): a manager cannot ship it.
    const legacy = await prisma.stockTransfer.create({
      data: {
        inventoryItemId: it0.id, fromLocationId: A.locationId, toLocationId: outlet2, fromConceptId: brand2, toConceptId: A.conceptId, brandMove: true,
        quantity: 1, unit: 'kg', status: 'approved', requestedById: u.mgrA!.id, approvedById: u.mgrA2!.id, approvedAt: new Date(),
      },
    })
    expect((await call(u.mgrA!, 'PATCH', `/stock-transfers/${legacy.id}/ship`)).json().error.code).toBe('BRAND_MOVE_CEO_ONLY')
    expect(await brandQty(it0.id, brand2)).toBe(3)
  })
})
