// Food came back — a delivery the rider brought back (orders/returnedFood.ts
// returnUndeliveredOrder; cancelOrder's `returned` hook; restoreInventoryForOrder
// wasteAll). Two companies A and B.
//
// What this guards:
//   - the order is 'cancelled' with returnedAt + returnCause, audited
//     'order.returned_by_rider' in the ORDER's company (the actor works in B);
//   - EVERY live line is wasted 'returned_food' — fired and unfired — one
//     WasteLog per item, Dr 1290 / Cr 1210 (+ 1220 drink, + 1230 packaging) in
//     A under 'pos.void_waste:<lineId>'; nothing goes back to the lots;
//   - the pending COD row becomes 'failed' with gatewayMeta.voided (no
//     posting); no FiscalDocument; the pre-bills are cancelled;
//   - the rider's 'returned' job event names the manager; a 'food_returned'
//     exception in A carries the waste cost;
//   - a paid card ticket is accepted and returns refundDueCents;
//   - one strike (tenantId A) only for 'refused'; none for 'unreachable';
//   - a replay is 409 ALREADY_RETURNED with no second waste, event, flag or strike;
//   - refusals: not a delivery, delivered, completed, not ready, no rider,
//     an app job not picked up;
//   - a closed period: the cancel stands and posting_failed is flagged;
//   - code-only delivery OFF: the generic cancel of a picked-up delivery works
//     as today; ON: 409 USE_EMERGENCY_OVERRIDE (the system auto-cancel is
//     exempt; an app job not yet picked up still cancels);
//   - POST /orders/:id/cod-unpaid and /refused-at-door are gone (404).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { randomUUID } from 'node:crypto'
import { AppError, errorResponse } from '../src/lib/errors.js'
import { prisma, mkCompany, mkUser, caller, openDrawer, type Company, type Who } from './connectorsFixtures.js'
import { addLotTx, fifoCutoverKey } from '../src/lib/stockLedger.js'
import { ingestOrder, deductInventoryForOrder, cancelOrder } from '../src/modules/orders/service.js'
import { returnUndeliveredOrder } from '../src/modules/orders/returnedFood.js'
import { orderRoutes } from '../src/modules/orders/routes.js'
import { setCodeOnlyDelivery } from '../src/lib/deliveryRules.js'
import { setFiscalKicker } from '../src/connectors/fiscal/outbox.js'

let app: FastifyInstance
let A: Company
let B: Company
let mgrA: Who
let mgrB: Who
let cashA: Who
let beefA: string
let boxA: string
let colaA: string
let riderA: string
let seq = 0
const DAY = 86_400_000

const call = (...args: Parameters<ReturnType<typeof caller>>) => caller(app)(...args)

async function lot(tenantId: string, itemId: string, qty: number, unitCostCents: number) {
  const src = `fret-lot-${++seq}`
  await prisma.$transaction((tx) => addLotTx(tx, {
    tenantId, inventoryItemId: itemId, qty, unitCostCents, kind: 'count_gain', lotSourceType: 'count_gain', lotSourceId: src,
    movementSourceType: 'test', movementSourceId: src, receivedAt: new Date(Date.now() - 5 * DAY),
  }))
}

/**
 * A delivery out with A's rider: Beef Nihari (fired) + Kheer (not fired),
 * stock depleted, cash on delivery pending (or no COD when `cod` is false).
 */
