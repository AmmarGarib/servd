// The serverless scheduler (Vercel): every background task and queue processor
// in one table, driven by an external every-minute tick
// (GET|POST /api/v1/internal/cron/tick → runTick).
//
// Docker does NOT use this file for scheduling: src/index.ts still starts each
// worker's startXWorker() (BullMQ repeatables / node-cron / setInterval), and
// those call the same functions listed here. So a cadence change must be made
// in both places.
//
// Due-ness is stored in cron_runs (one row per task). A task is claimed by
// moving its lastRunAt forward with an optimistic compare-and-set BEFORE it
// runs, so two overlapping ticks never both run it; a failure is recorded in
// lastError and retried at the next cadence, not immediately.
//
// Cadence caveats vs Docker: the tick is at best once a minute, so the 30s
// course-pacing interval becomes ~1 minute; fixed-time daily jobs run on the
// first tick at/after their UTC slot.

import { serviceClient as prisma } from '../lib/prisma.js'
import {
  registerProcessor, drainQueue, purgeFinishedJobs, jobCounts, getJobsDriver,
} from '../lib/jobs.js'
import type {
  FbrSubmissionJob, SrbSubmissionJob, WebhookDeliveryJob, CartReleaseJob, SocialPublishJob,
} from '../lib/queue.js'
import { processCartRelease } from '../lib/reservation.js'
import { runBootstrap } from '../bootstrap.js'
import { processFbrSubmission, logFbrCompleted, logFbrFailed } from './fbrSubmission.js'
import { processSrbSubmission, logSrbCompleted, logSrbFailed } from './srbSubmission.js'
import { processWebhookDelivery, logWebhookFailed } from './webhookDelivery.js'
import { runLoyaltyTriggers } from './loyaltyTriggers.js'
import { runSegmentComputation } from './segmentComputation.js'
import { processSocialPublish, runSocialPublishPoll } from './socialPublish.js'
import { runCancelSweep } from './orderAutoCancel.js'
import { runExpirationSweep } from './loyaltyExpiration.js'
import { runReminderSweep } from './reservationReminders.js'
import { runDispatchSweep } from './riderDispatch.js'
import { runRetrySweep } from './paymentRetry.js'
import { runPromptSweep } from './reviewPrompt.js'
import { runDeliveryWatch } from './deliveryWatch.js'
import { runOnce as runRiderScoring } from './riderScoring.js'
import { runOnce as runShrinkageTrend } from './shrinkageTrend.js'
import { runScheduledReportsWindow, carryOverDigestRecipient } from './scheduledReports.js'
import { runCoursePacingTick } from './coursePacing.js'
import { runSitePublishSweep } from './sitePublish.js'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

export interface CronTaskContext {
  /** When this task last started before this run (null on its first run). */
  previousRunAt: Date | null
}

export interface CronTask {
  name: string
  /** Minimum gap between runs. */
  everyMs: number
  /**
   * Daily wall-clock slot, 'HH:MM' UTC (the Docker box runs node-cron / BullMQ
   * patterns in UTC). When set, the task runs on the first tick at/after the
   * slot, once per day, instead of every `everyMs` from its last run.
   */
  dailyAtUtc?: string
  run: (ctx?: CronTaskContext) => Promise<void>
}

const log = {
  info: (m: string) => console.info(m),
  warn: (m: string) => console.warn(m),
}

