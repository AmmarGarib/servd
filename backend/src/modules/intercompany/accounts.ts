// Inter-company pair accounts (H30) — "Due from <company>" / "Due to <company>".
//
// Each pair of group companies that ever posts to each other gets, in EACH
// company's chart, created lazily on first posting:
//   • 'Due from <other>'  asset,     first free code 1450–1499
//   • 'Due to <other>'    liability, first free code 2150–2199
// with controlledBy 'intercompany' and counterpartyTenantId = the other
// company. journal.ts refuses any line on them unless the posting's
// sourceType starts 'ic.' (inter-company transfers and their reversals), so
// the two sides can only move together (intercompany/service.ts).
//
// The ranges are reserved in lib/chartOfAccounts.ts (never template codes); a
// code an operator already used is skipped. One Due-from and one Due-to per
// company per counterparty: the partial unique index accounts_ic_pair_side
// (SQL only) backs it, and the pair advisory lock below serialises creation.
//
// Balances are read by account (controlledBy + counterparty), never by code,
// so the code each company happened to get does not matter.

import type { Prisma, PrismaClient } from '@prisma/client'
import { AppError } from '../../lib/errors.js'
import { sumCents } from '../../lib/money.js'

export type Tx = Prisma.TransactionClient
export type Db = Prisma.TransactionClient | PrismaClient

/** Account.controlledBy of a pair account. */
export const IC_CONTROLLED_BY = 'intercompany'
/** Reserved code ranges (inclusive) — chartOfAccounts.ts header. */
export const IC_DUE_FROM_RANGE = { from: 1450, to: 1499 } as const
export const IC_DUE_TO_RANGE = { from: 2150, to: 2199 } as const

function codesIn(range: { from: number; to: number }): string[] {
  const out: string[] = []
  for (let c = range.from; c <= range.to; c++) out.push(String(c))
  return out
}

/** The pair's sorted key 'a:b' (min first) — used for the lock and for flags. */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`
}

/**
 * Serialise everything that touches one company pair (account creation, the
 * balance checks of settlements / netting, fleet charges) for the rest of the
 * transaction. Same key whichever side is named first.
 */
export async function lockPair(tx: Tx, a: string, b: string): Promise<void> {
  const key = `ic.pair:${pairKey(a, b)}`
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}::text))`
}

interface PairSide { dueFrom: string; dueTo: string }

/** One company's two accounts against `other`: reuse, reactivate, or create in the reserved ranges. */
async function ensureSide(tx: Tx, self: string, other: string, otherName: string): Promise<PairSide> {
  const existing = await tx.account.findMany({
    where: { tenantId: self, controlledBy: IC_CONTROLLED_BY, counterpartyTenantId: other },
    select: { id: true, code: true, type: true, isActive: true },
  })
  const description = `Inter-company with ${otherName}. Confirm with your CA.`
  const want = [
    { type: 'asset' as const, name: `Due from ${otherName}`, range: IC_DUE_FROM_RANGE },
    { type: 'liability' as const, name: `Due to ${otherName}`, range: IC_DUE_TO_RANGE },
  ]
  const out: Partial<PairSide> = {}
  for (const w of want) {
    let row = existing.find((e) => e.type === w.type)
    if (row && !row.isActive) {
      // A system account: it must stay usable while the pair has balances.
      // (Deactivating a controlled account is refused by the chart routes.)
      await tx.account.update({ where: { id: row.id }, data: { isActive: true } })
    }
    if (!row) {
      const range = codesIn(w.range)
      const used = new Set((await tx.account.findMany({
        where: { tenantId: self, code: { in: range } },
        select: { code: true },
      })).map((a) => a.code))
      const code = range.find((c) => !used.has(c))
      if (!code) {
        throw new AppError(
          'NO_FREE_IC_CODE',
          `No free code left in ${w.range.from}–${w.range.to} for '${w.name}' — free one in Configuration → Chart of accounts`,
          422,
        )
      }
      row = await tx.account.create({
        data: {
          tenantId: self, code, name: w.name, type: w.type, description,
          controlledBy: IC_CONTROLLED_BY, counterpartyTenantId: other,
        },
        select: { id: true, code: true, type: true, isActive: true },
      })
    }
    if (w.type === 'asset') out.dueFrom = row.code
    else out.dueTo = row.code
  }
  return out as PairSide
}

/**
 * Both companies' Due-from / Due-to accounts against each other, created on
 * first use under the pair lock. Returns the codes in each company's chart.
 */
