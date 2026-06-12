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
import { serviceClient as prisma } from '../lib/prisma.js'
import { buildSrbDataForOrder, buildSrbReturnForRefund, submitSrbInvoice } from '../adapters/srb/index.js'
import type { SrbSubmissionJob } from '../lib/queue.js'

export function startSrbSubmissionWorker() {
  try {
    const worker = new Worker<SrbSubmissionJob>(
      'srb-submission',
      async (job) => {
        const { orderId, kind, refundAmountCents, refundRef } = job.data

        // Sales-return (refund) path — invoiceType 2. Doesn't touch the order's
        // sale invoice fields; the return id is recorded by the refund audit log.
        if (kind === 'return') {
          console.info(`[SRB] Submitting sales-return for order ${orderId}, attempt ${job.attemptsMade + 1}`)
          const ret = await buildSrbReturnForRefund(orderId, refundAmountCents ?? 0, refundRef ?? job.id ?? orderId)
          if (!ret) {
            console.info(`[SRB] Return for order ${orderId} skipped — concept has no srbPosId`)
            return { skipped: true }
          }
          const { srbInvoiceId } = await submitSrbInvoice(ret)
          console.info(`[SRB] Sales-return submitted for order ${orderId}: ${srbInvoiceId}`)
          return { srbInvoiceNumber: srbInvoiceId, kind: 'return' }
        }

        console.info(`[SRB] Submitting invoice for order ${orderId}, attempt ${job.attemptsMade + 1}`)

        const data = await buildSrbDataForOrder(orderId)
        if (!data) {
          console.info(`[SRB] Order ${orderId} skipped — concept has no srbPosId`)
          return { skipped: true }
        }

        const { srbInvoiceId, qrCodeLink } = await submitSrbInvoice(data)

        await prisma.order.update({
          where: { id: orderId },
          data: { srbInvoiceNumber: srbInvoiceId, srbQrCodeLink: qrCodeLink },
        })

        console.info(`[SRB] Invoice submitted for order ${orderId}: ${srbInvoiceId}`)
        return { srbInvoiceNumber: srbInvoiceId }
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
