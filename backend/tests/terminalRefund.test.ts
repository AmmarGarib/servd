// W1 — refund to the card on the card machine (spec §7.11): referenced
// refund → one negative Payment through refundOrder; unknown waits for the
// reconciler; legacy (non card_terminal) payments keep the manual refund.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import {
  prisma, mkCompany, mkUser, buildApp, caller, setConnector, resetConnectorCache, openDrawer, terminalSettings, ringKheer,
  type Company, type Who,
} from './connectorsFixtures.js'
import { setConnectorClock } from '../src/connectors/registry.js'
import { setFiscalKicker } from '../src/connectors/fiscal/outbox.js'
import { reconcileTerminal } from '../src/connectors/terminal/service.js'
import { testDriverCalls } from '../src/connectors/drivers/test.js'
import { getRefundPolicy, invalidateSetupCache } from '../src/lib/setup-config.js'

let app: FastifyInstance
let call: ReturnType<typeof caller>
let A: Company, B: Company
let cashier: Who, manager: Who, managerB: Who, legacyManager: Who
let drawer: string
let offset = 0
let n = 0
const key = () => `rf-${Date.now()}-${n++}`
let cardPaymentId: string
let saleOrderId: string

async function cardSale(): Promise<{ orderId: string; paymentId: string }> {
  const o = await ringKheer(app, cashier, A)
  const q = await call(cashier, 'GET', `/pos/orders/${o.id}/quote?method=card`)
  const r = await call(cashier, 'POST', '/pos/terminal/charges', { orderId: o.id, shiftId: drawer, terminalId: 'trm-1', expectedDueCents: q.json().dueCents, idempotencyKey: key() })
  offset += 2_000
  await new Promise((res) => setTimeout(res, 1_100))
  const done = await call(cashier, 'GET', `/pos/terminal/charges/${r.json().id}`)
  expect(done.json().status, done.body).toBe('recorded')
  return { orderId: o.id, paymentId: done.json().payment.id }
}

beforeAll(async () => {
  setFiscalKicker(async () => {})
  setConnectorClock(() => new Date(Date.now() + offset))
  A = await mkCompany('rf-a')
  B = await mkCompany('rf-b')
  cashier = await mkUser('rfCashier', 'cashier', A.tenantId)
  manager = await mkUser('rfManager', 'foh_management', A.tenantId)
  managerB = await mkUser('rfManagerB', 'foh_management', B.tenantId)
  legacyManager = await mkUser('rfLegacyManager', 'manager', A.tenantId)
  await setConnector(A.tenantId, 'terminal', { driver: 'test', enabled: true, settings: terminalSettings(A, 'approve') })
  app = await buildApp()
  call = caller(app)
  drawer = await openDrawer(A, cashier)
  const s = await cardSale()
  cardPaymentId = s.paymentId
  saleOrderId = s.orderId
}, 60_000)

afterAll(async () => {
  setConnectorClock(null)
  setFiscalKicker(null)
  resetConnectorCache()
  await app.close()
})

