// W1 — card-machine timeouts, unknown outcomes, reversals and the reconciler
// (spec §7.5–§7.9, §9.2).
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import {
  prisma, mkCompany, mkUser, buildApp, caller, setConnector, resetConnectorCache, openDrawer, terminalSettings, ringKheer,
  type Company, type Who,
} from './connectorsFixtures.js'
import { setConnectorClock } from '../src/connectors/registry.js'
import { setFiscalKicker } from '../src/connectors/fiscal/outbox.js'
import { reconcileTerminal, reverseCharge } from '../src/connectors/terminal/service.js'

let app: FastifyInstance
let call: ReturnType<typeof caller>
let A: Company
let cashier: Who, cashier2: Who, manager: Who
let drawer: string
let offset = 0
let n = 0
const key = () => `tmo-${Date.now()}-${n++}`
const charge = (id: string) => prisma.terminalCharge.findUniqueOrThrow({ where: { id } })
const scenario = (s: string) => setConnector(A.tenantId, 'terminal', { settings: { test: { scenario: s } } })
const settle = () => new Promise((r) => setTimeout(r, 1_100))

async function start(orderId?: string): Promise<{ id: string; orderId: string; status: string; amountCents: number; message: string | null }> {
  const o = orderId ?? (await ringKheer(app, cashier, A)).id
  const q = await call(cashier, 'GET', `/pos/orders/${o}/quote?method=card`)
  const r = await call(cashier, 'POST', '/pos/terminal/charges', { orderId: o, shiftId: drawer, terminalId: 'trm-1', expectedDueCents: q.json().dueCents, idempotencyKey: key() })
  expect(r.statusCode, r.body).toBe(201)
  return r.json()
}

beforeAll(async () => {
  setFiscalKicker(async () => {})
  setConnectorClock(() => new Date(Date.now() + offset))
  A = await mkCompany('tmo-a')
  cashier = await mkUser('tmoCashier', 'cashier', A.tenantId)
  cashier2 = await mkUser('tmoCashier2', 'cashier', A.tenantId)
  manager = await mkUser('tmoManager', 'foh_management', A.tenantId)
  await setConnector(A.tenantId, 'terminal', { driver: 'test', enabled: true, settings: terminalSettings(A, 'approve') })
  app = await buildApp()
  call = caller(app)
  drawer = await openDrawer(A, cashier)
}, 60_000)

beforeEach(() => { offset = 0 })

afterAll(async () => {
  setConnectorClock(null)
  setFiscalKicker(null)
  resetConnectorCache()
  await app.close()
})

