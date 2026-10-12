// I3 review fixes (admin order page) — regression tests.
//
//   I3-RV-1  "Refund money taken" on a cancelled ticket: a back-office manager
//            with no drawer of their own names the open drawer the cash leaves
//            from (the one that took it). The route contract the dialog relies
//            on: no shiftId → 422 OPEN_DRAWER_REQUIRED; the cashier's open
//            drawer → 200 from that drawer; a closed one → 422 SHIFT_CLOSED; a
//            cashier cannot name another cashier's drawer (403); company B
//            cannot touch A's ticket (404) nor pay it from B's drawer (422).
//   I3-RV-2  the amount field: "1,500" is PKR 1,500, never PKR 1; junk is NaN.
//   I3-RV-3  Print / Reprint show only to roles the bill routes admit
//            (CASHIERS): expediter and finance get 403 from them, so the
//            admin's canPrintBill must say no — for every role, the default
//            module sets give exactly CASHIERS.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { CASHIERS } from '../src/modules/auth/middleware.js'
import { AppError, errorResponse } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { invalidateSetupCache } from '../src/lib/setup-config.js'
import { ALL_ROLES, OVERRIDE_APPROVERS } from '../src/lib/roles.js'
import { DEFAULT_MODULE_ACCESS } from '../src/lib/moduleAccess.js'
import { posRoutes } from '../src/modules/pos/routes.js'
import { preBillPosRoutes } from '../src/modules/prebills/routes.js'

// The admin's pure helpers (no React, no API client), loaded as-is.
const { parsePkrToCents, cashDrawerChoices, canPrintBill, OWN_DRAWER } =
  await import('../../frontend/admin/src/components/pos/handBack.ts')

// ─── I3-RV-2 ──────────────────────────────────────────────────────────────────

describe('I3-RV-2 — the hand-back amount field', () => {
  it('reads grouped thousands and plain decimals as paisa, with integer maths', () => {
    expect(parsePkrToCents('1,500')).toBe(150_000)
    expect(parsePkrToCents('1500')).toBe(150_000)
    expect(parsePkrToCents(' 12,345.67 ')).toBe(1_234_567)
    expect(parsePkrToCents('1500.5')).toBe(150_050)
    expect(parsePkrToCents('0.29')).toBe(29)
    expect(parsePkrToCents('5000.00')).toBe(500_000)
    expect(parsePkrToCents('1,000,000')).toBe(100_000_000)
  })

  it('rejects anything that is not a plain amount (NaN, so the button stays off)', () => {
    for (const bad of ['', ' ', '1,5', '1,50', '15,00', '1500abc', 'abc', '-300', '1e3', '1.234', '.5', '1,500.', '1 500', 'PKR 1500', '1,500,00']) {
      expect(parsePkrToCents(bad), bad).toBeNaN()
    }
  })
})

// ─── I3-RV-1 (the dialog's choices) ─────────────────────────────────────────

describe('I3-RV-1 — which drawer the cash leaves from', () => {
  const S1 = '11111111-aaaa-4aaa-8aaa-111111111111'
  const S2 = '22222222-bbbb-4bbb-8bbb-222222222222'
  const T = '33333333-cccc-4ccc-8ccc-333333333333'

  it('no till open in this browser: defaults to the drawer that took the cash most recently', () => {
    const r = cashDrawerChoices({
      tillShiftId: null,
      receipts: [
        { method: 'cash', shiftId: S1, processedAt: '2026-10-11T10:00:00Z' },
        { method: 'cash', shiftId: S2, processedAt: '2026-10-11T11:00:00Z' },
        { method: 'card', shiftId: T, processedAt: '2026-10-11T12:00:00Z' }, // not cash: not offered
        { method: 'cash', shiftId: S2, processedAt: '2026-10-11T09:00:00Z' }, // same drawer once
      ],
    })
    expect(r.defaultValue).toBe(S2)
    expect(r.choices.map((c) => c.value)).toEqual([S2, S1, OWN_DRAWER])
  })

  it('a till open here comes first (and says when it is the one that took the cash)', () => {
    const r = cashDrawerChoices({ tillShiftId: S1, receipts: [{ method: 'cash', shiftId: S1, processedAt: '2026-10-11T10:00:00Z' }] })
    expect(r.defaultValue).toBe(S1)
    expect(r.choices.map((c) => c.value)).toEqual([S1, OWN_DRAWER])
    expect(r.choices[0]!.label).toMatch(/took the cash/)
    const other = cashDrawerChoices({ tillShiftId: T, receipts: [{ method: 'cash', shiftId: S1 }] })
    expect(other.choices.map((c) => c.value)).toEqual([T, S1, OWN_DRAWER])
  })

  it('a drawer the server reported closed is marked and skipped; with none left it is "my own drawer"', () => {
    const r = cashDrawerChoices({ tillShiftId: null, receipts: [{ method: 'cash', shiftId: S1 }], closed: new Set([S1]) })
    expect(r.choices.find((c) => c.value === S1)?.closed).toBe(true)
    expect(r.defaultValue).toBe(OWN_DRAWER)
  })
})

