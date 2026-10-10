// Login rate limiter.
//
// Redis-backed in the normal case: the counter survives an API restart and is
// shared across every instance, so an attacker can't reset their budget by
// reconnecting or by landing on a different container.
//
// It used to FAIL OPEN. If Redis was unreachable, `check` swallowed the error
// and returned "allowed", and `recordFailure` quietly dropped the increment.
// That turned a Redis outage into an open door: unlimited PIN guesses against
// a 4-digit space (10,000 combinations — minutes of brute force), unlimited
// password attempts, unlimited magic-link verification. And the outage is the
// easy part — Redis and the API run on the same box, so whatever knocks one
// over tends to take the other's dependency with it.
//
// Now there is a per-process in-memory fallback. When Redis is unavailable the
// limiter keeps counting locally instead of giving up. The tradeoffs, stated
// plainly:
//
//   - It is per process. With N API instances an attacker gets up to N times
//     the attempts. N is small here (one box), and N x 3 PIN attempts is still
//     a limit; unlimited is not.
//   - It does not survive a restart. An attacker who can crash-loop the API can
//     reset their budget — but if they can do that, the API is not serving
//     logins anyway.
//   - It is bounded (MAX_MEMORY_KEYS) so a flood of distinct IPs can't grow it
//     without limit. When full, entries closest to expiry are dropped first.
//
// None of that is as good as Redis. All of it is better than no limit at all,
// which is what "fail open" meant.

import { redisFast as redis } from './redis.js'
import { AppError } from './errors.js'

// Hard ceiling on how long a login waits for Redis. `redisFast` rejects
// promptly when the socket is down, but a Redis that is connected and wedged
// (swapping, blocked on a slow command) would still stall the request. A login
// check has no business taking longer than this; past it we treat Redis as
// unavailable and use the local counter.
const REDIS_TIMEOUT_MS = 750

function withTimeout<T>(op: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`redis ${label} exceeded ${REDIS_TIMEOUT_MS}ms`)),
      REDIS_TIMEOUT_MS,
    )
    op.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

interface Limit {
  /** Bucket name (e.g. "pin", "staff-login", "customer-login") */
  scope: string
  /** Max failed attempts before lockout */
  max: number
  /** Lockout duration in seconds */
  lockoutSec: number
}

function key(scope: string, ip: string) {
  return `ratelimit:${scope}:${ip}`
}

// ─── In-memory fallback ──────────────────────────────────────────────────────

interface MemoryEntry {
  count: number
  /** epoch ms at which this entry stops counting */
  expiresAt: number
}

// Roughly 50k entries at a few dozen bytes each — single-digit megabytes, well
// under any sane container limit, and far more distinct IPs than this system
// sees in a lockout window.
const MAX_MEMORY_KEYS = 50_000

const memory = new Map<string, MemoryEntry>()

/** Drop expired entries, then trim to the cap by evicting the soonest to expire. */
function pruneMemory(now: number): void {
  for (const [k, e] of memory) {
    if (e.expiresAt <= now) memory.delete(k)
  }
  if (memory.size <= MAX_MEMORY_KEYS) return
  // Over the cap even after pruning — an unusual flood of distinct keys. Evict
  // the entries with the least life left: they are the ones whose protection
  // was about to lapse anyway.
  const byExpiry = [...memory.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)
  for (const [k] of byExpiry.slice(0, memory.size - MAX_MEMORY_KEYS)) memory.delete(k)
}

function memoryGet(k: string, now: number): MemoryEntry | null {
  const e = memory.get(k)
  if (!e) return null
  if (e.expiresAt <= now) {
    memory.delete(k)
    return null
  }
  return e
}

function memoryIncrement(k: string, lockoutSec: number, now: number): void {
  const e = memoryGet(k, now)
  if (e) {
    e.count += 1
    return
  }
  pruneMemory(now)
  memory.set(k, { count: 1, expiresAt: now + lockoutSec * 1000 })
}

// ─── Degraded-mode reporting ─────────────────────────────────────────────────
//
// Redis being down is an operational event someone should see, but a failing
// Redis fails on EVERY login attempt, so logging per call would bury the box in
// identical lines. Log the transition in and out, and no more than one reminder
// a minute while it persists.

const DEGRADED_LOG_INTERVAL_MS = 60_000
let degraded = false
let lastDegradedLogAt = 0

function noteRedisFailure(err: unknown): void {
  const now = Date.now()
  if (!degraded || now - lastDegradedLogAt > DEGRADED_LOG_INTERVAL_MS) {
    degraded = true
    lastDegradedLogAt = now
    console.error(
      '[loginRateLimit] Redis unavailable — login rate limiting has fallen back to ' +
        'per-process in-memory counters. Limits still apply but are no longer shared ' +
        'across instances or preserved across restarts. Reason:',
      err instanceof Error ? err.message : err,
    )
  }
}

