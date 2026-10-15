// Raast QR refunds and hand-backs (2026-10-12) — Stream B, spec §4.4–4.6.
//
// What this guards:
//   - A Raast refund is money a person sends back from the company's bank, so
//     a MANAGER always approves it — even when the company lets a cashier
//     refund on their own: a cashier gets 403 MANAGER_OVERRIDE_REQUIRED, company
//     A's manager PIN approves (recorded), company B's PIN is 403
//     INVALID_MANAGER_PIN. The outgoing transfer's reference is required (400
//     RAAST_REFUND_REF_REQUIRED), validated, NOT unique.
//   - The refund row is gateway 'raast' with the outgoing reference and
//     gatewayMeta.raast = the receipt it goes back against (its bank account
//     and ledger code); one refund never spans two receipts (422
//     RAAST_REFUND_SPLIT); the ledger credits the receiving bank, never 1030;
//     the fiscal refund lists a raast tender.
//   - A refund goes back the way the money came: a Raast sale is not refunded
//     by card, a cash sale not by Raast; an old Keenu QR sale is refunded by
//     keenu_qr exactly as before (Cr 1030), never by Raast.
//   - A void on a paid, still-open Raast bill needs the outgoing reference (409
//     RAAST_REFUND_REFERENCE_REQUIRED {amountCents}) and books the same
//     receipt link.
//   - LEDGER-R5: a cancelled ticket's Raast money is parked by ACCOUNT CODE —
//     the receiving bank's — and every hand-back nets revenue, tax, 1110 and
//     the bank code to zero, whatever was posted before the cancel (R5-A/B/C).
//
// Two companies throughout. Requires a disposable database (DATABASE_URL must
// contain "test").
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { AppError, errorResponse } from '../src/lib/errors.js'
import { posRoutes } from '../src/modules/pos/routes.js'
import { checkSplitRoutes } from '../src/modules/checkSplit/routes.js'
import { registerConnectorPlugins } from '../src/modules/connectors/index.js'
import { setFiscalKicker } from '../src/connectors/fiscal/outbox.js'
import { setManagerPin } from '../src/modules/auth/managerPin.js'
import { invalidateSetupCache, getRefundPolicy } from '../src/lib/setup-config.js'
import { refundOrder, voidOrderItem, processPayment } from '../src/modules/pos/service.js'
import { refundDueCents, postRefundPayment } from '../src/modules/accounting/orderPosting.js'
import { postShiftClose } from '../src/modules/accounting/shiftPosting.js'
import {
  prisma, mkCompany, mkUser, caller, setConnector, resetConnectorCache, openDrawer, ringKheer, mkOrder, mkRaastAccount,
  type Company, type Who,
} from './connectorsFixtures.js'

let app: FastifyInstance
let call: ReturnType<typeof caller>
let A: Company, B: Company
let cashierA: Who, mgrA: Who, mgrB: Who, cashierB: Who
let drawerA: string, drawerB: string
let acctA: { bankAccountId: string; ledgerCode: string }
const PIN_A = '7351'
const PIN_B = '8462'
const CARD_TOTAL = 118_800   // 2 × Kheer at the card / Raast rate
const CASH_TOTAL = 126_500

let seq = 0
const ref = () => `UBL${Date.now().toString().slice(-7)}${String(++seq).padStart(3, '0')}`

async function build(): Promise<FastifyInstance> {
  const a = Fastify()
  a.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await a.register(posRoutes, { prefix: '/pos' })
  await a.register(checkSplitRoutes, { prefix: '/check-split' })
  await registerConnectorPlugins(a)
  await a.ready()
  return a
}

/** A till sale of company A paid in full by Raast at the till (through the real route). */
async function raastSale(): Promise<{ orderId: string; receiptId: string; paymentId: string }> {
  const o = await ringKheer(app, cashierA, A)
  const r = await call(cashierA, 'POST', '/pos/payments', { orderId: o.id, shiftId: drawerA, payments: [{ method: 'raast', amountCents: CARD_TOTAL, gatewayRef: ref(), raastVerified: true }] })
  expect(r.statusCode, r.body).toBe(201)
  return { orderId: o.id, receiptId: r.json().raast[0].receiptId, paymentId: r.json().payments[0].id }
}

