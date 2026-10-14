// Integration pass 1 — backend follow-ups of the till / people fix runs
// (2026-10-12). Two companies (A and B) throughout.
//
//   6   the till's override flags carry their own kinds: 'manager_pin_failed'
//       (the wrong-PIN lock), 'discount_above_cap' and 'price_override' —
//       not 'self_approval' / 'comp_above_threshold' / 'high_value_void'.
//   7   POST /orders/:id/cancel and /orders/:id/refused-at-door count a PIN
//       against the ORDER's bucket too, so wrong PINs on one order cannot be
//       spread across the void and cancel doors.
//   10  petty-cash top-up over the box limit: no PIN → 403 TOPUP_OVER_LIMIT;
//       a PIN that does not verify (wrong, or company B's) → 403
//       INVALID_MANAGER_PIN, audited against the sender.
//   3   a punch-in on an approved leave day is remarked as such.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { randomUUID } from 'node:crypto'
import { AppError, errorResponse } from '../src/lib/errors.js'
import { posRoutes } from '../src/modules/pos/routes.js'
import { orderRoutes } from '../src/modules/orders/routes.js'
import { trustopsRoutes } from '../src/modules/trustops/routes.js'
import { registerPreBillPlugins } from '../src/modules/prebills/index.js'
import { setManagerPin } from '../src/modules/auth/managerPin.js'
import { invalidateSetupCache } from '../src/lib/setup-config.js'
import { setFiscalKicker } from '../src/connectors/fiscal/outbox.js'
import { recordPunch } from '../src/modules/hr/attendance.js'
import { prisma, mkCompany, mkUser, caller, resetConnectorCache, type Company, type Who } from './connectorsFixtures.js'

let app: FastifyInstance
let A: Company, B: Company
let mgrA: Who, mgrB: Who
const PIN_A = '5831'
const PIN_B = '7364'

const call = (...args: Parameters<ReturnType<typeof caller>>) => caller(app)(...args)

async function ticket(who: Who, co: Company, extra: Record<string, unknown> = {}) {
  const r = await call(who, 'POST', '/pos/orders', {
    conceptId: co.conceptId,
    items: [
      { menuItemId: co.items.nihari, name: 'Beef Nihari', quantity: 1, unitPriceCents: 145_000, modifiers: [] },
      { menuItemId: co.items.kheer, name: 'Kheer', quantity: 1, unitPriceCents: 55_000, modifiers: [] },
    ],
    ...extra,
  })
  if (r.statusCode !== 201) throw new Error(`ring failed ${r.statusCode} ${r.body}`)
  return r.json() as { id: string; items: Array<{ id: string }> }
}

const voidLine = (who: Who, orderId: string, orderItemId: string, pin: string) =>
  call(who, 'POST', `/pos/orders/${orderId}/void`, { orderItemId, reason: 'guest left', managerOverridePin: pin })
const cancel = (who: Who, orderId: string, pin?: string) =>
  call(who, 'POST', `/orders/${orderId}/cancel`, { reason: 'guest walked out', ...(pin !== undefined && { managerOverridePin: pin }) })
const refused = (who: Who, orderId: string, pin?: string) =>
  call(who, 'POST', `/orders/${orderId}/refused-at-door`, { reason: 'refused', ...(pin !== undefined && { managerOverridePin: pin }) })

const cashier = (tag: string, co: Company) => mkUser(`ip1-${tag}-${randomUUID().slice(0, 6)}`, 'cashier', co.tenantId)

beforeAll(async () => {
  A = await mkCompany('ip1-a')
  B = await mkCompany('ip1-b')
  mgrA = await mkUser('ip1-mgr-a', 'foh_management', A.tenantId)
  mgrB = await mkUser('ip1-mgr-b', 'foh_management', B.tenantId)
  await setManagerPin(mgrA.id, PIN_A)
  await setManagerPin(mgrB.id, PIN_B)
  invalidateSetupCache()
  setFiscalKicker(async () => {})
  const a = Fastify()
  a.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await a.register(posRoutes, { prefix: '/pos' })
  await a.register(orderRoutes, { prefix: '/orders' })
  await a.register(trustopsRoutes, { prefix: '/trustops' })
  await registerPreBillPlugins(a)
  await a.ready()
  app = a
}, 60_000)

afterAll(async () => {
  setFiscalKicker(null)
  resetConnectorCache()
  await app?.close()
})

// ─── 6 — exception kinds ──────────────────────────────────────────────────────

