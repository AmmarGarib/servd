// Internal payment classification & management reporting (owner, 2026-10-20).
//
// "A mandatory classification on all payment types … Official, Unofficial,
// Unclassified. A SEPARATE REPORTING DIMENSION inside the existing accounting
// system — no duplicate accounting entries, no separate statutory books."
//
// HARD RULE: the classification is a LABEL on a journal entry plus reports.
// It never changes a posting, an account, the trial balance, a tax return or
// any statutory / payroll / WHT report — nothing in the ledger reads the
// `payment_classifications` table. Unofficial payments stay in every
// statutory report exactly as before.
//
// This file is the ONE definition of:
//   • what a payment is (isPaymentEntry / moneyAggregatesSql + moneyFlowWhereSql): a live journal
//     entry (not reversed, not a reversal) of a company whose lines net-CREDIT
//     the company's money accounts — cash 1010, petty cash 1011, 1020 and
//     every bank account code of that company (bank_accounts.accountCode,
//     never one of NOT_BANK_CODES). Moves between money accounts net to zero
//     and drop out (deposit drops, petty-cash top-ups, bank-to-bank); sales
//     and till sources (order*, pos.*, shift.close) are out of scope;
//   • what a RECEIPT is (owner, 2026-10-23, the Journals tab): the mirror —
//     a live entry whose lines net-DEBIT the same money accounts; transfers
//     between money accounts net out; sales / till sources are out unless the
//     caller asks for them (includeSales) (isReceiptAgg / moneyFlowWhereSql 'in');
//   • its category, payee, voucher number, method, gross / WHT / net and tax
//     status (paymentRegister);
//   • the one writer of a classification (classifyPaymentTx — at creation, in
//     the posting's own transaction; setPaymentClassification — afterwards);
//   • the tie-out of the register to the ledger (ledgerPaymentsTieOut — an
//     independent aggregate over journal lines).

import { z } from 'zod'
import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { NOT_BANK_CODES } from '../../lib/bankAccounts.js'
import { toCents } from '../../lib/money.js'

type Db = Prisma.TransactionClient | typeof prisma

// ─── The dimension ───────────────────────────────────────────────────────────

export const PAYMENT_CLASSIFICATIONS = ['official', 'unofficial', 'unclassified'] as const
export type PaymentClassificationValue = typeof PAYMENT_CLASSIFICATIONS[number]
export const TAX_STATUSES = ['deducted', 'not_deducted', 'not_applicable'] as const
export type TaxStatus = typeof TAX_STATUSES[number]

/** Optional body fields every person-made payment route accepts (omitted → no row = Unclassified). */
export const paymentClassificationBodyFields = {
  classification: z.enum(PAYMENT_CLASSIFICATIONS).optional(),
  taxStatus: z.enum(TAX_STATUSES).nullish(),
  nonDeductionReason: z.string().trim().max(500).nullish(),
}

export interface ClassificationInput {
  classification: PaymentClassificationValue
  taxStatus?: TaxStatus | null
  nonDeductionReason?: string | null
}

/** The classification a route body carries, or null when it carries none. */
export function classificationOf(body: unknown): ClassificationInput | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  const parsed = z.object(paymentClassificationBodyFields).safeParse({
    classification: b['classification'] ?? undefined,
    taxStatus: b['taxStatus'] ?? undefined,
    nonDeductionReason: b['nonDeductionReason'] ?? undefined,
  })
  if (!parsed.success) {
    throw new AppError('INVALID_CLASSIFICATION', 'Classification must be official, unofficial or unclassified; tax status deducted, not_deducted or not_applicable', 400)
  }
  if (!parsed.data.classification) return null
  const out: ClassificationInput = {
    classification: parsed.data.classification,
    taxStatus: parsed.data.taxStatus ?? null,
    nonDeductionReason: parsed.data.nonDeductionReason ?? null,
  }
  assertTaxStatusFields(out)
  return out
}

/** 422 when a tax was not deducted without a reason (≥10 characters) — the DB CHECK says the same. */
export function assertTaxStatusFields(c: ClassificationInput): void {
  if (c.taxStatus === 'not_deducted' && (c.nonDeductionReason ?? '').trim().length < 10) {
    throw new AppError('NON_DEDUCTION_REASON_REQUIRED', 'Say why tax was not deducted (at least 10 characters)', 422)
  }
}

// ─── What a payment is ───────────────────────────────────────────────────────

/** Fixed money accounts in every company's chart; a company's banks add their own codes. */
export const FIXED_MONEY_CODES = ['1010', '1011', '1020'] as const
/** Withholding payable accounts — supplier WHT 2040, sales-tax WHT 2041, salary tax 2042. */
export const WHT_PAYABLE_CODES = ['2040', '2041', '2042'] as const
/** Sales and till sources are out of scope (customer refunds at the till are not payments here). */
const SALES_PREFIX_SQL = ['order%', 'pos.%', 'shift.close%']

const BANK_CODE_EXCLUDED = NOT_BANK_CODES.filter((c) => !FIXED_MONEY_CODES.includes(c as never))

/**
 * The ONE SQL of "money moved by an entry": per entry of the companies, the
 * credits (cr) and debits (dr) on its money-account lines, whether it is a
 * sales / till source (sales) and whether it is reversed or itself a reversal
 * (dead). Only entries that touch a money account are returned. `window` null =
 * all history (the Journals tab, accounting/journalsRegister.ts); an `entryId`
 * narrows to one entry. Payments (net credit) and receipts (net debit) are both
 * read from it, so the register, the tie-out and the Journals tab agree.
 */
