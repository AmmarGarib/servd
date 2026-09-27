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
  'loyalty.point_value_cents',      // value of one point at redeem — default 10 (= PKR 0.10, owner decision 12)
  'loyalty.min_redeem_points',      // minimum points needed to redeem in one go
  'loyalty.expiry_months',          // months before unused points expire
  'loyalty.birthday_bonus_points',  // points auto-credited on birthday
  'loyalty.stamp_threshold',        // visits to earn one free item via stamps (per concept)
] as const

// Owner decision 12: one point is worth PKR 0.10 everywhere — at checkout, on
// the account page, in the admin setting and in the books. The default used to
// be 100 (PKR 1) while checkout paid 10 paisa and the ledger booked 1 paisa.
// Stored company values of the old default are corrected once by
// modules/loyalty/settings.ts (applyPointValueDecision).
export const POINT_VALUE_CENTS = 10

export const LOYALTY_DEFAULTS: Record<typeof LOYALTY_SETTING_KEYS[number], number> = {
  'loyalty.earn_cents_per_point':  100,
  'loyalty.point_value_cents':     POINT_VALUE_CENTS,
  'loyalty.min_redeem_points':     50,
  'loyalty.expiry_months':         12,
  'loyalty.birthday_bonus_points': 500,
  'loyalty.stamp_threshold':       9,
}

// Loyalty values are per company (modules/loyalty/settings.ts). Cached per
// company for a minute; PATCH /loyalty/settings invalidates.
const cache = new Map<string, { values: typeof LOYALTY_DEFAULTS; expiresAt: number }>()
const CACHE_TTL_MS = 60_000

export function invalidateLoyaltySettings(): void { cache.clear() }

export async function loadLoyaltySettings(tenantId: string | null | undefined): Promise<typeof LOYALTY_DEFAULTS> {
  if (!tenantId) return { ...LOYALTY_DEFAULTS }
  const hit = cache.get(tenantId)
  if (hit && hit.expiresAt > Date.now()) return hit.values
  try {
    const { loadCompanyLoyaltySettings } = await import('../modules/loyalty/settings.js')
    const out = await loadCompanyLoyaltySettings(tenantId)
    cache.set(tenantId, { values: out, expiresAt: Date.now() + CACHE_TTL_MS })
    return out
  } catch {
    return { ...LOYALTY_DEFAULTS }
  }
}

export async function calculatePointsEarned(totalCents: number, tenantId: string | null | undefined): Promise<number> {
  const s = await loadLoyaltySettings(tenantId)
  const denom = s['loyalty.earn_cents_per_point'] || 100
  return Math.floor(totalCents / denom)
}

export async function calculatePointsValue(points: number, tenantId: string | null | undefined): Promise<number> {
  const s = await loadLoyaltySettings(tenantId)
  return Math.floor(points) * (s['loyalty.point_value_cents'] || POINT_VALUE_CENTS)
}
