// Head office (D1) — the CEO's % table ("split"), versioned by effective month.
//
// A version applies from its `effectiveFrom` month until the next version; the
// version for month M is the latest effectiveFrom ≤ M (`splitFor`). Each
// version is written whole and never edited: a change is a new version, and a
// version is deleted only while no recharge run references it.
//
// Rules (spec §0 / §4.2, amendments A1 and A11):
//   • every company in a version has a LIVE link to the head office
//     (422 COMPANY_NOT_LINKED);
//   • each share is 1..10000 basis points and the total ≤ 10000
//     (422 SPLIT_OVER_100) — anything below 100% stays with the head office
//     as its own cost;
//   • a version cannot start in a month that already has a submitted or
//     posted run, or any later month (409 SPLIT_PERIOD_IN_USE — withdraw or
//     reverse those runs first); draft runs from that month on are marked
//     stale (they must be refreshed);
//   • `splitByBps` is the ONE rounding rule: floor(|base| × bps / 10000) per
//     company; when the version totals exactly 100% the leftover paisa go to
//     the largest share (ties: the lowest company id), so the head office nets
//     to zero; below 100% the leftover stays with the head office.

import type { Prisma, PrismaClient } from '@prisma/client'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { liveLink } from '../../lib/headOffice.js'
import { assertMonth } from '../intercompany/fleet.js'
import { assertMoneyFits } from '../../lib/money.js'

export type Tx = Prisma.TransactionClient
export type Db = Tx | PrismaClient

/** 100% in basis points. */
export const FULL_BPS = 10_000

export interface SplitLineInput {
  companyTenantId: string
  shareBps: number
}

export interface SplitAmount extends SplitLineInput {
  /** Signed paisa: the sign of the base (negative = a credit to the company). */
  amountCents: number
}

export interface SplitVersion {
  id: string
  tenantId: string
  effectiveFrom: string
  note: string | null
  createdById: string
  createdAt: Date
  lines: SplitLineInput[]
  totalBps: number
}

// ─── The rounding rule (pure) ────────────────────────────────────────────────

/**
 * Split `base` paisa over `lines` by basis points. Pure.
 *
 *   amount = floor(|base| × bps / 10000), computed as
 *            q × bps + floor(r × bps / 10000) with |base| = q × 10000 + r,
 *   so every intermediate stays a safe integer for any base ≤ MAX_MONEY_CENTS
 *   (no bigint math in src — CLAUDE.md BOOKS-06).
 *
 * When the shares total exactly 10000 the residue goes to the largest share
 * (ties: the lowest companyTenantId); otherwise it is retained by the head
 * office. The base's sign is then re-applied and zero lines are dropped.
 * Lines come back ordered by companyTenantId.
 */
export function splitByBps(base: number, lines: readonly SplitLineInput[]): SplitAmount[] {
  if (!Number.isSafeInteger(base)) throw new AppError('INVALID_AMOUNT', 'The amount to split must be whole paisa', 422)
  assertMoneyFits(Math.abs(base), 'recharge base')
  for (const l of lines) {
    if (!Number.isInteger(l.shareBps) || l.shareBps < 0 || l.shareBps > FULL_BPS) {
      throw new AppError('SPLIT_OVER_100', 'Each share must be between 0.01% and 100%', 422)
    }
  }
  const sorted = [...lines].sort((a, b) => (a.companyTenantId < b.companyTenantId ? -1 : a.companyTenantId > b.companyTenantId ? 1 : 0))
  const abs = Math.abs(base)
  const q = Math.floor(abs / FULL_BPS)
  const r = abs % FULL_BPS
  const out = sorted.map((l) => ({ companyTenantId: l.companyTenantId, shareBps: l.shareBps, amountCents: q * l.shareBps + Math.floor((r * l.shareBps) / FULL_BPS) }))
  const totalBps = sorted.reduce((s, l) => s + l.shareBps, 0)
  if (totalBps === FULL_BPS && out.length > 0) {
    const allocated = out.reduce((s, l) => s + l.amountCents, 0)
    const residue = abs - allocated
    if (residue > 0) {
      // Largest share; on a tie the lowest company id (the list is sorted by id, so the first max wins).
      let top = out[0]!
      for (const l of out) if (l.shareBps > top.shareBps) top = l
      top.amountCents += residue
    }
  }
  const sign = base < 0 ? -1 : 1
  return out
    .filter((l) => l.amountCents !== 0)
    .map((l) => ({ ...l, amountCents: sign * l.amountCents }))
}

