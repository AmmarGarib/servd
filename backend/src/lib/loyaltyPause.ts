// Loyalty paused servd-wide (owner, 2026-10-22: "stop the Loyalty points
// section for now, will decide after opening to keep it or not, until then no
// amount should go to loyalty points account").
//
// ONE platform Setting `loyalty.paused`. ABSENT = PAUSED (the owner's
// standing word until they switch it back on). While paused:
//   - no points are earned (loyalty/service creditPointsTx — orders,
//     reservations, reviews, birthday / trigger bonuses, stamps) → no 2060 earn
//   - no points are redeemed (quoteWith → 409 LOYALTY_PAUSED)
//   - the expiry worker does not run (workers/loyaltyExpiration)
//   - the point value cannot change (no revaluation entry on 2060)
// Customers' existing balances stay as they are (frozen, never erased).
// Reversals of points earned BEFORE the pause (a refunded order's claw-back)
// still run: they undo history, they do not add new loyalty money.
// Only the CEO switches it (PUT /loyalty/pause, reason, audited).

import { serviceClient } from './prisma.js'

export const LOYALTY_PAUSE_SETTING = 'loyalty.paused'

export interface LoyaltyPause { paused: boolean; reason: string | null; updatedAt: string | null; updatedById: string | null }

let cache: { at: number; v: LoyaltyPause } | null = null
const TTL_MS = 10_000

/** The switch. Absent or unreadable = PAUSED. Never throws. */
export async function readLoyaltyPause(): Promise<LoyaltyPause> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.v
  const paused: LoyaltyPause = { paused: true, reason: null, updatedAt: null, updatedById: null }
  let v = paused
  try {
    const row = await serviceClient.setting.findUnique({ where: { key: LOYALTY_PAUSE_SETTING } })
    if (row) {
      const o = JSON.parse(row.value) as Partial<LoyaltyPause>
      v = { paused: o.paused !== false, reason: o.reason ?? null, updatedAt: row.updatedAt.toISOString(), updatedById: o.updatedById ?? null }
    }
  } catch { v = paused }
  cache = { at: Date.now(), v }
  return v
}

export async function isLoyaltyPaused(): Promise<boolean> {
  return (await readLoyaltyPause()).paused
}

export async function writeLoyaltyPause(input: { paused: boolean; reason: string; actorId: string }): Promise<LoyaltyPause> {
  const value = JSON.stringify({ paused: input.paused, reason: input.reason, updatedById: input.actorId })
  await serviceClient.setting.upsert({ where: { key: LOYALTY_PAUSE_SETTING }, create: { key: LOYALTY_PAUSE_SETTING, value }, update: { value } })
  cache = null
  return readLoyaltyPause()
}

/** Tests: forget the cached switch. */
export function resetLoyaltyPauseCache(): void { cache = null }
