// W1 — the fiscal payload builder (spec §6.1, D8) and the FBR / SRB rules
// ported from the old direct filers (adapters/fbr, adapters/srb).
import { describe, it, expect, beforeAll } from 'vitest'
import { prisma, mkCompany, mkOrder, type Company } from './connectorsFixtures.js'
import {
  buildFiscalSaleTx, buildRefundPayload, payloadHash, resolveRegistrations, paymentModeOf,
  toSrbInvoiceFields, toFbrInvoiceFields,
} from '../src/connectors/fiscal/payload.js'
import { stableStringify } from '../src/connectors/util.js'
import { DEFAULT_FISCAL_SETTINGS } from '../src/connectors/config.js'
import type { FiscalPayload, FiscalSettings } from '../src/connectors/types.js'

let A: Company
let bare: Company

const NIHARI_NALLI = (A: Company) => ({ menuItemId: A.items.nihari, name: 'Beef Nihari', quantity: 1, unitPriceCents: 145_000, modifiers: [{ name: 'Nalli', priceDeltaCents: 35_000 }] })
const KHEER2 = (A: Company) => ({ menuItemId: A.items.kheer, name: 'Kheer', quantity: 2, unitPriceCents: 55_000 })

async function build(orderId: string, settings: Pick<FiscalSettings, 'outlets'> = DEFAULT_FISCAL_SETTINGS, docId = 'doc_test_1') {
  return prisma.$transaction((tx) => buildFiscalSaleTx(tx, orderId, docId, settings))
}

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0)

beforeAll(async () => {
  A = await mkCompany('payload-a', { srbPosId: 1234, fbrPosId: 999 })
  bare = await mkCompany('payload-bare')
}, 60_000)