// ─── Reading versions ────────────────────────────────────────────────────────

const SPLIT_INCLUDE = { lines: { select: { companyTenantId: true, shareBps: true }, orderBy: { companyTenantId: 'asc' as const } } }

type SplitRow = {
  id: string; tenantId: string; effectiveFrom: string; note: string | null; createdById: string; createdAt: Date
  lines: Array<{ companyTenantId: string; shareBps: number }>
}

function present(row: SplitRow): SplitVersion {
  return {
    id: row.id,
    tenantId: row.tenantId,
    effectiveFrom: row.effectiveFrom,
    note: row.note,
    createdById: row.createdById,
    createdAt: row.createdAt,
    lines: row.lines.map((l) => ({ companyTenantId: l.companyTenantId, shareBps: l.shareBps })),
    totalBps: row.lines.reduce((s, l) => s + l.shareBps, 0),
  }
}

/** The version in force for `period` ('YYYY-MM'), or null when none starts on or before it. */
export async function splitForOrNull(db: Db, hoId: string, period: string): Promise<SplitVersion | null> {
  assertMonth(period, 'period')
  const row = await db.rechargeSplit.findFirst({
    where: { tenantId: hoId, effectiveFrom: { lte: period } },
    orderBy: { effectiveFrom: 'desc' },
    include: SPLIT_INCLUDE,
  })
  return row ? present(row) : null
}

/** The version in force for `period` ('YYYY-MM'): the latest effectiveFrom ≤ period. 422 NO_SPLIT when there is none. */
export async function splitFor(db: Db, hoId: string, period: string): Promise<SplitVersion> {
  const v = await splitForOrNull(db, hoId, period)
  if (!v) {
    throw new AppError('NO_SPLIT', `The head office has no % table in force for ${period} — add one (CEO → Head offices → Split)`, 422)
  }
  return v
}

/** Every version of a head office, newest first, with how many runs use each. */
export async function listSplits(db: Db, hoId: string): Promise<Array<SplitVersion & { runCount: number }>> {
  const rows = await db.rechargeSplit.findMany({
    where: { tenantId: hoId },
    orderBy: { effectiveFrom: 'desc' },
    include: { ...SPLIT_INCLUDE, _count: { select: { runs: true } } },
  })
  return rows.map((r) => ({ ...present(r), runCount: r._count.runs }))
}

// ─── Writing versions ────────────────────────────────────────────────────────

