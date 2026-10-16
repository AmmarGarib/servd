// The notification bell — the ONE writer of StaffNotification (owner,
// 2026-10-16: "add a notification box in servd. mainly for Approvals, Night
// run reports, or warnings for any unusual activity performed by any user.
// Notification should be sent to concerned user.").
//
// The bell is ADVISORY. The module's own row (an approval item, an exception
// flag, a night-audit day) stays the record, and the approvals inbox /
// Exceptions page / Night audit page stay the places to act. Nothing the bell
// does may make the business action fail.
//
// Rules (tested in tests/staffNotify.test.ts):
//
//  • NEVER inside a business transaction. A failed insert inside a Postgres
//    transaction aborts it and would fail the sale / approval. Call sites run
//    AFTER their commit through `queueStaffNotify(() => …)`. Never call
//    `queueStaffNotify` inside a `$transaction(` callback or a function that
//    receives a `tx`: setImmediate would run before the commit, and announce a
//    row that is then rolled back (or see none). Losing a notice on a crash
//    between commit and notify is accepted — the inbox / Exceptions / Night
//    audit pages are the record. (The one exception is a WORKER-owned
//    transaction, workers/staffNotifications.ts, which claims exception flags
//    and inserts their notices together so a failure retries the claim:
//    `insertStaffNotificationsTx`.)
//  • Never the ACTOR of the event: a row whose recipient is the actor is
//    dropped.
//  • Company-scoped from the first row: `tenantId` is the EVENT's company
//    (approval subject owner, flag.tenantId, audited company) — never the
//    actor's active company. A recipient must be an active staff login
//    (isActive, accountStatus 'active', not deleted) who is a member of that
//    company (TenantMember ∪ User.tenantId) or reaches it through a live
//    head-office link. A NULL tenantId (a company-less approval item, CEO-only
//    by rule) is kept only for role 'admin' — deliberate.
//  • No secrets / customer PII in title or body (no hand-over codes, OTPs,
//    card codes, customer phone numbers). Amounts are fine: recipients see
//    them on the linked page anyway.
//  • `link` is an admin path starting with ONE '/' (CHECK
//    staff_notifications_link_chk): anything else is stored as null.
//  • Bounded: queued jobs run through one in-process queue (concurrency 2, at
//    most 1 000 waiting; overflow is logged and dropped — the approvals count
//    in the bell still shows it). The socket ping is never awaited.
//  • Bell only (owner, 2026-10-16: "Bell only for now"): no phone push, no
//    email, no WhatsApp from here. A future push must ask `sandboxBlocks`
//    first (lib/sandbox.ts).

import type { Prisma, PrismaClient } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import { serviceClient } from './prisma.js'
import { runWithRlsContext } from './rlsContext.js'
import { headOfficeReach } from './headOffice.js'
import { emitToUser } from './ws.js'

export type NotificationKind =
  | 'approval.waiting'        // an item entered a queue you can decide
  | 'approval.decided'        // your item was approved / rejected / returned / posted
  | 'night_audit.report'      // a sales day was audited: report ready
  | 'night_audit.closed'      // an audited sales day was closed (settled)
  | 'night_audit.awaiting'    // an audited sales day still not settled 2 working days later (H45)
  | 'exception'               // a new ExceptionFlag (CEO only, plus finance for night_audit_pending)
  | 'exception.digest'        // a burst of flags collapsed into one row
  | 'task.next'               // not an approval: your step is next (cash voucher pay / documents / verify)

export type NotificationSeverity = 'info' | 'success' | 'warning' | 'critical'

export interface NotifyInput {
  userId: string
  tenantId: string | null
  kind: NotificationKind
  severity?: NotificationSeverity
  title: string
  body?: string | null
  link?: string | null
  entityType?: string | null
  entityId?: string | null
  actorId?: string | null
  dedupeKey: string
}

export interface CreatedNotification { id: string; userId: string; kind: string }

/** Lengths the CHECK staff_notifications_len_chk enforces. */
export const TITLE_MAX = 140
export const BODY_MAX = 500
export const DEDUPE_KEY_MAX = 200

const SEVERITIES: ReadonlySet<string> = new Set(['info', 'success', 'warning', 'critical'])

/** Same rule as the CHECK: one leading '/', then not '/' or '\'. No //host, no absolute URL. */
export function isSafeLink(link: string | null | undefined): link is string {
  return typeof link === 'string' && /^\/[^/\\]/.test(link) && link.length <= 500
}