// Mirrors the Docker cadences (see each worker's startXWorker).
export const CRON_TASKS: CronTask[] = [
  // setInterval 30s (coursePacing.ts) — best the tick can do is 1 minute.
  { name: 'coursePacing', everyMs: 30_000, run: async () => { await runCoursePacingTick() } },
  // node-cron '* * * * *' (scheduledReports.ts); window-matched so a late tick skips no slot.
  { name: 'scheduledReports', everyMs: MIN, run: async (ctx) => { await runScheduledReportsWindow(ctx?.previousRunAt ?? null) } },
  // BullMQ scheduler '* * * * *' (socialPublish.ts) — enqueues; the social-publish queue drains below.
  { name: 'socialPublishPoll', everyMs: MIN, run: async () => { await runSocialPublishPoll() } },
  // setInterval 60s (sitePublish.ts).
  { name: 'sitePublish', everyMs: MIN, run: async () => { await runSitePublishSweep() } },
  // BullMQ repeat every 2 min (riderDispatch.ts).
  { name: 'riderDispatch', everyMs: 2 * MIN, run: runDispatchSweep },
  // BullMQ repeat every 5 min.
  { name: 'orderAutoCancel', everyMs: 5 * MIN, run: runCancelSweep },
  { name: 'reservationReminders', everyMs: 5 * MIN, run: async () => { await runReminderSweep() } },
  { name: 'reviewPrompt', everyMs: 5 * MIN, run: runPromptSweep },
  // BullMQ repeat every 10 min (paymentRetry.ts); node-cron '*/10 * * * *' (deliveryWatch.ts).
  { name: 'paymentRetry', everyMs: 10 * MIN, run: runRetrySweep },
  { name: 'deliveryWatch', everyMs: 10 * MIN, run: async () => { await runDeliveryWatch() } },
  // BullMQ repeat every hour (loyaltyTriggers.ts).
  { name: 'loyaltyTriggers', everyMs: HOUR, run: runLoyaltyTriggers },
  // BullMQ repeat every 24h (loyaltyExpiration.ts).
  { name: 'loyaltyExpiration', everyMs: DAY, run: runExpirationSweep },
  // Fixed daily slots (UTC): node-cron / BullMQ patterns in index.ts and the workers.
  { name: 'shrinkageTrend', everyMs: DAY, dailyAtUtc: '02:00', run: async () => { await runShrinkageTrend() } },
  { name: 'riderScoring', everyMs: DAY, dailyAtUtc: '02:30', run: async () => { await runRiderScoring() } },
  { name: 'hrDaily', everyMs: DAY, dailyAtUtc: '19:15', run: async () => {
    const { runHrDaily } = await import('../modules/hr/daily.js')
    await runHrDaily()
  } },
  { name: 'segmentComputation', everyMs: DAY, dailyAtUtc: '22:00', run: async () => { await runSegmentComputation('cron') } },
  // Boot-time seeds/backfills (src/index.ts runs them per process on Docker).
  { name: 'bootstrap', everyMs: DAY, run: async () => {
    await runBootstrap(log)
    const slugs = await carryOverDigestRecipient()
    if (slugs.length > 0) log.info(`[scheduledReports] daily sales schedule carried over from DIGEST_EMAIL for ${slugs.join(', ')}`)
  } },
]

// ─── Queue processors (db driver) ────────────────────────────────────────────
// Tax queues first: when the budget runs short they are the ones drained.

registerProcessor('fbr-submission', (p: FbrSubmissionJob, ctx) => processFbrSubmission(p, ctx), {
  onCompleted: (_p, result, ctx) => logFbrCompleted(ctx.jobId, result as { skipped?: boolean; fbrInvoiceNumber?: string }),
  onFailed: (p: FbrSubmissionJob, err, ctx) => logFbrFailed(ctx.jobId, p?.orderId, ctx.attempt, ctx.final, err),
})
registerProcessor('srb-submission', (p: SrbSubmissionJob, ctx) => processSrbSubmission(p, ctx), {
  onCompleted: (_p, result, ctx) => logSrbCompleted(ctx.jobId, result as { skipped?: boolean; srbInvoiceNumber?: string }),
  onFailed: (p: SrbSubmissionJob, err, ctx) => logSrbFailed(ctx.jobId, p?.orderId, ctx.attempt, ctx.final, err),
})
registerProcessor('webhook-delivery', (p: WebhookDeliveryJob, ctx) => processWebhookDelivery(p, ctx.attempt), {
  onFailed: (p: WebhookDeliveryJob, err) => logWebhookFailed(p?.event, p?.subscriptionId, err),
})
registerProcessor('cart-releases', (p: CartReleaseJob) => processCartRelease(p))
registerProcessor('social-publish', (p: SocialPublishJob) => processSocialPublish(p))
// Normally run by the cron tasks above; registered so an ad-hoc enqueue works too.
registerProcessor('loyalty-triggers', () => runLoyaltyTriggers())
registerProcessor('segment-computation', (_p, ctx) => runSegmentComputation(ctx.jobId))

export const DB_QUEUES: string[] = [
  'fbr-submission',
  'srb-submission',
  'webhook-delivery',
  'cart-releases',
  'social-publish',
  'loyalty-triggers',
  'segment-computation',
]

// ─── Scheduling ──────────────────────────────────────────────────────────────

function lastDailySlot(hhmm: string, now: Date): Date {
  const [h, m] = hhmm.split(':').map(Number) as [number, number]
  const slot = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, m))
  if (slot.getTime() > now.getTime()) slot.setUTCDate(slot.getUTCDate() - 1)
  return slot
}

function isDue(task: CronTask, lastRunAt: Date | null, now: Date): boolean {
  if (!lastRunAt) return true
  if (task.dailyAtUtc) return lastRunAt.getTime() < lastDailySlot(task.dailyAtUtc, now).getTime()
  // 5s slack so a task with everyMs = 1 min is not skipped by a tick that
  // arrives a moment early.
  return now.getTime() - lastRunAt.getTime() >= task.everyMs - 5_000
}

/**
 * Claim `task` for this run: returns the previous lastRunAt (null on the
 * first run) when claimed, or undefined when it is not due or another tick got
 * it first.
 */
