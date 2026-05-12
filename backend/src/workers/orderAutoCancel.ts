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
// For each cancelled order we send a status-update notification to the
// customer (SMS + email) via the shared sendOrderStatusUpdate helper, which
// uses operator-defined template overrides if configured.

import { Queue, Worker } from 'bullmq'
import { redis } from '../lib/redis.js'
import { prisma } from '../lib/prisma.js'
import { sendOrderStatusUpdate } from '../lib/notify.js'

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

async function runCancelSweep(): Promise<void> {
  const now = new Date()
  const receivedCutoff  = new Date(now.getTime() - RECEIVED_TIMEOUT_MS)
  const confirmedCutoff = new Date(now.getTime() - CONFIRMED_TIMEOUT_MS)

  // Fetch both cohorts in parallel — independent DB queries.
  const [stalledReceived, stalledConfirmed] = await Promise.all([
    // Digital orders stuck in 'received' > 30 min.
    // Exclude foodpanda/careem (aggregator-managed), pos (staff-facing), and
    // manual (operator-entered) — those have different workflows.
    prisma.order.findMany({
      where: {
        status: 'received',
        source: { in: ['servd', 'cart'] },
        placedAt: { lt: receivedCutoff },
      },
      take: 200,
      select: {
        id: true,
        conceptId: true,
        customerId: true,
        customerName: true,
        customer: { select: { email: true, phone: true, name: true } },
        concept:  { select: { name: true } },
      },
    }),

    // Any-source orders stuck in 'confirmed' > 2 hours.
    prisma.order.findMany({
      where: {
        status: 'confirmed',
        placedAt: { lt: confirmedCutoff },
      },
      take: 200,
      select: {
        id: true,
        conceptId: true,
        customerId: true,
        customerName: true,
        customer: { select: { email: true, phone: true, name: true } },
        concept:  { select: { name: true } },
      },
    }),
  ])

  const toCancel = [...stalledReceived, ...stalledConfirmed]

  if (toCancel.length === 0) return

  console.log(`[orderAutoCancel] cancelling ${toCancel.length} stalled order(s) (${stalledReceived.length} received, ${stalledConfirmed.length} confirmed)`)

  const cancelledAt = new Date()

  for (const order of toCancel) {
    try {
      await prisma.order.update({
        where: { id: order.id },
        data: {
          status: 'cancelled',
          cancelledAt,
          cancellationReason: 'auto_cancelled_timeout',
        },
      })

      // Best-effort notification — a send failure must not prevent the next
      // order from being processed or the DB update from sticking.
      const email        = order.customer?.email ?? null
      const phone        = order.customer?.phone ?? null
      const customerName = order.customer?.name ?? order.customerName ?? null

      if (email || phone) {
        await sendOrderStatusUpdate({
          email,
          phone,
          conceptName: order.concept.name,
          conceptId: order.conceptId,
          orderId: order.id,
          status: 'cancelled',
          customerName,
        }).catch((err: Error) => {
          console.error(`[orderAutoCancel] notify failed for order ${order.id}:`, err.message)
        })
      }
    } catch (err) {
      console.error(`[orderAutoCancel] failed to cancel order ${order.id}:`, (err as Error).message)
    }
  }
}
