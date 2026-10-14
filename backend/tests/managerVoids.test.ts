// W4 — §17.4 manager-only voids. "This void is not a void that cashier or
// server can do. It must be manager that voids." (owner, 2026-10-10)
//
//   - EVERY line void needs a manager: the signed-in user is an override
//     approver, or a valid manager PIN of the ORDER's company is sent. The
//     cashier void cap is treated as 0 — even a free line or a generous
//     cashier cap; the manager cap still applies.
//   - Cancelling / voiding a whole rung-up order (POST /orders/:id/cancel,
//     and refused-at-door of a till order) likewise.
//   - 403 MANAGER_OVERRIDE_REQUIRED without a PIN; 403 INVALID_MANAGER_PIN
//     for a wrong PIN or another company's manager's PIN.
//   - approverId is ALWAYS recorded (the manager's own id when they act).
//   - A fired line's void is food cost: a refused void wastes nothing; the
//     manager's void books it as waste (void_after_fire, FIFO value) with the
//     approver, in the order's company.
// Two companies: B's manager PIN never unlocks A's till; B gets 404 on A.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { AppError, errorResponse } from '../src/lib/errors.js'
import { posRoutes } from '../src/modules/pos/routes.js'
import { orderRoutes } from '../src/modules/orders/routes.js'
import { registerPreBillPlugins } from '../src/modules/prebills/index.js'
import { setManagerPin } from '../src/modules/auth/managerPin.js'
import { invalidateSetupCache } from '../src/lib/setup-config.js'
import { setFiscalKicker } from '../src/connectors/fiscal/outbox.js'
import { prisma, mkCompany, mkUser, caller, resetConnectorCache, type Company, type Who } from './connectorsFixtures.js'
import { addLotTx, fifoCutoverKey } from '../src/lib/stockLedger.js'
import { deductInventoryForOrder } from '../src/modules/orders/service.js'

let app: FastifyInstance
let A: Company, B: Company
let cashierA: Who, waiterA: Who, mgrA: Who, cashierB: Who, mgrB: Who
const PIN_A = '5821'
const PIN_B = '7394'
let beefA: string

async function build(): Promise<FastifyInstance> {
  const a = Fastify()
  a.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await a.register(posRoutes, { prefix: '/pos' })
  await a.register(orderRoutes, { prefix: '/orders' })
  await registerPreBillPlugins(a)
  await a.ready()
  return a
}

const call = (...args: Parameters<ReturnType<typeof caller>>) => caller(app)(...args)

/** A two-line ticket rung by `who` at company `co` (Kheer + Nihari). */
async function ticket(who: Who, co: Company) {
  const r = await call(who, 'POST', '/pos/orders', {
    conceptId: co.conceptId,
    items: [
      { menuItemId: co.items.kheer, name: 'Kheer', quantity: 1, unitPriceCents: 55_000, modifiers: [] },
      { menuItemId: co.items.nihari, name: 'Beef Nihari', quantity: 1, unitPriceCents: 145_000, modifiers: [] },
    ],
  })
  if (r.statusCode !== 201) throw new Error(`ring failed ${r.statusCode} ${r.body}`)
  return r.json() as { id: string; items: Array<{ id: string; name: string }> }
}

const voidAudit = (orderItemId: string) => prisma.auditLog.findFirst({ where: { action: 'order_item_void', entityId: orderItemId } })

beforeAll(async () => {
  A = await mkCompany('mvoid-a')
  B = await mkCompany('mvoid-b')
  cashierA = await mkUser('mvoid-cashier-a', 'cashier', A.tenantId)
  waiterA = await mkUser('mvoid-waiter-a', 'foh', A.tenantId)
  mgrA = await mkUser('mvoid-mgr-a', 'foh_management', A.tenantId)
  cashierB = await mkUser('mvoid-cashier-b', 'cashier', B.tenantId)
  mgrB = await mkUser('mvoid-mgr-b', 'foh_management', B.tenantId)
  await setManagerPin(mgrA.id, PIN_A)
  await setManagerPin(mgrB.id, PIN_B)
  // A's nihari takes 150 g of beef from its FIFO lot (finance wave B), so a fired void has food cost to waste.
  await prisma.setting.create({ data: { key: fifoCutoverKey(A.tenantId), value: new Date(Date.now() - 30 * 86_400_000).toISOString() } })
  beefA = (await prisma.inventoryItem.create({ data: { tenantId: A.tenantId, name: 'Beef', unit: 'kg' } })).id
  await prisma.$transaction((tx) => addLotTx(tx, {
    tenantId: A.tenantId, inventoryItemId: beefA, qty: 20, unitCostCents: 200_000, kind: 'count_gain', lotSourceType: 'count_gain',
    lotSourceId: 'mvoid-beef', movementSourceType: 'test', movementSourceId: 'mvoid-beef', receivedAt: new Date(Date.now() - 86_400_000),
  }))
  await prisma.recipe.create({
    data: { kind: 'plate', menuItemId: A.items.nihari, servings: 1, qFactorPct: 0, ingredients: { create: [{ inventoryItemId: beefA, quantity: 150, unit: 'kg' }] } },
  })
  // A generous cashier void cap: §17.4 says it no longer lets a cashier void alone.
  await prisma.refundPolicy.create({ data: { scope: 'global', scopeId: null, tenantId: A.tenantId, cashierVoidLimitCents: 1_000_000, managerVoidLimitCents: 1_000_000 } })
  invalidateSetupCache()
  setFiscalKicker(async () => {})
  app = await build()
}, 60_000)

