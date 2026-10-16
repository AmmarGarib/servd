// Payment reference # + Bank deposit on gift-card sales and wallet top-ups
// (owner, 2026-10-14).
//
//   POST /gift-cards, POST /gift-cards/:id/book-issue, POST /wallet/topup,
//   POST /wallet/bulk-topup:
//     • methods are cash · bank transfer · BANK DEPOSIT · cheque (card is
//       the till's only since 2026-10-16 — 400 at the route);
//       a bank deposit lands in the named bank of the DOCUMENT's company
//       (the card's / the wallet's), another company's bank is 422;
//     • the payment reference # is REQUIRED on every method, cash included
//       (422 PAYMENT_REFERENCE_REQUIRED, nothing saved, nothing booked);
//     • it is stored (GiftCard.paymentRef, WalletTransaction.method +
//       paymentRef) and written into the entry's description and the money
//       line's memo — journal_entries.reference stays the dedupe key;
//     • a reference used before SAVES and comes back as
//       `referenceUsedBefore` — this company's rows only, never B's;
//     • promotional cards and goodwill credits take no reference; the void
//       refund keeps its own list (no bank deposit paid out); a bulk paid
//       top-up applies one reference to the whole batch.
//
// Two companies throughout. Requires a disposable database (DATABASE_URL must
// contain "test").
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import bcrypt from 'bcryptjs'
import type { UserRole } from '@prisma/client'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { issueStaffSession } from '../src/modules/auth/service.js'
import { AppError } from '../src/lib/errors.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { linkBankLedgerAccount, RECEIPT_METHODS } from '../src/lib/bankAccounts.js'
import { giftCardRoutes } from '../src/modules/giftCards/routes.js'
import { walletRoutes } from '../src/modules/wallet/routes.js'
import { topUpWallet } from '../src/modules/wallet/service.js'

const RUN = Date.now().toString(36)
let app: FastifyInstance
let tenantA: string, tenantB: string
let conceptA: string, conceptB: string
let bankA1: string, bankA2: string, bankA2Code: string, bankB: string
const tokens: Record<string, string> = {}

async function mkUser(key: string, role: string, tenantId: string) {
  const u = await prisma.user.create({
    data: {
      name: `${key} person`, email: `${key}.${RUN}@payrefs.test`, password: await bcrypt.hash('x-Password-1', 4),
      role: role as UserRole, isActive: true, accountStatus: 'active', tenantId,
    },
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } })
  tokens[key] = `Bearer ${(issueStaffSession(u) as { accessToken: string }).accessToken}`
}
const call = (who: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url: `/api/v1${url}`, headers: { authorization: tokens[who]! }, ...(payload !== undefined && { payload: payload as object }) })

let seq = 0
/** A customer who ordered at each of `conceptIds` (so they are that company's customer). */
async function mkCustomer(conceptIds: string[]) {
  seq += 1
  const c = await prisma.customer.create({
    data: { name: `Payer ${seq}`, email: `pr-${RUN}-${seq}@example.com`, phone: `+92312${String(Date.now()).slice(-3)}${String(seq).padStart(4, '0')}` },
  })
  for (const conceptId of conceptIds) {
    await prisma.order.create({
      data: { conceptId, customerId: c.id, source: 'servd', status: 'completed', totalCents: 1_000, completedAt: new Date(), items: { create: [{ name: 'Water', quantity: 1, unitPriceCents: 1_000 }] } },
    })
  }
  return c.id
}

