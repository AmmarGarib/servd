// Financial reports built from the journal — the ledger is the source of truth.
//
// Every report aggregates JournalLine rows by account; nothing reads from
// FinancialEntry or Order tables. If it isn't in the ledger, it isn't in the
// report. This is the property that lets the trial balance prove correctness:
// sum(debits) − sum(credits) across every account in scope MUST equal zero.

import type { AccountType, Prisma, PrismaClient } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { ACCT } from './journal.js'
import { fmtPktDate } from './dates.js'
import { sumCents, toCents, type DbMoney } from '../../lib/money.js'
import { fiscalYearsFor, type CompanyFiscalYear } from './fiscalYear.js'
import { ASSET_CLASS_DEFAULTS } from '../fixedAssets/classes.js'
import { costClassOf } from '../../lib/inventoryClass.js'

type Db = Prisma.TransactionClient | PrismaClient

// ─── Revenue groups (one definition for every report) ───────────────────────
//
//   40xx  brand sales (each brand's own account — Concept.revenueAccountCode:
//         legacy 4001–4007, new brands 4010–4089; 4090 fallback) — the sales KPIs
//   4100  service charge, 4110 delivery fees — still sales (operating revenue)
//   42xx  OTHER INCOME (4200 gift-card breakage, H11) — shown below operating
//         revenue and kept out of every sales KPI (revenue cards, food-cost
//         and labour denominators)

/** Brand sales accounts: 40xx. */
export function isBrandSalesCode(code: string): boolean {
  return /^40\d\d$/.test(code)
}

/** Other income (42xx): below operating revenue, never a sales KPI. */
export function isOtherIncomeCode(code: string): boolean {
  return code.startsWith('42')
}

/** The contra accounts netted off brand sales for the cost-of-sales denominator: discounts and loyalty redemptions. */
export const BRAND_SALES_CONTRA_CODES: readonly string[] = [ACCT.DISCOUNTS, ACCT.LOYALTY_REDEMPTIONS]

/** One line's effect on brand sales, credit-positive (0 for every other account). */
function brandSalesEffect(code: string, type: 'debit' | 'credit', cents: number): number {
  if (isBrandSalesCode(code)) return type === 'credit' ? cents : -cents
  if (BRAND_SALES_CONTRA_CODES.includes(code)) return type === 'debit' ? -cents : cents
  return 0
}

/** Depreciation and impairment (FA): shown as their own P&L lines (still inside opex). */
const DEPRECIATION_CODES: readonly string[] = [ACCT.DEPRECIATION]
const IMPAIRMENT_CODES: readonly string[] = [ACCT.IMPAIRMENT]

// Asset & expense accounts increase on the debit side; liability, equity, and
// revenue accounts increase on the credit side. "Balance" is always expressed
// in the account's natural direction so the numbers read positively.
const DEBIT_NORMAL: AccountType[] = ['asset', 'expense']
const CREDIT_NORMAL: AccountType[] = ['liability', 'equity', 'revenue']

function naturalBalanceCents(type: AccountType, debits: number, credits: number): number {
  if (DEBIT_NORMAL.includes(type)) return debits - credits
  if (CREDIT_NORMAL.includes(type)) return credits - debits
  return debits - credits
}

interface AccountAggregation {
  accountId: string
  // The company whose chart the account is in. In "All companies" view the
  // same code appears once per company, so every row carries its company.
  tenantId: string | null
  code: string
  name: string
  type: AccountType
  debitCents: number
  creditCents: number
  balanceCents: number
}

/** A company in the report's scope, for labelling rows. */
export interface ReportCompany { id: string; name: string }

/** The companies in scope, by name — what each row's `companyName` reads. */
async function companiesInScope(tenantIds: string[]): Promise<ReportCompany[]> {
  if (tenantIds.length === 0) return []
  const rows = await prisma.tenant.findMany({ where: { id: { in: tenantIds } }, select: { id: true, name: true } })
  return rows.sort((a, b) => a.name.localeCompare(b.name))
}

/** Order rows by company (name) then account code: one company's accounts together. */
function byCompanyThenCode<T extends { companyName: string | null; code: string }>(a: T, b: T): number {
  return (a.companyName ?? '').localeCompare(b.companyName ?? '') || a.code.localeCompare(b.code)
}

// Pulls all journal lines in the date range, grouped by account.
//
// `tenantIds` is the company scope: one company in normal view, every company
// the operator belongs to in "All companies". Each company keeps its own books,
// so a report that didn't filter would silently consolidate two sets of
// accounts that happen to share code numbers.
async function aggregateByAccount(opts: {
  tenantIds: string[]
  dateFrom?: Date
  dateTo?: Date
  upTo?: Date
}): Promise<AccountAggregation[]> {
  const where: Prisma.JournalLineWhereInput = {
    journalEntry: { tenantId: { in: opts.tenantIds } },
  }
  if (opts.dateFrom || opts.dateTo || opts.upTo) {
    where.journalEntry = {
      tenantId: { in: opts.tenantIds },
      entryDate: {
        ...(opts.dateFrom && { gte: opts.dateFrom }),
        ...(opts.dateTo && { lte: opts.dateTo }),
        ...(opts.upTo && !opts.dateTo && { lte: opts.upTo }),
      },
    }
  }

  const grouped = await prisma.journalLine.groupBy({
    by: ['accountId', 'type'],
    _sum: { amountCents: true },
    where,
  })

  // Need account metadata for code/name/type
  const accountIds = Array.from(new Set(grouped.map((g) => g.accountId)))
  const accounts = await prisma.account.findMany({
    where: { id: { in: accountIds } },
    select: { id: true, tenantId: true, code: true, name: true, type: true },
  })
  const accountMap = new Map(accounts.map((a) => [a.id, a]))

  // Bucket
  const bucket = new Map<string, { debit: number; credit: number }>()
  for (const row of grouped) {
    const slot = bucket.get(row.accountId) ?? { debit: 0, credit: 0 }
    if (row.type === 'debit') slot.debit  += sumCents(row._sum.amountCents)
    else                       slot.credit += sumCents(row._sum.amountCents)
    bucket.set(row.accountId, slot)
  }

  const out: AccountAggregation[] = []
  for (const [accountId, sums] of bucket.entries()) {
    const acc = accountMap.get(accountId)
    if (!acc) continue
    out.push({
      accountId,
      tenantId: acc.tenantId,
      code: acc.code,
      name: acc.name,
      type: acc.type,
      debitCents: sums.debit,
      creditCents: sums.credit,
      balanceCents: naturalBalanceCents(acc.type, sums.debit, sums.credit),
    })
  }

  out.sort((a, b) => a.code.localeCompare(b.code))
  return out
}

// ─── Fiscal-year split (H29: virtual roll-forward) ───────────────────────────
//
// No closing journal is ever posted: each company's P&L before the start of
// its fiscal year (the year that contains the report's asOf, by the company's
// own Tenant.fiscalYearEndMonth) IS its retained earnings brought forward, and
// the rest up to asOf is the profit for the year to date. Reopening a closed
// year needs nothing reversed.

/** Each company's P&L account activity BEFORE its fiscal year (containing asOf) starts. */
async function pnlBeforeFiscalYear(years: CompanyFiscalYear[]): Promise<AccountAggregation[]> {
  const byStart = new Map<number, string[]>()
  for (const y of years) byStart.set(y.start.getTime(), [...(byStart.get(y.start.getTime()) ?? []), y.tenantId])
  const out: AccountAggregation[] = []
  for (const [start, ids] of byStart) {
    const rows = await aggregateByAccount({ tenantIds: ids, dateTo: new Date(start - 1) })
    out.push(...rows.filter((r) => r.type === 'revenue' || r.type === 'expense'))
  }
  return out
}

/** Credit-positive P&L result of some account rows (revenue − expense). */
const pnlResultCents = (rows: AccountAggregation[]) => rows.reduce((s, r) => s + (r.creditCents - r.debitCents), 0)

export interface ReportFiscalYear { tenantId: string; endMonth: number; start: string; end: string; label: string }

const fiscalYearOut = (y: CompanyFiscalYear): ReportFiscalYear => ({
  tenantId: y.tenantId, endMonth: y.endMonth, start: fmtPktDate(y.start), end: fmtPktDate(y.end), label: y.label,
})

// ─── Trial balance ──────────────────────────────────────────────────────────
// Lists every account with a balance at asOf — ONE net figure per account, in
// the Debit column (debits exceed credits) or the Credit column, never both;
// accounts at zero are left out. The Δ at the bottom MUST be zero — that's
// what proves the books are balanced.
//
// basis 'inception' (the API default): every account since the first entry.
// basis 'year' (the admin page's default): balance-sheet accounts since
// inception, revenue and expense accounts from each company's fiscal-year
// start, plus ONE computed row per company — 'Retained earnings b/f' — holding
// the P&L before that start. The removed debits and credits net exactly to
// that row, so the trial balance still balances.