export function moneyAggregatesSql(tenantIds: string[], window: { from: Date; to: Date } | null, entryId: string | null = null): Prisma.Sql {
  return Prisma.sql`
    SELECT e.id, e."tenantId", e.reference, e.description, e."entryDate",
           COALESCE(SUM(CASE WHEN l.type = 'credit' THEN l."amountCents" ELSE 0 END), 0)::bigint AS cr,
           COALESCE(SUM(CASE WHEN l.type = 'debit'  THEN l."amountCents" ELSE 0 END), 0)::bigint AS dr,
           (COALESCE(e.reference, '') LIKE ANY(${SALES_PREFIX_SQL}::text[])) AS sales,
           (
             (COALESCE(e.reference, '') ~ '^[^:]+\\.(reversal|void):' AND e.description LIKE 'Reversal of %')
             OR EXISTS (
               SELECT 1 FROM journal_entries r
                WHERE r."tenantId" = e."tenantId"
                  AND r.description LIKE 'Reversal of %'
                  AND strpos(COALESCE(e.reference, ''), ':') > 0
                  AND r.reference IN (
                        split_part(e.reference, ':', 1) || '.reversal:' || substr(e.reference, strpos(e.reference, ':') + 1),
                        split_part(e.reference, ':', 1) || '.void:' || substr(e.reference, strpos(e.reference, ':') + 1)))
           ) AS dead
      FROM journal_entries e
      JOIN journal_lines l ON l."journalEntryId" = e.id
      JOIN accounts a ON a.id = l."accountId"
     WHERE e."tenantId" = ANY(${tenantIds}::text[])
       AND (${entryId}::text IS NULL OR e.id = ${entryId}::text)
       ${window && !entryId ? Prisma.sql`AND e."entryDate" >= ${window.from} AND e."entryDate" <= ${window.to}` : Prisma.empty}
       AND (
             a.code = ANY(${[...FIXED_MONEY_CODES]}::text[])
          OR (NOT (a.code = ANY(${BANK_CODE_EXCLUDED}::text[]))
              AND EXISTS (SELECT 1 FROM bank_accounts b WHERE b."tenantId" = e."tenantId" AND b."accountCode" = a.code))
       )
     GROUP BY e.id`
}

/** The money accounts of each company: 1010, 1011, 1020 + its bank accounts' codes (the same rule as the SQL above). */
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

/**
 * The money-flow condition on a row of moneyAggregatesSql (alias `m`), in SQL —
 * the twin of isPaymentAgg / isReceiptAgg below:
 *   out (a PAYMENT): live, not sales, net credit to money accounts;
 *   in  (a RECEIPT): live, not sales (unless includeSales), net debit to money accounts.
 * Moves between money accounts net to zero and are neither.
 */
export function moneyFlowWhereSql(direction: 'out' | 'in', opts: { includeSales?: boolean } = {}): Prisma.Sql {
  const net = direction === 'out' ? Prisma.sql`m.cr - m.dr > 0` : Prisma.sql`m.dr - m.cr > 0`
  const sales = direction === 'in' && opts.includeSales ? Prisma.empty : Prisma.sql`AND NOT m.sales`
  return Prisma.sql`(NOT m.dead ${sales} AND ${net})`
}

/**
 * Per-entry money credits / debits of every live, non-sales entry of the
 * companies in the period that touches a money account. One SQL so the
 * register and the tie-out agree on the same rule.
 */
async function moneyEntryAggregates(
  db: Db,
  tenantIds: string[],
  from: Date,
  to: Date,
  opts: { entryId?: string } = {},
): Promise<Array<{ id: string; tenantId: string; reference: string | null; description: string; entryDate: Date; cr: number; dr: number; sales: boolean; dead: boolean }>> {
  if (tenantIds.length === 0) return []
  const rows = await db.$queryRaw<Array<{ id: string; tenantId: string; reference: string | null; description: string; entryDate: Date; cr: bigint | number; dr: bigint | number; sales: boolean; dead: boolean }>>(
    moneyAggregatesSql(tenantIds, { from, to }, opts.entryId ?? null))
  return rows.map((r) => ({ ...r, cr: toCents(r.cr), dr: toCents(r.dr) }))
}

const isPaymentAgg = (a: { cr: number; dr: number; sales: boolean; dead: boolean }) => !a.sales && !a.dead && a.cr - a.dr > 0
/** A RECEIPT (owner, 2026-10-23 — the Journals tab's Receipt view): the mirror of a payment — net money IN. */
export const isReceiptAgg = (a: { cr: number; dr: number; sales: boolean; dead: boolean }, opts: { includeSales?: boolean } = {}) =>
  (opts.includeSales || !a.sales) && !a.dead && a.dr - a.cr > 0

/** True when the entry (of that company) is a receipt under the one rule above (sales / till sources excluded). */
export async function isReceiptEntry(db: Db, tenantId: string, journalEntryId: string): Promise<boolean> {
  const [agg] = await moneyEntryAggregates(db, [tenantId], new Date(0), new Date(0), { entryId: journalEntryId })
  return !!agg && isReceiptAgg(agg)
}

/** True when the entry (of that company) is a payment under the one rule above. */
export async function isPaymentEntry(db: Db, tenantId: string, journalEntryId: string): Promise<boolean> {
  const [agg] = await moneyEntryAggregates(db, [tenantId], new Date(0), new Date(0), { entryId: journalEntryId })
  return !!agg && isPaymentAgg(agg)
}

// ─── The one writer ──────────────────────────────────────────────────────────

/**
 * Classify a payment entry at creation, in the SAME transaction as its
 * posting. Stamped with the ENTRY's company (never the caller's). An entry
 * that is not a payment (nothing left a money account) is left alone and
 * false is returned — creation never fails on the label. A null input or
 * entry id is a no-op (Unclassified).
 */
