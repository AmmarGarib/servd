// Customer ordering switched off servd-wide (owner, 2026-10-27: "ordering needs to be off on all
// brands for now").
//
// ONE platform Setting `ordering.online`. ABSENT = OFF (the owner's standing word until they switch
// it on). While off, `storefront/serviceHours.ts orderingState` answers closed for EVERY brand, so
// every customer path that already asks it refuses an order: storefront checkout and pre-orders
// (assertOpenForOrders), group orders, WhatsApp ordering (its brand menu lists no brand). The till,
// the KDS and the back office are not customer ordering and never read it. Menus, brand pages and
// bookings stay up. Only the CEO switches it (PUT /ordering-switch, reason, audited).

import { serviceClient } from './prisma.js'

export const ONLINE_ORDERING_SETTING = 'ordering.online'

export interface OnlineOrdering { on: boolean; reason: string | null; updatedAt: string | null; updatedById: string | null }

let cache: { at: number; v: OnlineOrdering } | null = null
const TTL_MS = 10_000

/** The switch. Absent or unreadable = OFF. Never throws. */
export async function readOnlineOrdering(): Promise<OnlineOrdering> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.v
  const off: OnlineOrdering = { on: false, reason: null, updatedAt: null, updatedById: null }
  let v = off
  try {
    const row = await serviceClient.setting.findUnique({ where: { key: ONLINE_ORDERING_SETTING } })
    if (row) {
      const o = JSON.parse(row.value) as Partial<OnlineOrdering>
      v = { on: o.on === true, reason: o.reason ?? null, updatedAt: row.updatedAt.toISOString(), updatedById: o.updatedById ?? null }
    }
  } catch { v = off }
  cache = { at: Date.now(), v }
  return v
}

export async function isOnlineOrderingOn(): Promise<boolean> {
  return (await readOnlineOrdering()).on
}

export async function writeOnlineOrdering(input: { on: boolean; reason: string; actorId: string }): Promise<OnlineOrdering> {
  const value = JSON.stringify({ on: input.on, reason: input.reason, updatedById: input.actorId })
  await serviceClient.setting.upsert({ where: { key: ONLINE_ORDERING_SETTING }, create: { key: ONLINE_ORDERING_SETTING, value }, update: { value } })
  cache = null
  return readOnlineOrdering()
}

/** Tests: forget the cached switch. */
export function resetOnlineOrderingCache(): void { cache = null }
