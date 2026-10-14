// Reconciliation service.
//
// Bank/gateway statement reconciliation — operator pastes CSV; we parse,
// auto-match against journal lines, and surface unmatched rows for the
// operator to investigate / book as adjustment journal entries.

import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { ACCT, postJournalEntry, type JournalLineInput } from '../accounting/journal.js'
import { MAX_MONEY_CENTS, assertMoneyFits, toCents } from '../../lib/money.js'
import { audit } from '../../lib/audit.js'
import { flagException } from '../../lib/exceptions.js'
import { RAAST_RECEIPTS_MEMO } from '../accounting/orderPosting.js'
import { matchRaastLinesTx, raastSkipLinesTx, flagUnmatchedReceipts } from './raast.js'
import {
  cardSettlementSettings, findCardPayoutFits, postCardFits, claimManualCardDaysTx, isPayoutBank, type CardFit,
} from './cardPayouts.js'

type Tx = Prisma.TransactionClient

// ─── CSV statement parser ────────────────────────────────────────────────────
// Lenient: accepts any of date,description,amount in the header (in any case);
// amount is signed. Operators can hand-massage exports from HBL / Faysal /
// JazzCash before pasting. Returns an array of normalised lines.

export interface ParsedStatementLine {
  postedDate: Date
  description: string
  reference: string | null
  amountCents: number
}

const HEADER_ALIASES: Record<string, string[]> = {
  date:        ['date', 'transaction date', 'posted date', 'value date'],
  description: ['description', 'narration', 'particulars', 'details'],
  amount:      ['amount', 'amount (pkr)', 'transaction amount', 'value'],
  reference:   ['reference', 'ref', 'ref no', 'transaction id', 'txn id'],
}

function findColumn(headers: string[], aliases: string[]): number {
  const lc = headers.map((h) => h.toLowerCase().trim())
  for (const a of aliases) {
    const idx = lc.indexOf(a)
    if (idx >= 0) return idx
  }
  return -1
}

function splitCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; continue }
      inQuotes = !inQuotes
      continue
    }
    if (ch === ',' && !inQuotes) { out.push(cur); cur = ''; continue }
    cur += ch
  }
  out.push(cur)
  return out
}

// One statement line becomes one journal line (BIGINT paisa, BOOKS-06): a
// single bank transaction can carry at most MAX_MONEY_CENTS (PKR 900bn), the
// ledger's own per-line ceiling. Above it, a clear 422 rather than a 500.

export function parseStatementCsv(csv: string): ParsedStatementLine[] {
  const lines = csv.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim().length > 0)
  if (lines.length < 2) throw new AppError('CSV_EMPTY', 'CSV must contain a header row and at least one data row', 400)

  const headers = splitCsvLine(lines[0]!)
  const dateIdx = findColumn(headers, HEADER_ALIASES['date']!)
  const descIdx = findColumn(headers, HEADER_ALIASES['description']!)
  const amtIdx  = findColumn(headers, HEADER_ALIASES['amount']!)
  const refIdx  = findColumn(headers, HEADER_ALIASES['reference']!)

  if (dateIdx < 0 || descIdx < 0 || amtIdx < 0) {
    throw new AppError('CSV_HEADERS_MISSING', `CSV must include date, description, and amount columns. Got: ${headers.join(', ')}`, 400)
  }

  const out: ParsedStatementLine[] = []
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]!)
    const dateRaw = cols[dateIdx]?.trim()
    const desc    = cols[descIdx]?.trim() ?? ''
    const amtRaw  = cols[amtIdx]?.trim() ?? ''
    if (!dateRaw || !amtRaw) continue

    const parsed = new Date(dateRaw)
    if (isNaN(parsed.getTime())) {
      throw new AppError('CSV_BAD_DATE', `Cannot parse date "${dateRaw}" on row ${i + 1}`, 400)
    }

    const cleaned = amtRaw.replace(/[, ]/g, '').replace(/^PKR/i, '')
    const amount = parseFloat(cleaned)
    if (isNaN(amount)) {
      throw new AppError('CSV_BAD_AMOUNT', `Cannot parse amount "${amtRaw}" on row ${i + 1}`, 400)
    }

    const amountCents = Math.round(amount * 100)
    if (!Number.isSafeInteger(amountCents) || Math.abs(amountCents) > MAX_MONEY_CENTS) {
      throw new AppError(
        'CSV_AMOUNT_TOO_LARGE',
        `Row ${i + 1}: a single statement line can be at most PKR 900,000,000,000.00 — got "${amtRaw}". Check the figure.`,
        422,
      )
    }
    out.push({
      postedDate: parsed,
      description: desc,
      reference: refIdx >= 0 ? (cols[refIdx]?.trim() || null) : null,
      amountCents,
    })
  }
  return out
}

