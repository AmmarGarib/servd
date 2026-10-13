// Sales tax return — the figures a company files with each tax authority for
// a period: FBR (federal sales tax on goods, 2030 / 1320) and the provincial
// authorities that tax restaurant SERVICES — SRB for Sindh (2032 / 1322), PRA,
// KPRA, BRA. Operators still file through the authority's portal (IRIS for
// FBR, SRB's e-filing for Sindh); this report tells them what to enter.
//
// What it gives (BOOKS-10):
//   • byAuthority — each authority's output and input tax from the ledger, and
//     its OWN net. Input tax is set off only against the same authority's
//     output: federal input on goods (1320) is never netted against Sindh
//     output on services — those are two returns with two authorities. The
//     top-level netPayableCents is what is payable across them (no
//     authority's credit reduces another's bill); carryForwardCents is any
//     authority's excess input. Each row also shows what was PAID for the
//     period (the payments register, taxPayments.ts) and the output account's
//     ledger balance at the period's end.
//   • byRate — per authority, per supply class and rate (15% cash / 8% card —
//     Order.taxRatePct, owner decision 9; zero-rated / exempt / custom lines by
//     the item's tax class), the taxable value and the tax: sales booked in
//     the period less refunds booked in the period. Sales are the orders the
//     ledger booked ('order.complete' entries, and the till orders each
//     'shift.close' entry booked); refunds are the tax the refund entries
//     actually debited. The value is the pre-discount item value (GST is
//     charged before a discount — SRB POS rule).
//   • reclassification — output tax still sitting in 2030 for a brand whose
//     authority is provincial (booked before sales were routed by province):
//     POST /accounting/sales-tax-return/reclass moves it (Dr 2030 / Cr the
//     authority's account, dated in the sales' month — taxPayments.ts).
//   Sales and refunds are filed under the authority whose account the entry
//   actually credited / debited — a refund of a pre-routing sale debits 2030
//   like its sale (orderPosting.ts refundTaxAccountFor), so both sit with FBR
//   until the reclass moves them; a sale of a brand-month that was reclassed
//   is filed with the account the reclass moved it to.
//
// Output and input are what was CHARGED and RECOVERED in the period: the
// entries that SETTLE tax — payments posted here ('salestax.payment:…' and
// their reversals) and manual / reconciliation entries linked as a payment —
// are left out, so paying last month's SRB in this month never lowers this
// month's output (finance gap 6).
//
// Caveats:
//   1. Supplies are classed by each item's CURRENT tax class (MenuItem.
//      taxClassification — what priceOrder charges); there is no snapshot on
//      the order line. A bill that carried tax although none of its lines is
//      taxed today is declared as standard-rated. Adjust with your CA.
//   2. The return is ONE company's (the caller passes the active company).
//   3. The return needs to be signed and filed by a person — never auto-file.

import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { ACCT, revenueCodeForConcept } from './journal.js'
import { fmtPktDate } from './dates.js'
import { homeShiftOf, outputTaxCodeFor } from './orderPosting.js'
import { sumCents, toCents } from '../../lib/money.js'

type Db = Prisma.TransactionClient

/** Journal source of a tax payment posted from the return: 'salestax.payment:<SalesTaxPayment.id>'. */
export const TAX_PAYMENT_SOURCE = 'salestax.payment'
/** The one-off move of a provincial brand's output tax out of 2030: 'salestax.reclass:<conceptId>:<YYYY-MM>[:n]'. */
export const TAX_RECLASS_SOURCE = 'salestax.reclass'
/** Entries that are payments by reference: the posting and its reversal ('salestax.payment.reversal:<id>'). */
const PAYMENT_REF_PREFIXES = [`${TAX_PAYMENT_SOURCE}:`, `${TAX_PAYMENT_SOURCE}.reversal:`]

interface AccountTotal {
  code: string
  name: string
  totalCents: number   // natural balance in the account's normal direction
}

/**
 * The entries that SETTLE tax rather than charge or recover it, as a filter
 * that leaves them out: the payments posted here (by reference) and the
 * manual / reconciliation entries linked as a payment (by id).
 */
async function notSettlement(db: Db, tenantIds: string[], from: Date, to: Date): Promise<Prisma.JournalEntryWhereInput> {
  const linked = await db.salesTaxPayment.findMany({
    where: { tenantId: { in: tenantIds }, linked: true, journalEntryId: { not: null }, paidAt: { gte: from, lte: to } },
    select: { journalEntryId: true },
  })
  const ids = linked.map((l) => l.journalEntryId).filter((x): x is string => !!x)
  return {
    AND: [
      { OR: [{ reference: null }, { NOT: PAYMENT_REF_PREFIXES.map((p) => ({ reference: { startsWith: p } })) }] },
      ...(ids.length > 0 ? [{ id: { notIn: ids } }] : []),
    ],
  }
}

async function netCreditCents(
  tenantId: string,
  accountCode: string,
  from: Date,
  to: Date,
  exclude: Prisma.JournalEntryWhereInput,
): Promise<number> {
  // The return is filed by ONE company, against its own chart of accounts.
  const account = await prisma.account.findFirst({ where: { tenantId, code: accountCode } })
  if (!account) return 0
  const sums = await prisma.journalLine.groupBy({
    by: ['type'],
    _sum: { amountCents: true },
    where: {
      accountId: account.id,
      journalEntry: { tenantId, entryDate: { gte: from, lte: to }, AND: [exclude] },
    },
  })
  let debit = 0, credit = 0
  for (const s of sums) {
    if (s.type === 'debit') debit  = sumCents(s._sum.amountCents)
    else                     credit = sumCents(s._sum.amountCents)
  }
  return credit - debit
}