describe('refund to card', () => {
  it('approved referenced refund → ONE negative card Payment through refundOrder; the charge is recorded', async () => {
    const r = await call(manager, 'POST', '/pos/terminal/refunds', { paymentId: cardPaymentId, amountCents: 50_000, terminalId: 'trm-1', idempotencyKey: key(), reason: 'cold food' })
    expect(r.statusCode, r.body).toBe(201)
    expect(r.json()).toMatchObject({ kind: 'refund', status: 'sent', amountCents: 50_000 })
    const refundCharge = await prisma.terminalCharge.findUniqueOrThrow({ where: { id: r.json().id } })
    const original = await prisma.terminalCharge.findFirstOrThrow({ where: { paymentId: cardPaymentId } })
    expect(refundCharge).toMatchObject({ targetPaymentId: cardPaymentId, originalChargeId: original.id, idempotencyKey: expect.stringMatching(/^refund:/) })
    const polled = await call(manager, 'GET', `/pos/terminal/charges/${r.json().id}`)
    expect(polled.json().status, polled.body).toBe('recorded')
    const refunds = await prisma.payment.findMany({ where: { orderId: saleOrderId, status: 'refunded' } })
    expect(refunds).toHaveLength(1)
    expect(refunds[0]).toMatchObject({ method: 'card', amountCents: -50_000 })
    expect(polled.json().payment).toMatchObject({ id: refunds[0]!.id, amountCents: -50_000 })
    // Replay of the same request is the same charge, nothing new.
    const again = await call(manager, 'POST', '/pos/terminal/refunds', { paymentId: cardPaymentId, amountCents: 50_000, terminalId: 'trm-1', idempotencyKey: refundCharge.idempotencyKey.slice('refund:'.length), reason: 'cold food' })
    expect(again.statusCode).toBe(200)
    expect(again.json().id).toBe(refundCharge.id)
  })

  it('more than is left to refund → 409 AMOUNT_EXCEEDS_REFUNDABLE', async () => {
    const r = await call(manager, 'POST', '/pos/terminal/refunds', { paymentId: cardPaymentId, amountCents: 100_000, terminalId: 'trm-1', idempotencyKey: key(), reason: 'whole bill' })
    expect(r.statusCode).toBe(409)
    expect(r.json().error).toMatchObject({ code: 'AMOUNT_EXCEEDS_REFUNDABLE', details: { refundableCents: 68_800 } })
  })

  it('unknown → no Payment until the reconciler confirms it', async () => {
    const r = await call(manager, 'POST', '/pos/terminal/refunds', { paymentId: cardPaymentId, amountCents: 20_000, terminalId: 'trm-1', idempotencyKey: key(), reason: 'missing side' })
    expect(r.statusCode, r.body).toBe(201)
    await prisma.terminalCharge.update({ where: { id: r.json().id }, data: { status: 'unknown' } })
    expect(await prisma.payment.count({ where: { orderId: saleOrderId, status: 'refunded' } })).toBe(1)
    await reconcileTerminal()
    expect((await prisma.terminalCharge.findUniqueOrThrow({ where: { id: r.json().id } })).status).toBe('recorded')
    expect(await prisma.payment.count({ where: { orderId: saleOrderId, status: 'refunded' } })).toBe(2)
  })

  it('a legacy card payment (gateway none) keeps the manual refund: 409 NOT_A_TERMINAL_PAYMENT', async () => {
    const o = await ringKheer(app, cashier, A)
    const p = await call(cashier, 'POST', '/pos/payments', { orderId: o.id, shiftId: drawer, payments: [{ method: 'card', amountCents: 118_800, gatewayRef: 'SLIP-1' }] })
    expect(p.statusCode, p.body).toBeLessThan(300)
    const pay = await prisma.payment.findFirstOrThrow({ where: { orderId: o.id, status: 'paid' } })
    const r = await call(manager, 'POST', '/pos/terminal/refunds', { paymentId: pay.id, amountCents: 10_000, terminalId: 'trm-1', idempotencyKey: key(), reason: 'legacy' })
    expect(r.statusCode).toBe(409)
    expect(r.json().error.code).toBe('NOT_A_TERMINAL_PAYMENT')
  })

  it('cashier → 403; another company\'s manager → 404', async () => {
    expect((await call(cashier, 'POST', '/pos/terminal/refunds', { paymentId: cardPaymentId, amountCents: 1_000, terminalId: 'trm-1', idempotencyKey: key(), reason: 'nope' })).statusCode).toBe(403)
    expect((await call(managerB, 'POST', '/pos/terminal/refunds', { paymentId: cardPaymentId, amountCents: 1_000, terminalId: 'trm-1', idempotencyKey: key(), reason: 'nope' })).statusCode).toBe(404)
  })

  describe('W1-R1: the refund policy is checked BEFORE the machine gives money back', () => {
    const setPolicy = async (data: { managerRefundLimitCents?: number; requirePhotoEvidence?: boolean }) => {
      await getRefundPolicy(A.tenantId)
      await prisma.refundPolicy.updateMany({ where: { tenantId: A.tenantId, scope: 'global' }, data })
      invalidateSetupCache()
    }
    afterAll(async () => { await setPolicy({ managerRefundLimitCents: 500_000, requirePhotoEvidence: false }) })

    it('legacy `manager` (not a refund approver) over the cashier cap → 403; the machine is never asked, no charge row', async () => {
      const before = testDriverCalls.refund
      const rows = await prisma.terminalCharge.count({ where: { kind: 'refund' } })
      const r = await call(legacyManager, 'POST', '/pos/terminal/refunds', { paymentId: cardPaymentId, amountCents: 5_000, terminalId: 'trm-1', idempotencyKey: key(), reason: 'cold food' })
      expect(r.statusCode, r.body).toBe(403)
      expect(r.json().error.code).toBe('MANAGER_OVERRIDE_REQUIRED')
      expect(testDriverCalls.refund).toBe(before)
      expect(await prisma.terminalCharge.count({ where: { kind: 'refund' } })).toBe(rows)
    })

    it('over the manager cap → 403 OVER_CAP, nothing pushed', async () => {
      await setPolicy({ managerRefundLimitCents: 500 })
      const before = testDriverCalls.refund
      const r = await call(manager, 'POST', '/pos/terminal/refunds', { paymentId: cardPaymentId, amountCents: 1_000, terminalId: 'trm-1', idempotencyKey: key(), reason: 'cold food' })
      expect(r.statusCode, r.body).toBe(403)
      expect(r.json().error.code).toBe('OVER_CAP')
      expect(testDriverCalls.refund).toBe(before)
      await setPolicy({ managerRefundLimitCents: 500_000 })
    })

    it('photo evidence required: none → 400 PHOTO_REQUIRED before the machine; with a photo it is refunded AND booked', async () => {
      await setPolicy({ requirePhotoEvidence: true })
      const before = testDriverCalls.refund
      const no = await call(manager, 'POST', '/pos/terminal/refunds', { paymentId: cardPaymentId, amountCents: 1_000, terminalId: 'trm-1', idempotencyKey: key(), reason: 'cold food' })
      expect(no.statusCode, no.body).toBe(400)
      expect(no.json().error.code).toBe('PHOTO_REQUIRED')
      expect(testDriverCalls.refund).toBe(before)
      const booked = await prisma.payment.count({ where: { orderId: saleOrderId, status: 'refunded' } })
      const yes = await call(manager, 'POST', '/pos/terminal/refunds', { paymentId: cardPaymentId, amountCents: 1_000, terminalId: 'trm-1', idempotencyKey: key(), reason: 'cold food', photoUrl: 'https://cdn.servd.pk/evidence/1.jpg' })
      expect(yes.statusCode, yes.body).toBe(201)
      expect(testDriverCalls.refund).toBe(before + 1)
      const polled = await call(manager, 'GET', `/pos/terminal/charges/${yes.json().id}`)
      expect(polled.json().status, polled.body).toBe('recorded')
      expect(await prisma.payment.count({ where: { orderId: saleOrderId, status: 'refunded' } })).toBe(booked + 1)
    })
  })
})
