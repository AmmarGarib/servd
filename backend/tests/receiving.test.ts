// Goods receiving, reconciled onto ONE path (procurement receiveGoods), the
// one separation-of-duties helper, and supplier balances with the opening
// balance posted to the ledger once.
//
// What this guards:
//   - The dock page (POST /crosschecks/receiving) and the PO receive route
//     (POST /procurement/purchase-orders/:id/receive) both write a
//     GoodsReceipt, bump PurchaseOrderLine.quantityReceived, move stock and
//     re-average the unit cost (moving average of actual deliveries), in one
//     transaction. A line can be 0 / omitted; a part-received PO stays open.
//   - Only sent / partial POs can be received (not draft, pending, approved-
//     but-never-sent, received).
//   - Owner decision 27: receiving without a PO is allowed for manager tiers
//     with a unit cost; non-managers are refused; the PO raiser can't
//     receive it — except the CEO.
//   - The dock photo threshold and the >5% variance flag.
//   - GET /crosschecks/receiving and the dock PO picker are company-scoped.
//   - One assertNotSelfApproval: CEO exempt, blocked attempts flagged.
//   - Supplier opening balances post to AP 2010 (as deltas); the statement's
//     one balance equals the ledger; an unapplied payment nets it off.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { invalidateSetupCache } from '../src/lib/setup-config.js'
import { createPo, submitPo, markPoSent, createPayment, agingReport } from '../src/modules/procurement/service.js'
import { postSupplierPayment } from '../src/modules/accounting/supplierPosting.js'
import { syncSupplierOpeningBalance } from '../src/modules/procurement/openingBalance.js'
import { assertNotSelfApproval } from '../src/lib/separation-of-duties.js'
import { procurementRoutes } from '../src/modules/procurement/routes.js'
import { crosschecksRoutes } from '../src/modules/crosschecks/routes.js'

let tenantA: string
let tenantB: string
let supA: string
let supB: string
let flour: string
let sugar: string
let itemB: string
let app: FastifyInstance
const users: Record<string, { id: string; token: string }> = {}
const PHOTO = 'https://example.com/dock.jpg'

async function mkUser(key: string, role: string, primary: string) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.rcvtest@gsfoods.pk`, password: await bcrypt.hash('x-Password-1', 4), role: role as never, isActive: true, accountStatus: 'active', tenantId: primary },
  })
  await prisma.tenantMember.create({ data: { tenantId: primary, userId: u.id } as never }).catch(() => {})
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}

const call = (who: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${users[who]!.token}` }, ...(payload !== undefined ? { payload: payload as object } : {}) })

async function sentPo(createdBy: string, lines: Array<{ item: string; qty: number; cost: number }>, supplierId = supA) {
  const po = await createPo({
    supplierId,
    lines: lines.map((l) => ({ inventoryItemId: l.item, quantityOrdered: l.qty, unitCostCents: l.cost })),
    createdBy,
  })
  const r = await submitPo(po.id, createdBy)   // under the approval threshold → approved (not sent)
  expect(r.status).toBe('approved')
  await markPoSent(po.id, createdBy, { channel: 'phone' })
  return po
}

async function item(id: string) {
  return prisma.inventoryItem.findUniqueOrThrow({ where: { id } })
}

async function ledgerAp(tenantId: string, supplierRefPrefix?: string): Promise<number> {
  const acct = await prisma.account.findFirstOrThrow({ where: { tenantId, code: '2010' } })
  const sums = await prisma.journalLine.groupBy({
    by: ['type'],
    where: { accountId: acct.id, ...(supplierRefPrefix ? { journalEntry: { reference: { startsWith: supplierRefPrefix } } } : {}) },
    _sum: { amountCents: true },
  })
  const cr = sums.find((s) => s.type === 'credit')?._sum.amountCents ?? 0
  const dr = sums.find((s) => s.type === 'debit')?._sum.amountCents ?? 0
  return cr - dr
}

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'RCV A', slug: 'rcv-a' } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'RCV B', slug: 'rcv-b' } })).id
  await ensureChartOfAccounts(tenantA)
  await ensureChartOfAccounts(tenantB)
  invalidateSetupCache()

  supA = (await prisma.supplier.create({ data: { name: 'Mill Co', tenantId: tenantA, paymentTermsDays: 10 } })).id
  supB = (await prisma.supplier.create({ data: { name: 'B Veg', tenantId: tenantB, paymentTermsDays: 10 } })).id
  flour = (await prisma.inventoryItem.create({ data: { name: 'Flour', unit: 'kg', tenantId: tenantA, currentStock: 10, unitCostCents: 100 } })).id
  sugar = (await prisma.inventoryItem.create({ data: { name: 'Sugar', unit: 'kg', tenantId: tenantA, currentStock: 0 } })).id
  itemB = (await prisma.inventoryItem.create({ data: { name: 'Onion', unit: 'kg', tenantId: tenantB, currentStock: 0 } })).id

  await mkUser('ceo', 'admin', tenantA)
  await mkUser('mgr', 'boh_management', tenantA)
  await mkUser('mgr2', 'foh_management', tenantA)
  await mkUser('cook', 'boh', tenantA)
  await mkUser('mgrB', 'boh_management', tenantB)

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(procurementRoutes, { prefix: '/procurement' })
  await app.register(crosschecksRoutes, { prefix: '/crosschecks' })
  await app.ready()
})

