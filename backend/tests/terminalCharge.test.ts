// W1 — charging a card on the card machine from the till (spec §7.1–§7.6).
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import {
  prisma, mkCompany, mkUser, buildApp, caller, setConnector, resetConnectorCache, openDrawer, terminalSettings, ringKheer,
  type Company, type Who,
} from './connectorsFixtures.js'
import { setConnectorClock } from '../src/connectors/registry.js'
import { setFiscalKicker } from '../src/connectors/fiscal/outbox.js'
import { testDriverCalls, resetTestDriverCalls, testApproval } from '../src/connectors/drivers/test.js'
import { applyTerminalEvent } from '../src/connectors/terminal/service.js'

let app: FastifyInstance
let call: ReturnType<typeof caller>
let A: Company, B: Company, C: Company
let cashierA: Who, cashierB: Who, cashierC: Who
let drawerA: string, drawerB: string, drawerC: string
let offset = 0
let n = 0
const key = () => `tap-${Date.now()}-${n++}`

async function quoteCard(orderId: string): Promise<number> {
  const q = await call(cashierA, 'GET', `/pos/orders/${orderId}/quote?method=card`)
  expect(q.statusCode, q.body).toBe(200)
  return q.json().dueCents
}

beforeAll(async () => {
  setFiscalKicker(async () => {})
  setConnectorClock(() => new Date(Date.now() + offset))
  A = await mkCompany('tc-a')
  B = await mkCompany('tc-b')
  C = await mkCompany('tc-c')
  cashierA = await mkUser('tcCashierA', 'cashier', A.tenantId)
  cashierB = await mkUser('tcCashierB', 'cashier', B.tenantId)
  cashierC = await mkUser('tcCashierC', 'cashier', C.tenantId)
  await setConnector(A.tenantId, 'terminal', { driver: 'test', enabled: true, settings: terminalSettings(A, 'approve') })
  await setConnector(B.tenantId, 'terminal', { driver: 'test', enabled: true, settings: terminalSettings(B, 'approve') })
  app = await buildApp()
  call = caller(app)
  drawerA = await openDrawer(A, cashierA)
  drawerB = await openDrawer(B, cashierB)
  drawerC = await openDrawer(C, cashierC)
}, 60_000)

beforeEach(() => {
  offset = 0
  resetTestDriverCalls()
})

afterAll(async () => {
  setConnectorClock(null)
  setFiscalKicker(null)
  resetConnectorCache()
  await app.close()
})

describe('config', () => {
  it('the till sees the terminals at its outlet; a foreign drawer is 404', async () => {
    const r = await call(cashierA, 'GET', `/pos/terminal/config?shiftId=${drawerA}`)
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json()).toMatchObject({ enabled: true, driver: 'test', isTest: true, allowManualRef: true, chargeTimeoutSec: 120, pollMs: 1500, terminals: [{ id: 'trm-1', label: 'Counter 1' }], online: true })
    expect((await call(cashierA, 'GET', `/pos/terminal/config?shiftId=${drawerB}`)).statusCode).toBe(404)
    const c = await call(cashierC, 'GET', `/pos/terminal/config?shiftId=${drawerC}`)
    expect(c.json()).toMatchObject({ enabled: false, terminals: [], allowManualRef: true })
  })
})