describe('stored figures, never recomputed', () => {
  it('cash at 15 % and card at 8 % give different payloads from the stored tax and rate', async () => {
    const cash = await mkOrder(A, { items: [NIHARI_NALLI(A), KHEER2(A)], taxCents: 43_500, taxRatePct: 15, totalCents: 333_500, payments: [{ method: 'cash', amountCents: 333_500 }] })
    const card = await mkOrder(A, { items: [NIHARI_NALLI(A), KHEER2(A)], taxCents: 23_200, taxRatePct: 8, totalCents: 313_200, payments: [{ method: 'card', amountCents: 313_200 }] })
    const c = (await build(cash)).payload
    const k = (await build(card)).payload
    expect(c.totals).toMatchObject({ saleValueCents: 290_000, discountCents: 0, taxableCents: 290_000, taxCents: 43_500, taxRatePct: 15, totalCents: 333_500 })
    expect(k.totals).toMatchObject({ saleValueCents: 290_000, taxCents: 23_200, taxRatePct: 8, totalCents: 313_200 })
    expect(c.payment).toEqual({ mode: 'cash', tenders: [{ method: 'cash', amountCents: 333_500 }] })
    expect(k.payment.mode).toBe('card')
    // Lines: gross = qty × (unit + modifiers), line tax sums exactly.
    expect(c.lines.map((l) => l.grossCents)).toEqual([180_000, 110_000])
    expect(c.lines.map((l) => l.unitPriceCents)).toEqual([180_000, 55_000])
    expect(c.lines.map((l) => l.taxCents)).toEqual([27_000, 16_500])
    expect(sum(k.lines.map((l) => l.taxCents))).toBe(23_200)
    expect(c.issuedAt).toBe('2026-10-10T14:30:00+05:00')
    expect(c.seller).toMatchObject({ legalName: 'payload-a Foods (Pvt) Ltd', ntn: '1234567-8', province: 'SD' })
  })

  it('never reads concept.taxRate (17): a legacy order without taxRatePct falls back to the tender rate', async () => {
    const byCard = await mkOrder(A, { items: [KHEER2(A)], taxCents: 8_800, taxRatePct: null, totalCents: 118_800, payments: [{ method: 'card', amountCents: 118_800 }] })
    const byCash = await mkOrder(A, { items: [KHEER2(A)], taxCents: 16_500, taxRatePct: null, totalCents: 126_500, payments: [{ method: 'cash', amountCents: 126_500 }] })
    const p1 = (await build(byCard)).payload
    const p2 = (await build(byCash)).payload
    expect(p1.totals.taxRatePct).toBe(8)
    expect(p2.totals.taxRatePct).toBe(15)
    for (const p of [p1, p2]) {
      expect(p.totals.taxRatePct).not.toBe(17)
      for (const l of p.lines) expect(l.taxRatePct).not.toBe(17)
    }
  })

  it('discount = discount + promo, spread over the lines; line tax still sums to the stored tax', async () => {
    const id = await mkOrder(A, { items: [NIHARI_NALLI(A), KHEER2(A)], discountCents: 10_000, promoDiscountCents: 5_000, taxCents: 41_250, taxRatePct: 15, totalCents: 316_250, payments: [{ method: 'cash', amountCents: 316_250 }] })
    const p = (await build(id)).payload
    expect(p.totals.discountCents).toBe(15_000)
    expect(sum(p.lines.map((l) => l.discountCents))).toBe(15_000)
    expect(p.totals.taxableCents).toBe(275_000)
    expect(sum(p.lines.map((l) => l.taxableCents))).toBe(275_000)
    expect(sum(p.lines.map((l) => l.taxCents))).toBe(41_250)
  })

  it('a zero-rated item carries no tax (the FBR tax-class weighting)', async () => {
    const id = await mkOrder(A, {
      items: [{ menuItemId: A.items.nihari, name: 'Beef Nihari', quantity: 1, unitPriceCents: 145_000 }, { menuItemId: A.items.water, name: 'Water', quantity: 1, unitPriceCents: 10_000 }],
      taxCents: 21_750, taxRatePct: 15, totalCents: 176_750, payments: [{ method: 'cash', amountCents: 176_750 }],
    })
    const p = (await build(id)).payload
    expect(p.lines.map((l) => l.taxRatePct)).toEqual([15, 0])
    expect(p.lines.map((l) => l.taxCents)).toEqual([21_750, 0])
  })

  it('buyer only when the customer has an NTN or CNIC; servd invoice number when one exists', async () => {
    const withNtn = await mkOrder(A, { items: [KHEER2(A)], taxCents: 16_500, taxRatePct: 15, totalCents: 126_500, payments: [{ method: 'cash', amountCents: 126_500 }], customer: { name: 'Acme Traders', ntn: '7654321-0' } })
    const plain = await mkOrder(A, { items: [KHEER2(A)], taxCents: 16_500, taxRatePct: 15, totalCents: 126_500, payments: [{ method: 'cash', amountCents: 126_500 }], customer: { name: 'Walk-in' } })
    await prisma.taxInvoice.create({ data: { invoiceNumber: 'STX-2026-0007', orderId: withNtn, conceptId: A.conceptId, sellerLegalName: 'x', subtotalCents: 110_000, taxableValueCents: 110_000, totalCents: 126_500 } })
    const p = (await build(withNtn)).payload
    expect(p.buyer).toEqual({ legalName: 'Acme Traders', ntn: '7654321-0' })
    expect(p.servdInvoiceNumber).toBe('STX-2026-0007')
    expect((await build(plain)).payload.buyer).toBeNull()
  })
})

describe('payment mode', () => {
  it('cash only when every paid tender is cash; card for card / Keenu QR; mixed otherwise; zero-value → cash, no tenders', async () => {
    expect(paymentModeOf(['cash'])).toBe('cash')
    expect(paymentModeOf(['card', 'keenu_qr'])).toBe('card')
    expect(paymentModeOf(['cash', 'card'])).toBe('mixed')
    expect(paymentModeOf([])).toBe('cash')
    const comped = await mkOrder(A, { items: [KHEER2(A)], taxCents: 0, taxRatePct: 15, totalCents: 0, payments: [] })
    const p = (await build(comped)).payload
    expect(p.payment).toEqual({ mode: 'cash', tenders: [] })
    const mixed = await mkOrder(A, { items: [KHEER2(A)], taxCents: 16_500, taxRatePct: 15, totalCents: 126_500, payments: [{ method: 'cash', amountCents: 26_500 }, { method: 'card', amountCents: 100_000 }] })
    expect((await build(mixed)).payload.payment.mode).toBe('mixed')
  })
})

