// The night audit — SALES module only (owner, 2026-10-16). Contract: ./README.md.
//
// One NightAuditDay row per company per Karachi business date (no row = open):
//   open ──run (finance / CEO)──▶ audited ("awaiting settlement"; LOCKED for
//   sales postings: nightAudit/lock.ts) ──settle (auto / manual / CEO
//   override)──▶ closed (still locked). The CEO alone reopens a day (→ open).
// Nothing here posts to the ledger.

import { Prisma } from '@prisma/client'
import { serviceClient as prisma } from '../../lib/prisma.js'
import { AppError } from '../../lib/errors.js'
import { audit } from '../../lib/audit.js'
import { flagException } from '../../lib/exceptions.js'
import { fmtPktDate, parsePktEndOfDay, parsePktStartOfDay } from '../accounting/dates.js'
import { toCents } from '../../lib/money.js'
import { isNightOverridableKey, nightChecklist, type NightChecklist } from './checks.js'
import { activityDaysBetween } from './activity.js'
import { buildDailyReport, type DailyReport } from './report.js'
import { MIN_REASON, NIGHT_AUDIT_RUNNERS, type CheckLine, type CloseProblem, type HistoryEntry, type LastCheck, type NightPhase } from './types.js'

type Tx = Prisma.TransactionClient
type Row = Prisma.NightAuditDayGetPayload<object>

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const TX_OPTS = { maxWait: 15_000, timeout: 120_000 } as const

export interface Actor { id: string; role: string; email?: string | null }
export interface Acknowledge { keys: string[]; reason: string }

/** 422 INVALID_DATE unless `day` is a real 'YYYY-MM-DD'. */
export function assertDay(day: string): string {
  const m = DAY_RE.exec(day)
  if (!m) throw new AppError('INVALID_DATE', 'Give the day as YYYY-MM-DD', 422)
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  if (d.toISOString().slice(0, 10) !== day) throw new AppError('INVALID_DATE', `${day} is not a date`, 422)
  return day
}

export const todayPkt = (now: Date = new Date()): string => fmtPktDate(now)

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

const lineOf = (p: CloseProblem): CheckLine => ({ key: p.key, title: p.title, count: p.count, ...(p.cents ? { cents: p.cents } : {}) })

function lastCheckOf(c: NightChecklist): LastCheck {
  return {
    phase: c.phase,
    at: new Date().toISOString(),
    blocks: c.blocks.map(lineOf),
    warnings: c.warnings.map((w) => ({ key: w.key, title: w.title, count: w.count })),
  }
}

function historyOf(v: Prisma.JsonValue | null | undefined): HistoryEntry[] {
  return Array.isArray(v) ? (v as unknown as HistoryEntry[]) : []
}

const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue

async function periodLockedThrough(db: Tx | typeof prisma, tenantId: string): Promise<Date | null> {
  const lock = await db.periodLock.findFirst({ where: { tenantId }, orderBy: { lockedThrough: 'desc' }, select: { lockedThrough: true } })
  return lock?.lockedThrough ?? null
}

