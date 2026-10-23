// Automatic voucher numbers on the ledger (owner, 2026-10-20: "Every manual
// journal entry, and every voucher should generate a unique number in
// ascending order automatically, no manual voucher number will be entered").
//
// Stamped by the ONE posting engine (journal.ts postJournalEntry) in the same
// transaction as the entry, per company, ascending, never reused:
//   • A manual entry takes the type finance picks on the form (owner, 2026-10-23: "Payment voucher (PV),
//     journal voucher (JV), Receiving voucher (RV) and adjustment voucher (AV)"): PV only when the entry
//     pays money out, RV only when it brings money in (422 VOUCHER_TYPE_MISMATCH); JV / AV on anything.
//     None picked = JV, as before.
//   • AV-00001 — an adjustment voucher (manual entries only).
//   • JV-00001 — a manual journal entry, and every reversal / void / cancel
//                (a correcting entry is a journal voucher, never a receipt).
//   • PV-00001 — a payment: money net OUT of cash on hand, petty cash or a
//                bank of the company (the payments register's money accounts).
//   • RV-00001 — a receipt: money net IN to those accounts.
//   • none     — sales and till postings (order*, pos.*, shift.close — the
//                till has its own bill numbers), transfers between money
//                accounts and every other non-cash entry (accruals, stock,
//                depreciation…).
// The typed "reference #" on payment screens stays the cheque / bank
// reference for matching the statement — it is never the voucher number.
// Cash vouchers keep their own CV- numbers; the payment entry a cash voucher
// books gets its PV- number like any other payment.
// Old entries were numbered once by migration 20261020140000 (date order).

import type { Prisma, PrismaClient } from '@prisma/client'

type Db = Prisma.TransactionClient | PrismaClient
import { NOT_BANK_CODES } from '../../lib/bankAccounts.js'
import { AppError } from '../../lib/errors.js'

export type VoucherKind = 'JV' | 'PV' | 'RV' | 'AV'
/** The types a person may pick for a manual entry. */
export const MANUAL_VOUCHER_KINDS = ['PV', 'JV', 'RV', 'AV'] as const
export type ManualVoucherKind = (typeof MANUAL_VOUCHER_KINDS)[number]

/** Cash on hand, petty cash, the default bank — the same fixed set as paymentsRegister.ts FIXED_MONEY_CODES. */
const FIXED_MONEY_CODES = ['1010', '1011', '1020']
const BANK_CODE_EXCLUDED = NOT_BANK_CODES.filter((c) => !FIXED_MONEY_CODES.includes(c))
const SALES_PREFIXES = ['order', 'pos.', 'shift.close']

export function voucherNoOf(kind: VoucherKind, seq: number): string {
  return `${kind}-${String(seq).padStart(5, '0')}`
}

/** The kind of voucher an entry is, from its source and its lines (codes). null = no voucher number. */
export async function voucherKindOf(
  tx: Db,
  tenantId: string,
  sourceType: string,
  lines: Array<{ accountCode: string; type: 'debit' | 'credit'; amountCents: number }>,
  /** A manual entry's picked type (checked by the caller with assertManualVoucherKind). */
  chosen?: ManualVoucherKind | null,
): Promise<VoucherKind | null> {
  if (SALES_PREFIXES.some((p) => sourceType.startsWith(p))) return null
  if (sourceType === 'manual' && chosen) return chosen
  if (sourceType === 'manual' || sourceType.startsWith('manual.') || /\.(reversal|void)$/.test(sourceType)) return 'JV'
  const net = await moneyNetOutCents(tx, tenantId, lines)
  return net > 0 ? 'PV' : net < 0 ? 'RV' : null
}

/** Money net OUT of the company's cash on hand, petty cash and banks (> 0 pays out, < 0 brings in, 0 neither). */
export async function moneyNetOutCents(
  tx: Db,
  tenantId: string,
  lines: Array<{ accountCode: string; type: 'debit' | 'credit'; amountCents: number }>,
): Promise<number> {
  const codes = [...new Set(lines.map((l) => l.accountCode))]
  const banks = await tx.bankAccount.findMany({
    where: { tenantId, accountCode: { in: codes.filter((c) => !BANK_CODE_EXCLUDED.includes(c)) } },
    select: { accountCode: true },
  })
  const money = new Set([...FIXED_MONEY_CODES, ...banks.map((b) => b.accountCode!).filter(Boolean)])
  let net = 0
  for (const l of lines) if (money.has(l.accountCode)) net += l.type === 'credit' ? l.amountCents : -l.amountCents
  return net
}

/** The type that fits a manual entry's lines, for the form's default: PV pays out, RV brings in, else JV. */
export async function suggestedManualVoucherKind(
  tx: Db, tenantId: string, lines: Array<{ accountCode: string; type: 'debit' | 'credit'; amountCents: number }>,
): Promise<ManualVoucherKind> {
  const net = await moneyNetOutCents(tx, tenantId, lines)
  return net > 0 ? 'PV' : net < 0 ? 'RV' : 'JV'
}

/** 422 VOUCHER_TYPE_MISMATCH when a PV does not pay money out or an RV does not bring money in. */
export async function assertManualVoucherKind(
  tx: Db, tenantId: string, kind: ManualVoucherKind,
  lines: Array<{ accountCode: string; type: 'debit' | 'credit'; amountCents: number }>,
): Promise<void> {
  if (kind !== 'PV' && kind !== 'RV') return
  const net = await moneyNetOutCents(tx, tenantId, lines)
  if (kind === 'PV' && net <= 0) {
    throw new AppError('VOUCHER_TYPE_MISMATCH', 'A payment voucher (PV) must pay money out — credit cash on hand, petty cash or a bank. Pick JV or AV for this entry' + (net < 0 ? ', or RV (it brings money in).' : '.'), 422)
  }
  if (kind === 'RV' && net >= 0) {
    throw new AppError('VOUCHER_TYPE_MISMATCH', 'A receiving voucher (RV) must bring money in — debit cash on hand, petty cash or a bank. Pick JV or AV for this entry' + (net > 0 ? ', or PV (it pays money out).' : '.'), 422)
  }
}

/**
 * Give the entry the company's next number of its kind. One numbering writer per company at a time (advisory lock,
 * released with the transaction), so numbers are gap-free and ascending in the order entries are committed.
 */
export async function stampVoucherNoTx(tx: Db, tenantId: string, entryId: string, kind: VoucherKind): Promise<string> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tenantId}::text), hashtext('journal-voucher-seq'))`
  const last = await tx.journalEntry.aggregate({ where: { tenantId, voucherKind: kind }, _max: { voucherSeq: true } })
  const seq = (last._max.voucherSeq ?? 0) + 1
  const voucherNo = voucherNoOf(kind, seq)
  await tx.journalEntry.update({ where: { id: entryId }, data: { voucherKind: kind, voucherSeq: seq, voucherNo } })
  return voucherNo
}
