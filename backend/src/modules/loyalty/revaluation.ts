// Loyalty revaluation (owner, 2026-10-17: "Yes to loyalty revaluation"; H48:
// points are valued at TODAY's point value).
//
// 2060 Loyalty liability must always equal the company's outstanding points ×
// its CURRENT point value (the tie-out in intercompany/legacy.ts controlTieOut
// measures exactly that). Earns, redemptions and expiries post at the value of
// their day, so when the point value changes the points already sitting in
// 2060 are re-measured by ONE entry in the company's books:
//
//   rise: Dr 6060 Marketing & Promo / Cr 2060 Loyalty liability
//   fall: Dr 2060                   / Cr 6060
//   amount = points × (new value − old value)   (integer paisa — values are whole paisa)
//
// sourceType 'loyalty.revalue', sourceId = the id of the AuditLog row (action
// 'loyalty.revalue', category 'accounting') written in the SAME transaction as
// the setting. That row is the record: it stores oldValueCents, newValueCents,
// points and deltaCents, and the re-poster (reconciliation/backfillOrders.ts
// REPOSTERS 'loyalty.revalue') posts exactly that stored delta — it never
// recomputes. The reference '<sourceType>:<auditId>' is per change, so a change
// can never post twice. No change (or no points) → no entry (the audit row is
// still written for a value change).
//
// Which points: the points whose value is IN 2060 right now — the company's
// balances, less earns not yet booked (they will post at the new value), plus
// redemptions / expiries not yet booked (2060 still holds them at the old
// value; they will discharge at the new one). Reversed transactions are out
// either way (a reversed, never-booked transaction never moved 2060; a booked
// one is netted by its mirror).
//
// Concurrency: the setting write, the count and the entry run under ONE
// per-company advisory lock (`lockLoyaltyValueTx`, exclusive). Every earn /
// redeem / expiry posting takes the same lock SHARED and reads the point value
// inside it (accounting/loyaltyPosting.ts), so a posting is either on the
// books before the change (counted, revalued) or reads the new value after it
// (not counted). Never both, never neither.
//
// A refused posting (closed books, a missing account) never blocks the
// setting: the change is saved with its record and the posting is flagged
// posting_failed (metadata.documentDate) for Reconciliation → Backfill
// unposted.

import type { Prisma } from '@prisma/client'
import { serviceClient as prisma } from '../../lib/prisma.js'
import { LOYALTY_DEFAULTS, POINT_VALUE_CENTS, type LOYALTY_SETTING_KEYS } from '../../lib/loyaltySettings.js'
import { postJournalEntry, flagPostingFailed, withLateNote, type RepostOptions } from '../accounting/journal.js'

type Db = Prisma.TransactionClient
type LoyaltySettingKey = typeof LOYALTY_SETTING_KEYS[number]

export const LOYALTY_REVALUE_SOURCE = 'loyalty.revalue'
export const LOYALTY_REVALUE_ENTITY = 'LoyaltyRevaluation'
const LOYALTY_MARKETING_ACCOUNT = '6060'   // the account loyalty earns debit (accounting/loyaltyPosting.ts)
const LOYALTY_LIABILITY_ACCOUNT = '2060'

const POINT_VALUE_KEY = 'loyalty.point_value_cents' as const
const settingKey = (key: LoyaltySettingKey, tenantId: string) => `${key}.${tenantId}`

/**
 * The per-company point-value lock. `shared` for a posting that values points,
 * exclusive for a change of the value. Transaction-scoped.
 */
export async function lockLoyaltyValueTx(db: Db, tenantId: string, mode: 'shared' | 'exclusive'): Promise<void> {
  if (mode === 'shared') {
    await db.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtext('loyalty.point_value'), hashtext(${tenantId}::text))`
  } else {
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('loyalty.point_value'), hashtext(${tenantId}::text))`
  }
}

/**
 * The company's point value in paisa, read inside `db` (no cache). Same rule
 * as lib/loyaltySettings.ts calculatePointsValue: a stored 0 or nothing → the
 * default. Call loadLoyaltySettings(tenantId) BEFORE the transaction so a
 * company's keys are seeded (that seed writes outside the transaction).
 */
export async function pointValueCentsTx(db: Db, tenantId: string): Promise<number> {
  const row = await db.setting.findUnique({ where: { key: settingKey(POINT_VALUE_KEY, tenantId) }, select: { value: true } })
  const n = row ? Number(row.value) : NaN
  const v = Number.isFinite(n) && n >= 0 ? n : LOYALTY_DEFAULTS[POINT_VALUE_KEY]
  return v || POINT_VALUE_CENTS
}

