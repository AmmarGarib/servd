// Raast "void, never booked" (RV-MONEY-1, owner 2026-10-13: finance may ask,
// ONLY the CEO voids) — reconciliation/raast.ts voidNeverBooked +
// raastRoutes.ts /receipts/:id/void-request | void | void-request/reject.
//
//   - company B gets 404 on A's receipt (ask, void, reject) and never lists it
//   - finance / management / an owner may ask; a floor manager may not (403);
//     only the CEO (role admin) voids or rejects (403 for everyone else)
//   - every eligibility refusal: not provisional, sale booked, bill not
//     cancelled, a drawer open / a refused posting, a refund paid against it
//   - a void posts NOTHING, the receipt is 'voided', raastOpenThrough no
//     longer counts it, the bank reference stays claimed (the till answers
//     RAAST_REF_USED), the audit row is stamped with the RECEIPT's company
//   - the rows carry the caller's capability flags
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { randomBytes } from 'node:crypto'
import type { RaastReceipt } from '@prisma/client'
import { AppError, errorResponse } from '../src/lib/errors.js'
import { prisma, mkCompany, mkUser, mkOrder, mkRaastAccount, openDrawer, ringKheer, setConnector, resetConnectorCache, type Company, type Who } from './connectorsFixtures.js'
import { reconciliationRoutes } from '../src/modules/reconciliation/routes.js'
import { posRoutes } from '../src/modules/pos/routes.js'
import { registerConnectorPlugins } from '../src/modules/connectors/index.js'
import { setFiscalKicker } from '../src/connectors/fiscal/outbox.js'
import { postJournalEntry } from '../src/modules/accounting/journal.js'
import { RAAST_RECEIPTS_MEMO, refundDueMemo } from '../src/modules/accounting/orderPosting.js'
import { raastOpenThrough, voidNeverBooked } from '../src/modules/reconciliation/raast.js'

let app: FastifyInstance
let A: Company
let B: Company
let bankA: { bankAccountId: string; ledgerCode: string }
let adminA: Who, financeA: Who, ownerA: Who, mgmtA: Who, floorMgrA: Who, cashierA: Who, adminB: Who, financeB: Who, ceoBoth: Who

const call = (who: Who, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, ...(payload !== undefined && { payload: payload as Record<string, unknown> }), headers: { authorization: `Bearer ${who.token}` } })

const newRef = () => `RVD${String(Date.now()).slice(-6)}${randomBytes(3).toString('hex').replace(/[^0-9]/g, '7').padEnd(4, '3').slice(0, 4)}`

/** A Raast receipt on a bill of A (as the till writes it), on a cancelled non-till bill by default. */
async function receipt(opts: {
  amountCents?: number; status?: 'provisional' | 'matched'; orderStatus?: 'cancelled' | 'rejected' | 'ready' | 'completed'
  source?: string; shiftId?: string | null
} = {}): Promise<RaastReceipt> {
  const amountCents = opts.amountCents ?? 50_000
  const orderId = await mkOrder(A, {
    items: [{ menuItemId: A.items.kheer, name: 'Kheer', quantity: 1, unitPriceCents: amountCents }],
    taxCents: 0, taxRatePct: 8, totalCents: amountCents, payments: [{ method: 'raast', amountCents }], shiftId: opts.shiftId ?? null,
  })
  await prisma.order.update({ where: { id: orderId }, data: { source: opts.source ?? 'servd', status: opts.orderStatus ?? 'cancelled' } })
  const payment = await prisma.payment.findFirstOrThrow({ where: { orderId } })
  const ref = newRef()
  await prisma.payment.update({ where: { id: payment.id }, data: { gateway: 'raast', gatewayRef: ref } })
  return prisma.raastReceipt.create({
    data: {
      tenantId: A.tenantId, orderId, conceptId: A.conceptId, shiftId: opts.shiftId ?? null, paymentId: payment.id,
      bankAccountId: bankA.bankAccountId, ledgerCode: bankA.ledgerCode, amountCents, dueCents: amountCents,
      bankRef: ref, bankRefRaw: ref, status: opts.status ?? 'provisional', confirmedVia: 'cashier', confirmedAt: new Date(),
      cashierVerified: true, idempotencyKey: `pay:${payment.id}`, createdById: cashierA.id,
    },
  })
}

async function closedShift(): Promise<string> {
  return (await prisma.shift.create({ data: { userId: cashierA.id, tenantId: A.tenantId, status: 'closed', openingFloatCents: 0, closedAt: new Date(), closingFloatCents: 0 } })).id
}

const listRow = async (who: Who, id: string, query = '') => {
  const r = await call(who, 'GET', `/reconciliation/raast/receipts?limit=200${query}`)
  expect(r.statusCode, r.body).toBe(200)
  return r.json().receipts.find((x: { id: string }) => x.id === id)
}

