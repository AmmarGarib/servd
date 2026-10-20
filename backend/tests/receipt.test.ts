// One receipt builder — the FULL & FINAL bill (spec §11, §17.1).
//
// The HTML receipt used to recompute GST at the legacy concept.taxRate (17%)
// on the post-discount base, so its printed total disagreed with what was
// charged; the JSON receipt-data left modifiers out of the subtotal and used a
// different receipt number. Both now come from buildReceiptData. What this
// guards:
//   - tax and total are the STORED order values, never recomputed;
//   - modifiers are in the line price and the subtotal; voided lines are not;
//   - an open order has no final bill: 409 PRE_BILL_REQUIRED (print a pre-bill);
//   - heading FULL & FINAL BILL; the fiscal block from the sale's FiscalDocument:
//       filed  → "SRB Fiscal Invoice: <n>" + a real QR (<svg); the fiscal
//                number is the headline and our TaxInvoice number is "Ref"
//       test   → TEST — NOT A FISCAL INVOICE (never the headline)
//       pending→ "Fiscal invoice: pending", no number
//       legacy → a sale filed directly with SRB / FBR: the old lines + a QR
//       not required (§17.7) → "Not a tax invoice"
//   - the legacy fbrInvoiceNo / srbInvoiceNo / srbQrLink keys stay (tablets);
//   - ReceiptConfig.showFbrInvoice=false hides the fiscal block;
//   - a card-machine payment prints its card and auth code;
//   - the HTML escapes user text; company B gets 404 before any 409.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { AppError, errorResponse } from '../src/lib/errors.js'
import { registerPreBillPlugins } from '../src/modules/prebills/index.js'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { buildReceiptData, buildReceiptHtml } from '../src/modules/pos/receipt.js'
import { invalidateSetupCache } from '../src/lib/setup-config.js'
import { mkCompany, mkUser, buildApp, caller, setConnector, resetConnectorCache, type Company, type Who } from './connectorsFixtures.js'

let conceptId: string
let tenantId: string
let A: Company, B: Company
let app: FastifyInstance
let cashierA: Who, cashierB: Who

beforeAll(async () => {
  tenantId = (await prisma.tenant.create({ data: { name: 'Receipt Co', slug: 'receipt-co' } })).id
  conceptId = (await prisma.concept.create({
    // taxRate 17 is the legacy rate the old HTML receipt recomputed with.
    data: { name: 'Receipt Cafe', slug: 'receipt-cafe', type: 'restaurant', tenantId, taxRate: 17, taxRateCash: 15, invoiceLegalName: 'Receipt Cafe (Pvt) Ltd', strn: 'STRN-1' },
  })).id
  A = await mkCompany('rcpt-a', { srbPosId: 4401 })
  B = await mkCompany('rcpt-b', { srbPosId: 4402 })
  cashierA = await mkUser('rcpt-cashier-a', 'cashier', A.tenantId)
  cashierB = await mkUser('rcpt-cashier-b', 'cashier', B.tenantId)
  app = await buildApp()
}, 60_000)

afterAll(async () => {
  resetConnectorCache()
  await app?.close()
})

async function order(extra: { status?: 'completed' | 'received' | 'cancelled'; legacy?: boolean } = {}) {
  const legacy = extra.legacy ?? true
  return prisma.order.create({
    data: {
      conceptId, source: 'pos', status: extra.status ?? 'completed', completedAt: (extra.status ?? 'completed') === 'completed' ? new Date() : null,
      // 2 × (500 + 50 extra cheese) + 1 × 300 = 1,400.00; 15% GST on the
      // pre-discount base = 210.00; less 100.00 discount → 1,510.00.
      discountCents: 10_000, taxCents: 21_000, totalCents: 151_000,
      ...(legacy && { fbrInvoiceNumber: 'FBR-998877', srbInvoiceNumber: 'SRB-112233', srbQrCodeLink: 'https://srb.example/verify?x=1' }),
      customerName: '<b>Ali</b>',
      items: {
        create: [
          { name: 'Club sandwich', quantity: 2, unitPriceCents: 50_000, modifiers: { create: [{ name: 'Extra cheese', priceDeltaCents: 5_000 }] } },
          { name: 'Iced latte', quantity: 1, unitPriceCents: 30_000 },
          { name: 'Voided brownie', quantity: 1, unitPriceCents: 40_000, status: 'voided', voidedAt: new Date(), voidReason: 'Wrong item' },
        ],
      },
      payments: { create: [{ method: 'cash', amountCents: 151_000, status: 'paid', tenderedCents: 160_000 }] },
    },
  })
}