/** Credit − debit of each code in `tenantId`'s chart, over every entry up to `asOf`. */
async function creditBalancesAt(db: Db, tenantId: string, codes: string[], asOf: Date): Promise<Map<string, number>> {
  const out = new Map<string, number>(codes.map((c) => [c, 0]))
  const accounts = await db.account.findMany({ where: { tenantId, code: { in: codes } }, select: { id: true, code: true } })
  if (accounts.length === 0) return out
  const sums = await db.journalLine.groupBy({
    by: ['accountId', 'type'],
    _sum: { amountCents: true },
    where: { accountId: { in: accounts.map((a) => a.id) }, journalEntry: { tenantId, entryDate: { lte: asOf } } },
  })
  const codeOf = new Map(accounts.map((a) => [a.id, a.code]))
  for (const s of sums) {
    const code = codeOf.get(s.accountId)
    if (!code) continue
    const amt = sumCents(s._sum.amountCents)
    out.set(code, (out.get(code) ?? 0) + (s.type === 'credit' ? amt : -amt))
  }
  return out
}

/** The ledger balance of one account at `asOf`: debit − credit (an asset). */
export async function debitBalanceAt(db: Db, tenantId: string, code: string, asOf: Date): Promise<number> {
  return 0 - ((await creditBalancesAt(db, tenantId, [code], asOf)).get(code) ?? 0)
}

export type AuthorityKey = 'fbr' | 'pra' | 'srb' | 'kpra' | 'bra'

/** Each authority: its output (payable) and input (recoverable) accounts. */
export const AUTHORITIES: Array<{ key: AuthorityKey; authority: string; name: string; output: string; input: string }> = [
  { key: 'fbr',  authority: 'FBR',  name: 'Federal Board of Revenue',              output: ACCT.GST_OUTPUT,      input: ACCT.GST_INPUT },
  { key: 'pra',  authority: 'PRA',  name: 'Punjab Revenue Authority',              output: ACCT.PRA_TAX_OUTPUT,  input: '1321' },
  { key: 'srb',  authority: 'SRB',  name: 'Sindh Revenue Board',                   output: ACCT.SRB_TAX_OUTPUT,  input: '1322' },
  { key: 'kpra', authority: 'KPRA', name: 'Khyber Pakhtunkhwa Revenue Authority',  output: ACCT.KPRA_TAX_OUTPUT, input: '1323' },
  { key: 'bra',  authority: 'BRA',  name: 'Balochistan Revenue Authority',         output: ACCT.BRA_TAX_OUTPUT,  input: '1324' },
]
const authorityOfOutput = (code: string) => AUTHORITIES.find((a) => a.output === code) ?? AUTHORITIES[0]!

export type WithholdingKey = 'wht' | 'stwh'

/**
 * Tax the company withholds from others and pays over: income tax withheld
 * from suppliers (and salaries) — 2040, paid to FBR; sales tax withheld as a
 * withholding agent — 2041. Paid from the return like sales tax, never set
 * off against input.
 */
export const WITHHOLDING: Array<{ key: WithholdingKey; authority: string; name: string; account: string }> = [
  { key: 'wht',  authority: 'WHT',  name: 'Income tax withheld (paid to FBR)', account: ACCT.WHT_PAYABLE },
  { key: 'stwh', authority: 'STWH', name: 'Sales tax withheld (as withholding agent)', account: ACCT.STWH_PAYABLE },
]

export interface AuthorityReturn {
  key: AuthorityKey
  authority: string
  name: string
  output: AccountTotal
  input: AccountTotal
  /** output − input of THIS authority. Negative = excess input to carry forward with it. */
  netPayableCents: number
  /** Brands whose sales tax is owed to this authority. */
  brands: string[]
  /** Output tax in the ledger NOT explained by the period's order sales and refunds (manual journals, B2B invoices, older entries). */
  otherOutputCents: number
  /** Paid in cash to this authority for a period overlapping this one (the payments register). */
  paidForPeriodCents: number
  /** Input tax set off in those payments. */
  inputSetOffForPeriodCents: number
  /** The output account's balance (still owed) at the period's end, after every charge and payment up to then. */
  ledgerBalanceAtEndCents: number
  /** The input account's balance (still recoverable) at the period's end. */
  inputLedgerBalanceAtEndCents: number
}

export interface WithholdingReturn {
  key: WithholdingKey
  authority: string
  name: string
  /** Withheld in the period (credits less debits, payments left out). */
  account: AccountTotal
  paidForPeriodCents: number
  ledgerBalanceAtEndCents: number
}

export type SupplyClass = 'standard' | 'zero_rated' | 'exempt' | 'custom'

export interface RateLine {
  authority: string
  /** The item tax class: standard lines at the order's rate, custom at the item's own, zero-rated / exempt at 0%. */
  supply: SupplyClass
  /** Order.taxRatePct (standard), the item's rate (custom), 0 (zero-rated / exempt); null = an order priced before the rate was stored. */
  ratePct: number | null
  /** Which of the brand's two rates the order was billed at (cash 15% / card 8%). */
  tender: 'cash' | 'card' | 'other'
  orders: number
  salesValueCents: number
  salesTaxCents: number
  refundValueCents: number
  refundTaxCents: number
  /** Value of supplies to declare: sales − refunds. */
  taxableValueCents: number
  /** Output tax to declare at this rate: sales − refunds. */
  taxCents: number
}

export interface TaxPaymentRow {
  id: string
  authority: AuthorityKey | WithholdingKey
  periodFrom: string
  periodTo: string
  paidAt: string
  paidCents: number
  inputSetOffCents: number
  outputSetOffCents: number
  cprNumber: string | null
  bankAccountId: string | null
  bankAccountName: string | null
  journalEntryId: string | null
  /** True = an existing manual / reconciliation entry linked, not posted here. */
  linked: boolean
  notes: string | null
  createdAt: string
}

