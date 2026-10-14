// Re-simulation fixes, till stream (2026-10-12). Two companies throughout.
//
//   FOH-R2-01  manager PINs are rate-limited: 5 attempts per actor (and per
//              order) per 15 minutes, counted BEFORE the comparison, then 429
//              MANAGER_PIN_LOCKED; every wrong PIN is audited
//              ('manager_pin.failed': actor, order, company); the attempt that
//              locks raises an exception flag for the company; a correct PIN
//              gives back only its own slot (T-RV-01) and a request refused
//              for a locked order costs the sender nothing (T-RV-02); Redis
//              down → counted in memory.
//   FOH-R2-03  a wrong / other-company PIN on an over-cap discount is 403
//              INVALID_MANAGER_PIN; the discount alert is not a 'void' and
//              points at the order.
//   BOH-R2-03  a line voided after it was fired is booked as waste: its FIFO
//              sale rows relabelled sale_void + waste, a WasteLog
//              (void_after_fire) + Dr 1290 / Cr 1210 in the ORDER's company,
//              once; a closed period → the void stands, a posting_failed flag.
//   R2-UI-01   the ring-up answers with payments: [] (fresh and replay).
//   R2-UI-07   an 11-digit cash tender is 422 AMOUNT_TOO_LARGE, not a 500.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { randomUUID } from 'node:crypto'
import { AppError, errorResponse } from '../src/lib/errors.js'
import { posRoutes } from '../src/modules/pos/routes.js'
import { orderRoutes } from '../src/modules/orders/routes.js'
import { registerPreBillPlugins } from '../src/modules/prebills/index.js'
import { setManagerPin, verifyManagerPin } from '../src/modules/auth/managerPin.js'
import { claimPinAttempt, resetPinAttempts } from '../src/lib/managerPinLimit.js'
import { runWithRlsContext } from '../src/lib/rlsContext.js'
import { redisFast } from '../src/lib/redis.js'
import { invalidateSetupCache } from '../src/lib/setup-config.js'
import { setFiscalKicker } from '../src/connectors/fiscal/outbox.js'
import { deductInventoryForOrder } from '../src/modules/orders/service.js'
import { addLotTx, fifoCutoverKey } from '../src/lib/stockLedger.js'
import { prisma, mkCompany, mkUser, caller, resetConnectorCache, type Company, type Who } from './connectorsFixtures.js'

let app: FastifyInstance
let A: Company, B: Company
let mgrA: Who, mgrB: Who, cashierB: Who
const beef: Record<string, string> = {}
const PIN_A = '5821'
const PIN_B = '7394'

async function build(): Promise<FastifyInstance> {
  const a = Fastify()
  a.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await a.register(posRoutes, { prefix: '/pos' })
  await a.register(orderRoutes, { prefix: '/orders' })
  await registerPreBillPlugins(a)
  await a.ready()
  return a
}

const call = (...args: Parameters<ReturnType<typeof caller>>) => caller(app)(...args)

/** Nihari + Kheer at company `co`, rung by `who`. */
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
  return r.json() as { id: string; totalCents: number; payments: unknown; items: Array<{ id: string; name: string; modifiers: unknown[] }> }
}

const voidLine = (who: Who, orderId: string, orderItemId: string, pin?: string) =>
  call(who, 'POST', `/pos/orders/${orderId}/void`, { orderItemId, reason: 'guest left', ...(pin !== undefined && { managerOverridePin: pin }) })

const stock = async (id: string) => Number((await prisma.inventoryItem.findUniqueOrThrow({ where: { id } })).currentStock)