async function outForDelivery(o: Partial<{
  cod: boolean; customer: boolean; pickedUp: boolean; app: boolean; status: 'ready' | 'preparing' | 'completed'
  fulfilment: 'delivery' | 'takeout'; rider: boolean; delivered: boolean
}> = {}) {
  const customerId = (o.customer ?? true) ? (await prisma.customer.create({ data: { name: `Return guest ${++seq}` } })).id : null
  const { order } = await ingestOrder({
    source: 'manual', external_id: randomUUID(), concept_id: A.conceptId, placed_at: new Date().toISOString(),
    customer_id: customerId, customer_name: null, loyalty_points_earned: null, delivery_notes: null, estimated_pickup: null,
    fulfilment_type: o.fulfilment ?? 'delivery',
    items: [
      { externalItemId: '', menuItemId: A.items.nihari, name: 'Beef Nihari', quantity: 1, unitPriceCents: 100_000, modifiers: [] },
      { externalItemId: '', menuItemId: A.items.kheer, name: 'Kheer', quantity: 1, unitPriceCents: 50_000, modifiers: [] },
    ],
    payment: (o.cod ?? true) ? { provider: 'cash', amountCents: 150_000, status: 'pending' } : { provider: null, amountCents: 150_000, status: 'pending' },
  })
  await deductInventoryForOrder(order.id)
  const items = await prisma.orderItem.findMany({ where: { orderId: order.id }, orderBy: { createdAt: 'asc' } })
  const nihari = items.find((i) => i.menuItemId === A.items.nihari)!
  const kheer = items.find((i) => i.menuItemId === A.items.kheer)!
  await prisma.orderItem.update({ where: { id: nihari.id }, data: { status: 'bumped' } })
  const now = new Date()
  const app = o.app ?? true
  const withRider = o.rider ?? true
  await prisma.order.update({
    where: { id: order.id },
    data: {
      status: o.status ?? 'ready', customerId,
      riderId: withRider ? riderA : null,
      riderAssignedAt: withRider && app ? now : null,
      riderAcceptedAt: withRider && app ? now : null,
      pickedUpAt: withRider && app && (o.pickedUp ?? true) ? now : null,
      deliveredAt: o.delivered ? now : null,
    },
  })
  return { id: order.id, nihari, kheer }
}

const actorA = (tenantId = A.tenantId) => ({ id: mgrA.id, email: 'mgr-a@fret.test', tenantId, role: 'foh_management' })
const stockOf = async (id: string) => (await prisma.inventoryItem.findUniqueOrThrow({ where: { id } })).currentStock
const entryOf = (reference: string) => prisma.journalEntry.findFirst({
  where: { reference }, include: { lines: { include: { account: { select: { code: true } } } } },
})
const codeOf = async (p: Promise<unknown>): Promise<string | null> => {
  try { await p; return null } catch (err) { return (err as AppError).code }
}

