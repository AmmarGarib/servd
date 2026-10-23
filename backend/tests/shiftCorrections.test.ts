// Shift corrections (owner, 2026-10-21): finance raises ONE set of fixes on a
// closed drawer; the CEO approves or rejects it once; nothing moves before.
//   - company separation: another company's shift / set is 404; a set binds to the SHIFT's company;
//   - finance without `accounting`, a cashier, a manager → 403; finance never approves;
//   - one open set per shift (409 CORRECTION_PENDING); a closed month 409 BOOKS_CLOSED;
//     void & re-issue is refused (422 VOID_REISSUE_NOT_AVAILABLE — not built);
//   - reject: nothing changes;
//   - approve void_bill: the bill is cancelled, its tenders voided (not refunded),
//     ONE fiscal void document ('void:<orderId>'), the drawer's close reversed on
//     its own date and re-posted as 'shift.close:<id>@2' without the bill, the
//     trial balance balances, the order is in the Trash (never erasable), an
//     audited sales day is reopened first;
//   - a second set on the same drawer (money really handed back): the receipts
//     are held as a REFUND DUE on till clearing in the re-posted close;
//   - cancel_kot: an open ticket cancelled, nothing posted;
//   - void & re-issue on a PAST business day (cash → card, card → cash, → Raast):
//     the corrected bill, its payment and its ONE fiscal sale document are
//     dated the original day, GST at the new tender's rate, no kitchen ticket,
//     the stock moves (never drawn twice), cost of sales booked once, the
//     re-posted close carries the new bill; a duplicate Raast reference 409;
//     a retry after a mid-apply failure issues no second bill.
//   - Raast QR bills: a provisional receipt + void_bill → the receipt voided
//     (never matched), the re-posted close without the Raast money, a retry
//     idempotent; a matched receipt refuses a void with no money returned and
//     a re-issue (422 RAAST_MONEY_RECEIVED); matched + money handed back → a
//     REFUND DUE; Raast → cash re-issue voids the receipt, cash bill on the
//     original day at the cash GST.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { AppError, errorResponse } from '../src/lib/errors.js'
import { posRoutes } from '../src/modules/pos/routes.js'
import { shiftCorrectionRoutes } from '../src/modules/shiftCorrections/routes.js'
import { setFiscalKicker } from '../src/connectors/fiscal/outbox.js'
import { closeShift } from '../src/modules/pos/service.js'
import { postShiftClose } from '../src/modules/accounting/shiftPosting.js'
import { OUTPUT_TAX_ACCOUNTS } from '../src/modules/accounting/orderPosting.js'
import { ORDER_TRASH_PROVIDERS } from '../src/modules/trash/providers/transactions/orders.js'
import { fmtPktDate } from '../src/modules/accounting/dates.js'
import { sumCents } from '../src/lib/money.js'
import { addLotTx, fifoCutoverKey } from '../src/lib/stockLedger.js'
import { flushNotifications } from '../src/lib/staffNotify.js'
import {
  prisma, mkCompany, mkUser, caller, setConnector, resetConnectorCache, openDrawer, ringKheer, mkRaastAccount,
  type Company, type Who,
} from './connectorsFixtures.js'

let app: FastifyInstance
let A: Company, B: Company
let cashierA: Who, financeA: Who, financeNoAcc: Who, mgrA: Who, ceoA: Who
let cashierB: Who, financeB: Who, ceoB: Who

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
  await a.register(shiftCorrectionRoutes, { prefix: '/pos/shift-corrections' })
  await a.ready()
  return a
}

const call = () => caller(app)
const REASON = 'Cashier rang the bill twice by mistake'

/** A paid cash bill on an open drawer. */
async function paidBill(co: Company, cashier: Who, drawer: string) {
  const o = await ringKheer(app, cashier, co)
  const r = await call()(cashier, 'POST', '/pos/payments', { orderId: o.id, shiftId: drawer, payments: [{ method: 'cash', amountCents: o.totalCents, tenderedCents: o.totalCents }] })
  expect(r.statusCode, r.body).toBe(201)
  return prisma.order.findUniqueOrThrow({ where: { id: o.id } })
}

async function closeDrawer(drawer: string, counted: number) {
  await closeShift(drawer, counted, undefined, { confirmOpenTickets: true })
  const posted = await postShiftClose(drawer)
  expect(posted.entryId, JSON.stringify(posted)).toBeTruthy()
}

/** Net (debit − credit) on account codes in a company, optionally for one brand. */
async function net(tenantId: string, codes: readonly string[], conceptId?: string) {
  const rows = await prisma.journalLine.groupBy({
    by: ['type'], _sum: { amountCents: true },
    where: { account: { tenantId, code: { in: [...codes] } }, journalEntry: { tenantId }, ...(conceptId && { conceptId }) },
  })
  return sumCents(rows.find((x) => x.type === 'debit')?._sum.amountCents) - sumCents(rows.find((x) => x.type === 'credit')?._sum.amountCents)
}

async function revenueNet(tenantId: string, conceptId: string) {
  const rows = await prisma.journalLine.groupBy({
    by: ['type'], _sum: { amountCents: true },
    where: { conceptId, account: { tenantId, type: 'revenue' }, journalEntry: { tenantId } },
  })
  return sumCents(rows.find((x) => x.type === 'debit')?._sum.amountCents) - sumCents(rows.find((x) => x.type === 'credit')?._sum.amountCents)
}

async function trialBalance(tenantId: string) {
  const rows = await prisma.journalLine.groupBy({ by: ['type'], _sum: { amountCents: true }, where: { journalEntry: { tenantId } } })
  return { debits: sumCents(rows.find((x) => x.type === 'debit')?._sum.amountCents), credits: sumCents(rows.find((x) => x.type === 'credit')?._sum.amountCents) }
}

beforeAll(async () => {
  A = await mkCompany(`scor-a-${Date.now()}`, { srbPosId: 7401 })
  B = await mkCompany(`scor-b-${Date.now()}`, { srbPosId: 7402 })
  cashierA = await mkUser('scor-cashier-a', 'cashier', A.tenantId)
  financeA = await mkUser('scor-fin-a', 'finance', A.tenantId)
  financeNoAcc = await mkUser('scor-fin-noacc', 'finance', A.tenantId)
  await prisma.user.update({ where: { id: financeNoAcc.id }, data: { moduleDeny: ['accounting'] } })
  mgrA = await mkUser('scor-mgr-a', 'fnb_manager', A.tenantId)
  ceoA = await mkUser('scor-ceo-a', 'admin', A.tenantId)
  cashierB = await mkUser('scor-cashier-b', 'cashier', B.tenantId)
  financeB = await mkUser('scor-fin-b', 'finance', B.tenantId)
  ceoB = await mkUser('scor-ceo-b', 'admin', B.tenantId)
  setFiscalKicker(async () => {})
  for (const co of [A, B]) {
    await setConnector(co.tenantId, 'fiscal', { driver: 'test', enabled: true, settings: { test: { scenario: 'ok' }, syncTimeoutMs: 1000, syncAtTill: true, fiscalReportingRequired: true } })
  }
  app = await build()
}, 60_000)

afterAll(async () => {
  setFiscalKicker(null)
  resetConnectorCache()
  await app?.close()
})

