// The delivery fee on the bill and the tax invoice (owner 2026-10-13, H9), and
// an on-account client's bill (H14).
//
//   receipt  ReceiptData.deliveryFeeCents / deliveryFeeTaxCents; the HTML
//            prints a 'Delivery charge' row and 'GST (incl. PKR x on
//            delivery)', so subtotal − discount + delivery + GST + service +
//            tip = the TOTAL. An on-account payment prints "On account —
//            <client> (<OA-number>) · <reference>" and a client signature line.
//   invoice  TaxInvoice.deliveryFeeCents; taxable value = food + fee; a
//            'Delivery charge' line; total = max(0, food + fee + tax + service
//            + tip − discount) = the bill, even when a discount covers more
//            than the food; the credit note mirrors it. An order charged to an
//            on-account client names the client as the buyer — its OWN
//            company's charge only.
//
// Two companies: B's cashier gets 404 on A's bill; a charge row of company B
// never names B's client on A's invoice.
// Requires a disposable database (DATABASE_URL must contain "test").
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { buildReceiptData, buildReceiptHtml, paymentLabelOf, CLIENT_SIGNATURE_LINE } from '../src/modules/pos/receipt.js'
import { issueInvoiceForOrder, issueCreditNoteForOrder, renderInvoiceHtml, DELIVERY_CHARGE_LINE } from '../src/modules/invoices/service.js'
import { mkCompany, mkUser, buildApp, caller, resetConnectorCache, type Company, type Who } from './connectorsFixtures.js'

let A: Company, B: Company
let app: FastifyInstance
let call: ReturnType<typeof caller>
let cashierA: Who, cashierB: Who

beforeAll(async () => {
  A = await mkCompany('dfri-a', { srbPosId: 5101 })
  B = await mkCompany('dfri-b', { srbPosId: 5102 })
  cashierA = await mkUser('dfri-cashier-a', 'cashier', A.tenantId)
  cashierB = await mkUser('dfri-cashier-b', 'cashier', B.tenantId)
  app = await buildApp()
  call = caller(app)
}, 60_000)

afterAll(async () => {
  resetConnectorCache()
  await app?.close()
})

interface DeliverySpec {
  qty?: number
  discountCents?: number
  tipCents?: number
  serviceChargeCents?: number
  /** Paid rows; amountCents defaults to the whole bill. */
  payments?: Array<{ method: 'cash' | 'on_account'; amountCents?: number; gatewayRef?: string; gatewayMeta?: object }>
}

/**
 * A completed storefront delivery as ingestOrder stores it: Kheer at
 * PKR 550 a cup, GST 15 % (cash on delivery), fee 15,000 + its GST 2,250.
 */
async function deliveryOrder(co: Company, spec: DeliverySpec = {}): Promise<{ id: string; totalCents: number }> {
  const qty = spec.qty ?? 2
  const food = 55_000 * qty
  const itemTax = Math.round(food * 0.15)
  const fee = 15_000
  const feeTax = 2_250
  const discount = spec.discountCents ?? 0
  const tip = spec.tipCents ?? 0
  const svc = spec.serviceChargeCents ?? 0
  const total = Math.max(0, food + itemTax - discount + fee + feeTax + svc + tip)
  const o = await prisma.order.create({
    data: {
      conceptId: co.conceptId, locationId: co.locationId, source: 'servd', fulfilmentType: 'delivery',
      status: 'completed', completedAt: new Date(), placedAt: new Date(),
      taxRatePct: 15, taxCents: itemTax + feeTax, deliveryFeeCents: fee, deliveryFeeTaxCents: feeTax,
      discountCents: discount, serviceChargeCents: svc, tipCents: tip, totalCents: total, customerName: 'Sana',
      items: { create: [{ name: 'Kheer', quantity: qty, unitPriceCents: 55_000, menuItemId: co.items.kheer }] },
      payments: { create: (spec.payments ?? [{ method: 'cash' as const }]).map((p) => ({ status: 'paid' as const, ...p, amountCents: p.amountCents ?? total })) },
    },
  })
  return { id: o.id, totalCents: total }
}

