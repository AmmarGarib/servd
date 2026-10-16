// Finance audit 2026-10-17, group ar_ic (owner decisions 2026-10-16):
//
//   #24 Back-office receipts take bank transfer, bank deposit, cash or cheque
//       only — card is the till's (route 400; service 422 CARD_NOT_A_RECEIPT).
//   #25 Finance (with 'accounting') records PAID wallet top-ups, single and
//       bulk, and finds the customer through GET /wallet/customers?q= (active
//       company only); a goodwill credit stays a manager's (403
//       GOODWILL_MANAGERS_ONLY); without 'accounting' finance is refused.
//   #26 Finance (with 'accounting') settles value left on a VOIDED or EXPIRED
//       gift card; voiding a LIVE card stays with managers (403
//       VOID_NEEDS_MANAGER, card untouched). Company B gets 404 on A's card.
//   #37 An on-account client in credit (a statement pushed below zero by a
//       refund after it was paid) cannot be closed (409 CLIENT_IN_CREDIT);
//       the list shows creditCents. Company B gets 404.
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
import { giftCardRoutes } from '../src/modules/giftCards/routes.js'
import { issueGiftCard } from '../src/modules/giftCards/books.js'
import { walletRoutes } from '../src/modules/wallet/routes.js'
import { topUpWallet } from '../src/modules/wallet/service.js'
import { customerAccountRoutes } from '../src/modules/receivables/customerAccounts.js'

const RUN = Date.now().toString(36)
const CA = '/api/v1/accounting/customer-accounts'
let app: FastifyInstance
let tenantA: string, tenantB: string
let conceptA: string, conceptB: string
let bankA: string
const tokens: Record<string, string> = {}

async function mkUser(key: string, role: string, tenantId: string, extra: { moduleDeny?: string[] } = {}) {
  const u = await prisma.user.create({
    data: {
      name: `${key} person`, email: `${key}.${RUN}@aric.test`, password: await bcrypt.hash('x-Password-1', 4),
      role: role as UserRole, isActive: true, accountStatus: 'active', tenantId, moduleDeny: extra.moduleDeny ?? [],
    },
  })
  await prisma.tenantMember.create({ data: { tenantId, userId: u.id } })
  tokens[key] = `Bearer ${(issueStaffSession(u) as { accessToken: string }).accessToken}`
}
const call = (who: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url: url.startsWith('/api/') ? url : `/api/v1${url}`, headers: { authorization: tokens[who]! }, ...(payload !== undefined && { payload: payload as object }) })

let seq = 0
const uniq = (tag: string) => `${tag}-${RUN}-${++seq}`
async function mkCustomer(conceptId: string, name: string) {
  seq += 1
  const c = await prisma.customer.create({
    data: { name, email: `aric-${RUN}-${seq}@example.com`, phone: `+92313${String(Date.now()).slice(-3)}${String(seq).padStart(4, '0')}` },
  })
  await prisma.order.create({
    data: { conceptId, customerId: c.id, source: 'servd', status: 'completed', totalCents: 1_000, completedAt: new Date(), items: { create: [{ name: 'Water', quantity: 1, unitPriceCents: 1_000 }] } },
  })
  return c
}
async function entryOf(tenantId: string, reference: string) {
  return prisma.journalEntry.findFirst({
    where: { tenantId, reference },
    include: { lines: { include: { account: { select: { code: true } } } } },
  })
}

beforeAll(async () => {
  tenantA = (await prisma.tenant.create({ data: { name: 'ARIC A', slug: `aric-a-${RUN}` } })).id
  tenantB = (await prisma.tenant.create({ data: { name: 'ARIC B', slug: `aric-b-${RUN}` } })).id
  for (const t of [tenantA, tenantB]) await ensureChartOfAccounts(t)
  conceptA = (await prisma.concept.create({ data: { name: 'Stackd', slug: `stackd-aric-${RUN}`, type: 'restaurant', tenantId: tenantA } })).id
  conceptB = (await prisma.concept.create({ data: { name: 'Flipd', slug: `flipd-aric-${RUN}`, type: 'restaurant', tenantId: tenantB } })).id
  bankA = (await prisma.bankAccount.create({ data: { tenantId: tenantA, name: 'HBL Ops', accountCode: '1020' } })).id
  await prisma.bankAccount.create({ data: { tenantId: tenantB, name: 'MCB Ops', accountCode: '1020' } })

  await mkUser('mgrA', 'manager', tenantA)
  await mkUser('finA', 'finance', tenantA)
  await mkUser('finNoAcct', 'finance', tenantA, { moduleDeny: ['accounting'] })
  await mkUser('finB', 'finance', tenantB)
  await mkUser('ceoA', 'admin', tenantA)
  await mkUser('mktA', 'marketing', tenantA)

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(async (api) => {
    await api.register(giftCardRoutes, { prefix: '/gift-cards' })
    await api.register(walletRoutes, { prefix: '/wallet' })
    await api.register(customerAccountRoutes, { prefix: '/accounting/customer-accounts' })
  }, { prefix: '/api/v1' })
  await app.ready()
}, 120_000)

