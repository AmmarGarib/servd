// Cart reservation system — atomic Redis holds + BullMQ TTL release
// Tracks per-item availability when portionsAvailable is set on a MenuItem.
// null portionsAvailable = unlimited (no tracking needed).

import { Queue, Worker } from 'bullmq'
import { redis, redisFast } from './redis.js'
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
  try { await redisFast.set(`${AVAIL_PREFIX}${menuItemId}`, portions) }
  catch (err) { console.warn('[reservation] seedAvailability skipped:', (err as Error).message) }
}

/** Current available count. null = unlimited. */
export async function getAvailability(menuItemId: string, portionsAvailable: number | null): Promise<number | null> {
  if (portionsAvailable === null) return null
  try {
    const val = await redisFast.get(`${AVAIL_PREFIX}${menuItemId}`)
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
    redisValues = (await redisFast.mget(...keys)) as (string | null)[]
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

// ── Par stock today (owner, 2026-11-13) ──────────────────────────────────────
//
// The SAME `avail:{menuItemId}` counter the cart uses: expo sets "what is left
// now" (seedAvailability) and every sale counts it down through takePortions,
// cancel / void gives back through givePortions. A service counter only — it
// never touches stock, FIFO lots or the ledger. null portionsAvailable =
// unlimited (no-op). Redis down = fail open (logged, allowed), like the cart.
// Request paths, so the fail-fast client (redisFast) — the shared one hangs while
// Redis is down. lib/parStock.ts is the caller that adds the sold-out / back-on switching.

export interface PortionLine { menuItemId: string; qty: number; portionsAvailable: number | null }

// KEYS[i] = avail:{id}; ARGV[i] = qty; ARGV[n+i] = the seed when the key is
// missing (portionsAvailable — what getBatchAvailability reports then).
// All-or-nothing: returns {1, left_1..left_n} after taking, or {0, have_1..have_n}.
const luaTakeMany = `
local n = #KEYS
local have = {}
for i = 1, n do
  local cur = redis.call('GET', KEYS[i])
  if cur == false then
    redis.call('SET', KEYS[i], ARGV[n + i])
    cur = ARGV[n + i]
  end
  have[i] = tonumber(cur)
end
for i = 1, n do
  if have[i] < tonumber(ARGV[i]) then
    local out = {0}
    for j = 1, n do out[j + 1] = have[j] end
    return out
  end
end
local out = {1}
for i = 1, n do out[i + 1] = redis.call('INCRBY', KEYS[i], -tonumber(ARGV[i])) end
return out
`

/** Merge lines of the same dish and drop unlimited / empty ones. */
function limitedLines(items: PortionLine[]): PortionLine[] {
  const by = new Map<string, PortionLine>()
  for (const i of items) {
    if (i.portionsAvailable === null || !(i.qty > 0)) continue
    const prev = by.get(i.menuItemId)
    by.set(i.menuItemId, { menuItemId: i.menuItemId, qty: (prev?.qty ?? 0) + i.qty, portionsAvailable: i.portionsAvailable })
  }
  return [...by.values()]
}

/**
 * Take portions for a whole ticket, all or nothing. `left` = what each
 * limited dish has left after the take (so the caller can sell out at 0).
 */
export async function takePortions(items: PortionLine[]): Promise<
  | { ok: true; left: Array<{ menuItemId: string; left: number }> }
  | { ok: false; short: Array<{ menuItemId: string; available: number }> }
> {
  const lines = limitedLines(items)
  if (lines.length === 0) return { ok: true, left: [] }
  let res: number[]
  try {
    res = await redisFast.eval(
      luaTakeMany, lines.length,
      ...lines.map((l) => `${AVAIL_PREFIX}${l.menuItemId}`),
      ...lines.map((l) => String(l.qty)),
      ...lines.map((l) => String(l.portionsAvailable)),
    ) as number[]
  } catch (err) {
    console.warn('[reservation] Redis error in takePortions, allowing the sale:', (err as Error).message)
    return { ok: true, left: [] }
  }
  if (Number(res[0]) !== 1) {
    const short = lines
      .map((l, i) => ({ menuItemId: l.menuItemId, available: Math.max(0, Number(res[i + 1])), qty: l.qty }))
      .filter((s) => s.available < s.qty)
      .map(({ menuItemId, available }) => ({ menuItemId, available }))
    return { ok: false, short }
  }
  const left = lines.map((l, i) => ({ menuItemId: l.menuItemId, left: Math.max(0, Number(res[i + 1])) }))
  for (const l of left) void emitAvailabilityChange(l.menuItemId, l.left)
  return { ok: true, left }
}

/** Give portions back (cancel / void / a refused order write). Returns what each dish has left after. */
export async function givePortions(items: PortionLine[]): Promise<Array<{ menuItemId: string; left: number }>> {
  const out: Array<{ menuItemId: string; left: number }> = []
  for (const l of limitedLines(items)) {
    try {
      const key = `${AVAIL_PREFIX}${l.menuItemId}`
      // A missing key already reads as the full set count — nothing to give back to.
      if (!(await redisFast.exists(key))) continue
      const left = Math.max(0, Number(await redisFast.incrby(key, l.qty)))
      out.push({ menuItemId: l.menuItemId, left })
      void emitAvailabilityChange(l.menuItemId, left)
    } catch (err) {
      console.warn('[reservation] Redis error in givePortions:', (err as Error).message)
    }
  }
  return out
}
