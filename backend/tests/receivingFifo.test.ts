// Receiving on FIFO lots + GRNI (finance wave B, H16 / H17) — procurement/receiving.ts.
//
//   - A PO receipt opens one lot per line at the PO price and posts
//     'procurement.receipt:<id>' Dr 12x0 per class / Cr 2015, in the
//     supplier's company; GoodsReceipt.tenantId / locationId are set.
//   - A quantity a bill already priced (a pending GrniMatch) opens its own lot
//     at the billed price: one receipt line, two lots; the match turns live.
//   - Company-less items and suppliers are refused on the PO path AND the
//     no-PO path (422); an outlet of another company is 422
//     LOCATION_NOT_IN_COMPANY and nothing is written; company B gets 404 on
//     company A's PO.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { invalidateSetupCache } from '../src/lib/setup-config.js'
import { createBill } from '../src/modules/procurement/service.js'
import { receiveGoods } from '../src/modules/procurement/receiving.js'
import { procurementRoutes } from '../src/modules/procurement/routes.js'

const RUN = Math.random().toString(36).slice(2, 8)
const PHOTO = 'https://example.com/dock.jpg'
let tenantA: string, tenantB: string, supA: string, supOrphan: string
let locA: string, locB: string
let app: FastifyInstance
const users: Record<string, { id: string; token: string }> = {}

async function mkUser(key: string, role: string, tenantId: string) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${RUN}@rcvfifo.test`, password: await bcrypt.hash('x-Password-1', 4), role: role as 'admin', isActive: true, accountStatus: 'active', tenantId },
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } })
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}
const call = (who: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${users[who]!.token}` }, ...(payload !== undefined ? { payload: payload as object } : {}) })

async function entry(tenantId: string, reference: string) {
  const je = await prisma.journalEntry.findFirst({ where: { tenantId, reference }, include: { lines: { include: { account: { select: { code: true } } } } } })
  return je?.lines.map((l) => [l.account.code, l.type, Number(l.amountCents)]).sort() ?? null
}
const mkItem = async (name: string, tenantId: string | null, category: string | null = null) =>
  (await prisma.inventoryItem.create({ data: { name: `${name} ${RUN}`, unit: 'kg', tenantId, currentStock: 0, unitCostCents: 100, category } })).id