export async function classifyPaymentTx(
  tx: Db,
  args: { journalEntryId: string | null | undefined; input: ClassificationInput | null; setById: string | null; tenantId?: string },
): Promise<boolean> {
  if (!args.input || !args.journalEntryId) return false
  assertTaxStatusFields(args.input)
  const entry = await tx.journalEntry.findUnique({ where: { id: args.journalEntryId }, select: { tenantId: true } })
  if (!entry?.tenantId) return false
  if (args.tenantId && args.tenantId !== entry.tenantId) {
    throw new AppError('CLASSIFICATION_COMPANY_MISMATCH', 'The payment entry belongs to another company', 500)
  }
  if (!(await isPaymentEntry(tx, entry.tenantId, args.journalEntryId))) return false
  const data = {
    classification: args.input.classification,
    taxStatus: args.input.taxStatus ?? null,
    nonDeductionReason: args.input.taxStatus === 'not_deducted' ? (args.input.nonDeductionReason ?? '').trim() : (args.input.nonDeductionReason?.trim() || null),
    setById: args.setById,
  }
  await tx.paymentClassification.upsert({
    where: { journalEntryId: args.journalEntryId },
    create: { tenantId: entry.tenantId, journalEntryId: args.journalEntryId, ...data },
    update: data,
  })
  return true
}

/**
 * Change a payment's classification afterwards (PUT
 * /accounting/payments/:id/classification). The caller resolved the entry
 * inside its write scope (foreign → 404). Changing an existing value needs a
 * reason (≥10). Conditional on the row being unchanged since it was read.
 */
export async function setPaymentClassification(args: {
  tenantIds: string[]; journalEntryId: string; input: ClassificationInput; reason: string | null; userId: string
}): Promise<{ tenantId: string; before: ClassificationSnapshot | null; after: ClassificationSnapshot }> {
  assertTaxStatusFields(args.input)
  return prisma.$transaction(async (tx) => {
    const [entry] = await assertPaymentsInScopeTx(tx, args.tenantIds, [args.journalEntryId])
    const r = await applyClassificationTx(tx, { entry: entry!, input: args.input, reason: args.reason, userId: args.userId, skipUnchanged: false })
    return { tenantId: entry!.tenantId, before: r.before, after: r.after }
  })
}

/**
 * Bulk allocation (owner, 2026-10-20: older payments start Unclassified;
 * finance / the CEO allocate them in bulk from the register). All or nothing
 * in ONE transaction: any id outside the caller's write scope → 404, any id
 * that is not a payment → 422 NOT_A_PAYMENT, before anything is written. A
 * reason (≥10) is always required. An entry already at the requested value is
 * left alone (reported as unchanged).
 */
export async function classifyPaymentsBulk(args: {
  tenantIds: string[]; journalEntryIds: string[]; input: ClassificationInput; reason: string; userId: string
}): Promise<Array<{ journalEntryId: string; tenantId: string; changed: boolean; before: ClassificationSnapshot | null; after: ClassificationSnapshot }>> {
  assertTaxStatusFields(args.input)
  if ((args.reason ?? '').trim().length < 10) {
    throw new AppError('REASON_REQUIRED', 'Give a reason for the classification (at least 10 characters)', 422)
  }
  const ids = [...new Set(args.journalEntryIds)]
  return prisma.$transaction(async (tx) => {
    const entries = await assertPaymentsInScopeTx(tx, args.tenantIds, ids)
    const out = []
    for (const entry of entries) {
      const r = await applyClassificationTx(tx, { entry, input: args.input, reason: args.reason, userId: args.userId, skipUnchanged: true })
      out.push({ journalEntryId: entry.id, tenantId: entry.tenantId, ...r })
    }
    return out
  }, { timeout: 60_000 })
}

/** Every id is an entry of a company in `tenantIds` (else 404) and a payment (else 422). */
async function assertPaymentsInScopeTx(tx: Db, tenantIds: string[], ids: string[]): Promise<Array<{ id: string; tenantId: string }>> {
  const found = await tx.journalEntry.findMany({
    where: { id: { in: ids }, tenantId: { in: tenantIds } },
    select: { id: true, tenantId: true },
  })
  const byId = new Map(found.map((e) => [e.id, e]))
  const missing = ids.find((id) => !byId.get(id)?.tenantId)
  if (missing) throw new NotFoundError('Payment', missing)
  const notPayments: string[] = []
  for (const id of ids) {
    const e = byId.get(id)!
    if (!(await isPaymentEntry(tx, e.tenantId!, id))) notPayments.push(id)
  }
  if (notPayments.length) {
    throw new AppError('NOT_A_PAYMENT', 'This entry is not a payment (no money left a cash, petty-cash or bank account)', 422, { journalEntryIds: notPayments })
  }
  return ids.map((id) => ({ id, tenantId: byId.get(id)!.tenantId! }))
}

async function applyClassificationTx(tx: Db, args: {
  entry: { id: string; tenantId: string }; input: ClassificationInput; reason: string | null; userId: string; skipUnchanged: boolean
}): Promise<{ changed: boolean; before: ClassificationSnapshot | null; after: ClassificationSnapshot }> {
  const { entry } = args
  const existing = await tx.paymentClassification.findUnique({ where: { journalEntryId: entry.id } })
  const after: ClassificationSnapshot = {
    classification: args.input.classification,
    taxStatus: args.input.taxStatus ?? null,
    nonDeductionReason: args.input.nonDeductionReason?.trim() || null,
  }
  const before: ClassificationSnapshot | null = existing
    ? { classification: existing.classification as PaymentClassificationValue, taxStatus: (existing.taxStatus as TaxStatus | null) ?? null, nonDeductionReason: existing.nonDeductionReason }
    : null
  const changes = !before || before.classification !== after.classification || before.taxStatus !== after.taxStatus || (before.nonDeductionReason ?? null) !== after.nonDeductionReason
  if (!changes) {
    if (args.skipUnchanged) return { changed: false, before, after }
    throw new AppError('CLASSIFICATION_UNCHANGED', 'Nothing changed', 409)
  }
  // Changing a value someone already set needs a reason. Setting the first
  // value (Unclassified → a value) does not.
  if (before && (args.reason ?? '').trim().length < 10) {
    throw new AppError('REASON_REQUIRED', 'Give a reason for changing the classification (at least 10 characters)', 422)
  }
  if (existing) {
    const r = await tx.paymentClassification.updateMany({
      where: { id: existing.id, updatedAt: existing.updatedAt },
      data: { ...after, setById: args.userId },
    })
    if (r.count === 0) throw new AppError('CLASSIFICATION_CHANGED', 'Someone else changed this classification — reload and try again', 409)
  } else {
    try {
      await tx.paymentClassification.create({ data: { tenantId: entry.tenantId, journalEntryId: entry.id, ...after, setById: args.userId } })
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') throw new AppError('CLASSIFICATION_CHANGED', 'Someone else classified this payment — reload and try again', 409)
      throw err
    }
  }
  return { changed: true, before, after }
}