export interface ReclassRow {
  conceptId: string
  conceptSlug: string
  conceptName: string
  fromAccount: string
  toAccount: string
  amountCents: number
}

export interface SalesTaxReturnReport {
  /** The filing company. */
  tenantId: string
  period: { from: string; to: string }
  outputTax: {
    fbr: AccountTotal
    pra: AccountTotal
    srb: AccountTotal
    kpra: AccountTotal
    bra: AccountTotal
    totalCents: number
  }
  inputTax: {
    fbr: AccountTotal
    pra: AccountTotal
    srb: AccountTotal
    kpra: AccountTotal
    bra: AccountTotal
    totalCents: number
  }
  byAuthority: AuthorityReturn[]
  byRate: RateLine[]
  reclassification: ReclassRow[]
  /** Reclass entries dated in the period (already posted). */
  reclassesPosted: Array<{ conceptId: string; conceptName: string; month: string; reference: string; entryDate: string; fromAccount: string; toAccount: string; amountCents: number }>
  withholding: WithholdingReturn[]
  /** Payments whose period overlaps this one. */
  payments: TaxPaymentRow[]
  taxableSalesCents: number    // sum of all per-concept revenue
  taxableValueByConceptCents: Array<{ conceptSlug: string; conceptName: string; revenueCents: number }>
  /** What is payable: each authority's own net, summed where positive — never one authority's input against another's output. */
  netPayableCents: number
  /** Excess input tax per authority, carried forward with that authority (not a reduction of another's bill). */
  carryForwardCents: number
  notes: string[]              // operator-facing caveats
}

/** Every output sales-tax account the return files: FBR 2030 + PRA/SRB/KPRA/BRA. */
export const OUTPUT_TAX_CODES: string[] = AUTHORITIES.map((a) => a.output)

/**
 * Sales tax collected in the period, from the ledger — the output accounts the
 * return files, net of reversals, leaving out tax PAID to the authorities
 * (payments posted from the return and entries linked as payments). This is
 * the figure the CEO "Tax collected" card shows; it used to show the sales
 * register's taxCents, which missed POS card sales and refunds and used
 * payment timing, so it never matched the return. `tenantIds` is the company
 * scope (a return itself is one company).
 */
export async function outputTaxCollectedCents(tenantIds: string[], from: Date, to: Date): Promise<number> {
  if (tenantIds.length === 0) return 0
  const accounts = await prisma.account.findMany({
    where: { tenantId: { in: tenantIds }, code: { in: OUTPUT_TAX_CODES } },
    select: { id: true },
  })
  if (accounts.length === 0) return 0
  const exclude = await notSettlement(prisma, tenantIds, from, to)
  const sums = await prisma.journalLine.groupBy({
    by: ['type'],
    _sum: { amountCents: true },
    where: {
      accountId: { in: accounts.map((a) => a.id) },
      journalEntry: { tenantId: { in: tenantIds }, entryDate: { gte: from, lte: to }, AND: [exclude] },
    },
  })
  const credit = sumCents(sums.find((x) => x.type === 'credit')?._sum.amountCents)
  const debit  = sumCents(sums.find((x) => x.type === 'debit')?._sum.amountCents)
  return credit - debit
}

// ─── Per-rate breakdown ─────────────────────────────────────────────────────

const ORDER_FOR_RETURN = {
  id: true, status: true, source: true, conceptId: true, taxCents: true, taxRatePct: true,
  concept: { select: { slug: true, tenantId: true, province: true, srbPosId: true, taxRateCash: true, taxRateCard: true } },
  items: {
    select: {
      unitPriceCents: true, quantity: true, status: true,
      modifiers: { select: { priceDeltaCents: true } },
      menuItem: { select: { taxClassification: true, overrideTaxRate: true } },
    },
  },
} as const

interface ReturnOrder {
  id: string
  conceptId: string
  status: string
  taxCents: number
  taxRatePct: number | null
  concept: { slug: string; tenantId: string | null; province: string | null; srbPosId: number | null; taxRateCash: number; taxRateCard: number }
  items: Array<{
    unitPriceCents: number; quantity: number; status: string
    modifiers: Array<{ priceDeltaCents: number }>
    menuItem: { taxClassification: string; overrideTaxRate: number | null } | null
  }>
}

interface SupplyPart {
  supply: SupplyClass
  ratePct: number | null
  valueCents: number
  /** The order's stored tax that falls on this part. */
  taxCents: number
}

/** Share `total` over `parts` in proportion to `weight`; the rounding remainder goes to the heaviest. */
function shareOut<T extends { weight: number }>(total: number, parts: T[], set: (p: T, cents: number) => void): void {
  const sum = parts.reduce((t, p) => t + p.weight, 0)
  if (parts.length === 0 || sum <= 0) return
  let given = 0
  let heaviest = parts[0]!
  for (const p of parts) {
    const cents = Math.round(total * (p.weight / sum))
    set(p, cents)
    given += cents
    if (p.weight > heaviest.weight) heaviest = p
  }
  if (given !== total) set(heaviest, Math.round(total * (heaviest.weight / sum)) + (total - given))
}

/**
 * An order's supplies by tax class (MenuItem.taxClassification — the class
 * priceOrder charged): standard lines at the order's rate, custom lines at the
 * item's own rate, zero-rated and exempt lines at 0%. The order's STORED tax
 * is shared over the taxed parts in proportion to the tax each would bear, so
 * the parts always add up to what the ledger booked. A bill that carried tax
 * although none of its lines is taxed today (an item reclassified after the
 * sale) is declared as standard-rated: tax was charged, so it is output.
 */