afterAll(async () => {
  await app?.close()
})

// ─── #24 No card on back-office receipts ─────────────────────────────────────

describe('#24 back-office receipts take no card', () => {
  it('gift-card sale and wallet top-up by card are refused at the route (400) — nothing saved, nothing booked', async () => {
    const cards = await prisma.giftCard.count({ where: { tenantId: tenantA } })
    const g = await call('finA', 'POST', '/gift-cards', { issuedAmountCents: 20_000, paymentMethod: 'card', paymentRef: uniq('APPR') })
    expect(g.statusCode, g.body).toBe(400)
    expect(await prisma.giftCard.count({ where: { tenantId: tenantA } })).toBe(cards)

    const cust = await mkCustomer(conceptA, `Card Payer ${RUN}`)
    const w = await call('mgrA', 'POST', '/wallet/topup', { customerId: cust.id, amountCents: 5_000, kind: 'paid', tender: 'card', paymentRef: uniq('APPR') })
    expect(w.statusCode, w.body).toBe(400)
    expect(await prisma.walletTransaction.count({ where: { customerId: cust.id } })).toBe(0)
  })

  it('the services refuse card too (422 CARD_NOT_A_RECEIPT), so no back-office path debits 1030', async () => {
    const cust = await mkCustomer(conceptA, `Svc Payer ${RUN}`)
    await expect(topUpWallet({
      tenantId: tenantA, customerId: cust.id, amountCents: 5_000, kind: 'paid', tender: 'card' as never,
      paymentRef: 'X-1', description: 'x', postedBy: 'test',
    })).rejects.toMatchObject({ code: 'CARD_NOT_A_RECEIPT', statusCode: 422 })
    await expect(issueGiftCard({
      tenantId: tenantA, kind: 'sold', issuedAmountCents: 10_000, paymentMethod: 'card' as never, paymentRef: 'X-2', issuedById: null,
    })).rejects.toMatchObject({ code: 'CARD_NOT_A_RECEIPT', statusCode: 422 })
    expect(await prisma.walletTransaction.count({ where: { customerId: cust.id } })).toBe(0)
  })
})

// ─── #25 Finance records paid wallet top-ups ─────────────────────────────────

