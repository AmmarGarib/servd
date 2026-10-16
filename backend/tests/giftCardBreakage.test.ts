// Gift-card breakage (owner + accountant H11, wave B — critic-corrected).
//
//   expiry   the nightly sweep expires a card and books its unused value in
//            ONE row-locked transaction: 'giftcard.expire:<card>' Dr 2080 /
//            Cr 4200 (sold) or Cr 6060 (promotional), tagged with the brand,
//            in the CARD's company; breakageCents / breakageAt recorded.
//            Breakage is taken ONCE, at the first expiry: value a refund puts
//            back afterwards waits for a manager (expiredHoldingValue) and is
//            settled through Void.
//   held     the card's sale not in the books → the card expires, breakage
//            held (breakagePendingAt, ISSUE_NOT_BOOKED, flag
//            'gift_card_breakage_held'); a refused posting (4200 missing) →
//            the balance claim rolls back, breakagePendingAt + posting_failed;
//            the next run retries both once fixed.
//   cursor   each card is processed once per run.
//   forfeit  a SOLD card's forfeit is the CEO's (admin) only: a manager or an
//            owner gets 403 FORFEIT_NEEDS_CEO; the CEO's posts Dr 2080 /
//            Cr 4200. Another company's card is 404.
//   check    GET /gift-cards/reconcile adds breakage {count, cents} per
//            company; the difference stays 0.
//
// Requires a disposable database (DATABASE_URL must contain "test").
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import type { UserRole } from '@prisma/client'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { giftCardRoutes } from '../src/modules/giftCards/routes.js'
import { redeemGiftCard } from '../src/modules/giftCards/service.js'
import { expireDueGiftCards, expireOneGiftCard } from '../src/modules/giftCards/books.js'
import { postOrderCompletion, postOrderRefund } from '../src/modules/accounting/orderPosting.js'
import { runGiftCardExpiryOnce } from '../src/workers/giftCardExpiry.js'

const RUN = Date.now().toString(36)
let app: FastifyInstance
let tenantA: string, tenantB: string, tenantC: string, tenantD: string
let conceptA: string
const tokens: Record<string, string> = {}

async function mkUser(key: string, role: string, tenantId: string) {
  const u = await prisma.user.create({
    data: {
      name: `${key} person`, email: `${key}.${RUN}@gcbreak.test`, password: await bcrypt.hash('x-Password-1', 4),
      role: role as UserRole, isActive: true, accountStatus: 'active', tenantId,
    },
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } })
  tokens[key] = `Bearer ${(issueStaffSession(u) as { accessToken: string }).accessToken}`
}
const call = (who: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url: `/api/v1${url}`, headers: { authorization: tokens[who]! }, ...(payload !== undefined && { payload: payload as object }) })

type Line = { code: string; type: string; amount: number; conceptId: string | null }
async function entry(tenantId: string, reference: string): Promise<Line[] | null> {
  const je = await prisma.journalEntry.findFirst({
    where: { tenantId, reference },
    include: { lines: { include: { account: { select: { code: true } } } } },
  })
  return je ? je.lines.map((l) => ({ code: l.account.code, type: l.type, amount: Number(l.amountCents), conceptId: l.conceptId })) : null
}
const amt = (lines: Line[], code: string, type: 'debit' | 'credit') =>
  lines.filter((l) => l.code === code && l.type === type).reduce((t, l) => t + l.amount, 0)

// A sold card carries its payment reference # (owner, 2026-10-14).
let refSeq = 0
const withRef = (body: Record<string, unknown>) =>
  body.paymentMethod && !('paymentRef' in body) ? { ...body, paymentRef: `GB-${RUN}-${++refSeq}` } : body
async function issued(who: string, body: Record<string, unknown>): Promise<{ id: string; code: string }> {
  const r = await call(who, 'POST', '/gift-cards', { issuedAmountCents: 50_000, ...withRef(body) })
  expect(r.statusCode, r.body).toBe(201)
  return r.json()
}
const past = () => new Date(Date.now() - 60_000)
const expireNow = (ids: string[]) => prisma.giftCard.updateMany({ where: { id: { in: ids } }, data: { expiresAt: past() } })