describe('shift corrections', () => {
  let drawer: string
  let bill1: Awaited<ReturnType<typeof paidBill>>
  let bill2: Awaited<ReturnType<typeof paidBill>>
  let kot: { id: string; totalCents: number }
  let setId: string

  it('lists a closed drawer\'s bills and open tickets for finance', async () => {
    drawer = await openDrawer(A, cashierA)
    bill1 = await paidBill(A, cashierA, drawer)
    bill2 = await paidBill(A, cashierA, drawer)
    kot = await ringKheer(app, cashierA, A, 1)  // rung on the drawer, never paid
    await closeDrawer(drawer, bill1.totalCents + bill2.totalCents)

    const r = await call()(financeA, 'GET', `/pos/shift-corrections/shift/${drawer}`)
    expect(r.statusCode, r.body).toBe(200)
    const body = r.json()
    expect(body.shift).toMatchObject({ id: drawer, tenantId: A.tenantId, status: 'closed', businessDay: fmtPktDate(new Date()) })
    const byId = new Map<string, { kind: string | null; blockedBy: unknown }>(body.orders.map((o: { orderId: string }) => [o.orderId, o]))
    expect(byId.get(bill1.id)).toMatchObject({ kind: 'void_bill', blockedBy: null })
    expect(byId.get(kot.id)).toMatchObject({ kind: 'cancel_kot', blockedBy: null })
  })

  it('refuses the wrong people: finance without accounting, a cashier, a manager → 403; another company → 404', async () => {
    const body = { shiftId: drawer, reason: REASON, items: [{ orderId: bill1.id, kind: 'void_bill', reason: 'Duplicate bill of table 4' }] }
    for (const who of [financeNoAcc, cashierA, mgrA]) {
      const r = await call()(who, 'POST', '/pos/shift-corrections', body)
      expect(r.statusCode, `${who.role} ${r.body}`).toBe(403)
    }
    expect((await call()(financeB, 'POST', '/pos/shift-corrections', body)).statusCode).toBe(404)
    expect((await call()(financeB, 'GET', `/pos/shift-corrections/shift/${drawer}`)).statusCode).toBe(404)
  })

  it('refuses a void & re-issue with "food made" or no card reference, and an order that is not on the drawer', async () => {
    const r = await call()(financeA, 'POST', '/pos/shift-corrections', {
      shiftId: drawer, reason: REASON, items: [{ orderId: bill1.id, kind: 'void_reissue', newTender: 'card', tenderRef: 'SLIP-4411', foodMade: true, reason: 'Paid by card, rung as cash' }],
    })
    expect(r.statusCode, r.body).toBe(422)
    expect(r.json().error.code).toBe('FOOD_MADE_NOT_FOR_REISSUE')
    const noRef = await call()(financeA, 'POST', '/pos/shift-corrections', {
      shiftId: drawer, reason: REASON, items: [{ orderId: bill1.id, kind: 'void_reissue', newTender: 'card', reason: 'Paid by card, rung as cash' }],
    })
    expect(noRef.statusCode, noRef.body).toBe(422)
    expect(noRef.json().error.code).toBe('TENDER_REF_REQUIRED')
    // A bill rung up as a KOT, an unknown order → 422.
    const bad = await call()(financeA, 'POST', '/pos/shift-corrections', {
      shiftId: drawer, reason: REASON, items: [{ orderId: '00000000-0000-4000-8000-000000000000', kind: 'void_bill', reason: 'Duplicate bill of table 4' }],
    })
    expect(bad.statusCode).toBe(422)
    expect(bad.json().error.code).toBe('ORDER_NOT_ON_SHIFT')
    const wrongKind = await call()(financeA, 'POST', '/pos/shift-corrections', {
      shiftId: drawer, reason: REASON, items: [{ orderId: bill1.id, kind: 'cancel_kot', reason: 'Duplicate bill of table 4' }],
    })
    expect(wrongKind.statusCode).toBe(409)
    expect(wrongKind.json().error.code).toBe('KOT_NOT_OPEN')
  })

  it('refuses to void a tipped bill whose tip a posted tip pool already shared (409 TIP_ALREADY_POOLED)', async () => {
    const at = (await prisma.order.findUniqueOrThrow({ where: { id: bill1.id }, select: { completedAt: true } })).completedAt!
    await prisma.order.update({ where: { id: bill1.id }, data: { tipCents: 5_000 } })
    const pool = await prisma.tipPool.create({
      data: { tenantId: A.tenantId, conceptId: A.conceptId, name: 'Today', periodStart: new Date(at.getTime() - 3_600_000), periodEnd: new Date(at.getTime() + 3_600_000), status: 'posted', postedAt: new Date(), totalTipsCents: 5_000 },
    })
    try {
      const r = await call()(financeA, 'POST', '/pos/shift-corrections', { shiftId: drawer, reason: REASON, items: [{ orderId: bill1.id, kind: 'void_bill', reason: 'Duplicate bill of table 4' }] })
      expect(r.statusCode, r.body).toBe(409)
      expect(r.json().error.code).toBe('TIP_ALREADY_POOLED')
    } finally {
      await prisma.tipPool.delete({ where: { id: pool.id } })
      await prisma.order.update({ where: { id: bill1.id }, data: { tipCents: 0 } })
    }
  })

  it('finance raises a set (201, bound to the shift\'s company) and NOTHING changes before the CEO approves', async () => {
    const entriesBefore = await prisma.journalEntry.count({ where: { tenantId: A.tenantId } })
    const r = await call()(financeA, 'POST', '/pos/shift-corrections', {
      shiftId: drawer, reason: REASON,
      items: [
        { orderId: bill1.id, kind: 'void_bill', reason: 'Duplicate bill of table 4' },
        { orderId: kot.id, kind: 'cancel_kot', reason: 'Guest left before ordering' },
      ],
    })
    expect(r.statusCode, r.body).toBe(201)
    const set = r.json()
    setId = set.id
    expect(set).toMatchObject({ tenantId: A.tenantId, shiftId: drawer, status: 'submitted', requestedBy: { id: financeA.id } })
    expect(set.items[0].preview.effect).toMatchObject({ order: 'void_final_bill', money: 'voided', stock: 'back_to_stock', fiscal: 'void_document', reversesRevenue: true })
    expect(set.items[1].preview.effect).toMatchObject({ order: 'cancel_ticket', money: 'none' })

    expect((await prisma.order.findUniqueOrThrow({ where: { id: bill1.id } })).status).toBe('completed')
    expect((await prisma.order.findUniqueOrThrow({ where: { id: kot.id } })).status).not.toBe('cancelled')
    expect(await prisma.payment.count({ where: { orderId: bill1.id, status: 'paid' } })).toBe(1)
    expect(await prisma.fiscalDocument.count({ where: { orderId: bill1.id, kind: 'refund' } })).toBe(0)
    expect(await prisma.journalEntry.count({ where: { tenantId: A.tenantId } })).toBe(entriesBefore)
    // The bell: the CEO of the shift's company is told it waits; never company B's CEO.
    await flushNotifications()
    expect(await prisma.staffNotification.count({ where: { userId: ceoA.id, kind: 'approval.waiting', entityType: 'shift_correction', entityId: setId } })).toBe(1)
    expect(await prisma.staffNotification.count({ where: { userId: ceoB.id, entityId: setId } })).toBe(0)
  })

  it('another company never sees or decides the set (404); a second open set on the drawer is 409', async () => {
    expect((await call()(financeB, 'GET', `/pos/shift-corrections/${setId}`)).statusCode).toBe(404)
    expect((await call()(ceoB, 'POST', `/pos/shift-corrections/${setId}/approve`, {})).statusCode).toBe(404)
    const list = await call()(financeB, 'GET', '/pos/shift-corrections')
    expect(list.json().items.map((i: { id: string }) => i.id)).not.toContain(setId)
    const again = await call()(financeA, 'POST', '/pos/shift-corrections', {
      shiftId: drawer, reason: REASON, items: [{ orderId: bill2.id, kind: 'void_bill', reason: 'Duplicate bill of table 9' }],
    })
    expect(again.statusCode).toBe(409)
    expect(again.json().error.code).toBe('CORRECTION_PENDING')
  })

  it('finance can never approve; a reject needs a reason', async () => {
    expect((await call()(financeA, 'POST', `/pos/shift-corrections/${setId}/approve`, {})).statusCode).toBe(403)
    expect((await call()(ceoA, 'POST', `/pos/shift-corrections/${setId}/reject`, { note: 'no' })).statusCode).toBe(400)
  })

  it('the CEO approves: the audited day is reopened, the bill voided, the close reversed and re-posted, the order in the Trash', async () => {
    const today = fmtPktDate(new Date())
    await prisma.nightAuditDay.upsert({
      where: { tenantId_businessDate: { tenantId: A.tenantId, businessDate: today } },
      create: { tenantId: A.tenantId, businessDate: today, status: 'audited', auditedAt: new Date(), auditedById: ceoA.id },
      update: { status: 'audited', auditedAt: new Date(), auditedById: ceoA.id },
    })
    const original = await prisma.journalEntry.findFirstOrThrow({ where: { tenantId: A.tenantId, reference: `shift.close:${drawer}` } })

    const r = await call()(ceoA, 'POST', `/pos/shift-corrections/${setId}/approve`, { note: 'OK, checked the CCTV' })
    expect(r.statusCode, r.body).toBe(200)
    const set = r.json()
    expect(set.status, JSON.stringify(set)).toBe('applied')
    expect(set.decidedBy.id).toBe(ceoA.id)
    expect(set.result.reopenedDays).toEqual([today])
    expect((await prisma.nightAuditDay.findUniqueOrThrow({ where: { tenantId_businessDate: { tenantId: A.tenantId, businessDate: today } } })).status).toBe('open')

    // The bill: cancelled, tenders voided (never refunded), one fiscal void document.
    const o1 = await prisma.order.findUniqueOrThrow({ where: { id: bill1.id }, include: { payments: true } })
    expect(o1.status).toBe('cancelled')
    expect(o1.payments.every((p) => p.status === 'failed' && (p.gatewayMeta as { voided?: { reason?: string } }).voided?.reason === 'shift_correction')).toBe(true)
    expect(o1.payments.some((p) => p.status === 'refunded' || p.amountCents < 0)).toBe(false)
    const voids = await prisma.fiscalDocument.findMany({ where: { orderId: bill1.id, kind: 'refund' } })
    expect(voids.map((d) => d.idempotencyKey)).toEqual([`void:${bill1.id}`])
    expect(await prisma.fiscalDocument.count({ where: { orderId: bill1.id, kind: 'sale' } })).toBe(1)
    // The KOT: cancelled.
    expect((await prisma.order.findUniqueOrThrow({ where: { id: kot.id } })).status).toBe('cancelled')

    // The ledger: the close reversed ON ITS OWN DATE, re-posted as revision @2 without the bill.
    const reversal = await prisma.journalEntry.findFirstOrThrow({ where: { tenantId: A.tenantId, reference: `shift.close.reversal:${drawer}` } })
    expect(reversal.entryDate.getTime()).toBe(original.entryDate.getTime())
    const repost = await prisma.journalEntry.findFirstOrThrow({ where: { tenantId: A.tenantId, reference: `shift.close:${drawer}@2` } })
    expect(fmtPktDate(repost.entryDate)).toBe(fmtPktDate(original.entryDate))
    expect(await net(A.tenantId, OUTPUT_TAX_ACCOUNTS, A.conceptId)).toBe(-bill2.taxCents)
    const b2 = await prisma.order.findUniqueOrThrow({ where: { id: bill2.id } })
    expect(-(await revenueNet(A.tenantId, A.conceptId))).toBe(b2.totalCents - b2.taxCents)
    // Counted cash stays: the drawer is now over by the voided bill (Cr 8010), never revenue.
    expect(set.result.drawer.varianceCents).toBe(bill1.totalCents)
    const tb = await trialBalance(A.tenantId)
    expect(tb.debits).toBe(tb.credits)

    // The Trash: both orders parked with the CEO as the one who moved them; never erasable.
    const trash = await prisma.trashEntry.findMany({ where: { entityType: 'order', entityId: { in: [bill1.id, kot.id] } } })
    expect(trash).toHaveLength(2)
    expect(trash.every((t) => t.deletedById === ceoA.id && t.tenantId === A.tenantId)).toBe(true)
    const provider = ORDER_TRASH_PROVIDERS.find((p) => p.key === 'order')!
    expect(provider.erasable(trash[0]!, [])).toBe(false)

    // Finance (the requester) hears it was approved and applied.
    await flushNotifications()
    const told = await prisma.staffNotification.findMany({ where: { userId: financeA.id, entityId: setId }, select: { kind: true } })
    expect(told.map((t) => t.kind).sort()).toEqual(['approval.decided', 'shift_correction.applied'])
    // A second approve is refused.
    expect((await call()(ceoA, 'POST', `/pos/shift-corrections/${setId}/approve`, {})).statusCode).toBe(409)
  })

  it('a second set on the same drawer, money really handed back: the receipts are held as a refund due', async () => {
    const r = await call()(financeA, 'POST', '/pos/shift-corrections', {
      shiftId: drawer, reason: 'Second bill voided after the guest complained',
      items: [{ orderId: bill2.id, kind: 'void_bill', reason: 'Guest refused the food', moneyReturned: true }],
    })
    expect(r.statusCode, r.body).toBe(201)
    expect(r.json().items[0].preview.effect.money).toBe('owed_back')
    const ok = await call()(ceoA, 'POST', `/pos/shift-corrections/${r.json().id}/approve`, {})
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json().status, ok.body).toBe('applied')
    // The receipts stay paid (handed back through the till's refund route, never here).
    expect(await prisma.payment.count({ where: { orderId: bill2.id, status: 'paid' } })).toBe(1)
    await prisma.journalEntry.findFirstOrThrow({ where: { tenantId: A.tenantId, reference: `shift.close.reversal:${drawer}@2` } })
    const third = await prisma.journalEntry.findFirstOrThrow({
      where: { tenantId: A.tenantId, reference: `shift.close:${drawer}@3` },
      include: { lines: { include: { account: { select: { code: true } } } } },
    })
    const due = third.lines.find((l) => l.type === 'credit' && (l.memo ?? '').startsWith('REFUND DUE') && (l.memo ?? '').includes(bill2.id))
    expect(due && Number(due.amountCents)).toBe(bill2.totalCents)
    // Nothing of either bill is revenue or output tax any more.
    expect(await net(A.tenantId, OUTPUT_TAX_ACCOUNTS, A.conceptId)).toBe(0)
    expect(await revenueNet(A.tenantId, A.conceptId)).toBe(0)
    const tb = await trialBalance(A.tenantId)
    expect(tb.debits).toBe(tb.credits)
  })

  it('a reject leaves everything untouched', async () => {
    const d = await openDrawer(A, cashierA)
    const bill = await paidBill(A, cashierA, d)
    await closeDrawer(d, bill.totalCents)
    const entries = await prisma.journalEntry.count({ where: { tenantId: A.tenantId } })
    const r = await call()(financeA, 'POST', '/pos/shift-corrections', {
      shiftId: d, reason: REASON, items: [{ orderId: bill.id, kind: 'void_bill', reason: 'Duplicate bill of table 2' }],
    })
    expect(r.statusCode, r.body).toBe(201)
    const rej = await call()(ceoA, 'POST', `/pos/shift-corrections/${r.json().id}/reject`, { note: 'This bill was real — keep it' })
    expect(rej.statusCode, rej.body).toBe(200)
    expect(rej.json().status).toBe('rejected')
    expect((await prisma.order.findUniqueOrThrow({ where: { id: bill.id } })).status).toBe('completed')
    expect(await prisma.payment.count({ where: { orderId: bill.id, status: 'paid' } })).toBe(1)
    expect(await prisma.journalEntry.count({ where: { tenantId: A.tenantId } })).toBe(entries)
    expect(await prisma.trashEntry.count({ where: { entityType: 'order', entityId: bill.id } })).toBe(0)
  })

  it('a closed month is 409 BOOKS_CLOSED (company B; its own CEO reopens the month first)', async () => {
    const d = await openDrawer(B, cashierB)
    const bill = await paidBill(B, cashierB, d)
    await closeDrawer(d, bill.totalCents)
    await prisma.periodLock.create({ data: { tenantId: B.tenantId, lockedThrough: new Date(Date.now() + 86_400_000), lockedBy: ceoB.id } })
    const r = await call()(financeB, 'POST', '/pos/shift-corrections', {
      shiftId: d, reason: REASON, items: [{ orderId: bill.id, kind: 'void_bill', reason: 'Duplicate bill of table 2' }],
    })
    expect(r.statusCode, r.body).toBe(409)
    expect(r.json().error.code).toBe('BOOKS_CLOSED')
    // Company A's books are untouched by B's close.
    expect(await prisma.periodLock.count({ where: { tenantId: A.tenantId } })).toBe(0)
  })
})

