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
// Finance wave B (H8–H13):
//   • The authority table is accounting/taxAuthorities.ts (AUTHORITIES,
//     re-exported here) — never a second copy. Input tax on bills, OpEx and
//     CapEx is booked to the CHARGING authority's own input account
//     (1320–1324) and set off against that authority (H8).
//   • Federal input on raw materials, cross set-off (H8, Hasnain 2026-10-14,
//     "as per SRB eligibility"): FBR input (1320) booked on SUPPLIER BILLS for
//     stock lines whose cost class is in CROSS_SETOFF_ELIGIBLE_CLASSES (food
//     and drinks — the one switch point) may ALSO be set off against a
//     provincial authority's output (SRB, PRA, KPRA, BRA). Pool per company:
//     eligible federal input booked to date − cross set-offs already recorded
//     (any period, any authority), never more than 1320 still holds after
//     what FBR is owed (federal output uses 1320 first). Shared over the
//     provincial authorities in AUTHORITIES order; unused, it carries
//     forward. A payment sets it off with crossSetOffCents (taxPayments.ts:
//     Dr the output / Cr 1320). Another company's input never counts.
//   • Delivery charges (H9): Order.deliveryFeeCents / deliveryFeeTaxCents are
//     their own supply ('delivery_charge') at the order's rate; the item parts
//     share the rest of the order's tax. Taxable sales include 4110 Delivery
//     Fee Income per brand.
//   • Kept no-show deposits (H10, Hasnain 2026-10-14): untaxed compensation —
//     'reservation.deposit_capture:' entries credit 4210 (other income) with
//     no output tax, so they are not supplies and the return lists nothing
//     for them. Entries posted under the earlier treatment (brand revenue +
//     output tax inside, card rate) stay declared as they were filed: a
//     capture entry that credited an output-tax account is a 'deposit_forfeit'
//     row, flagged 'pre-H10' in the notes (its reversal counts the other way).
//   • Sales tax withheld by customers (H13): 1335, from 'receivable.st_withheld:'
//     entries (and their reversals), per authority (ReceivablePayment.
//     taxAuthority) — deducted from that authority's net (netAfterWithheld).
//   • The payments list is sales tax + withholding only: statutory payroll
//     challans (2042–2044) are the statutory page's (accounting/statutory.ts).
//     The one-time statutory reclass (Dr 2040) is not "withheld in the period".
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
import { homeShiftOf } from './orderPosting.js'
import { sumCents, toCents } from '../../lib/money.js'
import { costClassOf, type CostClass } from '../../lib/inventoryClass.js'
import {
  AUTHORITIES, AUTHORITY_LIST, TAX_AUTHORITY_KEYS, authorityOfOutputCode, isAuthorityKey, outputTaxCodeFor,
  type AuthorityKey,
} from './taxAuthorities.js'
// taxPayments.ts imports this file too: use these only inside functions.
import { customerWithheldAvailable, type StatutoryKey } from './taxPayments.js'

/** THE authority table (accounting/taxAuthorities.ts), re-exported for the return's callers. */
export { AUTHORITIES, type AuthorityKey } from './taxAuthorities.js'

type Db = Prisma.TransactionClient

/** Journal source of a tax payment posted from the return: 'salestax.payment:<SalesTaxPayment.id>'. */
export const TAX_PAYMENT_SOURCE = 'salestax.payment'
/** The one-off move of a provincial brand's output tax out of 2030: 'salestax.reclass:<conceptId>:<YYYY-MM>[:n]'. */
export const TAX_RECLASS_SOURCE = 'salestax.reclass'
/** Entries that are payments by reference: the posting and its reversal ('salestax.payment.reversal:<id>'). */
const PAYMENT_REF_PREFIXES = [`${TAX_PAYMENT_SOURCE}:`, `${TAX_PAYMENT_SOURCE}.reversal:`]
/**
 * The one-time statutory reclass (accounting/statutory.ts STATUTORY_RECLASS_SOURCE,
 * kept literal here to avoid an import cycle): it moves legacy salary tax OUT
 * of 2040 — a move, never income tax withheld in the period.
 */
const STATUTORY_RECLASS_PREFIX = 'statutory.reclass:'
/** Sales tax a client withheld from us (H13): Dr 1335 / Cr 1110, per ReceivablePayment ('st_withheld'), and its reversal. */
export const CUSTOMER_WITHHELD_SOURCE = 'receivable.st_withheld'
const CUSTOMER_WITHHELD_PREFIXES = [`${CUSTOMER_WITHHELD_SOURCE}:`, `${CUSTOMER_WITHHELD_SOURCE}.reversal:`]
/** A kept no-show deposit (reservations/depositCapture.ts, H10), and its reversal. */
const DEPOSIT_CAPTURE_PREFIXES = ['reservation.deposit_capture:', 'reservation.deposit_capture.reversal:']

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

/** The authority whose OUTPUT account `code` is; an unknown code files with FBR. */
const authorityOfOutput = (code: string) => AUTHORITIES[authorityOfOutputCode(code) ?? 'fbr']

// ─── Federal input on raw materials, cross set-off (H8) ─────────────────────

/**
 * THE switch point (H8, Hasnain 2026-10-14; H34 default): the stock cost
 * classes (lib/inventoryClass.ts) whose federal input tax on supplier bills
 * may be set off against a provincial authority's output — food (meat,
 * chicken, vegetables, dry goods …) and drinks. Add 'packaging' here, and only
 * here, if the CA confirms it is eligible.
 */
export const CROSS_SETOFF_ELIGIBLE_CLASSES: readonly CostClass[] = ['food', 'beverage']

/** A provincial sales-tax authority (every one but FBR). */
export type ProvincialAuthorityKey = Exclude<AuthorityKey, 'fbr'>

/** The authorities eligible federal input may be set off against: every provincial one (never FBR — 1320 is FBR's own). */
export const CROSS_SETOFF_AUTHORITIES: readonly ProvincialAuthorityKey[] = TAX_AUTHORITY_KEYS.filter((k): k is ProvincialAuthorityKey => k !== 'fbr')

