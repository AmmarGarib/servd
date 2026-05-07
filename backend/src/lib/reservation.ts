// Cart reservation system — atomic Redis holds + BullMQ TTL release
// Tracks per-item availability when portionsAvailable is set on a MenuItem.
// null portionsAvailable = unlimited (no tracking needed).

import { Queue, Worker } from 'bullmq'
import { redis } from './redis.js'
import { emitAvailabilityChange } from './ws.js'

const HOLD_TTL_MS  = 20 * 60 * 1000   // 20 min hold window
const AVAIL_PREFIX = 'avail:'
const releaseQueue = new Queue<ReleaseJob>('cart-releases', {
  connection: redis,
  defaultJobOptions: { removeOnComplete: true, removeOnFail: false },
})

interface ReleaseJob { cartId: string; menuItemId: string; qty: number }

// Lua: atomic check-and-decrement. Returns 1 = ok, 0 = insufficient stock.
// KEYS[1] = avail:{menuItemId}   ARGV[1] = delta (positive = reserve)
const luaReserve = `
local key = KEYS[1]
local delta = tonumber(ARGV[1])
local current = redis.call('GET', key)
if current == false then return 1 end
local avail = tonumber(current)
if delta > 0 and avail < delta then return 0 end
redis.call('INCRBY', key, -delta)
return 1
`

// ── Public API ────────────────────────────────────────────────────────────────

/** Seed Redis when admin sets portionsAvailable. Must be called on every update. */
export async function seedAvailability(menuItemId: string, portions: number): Promise<void> {
  try { await redis.set(`${AVAIL_PREFIX}${menuItemId}`, portions) }
  catch (err) { console.warn('[reservation] seedAvailability skipped:', (err as Error).message) }
}

/** Current available count. null = unlimited. */
export async function getAvailability(menuItemId: string, portionsAvailable: number | null): Promise<number | null> {
  if (portionsAvailable === null) return null
  try {
    const val = await redis.get(`${AVAIL_PREFIX}${menuItemId}`)
    return val === null ? portionsAvailable : Math.max(0, parseInt(val, 10))
  } catch {
    return portionsAvailable // Redis down — report full availability
  }
}

/**
 * Batch availability lookup using Redis MGET — one round-trip instead of N.
 * Returns a map of menuItemId → available count (null = unlimited).
 */
export async function getBatchAvailability(
  items: Array<{ id: string; portionsAvailable: number | null }>,
): Promise<Map<string, number | null>> {
  const limited = items.filter((i) => i.portionsAvailable !== null)
  const result = new Map<string, number | null>()

  if (limited.length === 0) {
    for (const item of items) result.set(item.id, null)
    return result
  }

  let redisValues: (string | null)[] = limited.map(() => null)
  try {
    const keys = limited.map((i) => `${AVAIL_PREFIX}${i.id}`)
    redisValues = (await redis.mget(...keys)) as (string | null)[]
  } catch {
    // Redis down — fall back to portionsAvailable values
  }

  const limitedByIndex = new Map(limited.map((item, idx) => [item.id, { item, idx }]))
  for (const item of items) {
    if (item.portionsAvailable === null) {
      result.set(item.id, null)
    } else {
      const entry = limitedByIndex.get(item.id)!
      const val = redisValues[entry.idx]
      result.set(item.id, val == null ? item.portionsAvailable : Math.max(0, parseInt(val, 10)))
    }
  }
  return result
}

/**
 * Reserve qty for a cart item.
 * prevQty = what this cartId already holds for this item (0 if new).
 * Returns { ok: true } or { ok: false, available: N }.
 */
