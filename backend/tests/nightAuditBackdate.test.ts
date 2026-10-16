// CEO-only undo of a BACK-DATED sale (owner, 2026-10-16 (c), sales module
// only): voiding a line, comping, cancelling, rejecting, reversing the card
// payment of, or credit-noting a bill from an earlier sales day (final on an
// earlier day, or on a night-audited day) needs the CEO — signed in or as the
// manager-PIN approver — with a reason; a manager gets 403
// CEO_ONLY_BACKDATED, the CEO without a reason 422 BACKDATED_REASON_REQUIRED.
// The CEO's change is audited ('sales.backdated.<action>') and flagged
// ('backdated_sale_change'). Today's bills, an open ticket over midnight on a
// day not audited, and refunds (Q5) keep the normal manager rules. Company
// scope comes first (B → 404 on A's order). No sales route takes a date.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { AppError, errorResponse } from '../src/lib/errors.js'
import { posRoutes } from '../src/modules/pos/routes.js'
import { orderRoutes } from '../src/modules/orders/routes.js'
import { expoRoutes } from '../src/modules/expo/routes.js'
import { invoiceRoutes } from '../src/modules/invoices/routes.js'
import { registerConnectorPlugins } from '../src/modules/connectors/index.js'
import { registerPreBillPlugins } from '../src/modules/prebills/index.js'
import { setManagerPin } from '../src/modules/auth/managerPin.js'
import { setFiscalKicker } from '../src/connectors/fiscal/outbox.js'
import { issueInvoiceForOrder } from '../src/modules/invoices/service.js'
import { fmtPktDate } from '../src/modules/accounting/dates.js'
import { prisma, mkCompany, mkUser, caller, openDrawer, resetConnectorCache, type Company, type Who } from './connectorsFixtures.js'

