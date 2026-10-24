// Stock by site (owner, 2026-10-24, D4: "per-site stock now").
//
// What this guards:
//   - Every lot belongs to one outlet; a draw takes only that site's lots (a
//     sale at a site with nothing there is a shortfall there, never another
//     site's stock); stock_balances = Σ lots per site; currentStock stays the
//     company total.
//   - The site cut-over moves lots with no site to the STOCK HOME (the single
//     active outlet; never the "General" holding place), once, with a marker.
//   - stockSiteOf: the order's outlet, else the brand's primary outlet, else
//     the stock home. A location of another company is 422
//     LOCATION_NOT_IN_COMPANY.
//   - Waste / counts with two active outlets and no locationId: 422
//     LOCATION_REQUIRED; a count's book is the counted site's.
//   - Transfers: ship short → 409 INSUFFICIENT_STOCK (nothing moves); in
//     transit stays in the company valuation; cancel after ship returns the
//     stock to its very lots; across two companies → 422
//     TRANSFER_CROSS_COMPANY; company B gets 404 on A's transfer.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { AppError } from '../src/lib/errors.js'
import {
  addLotTx, consumeFifoTx, ensureFifoReady, fifoCutoverKey, lotValuation, repriceLotTx, siteOnHand, STOCK_SOURCE,
} from '../src/lib/stockLedger.js'
import { readSiteCutover, stockHomeOf, stockSiteOf, siteCutoverKey } from '../src/lib/stockSite.js'
import { ensureGeneralLocation } from '../src/lib/generalLocation.js'
import { stockTransferRoutes } from '../src/modules/stockTransfers/routes.js'
import { inventoryRoutes } from '../src/modules/inventory/routes.js'
import { crosschecksRoutes } from '../src/modules/crosschecks/routes.js'
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

async function mkItem(co: Company, name = `Site item ${++seq}`) {
  await ensureFifoReady(co.tenantId)
  return prisma.inventoryItem.create({ data: { name, unit: 'kg', tenantId: co.tenantId, unitCostCents: 10_000, category: 'protein' } })
}
function gainAt(co: Company, itemId: string, qty: number, locationId: string | null, cost = 10_000) {
  const src = `site-gain-${++seq}`
  return prisma.$transaction((tx) => addLotTx(tx, {
    tenantId: co.tenantId, inventoryItemId: itemId, qty, unitCostCents: cost, kind: 'count_gain', lotSourceType: 'count_gain',
    lotSourceId: src, movementSourceType: 'test', movementSourceId: src, receivedAt: new Date(Date.now() - DAY), locationId,
  }))
}
const balanceOf = async (itemId: string, locationId: string) =>
  (await prisma.stockBalance.findUnique({ where: { inventoryItemId_locationId: { inventoryItemId: itemId, locationId } } }))?.qty ?? 0

beforeAll(async () => {
  A = await mkCompany('site-a')
  B = await mkCompany('site-b')
  A2 = (await prisma.location.create({ data: { slug: 'loc-site-a2', name: 'Outlet A2', tenantId: A.tenantId } })).id
  u.mgrA = await mkUser('siteMgrA', 'manager', A.tenantId)
  u.mgrB = await mkUser('siteMgrB', 'manager', B.tenantId)
  u.ceo = await mkUser('siteCeo', 'admin', A.tenantId)
  await prisma.tenantMember.create({ data: { tenantId: B.tenantId, userId: u.ceo.id } })
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(stockTransferRoutes, { prefix: '/stock-transfers' })
  await app.register(inventoryRoutes, { prefix: '/inventory' })
  await app.register(crosschecksRoutes)
  await app.ready()
}, 60_000)

afterAll(async () => { await app?.close() })

