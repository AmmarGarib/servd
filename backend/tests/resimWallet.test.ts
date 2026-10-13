// Re-sim wave (2026-10-11) — the customer wallet is per company, and every
// move of it reaches the right company's books.
//
//   ONL-R2-01  a top-up credits the ACTIVE company's wallet and posts there in
//              the same transaction (goodwill: Dr 6060 / Cr 2050; paid: Dr the
//              tender's account / Cr 2050). Only the wallet of the ORDER's
//              company can pay an order; its spend is Dr 2050 in that company;
//              a cancel / refund restores to that company's wallet. 2050 never
//              goes to a debit balance in either company.
//   ONL-R2-06  a bill a gift card covers in full leaves no PKR 0 pending row,
//              and /pos/cod-due never lists a PKR 0 entry.
//
// Two companies throughout: A and B, one brand each, a customer of both.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError, errorResponse } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { storefrontRoutes } from '../src/modules/storefront/routes.js'
import { walletRoutes } from '../src/modules/wallet/routes.js'
import { crmRoutes } from '../src/modules/crm/routes.js'
import { posRoutes } from '../src/modules/pos/routes.js'
import { postOrderCompletion, postOrderRefund } from '../src/modules/accounting/orderPosting.js'
import { restoreOrderWallet, spendWalletOnOrder, topUpWallet } from '../src/modules/wallet/service.js'
import { postRefundOrFlag } from '../src/modules/orders/service.js'

const RUN = Math.random().toString(36).slice(2, 8)

let app: FastifyInstance
let tenantA: string, tenantB: string
let conceptA: string, conceptB: string
let slugA: string, slugB: string
let clubA: string, clubB: string
let shared: string           // a customer of both companies
const staff: Record<string, string> = {}

async function mkStaff(key: string, tenantId: string) {
  const u = await prisma.user.create({
    data: { name: key, email: `${key}.${RUN}@resimwallet.test`, password: await bcrypt.hash('x-Password-1', 4), role: 'admin', isActive: true, accountStatus: 'active', tenantId },
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } })
  staff[key] = (issueStaffSession(u) as { accessToken: string }).accessToken
}
const asStaff = (who: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as never, headers: { authorization: `Bearer ${staff[who]}` } })
const customerToken = (id: string) => jwt.sign({ sub: id, type: 'customer' }, process.env['JWT_SECRET'] as string, { expiresIn: '2h' })
const asCustomer = (id: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, payload: payload as never, headers: { authorization: `Bearer ${customerToken(id)}` } })

let seq = 0
async function mkCustomer(orderAt: string[] = []) {
  seq += 1
  const c = await prisma.customer.create({
    data: {
      name: `Wallet ${seq}`, email: `rw-${RUN}-${seq}@example.com`,
      phone: `+92311${RUN.replace(/\D/g, '').padEnd(3, '7').slice(0, 3)}${String(seq).padStart(4, '0')}`,
      phoneVerifiedAt: new Date(),
    },
  })
  // A completed order at each brand makes them that company's customer (the
  // top-up route credits only a customer of the active company).
  for (const conceptId of orderAt) {
    await prisma.order.create({
      data: {
        conceptId, customerId: c.id, source: 'servd', status: 'completed', totalCents: 1_000, completedAt: new Date(),
        items: { create: [{ name: 'Water', quantity: 1, unitPriceCents: 1_000 }] },
      },
    })
  }
  return c.id
}

const basket = (menuItemId: string, quantity = 1) => [{ menuItemId, quantity, modifiers: [] }]
const walletAt = async (tenantId: string, customerId: string) =>
  (await prisma.customerWallet.findUnique({ where: { tenantId_customerId: { tenantId, customerId } } }))?.balanceCents ?? 0

/** Net CREDIT balance of an account code in one company's books (all entries). */
async function netCredit(tenantId: string, code: string): Promise<number> {
  const lines = await prisma.journalLine.findMany({
    where: { account: { tenantId, code }, journalEntry: { tenantId } },
    select: { type: true, amountCents: true },
  })
  return lines.reduce((t, l) => t + (l.type === 'credit' ? l.amountCents : -l.amountCents), 0)
}
async function entryLines(tenantId: string, reference: string) {
  const je = await prisma.journalEntry.findFirst({
    where: { tenantId, reference },
    include: { lines: { include: { account: { select: { code: true, tenantId: true } } } } },
  })
  return je
}

