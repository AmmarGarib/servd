// Work locations on the employee profile (owner, 2026-10-15: "put employment location into their erp profile …
// make sure i can give staff multiple employment locations").
//
//   GET /hr/employees/:id/work-locations   the employee's work locations (HR team)
//   PUT /hr/employees/:id/work-locations   replace the set {items:[{locationId, radiusMetres?, isPrimary?}]}
//
// A work location is a Location of the EMPLOYEE's company (422 LOCATION_NOT_IN_COMPANY otherwise; another company's
// employee is 404). At most 10; exactly one primary when the set is not empty. The primary is the employee's
// "Branch Location": hr_employees.locationId is kept in step with it. The time clock measures every punch against
// these (timeclock/policy.ts); a location with no map pin cannot measure a punch, so the list says so.
// Registered from hr/routes.ts under the /hr prefix — /hr/employees is gated by module staff_hr (lib/moduleAccess.ts).

import type { FastifyInstance } from 'fastify'
import type { UserRole } from '@prisma/client'
import { z } from 'zod'
import { serviceClient as prisma } from '../../lib/prisma.js'
import { requireAuth } from '../auth/middleware.js'
import { AppError, NotFoundError, ForbiddenError } from '../../lib/errors.js'
import { scopeTenantWhere } from '../../lib/tenantScope.js'
import { audit } from '../../lib/audit.js'

/** The HR team — the roles that edit HR employees (hr/routes.ts HR_ADMIN). */
const HR_TEAM = ['admin', 'owner', 'management', 'hr'] as UserRole[]
/** Who may edit the employee record linked to their own login (hr/routes.ts SELF_EDITORS). */
const SELF_EDITORS = ['admin', 'owner'] as UserRole[]
export const MAX_WORK_LOCATIONS = 10

const itemsBody = z.object({
  items: z.array(z.object({
    locationId: z.string().min(1).max(64),
    radiusMetres: z.number().int().min(10).max(5000).nullable().optional(),
    isPrimary: z.boolean().optional(),
  })).max(MAX_WORK_LOCATIONS),
})

/** An employee's work locations, primary first, with whether each can measure a punch (has a map pin). */
export async function workLocationsOf(employeeId: string, tenantId: string) {
  const rows = await prisma.hrWorkLocation.findMany({
    where: { employeeId, tenantId },
    include: { location: { select: { id: true, name: true, latitude: true, longitude: true, geofenceRadiusMetres: true, isActive: true, deletedAt: true } } },
    orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
  })
  return rows.map((r) => ({
    id: r.id,
    locationId: r.locationId,
    name: r.location.name,
    radiusMetres: r.radiusMetres,
    locationRadiusMetres: r.location.geofenceRadiusMetres,
    isPrimary: r.isPrimary,
    hasPin: r.location.latitude != null && r.location.longitude != null,
    live: r.location.isActive && !r.location.deletedAt,
  }))
}