beforeAll(async () => {
  setFiscalKicker(async () => {})
  A = await mkCompany(`fret-a-${Date.now()}`)
  B = await mkCompany(`fret-b-${Date.now()}`)
  await prisma.setting.create({ data: { key: fifoCutoverKey(A.tenantId), value: new Date(Date.now() - 60 * DAY).toISOString() } })
  mgrA = await mkUser('fret-mgr-a', 'foh_management', A.tenantId)
  mgrB = await mkUser('fret-mgr-b', 'foh_management', B.tenantId)
  cashA = await mkUser('fret-cash-a', 'cashier', A.tenantId)
  beefA = (await prisma.inventoryItem.create({ data: { tenantId: A.tenantId, name: 'Beef', unit: 'kg', category: 'protein' } })).id
  boxA = (await prisma.inventoryItem.create({ data: { tenantId: A.tenantId, name: 'Nihari box', unit: 'pcs', category: 'packaging' } })).id
  colaA = (await prisma.inventoryItem.create({ data: { tenantId: A.tenantId, name: 'Cola', unit: 'pcs', category: 'beverage' } })).id
  await lot(A.tenantId, beefA, 50, 150_000)
  await lot(A.tenantId, boxA, 100, 3_000)
  await lot(A.tenantId, colaA, 100, 8_000)
  // Nihari: 150 g beef + a box (Packaging — a delivery always takes it). Kheer stands in for a drink: 1 cola.
  await prisma.recipe.create({
    data: {
      kind: 'plate', menuItemId: A.items.nihari, servings: 1, qFactorPct: 0,
      ingredients: { create: [
        { inventoryItemId: beefA, quantity: 150, unit: 'kg' },
        { inventoryItemId: boxA, quantity: 1, unit: 'pcs', section: 'packaging' },
      ] },
    },
  })
  await prisma.recipe.create({
    data: { kind: 'plate', menuItemId: A.items.kheer, servings: 1, qFactorPct: 0, ingredients: { create: [{ inventoryItemId: colaA, quantity: 1, unit: 'pcs' }] } },
  })
  riderA = (await prisma.rider.create({ data: { tenantId: A.tenantId, name: 'Rider Fret', phone: '03125557001', status: 'busy', isActive: true } })).id

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(orderRoutes, { prefix: '/orders' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  setFiscalKicker(null)
  await app?.close()
})

describe('food came back — refused', () => {
  let o: Awaited<ReturnType<typeof outForDelivery>>
  let res: Awaited<ReturnType<typeof returnUndeliveredOrder>>
  const before: Record<string, number> = {}

  beforeAll(async () => {
    o = await outForDelivery()
    await prisma.preBill.create({
      data: {
        tenantId: A.tenantId, conceptId: A.conceptId, orderId: o.id, number: 90_001, printedById: mgrA.id, tender: 'cash',
        lines: [], subtotalCents: 150_000, discountCents: 0, serviceChargeCents: 0, taxCents: 0, totalCents: 150_000,
      },
    })
    for (const id of [beefA, boxA, colaA]) before[id] = await stockOf(id)
    // The manager's ACTIVE company is B; the order is A's.
    res = await returnUndeliveredOrder(o.id, { actor: actorA(B.tenantId), cause: 'refused', reason: 'Customer refused at the door' })
  })

  it('cancels the order with returnedAt / returnCause, audited in A', async () => {
    const order = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })
    expect(order.status).toBe('cancelled')
    expect(order.returnedAt).not.toBeNull()
    expect(order.returnCause).toBe('refused')
    expect(order.cancellationReason).toBe('Returned by rider — refused: Customer refused at the door')
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'order.returned_by_rider', entityId: o.id } })
    expect(audit.tenantId).toBe(A.tenantId)
    expect(audit.metadata).toMatchObject({ approverId: mgrA.id, returnCause: 'refused' })
  })

  it('wastes EVERY line as returned_food (fired and unfired), one log per item, nothing back in the lots', async () => {
    const logs = await prisma.wasteLog.findMany({ where: { orderItemId: { in: [o.nihari.id, o.kheer.id] } } })
    expect(logs.map((l) => [l.orderItemId, l.inventoryItemId, l.reason, l.tenantId]).sort()).toEqual([
      [o.nihari.id, beefA, 'returned_food', A.tenantId],
      [o.nihari.id, boxA, 'returned_food', A.tenantId],
      [o.kheer.id, colaA, 'returned_food', A.tenantId],
    ].sort())
    // 150 g of beef at PKR 1,500/kg = 22,500; a box 3,000; a cola 8,000.
    expect(res.wasteCostCents).toBe(33_500)
    expect(res.wasteLogIds.sort()).toEqual(logs.map((l) => l.id).sort())
    for (const id of [beefA, boxA, colaA]) expect(await stockOf(id)).toBeCloseTo(before[id]!, 6)
    expect(await prisma.stockMovement.count({ where: { orderId: o.id, kind: 'sale_return' } })).toBe(0)
    const claim = await prisma.auditLog.findFirstOrThrow({ where: { action: 'stock.sale_restore', entityId: o.id } })
    expect(claim.metadata).toMatchObject({ wasteAll: true, wasteReason: 'returned_food', returnedCents: 0, wastedCents: 33_500 })
  })

  it('books Dr 1290 / Cr 1210 + 1230 (nihari) and Cr 1220 (cola) in A under pos.void_waste:<line>', async () => {
    const n = await entryOf(`pos.void_waste:${o.nihari.id}`)
    expect(n?.tenantId).toBe(A.tenantId)
    const sides = (e: NonNullable<typeof n>) => e.lines.map((l) => [l.account.code, l.type, Number(l.amountCents)]).sort()
    expect(sides(n!)).toEqual([['1210', 'credit', 22_500], ['1230', 'credit', 3_000], ['1290', 'debit', 22_500], ['1290', 'debit', 3_000]].sort())
    const k = await entryOf(`pos.void_waste:${o.kheer.id}`)
    expect(k?.tenantId).toBe(A.tenantId)
    expect(sides(k!)).toEqual([['1220', 'credit', 8_000], ['1290', 'debit', 8_000]].sort())
  })

  it('voids the pending COD (no posting), files nothing, cancels the pre-bill', async () => {
    const pay = await prisma.payment.findFirstOrThrow({ where: { orderId: o.id, method: 'cash' } })
    expect(pay.status).toBe('failed')
    expect(pay.gatewayMeta).toMatchObject({ voided: { reason: 'returned_undelivered', by: mgrA.id } })
    expect(res.codVoidedCents).toBe(150_000)
    expect(res.refundDueCents).toBe(0)
    expect(await prisma.fiscalDocument.count({ where: { orderId: o.id } })).toBe(0)
    expect(await prisma.preBill.findFirstOrThrow({ where: { orderId: o.id } })).toMatchObject({ status: 'cancelled', cancelledById: mgrA.id })
  })

  it('writes the rider\'s returned event (with the manager), a food_returned flag in A, and one strike in A', async () => {
    const ev = await prisma.riderJobEvent.findFirstOrThrow({ where: { orderId: o.id, type: 'returned' } })
    expect(ev).toMatchObject({ riderId: riderA, tenantId: A.tenantId, riderTenantId: A.tenantId, actorId: mgrA.id })
    const flag = await prisma.exceptionFlag.findFirstOrThrow({ where: { kind: 'food_returned', entityId: o.id } })
    expect(flag.tenantId).toBe(A.tenantId)
    expect(Number(flag.amountCents)).toBe(33_500)
    expect(res.strike).toEqual({ recorded: true, duplicate: false })
    const strikes = await prisma.customerStrike.findMany({ where: { sourceType: 'order', sourceId: o.id } })
    expect(strikes.map((s) => [s.kind, s.severity, s.tenantId])).toEqual([['cod_refused', 1, A.tenantId]])
  })

  it('a replay is 409 ALREADY_RETURNED — no second waste, event, flag or strike', async () => {
    const counts = async () => [
      await prisma.wasteLog.count({ where: { orderItemId: { in: [o.nihari.id, o.kheer.id] } } }),
      await prisma.riderJobEvent.count({ where: { orderId: o.id, type: 'returned' } }),
      await prisma.exceptionFlag.count({ where: { kind: 'food_returned', entityId: o.id } }),
      await prisma.customerStrike.count({ where: { sourceId: o.id } }),
      await prisma.journalEntry.count({ where: { tenantId: A.tenantId } }),
    ]
    const c0 = await counts()
    const err = await returnUndeliveredOrder(o.id, { actor: actorA(), cause: 'refused', reason: 'again' }).catch((e: AppError) => e)
    expect(err).toMatchObject({ code: 'ALREADY_RETURNED', statusCode: 409 })
    expect(await counts()).toEqual(c0)
  })
})