async function lockTenant(tx: Tx, tenantId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`night-audit:${tenantId}`}))`
}

/** Validate an acknowledge (CEO only, reason ≥ 10, every key overridable). */
function checkAcknowledge(ack: Acknowledge | undefined, actor: Actor | null): Acknowledge | undefined {
  if (!ack) return undefined
  if (actor?.role !== 'admin') {
    throw new AppError('OVERRIDE_CEO_ONLY', 'Only the CEO can push a day past its blocks', 403)
  }
  const reason = (ack.reason ?? '').trim()
  if (reason.length < MIN_REASON) {
    throw new AppError('OVERRIDE_REASON_REQUIRED', `Give the reason (at least ${MIN_REASON} characters)`, 422)
  }
  const bad = ack.keys.filter((k) => !isNightOverridableKey(k))
  if (bad.length > 0) throw new AppError('NOT_OVERRIDABLE', `These cannot be pushed past: ${bad.join(', ')}`, 422, { keys: bad })
  return { keys: [...new Set(ack.keys)], reason }
}

/** Active SALES days of the company in [startDay, day) not yet audited / closed. */
async function earlierOpenDays(db: Tx | typeof prisma, tenantId: string, startDay: string | null, day: string): Promise<string[]> {
  if (!startDay || startDay >= day) return []
  const days = await activityDaysBetween(db, tenantId, startDay, addDays(day, -1))
  if (days.length === 0) return []
  const done = new Set((await db.nightAuditDay.findMany({
    where: { tenantId, businessDate: { in: days }, status: { in: ['audited', 'closed'] } },
    select: { businessDate: true },
  })).map((r) => r.businessDate))
  return days.filter((d) => !done.has(d))
}

// ─── Run (open → audited) ────────────────────────────────────────────────────

export async function runNightAudit(input: { tenantId: string; day: string; actor: Actor; acknowledge?: Acknowledge }): Promise<void> {
  const { tenantId, actor } = input
  const day = assertDay(input.day)
  if (day >= todayPkt()) throw new AppError('DAY_NOT_OVER', `${day} is not over yet — run the night audit once the day has ended`, 422)
  const lock = await periodLockedThrough(prisma, tenantId)
  if (lock && parsePktEndOfDay(day) <= lock) {
    throw new AppError('DAY_IN_CLOSED_PERIOD', `${day} is inside a closed period (books closed through ${fmtPktDate(lock)})`, 409)
  }
  const ack = checkAcknowledge(input.acknowledge, actor)

  type Outcome = { ok: true; overrides: CheckLine[] | null; checks: NightChecklist } | { ok: false; checks: NightChecklist; missing: string[] }
  const outcome: Outcome = await prisma.$transaction(async (tx) => {
    await lockTenant(tx, tenantId)
    const row = await tx.nightAuditDay.findUnique({ where: { tenantId_businessDate: { tenantId, businessDate: day } } })
    if (row && row.status !== 'open') throw new AppError('ALREADY_AUDITED', `${day} is already ${row.status}`, 409, { status: row.status })
    const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { nightAuditStartDay: true } })
    const earlier = await earlierOpenDays(tx, tenantId, tenant.nightAuditStartDay, day)
    if (earlier.length > 0) {
      throw new AppError('EARLIER_DAYS_OPEN', `Run the earlier sales days first: ${earlier.slice(0, 7).join(', ')}${earlier.length > 7 ? ', …' : ''}`, 409, { days: earlier })
    }
    const checks = await nightChecklist(tx, tenantId, day, 'night')
    const acked = new Set(ack?.keys ?? [])
    const missing = checks.blocks.filter((b) => !acked.has(b.key)).map((b) => b.key)
    const lastCheck = json(lastCheckOf(checks))
    const now = new Date()
    if (missing.length > 0) {
      await tx.nightAuditDay.upsert({
        where: { tenantId_businessDate: { tenantId, businessDate: day } },
        create: { tenantId, businessDate: day, lastCheck, lastCheckedAt: now },
        update: { lastCheck, lastCheckedAt: now },
      })
      return { ok: false as const, checks, missing }
    }
    const overrides = checks.blocks.length > 0 ? checks.blocks.map(lineOf) : null
    const report = await buildDailyReport(tx, tenantId, day, { generatedById: actor.id, checks: { night: checks.problems } })
    const prevReport = (row?.report ?? null) as { previousRuns?: unknown[] } | null
    const fullReport: DailyReport = { ...report, ...(prevReport?.previousRuns?.length ? { previousRuns: prevReport.previousRuns } : {}) }
    const history = [...historyOf(row?.history), {
      at: now.toISOString(), byId: actor.id, action: overrides ? 'run_override' : 'run', from: 'open', to: 'audited',
      ...(overrides ? { reason: ack!.reason, keys: overrides.map((o) => o.key) } : {}),
    } satisfies HistoryEntry]
    const data = {
      status: 'audited' as const, auditedAt: now, auditedById: actor.id,
      nightOverrideReason: overrides ? ack!.reason : null,
      closedAt: null, closedById: null, closedVia: null, settlementOverrideReason: null,
      report: json(fullReport), lastCheck, lastCheckedAt: now, history: json(history),
    }
    await tx.nightAuditDay.upsert({
      where: { tenantId_businessDate: { tenantId, businessDate: day } },
      create: { tenantId, businessDate: day, ...data, nightOverrides: overrides ? json(overrides) : Prisma.DbNull },
      update: { ...data, nightOverrides: overrides ? json(overrides) : Prisma.DbNull, settlementOverrides: Prisma.DbNull },
    })
    if (!tenant.nightAuditStartDay) await tx.tenant.update({ where: { id: tenantId }, data: { nightAuditStartDay: day } })
    return { ok: true as const, overrides, checks }
  }, TX_OPTS)

  if (!outcome.ok) {
    throw new AppError('NIGHT_AUDIT_NOT_READY', `${day} cannot be audited yet: ${outcome.checks.blocks.map((b) => b.title).join('; ')}`, 409, {
      problems: outcome.checks.problems, blocks: outcome.checks.blocks, ...(ack ? { missing: outcome.missing } : {}),
    })
  }
  await audit({
    category: 'accounting', action: outcome.overrides ? 'night_audit.override' : 'night_audit.run',
    entity: 'NightAuditDay', entityId: `${tenantId}:${day}`, userId: actor.id, userEmail: actor.email ?? null, tenantId,
    metadata: { day, ...(outcome.overrides ? { overrides: outcome.overrides, reason: ack!.reason } : {}), warnings: outcome.checks.warnings.map((w) => w.key) },
  })
  if (outcome.overrides) {
    await flagException({
      tenantId, kind: 'night_audit_override', severity: 'high',
      title: `Night audit of ${day} run over ${outcome.overrides.length} block(s)`,
      description: `The CEO audited ${day} over: ${outcome.overrides.map((o) => o.title).join('; ')}. Reason: ${ack!.reason}`,
      entityType: 'NightAuditDay', entityId: `${tenantId}:${day}`, actorId: actor.id,
      metadata: { day, phase: 'night', keys: outcome.overrides.map((o) => o.key), reason: ack!.reason },
    })
  }
  // Try to close it straight away (a day with no card / bank money settles at once).
  await settleDay({ tenantId, day, actor: null, auto: true }).catch((err) => {
    console.error(`[night-audit] auto settle of ${tenantId} ${day} failed:`, (err as Error).message)
  })
}

// ─── Settle (audited → closed) ───────────────────────────────────────────────

async function closingOf(tx: Tx, tenantId: string, day: string, bankUnmatched: number): Promise<NonNullable<DailyReport['closing']>> {
  const cardDays = await tx.cardSettlementDay.findMany({ where: { tenantId, day }, select: { grossCents: true, settlement: { select: { grossCents: true, feeCents: true } } } })
  let settled = 0, fee = 0
  for (const c of cardDays) {
    const g = toCents(c.grossCents)
    settled += g
    const sg = toCents(c.settlement.grossCents)
    if (sg > 0) fee += Math.round(toCents(c.settlement.feeCents) * (g / sg))
  }
  const from = parsePktStartOfDay(day), to = parsePktEndOfDay(day)
  const dayWhere = { tenantId, OR: [{ confirmedAt: { gte: from, lte: to } }, { confirmedAt: null, createdAt: { gte: from, lte: to } }] }
  const matched = await tx.raastReceipt.count({ where: { ...dayWhere, status: 'matched' } })
  const open = await tx.raastReceipt.count({ where: { ...dayWhere, status: { in: ['provisional', 'needs_attention'] } } })
  return { at: new Date().toISOString(), card: { settledCents: settled, feeCents: fee }, bank: { unmatchedLines: bankUnmatched }, raast: { matched, open } }
}

/**
 * Settle one audited day. `auto` (after a run, the worker, a nudge) never
 * throws for a day that is not ready / not audited — it stores lastCheck.
 * Manual (finance / CEO): 409 NOT_AUDITED, 409 SETTLEMENT_NOT_READY.
 */
export async function settleDay(input: { tenantId: string; day: string; actor: Actor | null; auto?: boolean; acknowledge?: Acknowledge }): Promise<'closed' | 'audited' | 'skipped'> {
  const { tenantId, actor } = input
  const day = assertDay(input.day)
  const ack = checkAcknowledge(input.acknowledge, actor)
  const r = await prisma.$transaction(async (tx) => {
    await lockTenant(tx, tenantId)
    const row = await tx.nightAuditDay.findUnique({ where: { tenantId_businessDate: { tenantId, businessDate: day } } })
    if (!row || row.status !== 'audited') {
      if (input.auto) return { state: 'skipped' as const }
      throw new AppError('NOT_AUDITED', row?.status === 'closed' ? `${day} is already closed` : `${day} has not been night-audited`, 409, { status: row?.status ?? 'open' })
    }
    const checks = await nightChecklist(tx, tenantId, day, 'settlement')
    const acked = new Set(ack?.keys ?? [])
    const missing = checks.blocks.filter((b) => !acked.has(b.key)).map((b) => b.key)
    const now = new Date()
    const lastCheck = json(lastCheckOf(checks))
    if (missing.length > 0) {
      await tx.nightAuditDay.update({ where: { id: row.id }, data: { lastCheck, lastCheckedAt: now } })
      return { state: 'not_ready' as const, checks, missing }
    }
    const overrides = checks.blocks.length > 0 ? checks.blocks.map(lineOf) : null
    const via = overrides ? 'override' : input.auto ? 'auto' : 'manual'
    const bankUnmatched = checks.problems.find((p) => p.key === 'sales_bank_unmatched')?.count ?? 0
    const report = (row.report ?? null) as DailyReport | null
    const closing = await closingOf(tx, tenantId, day, bankUnmatched)
    const nextReport = report ? { ...report, checks: { ...report.checks, settlement: checks.problems }, closing } : null
    const history = [...historyOf(row.history), {
      at: now.toISOString(), byId: actor?.id ?? null, action: overrides ? 'settle_override' : `settle_${via}`, from: 'audited', to: 'closed',
      ...(overrides ? { reason: ack!.reason, keys: overrides.map((o) => o.key) } : {}),
    } satisfies HistoryEntry]
    await tx.nightAuditDay.update({
      where: { id: row.id },
      data: {
        status: 'closed', closedAt: now, closedById: input.auto ? null : (actor?.id ?? null), closedVia: via,
        ...(overrides ? { settlementOverrides: json(overrides), settlementOverrideReason: ack!.reason } : {}),
        ...(nextReport ? { report: json(nextReport) } : {}),
        lastCheck, lastCheckedAt: now, history: json(history),
      },
    })
    return { state: 'closed' as const, overrides, checks }
  }, TX_OPTS)

  if (r.state === 'skipped') return 'skipped'
  if (r.state === 'not_ready') {
    if (input.auto) return 'audited'
    throw new AppError('SETTLEMENT_NOT_READY', `${day} cannot close yet: ${r.checks.blocks.map((b) => b.title).join('; ')}`, 409, {
      problems: r.checks.problems, blocks: r.checks.blocks, ...(ack ? { missing: r.missing } : {}),
    })
  }
  if (r.overrides) {
    await audit({
      category: 'accounting', action: 'night_audit.settle_override', entity: 'NightAuditDay', entityId: `${tenantId}:${day}`,
      userId: actor?.id ?? null, userEmail: actor?.email ?? null, tenantId, metadata: { day, overrides: r.overrides, reason: ack!.reason },
    })
    await flagException({
      tenantId, kind: 'night_audit_override', severity: 'high',
      title: `Sales day ${day} closed over ${r.overrides.length} settlement block(s)`,
      description: `The CEO closed ${day} over: ${r.overrides.map((o) => o.title).join('; ')}. Reason: ${ack!.reason}`,
      entityType: 'NightAuditDay', entityId: `${tenantId}:${day}`, actorId: actor?.id ?? null,
      metadata: { day, phase: 'settlement', keys: r.overrides.map((o) => o.key), reason: ack!.reason },
    })
  } else if (!input.auto) {
    await audit({
      category: 'accounting', action: 'night_audit.settle', entity: 'NightAuditDay', entityId: `${tenantId}:${day}`,
      userId: actor?.id ?? null, userEmail: actor?.email ?? null, tenantId, metadata: { day },
    })
  }
  return 'closed'
}

/**
 * Re-check the company's audited days (least recently checked first, at most `limit`), closing
 * the ones whose settlement is now clear. `staleMinutes`: only days last
 * checked longer ago than that. `from` / `to` limit the dates.
 */
export async function refreshAuditedDays(tenantId: string, opts: { from?: string; to?: string; staleMinutes?: number; limit?: number } = {}): Promise<{ checked: number; closed: number }> {
  const stale = opts.staleMinutes != null ? new Date(Date.now() - opts.staleMinutes * 60_000) : null
  const rows = await prisma.nightAuditDay.findMany({
    where: {
      tenantId, status: 'audited',
      ...(opts.from || opts.to ? { businessDate: { ...(opts.from ? { gte: opts.from } : {}), ...(opts.to ? { lte: opts.to } : {}) } } : {}),
      ...(stale ? { OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: stale } }] } : {}),
    },
    select: { businessDate: true },
    // Least recently checked first, so `limit` rotates through a long backlog.
    orderBy: [{ lastCheckedAt: { sort: 'asc', nulls: 'first' } }, { businessDate: 'asc' }],
    take: opts.limit ?? 62,
  })
  let closed = 0
  for (const r of rows) {
    try {
      if (await settleDay({ tenantId, day: r.businessDate, actor: null, auto: true }) === 'closed') closed++
    } catch (err) {
      console.error(`[night-audit] refresh ${tenantId} ${r.businessDate} failed:`, (err as Error).message)
    }
  }
  return { checked: rows.length, closed }
}

// ─── Reopen (CEO) ────────────────────────────────────────────────────────────

export async function reopenDay(input: { tenantId: string; day: string; actor: Actor; reason: string }): Promise<void> {
  const { tenantId, actor } = input
  const day = assertDay(input.day)
  const reason = (input.reason ?? '').trim()
  if (reason.length < MIN_REASON) throw new AppError('REASON_REQUIRED', `Give the reason (at least ${MIN_REASON} characters)`, 422)
  const prev = await prisma.$transaction(async (tx) => {
    await lockTenant(tx, tenantId)
    const row = await tx.nightAuditDay.findUnique({ where: { tenantId_businessDate: { tenantId, businessDate: day } } })
    if (!row || row.status === 'open') throw new AppError('NOT_AUDITED', `${day} is not night-audited`, 409)
    const lock = await periodLockedThrough(tx, tenantId)
    if (lock && parsePktEndOfDay(day) <= lock) {
      throw new AppError('DAY_IN_CLOSED_PERIOD', `${day} is inside a closed period (books closed through ${fmtPktDate(lock)})`, 409)
    }
    const now = new Date()
    const report = (row.report ?? null) as (DailyReport & { previousRuns?: unknown[] }) | null
    let nextReport: unknown = null
    if (report) {
      const { previousRuns = [], ...snapshot } = report
      nextReport = { ...report, previousRuns: [{ ...snapshot, status: row.status, auditedAt: row.auditedAt, auditedById: row.auditedById, closedAt: row.closedAt, closedVia: row.closedVia, nightOverrides: row.nightOverrides, settlementOverrides: row.settlementOverrides }, ...previousRuns].slice(0, 5) }
    }
    const history = [...historyOf(row.history), { at: now.toISOString(), byId: actor.id, action: 'reopen', from: row.status, to: 'open', reason } satisfies HistoryEntry]
    await tx.nightAuditDay.update({
      where: { id: row.id },
      data: {
        status: 'open', auditedAt: null, auditedById: null, closedAt: null, closedById: null, closedVia: null,
        nightOverrides: Prisma.DbNull, nightOverrideReason: null,
        settlementOverrides: Prisma.DbNull, settlementOverrideReason: null,
        report: nextReport === null ? Prisma.DbNull : json(nextReport),
        reopenCount: { increment: 1 }, history: json(history),
      },
    })
    return row.status
  }, TX_OPTS)
  await audit({
    category: 'accounting', action: 'night_audit.reopen', entity: 'NightAuditDay', entityId: `${tenantId}:${day}`,
    userId: actor.id, userEmail: actor.email ?? null, tenantId, before: { status: prev }, after: { status: 'open' }, metadata: { day, reason },
  })
  await flagException({
    tenantId, kind: 'night_audit_reopened', severity: 'high',
    title: `Sales day ${day} reopened by the CEO`,
    description: `The CEO reopened ${day} (it was ${prev}). Reason: ${reason}. Sales postings into that day are allowed again until it is re-run.`,
    entityType: 'NightAuditDay', entityId: `${tenantId}:${day}`, actorId: actor.id, metadata: { day, reason, from: prev },
  })
}

// ─── Start day (CEO) ─────────────────────────────────────────────────────────

export async function setStartDay(input: { tenantId: string; startDay: string | null; actor: Actor; reason: string }): Promise<{ startDay: string | null }> {
  const { tenantId, actor } = input
  if (input.startDay !== null) assertDay(input.startDay)
  const reason = (input.reason ?? '').trim()
  if (reason.length < MIN_REASON) throw new AppError('REASON_REQUIRED', `Give the reason (at least ${MIN_REASON} characters)`, 422)
  const before = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { nightAuditStartDay: true } })
  if (input.startDay) {
    const earlier = await prisma.nightAuditDay.findFirst({
      where: { tenantId, status: { in: ['audited', 'closed'] }, businessDate: { lt: input.startDay } },
      select: { businessDate: true }, orderBy: { businessDate: 'asc' },
    })
    if (earlier) {
      throw new AppError('START_AFTER_AUDITED_DAY', `${earlier.businessDate} is already night-audited — the start day cannot be after it`, 422, { day: earlier.businessDate })
    }
  }
  await prisma.tenant.update({ where: { id: tenantId }, data: { nightAuditStartDay: input.startDay } })
  await audit({
    category: 'accounting', action: 'night_audit.start_day', entity: 'Tenant', entityId: tenantId,
    userId: actor.id, userEmail: actor.email ?? null, tenantId,
    before: { startDay: before.nightAuditStartDay }, after: { startDay: input.startDay }, metadata: { reason },
  })
  return { startDay: input.startDay }
}

// ─── Reads ───────────────────────────────────────────────────────────────────

async function namesOf(ids: Array<string | null | undefined>): Promise<Map<string, string>> {
  const list = [...new Set(ids.filter((x): x is string => !!x))]
  if (list.length === 0) return new Map()
  const users = await prisma.user.findMany({ where: { id: { in: list } }, select: { id: true, name: true } })
  return new Map(users.map((u) => [u.id, u.name]))
}

const canRunRole = (role: string) => (NIGHT_AUDIT_RUNNERS as readonly string[]).includes(role)

export async function listMonth(input: { tenantId: string; month?: string; role: string }) {
  const { tenantId } = input
  const today = todayPkt()
  const month = input.month ?? today.slice(0, 7)
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new AppError('INVALID_DATE', 'Give the month as YYYY-MM', 422)
  const [y, m] = month.split('-').map(Number) as [number, number]
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const first = `${month}-01`
  const lastDay = `${month}-${String(last).padStart(2, '0')}`
  // Audited days of the month last checked over 10 minutes ago settle first.
  await refreshAuditedDays(tenantId, { from: first, to: lastDay, staleMinutes: 10, limit: 62 }).catch(() => undefined)
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { nightAuditStartDay: true } })
  const lock = await periodLockedThrough(prisma, tenantId)
  const lockDay = lock ? fmtPktDate(lock) : null
  const active = new Set(await activityDaysBetween(prisma, tenantId, first, lastDay))
  const rows = await prisma.nightAuditDay.findMany({ where: { tenantId, businessDate: { gte: first, lte: lastDay } } })
  const byDay = new Map(rows.map((r) => [r.businessDate, r]))
  const names = await namesOf(rows.flatMap((r) => [r.auditedById, r.closedById]))
  const startDay = tenant.nightAuditStartDay
  const days = []
  const summary = { activeDays: 0, closed: 0, awaitingSettlement: 0, open: 0, overdue: 0 }
  for (let i = 1; i <= last; i++) {
    const day = `${month}-${String(i).padStart(2, '0')}`
    const r = byDay.get(day)
    const status = (r?.status ?? 'open') as 'open' | 'audited' | 'closed'
    const isActive = active.has(day)
    const beforeStart = !startDay || day < startDay
    const inClosedPeriod = !!lockDay && day <= lockDay
    if (isActive) {
      summary.activeDays++
      if (status === 'closed') summary.closed++
      else if (status === 'audited') summary.awaitingSettlement++
      else {
        summary.open++
        if (day < today && !beforeStart && !inClosedPeriod) summary.overdue++
      }
    }
    days.push({
      day, active: isActive, future: day > today, isToday: day === today, inClosedPeriod, beforeStart,
      status, locked: status !== 'open',
      auditedAt: r?.auditedAt?.toISOString() ?? null, auditedByName: r?.auditedById ? names.get(r.auditedById) ?? null : null,
      closedAt: r?.closedAt?.toISOString() ?? null, closedByName: r?.closedById ? names.get(r.closedById) ?? null : null,
      closedVia: (r?.closedVia ?? null) as 'auto' | 'manual' | 'override' | null,
      overridden: !!(r?.nightOverrides || r?.settlementOverrides), reopenCount: r?.reopenCount ?? 0,
      lastCheck: (r?.lastCheck ?? null) as LastCheck | null,
    })
  }
  return {
    tenantId, month, today, startDay, periodLockedThrough: lockDay,
    canRun: canRunRole(input.role), canOverride: input.role === 'admin',
    summary, days,
  }
}

export async function dayDetail(input: { tenantId: string; day: string; role: string; liveChecks?: boolean }) {
  const { tenantId } = input
  const day = assertDay(input.day)
  const today = todayPkt()
  const row: Row | null = await prisma.nightAuditDay.findUnique({ where: { tenantId_businessDate: { tenantId, businessDate: day } } })
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { nightAuditStartDay: true } })
  const lock = await periodLockedThrough(prisma, tenantId)
  const inClosedPeriod = !!lock && parsePktEndOfDay(day) <= lock
  const status = (row?.status ?? 'open') as 'open' | 'audited' | 'closed'
  const history = historyOf(row?.history)
  const names = await namesOf([row?.auditedById, row?.closedById, ...history.map((h) => h.byId)])
  let checks: NightChecklist | null = null
  if (input.liveChecks !== false && status !== 'closed' && day <= today && !inClosedPeriod) {
    const phase: NightPhase = status === 'audited' ? 'settlement' : 'night'
    checks = await nightChecklist(prisma, tenantId, day, phase)
  }
  const isActive = (await activityDaysBetween(prisma, tenantId, day, day)).length > 0
  const earlier = status === 'open' ? await earlierOpenDays(prisma, tenantId, tenant.nightAuditStartDay, day) : []
  return {
    tenantId, day, status, locked: status !== 'open', active: isActive, inClosedPeriod, startDay: tenant.nightAuditStartDay,
    canRun: canRunRole(input.role) && status === 'open' && day < today && !inClosedPeriod,
    canOverride: input.role === 'admin',
    canReopen: input.role === 'admin' && status !== 'open' && !inClosedPeriod,
    auditedAt: row?.auditedAt?.toISOString() ?? null,
    auditedBy: row?.auditedById ? { id: row.auditedById, name: names.get(row.auditedById) ?? '' } : null,
    closedAt: row?.closedAt?.toISOString() ?? null,
    closedBy: row?.closedById ? { id: row.closedById, name: names.get(row.closedById) ?? '' } : null,
    closedVia: (row?.closedVia ?? null) as 'auto' | 'manual' | 'override' | null,
    nightOverrides: (row?.nightOverrides ?? null) as CheckLine[] | null,
    nightOverrideReason: row?.nightOverrideReason ?? null,
    settlementOverrides: (row?.settlementOverrides ?? null) as CheckLine[] | null,
    settlementOverrideReason: row?.settlementOverrideReason ?? null,
    checks: checks ? { phase: checks.phase, problems: checks.problems, blocks: checks.blocks, warnings: checks.warnings, ready: checks.ready } : null,
    earlierOpenDays: earlier,
    history: history.map((h) => ({ ...h, byName: h.byId ? names.get(h.byId) ?? null : null })),
    report: (row?.report ?? null) as DailyReport | null,
  }
}

export async function dayReport(input: { tenantId: string; day: string; live: boolean; actorId: string }): Promise<{ report: DailyReport; live: boolean }> {
  const day = assertDay(input.day)
  if (input.live) return { report: await buildDailyReport(prisma, input.tenantId, day, { generatedById: input.actorId }), live: true }
  const row = await prisma.nightAuditDay.findUnique({ where: { tenantId_businessDate: { tenantId: input.tenantId, businessDate: day } }, select: { report: true } })
  const report = row?.report as DailyReport | null | undefined
  if (!report || !(report as { version?: number }).version) throw new AppError('NO_REPORT', `${day} has no night-audit report yet — run the day, or ask for the live one`, 404)
  return { report, live: false }
}

// ─── Company merge (tenants/routes.ts, inside the merge transaction) ─────────

/**
 * Before the generic repoint: the target's rows on the source's SALES days are
 * reopened (those days gain the source's sales); the source's rows on a date
 * the target also has are folded into the target's history and deleted; the
 * rest are repointed to the target and opened. The start day becomes the
 * earlier of the two.
 */
export async function mergeNightAuditDaysTx(tx: Tx, src: string, dst: string): Promise<{ reopened: number; folded: number; moved: number }> {
  const now = new Date().toISOString()
  const [s, d] = await Promise.all([
    tx.tenant.findUniqueOrThrow({ where: { id: src }, select: { nightAuditStartDay: true } }),
    tx.tenant.findUniqueOrThrow({ where: { id: dst }, select: { nightAuditStartDay: true } }),
  ])
  const srcDays = new Set(await activityDaysBetween(tx, src, '2000-01-01', todayPkt()))
  const reopenData = (h: HistoryEntry[], from: string) => ({
    status: 'open' as const, auditedAt: null, auditedById: null, closedAt: null, closedById: null, closedVia: null,
    nightOverrides: Prisma.DbNull, nightOverrideReason: null,
    settlementOverrides: Prisma.DbNull, settlementOverrideReason: null,
    history: json([...h, { at: now, byId: null, action: 'merge_reopen', from, to: 'open', reason: `company merged in (${src})` } satisfies HistoryEntry]),
  })
  let reopened = 0
  const dstRows = await tx.nightAuditDay.findMany({ where: { tenantId: dst } })
  const dstByDay = new Map(dstRows.map((r) => [r.businessDate, r]))
  for (const r of dstRows) {
    if (r.status === 'open' || !srcDays.has(r.businessDate)) continue
    await tx.nightAuditDay.update({ where: { id: r.id }, data: reopenData(historyOf(r.history), r.status) })
    reopened++
  }
  let folded = 0
  let moved = 0
  const srcRows = await tx.nightAuditDay.findMany({ where: { tenantId: src } })
  for (const r of srcRows) {
    const twin = dstByDay.get(r.businessDate)
    if (twin) {
      const cur = await tx.nightAuditDay.findUniqueOrThrow({ where: { id: twin.id }, select: { history: true } })
      await tx.nightAuditDay.update({
        where: { id: twin.id },
        data: { history: json([...historyOf(cur.history), { at: now, byId: null, action: 'merge_fold', from: r.status, to: null, reason: `merged company's ${r.businessDate} row (${r.status}, reopened ${r.reopenCount}×)` } satisfies HistoryEntry]) },
      })
      await tx.nightAuditDay.delete({ where: { id: r.id } })
      folded++
    } else {
      await tx.nightAuditDay.update({ where: { id: r.id }, data: { tenantId: dst, ...(r.status === 'open' ? {} : reopenData(historyOf(r.history), r.status)) } })
      moved++
    }
  }
  const starts = [s.nightAuditStartDay, d.nightAuditStartDay].filter((x): x is string => !!x).sort()
  if (starts.length > 0 && starts[0] !== d.nightAuditStartDay) await tx.tenant.update({ where: { id: dst }, data: { nightAuditStartDay: starts[0] } })
  return { reopened, folded, moved }
}

