// The notification bell's worker (owner, 2026-10-16) — two jobs, every 60 s
// under ENABLE_WORKERS:
//
// 1. Unusual activity → the CEO(s) of that company. `flagException` is NOT
//    the only writer of ExceptionFlag (orders, the till's on-account tender,
//    the fiscal outbox, connector alerts, Raast intake / match, the
//    on-account daily worker all create flags directly, some inside their
//    business transactions). So the bell never hooks a writer: it CLAIMS
//    committed flags here.
//      • Claim, don't watermark: one worker-owned transaction per batch —
//        UPDATE exception_flags SET "notifiedAt" … WHERE id IN (SELECT …
//        "notifiedAt" IS NULL AND "createdAt" within 2 days … FOR UPDATE SKIP
//        LOCKED) RETURNING id — then the notices are inserted in the SAME
//        transaction (lib/staffNotify.ts insertStaffNotificationsTx), so a
//        failure rolls the claim back and the next tick retries. Only
//        COMMITTED flags are visible, so a flag of a rolled-back transaction
//        is never announced and a late-committing one is never missed.
//        SKIP LOCKED makes two API processes safe. Flags older than 2 days
//        are left on the Exceptions page (no flood after an outage; the
//        migration stamps every existing flag).
//      • Which flags (owner Q1 default): performed by a user (actorId set),
//        or severity high / critical, or a kind in ALWAYS_NOTIFY. Others stay
//        on the Exceptions page only (they are still claimed).
//      • Who: the active `admin` logins who are members of the flag's company
//        (owner: "Warnings = CEO only") minus the flag's actor — plus finance
//        (with `accounting`) for `night_audit_pending`, which is a night-run
//        notice, not unusual activity. A company-less flag is claimed and
//        skipped.
//      • A burst — more than DIGEST_OVER qualifying flags for one (recipient,
//        company) in one batch — becomes ONE `exception.digest` row. The
//        claim guarantees a flag is in one batch only, so it is never
//        announced both singly and in a digest.
//    This is a WORKER transaction, not a business one: lib/staffNotify.ts's
//    "never inside a business transaction" rule is about sale / approval paths.
//
// 2. Retention, once a Karachi day after 03:50 PKT: read rows older than 90
//    days and any row older than 180 days are deleted, 5 000 at a time.
//    There is no user delete route (rows are only marked read), so the Trash
//    bin needs no provider.

import { serviceClient } from '../lib/prisma.js'
import {
  insertStaffNotificationsTx, emitCreated,
  type NotifyInput, type CreatedNotification,
} from '../lib/staffNotify.js'
import type { ExceptionKind } from '../lib/exceptions.js'
import { ceosOf, financeOf } from '../lib/staffNotifyRecipients.js'

export const STAFF_NOTIFICATIONS_INTERVAL_MS = 60_000
const FIRST_TICK_MS = 45_000
export const CLAIM_BATCH = 200
/** More than this many qualifying flags for one recipient + company in a batch → one digest. */
export const DIGEST_OVER = 10
/** Flags older than this are never announced (they stay on the Exceptions page). */
export const CLAIM_WINDOW_DAYS = 2

export const READ_RETENTION_DAYS = 90
export const ANY_RETENTION_DAYS = 180
const RETENTION_BATCH = 5000
const RETENTION_AT_PKT_MINUTES = 3 * 60 + 50   // 03:50 PKT
const PKT_OFFSET_MS = 5 * 3_600_000

/** Kinds always announced, whoever (or whatever) raised them. */
export const ALWAYS_NOTIFY: ReadonlySet<ExceptionKind> = new Set<ExceptionKind>([
  'self_approval', 'pii_export', 'manager_pin_failed', 'consecutive_voids',
  'high_value_void', 'backdated_sale_change', 'night_audit_override', 'night_audit_reopened',
  'night_audit_pending', 'period_reopened', 'period_close_override', 'manual_journal',
  'wage_change', 'ghost_employee', 'delivery_code_rerouted',
])

/** Who hears a flag kind. Default: the CEO(s) only. */
export const FLAG_ROUTES: Partial<Record<ExceptionKind, ReadonlyArray<'ceo' | 'finance'>>> = {
  night_audit_pending: ['ceo', 'finance'],
}

