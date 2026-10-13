// An OpEx category's own expense account (finance gaps 17d).
//
// OpexCategory.expenseAccountCode is the 6xxx account in the category's
// company's chart that its payments post to. It replaces the name-keyword
// guess, which now only SUGGESTS a code:
//   • on create, when the operator names none, the name map pre-fills it —
//     only when that company's chart has the code as an active expense;
//   • categories that predate the column are backfilled the same way, once,
//     at boot (backfillOpexCategoryAccounts — idempotent, never overwrites);
//   • a category still unmapped asks on its first payment, and the code named
//     there is remembered on the category (opex/posting.ts).
// The payroll category never carries one: HR payroll books wages.

import type { Prisma } from '@prisma/client'
import { serviceClient } from '../../lib/prisma.js'
import { AppError } from '../../lib/errors.js'
import { assertExpenseCode, expenseCodeForCategoryName, isPayrollCategory } from '../accounting/expenseCategories.js'

type Db = Pick<typeof serviceClient, 'account' | 'opexCategory'> | Prisma.TransactionClient

/**
 * 422 unless `code` can be the account of a category called `name` in
 * `tenantId`: never on the payroll category, and always an active 6xxx
 * expense account of that company's own chart.
 */
export async function assertCategoryAccount(tenantId: string, name: string, code: string): Promise<void> {
  if (isPayrollCategory(name)) {
    throw new AppError('PAYROLL_CATEGORY', 'The payroll category has no expense account here — HR payroll books wages', 422)
  }
  await assertExpenseCode(tenantId, code)
}

/** The name map's code for a category, when `tenantId`'s chart has it as an active expense account; else null. */
export async function suggestedCategoryAccount(db: Db, tenantId: string, name: string): Promise<string | null> {
  if (isPayrollCategory(name)) return null
  const code = expenseCodeForCategoryName(name)
  if (!code) return null
  const acct = await db.account.findFirst({ where: { tenantId, code, isActive: true, type: 'expense' }, select: { id: true } })
  return acct ? code : null
}

/**
 * Give every category that predates the column the account its name maps to,
 * where its company's chart has that code as an active expense account.
 * Idempotent: only categories with no account are touched, and a code the
 * operator set is never overwritten. Payroll and company-less categories are
 * left alone. Runs at boot.
 */
export async function backfillOpexCategoryAccounts(db: Db = serviceClient): Promise<{ mapped: number; unmapped: number }> {
  const cats = await db.opexCategory.findMany({
    where: { expenseAccountCode: null, tenantId: { not: null } },
    select: { id: true, tenantId: true, name: true },
  })
  // The active expense codes of each company in play, read once per company.
  const codesOf = new Map<string, Set<string>>()
  for (const tenantId of new Set(cats.map((c) => c.tenantId!))) {
    const accounts = await db.account.findMany({
      where: { tenantId, isActive: true, type: 'expense', code: { startsWith: '6' } },
      select: { code: true },
    })
    codesOf.set(tenantId, new Set(accounts.map((a) => a.code)))
  }
  let mapped = 0
  let unmapped = 0
  for (const c of cats) {
    if (isPayrollCategory(c.name)) continue
    const code = expenseCodeForCategoryName(c.name)
    if (!code || !codesOf.get(c.tenantId!)?.has(code)) { unmapped += 1; continue }
    // Guarded on NULL: an operator's pick made meanwhile is never replaced.
    const r = await db.opexCategory.updateMany({ where: { id: c.id, expenseAccountCode: null }, data: { expenseAccountCode: code } })
    mapped += r.count
  }
  return { mapped, unmapped }
}