describe('6 — till override flags carry their own kinds', () => {
  it('the wrong-PIN lock flags manager_pin_failed for the order\'s company only', async () => {
    const c = await cashier('lock', A)
    const o = await ticket(c, A)
    for (let i = 0; i < 5; i++) expect((await voidLine(c, o.id, o.items[0]!.id, `90100${i}`)).json().error.code).toBe('INVALID_MANAGER_PIN')
    const flags = await prisma.exceptionFlag.findMany({ where: { actorId: c.id } })
    expect(flags).toHaveLength(1)
    expect(flags[0]!.kind).toBe('manager_pin_failed')
    expect(flags[0]!.tenantId).toBe(A.tenantId)
    // One sender filled both buckets (actor and order): the flag names them.
    expect(flags[0]!.title).toMatch(/: 5 wrong manager PINs — overrides locked$/)
    expect((flags[0]!.metadata as { lock?: string }).lock).toBe('actor_and_order')
    expect(await prisma.exceptionFlag.count({ where: { actorId: c.id, kind: 'self_approval' } })).toBe(0)
    expect(await prisma.exceptionFlag.count({ where: { tenantId: B.tenantId, kind: 'manager_pin_failed' } })).toBe(0)
  })

  it('an authorised over-cap discount flags discount_above_cap on the order, company A', async () => {
    const c = await cashier('disc', A)
    const r = await call(c, 'POST', '/pos/orders', {
      conceptId: A.conceptId,
      items: [{ menuItemId: A.items.nihari, name: 'Beef Nihari', quantity: 1, unitPriceCents: 145_000, modifiers: [] }],
      discountCents: 36_250, discountReason: 'regular', managerOverridePin: PIN_A, // 25%
    })
    expect(r.statusCode, r.body).toBe(201)
    const flag = await prisma.exceptionFlag.findFirst({ where: { actorId: c.id, entityId: r.json().id } })
    expect(flag?.kind).toBe('discount_above_cap')
    expect(flag?.tenantId).toBe(A.tenantId)
    expect(flag?.entityType).toBe('Order')
  })

  it('B\'s manager PIN does not authorise A\'s discount, and nothing is flagged as a discount', async () => {
    const c = await cashier('disc-b', A)
    const r = await call(c, 'POST', '/pos/orders', {
      conceptId: A.conceptId,
      items: [{ menuItemId: A.items.nihari, name: 'Beef Nihari', quantity: 1, unitPriceCents: 145_000, modifiers: [] }],
      discountCents: 36_250, discountReason: 'regular', managerOverridePin: PIN_B,
    })
    expect(r.statusCode).toBe(403)
    expect(r.json().error.code).toBe('INVALID_MANAGER_PIN')
    expect(await prisma.exceptionFlag.count({ where: { actorId: c.id, kind: 'discount_above_cap' } })).toBe(0)
  })

  it('a price override flags price_override on the order, company A (not a void)', async () => {
    const r = await call(mgrA, 'POST', '/pos/orders', {
      conceptId: A.conceptId,
      items: [{ menuItemId: A.items.nihari, name: 'Beef Nihari', quantity: 1, unitPriceCents: 120_000, modifiers: [] }],
      discountReason: 'regular price agreed',
    })
    expect(r.statusCode, r.body).toBe(201)
    const flag = await prisma.exceptionFlag.findFirst({ where: { actorId: mgrA.id, entityId: r.json().id } })
    expect(flag?.kind).toBe('price_override')
    expect(flag?.tenantId).toBe(A.tenantId)
    expect(flag?.amountCents).toBe(25_000)
  })
})

// ─── 7 — cancels share the per-order PIN bucket ───────────────────────────────

