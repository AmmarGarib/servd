// On account at the till (pos/onAccountTender.ts + pos/onAccountRoutes.ts).
//
//   - two companies: B's cashier gets 404 on A's order (lookup, quote,
//     charge); A's card presented on B's order is ON_ACCOUNT_CARD_UNKNOWN; the
//     charge, the payment row and the fiscal document carry A's company;
//   - the charge completes the sale ONCE: exactly one sale FiscalDocument, at
//     the cash rate (a bill rung at the card rate is re-priced), with the
//     client as the buyer;
//   - no manager PIN; a replay returns the same payment; the same key with
//     another card is IDEMPOTENCY_KEY_REUSED;
//   - two concurrent charges near the limit: exactly one 409 OVER_LIMIT;
//   - every refusal writes nothing: TILL_CLEARING_NOT_SPLIT, NOT_ACTIVE
//     (pending, suspended), BRAND_NOT_ALLOWED, OVERDUE, REFERENCE_REQUIRED,
//     NOT_HERE (delivery / pickup), WHOLE_BILL (tip, part-paid, promo),
//     ON_ACCOUNT_RATE (a bill that cannot be priced at the cash rate);
//   - a revoked card is refused and flagged once per card per Karachi day;
//   - the card code never reaches an audit row or a response.
//
// Requires a disposable database (DATABASE_URL must contain "test").
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { randomUUID } from 'node:crypto'
import type { CustomerAccount, Prisma } from '@prisma/client'
import { AppError, errorResponse } from '../src/lib/errors.js'
import { posRoutes } from '../src/modules/pos/routes.js'
import posOnAccountRoutes from '../src/modules/pos/onAccountRoutes.js'
import { registerConnectorPlugins } from '../src/modules/connectors/index.js'
import { setFiscalKicker } from '../src/connectors/fiscal/outbox.js'
import { newCardCode, normalizeCardCode } from '../src/lib/onAccountCard.js'
import { tillClearingCutoverKey } from '../src/modules/accounting/tillClearingCode.js'
import {
  prisma, mkCompany, mkUser, caller, setConnector, resetConnectorCache, openDrawer, ringKheer, containsDeep,
  type Company, type Who,
} from './connectorsFixtures.js'

let app: FastifyInstance
let A: Company, B: Company
let cashierA: Who, cashierA2: Who, cashierB: Who, adminA: Who
let drawerA: string, drawerA2: string, drawerB: string
let seq = 0
const CASH_TOTAL = 126_500 // 2 × Kheer at the cash rate (15 %)

async function build(): Promise<FastifyInstance> {
  const a = Fastify()
  a.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await a.register(posRoutes, { prefix: '/pos' })
  await a.register(posOnAccountRoutes, { prefix: '/pos' })
  await registerConnectorPlugins(a)
  await a.ready()
  return a
}

const cutOver = (tenantId: string) =>
  prisma.setting.upsert({
    where: { key: tillClearingCutoverKey(tenantId) },
    create: { key: tillClearingCutoverKey(tenantId), value: new Date().toISOString() },
    update: {},
  })

async function mkClient(co: Company, extra: Partial<Prisma.CustomerAccountUncheckedCreateInput> = {}): Promise<{ account: CustomerAccount; code: string; cardId: string }> {
  seq++
  const account = await prisma.customerAccount.create({
    data: {
      tenantId: co.tenantId, number: `OA-${String(seq).padStart(4, '0')}`, legalName: `Client ${seq} (Pvt) Ltd`, ntn: `76543${seq}-0`,
      creditLimitCents: 1_000_000, status: 'active', createdById: adminA.id, ...extra,
    },
  })
  const { code, hash, hint } = newCardCode()
  const card = await prisma.customerAccountCard.create({
    data: { tenantId: co.tenantId, accountId: account.id, label: 'Reception', tokenHash: hash, tokenHint: hint, issuedById: adminA.id },
  })
  return { account, code, cardId: card.id }
}

const charge = (who: Who, orderId: string, body: Record<string, unknown>) =>
  caller(app)(who, 'POST', `/pos/orders/${orderId}/on-account`, { idempotencyKey: `oa-${randomUUID()}`, ...body })