export async function workLocationRoutes(fastify: FastifyInstance) {
  fastify.get<{ Params: { id: string } }>('/employees/:id/work-locations', { preHandler: requireAuth(...HR_TEAM) }, async (req) => {
    const emp = await prisma.hrEmployee.findFirst({ where: { id: req.params.id, ...(await scopeTenantWhere(req, 'read')) }, select: { id: true, tenantId: true, locationId: true } })
    if (!emp) throw new NotFoundError('Employee', req.params.id)
    return { employeeId: emp.id, tenantId: emp.tenantId, items: await workLocationsOf(emp.id, emp.tenantId) }
  })

  fastify.put<{ Params: { id: string } }>('/employees/:id/work-locations', { preHandler: requireAuth(...HR_TEAM) }, async (req) => {
    const body = itemsBody.parse(req.body)
    const emp = await prisma.hrEmployee.findFirst({ where: { id: req.params.id, ...(await scopeTenantWhere(req, 'write')) }, select: { id: true, tenantId: true, userId: true, locationId: true } })
    if (!emp) throw new NotFoundError('Employee', req.params.id)
    // Nobody moves their own clock-in fence (hr/routes.ts saveEmployee: no self-edit of the master record).
    if (emp.userId && emp.userId === req.staffUser!.id && !SELF_EDITORS.includes(req.staffUser!.role)) {
      throw new ForbiddenError('You cannot edit your own work locations — ask another HR user')
    }

    const ids = body.items.map((i) => i.locationId)
    if (new Set(ids).size !== ids.length) throw new AppError('DUPLICATE_LOCATION', 'A location is listed twice', 400)
    const primaries = body.items.filter((i) => i.isPrimary).length
    if (body.items.length && primaries !== 1) throw new AppError('PRIMARY_REQUIRED', 'Mark exactly one work location as primary', 400)

    // Every location must be a live Location of the EMPLOYEE's company (never trust a client id).
    const locs = ids.length
      ? await prisma.location.findMany({ where: { id: { in: ids }, tenantId: emp.tenantId, isActive: true, deletedAt: null }, select: { id: true, name: true } })
      : []
    const foreign = ids.filter((id) => !locs.some((l) => l.id === id))
    if (foreign.length) {
      throw new AppError('LOCATION_NOT_IN_COMPANY', 'Every work location must be a live location of the employee\'s company', 422, { locationIds: foreign })
    }

    const before = await workLocationsOf(emp.id, emp.tenantId)
    const primaryId = body.items.find((i) => i.isPrimary)?.locationId ?? null
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`hr-work-locations:${emp.id}`}))`
      await tx.hrWorkLocation.deleteMany({ where: { employeeId: emp.id, locationId: { notIn: ids } } })
      for (const i of body.items) {
        await tx.hrWorkLocation.upsert({
          where: { employeeId_locationId: { employeeId: emp.id, locationId: i.locationId } },
          create: { tenantId: emp.tenantId, employeeId: emp.id, locationId: i.locationId, radiusMetres: i.radiusMetres ?? null, isPrimary: !!i.isPrimary, createdById: req.staffUser!.id },
          update: { radiusMetres: i.radiusMetres ?? null, isPrimary: !!i.isPrimary },
        })
      }
      // The primary is the employee's Branch Location. An empty set leaves the branch as it was (HR clears it on
      // the profile) — the clock then measures from the company's locations.
      if (primaryId && primaryId !== emp.locationId) {
        await tx.hrEmployee.update({ where: { id: emp.id }, data: { locationId: primaryId } })
      }
    })
    const after = await workLocationsOf(emp.id, emp.tenantId)
    await audit({
      category: 'identity', action: 'hr.work_locations.update', entity: 'HrEmployee', entityId: emp.id,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId: emp.tenantId,
      before: { items: before.map((b) => ({ locationId: b.locationId, radiusMetres: b.radiusMetres, isPrimary: b.isPrimary })) },
      after: { items: after.map((b) => ({ locationId: b.locationId, radiusMetres: b.radiusMetres, isPrimary: b.isPrimary })) },
    })
    return { employeeId: emp.id, tenantId: emp.tenantId, items: after }
  })
}

/**
 * Keep the work locations in step when HR changes the Branch Location on the profile: the new branch becomes (or
 * is added as) the primary work location, when it is a live location of the employee's company. Called by the
 * employee save path; never throws on a foreign id (the profile's own reference check owns that).
 */
export async function syncPrimaryWorkLocation(employeeId: string, tenantId: string, locationId: string | null, actorId: string | null): Promise<void> {
  if (!locationId) return
  const loc = await prisma.location.findFirst({ where: { id: locationId, tenantId, deletedAt: null }, select: { id: true } })
  if (!loc) return
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`hr-work-locations:${employeeId}`}))`
    const count = await tx.hrWorkLocation.count({ where: { employeeId } })
    if (count >= MAX_WORK_LOCATIONS && !(await tx.hrWorkLocation.findUnique({ where: { employeeId_locationId: { employeeId, locationId } } }))) return
    await tx.hrWorkLocation.updateMany({ where: { employeeId, NOT: { locationId } }, data: { isPrimary: false } })
    await tx.hrWorkLocation.upsert({
      where: { employeeId_locationId: { employeeId, locationId } },
      create: { tenantId, employeeId, locationId, isPrimary: true, createdById: actorId },
      update: { isPrimary: true },
    })
  })
}