// ─── Import + auto-match ────────────────────────────────────────────────────
// One transaction, four steps:
//   1. insert every line 'unmatched';
//   2. the Raast pass (./raast.ts — only when the import names its bank
//      account): a credit line naming exactly one provisional Raast receipt's
//      reference with the same amount matches that receipt;
//   3. the card-payout pass (./cardPayouts.ts, H12 — only when card payout
//      matching is on and this is the payout bank): a credit that fits
//      EXACTLY one run of unsettled card days (net of the MDR and the tax on
//      it) is collected; every credit with at least one fit is left for
//      finance by the generic pass. Raast's lines are never considered;
//   4. the generic pass: a line matches a journal line if, within a 3-day
//      window, signed amounts equal AND the journal-line account is the one
//      the statement is reconciling against. It skips lines steps 2 and 3
//      claimed, never uses a journal line whose memo starts with
//      RAAST_RECEIPTS_MEMO (a shift's aggregated Raast debit or a write-off —
//      those reconcile receipt by receipt on the Raast tab), leaves alone
//      every credit that names a Raast receipt's reference without matching
//      it (RV-FIN-2), and (S3) every credit equal to a provisional or
//      written-off Raast receipt's amount on that account within
//      ±statementMatchDays, which it would otherwise pair with any equal debit
//      (a cash deposit) and strand the receipt.
// After the commit, each card fit is booked in its OWN transaction
// (cardPayouts.postCardFits → 'card.settlement:<lineId>', the split through
// postCardPayoutSplitTx); a refused one stays unmatched with its reason on the
// line and a card_payout_unmatched flag (re-run from the Card payouts tab).
// Auto-matched lines flip to `matched`; the rest stay `unmatched` for the
// operator.

const MATCH_WINDOW_DAYS = 3

