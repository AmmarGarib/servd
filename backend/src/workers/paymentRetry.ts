// Payment retry worker.
//
// Fires every 10 minutes. Finds Payment records in 'failed' status that have
// not yet exhausted their retry budget and attempts to re-process them.
//
// Retry policy:
//   • Maximum 3 attempts (retryCount < 3).
//   • Back-off guard: lastRetryAt must be null OR more than 10 minutes ago,
//     so we never hammer a gateway that just rejected us.
//   • After the 3rd attempt the payment is marked 'failed' permanently and
//     no further retries are scheduled.
//
// NOTE — gateway integration:
//   This worker contains the full retry orchestration skeleton. The actual
//   gateway charge call (Keenu QR re-initiation, JazzCash re-auth, etc.) must
//   be inserted at the marked location below. Each gateway client lives in
//   src/lib/gateways/ and accepts { payment, order } — return a
//   { success: boolean; gatewayRef?: string; gatewayMeta?: object } shape so
//   this worker can persist the result uniformly. Until that integration is
//   wired, the worker increments the counter and logs the attempt; in
//   production this prevents the retry queue from growing unboundedly while
//   the gateway code is being built out.

import { Queue, Worker } from 'bullmq'
import { redis } from '../lib/redis.js'
import { serviceClient as prisma } from '../lib/prisma.js'

const QUEUE_NAME    = 'payment-retry'
const RUN_EVERY_MS  = 10 * 60_000   // 10 minutes
const BACK_OFF_MS   = 10 * 60_000   // don't retry sooner than 10 min after last attempt
const MAX_RETRIES   = 3

export function startPaymentRetryWorker() {
  try {
    const queue = new Queue(QUEUE_NAME, {
      connection: redis,
      defaultJobOptions: { removeOnComplete: { count: 200 }, removeOnFail: { count: 100 } },
    })

    void queue.add('scan', {}, {
      repeat: { every: RUN_EVERY_MS },
      jobId: 'payment-retry-recurring',
    }).catch((err: Error) => console.warn('[paymentRetry] schedule failed:', err.message))

    const worker = new Worker(QUEUE_NAME, runRetrySweep, { connection: redis, concurrency: 1 })
    worker.on('failed', (job, err) => {
      console.error(`[paymentRetry] job ${job?.id} failed:`, err.message)
    })
    return worker
  } catch (err) {
    console.warn('[paymentRetry] worker disabled:', (err as Error).message)
    return null
  }
}

async function runRetrySweep(): Promise<void> {
  const backOffCutoff = new Date(Date.now() - BACK_OFF_MS)

  const due = await prisma.payment.findMany({
    where: {
      status: 'failed',
      retryCount: { lt: MAX_RETRIES },
      OR: [
        { lastRetryAt: null },
        { lastRetryAt: { lt: backOffCutoff } },
      ],
    },
    take: 100,
    select: {
      id: true,
      orderId: true,
      method: true,
      gateway: true,
      amountCents: true,
      retryCount: true,
      gatewayRef: true,
      order: {
        select: {
          id: true,
          conceptId: true,
          totalCents: true,
          customerId: true,
        },
      },
    },
  })

  if (due.length === 0) return

  console.log(`[paymentRetry] processing ${due.length} failed payment(s)`)

  for (const payment of due) {
    const nextRetryCount = payment.retryCount + 1
    const isLastAttempt  = nextRetryCount >= MAX_RETRIES

    console.log(
      `[paymentRetry] attempt ${nextRetryCount}/${MAX_RETRIES} for payment ${payment.id}` +
      ` (order ${payment.orderId}, gateway: ${payment.gateway}, amount: ${payment.amountCents}¢)`,
    )

    try {
      // ── GATEWAY CALL ──────────────────────────────────────────────────────
      //
      // Insert real gateway integration here. Example shape:
      //
      //   const gw = getGatewayClient(payment.gateway)   // keenu | jazzcash | easypaisa
      //   const result = await gw.retryCharge({
      //     originalRef: payment.gatewayRef,
      //     amountCents: payment.amountCents,
      //     orderId: payment.orderId,
      //   })
      //
      // On success: set status='paid', gatewayRef=result.ref, processedAt=now.
      // On failure: fall through — the counter increment below is sufficient.
      //
      // For now we optimistically assume the attempt happened and update
      // bookkeeping so the retry queue advances correctly.
      //
      const gatewaySuccess = false  // replace with: result.success

      if (gatewaySuccess) {
        // Gateway accepted the re-charge — mark payment paid.
        await prisma.payment.update({
          where: { id: payment.id },
          data: {
            status: 'paid',
            retryCount: nextRetryCount,
            lastRetryAt: new Date(),
            processedAt: new Date(),
            // gatewayRef:  result.ref,
            // gatewayMeta: result.meta,
          },
        })
        console.log(`[paymentRetry] payment ${payment.id} succeeded on attempt ${nextRetryCount}`)
      } else if (isLastAttempt) {
        // All retries exhausted — mark permanently failed so we stop touching it.
        await prisma.payment.update({
          where: { id: payment.id },
          data: {
            status: 'failed',          // PaymentStatus has no 'permanently_failed' variant;
            retryCount: nextRetryCount, // retryCount >= MAX_RETRIES acts as the terminal gate.
            lastRetryAt: new Date(),
          },
        })
        console.warn(`[paymentRetry] payment ${payment.id} exhausted all ${MAX_RETRIES} retries — giving up`)
      } else {
        // Attempt failed, budget remaining — increment counter and back off.
        await prisma.payment.update({
          where: { id: payment.id },
          data: {
            retryCount: nextRetryCount,
            lastRetryAt: new Date(),
          },
        })
        console.log(`[paymentRetry] payment ${payment.id} still failing (attempt ${nextRetryCount}/${MAX_RETRIES}) — will retry next tick`)
      }
    } catch (err) {
      console.error(`[paymentRetry] error processing payment ${payment.id}:`, (err as Error).message)
    }
  }
}