/** Nothing of a refused charge was written: no payment, no charge row, the order still open. */
async function nothingWritten(orderId: string): Promise<void> {
  expect(await prisma.payment.count({ where: { orderId } })).toBe(0)
  expect(await prisma.customerAccountCharge.count({ where: { orderId } })).toBe(0)
  expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).not.toBe('completed')
  expect(await prisma.fiscalDocument.count({ where: { orderId } })).toBe(0)
}

async function rawOrder(co: Company, data: Partial<Prisma.OrderUncheckedCreateInput>): Promise<string> {
  const o = await prisma.order.create({
    data: {
      conceptId: co.conceptId, locationId: co.locationId, source: 'pos', fulfilmentType: 'takeout', status: 'received',
      totalCents: CASH_TOTAL, taxCents: 16_500, taxRatePct: 15,
      items: { create: [{ menuItemId: co.items.kheer, name: 'Kheer', quantity: 2, unitPriceCents: 55_000 }] },
      ...data,
    },
  })
  return o.id
}

beforeAll(async () => {
  A = await mkCompany('oat-a', { srbPosId: 7301 })
  B = await mkCompany('oat-b', { srbPosId: 7302 })
  adminA = await mkUser('oat-admin-a', 'admin', A.tenantId)
  cashierA = await mkUser('oat-cashier-a', 'cashier', A.tenantId)
  cashierA2 = await mkUser('oat-cashier-a2', 'cashier', A.tenantId)
  cashierB = await mkUser('oat-cashier-b', 'cashier', B.tenantId)
  drawerA = await openDrawer(A, cashierA)
  drawerA2 = await openDrawer(A, cashierA2)
  drawerB = await openDrawer(B, cashierB)
  await cutOver(A.tenantId)
  await cutOver(B.tenantId)
  setFiscalKicker(async () => {})
  app = await build()
}, 60_000)

afterAll(async () => {
  setFiscalKicker(null)
  resetConnectorCache()
  await app?.close()
})

beforeEach(async () => {
  await setConnector(A.tenantId, 'fiscal', { driver: 'test', enabled: true, settings: { test: { scenario: 'ok' }, syncTimeoutMs: 1000, syncAtTill: true, fiscalReportingRequired: true } })
  await setConnector(B.tenantId, 'fiscal', { driver: 'test', enabled: true, settings: { test: { scenario: 'ok' }, syncTimeoutMs: 1000, syncAtTill: true, fiscalReportingRequired: true } })
})

describe('the tender is shown only where it can work', () => {
  it('enabled = an active client AND the till-clearing cut-over', async () => {
    const C = await mkCompany('oat-c')
    const cashierC = await mkUser('oat-cashier-c', 'cashier', C.tenantId)
    const o = await ringKheer(app, cashierC, C)
    const enabled = async () => (await caller(app)(cashierC, 'GET', `/pos/on-account/enabled?orderId=${o.id}`)).json().enabled
    expect(await enabled()).toBe(false)
    await mkClient(C)
    expect(await enabled()).toBe(false) // not cut over yet
    await cutOver(C.tenantId)
    expect(await enabled()).toBe(true)
    // Another company's cashier: 404, not "false".
    expect((await caller(app)(cashierB, 'GET', `/pos/on-account/enabled?orderId=${o.id}`)).statusCode).toBe(404)
  })
})