/** A card-paid online order, completed and booked (Dr 2080 / Cr revenue). */
async function spendOnBookedSale(code: string, cents: number) {
  const o = await prisma.order.create({
    data: { conceptId: conceptA, source: 'servd', totalCents: cents, taxCents: 0, items: { create: [{ name: 'Plate', quantity: 1, unitPriceCents: cents }] } },
  })
  await redeemGiftCard({ code, orderId: o.id })
  await prisma.order.update({ where: { id: o.id }, data: { status: 'completed', completedAt: new Date() } })
  expect((await postOrderCompletion(o.id)).posted).toBe(true)
  return o.id
}

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'GS Foods (brk)', slug: `gs-brk-${RUN}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'Karachi Bites (brk)', slug: `kb-brk-${RUN}` } })).id
  tenantC = (await prisma.tenant.create({ data: { name: 'No-4200 Co (brk)', slug: `nc-brk-${RUN}` } })).id
  tenantD = (await prisma.tenant.create({ data: { name: 'Many cards (brk)', slug: `mc-brk-${RUN}` } })).id
  for (const t of [tenantA, tenantB, tenantC, tenantD]) await ensureChartOfAccounts(t)
  await prisma.account.updateMany({ where: { tenantId: tenantC, code: '4200' }, data: { isActive: false } })

  await mkUser('mgrA', 'manager', tenantA)
  await mkUser('ownerA', 'owner', tenantA)
  await mkUser('adminA', 'admin', tenantA)
  await mkUser('finA', 'finance', tenantA)
  await mkUser('mgrB', 'manager', tenantB)
  await mkUser('adminB', 'admin', tenantB)
  await mkUser('mgrC', 'manager', tenantC)

  conceptA = (await prisma.concept.create({ data: { name: 'Stackd', slug: `stackd-brk-${RUN}`, type: 'restaurant', tenantId: tenantA } })).id

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(async (api) => {
    await api.register(giftCardRoutes, { prefix: '/gift-cards' })
  }, { prefix: '/api/v1' })
  await app.ready()
}, 120_000)

afterAll(async () => {
  await app?.close()
})

describe('the sweep books breakage at the first expiry, in the card\'s company', () => {
  it('A: sold → Dr 2080 / Cr 4200, promotional → Cr 6060, tagged with the brand; B untouched; a second run books nothing more', async () => {
    const sold = await issued('mgrA', { paymentMethod: 'cash', conceptId: conceptA })
    const promo = await issued('mgrA', { kind: 'promotional', reason: 'Launch giveaway', conceptId: conceptA, issuedAmountCents: 30_000 })
    const bCard = await issued('mgrB', { paymentMethod: 'cash', issuedAmountCents: 40_000 })
    await expireNow([sold.id, promo.id, bCard.id])

    const r = await expireDueGiftCards(tenantA)
    expect(r).toMatchObject({ expired: 2, breakageCount: 2, breakageCents: 80_000, held: 0, failed: 0 })

    const s = (await entry(tenantA, `giftcard.expire:${sold.id}`))!
    expect(amt(s, '2080', 'debit')).toBe(50_000)
    expect(amt(s, '4200', 'credit')).toBe(50_000)
    expect(s.every((l) => l.conceptId === conceptA)).toBe(true)
    const p = (await entry(tenantA, `giftcard.expire:${promo.id}`))!
    expect(amt(p, '2080', 'debit')).toBe(30_000)
    expect(amt(p, '6060', 'credit')).toBe(30_000)
    expect(amt(p, '4200', 'credit')).toBe(0)

    const card = await prisma.giftCard.findUniqueOrThrow({ where: { id: sold.id } })
    expect(card).toMatchObject({ status: 'expired', balanceCents: 0, breakageCents: 50_000, breakagePendingAt: null })
    expect(card.breakageAt).toBeInstanceOf(Date)
    expect(card.expiredAt).toBeInstanceOf(Date)

    // B's card: still active, nothing in B's books yet.
    expect((await prisma.giftCard.findUniqueOrThrow({ where: { id: bCard.id } })).status).toBe('active')
    expect(await prisma.journalEntry.count({ where: { tenantId: tenantB, reference: { startsWith: 'giftcard.expire' } } })).toBe(0)

    // Second run: nothing new; one entry per card.
    expect(await expireDueGiftCards(tenantA)).toMatchObject({ expired: 0, breakageCount: 0, held: 0 })
    expect(await prisma.journalEntry.count({ where: { reference: `giftcard.expire:${sold.id}` } })).toBe(1)
    expect(await expireOneGiftCard(sold.id)).toEqual({ expired: false, breakageCents: 0, held: false })

    // The worker sweeps every company: B's card now, in B's books only.
    expect(await runGiftCardExpiryOnce()).toBeGreaterThanOrEqual(1)
    const b = (await entry(tenantB, `giftcard.expire:${bCard.id}`))!
    expect(amt(b, '4200', 'credit')).toBe(40_000)
    expect(await entry(tenantA, `giftcard.expire:${bCard.id}`)).toBeNull()
  })

  it('value a refund puts back on an expired card is NOT swept: it waits for a manager, who settles it through Void', async () => {
    const c = await issued('mgrA', { paymentMethod: 'cash', conceptId: conceptA })
    const orderId = await spendOnBookedSale(c.code, 20_000)
    await expireNow([c.id])
    expect(await expireOneGiftCard(c.id)).toEqual({ expired: true, breakageCents: 30_000, held: false })

    await prisma.order.update({ where: { id: orderId }, data: { status: 'refunded' } })
    await postOrderRefund(orderId, 'Order refunded')
    expect(await prisma.giftCard.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ status: 'expired', balanceCents: 20_000, breakageCents: 30_000 })

    // Never swept — by the sweep or a direct retry.
    expect(await expireDueGiftCards(tenantA)).toMatchObject({ breakageCount: 0 })
    expect(await expireOneGiftCard(c.id)).toEqual({ expired: false, breakageCents: 0, held: false })
    expect(await prisma.journalEntry.count({ where: { reference: { startsWith: `giftcard.expire:${c.id}` } } })).toBe(1)

    const check = (await call('finA', 'GET', '/gift-cards/reconcile')).json().companies[0]
    const waiting = check.expiredHoldingValue.items.find((i: { id: string }) => i.id === c.id)
    expect(waiting).toMatchObject({ balanceCents: 20_000 })
    expect(waiting.code.startsWith('••••')).toBe(true)   // finance sees masked codes

    const v = await call('mgrA', 'POST', `/gift-cards/${c.id}/void`, { reason: 'Refund paid out', disposition: 'refund', refundMethod: 'cash' })
    expect(v.statusCode, v.body).toBe(200)
    const je = (await entry(tenantA, `giftcard.void:${c.id}`))!
    expect(amt(je, '2080', 'debit')).toBe(20_000)
    expect(amt(je, '1010', 'credit')).toBe(20_000)
  })
})

describe('held breakage', () => {
  it('ISSUE_NOT_BOOKED: the card expires, breakage held and flagged once; booked once the sale is', async () => {
    const legacy = await prisma.giftCard.create({
      data: { tenantId: tenantA, code: `GS-HLD-${RUN}`.toUpperCase(), issuedAmountCents: 40_000, balanceCents: 40_000, expiresAt: past(), conceptId: conceptA },
    })
    expect(await expireOneGiftCard(legacy.id)).toEqual({ expired: true, breakageCents: 0, held: true })
    const card = await prisma.giftCard.findUniqueOrThrow({ where: { id: legacy.id } })
    expect(card).toMatchObject({ status: 'expired', balanceCents: 40_000, breakageCents: 0, breakageAt: null, breakagePendingReason: 'ISSUE_NOT_BOOKED' })
    expect(card.breakagePendingAt).toBeInstanceOf(Date)
    expect(await prisma.journalEntry.count({ where: { reference: `giftcard.expire:${legacy.id}` } })).toBe(0)

    const flags = () => prisma.exceptionFlag.findMany({ where: { kind: 'gift_card_breakage_held', entityId: legacy.id } })
    expect(await flags()).toHaveLength(1)
    expect((await flags())[0]).toMatchObject({ tenantId: tenantA, status: 'open', entityType: 'GiftCard' })
    expect(await expireDueGiftCards(tenantA)).toMatchObject({ held: 1 })
    expect(await flags()).toHaveLength(1)   // never raised twice

    // A void would be refused too (the same check), so book the sale; the next sweep books the breakage.
    expect((await call('finA', 'POST', `/gift-cards/${legacy.id}/book-issue`, { paymentMethod: 'cash', paymentRef: 'LATE-BOOK-1' })).statusCode).toBe(200)
    expect(await expireDueGiftCards(tenantA)).toMatchObject({ breakageCount: 1, breakageCents: 40_000, held: 0 })
    const je = (await entry(tenantA, `giftcard.expire:${legacy.id}`))!
    expect(amt(je, '4200', 'credit')).toBe(40_000)
    expect(await prisma.giftCard.findUniqueOrThrow({ where: { id: legacy.id } })).toMatchObject({ balanceCents: 0, breakageCents: 40_000, breakagePendingAt: null, breakagePendingReason: null })
    expect((await flags())[0]!.status).toBe('resolved')
  })

  it('4200 missing: the card stays expired with its balance, breakagePendingAt + posting_failed; the next run books it once the chart is fixed', async () => {
    const r = await call('mgrC', 'POST', '/gift-cards', { issuedAmountCents: 25_000, paymentMethod: 'cash', paymentRef: `GB-${RUN}-C` })
    expect(r.statusCode, r.body).toBe(201)
    const c = r.json() as { id: string }
    await expireNow([c.id])

    expect(await expireDueGiftCards(tenantC)).toMatchObject({ expired: 1, held: 1, breakageCount: 0, failed: 0 })
    const card = await prisma.giftCard.findUniqueOrThrow({ where: { id: c.id } })
    expect(card).toMatchObject({ status: 'expired', balanceCents: 25_000, breakageCents: 0, breakageAt: null })
    expect(card.breakagePendingAt).toBeInstanceOf(Date)
    expect(card.breakagePendingReason).toMatch(/^POSTING_REFUSED/)
    expect(await prisma.journalEntry.count({ where: { tenantId: tenantC, reference: { startsWith: 'giftcard.expire' } } })).toBe(0)
    const flag = await prisma.exceptionFlag.findFirstOrThrow({ where: { kind: 'posting_failed', entityType: 'GiftCard', entityId: c.id } })
    expect(flag).toMatchObject({ tenantId: tenantC, status: 'open' })
    expect(flag.metadata).toMatchObject({ sourceType: 'giftcard.expire', sourceId: c.id })

    // Still refused: still held, one flag.
    expect(await expireDueGiftCards(tenantC)).toMatchObject({ held: 1 })
    expect(await prisma.exceptionFlag.count({ where: { kind: 'posting_failed', entityId: c.id } })).toBe(1)

    await prisma.account.updateMany({ where: { tenantId: tenantC, code: '4200' }, data: { isActive: true } })
    expect(await expireDueGiftCards(tenantC)).toMatchObject({ breakageCount: 1, breakageCents: 25_000, held: 0 })
    const je = (await entry(tenantC, `giftcard.expire:${c.id}`))!
    expect(amt(je, '2080', 'debit')).toBe(25_000)
    expect(amt(je, '4200', 'credit')).toBe(25_000)
    expect(await prisma.giftCard.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ balanceCents: 0, breakageCents: 25_000, breakagePendingAt: null })
    expect((await prisma.exceptionFlag.findFirstOrThrow({ where: { id: flag.id } })).status).toBe('resolved')
  })

  it('the cursor: every due card is processed exactly once per run, even when every one is held', async () => {
    const N = 205   // more than one page (200)
    const base = Date.now() - 86_400_000
    await prisma.giftCard.createMany({
      data: Array.from({ length: N }, (_, i) => ({
        tenantId: tenantD, code: `GS-CUR-${RUN}-${i}`.toUpperCase(), issuedAmountCents: 10_000, balanceCents: 10_000,
        // Some share an expiry instant: the id breaks the tie.
        expiresAt: new Date(base + Math.floor(i / 3) * 1000),
      })),
    })
    expect(await expireDueGiftCards(tenantD)).toEqual({ expired: N, breakageCount: 0, breakageCents: 0, held: N, failed: 0 })
    expect(await expireDueGiftCards(tenantD)).toEqual({ expired: 0, breakageCount: 0, breakageCents: 0, held: N, failed: 0 })
    expect(await prisma.exceptionFlag.count({ where: { tenantId: tenantD, kind: 'gift_card_breakage_held' } })).toBe(N)
  })
})

describe('forfeit of a SOLD card is the CEO\'s', () => {
  it('a manager and an owner get 403 FORFEIT_NEEDS_CEO; B\'s admin gets 404; the CEO\'s forfeit posts Dr 2080 / Cr 4200', async () => {
    const c = await issued('mgrA', { paymentMethod: 'cash', conceptId: conceptA })
    for (const who of ['mgrA', 'ownerA']) {
      const r = await call(who, 'POST', `/gift-cards/${c.id}/void`, { reason: 'Keep the money', disposition: 'forfeit' })
      expect(r.statusCode).toBe(403)
      expect(r.json().error.code).toBe('FORFEIT_NEEDS_CEO')
    }
    expect((await call('adminB', 'POST', `/gift-cards/${c.id}/void`, { reason: 'Keep the money', disposition: 'forfeit' })).statusCode).toBe(404)
    expect(await prisma.giftCard.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ status: 'active', balanceCents: 50_000 })

    const ok = await call('adminA', 'POST', `/gift-cards/${c.id}/void`, { reason: 'Customer abandoned the card', disposition: 'forfeit' })
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json()).toMatchObject({ status: 'voided', voidDisposition: 'forfeit', creditCode: '4200', postedCents: 50_000, breakageCents: 50_000 })
    const je = (await entry(tenantA, `giftcard.void:${c.id}`))!
    expect(amt(je, '2080', 'debit')).toBe(50_000)
    expect(amt(je, '4200', 'credit')).toBe(50_000)

    // A promotional card's forfeit stays any manager's (back to 6060).
    const promo = await issued('mgrA', { kind: 'promotional', reason: 'Influencer visit' })
    const pr = await call('mgrA', 'POST', `/gift-cards/${promo.id}/void`, { reason: 'Campaign over', disposition: 'forfeit' })
    expect(pr.statusCode, pr.body).toBe(200)
    expect(pr.json()).toMatchObject({ creditCode: '6060', breakageCents: 50_000 })
  })
})

describe('the books check carries breakage per company and still agrees', () => {
  it('A: breakage counted, difference 0; B sees only B', async () => {
    const r = await call('finA', 'GET', '/gift-cards/reconcile')
    expect(r.statusCode, r.body).toBe(200)
    const companies = r.json().companies as Array<{ tenantId: string; differenceCents: number; unexplainedCents: number; breakage: { count: number; cents: number }; breakageHeld: { count: number } }>
    expect(companies.map((x) => x.tenantId)).toEqual([tenantA])
    const a = companies[0]!
    const cards = await prisma.giftCard.findMany({ where: { tenantId: tenantA, breakageCents: { gt: 0 } }, select: { breakageCents: true } })
    expect(a.breakage).toEqual({ count: cards.length, cents: cards.reduce((s, c) => s + c.breakageCents, 0) })
    // sold 50,000 + promo 30,000 + 30,000 (refund test) + legacy 40,000 + CEO forfeit 50,000 + promo forfeit 50,000
    expect(a.breakage).toEqual({ count: 6, cents: 250_000 })
    expect(a.breakageHeld.count).toBe(0)
    expect(a.differenceCents).toBe(0)
    expect(a.unexplainedCents).toBe(0)

    const b = (await call('adminB', 'GET', '/gift-cards/reconcile')).json().companies as Array<{ tenantId: string; breakage: { count: number; cents: number }; differenceCents: number }>
    expect(b.map((x) => x.tenantId)).toEqual([tenantB])
    expect(b[0]!.breakage).toEqual({ count: 1, cents: 40_000 })
    expect(b[0]!.differenceCents).toBe(0)
  })
})