export interface ClassificationSnapshot {
  classification: PaymentClassificationValue
  taxStatus: TaxStatus | null
  nonDeductionReason: string | null
}

// ─── Categories ──────────────────────────────────────────────────────────────

export const PAYMENT_CATEGORIES = {
  vendor: 'Vendor payment',
  salaries: 'Salaries & employee pay',
  advances: 'Advances',
  petty_cash: 'Petty cash',
  cash_voucher: 'Cash voucher',
  opex: 'Operating expenses',
  capital: 'Purchases (capital)',
  tax: 'Tax & statutory',
  refunds: 'Refunds',
  manual: 'Manual journal',
  other: 'Other',
} as const
export type PaymentCategory = keyof typeof PAYMENT_CATEGORIES

/** The category of an entry, from its source prefix ('<sourceType>:<sourceId>'). */
export function categoryOfReference(reference: string | null): PaymentCategory {
  const type = (reference ?? '').split(':')[0] ?? ''
  if (type === 'supplier.payment') return 'vendor'
  if (type === 'hr.payroll.payment' || type === 'hr.final_settlement.payment' || type === 'tippool.payout') return 'salaries'
  if (type === 'hr.loan.disbursement') return 'advances'
  if (type === 'pettycash.spend') return 'petty_cash'
  if (type.startsWith('cashvoucher.')) return 'cash_voucher'
  if (type.startsWith('opex.')) return 'opex'
  if (type.startsWith('capex.')) return 'capital'
  if (type.startsWith('salestax.') || type.startsWith('statutory.') || type.startsWith('tax.')) return 'tax'
  if (type.startsWith('receivable.') || type.startsWith('wallet.') || type.startsWith('giftcard.')) return 'refunds'
  if (type === 'manual') return 'manual'
  return 'other'
}

export type PaymentMethodKind = 'cash' | 'petty_cash' | 'bank' | 'cheque' | 'other'
export const PAYMENT_METHOD_LABELS: Record<PaymentMethodKind, string> = {
  cash: 'Cash', petty_cash: 'Petty cash', bank: 'Bank', cheque: 'Cheque', other: 'Other',
}

// ─── The register ────────────────────────────────────────────────────────────

export interface PaymentRow {
  journalEntryId: string
  tenantId: string
  entryDate: string
  reference: string | null
  /** The automatic voucher number (PV-00001…), stamped by the posting engine. null on an entry posted before numbering. */
  voucherNo: string | null
  /** The source document's own number or reference (cash voucher CV-…, cheque / bank reference, payroll period…). */
  voucherNumber: string
  payee: string
  category: PaymentCategory
  categoryLabel: string
  narration: string
  method: PaymentMethodKind
  methodLabel: string
  moneyAccountCode: string | null
  grossCents: number
  whtCents: number
  netCents: number
  classification: PaymentClassificationValue
  classified: boolean
  taxStatus: TaxStatus | null
  /** 'recorded' = set by a person; 'derived' = read from the books (WHT > 0 → deducted). */
  taxStatusSource: 'recorded' | 'derived' | 'none'
  nonDeductionReason: string | null
}

export interface RegisterFilters {
  classification?: PaymentClassificationValue | 'all'
  category?: PaymentCategory
  method?: PaymentMethodKind
  q?: string
}

