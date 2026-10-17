// S-1 card-machine pay-out (owner, 2026-10-17: "add card machine payout for
// credit notes"). A bill paid on the card machine and credited in full by a
// credit note (money owed back) is paid back to the card through the EXISTING
// terminal refund flow (POST /pos/terminal/refunds → machine → recordRefund →
// refundOrder → payOutCreditNote):
//   - capped at what the credit note still owes back, less pay-outs made and
//     card refunds still in flight on the machine (409 AMOUNT_EXCEEDS_REFUNDABLE);
//   - booked as the hand-back: Dr till clearing / Cr 1030, refund row marked
//     gatewayMeta.refund.creditNoteId, no fiscal document, never revenue;
//   - a decline books nothing; a duplicate confirmation books once;
//   - another company's manager gets 404.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import {
  prisma, mkCompany, mkUser, buildApp, caller, setConnector, resetConnectorCache, openDrawer, terminalSettings, ringKheer,
  type Company, type Who,
} from './connectorsFixtures.js'
import { setConnectorClock } from '../src/connectors/registry.js'
import { setFiscalKicker } from '../src/connectors/fiscal/outbox.js'
import { applyChargeState, recordApprovedCharge } from '../src/connectors/terminal/service.js'
import { issueInvoiceForOrder, issueCreditNoteForOrder } from '../src/modules/invoices/service.js'
import { refundOrder } from '../src/modules/pos/service.js'
import { sumCents } from '../src/lib/money.js'

let app: FastifyInstance
let call: ReturnType<typeof caller>
let A: Company, B: Company
let cashier: Who, manager: Who, managerB: Who
let drawer: string
let offset = 0
let n = 0
const key = () => `cnp-${Date.now()}-${n++}`
let bill: { orderId: string; paymentId: string; totalCents: number }
let cnId: string

async function cardSale(): Promise<{ orderId: string; paymentId: string; totalCents: number }> {
  const o = await ringKheer(app, cashier, A)
  const q = await call(cashier, 'GET', `/pos/orders/${o.id}/quote?method=card`)
  const r = await call(cashier, 'POST', '/pos/terminal/charges', { orderId: o.id, shiftId: drawer, terminalId: 'trm-1', expectedDueCents: q.json().dueCents, idempotencyKey: key() })
  expect(r.statusCode, r.body).toBe(201)
  offset += 2_000
  await new Promise((res) => setTimeout(res, 1_100))
  const done = await call(cashier, 'GET', `/pos/terminal/charges/${r.json().id}`)
  expect(done.json().status, done.body).toBe('recorded')
  return { orderId: o.id, paymentId: done.json().payment.id, totalCents: q.json().dueCents }
}

const startRefund = (who: Who, amountCents: number) =>
  call(who, 'POST', '/pos/terminal/refunds', { paymentId: bill.paymentId, amountCents, terminalId: 'trm-1', idempotencyKey: key(), reason: 'Credit note paid back to the card' })

async function net1110(tenantId: string): Promise<number> {
  const rows = await prisma.journalLine.groupBy({
    by: ['type'], _sum: { amountCents: true },
    where: { account: { tenantId, code: { in: ['1110', '1115'] } }, journalEntry: { tenantId } },
  })
  return sumCents(rows.find((x) => x.type === 'debit')?._sum.amountCents) - sumCents(rows.find((x) => x.type === 'credit')?._sum.amountCents)
}

const payoutRows = () => prisma.payment.findMany({ where: { orderId: bill.orderId, status: 'refunded' }, orderBy: { createdAt: 'asc' } })

beforeAll(async () => {
  setFiscalKicker(async () => {})
  setConnectorClock(() => new Date(Date.now() + offset))
  A = await mkCompany(`cnp-a-${Date.now()}`)
  B = await mkCompany(`cnp-b-${Date.now()}`)
  cashier = await mkUser('cnpCashier', 'cashier', A.tenantId)
  manager = await mkUser('cnpManager', 'foh_management', A.tenantId)
  managerB = await mkUser('cnpManagerB', 'foh_management', B.tenantId)
  await setConnector(A.tenantId, 'terminal', { driver: 'test', enabled: true, settings: terminalSettings(A, 'approve') })
  await setConnector(B.tenantId, 'terminal', { driver: 'test', enabled: true, settings: terminalSettings(B, 'approve') })
  app = await buildApp()
  call = caller(app)
  drawer = await openDrawer(A, cashier)
  bill = await cardSale()
  await issueInvoiceForOrder({ orderId: bill.orderId })
  const cn = await issueCreditNoteForOrder(bill.orderId, 'Guest returned the meal', { actor: { id: manager.id, role: manager.role } })
  expect(cn.owedBackCents).toBe(bill.totalCents)
  cnId = cn.id
  expect((await prisma.order.findUniqueOrThrow({ where: { id: bill.orderId } })).status).toBe('refunded')
  expect(await net1110(A.tenantId)).toBe(-bill.totalCents)
}, 60_000)

