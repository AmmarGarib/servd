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
//   - cancel_kot: an open ticket cancelled, nothing posted.
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
  prisma, mkCompany, mkUser, caller, setConnector, resetConnectorCache, openDrawer, ringKheer,
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

  it('refuses void & re-issue (not built) and an order that is not on the drawer', async () => {
    const r = await call()(financeA, 'POST', '/pos/shift-corrections', {
      shiftId: drawer, reason: REASON, items: [{ orderId: bill1.id, kind: 'void_reissue', newTender: 'card', reason: 'Paid by card, rung as cash' }],
    })
    expect(r.statusCode, r.body).toBe(422)
    expect(r.json().error.code).toBe('VOID_REISSUE_NOT_AVAILABLE')
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
    expect(r.json().items[1].preview.effect.stock).toBe('waste')
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