function noteRedisRecovered(): void {
  if (!degraded) return
  degraded = false
  console.warn('[loginRateLimit] Redis is reachable again — rate limiting is back on shared counters.')
  // The local entries are deliberately NOT cleared. Redis is authoritative once
  // it answers, so they stop being consulted anyway, and leaving them to expire
  // on their own means a flapping Redis doesn't hand an attacker a fresh budget
  // on every reconnect.
}

/** Exposed for /health so an operator can see the limiter is running degraded. */
export function isDegraded(): boolean {
  return degraded
}

// ─── Public API ──────────────────────────────────────────────────────────────

function rateLimited(limit: Limit, ttlSec: number | null): AppError {
  const mins = Math.max(1, Math.ceil((ttlSec && ttlSec > 0 ? ttlSec : limit.lockoutSec) / 60))
  return new AppError(
    'RATE_LIMITED',
    `Too many failed attempts. Try again in ${mins} minute${mins !== 1 ? 's' : ''}.`,
    429,
  )
}

export async function check(limit: Limit, ip: string): Promise<void> {
  const k = key(limit.scope, ip)
  const now = Date.now()

  let count: number | null = null
  let ttlSec: number | null = null

  try {
    const v = await withTimeout(redis.get(k), 'get')
    noteRedisRecovered()
    if (!v) return
    count = parseInt(v, 10)
    if (Number.isFinite(count) && count >= limit.max) {
      ttlSec = await withTimeout(redis.ttl(k), 'ttl')
    }
  } catch (err) {
    // Redis is down. Fall back to the local counter rather than waving the
    // request through.
    noteRedisFailure(err)
    const e = memoryGet(k, now)
    if (!e) return
    count = e.count
    ttlSec = Math.ceil((e.expiresAt - now) / 1000)
  }

  if (count === null || !Number.isFinite(count) || count < limit.max) return
  throw rateLimited(limit, ttlSec)
}

// INCR, and start the window on the first hit. Also re-arms a key that somehow
// lost its TTL, so a crash between INCR and EXPIRE can never leave a permanent
// lock-out behind.
const CLAIM_SCRIPT = `
local c = redis.call('INCR', KEYS[1])
if c == 1 or redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return c`

/**
 * Take one slot from the bucket BEFORE doing the guarded work, and throw 429
 * when the bucket is already full. Atomic, unlike `check` + `recordFailure`:
 * those read the counter first and add to it after the attempt, so N parallel
 * requests all pass the read and get N attempts — 25 parallel code guesses
 * used to sail past a limit of 6. Use this wherever the attempt itself is the
 * thing being limited (a code guess, a message sent); give the slot back with
 * `release` when the attempt turns out not to count.
 */
export async function claim(limit: Limit, ip: string): Promise<void> {
  const k = key(limit.scope, ip)
  const now = Date.now()
  let count: number
  let ttlSec: number | null = null
  try {
    count = Number(await withTimeout(
      redis.eval(CLAIM_SCRIPT, 1, k, String(limit.lockoutSec)) as Promise<number>,
      'claim',
    ))
    noteRedisRecovered()
  } catch (err) {
    noteRedisFailure(err)
    memoryIncrement(k, limit.lockoutSec, now)
    const e = memoryGet(k, now)
    count = e?.count ?? 1
    ttlSec = e ? Math.ceil((e.expiresAt - now) / 1000) : null
  }
  if (count <= limit.max) return
  if (ttlSec === null) {
    try { ttlSec = await withTimeout(redis.ttl(k), 'ttl') } catch { /* the message falls back to lockoutSec */ }
  }
  throw rateLimited(limit, ttlSec)
}

