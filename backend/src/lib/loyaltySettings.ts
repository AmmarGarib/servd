// Loyalty programme settings — the operator's configured earn/redeem rates.
//
// These live here rather than inside the loyalty routes so that EVERY place
// that awards or values points reads the same numbers. Order completion used
// to hardcode "1 point per PKR 1", silently ignoring whatever the operator had
// set on the admin Loyalty page.
//
// The constants below are bootstrap defaults, used when no Setting row exists
// yet and as a fallback if the lookup fails — loyalty must never crash a
// checkout.

import { serviceClient as prisma } from './prisma.js'

export const LOYALTY_SETTING_KEYS = [
  'loyalty.earn_cents_per_point',   // cents of spend that earns one point — default 100 (= 1 pt per PKR 1)
  'loyalty.point_value_cents',      // value of one point at redeem — default 100 (= PKR 1)
  'loyalty.min_redeem_points',      // minimum points needed to redeem in one go
  'loyalty.expiry_months',          // months before unused points expire
  'loyalty.birthday_bonus_points',  // points auto-credited on birthday
  'loyalty.stamp_threshold',        // visits to earn one free item via stamps (per concept)
] as const

export const LOYALTY_DEFAULTS: Record<typeof LOYALTY_SETTING_KEYS[number], number> = {
  'loyalty.earn_cents_per_point':  100,
  'loyalty.point_value_cents':     100,
  'loyalty.min_redeem_points':     50,
  'loyalty.expiry_months':         12,
  'loyalty.birthday_bonus_points': 500,
  'loyalty.stamp_threshold':       9,
}

// Small cache so we don't hit Settings on every order — invalidated when the
// operator saves new values (PATCH /loyalty/settings calls invalidate below).
let cache: { values: typeof LOYALTY_DEFAULTS; expiresAt: number } | null = null
const CACHE_TTL_MS = 60_000

export function invalidateLoyaltySettings(): void { cache = null }

export async function loadLoyaltySettings(): Promise<typeof LOYALTY_DEFAULTS> {
  if (cache && cache.expiresAt > Date.now()) return cache.values
  try {
    const rows = await prisma.setting.findMany({ where: { key: { in: [...LOYALTY_SETTING_KEYS] } } })
    const out = { ...LOYALTY_DEFAULTS }
    for (const r of rows) {
      const n = Number(r.value)
      if (Number.isFinite(n) && n >= 0) (out as Record<string, number>)[r.key] = n
    }
    cache = { values: out, expiresAt: Date.now() + CACHE_TTL_MS }
    return out
  } catch {
    return { ...LOYALTY_DEFAULTS }
  }
}

export async function calculatePointsEarned(totalCents: number): Promise<number> {
  const s = await loadLoyaltySettings()
  const denom = s['loyalty.earn_cents_per_point'] || 100
  return Math.floor(totalCents / denom)
}

export async function calculatePointsValue(points: number): Promise<number> {
  const s = await loadLoyaltySettings()
  return Math.floor(points) * (s['loyalty.point_value_cents'] || 100)
}