/** Points of `tenantId` whose value sits in 2060 right now (see the header). */
export async function pointsInLedgerTx(db: Db, tenantId: string): Promise<{ points: number; balancePoints: number; unpostedEarnPoints: number; unpostedOutPoints: number }> {
  const [bal] = await db.$queryRaw<Array<{ pts: bigint | number | null }>>`
    SELECT COALESCE(SUM("pointsBalance"), 0)::bigint AS pts FROM loyalty_accounts WHERE "tenantId" = ${tenantId}`
  const [pend] = await db.$queryRaw<Array<{ earn: bigint | number | null; out: bigint | number | null }>>`
    SELECT COALESCE(SUM(CASE WHEN t.type::text = 'earn' THEN t."pointsDelta" ELSE 0 END), 0)::bigint AS earn,
           COALESCE(SUM(CASE WHEN t.type::text IN ('redeem', 'expire') THEN -t."pointsDelta" ELSE 0 END), 0)::bigint AS out
      FROM loyalty_transactions t
      JOIN loyalty_accounts a ON a.id = t."loyaltyAccountId"
     WHERE a."tenantId" = ${tenantId}
       AND t."reversedAt" IS NULL
       AND ((t.type::text = 'earn' AND t."pointsDelta" > 0) OR (t.type::text IN ('redeem', 'expire') AND t."pointsDelta" < 0))
       AND NOT EXISTS (SELECT 1 FROM journal_entries j WHERE j.reference = 'loyalty.' || t.type::text || ':' || t.id)`
  const balancePoints = Number(bal?.pts ?? 0)
  const unpostedEarnPoints = Number(pend?.earn ?? 0)
  const unpostedOutPoints = Number(pend?.out ?? 0)
  return { points: balancePoints - unpostedEarnPoints + unpostedOutPoints, balancePoints, unpostedEarnPoints, unpostedOutPoints }
}

export interface RevaluationRecord {
  tenantId: string
  oldValueCents: number
  newValueCents: number
  points: number
  deltaCents: number
  balancePoints: number
  unpostedEarnPoints: number
  unpostedOutPoints: number
  changedAt: string
}

function linesFor(deltaCents: number, rec: Pick<RevaluationRecord, 'points' | 'oldValueCents' | 'newValueCents'>) {
  const amountCents = Math.abs(deltaCents)
  const what = `${rec.points} pts revalued from ${rec.oldValueCents} to ${rec.newValueCents} paisa a point`
  return deltaCents > 0
    ? [
        { accountCode: LOYALTY_MARKETING_ACCOUNT, type: 'debit' as const,  amountCents, memo: what },
        { accountCode: LOYALTY_LIABILITY_ACCOUNT, type: 'credit' as const, amountCents, memo: 'Liability revalued (point value up)' },
      ]
    : [
        { accountCode: LOYALTY_LIABILITY_ACCOUNT, type: 'debit' as const,  amountCents, memo: 'Liability revalued (point value down)' },
        { accountCode: LOYALTY_MARKETING_ACCOUNT, type: 'credit' as const, amountCents, memo: what },
      ]
}

async function postRevaluationTx(db: Db, sourceId: string, rec: RevaluationRecord, opts: RepostOptions & { postedBy?: string }) {
  const base = withLateNote(
    `Loyalty points revalued: ${rec.points.toLocaleString('en-PK')} points × (${rec.newValueCents} − ${rec.oldValueCents}) paisa`,
    linesFor(rec.deltaCents, rec),
    opts.memoNote,
  )
  return postJournalEntry({
    tenantId: rec.tenantId,
    sourceType: LOYALTY_REVALUE_SOURCE,
    sourceId,
    description: base.description,
    entryDate: opts.entryDate ?? new Date(rec.changedAt),
    postedBy: opts.postedBy ?? 'system',
    lines: base.lines,
  }, { tx: db })
}

/**
 * Write a company's loyalty settings and, when the point value changes,
 * revalue 2060 in the same transaction (see the header). The company's keys
 * must already be seeded (settings.ts saveCompanyLoyaltySettings does that).
 */
