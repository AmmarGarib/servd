// Re-sim stream F — fiscal payload totals (ONL-R2-02) and the held backlog of a
// company that switched "Fiscal reporting required" off (BOOKS-R2-02 /
// FOH-R2-02). Two companies; stored figures only.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { randomBytes } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import {
  prisma, mkCompany, mkUser, mkOrder, buildApp, caller, setConnector, resetConnectorCache, TEST_SECRET_KEY,
  type Company, type Who, type OrderSpec,
} from './connectorsFixtures.js'
import {
  buildFiscalSaleTx, buildRefundPayload, totalsCheck, totalsOf, toFbrInvoiceFields, toSrbInvoiceFields, payloadHash,
} from '../src/connectors/fiscal/payload.js'
import {
  enqueueFiscalSaleTx, enqueueFiscalRefundTx, releaseHeld, retryDocument, sendOnce, setFiscalKicker, newDocumentId, TOTALS_MISMATCH,
} from '../src/connectors/fiscal/outbox.js'
import { connectorHealthChecks } from '../src/connectors/health.js'
import { DEFAULT_FISCAL_SETTINGS } from '../src/connectors/config.js'
import type { FiscalPayload } from '../src/connectors/types.js'
import { testDriverCalls, resetTestDriverCalls, testFiscalDriver } from '../src/connectors/drivers/test.js'

let app: FastifyInstance
let call: ReturnType<typeof caller>
let A: Company, B: Company
const u: Record<string, Who> = {}
let prevKey: string | undefined

const KHEER = (c: Company, quantity = 2) => ({ menuItemId: c.items.kheer, name: 'Kheer', quantity, unitPriceCents: 55_000 })
const NIHARI_NALLI = (c: Company) => ({ menuItemId: c.items.nihari, name: 'Beef Nihari', quantity: 1, unitPriceCents: 145_000, modifiers: [{ name: 'Nalli', priceDeltaCents: 35_000 }] })

async function order(co: Company, spec: OrderSpec, extra: { source?: 'servd' | 'pos'; fulfilmentType?: 'delivery' | 'takeout'; walletAmountCents?: number; giftCardCents?: number } = {}): Promise<string> {
  const id = await mkOrder(co, spec)
  await prisma.order.update({
    where: { id },
    data: {
      ...(extra.source && { source: extra.source }),
      ...(extra.fulfilmentType && { fulfilmentType: extra.fulfilmentType }),
      ...(extra.walletAmountCents !== undefined && { walletAmountCents: extra.walletAmountCents }),
    },
  })
  if (extra.giftCardCents) {
    const card = await prisma.giftCard.create({
      data: { tenantId: co.tenantId, code: `GS-${randomBytes(4).toString('hex')}`, issuedAmountCents: extra.giftCardCents, balanceCents: 0 },
    })
    await prisma.giftCardRedemption.create({ data: { giftCardId: card.id, orderId: id, amountCents: extra.giftCardCents, balanceAfter: 0 } })
  }
  return id
}

const build = (orderId: string, docId = `doc_${randomBytes(4).toString('hex')}`) =>
  prisma.$transaction((tx) => buildFiscalSaleTx(tx, orderId, docId, DEFAULT_FISCAL_SETTINGS))
const enqueueSale = (co: Company, orderId: string) => prisma.$transaction((tx) => enqueueFiscalSaleTx(tx, { orderId, tenantId: co.tenantId }))

/** lines + tax + service + tip + delivery, the contract's sum. */
function sumOf(p: FiscalPayload): number {
  const t = totalsOf(p)
  return p.lines.reduce((s, l) => s + l.taxableCents, 0) + t.taxCents + t.serviceChargeCents + t.tipCents + (t.deliveryChargeCents ?? 0)
}

beforeAll(async () => {
  prevKey = process.env['SERVD_SECRET_KEY']
  process.env['SERVD_SECRET_KEY'] = TEST_SECRET_KEY
  setFiscalKicker(async () => {})
  A = await mkCompany('resim-f-a', { srbPosId: 4101, fbrPosId: 4102 })
  B = await mkCompany('resim-f-b', { srbPosId: 4201 })
  u['adminA'] = await mkUser('rfAdminA', 'admin', A.tenantId)
  u['adminB'] = await mkUser('rfAdminB', 'admin', B.tenantId)
  app = await buildApp()
  call = caller(app)
}, 60_000)

afterAll(async () => {
  if (prevKey === undefined) delete process.env['SERVD_SECRET_KEY']
  else process.env['SERVD_SECRET_KEY'] = prevKey
  setFiscalKicker(null)
  resetConnectorCache()
  await app.close()
})

