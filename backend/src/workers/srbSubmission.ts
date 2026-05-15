// BullMQ Worker — SRB (Sindh Revenue Board) Invoice Submission
//
// Runs in parallel with the FBR worker. Each completed POS order in a Sindh
// concept gets two submissions: one to FBR (federal) and one to SRB
// (provincial). They're independent — a failure in one doesn't roll back
// the other, and each retries on its own backoff.
//
// Skip rules:
//   - Concept has no srbPosId → silent skip (not an error). Concepts outside
//     Sindh, or in Sindh but not yet SRB-registered, simply don't submit.

import { Worker } from 'bullmq'
import { redis } from '../lib/redis.js'
import { prisma } from '../lib/prisma.js'
import { buildSrbDataForOrder, submitSrbInvoice } from '../adapters/srb/index.js'
import type { SrbSubmissionJob } from '../lib/queue.js'

export function startSrbSubmissionWorker() {
  try {
    const worker = new Worker<SrbSubmissionJob>(
      'srb-submission',
      async (job) => {
        const { orderId } = job.data
        console.info(`[SRB] Submitting invoice for order ${orderId}, attempt ${job.attemptsMade + 1}`)

        const data = await buildSrbDataForOrder(orderId)
        if (!data) {
          console.info(`[SRB] Order ${orderId} skipped — concept has no srbPosId`)
          return { skipped: true }
        }

        const srbInvoiceNumber = await submitSrbInvoice(data)

        await prisma.order.update({
          where: { id: orderId },
          data: { srbInvoiceNumber },
        })

        console.info(`[SRB] Invoice submitted for order ${orderId}: ${srbInvoiceNumber}`)
        return { srbInvoiceNumber }
      },
      {
        connection: redis,
        concurrency: 3,
      },
    )

    worker.on('completed', (job, result: { skipped?: boolean; srbInvoiceNumber?: string }) => {
      if (!result?.skipped) {
        console.info(`[SRB] Job ${job.id} done: ${result?.srbInvoiceNumber}`)
      }
    })

    worker.on('failed', (job, err) => {
      const isLastAttempt = (job?.attemptsMade ?? 0) >= (job?.opts?.attempts ?? 6)
      if (isLastAttempt) {
        // Compliance failure — log at error so monitors can alert
        console.error(`[SRB] COMPLIANCE: invoice submission permanently failed for order ${job?.data?.orderId} after ${job?.attemptsMade} attempts: ${err.message}`)
      } else {
        console.warn(`[SRB] Job ${job?.id} attempt ${job?.attemptsMade} failed: ${err.message}`)
      }
    })

    worker.on('error', (err) => {
      console.error('[SRB] Worker error:', err.message)
    })

    console.info('[SRB] Submission worker started')
    return worker
  } catch (err) {
    console.warn('[SRB] Submission worker disabled (Redis unavailable):', (err as Error).message)
    return null
  }
}