describe('7 — order cancels count PINs against the order', () => {
  it('a wrong PIN on cancel is audited against the order', async () => {
    const c = await cashier('cx-audit', A)
    const o = await ticket(c, A)
    const r = await cancel(c, o.id, '920001')
    expect(r.statusCode).toBe(403)
    expect(r.json().error.code).toBe('INVALID_MANAGER_PIN')
    const audit = await prisma.auditLog.findFirst({ where: { action: 'manager_pin.failed', userId: c.id } })
    expect(audit?.entityId).toBe(o.id)
    expect((audit?.metadata as { orderId?: string }).orderId).toBe(o.id)
    expect(audit?.tenantId).toBe(A.tenantId)
  })

  it('wrong PINs spread over void, cancel and refused-at-door lock the ORDER after 5', async () => {
    const [c1, c2, c3, c4] = await Promise.all(['p1', 'p2', 'p3', 'p4'].map((t) => cashier(t, A)))
    const customer = await prisma.customer.create({ data: { name: 'Door Guest', phone: `+92300${Math.floor(1_000_000 + Math.random() * 8_999_999)}` } })
    const o = await ticket(c1, A)
    await prisma.order.update({ where: { id: o.id }, data: { customerId: customer.id } })
    for (let i = 0; i < 2; i++) expect((await voidLine(c1!, o.id, o.items[0]!.id, `93000${i}`)).json().error.code).toBe('INVALID_MANAGER_PIN')
    for (let i = 0; i < 2; i++) expect((await cancel(c2!, o.id, `93100${i}`)).json().error.code).toBe('INVALID_MANAGER_PIN')
    expect((await refused(c3!, o.id, '932000')).json().error.code).toBe('INVALID_MANAGER_PIN')
    // Five wrong on this order from three people: a fourth cashier, even with
    // the right PIN, is refused for this order.
    const locked = await cancel(c4!, o.id, PIN_A)
    expect(locked.statusCode).toBe(429)
    expect(locked.json().error.code).toBe('MANAGER_PIN_LOCKED')
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).not.toBe('cancelled')
    // The order-level lock raised one flag, in A.
    const flags = await prisma.exceptionFlag.findMany({ where: { entityId: o.id, kind: 'manager_pin_failed' } })
    expect(flags).toHaveLength(1)
    expect(flags[0]!.tenantId).toBe(A.tenantId)
    // IB-RV-3: an order lock blames nobody — the last sender (c3, one PIN) is
    // not named as the guesser; every sender in the window is listed instead.
    const f = flags[0]!
    expect(f.actorId).toBeNull()
    expect(f.title).toBe('5 wrong manager PINs on one order — PIN approvals for this order locked')
    expect(f.description).toContain('for this order')
    expect(f.description).not.toContain('Manager-PIN approvals are locked')
    const meta = f.metadata as { lock?: string; senders?: Array<{ userId: string; attempts: number }> }
    expect(meta.lock).toBe('order')
    const byUser = Object.fromEntries((meta.senders ?? []).map((s) => [s.userId, s.attempts]))
    expect(byUser).toEqual({ [c1!.id]: 2, [c2!.id]: 2, [c3!.id]: 1 })
    // No actor-level flag for any of the three senders.
    expect(await prisma.exceptionFlag.count({ where: { actorId: { in: [c1!.id, c2!.id, c3!.id] } } })).toBe(0)
    // A manager signed in still cancels it (no PIN, no bucket).
    expect((await cancel(mgrA, o.id)).statusCode).toBe(200)
  })

  it('company B cannot cancel A\'s order (404, no PIN tried)', async () => {
    const c = await cashier('cx-a', A)
    const o = await ticket(c, A)
    const cb = await cashier('cx-b', B)
    expect((await cancel(cb, o.id, PIN_B)).statusCode).toBe(404)
    expect((await cancel(mgrB, o.id)).statusCode).toBe(404)
    expect(await prisma.auditLog.count({ where: { action: 'manager_pin.failed', userId: cb.id } })).toBe(0)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).not.toBe('cancelled')
  })
})

// ─── 10 — petty-cash top-up PIN ───────────────────────────────────────────────

