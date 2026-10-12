// Loyalty in the books — regression tests for the simulated-shift findings.
//
//   BOOKS-08 / ONL-06 / FOH-17  a refund clawed earned points back off the
//       balance but booked nothing: 2060 Loyalty Liability and 6060 Marketing
//       stayed overstated. Now every clawed-back earn posts the mirror of its
//       accrual ('loyalty.earn.reversal:<earnId>', Dr 2060 / Cr 6060) in the
//       order's company, atomically with the points, once.
//   ONL-07  points a customer SPENT were lost when the order was cancelled,
//       rejected, auto-cancelled or refunded. Now they come back, with the
//       mirror of the redemption ('loyalty.redeem.reversal:<redeemId>',
//       Dr 7020 / Cr 2060), once.
//   ONL-04  one loyalty account per customer let points earned at company A be
//       spent at company B, which then carried a negative 2060. Accounts are
//       per company now: earn, redeem, expire and reverse all stay in the
//       account (and the books) of the order's company; staff of one company
//       see only their company's account.
//
// Requires a disposable database (DATABASE_URL must contain "test").
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { crmRoutes } from '../src/modules/crm/routes.js'
import { loyaltyRoutes } from '../src/modules/loyalty/routes.js'
import { reviewRoutes } from '../src/modules/reviews/routes.js'
import {
  awardOrderPoints, creditPoints, quoteRedemption, claimRedemption, loyaltyAccountOf, loyaltyAccountsOf,
} from '../src/modules/loyalty/service.js'
import { postLoyaltyExpire, postLoyaltyReversal } from '../src/modules/accounting/loyaltyPosting.js'
import { postOrderRefund } from '../src/modules/accounting/orderPosting.js'
import { cancelOrder } from '../src/modules/orders/service.js'

const RUN = Math.random().toString(36).slice(2, 8)
let app: FastifyInstance
let tenantA: string, tenantB: string, conceptA: string, conceptB: string
let slugA: string, slugB: string
const staff: Record<string, { id: string; token: string }> = {}

async function mkStaff(key: string, tenantId: string) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${RUN}@ledgerloyalty.test`, password: await bcrypt.hash('x-Password-1', 4), role: 'admin', isActive: true, accountStatus: 'active', tenantId } as never,
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } })
  staff[key] = { id: u.id, token: (issueStaffSession(u) as { accessToken: string }).accessToken }
}
const asStaff = (who: string, url: string) =>
  app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${staff[who]!.token}` } })
const customerToken = (id: string) => jwt.sign({ sub: id, type: 'customer' }, process.env['JWT_SECRET'] as string, { expiresIn: '1h' })
const asCustomer = (id: string, url: string, payload?: unknown) =>
  app.inject({ method: payload ? 'POST' : 'GET', url, payload: payload as never, headers: { authorization: `Bearer ${customerToken(id)}` } })

let seq = 0
async function mkCustomer(key: string) {
  seq += 1
  return prisma.customer.create({ data: { name: key, email: `${key}.${seq}.${RUN}@ledgerloyalty.test` } })
}

async function mkOrder(conceptId: string, customerId: string, totalCents: number, status: 'completed' | 'received' = 'completed', placedAt = new Date()) {
  const o = await prisma.order.create({
    data: {
      conceptId, customerId, source: 'servd', status, totalCents, placedAt,
      completedAt: status === 'completed' ? new Date() : null,
      items: { create: [{ name: 'Club sandwich', quantity: 1, unitPriceCents: totalCents }] },
    },
  })
  if (status !== 'completed') await prisma.payment.create({ data: { orderId: o.id, method: 'cash', amountCents: totalCents, status: 'pending' } })
  return o
}

type Line = { code: string; type: string; amount: number }
async function entry(tenantId: string, reference: string): Promise<Line[] | null> {
  const je = await prisma.journalEntry.findFirst({
    where: { tenantId, reference },
    include: { lines: { include: { account: { select: { code: true, tenantId: true } } } } },
  })
  if (!je) return null
  for (const l of je.lines) expect(l.account.tenantId).toBe(tenantId)   // never another company's chart
  return je.lines.map((l) => ({ code: l.account.code, type: l.type, amount: l.amountCents }))
}
const amt = (lines: Line[], code: string, type: 'debit' | 'credit') =>
  lines.filter((l) => l.code === code && l.type === type).reduce((t, l) => t + l.amount, 0)