export async function importBankStatement(input: {
  source: string
  accountCode: string
  statementDate: Date
  openingBalanceCents: number
  closingBalanceCents: number
  filename?: string
  importedById?: string
  csv: string
  // Company being reconciled — resolves the bank account inside its own chart
  // and owns the import.
  tenantId: string
  // The bank the statement is for (null for a non-bank ledger like 1030).
  bankAccountId?: string | null
}) {
  const account = await prisma.account.findFirst({ where: { tenantId: input.tenantId, code: input.accountCode } })
  if (!account) throw new NotFoundError('Account', input.accountCode)

  const parsed = parseStatementCsv(input.csv)

  const result = await prisma.$transaction(async (tx) => {
    // No Raast lock here: inserting this import's own (new, uncommitted) rows
    // touches nothing the till or the SMS matcher write. matchRaastLinesTx
    // takes lockRaastTx itself right before it reads receipts (RV-FRAUD-6) —
    // holding it for the whole import would stall every till's Raast payment
    // of the company behind a big statement.
    const importRow = await tx.bankStatementImport.create({
      data: {
        tenantId: input.tenantId,
        bankAccountId: input.bankAccountId ?? null,
        source: input.source,
        accountCode: input.accountCode,
        statementDate: input.statementDate,
        openingBalanceCents: input.openingBalanceCents,
        closingBalanceCents: input.closingBalanceCents,
        filename: input.filename ?? null,
        importedById: input.importedById ?? null,
      },
    })

    // 1. Every line, unmatched, in the statement's own order (the generic
    //    pass below walks them in that order, as it always has).
    const order: string[] = []
    for (const line of parsed) {
      const row = await tx.bankStatementLine.create({
        data: {
          importId: importRow.id,
          postedDate: line.postedDate,
          description: line.description,
          reference: line.reference,
          amountCents: line.amountCents,
          matchStatus: 'unmatched',
        },
        select: { id: true },
      })
      order.push(row.id)
    }

    // 2. The Raast pass (same transaction, before the generic matcher).
    let raastMatched = 0
    const raastSkip = new Set<string>()
    if (input.bankAccountId) {
      const pass = await matchRaastLinesTx(tx, { tenantId: input.tenantId, importId: importRow.id, bankAccountId: input.bankAccountId, actorId: null })
      raastMatched = pass.matched
      // RV-FIN-2: a line that names a Raast receipt's reference but was not
      // matched (another amount, two receipts named, a receipt named twice) is
      // the Raast tab's — never paired with an unrelated equal journal line.
      for (const id of pass.hitLineIds) raastSkip.add(id)
    }
    const position = new Map(order.map((id, i) => [id, i]))
    const lines = (await tx.bankStatementLine.findMany({
      where: { importId: importRow.id, matchStatus: 'unmatched' },
      select: { id: true, postedDate: true, description: true, reference: true, amountCents: true },
    }))
      .map((l) => ({ ...l, amountCents: toCents(l.amountCents) }))
      .sort((a, b) => position.get(a.id)! - position.get(b.id)!)
    if (input.bankAccountId) {
      for (const id of await raastSkipLinesTx(tx, { tenantId: input.tenantId, bankAccountId: input.bankAccountId, lines })) raastSkip.add(id)
    }

    // 3. The card-payout pass (H12): collected here, booked after the commit.
    const cardSkip = new Set<string>()
    let cardFits: CardFit[] = []
    if (input.bankAccountId) {
      const cs = await cardSettlementSettings(tx, input.tenantId)
      if (isPayoutBank(cs, input.bankAccountId)) {
        const pass = await findCardPayoutFits(tx, {
          tenantId: input.tenantId, settings: cs, lines: lines.filter((l) => l.amountCents > 0 && !raastSkip.has(l.id)),
        })
        cardFits = pass.fits
        for (const id of pass.candidateLineIds) cardSkip.add(id)
      }
    }

    // 4. The generic pass. Candidate journal lines for the reconciling account
    //    in a wide window.
    if (parsed.length === 0) return { importId: importRow.id, totalRows: 0, matchedCount: 0, raastMatchedCount: 0, cardPayoutMatchedCount: 0, unmatchedCount: 0, cardFits }
    const minDate = new Date(parsed.reduce((m, l) => Math.min(m, l.postedDate.getTime()), Infinity) - MATCH_WINDOW_DAYS * 86400_000)
    const maxDate = new Date(parsed.reduce((m, l) => Math.max(m, l.postedDate.getTime()), -Infinity) + MATCH_WINDOW_DAYS * 86400_000)

    const candidates = (await tx.journalLine.findMany({
      where: {
        accountId: account.id,
        journalEntry: { entryDate: { gte: minDate, lte: maxDate } },
      },
      include: { journalEntry: { select: { entryDate: true } } },
    // A Raast line (a shift's aggregated Raast debit, a write-off) is never a
    // generic match — Raast reconciles receipt by receipt.
    })).filter((c) => !(c.memo ?? '').startsWith(RAAST_RECEIPTS_MEMO))

    // Lock out journal lines that ANY prior BankStatementLine already matched.
    // Without this, re-importing the same statement (or overlapping windows)
    // produces two BankStatementLine rows pointing at the same JournalLine —
    // breaking the audit trail and double-counting reconciliations.
    // Company-scoped: only this company's statement lines can have matched
    // this company's journal lines (the read used to span every company).
    const alreadyMatched = await tx.bankStatementLine.findMany({
      where: { matchStatus: 'matched', matchedJournalLineId: { not: null }, import: { tenantId: input.tenantId } },
      select: { matchedJournalLineId: true },
    })
    const consumed = new Set<string>(
      alreadyMatched.map((m) => m.matchedJournalLineId).filter((x): x is string => x !== null),
    )

    // Index candidates by signed amount → list of (lineId, date)
    const byAmount = new Map<number, Array<{ id: string; date: Date }>>()
    for (const c of candidates) {
      if (consumed.has(c.id)) continue   // already matched in a prior import
      // Map keys must be numbers (a bigint key never equals the parsed number).
      const amt = toCents(c.amountCents)
      const signed = c.type === 'debit' ? amt : -amt
      const arr = byAmount.get(signed) ?? []
      arr.push({ id: c.id, date: c.journalEntry.entryDate })
      byAmount.set(signed, arr)
    }

    let genericMatched = 0
    for (const line of lines) {
      if (raastSkip.has(line.id)) continue   // S3: left for the Raast tab
      if (cardSkip.has(line.id)) continue    // H12: a card payout (booked below, or finance confirms it)
      const candidates = byAmount.get(line.amountCents) ?? []
      const fit = candidates.find(
        (c) => !consumed.has(c.id) && Math.abs(c.date.getTime() - line.postedDate.getTime()) <= MATCH_WINDOW_DAYS * 86400_000,
      )
      if (!fit) continue
      consumed.add(fit.id)
      genericMatched++
      await tx.bankStatementLine.update({
        where: { id: line.id },
        data: { matchStatus: 'matched', matchedJournalLineId: fit.id },
      })
    }

    const matchedCount = genericMatched + raastMatched
    return {
      importId: importRow.id,
      totalRows: parsed.length,
      matchedCount,
      raastMatchedCount: raastMatched,
      cardPayoutMatchedCount: 0,
      unmatchedCount: parsed.length - matchedCount,
      cardFits,
    }
  }, { maxWait: 10_000, timeout: 60_000 })

  // The card payouts the pass found, each in its own transaction (a refusal
  // leaves its line unmatched with the reason — the import itself stands).
  const { cardFits, ...counts } = result
  if (cardFits.length > 0) {
    const card = await postCardFits(input.tenantId, cardFits)
    counts.cardPayoutMatchedCount = card.posted
    counts.matchedCount += card.posted
    counts.unmatchedCount -= card.posted
  }

  // The daily raast_unmatched flag of this company follows the import at
  // once (a statement that matched everything clears it). Best effort.
  if (input.bankAccountId) {
    await flagUnmatchedReceipts(input.tenantId).catch((err) => console.warn('[reconciliation] raast flag refresh failed:', (err as Error).message))
  }
  return counts
}