describe('food came back — other causes and paid tickets', () => {
  it('unreachable: wasted and cancelled, no strike', async () => {
    const o = await outForDelivery()
    const r = await returnUndeliveredOrder(o.id, { actor: actorA(), cause: 'unreachable', reason: 'Phone off, nobody home' })
    expect(r.strike).toBeNull()
    expect(r.wasteCostCents).toBe(33_500)
    expect(await prisma.customerStrike.count({ where: { sourceId: o.id } })).toBe(0)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).returnCause).toBe('unreachable')
  })

  it('a paid card ticket is accepted: the food is wasted and refundDueCents names what the hand-back owes', async () => {
    const o = await outForDelivery({ cod: false })
    const shiftId = await openDrawer(A, cashA)
    await prisma.payment.create({ data: { orderId: o.id, method: 'card', amountCents: 150_000, status: 'paid', processedAt: new Date(), shiftId } })
    const r = await returnUndeliveredOrder(o.id, { actor: actorA(), cause: 'other', reason: 'Wrong address, our mistake' })
    expect(r.codVoidedCents).toBe(0)
    expect(r.refundDueCents).toBe(150_000)
    expect(r.strike).toBeNull()
    expect((await prisma.payment.findFirstOrThrow({ where: { orderId: o.id, method: 'card' } })).status).toBe('paid')
  })
})

describe('refusals', () => {
  it.each([
    ['NOT_A_DELIVERY', { fulfilment: 'takeout' as const }],
    ['ALREADY_DELIVERED', { delivered: true }],
    ['ORDER_COMPLETED_USE_REFUND', { status: 'completed' as const }],
    ['ORDER_NOT_ACTIVE', { status: 'preparing' as const }],
    ['NO_RIDER', { rider: false }],
    ['NOT_PICKED_UP', { pickedUp: false }],
  ])('%s', async (code, spec) => {
    const o = await outForDelivery(spec)
    expect(await codeOf(returnUndeliveredOrder(o.id, { actor: actorA(), cause: 'refused', reason: 'x' }))).toBe(code)
    expect(await prisma.wasteLog.count({ where: { orderItemId: o.nihari.id, reason: 'returned_food' } })).toBe(0)
    expect(await prisma.customerStrike.count({ where: { sourceId: o.id } })).toBe(0)
  })

  it('a rider without the app (no riderAssignedAt) passes the pick-up check', async () => {
    const o = await outForDelivery({ app: false })
    expect((await returnUndeliveredOrder(o.id, { actor: actorA(), cause: 'other', reason: 'came back' })).ok).toBe(true)
  })
})