describe('shift corrections and stock (FIFO lots, cost booked by the close)', () => {
  let C: Company
  let cashierC: Who, financeC: Who, ceoC: Who
  let beef: string

  const stockOf = async () => (await prisma.inventoryItem.findUniqueOrThrow({ where: { id: beef } })).currentStock

  beforeAll(async () => {
    C = await mkCompany(`scor-c-${Date.now()}`, { srbPosId: 7403 })
    await prisma.setting.create({ data: { key: fifoCutoverKey(C.tenantId), value: new Date(Date.now() - 30 * 86_400_000).toISOString() } })
    cashierC = await mkUser('scor-cashier-c', 'cashier', C.tenantId)
    financeC = await mkUser('scor-fin-c', 'finance', C.tenantId)
    ceoC = await mkUser('scor-ceo-c', 'admin', C.tenantId)
    await setConnector(C.tenantId, 'fiscal', { driver: 'test', enabled: true, settings: { test: { scenario: 'ok' }, syncTimeoutMs: 1000, syncAtTill: true, fiscalReportingRequired: true } })
    beef = (await prisma.inventoryItem.create({ data: { tenantId: C.tenantId, name: 'Beef', unit: 'kg', category: 'protein', parLevel: 0 } })).id
    await prisma.$transaction((tx) => addLotTx(tx, {
      tenantId: C.tenantId, inventoryItemId: beef, qty: 20, unitCostCents: 100_000, kind: 'count_gain', lotSourceType: 'count_gain', lotSourceId: 'scor-lot',
      movementSourceType: 'test', movementSourceId: 'scor-lot', receivedAt: new Date(Date.now() - 5 * 86_400_000),
    }))
    await prisma.recipe.create({
      data: { kind: 'plate', menuItemId: C.items.nihari, servings: 1, qFactorPct: 0, ingredients: { create: [{ inventoryItemId: beef, quantity: 1000, unit: 'kg' }] } },
    })
  }, 60_000)

  async function nihariBill(drawer: string) {
    const r = await call()(cashierC, 'POST', '/pos/orders', { conceptId: C.conceptId, items: [{ menuItemId: C.items.nihari, name: 'Beef Nihari', quantity: 1, unitPriceCents: 145_000, modifiers: [] }] })
    expect(r.statusCode, r.body).toBe(201)
    const o = r.json()
    const p = await call()(cashierC, 'POST', '/pos/payments', { orderId: o.id, shiftId: drawer, payments: [{ method: 'cash', amountCents: o.totalCents, tenderedCents: o.totalCents }] })
    expect(p.statusCode, p.body).toBe(201)
    return prisma.order.findUniqueOrThrow({ where: { id: o.id } })
  }

  it('a voided bill whose food was never made goes back to its lots; one whose food was made is wasted (1290) — cost of sales nets to zero, never twice', async () => {
    const start = await stockOf()
    const drawer = await openDrawer(C, cashierC)
    const notMade = await nihariBill(drawer)
    const made = await nihariBill(drawer)
    await closeDrawer(drawer, notMade.totalCents + made.totalCents)
    expect(await stockOf()).toBeCloseTo(start - 2, 6)
    expect(await net(C.tenantId, ['5010'], C.conceptId)).toBe(200_000) // the close booked both plates' cost

    const r = await call()(financeC, 'POST', '/pos/shift-corrections', {
      shiftId: drawer, reason: REASON,
      items: [
        { orderId: notMade.id, kind: 'void_bill', reason: 'Rung up twice, never cooked' },
        { orderId: made.id, kind: 'void_bill', reason: 'Wrong table, the food was cooked', foodMade: true },
      ],
    })
    expect(r.statusCode, r.body).toBe(201)
    expect(r.json().items.find((i: { orderId: string }) => i.orderId === made.id).preview.effect.stock).toBe('waste')
    const ok = await call()(ceoC, 'POST', `/pos/shift-corrections/${r.json().id}/approve`, {})
    expect(ok.json().status, ok.body).toBe('applied')

    // One plate back in its lot, the other wasted.
    expect(await stockOf()).toBeCloseTo(start - 1, 6)
    // Cost of sales: neither bill is a sale any more — 5010 nets to zero (never a second credit).
    expect(await net(C.tenantId, ['5010'], C.conceptId)).toBe(0)
    // The cooked plate's cost waits in 1290 for the CEO; inventory is down by exactly that plate.
    expect(await net(C.tenantId, ['1290'])).toBe(100_000)
    expect(await net(C.tenantId, ['1210'])).toBe(-100_000)
    // No cost-of-sales fix or cancel unwind was booked beside the reversal.
    expect(await prisma.journalEntry.count({ where: { tenantId: C.tenantId, reference: { startsWith: 'order_item.return:' } } })).toBe(0)
    expect(await prisma.journalEntry.count({ where: { tenantId: C.tenantId, reference: { startsWith: 'order.cancel_unwind:' } } })).toBe(0)
    const tb = await trialBalance(C.tenantId)
    expect(tb.debits).toBe(tb.credits)
  })
})

