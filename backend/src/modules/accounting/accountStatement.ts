// The general-ledger ACCOUNT STATEMENT (owner, 2026-10-20): one account's
// lines between two dates — opening balance, each line with a running
// balance, closing balance. Read through GET /accounting/ledger
// ?accountId=&view=statement (the ledger's own route, viewers and company
// scope; ?format=csv|xlsx|pdf exports it through lib/reportExport.ts).
//
// The account must belong to a company in the caller's scope (another
// company's account is 404 — never trust a client id). Balances are in the
// account's natural direction: debit-normal for assets and expenses,
// credit-normal for liabilities, equity and revenue. Read only.
//
// The Journals tab's "Accounts" view (owner, 2026-10-23) is THIS statement:
// optional brand filter (conceptId — lines tagged to that brand only, opening
// included), optional paging (limit + cursor; the first page starts from the
// opening balance, each next page from the running balance where the last one
// stopped — `pageOpeningCents`), and the route puts each line's entry status and
// Edit / Cancel rights on it (journalsRegister.ts annotateEntries).

import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { sumCents, toCents } from '../../lib/money.js'
import { fmtPktDate } from './dates.js'

/** Lines in one statement at most — beyond it the caller narrows the dates. */
export const STATEMENT_MAX_LINES = 20_000

export interface AccountStatementLine {
  date: string
  lineId: string
  entryId: string
  conceptId: string | null
  description: string
  reference: string | null
  memo: string | null
  debitCents: number
  creditCents: number
  balanceCents: number
}

/** One sub-account's movement in the range (owner, 2026-10-23); the 'Unassigned' row (id null) makes them tie to the account. */
export interface SubAccountSummaryRow {
  id: string | null
  name: string
  code: string | null
  kind: string | null
  employeeId: string | null
  isActive: boolean
  openingCents: number
  debitCents: number
  creditCents: number
  closingCents: number
}

export interface AccountStatement {
  /** The account's sub-ledger in the range (+ Unassigned); empty when the account has no sub-accounts. */
  subAccounts: SubAccountSummaryRow[]
  /** Set when the statement is of ONE sub-account (?subAccountId). */
  subAccount: { id: string; name: string; code: string | null; kind: string; employeeId: string | null; isActive: boolean } | null
  account: { id: string; code: string; name: string; type: string; normal: 'debit' | 'credit'; companyName: string | null }
  dateFrom: string
  dateTo: string
  openingCents: number
  closingCents: number
  totals: { debitCents: number; creditCents: number }
  lines: AccountStatementLine[]
  truncated: boolean
  /** Paged reads: the running balance before this page's first line (= openingCents on the first page). */
  pageOpeningCents: number
  nextCursor: string | null
  hasMore: boolean
  /** The flat rows the exports print: opening, every line, totals, closing. */
  rows: Array<{ date: string; description: string; reference: string | null; memo: string | null; debitCents: number; creditCents: number; balanceCents: number }>
}

export interface StatementOptions {
  /** Only lines tagged to this brand (the brand must be of the account's company, else 404). */
  conceptId?: string | null
  /** Page size (≤ 1,000); omitted = the whole window up to STATEMENT_MAX_LINES (what the exports use). */
  limit?: number
  cursor?: string | null
  /** One sub-account's own statement (its tagged amounts only; the whole window, no paging). Another account's → 404. */
  subAccountId?: string | null
}

/**
 * Each sub-account of the account: opening (before `from`), debits, credits
 * and closing in [from, to] in the account's natural direction, from its tags
 * (journal_line_sub_accounts), plus 'Unassigned' = the account's own figures
 * less the sub-accounts', so the rows always add up to the account.
 */