describe('10 — petty-cash top-up over the box limit', () => {
  let boxA: string
  beforeAll(async () => {
    boxA = (await prisma.pettyCashBox.create({
      data: { tenantId: A.tenantId, name: 'IP1 FOH box', custodianId: mgrA.id, floatCents: 10_000, topUpLimitCents: 5_000 },
    })).id
  })
  const topup = (who: Who, pin?: string) => call(who, 'POST', '/trustops/petty-cash/movements', {
    boxId: boxA, type: 'topup', amountCents: 20_000, reason: 'float', source: 'safe', ...(pin !== undefined && { managerOverridePin: pin }),
  })

  // A top-up is a cash keeper's or the box custodian's: each cashier below
  // holds the box (finance gaps, 2026-10-13).
  const holds = (c: Who) => prisma.pettyCashBox.update({ where: { id: boxA }, data: { custodianId: c.id } })

  it('a cashier who does not hold the box cannot top it up at all', async () => {
    const c = await cashier('pc-other', A)
    const r = await topup(c, PIN_A)
    expect(r.statusCode).toBe(403)
    expect(r.json().error.code).toBe('TOPUP_NOT_ALLOWED')
    expect((await prisma.pettyCashBox.findUniqueOrThrow({ where: { id: boxA } })).floatCents).toBe(10_000)
  })

  it('no PIN → 403 TOPUP_OVER_LIMIT, no attempt counted', async () => {
    const c = await cashier('pc-none', A)
    await holds(c)
    const r = await topup(c)
    expect(r.statusCode).toBe(403)
    expect(r.json().error.code).toBe('TOPUP_OVER_LIMIT')
    expect(await prisma.auditLog.count({ where: { action: 'manager_pin.failed', userId: c.id } })).toBe(0)
  })

  it('a wrong PIN, or company B\'s manager PIN → 403 INVALID_MANAGER_PIN, audited against the sender', async () => {
    const c = await cashier('pc-bad', A)
    await holds(c)
    for (const pin of ['940001', PIN_B]) {
      const r = await topup(c, pin)
      expect(r.statusCode).toBe(403)
      expect(r.json().error.code).toBe('INVALID_MANAGER_PIN')
    }
    const audits = await prisma.auditLog.findMany({ where: { action: 'manager_pin.failed', userId: c.id } })
    expect(audits).toHaveLength(2)
    for (const a of audits) {
      expect(a.tenantId).toBe(A.tenantId)
      expect((a.metadata as { action?: string }).action).toBe('petty_cash_topup')
    }
    expect((await prisma.pettyCashBox.findUniqueOrThrow({ where: { id: boxA } })).floatCents).toBe(10_000)
  })

  it('A\'s manager PIN lifts the limit; B\'s operator cannot touch A\'s box', async () => {
    const c = await cashier('pc-ok', A)
    await holds(c)
    const r = await topup(c, PIN_A)
    expect(r.statusCode, r.body).toBe(201)
    expect(r.json().newFloatCents).toBe(30_000)
    expect((await topup(mgrB, PIN_B)).statusCode).toBe(404)
  })
})

// ─── 3 — punch-in on approved leave ───────────────────────────────────────────

describe('3 — a punch-in on an approved leave day is remarked', () => {
  const pkt = (date: string, hhmm: string) => new Date(new Date(`${date}T${hhmm}:00.000Z`).getTime() - 5 * 3_600_000)

  it('remarks the day for A\'s employee on leave; B\'s employee on the same day is unremarked', async () => {
    const empA = await prisma.hrEmployee.create({ data: { tenantId: A.tenantId, employeeCode: 'IP1-A1', fullName: 'Leave Cook', joiningDate: new Date('2025-01-01') } })
    const empB = await prisma.hrEmployee.create({ data: { tenantId: B.tenantId, employeeCode: 'IP1-B1', fullName: 'Other Cook', joiningDate: new Date('2025-01-01') } })
    const day = new Date('2026-09-30T00:00:00.000Z')
    await prisma.hrRecord.create({
      data: { tenantId: A.tenantId, section: 'leave', formVersion: 0, status: 'approved', employeeId: empA.id, startDate: day, endDate: day, quantity: 1, data: {} },
    })
    // A leave record in A naming B's employee must not touch B's day.
    await prisma.hrRecord.create({
      data: { tenantId: A.tenantId, section: 'leave', formVersion: 0, status: 'approved', employeeId: empB.id, startDate: day, endDate: day, quantity: 1, data: {} },
    })

    const ra = await recordPunch({ tenantId: A.tenantId, employeeId: empA.id, kind: 'in', at: pkt('2026-09-30', '09:05'), source: 'clock' })
    expect(ra.recordId).toBeTruthy()
    const recA = await prisma.hrRecord.findUniqueOrThrow({ where: { id: ra.recordId! } })
    expect((recA.data as Record<string, unknown>)['remarks']).toBe('Punched in on an approved leave day')
    expect(recA.tenantId).toBe(A.tenantId)

    const rb = await recordPunch({ tenantId: B.tenantId, employeeId: empB.id, kind: 'in', at: pkt('2026-09-30', '09:05'), source: 'clock' })
    expect(rb.recordId).toBeTruthy()
    const recB = await prisma.hrRecord.findUniqueOrThrow({ where: { id: rb.recordId! } })
    expect((recB.data as Record<string, unknown>)['remarks']).toBeUndefined()
    expect(recB.tenantId).toBe(B.tenantId)
  })
})
