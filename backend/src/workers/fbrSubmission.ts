// BullMQ Worker — FBR PRAL Invoice Submission
// SRO 1307(I)/2022 compliance: submit each completed POS order to PRAL in
// real-time. Runs fire-and-forget from processPayment; failures are logged
// and retried with exponential backoff (6 attempts, ~5 min spread).
// Final failure is surfaced as a console.error so CloudWatch alarms fire.

import { Worker } from 'bullmq'
import { redis } from '../lib/redis.js'
import { prisma } from '../lib/prisma.js'
import { buildFbrDataForOrder, submitFbrInvoice } from '../adapters/fbr/index.js'
import type { FbrSubmissionJob } from '../lib/queue.js'

export function startFbrSubmissionWorker() {
  try {
    const worker = new Worker<FbrSubmissionJob>(
      'fbr-submission',
      async (job) => {
        const { orderId } = job.data
        console.info(`[FBR] Submitting invoice for order ${orderId}, attempt ${job.attemptsMade + 1}`)

        const data = await buildFbrDataForOrder(orderId)
        if (!data) {
          // Concept not registered with FBR — skip silently (not an error)
          console.info(`[FBR] Order ${orderId} skipped — concept has no fbrPosId`)
          return { skipped: true }
        }

        const fbrInvoiceNumber = await submitFbrInvoice(data)

        await prisma.order.update({
          where: { id: orderId },
          data: { fbrInvoiceNumber },
        })

        console.info(`[FBR] Invoice submitted for order ${orderId}: ${fbrInvoiceNumber}`)
        return { fbrInvoiceNumber }
      },
      {
        connection: redis,
        concurrency: 3,
      },
    )

    worker.on('completed', (job, result: { skipped?: boolean; fbrInvoiceNumber?: string }) => {
      if (!result?.skipped) {
        console.info(`[FBR] Job ${job.id} done: ${result?.fbrInvoiceNumber}`)
      }
    })

    worker.on('failed', (job, err) => {
      const isLastAttempt = (job?.attemptsMade ?? 0) >= (job?.opts?.attempts ?? 6)
      if (isLastAttempt) {
        // Compliance failure — log at error so CloudWatch metric filter fires
        console.error(`[FBR] COMPLIANCE: invoice submission permanently failed for order ${job?.data?.orderId} after ${job?.attemptsMade} attempts: ${err.message}`)
      } else {
        console.warn(`[FBR] Job ${job?.id} attempt ${job?.attemptsMade} failed: ${err.message}`)
      }
    })

    worker.on('error', (err) => {
      console.error('[FBR] Worker error:', err.message)
    })

    console.info('[FBR] Submission worker started')
    return worker
  } catch (err) {
    console.warn('[FBR] Submission worker disabled (Redis unavailable):', (err as Error).message)
    return null
  }
}