describe('#25 finance records paid wallet top-ups', () => {
  it('finance finds A\'s customer (never B\'s), tops up paid by bank deposit into A\'s bank; B gets 404', async () => {
    const ca = await mkCustomer(conceptA, `Wallet Alpha ${RUN}`)
    const cb = await mkCustomer(conceptB, `Wallet Alpha ${RUN} B`)

    const found = await call('finA', 'GET', `/wallet/customers?q=${encodeURIComponent(`Wallet Alpha ${RUN}`)}`)
    expect(found.statusCode, found.body).toBe(200)
    const ids = (found.json().customers as Array<{ id: string }>).map((c) => c.id)
    expect(ids).toContain(ca.id)
    expect(ids).not.toContain(cb.id)
    const foundB = await call('finB', 'GET', `/wallet/customers?q=${encodeURIComponent(`Wallet Alpha ${RUN}`)}`)
    expect((foundB.json().customers as Array<{ id: string }>).map((c) => c.id)).toEqual([cb.id])
    expect((await call('finA', 'GET', '/wallet/customers?q=ab')).statusCode).toBe(400)

    const ref = uniq('DEP')
    const r = await call('finA', 'POST', '/wallet/topup', { customerId: ca.id, amountCents: 25_000, kind: 'paid', tender: 'bank_deposit', paymentRef: ref, bankAccountId: bankA })
    expect(r.statusCode, r.body).toBe(201)
    expect(r.json()).toMatchObject({ tenantId: tenantA, newBalance: 25_000 })
    const je = (await entryOf(tenantA, `wallet.topup:${r.json().transactionId}`))!
    expect(je.lines.find((l) => l.type === 'debit')!.account.code).toBe('1020')
    expect(je.lines.find((l) => l.type === 'credit')!.account.code).toBe('2050')
    const audit = await prisma.auditLog.findFirst({ where: { action: 'wallet.topup', entityId: r.json().transactionId } })
    expect(audit).toBeTruthy()

    // B's finance cannot credit A's customer (404, nothing moved).
    const foreign = await call('finB', 'POST', '/wallet/topup', { customerId: ca.id, amountCents: 1_000, kind: 'paid', tender: 'cash', paymentRef: uniq('C') })
    expect(foreign.statusCode).toBe(404)
    expect((await call('finB', 'GET', `/wallet/customers/${ca.id}`)).statusCode).toBe(404)
    // A's finance reads the wallet.
    const read = await call('finA', 'GET', `/wallet/customers/${ca.id}`)
    expect(read.statusCode, read.body).toBe(200)
    expect(read.json().walletBalance).toBe(25_000)
  })

  it('a goodwill credit stays a manager\'s (finance 403 GOODWILL_MANAGERS_ONLY, single and bulk); managers still give it', async () => {
    const c = await mkCustomer(conceptA, `Goodwill ${RUN}`)
    const g = await call('finA', 'POST', '/wallet/topup', { customerId: c.id, amountCents: 1_000, kind: 'goodwill' })
    expect(g.statusCode).toBe(403)
    expect(g.json().error.code).toBe('GOODWILL_MANAGERS_ONLY')
    const gb = await call('finA', 'POST', '/wallet/bulk-topup', { customerIds: [c.id], amountCents: 1_000, kind: 'goodwill' })
    expect(gb.statusCode).toBe(403)
    expect(await prisma.walletTransaction.count({ where: { customerId: c.id } })).toBe(0)
    const m = await call('mgrA', 'POST', '/wallet/topup', { customerId: c.id, amountCents: 1_000, kind: 'goodwill' })
    expect(m.statusCode, m.body).toBe(201)
  })

  it('finance bulk paid top-up credits A\'s customers only; finance without accounting and other roles are refused', async () => {
    const a1 = await mkCustomer(conceptA, `Bulk One ${RUN}`)
    const b1 = await mkCustomer(conceptB, `Bulk Two ${RUN}`)
    const r = await call('finA', 'POST', '/wallet/bulk-topup', { customerIds: [a1.id, b1.id], amountCents: 2_000, kind: 'paid', tender: 'cash', paymentRef: uniq('BULK') })
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json()).toMatchObject({ success: 1, total: 2 })
    expect(await prisma.walletTransaction.count({ where: { customerId: b1.id } })).toBe(0)

    const denied = await call('finNoAcct', 'POST', '/wallet/topup', { customerId: a1.id, amountCents: 1_000, kind: 'paid', tender: 'cash', paymentRef: uniq('C') })
    expect(denied.statusCode).toBe(403)
    expect((await call('finNoAcct', 'GET', `/wallet/customers?q=${encodeURIComponent('Bulk One')}`)).statusCode).toBe(403)
    expect((await call('mktA', 'POST', '/wallet/topup', { customerId: a1.id, amountCents: 1_000, kind: 'paid', tender: 'cash', paymentRef: uniq('C') })).statusCode).toBe(403)
  })
})

// ─── #26 Finance settles value on voided / expired gift cards ────────────────