describe('a closed period', () => {
  it('the cancel stands and each refused waste posting is flagged posting_failed in A', async () => {
    const o = await outForDelivery()
    const lock = await prisma.periodLock.create({ data: { tenantId: A.tenantId, lockedThrough: new Date(Date.now() + 365 * DAY), lockedBy: mgrA.id } })
    try {
      const r = await returnUndeliveredOrder(o.id, { actor: actorA(), cause: 'unreachable', reason: 'nobody home' })
      expect(r.wasteCostCents).toBe(33_500)
      expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('cancelled')
      expect(await entryOf(`pos.void_waste:${o.nihari.id}`)).toBeNull()
      const flags = await prisma.exceptionFlag.findMany({ where: { kind: 'posting_failed', entityId: { in: [o.nihari.id, o.kheer.id] } } })
      expect(flags.map((f) => [f.entityId, f.tenantId, (f.metadata as { sourceType?: string }).sourceType]).sort()).toEqual([
        [o.kheer.id, A.tenantId, 'pos.void_waste'], [o.nihari.id, A.tenantId, 'pos.void_waste'],
      ].sort())
    } finally {
      await prisma.periodLock.delete({ where: { id: lock.id } })
    }
  })
})

describe('the generic cancel of a delivery out with its rider', () => {
  it('code-only delivery OFF: cancels as today (fired food cancelled_after_fire, unfired back to the lots)', async () => {
    const o = await outForDelivery()
    const r = await call(mgrA, 'POST', `/orders/${o.id}/cancel`, { reason: 'Customer called to cancel' })
    expect(r.statusCode, r.body).toBe(200)
    const logs = await prisma.wasteLog.findMany({ where: { orderItemId: { in: [o.nihari.id, o.kheer.id] } } })
    expect(logs.every((l) => l.reason === 'cancelled_after_fire' && l.orderItemId === o.nihari.id)).toBe(true)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).returnedAt).toBeNull()
  })

  describe('code-only delivery ON', () => {
    beforeAll(async () => {
      await prisma.$transaction((tx) => setCodeOnlyDelivery(tx, { tenantId: A.tenantId, on: true, actorId: mgrA.id, reason: 'go live with code-only delivery' }))
    })
    afterAll(async () => {
      await prisma.$transaction((tx) => setCodeOnlyDelivery(tx, { tenantId: A.tenantId, on: false, actorId: mgrA.id, reason: 'back off after the test' }))
    })

    it('a picked-up delivery → 409 USE_EMERGENCY_OVERRIDE, nothing changed; B gets 404', async () => {
      const o = await outForDelivery()
      expect((await call(mgrB, 'POST', `/orders/${o.id}/cancel`, { reason: 'not mine' })).statusCode).toBe(404)
      const r = await call(mgrA, 'POST', `/orders/${o.id}/cancel`, { reason: 'Customer called to cancel' })
      expect(r.statusCode).toBe(409)
      expect(r.json().error).toMatchObject({ code: 'USE_EMERGENCY_OVERRIDE' })
      expect(r.json().error.message).toContain('Emergency overrides')
      const order = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })
      expect(order.status).toBe('ready')
      expect(await prisma.wasteLog.count({ where: { orderItemId: o.nihari.id } })).toBe(0)
      // Food came back still works.
      expect((await returnUndeliveredOrder(o.id, { actor: actorA(), cause: 'other', reason: 'logged properly' })).ok).toBe(true)
    })

    it('a rider without the app is "out" too → 409', async () => {
      const o = await outForDelivery({ app: false })
      expect(await codeOf(cancelOrder(o.id, { reason: 'x', actor: { id: mgrA.id, tenantId: A.tenantId } }))).toBe('USE_EMERGENCY_OVERRIDE')
    })

    // (An intake reject is exempt too, but the state machine never lets a 'ready' order be rejected.)
  it('an app job not yet picked up and the system auto-cancel are not refused', async () => {
      const notYet = await outForDelivery({ pickedUp: false })
      expect((await cancelOrder(notYet.id, { reason: 'x', actor: { id: mgrA.id, tenantId: A.tenantId } })).status).toBe('cancelled')
      const sys = await outForDelivery()
      expect((await cancelOrder(sys.id, { reason: 'auto', actor: null })).status).toBe('cancelled')
    })
  })
})

describe('the old routes are gone', () => {
  it('POST /orders/:id/cod-unpaid and /orders/:id/refused-at-door → 404', async () => {
    const o = await outForDelivery()
    expect((await call(mgrA, 'POST', `/orders/${o.id}/cod-unpaid`, { reason: 'x' })).statusCode).toBe(404)
    expect((await call(mgrA, 'POST', `/orders/${o.id}/refused-at-door`, { reason: 'x' })).statusCode).toBe(404)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('ready')
  })
})