export async function reserveItem(
  cartId: string,
  menuItemId: string,
  qty: number,
  prevQty: number,
  portionsAvailable: number | null,
): Promise<{ ok: boolean; available?: number }> {
  const delta = qty - prevQty
  if (delta === 0) return { ok: true }

  if (portionsAvailable !== null) {
    try {
      const result = await redis.eval(luaReserve, 1, `${AVAIL_PREFIX}${menuItemId}`, String(delta)) as number
      if (result === 0) {
        const raw = await redis.get(`${AVAIL_PREFIX}${menuItemId}`)
        const available = raw ? Math.max(0, parseInt(raw, 10)) : 0
        return { ok: false, available }
      }
      // Broadcast updated availability to all open menus
      const raw = await redis.get(`${AVAIL_PREFIX}${menuItemId}`)
      const newAvail = raw ? Math.max(0, parseInt(raw, 10)) : 0
      emitAvailabilityChange(menuItemId, newAvail)
    } catch (err) {
      // Redis unavailable — allow the reservation (no stock tracking)
      console.warn('[reservation] Redis error in reserveItem, skipping hold:', (err as Error).message)
    }
  }

  // Schedule / refresh auto-release job
  if (qty > 0) {
    await scheduleRelease(cartId, menuItemId, qty, portionsAvailable)
  } else {
    await cancelRelease(cartId, menuItemId)
  }
  return { ok: true }
}

/**
 * Release all holds for a cart (called when order is placed — holds become
 * permanent consumption so we just cancel the auto-release jobs).
 * Pass release=true to actually restore availability (on cart clear/abandon).
 */
export async function settleCart(
  cartId: string,
  items: Array<{ menuItemId: string; quantity: number; portionsAvailable: number | null }>,
  restore: boolean,
): Promise<void> {
  for (const item of items) {
    try { await cancelRelease(cartId, item.menuItemId) } catch { /* Redis down — job already gone */ }
    if (restore && item.portionsAvailable !== null && item.quantity > 0) {
      try {
        await redis.incrby(`${AVAIL_PREFIX}${item.menuItemId}`, item.quantity)
        const raw = await redis.get(`${AVAIL_PREFIX}${item.menuItemId}`)
        emitAvailabilityChange(item.menuItemId, raw ? Math.max(0, parseInt(raw, 10)) : 0)
      } catch (err) {
        console.warn('[reservation] Redis error in settleCart:', (err as Error).message)
      }
    }
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function scheduleRelease(
  cartId: string,
  menuItemId: string,
  qty: number,
  portionsAvailable: number | null,
): Promise<void> {
  // Only track jobs for limited items (unlimited items don't need release)
  if (portionsAvailable === null) return
  const jobId = `release-${cartId}-${menuItemId}`
  const existing = await releaseQueue.getJob(jobId)
  if (existing) await existing.remove()
  await releaseQueue.add('release', { cartId, menuItemId, qty }, { jobId, delay: HOLD_TTL_MS })
}

async function cancelRelease(cartId: string, menuItemId: string): Promise<void> {
  const job = await releaseQueue.getJob(`release-${cartId}-${menuItemId}`)
  if (job) await job.remove()
}

// ── Worker (registered in index.ts) ───────────────────────────────────────────

export function startCartReleaseWorker() {
  try {
    const worker = new Worker<ReleaseJob>(
      'cart-releases',
      async (job) => {
        const { menuItemId, qty } = job.data
        const exists = await redis.exists(`${AVAIL_PREFIX}${menuItemId}`)
        if (exists) {
          await redis.incrby(`${AVAIL_PREFIX}${menuItemId}`, qty)
          const raw = await redis.get(`${AVAIL_PREFIX}${menuItemId}`)
          const newAvail = raw ? Math.max(0, parseInt(raw, 10)) : 0
          emitAvailabilityChange(menuItemId, newAvail)
          console.info(`[reservation] cart hold expired — restored ${qty}x ${menuItemId}, avail=${newAvail}`)
        }
      },
      { connection: redis },
    )
    worker.on('failed', (job, err) => console.error('[reservation] release job failed', job?.id, err))
    worker.on('error',  (err)      => console.error('[reservation] worker error:', err.message))
    return worker
  } catch (err) {
    console.warn('[reservation] cart release worker disabled (Redis unavailable):', (err as Error).message)
    return null
  }
}