export async function ensurePairAccounts(tx: Tx, a: string, b: string): Promise<{ aDueFrom: string; aDueTo: string; bDueFrom: string; bDueTo: string }> {
  if (!a || !b || a === b) throw new AppError('SAME_COMPANY', 'An inter-company account needs two different companies', 422)
  await lockPair(tx, a, b)
  const tenants = await tx.tenant.findMany({ where: { id: { in: [a, b] } }, select: { id: true, name: true } })
  const nameOf = new Map(tenants.map((t) => [t.id, t.name]))
  if (!nameOf.has(a) || !nameOf.has(b)) throw new AppError('COMPANY_NOT_FOUND', 'One of the two companies does not exist', 422)
  const sa = await ensureSide(tx, a, b, nameOf.get(b)!)
  const sb = await ensureSide(tx, b, a, nameOf.get(a)!)
  return { aDueFrom: sa.dueFrom, aDueTo: sa.dueTo, bDueFrom: sb.dueFrom, bDueTo: sb.dueTo }
}

/**
 * The balances of one company's pair accounts against `other` at `asOf`
 * (inclusive; omitted = everything posted): dueFrom as an asset (what
 * `other` owes this company, debits − credits) and dueTo as a liability
 * (what this company owes `other`, credits − debits). 0 when the accounts
 * do not exist yet.
 */
export async function sideBalances(db: Db, self: string, other: string, asOf?: Date): Promise<{ dueFrom: number; dueTo: number; dueFromCode: string | null; dueToCode: string | null }> {
  const accounts = await db.account.findMany({
    where: { tenantId: self, controlledBy: IC_CONTROLLED_BY, counterpartyTenantId: other },
    select: { id: true, code: true, type: true },
  })
  const out = { dueFrom: 0, dueTo: 0, dueFromCode: null as string | null, dueToCode: null as string | null }
  if (accounts.length === 0) return out
  const sums = await db.journalLine.groupBy({
    by: ['accountId', 'type'],
    where: {
      accountId: { in: accounts.map((x) => x.id) },
      journalEntry: { tenantId: self, ...(asOf && { entryDate: { lte: asOf } }) },
    },
    _sum: { amountCents: true },
  })
  for (const acc of accounts) {
    let dr = 0
    let cr = 0
    for (const s of sums) {
      if (s.accountId !== acc.id) continue
      if (s.type === 'debit') dr += sumCents(s._sum.amountCents)
      else cr += sumCents(s._sum.amountCents)
    }
    if (acc.type === 'asset') { out.dueFrom = dr - cr; out.dueFromCode = acc.code }
    else { out.dueTo = cr - dr; out.dueToCode = acc.code }
  }
  return out
}

export interface PairBalances {
  /** What b owes a, in a's books (a's Due from b). */
  aDueFromB: number
  /** What a owes b, in a's books (a's Due to b). */
  aDueToB: number
  /** What a owes b, in b's books (b's Due from a). */
  bDueFromA: number
  /** What b owes a, in b's books (b's Due to a). */
  bDueToA: number
  /** Net that a owes b by a's books (positive) — or b owes a (negative). */
  netOwedByA: number
  /** |a.dueTo(b) − b.dueFrom(a)| + |b.dueTo(a) − a.dueFrom(b)|: 0 when the two books agree. */
  mismatchCents: number
}

/** Both sides of a pair at `asOf`. Every inter-company posting moves both books, so mismatchCents is 0 unless something went wrong. */
export async function pairBalances(db: Db, a: string, b: string, asOf?: Date): Promise<PairBalances> {
  const [sa, sb] = await Promise.all([sideBalances(db, a, b, asOf), sideBalances(db, b, a, asOf)])
  return {
    aDueFromB: sa.dueFrom,
    aDueToB: sa.dueTo,
    bDueFromA: sb.dueFrom,
    bDueToA: sb.dueTo,
    netOwedByA: sa.dueTo - sa.dueFrom,
    mismatchCents: Math.abs(sa.dueTo - sb.dueFrom) + Math.abs(sb.dueTo - sa.dueFrom),
  }
}

/** Every company `self` has pair accounts against (the counterparties it has ever posted with). */
export async function counterpartiesOf(db: Db, self: string): Promise<string[]> {
  const rows = await db.account.findMany({
    where: { tenantId: self, controlledBy: IC_CONTROLLED_BY, counterpartyTenantId: { not: null } },
    select: { counterpartyTenantId: true },
  })
  return Array.from(new Set(rows.map((r) => r.counterpartyTenantId!).filter(Boolean)))
}