describe('ONL-R2-02 — the sale payload is the bill, from stored components', () => {
  it('(a) COD delivery: the fee is an explicit delivery charge, the pending cash is the tender, everything adds up', async () => {
    // 5 × Kheer 275,000 + GST 15 % 41,250 + delivery 15,000 + tip 10,000 = 341,250
    const id = await order(A, {
      items: [KHEER(A, 5)], taxCents: 41_250, taxRatePct: 15, tipCents: 10_000, totalCents: 341_250,
      payments: [{ method: 'cash', amountCents: 341_250, status: 'pending' }],
    }, { source: 'servd', fulfilmentType: 'delivery' })
    const b = await build(id)
    const t = totalsOf(b.payload)
    expect(t).toMatchObject({ saleValueCents: 275_000, taxCents: 41_250, tipCents: 10_000, deliveryChargeCents: 15_000, totalCents: 341_250 })
    expect(sumOf(b.payload)).toBe(t.totalCents)
    expect(b.check.ok).toBe(true)
    expect(b.totalCents).toBe(341_250)
    expect(b.payload.payment).toEqual({ mode: 'cash', tenders: [{ method: 'cash', amountCents: 341_250 }] })
    const fbr = toFbrInvoiceFields(b.payload)
    expect(fbr.TotalSaleValue).toBe(3000)
    expect(fbr.PaymentMode).toBe(2)
    expect(toSrbInvoiceFields(b.payload).modeOfPay).toBe('Cash')

    // The full refund carries the same components: never more sale value than the sale.
    const r = buildRefundPayload(b.payload, { documentId: 'r1', refundAmountCents: 341_250, issuedAt: new Date(), original: null })
    const rt = totalsOf(r)
    expect(rt).toMatchObject({ saleValueCents: 275_000, taxCents: 41_250, tipCents: 10_000, deliveryChargeCents: 15_000, totalCents: 341_250 })
    expect(totalsCheck(r).ok).toBe(true)
    expect(toSrbInvoiceFields(r).taxAmount).toBe(toSrbInvoiceFields(b.payload).taxAmount)
  })

  it('(b) PKR 1,000 by gift card: the bill is unchanged, the card is a tender, a full refund returns all of the tax', async () => {
    // 290,000 + 43,500 = 333,500; the card paid 100,000, cash 233,500.
    const id = await order(A, {
      items: [NIHARI_NALLI(A), KHEER(A)], taxCents: 43_500, taxRatePct: 15, totalCents: 233_500,
      payments: [{ method: 'cash', amountCents: 233_500 }],
    }, { giftCardCents: 100_000 })
    const b = await build(id)
    expect(totalsOf(b.payload)).toMatchObject({ saleValueCents: 290_000, taxCents: 43_500, deliveryChargeCents: 0, totalCents: 333_500 })
    expect(b.check.ok).toBe(true)
    expect(b.payload.payment).toEqual({ mode: 'cash', tenders: [{ method: 'cash', amountCents: 233_500 }, { method: 'gift_card', amountCents: 100_000 }] })
    expect(toFbrInvoiceFields(b.payload)).toMatchObject({ TotalSaleValue: 2900, TotalBillAmount: 3335, TotalTaxCharged: 435 })
    // The cash tender refunded: its share of the tax (the ledger's refundShareOf base), not all of it.
    const cashBack = buildRefundPayload(b.payload, { documentId: 'r2', refundAmountCents: 233_500, issuedAt: new Date(), original: null })
    expect(totalsOf(cashBack).taxCents).toBe(Math.round((43_500 * 233_500) / 333_500))
    expect(totalsCheck(cashBack).ok).toBe(true)
    const full = buildRefundPayload(b.payload, { documentId: 'r3', refundAmountCents: 333_500, issuedAt: new Date(), original: null })
    expect(totalsOf(full)).toMatchObject({ saleValueCents: 290_000, taxCents: 43_500, totalCents: 333_500 })
  })

  it('(c) paid entirely by wallet: a positive bill at the card rate, wallet tender, FBR sale value never negative; never zero-value-skipped', async () => {
    // 55,000 + 8 % 4,400 = 59,400, all from the wallet (Order.totalCents 0).
    const id = await order(A, { items: [KHEER(A, 1)], taxCents: 4_400, taxRatePct: 8, totalCents: 0, payments: [] }, { source: 'servd', walletAmountCents: 59_400 })
    const b = await build(id)
    expect(totalsOf(b.payload)).toMatchObject({ saleValueCents: 55_000, taxCents: 4_400, totalCents: 59_400 })
    expect(b.payload.payment).toEqual({ mode: 'card', tenders: [{ method: 'wallet', amountCents: 59_400 }] })
    expect(toFbrInvoiceFields(b.payload).TotalSaleValue).toBe(550)
    await setConnector(A.tenantId, 'fiscal', { settings: { fileZeroValue: false } })
    try {
      const doc = await enqueueSale(A, id)
      expect(doc?.status).not.toBe('skipped')
      expect((await prisma.fiscalDocument.findUniqueOrThrow({ where: { id: doc!.id } })).amountCents).toBe(59_400)
    } finally {
      await setConnector(A.tenantId, 'fiscal', { settings: { fileZeroValue: true } })
    }
  })

  it('(d) covered in full by a gift card: bill = the food + tax, gift-card tender, filed not skipped', async () => {
    const id = await order(A, { items: [KHEER(A, 1)], taxCents: 8_250, taxRatePct: 15, totalCents: 0, payments: [] }, { giftCardCents: 63_250 })
    const b = await build(id)
    expect(totalsOf(b.payload)).toMatchObject({ taxCents: 8_250, totalCents: 63_250 })
    expect(b.payload.payment).toEqual({ mode: 'cash', tenders: [{ method: 'gift_card', amountCents: 63_250 }] })
    expect(toFbrInvoiceFields(b.payload).TotalSaleValue).toBe(550)
    await setConnector(A.tenantId, 'fiscal', { settings: { fileZeroValue: false } })
    try {
      expect((await enqueueSale(A, id))?.status).not.toBe('skipped')
    } finally {
      await setConnector(A.tenantId, 'fiscal', { settings: { fileZeroValue: true } })
    }
  })

  it('a top-up wallet plus card, a loyalty discount and service charge still add up', async () => {
    // 110,000 − 10,000 loyalty discount = 100,000 taxable; tax on the
    // pre-discount lines at 8 % 8,800 (stored); service 5,000;
    // bill 113,800 = wallet 13,800 + card 100,000.
    const id = await order(A, {
      items: [KHEER(A)], discountCents: 10_000, taxCents: 8_800, taxRatePct: 8, serviceChargeCents: 5_000, totalCents: 100_000,
      payments: [{ method: 'card', amountCents: 100_000 }],
    }, { source: 'servd', walletAmountCents: 13_800 })
    const b = await build(id)
    expect(b.check.ok, b.check.problems.join('; ')).toBe(true)
    expect(totalsOf(b.payload)).toMatchObject({ discountCents: 10_000, serviceChargeCents: 5_000, totalCents: 113_800, deliveryChargeCents: 0 })
    expect(b.payload.payment).toEqual({ mode: 'card', tenders: [{ method: 'card', amountCents: 100_000 }, { method: 'wallet', amountCents: 13_800 }] })
  })

  it('a refund with a known tip share and a tiny refund still sum exactly', () => {
    const sale = {
      version: 1, documentId: 's', kind: 'sale', orderId: 'o', orderRef: 'O', source: 'servd', issuedAt: new Date().toISOString(), currency: 'PKR',
      registrations: [], seller: { legalName: 'x' }, buyer: null,
      lines: [{ lineId: 'l', itemCode: 'c', description: 'd', quantity: 1, unitPriceCents: 100_000, grossCents: 100_000, discountCents: 0, taxableCents: 100_000, taxRatePct: 15, taxCents: 15_000 }],
      totals: { saleValueCents: 100_000, discountCents: 0, taxableCents: 100_000, taxCents: 15_000, taxRatePct: 15, serviceChargeCents: 3_000, tipCents: 7_000, deliveryChargeCents: 20_000, totalCents: 145_000 },
      payment: { mode: 'cash', tenders: [{ method: 'cash', amountCents: 145_000 }] },
    } as FiscalPayload
    expect(totalsCheck(sale).ok).toBe(true)
    for (const amount of [1, 2, 3, 7, 999, 50_000, 145_000]) {
      for (const tip of [undefined, 0]) {
        const r = buildRefundPayload(sale, { documentId: 'r', refundAmountCents: amount, issuedAt: new Date(), original: null, ...(tip !== undefined && { tipShareCents: tip }) })
        expect(totalsCheck(r).ok, `${amount}/${tip}: ${totalsCheck(r).problems.join('; ')}`).toBe(true)
        expect(r.totals.totalCents).toBe(amount)
      }
    }
  })
})