afterAll(async () => {
  invalidateSetupCache()
  await app.close()
})

describe('receiving against a PO — one path, PO + stock + cost together', () => {
  it('refuses a PO that has not been approved and sent', async () => {
    const po = await createPo({ supplierId: supA, lines: [{ inventoryItemId: flour, quantityOrdered: 5, unitCostCents: 200 }], createdBy: users['mgr']!.id })
    const line = (await prisma.purchaseOrderLine.findFirstOrThrow({ where: { purchaseOrderId: po.id } })).id
    const res = await call('ceo', 'POST', `/procurement/purchase-orders/${po.id}/receive`, { photoUrl: PHOTO, lines: [{ poLineId: line, quantityReceived: 5 }] })
    expect(res.statusCode).toBe(400)
    expect(res.json().error.code).toBe('PO_NOT_SENT')
    expect((await item(flour)).currentStock).toBe(10)
  })

  it('the PO raiser cannot receive it (flagged); the CEO can receive their own', async () => {
    const po = await sentPo(users['mgr']!.id, [{ item: flour, qty: 1, cost: 100 }])
    const line = (await prisma.purchaseOrderLine.findFirstOrThrow({ where: { purchaseOrderId: po.id } })).id
    const res = await call('mgr', 'POST', '/crosschecks/receiving', { poId: po.id, photoUrl: PHOTO, lines: [{ poLineId: line, quantityReceived: 1 }] })
    expect(res.statusCode).toBe(403)
    expect(res.json().error.code).toBe('SELF_APPROVAL_BLOCKED')
    expect(await prisma.exceptionFlag.count({ where: { kind: 'self_approval', entityId: po.id } })).toBe(1)

    const ceoPo = await sentPo(users['ceo']!.id, [{ item: flour, qty: 1, cost: 100 }])
    const ceoLine = (await prisma.purchaseOrderLine.findFirstOrThrow({ where: { purchaseOrderId: ceoPo.id } })).id
    const ok = await call('ceo', 'POST', `/procurement/purchase-orders/${ceoPo.id}/receive`, { photoUrl: PHOTO, lines: [{ poLineId: ceoLine, quantityReceived: 1 }] })
    expect(ok.statusCode).toBe(201)
    // Flour: 10 @ 100 + 1 @ 100 → 11 @ 100
    expect(await item(flour)).toMatchObject({ currentStock: 11, unitCostCents: 100 })
  })

  it('part-receives from the dock (a line can be 0), then completes from the PO route', async () => {
    const po = await sentPo(users['mgr']!.id, [{ item: flour, qty: 10, cost: 210 }, { item: sugar, qty: 4, cost: 300 }])
    const lines = await prisma.purchaseOrderLine.findMany({ where: { purchaseOrderId: po.id } })
    const fl = lines.find((l) => l.inventoryItemId === flour)!.id
    const sg = lines.find((l) => l.inventoryItemId === sugar)!.id

    // The dock picker lists it.
    const open = await call('mgr2', 'GET', '/crosschecks/receiving/open-pos')
    expect(open.statusCode).toBe(200)
    expect((open.json() as Array<{ id: string }>).map((p) => p.id)).toContain(po.id)

    // 1st delivery: all the flour, no sugar.
    const r1 = await call('mgr2', 'POST', '/crosschecks/receiving', {
      poId: po.id, photoUrl: PHOTO, lines: [{ poLineId: fl, quantityReceived: 10 }, { poLineId: sg, quantityReceived: 0 }],
    })
    expect(r1.statusCode).toBe(201)
    expect(r1.json().poStatus).toBe('partial')
    // FIFO lots (wave B): 11 @ 100 + 10 @ 210 → 21 on hand; the item's cost
    // is the FIFO head (the oldest open lot) — 100 until that stock is used.
    expect(await item(flour)).toMatchObject({ currentStock: 21, unitCostCents: 100 })
    const lots = await prisma.stockLot.findMany({ where: { inventoryItemId: flour }, orderBy: { receivedAt: 'asc' } })
    expect(lots.reduce((s, l) => s + l.remainingQty, 0)).toBe(21)
    expect(lots.at(-1)).toMatchObject({ qtyIn: 10, unitCostCents: 210, sourceType: 'goods_receipt_line' })
    expect((await item(sugar)).currentStock).toBe(0)
    const after1 = await prisma.purchaseOrderLine.findMany({ where: { purchaseOrderId: po.id } })
    expect(after1.find((l) => l.id === fl)!.quantityReceived).toBe(10)
    expect(after1.find((l) => l.id === sg)!.quantityReceived).toBe(0)
    const grn1 = await prisma.goodsReceipt.findUniqueOrThrow({ where: { id: r1.json().id }, include: { lines: true } })
    expect(grn1.poId).toBe(po.id)
    expect(grn1.lines).toHaveLength(2)
    // The sugar that didn't arrive is a 100% short shipment → flagged.
    expect(grn1.varianceFlag).toBe(true)
    expect(await prisma.exceptionFlag.count({ where: { kind: 'short_shipment', entityId: grn1.id } })).toBe(1)
    expect(await prisma.itemPriceHistory.count({ where: { inventoryItemId: flour, source: 'po_receive', newCostCents: 210 } })).toBe(1)
    // Booked on arrival (H17): Dr 1210 / Cr 2015 GRNI at the PO price.
    const grnEntry = await prisma.journalEntry.findFirstOrThrow({ where: { tenantId: tenantA, reference: `procurement.receipt:${grn1.id}` }, include: { lines: { include: { account: { select: { code: true } } } } } })
    expect(grnEntry.lines.map((l) => [l.account.code, l.type, Number(l.amountCents)]).sort()).toEqual([['1210', 'debit', 2_100], ['2015', 'credit', 2_100]])

    // A second receipt defaults to what is outstanding — here via the PO route, sugar only.
    const r2 = await call('ceo', 'POST', `/procurement/purchase-orders/${po.id}/receive`, { photoUrl: PHOTO, lines: [{ poLineId: sg, quantityReceived: 4 }] })
    expect(r2.statusCode).toBe(201)
    expect(r2.json().status).toBe('received')
    expect(await item(sugar)).toMatchObject({ currentStock: 4, unitCostCents: 300 })
    expect(await prisma.goodsReceipt.count({ where: { poId: po.id } })).toBe(2)

    // Received POs can't be received again, from either door.
    const again = await call('mgr2', 'POST', '/crosschecks/receiving', { poId: po.id, photoUrl: PHOTO, lines: [{ poLineId: sg, quantityReceived: 1 }] })
    expect(again.json().error.code).toBe('PO_RECEIVED')
    expect((await item(sugar)).currentStock).toBe(4)
  })

  it('refuses an all-zero receipt and a line from another PO', async () => {
    const po = await sentPo(users['mgr']!.id, [{ item: flour, qty: 2, cost: 150 }])
    const other = await sentPo(users['mgr']!.id, [{ item: flour, qty: 2, cost: 150 }])
    const line = (await prisma.purchaseOrderLine.findFirstOrThrow({ where: { purchaseOrderId: po.id } })).id
    const foreign = (await prisma.purchaseOrderLine.findFirstOrThrow({ where: { purchaseOrderId: other.id } })).id
    expect((await call('mgr2', 'POST', '/crosschecks/receiving', { poId: po.id, lines: [{ poLineId: line, quantityReceived: 0 }] })).json().error.code).toBe('NOTHING_RECEIVED')
    expect((await call('mgr2', 'POST', '/crosschecks/receiving', { poId: po.id, lines: [{ poLineId: foreign, quantityReceived: 1 }] })).json().error.code).toBe('LINE_NOT_FOUND')
  })
})