export async function subAccountSummary(
  account: { id: string; normal: 'debit' | 'credit' }, from: Date, to: Date, conceptId: string | null,
  totals: { openingCents: number; debitCents: number; creditCents: number },
): Promise<SubAccountSummaryRow[]> {
  const subs = await prisma.subAccount.findMany({ where: { accountId: account.id }, orderBy: [{ isActive: 'desc' }, { name: 'asc' }] })
  if (subs.length === 0) return []
  const brand = conceptId ? Prisma.sql`AND l."conceptId" = ${conceptId}` : Prisma.empty
  const agg = await prisma.$queryRaw<Array<{ id: string; before: bigint | number; dr: bigint | number; cr: bigint | number }>>`
    SELECT t."subAccountId" AS id,
           COALESCE(SUM(CASE WHEN e."entryDate" < ${from} THEN (CASE WHEN l.type = 'debit' THEN t."amountCents" ELSE -t."amountCents" END) ELSE 0 END), 0)::bigint AS before,
           COALESCE(SUM(CASE WHEN e."entryDate" >= ${from} AND l.type = 'debit'  THEN t."amountCents" ELSE 0 END), 0)::bigint AS dr,
           COALESCE(SUM(CASE WHEN e."entryDate" >= ${from} AND l.type = 'credit' THEN t."amountCents" ELSE 0 END), 0)::bigint AS cr
      FROM journal_line_sub_accounts t
      JOIN journal_lines l ON l.id = t."journalLineId"
      JOIN journal_entries e ON e.id = l."journalEntryId"
     WHERE l."accountId" = ${account.id} AND e."entryDate" <= ${to} ${brand}
     GROUP BY t."subAccountId"`
  const by = new Map(agg.map((a) => [a.id, { before: toCents(a.before), dr: toCents(a.dr), cr: toCents(a.cr) }]))
  const sign = account.normal === 'debit' ? 1 : -1
  const rows: SubAccountSummaryRow[] = subs.map((s) => {
    const a = by.get(s.id) ?? { before: 0, dr: 0, cr: 0 }
    const openingCents = sign * a.before
    return {
      id: s.id, name: s.name, code: s.code, kind: s.kind, employeeId: s.employeeId, isActive: s.isActive,
      openingCents, debitCents: a.dr, creditCents: a.cr, closingCents: openingCents + sign * (a.dr - a.cr),
    }
  })
  const sum = (k: 'openingCents' | 'debitCents' | 'creditCents') => rows.reduce((t, r) => t + r[k], 0)
  const uo = totals.openingCents - sum('openingCents')
  const ud = totals.debitCents - sum('debitCents')
  const uc = totals.creditCents - sum('creditCents')
  rows.push({ id: null, name: 'Unassigned', code: null, kind: null, employeeId: null, isActive: true, openingCents: uo, debitCents: ud, creditCents: uc, closingCents: uo + sign * (ud - uc) })
  return rows
}

function encodeStatementCursor(l: { id: string; journalEntry: { entryDate: Date; createdAt: Date } }): string {
  return Buffer.from(`${l.journalEntry.entryDate.toISOString()}|${l.journalEntry.createdAt.toISOString()}|${l.id}`).toString('base64url')
}
function decodeStatementCursor(c: string): { d: Date; c: Date; id: string } {
  const [a, b, id] = Buffer.from(c, 'base64url').toString().split('|')
  const d = new Date(a ?? ''); const cr = new Date(b ?? '')
  if (!id || Number.isNaN(d.getTime()) || Number.isNaN(cr.getTime())) throw new AppError('INVALID_CURSOR', 'The page cursor is not valid — start from the first page', 400)
  return { d, c: cr, id }
}