// Operator decision on an unmatched line: book it as an adjustment JE, in the
// books of the company whose statement it is. The statement line is one leg
// (Dr the reconciling account for money in, Cr for money out); the other side
// is either
//   • ONE contra account for the whole amount (bank fee → 6080, owner draw →
//     3030), or
//   • a SPLIT (BOOKS-11): several lines with their own side and amount, e.g. a
//     Keenu settlement that arrives net of the MDR —
//       Dr 1020 4,537.40 (the statement line)  Dr 6080 92.60  Cr 1030 4,630.00
//     — so the card receivable clears in full and the fee lands on 6080. The
//     split must balance against the statement line to the paisa.
//
// ONE posting core (postStatementEntryTx): balance, every code an active
// account of the statement's company, the entry dated the line's date, the
// bank leg's journal line returned. A card-payout split (money in, Cr 1030 and
// at most one Dr 6080) goes through postCardPayoutSplitTx — the SAME helper
// the card-payout matcher (./cardPayouts.ts, H12) books with, so there is one
// way to book a net Keenu payout.
//
// H12: while card payout matching is on, a split that credits 1030 on the
// payout bank must name the card days it settles (`cardDays`, + `cardUnit`
// per brand / machine): they are claimed (CardSettlement 'manual_adjust') in
// the same transaction, so the matcher never clears them again. Without them:
// 409 USE_CARD_PAYOUT_CONFIRM (use the Card payouts tab's confirm instead).
//
// A split onto a fixed-asset register account (1500–1599, 2012) needs
// `registerOverride { reason ≥ 10 }` (journal.ts controlledOverride); it is
// audited and flagged fixed_asset_gl_mismatch for review.
export interface AdjustmentLine {
  accountCode: string
  type: 'debit' | 'credit'
  amountCents: number
  memo?: string
}

export const ADJUSTMENT_SOURCE = 'reconciliation.adjustment'

/**
 * The one statement-line posting core (see above). Runs inside `tx`; never
 * changes the line's status — the caller does (adjusted / matched).
 */