const refundCall = (who: Who, orderId: string, body: Record<string, unknown>) =>
  call(who, 'POST', `/pos/orders/${orderId}/refund`, { reason: 'Guest unhappy with the dish', ...body })

type Line = { code: string; type: string; amount: number }
async function linesOf(tenantId: string, references: string[]): Promise<Line[]> {
  const rows = await prisma.journalLine.findMany({
    where: { journalEntry: { tenantId, reference: { in: references } } },
    select: { type: true, amountCents: true, account: { select: { code: true, tenantId: true } } },
  })
  for (const r of rows) expect(r.account.tenantId).toBe(tenantId)
  return rows.map((r) => ({ code: r.account.code, type: r.type, amount: r.amountCents }))
}
const amt = (lines: Line[], code: string, type: 'debit' | 'credit') =>
  lines.filter((l) => l.code === code && l.type === type).reduce((t, l) => t + l.amount, 0)
/** Accounts that do not net to zero (debit +). */
const nonZero = (lines: Line[]) => {
  const net = new Map<string, number>()
  for (const l of lines) net.set(l.code, (net.get(l.code) ?? 0) + (l.type === 'debit' ? l.amount : -l.amount))
  return Object.fromEntries([...net].filter(([, v]) => v !== 0))
}

beforeAll(async () => {
  setFiscalKicker(async () => {})
  A = await mkCompany('rref-a')
  B = await mkCompany('rref-b')
  cashierA = await mkUser('rref-cashier-a', 'cashier', A.tenantId)
  mgrA = await mkUser('rref-mgr-a', 'foh_management', A.tenantId)
  cashierB = await mkUser('rref-cashier-b', 'cashier', B.tenantId)
  mgrB = await mkUser('rref-mgr-b', 'foh_management', B.tenantId)
  await setManagerPin(mgrA.id, PIN_A)
  await setManagerPin(mgrB.id, PIN_B)
  drawerA = await openDrawer(A, cashierA)
  drawerB = await openDrawer(B, cashierB)
  acctA = await mkRaastAccount(A)
  await mkRaastAccount(B)
  await setConnector(A.tenantId, 'fiscal', { driver: 'test', enabled: true, settings: {} })
  app = await build()
  call = caller(app)
}, 60_000)

afterAll(async () => {
  // Every entry this suite wrote, in either company, balances.
  const entries = await prisma.journalEntry.findMany({ where: { tenantId: { in: [A.tenantId, B.tenantId] } }, include: { lines: true } })
  for (const e of entries) {
    const d = e.lines.filter((l) => l.type === 'debit').reduce((t, l) => t + l.amountCents, 0)
    const c = e.lines.filter((l) => l.type === 'credit').reduce((t, l) => t + l.amountCents, 0)
    expect(d, `entry ${e.reference} balances`).toBe(c)
  }
  setFiscalKicker(null)
  resetConnectorCache()
  await app?.close()
})

// ─── Manager-only, with the outgoing reference ──────────────────────────────

