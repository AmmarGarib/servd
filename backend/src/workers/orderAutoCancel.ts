// Order auto-cancel worker.
//
// Fires every 5 minutes. Finds orders that have stalled in early statuses
// and cancels them automatically so operators never see a ghost queue:
//
//   • 'received' for > 30 minutes AND source in ('servd', 'cart')
//     → digital orders that were never acknowledged by the kitchen. Foodpanda,
//       Careem, POS, and manual orders are intentionally excluded because they
//       have their own SLAs or are operator-managed.
//
//   • 'confirmed' for > 2 hours (any source)
//     → order was accepted but never progressed to preparing / ready. Two
//       hours is a generous ceiling; real kitchens will notice before then, but
//       this catches crashes, tablet deaths, or forgotten tickets.
//
// Pre-orders (ONL-R2-03): an order with a scheduledFor in the future is not
// stalled — it is waiting for its time. Both clocks start at the LATER of
// placedAt and scheduledFor, so tomorrow's 10:30 pre-order is not cancelled
// half an hour after it was placed (it used to be, and the customer was told).
// It is swept only if still unacknowledged 30 minutes after its own time.
//
// Each order is cancelled through cancelOrder() — the same path a manager's
// cancel takes — so the customer is notified (operator templates apply), the
// wallet and gift-card money they paid with is given back, a promo usage is
// released and the cancellation is audited. This worker used to write the
// status directly, which did none of that: a storefront order that timed out
// kept the customer's wallet and gift-card money.

import { Queue, Worker } from 'bullmq'
import { redis } from '../lib/redis.js'
import { serviceClient as prisma } from '../lib/prisma.js'
import { cancelOrder } from '../modules/orders/service.js'

const QUEUE_NAME = 'order-auto-cancel'
const RUN_EVERY_MS = 5 * 60_000

// Thresholds
const RECEIVED_TIMEOUT_MS  = 30 * 60_000        // 30 minutes
const CONFIRMED_TIMEOUT_MS = 2 * 60 * 60_000    // 2 hours

export function startOrderAutoCancelWorker() {
  try {
    const queue = new Queue(QUEUE_NAME, {
      connection: redis,
      defaultJobOptions: { removeOnComplete: { count: 200 }, removeOnFail: { count: 100 } },
    })

    void queue.add('scan', {}, {
      repeat: { every: RUN_EVERY_MS },
      jobId: 'order-auto-cancel-recurring',
    }).catch((err: Error) => console.warn('[orderAutoCancel] schedule failed:', err.message))

    const worker = new Worker(QUEUE_NAME, runCancelSweep, { connection: redis, concurrency: 1 })
    worker.on('failed', (job, err) => {
      console.error(`[orderAutoCancel] job ${job?.id} failed:`, err.message)
    })
    return worker
  } catch (err) {
    console.warn('[orderAutoCancel] worker disabled:', (err as Error).message)
    return null
  }
}

/**
 * `where` fragment: the order is not scheduled for a time after `cutoff` —
 * either it has no scheduledFor (an order for now) or its scheduled time has
 * itself passed the cutoff. Combined with `placedAt < cutoff` this is
 * "greatest(placedAt, scheduledFor) < cutoff".
 */
function notScheduledAfter(cutoff: Date) {
  return { OR: [{ scheduledFor: null }, { scheduledFor: { lt: cutoff } }] }
}

export async function runCancelSweep(): Promise<void> {
  const now = new Date()
  const receivedCutoff  = new Date(now.getTime() - RECEIVED_TIMEOUT_MS)
  const confirmedCutoff = new Date(now.getTime() - CONFIRMED_TIMEOUT_MS)

  // Fetch both cohorts in parallel — independent DB queries.
  const [stalledReceived, stalledConfirmed] = await Promise.all([
    // Digital orders stuck in 'received' > 30 min.
    // Exclude pos (staff-facing) and manual (operator-entered) — those have
    // different workflows where a stale 'received' just means staff are slow.
    prisma.order.findMany({
      where: {
        status: 'received',
        deletedAt: null,
        source: { in: ['servd', 'cart'] },
        placedAt: { lt: receivedCutoff },
        ...notScheduledAfter(receivedCutoff),
      },
      take: 200,
      select: { id: true, status: true },
    }),

    // Any-source orders stuck in 'confirmed' > 2 hours.
    prisma.order.findMany({
      where: {
        status: 'confirmed',
        deletedAt: null,
        placedAt: { lt: confirmedCutoff },
        ...notScheduledAfter(confirmedCutoff),
      },
      take: 200,
      select: { id: true, status: true },
    }),
  ])

  const toCancel = [...stalledReceived, ...stalledConfirmed]

  if (toCancel.length === 0) return

  console.log(`[orderAutoCancel] cancelling ${toCancel.length} stalled order(s) (${stalledReceived.length} received, ${stalledConfirmed.length} confirmed)`)

  for (const order of toCancel) {
    try {
      // onlyFrom: the status the sweep saw. If the kitchen confirmed the order
      // in the meantime it is no longer stalled and must not be cancelled.
      await cancelOrder(order.id, {
        reason: 'auto_cancelled_timeout',
        actor: null,
        action: 'order.auto_cancel',
        onlyFrom: [order.status],
      })
    } catch (err) {
      console.error(`[orderAutoCancel] failed to cancel order ${order.id}:`, (err as Error).message)
    }
  }
}
