// Till clearing — the one-time 1110 → 1115 cut-over, the daily mover of late
// till lines, and the 1110 tie-out (on-account clients resumed, 2026-10-15).
//
// Until a company is cut over, till money that did not settle on its own
// drawer (an unsettled drawer balance, a refund due on a cancelled ticket, a
// till card that failed after its close, a Raast payment written off as "the
// customer owes it") sits on 1110 Customer receivable, mixed with invoices.
// accounting/tillClearingCode.ts decides the code for NEW postings: 1110 with
// no marker, 1115 once the marker exists.
//
// THE CUT-OVER IS THE CEO'S (coordinator switch, 2026-10-15): nothing runs it
// at boot. POST /accounting/till-clearing/cutover (tillClearingRoutes.ts), per
// company, once the CA confirms. cutoverTillClearing:
//   • under pg_advisory_xact_lock(hashtext('till_clearing:'+tenantId)), and
//     with journal_entries held in SHARE mode for the few hundred ms it takes
//     (every in-flight posting commits first, so the balance read below sees
//     it; a posting that starts meanwhile waits for the marker);
//   • X = net Dr − Cr of the company's 1110 lines from TILL_SOURCES (the
//     allow-list below, by journal_entries.reference prefix). Lines memo'd
//     ON_ACCOUNT_MEMO (a client's invoiced balance) and 'receivable.*' entries
//     are never in it;
//   • X ≠ 0 → 'ledger.till_clearing_split:<tenantId>' (sourceId = tenantId),
//     dated now: Cr 1110 / Dr 1115, signs flipped when X < 0, one pair per
//     brand so brand attribution survives;
//   • the marker Setting (TILL_CLEARING_CUTOVER_SETTING:<tenantId>, ISO time)
//     is written in the SAME transaction — a refused posting leaves no marker.
//   A refusal (a locked period, a missing account) is flagged posting_failed
//   (sourceType 'ledger.till_clearing_split', entityType 'Tenant', entityId =
//   sourceId = tenantId) and re-posted by Reconciliation → Backfill unposted
//   (reconciliation/backfillOrders.ts REPOSTERS → tillClearingRefusedDoc).
//
// 1110 lines from any other source (manual journals, opening balances, …) are
// NEVER moved — tieOutOf lists them as unexplained for a person to decide.
//
// After the cut-over (moveLateTillLines, the daily worker workers/
// tillClearingSweep.ts at 03:10 PKT, only for companies WITH the marker):
//   • an allow-listed till line on 1110 posted after the marker — a reversal
//     of a pre-cut-over entry (reversals mirror their own lines), or a close
//     that raced the cut-over — is moved to 1115 under its own key
//     'ledger.till_clearing_split:<tenantId>:r:<entryId>';
//   • any other non-receivable, non-ON-ACCOUNT 1110 line posted after the
//     marker raises ONE till_clearing_unexpected flag per entry and is never
//     moved.
//   Entries created in the RECENT_WINDOW before the marker that were already
//   in X are recorded at the cut-over (TILL_CLEARING_INCLUDED_SETTING), so a
//   posting that raced the cut-over is moved exactly once and nothing in X is
//   moved twice.

import type { Prisma, PrismaClient } from '@prisma/client'
import { Prisma as P } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { toCents } from '../../lib/money.js'
import { flagException } from '../../lib/exceptions.js'
import { AppError } from '../../lib/errors.js'
import {
  ACCT, ON_ACCOUNT_MEMO, flagPostingFailed, lateDatingFor, postJournalEntry, withLateNote,
  type JournalLineInput, type RepostOptions,
} from './journal.js'
import { TILL_CLEARING_CUTOVER_SETTING, tillClearingCutoverAt, tillClearingCutoverKey } from './tillClearingCode.js'
import { LIVE_KINDS, STATEMENT, balanceOf } from '../receivables/ledger.js'
import { chargeNetCents, isChargeBookedTx } from '../receivables/onAccount.js'
import type { RefusedDoc } from '../reconciliation/backfillOrders.js'

