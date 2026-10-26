// W4 — the hot-path cutover: completion is the full & final bill, and it is
// the ONLY place a sale is enqueued for the fiscal POS (spec D4, §6.3, §17.1).
//
//   - POST /pos/payments makes a bounded attempt to file (syncTimeoutMs): a
//     slow POS never holds the till — the payment is committed and the till
//     gets fiscal 'pending'; an answering POS gives the number + the
//     deprecated `srb` alias; a driver that throws never fails a payment.
//   - every completion door creates exactly ONE sale FiscalDocument: till,
//     comp, check-split (group bill), Keenu confirmation, expo hand-off,
//     rider drop-off, OTP verify, the status route — and a replay none.
//   - a pre-bill + payment + completion → exactly one sale document, the
//     pre-bill converted; a cancel → none, the pre-bill cancelled with the
//     manager who approved it.
//   - refunds after completion: a refund document per refund, inside the
//     refund's transaction (waiting for its sale); a refund in full adds no
//     second return when the refunds already cover the sale.
//   - a line voided (and refunded) on a paid order before completion gets
//     its return document at completion, behind the sale.
//   - §17.7: a company that does not report sales gets NO document; another
//     company's switch never affects it (two companies throughout).
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { AppError, errorResponse } from '../src/lib/errors.js'
import { posRoutes } from '../src/modules/pos/routes.js'
import { orderRoutes } from '../src/modules/orders/routes.js'
import { checkSplitRoutes } from '../src/modules/checkSplit/routes.js'
import { registerConnectorPlugins } from '../src/modules/connectors/index.js'
import { registerPreBillPlugins } from '../src/modules/prebills/index.js'
import { setFiscalKicker } from '../src/connectors/fiscal/outbox.js'
import { toSrbInvoiceFields } from '../src/connectors/fiscal/payload.js'
import type { FiscalPayload } from '../src/connectors/types.js'
import { testFiscalDriver } from '../src/connectors/drivers/test.js'
import { completeOrder, updateOrderStatus } from '../src/modules/orders/service.js'
import { voidOrderItem } from '../src/modules/pos/service.js'
import { applyKeenuCallback } from '../src/modules/paymentGateways/keenuSettle.js'
import { setManagerPin } from '../src/modules/auth/managerPin.js'
import {
  prisma, mkCompany, mkUser, caller, setConnector, resetConnectorCache, openDrawer, ringKheer,
  type Company, type Who,
} from './connectorsFixtures.js'

let app: FastifyInstance
let A: Company, B: Company
let cashierA: Who, mgrA: Who, cashierB: Who
let drawerA: string, drawerB: string, drawerMgrA: string
const kicked: string[] = []
const PIN = '593741'

async function build(): Promise<FastifyInstance> {
  const a = Fastify()
  a.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await a.register(posRoutes, { prefix: '/pos' })
  await a.register(orderRoutes, { prefix: '/orders' })
  await a.register(checkSplitRoutes, { prefix: '/check-split' })
  await registerConnectorPlugins(a)
  await registerPreBillPlugins(a)
  await a.ready()
  return a
}

const saleDocs = (orderId: string) => prisma.fiscalDocument.findMany({ where: { orderId, kind: 'sale' } })
/** Σ line taxable + tax, + service + tip = the document's total (each document adds up on its own). */
const consistent = (p: FiscalPayload) =>
  p.lines.reduce((s, l) => s + l.taxableCents + l.taxCents, 0) + p.totals.serviceChargeCents + p.totals.tipCents === p.totals.totalCents
const taxable = (p: FiscalPayload) => p.lines.reduce((s, l) => s + l.taxableCents, 0)
const allDocs = (orderId: string) => prisma.fiscalDocument.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } })

beforeAll(async () => {
  A = await mkCompany('ftill-a', { srbPosId: 7101 })
  B = await mkCompany('ftill-b', { srbPosId: 7102 })
  cashierA = await mkUser('ftill-cashier-a', 'cashier', A.tenantId)
  mgrA = await mkUser('ftill-mgr-a', 'foh_management', A.tenantId)
  cashierB = await mkUser('ftill-cashier-b', 'cashier', B.tenantId)
  await setManagerPin(mgrA.id, PIN)
  drawerA = await openDrawer(A, cashierA)
  drawerMgrA = await openDrawer(A, mgrA)
  drawerB = await openDrawer(B, cashierB)
  setFiscalKicker(async (id) => { kicked.push(id) })
  app = await build()
}, 60_000)

