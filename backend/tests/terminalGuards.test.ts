// W4 — while the card machine works on a bill, nothing else settles it
// (spec §7.10, D11). Under the order lock:
//   - a cash / card tender (POST /pos/payments), a split-portion settle, a
//     comp, a gift card and a (re-)split are all 409 TERMINAL_CHARGE_ACTIVE
//     {chargeId}; a drawer with a charge in flight cannot close (409
//     SHIFT_HAS_ACTIVE_CHARGE);
//   - the charge itself still records (processPayment / settlePayment let
//     their own terminalChargeId through), persisting the card slip in
//     gatewayMeta, and the sale files ONE fiscal document;
//   - the bill changed after the charge started → the approval is refused
//     (AMOUNT_MISMATCH) → the charge is voided automatically, no payment;
//   - once the charge is final the bill takes other tenders again.
//   - W4-MONEY-4: a line void and a whole-order cancel are refused too — the
//     card would be charged for a bill that no longer exists;
//   - W4-MONEY-1: a charge on a pending row records only if the row is still
//     exactly what the card was charged (else refused → reversed);
//   - W4-AUTH-2: allowManualRef=false is enforced by the server — a keyed card
//     reference is refused (company A), allowed where it is on (company B);
//   - W4-MONEY-3: a card refund on its way back through the machine counts as
//     refunded for the manual refund route — the same money never goes back
//     twice.
// Two companies: B never sees A's charge.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { randomUUID } from 'node:crypto'
import { AppError, errorResponse } from '../src/lib/errors.js'
import { posRoutes } from '../src/modules/pos/routes.js'
import { orderRoutes } from '../src/modules/orders/routes.js'
import { checkSplitRoutes } from '../src/modules/checkSplit/routes.js'
import { registerConnectorPlugins } from '../src/modules/connectors/index.js'
import { applyGiftCardTender } from '../src/modules/pos/service.js'
import { applyTerminalEvent } from '../src/connectors/terminal/service.js'
import { testApproval } from '../src/connectors/drivers/test.js'
import { setFiscalKicker } from '../src/connectors/fiscal/outbox.js'
import {
  prisma, mkCompany, mkUser, caller, setConnector, resetConnectorCache, openDrawer, terminalSettings, ringKheer,
  type Company, type Who,
} from './connectorsFixtures.js'

let app: FastifyInstance
let A: Company, B: Company
let cashierA: Who, mgrA: Who, cashierB: Who
let drawerA: string, drawerMgrA: string, drawerB: string

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
  await a.ready()
  return a
}

const call = (...args: Parameters<ReturnType<typeof caller>>) => caller(app)(...args)
const quoteCard = async (orderId: string) => (await call(cashierA, 'GET', `/pos/orders/${orderId}/quote?method=card`)).json().dueCents as number

async function startCharge(orderId: string, extra: Record<string, unknown> = {}) {
  const r = await call(cashierA, 'POST', '/pos/terminal/charges', {
    orderId, shiftId: drawerA, terminalId: 'trm-1', expectedDueCents: await quoteCard(orderId), idempotencyKey: randomUUID(), ...extra,
  })
  if (r.statusCode !== 201) throw new Error(`start failed ${r.statusCode} ${r.body}`)
  return r.json() as { id: string; amountCents: number; status: string }
}

function expectActive(r: { statusCode: number; json: () => { error: { code: string; details?: { chargeId?: string } } } }, chargeId: string) {
  expect(r.statusCode).toBe(409)
  expect(r.json().error).toMatchObject({ code: 'TERMINAL_CHARGE_ACTIVE', details: { chargeId } })
}

beforeAll(async () => {
  A = await mkCompany('tguard-a', { srbPosId: 8101 })
  B = await mkCompany('tguard-b', { srbPosId: 8102 })
  cashierA = await mkUser('tguard-cashier-a', 'cashier', A.tenantId)
  mgrA = await mkUser('tguard-mgr-a', 'foh_management', A.tenantId)
  cashierB = await mkUser('tguard-cashier-b', 'cashier', B.tenantId)
  drawerA = await openDrawer(A, cashierA)
  drawerMgrA = await openDrawer(A, mgrA)
  drawerB = await openDrawer(B, cashierB)
  setFiscalKicker(async () => {})
  app = await build()
}, 60_000)