describe('happy path', () => {
  it('approve: ONE card payment (gateway card_terminal, ref = approval, 8 % due + tip) and the order completes', async () => {
    const o = await ringKheer(app, cashierA, A)
    const due = await quoteCard(o.id)
    expect(due).toBe(118_800)
    const start = await call(cashierA, 'POST', '/pos/terminal/charges', { orderId: o.id, shiftId: drawerA, terminalId: 'trm-1', tipCents: 5_000, expectedDueCents: due, idempotencyKey: key() })
    expect(start.statusCode, start.body).toBe(201)
    expect(start.json()).toMatchObject({ status: 'sent', final: false, amountCents: 123_800, tipCents: 5_000, quoteDueCents: 118_800, terminalLabel: 'Counter 1', payment: null })
    // Still waiting for the card.
    expect((await call(cashierA, 'GET', `/pos/terminal/charges/${start.json().id}`)).json().status).toBe('sent')
    offset = 2_000
    await new Promise((r) => setTimeout(r, 1_100)) // the poll throttle (1 s)
    const done = await call(cashierA, 'GET', `/pos/terminal/charges/${start.json().id}`)
    expect(done.statusCode, done.body).toBe(200)
    const approval = testApproval(start.json().id, 123_800)
    expect(done.json()).toMatchObject({ status: 'recorded', final: true, approvalRef: approval.approvalRef, cardBrand: 'TESTCARD', cardLast4: '4242' })
    const pays = await prisma.payment.findMany({ where: { orderId: o.id } })
    expect(pays).toHaveLength(1)
    expect(pays[0]).toMatchObject({ method: 'card', gateway: 'card_terminal', gatewayRef: approval.approvalRef, amountCents: 123_800, status: 'paid', shiftId: drawerA })
    expect(done.json().payment).toMatchObject({ id: pays[0]!.id, method: 'card', amountCents: 123_800 })
    const order = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })
    expect(order).toMatchObject({ status: 'completed', tipCents: 5_000, taxRatePct: 8, totalCents: 123_800 })
    expect(testDriverCalls.startCharge).toBe(1)
  })

  it('a double tap with the same key → one charge, one push to the machine', async () => {
    const o = await ringKheer(app, cashierA, A)
    const body = { orderId: o.id, shiftId: drawerA, terminalId: 'trm-1', expectedDueCents: await quoteCard(o.id), idempotencyKey: key() }
    const [r1, r2] = await Promise.all([call(cashierA, 'POST', '/pos/terminal/charges', body), call(cashierA, 'POST', '/pos/terminal/charges', body)])
    expect([r1.statusCode, r2.statusCode].sort()).toEqual([200, 201])
    expect(r1.json().id).toBe(r2.json().id)
    const r3 = await call(cashierA, 'POST', '/pos/terminal/charges', body)
    expect(r3.statusCode).toBe(200)
    expect(await prisma.terminalCharge.count({ where: { orderId: o.id } })).toBe(1)
    expect(testDriverCalls.startCharge).toBe(1)
  })

  it('a different key while a charge is active → 409 CHARGE_IN_PROGRESS {chargeId}', async () => {
    const o = await ringKheer(app, cashierA, A)
    const due = await quoteCard(o.id)
    const first = await call(cashierA, 'POST', '/pos/terminal/charges', { orderId: o.id, shiftId: drawerA, terminalId: 'trm-1', expectedDueCents: due, idempotencyKey: key() })
    const second = await call(cashierA, 'POST', '/pos/terminal/charges', { orderId: o.id, shiftId: drawerA, terminalId: 'trm-1', expectedDueCents: due, idempotencyKey: key() })
    expect(second.statusCode).toBe(409)
    expect(second.json().error).toMatchObject({ code: 'CHARGE_IN_PROGRESS', details: { chargeId: first.json().id } })
  })

  it('a stale expectedDueCents → 409 AMOUNT_MISMATCH {dueCents}; nothing is pushed', async () => {
    const o = await ringKheer(app, cashierA, A)
    const r = await call(cashierA, 'POST', '/pos/terminal/charges', { orderId: o.id, shiftId: drawerA, terminalId: 'trm-1', expectedDueCents: 126_500, idempotencyKey: key() })
    expect(r.statusCode).toBe(409)
    expect(r.json().error).toMatchObject({ code: 'AMOUNT_MISMATCH', details: { dueCents: 118_800 } })
    expect(testDriverCalls.startCharge).toBe(0)
    expect(await prisma.terminalCharge.count({ where: { orderId: o.id } })).toBe(0)
  })

  it('a webhook racing the poll → one Payment', async () => {
    const o = await ringKheer(app, cashierA, A)
    const start = await call(cashierA, 'POST', '/pos/terminal/charges', { orderId: o.id, shiftId: drawerA, terminalId: 'trm-1', expectedDueCents: await quoteCard(o.id), idempotencyKey: key() })
    const id = start.json().id as string
    offset = 2_000
    await new Promise((r) => setTimeout(r, 1_100))
    await Promise.all([
      call(cashierA, 'GET', `/pos/terminal/charges/${id}`),
      applyTerminalEvent(A.tenantId, id, testApproval(id, start.json().amountCents), 'poll'),
      applyTerminalEvent(A.tenantId, id, testApproval(id, start.json().amountCents), 'reconciler'),
    ])
    await new Promise((r) => setTimeout(r, 300))
    expect(await prisma.payment.count({ where: { orderId: o.id, status: 'paid' } })).toBe(1)
    expect((await prisma.terminalCharge.findUniqueOrThrow({ where: { id } })).status).toBe('recorded')
  })
})

