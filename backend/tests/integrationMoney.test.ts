// I1 — money guards on gift cards and loyalty, and the storefront tip.
//
//   W4-MONEY-1 item 3: while the card machine is charging a bill, the bill
//   must not move at all. The till's own gift-card tender already checked
//   this; the gift-card engine itself (redeemGiftCardTx — the admin redeem
//   and storefront checkout) and the loyalty bill moves (adjustOrderBill,
//   redeemPointsOnOrder) did not. Each now takes the order's row lock FIRST
//   (the same lock the till takes, so the lock order is unchanged) and then
//   refuses with 409 TERMINAL_CHARGE_ACTIVE {chargeId}, card / points / bill
//   untouched. redeemPointsOnOrder also reads status, the once-per-order
//   check and what is still owed under that lock, so two redeems on one order
//   can no longer both pass, and the discount never pushes the bill below
//   money already taken.
//
//   Storefront tip: tip_cents is on OrderDTO and always goes into the insert
//   (the wallet-as-method checkout used to patch it in a second write).
//
// Two companies: B's staff get 404 on A's order, and B's card / B's points
// are unknown on A's order.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { AppError, errorResponse } from '../src/lib/errors.js'
import { giftCardRoutes } from '../src/modules/giftCards/routes.js'
import { loyaltyRoutes } from '../src/modules/loyalty/routes.js'
import { storefrontRoutes } from '../src/modules/storefront/routes.js'
import { redeemGiftCard } from '../src/modules/giftCards/service.js'
import { adjustOrderBill, redeemPointsOnOrder, ensureLoyaltyAccountTx } from '../src/modules/loyalty/service.js'
import { ingestOrder } from '../src/modules/orders/service.js'
import {
  prisma, mkCompany, mkUser, caller, setConnector, resetConnectorCache, terminalSettings,
  type Company, type Who,
} from './connectorsFixtures.js'

const RUN = Math.random().toString(36).slice(2, 8)
let app: FastifyInstance
let A: Company, B: Company
let cashierA: Who, ceoA: Who, ceoB: Who
let terminalA: string

const call = (...args: Parameters<ReturnType<typeof caller>>) => caller(app)(...args)
const customerToken = (id: string) => jwt.sign({ sub: id, type: 'customer' }, process.env['JWT_SECRET'] as string, { expiresIn: '2h' })
const asCustomer = (id: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as never, headers: { authorization: `Bearer ${customerToken(id)}` } })

let seq = 0
async function mkCustomer(walletBalance = 0) {
  seq += 1
  return prisma.customer.create({
    data: {
      name: `Guest ${seq}`, email: `im-${RUN}-${seq}@example.com`,
      phone: `+92311${RUN.replace(/\D/g, '').padEnd(3, '1').slice(0, 3)}${String(seq).padStart(4, '0')}`,
      phoneVerifiedAt: new Date(), walletBalance,
    },
  })
}

/** An open online order: `paid` already taken, the rest on a pending card row. */
async function onlineOrder(co: Company, opts: { totalCents: number; paidCents?: number; customerId?: string | null }) {
  const paid = opts.paidCents ?? 0
  const o = await prisma.order.create({
    data: {
      conceptId: co.conceptId, locationId: co.locationId, source: 'servd', fulfilmentType: 'takeout', status: 'received',
      totalCents: opts.totalCents, taxCents: 0, customerId: opts.customerId ?? null,
      items: { create: [{ name: 'Beef Nihari', quantity: 1, unitPriceCents: opts.totalCents }] },
      payments: {
        create: [
          ...(paid > 0 ? [{ method: 'card' as const, amountCents: paid, status: 'paid' as const, processedAt: new Date() }] : []),
          ...(opts.totalCents - paid > 0 ? [{ method: 'card' as const, amountCents: opts.totalCents - paid, status: 'pending' as const }] : []),
        ],
      },
    },
  })
  return o.id
}

/** A card-machine charge on the order in `status` (default: sent — in flight). */
async function charge(orderId: string, amountCents: number, status: 'sent' | 'pending' | 'approved' | 'unknown' = 'sent') {
  return (await prisma.terminalCharge.create({
    data: {
      tenantId: A.tenantId, connectorId: terminalA, terminalId: 'trm-1', orderId, amountCents, quoteDueCents: amountCents,
      idempotencyKey: randomUUID(), status, expiresAt: new Date(Date.now() + 10 * 60_000), createdById: cashierA.id,
    },
  })).id
}
const finish = (chargeId: string) => prisma.terminalCharge.update({ where: { id: chargeId }, data: { status: 'cancelled', resolvedAt: new Date() } })