describe('void & re-issue on a past business day', () => {
  let D: Company
  let cashierD: Who, financeD: Who, ceoD: Who
  let beef: string
  const YESTERDAY = () => new Date(Date.now() - 86_400_000)

  const stockOf = async () => (await prisma.inventoryItem.findUniqueOrThrow({ where: { id: beef } })).currentStock

  beforeAll(async () => {
    D = await mkCompany(`scor-d-${Date.now()}`, { srbPosId: 7404 })
    await prisma.setting.create({ data: { key: fifoCutoverKey(D.tenantId), value: new Date(Date.now() - 30 * 86_400_000).toISOString() } })
    cashierD = await mkUser('scor-cashier-d', 'cashier', D.tenantId)
    financeD = await mkUser('scor-fin-d', 'finance', D.tenantId)
    ceoD = await mkUser('scor-ceo-d', 'admin', D.tenantId)
    await setConnector(D.tenantId, 'fiscal', { driver: 'test', enabled: true, settings: { test: { scenario: 'ok' }, syncTimeoutMs: 1000, syncAtTill: true, fiscalReportingRequired: true } })
    beef = (await prisma.inventoryItem.create({ data: { tenantId: D.tenantId, name: 'Beef', unit: 'kg', category: 'protein', parLevel: 0 } })).id
    await prisma.$transaction((tx) => addLotTx(tx, {
      tenantId: D.tenantId, inventoryItemId: beef, qty: 50, unitCostCents: 100_000, kind: 'count_gain', lotSourceType: 'count_gain', lotSourceId: 'scor-lot-d',
      movementSourceType: 'test', movementSourceId: 'scor-lot-d', receivedAt: new Date(Date.now() - 5 * 86_400_000),
    }))
    await prisma.recipe.create({
      data: { kind: 'plate', menuItemId: D.items.nihari, servings: 1, qFactorPct: 0, ingredients: { create: [{ inventoryItemId: beef, quantity: 1000, unit: 'kg' }] } },
    })
  }, 60_000)

  /** A Nihari bill paid by `method` on an open drawer (the stock comes out at the sale). */
  async function bill(drawer: string, method: 'cash' | 'card') {
    const r = await call()(cashierD, 'POST', '/pos/orders', { conceptId: D.conceptId, items: [{ menuItemId: D.items.nihari, name: 'Beef Nihari', quantity: 1, unitPriceCents: 145_000, modifiers: [] }], paymentMethod: method })
    expect(r.statusCode, r.body).toBe(201)
    const o = r.json()
    const p = await call()(cashierD, 'POST', '/pos/payments', {
      orderId: o.id, shiftId: drawer,
      payments: [method === 'cash' ? { method, amountCents: o.totalCents, tenderedCents: o.totalCents } : { method, amountCents: o.totalCents, gatewayRef: `SLIP${Date.now()}` }],
    })
    expect(p.statusCode, p.body).toBe(201)
    return o.id as string
  }

  /** Move the drawer and its bills to YESTERDAY, close it there and post its close (dated that business day). */
  async function closeYesterday(drawer: string, orderIds: string[], counted: number) {
    const day = YESTERDAY()
    await prisma.shift.update({ where: { id: drawer }, data: { openedAt: new Date(day.getTime() - 3_600_000), closedAt: new Date(day.getTime() + 3_600_000), status: 'closed', closingFloatCents: counted } })
    await prisma.order.updateMany({ where: { id: { in: orderIds } }, data: { placedAt: day, completedAt: day } })
    await prisma.payment.updateMany({ where: { orderId: { in: orderIds } }, data: { createdAt: day, processedAt: day } })
    const posted = await postShiftClose(drawer)
    expect(posted.entryId, JSON.stringify(posted)).toBeTruthy()
  }

  async function approve(body: Record<string, unknown>) {
    const r = await call()(financeD, 'POST', '/pos/shift-corrections', body)
    expect(r.statusCode, r.body).toBe(201)
    const ok = await call()(ceoD, 'POST', `/pos/shift-corrections/${r.json().id}/approve`, {})
    expect(ok.statusCode, ok.body).toBe(200)
    return { created: r.json(), applied: ok.json() }
  }

  it('cash → card: the corrected bill, its payment and its ONE fiscal sale document are dated the original day; GST at the card rate; stock moved, never drawn twice', async () => {
    const start = await stockOf()
    const drawer = await openDrawer(D, cashierD)
    const wrong = await bill(drawer, 'cash')
    const old = await prisma.order.findUniqueOrThrow({ where: { id: wrong }, include: { items: true } })
    await closeYesterday(drawer, [wrong], old.totalCents)
    const oldDone = await prisma.order.findUniqueOrThrow({ where: { id: wrong } })
    expect(await stockOf()).toBeCloseTo(start - 1, 6)
    expect(await net(D.tenantId, ['5010'], D.conceptId)).toBe(100_000)

    const { created, applied } = await approve({
      shiftId: drawer, reason: 'Guest paid by card, cashier pressed cash',
      items: [{ orderId: wrong, kind: 'void_reissue', newTender: 'card', tenderRef: 'APPR 778812', reason: 'Wrong tender on the bill' }],
    })
    expect(created.items[0].preview.effect).toMatchObject({ order: 'void_and_reissue', stock: 'moves_to_new_bill' })
    expect(created.items[0].preview.reissue).toMatchObject({ tender: 'card', taxRatePct: 8 })
    expect(applied.status, JSON.stringify(applied)).toBe('applied')
    const res = applied.items[0].result as { newOrderId: string; applied: boolean }
    expect(res.applied).toBe(true)

    // The voided bill: cancelled, its tender voided, one fiscal void document.
    expect((await prisma.order.findUniqueOrThrow({ where: { id: wrong } })).status).toBe('cancelled')
    expect((await prisma.fiscalDocument.findMany({ where: { orderId: wrong, kind: 'refund' } })).map((d) => d.idempotencyKey)).toEqual([`void:${wrong}`])

    // The corrected bill: same drawer, completed AS OF the original sale, at the card rate.
    const fresh = await prisma.order.findUniqueOrThrow({ where: { id: res.newOrderId }, include: { items: true, payments: true } })
    expect(fresh).toMatchObject({ status: 'completed', source: 'pos', shiftId: drawer, taxRatePct: 8 })
    expect(fresh.completedAt!.getTime()).toBe(oldDone.completedAt!.getTime())
    expect(fresh.taxCents).toBe(11_600)                 // 8% of 1,450
    expect(fresh.totalCents).toBeLessThan(old.totalCents) // cash 15% → card 8%
    expect(fresh.payments).toHaveLength(1)
    const pay = fresh.payments[0]!
    expect(pay).toMatchObject({ method: 'card', status: 'paid', shiftId: drawer, amountCents: fresh.totalCents, gatewayRef: 'APPR 778812' })
    expect(pay.createdAt.getTime()).toBe(oldDone.completedAt!.getTime())
    expect((pay.gatewayMeta as { correction?: { itemId?: string } }).correction?.itemId).toBe(applied.items[0].id)
    // ONE sale document for the new bill, issued on the original day.
    const sales = await prisma.fiscalDocument.findMany({ where: { orderId: fresh.id, kind: 'sale' } })
    expect(sales).toHaveLength(1)
    expect(String((sales[0]!.payload as { issuedAt?: string }).issuedAt).slice(0, 10)).toBe(fmtPktDate(oldDone.completedAt!))

    // No kitchen ticket: every line is already done.
    expect(fresh.items.every((i) => i.status === 'bumped')).toBe(true)
    // Stock: moved to the new bill, never drawn twice; cost of sales booked once.
    expect(await stockOf()).toBeCloseTo(start - 1, 6)
    expect(await prisma.stockMovement.count({ where: { orderId: wrong } })).toBe(0)
    expect(await prisma.stockMovement.count({ where: { orderId: fresh.id, kind: 'sale' } })).toBeGreaterThan(0)
    expect(await net(D.tenantId, ['5010'], D.conceptId)).toBe(100_000)

    // The re-posted close carries the new bill: output tax = the new bill's; the books balance.
    const repost = await prisma.journalEntry.findFirstOrThrow({ where: { tenantId: D.tenantId, reference: `shift.close:${drawer}@2` }, include: { lines: { include: { account: { select: { code: true } } } } } })
    expect(fmtPktDate(repost.entryDate)).toBe(fmtPktDate(oldDone.completedAt!))
    expect(repost.lines.some((l) => l.account.code === '1030' && l.type === 'debit' && Number(l.amountCents) === fresh.totalCents)).toBe(true)
    expect(await net(D.tenantId, OUTPUT_TAX_ACCOUNTS, D.conceptId)).toBe(-fresh.taxCents)
    const tb = await trialBalance(D.tenantId)
    expect(tb.debits).toBe(tb.credits)
  })

  it('card → cash: the corrected bill is at the cash rate and paid in cash', async () => {
    const drawer = await openDrawer(D, cashierD)
    const wrong = await bill(drawer, 'card')
    await closeYesterday(drawer, [wrong], 0)
    const { applied } = await approve({
      shiftId: drawer, reason: 'Guest paid cash, cashier pressed card',
      items: [{ orderId: wrong, kind: 'void_reissue', newTender: 'cash', reason: 'Wrong tender on the bill' }],
    })
    expect(applied.status, JSON.stringify(applied)).toBe('applied')
    const fresh = await prisma.order.findUniqueOrThrow({ where: { id: applied.items[0].result.newOrderId }, include: { payments: true } })
    expect(fresh.taxRatePct).toBe(15)
    expect(fresh.payments.map((p) => [p.method, p.status, p.amountCents])).toEqual([['cash', 'paid', fresh.totalCents]])
    // The counted cash (0) stays — the drawer is short by the cash bill until someone explains it.
    expect(applied.result.drawer.varianceCents).toBe(-fresh.totalCents)
    const tb = await trialBalance(D.tenantId)
    expect(tb.debits).toBe(tb.credits)
  })

  it('→ Raast: a failure mid-apply (no receiving account) is retried without a second bill; a used reference is 409', async () => {
    const drawer = await openDrawer(D, cashierD)
    const wrong = await bill(drawer, 'cash')
    const other = await bill(drawer, 'cash')
    const o1 = await prisma.order.findUniqueOrThrow({ where: { id: wrong } })
    const o2 = await prisma.order.findUniqueOrThrow({ where: { id: other } })
    await closeYesterday(drawer, [wrong, other], o1.totalCents + o2.totalCents)
    const r = await call()(financeD, 'POST', '/pos/shift-corrections', {
      shiftId: drawer, reason: 'Guest paid by Raast, cashier pressed cash',
      items: [{ orderId: wrong, kind: 'void_reissue', newTender: 'raast', tenderRef: 'FT26102177881', reason: 'Wrong tender on the bill' }],
    })
    expect(r.statusCode, r.body).toBe(201)
    const id = r.json().id
    // No Raast receiving account yet: the void went through, the re-issue stops at the payment.
    const failed = await call()(ceoD, 'POST', `/pos/shift-corrections/${id}/approve`, {})
    expect(failed.json().status, failed.body).toBe('failed')
    expect(failed.json().error).toMatch(/RAAST_NOT_SET_UP/)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: wrong } })).status).toBe('cancelled')

    await mkRaastAccount(D)
    const retried = await call()(ceoD, 'POST', `/pos/shift-corrections/${id}/retry`, {})
    expect(retried.statusCode, retried.body).toBe(200)
    expect(retried.json().status, retried.body).toBe('applied')
    const key = `shift-correction:${r.json().items[0].id}`
    const issued = await prisma.order.findMany({ where: { externalId: key } })
    expect(issued).toHaveLength(1)
    expect(await prisma.payment.count({ where: { orderId: issued[0]!.id } })).toBe(1)
    const receipt = await prisma.raastReceipt.findFirstOrThrow({ where: { orderId: issued[0]!.id } })
    expect(receipt).toMatchObject({ bankRef: 'FT26102177881', status: 'provisional', tenantId: D.tenantId })
    const o1Day = await prisma.order.findUniqueOrThrow({ where: { id: wrong } })
    expect(receipt.createdAt.getTime()).toBe(o1Day.completedAt!.getTime())
    expect(issued[0]!.completedAt!.getTime()).toBe(o1Day.completedAt!.getTime())
    expect(await prisma.fiscalDocument.count({ where: { orderId: issued[0]!.id, kind: 'sale' } })).toBe(1)

    // The same bank reference for another bill → 409 (one transfer pays one bill).
    const dup = await call()(financeD, 'POST', '/pos/shift-corrections', {
      shiftId: drawer, reason: 'Second guest also paid by Raast',
      items: [{ orderId: other, kind: 'void_reissue', newTender: 'raast', tenderRef: 'ft-2610 2177 881', reason: 'Wrong tender on the bill' }],
    })
    expect(dup.statusCode, dup.body).toBe(409)
    expect(dup.json().error.code).toBe('RAAST_REF_USED')
    const tb = await trialBalance(D.tenantId)
    expect(tb.debits).toBe(tb.credits)
  })
})

