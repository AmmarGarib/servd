// Raast QR at the till (2026-10-12, owner decision) — Stream B, spec §4.
//
// What this guards:
//   - Raast QR is the digital tax group with card (lib/pricing tenderOf →
//     'card', taxRateCard); a pre-deploy ring-up carrying 'keenu_qr' is priced
//     as Raast, while a NEW Keenu QR payment / settle / split / quote-for-
//     payment is refused (422 KEENU_QR_RETIRED).
//   - A Raast payment needs the bank reference (400 RAAST_REF_REQUIRED;
//     normalised, 422 RAAST_REF_INVALID) and the counter-device tick (400
//     RAAST_NOT_VERIFIED — never the customer's screen). It completes the sale
//     like card (gateway 'raast', the order completes, the fiscal sale lists a
//     raast tender) and writes ONE RaastReceipt: the ORDER's company, the
//     brand's receiving account (brand override, else the company default —
//     422 RAAST_NOT_SET_UP without one) with its ledger code snapshotted,
//     'provisional' until the bank statement matches it.
//   - One transfer pays one bill — per company: the same reference twice in
//     company A is 409 RAAST_REF_USED (also when two tills race), the same
//     reference in company B is fine.
//   - Company separation: B's cashier gets 404 on A's bill; B's drawer is
//     refused on A's bill.
//   - Intents (M2/M3): a waiting Raast request blocks every other tender, a
//     comp, a void, a split, a gift card, a cancel and the shift close; paying
//     through it claims it; another bill's / cancelled / other-money intents
//     are refused; an SMS's live lease keeps the cashier out (409
//     RAAST_SETTLING) but lets that SMS in; a cashier confirm racing the bank
//     SMS leaves ONE payment and the receipt linked to the SMS.
//   - SMS matching on: a typed reference whose bank SMS is in confirms the
//     receipt; one naming other money is 422 RAAST_AMOUNT_MISMATCH; a
//     reference dismissed as "not a sale" or a debit's is 409
//     RAAST_REF_DISMISSED (M4); an SMS settling another bill is 409
//     RAAST_SMS_IN_USE.
//   - Check-split Raast portions, the pre-deploy Keenu QR portion (S5), a Raast
//     settle on a completed order (422 RAAST_AFTER_COMPLETION), S6 (a bill
//     settled another way flags its needs-attention Raast receipt; a re-split
//     clears a dead target), the Z-report's Raast lines and the receipt label.
//
// Two companies throughout. Requires a disposable database (DATABASE_URL must
// contain "test").
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { randomBytes } from 'node:crypto'
import { AppError, errorResponse } from '../src/lib/errors.js'
import { posRoutes } from '../src/modules/pos/routes.js'
import { orderRoutes } from '../src/modules/orders/routes.js'
import { checkSplitRoutes } from '../src/modules/checkSplit/routes.js'
import { registerConnectorPlugins } from '../src/modules/connectors/index.js'
import { setFiscalKicker } from '../src/connectors/fiscal/outbox.js'
import { setManagerPin } from '../src/modules/auth/managerPin.js'
import { tenderOf, tenderOfPayments } from '../src/lib/pricing.js'
import { orderRefOf } from '../src/lib/orderRef.js'
import { processPayment, compOrder, applyGiftCardTender, voidOrderItem, getZReport } from '../src/modules/pos/service.js'
import { applyBankCredit } from '../src/connectors/raast/match.js'
import {
  prisma, mkCompany, mkUser, caller, setConnector, resetConnectorCache, openDrawer, ringKheer, mkRaastAccount,
  type Company, type Who,
} from './connectorsFixtures.js'

let app: FastifyInstance
let call: ReturnType<typeof caller>
let A: Company, B: Company, N: Company
let cashierA: Who, cashierA2: Who, mgrA: Who, cashierB: Who, cashierN: Who
let drawerA: string, drawerA2: string, drawerB: string, drawerN: string
let acctA: { bankAccountId: string; ledgerCode: string }
let acctB: { bankAccountId: string; ledgerCode: string }
const PIN = '614372'

// 2 × Kheer: cash 1,265.00 / card (and Raast) 1,188.00.
const CASH_TOTAL = 126_500
const CARD_TOTAL = 118_800

let seq = 0
/** A fresh, valid bank reference (letters + digits, never a bill's own number). */
const ref = () => `MZN${Date.now().toString().slice(-7)}${String(++seq).padStart(3, '0')}`
let keySeq = 0
const key = () => `raast-till-${Date.now()}-${++keySeq}`

