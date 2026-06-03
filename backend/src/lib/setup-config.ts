// Centralised readers for the singleton settings shipped under /api/v1/setup.
// Routes / workers / posting code call into here instead of querying the DB
// directly so the "auto-create on first read" semantics live in one place.
//
// Caching: a 60-second in-memory cache keeps order-creation hot path fast.
// Settings rarely change; staleness is bounded.

// Operator-wide configuration. Reads can be invoked from customer-authed
// or pre-auth contexts (checkout's delivery fee + refund policy, receipt
// printing, POS service charge) — route via serviceClient so the singleton
// config tables don't have to add a customer-readable clause.
import { serviceClient as prisma } from './prisma.js'

const CACHE_TTL_MS = 60_000
type Cached<T> = { value: T; expiresAt: number }
const cache = new Map<string, Cached<unknown>>()

function getCached<T>(key: string): T | null {
  const entry = cache.get(key)
  if (!entry || entry.expiresAt < Date.now()) return null
  return entry.value as T
}
function setCached<T>(key: string, value: T): void {
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS })
}
export function invalidateSetupCache(): void { cache.clear() }

// ─── Singleton readers ────────────────────────────────────────────────────────

export async function getOperationsConfig() {
  const cached = getCached<OperationsConfigT>('operations')
  if (cached) return cached
  let cfg = await prisma.operationsConfig.findFirst({ where: { scope: 'global', scopeId: null } })
  if (!cfg) cfg = await prisma.operationsConfig.create({ data: { scope: 'global', scopeId: null } })
  setCached('operations', cfg)
  return cfg
}
type OperationsConfigT = Awaited<ReturnType<typeof prisma.operationsConfig.findFirst>>

export async function getRefundPolicy() {
  const cached = getCached<RefundPolicyT>('refund')
  if (cached) return cached
  let p = await prisma.refundPolicy.findFirst({ where: { scope: 'global', scopeId: null } })
  if (!p) p = await prisma.refundPolicy.create({ data: { scope: 'global', scopeId: null } })
  setCached('refund', p)
  return p
}
type RefundPolicyT = Awaited<ReturnType<typeof prisma.refundPolicy.findFirst>>

export async function getReservationPolicy() {
  const cached = getCached<ReservationPolicyT>('reservation')
  if (cached) return cached
  let p = await prisma.reservationPolicy.findFirst({ where: { scope: 'global', scopeId: null } })
  if (!p) p = await prisma.reservationPolicy.create({ data: { scope: 'global', scopeId: null } })
  setCached('reservation', p)
  return p
}
type ReservationPolicyT = Awaited<ReturnType<typeof prisma.reservationPolicy.findFirst>>

export async function getReceiptConfig() {
  const cached = getCached<ReceiptConfigT>('receipt')
  if (cached) return cached
  let c = await prisma.receiptConfig.findFirst({ where: { scope: 'global', scopeId: null } })
  if (!c) c = await prisma.receiptConfig.create({ data: { scope: 'global', scopeId: null } })
  setCached('receipt', c)
  return c
}
type ReceiptConfigT = Awaited<ReturnType<typeof prisma.receiptConfig.findFirst>>

// ─── Computed helpers ────────────────────────────────────────────────────────

/**
 * Compute service charge cents for a given subtotal + channel. Returns 0 if
 * service charge is disabled, or if the channel is not in the allow-list
 * (when the allow-list is non-empty).
 */
export async function computeServiceCharge(subtotalCents: number, channel: string): Promise<number> {
  const cfg = await getOperationsConfig()
  if (!cfg) return 0
  if (cfg.serviceChargePct <= 0) return 0
  const channels = cfg.serviceChargeAppliesToChannels ?? []
  if (channels.length > 0 && !channels.includes(channel)) return 0
  return Math.round(subtotalCents * cfg.serviceChargePct)
}

/**
 * Look up the matching delivery zone by distance (km). Returns the zone with
 * the smallest matching radius range — operators define narrow zones first
 * (DHA Phase 5) and wider ones later (Outside city).
 */
export async function findDeliveryZone(distanceKm: number, conceptId: string | null) {
  const zones = await prisma.deliveryZone.findMany({
    where: {
      isActive: true,
      OR: [{ conceptId: null }, ...(conceptId ? [{ conceptId }] : [])],
    },
    orderBy: [{ radiusKmMin: 'asc' }, { sortOrder: 'asc' }],
  })
  for (const z of zones) {
    const min = z.radiusKmMin ?? 0
    const max = z.radiusKmMax ?? Number.POSITIVE_INFINITY
    if (distanceKm >= min && distanceKm <= max) return z
  }
  return null
}

/**
 * Compute delivery fee for a given subtotal + distance + concept. Honours
 * `freeAboveCents` thresholds. Returns 0 if no matching zone (caller decides
 * whether that's "free" or "out of range").
 */
export async function computeDeliveryFee(
  subtotalCents: number,
  distanceKm: number,
  conceptId: string | null,
): Promise<{ feeCents: number; zoneId: string | null; zoneName: string | null; meetsMinimum: boolean }> {
  const zone = await findDeliveryZone(distanceKm, conceptId)
  if (!zone) return { feeCents: 0, zoneId: null, zoneName: null, meetsMinimum: true }
  const meetsMinimum = subtotalCents >= zone.minOrderCents
  if (zone.freeAboveCents != null && subtotalCents >= zone.freeAboveCents) {
    return { feeCents: 0, zoneId: zone.id, zoneName: zone.name, meetsMinimum }
  }
  return { feeCents: zone.feeCents, zoneId: zone.id, zoneName: zone.name, meetsMinimum }
}

/**
 * Haversine distance in km between two lat/lng pairs. Used for delivery zone
 * matching when address geocoding gives us coords but the order doesn't carry
 * a pre-computed distance.
 */
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const R = 6371 // km
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}