afterAll(async () => {
  setFiscalKicker(null)
  resetConnectorCache()
  await app?.close()
})

describe('line voids are manager-only', () => {
  it.each([['cashier', () => cashierA], ['waiter (foh)', () => waiterA]] as const)('a %s without a PIN → 403 MANAGER_OVERRIDE_REQUIRED, nothing voided', async (_label, who) => {
    const o = await ticket(who(), A)
    const r = await call(who(), 'POST', `/pos/orders/${o.id}/void`, { orderItemId: o.items[0]!.id, reason: 'wrong item' })
    expect(r.statusCode).toBe(403)
    expect(r.json().error.code).toBe('MANAGER_OVERRIDE_REQUIRED')
    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: o.items[0]!.id } })).voidedAt).toBeNull()
    expect(await voidAudit(o.items[0]!.id)).toBeNull()
  })

  it('with company B\'s manager PIN → 403 INVALID_MANAGER_PIN; a wrong PIN likewise', async () => {
    const o = await ticket(cashierA, A)
    for (const pin of [PIN_B, '1357']) {
      const r = await call(cashierA, 'POST', `/pos/orders/${o.id}/void`, { orderItemId: o.items[0]!.id, reason: 'wrong item', managerOverridePin: pin })
      expect(r.statusCode).toBe(403)
      expect(r.json().error.code).toBe('INVALID_MANAGER_PIN')
    }
    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: o.items[0]!.id } })).voidedAt).toBeNull()
  })

  it('with its own company\'s manager PIN → 200, the PIN\'s manager recorded as approver', async () => {
    const o = await ticket(waiterA, A)
    const r = await call(waiterA, 'POST', `/pos/orders/${o.id}/void`, { orderItemId: o.items[0]!.id, reason: 'wrong item', managerOverridePin: PIN_A })
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json().status).toBe('voided')
    const log = await voidAudit(o.items[0]!.id)
    expect(log).toMatchObject({ userId: waiterA.id, tenantId: A.tenantId })
    expect((log!.metadata as { approverId?: string }).approverId).toBe(mgrA.id)
  })

  it('a manager signed in → 200, their own id recorded as approver (no PIN needed)', async () => {
    const o = await ticket(cashierA, A)
    const r = await call(mgrA, 'POST', `/pos/orders/${o.id}/void`, { orderItemId: o.items[1]!.id, reason: 'dropped' })
    expect(r.statusCode, r.body).toBe(200)
    expect((((await voidAudit(o.items[1]!.id))!.metadata) as { approverId?: string }).approverId).toBe(mgrA.id)
  })

  it('the manager cap still applies', async () => {
    await prisma.refundPolicy.updateMany({ where: { tenantId: A.tenantId }, data: { managerVoidLimitCents: 10_000 } })
    invalidateSetupCache()
    try {
      const o = await ticket(cashierA, A)
      const own = await call(mgrA, 'POST', `/pos/orders/${o.id}/void`, { orderItemId: o.items[0]!.id, reason: 'x' })
      expect(own.statusCode).toBe(403)
      expect(own.json().error.code).toBe('OVER_CAP')
      const pin = await call(cashierA, 'POST', `/pos/orders/${o.id}/void`, { orderItemId: o.items[0]!.id, reason: 'x', managerOverridePin: PIN_A })
      expect(pin.statusCode).toBe(403)
      expect(pin.json().error.code).toBe('OVER_MANAGER_CAP')
    } finally {
      await prisma.refundPolicy.updateMany({ where: { tenantId: A.tenantId }, data: { managerVoidLimitCents: 1_000_000 } })
      invalidateSetupCache()
    }
  })

  it('a fired line: a refused void wastes nothing; the manager\'s void books it as waste (void_after_fire) with the approver, in A', async () => {
    const o = await ticket(cashierA, A)
    await deductInventoryForOrder(o.id)
    const nihari = o.items.find((i) => i.name === 'Beef Nihari')!
    await prisma.orderItem.update({ where: { id: nihari.id }, data: { status: 'preparing' } })
    const refused = await call(cashierA, 'POST', `/pos/orders/${o.id}/void`, { orderItemId: nihari.id, reason: 'burnt' })
    expect(refused.statusCode).toBe(403)
    expect(await prisma.wasteLog.count({ where: { orderItemId: nihari.id } })).toBe(0)
    expect(await prisma.stockMovement.count({ where: { orderItemId: nihari.id, kind: { in: ['sale_void', 'waste'] } } })).toBe(0)

    const ok = await call(cashierA, 'POST', `/pos/orders/${o.id}/void`, { orderItemId: nihari.id, reason: 'burnt', managerOverridePin: PIN_A })
    expect(ok.statusCode, ok.body).toBe(200)
    const logs = await prisma.wasteLog.findMany({ where: { orderItemId: nihari.id } })
    expect(logs.map((l) => [l.reason, l.tenantId, l.approvedById, l.estimatedCostCents])).toEqual([['void_after_fire', A.tenantId, mgrA.id, 30_000]])
    expect((await prisma.journalEntry.findFirst({ where: { reference: `pos.void_waste:${nihari.id}` } }))?.tenantId).toBe(A.tenantId)
  })

  it('company B gets 404 on A\'s ticket, even with A\'s PIN', async () => {
    const o = await ticket(cashierA, A)
    const r = await call(cashierB, 'POST', `/pos/orders/${o.id}/void`, { orderItemId: o.items[0]!.id, reason: 'x', managerOverridePin: PIN_A })
    expect(r.statusCode).toBe(404)
  })
})

