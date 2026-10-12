// Bank accounts ↔ the chart of accounts.
//
// There is one registry of what the company has in the bank: the ledger. A
// BankAccount row (Configuration → Bank accounts) carries the bank details —
// name, IBAN, branch, title — and `accountCode`, the chart code in the SAME
// company's chart whose balance is that bank's balance. 1020 "Bank —
// Operating Account" is the first bank; each further bank gets its own child
// code in 1021–1029, checked against every code the company already has (an
// operator may have added their own).
//
// Deposits post to the bank's code, and bank-statement imports reconcile
// against it, so a deposit drop can finally be matched to its statement line.

import { Prisma } from '@prisma/client'
import { prisma } from './prisma.js'
import { AppError } from './errors.js'
import { sumCents } from './money.js'

export const OPERATING_BANK_CODE = '1020'
const CHILD_BANK_CODES = ['1021', '1022', '1023', '1024', '1025', '1026', '1027', '1028', '1029']

/**
 * The chart code a new bank account of `tenantId` should hang off.
 *
 * With `requestedCode`: it must be an active ASSET account in the company's
 * own chart (422 otherwise). Without: 1020 when no live bank account uses it
 * yet, else a new child account on the next free 102x code, named after the
 * bank.
 */
export async function linkBankLedgerAccount(
  tenantId: string,
  bankName: string,
  requestedCode?: string | null,
): Promise<string> {
  if (requestedCode) {
    const account = await prisma.account.findFirst({
      where: { tenantId, code: requestedCode, isActive: true },
      select: { type: true },
    })
    if (!account) throw new AppError('ACCOUNT_NOT_IN_CHART', `Code ${requestedCode} is not an active account in this company's chart of accounts`, 422)
    if (account.type !== 'asset') throw new AppError('NOT_AN_ASSET_ACCOUNT', `Code ${requestedCode} is not an asset account — a bank balance is an asset`, 422)
    return requestedCode
  }

  const operatingInUse = await prisma.bankAccount.count({
    where: { tenantId, deletedAt: null, accountCode: OPERATING_BANK_CODE },
  })
  if (operatingInUse === 0) {
    const operating = await prisma.account.findFirst({
      where: { tenantId, code: OPERATING_BANK_CODE, isActive: true },
      select: { id: true },
    })
    if (operating) return OPERATING_BANK_CODE
  }

  // Two tries: a concurrent create can take the same free code first.
  for (let attempt = 0; attempt < 2; attempt++) {
    const taken = new Set(
      (await prisma.account.findMany({ where: { tenantId, code: { in: CHILD_BANK_CODES } }, select: { code: true } }))
        .map((a) => a.code),
    )
    const code = CHILD_BANK_CODES.find((c) => !taken.has(c))
    if (!code) {
      throw new AppError('NO_FREE_BANK_CODE', 'Codes 1021–1029 are all in use — pick an existing asset account for this bank', 422)
    }
    try {
      await prisma.account.create({
        data: { tenantId, code, name: `Bank — ${bankName}`.slice(0, 120), type: 'asset', description: 'Bank account (Configuration → Bank accounts)', isActive: true },
      })
      return code
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') continue
      throw err
    }
  }
  throw new AppError('NO_FREE_BANK_CODE', 'Could not reserve a bank code — try again', 409)
}

/**
 * The ledger code a bank account's money sits in, for postings: its linked
 * code when the account belongs to `tenantId`, else the operating bank.
 */
export async function bankLedgerCode(tenantId: string, bankAccountId: string | null | undefined): Promise<string> {
  if (!bankAccountId) return OPERATING_BANK_CODE
  const bank = await prisma.bankAccount.findFirst({
    where: { id: bankAccountId, tenantId },
    select: { accountCode: true },
  })
  return bank?.accountCode ?? OPERATING_BANK_CODE
}

/**
 * Ledger balance (debits − credits, in paisa) of each code in `tenantId`'s
 * chart. This — not BankAccount.openingBalanceCents — is a bank's balance.
 */
export async function ledgerBalancesByCode(tenantId: string, codes: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (codes.length === 0) return out
  const accounts = await prisma.account.findMany({
    where: { tenantId, code: { in: Array.from(new Set(codes)) } },
    select: { id: true, code: true },
  })
  if (accounts.length === 0) return out
  const sums = await prisma.journalLine.groupBy({
    by: ['accountId', 'type'],
    where: { accountId: { in: accounts.map((a) => a.id) } },
    _sum: { amountCents: true },
  })
  const codeOf = new Map(accounts.map((a) => [a.id, a.code]))
  for (const a of accounts) out.set(a.code, 0)
  for (const s of sums) {
    const code = codeOf.get(s.accountId)
    if (!code) continue
    const amt = sumCents(s._sum.amountCents)
    out.set(code, (out.get(code) ?? 0) + (s.type === 'debit' ? amt : -amt))
  }
  return out
}