export async function accountStatement(tenantIds: string[], accountId: string, from: Date, to: Date, opts: StatementOptions = {}): Promise<AccountStatement> {
  const account = await prisma.account.findFirst({
    where: { id: accountId, tenantId: { in: tenantIds } },
    select: { id: true, code: true, name: true, type: true, tenantId: true, subAccountsEnabled: true, tenant: { select: { name: true } } },
  })
  if (!account) throw new NotFoundError('Account', accountId)
  const normal: 'debit' | 'credit' = account.type === 'asset' || account.type === 'expense' ? 'debit' : 'credit'
  const sign = (type: 'debit' | 'credit') => (type === normal ? 1 : -1)

  if (opts.conceptId) {
    const own = await prisma.concept.count({ where: { id: opts.conceptId, tenantId: account.tenantId ?? '__none__' } })
    if (!own) throw new NotFoundError('Concept', opts.conceptId)
  }
  if (opts.subAccountId) return subAccountStatement(account, normal, from, to, opts.subAccountId, opts.conceptId ?? null)
  const brand: Prisma.JournalLineWhereInput = opts.conceptId ? { conceptId: opts.conceptId } : {}
  const sumBy = async (where: Prisma.JournalLineWhereInput) => {
    const g = await prisma.journalLine.groupBy({ by: ['type'], where: { accountId: account.id, ...brand, ...where }, _sum: { amountCents: true } })
    const dr = sumCents(g.find((x) => x.type === 'debit')?._sum.amountCents ?? 0)
    const cr = sumCents(g.find((x) => x.type === 'credit')?._sum.amountCents ?? 0)
    return { dr, cr, net: (normal === 'debit' ? 1 : -1) * (dr - cr) }
  }
  const openingCents = (await sumBy({ journalEntry: { entryDate: { lt: from } } })).net
  const inWindow: Prisma.JournalLineWhereInput = { journalEntry: { entryDate: { gte: from, lte: to } } }
  // The window's totals, whatever page is read.
  const win = await sumBy(inWindow)

  const paged = opts.limit !== undefined
  const take = paged ? Math.min(Math.max(opts.limit!, 1), 1000) : STATEMENT_MAX_LINES
  let pageOpeningCents = openingCents
  let after: Prisma.JournalLineWhereInput = {}
  if (opts.cursor) {
    const c = decodeStatementCursor(opts.cursor)
    after = { OR: [
      { journalEntry: { entryDate: { gt: c.d } } },
      { journalEntry: { entryDate: c.d, createdAt: { gt: c.c } } },
      { journalEntry: { entryDate: c.d, createdAt: c.c }, id: { gt: c.id } },
    ] }
    const upTo = await sumBy({ AND: [inWindow, { OR: [
      { journalEntry: { entryDate: { lt: c.d } } },
      { journalEntry: { entryDate: c.d, createdAt: { lt: c.c } } },
      { journalEntry: { entryDate: c.d, createdAt: c.c }, id: { lte: c.id } },
    ] }] })
    pageOpeningCents = openingCents + upTo.net
  }

  const raw = await prisma.journalLine.findMany({
    where: { accountId: account.id, ...brand, AND: [inWindow, after] },
    select: {
      id: true, type: true, amountCents: true, memo: true, conceptId: true,
      journalEntry: { select: { id: true, entryDate: true, description: true, reference: true, createdAt: true } },
    },
    orderBy: [{ journalEntry: { entryDate: 'asc' } }, { journalEntry: { createdAt: 'asc' } }, { id: 'asc' }],
    take: take + 1,
  })
  const more = raw.length > take
  if (more) raw.pop()
  const truncated = !paged && more
  const hasMore = paged && more
  const lastRaw = raw[raw.length - 1]

  let bal = pageOpeningCents
  let dr = 0
  let cr = 0
  const lines: AccountStatementLine[] = raw.map((l) => {
    const amt = toCents(l.amountCents)
    if (l.type === 'debit') dr += amt; else cr += amt
    bal += sign(l.type) * amt
    return {
      date: fmtPktDate(l.journalEntry.entryDate),
      lineId: l.id,
      entryId: l.journalEntry.id,
      conceptId: l.conceptId,
      description: l.journalEntry.description,
      reference: l.journalEntry.reference,
      memo: l.memo,
      debitCents: l.type === 'debit' ? amt : 0,
      creditCents: l.type === 'credit' ? amt : 0,
      balanceCents: bal,
    }
  })
  const dateFrom = fmtPktDate(from)
  const dateTo = fmtPktDate(to)
  // Unpaged and complete: the totals are the lines'. Paged or truncated: the window's (so closing is the real one).
  if (paged || truncated) { dr = win.dr; cr = win.cr; bal = openingCents + win.net }
  const rows = [
    { date: dateFrom, description: 'OPENING BALANCE', reference: null, memo: null, debitCents: 0, creditCents: 0, balanceCents: openingCents },
    ...lines.map((l) => ({ date: l.date, description: l.description, reference: l.reference, memo: l.memo, debitCents: l.debitCents, creditCents: l.creditCents, balanceCents: l.balanceCents })),
    { date: '', description: 'TOTAL MOVEMENT', reference: null, memo: null, debitCents: dr, creditCents: cr, balanceCents: bal - openingCents },
    { date: dateTo, description: 'CLOSING BALANCE', reference: null, memo: null, debitCents: 0, creditCents: 0, balanceCents: bal },
  ]
  return {
    account: { id: account.id, code: account.code, name: account.name, type: account.type, normal, companyName: account.tenant?.name ?? null },
    dateFrom, dateTo, openingCents, closingCents: bal, totals: { debitCents: dr, creditCents: cr }, lines, truncated, rows,
    pageOpeningCents, nextCursor: hasMore && lastRaw ? encodeStatementCursor(lastRaw) : null, hasMore,
    // Only while the account's sub-accounts are switched on (owner, 2026-10-23); tags stay as history.
    subAccounts: account.subAccountsEnabled
      ? await subAccountSummary({ id: account.id, normal }, from, to, opts.conceptId ?? null, { openingCents, debitCents: win.dr, creditCents: win.cr })
      : [],
    subAccount: null,
  }
}

