// Stream T — a cancelled / rejected ticket's CARD money goes back on the card
// machine (LEDGER-R5 hand-back through POST /pos/terminal/refunds), up to what
// the ticket still owes back by card, less refunds done or in flight; managers
// only; exactly once; booked as the hand-back in the ORDER's company; never a
// fiscal document. Completed-sale card refunds are unchanged (terminalRefund suite).
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import {
  prisma, mkCompany, mkUser, buildApp, caller, setConnector, resetConnectorCache, openDrawer, terminalSettings,
  type Company, type Who,
} from './connectorsFixtures.js'
import { setConnectorClock } from '../src/connectors/registry.js'
import { setFiscalKicker } from '../src/connectors/fiscal/outbox.js'
import { testDriverCalls } from '../src/connectors/drivers/test.js'
import { refundOrder, inFlightTerminalRefundCents } from '../src/modules/pos/service.js'
import { recordApprovedCharge } from '../src/connectors/terminal/service.js'

// The admin till's REAL offer rule (tillApi cancelledCardRefundOffer) runs
// against the REAL server answers — only the browser API client is mocked.
vi.mock('../../frontend/admin/src/lib/api.ts', () => ({
  api: { get: vi.fn(), post: vi.fn() },
  ApiError: class ApiError extends Error { status = 0; code: string | null = null },
}))
const till = await import('../../frontend/admin/src/components/pos/tillApi.ts')

let app: FastifyInstance
let call: ReturnType<typeof caller>
let A: Company, B: Company
let cashier: Who, manager: Who, managerB: Who
let drawer: string
let n = 0
const key = () => `cc-${Date.now()}-${n++}`

/**
 * A till ticket that took `cardCents` on the card machine (and `cashCents` in
 * cash) on the drawer, then was cancelled (or rejected) before its full & final bill.
 */
async function cancelledCardTicket(opts: { cardCents: number; cashCents?: number; status?: 'cancelled' | 'rejected' | 'completed'; co?: Company; shiftId?: string; by?: Who }) {
  const co = opts.co ?? A
  const shiftId = opts.shiftId ?? drawer
  const by = opts.by ?? cashier
  const total = opts.cardCents + (opts.cashCents ?? 0)
  const order = await prisma.order.create({
    data: {
      conceptId: co.conceptId, locationId: co.locationId, source: 'pos', fulfilmentType: 'takeout', status: 'received',
      totalCents: total, taxCents: Math.round(total * 8 / 108), taxRatePct: 8, shiftId,
      items: { create: [{ menuItemId: co.items.kheer, name: 'Kheer', quantity: 2, unitPriceCents: 55_000 }] },
    },
  })
  const conn = await prisma.posConnector.findUniqueOrThrow({ where: { tenantId_kind: { tenantId: co.tenantId, kind: 'terminal' } } })
  const charge = await prisma.terminalCharge.create({
    data: {
      tenantId: co.tenantId, kind: 'charge', connectorId: conn.id, terminalId: 'trm-1', orderId: order.id, shiftId,
      amountCents: opts.cardCents, tipCents: 0, quoteDueCents: opts.cardCents, idempotencyKey: `seed-${key()}`,
      status: 'recorded', expiresAt: new Date(Date.now() + 60_000), createdById: by.id, approvalRef: `APR-${n}`,
    },
  })
  const pay = await prisma.payment.create({
    data: {
      orderId: order.id, shiftId, method: 'card', amountCents: opts.cardCents, status: 'paid', processedAt: new Date(),
      gateway: 'card_terminal', gatewayRef: `APR-${n}`, gatewayMeta: { terminalChargeId: charge.id },
    },
  })
  await prisma.terminalCharge.update({ where: { id: charge.id }, data: { paymentId: pay.id } })
  if (opts.cashCents) {
    await prisma.payment.create({ data: { orderId: order.id, shiftId, method: 'cash', amountCents: opts.cashCents, status: 'paid', processedAt: new Date() } })
  }
  await prisma.order.update({ where: { id: order.id }, data: { status: opts.status ?? 'cancelled' } })
  return { orderId: order.id, paymentId: pay.id, chargeId: charge.id }
}

const refundBody = (paymentId: string, amountCents: number, idempotencyKey = key()) =>
  ({ paymentId, amountCents, terminalId: 'trm-1', idempotencyKey, reason: 'Ticket cancelled — guest left' })

