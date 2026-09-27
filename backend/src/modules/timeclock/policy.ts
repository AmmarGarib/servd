// Clock-in policy: geofence + anti-buddy-punching selfie, for ONE company.
//
// Decision 37: one config — the company's OperationsConfig (enforced? radius?
// selfie?) anchored on the company's own Locations with coordinates. Staff may
// punch at ANY of their company's locations, so the nearest one decides. The
// old company-less 'location_config' Setting and "the first concept with
// coordinates, of any company" anchor are gone.

import { AppError } from '../../lib/errors.js'
import { getGeofenceConfig, type GeofenceAnchor } from '../../lib/setup-config.js'

import { isGeofenceExempt } from '../../lib/roles.js'

export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

/** The company location nearest a point, with its distance. */
export function nearestAnchor(anchors: GeofenceAnchor[], lat: number, lng: number): { anchor: GeofenceAnchor; distanceM: number } | null {
  let best: { anchor: GeofenceAnchor; distanceM: number } | null = null
  for (const a of anchors) {
    const d = haversineMeters(a.lat, a.lng, lat, lng)
    if (!best || d < best.distanceM) best = { anchor: a, distanceM: d }
  }
  return best
}

export interface ClockInVerdict {
  geofenceMatched: boolean | null
  geofenceDistanceM: number | null
  locationId: string | null
  locationName: string | null
}

/**
 * Check a punch against the company's policy. Throws when it must be
 * refused; otherwise returns the geofence verdict for the punch log. `role`
 * is null for a kiosk punch by someone without a login — never exempt.
 */
export async function enforceClockInPolicy(
  tenantId: string,
  role: string | null,
  body: { lat?: number; lng?: number; selfieUrl?: string },
): Promise<ClockInVerdict> {
  const none: ClockInVerdict = { geofenceMatched: null, geofenceDistanceM: null, locationId: null, locationName: null }
  if (isGeofenceExempt(role)) return none
  const cfg = await getGeofenceConfig(tenantId)

  if (cfg.selfieRequired && !body.selfieUrl) {
    throw new AppError('SELFIE_REQUIRED', 'Snap a selfie to clock in. Buddy-punching is blocked.', 403)
  }

  const hasFix = body.lat != null && body.lng != null
  const near = hasFix ? nearestAnchor(cfg.anchors, body.lat!, body.lng!) : null
  const verdict: ClockInVerdict = near
    ? { geofenceMatched: near.distanceM <= cfg.radiusM, geofenceDistanceM: Math.round(near.distanceM), locationId: near.anchor.locationId, locationName: near.anchor.name }
    : none

  if (!cfg.enforced) return verdict
  if (cfg.anchors.length === 0) {
    // Enforced with nothing to measure from: refuse with the fix rather than
    // silently letting everyone through.
    throw new AppError('NO_BRANCH_LOCATION', 'Clock-in is limited to the branch, but no branch of this company has its map pin set — ask a manager to set it under Configuration → Locations.', 403)
  }
  if (!hasFix) throw new AppError('LOCATION_REQUIRED', 'Allow location on this device — you can only clock in on-site.', 403)
  if (!verdict.geofenceMatched) {
    throw new AppError(
      'OUTSIDE_GEOFENCE',
      `You must be within ${cfg.radiusM}m of one of this company's branches to clock in (the nearest, ${near!.anchor.name}, is ${Math.round(near!.distanceM)}m away).`,
      403,
    )
  }
  return verdict
}