afterAll(async () => {
  setFiscalKicker(null)
  resetConnectorCache()
  await app?.close()
})

beforeEach(async () => {
  // 'never': the machine waits for a card until we say otherwise.
  await setConnector(A.tenantId, 'terminal', { driver: 'test', enabled: true, settings: terminalSettings(A, 'never') })
  await setConnector(B.tenantId, 'terminal', { driver: 'test', enabled: true, settings: terminalSettings(B, 'never') })
  await setConnector(A.tenantId, 'fiscal', { driver: 'test', enabled: true, settings: { test: { scenario: 'ok' } } })
})

describe('an active card-machine charge holds the bill', () => {
  it('cash, comp, gift card and a split are refused with 409 TERMINAL_CHARGE_ACTIVE; nothing is taken', async () => {
    const o = await ringKheer(app, cashierA, A)
    const charge = await startCharge(o.id)
    expect(charge.status).toBe('sent')

    expectActive(await call(cashierA, 'POST', '/pos/payments', { orderId: o.id, shiftId: drawerA, payments: [{ method: 'cash', amountCents: o.totalCents }] }), charge.id)
    expectActive(await call(mgrA, 'POST', `/pos/orders/${o.id}/comp`, { amountCents: 10_000, reason: 'regular', shiftId: drawerMgrA }), charge.id)
    expectActive(await call(cashierA, 'POST', `/check-split/orders/${o.id}/split-evenly`, { ways: 2, method: 'cash' }), charge.id)
    await prisma.giftCard.create({ data: { tenantId: A.tenantId, code: 'GS-TGUARD-1', issuedAmountCents: 50_000, balanceCents: 50_000 } })
    await expect(applyGiftCardTender({ orderId: o.id, code: 'GS-TGUARD-1', staffId: cashierA.id }))
      .rejects.toMatchObject({ code: 'TERMINAL_CHARGE_ACTIVE', statusCode: 409 })
    expect((await prisma.giftCard.findUniqueOrThrow({ where: { code: 'GS-TGUARD-1' } })).balanceCents).toBe(50_000)
    expect(await prisma.payment.count({ where: { orderId: o.id } })).toBe(0)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).not.toBe('completed')

    // The drawer cannot close while the charge is in flight.
    const close = await call(cashierA, 'POST', `/pos/shifts/${drawerA}/close`, { closingFloatCents: 0, confirmOpenTickets: true })
    expect(close.statusCode).toBe(409)
    expect(close.json().error.code).toBe('SHIFT_HAS_ACTIVE_CHARGE')
    expect((await prisma.shift.findUniqueOrThrow({ where: { id: drawerA } })).status).toBe('open')

    // The approval itself records — the guard lets its own charge through —
    // with the slip in gatewayMeta, and the sale files ONE fiscal document.
    await applyTerminalEvent(A.tenantId, charge.id, testApproval(charge.id, charge.amountCents), 'simulate')
    const recorded = await prisma.terminalCharge.findUniqueOrThrow({ where: { id: charge.id } })
    expect(recorded.status).toBe('recorded')
    const pays = await prisma.payment.findMany({ where: { orderId: o.id } })
    expect(pays).toHaveLength(1)
    expect(pays[0]).toMatchObject({ method: 'card', gateway: 'card_terminal', status: 'paid', amountCents: charge.amountCents })
    expect(pays[0]!.gatewayMeta).toMatchObject({ terminalChargeId: charge.id, cardBrand: 'TESTCARD', cardLast4: '4242', authCode: testApproval(charge.id, 0).authCode })
    expect(await prisma.fiscalDocument.count({ where: { orderId: o.id, kind: 'sale' } })).toBe(1)
    // The receipt prints the card slip.
    expect((await call(cashierA, 'GET', `/pos/orders/${o.id}/receipt-data`)).json().card).toMatchObject({ brand: 'TESTCARD', last4: '4242' })
  })

  it('a split portion cannot be settled while the machine works on another portion; the charged portion settles itself', async () => {
    const o = await ringKheer(app, cashierA, A)
    const split = await call(cashierA, 'POST', `/check-split/orders/${o.id}/split-evenly`, { ways: 2, method: 'card' })
    expect(split.statusCode, split.body).toBe(200)
    const [p1, p2] = split.json() as Array<{ id: string; amountCents: number }>
    const charge = await startCharge(o.id, { paymentId: p1!.id, expectedDueCents: p1!.amountCents })
    expectActive(await call(cashierA, 'POST', `/check-split/payments/${p2!.id}/settle`, { shiftId: drawerA, gatewayRef: 'SLIP-9' }), charge.id)
    expectActive(await call(cashierA, 'POST', `/pos/payments/${p2!.id}/settle`, { shiftId: drawerA, gatewayRef: 'SLIP-9' }), charge.id)
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: p2!.id } })).status).toBe('pending')

    await applyTerminalEvent(A.tenantId, charge.id, testApproval(charge.id, charge.amountCents), 'simulate')
    const settled = await prisma.payment.findUniqueOrThrow({ where: { id: p1!.id } })
    expect(settled).toMatchObject({ status: 'paid', gateway: 'card_terminal', shiftId: drawerA })
    expect(settled.gatewayMeta).toMatchObject({ terminalChargeId: charge.id })
    // Final now: the other portion settles.
    const s2 = await call(cashierA, 'POST', `/check-split/payments/${p2!.id}/settle`, { shiftId: drawerA, gatewayRef: 'SLIP-9' })
    expect(s2.statusCode, s2.body).toBe(200)
    expect(s2.json().orderCompleted).toBe(true)
  })

  it('a line void and a whole-order cancel are refused while the machine charges the bill (W4-MONEY-4)', async () => {
    const rung = await call(cashierA, 'POST', '/pos/orders', {
      conceptId: A.conceptId,
      items: [
        { menuItemId: A.items.kheer, name: 'Kheer', quantity: 1, unitPriceCents: 55_000, modifiers: [] },
        { menuItemId: A.items.nihari, name: 'Beef Nihari', quantity: 1, unitPriceCents: 145_000, modifiers: [] },
      ],
    })
    expect(rung.statusCode, rung.body).toBe(201)
    const o = await prisma.order.findUniqueOrThrow({ where: { id: rung.json().id }, include: { items: true } })
    const charge = await startCharge(o.id)
    expectActive(await call(mgrA, 'POST', `/pos/orders/${o.id}/void`, { orderItemId: o.items[0]!.id, reason: 'guest changed mind' }), charge.id)
    expectActive(await call(mgrA, 'POST', `/orders/${o.id}/cancel`, { reason: 'guest left' }), charge.id)
    const still = await prisma.order.findUniqueOrThrow({ where: { id: o.id }, include: { items: true } })
    expect(still.status).not.toBe('cancelled')
    expect(still.items.every((i) => i.status !== 'voided')).toBe(true)
    // The charge records against the bill it was started for.
    await applyTerminalEvent(A.tenantId, charge.id, testApproval(charge.id, charge.amountCents), 'simulate')
    expect((await prisma.terminalCharge.findUniqueOrThrow({ where: { id: charge.id } })).status).toBe('recorded')
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('completed')
  })

  it('the bill changed after the charge started → approval refused (AMOUNT_MISMATCH) → voided automatically, no payment; then cash is taken', async () => {
    const rung = await call(cashierA, 'POST', '/pos/orders', {
      conceptId: A.conceptId,
      items: [
        { menuItemId: A.items.kheer, name: 'Kheer', quantity: 1, unitPriceCents: 55_000, modifiers: [] },
        { menuItemId: A.items.nihari, name: 'Beef Nihari', quantity: 1, unitPriceCents: 145_000, modifiers: [] },
      ],
    })
    expect(rung.statusCode, rung.body).toBe(201)
    const o = await prisma.order.findUniqueOrThrow({ where: { id: rung.json().id }, include: { items: true } })
    const charge = await startCharge(o.id)
    // The bill changes by a path outside the till's guards while the machine waits.
    await prisma.orderItem.create({ data: { orderId: o.id, menuItemId: A.items.kheer, name: 'Kheer', quantity: 1, unitPriceCents: 55_000 } })
    await applyTerminalEvent(A.tenantId, charge.id, testApproval(charge.id, charge.amountCents), 'simulate')
    const after = await prisma.terminalCharge.findUniqueOrThrow({ where: { id: charge.id } })
    expect(after).toMatchObject({ status: 'voided', refusalCode: 'AMOUNT_MISMATCH', paymentId: null })
    expect(await prisma.payment.count({ where: { orderId: o.id } })).toBe(0)
    expect(await prisma.fiscalDocument.count({ where: { orderId: o.id } })).toBe(0)

    // The charge is final: the bill takes cash again.
    const due = (await call(cashierA, 'GET', `/pos/orders/${o.id}/quote?method=cash`)).json().dueCents as number
    const cash = await call(cashierA, 'POST', '/pos/payments', { orderId: o.id, shiftId: drawerA, payments: [{ method: 'cash', amountCents: due }] })
    expect(cash.statusCode, cash.body).toBe(201)
    expect(cash.json().orderCompleted).toBe(true)
  })

  it('company B cannot see or settle around A\'s charge; B\'s own bills are unaffected', async () => {
    const o = await ringKheer(app, cashierA, A)
    const charge = await startCharge(o.id)
    expect((await call(cashierB, 'GET', `/pos/terminal/charges/${charge.id}`)).statusCode).toBe(404)
    expect((await call(cashierB, 'POST', '/pos/payments', { orderId: o.id, shiftId: drawerB, payments: [{ method: 'cash', amountCents: o.totalCents }] })).statusCode).toBe(404)
    const ob = await ringKheer(app, cashierB, B)
    const pb = await call(cashierB, 'POST', '/pos/payments', { orderId: ob.id, shiftId: drawerB, payments: [{ method: 'cash', amountCents: ob.totalCents }] })
    expect(pb.statusCode, pb.body).toBe(201)
  })

  it('a card slip keyed by hand while the machine is offline is recorded as such and audited', async () => {
    const o = await ringKheer(app, cashierA, A)
    const due = await quoteCard(o.id)
    const r = await call(cashierA, 'POST', '/pos/payments', { orderId: o.id, shiftId: drawerA, payments: [{ method: 'card', amountCents: due, gatewayRef: 'SLIP-OFF-1', manualReason: 'terminal_offline' }] })
    expect(r.statusCode, r.body).toBe(201)
    const p = await prisma.payment.findFirstOrThrow({ where: { orderId: o.id } })
    expect(p).toMatchObject({ gateway: 'none', gatewayRef: 'SLIP-OFF-1' })
    expect(p.gatewayMeta).toMatchObject({ manualReason: 'terminal_offline' })
    expect(await prisma.auditLog.count({ where: { action: 'terminal.manual_reference', entityId: o.id } })).toBe(1)
    // A client can never claim to be the card machine.
    const forged = await call(cashierA, 'POST', '/pos/payments', { orderId: (await ringKheer(app, cashierA, A)).id, shiftId: drawerA, payments: [{ method: 'card', amountCents: due, gatewayRef: 'X', gateway: 'card_terminal' }] })
    expect(forged.statusCode).toBe(400)
  })
})