async function settle(chargeId: string) {
  const r = await call(manager, 'GET', `/pos/terminal/charges/${chargeId}`)
  expect(r.statusCode, r.body).toBe(200)
  return r.json()
}

async function refundRows(orderId: string) {
  return prisma.payment.findMany({ where: { orderId, status: 'refunded' }, orderBy: { createdAt: 'asc' } })
}

async function entryOf(refundPaymentId: string) {
  return prisma.journalEntry.findFirst({
    where: { reference: `order.refund:${refundPaymentId}` },
    include: { lines: { include: { account: { select: { code: true, tenantId: true } } } } },
  })
}

beforeAll(async () => {
  setFiscalKicker(async () => {})
  setConnectorClock(null)
  A = await mkCompany('cc-a')
  B = await mkCompany('cc-b')
  cashier = await mkUser('ccCashier', 'cashier', A.tenantId)
  manager = await mkUser('ccManager', 'foh_management', A.tenantId)
  managerB = await mkUser('ccManagerB', 'foh_management', B.tenantId)
  await setConnector(A.tenantId, 'terminal', { driver: 'test', enabled: true, settings: terminalSettings(A, 'approve') })
  await setConnector(B.tenantId, 'terminal', { driver: 'test', enabled: true, settings: terminalSettings(B, 'approve') })
  // Fiscal reporting ON for A, so "no fiscal document" is the cancelled-ticket rule, not a switched-off company.
  await setConnector(A.tenantId, 'fiscal', { driver: 'test', enabled: true, settings: {} })
  app = await buildApp()
  call = caller(app)
  drawer = await openDrawer(A, cashier)
}, 60_000)

afterAll(async () => {
  setConnectorClock(null)
  setFiscalKicker(null)
  resetConnectorCache()
  await app.close()
})

