// Returning-guest helpers shared by /account and /orders. Pure functions over
// data the pages already hold; nothing here fetches.

import { brandSurface } from '../../lib/concept'

const DAY = 86_400_000

/** The film-voice greeting for a guest, from their order history alone.
 *  null means "no special line" (the page keeps its plain greeting). */
export function sceneGreeting(orders: ReadonlyArray<{ placedAt: string }>, now: number = Date.now()): string | null {
  if (orders.length === 0) return 'your first scene is one order away.'
  let last = -Infinity
  for (const o of orders) {
    const t = Date.parse(o.placedAt)
    if (Number.isFinite(t) && t > last) last = t
  }
  if (!Number.isFinite(last)) return null
  const days = (now - last) / DAY
  if (days <= 30) return 'welcome back, regular.'
  if (days > 45) return 'long time. the crowd missed you.'
  return null
}

const KNOWN = new Set(['simmer', 'stackd', 'flipd'])

/** A solid, visible accent bar colour per brand (tiber / red plum / Flipd
 *  blue), servd plum for anything else. Not the text accent: stackd's accent
 *  is cream, which vanishes on a light card. */
export function brandBar(slug: string | null | undefined): string {
  const k = (slug ?? '').toLowerCase()
  return KNOWN.has(k) ? brandSurface(k).bg : '#4E2A4F'
}

/** Tier ladder, lowest first. Unknown tiers rank as -1. */
const TIER_RANK = ['bronze', 'silver', 'gold']
export function tierRank(tier: string | null | undefined): number {
  return TIER_RANK.indexOf((tier ?? '').toLowerCase())
}
