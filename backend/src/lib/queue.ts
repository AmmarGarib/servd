import { Queue, Worker, QueueEvents } from 'bullmq'
import { redis } from './redis.js'

const connection = redis

// ─── Order Ingestion Queue ────────────────────────────────────────────────────
// Handles retry logic for failed webhook acknowledgements

export interface OrderIngestionJob {
  source: string
  payload: unknown
  attempt?: number
}

let _orderIngestionQueue: Queue<OrderIngestionJob> | null = null

export function getOrderIngestionQueue(): Queue<OrderIngestionJob> | null {
  if (_orderIngestionQueue) return _orderIngestionQueue
  try {
    _orderIngestionQueue = new Queue<OrderIngestionJob>('order-ingestion', {
      connection,
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 200 },
      },
    })
    return _orderIngestionQueue
  } catch (err) {
    console.warn('[queue] orderIngestionQueue init failed (Redis unavailable):', (err as Error).message)
    return null
  }
}

// Legacy export — lazily initialised on first access
export const orderIngestionQueue = { add: (...args: Parameters<Queue['add']>) => getOrderIngestionQueue()?.add(...args) }

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
