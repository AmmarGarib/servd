// W1 review fixes on the card machine (W1-R5, W1-R7):
//   - a card REFUND is never reversed — a mismatched approval on a refund goes
//     to a person, never to a second refund or a void;
//   - an automatic reversal by referenced refund only counts once the
//     processor CONFIRMS the refund ("poll like a charge").
import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import {
  prisma, mkCompany, mkUser, buildApp, caller, setConnector, resetConnectorCache, openDrawer, terminalSettings, ringKheer,
  type Company, type Who,
} from './connectorsFixtures.js'
import { setConnectorClock } from '../src/connectors/registry.js'
import { setFiscalKicker } from '../src/connectors/fiscal/outbox.js'
import { applyTerminalEvent, reverseCharge, reconcileTerminal } from '../src/connectors/terminal/service.js'
import { testDriverCalls, testTerminalDriver, testApproval } from '../src/connectors/drivers/test.js'
import type { ChargeState } from '../src/connectors/types.js'

let app: FastifyInstance
let call: ReturnType<typeof caller>
let A: Company
let cashier: Who, manager: Who
let drawer: string
let offset = 0
let n = 0
const key = () => `rev-${Date.now()}-${n++}`
const HOUR = 3_600_000
const charge = (id: string) => prisma.terminalCharge.findUniqueOrThrow({ where: { id } })
const settle = () => new Promise((r) => setTimeout(r, 1_100))
async function until(what: string, fn: () => Promise<boolean>, ms = 5_000): Promise<void> {
  const end = Date.now() + ms
  while (!(await fn())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

async function cardSale(): Promise<{ orderId: string; paymentId: string; chargeId: string }> {
  const o = await ringKheer(app, cashier, A)
  const q = await call(cashier, 'GET', `/pos/orders/${o.id}/quote?method=card`)
  const r = await call(cashier, 'POST', '/pos/terminal/charges', { orderId: o.id, shiftId: drawer, terminalId: 'trm-1', expectedDueCents: q.json().dueCents, idempotencyKey: key() })
  expect(r.statusCode, r.body).toBe(201)
  offset += 2_000
  await settle()
  const done = await call(cashier, 'GET', `/pos/terminal/charges/${r.json().id}`)
  expect(done.json().status, done.body).toBe('recorded')
  return { orderId: o.id, paymentId: done.json().payment.id, chargeId: r.json().id }
}

/** A charge approved on the machine but refused by servd (order cancelled meanwhile), on a LATER Karachi day → referenced refund. */
async function refusedNextDay(): Promise<string> {
  const o = await ringKheer(app, cashier, A)
  const q = await call(cashier, 'GET', `/pos/orders/${o.id}/quote?method=card`)
  const r = await call(cashier, 'POST', '/pos/terminal/charges', { orderId: o.id, shiftId: drawer, terminalId: 'trm-1', expectedDueCents: q.json().dueCents, idempotencyKey: key() })
  expect(r.statusCode, r.body).toBe(201)
  await prisma.order.update({ where: { id: o.id }, data: { status: 'cancelled' } })
  offset = 26 * HOUR
  await settle()
  await call(cashier, 'GET', `/pos/terminal/charges/${r.json().id}`)
  return r.json().id
}

// The reversing refund's status, as the processor reports it.
let reversalState: ChargeState | 'transient' = { state: 'pending' }
const realStatus = testTerminalDriver.getChargeStatus.bind(testTerminalDriver)

beforeAll(async () => {
  setFiscalKicker(async () => {})
  setConnectorClock(() => new Date(Date.now() + offset))
  A = await mkCompany('rev-a')
  cashier = await mkUser('revCashier', 'cashier', A.tenantId)
  manager = await mkUser('revManager', 'foh_management', A.tenantId)
  await setConnector(A.tenantId, 'terminal', { driver: 'test', enabled: true, settings: terminalSettings(A, 'approve') })
  app = await buildApp()
  call = caller(app)
  drawer = await openDrawer(A, cashier)
}, 60_000)

beforeEach(() => {
  offset = 0
  reversalState = { state: 'pending' }
  vi.spyOn(testTerminalDriver, 'getChargeStatus').mockImplementation(async (ctx, r) => {
    if (!r.chargeId.includes('-rev')) return realStatus(ctx, r)
    testDriverCalls.getChargeStatus++
    if (reversalState === 'transient') return { kind: 'transient', code: 'DOWN', message: 'processor down' }
    return { kind: 'ok', value: reversalState.state === 'approved' ? testApproval(r.chargeId, r.amountCents) : reversalState }
  })
})

afterEach(() => { vi.restoreAllMocks() })

afterAll(async () => {
  setConnectorClock(null)
  setFiscalKicker(null)
  resetConnectorCache()
  await app.close()
})

describe('W1-R5: a card refund is never reversed', () => {
  it('an approved refund reported with a different amount → needs_attention + terminal_unreconciled; no second refund, no void, nothing booked', async () => {
    const sale = await cardSale()
    const r = await call(manager, 'POST', '/pos/terminal/refunds', { paymentId: sale.paymentId, amountCents: 40_000, terminalId: 'trm-1', idempotencyKey: key(), reason: 'cold food' })
    expect(r.statusCode, r.body).toBe(201)
    const id = r.json().id as string
    const refunds = testDriverCalls.refund
    const voids = testDriverCalls.voidCharge
    offset += 26 * HOUR
    // A vendor that reports refunds as negative amounts.
    await applyTerminalEvent(A.tenantId, id, { ...testApproval(id, 40_000), amountCents: -40_000 }, 'webhook')
    await until('the alert', async () => (await prisma.exceptionFlag.count({ where: { entityId: id, kind: 'terminal_unreconciled' } })) > 0)
    const after = await charge(id)
    expect(after).toMatchObject({ kind: 'refund', status: 'needs_attention', refusalCode: 'TERMINAL_AMOUNT_MISMATCH', paymentId: null })
    expect(testDriverCalls.refund).toBe(refunds)
    expect(testDriverCalls.voidCharge).toBe(voids)
    expect(await prisma.payment.count({ where: { orderId: sale.orderId, status: 'refunded' } })).toBe(0)
    expect(await prisma.exceptionFlag.count({ where: { entityId: id, kind: 'terminal_unreconciled' } })).toBe(1)

    // Nothing can push it into a reversal either.
    await prisma.terminalCharge.update({ where: { id }, data: { status: 'void_pending', nextActionAt: null } })
    await reverseCharge(id)
    expect((await charge(id)).status).toBe('needs_attention')
    expect(testDriverCalls.refund).toBe(refunds)
    expect(testDriverCalls.voidCharge).toBe(voids)
    const m = await call(manager, 'POST', `/pos/terminal/charges/${id}/reverse`, {})
    expect(m.statusCode, m.body).toBe(409)
    expect(m.json().error.code).toBe('NOT_REVERSIBLE')
  })
})

describe('W1-R7: a reversal by referenced refund is confirmed before it counts', () => {
  it('pending → stays void_pending (one refund started, never a second); approved → voided', async () => {
    const before = testDriverCalls.refund
    const id = await refusedNextDay()
    let c = await charge(id)
    expect(c).toMatchObject({ status: 'void_pending', refusalCode: 'ORDER_NOT_OPEN' })
    expect(testDriverCalls.refund).toBe(before + 1)
    expect((c.vendorMeta as { reversal?: { chargeId: string } }).reversal).toMatchObject({ chargeId: `${id}-rev` })

    // Still pending at the processor: polled again, never re-sent.
    offset += 31_000
    await reconcileTerminal()
    c = await charge(id)
    expect(c.status).toBe('void_pending')
    expect(testDriverCalls.refund).toBe(before + 1)

    // The processor cannot be asked right now: still waiting, still one refund.
    reversalState = 'transient'
    offset += 31_000
    await reverseCharge(id)
    expect((await charge(id)).status).toBe('void_pending')
    expect(testDriverCalls.refund).toBe(before + 1)

    reversalState = { state: 'approved', providerRef: 'x', approvalRef: 'y', amountCents: 0 }
    offset += 31_000
    await reverseCharge(id)
    c = await charge(id)
    expect(c.status).toBe('voided')
    expect(c.resolvedAt).not.toBeNull()
    expect(testDriverCalls.refund).toBe(before + 1)
  })

  it('declined → the backoff starts a NEW reversing refund (new id); approved → voided', async () => {
    const before = testDriverCalls.refund
    const id = await refusedNextDay()
    reversalState = { state: 'declined', reason: 'CARD_BLOCKED' }
    offset += 31_000
    await reverseCharge(id)
    let c = await charge(id)
    expect(c).toMatchObject({ status: 'void_pending', reverseAttempts: 1 })
    expect((c.vendorMeta as { reversal?: unknown }).reversal).toBeUndefined()

    reversalState = { state: 'approved', providerRef: 'x', approvalRef: 'y', amountCents: 0 }
    offset += 31_000
    await reverseCharge(id)
    c = await charge(id)
    expect(c.status).toBe('voided')
    expect(testDriverCalls.refund).toBe(before + 2)
    expect((c.vendorMeta as { reversal?: { chargeId: string } }).reversal).toMatchObject({ chargeId: `${id}-rev1` })
  })

  it('never confirmed within 24 h → needs_attention + terminal_void_failed (the customer may be charged twice)', async () => {
    const id = await refusedNextDay()
    expect((await charge(id)).status).toBe('void_pending')
    offset += 25 * HOUR
    await reverseCharge(id)
    expect((await charge(id)).status).toBe('needs_attention')
    expect(await prisma.exceptionFlag.count({ where: { entityId: id, kind: 'terminal_void_failed' } })).toBe(1)
  })

  it('same day: a void is final at once (no confirmation needed)', async () => {
    const o = await ringKheer(app, cashier, A)
    const q = await call(cashier, 'GET', `/pos/orders/${o.id}/quote?method=card`)
    const r = await call(cashier, 'POST', '/pos/terminal/charges', { orderId: o.id, shiftId: drawer, terminalId: 'trm-1', expectedDueCents: q.json().dueCents, idempotencyKey: key() })
    await prisma.order.update({ where: { id: o.id }, data: { status: 'cancelled' } })
    offset = 2_000
    await settle()
    const voids = testDriverCalls.voidCharge
    const refunds = testDriverCalls.refund
    await call(cashier, 'GET', `/pos/terminal/charges/${r.json().id}`)
    expect((await charge(r.json().id)).status).toBe('voided')
    expect(testDriverCalls.voidCharge).toBe(voids + 1)
    expect(testDriverCalls.refund).toBe(refunds)
  })
})