type ClaimedFlag = {
  id: string
  tenantId: string | null
  kind: string
  severity: string
  title: string
  description: string
  metadata: unknown
  actorId: string | null
  entityType: string | null
  entityId: string | null
}

/** Does this flag reach the bell? (owner Q1 default) */
export function flagQualifies(f: Pick<ClaimedFlag, 'actorId' | 'severity' | 'kind'>): boolean {
  return f.actorId != null
    || f.severity === 'high' || f.severity === 'critical'
    || ALWAYS_NOTIFY.has(f.kind as ExceptionKind)
}

function flagLink(f: ClaimedFlag): string {
  if (f.kind.startsWith('night_audit_')) {
    const day = (f.metadata as { day?: unknown } | null)?.day
    if (typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day)) return `/finance/night-audit?day=${day}`
    return '/finance/night-audit'
  }
  return `/exceptions?flag=${encodeURIComponent(f.id)}`
}

async function recipientsOf(f: ClaimedFlag, cache: Map<string, Promise<string[]>>): Promise<string[]> {
  if (!f.tenantId) return []
  const routes = FLAG_ROUTES[f.kind as ExceptionKind] ?? ['ceo']
  const ids = new Set<string>()
  for (const r of routes) {
    const key = `${r}:${f.tenantId}`
    let p = cache.get(key)
    if (!p) {
      p = r === 'ceo' ? ceosOf(f.tenantId) : financeOf(f.tenantId)
      cache.set(key, p)
    }
    for (const id of await p) ids.add(id)
  }
  if (f.actorId) ids.delete(f.actorId)
  return [...ids]
}

/** The notice rows for one claimed batch (singles, or a digest per busy recipient + company). */
export async function rowsForFlags(flags: ClaimedFlag[]): Promise<NotifyInput[]> {
  const cache = new Map<string, Promise<string[]>>()
  const perPair = new Map<string, { userId: string; tenantId: string; flags: ClaimedFlag[] }>()
  for (const f of flags) {
    if (!f.tenantId || !flagQualifies(f)) continue
    for (const userId of await recipientsOf(f, cache)) {
      const key = `${userId}\u0000${f.tenantId}`
      const pair = perPair.get(key) ?? { userId, tenantId: f.tenantId, flags: [] }
      pair.flags.push(f)
      perPair.set(key, pair)
    }
  }
  const tenantIds = [...new Set([...perPair.values()].map((p) => p.tenantId))]
  const names = new Map(
    tenantIds.length > 0
      ? (await serviceClient.tenant.findMany({ where: { id: { in: tenantIds } }, select: { id: true, name: true } }))
          .map((t) => [t.id, t.name] as const)
      : [],
  )
  const rows: NotifyInput[] = []
  for (const p of perPair.values()) {
    if (p.flags.length > DIGEST_OVER) {
      const worst = p.flags.some((f) => f.severity === 'critical') ? 'critical' : 'warning'
      rows.push({
        userId: p.userId,
        tenantId: p.tenantId,
        kind: 'exception.digest',
        severity: worst,
        title: `${p.flags.length} new warnings in ${names.get(p.tenantId) ?? 'your company'}`,
        body: 'Open the Exceptions page to review them.',
        link: '/exceptions',
        dedupeKey: `exception.digest:${p.tenantId}:${p.flags[0]!.id}`,
      })
      continue
    }
    for (const f of p.flags) {
      rows.push({
        userId: p.userId,
        tenantId: p.tenantId,
        kind: 'exception',
        severity: f.severity === 'critical' ? 'critical' : 'warning',
        title: f.title,
        body: f.description ? f.description.slice(0, 300) : null,
        link: flagLink(f),
        entityType: 'ExceptionFlag',
        entityId: f.id,
        actorId: f.actorId,
        dedupeKey: `exception:${f.id}`,
      })
    }
  }
  return rows
}

/**
 * Claim one batch of unannounced, committed flags and insert their notices in
 * the same transaction. Returns how many flags were claimed (a full batch
 * means "run again") and the new notices. Safe to run concurrently (SKIP LOCKED).
 */
