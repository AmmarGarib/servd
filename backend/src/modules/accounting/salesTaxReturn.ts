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
//     authority's excess input.
//   • byRate — per authority, per rate (15% cash / 8% card — Order.taxRatePct,
//     owner decision 9), the taxable value and the tax: sales booked in the
//     period less refunds booked in the period. Sales are the orders the
//     ledger booked ('order.complete' entries, and the till orders each
//     'shift.close' entry booked); refunds are the tax the refund entries
//     actually debited. The value is the pre-discount item value (GST is
//     charged before a discount — SRB POS rule).
//   • reclassification — output tax still sitting in 2030 for a brand whose
//     authority is provincial (booked before sales were routed by province):
//     the one-off reclass is Dr 2030 / Cr the authority's account.
//   Sales and refunds are filed under the authority whose account the entry
//   actually credited / debited — a refund of a pre-routing sale debits 2030
//   like its sale (orderPosting.ts refundTaxAccountFor), so both sit with FBR
//   until the reclass moves them.
//
// Caveats:
//   1. We DO NOT classify supplies into zero-rated / exempt / standard beyond
//      the item tax classes priceOrder applies. Adjust with your CA.
//   2. The return is ONE company's (the caller passes the active company).
//   3. The return needs to be signed and filed by a person — never auto-file.

import { prisma } from '../../lib/prisma.js'
import { ACCT, revenueCodeForConcept } from './journal.js'
import { fmtPktDate } from './dates.js'
import { homeShiftOf, outputTaxCodeFor } from './orderPosting.js'
import { sumCents, toCents } from '../../lib/money.js'

interface AccountTotal {
  code: string
  name: string
  totalCents: number   // natural balance in the account's normal direction
}

async function netCreditCents(tenantId: string, accountCode: string, from: Date, to: Date): Promise<number> {
  // The return is filed by ONE company, against its own chart of accounts.
  const account = await prisma.account.findFirst({ where: { tenantId, code: accountCode } })
  if (!account) return 0
  const sums = await prisma.journalLine.groupBy({
    by: ['type'],
    _sum: { amountCents: true },
    where: {
      accountId: account.id,
      journalEntry: { tenantId, entryDate: { gte: from, lte: to } },
    },
  })
  let debit = 0, credit = 0
  for (const s of sums) {
    if (s.type === 'debit') debit  = sumCents(s._sum.amountCents)
    else                     credit = sumCents(s._sum.amountCents)
  }
  return credit - debit
}

async function netDebitCents(tenantId: string, accountCode: string, from: Date, to: Date): Promise<number> {
  return -(await netCreditCents(tenantId, accountCode, from, to))
}

type AuthorityKey = 'fbr' | 'pra' | 'srb' | 'kpra' | 'bra'

/** Each authority: its output (payable) and input (recoverable) accounts. */
const AUTHORITIES: Array<{ key: AuthorityKey; authority: string; name: string; output: string; input: string }> = [
  { key: 'fbr',  authority: 'FBR',  name: 'Federal Board of Revenue',              output: ACCT.GST_OUTPUT,      input: ACCT.GST_INPUT },
  { key: 'pra',  authority: 'PRA',  name: 'Punjab Revenue Authority',              output: ACCT.PRA_TAX_OUTPUT,  input: '1321' },
  { key: 'srb',  authority: 'SRB',  name: 'Sindh Revenue Board',                   output: ACCT.SRB_TAX_OUTPUT,  input: '1322' },
  { key: 'kpra', authority: 'KPRA', name: 'Khyber Pakhtunkhwa Revenue Authority',  output: ACCT.KPRA_TAX_OUTPUT, input: '1323' },
  { key: 'bra',  authority: 'BRA',  name: 'Balochistan Revenue Authority',         output: ACCT.BRA_TAX_OUTPUT,  input: '1324' },
]
const authorityOfOutput = (code: string) => AUTHORITIES.find((a) => a.output === code) ?? AUTHORITIES[0]!

export interface AuthorityReturn {
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
}