async function build(): Promise<FastifyInstance> {
  const a = Fastify()
  a.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode
    if (status && status >= 400 && status < 500) return reply.status(status).send({ error: { code: 'BAD_REQUEST', message: (err as Error).message } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await a.register(posRoutes, { prefix: '/pos' })
  await a.register(orderRoutes, { prefix: '/orders' })
  await a.register(checkSplitRoutes, { prefix: '/check-split' })
  await registerConnectorPlugins(a)
  await a.ready()
  return a
}

const payRaast = (who: Who, shiftId: string, orderId: string, amountCents: number, extra: Record<string, unknown> = {}) =>
  call(who, 'POST', '/pos/payments', { orderId, shiftId, payments: [{ method: 'raast', amountCents, gatewayRef: ref(), raastVerified: true, ...extra }] })

const writtenFor = async (orderId: string) => ({
  payments: await prisma.payment.count({ where: { orderId } }),
  receipts: await prisma.raastReceipt.count({ where: { orderId } }),
})

/** An awaiting Raast request (intent) the way the Raast engine writes one. */
async function mkIntent(co: Company, acct: { bankAccountId: string; ledgerCode: string }, orderId: string, shiftId: string, by: Who, amountCents: number, extra: Record<string, unknown> = {}) {
  return prisma.raastReceipt.create({
    data: {
      tenantId: co.tenantId, orderId, conceptId: co.conceptId, shiftId, bankAccountId: acct.bankAccountId, ledgerCode: acct.ledgerCode,
      amountCents, tipCents: 0, dueCents: amountCents, status: 'awaiting', expiresAt: new Date(Date.now() + 30 * 60_000),
      idempotencyKey: `intent-${key()}`, createdById: by.id, ...extra,
    },
  })
}

const devices = new Map<string, string>()
/** A counter phone of the company (its raast connector row). */
async function deviceOf(co: Company, by: Who): Promise<string> {
  const hit = devices.get(co.tenantId)
  if (hit) return hit
  await setConnector(co.tenantId, 'raast', {})
  const conn = await prisma.posConnector.findUniqueOrThrow({ where: { tenantId_kind: { tenantId: co.tenantId, kind: 'raast' } } })
  const d = await prisma.bankSmsDevice.create({
    data: {
      tenantId: co.tenantId, connectorId: conn.id, label: 'Counter phone', tokenHash: randomBytes(32).toString('hex'),
      tokenEnc: 'enc:test', tokenHint: 'sms_…test', createdById: by.id,
    },
  })
  devices.set(co.tenantId, d.id)
  return d.id
}

/** A bank SMS alert, already parsed (the Raast engine's row). */
async function mkAlert(co: Company, by: Who, a: {
  bankRef: string; amountCents: number; bankAccountId: string; kind?: 'credit' | 'debit'
  status?: 'received' | 'processing' | 'unmatched' | 'ambiguous' | 'off' | 'needs_attention' | 'dismissed'; occurredAt?: Date; claimedRef?: string | null
}) {
  return prisma.bankSmsAlert.create({
    data: {
      tenantId: co.tenantId, deviceId: await deviceOf(co, by), sender: 'MEEZANBNK', bodyHash: randomBytes(16).toString('hex'),
      body: `PKR ${(a.amountCents / 100).toFixed(2)} received ref ${a.bankRef}`, receivedAt: new Date(), templateId: 'tpl-1',
      kind: a.kind ?? 'credit', amountCents: a.amountCents, bankRef: a.bankRef, occurredAt: a.occurredAt ?? new Date(),
      bankAccountId: a.bankAccountId, status: a.status ?? 'unmatched', claimedRef: a.claimedRef ?? null,
    },
  })
}

const smsOn = (co: Company, on: boolean) => setConnector(co.tenantId, 'raast', { enabled: on })

beforeAll(async () => {
  setFiscalKicker(async () => {})
  A = await mkCompany('rtill-a')
  B = await mkCompany('rtill-b')
  N = await mkCompany('rtill-n')
  cashierA = await mkUser('rtill-cashier-a', 'cashier', A.tenantId)
  cashierA2 = await mkUser('rtill-cashier-a2', 'cashier', A.tenantId)
  mgrA = await mkUser('rtill-mgr-a', 'foh_management', A.tenantId)
  cashierB = await mkUser('rtill-cashier-b', 'cashier', B.tenantId)
  cashierN = await mkUser('rtill-cashier-n', 'cashier', N.tenantId)
  await setManagerPin(mgrA.id, PIN)
  drawerA = await openDrawer(A, cashierA)
  drawerA2 = await openDrawer(A, cashierA2)
  drawerB = await openDrawer(B, cashierB)
  drawerN = await openDrawer(N, cashierN)
  acctA = await mkRaastAccount(A)
  acctB = await mkRaastAccount(B)
  // Fiscal reporting on (the default): every completed sale gets its document.
  await setConnector(A.tenantId, 'fiscal', { driver: 'test', enabled: true, settings: {} })
  app = await build()
  call = caller(app)
}, 60_000)

afterAll(async () => {
  setFiscalKicker(null)
  resetConnectorCache()
  await app?.close()
})

// ─── The digital tax group ──────────────────────────────────────────────────

describe('Raast QR is the digital tax group (card rate); Keenu QR is retired', () => {
  it('tenderOf: raast is card; a quote for a Raast payment is the card-rate bill; a Keenu QR quote is refused', async () => {
    expect(tenderOf('raast')).toBe('card')
    expect(tenderOfPayments(['raast'])).toBe('card')
    expect(tenderOfPayments(['raast', 'cash'])).toBe('cash')
    const o = await ringKheer(app, cashierA, A)
    expect(o.totalCents).toBe(CASH_TOTAL)
    const q = await call(cashierA, 'GET', `/pos/orders/${o.id}/quote?method=raast`)
    expect(q.statusCode, q.body).toBe(200)
    expect(q.json()).toMatchObject({ tender: 'card', taxRatePct: 8, totalCents: CARD_TOTAL, dueCents: CARD_TOTAL, repriced: true })
    const k = await call(cashierA, 'GET', `/pos/orders/${o.id}/quote?method=keenu_qr`)
    expect(k.statusCode).toBe(422)
    expect(k.json().error.code).toBe('KEENU_QR_RETIRED')
  })

  it("a pre-deploy ring-up carrying 'keenu_qr' (offline queue) is priced as Raast; 'raast' rings at the card rate", async () => {
    const legacy = await call(cashierA, 'POST', '/pos/orders', {
      conceptId: A.conceptId, paymentMethod: 'keenu_qr', items: [{ menuItemId: A.items.kheer, name: 'Kheer', quantity: 2, unitPriceCents: 55_000, modifiers: [] }],
    })
    expect(legacy.statusCode, legacy.body).toBe(201)
    expect(legacy.json()).toMatchObject({ taxRatePct: 8, totalCents: CARD_TOTAL })
    const raast = await call(cashierA, 'POST', '/pos/orders', {
      conceptId: A.conceptId, paymentMethod: 'raast', items: [{ menuItemId: A.items.kheer, name: 'Kheer', quantity: 2, unitPriceCents: 55_000, modifiers: [] }],
    })
    expect(raast.json()).toMatchObject({ taxRatePct: 8, totalCents: CARD_TOTAL })
    const quote = await call(cashierA, 'POST', '/pos/quote', {
      conceptId: A.conceptId, paymentMethod: 'keenu_qr', items: [{ menuItemId: A.items.kheer, name: 'Kheer', quantity: 2, unitPriceCents: 55_000, modifiers: [] }],
    })
    expect(quote.statusCode, quote.body).toBe(200)
    expect(quote.json()).toMatchObject({ tender: 'card', taxRatePct: 8, totalCents: CARD_TOTAL })
  })
})

// ─── Taking Raast at the till ────────────────────────────────────────────────

describe('POST /pos/payments with Raast QR', () => {
  it('refuses a missing / malformed reference, a missing counter-device tick, two Raast tenders and Keenu QR — writing nothing', async () => {
    const o = await ringKheer(app, cashierA, A)
    const pay = (p: Record<string, unknown>) => call(cashierA, 'POST', '/pos/payments', { orderId: o.id, shiftId: drawerA, payments: [{ method: 'raast', amountCents: CARD_TOTAL, ...p }] })

    const noRef = await pay({ raastVerified: true })
    expect(noRef.statusCode).toBe(400)
    expect(noRef.json().error.code).toBe('RAAST_REF_REQUIRED')
    for (const bad of ['AB12', 'ABCDEFGH', '1111111', orderRefOf(o.id), 'ref with ✓ 12345']) {
      const r = await pay({ raastVerified: true, gatewayRef: bad })
      expect(r.statusCode, `${bad}: ${r.body}`).toBe(422)
      expect(r.json().error.code).toBe('RAAST_REF_INVALID')
    }
    const unticked = await pay({ gatewayRef: ref() })
    expect(unticked.statusCode).toBe(400)
    expect(unticked.json().error.code).toBe('RAAST_NOT_VERIFIED')
    const falseTick = await pay({ gatewayRef: ref(), raastVerified: false })
    expect(falseTick.statusCode).toBe(400)
    expect(falseTick.json().error.code).toBe('VALIDATION_ERROR')
    const two = await call(cashierA, 'POST', '/pos/payments', {
      orderId: o.id, shiftId: drawerA,
      payments: [
        { method: 'raast', amountCents: 50_000, gatewayRef: ref(), raastVerified: true },
        { method: 'raast', amountCents: CARD_TOTAL - 50_000, gatewayRef: ref(), raastVerified: true },
      ],
    })
    expect(two.statusCode).toBe(400)
    expect(two.json().error.code).toBe('RAAST_ONE_PER_PAYMENT')
    const keenu = await call(cashierA, 'POST', '/pos/payments', { orderId: o.id, shiftId: drawerA, payments: [{ method: 'keenu_qr', amountCents: CARD_TOTAL, gatewayRef: 'QR-77' }] })
    expect(keenu.statusCode).toBe(422)
    expect(keenu.json().error).toMatchObject({ code: 'KEENU_QR_RETIRED', message: 'Keenu QR is retired — take Raast QR or Card – Keenu' })

    expect(await writtenFor(o.id)).toEqual({ payments: 0, receipts: 0 })
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).not.toBe('completed')
  })

  it('a verified reference completes the sale like card: gateway raast, ONE provisional receipt in the order\'s company with the ledger code snapshot, a raast fiscal tender', async () => {
    const o = await ringKheer(app, cashierA, A)
    const r = await call(cashierA, 'POST', '/pos/payments', {
      orderId: o.id, shiftId: drawerA, idempotencyKey: key(),
      payments: [{ method: 'raast', amountCents: CARD_TOTAL, gatewayRef: ' mzn-778 899 001 ', raastVerified: true }],
    })
    expect(r.statusCode, r.body).toBe(201)
    const body = r.json()
    expect(body.orderCompleted).toBe(true)
    expect(body.raast).toHaveLength(1)
    expect(body.raast[0]).toMatchObject({ status: 'provisional', bankRef: 'MZN778899001', confirmedVia: 'cashier', smsConfirmed: false })

    const order = await prisma.order.findUniqueOrThrow({ where: { id: o.id }, include: { payments: true, raastReceipts: true } })
    expect(order).toMatchObject({ status: 'completed', taxRatePct: 8, totalCents: CARD_TOTAL })
    expect(order.payments).toHaveLength(1)
    const p = order.payments[0]!
    expect(p).toMatchObject({ method: 'raast', status: 'paid', gateway: 'raast', gatewayRef: 'MZN778899001', amountCents: CARD_TOTAL, shiftId: drawerA })
    expect(order.raastReceipts).toHaveLength(1)
    expect(order.raastReceipts[0]).toMatchObject({
      id: body.raast[0].receiptId, tenantId: A.tenantId, conceptId: A.conceptId, orderId: o.id, paymentId: p.id, shiftId: drawerA,
      bankAccountId: acctA.bankAccountId, ledgerCode: acctA.ledgerCode, amountCents: CARD_TOTAL, tipCents: 0, dueCents: CARD_TOTAL,
      bankRef: 'MZN778899001', bankRefRaw: 'mzn-778 899 001', status: 'provisional', confirmedVia: 'cashier', cashierVerified: true,
      confirmedById: cashierA.id, createdById: cashierA.id, smsAlertId: null, statementLineId: null,
    })

    // The ONE fiscal sale document lists the Raast tender (stored figures).
    const sale = await prisma.fiscalDocument.findFirstOrThrow({ where: { orderId: o.id, kind: 'sale' } })
    expect((sale.payload as { payment: { tenders: unknown[] } }).payment.tenders).toEqual([{ method: 'raast', amountCents: CARD_TOTAL }])
  })

  it('a tip rides on the transfer: the receipt is the bill share + tip, the order carries the tip', async () => {
    const o = await ringKheer(app, cashierA, A)
    const r = await payRaast(cashierA, drawerA, o.id, CARD_TOTAL + 5_000, { tipCents: 5_000 })
    expect(r.statusCode, r.body).toBe(201)
    const order = await prisma.order.findUniqueOrThrow({ where: { id: o.id }, include: { raastReceipts: true } })
    expect(order).toMatchObject({ tipCents: 5_000, totalCents: CARD_TOTAL + 5_000, status: 'completed' })
    expect(order.raastReceipts[0]).toMatchObject({ amountCents: CARD_TOTAL + 5_000, tipCents: 5_000, dueCents: CARD_TOTAL })
  })

  it('one transfer pays one bill — per company: the same reference again in A is 409 RAAST_REF_USED (normalised), in B it is fine', async () => {
    const used = ref()
    const o1 = await ringKheer(app, cashierA, A)
    expect((await payRaast(cashierA, drawerA, o1.id, CARD_TOTAL, { gatewayRef: used })).statusCode).toBe(201)

    const o2 = await ringKheer(app, cashierA, A)
    const again = await payRaast(cashierA, drawerA, o2.id, CARD_TOTAL, { gatewayRef: used.toLowerCase().replace(/(\d{3})/, '$1-') })
    expect(again.statusCode, again.body).toBe(409)
    expect(again.json().error).toMatchObject({ code: 'RAAST_REF_USED', details: { orderRef: orderRefOf(o1.id) } })
    expect(await writtenFor(o2.id)).toEqual({ payments: 0, receipts: 0 })

    const ob = await ringKheer(app, cashierB, B)
    const inB = await payRaast(cashierB, drawerB, ob.id, CARD_TOTAL, { gatewayRef: used })
    expect(inB.statusCode, inB.body).toBe(201)
    const rb = await prisma.raastReceipt.findFirstOrThrow({ where: { orderId: ob.id } })
    expect(rb).toMatchObject({ tenantId: B.tenantId, bankAccountId: acctB.bankAccountId, bankRef: used })
  })

  it('two tills racing the same reference: exactly one bill is paid by it, the other gets 409 RAAST_REF_USED', async () => {
    const shared = ref()
    const o1 = await ringKheer(app, cashierA, A)
    const o2 = await ringKheer(app, cashierA2, A)
    const res = await Promise.all([
      payRaast(cashierA, drawerA, o1.id, CARD_TOTAL, { gatewayRef: shared }),
      payRaast(cashierA2, drawerA2, o2.id, CARD_TOTAL, { gatewayRef: shared }),
    ])
    expect(res.map((r) => r.statusCode).sort()).toEqual([201, 409])
    expect(res.find((r) => r.statusCode === 409)!.json().error.code).toBe('RAAST_REF_USED')
    expect(await prisma.raastReceipt.count({ where: { tenantId: A.tenantId, bankRef: shared } })).toBe(1)
    expect(await prisma.payment.count({ where: { orderId: { in: [o1.id, o2.id] }, method: 'raast' } })).toBe(1)
  })

  it("company B's cashier gets 404 on A's bill; A's bill is refused on B's drawer — nothing written", async () => {
    const o = await ringKheer(app, cashierA, A)
    const foreign = await payRaast(cashierB, drawerB, o.id, CARD_TOTAL)
    expect(foreign.statusCode).toBe(404)
    const wrongDrawer = await payRaast(cashierA, drawerB, o.id, CARD_TOTAL)
    expect(wrongDrawer.statusCode).toBe(422)
    expect(wrongDrawer.json().error.code).toBe('SHIFT_NOT_IN_COMPANY')
    expect(await writtenFor(o.id)).toEqual({ payments: 0, receipts: 0 })
  })

  it('a brand with no receiving account is 422 RAAST_NOT_SET_UP; a brand override wins over the company default', async () => {
    const on = await ringKheer(app, cashierN, N)
    const notSetUp = await payRaast(cashierN, drawerN, on.id, CARD_TOTAL)
    expect(notSetUp.statusCode, notSetUp.body).toBe(422)
    expect(notSetUp.json().error.code).toBe('RAAST_NOT_SET_UP')
    expect(await writtenFor(on.id)).toEqual({ payments: 0, receipts: 0 })

    // A second brand of company A with its own Raast account (1022).
    const brand2 = await prisma.concept.create({
      data: { name: 'Brand rtill-a2', slug: 'brand-rtill-a2', type: 'restaurant', tenantId: A.tenantId, taxRate: 17, taxRateCash: 15, taxRateCard: 8 },
    })
    const cat = await prisma.category.create({ data: { conceptId: brand2.id, name: 'Mains' } })
    const item = await prisma.menuItem.create({ data: { conceptId: brand2.id, categoryId: cat.id, name: 'Kheer', priceCents: 55_000 } })
    const own = await mkRaastAccount(A, { code: '1022', forConceptId: brand2.id, isDefault: false })
    const ring = await call(cashierA, 'POST', '/pos/orders', { conceptId: brand2.id, items: [{ menuItemId: item.id, name: 'Kheer', quantity: 2, unitPriceCents: 55_000, modifiers: [] }] })
    expect(ring.statusCode, ring.body).toBe(201)
    expect((await payRaast(cashierA, drawerA, ring.json().id, CARD_TOTAL)).statusCode).toBe(201)
    expect(await prisma.raastReceipt.findFirstOrThrow({ where: { orderId: ring.json().id } })).toMatchObject({ bankAccountId: own.bankAccountId, ledgerCode: '1022', conceptId: brand2.id })
    // The company's own brand still lands on the default.
    const o = await ringKheer(app, cashierA, A)
    expect((await payRaast(cashierA, drawerA, o.id, CARD_TOTAL)).statusCode).toBe(201)
    expect(await prisma.raastReceipt.findFirstOrThrow({ where: { orderId: o.id } })).toMatchObject({ bankAccountId: acctA.bankAccountId, ledgerCode: acctA.ledgerCode })
    // An override pointing at ANOTHER company's account is never used: back to A's default.
    await prisma.concept.update({ where: { id: brand2.id }, data: { raastBankAccountId: acctB.bankAccountId } })
    const ring2 = await call(cashierA, 'POST', '/pos/orders', { conceptId: brand2.id, items: [{ menuItemId: item.id, name: 'Kheer', quantity: 2, unitPriceCents: 55_000, modifiers: [] }] })
    expect((await payRaast(cashierA, drawerA, ring2.json().id, CARD_TOTAL)).statusCode).toBe(201)
    expect(await prisma.raastReceipt.findFirstOrThrow({ where: { orderId: ring2.json().id } })).toMatchObject({ bankAccountId: acctA.bankAccountId, tenantId: A.tenantId })
  })

  it('a retry with the same key replays the payment (same receipt); the same key with another reference is 409', async () => {
    const idem = key()
    const o2 = await ringKheer(app, cashierA, A)
    const body = (gatewayRef: string) => ({ orderId: o2.id, shiftId: drawerA, idempotencyKey: idem, payments: [{ method: 'raast', amountCents: CARD_TOTAL, gatewayRef, raastVerified: true }] })
    const r1 = await call(cashierA, 'POST', '/pos/payments', body('HBL 5544332211'))
    expect(r1.statusCode, r1.body).toBe(201)
    const r2 = await call(cashierA, 'POST', '/pos/payments', body('hbl-5544332211'))
    expect(r2.statusCode).toBe(201)
    expect(r2.json()).toMatchObject({ replayed: true, orderCompleted: true })
    expect(r2.json().raast).toEqual(r1.json().raast)
    const r3 = await call(cashierA, 'POST', '/pos/payments', body('HBL9988776655'))
    expect(r3.statusCode).toBe(409)
    expect(r3.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED')
    expect(await prisma.raastReceipt.count({ where: { orderId: o2.id } })).toBe(1)
  })

  it("the full & final bill prints the tender as 'Raast QR — Ref <bank reference>'", async () => {
    const o = await ringKheer(app, cashierA, A)
    const theRef = ref()
    expect((await payRaast(cashierA, drawerA, o.id, CARD_TOTAL, { gatewayRef: theRef })).statusCode).toBe(201)
    const data = await call(cashierA, 'GET', `/pos/orders/${o.id}/receipt-data`)
    expect(data.statusCode, data.body).toBe(200)
    expect(data.json().payments).toEqual([{ method: 'raast', amountCents: CARD_TOTAL, tenderedCents: null, label: `Raast QR — Ref ${theRef}`, reference: theRef }])
    const html = await call(cashierA, 'GET', `/pos/receipt/${o.id}`)
    // The bill shows Paid / Due, not the payment lines (owner, 2026-10-20); the reference stays on the receipt data.
    expect(html.body).not.toContain(`Ref ${theRef}`)
    expect(html.body).toContain('Paid')
  })
})

// ─── Check-split portions ────────────────────────────────────────────────────

describe('check-split: Raast portions, the retired Keenu QR portion, a completed order', () => {
  it('a Raast portion settles with its reference and the tick, and gets its own receipt (targetPaymentId); the bill completes with the last portion', async () => {
    const o = await ringKheer(app, cashierA, A)
    const split = await call(cashierA, 'POST', `/check-split/orders/${o.id}/split`, { splits: [{ amountCents: 60_000, method: 'raast' }, { amountCents: CASH_TOTAL - 60_000, method: 'cash' }] })
    expect(split.statusCode, split.body).toBe(200)
    const [raastPortion, cashPortion] = split.json() as Array<{ id: string; amountCents: number; method: string }>
    expect(raastPortion!.method).toBe('raast')

    const unticked = await call(cashierA, 'POST', `/check-split/payments/${raastPortion!.id}/settle`, { shiftId: drawerA, gatewayRef: ref() })
    expect(unticked.statusCode).toBe(400)
    expect(unticked.json().error.code).toBe('RAAST_NOT_VERIFIED')
    const noRef = await call(cashierA, 'POST', `/check-split/payments/${raastPortion!.id}/settle`, { shiftId: drawerA, raastVerified: true })
    expect(noRef.json().error.code).toBe('RAAST_REF_REQUIRED')

    const theRef = ref()
    const s1 = await call(cashierA, 'POST', `/check-split/payments/${raastPortion!.id}/settle`, { shiftId: drawerA, gatewayRef: theRef, raastVerified: true })
    expect(s1.statusCode, s1.body).toBe(200)
    expect(s1.json()).toMatchObject({ status: 'paid', method: 'raast', gateway: 'raast', gatewayRef: theRef, orderCompleted: false })
    expect(s1.json().raast[0]).toMatchObject({ status: 'provisional', bankRef: theRef })
    expect(await prisma.raastReceipt.findFirstOrThrow({ where: { orderId: o.id } })).toMatchObject({
      paymentId: raastPortion!.id, targetPaymentId: raastPortion!.id, amountCents: 60_000, tipCents: 0, tenantId: A.tenantId, status: 'provisional',
    })
    const s2 = await call(cashierA, 'POST', `/check-split/payments/${cashPortion!.id}/settle`, { shiftId: drawerA, tenderedCents: cashPortion!.amountCents })
    expect(s2.statusCode, s2.body).toBe(200)
    expect(s2.json().orderCompleted).toBe(true)
  })

  it('a split (or an even split) by Keenu QR is 422 KEENU_QR_RETIRED', async () => {
    const o = await ringKheer(app, cashierA, A)
    const r = await call(cashierA, 'POST', `/check-split/orders/${o.id}/split`, { splits: [{ amountCents: 60_000, method: 'keenu_qr' }, { amountCents: CASH_TOTAL - 60_000, method: 'cash' }] })
    expect(r.statusCode).toBe(422)
    expect(r.json().error.code).toBe('KEENU_QR_RETIRED')
    const even = await call(cashierA, 'POST', `/check-split/orders/${o.id}/split-evenly`, { ways: 2, method: 'keenu_qr' })
    expect(even.statusCode).toBe(422)
    expect(even.json().error.code).toBe('KEENU_QR_RETIRED')
  })

  it('S5 — a pre-deploy split with a paid portion and a Keenu QR portion left: settle says take the rest with Pay, which completes the bill', async () => {
    const o = await ringKheer(app, cashierA, A)
    const split = await call(cashierA, 'POST', `/check-split/orders/${o.id}/split`, { splits: [{ amountCents: 70_000, method: 'cash' }, { amountCents: CASH_TOTAL - 70_000, method: 'card' }] })
    const [cashPortion, oldPortion] = split.json() as Array<{ id: string; amountCents: number }>
    // As it stood before the deploy: the second portion was taken by Keenu QR.
    await prisma.payment.update({ where: { id: oldPortion!.id }, data: { method: 'keenu_qr' } })
    expect((await call(cashierA, 'POST', `/check-split/payments/${cashPortion!.id}/settle`, { shiftId: drawerA, tenderedCents: 70_000 })).statusCode).toBe(200)

    const settle = await call(cashierA, 'POST', `/check-split/payments/${oldPortion!.id}/settle`, { shiftId: drawerA, gatewayRef: 'QR-OLD-1' })
    expect(settle.statusCode).toBe(422)
    expect(settle.json().error.code).toBe('KEENU_QR_RETIRED')
    expect(settle.json().error.message).toContain('take the rest with Pay (cash, Card – Keenu or Raast QR)')
    // Re-splitting is not the way out: a bill with a paid portion can't be re-split.
    const resplit = await call(cashierA, 'POST', `/check-split/orders/${o.id}/split`, { splits: [{ amountCents: 70_000, method: 'cash' }, { amountCents: CASH_TOTAL - 70_000, method: 'raast' }] })
    expect(resplit.statusCode).toBe(409)
    expect(resplit.json().error.code).toBe('ALREADY_PAID')

    // Pay takes the rest (here by Raast); its coverage fails the leftover Keenu QR row.
    const rest = await payRaast(cashierA, drawerA, o.id, oldPortion!.amountCents)
    expect(rest.statusCode, rest.body).toBe(201)
    expect(rest.json().orderCompleted).toBe(true)
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: oldPortion!.id } })).status).toBe('failed')
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('completed')
  })

  it('a Raast settle on an already-completed order is 422 RAAST_AFTER_COMPLETION', async () => {
    const o = await prisma.order.create({
      data: {
        conceptId: A.conceptId, source: 'servd', fulfilmentType: 'takeout', status: 'completed', completedAt: new Date(), totalCents: 50_000, taxCents: 0,
        payments: { create: [{ method: 'raast', amountCents: 50_000, status: 'pending', splitGroup: 1, splitLabel: 'Split 1' }] },
      },
      include: { payments: true },
    })
    const r = await call(cashierA, 'POST', `/pos/payments/${o.payments[0]!.id}/settle`, { shiftId: drawerA, gatewayRef: ref(), raastVerified: true })
    expect(r.statusCode).toBe(422)
    expect(r.json().error.code).toBe('RAAST_AFTER_COMPLETION')
    expect(await prisma.raastReceipt.count({ where: { orderId: o.id } })).toBe(0)
  })
})

