// Till review findings (2026-10-10, second pass) — regression tests. Two
// companies throughout: B's staff never learn anything about A's drawers.
//
//   TILL-R1  a drawer's close names its open tickets (GET /pos/shifts/:id/
//            open-tickets) and a ticket voided down to PKR 0 never holds it
//   TILL-R3  a line on a paid, not-yet-completed order can be voided: it is
//            refunded on its tender through the refund engine; a part-paid
//            bill loses a line when what is paid still fits the bill
//   TILL-R4  the fiscal return of a tipped refund leaves the tip out
//   TILL-R5  the Z-report gives sales without tips
//   TILL-R7  the settle routes check the drawer's company before its owner
//   F6       a till pay-out against a supplier bill posts once, in its transaction
//   F7       the Z-report shows gift-card tenders and refund due on cancelled tickets
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { randomUUID } from 'node:crypto'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { setManagerPin } from '../src/modules/auth/managerPin.js'
import { AppError, errorResponse } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { invalidateSetupCache } from '../src/lib/setup-config.js'
import { posRoutes } from '../src/modules/pos/routes.js'
import { checkSplitRoutes } from '../src/modules/checkSplit/routes.js'
import { orderRoutes } from '../src/modules/orders/routes.js'
import { taxableRefundCents, applyGiftCardTender, recordCashMovement } from '../src/modules/pos/service.js'

const PIN = '3917'
let app: FastifyInstance
let tenantA: string, tenantB: string
let conceptA: string, conceptB: string
const item: Record<string, string> = {}
const users: Record<string, { id: string; token: string }> = {}
const drawers: Record<string, string> = {}