async function bill(orderId: string) {
  const o = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { payments: true } })
  const pending = o.payments.filter((p) => p.status === 'pending').reduce((s, p) => s + p.amountCents, 0)
  return { totalCents: o.totalCents, discountCents: o.discountCents, pending }
}

async function giveCard(tenantId: string, cents: number) {
  return prisma.giftCard.create({ data: { tenantId, code: `GS-IM-${RUN}-${++seq}`.toUpperCase(), issuedAmountCents: cents, balanceCents: cents } })
}

async function givePoints(customerId: string, tenantId: string, points: number) {
  return prisma.$transaction(async (tx) => {
    const acc = await ensureLoyaltyAccountTx(tx, customerId, tenantId)
    return tx.loyaltyAccount.update({ where: { id: acc.id }, data: { pointsBalance: points, lifetimePoints: points } })
  })
}
const pointsOf = async (customerId: string, tenantId: string) =>
  (await prisma.loyaltyAccount.findUnique({ where: { tenantId_customerId: { tenantId, customerId } } }))?.pointsBalance ?? 0

beforeAll(async () => {
  A = await mkCompany(`im-a-${RUN}`, { srbPosId: 8201 })
  B = await mkCompany(`im-b-${RUN}`, { srbPosId: 8202 })
  cashierA = await mkUser(`im-cashier-a-${RUN}`, 'cashier', A.tenantId)
  // The gift-card routes are module-gated (gift_cards): the company's CEO.
  ceoA = await mkUser(`im-ceo-a-${RUN}`, 'admin', A.tenantId)
  ceoB = await mkUser(`im-ceo-b-${RUN}`, 'admin', B.tenantId)
  await setConnector(A.tenantId, 'terminal', { driver: 'test', enabled: true, settings: terminalSettings(A, 'never') })
  terminalA = (await prisma.posConnector.findUniqueOrThrow({ where: { tenantId_kind: { tenantId: A.tenantId, kind: 'terminal' } } })).id

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: 'ERROR', message: (err as Error).message } })
  })
  await app.register(giftCardRoutes, { prefix: '/gift-cards' })
  await app.register(loyaltyRoutes, { prefix: '/loyalty' })
  await app.register(storefrontRoutes, { prefix: '/storefront' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  resetConnectorCache()
  await app?.close()
})

// ─── Gift cards ───────────────────────────────────────────────────────────────

describe('a gift card cannot lower a bill the card machine is charging', () => {
  it('admin redeem on an online order: 409 TERMINAL_CHARGE_ACTIVE, card and bill untouched; applies once the charge is final', async () => {
    const orderId = await onlineOrder(A, { totalCents: 120_000 })
    const card = await giveCard(A.tenantId, 50_000)
    const chargeId = await charge(orderId, 120_000)
    const before = await bill(orderId)

    const r = await call(ceoA, 'POST', '/gift-cards/redeem', { code: card.code, orderId })
    expect(r.statusCode).toBe(409)
    expect(r.json().error).toMatchObject({ code: 'TERMINAL_CHARGE_ACTIVE', details: { chargeId } })
    expect(await bill(orderId)).toEqual(before)
    expect((await prisma.giftCard.findUniqueOrThrow({ where: { id: card.id } })).balanceCents).toBe(50_000)
    expect(await prisma.giftCardRedemption.count({ where: { orderId } })).toBe(0)

    // Every status that may still take money holds the bill.
    for (const status of ['pending', 'approved', 'unknown'] as const) {
      await prisma.terminalCharge.update({ where: { id: chargeId }, data: { status } })
      await expect(redeemGiftCard({ code: card.code, orderId })).rejects.toMatchObject({ code: 'TERMINAL_CHARGE_ACTIVE', statusCode: 409 })
    }
    expect(await bill(orderId)).toEqual(before)

    await finish(chargeId)
    const ok = await call(ceoA, 'POST', '/gift-cards/redeem', { code: card.code, orderId })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toMatchObject({ appliedCents: 50_000, remainingDueCents: 70_000, cardBalanceCents: 0 })
    expect(await bill(orderId)).toEqual({ totalCents: 70_000, discountCents: 0, pending: 70_000 })
  })

  it('the storefront redeem (redeemGiftCard) is refused the same way', async () => {
    const orderId = await onlineOrder(A, { totalCents: 80_000 })
    const card = await giveCard(A.tenantId, 30_000)
    await charge(orderId, 80_000)
    await expect(redeemGiftCard({ code: card.code, orderId })).rejects.toMatchObject({ code: 'TERMINAL_CHARGE_ACTIVE', statusCode: 409 })
    expect(await bill(orderId)).toEqual({ totalCents: 80_000, discountCents: 0, pending: 80_000 })
    expect((await prisma.giftCard.findUniqueOrThrow({ where: { id: card.id } })).balanceCents).toBe(30_000)
  })

  it('two companies: B\'s CEO gets 404 on A\'s order; B\'s card is unknown on A\'s order', async () => {
    const orderId = await onlineOrder(A, { totalCents: 60_000 })
    const cardA = await giveCard(A.tenantId, 10_000)
    const cardB = await giveCard(B.tenantId, 10_000)
    const foreign = await call(ceoB, 'POST', '/gift-cards/redeem', { code: cardA.code, orderId })
    expect(foreign.statusCode).toBe(404)
    const wrongCard = await call(ceoA, 'POST', '/gift-cards/redeem', { code: cardB.code, orderId })
    expect(wrongCard.statusCode).toBe(404)
    expect(await bill(orderId)).toEqual({ totalCents: 60_000, discountCents: 0, pending: 60_000 })
    expect((await prisma.giftCard.findUniqueOrThrow({ where: { id: cardB.id } })).balanceCents).toBe(10_000)
  })
})

