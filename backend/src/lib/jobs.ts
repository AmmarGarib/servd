// Driver-agnostic background jobs.
//
//   bullmq — the Docker deployment. enqueueJob() is a BullMQ Queue.add with the
//            queue's default options (lib/queue.ts); the always-on workers in
//            workers/*.ts consume it exactly as before.
//   db     — serverless (Vercel). There is no always-on process, so a job is a
//            row in background_jobs, drained by the scheduler tick
//            (POST /api/v1/internal/cron/tick → workers/registry.ts runTick).
//
// Driver: JOBS_DRIVER if set, else 'db' on Vercel (VERCEL is set by the
// platform), else 'bullmq'.
//
// Semantics the db driver keeps from BullMQ:
//   - jobKey is the BullMQ jobId: a second enqueue with the same key is a
//     no-op while the first is pending, running, or finished-and-retained.
//     (A permanently failed row is re-armed by a new enqueue.)
//   - attempts / exponential backoff come from the queue's policy
//     (lib/queue.ts QUEUE_POLICIES) unless the caller overrides maxAttempts.
//     Retry n waits backoffMs * 2^(n-1), capped at one hour — BullMQ's curve.
//   - removeOnComplete: true queues (cart-releases) delete the row on success.
//   - a row stuck in 'running' for 10 minutes (the function was killed
//     mid-job) is claimable again; the killed run counts as an attempt.

import { Prisma } from '@prisma/client'
import { serviceClient as prisma } from './prisma.js'
import * as Q from './queue.js'

export type JobsDriver = 'bullmq' | 'db'

export function getJobsDriver(): JobsDriver {
  const explicit = process.env['JOBS_DRIVER']
  if (explicit === 'bullmq' || explicit === 'db') return explicit
  if (explicit) console.warn(`[jobs] unknown JOBS_DRIVER "${explicit}" — using the default`)
  return process.env['VERCEL'] ? 'db' : 'bullmq'
}

export interface EnqueueOptions {
  /** Idempotency key (BullMQ jobId). Unique per queue. */
  jobKey?: string
  /** Run no earlier than this many ms from now. */
  delayMs?: number
  /** Override the queue's attempts. */
  maxAttempts?: number
  /**
   * Override the queue's exponential backoff base. BullMQ driver only — the db
   * driver always uses the queue policy's backoff (the row has no column for it).
   */
  backoffMs?: number
  /** BullMQ job name. Defaults to the queue policy's jobName. */
  name?: string
}

export interface JobContext {
  /** 1-based attempt number of this run. */
  attempt: number
  maxAttempts: number
  /** BullMQ job id, or the row's jobKey ?? id. */
  jobId: string | undefined
}

export type JobProcessor = (payload: any, ctx: JobContext) => Promise<unknown>

export interface ProcessorOptions {
  /** Called after every failed run. `final` is true when no retry follows. */
  onFailed?: (payload: any, err: Error, ctx: JobContext & { final: boolean }) => void
  /** Called after a successful run with the processor's return value. */
  onCompleted?: (payload: any, result: unknown, ctx: JobContext) => void
}

// ─── Enqueue ─────────────────────────────────────────────────────────────────

function bullQueueFor(queue: string) {
  // Named getters first so a test stub of one of them (vi.mock of queue.js)
  // is honoured.
  switch (queue) {
    case 'fbr-submission': return Q.getFbrQueue()
    case 'srb-submission': return Q.getSrbQueue()
    case 'webhook-delivery': return Q.getWebhookQueue()
    default: return Q.getBullQueue(queue)
  }
}

export async function enqueueJob(queue: string, payload: unknown, opts: EnqueueOptions = {}): Promise<void> {
  const policy = Q.queuePolicy(queue)

  if (getJobsDriver() === 'bullmq') {
    const q = bullQueueFor(queue)
    if (!q) throw new Error(`queue ${queue} unavailable`)
    // Only the options the caller set: everything else comes from the queue's
    // defaultJobOptions, exactly as the direct Queue.add calls did.
    const jobOpts: Record<string, unknown> = {}
    if (opts.jobKey !== undefined) jobOpts['jobId'] = opts.jobKey
    if (opts.delayMs !== undefined && opts.delayMs > 0) jobOpts['delay'] = opts.delayMs
    if (opts.maxAttempts !== undefined) jobOpts['attempts'] = opts.maxAttempts
    if (opts.backoffMs !== undefined) jobOpts['backoff'] = { type: 'exponential', delay: opts.backoffMs }
    await (q as { add: (n: string, d: unknown, o?: Record<string, unknown>) => Promise<unknown> })
      .add(opts.name ?? policy.jobName, payload, jobOpts)
    return
  }

  const runAt = new Date(Date.now() + Math.max(0, opts.delayMs ?? 0))
  const maxAttempts = Math.max(1, opts.maxAttempts ?? policy.attempts)
  const data = payload === undefined ? {} : (payload as Prisma.InputJsonValue)

  if (!opts.jobKey) {
    await prisma.backgroundJob.create({ data: { queue, payload: data, runAt, maxAttempts } })
    return
  }

  const existing = await prisma.backgroundJob.findFirst({
    where: { queue, jobKey: opts.jobKey },
    select: { id: true, status: true },
  })
  if (existing) {
    if (existing.status !== 'failed') return // dedupe, as BullMQ does on jobId
    // Re-arm a permanently failed job; the status guard keeps a concurrent
    // enqueue from re-arming it twice.
    await prisma.backgroundJob.updateMany({
      where: { id: existing.id, status: 'failed' },
      data: { status: 'pending', payload: data, runAt, attempts: 0, maxAttempts, lastError: null, lockedAt: null },
    })
    return
  }
  try {
    await prisma.backgroundJob.create({ data: { queue, jobKey: opts.jobKey, payload: data, runAt, maxAttempts } })
  } catch (err) {
    // A concurrent enqueue with the same key won the unique index: dedupe.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return
    throw err
  }
}