describe('a Raast refund: a manager always approves it, with the outgoing transfer\'s reference', () => {
  it("even where a cashier may refund alone: the cashier is 403, B's PIN is refused, A's manager PIN approves and is recorded", async () => {
    // Company A lets cashiers refund up to PKR 10,000 on their own.
    await getRefundPolicy(A.tenantId)    // the company's policy row exists (created on first read)
    await prisma.refundPolicy.updateMany({ where: { tenantId: A.tenantId }, data: { cashierRefundLimitCents: 1_000_000 } })
    invalidateSetupCache()
    expect((await getRefundPolicy(A.tenantId)).cashierRefundLimitCents).toBe(1_000_000)
    try {
      // A cash sale: the cashier refunds part of it alone (the company's own rule).
      const cashSale = await ringKheer(app, cashierA, A)
      expect((await call(cashierA, 'POST', '/pos/payments', { orderId: cashSale.id, shiftId: drawerA, payments: [{ method: 'cash', amountCents: CASH_TOTAL }] })).statusCode).toBe(201)
      expect((await refundCall(cashierA, cashSale.id, { amountCents: 10_000, method: 'cash' })).statusCode).toBe(200)

      // A Raast sale: the same cashier, the same amount — a manager must approve.
      const s = await raastSale()
      const alone = await refundCall(cashierA, s.orderId, { amountCents: 10_000, method: 'raast', gatewayRef: ref() })
      expect(alone.statusCode).toBe(403)
      expect(alone.json().error.code).toBe('MANAGER_OVERRIDE_REQUIRED')
      const otherCo = await refundCall(cashierA, s.orderId, { amountCents: 10_000, method: 'raast', gatewayRef: ref(), managerOverridePin: PIN_B })
      expect(otherCo.statusCode).toBe(403)
      expect(otherCo.json().error.code).toBe('INVALID_MANAGER_PIN')
      expect(await prisma.payment.count({ where: { orderId: s.orderId, status: 'refunded' } })).toBe(0)

      const outgoing = ref()
      const ok = await refundCall(cashierA, s.orderId, { amountCents: 10_000, method: 'raast', gatewayRef: outgoing.toLowerCase(), managerOverridePin: PIN_A })
      expect(ok.statusCode, ok.body).toBe(200)
      expect(ok.json()).toMatchObject({ method: 'raast', amountCents: -10_000, gateway: 'raast', gatewayRef: outgoing, orderRefunded: false })
      const row = await prisma.payment.findUniqueOrThrow({ where: { id: ok.json().id } })
      expect(row.gatewayMeta).toMatchObject({
        refund: { approverId: mgrA.id, actorId: cashierA.id },
        raast: { receiptId: s.receiptId, bankAccountId: acctA.bankAccountId, ledgerCode: acctA.ledgerCode },
      })
      const a = await prisma.auditLog.findFirstOrThrow({ where: { entityId: s.orderId, action: 'order_refund' } })
      expect(a.metadata).toMatchObject({ approverId: mgrA.id, method: 'raast', raast: { outgoingRef: outgoing, receiptId: s.receiptId } })
    } finally {
      await prisma.refundPolicy.updateMany({ where: { tenantId: A.tenantId }, data: { cashierRefundLimitCents: 0 } })
      invalidateSetupCache()
    }
  })

  it('the outgoing reference is required and validated, but not unique; a manager signed in approves it themselves', async () => {
    const s1 = await raastSale()
    const missing = await refundCall(mgrA, s1.orderId, { amountCents: 5_000, method: 'raast' })
    expect(missing.statusCode).toBe(400)
    expect(missing.json().error.code).toBe('RAAST_REFUND_REF_REQUIRED')
    const invalid = await refundCall(mgrA, s1.orderId, { amountCents: 5_000, method: 'raast', gatewayRef: 'ABCDEF' })
    expect(invalid.statusCode).toBe(422)
    expect(invalid.json().error.code).toBe('RAAST_REF_INVALID')
    expect(await prisma.payment.count({ where: { orderId: s1.orderId, status: 'refunded' } })).toBe(0)

    // One outgoing bank transfer can repay two bills (it is not a customer's payment claim).
    const batch = ref()
    const s2 = await raastSale()
    const r1 = await refundCall(mgrA, s1.orderId, { amountCents: 5_000, method: 'raast', gatewayRef: batch })
    const r2 = await refundCall(mgrA, s2.orderId, { amountCents: 6_000, method: 'raast', gatewayRef: batch })
    expect([r1.statusCode, r2.statusCode]).toEqual([200, 200])
    expect((r1.json().gatewayMeta as { refund: { approverId: string } }).refund.approverId).toBe(mgrA.id)
  })

  it('the refund credits the receiving bank (never 1030) and its fiscal return lists a raast tender', async () => {
    const s = await raastSale()
    const r = await refundCall(mgrA, s.orderId, { amountCents: 20_000, method: 'raast', gatewayRef: ref() })
    expect(r.statusCode, r.body).toBe(200)
    const e = await linesOf(A.tenantId, [`order.refund:${r.json().id}`])
    expect(amt(e, acctA.ledgerCode, 'credit')).toBe(20_000)
    expect(e.some((l) => l.code === '1030')).toBe(false)
    const doc = await prisma.fiscalDocument.findFirstOrThrow({ where: { orderId: s.orderId, kind: 'refund', refundPaymentId: r.json().id } })
    expect((doc.payload as { payment: { tenders: unknown[] } }).payment.tenders).toEqual([{ method: 'raast', amountCents: 20_000 }])
  })

  it('one refund goes back against ONE receipt (422 RAAST_REFUND_SPLIT); the next goes against the receipt with the most left', async () => {
    const o = await ringKheer(app, cashierA, A)
    const split = await call(cashierA, 'POST', `/check-split/orders/${o.id}/split`, { splits: [{ amountCents: 50_000, method: 'raast' }, { amountCents: CARD_TOTAL - 50_000, method: 'raast' }] })
    expect(split.statusCode, split.body).toBe(200)
    const portions = split.json() as Array<{ id: string; amountCents: number }>
    for (const p of portions) {
      const s = await call(cashierA, 'POST', `/check-split/payments/${p.id}/settle`, { shiftId: drawerA, gatewayRef: ref(), raastVerified: true })
      expect(s.statusCode, s.body).toBe(200)
    }
    const receipts = await prisma.raastReceipt.findMany({ where: { orderId: o.id } })
    const big = receipts.find((r) => r.amountCents === CARD_TOTAL - 50_000)!
    const small = receipts.find((r) => r.amountCents === 50_000)!

    const tooMuch = await refundCall(mgrA, o.id, { amountCents: 80_000, method: 'raast', gatewayRef: ref() })
    expect(tooMuch.statusCode).toBe(422)
    expect(tooMuch.json().error).toMatchObject({ code: 'RAAST_REFUND_SPLIT', details: { maxCents: CARD_TOTAL - 50_000 } })
    const first = await refundCall(mgrA, o.id, { amountCents: 60_000, method: 'raast', gatewayRef: ref() })
    expect(first.statusCode, first.body).toBe(200)
    expect((first.json().gatewayMeta as { raast: { receiptId: string } }).raast.receiptId).toBe(big.id)
    // Left: big 8,800, small 50,000 → the next 30,000 goes against the small one.
    const second = await refundCall(mgrA, o.id, { amountCents: 30_000, method: 'raast', gatewayRef: ref() })
    expect((second.json().gatewayMeta as { raast: { receiptId: string } }).raast.receiptId).toBe(small.id)
    // 28,800 is still refundable on the bill, but at most 20,000 on one receipt.
    const third = await refundCall(mgrA, o.id, { amountCents: 28_800, method: 'raast', gatewayRef: ref() })
    expect(third.json().error).toMatchObject({ code: 'RAAST_REFUND_SPLIT', details: { maxCents: 20_000 } })
  })
})