/** A sale document for an order of company `co`, as the outbox would leave it. */
async function saleDoc(co: { tenantId: string; conceptId: string }, orderId: string, data: {
  status: 'filed' | 'pending' | 'held' | 'skipped'; driver?: string; isTest?: boolean; fiscalNumber?: string; authority?: string
  qrPayload?: string; verifyUrl?: string; statusReason?: string; extraNumbers?: unknown
}) {
  return prisma.fiscalDocument.create({
    data: {
      tenantId: co.tenantId, kind: 'sale', orderId, conceptId: co.conceptId, idempotencyKey: `sale:${orderId}`,
      status: data.status, statusReason: data.statusReason ?? null, driver: data.driver ?? null, isTest: data.isTest ?? false,
      payload: { version: 1 }, payloadHash: 'h', amountCents: 151_000,
      fiscalNumber: data.fiscalNumber ?? null, authority: data.authority ?? null,
      qrPayload: data.qrPayload ?? null, verifyUrl: data.verifyUrl ?? null,
      fiscalAt: data.status === 'filed' ? new Date('2026-10-10T09:31:00Z') : null,
      ...(data.extraNumbers !== undefined && { extraNumbers: data.extraNumbers as never }),
    },
  })
}

describe('buildReceiptData', () => {
  it('prints what was charged: stored tax and total, modifiers in, voids out', async () => {
    const o = await order()
    const r = await buildReceiptData(o.id)
    expect(r.taxCents).toBe(21_000)
    expect(r.totalCents).toBe(151_000)
    expect(r.subtotalCents).toBe(140_000)
    expect(r.discountCents).toBe(10_000)
    expect(r.items.map((i) => i.name)).toEqual(['Club sandwich', 'Iced latte'])
    expect(r.items[0]).toMatchObject({ qty: 2, price: 55_000, lineTotalCents: 110_000, modifiers: ['Extra cheese'] })
    expect(r.paidCents).toBe(151_000)
    expect(r.tenderType).toBe('cash')
    expect(r.heading).toBe('FULL & FINAL BILL')
    expect(r.kind).toBe('final_bill')
    // A legacy order (filed directly before the connector) keeps its numbers.
    expect(r.fbrInvoiceNo).toBe('FBR-998877')
    expect(r.srbInvoiceNo).toBe('SRB-112233')
    expect(r.srbQrLink).toBe('https://srb.example/verify?x=1')
    expect(r.fiscal).toMatchObject({ status: 'legacy', authority: 'srb', fiscalNumber: 'SRB-112233', qrPayload: 'https://srb.example/verify?x=1' })
  })

  it('numbers the receipt with our tax invoice once issued, the order ref before', async () => {
    const o = await order()
    const before = await buildReceiptData(o.id)
    expect(before.invoiceNumber).toBeNull()
    expect(before.number).toBe(o.id.slice(-8).toUpperCase())

    await prisma.taxInvoice.create({
      data: {
        tenantId, invoiceNumber: 'RCP-2026-00001', type: 'invoice', orderId: o.id, conceptId,
        sellerLegalName: 'Receipt Cafe (Pvt) Ltd', subtotalCents: 140_000, discountCents: 10_000,
        taxableValueCents: 130_000, fbrTaxCents: 21_000, provincialTaxCents: 0, serviceChargeCents: 0, tipCents: 0, totalCents: 151_000,
      },
    })
    const after = await buildReceiptData(o.id)
    expect(after.number).toBe('RCP-2026-00001')
    expect(after.invoiceNumber).toBe('RCP-2026-00001')
    expect(after.servdRef).toBe('RCP-2026-00001')
    expect(after.orderRef).toBe(o.id.slice(-8).toUpperCase())
  })

  it('an open order with money still due has no full & final bill: 409 PRE_BILL_REQUIRED', async () => {
    const o = await order({ status: 'received', legacy: false })
    // (Fully paid it would be final — W4-FISCAL-3, tested with the routes.)
    await prisma.payment.updateMany({ where: { orderId: o.id }, data: { status: 'pending' } })
    await expect(buildReceiptData(o.id)).rejects.toMatchObject({ code: 'PRE_BILL_REQUIRED', statusCode: 409 })
    await expect(buildReceiptHtml(o.id)).rejects.toMatchObject({ code: 'PRE_BILL_REQUIRED', statusCode: 409 })
  })

  it('a cancelled order prints a CANCELLED slip: no heading, no fiscal block', async () => {
    const o = await order({ status: 'cancelled' })
    const r = await buildReceiptData(o.id)
    expect(r).toMatchObject({ kind: 'cancelled', heading: null, banner: 'CANCELLED', fiscal: null })
    const html = await buildReceiptHtml(o.id)
    expect(html).not.toContain('FULL &amp; FINAL BILL')
    expect(html).not.toContain('Fiscal Invoice')
  })

  it('the HTML receipt shows the same numbers — never a 17% recompute — and escapes user text', async () => {
    const o = await order()
    const html = await buildReceiptHtml(o.id)
    expect(html).toContain('PKR 1510.00')   // stored total
    expect(html).toContain('PKR 210.00')    // stored GST
    expect(html).not.toContain('GST 17%')
    expect(html).toContain('FULL &amp; FINAL BILL')
    // Legacy: the old lines, now with a real QR from the SRB link.
    expect(html).toContain('SRB Invoice No: SRB-112233')
    expect(html).toContain('<svg')
    expect(html).toContain('&lt;b&gt;Ali&lt;/b&gt;')
    expect(html).not.toContain('<b>Ali</b>')
    expect(html).not.toContain('Voided brownie')
  })
})

