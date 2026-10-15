// Head-office recharge worker (D1, spec §4.9) — hourly, serviceClient, no Redis.
//
// Per head office (kind head_office, active, not deleted, recharge ON), each in
// its own try/catch, for every month M from the later of its rechargeFromPeriod
// and 12 months ago up to LAST month (PKT):
//   • no run rows at all for M, and M is ready apart from drift (payroll locked
//     when required, no open run) → prepare and submit a run as 'system'
//     (nothing to recharge → nothing is created);
//   • its own open DRAFT (left by an earlier tick whose submit was refused) →
//     refresh when stale, then submit again;
//   • the latest run is posted, drift ≠ 0 and no run is open → prepare and
//     submit a true-up as 'system';
//   • the latest run was rejected, withdrawn or reversed → nothing: a person
//     decides;
//   • M still not ready on day ≥ 5 of M+1 → ONE open 'recharge_missing' flag in
//     the head office (resolved once M is ready).
// Once a day (the first tick after 06:00 PKT) it raises or resolves
// 'recharge_drift' for months whose posted recharge no longer matches the
// head office's cost.
//
// It NEVER approves or posts: every run waits for the CEO (or a
// head-office-wide Finance delegate). The pair mismatch check stays with
// workers/intercompanyFleet.ts (head-office pairs are inter-company pairs).
// Started by index.ts under ENABLE_WORKERS (orchestrator).

import type { Prisma } from '@prisma/client'
import { serviceClient as db } from '../lib/prisma.js'
import { flagException } from '../lib/exceptions.js'
import { AppError } from '../lib/errors.js'
import { fmtPktDate } from '../modules/accounting/dates.js'
import { addMonths, monthLabel, monthOf, monthsBetween } from '../modules/intercompany/fleet.js'
import {
  monthReadiness, payrollReady, prepareRun, refreshRun, submitRun, SYSTEM, READINESS_TEXT, OPEN_STATUSES,
} from '../modules/headOffices/runs.js'

/** Hourly. */
export const HO_RECHARGE_INTERVAL_MS = 60 * 60 * 1000
/** The first tick after start-up. */
export const HO_RECHARGE_FIRST_TICK_MS = 60 * 1000
/** recharge_missing is raised from this day of the following month (PKT). */
export const RECHARGE_MISSING_FROM_DAY = 5
/** The daily drift check runs on the first tick at or after this PKT hour. */
export const DRIFT_CHECK_HOUR_PKT = 6
/** How far back the worker looks. */
export const HO_RECHARGE_MONTHS_BACK = 12

const MONTH_ENTITY = 'HeadOfficeRechargeMonth'
const OPEN_FLAG: Prisma.EnumExceptionStatusFilter<'ExceptionFlag'> = { in: ['open', 'acknowledged'] }

export interface TickResult {
  headOffices: number
  prepared: number
  submitted: number
  failed: number
  missingRaised: number
  missingResolved: number
  driftRaised: number
  driftResolved: number
}

let lastDriftDay: string | null = null
/** Tests: forget that today's drift check already ran. */
export function resetHeadOfficeRechargeDailyMark(): void { lastDriftDay = null }