// ─── The way the money came ──────────────────────────────────────────────────

describe('a refund goes back the way the money came', () => {
  it('a Raast sale is not refunded by card, a cash sale not by Raast', async () => {
    const s = await raastSale()
    const byCard = await refundCall(mgrA, s.orderId, { amountCents: 1_000, method: 'card' })
    expect(byCard.statusCode).toBe(422)
    expect(byCard.json().error.code).toBe('REFUND_METHOD_NOT_TENDERED')
    const cashSale = await ringKheer(app, cashierA, A)
    expect((await call(cashierA, 'POST', '/pos/payments', { orderId: cashSale.id, shiftId: drawerA, payments: [{ method: 'cash', amountCents: CASH_TOTAL }] })).statusCode).toBe(201)
    const byRaast = await refundCall(mgrA, cashSale.id, { amountCents: 1_000, method: 'raast', gatewayRef: ref() })
    expect(byRaast.statusCode).toBe(422)
    expect(byRaast.json().error.code).toBe('REFUND_METHOD_NOT_TENDERED')
  })

  it('an old Keenu QR sale is refunded by keenu_qr exactly as before (Cr 1030), never by Raast', async () => {
    const orderId = await mkOrder(A, {
      items: [{ menuItemId: A.items.kheer, name: 'Kheer', quantity: 2, unitPriceCents: 55_000 }],
      taxCents: 8_800, taxRatePct: 8, totalCents: CARD_TOTAL, payments: [{ method: 'keenu_qr', amountCents: CARD_TOTAL }],
    })
    const byRaast = await refundCall(mgrA, orderId, { amountCents: 1_000, method: 'raast', gatewayRef: ref() })
    expect(byRaast.statusCode).toBe(422)
    expect(byRaast.json().error.code).toBe('REFUND_METHOD_NOT_TENDERED')
    const old = await refundCall(mgrA, orderId, { amountCents: 10_000, method: 'keenu_qr' })
    expect(old.statusCode, old.body).toBe(200)
    expect(old.json()).toMatchObject({ method: 'keenu_qr', gateway: 'none', amountCents: -10_000 })
    expect((old.json().gatewayMeta as Record<string, unknown>)['raast']).toBeUndefined()
    const e = await linesOf(A.tenantId, [`order.refund:${old.json().id}`])
    expect(amt(e, '1030', 'credit')).toBe(10_000)
  })

  it("company B's manager cannot refund company A's Raast sale (404)", async () => {
    const s = await raastSale()
    const r = await refundCall(mgrB, s.orderId, { amountCents: 1_000, method: 'raast', gatewayRef: ref() })
    expect(r.statusCode).toBe(404)
    expect(await prisma.payment.count({ where: { orderId: s.orderId, status: 'refunded' } })).toBe(0)
  })
})

