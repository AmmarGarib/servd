// OpEx payment → the ledger (owner decision 23). The OpEx tracker keeps the
// budget, the cadence and the due dates; the LEDGER holds the actuals. When a
// payment is marked paid it posts (finance wave B — H8 input tax by authority,
// H8/H28 withholding, H25 prepaid):
//
//   Dr 6xxx  the category's expense account   expense = invoice − input tax
//            (tagged with the line's brand) — or Dr 1310 Prepaid Expenses for
//            a 'prepaid' payment (H25: rent paid ahead, released monthly to
//            the category's account by accounting/prepaidReleases.ts, source
//            'opex_payment')
//   Dr 132x  the CHARGING authority's input account (inputTaxCodeFor —
//            fbr 1320, pra 1321, srb 1322, kpra 1323, bra 1324)   input tax
//   Cr where the money came from — lib/bankAccounts.ts moneyAccountCode, the
//      one resolver: 1010 cash on hand for a cash payment; else the named bank
//      account's chart code (a live, linked bank of the CATEGORY's company),
//      or the company's only bank, or 1020 when it has none — and 422
//      BANK_ACCOUNT_REQUIRED when it has two or more and none is named.
//                                                       cash = actualCents
//   Cr 2040  income tax withheld from the vendor (s.153 / s.155)   whtCents
//
// The payment stores the CASH (actualCents), the withholding (whtCents, with
// its section / rate / filer-status snapshot — fixed by opex/routes.ts through
// lib/withholding.ts computeWithholding) and the input tax with its
// authority. invoice = cash + WHT; expense = invoice − input tax. Lines of 0
// are left out, so a payment with no tax and no withholding is the old
// two-line entry.
//
// sourceType 'opex.payment', keyed on the payment id, kept in step through
// syncSourcePosting: a change to the amount, the tax, the withholding, the
// treatment, the paid date or either account reverses the live entry and
// reposts; un-marking it paid reverses it; a save that changes none of those
// (a note, a reference, a receipt) does nothing. It runs inside the payment's
// own transaction, so a closed month (PERIOD_LOCKED) or any other refusal
// saves nothing. A prepaid payment whose release has started (PrepaidRelease
// rows) cannot change its 1310 amount or stop being prepaid: 409
// PREPAID_RELEASING.
//
// Which expense account, in order:
//   1. the code named on THIS payment (an explicit correction);
//   2. what this payment already posted to (its live EXPENSE line — picked by
//      account, never by line order: not 132x input tax, not 1310) — so
//      changing a category's account only moves NEW payments, never re-books
//      old ones on an unrelated edit;
//   3. the category's own account (OpexCategory.expenseAccountCode);
//   4. the name map's suggestion (accounting/expenseCategories.ts).
// None of them → 422 CATEGORY_NOT_MAPPED until the account is named. A code
// named on a payment of a category with no account is saved to the category in
// the same transaction, so the next period posts without asking. A prepaid
// payment needs it too: its monthly release books to it.
//
// Where the money came from, in order: what THIS payment names (payFrom /
// bankAccountId — an explicit correction); else what it already posted to
// (its live MONEY credit — not 2040; the same rule as CapEx's live credit — an
// amount fix never moves a payment to another bank); else the line's bank
// account and method.
//
// What never posts here:
//   • The payroll category / payroll-sourced lines — HR payroll books wages
//     (hr/ledger.ts); posting them here would count wages twice.
//   • A category with no company — refused (the ledger is per company).
//   • A refundable deposit — never OpEx: CapEx with treatment 'deposit' (1360).

import type { Prisma, PrismaClient } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { AppError } from '../../lib/errors.js'
import { moneyAccountCode } from '../../lib/bankAccounts.js'
import { syncSourcePosting, liveRevision, type SyncOutcome } from '../accounting/sourcePosting.js'
import type { JournalLineInput } from '../accounting/journal.js'
import { expenseCodeForCategoryName, isPayrollCategory, assertExpenseCode } from '../accounting/expenseCategories.js'
import { ACCT } from '../accounting/journal.js'
import { INPUT_TAX_ACCOUNTS, inputTaxCodeFor, isAuthorityKey } from '../accounting/taxAuthorities.js'
import { assertTemplateAccounts } from '../../lib/chartOfAccounts.js'
import { assertMoneyFits, toCents } from '../../lib/money.js'