describe('registrations', () => {
  it('the outlet override for this brand beats the outlet-wide one and the brand id; each authority once', async () => {
    const settings = {
      outlets: [
        { locationId: A.locationId, conceptId: null, authority: 'srb' as const, posId: 'LOC-SRB' },
        { locationId: A.locationId, conceptId: A.conceptId, authority: 'srb' as const, posId: 'OUT-SRB', storeId: 'S1' },
        { locationId: A.locationId, conceptId: null, authority: 'fbr' as const, posId: 'LOC-FBR' },
      ],
    }
    const id = await mkOrder(A, { items: [KHEER2(A)], taxCents: 16_500, taxRatePct: 15, totalCents: 126_500, payments: [{ method: 'cash', amountCents: 126_500 }] })
    expect((await build(id, settings)).registrations).toEqual([
      { authority: 'srb', posId: 'OUT-SRB', storeId: 'S1' },
      { authority: 'fbr', posId: 'LOC-FBR' },
    ])
    const noOutlet = await mkOrder(A, { items: [KHEER2(A)], taxCents: 16_500, taxRatePct: 15, totalCents: 126_500, locationId: null, payments: [{ method: 'cash', amountCents: 126_500 }] })
    expect((await build(noOutlet, settings)).registrations).toEqual([{ authority: 'srb', posId: '1234' }, { authority: 'fbr', posId: '999' }])
  })

  it('no POS id anywhere → an empty list', async () => {
    const id = await mkOrder(bare, { items: [KHEER2(bare)], taxCents: 16_500, taxRatePct: 15, totalCents: 126_500, payments: [{ method: 'cash', amountCents: 126_500 }] })
    expect((await build(id)).registrations).toEqual([])
    expect(resolveRegistrations([], { id: 'x', fbrPosId: null, srbPosId: null }, null)).toEqual([])
  })
})

describe('refund pro rata', () => {
  it('one partial refund sums exactly (lines + tax = refund) and two partials return exactly the sale tax', async () => {
    const id = await mkOrder(A, { items: [NIHARI_NALLI(A), KHEER2(A)], taxCents: 43_500, taxRatePct: 15, totalCents: 333_500, payments: [{ method: 'cash', amountCents: 333_500 }] })
    const sale = (await build(id)).payload
    const original = { documentId: 'sale1', fiscalNumber: 'SRB-1', authority: 'srb' }
    const r1 = buildRefundPayload(sale, { documentId: 'r1', refundAmountCents: 100_000, issuedAt: new Date('2026-10-11T05:00:00Z'), original })
    expect(r1.kind).toBe('refund')
    expect(r1.totals.taxCents).toBe(13_043)
    expect(sum(r1.lines.map((l) => l.taxCents))).toBe(13_043)
    expect(sum(r1.lines.map((l) => l.taxableCents)) + r1.totals.taxCents).toBe(100_000)
    expect(r1.totals.totalCents).toBe(100_000)
    expect(r1.refundAmountCents).toBe(100_000)
    expect(r1.original).toEqual(original)
    const r2 = buildRefundPayload(sale, { documentId: 'r2', refundAmountCents: 233_500, issuedAt: new Date(), original })
    expect(r1.totals.taxCents + r2.totals.taxCents).toBe(43_500)
  })

  it('a tipped sale returns the tip share as tip, not as sale value', async () => {
    const id = await mkOrder(A, { items: [KHEER2(A)], taxCents: 16_500, taxRatePct: 15, tipCents: 10_000, totalCents: 136_500, payments: [{ method: 'cash', amountCents: 136_500 }] })
    const sale = (await build(id)).payload
    const r = buildRefundPayload(sale, { documentId: 'r', refundAmountCents: 136_500, issuedAt: new Date(), original: null })
    expect(r.totals).toMatchObject({ tipCents: 10_000, taxCents: 16_500, taxableCents: 110_000, totalCents: 136_500 })
  })
})

describe('payload hash', () => {
  it('is stable for the same order and document id, and independent of key order', async () => {
    const id = await mkOrder(A, { items: [KHEER2(A)], taxCents: 16_500, taxRatePct: 15, totalCents: 126_500, payments: [{ method: 'cash', amountCents: 126_500 }] })
    const a = await build(id, DEFAULT_FISCAL_SETTINGS, 'doc_same')
    const b = await build(id, DEFAULT_FISCAL_SETTINGS, 'doc_same')
    expect(a.hash).toBe(b.hash)
    expect(a.hash).toBe(payloadHash(a.payload))
    expect(stableStringify({ b: 1, a: { d: 2, c: [3] } })).toBe(stableStringify({ a: { c: [3], d: 2 }, b: 1 }))
    const other = await build(id, DEFAULT_FISCAL_SETTINGS, 'doc_other')
    expect(other.hash).not.toBe(a.hash)
  })
})

