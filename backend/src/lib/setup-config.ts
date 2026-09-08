// Centralised readers for the singleton settings shipped under /api/v1/setup.
// Routes / workers / posting code call into here instead of querying the DB
// directly so the "auto-create on first read" semantics live in one place.
//
// Every singleton is PER COMPANY (one `scope='global'` row per tenantId —
// migration 20260907130000). Callers pass the company they are acting for;
// when a caller genuinely has no company context (a brand-less worker, a
// pre-auth path with only a concept), `tenantForConcept()` / the primary
// company fallback resolve it. Never read a company-less row: with several
// companies that is a coin toss between their settings.
//
// Caching: a 60-second in-memory cache per (setting, company) keeps the
// order-creation hot path fast. Settings rarely change; staleness is bounded.

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

// ─── Company resolution ──────────────────────────────────────────────────────

/**
 * The oldest active company. Only a fallback for callers with no company
 * context at all (mirrors the migration backfill rule). Cached.
 */
export async function primaryTenantId(): Promise<string | null> {
  const cached = getCached<string | null>('primary-tenant')
  if (cached !== null) return cached
  const t = await prisma.tenant.findFirst({
    where: { isActive: true, deletedAt: null },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  })
  const id = t?.id ?? null
  if (id) setCached('primary-tenant', id)
  return id
}

/** Company that owns a brand. Cached. Null for unknown brands. */
export async function tenantForConcept(conceptId: string | null | undefined): Promise<string | null> {
  if (!conceptId) return null
  const key = `concept-tenant:${conceptId}`
  const cached = getCached<string>(key)
  if (cached) return cached
  const c = await prisma.concept.findUnique({ where: { id: conceptId }, select: { tenantId: true } })
  if (c?.tenantId) setCached(key, c.tenantId)
  return c?.tenantId ?? null
}

async function resolveTenant(tenantId: string | null | undefined): Promise<string | null> {
  return tenantId ?? (await primaryTenantId())
}

// ─── Singleton readers ────────────────────────────────────────────────────────
//
// Each takes the company. Pass `req.staffUser!.tenantId` from a staff route,
// `await tenantForConcept(conceptId)` from a brand-only context.

export async function getOperationsConfig(tenantId?: string | null) {
  const t = await resolveTenant(tenantId)
  const key = `operations:${t ?? '-'}`
  const cached = getCached<OperationsConfigT>(key)
  if (cached) return cached
  let cfg = await prisma.operationsConfig.findFirst({ where: { scope: 'global', scopeId: null, tenantId: t } })
  if (!cfg) cfg = await prisma.operationsConfig.create({ data: { scope: 'global', scopeId: null, tenantId: t } })
  setCached(key, cfg)
  return cfg
}
type OperationsConfigT = Awaited<ReturnType<typeof prisma.operationsConfig.findFirst>>

export async function getRefundPolicy(tenantId?: string | null) {
  const t = await resolveTenant(tenantId)
  const key = `refund:${t ?? '-'}`
  const cached = getCached<RefundPolicyT>(key)
  if (cached) return cached
  let p = await prisma.refundPolicy.findFirst({ where: { scope: 'global', scopeId: null, tenantId: t } })
  if (!p) p = await prisma.refundPolicy.create({ data: { scope: 'global', scopeId: null, tenantId: t } })
  setCached(key, p)
  return p
}
type RefundPolicyT = Awaited<ReturnType<typeof prisma.refundPolicy.findFirst>>

export async function getReservationPolicy(tenantId?: string | null) {
  const t = await resolveTenant(tenantId)
  const key = `reservation:${t ?? '-'}`
  const cached = getCached<ReservationPolicyT>(key)
  if (cached) return cached
  let p = await prisma.reservationPolicy.findFirst({ where: { scope: 'global', scopeId: null, tenantId: t } })
  if (!p) p = await prisma.reservationPolicy.create({ data: { scope: 'global', scopeId: null, tenantId: t } })
  setCached(key, p)
  return p
}
type ReservationPolicyT = Awaited<ReturnType<typeof prisma.reservationPolicy.findFirst>>

export async function getReceiptConfig(tenantId?: string | null) {
  const t = await resolveTenant(tenantId)
  const key = `receipt:${t ?? '-'}`
  const cached = getCached<ReceiptConfigT>(key)
  if (cached) return cached
  let c = await prisma.receiptConfig.findFirst({ where: { scope: 'global', scopeId: null, tenantId: t } })
  if (!c) c = await prisma.receiptConfig.create({ data: { scope: 'global', scopeId: null, tenantId: t } })
  setCached(key, c)
  return c
}
type ReceiptConfigT = Awaited<ReturnType<typeof prisma.receiptConfig.findFirst>>

// ─── Computed helpers ────────────────────────────────────────────────────────

/**
 * Compute service charge cents for a given subtotal + channel for a company.
 * Returns 0 if service charge is disabled, or if the channel is not in the
 * allow-list (when the allow-list is non-empty).
 */
export async function computeServiceCharge(subtotalCents: number, channel: string, tenantId?: string | null): Promise<number> {
  const cfg = await getOperationsConfig(tenantId)
  if (!cfg) return 0
  if (cfg.serviceChargePct <= 0) return 0
  const channels = cfg.serviceChargeAppliesToChannels ?? []
  if (channels.length > 0 && !channels.includes(channel)) return 0
  return Math.round(subtotalCents * cfg.serviceChargePct)
}

/**
 * Look up the matching delivery zone by distance (km) for a brand. Only the
 * brand's own zones and its company's "all brands" zones are candidates —
 * never another company's. Returns the zone with the smallest matching
 * radius range — operators define narrow zones first (DHA Phase 5) and wider
 * ones later (Outside city).
 */
export async function findDeliveryZone(distanceKm: number, conceptId: string | null) {
  const tenantId = await tenantForConcept(conceptId)
  if (!tenantId) return null
  const zones = await prisma.deliveryZone.findMany({
    where: {
      isActive: true,
      tenantId,
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
