// S-1 (owner, 2026-10-17: "Allow it, owed back"). A credit note on a completed
// bill that was never refunded is a sales return with the money still owed to
// the customer:
//   - ledger: ONE 'order.credit_note:<cnId>' entry — Dr the brand's revenue and
//     the output tax back to the account the sale credited / Cr till clearing
//     (REFUND DUE — owed back), never cash / card;
//   - fiscal POS: ONE refund document ('void:<orderId>') in the same transaction;
//   - the order goes to 'refunded' (no second refund can book it again);
//   - a second credit note is 409; another company's bill is 404;
//   - the till pays it out (refundOrder on the refunded bill, gatewayMeta.refund.creditNoteId):
//     Dr till clearing / Cr the drawer, never revenue or tax, no fiscal document; capped at what
//     is still owed (422); a backfill repost books only the hand-back.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import { AppError, errorResponse } from '../src/lib/errors.js'
import { posRoutes } from '../src/modules/pos/routes.js'
import { invoiceRoutes } from '../src/modules/invoices/routes.js'
import { setFiscalKicker } from '../src/connectors/fiscal/outbox.js'
import { closeShift } from '../src/modules/pos/service.js'
import { postShiftClose } from '../src/modules/accounting/shiftPosting.js'
import { issueInvoiceForOrder } from '../src/modules/invoices/service.js'
import { OUTPUT_TAX_ACCOUNTS, postRefundPayment } from '../src/modules/accounting/orderPosting.js'
import { sumCents } from '../src/lib/money.js'
import {
  prisma, mkCompany, mkUser, caller, setConnector, resetConnectorCache, openDrawer, ringKheer,
  type Company, type Who,
} from './connectorsFixtures.js'

let app: FastifyInstance
let A: Company, B: Company
let cashierA: Who, mgrA: Who, cashierB: Who, mgrB: Who

async function build(): Promise<FastifyInstance> {
  const a = Fastify()
  a.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.statusCode).send(errorResponse(err))
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', issues: err.issues } })
    return reply.status(500).send({ error: { code: 'INTERNAL', message: (err as Error).message } })
  })
  await a.register(posRoutes, { prefix: '/pos' })
  await a.register(invoiceRoutes, { prefix: '/invoices' })
  await a.ready()
  return a
}

/** A paid, completed cash bill whose drawer is closed (the sale is on the books), with its tax invoice. */
async function soldBill(co: Company, cashier: Who) {
  const drawer = await openDrawer(co, cashier)
  const o = await ringKheer(app, cashier, co)
  const r = await caller(app)(cashier, 'POST', '/pos/payments', { orderId: o.id, shiftId: drawer, payments: [{ method: 'cash', amountCents: o.totalCents, tenderedCents: o.totalCents }] })
  expect(r.statusCode, r.body).toBe(201)
  await closeShift(drawer, o.totalCents)
  const posted = await postShiftClose(drawer) // idempotent: the close's own post may still be running
  expect(posted.entryId, JSON.stringify(posted)).toBeTruthy()
  await issueInvoiceForOrder({ orderId: o.id })
  return { id: o.id, totalCents: o.totalCents, drawer }
}

/** Net (debit − credit) on account codes in a company, optionally for one brand. */
async function net(tenantId: string, codes: readonly string[], conceptId?: string) {
  const rows = await prisma.journalLine.groupBy({
    by: ['type'], _sum: { amountCents: true },
    where: { account: { tenantId, code: { in: [...codes] } }, journalEntry: { tenantId }, ...(conceptId && { conceptId }) },
  })
  return sumCents(rows.find((x) => x.type === 'debit')?._sum.amountCents) - sumCents(rows.find((x) => x.type === 'credit')?._sum.amountCents)
}

