// Till audit (2026-10-10) — the money paths, regression tests for the
// simulated lunch + dinner service's findings. Two companies throughout:
// company B's staff get 404 on company A's rows, and nothing B does lands on A.
//
//   FOH-03 / BOH-02  a void re-prices the bill (cash and card agree)
//   FOH-16           no void on a paid / partly paid bill
//   FOH-04           one payment per bill, however many cashiers tap at once;
//                    an idempotency key on the payment returns the first result
//   FOH-05           one refund of the money, however many are fired at once
//   FOH-06 / FOH-07  ring-up keys: server UUIDs, never another company's order
//   FOH-08           add-ons priced from the menu; under-pricing needs a PIN
//   FOH-09           a cancelled order takes no money
//   FOH-10           a bill split all-card is taxed at the card rate
//   FOH-14           a tip at the till
//   FOH-15           money only onto your own drawer (or a manager's say)
//   FOH-24 / FOH-26  tendered ≥ amount; "drawer closed" says so
//   BOOKS-05 / ONL-16 refunds only of money received, the way it came
//   Till UI          GET /pos/orders/:id/quote, POST /pos/quote, paymentMethod on ring-up
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { setManagerPin } from '../src/modules/auth/managerPin.js'
import { AppError, errorResponse } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { invalidateSetupCache } from '../src/lib/setup-config.js'
import { posRoutes } from '../src/modules/pos/routes.js'
import { checkSplitRoutes, scalePortions } from '../src/modules/checkSplit/routes.js'
import { orderRoutes } from '../src/modules/orders/routes.js'

const PIN = '472915'
let app: FastifyInstance
let tenantA: string, tenantB: string
let conceptA: string, conceptB: string
const item: Record<string, string> = {}
let nalli: string
const users: Record<string, { id: string; token: string }> = {}
const drawers: Record<string, string> = {}

