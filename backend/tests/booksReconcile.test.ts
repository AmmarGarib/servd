// Books & till reconciled onto one implementation each (books-2 batch).
//
//   - ONE refund engine (refundOrder): caps + PIN, partial amounts, cash out of
//     the drawer open NOW (decision 3), its own balanced 'order.refund' entry
//     for till AND online orders, status 'refunded' once in full; the old
//     POST /orders/:id/refund and the 'refunded' status PATCH are gone.
//   - ONE settle (settlePayment): check-split, rider COD pay-in (decision 4),
//     the Keenu callback; card needs the terminal reference.
//   - Comps: staff meals ring through the till as a comp (decision 11).
//   - Drawer pay-outs: PIN + cap, booked like a petty-cash spend (decision 5).
//   - Period locks: one write path, reopen = admin + audit + exception (21).
//   - Allocations tagged per brand, head-office line (22).
//   - OpEx paid → posted from the line's bank (23).
//   - Capex: advances, capitalised on delivery, prepaid rent, fees (24).
//   - Projections labour: frozen out, JV netted (25).
//   - Unposted shifts post into the current open month (6).
// Every journal entry written here is checked to balance.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { setManagerPin } from '../src/modules/auth/managerPin.js'
import { AppError } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { invalidateSetupCache } from '../src/lib/setup-config.js'
import { refundOrder, compOrder, processPayment, settlePayment, recordCashMovement } from '../src/modules/pos/service.js'
import { refundShareOf } from '../src/modules/accounting/orderPosting.js'
import { buildShiftCloseEntry, backfillUnpostedShifts } from '../src/modules/accounting/shiftPosting.js'
import { brandPnl } from '../src/modules/accounting/reports.js'
import { runAllocationRule } from '../src/modules/allocations/service.js'
import { monthlyLabourCents } from '../src/modules/projections/labour.js'
import { applyKeenuCallback } from '../src/modules/paymentGateways/keenuSettle.js'
import { posRoutes } from '../src/modules/pos/routes.js'
import { orderRoutes } from '../src/modules/orders/routes.js'
import { checkSplitRoutes } from '../src/modules/checkSplit/routes.js'
import { accountingRoutes } from '../src/modules/accounting/routes.js'
import { opexRoutes } from '../src/modules/opex/routes.js'
import { financePlanningRoutes } from '../src/modules/financePlanning/routes.js'
import { reconciliationRoutes } from '../src/modules/reconciliation/routes.js'
import { trustopsRoutes } from '../src/modules/trustops/routes.js'

let tenantA: string
let tenantB: string
let conceptA: string
let conceptA2: string
let app: FastifyInstance
const users: Record<string, { id: string; token: string }> = {}
const PIN = '739154'

