// Where an account shows in the P&L — the ONE reading (owner, 2026-11-18: "account code should not decide where an
// account balance will reflect in P&L or BS … An account which relates to operating expenses, should stay in
// operating expenses despite of account codes being matched with other set. It should not happen again").
//
// Account.plSection is the STORED answer for a revenue or expense account:
//   revenue   'revenue' (sales and operating revenue) | 'other_income' (below operating profit)
//   expense   'cost_of_sales' (above gross profit) | 'contra_revenue' (discounts / refunds, taken off sales)
//             | 'operating_expense'
// Every account finance or the CEO adds stores it (the chart form asks "Shows in"), and the migration stored it on
// every existing account. Only an account a servd MODULE creates by its own fixed code (the chart template, brand
// sales accounts, head-office charges, a cost split's copy made before this rule) may still have NULL — for those the
// code IS the account's identity and `defaultSectionByCode` answers. Never read a code prefix for this anywhere else.
//
// The balance sheet's side is the account's `type`; current / non-current is lib/accountTerm.ts termOf (stored on
// every hand-made account too).
//
// Codes are picked by servd (`nextAccountCodeTx`), never typed: the first free code of the band below that NO company
// of servd uses — so a code means the same account in every company (a cost split copies an account to another
// company under its code) and never lands on a code a servd module posts to.

import { Prisma } from '@prisma/client'
import { AppError } from './errors.js'

export const REVENUE_SECTIONS = ['revenue', 'other_income'] as const
export const EXPENSE_SECTIONS = ['cost_of_sales', 'contra_revenue', 'operating_expense'] as const
export const PL_SECTIONS = [...REVENUE_SECTIONS, ...EXPENSE_SECTIONS] as const
export type PlSection = (typeof PL_SECTIONS)[number]

export const PL_SECTION_LABELS: Record<PlSection, string> = {
  revenue: 'Sales / operating revenue',
  other_income: 'Other income',
  cost_of_sales: 'Cost of sales',
  contra_revenue: 'Discounts & refunds (taken off sales)',
  operating_expense: 'Operating expenses',
}

/** The section a module-created account has by its fixed code (the rule every report used before 2026-11-18). */
export function defaultSectionByCode(type: string, code: string): PlSection | null {
  if (type === 'revenue') return code.startsWith('42') ? 'other_income' : 'revenue'
  if (type === 'expense') {
    if (code.startsWith('5')) return 'cost_of_sales'
    if (code.startsWith('7')) return 'contra_revenue'
    return 'operating_expense'
  }
  return null
}

const isSection = (v: unknown): v is PlSection => typeof v === 'string' && (PL_SECTIONS as readonly string[]).includes(v)

/** The account's P&L section: the stored one, else the module default. Null for asset / liability / equity. */
export function plSectionOf(a: { type: string; code: string; plSection?: string | null }): PlSection | null {
  if (a.type !== 'revenue' && a.type !== 'expense') return null
  const allowed: readonly string[] = a.type === 'revenue' ? REVENUE_SECTIONS : EXPENSE_SECTIONS
  if (isSection(a.plSection) && allowed.includes(a.plSection)) return a.plSection
  return defaultSectionByCode(a.type, a.code)
}

/** An ordinary running-cost account: an expense account that shows in Operating expenses. */
export function isOperatingExpense(a: { type: string; code: string; plSection?: string | null }): boolean {
  return a.type === 'expense' && plSectionOf(a) === 'operating_expense'
}

/** 422 unless `section` fits the account type. */
export function assertSectionFitsType(type: string, section: string): asserts section is PlSection {
  const allowed: readonly string[] = type === 'revenue' ? REVENUE_SECTIONS : type === 'expense' ? EXPENSE_SECTIONS : []
  if (!allowed.includes(section)) {
    throw new AppError('SECTION_NOT_FOR_TYPE', type === 'revenue'
      ? 'A revenue account shows in Sales / operating revenue or Other income'
      : type === 'expense'
        ? 'An expense account shows in Cost of sales, Operating expenses or Discounts & refunds'
        : 'Only revenue and expense accounts have a P&L section', 422)
  }
}

// ─── Codes picked by servd ───────────────────────────────────────────────────

export type CodeBand = 'bank' | 'asset' | 'liability' | 'equity' | PlSection

/**
 * The band a hand-made account's code comes from. None of them holds a code the chart template or a module creates
 * (lib/chartOfAccounts.ts; brand sales 4001–4090; register 1500–1599 / 2012; inter-company 1400–1499 / 2100–2199;
 * head-office charges 6200–6249; recharges 6990–6999), so `ensureChartOfAccounts` can never adopt a hand-made account
 * as a system one. The band is only where the number comes from — it decides nothing afterwards.
 */
const BANDS: Record<CodeBand, readonly [number, number]> = {
  bank:              [1040, 1099], // lib/bankAccounts.ts: a bank's chart code is a 10xx asset
  asset:             [1700, 1999],
  liability:         [2300, 2999],
  equity:            [3040, 3099],
  revenue:           [4300, 4899],
  other_income:      [4900, 4999],
  cost_of_sales:     [5100, 5999],
  operating_expense: [6300, 6989],
  contra_revenue:    [7100, 7999],
}

export function codeBandOf(a: { type: string; plSection?: string | null; isBank?: boolean }): CodeBand {
  if (a.type === 'asset') return a.isBank ? 'bank' : 'asset'
  if (a.type === 'liability') return 'liability'
  if (a.type === 'equity') return 'equity'
  return (a.plSection as PlSection | null | undefined) ?? (a.type === 'revenue' ? 'revenue' : 'operating_expense')
}

/**
 * The next code for a new hand-made account: the first number of the band no account of ANY company starts with.
 * Call inside the creating transaction on the SERVICE client's transaction (it must see every company); it takes a
 * servd-wide advisory lock so two creations never get the same code.
 */
export async function nextAccountCodeTx(tx: Prisma.TransactionClient, band: CodeBand): Promise<string> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('servd:account_code'))`
  const [lo, hi] = BANDS[band]
  // POSIX classes, not \\d / \\s: a tagged template would swallow the backslashes.
  const rows = await tx.$queryRaw<Array<{ lead: string }>>`
    SELECT DISTINCT substring(code from '^[[:space:]]*([0-9]{4})') AS lead FROM "accounts" WHERE code ~ '^[[:space:]]*[0-9]{4}'`
  const taken = new Set(rows.map((r) => Number(r.lead)))
  for (let n = lo; n <= hi; n++) if (!taken.has(n)) return String(n)
  throw new AppError('NO_FREE_ACCOUNT_CODE', 'servd has run out of codes for this kind of account — tell IT', 422)
}