let app: FastifyInstance
let A: Company, B: Company
let cashierA: Who, mgrA: Who, ceo: Who, mgrB: Who
const PIN_A = '5821'
const DAY_MS = 86_400_000
const yesterday = fmtPktDate(new Date(Date.now() - DAY_MS))
const today = fmtPktDate(new Date())
const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00+05:00`)

const call = (...args: Parameters<ReturnType<typeof caller>>) => caller(app)(...args)

async function ticket(who: Who, co: Company, placedAt?: Date) {
  const r = await call(who, 'POST', '/pos/orders', {
    conceptId: co.conceptId,
    items: [
      { menuItemId: co.items.kheer, name: 'Kheer', quantity: 1, unitPriceCents: 55_000, modifiers: [] },
      { menuItemId: co.items.water, name: 'Water', quantity: 1, unitPriceCents: 10_000, modifiers: [] },
    ],
  })
  if (r.statusCode !== 201) throw new Error(`ring failed ${r.statusCode} ${r.body}`)
  const o = r.json() as { id: string; items: Array<{ id: string }> }
  if (placedAt) await prisma.order.update({ where: { id: o.id }, data: { placedAt } })
  return o
}

/** A bill completed (and paid in cash) yesterday at company A. */
async function oldBill(extra: Record<string, unknown> = {}) {
  return prisma.order.create({
    data: {
      conceptId: A.conceptId, locationId: A.locationId, source: 'pos', fulfilmentType: 'takeout', status: 'completed',
      totalCents: 63_250, taxCents: 8_250, placedAt: at(yesterday, '13:00'), completedAt: at(yesterday, '13:20'),
      items: { create: [{ menuItemId: A.items.kheer, name: 'Kheer', quantity: 1, unitPriceCents: 55_000 }] },
      ...extra,
    } as never,
  })
}

const expectCeoOnly = (r: { statusCode: number; json(): { error: { code: string; details?: { day?: string; action?: string } } } }, action: string) => {
  expect(r.statusCode).toBe(403)
  expect(r.json().error.code).toBe('CEO_ONLY_BACKDATED')
  expect(r.json().error.details).toMatchObject({ day: yesterday, action })
}

const audited = (action: string, orderId: string) => prisma.auditLog.count({ where: { action: `sales.backdated.${action}`, entityId: orderId, tenantId: A.tenantId } })
const flagged = (orderId: string) => prisma.exceptionFlag.count({ where: { kind: 'backdated_sale_change', entityId: orderId, tenantId: A.tenantId, severity: 'high' } })

beforeAll(async () => {
  A = await mkCompany('nab-a')
  B = await mkCompany('nab-b')
  cashierA = await mkUser('nab-cashier-a', 'cashier', A.tenantId)
  mgrA = await mkUser('nab-mgr-a', 'foh_management', A.tenantId)
  ceo = await mkUser('nab-ceo', 'admin', A.tenantId)
  mgrB = await mkUser('nab-mgr-b', 'foh_management', B.tenantId)
  await setManagerPin(mgrA.id, PIN_A)
  // Yesterday is night-audited at A (not at B).
  await prisma.nightAuditDay.create({ data: { tenantId: A.tenantId, businessDate: yesterday, status: 'audited', auditedAt: new Date(), auditedById: ceo.id } })
  setFiscalKicker(async () => {})
  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode
    if (status && status >= 400 && status < 500) return reply.status(status).send({ error: { code: 'BAD_REQUEST', message: (err as Error).message } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(posRoutes, { prefix: '/pos' })
  await app.register(orderRoutes, { prefix: '/orders' })
  await app.register(expoRoutes, { prefix: '/expo' })
  await app.register(invoiceRoutes, { prefix: '/invoices' })
  await registerConnectorPlugins(app)
  await registerPreBillPlugins(app)
  await app.ready()
}, 60_000)

afterAll(async () => {
  setFiscalKicker(null)
  resetConnectorCache()
  await app?.close()
})

describe('item void of a ticket from a night-audited day', () => {
  it('manager 403, cashier + manager PIN 403, CEO without a reason 422, CEO with a reason 200 — audited and flagged', async () => {
    const o = await ticket(cashierA, A, at(yesterday, '23:50'))
    const url = `/pos/orders/${o.id}/void`
    const body = { orderItemId: o.items[0]!.id, reason: 'wrong item' }
    expectCeoOnly(await call(mgrA, 'POST', url, body), 'item_void')
    expectCeoOnly(await call(cashierA, 'POST', url, { ...body, managerOverridePin: PIN_A }), 'item_void')
    const noReason = await call(ceo, 'POST', url, body)
    expect(noReason.statusCode).toBe(422)
    expect(noReason.json().error.code).toBe('BACKDATED_REASON_REQUIRED')
    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: o.items[0]!.id } })).voidedAt).toBeNull()
    const ok = await call(ceo, 'POST', url, { ...body, backdatedReason: 'Guest never got the kheer' })
    expect(ok.statusCode, ok.body).toBe(200)
    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: o.items[0]!.id } })).voidedAt).not.toBeNull()
    expect(await audited('item_void', o.id)).toBe(1)
    expect(await flagged(o.id)).toBe(1)
  })

  it('company B\'s manager gets 404 on A\'s back-dated ticket (scope first)', async () => {
    const o = await ticket(cashierA, A, at(yesterday, '22:00'))
    const r = await call(mgrB, 'POST', `/pos/orders/${o.id}/void`, { orderItemId: o.items[0]!.id, reason: 'wrong item' })
    expect(r.statusCode).toBe(404)
  })

  it('today\'s ticket, and an open ticket over midnight on a day NOT audited (B), keep the manager rules', async () => {
    const t = await ticket(cashierA, A)
    expect((await call(mgrA, 'POST', `/pos/orders/${t.id}/void`, { orderItemId: t.items[0]!.id, reason: 'wrong item' })).statusCode).toBe(200)
    const late = await ticket(mgrB, B, at(yesterday, '23:50'))
    expect((await call(mgrB, 'POST', `/pos/orders/${late.id}/void`, { orderItemId: late.items[0]!.id, reason: 'wrong item' })).statusCode).toBe(200)
  })
})

describe('comp, cancel and expo reject of a ticket from a night-audited day', () => {
  it('comp: manager 403, CEO 422 then 200', async () => {
    const shiftId = await openDrawer(A, cashierA)
    const o = await ticket(cashierA, A, at(yesterday, '21:00'))
    const body = { amountCents: 1_000, reason: 'cold food', shiftId }
    expectCeoOnly(await call(mgrA, 'POST', `/pos/orders/${o.id}/comp`, body), 'comp')
    expect((await call(ceo, 'POST', `/pos/orders/${o.id}/comp`, body)).json().error.code).toBe('BACKDATED_REASON_REQUIRED')
    const ok = await call(ceo, 'POST', `/pos/orders/${o.id}/comp`, { ...body, backdatedReason: 'Owner comped the cold plate' })
    expect(ok.statusCode, ok.body).toBe(200)
    // Booked today, never on the locked day.
    expect(fmtPktDate((await prisma.payment.findFirstOrThrow({ where: { orderId: o.id, method: 'comp' } })).processedAt!)).toBe(today)
    expect(await audited('comp', o.id)).toBe(1)
  })

  it('cancel: manager 403, cashier + manager PIN 403, CEO 422 then 200', async () => {
    const o = await ticket(cashierA, A, at(yesterday, '20:00'))
    expectCeoOnly(await call(mgrA, 'POST', `/orders/${o.id}/cancel`, { reason: 'walked out' }), 'cancel')
    expectCeoOnly(await call(cashierA, 'POST', `/orders/${o.id}/cancel`, { reason: 'walked out', managerOverridePin: PIN_A }), 'cancel')
    expect((await call(ceo, 'POST', `/orders/${o.id}/cancel`, { reason: 'walked out' })).json().error.code).toBe('BACKDATED_REASON_REQUIRED')
    const ok = await call(ceo, 'POST', `/orders/${o.id}/cancel`, { reason: 'walked out', backdatedReason: 'Guest left before the food' })
    expect(ok.statusCode, ok.body).toBe(200)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('cancelled')
    expect(await audited('cancel', o.id)).toBe(1)
    expect(await flagged(o.id)).toBe(1)
  })

  it('expo reject: manager 403, CEO 200 with a reason', async () => {
    const o = await prisma.order.create({ data: {
      conceptId: A.conceptId, source: 'servd', fulfilmentType: 'takeout', status: 'received', totalCents: 10_000, taxCents: 0,
      placedAt: at(yesterday, '22:30'), items: { create: [{ menuItemId: A.items.water, name: 'Water', quantity: 1, unitPriceCents: 10_000 }] },
    } })
    expectCeoOnly(await call(mgrA, 'POST', `/expo/orders/${o.id}/reject`, { reason: 'out of stock' }), 'reject')
    expect((await call(ceo, 'POST', `/expo/orders/${o.id}/reject`, { reason: 'out of stock' })).json().error.code).toBe('BACKDATED_REASON_REQUIRED')
    const ok = await call(ceo, 'POST', `/expo/orders/${o.id}/reject`, { reason: 'out of stock', backdatedReason: 'Stale order from last night' })
    expect(ok.statusCode, ok.body).toBe(200)
    expect(await audited('reject', o.id)).toBe(1)
  })
})

describe('a bill completed yesterday', () => {
  it('card reverse: manager 403, CEO 422 then 200', async () => {
    const o = await oldBill()
    const conn = await prisma.posConnector.create({ data: { tenantId: A.tenantId, kind: 'terminal', webhookToken: randomBytes(16).toString('hex') } })
    const c = await prisma.terminalCharge.create({ data: {
      tenantId: A.tenantId, connectorId: conn.id, terminalId: 'trm-1', orderId: o.id, amountCents: 63_250, quoteDueCents: 63_250,
      idempotencyKey: 'nab-tc', status: 'needs_attention', approvalRef: 'AP-1', expiresAt: at(yesterday, '14:00'), createdById: cashierA.id, createdAt: at(yesterday, '13:15'),
    } })
    const url = `/pos/terminal/charges/${c.id}/reverse`
    expectCeoOnly(await call(mgrA, 'POST', url, { markRefundedOnMachine: true }), 'card_reverse')
    expect((await call(ceo, 'POST', url, { markRefundedOnMachine: true })).json().error.code).toBe('BACKDATED_REASON_REQUIRED')
    const ok = await call(ceo, 'POST', url, { markRefundedOnMachine: true, backdatedReason: 'Customer was double charged' })
    expect(ok.statusCode, ok.body).toBe(200)
    expect(await audited('card_reverse', o.id)).toBe(1)
  })

  it('credit note: manager 403, CEO 422 then 201', async () => {
    const o = await oldBill()
    await issueInvoiceForOrder({ orderId: o.id })
    const url = `/invoices/orders/${o.id}/credit-note`
    expectCeoOnly(await call(mgrA, 'POST', url, { reason: 'wrong buyer' }), 'credit_note')
    expect((await call(ceo, 'POST', url, { reason: 'wrong buyer' })).json().error.code).toBe('BACKDATED_REASON_REQUIRED')
    const ok = await call(ceo, 'POST', url, { reason: 'wrong buyer', backdatedReason: 'Issued to the wrong company' })
    expect(ok.statusCode, ok.body).toBe(201)
    expect(await audited('credit_note', o.id)).toBe(1)
  })

  it('a refund today of yesterday\'s bill by a manager is allowed (owner question Q5)', async () => {
    const closed = await prisma.shift.create({ data: { userId: cashierA.id, tenantId: A.tenantId, status: 'closed', openedAt: at(yesterday, '09:00'), closedAt: at(yesterday, '23:00'), closingFloatCents: 63_250 } })
    const o = await oldBill()
    await prisma.payment.create({ data: { orderId: o.id, shiftId: closed.id, method: 'cash', amountCents: 63_250, status: 'paid', processedAt: at(yesterday, '13:20') } })
    const drawer = await openDrawer(A, mgrA)
    const r = await call(mgrA, 'POST', `/pos/orders/${o.id}/refund`, { amountCents: 10_000, reason: 'Late complaint', method: 'cash', shiftId: drawer })
    expect(r.statusCode, r.body).toBe(200)
  })
})

describe('no sales route takes a date', () => {
  it('the sales route schemas carry no placedAt / completedAt / entryDate / occurredAt / droppedAt', () => {
    const files = [
      'src/modules/pos/routes.ts', 'src/modules/pos/onAccountRoutes.ts', 'src/modules/orders/routes.ts', 'src/modules/expo/routes.ts',
      'src/modules/connectors/posRoutes.ts', 'src/modules/invoices/routes.ts', 'src/modules/trustops/routes.ts',
    ]
    for (const f of files) {
      const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
      expect(src, f).not.toMatch(/\b(placedAt|completedAt|entryDate|occurredAt|droppedAt)\s*:\s*z\./)
    }
  })
})