describe('timeouts and unknown outcomes', () => {
  it('never: past expiresAt the poll cancels and the vendor confirms expired', async () => {
    await scenario('never')
    const c = await start()
    expect(c.status).toBe('sent')
    offset = 121_000
    const r = await call(cashier, 'GET', `/pos/terminal/charges/${c.id}`)
    expect(r.json()).toMatchObject({ status: 'expired', final: true, payment: null })
  })

  it('unknown_start: the reconciler finds the approval and records it', async () => {
    await scenario('unknown_start')
    const c = await start()
    expect(c.status).toBe('unknown')
    offset = 2_000
    await reconcileTerminal()
    const after = await charge(c.id)
    expect(after.status).toBe('recorded')
    expect(await prisma.payment.count({ where: { orderId: c.orderId, gateway: 'card_terminal', status: 'paid' } })).toBe(1)
  })

  it('unknown_start + the cashier said "not charged" and took cash → the late approval is reversed (voided)', async () => {
    await scenario('unknown_start')
    const c = await start()
    const res = await call(cashier, 'POST', `/pos/terminal/charges/${c.id}/resolve`, { outcome: 'not_charged', note: 'machine shows nothing' })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().status).toBe('unverified')
    const cash = await call(cashier, 'POST', '/pos/payments', { orderId: c.orderId, shiftId: drawer, payments: [{ method: 'cash', amountCents: 126_500, tenderedCents: 130_000 }] })
    expect(cash.statusCode, cash.body).toBeLessThan(300)
    offset = 2_000
    await reconcileTerminal()
    const after = await charge(c.id)
    expect(after).toMatchObject({ status: 'voided', refusalCode: 'ALREADY_PAID' })
    expect(await prisma.payment.count({ where: { orderId: c.orderId, status: 'paid' } })).toBe(1)
    expect(await prisma.auditLog.count({ where: { action: 'terminal.resolve', entityId: c.id } })).toBe(1)
  })

  it('late_approve: a cancel that comes too late is recorded, not lost', async () => {
    await scenario('late_approve')
    const c = await start()
    const r = await call(cashier, 'POST', `/pos/terminal/charges/${c.id}/cancel`)
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json().status).toBe('recorded')
    expect(await prisma.payment.count({ where: { orderId: c.orderId, status: 'paid' } })).toBe(1)
  })

  it('void_fails: approved, refused by servd, reversal fails 4 times → needs_attention + terminal_void_failed; a manager marks it refunded', async () => {
    await scenario('void_fails')
    const c = await start()
    await prisma.order.update({ where: { id: c.orderId }, data: { status: 'cancelled' } })
    offset = 2_000
    await settle()
    await call(cashier, 'GET', `/pos/terminal/charges/${c.id}`)
    let after = await charge(c.id)
    expect(after).toMatchObject({ status: 'void_pending', refusalCode: 'ORDER_NOT_OPEN', reverseAttempts: 1 })
    for (const wait of [31_000, 121_000, 601_000]) {
      offset += wait
      await reverseCharge(c.id)
    }
    after = await charge(c.id)
    expect(after).toMatchObject({ status: 'needs_attention', reverseAttempts: 4 })
    const flag = await prisma.exceptionFlag.findFirstOrThrow({ where: { entityId: c.id, kind: 'terminal_void_failed' } })
    expect(flag).toMatchObject({ severity: 'high', tenantId: A.tenantId, amountCents: c.amountCents })
    expect((await call(cashier, 'POST', `/pos/terminal/charges/${c.id}/reverse`, { markRefundedOnMachine: true })).statusCode).toBe(403)
    const m = await call(manager, 'POST', `/pos/terminal/charges/${c.id}/reverse`, { markRefundedOnMachine: true, note: 'refunded on the machine' })
    expect(m.statusCode, m.body).toBe(200)
    expect(m.json().status).toBe('voided')
    expect(await prisma.payment.count({ where: { orderId: c.orderId } })).toBe(0)
  })

  it('offline: TERMINAL_UNREACHABLE (nothing sent) and the manual reference still records the sale', async () => {
    await scenario('offline')
    const c = await start()
    expect(c).toMatchObject({ status: 'cancelled', message: 'TERMINAL_UNREACHABLE' })
    const manual = await call(cashier, 'POST', '/pos/payments', { orderId: c.orderId, shiftId: drawer, payments: [{ method: 'card', amountCents: 118_800, gatewayRef: 'SLIP-4411' }] })
    expect(manual.statusCode, manual.body).toBeLessThan(300)
    expect(await prisma.payment.count({ where: { orderId: c.orderId, status: 'paid', gatewayRef: 'SLIP-4411' } })).toBe(1)
  })

  it('resolve approved_manual, then the processor says declined → needs_attention + terminal_unreconciled', async () => {
    await scenario('unknown_start')
    const c = await start()
    expect((await call(cashier2, 'POST', `/pos/terminal/charges/${c.id}/resolve`, { outcome: 'approved_manual', gatewayRef: 'SLIP-777' })).statusCode).toBe(403)
    const r = await call(cashier, 'POST', `/pos/terminal/charges/${c.id}/resolve`, { outcome: 'approved_manual', gatewayRef: 'SLIP-777' })
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json().status).toBe('manual_resolved')
    const pay = await prisma.payment.findFirstOrThrow({ where: { orderId: c.orderId, status: 'paid' } })
    expect(pay).toMatchObject({ gateway: 'card_terminal', gatewayRef: 'SLIP-777', method: 'card' })
    await scenario('decline')
    offset = 2_000
    await reconcileTerminal()
    await new Promise((res) => setTimeout(res, 300))
    expect((await charge(c.id)).status).toBe('needs_attention')
    expect(await prisma.exceptionFlag.count({ where: { entityId: c.id, kind: 'terminal_unreconciled' } })).toBe(1)
  })

  it('unknown for more than 24 h → needs_attention + terminal_unreconciled', async () => {
    await scenario('unknown_start')
    const c = await start()
    await prisma.terminalCharge.update({ where: { id: c.id }, data: { createdAt: new Date(Date.now() - 25 * 3_600_000) } })
    await reconcileTerminal()
    expect((await charge(c.id)).status).toBe('needs_attention')
    expect(await prisma.exceptionFlag.count({ where: { entityId: c.id, kind: 'terminal_unreconciled' } })).toBe(1)
  })

  it('a split portion is settled through settlePayment', async () => {
    await scenario('approve')
    const o = await ringKheer(app, cashier, A)
    const portion = await prisma.payment.create({ data: { orderId: o.id, method: 'card', amountCents: 126_500, status: 'pending', splitGroup: 1 } })
    const r = await call(cashier, 'POST', '/pos/terminal/charges', { orderId: o.id, shiftId: drawer, terminalId: 'trm-1', expectedDueCents: 126_500, idempotencyKey: key(), paymentId: portion.id })
    expect(r.statusCode, r.body).toBe(201)
    offset = 2_000
    await settle()
    const done = await call(cashier, 'GET', `/pos/terminal/charges/${r.json().id}`)
    expect(done.json()).toMatchObject({ status: 'recorded', payment: { id: portion.id } })
    const p = await prisma.payment.findUniqueOrThrow({ where: { id: portion.id } })
    expect(p).toMatchObject({ status: 'paid', gatewayRef: done.json().approvalRef, shiftId: drawer })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('completed')
  })
})