describe('ONL-R2-02 — a document that does not add up is never filed', () => {
  it('a takeout whose stored total disagrees with its parts → failed / totals_mismatch + fiscal_failed flag; a fixed order retries clean', async () => {
    await setConnector(A.tenantId, 'fiscal', { driver: 'test', enabled: true })
    const id = await order(A, { items: [KHEER(A)], taxCents: 16_500, taxRatePct: 15, totalCents: 120_000, payments: [{ method: 'cash', amountCents: 120_000 }] })
    const doc = await enqueueSale(A, id)
    expect(doc).toMatchObject({ status: 'failed', statusReason: TOTALS_MISMATCH })
    const flag = await prisma.exceptionFlag.findFirstOrThrow({ where: { tenantId: A.tenantId, entityId: doc!.id } })
    expect(flag.kind).toBe('fiscal_failed')
    expect(flag.description).toMatch(/not the bill 120000/)
    // Nothing reached the fiscal POS.
    expect(await sendOnce(doc!.id, 'worker', 2000)).toBe('busy')
    expect(await prisma.fiscalAttempt.count({ where: { documentId: doc!.id, op: 'submit' } })).toBe(0)
    // Retry while still wrong → 409; fixed → rebuilt and queued.
    await expect(retryDocument(doc!.id, { tenantId: A.tenantId })).rejects.toMatchObject({ code: 'TOTALS_MISMATCH' })
    await prisma.order.update({ where: { id }, data: { totalCents: 126_500 } })
    await prisma.payment.updateMany({ where: { orderId: id }, data: { amountCents: 126_500 } })
    const after = await retryDocument(doc!.id, { tenantId: A.tenantId })
    expect(after.status).toBe('pending')
    expect(after.amountCents).toBe(126_500)
    expect(totalsCheck(after.payload as unknown as FiscalPayload).ok).toBe(true)
    // Company B cannot touch A's document.
    await expect(retryDocument(doc!.id, { tenantId: B.tenantId })).rejects.toMatchObject({ statusCode: 404 })
    await setConnector(A.tenantId, 'fiscal', { driver: 'none', enabled: false })
  })

  it('a delivery whose bill is LESS than its parts is a mismatch, not a negative fee', async () => {
    const id = await order(A, {
      items: [KHEER(A)], taxCents: 16_500, taxRatePct: 15, totalCents: 100_000, payments: [{ method: 'cash', amountCents: 100_000, status: 'pending' }],
    }, { source: 'servd', fulfilmentType: 'delivery' })
    const b = await build(id)
    expect(totalsOf(b.payload).deliveryChargeCents).toBe(0)
    expect(b.check.ok).toBe(false)
  })

  it('a pending document frozen BEFORE the fix (wallet sale, total 0) is stopped at send: failed, never submitted', async () => {
    await setConnector(A.tenantId, 'fiscal', { driver: 'test', enabled: true })
    const id = await order(A, { items: [KHEER(A, 1)], taxCents: 4_400, taxRatePct: 8, totalCents: 0, payments: [] }, { source: 'servd', walletAmountCents: 59_400 })
    const fresh = await build(id)
    const old: FiscalPayload = { ...fresh.payload, totals: { ...fresh.payload.totals, totalCents: 0 }, payment: { mode: 'cash', tenders: [] } }
    delete (old.totals as { deliveryChargeCents?: number }).deliveryChargeCents
    const docId = newDocumentId()
    await prisma.fiscalDocument.create({
      data: {
        id: docId, tenantId: A.tenantId, kind: 'sale', orderId: id, conceptId: A.conceptId, locationId: A.locationId,
        idempotencyKey: `sale:${id}`, status: 'pending', payload: JSON.parse(JSON.stringify({ ...old, documentId: docId })) as Prisma.InputJsonValue,
        payloadHash: payloadHash(old), amountCents: 0, nextAttemptAt: new Date(Date.now() - 1000),
      },
    })
    expect(await sendOnce(docId, 'worker', 2000)).toBe('failed')
    const row = await prisma.fiscalDocument.findUniqueOrThrow({ where: { id: docId } })
    expect(row).toMatchObject({ status: 'failed', statusReason: TOTALS_MISMATCH, lastErrorCode: 'TOTALS_MISMATCH', attempts: 0, fiscalNumber: null })
    expect(await prisma.fiscalAttempt.count({ where: { documentId: docId, op: 'submit' } })).toBe(0)
    expect(await prisma.exceptionFlag.count({ where: { tenantId: A.tenantId, entityId: docId, kind: 'fiscal_failed' } })).toBe(1)
    // Never sent → Retry rebuilds it from the order with the bill, and it files.
    const retried = await retryDocument(docId, { tenantId: A.tenantId })
    expect(retried).toMatchObject({ status: 'pending', amountCents: 59_400 })
    expect(await sendOnce(docId, 'worker', 2000)).toBe('filed')
    await setConnector(A.tenantId, 'fiscal', { driver: 'none', enabled: false })
  })

  it('a sale HELD before the fix is rebuilt on release: bill, fee and tenders', async () => {
    await setConnector(B.tenantId, 'fiscal', { driver: 'none', enabled: false })
    const id = await order(B, {
      items: [KHEER(B, 5)], taxCents: 41_250, taxRatePct: 15, tipCents: 10_000, totalCents: 241_250,
      payments: [{ method: 'cash', amountCents: 241_250, status: 'pending' }],
    }, { source: 'servd', fulfilmentType: 'delivery', giftCardCents: 100_000 })
    const fresh = await build(id)
    const old: FiscalPayload = { ...fresh.payload, totals: { ...fresh.payload.totals, totalCents: 241_250 }, payment: { mode: 'card', tenders: [] } }
    delete (old.totals as { deliveryChargeCents?: number }).deliveryChargeCents
    const docId = newDocumentId()
    await prisma.fiscalDocument.create({
      data: {
        id: docId, tenantId: B.tenantId, kind: 'sale', orderId: id, conceptId: B.conceptId, locationId: B.locationId,
        idempotencyKey: `sale:${id}`, status: 'held', statusReason: 'no_connector', payload: JSON.parse(JSON.stringify({ ...old, documentId: docId })) as Prisma.InputJsonValue,
        payloadHash: payloadHash(old), amountCents: 241_250,
      },
    })
    await setConnector(B.tenantId, 'fiscal', { driver: 'test', enabled: true })
    const r = await releaseHeld(B.tenantId)
    expect(r.released).toBeGreaterThanOrEqual(1)
    const row = await prisma.fiscalDocument.findUniqueOrThrow({ where: { id: docId } })
    expect(row.status).toBe('pending')
    expect(row.amountCents).toBe(341_250)
    const p = row.payload as unknown as FiscalPayload
    expect(totalsOf(p)).toMatchObject({ totalCents: 341_250, deliveryChargeCents: 15_000, tipCents: 10_000 })
    expect(p.payment.tenders).toEqual([{ method: 'cash', amountCents: 241_250 }, { method: 'gift_card', amountCents: 100_000 }])
    await setConnector(B.tenantId, 'fiscal', { driver: 'none', enabled: false })
  })

  it('a refund document uses the same rules: fee share, sums to the refund, against the bill', async () => {
    const id = await order(A, {
      items: [KHEER(A, 5)], taxCents: 41_250, taxRatePct: 15, tipCents: 10_000, totalCents: 341_250,
      payments: [{ method: 'cash', amountCents: 341_250 }],
    }, { source: 'servd', fulfilmentType: 'delivery' })
    const sale = await enqueueSale(A, id)
    expect(sale?.status).toBe('held')
    const ref = await prisma.$transaction((tx) => enqueueFiscalRefundTx(tx, { orderId: id, tenantId: A.tenantId, refundPaymentId: null, amountCents: 341_250, reason: 'Order refunded in full' }))
    expect(ref?.status).toBe('waiting')
    const row = await prisma.fiscalDocument.findUniqueOrThrow({ where: { id: ref!.id } })
    const p = row.payload as unknown as FiscalPayload
    expect(totalsCheck(p).ok).toBe(true)
    expect(totalsOf(p)).toMatchObject({ saleValueCents: 275_000, deliveryChargeCents: 15_000, totalCents: 341_250 })
  })
})