/** Every payment of the companies in [from, to], enriched for the register. */
export async function paymentRows(db: Db, tenantIds: string[], from: Date, to: Date, opts: { entryId?: string } = {}): Promise<PaymentRow[]> {
  const aggs = (await moneyEntryAggregates(db, tenantIds, from, to, opts)).filter(isPaymentAgg)
  if (aggs.length === 0) return []
  const ids = aggs.map((a) => a.id)

  const [lines, classes, banks] = await Promise.all([
    db.journalLine.findMany({
      where: { journalEntryId: { in: ids } },
      select: { journalEntryId: true, type: true, amountCents: true, account: { select: { code: true } } },
    }),
    db.paymentClassification.findMany({ where: { journalEntryId: { in: ids } } }),
    db.bankAccount.findMany({
      where: { tenantId: { in: [...new Set(aggs.map((a) => a.tenantId))] }, accountCode: { not: null } },
      select: { tenantId: true, accountCode: true, name: true, deletedAt: true },
      orderBy: { createdAt: 'asc' },
    }),
  ])
  const bankName = new Map<string, string>()
  for (const b of banks) {
    const k = `${b.tenantId}|${b.accountCode}`
    if (!bankName.has(k) || !b.deletedAt) bankName.set(k, b.name)
  }
  const classOf = new Map<string, { classification: string; taxStatus: string | null; nonDeductionReason: string | null }>(classes.map((c) => [c.journalEntryId, c]))
  // A document edited after it posted is reversed and re-posted as '<ref>@n'
  // (sourcePosting.ts). A revision nobody classified yet carries the latest
  // classification of an earlier revision of the same document.
  const unrevised = (ref: string | null) => (ref ?? '').replace(/@\d+$/, '')
  const needInherit = aggs.filter((a) => !classOf.has(a.id) && a.reference && /@\d+$/.test(a.reference))
  if (needInherit.length) {
    const bases = [...new Set(needInherit.map((a) => unrevised(a.reference)))]
    const siblings = await db.journalEntry.findMany({
      where: {
        tenantId: { in: [...new Set(needInherit.map((a) => a.tenantId))] },
        OR: bases.flatMap((b) => [{ reference: b }, { reference: { startsWith: `${b}@` } }]),
        paymentClassification: { isNot: null },
      },
      select: { tenantId: true, reference: true, paymentClassification: true },
    })
    const latest = new Map<string, { classification: string; taxStatus: string | null; nonDeductionReason: string | null; updatedAt: Date }>()
    for (const sib of siblings) {
      const c = sib.paymentClassification!
      const k = `${sib.tenantId}|${unrevised(sib.reference)}`
      const cur = latest.get(k)
      if (!cur || cur.updatedAt < c.updatedAt) latest.set(k, c)
    }
    for (const a of needInherit) {
      const c = latest.get(`${a.tenantId}|${unrevised(a.reference)}`)
      if (c) classOf.set(a.id, c)
    }
  }
  const linesOf = new Map<string, typeof lines>()
  for (const l of lines) linesOf.set(l.journalEntryId, [...(linesOf.get(l.journalEntryId) ?? []), l])

  const details = await sourceDetails(db, aggs)
  // The automatic voucher number of each entry (PV-…; voucherNumbers.ts).
  const voucherNoOf = new Map((await db.journalEntry.findMany({ where: { id: { in: aggs.map((a) => a.id) } }, select: { id: true, voucherNo: true } }))
    .map((e) => [e.id, e.voucherNo]))

  const out: PaymentRow[] = []
  for (const a of aggs) {
    const ls = linesOf.get(a.id) ?? []
    const isMoney = (code: string) => FIXED_MONEY_CODES.includes(code as never) || bankName.has(`${a.tenantId}|${code}`)
    // The money account credited most is the method.
    const moneyCredits = new Map<string, number>()
    for (const l of ls) if (l.type === 'credit' && isMoney(l.account.code)) moneyCredits.set(l.account.code, (moneyCredits.get(l.account.code) ?? 0) + toCents(l.amountCents))
    const moneyCode = [...moneyCredits.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? null
    const d = details.get(a.id) ?? {}
    let method: PaymentMethodKind = moneyCode === '1010' ? 'cash' : moneyCode === '1011' ? 'petty_cash' : moneyCode ? 'bank' : 'other'
    if (d.cheque) method = 'cheque'
    const methodLabel = method === 'bank' || method === 'cheque'
      ? `${PAYMENT_METHOD_LABELS[method]}${moneyCode && bankName.get(`${a.tenantId}|${moneyCode}`) ? ` — ${bankName.get(`${a.tenantId}|${moneyCode}`)}` : ''}`
      : PAYMENT_METHOD_LABELS[method]

    const entryWht = ls.filter((l) => l.type === 'credit' && WHT_PAYABLE_CODES.includes(l.account.code as never)).reduce((s, l) => s + toCents(l.amountCents), 0)
    const whtCents = entryWht > 0 ? entryWht : (d.whtCents ?? 0)
    const netCents = a.cr - a.dr
    const c = classOf.get(a.id)
    const recordedStatus = (c?.taxStatus as TaxStatus | null | undefined) ?? null
    const category = categoryOfReference(a.reference)
    out.push({
      journalEntryId: a.id,
      tenantId: a.tenantId,
      entryDate: a.entryDate.toISOString(),
      reference: a.reference,
      voucherNo: voucherNoOf.get(a.id) ?? null,
      voucherNumber: d.voucherNumber ?? shortRef(a.reference, a.id),
      payee: d.payee ?? a.description,
      category,
      categoryLabel: d.categoryOverride ? PAYMENT_CATEGORIES[d.categoryOverride] : PAYMENT_CATEGORIES[category],
      narration: a.description,
      method,
      methodLabel,
      moneyAccountCode: moneyCode,
      grossCents: netCents + whtCents,
      whtCents,
      netCents,
      classification: (c?.classification as PaymentClassificationValue | undefined) ?? 'unclassified',
      classified: !!c,
      taxStatus: recordedStatus ?? (whtCents > 0 ? 'deducted' : null),
      taxStatusSource: recordedStatus ? 'recorded' : whtCents > 0 ? 'derived' : 'none',
      nonDeductionReason: c?.nonDeductionReason ?? null,
    })
    if (d.categoryOverride) out[out.length - 1]!.category = d.categoryOverride
  }
  out.sort((x, y) => (x.entryDate < y.entryDate ? 1 : x.entryDate > y.entryDate ? -1 : x.journalEntryId < y.journalEntryId ? 1 : -1))
  return out
}

function shortRef(reference: string | null, id: string): string {
  if (!reference) return `JE-${id.slice(-8).toUpperCase()}`
  const at = reference.indexOf(':')
  return at > 0 ? `${reference.slice(0, at)}:${reference.slice(at + 1).slice(-8).toUpperCase()}` : reference
}

interface SourceDetail {
  voucherNumber?: string
  payee?: string
  cheque?: boolean
  whtCents?: number
  categoryOverride?: PaymentCategory
}

/** Payee / voucher number / cheque / WHT-taken-earlier, per source type, in a few batched reads. */
async function sourceDetails(db: Db, aggs: Array<{ id: string; tenantId: string; reference: string | null }>): Promise<Map<string, SourceDetail>> {
  const out = new Map<string, SourceDetail>()
  const byType = new Map<string, Array<{ entryId: string; sourceId: string; tenantId: string }>>()
  for (const a of aggs) {
    const ref = a.reference ?? ''
    const at = ref.indexOf(':')
    if (at <= 0) continue
    const type = ref.slice(0, at)
    // A re-posted revision is '<id>@n' (sourcePosting.ts) — the document is '<id>'.
    byType.set(type, [...(byType.get(type) ?? []), { entryId: a.id, sourceId: ref.slice(at + 1).replace(/@\d+$/, ''), tenantId: a.tenantId }])
  }
  const set = (entryId: string, d: SourceDetail) => out.set(entryId, { ...(out.get(entryId) ?? {}), ...d })
  const of = (type: string) => byType.get(type) ?? []
  const ids = (type: string) => of(type).map((x) => x.sourceId)
  const tasks: Array<Promise<void>> = []

  // Vendor payments: supplier, payment reference, cheque, and the WHT of the
  // bills it settled (taken at the bill — H47), allocated by what was applied.
  if (of('supplier.payment').length) tasks.push((async () => {
    const pays = await db.supplierPayment.findMany({
      where: { id: { in: ids('supplier.payment') } },
      select: {
        id: true, method: true, reference: true, supplier: { select: { name: true } },
        applications: { select: { amountAppliedCents: true, bill: { select: { billNumber: true, totalCents: true, whtCents: true } } } },
      },
    })
    const m = new Map(pays.map((p) => [p.id, p]))
    for (const x of of('supplier.payment')) {
      const p = m.get(x.sourceId)
      if (!p) continue
      let wht = 0
      for (const app of p.applications) {
        const payable = toCents(app.bill.totalCents) - toCents(app.bill.whtCents)
        if (payable > 0 && toCents(app.bill.whtCents) > 0) wht += Math.round(toCents(app.bill.whtCents) * Math.min(1, toCents(app.amountAppliedCents) / payable))
      }
      const bills = p.applications.map((a) => a.bill.billNumber).filter(Boolean)
      set(x.entryId, {
        payee: p.supplier.name,
        voucherNumber: p.reference || (bills.length ? bills.join(', ') : undefined),
        cheque: p.method === 'cheque',
        whtCents: wht,
      })
    }
  })())

  // Cash vouchers paid from cash on hand / a bank.
  const voucherIds = [...ids('cashvoucher.pay')]
  const spendIds = ids('pettycash.spend')
  if (voucherIds.length || spendIds.length) tasks.push((async () => {
    const moves = spendIds.length
      ? await db.pettyCashMovement.findMany({ where: { id: { in: spendIds } }, select: { id: true, vendorName: true, reason: true, cashVoucherId: true } })
      : []
    const allVoucherIds = [...new Set([...voucherIds, ...moves.map((m) => m.cashVoucherId).filter((v): v is string => !!v)])]
    const vouchers = allVoucherIds.length
      ? await db.cashVoucher.findMany({ where: { id: { in: allVoucherIds } }, select: { id: true, number: true, payeeName: true, payeeUserId: true, purpose: true } })
      : []
    const userIds = vouchers.map((v) => v.payeeUserId).filter((v): v is string => !!v)
    const users = userIds.length ? await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : []
    const userName = new Map(users.map((u) => [u.id, u.name]))
    const vm = new Map(vouchers.map((v) => [v.id, v]))
    const payeeOfVoucher = (v: typeof vouchers[number]) => v.payeeName || (v.payeeUserId ? userName.get(v.payeeUserId) : undefined) || v.purpose
    for (const x of of('cashvoucher.pay')) {
      const v = vm.get(x.sourceId)
      if (v) set(x.entryId, { voucherNumber: v.number, payee: payeeOfVoucher(v) ?? undefined })
    }
    const mm = new Map(moves.map((m) => [m.id, m]))
    for (const x of of('pettycash.spend')) {
      const m = mm.get(x.sourceId)
      if (!m) continue
      const v = m.cashVoucherId ? vm.get(m.cashVoucherId) : undefined
      if (v) set(x.entryId, { voucherNumber: v.number, payee: payeeOfVoucher(v) ?? undefined, categoryOverride: 'cash_voucher' })
      else set(x.entryId, { payee: m.vendorName || m.reason })
    }
  })())

  // Payroll runs and full & final: the salary tax was taken at the accrual (2042).
  if (of('hr.payroll.payment').length) tasks.push((async () => {
    const runs = await db.hrPayrollRun.findMany({ where: { id: { in: ids('hr.payroll.payment') } }, select: { id: true, period: true } })
    const rm = new Map(runs.map((r) => [r.id, r]))
    const tax = await accrualTax(db, of('hr.payroll.payment').map((x) => ({ ...x, accrual: `hr.payroll.accrual:${x.sourceId}` })))
    for (const x of of('hr.payroll.payment')) {
      const r = rm.get(x.sourceId)
      set(x.entryId, { voucherNumber: r ? `Payroll ${r.period}` : undefined, payee: r ? `Staff payroll ${r.period}` : undefined, whtCents: tax.get(x.entryId) ?? 0 })
    }
  })())
  const hrRecordTypes = ['hr.final_settlement.payment', 'hr.loan.disbursement']
  if (hrRecordTypes.some((t) => of(t).length)) tasks.push((async () => {
    const recs = await db.hrRecord.findMany({
      where: { id: { in: hrRecordTypes.flatMap(ids) } },
      select: { id: true, employee: { select: { fullName: true, employeeCode: true } } },
    })
    const m = new Map(recs.map((r) => [r.id, r]))
    const tax = await accrualTax(db, of('hr.final_settlement.payment').map((x) => ({ ...x, accrual: `hr.final_settlement.accrual:${x.sourceId}` })))
    for (const t of hrRecordTypes) {
      for (const x of of(t)) {
        const r = m.get(x.sourceId)
        set(x.entryId, {
          payee: r?.employee?.fullName ?? undefined,
          voucherNumber: r?.employee?.employeeCode ? `${t === 'hr.loan.disbursement' ? 'LOAN' : 'F&F'} ${r.employee.employeeCode}` : undefined,
          ...(t === 'hr.final_settlement.payment' ? { whtCents: tax.get(x.entryId) ?? 0 } : {}),
        })
      }
    }
  })())

  if (of('tippool.payout').length) tasks.push((async () => {
    const pools = await db.tipPool.findMany({ where: { id: { in: ids('tippool.payout') } }, select: { id: true, name: true } })
    const m = new Map(pools.map((p) => [p.id, p]))
    for (const x of of('tippool.payout')) { const p = m.get(x.sourceId); if (p) set(x.entryId, { payee: `Tip pool — ${p.name}` }) }
  })())

  if (of('opex.payment').length) tasks.push((async () => {
    const pays = await db.opexPayment.findMany({
      where: { id: { in: ids('opex.payment') } },
      select: { id: true, paymentRef: true, line: { select: { name: true, vendor: true, supplier: { select: { name: true } } } } },
    })
    const m = new Map(pays.map((p) => [p.id, p]))
    for (const x of of('opex.payment')) {
      const p = m.get(x.sourceId)
      if (p) set(x.entryId, { voucherNumber: p.paymentRef || undefined, payee: p.line.supplier?.name || p.line.vendor || p.line.name })
    }
  })())

  if (of('capex.payment').length) tasks.push((async () => {
    const pays = await db.capexPayment.findMany({
      where: { id: { in: ids('capex.payment') } },
      select: { id: true, paymentRef: true, label: true, line: { select: { item: true, vendor: true, supplierRecord: { select: { name: true } } } } },
    })
    const m = new Map(pays.map((p) => [p.id, p]))
    for (const x of of('capex.payment')) {
      const p = m.get(x.sourceId)
      if (p) set(x.entryId, { voucherNumber: p.paymentRef || undefined, payee: p.line.supplierRecord?.name || p.line.vendor || p.line.item || p.label })
    }
  })())

  if (of('salestax.payment').length) tasks.push((async () => {
    const pays = await db.salesTaxPayment.findMany({ where: { id: { in: ids('salestax.payment') } }, select: { id: true, authority: true, cprNumber: true } })
    const m = new Map(pays.map((p) => [p.id, p]))
    for (const x of of('salestax.payment')) {
      const p = m.get(x.sourceId)
      if (p) set(x.entryId, { voucherNumber: p.cprNumber || undefined, payee: p.authority.toUpperCase() })
    }
  })())

  if (of('receivable.refund').length) tasks.push((async () => {
    const pays = await db.receivablePayment.findMany({
      where: { id: { in: ids('receivable.refund') } },
      select: { id: true, method: true, reference: true, invoice: { select: { number: true, customerName: true } } },
    })
    const m = new Map(pays.map((p) => [p.id, p]))
    for (const x of of('receivable.refund')) {
      const p = m.get(x.sourceId)
      if (p) set(x.entryId, { voucherNumber: p.reference || p.invoice.number, payee: p.invoice.customerName, cheque: p.method === 'cheque' })
    }
  })())

  await Promise.all(tasks)
  return out
}

/** Credits to 2042 (salary tax) in each payment's matching accrual entry. */
async function accrualTax(db: Db, items: Array<{ entryId: string; tenantId: string; accrual: string }>): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (items.length === 0) return out
  const lines = await db.journalLine.findMany({
    where: {
      type: 'credit',
      account: { code: { in: [...WHT_PAYABLE_CODES] } },
      journalEntry: { reference: { in: items.map((i) => i.accrual) }, tenantId: { in: [...new Set(items.map((i) => i.tenantId))] } },
    },
    select: { amountCents: true, journalEntry: { select: { reference: true, tenantId: true } } },
  })
  const byRef = new Map<string, number>()
  for (const l of lines) {
    const k = `${l.journalEntry.tenantId}|${l.journalEntry.reference}`
    byRef.set(k, (byRef.get(k) ?? 0) + toCents(l.amountCents))
  }
  for (const i of items) out.set(i.entryId, byRef.get(`${i.tenantId}|${i.accrual}`) ?? 0)
  return out
}