type Tx = Prisma.TransactionClient
type Db = PrismaClient | Tx | typeof prisma

export { TILL_CLEARING_CUTOVER_SETTING }

/** The cut-over's (and every late move's) journal sourceType. */
export const TILL_SPLIT_SOURCE = 'ledger.till_clearing_split'
/** The flag's entityType for a refused cut-over / move (entityId = the company id). */
export const TILL_SPLIT_ENTITY = 'Tenant'
const LEGACY = ACCT.CUSTOMER_AR      // 1110
const CLEARING = ACCT.TILL_CLEARING  // 1115

/** Memo prefix of a cancelled ticket's hand-back lines (orderPosting.ts / pos/service.ts). */
export const REFUND_HANDBACK_MEMO = 'Refund due handed back'

/** Till sources whose every (non-ON-ACCOUNT) 1110 line is till clearing. */
const PLAIN_TILL_SOURCES = ['shift.close', 'order.cancel_unwind', 'pos.card_failed', 'raast.unreceived'] as const
/** 'order.refund' entries count only on lines memo'd REFUND_HANDBACK_MEMO. */
const HANDBACK_SOURCE = 'order.refund'

const withReversal = (s: string): string[] => [`${s}:`, `${s}.reversal:`]
const PLAIN_PREFIXES: string[] = PLAIN_TILL_SOURCES.flatMap(withReversal)
const HANDBACK_PREFIXES: string[] = withReversal(HANDBACK_SOURCE)

/** The allow-list, by journal_entries.reference prefix (order.refund: hand-back lines only). */
export const TILL_SOURCES: readonly string[] = [...PLAIN_PREFIXES, ...HANDBACK_PREFIXES]

/** Is this 1110 line till clearing (the allow-list, never ON ACCOUNT, never receivable.*)? */
export function isTillClearingLine(reference: string | null | undefined, memo: string | null | undefined): boolean {
  const ref = reference ?? ''
  const m = memo ?? ''
  if (m.startsWith(ON_ACCOUNT_MEMO) || ref.startsWith('receivable.')) return false
  if (PLAIN_PREFIXES.some((p) => ref.startsWith(p))) return true
  return HANDBACK_PREFIXES.some((p) => ref.startsWith(p)) && m.startsWith(REFUND_HANDBACK_MEMO)
}

/** Entries created this long before the marker are checked against the cut-over's own list. */
export const RECENT_WINDOW_MS = 10 * 60_000
/** Setting key (+ ':<tenantId>') of the ids of entries in the RECENT_WINDOW that the cut-over moved. */
export const TILL_CLEARING_INCLUDED_SETTING = 'ledger.tillClearingCutoverIncluded'
const includedKey = (tenantId: string) => `${TILL_CLEARING_INCLUDED_SETTING}:${tenantId}`

const moveKey = (tenantId: string, entryId: string) => `${tenantId}:r:${entryId}`

// ─── SQL pieces ──────────────────────────────────────────────────────────────

/** The line is till clearing (l = journal_lines, j = journal_entries). */
const TILL_LINE_SQL = P.sql`(
  NOT starts_with(COALESCE(l.memo, ''), ${ON_ACCOUNT_MEMO})
  AND NOT starts_with(COALESCE(j.reference, ''), 'receivable.')
  AND (
    EXISTS (SELECT 1 FROM unnest(${PLAIN_PREFIXES}::text[]) p(x) WHERE starts_with(COALESCE(j.reference, ''), p.x))
    OR (
      EXISTS (SELECT 1 FROM unnest(${HANDBACK_PREFIXES}::text[]) p(x) WHERE starts_with(COALESCE(j.reference, ''), p.x))
      AND starts_with(COALESCE(l.memo, ''), ${REFUND_HANDBACK_MEMO})
    )
  )
)`
const SPLIT_ENTRY_SQL = P.sql`starts_with(COALESCE(j.reference, ''), ${`${TILL_SPLIT_SOURCE}:`})`
const SIGNED = P.sql`CASE WHEN l.type::text = 'debit' THEN l."amountCents" ELSE -l."amountCents" END`