export type TrialBalanceBasis = 'inception' | 'year'

export interface TrialBalanceRow {
  tenantId: string | null
  companyName: string | null
  code: string
  name: string
  type: AccountType
  debitCents: number
  creditCents: number
  /** True on the computed 'Retained earnings b/f' row (year basis) — no account behind it. */
  virtual?: boolean
}

export interface TrialBalanceReport {
  asOf: string
  basis: TrialBalanceBasis
  /** Companies in scope. More than one = "All companies" view: read each row's company. */
  companies: ReportCompany[]
  /** Each company's fiscal year at asOf (year basis: its P&L rows start at `start`). */
  fiscalYears: ReportFiscalYear[]
  rows: TrialBalanceRow[]
  totals: { debitCents: number; creditCents: number; differenceCents: number }
  /** Each company's own books, which must balance on their own. */
  companyTotals: Array<{ tenantId: string; name: string; debitCents: number; creditCents: number; differenceCents: number }>
}

/** The code the computed brought-forward row shows under (3020 Retained earnings, starred: not the account itself). */
export const RETAINED_BF_CODE = '3020*'

export async function trialBalance(tenantIds: string[], asOf: Date, opts: { basis?: TrialBalanceBasis } = {}): Promise<TrialBalanceReport> {
  const basis: TrialBalanceBasis = opts.basis ?? 'inception'
  const [agg, companies, years] = await Promise.all([
    aggregateByAccount({ tenantIds, upTo: asOf }),
    companiesInScope(tenantIds),
    fiscalYearsFor(prisma, tenantIds, asOf),
  ])
  const nameOf = new Map(companies.map((c) => [c.id, c.name]))
  let accountRows = agg
  const virtualRows: TrialBalanceRow[] = []
  if (basis === 'year') {
    const before = await pnlBeforeFiscalYear(years)
    const beforeOf = new Map(before.map((b) => [b.accountId, b]))
    accountRows = agg
      .map((r) => {
        const b = beforeOf.get(r.accountId)
        return b ? { ...r, debitCents: r.debitCents - b.debitCents, creditCents: r.creditCents - b.creditCents } : r
      })
      .filter((r) => r.debitCents !== 0 || r.creditCents !== 0)
    for (const y of years) {
      const net = pnlResultCents(before.filter((b) => b.tenantId === y.tenantId))
      // A company in its first fiscal year has nothing brought forward: no
      // zero row (accounts at zero are not listed).
      if (net === 0) continue
      virtualRows.push({
        tenantId: y.tenantId,
        companyName: nameOf.get(y.tenantId) ?? null,
        code: RETAINED_BF_CODE,
        name: `Retained earnings b/f (${net < 0 ? 'loss' : 'profit'} before ${fmtPktDate(y.start)})`,
        type: 'equity',
        debitCents: net < 0 ? -net : 0,
        creditCents: net > 0 ? net : 0,
        virtual: true,
      })
    }
  }
  // One row per (company, account) — account rows are already per company,
  // so "All companies" lists GS Foods' 2030 and GSX Viva's 2030 separately,
  // each labelled, never two indistinguishable rows.
  // ONE net balance per account (owner, 2026-10-16): debits − credits in the
  // Debit column when positive, in the Credit column when negative — never
  // both — and an account whose balance is zero is not listed (a cleared
  // account such as 1357 drops off). Σ debit − Σ credit is unchanged, so the
  // totals still balance. The computed b/f rows are already one-sided.
  const rows: TrialBalanceRow[] = [
    ...accountRows
      .map((r) => {
        const net = r.debitCents - r.creditCents
        return {
          tenantId: r.tenantId,
          companyName: r.tenantId ? (nameOf.get(r.tenantId) ?? null) : null,
          code: r.code, name: r.name, type: r.type,
          debitCents: net > 0 ? net : 0,
          creditCents: net < 0 ? -net : 0,
        }
      })
      .filter((r) => r.debitCents !== 0 || r.creditCents !== 0),
    ...virtualRows,
  ].sort(byCompanyThenCode)
  const totals = rows.reduce(
    (s, r) => ({ debitCents: s.debitCents + r.debitCents, creditCents: s.creditCents + r.creditCents }),
    { debitCents: 0, creditCents: 0 },
  )
  const companyTotals = companies.map((c) => {
    const mine = rows.filter((r) => r.tenantId === c.id)
    const debitCents = mine.reduce((s, r) => s + r.debitCents, 0)
    const creditCents = mine.reduce((s, r) => s + r.creditCents, 0)
    return { tenantId: c.id, name: c.name, debitCents, creditCents, differenceCents: debitCents - creditCents }
  })
  return {
    asOf: fmtPktDate(asOf),
    basis,
    companies,
    fiscalYears: years.map(fiscalYearOut),
    rows,
    totals: { ...totals, differenceCents: totals.debitCents - totals.creditCents },
    companyTotals,
  }
}

// ─── Balance sheet ──────────────────────────────────────────────────────────
// Snapshot at a point in time: assets = liabilities + equity. Revenue/expense
// balances roll into equity as two lines per company (virtual roll-forward,
// H29): 'Retained earnings b/f' (P&L before the company's fiscal-year start)
// and 'Profit for the year to date' (the rest, up to asOf). Their sum is
// totals.currentEarningsCents, so differenceCents is what it always was.
//
// "All companies" lists each company's own rows: inter-company Due from / Due
// to balances are shown GROSS (one company's receivable, the other's payable),
// never eliminated — this is not a consolidation.

type BalanceRow = { tenantId: string | null; companyName: string | null; code: string; name: string; balanceCents: number }

export interface BalanceSheetEarnings {
  tenantId: string
  companyName: string
  fiscalYear: ReportFiscalYear
  /** P&L before the fiscal year started — 'Retained earnings b/f'. */
  retainedEarningsBroughtForwardCents: number
  /** P&L from the fiscal-year start to asOf — 'Profit for the year to date'. */
  currentYearEarningsCents: number
}

export interface BalanceSheetPpeRow {
  tenantId: string | null
  companyName: string | null
  /** The asset class key ('legacy' = 1590, accumulated before classes existed). */
  classKey: string
  label: string
  costCode: string | null
  accumCode: string | null
  costCents: number
  /** Accumulated depreciation and impairment, as a positive figure. */
  accumulatedCents: number
  netCents: number
}

export interface BalanceSheetReport {
  asOf: string
  /** Companies in scope. More than one = "All companies" view: read each row's company. */
  companies: ReportCompany[]
  assets:      BalanceRow[]
  liabilities: BalanceRow[]
  equity:      BalanceRow[]
  /** Per company: retained earnings b/f and profit for the year to date (virtual roll-forward). */
  earningsByCompany: BalanceSheetEarnings[]
  /** Property, plant & equipment per company and asset class (FA): cost, accumulated, net. A view of asset rows above. */
  ppe: BalanceSheetPpeRow[]
  totals: {
    assetsCents: number
    liabilitiesCents: number
    equityCents: number
    retainedEarningsBroughtForwardCents: number
    currentYearEarningsCents: number
    currentEarningsCents: number   // revenue − expenses since inception = b/f + year to date (rolls into equity)
    differenceCents: number        // should be 0
  }
}

/** Fixed-asset classes per company (the company's own codes, else the template). */
async function ppeClassesFor(tenantIds: string[]): Promise<Map<string, Array<{ key: string; label: string; costCode: string; accumCode: string | null }>>> {
  const rows = tenantIds.length === 0 ? [] : await prisma.fixedAssetClass.findMany({
    where: { tenantId: { in: tenantIds } },
    select: { tenantId: true, key: true, label: true, costAccountCode: true, accumAccountCode: true, sortOrder: true },
    orderBy: { sortOrder: 'asc' },
  })
  const out = new Map<string, Array<{ key: string; label: string; costCode: string; accumCode: string | null }>>()
  for (const t of tenantIds) {
    const own = rows.filter((r) => r.tenantId === t)
    out.set(t, own.length > 0
      ? own.map((r) => ({ key: r.key, label: r.label, costCode: r.costAccountCode, accumCode: r.accumAccountCode }))
      : ASSET_CLASS_DEFAULTS.map((c) => ({ key: c.key, label: c.label, costCode: c.costAccountCode, accumCode: c.accumAccountCode })))
  }
  return out
}

