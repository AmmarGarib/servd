import { Queue, Worker, QueueEvents } from 'bullmq'
import { redis } from './redis.js'

const connection = redis

// ─── FBR Submission Queue ─────────────────────────────────────────────────────
// Fire-and-forget; failures do NOT block the POS payment response.
// Worker retries with exponential backoff; final failure logs for compliance.

export interface FbrSubmissionJob {
  orderId: string
}

let _fbrQueue: Queue<FbrSubmissionJob> | null = null

export function getFbrQueue(): Queue<FbrSubmissionJob> | null {
  if (_fbrQueue) return _fbrQueue
  try {
    _fbrQueue = new Queue<FbrSubmissionJob>('fbr-submission', {
      connection,
      defaultJobOptions: {
        attempts: 6,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { count: 500 },
        removeOnFail: { count: 500 },
      },
    })
    return _fbrQueue
  } catch (err) {
    console.warn('[queue] fbrQueue init failed (Redis unavailable):', (err as Error).message)
    return null
  }
}

// ─── SRB Submission Queue ─────────────────────────────────────────────────────
// Parallel to FBR. Same retry profile — 6 attempts, exponential backoff.
// Separate queue so a stuck SRB submission can't block FBR (or vice versa);
// each can fail / drain on its own without dragging the other down.

export interface SrbSubmissionJob {
  orderId: string
}

let _srbQueue: Queue<SrbSubmissionJob> | null = null

export function getSrbQueue(): Queue<SrbSubmissionJob> | null {
  if (_srbQueue) return _srbQueue
  try {
    _srbQueue = new Queue<SrbSubmissionJob>('srb-submission', {
      connection,
      defaultJobOptions: {
        attempts: 6,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { count: 500 },
        removeOnFail: { count: 500 },
      },
    })
    return _srbQueue
  } catch (err) {
    console.warn('[queue] srbQueue init failed (Redis unavailable):', (err as Error).message)
    return null
  }
}

// ─── Webhook Delivery Queue ───────────────────────────────────────────────────
// Outbound HMAC-signed webhooks to subscribers. Each subscription × event
// gets its own job so a single bad endpoint can't hold up others.

export interface WebhookDeliveryJob {
  subscriptionId: string
  event: string
  payload: unknown
  emittedAt: string
}

let _webhookQueue: Queue<WebhookDeliveryJob> | null = null

export function getWebhookQueue(): Queue<WebhookDeliveryJob> | null {
  if (_webhookQueue) return _webhookQueue
  try {
    _webhookQueue = new Queue<WebhookDeliveryJob>('webhook-delivery', {
      connection,
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 500 },
      },
    })
    return _webhookQueue
  } catch (err) {
    console.warn('[queue] webhookQueue init failed (Redis unavailable):', (err as Error).message)
    return null
  }
}

// Worker is started in its own process / registered separately
export { Worker }
export type { QueueEvents }
