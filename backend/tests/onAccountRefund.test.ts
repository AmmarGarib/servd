// On-account clients at the till (2026-10-15, parked B resumed) — the till
// engine in pos/service.ts.
//
// What this guards:
//   - A refund of a bill charged to a client's account goes back to the
//     account through THE refund engine: Cr 1110 (memo ON ACCOUNT), a fiscal
//     refund document whose tender is on_account, the charge's refundedCents
//     raised, a billed statement credited and re-statused — and no drawer is
//     touched (the refund row sits on no shift; nothing on 1010 / 1015 / 1030).
//   - A refund the ledger refuses (a closed period) saves nothing: no refund
//     row, no fiscal document, the charge unchanged.
//   - Only the tender it was paid with: a cash refund of an on-account bill is
//     refused, and never more than was charged.
//   - Company B's cashier gets 404 on A's order.
//   - The Z-report shows on-account sales per client (in totalSales, never in
//     cancelledPaid); the quote prices an on-account bill at the cash rate.
//   - A line void on an open bill carrying a paid on-account row → 409
//     ON_ACCOUNT_REFUND_INSTEAD; a cancelled ticket's on-account charge is
//     nothing to hand back.
//
// Two companies. Requires a disposable database (DATABASE_URL must contain "test").
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { randomBytes } from 'node:crypto'
import {
  applyCoverageTx, afterTillSale, getZReport, quoteOrderForTender, refundOrder, voidOrderItem,
} from '../src/modules/pos/service.js'
import { setFiscalKicker } from '../src/connectors/fiscal/outbox.js'
import {
  prisma, mkCompany, mkUser, buildApp, caller, openDrawer, ringKheer, setConnector, resetConnectorCache,
  type Company, type Who,
} from './connectorsFixtures.js'

let app: FastifyInstance
let call: ReturnType<typeof caller>
let A: Company, B: Company
let cashierA: Who, mgrA: Who, cashierB: Who
let drawerA: string
let client1: { id: string; number: string; legalName: string }
let client2: { id: string; number: string; legalName: string }
const CASH_TOTAL = 126_500   // 2 × Kheer at the cash rate (15%)
const DAY = 86_400_000

type Line = { code: string; type: string; amount: number; memo: string }
async function linesOf(tenantId: string, reference: string): Promise<Line[]> {
  const rows = await prisma.journalLine.findMany({
    where: { journalEntry: { tenantId, reference } },
    select: { type: true, amountCents: true, memo: true, account: { select: { code: true, tenantId: true } } },
  })
  for (const r of rows) expect(r.account.tenantId).toBe(tenantId)
  return rows.map((r) => ({ code: r.account.code, type: r.type, amount: Number(r.amountCents), memo: r.memo ?? '' }))
}
const amt = (lines: Line[], code: string, type: 'debit' | 'credit') =>
  lines.filter((l) => l.code === code && l.type === type).reduce((t, l) => t + l.amount, 0)

async function mkClient(co: Company, number: string, legalName: string, by: Who) {
  return prisma.customerAccount.create({
    data: { tenantId: co.tenantId, number, legalName, creditLimitCents: 50_000_000, status: 'active', createdById: by.id, approvedById: by.id, approvedAt: new Date() },
    select: { id: true, number: true, legalName: true },
  })
}

/**
 * What the till's on-account charge writes (OA-charge's chargeOrderToAccount):
 * a paid on_account Payment on the drawer + its CustomerAccountCharge, then
 * coverage completes the till sale and completeOrder files the ONE sale
 * document.
 */
async function chargeToClient(
  co: Company, who: Who, shiftId: string,
  client: { id: string; number: string; legalName: string },
  opts: { complete?: boolean } = {},
): Promise<{ orderId: string; paymentId: string; chargeId: string; totalCents: number }> {
  const o = await ringKheer(app, who, co)
  const order = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })
  expect(order.totalCents).toBe(CASH_TOTAL)
  const res = await prisma.$transaction(async (tx) => {
    const payment = await tx.payment.create({
      data: {
        orderId: order.id, shiftId, method: 'on_account', status: 'paid', amountCents: order.totalCents, processedAt: new Date(),
        gatewayRef: client.number,
        gatewayMeta: { idempotencyKey: `k-${order.id}`, onAccount: { accountId: client.id, cardId: null, number: client.number, name: client.legalName, reference: 'PO-1' } },
      },
    })
    const charge = await tx.customerAccountCharge.create({
      data: {
        tenantId: co.tenantId, accountId: client.id, orderId: order.id, paymentId: payment.id, conceptId: order.conceptId, shiftId,
        amountCents: order.totalCents, taxCents: order.taxCents, chargedById: who.id,
      },
    })
    if (opts.complete !== false) {
      const cov = await applyCoverageTx(tx, order.id, 'till')
      expect(cov.completedNow).toBe(true)
    }
    return { paymentId: payment.id, chargeId: charge.id }
  })
  if (opts.complete !== false) await afterTillSale(order.id)
  return { orderId: order.id, totalCents: order.totalCents, ...res }
}

