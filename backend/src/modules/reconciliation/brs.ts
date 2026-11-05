// Bank Reconciliation Statements (owner, 2026-11-05: "reconcile the bank balance appearing in the company's
// accounting books with the actual closing balance appearing in the bank statement … integrated with the existing
// accounting system"; answers: extend the existing bank reconciliation, finance submits / the CEO approves, finance or
// the CEO reopens, a bank charge / credit voucher posts when finance confirms it).
//
// ONE engine on the EXISTING data — never a second ledger or a second statement store:
//   • the books        = the ledger (journal_lines) of the bank's chart code (BankAccount.accountCode), as at the
//                        period end (Karachi day) — the same figure the trial balance, the balance sheet and the
//                        account statement ("Bank Book") show;
//   • the bank         = bank_statement_lines of the bank's imports (reconciliation/service.ts importBankStatement),
//                        plus the closing balance finance types or the import carries;
//   • the pairing      = BankStatementLine.matchedJournalLineId (the existing auto / manual match), an adjustment's
//                        own entry ('reconciliation.adjustment:<lineId>[@n]'), and Raast receipts (receipt by receipt).
//
// AS AT the period end (periodTo):
//   uncredited deposits = book DEBITS on the bank code dated ≤ periodTo not cleared by a statement line dated ≤ periodTo
//   unpresented cheques = book CREDITS … the same
//   bank credits / debits not in books = statement lines dated ≤ periodTo that are unmatched (not ignored), or whose
//                         book line is dated after periodTo
//   section F           = BankReconciliationAdjustment rows (narration ≥10 + a reference; approved with the BRS)
// So nothing is entered twice and outstanding items CARRY FORWARD by themselves: an item stays outstanding in every
// later period until a statement line clears it. A reversed entry and its reversal (deadEntryIds) are left out only
// when they cancel each other (net zero) — otherwise they stay visible.
//
//   Adjusted balance as per bank  = bank closing + uncredited deposits − unpresented cheques ± bank-side adjustments
//   Adjusted balance as per books = book closing + bank credits not in books − bank debits not in books ± book-side adj.
//   Unreconciled difference       = adjusted bank − adjusted books   (must be 0 to submit)
// The second view (books → bank) is the same figures the other way round; both always agree (tested).
//
// Rules: the ledger is only READ here (no posting, no reversal, no date or amount change — a missing bank charge or
// credit is booked through the existing adjustment route, which posts when finance confirms; a book error through a
// journal voucher). Workflow draft → submitted (finance / CEO) → approved (the CEO: approval type bank_reconciliation)
// → reopened to draft (finance with `accounting` or the CEO, reason ≥10, audited, the CEO told). An APPROVED period
// locks its bank's statement lines (match / unmatch / ignore / adjust / import refused: RECONCILIATION_LOCKED) and the
// 'cleared before' marks dated in it. Periods of one bank never overlap; a later period is approved only after the
// earlier ones; an earlier one is reopened only while no later one is approved. Company: the bank's company.
import type { Prisma } from '@prisma/client'
import { createHash } from 'node:crypto'
import { prisma } from '../../lib/prisma.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { toCents } from '../../lib/money.js'
import { parsePktEndOfDay, parsePktStartOfDay } from '../accounting/dates.js'
import { RAAST_RECEIPTS_MEMO } from '../accounting/orderPosting.js'
import { MANUAL_PREFIX, splitDescription } from '../accounting/manualJournal.js'

type Db = Prisma.TransactionClient | typeof prisma

export const ADJUSTMENT_SOURCE_PREFIX = 'reconciliation.adjustment:'
export const ADJ_KINDS = ['bank_error', 'book_error', 'duplicate', 'wrong_amount', 'other'] as const
export const ADJ_KIND_LABEL: Record<string, string> = {
  bank_error: 'Error in bank statement', book_error: 'Error in company books', duplicate: 'Duplicate entry',
  wrong_amount: 'Incorrect transaction amount', other: 'Other reconciliation adjustment',
}
export const MIN_TEXT = 10
const DAY = 86_400_000