function supplyParts(o: ReturnOrder): SupplyPart[] {
  const parts = new Map<string, SupplyPart & { weight: number }>()
  for (const i of o.items) {
    if (i.status === 'voided') continue
    const value = (i.unitPriceCents + i.modifiers.reduce((m, x) => m + x.priceDeltaCents, 0)) * i.quantity
    const cls = i.menuItem?.taxClassification
    const supply: SupplyClass = cls === 'zero_rated' || cls === 'exempt' || cls === 'custom' ? cls : 'standard'
    const ratePct = supply === 'standard' ? o.taxRatePct : supply === 'custom' ? (i.menuItem?.overrideTaxRate ?? 0) : 0
    const key = `${supply}|${ratePct ?? 'null'}`
    let p = parts.get(key)
    if (!p) {
      p = { supply, ratePct, valueCents: 0, taxCents: 0, weight: 0 }
      parts.set(key, p)
    }
    p.valueCents += value
  }
  const list = [...parts.values()]
  // An order priced before its rate was stored: weigh its standard lines at the brand's cash rate.
  const standardRate = o.taxRatePct ?? o.concept.taxRateCash
  for (const p of list) {
    const rate = p.supply === 'standard' ? standardRate : (p.ratePct ?? 0)
    p.weight = rate > 0 && p.valueCents > 0 ? p.valueCents * rate : 0
  }
  const taxed = list.filter((p) => p.weight > 0)
  if (taxed.length === 0) {
    if (o.taxCents === 0) return list.map(({ weight: _w, ...p }) => p)
    const valueCents = list.reduce((t, p) => t + p.valueCents, 0)
    return [{ supply: 'standard', ratePct: o.taxRatePct, valueCents, taxCents: o.taxCents }]
  }
  shareOut(o.taxCents, taxed, (p, cents) => { p.taxCents = cents })
  return list.map(({ weight: _w, ...p }) => p)
}

function tenderOfRate(o: ReturnOrder): RateLine['tender'] {
  if (o.taxRatePct == null) return 'other'
  if (o.taxRatePct === o.concept.taxRateCash) return 'cash'
  if (o.taxRatePct === o.concept.taxRateCard) return 'card'
  return 'other'
}

/** YYYY-MM of an instant, Pakistan time — the month a return files it in. */
export function pktMonthOf(d: Date): string {
  return fmtPktDate(d).slice(0, 7)
}

/** 'salestax.reclass:<conceptId>:<YYYY-MM>[:n]' → its brand and month. */
function parseReclassRef(ref: string | null): { conceptId: string; month: string } | null {
  if (!ref?.startsWith(`${TAX_RECLASS_SOURCE}:`)) return null
  const [conceptId, month] = ref.slice(TAX_RECLASS_SOURCE.length + 1).split(':')
  return conceptId && month && /^\d{4}-\d{2}$/.test(month) ? { conceptId, month } : null
}

/**
 * The reclasses dated in [from, to]: per brand and month, the authority
 * account its 2030 tax was moved to, and the entries themselves.
 */
async function reclassesIn(tenantId: string, from: Date, to: Date) {
  const entries = await prisma.journalEntry.findMany({
    where: { tenantId, entryDate: { gte: from, lte: to }, reference: { startsWith: `${TAX_RECLASS_SOURCE}:` } },
    select: { reference: true, entryDate: true, lines: { select: { type: true, amountCents: true, account: { select: { code: true } } } } },
    orderBy: { entryDate: 'asc' },
  })
  const target = new Map<string, string>() // `${conceptId}|${YYYY-MM}` → account
  const posted: Array<{ conceptId: string; month: string; reference: string; entryDate: Date; fromAccount: string; toAccount: string; amountCents: number }> = []
  for (const e of entries) {
    const parsed = parseReclassRef(e.reference)
    const other = e.lines.find((l) => l.account.code !== ACCT.GST_OUTPUT && OUTPUT_TAX_CODES.includes(l.account.code))
    const gst = e.lines.find((l) => l.account.code === ACCT.GST_OUTPUT)
    if (!parsed || !other || !gst) continue
    target.set(`${parsed.conceptId}|${parsed.month}`, other.account.code)
    posted.push({
      ...parsed, reference: e.reference!, entryDate: e.entryDate, fromAccount: ACCT.GST_OUTPUT, toAccount: other.account.code,
      // Positive = moved out of 2030 (Dr 2030); negative = a refund's share moved back.
      amountCents: gst.type === 'debit' ? toCents(gst.amountCents) : -toCents(gst.amountCents),
    })
  }
  return { target, posted }
}

/**
 * Sales and refunds the ledger booked for `tenantId` in [from, to], per
 * authority, supply class and rate. Sales come from the orders behind the
 * period's 'order.complete' and 'shift.close' entries; refunds from the
 * output-tax debits on the period's refund entries.
 */