beforeAll(async () => {
  A = await mkCompany('resimt-a')
  B = await mkCompany('resimt-b')
  mgrA = await mkUser('resimt-mgr-a', 'foh_management', A.tenantId)
  mgrB = await mkUser('resimt-mgr-b', 'foh_management', B.tenantId)
  cashierB = await mkUser('resimt-cashier-b', 'cashier', B.tenantId)
  await setManagerPin(mgrA.id, PIN_A)
  await setManagerPin(mgrB.id, PIN_B)
  // Nihari takes 0.15 kg of beef at PKR 2,000/kg (plate cost PKR 300), in each company.
  for (const co of [A, B]) {
    // On FIFO lots (finance wave B): the company is cut over and holds 20 kg of beef in one lot.
    await prisma.setting.create({ data: { key: fifoCutoverKey(co.tenantId), value: new Date(Date.now() - 30 * 86_400_000).toISOString() } })
    beef[co.tenantId] = (await prisma.inventoryItem.create({ data: { tenantId: co.tenantId, name: 'Beef', unit: 'kg', parLevel: 1, unitCostCents: 200_000 } })).id
    await prisma.$transaction((tx) => addLotTx(tx, {
      tenantId: co.tenantId, inventoryItemId: beef[co.tenantId]!, qty: 20, unitCostCents: 200_000, kind: 'count_gain', lotSourceType: 'count_gain',
      lotSourceId: `resimt-beef-${co.tenantId}`, movementSourceType: 'test', movementSourceId: `resimt-beef-${co.tenantId}`, receivedAt: new Date(Date.now() - 86_400_000),
    }))
    await prisma.recipe.create({
      data: {
        kind: 'plate', menuItemId: co.items.nihari, servings: 1, qFactorPct: 0, laborMinutes: 5,
        ingredients: { create: [{ inventoryItemId: beef[co.tenantId]!, quantity: 150, yieldPct: 1, unit: 'kg' }] },
      },
    })
  }
  invalidateSetupCache()
  setFiscalKicker(async () => {})
  app = await build()
}, 60_000)

afterAll(async () => {
  setFiscalKicker(null)
  resetConnectorCache()
  await app?.close()
})

// ─── FOH-R2-01 ────────────────────────────────────────────────────────────────