describe('the site cut-over and the stock home', () => {
  it('moves lots with no site to the single active outlet, once — never the General holding place', async () => {
    const C = await mkCompany('site-c')
    await ensureGeneralLocation(prisma, C.tenantId)
    await prisma.location.create({ data: { slug: 'loc-site-c-closed', name: 'Closed outlet', tenantId: C.tenantId, isActive: false } })
    const it0 = await prisma.inventoryItem.create({ data: { name: 'Legacy flour', unit: 'kg', tenantId: C.tenantId, category: 'dry_goods' } })
    // A lot from before per-site stock (no site), as the FIFO cut-over left it.
    await prisma.setting.create({ data: { key: `foodcost.fifoCutoverAt:${C.tenantId}`, value: new Date(Date.now() - 30 * DAY).toISOString() } })
    await prisma.stockLot.create({ data: {
      tenantId: C.tenantId, inventoryItemId: it0.id, sourceType: 'fifo_cutover', sourceId: C.tenantId, costClass: 'food',
      receivedAt: new Date(Date.now() - 30 * DAY), qtyIn: 5, remainingQty: 5, unitCostCents: 100, valueInCents: 500, remainingValueCents: 500,
    } })
    await prisma.inventoryItem.update({ where: { id: it0.id }, data: { currentStock: 5 } })

    await ensureFifoReady(C.tenantId)
    const marker = await readSiteCutover(prisma, C.tenantId)
    expect(marker?.homeLocationId).toBe(C.locationId)
    expect(await stockHomeOf(prisma, C.tenantId)).toBe(C.locationId)
    expect((await prisma.stockLot.findFirstOrThrow({ where: { inventoryItemId: it0.id } })).locationId).toBe(C.locationId)
    expect(await balanceOf(it0.id, C.locationId)).toBe(5)
    expect(await prisma.auditLog.count({ where: { tenantId: C.tenantId, action: 'stock.site_cutover' } })).toBe(1)
    await ensureFifoReady(C.tenantId)   // idempotent
    expect(await prisma.auditLog.count({ where: { tenantId: C.tenantId, action: 'stock.site_cutover' } })).toBe(1)
    expect(await prisma.setting.count({ where: { key: siteCutoverKey(C.tenantId) } })).toBe(1)
  })

  it('stockSiteOf: the order outlet, else the brand\'s primary outlet, else the home; never another company\'s outlet', async () => {
    expect(await stockSiteOf(prisma, { orderLocationId: A2, conceptId: A.conceptId, tenantId: A.tenantId })).toBe(A2)
    // B's outlet on an A order is ignored.
    const home = await stockHomeOf(prisma, A.tenantId)
    expect(await stockSiteOf(prisma, { orderLocationId: B.locationId, conceptId: A.conceptId, tenantId: A.tenantId })).toBe(home)
    await prisma.conceptLocation.create({ data: { conceptId: A.conceptId, locationId: A2, isPrimary: true } })
    expect(await stockSiteOf(prisma, { orderLocationId: null, conceptId: A.conceptId, tenantId: A.tenantId })).toBe(A2)
    await prisma.conceptLocation.delete({ where: { conceptId_locationId: { conceptId: A.conceptId, locationId: A2 } } })
  })
})