// ─── A waiting Raast request (intent) ───────────────────────────────────────

describe('a waiting Raast request (M2/M3)', () => {
  it('blocks every other tender, a comp, a void, a split, a gift card, a cancel and the shift close', async () => {
    const o = await ringKheer(app, cashierA2, A)
    const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId: o.id } })
    const intent = await mkIntent(A, acctA, o.id, drawerA2, cashierA2, CARD_TOTAL)

    const cash = await call(cashierA2, 'POST', '/pos/payments', { orderId: o.id, shiftId: drawerA2, payments: [{ method: 'cash', amountCents: CASH_TOTAL }] })
    expect(cash.statusCode).toBe(409)
    expect(cash.json().error).toMatchObject({ code: 'RAAST_AWAITING', details: { receiptId: intent.id } })
    const typed = await payRaast(cashierA2, drawerA2, o.id, CARD_TOTAL)
    expect(typed.json().error.code).toBe('RAAST_AWAITING')
    await expect(compOrder({ orderId: o.id, shiftId: drawerA2, amountCents: 100, reason: 'Sorry', actorId: mgrA.id, actorRole: 'foh_management' }))
      .rejects.toMatchObject({ code: 'RAAST_AWAITING' })
    await expect(voidOrderItem({ orderId: o.id, orderItemId: item.id, reason: 'Wrong item', actorId: mgrA.id, actorRole: 'foh_management' }))
      .rejects.toMatchObject({ code: 'RAAST_AWAITING' })
    const split = await call(cashierA2, 'POST', `/check-split/orders/${o.id}/split-evenly`, { ways: 2, method: 'cash' })
    expect(split.json().error.code).toBe('RAAST_AWAITING')
    await expect(applyGiftCardTender({ orderId: o.id, code: 'NO-SUCH-CARD', amountCents: 1_000 })).rejects.toMatchObject({ code: 'RAAST_AWAITING' })
    const cancel = await call(mgrA, 'POST', `/orders/${o.id}/cancel`, { reason: 'Guest left' })
    expect(cancel.json().error.code).toBe('RAAST_AWAITING')
    const close = await call(cashierA2, 'POST', `/pos/shifts/${drawerA2}/close`, { closingFloatCents: 0, confirmOpenTickets: true })
    expect(close.statusCode).toBe(409)
    expect(close.json().error.code).toBe('SHIFT_HAS_AWAITING_RAAST')
    expect(await prisma.payment.count({ where: { orderId: o.id } })).toBe(0)

    // Paying THROUGH the request claims it: the same receipt, now provisional.
    const paid = await processPayment({
      orderId: o.id, shiftId: drawerA2, actorId: cashierA2.id, idempotencyKey: `raast:${intent.id}`,
      payments: [{ method: 'raast', amountCents: CARD_TOTAL, gatewayRef: ref(), raast: { via: 'cashier', intentId: intent.id, cashierVerified: true } }],
    })
    expect(paid.orderCompleted).toBe(true)
    expect(paid.raast).toHaveLength(1)
    expect(paid.raast[0]).toMatchObject({ receiptId: intent.id, status: 'provisional', confirmedVia: 'cashier' })
    const claimed = await prisma.raastReceipt.findUniqueOrThrow({ where: { id: intent.id } })
    expect(claimed).toMatchObject({ status: 'provisional', paymentId: paid.payments[0]!.id, settlingUntil: null, cashierVerified: true, confirmedById: cashierA2.id })
    expect(await prisma.raastReceipt.count({ where: { orderId: o.id } })).toBe(1)
  })

  it('refuses an intent of another bill, a cancelled one, and one for other money (the bill moved) — nothing written', async () => {
    const o = await ringKheer(app, cashierA2, A)
    const other = await ringKheer(app, cashierA2, A)
    const otherIntent = await mkIntent(A, acctA, other.id, drawerA2, cashierA2, CARD_TOTAL)
    const pay = (intentId: string, amountCents = CARD_TOTAL, orderId = o.id) => processPayment({
      orderId, shiftId: drawerA2, actorId: cashierA2.id,
      payments: [{ method: 'raast', amountCents, gatewayRef: ref(), raast: { via: 'cashier', intentId, cashierVerified: true } }],
    })
    await expect(pay(otherIntent.id)).rejects.toMatchObject({ code: 'RAAST_INTENT_GONE', statusCode: 409 })
    await prisma.raastReceipt.update({ where: { id: otherIntent.id }, data: { status: 'cancelled', cancelReason: 'test' } })
    await expect(pay(otherIntent.id, CARD_TOTAL, other.id)).rejects.toMatchObject({ code: 'RAAST_INTENT_GONE' })
    // Asked for 1,000 more than the bill now: the customer transferred other money.
    const moved = await mkIntent(A, acctA, o.id, drawerA2, cashierA2, CARD_TOTAL + 1_000)
    await expect(pay(moved.id)).rejects.toMatchObject({ code: 'AMOUNT_MISMATCH', statusCode: 409 })
    expect(await prisma.payment.count({ where: { orderId: { in: [o.id, other.id] } } })).toBe(0)
    expect(await prisma.raastReceipt.findUniqueOrThrow({ where: { id: moved.id } })).toMatchObject({ status: 'awaiting', paymentId: null })
    await prisma.raastReceipt.update({ where: { id: moved.id }, data: { status: 'cancelled' } })
  })

  it("an SMS's live lease keeps the cashier out (409 RAAST_SETTLING) and lets that SMS in; a lapsed lease is released to the cashier", async () => {
    const o = await ringKheer(app, cashierA2, A)
    const smsRef = ref()
    const alert = await mkAlert(A, mgrA, { bankRef: smsRef, amountCents: CARD_TOTAL, bankAccountId: acctA.bankAccountId, status: 'processing' })
    const intent = await mkIntent(A, acctA, o.id, drawerA2, cashierA2, CARD_TOTAL, { smsAlertId: alert.id, settlingUntil: new Date(Date.now() + 60_000) })
    await expect(processPayment({
      orderId: o.id, shiftId: drawerA2, actorId: cashierA2.id,
      payments: [{ method: 'raast', amountCents: CARD_TOTAL, gatewayRef: ref(), raast: { via: 'cashier', intentId: intent.id, cashierVerified: true } }],
    })).rejects.toMatchObject({ code: 'RAAST_SETTLING', statusCode: 409 })
    // Another SMS can't take it either.
    await expect(processPayment({
      orderId: o.id, shiftId: drawerA2, actorId: cashierA2.id,
      payments: [{ method: 'raast', amountCents: CARD_TOTAL, gatewayRef: ref(), raast: { via: 'sms', intentId: intent.id, smsAlertId: 'some-other-alert' } }],
    })).rejects.toMatchObject({ code: 'RAAST_SETTLING' })
    // The SMS that holds the lease settles it.
    const viaSms = await processPayment({
      orderId: o.id, shiftId: drawerA2, actorId: cashierA2.id, idempotencyKey: `raast:${intent.id}`,
      payments: [{ method: 'raast', amountCents: CARD_TOTAL, gatewayRef: smsRef, raast: { via: 'sms', intentId: intent.id, smsAlertId: alert.id } }],
    })
    expect(viaSms.orderCompleted).toBe(true)
    const r = await prisma.raastReceipt.findUniqueOrThrow({ where: { id: intent.id } })
    expect(r).toMatchObject({ status: 'provisional', confirmedVia: 'sms', smsAlertId: alert.id, bankRef: smsRef, settlingUntil: null, cashierVerified: false })
    expect(r.smsConfirmedAt).toBeInstanceOf(Date)

    // A lapsed lease: the cashier may confirm, and the dead SMS link is released.
    const o2 = await ringKheer(app, cashierA2, A)
    const alert2 = await mkAlert(A, mgrA, { bankRef: ref(), amountCents: CARD_TOTAL + 7, bankAccountId: acctA.bankAccountId, status: 'processing' })
    const stale = await mkIntent(A, acctA, o2.id, drawerA2, cashierA2, CARD_TOTAL, { smsAlertId: alert2.id, settlingUntil: new Date(Date.now() - 1_000) })
    const typed = await processPayment({
      orderId: o2.id, shiftId: drawerA2, actorId: cashierA2.id,
      payments: [{ method: 'raast', amountCents: CARD_TOTAL, gatewayRef: ref(), raast: { via: 'cashier', intentId: stale.id, cashierVerified: true } }],
    })
    expect(typed.orderCompleted).toBe(true)
    expect(await prisma.raastReceipt.findUniqueOrThrow({ where: { id: stale.id } })).toMatchObject({ status: 'provisional', confirmedVia: 'cashier', smsAlertId: null })
  })

  it('a needs-attention request leased for a cashier\'s attach is paid by that alert (own lease)', async () => {
    const o = await ringKheer(app, cashierA2, A)
    const smsRef = ref()
    const alert = await mkAlert(A, mgrA, { bankRef: smsRef, amountCents: CARD_TOTAL, bankAccountId: acctA.bankAccountId, status: 'processing' })
    const r = await mkIntent(A, acctA, o.id, drawerA2, cashierA2, CARD_TOTAL, { status: 'needs_attention', attentionReason: 'AMOUNT_MISMATCH', smsAlertId: alert.id, settlingUntil: new Date(Date.now() + 60_000) })
    const paid = await processPayment({
      orderId: o.id, shiftId: drawerA2, actorId: cashierA2.id,
      payments: [{ method: 'raast', amountCents: CARD_TOTAL, gatewayRef: smsRef, raast: { via: 'sms', intentId: r.id, smsAlertId: alert.id } }],
    })
    expect(paid.orderCompleted).toBe(true)
    expect(await prisma.raastReceipt.findUniqueOrThrow({ where: { id: r.id } })).toMatchObject({ status: 'provisional', smsAlertId: alert.id, attentionReason: null })
  })

  it('M2 — a cashier confirm racing the bank SMS for the same request: ONE payment, the receipt provisional and linked to the SMS', async () => {
    await smsOn(A, true)
    try {
      for (let i = 0; i < 3; i++) {
        const o = await ringKheer(app, cashierA2, A)
        const intent = await mkIntent(A, acctA, o.id, drawerA2, cashierA2, CARD_TOTAL)
        const smsRef = ref()
        const alert = await mkAlert(A, mgrA, { bankRef: smsRef, amountCents: CARD_TOTAL, bankAccountId: acctA.bankAccountId, status: 'processing', occurredAt: new Date() })
        const [cashier, sms] = await Promise.allSettled([
          processPayment({
            orderId: o.id, shiftId: drawerA2, actorId: cashierA2.id, idempotencyKey: `raast:${intent.id}`,
            payments: [{ method: 'raast', amountCents: CARD_TOTAL, gatewayRef: smsRef, raast: { via: 'cashier', intentId: intent.id, cashierVerified: true } }],
          }),
          applyBankCredit({ tenantId: A.tenantId, bankAccountId: acctA.bankAccountId, amountCents: CARD_TOTAL, bankRef: smsRef, occurredAt: new Date(), receiptId: null }, { kind: 'sms', alertId: alert.id }),
        ])
        if (cashier.status === 'rejected') expect((cashier.reason as AppError).code).toMatch(/^RAAST_(SETTLING|INTENT_GONE)$/)
        expect(sms.status).toBe('fulfilled')
        expect(await prisma.payment.count({ where: { orderId: o.id, method: 'raast', status: 'paid' } })).toBe(1)
        const r = await prisma.raastReceipt.findUniqueOrThrow({ where: { id: intent.id } })
        expect(r).toMatchObject({ status: 'provisional', smsAlertId: alert.id, bankRef: smsRef, settlingUntil: null })
        expect(r.smsConfirmedAt).toBeInstanceOf(Date)
        expect(['confirmed', 'matched']).toContain((await prisma.bankSmsAlert.findUniqueOrThrow({ where: { id: alert.id } })).status)
        expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('completed')
      }
    } finally {
      await smsOn(A, false)
    }
  })
})

