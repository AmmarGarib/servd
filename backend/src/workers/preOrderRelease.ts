// Pre-order release worker (O-RV-3).
//
// Every minute, for each company in turn, releases the pre-orders whose prep
// window has opened (scheduledFor − PRE_ORDER_PREP_MS): order:new reaches the
// company's KDS / expo rooms and the order's stock is taken. Until then
// ingestOrder held both back (orders/service.ts, "Pre-orders").
//
// Idempotent and safe on several processes: each order is claimed under its
// row lock by a PRE_ORDER_RELEASE audit row (releasePreOrder), so a second
// tick — or a second box — finds it released and does nothing. A plain
// interval, like the course-pacing worker: no Redis needed.

import { serviceClient as prisma } from '../lib/prisma.js'
import { releaseDuePreOrders } from '../modules/orders/service.js'

const TICK_INTERVAL_MS = 60_000

let timer: NodeJS.Timeout | null = null
let running = false

/** One pass over every company. Returns how many pre-orders were released. */
export async function runPreOrderReleaseTick(now: Date = new Date()): Promise<number> {
  const companies = await prisma.tenant.findMany({ where: { deletedAt: null, kind: 'company' }, select: { id: true } })
  let released = 0
  for (const c of companies) {
    try {
      released += (await releaseDuePreOrders(c.id, now)).length
    } catch (err) {
      console.error(`[pre-order] release failed for company ${c.id}:`, (err as Error).message)
    }
  }
  return released
}

export function startPreOrderReleaseWorker() {
  if (timer) return
  console.log('[pre-order] release worker started — ticking every 60s')
  timer = setInterval(() => {
    if (running) return
    running = true
    runPreOrderReleaseTick()
      .then((n) => { if (n > 0) console.log(`[pre-order] released ${n} pre-order(s) to the kitchen`) })
      .catch((err) => console.error('[pre-order] tick failed:', (err as Error).message))
      .finally(() => { running = false })
  }, TICK_INTERVAL_MS)
}

export function stopPreOrderReleaseWorker() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