const refundCall = (who: Who, orderId: string, body: Record<string, unknown>) =>
  call(who, 'POST', `/pos/orders/${orderId}/refund`, { reason: 'Client disputed the lunch', ...body })

beforeAll(async () => {
  setFiscalKicker(async () => {})
  const run = randomBytes(3).toString('hex')
  A = await mkCompany(`oar-a-${run}`)
  B = await mkCompany(`oar-b-${run}`)
  cashierA = await mkUser(`oar-cashier-a-${run}`, 'cashier', A.tenantId)
  mgrA = await mkUser(`oar-mgr-a-${run}`, 'foh_management', A.tenantId)
  cashierB = await mkUser(`oar-cashier-b-${run}`, 'cashier', B.tenantId)
  drawerA = await openDrawer(A, cashierA)
  await openDrawer(B, cashierB)
  await setConnector(A.tenantId, 'fiscal', { driver: 'test', enabled: true, settings: {} })
  client1 = await mkClient(A, 'OA-0001', `Acme Ltd ${run}`, mgrA)
  client2 = await mkClient(A, 'OA-0002', `Bolt Pvt ${run}`, mgrA)
  app = await buildApp()
  call = caller(app)
}, 60_000)

afterAll(async () => {
  const entries = await prisma.journalEntry.findMany({
    where: { tenantId: { in: [A.tenantId, B.tenantId] } },
    include: { lines: { include: { account: { select: { tenantId: true } } } } },
  })
  for (const e of entries) {
    const d = e.lines.filter((l) => l.type === 'debit').reduce((t, l) => t + Number(l.amountCents), 0)
    const c = e.lines.filter((l) => l.type === 'credit').reduce((t, l) => t + Number(l.amountCents), 0)
    expect(d, `entry ${e.reference} balances`).toBe(c)
    for (const l of e.lines) expect(l.account.tenantId, `entry ${e.reference} stays in its company`).toBe(e.tenantId)
  }
  setFiscalKicker(null)
  resetConnectorCache()
  await app?.close()
})

