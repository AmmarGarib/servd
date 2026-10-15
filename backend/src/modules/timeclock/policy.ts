// Clock-in policy: where a punch was taken, and the anti-buddy-punching selfie, for ONE company.
//
// Attendance by work location (owner, 2026-10-15). A punch is measured against the punching employee's own WORK
// LOCATIONS (HrWorkLocation rows — an employee may have several); with none set, against every located Location of
// the company (decision 37, today's rule). The NEAREST anchor decides, inside its own radius: the work location's
// radiusMetres, else the location's geofenceRadiusMetres, else the company's OperationsConfig radius.
//
// A punch is NEVER refused for where it was taken (owner: "Allow it but flag it"). The verdict is stored on the
// punch; when the company's geofence is switched on (OperationsConfig.geofenceEnforced) a punch outside every anchor,
// or with no location fix, is OUT OF AREA: the day's attendance record says so and HR gets ONE exception flag per
// employee per Karachi day (flagOutOfArea). With the switch off the verdict is only stored. Geofence-exempt roles
// (isGeofenceExempt) are not measured at all. The selfie rule is unchanged: required at clock-in when the company
// asks for it.

import { AppError } from '../../lib/errors.js'
import { serviceClient as prisma } from '../../lib/prisma.js'
import { getGeofenceConfig, type GeofenceAnchor } from '../../lib/setup-config.js'
import { flagException, kindsMatching } from '../../lib/exceptions.js'
import { isGeofenceExempt } from '../../lib/roles.js'
import { haversineMeters } from '../../lib/geo.js'
import { pktToday } from '../hr/logic.js'

/** The anchor nearest a point, with its distance. */
export function nearestAnchor(anchors: GeofenceAnchor[], lat: number, lng: number): { anchor: GeofenceAnchor; distanceM: number } | null {
  let best: { anchor: GeofenceAnchor; distanceM: number } | null = null
  for (const a of anchors) {
    const d = haversineMeters(a.lat, a.lng, lat, lng)
    if (!best || d < best.distanceM) best = { anchor: a, distanceM: d }
  }
  return best
}

/** Why a punch is out of area: outside every anchor, no location fix from the device, or nothing to measure from. */
export type OutOfAreaReason = 'outside' | 'no_fix' | 'no_anchor'

export interface ClockInVerdict {
  /** true inside the nearest anchor's radius, false outside, null = not measured. */
  geofenceMatched: boolean | null
  geofenceDistanceM: number | null
  /** The nearest anchor (the work location the punch is booked at). */
  locationId: string | null
  locationName: string | null
  /** The radius the punch was held to (metres). */
  radiusM: number | null
  /** Outside / no fix while the company's geofence is on. Null = not judged (exempt role, an out with no fix). */
  outOfArea: boolean | null
  outOfAreaReason: OutOfAreaReason | null
  /** The company's geofence switch: on = an out-of-area punch is flagged for HR. */
  enforced: boolean
  /** Measured from the employee's own work locations (false = the company's locations). */
  fromWorkLocations: boolean
}

const NOT_JUDGED: ClockInVerdict = {
  geofenceMatched: null, geofenceDistanceM: null, locationId: null, locationName: null, radiusM: null,
  outOfArea: null, outOfAreaReason: null, enforced: false, fromWorkLocations: false,
}

/**
 * The anchors a punch by this employee is measured from: their own work locations that are live and have a map
 * pin, in the punch's company; none → every located location of the company.
 */
export async function anchorsFor(tenantId: string, employeeId: string | null, companyAnchors: GeofenceAnchor[]): Promise<{ anchors: GeofenceAnchor[]; fromWorkLocations: boolean }> {
  if (employeeId) {
    const rows = await prisma.hrWorkLocation.findMany({
      where: {
        tenantId, employeeId,
        location: { tenantId, isActive: true, deletedAt: null, latitude: { not: null }, longitude: { not: null } },
      },
      include: { location: { select: { id: true, name: true, latitude: true, longitude: true, geofenceRadiusMetres: true } } },
    })
    if (rows.length) {
      return {
        fromWorkLocations: true,
        anchors: rows.map((r) => ({
          locationId: r.location.id, name: r.location.name, lat: r.location.latitude!, lng: r.location.longitude!,
          radiusM: r.radiusMetres ?? r.location.geofenceRadiusMetres ?? null,
        })),
      }
    }
  }
  return { anchors: companyAnchors, fromWorkLocations: false }
}

export interface PunchWhere { lat?: number; lng?: number; selfieUrl?: string }

/**
 * Judge a punch against the company's policy. Throws only for the selfie rule (clock-in, when the company requires
 * it) — never for where the punch was taken. `role` is null for a kiosk punch by someone without a login (never
 * exempt). `employeeId` is the HR employee punching in this company, if any. An OUT with no location fix is not
 * judged (logging out of the admin sends no location); an out with a fix is measured like an in.
 */
