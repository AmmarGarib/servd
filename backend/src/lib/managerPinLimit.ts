// Manager-override PIN attempt limiter (FOH-R2-01).
//
// Every void, cancel, refund, comp, over-cap discount, price override, till
// pay-out, staff meal and petty-cash top-up a cashier or server does rests on
// a manager's PIN (§17.4: "a cashier or server can never void alone"). The PIN
// is 4 to 8 digits and a guess matches ANY approver of the company, so without
// a limit a cashier token can grind the PIN space from the till in under an
// hour. This is the limit.
//
// Two buckets, both taken BEFORE the PIN is compared (the `claim` pattern in
// loginRateLimit.ts — check-then-record lets N parallel guesses all pass the
// read, which is exactly the burst the sim used):
//
//   actor  — the signed-in person sending the PIN. 5 attempts per 15 minutes.
//            A correct PIN gives back ITS OWN slot only; the wrong guesses
//            around it keep counting for the whole window (T-RV-01). Clearing
//            the bucket on success let anyone who knows one valid approver PIN
//            (their own, or one shoulder-surfed) reset their count after every
//            4 guesses and grind the other approvers' PINs — the CEO's
//            included — without limit or flag. An honest cashier who
//            mistypes twice and then gets it right keeps 3 spare attempts.
//            (Same rule as the PIN-change route in auth/routes.ts: release,
//            not clear.)
//   order  — the order the override is for, whoever sends it, so several
//            cashiers cannot pool their budgets on one ticket. 5 per 15
//            minutes; a correct PIN gives its own slot back.
//
// A request over either bucket is refused with 429 MANAGER_PIN_LOCKED before
// any comparison is made — a locked attempt learns nothing, not even whether
// the PIN was right. A request refused because the ORDER is locked made no
// comparison, so the sender's actor slot is given back (T-RV-02): otherwise an
// honest cashier retrying the right PIN on someone else's locked ticket would
// lock themselves out of every order.
//
// Redis (the `redisFast` connection, so a dead Redis rejects promptly instead
// of hanging) is the shared counter; when it is unreachable the limiter keeps
// counting in process memory, as the login limiter does. Never fail open.

import { redisFast as redis } from './redis.js'
import { AppError } from './errors.js'

export interface PinLimit {
  scope: string
  max: number
  lockoutSec: number
}

export const MANAGER_PIN_ACTOR_LIMIT: PinLimit = { scope: 'manager-pin-actor', max: 5, lockoutSec: 15 * 60 }
export const MANAGER_PIN_ORDER_LIMIT: PinLimit = { scope: 'manager-pin-order', max: 5, lockoutSec: 15 * 60 }

const REDIS_TIMEOUT_MS = 750

function withTimeout<T>(op: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`redis ${label} exceeded ${REDIS_TIMEOUT_MS}ms`)), REDIS_TIMEOUT_MS)
    op.then((v) => { clearTimeout(timer); resolve(v) }, (e) => { clearTimeout(timer); reject(e) })
  })
}

const key = (limit: PinLimit, id: string) => `ratelimit:${limit.scope}:${id}`

// ─── In-memory fallback (per process; bounded) ───────────────────────────────

interface MemoryEntry { count: number; expiresAt: number }
const MAX_MEMORY_KEYS = 20_000
const memory = new Map<string, MemoryEntry>()

function memoryGet(k: string, now: number): MemoryEntry | null {
  const e = memory.get(k)
  if (!e) return null
  if (e.expiresAt <= now) { memory.delete(k); return null }
  return e
}

function memoryIncrement(k: string, lockoutSec: number, now: number): MemoryEntry {
  const e = memoryGet(k, now)
  if (e) { e.count += 1; return e }
  if (memory.size >= MAX_MEMORY_KEYS) {
    for (const [mk, me] of memory) if (me.expiresAt <= now) memory.delete(mk)
    if (memory.size >= MAX_MEMORY_KEYS) {
      const byExpiry = [...memory.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)
      for (const [mk] of byExpiry.slice(0, memory.size - MAX_MEMORY_KEYS + 1)) memory.delete(mk)
    }
  }
  const fresh = { count: 1, expiresAt: now + lockoutSec * 1000 }
  memory.set(k, fresh)
  return fresh
}

let degraded = false
let lastLogAt = 0
function noteRedisFailure(err: unknown): void {
  const now = Date.now()
  if (!degraded || now - lastLogAt > 60_000) {
    degraded = true
    lastLogAt = now
    console.error('[managerPinLimit] Redis unavailable — manager-PIN attempts are counted per process in memory. Reason:',
      err instanceof Error ? err.message : err)
  }
}
function noteRedisRecovered(): void {
  if (degraded) { degraded = false; console.warn('[managerPinLimit] Redis reachable again — manager-PIN limits are shared again.') }
}

// INCR, start the window on the first hit, re-arm a key that lost its TTL.
const CLAIM_SCRIPT = `
local c = redis.call('INCR', KEYS[1])
if c == 1 or redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return {c, redis.call('TTL', KEYS[1])}`