describe('company separation', () => {
  it("B's cashier gets 404 on A's order; A's card on B's order is unknown", async () => {
    const { code } = await mkClient(A)
    const oA = await ringKheer(app, cashierA, A)
    expect((await caller(app)(cashierB, 'POST', '/pos/on-account/lookup', { orderId: oA.id, code })).statusCode).toBe(404)
    expect((await caller(app)(cashierB, 'GET', `/pos/orders/${oA.id}/on-account/quote`)).statusCode).toBe(404)
    expect((await charge(cashierB, oA.id, { shiftId: drawerB, code })).statusCode).toBe(404)
    await nothingWritten(oA.id)

    const oB = await ringKheer(app, cashierB, B)
    const look = await caller(app)(cashierB, 'POST', '/pos/on-account/lookup', { orderId: oB.id, code })
    expect(look.statusCode).toBe(404)
    expect(look.json().error.code).toBe('ON_ACCOUNT_CARD_UNKNOWN')
    const r = await charge(cashierB, oB.id, { shiftId: drawerB, code })
    expect(r.statusCode).toBe(404)
    expect(r.json().error.code).toBe('ON_ACCOUNT_CARD_UNKNOWN')
    await nothingWritten(oB.id)
    // A drawer of the other company is refused too.
    expect((await charge(cashierA, oA.id, { shiftId: drawerB, code })).json().error.code).toBe('SHIFT_NOT_IN_COMPANY')
  })
})

describe('lookup', () => {
  it('names the client, its credit, the cash-rate quote and nothing blocking — never the code', async () => {
    const { account, code, cardId } = await mkClient(A, { creditLimitCents: 500_000, requiresReference: true })
    const o = await ringKheer(app, cashierA, A)
    const r = await caller(app)(cashierA, 'POST', '/pos/on-account/lookup', { orderId: o.id, code: code.toLowerCase().replace(/-/g, ' ') })
    expect(r.statusCode, r.body).toBe(200)
    const body = r.json()
    expect(body.account).toMatchObject({ id: account.id, number: account.number, limitCents: 500_000, exposureCents: 0, availableCents: 500_000, requiresReference: true })
    expect(body.card).toMatchObject({ id: cardId, label: 'Reception' })
    expect(body.card.hint).toHaveLength(4)
    expect(body.quote).toMatchObject({ taxRatePct: 15, totalCents: CASH_TOTAL, dueCents: CASH_TOTAL })
    expect(body.blocked).toBeNull()
    expect(containsDeep(body, code)).toBe(false)
    expect(containsDeep(body, normalizeCardCode(code)!)).toBe(false)
  })

  it('shows what would block the charge (over the limit) without writing anything', async () => {
    const { code } = await mkClient(A, { creditLimitCents: 100_000 })
    const o = await ringKheer(app, cashierA, A)
    const body = (await caller(app)(cashierA, 'POST', '/pos/on-account/lookup', { orderId: o.id, code })).json()
    expect(body.blocked).toMatchObject({ code: 'ON_ACCOUNT_OVER_LIMIT', details: { limitCents: 100_000, billCents: CASH_TOTAL } })
    await nothingWritten(o.id)
  })

  it('the quote route prices at the cash rate', async () => {
    const r = await caller(app)(cashierA, 'POST', '/pos/orders', {
      conceptId: A.conceptId, paymentMethod: 'card', items: [{ menuItemId: A.items.kheer, name: 'Kheer', quantity: 2, unitPriceCents: 55_000, modifiers: [] }],
    })
    expect(r.statusCode, r.body).toBe(201)
    const q = (await caller(app)(cashierA, 'GET', `/pos/orders/${r.json().id}/on-account/quote`)).json()
    expect(q).toMatchObject({ tender: 'cash', taxRatePct: 15, totalCents: CASH_TOTAL })
  })
})