export async function balanceSheet(tenantIds: string[], asOf: Date): Promise<BalanceSheetReport> {
  const [rows, companies, years, classes] = await Promise.all([
    aggregateByAccount({ tenantIds, upTo: asOf }),
    companiesInScope(tenantIds),
    fiscalYearsFor(prisma, tenantIds, asOf),
    ppeClassesFor(tenantIds),
  ])
  const nameOf = new Map(companies.map((c) => [c.id, c.name]))
  const section = (type: AccountType): BalanceRow[] => rows
    .filter((r) => r.type === type)
    .map((r) => ({
      tenantId: r.tenantId,
      companyName: r.tenantId ? (nameOf.get(r.tenantId) ?? null) : null,
      code: r.code, name: r.name, balanceCents: r.balanceCents,
    }))
    .sort(byCompanyThenCode)

  const assets = section('asset')
  const liabilities = section('liability')
  const equity = section('equity')

  const revenueCents = rows.filter((r) => r.type === 'revenue').reduce((s, r) => s + r.balanceCents, 0)
  const expenseCents = rows.filter((r) => r.type === 'expense').reduce((s, r) => s + r.balanceCents, 0)
  const currentEarningsCents = revenueCents - expenseCents

  // Virtual roll-forward, per company on its own fiscal year.
  const before = await pnlBeforeFiscalYear(years)
  const pnlRows = rows.filter((r) => r.type === 'revenue' || r.type === 'expense')
  const earningsByCompany: BalanceSheetEarnings[] = years
    .map((y) => {
      const bf = pnlResultCents(before.filter((b) => b.tenantId === y.tenantId))
      const sinceInception = pnlResultCents(pnlRows.filter((r) => r.tenantId === y.tenantId))
      return {
        tenantId: y.tenantId,
        companyName: nameOf.get(y.tenantId) ?? '',
        fiscalYear: fiscalYearOut(y),
        retainedEarningsBroughtForwardCents: bf,
        currentYearEarningsCents: sinceInception - bf,
      }
    })
    .sort((a, b) => a.companyName.localeCompare(b.companyName))
  const retainedEarningsBroughtForwardCents = earningsByCompany.reduce((s, e) => s + e.retainedEarningsBroughtForwardCents, 0)
  // Whatever no company owns (a company-less legacy account) stays in the year's line, so the two always sum to the total.
  const currentYearEarningsCents = currentEarningsCents - retainedEarningsBroughtForwardCents

  // PPE per class (FA): cost and accumulated per company and class.
  const ppe: BalanceSheetPpeRow[] = []
  for (const c of companies) {
    const mine = assets.filter((a) => a.tenantId === c.id)
    const bal = (code: string | null) => (code ? mine.filter((a) => a.code === code).reduce((s, a) => s + a.balanceCents, 0) : 0)
    for (const k of classes.get(c.id) ?? []) {
      const costCents = bal(k.costCode)
      const accumulatedCents = -bal(k.accumCode)
      if (costCents === 0 && accumulatedCents === 0) continue
      ppe.push({ tenantId: c.id, companyName: c.name, classKey: k.key, label: k.label, costCode: k.costCode, accumCode: k.accumCode, costCents, accumulatedCents, netCents: costCents - accumulatedCents })
    }
    const legacy = -bal(ACCT.ACC_DEP_LEGACY)
    if (legacy !== 0) {
      ppe.push({ tenantId: c.id, companyName: c.name, classKey: 'legacy', label: 'Accumulated depreciation (before asset classes)', costCode: null, accumCode: ACCT.ACC_DEP_LEGACY, costCents: 0, accumulatedCents: legacy, netCents: -legacy })
    }
  }

  const assetsCents      = assets.reduce((s, r) => s + r.balanceCents, 0)
  const liabilitiesCents = liabilities.reduce((s, r) => s + r.balanceCents, 0)
  const equityCents      = equity.reduce((s, r) => s + r.balanceCents, 0)

  return {
    asOf: fmtPktDate(asOf),
    companies,
    assets,
    liabilities,
    equity,
    earningsByCompany,
    ppe,
    totals: {
      assetsCents,
      liabilitiesCents,
      equityCents,
      retainedEarningsBroughtForwardCents,
      currentYearEarningsCents,
      currentEarningsCents,
      differenceCents: assetsCents - liabilitiesCents - equityCents - currentEarningsCents,
    },
  }
}

// ─── Profit & loss (from ledger) ────────────────────────────────────────────
// Replaces the FinancialEntry-based P&L. Groups revenue and expense balances
// over a date range, with a per-concept revenue breakdown (4001-409x).
//
// Operating revenue is every revenue account EXCEPT 42xx, which is shown as
// OTHER INCOME below the operating result (4200 gift-card breakage, H11) and
// never counts in revenue, margins or any sales KPI. Net profit includes it.
// Depreciation (6150) and impairment (6155) stay inside opex and are also
// given as their own totals (FA).

export interface ProfitAndLossReport {
  dateFrom: string
  dateTo: string
  revenue: { code: string; name: string; amountCents: number }[]
  cogs:    { code: string; name: string; amountCents: number }[]
  opex:    { code: string; name: string; amountCents: number }[]
  contraRevenue: { code: string; name: string; amountCents: number }[]
  /** 42xx — below the operating result, never in revenue. */
  otherIncome: { code: string; name: string; amountCents: number }[]
  totals: {
    revenueCents: number
    cogsCents: number
    grossProfitCents: number
    grossMarginPct: number  // 0–100
    opexCents: number
    /** Of opexCents: depreciation (6150) and impairment (6155). */
    depreciationCents: number
    impairmentCents: number
    contraRevenueCents: number
    /** Gross profit − opex, before other income. */
    operatingProfitCents: number
    otherIncomeCents: number
    netProfitCents: number
  }
}

const COGS_PREFIX = '5'
const CONTRA_REVENUE_PREFIX = '7'

export async function profitAndLoss(tenantIds: string[], dateFrom: Date, dateTo: Date): Promise<ProfitAndLossReport> {
  const rows = await aggregateByAccount({ tenantIds, dateFrom, dateTo })

  const revenueRows = rows.filter((r) => r.type === 'revenue')
  const revenue = revenueRows
    .filter((r) => !isOtherIncomeCode(r.code))
    .map((r) => ({ code: r.code, name: r.name, amountCents: r.balanceCents }))
  const otherIncome = revenueRows
    .filter((r) => isOtherIncomeCode(r.code))
    .map((r) => ({ code: r.code, name: r.name, amountCents: r.balanceCents }))

  const expenses = rows.filter((r) => r.type === 'expense')
  const cogs = expenses
    .filter((r) => r.code.startsWith(COGS_PREFIX))
    .map((r) => ({ code: r.code, name: r.name, amountCents: r.balanceCents }))
  const contraRevenue = expenses
    .filter((r) => r.code.startsWith(CONTRA_REVENUE_PREFIX))
    .map((r) => ({ code: r.code, name: r.name, amountCents: r.balanceCents }))
  const opex = expenses
    .filter((r) => !r.code.startsWith(COGS_PREFIX) && !r.code.startsWith(CONTRA_REVENUE_PREFIX))
    .map((r) => ({ code: r.code, name: r.name, amountCents: r.balanceCents }))

  const revenueCents       = revenue.reduce((s, r) => s + r.amountCents, 0)
  const otherIncomeCents   = otherIncome.reduce((s, r) => s + r.amountCents, 0)
  const cogsCents          = cogs.reduce((s, r) => s + r.amountCents, 0)
  const opexCents          = opex.reduce((s, r) => s + r.amountCents, 0)
  const contraRevenueCents = contraRevenue.reduce((s, r) => s + r.amountCents, 0)
  const depreciationCents  = opex.filter((r) => DEPRECIATION_CODES.includes(r.code)).reduce((s, r) => s + r.amountCents, 0)
  const impairmentCents    = opex.filter((r) => IMPAIRMENT_CODES.includes(r.code)).reduce((s, r) => s + r.amountCents, 0)

  const grossProfitCents     = revenueCents - cogsCents - contraRevenueCents
  const operatingProfitCents = grossProfitCents - opexCents
  const netProfitCents       = operatingProfitCents + otherIncomeCents
  const grossMarginPct       = revenueCents > 0 ? (grossProfitCents / revenueCents) * 100 : 0

  return {
    dateFrom: fmtPktDate(dateFrom),
    dateTo: fmtPktDate(dateTo),
    revenue,
    cogs,
    opex,
    contraRevenue,
    otherIncome,
    totals: {
      revenueCents,
      cogsCents,
      grossProfitCents,
      grossMarginPct: Number(grossMarginPct.toFixed(2)),
      opexCents,
      depreciationCents,
      impairmentCents,
      contraRevenueCents,
      operatingProfitCents,
      otherIncomeCents,
      netProfitCents,
    },
  }
}

// ─── Per-brand P&L components (measured from tagged lines) ───────────────────
// Groups journal lines by their conceptId so each brand's revenue, COGS and
// discounts are MEASURED from the ledger, not estimated by revenue share. Lines
// with a null conceptId (shared overhead, manual entries) land in the `null`
// bucket; the brand report allocates that remainder across brands.
// revenueCents is operating revenue (42xx other income is apart, in
// otherIncomeCents).