// ─── Loyalty ──────────────────────────────────────────────────────────────────

describe('points cannot lower a bill the card machine is charging', () => {
  it('POST /loyalty/redeem: 409 TERMINAL_CHARGE_ACTIVE, points, discount and bill untouched; redeems once the charge is final', async () => {
    const c = await mkCustomer()
    await givePoints(c.id, A.tenantId, 5_000)
    const orderId = await onlineOrder(A, { totalCents: 100_000, customerId: c.id })
    const chargeId = await charge(orderId, 100_000)
    const before = await bill(orderId)

    const r = await asCustomer(c.id, 'POST', '/loyalty/redeem', { orderId, pointsToRedeem: 1_000 })
    expect(r.statusCode).toBe(409)
    expect(r.json().error).toMatchObject({ code: 'TERMINAL_CHARGE_ACTIVE', details: { chargeId } })
    expect(await bill(orderId)).toEqual(before)
    expect(await pointsOf(c.id, A.tenantId)).toBe(5_000)
    expect(await prisma.loyaltyTransaction.count({ where: { orderId } })).toBe(0)

    await finish(chargeId)
    const ok = await asCustomer(c.id, 'POST', '/loyalty/redeem', { orderId, pointsToRedeem: 1_000 })
    expect(ok.statusCode).toBe(200)
    // 1,000 pts × 10 paisa = PKR 100.
    expect(ok.json()).toMatchObject({ pointsRedeemed: 1_000, discountCents: 10_000, newBalance: 4_000 })
    expect(await bill(orderId)).toEqual({ totalCents: 90_000, discountCents: 10_000, pending: 90_000 })
    // Once per order.
    const again = await asCustomer(c.id, 'POST', '/loyalty/redeem', { orderId, pointsToRedeem: 1_000 })
    expect(again.statusCode).toBe(409)
    expect(again.json().error.code).toBe('ALREADY_REDEEMED')
  })

  it('adjustOrderBill refuses to move the bill either way while a charge is in flight, then moves bill and pending row together', async () => {
    const orderId = await onlineOrder(A, { totalCents: 50_000 })
    const chargeId = await charge(orderId, 50_000)
    await expect(adjustOrderBill(orderId, 5_000)).rejects.toMatchObject({ code: 'TERMINAL_CHARGE_ACTIVE', statusCode: 409 })
    await expect(adjustOrderBill(orderId, -5_000)).rejects.toMatchObject({ code: 'TERMINAL_CHARGE_ACTIVE', statusCode: 409 })
    expect(await bill(orderId)).toEqual({ totalCents: 50_000, discountCents: 0, pending: 50_000 })

    await finish(chargeId)
    await adjustOrderBill(orderId, 5_000)
    expect(await bill(orderId)).toEqual({ totalCents: 45_000, discountCents: 0, pending: 45_000 })
    await adjustOrderBill(orderId, -5_000)
    expect(await bill(orderId)).toEqual({ totalCents: 50_000, discountCents: 0, pending: 50_000 })
  })

  it('two redeems on one order at once: exactly one passes, the points are taken once', async () => {
    const c = await mkCustomer()
    await givePoints(c.id, A.tenantId, 5_000)
    const orderId = await onlineOrder(A, { totalCents: 100_000, customerId: c.id })
    const results = await Promise.allSettled([
      redeemPointsOnOrder({ customerId: c.id, orderId, points: 1_000 }),
      redeemPointsOnOrder({ customerId: c.id, orderId, points: 1_000 }),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect(failed.reason).toMatchObject({ code: 'ALREADY_REDEEMED' })
    expect(await pointsOf(c.id, A.tenantId)).toBe(4_000)
    expect(await bill(orderId)).toEqual({ totalCents: 90_000, discountCents: 10_000, pending: 90_000 })
  })

  it('a gift card and points on the same order at once both land (same lock order, no deadlock)', async () => {
    const c = await mkCustomer()
    await givePoints(c.id, A.tenantId, 5_000)
    const orderId = await onlineOrder(A, { totalCents: 100_000, customerId: c.id })
    const card = await giveCard(A.tenantId, 20_000)
    const [g, l] = await Promise.all([
      redeemGiftCard({ code: card.code, orderId }),
      redeemPointsOnOrder({ customerId: c.id, orderId, points: 1_000 }),
    ])
    expect(g.appliedCents).toBe(20_000)
    expect(l.discountCents).toBe(10_000)
    expect(await bill(orderId)).toEqual({ totalCents: 70_000, discountCents: 10_000, pending: 70_000 })
  })

  it('the discount is capped at what is still owed, never below money already taken', async () => {
    const c = await mkCustomer()
    await givePoints(c.id, A.tenantId, 50_000)
    const orderId = await onlineOrder(A, { totalCents: 50_000, paidCents: 45_000, customerId: c.id })
    const r = await redeemPointsOnOrder({ customerId: c.id, orderId, points: 50_000 })
    // Owed 5,000 paisa → 500 pts at 10 paisa.
    expect(r).toMatchObject({ pointsRedeemed: 500, discountCents: 5_000, newBalance: 49_500 })
    expect(await bill(orderId)).toEqual({ totalCents: 45_000, discountCents: 5_000, pending: 0 })

    const paidUp = await onlineOrder(A, { totalCents: 30_000, paidCents: 30_000, customerId: c.id })
    await expect(redeemPointsOnOrder({ customerId: c.id, orderId: paidUp, points: 1_000 })).rejects.toMatchObject({ code: 'NOTHING_DUE' })
    expect(await pointsOf(c.id, A.tenantId)).toBe(49_500)
  })

  // I1-RV-1: the redeem is one interactive transaction holding a pool
  // connection and the order lock. Every read it makes must go through that
  // transaction — a read on the global client needs a SECOND connection, so
  // as many concurrent redeems as the pool has connections each held one and
  // waited forever for another (all failed at the 5 s transaction timeout,
  // and every other request in the API waited on the pool meanwhile). Run in
  // a child process so the pool size is fixed (connection_limit=3) and the
  // settings cache starts cold, as on a fresh API process.
  it('as many concurrent redeems as the pool has connections all succeed (no read outside the transaction)', async () => {
    const POOL = 3
    const jobs: Array<{ customerId: string; orderId: string }> = []
    for (let i = 0; i < POOL; i++) {
      const c = await mkCustomer()
      await givePoints(c.id, A.tenantId, 5_000)
      jobs.push({ customerId: c.id, orderId: await onlineOrder(A, { totalCents: 100_000, customerId: c.id }) })
    }
    const base = process.env['DATABASE_URL'] as string
    const url = `${base}${base.includes('?') ? '&' : '?'}connection_limit=${POOL}&pool_timeout=30`
    const script = `
      const { redeemPointsOnOrder } = await import('./src/modules/loyalty/service.js')
      const jobs = ${JSON.stringify(jobs)}
      const t0 = Date.now()
      const r = await Promise.allSettled(jobs.map((j) => redeemPointsOnOrder({ ...j, points: 1000 })))
      console.log('RESULT ' + JSON.stringify({ ms: Date.now() - t0, r: r.map((x) => x.status === 'fulfilled' ? x.value : { error: String(x.reason?.message ?? x.reason) }) }))
      process.exit(0)
    `
    const cwd = fileURLToPath(new URL('..', import.meta.url))
    const { stdout } = await promisify(execFile)(fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url)), ['-e', `(async () => {${script}})()`], {
      cwd, env: { ...process.env, DATABASE_URL: url, NODE_ENV: 'test' }, timeout: 60_000,
    })
    const line = stdout.split('\n').find((l) => l.startsWith('RESULT '))
    expect(line).toBeTruthy()
    const out = JSON.parse(line!.slice(7)) as { ms: number; r: Array<Record<string, unknown>> }
    expect(out.r).toEqual(jobs.map(() => ({ pointsRedeemed: 1_000, discountCents: 10_000, newBalance: 4_000 })))
    expect(out.ms).toBeLessThan(5_000)
    for (const j of jobs) {
      expect(await pointsOf(j.customerId, A.tenantId)).toBe(4_000)
      expect(await bill(j.orderId)).toEqual({ totalCents: 90_000, discountCents: 10_000, pending: 90_000 })
    }
  }, 90_000)

  it('two companies: another customer\'s order is 404; points held at B do not pay A\'s bill', async () => {
    const owner = await mkCustomer()
    const other = await mkCustomer()
    await givePoints(other.id, A.tenantId, 5_000)
    const orderId = await onlineOrder(A, { totalCents: 40_000, customerId: owner.id })
    const r = await asCustomer(other.id, 'POST', '/loyalty/redeem', { orderId, pointsToRedeem: 1_000 })
    expect(r.statusCode).toBe(404)

    await givePoints(owner.id, B.tenantId, 5_000)
    const atA = await asCustomer(owner.id, 'POST', '/loyalty/redeem', { orderId, pointsToRedeem: 1_000 })
    expect(atA.statusCode).toBe(400)
    expect(atA.json().error.code).toBe('LOYALTY_BELOW_MINIMUM')
    expect(await pointsOf(owner.id, B.tenantId)).toBe(5_000)
    expect(await bill(orderId)).toEqual({ totalCents: 40_000, discountCents: 0, pending: 40_000 })
  })
})