// ─── The bank SMS cross-check (SMS matching on) ─────────────────────────────

describe('a typed reference checked against the bank SMS (SMS matching on)', () => {
  it('the SMS for the reference confirms the receipt; an SMS naming other money refuses the payment; SMS off → not linked', async () => {
    await smsOn(A, true)
    try {
      const o = await ringKheer(app, cashierA, A)
      const smsRef = ref()
      const alert = await mkAlert(A, mgrA, { bankRef: smsRef, amountCents: CARD_TOTAL, bankAccountId: acctA.bankAccountId })
      const r = await payRaast(cashierA, drawerA, o.id, CARD_TOTAL, { gatewayRef: smsRef })
      expect(r.statusCode, r.body).toBe(201)
      expect(r.json().raast[0]).toMatchObject({ smsConfirmed: true, confirmedVia: 'cashier' })
      const rec = await prisma.raastReceipt.findFirstOrThrow({ where: { orderId: o.id } })
      expect(rec.smsAlertId).toBe(alert.id)
      expect(rec.smsConfirmedAt).toBeInstanceOf(Date)
      expect((await prisma.bankSmsAlert.findUniqueOrThrow({ where: { id: alert.id } })).status).toBe('confirmed')

      const o2 = await ringKheer(app, cashierA, A)
      const otherMoney = ref()
      await mkAlert(A, mgrA, { bankRef: otherMoney, amountCents: 50_000, bankAccountId: acctA.bankAccountId })
      const mismatch = await payRaast(cashierA, drawerA, o2.id, CARD_TOTAL, { gatewayRef: otherMoney })
      expect(mismatch.statusCode).toBe(422)
      expect(mismatch.json().error).toMatchObject({ code: 'RAAST_AMOUNT_MISMATCH', details: { smsAmountCents: 50_000 } })
      expect(await writtenFor(o2.id)).toEqual({ payments: 0, receipts: 0 })
    } finally {
      await smsOn(A, false)
    }
    // SMS matching off: the alert is never used to confirm.
    const o3 = await ringKheer(app, cashierA, A)
    const offRef = ref()
    const offAlert = await mkAlert(A, mgrA, { bankRef: offRef, amountCents: CARD_TOTAL, bankAccountId: acctA.bankAccountId, status: 'off' })
    expect((await payRaast(cashierA, drawerA, o3.id, CARD_TOTAL, { gatewayRef: offRef })).json().raast[0].smsConfirmed).toBe(false)
    expect((await prisma.bankSmsAlert.findUniqueOrThrow({ where: { id: offAlert.id } })).status).toBe('off')
  })

  it("M4 — a reference a manager dismissed as 'not a sale', or a debit's, never pays a bill (409 RAAST_REF_DISMISSED)", async () => {
    const dismissed = ref()
    await mkAlert(A, mgrA, { bankRef: dismissed, amountCents: CARD_TOTAL, bankAccountId: acctA.bankAccountId, status: 'dismissed', claimedRef: dismissed })
    const debit = ref()
    await mkAlert(A, mgrA, { bankRef: debit, amountCents: CARD_TOTAL, bankAccountId: acctA.bankAccountId, kind: 'debit', status: 'unmatched' })
    for (const theRef of [dismissed, debit]) {
      const o = await ringKheer(app, cashierA, A)
      const r = await payRaast(cashierA, drawerA, o.id, CARD_TOTAL, { gatewayRef: theRef })
      expect(r.statusCode, r.body).toBe(409)
      expect(r.json().error.code).toBe('RAAST_REF_DISMISSED')
      expect(await writtenFor(o.id)).toEqual({ payments: 0, receipts: 0 })
    }
    // Company B is not bound by A's claims.
    const ob = await ringKheer(app, cashierB, B)
    expect((await payRaast(cashierB, drawerB, ob.id, CARD_TOTAL, { gatewayRef: dismissed })).statusCode).toBe(201)
  })

  it("a bank SMS that is settling another bill right now is that bill's (409 RAAST_SMS_IN_USE)", async () => {
    await smsOn(A, true)
    try {
      const o1 = await ringKheer(app, cashierA2, A)
      const smsRef = ref()
      const alert = await mkAlert(A, mgrA, { bankRef: smsRef, amountCents: CARD_TOTAL, bankAccountId: acctA.bankAccountId, status: 'processing' })
      const leased = await mkIntent(A, acctA, o1.id, drawerA2, cashierA2, CARD_TOTAL, { smsAlertId: alert.id, settlingUntil: new Date(Date.now() + 60_000) })
      const o2 = await ringKheer(app, cashierA, A)
      const r = await payRaast(cashierA, drawerA, o2.id, CARD_TOTAL, { gatewayRef: smsRef })
      expect(r.statusCode, r.body).toBe(409)
      expect(r.json().error).toMatchObject({ code: 'RAAST_SMS_IN_USE', details: { orderRef: orderRefOf(o1.id) } })
      expect(await writtenFor(o2.id)).toEqual({ payments: 0, receipts: 0 })
      expect(await prisma.raastReceipt.findUniqueOrThrow({ where: { id: leased.id } })).toMatchObject({ smsAlertId: alert.id, status: 'awaiting' })
      await prisma.raastReceipt.update({ where: { id: leased.id }, data: { status: 'cancelled', smsAlertId: null, settlingUntil: null } })
    } finally {
      await smsOn(A, false)
    }
  })
})