async function postStatementEntryTx(tx: Tx, a: {
  tenantId: string
  line: { id: string; postedDate: Date; reference: string | null }
  bankLeg: JournalLineInput
  other: JournalLineInput[]
  sourceType: string
  sourceId: string
  description: string
  postedBy: string
  controlledOverride?: { reason: string }
}): Promise<{ entryId: string; bankLineId: string }> {
  const entryLines = [a.bankLeg, ...a.other]
  assertBalanced(entryLines)
  const codes = Array.from(new Set(entryLines.map((l) => l.accountCode)))
  const found = await tx.account.findMany({ where: { tenantId: a.tenantId, code: { in: codes }, isActive: true }, select: { code: true } })
  const missing = codes.filter((c) => !found.some((f) => f.code === c))
  if (missing.length > 0) {
    throw new AppError('ACCOUNT_NOT_FOUND', `No active account ${missing.join(', ')} in this company's chart of accounts`, 422)
  }
  const posted = await postJournalEntry({
    tenantId: a.tenantId,
    sourceType: a.sourceType,
    sourceId: a.sourceId,
    description: a.description.slice(0, 500),
    entryDate: a.line.postedDate,
    postedBy: a.postedBy,
    reference: a.line.reference ?? undefined,
    lines: entryLines,
    ...(a.controlledOverride ? { controlledOverride: a.controlledOverride } : {}),
  }, { tx })
  if (!posted.posted) {
    throw new AppError('ENTRY_ALREADY_POSTED', `${a.sourceType}:${a.sourceId} is already on the books — refresh`, 409)
  }
  const bankLine = await tx.journalLine.findFirst({
    where: { journalEntryId: posted.entryId, type: a.bankLeg.type, amountCents: a.bankLeg.amountCents, account: { tenantId: a.tenantId, code: a.bankLeg.accountCode } },
    select: { id: true },
  })
  if (!bankLine) throw new AppError('BANK_LEG_MISSING', 'The bank leg of the entry was not found', 500)
  return { entryId: posted.entryId, bankLineId: bankLine.id }
}

function assertBalanced(entryLines: JournalLineInput[]): void {
  const debits  = entryLines.filter((l) => l.type === 'debit').reduce((t, l) => t + l.amountCents, 0)
  const credits = entryLines.filter((l) => l.type === 'credit').reduce((t, l) => t + l.amountCents, 0)
  if (debits !== credits) {
    const diff = (Math.abs(debits - credits) / 100).toFixed(2)
    throw new AppError(
      'ADJUSTMENT_UNBALANCED',
      `The split does not balance the statement line: debits ${(debits / 100).toFixed(2)} vs credits ${(credits / 100).toFixed(2)} (off by PKR ${diff})`,
      422,
    )
  }
}

/**
 * BOOKS-11's card-payout split, the ONE way a net Keenu payout is booked —
 * the manual split (adjustStatementLine), the automatic match and finance's
 * confirm (./cardPayouts.ts) all call it, inside their own transaction:
 *
 *   Dr <bankCode> net (the statement line) / Dr 6080 fee / Cr 1030 gross
 *
 * gross = net + fee to the paisa; net must be the line's amount (money in).
 * Checks every account is active in the statement's company and posts
 * `${sourceType}:${sourceId}` dated the line's date. Returns the entry and the
 * bank leg's journal line (what a matched line points at). Never changes the
 * line's status.
 */