// ─── Storefront tip ───────────────────────────────────────────────────────────

describe('the storefront tip is written in the order insert', () => {
  it('wallet as the method with a tip: the order carries its tip, nothing is left to collect', async () => {
    const c = await mkCustomer()
    // The wallet is per company (ONL-R2-01): the balance at A's company.
    await prisma.customerWallet.create({ data: { tenantId: A.tenantId, customerId: c.id, balanceCents: 500_000 } })
    const r = await asCustomer(c.id, 'POST', '/storefront/orders', {
      conceptSlug: `brand-im-a-${RUN}`, type: 'pickup', paymentGateway: 'wallet', useWallet: true, tipCents: 10_000,
      items: [{ menuItemId: A.items.kheer, quantity: 1, modifiers: [] }],
    })
    expect(r.statusCode).toBe(201)
    const row = await prisma.order.findUniqueOrThrow({ where: { id: r.json().id }, include: { payments: true } })
    // Kheer 550 + 8% card GST 44 = 594, + PKR 100 tip — all from the wallet.
    expect(row).toMatchObject({ totalCents: 0, tipCents: 10_000, walletAmountCents: 69_400 })
    expect(row.payments.filter((p) => p.status === 'pending').reduce((s, p) => s + p.amountCents, 0)).toBe(0)
  })

  it('ingestOrder takes tip_cents up to the payment plus the wallet share, and refuses more', async () => {
    const base = {
      source: 'servd' as const, concept_id: A.conceptId, placed_at: new Date().toISOString(),
      customer_id: null, customer_name: null, loyalty_points_earned: null, delivery_notes: null, estimated_pickup: null,
      items: [{ externalItemId: 'x', menuItemId: A.items.kheer, name: 'Kheer', quantity: 1, unitPriceCents: 55_000, modifiers: [] }],
    }
    const { order } = await ingestOrder({
      ...base, external_id: `im-${randomUUID()}`,
      payment: { provider: 'wallet', amountCents: 0, status: 'pending' }, wallet_amount_cents: 60_000, tip_cents: 5_000,
    })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).tipCents).toBe(5_000)

    await expect(ingestOrder({
      ...base, external_id: `im-${randomUUID()}`,
      payment: { provider: 'wallet', amountCents: 1_000, status: 'pending' }, wallet_amount_cents: 2_000, tip_cents: 3_001,
    })).rejects.toMatchObject({ code: 'INVALID_TIP' })
  })
})