async function mkUser(key: string, role: string, tenantId: string) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.tillmoney@gsfoods.pk`, password: await bcrypt.hash('x-Password-1', 4), role: role as never, isActive: true, accountStatus: 'active', tenantId },
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } as never }).catch(() => {})
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
  return u
}

const call = (who: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as never, headers: { authorization: `Bearer ${users[who]!.token}` } })

/** A fresh open drawer for `who` (any earlier one closed first). */
async function drawer(who: string): Promise<string> {
  await prisma.shift.updateMany({ where: { userId: users[who]!.id, status: 'open' }, data: { status: 'closed', closedAt: new Date(), closingFloatCents: 0 } })
  const r = await call(who, 'POST', '/pos/shifts/open', { openingFloatCents: 100_000 })
  expect(r.statusCode).toBe(201)
  drawers[who] = r.json().id
  return drawers[who]!
}

type Line = { menuItemId: string | null; name: string; quantity: number; unitPriceCents: number; modifiers?: Array<{ name: string; priceDeltaCents?: number; modifierId?: string }> }
const NIHARI = (q = 1): Line => ({ menuItemId: item['nihari']!, name: 'Beef Nihari', quantity: q, unitPriceCents: 145_000 })
const KHEER = (q = 1): Line => ({ menuItemId: item['kheer']!, name: 'Kheer', quantity: q, unitPriceCents: 55_000 })
const KARAHI = (q = 1): Line => ({ menuItemId: item['karahi']!, name: 'Chicken Karahi', quantity: q, unitPriceCents: 185_000 })

async function ring(who: string, items: Line[], extra: Record<string, unknown> = {}) {
  const r = await call(who, 'POST', '/pos/orders', { conceptId: conceptA, items: items.map((i) => ({ modifiers: [], ...i })), ...extra })
  expect(r.statusCode, r.body).toBe(201)
  return r.json() as { id: string; totalCents: number; taxCents: number; items: Array<{ id: string; name: string }> }
}

async function waitFor<T>(read: () => Promise<T>, done: (v: T) => boolean, ms = 5000): Promise<T> {
  const until = Date.now() + ms
  let v = await read()
  while (!done(v) && Date.now() < until) { await new Promise((r) => setTimeout(r, 50)); v = await read() }
  return v
}

const statuses = (rs: Array<{ statusCode: number }>) => rs.map((r) => r.statusCode).sort()

beforeAll(async () => {
  tenantB = (await prisma.tenant.create({ data: { name: 'Karachi Grill Co', slug: 'tillmoney-b' } })).id
  tenantA = (await prisma.tenant.create({ data: { name: 'GS Foods', slug: 'tillmoney-a' } })).id
  await ensureChartOfAccounts(tenantA)
  await ensureChartOfAccounts(tenantB)
  conceptA = (await prisma.concept.create({ data: { name: 'Simmer', slug: 'simmer', type: 'restaurant', tenantId: tenantA, taxRate: 17, taxRateCash: 15, taxRateCard: 8 } })).id
  conceptB = (await prisma.concept.create({ data: { name: 'Grill House', slug: 'grill-house', type: 'restaurant', tenantId: tenantB, taxRate: 17, taxRateCash: 15, taxRateCard: 8 } })).id
  const catA = await prisma.category.create({ data: { conceptId: conceptA, name: 'Mains' } })
  const catB = await prisma.category.create({ data: { conceptId: conceptB, name: 'Mains' } })
  item['nihari'] = (await prisma.menuItem.create({ data: { conceptId: conceptA, categoryId: catA.id, name: 'Beef Nihari', priceCents: 145_000 } })).id
  item['kheer'] = (await prisma.menuItem.create({ data: { conceptId: conceptA, categoryId: catA.id, name: 'Kheer', priceCents: 55_000 } })).id
  item['karahi'] = (await prisma.menuItem.create({ data: { conceptId: conceptA, categoryId: catA.id, name: 'Chicken Karahi', priceCents: 185_000 } })).id
  item['chapli'] = (await prisma.menuItem.create({ data: { conceptId: conceptB, categoryId: catB.id, name: 'Chapli Burger', priceCents: 90_000 } })).id
  const group = await prisma.modifierGroup.create({ data: { menuItemId: item['nihari']!, name: 'Extras' } })
  nalli = (await prisma.modifier.create({ data: { groupId: group.id, name: 'Nalli', priceDeltaCents: 35_000 } })).id

  await mkUser('cashier1', 'cashier', tenantA)
  await mkUser('cashier2', 'cashier', tenantA)
  await mkUser('waiter', 'foh', tenantA)
  const mgr = await mkUser('mgrA', 'foh_management', tenantA)
  await setManagerPin(mgr.id, PIN)
  await mkUser('cashierB', 'cashier', tenantB)

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
}, 60_000)

afterAll(async () => {
  invalidateSetupCache()
  await app.close()
})

const pay = (who: string, orderId: string, payments: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) =>
  call(who, 'POST', '/pos/payments', { orderId, shiftId: drawers[who] ?? drawers['cashier1'], payments, ...extra })

// ─── FOH-03 / BOH-02 / FOH-16 — voids ─────────────────────────────────────────

describe('FOH-03 — a void takes the line off the bill', () => {
  it('Nihari + 2 Kheer, Kheer voided: the bill, the receipt and the cash taken all say 1,667.50', async () => {
    const o = await ring('cashier1', [NIHARI(), KHEER(2)])
    expect(o.totalCents).toBe(293_250)
    const kheer = o.items.find((i) => i.name === 'Kheer')!
    const v = await call('mgrA', 'POST', `/pos/orders/${o.id}/void`, { orderItemId: kheer.id, reason: 'guest allergic' })
    expect(v.statusCode, v.body).toBe(200)
    expect(v.json()).toMatchObject({ status: 'voided', order: { totalCents: 166_750, taxCents: 21_750 }, removedCents: 126_500 })

    const row = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })
    expect(row).toMatchObject({ totalCents: 166_750, taxCents: 21_750 })
    // An open order has no full & final bill yet (§17.1) — the till prints a pre-bill.
    const early = await call('cashier1', 'GET', `/pos/orders/${o.id}/receipt-data`)
    expect(early.statusCode).toBe(409)
    expect(early.json().error.code).toBe('PRE_BILL_REQUIRED')

    const quote = (await call('cashier1', 'GET', `/pos/orders/${o.id}/quote?method=cash`)).json()
    expect(quote.dueCents).toBe(166_750)
    const p = await pay('cashier1', o.id, [{ method: 'cash', amountCents: 166_750, tenderedCents: 170_000 }])
    expect(p.statusCode, p.body).toBe(201)
    expect(p.json().orderCompleted).toBe(true)
    const receipt = (await call('cashier1', 'GET', `/pos/orders/${o.id}/receipt-data`)).json()
    expect(receipt).toMatchObject({ subtotalCents: 145_000, taxCents: 21_750, totalCents: 166_750 })
  })

  it('paid by card after a void, the card bill is the same lines at 8% — and matches the quote', async () => {
    const o = await ring('cashier1', [NIHARI(), KHEER()])
    await call('mgrA', 'POST', `/pos/orders/${o.id}/void`, { orderItemId: o.items.find((i) => i.name === 'Kheer')!.id, reason: 'changed mind' })
    const quote = (await call('cashier1', 'GET', `/pos/orders/${o.id}/quote?method=card`)).json()
    expect(quote).toMatchObject({ totalCents: 156_600, taxCents: 11_600, taxRatePct: 8, dueCents: 156_600, repriced: true })
    const p = await pay('cashier1', o.id, [{ method: 'card', amountCents: 156_600, gatewayRef: 'KEENU-V1' }])
    expect(p.statusCode, p.body).toBe(201)
    expect(await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).toMatchObject({ status: 'completed', totalCents: 156_600, taxRatePct: 8 })
  })

  it('voiding every line leaves nothing due; the till says cancel, not "already paid"', async () => {
    const o = await ring('cashier1', [KARAHI(2)])
    const v = await call('mgrA', 'POST', `/pos/orders/${o.id}/void`, { orderItemId: o.items[0]!.id, reason: 'walked out before cooking' })
    expect(v.json().order).toMatchObject({ totalCents: 0, taxCents: 0 })
    const p = await pay('cashier1', o.id, [{ method: 'cash', amountCents: 1 }])
    expect(p.statusCode).toBe(409)
    expect(p.json().error.code).toBe('NOTHING_DUE')
  })

  it('a void clears check-split portions that no longer add up', async () => {
    const o = await ring('cashier1', [NIHARI(), KHEER()])
    expect((await call('cashier1', 'POST', `/check-split/orders/${o.id}/split-evenly`, { ways: 2, method: 'cash' })).statusCode).toBe(200)
    const v = await call('mgrA', 'POST', `/pos/orders/${o.id}/void`, { orderItemId: o.items.find((i) => i.name === 'Kheer')!.id, reason: 'not wanted' })
    expect(v.json().splitCleared).toBe(true)
    expect(await prisma.payment.count({ where: { orderId: o.id, status: 'pending' } })).toBe(0)
  })

  it('FOH-16: no void on a paid bill (refund it) or one with a comp on it', async () => {
    const paid = await ring('cashier1', [KARAHI(), KHEER()])
    await pay('cashier1', paid.id, [{ method: 'cash', amountCents: paid.totalCents }])
    const v1 = await call('mgrA', 'POST', `/pos/orders/${paid.id}/void`, { orderItemId: paid.items[0]!.id, reason: 'after payment' })
    expect(v1.statusCode).toBe(422)
    expect(v1.json().error.code).toBe('ORDER_PAID')
    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: paid.items[0]!.id } })).status).not.toBe('voided')

    const comped = await ring('cashier1', [KARAHI(), KHEER()])
    expect((await call('mgrA', 'POST', `/pos/orders/${comped.id}/comp`, { amountCents: 10_000, reason: 'slow service', shiftId: drawers['cashier1'] })).statusCode).toBe(200)
    // TILL-R3: a comp (or part payment) that still fits the bill without the
    // line does not block the void — the bill comes down, the comp stays.
    const v2 = await call('mgrA', 'POST', `/pos/orders/${comped.id}/void`, { orderItemId: comped.items[0]!.id, reason: 'x' })
    expect(v2.statusCode, v2.body).toBe(200)
    expect(v2.json().order.totalCents).toBe(63_250)
    expect(v2.json().refund).toBeNull()
  })

  it('a void racing the payment: either the void wins (payment refused) or the payment wins (void refused) — never both', async () => {
    for (let i = 0; i < 3; i++) {
      const o = await ring('cashier1', [NIHARI(), KHEER()])
      const kheer = o.items.find((x) => x.name === 'Kheer')!
      const [v, p] = await Promise.all([
        call('mgrA', 'POST', `/pos/orders/${o.id}/void`, { orderItemId: kheer.id, reason: 'race' }),
        pay('cashier1', o.id, [{ method: 'cash', amountCents: o.totalCents }]),
      ])
      expect([v.statusCode, p.statusCode].sort()).toEqual(v.statusCode === 200 ? [200, 400] : [201, 422])
      const row = await prisma.order.findUniqueOrThrow({ where: { id: o.id }, include: { payments: true, items: true } })
      const paidCents = row.payments.filter((x) => x.status === 'paid').reduce((s, x) => s + x.amountCents, 0)
      if (p.statusCode === 201) {
        expect(row.items.every((x) => x.status !== 'voided')).toBe(true)
        expect(paidCents).toBe(row.totalCents)
      } else {
        expect(paidCents).toBe(0)
        expect(row.totalCents).toBe(166_750)
      }
    }
  })
})

// ─── FOH-04 — concurrent payments ─────────────────────────────────────────────

describe('FOH-04 — one bill is paid once', () => {
  it('two cashiers settling the same table at once: exactly one takes the money', async () => {
    const o = await ring('cashier1', [NIHARI(2)])
    expect(o.totalCents).toBe(333_500)
    const rs = await Promise.all([
      pay('cashier1', o.id, [{ method: 'cash', amountCents: 333_500 }]),
      pay('cashier2', o.id, [{ method: 'cash', amountCents: 333_500 }]),
    ])
    expect(statuses(rs)).toEqual([201, 400])
    expect(rs.find((r) => r.statusCode === 400)!.json().error.code).toBe('ALREADY_PAID')
    const rows = await prisma.payment.findMany({ where: { orderId: o.id, status: 'paid' } })
    expect(rows.reduce((s, r) => s + r.amountCents, 0)).toBe(333_500)
  })

  it('five taps of the same cash payment: one row', async () => {
    const o = await ring('cashier1', [KHEER()])
    const rs = await Promise.all(Array.from({ length: 5 }, () => pay('cashier1', o.id, [{ method: 'cash', amountCents: 63_250 }])))
    expect(rs.filter((r) => r.statusCode === 201)).toHaveLength(1)
    expect(await prisma.payment.count({ where: { orderId: o.id } })).toBe(1)
  })

  it('a double-tapped card with an idempotency key returns the first result; a different payload under the key is a 409', async () => {
    const o = await ring('cashier1', [KHEER()])
    const key = `pay-${o.id}`
    const body = [{ method: 'card', amountCents: 59_400, gatewayRef: 'KEENU-1' }]
    const rs = await Promise.all([pay('cashier1', o.id, body, { idempotencyKey: key }), pay('cashier1', o.id, body, { idempotencyKey: key })])
    expect(statuses(rs)).toEqual([201, 201])
    expect(rs.map((r) => r.json().replayed).sort()).toEqual([false, true])
    expect(rs[0]!.json().payments[0].id).toBe(rs[1]!.json().payments[0].id)
    expect(rs.every((r) => r.json().orderCompleted === true)).toBe(true)
    expect(await prisma.payment.count({ where: { orderId: o.id } })).toBe(1)

    const other = await pay('cashier1', o.id, [{ method: 'card', amountCents: 59_000, gatewayRef: 'KEENU-1' }], { idempotencyKey: key })
    expect(other.statusCode).toBe(409)
    expect(other.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED')
  })

  it('a double-tapped card WITHOUT a key: the second tap is refused, not charged', async () => {
    const o = await ring('cashier1', [KHEER()])
    const body = [{ method: 'card', amountCents: 59_400, gatewayRef: 'KEENU-2' }]
    const rs = await Promise.all([pay('cashier1', o.id, body), pay('cashier1', o.id, body)])
    expect(statuses(rs)).toEqual([201, 400])
    expect(await prisma.payment.count({ where: { orderId: o.id } })).toBe(1)
  })
})

// ─── FOH-05 — concurrent refunds ──────────────────────────────────────────────

describe('FOH-05 — one refund of the money', () => {
  it('a manager and a cashier refunding the same sale at once: one refund, one journal entry', async () => {
    const o = await ring('cashier1', [NIHARI()])
    await pay('cashier1', o.id, [{ method: 'cash', amountCents: 166_750 }])
    const rs = await Promise.all([
      call('mgrA', 'POST', `/pos/orders/${o.id}/refund`, { amountCents: 166_750, reason: 'cold food', method: 'cash', shiftId: drawers['cashier1'] }),
      call('cashier1', 'POST', `/pos/orders/${o.id}/refund`, { amountCents: 166_750, reason: 'cold food', method: 'cash', shiftId: drawers['cashier1'], managerOverridePin: PIN }),
    ])
    expect(rs.filter((r) => r.statusCode === 200)).toHaveLength(1)
    const loser = rs.find((r) => r.statusCode !== 200)!
    expect(['REFUND_EXCEEDS_PAID', 'ALREADY_REFUNDED']).toContain(loser.json().error.code)
    const refunds = await prisma.payment.findMany({ where: { orderId: o.id, status: 'refunded' } })
    expect(refunds).toHaveLength(1)
    expect(await prisma.journalEntry.count({ where: { reference: { in: refunds.map((r) => `order.refund:${r.id}`) } } })).toBe(1)
    expect(await prisma.journalEntry.count({ where: { reference: { startsWith: 'order.refund:' }, lines: { some: { memo: { contains: o.id.slice(-8).toUpperCase() } } } } })).toBe(1)
  })

  it('two partial refunds that together exceed the sale: the second is refused under the lock', async () => {
    const o = await ring('cashier1', [NIHARI()])
    await pay('cashier1', o.id, [{ method: 'cash', amountCents: 166_750 }])
    const rs = await Promise.all([
      call('mgrA', 'POST', `/pos/orders/${o.id}/refund`, { amountCents: 100_000, reason: 'part one', shiftId: drawers['cashier1'] }),
      call('mgrA', 'POST', `/pos/orders/${o.id}/refund`, { amountCents: 100_000, reason: 'part two', shiftId: drawers['cashier1'] }),
    ])
    expect(statuses(rs)).toEqual([200, 400])
    const refunded = await prisma.payment.aggregate({ where: { orderId: o.id, status: 'refunded' }, _sum: { amountCents: true } })
    expect(refunded._sum.amountCents).toBe(-100_000)
  })
})

// ─── BOOKS-05 / ONL-16 — refunds of money received, the way it came ──────────

describe('BOOKS-05 / ONL-16 — what can be refunded, and how', () => {
  async function codOrder(cents: number) {
    const o = await prisma.order.create({
      data: { conceptId: conceptA, source: 'servd', fulfilmentType: 'delivery', status: 'completed', completedAt: new Date(), totalCents: cents, taxCents: 0 },
    })
    const p = await prisma.payment.create({ data: { orderId: o.id, method: 'cash', amountCents: cents, status: 'pending' } })
    return { o, p }
  }

  it('cash not yet paid in is not refundable — by cash or by "card"; once paid in, only cash', async () => {
    const { o, p } = await codOrder(287_500)
    for (const method of ['cash', 'card']) {
      const r = await call('mgrA', 'POST', `/pos/orders/${o.id}/refund`, { amountCents: 50_000, reason: 'Missing drink', method, shiftId: drawers['cashier1'] })
      expect(r.statusCode).toBe(422)
      expect(r.json().error.code).toBe('CASH_NOT_PAID_IN')
    }
    expect(await prisma.payment.count({ where: { orderId: o.id, status: 'refunded' } })).toBe(0)

    expect((await call('cashier1', 'POST', `/pos/payments/${p.id}/settle`, { shiftId: drawers['cashier1'] })).statusCode).toBe(200)
    const card = await call('mgrA', 'POST', `/pos/orders/${o.id}/refund`, { amountCents: 50_000, reason: 'Missing drink', method: 'card', shiftId: drawers['cashier1'] })
    expect(card.statusCode).toBe(422)
    expect(card.json().error.code).toBe('REFUND_METHOD_NOT_TENDERED')
    const cash = await call('mgrA', 'POST', `/pos/orders/${o.id}/refund`, { amountCents: 50_000, reason: 'Missing drink', shiftId: drawers['cashier1'] })
    expect(cash.statusCode, cash.body).toBe(200)
    expect(cash.json()).toMatchObject({ method: 'cash', shiftId: drawers['cashier1'] })
  })

  it('a bill paid part cash, part card refunds each tender up to what it took', async () => {
    const o = await ring('cashier1', [KARAHI(2)])
    const split = await call('cashier1', 'POST', `/check-split/orders/${o.id}/split`, { splits: [{ amountCents: 100_000, method: 'cash' }, { amountCents: 325_500, method: 'card' }] })
    expect(split.statusCode, split.body).toBe(200)
    for (const portion of split.json() as Array<{ id: string; method: string }>) {
      const r = await call('cashier1', 'POST', `/check-split/payments/${portion.id}/settle`, { shiftId: drawers['cashier1'], ...(portion.method === 'card' && { gatewayRef: 'T-55' }) })
      expect(r.statusCode, r.body).toBe(200)
    }
    const tooMuchCash = await call('mgrA', 'POST', `/pos/orders/${o.id}/refund`, { amountCents: 150_000, reason: 'over the cash', method: 'cash', shiftId: drawers['cashier1'] })
    expect(tooMuchCash.statusCode).toBe(400)
    expect(tooMuchCash.json().error.code).toBe('REFUND_EXCEEDS_TENDER')
    expect((await call('mgrA', 'POST', `/pos/orders/${o.id}/refund`, { amountCents: 150_000, reason: 'on the card', method: 'card' })).statusCode).toBe(200)
  })
})

// ─── FOH-06 / FOH-07 — ring-up keys ───────────────────────────────────────────

describe('FOH-06 / FOH-07 — ring-up keys never hand over another order', () => {
  it('30 keyless ring-ups from two companies at once: 30 orders, each caller gets its own', async () => {
    const reqs = [
      ...Array.from({ length: 15 }, () => call('waiter', 'POST', '/pos/orders', { conceptId: conceptA, items: [{ ...KHEER(), modifiers: [] }] })),
      ...Array.from({ length: 15 }, () => call('cashierB', 'POST', '/pos/orders', { conceptId: conceptB, items: [{ menuItemId: item['chapli'], name: 'Chapli Burger', quantity: 1, unitPriceCents: 90_000, modifiers: [] }] })),
    ]
    const rs = await Promise.all(reqs)
    expect(rs.every((r) => r.statusCode === 201)).toBe(true)
    const ids = new Set(rs.map((r) => r.json().id))
    expect(ids.size).toBe(30)
    rs.slice(0, 15).forEach((r) => expect(r.json().conceptId).toBe(conceptA))
    rs.slice(15).forEach((r) => expect(r.json().conceptId).toBe(conceptB))
    const keys = await prisma.order.findMany({ where: { id: { in: [...ids] } }, select: { externalId: true } })
    expect(keys.every((k) => /^pos-[0-9a-f-]{36}$/.test(k.externalId ?? ''))).toBe(true)
  })

  it('a key already used by company A is a 409 for company B — never A\'s order', async () => {
    const key = 'pos-verify-o1-1-0000'
    const a = await ring('cashier1', [KARAHI()], { idempotencyKey: key })
    const again = await ring('cashier1', [KARAHI()], { idempotencyKey: key })
    expect(again.id).toBe(a.id)
    const b = await call('cashierB', 'POST', '/pos/orders', { conceptId: conceptB, idempotencyKey: key, items: [{ menuItemId: null, name: 'x', quantity: 1, unitPriceCents: 1, modifiers: [] }] })
    expect(b.statusCode).toBe(409)
    expect(b.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED')
    expect(b.body).not.toContain(a.id)
    // Another cashier of the same company reusing it is a different ring-up too.
    const other = await call('cashier2', 'POST', '/pos/orders', { conceptId: conceptA, idempotencyKey: key, items: [{ ...KARAHI(), modifiers: [] }] })
    expect(other.statusCode).toBe(409)
  })

  it('the same new key from both companies at once: one order, the other caller 409s', async () => {
    const key = `pos-race-${Date.now()}`
    const rs = await Promise.all([
      call('cashier1', 'POST', '/pos/orders', { conceptId: conceptA, idempotencyKey: key, items: [{ ...KHEER(), modifiers: [] }] }),
      call('cashierB', 'POST', '/pos/orders', { conceptId: conceptB, idempotencyKey: key, items: [{ menuItemId: item['chapli'], name: 'Chapli Burger', quantity: 1, unitPriceCents: 90_000, modifiers: [] }] }),
    ])
    expect(statuses(rs)).toEqual([201, 409])
    const won = rs.find((r) => r.statusCode === 201)!
    const wonBy = won === rs[0] ? conceptA : conceptB
    expect(won.json().conceptId).toBe(wonBy)
  })
})

// ─── FOH-08 — add-ons and price overrides ─────────────────────────────────────

describe('FOH-08 — add-ons at menu price; under-pricing needs a manager', () => {
  it('a menu add-on is charged at its menu price whatever the till sends', async () => {
    const o = await ring('cashier1', [{ ...NIHARI(), modifiers: [{ name: 'Nalli', modifierId: nalli, priceDeltaCents: -140_000 }] }])
    expect(o.totalCents).toBe(207_000)   // (1,450 + 350) + 15%
    const mods = await prisma.orderItemModifier.findMany({ where: { orderItem: { orderId: o.id } } })
    expect(mods.map((m) => m.priceDeltaCents)).toEqual([35_000])
  })

  it('a negative free-text add-on, or another dish\'s add-on, is refused', async () => {
    const neg = await call('cashier1', 'POST', '/pos/orders', { conceptId: conceptA, items: [{ ...NIHARI(), modifiers: [{ name: 'discount', priceDeltaCents: -140_000 }] }] })
    expect(neg.statusCode).toBe(422)
    expect(neg.json().error.code).toBe('NEGATIVE_MODIFIER')
    const foreign = await call('cashier1', 'POST', '/pos/orders', { conceptId: conceptA, items: [{ ...KHEER(), modifiers: [{ name: 'Nalli', modifierId: nalli }] }] })
    expect(foreign.statusCode).toBe(422)
    expect(foreign.json().error.code).toBe('INVALID_MODIFIER')
  })

  it('pricing a dish BELOW the menu needs a manager PIN — for a cashier and for a waiter — and is flagged to company A', async () => {
    for (const who of ['cashier1', 'waiter']) {
      const r = await call(who, 'POST', '/pos/orders', { conceptId: conceptA, items: [{ ...NIHARI(), unitPriceCents: 5_000, modifiers: [] }] })
      expect(r.statusCode).toBe(403)
      expect(r.json().error.code).toBe('PRICE_OVERRIDE_BLOCKED')
    }
    const ok = await ring('cashier1', [{ ...NIHARI(), unitPriceCents: 100_000 }], { managerOverridePin: PIN, discountReason: 'regular' })
    expect(ok.totalCents).toBe(115_000)
    const flag = await prisma.exceptionFlag.findFirst({ where: { title: 'Price override on POS order', conceptId: conceptA }, orderBy: { createdAt: 'desc' } })
    expect(flag?.tenantId).toBe(tenantA)
  })
})

// ─── FOH-09 — a cancelled order takes no money ────────────────────────────────

describe('FOH-09 — cancelled means no payment', () => {
  it('pay, comp and split are all refused on a cancelled ticket', async () => {
    const o = await ring('cashier1', [KHEER()])
    expect((await call('mgrA', 'POST', `/orders/${o.id}/cancel`, { reason: 'guest walked out' })).statusCode).toBe(200)
    const p = await pay('cashier1', o.id, [{ method: 'cash', amountCents: 63_250 }])
    expect(p.statusCode).toBe(409)
    expect(p.json().error.code).toBe('ORDER_NOT_OPEN')
    const c = await call('mgrA', 'POST', `/pos/orders/${o.id}/comp`, { amountCents: 63_250, reason: 'x', shiftId: drawers['cashier1'] })
    expect(c.json().error.code).toBe('ORDER_NOT_OPEN')
    const s = await call('cashier1', 'POST', `/check-split/orders/${o.id}/split-evenly`, { ways: 2, method: 'cash' })
    expect(s.json().error.code).toBe('ORDER_NOT_OPEN')
    expect(await prisma.payment.count({ where: { orderId: o.id } })).toBe(0)
  })

  it('a split portion of an order cancelled after the split cannot be settled', async () => {
    const o = await ring('cashier1', [KHEER(2)])
    const split = (await call('cashier1', 'POST', `/check-split/orders/${o.id}/split-evenly`, { ways: 2, method: 'cash' })).json() as Array<{ id: string }>
    await call('mgrA', 'POST', `/orders/${o.id}/cancel`, { reason: 'walked out' })
    const r = await call('cashier1', 'POST', `/check-split/payments/${split[0]!.id}/settle`, { shiftId: drawers['cashier1'] })
    expect(r.statusCode).toBe(409)
    expect(r.json().error.code).toBe('ORDER_NOT_OPEN')
  })
})

// ─── FOH-10 — split bills are re-priced for their tenders ─────────────────────

describe('FOH-10 — a bill split all by card is taxed at the card rate', () => {
  it('split evenly two ways by card: 3,996 not 4,255, and it completes at 8%', async () => {
    const o = await ring('cashier1', [KARAHI(2)])
    expect(o.totalCents).toBe(425_500)
    const split = await call('cashier1', 'POST', `/check-split/orders/${o.id}/split-evenly`, { ways: 2, method: 'card' })
    expect(split.statusCode, split.body).toBe(200)
    const portions = split.json() as Array<{ id: string; amountCents: number }>
    expect(portions.map((p) => p.amountCents)).toEqual([199_800, 199_800])
    // Both portions at once — the settle lock means the last one completes the bill.
    const rs = await Promise.all(portions.map((p, i) => call('cashier1', 'POST', `/check-split/payments/${p.id}/settle`, { shiftId: drawers['cashier1'], gatewayRef: `T-${i}` })))
    expect(rs.every((r) => r.statusCode === 200)).toBe(true)
    expect(rs.filter((r) => r.json().orderCompleted)).toHaveLength(1)
    expect(await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).toMatchObject({ status: 'completed', totalCents: 399_600, taxCents: 29_600, taxRatePct: 8 })
  })

  it('custom card portions worked out from the cash total are scaled onto the card total; a mix stays at cash', async () => {
    const o = await ring('cashier1', [KARAHI(2)])
    const r = await call('cashier1', 'POST', `/check-split/orders/${o.id}/split`, { splits: [{ amountCents: 212_750, method: 'card' }, { amountCents: 212_750, method: 'card' }] })
    expect(r.statusCode, r.body).toBe(200)
    expect((r.json() as Array<{ amountCents: number }>).map((p) => p.amountCents)).toEqual([199_800, 199_800])

    // Re-split with a cash portion → back to the cash rate (a mix is cash);
    // portions worked out from the card total are scaled back up.
    const mixed = await call('cashier1', 'POST', `/check-split/orders/${o.id}/split`, { splits: [{ amountCents: 199_800, method: 'cash' }, { amountCents: 199_800, method: 'card' }] })
    expect(mixed.statusCode, mixed.body).toBe(200)
    expect((mixed.json() as Array<{ amountCents: number }>).map((p) => p.amountCents)).toEqual([212_750, 212_750])
    expect(await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).toMatchObject({ totalCents: 425_500, taxRatePct: 15 })
    expect(await prisma.payment.count({ where: { orderId: o.id, status: 'pending' } })).toBe(2)

    // Portions that add up to neither total: refused, with the total to split.
    const wrong = await call('cashier1', 'POST', `/check-split/orders/${o.id}/split`, { splits: [{ amountCents: 1_000, method: 'card' }, { amountCents: 1_000, method: 'card' }] })
    expect(wrong.statusCode).toBe(422)
    expect(wrong.json().error).toMatchObject({ code: 'SPLIT_TOTAL_MISMATCH', details: { totalCents: 399_600 } })
    // …and the refused split re-priced nothing.
    expect(await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).toMatchObject({ totalCents: 425_500, taxRatePct: 15 })
  })

  it('scalePortions keeps the proportions and adds up exactly', () => {
    expect(scalePortions([1, 1, 1], 3, 10)).toEqual([4, 3, 3])
    expect(scalePortions([212_750, 212_750], 425_500, 399_600)).toEqual([199_800, 199_800])
    expect(scalePortions([1, 99], 100, 50)).toEqual([1, 49])
  })
})

// ─── FOH-14 — tips ────────────────────────────────────────────────────────────

describe('FOH-14 — a tip at the till', () => {
  it('a card tip rides on the order (tipCents and total), the receipt and the Z-report', async () => {
    const s = await drawer('cashier2')
    const o = await ring('cashier2', [KHEER()], { shiftId: s })
    const bad = await pay('cashier2', o.id, [{ method: 'card', amountCents: 79_400, gatewayRef: 'KEENU-T', tipCents: 90_000 }])
    expect(bad.json().error.code).toBe('INVALID_TIP')
    const p = await pay('cashier2', o.id, [{ method: 'card', amountCents: 79_400, gatewayRef: 'KEENU-T', tipCents: 20_000 }])
    expect(p.statusCode, p.body).toBe(201)
    expect(p.json().orderCompleted).toBe(true)
    expect(await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).toMatchObject({ tipCents: 20_000, totalCents: 79_400, taxCents: 4_400, taxRatePct: 8 })
    expect((await call('cashier2', 'GET', `/pos/orders/${o.id}/receipt-data`)).json()).toMatchObject({ tipCents: 20_000, totalCents: 79_400, paidCents: 79_400 })
    const z = await call('mgrA', 'GET', `/pos/shifts/${s}/zreport`)
    expect(z.json().tipsCents).toBe(20_000)
  })

  it('a tip does not count toward the bill', async () => {
    const o = await ring('cashier1', [KHEER()])
    const r = await pay('cashier1', o.id, [{ method: 'cash', amountCents: 63_250, tipCents: 10_000 }])
    expect(r.statusCode).toBe(400)
    expect(r.json().error.code).toBe('AMOUNT_MISMATCH')
  })
})

// ─── FOH-15 / FOH-24 / FOH-26 — the drawer ────────────────────────────────────

describe('the drawer the money lands on', () => {
  it('FOH-15: a cashier cannot put takings into another cashier\'s drawer; a manager can', async () => {
    const o = await ring('cashier2', [KHEER()])
    const r = await call('cashier2', 'POST', '/pos/payments', { orderId: o.id, shiftId: drawers['cashier1'], payments: [{ method: 'cash', amountCents: 63_250 }] })
    expect(r.statusCode).toBe(403)
    expect(r.json().error.code).toBe('NOT_YOUR_SHIFT')
    const comp = await call('cashier2', 'POST', `/pos/orders/${o.id}/comp`, { amountCents: 1_000, reason: 'x', shiftId: drawers['cashier1'] })
    expect(comp.statusCode).toBe(403)
    const m = await call('mgrA', 'POST', '/pos/payments', { orderId: o.id, shiftId: drawers['cashier1'], payments: [{ method: 'cash', amountCents: 63_250 }] })
    expect(m.statusCode).toBe(201)
  })

  it('FOH-24: cash handed over below the amount is refused', async () => {
    const o = await ring('cashier1', [KHEER()])
    const r = await pay('cashier1', o.id, [{ method: 'cash', amountCents: 63_250, tenderedCents: 1_000 }])
    expect(r.statusCode).toBe(400)
    expect(r.json().error.code).toBe('TENDERED_LESS_THAN_DUE')
  })

  it('FOH-26: paying onto a closed drawer says the drawer is closed; a foreign drawer is still "not in this company"', async () => {
    const o = await ring('cashier1', [KHEER()])
    const closed = await prisma.shift.create({ data: { userId: users['cashier1']!.id, tenantId: tenantA, status: 'closed', closedAt: new Date(), openingFloatCents: 0, closingFloatCents: 0 } })
    const r = await call('cashier1', 'POST', '/pos/payments', { orderId: o.id, shiftId: closed.id, payments: [{ method: 'cash', amountCents: 63_250 }] })
    expect(r.statusCode).toBe(422)
    expect(r.json().error.code).toBe('SHIFT_CLOSED')
    const f = await call('mgrA', 'POST', '/pos/payments', { orderId: o.id, shiftId: drawers['cashierB'], payments: [{ method: 'cash', amountCents: 63_250 }] })
    expect(f.json().error.code).toBe('SHIFT_NOT_IN_COMPANY')
  })
})

// ─── Till UI — quotes and the tender at ring-up ───────────────────────────────

describe('quotes — exactly what the payment will demand, and nothing written', () => {
  it('cash and card quotes are what POST /pos/payments accepts', async () => {
    for (const [method, expected] of [['cash', 425_500], ['card', 399_600]] as const) {
      const o = await ring('cashier1', [KARAHI(2)])
      const q = await call('cashier1', 'GET', `/pos/orders/${o.id}/quote?method=${method}`)
      expect(q.statusCode).toBe(200)
      expect(q.json()).toMatchObject({ orderId: o.id, dueCents: expected, totalCents: expected, paidCents: 0 })
      const p = await pay('cashier1', o.id, [{ method, amountCents: q.json().dueCents, ...(method === 'card' && { gatewayRef: 'Q-1' }) }])
      expect(p.statusCode, p.body).toBe(201)
    }
  })

  it('the quote writes nothing', async () => {
    const o = await ring('cashier1', [KARAHI(2)])
    const before = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })
    expect((await call('cashier1', 'GET', `/pos/orders/${o.id}/quote?method=card`)).json().totalCents).toBe(399_600)
    const after = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })
    expect(after).toEqual(before)
    expect(await prisma.payment.count({ where: { orderId: o.id } })).toBe(0)
  })

  it('a partly covered bill quotes its stored total minus what is covered', async () => {
    const o = await ring('cashier1', [KARAHI(2)])
    await call('mgrA', 'POST', `/pos/orders/${o.id}/comp`, { amountCents: 25_500, reason: 'birthday', shiftId: drawers['cashier1'] })
    const q = (await call('cashier1', 'GET', `/pos/orders/${o.id}/quote?method=card`)).json()
    expect(q).toMatchObject({ totalCents: 425_500, paidCents: 25_500, dueCents: 400_000, repriced: false })
    expect((await pay('cashier1', o.id, [{ method: 'card', amountCents: 400_000, gatewayRef: 'Q-2' }])).statusCode).toBe(201)
  })

  it('a ring-up priced for card, and POST /pos/quote, agree with the order created', async () => {
    const lines = [{ ...NIHARI(), modifiers: [{ name: 'Nalli', modifierId: nalli, priceDeltaCents: 0 }] }, { ...KHEER(), modifiers: [] }]
    const q = await call('cashier1', 'POST', '/pos/quote', { conceptId: conceptA, items: lines, paymentMethod: 'card' })
    expect(q.statusCode, q.body).toBe(200)
    expect(q.json()).toMatchObject({ tender: 'card', taxRatePct: 8, itemTotalCents: 235_000, totalCents: 253_800 })
    const o = await ring('cashier1', lines, { paymentMethod: 'card' })
    expect(o.totalCents).toBe(253_800)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).taxRatePct).toBe(8)
  })

  it('company B gets 404 on A\'s order and A\'s brand', async () => {
    const o = await ring('cashier1', [KHEER()])
    expect((await call('cashierB', 'GET', `/pos/orders/${o.id}/quote?method=cash`)).statusCode).toBe(404)
    expect((await call('cashierB', 'POST', '/pos/quote', { conceptId: conceptA, items: [{ ...KHEER(), modifiers: [] }] })).statusCode).toBe(404)
  })
})

// ─── Company separation on every money route ──────────────────────────────────

describe('company B never touches company A\'s bill', () => {
  it('pay, void, comp, refund, split, settle, receipt: all 404 for B', async () => {
    const o = await ring('cashier1', [KHEER(2)])
    const split = (await call('cashier1', 'POST', `/check-split/orders/${o.id}/split-evenly`, { ways: 2, method: 'cash' })).json() as Array<{ id: string }>
    const b = drawers['cashierB']
    const rs = await Promise.all([
      call('cashierB', 'POST', '/pos/payments', { orderId: o.id, shiftId: b, payments: [{ method: 'cash', amountCents: 126_500 }] }),
      call('cashierB', 'POST', `/pos/orders/${o.id}/void`, { orderItemId: o.items[0]!.id, reason: 'x' }),
      call('cashierB', 'POST', `/pos/orders/${o.id}/comp`, { amountCents: 100, reason: 'x', shiftId: b }),
      call('cashierB', 'POST', `/pos/orders/${o.id}/refund`, { amountCents: 100, reason: 'xxx' }),
      call('cashierB', 'POST', `/check-split/orders/${o.id}/split-evenly`, { ways: 2 }),
      call('cashierB', 'POST', `/check-split/payments/${split[0]!.id}/settle`, { shiftId: b }),
      call('cashierB', 'POST', `/pos/payments/${split[0]!.id}/settle`, { shiftId: b }),
      call('cashierB', 'GET', `/pos/orders/${o.id}/receipt-data`),
    ])
    expect(rs.map((r) => r.statusCode)).toEqual(Array(8).fill(404))
    expect(await prisma.payment.count({ where: { orderId: o.id, status: { not: 'pending' } } })).toBe(0)
  })
})