afterAll(async () => {
  setConnectorClock(null)
  setFiscalKicker(null)
  resetConnectorCache()
  await app.close()
})

describe('card-machine pay-out of a credit note', () => {
  it('more than the credit note owes back is refused before the machine moves money', async () => {
    const r = await startRefund(manager, bill.totalCents + 1)
    expect(r.statusCode, r.body).toBe(409)
    expect(r.json().error.code).toBe('AMOUNT_EXCEEDS_REFUNDABLE')
    expect(await prisma.terminalCharge.count({ where: { orderId: bill.orderId, kind: 'refund' } })).toBe(0)
  })

  it('another company\'s manager gets 404', async () => {
    const r = await startRefund(managerB, 1_000)
    expect(r.statusCode, r.body).toBe(404)
  })

  it('a machine decline records nothing', async () => {
    const r = await startRefund(manager, 10_000)
    expect(r.statusCode, r.body).toBe(201)
    await applyChargeState(r.json().id, { state: 'declined', reason: 'TEST_DECLINED' }, 'webhook')
    const c = await prisma.terminalCharge.findUniqueOrThrow({ where: { id: r.json().id } })
    expect(c.status).toBe('declined')
    expect(c.paymentId).toBeNull()
    expect(await payoutRows()).toHaveLength(0)
    expect(await net1110(A.tenantId)).toBe(-bill.totalCents)
  })

  it('a refund still in flight counts: a second start beyond the rest is refused; within the rest it starts', async () => {
    const first = await startRefund(manager, 100_000)
    expect(first.statusCode, first.body).toBe(201)
    expect(first.json().status).toBe('sent') // on the machine, not booked yet
    const tooMuch = await startRefund(manager, bill.totalCents - 100_000 + 1)
    expect(tooMuch.statusCode, tooMuch.body).toBe(409)
    expect(tooMuch.json().error.code).toBe('AMOUNT_EXCEEDS_REFUNDABLE')
    // The till cannot pay out the money on its way back to the card either.
    const tillDrawer = await openDrawer(A, manager)
    const till = await call(manager, 'POST', `/pos/orders/${bill.orderId}/refund`, { amountCents: bill.totalCents - 100_000 + 1, reason: 'Credit note paid out', method: 'card', shiftId: tillDrawer })
    expect(till.statusCode, till.body).toBe(422)
    expect(till.json().error.code).toBe('REFUND_EXCEEDS_DUE')
    const rest = await startRefund(manager, bill.totalCents - 100_000)
    expect(rest.statusCode, rest.body).toBe(201)

    // The machine confirms both: each is booked as the credit note's hand-back.
    for (const id of [first.json().id, rest.json().id]) {
      const polled = await call(manager, 'GET', `/pos/terminal/charges/${id}`)
      expect(polled.json().status, polled.body).toBe('recorded')
    }
    const rows = await payoutRows()
    expect(rows.map((r) => -r.amountCents).sort((a, b) => a - b)).toEqual([bill.totalCents - 100_000, 100_000].sort((a, b) => a - b))
    for (const row of rows) {
      expect(row.method).toBe('card')
      expect((row.gatewayMeta as { refund: { creditNoteId: string } }).refund.creditNoteId).toBe(cnId)
      const e = await prisma.journalEntry.findFirstOrThrow({
        where: { tenantId: A.tenantId, reference: `order.refund:${row.id}` },
        include: { lines: { include: { account: { select: { code: true } } } } },
      })
      expect(e.lines.map((l) => `${l.type}:${l.account.code}`).sort()).toEqual(['credit:1030', 'debit:1110'])
    }
    expect(await net1110(A.tenantId)).toBe(0)
    // The credit note filed the return; a pay-out files nothing.
    expect(await prisma.fiscalDocument.count({ where: { orderId: bill.orderId, kind: 'refund' } })).toBe(1)
    // Nothing is left to pay out.
    const more = await startRefund(manager, 100)
    expect(more.statusCode, more.body).toBe(409)
  })

  it('a duplicate confirmation books once', async () => {
    const charge = await prisma.terminalCharge.findFirstOrThrow({ where: { orderId: bill.orderId, kind: 'refund', status: 'recorded' }, orderBy: { createdAt: 'asc' } })
    const before = await payoutRows()
    await recordApprovedCharge(charge.id)
    // A booking that lost its lease and runs again goes through the engine's own replay.
    const again = await refundOrder({
      orderId: bill.orderId, amountCents: charge.amountCents, reason: 'Credit note paid back to the card', actorId: manager.id, actorRole: manager.role,
      method: 'card', gateway: 'card_terminal', gatewayRef: charge.approvalRef ?? `TERM-${charge.id}`, terminalChargeId: charge.id, shiftId: null,
    })
    expect(again.id).toBe(charge.paymentId)
    expect(await payoutRows()).toHaveLength(before.length)
    expect(await net1110(A.tenantId)).toBe(0)
  })
})
