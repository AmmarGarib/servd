// The delivery fee on the fiscal document (owner 2026-10-13, H9).
//
// An order priced with the fee stores Order.deliveryFeeCents (before GST) and
// Order.deliveryFeeTaxCents (its GST, inside Order.taxCents). buildFiscalSaleTx
// makes the fee a TAXED LINE — lineId 'delivery:<orderId>', itemCode
// 'DELIVERY-CHARGE', the order's standard rate, its stored GST — and
// totals.deliveryChargeCents is 0. The discount covers the food first, then the
// fee line, then billDiscount. A legacy delivery (fee 0 stored, fee untaxed in
// the total) keeps the remainder rule. totalsCheck and the refund payload are
// unchanged and add up. The FBR reference mapping gives the fee ItemCode
// 'DELIVERY'.
//
// Two companies: a document is the order's company's; B never lists A's.
// Requires a disposable database (DATABASE_URL must contain "test").
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { randomBytes } from 'node:crypto'
import { prisma, mkCompany, mkUser, mkOrder, buildApp, caller, setConnector, resetConnectorCache, TEST_SECRET_KEY, type Company, type Who } from './connectorsFixtures.js'
import {
  buildFiscalSaleTx, buildRefundPayload, totalsCheck, totalsOf, toFbrInvoiceFields, toSrbInvoiceFields,
  DELIVERY_CHARGE_ITEM_CODE, deliveryLineId,
} from '../src/connectors/fiscal/payload.js'
import { enqueueFiscalSaleTx, setFiscalKicker } from '../src/connectors/fiscal/outbox.js'
import { DEFAULT_FISCAL_SETTINGS } from '../src/connectors/config.js'
import type { FiscalPayload } from '../src/connectors/types.js'

let A: Company, B: Company
let app: FastifyInstance
let call: ReturnType<typeof caller>
const u: Record<string, Who> = {}
let prevKey: string | undefined

const build = (orderId: string) =>
  prisma.$transaction((tx) => buildFiscalSaleTx(tx, orderId, `doc_${randomBytes(4).toString('hex')}`, DEFAULT_FISCAL_SETTINGS))

/**
 * A storefront delivery as ingestOrder stores it (H9): Kheer PKR 550 a cup,
 * GST at `rate` on the food, fee 15,000 + its GST at the same rate.
 */
async function delivery(co: Company, opts: { qty?: number; rate?: 15 | 8; discountCents?: number; method?: 'cash' | 'card'; pending?: boolean; tipCents?: number } = {}) {
  const qty = opts.qty ?? 2
  const rate = opts.rate ?? 15
  const food = 55_000 * qty
  const itemTax = Math.round((food * rate) / 100)
  const fee = 15_000
  const feeTax = Math.round((fee * rate) / 100)
  const discount = opts.discountCents ?? 0
  const tip = opts.tipCents ?? 0
  const total = Math.max(0, food + itemTax - discount + fee + feeTax) + tip
  const id = await mkOrder(co, {
    items: [{ menuItemId: co.items.kheer, name: 'Kheer', quantity: qty, unitPriceCents: 55_000 }],
    taxCents: itemTax + feeTax, taxRatePct: rate, discountCents: discount, tipCents: tip, totalCents: total,
    payments: total > 0 ? [{ method: opts.method ?? 'cash', amountCents: total, status: opts.pending ? 'pending' : 'paid' }] : [],
  })
  await prisma.order.update({ where: { id }, data: { source: 'servd', fulfilmentType: 'delivery', deliveryFeeCents: fee, deliveryFeeTaxCents: feeTax } })
  return { id, total, food, itemTax, fee, feeTax }
}

function sumOf(p: FiscalPayload): number {
  const t = totalsOf(p)
  return p.lines.reduce((s, l) => s + l.taxableCents, 0) + t.taxCents + t.serviceChargeCents + t.tipCents + (t.deliveryChargeCents ?? 0) - (t.billDiscountCents ?? 0)
}