describe('W4-MONEY-1 — a charge on a pending row records only what the card was charged', () => {
  it('the row was lowered while the machine waited → the settle is refused (AMOUNT_MISMATCH) → the charge is reversed; the row stays pending', async () => {
    const rung = await ringKheer(app, cashierA, A)
    await prisma.order.update({ where: { id: rung.id }, data: { source: 'servd', fulfilmentType: 'takeout', status: 'received' } })
    const o = await prisma.order.findUniqueOrThrow({ where: { id: rung.id } })
    const row = await prisma.payment.create({ data: { orderId: o.id, method: 'card', amountCents: o.totalCents, status: 'pending' } })
    const charge = await startCharge(o.id, { paymentId: row.id, expectedDueCents: row.amountCents })
    expect(charge.amountCents).toBe(row.amountCents)
    // A gift card / points applied by a path that does not hold the bill lowers the pending row.
    await prisma.payment.update({ where: { id: row.id }, data: { amountCents: row.amountCents - 50_000 } })
    await prisma.order.update({ where: { id: o.id }, data: { totalCents: o.totalCents - 50_000 } })

    await applyTerminalEvent(A.tenantId, charge.id, testApproval(charge.id, charge.amountCents), 'simulate')
    const after = await prisma.terminalCharge.findUniqueOrThrow({ where: { id: charge.id } })
    expect(after).toMatchObject({ status: 'voided', refusalCode: 'AMOUNT_MISMATCH', paymentId: null })
    const p = await prisma.payment.findUniqueOrThrow({ where: { id: row.id } })
    expect(p).toMatchObject({ status: 'pending', amountCents: row.amountCents - 50_000, gateway: 'none' })
    expect(await prisma.fiscalDocument.count({ where: { orderId: o.id } })).toBe(0)
  })

  it('an unchanged row settles from the charge as before', async () => {
    const rung = await ringKheer(app, cashierA, A)
    await prisma.order.update({ where: { id: rung.id }, data: { source: 'servd', fulfilmentType: 'dine_in', status: 'received' } })
    const o = await prisma.order.findUniqueOrThrow({ where: { id: rung.id } })
    const row = await prisma.payment.create({ data: { orderId: o.id, method: 'card', amountCents: o.totalCents, status: 'pending' } })
    const charge = await startCharge(o.id, { paymentId: row.id, expectedDueCents: row.amountCents })
    await applyTerminalEvent(A.tenantId, charge.id, testApproval(charge.id, charge.amountCents), 'simulate')
    expect((await prisma.terminalCharge.findUniqueOrThrow({ where: { id: charge.id } })).status).toBe('recorded')
    expect(await prisma.payment.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ status: 'paid', amountCents: charge.amountCents, gateway: 'card_terminal' })
  })
})

