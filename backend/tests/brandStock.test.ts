// Brand stock (owner B13 (a), 2026-10-26: "Each brand keeps its own stock even when it shares a kitchen; moving
// stock between brands moves the cost between the brands' P&Ls automatically").
//
// What this guards:
//   - Two brands at ONE outlet: a sale draws only its own brand's lots, then the shared lots — never the other
//     brand's (the rest is a shortfall, as before); a brand's later lot settles only its own brand's shortfall.
//   - A brand move (POST /stock-transfers/brand-move, and the normal transfer flow with brands) moves the lots at lot
//     cost and age and posts ONE balanced 'inventory.brand_move:<id>' (Dr 12x0 tagged the new brand / Cr 12x0 tagged
//     the old); the company's stock value is unchanged.
//   - A receipt's lots are the brand that received (named, else the outlet's only brand); the GRN posting tags it.
//   - A brand count assigns shared stock to the brand (a brand move, no variance) and writes a loss off the brand's
//     own lots only.
//   - Two companies: another company's brand is 422 BRAND_NOT_IN_COMPANY; another company's item 404.
//   - The migration backfill: lots at an outlet with exactly one brand get that brand; several brands stay shared.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { AppError } from '../src/lib/errors.js'
import { addLotTx, consumeFifoTx, ensureFifoReady, lotValuation, STOCK_SOURCE } from '../src/lib/stockLedger.js'
import { stockTransferRoutes } from '../src/modules/stockTransfers/routes.js'
import { crosschecksRoutes } from '../src/modules/crosschecks/routes.js'
import { receiveGoods } from '../src/modules/procurement/receiving.js'
import { mkCompany, mkUser, type Company, type Who } from './connectorsFixtures.js'

const DAY = 86_400_000
let app: FastifyInstance
let A: Company
let B: Company
let brand2: string   // a second brand of company A, sharing A's outlet
const u: Record<string, Who> = {}
let seq = 0

const call = (who: Who, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}), headers: { authorization: `Bearer ${who.token}` } })

async function mkItem(co: Company, name = `Brand item ${++seq}`) {
  await ensureFifoReady(co.tenantId)
  return prisma.inventoryItem.create({ data: { name, unit: 'kg', tenantId: co.tenantId, unitCostCents: 100, category: 'protein' } })
}
function lotFor(co: Company, itemId: string, qty: number, cost: number, conceptId: string | null, ageDays = 1) {
  const src = `brand-lot-${++seq}`
  return prisma.$transaction((tx) => addLotTx(tx, {
    tenantId: co.tenantId, inventoryItemId: itemId, qty, unitCostCents: cost, kind: 'count_gain', lotSourceType: 'count_gain',
    lotSourceId: src, movementSourceType: 'test', movementSourceId: src, receivedAt: new Date(Date.now() - ageDays * DAY),
    locationId: co.locationId, conceptId,
  }))
}
function sell(co: Company, itemId: string, qty: number, conceptId: string) {
  return prisma.$transaction((tx) => consumeFifoTx(tx, {
    tenantId: co.tenantId, inventoryItemId: itemId, qty, kind: 'sale', sourceType: STOCK_SOURCE.orderItemSale, sourceId: randomUUID(),
    clamp: true, conceptId, locationId: co.locationId, occurredAt: new Date(),
  }))
}
const lotsOf = (itemId: string) => prisma.stockLot.findMany({ where: { inventoryItemId: itemId }, orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }] })
const brandQty = async (itemId: string, conceptId: string | null) =>
  (await prisma.stockLot.aggregate({ where: { inventoryItemId: itemId, conceptId }, _sum: { remainingQty: true } }))._sum.remainingQty ?? 0
async function entryLines(reference: string) {
  const e = await prisma.journalEntry.findFirst({ where: { reference }, include: { lines: { include: { account: { select: { code: true } } } } } })
  return e ? e.lines.map((l) => ({ code: l.account.code, type: l.type, cents: Number(l.amountCents), conceptId: l.conceptId })) : null
}