describe('FOH-R2-01 — manager PIN attempts are limited, audited and flagged', () => {
  it('5 wrong PINs from one cashier → audited; the 6th (even the right PIN) → 429 MANAGER_PIN_LOCKED; one flag for the company', async () => {
    const cashier = await mkUser(`resimt-c1-${randomUUID().slice(0, 6)}`, 'cashier', A.tenantId)
    const o = await ticket(cashier, A)
    const codes: string[] = []
    for (const pin of ['200001', '200002', '200003', '200004', '200005']) {
      codes.push((await voidLine(cashier, o.id, o.items[0]!.id, pin)).json().error.code)
    }
    expect(codes).toEqual(Array(5).fill('INVALID_MANAGER_PIN'))
    const locked = await voidLine(cashier, o.id, o.items[0]!.id, PIN_A)
    expect(locked.statusCode).toBe(429)
    expect(locked.json().error.code).toBe('MANAGER_PIN_LOCKED')
    expect(locked.json().error.details.retryAfterSec).toBeGreaterThan(0)
    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: o.items[0]!.id } })).voidedAt).toBeNull()

    const audits = await prisma.auditLog.findMany({ where: { action: 'manager_pin.failed', userId: cashier.id } })
    expect(audits).toHaveLength(5)
    for (const a of audits) {
      expect(a.tenantId).toBe(A.tenantId)
      expect(a.entityId).toBe(o.id)
      expect((a.metadata as { orderId?: string }).orderId).toBe(o.id)
    }
    const flags = await prisma.exceptionFlag.findMany({ where: { actorId: cashier.id, kind: 'manager_pin_failed' } })
    expect(flags).toHaveLength(1)
    expect(flags[0]!.tenantId).toBe(A.tenantId)
    expect((flags[0]!.metadata as { realKind?: string }).realKind).toBe('manager_pin_failed')
    // Company B sees none of it.
    expect(await prisma.exceptionFlag.count({ where: { actorId: cashier.id, tenantId: B.tenantId } })).toBe(0)

    // The lock is per actor: a manager signed in still voids the line.
    expect((await voidLine(mgrA, o.id, o.items[0]!.id)).statusCode).toBe(200)
    // ...and company B's till is untouched.
    const ob = await ticket(cashierB, B)
    expect((await voidLine(cashierB, ob.id, ob.items[0]!.id, PIN_B)).statusCode).toBe(200)
  })

  it('T-RV-01: a correct PIN gives back only its own slot — two mistypes then a right PIN leaves 3 spare, not 5', async () => {
    const cashier = await mkUser(`resimt-c2-${randomUUID().slice(0, 6)}`, 'cashier', A.tenantId)
    const o1 = await ticket(cashier, A)
    for (let i = 0; i < 2; i++) expect((await voidLine(cashier, o1.id, o1.items[0]!.id, `30000${i}`)).json().error.code).toBe('INVALID_MANAGER_PIN')
    expect((await voidLine(cashier, o1.id, o1.items[0]!.id, PIN_A)).statusCode).toBe(200)
    // Fresh order (its own bucket): 3 more wrong are still 403 — the 5th wrong
    // in the window locks the cashier, so the next, even the right PIN, is 429.
    const o2 = await ticket(cashier, A)
    for (let i = 0; i < 3; i++) expect((await voidLine(cashier, o2.id, o2.items[0]!.id, `31000${i}`)).json().error.code).toBe('INVALID_MANAGER_PIN')
    expect((await voidLine(cashier, o2.id, o2.items[0]!.id, PIN_A)).json().error.code).toBe('MANAGER_PIN_LOCKED')
    expect(await prisma.exceptionFlag.count({ where: { actorId: cashier.id, kind: 'manager_pin_failed', tenantId: A.tenantId } })).toBe(1)
  })

  it('cashiers cannot pool budgets on one order: 5 wrong PINs on it from several people lock that order', async () => {
    const cs = await Promise.all([1, 2, 3].map((i) => mkUser(`resimt-pool${i}-${randomUUID().slice(0, 6)}`, 'cashier', A.tenantId)))
    const o = await ticket(cs[0]!, A)
    for (const [who, n] of [[cs[0]!, 3], [cs[1]!, 2]] as const) {
      for (let i = 0; i < n; i++) expect((await voidLine(who, o.id, o.items[0]!.id, `40000${i}`)).json().error.code).toBe('INVALID_MANAGER_PIN')
    }
    const third = await voidLine(cs[2]!, o.id, o.items[0]!.id, '400009')
    expect(third.statusCode).toBe(429)
    expect(third.json().error.code).toBe('MANAGER_PIN_LOCKED')
    // The order-level lock raised the company's flag.
    expect(await prisma.exceptionFlag.count({ where: { entityId: o.id, kind: 'manager_pin_failed', tenantId: A.tenantId } })).toBe(1)
  })

  it('a parallel burst of 20 guesses gets at most 5 comparisons', async () => {
    const cashier = await mkUser(`resimt-burst-${randomUUID().slice(0, 6)}`, 'cashier', A.tenantId)
    const orders = await Promise.all(Array.from({ length: 4 }, () => ticket(cashier, A)))
    const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => {
      const o = orders[i % 4]!
      return voidLine(cashier, o.id, o.items[0]!.id, String(500_000 + i))
    }))
    const codes = rs.map((r) => r.json().error.code as string)
    expect(codes.filter((c) => c === 'INVALID_MANAGER_PIN').length).toBeLessThanOrEqual(5)
    expect(codes.filter((c) => c === 'MANAGER_PIN_LOCKED').length).toBeGreaterThanOrEqual(15)
    expect(await prisma.auditLog.count({ where: { action: 'manager_pin.failed', userId: cashier.id } })).toBeLessThanOrEqual(5)
  })

  it('every override path shares the limit — a discount PIN, a cancel PIN and a void PIN count together', async () => {
    const cashier = await mkUser(`resimt-mix-${randomUUID().slice(0, 6)}`, 'cashier', A.tenantId)
    const disc = await call(cashier, 'POST', '/pos/orders', {
      conceptId: A.conceptId,
      items: [{ menuItemId: A.items.nihari, name: 'Beef Nihari', quantity: 1, unitPriceCents: 145_000, modifiers: [] }],
      discountCents: 43_750, discountReason: 'bday', managerOverridePin: '600001',
    })
    expect(disc.json().error.code).toBe('INVALID_MANAGER_PIN')
    const o = await ticket(cashier, A)
    for (let i = 0; i < 2; i++) {
      expect((await call(cashier, 'POST', `/orders/${o.id}/cancel`, { reason: 'guest left', managerOverridePin: `60001${i}` })).json().error.code).toBe('INVALID_MANAGER_PIN')
    }
    for (let i = 0; i < 2; i++) expect((await voidLine(cashier, o.id, o.items[0]!.id, `60002${i}`)).json().error.code).toBe('INVALID_MANAGER_PIN')
    expect((await voidLine(cashier, o.id, o.items[0]!.id, PIN_A)).json().error.code).toBe('MANAGER_PIN_LOCKED')
  })

  it('a caller that passes no actor (trustops petty cash) is still limited — the request\'s signed-in user is the key', async () => {
    const someone = randomUUID()
    const verdicts = await runWithRlsContext({ staffUserId: someone }, async () => {
      const out: string[] = []
      for (let i = 0; i < 6; i++) {
        try { out.push((await verifyManagerPin(`70000${i}`, A.tenantId)) ? 'ok' : 'wrong') } catch (e) { out.push((e as AppError).code) }
      }
      return out
    })
    expect(verdicts).toEqual(['wrong', 'wrong', 'wrong', 'wrong', 'wrong', 'MANAGER_PIN_LOCKED'])
    expect(await prisma.auditLog.count({ where: { action: 'manager_pin.failed', userId: someone, tenantId: A.tenantId } })).toBe(5)
  })

  it('no PIN sent is not an attempt; another company\'s manager PIN is a wrong PIN', async () => {
    const cashier = await mkUser(`resimt-np-${randomUUID().slice(0, 6)}`, 'cashier', A.tenantId)
    const o = await ticket(cashier, A)
    for (let i = 0; i < 7; i++) expect((await voidLine(cashier, o.id, o.items[0]!.id)).json().error.code).toBe('MANAGER_OVERRIDE_REQUIRED')
    expect((await voidLine(cashier, o.id, o.items[0]!.id, PIN_B)).json().error.code).toBe('INVALID_MANAGER_PIN')
    expect((await voidLine(cashier, o.id, o.items[0]!.id, PIN_A)).statusCode).toBe(200)
  })

  it('Redis down: attempts are counted in memory and the limit still holds (never fails open)', async () => {
    const keys = { actor: `user:redis-down-${randomUUID()}` }
    redisFast.disconnect()
    try {
      for (let i = 0; i < 5; i++) await claimPinAttempt(keys)
      await expect(claimPinAttempt(keys)).rejects.toMatchObject({ code: 'MANAGER_PIN_LOCKED', statusCode: 429 })
    } finally {
      await resetPinAttempts(keys)
      await redisFast.connect().catch(() => {})
    }
  })
})