describe('Raast QR bills (correctable like cash and card)', () => {
  let R: Company
  let cashierR: Who, financeR: Who, ceoR: Who
  let bank: { bankAccountId: string; ledgerCode: string }
  const CARD_TOTAL = 118_800 // 2 × Kheer at the card / Raast rate (8%)
  let refN = 0
  const bankRef = () => `FT2610${Date.now().toString().slice(-6)}${String(++refN).padStart(2, '0')}`
  const YESTERDAY = () => new Date(Date.now() - 86_400_000)

  beforeAll(async () => {
    R = await mkCompany(`scor-r-${Date.now()}`, { srbPosId: 7405 })
    cashierR = await mkUser('scor-cashier-r', 'cashier', R.tenantId)
    financeR = await mkUser('scor-fin-r', 'finance', R.tenantId)
    ceoR = await mkUser('scor-ceo-r', 'admin', R.tenantId)
    await setConnector(R.tenantId, 'fiscal', { driver: 'test', enabled: true, settings: { test: { scenario: 'ok' }, syncTimeoutMs: 1000, syncAtTill: true, fiscalReportingRequired: true } })
    bank = await mkRaastAccount(R)
  }, 60_000)

  /** A bill paid by Raast QR on an open drawer (the cashier checked the counter device). */
  async function raastBill(drawer: string) {
    const o = await ringKheer(app, cashierR, R)
    const r = await call()(cashierR, 'POST', '/pos/payments', { orderId: o.id, shiftId: drawer, payments: [{ method: 'raast', amountCents: CARD_TOTAL, gatewayRef: bankRef(), raastVerified: true }] })
    expect(r.statusCode, r.body).toBe(201)
    const order = await prisma.order.findUniqueOrThrow({ where: { id: o.id } })
    expect(order.status).toBe('completed')
    const receipt = await prisma.raastReceipt.findFirstOrThrow({ where: { orderId: o.id } })
    expect(receipt).toMatchObject({ status: 'provisional', ledgerCode: bank.ledgerCode })
    return { order, receipt }
  }

  async function submit(body: Record<string, unknown>) {
    return call()(financeR, 'POST', '/pos/shift-corrections', body)
  }

  const closeLines = (reference: string) => prisma.journalEntry.findFirstOrThrow({
    where: { tenantId: R.tenantId, reference }, include: { lines: { include: { account: { select: { code: true } } } } },
  })

  it('provisional receipt + void_bill: the bill is cancelled, the receipt voided (never matched), the close re-posted without the Raast money; a retry after a refused void is idempotent', async () => {
    const drawer = await openDrawer(R, cashierR)
    const { order, receipt } = await raastBill(drawer)
    await closeDrawer(drawer, 0)
    const original = await closeLines(`shift.close:${drawer}`)
    expect(original.lines.some((l) => l.account.code === bank.ledgerCode && l.type === 'debit' && Number(l.amountCents) === CARD_TOTAL)).toBe(true)

    // The drawer view: the Raast bill is correctable.
    const view = await call()(financeR, 'GET', `/pos/shift-corrections/shift/${drawer}`)
    expect(view.statusCode, view.body).toBe(200)
    expect(view.json().orders.find((o: { orderId: string }) => o.orderId === order.id)).toMatchObject({ kind: 'void_bill', blockedBy: null, raastStatus: 'provisional' })

    const r = await submit({ shiftId: drawer, reason: 'Test bill rung on the live till', items: [{ orderId: order.id, kind: 'void_bill', reason: 'Test bill, no money was sent' }] })
    expect(r.statusCode, r.body).toBe(201)
    expect(r.json().items[0].preview.effect).toMatchObject({ order: 'void_final_bill', money: 'voided', raast: 'cancelled', reversesRevenue: true })

    // A refused posting on the bill holds the Raast void (RAAST_CLOSE_PENDING) — the set fails AFTER the re-post.
    const flag = await prisma.exceptionFlag.create({
      data: { tenantId: R.tenantId, kind: 'posting_failed', severity: 'high', title: 'held', description: 'x', entityType: 'Order', entityId: order.id, status: 'open' },
    })
    const failed = await call()(ceoR, 'POST', `/pos/shift-corrections/${r.json().id}/approve`, {})
    expect(failed.statusCode, failed.body).toBe(200)
    expect(failed.json().status, failed.body).toBe('failed')
    expect(failed.json().error).toMatch(/RAAST_CLOSE_PENDING/)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('cancelled')
    expect((await prisma.raastReceipt.findUniqueOrThrow({ where: { id: receipt.id } })).status).toBe('provisional')
    const entriesAfterFail = await prisma.journalEntry.count({ where: { tenantId: R.tenantId } })

    await prisma.exceptionFlag.update({ where: { id: flag.id }, data: { status: 'resolved' } })
    const retried = await call()(ceoR, 'POST', `/pos/shift-corrections/${r.json().id}/retry`, {})
    expect(retried.statusCode, retried.body).toBe(200)
    expect(retried.json().status, retried.body).toBe('applied')
    // Nothing re-posted twice: the retry only voided the receipt.
    expect(await prisma.journalEntry.count({ where: { tenantId: R.tenantId } })).toBe(entriesAfterFail)

    const v = await prisma.raastReceipt.findUniqueOrThrow({ where: { id: receipt.id } })
    expect(v).toMatchObject({ status: 'voided', voidedById: ceoR.id, bankRef: receipt.bankRef, statementLineId: null })
    expect(v.voidReason).toMatch(/Shift correction/)
    expect(retried.json().items[0].result.raastReceiptsVoided).toEqual([receipt.id])
    const pay = await prisma.payment.findFirstOrThrow({ where: { orderId: order.id, method: 'raast' } })
    expect(pay.status).toBe('failed')

    // The close: reversed and re-posted with no Raast money — no bank debit, no refund due; the bank nets to zero.
    await closeLines(`shift.close.reversal:${drawer}`)
    const repost = await prisma.journalEntry.findFirst({ where: { tenantId: R.tenantId, reference: `shift.close:${drawer}@2` }, include: { lines: { include: { account: { select: { code: true } } } } } })
    expect(repost?.lines.some((l) => l.account.code === bank.ledgerCode) ?? false).toBe(false)
    expect(repost?.lines.some((l) => (l.memo ?? '').includes(order.id)) ?? false).toBe(false)
    expect(await net(R.tenantId, [bank.ledgerCode])).toBe(0)
    expect(await revenueNet(R.tenantId, R.conceptId)).toBe(0)
    const tb = await trialBalance(R.tenantId)
    expect(tb.debits).toBe(tb.credits)
    // A second retry is refused (applied) — nothing moves.
    expect((await call()(ceoR, 'POST', `/pos/shift-corrections/${r.json().id}/retry`, {})).statusCode).toBe(409)
  })

  it('matched receipt (the money reached the bank) + void with no money returned → 422 RAAST_MONEY_RECEIVED; void & re-issue too', async () => {
    const drawer = await openDrawer(R, cashierR)
    const { order, receipt } = await raastBill(drawer)
    await closeDrawer(drawer, 0)
    await prisma.raastReceipt.update({ where: { id: receipt.id }, data: { status: 'matched', matchedAt: new Date() } })

    // The drawer view: still correctable (with the money handed back), its receipt shown as matched.
    const view = await call()(financeR, 'GET', `/pos/shift-corrections/shift/${drawer}`)
    expect(view.json().orders.find((o: { orderId: string }) => o.orderId === order.id)).toMatchObject({ kind: 'void_bill', blockedBy: null, raastStatus: 'matched' })

    const r = await submit({ shiftId: drawer, reason: 'Guest disputes this Raast bill', items: [{ orderId: order.id, kind: 'void_bill', reason: 'Guest says it was a test' }] })
    expect(r.statusCode, r.body).toBe(422)
    expect(r.json().error.code).toBe('RAAST_MONEY_RECEIVED')
    const re = await submit({ shiftId: drawer, reason: 'Guest paid cash, cashier pressed Raast', items: [{ orderId: order.id, kind: 'void_reissue', newTender: 'cash', reason: 'Wrong tender on the bill' }] })
    expect(re.statusCode, re.body).toBe(422)
    expect(re.json().error.code).toBe('RAAST_MONEY_RECEIVED')
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('completed')
  })

  it('matched receipt + money handed back: the receipt is kept and the money is a REFUND DUE on till clearing', async () => {
    const drawer = await openDrawer(R, cashierR)
    const { order, receipt } = await raastBill(drawer)
    await closeDrawer(drawer, 0)
    await prisma.raastReceipt.update({ where: { id: receipt.id }, data: { status: 'matched', matchedAt: new Date() } })
    const bankBefore = await net(R.tenantId, [bank.ledgerCode])

    const r = await submit({ shiftId: drawer, reason: 'Guest refused the order after paying', items: [{ orderId: order.id, kind: 'void_bill', reason: 'Raast money sent back to the guest', moneyReturned: true }] })
    expect(r.statusCode, r.body).toBe(201)
    expect(r.json().items[0].preview.effect).toMatchObject({ money: 'owed_back', raast: 'owed_back' })
    const ok = await call()(ceoR, 'POST', `/pos/shift-corrections/${r.json().id}/approve`, {})
    expect(ok.json().status, ok.body).toBe('applied')

    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('cancelled')
    expect((await prisma.raastReceipt.findUniqueOrThrow({ where: { id: receipt.id } })).status).toBe('matched')
    expect((await prisma.payment.findFirstOrThrow({ where: { orderId: order.id, method: 'raast' } })).status).toBe('paid')
    const repost = await closeLines(`shift.close:${drawer}@2`)
    const due = repost.lines.find((l) => l.type === 'credit' && (l.memo ?? '').startsWith('REFUND DUE') && (l.memo ?? '').includes(order.id))
    expect(due && Number(due.amountCents)).toBe(CARD_TOTAL)
    expect(['1110', '1115']).toContain(due!.account.code)
    expect(repost.lines.some((l) => l.account.code === bank.ledgerCode && l.type === 'debit' && Number(l.amountCents) === CARD_TOTAL)).toBe(true)
    // The bank still holds the money once (reversal + re-post, never twice); revenue gone.
    expect(await net(R.tenantId, [bank.ledgerCode])).toBe(bankBefore)
    const tb = await trialBalance(R.tenantId)
    expect(tb.debits).toBe(tb.credits)
  })

  it('Raast → cash re-issue: the Raast receipt is voided; the new cash bill is on the original day at the cash GST', async () => {
    const drawer = await openDrawer(R, cashierR)
    const { order, receipt } = await raastBill(drawer)
    const day = YESTERDAY()
    await prisma.shift.update({ where: { id: drawer }, data: { openedAt: new Date(day.getTime() - 3_600_000), closedAt: new Date(day.getTime() + 3_600_000), status: 'closed', closingFloatCents: 0 } })
    await prisma.order.update({ where: { id: order.id }, data: { placedAt: day, completedAt: day } })
    await prisma.payment.updateMany({ where: { orderId: order.id }, data: { createdAt: day, processedAt: day } })
    expect((await postShiftClose(drawer)).entryId).toBeTruthy()
    const bankBefore = await net(R.tenantId, [bank.ledgerCode])

    const r = await submit({ shiftId: drawer, reason: 'Guest paid cash, cashier pressed Raast', items: [{ orderId: order.id, kind: 'void_reissue', newTender: 'cash', reason: 'Wrong tender on the bill' }] })
    expect(r.statusCode, r.body).toBe(201)
    expect(r.json().items[0].preview.effect).toMatchObject({ order: 'void_and_reissue', raast: 'cancelled' })
    expect(r.json().items[0].preview.reissue).toMatchObject({ tender: 'cash', taxRatePct: 15 })
    const ok = await call()(ceoR, 'POST', `/pos/shift-corrections/${r.json().id}/approve`, {})
    expect(ok.json().status, ok.body).toBe('applied')

    expect((await prisma.raastReceipt.findUniqueOrThrow({ where: { id: receipt.id } })).status).toBe('voided')
    const fresh = await prisma.order.findUniqueOrThrow({ where: { id: ok.json().items[0].result.newOrderId }, include: { payments: true } })
    expect(fresh).toMatchObject({ status: 'completed', shiftId: drawer, taxRatePct: 15 })
    expect(fresh.completedAt!.getTime()).toBe(day.getTime())
    expect(fresh.taxCents).toBe(16_500) // 15% of 1,100
    expect(fresh.payments.map((p) => [p.method, p.status, p.amountCents])).toEqual([['cash', 'paid', fresh.totalCents]])
    expect(fresh.payments[0]!.createdAt.getTime()).toBe(day.getTime())
    // The re-posted close, on the original day: cash, no Raast bank debit.
    const repost = await closeLines(`shift.close:${drawer}@2`)
    expect(fmtPktDate(repost.entryDate)).toBe(fmtPktDate(day))
    expect(repost.lines.some((l) => l.account.code === bank.ledgerCode)).toBe(false)
    expect(await net(R.tenantId, [bank.ledgerCode])).toBe(bankBefore - CARD_TOTAL)
    const tb = await trialBalance(R.tenantId)
    expect(tb.debits).toBe(tb.credits)
  })
})