const pkr = (c: number) => `PKR ${(c / 100).toLocaleString('en-PK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

function pktHour(now: Date): number {
  return new Date(now.getTime() + 5 * 3600_000).getUTCHours()
}

async function openFlag(kind: 'recharge_missing' | 'recharge_drift', hoId: string, entityId: string) {
  return db.exceptionFlag.findFirst({
    where: { kind, tenantId: hoId, entityType: MONTH_ENTITY, entityId, status: OPEN_FLAG },
    select: { id: true },
  })
}

async function resolveFlags(kind: 'recharge_missing' | 'recharge_drift', hoId: string, entityId: string, resolution: string): Promise<number> {
  const r = await db.exceptionFlag.updateMany({
    where: { kind, tenantId: hoId, entityType: MONTH_ENTITY, entityId, status: OPEN_FLAG },
    data: { status: 'resolved', resolvedAt: new Date(), resolution },
  })
  return r.count
}

/** Prepare (and submit) a run as the worker; a refusal is logged, never thrown. */
async function prepareAndSubmit(hoId: string, period: string, now: Date, r: TickResult): Promise<void> {
  let runId: string
  try {
    runId = (await prepareRun(SYSTEM, hoId, period, now)).id
  } catch (err) {
    if (err instanceof AppError && (err.code === 'NOTHING_TO_RECHARGE' || err.code === 'RUN_OPEN')) return
    // Any other refusal (NO_SPLIT, COMPANY_UNLINKED, …) is a setup problem for a
    // person: log it and carry on, so the month is still flagged and later
    // months are still prepared.
    if (err instanceof AppError) {
      console.warn(`[headOfficeRecharge] ${hoId} ${period}: no run prepared — ${err.code}: ${err.message}`)
      return
    }
    throw err
  }
  r.prepared += 1
  await trySubmit(runId, hoId, period, r)
}

async function trySubmit(runId: string, hoId: string, period: string, r: TickResult): Promise<void> {
  try {
    await submitRun(SYSTEM, runId)
    r.submitted += 1
  } catch (err) {
    console.warn(`[headOfficeRecharge] ${hoId} ${period}: run ${runId} left as a draft — ${(err as Error).message}`)
  }
}

async function tickHeadOffice(
  ho: { hoId: string; hoName: string; fromPeriod: string; requireLockedPayroll: boolean }, now: Date, daily: boolean, r: TickResult,
): Promise<void> {
  const { hoId, hoName, fromPeriod, requireLockedPayroll } = ho
  const current = monthOf(now)
  const last = addMonths(current, -1)
  const start = [fromPeriod, addMonths(current, -HO_RECHARGE_MONTHS_BACK)].sort().at(-1)!
  const today = fmtPktDate(now)
  for (const m of monthsBetween(start, last)) {
    const runs = await db.rechargeRun.findMany({
      where: { tenantId: hoId, period: m },
      orderBy: { createdAt: 'asc' },
      select: { id: true, status: true, stale: true, preparedById: true },
    })
    const latest = runs.at(-1)
    const open = runs.find((x) => (OPEN_STATUSES as readonly string[]).includes(x.status))

    if (runs.length === 0) {
      if (!requireLockedPayroll || (await payrollReady(db, hoId, m))) await prepareAndSubmit(hoId, m, now, r)
    } else if (open) {
      // Only the worker's own drafts are pushed on; a person's draft is theirs.
      if (open.status === 'draft' && open.preparedById === null) {
        try {
          if (open.stale) await refreshRun(SYSTEM, open.id)
          await trySubmit(open.id, hoId, m, r)
        } catch (err) {
          console.warn(`[headOfficeRecharge] ${hoId} ${m}: could not refresh run ${open.id} — ${(err as Error).message}`)
        }
      }
    } else if (latest?.status === 'posted') {
      const ready = await monthReadiness(db, hoId, m)
      if (ready.driftCents !== 0 && !ready.reasons.includes('payroll_not_locked')) await prepareAndSubmit(hoId, m, now, r)
    }
    // rejected / withdrawn / reversed latest → a person decides.

    const entityId = `${hoId}:${m}`
    const readiness = await monthReadiness(db, hoId, m)
    if (readiness.ready) {
      r.missingResolved += await resolveFlags('recharge_missing', hoId, entityId, `${monthLabel(m)} is recharged`)
    } else if (today >= `${addMonths(m, 1)}-${String(RECHARGE_MISSING_FROM_DAY).padStart(2, '0')}` && !(await openFlag('recharge_missing', hoId, entityId))) {
      await flagException({
        tenantId: hoId,
        kind: 'recharge_missing',
        severity: 'high',
        title: `${hoName}: ${monthLabel(m)} not recharged`,
        description: `${monthLabel(m)} is not recharged to the companies yet: ${readiness.reasons.map((x) => READINESS_TEXT[x]).join('; ')}. `
          + 'The companies cannot close the month until it is (Accounting → Inter-company → Head office).',
        entityType: MONTH_ENTITY,
        entityId,
        amountCents: readiness.driftCents || null,
        metadata: { headOfficeId: hoId, period: m, reasons: readiness.reasons, driftCents: readiness.driftCents },
      })
      r.missingRaised += 1
    }

    if (daily) {
      const posted = runs.some((x) => x.status === 'posted')
      if (posted && readiness.driftCents !== 0) {
        if (!(await openFlag('recharge_drift', hoId, entityId))) {
          await flagException({
            tenantId: hoId,
            kind: 'recharge_drift',
            severity: 'medium',
            title: `${hoName}: ${monthLabel(m)} cost moved after it was recharged`,
            description: `The head office's cost for ${monthLabel(m)} changed by ${pkr(readiness.driftCents)} after it was recharged. A true-up is prepared for approval (Accounting → Inter-company → Head office).`,
            entityType: MONTH_ENTITY,
            entityId,
            amountCents: readiness.driftCents,
            metadata: { headOfficeId: hoId, period: m, driftCents: readiness.driftCents },
          })
          r.driftRaised += 1
        }
      } else {
        r.driftResolved += await resolveFlags('recharge_drift', hoId, entityId, `${monthLabel(m)} recharge matches the cost again`)
      }
    }
  }
}

