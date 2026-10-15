// Head office (D1) — reconciliation and visibility of a head-office pair
// (spec §4.8 as amended by A1.4: the pair's Due from / Due to are the
// inter-company pair accounts, so the pair tie-out, the intercompany_mismatch
// flag and the inter-company close checks already cover them; this file adds
// the run invariants and the pair statement).
//
// Invariants of a run (runInvariants):
//   1. Σ lines + retained = base, and rechargedCents = Σ lines;
//   2. every line of a posted run has a POSTED transfer, source 'ho_recharge',
//      sourceRef 'ho_recharge:<lineId>', amount |A|, the company the debtor
//      when A > 0 (the head office when A < 0), with an entry in each book;
//   3. every line of a reversed run has its transfer reversed;
//   4. each pair it touched agrees across the two books (pairBalances).
//
// Who sees what (A5 — a deliberate crossing like FleetAgreement, explicitly
// filtered, read on serviceClient): a member of the head office sees every
// pair of it; a member of a company sees its own pairs only (both balances,
// its statement, its run lines and the run basis). Nothing else of the other
// side's books.

import type { Prisma, PrismaClient } from '@prisma/client'
import { serviceClient } from '../../lib/prisma.js'
import { toCents } from '../../lib/money.js'
import { IC_CONTROLLED_BY, pairBalances, sideBalances } from '../intercompany/accounts.js'
import { HO_RECHARGE_SOURCE, lineSourceRef, loadRun } from './runs.js'

export type Db = Prisma.TransactionClient | PrismaClient

// ─── Run invariants ──────────────────────────────────────────────────────────

export interface InvariantResult { runId: string; ok: boolean; problems: string[] }

export async function runInvariants(runId: string, db: Db = serviceClient): Promise<InvariantResult> {
  const run = await loadRun(db, runId)
  if (!run) return { runId, ok: false, problems: ['run not found'] }
  const problems: string[] = []
  const sumLines = run.lines.reduce((s, l) => s + toCents(l.amountCents), 0)
  if (sumLines !== toCents(run.rechargedCents)) problems.push(`recharged ${toCents(run.rechargedCents)} ≠ Σ lines ${sumLines}`)
  if (sumLines + toCents(run.retainedCents) !== toCents(run.baseCents)) {
    problems.push(`Σ lines ${sumLines} + retained ${toCents(run.retainedCents)} ≠ base ${toCents(run.baseCents)}`)
  }
  if (run.status === 'posted' || run.status === 'reversed') {
    for (const l of run.lines) {
      const a = toCents(l.amountCents)
      if (a === 0) continue
      if (!l.transferId) { problems.push(`line ${l.id}: no transfer`); continue }
      const t = await db.intercompanyTransfer.findUnique({ where: { id: l.transferId } })
      if (!t) { problems.push(`line ${l.id}: transfer ${l.transferId} missing`); continue }
      const wantStatus = run.status === 'posted' ? 'posted' : 'reversed'
      if (t.status !== wantStatus) problems.push(`line ${l.id}: transfer is ${t.status}, expected ${wantStatus}`)
      if (t.source !== HO_RECHARGE_SOURCE) problems.push(`line ${l.id}: transfer source ${t.source}`)
      const ref = lineSourceRef(l.id)
      if (t.sourceRef !== ref && !(t.sourceRef ?? '').startsWith(`${ref}#reversed:`)) problems.push(`line ${l.id}: transfer sourceRef ${t.sourceRef}`)
      if (toCents(t.amountCents) !== Math.abs(a)) problems.push(`line ${l.id}: transfer amount ${toCents(t.amountCents)} ≠ |${a}|`)
      const debtor = a > 0 ? l.companyTenantId : run.tenantId
      const creditor = a > 0 ? run.tenantId : l.companyTenantId
      if (t.tenantId !== debtor || t.counterpartyTenantId !== creditor) problems.push(`line ${l.id}: transfer direction is wrong`)
      for (const [entryId, tenantId] of [[t.debtorEntryId, debtor], [t.creditorEntryId, creditor]] as const) {
        if (!entryId) { problems.push(`line ${l.id}: an entry is missing`); continue }
        const e = await db.journalEntry.findUnique({ where: { id: entryId }, select: { tenantId: true, lines: { select: { type: true, amountCents: true } } } })
        if (!e || e.tenantId !== tenantId) { problems.push(`line ${l.id}: entry ${entryId} is not in the right book`); continue }
        const dr = e.lines.filter((x) => x.type === 'debit').reduce((s, x) => s + toCents(x.amountCents), 0)
        const cr = e.lines.filter((x) => x.type === 'credit').reduce((s, x) => s + toCents(x.amountCents), 0)
        if (dr !== cr || dr !== Math.abs(a)) problems.push(`line ${l.id}: entry ${entryId} is ${dr}/${cr}, expected ${Math.abs(a)}`)
      }
      const pb = await pairBalances(db, run.tenantId, l.companyTenantId)
      if (pb.mismatchCents !== 0) problems.push(`pair with ${l.companyTenantId}: books disagree by ${pb.mismatchCents}`)
    }
  }
  return { runId, ok: problems.length === 0, problems }
}