const balanced = (lines: Line[]) => amt2(lines, 'debit') === amt2(lines, 'credit')
const amt2 = (lines: Line[], type: string) => lines.filter((l) => l.type === type).reduce((t, l) => t + l.amount, 0)

/** Net credit balance of `code` in `tenantId`'s books over the given entries. */
async function netCredit(tenantId: string, code: string, references: string[]): Promise<number> {
  const lines = await prisma.journalLine.findMany({
    where: { account: { tenantId, code }, journalEntry: { tenantId, reference: { in: references } } },
    select: { type: true, amountCents: true },
  })
  return lines.reduce((t, l) => t + (l.type === 'credit' ? l.amountCents : -l.amountCents), 0)
}

async function waitFor<T>(fn: () => Promise<T>, ok: (x: T) => boolean, ms = 5000): Promise<T> {
  const until = Date.now() + ms
  let v = await fn()
  while (!ok(v) && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 50))
    v = await fn()
  }
  return v
}

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'Ledger GS', slug: `ll-a-${RUN}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'Ledger KGC', slug: `ll-b-${RUN}` } })).id
  await ensureChartOfAccounts(tenantA)
  await ensureChartOfAccounts(tenantB)
  slugA = `ll-stackd-${RUN}`
  slugB = `ll-kgc-${RUN}`
  conceptA = (await prisma.concept.create({ data: { name: 'Stackd LL', slug: slugA, type: 'restaurant', tenantId: tenantA } })).id
  conceptB = (await prisma.concept.create({ data: { name: 'KGC LL', slug: slugB, type: 'restaurant', tenantId: tenantB } })).id
  await mkStaff('mgrA', tenantA)
  await mkStaff('mgrB', tenantB)

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status((err as { statusCode?: number }).statusCode ?? 500).send({ error: { code: 'ERROR', message: (err as Error).message } })
  })
  await app.register(crmRoutes, { prefix: '/crm' })
  await app.register(loyaltyRoutes, { prefix: '/loyalty' })
  await app.register(reviewRoutes, { prefix: '/reviews' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  await app?.close()
})

// ─── BOOKS-08 / ONL-06 / FOH-17 ───────────────────────────────────────────────

describe('a refund that claws back earned points reverses the accrual', () => {
  it('posts Dr 2060 / Cr 6060 for every clawed-back earn, in the order\'s company, once', async () => {
    const c = await mkCustomer('refunded')
    const o = await mkOrder(conceptA, c.id, 115_000)                 // 1,150 pts at 1 pt / PKR 1
    const earned = await awardOrderPoints(o.id)
    expect(earned?.credited).toBe(true)
    // The review bonus: a second earn carrying the same orderId.
    const bonus = await creditPoints({ customerId: c.id, tenantId: tenantA, orderId: o.id, points: 50, description: 'Bonus: posted review within 24h' })
    const earns = await prisma.loyaltyTransaction.findMany({ where: { orderId: o.id, type: 'earn' }, orderBy: { createdAt: 'asc' } })
    expect(earns.map((e) => e.id)).toEqual([earned!.txId, bonus.txId])
    for (const e of earns) expect(await entry(tenantA, `loyalty.earn:${e.id}`)).not.toBeNull()

    await prisma.order.update({ where: { id: o.id }, data: { status: 'refunded' } })
    await postOrderRefund(o.id, 'Order refunded')

    for (const e of earns) {
      const accrual = (await entry(tenantA, `loyalty.earn:${e.id}`))!
      const rev = await entry(tenantA, `loyalty.earn.reversal:${e.id}`)
      expect(rev).not.toBeNull()
      expect(balanced(rev!)).toBe(true)
      // The mirror of what the earn booked: same value, sides swapped.
      expect(amt(rev!, '2060', 'debit')).toBe(amt(accrual, '2060', 'credit'))
      expect(amt(rev!, '6060', 'credit')).toBe(amt(accrual, '6060', 'debit'))
      expect(amt(rev!, '2060', 'debit')).toBe(e.pointsDelta * 10)   // PKR 0.10 a point
      // Nothing in the other company's books.
      expect(await entry(tenantB, `loyalty.earn.reversal:${e.id}`)).toBeNull()
    }
    const refs = earns.flatMap((e) => [`loyalty.earn:${e.id}`, `loyalty.earn.reversal:${e.id}`])
    expect(await netCredit(tenantA, '2060', refs)).toBe(0)
    expect(await netCredit(tenantA, '6060', refs)).toBe(0)

    const acct = await loyaltyAccountOf(c.id, tenantA)
    expect(acct?.pointsBalance).toBe(0)
    expect(acct?.lifetimePoints).toBe(0)

    // A replay (a second 'refunded' write, a retried job) changes nothing.
    await postOrderRefund(o.id, 'Order refunded')
    expect(await prisma.loyaltyTransaction.count({ where: { orderId: o.id, type: 'reversal' } })).toBe(2)
    expect(await prisma.journalEntry.count({ where: { tenantId: tenantA, reference: { in: earns.map((e) => `loyalty.earn.reversal:${e.id}`) } } })).toBe(2)
    expect((await loyaltyAccountOf(c.id, tenantA))?.pointsBalance).toBe(0)
  })

  it('reverses nothing in the books when the earn was never booked (no value moved)', async () => {
    const c = await mkCustomer('unbooked')
    const o = await mkOrder(conceptA, c.id, 10_000)
    const acct = await prisma.loyaltyAccount.create({ data: { tenantId: tenantA, customerId: c.id, pointsBalance: 100, lifetimePoints: 100 } })
    const earn = await prisma.loyaltyTransaction.create({ data: { loyaltyAccountId: acct.id, orderId: o.id, type: 'earn', pointsDelta: 100, description: 'Earned 100 pts (before postings existed)' } })
    expect(await postLoyaltyReversal(earn.id)).toMatchObject({ posted: false, reason: 'original_not_booked' })
    await prisma.order.update({ where: { id: o.id }, data: { status: 'refunded' } })
    await postOrderRefund(o.id, 'Order refunded')
    expect((await loyaltyAccountOf(c.id, tenantA))?.pointsBalance).toBe(0)
    expect(await entry(tenantA, `loyalty.earn.reversal:${earn.id}`)).toBeNull()
  })
})

// ─── ONL-07 ───────────────────────────────────────────────────────────────────

describe('points spent on an order come back when it is cancelled or refunded', () => {
  async function redeemOn(customerId: string, orderId: string, points: number) {
    const q = await quoteRedemption({ customerId, requestedPoints: points, tenantId: tenantA, capCents: 1_000_000 })
    expect(await claimRedemption({ customerId, orderId, quote: q })).toBe(true)
    return prisma.loyaltyTransaction.findFirstOrThrow({ where: { orderId, type: 'redeem' } })
  }

  it('a cancel gives the points back and reverses the redemption (Dr 7020 / Cr 2060), once', async () => {
    const c = await mkCustomer('cancelled')
    await creditPoints({ customerId: c.id, tenantId: tenantA, points: 1_000, description: 'Birthday bonus' })
    const o = await mkOrder(conceptA, c.id, 20_000, 'received')
    const redeem = await redeemOn(c.id, o.id, 300)
    expect((await loyaltyAccountOf(c.id, tenantA))?.pointsBalance).toBe(700)
    const burned = (await entry(tenantA, `loyalty.redeem:${redeem.id}`))!
    expect(amt(burned, '2060', 'debit')).toBe(3_000)

    await prisma.order.update({ where: { id: o.id }, data: { status: 'cancelled' } })
    await postOrderRefund(o.id, 'Order cancelled')

    expect((await loyaltyAccountOf(c.id, tenantA))?.pointsBalance).toBe(1_000)
    const back = await prisma.loyaltyTransaction.findMany({ where: { orderId: o.id, type: 'reversal' } })
    expect(back.map((t) => t.pointsDelta)).toEqual([300])
    expect((await prisma.loyaltyTransaction.findUniqueOrThrow({ where: { id: redeem.id } })).reversedAt).not.toBeNull()
    const rev = (await entry(tenantA, `loyalty.redeem.reversal:${redeem.id}`))!
    expect(balanced(rev)).toBe(true)
    expect(amt(rev, '7020', 'debit')).toBe(3_000)
    expect(amt(rev, '2060', 'credit')).toBe(3_000)
    expect(await netCredit(tenantA, '2060', [`loyalty.redeem:${redeem.id}`, `loyalty.redeem.reversal:${redeem.id}`])).toBe(0)
    expect(await netCredit(tenantA, '7020', [`loyalty.redeem:${redeem.id}`, `loyalty.redeem.reversal:${redeem.id}`])).toBe(0)

    await postOrderRefund(o.id, 'Order cancelled')                     // replay
    expect((await loyaltyAccountOf(c.id, tenantA))?.pointsBalance).toBe(1_000)
    expect(await prisma.loyaltyTransaction.count({ where: { orderId: o.id, type: 'reversal' } })).toBe(1)
  })

  it('the cancel path (cancelOrder — what the auto-cancel worker and staff use) restores them', async () => {
    const c = await mkCustomer('autocancel')
    await creditPoints({ customerId: c.id, tenantId: tenantA, points: 500, description: 'Birthday bonus' })
    const o = await mkOrder(conceptA, c.id, 20_000, 'received')
    await redeemOn(c.id, o.id, 200)
    await cancelOrder(o.id, { reason: 'Kitchen out of bread', actor: null })
    const acct = await waitFor(() => loyaltyAccountOf(c.id, tenantA), (a) => a?.pointsBalance === 500)
    expect(acct?.pointsBalance).toBe(500)
  })

  it('a full refund gives the spent points back too', async () => {
    const c = await mkCustomer('refund-redeemer')
    await creditPoints({ customerId: c.id, tenantId: tenantA, points: 800, description: 'Birthday bonus' })
    const o = await mkOrder(conceptA, c.id, 30_000, 'received')
    const redeem = await redeemOn(c.id, o.id, 400)
    await prisma.order.update({ where: { id: o.id }, data: { status: 'refunded' } })
    await postOrderRefund(o.id, 'Order refunded')
    expect((await loyaltyAccountOf(c.id, tenantA))?.pointsBalance).toBe(800)
    expect(await entry(tenantA, `loyalty.redeem.reversal:${redeem.id}`)).not.toBeNull()
  })
})

// ─── ONL-04 ───────────────────────────────────────────────────────────────────

describe('points stay inside the company that issued them', () => {
  it('points earned at A cannot be spent at B, and B never books a redemption of them', async () => {
    const c = await mkCustomer('sana')
    const oA = await mkOrder(conceptA, c.id, 341_200)
    await awardOrderPoints(oA.id)
    expect((await loyaltyAccountOf(c.id, tenantA))?.pointsBalance).toBe(3_412)

    // Quoting at B sees B's balance (none).
    await expect(quoteRedemption({ customerId: c.id, requestedPoints: 2_000, tenantId: tenantB, capCents: 1_000_000 }))
      .rejects.toMatchObject({ code: 'LOYALTY_BELOW_MINIMUM' })
    // Even a forged quote cannot take A's points for a B order.
    const oB = await mkOrder(conceptB, c.id, 100_000, 'received')
    expect(await claimRedemption({ customerId: c.id, orderId: oB.id, quote: { points: 2_000, discountCents: 20_000, pointValueCents: 10 } })).toBe(false)
    expect((await loyaltyAccountOf(c.id, tenantA))?.pointsBalance).toBe(3_412)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: oB.id } })).discountCents).toBe(0)
    expect(await prisma.journalEntry.count({ where: { tenantId: tenantB, reference: { startsWith: 'loyalty.' }, description: { contains: c.id.slice(-8).toUpperCase() } } })).toBe(0)
  })

  it('earning at B opens B\'s own account; redeem and expiry book in the account\'s company', async () => {
    const c = await mkCustomer('two-companies')
    await awardOrderPoints((await mkOrder(conceptA, c.id, 50_000)).id)
    await awardOrderPoints((await mkOrder(conceptB, c.id, 80_000)).id)
    const accounts = await loyaltyAccountsOf(c.id)
    expect(accounts.map((a) => [a.tenantId, a.pointsBalance]).sort()).toEqual([[tenantA, 500], [tenantB, 800]].sort())

    // Redeem at B: B's balance, B's books.
    const oB = await mkOrder(conceptB, c.id, 50_000, 'received')
    const q = await quoteRedemption({ customerId: c.id, requestedPoints: 600, tenantId: tenantB, capCents: 50_000 })
    expect(q.points).toBe(600)
    expect(await claimRedemption({ customerId: c.id, orderId: oB.id, quote: q })).toBe(true)
    expect((await loyaltyAccountOf(c.id, tenantB))?.pointsBalance).toBe(200)
    expect((await loyaltyAccountOf(c.id, tenantA))?.pointsBalance).toBe(500)
    const redeem = await prisma.loyaltyTransaction.findFirstOrThrow({ where: { orderId: oB.id, type: 'redeem' } })
    expect(await entry(tenantB, `loyalty.redeem:${redeem.id}`)).not.toBeNull()
    expect(await entry(tenantA, `loyalty.redeem:${redeem.id}`)).toBeNull()

    // Expiry of B's points books in B even though the customer's latest order is at A.
    await mkOrder(conceptA, c.id, 1_000, 'completed', new Date(Date.now() + 60_000))
    const bAcct = (await loyaltyAccountOf(c.id, tenantB))!
    const exp = await prisma.loyaltyTransaction.create({ data: { loyaltyAccountId: bAcct.id, type: 'expire', pointsDelta: -200, description: '200 pts expired' } })
    await postLoyaltyExpire(exp.id)
    expect(await entry(tenantB, `loyalty.expire:${exp.id}`)).not.toBeNull()
    expect(await entry(tenantA, `loyalty.expire:${exp.id}`)).toBeNull()
  })

  it('staff see only their company\'s account; the customer sees each company\'s balance', async () => {
    const c = await mkCustomer('crm-view')
    await awardOrderPoints((await mkOrder(conceptA, c.id, 30_000)).id)
    await awardOrderPoints((await mkOrder(conceptB, c.id, 70_000)).id)

    const a = await asStaff('mgrA', `/crm/customers/${c.id}/context`)
    expect(a.statusCode).toBe(200)
    expect(a.json().loyaltyAccount).toMatchObject({ tenantId: tenantA, pointsBalance: 300 })
    expect(a.json().loyaltyAccounts.map((x: { tenantId: string }) => x.tenantId)).toEqual([tenantA])
    const b = await asStaff('mgrB', `/crm/customers/${c.id}/context`)
    expect(b.json().loyaltyAccount).toMatchObject({ tenantId: tenantB, pointsBalance: 700 })
    expect(b.json().loyaltyAccounts.map((x: { tenantId: string }) => x.tenantId)).toEqual([tenantB])
    const detailB = await asStaff('mgrB', `/crm/customers/${c.id}`)
    expect(detailB.json().loyaltyAccount).toMatchObject({ tenantId: tenantB, pointsBalance: 700 })

    const atB = await asCustomer(c.id, `/loyalty/account?conceptSlug=${slugB}`)
    expect(atB.statusCode).toBe(200)
    expect(atB.json()).toMatchObject({ tenantId: tenantB, pointsBalance: 700, pointsValueCents: 7_000 })
    expect(atB.json().companies).toHaveLength(2)
    const status = await asCustomer(c.id, `/loyalty/status?conceptSlug=${slugA}`)
    expect(status.json().pointsBalance).toBe(300)
  })

  it('the review bonus lands in the reviewed order\'s company and books its liability', async () => {
    const c = await mkCustomer('reviewer')
    await awardOrderPoints((await mkOrder(conceptA, c.id, 20_000)).id)       // an account at A already
    const oB = await mkOrder(conceptB, c.id, 40_000)
    const r = await asCustomer(c.id, '/reviews', { orderId: oB.id, rating: 5 })
    expect(r.statusCode).toBe(201)
    expect(r.json().bonusPointsAwarded).toBe(50)
    expect((await loyaltyAccountOf(c.id, tenantB))?.pointsBalance).toBe(50)
    expect((await loyaltyAccountOf(c.id, tenantA))?.pointsBalance).toBe(200)
    const bonus = await prisma.loyaltyTransaction.findFirstOrThrow({ where: { orderId: oB.id, type: 'earn' } })
    const je = await waitFor(() => entry(tenantB, `loyalty.earn:${bonus.id}`), (x) => x !== null)
    expect(amt(je!, '2060', 'credit')).toBe(500)
  })
})