function cut(s: string, max: number): string {
  const t = s.trim()
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`
}

type Db = PrismaClient | Prisma.TransactionClient

/**
 * Filter `rows` to the recipients that may receive them (see the header) and
 * normalise each one. Reads users / memberships / head-office reach on `db`.
 */
async function eligibleRows(db: Db, rows: NotifyInput[]): Promise<Prisma.StaffNotificationCreateManyInput[]> {
  const shaped = rows.filter((r) =>
    r && typeof r.userId === 'string' && r.userId.length > 0
    && typeof r.dedupeKey === 'string' && r.dedupeKey.length > 0 && r.dedupeKey.length <= DEDUPE_KEY_MAX
    && typeof r.title === 'string' && r.title.trim().length > 0
    && (r.actorId == null || r.actorId !== r.userId),
  )
  if (shaped.length === 0) return []

  const userIds = [...new Set(shaped.map((r) => r.userId))]
  const users = await db.user.findMany({
    where: { id: { in: userIds }, isActive: true, accountStatus: 'active', deletedAt: null },
    select: { id: true, role: true, tenantId: true, tenantMemberships: { select: { tenantId: true } } },
  })
  const byId = new Map(users.map((u) => {
    const members = new Set<string>(u.tenantMemberships.map((m) => m.tenantId))
    if (u.tenantId) members.add(u.tenantId)
    return [u.id, { role: u.role as string, members, reach: null as Set<string> | null }]
  }))

  // Head-office reach only for recipients who are not members of a row's company.
  const needReach = new Set<string>()
  for (const r of shaped) {
    const u = byId.get(r.userId)
    if (u && r.tenantId && !u.members.has(r.tenantId) && u.members.size > 0) needReach.add(r.userId)
  }
  for (const id of needReach) {
    const u = byId.get(id)!
    const reach = await headOfficeReach([...u.members], db as PrismaClient)
    u.reach = new Set(reach.keys())
  }

  const out: Prisma.StaffNotificationCreateManyInput[] = []
  const seen = new Set<string>()
  for (const r of shaped) {
    const u = byId.get(r.userId)
    if (!u) continue
    if (r.tenantId == null) {
      if (u.role !== 'admin') continue
    } else if (!u.members.has(r.tenantId) && !(u.reach?.has(r.tenantId))) {
      continue
    }
    const key = `${r.userId}\u0000${r.dedupeKey}`
    if (seen.has(key)) continue
    seen.add(key)
    const body = typeof r.body === 'string' && r.body.trim().length > 0 ? cut(r.body, BODY_MAX) : null
    out.push({
      id: randomUUID(),
      tenantId: r.tenantId ?? null,
      userId: r.userId,
      kind: r.kind,
      severity: r.severity && SEVERITIES.has(r.severity) ? r.severity : 'info',
      title: cut(r.title, TITLE_MAX),
      body,
      link: isSafeLink(r.link) ? r.link : null,
      entityType: r.entityType ?? null,
      entityId: r.entityId ?? null,
      actorId: r.actorId ?? null,
      dedupeKey: r.dedupeKey,
    })
  }
  return out
}

/**
 * Filter + insert on `db` (a worker-owned transaction, or serviceClient).
 * THROWS on a database error so a worker's claim rolls back with it. Returns
 * only the rows that were NEW (a duplicate (userId, dedupeKey) is skipped).
 * Does not ping sockets — call `emitCreated` after the commit.
 */
export async function insertStaffNotificationsTx(db: Db, rows: NotifyInput[]): Promise<CreatedNotification[]> {
  const data = await eligibleRows(db, rows)
  if (data.length === 0) return []
  return db.staffNotification.createManyAndReturn({
    data,
    skipDuplicates: true,
    select: { id: true, userId: true, kind: true },
  })
}

/** Ping each recipient's socket room (`notification:new`, ids only). Never throws, never awaited. */
export function emitCreated(created: readonly CreatedNotification[]): void {
  for (const c of created) {
    try { emitToUser(c.userId, 'notification:new', { id: c.id, kind: c.kind }) } catch { /* best effort */ }
  }
}

/**
 * Insert notifications (skipDuplicates on (userId, dedupeKey)) and ping the
 * recipients that got a NEW row. NEVER throws: logs
 * `[staff-notify] <kind> failed: <message>` and returns 0. Uses serviceClient
 * (the bell is personal across the recipient's companies; the recipient /
 * company checks above are the wall).
 */
export async function notifyStaffMany(rows: NotifyInput[]): Promise<number> {
  if (!Array.isArray(rows) || rows.length === 0) return 0
  try {
    const created = await insertStaffNotificationsTx(serviceClient, rows)
    emitCreated(created)
    return created.length
  } catch (err) {
    const kinds = [...new Set(rows.map((r) => r?.kind).filter(Boolean))].join(',') || 'unknown'
    const msg = String((err as Error)?.message ?? err).split('\n').map((l) => l.trim()).filter(Boolean)
    console.warn(`[staff-notify] ${kinds} failed: ${msg[msg.length - 1] ?? 'unknown error'}`)
    return 0
  }
}

export const notifyStaff = (row: NotifyInput): Promise<number> => notifyStaffMany([row])

// ─── The queue: run notify jobs AFTER the business commit ────────────────────

const CONCURRENCY = 2
const MAX_WAITING = 1000
const waiting: Array<() => Promise<unknown>> = []
const inFlight = new Set<Promise<unknown>>()
let running = 0
let scheduled = false

function pump(): void {
  scheduled = false
  while (running < CONCURRENCY && waiting.length > 0) {
    const fn = waiting.shift()!
    running++
    // A FRESH RLS context: recipient resolution (synthetic requests, widenRls)
    // can never widen — or read — the calling request's context.
    const p: Promise<unknown> = runWithRlsContext(
      { tenantIds: [], customerId: null, staffUserId: null },
      () => Promise.resolve().then(fn),
    )
      .catch((err) => {
        console.warn(`[staff-notify] queued job failed: ${(err as Error)?.message ?? String(err)}`)
      })
      .finally(() => {
        running--
        inFlight.delete(p)
        schedule()
      })
    inFlight.add(p)
  }
}

function schedule(): void {
  if (scheduled || waiting.length === 0) return
  scheduled = true
  setImmediate(pump)
}

/**
 * Fire-and-forget AFTER the business commit. `fn` runs on a later tick in a
 * fresh, empty RLS context; its errors are logged, never rethrown. Never call
 * this inside a `$transaction` callback (see the header).
 */
export function queueStaffNotify(fn: () => Promise<unknown>): void {
  if (typeof fn !== 'function') return
  if (waiting.length >= MAX_WAITING) {
    console.warn('[staff-notify] queue full — notification dropped (the inbox counts still show it)')
    return
  }
  waiting.push(fn)
  schedule()
}

/** Tests only: await every queued and running notify job (including ones they queue). */
export async function flushNotifications(): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    if (waiting.length === 0 && inFlight.size === 0) return
    await Promise.allSettled([...inFlight])
  }
}