// ─── A void on a paid, still-open Raast bill (TILL-R3) ──────────────────────

describe('a void on a paid, still-open Raast bill', () => {
  it('needs the outgoing transfer\'s reference (409 RAAST_REFUND_REFERENCE_REQUIRED {amountCents}); with it the line goes back against the receipt', async () => {
    // A pickup order paid in full at the till by Raast — still in the kitchen (completes at hand-off).
    const o = await prisma.order.create({
      data: {
        conceptId: A.conceptId, source: 'servd', fulfilmentType: 'takeout', status: 'preparing', totalCents: 108_000, taxCents: 8_000, taxRatePct: 8,
        items: { create: [{ name: 'Tea', quantity: 1, unitPriceCents: 40_000 }, { name: 'Cake', quantity: 1, unitPriceCents: 60_000 }] },
      },
      include: { items: true },
    })
    const paid = await processPayment({
      orderId: o.id, shiftId: drawerA, actorId: cashierA.id,
      payments: [{ method: 'raast', amountCents: 108_000, gatewayRef: ref(), raast: { via: 'cashier', cashierVerified: true } }],
    })
    expect(paid.orderCompleted).toBe(false)
    const receipt = await prisma.raastReceipt.findFirstOrThrow({ where: { orderId: o.id } })
    const tea = o.items.find((i) => i.name === 'Tea')!

    await expect(voidOrderItem({ orderId: o.id, orderItemId: tea.id, reason: 'Tea went cold', actorId: mgrA.id, actorRole: 'foh_management' }))
      .rejects.toMatchObject({ code: 'RAAST_REFUND_REFERENCE_REQUIRED', statusCode: 409, details: { amountCents: 43_200 } })
    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: tea.id } })).status).not.toBe('voided')
    expect(await prisma.payment.count({ where: { orderId: o.id, status: 'refunded' } })).toBe(0)

    const outgoing = ref()
    const v = await voidOrderItem({ orderId: o.id, orderItemId: tea.id, reason: 'Tea went cold', actorId: mgrA.id, actorRole: 'foh_management', refundReference: outgoing })
    expect(v.refund).toMatchObject({ amountCents: 43_200, method: 'raast' })
    const row = await prisma.payment.findUniqueOrThrow({ where: { id: v.refund!.id } })
    expect(row).toMatchObject({ method: 'raast', gateway: 'raast', gatewayRef: outgoing, amountCents: -43_200 })
    expect(row.gatewayMeta).toMatchObject({
      refund: { approverId: mgrA.id, voidedItemId: tea.id },
      raast: { receiptId: receipt.id, bankAccountId: acctA.bankAccountId, ledgerCode: acctA.ledgerCode },
    })
  })
})