async function claim(task: CronTask, now: Date, force: boolean): Promise<Date | null | undefined> {
  const row = await prisma.cronRun.findUnique({ where: { name: task.name } })
  if (!row) {
    try {
      await prisma.cronRun.create({ data: { name: task.name, lastRunAt: now } })
      return null
    } catch {
      return undefined // a concurrent tick created it first
    }
  }
  if (!force && !isDue(task, row.lastRunAt, now)) return undefined
  const r = await prisma.cronRun.updateMany({
    where: { name: task.name, lastRunAt: row.lastRunAt },
    data: { lastRunAt: now },
  })
  return r.count === 1 ? row.lastRunAt : undefined
}

async function execute(task: CronTask, previousRunAt: Date | null): Promise<string | null> {
  try {
    await task.run({ previousRunAt })
    await prisma.cronRun.update({ where: { name: task.name }, data: { lastError: null } }).catch(() => {})
    return null
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).slice(0, 2000)
    console.error(`[cron] ${task.name} failed: ${msg}`)
    await prisma.cronRun.update({ where: { name: task.name }, data: { lastError: msg } }).catch(() => {})
    return msg
  }
}

export interface TickResult {
  ran: string[]
  drained: Record<string, number>
  errors: Record<string, string>
}

async function drainAll(deadline: number, out: TickResult): Promise<void> {
  for (const q of DB_QUEUES) {
    const left = deadline - Date.now()
    if (left <= 0) break
    try {
      const n = await drainQueue(q, { limit: 100, budgetMs: left })
      if (n > 0) out.drained[q] = (out.drained[q] ?? 0) + n
    } catch (e) {
      out.errors[`queue:${q}`] = (e instanceof Error ? e.message : String(e)).slice(0, 500)
    }
  }
}

/**
 * One scheduler tick: run every due task, then drain the db-driver queues, all
 * inside `budgetMs`. A task is never started once less than the drain reserve
 * is left (it runs on the next tick instead); a task already running is not
 * interrupted.
 */
export async function runTick(opts: { budgetMs: number }): Promise<TickResult> {
  const started = Date.now()
  const deadline = started + opts.budgetMs
  const drainReserve = Math.min(10_000, Math.floor(opts.budgetMs / 4))
  const out: TickResult = { ran: [], drained: {}, errors: {} }
  const dbDriver = getJobsDriver() === 'db'

  // Tax and webhook work first, briefly, so a slow task cannot starve it.
  if (dbDriver) await drainAll(Math.min(deadline, Date.now() + drainReserve), out)

  for (const task of CRON_TASKS) {
    if (deadline - Date.now() < drainReserve) break
    const now = new Date()
    let previous: Date | null | undefined
    try {
      previous = await claim(task, now, false)
    } catch (e) {
      out.errors[task.name] = `claim failed: ${(e as Error).message}`.slice(0, 500)
      continue
    }
    if (previous === undefined) continue
    out.ran.push(task.name)
    const err = await execute(task, previous)
    if (err) out.errors[task.name] = err
  }

  if (dbDriver) {
    await drainAll(deadline, out)
    try { await purgeFinishedJobs() } catch (e) { out.errors['purge'] = (e as Error).message.slice(0, 500) }
  }
  return out
}

/**
 * Run one task now regardless of cadence (it still moves lastRunAt, so the
 * next scheduled run counts from here), or drain one db queue by name.
 */
export async function runTask(name: string): Promise<{ name: string; ok: boolean; error?: string; drained?: number }> {
  const task = CRON_TASKS.find((t) => t.name === name)
  if (task) {
    const previous = await claim(task, new Date(), true)
    if (previous === undefined) return { name, ok: false, error: 'another run claimed this task at the same moment — try again' }
    const err = await execute(task, previous)
    return err ? { name, ok: false, error: err } : { name, ok: true }
  }
  if (DB_QUEUES.includes(name)) {
    const drained = await drainQueue(name, { limit: 100, budgetMs: 45_000 })
    return { name, ok: true, drained }
  }
  throw Object.assign(new Error(`unknown task "${name}"`), { code: 'UNKNOWN_TASK' })
}

/** Every task's last run plus job counts per queue (db driver). */
export async function cronStatus() {
  const rows = await prisma.cronRun.findMany({ orderBy: { name: 'asc' } })
  const byName = new Map(rows.map((r) => [r.name, r]))
  const now = new Date()
  return {
    driver: getJobsDriver(),
    tasks: CRON_TASKS.map((t) => {
      const r = byName.get(t.name)
      return {
        name: t.name,
        everyMs: t.everyMs,
        dailyAtUtc: t.dailyAtUtc ?? null,
        lastRunAt: r?.lastRunAt ?? null,
        lastError: r?.lastError ?? null,
        due: isDue(t, r?.lastRunAt ?? null, now),
      }
    }),
    queues: await jobCounts(),
  }
}