describe('receiving without a PO — manager tiers, unit cost at the dock', () => {
  it('requires a unit cost, then receives at that cost (a new FIFO lot)', async () => {
    const before = await item(sugar)   // 4 @ 300
    const noCost = await call('mgr2', 'POST', '/crosschecks/receiving', { supplierId: supA, photoUrl: PHOTO, lines: [{ inventoryItemId: sugar, quantityReceived: 4 }] })
    expect(noCost.json().error.code).toBe('UNIT_COST_REQUIRED')

    const res = await call('mgr2', 'POST', '/crosschecks/receiving', { supplierId: supA, photoUrl: PHOTO, lines: [{ inventoryItemId: sugar, quantityReceived: 4, unitCostCents: 500 }] })
    expect(res.statusCode).toBe(201)
    expect(res.json().poId).toBeNull()
    expect(before).toMatchObject({ currentStock: 4, unitCostCents: 300 })
    // Two lots: 4 @ 300 then 4 @ 500; the head (oldest) cost is 300.
    expect(await item(sugar)).toMatchObject({ currentStock: 8, unitCostCents: 300 })
    expect(await prisma.itemPriceHistory.count({ where: { inventoryItemId: sugar, source: 'dock_receive' } })).toBe(1)
  })

  it('refuses non-managers, other companies\' items, and a big delivery with no photo', async () => {
    const cook = await call('cook', 'POST', '/crosschecks/receiving', { supplierId: supA, photoUrl: PHOTO, lines: [{ inventoryItemId: sugar, quantityReceived: 1, unitCostCents: 100 }] })
    expect(cook.statusCode).toBe(403)

    const foreignItem = await call('mgr2', 'POST', '/crosschecks/receiving', { supplierId: supA, photoUrl: PHOTO, lines: [{ inventoryItemId: itemB, quantityReceived: 1, unitCostCents: 100 }] })
    expect(foreignItem.json().error.code).toBe('ITEM_NOT_IN_COMPANY')

    const foreignSupplier = await call('mgr2', 'POST', '/crosschecks/receiving', { supplierId: supB, photoUrl: PHOTO, lines: [{ inventoryItemId: sugar, quantityReceived: 1, unitCostCents: 100 }] })
    expect(foreignSupplier.statusCode).toBe(404)

    // Default threshold PKR 500 = 50,000 paisa.
    const noPhoto = await call('mgr2', 'POST', '/crosschecks/receiving', { supplierId: supA, lines: [{ inventoryItemId: sugar, quantityReceived: 100, unitCostCents: 1_000 }] })
    expect(noPhoto.json().error.code).toBe('PHOTO_REQUIRED')
    expect((await item(sugar)).currentStock).toBe(8)
  })

  it('lists receipts per company only', async () => {
    const b = await call('mgrB', 'POST', '/crosschecks/receiving', { supplierId: supB, photoUrl: PHOTO, lines: [{ inventoryItemId: itemB, quantityReceived: 2, unitCostCents: 50 }] })
    expect(b.statusCode).toBe(201)
    const listA = (await call('mgr2', 'GET', '/crosschecks/receiving')).json() as Array<{ supplierId: string }>
    const listB = (await call('mgrB', 'GET', '/crosschecks/receiving')).json() as Array<{ supplierId: string }>
    expect(listA.length).toBeGreaterThan(0)
    expect(listA.every((r) => r.supplierId === supA)).toBe(true)
    expect(listB.map((r) => r.supplierId)).toEqual([supB])
    const posB = (await call('mgrB', 'GET', '/crosschecks/receiving/open-pos')).json() as unknown[]
    expect(posB).toEqual([])
  })
  it('tags the outlet the goods arrived at — one of the company\'s (another\'s is 422); the cash-purchases system supplier is never a dock supplier', async () => {
    const locA = (await prisma.location.create({ data: { slug: 'rcv-loc-a', name: 'RCV outlet A', tenantId: tenantA } })).id
    const locB = (await prisma.location.create({ data: { slug: 'rcv-loc-b', name: 'RCV outlet B', tenantId: tenantB } })).id
    const foreign = await call('mgr2', 'POST', '/crosschecks/receiving', { supplierId: supA, locationId: locB, photoUrl: PHOTO, lines: [{ inventoryItemId: sugar, quantityReceived: 1, unitCostCents: 100 }] })
    expect(foreign.statusCode).toBe(422)
    expect(foreign.json().error.code).toBe('LOCATION_NOT_IN_COMPANY')
    const ok = await call('mgr2', 'POST', '/crosschecks/receiving', { supplierId: supA, locationId: locA, photoUrl: PHOTO, lines: [{ inventoryItemId: sugar, quantityReceived: 1, unitCostCents: 100 }] })
    expect(ok.statusCode, ok.body).toBe(201)
    expect(ok.json().locationId).toBe(locA)
    expect((await prisma.stockLot.findFirstOrThrow({ where: { receiptLineId: ok.json().lines[0].id } })).locationId).toBe(locA)

    const cash = await prisma.supplier.create({ data: { name: 'Cash purchases', tenantId: tenantA, systemKind: 'cash_purchases' } })
    const sups = (await call('mgr2', 'GET', '/crosschecks/receiving/suppliers')).json() as Array<{ id: string }>
    expect(sups.map((x) => x.id)).not.toContain(cash.id)
    const viaDock = await call('mgr2', 'POST', '/crosschecks/receiving', { supplierId: cash.id, photoUrl: PHOTO, lines: [{ inventoryItemId: sugar, quantityReceived: 1, unitCostCents: 100 }] })
    expect(viaDock.statusCode).toBe(404)
  })
})