export function crossSetOffAllowed(authority: string): authority is ProvincialAuthorityKey {
  return (CROSS_SETOFF_AUTHORITIES as readonly string[]).includes(authority)
}

/** The supplier documents whose 1320 lines are federal input on goods: a bill (+), its void (−), a credit note (−), its void (+). */
const BILL_INPUT_PREFIXES = ['supplier.bill:', 'supplier.bill.void:', 'supplier.credit_note:', 'supplier.credit_note.void:'] as const

/** Every entry ever dated: a balance including everything after a date. */
const END_OF_TIME = new Date('9999-12-31T00:00:00Z')

/**
 * Federal input (1320) on supplier bills that is ELIGIBLE for the cross
 * set-off, booked in [from, to] (from null = since the beginning), net:
 * each 1320 line of a bill, its void, a credit note or its void, times the
 * share of that document's line value that is stock of an eligible class
 * (the line's item — or its PO line's — category, lib/inventoryClass.ts
 * costClassOf; a non-stock line, an item-less line or another company's item
 * is not eligible). A credit note with no lines of its own takes its
 * original bill's share. Only `tenantId`'s entries, documents and items.
 */
export async function eligibleFederalInputCents(db: Db, tenantId: string, from: Date | null, to: Date): Promise<number> {
  const lines = await db.journalLine.findMany({
    where: {
      account: { tenantId, code: ACCT.GST_INPUT },
      journalEntry: {
        tenantId,
        entryDate: { ...(from ? { gte: from } : {}), lte: to },
        OR: BILL_INPUT_PREFIXES.map((p) => ({ reference: { startsWith: p } })),
      },
    },
    select: { type: true, amountCents: true, journalEntry: { select: { reference: true } } },
  })
  if (lines.length === 0) return 0
  const docIdOf = (ref: string | null): string | null => {
    const p = BILL_INPUT_PREFIXES.find((x) => ref?.startsWith(x))
    return p ? ref!.slice(p.length) : null
  }
  const share = await eligibleShareOfDocs(db, tenantId, [...new Set(lines.map((l) => docIdOf(l.journalEntry.reference)).filter((x): x is string => !!x))])
  let total = 0
  for (const l of lines) {
    const id = docIdOf(l.journalEntry.reference)
    const s = id ? share.get(id) : undefined
    if (!s || s.all <= 0 || s.eligible <= 0) continue
    const cents = Math.round((toCents(l.amountCents) * s.eligible) / s.all)
    total += l.type === 'debit' ? cents : -cents
  }
  return total
}

/** Per supplier document: its eligible stock-line value and its whole line value (both ≥ 0). */
async function eligibleShareOfDocs(db: Db, tenantId: string, ids: string[]): Promise<Map<string, { eligible: number; all: number }>> {
  const out = new Map<string, { eligible: number; all: number }>()
  if (ids.length === 0) return out
  const select = {
    id: true, kind: true, originalBillId: true,
    lines: { select: { lineTotalCents: true, inventoryItemId: true, expenseAccountCode: true, poLine: { select: { inventoryItemId: true } } } },
  } as const
  const docs = await db.supplierBill.findMany({ where: { id: { in: ids }, supplier: { tenantId } }, select })
  // A credit note without lines of its own reads its original bill's.
  const originals = [...new Set(docs.filter((d) => d.lines.length === 0 && d.originalBillId).map((d) => d.originalBillId!))]
    .filter((id) => !docs.some((d) => d.id === id))
  const all = originals.length > 0
    ? [...docs, ...await db.supplierBill.findMany({ where: { id: { in: originals }, supplier: { tenantId } }, select })]
    : docs
  const itemIds = [...new Set(all.flatMap((d) => d.lines.map((l) => l.inventoryItemId ?? l.poLine?.inventoryItemId ?? null)).filter((x): x is string => !!x))]
  const items = itemIds.length > 0
    ? await db.inventoryItem.findMany({ where: { id: { in: itemIds }, tenantId }, select: { id: true, category: true } })
    : []
  const eligibleItem = new Set(items.filter((i) => CROSS_SETOFF_ELIGIBLE_CLASSES.includes(costClassOf(i.category))).map((i) => i.id))
  const own = new Map<string, { eligible: number; all: number }>()
  for (const d of all) {
    let eligible = 0, whole = 0
    for (const l of d.lines) {
      const v = Math.abs(toCents(l.lineTotalCents))
      whole += v
      const itemId = l.inventoryItemId ?? l.poLine?.inventoryItemId ?? null
      if (itemId && !l.expenseAccountCode && eligibleItem.has(itemId)) eligible += v
    }
    own.set(d.id, { eligible, all: whole })
  }
  for (const d of docs) {
    const s = own.get(d.id)!
    out.set(d.id, s.all > 0 || !d.originalBillId ? s : (own.get(d.originalBillId) ?? s))
  }
  return out
}

/**
 * Cross set-off recorded per payment: Cr − Dr on 1320 in the entry of each
 * live provincial payment (posted here or linked) — a provincial payment's
 * own input is its own 132x, so a 1320 line in it is always the cross
 * set-off. A voided payment's row is gone (its reversal nets its entry).
 */
export async function crossSetOffByPayment(
  db: Db, tenantId: string, rows: Array<{ id: string; authority: string; journalEntryId: string | null }>,
): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  const live = rows.filter((r) => r.journalEntryId && crossSetOffAllowed(r.authority))
  if (live.length === 0) return out
  const lines = await db.journalLine.findMany({
    where: { journalEntryId: { in: live.map((r) => r.journalEntryId!) }, account: { tenantId, code: ACCT.GST_INPUT }, journalEntry: { tenantId } },
    select: { journalEntryId: true, type: true, amountCents: true },
  })
  const byEntry = new Map<string, number>()
  for (const l of lines) byEntry.set(l.journalEntryId, (byEntry.get(l.journalEntryId) ?? 0) + (l.type === 'credit' ? toCents(l.amountCents) : -toCents(l.amountCents)))
  for (const r of live) {
    const c = byEntry.get(r.journalEntryId!) ?? 0
    if (c !== 0) out.set(r.id, c)
  }
  return out
}

