// ONE mapping from a spend category to its chart code — used by every place
// that spends money outside procurement: OpEx payments marked paid (owner
// decision 23), drawer pay-outs to vendors (decision 5) and petty-cash spends
// (finance wave B, H2: a box spend is Dr <category's code> / Cr 1011). A
// category the mapping does not know is refused rather than guessed, so
// nothing lands on a catch-all line nobody reviews.
//
// PAYOUT_CATEGORIES is the ONE list of spend categories (the till's pay-outs
// and petty cash share it). Each carries a `kind`:
//   • 'expense' — an operating expense (6xxx). The till and a live box spend
//     offer only these.
//   • 'cogs'    — kitchen food / drinks / packaging (5010 / 5020 / 5030). Used
//     ONLY as a pick for a pre-FIFO spend in the petty-cash HISTORY backfill.
//     Food, drinks and packaging bought with cash today come in as STOCK lines
//     (the owner's FIFO rule), so a live spend with a 'cogs' key is 422
//     USE_STOCK_LINE and the food-cost report sees every purchase.
// resolveSpendAccount turns a key (or, for a cash keeper, an explicit 6xxx
// code) into the company's account.
//
// The name map is a SUGGESTION. An OpEx category carries its own account
// (OpexCategory.expenseAccountCode, finance gaps 17d): the name map only
// pre-fills it when the category is created and backfills categories that
// predate the column (opex/categoryAccounts.ts). An explicit code — the
// category's column, or one the operator picks on the payment — always wins,
// as long as it is an operating-expense (6xxx) account in the company's own
// chart.

import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { AppError } from '../../lib/errors.js'

type Db = Pick<typeof prisma, 'account'> | Prisma.TransactionClient

/**
 * Keyword → 6xxx code. First match wins, so the specific ones come first.
 * `unless`: the rule is skipped when the name also matches it.
 */
const RULES: Array<{ match: RegExp; unless?: RegExp; code: string; label: string }> = [
  { match: /\b(rent|lease|premises)\b/i,                         code: '6010', label: 'Rent' },
  // A generator replaces the grid: its fuel is a power cost, not travel
  // (the travel rule below would catch "Generator fuel" on 'fuel').
  // A generator's repair or service is maintenance (6050), not power.
  { match: /\b(generator|genset)\b/i, unless: /\b(repair|repairs|maintenance|maint|service|servicing)\b/i, code: '6020', label: 'Electricity' },
  { match: /\b(electric|electricity|power|k-?electric|lesco|ke bill)\b/i, code: '6020', label: 'Electricity' },
  { match: /\b(gas|sui|lpg)\b/i,                                 code: '6021', label: 'Gas' },
  { match: /\b(internet|telecom|phone|mobile|broadband|wifi)\b/i, code: '6022', label: 'Internet & Telecom' },
  { match: /\b(water|tanker)\b/i,                                code: '6023', label: 'Water' },
  // A bare "Utilities" (no gas / water / electricity word — those matched
  // above) is the utility bill, which for a kitchen is the power bill. The
  // till's 'utilities' pay-out uses the SAME code (UTILITIES_CODE below).
  { match: /\butilit(y|ies)\b/i,                                 code: '6020', label: 'Electricity' },
  { match: /\b(clean|cleaning|supplies|janitorial|toiletr)/i,    code: '6040', label: 'Cleaning & Supplies' },
  { match: /\b(repair|maintenance|maint|service contract|amc)\b/i, code: '6050', label: 'Repairs & Maintenance' },
  { match: /\b(marketing|promo|advertis|ads|social media|influencer)/i, code: '6060', label: 'Marketing & Promo' },
  // Licences before software: a trade / food-authority licence fee is a
  // licence, not a subscription — unless the name says it is software.
  { match: /\b(licen[cs]es?|permits?|registration)\b/i, unless: /\b(software|saas|subscriptions?)\b/i, code: '6120', label: 'Licences & Permits' },
  { match: /\b(software|subscriptions?|saas)\b/i,                code: '6070', label: 'Software & Subscriptions' },
  { match: /\b(bank charge|bank fee)/i,                          code: '6081', label: 'Bank Charges' },
  { match: /\b(insurance)\b/i,                                   code: '6100', label: 'Insurance' },
  { match: /\b(legal|accounting|audit|consult|professional|broker)/i, code: '6110', label: 'Professional Fees' },
  { match: /\b(property tax)\b/i,                                code: '6130', label: 'Property Taxes' },
  { match: /\b(travel|fuel|transport|entertainment|conveyance)\b/i, code: '6140', label: 'Travel & Entertainment' },
]

/** The one code for a bare "utilities" — the name map and the till pay-out agree. */
const UTILITIES_CODE = '6020'

export type SpendCategoryKind = 'expense' | 'cogs'

/**
 * THE spend categories (decision 5 + finance wave B). The till's pay-outs and
 * live petty-cash spends offer the 'expense' ones; the 'cogs' ones are
 * history-backfill picks only (see the header).
 */
