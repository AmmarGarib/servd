// Public contact-form limiter (SEO round 1, WP4).
//
// The contact form is unauthenticated and stores a reply phone / email that
// staff will act on, so it is capped three ways BEFORE anything is stored:
//   - per caller address: 5 per hour,
//   - per reply phone: 3 per hour,
//   - per reply email: 3 per hour.
// The address bucket uses the `redisFast` connection (a dead Redis rejects
// promptly) and falls back to bounded per-process counters — it never fails
// open. The phone / email buckets are read from the stored rows themselves, so
// they hold across processes with no extra state. Nothing is ever sent to the
// reply address on submit: the form can't be used to text a stranger.

import { redisFast } from '../../lib/redis.js'
import { prisma } from '../../lib/prisma.js'

export const CONTACT_IP_MAX = 5
export const CONTACT_IDENTITY_MAX = 3
const WINDOW_SEC = 60 * 60

const memory = new Map<string, { count: number; expiresAt: number }>()
const MAX_KEYS = 10_000

function memoryHit(key: string, now: number): number {
  const e = memory.get(key)
  if (!e || e.expiresAt <= now) {
    if (memory.size >= MAX_KEYS) {
      for (const [k, v] of memory) if (v.expiresAt <= now) memory.delete(k)
      if (memory.size >= MAX_KEYS) memory.clear()
    }
    memory.set(key, { count: 1, expiresAt: now + WINDOW_SEC * 1000 })
    return 1
  }
  e.count += 1
  return e.count
}

/** Test hook: forget the per-process counters. */
export function resetContactLimit(): void { memory.clear() }

/** Count this submission against the caller address; true = over the limit. */
export async function contactAddressOver(ip: string): Promise<boolean> {
  const key = `ratelimit:contact-ip:${ip}`
  try {
    const n = await Promise.race([
      (async () => {
        const c = await redisFast.incr(key)
        if (c === 1) await redisFast.expire(key, WINDOW_SEC)
        return c
      })(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('redis timeout')), 750)),
    ])
    return n > CONTACT_IP_MAX
  } catch {
    return memoryHit(key, Date.now()) > CONTACT_IP_MAX
  }
}

/** True when this reply phone or email already sent its quota in the last hour. */
export async function contactIdentityOver(replyPhone: string | null, replyEmail: string | null): Promise<boolean> {
  const since = new Date(Date.now() - WINDOW_SEC * 1000)
  const or: Array<{ replyPhone: string } | { replyEmail: string }> = []
  if (replyPhone) or.push({ replyPhone })
  if (replyEmail) or.push({ replyEmail })
  if (or.length === 0) return false
  for (const one of or) {
    const n = await prisma.feedbackEntry.count({ where: { kind: 'contact', createdAt: { gte: since }, ...one } })
    if (n >= CONTACT_IDENTITY_MAX) return true
  }
  return false
}