type Tx = Prisma.TransactionClient | PrismaClient

export const OPEX_SOURCE = 'opex.payment'

export type OpexLedgerStatus = 'posted' | 'unposted' | 'payroll' | 'not_paid'

/** What syncOpexPaymentPosting did. */
export interface SyncResult { status: OpexLedgerStatus; outcome: SyncOutcome | null; entryId: string | null }

/** PrepaidRelease.sourceType of an OpEx prepaid payment (accounting/prepaidReleases.ts). */
export const OPEX_PREPAID_SOURCE = 'opex_payment'

/** How a paid OpEx payment splits (all paisa): cash + WHT = invoice; invoice − input tax = expense. */
export interface OpexAmounts { cashCents: number; whtCents: number; inputTaxCents: number; invoiceCents: number; expenseCents: number }

/** The split of a stored payment. `expenseCents` is what budgets and variance compare (never the cash). */
export function opexAmountsOf(p: { actualCents: number | bigint | null; whtCents: number | bigint; inputTaxCents: number | bigint }): OpexAmounts {
  const cashCents = p.actualCents == null ? 0 : toCents(p.actualCents)
  const whtCents = toCents(p.whtCents)
  const inputTaxCents = toCents(p.inputTaxCents)
  const invoiceCents = cashCents + whtCents
  return { cashCents, whtCents, inputTaxCents, invoiceCents, expenseCents: invoiceCents - inputTaxCents }
}

/** Live (un-reversed) prepaid releases of an OpEx payment — once one exists, its 1310 amount is fixed. */
export async function liveOpexReleases(db: Tx, tenantId: string, paymentId: string): Promise<number> {
  return (db as typeof prisma).prepaidRelease.count({
    where: { tenantId, sourceType: OPEX_PREPAID_SOURCE, sourceId: paymentId, reversedAt: null },
  })
}

/** Where one payment's money came from, when the operator says so on the payment. */
export interface OpexPayFrom {
  payFrom?: 'bank' | 'cash'
  bankAccountId?: string | null
}

/**
 * The moneyAccountCode input for an OpEx payment. A company card or an auto
 * debit draws on a bank account, so every method but cash is bank money (the
 * resolver's 'card' means card-sale money in 1030 — a receivable, never what
 * pays an expense). A line's bank account wins over its method, as before.
 */
export function opexMoneyInput(
  line: { paymentMethod: string | null; bankAccountId: string | null },
  override?: OpexPayFrom,
): { method: 'cash' | 'bank_transfer'; bankAccountId: string | null } {
  const payFrom = override?.payFrom ?? (override?.bankAccountId ? 'bank' : undefined)
  if (payFrom === 'cash') return { method: 'cash', bankAccountId: override?.bankAccountId ?? null }
  if (payFrom === 'bank') {
    return { method: 'bank_transfer', bankAccountId: override?.bankAccountId ?? line.bankAccountId ?? null }
  }
  if (line.bankAccountId) return { method: 'bank_transfer', bankAccountId: line.bankAccountId }
  return { method: line.paymentMethod === 'cash' ? 'cash' : 'bank_transfer', bankAccountId: null }
}