// ─── Worker helpers ──────────────────────────────────────────────────────────

/**
 * After 06:00 PKT: ONE 'night_audit_pending' flag per (company, yesterday)
 * when yesterday had sales, the company's night audit has started and the day
 * is still open. Never raised twice.
 */
export async function flagPendingYesterday(tenantId: string, now: Date = new Date()): Promise<boolean> {
  const pktHour = new Date(now.getTime() + 5 * 3_600_000).getUTCHours()
  if (pktHour < 6) return false
  const yesterday = addDays(todayPkt(now), -1)
  const t = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { nightAuditStartDay: true } })
  if (!t?.nightAuditStartDay || yesterday < t.nightAuditStartDay) return false
  const row = await prisma.nightAuditDay.findUnique({ where: { tenantId_businessDate: { tenantId, businessDate: yesterday } }, select: { status: true, lastCheck: true } })
  if (row && row.status !== 'open') return false
  if ((await activityDaysBetween(prisma, tenantId, yesterday, yesterday)).length === 0) return false
  const entityId = `${tenantId}:${yesterday}`
  const seen = await prisma.exceptionFlag.findFirst({ where: { tenantId, kind: 'night_audit_pending', entityType: 'NightAuditDay', entityId }, select: { id: true } })
  if (seen) return false
  const blocks = ((row?.lastCheck ?? null) as LastCheck | null)?.blocks ?? []
  await flagException({
    tenantId, kind: 'night_audit_pending', severity: 'medium',
    title: `Night audit of ${yesterday} not run`,
    description: `${yesterday} had sales and its night audit has not been run.${blocks.length ? ` Last check: ${blocks.map((b) => b.title).join('; ')}.` : ''} Run it on Finance → Night audit.`,
    entityType: 'NightAuditDay', entityId, metadata: { day: yesterday, blocks: blocks.map((b) => b.key) },
  })
  return true
}

/**
 * Fire-and-forget after new settlement evidence (a bank statement import, a
 * card payout confirmed or re-matched): the company's audited sales days are
 * re-checked so a day whose money is now matched closes without waiting for
 * the hourly worker. Never throws, never delays the caller.
 */
export function nudgeNightAudit(tenantId: string | null | undefined): void {
  if (!tenantId) return
  void refreshAuditedDays(tenantId, { limit: 62 }).catch((err) => {
    console.error(`[night-audit] nudge for ${tenantId} failed:`, (err as Error).message)
  })
}