/**
 * Take one attempt from a bucket. Returns the count after this attempt and the
 * seconds left in the window.
 *
 * Every attempt is ALSO counted in this process's memory, and the higher of
 * the two counts wins. Redis is the shared count (several instances, restarts);
 * memory is the floor that cannot be lost: a Redis call that times out (a
 * burst of PIN checks keeps the event loop busy with bcrypt) used to land the
 * attempt in a separate local counter, so a burst split across the two got
 * twice the budget.
 */
async function claimOne(limit: PinLimit, id: string): Promise<{ count: number; ttlSec: number }> {
  const k = key(limit, id)
  const now = Date.now()
  const local = memoryIncrement(k, limit.lockoutSec, now)
  const localTtl = Math.max(1, Math.ceil((local.expiresAt - now) / 1000))
  try {
    const [count, ttl] = (await withTimeout(redis.eval(CLAIM_SCRIPT, 1, k, String(limit.lockoutSec)) as Promise<[number, number]>, 'claim'))
    noteRedisRecovered()
    const shared = Number(count)
    return shared >= local.count
      ? { count: shared, ttlSec: Number(ttl) > 0 ? Number(ttl) : limit.lockoutSec }
      : { count: local.count, ttlSec: localTtl }
  } catch (err) {
    noteRedisFailure(err)
    return { count: local.count, ttlSec: localTtl }
  }
}

async function releaseOne(limit: PinLimit, id: string): Promise<void> {
  const k = key(limit, id)
  const e = memoryGet(k, Date.now())
  if (e && e.count > 0) e.count -= 1
  try {
    const v = await withTimeout(redis.decr(k), 'decr')
    noteRedisRecovered()
    if (v <= 0) await withTimeout(redis.del(k), 'del')
  } catch (err) {
    noteRedisFailure(err)
  }
}

async function clearOne(limit: PinLimit, id: string): Promise<void> {
  const k = key(limit, id)
  memory.delete(k)
  try {
    await withTimeout(redis.del(k), 'del')
    noteRedisRecovered()
  } catch (err) {
    noteRedisFailure(err)
  }
}

/** Who and what a PIN attempt is counted against. */
export interface PinAttemptKeys {
  /** The signed-in person sending the PIN (or, with no actor, the company — see managerPin.ts). */
  actor: string
  /** The order the override is for, when there is one. */
  orderId?: string | null
}

export interface PinAttemptClaim {
  actorCount: number
  orderCount: number | null
}

export function managerPinLocked(retryAfterSec: number): AppError {
  const mins = Math.max(1, Math.ceil(retryAfterSec / 60))
  return new AppError(
    'MANAGER_PIN_LOCKED',
    `Too many wrong manager PINs. Manager PIN approvals are locked for ${mins} minute${mins !== 1 ? 's' : ''} — a manager can sign in and do it themselves.`,
    429,
    { retryAfterSec },
  )
}

/**
 * Take one attempt from the actor's (and the order's) bucket before the PIN is
 * compared. Throws 429 MANAGER_PIN_LOCKED when either is already full.
 */
export async function claimPinAttempt(keys: PinAttemptKeys): Promise<PinAttemptClaim> {
  const a = await claimOne(MANAGER_PIN_ACTOR_LIMIT, keys.actor)
  if (a.count > MANAGER_PIN_ACTOR_LIMIT.max) throw managerPinLocked(a.ttlSec)
  if (!keys.orderId) return { actorCount: a.count, orderCount: null }
  const o = await claimOne(MANAGER_PIN_ORDER_LIMIT, keys.orderId)
  if (o.count > MANAGER_PIN_ORDER_LIMIT.max) {
    // T-RV-02: no comparison is made on a locked order, so the sender is not
    // charged for it — give the actor's slot back before refusing.
    await releaseOne(MANAGER_PIN_ACTOR_LIMIT, keys.actor)
    throw managerPinLocked(o.ttlSec)
  }
  return { actorCount: a.count, orderCount: o.count }
}

/**
 * A correct PIN gives back the slot THIS attempt took, on the actor and on the
 * order. It never clears either bucket: the wrong guesses before (and after)
 * it still count for the rest of the window (T-RV-01).
 */
export async function pinAttemptSucceeded(keys: PinAttemptKeys): Promise<void> {
  await releaseOne(MANAGER_PIN_ACTOR_LIMIT, keys.actor)
  if (keys.orderId) await releaseOne(MANAGER_PIN_ORDER_LIMIT, keys.orderId)
}

/** Tests only: forget a bucket. */
export async function resetPinAttempts(keys: PinAttemptKeys): Promise<void> {
  await clearOne(MANAGER_PIN_ACTOR_LIMIT, keys.actor)
  if (keys.orderId) await clearOne(MANAGER_PIN_ORDER_LIMIT, keys.orderId)
}

/** For /health: the limiter is counting in memory. */
export function isManagerPinLimitDegraded(): boolean {
  return degraded
}
