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
 * code when the account belongs to `tenantId`; the operating bank when no
 * account is named. A named account of another company, a deleted one or an
 * unlinked one is REFUSED (422) — never silently booked to 1020.
 */
export async function bankLedgerCode(
  tenantId: string,
  bankAccountId: string | null | undefined,
  db: Db = prisma,
): Promise<string> {
  if (!bankAccountId) return OPERATING_BANK_CODE
  return (await liveBank(db, tenantId, bankAccountId)).accountCode
}

type Db = Pick<typeof prisma, 'bankAccount'> | Prisma.TransactionClient

/** A live, linked bank account of `tenantId`, or 422. */
async function liveBank(db: Db, tenantId: string, bankAccountId: string): Promise<{ id: string; accountCode: string; name: string }> {
  const bank = await db.bankAccount.findFirst({
    where: { id: bankAccountId, tenantId, deletedAt: null },
    select: { id: true, accountCode: true, name: true, isActive: true },
  })
  if (!bank || !bank.isActive) {
    throw new AppError('BANK_ACCOUNT_NOT_IN_COMPANY', 'That bank account is not an active account of this company', 422)
  }
  if (!bank.accountCode) {
    throw new AppError('BANK_ACCOUNT_NOT_LINKED', `Link "${bank.name}" to a chart code first (Configuration → Bank accounts)`, 422)
  }
  return { id: bank.id, accountCode: bank.accountCode, name: bank.name }
}

/** How money moved, as the payment screens name it. */
export type MoneyMethod =
  | 'cash'
  | 'card'
  | 'bank' | 'bank_transfer' | 'cheque' | 'wallet' | 'online'

const CASH_ON_HAND_CODE = '1010'
const CARD_RECEIVABLE_CODE = '1030'
const BANK_METHODS = new Set<string>(['bank', 'bank_transfer', 'cheque', 'wallet', 'online'])

/**
 * THE one answer to "which account did this money go into / come out of" for
 * every payment that is not a till sale: supplier payments, receivable
 * receipts, wallet top-ups, CapEx instalments, gift-card sales, tax payments,
 * payroll and loans, OpEx (finance gaps #9, 2026-10-13).
 *
 *   cash → 1010 Cash on Hand · card → 1030 Card / Gateway Receivable
 *   bank-type (bank, bank_transfer, cheque, wallet, online) → the named bank
 *     account's chart code. It must be a live, active, LINKED account of
 *     `tenantId` (422 BANK_ACCOUNT_NOT_IN_COMPANY / BANK_ACCOUNT_NOT_LINKED).
 *     No account named: the company's only live linked bank; 1020 when it has
 *     none; 422 BANK_ACCOUNT_REQUIRED when it has two or more (never a guess).
 *     A 'wallet' payment must always name its wallet account.
 *
 * `tenantId` is the SOURCE DOCUMENT's company (the supplier's, the invoice's,
 * the card's), never the operator's.
 */
export async function moneyAccountCode(
  db: Db,
  tenantId: string,
  input: { method: string | null | undefined; bankAccountId?: string | null },
): Promise<{ code: string; bankAccountId: string | null }> {
  const method = (input.method ?? '').trim()
  if (method === 'cash') {
    if (input.bankAccountId) throw new AppError('BANK_ACCOUNT_ON_CASH', 'A cash payment does not use a bank account', 422)
    return { code: CASH_ON_HAND_CODE, bankAccountId: null }
  }
  if (method === 'card') return { code: CARD_RECEIVABLE_CODE, bankAccountId: null }
  if (!BANK_METHODS.has(method)) {
    throw new AppError('BAD_PAYMENT_METHOD', `Unknown payment method "${method}"`, 422)
  }
  if (input.bankAccountId) {
    const bank = await liveBank(db, tenantId, input.bankAccountId)
    return { code: bank.accountCode, bankAccountId: bank.id }
  }
  // A mobile wallet (JazzCash / Easypaisa) is its own account row — never
  // assumed to be the company's bank.
  if (method === 'wallet') {
    throw new AppError('BANK_ACCOUNT_REQUIRED', 'Say which wallet account (Configuration → Bank accounts) the money went through', 422)
  }
  const banks = await db.bankAccount.findMany({
    where: { tenantId, deletedAt: null, isActive: true, accountCode: { not: null } },
    select: { id: true, accountCode: true },
    take: 2,
  })
  if (banks.length === 0) return { code: OPERATING_BANK_CODE, bankAccountId: null }
  if (banks.length === 1) return { code: banks[0]!.accountCode!, bankAccountId: banks[0]!.id }
  throw new AppError('BANK_ACCOUNT_REQUIRED', 'This company has more than one bank account — say which one the money went through', 422)
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