// ─── Dates ─────────────────────────────────────────────────────────────────────────────────────────────────────────
export const isoDay = (d: Date) => d.toISOString().slice(0, 10)
/** Statement lines are dated at UTC midnight of their day (the CSV parser): everything before the next day's midnight. */
const statementEnd = (periodTo: string) => new Date(Date.parse(`${periodTo}T00:00:00Z`) + DAY)
const statementStart = (periodFrom: string) => new Date(Date.parse(`${periodFrom}T00:00:00Z`))
export function assertDay(v: string, label: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) {
    throw new AppError('INVALID_DATE', `${label} must be a date (YYYY-MM-DD)`, 422)
  }
  return v
}
/** Pakistan's financial year (1 July – 30 June) of the period end: "2026-27". */
export function financialYearOf(periodTo: string): string {
  const [y, m] = periodTo.split('-').map(Number) as [number, number]
  const start = m >= 7 ? y : y - 1
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`
}

// ─── Which statement lines belong to a bank ────────────────────────────────────────────────────────────────────────
/** The imports of a bank: named by id, or (older imports) by its ledger code in its company. */
export function bankImportsWhere(bank: { id: string; tenantId: string; accountCode: string }): Prisma.BankStatementImportWhereInput {
  return { tenantId: bank.tenantId, OR: [{ bankAccountId: bank.id }, { bankAccountId: null, accountCode: bank.accountCode }] }
}

export interface BankRef { id: string; tenantId: string; accountCode: string; name: string; bankName: string | null; accountNumber: string | null }

export async function loadBank(db: Db, bankAccountId: string, tenantIds: string[] | null): Promise<BankRef> {
  const b = await db.bankAccount.findFirst({
    where: { id: bankAccountId, deletedAt: null, ...(tenantIds ? { tenantId: { in: tenantIds } } : {}) },
    select: { id: true, tenantId: true, accountCode: true, name: true, bankName: true, accountNumber: true },
  })
  if (!b || !b.tenantId) throw new NotFoundError('BankAccount', bankAccountId)
  if (!b.accountCode) throw new AppError('BANK_NOT_LINKED', 'This bank account is not linked to a chart-of-accounts code yet — link it on Bank accounts first', 422)
  return { ...b, tenantId: b.tenantId, accountCode: b.accountCode }
}

// ─── Locks (approved periods) ──────────────────────────────────────────────────────────────────────────────────────
/** The approved reconciliation of this bank whose period holds `day`, if any. */
export async function approvedPeriodHolding(db: Db, bank: { id: string }, day: string) {
  const d = new Date(`${day}T00:00:00Z`)
  return db.bankReconciliation.findFirst({
    where: { bankAccountId: bank.id, status: 'approved', periodFrom: { lte: d }, periodTo: { gte: d } },
    select: { id: true, periodFrom: true, periodTo: true },
  })
}

const lockedError = (r: { id: string; periodFrom: Date; periodTo: Date }) => new AppError(
  'RECONCILIATION_LOCKED',
  `The bank reconciliation for ${isoDay(r.periodFrom)} to ${isoDay(r.periodTo)} is approved and locked — reopen it first to change anything in that period`,
  409, { reconciliationId: r.id },
)

/** A statement line's bank (by its import). Null for an import with no bank (a non-bank ledger such as 1030). */
async function bankOfLine(db: Db, lineId: string) {
  const l = await db.bankStatementLine.findUnique({
    where: { id: lineId },
    select: { postedDate: true, import: { select: { tenantId: true, bankAccountId: true, accountCode: true } } },
  })
  if (!l) return null
  let bankId = l.import.bankAccountId
  if (!bankId && l.import.tenantId) {
    const b = await db.bankAccount.findFirst({ where: { tenantId: l.import.tenantId, accountCode: l.import.accountCode, deletedAt: null }, select: { id: true } })
    bankId = b?.id ?? null
  }
  return bankId ? { bankId, day: isoDay(l.postedDate) } : null
}

/** 409 RECONCILIATION_LOCKED when the statement line sits in an approved reconciliation of its bank. */
export async function assertStatementLineEditable(db: Db, lineId: string): Promise<void> {
  const b = await bankOfLine(db, lineId)
  if (!b) return
  const r = await approvedPeriodHolding(db, { id: b.bankId }, b.day)
  if (r) throw lockedError(r)
}

/** 409 when any of these statement days of the bank fall in an approved reconciliation (a late import). */
export async function assertDaysOpen(db: Db, bankAccountId: string | null | undefined, days: string[]): Promise<void> {
  if (!bankAccountId || days.length === 0) return
  const sorted = [...new Set(days)].sort()
  const from = new Date(`${sorted[0]}T00:00:00Z`)
  const to = new Date(`${sorted[sorted.length - 1]}T00:00:00Z`)
  const recs = await db.bankReconciliation.findMany({
    where: { bankAccountId, status: 'approved', periodFrom: { lte: to }, periodTo: { gte: from } },
    select: { id: true, periodFrom: true, periodTo: true },
  })
  for (const r of recs) {
    const f = isoDay(r.periodFrom), t = isoDay(r.periodTo)
    if (sorted.some((d) => d >= f && d <= t)) throw lockedError(r)
  }
}

// ─── Import dedupe ─────────────────────────────────────────────────────────────────────────────────────────────────
/** The key of a statement line for "already imported for this bank" (same day, amount, reference and description). */
export function statementDedupeKey(bankKey: string, l: { postedDate: Date; amountCents: number; reference: string | null; description: string }): string {
  const norm = (s: string | null) => (s ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
  return createHash('sha256').update([bankKey, isoDay(l.postedDate), String(l.amountCents), norm(l.reference), norm(l.description)].join('|')).digest('hex')
}

// ─── The statement ─────────────────────────────────────────────────────────────────────────────────────────────────
export interface BookItem {
  journalLineId: string; entryId: string; date: string; voucherNo: string | null; reference: string | null
  chequeRef: string | null; party: string | null; description: string; amountCents: number
  underReview: boolean; reviewNote: string | null; clearedOn: string | null; raast?: boolean
  /** Cleared by a manual entry (owner, 2026-11-05) — the bank's date / reference / note; no statement line. */
  manualClear?: { clearedOn: string; reference: string | null; note: string } | null
}
export interface BankItem {
  statementLineId: string; date: string; reference: string | null; description: string; amountCents: number
  underReview: boolean; recordedOn: string | null; matchStatus: string
}
export interface AdjustmentItem {
  id: string; side: 'bank' | 'book'; kind: string; kindLabel: string; amountCents: number; narration: string; reference: string
  statementLineId: string | null; journalLineId: string | null; createdById: string; createdAt: string
}
export interface Statement {
  bank: { id: string; name: string; bankName: string | null; accountNumber: string | null; accountCode: string; accountName: string | null }
  periodFrom: string; periodTo: string; financialYear: string
  book: { openingCents: number; receiptsCents: number; paymentsCents: number; closingCents: number }
  bankClosingCents: number | null
  deposits: BookItem[]; cheques: BookItem[]; bankCredits: BankItem[]; bankDebits: BankItem[]; adjustments: AdjustmentItem[]
  /** Book items cleared by a manual entry dated in this period (shown for review / undo; not outstanding). */
  manuallyCleared: Array<BookItem & { kind: 'deposit' | 'cheque' }>
  totals: {
    depositsCents: number; chequesCents: number; bankCreditsCents: number; bankDebitsCents: number
    bankAdjustmentsCents: number; bookAdjustmentsCents: number
    adjustedBankCents: number | null; adjustedBookCents: number; differenceCents: number | null
    /** Method 2: books → bank (what the bank should show). */
    expectedBankCents: number; matchedCount: number; underReviewCount: number
  }
  firstReconciliation: boolean
  computedAt: string
}

const REVERSAL_RE = /^([^:]+)\.(reversal|void):(.+)$/

/** Party (payee / depositor) of a book line, from its source document where servd knows it. */
async function partiesOf(db: Db, tenantId: string, refs: string[]): Promise<Map<string, { party: string | null; chequeRef: string | null }>> {
  const out = new Map<string, { party: string | null; chequeRef: string | null }>()
  const spIds = refs.map((r) => /^supplier\.payment:([^@]+)/.exec(r)?.[1]).filter((x): x is string => !!x)
  if (spIds.length) {
    const rows = await db.supplierPayment.findMany({
      where: { id: { in: spIds }, supplier: { tenantId } },
      select: { id: true, reference: true, supplier: { select: { name: true } } },
    })
    for (const r of rows) out.set(`supplier.payment:${r.id}`, { party: r.supplier?.name ?? null, chequeRef: r.reference ?? null })
  }
  const cvIds = refs.map((r) => /^cashvoucher\.pay:([^@]+)/.exec(r)?.[1]).filter((x): x is string => !!x)
  if (cvIds.length) {
    const rows = await db.cashVoucher.findMany({ where: { id: { in: cvIds }, tenantId }, select: { id: true, payeeName: true, purpose: true } })
    for (const r of rows) out.set(`cashvoucher.pay:${r.id}`, { party: r.payeeName ?? null, chequeRef: null })
  }
  return out
}

export async function computeStatement(db: Db, rec: {
  bank: BankRef; periodFrom: string; periodTo: string; bankClosingCents: number | null; reconciliationId?: string | null
}): Promise<Statement> {
  const { bank, periodFrom, periodTo } = rec
  const tenantId = bank.tenantId
  const account = await db.account.findFirst({ where: { tenantId, code: bank.accountCode }, select: { id: true, name: true } })
  if (!account) throw new AppError('ACCOUNT_NOT_FOUND', `No account ${bank.accountCode} in this company's chart`, 422)
  const bookEnd = parsePktEndOfDay(periodTo)
  const bookStart = parsePktStartOfDay(periodFrom)
  const stmtEnd = statementEnd(periodTo)

  // ── Book balances (the ledger, exactly as the trial balance reads it).
  const sums = await db.$queryRaw<Array<{ opening: bigint | number | null; dr: bigint | number | null; cr: bigint | number | null }>>`
    SELECT
      COALESCE(sum(CASE WHEN e."entryDate" < ${bookStart} THEN (CASE WHEN l.type = 'debit' THEN l."amountCents" ELSE -l."amountCents" END) END), 0)::bigint AS opening,
      COALESCE(sum(CASE WHEN e."entryDate" >= ${bookStart} AND l.type = 'debit' THEN l."amountCents" END), 0)::bigint AS dr,
      COALESCE(sum(CASE WHEN e."entryDate" >= ${bookStart} AND l.type = 'credit' THEN l."amountCents" END), 0)::bigint AS cr
      FROM journal_lines l JOIN journal_entries e ON e.id = l."journalEntryId"
     WHERE l."accountId" = ${account.id} AND e."tenantId" = ${tenantId} AND e."entryDate" <= ${bookEnd}`
  const openingCents = toCents(sums[0]?.opening ?? 0)
  const receiptsCents = toCents(sums[0]?.dr ?? 0)
  const paymentsCents = toCents(sums[0]?.cr ?? 0)
  const closingCents = openingCents + receiptsCents - paymentsCents

  // ── Statement lines of this bank up to the period end.
  const stmt = (await db.bankStatementLine.findMany({
    where: { import: bankImportsWhere(bank), postedDate: { lt: stmtEnd } },
    select: {
      id: true, postedDate: true, description: true, reference: true, amountCents: true, matchStatus: true,
      matchedJournalLineId: true, underReview: true, raastReceipt: { select: { id: true } },
    },
    orderBy: [{ postedDate: 'asc' }, { createdAt: 'asc' }],
  })).map((l) => ({ ...l, amountCents: toCents(l.amountCents) }))

  // Book lines cleared by a statement line dated ≤ periodTo: a match, or an adjustment's own entry.
  const clearedBy = new Map<string, string>() // journalLineId → statement day
  for (const l of stmt) if ((l.matchStatus === 'matched' || l.matchStatus === 'adjusted') && l.matchedJournalLineId) clearedBy.set(l.matchedJournalLineId, isoDay(l.postedDate))
  const adjustedIds = stmt.filter((l) => l.matchStatus === 'adjusted').map((l) => l.id)
  const stmtDay = new Map(stmt.map((l) => [l.id, isoDay(l.postedDate)]))

  // ── Book lines on the account dated ≤ periodTo that no statement line dated ≤ periodTo points at.
  const open = await db.$queryRaw<Array<{
    id: string; type: string; amountCents: bigint | number; memo: string | null; entryId: string; entryDate: Date
    reference: string | null; description: string; voucherNo: string | null
  }>>`
    SELECT l.id, l.type::text AS type, l."amountCents", l.memo, e.id AS "entryId", e."entryDate", e.reference, e.description, e."voucherNo"
      FROM journal_lines l JOIN journal_entries e ON e.id = l."journalEntryId"
     WHERE l."accountId" = ${account.id} AND e."tenantId" = ${tenantId} AND e."entryDate" <= ${bookEnd}
       AND NOT EXISTS (
             SELECT 1 FROM bank_statement_lines s
              WHERE s."matchedJournalLineId" = l.id AND s."matchStatus" IN ('matched', 'adjusted') AND s."postedDate" < ${stmtEnd})
     ORDER BY e."entryDate", e."createdAt", l.id`

  // An adjustment's own entry is cleared by its statement line (older rows carry no matchedJournalLineId).
  const adjCleared = new Set<string>()
  for (const r of open) {
    if (!r.reference?.startsWith(ADJUSTMENT_SOURCE_PREFIX)) continue
    const lineId = r.reference.slice(ADJUSTMENT_SOURCE_PREFIX.length).split('@')[0]!
    if (adjustedIds.includes(lineId)) { adjCleared.add(r.id); clearedBy.set(r.id, stmtDay.get(lineId)!) }
  }

  // Raast takings reconcile receipt by receipt: their (aggregated) book lines are one group below.
  const isRaast = (r: { memo: string | null }) => (r.memo ?? '').startsWith(RAAST_RECEIPTS_MEMO)
  const signedOf = (r: { type: string; amountCents: bigint | number }) => (r.type === 'debit' ? 1 : -1) * toCents(r.amountCents)

  // Reversal pairs that cancel out on this account (an entry and its reversal both ≤ periodTo, both still open).
  const pairKey = (ref: string | null) => {
    if (!ref) return null
    const m = REVERSAL_RE.exec(ref)
    return m ? `${m[1]}:${m[3]}` : ref
  }
  const groups = new Map<string, { net: number; ids: string[]; hasReversal: boolean }>()
  for (const r of open) {
    if (isRaast(r) || adjCleared.has(r.id)) continue
    const k = pairKey(r.reference)
    if (!k) continue
    const g = groups.get(k) ?? { net: 0, ids: [], hasReversal: false }
    g.net += signedOf(r); g.ids.push(r.id)
    if (REVERSAL_RE.test(r.reference ?? '')) g.hasReversal = true
    groups.set(k, g)
  }
  const cancelled = new Set<string>()
  for (const g of groups.values()) if (g.hasReversal && g.ids.length >= 2 && g.net === 0) for (const id of g.ids) cancelled.add(id)

  // Marks: 'cleared_prior' = cleared before this bank's first reconciliation; 'under_review' = flagged.
  // 'cleared_manual' = cleared by the bank on `clearedOn`, entered by hand (no statement line): not outstanding once
  // that day is on or before the period end.
  const marks = await db.bankReconBookMark.findMany({ where: { tenantId, bankAccountId: bank.id }, select: { journalLineId: true, status: true, note: true, reference: true, clearedOn: true } })
  const markOf = new Map(marks.map((m) => [m.journalLineId, m]))
  const manualDay = (id: string) => { const m = markOf.get(id); return m?.status === 'cleared_manual' && m.clearedOn ? isoDay(m.clearedOn) : null }
  const manuallyClearedIds = new Set(open.filter((r) => { const d = manualDay(r.id); return d != null && d <= periodTo }).map((r) => r.id))

  const live = open.filter((r) => !isRaast(r) && !adjCleared.has(r.id) && !cancelled.has(r.id) && markOf.get(r.id)?.status !== 'cleared_prior' && !manuallyClearedIds.has(r.id))
  const parties = await partiesOf(db, tenantId, [...live, ...open.filter((r) => manuallyClearedIds.has(r.id))].map((r) => r.reference ?? '').filter(Boolean))
  // When did each still-open line clear (a statement line dated after periodTo)? For the "cleared on" column.
  const later = live.length
    ? await db.bankStatementLine.findMany({
        where: { matchedJournalLineId: { in: live.map((r) => r.id) }, matchStatus: { in: ['matched', 'adjusted'] } },
        select: { matchedJournalLineId: true, postedDate: true },
      })
    : []
  const laterOf = new Map(later.map((l) => [l.matchedJournalLineId!, isoDay(l.postedDate)]))
  const toBookItem = (r: typeof open[number]): BookItem => {
    const isManual = (r.reference ?? '').startsWith(MANUAL_PREFIX)
    const split = isManual ? splitDescription(r.description) : { description: r.description, reference: null }
    const p = parties.get(r.reference ?? '')
    const m = markOf.get(r.id)
    return {
      journalLineId: r.id, entryId: r.entryId, date: isoDay(new Date(r.entryDate.getTime() + 5 * 3600_000)), voucherNo: r.voucherNo,
      reference: r.reference, chequeRef: split.reference ?? p?.chequeRef ?? null, party: p?.party ?? null,
      description: (r.memo && !isManual ? `${split.description} — ${r.memo}` : split.description).slice(0, 500),
      amountCents: Math.abs(signedOf(r)), underReview: m?.status === 'under_review', reviewNote: m?.status === 'under_review' ? m.note : null,
      clearedOn: laterOf.get(r.id) ?? manualDay(r.id),
      manualClear: m?.status === 'cleared_manual' && m.clearedOn ? { clearedOn: isoDay(m.clearedOn), reference: m.reference, note: m.note } : null,
    }
  }
  const deposits: BookItem[] = live.filter((r) => r.type === 'debit').map(toBookItem)
  const cheques: BookItem[] = live.filter((r) => r.type === 'credit').map(toBookItem)
  const manuallyCleared = open
    .filter((r) => manuallyClearedIds.has(r.id) && !adjCleared.has(r.id) && !cancelled.has(r.id) && (manualDay(r.id) ?? '') >= periodFrom)
    .map((r) => ({ ...toBookItem(r), kind: (r.type === 'debit' ? 'deposit' : 'cheque') as 'deposit' | 'cheque' }))

  // Raast: book Raast net ≤ periodTo − Raast money the bank statement shows ≤ periodTo = Raast still to arrive.
  // (Raast book lines are never matched one-to-one, so every one of them is in `open`.)
  const raastBookNet = open.filter(isRaast).reduce((t, r) => t + signedOf(r), 0)
  const raastCleared = stmt.filter((l) => l.raastReceipt && l.matchStatus === 'matched').reduce((t, l) => t + l.amountCents, 0)
  const raastOpen = raastBookNet - raastCleared
  if (raastOpen !== 0) {
    const item: BookItem = {
      journalLineId: `raast:${bank.id}`, entryId: '', date: periodTo, voucherNo: null, reference: 'raast', chequeRef: null, party: null,
      description: 'Raast QR takings booked but not yet matched to the bank statement (Reconciliation → Raast, receipt by receipt)',
      amountCents: Math.abs(raastOpen), underReview: false, reviewNote: null, clearedOn: null, raast: true,
    }
    if (raastOpen > 0) deposits.push(item); else cheques.push(item)
  }

  // ── Bank side: statement lines ≤ periodTo the books do not hold as at periodTo.
  const matchedBook = stmt.filter((l) => (l.matchStatus === 'matched' || l.matchStatus === 'adjusted') && l.matchedJournalLineId).map((l) => l.matchedJournalLineId!)
  const bookDates = matchedBook.length
    ? new Map((await db.journalLine.findMany({ where: { id: { in: matchedBook } }, select: { id: true, journalEntry: { select: { entryDate: true } } } }))
        .map((j) => [j.id, j.journalEntry.entryDate]))
    : new Map<string, Date>()
  const bankCredits: BankItem[] = []
  const bankDebits: BankItem[] = []
  let matchedCount = 0
  for (const l of stmt) {
    if (l.matchStatus === 'ignored') continue
    let recordedOn: string | null = null
    if (l.matchStatus === 'matched' || l.matchStatus === 'adjusted') {
      const d = l.matchedJournalLineId ? bookDates.get(l.matchedJournalLineId) : null
      if (!d || d.getTime() <= bookEnd.getTime()) { matchedCount++; continue }
      recordedOn = isoDay(new Date(d.getTime() + 5 * 3600_000))
    }
    const item: BankItem = {
      statementLineId: l.id, date: isoDay(l.postedDate), reference: l.reference, description: l.description,
      amountCents: Math.abs(l.amountCents), underReview: l.underReview, recordedOn, matchStatus: l.matchStatus,
    }
    if (l.amountCents > 0) bankCredits.push(item); else if (l.amountCents < 0) bankDebits.push(item)
  }

  // ── Section F.
  const adjustments: AdjustmentItem[] = rec.reconciliationId
    ? (await db.bankReconciliationAdjustment.findMany({ where: { reconciliationId: rec.reconciliationId, removedAt: null }, orderBy: { createdAt: 'asc' } }))
        .map((a) => ({
          id: a.id, side: a.side as 'bank' | 'book', kind: a.kind, kindLabel: ADJ_KIND_LABEL[a.kind] ?? a.kind, amountCents: toCents(a.amountCents),
          narration: a.narration, reference: a.reference, statementLineId: a.statementLineId, journalLineId: a.journalLineId,
          createdById: a.createdById, createdAt: a.createdAt.toISOString(),
        }))
    : []

  const sum = (xs: Array<{ amountCents: number }>) => xs.reduce((t, x) => t + x.amountCents, 0)
  const depositsCents = sum(deposits), chequesCents = sum(cheques)
  const bankCreditsCents = sum(bankCredits), bankDebitsCents = sum(bankDebits)
  const bankAdjustmentsCents = sum(adjustments.filter((a) => a.side === 'bank'))
  const bookAdjustmentsCents = sum(adjustments.filter((a) => a.side === 'book'))
  const adjustedBookCents = closingCents + bankCreditsCents - bankDebitsCents + bookAdjustmentsCents
  const adjustedBankCents = rec.bankClosingCents == null ? null : rec.bankClosingCents + depositsCents - chequesCents + bankAdjustmentsCents
  const expectedBankCents = adjustedBookCents - depositsCents + chequesCents - bankAdjustmentsCents

  const first = rec.reconciliationId
    ? (await db.bankReconciliation.count({ where: { bankAccountId: bank.id, status: { not: 'cancelled' }, periodTo: { lt: new Date(`${periodFrom}T00:00:00Z`) } } })) === 0
    : true
  return {
    bank: { id: bank.id, name: bank.name, bankName: bank.bankName, accountNumber: bank.accountNumber, accountCode: bank.accountCode, accountName: account.name },
    periodFrom, periodTo, financialYear: financialYearOf(periodTo),
    book: { openingCents, receiptsCents, paymentsCents, closingCents },
    bankClosingCents: rec.bankClosingCents,
    deposits, cheques, bankCredits, bankDebits, adjustments, manuallyCleared,
    totals: {
      depositsCents, chequesCents, bankCreditsCents, bankDebitsCents, bankAdjustmentsCents, bookAdjustmentsCents,
      adjustedBankCents, adjustedBookCents, differenceCents: adjustedBankCents == null ? null : adjustedBankCents - adjustedBookCents,
      expectedBankCents, matchedCount,
      underReviewCount: [...deposits, ...cheques].filter((i) => i.underReview).length + [...bankCredits, ...bankDebits].filter((i) => i.underReview).length,
    },
    firstReconciliation: first,
    computedAt: new Date().toISOString(),
  }
}