afterAll(async () => {
  setFiscalKicker(null)
  resetConnectorCache()
  await app?.close()
})

beforeEach(async () => {
  // Default: A is live on the test driver (answers at once); B reports sales but has no POS yet.
  await setConnector(A.tenantId, 'fiscal', { driver: 'test', enabled: true, settings: { test: { scenario: 'ok' }, syncTimeoutMs: 1000, syncAtTill: true, fiscalReportingRequired: true } })
  await setConnector(B.tenantId, 'fiscal', { driver: 'none', enabled: false, settings: { fiscalReportingRequired: true } })
})

const pay = (who: Who, shiftId: string, orderId: string, amountCents: number, extra: Record<string, unknown> = {}) =>
  caller(app)(who, 'POST', '/pos/payments', { orderId, shiftId, payments: [{ method: 'cash', amountCents, tenderedCents: amountCents, ...extra }] })

describe('the till pays, then files within its budget', () => {
  it('an answering POS: the payment returns the fiscal number and the deprecated srb alias', async () => {
    const o = await ringKheer(app, cashierA, A)
    const r = await pay(cashierA, drawerA, o.id, o.totalCents)
    expect(r.statusCode, r.body).toBe(201)
    const body = r.json()
    expect(body.orderCompleted).toBe(true)
    expect(body.fiscal).toMatchObject({ kind: 'sale', status: 'test', rawStatus: 'filed', authority: 'srb' })
    expect(body.fiscal.fiscalNumber).toMatch(/^TEST-SRB-/)
    // The alias is only for a FILED, non-test SRB number — a test number is never passed off as one.
    expect(body.srb).toBeNull()
    expect(await saleDocs(o.id)).toHaveLength(1)
  })

  it('a slow POS never holds the till: back within the budget, payment committed, fiscal pending', async () => {
    // Baseline: the same payment with a POS that answers at once.
    const base = await ringKheer(app, cashierA, A)
    const t0 = Date.now()
    expect((await pay(cashierA, drawerA, base.id, base.totalCents)).statusCode).toBe(201)
    const baseline = Date.now() - t0

    await setConnector(A.tenantId, 'fiscal', { settings: { test: { scenario: 'slow' }, syncTimeoutMs: 1000 } })
    const o = await ringKheer(app, cashierA, A)
    const t1 = Date.now()
    const r = await pay(cashierA, drawerA, o.id, o.totalCents)
    const took = Date.now() - t1
    expect(r.statusCode, r.body).toBe(201)
    expect(took).toBeLessThan(baseline + 1000 + 500)
    expect(r.json().fiscal).toMatchObject({ status: 'test', rawStatus: 'pending', fiscalNumber: null })
    expect(r.json().srb).toBeNull()
    expect(await prisma.payment.count({ where: { orderId: o.id, status: 'paid' } })).toBe(1)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('completed')
    const docs = await saleDocs(o.id)
    expect(docs).toHaveLength(1)
    expect(docs[0]!.lastErrorCode).toMatch(/^UNKNOWN/) // the worker looks it up before any resubmit
  })

  it('a driver that throws never fails the payment', async () => {
    const spy = vi.spyOn(testFiscalDriver, 'submitSale').mockRejectedValueOnce(new Error('driver exploded'))
    try {
      const o = await ringKheer(app, cashierA, A)
      const r = await pay(cashierA, drawerA, o.id, o.totalCents)
      expect(r.statusCode, r.body).toBe(201)
      expect(r.json().orderCompleted).toBe(true)
      expect(await prisma.payment.count({ where: { orderId: o.id, status: 'paid' } })).toBe(1)
      expect(await saleDocs(o.id)).toHaveLength(1)
    } finally {
      spy.mockRestore()
    }
  })

  it('an enqueue that fails inside the claim transaction never blocks the sale — it is flagged, never silent', async () => {
    // A real database error inside the claim's transaction (Postgres aborts
    // the transaction on it): only the savepoint rolls back.
    vi.doMock('../src/connectors/fiscal/outbox.js', async (orig) => ({
      ...(await orig<Record<string, unknown>>()),
      enqueueFiscalSaleTx: async (tx: { $executeRawUnsafe: (q: string) => Promise<unknown> }) => { await tx.$executeRawUnsafe('SELECT 1/0'); return null },
    }))
    try {
      const o = await ringKheer(app, cashierA, A)
      expect((await caller(app)(cashierA, 'POST', `/pos/orders/${o.id}/pre-bill`, {})).statusCode).toBe(201)
      const r = await pay(cashierA, drawerA, o.id, o.totalCents)
      expect(r.statusCode, r.body).toBe(201)
      expect(r.json()).toMatchObject({ orderCompleted: true, fiscal: null })
      expect(await allDocs(o.id)).toHaveLength(0)
      // The completion still ran (its claim committed, the pre-bill converted) …
      expect(await prisma.auditLog.count({ where: { entity: 'Order', entityId: o.id, action: 'order.complete' } })).toBe(1)
      expect((await prisma.preBill.findFirstOrThrow({ where: { orderId: o.id } })).status).toBe('converted')
      // … and the missing fiscal document is on the CEO's exceptions inbox.
      expect(await prisma.exceptionFlag.count({ where: { tenantId: A.tenantId, kind: 'fiscal_failed', entityType: 'Order', entityId: o.id } })).toBe(1)
    } finally {
      vi.doUnmock('../src/connectors/fiscal/outbox.js')
    }
  })

  it('a replayed payment (same key) returns the sale\'s fiscal view and files nothing new', async () => {
    const o = await ringKheer(app, cashierA, A)
    const body = { orderId: o.id, shiftId: drawerA, idempotencyKey: `replay-${o.id}`, payments: [{ method: 'cash', amountCents: o.totalCents }] }
    const first = await caller(app)(cashierA, 'POST', '/pos/payments', body)
    expect(first.statusCode, first.body).toBe(201)
    const again = await caller(app)(cashierA, 'POST', '/pos/payments', body)
    expect(again.statusCode, again.body).toBe(201)
    expect(again.json()).toMatchObject({ replayed: true, orderCompleted: true, fiscal: { documentId: first.json().fiscal.documentId } })
    expect(await prisma.payment.count({ where: { orderId: o.id, status: 'paid' } })).toBe(1)
    expect(await saleDocs(o.id)).toHaveLength(1)
  })
})

