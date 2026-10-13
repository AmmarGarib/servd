// Gift cards in the books (finance gaps #7, 18a, 18c — 2026-10-13).
//
//   issue    the card and its 'giftcard.issue' entry are ONE transaction:
//            sold cash Dr 1010 / card Dr 1030 / bank transfer Dr that bank's
//            code (the card's company's bank only), promotional Dr 6060; all
//            Cr 2080. A refused entry leaves no card. Only the back office
//            (managers + finance) sells; only managers give promotional cards.
//   void     row-locked, balance claimed: refund Dr 2080 / Cr cash|card|bank;
//            payment_not_received Dr 2080 / Cr the account the issue debited;
//            forfeit only on promotional cards (Cr 6060) — a sold card's is
//            pending owner decision G10.
//   expiry   the sweep records 'expired' + expiredAt, per company, no entry
//            (G10); the redeem's doomed status write is gone.
//   refund   a refund of an order a card paid never reopens a voided or
//            expired card; the value waits on it and a manager settles it.
//   2080     GET /gift-cards/reconcile: ledger vs cards, per company; the list
//            is paginated; 2080 is a required account.
//
// Two companies throughout: B never sees, voids or books A's cards.
// Requires a disposable database (DATABASE_URL must contain "test").
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import type { UserRole } from '@prisma/client'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { ensureChartOfAccounts, REQUIRED_ACCOUNT_CODES } from '../src/lib/chartOfAccounts.js'
import { linkBankLedgerAccount } from '../src/lib/bankAccounts.js'
import { giftCardRoutes } from '../src/modules/giftCards/routes.js'
import { redeemGiftCard } from '../src/modules/giftCards/service.js'
import { postOrderCompletion, postOrderRefund } from '../src/modules/accounting/orderPosting.js'
import { runGiftCardExpiryOnce } from '../src/workers/giftCardExpiry.js'

const RUN = Date.now().toString(36)
let app: FastifyInstance
let tenantA: string, tenantB: string, tenantC: string
let conceptA: string
const tokens: Record<string, string> = {}
const ids: Record<string, string> = {}

async function mkUser(key: string, role: string, tenantId: string) {
  const u = await prisma.user.create({
    data: {
      name: `${key} person`, email: `${key}.${RUN}@gcledger.test`, password: await bcrypt.hash('x-Password-1', 4),
      role: role as UserRole, isActive: true, accountStatus: 'active', tenantId,
    },
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } })
  tokens[key] = `Bearer ${(issueStaffSession(u) as { accessToken: string }).accessToken}`
  ids[key] = u.id
}
const call = (who: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url: `/api/v1${url}`, headers: { authorization: tokens[who]! }, ...(payload !== undefined && { payload: payload as object }) })

type Line = { code: string; type: string; amount: number }
async function entry(tenantId: string, reference: string): Promise<Line[] | null> {
  const je = await prisma.journalEntry.findFirst({
    where: { tenantId, reference },
    include: { lines: { include: { account: { select: { code: true } } } } },
  })
  return je ? je.lines.map((l) => ({ code: l.account.code, type: l.type, amount: Number(l.amountCents) })) : null
}
const amt = (lines: Line[], code: string, type: 'debit' | 'credit') =>
  lines.filter((l) => l.code === code && l.type === type).reduce((t, l) => t + l.amount, 0)

async function issue(who: string, body: Record<string, unknown>) {
  const r = await call(who, 'POST', '/gift-cards', { issuedAmountCents: 50_000, ...body })
  return r
}
async function issued(who: string, body: Record<string, unknown>): Promise<{ id: string; code: string }> {
  const r = await issue(who, body)
  expect(r.statusCode, r.body).toBe(201)
  return r.json()
}