describe('BOOKS-R2-02 / FOH-R2-02 — reporting switched OFF with a held backlog', () => {
  it('held docs stay held and listed with a note; /health stops counting them; release is refused; ON again behaves as before', async () => {
    // Fresh state for the two companies' held backlog.
    await prisma.fiscalAttempt.deleteMany({ where: { tenantId: { in: [A.tenantId, B.tenantId] } } })
    await prisma.fiscalDocument.deleteMany({ where: { tenantId: { in: [A.tenantId, B.tenantId] }, kind: 'refund' } })
    await prisma.fiscalDocument.deleteMany({ where: { tenantId: { in: [A.tenantId, B.tenantId] } } })
    await setConnector(A.tenantId, 'fiscal', { driver: 'none', enabled: false })
    await setConnector(B.tenantId, 'fiscal', { driver: 'none', enabled: false })
    const kheerSale = (co: Company) => order(co, { items: [KHEER(co)], taxCents: 16_500, taxRatePct: 15, totalCents: 126_500, payments: [{ method: 'cash', amountCents: 126_500 }] })
    const bDocs = [await enqueueSale(B, await kheerSale(B)), await enqueueSale(B, await kheerSale(B))]
    const aDoc = await enqueueSale(A, await kheerSale(A))
    for (const d of [...bDocs, aDoc]) expect(d?.status).toBe('held')

    let h = await connectorHealthChecks()
    expect(h.details['fiscalConnector']).toMatch(/3 sales held in total/)

    const off = await call(u['adminB']!, 'PUT', '/connectors/fiscal/reporting-required', { required: false, reason: 'commissary is non-commercial for now' })
    expect(off.statusCode, off.body).toBe(200)
    expect(off.json()).toMatchObject({ fiscalReportingRequired: false, heldCount: 2 })
    expect(off.json().heldNote).toMatch(/2 sales were held before/)
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'fiscal.reporting_required', tenantId: B.tenantId }, orderBy: { createdAt: 'desc' } })
    expect(audit.metadata).toMatchObject({ heldCount: 2 })

    // Nothing was skipped or changed.
    for (const d of bDocs) expect((await prisma.fiscalDocument.findUniqueOrThrow({ where: { id: d!.id } })).status).toBe('held')
    // /health counts only A's held sale now.
    h = await connectorHealthChecks()
    expect(h.details['fiscalConnector']).toMatch(/1 sales held in total/)
    // The connector page of B still lists them, with the note; A's has no note.
    const gb = (await call(u['adminB']!, 'GET', '/connectors')).json()
    expect(gb.counts.held).toBe(2)
    expect(gb.heldNote).toMatch(/no sale is ever skipped/)
    const listB = (await call(u['adminB']!, 'GET', '/connectors/fiscal/documents?status=held')).json()
    expect(listB.items.map((x: { id: string }) => x.id).sort()).toEqual(bDocs.map((d) => d!.id).sort())
    expect((await call(u['adminA']!, 'GET', '/connectors')).json().heldNote).toBeNull()
    // A's own switch is untouched.
    expect((await call(u['adminA']!, 'GET', '/connectors')).json().fiscalReportingRequired).toBe(true)

    // Even live, a company with reporting off files nothing: release refused.
    await setConnector(B.tenantId, 'fiscal', { driver: 'test', enabled: true })
    const rel = await call(u['adminB']!, 'POST', '/connectors/fiscal/documents/release', {})
    expect(rel.statusCode).toBe(409)
    expect(rel.json().error.code).toBe('REPORTING_OFF')
    // B's live TEST connector still warns about the driver, never about the held backlog.
    h = await connectorHealthChecks()
    expect(h.details['fiscalConnector']).not.toMatch(/\b2 held\b/)

    // Back ON: counted again and released as usual.
    const on = await call(u['adminB']!, 'PUT', '/connectors/fiscal/reporting-required', { required: true, reason: 'commissary starts selling' })
    expect(on.statusCode).toBe(200)
    expect(on.json().heldNote).toBeNull()
    h = await connectorHealthChecks()
    expect(h.details['fiscalConnector']).toMatch(/2 held/)
    const rel2 = await call(u['adminB']!, 'POST', '/connectors/fiscal/documents/release', {})
    expect(rel2.statusCode, rel2.body).toBe(200)
    expect(rel2.json()).toMatchObject({ released: 2, stillHeld: 0 })
    // Company A's held sale was not touched by B's release.
    expect((await prisma.fiscalDocument.findUniqueOrThrow({ where: { id: aDoc!.id } })).status).toBe('held')
    await setConnector(B.tenantId, 'fiscal', { driver: 'none', enabled: false })
  })
})