// ─── T-RV-01 / T-RV-02 ───────────────────────────────────────────────────────

describe('T-RV-01 — knowing one valid PIN does not reset the guess budget', () => {
  const ringDiscount = (who: Who, discountCents: number, pin: string) => call(who, 'POST', '/pos/orders', {
    conceptId: A.conceptId,
    items: [{ menuItemId: A.items.nihari, name: 'Beef Nihari', quantity: 1, unitPriceCents: 145_000, modifiers: [] }],
    discountCents, discountReason: 'regular', managerOverridePin: pin,
  })
  const flagsFor = (actorId: string) => prisma.exceptionFlag.count({ where: { actorId, kind: 'manager_pin_failed', tenantId: A.tenantId } })

  it('a manager on a discount over managerDiscountCap: 4 wrong, own PIN, then the 5th wrong flags and the 6th is 429', async () => {
    const mgr = await mkUser(`resimt-rv1m-${randomUUID().slice(0, 6)}`, 'foh_management', A.tenantId)
    await setManagerPin(mgr.id, '6283')
    const sixty = 87_000 // 60% of PKR 1,450 — over the 50% manager cap, so only an admin PIN approves
    for (let i = 0; i < 4; i++) expect((await ringDiscount(mgr, sixty, `81000${i}`)).json().error.code).toBe('INVALID_MANAGER_PIN')
    // Their own PIN matches but is not an admin's: still refused, nothing created.
    const own = await ringDiscount(mgr, sixty, '6283')
    expect(own.statusCode).toBe(403)
    expect(own.json().error.code).toBe('DISCOUNT_OVER_MANAGER_CAP')
    expect(await flagsFor(mgr.id)).toBe(0)
    // The match did not wipe the 4 strikes: the next wrong is the 5th and locks.
    expect((await ringDiscount(mgr, sixty, '810009')).json().error.code).toBe('INVALID_MANAGER_PIN')
    expect(await flagsFor(mgr.id)).toBe(1)
    const sixth = await ringDiscount(mgr, sixty, '810010')
    expect(sixth.statusCode).toBe(429)
    expect(sixth.json().error.code).toBe('MANAGER_PIN_LOCKED')
    // ...and while locked, even the own PIN is not compared.
    expect((await ringDiscount(mgr, sixty, '6283')).json().error.code).toBe('MANAGER_PIN_LOCKED')
    expect(await prisma.auditLog.count({ where: { action: 'manager_pin.failed', userId: mgr.id } })).toBe(5)
    expect(await prisma.order.count({ where: { posStaffId: mgr.id } })).toBe(0)
  })

  it('a cashier on a discount over cashierDiscountPctCap: 4 wrong, a known manager PIN (order made), then the 5th wrong flags and the 6th is 429', async () => {
    const cashier = await mkUser(`resimt-rv1c-${randomUUID().slice(0, 6)}`, 'cashier', A.tenantId)
    const twenty = 29_000 // 20% — over the 10% cashier cap
    for (let i = 0; i < 4; i++) expect((await ringDiscount(cashier, twenty, `82000${i}`)).json().error.code).toBe('INVALID_MANAGER_PIN')
    expect((await ringDiscount(cashier, twenty, PIN_A)).statusCode).toBe(201)
    expect((await ringDiscount(cashier, twenty, '820009')).json().error.code).toBe('INVALID_MANAGER_PIN')
    expect(await flagsFor(cashier.id)).toBe(1)
    const sixth = await ringDiscount(cashier, twenty, '820010')
    expect(sixth.statusCode).toBe(429)
    expect(sixth.json().error.code).toBe('MANAGER_PIN_LOCKED')
    expect((await ringDiscount(cashier, twenty, PIN_A)).json().error.code).toBe('MANAGER_PIN_LOCKED')
    // Company B's books see none of it.
    expect(await prisma.exceptionFlag.count({ where: { actorId: cashier.id, tenantId: B.tenantId } })).toBe(0)
  })

  it('voids on fresh ring-ups (a new order bucket each time) do not reset the actor either', async () => {
    const cashier = await mkUser(`resimt-rv1v-${randomUUID().slice(0, 6)}`, 'cashier', A.tenantId)
    const codes: string[] = []
    for (let cycle = 0; cycle < 2; cycle++) {
      const o = await ticket(cashier, A)
      for (let i = 0; i < 4; i++) codes.push((await voidLine(cashier, o.id, o.items[0]!.id, `83${cycle}00${i}`)).json().error.code)
      const r = await voidLine(cashier, o.id, o.items[0]!.id, PIN_A)
      codes.push(r.statusCode === 200 ? 'OK' : r.json().error.code)
    }
    // Cycle 1: 4 wrong + OK. Cycle 2: the 1st wrong is the 5th (flag), the rest are locked.
    expect(codes).toEqual([
      'INVALID_MANAGER_PIN', 'INVALID_MANAGER_PIN', 'INVALID_MANAGER_PIN', 'INVALID_MANAGER_PIN', 'OK',
      'INVALID_MANAGER_PIN', 'MANAGER_PIN_LOCKED', 'MANAGER_PIN_LOCKED', 'MANAGER_PIN_LOCKED', 'MANAGER_PIN_LOCKED',
    ])
    expect(await flagsFor(cashier.id)).toBe(1)
  })
})