export async function postCardPayoutSplitTx(tx: Tx, a: {
  tenantId: string
  lineId: string
  grossCents: number
  feeCents: number
  netCents: number
  bankCode: string
  sourceType: string
  sourceId: string
  memo: string
  /** Entry description (default: the memo). */
  description?: string
  postedBy?: string
  /** Brand of the fee and the 1030 credit (per-brand payouts). */
  conceptId?: string | null
  /** Per-leg memos (a manual split keeps the operator's own). */
  bankMemo?: string
  grossMemo?: string
  feeMemo?: string
  controlledOverride?: { reason: string }
}): Promise<{ entryId: string; bankLineId: string }> {
  const line = await tx.bankStatementLine.findFirst({
    where: { id: a.lineId, import: { tenantId: a.tenantId } },
    select: { id: true, postedDate: true, reference: true, amountCents: true },
  })
  if (!line) throw new NotFoundError('BankStatementLine', a.lineId)
  for (const [what, v] of [['gross', a.grossCents], ['fee', a.feeCents], ['net', a.netCents]] as const) {
    if (!Number.isSafeInteger(v) || v < 0) throw new AppError('CARD_SPLIT_BAD_AMOUNT', `The card payout's ${what} must be a whole, non-negative amount in paisa`, 422)
    assertMoneyFits(v, `A card payout's ${what}`)
  }
  if (a.netCents <= 0 || a.grossCents <= 0) throw new AppError('CARD_SPLIT_BAD_AMOUNT', 'A card payout moves money IN: gross and net must be above zero', 422)
  if (a.grossCents !== a.netCents + a.feeCents) {
    throw new AppError('ADJUSTMENT_UNBALANCED', `Card sales ${(a.grossCents / 100).toFixed(2)} ≠ received ${(a.netCents / 100).toFixed(2)} + fee ${(a.feeCents / 100).toFixed(2)}`, 422)
  }
  if (toCents(line.amountCents) !== a.netCents) {
    throw new AppError('CARD_SPLIT_NOT_THE_LINE', 'The amount received must be the statement line\'s own amount', 422)
  }
  const conceptId = a.conceptId ?? null
  return postStatementEntryTx(tx, {
    tenantId: a.tenantId,
    line,
    bankLeg: { accountCode: a.bankCode, type: 'debit', amountCents: a.netCents, memo: a.bankMemo ?? a.memo },
    other: [
      { accountCode: ACCT.CARD_FEES, type: 'debit', amountCents: a.feeCents, memo: a.feeMemo ?? `${a.memo} — card fee (MDR + tax on it)`, conceptId },
      { accountCode: ACCT.CARD_RECEIVABLE, type: 'credit', amountCents: a.grossCents, memo: a.grossMemo ?? `${a.memo} — card sales settled`, conceptId },
    ],
    sourceType: a.sourceType,
    sourceId: a.sourceId,
    description: a.description ?? a.memo,
    postedBy: a.postedBy ?? 'system',
    controlledOverride: a.controlledOverride,
  })
}