async function sentPo(supplierId: string, lines: Array<{ item: string; qty: number; cost: number }>) {
  const po = await prisma.purchaseOrder.create({
    data: { supplierId, status: 'sent', totalCents: 0, lines: { create: lines.map((l) => ({ inventoryItemId: l.item, quantityOrdered: l.qty, unitCostCents: l.cost })) } },
    include: { lines: true },
  })
  return { poId: po.id, lineOf: (item: string) => po.lines.find((l) => l.inventoryItemId === item)!.id }
}

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'RF A', slug: `rf-a-${RUN}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'RF B', slug: `rf-b-${RUN}` } })).id
  await ensureChartOfAccounts(tenantA)
  await ensureChartOfAccounts(tenantB)
  invalidateSetupCache()
  supA = (await prisma.supplier.create({ data: { name: `RF Foods ${RUN}`, tenantId: tenantA } })).id
  supOrphan = (await prisma.supplier.create({ data: { name: `RF Orphan ${RUN}`, tenantId: null } })).id
  locA = (await prisma.location.create({ data: { slug: `rf-loc-a-${RUN}`, name: 'Clifton kitchen', tenantId: tenantA } })).id
  locB = (await prisma.location.create({ data: { slug: `rf-loc-b-${RUN}`, name: 'B kitchen', tenantId: tenantB } })).id
  await mkUser('ceoA', 'admin', tenantA)
  await mkUser('mgrA', 'boh_management', tenantA)
  await mkUser('mgrB', 'boh_management', tenantB)
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(procurementRoutes, { prefix: '/procurement' })
  await app.ready()
})

afterAll(async () => { invalidateSetupCache(); await app.close() })

describe('a PO receipt opens lots and books Dr 12x0 / Cr 2015', () => {
  it('one lot per line at the PO price, by class; the receipt carries its company and outlet', async () => {
    const flour = await mkItem('Flour', tenantA)
    const cola = await mkItem('Cola', tenantA, 'beverage')
    const po = await sentPo(supA, [{ item: flour, qty: 10, cost: 1_000 }, { item: cola, qty: 24, cost: 500 }])
    const res = await call('mgrA', 'POST', `/procurement/purchase-orders/${po.poId}/receive`, {
      photoUrl: PHOTO, locationId: locA,
      lines: [{ poLineId: po.lineOf(flour), quantityReceived: 10 }, { poLineId: po.lineOf(cola), quantityReceived: 24 }],
    })
    expect(res.statusCode, res.body).toBe(201)
    const receipt = await prisma.goodsReceipt.findUniqueOrThrow({ where: { id: res.json().receipt.id }, include: { lines: true } })
    expect(receipt).toMatchObject({ tenantId: tenantA, locationId: locA, settledByType: null })
    const lots = await prisma.stockLot.findMany({ where: { receiptLineId: { in: receipt.lines.map((l) => l.id) } } })
    expect(lots.map((l) => [l.costClass, l.qtyIn, l.unitCostCents, Number(l.valueInCents), l.locationId]).sort()).toEqual([
      ['beverage', 24, 500, 12_000, locA],
      ['food', 10, 1_000, 10_000, locA],
    ])
    for (const l of lots) expect(l.sourceId).toBe(`${l.receiptLineId}:po`)
    expect(receipt.lines.every((l) => l.lotUnitCostCents === l.poUnitCostCents && l.billedQty === 0)).toBe(true)
    expect(await entry(tenantA, `procurement.receipt:${receipt.id}`)).toEqual([
      ['1210', 'debit', 10_000], ['1220', 'debit', 12_000], ['2015', 'credit', 22_000],
    ])
    expect(await prisma.inventoryItem.findUniqueOrThrow({ where: { id: cola } })).toMatchObject({ currentStock: 24, unitCostCents: 500 })
  })

  it('a pending bill priced part of the line first: one receipt line opens two lots; 2015 keeps only the unbilled part', async () => {
    const beef = await mkItem('Beef', tenantA)
    const po = await sentPo(supA, [{ item: beef, qty: 10, cost: 1_000 }])
    const bill = await createBill({
      supplierId: supA, poId: po.poId, billNumber: `RF-PEND-${RUN}`, billDate: new Date().toISOString(),
      lines: [{ inventoryItemId: beef, poLineId: po.lineOf(beef), description: 'beef', quantity: 4, unitCostCents: 1_200 }],
      createdBy: users['ceoA']!.id,
    })
    const r = await receiveGoods({ actor: { id: users['mgrA']!.id, role: 'boh_management' }, poId: po.poId, photoUrl: PHOTO, lines: [{ poLineId: po.lineOf(beef), quantityReceived: 10 }] })
    const rl = r.receipt.lines[0]!
    const match = await prisma.grniMatch.findFirstOrThrow({ where: { billId: bill.id } })
    expect(match).toMatchObject({ status: 'live', receiptLineId: rl.id, qty: 4 })
    const lots = await prisma.stockLot.findMany({ where: { receiptLineId: rl.id } })
    expect(lots.map((l) => [l.sourceId, l.qtyIn, l.unitCostCents, Number(l.valueInCents)]).sort()).toEqual([
      [`${rl.id}:${match.id}`, 4, 1_200, 4_800],
      [`${rl.id}:po`, 6, 1_000, 6_000],
    ].sort())
    const line = await prisma.goodsReceiptLine.findUniqueOrThrow({ where: { id: rl.id } })
    expect(line).toMatchObject({ billedQty: 4, lotUnitCostCents: 1_000 })
    // Dr 2015 4,800 by the bill, Cr 2015 10,800 by the receipt: 6,000 open.
    expect(await entry(tenantA, `procurement.receipt:${r.receipt.id}`)).toEqual([['1210', 'debit', 10_800], ['2015', 'credit', 10_800]])
    expect(await entry(tenantA, `supplier.bill:${bill.id}`)).toEqual([['2010', 'credit', 4_800], ['2015', 'debit', 4_800]])
    // The FIFO head: both lots share the receipt's date; the oldest by id comes first.
    expect(await prisma.inventoryItem.findUniqueOrThrow({ where: { id: beef }, select: { currentStock: true } })).toEqual({ currentStock: 10 })
  })
})

describe('refusals — company-less rows on every path, another company\'s outlet', () => {
  const receive = (input: Parameters<typeof receiveGoods>[0]) => receiveGoods(input)

  it('a company-less item: refused on the PO path and the no-PO path (422 ITEM_HAS_NO_COMPANY)', async () => {
    const orphanItem = await mkItem('Orphan salt', null)
    const po = await sentPo(supA, [{ item: orphanItem, qty: 1, cost: 100 }])
    await expect(receive({ actor: { id: users['mgrA']!.id, role: 'boh_management' }, poId: po.poId, photoUrl: PHOTO, lines: [{ poLineId: po.lineOf(orphanItem), quantityReceived: 1 }] }))
      .rejects.toMatchObject({ code: 'ITEM_HAS_NO_COMPANY', statusCode: 422 })
    await expect(receive({ actor: { id: users['mgrA']!.id, role: 'boh_management' }, supplierId: supA, photoUrl: PHOTO, lines: [{ inventoryItemId: orphanItem, quantityReceived: 1, unitCostCents: 100 }] }))
      .rejects.toMatchObject({ code: 'ITEM_HAS_NO_COMPANY', statusCode: 422 })
    expect(await prisma.goodsReceiptLine.count({ where: { inventoryItemId: orphanItem } })).toBe(0)
  })

  it('a company-less supplier: refused on the PO path too (422 SUPPLIER_HAS_NO_COMPANY)', async () => {
    const salt = await mkItem('Salt', tenantA)
    const po = await sentPo(supOrphan, [{ item: salt, qty: 1, cost: 100 }])
    await expect(receive({ actor: { id: users['ceoA']!.id, role: 'admin' }, poId: po.poId, photoUrl: PHOTO, lines: [{ poLineId: po.lineOf(salt), quantityReceived: 1 }] }))
      .rejects.toMatchObject({ code: 'SUPPLIER_HAS_NO_COMPANY', statusCode: 422 })
    await expect(receive({ actor: { id: users['mgrA']!.id, role: 'boh_management' }, supplierId: supOrphan, photoUrl: PHOTO, lines: [{ inventoryItemId: salt, quantityReceived: 1, unitCostCents: 100 }] }))
      .rejects.toMatchObject({ code: 'SUPPLIER_HAS_NO_COMPANY', statusCode: 422 })
    expect(await prisma.goodsReceipt.count({ where: { supplierId: supOrphan } })).toBe(0)
  })

  it('an outlet of another company is 422 LOCATION_NOT_IN_COMPANY; nothing is written', async () => {
    const rice = await mkItem('Rice', tenantA)
    const po = await sentPo(supA, [{ item: rice, qty: 5, cost: 100 }])
    const res = await call('mgrA', 'POST', `/procurement/purchase-orders/${po.poId}/receive`, {
      photoUrl: PHOTO, locationId: locB, lines: [{ poLineId: po.lineOf(rice), quantityReceived: 5 }],
    })
    expect(res.statusCode).toBe(422)
    expect(res.json().error.code).toBe('LOCATION_NOT_IN_COMPANY')
    expect(await prisma.goodsReceipt.count({ where: { poId: po.poId } })).toBe(0)
    expect(await prisma.stockLot.count({ where: { inventoryItemId: rice } })).toBe(0)
    expect((await prisma.purchaseOrderLine.findUniqueOrThrow({ where: { id: po.lineOf(rice) } })).quantityReceived).toBe(0)
  })

  it('company B gets 404 on company A\'s PO', async () => {
    const oil = await mkItem('Oil', tenantA)
    const po = await sentPo(supA, [{ item: oil, qty: 1, cost: 100 }])
    const res = await call('mgrB', 'POST', `/procurement/purchase-orders/${po.poId}/receive`, { photoUrl: PHOTO, lines: [{ poLineId: po.lineOf(oil), quantityReceived: 1 }] })
    expect(res.statusCode).toBe(404)
    expect(await prisma.stockLot.count({ where: { inventoryItemId: oil } })).toBe(0)
  })
})
