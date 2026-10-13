// ONE mapping from an operating-expense category to its chart code — used by
// every place that spends money outside procurement: OpEx payments marked paid
// (owner decision 23), drawer pay-outs to vendors (decision 5) and, once the
// cash domain wires it, petty-cash spends (the same "booked like a petty-cash
// spend" rule). A category the mapping does not know is refused rather than
// guessed, so nothing lands on a catch-all line nobody reviews.
//
// The name map is a SUGGESTION. An OpEx category carries its own account
// (OpexCategory.expenseAccountCode, finance gaps 17d): the name map only
// pre-fills it when the category is created and backfills categories that
// predate the column (opex/categoryAccounts.ts). An explicit code — the
// category's column, or one the operator picks on the payment — always wins,
// as long as it is an operating-expense (6xxx) account in the company's own
// chart.

import { prisma } from '../../lib/prisma.js'
import { AppError } from '../../lib/errors.js'

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

/** Categories the till offers for a vendor pay-out (decision 5). */
export const PAYOUT_CATEGORIES = [
  { key: 'cleaning',     label: 'Cleaning & supplies',      code: '6040' },
  { key: 'repairs',      label: 'Repairs & maintenance',    code: '6050' },
  { key: 'utilities',    label: 'Utilities (electricity)',  code: UTILITIES_CODE },
  { key: 'water',        label: 'Water (tanker, bottled)',  code: '6023' },
  { key: 'gas',          label: 'Gas (cylinder, LPG)',      code: '6021' },
  { key: 'marketing',    label: 'Marketing & promo',        code: '6060' },
  { key: 'transport',    label: 'Transport / conveyance',   code: '6140' },
  { key: 'licences',     label: 'Licences & permits',       code: '6120' },
] as const
export type PayoutCategory = (typeof PAYOUT_CATEGORIES)[number]['key']

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
 * and balance-sheet codes are not operating expenses.
 */
export async function assertExpenseCode(tenantId: string, code: string): Promise<void> {
  if (!/^6\d{3}$/.test(code)) {
    throw new AppError('NOT_AN_EXPENSE_CODE', `${code} is not an operating-expense (6xxx) account`, 422)
  }
  const acct = await prisma.account.findFirst({ where: { tenantId, code, isActive: true, type: 'expense' }, select: { id: true } })
  if (!acct) throw new AppError('ACCOUNT_NOT_FOUND', `This company's chart has no active expense account ${code}`, 422)
}