export interface ConceptPnlBucket {
  conceptId: string | null // null = shared / unallocated
  revenueCents: number
  cogsCents: number
  contraRevenueCents: number
  opexCents: number
  otherIncomeCents: number
}

export async function pnlByConcept(tenantIds: string[], dateFrom: Date, dateTo: Date): Promise<ConceptPnlBucket[]> {
  const grouped = await prisma.journalLine.groupBy({
    by: ['conceptId', 'accountId', 'type'],
    _sum: { amountCents: true },
    where: { journalEntry: { tenantId: { in: tenantIds }, entryDate: { gte: dateFrom, lte: dateTo } } },
  })

  const accountIds = Array.from(new Set(grouped.map((g) => g.accountId)))
  const accounts = await prisma.account.findMany({
    where: { id: { in: accountIds } },
    select: { id: true, code: true, type: true },
  })
  const accMap = new Map(accounts.map((a) => [a.id, a]))

  const buckets = new Map<string, ConceptPnlBucket>()
  const ensure = (c: string | null): ConceptPnlBucket => {
    const k = c ?? '__shared__'
    let b = buckets.get(k)
    if (!b) {
      b = { conceptId: c, revenueCents: 0, cogsCents: 0, contraRevenueCents: 0, opexCents: 0, otherIncomeCents: 0 }
      buckets.set(k, b)
    }
    return b
  }

  for (const row of grouped) {
    const acc = accMap.get(row.accountId)
    if (!acc) continue
    const amt = sumCents(row._sum.amountCents)
    if (amt === 0) continue
    const b = ensure(row.conceptId)
    if (acc.type === 'revenue') {
      const signed = row.type === 'credit' ? amt : -amt
      if (isOtherIncomeCode(acc.code)) b.otherIncomeCents += signed
      else b.revenueCents += signed
    } else if (acc.type === 'expense') {
      const signed = row.type === 'debit' ? amt : -amt // expense increases on debit
      if (acc.code.startsWith(COGS_PREFIX)) b.cogsCents += signed
      else if (acc.code.startsWith(CONTRA_REVENUE_PREFIX)) b.contraRevenueCents += signed
      else b.opexCents += signed
    }
    // asset / liability / equity lines are not part of the P&L
  }

  return Array.from(buckets.values())
}

// ─── Brand sales and cost of sales — THE food-cost definition ────────────────
//
// ONE denominator and ONE class split for every cost-of-sales ratio (the brand
// P&L below, the management dashboards and the food-cost variance report import
// these — never a second copy):
//
//   brandSalesRevenueCents = brand sales 40xx (every brand's own account) net of
//     7010 discounts and 7020 loyalty redemptions. 4100 service charge, 4110
//     delivery fees and 42xx other income are NOT brand sales.
//   costOfSalesSplit = { food, drinks, packaging }:
//     5010 / 5020 / 5030 directly; the class-less 5040 waste, 5050 count
//     variance and 5060 cost adjustment split by the cost class of the stock
//     behind each entry — the class inventory lines (1210 / 1220 / 1230) the
//     same entry moved (written from the StockMovement rows' costClass) — or,
//     when it moved none, the class cost line (5010 / 5020 / 5030) on the
//     stock side (a sold-line waste whose cost was already booked) — and for
//     a 5060 with no stock line the GrniMatch bill line's (or the written-
//     off receipt line's) item class. An approved stock difference (H20,
//     approved line by line) takes its OWN 1290 line's class: its pair in the
//     waste / count entry, or the waste log a sold-line waste line names
//     (clearedLineClass). Only an untraceable remainder (pre-FIFO entries)
//     stays in food. A packaging count GAIN or LOSS (a missed or
//     wrong "Box given") therefore shows on packaging, never inside food.

export interface CostOfSalesSplit { foodCents: number; drinksCents: number; packagingCents: number }
type CosKey = keyof CostOfSalesSplit

const DIRECT_COS: Readonly<Record<string, CosKey>> = { [ACCT.FOOD_COST]: 'foodCents', [ACCT.BEVERAGE_COST]: 'drinksCents', [ACCT.PACKAGING_COST]: 'packagingCents' }
const CLASSLESS_COS: readonly string[] = [ACCT.WASTE, ACCT.INVENTORY_VARIANCE, ACCT.COST_ADJUSTMENT]
const INVENTORY_CLASS: Readonly<Record<string, CosKey>> = { [ACCT.INVENTORY_FOOD]: 'foodCents', [ACCT.INVENTORY_BEVERAGE]: 'drinksCents', [ACCT.INVENTORY_PACKAGING]: 'packagingCents' }
const COS_OF_CLASS: Readonly<Record<string, CosKey>> = { food: 'foodCents', beverage: 'drinksCents', packaging: 'packagingCents' }

const zeroSplit = (): CostOfSalesSplit => ({ foodCents: 0, drinksCents: 0, packagingCents: 0 })

/** Split `cents` over weights (largest remainder, exact to the paisa); no weight → all food. */
function splitByWeights(cents: number, weights: Map<CosKey, number>): Array<[CosKey, number]> {
  const entries = Array.from(weights.entries()).filter(([, w]) => w > 0)
  const total = entries.reduce((s, [, w]) => s + w, 0)
  if (total <= 0) return [['foodCents', cents]]
  const sign = cents < 0 ? -1 : 1
  const abs = Math.abs(cents)
  const parts = entries.map(([k, w]) => ({ k, exact: (abs * w) / total }))
  const out = parts.map((p) => ({ k: p.k, v: Math.floor(p.exact), frac: p.exact - Math.floor(p.exact) }))
  let left = abs - out.reduce((s, p) => s + p.v, 0)
  for (const p of [...out].sort((a, b) => b.frac - a.frac)) {
    if (left <= 0) break
    p.v += 1
    left -= 1
  }
  return out.map((p) => [p.k, sign * p.v])
}

/** The source id inside a reference '<sourceType>:<sourceId>[@n]'. */
function sourceIdOf(reference: string, sourceType: string): string | null {
  if (!reference.startsWith(`${sourceType}:`)) return null
  const rest = reference.slice(sourceType.length + 1)
  const at = rest.indexOf('@')
  return (at >= 0 ? rest.slice(0, at) : rest) || null
}

// Source names read here as plain strings (no import of the stock modules from the report layer).
const VOID_WASTE_REF = 'pos.void_waste'            // inventory/voidWaste.ts VOID_WASTE_SOURCE
const WASTE_LOG_MOVES = 'waste_log'                // lib/stockLedger.ts STOCK_SOURCE.wasteLog

/**
 * The cost class of each approved 1290 stock-difference line (H20), from its
 * OWN stock in the entry that booked it:
 *   1. its pair — the opposite-side class line (12x0, or 50x0 when the cost
 *      was already booked) with the same brand, amount and memo (waste and
 *      counts post Dr/Cr pairs with one memo, inventoryPosting.ts brandPairs);
 *   2. a sold-line waste (one 1290 debit per waste log, the stock credited per
 *      class): the log the memo names, of the same cost — its waste movement's
 *      class, else its item's category (as postVoidWaste chose it);
 *   3. an entry whose opposite-side class lines are all one class.
 * A line none of these resolves is left out (the caller falls back to the
 * whole entry's mix — legacy entries only).
 */