export async function claimAndNotifyBatch(batch = CLAIM_BATCH): Promise<{ claimed: number; created: CreatedNotification[] }> {
  const out = await serviceClient.$transaction(async (tx) => {
    // Timestamps are stored as UTC wall time (timestamp without time zone).
    const claimed = await tx.$queryRaw<Array<{ id: string }>>`
      UPDATE "exception_flags" SET "notifiedAt" = (now() AT TIME ZONE 'UTC')
       WHERE "id" IN (
         SELECT "id" FROM "exception_flags"
          WHERE "notifiedAt" IS NULL
            AND "createdAt" > (now() AT TIME ZONE 'UTC') - make_interval(days => ${CLAIM_WINDOW_DAYS}::int)
          ORDER BY "createdAt", "id"
          LIMIT ${batch}::int
          FOR UPDATE SKIP LOCKED)
      RETURNING "id"`
    if (claimed.length === 0) return { claimed: 0, created: [] as CreatedNotification[] }
    // Re-read through the model API (raw SQL would hand back amountCents as bigint).
    const flags = await tx.exceptionFlag.findMany({
      where: { id: { in: claimed.map((c) => c.id) } },
      select: {
        id: true, tenantId: true, kind: true, severity: true, title: true, description: true,
        metadata: true, actorId: true, entityType: true, entityId: true, createdAt: true,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })
    const rows = await rowsForFlags(flags as ClaimedFlag[])
    const created = rows.length > 0 ? await insertStaffNotificationsTx(tx, rows) : []
    return { claimed: claimed.length, created }
  }, { timeout: 30_000 })
  emitCreated(out.created)
  return out
}

/** Delete read rows older than 90 days and any row older than 180 days, in batches. */
export async function runStaffNotificationRetention(now: Date = new Date()): Promise<number> {
  const readBefore = new Date(now.getTime() - READ_RETENTION_DAYS * 86_400_000)
  const anyBefore = new Date(now.getTime() - ANY_RETENTION_DAYS * 86_400_000)
  let removed = 0
  for (let i = 0; i < 1000; i++) {
    const ids = await serviceClient.staffNotification.findMany({
      where: { OR: [{ readAt: { not: null }, createdAt: { lt: readBefore } }, { createdAt: { lt: anyBefore } }] },
      select: { id: true },
      take: RETENTION_BATCH,
    })
    if (ids.length === 0) break
    const res = await serviceClient.staffNotification.deleteMany({ where: { id: { in: ids.map((r) => r.id) } } })
    removed += res.count
    if (ids.length < RETENTION_BATCH) break
  }
  return removed
}

let running = false
let timer: NodeJS.Timeout | null = null
let lastRetentionDay: string | null = null

/** One tick: claim until a batch comes back short; retention once a Karachi day after 03:50. */
export async function runStaffNotificationsOnce(now: Date = new Date()): Promise<{ claimed: number; notified: number; retired: number }> {
  if (running) return { claimed: 0, notified: 0, retired: 0 }
  running = true
  let claimed = 0
  let notified = 0
  let retired = 0
  try {
    for (let i = 0; i < 50; i++) {
      const r = await claimAndNotifyBatch()
      claimed += r.claimed
      notified += r.created.length
      if (r.claimed < CLAIM_BATCH) break
    }
    const pkt = new Date(now.getTime() + PKT_OFFSET_MS)
    const day = pkt.toISOString().slice(0, 10)
    const minutes = pkt.getUTCHours() * 60 + pkt.getUTCMinutes()
    if (minutes >= RETENTION_AT_PKT_MINUTES && lastRetentionDay !== day) {
      lastRetentionDay = day
      retired = await runStaffNotificationRetention(now)
    }
  } catch (err) {
    console.warn(`[staff-notifications] tick failed: ${(err as Error)?.message ?? String(err)}`)
  } finally {
    running = false
  }
  return { claimed, notified, retired }
}

/** Every 60 s (setInterval, unref), first tick after 45 s. Posts nothing. */
export function startStaffNotificationsWorker(): { stop: () => void } {
  if (!timer) {
    const tick = () => { void runStaffNotificationsOnce() }
    const first = setTimeout(tick, FIRST_TICK_MS)
    first.unref()
    timer = setInterval(tick, STAFF_NOTIFICATIONS_INTERVAL_MS)
    timer.unref()
  }
  return {
    stop: () => {
      if (timer) clearInterval(timer)
      timer = null
    },
  }
}