describe('T-RV-02 — a locked order does not charge an honest sender\'s own budget', () => {
  it('cashier 1 locks order X; cashier 2 retries the right PIN on X (429 each) and can still void on order Y', async () => {
    const c1 = await mkUser(`resimt-rv2a-${randomUUID().slice(0, 6)}`, 'cashier', A.tenantId)
    const c2 = await mkUser(`resimt-rv2b-${randomUUID().slice(0, 6)}`, 'cashier', A.tenantId)
    const x = await ticket(c1, A)
    for (let i = 0; i < 5; i++) expect((await voidLine(c1, x.id, x.items[0]!.id, `84000${i}`)).json().error.code).toBe('INVALID_MANAGER_PIN')
    for (let i = 0; i < 6; i++) {
      const r = await voidLine(c2, x.id, x.items[0]!.id, PIN_A)
      expect(r.statusCode).toBe(429)
      expect(r.json().error.code).toBe('MANAGER_PIN_LOCKED')
    }
    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: x.items[0]!.id } })).voidedAt).toBeNull()
    const y = await ticket(c2, A)
    expect((await voidLine(c2, y.id, y.items[0]!.id, PIN_A)).statusCode).toBe(200)
    // Nothing names cashier 2: no failures audited, no flag.
    expect(await prisma.auditLog.count({ where: { action: 'manager_pin.failed', userId: c2.id } })).toBe(0)
    expect(await prisma.exceptionFlag.count({ where: { actorId: c2.id } })).toBe(0)
    // Cashier 2 still has the full budget: 4 wrong on a fresh order are all 403.
    const z = await ticket(c2, A)
    for (let i = 0; i < 4; i++) expect((await voidLine(c2, z.id, z.items[1]!.id, `84100${i}`)).json().error.code).toBe('INVALID_MANAGER_PIN')
  })
})