async function clearedLineClass(
  db: Db,
  lines: Array<{ id: string; journalEntryId: string; type: string; amountCents: DbMoney; conceptId: string | null; memo: string | null; journalEntry: { reference: string | null } }>,
): Promise<Map<string, CosKey>> {
  const out = new Map<string, CosKey>()
  if (lines.length === 0) return out
  const classOfCode = (code: string): CosKey | undefined => INVENTORY_CLASS[code] ?? DIRECT_COS[code]
  const partners = await db.journalLine.findMany({
    where: { journalEntryId: { in: Array.from(new Set(lines.map((l) => l.journalEntryId))) }, account: { code: { in: [...Object.keys(INVENTORY_CLASS), ...Object.keys(DIRECT_COS)] } } },
    select: { journalEntryId: true, type: true, amountCents: true, conceptId: true, memo: true, account: { select: { code: true } } },
  })
  // Sold-line waste: the logs of each voided line, with their class.
  const orderItemIds = Array.from(new Set(lines.map((l) => sourceIdOf(l.journalEntry.reference ?? '', VOID_WASTE_REF)).filter((x): x is string => !!x)))
  const logs = orderItemIds.length === 0 ? [] : await db.wasteLog.findMany({
    where: { orderItemId: { in: orderItemIds } },
    select: { id: true, orderItemId: true, estimatedCostCents: true, inventoryItem: { select: { name: true, category: true } } },
  })
  const moves = logs.length === 0 ? [] : await db.stockMovement.findMany({
    where: { sourceType: WASTE_LOG_MOVES, sourceId: { in: logs.map((x) => x.id) }, kind: 'waste' },
    select: { sourceId: true, costClass: true },
  })
  const movedClass = new Map(moves.map((m) => [m.sourceId, m.costClass]))
  for (const l of lines) {
    const amount = sumCents(l.amountCents)
    const opposite = partners.filter((p) => p.journalEntryId === l.journalEntryId && p.type !== l.type)
    // 1. Its pair.
    const pair = opposite.find((p) => p.conceptId === l.conceptId && sumCents(p.amountCents) === amount && (p.memo ?? '') === (l.memo ?? ''))
    let k = pair ? classOfCode(pair.account.code) : undefined
    // 2. Sold-line waste: the log its memo names.
    const orderItemId = sourceIdOf(l.journalEntry.reference ?? '', VOID_WASTE_REF)
    if (!k && orderItemId) {
      const item = /^Waste \([^)]*\): (.+)$/.exec((l.memo ?? '').replace(/ \[[^\]]*\]$/, ''))?.[1]?.trim()
      const log = logs.find((x) => x.orderItemId === orderItemId && x.inventoryItem.name === item && (x.estimatedCostCents ?? 0) === amount)
        ?? logs.find((x) => x.orderItemId === orderItemId && x.inventoryItem.name === item)
      if (log) k = COS_OF_CLASS[movedClass.get(log.id) ?? costClassOf(log.inventoryItem.category)]
    }
    // 3. One class on the stock side.
    if (!k) {
      const keys = new Set(opposite.map((p) => classOfCode(p.account.code)).filter((x): x is CosKey => !!x))
      if (keys.size === 1) k = [...keys][0]
    }
    if (k) out.set(l.id, k)
  }
  return out
}

/** Cost of sales by class per brand tag (null = untagged) over the window. */
export async function costOfSalesByConcept(db: Db, tenantIds: string[], a: { from: Date; to: Date }): Promise<Map<string | null, CostOfSalesSplit>> {
  const out = new Map<string | null, CostOfSalesSplit>()
  if (tenantIds.length === 0) return out
  const slot = (c: string | null) => {
    let s = out.get(c)
    if (!s) { s = zeroSplit(); out.set(c, s) }
    return s
  }
  const window = { tenantId: { in: tenantIds }, entryDate: { gte: a.from, lte: a.to } }

  // 1. The class accounts, directly.
  const direct = await db.journalLine.groupBy({
    by: ['conceptId', 'accountId', 'type'],
    _sum: { amountCents: true },
    where: { journalEntry: window, account: { code: { in: Object.keys(DIRECT_COS) } } },
  })
  const directAccounts = new Map((await db.account.findMany({
    where: { id: { in: Array.from(new Set(direct.map((d) => d.accountId))) } }, select: { id: true, code: true },
  })).map((x) => [x.id, x.code]))
  for (const d of direct) {
    const key = DIRECT_COS[directAccounts.get(d.accountId) ?? '']
    if (!key) continue
    const amt = sumCents(d._sum.amountCents)
    slot(d.conceptId)[key] += d.type === 'debit' ? amt : -amt
  }

  // 2. The class-less lines, by the stock behind their entry.
  const classless = await db.journalLine.findMany({
    where: { journalEntry: window, account: { code: { in: [...CLASSLESS_COS] } } },
    select: { journalEntryId: true, type: true, amountCents: true, conceptId: true, account: { select: { code: true } }, journalEntry: { select: { reference: true, tenantId: true } } },
  })
  if (classless.length === 0) return out
  // H20: a waste / count difference the CEO approved ('stock_difference.clear:<1290 lineId>')
  // has no stock line of its own — read the stock behind the entry its 1290 line came from.
  // The CEO approves LINE BY LINE (a count's beef short may clear in May, its
  // cups short in June, or never), so the class is the cleared 1290 line's
  // OWN stock (clearedLineClass), never the whole entry's mix.
  const stockEntryOf = new Map<string, string>()   // clearing entry id → the waste / count entry id
  const clearedLineIds = Array.from(new Set(classless
    .map((l) => sourceIdOf(l.journalEntry.reference ?? '', 'stock_difference.clear'))
    .filter((x): x is string => !!x)))
  const clearedClassOf = new Map<string, CosKey>()   // clearing entry id → the cleared line's class
  if (clearedLineIds.length > 0) {
    const src = await db.journalLine.findMany({
      where: { id: { in: clearedLineIds }, journalEntry: { tenantId: { in: tenantIds } } },
      select: { id: true, journalEntryId: true, type: true, amountCents: true, conceptId: true, memo: true, journalEntry: { select: { reference: true } } },
    })
    const entryOfLine = new Map(src.map((x) => [x.id, x.journalEntryId]))
    for (const l of classless) {
      const id = sourceIdOf(l.journalEntry.reference ?? '', 'stock_difference.clear')
      const e = id ? entryOfLine.get(id) : undefined
      if (e) stockEntryOf.set(l.journalEntryId, e)
    }
    const classOfLine = await clearedLineClass(db, src)
    for (const l of classless) {
      const id = sourceIdOf(l.journalEntry.reference ?? '', 'stock_difference.clear')
      const k = id ? classOfLine.get(id) : undefined
      if (k) clearedClassOf.set(l.journalEntryId, k)
    }
  }
  const stockEntry = (entryId: string) => stockEntryOf.get(entryId) ?? entryId
  const entryIds = Array.from(new Set(classless.map((l) => stockEntry(l.journalEntryId))))
  // Class evidence on the stock side: the class inventory accounts first; the
  // class cost accounts (5010 / 5020 / 5030) when the entry has none — a
  // sold-line waste whose cost was already booked credits the class cost, not
  // 12x0, and a straight-to-cost void books Dr 5040 / Cr 50x0.
  const invLines = await db.journalLine.findMany({
    where: { journalEntryId: { in: entryIds }, account: { code: { in: [...Object.keys(INVENTORY_CLASS), ...Object.keys(DIRECT_COS)] } } },
    select: { journalEntryId: true, type: true, amountCents: true, conceptId: true, account: { select: { code: true } } },
  })
  const invByEntry = new Map<string, typeof invLines>()
  const cosByEntry = new Map<string, typeof invLines>()
  for (const l of invLines) {
    const into = INVENTORY_CLASS[l.account.code] ? invByEntry : cosByEntry
    into.set(l.journalEntryId, [...(into.get(l.journalEntryId) ?? []), l])
  }

  // 5060 with no stock line in its entry: the bill's GRNI matches, or the written-off receipt line.
  const billIds = new Set<string>()
  const receiptLineIds = new Set<string>()
  for (const l of classless) {
    if (l.account.code !== ACCT.COST_ADJUSTMENT || invByEntry.has(l.journalEntryId)) continue
    const ref = l.journalEntry.reference ?? ''
    const bill = sourceIdOf(ref, 'supplier.bill')
    if (bill) billIds.add(bill)
    const rl = sourceIdOf(ref, 'procurement.grni_writeoff')
    if (rl) receiptLineIds.add(rl)
  }
  const billWeights = new Map<string, Map<CosKey, number>>()
  if (billIds.size > 0) {
    const matches = await db.grniMatch.findMany({
      where: { tenantId: { in: tenantIds }, billId: { in: Array.from(billIds) }, NOT: { usedCents: 0 } },
      select: { billId: true, usedCents: true, billLine: { select: { inventoryItem: { select: { category: true } } } } },
    })
    for (const m of matches) {
      const w = billWeights.get(m.billId) ?? new Map<CosKey, number>()
      const k = COS_OF_CLASS[costClassOf(m.billLine.inventoryItem?.category ?? null)]!
      w.set(k, (w.get(k) ?? 0) + Math.abs(sumCents(m.usedCents)))
      billWeights.set(m.billId, w)
    }
  }
  const receiptLineClass = new Map<string, CosKey>()
  if (receiptLineIds.size > 0) {
    const lines = await db.goodsReceiptLine.findMany({
      where: { id: { in: Array.from(receiptLineIds) } },
      select: { id: true, inventoryItemId: true },
    })
    const itemIds = Array.from(new Set(lines.map((l) => l.inventoryItemId).filter((x): x is string => !!x)))
    const categoryOf = new Map((itemIds.length === 0 ? [] : await db.inventoryItem.findMany({
      where: { id: { in: itemIds } }, select: { id: true, category: true },
    })).map((i) => [i.id, i.category]))
    for (const l of lines) receiptLineClass.set(l.id, COS_OF_CLASS[costClassOf(l.inventoryItemId ? (categoryOf.get(l.inventoryItemId) ?? null) : null)]!)
  }

  for (const l of classless) {
    const amt = sumCents(l.amountCents)
    if (amt === 0) continue
    const signed = l.type === 'debit' ? amt : -amt
    // The stock side of the same entry: a debit to 5040/5050/5060 is paired
    // with inventory CREDITS (stock out), a credit with inventory DEBITS.
    // (An approved stock difference: its waste / count entry's stock lines — Dr 1290 / Cr 12x0 there
    // pairs the same way as the Dr 5040 / Cr 1290 here.)
    const pick = (rows: typeof invLines) => {
      const w = new Map<CosKey, number>()
      for (const x of rows) {
        const k = INVENTORY_CLASS[x.account.code] ?? DIRECT_COS[x.account.code]
        if (k) w.set(k, (w.get(k) ?? 0) + sumCents(x.amountCents))
      }
      return w
    }
    const cleared = clearedClassOf.get(l.journalEntryId)
    let weights = new Map<CosKey, number>(cleared ? [[cleared, 1]] : [])
    for (const byEntry of [invByEntry, cosByEntry]) {
      if (weights.size > 0) break
      const opposite = (byEntry.get(stockEntry(l.journalEntryId)) ?? []).filter((x) => x.type !== l.type)
      weights = pick(opposite.filter((x) => x.conceptId === l.conceptId))
      if (weights.size === 0) weights = pick(opposite)
    }
    if (weights.size === 0 && l.account.code === ACCT.COST_ADJUSTMENT) {
      const ref = l.journalEntry.reference ?? ''
      const bill = sourceIdOf(ref, 'supplier.bill')
      const rl = sourceIdOf(ref, 'procurement.grni_writeoff')
      if (bill && billWeights.has(bill)) weights = billWeights.get(bill)!
      else if (rl && receiptLineClass.has(rl)) weights = new Map([[receiptLineClass.get(rl)!, 1]])
    }
    const s = slot(l.conceptId)
    for (const [k, v] of splitByWeights(signed, weights)) s[k] += v
  }
  return out
}