describe('draws are per site', () => {
  it('a sale at a site with nothing there is that site\'s shortfall; the other site keeps its stock', async () => {
    const it0 = await mkItem(A)
    await gainAt(A, it0.id, 10, A.locationId)
    expect(await balanceOf(it0.id, A.locationId)).toBe(10)
    const r = await prisma.$transaction((tx) => consumeFifoTx(tx, {
      tenantId: A.tenantId, inventoryItemId: it0.id, qty: 3, kind: 'sale', sourceType: STOCK_SOURCE.orderItemSale, sourceId: randomUUID(),
      clamp: true, locationId: A2, occurredAt: new Date(),
    }))
    expect(r.takenQty).toBe(0)
    expect(r.shortfallQty).toBe(3)
    expect(r.rows[0]).toMatchObject({ lotId: null })
    expect(await siteOnHand(prisma, it0.id, A.locationId)).toBe(10)
    const at1 = await prisma.$transaction((tx) => consumeFifoTx(tx, {
      tenantId: A.tenantId, inventoryItemId: it0.id, qty: 4, kind: 'sale', sourceType: STOCK_SOURCE.orderItemSale, sourceId: randomUUID(),
      clamp: true, locationId: A.locationId, occurredAt: new Date(),
    }))
    expect(at1.takenQty).toBe(4)
    expect(await balanceOf(it0.id, A.locationId)).toBe(6)
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: it0.id } })).currentStock).toBe(6)
    // A receipt at the short site settles that site's shortfall only.
    const src = `site-rcpt-${++seq}`
    const lot = await prisma.$transaction((tx) => addLotTx(tx, {
      tenantId: A.tenantId, inventoryItemId: it0.id, qty: 5, unitCostCents: 10_000, kind: 'receipt', lotSourceType: 'goods_receipt_line',
      lotSourceId: src, movementSourceType: STOCK_SOURCE.receiptLine, movementSourceId: src, receivedAt: new Date(), locationId: A2,
    }))
    expect(lot.settled?.valueCents).toBe(30_000)
    expect(await balanceOf(it0.id, A2)).toBe(2)
    expect(await balanceOf(it0.id, A.locationId)).toBe(6)
  })

  it('a location of another company is 422 LOCATION_NOT_IN_COMPANY', async () => {
    const it0 = await mkItem(A)
    await expect(gainAt(A, it0.id, 1, B.locationId)).rejects.toMatchObject({ code: 'LOCATION_NOT_IN_COMPANY' })
  })

  it('waste with two active outlets needs a locationId (422 LOCATION_REQUIRED); B gets 404 on A\'s item', async () => {
    const it0 = await mkItem(A)
    await gainAt(A, it0.id, 4, A2)
    const none = await call(u.mgrA!, 'POST', `/inventory/${it0.id}/waste`, { quantity: 1, unit: 'kg', reason: 'spoilage' })
    expect(none.statusCode, none.body).toBe(422)
    expect(none.json().error.code).toBe('LOCATION_REQUIRED')
    const ok = await call(u.mgrA!, 'POST', `/inventory/${it0.id}/waste`, { quantity: 1, unit: 'kg', reason: 'spoilage', locationId: A2, photoUrl: 'https://x.test/p.jpg' })
    expect(ok.statusCode, ok.body).toBe(201)
    expect(await balanceOf(it0.id, A2)).toBe(3)
    const wrongSite = await call(u.mgrA!, 'POST', `/inventory/${it0.id}/waste`, { quantity: 1, unit: 'kg', reason: 'spoilage', locationId: A.locationId })
    expect(wrongSite.statusCode).toBe(422)
    expect(wrongSite.json().error.code).toBe('NEGATIVE_STOCK')
    expect((await call(u.mgrB!, 'POST', `/inventory/${it0.id}/waste`, { quantity: 1, unit: 'kg', reason: 'spoilage', locationId: A2 })).statusCode).toBe(404)
  })

  it('a count\'s book is the counted site\'s', async () => {
    const it0 = await mkItem(A)
    await gainAt(A, it0.id, 4, A2)
    await gainAt(A, it0.id, 6, A.locationId)
    const res = await call(u.mgrA!, 'POST', '/physical-counts', { locationId: A2, lines: [{ inventoryItemId: it0.id, physicalQty: 3, reason: 'one bag torn' }] })
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json().lines[0]).toMatchObject({ systemQty: 4, physicalQty: 3 })
    expect(await balanceOf(it0.id, A2)).toBe(3)
    expect(await balanceOf(it0.id, A.locationId)).toBe(6)
  })
})