// ─── F3: separation of duties, retry rights, interrupted applies ───────────────
describe('shift corrections — own drawer, retry right, interrupted apply', () => {
  let financeRan: Who, financeClosed: Who

  beforeAll(async () => {
    financeRan = await mkUser('scor-fin-ran', 'finance', A.tenantId)
    financeClosed = await mkUser('scor-fin-closed', 'finance', A.tenantId)
  })

  async function closedDrawerWithBill() {
    const drawer = await openDrawer(A, cashierA)
    const bill = await paidBill(A, cashierA, drawer)
    // Closed through the till's own route: the closer is recorded.
    const c = await call()(cashierA, 'POST', `/pos/shifts/${drawer}/close`, { closingFloatCents: bill.totalCents, confirmOpenTickets: true })
    expect(c.statusCode, c.body).toBe(200)
    await postShiftClose(drawer)
    return { drawer, bill }
  }

  const body = (drawer: string, orderId: string) => ({ shiftId: drawer, reason: REASON, items: [{ orderId, kind: 'void_bill', reason: 'Duplicate bill of table 9' }] })

  it('the till close records who closed the drawer', async () => {
    const { drawer } = await closedDrawerWithBill()
    const row = await prisma.auditLog.findFirst({ where: { action: 'pos.shift.close', entity: 'Shift', entityId: drawer } })
    expect(row).toMatchObject({ userId: cashierA.id, tenantId: A.tenantId })
  })

  it('finance never raises a correction on a drawer it ran or closed (403 SELF_CORRECTION_BLOCKED); the CEO is exempt', async () => {
    const { drawer, bill } = await closedDrawerWithBill()
    await prisma.shift.update({ where: { id: drawer }, data: { userId: financeRan.id } })
    const ran = await call()(financeRan, 'POST', '/pos/shift-corrections', body(drawer, bill.id))
    expect(ran.statusCode, ran.body).toBe(403)
    expect(ran.json().error.code).toBe('SELF_CORRECTION_BLOCKED')

    const d2 = await closedDrawerWithBill()
    await prisma.auditLog.create({ data: { category: 'accounting', action: 'pos.shift.close', entity: 'Shift', entityId: d2.drawer, userId: financeClosed.id, tenantId: A.tenantId } })
    const closed = await call()(financeClosed, 'POST', '/pos/shift-corrections', body(d2.drawer, d2.bill.id))
    expect(closed.statusCode, closed.body).toBe(403)
    expect(closed.json().error.code).toBe('SELF_CORRECTION_BLOCKED')
    // Another finance login may raise it.
    const other = await call()(financeA, 'POST', '/pos/shift-corrections', body(d2.drawer, d2.bill.id))
    expect(other.statusCode, other.body).toBe(201)
    await call()(ceoA, 'POST', `/pos/shift-corrections/${other.json().id}/reject`, { note: 'Not needed after all, tested only' })

    // The CEO is exempt: a drawer the CEO ran.
    const d3 = await closedDrawerWithBill()
    await prisma.shift.update({ where: { id: d3.drawer }, data: { userId: ceoA.id } })
    const ceo = await call()(ceoA, 'POST', '/pos/shift-corrections', body(d3.drawer, d3.bill.id))
    expect(ceo.statusCode, ceo.body).toBe(201)
    await call()(ceoA, 'POST', `/pos/shift-corrections/${ceo.json().id}/reject`, { note: 'Not needed after all, tested only' })
  })

  it('an apply left "approved" is swept to failed after 5 minutes idle; Retry needs the approve right and finishes it', async () => {
    const { sweepStaleApplies } = await import('../src/modules/shiftCorrections/service.js')
    const { drawer, bill } = await closedDrawerWithBill()
    const r = await call()(financeA, 'POST', '/pos/shift-corrections', body(drawer, bill.id))
    expect(r.statusCode, r.body).toBe(201)
    const id = r.json().id as string
    // The process died after the CEO's claim, before the apply ran.
    await prisma.shiftCorrection.update({ where: { id }, data: { status: 'approved', decidedById: ceoA.id, decidedAt: new Date() } })

    // Fresh: not touched.
    expect(await sweepStaleApplies()).not.toContain(id)
    expect((await prisma.shiftCorrection.findUniqueOrThrow({ where: { id } })).status).toBe('approved')
    // Retry refuses a set that is not failed.
    expect((await call()(ceoA, 'POST', `/pos/shift-corrections/${id}/retry`, {})).json().error.code).toBe('NOT_FAILED')

    // Ten minutes idle → failed, with the reason; the sweep is idempotent.
    expect(await sweepStaleApplies(new Date(Date.now() + 10 * 60_000))).toContain(id)
    const failed = await prisma.shiftCorrection.findUniqueOrThrow({ where: { id } })
    expect(failed.status).toBe('failed')
    expect(failed.error).toMatch(/^APPLY_INTERRUPTED/)
    expect(await sweepStaleApplies(new Date(Date.now() + 10 * 60_000))).not.toContain(id)
    await flushNotifications()

    // Retry: another company's CEO 404, finance 403, the set's own CEO applies it.
    expect((await call()(ceoB, 'POST', `/pos/shift-corrections/${id}/retry`, {})).statusCode).toBe(404)
    expect((await call()(financeA, 'POST', `/pos/shift-corrections/${id}/retry`, {})).statusCode).toBe(403)
    const ok = await call()(ceoA, 'POST', `/pos/shift-corrections/${id}/retry`, {})
    expect(ok.statusCode, ok.body).toBe(200)
    expect(ok.json().status, ok.body).toBe('applied')
    expect((await prisma.order.findUniqueOrThrow({ where: { id: bill.id } })).status).toBe('cancelled')
  })
})
