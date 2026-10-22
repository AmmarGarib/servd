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
import { AppError } from './errors.js'

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
  // A head office (D1) is never the "primary" company: it has no brands,
  // sales or till, so a company-less reader must fall back to a trading one.
  const t = await prisma.tenant.findFirst({
    where: { isActive: true, deletedAt: null, kind: 'company' },
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

// ─── Clock-in geofence ───────────────────────────────────────────────────────
//
// ONE config (owner decision 37): the company's OperationsConfig says whether
// the geofence and the selfie are enforced and how wide the fence is; the
// anchors are the company's own Locations that have coordinates. Staff may
// punch at ANY of their company's locations, so the nearest one decides. The
// old company-less 'location_config' Setting is not read any more.

/** A place a punch is measured from. `radiusM` is the place's own fence (a work location's radius, else the
 *  location's geofenceRadiusMetres); null = the company's radius. */
export interface GeofenceAnchor { locationId: string; name: string; lat: number; lng: number; radiusM?: number | null }
export interface GeofenceConfig {
  enforced: boolean
  radiusM: number
  selfieRequired: boolean
  anchors: GeofenceAnchor[]
}

/** The default fence (owner's card, 2026-10-22: 100 m) when the company has not set one. */
export const DEFAULT_GEOFENCE_RADIUS_M = 100

export async function getGeofenceConfig(tenantId: string): Promise<GeofenceConfig> {
  const ops = await getOperationsConfig(tenantId)
  // Only the pin and radius the CEO approved count (owner, 2026-10-22) — an edited pin waits in the approvals inbox.
  const locs = await prisma.location.findMany({
    where: { tenantId, isActive: true, deletedAt: null, fenceLatitude: { not: null }, fenceLongitude: { not: null } },
    select: { id: true, name: true, fenceLatitude: true, fenceLongitude: true, fenceRadiusMetres: true },
    orderBy: { name: 'asc' },
  })
  return {
    enforced: ops?.geofenceEnforced ?? false,
    radiusM: ops?.geofenceRadiusMetres ?? DEFAULT_GEOFENCE_RADIUS_M,
    selfieRequired: ops?.selfieRequiredAtClockIn ?? false,
    anchors: locs.map((l) => ({ locationId: l.id, name: l.name, lat: l.fenceLatitude!, lng: l.fenceLongitude!, radiusM: l.fenceRadiusMetres })),
  }
}

// ─── Tip pool weights ────────────────────────────────────────────────────────
//
// Owner decision 36: servers 1.0, cashiers and baristas 0.75, kitchen 0.5.
// Everyone else is out of the pool unless the company gives them a weight in
// /configuration/operations. These defaults only SEED the editor and fill in
// roles a company never set; what the company saved wins. 'barista' is not a
// login role: it applies to a person whose HR designation says barista.

export const TIP_POOL_DEFAULT_WEIGHTS: Record<string, number> = {
  foh: 1.0,
  cashier: 0.75,
  barista: 0.75,
  kitchen: 0.5,
  boh: 0.5,
  expediter: 0.5,
}

/** The company's tip-pool weights: saved values over the defaults. */
export function tipPoolWeights(cfg: { tipPoolRoleWeights?: unknown } | null | undefined): Record<string, number> {
  const saved = cfg?.tipPoolRoleWeights
  const out: Record<string, number> = { ...TIP_POOL_DEFAULT_WEIGHTS }
  if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
    for (const [k, v] of Object.entries(saved as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = v
    }
  }
  return out
}

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
 * `freeAboveCents` thresholds.
 *
 * DeliveryZone bands are the ONE source of delivery coverage (owner decision
 * 19, 2026-09-27): delivery beyond the brand's last zone is REFUSED. This
 * used to return a zero fee and no minimum when no zone matched, so a
 * customer inside the old Concept.deliveryRadiusKm but past the last band —
 * or anyone posting straight to /storefront/orders from further out — got
 * free delivery with no minimum order. Brands that only had a radius were
 * given one zone at their current fee by data migration, so nothing that was
 * deliverable before stops being deliverable.
 *
 * Throws AppError (422):
 *   DELIVERY_UNAVAILABLE   — the brand (and its company) has no active zone
 *   OUTSIDE_DELIVERY_AREA  — zones exist, the drop point is beyond all of them
 */
export async function computeDeliveryFee(
  subtotalCents: number,
  distanceKm: number,
  conceptId: string | null,
): Promise<{ feeCents: number; zoneId: string | null; zoneName: string | null; meetsMinimum: boolean }> {
  const zone = await findDeliveryZone(distanceKm, conceptId)
  if (!zone) {
    const reach = await deliveryReachKm(conceptId)
    if (reach === null) {
      throw new AppError('DELIVERY_UNAVAILABLE', 'This kitchen is not delivering right now. Please choose pickup.', 422)
    }
    throw new AppError(
      'OUTSIDE_DELIVERY_AREA',
      `That address is ${distanceKm.toFixed(1)} km away — we deliver up to ${reach.toFixed(1)} km from this kitchen. Please choose pickup or a closer address.`,
      422,
    )
  }
  const meetsMinimum = subtotalCents >= zone.minOrderCents
  if (zone.freeAboveCents != null && subtotalCents >= zone.freeAboveCents) {
    return { feeCents: 0, zoneId: zone.id, zoneName: zone.name, meetsMinimum }
  }
  return { feeCents: zone.feeCents, zoneId: zone.id, zoneName: zone.name, meetsMinimum }
}

/**
 * How far a brand delivers: the outer edge of its furthest active zone (its
 * own zones plus its company's "All brands" zones). `Infinity` when a zone is
 * open-ended (no radiusKmMax), `null` when there is no active zone at all —
 * i.e. the brand does not deliver. This is what the storefront brand list
 * should filter on instead of Concept.deliveryRadiusKm.
 */
export async function deliveryReachKm(conceptId: string | null): Promise<number | null> {
  const tenantId = await tenantForConcept(conceptId)
  if (!tenantId) return null
  const zones = await prisma.deliveryZone.findMany({
    where: {
      isActive: true,
      tenantId,
      OR: [{ conceptId: null }, ...(conceptId ? [{ conceptId }] : [])],
    },
    select: { radiusKmMax: true },
  })
  if (zones.length === 0) return null
  let reach = 0
  for (const z of zones) {
    if (z.radiusKmMax == null) return Number.POSITIVE_INFINITY
    reach = Math.max(reach, z.radiusKmMax)
  }
  return reach
}

// Haversine lives in lib/geo.ts (D16). Re-exported for existing importers of
// delivery-zone matching; new code imports from './geo.js' directly.
export { haversineKm } from './geo.js'