export async function adjustStatementLine(input: {
  lineId: string
  memo: string
  postedById: string
  /** The whole amount to one account… */
  contraAccountCode?: string
  /** …or split across several (balanced against the statement line). */
  lines?: AdjustmentLine[]
  /** H12: the card days a split crediting 1030 on the payout bank settles (required while matching is on). */
  cardDays?: string[]
  /** H12: 'brand:<conceptId>' / 'terminal:<id>' when the company is paid per brand / machine. */
  cardUnit?: string
  /** Posting to a fixed-asset register account: why (≥ 10 characters). Audited + flagged. */
  registerOverride?: { reason: string }
  /** Who (for the register-override audit). */
  actorEmail?: string | null
  actorTenantId?: string | null
}) {
  const line = await prisma.bankStatementLine.findUnique({
    where: { id: input.lineId },
    include: { import: true },
  })
  if (!line) throw new NotFoundError('BankStatementLine', input.lineId)
  if (line.matchStatus !== 'unmatched') {
    throw new AppError('LINE_NOT_UNMATCHED', `Line is already ${line.matchStatus}`, 422)
  }
  // The adjustment posts to the books of the company whose statement this is.
  const tenantId = line.import.tenantId
  if (!tenantId) throw new AppError('IMPORT_HAS_NO_COMPANY', 'This statement import has no company — it cannot post to a ledger', 422)

  // Positive amount = inflow to the reconciling account; negative = outflow.
  const amt = toCents(line.amountCents)
  const isInflow = amt > 0
  const abs = Math.abs(amt)
  if (abs === 0) throw new AppError('LINE_ZERO', 'A zero-amount line has nothing to book — ignore it instead', 422)

  const bankLeg: JournalLineInput = {
    accountCode: line.import.accountCode,
    type: isInflow ? 'debit' : 'credit',
    amountCents: abs,
    memo: line.description,
  }
  let other: JournalLineInput[]
  if (input.lines && input.lines.length > 0) {
    other = input.lines.map((l) => ({ accountCode: l.accountCode.trim(), type: l.type, amountCents: l.amountCents, memo: l.memo?.trim() || input.memo }))
    for (const l of other) {
      if (!Number.isSafeInteger(l.amountCents) || l.amountCents <= 0) {
        throw new AppError('ADJUSTMENT_BAD_AMOUNT', `Each split line needs a positive amount in paisa (${l.accountCode})`, 422)
      }
      assertMoneyFits(l.amountCents, `A split line (${l.accountCode})`)
    }
  } else if (input.contraAccountCode) {
    other = [{ accountCode: input.contraAccountCode.trim(), type: isInflow ? 'credit' : 'debit', amountCents: abs, memo: input.memo }]
  } else {
    throw new AppError('ADJUSTMENT_CONTRA_REQUIRED', 'Give the contra account, or the split lines', 400)
  }
  assertBalanced([bankLeg, ...other])

  // H12: a split that clears card money on the payout bank claims its days.
  const cardCredits = other.filter((l) => l.accountCode === ACCT.CARD_RECEIVABLE && l.type === 'credit')
  const cs = await cardSettlementSettings(prisma, tenantId)
  const claimsCardDays = isInflow && cardCredits.length > 0 && isPayoutBank(cs, line.import.bankAccountId)
  if (claimsCardDays && !(input.cardDays && input.cardDays.length > 0)) {
    throw new AppError(
      'USE_CARD_PAYOUT_CONFIRM',
      'Card payout matching is on for this bank: confirm this payout on Reconciliation → Card payouts, or name the card days it settles — 1030 is never cleared twice',
      409,
    )
  }

  // Every code must be an active account of THIS company's chart — a typo is
  // the operator's to fix (422), not a server error.
  const codes = Array.from(new Set(other.map((l) => l.accountCode)))
  const found = await prisma.account.findMany({
    where: { tenantId, code: { in: codes }, isActive: true },
    select: { code: true },
  })
  const missing = codes.filter((c) => !found.some((a) => a.code === c))
  if (missing.length > 0) {
    throw new AppError('ACCOUNT_NOT_FOUND', `No active account ${missing.join(', ')} in this company's chart of accounts`, 422)
  }

  const overrideReason = input.registerOverride?.reason?.trim() ?? ''
  const controlledOverride = overrideReason ? { reason: overrideReason } : undefined
  // The BOOKS-11 card shape: money in, one Cr 1030, at most one Dr 6080, nothing else.
  const feeLines = other.filter((l) => l.accountCode === ACCT.CARD_FEES && l.type === 'debit')
  const cardShaped = isInflow && cardCredits.length === 1 && feeLines.length <= 1 && other.length === cardCredits.length + feeLines.length

  // Post and mark the line in one transaction: a line is never left
  // 'unmatched' with its entry posted, nor 'adjusted' without one.
  const posted = await prisma.$transaction(async (tx) => {
    let settlementId: string | null = null
    if (claimsCardDays) {
      const claim = await claimManualCardDaysTx(tx, {
        tenantId, settings: cs, lineId: line.id, lineDate: line.postedDate, bankAccountId: line.import.bankAccountId!,
        unit: input.cardUnit?.trim() || 'company', days: input.cardDays!,
        grossCents: cardCredits.reduce((t, l) => t + l.amountCents, 0),
        feeCents: feeLines.reduce((t, l) => t + l.amountCents, 0),
        netCents: abs, actorId: input.postedById,
      })
      settlementId = claim.settlementId
    }
    // A line put back to unmatched (its card claim undone) books its next
    // adjustment as '<lineId>@n' — a posting is idempotent per reference.
    const prior = await tx.journalEntry.count({
      where: { tenantId, OR: [{ reference: `${ADJUSTMENT_SOURCE}:${line.id}` }, { reference: { startsWith: `${ADJUSTMENT_SOURCE}:${line.id}@` } }] },
    })
    const sourceId = prior === 0 ? line.id : `${line.id}@${prior + 1}`
    const description = `Adjustment: ${line.description} (${input.memo})`
    let res: { entryId: string; bankLineId: string }
    if (cardShaped) {
      const credit = cardCredits[0]!
      const fee = feeLines[0]
      res = await postCardPayoutSplitTx(tx, {
        tenantId, lineId: line.id, grossCents: credit.amountCents, feeCents: fee?.amountCents ?? 0, netCents: abs,
        bankCode: line.import.accountCode, sourceType: ADJUSTMENT_SOURCE, sourceId, memo: input.memo, description,
        postedBy: input.postedById, bankMemo: line.description, grossMemo: credit.memo, feeMemo: fee?.memo, controlledOverride,
      })
    } else {
      res = await postStatementEntryTx(tx, {
        tenantId, line, bankLeg, other, sourceType: ADJUSTMENT_SOURCE, sourceId, description, postedBy: input.postedById, controlledOverride,
      })
    }
    const claimed = await tx.bankStatementLine.updateMany({
      where: { id: line.id, matchStatus: 'unmatched' },
      data: { matchStatus: 'adjusted', notes: input.memo },
    })
    if (claimed.count === 0) throw new AppError('LINE_NOT_UNMATCHED', 'Line was already cleared', 409)
    if (settlementId) await tx.cardSettlement.update({ where: { id: settlementId }, data: { journalEntryId: res.entryId } })
    return { ...res, sourceId, settlementId }
  })

  // A register account posted from a bank line: audited and flagged for review.
  if (controlledOverride) {
    const touched = await prisma.account.findMany({
      where: { tenantId, code: { in: Array.from(new Set([line.import.accountCode, ...codes])) }, controlledBy: 'fixed_asset' },
      select: { code: true },
    })
    if (touched.length > 0) {
      const touchedCodes = touched.map((t) => t.code).sort()
      await audit({
        category: 'accounting',
        action: 'reconciliation.adjustment.register_override',
        entity: 'BankStatementLine',
        entityId: line.id,
        userId: input.postedById,
        userEmail: input.actorEmail ?? null,
        tenantId,
        after: { entryId: posted.entryId, codes: touchedCodes },
        metadata: { reason: controlledOverride.reason, reference: `${ADJUSTMENT_SOURCE}:${posted.sourceId}`, actorTenantId: input.actorTenantId ?? null },
      })
      await flagException({
        tenantId,
        kind: 'fixed_asset_gl_mismatch',
        severity: 'high',
        title: `Fixed-asset account ${touchedCodes.join(', ')} posted from a bank-line adjustment`,
        description: `A bank-statement adjustment posted to the fixed-asset register's account(s) ${touchedCodes.join(', ')} outside Fixed assets / CapEx. `
          + `Reason given: ${controlledOverride.reason.slice(0, 300)}. Check the register still agrees with the ledger.`,
        entityType: 'BankStatementLine',
        entityId: line.id,
        actorId: input.postedById,
        amountCents: abs,
        metadata: { entryId: posted.entryId, codes: touchedCodes, reason: controlledOverride.reason },
      })
    }
  }

  return { ok: true, ...(posted.settlementId && { cardSettlementId: posted.settlementId }) }
}