describe('W4-AUTH-2 — allowManualRef=false is enforced by the server, per company', () => {
  it('A (switched off): a keyed card reference is refused — offline reason or not, at the till and on a split portion; B (on) is allowed; the machine still records for A', async () => {
    await setConnector(A.tenantId, 'terminal', { driver: 'test', enabled: true, settings: { ...terminalSettings(A, 'never'), allowManualRef: false } })
    const cfg = await call(cashierA, 'GET', `/pos/terminal/config?shiftId=${drawerA}`)
    expect(cfg.json().allowManualRef).toBe(false)

    const o = await ringKheer(app, cashierA, A)
    const due = await quoteCard(o.id)
    for (const extra of [{}, { manualReason: 'terminal_offline' }]) {
      const r = await call(cashierA, 'POST', '/pos/payments', { orderId: o.id, shiftId: drawerA, payments: [{ method: 'card', amountCents: due, gatewayRef: 'MADE-UP-123', ...extra }] })
      expect(r.statusCode, r.body).toBe(403)
      expect(r.json().error.code).toBe('MANUAL_CARD_REF_DISABLED')
    }
    expect(await prisma.payment.count({ where: { orderId: o.id } })).toBe(0)
    // A card portion of a split bill cannot be keyed either.
    const split = await call(cashierA, 'POST', `/check-split/orders/${o.id}/split-evenly`, { ways: 2, method: 'card' })
    expect(split.statusCode, split.body).toBe(200)
    const [p1] = split.json() as Array<{ id: string; amountCents: number }>
    const keyed = await call(cashierA, 'POST', `/check-split/payments/${p1!.id}/settle`, { shiftId: drawerA, gatewayRef: 'MADE-UP-9' })
    expect(keyed.statusCode, keyed.body).toBe(403)
    expect(keyed.json().error.code).toBe('MANUAL_CARD_REF_DISABLED')
    // The machine itself records the portion.
    const charge = await startCharge(o.id, { paymentId: p1!.id, expectedDueCents: p1!.amountCents })
    await applyTerminalEvent(A.tenantId, charge.id, testApproval(charge.id, charge.amountCents), 'simulate')
    expect((await prisma.terminalCharge.findUniqueOrThrow({ where: { id: charge.id } })).status).toBe('recorded')
    // Cash and Keenu QR are not card-machine tenders: untouched.
    const oc = await ringKheer(app, cashierA, A)
    expect((await call(cashierA, 'POST', '/pos/payments', { orderId: oc.id, shiftId: drawerA, payments: [{ method: 'cash', amountCents: oc.totalCents }] })).statusCode).toBe(201)

    // Company B keeps manual references on: allowed.
    const ob = await ringKheer(app, cashierB, B)
    const dueB = (await call(cashierB, 'GET', `/pos/orders/${ob.id}/quote?method=card`)).json().dueCents as number
    const rb = await call(cashierB, 'POST', '/pos/payments', { orderId: ob.id, shiftId: drawerB, payments: [{ method: 'card', amountCents: dueB, gatewayRef: 'SLIP-B-1' }] })
    expect(rb.statusCode, rb.body).toBe(201)
  })
})