async function rateBreakdown(tenantId: string, from: Date, to: Date, reclassTarget: Map<string, string>): Promise<RateLine[]> {
  const entries = await prisma.journalEntry.findMany({
    where: {
      tenantId,
      entryDate: { gte: from, lte: to },
      OR: [
        { reference: { startsWith: 'order.complete:' } },
        { reference: { startsWith: 'shift.close:' } },
        { reference: { startsWith: 'order.refund:' } },
        { reference: { startsWith: 'order.refund_wallet:' } },
        { reference: { startsWith: 'order.refund_giftcard:' } },
      ],
    },
    select: { id: true, reference: true, entryDate: true },
  })
  const idOf = (ref: string | null, prefix: string) => (ref?.startsWith(prefix) ? ref.slice(prefix.length) : null)
  const completeIds = entries.map((e) => idOf(e.reference, 'order.complete:')).filter((x): x is string => !!x)
  const shiftIds = new Set(entries.map((e) => idOf(e.reference, 'shift.close:')).filter((x): x is string => !!x))
  // When each sale was booked — the month a reclass of its brand covers.
  const saleDate = new Map<string, Date>()   // orderId → its order.complete entry's date
  const shiftDate = new Map<string, Date>()  // shiftId → its shift.close entry's date
  for (const e of entries) {
    const oid = idOf(e.reference, 'order.complete:')
    const sid = idOf(e.reference, 'shift.close:')
    if (oid) saleDate.set(oid, e.entryDate)
    if (sid) shiftDate.set(sid, e.entryDate)
  }
  // 2030 tax of a brand-month the reclass moved files with the account it moved to.
  const routed = (code: string, conceptId: string | null | undefined, at: Date): string =>
    code === ACCT.GST_OUTPUT && conceptId ? (reclassTarget.get(`${conceptId}|${pktMonthOf(at)}`) ?? code) : code

  // Sales: online orders booked one by one, till orders booked by their home drawer's close.
  const sold = new Map<string, ReturnOrder & { payments?: Parameters<typeof homeShiftOf>[0]['payments'] }>()
  if (completeIds.length > 0) {
    const rows = await prisma.order.findMany({ where: { id: { in: completeIds }, concept: { tenantId } }, select: ORDER_FOR_RETURN })
    for (const o of rows) sold.set(o.id, o)
  }
  if (shiftIds.size > 0) {
    const rows = await prisma.order.findMany({
      where: {
        source: 'pos',
        status: { notIn: ['cancelled', 'rejected'] },
        concept: { tenantId },
        payments: { some: { shiftId: { in: [...shiftIds] } } },
      },
      select: {
        ...ORDER_FOR_RETURN,
        payments: { select: { id: true, shiftId: true, method: true, status: true, gatewayRef: true, createdAt: true } },
      },
    })
    for (const o of rows) {
      const home = homeShiftOf(o)
      if (home && shiftIds.has(home)) sold.set(o.id, o)
    }
  }

  // Which authority each sale was booked to: the output-tax account its entry
  // actually credited (an order's own entry; a shift close's line for the
  // brand). A sale booked before tax was routed by province sits in 2030, and
  // is declared there until the reclass moves it.
  const saleTaxAccount = new Map<string, string>()     // orderId → code (order.complete)
  const shiftTaxAccount = new Map<string, string>()    // `${shiftId}|${conceptId}` → code
  const saleEntries = entries.filter((e) => e.reference?.startsWith('order.complete:') || e.reference?.startsWith('shift.close:'))
  if (saleEntries.length > 0) {
    const taxLines = await prisma.journalLine.findMany({
      where: { journalEntryId: { in: saleEntries.map((e) => e.id) }, type: 'credit', account: { tenantId, code: { in: OUTPUT_TAX_CODES } } },
      select: { journalEntryId: true, conceptId: true, account: { select: { code: true } } },
    })
    const refOf = new Map(saleEntries.map((e) => [e.id, e.reference ?? '']))
    for (const l of taxLines) {
      const ref = refOf.get(l.journalEntryId) ?? ''
      const oid = idOf(ref, 'order.complete:')
      const sid = idOf(ref, 'shift.close:')
      if (oid && !saleTaxAccount.has(oid)) saleTaxAccount.set(oid, l.account.code)
      if (sid && l.conceptId) shiftTaxAccount.set(`${sid}|${l.conceptId}`, l.account.code)
    }
  }
  const soldAccount = (o: ReturnOrder & { payments?: Parameters<typeof homeShiftOf>[0]['payments'] }): string => {
    const home = o.payments ? homeShiftOf({ payments: o.payments }) : null
    const code = saleTaxAccount.get(o.id)
      ?? (home ? shiftTaxAccount.get(`${home}|${o.conceptId}`) : undefined)
      ?? outputTaxCodeFor(o.concept)
    const at = saleDate.get(o.id) ?? (home ? shiftDate.get(home) : undefined) ?? to
    return routed(code, o.conceptId, at)
  }

  // Refunds: the output tax each refund entry actually debited, per order and account.
  const refundEntries = entries.filter((e) =>
    e.reference?.startsWith('order.refund:') || e.reference?.startsWith('order.refund_wallet:') || e.reference?.startsWith('order.refund_giftcard:'))
  const refundTaxByOrder = new Map<string, number>()
  if (refundEntries.length > 0) {
    const paymentIds = refundEntries.map((e) => idOf(e.reference, 'order.refund:')).filter((x): x is string => !!x)
    const redemptionIds = refundEntries.map((e) => idOf(e.reference, 'order.refund_giftcard:')).filter((x): x is string => !!x)
    const [pays, reds, taxLines] = await Promise.all([
      paymentIds.length ? prisma.payment.findMany({ where: { id: { in: paymentIds } }, select: { id: true, orderId: true } }) : [],
      redemptionIds.length ? prisma.giftCardRedemption.findMany({ where: { id: { in: redemptionIds } }, select: { id: true, orderId: true } }) : [],
      prisma.journalLine.findMany({
        where: { journalEntryId: { in: refundEntries.map((e) => e.id) }, account: { tenantId, code: { in: OUTPUT_TAX_CODES } } },
        select: { journalEntryId: true, type: true, amountCents: true, conceptId: true, account: { select: { code: true } } },
      }),
    ])
    const orderOfEntry = new Map<string, string>()
    for (const e of refundEntries) {
      const pid = idOf(e.reference, 'order.refund:')
      const rid = idOf(e.reference, 'order.refund_giftcard:')
      const oid = idOf(e.reference, 'order.refund_wallet:')
        ?? (pid ? pays.find((p) => p.id === pid)?.orderId : null)
        ?? (rid ? reds.find((r) => r.id === rid)?.orderId : null)
      if (oid) orderOfEntry.set(e.id, oid)
    }
    const dateOfEntry = new Map(refundEntries.map((e) => [e.id, e.entryDate]))
    for (const l of taxLines) {
      const oid = orderOfEntry.get(l.journalEntryId)
      if (!oid) continue
      const code = routed(l.account.code, l.conceptId, dateOfEntry.get(l.journalEntryId) ?? to)
      const key = `${oid}|${code}`
      refundTaxByOrder.set(key, (refundTaxByOrder.get(key) ?? 0) + (l.type === 'debit' ? toCents(l.amountCents) : -toCents(l.amountCents)))
    }
  }
  const refundedOrders = new Map<string, ReturnOrder>()
  const missing = [...new Set([...refundTaxByOrder.keys()].map((k) => k.split('|')[0]!))].filter((id) => !sold.has(id))
  if (missing.length > 0) {
    const rows = await prisma.order.findMany({ where: { id: { in: missing }, concept: { tenantId } }, select: ORDER_FOR_RETURN })
    for (const o of rows) refundedOrders.set(o.id, o)
  }

  const lines = new Map<string, RateLine>()
  const lineFor = (o: ReturnOrder, accountCode: string, part: SupplyPart) => {
    const authority = authorityOfOutput(accountCode).authority
    const tender = tenderOfRate(o)
    const key = `${authority}|${part.supply}|${part.ratePct ?? 'null'}|${tender}`
    let l = lines.get(key)
    if (!l) {
      l = { authority, supply: part.supply, ratePct: part.ratePct, tender, orders: 0, salesValueCents: 0, salesTaxCents: 0, refundValueCents: 0, refundTaxCents: 0, taxableValueCents: 0, taxCents: 0 }
      lines.set(key, l)
    }
    return l
  }
  const partsOf = new Map<string, SupplyPart[]>()
  const parts = (o: ReturnOrder) => {
    let p = partsOf.get(o.id)
    if (!p) { p = supplyParts(o); partsOf.set(o.id, p) }
    return p
  }
  for (const o of sold.values()) {
    const account = soldAccount(o)
    for (const part of parts(o)) {
      const l = lineFor(o, account, part)
      l.orders += 1
      l.salesValueCents += part.valueCents
      l.salesTaxCents += part.taxCents
    }
  }
  for (const [key, tax] of refundTaxByOrder) {
    const [oid, accountCode] = key.split('|') as [string, string]
    const o = sold.get(oid) ?? refundedOrders.get(oid)
    if (!o || tax === 0) continue
    // The refunded share of the bill, in proportion to its tax: every supply
    // on it (zero-rated and exempt lines too) goes back in that proportion,
    // and the refunded tax falls on the taxed parts as the sale's did.
    let ps = parts(o).map((p) => ({ ...p, weight: Math.max(0, p.taxCents), refundTax: 0 }))
    if (!ps.some((p) => p.weight > 0)) {
      // Tax refunded on a bill whose stored tax falls on no part: declare it standard.
      ps = [{ supply: 'standard', ratePct: o.taxRatePct, valueCents: ps.reduce((t, p) => t + p.valueCents, 0), taxCents: 0, weight: 1, refundTax: 0 }]
    }
    shareOut(tax, ps.filter((p) => p.weight > 0), (p, cents) => { p.refundTax = cents })
    for (const p of ps) {
      const l = lineFor(o, accountCode, p)
      l.refundTaxCents += p.refundTax
      l.refundValueCents += o.taxCents > 0 ? Math.round((p.valueCents * tax) / o.taxCents) : 0
    }
  }
  for (const l of lines.values()) {
    l.taxableValueCents = l.salesValueCents - l.refundValueCents
    l.taxCents = l.salesTaxCents - l.refundTaxCents
  }
  const SUPPLY_ORDER: SupplyClass[] = ['standard', 'custom', 'zero_rated', 'exempt']
  const order = (a: RateLine) => AUTHORITIES.findIndex((x) => x.authority === a.authority)
  return [...lines.values()].sort((a, b) =>
    order(a) - order(b)
    || SUPPLY_ORDER.indexOf(a.supply) - SUPPLY_ORDER.indexOf(b.supply)
    || (b.ratePct ?? -1) - (a.ratePct ?? -1))
}