/** Brand sales (40xx net of 7010 / 7020) per brand tag (null = untagged) over the window. */
export async function brandSalesByConcept(db: Db, tenantIds: string[], a: { from: Date; to: Date }): Promise<Map<string | null, number>> {
  const out = new Map<string | null, number>()
  if (tenantIds.length === 0) return out
  const grouped = await db.journalLine.groupBy({
    by: ['conceptId', 'accountId', 'type'],
    _sum: { amountCents: true },
    where: {
      journalEntry: { tenantId: { in: tenantIds }, entryDate: { gte: a.from, lte: a.to } },
      account: { OR: [{ code: { startsWith: '40' } }, { code: { in: [...BRAND_SALES_CONTRA_CODES] } }] },
    },
  })
  const codes = new Map((await db.account.findMany({
    where: { id: { in: Array.from(new Set(grouped.map((g) => g.accountId))) } }, select: { id: true, code: true },
  })).map((x) => [x.id, x.code]))
  for (const g of grouped) {
    const code = codes.get(g.accountId)
    if (!code) continue
    const v = brandSalesEffect(code, g.type, sumCents(g._sum.amountCents))
    if (v !== 0) out.set(g.conceptId, (out.get(g.conceptId) ?? 0) + v)
  }
  return out
}

/**
 * THE cost-of-sales denominator: brand sales 40xx net of discounts (7010) and
 * loyalty redemptions (7020), for one company — one brand when `conceptId`.
 */
export async function brandSalesRevenueCents(db: Db, tenantId: string, a: { from: Date; to: Date; conceptId?: string }): Promise<number> {
  const by = await brandSalesByConcept(db, [tenantId], a)
  if (a.conceptId !== undefined) return by.get(a.conceptId) ?? 0
  return Array.from(by.values()).reduce((s, v) => s + v, 0)
}

/**
 * THE cost-of-sales class split for one company — one brand when `conceptId`
 * (lines tagged to it; a brand-less line is head office's, never the brand's).
 */
export async function costOfSalesSplit(db: Db, tenantId: string, a: { from: Date; to: Date; conceptId?: string }): Promise<CostOfSalesSplit> {
  const by = await costOfSalesByConcept(db, [tenantId], a)
  if (a.conceptId !== undefined) return by.get(a.conceptId) ?? zeroSplit()
  const total = zeroSplit()
  for (const s of by.values()) {
    total.foodCents += s.foodCents; total.drinksCents += s.drinksCents; total.packagingCents += s.packagingCents
  }
  return total
}

// ─── Brand P&L with the head-office line (owner decision 22) ─────────────────
// The ONE per-brand P&L reader for dashboards. Every figure is measured from
// the ledger: brand-tagged lines are that brand's; a shared cost reaches a
// brand only through a POSTED allocation (the /allocations rules post their
// runs with each debit tagged to its brand). Whatever no rule has allocated —
// head-office rent, untagged overhead, manual entries, older postings — is
// shown as ONE "Company overhead (unallocated)" line, never spread across brands
// by revenue share. Labour is the wage accounts (6030–6035): tagged wages are
// the brand's, untagged wages are head office's.
//
// Cost of sales is split food / drinks / packaging (costOfSalesSplit's
// definition) and its ratio, costOfSalesPct (formerly 'foodCostPct', which
// counted every 5xxx as "food"), is over BRAND SALES (brandSalesRevenueCents'
// definition), not total revenue. 42xx other income is apart from revenue.

export const WAGE_CODES = ['6030', '6031', '6032', '6035'] as const
// D1 (spec §1): renamed so it never collides with a real head office (a Tenant
// of kind 'head_office'). The row is still the company's untagged cost; the
// response key stays `headOffice`. reports/foodCost.ts imports this constant.
export const HEAD_OFFICE_LABEL = 'Company overhead (unallocated)'

export interface BrandPnlRow {
  conceptId: string | null          // null = head office (unallocated)
  name: string
  revenueCents: number              // operating revenue (42xx excluded)
  contraCents: number
  netRevenueCents: number
  /** Brand sales 40xx net of 7010 / 7020 — the cost-of-sales denominator. */
  brandSalesCents: number
  cogsCents: number
  foodCents: number
  drinksCents: number
  packagingCents: number
  opexCents: number                 // includes labour
  labourCents: number
  otherIncomeCents: number
  grossProfitCents: number
  netProfitCents: number            // includes other income
  grossMarginPct: number
  netMarginPct: number
  /** Cost of sales over brand sales (was foodCostPct, over revenue). */
  costOfSalesPct: number
  foodPct: number
  drinksPct: number
  packagingPct: number
  labourPct: number
  primeCostPct: number
}

export interface BrandPnlReport {
  brands: BrandPnlRow[]
  headOffice: BrandPnlRow
  company: BrandPnlRow
  basis: {
    source: 'ledger'
    allocation: 'posted-allocations+head-office-unallocated'
    /** Share of company opex (ex-labour) that sits on brands (measured or allocated). */
    allocatedOpexPct: number
    headOfficeOpexCents: number
    headOfficeLabourCents: number
  }
}

type BrandMeasure = { revenue: number; contra: number; cogs: number; opex: number; labour: number; other: number; sales: number; split: CostOfSalesSplit }

function brandRow(conceptId: string | null, name: string, m: BrandMeasure): BrandPnlRow {
  const netRevenueCents  = m.revenue - m.contra
  const grossProfitCents = m.revenue - m.contra - m.cogs
  const netProfitCents   = grossProfitCents - m.opex + m.other
  const pctOf = (c: number) => (m.revenue > 0 ? Number(((c / m.revenue) * 100).toFixed(2)) : 0)
  const pctOfSales = (c: number) => (m.sales > 0 ? Number(((c / m.sales) * 100).toFixed(2)) : 0)
  return {
    conceptId, name,
    revenueCents: m.revenue, contraCents: m.contra, netRevenueCents,
    brandSalesCents: m.sales,
    cogsCents: m.cogs, foodCents: m.split.foodCents, drinksCents: m.split.drinksCents, packagingCents: m.split.packagingCents,
    opexCents: m.opex, labourCents: m.labour, otherIncomeCents: m.other,
    grossProfitCents, netProfitCents,
    grossMarginPct: pctOf(grossProfitCents),
    netMarginPct: pctOf(netProfitCents),
    costOfSalesPct: pctOfSales(m.cogs),
    foodPct: pctOfSales(m.split.foodCents),
    drinksPct: pctOfSales(m.split.drinksCents),
    packagingPct: pctOfSales(m.split.packagingCents),
    labourPct: pctOf(m.labour),
    primeCostPct: pctOf(m.cogs + m.labour),
  }
}

/**
 * Per-brand P&L for `brands` (the brands in view, with display names) over
 * the companies in `tenantIds`. Lines tagged with a brand outside `brands`
 * (another company's, a deleted brand) fall into the head-office line so the
 * three blocks always add up to the company.
 */