describe('transfers between sites', () => {
  async function approved(itemId: string, qty: number, from = A.locationId, to = A2) {
    const created = await call(u.mgrA!, 'POST', '/stock-transfers', { inventoryItemId: itemId, fromLocationId: from, toLocationId: to, quantity: qty, unit: 'kg' })
    expect(created.statusCode, created.body).toBe(201)
    const id = created.json().id as string
    expect((await call(u.mgrA!, 'PATCH', `/stock-transfers/${id}/approve`)).statusCode).toBe(200)
    return id
  }

  it('ship short → 409 INSUFFICIENT_STOCK and nothing moves', async () => {
    const it0 = await mkItem(A)
    await gainAt(A, it0.id, 2, A.locationId)
    const id = await approved(it0.id, 3)
    const r = await call(u.mgrA!, 'PATCH', `/stock-transfers/${id}/ship`)
    expect(r.statusCode).toBe(409)
    expect(r.json().error.code).toBe('INSUFFICIENT_STOCK')
    expect((await prisma.stockTransfer.findUniqueOrThrow({ where: { id } })).status).toBe('approved')
    expect(await balanceOf(it0.id, A.locationId)).toBe(2)
  })

  it('in transit stays in the company valuation; cancel after ship returns the stock to its very lots', async () => {
    const it0 = await mkItem(A)
    const { lotId } = await gainAt(A, it0.id, 5, A.locationId, 20_000)
    const before = await lotValuation(prisma, A.tenantId)
    const id = await approved(it0.id, 2)
    expect((await call(u.mgrA!, 'PATCH', `/stock-transfers/${id}/ship`)).statusCode).toBe(200)
    expect(await balanceOf(it0.id, A.locationId)).toBe(3)
    expect((await lotValuation(prisma, A.tenantId)).food).toBe(before.food)
    expect((await lotValuation(prisma, A.tenantId, undefined, { locationId: A.locationId })).food).toBeLessThan(before.food)
    const c = await call(u.mgrA!, 'PATCH', `/stock-transfers/${id}/cancel`, { reason: 'van broke down' })
    expect(c.statusCode, c.body).toBe(200)
    const lot = await prisma.stockLot.findUniqueOrThrow({ where: { id: lotId } })
    expect(lot.remainingQty).toBe(5)
    expect(Number(lot.remainingValueCents)).toBe(100_000)
    expect(await balanceOf(it0.id, A.locationId)).toBe(5)
    expect(await prisma.stockLot.count({ where: { inventoryItemId: it0.id, sourceType: 'transfer_in' } })).toBe(0)
    expect((await lotValuation(prisma, A.tenantId)).food).toBe(before.food)
  })

  it('received lots keep the shipped cost; across two companies is 422 TRANSFER_CROSS_COMPANY; B gets 404', async () => {
    const it0 = await mkItem(A)
    await gainAt(A, it0.id, 3, A.locationId, 30_000)
    const id = await approved(it0.id, 3)
    expect((await call(u.mgrB!, 'PATCH', `/stock-transfers/${id}/ship`)).statusCode).toBe(404)
    expect((await call(u.mgrA!, 'PATCH', `/stock-transfers/${id}/ship`)).statusCode).toBe(200)
    expect((await call(u.mgrB!, 'PATCH', `/stock-transfers/${id}/receive`, {})).statusCode).toBe(404)
    expect((await call(u.mgrA!, 'PATCH', `/stock-transfers/${id}/receive`, {})).statusCode).toBe(200)
    const landed = await prisma.stockLot.findMany({ where: { inventoryItemId: it0.id, locationId: A2 } })
    expect(landed).toHaveLength(1)
    expect(landed[0]).toMatchObject({ sourceType: 'transfer_in', unitCostCents: 30_000, remainingQty: 3 })
    expect(Number(landed[0]!.remainingValueCents)).toBe(90_000)

    const cross = await call(u.ceo!, 'POST', '/stock-transfers', { inventoryItemId: it0.id, fromLocationId: A.locationId, toLocationId: B.locationId, quantity: 1, unit: 'kg' })
    expect(cross.statusCode).toBe(422)
    expect(cross.json().error.code).toBe('TRANSFER_CROSS_COMPANY')
  })
})

