// Fiscal connector worker (spec §9.1). W4 starts it under ENABLE_WORKERS,
// after drainLegacyTaxQueues().
//
//   - BullMQ queue `fiscal-connector` (getFiscalQueue): the fast path. Jobs are
//     {documentId}, single attempt — retries and backoff live in the DB row.
//     Handler: sendFiscalDocument(id, 'worker', 15 s).
//   - Sweeper every 30 s (node-cron), Redis-independent: frees expired leases
//     (next attempt looks up first), promotes waiting refunds, re-drives due
//     rows per company (inline when the queue is unreachable), fails rows past
//     their age, and sends the per-company digest. The per-row lease is the
//     single-flight guarantee, so no global lock is needed — only an
//     in-process re-entrancy guard.

import cron from 'node-cron'
import { Worker } from 'bullmq'
import { redis } from '../lib/redis.js'
import type { FiscalConnectorJob } from '../lib/queue.js'
import { sendFiscalDocument, sweepFiscal } from '../connectors/fiscal/outbox.js'

let sweeping = false

export async function runFiscalSweep(): Promise<void> {
  if (sweeping) return
  sweeping = true
  try {
    const s = await sweepFiscal()
    if (s.leasesFreed || s.promoted || s.sentInline || s.failed) {
      console.info(`[fiscal-sweeper] leases=${s.leasesFreed} promoted=${s.promoted} kicked=${s.kicked} inline=${s.sentInline} failed=${s.failed}`)
    }
  } catch (err) {
    console.error('[fiscal-sweeper] tick failed:', (err as Error).message)
  } finally {
    sweeping = false
  }
}

export function startFiscalConnectorWorker(): { worker: Worker<FiscalConnectorJob> | null; stop: () => Promise<void> } {
  let worker: Worker<FiscalConnectorJob> | null = null
  try {
    worker = new Worker<FiscalConnectorJob>(
      'fiscal-connector',
      async (job) => {
        await sendFiscalDocument(job.data.documentId, 'worker', 15_000)
      },
      { connection: redis, concurrency: 3 },
    )
    worker.on('failed', (job, err) => console.error(`[fiscal-connector] job ${job?.id} failed:`, err.message))
  } catch (err) {
    // Redis unavailable: the sweeper alone keeps filing.
    console.warn('[fiscal-connector] queue worker not started:', (err as Error).message)
  }
  const task = cron.schedule('*/30 * * * * *', () => { void runFiscalSweep() })
  console.info('[fiscal-connector] worker + sweeper started')
  return {
    worker,
    stop: async () => {
      task.stop()
      await worker?.close().catch(() => {})
    },
  }
}