export async function brandPnl(
  tenantIds: string[],
  dateFrom: Date,
  dateTo: Date,
  brands: Array<{ id: string; name: string }>,
): Promise<BrandPnlReport> {
  const [grouped, sales, split] = await Promise.all([
    prisma.journalLine.groupBy({
      by: ['conceptId', 'accountId', 'type'],
      _sum: { amountCents: true },
      where: { journalEntry: { tenantId: { in: tenantIds }, entryDate: { gte: dateFrom, lte: dateTo } } },
    }),
    brandSalesByConcept(prisma, tenantIds, { from: dateFrom, to: dateTo }),
    costOfSalesByConcept(prisma, tenantIds, { from: dateFrom, to: dateTo }),
  ])
  const accounts = await prisma.account.findMany({
    where: { id: { in: Array.from(new Set(grouped.map((g) => g.accountId))) } },
    select: { id: true, code: true, type: true },
  })
  const accMap = new Map(accounts.map((a) => [a.id, a]))
  const known = new Map(brands.map((b) => [b.id, b.name]))
  const zero = (): BrandMeasure => ({ revenue: 0, contra: 0, cogs: 0, opex: 0, labour: 0, other: 0, sales: 0, split: zeroSplit() })
  const perBrand = new Map<string, BrandMeasure>(brands.map((b) => [b.id, zero()]))
  const ho = zero()
  const bucketOf = (conceptId: string | null) => (conceptId && known.has(conceptId) ? perBrand.get(conceptId)! : ho)
  for (const row of grouped) {
    const acc = accMap.get(row.accountId)
    if (!acc) continue
    const amt = sumCents(row._sum.amountCents)
    if (amt === 0) continue
    const bucket = bucketOf(row.conceptId)
    if (acc.type === 'revenue') {
      const signed = row.type === 'credit' ? amt : -amt
      if (isOtherIncomeCode(acc.code)) bucket.other += signed
      else bucket.revenue += signed
    } else if (acc.type === 'expense') {
      const signed = row.type === 'debit' ? amt : -amt
      if (acc.code.startsWith(COGS_PREFIX)) bucket.cogs += signed
      else if (acc.code.startsWith(CONTRA_REVENUE_PREFIX)) bucket.contra += signed
      else {
        bucket.opex += signed
        if ((WAGE_CODES as readonly string[]).includes(acc.code)) bucket.labour += signed
      }
    }
  }
  for (const [conceptId, v] of sales) bucketOf(conceptId).sales += v
  for (const [conceptId, s] of split) {
    const b = bucketOf(conceptId)
    b.split.foodCents += s.foodCents; b.split.drinksCents += s.drinksCents; b.split.packagingCents += s.packagingCents
  }
  const brandRows = brands
    .map((b) => brandRow(b.id, b.name, perBrand.get(b.id)!))
    .filter((r) => r.revenueCents !== 0 || r.cogsCents !== 0 || r.opexCents !== 0 || r.contraCents !== 0 || r.otherIncomeCents !== 0)
    .sort((a, b) => b.revenueCents - a.revenueCents)
  const total = zero()
  for (const m of [...perBrand.values(), ho]) {
    total.revenue += m.revenue; total.contra += m.contra; total.cogs += m.cogs; total.opex += m.opex; total.labour += m.labour
    total.other += m.other; total.sales += m.sales
    total.split.foodCents += m.split.foodCents; total.split.drinksCents += m.split.drinksCents; total.split.packagingCents += m.split.packagingCents
  }
  const opexExLabour = total.opex - total.labour
  const brandOpexExLabour = opexExLabour - (ho.opex - ho.labour)
  return {
    brands: brandRows,
    headOffice: brandRow(null, HEAD_OFFICE_LABEL, ho),
    company: brandRow(null, 'Company', total),
    basis: {
      source: 'ledger',
      allocation: 'posted-allocations+head-office-unallocated',
      allocatedOpexPct: opexExLabour > 0 ? Number(((brandOpexExLabour / opexExLabour) * 100).toFixed(1)) : 0,
      headOfficeOpexCents: ho.opex - ho.labour,
      headOfficeLabourCents: ho.labour,
    },
  }
}

// ─── Cash flow (indirect-method-lite) ───────────────────────────────────────
// True cash-flow categorisation requires tagging every JE with operating /
// investing / financing intent. v1 takes a pragmatic shortcut: for each cash
// account report inflow / outflow / net for the period, then attribute by the
// OPPOSING account on each entry.
//
// Cash accounts are the safe, petty cash, till, bank and gateway codes (1010,
// 1011, 1015, 1020, 1030), every bank child code (1021–1029,
// lib/bankAccounts.ts) and any asset account a live bank account is linked to.
// A petty-cash top-up from the safe (Dr 1011 / Cr 1010) is therefore a
// transfer, not an outflow; the Garibsons funding (Dr 1011 / Cr 2210, H1) is
// cash coming in.
//
// TRANSFERS ARE NOT CASH FLOW. Money moving between two of the company's own
// cash accounts — a safe drop (1015 → 1010), a pay-in or COD hand-over
// (1010 → 1015), a bank deposit (1010/1015 → 1020) — does not change the cash
// the company holds. Counting both legs made a PKR 3,000 drop show as +3,000
// in and −3,000 out (BOOKS-09), so each entry's cash-to-cash legs are netted
// out before anything is summed:
//   1. a cash debit and a cash credit on DIFFERENT cash accounts with the same
//      amount and memo are a transfer pair (how the shift close, till
//      pay-outs and manual transfers write them);
//   2. of what is left, cash can only have come IN from a non-cash credit and
//      gone OUT to a non-cash debit, so inflow is capped at the entry's
//      non-cash credits and outflow at its non-cash debits; the excess on both
//      sides is a transfer (a deposit split across safe and drawer, an entry
//      made only of cash lines).
// Transfers are reported per account (transferIn / transferOut, so each
// account's net is still its true balance change) and in total, but never in
// inflow, outflow or the categories.

const CASH_ACCOUNT_CODES: string[] = [ACCT.CASH_ON_HAND, ACCT.PETTY_CASH, ACCT.CASH_DRAWER, ACCT.BANK, ACCT.CARD_RECEIVABLE]
const BANK_CHILD_CODES = ['1021', '1022', '1023', '1024', '1025', '1026', '1027', '1028', '1029']

export interface CashFlowReport {
  dateFrom: string
  dateTo: string
  /** Companies in scope. More than one = "All companies" view: read each row's company. */
  companies: ReportCompany[]
  byCashAccount: Array<{
    tenantId: string | null
    companyName: string | null
    code: string
    name: string
    inflowCents: number         // from outside the company's cash
    outflowCents: number        // to outside the company's cash
    transferInCents: number     // from another of the company's cash accounts
    transferOutCents: number    // to another of the company's cash accounts
    netCents: number            // the account's balance change (incl. transfers)
  }>
  byCategory: Array<{
    category: 'operating' | 'investing' | 'financing'
    inflowCents: number
    outflowCents: number
    netCents: number
  }>
  /** Inflow / outflow exclude transfers; transfersCents is what moved between own cash accounts. */
  totals: { inflowCents: number; outflowCents: number; netCents: number; transfersCents: number }
}

type CashCategory = 'operating' | 'investing' | 'financing'

function categorise(code: string): CashCategory {
  if (code.startsWith('15')) return 'investing'  // fixed assets
  if (code.startsWith('30')) return 'financing'  // owner capital / drawings
  return 'operating'
}

/** The register's and CapEx's entries (FA critic): categorised line by line, by the NON-cash line. */
const isRegisterOrCapex = (reference: string | null | undefined) => !!reference && (reference.startsWith('capex.') || reference.startsWith('fixed_asset.'))

/**
 * A capex.* / fixed_asset.* entry's non-cash line: supplier advances (1340),
 * fixed assets (15xx), refundable deposits (1360) and capital payables (2012,
 * or 2010 for a line capitalised before the register link) are investing;
 * prepaid rent (1310), any expense (6xxx, e.g. broker / legal fees, H26), input
 * tax (132x) and withholding (2040) are operating. 'prepaid.release' moves no
 * cash, so it never reaches this report.
 */
function categoriseCapexLine(code: string): CashCategory {
  // 8030 on a register / CapEx entry is a disposal's gain or loss: the sale
  // proceeds it shares in are investing, never operating.
  if (code === ACCT.SUPPLIER_ADVANCES || code === ACCT.SECURITY_DEPOSITS || code === ACCT.CAPITAL_PAYABLES || code === ACCT.AP_SUPPLIERS
    || code === ACCT.ASSET_DISPOSAL || code.startsWith('15')) return 'investing'
  if (code === ACCT.PREPAID || code === ACCT.WHT_PAYABLE || code.startsWith('6')) return 'operating'
  return categorise(code)
}