/**
 * Output tax booked to 2030 (FBR) in [from, to] for brands whose authority is
 * provincial — sales booked before tax was routed by province (BOOKS-10). The
 * fix is the reclass (taxPayments.ts postTaxReclass): Dr 2030 / Cr the
 * authority's account, per brand, tagged with the brand. A reclass already
 * posted in the window is netted here, so a moved brand drops off the list.
 */
export async function misroutedOutputTax(
  db: Db,
  tenantId: string,
  from: Date,
  to: Date,
  concepts: Array<{ id: string; slug: string; name: string; province: string | null; srbPosId: number | null }>,
): Promise<ReclassRow[]> {
  const provincial = concepts.filter((c) => outputTaxCodeFor(c) !== ACCT.GST_OUTPUT)
  if (provincial.length === 0) return []
  const sums = await db.journalLine.groupBy({
    by: ['conceptId', 'type'],
    _sum: { amountCents: true },
    where: {
      conceptId: { in: provincial.map((c) => c.id) },
      account: { tenantId, code: ACCT.GST_OUTPUT },
      journalEntry: { tenantId, entryDate: { gte: from, lte: to } },
    },
  })
  return provincial
    .map((c) => {
      const credit = sumCents(sums.find((s) => s.conceptId === c.id && s.type === 'credit')?._sum.amountCents)
      const debit  = sumCents(sums.find((s) => s.conceptId === c.id && s.type === 'debit')?._sum.amountCents)
      return { conceptId: c.id, conceptSlug: c.slug, conceptName: c.name, fromAccount: ACCT.GST_OUTPUT, toAccount: outputTaxCodeFor(c), amountCents: credit - debit }
    })
    .filter((r) => r.amountCents !== 0)
}