async function mkUser(key: string, role: string, tenantId: string) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.tillreview@gsfoods.pk`, password: await bcrypt.hash('x-Password-1', 4), role: role as never, isActive: true, accountStatus: 'active', tenantId },
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } as never }).catch(() => {})
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
  return u
}

const call = (who: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as never, headers: { authorization: `Bearer ${users[who]!.token}` } })

async function drawer(who: string): Promise<string> {
  await prisma.shift.updateMany({ where: { userId: users[who]!.id, status: 'open' }, data: { status: 'closed', closedAt: new Date(), closingFloatCents: 0 } })
  const r = await call(who, 'POST', '/pos/shifts/open', { openingFloatCents: 100_000 })
  expect(r.statusCode, r.body).toBe(201)
  drawers[who] = r.json().id
  return drawers[who]!
}

type Line = { menuItemId: string; name: string; quantity: number; unitPriceCents: number }
const NIHARI = (): Line => ({ menuItemId: item['nihari']!, name: 'Beef Nihari', quantity: 1, unitPriceCents: 145_000 })
const KHEER = (): Line => ({ menuItemId: item['kheer']!, name: 'Kheer', quantity: 1, unitPriceCents: 55_000 })

async function ring(who: string, items: Line[], extra: Record<string, unknown> = {}) {
  const r = await call(who, 'POST', '/pos/orders', { conceptId: extra['conceptId'] ?? conceptA, items: items.map((i) => ({ modifiers: [], ...i })), shiftId: drawers[who], ...extra })
  expect(r.statusCode, r.body).toBe(201)
  return r.json() as { id: string; totalCents: number; taxCents: number; items: Array<{ id: string; name: string }> }
}

const pay = (who: string, orderId: string, payments: Array<Record<string, unknown>>) =>
  call(who, 'POST', '/pos/payments', { orderId, shiftId: drawers[who], payments, idempotencyKey: randomUUID() })

/** An online (servd) order, paid by card through the gateway, still in the kitchen. */
async function onlinePaidOrder(method: 'card' | 'cash' = 'card') {
  // Nihari 1,450 + Kheer 550 = 2,000; card rate 8% → GST 160 → 2,160.
  const rate = method === 'card' ? 8 : 15
  const tax = method === 'card' ? 16_000 : 30_000
  const total = 200_000 + tax
  const o = await prisma.order.create({
    data: {
      conceptId: conceptA, source: 'servd', fulfilmentType: 'delivery', status: 'preparing',
      totalCents: total, taxCents: tax, taxRatePct: rate,
      items: { create: [
        { menuItemId: item['nihari']!, name: 'Beef Nihari', quantity: 1, unitPriceCents: 145_000, status: 'preparing' },
        { menuItemId: item['kheer']!, name: 'Kheer', quantity: 1, unitPriceCents: 55_000, status: 'pending' },
      ] },
      payments: { create: [{ method, amountCents: total, status: 'paid', gateway: method === 'card' ? 'keenu' : 'none', gatewayRef: method === 'card' ? 'KN-1' : null, processedAt: new Date() }] },
    },
    include: { items: true },
  })
  return o
}

beforeAll(async () => {
  tenantB = (await prisma.tenant.create({ data: { name: 'Karachi Grill Co', slug: 'tillreview-b' } })).id
  tenantA = (await prisma.tenant.create({ data: { name: 'GS Foods', slug: 'tillreview-a' } })).id
  await ensureChartOfAccounts(tenantA)
  await ensureChartOfAccounts(tenantB)
  conceptA = (await prisma.concept.create({ data: { name: 'Simmer', slug: 'simmer', type: 'restaurant', tenantId: tenantA, taxRate: 17, taxRateCash: 15, taxRateCard: 8 } })).id
  conceptB = (await prisma.concept.create({ data: { name: 'Grill House', slug: 'grill-house', type: 'restaurant', tenantId: tenantB, taxRate: 17, taxRateCash: 15, taxRateCard: 8 } })).id
  const catA = await prisma.category.create({ data: { conceptId: conceptA, name: 'Mains' } })
  const catB = await prisma.category.create({ data: { conceptId: conceptB, name: 'Mains' } })
  item['nihari'] = (await prisma.menuItem.create({ data: { conceptId: conceptA, categoryId: catA.id, name: 'Beef Nihari', priceCents: 145_000 } })).id
  item['kheer'] = (await prisma.menuItem.create({ data: { conceptId: conceptA, categoryId: catA.id, name: 'Kheer', priceCents: 55_000 } })).id
  item['chapli'] = (await prisma.menuItem.create({ data: { conceptId: conceptB, categoryId: catB.id, name: 'Chapli Burger', priceCents: 90_000 } })).id

  await mkUser('cashier1', 'cashier', tenantA)
  await mkUser('cashier2', 'cashier', tenantA)
  const mgr = await mkUser('mgrA', 'foh_management', tenantA)
  await setManagerPin(mgr.id, PIN)
  await mkUser('cashierB', 'cashier', tenantB)
  await mkUser('mgrB', 'foh_management', tenantB)

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(posRoutes, { prefix: '/pos' })
  await app.register(checkSplitRoutes, { prefix: '/check-split' })
  await app.register(orderRoutes, { prefix: '/orders' })
  await app.ready()

  await drawer('cashier1')
  await drawer('cashier2')
  await drawer('cashierB')
  await drawer('mgrA')
}, 60_000)

afterAll(async () => {
  invalidateSetupCache()
  await app.close()
})

// ─── TILL-R1 ──────────────────────────────────────────────────────────────────

describe('TILL-R1 — the close names its open tickets; a PKR 0 ticket never holds it', () => {
  it('the drawer\'s cashier (and a manager) read the open tickets; another cashier is 403, company B is 404', async () => {
    const s = await drawer('cashier2')
    const o = await ring('cashier2', [KHEER()])
    const own = await call('cashier2', 'GET', `/pos/shifts/${s}/open-tickets`)
    expect(own.statusCode, own.body).toBe(200)
    expect(own.json()).toMatchObject({ count: 1, tickets: [{ id: o.id, dueCents: o.totalCents }] })
    expect((await call('mgrA', 'GET', `/pos/shifts/${s}/open-tickets`)).statusCode).toBe(200)
    const other = await call('cashier1', 'GET', `/pos/shifts/${s}/open-tickets`)
    expect(other.statusCode).toBe(403)
    expect((await call('cashierB', 'GET', `/pos/shifts/${s}/open-tickets`)).statusCode).toBe(404)
    expect((await call('mgrB', 'GET', `/pos/shifts/${s}/open-tickets`)).statusCode).toBe(404)
    // The close refuses with the same list, then closes on confirmation.
    const r = await call('cashier2', 'POST', `/pos/shifts/${s}/close`, { closingFloatCents: 100_000 })
    expect(r.statusCode).toBe(409)
    expect(r.json().error).toMatchObject({ code: 'OPEN_TICKETS', details: { openTickets: { count: 1 } } })
    const ok = await call('cashier2', 'POST', `/pos/shifts/${s}/close`, { closingFloatCents: 100_000, confirmOpenTickets: true })
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json().openTickets.count).toBe(1)
  })

  it('a ticket voided down to PKR 0 does not hold the close', async () => {
    const s = await drawer('cashier2')
    const o = await ring('cashier2', [KHEER()])
    const v = await call('mgrA', 'POST', `/pos/orders/${o.id}/void`, { orderItemId: o.items[0]!.id, reason: 'walked out' })
    expect(v.statusCode, v.body).toBe(200)
    expect(v.json().order.totalCents).toBe(0)
    expect((await call('cashier2', 'GET', `/pos/shifts/${s}/open-tickets`)).json().count).toBe(0)
    const ok = await call('cashier2', 'POST', `/pos/shifts/${s}/close`, { closingFloatCents: 100_000 })
    expect(ok.statusCode, ok.body).toBe(200)
  })
})

// ─── TILL-R3 ──────────────────────────────────────────────────────────────────

describe('TILL-R3 — voiding a line on a paid or part-paid open order', () => {
  it('a paid online order still in the kitchen: the line is voided and refunded on its card, booked once', async () => {
    const o = await onlinePaidOrder('card')
    const kheer = o.items.find((i) => i.name === 'Kheer')!
    const v = await call('mgrA', 'POST', `/pos/orders/${o.id}/void`, { orderItemId: kheer.id, reason: 'out of kheer' })
    expect(v.statusCode, v.body).toBe(200)
    // Kheer 550 + 8% GST 44 = 594 back on the card; the bill as charged stands.
    expect(v.json()).toMatchObject({ status: 'voided', removedCents: 59_400, refund: { amountCents: 59_400, method: 'card' } })
    const after = await prisma.order.findUniqueOrThrow({ where: { id: o.id }, include: { payments: true } })
    expect(after).toMatchObject({ status: 'preparing', totalCents: 216_000, taxCents: 16_000 })
    const refunds = after.payments.filter((p) => p.status === 'refunded')
    expect(refunds.map((p) => p.amountCents)).toEqual([-59_400])
    const entry = await prisma.journalEntry.findFirst({ where: { reference: `order.refund:${refunds[0]!.id}` }, include: { lines: true } })
    expect(entry?.tenantId).toBe(tenantA)
    const dr = entry!.lines.filter((l) => l.type === 'debit').reduce((t, l) => t + l.amountCents, 0)
    const cr = entry!.lines.filter((l) => l.type === 'credit').reduce((t, l) => t + l.amountCents, 0)
    expect(dr).toBe(59_400)
    expect(cr).toBe(59_400)
    // What is left to refund later is the order net of the void refund.
    const rest = await call('mgrA', 'POST', `/pos/orders/${o.id}/refund`, { amountCents: 1, reason: 'customer asked', method: 'card' })
    expect(rest.json().error.code).toBe('NOT_REFUNDABLE') // still open — refunds wait for completion
  })

  it('the last line of a paid order is a cancel, not a void; company B cannot void A\'s line', async () => {
    const o = await onlinePaidOrder('card')
    const [nihari, kheer] = [o.items.find((i) => i.name === 'Beef Nihari')!, o.items.find((i) => i.name === 'Kheer')!]
    expect((await call('mgrB', 'POST', `/pos/orders/${o.id}/void`, { orderItemId: kheer.id, reason: 'x' })).statusCode).toBe(404)
    expect((await call('mgrA', 'POST', `/pos/orders/${o.id}/void`, { orderItemId: kheer.id, reason: 'x' })).statusCode).toBe(200)
    const last = await call('mgrA', 'POST', `/pos/orders/${o.id}/void`, { orderItemId: nihari.id, reason: 'x' })
    expect(last.statusCode).toBe(409)
    expect(last.json().error.code).toBe('VOID_LAST_LINE')
    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: nihari.id } })).status).not.toBe('voided')
    expect(await prisma.payment.count({ where: { orderId: o.id, status: 'refunded' } })).toBe(1)
  })

  it('a cash-paid open order needs the refunder\'s open drawer, and refunds from it', async () => {
    const o = await onlinePaidOrder('cash')
    const kheer = o.items.find((i) => i.name === 'Kheer')!
    await prisma.shift.updateMany({ where: { userId: users['mgrA']!.id, status: 'open' }, data: { status: 'closed', closedAt: new Date(), closingFloatCents: 0 } })
    const none = await call('mgrA', 'POST', `/pos/orders/${o.id}/void`, { orderItemId: kheer.id, reason: 'x' })
    expect(none.statusCode).toBe(422)
    expect(none.json().error.code).toBe('OPEN_DRAWER_REQUIRED')
    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: kheer.id } })).status).not.toBe('voided')
    const s = await drawer('mgrA')
    const v = await call('mgrA', 'POST', `/pos/orders/${o.id}/void`, { orderItemId: kheer.id, reason: 'x' })
    expect(v.statusCode, v.body).toBe(200)
    // Kheer 550 + 15% = 632.50 in cash out of the manager's drawer.
    expect(v.json().refund).toMatchObject({ amountCents: 63_250, method: 'cash', shiftId: s })
  })

  it('a part-paid table loses a line when what is paid still fits the bill', async () => {
    const o = await ring('cashier1', [NIHARI(), KHEER()]) // 2,000 + 15% = 2,300
    const split = await call('cashier1', 'POST', `/check-split/orders/${o.id}/split-evenly`, { ways: 2, method: 'cash' })
    expect(split.statusCode, split.body).toBe(200)
    const portions = await prisma.payment.findMany({ where: { orderId: o.id, status: 'pending' }, orderBy: { createdAt: 'asc' } })
    const settled = await call('cashier1', 'POST', `/check-split/payments/${portions[0]!.id}/settle`, { shiftId: drawers['cashier1'] })
    expect(settled.statusCode, settled.body).toBe(200)
    const kheer = o.items.find((i) => i.name === 'Kheer')!
    const v = await call('mgrA', 'POST', `/pos/orders/${o.id}/void`, { orderItemId: kheer.id, reason: 'not wanted' })
    expect(v.statusCode, v.body).toBe(200)
    expect(v.json()).toMatchObject({ order: { totalCents: 166_750 }, removedCents: 63_250, splitCleared: true, refund: null })
    // 1,150 paid of 1,667.50 → 517.50 still due, and paying it completes the bill.
    const p = await pay('cashier1', o.id, [{ method: 'cash', amountCents: 51_750 }])
    expect(p.statusCode, p.body).toBe(201)
    expect(p.json().orderCompleted).toBe(true)
  })

  it('a part-paid table whose payments already exceed the bill without the line: pay the rest first', async () => {
    const o = await ring('cashier1', [NIHARI(), KHEER()])
    await call('cashier1', 'POST', `/check-split/orders/${o.id}/split-evenly`, { ways: 2, method: 'cash' })
    const portions = await prisma.payment.findMany({ where: { orderId: o.id, status: 'pending' }, orderBy: { createdAt: 'asc' } })
    expect((await call('cashier1', 'POST', `/check-split/payments/${portions[0]!.id}/settle`, { shiftId: drawers['cashier1'] })).statusCode).toBe(200)
    const nihari = o.items.find((i) => i.name === 'Beef Nihari')!
    const v = await call('mgrA', 'POST', `/pos/orders/${o.id}/void`, { orderItemId: nihari.id, reason: 'x' })
    expect(v.statusCode).toBe(409)
    expect(v.json().error.code).toBe('ORDER_PARTLY_PAID')
    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: nihari.id } })).status).not.toBe('voided')
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).totalCents).toBe(230_000)
  })
})

// ─── TILL-R4 ──────────────────────────────────────────────────────────────────

describe('TILL-R4 — the fiscal sales-return leaves the tip out', () => {
  it('taxableRefundCents: tip removed, cumulative, never more than the taxable sale', () => {
    const o = { totalCents: 128_000, tipCents: 20_000 }
    expect(taxableRefundCents(o, 0, 128_000)).toBe(108_000)
    expect(taxableRefundCents(o, 0, 64_000) + taxableRefundCents(o, 64_000, 64_000)).toBe(108_000)
    expect(taxableRefundCents({ totalCents: 108_000, tipCents: 0 }, 0, 50_000)).toBe(50_000)
    expect(taxableRefundCents(o, 128_000, 10)).toBe(0)
  })

  it('a tipped card bill refunded in full files a return on the bill, not the tip', async () => {
    const o = await ring('cashier1', [KHEER()], { paymentMethod: 'card' }) // 550 + 8% = 594
    const p = await pay('cashier1', o.id, [{ method: 'card', amountCents: 79_400, tipCents: 20_000, gatewayRef: 'T-1' }])
    expect(p.statusCode, p.body).toBe(201)
    const r = await call('mgrA', 'POST', `/pos/orders/${o.id}/refund`, { amountCents: 79_400, reason: 'wrong order', method: 'card' })
    expect(r.statusCode, r.body).toBe(200)
    // The fiscal return document (POS connector outbox): the whole refund,
    // with the tip split out of the taxable return — lines + tax + service
    // is the bill (594), the tip (200) is never filed as sale value.
    const doc = await prisma.fiscalDocument.findFirstOrThrow({ where: { orderId: o.id, kind: 'refund' } })
    const totals = (doc.payload as { totals: { tipCents: number; taxableCents: number; taxCents: number; serviceChargeCents: number; totalCents: number } }).totals
    expect(doc.amountCents).toBe(79_400)
    expect(totals.tipCents).toBe(20_000)
    expect(totals.taxableCents + totals.taxCents + totals.serviceChargeCents).toBe(59_400)
    const log = await prisma.auditLog.findFirst({ where: { action: 'order_refund', entityId: o.id } })
    expect((log!.metadata as { fiscalRefund: { documentId: string } }).fiscalRefund.documentId).toBe(doc.id)
  })
})

// ─── TILL-R5 / F7 ─────────────────────────────────────────────────────────────

describe('TILL-R5 / F7 — the Z-report', () => {
  it('sales without tips, gift-card tenders, and refund due on cancelled tickets', async () => {
    const s = await drawer('cashier2')
    // A tipped card sale.
    const t = await ring('cashier2', [KHEER()], { paymentMethod: 'card' })
    expect((await pay('cashier2', t.id, [{ method: 'card', amountCents: 79_400, tipCents: 20_000, gatewayRef: 'T-2' }])).statusCode).toBe(201)
    // A bill part-paid by a gift card, the rest in cash.
    await prisma.giftCard.create({ data: { tenantId: tenantA, code: 'GS-REVIEW-01', issuedAmountCents: 20_000, balanceCents: 20_000 } })
    const g = await ring('cashier2', [KHEER()]) // 632.50 cash rate
    const gc = await applyGiftCardTender({ orderId: g.id, code: 'GS-REVIEW-01', staffId: users['cashier2']!.id })
    expect(gc.appliedCents).toBe(20_000)
    expect((await pay('cashier2', g.id, [{ method: 'cash', amountCents: 43_250 }])).statusCode).toBe(201)
    // A ticket that took a portion in cash and was then cancelled.
    const c = await ring('cashier2', [NIHARI(), KHEER()])
    await call('cashier2', 'POST', `/check-split/orders/${c.id}/split-evenly`, { ways: 2, method: 'cash' })
    const portion = (await prisma.payment.findMany({ where: { orderId: c.id, status: 'pending' }, orderBy: { createdAt: 'asc' } }))[0]!
    expect((await call('cashier2', 'POST', `/check-split/payments/${portion.id}/settle`, { shiftId: s })).statusCode).toBe(200)
    const cancel = await call('mgrA', 'POST', `/orders/${c.id}/cancel`, { reason: 'guest left' })
    expect(cancel.statusCode, cancel.body).toBe(200)

    const z = (await call('mgrA', 'GET', `/pos/shifts/${s}/zreport`)).json()
    expect(z.tipsCents).toBe(20_000)
    expect(z.salesExTipsCents).toBe(z.totalSales - 20_000)
    expect(z.giftCardCents).toBe(20_000)
    expect(z.cancelledPaid).toEqual({ count: 1, cashCents: 115_000, cardCents: 0 })
    expect(z.refundDueCents).toBe(115_000)
    // Company B's finance cannot read it.
    expect((await call('cashierB', 'GET', `/pos/shifts/${s}/zreport`)).statusCode).toBe(403)
  })
})

// ─── TILL-R7 ──────────────────────────────────────────────────────────────────

describe('TILL-R7 — a foreign drawer and a made-up one answer the same', () => {
  it('both settle routes: company B\'s cashier gets 422 SHIFT_NOT_IN_COMPANY for A\'s real drawer and for a fake id', async () => {
    const o = await ring('cashierB', [{ menuItemId: item['chapli']!, name: 'Chapli Burger', quantity: 1, unitPriceCents: 90_000 }], { conceptId: conceptB })
    expect((await call('cashierB', 'POST', `/check-split/orders/${o.id}/split-evenly`, { ways: 2, method: 'cash' })).statusCode).toBe(200)
    const [p1, p2] = await prisma.payment.findMany({ where: { orderId: o.id, status: 'pending' }, orderBy: { createdAt: 'asc' } })
    for (const url of [`/check-split/payments/${p1!.id}/settle`, `/pos/payments/${p2!.id}/settle`]) {
      const real = await call('cashierB', 'POST', url, { shiftId: drawers['cashier1'] })
      const fake = await call('cashierB', 'POST', url, { shiftId: randomUUID() })
      expect([real.statusCode, real.json().error.code]).toEqual([422, 'SHIFT_NOT_IN_COMPANY'])
      expect([fake.statusCode, fake.json().error.code]).toEqual([422, 'SHIFT_NOT_IN_COMPANY'])
    }
    expect(await prisma.payment.count({ where: { orderId: o.id, status: 'pending', shiftId: null } })).toBe(2)
    // Their own drawer still works, and a cashier of A on A's other drawer is still NOT_YOUR_SHIFT.
    expect((await call('cashierB', 'POST', `/pos/payments/${p2!.id}/settle`, { shiftId: drawers['cashierB'] })).statusCode).toBe(200)
    const a = await ring('cashier1', [KHEER()])
    await call('cashier1', 'POST', `/check-split/orders/${a.id}/split-evenly`, { ways: 2, method: 'cash' })
    const ap = (await prisma.payment.findMany({ where: { orderId: a.id, status: 'pending' } }))[0]!
    const notMine = await call('cashier1', 'POST', `/pos/payments/${ap.id}/settle`, { shiftId: drawers['cashier2'] })
    expect([notMine.statusCode, notMine.json().error.code]).toEqual([403, 'NOT_YOUR_SHIFT'])
  })
})

// ─── F6 ───────────────────────────────────────────────────────────────────────

describe('F6 — a till pay-out against a supplier bill', () => {
  it('posts the supplier payment once, inside its transaction', async () => {
    const s = await drawer('cashier1')
    const sup = await prisma.supplier.create({ data: { name: 'Dairy Co', tenantId: tenantA } })
    const bill = await prisma.supplierBill.create({
      data: { supplierId: sup.id, billNumber: 'A-1', billDate: new Date(), dueDate: new Date(), subtotalCents: 10_000, totalCents: 10_000, status: 'open' },
    })
    await recordCashMovement({ shiftId: s, type: 'payout', amountCents: 10_000, reason: 'milk', actorId: users['mgrA']!.id, actorRole: 'foh_management', supplierBillId: bill.id })
    const sp = await prisma.supplierPayment.findFirstOrThrow({ where: { supplierId: sup.id } })
    const entries = await prisma.journalEntry.findMany({ where: { reference: `supplier.payment:${sp.id}` } })
    expect(entries).toHaveLength(1)
    expect(entries[0]!.tenantId).toBe(tenantA)
    expect((await prisma.supplierBill.findUniqueOrThrow({ where: { id: bill.id } })).status).toBe('paid')
  })
})