export const PAYOUT_CATEGORIES: ReadonlyArray<{ key: string; label: string; code: string; kind: SpendCategoryKind }> = [
  { key: 'cleaning',          label: 'Cleaning & supplies',          code: '6040',          kind: 'expense' },
  { key: 'repairs',           label: 'Repairs & maintenance',        code: '6050',          kind: 'expense' },
  { key: 'utilities',         label: 'Utilities (electricity)',      code: UTILITIES_CODE,  kind: 'expense' },
  { key: 'water',             label: 'Water (tanker, bottled)',      code: '6023',          kind: 'expense' },
  { key: 'gas',               label: 'Gas (cylinder, LPG)',          code: '6021',          kind: 'expense' },
  { key: 'marketing',         label: 'Marketing & promo',            code: '6060',          kind: 'expense' },
  { key: 'transport',         label: 'Transport / conveyance',       code: '6140',          kind: 'expense' },
  { key: 'licences',          label: 'Licences & permits',           code: '6120',          kind: 'expense' },
  { key: 'office',            label: 'Office & stationery',          code: '6170',          kind: 'expense' },
  { key: 'courier',           label: 'Postage & courier',            code: '6175',          kind: 'expense' },
  { key: 'staff_welfare',     label: 'Staff welfare & refreshments', code: '6180',          kind: 'expense' },
  { key: 'phone',             label: 'Phone & internet top-ups',     code: '6022',          kind: 'expense' },
  // History backfill picks only (pre-FIFO kitchen spends) — never live.
  { key: 'kitchen_food',      label: 'Kitchen food (history only)',      code: '5010', kind: 'cogs' },
  { key: 'kitchen_drinks',    label: 'Kitchen drinks (history only)',    code: '5020', kind: 'cogs' },
  { key: 'kitchen_packaging', label: 'Kitchen packaging (history only)', code: '5030', kind: 'cogs' },
]
export type PayoutCategory = string

/** The 'expense' categories — what the till and a live petty-cash spend offer. */
export const EXPENSE_PAYOUT_CATEGORIES = PAYOUT_CATEGORIES.filter((c) => c.kind === 'expense')
/** The keys of EXPENSE_PAYOUT_CATEGORIES, as a zod enum tuple. */
export const EXPENSE_PAYOUT_KEYS = EXPENSE_PAYOUT_CATEGORIES.map((c) => c.key) as [string, ...string[]]

/** A category by key, or undefined. */
export function payoutCategory(key: string | null | undefined) {
  return key ? PAYOUT_CATEGORIES.find((c) => c.key === key) : undefined
}

/** The 6xxx code a category name maps to, or null when it cannot be told. */
export function expenseCodeForCategoryName(name: string | null | undefined): string | null {
  if (!name) return null
  for (const r of RULES) {
    if (r.match.test(name) && !(r.unless && r.unless.test(name))) return r.code
  }
  return null
}

/** True for the payroll category, which HR payroll posts (hr/ledger.ts) — never here. */
export function isPayrollCategory(name: string | null | undefined): boolean {
  return !!name && /\b(payroll|salar(y|ies)|wages?)\b/i.test(name)
}

/**
 * 422 unless `code` is an active operating-expense account (6xxx) in the
 * company's chart. Operators may add their own 6xxx codes; COGS, contra-revenue
 * and balance-sheet codes are not operating expenses. `db` reads through the
 * caller's transaction when it holds one.
 */
export async function assertExpenseCode(tenantId: string, code: string, db: Db = prisma): Promise<void> {
  if (!/^6\d{3}$/.test(code)) {
    throw new AppError('NOT_AN_EXPENSE_CODE', `${code} is not an operating-expense (6xxx) account`, 422)
  }
  const acct = await db.account.findFirst({ where: { tenantId, code, isActive: true, type: 'expense' }, select: { id: true } })
  if (!acct) throw new AppError('ACCOUNT_NOT_FOUND', `This company's chart has no active expense account ${code}`, 422)
}

/**
 * The account a spend line is booked to, in `tenantId`'s chart:
 *   • `categoryKey` → its PAYOUT_CATEGORIES code, which must be an active
 *     account of the company (422 ACCOUNT_NOT_FOUND). An unknown key is 400
 *     SPEND_CATEGORY_UNKNOWN; a 'cogs' key is 422 USE_STOCK_LINE unless
 *     `allowCogs` (the history backfill's picks only).
 *   • `accountCode` (explicit) → only when `allowExplicit` (a cash keeper;
 *     else 403 EXPLICIT_ACCOUNT_NOT_ALLOWED), through assertExpenseCode (6xxx
 *     only — 1210 or any balance-sheet code is 422).
 *   • neither → 400 SPEND_CATEGORY_REQUIRED.
 * A key wins over a code when both are sent.
 */
export async function resolveSpendAccount(
  db: Db,
  tenantId: string,
  a: { categoryKey?: string | null; accountCode?: string | null },
  o: { allowExplicit: boolean; allowCogs?: boolean },
): Promise<{ code: string; categoryKey: string | null }> {
  const key = a.categoryKey?.trim() || null
  const explicit = a.accountCode?.trim() || null
  if (key) {
    const cat = payoutCategory(key)
    if (!cat) {
      throw new AppError('SPEND_CATEGORY_UNKNOWN', `"${key}" is not a spend category (${EXPENSE_PAYOUT_KEYS.join(', ')})`, 400)
    }
    if (cat.kind === 'cogs' && !o.allowCogs) {
      throw new AppError(
        'USE_STOCK_LINE',
        'Food, drinks and packaging bought with cash are booked as stock lines so the food-cost report sees them',
        422,
        { categoryKey: key },
      )
    }
    const acct = await db.account.findFirst({ where: { tenantId, code: cat.code, isActive: true }, select: { id: true } })
    if (!acct) throw new AppError('ACCOUNT_NOT_FOUND', `This company's chart has no active account ${cat.code} (${cat.label})`, 422)
    return { code: cat.code, categoryKey: cat.key }
  }
  if (explicit) {
    if (!o.allowExplicit) {
      throw new AppError('EXPLICIT_ACCOUNT_NOT_ALLOWED', 'Only a manager or finance can book a spend to an account of their choosing — pick a category', 403)
    }
    await assertExpenseCode(tenantId, explicit, db)
    return { code: explicit, categoryKey: null }
  }
  throw new AppError('SPEND_CATEGORY_REQUIRED', 'Say what the spend was for — pick a category', 400)
}