describe('review fixes (2026-10-24)', () => {
  async function approvedShip(itemId: string, qty: number) {
    const created = await call(u.mgrA!, 'POST', '/stock-transfers', { inventoryItemId: itemId, fromLocationId: A.locationId, toLocationId: A2, quantity: qty, unit: 'kg' })
    const id = created.json().id as string
    expect((await call(u.mgrA!, 'PATCH', `/stock-transfers/${id}/approve`)).statusCode).toBe(200)
    expect((await call(u.mgrA!, 'PATCH', `/stock-transfers/${id}/ship`)).statusCode).toBe(200)
    return id
  }

  it('ship 10, receive 9 at a site already 10 short: the loss is booked first, then 9 settle the shortfall', async () => {
    const it0 = await mkItem(A)
    await gainAt(A, it0.id, 10, A.locationId)
    await prisma.$transaction((tx) => consumeFifoTx(tx, {
      tenantId: A.tenantId, inventoryItemId: it0.id, qty: 10, kind: 'sale', sourceType: STOCK_SOURCE.orderItemSale, sourceId: randomUUID(),
      clamp: true, locationId: A2, occurredAt: new Date(),
    }))
    const id = await approvedShip(it0.id, 10)
    const r = await call(u.mgrA!, 'PATCH', `/stock-transfers/${id}/receive`, { receivedQuantity: 9, shortfallReason: 'one bag split' })
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json().transitLoss.quantity).toBe(1)
    const settled = await prisma.stockMovement.aggregate({ where: { inventoryItemId: it0.id, kind: 'shortfall_settle' }, _sum: { qty: true } })
    expect(settled._sum.qty).toBeCloseTo(-9, 6)
    expect(await balanceOf(it0.id, A2)).toBe(0)
  })

  it('re-pricing a lot follows its units in transit, and the transfer lands at the re-priced cost', async () => {
    const it0 = await mkItem(A)
    const { lotId } = await gainAt(A, it0.id, 10, A.locationId, 1_000)
    const id = await approvedShip(it0.id, 4)
    const r = await prisma.$transaction((tx) => repriceLotTx(tx, { lotId, deltaCents: 1_000, qtyBasis: 10, sourceType: 'test.reprice', sourceId: randomUUID() }))
    expect(r).toEqual({ onHandCents: 1_000, usedCents: 0 })
    expect(Number((await prisma.stockLot.findUniqueOrThrow({ where: { id: lotId } })).remainingValueCents)).toBe(6_600)
    expect((await call(u.mgrA!, 'PATCH', `/stock-transfers/${id}/receive`, {})).statusCode).toBe(200)
    const landed = await prisma.stockLot.findFirstOrThrow({ where: { inventoryItemId: it0.id, locationId: A2 } })
    expect(Number(landed.remainingValueCents)).toBe(4_400)
    // Σ movements per site == that site's lots.
    for (const loc of [A.locationId, A2]) {
      const m = await prisma.stockMovement.aggregate({ where: { inventoryItemId: it0.id, locationId: loc }, _sum: { valueCents: true } })
      const l = await prisma.stockLot.aggregate({ where: { inventoryItemId: it0.id, locationId: loc }, _sum: { remainingValueCents: true } })
      expect(Number(m._sum.valueCents)).toBe(Number(l._sum.remainingValueCents))
    }
  })

  it('the cut-over retags every lot-carrying movement to its lot\'s site; lots at a deleted outlet move to the stock home', async () => {
    const E = await mkCompany('site-e')
    const E2 = (await prisma.location.create({ data: { slug: 'loc-site-e2', name: 'E2', tenantId: E.tenantId, isActive: false } })).id
    await prisma.setting.create({ data: { key: fifoCutoverKey(E.tenantId), value: new Date(Date.now() - 30 * DAY).toISOString() } })
    const it0 = await prisma.inventoryItem.create({ data: { name: 'Legacy rice', unit: 'kg', tenantId: E.tenantId, category: 'dry_goods', currentStock: 5 } })
    const lot = await prisma.stockLot.create({ data: {
      tenantId: E.tenantId, inventoryItemId: it0.id, sourceType: 'fifo_cutover', sourceId: E.tenantId, costClass: 'food',
      receivedAt: new Date(Date.now() - 30 * DAY), qtyIn: 5, remainingQty: 5, unitCostCents: 100, valueInCents: 500, remainingValueCents: 500,
    } })
    // A movement of that lot tagged with another outlet (the old "where it was sold" tag).
    await prisma.stockMovement.create({ data: {
      tenantId: E.tenantId, inventoryItemId: it0.id, lotId: lot.id, lotKey: lot.id, kind: 'fifo_cutover', qty: 5, valueCents: 500, unitCostCents: 100,
      costClass: 'food', locationId: E2, sourceType: 'fifo_cutover', sourceId: E.tenantId, occurredAt: new Date(Date.now() - 30 * DAY),
    } })
    await ensureFifoReady(E.tenantId)
    expect((await prisma.stockMovement.findFirstOrThrow({ where: { lotId: lot.id } })).locationId).toBe(E.locationId)
    // A lot left at an outlet that is then deleted moves to the home, with its movements.
    const it1 = await prisma.inventoryItem.create({ data: { name: 'Lentils', unit: 'kg', tenantId: E.tenantId, category: 'dry_goods' } })
    const src = `e-gain-${randomUUID()}`
    const { lotId } = await prisma.$transaction((tx) => addLotTx(tx, {
      tenantId: E.tenantId, inventoryItemId: it1.id, qty: 3, unitCostCents: 100, kind: 'count_gain', lotSourceType: 'count_gain',
      lotSourceId: src, movementSourceType: 'test', movementSourceId: src, receivedAt: new Date(), locationId: E2,
    }))
    expect(await balanceOf(it1.id, E2)).toBe(3)
    await prisma.location.update({ where: { id: E2 }, data: { deletedAt: new Date() } })
    await ensureFifoReady(E.tenantId)
    expect((await prisma.stockLot.findUniqueOrThrow({ where: { id: lotId } })).locationId).toBe(E.locationId)
    expect(await prisma.stockMovement.count({ where: { inventoryItemId: it1.id, locationId: E2 } })).toBe(0)
    expect(await balanceOf(it1.id, E2)).toBe(0)
    expect(await balanceOf(it1.id, E.locationId)).toBe(3)
    expect(await prisma.auditLog.count({ where: { tenantId: E.tenantId, action: 'stock.site_relocate' } })).toBe(1)
    await ensureFifoReady(E.tenantId)   // idempotent
    expect(await prisma.auditLog.count({ where: { tenantId: E.tenantId, action: 'stock.site_relocate' } })).toBe(1)
  })
})