// ─── FOH-R2-03 ────────────────────────────────────────────────────────────────

describe('FOH-R2-03 — over-cap discount PIN errors and the discount alert', () => {
  const ring = (who: Who, pin?: string) => call(who, 'POST', '/pos/orders', {
    conceptId: A.conceptId,
    items: [{ menuItemId: A.items.nihari, name: 'Beef Nihari', quantity: 1, unitPriceCents: 145_000, modifiers: [] }],
    discountCents: 36_250, discountReason: 'regular', // 25%
    ...(pin !== undefined && { managerOverridePin: pin }),
  })

  it('no PIN → DISCOUNT_OVER_CAP; a wrong PIN or company B\'s manager PIN → 403 INVALID_MANAGER_PIN', async () => {
    const cashier = await mkUser(`resimt-d1-${randomUUID().slice(0, 6)}`, 'cashier', A.tenantId)
    expect((await ring(cashier)).json().error.code).toBe('DISCOUNT_OVER_CAP')
    for (const pin of ['999999', PIN_B]) {
      const r = await ring(cashier, pin)
      expect(r.statusCode).toBe(403)
      expect(r.json().error.code).toBe('INVALID_MANAGER_PIN')
    }
  })

  it('an authorised 25% discount flags a discount (not a void) for the company, pointing at the order', async () => {
    const cashier = await mkUser(`resimt-d2-${randomUUID().slice(0, 6)}`, 'cashier', A.tenantId)
    const r = await ring(cashier, PIN_A)
    expect(r.statusCode, r.body).toBe(201)
    const flag = await prisma.exceptionFlag.findFirst({ where: { actorId: cashier.id, title: { contains: 'discount' } } })
    expect(flag).toBeTruthy()
    expect(flag!.kind).not.toBe('high_value_void')
    expect(flag!.kind).toBe('discount_above_cap')
    expect(flag!.entityType).toBe('Order')
    expect(flag!.entityId).toBe(r.json().id)
    expect(flag!.tenantId).toBe(A.tenantId)
  })
})

// ─── BOH-R2-03 ────────────────────────────────────────────────────────────────