export async function syncOpexPaymentPosting(
  paymentId: string,
  opts: { tx?: Tx; postedBy?: string; expenseAccountCode?: string | null } & OpexPayFrom = {},
): Promise<SyncResult> {
  const db = (opts.tx ?? prisma) as typeof prisma
  const p = await db.opexPayment.findUnique({
    where: { id: paymentId },
    include: { line: { include: { category: true } } },
  })
  if (!p) throw new AppError('NOT_FOUND', 'OpEx payment not found', 404)
  const { line } = p
  const category = line.category

  if (isPayrollCategory(category.name) || line.source === 'payroll') {
    return { status: 'payroll', outcome: null, entryId: null }
  }
  const tenantId = category.tenantId
  const paid = !!p.paidAt && (p.actualCents ?? 0) > 0
  if (!tenantId) {
    if (!paid) return { status: 'not_paid', outcome: null, entryId: null }
    throw new AppError('CATEGORY_HAS_NO_COMPANY', 'This OpEx category is not bound to a company, so its payment cannot reach the books — recreate it under the company', 422)
  }

  const { live } = await liveRevision(tenantId, OPEX_SOURCE, p.id, db)
  const prepaid = p.treatment === 'prepaid'
  // A prepaid payment whose monthly release has started: its 1310 amount is
  // what the releases draw down — never moved or taken away under them.
  const live1310 = live?.lines.filter((l) => l.type === 'debit' && l.accountCode === ACCT.PREPAID).reduce((t, l) => t + l.amountCents, 0) ?? 0
  const guardReleases = async (want1310: number) => {
    if (live1310 === want1310 || live1310 === 0) return
    if (await liveOpexReleases(db, tenantId, p.id) > 0) {
      throw new AppError(
        'PREPAID_RELEASING',
        'This prepaid payment is already being released to expense month by month — its amount, treatment and paid state can no longer change. Reverse the releases first (Finance → Prepaid releases).',
        409,
      )
    }
  }

  if (!paid) {
    await guardReleases(0)
    const r = await syncSourcePosting({ tenantId, sourceType: OPEX_SOURCE, id: p.id, desired: null, postedBy: opts.postedBy, reason: 'OpEx payment no longer marked paid', tx: opts.tx })
    return { status: 'not_paid', outcome: r.outcome, entryId: null }
  }

  // ─── Amounts ──────────────────────────────────────────────────────────────
  const a = opexAmountsOf(p)
  if (a.whtCents < 0 || a.inputTaxCents < 0) {
    throw new AppError('BAD_AMOUNT', 'Withholding and input tax cannot be negative', 422)
  }
  assertMoneyFits(a.invoiceCents, 'The invoice (cash paid + withholding)')
  if (a.expenseCents <= 0) {
    throw new AppError('INPUT_TAX_TOO_LARGE', 'The input sales tax must be less than the invoice amount', 422)
  }
  let inputCode: string | null = null
  if (a.inputTaxCents > 0) {
    if (!isAuthorityKey(p.inputTaxAuthority)) {
      throw new AppError('INPUT_TAX_AUTHORITY_REQUIRED', 'Say who charged the sales tax on this invoice (FBR, SRB, PRA, KPRA or BRA) — input tax is set off only against that authority', 422)
    }
    inputCode = inputTaxCodeFor(p.inputTaxAuthority)
  }
  if (prepaid && (!p.coversFrom || !p.coversMonths || p.coversMonths < 1)) {
    throw new AppError('PREPAID_TERM_REQUIRED', 'A prepaid payment needs the months it covers: the first month (YYYY-MM) and how many months', 422)
  }

  // ─── Accounts ─────────────────────────────────────────────────────────────
  // The live revision's EXPENSE debit and MONEY credit, picked by account —
  // never by line order (four lines since wave B).
  const inputCodes = new Set<string>(INPUT_TAX_ACCOUNTS)
  const liveDebit = live?.lines.find((l) => l.type === 'debit' && !inputCodes.has(l.accountCode) && l.accountCode !== ACCT.PREPAID)?.accountCode
  const liveCredit = live?.lines.find((l) => l.type === 'credit' && l.accountCode !== ACCT.WHT_PAYABLE)?.accountCode

  const named = opts.expenseAccountCode || null
  const expenseCode = named ?? liveDebit ?? category.expenseAccountCode ?? expenseCodeForCategoryName(category.name)
  if (!expenseCode) {
    throw new AppError(
      'CATEGORY_NOT_MAPPED',
      `Say which expense account "${category.name}" is booked to — pick the 6xxx account (it is remembered for the category)`,
      422,
    )
  }
  await assertExpenseCode(tenantId, expenseCode)
  // A prepaid payment is released to its CATEGORY's account
  // (accounting/prepaidReleases.ts) — a different code named on it would be
  // lost behind the 1310 debit.
  if (prepaid && named && category.expenseAccountCode && named !== category.expenseAccountCode) {
    throw new AppError(
      'PREPAID_USES_CATEGORY_ACCOUNT',
      `A prepaid payment is released month by month to its category's account (${category.expenseAccountCode}) — change the category's account instead of naming one on the payment`,
      422,
    )
  }
  // Named on a payment of a category that has no account yet: remember it.
  if (named && !category.expenseAccountCode) {
    await db.opexCategory.updateMany({ where: { id: category.id, expenseAccountCode: null }, data: { expenseAccountCode: named } })
  }

  const explicitMoney = opts.payFrom !== undefined || !!opts.bankAccountId
  const creditCode = !explicitMoney && liveCredit
    ? liveCredit
    : (await moneyAccountCode(db, tenantId, opexMoneyInput(line, explicitMoney ? opts : undefined))).code

  const debitCode = prepaid ? ACCT.PREPAID : expenseCode
  // A clear 422 (deactivated / taken code) instead of resolveAccountIds' 500.
  await assertTemplateAccounts(db, tenantId, [
    ...(prepaid ? [ACCT.PREPAID] : []),
    ...(inputCode ? [inputCode] : []),
    ...(a.whtCents > 0 ? [ACCT.WHT_PAYABLE] : []),
  ])
  await guardReleases(prepaid ? a.expenseCents : 0)

  const conceptId = line.conceptId ?? category.conceptId ?? null
  const memo = `${line.name}${line.vendor ? ` — ${line.vendor}` : ''} (${p.periodStart.toISOString().slice(0, 10)}–${p.periodEnd.toISOString().slice(0, 10)})${p.paymentRef ? ` ref ${p.paymentRef}` : ''}`.slice(0, 250)
  const lines: JournalLineInput[] = [
    { accountCode: debitCode, type: 'debit', amountCents: a.expenseCents, memo: prepaid ? `Prepaid ${p.coversFrom} for ${p.coversMonths} month(s): ${memo}`.slice(0, 250) : memo, conceptId },
    ...(inputCode ? [{ accountCode: inputCode, type: 'debit' as const, amountCents: a.inputTaxCents, memo: `Input sales tax: ${memo}`.slice(0, 250) }] : []),
    { accountCode: creditCode, type: 'credit', amountCents: a.cashCents, memo },
    ...(a.whtCents > 0 ? [{ accountCode: ACCT.WHT_PAYABLE, type: 'credit' as const, amountCents: a.whtCents, memo: `Income tax withheld${p.whtSection ? ` (${p.whtSection})` : ''}: ${memo}`.slice(0, 250) }] : []),
  ]
  const dr = lines.filter((l) => l.type === 'debit').reduce((t, l) => t + l.amountCents, 0)
  const cr = lines.filter((l) => l.type === 'credit').reduce((t, l) => t + l.amountCents, 0)
  if (dr !== cr) {
    // Cannot happen (expense + input = cash + WHT by construction) — say which payment if it ever does.
    throw new AppError('OPEX_POSTING_UNBALANCED', `OpEx payment ${p.id} would post debits ${dr} ≠ credits ${cr}`, 500)
  }
  const r = await syncSourcePosting({
    tenantId,
    sourceType: OPEX_SOURCE,
    id: p.id,
    desired: {
      description: `OpEx paid${prepaid ? ' (prepaid)' : ''}: ${category.name} — ${line.name}`,
      entryDate: p.paidAt!,
      lines,
    },
    postedBy: opts.postedBy,
    reason: 'OpEx payment changed',
    tx: opts.tx,
  })
  return { status: 'posted', outcome: r.outcome, entryId: r.entryId }
}