// ─── I3-RV-3 (who sees Print / Reprint) ─────────────────────────────────────

describe('I3-RV-3 — bill printing shows only to the roles the bill routes admit', () => {
  it('fallback (no roles.cashiers from the API): the default module sets give exactly CASHIERS', () => {
    for (const role of ALL_ROLES) {
      const shown = canPrintBill(role, { overrideApprovers: OVERRIDE_APPROVERS, modules: DEFAULT_MODULE_ACCESS[role] ?? [] })
      expect(shown, role).toBe((CASHIERS as readonly string[]).includes(role))
    }
    expect(canPrintBill('expediter', { overrideApprovers: OVERRIDE_APPROVERS, modules: DEFAULT_MODULE_ACCESS['expediter'] })).toBe(false)
    expect(canPrintBill('finance', { overrideApprovers: OVERRIDE_APPROVERS, modules: DEFAULT_MODULE_ACCESS['finance'] })).toBe(false)
  })

  it('with the server list, it is the list — nothing else', () => {
    expect(canPrintBill('finance', { cashierRoles: CASHIERS, modules: ['pos'] })).toBe(false)
    expect(canPrintBill('cashier', { cashierRoles: CASHIERS, modules: [] })).toBe(true)
    expect(canPrintBill(null, { cashierRoles: CASHIERS })).toBe(false)
  })
})

// ─── Route contract (two companies) ─────────────────────────────────────────

let app: FastifyInstance
let tenantA: string, tenantB: string
let conceptA: string
const users: Record<string, { id: string; token: string }> = {}
const drawers: Record<string, string> = {}