/** Give back a slot taken by `claim` — the attempt succeeded and should not count. */
export async function release(limit: Limit, ip: string): Promise<void> {
  const k = key(limit.scope, ip)
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

export async function recordFailure(limit: Limit, ip: string): Promise<void> {
  const k = key(limit.scope, ip)
  try {
    const count = await withTimeout(redis.incr(k), 'incr')
    noteRedisRecovered()
    if (count === 1) await withTimeout(redis.expire(k, limit.lockoutSec), 'expire')
  } catch (err) {
    // The failure still has to be counted somewhere, or the next `check` has
    // nothing to go on and the limit is meaningless.
    noteRedisFailure(err)
    memoryIncrement(k, limit.lockoutSec, Date.now())
  }
}

export async function clearFailures(limit: Limit, ip: string): Promise<void> {
  const k = key(limit.scope, ip)
  // Always clear the local counter: a successful sign-in should not leave a
  // stale in-memory strike behind once Redis comes back.
  memory.delete(k)
  try {
    await withTimeout(redis.del(k), 'del')
    noteRedisRecovered()
  } catch (err) {
    noteRedisFailure(err)
  }
}

// A restaurant is ONE public IP. Every tablet, till and KDS screen on site
// shares it, so a per-IP cap of 5 means five fumbled passwords anywhere in the
// building locks out the whole venue for 15 minutes — including the manager
// who would fix it. That was survivable while cooks typed PINs into a separate
// bucket; with email+password as the only way in, all of that traffic lands
// here.
//
// So the per-IP cap is loose enough to absorb a shift's honest mistakes, and
// the PER-ACCOUNT cap below is the one doing the real work: an attacker
// grinding one account hits 8 and stops, while a busy venue never trips 40.
// Rotating the source IP does not help them, because the account bucket is
// keyed on the email.
export const STAFF_PASSWORD_LIMIT:    Limit = { scope: 'staff-login',      max: 40, lockoutSec: 10 * 60 }
// Per-account companion to the above, keyed on the email rather than the IP.
// An IP limit alone is the easy half to evade — rotate the source and the
// budget resets — and password is now the ONLY way into the owner, management
// and finance accounts. Slightly more generous than the per-IP cap so a real
// person fumbling their password from a couple of devices isn't locked out
// before the IP limit would have stopped them.
export const STAFF_PASSWORD_USER_LIMIT: Limit = { scope: 'staff-login-user', max: 8, lockoutSec: 15 * 60 }
// Floor-staff code sign-in, capped PER PHONE rather than per IP. This endpoint
// makes us send a WhatsApp message to a caller-chosen number, so the number is
// the thing worth limiting: an IP limit is trivially sidestepped with a proxy,
// and it would also punish a whole restaurant behind one NAT. 6 is a couple of
// genuine retries plus a fat-fingered code, and no more.
export const STAFF_OTP_PHONE_LIMIT: Limit = { scope: 'staff-otp-phone', max: 6, lockoutSec: 15 * 60 }
// Rider-app sign-in (docs/rider-app.md). The same shape as the floor-staff code
// sign-in: the phone bucket counts EVERY code request for that number (known
// rider or not, so the 429 cannot tell the two apart) plus every wrong code;
// the IP bucket counts requests and wrong codes and is loose, because riders on
// mobile data sit behind carrier NAT and share addresses. Both are taken with
// `claim` (before the work), never check-then-record.
export const RIDER_OTP_PHONE_LIMIT: Limit = { scope: 'rider-otp-phone', max: 6, lockoutSec: 15 * 60 }
export const RIDER_OTP_IP_LIMIT:    Limit = { scope: 'rider-otp-ip',    max: 40, lockoutSec: 10 * 60 }
// Requests to /rider/* whose token is refused (bad, expired, revoked, or the
// rider deactivated), per IP. Only failures count, so riders sharing a carrier
// IP are not throttled by each other's ordinary traffic — an expired access
// token is about one failure per rider per 15 minutes. It bounds replaying a
// revoked or deactivated rider's token, which otherwise costs a Redis read (and
// database reads) per request with no limit at all: the per-route limiter
// keys on the rider and runs after the guard, so it never sees these.
export const RIDER_BAD_TOKEN_IP_LIMIT: Limit = { scope: 'rider-bad-token-ip', max: 120, lockoutSec: 10 * 60 }
export const CUSTOMER_PASSWORD_LIMIT: Limit = { scope: 'customer-login',   max: 8, lockoutSec: 15 * 60 }
export const MAGIC_LINK_VERIFY_LIMIT: Limit = { scope: 'magic-link-verify', max: 30, lockoutSec: 5 * 60 }
// Password-reset REQUESTS, keyed on the email. Deliberately tight: each one
// sends a real message to a real inbox and WhatsApp, so an unthrottled endpoint
// is a way to flood someone else's phone using our gateway. Three is enough for
// "it didn't arrive, try again"; the fourth waits.
export const PASSWORD_RESET_LIMIT:   Limit = { scope: 'password-reset',      max: 3,  lockoutSec: 15 * 60 }
// Reset-link REDEMPTIONS, keyed on IP. The token is 32 random bytes so guessing
// is not the threat; this just stops a scripted sweep from burning CPU on
// bcrypt for every attempt.
export const PASSWORD_RESET_USE_LIMIT: Limit = { scope: 'password-reset-use', max: 20, lockoutSec: 10 * 60 }
