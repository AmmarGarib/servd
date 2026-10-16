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
import { z } from 'zod'
import { prisma } from './prisma.js'
import { AppError } from './errors.js'
import { sumCents } from './money.js'

export const OPERATING_BANK_CODE = '1020'
const CHILD_BANK_CODES = ['1021', '1022', '1023', '1024', '1025', '1026', '1027', '1028', '1029']

/**
 * Codes that are never a bank's balance: cash on hand, petty cash, the till
 * drawer, card receivable, customer receivable, till clearing, rider COD,
 * cash advances, the director's account and the retired voucher hold. A bank
 * linked to one of them would make every bank payment move cash (or a
 * receivable) instead.
 */
export const NOT_BANK_CODES: readonly string[] = ['1010', '1011', '1015', '1030', '1110', '1115', '1351', '1355', '1356', '1357']
/** A bank's code lives in the cash-and-bank band 1000–1099 (receivables, stock, prepayments, inter-company and fixed assets never). */
const BANK_CODE_BAND = /^10\d\d$/

/**
 * The chart code a new bank account of `tenantId` should hang off.
 *
 * With `requestedCode`: it must be an active ASSET account in the company's
 * own chart (422 otherwise), in the cash-and-bank band 1000–1099, not one of
 * NOT_BANK_CODES and not a register-controlled account (422
 * NOT_A_BANK_CODE / ACCOUNT_CONTROLLED), and not the code of another live bank
 * of the company (409 BANK_CODE_IN_USE; `opts.bankAccountId` = the row being
 * edited, which may keep its own code). Without: 1020 when no live bank
 * account uses it yet, else a new child account on the next free 102x code,
 * named after the bank.
 */
