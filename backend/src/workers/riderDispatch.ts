// Rider Auto-Dispatch Worker.
//
// Fires every 2 minutes. Finds confirmed delivery orders with no rider
// assigned, then picks the nearest available rider using Haversine distance
// from the concept's lat/lng and assigns them.
//
// Delivery orders are identified by source (foodpanda, careem) or by the
// presence of a delivery OTP (native delivery orders placed via storefront/cart
// that generate an OTP at checkout). Dine-in and pure pickup orders are skipped.
//
// If no riders are available the order is logged and left for the next tick or
// for a human dispatcher to handle manually via /dispatch.

import { Queue, Worker } from 'bullmq'
import { redis } from '../lib/redis.js'
import { prisma } from '../lib/prisma.js'

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

async function runDispatchSweep(): Promise<void> {
  // Confirmed delivery orders with no rider yet.
  // Delivery orders are either from a delivery platform (foodpanda/careem)
  // or native orders that received a delivery OTP at checkout.
  const orders = await prisma.order.findMany({
    where: {
      status: 'confirmed',
      riderId: null,
      deletedAt: null,
      OR: [
        { source: { in: ['foodpanda', 'careem'] } },
        { deliveryOtp: { not: null } },
      ],
    },
    take: 50,
    select: {
      id: true,
      conceptId: true,
      concept: { select: { latitude: true, longitude: true, name: true } },
    },
  })

  if (orders.length === 0) return

  // Load all available riders once per sweep — cheaper than per-order queries
  // when there are many unassigned orders in a burst.
  const availableRiders = await prisma.rider.findMany({
    where: { status: 'available', isActive: true, deletedAt: null },
    select: { id: true, name: true, lastLat: true, lastLng: true },
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
    const candidates = availableRiders.filter((r) => !assignedRiderIds.has(r.id))
    if (candidates.length === 0) {
      console.log(`[riderDispatch] no remaining riders for order ${order.id.slice(0, 8)} — will retry next tick`)
      break
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

    await prisma.order.update({
      where: { id: order.id },
      data: { riderId: nearestRider.id },
    })

    // Mark rider busy so they aren't re-assigned within the same sweep.
    await prisma.rider.update({
      where: { id: nearestRider.id },
      data: { status: 'busy' as never },
    })

    assignedRiderIds.add(nearestRider.id)
    console.log(`[riderDispatch] Assigned rider ${nearestRider.name} to order ${order.id.slice(0, 8)}`)
  }
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLon/2)**2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))
}