export interface FederalCrossSetOffPool {
  /** The classes counted (CROSS_SETOFF_ELIGIBLE_CLASSES). */
  eligibleClasses: CostClass[]
  /** Eligible federal input booked up to the date. */
  eligibleToDateCents: number
  /** Cross set-offs recorded in payments (any period, any provincial authority). */
  usedCents: number
  /** What 1320 holds (on the date, and counting everything after it — the lower). */
  ledgerHeldCents: number
  /** FBR output still owed on the date (2030, never negative) — federal output takes 1320 first. */
  federalOutputOwedCents: number
  /** What may still be set off against a provincial authority. Never negative. */
  availableCents: number
}

/**
 * The cross set-off still available to `tenantId` on `asOf` (H8): eligible
 * federal input to date − cross set-offs already recorded; with `ledgerCap`
 * (the default) also never more than 1320 holds after what FBR is still
 * owed. `ledgerCap: false` is for linking an entry that already credited
 * 1320 (its own credit is in the balance). One company's books only.
 */
export async function federalCrossSetOffAvailable(
  db: Db, tenantId: string, asOf: Date, opts: { ledgerCap?: boolean } = {},
): Promise<FederalCrossSetOffPool> {
  const live = await db.salesTaxPayment.findMany({
    where: { tenantId, authority: { in: [...CROSS_SETOFF_AUTHORITIES] }, journalEntryId: { not: null } },
    select: { id: true, authority: true, journalEntryId: true },
  })
  const [eligibleToDateCents, used, owed, held, heldLater] = await Promise.all([
    eligibleFederalInputCents(db, tenantId, null, asOf),
    crossSetOffByPayment(db, tenantId, live),
    creditBalancesAt(db, tenantId, [ACCT.GST_OUTPUT], asOf),
    debitBalanceAt(db, tenantId, ACCT.GST_INPUT, asOf),
    debitBalanceAt(db, tenantId, ACCT.GST_INPUT, END_OF_TIME),
  ])
  const usedCents = [...used.values()].reduce((t, v) => t + v, 0)
  const ledgerHeldCents = Math.min(held, heldLater)
  const federalOutputOwedCents = Math.max(0, owed.get(ACCT.GST_OUTPUT) ?? 0)
  let available = eligibleToDateCents - usedCents
  if (opts.ledgerCap !== false) available = Math.min(available, ledgerHeldCents - federalOutputOwedCents)
  return {
    eligibleClasses: [...CROSS_SETOFF_ELIGIBLE_CLASSES],
    eligibleToDateCents, usedCents, ledgerHeldCents, federalOutputOwedCents,
    availableCents: Math.max(0, available),
  }
}

export type WithholdingKey = 'wht' | 'stwh'

/**
 * Tax the company withholds from others and pays over: income tax withheld
 * from vendors (supplier bills, OpEx and CapEx payments, s.153 / s.155) —
 * 2040, paid to FBR; sales tax withheld as a withholding agent — 2041. Paid
 * from the return like sales tax, never set off against input. Salary tax is
 * NOT here: it is a statutory payable (2042, accounting/statutory.ts).
 */
export const WITHHOLDING: Array<{ key: WithholdingKey; authority: string; name: string; account: string }> = [
  { key: 'wht',  authority: 'WHT',  name: 'Income tax withheld from vendors (paid to FBR)', account: ACCT.WHT_PAYABLE },
  { key: 'stwh', authority: 'STWH', name: 'Sales tax withheld (as withholding agent)', account: ACCT.STWH_PAYABLE },
]

/** The payment authorities the return lists: the five sales-tax authorities and the two withholdings — never statutory challans. */
export const RETURN_PAYMENT_KEYS: ReadonlyArray<AuthorityKey | WithholdingKey> = [...TAX_AUTHORITY_KEYS, ...WITHHOLDING.map((w) => w.key)]

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
  /**
   * Sales tax our clients withheld for this authority in the period (H13):
   * Dr − Cr on 1335 from 'receivable.st_withheld:' entries and their
   * reversals dated in the period, by the receipt's authority.
   */
  withheldByCustomersCents: number
  /** Customer-withheld tax (1335) set off in this period's payments to this authority. */
  customerWithheldSetOffForPeriodCents: number
  /** Customer-withheld tax still available to set off against this authority at the period's end. */
  customerWithheldAvailableCents: number
  /** output − input − withheld by customers: what this authority is owed for the period. Negative = carried forward. */
  netAfterWithheldCents: number
  /** The output account's balance (still owed) at the period's end, after every charge and payment up to then. */
  ledgerBalanceAtEndCents: number
  /** The input account's balance (still recoverable) at the period's end. */
  inputLedgerBalanceAtEndCents: number
  /**
   * H8 cross set-off (provincial authorities only; 0 for FBR): federal input
   * on raw materials (1320) already set off against THIS authority in
   * payments for the period.
   */
  crossSetOffForPeriodCents: number
  /**
   * "Federal input on raw materials claimable against <authority>": what of
   * the company's pool (federalCrossSetOff.availableCents, shared over the
   * provincial authorities in AUTHORITIES order) may still be set off against
   * what this authority is owed for the period. Never more than it is owed.
   */
  federalInputClaimableCents: number
  /** netAfterWithheldCents − crossSetOffForPeriodCents − federalInputClaimableCents: payable after the cross set-off. Negative = carried forward. */
  netAfterCrossSetOffCents: number
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

export type SupplyClass = 'standard' | 'zero_rated' | 'exempt' | 'custom' | 'delivery_charge' | 'deposit_forfeit'

/** The order the return lists supplies in, within an authority. Every SupplyClass is here. */
export const SUPPLY_ORDER: readonly SupplyClass[] = ['standard', 'custom', 'zero_rated', 'exempt', 'delivery_charge', 'deposit_forfeit']

/** How each supply class reads on the return screen and its CSV. */
export const SUPPLY_LABEL: Readonly<Record<SupplyClass, string>> = {
  standard: 'Standard-rated',
  custom: 'Own rate',
  zero_rated: 'Zero-rated',
  exempt: 'Exempt',
  delivery_charge: 'Delivery charges',
  deposit_forfeit: 'No-show deposits kept (pre-H10)',
}

