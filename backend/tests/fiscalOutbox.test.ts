// W1 — the fiscal outbox enqueue rules (spec §6.2, §17.0, §17.7).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma, mkCompany, mkOrder, setConnector, resetConnectorCache, type Company } from './connectorsFixtures.js'
import { enqueueFiscalSaleTx, enqueueFiscalRefundTx, sendOnce, setFiscalKicker, releaseHeld } from '../src/connectors/fiscal/outbox.js'
import { clearConnectorCache } from '../src/connectors/registry.js'
import { setConnectorClock } from '../src/connectors/registry.js'
import type { FiscalPayload } from '../src/connectors/types.js'

let live: Company        // test driver, live, brand registered
let off: Company         // connector never configured
let unregistered: Company // live, but no POS id anywhere
let notRequired: Company  // §17.7: fiscal reporting not required

const KHEER = (co: Company) => [{ menuItemId: co.items.kheer, name: 'Kheer', quantity: 2, unitPriceCents: 55_000 }]
const sale = (co: Company, extra: Record<string, unknown> = {}) => mkOrder(co, { items: KHEER(co), taxCents: 16_500, taxRatePct: 15, totalCents: 126_500, payments: [{ method: 'cash', amountCents: 126_500 }], ...extra })

const enqueueSale = (co: Company, orderId: string) => prisma.$transaction((tx) => enqueueFiscalSaleTx(tx, { orderId, tenantId: co.tenantId }))
const enqueueRefund = (co: Company, orderId: string, refundPaymentId: string | null, amountCents: number) =>
  prisma.$transaction((tx) => enqueueFiscalRefundTx(tx, { orderId, tenantId: co.tenantId, refundPaymentId, amountCents, reason: 'guest complaint' }))

async function refundPayment(orderId: string, amountCents: number): Promise<string> {
  return (await prisma.payment.create({ data: { orderId, method: 'cash', amountCents: -amountCents, status: 'refunded', processedAt: new Date() } })).id
}

beforeAll(async () => {
  setFiscalKicker(async () => {}) // no Redis traffic from these tests
  live = await mkCompany('outbox-live', { srbPosId: 4321 })
  off = await mkCompany('outbox-off', { srbPosId: 4322 })
  unregistered = await mkCompany('outbox-unreg')
  notRequired = await mkCompany('outbox-notreq', { srbPosId: 4323 })
  await setConnector(live.tenantId, 'fiscal', { driver: 'test', enabled: true, liveSince: new Date() })
  await setConnector(unregistered.tenantId, 'fiscal', { driver: 'test', enabled: true })
  await setConnector(notRequired.tenantId, 'fiscal', { driver: 'test', enabled: true, settings: { fiscalReportingRequired: false } })
}, 60_000)

afterAll(() => {
  setFiscalKicker(null)
  setConnectorClock(null)
  resetConnectorCache()
})

