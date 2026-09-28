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
//
// The work itself is processSrbSubmission(); the BullMQ worker below (Docker)
// and the db jobs driver (Vercel, workers/registry.ts) both call it.

import { Worker } from 'bullmq'
import { redis } from '../lib/redis.js'
import { serviceClient as prisma } from '../lib/prisma.js'
import { buildSrbDataForOrder, buildSrbReturnForRefund, submitSrbInvoice } from '../adapters/srb/index.js'
import type { SrbSubmissionJob } from '../lib/queue.js'
import type { JobContext } from '../lib/jobs.js'

export type SrbSubmissionResult =
  | { skipped: true }
  | { srbInvoiceNumber: string; kind?: 'return' }

export async function processSrbSubmission(data: SrbSubmissionJob, ctx: Pick<JobContext, 'attempt' | 'jobId'>): Promise<SrbSubmissionResult> {
  const { orderId, kind, refundAmountCents, refundRef } = data

  // Sales-return (refund) path — invoiceType 2. Doesn't touch the order's
  // sale invoice fields; the return id is recorded by the refund audit log.
  if (kind === 'return') {
    console.info(`[SRB] Submitting sales-return for order ${orderId}, attempt ${ctx.attempt}`)
    const ret = await buildSrbReturnForRefund(orderId, refundAmountCents ?? 0, refundRef ?? ctx.jobId ?? orderId)
    if (!ret) {
      console.info(`[SRB] Return for order ${orderId} skipped — concept has no srbPosId`)
      return { skipped: true }
    }
    const { srbInvoiceId } = await submitSrbInvoice(ret)
    console.info(`[SRB] Sales-return submitted for order ${orderId}: ${srbInvoiceId}`)
    return { srbInvoiceNumber: srbInvoiceId, kind: 'return' }
  }

  console.info(`[SRB] Submitting invoice for order ${orderId}, attempt ${ctx.attempt}`)

  const srbData = await buildSrbDataForOrder(orderId)
  if (!srbData) {
    console.info(`[SRB] Order ${orderId} skipped — concept has no srbPosId`)
    return { skipped: true }
  }

  const { srbInvoiceId, qrCodeLink } = await submitSrbInvoice(srbData)

  await prisma.order.update({
    where: { id: orderId },
    data: { srbInvoiceNumber: srbInvoiceId, srbQrCodeLink: qrCodeLink },
  })

  console.info(`[SRB] Invoice submitted for order ${orderId}: ${srbInvoiceId}`)
  return { srbInvoiceNumber: srbInvoiceId }
}

export function logSrbCompleted(jobId: string | undefined, result: { skipped?: boolean; srbInvoiceNumber?: string } | undefined): void {
  if (!result?.skipped) {
    console.info(`[SRB] Job ${jobId} done: ${result?.srbInvoiceNumber}`)
  }
}

export function logSrbFailed(jobId: string | undefined, orderId: string | undefined, attemptsMade: number, isLastAttempt: boolean, err: Error): void {
  if (isLastAttempt) {
    // Compliance failure — log at error so monitors can alert
    console.error(`[SRB] COMPLIANCE: invoice submission permanently failed for order ${orderId} after ${attemptsMade} attempts: ${err.message}`)
  } else {
    console.warn(`[SRB] Job ${jobId} attempt ${attemptsMade} failed: ${err.message}`)
  }
}

export function startSrbSubmissionWorker() {
  try {
    const worker = new Worker<SrbSubmissionJob>(
      'srb-submission',
      async (job) => processSrbSubmission(job.data, { attempt: job.attemptsMade + 1, jobId: job.id }),
      {
        connection: redis,
        concurrency: 3,
      },
    )

    worker.on('completed', (job, result: { skipped?: boolean; srbInvoiceNumber?: string }) => {
      logSrbCompleted(job.id, result)
    })

    worker.on('failed', (job, err) => {
      const isLastAttempt = (job?.attemptsMade ?? 0) >= (job?.opts?.attempts ?? 6)
      logSrbFailed(job?.id, job?.data?.orderId, job?.attemptsMade ?? 0, isLastAttempt, err)
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