describe('the fiscal block (POS connector)', () => {
  const mk = (co: Company) => prisma.order.create({
    data: {
      conceptId: co.conceptId, source: 'pos', status: 'completed', completedAt: new Date(), taxCents: 13_050, totalCents: 100_050,
      items: { create: [{ name: 'Nihari', quantity: 1, unitPriceCents: 87_000 }] },
      payments: { create: [{ method: 'cash', amountCents: 100_050, status: 'paid' }] },
    },
  })

  it('filed: the fiscal number is the headline, a real QR prints, our TaxInvoice is the Ref; legacy keys carry the SRB number', async () => {
    const o = await mk(A)
    await prisma.taxInvoice.create({
      data: {
        tenantId: A.tenantId, invoiceNumber: 'RCP-A-0001', type: 'invoice', orderId: o.id, conceptId: A.conceptId, sellerLegalName: 'A',
        subtotalCents: 87_000, discountCents: 0, taxableValueCents: 87_000, fbrTaxCents: 13_050, provincialTaxCents: 0, serviceChargeCents: 0, tipCents: 0, totalCents: 100_050,
      },
    })
    await saleDoc(A, o.id, {
      status: 'filed', driver: 'http', fiscalNumber: 'SRB-2026-777', authority: 'srb', qrPayload: 'https://srb.example/v/777', verifyUrl: 'https://srb.example/v/777',
      extraNumbers: [{ authority: 'fbr', number: 'FBR-555' }],
    })
    const r = await buildReceiptData(o.id)
    expect(r.number).toBe('SRB-2026-777')
    expect(r.servdRef).toBe('RCP-A-0001')
    expect(r.fiscal).toMatchObject({ status: 'filed', fiscalNumber: 'SRB-2026-777', authority: 'srb' })
    expect(r).toMatchObject({ srbInvoiceNo: 'SRB-2026-777', srbQrLink: 'https://srb.example/v/777', fbrInvoiceNo: 'FBR-555', notTaxInvoice: false })
    const html = await buildReceiptHtml(o.id)
    expect(html).toContain('Invoice #: <strong>SRB-2026-777</strong>')
    expect(html).toContain('Ref: RCP-A-0001')
    expect(html).toContain('SRB Fiscal Invoice: SRB-2026-777')
    expect(html).toContain('FBR Fiscal Invoice: FBR-555')
    expect(html).toMatch(/<svg[^>]*aria-label="Scan to verify with SRB"/)
    expect(html).toContain('Scan to verify with SRB')
  })

  it('test driver: TEST — NOT A FISCAL INVOICE, the TEST-SRB number with its QR, never the headline', async () => {
    const o = await mk(A)
    await saleDoc(A, o.id, { status: 'filed', driver: 'test', isTest: true, fiscalNumber: 'TEST-SRB-ABC123', authority: 'srb', qrPayload: 'https://fiscal.test.servd.pk/verify/TEST-SRB-ABC123' })
    const r = await buildReceiptData(o.id)
    expect(r.fiscal).toMatchObject({ status: 'test', isTest: true })
    expect(r.number).toBe(o.id.slice(-8).toUpperCase())
    // An old tablet must never print a TEST number as a real one.
    expect(r.srbInvoiceNo).toBeNull()
    const html = await buildReceiptHtml(o.id)
    expect(html).toContain('TEST — NOT A FISCAL INVOICE')
    expect(html).toContain('SRB Fiscal Invoice: TEST-SRB-')
    expect(html).toContain('<svg')
  })

  it('pending (queued, not yet filed): nothing about it printed (owner, 2026-10-20), no number, no QR', async () => {
    const o = await mk(A)
    await saleDoc(A, o.id, { status: 'pending' })
    const r = await buildReceiptData(o.id)
    expect(r.fiscal).toMatchObject({ status: 'pending', fiscalNumber: null })
    expect(r.number).toBe(o.id.slice(-8).toUpperCase())
    const html = await buildReceiptHtml(o.id)
    expect(html).not.toContain('Fiscal invoice')
    expect(html).not.toContain('Fiscal Invoice:')
    expect(html).not.toContain('<svg')
  })

  it('held (the company is not live on the fiscal POS yet): "not yet issued" — no promise of a QR on a reprint (W4-RG-3)', async () => {
    const o = await mk(A)
    await saleDoc(A, o.id, { status: 'held', statusReason: 'no_connector' })
    const r = await buildReceiptData(o.id)
    expect(r.fiscal).toMatchObject({ status: 'pending', rawStatus: 'held', fiscalNumber: null })
    const html = await buildReceiptHtml(o.id)
    expect(html).not.toContain('Fiscal invoice')
    expect(html).not.toContain('filed automatically')
    expect(html).not.toContain('reprint')
    expect(html).not.toContain('<svg')
  })

  it('completed with no sale document yet (its enqueue is being recovered): pending — never our number as a fiscal one (W4-FISCAL-2)', async () => {
    const o = await mk(A)
    const r = await buildReceiptData(o.id)
    expect(r).toMatchObject({ notTaxInvoice: false, fiscal: { status: 'pending', statusReason: 'not_queued', fiscalNumber: null, documentId: null } })
    const html = await buildReceiptHtml(o.id)
    expect(html).not.toContain('Fiscal invoice')
    expect(html).not.toContain('Fiscal Invoice:')
  })

  it('a line voided and refunded on a paid order stays on the bill marked refunded, so the lines add up to the total', async () => {
    const o = await prisma.order.create({
      data: {
        conceptId: A.conceptId, source: 'servd', fulfilmentType: 'takeout', status: 'completed', completedAt: new Date(), taxCents: 16_500, totalCents: 126_500,
        items: { create: [
          { name: 'Kheer', quantity: 1, unitPriceCents: 55_000 },
          { name: 'Kheer', quantity: 1, unitPriceCents: 55_000, status: 'voided', voidedAt: new Date(), voidReason: 'out of kheer' },
          { name: 'Voided before payment', quantity: 1, unitPriceCents: 40_000, status: 'voided', voidedAt: new Date(), voidReason: 'wrong item' },
        ] },
      },
      include: { items: true },
    })
    const refunded = o.items.find((i) => i.status === 'voided' && i.name === 'Kheer')!
    await prisma.payment.createMany({ data: [
      { orderId: o.id, method: 'card', amountCents: 126_500, status: 'paid' },
      { orderId: o.id, method: 'card', amountCents: -63_250, status: 'refunded', gatewayMeta: { refund: { reason: 'Void: out of kheer', voidedItemId: refunded.id } } },
    ] })
    const r = await buildReceiptData(o.id)
    expect(r.items.map((i) => i.name)).toEqual(['Kheer', 'Kheer (refunded)'])
    expect(r.subtotalCents + r.taxCents).toBe(r.totalCents)
    expect(r).toMatchObject({ banner: 'PARTLY REFUNDED', refundedCents: 63_250 })
  })

  it('a sale auto-skipped as prefiled_direct prints its legacy SRB lines', async () => {
    const o = await order()
    await saleDoc({ tenantId, conceptId }, o.id, { status: 'skipped', statusReason: 'prefiled_direct' })
    const r = await buildReceiptData(o.id)
    expect(r.fiscal).toMatchObject({ status: 'legacy', fiscalNumber: 'SRB-112233' })
  })

  it('ReceiptConfig.showFbrInvoice=false hides the fiscal block', async () => {
    const o = await mk(B)
    await saleDoc(B, o.id, { status: 'filed', driver: 'http', fiscalNumber: 'SRB-B-1', authority: 'srb', qrPayload: 'https://srb.example/b1' })
    await prisma.receiptConfig.create({ data: { scope: 'global', scopeId: null, tenantId: B.tenantId, showFbrInvoice: false } })
    invalidateSetupCache()
    const html = await buildReceiptHtml(o.id)
    expect(html).not.toContain('Fiscal Invoice')
    expect(html).not.toContain('<svg')
    await prisma.receiptConfig.deleteMany({ where: { tenantId: B.tenantId } })
    invalidateSetupCache()
  })

  it('a company that does not report sales (§17.7) prints "Not a tax invoice"', async () => {
    const co = await mkCompany('rcpt-home')
    await setConnector(co.tenantId, 'fiscal', { settings: { fiscalReportingRequired: false } })
    const o = await mk(co)
    const r = await buildReceiptData(o.id)
    expect(r).toMatchObject({ fiscal: null, notTaxInvoice: true })
    expect(await buildReceiptHtml(o.id)).toContain('Not a tax invoice')
    // A reporting company with no document yet is NOT "not a tax invoice".
    const a = await mk(A)
    expect((await buildReceiptData(a.id)).notTaxInvoice).toBe(false)
  })

  it('a card-machine payment prints its card and auth code', async () => {
    const o = await prisma.order.create({
      data: {
        conceptId: A.conceptId, source: 'pos', status: 'completed', completedAt: new Date(), taxCents: 6_960, totalCents: 93_960,
        items: { create: [{ name: 'Nihari', quantity: 1, unitPriceCents: 87_000 }] },
        payments: { create: [{ method: 'card', amountCents: 93_960, status: 'paid', gateway: 'card_terminal', gatewayRef: 'APR-1', gatewayMeta: { terminalChargeId: 'tc1', cardBrand: 'VISA', cardLast4: '4242', authCode: 'A77' } }] },
      },
    })
    const r = await buildReceiptData(o.id)
    expect(r.card).toEqual({ brand: 'VISA', last4: '4242', authCode: 'A77' })
    const html = await buildReceiptHtml(o.id)
    expect(html).toContain('Card VISA •4242')
    expect(html).toContain('Auth A77')
  })
})