export interface RateLine {
  authority: string
  /**
   * The item tax class: standard lines at the order's rate, custom at the
   * item's own, zero-rated / exempt at 0%; 'delivery_charge' = an order's
   * delivery fee at the order's rate (H9); 'deposit_forfeit' = a kept no-show
   * deposit captured under the PRE-H10 treatment (brand revenue, tax inside at
   * the brand's card rate). Since H10 a kept deposit is untaxed other income
   * (4210) and is not a supply — no row.
   */
  supply: SupplyClass
  /** Order.taxRatePct (standard, delivery), the item's rate (custom), 0 (zero-rated / exempt), the brand's card rate (deposits); null = an order priced before the rate was stored. */
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
  authority: AuthorityKey | WithholdingKey | StatutoryKey
  /** What the payment settles: a sales-tax authority, a withholding, or a statutory payroll challan (listed only on request). */
  kind: 'sales_tax' | 'withholding' | 'statutory'
  periodFrom: string
  periodTo: string
  paidAt: string
  paidCents: number
  inputSetOffCents: number
  /** Sales tax our clients withheld (1335) set off in this payment (H13). */
  customerWithheldSetOffCents: number
  /** Federal input on raw materials (1320) set off against this provincial authority (H8); 0 for others. */
  crossSetOffCents: number
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
  /** Sales-tax and withholding payments whose period overlaps this one (statutory challans are not listed). */
  payments: TaxPaymentRow[]
  /** Per-brand revenue plus delivery fees (4110). */
  taxableSalesCents: number
  /** Delivery fees (4110, Cr − Dr) booked in the period — a taxable supply of their own (H9). */
  deliveryFeesCents: number
  /** Per brand: its revenue account and its 4110 delivery fees (lines tagged with the brand). */
  taxableValueByConceptCents: Array<{ conceptSlug: string; conceptName: string; revenueCents: number; deliveryFeeCents: number }>
  /**
   * What is payable: each authority's own net AFTER customer-withheld tax
   * (netAfterWithheldCents), summed where positive — never one authority's
   * input or withholding against another's output.
   */
  netPayableCents: number
  /** Excess input (and withheld) tax per authority, carried forward with that authority (not a reduction of another's bill). */
  carryForwardCents: number
  /**
   * H8: federal input on raw materials that may be set off against provincial
   * output — the company's pool at the period's end (what is still available
   * after every set-off recorded) and the period's own figures.
   */
  federalCrossSetOff: FederalCrossSetOffPool & {
    /** Eligible federal input booked in the period. */
    eligibleInPeriodCents: number
    /** Σ crossSetOffForPeriodCents over the provincial authorities. */
    setOffForPeriodCents: number
    /** Σ federalInputClaimableCents — never more than availableCents. */
    claimableCents: number
  }
  /** Each authority's netAfterCrossSetOffCents, summed where positive: payable if the claimable federal input is set off. */
  netPayableAfterCrossSetOffCents: number
  notes: string[]              // operator-facing caveats
}

/** Every output sales-tax account the return files: FBR 2030 + PRA/SRB/KPRA/BRA. */
export const OUTPUT_TAX_CODES: string[] = AUTHORITY_LIST.map((a) => a.outputCode)

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
  deliveryFeeCents: true, deliveryFeeTaxCents: true,
  concept: { select: { slug: true, tenantId: true, province: true, srbPosId: true, taxRateCash: true, taxRateCard: true } },
  items: {
    select: {
      unitPriceCents: true, quantity: true, status: true,
      modifiers: { select: { priceDeltaCents: true } },
      menuItem: { select: { taxClassification: true, overrideTaxRate: true } },
    },
  },
} as const

export interface ReturnOrder {
  id: string
  conceptId: string
  status: string
  taxCents: number
  taxRatePct: number | null
  /** The delivery fee before tax and its GST (H9); 0 on a legacy order (the fee was not stored apart). */
  deliveryFeeCents: number
  deliveryFeeTaxCents: number
  concept: { slug: string; tenantId: string | null; province: string | null; srbPosId: number | null; taxRateCash: number; taxRateCard: number }
  items: Array<{
    unitPriceCents: number; quantity: number; status: string
    modifiers: Array<{ priceDeltaCents: number }>
    menuItem: { taxClassification: string; overrideTaxRate: number | null } | null
  }>
}