/** An online order the card pays in full, completed and booked (Dr 2080 / Cr revenue). */
async function spendOnBookedSale(code: string, cents: number) {
  const o = await prisma.order.create({
    data: { conceptId: conceptA, source: 'servd', totalCents: cents, taxCents: 0, items: { create: [{ name: 'Plate', quantity: 1, unitPriceCents: cents }] } },
  })
  await redeemGiftCard({ code, orderId: o.id })
  await prisma.order.update({ where: { id: o.id }, data: { status: 'completed', completedAt: new Date() } })
  expect((await postOrderCompletion(o.id)).posted).toBe(true)
  return o.id
}
async function refundOrder(orderId: string) {
  await prisma.order.update({ where: { id: orderId }, data: { status: 'refunded' } })
  await postOrderRefund(orderId, 'Order refunded')
}

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'GS Foods (gc)', slug: `gs-gc-${RUN}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'Karachi Bites (gc)', slug: `kb-gc-${RUN}` } })).id
  tenantC = (await prisma.tenant.create({ data: { name: 'No-2080 Co (gc)', slug: `nc-gc-${RUN}` } })).id
  for (const t of [tenantA, tenantB, tenantC]) await ensureChartOfAccounts(t)
  await prisma.account.updateMany({ where: { tenantId: tenantC, code: '2080' }, data: { isActive: false } })

  await mkUser('mgrA', 'manager', tenantA)
  await mkUser('finA', 'finance', tenantA)
  await mkUser('cashA', 'cashier', tenantA)
  await mkUser('mgrB', 'manager', tenantB)
  await mkUser('mgrC', 'manager', tenantC)

  conceptA = (await prisma.concept.create({ data: { name: 'Stackd', slug: `stackd-gc-${RUN}`, type: 'restaurant', tenantId: tenantA } })).id
  ids.bankA = (await prisma.bankAccount.create({ data: { tenantId: tenantA, name: 'HBL Ops', accountCode: '1020' } })).id
  ids.bankB = (await prisma.bankAccount.create({ data: { tenantId: tenantB, name: 'MCB Ops', accountCode: '1020' } })).id

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

describe('issue: the card and its entry together, in the right accounts', () => {
  it('sold for cash: Dr 1010 / Cr 2080 in A, payment method stored', async () => {
    const c = await issued('mgrA', { paymentMethod: 'cash' })
    const card = await prisma.giftCard.findUniqueOrThrow({ where: { id: c.id } })
    expect(card).toMatchObject({ tenantId: tenantA, kind: 'sold', paymentMethod: 'cash', bankAccountId: null })
    const je = (await entry(tenantA, `giftcard.issue:${c.id}`))!
    expect(amt(je, '1010', 'debit')).toBe(50_000)
    expect(amt(je, '2080', 'credit')).toBe(50_000)
    expect(await entry(tenantB, `giftcard.issue:${c.id}`)).toBeNull()
  })

  it('sold by card: Dr 1030', async () => {
    const c = await issued('finA', { paymentMethod: 'card' })
    expect(amt((await entry(tenantA, `giftcard.issue:${c.id}`))!, '1030', 'debit')).toBe(50_000)
  })

  it('bank transfer debits the named bank of the company (not 1030); another company\'s bank is 422 and no card', async () => {
    const c = await issued('mgrA', { paymentMethod: 'bank_transfer', bankAccountId: ids.bankA })
    const je = (await entry(tenantA, `giftcard.issue:${c.id}`))!
    expect(amt(je, '1020', 'debit')).toBe(50_000)
    expect(amt(je, '1030', 'debit')).toBe(0)
    expect((await prisma.giftCard.findUniqueOrThrow({ where: { id: c.id } })).bankAccountId).toBe(ids.bankA)

    const before = await prisma.giftCard.count({ where: { tenantId: tenantA } })
    const foreign = await issue('mgrA', { paymentMethod: 'bank_transfer', bankAccountId: ids.bankB })
    expect(foreign.statusCode).toBe(422)
    expect(foreign.json().error.code).toBe('BANK_ACCOUNT_NOT_IN_COMPANY')
    expect(await prisma.giftCard.count({ where: { tenantId: tenantA } })).toBe(before)
  })

  it('with two banks and none named, the bank must be picked; a second bank posts to its own code', async () => {
    const code = await linkBankLedgerAccount(tenantA, 'Meezan')
    ids.bankA2 = (await prisma.bankAccount.create({ data: { tenantId: tenantA, name: 'Meezan', accountCode: code } })).id
    const r = await issue('mgrA', { paymentMethod: 'bank_transfer' })
    expect(r.statusCode).toBe(422)
    expect(r.json().error.code).toBe('BANK_ACCOUNT_REQUIRED')
    const c = await issued('mgrA', { paymentMethod: 'bank_transfer', bankAccountId: ids.bankA2 })
    expect(amt((await entry(tenantA, `giftcard.issue:${c.id}`))!, code, 'debit')).toBe(50_000)
  })

  it('when the books refuse (2080 inactive), no card exists and no entry', async () => {
    const r = await issue('mgrC', { paymentMethod: 'cash' })
    expect(r.statusCode).toBe(500)
    expect(r.json().error.code).toBe('ACCOUNT_NOT_FOUND')
    expect(await prisma.giftCard.count({ where: { tenantId: tenantC } })).toBe(0)
    expect(await prisma.journalEntry.count({ where: { tenantId: tenantC } })).toBe(0)
  })

  it('a sold card needs a payment method; a cashier cannot issue at all', async () => {
    const none = await issue('mgrA', {})
    expect(none.statusCode).toBe(422)
    expect(none.json().error.code).toBe('PAYMENT_METHOD_REQUIRED')
    expect((await issue('cashA', { paymentMethod: 'cash' })).statusCode).toBe(403)
  })

  it('promotional: managers only, a reason, no payment — Dr 6060 / Cr 2080', async () => {
    expect((await issue('finA', { kind: 'promotional', reason: 'Influencer visit' })).statusCode).toBe(403)
    expect((await issue('mgrA', { kind: 'promotional' })).json().error.code).toBe('REASON_REQUIRED')
    expect((await issue('mgrA', { kind: 'promotional', reason: 'Influencer visit', paymentMethod: 'cash' })).json().error.code).toBe('PROMO_CARD_NOT_PAID')
    const c = await issued('mgrA', { kind: 'promotional', reason: 'Influencer visit', conceptId: conceptA })
    const card = await prisma.giftCard.findUniqueOrThrow({ where: { id: c.id } })
    expect(card).toMatchObject({ kind: 'promotional', paymentMethod: null, conceptId: conceptA })
    const je = (await entry(tenantA, `giftcard.issue:${c.id}`))!
    expect(amt(je, '6060', 'debit')).toBe(50_000)
    expect(amt(je, '2080', 'credit')).toBe(50_000)
  })

  it('B cannot issue under A\'s brand', async () => {
    expect((await issue('mgrB', { paymentMethod: 'cash', conceptId: conceptA })).statusCode).toBe(404)
  })
})

describe('void: the balance leaves 2080 the way the disposition says', () => {
  it('B voiding A\'s card is 404 and nothing moves; finance cannot void', async () => {
    const c = await issued('mgrA', { paymentMethod: 'cash' })
    expect((await call('mgrB', 'POST', `/gift-cards/${c.id}/void`, { reason: 'fraud test', disposition: 'refund', refundMethod: 'cash' })).statusCode).toBe(404)
    expect((await call('finA', 'POST', `/gift-cards/${c.id}/void`, { reason: 'fraud test', disposition: 'refund', refundMethod: 'cash' })).statusCode).toBe(403)
    const card = await prisma.giftCard.findUniqueOrThrow({ where: { id: c.id } })
    expect(card).toMatchObject({ status: 'active', balanceCents: 50_000 })
    expect(await prisma.journalEntry.count({ where: { reference: `giftcard.void:${c.id}` } })).toBe(0)
  })

  it('refund in cash: Dr 2080 / Cr 1010 for what is left; the card is voided at zero; a second void is 409', async () => {
    const c = await issued('mgrA', { paymentMethod: 'card' })
    await spendOnBookedSale(c.code, 20_000)
    const r = await call('mgrA', 'POST', `/gift-cards/${c.id}/void`, { reason: 'Customer asked for the rest back', disposition: 'refund', refundMethod: 'cash' })
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json()).toMatchObject({ status: 'voided', balanceCents: 0, voidDisposition: 'refund', postedCents: 30_000, creditCode: '1010' })
    const je = (await entry(tenantA, `giftcard.void:${c.id}`))!
    expect(amt(je, '2080', 'debit')).toBe(30_000)
    expect(amt(je, '1010', 'credit')).toBe(30_000)
    expect((await call('mgrA', 'POST', `/gift-cards/${c.id}/void`, { reason: 'again', disposition: 'refund', refundMethod: 'cash' })).statusCode).toBe(409)
  })

  it('refund to another company\'s bank is 422 and the card is untouched', async () => {
    const c = await issued('mgrA', { paymentMethod: 'cash' })
    const r = await call('mgrA', 'POST', `/gift-cards/${c.id}/void`, { reason: 'refund it', disposition: 'refund', refundMethod: 'bank_transfer', bankAccountId: ids.bankB })
    expect(r.statusCode).toBe(422)
    expect((await prisma.giftCard.findUniqueOrThrow({ where: { id: c.id } })).status).toBe('active')
  })

  it('payment never received: Dr 2080 / Cr the account the issue debited (the bank)', async () => {
    const c = await issued('mgrA', { paymentMethod: 'bank_transfer', bankAccountId: ids.bankA2 })
    const bankCode = (await prisma.bankAccount.findUniqueOrThrow({ where: { id: ids.bankA2 } })).accountCode!
    const r = await call('mgrA', 'POST', `/gift-cards/${c.id}/void`, { reason: 'Transfer bounced', disposition: 'payment_not_received' })
    expect(r.statusCode, r.body).toBe(200)
    const je = (await entry(tenantA, `giftcard.void:${c.id}`))!
    expect(amt(je, '2080', 'debit')).toBe(50_000)
    expect(amt(je, bankCode, 'credit')).toBe(50_000)
  })

  it('a sold card cannot be forfeited (pending G10); a promotional card can only be forfeited — back to 6060', async () => {
    const sold = await issued('mgrA', { paymentMethod: 'cash' })
    const f = await call('mgrA', 'POST', `/gift-cards/${sold.id}/void`, { reason: 'keep it', disposition: 'forfeit' })
    expect(f.statusCode).toBe(422)
    expect(f.json().error.code).toBe('FORFEIT_PENDING_DECISION')

    const promo = await issued('mgrA', { kind: 'promotional', reason: 'Launch giveaway' })
    expect((await call('mgrA', 'POST', `/gift-cards/${promo.id}/void`, { reason: 'Pay it out', disposition: 'refund', refundMethod: 'cash' })).json().error.code).toBe('PROMO_CARD_FORFEIT_ONLY')
    const ok = await call('mgrA', 'POST', `/gift-cards/${promo.id}/void`, { reason: 'Campaign over', disposition: 'forfeit' })
    expect(ok.statusCode, ok.body).toBe(200)
    const je = (await entry(tenantA, `giftcard.void:${promo.id}`))!
    expect(amt(je, '2080', 'debit')).toBe(50_000)
    expect(amt(je, '6060', 'credit')).toBe(50_000)
  })

  it('a card whose sale never reached the books must be booked before it is voided; B cannot book it', async () => {
    const legacy = await prisma.giftCard.create({ data: { tenantId: tenantA, code: `GS-LEG-${RUN}`.toUpperCase(), issuedAmountCents: 40_000, balanceCents: 40_000 } })
    const v = await call('mgrA', 'POST', `/gift-cards/${legacy.id}/void`, { reason: 'refund it', disposition: 'refund', refundMethod: 'cash' })
    expect(v.json().error.code).toBe('ISSUE_NOT_BOOKED')
    expect((await call('mgrB', 'POST', `/gift-cards/${legacy.id}/book-issue`, { paymentMethod: 'cash' })).statusCode).toBe(404)

    const b = await call('finA', 'POST', `/gift-cards/${legacy.id}/book-issue`, { paymentMethod: 'cash' })
    expect(b.statusCode, b.body).toBe(200)
    expect(amt((await entry(tenantA, `giftcard.issue:${legacy.id}`))!, '2080', 'credit')).toBe(40_000)
    expect((await call('finA', 'POST', `/gift-cards/${legacy.id}/book-issue`, { paymentMethod: 'cash' })).statusCode).toBe(409)
    expect((await call('mgrA', 'POST', `/gift-cards/${legacy.id}/void`, { reason: 'refund it', disposition: 'refund', refundMethod: 'cash' })).statusCode).toBe(200)
  })
})

describe('expiry is recorded by the sweep, per company, with no entry (G10)', () => {
  it('the redeem refuses an expired card without a doomed write; the sweep marks it expired once', async () => {
    const a = await issued('mgrA', { paymentMethod: 'cash' })
    const keep = await issued('mgrA', { paymentMethod: 'cash', expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString() })
    const b = await issued('mgrB', { paymentMethod: 'cash' })
    const past = new Date(Date.now() - 60_000)
    await prisma.giftCard.updateMany({ where: { id: { in: [a.id, b.id] } }, data: { expiresAt: past } })

    const o = await prisma.order.create({ data: { conceptId: conceptA, source: 'servd', totalCents: 10_000 } })
    await expect(redeemGiftCard({ code: a.code, orderId: o.id })).rejects.toMatchObject({ code: 'GIFTCARD_EXPIRED' })
    expect((await prisma.giftCard.findUniqueOrThrow({ where: { id: a.id } })).status).toBe('active')
    expect((await call('mgrA', 'GET', `/gift-cards/balance/${a.code}`)).json().status).toBe('expired')

    expect(await runGiftCardExpiryOnce()).toBeGreaterThanOrEqual(2)
    const after = await prisma.giftCard.findMany({ where: { id: { in: [a.id, b.id, keep.id] } } })
    const by = new Map(after.map((c) => [c.id, c]))
    expect(by.get(a.id)).toMatchObject({ status: 'expired', balanceCents: 50_000 })
    expect(by.get(a.id)!.expiredAt).toBeInstanceOf(Date)
    expect(by.get(b.id)!.status).toBe('expired')
    expect(by.get(keep.id)!.status).toBe('active')
    expect(await prisma.journalEntry.count({ where: { reference: { startsWith: 'giftcard.expire' } } })).toBe(0)
    expect(await runGiftCardExpiryOnce()).toBe(0)
  })
})

describe('a refund never reopens a voided or expired card', () => {
  it('a spent card comes back to active; a voided card stays voided and holds the value until settled', async () => {
    // Fully spent → redeemed_full → the refund makes it active again.
    const spent = await issued('mgrA', { paymentMethod: 'cash', issuedAmountCents: 20_000 })
    const o1 = await spendOnBookedSale(spent.code, 20_000)
    expect((await prisma.giftCard.findUniqueOrThrow({ where: { id: spent.id } })).status).toBe('redeemed_full')
    await refundOrder(o1)
    expect(await prisma.giftCard.findUniqueOrThrow({ where: { id: spent.id } })).toMatchObject({ status: 'active', balanceCents: 20_000 })

    // Voided after spending part: the refund's value lands on the card, which stays voided.
    const c = await issued('mgrA', { paymentMethod: 'cash' })
    const o2 = await spendOnBookedSale(c.code, 20_000)
    expect((await call('mgrA', 'POST', `/gift-cards/${c.id}/void`, { reason: 'Reported stolen', disposition: 'refund', refundMethod: 'cash' })).statusCode).toBe(200)
    await refundOrder(o2)
    expect(await prisma.giftCard.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ status: 'voided', balanceCents: 20_000 })
    const red = await prisma.giftCardRedemption.findFirstOrThrow({ where: { orderId: o2 } })
    expect(amt((await entry(tenantA, `order.refund_giftcard:${red.id}`))!, '2080', 'credit')).toBe(20_000)
    const redeemAgain = await prisma.order.create({ data: { conceptId: conceptA, source: 'servd', totalCents: 5_000 } })
    await expect(redeemGiftCard({ code: c.code, orderId: redeemAgain.id })).rejects.toMatchObject({ code: 'GIFTCARD_INACTIVE' })

    const check = (await call('finA', 'GET', '/gift-cards/reconcile')).json().companies[0]
    expect(check.voidedHoldingValue.items.map((i: { id: string }) => i.id)).toContain(c.id)

    // Settled: a second void entry ('@2') pays the customer out.
    const s = await call('mgrA', 'POST', `/gift-cards/${c.id}/void`, { reason: 'Pay the refund out', disposition: 'refund', refundMethod: 'cash' })
    expect(s.statusCode, s.body).toBe(200)
    const je = (await entry(tenantA, `giftcard.void:${c.id}@2`))!
    expect(amt(je, '2080', 'debit')).toBe(20_000)
    expect(amt(je, '1010', 'credit')).toBe(20_000)
    expect((await prisma.giftCard.findUniqueOrThrow({ where: { id: c.id } })).balanceCents).toBe(0)
  })

  it('an expired card stays expired when a refund puts value back', async () => {
    const c = await issued('mgrA', { paymentMethod: 'cash' })
    const o = await spendOnBookedSale(c.code, 10_000)
    await prisma.giftCard.update({ where: { id: c.id }, data: { expiresAt: new Date(Date.now() - 1_000) } })
    await runGiftCardExpiryOnce()
    await refundOrder(o)
    expect(await prisma.giftCard.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ status: 'expired', balanceCents: 50_000 })
  })
})

describe('the register and the 2080 check', () => {
  it('2080 is a required account (health warns when it is missing)', () => {
    expect(REQUIRED_ACCOUNT_CODES).toContain('2080')
  })

  it('the list pages through every card with a cursor; B\'s cursor and B\'s view never show A\'s cards', async () => {
    const total = await prisma.giftCard.count({ where: { tenantId: tenantA } })
    expect(total).toBeGreaterThan(5)
    const seen: string[] = []
    let cursor: string | null = null
    for (let i = 0; i < 50; i++) {
      const page = (await call('finA', 'GET', `/gift-cards?limit=4${cursor ? `&cursor=${cursor}` : ''}`)).json() as { items: Array<{ id: string; code: string }>; nextCursor: string | null; total: number }
      expect(page.total).toBe(total)
      expect(page.items.length).toBeLessThanOrEqual(4)
      seen.push(...page.items.map((c) => c.id))
      expect(page.items.every((c) => c.code.startsWith('••••'))).toBe(true)   // finance sees masked codes
      cursor = page.nextCursor
      if (!cursor) break
    }
    expect(seen.length).toBe(total)
    expect(new Set(seen).size).toBe(total)

    const b = (await call('mgrB', 'GET', '/gift-cards')).json() as { items: Array<{ id: string }> }
    expect(b.items.some((c) => seen.includes(c.id))).toBe(false)
    expect((await call('mgrB', 'GET', `/gift-cards?cursor=${seen[0]}`)).statusCode).toBe(404)
  })

  it('A\'s 2080 agrees with its cards; an unbooked sale and an open order are explained; B sees only B', async () => {
    // Value spent on an order that has not completed: still owed in 2080.
    const c = await issued('mgrA', { paymentMethod: 'cash' })
    const open = await prisma.order.create({ data: { conceptId: conceptA, source: 'servd', totalCents: 15_000 } })
    await redeemGiftCard({ code: c.code, orderId: open.id })
    // A card whose sale never reached the books.
    const legacy = await prisma.giftCard.create({ data: { tenantId: tenantA, code: `GS-LG2-${RUN}`.toUpperCase(), issuedAmountCents: 25_000, balanceCents: 25_000 } })

    const r = await call('finA', 'GET', '/gift-cards/reconcile')
    expect(r.statusCode, r.body).toBe(200)
    const companies = r.json().companies as Array<{ tenantId: string; differenceCents: number; unexplainedCents: number; awaitingSale: { cents: number; items: Array<{ orderId: string }> }; issueNotBooked: { cents: number; items: Array<{ id: string; code: string }> }; ledgerCents: number; expectedCents: number }>
    expect(companies.map((x) => x.tenantId)).toEqual([tenantA])
    const a = companies[0]!
    expect(a.awaitingSale.items.map((i) => i.orderId)).toContain(open.id)
    expect(a.issueNotBooked.items.map((i) => i.id)).toContain(legacy.id)
    expect(a.issueNotBooked.items.find((i) => i.id === legacy.id)!.code.startsWith('••••')).toBe(true)
    expect(a.differenceCents).toBe(-a.issueNotBooked.cents)
    expect(a.unexplainedCents).toBe(0)

    expect((await call('finA', 'POST', `/gift-cards/${legacy.id}/book-issue`, { paymentMethod: 'cash' })).statusCode).toBe(200)
    const after = (await call('mgrA', 'GET', '/gift-cards/reconcile')).json().companies[0] as typeof a
    expect(after.differenceCents).toBe(0)
    expect(after.ledgerCents).toBe(after.expectedCents)

    const b = (await call('mgrB', 'GET', '/gift-cards/reconcile')).json().companies as Array<{ tenantId: string }>
    expect(b.map((x) => x.tenantId)).toEqual([tenantB])
  })
})