async function mkUser(key: string, role: string, primary: string) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.books2@gsfoods.pk`, password: await bcrypt.hash('x-Password-1', 4), role: role as never, isActive: true, accountStatus: 'active', tenantId: primary },
  })
  await prisma.tenantMember.create({ data: { tenantId: primary, userId: u.id } as never }).catch(() => {})
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
  return u
}

const call = (who: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as never, headers: { authorization: `Bearer ${users[who]!.token}` } })

async function openShift(userKey: string, tenantId = tenantA) {
  const userId = users[userKey]!.id
  await prisma.shift.updateMany({ where: { userId, status: 'open' }, data: { status: 'closed', closedAt: new Date(), closingFloatCents: 0 } })
  return prisma.shift.create({ data: { userId, openingFloatCents: 100_000, status: 'open', tenantId } })
}

/** A till sale: 1,000 food + 150 GST = 1,150, paid cash on `shiftId`. */
async function tillSale(shiftId: string, opts: { totalCents?: number; taxCents?: number; conceptId?: string } = {}) {
  const totalCents = opts.totalCents ?? 115_000
  const o = await prisma.order.create({
    data: {
      conceptId: opts.conceptId ?? conceptA, source: 'pos', status: 'completed', completedAt: new Date(),
      totalCents, taxCents: opts.taxCents ?? 15_000,
      items: { create: [{ name: 'Sandwich', quantity: 1, unitPriceCents: totalCents - (opts.taxCents ?? 15_000) }] },
    },
  })
  await prisma.payment.create({ data: { orderId: o.id, shiftId, method: 'cash', amountCents: totalCents, status: 'paid', processedAt: new Date() } })
  return o
}

async function entry(reference: string) {
  const je = await prisma.journalEntry.findFirst({
    where: { reference },
    include: { lines: { include: { account: { select: { code: true } } } } },
  })
  return je ? { ...je, rows: je.lines.map((l) => ({ code: l.account.code, type: l.type, amount: l.amountCents, conceptId: l.conceptId, memo: l.memo ?? '' })) } : null
}
const sum = (rows: Array<{ code: string; type: string; amount: number }>, code: string, type: 'debit' | 'credit') =>
  rows.filter((r) => r.code === code && r.type === type).reduce((t, r) => t + r.amount, 0)

async function waitFor<T>(read: () => Promise<T>, done: (v: T) => boolean, ms = 5000): Promise<T> {
  const until = Date.now() + ms
  let v = await read()
  while (!done(v) && Date.now() < until) { await new Promise((r) => setTimeout(r, 50)); v = await read() }
  return v
}

beforeAll(async () => {
  tenantB = (await prisma.tenant.create({ data: { name: 'Books B', slug: 'books-b' } })).id
  tenantA = (await prisma.tenant.create({ data: { name: 'Books A', slug: 'books-a' } })).id
  await ensureChartOfAccounts(tenantA)
  await ensureChartOfAccounts(tenantB)
  conceptA = (await prisma.concept.create({ data: { name: 'Books Cafe', slug: 'simmer', type: 'restaurant', tenantId: tenantA, taxRateCash: 15, taxRateCard: 8 } })).id
  conceptA2 = (await prisma.concept.create({ data: { name: 'Books Diner', slug: 'flipd', type: 'restaurant', tenantId: tenantA, taxRateCash: 15, taxRateCard: 8 } })).id
  await mkUser('admin', 'admin', tenantA)
  await mkUser('adminB', 'admin', tenantB)
  const mgr = await mkUser('mgr', 'foh_management', tenantA)
  await setManagerPin(mgr.id, PIN)
  await mkUser('cashier', 'cashier', tenantA)
  await mkUser('cashier2', 'cashier', tenantA)
  await mkUser('finance', 'finance', tenantA)

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(posRoutes, { prefix: '/pos' })
  await app.register(orderRoutes, { prefix: '/orders' })
  await app.register(checkSplitRoutes, { prefix: '/check-split' })
  await app.register(accountingRoutes, { prefix: '/accounting' })
  await app.register(opexRoutes, { prefix: '/opex' })
  await app.register(financePlanningRoutes, { prefix: '/finance' })
  await app.register(reconciliationRoutes, { prefix: '/reconciliation' })
  await app.register(trustopsRoutes, { prefix: '/trustops' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  // Every entry this suite wrote balances — no exceptions.
  const entries = await prisma.journalEntry.findMany({
    where: { tenantId: { in: [tenantA, tenantB] } },
    include: { lines: true },
  })
  for (const e of entries) {
    const d = e.lines.filter((l) => l.type === 'debit').reduce((t, l) => t + l.amountCents, 0)
    const c = e.lines.filter((l) => l.type === 'credit').reduce((t, l) => t + l.amountCents, 0)
    expect({ ref: e.reference, d }).toEqual({ ref: e.reference, d: c })
  }
  invalidateSetupCache()
  await app.close()
})

// ─── Refunds ──────────────────────────────────────────────────────────────────

describe('refundShareOf — cumulative, exact', () => {
  it('partial refunds add up to exactly the order\'s GST, service charge and tip', () => {
    const order = { totalCents: 100_001, walletAmountCents: 0, taxCents: 13_043, discountCents: 0, promoDiscountCents: 0, serviceChargeCents: 4_999, tipCents: 1_000 }
    const parts = [33_333, 33_333, 33_335]
    let prior = 0
    const shares = parts.map((p) => { const s = refundShareOf(order, prior, p); prior += p; return s })
    expect(shares.reduce((t, s) => t + s.taxCents, 0)).toBe(13_043)
    expect(shares.reduce((t, s) => t + s.serviceChargeCents, 0)).toBe(4_999)
    expect(shares.reduce((t, s) => t + s.tipCents, 0)).toBe(1_000)
    for (let i = 0; i < parts.length; i++) {
      const s = shares[i]!
      expect(s.revenueCents + s.taxCents + s.serviceChargeCents + s.tipCents).toBe(parts[i])
    }
  })
})

describe('refunds — one engine', () => {
  it('a cash refund of an earlier closed shift\'s sale leaves the drawer open NOW, and books its own entry', async () => {
    const s1 = await openShift('cashier')
    const o = await tillSale(s1.id)
    await prisma.shift.update({ where: { id: s1.id }, data: { status: 'closed', closedAt: new Date(), closingFloatCents: 215_000 } })
    const s2 = await openShift('cashier2')

    const r = await call('cashier2', 'POST', `/pos/orders/${o.id}/refund`, { amountCents: 46_000, reason: 'Cold sandwich', managerOverridePin: PIN })
    expect(r.statusCode).toBe(200)
    const refund = r.json()
    expect(refund.shiftId).toBe(s2.id)
    expect(refund.orderRefunded).toBe(false)

    const je = await entry(`order.refund:${refund.id}`)
    expect(je).toBeTruthy()
    // 46,000 of 115,000 → 40% → GST 6,000, revenue 40,000; cash out of the open drawer.
    expect(sum(je!.rows, '2030', 'debit')).toBe(6_000)
    expect(sum(je!.rows, '4001', 'debit')).toBe(40_000)
    expect(sum(je!.rows, '1015', 'credit')).toBe(46_000)
    expect(je!.rows.every((x) => x.conceptId === conceptA)).toBe(true)

    // The rest → refunded in full; GST exactly 15,000 over both.
    const r2 = await call('cashier2', 'POST', `/pos/orders/${o.id}/refund`, { amountCents: 69_000, reason: 'Rest of it', managerOverridePin: PIN })
    expect(r2.statusCode).toBe(200)
    expect(r2.json().orderRefunded).toBe(true)
    const je2 = await entry(`order.refund:${r2.json().id}`)
    expect(sum(je2!.rows, '2030', 'debit') + 6_000).toBe(15_000)
    const after = await waitFor(() => prisma.order.findUniqueOrThrow({ where: { id: o.id } }), (x) => x.status === 'refunded')
    expect(after.status).toBe('refunded')

    // Nothing more to refund.
    const r3 = await call('cashier2', 'POST', `/pos/orders/${o.id}/refund`, { amountCents: 1, reason: 'Again', managerOverridePin: PIN })
    expect(r3.statusCode).toBe(409)

    // S2's close does not book those refunds a second time, and balances.
    await prisma.shift.update({ where: { id: s2.id }, data: { status: 'closed', closedAt: new Date(), closingFloatCents: 100_000 - 115_000 } })
    // S2 took no sales and its refunds are already on the books, so its
    // close has nothing left to post.
    const close = await buildShiftCloseEntry(s2.id)
    expect(close).toMatchObject({ ok: false, reason: 'no_postable_activity' })
    // With a sale on it, the close books the sale and still skips the refunds.
    await tillSale(s2.id, { totalCents: 10_000, taxCents: 0 })
    await prisma.shift.update({ where: { id: s2.id }, data: { closingFloatCents: 100_000 - 115_000 + 10_000 } })
    const close2 = await buildShiftCloseEntry(s2.id)
    expect(close2.ok).toBe(true)
    if (!close2.ok) return
    expect(close2.lines.filter((l) => l.accountCode === '7040')).toHaveLength(0)
    expect(close2.debits).toBe(close2.credits)
  })

  it('refuses a cash refund with no open drawer, and a cashier over the cap without a PIN', async () => {
    const s = await openShift('cashier')
    const o = await tillSale(s.id)
    await prisma.shift.update({ where: { id: s.id }, data: { status: 'closed', closedAt: new Date(), closingFloatCents: 215_000 } })
    await expect(refundOrder({ orderId: o.id, amountCents: 1_000, reason: 'No drawer', actorId: users['admin']!.id, actorRole: 'admin' }))
      .rejects.toMatchObject({ code: 'OPEN_DRAWER_REQUIRED' })
    await openShift('cashier')
    const r = await call('cashier', 'POST', `/pos/orders/${o.id}/refund`, { amountCents: 1_000, reason: 'Over cap' })
    expect(r.statusCode).toBe(403)
    expect(r.json().error.code).toBe('MANAGER_OVERRIDE_REQUIRED')
  })

  it('refunds a completed online order nothing ever settled, back to the card receivable', async () => {
    const o = await prisma.order.create({
      data: { conceptId: conceptA, source: 'servd', status: 'completed', completedAt: new Date(), totalCents: 108_000, taxCents: 8_000 },
    })
    await prisma.payment.create({ data: { orderId: o.id, method: 'card', amountCents: 108_000, status: 'pending' } })
    const res = await refundOrder({ orderId: o.id, amountCents: 108_000, reason: 'Never arrived', actorId: users['admin']!.id, actorRole: 'admin' })
    const je = await entry(`order.refund:${res.id}`)
    expect(sum(je!.rows, '1030', 'credit')).toBe(108_000)
    expect(sum(je!.rows, '2030', 'debit')).toBe(8_000)
    expect(res.orderRefunded).toBe(true)
  })

  it('the old refund doors are shut', async () => {
    const s = await openShift('cashier')
    const o = await tillSale(s.id)
    expect((await call('admin', 'POST', `/orders/${o.id}/refund`, { reason: 'old route' })).statusCode).toBe(404)
    expect((await call('admin', 'PATCH', `/orders/${o.id}/status`, { status: 'refunded' })).statusCode).toBe(400)
    // A not-yet-sold order is cancelled, not refunded.
    const open = await prisma.order.create({ data: { conceptId: conceptA, source: 'pos', status: 'preparing', totalCents: 1_000 } })
    const r = await call('admin', 'POST', `/pos/orders/${open.id}/refund`, { amountCents: 1_000, reason: 'unsold' })
    expect(r.json().error.code).toBe('NOT_REFUNDABLE')
  })
})

// ─── Settlement ───────────────────────────────────────────────────────────────

describe('settlement — one settle', () => {
  it('card at the till needs the terminal reference, then completes the sale', async () => {
    const s = await openShift('cashier')
    const o = await prisma.order.create({ data: { conceptId: conceptA, source: 'pos', status: 'received', totalCents: 50_000, taxCents: 0 } })
    await expect(processPayment({ orderId: o.id, shiftId: s.id, payments: [{ method: 'card', amountCents: 50_000 }] }))
      .rejects.toMatchObject({ code: 'GATEWAY_REF_REQUIRED' })
    const r = await processPayment({ orderId: o.id, shiftId: s.id, payments: [{ method: 'card', amountCents: 50_000, gatewayRef: 'TERM-001' }] })
    expect(r.payments[0]!.status).toBe('paid')
    expect(r.orderCompleted).toBe(true)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('completed')
  })

  it('check-split portions settle onto an open drawer and the last one completes the bill, voiding the group placeholder', async () => {
    const s = await openShift('cashier')
    const o = await prisma.order.create({ data: { conceptId: conceptA, source: 'servd', fulfilmentType: 'dine_in', status: 'ready', totalCents: 60_000, taxCents: 0 } })
    await prisma.payment.create({ data: { orderId: o.id, method: 'split', amountCents: 60_000, status: 'pending' } })
    const split = await call('cashier', 'POST', `/check-split/orders/${o.id}/split`, { splits: [{ amountCents: 30_000, method: 'cash' }, { amountCents: 30_000, method: 'card' }] })
    expect(split.statusCode).toBe(200)
    const [a, b] = split.json() as Array<{ id: string; method: string }>
    const cashLeg = [a, b].find((x) => x!.method === 'cash')!
    const cardLeg = [a, b].find((x) => x!.method === 'card')!
    expect((await call('cashier', 'POST', `/check-split/payments/${cashLeg.id}/settle`, {})).statusCode).toBe(400)
    const p1 = await call('cashier', 'POST', `/check-split/payments/${cashLeg.id}/settle`, { shiftId: s.id, tenderedCents: 30_000 })
    expect(p1.statusCode).toBe(200)
    expect(p1.json().shiftId).toBe(s.id)
    expect(p1.json().orderCompleted).toBe(false)
    const noRef = await call('cashier', 'POST', `/check-split/payments/${cardLeg.id}/settle`, { shiftId: s.id })
    expect(noRef.json().error.code).toBe('GATEWAY_REF_REQUIRED')
    const p2 = await call('cashier', 'POST', `/check-split/payments/${cardLeg.id}/settle`, { shiftId: s.id, gatewayRef: 'TERM-777' })
    expect(p2.json().orderCompleted).toBe(true)
    expect((await prisma.payment.count({ where: { orderId: o.id, status: 'pending' } }))).toBe(0)
  })

  it('rider cash on delivery is paid into a drawer and lands on its close as Dr 1015 / Cr 1010', async () => {
    const s = await openShift('cashier')
    const o = await prisma.order.create({ data: { conceptId: conceptA, source: 'servd', fulfilmentType: 'delivery', status: 'completed', completedAt: new Date(), totalCents: 23_000, taxCents: 3_000 } })
    const cod = await prisma.payment.create({ data: { orderId: o.id, method: 'cash', amountCents: 23_000, status: 'pending' } })
    const due = await call('cashier', 'GET', '/pos/cod-due')
    expect(due.json().payments.map((p: { id: string }) => p.id)).toContain(cod.id)
    const r = await call('cashier', 'POST', `/pos/payments/${cod.id}/settle`, { shiftId: s.id })
    expect(r.statusCode).toBe(200)
    expect(r.json().payment.status).toBe('paid')
    await prisma.shift.update({ where: { id: s.id }, data: { status: 'closed', closedAt: new Date(), closingFloatCents: 123_000 } })
    const close = await buildShiftCloseEntry(s.id)
    expect(close.ok).toBe(true)
    if (!close.ok) return
    const rows = close.lines.map((l) => ({ code: l.accountCode, type: l.type, amount: l.amountCents }))
    expect(sum(rows, '1015', 'debit')).toBe(23_000)
    expect(sum(rows, '1010', 'credit')).toBe(23_000)
    expect(close.debits).toBe(close.credits)
  })

  it('a Keenu SUCCESS goes through the one settle; an underpayment does not', async () => {
    const o = await prisma.order.create({ data: { conceptId: conceptA, source: 'servd', fulfilmentType: 'delivery', status: 'preparing', totalCents: 40_000 } })
    const p = await prisma.payment.create({ data: { orderId: o.id, method: 'card', amountCents: 40_000, status: 'pending', gatewayRef: 'KNU-1' } })
    expect(await applyKeenuCallback({ orderId: o.id, transactionId: 'KNU-1', status: 'SUCCESS', amount: 39_000 })).toMatchObject({ result: 'amount_mismatch' })
    const ok = await applyKeenuCallback({ orderId: o.id, transactionId: 'KNU-1', status: 'SUCCESS', amount: 40_000 })
    expect(ok).toMatchObject({ result: 'settled', orderCompleted: false })   // a delivery completes on delivery, not payment
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status).toBe('paid')
    expect(await settlePayment({ paymentId: p.id, via: 'gateway' })).toMatchObject({ alreadySettled: true })
  })
})

// ─── Comps and pay-outs ───────────────────────────────────────────────────────

describe('staff meals ring through the till as a comp', () => {
  it('comps the order in full with a PIN and writes the staff-meal row', async () => {
    const s = await openShift('cashier')
    const o = await prisma.order.create({
      data: { conceptId: conceptA, source: 'pos', status: 'received', totalCents: 20_000, items: { create: [{ name: 'Wrap', quantity: 1, unitPriceCents: 20_000 }] } },
    })
    await expect(compOrder({ orderId: o.id, shiftId: s.id, amountCents: 20_000, reason: 'lunch', actorId: users['cashier']!.id, actorRole: 'cashier', staffMeal: { staffId: users['cashier2']!.id } }))
      .rejects.toMatchObject({ code: 'MANAGER_OVERRIDE_REQUIRED' })
    const r = await call('cashier', 'POST', `/pos/orders/${o.id}/comp`, { amountCents: 20_000, reason: 'lunch', shiftId: s.id, managerOverridePin: PIN, staffMealFor: users['cashier2']!.id })
    expect(r.statusCode).toBe(200)
    expect(r.json().orderCompleted).toBe(true)
    const meal = await prisma.staffMeal.findUniqueOrThrow({ where: { id: r.json().staffMealId } })
    expect(meal.tenantId).toBe(tenantA)
    expect(meal.shiftId).toBe(s.id)
    expect(meal.staffId).toBe(users['cashier2']!.id)
    // The hand-typed log is retired.
    expect((await call('cashier', 'POST', '/trustops/staff-meals', { staffId: users['cashier2']!.id, description: 'x', managerPin: PIN })).statusCode).toBe(410)
  })
})

describe('drawer pay-outs to vendors', () => {
  it('need a PIN, respect the cap, and post like a petty-cash spend (the close skips them)', async () => {
    const s = await openShift('cashier')
    await tillSale(s.id, { totalCents: 300_000, taxCents: 0 })
    const noPin = await call('cashier', 'POST', `/pos/shifts/${s.id}/cash-movements`, { type: 'payout', amountCents: 5_000, reason: 'Ice', category: 'cleaning' })
    expect(noPin.json().error.code).toBe('MANAGER_OVERRIDE_REQUIRED')
    const overCap = await call('cashier', 'POST', `/pos/shifts/${s.id}/cash-movements`, { type: 'payout', amountCents: 600_000, reason: 'Big', category: 'repairs', managerOverridePin: PIN })
    expect(overCap.json().error.code).toBe('OVER_PAYOUT_CAP')
    const noCat = await call('cashier', 'POST', `/pos/shifts/${s.id}/cash-movements`, { type: 'payout', amountCents: 5_000, reason: 'What', managerOverridePin: PIN })
    expect(noCat.json().error.code).toBe('PAYOUT_CATEGORY_REQUIRED')
    const ok = await call('cashier', 'POST', `/pos/shifts/${s.id}/cash-movements`, { type: 'payout', amountCents: 5_000, reason: 'Detergent', category: 'cleaning', managerOverridePin: PIN })
    expect(ok.statusCode).toBe(201)
    expect(ok.json().managerOverridePin).not.toBe(PIN)
    const je = await entry(`pos.payout:${ok.json().id}`)
    expect(sum(je!.rows, '6040', 'debit')).toBe(5_000)
    expect(sum(je!.rows, '1015', 'credit')).toBe(5_000)

    await prisma.shift.update({ where: { id: s.id }, data: { status: 'closed', closedAt: new Date(), closingFloatCents: 100_000 + 300_000 - 5_000 } })
    const close = await buildShiftCloseEntry(s.id)
    expect(close.ok).toBe(true)
    if (!close.ok) return
    expect(close.lines.filter((l) => l.memo?.includes('pay-outs'))).toHaveLength(0)
    expect(close.lines.filter((l) => l.accountCode === '8010')).toHaveLength(0)
    expect(close.debits).toBe(close.credits)
  })

  it('a drop needs no PIN', async () => {
    const s = await openShift('cashier')
    const m = await recordCashMovement({ shiftId: s.id, type: 'drop', amountCents: 10_000, reason: 'Safe', actorId: users['cashier']!.id, actorRole: 'cashier' })
    expect(m.type).toBe('drop')
  })
})

// ─── Period locks ─────────────────────────────────────────────────────────────

describe('period locks — one write path', () => {
  it('closes forward only; reopening is admin only, audited and flagged', async () => {
    const close = await call('admin', 'POST', '/accounting/period-close', { lockedThrough: '2026-01-31', note: 'Jan' })
    expect(close.statusCode).toBe(201)
    expect((await call('admin', 'POST', '/accounting/period-close', { lockedThrough: '2026-01-15' })).json().error.code).toBe('LOCK_CANNOT_REGRESS')
    const hist = await call('finance', 'GET', '/accounting/period-close/history')
    expect(hist.statusCode).toBe(200)
    expect(hist.json().locks).toHaveLength(1)

    expect((await call('finance', 'POST', '/accounting/period-close/reopen', { reason: 'fix a posting' })).statusCode).toBe(403)
    const re = await call('admin', 'POST', '/accounting/period-close/reopen', { reason: 'fix a posting' })
    expect(re.statusCode).toBe(200)
    expect(await prisma.periodLock.count({ where: { tenantId: tenantA } })).toBe(0)
    expect(await prisma.auditLog.count({ where: { tenantId: tenantA, category: 'accounting', action: 'period.reopen' } })).toBe(1)
    expect(await prisma.exceptionFlag.count({ where: { tenantId: tenantA, kind: 'period_reopened' } })).toBe(1)
  })
})

// ─── Unposted shifts (decision 6) ─────────────────────────────────────────────

describe('backfill — unposted shifts post into the current open month', () => {
  it('dry run lists; apply posts a locked-month shift today with a memo naming its date', async () => {
    const s = await openShift('cashier')
    await tillSale(s.id, { totalCents: 20_000, taxCents: 0 })
    const oldClose = new Date('2026-02-10T12:00:00Z')
    await prisma.shift.update({ where: { id: s.id }, data: { status: 'closed', closedAt: oldClose, closingFloatCents: 120_000 } })
    await prisma.periodLock.create({ data: { tenantId: tenantA, lockedThrough: new Date('2026-02-28T18:59:59.999Z'), lockedBy: users['admin']!.id } })

    const dry = await call('admin', 'POST', '/reconciliation/backfill-unposted', { dryRun: true })
    expect(dry.statusCode).toBe(200)
    expect(dry.json().rows.find((r: { shiftId: string }) => r.shiftId === s.id).outcome).toBe('would_post_into_current_month')
    expect(await entry(`shift.close:${s.id}`)).toBeNull()
    expect((await call('mgr', 'POST', '/reconciliation/backfill-unposted', { dryRun: false })).statusCode).toBe(403)

    const run = await call('admin', 'POST', '/reconciliation/backfill-unposted', { dryRun: false })
    expect(run.json().rows.find((r: { shiftId: string }) => r.shiftId === s.id).outcome).toBe('posted_into_current_month')
    const je = await entry(`shift.close:${s.id}`)
    expect(je!.entryDate.getTime()).toBeGreaterThan(new Date('2026-02-28T19:00:00Z').getTime())
    expect(je!.description).toContain('closed 10 Feb 2026'.slice(0, 6))
    // The lock was not touched.
    expect(await prisma.periodLock.count({ where: { tenantId: tenantA } })).toBe(1)
    await prisma.periodLock.deleteMany({ where: { tenantId: tenantA } })
  })
})

// ─── Allocations and the brand P&L ────────────────────────────────────────────

describe('shared costs — posted allocations and one head-office line', () => {
  it('a run tags each brand; an overlapping run is refused; unallocated cost stays head office', async () => {
    const at = new Date('2026-03-15T12:00:00Z')
    const { postJournalEntry } = await import('../src/modules/accounting/journal.js')
    await postJournalEntry({ tenantId: tenantA, sourceType: 'test.rent', sourceId: 'mar', description: 'Rent', entryDate: at, lines: [
      { accountCode: '6010', type: 'debit', amountCents: 1_000_000 }, { accountCode: '1020', type: 'credit', amountCents: 1_000_000 },
    ] })
    await postJournalEntry({ tenantId: tenantA, sourceType: 'test.software', sourceId: 'mar', description: 'Software', entryDate: at, lines: [
      { accountCode: '6070', type: 'debit', amountCents: 200_000 }, { accountCode: '1020', type: 'credit', amountCents: 200_000 },
    ] })
    const rule = await prisma.costAllocationRule.create({
      data: { tenantId: tenantA, name: 'Rent split', sourceAccountCode: '6010', driver: 'fixed_pct', weights: { create: [{ conceptId: conceptA, weightBps: 6000 }, { conceptId: conceptA2, weightBps: 4000 }] } },
    })
    const periodStart = new Date('2026-03-01T00:00:00Z'), periodEnd = new Date('2026-03-31T18:59:59Z')
    const run = await runAllocationRule({ ruleId: rule.id, periodStart, periodEnd, postedById: users['admin']!.id, tenantId: tenantA })
    const je = await entry(`allocation.run:${run.runId}`)
    expect(je!.rows.filter((r) => r.type === 'debit').map((r) => r.conceptId).sort()).toEqual([conceptA, conceptA2].sort())
    await expect(runAllocationRule({ ruleId: rule.id, periodStart: new Date('2026-03-10T00:00:00Z'), periodEnd, postedById: users['admin']!.id, tenantId: tenantA }))
      .rejects.toMatchObject({ code: 'RUN_OVERLAPS' })

    const pnl = await brandPnl([tenantA], periodStart, periodEnd, [{ id: conceptA, name: 'Cafe' }, { id: conceptA2, name: 'Diner' }])
    expect(pnl.brands.find((b) => b.conceptId === conceptA)!.opexCents).toBe(600_000)
    expect(pnl.brands.find((b) => b.conceptId === conceptA2)!.opexCents).toBe(400_000)
    // Software had no rule: one head-office line, not spread.
    expect(pnl.headOffice.name).toBe('Company overhead (unallocated)')
    expect(pnl.headOffice.opexCents).toBe(200_000)
    expect(pnl.company.opexCents).toBe(1_200_000)
  })
})

// ─── OpEx actuals ─────────────────────────────────────────────────────────────

describe('OpEx — marking a payment paid posts it from the line\'s bank', () => {
  it('posts, reposts on edit, reverses on un-pay; payroll never posts; unmapped is refused', async () => {
    const bank = await prisma.bankAccount.create({ data: { tenantId: tenantA, name: 'HBL Ops', accountCode: '1020' } })
    const rentCat = await prisma.opexCategory.create({ data: { tenantId: tenantA, name: 'Rent' } })
    const line = await prisma.opexLine.create({ data: { categoryId: rentCat.id, name: 'Shop rent', amountCents: 500_000, bankAccountId: bank.id, conceptId: conceptA } })
    const create = await call('admin', 'POST', '/opex/payments', {
      lineId: line.id, periodStart: '2026-09-01', periodEnd: '2026-09-30', expectedCents: 500_000, actualCents: 520_000, paidAt: '2026-09-05',
    })
    expect(create.statusCode).toBe(201)
    const pid = create.json().id
    expect(create.json().ledger.status).toBe('posted')
    let je = await entry(`opex.payment:${pid}`)
    expect(sum(je!.rows, '6010', 'debit')).toBe(520_000)
    expect(sum(je!.rows, '1020', 'credit')).toBe(520_000)
    expect(je!.rows.find((r) => r.code === '6010')!.conceptId).toBe(conceptA)

    // Unchanged save → nothing new.
    await call('admin', 'PATCH', `/opex/payments/${pid}`, { notes: 'receipt filed' })
    expect(await prisma.journalEntry.count({ where: { tenantId: tenantA, reference: { contains: pid } } })).toBe(1)
    // Amount corrected → reversal + repost.
    await call('admin', 'PATCH', `/opex/payments/${pid}`, { actualCents: 510_000 })
    expect(await entry(`opex.payment.reversal:${pid}`)).toBeTruthy()
    je = await entry(`opex.payment:${pid}@2`)
    expect(sum(je!.rows, '6010', 'debit')).toBe(510_000)
    // Un-paid → reversed.
    await call('admin', 'PATCH', `/opex/payments/${pid}`, { paidAt: null })
    expect(await entry(`opex.payment.reversal:${pid}@2`)).toBeTruthy()

    const list = await call('admin', 'GET', '/opex/categories')
    const pay = list.json().flatMap((c: { lines: Array<{ payments: Array<{ id: string; ledger: { status: string } }> }> }) => c.lines.flatMap((l) => l.payments)).find((p: { id: string }) => p.id === pid)
    expect(pay.ledger.status).toBe('not_paid')

    // Payroll: HR posts wages — never here.
    const payroll = await prisma.opexCategory.create({ data: { tenantId: tenantA, name: 'Payroll' } })
    const pl = await prisma.opexLine.create({ data: { categoryId: payroll.id, name: 'Salaries', amountCents: 1_000_000 } })
    const pp = await call('admin', 'POST', '/opex/payments', { lineId: pl.id, periodStart: '2026-09-01', periodEnd: '2026-09-30', expectedCents: 1_000_000, paidAt: '2026-09-30' })
    expect(pp.json().ledger.status).toBe('payroll')
    expect(await prisma.journalEntry.count({ where: { reference: { contains: pp.json().id } } })).toBe(0)

    // A category the mapping can't place: refused (and not saved), until the account is named.
    const odd = await prisma.opexCategory.create({ data: { tenantId: tenantA, name: 'Miscellany' } })
    const ol = await prisma.opexLine.create({ data: { categoryId: odd.id, name: 'Stuff', amountCents: 10_000 } })
    const bad = await call('admin', 'POST', '/opex/payments', { lineId: ol.id, periodStart: '2026-09-01', periodEnd: '2026-09-30', expectedCents: 10_000, paidAt: '2026-09-10' })
    expect(bad.json().error.code).toBe('CATEGORY_NOT_MAPPED')
    expect(await prisma.opexPayment.count({ where: { lineId: ol.id } })).toBe(0)
    const named = await call('admin', 'POST', '/opex/payments', { lineId: ol.id, periodStart: '2026-09-01', periodEnd: '2026-09-30', expectedCents: 10_000, paidAt: '2026-09-10', expenseAccountCode: '6040' })
    expect(named.statusCode).toBe(201)
    const nj = await entry(`opex.payment:${named.json().id}`)
    expect(sum(nj!.rows, '6040', 'debit')).toBe(10_000)
  })
})

// ─── Capex ───────────────────────────────────────────────────────────────────

describe('capex — advances, capitalised on delivery; rent prepaid; fees expensed', () => {
  it('books each kind of instalment and capitalises a delivered item against its advances', async () => {
    const project = await prisma.capexProject.create({ data: { tenantId: tenantA, conceptId: conceptA, name: 'Cafe fit-out' } })
    const oven = await prisma.capexLine.create({ data: { projectId: project.id, scope: 'Equipment', item: 'Combi oven', unitCostCents: 3_000_000, negotiatedCents: 3_000_000, status: 'ordered' } })
    const rent = await prisma.capexLine.create({ data: { projectId: project.id, scope: 'SoftCosts', item: 'Rent advance (3 months)', unitCostCents: 900_000 } })
    const broker = await prisma.capexLine.create({ data: { projectId: project.id, scope: 'SoftCosts', item: 'Broker commission', unitCostCents: 200_000 } })

    const dep = await call('admin', 'POST', `/finance/capex/lines/${oven.id}/payments`, { label: 'deposit', amountCents: 1_000_000, paidAt: '2026-09-02', paidAmountCents: 1_000_000 })
    expect(dep.statusCode).toBe(201)
    let je = await entry(`capex.payment:${dep.json().id}`)
    expect(sum(je!.rows, '1340', 'debit')).toBe(1_000_000)
    expect(sum(je!.rows, '1020', 'credit')).toBe(1_000_000)

    // A rent advance says which months it covers (H25: released monthly).
    const noTerm = await call('admin', 'POST', `/finance/capex/lines/${rent.id}/payments`, { label: 'deposit', amountCents: 900_000, paidAt: '2026-09-02' })
    expect(noTerm.json().error.code).toBe('PREPAID_TERM_REQUIRED')
    const rp = await call('admin', 'POST', `/finance/capex/lines/${rent.id}/payments`, { label: 'deposit', amountCents: 900_000, paidAt: '2026-09-02', coversFrom: '2026-09', coversMonths: 3 })
    expect(rp.statusCode).toBe(201)
    je = await entry(`capex.payment:${rp.json().id}`)
    expect(sum(je!.rows, '1310', 'debit')).toBe(900_000)
    const bp = await call('admin', 'POST', `/finance/capex/lines/${broker.id}/payments`, { label: 'deposit', amountCents: 200_000, paidAt: '2026-09-02' })
    je = await entry(`capex.payment:${bp.json().id}`)
    expect(sum(je!.rows, '6110', 'debit')).toBe(200_000)
    expect(je!.rows.find((r) => r.code === '6110')!.conceptId).toBe(conceptA)

    // Not delivered yet.
    const early = await call('admin', 'POST', `/finance/capex/lines/${oven.id}/capitalise`, { classKey: 'kitchen_equipment', usefulLifeMonths: 60 })
    expect(early.json().error.code).toBe('NOT_DELIVERED')
    // A fee never becomes an asset.
    await prisma.capexLine.update({ where: { id: broker.id }, data: { status: 'delivered' } })
    expect((await call('admin', 'POST', `/finance/capex/lines/${broker.id}/capitalise`, { classKey: 'kitchen_equipment', usefulLifeMonths: 60 })).json().error.code).toBe('NOT_CAPITAL')

    await prisma.capexLine.update({ where: { id: oven.id }, data: { status: 'delivered', actualDeliveryDate: new Date('2026-09-20T12:00:00Z') } })
    // The CEO's own preparation applies at once (201).
    const cap = await call('admin', 'POST', `/finance/capex/lines/${oven.id}/capitalise`, { classKey: 'kitchen_equipment', usefulLifeMonths: 60 })
    expect(cap.statusCode, cap.body).toBe(201)
    expect(cap.json().applied).toBe(true)
    const assetId = cap.json().assetIds[0] as string
    // The link is a column — never the notes.
    expect((await prisma.fixedAsset.findUniqueOrThrow({ where: { id: assetId } })).capexLineId).toBe(oven.id)
    je = await entry(`fixed_asset.acquire:${assetId}`)
    expect(sum(je!.rows, '1510', 'debit')).toBe(3_000_000)
    expect(sum(je!.rows, '1340', 'credit')).toBe(1_000_000)
    expect(sum(je!.rows, '2012', 'credit')).toBe(2_000_000)
    expect((await call('admin', 'POST', `/finance/capex/lines/${oven.id}/capitalise`, { classKey: 'kitchen_equipment', usefulLifeMonths: 60 })).statusCode).toBe(409)

    // The balance paid after delivery settles the capital supplier (2012).
    const bal = await call('admin', 'POST', `/finance/capex/lines/${oven.id}/payments`, { label: 'balance', amountCents: 2_000_000, paidAt: '2026-09-25' })
    je = await entry(`capex.payment:${bal.json().id}`)
    expect(sum(je!.rows, '2012', 'debit')).toBe(2_000_000)

    const view = await call('admin', 'GET', `/finance/capex/${project.id}`)
    expect(view.json().books.capitalisedCents).toBe(3_000_000)
    expect(view.json().books.notYetCapitalisedCents).toBe(0)
    expect(view.json().books.prepaidCents).toBe(900_000)
    expect(view.json().lines.find((l: { id: string }) => l.id === oven.id).capitalisation.assetIds).toEqual([assetId])

    // A legacy line whose capitalisation credited 2010: later payments settle 2010.
    const old = await prisma.capexLine.create({ data: { projectId: project.id, scope: 'Equipment', item: 'Old fryer', unitCostCents: 500_000, status: 'delivered', actualDeliveryDate: new Date('2026-09-05T12:00:00Z') } })
    const legacy = await prisma.fixedAsset.create({ data: { tenantId: tenantA, name: 'Old fryer', category: 'kitchen_equipment', acquiredAt: new Date('2026-09-05T12:00:00Z'), costCents: 500_000, originalCostCents: 500_000, usefulLifeMonths: 60, capexLineId: old.id, acquisitionCreditCode: '2010' } })
    const { postJournalEntry } = await import('../src/modules/accounting/journal.js')
    await postJournalEntry({ tenantId: tenantA, sourceType: 'fixed_asset.acquire', sourceId: legacy.id, description: 'Legacy capitalisation', entryDate: new Date('2026-09-05T12:00:00Z'), postedBy: 'test', lines: [
      { accountCode: '1510', type: 'debit', amountCents: 500_000 }, { accountCode: '2010', type: 'credit', amountCents: 500_000 },
    ] })
    const lp = await call('admin', 'POST', `/finance/capex/lines/${old.id}/payments`, { label: 'balance', amountCents: 500_000, paidAt: '2026-09-26' })
    expect(sum((await entry(`capex.payment:${lp.json().id}`))!.rows, '2010', 'debit')).toBe(500_000)

    // The old capital-ledger writer is gone; the ProForma API too.
    expect((await call('admin', 'POST', '/finance/capital-ledger', { date: '2026-09-01', amountCents: 1, description: 'x' })).statusCode).toBe(404)
    expect((await call('admin', 'GET', '/finance/projections')).statusCode).toBe(404)
  })
})

// ─── Projections labour ──────────────────────────────────────────────────────

describe('projections labour — frozen seats out, JV contribution netted', () => {
  it('one rule', async () => {
    await prisma.position.createMany({ data: [
      { tenantId: tenantB, conceptId: null, title: 'CFO', monthlySalaryCents: 800_000, tenantCostShareCents: 800_000, status: 'filled' },
      { tenantId: tenantB, conceptId: null, title: 'Analyst', monthlySalaryCents: 200_000, tenantCostShareCents: 200_000, status: 'frozen' },
      { tenantId: tenantB, conceptId: null, title: 'Buyer', monthlySalaryCents: 100_000, tenantCostShareCents: 100_000, headcount: 2, status: 'open' },
    ] })
    await prisma.tenantContribution.create({ data: { sourceTenantId: tenantA, destinationTenantId: tenantB, monthlyCents: 500_000, label: 'JV HO contribution' } })
    const l = await monthlyLabourCents(tenantB)
    expect(l.seatsCents).toBe(1_000_000)
    expect(l.incomingContributionCents).toBe(500_000)
    expect(l.netCents).toBe(500_000)
    expect(l.openSeats).toBe(2)
  })
})