export async function linkBankLedgerAccount(
  tenantId: string,
  bankName: string,
  requestedCode?: string | null,
  opts: { bankAccountId?: string } = {},
): Promise<string> {
  if (requestedCode) {
    const account = await prisma.account.findFirst({
      where: { tenantId, code: requestedCode, isActive: true },
      select: { type: true, controlledBy: true },
    })
    if (!account) throw new AppError('ACCOUNT_NOT_IN_CHART', `Code ${requestedCode} is not an active account in this company's chart of accounts`, 422)
    if (account.type !== 'asset') throw new AppError('NOT_AN_ASSET_ACCOUNT', `Code ${requestedCode} is not an asset account — a bank balance is an asset`, 422)
    if (NOT_BANK_CODES.includes(requestedCode) || !BANK_CODE_BAND.test(requestedCode)) {
      throw new AppError('NOT_A_BANK_CODE', `Code ${requestedCode} is not a bank balance — link a bank to a bank code (1020–1029, or another 10xx bank account you added)`, 422)
    }
    if (account.controlledBy) {
      throw new AppError('ACCOUNT_CONTROLLED', `Code ${requestedCode} is kept by ${account.controlledBy.replace(/_/g, ' ')} — it cannot be a bank`, 422)
    }
    const other = await prisma.bankAccount.findFirst({
      where: { tenantId, deletedAt: null, accountCode: requestedCode, ...(opts.bankAccountId && { id: { not: opts.bankAccountId } }) },
      select: { name: true },
    })
    if (other) throw new AppError('BANK_CODE_IN_USE', `Code ${requestedCode} is already the ledger of ${other.name} — each bank has its own code`, 409)
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
  | 'bank' | 'bank_transfer' | 'bank_deposit' | 'cheque' | 'wallet' | 'online'

const CASH_ON_HAND_CODE = '1010'
const CARD_RECEIVABLE_CODE = '1030'
// 'bank_deposit' = the payer paid cash (or a cheque) straight into one of our
// bank accounts at a branch — it lands in the named bank like a transfer.
const BANK_METHODS = new Set<string>(['bank', 'bank_transfer', 'bank_deposit', 'cheque', 'wallet', 'online'])

/**
 * THE one answer to "which account did this money go into / come out of" for
 * every payment that is not a till sale: supplier payments, receivable
 * receipts, wallet top-ups, CapEx instalments, gift-card sales, tax payments,
 * payroll and loans, OpEx (finance gaps #9, 2026-10-13).
 *
 *   cash → 1010 Cash on Hand · card → 1030 Card / Gateway Receivable
 *   bank-type (bank, bank_transfer, bank_deposit, cheque, wallet, online) → the named bank
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

// ─── Money received outside the till (owner, 2026-10-14) ─────────────────────
//
// Every back-office screen that records money coming IN (gift-card sales,
// wallet top-ups, receivable receipts and write-off recoveries, asset-sale
// proceeds, CapEx deposit returns, inter-company settlements) offers THESE
// methods (cash, bank transfer, bank deposit, cheque — never card) and asks
// for a payment reference # on EVERY method, cash included
// (owner: "required for every method"). A reference used before is a
// warning, never a block (one transfer can pay several invoices) — see
// lib/paymentRefs.ts. The till keeps its own tenders (lib/tenders.ts). The
// admin copy lives in components/finance/PaymentReceivedFields.tsx — keep the
// two in step. A bank deposit drop (POST /trustops/deposit-drops) is our own
// till cash going to the bank, not a receipt: its deposit slip # (slipNumber)
// is optional, goes into the posting's description and memos, and still
// warns when used before (lib/paymentRefs.ts).

/**
 * THE list of ways money can come in on a back-office screen. No card (owner,
 * 2026-10-16: "Back-office receipts take bank, bank deposit, cash or cheque
 * only. Tills keep card as today."): a back-office card receipt debited 1030
 * but Keenu payout matching counts only till card payments, so it was never
 * cleared. Rows already stored with 'card' still read (RECEIPT_METHOD_LABEL)
 * and refund the way they were paid (moneyAccountCode still maps card → 1030).
 */
export const RECEIPT_METHODS = ['cash', 'bank_transfer', 'bank_deposit', 'cheque'] as const
export type ReceiptMethod = typeof RECEIPT_METHODS[number]

/** Words for every method value servd has stored (old rows say 'bank' / 'online'). */
export const RECEIPT_METHOD_LABEL: Record<string, string> = {
  cash: 'Cash',
  card: 'Card',
  bank_transfer: 'Bank transfer',
  bank_deposit: 'Bank deposit',
  cheque: 'Cheque',
  bank: 'Bank transfer',
  online: 'Online payment',
  wallet: 'Mobile wallet',
}

/** True when the money lands in (or leaves) a bank account — the form shows the bank picker. */
export function isBankMethod(method: string | null | undefined): boolean {
  return BANK_METHODS.has((method ?? '').trim())
}

/**
 * A back-office receipt's method must be one of RECEIPT_METHODS — card is the
 * till's only (422 CARD_NOT_A_RECEIPT; anything else 422 BAD_PAYMENT_METHOD).
 * The services call it too, so a caller that skips the route's zod still
 * cannot debit 1030 from the back office.
 */
export function assertReceiptMethod(method: string | null | undefined): ReceiptMethod {
  const m = (method ?? '').trim()
  if ((RECEIPT_METHODS as readonly string[]).includes(m)) return m as ReceiptMethod
  if (m === 'card') {
    throw new AppError('CARD_NOT_A_RECEIPT', 'Card is taken at the till only — record this as a bank transfer, bank deposit, cash or cheque', 422)
  }
  throw new AppError('BAD_PAYMENT_METHOD', `Unknown payment method "${m}" — use cash, bank transfer, bank deposit or cheque`, 422)
}

/** zod: one of `allowed` (default RECEIPT_METHODS). */
export function zReceiptMethod<T extends readonly [string, ...string[]]>(allowed?: T) {
  return z.enum((allowed ?? RECEIPT_METHODS) as unknown as [string, ...string[]])
}

/** zod: the payment reference # as typed (trimmed, at most 100 characters). */
export const zPaymentRef = z.string().trim().max(100)

/**
 * The payment reference # for a receipt, trimmed — 422 PAYMENT_REFERENCE_REQUIRED
 * when it is missing (every method, cash included: owner 2026-10-14).
 */
export function assertPaymentReference(method: string | null | undefined, reference: string | null | undefined): string {
  const ref = (reference ?? '').trim()
  if (!ref) {
    const label = RECEIPT_METHOD_LABEL[(method ?? '').trim()] ?? 'this payment'
    throw new AppError(
      'PAYMENT_REFERENCE_REQUIRED',
      `Enter the payment reference # for ${label.toLowerCase()} — the receipt, slip, transfer or cheque number`,
      422,
    )
  }
  if (ref.length > 100) throw new AppError('PAYMENT_REFERENCE_TOO_LONG', 'The payment reference # is at most 100 characters', 422)
  return ref
}

/** "bank deposit, ref 4471" — for journal descriptions and money-line memos. */
export function receiptText(method: string | null | undefined, reference: string | null | undefined): string {
  const label = (RECEIPT_METHOD_LABEL[(method ?? '').trim()] ?? (method ?? '').trim()) || 'payment'
  const ref = (reference ?? '').trim()
  return ref ? `${label.toLowerCase()}, ref ${ref}` : label.toLowerCase()
}

/**
 * Ledger balance (debits − credits, in paisa) of each code in `tenantId`'s
 * chart. This — not BankAccount.openingBalanceCents — is a bank's balance.
 *
 * `asOf` counts only entries dated on or before it (`journalEntry.entryDate
 * <= asOf`) — the fixed-asset register ties out to the ledger at a month end.
 * `db` reads through a transaction when the caller holds one.
 */
export async function ledgerBalancesByCode(
  tenantId: string,
  codes: string[],
  opts: { asOf?: Date; db?: Prisma.TransactionClient | typeof prisma } = {},
): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (codes.length === 0) return out
  const db = opts.db ?? prisma
  const accounts = await db.account.findMany({
    where: { tenantId, code: { in: Array.from(new Set(codes)) } },
    select: { id: true, code: true },
  })
  if (accounts.length === 0) return out
  const sums = await db.journalLine.groupBy({
    by: ['accountId', 'type'],
    where: {
      accountId: { in: accounts.map((a) => a.id) },
      ...(opts.asOf && { journalEntry: { entryDate: { lte: opts.asOf } } }),
    },
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