describe('#26 finance settles voided / expired gift cards; managers void live ones', () => {
  async function soldCard(amount = 30_000) {
    const r = await call('mgrA', 'POST', '/gift-cards', { issuedAmountCents: amount, paymentMethod: 'cash', paymentRef: uniq('GC') })
    expect(r.statusCode, r.body).toBe(201)
    return r.json() as { id: string; code: string }
  }

  it('finance cannot void a LIVE card (403 VOID_NEEDS_MANAGER, card untouched); a manager can', async () => {
    const card = await soldCard()
    const r = await call('finA', 'POST', `/gift-cards/${card.id}/void`, { reason: 'customer asked', disposition: 'refund', refundMethod: 'cash' })
    expect(r.statusCode, r.body).toBe(403)
    expect(r.json().error.code).toBe('VOID_NEEDS_MANAGER')
    expect(await prisma.giftCard.findUniqueOrThrow({ where: { id: card.id } })).toMatchObject({ status: 'active', balanceCents: 30_000 })
    expect(await entryOf(tenantA, `giftcard.void:${card.id}`)).toBeNull()
    const m = await call('mgrA', 'POST', `/gift-cards/${card.id}/void`, { reason: 'customer asked', disposition: 'refund', refundMethod: 'cash' })
    expect(m.statusCode, m.body).toBe(200)
  })

  it('finance settles value a refund put back on a VOIDED card (Dr 2080 / Cr 1010); B gets 404', async () => {
    const card = await soldCard()
    // A void that left value behind (a refund re-credited it afterwards).
    await prisma.giftCard.update({ where: { id: card.id }, data: { status: 'voided', voidedAt: new Date(), balanceCents: 4_000 } })
    const foreign = await call('finB', 'POST', `/gift-cards/${card.id}/void`, { reason: 'settle it', disposition: 'refund', refundMethod: 'cash' })
    expect(foreign.statusCode).toBe(404)

    const r = await call('finA', 'POST', `/gift-cards/${card.id}/void`, { reason: 'settle refunded value', disposition: 'refund', refundMethod: 'cash' })
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json()).toMatchObject({ postedCents: 4_000, creditCode: '1010' })
    expect(await prisma.giftCard.findUniqueOrThrow({ where: { id: card.id } })).toMatchObject({ status: 'voided', balanceCents: 0 })
    const je = (await entryOf(tenantA, `giftcard.void:${card.id}`))!
    expect(je.lines.map((l) => [l.type, l.account.code, Number(l.amountCents)]).sort()).toEqual([['credit', '1010', 4_000], ['debit', '2080', 4_000]])
    const audit = await prisma.auditLog.findFirst({ where: { action: 'giftcard.void', entityId: card.id } })
    expect((audit!.metadata as { actorRole?: string }).actorRole).toBe('finance')
  })

  it('finance settles an EXPIRED card holding value as payment not received; never forfeits a sold card; without accounting 403', async () => {
    const card = await soldCard(12_000)
    await prisma.giftCard.update({ where: { id: card.id }, data: { status: 'expired', expiredAt: new Date(), breakageAt: new Date(), balanceCents: 2_500 } })
    expect((await call('finNoAcct', 'POST', `/gift-cards/${card.id}/void`, { reason: 'settle it', disposition: 'payment_not_received' })).statusCode).toBe(403)
    const forfeit = await call('finA', 'POST', `/gift-cards/${card.id}/void`, { reason: 'keep it', disposition: 'forfeit' })
    expect(forfeit.statusCode).toBe(403)
    expect(forfeit.json().error.code).toBe('FORFEIT_NEEDS_CEO')
    const r = await call('finA', 'POST', `/gift-cards/${card.id}/void`, { reason: 'transfer bounced', disposition: 'payment_not_received' })
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json()).toMatchObject({ postedCents: 2_500, creditCode: '1010', status: 'voided', balanceCents: 0 })
  })
})

// ─── #37 On-account client in credit cannot be closed ────────────────────────

describe('#37 an on-account client in credit cannot be closed', () => {
  it('409 CLIENT_IN_CREDIT while a paid statement is below zero; the list shows creditCents; B gets 404; closes once refunded', async () => {
    const created = await call('finA', 'POST', CA, { legalName: `Credit Client ${RUN}`, creditLimitCents: 100_000_00 })
    expect(created.statusCode, created.body).toBe(201)
    const id = created.json().id as string
    // A statement paid in full, then a refund credited 2,000 after payment.
    const st = await prisma.receivableInvoice.create({
      data: {
        tenantId: tenantA, number: `AR-ST-${RUN}`, customerName: `Credit Client ${RUN}`, issueDate: new Date(), dueDate: new Date(),
        description: 'Statement', amountCents: 10_000, paidCents: 10_000, creditedCents: 2_000, status: 'paid', kind: 'statement',
        customerAccountId: id, periodFrom: new Date(Date.now() - 30 * 86_400_000), periodTo: new Date(),
      },
    })

    const list = (await call('finA', 'GET', CA)).json() as { items: Array<{ id: string; creditCents: number; exposureCents: number }> }
    expect(list.items.find((r) => r.id === id)).toMatchObject({ creditCents: 2_000, exposureCents: 0 })
    expect((await call('finB', 'PATCH', `${CA}/${id}`, { status: 'closed' })).statusCode).toBe(404)

    const refused = await call('finA', 'PATCH', `${CA}/${id}`, { status: 'closed', reason: 'contract ended' })
    expect(refused.statusCode, refused.body).toBe(409)
    expect(refused.json().error.code).toBe('CLIENT_IN_CREDIT')
    expect((await prisma.customerAccount.findUniqueOrThrow({ where: { id } })).status).not.toBe('closed')

    // Paid back (the refund row lowers paidCents) → nothing owed either way → it closes.
    await prisma.receivableInvoice.update({ where: { id: st.id }, data: { paidCents: 8_000 } })
    const closed = await call('finA', 'PATCH', `${CA}/${id}`, { status: 'closed', reason: 'contract ended' })
    expect(closed.statusCode, closed.body).toBe(200)
    expect(closed.json()).toMatchObject({ status: 'closed', creditCents: 0 })
  })
})