describe('enqueueFiscalSaleTx', () => {
  it('is idempotent: five concurrent calls in separate transactions make ONE document', async () => {
    const orderId = await sale(live)
    const results = await Promise.all(Array.from({ length: 5 }, () => enqueueSale(live, orderId)))
    expect(new Set(results.map((r) => r!.id)).size).toBe(1)
    expect(results.filter((r) => r!.created)).toHaveLength(1)
    expect(await prisma.fiscalDocument.count({ where: { orderId } })).toBe(1)
    expect(results[0]!.status).toBe('pending')
    const doc = await prisma.fiscalDocument.findFirstOrThrow({ where: { orderId } })
    expect(doc).toMatchObject({ tenantId: live.tenantId, kind: 'sale', idempotencyKey: `sale:${orderId}`, amountCents: 126_500, conceptId: live.conceptId })
    expect((doc.payload as unknown as FiscalPayload).documentId).toBe(doc.id)
  })

  it('a rolled-back transaction leaves no document', async () => {
    const orderId = await sale(live)
    await expect(prisma.$transaction(async (tx) => {
      await enqueueFiscalSaleTx(tx, { orderId, tenantId: live.tenantId })
      throw new Error('completion failed')
    })).rejects.toThrow('completion failed')
    expect(await prisma.fiscalDocument.count({ where: { orderId } })).toBe(0)
  })

  it('connector off → held / no_connector (visible, never sent)', async () => {
    const r = await enqueueSale(off, await sale(off))
    expect(r).toMatchObject({ status: 'held', statusReason: 'no_connector' })
  })

  it('live but no POS id for the brand or outlet → held / not_registered', async () => {
    const r = await enqueueSale(unregistered, await sale(unregistered))
    expect(r).toMatchObject({ status: 'held', statusReason: 'not_registered' })
  })

  it('an order already filed directly with SRB / FBR → skipped / prefiled_direct (automatic)', async () => {
    const r = await enqueueSale(live, await sale(live, { srbInvoiceNumber: 'SRB-OLD-1' }))
    expect(r).toMatchObject({ status: 'skipped', statusReason: 'prefiled_direct' })
  })

  it('zero-value: filed by default (owner flag d); skipped / zero_value when fileZeroValue is off', async () => {
    // A real zero bill: the food discounted in full (a zero bill with priced
    // lines and no discount does not add up — ONL-R2-02, resimFiscal).
    const zero = () => mkOrder(live, { items: KHEER(live), discountCents: 110_000, taxCents: 0, taxRatePct: 15, totalCents: 0, payments: [] })
    expect(await enqueueSale(live, await zero())).toMatchObject({ status: 'pending' })
    await setConnector(live.tenantId, 'fiscal', { settings: { fileZeroValue: false } })
    expect(await enqueueSale(live, await zero())).toMatchObject({ status: 'skipped', statusReason: 'zero_value' })
    await setConnector(live.tenantId, 'fiscal', { settings: { fileZeroValue: true } })
  })

  it('§17.7: a company that does not report sales gets NO document', async () => {
    const orderId = await sale(notRequired)
    expect(await enqueueSale(notRequired, orderId)).toBeNull()
    expect(await prisma.fiscalDocument.count({ where: { orderId } })).toBe(0)
  })
})

