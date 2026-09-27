// Financial reports built from the journal — the ledger is the source of truth.
//
// Every report aggregates JournalLine rows by account; nothing reads from
// FinancialEntry or Order tables. If it isn't in the ledger, it isn't in the
// report. This is the property that lets the trial balance prove correctness:
// sum(debits) − sum(credits) across every account in scope MUST equal zero.

import type { AccountType, Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { ACCT } from './journal.js'
import { fmtPktDate } from './dates.js'

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
  code: string
  name: string
  type: AccountType
  debitCents: number
  creditCents: number
  balanceCents: number
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
    select: { id: true, code: true, name: true, type: true },
  })
  const accountMap = new Map(accounts.map((a) => [a.id, a]))

  // Bucket
  const bucket = new Map<string, { debit: number; credit: number }>()
  for (const row of grouped) {
    const slot = bucket.get(row.accountId) ?? { debit: 0, credit: 0 }
    if (row.type === 'debit') slot.debit  += row._sum.amountCents ?? 0
    else                       slot.credit += row._sum.amountCents ?? 0
    bucket.set(row.accountId, slot)
  }

  const out: AccountAggregation[] = []
  for (const [accountId, sums] of bucket.entries()) {
    const acc = accountMap.get(accountId)
    if (!acc) continue
    out.push({
      accountId,
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

// ─── Trial balance ──────────────────────────────────────────────────────────
// Lists every account with activity in the range and shows total debits vs
// credits. The Δ column at the bottom MUST be zero — that's what proves the
// books are balanced.

export interface TrialBalanceReport {
  asOf: string
  rows: Array<{ code: string; name: string; type: AccountType; debitCents: number; creditCents: number }>
  totals: { debitCents: number; creditCents: number; differenceCents: number }
}

export async function trialBalance(tenantIds: string[], asOf: Date): Promise<TrialBalanceReport> {
  const rows = await aggregateByAccount({ tenantIds, upTo: asOf })
  const totals = rows.reduce(
    (s, r) => ({ debitCents: s.debitCents + r.debitCents, creditCents: s.creditCents + r.creditCents }),
    { debitCents: 0, creditCents: 0 },
  )
  return {
    asOf: fmtPktDate(asOf),
    rows: rows.map((r) => ({ code: r.code, name: r.name, type: r.type, debitCents: r.debitCents, creditCents: r.creditCents })),
    totals: { ...totals, differenceCents: totals.debitCents - totals.creditCents },
  }
}

// ─── Balance sheet ──────────────────────────────────────────────────────────
// Snapshot at a point in time: assets = liabilities + equity. Revenue/expense
// accumulated balances roll into "current period earnings" within equity.

export interface BalanceSheetReport {
  asOf: string
  assets:      { code: string; name: string; balanceCents: number }[]
  liabilities: { code: string; name: string; balanceCents: number }[]
  equity:      { code: string; name: string; balanceCents: number }[]
  totals: {
    assetsCents: number
    liabilitiesCents: number
    equityCents: number
    currentEarningsCents: number   // revenue − expenses (rolls into equity)
    differenceCents: number        // should be 0
  }
}

export async function balanceSheet(tenantIds: string[], asOf: Date): Promise<BalanceSheetReport> {
  const rows = await aggregateByAccount({ tenantIds, upTo: asOf })

  const assets = rows.filter((r) => r.type === 'asset').map((r) => ({ code: r.code, name: r.name, balanceCents: r.balanceCents }))
  const liabilities = rows.filter((r) => r.type === 'liability').map((r) => ({ code: r.code, name: r.name, balanceCents: r.balanceCents }))
  const equity = rows.filter((r) => r.type === 'equity').map((r) => ({ code: r.code, name: r.name, balanceCents: r.balanceCents }))

  const revenueCents = rows.filter((r) => r.type === 'revenue').reduce((s, r) => s + r.balanceCents, 0)
  const expenseCents = rows.filter((r) => r.type === 'expense').reduce((s, r) => s + r.balanceCents, 0)
  const currentEarningsCents = revenueCents - expenseCents

  const assetsCents      = assets.reduce((s, r) => s + r.balanceCents, 0)
  const liabilitiesCents = liabilities.reduce((s, r) => s + r.balanceCents, 0)
  const equityCents      = equity.reduce((s, r) => s + r.balanceCents, 0)

  return {
    asOf: fmtPktDate(asOf),
    assets,
    liabilities,
    equity,
    totals: {
      assetsCents,
      liabilitiesCents,
      equityCents,
      currentEarningsCents,
      differenceCents: assetsCents - liabilitiesCents - equityCents - currentEarningsCents,
    },
  }
}

// ─── Profit & loss (from ledger) ────────────────────────────────────────────
// Replaces the FinancialEntry-based P&L. Groups revenue and expense balances
// over a date range, with a per-concept revenue breakdown (4001-409x).

export interface ProfitAndLossReport {
  dateFrom: string
  dateTo: string
  revenue: { code: string; name: string; amountCents: number }[]
  cogs:    { code: string; name: string; amountCents: number }[]
  opex:    { code: string; name: string; amountCents: number }[]
  contraRevenue: { code: string; name: string; amountCents: number }[]
  totals: {
    revenueCents: number
    cogsCents: number
    grossProfitCents: number
    grossMarginPct: number  // 0–100
    opexCents: number
    contraRevenueCents: number
    netProfitCents: number
  }
}

const COGS_PREFIX = '5'
const CONTRA_REVENUE_PREFIX = '7'

export async function profitAndLoss(tenantIds: string[], dateFrom: Date, dateTo: Date): Promise<ProfitAndLossReport> {
  const rows = await aggregateByAccount({ tenantIds, dateFrom, dateTo })

  const revenue = rows
    .filter((r) => r.type === 'revenue')
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
  const cogsCents          = cogs.reduce((s, r) => s + r.amountCents, 0)
  const opexCents          = opex.reduce((s, r) => s + r.amountCents, 0)
  const contraRevenueCents = contraRevenue.reduce((s, r) => s + r.amountCents, 0)

  const grossProfitCents = revenueCents - cogsCents - contraRevenueCents
  const netProfitCents   = grossProfitCents - opexCents
  const grossMarginPct   = revenueCents > 0 ? (grossProfitCents / revenueCents) * 100 : 0

  return {
    dateFrom: fmtPktDate(dateFrom),
    dateTo: fmtPktDate(dateTo),
    revenue,
    cogs,
    opex,
    contraRevenue,
    totals: {
      revenueCents,
      cogsCents,
      grossProfitCents,
      grossMarginPct: Number(grossMarginPct.toFixed(2)),
      opexCents,
      contraRevenueCents,
      netProfitCents,
    },
  }
}

// ─── Per-brand P&L components (measured from tagged lines) ───────────────────
// Groups journal lines by their conceptId so each brand's revenue, COGS and
// discounts are MEASURED from the ledger, not estimated by revenue share. Lines
// with a null conceptId (shared overhead, manual entries) land in the `null`
// bucket; the brand report allocates that remainder across brands.

export interface ConceptPnlBucket {
  conceptId: string | null // null = shared / unallocated
  revenueCents: number
  cogsCents: number
  contraRevenueCents: number
  opexCents: number
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
      b = { conceptId: c, revenueCents: 0, cogsCents: 0, contraRevenueCents: 0, opexCents: 0 }
      buckets.set(k, b)
    }
    return b
  }

  for (const row of grouped) {
    const acc = accMap.get(row.accountId)
    if (!acc) continue
    const amt = row._sum.amountCents ?? 0
    if (amt === 0) continue
    const b = ensure(row.conceptId)
    if (acc.type === 'revenue') {
      b.revenueCents += row.type === 'credit' ? amt : -amt
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

// ─── Brand P&L with the head-office line (owner decision 22) ─────────────────
// The ONE per-brand P&L reader for dashboards. Every figure is measured from
// the ledger: brand-tagged lines are that brand's; a shared cost reaches a
// brand only through a POSTED allocation (the /allocations rules post their
// runs with each debit tagged to its brand). Whatever no rule has allocated —
// head-office rent, untagged overhead, manual entries, older postings — is
// shown as ONE "Head office (unallocated)" line, never spread across brands
// by revenue share. Labour is the wage accounts (6030–6035): tagged wages are
// the brand's, untagged wages are head office's.

export const WAGE_CODES = ['6030', '6031', '6032', '6035'] as const
export const HEAD_OFFICE_LABEL = 'Head office (unallocated)'

export interface BrandPnlRow {
  conceptId: string | null          // null = head office (unallocated)
  name: string
  revenueCents: number
  contraCents: number
  netRevenueCents: number
  cogsCents: number
  opexCents: number                 // includes labour
  labourCents: number
  grossProfitCents: number
  netProfitCents: number
  grossMarginPct: number
  netMarginPct: number
  foodCostPct: number
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

function brandRow(conceptId: string | null, name: string, m: { revenue: number; contra: number; cogs: number; opex: number; labour: number }): BrandPnlRow {
  const netRevenueCents  = m.revenue - m.contra
  const grossProfitCents = m.revenue - m.contra - m.cogs
  const netProfitCents   = grossProfitCents - m.opex
  const pctOf = (c: number) => (m.revenue > 0 ? Number(((c / m.revenue) * 100).toFixed(2)) : 0)
  return {
    conceptId, name,
    revenueCents: m.revenue, contraCents: m.contra, netRevenueCents,
    cogsCents: m.cogs, opexCents: m.opex, labourCents: m.labour,
    grossProfitCents, netProfitCents,
    grossMarginPct: pctOf(grossProfitCents),
    netMarginPct: pctOf(netProfitCents),
    foodCostPct: pctOf(m.cogs),
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
  const grouped = await prisma.journalLine.groupBy({
    by: ['conceptId', 'accountId', 'type'],
    _sum: { amountCents: true },
    where: { journalEntry: { tenantId: { in: tenantIds }, entryDate: { gte: dateFrom, lte: dateTo } } },
  })
  const accounts = await prisma.account.findMany({
    where: { id: { in: Array.from(new Set(grouped.map((g) => g.accountId))) } },
    select: { id: true, code: true, type: true },
  })
  const accMap = new Map(accounts.map((a) => [a.id, a]))
  const known = new Map(brands.map((b) => [b.id, b.name]))
  type M = { revenue: number; contra: number; cogs: number; opex: number; labour: number }
  const zero = (): M => ({ revenue: 0, contra: 0, cogs: 0, opex: 0, labour: 0 })
  const perBrand = new Map<string, M>(brands.map((b) => [b.id, zero()]))
  const ho = zero()
  for (const row of grouped) {
    const acc = accMap.get(row.accountId)
    if (!acc) continue
    const amt = row._sum.amountCents ?? 0
    if (amt === 0) continue
    const bucket = row.conceptId && known.has(row.conceptId) ? perBrand.get(row.conceptId)! : ho
    if (acc.type === 'revenue') {
      bucket.revenue += row.type === 'credit' ? amt : -amt
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
  const brandRows = brands
    .map((b) => brandRow(b.id, b.name, perBrand.get(b.id)!))
    .filter((r) => r.revenueCents !== 0 || r.cogsCents !== 0 || r.opexCents !== 0 || r.contraCents !== 0)
    .sort((a, b) => b.revenueCents - a.revenueCents)
  const total = zero()
  for (const m of [...perBrand.values(), ho]) {
    total.revenue += m.revenue; total.contra += m.contra; total.cogs += m.cogs; total.opex += m.opex; total.labour += m.labour
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
// account (1010, 1015, 1020, 1030), report inflow / outflow / net for the
// period, then attribute by the OPPOSING account on each line.

const CASH_ACCOUNT_CODES = [ACCT.CASH_ON_HAND, ACCT.CASH_DRAWER, ACCT.BANK, ACCT.CARD_RECEIVABLE]

export interface CashFlowReport {
  dateFrom: string
  dateTo: string
  byCashAccount: Array<{
    code: string
    name: string
    inflowCents: number
    outflowCents: number
    netCents: number
  }>
  byCategory: Array<{
    category: 'operating' | 'investing' | 'financing'
    inflowCents: number
    outflowCents: number
    netCents: number
  }>
  totals: { inflowCents: number; outflowCents: number; netCents: number }
}

function categorise(code: string, reference?: string | null): 'operating' | 'investing' | 'financing' {
  // Capex instalments are advances to suppliers (1340) until the asset is
  // delivered and capitalised (owner decision 24) — still investing cash.
  if (reference?.startsWith('capex.payment')) return 'investing'
  if (code.startsWith('15')) return 'investing'  // fixed assets
  if (code.startsWith('30')) return 'financing'  // owner capital / drawings
  return 'operating'
}

export async function cashFlow(tenantIds: string[], dateFrom: Date, dateTo: Date): Promise<CashFlowReport> {
  const cashAccounts = await prisma.account.findMany({
    where: { tenantId: { in: tenantIds }, code: { in: CASH_ACCOUNT_CODES } },
    select: { id: true, code: true, name: true },
  })
  const cashAccountIds = new Set(cashAccounts.map((a) => a.id))

  // Pull every line in entries that touched a cash account
  const entriesWithCash = await prisma.journalEntry.findMany({
    where: {
      tenantId: { in: tenantIds },
      entryDate: { gte: dateFrom, lte: dateTo },
      lines: { some: { accountId: { in: Array.from(cashAccountIds) } } },
    },
    include: { lines: { include: { account: true } } },
  })

  // Per-cash-account inflow/outflow (debit to cash = inflow; credit = outflow)
  const perCash = new Map(cashAccounts.map((a) => [a.id, { code: a.code, name: a.name, inflowCents: 0, outflowCents: 0 }]))

  // Per-category — opposing-account driven
  const perCategory = new Map<'operating' | 'investing' | 'financing', { inflowCents: number; outflowCents: number }>([
    ['operating', { inflowCents: 0, outflowCents: 0 }],
    ['investing', { inflowCents: 0, outflowCents: 0 }],
    ['financing', { inflowCents: 0, outflowCents: 0 }],
  ])

  for (const entry of entriesWithCash) {
    for (const line of entry.lines) {
      if (!cashAccountIds.has(line.accountId)) continue
      const slot = perCash.get(line.accountId)!
      if (line.type === 'debit') slot.inflowCents  += line.amountCents
      else                        slot.outflowCents += line.amountCents
    }

    // Determine dominant non-cash account for category attribution
    const nonCashLines = entry.lines.filter((l) => !cashAccountIds.has(l.accountId))
    if (nonCashLines.length === 0) continue
    const dominant = nonCashLines.reduce((a, b) => (a.amountCents >= b.amountCents ? a : b))
    const category = categorise(dominant.account.code, entry.reference)
    const cashLines = entry.lines.filter((l) => cashAccountIds.has(l.accountId))
    const inflow  = cashLines.filter((l) => l.type === 'debit').reduce((s, l) => s + l.amountCents, 0)
    const outflow = cashLines.filter((l) => l.type === 'credit').reduce((s, l) => s + l.amountCents, 0)
    const cat = perCategory.get(category)!
    cat.inflowCents  += inflow
    cat.outflowCents += outflow
  }

  const byCashAccount = Array.from(perCash.values())
    .sort((a, b) => a.code.localeCompare(b.code))
    .map((r) => ({ ...r, netCents: r.inflowCents - r.outflowCents }))

  const byCategory = Array.from(perCategory.entries())
    .map(([category, v]) => ({ category, ...v, netCents: v.inflowCents - v.outflowCents }))

  const totals = byCashAccount.reduce(
    (s, r) => ({
      inflowCents: s.inflowCents + r.inflowCents,
      outflowCents: s.outflowCents + r.outflowCents,
      netCents: s.netCents + r.netCents,
    }),
    { inflowCents: 0, outflowCents: 0, netCents: 0 },
  )

  return { dateFrom: fmtPktDate(dateFrom), dateTo: fmtPktDate(dateTo), byCashAccount, byCategory, totals }
}