async function entryOf(tenantId: string, reference: string) {
  return prisma.journalEntry.findFirst({
    where: { tenantId, reference },
    include: { lines: { include: { account: { select: { code: true, tenantId: true } } } } },
  })
}
const uniq = (tag: string) => `${tag}-${RUN}-${++seq}`

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'Refs A', slug: `pr-a-${RUN}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'Refs B', slug: `pr-b-${RUN}` } })).id
  for (const t of [tenantA, tenantB]) await ensureChartOfAccounts(t)
  conceptA = (await prisma.concept.create({ data: { name: 'Stackd', slug: `stackd-pr-${RUN}`, type: 'restaurant', tenantId: tenantA } })).id
  conceptB = (await prisma.concept.create({ data: { name: 'Flipd', slug: `flipd-pr-${RUN}`, type: 'restaurant', tenantId: tenantB } })).id
  // A has two banks (a pick is required), B has one.
  bankA1 = (await prisma.bankAccount.create({ data: { tenantId: tenantA, name: 'HBL Ops', accountCode: '1020' } })).id
  bankA2Code = await linkBankLedgerAccount(tenantA, 'Meezan Collections')
  bankA2 = (await prisma.bankAccount.create({ data: { tenantId: tenantA, name: 'Meezan Collections', accountCode: bankA2Code } })).id
  bankB = (await prisma.bankAccount.create({ data: { tenantId: tenantB, name: 'MCB Ops', accountCode: '1020' } })).id

  await mkUser('mgrA', 'manager', tenantA)
  await mkUser('finA', 'finance', tenantA)
  await mkUser('mgrB', 'manager', tenantB)

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(async (api) => {
    await api.register(giftCardRoutes, { prefix: '/gift-cards' })
    await api.register(walletRoutes, { prefix: '/wallet' })
  }, { prefix: '/api/v1' })
  await app.ready()
}, 120_000)

afterAll(async () => {
  await app?.close()
})

// ─── Gift cards ──────────────────────────────────────────────────────────────

describe('gift card sale: bank deposit + payment reference #', () => {
  it("a bank deposit lands on A's named bank; the reference is stored and in the entry's description and money memo (not its dedupe key)", async () => {
    const ref = uniq('DEP')
    const r = await call('finA', 'POST', '/gift-cards', { issuedAmountCents: 60_000, paymentMethod: 'bank_deposit', paymentRef: `  ${ref} `, bankAccountId: bankA2 })
    expect(r.statusCode, r.body).toBe(201)
    expect(r.json().referenceUsedBefore).toEqual([])
    const card = await prisma.giftCard.findUniqueOrThrow({ where: { id: r.json().id } })
    expect(card).toMatchObject({ tenantId: tenantA, paymentMethod: 'bank_deposit', paymentRef: ref, bankAccountId: bankA2 })

    const je = (await entryOf(tenantA, `giftcard.issue:${card.id}`))!
    expect(je).not.toBeNull()
    expect(je.reference).toBe(`giftcard.issue:${card.id}`)
    expect(je.description).toContain(`bank deposit, ref ${ref}`)
    const money = je.lines.find((l) => l.type === 'debit')!
    expect([money.account.code, Number(money.amountCents)]).toEqual([bankA2Code, 60_000])
    expect(money.memo).toContain(`bank deposit, ref ${ref}`)
    expect(je.lines.every((l) => l.account.tenantId === tenantA)).toBe(true)
  })

  it("B's bank is 422 for A's card — no card, no entry", async () => {
    const before = await prisma.giftCard.count({ where: { tenantId: tenantA } })
    const r = await call('finA', 'POST', '/gift-cards', { paymentMethod: 'bank_deposit', paymentRef: uniq('DEP'), bankAccountId: bankB, issuedAmountCents: 20_000 })
    expect(r.statusCode).toBe(422)
    expect(r.json().error.code).toBe('BANK_ACCOUNT_NOT_IN_COMPANY')
    expect(await prisma.giftCard.count({ where: { tenantId: tenantA } })).toBe(before)
  })

  it('A has two banks: a bank deposit with none named is 422 BANK_ACCOUNT_REQUIRED', async () => {
    const r = await call('finA', 'POST', '/gift-cards', { paymentMethod: 'bank_deposit', paymentRef: uniq('DEP'), issuedAmountCents: 20_000 })
    expect(r.json().error.code).toBe('BANK_ACCOUNT_REQUIRED')
  })

  it('a missing or blank reference is 422 on EVERY method, cash included — nothing saved', async () => {
    const before = await prisma.giftCard.count({ where: { tenantId: tenantA } })
    for (const method of RECEIPT_METHODS) {
      const bank = method === 'bank_transfer' || method === 'bank_deposit' || method === 'cheque' ? { bankAccountId: bankA1 } : {}
      for (const ref of [undefined, '', '   ']) {
        const r = await call('finA', 'POST', '/gift-cards', { issuedAmountCents: 20_000, paymentMethod: method, ...bank, ...(ref !== undefined && { paymentRef: ref }) })
        expect([method, r.statusCode, r.json().error?.code]).toEqual([method, 422, 'PAYMENT_REFERENCE_REQUIRED'])
      }
    }
    expect(await prisma.giftCard.count({ where: { tenantId: tenantA } })).toBe(before)
  })

  it('every receipt method sells a card with its reference (cheque into a bank, cash to 1010)', async () => {
    const expectCode: Record<string, string> = { cash: '1010', bank_transfer: '1020', bank_deposit: '1020', cheque: '1020' }
    for (const method of RECEIPT_METHODS) {
      const bank = ['bank_transfer', 'bank_deposit', 'cheque'].includes(method) ? { bankAccountId: bankA1 } : {}
      const ref = uniq(method.toUpperCase())
      const r = await call('mgrA', 'POST', '/gift-cards', { issuedAmountCents: 15_000, paymentMethod: method, paymentRef: ref, ...bank })
      expect(r.statusCode, r.body).toBe(201)
      const je = (await entryOf(tenantA, `giftcard.issue:${r.json().id}`))!
      const money = je.lines.find((l) => l.type === 'debit')!
      expect([method, money.account.code]).toEqual([method, expectCode[method]])
      expect(money.memo).toContain(`ref ${ref}`)
      expect(je.description).toContain(`ref ${ref}`)
    }
  })

  it('a reused reference SAVES and warns with the earlier use; B\'s same reference never shows in A\'s warning', async () => {
    const ref = uniq('SHARED')
    // B uses it first — B's own business.
    const b1 = await call('mgrB', 'POST', '/gift-cards', { issuedAmountCents: 20_000, paymentMethod: 'cash', paymentRef: ref })
    expect(b1.statusCode, b1.body).toBe(201)
    expect(b1.json().referenceUsedBefore).toEqual([])

    // A's first use: nothing of A's before it, and B's card is NOT listed.
    const a1 = await call('finA', 'POST', '/gift-cards', { issuedAmountCents: 20_000, paymentMethod: 'cash', paymentRef: ref })
    expect(a1.statusCode, a1.body).toBe(201)
    expect(a1.json().referenceUsedBefore).toEqual([])

    // A again (any case): saved, and warned about A's first card only.
    const a2 = await call('finA', 'POST', '/gift-cards', { issuedAmountCents: 20_000, paymentMethod: 'cheque', bankAccountId: bankA1, paymentRef: ref.toLowerCase() })
    expect(a2.statusCode, a2.body).toBe(201)
    const uses = a2.json().referenceUsedBefore as Array<{ kind: string; id: string; label: string }>
    expect(uses.map((u) => [u.kind, u.id])).toEqual([['gift_card', a1.json().id]])
    expect(uses.some((u) => u.id === b1.json().id)).toBe(false)
    // The label shows the last 4 of the code only.
    expect(uses[0]!.label).toContain('••••')
    expect(uses[0]!.label).not.toContain(a1.json().code)
    expect(await prisma.giftCard.count({ where: { tenantId: tenantA, paymentRef: { equals: ref, mode: 'insensitive' } } })).toBe(2)

    // B again: warned about B's card only.
    const b2 = await call('mgrB', 'POST', '/gift-cards', { issuedAmountCents: 20_000, paymentMethod: 'cash', paymentRef: ref })
    expect((b2.json().referenceUsedBefore as Array<{ id: string }>).map((u) => u.id)).toEqual([b1.json().id])
  })

  it('a promotional card takes no reference (PROMO_CARD_NOT_PAID); without one it is issued with none', async () => {
    const r = await call('mgrA', 'POST', '/gift-cards', { issuedAmountCents: 20_000, kind: 'promotional', reason: 'Influencer visit', paymentRef: 'X-1' })
    expect([r.statusCode, r.json().error.code]).toEqual([422, 'PROMO_CARD_NOT_PAID'])
    const ok = await call('mgrA', 'POST', '/gift-cards', { issuedAmountCents: 20_000, kind: 'promotional', reason: 'Influencer visit' })
    expect(ok.statusCode, ok.body).toBe(201)
    expect(ok.json()).toMatchObject({ paymentMethod: null, paymentRef: null, referenceUsedBefore: [] })
  })

  it('the card history shows the reference; the void refund still refuses a bank deposit (money out keeps its own list)', async () => {
    const ref = uniq('HIST')
    const c = await call('mgrA', 'POST', '/gift-cards', { issuedAmountCents: 20_000, paymentMethod: 'cash', paymentRef: ref })
    const h = await call('finA', 'GET', `/gift-cards/${c.json().id}/redemptions`)
    expect(h.json().card).toMatchObject({ paymentMethod: 'cash', paymentRef: ref })
    expect((await call('mgrB', 'GET', `/gift-cards/${c.json().id}/redemptions`)).statusCode).toBe(404)

    const v = await call('mgrA', 'POST', `/gift-cards/${c.json().id}/void`, { reason: 'refund it', disposition: 'refund', refundMethod: 'bank_deposit', bankAccountId: bankA1 })
    expect(v.statusCode).toBe(400)
    const ok = await call('mgrA', 'POST', `/gift-cards/${c.json().id}/void`, { reason: 'refund it', disposition: 'refund', refundMethod: 'bank_transfer', bankAccountId: bankA1 })
    expect(ok.statusCode, ok.body).toBe(200)
  })
})

describe('gift card: booking a late sale needs the reference too', () => {
  it("B cannot book A's card (404); a missing reference is 422; a bank deposit books to A's bank with the reference", async () => {
    const legacy = await prisma.giftCard.create({ data: { tenantId: tenantA, code: `GS-PRF-${RUN}`.toUpperCase(), issuedAmountCents: 30_000, balanceCents: 30_000 } })
    const ref = uniq('LATE')
    expect((await call('mgrB', 'POST', `/gift-cards/${legacy.id}/book-issue`, { paymentMethod: 'bank_deposit', paymentRef: ref, bankAccountId: bankB })).statusCode).toBe(404)
    for (const method of RECEIPT_METHODS) {
      const r = await call('finA', 'POST', `/gift-cards/${legacy.id}/book-issue`, { paymentMethod: method })
      expect([method, r.statusCode, r.json().error?.code]).toEqual([method, 422, 'PAYMENT_REFERENCE_REQUIRED'])
    }
    expect(await entryOf(tenantA, `giftcard.issue:${legacy.id}`)).toBeNull()

    // A's own card, B's bank → 422.
    expect((await call('finA', 'POST', `/gift-cards/${legacy.id}/book-issue`, { paymentMethod: 'bank_deposit', paymentRef: ref, bankAccountId: bankB })).json().error.code).toBe('BANK_ACCOUNT_NOT_IN_COMPANY')

    const b = await call('finA', 'POST', `/gift-cards/${legacy.id}/book-issue`, { paymentMethod: 'bank_deposit', paymentRef: ref, bankAccountId: bankA2 })
    expect(b.statusCode, b.body).toBe(200)
    expect(b.json()).toMatchObject({ debitCode: bankA2Code, referenceUsedBefore: [] })
    const card = await prisma.giftCard.findUniqueOrThrow({ where: { id: legacy.id } })
    expect(card).toMatchObject({ paymentMethod: 'bank_deposit', paymentRef: ref, bankAccountId: bankA2 })
    const je = (await entryOf(tenantA, `giftcard.issue:${legacy.id}`))!
    expect(je.description).toContain(`bank deposit, ref ${ref}`)
    expect(je.lines.find((l) => l.type === 'debit')!.memo).toContain(`ref ${ref}`)
  })
})

// ─── Wallet top-ups ──────────────────────────────────────────────────────────

describe('wallet top-up: bank deposit + payment reference #', () => {
  it("a paid bank deposit lands on A's named bank; method and reference are stored and in the entry", async () => {
    const c = await mkCustomer([conceptA])
    const ref = uniq('WDEP')
    const r = await call('mgrA', 'POST', '/wallet/topup', { customerId: c, amountCents: 25_000, kind: 'paid', tender: 'bank_deposit', paymentRef: ref, bankAccountId: bankA2 })
    expect(r.statusCode, r.body).toBe(201)
    expect(r.json()).toMatchObject({ tenantId: tenantA, newBalance: 25_000, referenceUsedBefore: [] })
    const wt = await prisma.walletTransaction.findUniqueOrThrow({ where: { id: r.json().transactionId } })
    expect(wt).toMatchObject({ tenantId: tenantA, method: 'bank_deposit', paymentRef: ref, bankAccountId: bankA2 })

    const je = (await entryOf(tenantA, `wallet.topup:${wt.id}`))!
    expect(je.reference).toBe(`wallet.topup:${wt.id}`)
    expect(je.description).toContain(`bank deposit, ref ${ref}`)
    const money = je.lines.find((l) => l.type === 'debit')!
    expect([money.account.code, Number(money.amountCents)]).toEqual([bankA2Code, 25_000])
    expect(money.memo).toContain(`bank deposit, ref ${ref}`)
    expect(je.lines.every((l) => l.account.tenantId === tenantA)).toBe(true)
  })

  it("B's bank is 422 for A's top-up — nothing moved", async () => {
    const c = await mkCustomer([conceptA])
    const r = await call('mgrA', 'POST', '/wallet/topup', { customerId: c, amountCents: 5_000, kind: 'paid', tender: 'bank_deposit', paymentRef: uniq('WDEP'), bankAccountId: bankB })
    expect([r.statusCode, r.json().error.code]).toEqual([422, 'BANK_ACCOUNT_NOT_IN_COMPANY'])
    expect(await prisma.walletTransaction.count({ where: { customerId: c } })).toBe(0)
    expect(await prisma.customerWallet.count({ where: { customerId: c, balanceCents: { gt: 0 } } })).toBe(0)
  })

  it('a missing reference is 422 on every tender, cash included — nothing moved', async () => {
    const c = await mkCustomer([conceptA])
    for (const tender of RECEIPT_METHODS) {
      const bank = ['bank_transfer', 'bank_deposit', 'cheque'].includes(tender) ? { bankAccountId: bankA1 } : {}
      for (const ref of [undefined, '  ']) {
        const r = await call('mgrA', 'POST', '/wallet/topup', { customerId: c, amountCents: 5_000, kind: 'paid', tender, ...bank, ...(ref !== undefined && { paymentRef: ref }) })
        expect([tender, r.statusCode, r.json().error?.code]).toEqual([tender, 422, 'PAYMENT_REFERENCE_REQUIRED'])
      }
    }
    expect(await prisma.walletTransaction.count({ where: { customerId: c } })).toBe(0)
  })

  it('a goodwill credit takes no reference (400 at the route, 422 REFERENCE_ON_GOODWILL in the service) and stores no method', async () => {
    const c = await mkCustomer([conceptA])
    expect((await call('mgrA', 'POST', '/wallet/topup', { customerId: c, amountCents: 5_000, kind: 'goodwill', paymentRef: 'G-1' })).statusCode).toBe(400)
    await expect(topUpWallet({ tenantId: tenantA, customerId: c, amountCents: 5_000, kind: 'goodwill', paymentRef: 'G-1', description: 't', postedBy: 'test' }))
      .rejects.toMatchObject({ code: 'REFERENCE_ON_GOODWILL', statusCode: 422 })
    const ok = await call('mgrA', 'POST', '/wallet/topup', { customerId: c, amountCents: 5_000 })
    expect(ok.statusCode, ok.body).toBe(201)
    expect(ok.json().referenceUsedBefore).toEqual([])
    expect(await prisma.walletTransaction.findUniqueOrThrow({ where: { id: ok.json().transactionId } })).toMatchObject({ method: null, paymentRef: null })
  })

  it("a reused reference saves and warns — across screens (A's gift card), never B's rows", async () => {
    const ref = uniq('XREF')
    const card = await call('finA', 'POST', '/gift-cards', { issuedAmountCents: 20_000, paymentMethod: 'cash', paymentRef: ref })
    expect(card.statusCode, card.body).toBe(201)
    const cB = await mkCustomer([conceptB])
    const b = await call('mgrB', 'POST', '/wallet/topup', { customerId: cB, amountCents: 3_000, kind: 'paid', tender: 'cash', paymentRef: ref })
    expect(b.statusCode, b.body).toBe(201)
    // B's warning never shows A's gift card.
    expect(b.json().referenceUsedBefore).toEqual([])

    const cA = await mkCustomer([conceptA])
    const a = await call('mgrA', 'POST', '/wallet/topup', { customerId: cA, amountCents: 3_000, kind: 'paid', tender: 'cheque', paymentRef: ref, bankAccountId: bankA1 })
    expect(a.statusCode, a.body).toBe(201)
    const uses = a.json().referenceUsedBefore as Array<{ kind: string; id: string }>
    expect(uses.map((u) => [u.kind, u.id])).toEqual([['gift_card', card.json().id]])
    expect(uses.some((u) => u.id === b.json().transactionId)).toBe(false)
  })

  it("B cannot top up A's customer (404) even with a reference", async () => {
    const onlyA = await mkCustomer([conceptA])
    expect((await call('mgrB', 'POST', '/wallet/topup', { customerId: onlyA, amountCents: 1_000, kind: 'paid', tender: 'cash', paymentRef: uniq('W') })).statusCode).toBe(404)
  })
})

describe('bulk top-up: one reference for the batch', () => {
  it('a paid batch without a reference is refused whole; with one, every top-up stores it and the batch is not its own warning', async () => {
    const c1 = await mkCustomer([conceptA])
    const c2 = await mkCustomer([conceptA])
    const onlyB = await mkCustomer([conceptB])
    const none = await call('mgrA', 'POST', '/wallet/bulk-topup', { customerIds: [c1, c2], amountCents: 2_000, kind: 'paid', tender: 'bank_deposit', bankAccountId: bankA2 })
    expect([none.statusCode, none.json().error.code]).toEqual([422, 'PAYMENT_REFERENCE_REQUIRED'])
    expect(await prisma.walletTransaction.count({ where: { customerId: { in: [c1, c2] } } })).toBe(0)

    const ref = uniq('BATCH')
    const r = await call('mgrA', 'POST', '/wallet/bulk-topup', { customerIds: [c1, c2, onlyB], amountCents: 2_000, kind: 'paid', tender: 'bank_deposit', paymentRef: ref, bankAccountId: bankA2 })
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json()).toMatchObject({ success: 2, failed: [], referenceUsedBefore: [] })
    const rows = await prisma.walletTransaction.findMany({ where: { customerId: { in: [c1, c2, onlyB] } } })
    expect(rows).toHaveLength(2)
    expect(rows.every((w) => w.tenantId === tenantA && w.method === 'bank_deposit' && w.paymentRef === ref && w.bankAccountId === bankA2)).toBe(true)
    for (const w of rows) {
      const je = (await entryOf(tenantA, `wallet.topup:${w.id}`))!
      expect(je.lines.find((l) => l.type === 'debit')!.account.code).toBe(bankA2Code)
      expect(je.description).toContain(`ref ${ref}`)
    }

    // The same reference on a later batch: warned with the earlier rows.
    const again = await call('mgrA', 'POST', '/wallet/bulk-topup', { customerIds: [c1], amountCents: 1_000, kind: 'paid', tender: 'cash', paymentRef: ref })
    expect(again.statusCode, again.body).toBe(200)
    expect((again.json().referenceUsedBefore as Array<{ id: string }>).map((u) => u.id).sort()).toEqual(rows.map((w) => w.id).sort())
  })
})