export interface SupplyPart {
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
 * item's own rate, zero-rated and exempt lines at 0%. The delivery fee is a
 * part of its own ('delivery_charge': the fee at the order's rate, with the
 * fee's stored GST — H9). The rest of the order's STORED tax (taxCents −
 * deliveryFeeTaxCents) is shared over the taxed item parts in proportion to
 * the tax each would bear, so the parts always add up to what the ledger
 * booked. A bill that carried item tax although none of its lines is taxed
 * today (an item reclassified after the sale) is declared as standard-rated:
 * tax was charged, so it is output.
 */
export function supplyParts(o: ReturnOrder): SupplyPart[] {
  // The fee's GST, never more than the order's whole tax (a malformed row
  // must not make the item parts negative).
  const feeCents = Math.max(0, o.deliveryFeeCents ?? 0)
  const feeTax = Math.min(Math.max(0, o.deliveryFeeTaxCents ?? 0), Math.max(0, o.taxCents))
  const itemTax = o.taxCents - feeTax
  const fee: SupplyPart[] = feeCents > 0 || feeTax > 0
    ? [{ supply: 'delivery_charge', ratePct: o.taxRatePct, valueCents: feeCents, taxCents: feeTax }]
    : []
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
    if (itemTax === 0) return [...list.map(({ weight: _w, ...p }) => p), ...fee]
    // Item tax on a bill none of whose lines is taxed today: declare it
    // standard — the item tax only, the fee keeps its own part.
    const valueCents = list.reduce((t, p) => t + p.valueCents, 0)
    return [{ supply: 'standard', ratePct: o.taxRatePct, valueCents, taxCents: itemTax }, ...fee]
  }
  shareOut(itemTax, taxed, (p, cents) => { p.taxCents = cents })
  return [...list.map(({ weight: _w, ...p }) => p), ...fee]
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
        ...DEPOSIT_CAPTURE_PREFIXES.map((p) => ({ reference: { startsWith: p } })),
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
    const authority = authorityOfOutput(accountCode).label
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
  // Kept no-show deposits. Since H10 (Hasnain, 2026-10-14) a capture credits
  // 4210 other income with NO output tax: not a supply, nothing declared.
  // A capture posted under the earlier treatment credited the brand's revenue
  // (the value) and its output-tax account (the tax inside, at the brand's
  // card rate) — it was declared that way and stays declared ('pre-H10'):
  // filed with the authority whose account it credited (routed through a
  // reclass like any sale); a reversal counts the other way. Old or new is
  // read from the entry itself (a tax line), so no date cut-off can misfile.
  const depositEntries = entries.filter((e) => DEPOSIT_CAPTURE_PREFIXES.some((p) => e.reference?.startsWith(p)))
  if (depositEntries.length > 0) {
    const depLines = await prisma.journalLine.findMany({
      where: { journalEntryId: { in: depositEntries.map((e) => e.id) }, type: 'credit' },
      select: { journalEntryId: true, amountCents: true, conceptId: true, account: { select: { code: true, type: true } } },
    })
    const reversalLines = await prisma.journalLine.findMany({
      where: { journalEntryId: { in: depositEntries.map((e) => e.id) }, type: 'debit' },
      select: { journalEntryId: true, amountCents: true, conceptId: true, account: { select: { code: true, type: true } } },
    })
    const conceptIds = [...new Set([...depLines, ...reversalLines].map((l) => l.conceptId).filter((x): x is string => !!x))]
    const rateOf = new Map(
      (conceptIds.length > 0
        ? await prisma.concept.findMany({ where: { id: { in: conceptIds }, tenantId }, select: { id: true, taxRateCard: true } })
        : []
      ).map((c) => [c.id, c.taxRateCard]),
    )
    for (const e of depositEntries) {
      const reversal = e.reference!.startsWith(DEPOSIT_CAPTURE_PREFIXES[1]!)
      // A capture credits revenue + tax; its reversal debits them.
      const own = (reversal ? reversalLines : depLines).filter((l) => l.journalEntryId === e.id)
      const taxLine = own.find((l) => OUTPUT_TAX_CODES.includes(l.account.code))
      if (!taxLine) continue // H10 (4210, no tax) — or a pre-H10 capture of a 0% brand: nothing to declare
      const value = own.filter((l) => l.account.type === 'revenue').reduce((t, l) => t + toCents(l.amountCents), 0)
      const tax = toCents(taxLine.amountCents)
      const conceptId = taxLine.conceptId
      const code = routed(taxLine.account.code, conceptId, e.entryDate)
      const authority = authorityOfOutput(code).label
      const ratePct = conceptId ? (rateOf.get(conceptId) ?? null) : null
      const key = `${authority}|deposit_forfeit|${ratePct ?? 'null'}|card`
      let l = lines.get(key)
      if (!l) {
        l = { authority, supply: 'deposit_forfeit', ratePct, tender: 'card', orders: 0, salesValueCents: 0, salesTaxCents: 0, refundValueCents: 0, refundTaxCents: 0, taxableValueCents: 0, taxCents: 0 }
        lines.set(key, l)
      }
      if (reversal) {
        l.refundValueCents += value
        l.refundTaxCents += tax
      } else {
        l.orders += 1
        l.salesValueCents += value
        l.salesTaxCents += tax
      }
    }
  }

  for (const l of lines.values()) {
    l.taxableValueCents = l.salesValueCents - l.refundValueCents
    l.taxCents = l.salesTaxCents - l.refundTaxCents
  }
  const order = (a: RateLine) => AUTHORITY_LIST.findIndex((x) => x.label === a.authority)
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

/**
 * Payments of `tenantId` whose period overlaps [from, to], oldest first: the
 * sales-tax authorities and the two withholdings (RETURN_PAYMENT_KEYS).
 * Statutory payroll challans (salary tax, EOBI, SESSI — the statutory page's)
 * are left out unless `opts.statutory` asks for them; every row says its kind.
 */
export async function taxPaymentsFor(tenantId: string, from: Date, to: Date, opts: { statutory?: boolean } = {}): Promise<TaxPaymentRow[]> {
  const rows = await prisma.salesTaxPayment.findMany({
    where: {
      tenantId, periodFrom: { lte: to }, periodTo: { gte: from },
      ...(opts.statutory ? {} : { authority: { in: [...RETURN_PAYMENT_KEYS] } }),
    },
    orderBy: [{ periodFrom: 'asc' }, { authority: 'asc' }],
  })
  const bankIds = [...new Set(rows.map((r) => r.bankAccountId).filter((x): x is string => !!x))]
  const banks = bankIds.length > 0
    ? await prisma.bankAccount.findMany({ where: { id: { in: bankIds }, tenantId }, select: { id: true, name: true } })
    : []
  const bankName = new Map(banks.map((b) => [b.id, b.name]))
  const cross = await crossSetOffByPayment(prisma, tenantId, rows)
  const kindOf = (a: string): TaxPaymentRow['kind'] =>
    isAuthorityKey(a) ? 'sales_tax' : WITHHOLDING.some((w) => w.key === a) ? 'withholding' : 'statutory'
  return rows.map((r) => ({
    id: r.id,
    authority: r.authority as TaxPaymentRow['authority'],
    kind: kindOf(r.authority),
    periodFrom: fmtPktDate(r.periodFrom),
    periodTo: fmtPktDate(r.periodTo),
    paidAt: fmtPktDate(r.paidAt),
    paidCents: toCents(r.paidCents),
    inputSetOffCents: toCents(r.inputSetOffCents),
    customerWithheldSetOffCents: toCents(r.customerWithheldSetOffCents),
    crossSetOffCents: cross.get(r.id) ?? 0,
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

/**
 * Sales tax our clients withheld from us in [from, to] (H13), per authority:
 * Dr − Cr on 1335 in the 'receivable.st_withheld:' entries (and their
 * reversals) dated in the period. Each entry's authority is its receipt's
 * (ReceivablePayment.taxAuthority — the output account the invoice's issue
 * entry credited); a receipt with no authority files with FBR.
 */
export async function withheldByCustomersIn(tenantId: string, from: Date, to: Date): Promise<Map<AuthorityKey, number>> {
  const out = new Map<AuthorityKey, number>(TAX_AUTHORITY_KEYS.map((k) => [k, 0]))
  const lines = await prisma.journalLine.findMany({
    where: {
      account: { tenantId, code: ACCT.ST_WITHHELD_BY_CUSTOMERS },
      journalEntry: {
        tenantId, entryDate: { gte: from, lte: to },
        OR: CUSTOMER_WITHHELD_PREFIXES.map((p) => ({ reference: { startsWith: p } })),
      },
    },
    select: { type: true, amountCents: true, journalEntry: { select: { reference: true } } },
  })
  if (lines.length === 0) return out
  // 'receivable.st_withheld[.reversal]:<paymentId>[@n]' → the receipt.
  const paymentIdOf = (ref: string | null): string | null => {
    const prefix = CUSTOMER_WITHHELD_PREFIXES.find((p) => ref?.startsWith(p))
    return prefix ? ref!.slice(prefix.length).split('@')[0]! : null
  }
  const ids = [...new Set(lines.map((l) => paymentIdOf(l.journalEntry.reference)).filter((x): x is string => !!x))]
  const receipts = await prisma.receivablePayment.findMany({ where: { id: { in: ids }, tenantId }, select: { id: true, taxAuthority: true } })
  const authorityOf = new Map(receipts.map((r) => [r.id, isAuthorityKey(r.taxAuthority) ? r.taxAuthority : 'fbr' as AuthorityKey]))
  for (const l of lines) {
    const id = paymentIdOf(l.journalEntry.reference)
    const key = (id && authorityOf.get(id)) || 'fbr'
    const amt = toCents(l.amountCents)
    out.set(key, (out.get(key) ?? 0) + (l.type === 'debit' ? amt : -amt))
  }
  return out
}

export async function salesTaxReturn(tenantId: string, from: Date, to: Date): Promise<SalesTaxReturnReport> {
  const returnCodes = [...AUTHORITY_LIST.flatMap((a) => [a.outputCode, a.inputCode]), ...WITHHOLDING.map((w) => w.account)]
  const accounts = await prisma.account.findMany({
    where: { tenantId, code: { in: returnCodes } },
    select: { code: true, name: true },
  })
  const named = (code: string) => accounts.find((a) => a.code === code)?.name ?? code

  const exclude = await notSettlement(prisma, [tenantId], from, to)
  const ledger = await Promise.all(AUTHORITY_LIST.map(async (a) => ({
    a,
    output: await netCreditCents(tenantId, a.outputCode, from, to, exclude),
    input:  0 - (await netCreditCents(tenantId, a.inputCode, from, to, exclude)),
  })))
  const of = (key: AuthorityKey) => ledger.find((l) => l.a.key === key)!
  const total = (side: 'output' | 'input') => ledger.reduce((t, l) => t + l[side], 0)

  // Balances at the period's end — everything charged and paid up to then.
  const balances = await creditBalancesAt(prisma, tenantId, returnCodes, to)
  const payments = await taxPaymentsFor(tenantId, from, to)
  const paidFor = (key: string) => payments.filter((p) => p.authority === key)
  const withheldByCustomers = await withheldByCustomersIn(tenantId, from, to)
  const withheldAvailable = new Map<AuthorityKey, number>(await Promise.all(
    TAX_AUTHORITY_KEYS.map(async (k) => [k, await customerWithheldAvailable(prisma, tenantId, k, to)] as [AuthorityKey, number]),
  ))

  // Every brand of the company, active or not, deleted or not — a brand
  // closed or removed mid-month still made taxable supplies in it.
  const concepts = await prisma.concept.findMany({
    where: { tenantId },
    select: { id: true, slug: true, name: true, province: true, srbPosId: true, isActive: true, deletedAt: true },
    orderBy: { createdAt: 'asc' },
  })

  // Per-concept revenue for the period
  const taxableByConcept: SalesTaxReturnReport['taxableValueByConceptCents'] = []
  let taxableSales = 0
  const revenueAccounts = await prisma.account.findMany({ where: { tenantId, type: 'revenue' }, select: { id: true, code: true } })
  // Delivery fees (4110, H9) per brand: the lines are tagged with the brand.
  const feeByConcept = new Map<string | null, number>()
  const feeAccount = revenueAccounts.find((a) => a.code === ACCT.DELIVERY_FEE_REVENUE)
  if (feeAccount) {
    const sums = await prisma.journalLine.groupBy({
      by: ['conceptId', 'type'], _sum: { amountCents: true },
      where: { accountId: feeAccount.id, journalEntry: { tenantId, entryDate: { gte: from, lte: to } } },
    })
    for (const x of sums) {
      const amt = sumCents(x._sum.amountCents)
      feeByConcept.set(x.conceptId, (feeByConcept.get(x.conceptId) ?? 0) + (x.type === 'credit' ? amt : -amt))
    }
  }
  const deliveryFeesCents = [...feeByConcept.values()].reduce((t, v) => t + v, 0)
  // A brand with no entry in the code map falls back to 4090 (Other/Catering),
  // and several brands can share it. The loop looked the account up per brand
  // and summed it each time, so 4090's revenue was counted once per unmapped
  // brand — over-declaring taxable sales, and therefore output GST, on a return
  // filed with FBR/SRB. Count each account at most once.
  const countedAccountIds = new Set<string>()
  const conceptIds = new Set(concepts.map((c) => c.id))
  for (const c of concepts) {
    // Find the matching 4xxx account by code-mapping in journal.ts (revenueCodeForConcept)
    const revAccount = revenueAccounts.find((a) => a.code === revenueCodeForConcept(c.slug))
    let revenue = 0
    if (revAccount && !countedAccountIds.has(revAccount.id)) {
      countedAccountIds.add(revAccount.id)
      const sums = await prisma.journalLine.groupBy({
        by: ['type'], _sum: { amountCents: true },
        where: { accountId: revAccount.id, journalEntry: { tenantId, entryDate: { gte: from, lte: to } } },
      })
      let debit = 0, credit = 0
      for (const x of sums) {
        if (x.type === 'debit') debit  = sumCents(x._sum.amountCents)
        else                     credit = sumCents(x._sum.amountCents)
      }
      revenue = Math.max(0, credit - debit)
    }
    const deliveryFeeCents = feeByConcept.get(c.id) ?? 0
    if (revenue > 0 || deliveryFeeCents !== 0) {
      taxableByConcept.push({ conceptSlug: c.slug, conceptName: c.name, revenueCents: revenue, deliveryFeeCents })
      taxableSales += revenue + deliveryFeeCents
    }
  }
  // 4110 lines with no brand of this company's (should not happen — order
  // postings tag the brand): declared on a row of their own so the per-brand
  // rows still add up to the total.
  const untaggedFees = [...feeByConcept.entries()].filter(([id]) => !id || !conceptIds.has(id)).reduce((t, [, v]) => t + v, 0)
  if (untaggedFees !== 0) {
    taxableByConcept.push({ conceptSlug: '', conceptName: 'Delivery fees (no brand)', revenueCents: 0, deliveryFeeCents: untaggedFees })
    taxableSales += untaggedFees
  }

  const reclasses = await reclassesIn(tenantId, from, to)
  const byRate = await rateBreakdown(tenantId, from, to, reclasses.target)
  const reclassification = await misroutedOutputTax(prisma, tenantId, from, to, concepts)
  const conceptName = new Map(concepts.map((c) => [c.id, c.name]))

  const byAuthority: AuthorityReturn[] = ledger.map(({ a, output, input }) => {
    const brands = concepts.filter((c) => outputTaxCodeFor(c) === a.outputCode).map((c) => c.slug)
    const fromOrders = byRate.filter((r) => r.authority === a.label).reduce((t, r) => t + r.taxCents, 0)
    const paid = paidFor(a.key)
    const withheld = withheldByCustomers.get(a.key) ?? 0
    return {
      key: a.key,
      authority: a.label,
      name: a.name,
      output: { code: a.outputCode, name: named(a.outputCode), totalCents: output },
      input:  { code: a.inputCode,  name: named(a.inputCode),  totalCents: input },
      netPayableCents: output - input,
      brands,
      otherOutputCents: output - fromOrders,
      paidForPeriodCents: paid.reduce((t, p) => t + p.paidCents, 0),
      inputSetOffForPeriodCents: paid.reduce((t, p) => t + p.inputSetOffCents, 0),
      withheldByCustomersCents: withheld,
      customerWithheldSetOffForPeriodCents: paid.reduce((t, p) => t + p.customerWithheldSetOffCents, 0),
      customerWithheldAvailableCents: withheldAvailable.get(a.key) ?? 0,
      netAfterWithheldCents: output - input - withheld,
      ledgerBalanceAtEndCents: balances.get(a.outputCode) ?? 0,
      inputLedgerBalanceAtEndCents: 0 - (balances.get(a.inputCode) ?? 0),
      crossSetOffForPeriodCents: paid.reduce((t, p) => t + p.crossSetOffCents, 0),
      federalInputClaimableCents: 0,
      netAfterCrossSetOffCents: 0,
    }
  }).filter((r) =>
    r.output.totalCents !== 0 || r.input.totalCents !== 0 || r.brands.length > 0
    || r.paidForPeriodCents !== 0 || r.inputSetOffForPeriodCents !== 0 || r.ledgerBalanceAtEndCents !== 0
    || r.withheldByCustomersCents !== 0 || r.customerWithheldSetOffForPeriodCents !== 0 || r.crossSetOffForPeriodCents !== 0)

  // H8: federal input on raw materials, set off against provincial output.
  // The company's pool at the period's end is shared over the provincial
  // authorities in AUTHORITIES order — never claimed twice — and each takes
  // at most what it is still owed for the period after set-offs already made.
  const [pool, eligibleInPeriodCents] = await Promise.all([
    federalCrossSetOffAvailable(prisma, tenantId, to),
    eligibleFederalInputCents(prisma, tenantId, from, to),
  ])
  let poolLeft = pool.availableCents
  for (const r of byAuthority) {
    const owed = r.netAfterWithheldCents - r.crossSetOffForPeriodCents
    if (crossSetOffAllowed(r.key) && owed > 0 && poolLeft > 0) {
      r.federalInputClaimableCents = Math.min(poolLeft, owed)
      poolLeft -= r.federalInputClaimableCents
    }
    r.netAfterCrossSetOffCents = owed - r.federalInputClaimableCents
  }
  const federalCrossSetOff: SalesTaxReturnReport['federalCrossSetOff'] = {
    ...pool,
    eligibleInPeriodCents,
    setOffForPeriodCents: byAuthority.reduce((t, r) => t + r.crossSetOffForPeriodCents, 0),
    claimableCents: byAuthority.reduce((t, r) => t + r.federalInputClaimableCents, 0),
  }
  const netPayableAfterCrossSetOffCents = byAuthority.reduce((t, r) => t + Math.max(0, r.netAfterCrossSetOffCents), 0)

  // Withheld in the period: payments left out (as for sales tax), and the
  // one-time statutory reclass too — it moves legacy salary tax out of 2040,
  // it is not income tax withheld from anyone.
  const withheldExclude: Prisma.JournalEntryWhereInput = {
    AND: [exclude, { OR: [{ reference: null }, { NOT: { reference: { startsWith: STATUTORY_RECLASS_PREFIX } } }] }],
  }
  const withholding: WithholdingReturn[] = await Promise.all(WITHHOLDING.map(async (w) => ({
    key: w.key,
    authority: w.authority,
    name: w.name,
    account: { code: w.account, name: named(w.account), totalCents: await netCreditCents(tenantId, w.account, from, to, withheldExclude) },
    paidForPeriodCents: paidFor(w.key).reduce((t, p) => t + p.paidCents, 0),
    ledgerBalanceAtEndCents: balances.get(w.account) ?? 0,
  })))

  // Each authority's own net after what clients withheld for it (H13): never
  // one authority's input or withholding against another's output.
  const netPayableCents   = byAuthority.reduce((t, r) => t + Math.max(0, r.netAfterWithheldCents), 0)
  const carryForwardCents = byAuthority.reduce((t, r) => t + Math.max(0, -r.netAfterWithheldCents), 0)

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
    notes.push('No input tax recorded. Input tax comes from "Tax charged by" on supplier bills and OpEx (and CapEx) payments — each charging authority\'s own input account (FBR 1320, PRA 1321, SRB 1322, KPRA 1323, BRA 1324). Check those documents name the tax and who charged it.')
  }
  const unclassed = byRate.filter((r) => r.supply === 'zero_rated' || r.supply === 'exempt')
  if (unclassed.length > 0) {
    notes.push('Zero-rated and exempt lines are declared on their own rows, at 0%, by each item\'s tax class as it is set today (Menu → item → tax class). "Total taxable sales" is ledger revenue and includes them.')
  }
  if (deliveryFeesCents !== 0 || byRate.some((r) => r.supply === 'delivery_charge')) {
    notes.push('Delivery charges are a taxable supply of their own: GST is added on top of the fee at the order\'s rate (15% cash, 8% card / Raast / online). They are declared on the "delivery_charge" rows, and the fee income (4110) is included in total taxable sales, per brand.')
  }
  if (byRate.some((r) => r.supply === 'deposit_forfeit')) {
    notes.push('pre-H10: the "deposit_forfeit" rows are no-show deposits kept under the earlier treatment (brand revenue with the tax inside, at the brand\'s card rate) — they stay declared as they were booked. Since H10 a kept deposit is untaxed compensation, booked to 4210 No-show Deposits Kept (other income), and is not on the return.')
  }
  if (byAuthority.some((r) => r.withheldByCustomersCents !== 0 || r.customerWithheldAvailableCents !== 0)) {
    notes.push('Sales tax our clients withheld from us as withholding agents (1335) is deducted from that same authority\'s net ("Net after withheld") — SRB withholding never reduces PRA\'s. Set it off when recording the payment ("Withheld tax set off"); what is still available is shown per authority.')
  }
  notes.push('Output and input are what was charged and recovered in the period. Tax paid to the authorities (payments recorded here, and entries linked as payments) is left out of them and shown under "Paid for this period"; "Ledger balance at period end" is what the books still owe after every charge and payment up to then.')
  notes.push('Input tax is set off against the same authority\'s output. The one exception (H8, as per SRB eligibility): federal input (1320) on supplier bills for raw materials — stock of the classes ' + CROSS_SETOFF_ELIGIBLE_CLASSES.join(' and ') + ' — may also be set off against a provincial authority\'s output ("Federal input on raw materials claimable against …", and "Net after federal input"). It is one pool per company: what was set off once is never claimed again, for any period or authority, and what FBR is owed takes 1320 first. Set it off when recording the payment ("Federal input set off"). Whether any other input is admissible (e.g. restaurant services at a reduced rate) is for your CA.')
  notes.push('Per-rate figures: sales are the orders booked in the period (online orders on completion, till orders on their drawer\'s close), less the tax the period\'s refunds reversed. Value is the pre-discount item value. "otherOutputCents" is ledger output tax not explained by them (manual journals, B2B invoices, older entries).')
  notes.push('Supplies are classed by item tax class (standard / custom / zero-rated / exempt), with delivery charges on their own rows. Kept no-show deposits are other income (4210, H10), not a supply. Adjust with your CA before filing.')
  notes.push('Withholding lists income tax withheld from vendors (2040) and sales tax withheld as an agent (2041). Salary tax, EOBI and SESSI are statutory payroll challans — see Statutory Payments.')

  return {
    tenantId,
    period: { from: fmtPktDate(from), to: fmtPktDate(to) },
    outputTax: {
      fbr:  { code: AUTHORITIES.fbr.outputCode,  name: named(AUTHORITIES.fbr.outputCode),  totalCents: of('fbr').output },
      pra:  { code: AUTHORITIES.pra.outputCode,  name: named(AUTHORITIES.pra.outputCode),  totalCents: of('pra').output },
      srb:  { code: AUTHORITIES.srb.outputCode,  name: named(AUTHORITIES.srb.outputCode),  totalCents: of('srb').output },
      kpra: { code: AUTHORITIES.kpra.outputCode, name: named(AUTHORITIES.kpra.outputCode), totalCents: of('kpra').output },
      bra:  { code: AUTHORITIES.bra.outputCode,  name: named(AUTHORITIES.bra.outputCode),  totalCents: of('bra').output },
      totalCents: total('output'),
    },
    inputTax: {
      fbr:  { code: AUTHORITIES.fbr.inputCode,  name: named(AUTHORITIES.fbr.inputCode),  totalCents: of('fbr').input },
      pra:  { code: AUTHORITIES.pra.inputCode,  name: named(AUTHORITIES.pra.inputCode),  totalCents: of('pra').input },
      srb:  { code: AUTHORITIES.srb.inputCode,  name: named(AUTHORITIES.srb.inputCode),  totalCents: of('srb').input },
      kpra: { code: AUTHORITIES.kpra.inputCode, name: named(AUTHORITIES.kpra.inputCode), totalCents: of('kpra').input },
      bra:  { code: AUTHORITIES.bra.inputCode,  name: named(AUTHORITIES.bra.inputCode),  totalCents: of('bra').input },
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
    deliveryFeesCents,
    taxableValueByConceptCents: taxableByConcept,
    netPayableCents,
    carryForwardCents,
    federalCrossSetOff,
    netPayableAfterCrossSetOffCents,
    notes,
  }
}
