// BullMQ Worker — FBR PRAL Invoice Submission
// SRO 1307(I)/2022 compliance: submit each completed POS order to PRAL in
// real-time. Runs fire-and-forget from processPayment; failures are logged
// and retried with exponential backoff (6 attempts, ~5 min spread).
// Final failure is surfaced as a console.error so CloudWatch alarms fire.
//
// The work itself is processFbrSubmission(); the BullMQ worker below (Docker)
// and the db jobs driver (Vercel, workers/registry.ts) both call it.

import { Worker } from 'bullmq'
import { redis } from '../lib/redis.js'
import { serviceClient as prisma } from '../lib/prisma.js'
import { buildFbrDataForOrder, submitFbrInvoice } from '../adapters/fbr/index.js'
import type { FbrSubmissionJob } from '../lib/queue.js'
import type { JobContext } from '../lib/jobs.js'

export type FbrSubmissionResult = { skipped: true } | { fbrInvoiceNumber: string }

export async function processFbrSubmission(data: FbrSubmissionJob, ctx: Pick<JobContext, 'attempt'>): Promise<FbrSubmissionResult> {
  const { orderId } = data
  console.info(`[FBR] Submitting invoice for order ${orderId}, attempt ${ctx.attempt}`)

  const fbrData = await buildFbrDataForOrder(orderId)
  if (!fbrData) {
    // Concept not registered with FBR — skip silently (not an error)
    console.info(`[FBR] Order ${orderId} skipped — concept has no fbrPosId`)
    return { skipped: true }
  }

  const fbrInvoiceNumber = await submitFbrInvoice(fbrData)

  await prisma.order.update({
    where: { id: orderId },
    data: { fbrInvoiceNumber },
  })

  console.info(`[FBR] Invoice submitted for order ${orderId}: ${fbrInvoiceNumber}`)
  return { fbrInvoiceNumber }
}

export function logFbrCompleted(jobId: string | undefined, result: { skipped?: boolean; fbrInvoiceNumber?: string } | undefined): void {
  if (!result?.skipped) {
    console.info(`[FBR] Job ${jobId} done: ${result?.fbrInvoiceNumber}`)
  }
}

export function logFbrFailed(jobId: string | undefined, orderId: string | undefined, attemptsMade: number, isLastAttempt: boolean, err: Error): void {
  if (isLastAttempt) {
    // Compliance failure — log at error so CloudWatch metric filter fires
    console.error(`[FBR] COMPLIANCE: invoice submission permanently failed for order ${orderId} after ${attemptsMade} attempts: ${err.message}`)
  } else {
    console.warn(`[FBR] Job ${jobId} attempt ${attemptsMade} failed: ${err.message}`)
  }
}

export function startFbrSubmissionWorker() {
  try {
    const worker = new Worker<FbrSubmissionJob>(
      'fbr-submission',
      async (job) => processFbrSubmission(job.data, { attempt: job.attemptsMade + 1 }),
      {
        connection: redis,
        concurrency: 3,
      },
    )

    worker.on('completed', (job, result: { skipped?: boolean; fbrInvoiceNumber?: string }) => {
      logFbrCompleted(job.id, result)
    })

    worker.on('failed', (job, err) => {
      const isLastAttempt = (job?.attemptsMade ?? 0) >= (job?.opts?.attempts ?? 6)
      logFbrFailed(job?.id, job?.data?.orderId, job?.attemptsMade ?? 0, isLastAttempt, err)
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