describe('the receipt routes', () => {
  it('company B gets 404 on A\'s order (before any 409); A gets 409 PRE_BILL_REQUIRED for an open order on both routes', async () => {
    const o = await prisma.order.create({
      data: { conceptId: A.conceptId, source: 'pos', status: 'received', taxCents: 0, totalCents: 87_000, items: { create: [{ name: 'Nihari', quantity: 1, unitPriceCents: 87_000 }] } },
    })
    const call = caller(app)
    expect((await call(cashierB, 'GET', `/pos/orders/${o.id}/receipt-data`)).statusCode).toBe(404)
    expect((await call(cashierB, 'GET', `/pos/receipt/${o.id}`)).statusCode).toBe(404)
    for (const url of [`/pos/orders/${o.id}/receipt-data`, `/pos/receipt/${o.id}`]) {
      const r = await call(cashierA, 'GET', url)
      expect(r.statusCode).toBe(409)
      expect(r.json().error.code).toBe('PRE_BILL_REQUIRED')
    }
    await prisma.order.update({ where: { id: o.id }, data: { status: 'completed', completedAt: new Date() } })
    const ok = await call(cashierA, 'GET', `/pos/orders/${o.id}/receipt-data`)
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toMatchObject({ heading: 'FULL & FINAL BILL', kind: 'final_bill' })
  })

  it('a fully paid order not yet handed over prints its full & final bill (fiscal: issued on completion); the pre-bill points here, not back (W4-FISCAL-3)', async () => {
    const o = await prisma.order.create({
      data: {
        conceptId: A.conceptId, source: 'servd', fulfilmentType: 'takeout', status: 'preparing', taxCents: 8_250, totalCents: 63_250, taxRatePct: 15,
        items: { create: [{ name: 'Kheer', quantity: 1, unitPriceCents: 55_000, status: 'preparing' }] },
        payments: { create: [{ method: 'card', amountCents: 63_250, status: 'paid', gateway: 'keenu', gatewayRef: `KN-rcpt-${Date.now()}` }] },
      },
    })
    const call = caller(app)
    expect((await call(cashierB, 'GET', `/pos/orders/${o.id}/receipt-data`)).statusCode).toBe(404)
    const rd = await call(cashierA, 'GET', `/pos/orders/${o.id}/receipt-data`)
    expect(rd.statusCode, rd.body).toBe(200)
    expect(rd.json()).toMatchObject({
      kind: 'final_bill', heading: 'FULL & FINAL BILL', status: 'preparing', notTaxInvoice: false,
      fiscal: { status: 'pending', statusReason: 'awaiting_completion', fiscalNumber: null },
    })
    const html = await call(cashierA, 'GET', `/pos/receipt/${o.id}`)
    expect(html.statusCode).toBe(200)
    expect(html.body).toContain('FULL &amp; FINAL BILL')
    expect(html.body).not.toContain('Fiscal invoice')   // owner, 2026-10-20: nothing printed until filed
    // Printing it files nothing: the sale document is made at completion.
    expect(await prisma.fiscalDocument.count({ where: { orderId: o.id } })).toBe(0)
    // The pre-bill refuses a paid order and says to print THIS bill — which now works.
    const pbApp = Fastify()
    pbApp.setErrorHandler((err, _req, reply) => reply.status(err instanceof AppError ? err.statusCode : 500).send(err instanceof AppError ? errorResponse(err) : { error: { code: 'INTERNAL' } }))
    await registerPreBillPlugins(pbApp)
    await pbApp.ready()
    try {
      const pb = await caller(pbApp)(cashierA, 'POST', `/pos/orders/${o.id}/pre-bill`, { tender: 'card' })
      expect(pb.statusCode, pb.body).toBe(409)
      expect(pb.json().error.code).toBe('ALREADY_FINAL')
    } finally {
      await pbApp.close()
    }

    // Part paid: still a pre-bill, with a message that does not claim nothing was paid.
    await prisma.payment.updateMany({ where: { orderId: o.id }, data: { amountCents: 30_000 } })
    const part = await call(cashierA, 'GET', `/pos/orders/${o.id}/receipt-data`)
    expect(part.statusCode).toBe(409)
    expect(part.json().error).toMatchObject({ code: 'PRE_BILL_REQUIRED', message: "This order isn't fully paid yet — print a pre-bill" })
  })
})
