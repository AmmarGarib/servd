// Labour % — wages over revenue for a window, per company.
//
// Both sides come from the ledger: revenue from revenue accounts, wages from
// the wages accounts HR payroll posts to when a month is locked. That keeps the
// ratio on one source of truth and scoped to the same companies.

import { prisma } from './prisma.js'
import { ACCT } from '../modules/accounting/journal.js'
import { toCents } from './money.js'

const WAGE_CODES = [ACCT.WAGES_KITCHEN, ACCT.WAGES_FOH, ACCT.WAGES_MANAGEMENT, ACCT.WAGES_RIDERS]

/** Net (credits minus debits, or the reverse) per account code over the window. */
async function netByCode(tenantIds: string[], from: Date, to: Date, where: { type?: 'revenue'; codes?: string[] }) {
  const rows = await prisma.journalLine.findMany({
    where: {
      account: { ...(where.type && { type: where.type }), ...(where.codes && { code: { in: where.codes } }) },
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
  const [revenue, wages] = await Promise.all([
    netByCode(tenantIds, periodStart, periodEnd, { type: 'revenue' }),
    netByCode(tenantIds, periodStart, periodEnd, { codes: WAGE_CODES }),
  ])
  const revenueCents = Array.from(revenue.values()).reduce((s, v) => s + v.credit - v.debit, 0)
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