beforeAll(async () => {
  setFiscalKicker(async () => {})
  A = await mkCompany('rvoid-a')
  B = await mkCompany('rvoid-b')
  adminA = await mkUser('rv-admin-a', 'admin', A.tenantId)
  financeA = await mkUser('rv-fin-a', 'finance', A.tenantId)
  ownerA = await mkUser('rv-owner-a', 'owner', A.tenantId)
  mgmtA = await mkUser('rv-mgmt-a', 'management', A.tenantId)
  floorMgrA = await mkUser('rv-floor-a', 'foh_management', A.tenantId)
  cashierA = await mkUser('rv-cash-a', 'cashier', A.tenantId)
  adminB = await mkUser('rv-admin-b', 'admin', B.tenantId)
  financeB = await mkUser('rv-fin-b', 'finance', B.tenantId)
  // The CEO of both companies, working in B right now.
  ceoBoth = await mkUser('rv-ceo-both', 'admin', B.tenantId)
  await prisma.tenantMember.create({ data: { tenantId: A.tenantId, userId: ceoBoth.id } })
  bankA = await mkRaastAccount(A)
  await setConnector(A.tenantId, 'fiscal', { driver: 'test', enabled: true, settings: {} })

  app = Fastify()
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    const status = (err as { statusCode?: number }).statusCode
    if (status && status >= 400 && status < 500) return reply.status(status).send({ error: { code: 'BAD_REQUEST', message: (err as Error).message } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await app.register(reconciliationRoutes, { prefix: '/reconciliation' })
  await app.register(posRoutes, { prefix: '/pos' })
  await registerConnectorPlugins(app)
  await app.ready()
}, 60_000)

afterAll(async () => {
  setFiscalKicker(null)
  resetConnectorCache()
  await app?.close()
})

describe('who may ask, who may void — and company B never reaches A', () => {
  it('B gets 404 on A\'s receipt and never lists it; a floor manager cannot ask (403); finance / owner cannot void or reject (403)', async () => {
    const r = await receipt()
    const why = { reason: 'Bill cancelled before close; transfer never booked' }
    expect((await call(financeB, 'POST', `/reconciliation/raast/receipts/${r.id}/void-request`, why)).statusCode).toBe(404)
    expect((await call(adminB, 'POST', `/reconciliation/raast/receipts/${r.id}/void`, why)).statusCode).toBe(404)
    expect((await call(adminB, 'POST', `/reconciliation/raast/receipts/${r.id}/void-request/reject`, { note: 'not yours to reject' })).statusCode).toBe(404)
    expect(await listRow(financeB, r.id)).toBeUndefined()

    expect((await call(floorMgrA, 'POST', `/reconciliation/raast/receipts/${r.id}/void-request`, why)).statusCode).toBe(403)
    expect((await call(financeA, 'POST', `/reconciliation/raast/receipts/${r.id}/void`, why)).statusCode).toBe(403)
    expect((await call(ownerA, 'POST', `/reconciliation/raast/receipts/${r.id}/void`, why)).statusCode).toBe(403)
    expect((await call(mgmtA, 'POST', `/reconciliation/raast/receipts/${r.id}/void-request/reject`, { note: 'not the CEO here' })).statusCode).toBe(403)
    // A reason is a sentence.
    expect((await call(financeA, 'POST', `/reconciliation/raast/receipts/${r.id}/void-request`, { reason: 'short' })).statusCode).toBe(400)
    expect((await prisma.raastReceipt.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('provisional')
  })

  it('capability flags: finance / management / an owner may ask, the CEO voids; a floor manager has no Raast tab at all', async () => {
    const r = await receipt()
    expect(await listRow(financeA, r.id)).toMatchObject({ orderStatus: 'cancelled', canRequestVoid: true, canVoid: false, canRejectVoidRequest: false, canWriteOff: false, canMatch: true, voidBlockedReason: null, voidRequest: null })
    expect(await listRow(mgmtA, r.id)).toMatchObject({ canRequestVoid: true, canVoid: false })
    expect(await listRow(ownerA, r.id)).toMatchObject({ canRequestVoid: true, canVoid: false, canWriteOff: true })
    expect(await listRow(adminA, r.id)).toMatchObject({ canVoid: true, canRequestVoid: false, canWriteOff: true, canFixReference: true })
    expect((await call(floorMgrA, 'GET', '/reconciliation/raast/receipts')).statusCode).toBe(403)
    // A live bill's receipt is no void candidate: no flags, no reason shown.
    const live = await receipt({ orderStatus: 'completed' })
    expect(await listRow(adminA, live.id)).toMatchObject({ canVoid: false, canRequestVoid: false, voidBlockedReason: null })
  })
})

describe('the ask, the rejection and the void', () => {
  it('finance asks → the CEO rejects → finance asks again → the CEO voids: no posting, voided, reference still claimed, audited in A', async () => {
    const r = await receipt({ amountCents: 77_700 })
    const base = `/reconciliation/raast/receipts/${r.id}`
    const ask = await call(financeA, 'POST', `${base}/void-request`, { reason: 'Bill cancelled at the door; never booked anywhere' })
    expect(ask.statusCode, ask.body).toBe(200)
    expect(ask.json()).toMatchObject({ status: 'provisional', voidRequest: { pending: true, by: { id: financeA.id, name: 'rv-fin-a' } }, canRequestVoid: false })
    expect((await call(financeA, 'POST', `${base}/void-request`, { reason: 'asking a second time over' })).json().error.code).toBe('RAAST_VOID_ALREADY_REQUESTED')
    // The CEO's inbox reads ?voidRequested=1.
    const inbox = await call(adminA, 'GET', '/reconciliation/raast/receipts?voidRequested=1')
    expect(inbox.json().receipts.map((x: { id: string }) => x.id)).toContain(r.id)
    expect(inbox.json().receipts.every((x: { voidRequest: { pending: boolean } | null }) => x.voidRequest?.pending)).toBe(true)
    expect(inbox.json().kpis.voidRequested.count).toBeGreaterThanOrEqual(1)
    expect(await listRow(adminA, r.id)).toMatchObject({ canVoid: true, canRejectVoidRequest: true })
    expect(await prisma.auditLog.count({ where: { action: 'raast.receipt.void_request', entityId: r.id, tenantId: A.tenantId } })).toBe(1)

    const rej = await call(adminA, 'POST', `${base}/void-request/reject`, { note: 'check with the bank first' })
    expect(rej.statusCode, rej.body).toBe(200)
    expect(rej.json().voidRequest).toBeNull()
    expect((await call(adminA, 'POST', `${base}/void-request/reject`, { note: 'again' })).json().error.code).toBe('RAAST_NO_VOID_REQUEST')
    expect((await call(financeA, 'POST', `${base}/void-request`, { reason: 'bank confirms no transfer posted' })).statusCode).toBe(200)

    const entriesBefore = await prisma.journalEntry.count({ where: { tenantId: A.tenantId } })
    const openBefore = await raastOpenThrough(prisma, A.tenantId, new Date())
    // The CEO of both companies, working in B: the audit row is still A's.
    const v = await call(ceoBoth, 'POST', `${base}/void`, { reason: 'Never booked: cancelled bill, money not in the bank' })
    expect(v.statusCode, v.body).toBe(200)
    expect(v.json()).toMatchObject({ status: 'voided', bankRef: r.bankRef, voided: { by: { id: ceoBoth.id } }, canVoid: false })
    const after = await prisma.raastReceipt.findUniqueOrThrow({ where: { id: r.id } })
    expect(after).toMatchObject({ status: 'voided', voidedById: ceoBoth.id, voidReason: 'Never booked: cancelled bill, money not in the bank', bankRef: r.bankRef })
    expect(after.voidRequestedAt).not.toBeNull()
    expect(await prisma.journalEntry.count({ where: { tenantId: A.tenantId } })).toBe(entriesBefore)
    const openAfter = await raastOpenThrough(prisma, A.tenantId, new Date())
    expect(openAfter.count).toBe(openBefore.count - 1)
    expect(openAfter.cents).toBe(openBefore.cents - 77_700)
    const log = await prisma.auditLog.findFirstOrThrow({ where: { action: 'raast.receipt.void', entityId: r.id } })
    expect(log.tenantId).toBe(A.tenantId)
    expect(log.metadata).toMatchObject({ noLedgerEntry: true, actorTenantId: B.tenantId })
    // Listed as voided (it is in the default list), the CEO can't void twice.
    expect(await listRow(financeA, r.id)).toMatchObject({ status: 'voided', canRequestVoid: false })
    expect((await call(adminA, 'POST', `${base}/void`, { reason: 'twice over, just to be sure' })).json().error.code).toBe('RAAST_NOT_PROVISIONAL')

    // The same transfer can never pay another bill: the till answers RAAST_REF_USED.
    const drawer = await openDrawer(A, cashierA)
    const o = await ringKheer(app, cashierA, A)
    const pay = await call(cashierA, 'POST', '/pos/payments', { orderId: o.id, shiftId: drawer, payments: [{ method: 'raast', amountCents: 118_800, gatewayRef: r.bankRef, raastVerified: true }] })
    expect(pay.statusCode, pay.body).toBe(409)
    expect(pay.json().error.code).toBe('RAAST_REF_USED')
  })

  it('the CEO may void without an ask (the service is the same rule)', async () => {
    const r = await receipt({ orderStatus: 'rejected' })
    const v = await voidNeverBooked(r.id, { actorId: adminA.id, reason: 'Rejected order, transfer bounced back' })
    expect(v.status).toBe('voided')
    expect(v.voidRequestedAt).toBeNull()
  })
})

describe('eligibility — each refusal (409), for the ask and the void alike', () => {
  async function refused(r: RaastReceipt, code: string) {
    const ask = await call(financeA, 'POST', `/reconciliation/raast/receipts/${r.id}/void-request`, { reason: 'please void this receipt' })
    expect(ask.statusCode, ask.body).toBe(409)
    expect(ask.json().error.code).toBe(code)
    const v = await call(adminA, 'POST', `/reconciliation/raast/receipts/${r.id}/void`, { reason: 'please void this receipt' })
    expect(v.statusCode, v.body).toBe(409)
    expect(v.json().error.code).toBe(code)
    expect((await prisma.raastReceipt.findUniqueOrThrow({ where: { id: r.id } })).status).toBe(r.status)
  }

  it('not provisional → RAAST_NOT_PROVISIONAL', async () => {
    await refused(await receipt({ status: 'matched' }), 'RAAST_NOT_PROVISIONAL')
  })

  it('the sale is booked (a close held it as a refund due on 1115 — or legacy 1110) → RAAST_SALE_BOOKED', async () => {
    for (const code of ['1115', '1110']) {
      const shift = await closedShift()
      const r = await receipt({ shiftId: shift })
      await postJournalEntry({
        tenantId: A.tenantId, sourceType: 'shift.close', sourceId: shift, description: 'test close',
        lines: [
          { accountCode: bankA.ledgerCode, type: 'debit', amountCents: r.amountCents, memo: `${RAAST_RECEIPTS_MEMO} — REFUND DUE — test` },
          { accountCode: code, type: 'credit', amountCents: r.amountCents, memo: refundDueMemo(r.orderId, 'test') },
        ],
      })
      await refused(r, 'RAAST_SALE_BOOKED')
      const row = await listRow(adminA, r.id)
      expect(row).toMatchObject({ canVoid: false, voidBlockedCode: 'RAAST_SALE_BOOKED' })
      expect(row.voidBlockedReason).toContain('not received')
    }
  })

  it('the bill is not cancelled → RAAST_ORDER_NOT_CANCELLED', async () => {
    await refused(await receipt({ orderStatus: 'ready' }), 'RAAST_ORDER_NOT_CANCELLED')
  })

  it('a drawer holding it is open, or its close / the bill has a refused posting → RAAST_CLOSE_PENDING', async () => {
    const open = (await prisma.shift.create({ data: { userId: cashierA.id, tenantId: A.tenantId, status: 'open', openingFloatCents: 0 } })).id
    await refused(await receipt({ shiftId: open }), 'RAAST_CLOSE_PENDING')

    const shift = await closedShift()
    const r = await receipt({ shiftId: shift })
    const flag = await prisma.exceptionFlag.create({
      data: { tenantId: A.tenantId, kind: 'posting_failed', severity: 'high', title: 'close refused', description: 'x', entityType: 'Shift', entityId: shift, status: 'open', metadata: { sourceType: 'shift.close', sourceId: shift } },
    })
    await refused(r, 'RAAST_CLOSE_PENDING')
    await prisma.exceptionFlag.update({ where: { id: flag.id }, data: { status: 'resolved' } })
    const orderFlag = await prisma.exceptionFlag.create({
      data: { tenantId: A.tenantId, kind: 'posting_failed', severity: 'high', title: 'order refused', description: 'x', entityType: 'Order', entityId: r.orderId, status: 'open' },
    })
    await refused(r, 'RAAST_CLOSE_PENDING')
    await prisma.exceptionFlag.update({ where: { id: orderFlag.id }, data: { status: 'resolved' } })
    // Fixed: now it can be voided.
    expect(await listRow(adminA, r.id)).toMatchObject({ canVoid: true, voidBlockedReason: null })
  })

  it('a refund row on the bill paid back against this receipt → RAAST_REFUND_EXISTS', async () => {
    const r = await receipt()
    await prisma.payment.create({
      data: {
        orderId: r.orderId, method: 'raast', amountCents: -r.amountCents, status: 'refunded', gateway: 'raast', processedAt: new Date(),
        gatewayMeta: { refund: { reason: 'cancelled' }, raast: { receiptId: r.id, bankAccountId: bankA.bankAccountId, ledgerCode: bankA.ledgerCode } },
      },
    })
    await refused(r, 'RAAST_REFUND_EXISTS')
    // A refund against ANOTHER receipt of the bill does not count.
    const other = await receipt()
    await prisma.payment.create({
      data: { orderId: other.orderId, method: 'cash', amountCents: -100, status: 'refunded', processedAt: new Date(), gatewayMeta: { refund: { reason: 'x' } } },
    })
    expect(await listRow(adminA, other.id)).toMatchObject({ canVoid: true })
  })
})
