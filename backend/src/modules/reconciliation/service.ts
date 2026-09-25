// Reconciliation service.
//
// Bank/gateway statement reconciliation — operator pastes CSV; we parse,
// auto-match against journal lines, and surface unmatched rows for the
// operator to investigate / book as adjustment journal entries.

import { prisma } from '../../lib/prisma.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { postJournalEntry } from '../accounting/journal.js'

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

    out.push({
      postedDate: parsed,
      description: desc,
      reference: refIdx >= 0 ? (cols[refIdx]?.trim() || null) : null,
      amountCents: Math.round(amount * 100),
    })
  }
  return out
}

// ─── Import + auto-match ────────────────────────────────────────────────────
// Heuristic: a statement line matches a journal line if, within a 3-day
// window, signed amounts equal AND the journal-line account is the one the
// statement is reconciling against. Auto-matched lines flip to `matched`;
// the rest stay `unmatched` for the operator.

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

  return prisma.$transaction(async (tx) => {
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

    // Pull candidate journal lines for the reconciling account in a wide window
    const minDate = new Date(parsed.reduce((m, l) => Math.min(m, l.postedDate.getTime()), Infinity) - MATCH_WINDOW_DAYS * 86400_000)
    const maxDate = new Date(parsed.reduce((m, l) => Math.max(m, l.postedDate.getTime()), -Infinity) + MATCH_WINDOW_DAYS * 86400_000)

    const candidates = await tx.journalLine.findMany({
      where: {
        accountId: account.id,
        journalEntry: { entryDate: { gte: minDate, lte: maxDate } },
      },
      include: { journalEntry: { select: { entryDate: true } } },
    })

    // Lock out journal lines that ANY prior BankStatementLine already matched.
    // Without this, re-importing the same statement (or overlapping windows)
    // produces two BankStatementLine rows pointing at the same JournalLine —
    // breaking the audit trail and double-counting reconciliations.
    const alreadyMatched = await tx.bankStatementLine.findMany({
      where: { matchStatus: 'matched', matchedJournalLineId: { not: null } },
      select: { matchedJournalLineId: true },
    })
    const consumed = new Set<string>(
      alreadyMatched.map((m) => m.matchedJournalLineId).filter((x): x is string => x !== null),
    )

    // Index candidates by signed amount → list of (lineId, date)
    const byAmount = new Map<number, Array<{ id: string; date: Date }>>()
    for (const c of candidates) {
      if (consumed.has(c.id)) continue   // already matched in a prior import
      const signed = c.type === 'debit' ? c.amountCents : -c.amountCents
      const arr = byAmount.get(signed) ?? []
      arr.push({ id: c.id, date: c.journalEntry.entryDate })
      byAmount.set(signed, arr)
    }

    let matchedCount = 0
    for (const line of parsed) {
      const candidates = byAmount.get(line.amountCents) ?? []
      const fit = candidates.find(
        (c) => !consumed.has(c.id) && Math.abs(c.date.getTime() - line.postedDate.getTime()) <= MATCH_WINDOW_DAYS * 86400_000,
      )
      const matchedJournalLineId = fit?.id ?? null
      if (fit) {
        consumed.add(fit.id)
        matchedCount++
      }

      await tx.bankStatementLine.create({
        data: {
          importId: importRow.id,
          postedDate: line.postedDate,
          description: line.description,
          reference: line.reference,
          amountCents: line.amountCents,
          matchStatus: matchedJournalLineId ? 'matched' : 'unmatched',
          matchedJournalLineId,
        },
      })
    }

    return { importId: importRow.id, totalRows: parsed.length, matchedCount, unmatchedCount: parsed.length - matchedCount }
  })
}

// Operator decision on an unmatched line: book it as an adjustment JE.
// The other side of the entry is whatever account the operator picks
// (e.g. bank fee → 6080, owner draw → 3030).
export async function adjustStatementLine(input: {
  lineId: string
  contraAccountCode: string
  memo: string
  postedById: string
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
  const isInflow = line.amountCents > 0
  const abs = Math.abs(line.amountCents)

  await postJournalEntry({
    tenantId,
    sourceType: 'reconciliation.adjustment',
    sourceId: line.id,
    description: `Adjustment: ${line.description} (${input.memo})`,
    entryDate: line.postedDate,
    postedBy: input.postedById,
    reference: line.reference ?? undefined,
    lines: [
      {
        accountCode: line.import.accountCode,
        type: isInflow ? 'debit' : 'credit',
        amountCents: abs,
        memo: line.description,
      },
      {
        accountCode: input.contraAccountCode,
        type: isInflow ? 'credit' : 'debit',
        amountCents: abs,
        memo: input.memo,
      },
    ],
  })

  await prisma.bankStatementLine.update({
    where: { id: line.id },
    data: { matchStatus: 'adjusted', notes: input.memo },
  })

  return { ok: true }
}