/** Payments of `tenantId` whose period overlaps [from, to], oldest first. */
export async function taxPaymentsFor(tenantId: string, from: Date, to: Date): Promise<TaxPaymentRow[]> {
  const rows = await prisma.salesTaxPayment.findMany({
    where: { tenantId, periodFrom: { lte: to }, periodTo: { gte: from } },
    orderBy: [{ periodFrom: 'asc' }, { authority: 'asc' }],
  })
  const bankIds = [...new Set(rows.map((r) => r.bankAccountId).filter((x): x is string => !!x))]
  const banks = bankIds.length > 0
    ? await prisma.bankAccount.findMany({ where: { id: { in: bankIds }, tenantId }, select: { id: true, name: true } })
    : []
  const bankName = new Map(banks.map((b) => [b.id, b.name]))
  return rows.map((r) => ({
    id: r.id,
    authority: r.authority as TaxPaymentRow['authority'],
    periodFrom: fmtPktDate(r.periodFrom),
    periodTo: fmtPktDate(r.periodTo),
    paidAt: fmtPktDate(r.paidAt),
    paidCents: toCents(r.paidCents),
    inputSetOffCents: toCents(r.inputSetOffCents),
    outputSetOffCents: toCents(r.outputSetOffCents),
    cprNumber: r.cprNumber,
    bankAccountId: r.bankAccountId,
    bankAccountName: r.bankAccountId ? (bankName.get(r.bankAccountId) ?? null) : null,
    journalEntryId: r.journalEntryId,
    linked: r.linked,
    notes: r.notes,
    createdAt: r.createdAt.toISOString(),
  }))
}