// Undo a GENERIC match (S3): the line goes back to 'unmatched' and its
// journal line is free again. A line matched to a Raast receipt is undone on
// the Raast tab (POST /reconciliation/raast/receipts/:id/unmatch), which puts
// the receipt back to provisional too — 409 RAAST_MATCHED_LINE here. A card
// payout (H12) is undone on the Card payouts tab, which reverses its entry and
// frees its card days — 409 CARD_PAYOUT_LINE here.
export async function unmatchStatementLine(lineId: string): Promise<{ before: { matchStatus: string; matchedJournalLineId: string | null; notes: string | null } }> {
  return prisma.$transaction(async (tx) => {
    const line = await tx.bankStatementLine.findUnique({
      where: { id: lineId },
      select: { id: true, matchStatus: true, matchedJournalLineId: true, notes: true, raastReceipt: { select: { id: true } } },
    })
    if (!line) throw new NotFoundError('BankStatementLine', lineId)
    if (line.raastReceipt) {
      throw new AppError('RAAST_MATCHED_LINE', 'This line is matched to a Raast payment — unmatch it on the Raast tab', 409, { receiptId: line.raastReceipt.id })
    }
    const card = await tx.cardSettlement.findFirst({ where: { statementLineId: line.id }, select: { id: true } })
    if (card) {
      throw new AppError('CARD_PAYOUT_LINE', 'This line is a card payout — undo it on the Card payouts tab (its entry is reversed and its card days freed)', 409, { settlementId: card.id })
    }
    if (line.matchStatus !== 'matched') throw new AppError('LINE_NOT_MATCHED', `Line is ${line.matchStatus}, not matched`, 409)
    const r = await tx.bankStatementLine.updateMany({
      where: { id: line.id, matchStatus: 'matched' },
      data: { matchStatus: 'unmatched', matchedJournalLineId: null, notes: null },
    })
    if (r.count === 0) throw new AppError('LINE_NOT_MATCHED', 'Line was already unmatched', 409)
    return { before: { matchStatus: line.matchStatus, matchedJournalLineId: line.matchedJournalLineId, notes: line.notes } }
  })
}