export async function enforceClockInPolicy(
  tenantId: string,
  role: string | null,
  body: PunchWhere,
  opts: { employeeId?: string | null; kind?: 'in' | 'out' } = {},
): Promise<ClockInVerdict> {
  if (isGeofenceExempt(role)) return NOT_JUDGED
  const kind = opts.kind ?? 'in'
  const cfg = await getGeofenceConfig(tenantId)

  if (kind === 'in' && cfg.selfieRequired && !body.selfieUrl) {
    throw new AppError('SELFIE_REQUIRED', 'Snap a selfie to clock in. Buddy-punching is blocked.', 403)
  }

  const hasFix = body.lat != null && body.lng != null
  if (kind === 'out' && !hasFix) return { ...NOT_JUDGED, enforced: cfg.enforced }

  const { anchors, fromWorkLocations } = await anchorsFor(tenantId, opts.employeeId ?? null, cfg.anchors)
  const near = hasFix ? nearestAnchor(anchors, body.lat!, body.lng!) : null
  const radiusM = near ? (near.anchor.radiusM ?? cfg.radiusM) : null
  const matched = near ? near.distanceM <= radiusM! : null
  const reason: OutOfAreaReason | null = !hasFix ? 'no_fix' : !near ? 'no_anchor' : matched ? null : 'outside'
  return {
    geofenceMatched: matched,
    geofenceDistanceM: near ? Math.round(near.distanceM) : null,
    locationId: near?.anchor.locationId ?? null,
    locationName: near?.anchor.name ?? null,
    radiusM,
    outOfArea: cfg.enforced && reason != null,
    outOfAreaReason: reason,
    enforced: cfg.enforced,
    fromWorkLocations,
  }
}

/** The exception kind HR sees for a punch outside the work locations. */
export const OUT_OF_AREA_KIND = 'attendance_out_of_area' as const

const REASON_TEXT: Record<OutOfAreaReason, string> = {
  outside: 'outside their work locations',
  no_fix: 'with no location from the device',
  no_anchor: 'where no work location has a map pin to measure from',
}

/**
 * Raise the day's out-of-area flag for HR: ONE per employee (or, for a login with no employee record, per login) per
 * Karachi day. A later out-of-area punch the same day only bumps the flag's counts. Metadata holds counts and
 * distances — never coordinates. Never throws (a flag must not block a punch).
 */
export async function flagOutOfArea(input: {
  tenantId: string
  employeeId: string | null
  userId: string | null
  name: string | null
  kind: 'in' | 'out'
  at: Date
  verdict: ClockInVerdict
}): Promise<void> {
  const { verdict: v } = input
  if (!v.enforced || !v.outOfArea || !v.outOfAreaReason) return
  const subjectType = input.employeeId ? 'HrEmployee' : 'User'
  const subjectId = input.employeeId ?? input.userId
  if (!subjectId) return
  const day = pktToday(input.at).toISOString().slice(0, 10)
  try {
    await prisma.$transaction(async (tx) => {
      // One flag per subject per day, even for two punches at once.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`attendance-ooa:${input.tenantId}:${subjectId}:${day}`}))`
      const cur = await tx.exceptionFlag.findFirst({
        where: {
          tenantId: input.tenantId, kind: { in: kindsMatching(OUT_OF_AREA_KIND) }, entityType: subjectType, entityId: subjectId,
          metadata: { path: ['day'], equals: day },
        },
        select: { id: true, metadata: true },
      })
      if (cur) {
        const m = (cur.metadata ?? {}) as Record<string, unknown>
        await tx.exceptionFlag.update({
          where: { id: cur.id },
          data: {
            metadata: {
              ...m,
              punches: Number(m['punches'] ?? 1) + 1,
              [input.kind === 'in' ? 'ins' : 'outs']: Number(m[input.kind === 'in' ? 'ins' : 'outs'] ?? 0) + 1,
              ...(v.geofenceDistanceM != null && { maxDistanceM: Math.max(Number(m['maxDistanceM'] ?? 0), v.geofenceDistanceM) }),
            },
          },
        })
        return
      }
      // The lock is held until this transaction ends, so a second punch waits for this flag to be written.
      await flagException({
        tenantId: input.tenantId,
        kind: OUT_OF_AREA_KIND,
        severity: 'medium',
        title: `Punch out of area${input.name ? `: ${input.name}` : ''}`,
        description: `${input.name ?? 'A staff member'} punched ${input.kind} ${REASON_TEXT[v.outOfAreaReason!]}`
          + (v.geofenceDistanceM != null && v.locationName ? ` — ${v.geofenceDistanceM} m from ${v.locationName} (allowed ${v.radiusM} m)` : '')
          + '. The punch was recorded; HR may check it.',
        entityType: subjectType,
        entityId: subjectId,
        actorId: input.userId,
        metadata: {
          day, punches: 1, ins: input.kind === 'in' ? 1 : 0, outs: input.kind === 'out' ? 1 : 0,
          firstReason: v.outOfAreaReason, ...(v.geofenceDistanceM != null && { maxDistanceM: v.geofenceDistanceM }),
          ...(v.radiusM != null && { radiusM: v.radiusM }), ...(v.locationId && { nearestLocationId: v.locationId }),
        },
      })
    }, { timeout: 15_000 })
  } catch (err) {
    console.warn('[timeclock] out-of-area flag failed:', (err as Error).message)
  }
}