export function filterRows(rows: PaymentRow[], f: RegisterFilters): PaymentRow[] {
  const q = (f.q ?? '').trim().toLowerCase()
  return rows.filter((r) =>
    (!f.classification || f.classification === 'all' || r.classification === f.classification)
    && (!f.category || r.category === f.category)
    && (!f.method || r.method === f.method)
    && (!q || [r.voucherNo ?? '', r.voucherNumber, r.payee, r.narration, r.categoryLabel, r.methodLabel, r.reference ?? ''].some((s) => s.toLowerCase().includes(q))))
}

export interface ClassTotals { count: number; grossCents: number; whtCents: number; netCents: number }
export function totalsByClassification(rows: PaymentRow[]): Record<PaymentClassificationValue | 'all', ClassTotals> {
  const zero = (): ClassTotals => ({ count: 0, grossCents: 0, whtCents: 0, netCents: 0 })
  const t = { official: zero(), unofficial: zero(), unclassified: zero(), all: zero() }
  for (const r of rows) {
    for (const k of [r.classification, 'all'] as const) {
      t[k].count += 1; t[k].grossCents += r.grossCents; t[k].whtCents += r.whtCents; t[k].netCents += r.netCents
    }
  }
  return t
}

/**
 * The summary grid (owner, 2026-10-20: "combining all payments, through bank and cash, with the official /
 * unofficial option"): net paid per classification × method, with row and column totals. Cash, petty cash and bank
 * always show; cheque / other only when they hold something. Built from the rows it is given — the register passes
 * the period's payments narrowed by category and search, never by method or classification (the grid IS that split).
 */