beforeAll(async () => {
  A = await mkCompany('brandst-a')
  B = await mkCompany('brandst-b')
  brand2 = (await prisma.concept.create({ data: { name: 'Second brand', slug: 'brandst-a-two', type: 'restaurant', tenantId: A.tenantId, taxRate: 17 } })).id
  // Both of A's brands cook at A's one outlet.
  await prisma.conceptLocation.createMany({ data: [{ conceptId: A.conceptId, locationId: A.locationId, isPrimary: true }, { conceptId: brand2, locationId: A.locationId, isPrimary: true }] })
  u.mgrA = await mkUser('brandMgrA', 'manager', A.tenantId)
  u.mgrB = await mkUser('brandMgrB', 'manager', B.tenantId)
  // Brand moves need the CEO (owner, 2026-10-27; tests/brandMoveApproval.test.ts): the CEO's own move is at once.
  u.ceoA = await mkUser('brandCeoA', 'admin', A.tenantId)
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(stockTransferRoutes, { prefix: '/stock-transfers' })
  await app.register(crosschecksRoutes)
  await app.ready()
}, 60_000)

afterAll(async () => { await app?.close() })

describe('two brands at one outlet keep their own stock', () => {
  it('each brand draws only its own lots, then the shared ones — never the other brand\'s', async () => {
    const it0 = await mkItem(A)
    await lotFor(A, it0.id, 5, 100, A.conceptId, 3)
    await lotFor(A, it0.id, 5, 300, brand2, 4)      // older than A's — still never A's to take
    await lotFor(A, it0.id, 4, 200, null, 5)        // shared, the oldest

    // Brand 2 sells 3: its own lot first (even though the shared lot is older), at its own price.
    const s2 = await sell(A, it0.id, 3, brand2)
    expect(s2.takenQty).toBe(3)
    expect(s2.valueCents).toBe(900)
    expect(await brandQty(it0.id, brand2)).toBe(2)
    expect(await brandQty(it0.id, null)).toBe(4)

    // Brand A sells 7: its own 5, then 2 from the shared lot; brand 2's lot is untouched.
    const s1 = await sell(A, it0.id, 7, A.conceptId)
    expect(s1.takenQty).toBe(7)
    expect(s1.valueCents).toBe(5 * 100 + 2 * 200)
    expect(await brandQty(it0.id, A.conceptId)).toBe(0)
    expect(await brandQty(it0.id, null)).toBe(2)
    expect(await brandQty(it0.id, brand2)).toBe(2)

    // Brand A sells 4 more: the shared 2, then a shortfall of 2 — brand 2's 2 stay brand 2's.
    const s3 = await sell(A, it0.id, 4, A.conceptId)
    expect(s3.takenQty).toBe(2)
    expect(s3.shortfallQty).toBe(2)
    expect(await brandQty(it0.id, brand2)).toBe(2)

    // A later lot of brand 2 does NOT settle brand A's shortfall; a lot of brand A does.
    await lotFor(A, it0.id, 1, 300, brand2, 0)
    expect(await prisma.stockMovement.count({ where: { inventoryItemId: it0.id, kind: 'shortfall_settle' } })).toBe(0)
    const src = `brand-rcpt-${++seq}`
    await prisma.$transaction((tx) => addLotTx(tx, {
      tenantId: A.tenantId, inventoryItemId: it0.id, qty: 3, unitCostCents: 100, kind: 'receipt', lotSourceType: 'goods_receipt_line',
      lotSourceId: src, movementSourceType: 'test', movementSourceId: src, receivedAt: new Date(), locationId: A.locationId, conceptId: A.conceptId,
    }))
    const settled = await prisma.stockMovement.aggregate({ where: { inventoryItemId: it0.id, kind: 'shortfall_settle' }, _sum: { qty: true } })
    expect(settled._sum.qty).toBe(-2)
    expect(await brandQty(it0.id, brand2)).toBe(3)
  })

  it('a lot of another company\'s brand is refused (422 BRAND_NOT_IN_COMPANY)', async () => {
    const it0 = await mkItem(A)
    await expect(lotFor(A, it0.id, 1, 100, B.conceptId)).rejects.toMatchObject({ code: 'BRAND_NOT_IN_COMPANY' })
  })
})