// ─── LEDGER-R5 with Raast money ─────────────────────────────────────────────

describe('LEDGER-R5 — a cancelled ticket\'s Raast money is parked on its bank code and nets to zero', () => {
  /** A fresh drawer of company A for `who`, without closing their others. */
  const mkDrawer = (who: Who, openingFloatCents = 0) =>
    prisma.shift.create({ data: { userId: who.id, openingFloatCents, status: 'open', tenantId: A.tenantId } }).then((s) => s.id)
  const closeAndPost = async (shiftId: string, countedCents: number) => {
    await prisma.shift.update({ where: { id: shiftId }, data: { status: 'closed', closedAt: new Date(), closingFloatCents: countedCents } })
    const r = await postShiftClose(shiftId)
    expect(r.posted, r.reason).toBe(true)
  }
  const cancel = (id: string) => prisma.order.update({ where: { id }, data: { status: 'cancelled' } })
  const take = (orderId: string, shiftId: string, amountCents: number) =>
    prisma.payment.create({ data: { orderId, shiftId, method: 'cash', amountCents, status: 'paid', processedAt: new Date() } })
  /** Raast money taken at the till (the payment and its provisional receipt, as the till writes them). */
  const takeRaast = async (orderId: string, shiftId: string, amountCents: number) => {
    const bankRef = ref()
    const p = await prisma.payment.create({ data: { orderId, shiftId, method: 'raast', amountCents, status: 'paid', gateway: 'raast', gatewayRef: bankRef, processedAt: new Date() } })
    const r = await prisma.raastReceipt.create({
      data: {
        tenantId: A.tenantId, orderId, conceptId: A.conceptId, shiftId, paymentId: p.id, bankAccountId: acctA.bankAccountId, ledgerCode: acctA.ledgerCode,
        amountCents, tipCents: 0, dueCents: amountCents, bankRef, bankRefRaw: bankRef, status: 'provisional', confirmedVia: 'cashier',
        confirmedAt: new Date(), confirmedById: cashierA.id, cashierVerified: true, idempotencyKey: `pay:${p.id}`, createdById: cashierA.id,
      },
    })
    return { payment: p, receipt: r }
  }
  /** A TILL-R3 void refund by Raast on the still-open ticket (the engine's own row + entry). */
  const voidRefundRaast = async (orderId: string, shiftId: string, receiptId: string, cents: number) => {
    const r = await prisma.payment.create({
      data: {
        orderId, shiftId, method: 'raast', amountCents: -cents, status: 'refunded', gateway: 'raast', gatewayRef: ref(), processedAt: new Date(),
        gatewayMeta: { refund: { reason: 'Void', approverId: mgrA.id, actorId: mgrA.id }, raast: { receiptId, bankAccountId: acctA.bankAccountId, ledgerCode: acctA.ledgerCode } },
      },
    })
    expect((await postRefundPayment(r.id)).entryId).toBeTruthy()
    return r
  }
  const handBack = (orderId: string, amountCents: number, method: 'raast' | 'cash' = 'raast', shiftId?: string) =>
    refundOrder({
      orderId, amountCents, reason: 'Cancelled — handed back', actorId: mgrA.id, actorRole: 'foh_management', method,
      ...(method === 'raast' && { gatewayRef: ref() }), ...(shiftId && { shiftId }),
    })
  /** Every entry that touched the ticket: the given drawer closes, its refund rows, its unwind. */
  const books = async (orderId: string, closes: string[]) => {
    const refunds = await prisma.payment.findMany({ where: { orderId, status: 'refunded' }, select: { id: true } })
    return linesOf(A.tenantId, [...closes.map((s) => `shift.close:${s}`), ...refunds.map((r) => `order.refund:${r.id}`), `order.cancel_unwind:${orderId}`])
  }
  const due = async (orderId: string) => refundDueCents(await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { payments: true } }))
  const online = (totalCents = 11_500, taxCents = 1_500) =>
    prisma.order.create({ data: { conceptId: A.conceptId, source: 'servd', fulfilmentType: 'takeout', status: 'preparing', totalCents, taxCents, taxRatePct: 15 } })
  const BANK = () => acctA.ledgerCode

  it('cancelled before the close: the hand-back is Dr 1110 / Cr the bank (never 1030); the close holds it Dr bank / Cr 1110 — both net to zero', async () => {
    const s1 = await mkDrawer(mgrA)
    const o = await prisma.order.create({ data: { conceptId: A.conceptId, source: 'pos', fulfilmentType: 'dine_in', status: 'preparing', shiftId: s1, totalCents: 11_500, taxCents: 1_500, taxRatePct: 15 } })
    await takeRaast(o.id, s1, 11_500)
    await cancel(o.id)
    expect(await due(o.id)).toBe(11_500)
    const r = await handBack(o.id, 11_500)
    expect(r).toMatchObject({ method: 'raast', gateway: 'raast', orderRefunded: false, refundDueLeftCents: 0 })
    const h = await linesOf(A.tenantId, [`order.refund:${r.id}`])
    expect(h).toEqual(expect.arrayContaining([{ code: '1110', type: 'debit', amount: 11_500 }, { code: BANK(), type: 'credit', amount: 11_500 }]))
    expect(h.some((l) => l.code === '1030')).toBe(false)
    await closeAndPost(s1, 0)
    const close = await linesOf(A.tenantId, [`shift.close:${s1}`])
    expect(amt(close, BANK(), 'debit')).toBe(11_500)
    expect(amt(close, '1110', 'credit')).toBe(11_500)
    const all = await books(o.id, [s1])
    expect(nonZero(all)).toEqual({})
    expect(all.filter((l) => /^(4|2030|2032|7)/.test(l.code))).toEqual([])
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe('cancelled')
  })

  it('R5-A — an online order whose drawer closed BEFORE the cancel: Raast the close never booked goes back against the bank code itself', async () => {
    const s1 = await mkDrawer(mgrA)
    const o = await online()
    await takeRaast(o.id, s1, 4_000)
    await take(o.id, s1, 7_500)
    await closeAndPost(s1, 7_500)              // live then: only the cash moved (Dr 1015 / Cr 1010)
    await cancel(o.id)
    const s2 = await mkDrawer(mgrA, 20_000)
    const back = await handBack(o.id, 4_000, 'raast', s2)
    expect(await linesOf(A.tenantId, [`order.refund:${back.id}`])).toEqual(expect.arrayContaining([
      { code: BANK(), type: 'debit', amount: 4_000 }, { code: BANK(), type: 'credit', amount: 4_000 },
    ]))
    await handBack(o.id, 7_500, 'cash', s2)
    expect(nonZero(await books(o.id, [s1]))).toEqual({})
  })

  it('R5-B — a Raast void refund while open, then the cancel: the sale-refund shares are undone once; 1110 / revenue / GST / the bank net to zero', async () => {
    const s1 = await mkDrawer(mgrA)
    const o = await online()
    const { receipt } = await takeRaast(o.id, s1, 11_500)
    await voidRefundRaast(o.id, s1, receipt.id, 2_300)      // Dr 4xxx 2,000 / Dr output tax 300 / Cr bank 2,300
    await cancel(o.id)
    expect(await due(o.id)).toBe(9_200)
    await handBack(o.id, 5_000)
    expect(await prisma.journalEntry.count({ where: { tenantId: A.tenantId, reference: `order.cancel_unwind:${o.id}` } })).toBe(1)
    await handBack(o.id, 4_200)
    expect(await due(o.id)).toBe(0)
    // Both hand-backs went back against the one receipt, which is now fully repaid.
    const backs = await prisma.payment.findMany({ where: { orderId: o.id, status: 'refunded' } })
    expect(backs.every((b) => (b.gatewayMeta as { raast?: { receiptId?: string } }).raast?.receiptId === receipt.id)).toBe(true)
    await expect(handBack(o.id, 1)).rejects.toMatchObject({ code: 'NOTHING_TO_REFUND' })
    await closeAndPost(s1, 0)                   // after the cancel: Dr bank / Cr 1110 refund due, gross 11,500
    const all = await books(o.id, [s1])
    expect(all.some((l) => /^203\d$/.test(l.code))).toBe(true)   // the void refund's GST share is in the set
    expect(nonZero(all)).toEqual({})
  })

  it('R5-C — a till bill whose home drawer booked the sale (Raast on the bank), then cancelled: the sale is reversed, the 1110 receivable cleared', async () => {
    const s1 = await mkDrawer(mgrA)
    const o = await prisma.order.create({ data: { conceptId: A.conceptId, source: 'pos', fulfilmentType: 'dine_in', status: 'preparing', shiftId: s1, totalCents: 11_500, taxCents: 1_500, taxRatePct: 15 } })
    await takeRaast(o.id, s1, 5_000)
    await closeAndPost(s1, 0)                   // Cr revenue 10,000 / Cr output tax 1,500 / Dr bank 5,000 / Dr 1110 6,500
    const close = await linesOf(A.tenantId, [`shift.close:${s1}`])
    expect(amt(close, BANK(), 'debit')).toBe(5_000)
    expect(close.some((l) => l.code === '1030')).toBe(false)
    await cancel(o.id)
    const s2 = await mkDrawer(mgrA, 20_000)
    const r = await handBack(o.id, 5_000, 'raast', s2)
    const u = await linesOf(A.tenantId, [`order.cancel_unwind:${o.id}`])
    expect(u.filter((l) => /^203\d$/.test(l.code) && l.type === 'debit').reduce((t, l) => t + l.amount, 0)).toBe(1_500)
    expect(amt(u, '1110', 'credit')).toBe(11_500)
    const h = await linesOf(A.tenantId, [`order.refund:${r.id}`])
    expect(h.filter((l) => /^(4|7|203)/.test(l.code))).toEqual([])   // the hand-back itself is never a sale refund
    expect(amt(h, BANK(), 'credit')).toBe(5_000)
    expect(nonZero(await books(o.id, [s1]))).toEqual({})
  })

  it("a cashier's Raast hand-back on a cancelled ticket needs A's manager (B's PIN refused); company B never sees A's ticket", async () => {
    const s1 = await mkDrawer(mgrA)
    const o = await prisma.order.create({ data: { conceptId: A.conceptId, source: 'pos', fulfilmentType: 'dine_in', status: 'preparing', shiftId: s1, totalCents: 11_500, taxCents: 1_500, taxRatePct: 15 } })
    await takeRaast(o.id, s1, 11_500)
    await cancel(o.id)
    const base = { orderId: o.id, amountCents: 11_500, reason: 'Cancelled — handed back', actorId: cashierA.id, actorRole: 'cashier', method: 'raast' as const, gatewayRef: ref() }
    await expect(refundOrder(base)).rejects.toMatchObject({ code: 'MANAGER_OVERRIDE_REQUIRED', statusCode: 403 })
    await expect(refundOrder({ ...base, managerOverridePin: PIN_B })).rejects.toMatchObject({ code: 'INVALID_MANAGER_PIN' })
    const viaB = await refundCall(mgrB, o.id, { amountCents: 11_500, method: 'raast', gatewayRef: ref() })
    expect(viaB.statusCode).toBe(404)
    const ok = await refundOrder({ ...base, managerOverridePin: PIN_A })
    expect((ok.gatewayMeta as { refund: { approverId: string } }).refund.approverId).toBe(mgrA.id)
    expect(await due(o.id)).toBe(0)
  })
})