describe('the bill: a Delivery charge row, GST with its delivery share, rows add up', () => {
  it('receipt data carries the fee and its GST; the rows add up to the total', async () => {
    const o = await deliveryOrder(A, { tipCents: 5_000 })
    const r = await buildReceiptData(o.id)
    expect(r).toMatchObject({ subtotalCents: 110_000, discountCents: 0, deliveryFeeCents: 15_000, deliveryFeeTaxCents: 2_250, taxCents: 18_750, tipCents: 5_000, totalCents: o.totalCents })
    expect(r.subtotalCents - r.discountCents + r.deliveryFeeCents + r.taxCents + r.serviceChargeCents + r.tipCents).toBe(r.totalCents)
    expect(r.clientSignature).toBe(false)

    const html = await buildReceiptHtml(o.id)
    expect(html).toMatch(/<td>Delivery charge<\/td><td style="text-align:right">PKR 150\.00<\/td>/)
    expect(html).toMatch(/<td>GST \(incl\. PKR 22\.50 on delivery\)<\/td><td style="text-align:right">PKR 187\.50<\/td>/)
    expect(html).toContain(`PKR ${(o.totalCents / 100).toFixed(2)}`)
    expect(html).not.toContain('Client signature')
  })

  it('a discount larger than the food: the bill still adds up', async () => {
    const o = await deliveryOrder(A, { qty: 1, discountCents: 70_000 })
    const r = await buildReceiptData(o.id)
    expect(r.totalCents).toBe(55_000 + 8_250 + 15_000 + 2_250 - 70_000)
    expect(r.subtotalCents - r.discountCents + r.deliveryFeeCents + r.taxCents + r.serviceChargeCents + r.tipCents).toBe(r.totalCents)
  })

  it('a till order prints no Delivery charge row and a plain GST row', async () => {
    const o = await prisma.order.create({
      data: {
        conceptId: A.conceptId, source: 'pos', status: 'completed', completedAt: new Date(), taxRatePct: 15, taxCents: 8_250, totalCents: 63_250,
        items: { create: [{ name: 'Kheer', quantity: 1, unitPriceCents: 55_000 }] },
        payments: { create: [{ method: 'cash', amountCents: 63_250, status: 'paid' }] },
      },
    })
    const html = await buildReceiptHtml(o.id)
    expect(html).not.toContain('Delivery charge')
    expect(html).toMatch(/<td>GST<\/td>/)
  })

  it('company B gets 404 on A\'s delivery bill; A gets the fee fields', async () => {
    const o = await deliveryOrder(A)
    expect((await call(cashierB, 'GET', `/pos/orders/${o.id}/receipt-data`)).statusCode).toBe(404)
    const mine = await call(cashierA, 'GET', `/pos/orders/${o.id}/receipt-data`)
    expect(mine.statusCode, mine.body).toBe(200)
    expect(mine.json()).toMatchObject({ deliveryFeeCents: 15_000, deliveryFeeTaxCents: 2_250 })
  })
})

describe('on-account bills name the client and carry a signature line', () => {
  const meta = { idempotencyKey: 'k-1', onAccount: { accountId: 'acc', cardId: 'card', number: 'OA-0003', name: 'Acme Ltd', reference: 'PO 4471' } }

  it('paymentLabelOf: client, number, reference; Raast and cash unchanged', () => {
    expect(paymentLabelOf({ method: 'on_account', gatewayRef: 'OA-0003', gatewayMeta: meta }))
      .toEqual({ label: 'On account — Acme Ltd (OA-0003) · PO 4471', reference: 'PO 4471' })
    expect(paymentLabelOf({ method: 'on_account', gatewayRef: 'OA-0009', gatewayMeta: null }))
      .toEqual({ label: 'On account — (OA-0009)', reference: null })
    expect(paymentLabelOf({ method: 'raast', gatewayRef: 'FT123' })).toEqual({ label: 'Raast QR — Ref FT123', reference: 'FT123' })
    expect(paymentLabelOf({ method: 'cash', gatewayRef: null })).toEqual({ label: 'Cash', reference: null })
  })

  it('the bill prints the client and the signature line', async () => {
    const o = await deliveryOrder(A, { payments: [{ method: 'on_account', gatewayRef: 'OA-0003', gatewayMeta: meta }] })
    const r = await buildReceiptData(o.id)
    expect(r.payments[0]).toMatchObject({ method: 'on_account', label: 'On account — Acme Ltd (OA-0003) · PO 4471', reference: 'PO 4471' })
    expect(r.clientSignature).toBe(true)
    const html = await buildReceiptHtml(o.id)
    expect(html).toContain('On account — Acme Ltd (OA-0003) · PO 4471')
    expect(html).toContain(CLIENT_SIGNATURE_LINE)
  })
})