describe('every completion door files exactly ONE sale', () => {
  it('comp', async () => {
    const o = await ringKheer(app, mgrA, A, 1)
    const r = await caller(app)(mgrA, 'POST', `/pos/orders/${o.id}/comp`, { amountCents: o.totalCents, reason: 'regular guest', shiftId: drawerMgrA })
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json().orderCompleted).toBe(true)
    expect(r.json().fiscal).toMatchObject({ kind: 'sale' })
    expect(await saleDocs(o.id)).toHaveLength(1)
  })

  it('check-split: the last portion completes a group bill', async () => {
    const o = await prisma.order.create({
      data: {
        conceptId: A.conceptId, locationId: A.locationId, source: 'servd', fulfilmentType: 'dine_in', status: 'preparing',
        rawPayload: { channel: 'group_order' }, totalCents: 126_500, taxCents: 16_500, taxRatePct: 15,
        items: { create: [{ menuItemId: A.items.kheer, name: 'Kheer', quantity: 2, unitPriceCents: 55_000 }] },
      },
    })
    const split = await caller(app)(cashierA, 'POST', `/check-split/orders/${o.id}/split-evenly`, { ways: 2, method: 'cash' })
    expect(split.statusCode, split.body).toBe(200)
    const [p1, p2] = split.json() as Array<{ id: string; amountCents: number }>
    const s1 = await caller(app)(cashierA, 'POST', `/check-split/payments/${p1!.id}/settle`, { shiftId: drawerA, tenderedCents: p1!.amountCents })
    expect(s1.json()).toMatchObject({ orderCompleted: false, fiscal: null })
    expect(await saleDocs(o.id)).toHaveLength(0)
    const s2 = await caller(app)(cashierA, 'POST', `/check-split/payments/${p2!.id}/settle`, { shiftId: drawerA, tenderedCents: p2!.amountCents })
    expect(s2.statusCode, s2.body).toBe(200)
    expect(s2.json().orderCompleted).toBe(true)
    expect(s2.json().fiscal).toMatchObject({ kind: 'sale' })
    expect(await saleDocs(o.id)).toHaveLength(1)
  })

  it('a Keenu confirmation completes a till bill', async () => {
    const o = await prisma.order.create({
      data: {
        conceptId: A.conceptId, source: 'pos', fulfilmentType: 'takeout', status: 'received', totalCents: 59_400, taxCents: 4_400, taxRatePct: 8,
        items: { create: [{ menuItemId: A.items.kheer, name: 'Kheer', quantity: 1, unitPriceCents: 55_000 }] },
        payments: { create: [{ method: 'card', amountCents: 59_400, status: 'pending', gateway: 'keenu', gatewayRef: `KN-${Date.now()}` }] },
      },
      include: { payments: true },
    })
    const r = await applyKeenuCallback({ orderId: o.id, transactionId: o.payments[0]!.gatewayRef!, status: 'SUCCESS', amount: 59_400 })
    expect(r).toMatchObject({ result: 'settled', orderCompleted: true })
    expect(await saleDocs(o.id)).toHaveLength(1)
  })

  it.each([
    ['expo_handoff', 'takeout'],
    ['rider_delivered', 'delivery'],
    ['otp_verified', 'delivery'],
    ['status_update', 'takeout'],
  ] as const)('%s', async (via, fulfilmentType) => {
    const o = await prisma.order.create({
      data: {
        conceptId: A.conceptId, source: 'servd', fulfilmentType, status: 'ready', totalCents: 63_250, taxCents: 8_250, taxRatePct: 15,
        items: { create: [{ menuItemId: A.items.kheer, name: 'Kheer', quantity: 1, unitPriceCents: 55_000 }] },
        payments: { create: [{ method: 'card', amountCents: 63_250, status: 'paid', gateway: 'keenu', gatewayRef: `KN-${via}` }] },
      },
    })
    await updateOrderStatus(o.id, 'completed', { actor: { id: mgrA.id, tenantId: A.tenantId }, via })
    expect(await saleDocs(o.id)).toHaveLength(1)
    // A replay of the completion (another door, a retried request) files nothing.
    expect(await completeOrder(o.id, null, { via: 'status_update' })).toMatchObject({ ran: false })
    expect(await saleDocs(o.id)).toHaveLength(1)
    expect((await saleDocs(o.id))[0]).toMatchObject({ tenantId: A.tenantId, status: 'pending' })
  })
})