async function complete(orderId: string) {
  await prisma.order.update({ where: { id: orderId }, data: { status: 'completed', completedAt: new Date() } })
  return postOrderCompletion(orderId)
}

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'Wallet A', slug: `rw-a-${RUN}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'Wallet B', slug: `rw-b-${RUN}` } })).id
  await ensureChartOfAccounts(tenantA)
  await ensureChartOfAccounts(tenantB)
  slugA = `rw-a-${RUN}`; slugB = `rw-b-${RUN}`
  const mkConcept = async (tenantId: string, slug: string) => (await prisma.concept.create({
    data: { name: slug, slug, type: 'restaurant', tenantId, taxRate: 17, taxRateCash: 15, taxRateCard: 8, isActive: true },
  })).id
  conceptA = await mkConcept(tenantA, slugA)
  conceptB = await mkConcept(tenantB, slugB)
  const mkItem = async (conceptId: string) => {
    const categoryId = (await prisma.category.create({ data: { conceptId, name: 'Sandwiches' } })).id
    return (await prisma.menuItem.create({ data: { conceptId, categoryId, name: 'Club sandwich', priceCents: 100_000, isAvailable: true } })).id
  }
  clubA = await mkItem(conceptA)
  clubB = await mkItem(conceptB)
  await mkStaff('mgrA', tenantA)
  await mkStaff('mgrB', tenantB)
  shared = await mkCustomer([conceptA, conceptB])

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode ?? 500
    return reply.status(status).send({ error: { code: 'ERROR', message: (err as Error).message } })
  })
  await app.register(storefrontRoutes, { prefix: '/storefront' })
  await app.register(walletRoutes, { prefix: '/wallet' })
  await app.register(crmRoutes, { prefix: '/crm' })
  await app.register(posRoutes, { prefix: '/pos' })
  await app.ready()
}, 60_000)

afterAll(async () => {
  await app?.close()
})

// ─── Top-ups ─────────────────────────────────────────────────────────────────

describe('ONL-R2-01: a top-up is booked in the top-up company', () => {
  it('a goodwill top-up credits A only and posts Dr 6060 / Cr 2050 in A, balanced', async () => {
    const r = await asStaff('mgrA', 'POST', '/wallet/topup', { customerId: shared, amountCents: 50_000, description: 'Goodwill — late delivery' })
    expect(r.statusCode).toBe(201)
    expect(r.json()).toMatchObject({ newBalance: 50_000, tenantId: tenantA })
    expect(await walletAt(tenantA, shared)).toBe(50_000)
    expect(await walletAt(tenantB, shared)).toBe(0)

    const je = await entryLines(tenantA, `wallet.topup:${r.json().transactionId}`)
    expect(je).not.toBeNull()
    expect(je!.id).toBe(r.json().entryId)
    const dr = je!.lines.filter((l) => l.type === 'debit')
    const cr = je!.lines.filter((l) => l.type === 'credit')
    expect(dr.map((l) => [l.account.code, l.amountCents])).toEqual([['6060', 50_000]])
    expect(cr.map((l) => [l.account.code, l.amountCents])).toEqual([['2050', 50_000]])
    expect(je!.lines.every((l) => l.account.tenantId === tenantA)).toBe(true)
    // Nothing in B's books.
    expect(await prisma.journalEntry.count({ where: { tenantId: tenantB, reference: { startsWith: 'wallet.topup:' } } })).toBe(0)
    // The wallet's history carries its company.
    const wt = await prisma.walletTransaction.findUniqueOrThrow({ where: { id: r.json().transactionId } })
    expect(wt).toMatchObject({ tenantId: tenantA, type: 'topup', amountCents: 50_000, balanceAfter: 50_000 })
  })

  it('a paid top-up debits the tender account (cash → 1010) in its company', async () => {
    const c = await mkCustomer([conceptB])
    const r = await asStaff('mgrB', 'POST', '/wallet/topup', { customerId: c, amountCents: 20_000, kind: 'paid', tender: 'cash' })
    expect(r.statusCode).toBe(201)
    const je = await entryLines(tenantB, `wallet.topup:${r.json().transactionId}`)
    expect(je!.lines.map((l) => [l.type, l.account.code, l.amountCents]).sort()).toEqual([
      ['credit', '2050', 20_000], ['debit', '1010', 20_000],
    ])
    expect(await walletAt(tenantB, c)).toBe(20_000)
    expect(await walletAt(tenantA, c)).toBe(0)
  })

  it('a paid top-up without its tender is refused, nothing moved', async () => {
    const before = await walletAt(tenantA, shared)
    const r = await asStaff('mgrA', 'POST', '/wallet/topup', { customerId: shared, amountCents: 1_000, kind: 'paid' })
    expect(r.statusCode).toBe(400)
    expect(await walletAt(tenantA, shared)).toBe(before)
  })

  it("B cannot credit A's customer (404) and bulk top-up skips them", async () => {
    const onlyA = await mkCustomer([conceptA])
    expect((await asStaff('mgrB', 'POST', '/wallet/topup', { customerId: onlyA, amountCents: 500 })).statusCode).toBe(404)
    const bulk = await asStaff('mgrB', 'POST', '/wallet/bulk-topup', { customerIds: [onlyA, shared], amountCents: 700 })
    expect(bulk.json()).toMatchObject({ success: 1, failed: [] })
    expect(await walletAt(tenantB, onlyA)).toBe(0)
    expect(await walletAt(tenantA, onlyA)).toBe(0)
    expect(await walletAt(tenantB, shared)).toBe(700)
  })

  it('a posting that cannot be made rolls the credit back (no wallet value without its entry)', async () => {
    const c = await mkCustomer([conceptA])
    const acct = await prisma.account.findFirstOrThrow({ where: { tenantId: tenantA, code: '6060' } })
    await prisma.account.update({ where: { id: acct.id }, data: { code: '6060-x' } })
    try {
      await expect(topUpWallet({ tenantId: tenantA, customerId: c, amountCents: 5_000, kind: 'goodwill', description: 't', postedBy: 'test' })).rejects.toThrow()
    } finally {
      await prisma.account.update({ where: { id: acct.id }, data: { code: '6060' } })
    }
    expect(await walletAt(tenantA, c)).toBe(0)
    expect(await prisma.walletTransaction.count({ where: { customerId: c } })).toBe(0)
  })
})

// ─── Spending stays in the issuing company ──────────────────────────────────

describe("ONL-R2-01: A's wallet cannot pay B's order", () => {
  it("quote at B's brand applies none of A's balance; A's brand applies it", async () => {
    const c = await mkCustomer([conceptA, conceptB])
    await topUpWallet({ tenantId: tenantA, customerId: c, amountCents: 30_000, kind: 'goodwill', description: 't', postedBy: 'test' })
    const items = JSON.stringify(basket(clubB))
    const qB = await asCustomer(c, 'GET', `/storefront/quote?${new URLSearchParams({ conceptSlug: slugB, type: 'pickup', useWallet: 'true', items })}`)
    expect(qB.statusCode).toBe(200)
    expect(qB.json().walletCents).toBe(0)
    const qA = await asCustomer(c, 'GET', `/storefront/quote?${new URLSearchParams({ conceptSlug: slugA, type: 'pickup', useWallet: 'true', items: JSON.stringify(basket(clubA)) })}`)
    expect(qA.json().walletCents).toBe(30_000)
  })

  it("the wallet as the method at B's brand is refused (422) with A's balance untouched", async () => {
    const c = await mkCustomer([conceptA, conceptB])
    await topUpWallet({ tenantId: tenantA, customerId: c, amountCents: 500_000, kind: 'goodwill', description: 't', postedBy: 'test' })
    const r = await asCustomer(c, 'POST', '/storefront/orders', { conceptSlug: slugB, type: 'pickup', paymentGateway: 'wallet', items: basket(clubB) })
    expect(r.statusCode).toBe(422)
    expect(await prisma.order.count({ where: { customerId: c, conceptId: conceptB, source: 'servd', totalCents: { gt: 1_000 } } })).toBe(0)
    expect(await walletAt(tenantA, c)).toBe(500_000)
  })

  it("the 'use my wallet' toggle at B's brand takes nothing from A's wallet", async () => {
    const c = await mkCustomer([conceptA, conceptB])
    await topUpWallet({ tenantId: tenantA, customerId: c, amountCents: 40_000, kind: 'goodwill', description: 't', postedBy: 'test' })
    const r = await asCustomer(c, 'POST', '/storefront/orders', { conceptSlug: slugB, type: 'pickup', paymentGateway: 'cash', useWallet: true, items: basket(clubB) })
    expect(r.statusCode).toBe(201)
    expect(r.json().walletAmountCents).toBe(0)
    expect(r.json().totalCents).toBe(115_000)   // cash rate 15%, nothing off
    expect(await walletAt(tenantA, c)).toBe(40_000)
    expect(await prisma.walletTransaction.count({ where: { orderId: r.json().id } })).toBe(0)
  })

  it('at its own brand the wallet pays, and the spend row carries the company', async () => {
    const c = await mkCustomer([conceptA])
    await topUpWallet({ tenantId: tenantA, customerId: c, amountCents: 40_000, kind: 'goodwill', description: 't', postedBy: 'test' })
    const r = await asCustomer(c, 'POST', '/storefront/orders', { conceptSlug: slugA, type: 'pickup', paymentGateway: 'cash', useWallet: true, items: basket(clubA) })
    expect(r.statusCode).toBe(201)
    expect(r.json()).toMatchObject({ walletAmountCents: 40_000, totalCents: 75_000 })
    expect(await walletAt(tenantA, c)).toBe(0)
    const spend = await prisma.walletTransaction.findFirstOrThrow({ where: { orderId: r.json().id, type: 'spend' } })
    expect(spend).toMatchObject({ tenantId: tenantA, amountCents: -40_000, balanceAfter: 0 })
  })

  it('spendWalletOnOrder reads the ORDER company, never another', async () => {
    const c = await mkCustomer([conceptA, conceptB])
    await topUpWallet({ tenantId: tenantA, customerId: c, amountCents: 10_000, kind: 'goodwill', description: 't', postedBy: 'test' })
    const orderB = await prisma.order.create({
      data: { conceptId: conceptB, customerId: c, source: 'servd', status: 'received', totalCents: 10_000, items: { create: [{ name: 'x', quantity: 1, unitPriceCents: 10_000 }] } },
    })
    expect(await spendWalletOnOrder({ customerId: c, orderId: orderB.id, amountCents: 5_000 })).toBe(false)
    expect(await walletAt(tenantA, c)).toBe(10_000)
  })

  it('two concurrent wallet-paid checkouts against one balance: one wins, the wallet never goes negative', async () => {
    const c = await mkCustomer([conceptA])
    await topUpWallet({ tenantId: tenantA, customerId: c, amountCents: 150_000, kind: 'goodwill', description: 't', postedBy: 'test' })
    const place = () => asCustomer(c, 'POST', '/storefront/orders', { conceptSlug: slugA, type: 'pickup', paymentGateway: 'wallet', items: basket(clubA) })
    const [r1, r2] = await Promise.all([place(), place()])
    const codes = [r1.statusCode, r2.statusCode].sort()
    expect(codes[0]).toBe(201)
    expect(codes[1]).toBeGreaterThanOrEqual(409)
    expect(await walletAt(tenantA, c)).toBe(150_000 - 108_000)
    const spends = await prisma.walletTransaction.findMany({ where: { customerId: c, type: 'spend' } })
    expect(spends.reduce((t, s) => t + s.amountCents, 0)).toBe(-108_000)
    expect(spends.every((s) => s.orderId)).toBe(true)
  })
})

// ─── The books: top-up → spend → refund in both companies ───────────────────

describe('ONL-R2-01: 2050 never goes to a debit balance', () => {
  it('a run of top-ups, wallet spends, a cancel and a refund keeps 2050 ≥ 0 in both companies and equal to the wallets', async () => {
    const c = await mkCustomer([conceptA, conceptB])
    const startA = await netCredit(tenantA, '2050')
    const startB = await netCredit(tenantB, '2050')
    const walletsA0 = await walletAt(tenantA, c)
    const walletsB0 = await walletAt(tenantB, c)

    // A grants 200k goodwill, B takes 120k cash for a paid top-up.
    expect((await asStaff('mgrA', 'POST', '/wallet/topup', { customerId: c, amountCents: 200_000 })).statusCode).toBe(201)
    expect((await asStaff('mgrB', 'POST', '/wallet/topup', { customerId: c, amountCents: 120_000, kind: 'paid', tender: 'card' })).statusCode).toBe(201)

    // Spend at A (wallet as method, 108k at the card rate) and complete it.
    const oA = await asCustomer(c, 'POST', '/storefront/orders', { conceptSlug: slugA, type: 'pickup', paymentGateway: 'wallet', items: basket(clubA) })
    expect(oA.statusCode).toBe(201)
    expect(oA.json()).toMatchObject({ walletAmountCents: 108_000, totalCents: 0 })
    expect((await complete(oA.json().id)).posted).toBe(true)
    const saleA = await entryLines(tenantA, `order.complete:${oA.json().id}`)
    expect(saleA!.lines.find((l) => l.account.code === '2050')).toMatchObject({ type: 'debit', amountCents: 108_000 })
    expect(saleA!.lines.every((l) => l.account.tenantId === tenantA)).toBe(true)

    // Spend at B (wallet as method) and complete it — B's 2050 only.
    const oB = await asCustomer(c, 'POST', '/storefront/orders', { conceptSlug: slugB, type: 'pickup', paymentGateway: 'wallet', items: basket(clubB) })
    expect(oB.statusCode).toBe(201)
    expect(await walletAt(tenantA, c)).toBe(walletsA0 + 200_000 - 108_000)
    expect(await walletAt(tenantB, c)).toBe(walletsB0 + 120_000 - 108_000)
    expect((await complete(oB.json().id)).posted).toBe(true)

    // A third order at A with the toggle, cancelled before completion: the
    // wallet share goes back to A's wallet and no entry is needed.
    const oC = await asCustomer(c, 'POST', '/storefront/orders', { conceptSlug: slugA, type: 'pickup', paymentGateway: 'cash', useWallet: true, items: basket(clubA) })
    expect(oC.statusCode).toBe(201)
    expect(oC.json().walletAmountCents).toBe(92_000)
    expect(await walletAt(tenantA, c)).toBe(walletsA0)
    await prisma.order.update({ where: { id: oC.json().id }, data: { status: 'cancelled' } })
    await postOrderRefund(oC.json().id, 'Order cancelled', { bookWalletRestore: false })
    expect(await walletAt(tenantA, c)).toBe(walletsA0 + 92_000)
    expect(await walletAt(tenantB, c)).toBe(walletsB0 + 12_000)

    // B's completed order refunded in full: the wallet share goes back to B's
    // wallet (never A's) and B's 2050 is credited back.
    await prisma.order.update({ where: { id: oB.json().id }, data: { status: 'refunded' } })
    await postOrderRefund(oB.json().id, 'Order refunded', { bookWalletRestore: true })
    await postOrderRefund(oB.json().id, 'Order refunded', { bookWalletRestore: true })   // replay: no double credit
    expect(await walletAt(tenantB, c)).toBe(walletsB0 + 120_000)
    expect(await walletAt(tenantA, c)).toBe(walletsA0 + 92_000)
    const restore = await prisma.walletTransaction.findMany({ where: { orderId: oB.json().id, type: 'refund' } })
    expect(restore).toHaveLength(1)
    expect(restore[0]!.tenantId).toBe(tenantB)

    // The books: each company's 2050 moved by exactly its own wallets' change
    // and is never a debit balance.
    const endA = await netCredit(tenantA, '2050')
    const endB = await netCredit(tenantB, '2050')
    expect(endA - startA).toBe(200_000 - 108_000)
    expect(endB - startB).toBe(120_000)
    expect(endA).toBeGreaterThanOrEqual(0)
    expect(endB).toBeGreaterThanOrEqual(0)
    // Ledger 2050 = the company's wallets + the wallet shares sitting on its
    // still-open orders (taken from the wallet, booked Dr 2050 at completion).
    // This file's companies only ever got wallet value through the service.
    for (const [t, end] of [[tenantA, endA], [tenantB, endB]] as const) {
      const wallets = await prisma.customerWallet.aggregate({ where: { tenantId: t }, _sum: { balanceCents: true } })
      const open = await prisma.order.aggregate({
        where: { concept: { tenantId: t }, walletAmountCents: { gt: 0 }, status: { notIn: ['completed', 'refunded', 'cancelled', 'rejected'] } },
        _sum: { walletAmountCents: true },
      })
      expect(end).toBe((wallets._sum.balanceCents ?? 0) + (open._sum.walletAmountCents ?? 0))
    }
    // Every entry in both companies balances.
    for (const t of [tenantA, tenantB]) {
      const entries = await prisma.journalEntry.findMany({ where: { tenantId: t }, include: { lines: true } })
      for (const e of entries) {
        const d = e.lines.filter((l) => l.type === 'debit').reduce((s, l) => s + l.amountCents, 0)
        const cr = e.lines.filter((l) => l.type === 'credit').reduce((s, l) => s + l.amountCents, 0)
        expect(d, e.reference ?? e.id).toBe(cr)
      }
    }
  })

  it('restoreOrderWallet is once per order even when raced', async () => {
    const c = await mkCustomer([conceptA])
    await topUpWallet({ tenantId: tenantA, customerId: c, amountCents: 20_000, kind: 'goodwill', description: 't', postedBy: 'test' })
    const o = await asCustomer(c, 'POST', '/storefront/orders', { conceptSlug: slugA, type: 'pickup', paymentGateway: 'cash', useWallet: true, items: basket(clubA) })
    expect(o.json().walletAmountCents).toBe(20_000)
    await prisma.order.update({ where: { id: o.json().id }, data: { status: 'cancelled' } })
    await Promise.all([restoreOrderWallet(o.json().id, 'x'), restoreOrderWallet(o.json().id, 'y'), restoreOrderWallet(o.json().id, 'z')])
    expect(await walletAt(tenantA, c)).toBe(20_000)
  })

  // W-RV-02: the restore and its Cr 2050 entry are one transaction. A refused
  // entry leaves the wallet untouched, is FLAGGED (not just logged), and a
  // re-run restores and books together, once.
  it('a refund whose wallet entry is refused moves nothing, is flagged, and a re-run restores and books together', async () => {
    const c = await mkCustomer([conceptA])
    await topUpWallet({ tenantId: tenantA, customerId: c, amountCents: 200_000, kind: 'goodwill', description: 't', postedBy: 'test' })
    const o = await asCustomer(c, 'POST', '/storefront/orders', { conceptSlug: slugA, type: 'pickup', paymentGateway: 'wallet', items: basket(clubA) })
    expect(o.statusCode).toBe(201)
    const orderId = o.json().id as string
    const share = o.json().walletAmountCents as number
    expect(share).toBeGreaterThan(0)
    expect((await complete(orderId)).posted).toBe(true)
    const before = await walletAt(tenantA, c)
    const ledgerBefore = await netCredit(tenantA, '2050')

    await prisma.order.update({ where: { id: orderId }, data: { status: 'refunded' } })
    const lock = await prisma.periodLock.create({
      data: { tenantId: tenantA, lockedThrough: new Date(Date.now() + 2 * 86_400_000), lockedBy: 'test', note: 'W-RV-02' },
    })
    try {
      const results = await postOrderRefund(orderId, 'Order refunded', { bookWalletRestore: true })
      expect(results.some((r) => !r.posted && /PERIOD_LOCKED|closed through/i.test(r.reason ?? ''))).toBe(true)
      // Nothing moved: no credit, no claim, no entry — 2050 still equals the wallets.
      expect(await walletAt(tenantA, c)).toBe(before)
      expect(await prisma.walletTransaction.count({ where: { orderId, type: 'refund' } })).toBe(0)
      expect(await prisma.journalEntry.count({ where: { tenantId: tenantA, reference: `order.refund_wallet:${orderId}` } })).toBe(0)
      expect(await netCredit(tenantA, '2050')).toBe(ledgerBefore)

      // The refund path flags it for Reconciliation.
      const { failed } = await postRefundOrFlag(orderId, 'Order refunded', true)
      expect(failed.length).toBeGreaterThan(0)
      const flag = await prisma.exceptionFlag.findFirst({ where: { kind: 'posting_failed', entityType: 'Order', entityId: orderId } })
      expect(flag?.tenantId).toBe(tenantA)
    } finally {
      await prisma.periodLock.delete({ where: { id: lock.id } })
    }

    // Re-run after the cause is fixed: restored and booked together, once.
    await postOrderRefund(orderId, 'Order refunded', { bookWalletRestore: true })
    await postOrderRefund(orderId, 'Order refunded', { bookWalletRestore: true })
    expect(await walletAt(tenantA, c)).toBe(before + share)
    expect(await prisma.walletTransaction.count({ where: { orderId, type: 'refund' } })).toBe(1)
    const je = await entryLines(tenantA, `order.refund_wallet:${orderId}`)
    expect(je!.lines.find((l) => l.account.code === '2050')).toMatchObject({ type: 'credit', amountCents: share })
    expect(je!.lines.every((l) => l.account.tenantId === tenantA)).toBe(true)
    expect(await netCredit(tenantA, '2050') - ledgerBefore).toBe(share)
  })

  it('a restore made earlier without its entry gets the entry on the next run, without a second credit', async () => {
    const c = await mkCustomer([conceptA])
    await topUpWallet({ tenantId: tenantA, customerId: c, amountCents: 200_000, kind: 'goodwill', description: 't', postedBy: 'test' })
    const o = await asCustomer(c, 'POST', '/storefront/orders', { conceptSlug: slugA, type: 'pickup', paymentGateway: 'wallet', items: basket(clubA) })
    const orderId = o.json().id as string
    const share = o.json().walletAmountCents as number
    expect((await complete(orderId)).posted).toBe(true)
    await prisma.order.update({ where: { id: orderId }, data: { status: 'refunded' } })
    const ledgerBefore = await netCredit(tenantA, '2050')
    // The old code path: the wallet was credited, its entry never posted.
    await restoreOrderWallet(orderId, 'legacy')
    const afterRestore = await walletAt(tenantA, c)
    const results = await postOrderRefund(orderId, 'Order refunded', { bookWalletRestore: true })
    expect(results.find((r) => r.posted && r.entryId)).toBeTruthy()
    expect(await walletAt(tenantA, c)).toBe(afterRestore)
    expect(await prisma.walletTransaction.count({ where: { orderId, type: 'refund' } })).toBe(1)
    expect(await netCredit(tenantA, '2050') - ledgerBefore).toBe(share)
  })
})

// ─── Reads show the company's wallet ─────────────────────────────────────────

describe("ONL-R2-01: reads show the brand's / the company's wallet", () => {
  it('storefront /account and /wallet/me show the wallet of the brand passed', async () => {
    const c = await mkCustomer([conceptA, conceptB])
    await topUpWallet({ tenantId: tenantA, customerId: c, amountCents: 11_000, kind: 'goodwill', description: 'a', postedBy: 'test' })
    await topUpWallet({ tenantId: tenantB, customerId: c, amountCents: 2_200, kind: 'goodwill', description: 'b', postedBy: 'test' })
    const accA = (await asCustomer(c, 'GET', `/storefront/account?conceptSlug=${slugA}`)).json()
    const accB = (await asCustomer(c, 'GET', `/storefront/account?conceptSlug=${slugB}`)).json()
    expect(accA.walletBalance).toBe(11_000)
    expect(accB.walletBalance).toBe(2_200)
    expect(accA.walletTransactions.map((t: { amountCents: number }) => t.amountCents)).toEqual([11_000])
    expect(accB.walletTransactions.map((t: { amountCents: number }) => t.amountCents)).toEqual([2_200])
    expect(accA.wallets).toHaveLength(2)
    const meB = (await asCustomer(c, 'GET', `/wallet/me?conceptSlug=${slugB}`)).json()
    expect(meB).toMatchObject({ tenantId: tenantB, balance: 2_200 })
    expect(meB.history.every((h: { tenantId: string }) => h.tenantId === tenantB)).toBe(true)
  })

  it("staff see only their company's wallet (CRM and /wallet/customers)", async () => {
    const c = await mkCustomer([conceptA, conceptB])
    await topUpWallet({ tenantId: tenantA, customerId: c, amountCents: 33_000, kind: 'goodwill', description: 'a', postedBy: 'test' })
    await topUpWallet({ tenantId: tenantB, customerId: c, amountCents: 4_400, kind: 'goodwill', description: 'b', postedBy: 'test' })
    expect((await asStaff('mgrA', 'GET', `/wallet/customers/${c}`)).json().walletBalance).toBe(33_000)
    const wB = (await asStaff('mgrB', 'GET', `/wallet/customers/${c}`)).json()
    expect(wB.walletBalance).toBe(4_400)
    expect(wB.history.every((h: { tenantId: string }) => h.tenantId === tenantB)).toBe(true)
    expect((await asStaff('mgrA', 'GET', `/crm/customers/${c}`)).json().walletBalance).toBe(33_000)
    expect((await asStaff('mgrB', 'GET', `/crm/customers/${c}`)).json().walletBalance).toBe(4_400)
    expect((await asStaff('mgrB', 'GET', `/crm/customers/${c}/context`)).json().walletBalance).toBe(4_400)
  })
})

// ─── ONL-R2-06 ───────────────────────────────────────────────────────────────

describe('ONL-R2-06: nothing due leaves no PKR 0 cash row', () => {
  it('a bill a gift card covers in full has no pending payment, and cod-due lists only money owed', async () => {
    const card = await prisma.giftCard.create({ data: { code: `RW-GC-${RUN}`.toUpperCase(), tenantId: tenantA, issuedAmountCents: 500_000, balanceCents: 500_000 } })
    const c = await mkCustomer([conceptA])
    const r = await asCustomer(c, 'POST', '/storefront/orders', {
      conceptSlug: slugA, type: 'pickup', paymentGateway: 'cash', tipCents: 2_000, giftCardCode: card.code, items: basket(clubA),
    })
    expect(r.statusCode).toBe(201)
    expect(r.json()).toMatchObject({ totalCents: 0, giftCardAppliedCents: 117_000 })
    expect(await prisma.payment.count({ where: { orderId: r.json().id } })).toBe(0)
    await complete(r.json().id)

    // A legacy PKR 0 pending row (written before this fix) and a real one.
    const legacy = await prisma.order.create({
      data: { conceptId: conceptA, customerId: c, source: 'servd', status: 'completed', completedAt: new Date(), totalCents: 0,
        items: { create: [{ name: 'x', quantity: 1, unitPriceCents: 0 }] },
        payments: { create: { method: 'cash', amountCents: 0, status: 'pending' } } },
    })
    const owed = await prisma.order.create({
      data: { conceptId: conceptA, customerId: c, source: 'servd', status: 'completed', completedAt: new Date(), totalCents: 5_000,
        items: { create: [{ name: 'x', quantity: 1, unitPriceCents: 5_000 }] },
        payments: { create: { method: 'cash', amountCents: 5_000, status: 'pending' } } },
    })
    const due = await asStaff('mgrA', 'GET', '/pos/cod-due')
    expect(due.statusCode).toBe(200)
    const orderIds = due.json().payments.map((p: { order: { id: string } }) => p.order.id)
    expect(orderIds).toContain(owed.id)
    expect(orderIds).not.toContain(legacy.id)
    expect(orderIds).not.toContain(r.json().id)
    expect(due.json().payments.every((p: { amountCents: number }) => p.amountCents > 0)).toBe(true)
    // B sees none of A's.
    const dueB = await asStaff('mgrB', 'GET', '/pos/cod-due')
    expect(dueB.json().payments.map((p: { order: { id: string } }) => p.order.id)).not.toContain(owed.id)
  })

  it('a bill with money still owed keeps its pending row', async () => {
    const c = await mkCustomer([conceptA])
    const r = await asCustomer(c, 'POST', '/storefront/orders', { conceptSlug: slugA, type: 'pickup', paymentGateway: 'cash', items: basket(clubA) })
    expect(r.statusCode).toBe(201)
    const ps = await prisma.payment.findMany({ where: { orderId: r.json().id } })
    expect(ps.map((p) => [p.method, p.status, p.amountCents])).toEqual([['cash', 'pending', 115_000]])
  })
})

// ─── The migration ───────────────────────────────────────────────────────────

describe('ONL-R2-01: migration 20261011160000 moves each legacy balance to one company', () => {
  it("the home company is the latest completed order's; history follows its order", async () => {
    // Legacy state: a servd-wide balance and untagged history.
    const c = await mkCustomer()
    const older = await prisma.order.create({
      data: { conceptId: conceptA, customerId: c, source: 'servd', status: 'completed', completedAt: new Date(Date.now() - 86_400_000), totalCents: 1,
        items: { create: [{ name: 'x', quantity: 1, unitPriceCents: 1 }] } },
    })
    await prisma.order.create({
      data: { conceptId: conceptB, customerId: c, source: 'servd', status: 'completed', completedAt: new Date(), totalCents: 1,
        items: { create: [{ name: 'x', quantity: 1, unitPriceCents: 1 }] } },
    })
    await prisma.customer.update({ where: { id: c }, data: { walletBalance: 77_000 } })
    await prisma.walletTransaction.create({ data: { customerId: c, type: 'topup', amountCents: 80_000, balanceAfter: 80_000 } })
    await prisma.walletTransaction.create({ data: { customerId: c, type: 'spend', amountCents: -3_000, balanceAfter: 77_000, orderId: older.id } })

    const dir = readdirSync('prisma/migrations').find((d) => d.startsWith('20261011160000'))!
    const run = () => execFileSync('psql', [process.env['DATABASE_URL']!.replace(/\?.*$/, ''), '-v', 'ON_ERROR_STOP=1', '-q', '-f', `prisma/migrations/${dir}/migration.sql`], { stdio: 'pipe' })
    run()
    run()   // re-runnable: nothing doubles

    const wallets = await prisma.customerWallet.findMany({ where: { customerId: c } })
    expect(wallets.map((w) => [w.tenantId, w.balanceCents])).toEqual([[tenantB, 77_000]])
    // The legacy column is left in place, unread.
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: c } })).walletBalance).toBe(77_000)
    const hist = await prisma.walletTransaction.findMany({ where: { customerId: c }, orderBy: { amountCents: 'asc' } })
    expect(hist.map((h) => h.tenantId)).toEqual([tenantA, tenantB])   // the spend → its order's company; the top-up → home
  })

  // W-RV-01: a negative legacy balance does not abort the release. It gets no
  // wallet (a wallet below zero could never be credited again — the CHECK
  // still checks every UPDATE), stays on the legacy column, and the CHECK is
  // in place and validated.
  it('a negative legacy balance does not abort the migration and gets no wallet', async () => {
    const neg = await mkCustomer([conceptA])
    const pos = await mkCustomer([conceptA])
    await prisma.customer.update({ where: { id: neg }, data: { walletBalance: -200 } })
    await prisma.customer.update({ where: { id: pos }, data: { walletBalance: 500 } })
    const dir = readdirSync('prisma/migrations').find((d) => d.startsWith('20261011160000'))!
    const url = process.env['DATABASE_URL']!.replace(/\?.*$/, '')
    const run = () => execFileSync('psql', [url, '-v', 'ON_ERROR_STOP=1', '-q', '-f', `prisma/migrations/${dir}/migration.sql`], { stdio: 'pipe' }).toString()
    // The table and its CHECK already exist here, so the old migration (which
    // moved every non-zero balance in) failed on this customer.
    expect(() => run()).not.toThrow()
    expect(() => run()).not.toThrow()

    expect(await prisma.customerWallet.findMany({ where: { customerId: neg } })).toEqual([])
    expect((await prisma.customerWallet.findMany({ where: { customerId: pos } })).map((w) => [w.tenantId, w.balanceCents])).toEqual([[tenantA, 500]])
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: neg } })).walletBalance).toBe(-200)
    // The backstop is there and validated.
    const con = await prisma.$queryRaw<Array<{ convalidated: boolean }>>`SELECT convalidated FROM pg_constraint WHERE conname = 'customer_wallets_balance_non_negative'`
    expect(con).toEqual([{ convalidated: true }])
    // The customer can be credited normally afterwards.
    await topUpWallet({ tenantId: tenantA, customerId: neg, amountCents: 1_000, kind: 'goodwill', description: 't', postedBy: 'test' })
    expect(await walletAt(tenantA, neg)).toBe(1_000)
  })
})

// ─── Finance gaps #9 (2026-10-13): the bank a paid top-up went into ─────────

describe('finance gaps #9: a paid bank top-up is booked to the bank it was received into', () => {
  it('two banks: no pick is 422 with nothing moved; the picked bank is debited and stored on the wallet row; a foreign bank is 422', async () => {
    const tenantC = (await prisma.tenant.create({ data: { name: 'Wallet C', slug: `rw-c-${RUN}` } })).id
    await ensureChartOfAccounts(tenantC)
    const slugC = `rw-c-${RUN}`
    const conceptC = (await prisma.concept.create({
      data: { name: slugC, slug: slugC, type: 'restaurant', tenantId: tenantC, taxRate: 17, taxRateCash: 15, taxRateCard: 8, isActive: true },
    })).id
    await mkStaff('mgrC', tenantC)
    await prisma.account.create({ data: { tenantId: tenantC, code: '1021', name: 'Bank — C Second', type: 'asset', isActive: true } })
    await prisma.bankAccount.create({ data: { tenantId: tenantC, name: 'C Ops', accountCode: '1020' } })
    const second = (await prisma.bankAccount.create({ data: { tenantId: tenantC, name: 'C Second', accountCode: '1021' } })).id
    const ofB = (await prisma.bankAccount.create({ data: { tenantId: tenantB, name: 'B Ops', accountCode: '1020' } })).id
    const c = await mkCustomer([conceptC])

    const noPick = await asStaff('mgrC', 'POST', '/wallet/topup', { customerId: c, amountCents: 10_000, kind: 'paid', tender: 'bank' })
    expect(noPick.statusCode).toBe(422)
    expect(noPick.json().error.code).toBe('BANK_ACCOUNT_REQUIRED')
    const foreign = await asStaff('mgrC', 'POST', '/wallet/topup', { customerId: c, amountCents: 10_000, kind: 'paid', tender: 'bank', bankAccountId: ofB })
    expect(foreign.statusCode).toBe(422)
    expect(foreign.json().error.code).toBe('BANK_ACCOUNT_NOT_IN_COMPANY')
    expect(await walletAt(tenantC, c)).toBe(0)
    expect(await prisma.walletTransaction.count({ where: { customerId: c } })).toBe(0)

    // A bank account goes with a bank transfer only.
    expect((await asStaff('mgrC', 'POST', '/wallet/topup', { customerId: c, amountCents: 10_000, bankAccountId: second })).statusCode).toBe(400)
    expect((await asStaff('mgrC', 'POST', '/wallet/topup', { customerId: c, amountCents: 10_000, kind: 'paid', tender: 'cash', bankAccountId: second })).statusCode).toBe(400)

    const ok = await asStaff('mgrC', 'POST', '/wallet/topup', { customerId: c, amountCents: 10_000, kind: 'paid', tender: 'bank', bankAccountId: second })
    expect(ok.statusCode, ok.body).toBe(201)
    const je = await entryLines(tenantC, `wallet.topup:${ok.json().transactionId}`)
    expect(je!.lines.map((l) => [l.type, l.account.code, l.amountCents]).sort()).toEqual([
      ['credit', '2050', 10_000], ['debit', '1021', 10_000],
    ])
    expect(je!.lines.every((l) => l.account.tenantId === tenantC)).toBe(true)
    expect((await prisma.walletTransaction.findUniqueOrThrow({ where: { id: ok.json().transactionId } })).bankAccountId).toBe(second)
    expect(await walletAt(tenantC, c)).toBe(10_000)
  })

  it('a one-bank company uses its only bank without a pick; cash and card stay 1010 / 1030 with no bank', async () => {
    // B has exactly one bank (created above).
    const ofB = (await prisma.bankAccount.findFirstOrThrow({ where: { tenantId: tenantB, deletedAt: null } })).id
    const c = await mkCustomer([conceptB])
    const r = await asStaff('mgrB', 'POST', '/wallet/topup', { customerId: c, amountCents: 7_000, kind: 'paid', tender: 'bank' })
    expect(r.statusCode, r.body).toBe(201)
    const je = await entryLines(tenantB, `wallet.topup:${r.json().transactionId}`)
    expect(je!.lines.map((l) => [l.type, l.account.code, l.amountCents]).sort()).toEqual([['credit', '2050', 7_000], ['debit', '1020', 7_000]])
    expect((await prisma.walletTransaction.findUniqueOrThrow({ where: { id: r.json().transactionId } })).bankAccountId).toBe(ofB)
    const card = await asStaff('mgrB', 'POST', '/wallet/topup', { customerId: c, amountCents: 3_000, kind: 'paid', tender: 'card' })
    expect((await prisma.walletTransaction.findUniqueOrThrow({ where: { id: card.json().transactionId } })).bankAccountId).toBeNull()
    expect((await entryLines(tenantB, `wallet.topup:${card.json().transactionId}`))!.lines.some((l) => l.account.code === '1030' && l.type === 'debit')).toBe(true)
  })
})