describe('cancelling a whole rung-up order is manager-only', () => {
  it.each([['cashier', () => cashierA], ['waiter (foh)', () => waiterA]] as const)('a %s without a PIN → 403 MANAGER_OVERRIDE_REQUIRED; the order stays open', async (_label, who) => {
    const o = await ticket(who(), A)
    const r = await call(who(), 'POST', `/orders/${o.id}/cancel`, { reason: 'guest walked out' })
    expect(r.statusCode).toBe(403)
    expect(r.json().error.code).toBe('MANAGER_OVERRIDE_REQUIRED')
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('received')
  })

  it('with B\'s manager PIN → 403 INVALID_MANAGER_PIN', async () => {
    const o = await ticket(cashierA, A)
    const r = await call(cashierA, 'POST', `/orders/${o.id}/cancel`, { reason: 'guest walked out', managerOverridePin: PIN_B })
    expect(r.statusCode).toBe(403)
    expect(r.json().error.code).toBe('INVALID_MANAGER_PIN')
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('received')
  })

  it('with its own manager\'s PIN → 200; approver recorded on the audit and on the cancelled pre-bill; nothing to the fiscal POS', async () => {
    const o = await ticket(cashierA, A)
    expect((await call(cashierA, 'POST', `/pos/orders/${o.id}/pre-bill`, {})).statusCode).toBe(201)
    const r = await call(cashierA, 'POST', `/orders/${o.id}/cancel`, { reason: 'guest walked out', managerOverridePin: PIN_A })
    expect(r.statusCode, r.body).toBe(200)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('cancelled')
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'order.cancel', entityId: o.id } })
    expect(log.userId).toBe(cashierA.id)
    expect((log.metadata as { approverId?: string }).approverId).toBe(mgrA.id)
    expect(await prisma.preBill.findFirstOrThrow({ where: { orderId: o.id } })).toMatchObject({ status: 'cancelled', cancelledById: mgrA.id })
    expect(await prisma.fiscalDocument.count({ where: { orderId: o.id } })).toBe(0)
  })

  it('a manager signed in → 200 with their own id as approver', async () => {
    const o = await ticket(cashierA, A)
    const r = await call(mgrA, 'POST', `/orders/${o.id}/cancel`, { reason: 'kitchen closed' })
    expect(r.statusCode, r.body).toBe(200)
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'order.cancel', entityId: o.id } })
    expect((log.metadata as { approverId?: string }).approverId).toBe(mgrA.id)
  })

  it('refused at the door: a rung-up order needs a manager; with the PIN it cancels', async () => {
    const o = await ticket(cashierA, A)
    const customer = await prisma.customer.create({ data: { name: 'Door Guest' } })
    await prisma.order.update({ where: { id: o.id }, data: { customerId: customer.id, fulfilmentType: 'delivery' } })
    const no = await call(cashierA, 'POST', `/orders/${o.id}/refused-at-door`, { reason: 'not home' })
    expect(no.statusCode).toBe(403)
    expect(no.json().error.code).toBe('MANAGER_OVERRIDE_REQUIRED')
    const yes = await call(cashierA, 'POST', `/orders/${o.id}/refused-at-door`, { reason: 'not home', managerOverridePin: PIN_A })
    expect(yes.statusCode, yes.body).toBe(200)
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'order.refused_at_door', entityId: o.id } })
    expect((log.metadata as { approverId?: string }).approverId).toBe(mgrA.id)
  })

  it('company B gets 404 on A\'s order — before any PIN is tried', async () => {
    const o = await ticket(cashierA, A)
    expect((await call(mgrB, 'POST', `/orders/${o.id}/cancel`, { reason: 'not mine' })).statusCode).toBe(404)
    expect((await call(cashierB, 'POST', `/orders/${o.id}/cancel`, { reason: 'not mine', managerOverridePin: PIN_A })).statusCode).toBe(404)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('received')
  })
})
