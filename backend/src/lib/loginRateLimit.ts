// Redis-backed login rate limiter — survives restarts, works across instances.
// Falls back to "allow" on Redis failure so a Redis outage doesn't lock everyone out.

import { redis } from './redis.js'
import { AppError } from './errors.js'

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

export async function check(limit: Limit, ip: string): Promise<void> {
  try {
    const v = await redis.get(key(limit.scope, ip))
    if (!v) return
    const count = parseInt(v, 10)
    if (count >= limit.max) {
      const ttl = await redis.ttl(key(limit.scope, ip))
      const mins = Math.max(1, Math.ceil(ttl / 60))
      throw new AppError(
        'RATE_LIMITED',
        `Too many failed attempts. Try again in ${mins} minute${mins !== 1 ? 's' : ''}.`,
        429,
      )
    }
  } catch (err) {
    if (err instanceof AppError) throw err
    // Redis unavailable — fail open (allow request) so we don't lock everyone out.
  }
}

export async function recordFailure(limit: Limit, ip: string): Promise<void> {
  try {
    const k = key(limit.scope, ip)
    const count = await redis.incr(k)
    if (count === 1) await redis.expire(k, limit.lockoutSec)
  } catch {
    // Redis down — silently skip; the next successful Redis call will record again
  }
}

export async function clearFailures(limit: Limit, ip: string): Promise<void> {
  try {
    await redis.del(key(limit.scope, ip))
  } catch {
    /* ignore */
  }
}

// PIN: 4-digit PIN has only 10K combos. Cap aggressively, both per-IP and per-user.
// (per-user variant is checked separately in the PIN handler — see auth/routes.ts)
export const PIN_LIMIT:               Limit = { scope: 'pin',              max: 3, lockoutSec: 30 * 60 }
export const PIN_USER_LIMIT:          Limit = { scope: 'pin-user',         max: 5, lockoutSec: 60 * 60 }
export const STAFF_PASSWORD_LIMIT:    Limit = { scope: 'staff-login',      max: 5, lockoutSec: 15 * 60 }
export const CUSTOMER_PASSWORD_LIMIT: Limit = { scope: 'customer-login',   max: 8, lockoutSec: 15 * 60 }
export const MAGIC_LINK_VERIFY_LIMIT: Limit = { scope: 'magic-link-verify', max: 30, lockoutSec: 5 * 60 }