describe('enqueueFiscalRefundTx', () => {
  it('sale filed → refund pending with the original fiscal number', async () => {
    const orderId = await sale(live)
    const s = await enqueueSale(live, orderId)
    expect(await sendOnce(s!.id, 'worker', 3000)).toBe('filed')
    const saleDoc = await prisma.fiscalDocument.findUniqueOrThrow({ where: { id: s!.id } })
    const r = await enqueueRefund(live, orderId, await refundPayment(orderId, 50_000), 50_000)
    expect(r).toMatchObject({ status: 'pending' })
    const doc = await prisma.fiscalDocument.findUniqueOrThrow({ where: { id: r!.id } })
    expect(doc.saleDocumentId).toBe(saleDoc.id)
    expect((doc.payload as unknown as FiscalPayload).original).toMatchObject({ documentId: saleDoc.id, fiscalNumber: saleDoc.fiscalNumber, authority: 'srb' })
  })

  it('sale still pending → refund waiting, then promoted (with the number) when the sale files', async () => {
    const orderId = await sale(live)
    const s = await enqueueSale(live, orderId)
    const r = await enqueueRefund(live, orderId, await refundPayment(orderId, 26_500), 26_500)
    expect(r).toMatchObject({ status: 'waiting' })
    expect(await sendOnce(s!.id, 'worker', 3000)).toBe('filed')
    const doc = await prisma.fiscalDocument.findUniqueOrThrow({ where: { id: r!.id } })
    expect(doc.status).toBe('pending')
    const saleDoc = await prisma.fiscalDocument.findUniqueOrThrow({ where: { id: s!.id } })
    expect((doc.payload as unknown as FiscalPayload).original?.fiscalNumber).toBe(saleDoc.fiscalNumber)
  })

  it('W1-R4: a refund waiting on a HELD sale is rebuilt from the sale as released (POS ids, seller), keeping its own time, amount and reason', async () => {
    const co = await mkCompany('outbox-r4')
    await setConnector(co.tenantId, 'fiscal', { driver: 'test', enabled: true, liveSince: new Date() })
    const orderId = await sale(co)
    const s = await enqueueSale(co, orderId)
    expect(s).toMatchObject({ status: 'held', statusReason: 'not_registered' })
    const r = await enqueueRefund(co, orderId, await refundPayment(orderId, 26_500), 26_500)
    expect(r).toMatchObject({ status: 'waiting' })
    const before = (await prisma.fiscalDocument.findUniqueOrThrow({ where: { id: r!.id } })).payload as unknown as FiscalPayload
    expect(before.registrations).toEqual([])

    // The CEO adds the brand's SRB POS id and releases the held sale; it files.
    await prisma.concept.update({ where: { id: co.conceptId }, data: { srbPosId: 123456, ntn: '7654321-0', invoiceLegalName: 'R4 Foods (Pvt) Ltd' } })
    clearConnectorCache()
    expect(await releaseHeld(co.tenantId)).toMatchObject({ released: 1 })
    expect(await sendOnce(s!.id, 'worker', 3000)).toBe('filed')
    const saleDoc = await prisma.fiscalDocument.findUniqueOrThrow({ where: { id: s!.id } })
    const salePayload = saleDoc.payload as unknown as FiscalPayload

    const doc = await prisma.fiscalDocument.findUniqueOrThrow({ where: { id: r!.id } })
    expect(doc.status).toBe('pending')
    const after = doc.payload as unknown as FiscalPayload
    expect(after.registrations).toEqual([expect.objectContaining({ authority: 'srb', posId: '123456' })])
    expect(after.registrations).toEqual(salePayload.registrations)
    expect(after.seller).toEqual(salePayload.seller)
    expect(after.seller).toMatchObject({ legalName: 'R4 Foods (Pvt) Ltd', ntn: '7654321-0' })
    expect(after.original).toMatchObject({ documentId: saleDoc.id, fiscalNumber: saleDoc.fiscalNumber })
    expect(after).toMatchObject({ documentId: r!.id, kind: 'refund', issuedAt: before.issuedAt, refundAmountCents: 26_500, reason: 'guest complaint' })
    expect(after.payment.tenders).toEqual(before.payment.tenders)
    expect(doc.amountCents).toBe(26_500)
    expect(await sendOnce(r!.id, 'worker', 3000)).toBe('filed')
  })

  it('sale filed directly before the cutover (no sale document) → manual_required + ExceptionFlag', async () => {
    const orderId = await sale(live, { srbInvoiceNumber: 'SRB-PRE-77' })
    const r = await enqueueRefund(live, orderId, await refundPayment(orderId, 10_000), 10_000)
    expect(r).toMatchObject({ status: 'manual_required', statusReason: 'prefiled_direct_refund' })
    const flag = await prisma.exceptionFlag.findFirstOrThrow({ where: { entityId: r!.id } })
    expect(flag).toMatchObject({ kind: 'fiscal_manual_refund', severity: 'medium', tenantId: live.tenantId })
    expect((await prisma.fiscalDocument.findUniqueOrThrow({ where: { id: r!.id } })).payload).toMatchObject({ original: { fiscalNumber: 'SRB-PRE-77', authority: 'srb' } })
  })

  it('skipped sale → refund skipped with the same reason', async () => {
    await setConnector(live.tenantId, 'fiscal', { settings: { fileZeroValue: false } })
    const orderId = await mkOrder(live, { items: KHEER(live), discountCents: 110_000, taxCents: 0, taxRatePct: 15, totalCents: 0, payments: [] })
    await enqueueSale(live, orderId)
    await setConnector(live.tenantId, 'fiscal', { settings: { fileZeroValue: true } })
    const r = await enqueueRefund(live, orderId, null, 0)
    expect(r).toMatchObject({ status: 'skipped', statusReason: 'zero_value' })
  })

  it('no sale document and no legacy number → skipped / no_sale_document (automatic)', async () => {
    const orderId = await sale(live)
    const r = await enqueueRefund(live, orderId, null, 126_500)
    expect(r).toMatchObject({ status: 'skipped', statusReason: 'no_sale_document' })
  })

  it('two partial refunds give two documents; a repeated key gives the same one', async () => {
    const orderId = await sale(live)
    await enqueueSale(live, orderId)
    const p1 = await refundPayment(orderId, 20_000)
    const p2 = await refundPayment(orderId, 30_000)
    const a = await enqueueRefund(live, orderId, p1, 20_000)
    const b = await enqueueRefund(live, orderId, p2, 30_000)
    const again = await enqueueRefund(live, orderId, p1, 20_000)
    expect(a!.id).not.toBe(b!.id)
    expect(again!.id).toBe(a!.id)
    expect(again!.created).toBe(false)
    expect(await prisma.fiscalDocument.count({ where: { orderId, kind: 'refund' } })).toBe(2)
  })

  it('a void from the status path uses void:<orderId>', async () => {
    const orderId = await sale(live)
    await enqueueSale(live, orderId)
    const r = await enqueueRefund(live, orderId, null, 126_500)
    const doc = await prisma.fiscalDocument.findUniqueOrThrow({ where: { id: r!.id } })
    expect(doc.idempotencyKey).toBe(`void:${orderId}`)
    expect(doc.status).toBe('waiting')
  })
})