describe('refund a cancelled ticket\'s card payment on the card machine', () => {
  it('a manager refunds part of it to the card: booked ONCE as the LEDGER-R5 hand-back in the order\'s company, no fiscal document, the ticket stays cancelled', async () => {
    const t = await cancelledCardTicket({ cardCents: 118_800 })
    const before = testDriverCalls.refund
    const r = await call(manager, 'POST', '/pos/terminal/refunds', refundBody(t.paymentId, 50_000))
    expect(r.statusCode, r.body).toBe(201)
    expect(r.json()).toMatchObject({ kind: 'refund', status: 'sent', amountCents: 50_000, targetPaymentId: t.paymentId })
    expect(testDriverCalls.refund).toBe(before + 1)
    const done = await settle(r.json().id)
    expect(done.status, JSON.stringify(done)).toBe('recorded')
    expect(done.fiscal).toBeNull()

    const rows = await refundRows(t.orderId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ method: 'card', amountCents: -50_000, gateway: 'card_terminal' })
    expect((rows[0]!.gatewayMeta as { terminalChargeId?: string }).terminalChargeId).toBe(r.json().id)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: t.orderId } })).status).toBe('cancelled')

    // Dr 1110 refund due / Cr 1030 card — balanced, every account A's, nothing in B.
    const entry = await entryOf(rows[0]!.id)
    expect(entry).not.toBeNull()
    expect(entry!.tenantId).toBe(A.tenantId)
    const dr = entry!.lines.filter((l) => l.type === 'debit').reduce((s, l) => s + l.amountCents, 0)
    const cr = entry!.lines.filter((l) => l.type === 'credit').reduce((s, l) => s + l.amountCents, 0)
    expect(dr).toBe(cr)
    expect(dr).toBe(50_000)
    expect(entry!.lines.every((l) => l.account.tenantId === A.tenantId)).toBe(true)
    expect(entry!.lines.map((l) => `${l.type}:${l.account.code}`).sort()).toEqual(['credit:1030', 'debit:1110'])
    expect(await prisma.journalEntry.count({ where: { tenantId: B.tenantId, reference: { contains: t.orderId } } })).toBe(0)

    // Never a fiscal document: a ticket cancelled before the FnF bill sends nothing to the POS.
    expect(await prisma.fiscalDocument.count({ where: { orderId: t.orderId } })).toBe(0)
    // The hand-back's own audit, naming the machine refund.
    const audit = await prisma.auditLog.findFirst({ where: { action: 'order_refund_due', entityId: t.orderId } })
    expect(audit?.tenantId).toBe(A.tenantId)
    expect((audit?.metadata as { terminalChargeId?: string } | null)?.terminalChargeId).toBe(r.json().id)
  })

  it('works for a rejected ticket too', async () => {
    const t = await cancelledCardTicket({ cardCents: 30_000, status: 'rejected' })
    const r = await call(manager, 'POST', '/pos/terminal/refunds', refundBody(t.paymentId, 30_000))
    expect(r.statusCode, r.body).toBe(201)
    expect((await settle(r.json().id)).status).toBe('recorded')
    expect((await refundRows(t.orderId)).map((p) => p.amountCents)).toEqual([-30_000])
    expect(await prisma.fiscalDocument.count({ where: { orderId: t.orderId } })).toBe(0)
  })

  it('over-refund refused before the machine moves money: more than the card took, and more than is still owed back', async () => {
    const t = await cancelledCardTicket({ cardCents: 60_000, cashCents: 40_000 })
    const before = testDriverCalls.refund
    // More than this card payment.
    const over = await call(manager, 'POST', '/pos/terminal/refunds', refundBody(t.paymentId, 60_001))
    expect(over.statusCode, over.body).toBe(409)
    expect(over.json().error.code).toBe('AMOUNT_EXCEEDS_REFUNDABLE')

    // 50,000 of the card already handed back by the record-only path: only 10,000 is still owed back by card.
    const rec = await call(manager, 'POST', `/pos/orders/${t.orderId}/refund`, { amountCents: 50_000, reason: 'Recorded hand-back', method: 'card' })
    expect(rec.statusCode, rec.body).toBe(200)
    const tooMuch = await call(manager, 'POST', '/pos/terminal/refunds', refundBody(t.paymentId, 10_001))
    expect(tooMuch.statusCode, tooMuch.body).toBe(409)
    expect(tooMuch.json().error.code).toBe('AMOUNT_EXCEEDS_REFUNDABLE')
    expect(testDriverCalls.refund).toBe(before)
    expect(await prisma.terminalCharge.count({ where: { orderId: t.orderId, kind: 'refund' } })).toBe(0)

    // The cash taken is not the card's to give back; the rest of the card is.
    const ok = await call(manager, 'POST', '/pos/terminal/refunds', refundBody(t.paymentId, 10_000))
    expect(ok.statusCode, ok.body).toBe(201)
    expect((await settle(ok.json().id)).status).toBe('recorded')
    const nothing = await call(manager, 'POST', '/pos/terminal/refunds', refundBody(t.paymentId, 1))
    expect(nothing.statusCode).toBe(409)
    expect(nothing.json().error.code).toBe('AMOUNT_EXCEEDS_REFUNDABLE')
  })

  it('a machine refund in flight is counted: the record-only hand-back cannot give the same card money back, and vice versa', async () => {
    const t = await cancelledCardTicket({ cardCents: 80_000 })
    const r = await call(manager, 'POST', '/pos/terminal/refunds', refundBody(t.paymentId, 80_000))
    expect(r.statusCode, r.body).toBe(201)
    expect(r.json().status).toBe('sent')
    // In flight: the whole card amount is on its way back to the card.
    const rec = await call(manager, 'POST', `/pos/orders/${t.orderId}/refund`, { amountCents: 1_000, reason: 'Recorded hand-back', method: 'card' })
    expect(rec.statusCode, rec.body).toBe(422)
    expect(rec.json().error.code).toBe('NOTHING_TO_REFUND')
    // A second machine refund on the same payment is refused too.
    const second = await call(manager, 'POST', '/pos/terminal/refunds', refundBody(t.paymentId, 1_000))
    expect(second.statusCode).toBe(409)
    expect(second.json().error.code).toBe('AMOUNT_EXCEEDS_REFUNDABLE')

    expect((await settle(r.json().id)).status).toBe('recorded')
    expect((await refundRows(t.orderId)).map((p) => p.amountCents)).toEqual([-80_000])
    const after = await call(manager, 'POST', `/pos/orders/${t.orderId}/refund`, { amountCents: 1_000, reason: 'Recorded hand-back', method: 'card' })
    expect(after.statusCode).toBe(422)
    expect(after.json().error.code).toBe('NOTHING_TO_REFUND')
  })

  it('a concurrent double click refunds ONCE — same key or a fresh key per click', async () => {
    const t = await cancelledCardTicket({ cardCents: 70_000 })
    const before = testDriverCalls.refund
    const k = key()
    const [a, b] = await Promise.all([
      call(manager, 'POST', '/pos/terminal/refunds', refundBody(t.paymentId, 70_000, k)),
      call(manager, 'POST', '/pos/terminal/refunds', refundBody(t.paymentId, 70_000, k)),
    ])
    expect([a.statusCode, b.statusCode].sort(), `${a.body} ${b.body}`).toEqual([200, 201])
    expect(a.json().id).toBe(b.json().id)
    expect(testDriverCalls.refund).toBe(before + 1)

    // Two clicks that each minted a key: the second finds the first in flight.
    const t2 = await cancelledCardTicket({ cardCents: 70_000 })
    const [c, d] = await Promise.all([
      call(manager, 'POST', '/pos/terminal/refunds', refundBody(t2.paymentId, 70_000)),
      call(manager, 'POST', '/pos/terminal/refunds', refundBody(t2.paymentId, 70_000)),
    ])
    expect([c.statusCode, d.statusCode].sort(), `${c.body} ${d.body}`).toEqual([201, 409])
    expect(testDriverCalls.refund).toBe(before + 2)

    for (const [orderId, chargeId] of [[t.orderId, a.json().id], [t2.orderId, (c.statusCode === 201 ? c : d).json().id]] as const) {
      expect((await settle(chargeId)).status).toBe('recorded')
      expect((await refundRows(orderId)).map((p) => p.amountCents)).toEqual([-70_000])
      expect(await prisma.journalEntry.count({ where: { reference: `order.refund:${(await refundRows(orderId))[0]!.id}` } })).toBe(1)
    }
  })

  it('booking the same machine refund twice (a lapsed record lease) returns the first row — never a second hand-back', async () => {
    const t = await cancelledCardTicket({ cardCents: 40_000 })
    const r = await call(manager, 'POST', '/pos/terminal/refunds', refundBody(t.paymentId, 40_000))
    expect((await settle(r.json().id)).status).toBe('recorded')
    const [row] = await refundRows(t.orderId)
    const again = await refundOrder({
      orderId: t.orderId, amountCents: 40_000, reason: 'replay', actorId: manager.id, actorRole: manager.role,
      method: 'card', gateway: 'card_terminal', gatewayRef: 'APR', terminalChargeId: r.json().id,
    })
    expect(again.id).toBe(row!.id)
    expect(await refundRows(t.orderId)).toHaveLength(1)
    expect(await prisma.journalEntry.count({ where: { reference: `order.refund:${row!.id}` } })).toBe(1)
  })

  it('company separation and roles: B\'s manager gets 404 on A\'s ticket; a cashier gets 403; nothing is pushed', async () => {
    const t = await cancelledCardTicket({ cardCents: 20_000 })
    const before = testDriverCalls.refund
    const foreign = await call(managerB, 'POST', '/pos/terminal/refunds', refundBody(t.paymentId, 1_000))
    expect(foreign.statusCode).toBe(404)
    const cash = await call(cashier, 'POST', '/pos/terminal/refunds', refundBody(t.paymentId, 1_000))
    expect(cash.statusCode).toBe(403)
    expect(testDriverCalls.refund).toBe(before)
    expect(await prisma.terminalCharge.count({ where: { orderId: t.orderId, kind: 'refund' } })).toBe(0)

    // B's own ticket: B's manager refunds it, booked in B's books only.
    const cashierB = await mkUser('ccCashierB', 'cashier', B.tenantId)
    const drawerB = await openDrawer(B, cashierB)
    const tb = await cancelledCardTicket({ cardCents: 15_000, co: B, shiftId: drawerB, by: cashierB })
    expect((await call(manager, 'POST', '/pos/terminal/refunds', refundBody(tb.paymentId, 1_000))).statusCode).toBe(404)
    const okB = await call(managerB, 'POST', '/pos/terminal/refunds', refundBody(tb.paymentId, 15_000))
    expect(okB.statusCode, okB.body).toBe(201)
    const doneB = await call(managerB, 'GET', `/pos/terminal/charges/${okB.json().id}`)
    expect(doneB.json().status, doneB.body).toBe('recorded')
    const [rowB] = await refundRows(tb.orderId)
    const entryB = await entryOf(rowB!.id)
    expect(entryB!.tenantId).toBe(B.tenantId)
    expect(entryB!.lines.every((l) => l.account.tenantId === B.tenantId)).toBe(true)
  })

  it('an open (not cancelled, not completed) ticket is still refused NOT_REFUNDABLE', async () => {
    const t = await cancelledCardTicket({ cardCents: 10_000 })
    await prisma.order.update({ where: { id: t.orderId }, data: { status: 'received' } })
    const r = await call(manager, 'POST', '/pos/terminal/refunds', refundBody(t.paymentId, 1_000))
    expect(r.statusCode).toBe(409)
    expect(r.json().error.code).toBe('NOT_REFUNDABLE')
  })

  it('the till\'s "Refund to card" offer matches the server: its most is accepted, one paisa more is refused', async () => {
    const t = await cancelledCardTicket({ cardCents: 90_000, cashCents: 25_000 })
    const offerNow = async (terminalEnabled = true) => {
      const [order, charges] = await Promise.all([
        prisma.order.findUniqueOrThrow({ where: { id: t.orderId }, include: { payments: true } }),
        call(manager, 'GET', `/pos/terminal/charges?orderId=${t.orderId}`),
      ])
      expect(charges.statusCode, charges.body).toBe(200)
      return till.cancelledCardRefundOffer({ status: order.status, payments: order.payments, charges: charges.json(), terminalEnabled })
    }
    expect(await offerNow()).toEqual({ paymentId: t.paymentId, maxCents: 90_000 })
    expect(await offerNow(false)).toBeNull()

    // 30,000 handed back by card (record-only), 20,000 in flight on the machine.
    expect((await call(manager, 'POST', `/pos/orders/${t.orderId}/refund`, { amountCents: 30_000, reason: 'Recorded hand-back', method: 'card' })).statusCode).toBe(200)
    const fly = await call(manager, 'POST', '/pos/terminal/refunds', refundBody(t.paymentId, 20_000))
    expect(fly.statusCode, fly.body).toBe(201)
    const offer = await offerNow()
    expect(offer).toEqual({ paymentId: t.paymentId, maxCents: 40_000 })
    const over = await call(manager, 'POST', '/pos/terminal/refunds', refundBody(t.paymentId, offer!.maxCents + 1))
    expect(over.statusCode).toBe(409)
    const ok = await call(manager, 'POST', '/pos/terminal/refunds', refundBody(t.paymentId, offer!.maxCents))
    expect(ok.statusCode, ok.body).toBe(201)
    expect(await offerNow()).toBeNull()
    expect((await settle(fly.json().id)).status).toBe('recorded')
    expect((await settle(ok.json().id)).status).toBe('recorded')
    expect(await offerNow()).toBeNull()
    // The cash is still owed back — by cash, from a drawer, not on the machine.
    const order = await prisma.order.findUniqueOrThrow({ where: { id: t.orderId }, include: { payments: true } })
    expect(order.payments.filter((p) => p.status === 'refunded').reduce((s, p) => s + p.amountCents, 0)).toBe(-90_000)

    // A completed sale or a cash-only ticket is never offered here.
    expect(till.cancelledCardRefundOffer({ status: 'completed', payments: order.payments, charges: [], terminalEnabled: true })).toBeNull()
    expect(till.cancelledCardRefundOffer({
      status: 'cancelled', terminalEnabled: true, charges: [],
      payments: [{ id: 'p1', method: 'cash', amountCents: 10_000, status: 'paid', shiftId: drawer, gateway: 'none' }],
    })).toBeNull()
  })
})