/** Remove a not-yet-started job. Returns true when one was removed. */
export async function cancelJob(queue: string, jobKey: string): Promise<boolean> {
  if (getJobsDriver() === 'bullmq') {
    const q = bullQueueFor(queue)
    if (!q) return false
    const job = await q.getJob(jobKey)
    if (!job) return false
    await job.remove()
    return true
  }
  const r = await prisma.backgroundJob.deleteMany({ where: { queue, jobKey, status: 'pending' } })
  return r.count > 0
}

// ─── Processors (db driver) ──────────────────────────────────────────────────

const processors = new Map<string, { fn: JobProcessor; opts: ProcessorOptions }>()

export function registerProcessor(queue: string, fn: JobProcessor, opts: ProcessorOptions = {}): void {
  processors.set(queue, { fn, opts })
}

export function registeredQueues(): string[] {
  return [...processors.keys()]
}

const STALE_LOCK_MS = 10 * 60_000
const MAX_BACKOFF_MS = 60 * 60_000
const DONE_RETENTION_MS = 3 * 24 * 60 * 60_000

export function retryDelayMs(backoffMs: number, attemptsMade: number): number {
  if (backoffMs <= 0) return 0
  return Math.min(backoffMs * 2 ** Math.max(0, attemptsMade - 1), MAX_BACKOFF_MS)
}

/** Claim one due row of `queue`, or null. Optimistic: the claim only lands if nobody else changed the row. */
async function claimNext(queue: string, skip: Set<string>) {
  const now = new Date()
  const candidates = await prisma.backgroundJob.findMany({
    where: {
      queue,
      runAt: { lte: now },
      id: skip.size ? { notIn: [...skip] } : undefined,
      OR: [
        { status: 'pending' },
        { status: 'running', lockedAt: { lt: new Date(now.getTime() - STALE_LOCK_MS) } },
      ],
    },
    orderBy: { runAt: 'asc' },
    take: 5,
    select: { id: true, status: true, attempts: true },
  })
  for (const c of candidates) {
    const r = await prisma.backgroundJob.updateMany({
      where: { id: c.id, status: c.status, attempts: c.attempts },
      data: { status: 'running', lockedAt: now, attempts: { increment: 1 } },
    })
    if (r.count === 1) return prisma.backgroundJob.findUnique({ where: { id: c.id } })
    skip.add(c.id)
  }
  return null
}

/**
 * Run due jobs of one queue until `limit` jobs ran or `budgetMs` elapsed.
 * Returns the number of jobs run (success or failure).
 */
export async function drainQueue(queue: string, opts: { limit?: number; budgetMs?: number } = {}): Promise<number> {
  const entry = processors.get(queue)
  if (!entry) throw new Error(`no processor registered for queue ${queue}`)
  const limit = opts.limit ?? 50
  const deadline = Date.now() + (opts.budgetMs ?? 30_000)
  const policy = Q.queuePolicy(queue)
  const skip = new Set<string>()
  let ran = 0

  while (ran < limit && Date.now() < deadline) {
    const job = await claimNext(queue, skip)
    if (!job) break
    skip.add(job.id)
    ran++
    const ctx: JobContext = { attempt: job.attempts, maxAttempts: job.maxAttempts, jobId: job.jobKey ?? job.id }
    try {
      const result = await entry.fn(job.payload, ctx)
      if (policy.removeOnComplete === true) {
        await prisma.backgroundJob.delete({ where: { id: job.id } }).catch(() => {})
      } else {
        await prisma.backgroundJob.update({
          where: { id: job.id },
          data: { status: 'done', lockedAt: null, lastError: null },
        })
      }
      try { entry.opts.onCompleted?.(job.payload, result, ctx) } catch { /* logging only */ }
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e))
      const final = job.attempts >= job.maxAttempts
      await prisma.backgroundJob.update({
        where: { id: job.id },
        data: final
          ? { status: 'failed', lockedAt: null, lastError: err.message.slice(0, 2000) }
          : {
              status: 'pending',
              lockedAt: null,
              lastError: err.message.slice(0, 2000),
              runAt: new Date(Date.now() + retryDelayMs(policy.backoffMs, job.attempts)),
            },
      }).catch((ue: Error) => console.error(`[jobs] ${queue} ${job.id}: could not record failure: ${ue.message}`))
      try {
        if (entry.opts.onFailed) entry.opts.onFailed(job.payload, err, { ...ctx, final })
        else console.warn(`[jobs] ${queue} ${ctx.jobId} attempt ${job.attempts}/${job.maxAttempts} failed: ${err.message}`)
      } catch { /* logging only */ }
    }
  }
  return ran
}

/** Delete finished rows older than three days. */
export async function purgeFinishedJobs(): Promise<number> {
  const r = await prisma.backgroundJob.deleteMany({
    where: { status: 'done', updatedAt: { lt: new Date(Date.now() - DONE_RETENTION_MS) } },
  })
  return r.count
}

/** Pending / running / failed counts per queue (db driver's table). */
export async function jobCounts(): Promise<Record<string, Record<string, number>>> {
  const rows = await prisma.backgroundJob.groupBy({ by: ['queue', 'status'], _count: { _all: true } })
  const out: Record<string, Record<string, number>> = {}
  for (const r of rows) {
    const q = (out[r.queue] ??= {})
    q[r.status] = r._count._all
  }
  return out
}