export interface SummaryCell { count: number; netCents: number }
export interface PaymentsSummary {
  methods: Array<{ key: PaymentMethodKind; label: string }>
  rows: Array<{ classification: PaymentClassificationValue | 'all'; cells: Record<string, SummaryCell>; total: SummaryCell }>
}
export function paymentsSummary(rows: PaymentRow[]): PaymentsSummary {
  const used = new Set(rows.map((r) => r.method))
  const methods = (Object.keys(PAYMENT_METHOD_LABELS) as PaymentMethodKind[])
    .filter((m) => m === 'cash' || m === 'petty_cash' || m === 'bank' || used.has(m))
    .map((key) => ({ key, label: PAYMENT_METHOD_LABELS[key] }))
  const blank = () => Object.fromEntries(methods.map((m) => [m.key, { count: 0, netCents: 0 }])) as Record<string, SummaryCell>
  const order = ['official', 'unofficial', 'unclassified', 'all'] as const
  const out = order.map((classification) => ({ classification, cells: blank(), total: { count: 0, netCents: 0 } }))
  for (const r of rows) {
    for (const line of [out[order.indexOf(r.classification)]!, out[3]!]) {
      const c = line.cells[r.method]!
      c.count += 1; c.netCents += r.netCents
      line.total.count += 1; line.total.netCents += r.netCents
    }
  }
  return { methods, rows: out }
}