describe('the charge', () => {
  it('completes the sale once: one sale document at the cash rate, the client as buyer, all in A', async () => {
    const { account, code, cardId } = await mkClient(A)
    // Rung at the CARD rate — the charge re-prices it to cash.
    const rung = await caller(app)(cashierA, 'POST', '/pos/orders', {
      conceptId: A.conceptId, paymentMethod: 'card', items: [{ menuItemId: A.items.kheer, name: 'Kheer', quantity: 2, unitPriceCents: 55_000, modifiers: [] }],
    })
    const orderId = rung.json().id as string
    expect(rung.json().totalCents).not.toBe(CASH_TOTAL)

    // No manager PIN anywhere.
    const r = await charge(cashierA, orderId, { shiftId: drawerA, code, reference: 'PO 4471' })
    expect(r.statusCode, r.body).toBe(201)
    const body = r.json()
    expect(body).toMatchObject({ orderCompleted: true, replayed: false })
    expect(body.payment).toMatchObject({ method: 'on_account', status: 'paid', amountCents: CASH_TOTAL, shiftId: drawerA, gatewayRef: account.number })
    expect(body.payment.gatewayMeta.onAccount).toMatchObject({ accountId: account.id, cardId, number: account.number, name: account.legalName, reference: 'PO 4471' })
    expect(body.charge).toMatchObject({ tenantId: A.tenantId, accountId: account.id, cardId, amountCents: CASH_TOTAL, taxCents: 16_500, reference: 'PO 4471', chargedById: cashierA.id })
    expect(body.fiscal).toMatchObject({ kind: 'sale' })
    expect(containsDeep(body, code)).toBe(false)

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } })
    expect(order).toMatchObject({ status: 'completed', taxRatePct: 15, totalCents: CASH_TOTAL })
    const docs = await prisma.fiscalDocument.findMany({ where: { orderId } })
    expect(docs).toHaveLength(1)
    expect(docs[0]).toMatchObject({ kind: 'sale', tenantId: A.tenantId, amountCents: CASH_TOTAL })
    const payload = docs[0]!.payload as { buyer: { legalName: string; ntn?: string } | null; totals: { taxRatePct: number }; payment: { mode: string; tenders: Array<{ method: string }> } }
    expect(payload.buyer).toMatchObject({ legalName: account.legalName, ntn: account.ntn })
    expect(payload.totals.taxRatePct).toBe(15)
    expect(payload.payment.mode).toBe('cash')
    expect(payload.payment.tenders.map((t) => t.method)).toEqual(['on_account'])
    expect((await prisma.customerAccountCard.findUniqueOrThrow({ where: { id: cardId } })).lastUsedAt).not.toBeNull()
    // B's books saw nothing.
    expect(await prisma.customerAccountCharge.count({ where: { tenantId: B.tenantId } })).toBe(0)
  })

  it('a replay returns the same payment; the same key with another card is refused', async () => {
    const { code } = await mkClient(A)
    const other = await mkClient(A)
    const o = await ringKheer(app, cashierA, A)
    const key = `oa-replay-${o.id}`
    const first = await charge(cashierA, o.id, { shiftId: drawerA, code, idempotencyKey: key })
    expect(first.statusCode, first.body).toBe(201)
    const again = await charge(cashierA, o.id, { shiftId: drawerA, code, idempotencyKey: key })
    expect(again.statusCode, again.body).toBe(201)
    expect(again.json()).toMatchObject({ replayed: true, orderCompleted: true, payment: { id: first.json().payment.id }, charge: { id: first.json().charge.id } })
    expect(await prisma.payment.count({ where: { orderId: o.id } })).toBe(1)
    expect(await prisma.fiscalDocument.count({ where: { orderId: o.id, kind: 'sale' } })).toBe(1)
    const reused = await charge(cashierA, o.id, { shiftId: drawerA, code: other.code, idempotencyKey: key })
    expect(reused.statusCode).toBe(409)
    expect(reused.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED')
    // A new key on a completed order: not open.
    expect((await charge(cashierA, o.id, { shiftId: drawerA, code })).json().error.code).toBe('ORDER_NOT_OPEN')
  })

  it("another cashier's drawer is refused (FOH-15)", async () => {
    const { code } = await mkClient(A)
    const o = await ringKheer(app, cashierA, A)
    const r = await charge(cashierA, o.id, { shiftId: drawerA2, code })
    expect(r.statusCode).toBe(403)
    expect(r.json().error.code).toBe('NOT_YOUR_SHIFT')
    await nothingWritten(o.id)
  })

  it('two concurrent charges near the limit: exactly one is refused OVER_LIMIT', async () => {
    const { account, code } = await mkClient(A, { creditLimitCents: CASH_TOTAL + CASH_TOTAL / 2 })
    const o1 = await ringKheer(app, cashierA, A)
    const o2 = await ringKheer(app, cashierA2, A)
    const [r1, r2] = await Promise.all([
      charge(cashierA, o1.id, { shiftId: drawerA, code }),
      charge(cashierA2, o2.id, { shiftId: drawerA2, code }),
    ])
    const codes = [r1, r2].map((r) => r.statusCode).sort()
    expect(codes).toEqual([201, 409])
    const refused = [r1, r2].find((r) => r.statusCode === 409)!
    expect(refused.json().error.code).toBe('ON_ACCOUNT_OVER_LIMIT')
    expect(await prisma.customerAccountCharge.count({ where: { accountId: account.id } })).toBe(1)
  })
})