/** Serialise every split change of one head office for the rest of the transaction. */
async function lockSplits(tx: Tx, hoId: string): Promise<void> {
  const key = `ho.split:${hoId}`
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}::text))`
}

/** Shares: each 1..10000, no company twice, total ≤ 10000. */
export function assertSplitLines(lines: readonly SplitLineInput[]): number {
  const seen = new Set<string>()
  let total = 0
  for (const l of lines) {
    if (!l.companyTenantId) throw new AppError('COMPANY_NOT_LINKED', 'Every share must name a company', 422)
    if (seen.has(l.companyTenantId)) throw new AppError('DUPLICATE_COMPANY', 'A company appears twice in the % table', 422)
    seen.add(l.companyTenantId)
    if (!Number.isInteger(l.shareBps) || l.shareBps < 1 || l.shareBps > FULL_BPS) {
      throw new AppError('SPLIT_OVER_100', 'Each share must be between 0.01% and 100%', 422)
    }
    total += l.shareBps
  }
  if (total > FULL_BPS) {
    throw new AppError('SPLIT_OVER_100', `The shares add up to ${(total / 100).toFixed(2)}% — the total must be 100% or less`, 422)
  }
  return total
}

/** Mark the head office's DRAFT runs for `fromPeriod` and later stale (they must be refreshed). Returns how many. */
export async function markDraftRunsStale(tx: Tx, hoId: string, fromPeriod: string, opts: { after?: boolean } = {}): Promise<number> {
  const r = await tx.rechargeRun.updateMany({
    where: { tenantId: hoId, status: 'draft', period: opts.after ? { gt: fromPeriod } : { gte: fromPeriod } },
    data: { stale: true },
  })
  return r.count
}

export interface CreateSplitInput {
  hoId: string
  effectiveFrom: string
  lines: SplitLineInput[]
  note?: string | null
  actorId: string
}

/**
 * Create a version (spec §4.2). Inside the caller's transaction:
 *   422 INVALID_MONTH / DUPLICATE_COMPANY / SPLIT_OVER_100 / COMPANY_NOT_LINKED,
 *   409 SPLIT_PERIOD_IN_USE (a submitted or posted run for effectiveFrom or later),
 *   409 SPLIT_EXISTS (a version already starts that month — delete it first).
 * Draft runs for effectiveFrom and later are marked stale.
 * An empty `lines` is allowed here (endLink's automatic version when the last
 * company leaves: everything stays with the head office); the route asks for ≥1.
 */
export async function createSplitVersion(tx: Tx, input: CreateSplitInput): Promise<{ split: SplitVersion; staleRuns: number }> {
  assertMonth(input.effectiveFrom, 'effectiveFrom')
  assertSplitLines(input.lines)
  await lockSplits(tx, input.hoId)
  for (const l of input.lines) {
    if (!(await liveLink(input.hoId, l.companyTenantId, tx))) {
      throw new AppError('COMPANY_NOT_LINKED', 'Every company in the % table must be linked to this head office — link it first', 422)
    }
  }
  const inUse = await tx.rechargeRun.findMany({
    where: { tenantId: input.hoId, status: { in: ['submitted', 'posted'] }, period: { gte: input.effectiveFrom } },
    select: { id: true, period: true, status: true },
    orderBy: { period: 'asc' },
  })
  if (inUse.length > 0) {
    const list = inUse.map((r) => `${r.period} (${r.status})`).join(', ')
    throw new AppError('SPLIT_PERIOD_IN_USE', `Recharge runs from ${input.effectiveFrom} on are already submitted or posted: ${list} — withdraw or reverse those runs first`, 409)
  }
  const clash = await tx.rechargeSplit.findUnique({
    where: { tenantId_effectiveFrom: { tenantId: input.hoId, effectiveFrom: input.effectiveFrom } },
    select: { id: true },
  })
  if (clash) throw new AppError('SPLIT_EXISTS', `A % table already starts in ${input.effectiveFrom} — delete it first, then add the new one`, 409)
  const row = await tx.rechargeSplit.create({
    data: {
      tenantId: input.hoId,
      effectiveFrom: input.effectiveFrom,
      note: input.note?.trim() || null,
      createdById: input.actorId,
      lines: { create: input.lines.map((l) => ({ tenantId: input.hoId, companyTenantId: l.companyTenantId, shareBps: l.shareBps })) },
    },
    include: SPLIT_INCLUDE,
  })
  const staleRuns = await markDraftRunsStale(tx, input.hoId, input.effectiveFrom)
  return { split: present(row), staleRuns }
}

/**
 * Delete a version — only while no recharge run (of any status) references it
 * (409 SPLIT_IN_USE). Draft runs from its month on are marked stale (the
 * months fall back to the previous version).
 */
export async function deleteSplitVersion(tx: Tx, input: { hoId: string; splitId: string }): Promise<{ split: SplitVersion; staleRuns: number }> {
  await lockSplits(tx, input.hoId)
  const row = await tx.rechargeSplit.findFirst({ where: { id: input.splitId, tenantId: input.hoId }, include: SPLIT_INCLUDE })
  if (!row) throw new NotFoundError('Split', input.splitId)
  const runs = await tx.rechargeRun.count({ where: { splitId: row.id } })
  if (runs > 0) {
    throw new AppError('SPLIT_IN_USE', `${runs} recharge run(s) use this % table — it can no longer be deleted (add a new version instead)`, 409)
  }
  await tx.rechargeSplit.delete({ where: { id: row.id } })
  const staleRuns = await markDraftRunsStale(tx, input.hoId, row.effectiveFrom)
  return { split: present(row), staleRuns }
}
