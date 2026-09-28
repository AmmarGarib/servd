// Queue definitions: payload types, per-queue retry policy, and the BullMQ
// Queue cache used by the `bullmq` jobs driver (lib/jobs.ts).
//
// Producers never touch these Queue objects directly any more — they call
// `enqueueJob()` from lib/jobs.ts, which routes to BullMQ (Docker) or to the
// background_jobs table (Vercel). The policies below are the single source of
// truth for both drivers, so a queue retries the same way wherever it runs.
//
// Queues are created lazily: importing this module opens no Redis connection.

import { Queue, Worker, QueueEvents, type DefaultJobOptions } from 'bullmq'
import { redis } from './redis.js'

const connection = redis

// ─── Payloads ────────────────────────────────────────────────────────────────

// FBR Submission — fire-and-forget; failures do NOT block the POS payment
// response. Worker retries with exponential backoff; final failure logs for
// compliance.
export interface FbrSubmissionJob {
  orderId: string
}

// SRB Submission — parallel to FBR. Same retry profile — 6 attempts,
// exponential backoff. Separate queue so a stuck SRB submission can't block
// FBR (or vice versa); each can fail / drain on its own without dragging the
// other down.
export interface SrbSubmissionJob {
  orderId: string
  // 'sale' (default) submits the normal invoice; 'return' files an
  // invoiceType=2 sales-return for a refund.
  kind?: 'sale' | 'return'
  refundAmountCents?: number
  refundRef?: string
}

// Webhook Delivery — outbound HMAC-signed webhooks to subscribers. Each
// subscription × event gets its own job so a single bad endpoint can't hold
// up others.
export interface WebhookDeliveryJob {
  subscriptionId: string
  event: string
  payload: unknown
  emittedAt: string
}

// Cart hold auto-release (lib/reservation.ts).
export interface CartReleaseJob {
  cartId: string
  menuItemId: string
  qty: number
}

// Scheduled social post publish (workers/socialPublish.ts).
export interface SocialPublishJob {
  postId: string
}

// ─── Per-queue policy ────────────────────────────────────────────────────────
// `attempts` / `backoffMs` (exponential: backoffMs * 2^(attempt-1)) apply to
// both drivers. `jobName` is the BullMQ job name producers used before the
// driver split (workers that branch on job.name depend on it).
// `removeOnComplete: true` means a finished job leaves no trace (BullMQ
// option; the db driver deletes the row instead of marking it done).

export interface QueuePolicy {
  jobName: string
  attempts: number
  backoffMs: number
  removeOnComplete: DefaultJobOptions['removeOnComplete']
  removeOnFail: DefaultJobOptions['removeOnFail']
}

export const QUEUE_POLICIES: Record<string, QueuePolicy> = {
  'fbr-submission':      { jobName: 'submit',  attempts: 6, backoffMs: 5000, removeOnComplete: { count: 500 }, removeOnFail: { count: 500 } },
  'srb-submission':      { jobName: 'submit',  attempts: 6, backoffMs: 5000, removeOnComplete: { count: 500 }, removeOnFail: { count: 500 } },
  'webhook-delivery':    { jobName: 'deliver', attempts: 5, backoffMs: 5000, removeOnComplete: { count: 200 }, removeOnFail: { count: 500 } },
  'cart-releases':       { jobName: 'release', attempts: 1, backoffMs: 0,    removeOnComplete: true,           removeOnFail: false },
  'social-publish':      { jobName: 'publish', attempts: 1, backoffMs: 0,    removeOnComplete: 10,             removeOnFail: 20 },
  'loyalty-triggers':    { jobName: 'scan',    attempts: 1, backoffMs: 0,    removeOnComplete: { count: 500 }, removeOnFail: { count: 200 } },
  'segment-computation': { jobName: 'compute-segments', attempts: 1, backoffMs: 0, removeOnComplete: 10,       removeOnFail: 20 },
}

const FALLBACK_POLICY: QueuePolicy = { jobName: 'job', attempts: 1, backoffMs: 0, removeOnComplete: { count: 500 }, removeOnFail: { count: 500 } }

export function queuePolicy(name: string): QueuePolicy {
  return QUEUE_POLICIES[name] ?? FALLBACK_POLICY
}

// ─── BullMQ Queue cache ──────────────────────────────────────────────────────

const _queues = new Map<string, Queue>()

/** BullMQ Queue for `name` with that queue's default job options, or null when it cannot be created. */
export function getBullQueue<T = unknown>(name: string): Queue<T> | null {
  const cached = _queues.get(name)
  if (cached) return cached as unknown as Queue<T>
  try {
    const p = queuePolicy(name)
    const defaultJobOptions: DefaultJobOptions = {
      removeOnComplete: p.removeOnComplete,
      removeOnFail: p.removeOnFail,
    }
    if (p.attempts > 1) {
      defaultJobOptions.attempts = p.attempts
      if (p.backoffMs > 0) defaultJobOptions.backoff = { type: 'exponential', delay: p.backoffMs }
    }
    const q = new Queue<T>(name, { connection, defaultJobOptions })
    _queues.set(name, q as unknown as Queue)
    return q
  } catch (err) {
    console.warn(`[queue] ${name} init failed (Redis unavailable):`, (err as Error).message)
    return null
  }
}

// Named getters — kept so tests can stub a single queue.
export function getFbrQueue(): Queue<FbrSubmissionJob> | null {
  return getBullQueue<FbrSubmissionJob>('fbr-submission')
}

export function getSrbQueue(): Queue<SrbSubmissionJob> | null {
  return getBullQueue<SrbSubmissionJob>('srb-submission')
}

export function getWebhookQueue(): Queue<WebhookDeliveryJob> | null {
  return getBullQueue<WebhookDeliveryJob>('webhook-delivery')
}

// Worker is started in its own process / registered separately
export { Worker }
export type { QueueEvents }