// ─── Tie-out to the ledger ───────────────────────────────────────────────────

export interface LedgerTieOut {
  /** Every credit to a money account in the period (all entries). */
  moneyCreditsCents: number
  /** …of which sales and till sources (order*, pos.*, shift.close). */
  salesAndTillCents: number
  /** …of which reversed entries and their reversals. */
  reversedCents: number
  /** …of which moved between money accounts, or netted by money coming back in the same entry, or entries that brought money in. */
  transfersAndReceiptsCents: number
  /** …the rest: net money out = payments. */
  paymentsNetCents: number
  /** Σ net of the register (All). */
  registerNetCents: number
  differenceCents: number
  ties: boolean
}

/**
 * Independent tie-out: the ledger's money credits in the period, split into
 * what is out of scope and what is a payment, computed from journal lines
 * alone; then compared with Σ net of the register's rows.
 */
export async function ledgerPaymentsTieOut(db: Db, tenantIds: string[], from: Date, to: Date, registerNetCents: number): Promise<LedgerTieOut> {
  const aggs = await moneyEntryAggregates(db, tenantIds, from, to)
  let moneyCredits = 0, sales = 0, reversed = 0, payments = 0
  for (const a of aggs) {
    moneyCredits += a.cr
    if (a.sales) sales += a.cr
    else if (a.dead) reversed += a.cr
    else if (a.cr - a.dr > 0) payments += a.cr - a.dr
  }
  const transfers = moneyCredits - sales - reversed - payments
  const diff = registerNetCents - payments
  return {
    moneyCreditsCents: moneyCredits,
    salesAndTillCents: sales,
    reversedCents: reversed,
    transfersAndReceiptsCents: transfers,
    paymentsNetCents: payments,
    registerNetCents,
    differenceCents: diff,
    ties: diff === 0,
  }
}

/**
 * The classification of each source document's payment entry, by its
 * reference ('<sourceType>:<id>'; a re-posted '<ref>@n' counts as the same
 * document, latest first). For the module lists that show a Classification
 * column (supplier payments, OpEx payments, payroll runs). Callers pass ids
 * they already scoped; `tenantIds` (when given) narrows further.
 */
export async function classificationsOfReferences(db: Db, tenantIds: string[] | null, references: string[]): Promise<Map<string, { journalEntryId: string; classification: PaymentClassificationValue }>> {
  const out = new Map<string, { journalEntryId: string; classification: PaymentClassificationValue }>()
  if (references.length === 0 || (tenantIds && tenantIds.length === 0)) return out
  const entries = await db.journalEntry.findMany({
    where: {
      ...(tenantIds ? { tenantId: { in: tenantIds } } : {}),
      OR: [{ reference: { in: references } }, ...references.map((r) => ({ reference: { startsWith: `${r}@` } }))],
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true, reference: true, paymentClassification: { select: { classification: true } } },
  })
  for (const e of entries) {
    if (!e.reference) continue
    const base = e.reference.replace(/@\d+$/, '')
    const prev = out.get(base)
    const own = e.paymentClassification?.classification as PaymentClassificationValue | undefined
    // Latest revision wins; an unclassified re-post keeps the earlier label (as the register does).
    out.set(base, { journalEntryId: e.id, classification: own ?? prev?.classification ?? 'unclassified' })
  }
  return out
}

/**
 * Wrap a payment route's transaction body so the classification it was sent
 * is written in the SAME transaction, right after the posting:
 *   prisma.$transaction(classifyingTx(classificationOf(req.body), userId, 'entryId', async (tx) => { … }))
 * No classification in the body → the body runs unchanged (Unclassified).
 */
export function classifyingTx<T>(
  input: ClassificationInput | null,
  setById: string | null,
  entryKey: string,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): (tx: Prisma.TransactionClient) => Promise<T> {
  return async (tx: Prisma.TransactionClient) => {
    const result = await fn(tx)
    // The result's journal entry id, at `entryKey` (a dotted path, e.g. 'entryId' or 'posted.entryId').
    let id: unknown = result
    for (const k of entryKey.split('.')) id = id && typeof id === 'object' ? (id as Record<string, unknown>)[k] : undefined
    if (input) await classifyPaymentTx(tx, { journalEntryId: typeof id === 'string' ? id : null, input, setById })
    return result
  }
}

/**
 * Classify the payment posted under `reference` ('<sourceType>:<sourceId>') in
 * the caller's transaction — for postings whose entry id the route does not
 * hold. No input / no such entry → no-op.
 */
export async function classifyByReferenceTx(
  tx: Db,
  args: { reference: string; tenantId?: string | null; input: ClassificationInput | null; setById: string | null },
): Promise<boolean> {
  if (!args.input) return false
  // The latest revision ('<ref>' or a re-post '<ref>@n', sourcePosting.ts).
  const entry = await tx.journalEntry.findFirst({
    where: {
      OR: [{ reference: args.reference }, { reference: { startsWith: `${args.reference}@` } }],
      ...(args.tenantId ? { tenantId: args.tenantId } : {}),
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  })
  return classifyPaymentTx(tx, { journalEntryId: entry?.id ?? null, input: args.input, setById: args.setById })
}
