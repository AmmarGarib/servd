// A stock item's history (owner, 2026-10-27: "add history on each stock item"): GET /inventory/:id/movements reads
// the item's stock movements, newest first, one row per document (a draw over several lots is one row).
//   - a sale over two lots is ONE row with the dish and the order reference; deliveries name the supplier
//   - the kitchen floor sees quantities, never values
//   - another company's item 404; another company's outlet 422; a site filter keeps that outlet only
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { AppError } from '../src/lib/errors.js'
import { addLotTx, ensureFifoReady } from '../src/lib/stockLedger.js'
import { orderRefOf } from '../src/lib/orderRef.js'
import { inventoryRoutes } from '../src/modules/inventory/routes.js'
import { mkCompany, mkUser, type Company, type Who } from './connectorsFixtures.js'

let app: FastifyInstance
let A: Company
let B: Company
let A2 = ''
let itemId = ''
let orderId = ''
const u: Record<string, Who> = {}

const get = (who: Who, url: string) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${who.token}` } })

beforeAll(async () => {
  A = await mkCompany('ih-a')
  B = await mkCompany('ih-b')
  A2 = (await prisma.location.create({ data: { slug: 'loc-ih-a2', name: 'Outlet IH A2', tenantId: A.tenantId } })).id
  u.mgrA = await mkUser('ihMgrA', 'manager', A.tenantId)
  u.cookA = await mkUser('ihCookA', 'boh', A.tenantId)
  u.mgrB = await mkUser('ihMgrB', 'manager', B.tenantId)
  await ensureFifoReady(A.tenantId)
  const item = await prisma.inventoryItem.create({ data: { name: 'IH Beef mince', unit: 'g', tenantId: A.tenantId, unitCostCents: 200, category: 'meat' } })
  itemId = item.id
  const supplier = await prisma.supplier.create({ data: { name: 'IH Karachi Meat', tenantId: A.tenantId } })
  const user = await prisma.user.findUniqueOrThrow({ where: { id: u.mgrA!.id } })
  const receipt = await prisma.goodsReceipt.create({ data: { supplierId: supplier.id, receivedById: user.id, tenantId: A.tenantId, locationId: A.locationId } })
  const line = await prisma.goodsReceiptLine.create({ data: { receiptId: receipt.id, inventoryItemId: itemId, description: 'Beef', receivedQty: 1000, unit: 'g' } })
  const lot = (n: number, src: string, at: Date, loc = A.locationId) => prisma.$transaction((tx) => addLotTx(tx, {
    tenantId: A.tenantId, inventoryItemId: itemId, qty: n, unitCostCents: 200, kind: 'receipt', lotSourceType: 'goods_receipt_line',
    lotSourceId: src, movementSourceType: 'goods_receipt_line', movementSourceId: src, receivedAt: at, locationId: loc,
  }))
  const t0 = Date.now() - 3 * 3_600_000
  const l1 = await lot(100, line.id, new Date(t0))
  const l2 = await lot(500, `ih-second-${Date.now()}`, new Date(t0 + 60_000))
  await lot(300, `ih-a2-${Date.now()}`, new Date(t0 + 120_000), A2)
  // A sale of 2 burgers drawn over BOTH lots at outlet 1 (written as the ledger writes it: one row per lot).
  const order = await prisma.order.create({ data: { conceptId: A.conceptId, source: 'pos', fulfilmentType: 'dine_in', status: 'completed', totalCents: 2000, taxRatePct: 15 } })
  orderId = order.id
  const oi = await prisma.orderItem.create({ data: { orderId, name: 'Classic Smash Burger', quantity: 2, unitPriceCents: 1000 } })
  const at = new Date(t0 + 180_000)
  for (const [l, q] of [[l1, 100], [l2, 200]] as const) {
    await prisma.stockMovement.create({ data: {
      tenantId: A.tenantId, inventoryItemId: itemId, lotId: l.lotId, lotKey: l.lotId, kind: 'sale', qty: -q, valueCents: -q * 200, unitCostCents: 200,
      costClass: 'food', locationId: A.locationId, orderId, orderItemId: oi.id, sourceType: 'order_item.sale', sourceId: oi.id, occurredAt: at,
    } })
  }
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(inventoryRoutes, { prefix: '/inventory' })
  await app.ready()
}, 60_000)

afterAll(async () => { await app?.close() })

describe('stock item history', () => {
  it('lists every movement newest first; a sale over two lots is one row with the dish and order', async () => {
    const r = await get(u.mgrA!, `/inventory/${itemId}/movements`)
    expect(r.statusCode, r.body).toBe(200)
    const rows = r.json().rows as Array<Record<string, unknown>>
    expect(rows.map((x) => x['kind'])).toEqual(['sale', 'receipt', 'receipt', 'receipt'])
    expect(rows[0]).toMatchObject({ qty: -300, valueCents: -60_000, kindLabel: 'Sold (plate recipe)', orderRef: orderRefOf(orderId), detail: '2 × Classic Smash Burger' })
    expect(rows.find((x) => x['detail'] === 'IH Karachi Meat')).toMatchObject({ kind: 'receipt', qty: 100 })
  })

  it('the kitchen floor sees quantities, never values', async () => {
    const r = await get(u.cookA!, `/inventory/${itemId}/movements`)
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json().costsHidden).toBe(true)
    expect((r.json().rows as Array<{ valueCents: unknown }>).every((x) => x.valueCents === null)).toBe(true)
  })

  it('a site filter keeps that outlet; another company\'s item 404 and outlet 422', async () => {
    const site = await get(u.mgrA!, `/inventory/${itemId}/movements?locationId=${A2}`)
    expect(site.statusCode, site.body).toBe(200)
    expect(site.json().rows).toHaveLength(1)
    expect(site.json().rows[0]).toMatchObject({ qty: 300, location: 'Outlet IH A2' })
    expect((await get(u.mgrB!, `/inventory/${itemId}/movements`)).statusCode).toBe(404)
    expect((await get(u.mgrA!, `/inventory/${itemId}/movements?locationId=${B.locationId}`)).statusCode).toBe(422)
  })
})