/** The company's 1110 lines (l, j, a joined; the account in the company's own chart). */
function lines1110(tenantId: string): Prisma.Sql {
  return P.sql`journal_lines l
    JOIN journal_entries j ON j.id = l."journalEntryId"
    JOIN accounts a ON a.id = l."accountId"
   WHERE j."tenantId" = ${tenantId} AND a."tenantId" = ${tenantId} AND a.code = ${LEGACY}`
}

/** Net Dr − Cr of the company's till-clearing lines on 1110, per brand (X before the cut-over). */
async function tillNetByConcept(db: Db, tenantId: string): Promise<Array<{ conceptId: string | null; cents: number }>> {
  const rows = await (db as Tx).$queryRaw<Array<{ conceptId: string | null; net: bigint | number | null }>>`
    SELECT l."conceptId" AS "conceptId", COALESCE(SUM(${SIGNED}), 0)::bigint AS net
      FROM ${lines1110(tenantId)} AND ${TILL_LINE_SQL}
     GROUP BY l."conceptId"`
  return rows.map((r) => ({ conceptId: r.conceptId, cents: toCents(r.net) ?? 0 })).filter((r) => r.cents !== 0)
}

/** One Prisma.Sql scalar: net Dr − Cr of the company's 1110 lines matching `where`. */
async function net1110(db: Db, tenantId: string, where: Prisma.Sql): Promise<number> {
  const [row] = await (db as Tx).$queryRaw<Array<{ net: bigint | number | null }>>`
    SELECT COALESCE(SUM(${SIGNED}), 0)::bigint AS net FROM ${lines1110(tenantId)} AND ${where}`
  return toCents(row?.net) ?? 0
}

/** The reclass lines moving `byConcept` (net Dr on 1110 per brand) from 1110 to 1115, with `memo`. */
function moveLines(byConcept: Array<{ conceptId: string | null; cents: number }>, memo: string): JournalLineInput[] {
  const out: JournalLineInput[] = []
  for (const { conceptId, cents } of byConcept) {
    if (cents === 0) continue
    const abs = Math.abs(cents)
    // Dr balance on 1110 (cents > 0): Cr 1110 / Dr 1115; a Cr balance flips.
    out.push({ accountCode: LEGACY, type: cents > 0 ? 'credit' : 'debit', amountCents: abs, memo, conceptId })
    out.push({ accountCode: CLEARING, type: cents > 0 ? 'debit' : 'credit', amountCents: abs, memo, conceptId })
  }
  return out
}

// ─── The cut-over ────────────────────────────────────────────────────────────

export interface CutoverPreview {
  /** When the company was cut over, or null. */
  cutoverAt: Date | null
  /** Before the cut-over: X, what it would move. After: till lines still on 1110 net of the moves (0 when all moved). */
  tillOn1110Cents: number
}

/** What the cut-over would move now (or, after it, what is still left on 1110). Read-only. */
export async function cutoverPreview(tenantId: string, db: Db = prisma): Promise<CutoverPreview> {
  const cutoverAt = await tillClearingCutoverAt(db as Tx, tenantId)
  const tillOn1110Cents = await net1110(db, tenantId, P.sql`(${TILL_LINE_SQL} OR ${SPLIT_ENTRY_SQL})`)
  return { cutoverAt, tillOn1110Cents }
}

export interface CutoverResult {
  /** 'cut_over' — this call wrote the marker; 'already_cut_over' — it already existed (nothing posted). */
  status: 'cut_over' | 'already_cut_over'
  cutoverAt: Date
  /** The split entry, or null (X = 0, or already cut over). */
  entryId: string | null
  /** X: the net Dr moved off 1110 (negative = a credit balance moved). */
  movedCents: number
  /** For a reposter: why nothing was posted. */
  reason?: 'zero' | 'already_cut_over'
}