describe('one separation-of-duties helper', () => {
  it('blocks the creator (and flags it) but never the CEO', async () => {
    await expect(assertNotSelfApproval({ actor: { id: users['mgr']!.id, role: 'owner' }, creatorId: users['mgr']!.id, action: 'approve', entity: 'Recipe', entityId: 'r-1' }))
      .rejects.toMatchObject({ code: 'SELF_APPROVAL_BLOCKED', statusCode: 403 })
    expect(await prisma.exceptionFlag.count({ where: { kind: 'self_approval', entityId: 'r-1' } })).toBe(1)
    await expect(assertNotSelfApproval({ actor: { id: users['ceo']!.id, role: 'admin' }, creatorId: users['ceo']!.id, action: 'approve', entity: 'Recipe', entityId: 'r-2' }))
      .resolves.toBeUndefined()
    await expect(assertNotSelfApproval({ actor: { id: users['mgr']!.id, role: 'owner' }, creatorId: null, action: 'approve', entity: 'Recipe', entityId: 'r-3' }))
      .resolves.toBeUndefined()
  })
})

describe('supplier balance: one figure, the ledger\'s', () => {
  it('posts the opening balance to AP once, as deltas, and the statement equals the ledger', async () => {
    const res = await call('ceo', 'POST', '/procurement/suppliers', { name: 'Dairy Co', openingBalanceCents: 70_000 })
    expect(res.statusCode).toBe(201)
    const dairy = res.json().id as string
    const ref = `supplier.opening:${dairy}:`
    expect(await ledgerAp(tenantA, ref)).toBe(70_000)

    // Replaying posts nothing.
    expect((await syncSupplierOpeningBalance(dairy)).postings).toEqual([])
    expect(await ledgerAp(tenantA, ref)).toBe(70_000)

    // Editing it posts the difference.
    expect((await call('ceo', 'PATCH', `/procurement/suppliers/${dairy}`, { openingBalanceCents: 50_000 })).statusCode).toBe(200)
    expect(await ledgerAp(tenantA, ref)).toBe(50_000)

    // A payment against the opening balance (unapplied) nets it off.
    const p = await createPayment({ supplierId: dairy, paymentDate: new Date().toISOString(), method: 'cash', amountCents: 20_000, createdBy: users['ceo']!.id })
    await postSupplierPayment(p.id)

    const st = (await call('ceo', 'GET', `/procurement/suppliers/${dairy}/statement`)).json() as { outstanding: number; ledgerOutstanding: number; openingUnpostedCents: number }
    expect(st.outstanding).toBe(30_000)
    expect(st.ledgerOutstanding).toBe(30_000)
    expect(st.openingUnpostedCents).toBe(0)
    const row = (await agingReport([tenantA])).bySupplier.find((s) => s.supplierId === dairy)!
    expect(row).toMatchObject({ openingCents: 50_000, creditsCents: 20_000, total: 30_000, openingUnpostedCents: 0 })

    // The company's aging total is its ledger AP.
    expect((await agingReport([tenantA])).total.total).toBe(await ledgerAp(tenantA))
  })

  it('moving the supplier to another company moves its opening balance', async () => {
    await mkUser('ceo2', 'admin', tenantA)
    await prisma.tenantMember.create({ data: { tenantId: tenantB, userId: users['ceo2']!.id } as never })
    const s = await prisma.supplier.create({ data: { name: 'Mover', tenantId: tenantA, openingBalanceCents: 9_000 } })
    await syncSupplierOpeningBalance(s.id)
    const ref = `supplier.opening:${s.id}:`
    expect(await ledgerAp(tenantA, ref)).toBe(9_000)

    const res = await app.inject({
      method: 'PATCH', url: `/procurement/suppliers/${s.id}`, payload: { tenantId: tenantB },
      headers: { authorization: `Bearer ${users['ceo2']!.token}`, 'x-servd-portfolio': '1' },
    })
    expect(res.statusCode).toBe(200)
    expect(await ledgerAp(tenantA, ref)).toBe(0)
    expect(await ledgerAp(tenantB, ref)).toBe(9_000)
    expect((await agingReport([tenantB])).total.total).toBe(await ledgerAp(tenantB))
  })
})
