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
async function aggregateByAccount(opts: {
  dateFrom?: Date
  dateTo?: Date
  upTo?: Date
}): Promise<AccountAggregation[]> {
  const where: Prisma.JournalLineWhereInput = {}
  if (opts.dateFrom || opts.dateTo || opts.upTo) {
    where.journalEntry = {
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

export async function trialBalance(asOf: Date): Promise<TrialBalanceReport> {
  const rows = await aggregateByAccount({ upTo: asOf })
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

export async function balanceSheet(asOf: Date): Promise<BalanceSheetReport> {
  const rows = await aggregateByAccount({ upTo: asOf })

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

export async function profitAndLoss(dateFrom: Date, dateTo: Date): Promise<ProfitAndLossReport> {
  const rows = await aggregateByAccount({ dateFrom, dateTo })

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

export async function pnlByConcept(dateFrom: Date, dateTo: Date): Promise<ConceptPnlBucket[]> {
  const grouped = await prisma.journalLine.groupBy({
    by: ['conceptId', 'accountId', 'type'],
    _sum: { amountCents: true },
    where: { journalEntry: { entryDate: { gte: dateFrom, lte: dateTo } } },
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

function categorise(code: string): 'operating' | 'investing' | 'financing' {
  if (code.startsWith('15')) return 'investing'  // fixed assets
  if (code.startsWith('30')) return 'financing'  // owner capital / drawings
  return 'operating'
}

export async function cashFlow(dateFrom: Date, dateTo: Date): Promise<CashFlowReport> {
  const cashAccounts = await prisma.account.findMany({
    where: { code: { in: CASH_ACCOUNT_CODES } },
    select: { id: true, code: true, name: true },
  })
  const cashAccountIds = new Set(cashAccounts.map((a) => a.id))

  // Pull every line in entries that touched a cash account
  const entriesWithCash = await prisma.journalEntry.findMany({
    where: {
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
    const category = categorise(dominant.account.code)
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