describe('ported FBR / SRB adapter figures', () => {
  let cash: FiscalPayload
  let card: FiscalPayload
  let discounted: FiscalPayload
  beforeAll(async () => {
    cash = (await build(await mkOrder(A, { items: [NIHARI_NALLI(A), KHEER2(A)], taxCents: 43_500, taxRatePct: 15, totalCents: 333_500, payments: [{ method: 'cash', amountCents: 333_500 }] }))).payload
    card = (await build(await mkOrder(A, { items: [NIHARI_NALLI(A), KHEER2(A)], taxCents: 23_200, taxRatePct: 8, totalCents: 313_200, payments: [{ method: 'card', amountCents: 313_200 }] }))).payload
    discounted = (await build(await mkOrder(A, { items: [NIHARI_NALLI(A), KHEER2(A)], discountCents: 10_000, promoDiscountCents: 5_000, taxCents: 41_250, taxRatePct: 15, totalCents: 316_250, payments: [{ method: 'cash', amountCents: 316_250 }] }))).payload
  })

  it('SRB: rate 15 / 8, pre-discount sale value, spec tax and net, Cash only when all cash, PKT time', () => {
    expect(toSrbInvoiceFields(cash)).toMatchObject({
      posId: 1234, name: 'payload-a Foods (Pvt) Ltd', ntn: '1234567-8', invoiceType: 1, rateValue: 15,
      saleValue: 2900, taxAmount: 435, discountAmount: 0, netAmount: 3335, modeOfPay: 'Cash',
      invoiceDateTime: '2026-10-10 14:30:00', consumerName: 'N/A', consumerNTN: 'N/A', cpcCode: 'N/A',
    })
    expect(toSrbInvoiceFields(cash).invoiceId).toBe(`SRB-${cash.orderId.slice(-12).toUpperCase()}`)
    expect(toSrbInvoiceFields(card)).toMatchObject({ rateValue: 8, saleValue: 2900, taxAmount: 232, netAmount: 3132, modeOfPay: 'Card' })
    // SRB's spec taxes the PRE-discount value: 2900 × 15 % = 435; net = 2900 + 435 − 150.
    expect(toSrbInvoiceFields(discounted)).toMatchObject({ saleValue: 2900, taxAmount: 435, discountAmount: 150, netAmount: 3185 })
  })

  it('SRB sales return: invoiceType 2 against the original', () => {
    const r = buildRefundPayload(cash, { documentId: 'ret_abcdef', refundAmountCents: 115_000, issuedAt: new Date('2026-10-11T05:00:00Z'), original: { fiscalNumber: 'SRB-ORIG', authority: 'srb' } })
    const f = toSrbInvoiceFields(r)
    expect(f.invoiceType).toBe(2)
    expect(f.invoiceId).toBe(`SRBRET-${cash.orderId.slice(-10).toUpperCase()}-ABCDEF`)
    expect(f.rateValue).toBe(15)
    expect(f.saleValue).toBe(1000) // 1150 − 150 tax (round(43500 × 115000 / 333500) = 15000)
  })

  it('FBR: bill / sale value / tax in PKR, PaymentMode 2 cash · 1 card · 3 QR, PCT 9963.1100, items sum', () => {
    const f = toFbrInvoiceFields(cash)
    expect(f).toMatchObject({ POSID: 999, TotalBillAmount: 3335, TotalSaleValue: 2900, TotalTaxCharged: 435, Discount: 0, PaymentMode: 2, InvoiceType: 1, DateTime: '10102026143000', TotalQuantity: 3 })
    expect(f.Items.map((i) => [i.SaleValue, i.TaxCharged, i.TotalAmount, i.PCTCode, i.TaxRate])).toEqual([[1800, 270, 2070, '9963.1100', 15], [1100, 165, 1265, '9963.1100', 15]])
    expect(toFbrInvoiceFields(card).PaymentMode).toBe(1)
    expect(toFbrInvoiceFields({ ...card, payment: { mode: 'card', tenders: [{ method: 'keenu_qr', amountCents: 313_200 }] } }).PaymentMode).toBe(3)
    expect(toFbrInvoiceFields(discounted)).toMatchObject({ TotalSaleValue: 2750, Discount: 150, TotalTaxCharged: 412.5 })
    const r = buildRefundPayload(cash, { documentId: 'cn1', refundAmountCents: 333_500, issuedAt: new Date(), original: { fiscalNumber: 'FBR-ORIG', authority: 'fbr' } })
    expect(toFbrInvoiceFields(r)).toMatchObject({ InvoiceType: 3, TotalBillAmount: 3335, TotalTaxCharged: 435 })
    expect(toFbrInvoiceFields(r).Items[0]!.RefUSIN).toBe('FBR-ORIG')
  })
})
