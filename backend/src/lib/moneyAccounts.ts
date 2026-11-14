// THE definition of a company's "money accounts" (finance decision, clean-up A6, 2026-11-14): cash on hand 1010,
// petty cash 1011, the default bank 1020, and the ledger codes of the company's LINKED bank accounts (a bank_accounts
// row of that company with an accountCode) — never a code on NOT_BANK_CODES (the drawer 1015, card clearing 1030,
// till / customer receivables …). Nothing else: not 1015, not a 102x code no bank of the company is linked to.
//
// Read by the payments register and the Journals tab (accounting/paymentsRegister.ts — its SQL twin
// moneyAggregatesSql applies the same rule), the automatic PV / RV voucher stamp (accounting/voucherNumbers.ts) and
// the sales-tax payment link (accounting/taxPayments.ts). Which accounts a hand-picked manual PV / RV may credit /
// debit is a separate rule (voucherNumbers.ts assertManualVoucherKind: any asset or liability).

import type { Prisma, PrismaClient } from '@prisma/client'
import type { prisma } from './prisma.js'
import { NOT_BANK_CODES } from './bankAccounts.js'

type Db = PrismaClient | Prisma.TransactionClient | typeof prisma

/** Cash on hand, petty cash, the default bank. */
export const FIXED_MONEY_CODES = ['1010', '1011', '1020'] as const
/** Codes a linked bank account can never make a money account. */
export const BANK_CODE_EXCLUDED: readonly string[] = NOT_BANK_CODES.filter((c) => !(FIXED_MONEY_CODES as readonly string[]).includes(c))

/** The money accounts of each company: 1010, 1011, 1020 + its linked bank accounts' codes. */
export async function moneyCodesOf(db: Db, tenantIds: string[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>(tenantIds.map((t) => [t, new Set<string>(FIXED_MONEY_CODES)]))
  if (tenantIds.length === 0) return out
  const banks = await db.bankAccount.findMany({ where: { tenantId: { in: tenantIds }, accountCode: { not: null } }, select: { tenantId: true, accountCode: true } })
  for (const b of banks) {
    if (!b.tenantId || !b.accountCode || BANK_CODE_EXCLUDED.includes(b.accountCode)) continue
    out.get(b.tenantId)?.add(b.accountCode)
  }
  return out
}

/** One company's money accounts (moneyCodesOf for a single company). */
export async function moneyCodesOfCompany(db: Db, tenantId: string): Promise<Set<string>> {
  return (await moneyCodesOf(db, [tenantId])).get(tenantId) ?? new Set<string>(FIXED_MONEY_CODES)
}