describe('pre-bills never file; the full & final bill files once', () => {
  it('pre-bill (twice) + payment + completion → exactly ONE sale document; the open pre-bill converted', async () => {
    const o = await ringKheer(app, cashierA, A)
    for (let i = 0; i < 2; i++) {
      const pb = await caller(app)(cashierA, 'POST', `/pos/orders/${o.id}/pre-bill`, { tender: 'cash' })
      expect(pb.statusCode, pb.body).toBe(201)
    }
    expect(await allDocs(o.id)).toHaveLength(0) // a pre-bill never touches the fiscal POS
    // The old "print bill" button on an open order is refused.
    expect((await caller(app)(cashierA, 'GET', `/pos/orders/${o.id}/receipt-data`)).json().error.code).toBe('PRE_BILL_REQUIRED')
    const r = await pay(cashierA, drawerA, o.id, o.totalCents)
    expect(r.statusCode, r.body).toBe(201)
    const docs = await allDocs(o.id)
    expect(docs).toHaveLength(1)
    expect(docs[0]).toMatchObject({ kind: 'sale', idempotencyKey: `sale:${o.id}`, amountCents: o.totalCents, tenantId: A.tenantId })
    const pbs = await prisma.preBill.findMany({ where: { orderId: o.id }, orderBy: { number: 'asc' } })
    expect(pbs.map((p) => p.status)).toEqual(['superseded', 'converted'])
    expect(pbs.every((p) => p.finalTotalCents === o.totalCents)).toBe(true)
    // The final bill now prints.
    const fnf = await caller(app)(cashierA, 'GET', `/pos/orders/${o.id}/receipt-data`)
    expect(fnf.statusCode).toBe(200)
    expect(fnf.json()).toMatchObject({ heading: 'FULL & FINAL BILL', fiscal: { kind: 'sale' } })
  })

  it('pre-bill then cancel (with a manager PIN) → no fiscal document; the pre-bill cancelled by that manager', async () => {
    const o = await ringKheer(app, cashierA, A)
    expect((await caller(app)(cashierA, 'POST', `/pos/orders/${o.id}/pre-bill`, {})).statusCode).toBe(201)
    const c = await caller(app)(cashierA, 'POST', `/orders/${o.id}/cancel`, { reason: 'guest walked out', managerOverridePin: PIN })
    expect(c.statusCode, c.body).toBe(200)
    expect(await allDocs(o.id)).toHaveLength(0)
    const pb = await prisma.preBill.findFirstOrThrow({ where: { orderId: o.id } })
    expect(pb).toMatchObject({ status: 'cancelled', cancelledById: mgrA.id, cancelReason: 'guest walked out' })
  })
})