// ─── S6 ──────────────────────────────────────────────────────────────────────

describe('S6 — a Raast receipt left needing attention', () => {
  it('the bill settled another way raises raast_needs_attention for finance on that receipt', async () => {
    const o = await ringKheer(app, cashierA2, A)
    const r = await mkIntent(A, acctA, o.id, drawerA2, cashierA2, CARD_TOTAL, { status: 'needs_attention', attentionReason: 'AMOUNT_MISMATCH' })
    const cash = await call(cashierA2, 'POST', '/pos/payments', { orderId: o.id, shiftId: drawerA2, payments: [{ method: 'cash', amountCents: CASH_TOTAL }] })
    expect(cash.statusCode, cash.body).toBe(201)
    expect(cash.json().orderCompleted).toBe(true)
    const flag = await prisma.exceptionFlag.findFirst({ where: { tenantId: A.tenantId, kind: 'raast_needs_attention', entityType: 'RaastReceipt', entityId: r.id, status: 'open' } })
    expect(flag).not.toBeNull()
    expect(flag!.description).toContain('settled another way')
    expect(await prisma.raastReceipt.findUniqueOrThrow({ where: { id: r.id } })).toMatchObject({ status: 'needs_attention', attentionReason: 'settled_otherwise' })
    // Company B's inbox never sees it.
    expect(await prisma.exceptionFlag.count({ where: { tenantId: B.tenantId, kind: 'raast_needs_attention' } })).toBe(0)
  })

  it('a re-split clears the target of a receipt that pointed at a replaced portion', async () => {
    const o = await ringKheer(app, cashierA2, A)
    const split = await call(cashierA2, 'POST', `/check-split/orders/${o.id}/split`, { splits: [{ amountCents: 60_000, method: 'raast' }, { amountCents: CASH_TOTAL - 60_000, method: 'cash' }] })
    const [portion] = split.json() as Array<{ id: string }>
    const r = await mkIntent(A, acctA, o.id, drawerA2, cashierA2, 60_000, { status: 'needs_attention', targetPaymentId: portion!.id })
    const again = await call(cashierA2, 'POST', `/check-split/orders/${o.id}/split-evenly`, { ways: 2, method: 'cash' })
    expect(again.statusCode, again.body).toBe(200)
    expect(await prisma.payment.count({ where: { id: portion!.id } })).toBe(0)
    expect((await prisma.raastReceipt.findUniqueOrThrow({ where: { id: r.id } })).targetPaymentId).toBeNull()
  })
})