/** Postgres 55P03 lock_not_available (lock_timeout), however Prisma wraps it. */
function isLockNotAvailable(err: unknown): boolean {
  const e = err as { code?: unknown; meta?: { code?: unknown; message?: unknown }; message?: unknown } | null
  if (!e) return false
  if (e.code === '55P03' || e.meta?.code === '55P03') return true
  const msg = `${typeof e.message === 'string' ? e.message : ''} ${typeof e.meta?.message === 'string' ? e.meta.message : ''}`
  return /55P03|lock_not_available|canceling statement due to lock timeout/i.test(msg)
}

/**
 * The CEO's one-time cut-over of `tenantId` (see the header). Idempotent on
 * the marker. `actor` is the user id ('system' never runs it on its own).
 * Throws the refusal (after flagging it posting_failed) — nothing is written.
 */
export async function cutoverTillClearing(
  tenantId: string,
  actor: string,
  opts: { reason?: string | null } = {},
): Promise<CutoverResult> {
  if (!tenantId) throw new AppError('NO_COMPANY', 'The till-clearing cut-over is per company', 422)
  let preview = 0
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`till_clearing:${tenantId}`}::text))`
      const marker = await tx.setting.findUnique({ where: { key: tillClearingCutoverKey(tenantId) }, select: { value: true } })
      if (marker) {
        const at = new Date(marker.value)
        return { status: 'already_cut_over' as const, cutoverAt: Number.isNaN(at.getTime()) ? new Date(0) : at, entryId: null, movedCents: 0, reason: 'already_cut_over' as const }
      }
      // Every posting already writing to journal_entries commits before the
      // balance is read; one that starts now waits for the marker (and then
      // posts to 1115, or — if it read 1110 first — is moved by the daily job).
      // The lock covers every company's journal: never queue behind a long
      // writer (every new posting would then queue behind US) — give up fast.
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '5s'")
      await tx.$executeRawUnsafe('LOCK TABLE journal_entries IN SHARE MODE')
      const at = new Date()
      const byConcept = await tillNetByConcept(tx, tenantId)
      const x = byConcept.reduce((t, r) => t + r.cents, 0)
      preview = x
      let entryId: string | null = null
      if (byConcept.length > 0) {
        const why = opts.reason?.trim() ? ` — ${opts.reason.trim()}` : ''
        const res = await postJournalEntry({
          tenantId,
          sourceType: TILL_SPLIT_SOURCE,
          sourceId: tenantId,
          description: `Till clearing moved out of customer receivables (1110 → 1115), the one-time cut-over${why}`.slice(0, 500),
          entryDate: at,
          postedBy: actor,
          lines: moveLines(byConcept, 'Till clearing cut-over (1110 → 1115)'),
        }, { tx })
        entryId = res.entryId
      }
      // The recent entries X already holds — the daily mover never moves them again.
      const recent = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT DISTINCT j.id FROM ${lines1110(tenantId)} AND ${TILL_LINE_SQL}
           AND j."createdAt" >= ${new Date(at.getTime() - RECENT_WINDOW_MS)}`
      await tx.setting.create({ data: { key: tillClearingCutoverKey(tenantId), value: at.toISOString() } })
      await tx.setting.upsert({
        where: { key: includedKey(tenantId) },
        create: { key: includedKey(tenantId), value: JSON.stringify(recent.map((r) => r.id)) },
        update: { value: JSON.stringify(recent.map((r) => r.id)) },
      })
      return x === 0
        ? { status: 'cut_over' as const, cutoverAt: at, entryId: null, movedCents: 0, reason: 'zero' as const }
        : { status: 'cut_over' as const, cutoverAt: at, entryId, movedCents: x }
    }, { maxWait: 15_000, timeout: 60_000 })
  } catch (err) {
    // A busy table is not a refused posting: no flag (a flag's reposter would
    // later run the cut-over unattended) — the CEO simply tries again.
    if (isLockNotAvailable(err)) {
      throw new AppError('TILL_CLEARING_BUSY', 'The books are busy — try the cut-over again in a minute', 409)
    }
    await flagPostingFailed({
      tenantId,
      sourceType: TILL_SPLIT_SOURCE, sourceId: tenantId,
      entityType: TILL_SPLIT_ENTITY, entityId: tenantId,
      reason: (err as Error).message,
      title: 'Till clearing not moved out of 1110',
      actorId: actor && actor !== 'system' ? actor : null,
      amountCents: preview || null,
      metadata: { documentDate: new Date().toISOString(), step: 'cutover' },
    })
    throw err
  }
}