describe('BOH-R2-03 — a line voided after firing is booked as waste in the order\'s company', () => {
  // Let earlier tests' fire-and-forget depletions land before stock is read.
  beforeAll(() => new Promise((r) => setTimeout(r, 500)))
  async function firedTicket(who: Who, co: Company) {
    const o = await ticket(who, co)
    await deductInventoryForOrder(o.id)
    const nihari = o.items.find((i) => i.name === 'Beef Nihari')!
    await prisma.orderItem.update({ where: { id: nihari.id }, data: { status: 'preparing' } })
    return { o, nihari }
  }

  const entryOf = (orderItemId: string) => prisma.journalEntry.findFirst({
    where: { reference: `pos.void_waste:${orderItemId}` },
    include: { lines: { include: { account: { select: { code: true } } } } },
  })

  it('company A: WasteLog (void_after_fire, PKR 300) + Dr 1290 / Cr 1210 in A, stock stays out, nothing in B', async () => {
    const { o, nihari } = await firedTicket(mgrA, A)
    const sale = await prisma.stockMovement.findMany({ where: { orderItemId: nihari.id, kind: 'sale' } })
    expect(sale.reduce((s, m) => s - m.qty, 0)).toBeCloseTo(0.15, 6)
    expect(sale.every((m) => m.tenantId === A.tenantId && m.sourceType === 'order_item.sale')).toBe(true)
    const out = await stock(beef[A.tenantId]!)
    const v = await voidLine(mgrA, o.id, nihari.id)
    expect(v.statusCode, v.body).toBe(200)
    expect(v.json().stockRestored).toEqual({})
    expect(v.json().stockWasted).toEqual({ [beef[A.tenantId]!]: expect.closeTo(0.15, 6) })
    expect(await stock(beef[A.tenantId]!)).toBeCloseTo(out, 6)

    const logs = await prisma.wasteLog.findMany({ where: { inventoryItemId: beef[A.tenantId]!, reason: 'void_after_fire', orderItemId: nihari.id } })
    expect(logs).toHaveLength(1)
    expect(logs[0]!.tenantId).toBe(A.tenantId)
    // Relabelled, not re-drawn: the sale is netted out (sale_void) and taken as waste, on the same lot.
    const relabel = await prisma.stockMovement.findMany({ where: { orderItemId: nihari.id, kind: { in: ['sale_void', 'waste'] } } })
    expect(relabel.map((m) => m.kind).sort()).toEqual(['sale_void', 'waste'])
    expect(relabel.every((m) => m.lotId === sale[0]!.lotId && m.sourceType === 'waste_log' && m.sourceId === logs[0]!.id)).toBe(true)
    expect(logs[0]!.estimatedCostCents).toBe(30_000)
    expect(logs[0]!.quantity).toBeCloseTo(0.15, 6)
    expect(logs[0]!.approvedById).toBe(mgrA.id)

    const je = await entryOf(nihari.id)
    expect(je?.tenantId).toBe(A.tenantId)
    const dr = je!.lines.filter((l) => l.type === 'debit').reduce((s, l) => s + l.amountCents, 0)
    const cr = je!.lines.filter((l) => l.type === 'credit').reduce((s, l) => s + l.amountCents, 0)
    expect(dr).toBe(30_000)
    expect(cr).toBe(30_000)
    expect(je!.lines.find((l) => l.type === 'debit')!.account.code).toBe('1290')
    expect(je!.lines.find((l) => l.type === 'credit')!.account.code).toBe('1210')
    expect(await prisma.journalEntry.count({ where: { reference: `pos.void_waste:${nihari.id}`, tenantId: B.tenantId } })).toBe(0)

    // The order is then cancelled: the binned dish does not come back on the shelf.
    expect((await call(mgrA, 'POST', `/orders/${o.id}/cancel`, { reason: 'guest left' })).statusCode).toBe(200)
    expect(await stock(beef[A.tenantId]!)).toBeCloseTo(out, 6)
  })

  it('an unfired line gives its stock back and books no waste', async () => {
    const o = await ticket(mgrA, A)
    await deductInventoryForOrder(o.id)
    const out = await stock(beef[A.tenantId]!)
    const nihari = o.items.find((i) => i.name === 'Beef Nihari')!
    const v = await voidLine(mgrA, o.id, nihari.id)
    expect(v.statusCode, v.body).toBe(200)
    expect(v.json().stockWasted).toEqual({})
    expect(await stock(beef[A.tenantId]!)).toBeCloseTo(out + 0.15, 6)
    expect(await prisma.wasteLog.count({ where: { notes: { contains: nihari.id } } })).toBe(0)
    expect(await entryOf(nihari.id)).toBeNull()
  })

  it('company B: B\'s fired line posts in B\'s books, through B\'s manager PIN', async () => {
    const { o, nihari } = await firedTicket(cashierB, B)
    const v = await voidLine(cashierB, o.id, nihari.id, PIN_B)
    expect(v.statusCode, v.body).toBe(200)
    const je = await entryOf(nihari.id)
    expect(je?.tenantId).toBe(B.tenantId)
    expect(je!.lines.reduce((s, l) => s + (l.type === 'debit' ? l.amountCents : 0), 0)).toBe(30_000)
  })

  it('a closed period: the void stands, the waste is logged, the ledger refusal is flagged for finance', async () => {
    const lock = await prisma.periodLock.create({ data: { tenantId: A.tenantId, lockedThrough: new Date(Date.now() + 2 * 86_400_000), lockedBy: mgrA.id, note: 'test' } })
    try {
      const { o, nihari } = await firedTicket(mgrA, A)
      const v = await voidLine(mgrA, o.id, nihari.id)
      expect(v.statusCode, v.body).toBe(200)
      expect(await prisma.wasteLog.count({ where: { notes: { contains: nihari.id } } })).toBe(1)
      expect(await entryOf(nihari.id)).toBeNull()
      const flag = await prisma.exceptionFlag.findFirst({ where: { kind: 'posting_failed', entityId: nihari.id } })
      expect(flag?.tenantId).toBe(A.tenantId)
      expect(flag?.amountCents).toBe(30_000)
    } finally {
      await prisma.periodLock.delete({ where: { id: lock.id } })
    }
  })
})