// ─── Review fixes ─────────────────────────────────────────────────────────────

describe('F-RV-1 — a discount larger than the food is a bill discount, not a mismatch', () => {
  it('R1: loyalty above the food value (card 8 %) — lines carry the tax, the excess is a bill discount; it files', async () => {
    // Kheer 55,000 + 8 % 4,400 = 59,400; points worth 57,000; 2,400 by card.
    const id = await order(A, {
      items: [KHEER(A, 1)], discountCents: 57_000, taxCents: 4_400, taxRatePct: 8, totalCents: 2_400,
      payments: [{ method: 'card', amountCents: 2_400 }],
    }, { source: 'servd' })
    const b = await build(id)
    expect(b.check.ok, b.check.problems.join('; ')).toBe(true)
    expect(totalsOf(b.payload)).toMatchObject({ saleValueCents: 55_000, discountCents: 55_000, taxableCents: 0, taxCents: 4_400, billDiscountCents: 2_000, totalCents: 2_400 })
    expect(b.payload.lines.map((l) => [l.taxableCents, l.taxCents])).toEqual([[0, 4_400]])
    expect(toSrbInvoiceFields(b.payload)).toMatchObject({ saleValue: 550, taxAmount: 44, discountAmount: 570, netAmount: 24 })
    expect(toFbrInvoiceFields(b.payload)).toMatchObject({ TotalBillAmount: 24, TotalSaleValue: 0, TotalTaxCharged: 44, Discount: 570 })

    await setConnector(A.tenantId, 'fiscal', { driver: 'test', enabled: true, settings: { test: { scenario: 'ok' } } })
    try {
      const doc = await enqueueSale(A, id)
      expect(doc?.status).toBe('pending')
      expect(await prisma.exceptionFlag.count({ where: { tenantId: A.tenantId, entityId: doc!.id } })).toBe(0)
      expect(await sendOnce(doc!.id, 'worker', 2000)).toBe('filed')

      // The full refund mirrors the sale (the ledger's refundShareOf: all of the tax back).
      const full = buildRefundPayload(b.payload, { documentId: 'rv1', refundAmountCents: 2_400, issuedAt: new Date(), original: null })
      expect(totalsCheck(full).ok, totalsCheck(full).problems.join('; ')).toBe(true)
      expect(totalsOf(full)).toMatchObject({ taxableCents: 0, taxCents: 4_400, billDiscountCents: 2_000, totalCents: 2_400 })
      expect(full.lines.map((l) => l.taxCents)).toEqual([4_400])
      // Any refund amount, pro rata or as a voided line's (no tip), adds up exactly.
      for (const amount of [1, 2, 3, 7, 999, 1_200, 2_399, 2_400]) {
        for (const tip of [undefined, 0]) {
          const r = buildRefundPayload(b.payload, { documentId: 'r', refundAmountCents: amount, issuedAt: new Date(), original: null, ...(tip !== undefined && { tipShareCents: tip }) })
          expect(totalsCheck(r).ok, `${amount}/${tip}: ${totalsCheck(r).problems.join('; ')}`).toBe(true)
          expect(r.totals.totalCents).toBe(amount)
        }
      }
      // A refund queued through the outbox against the filed sale is due, not failed.
      const ref = await prisma.$transaction((tx) => enqueueFiscalRefundTx(tx, { orderId: id, tenantId: A.tenantId, refundPaymentId: null, amountCents: 2_400, reason: 'refunded' }))
      expect(ref?.status).toBe('pending')
    } finally {
      await setConnector(A.tenantId, 'fiscal', { driver: 'none', enabled: false })
    }
  })

  it('R2: a 100 % discount at the till (cash 15 %) — the customer pays only the GST; it adds up', async () => {
    const id = await order(A, {
      items: [KHEER(A, 2)], discountCents: 110_000, taxCents: 16_500, taxRatePct: 15, totalCents: 16_500,
      payments: [{ method: 'cash', amountCents: 16_500 }],
    })
    const b = await build(id)
    expect(b.check.ok, b.check.problems.join('; ')).toBe(true)
    expect(totalsOf(b.payload)).toMatchObject({ saleValueCents: 110_000, discountCents: 110_000, taxableCents: 0, taxCents: 16_500, totalCents: 16_500 })
    expect(totalsOf(b.payload).billDiscountCents).toBeUndefined()
    expect(b.payload.lines.reduce((s, l) => s + l.taxCents, 0)).toBe(16_500)
    const doc = await enqueueSale(A, id)
    expect(doc?.statusReason).not.toBe(TOTALS_MISMATCH)
    for (const amount of [1, 5_000, 16_500]) {
      const r = buildRefundPayload(b.payload, { documentId: 'r', refundAmountCents: amount, issuedAt: new Date(), original: null })
      expect(totalsCheck(r).ok, `${amount}: ${totalsCheck(r).problems.join('; ')}`).toBe(true)
    }
  })

  it('a bill fully covered by points is a zero-value sale again (skipped), not a mismatch', async () => {
    const id = await order(A, { items: [KHEER(A, 1)], discountCents: 59_400, taxCents: 4_400, taxRatePct: 8, totalCents: 0, payments: [] }, { source: 'servd' })
    const b = await build(id)
    expect(b.check.ok, b.check.problems.join('; ')).toBe(true)
    expect(totalsOf(b.payload)).toMatchObject({ taxCents: 4_400, billDiscountCents: 4_400, totalCents: 0 })
    await setConnector(A.tenantId, 'fiscal', { settings: { fileZeroValue: false } })
    try {
      expect(await enqueueSale(A, id)).toMatchObject({ status: 'skipped', statusReason: 'zero_value' })
    } finally {
      await setConnector(A.tenantId, 'fiscal', { settings: { fileZeroValue: true } })
    }
  })

  it('a delivery whose loyalty covers the food, the GST and part of the fee keeps the fee explicit', async () => {
    // 55,000 + 15 % 8,250 + delivery 15,000 = 78,250; points 70,000; COD 8,250.
    const id = await order(A, {
      items: [KHEER(A, 1)], discountCents: 70_000, taxCents: 8_250, taxRatePct: 15, totalCents: 8_250,
      payments: [{ method: 'cash', amountCents: 8_250, status: 'pending' }],
    }, { source: 'servd', fulfilmentType: 'delivery' })
    const b = await build(id)
    expect(b.check.ok, b.check.problems.join('; ')).toBe(true)
    expect(totalsOf(b.payload)).toMatchObject({ taxableCents: 0, taxCents: 8_250, deliveryChargeCents: 15_000, billDiscountCents: 15_000, totalCents: 8_250 })
  })

  it('a bill discount is never accepted while the lines still carry value', () => {
    const p = {
      version: 1, documentId: 's', kind: 'sale', orderId: 'o', orderRef: 'O', source: 'pos', issuedAt: new Date().toISOString(), currency: 'PKR',
      registrations: [], seller: { legalName: 'x' }, buyer: null,
      lines: [{ lineId: 'l', itemCode: 'c', description: 'd', quantity: 1, unitPriceCents: 1_000, grossCents: 1_000, discountCents: 0, taxableCents: 1_000, taxRatePct: 15, taxCents: 150 }],
      totals: { saleValueCents: 1_000, discountCents: 0, taxableCents: 1_000, taxCents: 150, taxRatePct: 15, serviceChargeCents: 0, tipCents: 0, billDiscountCents: 150, totalCents: 1_000 },
      payment: { mode: 'cash', tenders: [] },
    } as unknown as FiscalPayload
    expect(totalsCheck(p).ok).toBe(false)
  })
})