// ─── The daily mover ─────────────────────────────────────────────────────────

export interface LateMoveResult {
  cutoverAt: Date | null
  /** Entries moved to 1115 this run. */
  moved: Array<{ entryId: string; reference: string | null; cents: number; moveEntryId: string }>
  /** till_clearing_unexpected flags raised this run (entry ids). */
  flagged: string[]
  /** Moves the ledger refused this run (flagged posting_failed on the company). */
  refused: Array<{ entryId: string; reason: string }>
}

async function includedIds(db: Db, tenantId: string): Promise<string[]> {
  const row = await (db as Tx).setting.findUnique({ where: { key: includedKey(tenantId) }, select: { value: true } })
  if (!row) return []
  try {
    const v: unknown = JSON.parse(row.value)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/** Allow-listed till lines on 1110 posted after the marker and not yet moved: net per entry and brand. */
async function lateTillLines(db: Db, tenantId: string, cutoverAt: Date): Promise<Array<{
  entryId: string; reference: string | null; entryDate: Date; conceptId: string | null; cents: number
}>> {
  const skip = await includedIds(db, tenantId)
  const since = new Date(cutoverAt.getTime() - RECENT_WINDOW_MS)
  const rows = await (db as Tx).$queryRaw<Array<{ entryId: string; reference: string | null; entryDate: Date; conceptId: string | null; net: bigint | number | null }>>`
    SELECT j.id AS "entryId", j.reference, j."entryDate" AS "entryDate", l."conceptId" AS "conceptId", COALESCE(SUM(${SIGNED}), 0)::bigint AS net
      FROM ${lines1110(tenantId)} AND ${TILL_LINE_SQL}
       AND j."createdAt" >= ${since}
       AND NOT (j.id = ANY(${skip}::text[]))
       AND NOT EXISTS (
             SELECT 1 FROM journal_entries m
              WHERE m."tenantId" = ${tenantId}
                AND m.reference = ${`${TILL_SPLIT_SOURCE}:${tenantId}:r:`} || j.id)
     GROUP BY j.id, j.reference, j."entryDate", l."conceptId"
     ORDER BY j."entryDate" ASC`
  return rows.map((r) => ({ entryId: r.entryId, reference: r.reference, entryDate: new Date(r.entryDate), conceptId: r.conceptId, cents: toCents(r.net) ?? 0 }))
}

/** Other 1110 lines after the marker: not till clearing, not receivable.*, not ON ACCOUNT, not a split. Per entry. */
async function unexpectedAfter(db: Db, tenantId: string, cutoverAt: Date): Promise<Array<{
  entryId: string; reference: string | null; entryDate: Date; description: string; cents: number
}>> {
  const rows = await (db as Tx).$queryRaw<Array<{ entryId: string; reference: string | null; entryDate: Date; description: string; net: bigint | number | null }>>`
    SELECT j.id AS "entryId", j.reference, j."entryDate" AS "entryDate", j.description, COALESCE(SUM(${SIGNED}), 0)::bigint AS net
      FROM ${lines1110(tenantId)}
       AND j."createdAt" > ${cutoverAt}
       AND NOT ${TILL_LINE_SQL}
       AND NOT ${SPLIT_ENTRY_SQL}
       AND NOT starts_with(COALESCE(j.reference, ''), 'receivable.')
       AND NOT starts_with(COALESCE(l.memo, ''), ${ON_ACCOUNT_MEMO})
     GROUP BY j.id, j.reference, j."entryDate", j.description
     ORDER BY j."entryDate" ASC`
  return rows.map((r) => ({ entryId: r.entryId, reference: r.reference, entryDate: new Date(r.entryDate), description: r.description, cents: toCents(r.net) ?? 0 }))
}

/**
 * The daily job (only after the cut-over): moves allow-listed till lines that
 * reached 1110 after the marker to 1115, each under its own key, and flags
 * every other unexplained 1110 line once per entry. A refused move is flagged
 * posting_failed on the company and retried by the next run (or the backfill).
 */
export async function moveLateTillLines(tenantId: string, opts: { postedBy?: string } = {}): Promise<LateMoveResult> {
  const cutoverAt = await tillClearingCutoverAt(prisma, tenantId)
  const out: LateMoveResult = { cutoverAt, moved: [], flagged: [], refused: [] }
  if (!cutoverAt) return out

  // ── Late till lines → 1115 ─────────────────────────────────────────────
  const late = await lateTillLines(prisma, tenantId, cutoverAt)
  const byEntry = new Map<string, { reference: string | null; entryDate: Date; parts: Array<{ conceptId: string | null; cents: number }> }>()
  for (const r of late) {
    const e = byEntry.get(r.entryId) ?? { reference: r.reference, entryDate: r.entryDate, parts: [] }
    if (r.cents !== 0) e.parts.push({ conceptId: r.conceptId, cents: r.cents })
    byEntry.set(r.entryId, e)
  }
  for (const [entryId, e] of byEntry) {
    if (e.parts.length === 0) continue
    const cents = e.parts.reduce((t, p) => t + p.cents, 0)
    try {
      // On its own date (never before the cut-over); a closed month → today with a note.
      const natural = e.entryDate > cutoverAt ? e.entryDate : cutoverAt
      const placed = await lateDatingFor(prisma, tenantId, natural)
      if ('lockedThroughToday' in placed) throw new AppError('PERIOD_LOCKED', 'The books are closed through today — nothing can post until today is open', 422)
      const memo = `Till clearing moved to 1115 (posted after the cut-over: ${e.reference ?? entryId})`.slice(0, 250)
      const { description, lines } = withLateNote(
        `Till clearing moved out of customer receivables (1110 → 1115) — ${e.reference ?? entryId}, posted after the company's cut-over`,
        moveLines(e.parts, memo),
        placed.memoNote,
      )
      if (lines.length < 2) continue
      const res = await postJournalEntry({
        tenantId,
        sourceType: TILL_SPLIT_SOURCE,
        sourceId: moveKey(tenantId, entryId),
        description: description.slice(0, 500),
        entryDate: placed.entryDate,
        postedBy: opts.postedBy ?? 'system',
        lines,
      })
      out.moved.push({ entryId, reference: e.reference, cents, moveEntryId: res.entryId })
    } catch (err) {
      const reason = (err as Error).message
      out.refused.push({ entryId, reason })
      await flagPostingFailed({
        tenantId,
        sourceType: TILL_SPLIT_SOURCE, sourceId: tenantId,
        entityType: TILL_SPLIT_ENTITY, entityId: tenantId,
        reason: `Moving ${e.reference ?? entryId} to 1115: ${reason}`,
        title: 'Till clearing not moved out of 1110',
        amountCents: cents,
        metadata: { documentDate: e.entryDate.toISOString(), step: 'late_move', entryId },
      })
    }
  }

  // ── Anything else on 1110 after the marker → one flag per entry ────────
  const others = await unexpectedAfter(prisma, tenantId, cutoverAt)
  if (others.length > 0) {
    const seen = await prisma.exceptionFlag.findMany({
      where: { kind: 'till_clearing_unexpected', tenantId, entityType: 'JournalEntry', entityId: { in: others.map((o) => o.entryId) } },
      select: { entityId: true },
    })
    const already = new Set(seen.map((s) => s.entityId))
    for (const o of others) {
      // One flag per entry, ever: a flag a person closed is their decision.
      if (already.has(o.entryId)) continue
      const row = await flagException({
        tenantId,
        kind: 'till_clearing_unexpected',
        severity: 'medium',
        title: 'Unexpected posting to 1110 after the till-clearing cut-over',
        description: `${o.reference ?? 'A journal entry'} (${o.description.slice(0, 160)}) posted to 1110 Customer receivable after this company moved till clearing to 1115. `
          + 'It is not an invoice, a client statement or a till posting, so it was NOT moved. Check it: if it is till money, reverse it and re-post it on 1115; if it is a real receivable, close this flag.',
        entityType: 'JournalEntry',
        entityId: o.entryId,
        amountCents: o.cents,
        metadata: { reference: o.reference, documentDate: o.entryDate.toISOString(), cutoverAt: cutoverAt.toISOString() },
      })
      if (row) out.flagged.push(o.entryId)
    }
  }
  return out
}

// ─── The 1110 tie-out ────────────────────────────────────────────────────────

export interface UnexplainedLine {
  entryId: string
  reference: string | null
  entryDate: string
  description: string
  memo: string | null
  type: 'debit' | 'credit'
  amountCents: number
}

export interface TieOut {
  /** The 1110 balance (Dr − Cr) in the company's books. */
  gl1110: number
  /** Σ what open invoices still owe (balanceOf; a credit balance counts negative). */
  openInvoicesCents: number
  /** Σ what open client statements still owe. */
  openStatementsCents: number
  /** On-account charges not yet on a statement whose sale IS booked (on 1110 already). */
  unbilledBookedCents: number
  /** On-account charges whose sale is not booked yet (not on 1110 yet — for information). */
  unbilledNotBookedCents: number
  /** Till clearing still on 1110 (allow-listed till lines net of the cut-over and moves): X before the cut-over, 0 after. */
  tillClearingOn1110Cents: number
  /** gl1110 − (invoices + statements + unbilled booked + till clearing still on 1110). */
  differenceCents: number
  /** 1110 lines nothing above explains (manual journals, opening balances, …) — newest last, at most UNEXPLAINED_LIMIT. */
  unexplainedLines: UnexplainedLine[]
  /** How many such lines there are in all. */
  unexplainedCount: number
  cutoverAt: string | null
}

export const UNEXPLAINED_LIMIT = 200

/** The company's 1110 tie-out (read-only; the company's own rows only). */
export async function tieOutOf(tenantId: string, db: Db = prisma): Promise<TieOut> {
  const d = db as Tx
  const cutoverAt = await tillClearingCutoverAt(d, tenantId)
  const gl1110 = await net1110(db, tenantId, P.sql`TRUE`)
  const tillClearingOn1110Cents = await net1110(db, tenantId, P.sql`(${TILL_LINE_SQL} OR ${SPLIT_ENTRY_SQL})`)

  const invoices = await d.receivableInvoice.findMany({
    where: { tenantId, kind: { in: [...LIVE_KINDS] }, status: { not: 'void' } },
    select: { kind: true, status: true, amountCents: true, taxCents: true, paidCents: true, creditedCents: true, whtCents: true, writtenOffCents: true },
  })
  let openInvoicesCents = 0
  let openStatementsCents = 0
  for (const inv of invoices) {
    const b = balanceOf(inv)
    if (inv.kind === STATEMENT) openStatementsCents += b
    else openInvoicesCents += b
  }

  const charges = await d.customerAccountCharge.findMany({
    where: { tenantId, statementInvoiceId: null },
    select: { tenantId: true, orderId: true, paymentId: true, amountCents: true, refundedCents: true },
  })
  let unbilledBookedCents = 0
  let unbilledNotBookedCents = 0
  for (const c of charges) {
    const net = chargeNetCents(c)
    if (net === 0) continue
    if (await isChargeBookedTx(d, c)) unbilledBookedCents += net
    else unbilledNotBookedCents += net
  }

  const UNEXPLAINED = P.sql`NOT ${TILL_LINE_SQL} AND NOT ${SPLIT_ENTRY_SQL}
       AND NOT starts_with(COALESCE(j.reference, ''), 'receivable.')
       AND NOT starts_with(COALESCE(l.memo, ''), ${ON_ACCOUNT_MEMO})`
  const [count] = await d.$queryRaw<Array<{ n: bigint | number }>>`
    SELECT count(*)::bigint AS n FROM ${lines1110(tenantId)} AND ${UNEXPLAINED}`
  const rows = await d.$queryRaw<Array<{ entryId: string; reference: string | null; entryDate: Date; description: string; memo: string | null; type: string; amountCents: bigint | number }>>`
    SELECT j.id AS "entryId", j.reference, j."entryDate" AS "entryDate", j.description, l.memo, l.type::text AS type, l."amountCents"::bigint AS "amountCents"
      FROM ${lines1110(tenantId)} AND ${UNEXPLAINED}
     ORDER BY j."entryDate" DESC, j.id
     LIMIT ${UNEXPLAINED_LIMIT}`
  const unexplainedLines: UnexplainedLine[] = rows.reverse().map((r) => ({
    entryId: r.entryId, reference: r.reference, entryDate: new Date(r.entryDate).toISOString(), description: r.description,
    memo: r.memo, type: r.type === 'debit' ? 'debit' : 'credit', amountCents: toCents(r.amountCents) ?? 0,
  }))

  const differenceCents = gl1110 - (openInvoicesCents + openStatementsCents + unbilledBookedCents + tillClearingOn1110Cents)
  return {
    gl1110, openInvoicesCents, openStatementsCents, unbilledBookedCents, unbilledNotBookedCents,
    tillClearingOn1110Cents, differenceCents, unexplainedLines, unexplainedCount: Number(count?.n ?? 0),
    cutoverAt: cutoverAt ? cutoverAt.toISOString() : null,
  }
}

// ─── The re-poster (reconciliation/backfillOrders.ts REPOSTERS) ─────────────

/**
 * The refused cut-over (or a refused late move) of company `tenantId`, for
 * Reconciliation → Backfill unposted. The flag is raised only when the CEO
 * ran the cut-over (or the daily mover, which runs only after it), so the
 * backfill (CEO only) never cuts a company over on its own initiative.
 *   • no marker → post = cutoverTillClearing (nothing owed when X = 0 is
 *     reported as 'zero' by the post, which still writes the marker);
 *   • marker → post = moveLateTillLines; nothing owed when nothing late waits.
 */
export async function tillClearingRefusedDoc(tenantId: string): Promise<RefusedDoc | null> {
  const t = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true } })
  if (!t) return null
  const cutoverAt = await tillClearingCutoverAt(prisma, tenantId)
  if (!cutoverAt) {
    const { tillOn1110Cents } = await cutoverPreview(tenantId)
    return {
      tenantId, date: null, orderId: null, amountCents: tillOn1110Cents,
      what: '1110 → 1115 till-clearing cut-over',
      post: async (o: RepostOptions) => {
        const r = await cutoverTillClearing(tenantId, o.postedBy ?? 'system', { reason: 'Re-posted from Reconciliation → Backfill unposted' })
        if (r.reason) return { posted: false, entryId: r.entryId, reason: r.reason }
        return { posted: true, entryId: r.entryId }
      },
    }
  }
  const late = await lateTillLines(prisma, tenantId, cutoverAt)
  const owed = late.reduce((t, r) => t + r.cents, 0)
  const anything = late.some((r) => r.cents !== 0)
  return {
    tenantId, date: null, orderId: null, amountCents: owed,
    what: 'Till lines posted to 1110 after the cut-over, moved to 1115',
    nothingOwed: anything ? undefined : 'The company is cut over and no till line waits on 1110 — nothing to post.',
    post: async (o: RepostOptions) => {
      const r = await moveLateTillLines(tenantId, { postedBy: o.postedBy })
      if (r.refused.length > 0) return { posted: false, entryId: null, reason: r.refused.map((x) => x.reason).join('; ') }
      if (r.moved.length > 0) return { posted: true, entryId: r.moved[r.moved.length - 1]!.moveEntryId }
      return { posted: false, entryId: null, reason: 'nothing_late' }
    },
  }
}