// ─── R2-UI-01 / R2-UI-07 ──────────────────────────────────────────────────────

describe('R2-UI-01 — the ring-up carries its payments', () => {
  it('a fresh ring-up and its idempotent replay both answer with payments: [] and items with modifiers', async () => {
    const cashier = await mkUser(`resimt-ui-${randomUUID().slice(0, 6)}`, 'cashier', A.tenantId)
    const key = randomUUID()
    const first = await ticket(cashier, A, { idempotencyKey: key, paymentMethod: 'cash' })
    expect(first.payments).toEqual([])
    expect(Array.isArray(first.items[0]!.modifiers)).toBe(true)
    const again = await ticket(cashier, A, { idempotencyKey: key, paymentMethod: 'cash' })
    expect(again.id).toBe(first.id)
    expect(again.payments).toEqual([])
  })
})

describe('R2-UI-07 — a huge mistyped tender is a 422, not a 500', () => {
  it('tenderedCents / amountCents / tipCents beyond the column → 422 AMOUNT_TOO_LARGE; nothing written', async () => {
    const cashier = await mkUser(`resimt-big-${randomUUID().slice(0, 6)}`, 'cashier', A.tenantId)
    const shift = await call(cashier, 'POST', '/pos/shifts/open', { openingFloatCents: 500_000 })
    expect(shift.statusCode, shift.body).toBe(201)
    const o = await ticket(cashier, A)
    for (const tender of [
      { method: 'cash', amountCents: o.totalCents, tenderedCents: 66_301_188_000 },
      { method: 'cash', amountCents: 66_301_188_000 },
      { method: 'cash', amountCents: o.totalCents + 5_000_000_000, tipCents: 5_000_000_000 },
    ]) {
      const r = await call(cashier, 'POST', '/pos/payments', { orderId: o.id, shiftId: shift.json().id, payments: [tender] })
      expect(r.statusCode, r.body).toBe(422)
      expect(r.json().error.code).toBe('AMOUNT_TOO_LARGE')
    }
    expect(await prisma.payment.count({ where: { orderId: o.id, status: 'paid' } })).toBe(0)
  })
})
