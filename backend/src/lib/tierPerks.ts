// Tier perk evaluator.
//
// Given a customer (or just their tier), return the perks they're entitled
// to. Used by:
//   - Order checkout: free delivery / threshold
//   - Reservation creation: extended-advance booking window
//   - Birthday trigger: enhanced discount %
//   - Storefront /account: rendered as "perks unlocked" list
//
// Tiers without a row in TierConfig fall back to bronze (no perks). Caching
// is 60s in-memory like other setup-config readers — perks are tuned rarely.

import { prisma } from './prisma.js'

export type TierName = 'bronze' | 'silver' | 'gold'

export interface ResolvedPerks {
  tier: TierName
  alwaysFreeDelivery: boolean
  freeDeliveryAboveCents: number | null
  birthdayDiscountPct: number | null     // null = use the trigger's default
  priorityReservationDays: number        // 0 = no extra window
  waitlistPriority: boolean
  monthlyCompCents: number | null
  earlyMenuAccess: boolean
  freeBirthdayItem: boolean
}

const NO_PERKS: Omit<ResolvedPerks, 'tier'> = {
  alwaysFreeDelivery: false,
  freeDeliveryAboveCents: null,
  birthdayDiscountPct: null,
  priorityReservationDays: 0,
  waitlistPriority: false,
  monthlyCompCents: null,
  earlyMenuAccess: false,
  freeBirthdayItem: false,
}

const cache: Map<string, { value: ResolvedPerks; expiresAt: number }> = new Map()
const CACHE_TTL_MS = 60_000

export async function getTierPerks(tier: TierName): Promise<ResolvedPerks> {
  const cached = cache.get(tier)
  if (cached && cached.expiresAt > Date.now()) return cached.value

  const row = await prisma.tierConfig.findUnique({ where: { tier } })
  const resolved: ResolvedPerks = row
    ? {
        tier,
        alwaysFreeDelivery:      row.alwaysFreeDelivery,
        freeDeliveryAboveCents:  row.freeDeliveryAboveCents,
        birthdayDiscountPct:     row.birthdayDiscountPct,
        priorityReservationDays: row.priorityReservationDays ?? 0,
        waitlistPriority:        row.waitlistPriority,
        monthlyCompCents:        row.monthlyCompCents,
        earlyMenuAccess:         row.earlyMenuAccess,
        freeBirthdayItem:        row.freeBirthdayItem,
      }
    : { tier, ...NO_PERKS }
  cache.set(tier, { value: resolved, expiresAt: Date.now() + CACHE_TTL_MS })
  return resolved
}

export function invalidateTierPerksCache(): void {
  cache.clear()
}

// Returns the perks for whichever tier the customer is currently on. Bronze
// (or no loyalty account) → no perks.
export async function getCustomerPerks(customerId: string | null): Promise<ResolvedPerks> {
  if (!customerId) return { tier: 'bronze', ...NO_PERKS }
  const account = await prisma.loyaltyAccount.findUnique({
    where: { customerId },
    select: { tier: true },
  })
  const tier = (account?.tier as TierName | undefined) ?? 'bronze'
  return getTierPerks(tier)
}

// True if this customer's tier qualifies them for free delivery on an order
// of `subtotalCents`. Used by the order checkout flow to set deliveryFee=0.
export async function qualifiesForFreeDelivery(customerId: string | null, subtotalCents: number): Promise<boolean> {
  const perks = await getCustomerPerks(customerId)
  if (perks.alwaysFreeDelivery) return true
  if (perks.freeDeliveryAboveCents != null && subtotalCents >= perks.freeDeliveryAboveCents) return true
  return false
}