describe('a refund of an on-account bill goes back to the account', () => {
  it('in full: Cr 1110 (ON ACCOUNT), a fiscal refund by on_account, the charge refunded, no drawer touched', async () => {
    const x = await chargeToClient(A, cashierA, drawerA, client1)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: x.orderId } })).status).toBe('completed')
    const movementsBefore = await prisma.cashMovement.count({ where: { shiftId: drawerA } })

    const r = await refundCall(mgrA, x.orderId, { amountCents: x.totalCents, method: 'on_account' })
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json()).toMatchObject({ method: 'on_account', shiftId: null, amountCents: -x.totalCents, orderRefunded: true })

    const refund = await prisma.payment.findFirstOrThrow({ where: { orderId: x.orderId, status: 'refunded' } })
    expect(refund.shiftId).toBeNull()
    const meta = refund.gatewayMeta as { onAccount?: { number?: string }; onAccountApplied?: { chargeId?: string; cents?: number } }
    expect(meta.onAccount?.number).toBe(client1.number)
    expect(meta.onAccountApplied).toMatchObject({ chargeId: x.chargeId, cents: x.totalCents })

    const lines = await linesOf(A.tenantId, `order.refund:${refund.id}`)
    expect(amt(lines, '1110', 'credit')).toBe(x.totalCents)
    expect(lines.find((l) => l.code === '1110')!.memo).toMatch(/^ON ACCOUNT — /)
    for (const code of ['1010', '1015', '1030']) expect(lines.filter((l) => l.code === code)).toEqual([])

    const charge = await prisma.customerAccountCharge.findUniqueOrThrow({ where: { id: x.chargeId } })
    expect(charge.refundedCents).toBe(x.totalCents)

    const doc = await prisma.fiscalDocument.findFirstOrThrow({ where: { tenantId: A.tenantId, kind: 'refund', refundPaymentId: refund.id } })
    const payload = doc.payload as { payment?: { tenders?: Array<{ method: string; amountCents: number }> } }
    expect(payload.payment?.tenders).toEqual([{ method: 'on_account', amountCents: x.totalCents }])

    // No drawer: nothing moved, and the drawer's cash refunds are untouched.
    expect(await prisma.cashMovement.count({ where: { shiftId: drawerA } })).toBe(movementsBefore)
    const z = await getZReport(drawerA)
    expect(z.cashRefundsCents).toBe(0)
    expect(z.refundsCents).toBe(0)
  })

  it('in part: a billed statement is credited and re-statused; never more than was charged; never by cash', async () => {
    const x = await chargeToClient(A, cashierA, drawerA, client2)
    const st = await prisma.receivableInvoice.create({
      data: {
        tenantId: A.tenantId, customerAccountId: client2.id, kind: 'statement', number: `AR-ST-T-${x.orderId.slice(-6)}`,
        customerName: client2.legalName, issueDate: new Date(), dueDate: new Date(Date.now() + 30 * DAY),
        description: 'October statement', amountCents: x.totalCents, taxCents: 0,
        paidCents: x.totalCents - 50_000, status: 'partial',
      },
    })
    await prisma.customerAccountCharge.update({ where: { id: x.chargeId }, data: { statementInvoiceId: st.id } })

    const cash = await refundCall(mgrA, x.orderId, { amountCents: 10_000, method: 'cash', shiftId: drawerA })
    expect([cash.statusCode, cash.json().error.code]).toEqual([422, 'REFUND_METHOD_NOT_TENDERED'])

    const r = await refundCall(mgrA, x.orderId, { amountCents: 50_000, method: 'on_account' })
    expect(r.statusCode, r.body).toBe(200)
    expect(r.json()).toMatchObject({ shiftId: null, orderRefunded: false })
    expect((await prisma.customerAccountCharge.findUniqueOrThrow({ where: { id: x.chargeId } })).refundedCents).toBe(50_000)
    const after = await prisma.receivableInvoice.findUniqueOrThrow({ where: { id: st.id } })
    expect(Number(after.creditedCents)).toBe(50_000)
    expect(after.status).toBe('paid')
    const refund = await prisma.payment.findFirstOrThrow({ where: { orderId: x.orderId, status: 'refunded' } })
    expect(amt(await linesOf(A.tenantId, `order.refund:${refund.id}`), '1110', 'credit')).toBe(50_000)

    const over = await refundCall(mgrA, x.orderId, { amountCents: x.totalCents - 50_000 + 1, method: 'on_account' })
    expect(over.statusCode).toBe(400)
    expect(['REFUND_EXCEEDS_PAID', 'REFUND_EXCEEDS_TENDER']).toContain(over.json().error.code)
    expect((await prisma.customerAccountCharge.findUniqueOrThrow({ where: { id: x.chargeId } })).refundedCents).toBe(50_000)
  })

  it('a refund the ledger refuses (period closed) saves nothing', async () => {
    const x = await chargeToClient(A, cashierA, drawerA, client1)
    const lock = await prisma.periodLock.create({ data: { tenantId: A.tenantId, lockedThrough: new Date(Date.now() + DAY), lockedBy: mgrA.id } })
    try {
      await expect(refundOrder({
        orderId: x.orderId, amountCents: 20_000, reason: 'Client disputed the lunch', method: 'on_account',
        actorId: mgrA.id, actorRole: 'foh_management',
      })).rejects.toMatchObject({ code: expect.stringMatching(/^(PERIOD_LOCKED|REFUND_NOT_POSTED)$/) })
    } finally {
      await prisma.periodLock.delete({ where: { id: lock.id } })
    }
    expect(await prisma.payment.count({ where: { orderId: x.orderId, status: 'refunded' } })).toBe(0)
    expect(await prisma.fiscalDocument.count({ where: { orderId: x.orderId, kind: 'refund' } })).toBe(0)
    expect((await prisma.customerAccountCharge.findUniqueOrThrow({ where: { id: x.chargeId } })).refundedCents).toBe(0)
  })

  it("company B's cashier refunding A's on-account bill → 404, nothing written", async () => {
    const x = await chargeToClient(A, cashierA, drawerA, client1)
    const r = await refundCall(cashierB, x.orderId, { amountCents: 1_000, method: 'on_account' })
    expect(r.statusCode).toBe(404)
    expect(await prisma.payment.count({ where: { orderId: x.orderId, status: 'refunded' } })).toBe(0)
    expect((await prisma.customerAccountCharge.findUniqueOrThrow({ where: { id: x.chargeId } })).refundedCents).toBe(0)
  })
})