export async function writeLoyaltySettingsWithRevaluation(
  tenantId: string,
  writes: Array<[LoyaltySettingKey, number]>,
  actor: { userId?: string | null; userEmail?: string | null } = {},
): Promise<{ revaluation: (RevaluationRecord & { id: string; entryId: string | null; flagged: boolean }) | null }> {
  const changesValue = writes.some(([k]) => k === POINT_VALUE_KEY)

  const attempt = (post: boolean) => prisma.$transaction(async (db) => {
    if (changesValue) await lockLoyaltyValueTx(db, tenantId, 'exclusive')
    const oldValueCents = changesValue ? await pointValueCentsTx(db, tenantId) : 0
    for (const [k, value] of writes) {
      const key = settingKey(k, tenantId)
      await db.setting.upsert({ where: { key }, create: { key, value: String(value) }, update: { value: String(value) } })
    }
    if (!changesValue) return null
    const newValueCents = await pointValueCentsTx(db, tenantId)
    if (newValueCents === oldValueCents) return null

    const counted = await pointsInLedgerTx(db, tenantId)
    const rec: RevaluationRecord = {
      tenantId, oldValueCents, newValueCents,
      points: counted.points,
      deltaCents: counted.points * (newValueCents - oldValueCents),   // whole paisa: rounded once (exact)
      balancePoints: counted.balancePoints,
      unpostedEarnPoints: counted.unpostedEarnPoints,
      unpostedOutPoints: counted.unpostedOutPoints,
      changedAt: new Date().toISOString(),
    }
    const row = await db.auditLog.create({
      data: {
        category: 'accounting',
        tenantId,
        action: LOYALTY_REVALUE_SOURCE,
        entity: LOYALTY_REVALUE_ENTITY,
        entityId: tenantId,
        userId: actor.userId ?? null,
        userEmail: actor.userEmail ?? null,
        before: { [POINT_VALUE_KEY]: oldValueCents },
        after: { [POINT_VALUE_KEY]: newValueCents },
        metadata: { ...rec, posted: false } as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    })
    let entryId: string | null = null
    if (post && rec.deltaCents !== 0) {
      const r = await postRevaluationTx(db, row.id, rec, { postedBy: actor.userId ?? 'system' })
      entryId = r.entryId
      await db.auditLog.update({ where: { id: row.id }, data: { metadata: { ...rec, posted: true, entryId } as unknown as Prisma.InputJsonValue } })
    }
    return { ...rec, id: row.id, entryId, flagged: false }
  })

  try {
    return { revaluation: await attempt(true) }
  } catch (err) {
    if (!changesValue) throw err
    // The ledger refused the entry: the change still stands (it is the
    // operator's decision); save it with its record and flag the posting.
    const reason = (err as Error).message
    const saved = await attempt(false)
    if (saved && saved.deltaCents !== 0) {
      await flagPostingFailed({
        tenantId,
        sourceType: LOYALTY_REVALUE_SOURCE,
        sourceId: saved.id,
        entityType: LOYALTY_REVALUE_ENTITY,
        entityId: saved.id,
        reason,
        title: 'Loyalty revaluation did not reach the ledger',
        actorId: actor.userId ?? null,
        amountCents: Math.abs(saved.deltaCents),
        metadata: { documentDate: saved.changedAt, oldValueCents: saved.oldValueCents, newValueCents: saved.newValueCents, points: saved.points, deltaCents: saved.deltaCents },
      })
      return { revaluation: { ...saved, flagged: true } }
    }
    return { revaluation: saved }
  }
}

/** The stored record of one revaluation (the AuditLog row), or null. */
export async function loadRevaluation(id: string): Promise<RevaluationRecord | null> {
  const row = await prisma.auditLog.findFirst({ where: { id, action: LOYALTY_REVALUE_SOURCE }, select: { metadata: true } })
  const m = row?.metadata as Partial<RevaluationRecord> | null | undefined
  if (!m || typeof m.tenantId !== 'string' || typeof m.deltaCents !== 'number' || typeof m.changedAt !== 'string') return null
  return m as RevaluationRecord
}

/**
 * Re-post a refused revaluation: the STORED delta, nothing recomputed. On its
 * own date by default; the backfill passes entryDate / memoNote when that
 * month is closed.
 */
export async function postStoredRevaluation(id: string, opts: RepostOptions = {}): Promise<{ posted: boolean; entryId: string | null; reason?: string }> {
  const rec = await loadRevaluation(id)
  if (!rec) return { posted: false, entryId: null, reason: 'revaluation_not_found' }
  if (rec.deltaCents === 0) return { posted: false, entryId: null, reason: 'zero_delta' }
  const r = await prisma.$transaction((db) => postRevaluationTx(db, id, rec, opts))
  return { posted: r.posted, entryId: r.entryId }
}