describe('refunds after the full & final bill', () => {
  it('each refund gets its own return document in the refund\'s transaction; a refund in full adds no extra return', async () => {
    await setConnector(A.tenantId, 'fiscal', { settings: { test: { scenario: 'down' } } })
    const o = await ringKheer(app, cashierA, A)
    expect((await pay(cashierA, drawerA, o.id, o.totalCents)).statusCode).toBe(201)
    const sale = (await saleDocs(o.id))[0]!
    expect(sale.status).toBe('pending') // the POS is down; the outbox keeps it

    const r1 = await caller(app)(mgrA, 'POST', `/pos/orders/${o.id}/refund`, { amountCents: 50_000, reason: 'one was cold', method: 'cash', shiftId: drawerMgrA })
    expect(r1.statusCode, r1.body).toBe(200)
    expect(r1.json()).toMatchObject({ fiscalRefund: { kind: 'refund', rawStatus: 'waiting' }, srbReturnInvoiceNo: null })
    const r2 = await caller(app)(mgrA, 'POST', `/pos/orders/${o.id}/refund`, { amountCents: o.totalCents - 50_000, reason: 'the rest', method: 'cash', shiftId: drawerMgrA })
    expect(r2.statusCode, r2.body).toBe(200)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('refunded')

    const refunds = (await allDocs(o.id)).filter((d) => d.kind === 'refund')
    expect(refunds.map((d) => d.idempotencyKey).sort()).toEqual([`refund:${r1.json().id}`, `refund:${r2.json().id}`].sort())
    expect(refunds.every((d) => d.status === 'waiting' && d.saleDocumentId === sale.id)).toBe(true)
    expect(refunds.reduce((t, d) => t + d.amountCents, 0)).toBe(o.totalCents)
    // The refunds already return the whole sale: no 'void:' remainder.
    expect(await prisma.fiscalDocument.count({ where: { idempotencyKey: `void:${o.id}` } })).toBe(0)
  })

  it('a line voided on a paid order before completion gets its return at completion, behind the sale', async () => {
    const o = await prisma.order.create({
      data: {
        conceptId: A.conceptId, source: 'servd', fulfilmentType: 'takeout', status: 'preparing', totalCents: 126_500, taxCents: 16_500, taxRatePct: 15,
        items: { create: [
          { menuItemId: A.items.kheer, name: 'Kheer', quantity: 1, unitPriceCents: 55_000, status: 'preparing' },
          { menuItemId: A.items.kheer, name: 'Kheer', quantity: 1, unitPriceCents: 55_000, status: 'preparing' },
        ] },
        payments: { create: [{ method: 'card', amountCents: 126_500, status: 'paid', gateway: 'keenu', gatewayRef: `KN-void-${Date.now()}` }] },
      },
      include: { items: true },
    })
    const v = await voidOrderItem({ orderId: o.id, orderItemId: o.items[0]!.id, reason: 'out of kheer', actorId: mgrA.id, actorRole: 'foh_management' })
    expect(v.refund).not.toBeNull()
    expect(await allDocs(o.id)).toHaveLength(0) // no sale yet → nothing filed
    await updateOrderStatus(o.id, 'ready')
    await updateOrderStatus(o.id, 'completed', { via: 'expo_handoff' })
    const docs = await allDocs(o.id)
    expect(docs.map((d) => d.kind).sort()).toEqual(['refund', 'sale'])
    const ret = docs.find((d) => d.kind === 'refund')!
    expect(ret).toMatchObject({ refundPaymentId: v.refund!.id, amountCents: v.refund!.amountCents, saleDocumentId: docs.find((d) => d.kind === 'sale')!.id })

    // W4-FISCAL-1 / RG-1: the sale lists what was CHARGED (the voided line
    // included — the bill was not lowered), each document adds up to its own
    // total, and the return takes the line off ONCE: net filed = the Kheer
    // the customer kept.
    const sp = docs.find((d) => d.kind === 'sale')!.payload as unknown as FiscalPayload
    const rp = ret.payload as unknown as FiscalPayload
    expect(sp.lines).toHaveLength(2)
    expect(consistent(sp)).toBe(true)
    expect(consistent(rp)).toBe(true)
    expect(sp.totals.totalCents).toBe(126_500)
    expect(rp.totals.totalCents).toBe(63_250)
    expect(taxable(sp) - taxable(rp)).toBe(55_000)
    expect(sp.totals.taxCents - rp.totals.taxCents).toBe(8_250)
    expect(toSrbInvoiceFields(sp).saleValue - toSrbInvoiceFields(rp).saleValue).toBe(550)
  })

  it('a voided line\'s return carries no tip share: a tipped order still nets the kept line exactly', async () => {
    const o = await prisma.order.create({
      data: {
        conceptId: A.conceptId, source: 'servd', fulfilmentType: 'takeout', status: 'preparing', totalCents: 136_500, taxCents: 16_500, tipCents: 10_000, taxRatePct: 15,
        items: { create: [
          { menuItemId: A.items.kheer, name: 'Kheer', quantity: 1, unitPriceCents: 55_000, status: 'preparing' },
          { menuItemId: A.items.kheer, name: 'Kheer', quantity: 1, unitPriceCents: 55_000, status: 'preparing' },
        ] },
        payments: { create: [{ method: 'card', amountCents: 136_500, status: 'paid', gateway: 'keenu', gatewayRef: `KN-tip-${Date.now()}` }] },
      },
      include: { items: true },
    })
    const v = await voidOrderItem({ orderId: o.id, orderItemId: o.items[1]!.id, reason: 'out of kheer', actorId: mgrA.id, actorRole: 'foh_management' })
    expect(v.refund!.amountCents).toBe(63_250)
    await updateOrderStatus(o.id, 'ready')
    await updateOrderStatus(o.id, 'completed', { via: 'expo_handoff' })
    const docs = await allDocs(o.id)
    const sp = docs.find((d) => d.kind === 'sale')!.payload as unknown as FiscalPayload
    const rp = docs.find((d) => d.kind === 'refund')!.payload as unknown as FiscalPayload
    expect(consistent(sp)).toBe(true)
    expect(consistent(rp)).toBe(true)
    expect(sp.totals.tipCents).toBe(10_000)
    expect(rp.totals.tipCents).toBe(0)
    expect(taxable(sp) - taxable(rp)).toBe(55_000)
    // Promoted once the sale files: rebuilt from the filed sale, still no tip share.
    const { promoteWaitingRefunds } = await import('../src/connectors/fiscal/outbox.js')
    const sale = docs.find((d) => d.kind === 'sale')!
    if (sale.status !== 'filed') {
      await prisma.fiscalDocument.update({ where: { id: sale.id }, data: { status: 'filed', fiscalNumber: 'TEST-SRB-TIP', authority: 'srb', fiscalAt: new Date() } })
    }
    await promoteWaitingRefunds(sale.id, A.tenantId)
    const after = (await prisma.fiscalDocument.findFirstOrThrow({ where: { orderId: o.id, kind: 'refund' } })).payload as unknown as FiscalPayload
    expect(after.totals.tipCents).toBe(0)
    expect(taxable(after)).toBe(55_000)
    expect(consistent(after)).toBe(true)
  })
})