beforeAll(async () => {
  A = await mkCompany(`cnob-a-${Date.now()}`, { srbPosId: 7301 })
  B = await mkCompany(`cnob-b-${Date.now()}`, { srbPosId: 7302 })
  cashierA = await mkUser('cnob-cashier-a', 'cashier', A.tenantId)
  mgrA = await mkUser('cnob-mgr-a', 'admin', A.tenantId)
  cashierB = await mkUser('cnob-cashier-b', 'cashier', B.tenantId)
  mgrB = await mkUser('cnob-mgr-b', 'admin', B.tenantId)
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

describe('a credit note on a completed bill that was never refunded', () => {
  let bill: { id: string; totalCents: number }
  let taxBeforePayout = 0
  let cn: { id: string; invoiceNumber: string; tenantId: string; fbrTaxCents: number; provincialTaxCents: number; totalCents: number; owedBackCents: number }

  it('is issued (201) and books the sale return with the money owed back on till clearing', async () => {
    bill = await soldBill(A, cashierA)
    const order = await prisma.order.findUniqueOrThrow({ where: { id: bill.id } })
    const taxBefore = await net(A.tenantId, OUTPUT_TAX_ACCOUNTS, A.conceptId)
    expect(taxBefore).toBe(-order.taxCents) // the drawer close credited the sale's GST

    const r = await caller(app)(mgrA, 'POST', `/invoices/orders/${bill.id}/credit-note`, { reason: 'Guest returned the meal' })
    expect(r.statusCode, r.body).toBe(201)
    cn = r.json()
    expect(cn).toMatchObject({ tenantId: A.tenantId, type: 'credit_note', totalCents: -bill.totalCents, owedBackCents: bill.totalCents })

    const entry = await prisma.journalEntry.findFirstOrThrow({
      where: { tenantId: A.tenantId, reference: `order.credit_note:${cn.id}` },
      include: { lines: { include: { account: { select: { code: true } } } } },
    })
    const debits = entry.lines.filter((l) => l.type === 'debit').reduce((t, l) => t + Number(l.amountCents), 0)
    const credits = entry.lines.filter((l) => l.type === 'credit')
    expect(debits).toBe(bill.totalCents)
    // The money side is till clearing only (1110 before the company's cut-over) — never cash or card.
    expect(credits.map((l) => l.account.code)).toEqual(['1110'])
    expect(Number(credits[0]!.amountCents)).toBe(bill.totalCents)
    expect(credits[0]!.memo).toMatch(/^REFUND DUE/)
    expect(entry.lines.some((l) => ['1010', '1015', '1030'].includes(l.account.code))).toBe(false)
    // Output tax back to the account the sale credited, in full; every line on the brand.
    const taxLine = entry.lines.find((l) => (OUTPUT_TAX_ACCOUNTS as readonly string[]).includes(l.account.code))!
    expect(taxLine.type).toBe('debit')
    expect(Number(taxLine.amountCents)).toBe(order.taxCents)
    expect(entry.lines.every((l) => l.conceptId === A.conceptId)).toBe(true)
  })

  it('the tax-invoice register and 2030 / 2032 agree: the brand\'s output tax nets to zero', async () => {
    const inv = await prisma.taxInvoice.findFirstOrThrow({ where: { orderId: bill.id, type: 'invoice' } })
    expect(inv.fbrTaxCents + inv.provincialTaxCents + cn.fbrTaxCents + cn.provincialTaxCents).toBe(0)
    expect(await net(A.tenantId, OUTPUT_TAX_ACCOUNTS, A.conceptId)).toBe(0)
    // Revenue for the bill is reversed too: the brand's sales nets to zero (4xxx).
    const rev = await prisma.journalLine.groupBy({
      by: ['type'], _sum: { amountCents: true },
      where: { conceptId: A.conceptId, account: { tenantId: A.tenantId, type: 'revenue' }, journalEntry: { tenantId: A.tenantId } },
    })
    const revNet = sumCents(rev.find((x) => x.type === 'debit')?._sum.amountCents) - sumCents(rev.find((x) => x.type === 'credit')?._sum.amountCents)
    expect(revNet).toBe(0)
  })

  it('files ONE fiscal refund document for the sale, and the order is refunded', async () => {
    const refunds = await prisma.fiscalDocument.findMany({ where: { orderId: bill.id, kind: 'refund' } })
    expect(refunds).toHaveLength(1)
    expect(refunds[0]!.idempotencyKey).toBe(`void:${bill.id}`)
    const sale = await prisma.fiscalDocument.findFirstOrThrow({ where: { orderId: bill.id, kind: 'sale' } })
    expect(refunds[0]!.amountCents).toBe(sale.amountCents)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: bill.id } })).status).toBe('refunded')
  })

  it('a second credit note is 409 and books nothing more', async () => {
    const again = await caller(app)(mgrA, 'POST', `/invoices/orders/${bill.id}/credit-note`, { reason: 'again' })
    expect(again.statusCode, again.body).toBe(409)
    expect(again.json().error.code).toBe('CREDIT_NOTE_EXISTS')
    expect(await prisma.taxInvoice.count({ where: { orderId: bill.id, type: 'credit_note' } })).toBe(1)
    expect(await prisma.journalEntry.count({ where: { tenantId: A.tenantId, reference: { startsWith: 'order.credit_note:' } } })).toBe(1)
    expect(await prisma.fiscalDocument.count({ where: { orderId: bill.id, kind: 'refund' } })).toBe(1)
  })

  it('company B gets 404 on A\'s bill; B\'s own credit note binds to B', async () => {
    const other = await soldBill(A, cashierA)
    const r = await caller(app)(mgrB, 'POST', `/invoices/orders/${other.id}/credit-note`, { reason: 'cross-company try' })
    expect(r.statusCode, r.body).toBe(404)
    expect(await prisma.taxInvoice.count({ where: { orderId: other.id, type: 'credit_note' } })).toBe(0)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: other.id } })).status).toBe('completed')

    const bBill = await soldBill(B, cashierB)
    const own = await caller(app)(mgrB, 'POST', `/invoices/orders/${bBill.id}/credit-note`, { reason: 'Guest returned it' })
    expect(own.statusCode, own.body).toBe(201)
    expect(own.json().tenantId).toBe(B.tenantId)
    const e = await prisma.journalEntry.findFirstOrThrow({ where: { reference: `order.credit_note:${own.json().id}` } })
    expect(e.tenantId).toBe(B.tenantId)
    expect(await net(B.tenantId, ['1110'])).toBe(-bBill.totalCents)
  })

  it('the till pays it out: Dr till clearing / Cr the drawer, never revenue or tax, no fiscal document; it clears what is owed back', async () => {
    expect(-(await net(A.tenantId, ['1110']))).toBe(bill.totalCents)
    taxBeforePayout = await net(A.tenantId, OUTPUT_TAX_ACCOUNTS, A.conceptId) // (A's other, live bill still carries its GST)
    const drawer = await openDrawer(A, mgrA)
    const refund = (body: Record<string, unknown>, who: Who = mgrA) => caller(app)(who, 'POST', `/pos/orders/${bill.id}/refund`, { reason: 'Credit note paid out', shiftId: drawer, ...body })

    // More than is owed, or a tender the bill was not paid with: refused, nothing written.
    const over = await refund({ amountCents: bill.totalCents + 1, method: 'cash' })
    expect(over.statusCode, over.body).toBe(422)
    expect(over.json().error.code).toBe('REFUND_EXCEEDS_DUE')
    const card = await refund({ amountCents: 1_000, method: 'card' })
    expect(card.statusCode, card.body).toBe(422)
    expect(card.json().error.code).toBe('REFUND_METHOD_NOT_TENDERED')
    // Company B never reaches A's bill.
    const bDrawer = await openDrawer(B, mgrB)
    const cross = await caller(app)(mgrB, 'POST', `/pos/orders/${bill.id}/refund`, { amountCents: 1_000, reason: 'cross-company try', method: 'cash', shiftId: bDrawer })
    expect(cross.statusCode, cross.body).toBe(404)
    expect(await prisma.payment.count({ where: { orderId: bill.id, status: 'refunded' } })).toBe(0)

    // Two pay-outs: part, then the rest.
    const first = await refund({ amountCents: 50_000, method: 'cash' })
    expect(first.statusCode, first.body).toBe(200)
    expect(first.json()).toMatchObject({ owedBackLeftCents: bill.totalCents - 50_000, fiscalRefund: null })
    const rest = await refund({ amountCents: bill.totalCents - 50_000, method: 'cash' })
    expect(rest.statusCode, rest.body).toBe(200)
    expect(rest.json().owedBackLeftCents).toBe(0)
    const more = await refund({ amountCents: 100, method: 'cash' })
    expect(more.statusCode, more.body).toBe(422)
    expect(more.json().error.code).toBe('NOTHING_TO_REFUND')

    const rows = await prisma.payment.findMany({ where: { orderId: bill.id, status: 'refunded' } })
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect((row.gatewayMeta as { refund: { creditNoteId: string } }).refund.creditNoteId).toBe(cn.id)
      const e = await prisma.journalEntry.findFirstOrThrow({
        where: { tenantId: A.tenantId, reference: `order.refund:${row.id}` },
        include: { lines: { include: { account: { select: { code: true } } } } },
      })
      expect(e.lines.map((l) => `${l.type}:${l.account.code}`).sort()).toEqual(['credit:1015', 'debit:1110'])
      expect(e.lines.every((l) => (l.memo ?? '').startsWith('Refund due handed back'))).toBe(true)
    }
    expect(await net(A.tenantId, ['1110'])).toBe(0)
    expect(await net(A.tenantId, OUTPUT_TAX_ACCOUNTS, A.conceptId)).toBe(taxBeforePayout)
    // The credit note filed the return; a pay-out files nothing.
    expect(await prisma.fiscalDocument.count({ where: { orderId: bill.id, kind: 'refund' } })).toBe(1)
    // Both sides are till clearing to the cut-over / sweep / tie-out.
    const { isTillClearingLine } = await import('../src/modules/accounting/tillClearing.js')
    expect(isTillClearingLine(`order.credit_note:${cn.id}`, `REFUND DUE — credit note`)).toBe(true)
    expect(isTillClearingLine(`order.refund:${rows[0]!.id}`, 'Refund due handed back — credit note on order x')).toBe(true)
  })

  it('a backfill repost of a pay-out books only the hand-back — the sale is never reversed twice', async () => {
    const row = await prisma.payment.findFirstOrThrow({ where: { orderId: bill.id, status: 'refunded' }, orderBy: { createdAt: 'asc' } })
    const ref = `order.refund:${row.id}`
    // Idempotent: posting it again finds its entry.
    const again = await postRefundPayment(row.id)
    const existing = await prisma.journalEntry.findFirstOrThrow({ where: { tenantId: A.tenantId, reference: ref } })
    expect(again.entryId ?? existing.id).toBe(existing.id)
    expect(await prisma.journalEntry.count({ where: { tenantId: A.tenantId, reference: ref } })).toBe(1)
    // An entry lost (as a refused posting would leave it): the re-poster books the hand-back only.
    await prisma.journalLine.deleteMany({ where: { journalEntryId: existing.id } })
    await prisma.journalEntry.delete({ where: { id: existing.id } })
    const reposted = await postRefundPayment(row.id)
    expect(reposted.entryId).toBeTruthy()
    const e = await prisma.journalEntry.findFirstOrThrow({ where: { id: reposted.entryId! }, include: { lines: { include: { account: { select: { code: true } } } } } })
    expect(e.lines.map((l) => `${l.type}:${l.account.code}`).sort()).toEqual(['credit:1015', 'debit:1110'])
    expect(await net(A.tenantId, OUTPUT_TAX_ACCOUNTS, A.conceptId)).toBe(taxBeforePayout)
    expect(await net(A.tenantId, ['1110'])).toBe(0)
  })
})