describe('F-RV-2 — an in-doubt document is looked up before the totals gate', () => {
  /** A pending sale frozen before the totals fix (wallet sale sent with total 0), already submitted once with an unknown outcome. */
  async function inDoubtDoc(co: Company, opts: { status?: 'pending' | 'failed'; lastErrorCode?: string } = {}): Promise<{ docId: string; orderId: string }> {
    const orderId = await order(co, { items: [KHEER(co, 1)], taxCents: 4_400, taxRatePct: 8, totalCents: 0, payments: [] }, { source: 'servd', walletAmountCents: 59_400 })
    const fresh = await build(orderId)
    const docId = newDocumentId()
    const old: FiscalPayload = { ...fresh.payload, documentId: docId, totals: { ...fresh.payload.totals, totalCents: 0 }, payment: { mode: 'cash', tenders: [] } }
    delete (old.totals as { deliveryChargeCents?: number }).deliveryChargeCents
    await prisma.fiscalDocument.create({
      data: {
        id: docId, tenantId: co.tenantId, kind: 'sale', orderId, conceptId: co.conceptId, locationId: co.locationId,
        idempotencyKey: `sale:${orderId}`, status: opts.status ?? 'pending',
        ...(opts.status === 'failed' && { statusReason: TOTALS_MISMATCH }),
        payload: JSON.parse(JSON.stringify(old)) as Prisma.InputJsonValue, payloadHash: payloadHash(old), amountCents: 0,
        attempts: 1, lastErrorCode: opts.lastErrorCode ?? 'UNKNOWN_TIMEOUT', nextAttemptAt: new Date(Date.now() - 1000),
      },
    })
    return { docId, orderId }
  }
  const scenario = (co: Company, s: 'ok' | 'down' | 'reject') => setConnector(co.tenantId, 'fiscal', { driver: 'test', enabled: true, settings: { test: { scenario: s } } })

  it('the vendor has it: the lookup files it, nothing is submitted, no mismatch alert', async () => {
    await scenario(A, 'ok')
    const { docId } = await inDoubtDoc(A)
    resetTestDriverCalls()
    expect(await sendOnce(docId, 'worker', 2000)).toBe('filed')
    expect(testDriverCalls.getDocumentStatus).toBe(1)
    expect(testDriverCalls.submitSale).toBe(0)
    expect(await prisma.fiscalDocument.findUniqueOrThrow({ where: { id: docId } })).toMatchObject({ status: 'filed', lastErrorCode: null })
    expect(await prisma.exceptionFlag.count({ where: { tenantId: A.tenantId, entityId: docId } })).toBe(0)
  })

  it('the lookup fails: retried later with the UNKNOWN marker kept, never failed or submitted', async () => {
    await scenario(A, 'down')
    const { docId } = await inDoubtDoc(A, { lastErrorCode: 'UNKNOWN_LEASE_EXPIRED' })
    resetTestDriverCalls()
    expect(await sendOnce(docId, 'worker', 2000)).toBe('pending')
    expect(testDriverCalls.submitSale).toBe(0)
    expect(await prisma.fiscalDocument.findUniqueOrThrow({ where: { id: docId } })).toMatchObject({ status: 'pending', lastErrorCode: 'UNKNOWN_LEASE_EXPIRED' })
  })

  it('the vendor never got it: failed as NOT sent; Retry rebuilds it although attempts > 0, and it files', async () => {
    await scenario(A, 'reject') // the test driver's lookup answers not_found
    const { docId } = await inDoubtDoc(A)
    resetTestDriverCalls()
    expect(await sendOnce(docId, 'worker', 2000)).toBe('failed')
    expect(testDriverCalls.getDocumentStatus).toBe(1)
    expect(testDriverCalls.submitSale).toBe(0)
    const row = await prisma.fiscalDocument.findUniqueOrThrow({ where: { id: docId } })
    expect(row).toMatchObject({ status: 'failed', statusReason: TOTALS_MISMATCH, lastErrorCode: 'TOTALS_MISMATCH', attempts: 1 })
    const flag = await prisma.exceptionFlag.findFirstOrThrow({ where: { tenantId: A.tenantId, entityId: docId } })
    expect(flag.description).toMatch(/NOT sent/)
    // Company B cannot retry A's document.
    await expect(retryDocument(docId, { tenantId: B.tenantId })).rejects.toMatchObject({ statusCode: 404 })
    await scenario(A, 'ok')
    const retried = await retryDocument(docId, { tenantId: A.tenantId })
    expect(retried).toMatchObject({ status: 'pending', amountCents: 59_400 })
    expect(totalsCheck(retried.payload as unknown as FiscalPayload).ok).toBe(true)
    expect(await sendOnce(docId, 'worker', 2000)).toBe('filed')
  })

  it('no lookup possible: failed IN DOUBT — UNKNOWN kept, the alert never says "not sent", Retry asks the vendor first', async () => {
    await scenario(A, 'ok')
    const { docId } = await inDoubtDoc(A)
    const spy = vi.spyOn(testFiscalDriver, 'capabilities').mockReturnValue({ refunds: true, zeroValue: true, lookup: false })
    try {
      resetTestDriverCalls()
      expect(await sendOnce(docId, 'worker', 2000)).toBe('failed')
      expect(testDriverCalls.submitSale).toBe(0)
      const row = await prisma.fiscalDocument.findUniqueOrThrow({ where: { id: docId } })
      expect(row).toMatchObject({ status: 'failed', statusReason: TOTALS_MISMATCH, lastErrorCode: 'UNKNOWN_TIMEOUT' })
      expect(row.lastError).toMatch(/TOTALS_MISMATCH/)
      const flag = await prisma.exceptionFlag.findFirstOrThrow({ where: { tenantId: A.tenantId, entityId: docId } })
      expect(flag.description).not.toMatch(/NOT sent/)
      expect(flag.description).toMatch(/may already have filed it/)
      // Retry cannot ask this vendor → refused, nothing rebuilt.
      await expect(retryDocument(docId, { tenantId: A.tenantId })).rejects.toMatchObject({ code: 'FISCAL_IN_DOUBT', statusCode: 409 })
      expect((await prisma.fiscalDocument.findUniqueOrThrow({ where: { id: docId } })).status).toBe('failed')
    } finally {
      spy.mockRestore()
    }
    // With a lookup again: the vendor has it → Retry records the filing, nothing resubmitted.
    resetTestDriverCalls()
    const after = await retryDocument(docId, { tenantId: A.tenantId })
    expect(after.status).toBe('filed')
    expect(testDriverCalls.submitSale).toBe(0)
  })

  it('a failed in-doubt sale whose lookup cannot answer is refused (409), never rebuilt', async () => {
    await scenario(B, 'down')
    const { docId } = await inDoubtDoc(B, { status: 'failed' })
    await expect(retryDocument(docId, { tenantId: B.tenantId })).rejects.toMatchObject({ code: 'FISCAL_IN_DOUBT' })
    const row = await prisma.fiscalDocument.findUniqueOrThrow({ where: { id: docId } })
    expect(row).toMatchObject({ status: 'failed', amountCents: 0, lastErrorCode: 'UNKNOWN_TIMEOUT' })
    await expect(retryDocument(docId, { tenantId: A.tenantId })).rejects.toMatchObject({ statusCode: 404 })
    await setConnector(B.tenantId, 'fiscal', { driver: 'none', enabled: false })
    await setConnector(A.tenantId, 'fiscal', { driver: 'none', enabled: false })
  })
})
