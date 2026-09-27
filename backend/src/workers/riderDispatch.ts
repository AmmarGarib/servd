// Rider Auto-Dispatch Worker.
//
// Fires every 2 minutes. Finds confirmed delivery orders with no rider
// assigned, then picks the nearest available rider using Haversine distance
// from the concept's lat/lng and assigns them.
//
// Delivery orders are identified by the presence of a delivery OTP (orders
// placed via storefront/cart generate an OTP at checkout). Dine-in and pure
// pickup orders are skipped.
//
// If no riders are available the order is logged and left for the next tick or
// for a human dispatcher to handle manually via /dispatch.
//
// Only a rider of the ORDER's company is a candidate, and the assignment itself
// goes through dispatch/service.ts assignRider — the same rules as a manual
// assign. This worker used to write the assignment directly, picking from
// every company's riders.

import { Queue, Worker } from 'bullmq'
import { redis } from '../lib/redis.js'
import { haversineKm } from '../lib/geo.js'
import { serviceClient as prisma } from '../lib/prisma.js'
import { assignRider } from '../modules/dispatch/service.js'

const QUEUE_NAME = 'rider-dispatch'
const RUN_EVERY_MS = 2 * 60_000

export function startRiderDispatchWorker() {
  try {
    const queue = new Queue(QUEUE_NAME, {
      connection: redis,
      defaultJobOptions: { removeOnComplete: { count: 200 }, removeOnFail: { count: 100 } },
    })

    void queue.add('scan', {}, {
      repeat: { every: RUN_EVERY_MS },
      jobId: 'rider-dispatch-recurring',
    }).catch((err: Error) => console.warn('[riderDispatch] schedule failed:', err.message))

    const worker = new Worker(QUEUE_NAME, runDispatchSweep, { connection: redis, concurrency: 1 })
    worker.on('failed', (job, err) => {
      console.error(`[riderDispatch] job ${job?.id} failed:`, err.message)
    })
    return worker
  } catch (err) {
    console.warn('[riderDispatch] worker disabled:', (err as Error).message)
    return null
  }
}

export async function runDispatchSweep(): Promise<void> {
  // Confirmed delivery orders with no rider yet. Native servd orders mark
  // themselves for delivery by issuing a delivery OTP at checkout — that
  // OTP is the dispatcher's signal that this order needs a rider.
  const orders = await prisma.order.findMany({
    where: {
      status: 'confirmed',
      riderId: null,
      deletedAt: null,
      deliveryOtp: { not: null },
    },
    take: 50,
    select: {
      id: true,
      conceptId: true,
      concept: { select: { latitude: true, longitude: true, name: true, tenantId: true } },
    },
  })

  if (orders.length === 0) return

  // Load all available riders once per sweep — cheaper than per-order queries
  // when there are many unassigned orders in a burst.
  const availableRiders = await prisma.rider.findMany({
    where: { status: 'available', isActive: true, deletedAt: null },
    select: { id: true, name: true, tenantId: true, lastLat: true, lastLng: true },
  })

  if (availableRiders.length === 0) {
    console.log(`[riderDispatch] ${orders.length} order(s) awaiting dispatch but no riders available`)
    return
  }

  // Track which riders we've assigned during this sweep so we don't double-assign.
  const assignedRiderIds = new Set<string>()

  for (const order of orders) {
    const conceptLat = order.concept.latitude
    const conceptLng = order.concept.longitude

    // Find the nearest unassigned rider. If the concept has no lat/lng
    // configured, fall back to the first available rider (FIFO).
    const candidates = availableRiders.filter(
      (r) => !assignedRiderIds.has(r.id) && r.tenantId != null && r.tenantId === order.concept.tenantId,
    )
    if (candidates.length === 0) {
      console.log(`[riderDispatch] no available rider of this company for order ${order.id.slice(0, 8)} — will retry next tick`)
      continue
    }

    let nearestRider = candidates[0]!
    if (conceptLat != null && conceptLng != null) {
      let minDist = Infinity
      for (const rider of candidates) {
        if (rider.lastLat == null || rider.lastLng == null) continue
        const dist = haversineKm(conceptLat, conceptLng, rider.lastLat, rider.lastLng)
        if (dist < minDist) {
          minDist = dist
          nearestRider = rider
        }
      }
    }

    // Marks the rider busy too; track them so they aren't re-assigned within
    // the same sweep either way.
    assignedRiderIds.add(nearestRider.id)
    try {
      await assignRider(order.id, nearestRider.id)
      console.log(`[riderDispatch] Assigned rider ${nearestRider.name} to order ${order.id.slice(0, 8)}`)
    } catch (err) {
      console.warn(`[riderDispatch] could not assign order ${order.id.slice(0, 8)}: ${(err as Error).message}`)
    }
  }
}