describe('§17.7 — fiscal reporting per company, two companies', () => {
  it('B not required: B\'s sale creates NO document (A still files); A not required never touches B', async () => {
    await setConnector(B.tenantId, 'fiscal', { settings: { fiscalReportingRequired: false } })
    const ob = await ringKheer(app, cashierB, B)
    const rb = await pay(cashierB, drawerB, ob.id, ob.totalCents)
    expect(rb.statusCode, rb.body).toBe(201)
    expect(rb.json()).toMatchObject({ orderCompleted: true, fiscal: null, srb: null })
    expect(await allDocs(ob.id)).toHaveLength(0)
    expect((await caller(app)(cashierB, 'GET', `/pos/orders/${ob.id}/receipt-data`)).json()).toMatchObject({ notTaxInvoice: true, fiscal: null })
    // A refund of B's sale files nothing either.
    const mgrB = await mkUser('ftill-mgr-b', 'foh_management', B.tenantId)
    const dB = await openDrawer(B, mgrB)
    expect((await caller(app)(mgrB, 'POST', `/pos/orders/${ob.id}/refund`, { amountCents: 10_000, reason: 'cold', method: 'cash', shiftId: dB })).statusCode).toBe(200)
    expect(await allDocs(ob.id)).toHaveLength(0)

    const oa = await ringKheer(app, cashierA, A)
    expect((await pay(cashierA, drawerA, oa.id, oa.totalCents)).statusCode).toBe(201)
    const docs = await allDocs(oa.id)
    expect(docs).toHaveLength(1)
    expect(docs[0]!.tenantId).toBe(A.tenantId)
  })

  it('B required with no POS yet: its sale is HELD (visible, never sent) in B\'s own company', async () => {
    const ob = await ringKheer(app, cashierB, B)
    expect((await pay(cashierB, drawerB, ob.id, ob.totalCents)).statusCode).toBe(201)
    const docs = await saleDocs(ob.id)
    expect(docs).toHaveLength(1)
    expect(docs[0]).toMatchObject({ tenantId: B.tenantId, status: 'held', statusReason: 'no_connector' })
  })

  it('company B cannot pay, print or pre-bill company A\'s order (404)', async () => {
    const o = await ringKheer(app, cashierA, A)
    const call = caller(app)
    expect((await call(cashierB, 'POST', '/pos/payments', { orderId: o.id, shiftId: drawerB, payments: [{ method: 'cash', amountCents: o.totalCents }] })).statusCode).toBe(404)
    expect((await call(cashierB, 'POST', `/pos/orders/${o.id}/pre-bill`, {})).statusCode).toBe(404)
    expect((await call(cashierB, 'GET', `/pos/receipt/${o.id}`)).statusCode).toBe(404)
    expect(await allDocs(o.id)).toHaveLength(0)
  })
})