// T-RV-1: recordApprovedCharge commits a machine refund's Payment, and only
// AFTER that stamps the charge recorded / paymentId. A second booking that
// waited on the order lock wakes inside that gap; it used to count the first
// refund twice (booked AND in flight) and refuse money the machine had
// already given back (needs_attention, "Card refund given but not booked").
describe('a machine refund booked but not yet stamped is counted once (T-RV-1)', () => {
  /** Start a machine refund and leave it approved (the machine said yes; nothing booked yet). */
  async function approvedRefund(paymentId: string, amountCents: number): Promise<string> {
    const r = await call(manager, 'POST', '/pos/terminal/refunds', refundBody(paymentId, amountCents))
    expect(r.statusCode, r.body).toBe(201)
    await prisma.terminalCharge.update({ where: { id: r.json().id }, data: { status: 'approved', approvalRef: `APR-RV-${n++}`, nextActionAt: null } })
    return r.json().id as string
  }
  /** What recordApprovedCharge's booking transaction commits, without the stamp that follows it. */
  async function bookOnly(orderId: string, chargeId: string, amountCents: number) {
    return refundOrder({
      orderId, amountCents, reason: 'Ticket cancelled — guest left', actorId: manager.id, actorRole: manager.role,
      method: 'card', gateway: 'card_terminal', gatewayRef: `APR-${chargeId}`, terminalChargeId: chargeId,
    })
  }

  it('cancelled ticket: R1 booked, its charge still approved — R2 books too, both recorded, the ticket fully handed back once', async () => {
    const t = await cancelledCardTicket({ cardCents: 80_000 })
    const r1 = await approvedRefund(t.paymentId, 40_000)
    const r2 = await approvedRefund(t.paymentId, 40_000)
    await bookOnly(t.orderId, r1, 40_000)
    // The gap: R1 has its refund Payment, its charge still reads approved / paymentId null.
    expect(await prisma.terminalCharge.findUniqueOrThrow({ where: { id: r1 } })).toMatchObject({ status: 'approved', paymentId: null })
    expect(await inFlightTerminalRefundCents(prisma, t.orderId)).toBe(40_000) // R2 only — R1 is booked
    expect(await inFlightTerminalRefundCents(prisma, t.orderId, { exceptChargeId: r2 })).toBe(0)

    const second = await recordApprovedCharge(r2)
    expect(second?.status, JSON.stringify(second)).toBe('recorded')
    expect(second?.refusalCode ?? null).toBeNull()
    const first = await recordApprovedCharge(r1) // the stamp catches up: finds its own row
    expect(first?.status).toBe('recorded')

    const rows = await refundRows(t.orderId)
    expect(rows.map((p) => p.amountCents)).toEqual([-40_000, -40_000])
    expect(new Set(rows.map((p) => (p.gatewayMeta as { terminalChargeId?: string }).terminalChargeId))).toEqual(new Set([r1, r2]))
    for (const row of rows) expect(await prisma.journalEntry.count({ where: { reference: `order.refund:${row.id}` } })).toBe(1)
    expect(await prisma.fiscalDocument.count({ where: { orderId: t.orderId } })).toBe(0)
    // Nothing more goes back: the ticket owes nothing.
    const after = await call(manager, 'POST', `/pos/orders/${t.orderId}/refund`, { amountCents: 1, reason: 'Recorded hand-back', method: 'card' })
    expect(after.json().error.code).toBe('NOTHING_TO_REFUND')
  })

  it('inside the gap a legitimate start or record-only hand-back is not refused (R1 is counted once)', async () => {
    const t = await cancelledCardTicket({ cardCents: 100_000 })
    const r1 = await approvedRefund(t.paymentId, 40_000)
    await bookOnly(t.orderId, r1, 40_000)
    // 60,000 is still owed back by card: a record-only hand-back of 10,000 and a machine refund of the other 50,000.
    const rec = await call(manager, 'POST', `/pos/orders/${t.orderId}/refund`, { amountCents: 10_000, reason: 'Recorded hand-back', method: 'card' })
    expect(rec.statusCode, rec.body).toBe(200)
    const over = await call(manager, 'POST', '/pos/terminal/refunds', refundBody(t.paymentId, 50_001))
    expect(over.statusCode, over.body).toBe(409)
    const ok = await call(manager, 'POST', '/pos/terminal/refunds', refundBody(t.paymentId, 50_000))
    expect(ok.statusCode, ok.body).toBe(201)
    expect((await settle(ok.json().id)).status).toBe('recorded')
    expect((await recordApprovedCharge(r1))?.status).toBe('recorded')
    expect((await refundRows(t.orderId)).reduce((s, p) => s + p.amountCents, 0)).toBe(-100_000)
  })

  it('two approved refunds booked at the same time on one cancelled ticket: both recorded, never needs_attention', async () => {
    for (let i = 0; i < 4; i++) {
      const t = await cancelledCardTicket({ cardCents: 80_000 })
      const ids = [await approvedRefund(t.paymentId, 40_000), await approvedRefund(t.paymentId, 40_000)]
      const out = await Promise.all(ids.map((id) => recordApprovedCharge(id)))
      // A booking whose record lease was held by the other caller returns early; settle it.
      const final = await Promise.all(ids.map(async (id, k) => out[k]?.status === 'recorded' ? out[k] : recordApprovedCharge(id)))
      expect(final.map((c) => c?.status), JSON.stringify(final.map((c) => [c?.status, c?.refusalCode]))).toEqual(['recorded', 'recorded'])
      expect((await refundRows(t.orderId)).map((p) => p.amountCents)).toEqual([-40_000, -40_000])
    }
  })

  it('completed sale: the same gap on the sale-refund path books R2 too', async () => {
    const t = await cancelledCardTicket({ cardCents: 80_000, status: 'completed' })
    const r1 = await approvedRefund(t.paymentId, 40_000)
    const r2 = await approvedRefund(t.paymentId, 40_000)
    await bookOnly(t.orderId, r1, 40_000)
    expect((await recordApprovedCharge(r2))?.status).toBe('recorded')
    expect((await recordApprovedCharge(r1))?.status).toBe('recorded')
    expect((await refundRows(t.orderId)).map((p) => p.amountCents)).toEqual([-40_000, -40_000])
  })

  it('B\'s booked refunds never change A\'s in-flight count', async () => {
    const cashierB = await mkUser('ccRvCashierB', 'cashier', B.tenantId)
    const drawerB = await openDrawer(B, cashierB)
    const tb = await cancelledCardTicket({ cardCents: 30_000, co: B, shiftId: drawerB, by: cashierB })
    const ta = await cancelledCardTicket({ cardCents: 30_000 })
    const ra = await approvedRefund(ta.paymentId, 30_000)
    const okB = await call(managerB, 'POST', '/pos/terminal/refunds', refundBody(tb.paymentId, 30_000))
    expect(okB.statusCode, okB.body).toBe(201)
    expect((await call(managerB, 'GET', `/pos/terminal/charges/${okB.json().id}`)).json().status).toBe('recorded')
    expect(await inFlightTerminalRefundCents(prisma, ta.orderId)).toBe(30_000)
    expect((await recordApprovedCharge(ra))?.status).toBe('recorded')
  })
})