describe('refusals write nothing', () => {
  const refusedWith = async (orderId: string, body: Record<string, unknown>, status: number, code: string) => {
    const r = await charge(cashierA, orderId, { shiftId: drawerA, ...body })
    expect(r.statusCode, r.body).toBe(status)
    expect(r.json().error.code).toBe(code)
    await nothingWritten(orderId)
  }

  it('TILL_CLEARING_NOT_SPLIT before the company is cut over', async () => {
    const C = await mkCompany('oat-d')
    const cashierC = await mkUser('oat-cashier-d', 'cashier', C.tenantId)
    const drawerC = await openDrawer(C, cashierC)
    const { code } = await mkClient(C)
    const o = await ringKheer(app, cashierC, C)
    const r = await charge(cashierC, o.id, { shiftId: drawerC, code })
    expect(r.statusCode).toBe(409)
    expect(r.json().error.code).toBe('TILL_CLEARING_NOT_SPLIT')
    await nothingWritten(o.id)
  })

  it('pending and suspended clients', async () => {
    for (const status of ['pending', 'suspended']) {
      const { code } = await mkClient(A, { status })
      await refusedWith((await ringKheer(app, cashierA, A)).id, { code }, 409, 'ON_ACCOUNT_NOT_ACTIVE')
    }
  })

  it('a brand the client may not use', async () => {
    const other = await prisma.concept.create({ data: { name: 'Other brand oat', slug: 'brand-oat-other', type: 'restaurant', tenantId: A.tenantId, taxRateCash: 15, taxRateCard: 8 } })
    const { code } = await mkClient(A, { conceptIds: [other.id] })
    await refusedWith((await ringKheer(app, cashierA, A)).id, { code }, 409, 'ON_ACCOUNT_BRAND_NOT_ALLOWED')
  })

  it('a client with an overdue statement', async () => {
    const { account, code } = await mkClient(A)
    await prisma.receivableInvoice.create({
      data: {
        tenantId: A.tenantId, customerAccountId: account.id, kind: 'statement', number: `AR-ST-OAT-${seq}`, customerName: account.legalName,
        issueDate: new Date('2026-08-01T00:00:00Z'), dueDate: new Date('2026-08-31T00:00:00Z'), description: 'Statement', amountCents: 50_000, taxCents: 0,
        paidCents: 0, status: 'open',
      },
    })
    await refusedWith((await ringKheer(app, cashierA, A)).id, { code }, 409, 'ON_ACCOUNT_OVERDUE')
  })

  it('a reference the client requires', async () => {
    const { code } = await mkClient(A, { requiresReference: true })
    await refusedWith((await ringKheer(app, cashierA, A)).id, { code, reference: '   ' }, 422, 'ON_ACCOUNT_REFERENCE_REQUIRED')
  })

  it('delivery and pickup orders are not charged at the till', async () => {
    const { code } = await mkClient(A)
    await refusedWith(await rawOrder(A, { source: 'servd', fulfilmentType: 'delivery' }), { code }, 409, 'ON_ACCOUNT_NOT_HERE')
    await refusedWith(await rawOrder(A, { source: 'servd', fulfilmentType: 'takeout' }), { code }, 409, 'ON_ACCOUNT_NOT_HERE')
  })

  it('only the whole bill: tip, part-paid, a pending split portion, promo', async () => {
    const { code } = await mkClient(A)
    await refusedWith(await rawOrder(A, { tipCents: 5_000, totalCents: CASH_TOTAL + 5_000 }), { code }, 409, 'ON_ACCOUNT_WHOLE_BILL')
    await refusedWith(await rawOrder(A, { promoDiscountCents: 10_000, totalCents: CASH_TOTAL - 10_000 }), { code }, 409, 'ON_ACCOUNT_WHOLE_BILL')

    const partPaid = await rawOrder(A, {})
    await prisma.payment.create({ data: { orderId: partPaid, shiftId: drawerA, method: 'cash', amountCents: 50_000, status: 'paid', processedAt: new Date() } })
    const r1 = await charge(cashierA, partPaid, { shiftId: drawerA, code })
    expect(r1.json().error.code).toBe('ON_ACCOUNT_WHOLE_BILL')
    expect(await prisma.customerAccountCharge.count({ where: { orderId: partPaid } })).toBe(0)

    const split = await rawOrder(A, {})
    await prisma.payment.create({ data: { orderId: split, method: 'split', amountCents: CASH_TOTAL, status: 'pending' } })
    const r2 = await charge(cashierA, split, { shiftId: drawerA, code })
    expect(r2.json().error.code).toBe('ON_ACCOUNT_WHOLE_BILL')
    expect(await prisma.customerAccountCharge.count({ where: { orderId: split } })).toBe(0)
  })

  it('a bill that cannot be priced at the cash rate', async () => {
    const { code } = await mkClient(A)
    // A legacy bill with no stored rate, and a dine-in bill stored at the card rate that is not a till sale.
    await refusedWith(await rawOrder(A, { taxRatePct: null }), { code }, 409, 'ON_ACCOUNT_RATE')
    await refusedWith(await rawOrder(A, { source: 'servd', fulfilmentType: 'dine_in', taxRatePct: 8, taxCents: 8_800, totalCents: 118_800 }), { code }, 409, 'ON_ACCOUNT_RATE')
  })
})