/** Share `cents` over lines by amount (largest remainder, exact). */
function shareByLines(cents: number, lines: Array<{ category: CashCategory; amountCents: number }>): Map<CashCategory, number> {
  const out = new Map<CashCategory, number>()
  const total = lines.reduce((s, l) => s + l.amountCents, 0)
  if (cents === 0 || total <= 0) return out
  const parts = lines.map((l) => ({ category: l.category, exact: (cents * l.amountCents) / total }))
  const floors = parts.map((p) => ({ ...p, v: Math.floor(p.exact), frac: p.exact - Math.floor(p.exact) }))
  let left = cents - floors.reduce((s, p) => s + p.v, 0)
  for (const p of [...floors].sort((a, b) => b.frac - a.frac)) {
    if (left <= 0) break
    p.v += 1
    left -= 1
  }
  for (const p of floors) out.set(p.category, (out.get(p.category) ?? 0) + p.v)
  return out
}

export interface CashSplitLine {
  accountId: string
  type: 'debit' | 'credit'
  amountCents: number
  memo?: string | null
}

export interface CashSplit {
  /** External cash in / out of the entry (transfers removed). */
  inflowCents: number
  outflowCents: number
  /** Per cash account: external in / out and transfers in / out. */
  perAccount: Map<string, { inflowCents: number; outflowCents: number; transferInCents: number; transferOutCents: number }>
}

/**
 * Split ONE balanced journal entry's cash lines into external flow and
 * transfers between the company's own cash accounts (see the header above).
 * Pure — exported for the regression tests.
 */
export function splitEntryCash(lines: CashSplitLine[], isCash: (accountId: string) => boolean): CashSplit {
  const perAccount: CashSplit['perAccount'] = new Map()
  const slot = (id: string) => {
    let s = perAccount.get(id)
    if (!s) { s = { inflowCents: 0, outflowCents: 0, transferInCents: 0, transferOutCents: 0 }; perAccount.set(id, s) }
    return s
  }
  const cash = lines.filter((l) => isCash(l.accountId)).map((l) => ({ ...l, left: l.amountCents }))
  const nonCash = lines.filter((l) => !isCash(l.accountId))

  // 1. Explicit transfer pairs.
  const credits = cash.filter((l) => l.type === 'credit')
  for (const d of cash.filter((l) => l.type === 'debit')) {
    const c = credits.find((x) => x.left > 0 && x.accountId !== d.accountId
      && x.left === d.left && (x.memo ?? '') === (d.memo ?? ''))
    if (!c) continue
    slot(d.accountId).transferInCents += d.left
    slot(c.accountId).transferOutCents += c.left
    d.left = 0
    c.left = 0
  }

  // 2. Cap the rest by what non-cash lines can account for.
  const rd = cash.filter((l) => l.type === 'debit').reduce((s, l) => s + l.left, 0)
  const rc = cash.filter((l) => l.type === 'credit').reduce((s, l) => s + l.left, 0)
  const nc = nonCash.filter((l) => l.type === 'credit').reduce((s, l) => s + l.amountCents, 0)
  const nd = nonCash.filter((l) => l.type === 'debit').reduce((s, l) => s + l.amountCents, 0)
  const transfer = Math.max(0, Math.min(rd - nc, rc - nd, rd, rc))

  let tIn = transfer
  let tOut = transfer
  for (const l of cash) {
    if (l.left === 0) { slot(l.accountId); continue }
    const s = slot(l.accountId)
    if (l.type === 'debit') {
      const t = Math.min(tIn, l.left); tIn -= t
      s.transferInCents += t
      s.inflowCents += l.left - t
    } else {
      const t = Math.min(tOut, l.left); tOut -= t
      s.transferOutCents += t
      s.outflowCents += l.left - t
    }
  }
  return { inflowCents: rd - transfer, outflowCents: rc - transfer, perAccount }
}

export async function cashFlow(tenantIds: string[], dateFrom: Date, dateTo: Date): Promise<CashFlowReport> {
  // Asset accounts a live bank account points at, per company.
  const linkedBanks = await prisma.bankAccount.findMany({
    where: { tenantId: { in: tenantIds }, deletedAt: null, accountCode: { not: null } },
    select: { tenantId: true, accountCode: true },
  })
  const [cashAccounts, companies] = await Promise.all([
    prisma.account.findMany({
      where: {
        tenantId: { in: tenantIds },
        OR: [
          { code: { in: [...CASH_ACCOUNT_CODES, ...BANK_CHILD_CODES] } },
          ...linkedBanks.map((b) => ({ tenantId: b.tenantId!, code: b.accountCode!, type: 'asset' as const })),
        ],
      },
      select: { id: true, tenantId: true, code: true, name: true },
    }),
    companiesInScope(tenantIds),
  ])
  const nameOf = new Map(companies.map((c) => [c.id, c.name]))
  const cashAccountIds = new Set(cashAccounts.map((a) => a.id))
  const isCash = (id: string) => cashAccountIds.has(id)

  // Pull every line in entries that touched a cash account
  const entriesWithCash = cashAccountIds.size === 0 ? [] : await prisma.journalEntry.findMany({
    where: {
      tenantId: { in: tenantIds },
      entryDate: { gte: dateFrom, lte: dateTo },
      lines: { some: { accountId: { in: Array.from(cashAccountIds) } } },
    },
    include: { lines: { include: { account: true } } },
  })

  const perCash = new Map(cashAccounts.map((a) => [a.id, {
    tenantId: a.tenantId,
    companyName: a.tenantId ? (nameOf.get(a.tenantId) ?? null) : null,
    code: a.code, name: a.name,
    inflowCents: 0, outflowCents: 0, transferInCents: 0, transferOutCents: 0,
  }]))

  // Per-category — opposing-account driven, external flow only
  const perCategory = new Map<CashCategory, { inflowCents: number; outflowCents: number }>([
    ['operating', { inflowCents: 0, outflowCents: 0 }],
    ['investing', { inflowCents: 0, outflowCents: 0 }],
    ['financing', { inflowCents: 0, outflowCents: 0 }],
  ])

  for (const entry of entriesWithCash) {
    const split = splitEntryCash(entry.lines.map((l) => ({ ...l, amountCents: toCents(l.amountCents) })), isCash)
    for (const [accountId, s] of split.perAccount) {
      const row = perCash.get(accountId)!
      row.inflowCents      += s.inflowCents
      row.outflowCents     += s.outflowCents
      row.transferInCents  += s.transferInCents
      row.transferOutCents += s.transferOutCents
    }

    // Category: the dominant non-cash account. An entry made only of cash
    // lines is a transfer and has no external flow to categorise.
    const nonCashLines = entry.lines.filter((l) => !isCash(l.accountId))
    if (nonCashLines.length === 0) continue
    if (isRegisterOrCapex(entry.reference)) {
      // Cash out is shared over the non-cash DEBITS (what was bought or
      // prepaid), cash in over the non-cash CREDITS — each by its own code.
      const side = (type: 'debit' | 'credit') => nonCashLines
        .filter((l) => l.type === type)
        .map((l) => ({ category: categoriseCapexLine(l.account.code), amountCents: toCents(l.amountCents) }))
      for (const [c, v] of shareByLines(split.outflowCents, side('debit'))) perCategory.get(c)!.outflowCents += v
      for (const [c, v] of shareByLines(split.inflowCents, side('credit'))) perCategory.get(c)!.inflowCents += v
      continue
    }
    const dominant = nonCashLines.reduce((a, b) => (toCents(a.amountCents) >= toCents(b.amountCents) ? a : b))
    const cat = perCategory.get(categorise(dominant.account.code))!
    cat.inflowCents  += split.inflowCents
    cat.outflowCents += split.outflowCents
  }

  const byCashAccount = Array.from(perCash.values())
    .sort(byCompanyThenCode)
    .map((r) => ({ ...r, netCents: r.inflowCents - r.outflowCents + r.transferInCents - r.transferOutCents }))

  const byCategory = Array.from(perCategory.entries())
    .map(([category, v]) => ({ category, ...v, netCents: v.inflowCents - v.outflowCents }))

  const sums = byCashAccount.reduce(
    (s, r) => ({
      inflowCents: s.inflowCents + r.inflowCents,
      outflowCents: s.outflowCents + r.outflowCents,
      transfersCents: s.transfersCents + r.transferInCents,
    }),
    { inflowCents: 0, outflowCents: 0, transfersCents: 0 },
  )
  const totals = { ...sums, netCents: sums.inflowCents - sums.outflowCents }

  return { dateFrom: fmtPktDate(dateFrom), dateTo: fmtPktDate(dateTo), companies, byCashAccount, byCategory, totals }
}