// W4-FISCAL-2 / RG-2: a completed order never stays without its completion
// or its sale document. The claim transaction failing (pool exhaustion, a
// lock timeout, a dropped connection) is injected with a trigger on the
// claim row; the enqueue failing inside the claim with a mocked outbox.
describe('completion recovery — never silent, exactly one sale', () => {
  const failClaim = async () => {
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION ftill_fail_claim() RETURNS trigger AS $$ BEGIN IF NEW.action = 'order.complete' THEN RAISE EXCEPTION 'injected claim failure'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`)
    await prisma.$executeRawUnsafe(`CREATE TRIGGER ftill_fail_claim BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION ftill_fail_claim()`)
  }
  const healClaim = () => prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS ftill_fail_claim ON audit_logs')
  const claims = (orderId: string) => prisma.auditLog.count({ where: { entity: 'Order', entityId: orderId, action: 'order.complete' } })

  beforeAll(async () => {
    // Count every order this file completed (the marker is written at boot in production).
    await prisma.setting.upsert({
      where: { key: 'orders.completionRecoverySince' },
      create: { key: 'orders.completionRecoverySince', value: new Date(Date.now() - 3_600_000).toISOString() },
      update: { value: new Date(Date.now() - 3_600_000).toISOString() },
    })
  })
  afterAll(healClaim)

  it('the claim transaction failed: the sweep runs the completion once; a return taken in the gap is adopted, not skipped', async () => {
    await failClaim()
    let o: { id: string; totalCents: number }
    try {
      o = await ringKheer(app, cashierA, A)
      const r = await pay(cashierA, drawerA, o.id, o.totalCents)
      expect(r.statusCode, r.body).toBe(201)
    } finally {
      await healClaim()
    }
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('completed')
    expect(await claims(o.id)).toBe(0)
    expect(await allDocs(o.id)).toHaveLength(0)

    // A refund before the sweep: no sale document yet → auto-skipped for now.
    const rf = await caller(app)(mgrA, 'POST', `/pos/orders/${o.id}/refund`, { amountCents: 10_000, reason: 'cold', method: 'cash', shiftId: drawerMgrA })
    expect(rf.statusCode, rf.body).toBe(200)
    expect((await allDocs(o.id)).map((d) => `${d.kind}:${d.status}:${d.statusReason}`)).toEqual(['refund:skipped:no_sale_document'])

    const { recoverIncompleteCompletions } = await import('../src/modules/orders/service.js')
    const s1 = await recoverIncompleteCompletions({ tenantIds: [A.tenantId], graceMs: 0 })
    expect(s1.completed).toBeGreaterThanOrEqual(1)
    expect(await claims(o.id)).toBe(1)
    const docs = await allDocs(o.id)
    const sale = docs.filter((d) => d.kind === 'sale')
    expect(sale).toHaveLength(1)
    const ret = docs.find((d) => d.kind === 'refund')!
    expect(ret).toMatchObject({ refundPaymentId: rf.json().id, saleDocumentId: sale[0]!.id, status: 'waiting', statusReason: null })

    // Idempotent: a second sweep adds nothing.
    await recoverIncompleteCompletions({ tenantIds: [A.tenantId], graceMs: 0 })
    expect(await claims(o.id)).toBe(1)
    expect(await saleDocs(o.id)).toHaveLength(1)
    expect(await allDocs(o.id)).toHaveLength(2)
  })

  it('the sale enqueue failed inside the claim: the sweep queues it (exactly one) and resolves the flag', async () => {
    vi.doMock('../src/connectors/fiscal/outbox.js', async (orig) => ({
      ...(await orig<Record<string, unknown>>()),
      enqueueFiscalSaleTx: async (tx: { $executeRawUnsafe: (q: string) => Promise<unknown> }) => { await tx.$executeRawUnsafe('SELECT 1/0'); return null },
    }))
    let o: { id: string; totalCents: number }
    try {
      o = await ringKheer(app, cashierA, A)
      expect((await pay(cashierA, drawerA, o.id, o.totalCents)).statusCode).toBe(201)
    } finally {
      vi.doUnmock('../src/connectors/fiscal/outbox.js')
    }
    expect(await claims(o.id)).toBe(1)
    expect(await allDocs(o.id)).toHaveLength(0)
    expect(await prisma.exceptionFlag.count({ where: { kind: 'fiscal_failed', entityId: o.id, status: 'open' } })).toBe(1)

    // The receipt meanwhile: pending, never our invoice number passed off as a fiscal one.
    const rd = await caller(app)(cashierA, 'GET', `/pos/orders/${o.id}/receipt-data`)
    expect(rd.statusCode, rd.body).toBe(200)
    expect(rd.json()).toMatchObject({ heading: 'FULL & FINAL BILL', notTaxInvoice: false, fiscal: { status: 'pending', statusReason: 'not_queued', fiscalNumber: null } })

    const { recoverIncompleteCompletions } = await import('../src/modules/orders/service.js')
    const s = await recoverIncompleteCompletions({ tenantIds: [A.tenantId], graceMs: 0 })
    expect(s.saleEnqueued).toBeGreaterThanOrEqual(1)
    expect(await saleDocs(o.id)).toHaveLength(1)
    expect(await prisma.exceptionFlag.count({ where: { kind: 'fiscal_failed', entityId: o.id, status: 'open' } })).toBe(0)
    expect(await prisma.exceptionFlag.count({ where: { kind: 'fiscal_failed', entityId: o.id, status: 'resolved' } })).toBe(1)
    await recoverIncompleteCompletions({ tenantIds: [A.tenantId], graceMs: 0 })
    expect(await saleDocs(o.id)).toHaveLength(1)
  })

  it('a refunded order whose completion never ran is flagged once — never completed over its refunds', async () => {
    await failClaim()
    let o: { id: string; totalCents: number }
    try {
      o = await ringKheer(app, cashierA, A)
      expect((await pay(cashierA, drawerA, o.id, o.totalCents)).statusCode).toBe(201)
      const rf = await caller(app)(mgrA, 'POST', `/pos/orders/${o.id}/refund`, { amountCents: o.totalCents, reason: 'wrong order', method: 'cash', shiftId: drawerMgrA })
      expect(rf.statusCode, rf.body).toBe(200)
    } finally {
      await healClaim()
    }
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('refunded')
    const { recoverIncompleteCompletions } = await import('../src/modules/orders/service.js')
    const s = await recoverIncompleteCompletions({ tenantIds: [A.tenantId], graceMs: 0 })
    expect(s.flagged).toBeGreaterThanOrEqual(1)
    expect(await claims(o.id)).toBe(0)
    expect(await saleDocs(o.id)).toHaveLength(0)
    await recoverIncompleteCompletions({ tenantIds: [A.tenantId], graceMs: 0 })
    expect(await prisma.exceptionFlag.count({ where: { kind: 'fiscal_failed', entityId: o.id } })).toBe(1)
  })

  it('company B\'s sweep never touches company A\'s unrecovered order', async () => {
    await failClaim()
    let o: { id: string; totalCents: number }
    try {
      o = await ringKheer(app, cashierA, A)
      expect((await pay(cashierA, drawerA, o.id, o.totalCents)).statusCode).toBe(201)
    } finally {
      await healClaim()
    }
    const { recoverIncompleteCompletions } = await import('../src/modules/orders/service.js')
    await recoverIncompleteCompletions({ tenantIds: [B.tenantId], graceMs: 0 })
    expect(await claims(o.id)).toBe(0)
    await recoverIncompleteCompletions({ tenantIds: [A.tenantId], graceMs: 0 })
    expect(await claims(o.id)).toBe(1)
    expect(await saleDocs(o.id)).toHaveLength(1)
  })
})