/** The figures that must not move between submit and approve. */
export const fingerprintOf = (s: Statement) => JSON.stringify([
  s.book.closingCents, s.bankClosingCents, s.totals.depositsCents, s.totals.chequesCents, s.totals.bankCreditsCents,
  s.totals.bankDebitsCents, s.totals.bankAdjustmentsCents, s.totals.bookAdjustmentsCents,
])

export function recordOf(r: { id: string; tenantId: string; bankAccountId: string; periodFrom: Date; periodTo: Date; bankClosingCents: bigint | number | null }) {
  return { id: r.id, periodFrom: isoDay(r.periodFrom), periodTo: isoDay(r.periodTo), bankClosingCents: r.bankClosingCents == null ? null : toCents(r.bankClosingCents) }
}

// ─── Auto-match suggestions ────────────────────────────────────────────────────────────────────────────────────────
// Equal signed amount on the bank's code, within ±windowDays; among several, the one whose cheque number / reference
// appears in the other's text wins, then the nearest date. A suggestion is made only when ONE candidate is best —
// never a guess. Applying goes through the manual-match route's own engine (its locks, guards and audit).
export interface MatchSuggestion { statementLineId: string; journalLineId: string; reason: string; date: string; amountCents: number; description: string; book: string }

const tokensOf = (s: string | null | undefined) =>
  new Set((s ?? '').toLowerCase().match(/[a-z0-9]{4,}/g)?.filter((t) => /\d/.test(t)) ?? [])