describe('the tax invoice: the fee is a taxable line and the total is the bill', () => {
  it('a Delivery charge line; taxable = food + fee; total = the bill; the credit note mirrors it', async () => {
    const o = await deliveryOrder(A, { tipCents: 5_000 })
    const inv = await issueInvoiceForOrder({ orderId: o.id })
    expect(inv).toMatchObject({
      tenantId: A.tenantId, subtotalCents: 110_000, deliveryFeeCents: 15_000, taxableValueCents: 125_000,
      fbrTaxCents: 18_750, tipCents: 5_000, totalCents: o.totalCents,
    })
    const fee = inv.lines.find((l) => l.description === DELIVERY_CHARGE_LINE)
    expect(fee).toMatchObject({ quantity: 1, unitPriceCents: 15_000, lineTotalCents: 15_000 })
    expect(inv.lines.reduce((s, l) => s + l.lineTotalCents, 0)).toBe(125_000)
    const html = renderInvoiceHtml(inv)
    expect(html).toContain('Delivery charge')

    const cn = await issueCreditNoteForOrder(o.id, 'Order refunded')
    expect(cn).toMatchObject({ type: 'credit_note', deliveryFeeCents: -15_000, taxableValueCents: -125_000, totalCents: -o.totalCents })
    expect(cn.lines.find((l) => l.description.startsWith(`Credit note: ${DELIVERY_CHARGE_LINE}`))).toMatchObject({ unitPriceCents: -15_000, lineTotalCents: -15_000 })
  })

  it('a discount larger than the food: the invoice total equals the bill, not more', async () => {
    // 55,000 + 8,250 + 15,000 + 2,250 − 70,000 = 10,500
    const o = await deliveryOrder(A, { qty: 1, discountCents: 70_000 })
    expect(o.totalCents).toBe(10_500)
    const inv = await issueInvoiceForOrder({ orderId: o.id })
    expect(inv.totalCents).toBe(10_500)
    expect(inv.taxableValueCents).toBe(70_000)
  })

  it('an order charged to an on-account client names the client; B\'s charge row never does on A\'s order', async () => {
    const admin = await mkUser('dfri-admin-a', 'admin', A.tenantId)
    const acct = await prisma.customerAccount.create({
      data: {
        tenantId: A.tenantId, number: 'OA-0003', legalName: 'Acme Ltd', ntn: '7654321-0', strn: '17-00-1234-567-89',
        address: 'Plot 4, Korangi', status: 'active', createdById: admin.id,
      },
    })
    const o = await deliveryOrder(A, { payments: [{ method: 'on_account', gatewayRef: 'OA-0003' }] })
    const pay = await prisma.payment.findFirstOrThrow({ where: { orderId: o.id } })
    await prisma.customerAccountCharge.create({
      data: { tenantId: A.tenantId, accountId: acct.id, orderId: o.id, paymentId: pay.id, conceptId: A.conceptId, amountCents: o.totalCents, chargedById: admin.id },
    })
    const inv = await issueInvoiceForOrder({ orderId: o.id })
    expect(inv).toMatchObject({ buyerName: 'Acme Ltd', buyerNtn: '7654321-0', buyerStrn: '17-00-1234-567-89', buyerAddress: 'Plot 4, Korangi' })

    // A caller-named buyer still wins.
    const o2 = await deliveryOrder(A)
    const named = await issueInvoiceForOrder({ orderId: o2.id, buyer: { name: 'Walk-in Co', ntn: '1111111-1' } })
    expect(named).toMatchObject({ buyerName: 'Walk-in Co', buyerNtn: '1111111-1' })

    // A charge row of company B pointing at A's order is not A's client.
    const adminB = await mkUser('dfri-admin-b', 'admin', B.tenantId)
    const acctB = await prisma.customerAccount.create({
      data: { tenantId: B.tenantId, number: 'OA-0001', legalName: 'Beta Traders', ntn: '9999999-9', status: 'active', createdById: adminB.id },
    })
    const o3 = await deliveryOrder(A)
    const pay3 = await prisma.payment.findFirstOrThrow({ where: { orderId: o3.id } })
    await prisma.customerAccountCharge.create({
      data: { tenantId: B.tenantId, accountId: acctB.id, orderId: o3.id, paymentId: pay3.id, conceptId: A.conceptId, amountCents: o3.totalCents, chargedById: adminB.id },
    })
    const inv3 = await issueInvoiceForOrder({ orderId: o3.id })
    expect(inv3.buyerName).toBe('Sana')
    expect(inv3.buyerNtn).toBeNull()
  })
})