// ─── Z-report ────────────────────────────────────────────────────────────────

describe('the Z-report counts Raast takings', () => {
  it('raastSales / count / provisional / matched; totalSales = cash + card + Raast; card stays card', async () => {
    const cashier = await mkUser('rtill-z', 'cashier', A.tenantId)
    const drawer = await openDrawer(A, cashier)
    const o1 = await ringKheer(app, cashier, A)
    const o2 = await ringKheer(app, cashier, A)
    const o3 = await ringKheer(app, cashier, A)
    expect((await payRaast(cashier, drawer, o1.id, CARD_TOTAL)).statusCode).toBe(201)
    expect((await payRaast(cashier, drawer, o2.id, CARD_TOTAL + 2_000, { tipCents: 2_000 })).statusCode).toBe(201)
    expect((await call(cashier, 'POST', '/pos/payments', { orderId: o3.id, shiftId: drawer, payments: [{ method: 'cash', amountCents: CASH_TOTAL }] })).statusCode).toBe(201)
    // The bank statement has matched the first one.
    await prisma.raastReceipt.updateMany({ where: { orderId: o1.id }, data: { status: 'matched', matchedAt: new Date() } })

    const z = await getZReport(drawer)
    expect(z).toMatchObject({
      cashSales: CASH_TOTAL,
      cardSales: 0,
      raastSales: CARD_TOTAL * 2 + 2_000,
      raastCount: 2,
      raastMatchedCents: CARD_TOTAL,
      raastProvisionalCents: CARD_TOTAL + 2_000,
      raastUnreceivedCents: 0,
      totalSales: CASH_TOTAL + CARD_TOTAL * 2 + 2_000,
      grossCents: CASH_TOTAL + CARD_TOTAL * 2 + 2_000,
      tipsCents: 2_000,
      salesExTipsCents: CASH_TOTAL + CARD_TOTAL * 2,
    })
    expect(z.byMethod).toEqual(expect.arrayContaining([{ method: 'raast', count: 2, amountCents: CARD_TOTAL * 2 + 2_000 }]))
    expect(z.cancelledPaid).toMatchObject({ raastCents: 0 })
    // The drawer's cash is only its cash.
    expect(z.expectedCashCents).toBe(CASH_TOTAL)
  })
})