export async function suggestMatches(db: Db, bank: BankRef, upTo: string, windowDays = 7): Promise<MatchSuggestion[]> {
  const account = await db.account.findFirst({ where: { tenantId: bank.tenantId, code: bank.accountCode }, select: { id: true } })
  if (!account) return []
  const stmt = (await db.bankStatementLine.findMany({
    where: { import: bankImportsWhere(bank), matchStatus: 'unmatched', postedDate: { lt: statementEnd(upTo) }, raastReceipt: null },
    select: { id: true, postedDate: true, description: true, reference: true, amountCents: true },
  })).map((l) => ({ ...l, amountCents: toCents(l.amountCents) }))
  if (stmt.length === 0) return []
  const minD = new Date(Math.min(...stmt.map((l) => l.postedDate.getTime())) - windowDays * DAY)
  const maxD = new Date(Math.max(...stmt.map((l) => l.postedDate.getTime())) + windowDays * DAY)
  const rows = await db.journalLine.findMany({
    where: { accountId: account.id, journalEntry: { tenantId: bank.tenantId, entryDate: { gte: minD, lte: maxD } } },
    select: { id: true, type: true, amountCents: true, memo: true, journalEntry: { select: { id: true, entryDate: true, reference: true, description: true, voucherNo: true } } },
  })
  const { deadEntryIds } = await import('./service.js')
  const usable = rows.filter((r) => !(r.memo ?? '').startsWith(RAAST_RECEIPTS_MEMO))
  const dead = await deadEntryIds(db, bank.tenantId, usable.map((r) => r.journalEntry))
  const taken = new Set((await db.bankStatementLine.findMany({ where: { matchedJournalLineId: { in: usable.map((r) => r.id) } }, select: { matchedJournalLineId: true } })).map((t) => t.matchedJournalLineId))
  const marks = new Set((await db.bankReconBookMark.findMany({ where: { journalLineId: { in: usable.map((r) => r.id) }, status: 'cleared_prior' }, select: { journalLineId: true } })).map((m) => m.journalLineId))
  const free = usable.filter((r) => !dead.has(r.journalEntry.id) && !taken.has(r.id) && !marks.has(r.id))
  const used = new Set<string>()
  const out: MatchSuggestion[] = []
  for (const l of stmt) {
    const cands = free.filter((r) => !used.has(r.id)
      && (r.type === 'debit' ? 1 : -1) * toCents(r.amountCents) === l.amountCents
      && Math.abs(r.journalEntry.entryDate.getTime() - l.postedDate.getTime()) <= windowDays * DAY)
    if (cands.length === 0) continue
    const stmtTokens = new Set([...tokensOf(l.reference), ...tokensOf(l.description)])
    const scored = cands.map((r) => {
      const bookTokens = new Set([...tokensOf(r.journalEntry.reference), ...tokensOf(r.journalEntry.description), ...tokensOf(r.memo), ...tokensOf(r.journalEntry.voucherNo)])
      const refHit = [...stmtTokens].some((t) => bookTokens.has(t))
      return { r, refHit, gap: Math.abs(r.journalEntry.entryDate.getTime() - l.postedDate.getTime()) }
    }).sort((a, b) => Number(b.refHit) - Number(a.refHit) || a.gap - b.gap)
    const best = scored[0]!
    const second = scored[1]
    // Unique best: a reference hit nobody else has, or the only candidate, or a strictly nearer date with no reference anywhere.
    const unique = !second
      || (best.refHit && !second.refHit)
      || (!best.refHit && !second.refHit && best.gap < second.gap)
    if (!unique) continue
    used.add(best.r.id)
    out.push({
      statementLineId: l.id, journalLineId: best.r.id,
      reason: best.refHit ? 'Amount + cheque / reference number' : cands.length === 1 ? 'Amount, date within the window' : 'Amount, nearest date',
      date: isoDay(l.postedDate), amountCents: l.amountCents, description: l.description,
      book: `${best.r.journalEntry.voucherNo ?? ''} ${best.r.journalEntry.description}`.trim().slice(0, 200),
    })
  }
  return out
}
