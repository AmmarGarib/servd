// The sales tax return, finance wave B (H8–H13).
//
//   • Delivery charges (H9) are their own supply rows ('delivery_charge', at
//     the order's rate, the fee's stored GST); the item parts share the rest
//     of the order's tax — including the "no taxed item part" fallback, which
//     declares taxCents − deliveryFeeTaxCents as standard. 4110 is in taxable
//     sales, per brand.
//   • Kept no-show deposits (H10) are 'deposit_forfeit' rows (card rate, tax
//     inside), filed with the authority whose account the capture credited.
//   • Rows sort by authority, then SUPPLY_ORDER (every class listed).
//   • Sales tax withheld by customers (H13, 1335) nets THAT authority:
//     withheldByCustomersCents (reversals netted), netAfterWithheldCents, the
//     top-level net payable; set-offs and what is still available. Company
//     B's 1335 never shows in A's return.
//   • The return's payments are sales tax + withholding only (statutory
//     challans are listed only on request, labelled); the one-time statutory
//     reclass (Dr 2040) is not "withheld in the period"; the WHT row no longer
//     claims salaries.
//
// Requires a disposable database (DATABASE_URL must contain "test").
import { describe, it, expect, beforeAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { serviceClient as prisma } from '../src/lib/prisma.js'
import { ensureChartOfAccounts } from '../src/lib/chartOfAccounts.js'
import { postJournalEntry } from '../src/modules/accounting/journal.js'
import {
  salesTaxReturn, taxPaymentsFor, supplyParts, SUPPLY_ORDER, WITHHOLDING, AUTHORITIES, type ReturnOrder,
} from '../src/modules/accounting/salesTaxReturn.js'
import { AUTHORITIES as TABLE } from '../src/modules/accounting/taxAuthorities.js'
import { parsePktStartOfDay, parsePktEndOfDay } from '../src/modules/accounting/dates.js'

const RUN = Math.random().toString(36).slice(2, 8)
const pktIso = (d: Date) => new Date(d.getTime() + 5 * 3_600_000).toISOString().slice(0, 10)
const M2 = pktIso(new Date()).slice(0, 7)
const M1 = (() => {
  const [y, m] = M2.split('-').map(Number) as [number, number]
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`
})()
const lastDay = (month: string) => {
  const [y, m] = month.split('-').map(Number) as [number, number]
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`
}
const at = (iso: string) => new Date(`${iso}T10:00:00+05:00`)
const FROM = parsePktStartOfDay(`${M1}-01`)
const TO = parsePktEndOfDay(lastDay(M1))

let tenantA: string, tenantB: string, sdA: string, sdB: string
let invoiceA: string, invoiceB: string
let seq = 0

async function company(name: string) {
  const id = (await prisma.tenant.create({ data: { name, slug: `${name.toLowerCase().replace(/\W+/g, '-')}-${RUN}` } })).id
  await ensureChartOfAccounts(id)
  return id
}
const brand = async (tenantId: string, name: string) =>
  (await prisma.concept.create({ data: { name, slug: `st-${name.toLowerCase().replace(/\W+/g, '-')}-${RUN}`, type: 'restaurant', tenantId, province: 'SD', taxRateCash: 15, taxRateCard: 8 } })).id

async function post(tenantId: string, sourceType: string, sourceId: string, when: Date, lines: Array<{ accountCode: string; type: 'debit' | 'credit'; amountCents: number; conceptId?: string }>) {
  await postJournalEntry({ tenantId, sourceType, sourceId, description: sourceType, postedBy: 'test', entryDate: when, lines })
}

async function withheld(tenantId: string, invoiceId: string, authority: string, cents: number, when: Date, reversed = false) {
  const p = await prisma.receivablePayment.create({
    data: { tenantId, invoiceId, amountCents: cents, receivedAt: when, method: 'st_withheld', taxAuthority: authority, ...(reversed && { reversedAt: when }) },
  })
  await post(tenantId, 'receivable.st_withheld', p.id, when, [
    { accountCode: '1335', type: 'debit', amountCents: cents },
    { accountCode: '1110', type: 'credit', amountCents: cents },
  ])
  if (reversed) {
    await post(tenantId, 'receivable.st_withheld.reversal', p.id, when, [
      { accountCode: '1110', type: 'debit', amountCents: cents },
      { accountCode: '1335', type: 'credit', amountCents: cents },
    ])
  }
  return p.id
}

beforeAll(async () => {
  tenantA = await company('Return A')
  tenantB = await company('Return B')
  sdA = await brand(tenantA, 'A Karachi')
  sdB = await brand(tenantB, 'B Karachi')

  // A delivery order: food 100,000 at 15% (15,000) + a 20,000 fee with its own
  // 3,000 GST. The ledger: food to the brand's revenue, the fee to 4110.
  const o1 = await prisma.order.create({
    data: {
      conceptId: sdA, source: 'servd', status: 'completed', completedAt: at(`${M1}-10`), totalCents: 138_000,
      taxCents: 18_000, taxRatePct: 15, deliveryFeeCents: 20_000, deliveryFeeTaxCents: 3_000,
      items: { create: [{ name: 'Plate', quantity: 1, unitPriceCents: 100_000 }] },
    },
  })
  await post(tenantA, 'order.complete', o1.id, at(`${M1}-10`), [
    { accountCode: '1010', type: 'debit', amountCents: 138_000 },
    { accountCode: '4090', type: 'credit', amountCents: 100_000, conceptId: sdA },
    { accountCode: '4110', type: 'credit', amountCents: 20_000, conceptId: sdA },
    { accountCode: '2032', type: 'credit', amountCents: 18_000, conceptId: sdA },
  ])
  // A kept no-show deposit of 10,800 at the card rate (8%): 800 tax inside.
  await post(tenantA, 'reservation.deposit_capture', randomUUID(), at(`${M1}-12`), [
    { accountCode: '1030', type: 'debit', amountCents: 10_800, conceptId: sdA },
    { accountCode: '4090', type: 'credit', amountCents: 10_000, conceptId: sdA },
    { accountCode: '2032', type: 'credit', amountCents: 800, conceptId: sdA },
  ])

  // Corporate invoices, and what the clients withheld for SRB.
  const inv = (tenantId: string, conceptId: string, n: number) => prisma.receivableInvoice.create({
    data: { tenantId, conceptId, number: `AR-${RUN}-${n}`, customerName: 'Client', issueDate: at(`${M1}-02`), dueDate: at(`${M1}-28`), description: 'Catering', amountCents: 100_000, taxCents: 15_000 },
  })
  invoiceA = (await inv(tenantA, sdA, 1)).id
  invoiceB = (await inv(tenantB, sdB, 2)).id
  await withheld(tenantA, invoiceA, 'srb', 2_000, at(`${M1}-15`))
  await withheld(tenantA, invoiceA, 'srb', 500, at(`${M1}-16`), true) // reversed in the month — nets to 0
  await withheld(tenantB, invoiceB, 'srb', 700, at(`${M1}-15`))

  // 2040: 9,000 withheld from a vendor, and the one-time statutory reclass
  // moving 5,000 of legacy salary tax out of 2040 to 2042.
  await post(tenantA, 'test.vendor_wht', `${RUN}-${++seq}`, at(`${M1}-18`), [
    { accountCode: '6050', type: 'debit', amountCents: 9_000 },
    { accountCode: '2040', type: 'credit', amountCents: 9_000 },
  ])
  await post(tenantA, 'statutory.reclass', tenantA, at(`${M1}-20`), [
    { accountCode: '2040', type: 'debit', amountCents: 5_000 },
    { accountCode: '2042', type: 'credit', amountCents: 5_000 },
  ])

  // Payments recorded for M1: SRB (with 1,000 of the withheld tax set off) and an EOBI challan.
  const period = { periodFrom: FROM, periodTo: TO, paidAt: at(`${M1}-28`) }
  await prisma.salesTaxPayment.create({ data: { tenantId: tenantA, authority: 'srb', ...period, paidCents: 1_000, customerWithheldSetOffCents: 1_000 } })
  await prisma.salesTaxPayment.create({ data: { tenantId: tenantA, authority: 'eobi', ...period, paidCents: 4_000 } })
}, 60_000)

describe('one authority table', () => {
  it('re-exports THE table from taxAuthorities.ts', () => {
    expect(AUTHORITIES).toBe(TABLE)
    expect(AUTHORITIES.srb).toMatchObject({ label: 'SRB', outputCode: '2032', inputCode: '1322' })
  })
})

describe('supply parts (H9)', () => {
  const order = (over: Partial<ReturnOrder>): ReturnOrder => ({
    id: 'o', conceptId: 'c', status: 'completed', taxCents: 0, taxRatePct: 15, deliveryFeeCents: 0, deliveryFeeTaxCents: 0,
    concept: { slug: 's', tenantId: 't', province: 'SD', srbPosId: null, taxRateCash: 15, taxRateCard: 8 },
    items: [], ...over,
  })
  const item = (unitPriceCents: number, taxClassification: string) =>
    ({ unitPriceCents, quantity: 1, status: 'served', modifiers: [], menuItem: { taxClassification, overrideTaxRate: null } })

  it('the fee is its own part; the items share taxCents − the fee\'s GST', () => {
    const parts = supplyParts(order({ taxCents: 18_000, deliveryFeeCents: 20_000, deliveryFeeTaxCents: 3_000, items: [item(100_000, 'standard'), item(20_000, 'zero_rated')] }))
    expect(parts).toEqual([
      { supply: 'standard', ratePct: 15, valueCents: 100_000, taxCents: 15_000 },
      { supply: 'zero_rated', ratePct: 0, valueCents: 20_000, taxCents: 0 },
      { supply: 'delivery_charge', ratePct: 15, valueCents: 20_000, taxCents: 3_000 },
    ])
  })

  it('no taxed item part: the fallback declares taxCents − the fee\'s GST as standard, the fee keeps its own', () => {
    const parts = supplyParts(order({ taxCents: 9_000, deliveryFeeCents: 10_000, deliveryFeeTaxCents: 1_500, items: [item(50_000, 'exempt')] }))
    expect(parts).toEqual([
      { supply: 'standard', ratePct: 15, valueCents: 50_000, taxCents: 7_500 },
      { supply: 'delivery_charge', ratePct: 15, valueCents: 10_000, taxCents: 1_500 },
    ])
    // Untaxed items and an untaxed fee (a 0% order): nothing standard is invented.
    expect(supplyParts(order({ taxCents: 0, taxRatePct: 0, deliveryFeeCents: 5_000, items: [item(50_000, 'exempt')] }))).toEqual([
      { supply: 'exempt', ratePct: 0, valueCents: 50_000, taxCents: 0 },
      { supply: 'delivery_charge', ratePct: 0, valueCents: 5_000, taxCents: 0 },
    ])
  })

  it('SUPPLY_ORDER lists every class, the new ones last', () => {
    expect(SUPPLY_ORDER).toEqual(['standard', 'custom', 'zero_rated', 'exempt', 'delivery_charge', 'deposit_forfeit'])
  })
})

describe('the return (H8–H13)', () => {
  it('delivery_charge and deposit_forfeit rows, sorted; 4110 in taxable sales per brand', async () => {
    const r = await salesTaxReturn(tenantA, FROM, TO)
    const srb = r.byRate.filter((x) => x.authority === 'SRB')
    expect(srb.map((x) => x.supply)).toEqual(['standard', 'delivery_charge', 'deposit_forfeit'])
    expect(srb[0]).toMatchObject({ ratePct: 15, tender: 'cash', orders: 1, salesValueCents: 100_000, salesTaxCents: 15_000, taxCents: 15_000 })
    expect(srb[1]).toMatchObject({ supply: 'delivery_charge', ratePct: 15, tender: 'cash', orders: 1, salesValueCents: 20_000, salesTaxCents: 3_000, taxableValueCents: 20_000, taxCents: 3_000 })
    expect(srb[2]).toMatchObject({ supply: 'deposit_forfeit', ratePct: 8, tender: 'card', orders: 1, salesValueCents: 10_000, salesTaxCents: 800, taxCents: 800 })
    // Every bit of SRB output is explained by the rows.
    const a = r.byAuthority.find((x) => x.key === 'srb')!
    expect(a.output.totalCents).toBe(18_800)
    expect(a.otherOutputCents).toBe(0)
    // Taxable sales: brand revenue (food + kept deposit) plus the delivery fee.
    expect(r.deliveryFeesCents).toBe(20_000)
    expect(r.taxableValueByConceptCents).toEqual([expect.objectContaining({ conceptName: 'A Karachi', revenueCents: 110_000, deliveryFeeCents: 20_000 })])
    expect(r.taxableSalesCents).toBe(130_000)
    expect(r.notes.some((n) => n.includes('delivery_charge'))).toBe(true)
    expect(r.notes.some((n) => n.includes('deposit_forfeit'))).toBe(true)
  })

  it('withheld by customers nets SRB only; reversals net out; set-offs and what is left', async () => {
    const r = await salesTaxReturn(tenantA, FROM, TO)
    const srb = r.byAuthority.find((x) => x.key === 'srb')!
    expect(srb.withheldByCustomersCents).toBe(2_000)
    expect(srb.netPayableCents).toBe(18_800) // output − input, as before
    expect(srb.netAfterWithheldCents).toBe(16_800)
    expect(srb.customerWithheldSetOffForPeriodCents).toBe(1_000)
    expect(srb.customerWithheldAvailableCents).toBe(1_000) // 2,000 withheld − 1,000 set off
    expect(r.netPayableCents).toBe(16_800)
    // No authority but SRB is touched by it.
    expect(r.byAuthority.filter((x) => x.key !== 'srb').every((x) => x.withheldByCustomersCents === 0)).toBe(true)
  })

  it('company B\'s 1335 is absent from A\'s return, and B sees only its own', async () => {
    const a = await salesTaxReturn(tenantA, FROM, TO)
    expect(a.byAuthority.find((x) => x.key === 'srb')!.withheldByCustomersCents).toBe(2_000)
    const b = await salesTaxReturn(tenantB, FROM, TO)
    const srbB = b.byAuthority.find((x) => x.key === 'srb')!
    expect(srbB.withheldByCustomersCents).toBe(700)
    expect(srbB.customerWithheldAvailableCents).toBe(700)
    expect(srbB.netAfterWithheldCents).toBe(-700)
    expect(b.carryForwardCents).toBe(700)
    expect(b.byRate).toEqual([])
    expect(b.payments).toEqual([])
  })

  it('statutory challans are not in the return\'s payments (only on request, labelled)', async () => {
    const r = await salesTaxReturn(tenantA, FROM, TO)
    expect(r.payments.map((p) => p.authority)).toEqual(['srb'])
    expect(r.payments[0]).toMatchObject({ kind: 'sales_tax', paidCents: 1_000, customerWithheldSetOffCents: 1_000 })
    const all = await taxPaymentsFor(tenantA, FROM, TO, { statutory: true })
    expect(all.map((p) => [p.authority, p.kind]).sort()).toEqual([['eobi', 'statutory'], ['srb', 'sales_tax']])
  })

  it('the statutory reclass is not "withheld in the period"; the WHT row no longer claims salaries', async () => {
    const r = await salesTaxReturn(tenantA, FROM, TO)
    const wht = r.withholding.find((w) => w.key === 'wht')!
    expect(wht.account.totalCents).toBe(9_000)
    // The ledger balance still shows the move.
    expect(wht.ledgerBalanceAtEndCents).toBe(4_000)
    expect(WITHHOLDING.find((w) => w.key === 'wht')!.name).not.toMatch(/salar/i)
  })
})
