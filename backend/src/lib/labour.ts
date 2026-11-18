// Labour % — wages over revenue for a window, per company.
//
// Both sides come from the ledger: revenue from revenue accounts, wages from
// the wages accounts HR payroll posts to when a month is locked. That keeps the
// ratio on one source of truth and scoped to the same companies.
//
// The revenue side is SALES: every revenue account except 42xx other income
// (4200 gift-card breakage — accounting/reports.ts isOtherIncomeCode). 4100
// service charge and 4110 delivery fees stay: they are sales.

import { prisma } from './prisma.js'
import { ACCT } from '../modules/accounting/journal.js'
import { toCents } from './money.js'
import { WAGES_EXPENSE_NAME } from '../modules/accounting/reports.js'
import { plSectionOf } from './accountSection.js'

const WAGE_CODES = [ACCT.WAGES_KITCHEN, ACCT.WAGES_FOH, ACCT.WAGES_MANAGEMENT, ACCT.WAGES_RIDERS]

/** Net (credits minus debits, or the reverse) per account code over the window. */
async function netByCode(tenantIds: string[], from: Date, to: Date, where: { type?: 'revenue'; codes?: string[]; orAccountIds?: string[]; notAccountIds?: string[] }) {
  const rows = await prisma.journalLine.findMany({
    where: {
      ...(where.orAccountIds?.length
        ? { OR: [{ account: { code: { in: where.codes ?? [] } } }, { accountId: { in: where.orAccountIds } }] }
        : { account: { ...(where.type && { type: where.type }), ...(where.codes && { code: { in: where.codes } }) }, ...(where.notAccountIds?.length && { accountId: { notIn: where.notAccountIds } }) }),
      journalEntry: { tenantId: { in: tenantIds }, entryDate: { gte: from, lte: to } },
    },
    select: { type: true, amountCents: true, account: { select: { code: true } } },
  })
  const m = new Map<string, { debit: number; credit: number }>()
  for (const r of rows) {
    const cur = m.get(r.account.code) ?? { debit: 0, credit: 0 }
    cur[r.type === 'debit' ? 'debit' : 'credit'] += toCents(r.amountCents)
    m.set(r.account.code, cur)
  }
  return m
}

export async function labourPctReport(tenantIds: string[], periodStart: Date, periodEnd: Date) {
  // Plus each company's own Wages Expense account (payroll books office pay there, owner 2026-11-04).
  const own = (await prisma.account.findMany({ where: { tenantId: { in: tenantIds }, type: 'expense' }, select: { id: true, name: true } }))
    .filter((a) => WAGES_EXPENSE_NAME.test(a.name)).map((a) => a.id)
  // Other income is never a sales figure — by the account's stored P&L section (lib/accountSection.ts), not its code.
  const otherIncome = (await prisma.account.findMany({ where: { tenantId: { in: tenantIds }, type: 'revenue' }, select: { id: true, code: true, type: true, plSection: true } }))
    .filter((a) => plSectionOf(a) === 'other_income').map((a) => a.id)
  const [revenue, wages] = await Promise.all([
    netByCode(tenantIds, periodStart, periodEnd, { type: 'revenue', notAccountIds: otherIncome }),
    netByCode(tenantIds, periodStart, periodEnd, { codes: WAGE_CODES, orAccountIds: own }),
  ])
  const revenueCents = Array.from(revenue.entries())
    .reduce((s, [, v]) => s + v.credit - v.debit, 0)
  const byWageAccount = Array.from(wages.entries()).map(([code, v]) => ({ code, cents: v.debit - v.credit }))
  const labourCents = byWageAccount.reduce((s, r) => s + r.cents, 0)
  return {
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    revenueCents,
    labourCents,
    labourPct: revenueCents > 0 ? Number(((labourCents / revenueCents) * 100).toFixed(2)) : 0,
    byWageAccount,
  }
}