beforeAll(async () => {
  prevKey = process.env['SERVD_SECRET_KEY']
  process.env['SERVD_SECRET_KEY'] = TEST_SECRET_KEY
  setFiscalKicker(async () => {})
  A = await mkCompany('fdl-a', { srbPosId: 6101, fbrPosId: 6102 })
  B = await mkCompany('fdl-b', { srbPosId: 6201 })
  u['adminA'] = await mkUser('fdlAdminA', 'admin', A.tenantId)
  u['adminB'] = await mkUser('fdlAdminB', 'admin', B.tenantId)
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

describe('the fee is a taxed DELIVERY-CHARGE line', () => {
  it('COD cash 15 %: the food lines carry the food GST, the fee line its own GST; deliveryChargeCents 0; it adds up', async () => {
    const o = await delivery(A, { tipCents: 10_000, pending: true })
    const b = await build(o.id)
    expect(b.check.ok, b.check.problems.join('; ')).toBe(true)
    const t = totalsOf(b.payload)
    expect(t).toMatchObject({
      saleValueCents: o.food + o.fee, discountCents: 0, taxCents: o.itemTax + o.feeTax, taxRatePct: 15,
      tipCents: 10_000, deliveryChargeCents: 0, totalCents: o.total,
    })
    expect(t.billDiscountCents).toBeUndefined()
    const fee = b.payload.lines.find((l) => l.itemCode === DELIVERY_CHARGE_ITEM_CODE)!
    expect(fee).toEqual({
      lineId: deliveryLineId(o.id), itemCode: 'DELIVERY-CHARGE', description: 'Delivery charge', quantity: 1,
      unitPriceCents: 15_000, grossCents: 15_000, discountCents: 0, taxableCents: 15_000, taxRatePct: 15, taxCents: 2_250,
    })
    const food = b.payload.lines.filter((l) => l.itemCode !== DELIVERY_CHARGE_ITEM_CODE)
    expect(food.reduce((s, l) => s + l.taxCents, 0)).toBe(o.itemTax)
    expect(sumOf(b.payload)).toBe(o.total)

    const fbr = toFbrInvoiceFields(b.payload)
    expect(fbr.Items.map((i) => i.ItemCode)).toEqual(['POS-ITEM', 'DELIVERY'])
    expect(fbr.Items[1]).toMatchObject({ PCTCode: '9963.1100', TaxRate: 15, SaleValue: 150, TaxCharged: 22.5 })
    expect(fbr.TotalTaxCharged).toBe((o.itemTax + o.feeTax) / 100)
    // SRB: the fee is in the sale value, taxed at the order's rate.
    const srb = toSrbInvoiceFields(b.payload)
    expect(srb.saleValue).toBe((o.food + o.fee) / 100)
    expect(srb.taxAmount).toBe(((o.food + o.fee) * 0.15) / 100)
  })

  it('paid online at 8 %: the fee line is at the order\'s 8 %', async () => {
    const o = await delivery(A, { rate: 8, method: 'card' })
    const b = await build(o.id)
    expect(b.check.ok, b.check.problems.join('; ')).toBe(true)
    expect(b.payload.lines.find((l) => l.itemCode === DELIVERY_CHARGE_ITEM_CODE)).toMatchObject({ taxRatePct: 8, taxCents: 1_200, taxableCents: 15_000 })
    expect(b.payload.payment.mode).toBe('card')
  })

  it('a discount covers the food first, then the fee line; loyalty beyond both is billDiscount — totalsCheck holds', async () => {
    // 55,000 + 8,250 + 15,000 + 2,250 = 80,500. 70,000 off: the food 55,000, the fee 15,000.
    const o = await delivery(A, { qty: 1, discountCents: 70_000 })
    const b = await build(o.id)
    expect(b.check.ok, b.check.problems.join('; ')).toBe(true)
    const t = totalsOf(b.payload)
    expect(t).toMatchObject({ saleValueCents: 70_000, discountCents: 70_000, taxableCents: 0, taxCents: 10_500, deliveryChargeCents: 0, totalCents: 10_500 })
    expect(t.billDiscountCents).toBeUndefined()
    expect(b.payload.lines.find((l) => l.itemCode === DELIVERY_CHARGE_ITEM_CODE)).toMatchObject({ discountCents: 15_000, taxableCents: 0, taxCents: 2_250 })

    // 75,000 off: 5,000 above the food and the fee comes off after the tax.
    const o2 = await delivery(A, { qty: 1, discountCents: 75_000 })
    const b2 = await build(o2.id)
    expect(b2.check.ok, b2.check.problems.join('; ')).toBe(true)
    expect(totalsOf(b2.payload)).toMatchObject({ discountCents: 70_000, billDiscountCents: 5_000, taxCents: 10_500, totalCents: 5_500 })
    expect(sumOf(b2.payload)).toBe(5_500)
  })

  it('a refund payload of a sale with a fee line sums exactly, its fee line keeps its code; a full refund mirrors the sale', async () => {
    const o = await delivery(A, { tipCents: 10_000 })
    const sale = (await build(o.id)).payload
    for (const amount of [1, 999, 12_345, 50_000, o.total - 1, o.total]) {
      const r = buildRefundPayload(sale, { documentId: `r-${amount}`, refundAmountCents: amount, issuedAt: new Date(), original: null })
      expect(totalsCheck(r).ok, `${amount}: ${totalsCheck(r).problems.join('; ')}`).toBe(true)
      expect(r.totals.totalCents).toBe(amount)
      expect(totalsOf(r).deliveryChargeCents).toBe(0)
    }
    const full = buildRefundPayload(sale, { documentId: 'r-full', refundAmountCents: o.total, issuedAt: new Date(), original: null })
    expect(totalsOf(full)).toMatchObject({ saleValueCents: o.food + o.fee, taxCents: o.itemTax + o.feeTax, tipCents: 10_000, totalCents: o.total })
    expect(full.lines.find((l) => l.itemCode === DELIVERY_CHARGE_ITEM_CODE)).toMatchObject({ taxableCents: 15_000, taxCents: 2_250, taxRatePct: 15 })
    expect(toFbrInvoiceFields(full).Items.map((i) => i.ItemCode)).toContain('DELIVERY')
    // A known tip share (a voided line's refund) still adds up.
    const noTip = buildRefundPayload(sale, { documentId: 'r-notip', refundAmountCents: 40_000, issuedAt: new Date(), original: null, tipShareCents: 0 })
    expect(totalsCheck(noTip).ok).toBe(true)
  })

  it('a LEGACY delivery (no fee columns) keeps the untaxed remainder rule', async () => {
    // 5 × Kheer 275,000 + GST 41,250 + an untaxed fee 15,000 inside the total.
    const id = await mkOrder(A, {
      items: [{ menuItemId: A.items.kheer, name: 'Kheer', quantity: 5, unitPriceCents: 55_000 }],
      taxCents: 41_250, taxRatePct: 15, totalCents: 331_250, payments: [{ method: 'cash', amountCents: 331_250, status: 'pending' }],
    })
    await prisma.order.update({ where: { id }, data: { source: 'servd', fulfilmentType: 'delivery' } })
    const b = await build(id)
    expect(b.check.ok).toBe(true)
    expect(totalsOf(b.payload)).toMatchObject({ saleValueCents: 275_000, deliveryChargeCents: 15_000, totalCents: 331_250 })
    expect(b.payload.lines.some((l) => l.itemCode === DELIVERY_CHARGE_ITEM_CODE)).toBe(false)
  })

  it('a takeout carries no fee line', async () => {
    const id = await mkOrder(A, {
      items: [{ menuItemId: A.items.kheer, name: 'Kheer', quantity: 1, unitPriceCents: 55_000 }],
      taxCents: 8_250, taxRatePct: 15, totalCents: 63_250, payments: [{ method: 'cash', amountCents: 63_250 }],
    })
    const b = await build(id)
    expect(b.check.ok).toBe(true)
    expect(b.payload.lines).toHaveLength(1)
    expect(totalsOf(b.payload).deliveryChargeCents).toBe(0)
  })
})

describe('two companies: the document is the order\'s company\'s', () => {
  it('A\'s delivery sale is queued in A with its fee line; B never lists it', async () => {
    await setConnector(A.tenantId, 'fiscal', { driver: 'none', enabled: false })
    const o = await delivery(A)
    const doc = await prisma.$transaction((tx) => enqueueFiscalSaleTx(tx, { orderId: o.id, tenantId: A.tenantId }))
    expect(doc?.status).toBe('held')
    const row = await prisma.fiscalDocument.findUniqueOrThrow({ where: { id: doc!.id } })
    expect(row.tenantId).toBe(A.tenantId)
    expect(row.amountCents).toBe(o.total)
    const p = row.payload as unknown as FiscalPayload
    expect(p.lines.map((l) => l.itemCode)).toContain('DELIVERY-CHARGE')
    expect(totalsCheck(p).ok).toBe(true)

    const listA = (await call(u['adminA']!, 'GET', '/connectors/fiscal/documents?status=held')).json() as { items: Array<{ id: string }> }
    expect(listA.items.map((x) => x.id)).toContain(doc!.id)
    const listB = (await call(u['adminB']!, 'GET', '/connectors/fiscal/documents?status=held')).json() as { items: Array<{ id: string }> }
    expect(listB.items.map((x) => x.id)).not.toContain(doc!.id)
  })
})
