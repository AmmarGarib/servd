// Till audit (2026-10-10) — drawers, the end-of-shift report, alerts,
// receipts and stock. Two companies: B never sees A's drawers or flags.
//
//   FOH-13   one open drawer per cashier, however often "Open shift" is tapped
//   FOH-21   closing a drawer names its unpaid tickets (confirm to close anyway);
//            the Z-report lists them
//   FOH-11   cash-variance, over-threshold void and repeated-void alerts carry
//            the company
//   BOOKS-07 a till close the ledger refuses raises a company exception
//   BOOKS-02 finance reads Z-reports (its reconciliation module)
//   FOH-22   an unknown customer on a ring-up is a 422, not a 500
//   FOH-23   a refunded order's receipt says so; reprints say DUPLICATE
//   BOH-11   voiding an unfired line gives its stock back — once
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
import { orderRoutes } from '../src/modules/orders/routes.js'

const PIN = '5831'
let app: FastifyInstance
let tenantA: string, tenantB: string
let conceptA: string
const item: Record<string, string> = {}
let beefId: string
const users: Record<string, { id: string; token: string }> = {}

async function mkUser(key: string, role: string, tenantId: string) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.tillshift@gsfoods.pk`, password: await bcrypt.hash('x-Password-1', 4), role: role as never, isActive: true, accountStatus: 'active', tenantId },
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
  return r.json().id
}

async function ring(who: string, lines: Array<{ key: string; quantity?: number }>, extra: Record<string, unknown> = {}) {
  const prices: Record<string, [string, number]> = { kheer: ['Kheer', 55_000], classic: ['Classic Smash', 145_000], fries: ['Fries', 45_000] }
  const r = await call(who, 'POST', '/pos/orders', {
    conceptId: conceptA,
    items: lines.map((l) => ({ menuItemId: item[l.key], name: prices[l.key]![0], quantity: l.quantity ?? 1, unitPriceCents: prices[l.key]![1], modifiers: [] })),
    ...extra,
  })
  expect(r.statusCode, r.body).toBe(201)
  return r.json() as { id: string; totalCents: number; items: Array<{ id: string; name: string }> }
}

async function waitFor<T>(read: () => Promise<T>, done: (v: T) => boolean, ms = 5000): Promise<T> {
  const until = Date.now() + ms
  let v = await read()
  while (!done(v) && Date.now() < until) { await new Promise((r) => setTimeout(r, 50)); v = await read() }
  return v
}

const beef = async () => Number((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: beefId } })).currentStock)
const depleted = (orderId: string) => waitFor(
  () => prisma.auditLog.findFirst({ where: { entity: 'Order', entityId: orderId, action: 'stock.sale_deplete' } }),
  (x) => !!x,
)

beforeAll(async () => {
  tenantB = (await prisma.tenant.create({ data: { name: 'Shift B', slug: 'tillshift-b' } })).id
  tenantA = (await prisma.tenant.create({ data: { name: 'Shift A', slug: 'tillshift-a' } })).id
  await ensureChartOfAccounts(tenantA)
  await ensureChartOfAccounts(tenantB)
  conceptA = (await prisma.concept.create({ data: { name: 'Flipd', slug: 'flipd', type: 'restaurant', tenantId: tenantA, taxRate: 17, taxRateCash: 15, taxRateCard: 8 } })).id
  const cat = await prisma.category.create({ data: { conceptId: conceptA, name: 'Burgers' } })
  item['kheer'] = (await prisma.menuItem.create({ data: { conceptId: conceptA, categoryId: cat.id, name: 'Kheer', priceCents: 55_000 } })).id
  item['classic'] = (await prisma.menuItem.create({ data: { conceptId: conceptA, categoryId: cat.id, name: 'Classic Smash', priceCents: 145_000 } })).id
  item['fries'] = (await prisma.menuItem.create({ data: { conceptId: conceptA, categoryId: cat.id, name: 'Fries', priceCents: 45_000 } })).id
  beefId = (await prisma.inventoryItem.create({ data: { tenantId: tenantA, name: 'Beef mince', unit: 'kg', currentStock: 9.85, parLevel: 1, unitCostCents: 200_000 } })).id
  await prisma.recipe.create({
    data: {
      kind: 'plate', menuItemId: item['classic']!, servings: 1, qFactorPct: 0, laborMinutes: 5,
      ingredients: { create: [{ inventoryItemId: beefId, quantity: 150, yieldPct: 1, unit: 'kg' }] },
    },
  })

  await mkUser('cashier', 'cashier', tenantA)
  await mkUser('cashier2', 'cashier', tenantA)
  await mkUser('waiter', 'foh', tenantA)
  const mgr = await mkUser('mgr', 'foh_management', tenantA)
  await setManagerPin(mgr.id, PIN)
  await mkUser('mgrV', 'foh_management', tenantA)
  await mkUser('finance', 'finance', tenantA)
  await mkUser('financeB', 'finance', tenantB)
  await mkUser('cashierB', 'cashier', tenantB)

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(posRoutes, { prefix: '/pos' })
  await app.register(orderRoutes, { prefix: '/orders' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  invalidateSetupCache()
  await app.close()
})

// ─── FOH-13 ───────────────────────────────────────────────────────────────────

describe('FOH-13 — one open drawer per cashier', () => {
  it('three taps of "Open shift" at once open ONE drawer', async () => {
    await prisma.shift.updateMany({ where: { userId: users['cashier2']!.id, status: 'open' }, data: { status: 'closed', closedAt: new Date() } })
    const rs = await Promise.all(Array.from({ length: 3 }, () => call('cashier2', 'POST', '/pos/shifts/open', { openingFloatCents: 500_000 })))
    expect(rs.map((r) => r.statusCode).sort()).toEqual([201, 400, 400])
    const opened = rs.find((r) => r.statusCode === 201)!.json()
    for (const r of rs.filter((x) => x.statusCode === 400)) expect(r.json().error).toMatchObject({ code: 'SHIFT_OPEN', details: { shiftId: opened.id } })
    expect(await prisma.shift.count({ where: { userId: users['cashier2']!.id, status: 'open' } })).toBe(1)
    expect(opened.tenantId).toBe(tenantA)
  })
})

// ─── FOH-21 ───────────────────────────────────────────────────────────────────

describe('FOH-21 — the close names unpaid tickets', () => {
  it('409 OPEN_TICKETS lists them; confirming closes, and the Z-report lists them too', async () => {
    const s = await drawer('cashier')
    const paid = await ring('cashier', [{ key: 'kheer' }], { shiftId: s })
    expect((await call('cashier', 'POST', '/pos/payments', { orderId: paid.id, shiftId: s, payments: [{ method: 'cash', amountCents: 63_250 }] })).statusCode).toBe(201)
    const walkout = await ring('cashier', [{ key: 'kheer', quantity: 2 }], { shiftId: s })
    const rungNoDrawer = await ring('cashier', [{ key: 'fries' }])            // the cashier's own, no drawer named
    const waiterTicket = await ring('waiter', [{ key: 'kheer' }])             // nobody's drawer

    const r = await call('cashier', 'POST', `/pos/shifts/${s}/close`, { closingFloatCents: 100_000 + 63_250 })
    expect(r.statusCode).toBe(409)
    const open = r.json().error.details.openTickets
    expect(r.json().error.code).toBe('OPEN_TICKETS')
    expect(open.count).toBe(2)
    expect(open.tickets.map((t: { id: string }) => t.id).sort()).toEqual([walkout.id, rungNoDrawer.id].sort())
    expect(open.dueCents).toBe(126_500 + 51_750)
    expect((await prisma.shift.findUniqueOrThrow({ where: { id: s } })).status).toBe('open')

    const ok = await call('cashier', 'POST', `/pos/shifts/${s}/close`, { closingFloatCents: 100_000 + 63_250, confirmOpenTickets: true })
    expect(ok.statusCode, ok.body).toBe(200)
    const z = ok.json()
    expect(z.status).toBe('closed')
    expect(z.openTickets.count).toBe(2)
    expect(z.unassignedOpenTickets.count).toBeGreaterThanOrEqual(1)
    expect(z.openTickets.tickets.map((t: { id: string }) => t.id)).not.toContain(waiterTicket.id)
  })

  it('a drawer with nothing open closes without a confirmation', async () => {
    const s = await drawer('cashier')
    expect((await call('cashier', 'POST', `/pos/shifts/${s}/close`, { closingFloatCents: 100_000 })).statusCode).toBe(200)
  })
})

// ─── FOH-11 ───────────────────────────────────────────────────────────────────

describe('FOH-11 — till alerts are stamped with the company', () => {
  it('a drawer closed PKR 750 short raises a cash_variance flag for company A', async () => {
    const s = await drawer('cashier')
    const z = await call('cashier', 'POST', `/pos/shifts/${s}/close`, { closingFloatCents: 100_000 - 75_000 })
    expect(z.statusCode).toBe(200)
    const flag = await prisma.exceptionFlag.findFirst({ where: { kind: 'cash_variance', entityId: s } })
    expect(flag?.tenantId).toBe(tenantA)
  })

  it('an over-threshold void and a run of voids are flagged to company A', async () => {
    await prisma.refundPolicy.upsert({
      where: { id: (await prisma.refundPolicy.findFirst({ where: { tenantId: tenantA, scope: 'global' } }))?.id ?? '00000000-0000-0000-0000-000000000000' },
      update: { notifyOwnerAboveCents: 50_000 },
      create: { scope: 'global', scopeId: null, tenantId: tenantA, notifyOwnerAboveCents: 50_000 },
    })
    invalidateSetupCache()
    const o = await ring('cashier', [{ key: 'kheer' }, { key: 'fries' }, { key: 'kheer', quantity: 2 }])
    for (const line of o.items) {
      const v = await call('mgrV', 'POST', `/pos/orders/${o.id}/void`, { orderItemId: line.id, reason: 'guest left' })
      expect(v.statusCode, v.body).toBe(200)
    }
    const big = await prisma.exceptionFlag.findFirst({ where: { kind: 'high_value_void', entityId: o.id } })
    expect(big?.tenantId).toBe(tenantA)
    const run = await prisma.exceptionFlag.findFirst({ where: { kind: 'consecutive_voids', actorId: users['mgrV']!.id } })
    expect(run?.tenantId).toBe(tenantA)
    expect(await prisma.exceptionFlag.count({ where: { tenantId: null } })).toBe(0)
    await prisma.refundPolicy.updateMany({ where: { tenantId: tenantA }, data: { notifyOwnerAboveCents: null } })
    invalidateSetupCache()
  })
})

// ─── BOOKS-07 ─────────────────────────────────────────────────────────────────

describe('BOOKS-07 — a refused till close is raised, not just logged', () => {
  it('books closed through next year: the close succeeds, and a posting_failed exception lands in company A\'s inbox', async () => {
    const lock = await prisma.periodLock.create({ data: { tenantId: tenantA, lockedThrough: new Date(Date.now() + 365 * 86_400_000), lockedBy: users['mgr']!.id, note: 'typo' } })
    try {
      const s = await drawer('cashier')
      const o = await ring('cashier', [{ key: 'kheer' }], { shiftId: s })
      await call('cashier', 'POST', '/pos/payments', { orderId: o.id, shiftId: s, payments: [{ method: 'cash', amountCents: 63_250 }] })
      const r = await call('cashier', 'POST', `/pos/shifts/${s}/close`, { closingFloatCents: 163_250 })
      expect(r.statusCode).toBe(200)
      const flag = await waitFor(() => prisma.exceptionFlag.findFirst({ where: { kind: 'posting_failed', entityId: s } }), (x) => !!x)
      expect(flag).toMatchObject({ tenantId: tenantA, severity: 'high', entityType: 'Shift' })
      expect(await prisma.journalEntry.count({ where: { reference: `shift.close:${s}` } })).toBe(0)
    } finally {
      await prisma.periodLock.delete({ where: { id: lock.id } })
    }
  })
})

// ─── BOOKS-02 ─────────────────────────────────────────────────────────────────

describe('BOOKS-02 — finance reads Z-reports of its own company', () => {
  it('finance 200; finance of company B 404; a cashier still 403', async () => {
    const s = await drawer('cashier')
    await call('cashier', 'POST', `/pos/shifts/${s}/close`, { closingFloatCents: 100_000 })
    const z = await call('finance', 'GET', `/pos/shifts/${s}/zreport`)
    expect(z.statusCode, z.body).toBe(200)
    expect(z.json()).toMatchObject({ shiftId: s, openTickets: { count: 0 } })
    expect((await call('financeB', 'GET', `/pos/shifts/${s}/zreport`)).statusCode).toBe(404)
    expect((await call('cashier', 'GET', `/pos/shifts/${s}/zreport`)).statusCode).toBe(403)
  })
})

// ─── FOH-22 / FOH-23 ─────────────────────────────────────────────────────────

describe('ring-up and receipts', () => {
  it('FOH-22: an unknown customer is a 422', async () => {
    const r = await call('cashier', 'POST', '/pos/orders', {
      conceptId: conceptA, customerId: '00000000-0000-4000-8000-000000000000',
      items: [{ menuItemId: item['kheer'], name: 'Kheer', quantity: 1, unitPriceCents: 55_000, modifiers: [] }],
    })
    expect(r.statusCode).toBe(422)
    expect(r.json().error.code).toBe('CUSTOMER_NOT_FOUND')
  })

  it('FOH-23: a refunded order reprints as REFUNDED with its refund lines; a reprint can say DUPLICATE', async () => {
    const s = await drawer('cashier')
    const o = await ring('cashier', [{ key: 'kheer', quantity: 2 }], { shiftId: s })
    await call('cashier', 'POST', '/pos/payments', { orderId: o.id, shiftId: s, payments: [{ method: 'card', amountCents: 118_800, gatewayRef: 'T-1' }] })
    const normal = (await call('cashier', 'GET', `/pos/orders/${o.id}/receipt-data`)).json()
    expect(normal).toMatchObject({ banner: null, refunds: [], refundedCents: 0, status: 'completed' })

    expect((await call('mgr', 'POST', `/pos/orders/${o.id}/refund`, { amountCents: 50_000, reason: 'one was cold' })).statusCode).toBe(200)
    expect((await call('cashier', 'GET', `/pos/orders/${o.id}/receipt-data`)).json()).toMatchObject({ banner: 'PARTLY REFUNDED', refundedCents: 50_000 })

    expect((await call('mgr', 'POST', `/pos/orders/${o.id}/refund`, { amountCents: 68_800, reason: 'both were cold' })).statusCode).toBe(200)
    await waitFor(() => prisma.order.findUniqueOrThrow({ where: { id: o.id } }), (x) => x.status === 'refunded')
    const data = (await call('cashier', 'GET', `/pos/orders/${o.id}/receipt-data`)).json()
    expect(data).toMatchObject({ banner: 'REFUNDED', status: 'refunded', refundedCents: 118_800, paidCents: 118_800 })
    expect(data.refunds.map((x: { amountCents: number; method: string }) => [x.method, x.amountCents])).toEqual([['card', 50_000], ['card', 68_800]])
    const html = (await call('cashier', 'GET', `/pos/receipt/${o.id}?duplicate=1`)).body
    expect(html).toContain('REFUNDED')
    expect(html).toContain('DUPLICATE')
    expect(html).toContain('REFUND card')
    expect((await call('cashierB', 'GET', `/pos/receipt/${o.id}`)).statusCode).toBe(404)
  })
})

// ─── BOH-11 ───────────────────────────────────────────────────────────────────

describe('BOH-11 — a voided, unfired line gives its stock back, once', () => {
  it('fries + Classic, Classic voided before firing: the beef comes back; cancelling later does not give it back twice', async () => {
    const start = await beef()
    const o = await ring('cashier', [{ key: 'fries' }, { key: 'classic' }])
    await depleted(o.id)
    expect(await beef()).toBeCloseTo(start - 0.15, 6)

    const classic = o.items.find((i) => i.name === 'Classic Smash')!
    const v = await call('mgr', 'POST', `/pos/orders/${o.id}/void`, { orderItemId: classic.id, reason: 'customer changed mind' })
    expect(v.statusCode, v.body).toBe(200)
    expect(v.json().stockRestored).toEqual({ [beefId]: expect.closeTo(0.15, 6) })
    expect(v.json().order.totalCents).toBe(51_750)
    expect(await beef()).toBeCloseTo(start, 6)
    const trail = await prisma.auditLog.findFirst({ where: { action: 'stock.void_restore', entityId: classic.id } })
    expect(trail?.tenantId).toBe(tenantA)

    // The whole order is then cancelled: only what is still out comes back (nothing).
    expect((await call('mgr', 'POST', `/orders/${o.id}/cancel`, { reason: 'guest left' })).statusCode).toBe(200)
    expect(await beef()).toBeCloseTo(start, 6)
  })

  it('a line the kitchen already started stays consumed (booked as waste); cancelling the order gives back the rest', async () => {
    const start = await beef()
    const o = await ring('cashier', [{ key: 'classic' }, { key: 'classic' }])
    await depleted(o.id)
    expect(await beef()).toBeCloseTo(start - 0.3, 6)
    const [cooked, other] = o.items
    await prisma.orderItem.update({ where: { id: cooked!.id }, data: { status: 'preparing' } })
    const v = await call('mgr', 'POST', `/pos/orders/${o.id}/void`, { orderItemId: cooked!.id, reason: 'dropped on the floor' })
    expect(v.json().stockRestored).toEqual({})
    // BOH-R2-03: the cooked portion is booked as waste (resimTill.test.ts has the ledger side).
    expect(v.json().stockWasted).toEqual({ [beefId]: expect.closeTo(0.15, 6) })
    expect(await beef()).toBeCloseTo(start - 0.3, 6)
    const c = await call('mgr', 'POST', `/orders/${o.id}/cancel`, { reason: 'guest left' })
    expect(c.statusCode, c.body).toBe(200)
    // Cancel gives back what is still out — the uncooked portion. The cooked
    // one left as waste and stays out.
    expect(await beef()).toBeCloseTo(start - 0.15, 6)
    expect(other).toBeTruthy()
  })
})
