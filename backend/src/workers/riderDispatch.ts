// Rider Auto-Dispatch Worker (docs/rider-app.md, "Dispatch changes").
//
// Every 30 seconds:
//   1. Offers the auto-dispatcher made that nobody accepted within 3 minutes
//      are withdrawn: a `timed_out` event, the rider is taken off, and the
//      order goes to the next rider on this same sweep. Only the worker's own
//      offers time out — a dispatcher who hands an order to a rider by hand
//      (often a rider without the app) is not overruled by a timer.
//   2. Delivery orders (`fulfilmentType = 'delivery'`) with no rider, in
//      `confirmed | preparing | ready`, placed in the last DISPATCH_WINDOW_MS,
//      (or, for a pre-order, scheduled inside the window and no later than
//      its prep window from now — O-RV-3) are offered to the nearest
//      available rider — from the order's own
//      company or from a company with an active fleet agreement to deliver for
//      it (lib/fleet.ts). A rider who declined that order is never offered it
//      again; one whose offer timed out is tried only when nobody else is free.
//
// The window matters: nothing closes a 'preparing' or 'ready' order on its own
// (orderAutoCancel only ends 'confirmed' ones after two hours), so without it
// every old delivery order left open — delivered outside the system and never
// closed — would be offered to riders on deploy, cycle through the fleet on
// the 3-minute timer, and crowd newer orders out of the batch.
//
// Both writes are claims (dispatch/service): an offer only lands on an order
// that still has NO rider (a dispatcher who assigned by hand since the sweep
// read it wins) and on a rider who is still 'available'; a timeout only
// withdraws an offer the rider has still not accepted.
//
// Hourly it also prunes rider_locations older than 24 hours.
//
// The assignment itself goes through dispatch/service.ts assignRider — the
// same rules as a manual assign (company / agreement, active, not offline).
// This worker used to write the assignment directly, picking from every
// company's riders, and keyed "is this a delivery?" on the order having a
// hand-over code rather than on its fulfilment type.

import { Queue, Worker, type Job } from 'bullmq'
import { redis } from '../lib/redis.js'
import { haversineKm } from '../lib/geo.js'
import { serviceClient as prisma } from '../lib/prisma.js'
import { fleetCompaniesFor } from '../lib/fleet.js'
import { assignRider, withdrawOffer, AUTO_OFFER_NOTE, RIDER_ACTIVE_STATUSES } from '../modules/dispatch/service.js'
import { PRE_ORDER_PREP_MS } from '../modules/orders/service.js'

const QUEUE_NAME = 'rider-dispatch'
const RUN_EVERY_MS = 30_000
const PRUNE_EVERY_MS = 60 * 60_000

/** An auto offer nobody accepted is withdrawn after this long. */
export const OFFER_TIMEOUT_MS = 3 * 60_000
/** Location history kept for disputes and time-to-arrive analytics. */
export const LOCATION_RETENTION_MS = 24 * 60 * 60_000
/** Only orders placed this recently are offered automatically (see header). */
export const DISPATCH_WINDOW_MS = 6 * 60 * 60_000
/** Orders looked at per sweep, oldest first. */
const SWEEP_BATCH = 100

const DISPATCHABLE = ['confirmed', 'preparing', 'ready'] as const

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
    void queue.add('prune', {}, {
      repeat: { every: PRUNE_EVERY_MS },
      jobId: 'rider-locations-prune',
    }).catch((err: Error) => console.warn('[riderDispatch] prune schedule failed:', err.message))

    const worker = new Worker(QUEUE_NAME, async (job: Job) => {
      if (job.name === 'prune') {
        const n = await pruneRiderLocations()
        if (n > 0) console.log(`[riderDispatch] pruned ${n} rider location fix(es) older than 24h`)
        return
      }
      await runDispatchSweep()
    }, { connection: redis, concurrency: 1 })
    worker.on('failed', (job, err) => {
      console.error(`[riderDispatch] job ${job?.id} failed:`, err.message)
    })
    return worker
  } catch (err) {
    console.warn('[riderDispatch] worker disabled:', (err as Error).message)
    return null
  }
}

/** Delete location fixes older than 24 hours. Returns how many went. */
export async function pruneRiderLocations(now = new Date()): Promise<number> {
  const r = await prisma.riderLocation.deleteMany({
    where: { recordedAt: { lt: new Date(now.getTime() - LOCATION_RETENTION_MS) } },
  })
  return r.count
}

/**
 * Withdraw the auto-dispatcher's offers that have waited longer than
 * OFFER_TIMEOUT_MS without being accepted. Returns the order ids freed.
 */
export async function expireStaleOffers(now = new Date()): Promise<string[]> {
  const stale = await prisma.order.findMany({
    where: {
      riderId: { not: null },
      riderAcceptedAt: null,
      riderAssignedAt: { lt: new Date(now.getTime() - OFFER_TIMEOUT_MS) },
      deliveredAt: null,
      deletedAt: null,
      status: { in: [...RIDER_ACTIVE_STATUSES] },
    },
    select: { id: true, riderId: true },
    take: 100,
  })
  if (stale.length === 0) return []
  // The latest offer on each order — only the worker's own may time out.
  const offers = await prisma.riderJobEvent.findMany({
    where: { orderId: { in: stale.map((o) => o.id) }, type: 'offered' },
    orderBy: { createdAt: 'desc' },
    select: { orderId: true, riderId: true, note: true },
  })
  const latest = new Map<string, { riderId: string; note: string | null }>()
  for (const e of offers) if (!latest.has(e.orderId)) latest.set(e.orderId, e)

  const freed: string[] = []
  for (const o of stale) {
    const offer = latest.get(o.id)
    if (!offer || offer.riderId !== o.riderId || offer.note !== AUTO_OFFER_NOTE) continue
    try {
      // Guarded on "still theirs and still not accepted": a rider who accepts
      // between the read above and this write keeps the job.
      const withdrawn = await withdrawOffer(o.id, o.riderId!, {
        event: 'timed_out',
        note: 'offer not accepted within 3 minutes',
      })
      if (withdrawn) freed.push(o.id)
    } catch (err) {
      console.warn(`[riderDispatch] could not time out offer on ${o.id.slice(0, 8)}: ${(err as Error).message}`)
    }
  }
  return freed
}