export interface RateLine {
  authority: string
  /** Order.taxRatePct; null = an order priced before the rate was stored. */
  ratePct: number | null
  /** Which of the brand's two rates this is (cash 15% / card 8%). */
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

export interface SalesTaxReturnReport {
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
  reclassification: Array<{ conceptSlug: string; conceptName: string; fromAccount: string; toAccount: string; amountCents: number }>
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
 * return files, net of reversals. This is the figure the CEO "Tax collected"
 * card shows; it used to show the sales register's taxCents, which missed POS
 * card sales and refunds and used payment timing, so it never matched the
 * return. `tenantIds` is the company scope (a return itself is one company).
 */
export async function outputTaxCollectedCents(tenantIds: string[], from: Date, to: Date): Promise<number> {
  if (tenantIds.length === 0) return 0
  const accounts = await prisma.account.findMany({
    where: { tenantId: { in: tenantIds }, code: { in: OUTPUT_TAX_CODES } },
    select: { id: true },
  })
  if (accounts.length === 0) return 0
  const sums = await prisma.journalLine.groupBy({
    by: ['type'],
    _sum: { amountCents: true },
    where: {
      accountId: { in: accounts.map((a) => a.id) },
      journalEntry: { tenantId: { in: tenantIds }, entryDate: { gte: from, lte: to } },
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
  items: { select: { unitPriceCents: true, quantity: true, status: true, modifiers: { select: { priceDeltaCents: true } } } },
} as const

interface ReturnOrder {
  id: string
  conceptId: string
  status: string
  taxCents: number
  taxRatePct: number | null
  concept: { slug: string; tenantId: string | null; province: string | null; srbPosId: number | null; taxRateCash: number; taxRateCard: number }
  items: Array<{ unitPriceCents: number; quantity: number; status: string; modifiers: Array<{ priceDeltaCents: number }> }>
}

/** The pre-discount value of an order's (non-voided) items — the base GST is charged on. */
function itemValueCents(o: ReturnOrder): number {
  return o.items
    .filter((i) => i.status !== 'voided')
    .reduce((t, i) => t + (i.unitPriceCents + i.modifiers.reduce((m, x) => m + x.priceDeltaCents, 0)) * i.quantity, 0)
}

function tenderOfRate(o: ReturnOrder): RateLine['tender'] {
  if (o.taxRatePct == null) return 'other'
  if (o.taxRatePct === o.concept.taxRateCash) return 'cash'
  if (o.taxRatePct === o.concept.taxRateCard) return 'card'
  return 'other'
}

/**
 * Sales and refunds the ledger booked for `tenantId` in [from, to], per
 * authority and rate. Sales come from the orders behind the period's
 * 'order.complete' and 'shift.close' entries; refunds from the output-tax
 * debits on the period's refund entries.
 */
async function rateBreakdown(tenantId: string, from: Date, to: Date): Promise<RateLine[]> {
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
    select: { id: true, reference: true },
  })
  const idOf = (ref: string | null, prefix: string) => (ref?.startsWith(prefix) ? ref.slice(prefix.length) : null)
  const completeIds = entries.map((e) => idOf(e.reference, 'order.complete:')).filter((x): x is string => !!x)
  const shiftIds = new Set(entries.map((e) => idOf(e.reference, 'shift.close:')).filter((x): x is string => !!x))

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
  // is declared there until the one-off reclass moves it.
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
    const own = saleTaxAccount.get(o.id)
    if (own) return own
    const home = o.payments ? homeShiftOf({ payments: o.payments }) : null
    return (home ? shiftTaxAccount.get(`${home}|${o.conceptId}`) : undefined) ?? outputTaxCodeFor(o.concept)
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
        select: { journalEntryId: true, type: true, amountCents: true, account: { select: { code: true } } },
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
    for (const l of taxLines) {
      const oid = orderOfEntry.get(l.journalEntryId)
      if (!oid) continue
      const key = `${oid}|${l.account.code}`
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
  const lineFor = (o: ReturnOrder, accountCode: string) => {
    const authority = authorityOfOutput(accountCode).authority
    const tender = tenderOfRate(o)
    const key = `${authority}|${o.taxRatePct ?? 'null'}|${tender}`
    let l = lines.get(key)
    if (!l) {
      l = { authority, ratePct: o.taxRatePct, tender, orders: 0, salesValueCents: 0, salesTaxCents: 0, refundValueCents: 0, refundTaxCents: 0, taxableValueCents: 0, taxCents: 0 }
      lines.set(key, l)
    }
    return l
  }
  for (const o of sold.values()) {
    const l = lineFor(o, soldAccount(o))
    l.orders += 1
    l.salesValueCents += itemValueCents(o)
    l.salesTaxCents += o.taxCents
  }
  for (const [key, tax] of refundTaxByOrder) {
    const [oid, accountCode] = key.split('|') as [string, string]
    const o = sold.get(oid) ?? refundedOrders.get(oid)
    if (!o || tax === 0) continue
    const l = lineFor(o, accountCode)
    l.refundTaxCents += tax
    // The refunded share of the order's value, in proportion to its tax.
    l.refundValueCents += o.taxCents > 0 ? Math.round((itemValueCents(o) * tax) / o.taxCents) : 0
  }
  for (const l of lines.values()) {
    l.taxableValueCents = l.salesValueCents - l.refundValueCents
    l.taxCents = l.salesTaxCents - l.refundTaxCents
  }
  const order = (a: RateLine) => AUTHORITIES.findIndex((x) => x.authority === a.authority)
  return [...lines.values()].sort((a, b) => order(a) - order(b) || (b.ratePct ?? -1) - (a.ratePct ?? -1))
}

/**
 * Output tax booked to 2030 (FBR) in the period for brands whose authority is
 * provincial — sales booked before tax was routed by province (BOOKS-10). The
 * one-off fix is a manual journal: Dr 2030 / Cr the authority's account, per
 * brand (tag the lines with the brand).
 */
async function misroutedOutputTax(
  tenantId: string,
  from: Date,
  to: Date,
  concepts: Array<{ id: string; slug: string; name: string; province: string | null; srbPosId: number | null }>,
) {
  const provincial = concepts.filter((c) => outputTaxCodeFor(c) !== ACCT.GST_OUTPUT)
  if (provincial.length === 0) return []
  const sums = await prisma.journalLine.groupBy({
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
      return { conceptSlug: c.slug, conceptName: c.name, fromAccount: ACCT.GST_OUTPUT, toAccount: outputTaxCodeFor(c), amountCents: credit - debit }
    })
    .filter((r) => r.amountCents !== 0)
}

export async function salesTaxReturn(tenantId: string, from: Date, to: Date): Promise<SalesTaxReturnReport> {
  const accounts = await prisma.account.findMany({
    where: { tenantId, code: { in: AUTHORITIES.flatMap((a) => [a.output, a.input]) } },
    select: { code: true, name: true },
  })
  const named = (code: string) => accounts.find((a) => a.code === code)?.name ?? code

  const ledger = await Promise.all(AUTHORITIES.map(async (a) => ({
    a,
    output: await netCreditCents(tenantId, a.output, from, to),
    input:  await netDebitCents(tenantId, a.input, from, to),
  })))
  const of = (key: AuthorityKey) => ledger.find((l) => l.a.key === key)!
  const total = (side: 'output' | 'input') => ledger.reduce((t, l) => t + l[side], 0)

  // Every brand of the company, active or not — a brand closed mid-month
  // still made taxable supplies in it.
  const concepts = await prisma.concept.findMany({
    where: { tenantId },
    select: { id: true, slug: true, name: true, province: true, srbPosId: true, isActive: true, deletedAt: true },
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
  for (const c of concepts.filter((x) => x.isActive && !x.deletedAt)) {
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

  const byRate = await rateBreakdown(tenantId, from, to)
  const reclassification = await misroutedOutputTax(tenantId, from, to, concepts)

  const byAuthority: AuthorityReturn[] = ledger.map(({ a, output, input }) => {
    const brands = concepts.filter((c) => outputTaxCodeFor(c) === a.output).map((c) => c.slug)
    const fromOrders = byRate.filter((r) => r.authority === a.authority).reduce((t, r) => t + r.taxCents, 0)
    return {
      authority: a.authority,
      name: a.name,
      output: { code: a.output, name: named(a.output), totalCents: output },
      input:  { code: a.input,  name: named(a.input),  totalCents: input },
      netPayableCents: output - input,
      brands,
      otherOutputCents: output - fromOrders,
    }
  }).filter((r) => r.output.totalCents !== 0 || r.input.totalCents !== 0 || r.brands.length > 0)

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
      'Post a one-off manual journal per brand: Dr 2030 / Cr the authority account shown under "reclassification", tagged with the brand, dated in the open period. ' +
      'A negative amount is a refund of such a sale, debited to 2030 where the sale sits: move it the other way (Dr the authority account / Cr 2030). ' +
      'The brand tag matters — refunds of these sales keep debiting 2030 until the brand\'s 2030 balance has been moved.',
    )
  }
  if (total('input') === 0) {
    notes.push('No input tax recorded. Verify supplier bills are tagging GST Input (1320) or the provincial input account when applicable.')
  }
  notes.push('Input tax is set off only against the same authority\'s output: federal input on goods (1320) is never netted against provincial output on services. Whether any input is admissible (e.g. restaurant services at a reduced rate) is for your CA.')
  notes.push('Per-rate figures: sales are the orders booked in the period (online orders on completion, till orders on their drawer\'s close), less the tax the period\'s refunds reversed. Value is the pre-discount item value. "otherOutputCents" is ledger output tax not explained by them (manual journals, B2B invoices, older entries).')
  notes.push('This report does NOT distinguish standard / zero-rated / exempt supplies beyond item tax classes. Adjust with your CA before filing.')

  return {
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
    taxableSalesCents: taxableSales,
    taxableValueByConceptCents: taxableByConcept,
    netPayableCents,
    carryForwardCents,
    notes,
  }
}