// T-RV-2: the shift's Z report lists the cancelled tickets (so the per-ticket
// "Refund to card" rows render) and how much card money on them is still
// owed back (so the box hides once it has all gone back).
describe('Z report: cancelled tickets and the card still owed back (T-RV-2)', () => {
  it('lists the cancelled tickets, card still owed falls as it goes back; the screen\'s rule follows it', async () => {
    const zCashier = await mkUser('ccZCashier', 'cashier', A.tenantId)
    const zDrawer = await openDrawer(A, zCashier)
    const t1 = await cancelledCardTicket({ cardCents: 50_000, cashCents: 5_000, shiftId: zDrawer, by: zCashier })
    const t2 = await cancelledCardTicket({ cardCents: 20_000, shiftId: zDrawer, by: zCashier })
    const z = async () => {
      const r = await call(manager, 'GET', `/pos/shifts/${zDrawer}/zreport`)
      expect(r.statusCode, r.body).toBe(200)
      return r.json().cancelledPaid as { count: number; cashCents: number; cardCents: number; orderIds: string[]; cardOwedCents: number }
    }
    let cp = await z()
    expect(new Set(cp.orderIds)).toEqual(new Set([t1.orderId, t2.orderId]))
    expect(cp).toMatchObject({ count: 2, cardCents: 70_000, cashCents: 5_000, cardOwedCents: 70_000 })
    expect(till.cancelledCardStillOwed(cp)).toBe(true)

    const r = await call(manager, 'POST', '/pos/terminal/refunds', refundBody(t1.paymentId, 50_000))
    expect((await settle(r.json().id)).status).toBe('recorded')
    expect((await call(manager, 'POST', `/pos/orders/${t2.orderId}/refund`, { amountCents: 20_000, reason: 'Recorded hand-back', method: 'card' })).statusCode).toBe(200)
    cp = await z()
    // Gross card taken is unchanged; none of it is owed back any more (the cash still is).
    expect(cp).toMatchObject({ cardCents: 70_000, cardOwedCents: 0 })
    expect(till.cancelledCardStillOwed(cp)).toBe(false)

    // B's manager cannot read A's drawer.
    expect((await call(managerB, 'GET', `/pos/shifts/${zDrawer}/zreport`)).statusCode).toBe(404)
    // An older API (no cardOwedCents) falls back to card taken.
    expect(till.cancelledCardStillOwed({ count: 1, cashCents: 0, cardCents: 1 })).toBe(true)
    expect(till.cancelledCardStillOwed({ count: 1, cashCents: 9, cardCents: 0 })).toBe(false)
    expect(till.cancelledCardStillOwed(undefined)).toBe(false)
  })
})
