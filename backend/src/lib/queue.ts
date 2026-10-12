import { Queue, Worker, QueueEvents } from 'bullmq'
import { redis } from './redis.js'

const connection = redis

// ─── Fiscal connector queue ───────────────────────────────────────────────────
// (The direct 'fbr-submission' / 'srb-submission' queues are gone with the
// direct FBR / SRB filers — the external fiscal POS is the only filer. Their
// leftover jobs are drained once at boot by connectors/legacyDrain.ts.)
//
// Fast path for the POS connector's fiscal outbox (backend/src/connectors). The
// outbox rows (FiscalDocument) are the source of truth: retries, backoff and
// leases are driven by the database and a Redis-independent sweeper, so jobs
// are single-attempt and losing one (Redis down) loses nothing.

export interface FiscalConnectorJob {
  documentId: string
}

let _fiscalQueue: Queue<FiscalConnectorJob> | null = null

export function getFiscalQueue(): Queue<FiscalConnectorJob> | null {
  if (_fiscalQueue) return _fiscalQueue
  try {
    _fiscalQueue = new Queue<FiscalConnectorJob>('fiscal-connector', {
      connection,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { count: 500 },
        removeOnFail: { count: 1000 },
      },
    })
    return _fiscalQueue
  } catch (err) {
    console.warn('[queue] fiscalQueue init failed (Redis unavailable):', (err as Error).message)
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