export async function salesTaxReturn(tenantId: string, from: Date, to: Date): Promise<SalesTaxReturnReport> {
  const accounts = await prisma.account.findMany({
    where: { tenantId, code: { in: [...AUTHORITIES.flatMap((a) => [a.output, a.input]), ...WITHHOLDING.map((w) => w.account)] } },
    select: { code: true, name: true },
  })
  const named = (code: string) => accounts.find((a) => a.code === code)?.name ?? code

  const exclude = await notSettlement(prisma, [tenantId], from, to)
  const ledger = await Promise.all(AUTHORITIES.map(async (a) => ({
    a,
    output: await netCreditCents(tenantId, a.output, from, to, exclude),
    input:  0 - (await netCreditCents(tenantId, a.input, from, to, exclude)),
  })))
  const of = (key: AuthorityKey) => ledger.find((l) => l.a.key === key)!
  const total = (side: 'output' | 'input') => ledger.reduce((t, l) => t + l[side], 0)

  // Balances at the period's end — everything charged and paid up to then.
  const balances = await creditBalancesAt(
    prisma, tenantId,
    [...AUTHORITIES.flatMap((a) => [a.output, a.input]), ...WITHHOLDING.map((w) => w.account)],
    to,
  )
  const payments = await taxPaymentsFor(tenantId, from, to)
  const paidFor = (key: string) => payments.filter((p) => p.authority === key)

  // Every brand of the company, active or not, deleted or not — a brand
  // closed or removed mid-month still made taxable supplies in it.
  const concepts = await prisma.concept.findMany({
    where: { tenantId },
    select: { id: true, slug: true, name: true, province: true, srbPosId: true, isActive: true, deletedAt: true },
    orderBy: { createdAt: 'asc' },
  })

  // Per-concept revenue for the period
  const taxableByConcept: Array<{ conceptSlug: string; conceptName: string; revenueCents: number }> = []
  let taxableSales = 0
  const revenueAccounts = await prisma.account.findMany({ where: { tenantId, type: 'revenue' }, select: { id: true, code: true } })
  // A brand with no entry in the code map falls back to 4090 (Other/Catering),
  // and several brands can share it. The loop looked the account up per brand
  // and summed it each time, so 4090's revenue was counted once per unmapped
  // brand — over-declaring taxable sales, and therefore output GST, on a return
  // filed with FBR/SRB. Count each account at most once.
  const countedAccountIds = new Set<string>()
  for (const c of concepts) {
    // Find the matching 4xxx account by code-mapping in journal.ts (revenueCodeForConcept)
    const revAccount = revenueAccounts.find((a) => a.code === revenueCodeForConcept(c.slug))
    if (!revAccount) continue
    if (countedAccountIds.has(revAccount.id)) continue
    countedAccountIds.add(revAccount.id)
    const sums = await prisma.journalLine.groupBy({
      by: ['type'], _sum: { amountCents: true },
      where: { accountId: revAccount.id, journalEntry: { tenantId, entryDate: { gte: from, lte: to } } },
    })
    let debit = 0, credit = 0
    for (const s of sums) {
      if (s.type === 'debit') debit  = sumCents(s._sum.amountCents)
      else                     credit = sumCents(s._sum.amountCents)
    }
    const revenue = Math.max(0, credit - debit)
    if (revenue > 0) {
      taxableByConcept.push({ conceptSlug: c.slug, conceptName: c.name, revenueCents: revenue })
      taxableSales += revenue
    }
  }

  const reclasses = await reclassesIn(tenantId, from, to)
  const byRate = await rateBreakdown(tenantId, from, to, reclasses.target)
  const reclassification = await misroutedOutputTax(prisma, tenantId, from, to, concepts)
  const conceptName = new Map(concepts.map((c) => [c.id, c.name]))

  const byAuthority: AuthorityReturn[] = ledger.map(({ a, output, input }) => {
    const brands = concepts.filter((c) => outputTaxCodeFor(c) === a.output).map((c) => c.slug)
    const fromOrders = byRate.filter((r) => r.authority === a.authority).reduce((t, r) => t + r.taxCents, 0)
    const paid = paidFor(a.key)
    return {
      key: a.key,
      authority: a.authority,
      name: a.name,
      output: { code: a.output, name: named(a.output), totalCents: output },
      input:  { code: a.input,  name: named(a.input),  totalCents: input },
      netPayableCents: output - input,
      brands,
      otherOutputCents: output - fromOrders,
      paidForPeriodCents: paid.reduce((t, p) => t + p.paidCents, 0),
      inputSetOffForPeriodCents: paid.reduce((t, p) => t + p.inputSetOffCents, 0),
      ledgerBalanceAtEndCents: balances.get(a.output) ?? 0,
      inputLedgerBalanceAtEndCents: 0 - (balances.get(a.input) ?? 0),
    }
  }).filter((r) =>
    r.output.totalCents !== 0 || r.input.totalCents !== 0 || r.brands.length > 0
    || r.paidForPeriodCents !== 0 || r.inputSetOffForPeriodCents !== 0 || r.ledgerBalanceAtEndCents !== 0)

  const withholding: WithholdingReturn[] = await Promise.all(WITHHOLDING.map(async (w) => ({
    key: w.key,
    authority: w.authority,
    name: w.name,
    account: { code: w.account, name: named(w.account), totalCents: await netCreditCents(tenantId, w.account, from, to, exclude) },
    paidForPeriodCents: paidFor(w.key).reduce((t, p) => t + p.paidCents, 0),
    ledgerBalanceAtEndCents: balances.get(w.account) ?? 0,
  })))

  const netPayableCents   = byAuthority.reduce((t, r) => t + Math.max(0, r.netPayableCents), 0)
  const carryForwardCents = byAuthority.reduce((t, r) => t + Math.max(0, -r.netPayableCents), 0)

  const notes: string[] = []
  const noProvince = concepts.filter((c) => !c.province && c.srbPosId == null && !c.deletedAt)
  if (noProvince.length > 0) {
    notes.push(`No province set for ${noProvince.map((c) => c.slug).join(', ')} — their sales tax is booked to 2030 (FBR). Set each brand's province (Brands → tax details) so it files with the right authority.`)
  }
  if (reclassification.length > 0) {
    notes.push(
      'Output tax for provincially-taxed brands is still in 2030 (FBR) for this period — booked before sales were routed by province. ' +
      'Use "Post reclass" on each brand under "To reclassify": it moves the brand\'s 2030 tax for that month to the authority\'s account (Dr 2030 / Cr the authority account, tagged with the brand), dated in the same month as the sales. ' +
      'A negative amount is a refund of such a sale; the reclass moves it the other way. Post it before the month is closed — a closed month must be reopened first.',
    )
  }
  if (total('input') === 0) {
    notes.push('No input tax recorded. Verify supplier bills are tagging GST Input (1320) or the provincial input account when applicable.')
  }
  const unclassed = byRate.filter((r) => r.supply === 'zero_rated' || r.supply === 'exempt')
  if (unclassed.length > 0) {
    notes.push('Zero-rated and exempt lines are declared on their own rows, at 0%, by each item\'s tax class as it is set today (Menu → item → tax class). "Total taxable sales" is ledger revenue and includes them.')
  }
  notes.push('Output and input are what was charged and recovered in the period. Tax paid to the authorities (payments recorded here, and entries linked as payments) is left out of them and shown under "Paid for this period"; "Ledger balance at period end" is what the books still owe after every charge and payment up to then.')
  notes.push('Input tax is set off only against the same authority\'s output: federal input on goods (1320) is never netted against provincial output on services. Whether any input is admissible (e.g. restaurant services at a reduced rate) is for your CA.')
  notes.push('Per-rate figures: sales are the orders booked in the period (online orders on completion, till orders on their drawer\'s close), less the tax the period\'s refunds reversed. Value is the pre-discount item value. "otherOutputCents" is ledger output tax not explained by them (manual journals, B2B invoices, older entries).')
  notes.push('Supplies are classed by item tax class only (standard / custom / zero-rated / exempt). Adjust with your CA before filing.')

  return {
    tenantId,
    period: { from: fmtPktDate(from), to: fmtPktDate(to) },
    outputTax: {
      fbr:  { code: ACCT.GST_OUTPUT,      name: named(ACCT.GST_OUTPUT),      totalCents: of('fbr').output },
      pra:  { code: ACCT.PRA_TAX_OUTPUT,  name: named(ACCT.PRA_TAX_OUTPUT),  totalCents: of('pra').output },
      srb:  { code: ACCT.SRB_TAX_OUTPUT,  name: named(ACCT.SRB_TAX_OUTPUT),  totalCents: of('srb').output },
      kpra: { code: ACCT.KPRA_TAX_OUTPUT, name: named(ACCT.KPRA_TAX_OUTPUT), totalCents: of('kpra').output },
      bra:  { code: ACCT.BRA_TAX_OUTPUT,  name: named(ACCT.BRA_TAX_OUTPUT),  totalCents: of('bra').output },
      totalCents: total('output'),
    },
    inputTax: {
      fbr:  { code: ACCT.GST_INPUT, name: named(ACCT.GST_INPUT), totalCents: of('fbr').input },
      pra:  { code: '1321', name: named('1321'), totalCents: of('pra').input },
      srb:  { code: '1322', name: named('1322'), totalCents: of('srb').input },
      kpra: { code: '1323', name: named('1323'), totalCents: of('kpra').input },
      bra:  { code: '1324', name: named('1324'), totalCents: of('bra').input },
      totalCents: total('input'),
    },
    byAuthority,
    byRate,
    reclassification,
    reclassesPosted: reclasses.posted.map((r) => ({
      conceptId: r.conceptId,
      conceptName: conceptName.get(r.conceptId) ?? r.conceptId,
      month: r.month,
      reference: r.reference,
      entryDate: fmtPktDate(r.entryDate),
      fromAccount: r.fromAccount,
      toAccount: r.toAccount,
      amountCents: r.amountCents,
    })),
    withholding,
    payments,
    taxableSalesCents: taxableSales,
    taxableValueByConceptCents: taxableByConcept,
    netPayableCents,
    carryForwardCents,
    notes,
  }
}