/** ONE sub-account's statement: its tagged amounts (a line's tag, on the line's side), running balance. */
async function subAccountStatement(
  account: { id: string; code: string; name: string; type: string; tenant: { name: string } | null },
  normal: 'debit' | 'credit', from: Date, to: Date, subAccountId: string, conceptId: string | null,
): Promise<AccountStatement> {
  const sa = await prisma.subAccount.findFirst({ where: { id: subAccountId, accountId: account.id } })
  if (!sa) throw new NotFoundError('SubAccount', subAccountId)
  const sign = (type: 'debit' | 'credit') => (type === normal ? 1 : -1)
  const brand: Prisma.JournalLineWhereInput = conceptId ? { conceptId } : {}
  const before = await prisma.journalLineSubAccount.findMany({
    where: { subAccountId: sa.id, line: { ...brand, journalEntry: { entryDate: { lt: from } } } },
    select: { amountCents: true, line: { select: { type: true } } },
  })
  const openingCents = before.reduce((t, a) => t + sign(a.line.type) * toCents(a.amountCents), 0)
  const raw = await prisma.journalLineSubAccount.findMany({
    where: { subAccountId: sa.id, line: { ...brand, journalEntry: { entryDate: { gte: from, lte: to } } } },
    select: {
      amountCents: true,
      line: { select: { id: true, type: true, memo: true, conceptId: true, journalEntry: { select: { id: true, entryDate: true, description: true, reference: true, createdAt: true } } } },
    },
    orderBy: [{ line: { journalEntry: { entryDate: 'asc' } } }, { line: { journalEntry: { createdAt: 'asc' } } }, { journalLineId: 'asc' }],
    take: STATEMENT_MAX_LINES + 1,
  })
  const truncated = raw.length > STATEMENT_MAX_LINES
  if (truncated) raw.pop()
  let bal = openingCents, dr = 0, cr = 0
  const lines: AccountStatementLine[] = raw.map((a) => {
    const amt = toCents(a.amountCents)
    const l = a.line
    if (l.type === 'debit') dr += amt; else cr += amt
    bal += sign(l.type) * amt
    return {
      date: fmtPktDate(l.journalEntry.entryDate), lineId: l.id, entryId: l.journalEntry.id, conceptId: l.conceptId,
      description: l.journalEntry.description, reference: l.journalEntry.reference, memo: l.memo,
      debitCents: l.type === 'debit' ? amt : 0, creditCents: l.type === 'credit' ? amt : 0, balanceCents: bal,
    }
  })
  const dateFrom = fmtPktDate(from), dateTo = fmtPktDate(to)
  const rows = [
    { date: dateFrom, description: 'OPENING BALANCE', reference: null, memo: null, debitCents: 0, creditCents: 0, balanceCents: openingCents },
    ...lines.map((l) => ({ date: l.date, description: l.description, reference: l.reference, memo: l.memo, debitCents: l.debitCents, creditCents: l.creditCents, balanceCents: l.balanceCents })),
    { date: '', description: 'TOTAL MOVEMENT', reference: null, memo: null, debitCents: dr, creditCents: cr, balanceCents: bal - openingCents },
    { date: dateTo, description: 'CLOSING BALANCE', reference: null, memo: null, debitCents: 0, creditCents: 0, balanceCents: bal },
  ]
  return {
    account: { id: account.id, code: account.code, name: account.name, type: account.type, normal, companyName: account.tenant?.name ?? null },
    dateFrom, dateTo, openingCents, closingCents: bal, totals: { debitCents: dr, creditCents: cr }, lines, truncated, rows,
    pageOpeningCents: openingCents, nextCursor: null, hasMore: false, subAccounts: [],
    subAccount: { id: sa.id, name: sa.name, code: sa.code, kind: sa.kind, employeeId: sa.employeeId, isActive: sa.isActive },
  }
}