export async function runDispatchSweep(now = new Date()): Promise<void> {
  await expireStaleOffers(now)

  // The window runs on the order's EFFECTIVE time — greatest(placedAt,
  // scheduledFor) — and a pre-order is offered only once its prep window has
  // opened (O-RV-3). Keyed on placedAt alone, a delivery pre-order the kitchen
  // confirmed today for tomorrow was offered to a rider straight away, and one
  // placed more than 6 h ahead was never offered when it was cooked.
  const windowStart = new Date(now.getTime() - DISPATCH_WINDOW_MS)
  const horizon = new Date(now.getTime() + PRE_ORDER_PREP_MS)
  const found = await prisma.order.findMany({
    where: {
      fulfilmentType: 'delivery',
      riderId: null,
      deletedAt: null,
      deliveredAt: null,
      status: { in: [...DISPATCHABLE] },
      AND: [
        { OR: [{ placedAt: { gte: windowStart } }, { scheduledFor: { gte: windowStart } }] },
        { OR: [{ scheduledFor: null }, { scheduledFor: { lte: horizon } }] },
      ],
      concept: { tenantId: { not: null } },
    },
    orderBy: { placedAt: 'asc' },
    take: SWEEP_BATCH,
    select: {
      id: true,
      placedAt: true,
      scheduledFor: true,
      concept: { select: { latitude: true, longitude: true, tenantId: true } },
      location: { select: { latitude: true, longitude: true } },
    },
  })
  if (found.length === 0) return
  // Oldest effective time first.
  const effective = (o: { placedAt: Date; scheduledFor: Date | null }) =>
    Math.max(o.placedAt.getTime(), o.scheduledFor?.getTime() ?? 0)
  const orders = [...found].sort((a, b) => effective(a) - effective(b))

  // Which companies' riders may carry each order's company's orders.
  const orderCompanies = [...new Set(orders.map((o) => o.concept.tenantId!))]
  const fleets = await fleetCompaniesFor(orderCompanies)
  const riderCompanies = [...new Set([...fleets.values()].flat())]

  // Load every available rider once per sweep — cheaper than per-order
  // queries when there are many unassigned orders in a burst.
  const available = await prisma.rider.findMany({
    where: { status: 'available', isActive: true, deletedAt: null, tenantId: { in: riderCompanies } },
    select: { id: true, name: true, tenantId: true, lastLat: true, lastLng: true },
  })
  if (available.length === 0) {
    console.log(`[riderDispatch] ${orders.length} order(s) awaiting dispatch but no riders available`)
    return
  }

  // Who declined (never again) or let an offer time out (only as a last
  // resort) on each of these orders.
  const history = await prisma.riderJobEvent.findMany({
    where: { orderId: { in: orders.map((o) => o.id) }, type: { in: ['declined', 'timed_out'] } },
    select: { orderId: true, riderId: true, type: true },
  })
  const declined = new Set(history.filter((h) => h.type === 'declined').map((h) => `${h.orderId}:${h.riderId}`))
  const timedOut = new Set(history.filter((h) => h.type === 'timed_out').map((h) => `${h.orderId}:${h.riderId}`))

  // One offer per rider per sweep.
  const taken = new Set<string>()

  for (const order of orders) {
    const allowed = new Set(fleets.get(order.concept.tenantId!) ?? [])
    const eligible = available.filter(
      (r) => !taken.has(r.id) && r.tenantId != null && allowed.has(r.tenantId) && !declined.has(`${order.id}:${r.id}`),
    )
    const fresh = eligible.filter((r) => !timedOut.has(`${order.id}:${r.id}`))
    const candidates = fresh.length > 0 ? fresh : eligible
    if (candidates.length === 0) {
      console.log(`[riderDispatch] no available rider for order ${order.id.slice(0, 8)} — will retry next tick`)
      continue
    }

    // Nearest to the kitchen (the order's location, else its brand's pin).
    // Riders without a fix go last; with no kitchen pin, first come first served.
    const lat = order.location?.latitude ?? order.concept.latitude
    const lng = order.location?.longitude ?? order.concept.longitude
    let chosen = candidates[0]!
    if (lat != null && lng != null) {
      let best = Infinity
      for (const r of candidates) {
        if (r.lastLat == null || r.lastLng == null) continue
        const d = haversineKm(lat, lng, r.lastLat, r.lastLng)
        if (d < best) { best = d; chosen = r }
      }
    }

    taken.add(chosen.id)
    try {
      await assignRider(order.id, chosen.id, { note: AUTO_OFFER_NOTE, expectRiderId: null, requireAvailable: true })
      console.log(`[riderDispatch] offered order ${order.id.slice(0, 8)} to rider ${chosen.name}`)
    } catch (err) {
      console.warn(`[riderDispatch] could not offer order ${order.id.slice(0, 8)}: ${(err as Error).message}`)
    }
  }
}