/** One pass over every head office with recharge on (tests call it directly with `now`). */
export async function runHeadOfficeRechargeTick(now: Date = new Date()): Promise<TickResult> {
  const r: TickResult = { headOffices: 0, prepared: 0, submitted: 0, failed: 0, missingRaised: 0, missingResolved: 0, driftRaised: 0, driftResolved: 0 }
  const today = fmtPktDate(now)
  const daily = pktHour(now) >= DRIFT_CHECK_HOUR_PKT && lastDriftDay !== today
  const hos = await db.headOfficeBooks.findMany({
    where: { rechargeEnabled: true, rechargeFromPeriod: { not: null }, tenant: { kind: 'head_office', isActive: true, deletedAt: null } },
    select: { tenantId: true, rechargeFromPeriod: true, requireLockedPayroll: true, tenant: { select: { name: true } } },
    orderBy: { tenantId: 'asc' },
  })
  for (const ho of hos) {
    r.headOffices += 1
    try {
      await tickHeadOffice({ hoId: ho.tenantId, hoName: ho.tenant.name, fromPeriod: ho.rechargeFromPeriod!, requireLockedPayroll: ho.requireLockedPayroll }, now, daily, r)
    } catch (err) {
      r.failed += 1
      console.error(`[headOfficeRecharge] ${ho.tenantId}:`, (err as Error).message)
    }
  }
  if (daily) lastDriftDay = today
  return r
}

let running = false
let timer: NodeJS.Timeout | null = null

async function guardedTick(): Promise<void> {
  if (running) return
  running = true
  try {
    const r = await runHeadOfficeRechargeTick()
    if (r.prepared || r.submitted || r.failed || r.missingRaised || r.driftRaised) {
      console.info(`[headOfficeRecharge] ${r.prepared} prepared, ${r.submitted} submitted, ${r.failed} failed, ${r.missingRaised} missing / ${r.driftRaised} drift flag(s)`)
    }
  } catch (err) {
    console.error('[headOfficeRecharge] tick failed:', (err as Error).message)
  } finally {
    running = false
  }
}

/** Hourly setInterval (unref), first tick after 60 s. Never posts. */
export function startHeadOfficeRechargeWorker(): void {
  if (timer) return
  const first = setTimeout(() => { void guardedTick() }, HO_RECHARGE_FIRST_TICK_MS)
  first.unref()
  timer = setInterval(() => { void guardedTick() }, HO_RECHARGE_INTERVAL_MS)
  timer.unref()
  console.info('[headOfficeRecharge] worker started — hourly (prepares and submits head-office recharge runs; never posts)')
}