describe('the Z-report and the quote', () => {
  it('shows on-account sales per client, in totalSales, never in cancelledPaid', async () => {
    const cashier = await mkUser(`oar-z-${randomBytes(3).toString('hex')}`, 'cashier', A.tenantId)
    const drawer = await openDrawer(A, cashier)
    const a1 = await chargeToClient(A, cashier, drawer, client1)
    const a2 = await chargeToClient(A, cashier, drawer, client1)
    const b1 = await chargeToClient(A, cashier, drawer, client2)
    const z = await getZReport(drawer)
    expect(z.onAccountSales).toBe(a1.totalCents + a2.totalCents + b1.totalCents)
    expect(z.onAccountCount).toBe(3)
    expect(z.onAccountByClient).toEqual([
      { number: client1.number, name: client1.legalName, cents: a1.totalCents + a2.totalCents, count: 2 },
      { number: client2.number, name: client2.legalName, cents: b1.totalCents, count: 1 },
    ])
    expect(z.totalSales).toBe(z.cashSales + z.cardSales + z.raastSales + z.walletSales + z.onAccountSales)
    expect(z.cashSales).toBe(0)
    expect(z.cancelledPaid.count).toBe(0)
    expect(z.refundDueCents).toBe(0)
    expect(z.expectedCashCents).toBe(0)
  })

  it('quotes an on-account bill at the cash rate (a card-priced ticket re-prices)', async () => {
    const r = await call(cashierA, 'POST', '/pos/orders', {
      conceptId: A.conceptId, paymentMethod: 'card',
      items: [{ menuItemId: A.items.kheer, name: 'Kheer', quantity: 2, unitPriceCents: 55_000, modifiers: [] }],
    })
    expect(r.statusCode, r.body).toBe(201)
    const order = await prisma.order.findUniqueOrThrow({ where: { id: r.json().id } })
    expect(order.taxRatePct).toBe(8)
    const q = await quoteOrderForTender(order.id, 'on_account')
    expect(q).toMatchObject({ tender: 'cash', repriced: true, taxRatePct: 15, totalCents: CASH_TOTAL, dueCents: CASH_TOTAL })
    expect(await quoteOrderForTender(order.id, 'cash')).toMatchObject({ taxRatePct: 15, totalCents: CASH_TOTAL })
  })
})

describe('never a void, never a hand-back', () => {
  it('a line void on an open bill carrying a paid on-account row → 409 ON_ACCOUNT_REFUND_INSTEAD', async () => {
    const x = await chargeToClient(A, cashierA, drawerA, client1, { complete: false })
    const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId: x.orderId } })
    await expect(voidOrderItem({
      orderId: x.orderId, orderItemId: item.id, reason: 'Wrong dish', actorId: mgrA.id, actorRole: 'foh_management',
    })).rejects.toMatchObject({ code: 'ON_ACCOUNT_REFUND_INSTEAD', statusCode: 409 })
    expect((await prisma.orderItem.findUniqueOrThrow({ where: { id: item.id } })).voidedAt).toBeNull()
  })

  it("a cancelled ticket's on-account charge is nothing to hand back", async () => {
    const x = await chargeToClient(A, cashierA, drawerA, client1, { complete: false })
    await prisma.order.update({ where: { id: x.orderId }, data: { status: 'cancelled' } })
    const r = await refundCall(mgrA, x.orderId, { amountCents: 1_000, method: 'on_account' })
    expect([r.statusCode, r.json().error.code]).toEqual([422, 'NOTHING_TO_REFUND'])
    expect(await prisma.payment.count({ where: { orderId: x.orderId, status: 'refunded' } })).toBe(0)
  })
})