describe('company separation and refusals', () => {
  it('a foreign order → 404; a foreign drawer → 422; a terminal of no outlet here → 422; no machine → 503', async () => {
    const o = await ringKheer(app, cashierA, A)
    const due = await quoteCard(o.id)
    const foreignOrder = await call(cashierB, 'POST', '/pos/terminal/charges', { orderId: o.id, shiftId: drawerB, terminalId: 'trm-1', expectedDueCents: due, idempotencyKey: key() })
    expect(foreignOrder.statusCode).toBe(404)
    const foreignShift = await call(cashierA, 'POST', '/pos/terminal/charges', { orderId: o.id, shiftId: drawerB, terminalId: 'trm-1', expectedDueCents: due, idempotencyKey: key() })
    expect(foreignShift.statusCode).toBe(422)
    const badTerminal = await call(cashierA, 'POST', '/pos/terminal/charges', { orderId: o.id, shiftId: drawerA, terminalId: 'trm-9', expectedDueCents: due, idempotencyKey: key() })
    expect(badTerminal.statusCode).toBe(422)
    expect(badTerminal.json().error.code).toBe('TERMINAL_NOT_IN_COMPANY')
    const oc = await ringKheer(app, cashierC, C)
    const none = await call(cashierC, 'POST', '/pos/terminal/charges', { orderId: oc.id, shiftId: drawerC, terminalId: 'trm-1', expectedDueCents: 118_800, idempotencyKey: key() })
    expect(none.statusCode).toBe(503)
    expect(none.json().error.code).toBe('TERMINAL_NOT_CONFIGURED')
    expect(testDriverCalls.startCharge).toBe(0)
  })

  it('B cannot read, cancel or resolve A\'s charge (404)', async () => {
    const o = await ringKheer(app, cashierA, A)
    const start = await call(cashierA, 'POST', '/pos/terminal/charges', { orderId: o.id, shiftId: drawerA, terminalId: 'trm-1', expectedDueCents: await quoteCard(o.id), idempotencyKey: key() })
    const id = start.json().id as string
    expect((await call(cashierB, 'GET', `/pos/terminal/charges/${id}`)).statusCode).toBe(404)
    expect((await call(cashierB, 'POST', `/pos/terminal/charges/${id}/cancel`)).statusCode).toBe(404)
    expect((await call(cashierB, 'POST', `/pos/terminal/charges/${id}/resolve`, { outcome: 'not_charged' })).statusCode).toBe(404)
    expect((await call(cashierB, 'GET', `/pos/terminal/charges?orderId=${o.id}&active=1`)).statusCode).toBe(404)
    const mine = await call(cashierA, 'GET', `/pos/terminal/charges?orderId=${o.id}&active=1`)
    expect(mine.json().map((c: { id: string }) => c.id)).toEqual([id])
  })

  it('an ended order cannot be charged (409 ORDER_NOT_OPEN)', async () => {
    const o = await ringKheer(app, cashierA, A)
    await prisma.order.update({ where: { id: o.id }, data: { status: 'cancelled' } })
    const r = await call(cashierA, 'POST', '/pos/terminal/charges', { orderId: o.id, shiftId: drawerA, terminalId: 'trm-1', expectedDueCents: 118_800, idempotencyKey: key() })
    expect(r.statusCode).toBe(409)
    expect(r.json().error.code).toBe('ORDER_NOT_OPEN')
  })
})
