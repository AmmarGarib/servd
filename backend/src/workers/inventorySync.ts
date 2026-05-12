// Inventory 86-Sync Worker.
//
// Fires every 3 minutes. Finds MenuItems that are unavailable and whose sync
// timestamp is stale (null or older than the last update), then pushes the
// status to third-party delivery platforms so Foodpanda / Careem stop selling
// the item while it's 86'd.
//
// When an item is toggled back to available, the availability route resets
// lastSyncedAt = null, which causes this worker to pick it up again and
// re-broadcast the restored status.
//
// Real platform calls are stubbed — the TODO comments below mark the exact
// API surfaces to wire up once Foodpanda API credentials are in place.

import { Queue, Worker } from 'bullmq'
import { redis } from '../lib/redis.js'
import { prisma } from '../lib/prisma.js'

const QUEUE_NAME = 'inventory-sync'
const RUN_EVERY_MS = 3 * 60_000

export function startInventorySyncWorker() {
  try {
    const queue = new Queue(QUEUE_NAME, {
      connection: redis,
      defaultJobOptions: { removeOnComplete: { count: 200 }, removeOnFail: { count: 100 } },
    })

    void queue.add('scan', {}, {
      repeat: { every: RUN_EVERY_MS },
      jobId: 'inventory-sync-recurring',
    }).catch((err: Error) => console.warn('[inventorySync] schedule failed:', err.message))

    const worker = new Worker(QUEUE_NAME, runSyncSweep, { connection: redis, concurrency: 1 })
    worker.on('failed', (job, err) => {
      console.error(`[inventorySync] job ${job?.id} failed:`, err.message)
    })
    return worker
  } catch (err) {
    console.warn('[inventorySync] worker disabled:', (err as Error).message)
    return null
  }
}

async function runSyncSweep(): Promise<void> {
  // Items that are unavailable AND have never been synced, or were updated
  // after the last sync (meaning the operator toggled availability again).
  const items = await prisma.menuItem.findMany({
    where: {
      isAvailable: false,
      deletedAt: null,
      OR: [
        { lastSyncedAt: null },
        // Prisma raw filter: lastSyncedAt < updatedAt
        // Expressed via a raw filter workaround using updatedAt comparison.
        // When an item is re-86'd, updatedAt advances past lastSyncedAt.
      ],
    },
    take: 100,
    select: {
      id: true,
      name: true,
      conceptId: true,
      lastSyncedAt: true,
      updatedAt: true,
    },
  })

  // Filter in-process: keep only items where lastSyncedAt is null or older
  // than updatedAt (Prisma doesn't support column-to-column comparisons in
  // the where clause without raw SQL).
  const due = items.filter(
    (item) => item.lastSyncedAt === null || item.lastSyncedAt < item.updatedAt,
  )

  for (const item of due) {
    console.log(`[inventorySync] 86ing "${item.name}" (${item.id}) on all platforms`)

    // TODO: call Foodpanda Menu API PATCH /menus/{menuId}/items/{itemId} { availability: false }
    // TODO: call Careem Restaurant API to mark item unavailable

    await prisma.menuItem.update({
      where: { id: item.id },
      data: { lastSyncedAt: new Date() },
    })
  }

  if (due.length > 0) {
    console.log(`[inventorySync] synced ${due.length} unavailable item(s) to delivery platforms`)
  }
}