async function mkUser(key: string, role: string, tenantId: string) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.i3handback@gsfoods.pk`, password: await bcrypt.hash('x-Password-1', 4), role: role as never, isActive: true, accountStatus: 'active', tenantId },
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } as never }).catch(() => {})
  users[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}

const call = (who: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as never, headers: { authorization: `Bearer ${users[who]!.token}` } })

async function openDrawer(who: string): Promise<string> {
  const r = await call(who, 'POST', '/pos/shifts/open', { openingFloatCents: 100_000 })
  expect(r.statusCode, r.body).toBe(201)
  drawers[who] = r.json().id
  return drawers[who]!
}

/** A till ticket that took `cashCents` in cash on `shiftId`, then was cancelled. */
async function cancelledTicket(shiftId: string, cashCents: number) {
  const o = await prisma.order.create({
    data: {
      conceptId: conceptA, source: 'pos', fulfilmentType: 'dine_in', status: 'received', totalCents: 575_000, taxCents: 75_000, taxRatePct: 15,
      items: { create: [{ name: 'Family platter', quantity: 1, unitPriceCents: 500_000 }] },
    },
  })
  await prisma.payment.create({ data: { orderId: o.id, shiftId, method: 'cash', amountCents: cashCents, status: 'paid', processedAt: new Date() } })
  await prisma.order.update({ where: { id: o.id }, data: { status: 'cancelled' } })
  return o
}

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'GS Foods', slug: 'i3handback-a' } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'Karachi Grill Co', slug: 'i3handback-b' } })).id
  await ensureChartOfAccounts(tenantA)
  await ensureChartOfAccounts(tenantB)
  conceptA = (await prisma.concept.create({ data: { name: 'Simmer', slug: 'i3-simmer', type: 'restaurant', tenantId: tenantA, taxRate: 17, taxRateCash: 15, taxRateCard: 8 } })).id

  await mkUser('cashier1', 'cashier', tenantA)
  await mkUser('cashier2', 'cashier', tenantA)
  await mkUser('cashier3', 'cashier', tenantA)
  await mkUser('fnbA', 'fnb_manager', tenantA)      // back office: no drawer of their own
  await mkUser('finance', 'finance', tenantA)
  await mkUser('expediter', 'expediter', tenantA)
  await mkUser('cashierB', 'cashier', tenantB)
  await mkUser('mgrB', 'foh_management', tenantB)

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(posRoutes, { prefix: '/pos' })
  await app.register(preBillPosRoutes, { prefix: '/pos' })
  await app.ready()

  await openDrawer('cashier1')
  await openDrawer('cashier2')
  await openDrawer('cashierB')
}, 60_000)

afterAll(async () => {
  invalidateSetupCache()
  await app.close()
})

describe('I3-RV-1 — the hand-back route the dialog calls', () => {
  it('a manager with no drawer pays the cash out of the cashier\'s drawer that took it', async () => {
    const o = await cancelledTicket(drawers['cashier1']!, 500_000)
    const body = { amountCents: 150_000, reason: 'Guest left before the food', method: 'cash' }

    // No drawer named and none of their own: refused, nothing written.
    const none = await call('fnbA', 'POST', `/pos/orders/${o.id}/refund`, body)
    expect(none.statusCode).toBe(422)
    expect(none.json().error.code).toBe('OPEN_DRAWER_REQUIRED')
    expect(await prisma.payment.count({ where: { orderId: o.id, status: 'refunded' } })).toBe(0)

    // Company B: A's ticket does not exist for them.
    expect((await call('mgrB', 'POST', `/pos/orders/${o.id}/refund`, { ...body, shiftId: drawers['cashierB'] })).statusCode).toBe(404)
    // A's manager cannot pay A's ticket out of B's drawer.
    const foreign = await call('fnbA', 'POST', `/pos/orders/${o.id}/refund`, { ...body, shiftId: drawers['cashierB'] })
    expect(foreign.statusCode).toBe(422)
    expect(foreign.json().error.code).toBe('SHIFT_NOT_IN_COMPANY')
    // A cashier cannot empty another cashier's drawer.
    const notTheirs = await call('cashier2', 'POST', `/pos/orders/${o.id}/refund`, { ...body, shiftId: drawers['cashier1'] })
    expect(notTheirs.statusCode).toBe(403)
    expect(notTheirs.json().error.code).toBe('NOT_YOUR_SHIFT')

    // The drawer that took the cash (what the dialog defaults to): 200, from that drawer.
    const ok = await call('fnbA', 'POST', `/pos/orders/${o.id}/refund`, { ...body, shiftId: drawers['cashier1'] })
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json()).toMatchObject({ shiftId: drawers['cashier1'], amountCents: -150_000, refundDueLeftCents: 350_000 })
    const row = await prisma.payment.findFirstOrThrow({ where: { orderId: o.id, status: 'refunded' } })
    expect(row).toMatchObject({ shiftId: drawers['cashier1'], method: 'cash', amountCents: -150_000 })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('cancelled')
  })

  it('a drawer that has closed since is refused with SHIFT_CLOSED (the dialog then moves on)', async () => {
    const s = await openDrawer('cashier3')
    const o = await cancelledTicket(s, 20_000)
    await prisma.shift.update({ where: { id: s }, data: { status: 'closed', closedAt: new Date(), closingFloatCents: 0 } })
    const r = await call('fnbA', 'POST', `/pos/orders/${o.id}/refund`, { amountCents: 20_000, reason: 'Cancelled', method: 'cash', shiftId: s })
    expect(r.statusCode).toBe(422)
    expect(r.json().error.code).toBe('SHIFT_CLOSED')
    // Another open drawer of the company still pays it.
    const ok = await call('fnbA', 'POST', `/pos/orders/${o.id}/refund`, { amountCents: 20_000, reason: 'Cancelled', method: 'cash', shiftId: drawers['cashier1'] })
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json().refundDueLeftCents).toBe(0)
  })
})

describe('I3-RV-3 — the bill routes refuse the roles the buttons are now hidden from', () => {
  it('expediter and finance get 403 from the receipt and the pre-bill; a cashier does not', async () => {
    const o = await cancelledTicket(drawers['cashier1']!, 1_000)
    for (const who of ['expediter', 'finance']) {
      expect((await call(who, 'GET', `/pos/receipt/${o.id}`)).statusCode, who).toBe(403)
      expect((await call(who, 'POST', `/pos/orders/${o.id}/pre-bill`, {})).statusCode, who).toBe(403)
    }
    expect((await call('cashier1', 'GET', `/pos/receipt/${o.id}`)).statusCode).not.toBe(403)
  })
})
