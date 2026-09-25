// One receipt builder.
//
// The HTML receipt used to recompute GST at the legacy concept.taxRate (17%)
// on the post-discount base, so its printed total disagreed with what was
// charged; the JSON receipt-data left modifiers out of the subtotal and used a
// different receipt number. Both now come from buildReceiptData. What this
// guards:
//   - tax and total are the STORED order values, never recomputed;
//   - modifiers are in the line price and the subtotal; voided lines are not;
//   - "Invoice #" is our TaxInvoice number once issued, the order ref before;
//   - the FBR / SRB ids and the SRB link pass through untouched;
//   - the HTML renders the same numbers, and escapes user text.
import { describe, it, expect, beforeAll } from 'vitest'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { buildReceiptData, buildReceiptHtml } from '../src/modules/pos/receipt.js'

let conceptId: string

beforeAll(async () => {
  const tenantId = (await prisma.tenant.create({ data: { name: 'Receipt Co', slug: 'receipt-co' } })).id
  conceptId = (await prisma.concept.create({
    // taxRate 17 is the legacy rate the old HTML receipt recomputed with.
    data: { name: 'Receipt Cafe', slug: 'receipt-cafe', type: 'restaurant', tenantId, taxRate: 17, taxRateCash: 15, invoiceLegalName: 'Receipt Cafe (Pvt) Ltd', strn: 'STRN-1' },
  })).id
})

async function order() {
  return prisma.order.create({
    data: {
      conceptId, source: 'pos', status: 'completed', completedAt: new Date(),
      // 2 × (500 + 50 extra cheese) + 1 × 300 = 1,400.00; 15% GST on the
      // pre-discount base = 210.00; less 100.00 discount → 1,510.00.
      discountCents: 10_000, taxCents: 21_000, totalCents: 151_000,
      fbrInvoiceNumber: 'FBR-998877', srbInvoiceNumber: 'SRB-112233', srbQrCodeLink: 'https://srb.example/verify?x=1',
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
    expect(r.fbrInvoiceNo).toBe('FBR-998877')
    expect(r.srbInvoiceNo).toBe('SRB-112233')
    expect(r.srbQrLink).toBe('https://srb.example/verify?x=1')
  })

  it('numbers the receipt with our tax invoice once issued, the order ref before', async () => {
    const o = await order()
    const before = await buildReceiptData(o.id)
    expect(before.invoiceNumber).toBeNull()
    expect(before.number).toBe(o.id.slice(-8).toUpperCase())

    await prisma.taxInvoice.create({
      data: {
        invoiceNumber: 'RCP-2026-00001', type: 'invoice', orderId: o.id, conceptId,
        sellerLegalName: 'Receipt Cafe (Pvt) Ltd', subtotalCents: 140_000, discountCents: 10_000,
        taxableValueCents: 130_000, fbrTaxCents: 21_000, provincialTaxCents: 0, serviceChargeCents: 0, tipCents: 0, totalCents: 151_000,
      },
    })
    const after = await buildReceiptData(o.id)
    expect(after.number).toBe('RCP-2026-00001')
    expect(after.invoiceNumber).toBe('RCP-2026-00001')
    expect(after.orderRef).toBe(o.id.slice(-8).toUpperCase())
  })

  it('the HTML receipt shows the same numbers — never a 17% recompute — and escapes user text', async () => {
    const o = await order()
    const html = await buildReceiptHtml(o.id)
    expect(html).toContain('PKR 1510.00')   // stored total
    expect(html).toContain('PKR 210.00')    // stored GST
    expect(html).not.toContain('GST 17%')
    expect(html).toContain('SRB Invoice No: SRB-112233')
    expect(html).toContain('&lt;b&gt;Ali&lt;/b&gt;')
    expect(html).not.toContain('<b>Ali</b>')
    expect(html).not.toContain('Voided brownie')
  })
})