describe('moving stock between brands', () => {
  it('POST /stock-transfers/brand-move moves the lots at cost and age and re-tags the cost in ONE balanced entry', async () => {
    const it0 = await mkItem(A)
    await lotFor(A, it0.id, 4, 250, brand2, 6)
    const before = await lotValuation(prisma, A.tenantId)
    const res = await call(u.ceoA!, 'POST', '/stock-transfers/brand-move', {
      inventoryItemId: it0.id, locationId: A.locationId, fromConceptId: brand2, toConceptId: A.conceptId, quantity: 3, reason: 'Short on the line',
    })
    expect(res.statusCode).toBe(201)
    const t = res.json() as { id: string; status: string; brandMove: boolean; movedValueCents: number }
    expect(t).toMatchObject({ status: 'received', brandMove: true, movedValueCents: 750 })
    expect(await brandQty(it0.id, brand2)).toBe(1)
    expect(await brandQty(it0.id, A.conceptId)).toBe(3)
    const moved = (await lotsOf(it0.id)).find((l) => l.conceptId === A.conceptId)!
    expect(moved.unitCostCents).toBe(250)
    expect(moved.locationId).toBe(A.locationId)
    expect(moved.receivedAt.getTime()).toBeLessThan(Date.now() - 5 * DAY)   // keeps its age (FIFO order)
    // The company's stock value does not change; no stock in transit is left.
    const after = await lotValuation(prisma, A.tenantId)
    expect(after).toEqual(before)

    const lines = await entryLines(`inventory.brand_move:${t.id}`)
    expect(lines).toHaveLength(2)
    expect(lines).toEqual(expect.arrayContaining([
      { code: '1210', type: 'debit', cents: 750, conceptId: A.conceptId },
      { code: '1210', type: 'credit', cents: 750, conceptId: brand2 },
    ]))

    // The buyer sells it at the moved cost.
    const sale = await sell(A, it0.id, 3, A.conceptId)
    expect(sale.valueCents).toBe(750)
  })

  it('a brand move short of the from-brand\'s stock is 409 INSUFFICIENT_STOCK and moves nothing', async () => {
    const it0 = await mkItem(A)
    await lotFor(A, it0.id, 1, 100, brand2)
    await lotFor(A, it0.id, 9, 100, null)          // shared stock is not brand 2's to move
    const res = await call(u.ceoA!, 'POST', '/stock-transfers/brand-move', {
      inventoryItemId: it0.id, locationId: A.locationId, fromConceptId: brand2, toConceptId: A.conceptId, quantity: 2,
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().error.code).toBe('INSUFFICIENT_STOCK')
    expect(await brandQty(it0.id, brand2)).toBe(1)
    expect(await prisma.stockTransfer.count({ where: { inventoryItemId: it0.id } })).toBe(0)
  })

  it('the normal transfer flow takes brands too: same outlet, request → the CEO\'s approval moves it', async () => {
    const it0 = await mkItem(A)
    await lotFor(A, it0.id, 5, 120, null)   // shared stock, assigned to brand 2
    const created = await call(u.mgrA!, 'POST', '/stock-transfers', {
      inventoryItemId: it0.id, fromLocationId: A.locationId, toLocationId: A.locationId, quantity: 2, unit: 'kg', fromConceptId: null, toConceptId: brand2,
    })
    expect(created.statusCode).toBe(201)
    const id = (created.json() as { id: string }).id
    // A manager cannot approve a brand move; the CEO's approval at one outlet moves it at once.
    expect((await call(u.mgrA!, 'PATCH', `/stock-transfers/${id}/approve`)).json().error.code).toBe('BRAND_MOVE_CEO_ONLY')
    const approved = await call(u.ceoA!, 'PATCH', `/stock-transfers/${id}/approve`)
    expect(approved.statusCode).toBe(200)
    expect(approved.json()).toMatchObject({ status: 'received' })
    expect(await brandQty(it0.id, brand2)).toBe(2)
    expect(await brandQty(it0.id, null)).toBe(3)
    expect(await entryLines(`inventory.brand_move:${id}`)).toEqual(expect.arrayContaining([
      { code: '1210', type: 'debit', cents: 240, conceptId: brand2 },
      { code: '1210', type: 'credit', cents: 240, conceptId: null },
    ]))
    // Same outlet without brands is still refused.
    const plain = await call(u.mgrA!, 'POST', '/stock-transfers', { inventoryItemId: it0.id, fromLocationId: A.locationId, toLocationId: A.locationId, quantity: 1, unit: 'kg' })
    expect(plain.statusCode).toBe(400)
  })

  it('two companies: another company\'s brand is 422, another company\'s item is 404', async () => {
    const it0 = await mkItem(A)
    await lotFor(A, it0.id, 2, 100, A.conceptId)
    const foreignBrand = await call(u.mgrA!, 'POST', '/stock-transfers/brand-move', {
      inventoryItemId: it0.id, locationId: A.locationId, fromConceptId: A.conceptId, toConceptId: B.conceptId, quantity: 1,
    })
    expect(foreignBrand.statusCode).toBe(422)
    expect(foreignBrand.json().error.code).toBe('BRAND_NOT_IN_COMPANY')
    const viaFlow = await call(u.mgrA!, 'POST', '/stock-transfers', {
      inventoryItemId: it0.id, fromLocationId: A.locationId, toLocationId: A.locationId, quantity: 1, unit: 'kg', fromConceptId: A.conceptId, toConceptId: B.conceptId,
    })
    expect(viaFlow.statusCode).toBe(422)
    const foreignItem = await call(u.mgrB!, 'POST', '/stock-transfers/brand-move', {
      inventoryItemId: it0.id, locationId: B.locationId, fromConceptId: B.conceptId, toConceptId: null, quantity: 1,
    })
    expect(foreignItem.statusCode).toBe(404)
    const foreignOutlet = await call(u.mgrA!, 'POST', '/stock-transfers/brand-move', {
      inventoryItemId: it0.id, locationId: B.locationId, fromConceptId: A.conceptId, toConceptId: brand2, quantity: 1,
    })
    expect(foreignOutlet.statusCode).toBe(422)
    expect(foreignOutlet.json().error.code).toBe('LOCATION_NOT_IN_COMPANY')
    expect(await brandQty(it0.id, A.conceptId)).toBe(2)
  })
})

describe('receipts and counts carry the brand', () => {
  it('a delivery is the named brand\'s; the GRN tags its Dr 12x0 with it; another company\'s brand is 422', async () => {
    const sup = await prisma.supplier.create({ data: { name: `Brand supplier ${++seq}`, tenantId: A.tenantId } })
    const it0 = await mkItem(A)
    const r = await receiveGoods({
      actor: { id: u.mgrA!.id, role: 'manager' }, supplierId: sup.id, locationId: A.locationId, conceptId: brand2,
      photoUrl: 'https://example.com/p.jpg', lines: [{ inventoryItemId: it0.id, quantityReceived: 2, unitCostCents: 400 }],
    })
    expect(await brandQty(it0.id, brand2)).toBe(2)
    expect((await prisma.goodsReceipt.findUniqueOrThrow({ where: { id: r.receipt.id } })).conceptId).toBe(brand2)
    expect(await entryLines(`procurement.receipt:${r.receipt.id}`)).toEqual(expect.arrayContaining([
      { code: '1210', type: 'debit', cents: 800, conceptId: brand2 },
    ]))
    await expect(receiveGoods({
      actor: { id: u.mgrA!.id, role: 'manager' }, supplierId: sup.id, locationId: A.locationId, conceptId: B.conceptId,
      photoUrl: 'https://example.com/p.jpg', lines: [{ inventoryItemId: it0.id, quantityReceived: 1, unitCostCents: 400 }],
    })).rejects.toMatchObject({ code: 'BRAND_NOT_IN_COMPANY' })
  })

  it('no brand named: the outlet\'s only brand, else shared', async () => {
    const C = await mkCompany('brandst-c')
    await prisma.conceptLocation.create({ data: { conceptId: C.conceptId, locationId: C.locationId, isPrimary: true } })
    const sup = await prisma.supplier.create({ data: { name: `Brand supplier C ${++seq}`, tenantId: C.tenantId } })
    const itC = await mkItem(C)
    await receiveGoods({
      actor: { id: (await mkUser('brandMgrC', 'manager', C.tenantId)).id, role: 'manager' }, supplierId: sup.id, locationId: C.locationId,
      photoUrl: 'https://example.com/p.jpg', lines: [{ inventoryItemId: itC.id, quantityReceived: 1, unitCostCents: 100 }],
    })
    expect(await brandQty(itC.id, C.conceptId)).toBe(1)
    // A's outlet has two brands: a delivery that names none stays shared.
    const supA = await prisma.supplier.create({ data: { name: `Brand supplier A ${++seq}`, tenantId: A.tenantId } })
    const itA = await mkItem(A)
    await receiveGoods({
      actor: { id: u.mgrA!.id, role: 'manager' }, supplierId: supA.id, locationId: A.locationId,
      photoUrl: 'https://example.com/p.jpg', lines: [{ inventoryItemId: itA.id, quantityReceived: 1, unitCostCents: 100 }],
    })
    expect(await brandQty(itA.id, null)).toBe(1)
  })

  it('a brand count assigns shared stock to the brand (no variance), and a loss comes off the brand\'s own lots only', async () => {
    const it0 = await mkItem(A)
    await lotFor(A, it0.id, 10, 100, null, 3)
    await lotFor(A, it0.id, 2, 100, brand2, 2)
    // Brand A counts 4 on its shelf: 4 of the shared lot become A's — a brand move, not a gain.
    const c1 = await call(u.mgrA!, 'POST', '/physical-counts', {
      locationId: A.locationId, conceptId: A.conceptId, lines: [{ inventoryItemId: it0.id, physicalQty: 4 }],
    })
    expect(c1.statusCode).toBe(201)
    const line1 = (c1.json() as { lines: Array<{ systemQty: number; physicalQty: number }> }).lines[0]!
    expect(line1).toMatchObject({ systemQty: 4, physicalQty: 4 })
    expect(await brandQty(it0.id, A.conceptId)).toBe(4)
    expect(await brandQty(it0.id, null)).toBe(6)
    expect(await prisma.stockMovement.count({ where: { inventoryItemId: it0.id, kind: { in: ['count_gain', 'count_loss'] }, sourceType: STOCK_SOURCE.countLine } })).toBe(0)
    const move = await prisma.stockTransfer.findFirstOrThrow({ where: { inventoryItemId: it0.id, brandMove: true } })
    expect(await entryLines(`inventory.brand_move:${move.id}`)).toEqual(expect.arrayContaining([
      { code: '1210', type: 'debit', cents: 400, conceptId: A.conceptId },
      { code: '1210', type: 'credit', cents: 400, conceptId: null },
    ]))
    // Brand A counts 3: a loss of 1 from A's lots — never the shared or brand 2's.
    const c2 = await call(u.mgrA!, 'POST', '/physical-counts', {
      locationId: A.locationId, conceptId: A.conceptId, lines: [{ inventoryItemId: it0.id, physicalQty: 3, reason: 'dropped tray' }],
    })
    expect(c2.statusCode).toBe(201)
    expect(await brandQty(it0.id, A.conceptId)).toBe(3)
    expect(await brandQty(it0.id, null)).toBe(6)
    expect(await brandQty(it0.id, brand2)).toBe(2)
    const count = await prisma.physicalCount.findUniqueOrThrow({ where: { id: (c2.json() as { id: string }).id } })
    expect(count.conceptId).toBe(A.conceptId)
    expect(await entryLines(`inventory.count:${count.id}`)).toEqual(expect.arrayContaining([
      { code: '1210', type: 'credit', cents: 100, conceptId: A.conceptId },
    ]))
    // Company B cannot count with A's brand.
    const foreign = await call(u.mgrB!, 'POST', '/physical-counts', {
      locationId: B.locationId, conceptId: A.conceptId, lines: [{ inventoryItemId: (await mkItem(B)).id, physicalQty: 1, reason: 'found it' }],
    })
    expect(foreign.statusCode).toBe(422)
    expect(foreign.json().error.code).toBe('BRAND_NOT_IN_COMPANY')
  })
})

describe('prep batches for a brand', () => {
  it('draw the brand\'s lots then shared — never another brand\'s — and the draw is that brand\'s cost', async () => {
    const it0 = await mkItem(A)
    await lotFor(A, it0.id, 1, 100, brand2, 3)
    await lotFor(A, it0.id, 5, 100, A.conceptId, 4)
    const body = (qty: number) => ({
      itemName: 'Brand prep', inputs: [{ inventoryItemId: it0.id, qtyDrawn: qty, unit: 'kg' }], actualYieldQty: 1, unit: 'kg',
      locationId: A.locationId, conceptId: brand2,
    })
    const short = await call(u.mgrA!, 'POST', '/prep-batches', body(2))
    expect(short.statusCode).toBe(409)
    expect(short.json().error.code).toBe('INSUFFICIENT_STOCK')
    await lotFor(A, it0.id, 3, 200, null, 5)
    const ok = await call(u.mgrA!, 'POST', '/prep-batches', body(2))
    expect(ok.statusCode).toBe(201)
    expect(await brandQty(it0.id, brand2)).toBe(0)
    expect(await brandQty(it0.id, null)).toBe(2)
    expect(await brandQty(it0.id, A.conceptId)).toBe(5)
    const id = (ok.json() as { id: string }).id
    expect((await prisma.prepBatch.findUniqueOrThrow({ where: { id } })).conceptId).toBe(brand2)
    const lines = await entryLines(`inventory.prep_draw:${id}`)
    expect(lines?.every((l) => l.conceptId === brand2)).toBe(true)
    // Another company's brand is refused.
    const foreign = await call(u.mgrA!, 'POST', '/prep-batches', { ...body(1), conceptId: B.conceptId })
    expect(foreign.statusCode).toBe(422)
  })
})

describe('the migration backfill', () => {
  it('lots at an outlet with exactly one brand get it; an outlet with several brands stays shared', async () => {
    const D = await mkCompany('brandst-d')
    const D2 = (await prisma.location.create({ data: { slug: 'loc-brandst-d2', name: 'Outlet D2', tenantId: D.tenantId } })).id
    const dBrand2 = (await prisma.concept.create({ data: { name: 'D two', slug: 'brandst-d-two', type: 'restaurant', tenantId: D.tenantId, taxRate: 17 } })).id
    await prisma.conceptLocation.createMany({ data: [
      { conceptId: D.conceptId, locationId: D.locationId, isPrimary: true },
      { conceptId: D.conceptId, locationId: D2 }, { conceptId: dBrand2, locationId: D2, isPrimary: true },
    ] })
    const itD = await mkItem(D)
    const mk = (locationId: string) => prisma.stockLot.create({ data: {
      tenantId: D.tenantId, inventoryItemId: itD.id, locationId, sourceType: 'opening', sourceId: randomUUID(), costClass: 'food',
      receivedAt: new Date(), qtyIn: 1, remainingQty: 1, unitCostCents: 1, valueInCents: 1, remainingValueCents: 1,
    } })
    const one = await mk(D.locationId)
    const several = await mk(D2)
    const sql = readFileSync(new URL('../prisma/migrations/20261027130000_brand_stock/migration.sql', import.meta.url), 'utf8')
    await prisma.$executeRawUnsafe(sql.slice(sql.indexOf('WITH live_links')))
    expect((await prisma.stockLot.findUniqueOrThrow({ where: { id: one.id } })).conceptId).toBe(D.conceptId)
    expect((await prisma.stockLot.findUniqueOrThrow({ where: { id: several.id } })).conceptId).toBeNull()
  })
})
