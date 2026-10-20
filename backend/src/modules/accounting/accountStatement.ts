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

import { prisma } from '../../lib/prisma.js'
import { NotFoundError } from '../../lib/errors.js'
import { sumCents, toCents } from '../../lib/money.js'
import { fmtPktDate } from './dates.js'

/** Lines in one statement at most — beyond it the caller narrows the dates. */
export const STATEMENT_MAX_LINES = 20_000

export interface AccountStatementLine {
  date: string
  entryId: string
  description: string
  reference: string | null
  memo: string | null
  debitCents: number
  creditCents: number
  balanceCents: number
}

export interface AccountStatement {
  account: { id: string; code: string; name: string; type: string; normal: 'debit' | 'credit'; companyName: string | null }
  dateFrom: string
  dateTo: string
  openingCents: number
  closingCents: number
  totals: { debitCents: number; creditCents: number }
  lines: AccountStatementLine[]
  truncated: boolean
  /** The flat rows the exports print: opening, every line, totals, closing. */
  rows: Array<{ date: string; description: string; reference: string | null; memo: string | null; debitCents: number; creditCents: number; balanceCents: number }>
}

export async function accountStatement(tenantIds: string[], accountId: string, from: Date, to: Date): Promise<AccountStatement> {
  const account = await prisma.account.findFirst({
    where: { id: accountId, tenantId: { in: tenantIds } },
    select: { id: true, code: true, name: true, type: true, tenant: { select: { name: true } } },
  })
  if (!account) throw new NotFoundError('Account', accountId)
  const normal: 'debit' | 'credit' = account.type === 'asset' || account.type === 'expense' ? 'debit' : 'credit'
  const sign = (type: 'debit' | 'credit') => (type === normal ? 1 : -1)

  const before = await prisma.journalLine.groupBy({
    by: ['type'],
    where: { accountId: account.id, journalEntry: { entryDate: { lt: from } } },
    _sum: { amountCents: true },
  })
  const openingCents = before.reduce((s, g) => s + sign(g.type) * sumCents(g._sum.amountCents), 0)

  const raw = await prisma.journalLine.findMany({
    where: { accountId: account.id, journalEntry: { entryDate: { gte: from, lte: to } } },
    select: {
      id: true, type: true, amountCents: true, memo: true,
      journalEntry: { select: { id: true, entryDate: true, description: true, reference: true, createdAt: true } },
    },
    orderBy: [{ journalEntry: { entryDate: 'asc' } }, { journalEntry: { createdAt: 'asc' } }, { id: 'asc' }],
    take: STATEMENT_MAX_LINES + 1,
  })
  const truncated = raw.length > STATEMENT_MAX_LINES
  if (truncated) raw.pop()

  let bal = openingCents
  let dr = 0
  let cr = 0
  const lines: AccountStatementLine[] = raw.map((l) => {
    const amt = toCents(l.amountCents)
    if (l.type === 'debit') dr += amt; else cr += amt
    bal += sign(l.type) * amt
    return {
      date: fmtPktDate(l.journalEntry.entryDate),
      entryId: l.journalEntry.id,
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
  const rows = [
    { date: dateFrom, description: 'OPENING BALANCE', reference: null, memo: null, debitCents: 0, creditCents: 0, balanceCents: openingCents },
    ...lines.map((l) => ({ date: l.date, description: l.description, reference: l.reference, memo: l.memo, debitCents: l.debitCents, creditCents: l.creditCents, balanceCents: l.balanceCents })),
    { date: '', description: 'TOTAL MOVEMENT', reference: null, memo: null, debitCents: dr, creditCents: cr, balanceCents: bal - openingCents },
    { date: dateTo, description: 'CLOSING BALANCE', reference: null, memo: null, debitCents: 0, creditCents: 0, balanceCents: bal },
  ]
  return {
    account: { id: account.id, code: account.code, name: account.name, type: account.type, normal, companyName: account.tenant?.name ?? null },
    dateFrom, dateTo, openingCents, closingCents: bal, totals: { debitCents: dr, creditCents: cr }, lines, truncated, rows,
  }
}