describe('a revoked card', () => {
  it('is refused at lookup and at charge, and flagged once per card per Karachi day', async () => {
    const { code, cardId } = await mkClient(A)
    await prisma.customerAccountCard.update({ where: { id: cardId }, data: { revokedAt: new Date(), revokedById: adminA.id, revokedReason: 'lost' } })
    const o = await ringKheer(app, cashierA, A)
    for (let i = 0; i < 2; i++) {
      const l = await caller(app)(cashierA, 'POST', '/pos/on-account/lookup', { orderId: o.id, code })
      expect(l.statusCode).toBe(409)
      expect(l.json().error.code).toBe('ON_ACCOUNT_CARD_REVOKED')
    }
    const r = await charge(cashierA, o.id, { shiftId: drawerA, code })
    expect(r.statusCode).toBe(409)
    expect(r.json().error.code).toBe('ON_ACCOUNT_CARD_REVOKED')
    await nothingWritten(o.id)
    const flags = await prisma.exceptionFlag.findMany({ where: { kind: 'on_account_card_revoked_used', entityId: cardId } })
    expect(flags).toHaveLength(1)
    expect(flags[0]!.tenantId).toBe(A.tenantId)
    expect(containsDeep(flags, code)).toBe(false)
  })
})

describe('the code never reaches an audit row', () => {
  it('one order.on_account_charge row in A with the hint only', async () => {
    const { code, cardId } = await mkClient(A)
    const o = await ringKheer(app, cashierA, A)
    expect((await charge(cashierA, o.id, { shiftId: drawerA, code })).statusCode).toBe(201)
    const rows = await prisma.auditLog.findMany({ where: { action: 'order.on_account_charge', entityId: o.id } })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.tenantId).toBe(A.tenantId)
    const card = await prisma.customerAccountCard.findUniqueOrThrow({ where: { id: cardId } })
    expect(rows[0]!.metadata).toMatchObject({ cardId, cardHint: card.tokenHint })
    const everything = await prisma.auditLog.findMany()
    const norm = normalizeCardCode(code)!
    expect(containsDeep(everything, code)).toBe(false)
    expect(containsDeep(everything, norm)).toBe(false)
    expect(containsDeep(everything, card.tokenHash)).toBe(false)
  })
})