// ─── The pair statement ──────────────────────────────────────────────────────

export type StatementCategory = 'charges' | 'settlements' | 'adjustments' | 'other'

export interface StatementRow {
  date: string
  reference: string | null
  transferId: string | null
  category: StatementCategory
  reversal: boolean
  description: string
  /** Movement in what the company owes the head office (by the head office's books): + = owes more. */
  cents: number
}

export interface HeadOfficeStatement {
  headOfficeId: string
  companyId: string
  from: string
  to: string
  /** What the company owes the head office at the start (head office's books; negative = the head office owes). */
  openingCents: number
  chargesCents: number
  settlementsCents: number
  adjustmentsCents: number
  /** Lines on the pair accounts with no inter-company reference (should be none). */
  otherCents: number
  closingCents: number
  /** The same balance by the company's books at `to`, and the difference (0 = agree). */
  companyClosingCents: number
  differenceCents: number
  rows: StatementRow[]
}

const TRANSFER_REF = /^ic\.transfer(\.reversal)?:(.+)$/

/**
 * Opening, charges, settlements, adjustments and closing of one head office ↔
 * company pair between two instants (inclusive), from the head office's pair
 * accounts; the closing is compared with the company's own books. The caller
 * has checked who may see the pair.
 */
export async function headOfficeStatement(db: Db, hoId: string, companyId: string, from: Date, to: Date): Promise<HeadOfficeStatement> {
  const opening = await sideBalances(db, hoId, companyId, new Date(from.getTime() - 1))
  const accounts = await db.account.findMany({
    where: { tenantId: hoId, controlledBy: IC_CONTROLLED_BY, counterpartyTenantId: companyId },
    select: { id: true },
  })
  const lines = accounts.length
    ? await db.journalLine.findMany({
      where: { accountId: { in: accounts.map((a) => a.id) }, journalEntry: { tenantId: hoId, entryDate: { gte: from, lte: to } } },
      select: { type: true, amountCents: true, journalEntry: { select: { id: true, reference: true, entryDate: true, description: true } } },
      orderBy: [{ journalEntry: { entryDate: 'asc' } }, { journalEntry: { createdAt: 'asc' } }],
    })
    : []
  const transferIds = [...new Set(lines.map((l) => TRANSFER_REF.exec(l.journalEntry.reference ?? '')?.[2]).filter((x): x is string => !!x))]
  const transfers = transferIds.length
    ? await db.intercompanyTransfer.findMany({ where: { id: { in: transferIds } }, select: { id: true, kind: true, source: true } })
    : []
  const tById = new Map(transfers.map((t) => [t.id, t]))

  const byEntry = new Map<string, StatementRow>()
  for (const l of lines) {
    const e = l.journalEntry
    const m = TRANSFER_REF.exec(e.reference ?? '')
    const t = m ? tById.get(m[2]!) : undefined
    const category: StatementCategory = !t ? 'other' : t.source === HO_RECHARGE_SOURCE ? 'charges' : t.kind === 'settlement' ? 'settlements' : 'adjustments'
    const delta = (l.type === 'debit' ? 1 : -1) * toCents(l.amountCents)
    const row = byEntry.get(e.id) ?? {
      date: e.entryDate.toISOString(), reference: e.reference, transferId: t?.id ?? null, category,
      reversal: !!m?.[1], description: e.description, cents: 0,
    }
    row.cents += delta
    byEntry.set(e.id, row)
  }
  const rows = [...byEntry.values()]
  const total = (c: StatementCategory) => rows.filter((r) => r.category === c).reduce((s, r) => s + r.cents, 0)
  const openingCents = opening.dueFrom - opening.dueTo
  const chargesCents = total('charges')
  const settlementsCents = total('settlements')
  const adjustmentsCents = total('adjustments')
  const otherCents = total('other')
  const closingCents = openingCents + chargesCents + settlementsCents + adjustmentsCents + otherCents
  const company = await sideBalances(db, companyId, hoId, to)
  const companyClosingCents = company.dueTo - company.dueFrom
  return {
    headOfficeId: hoId,
    companyId,
    from: from.toISOString(),
    to: to.toISOString(),
    openingCents,
    chargesCents,
    settlementsCents,
    adjustmentsCents,
    otherCents,
    closingCents,
    companyClosingCents,
    differenceCents: closingCents - companyClosingCents,
    rows,
  }
}

// ─── Who may see a pair ──────────────────────────────────────────────────────

/** A member of the head office sees all its pairs; a company member sees its own (a link, live or ended, must exist). */
export async function maySeePair(viewer: { memberTenantIds: string[] }, hoId: string, companyId: string, db: Db = serviceClient): Promise<boolean> {
  const members = new Set(viewer.memberTenantIds)
  if (!members.has(hoId) && !members.has(companyId)) return false
  const link = await db.headOfficeLink.findFirst({ where: { tenantId: hoId, companyTenantId: companyId }, select: { id: true } })
  return link !== null
}