describe('W4-MONEY-3 — a card refund in flight on the machine counts for the manual refund route', () => {
  it('the manual refund cannot give back what the machine is refunding; the machine refund still books', async () => {
    const o = await ringKheer(app, cashierA, A)
    const charge = await startCharge(o.id)
    await applyTerminalEvent(A.tenantId, charge.id, testApproval(charge.id, charge.amountCents), 'simulate')
    const pay = await prisma.payment.findFirstOrThrow({ where: { orderId: o.id, status: 'paid' } })
    expect(pay.gateway).toBe('card_terminal')

    const part = 50_000
    const tr = await call(mgrA, 'POST', '/pos/terminal/refunds', { paymentId: pay.id, amountCents: part, terminalId: 'trm-1', idempotencyKey: randomUUID(), reason: 'cold food' })
    expect(tr.statusCode, tr.body).toBe(201)
    const refundCharge = tr.json() as { id: string; amountCents: number; status: string }
    expect(refundCharge.status).not.toBe('recorded')

    // The whole payment by hand: refused — part of it is already on its way back.
    const all = await call(mgrA, 'POST', `/pos/orders/${o.id}/refund`, { amountCents: pay.amountCents, reason: 'cold food', method: 'card', shiftId: drawerMgrA })
    expect(all.statusCode, all.body).toBe(400)
    expect(all.json().error.code).toBe('REFUND_EXCEEDS_PAID')
    // What is left is refundable by hand.
    const rest = await call(mgrA, 'POST', `/pos/orders/${o.id}/refund`, { amountCents: pay.amountCents - part, reason: 'cold food', method: 'card', shiftId: drawerMgrA })
    expect(rest.statusCode, rest.body).toBe(200)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('completed')

    // The machine approves: it books (its own charge is not counted against itself) and the order is refunded in full — once.
    await applyTerminalEvent(A.tenantId, refundCharge.id, testApproval(refundCharge.id, refundCharge.amountCents), 'simulate')
    const rc = await prisma.terminalCharge.findUniqueOrThrow({ where: { id: refundCharge.id } })
    expect(rc.status).toBe('recorded')
    const refunds = await prisma.payment.findMany({ where: { orderId: o.id, status: 'refunded' } })
    expect(refunds.reduce((t, r) => t + Math.abs(r.amountCents), 0)).toBe(pay.amountCents)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('refunded')
  })
})
