// Work locations on the employee profile (owner, 2026-10-15: "put employment location into their erp profile …
// make sure i can give staff multiple employment locations"; 2026-10-27: "make work locations a system in which i
// can add multiple pin locations").
//
//   GET /hr/employees/:id/work-locations   the employee's work locations (HR team)
//   PUT /hr/employees/:id/work-locations   replace the set {items:[
//                                             {locationId, radiusMetres?, isPrimary?}                         a company Location
//                                           | {id?, label, latitude, longitude, radiusMetres?, isPrimary?}   a map pin of this employee only
//                                           ]}
//   GET  /hr/work-pins?status=pending      every custom pin of the caller's companies (the approvals inbox reads it)
//   POST /hr/work-pins/:id/approve | reject {latitude, longitude, radiusMetres, note}   the CEO only (work_pin)
//
// A work location is EITHER a Location of the EMPLOYEE's company (422 LOCATION_NOT_IN_COMPANY otherwise) OR a custom
// map pin (one HrWorkLocation row, no new table). Another company's employee is 404. At most 20; exactly one primary
// when the set is not empty. A primary Location is the employee's "Branch Location" (hr_employees.locationId kept in
// step); a primary pin leaves the branch as it was.
//
// A custom pin is measured ONLY from the pin + radius the CEO APPROVED (fence* columns, approval type work_pin —
// the same rule as a Location's pin, lib/approvalRights.ts fencePinPending / workPinPending): a new or moved pin
// waits for the CEO and the old approved one (if any) stays in force meanwhile. The CEO's own add / move is the
// approval. Item `id` names an existing pin of this employee; a pin left out of the set is removed.
// Registered from hr/routes.ts under the /hr prefix — /hr/employees and /hr/work-pins are gated by staff_hr.

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { Prisma, type UserRole } from '@prisma/client'
import { z } from 'zod'
import { serviceClient as prisma } from '../../lib/prisma.js'
import { requireAuth, ADMIN_ONLY } from '../auth/middleware.js'
import { AppError, NotFoundError, ForbiddenError } from '../../lib/errors.js'
import { scopeTenantWhere } from '../../lib/tenantScope.js'
import { audit } from '../../lib/audit.js'
import { approvalInputOf, approvalSubject, assertCanApprove, auditApproval, workPinPending } from '../../lib/approvalRights.js'
import { approvalWaiting } from '../approvals/notify.js'

/** The HR team — the roles that edit HR employees (hr/routes.ts HR_ADMIN). */
const HR_TEAM = ['admin', 'owner', 'management', 'hr'] as UserRole[]
/** Who may edit the employee record linked to their own login (hr/routes.ts SELF_EDITORS). */
const SELF_EDITORS = ['admin', 'owner'] as UserRole[]
export const MAX_WORK_LOCATIONS = 20

const radius = z.number().int().min(10).max(5000).nullable().optional()
const locationItem = z.object({
  locationId: z.string().min(1).max(64),
  radiusMetres: radius,
  isPrimary: z.boolean().optional(),
}).strict()
const pinItem = z.object({
  id: z.string().min(1).max(64).optional(),
  label: z.string().trim().min(1).max(80),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  radiusMetres: radius,
  isPrimary: z.boolean().optional(),
}).strict()
const itemsBody = z.object({ items: z.array(z.union([locationItem, pinItem])).max(MAX_WORK_LOCATIONS) })
type PinItem = z.infer<typeof pinItem>
const isPin = (i: z.infer<typeof locationItem> | PinItem): i is PinItem => 'latitude' in i

const ROW_SELECT = {
  id: true, tenantId: true, employeeId: true, locationId: true, label: true, latitude: true, longitude: true, radiusMetres: true, isPrimary: true,
  fenceLatitude: true, fenceLongitude: true, fenceRadiusMetres: true, fencePinApprovedAt: true, fencePinApprovedById: true, fencePinRejected: true,
  createdAt: true, updatedAt: true,
} as const

type PinRow = Prisma.HrWorkLocationGetPayload<{ select: typeof ROW_SELECT }>

/** A custom pin's state: approved (in force as shown), pending (waiting for the CEO), rejected (turned down). */
export function pinStatus(w: PinRow): 'approved' | 'pending' | 'rejected' {
  if (workPinPending(w)) return 'pending'
  const inForce = w.fenceLatitude === w.latitude && w.fenceLongitude === w.longitude && (w.fenceRadiusMetres ?? null) === (w.radiusMetres ?? null)
  return inForce ? 'approved' : 'rejected'
}

const pinView = (w: PinRow) => ({
  pin: { latitude: w.latitude, longitude: w.longitude, radiusMetres: w.radiusMetres },
  approved: w.fenceLatitude != null ? { latitude: w.fenceLatitude, longitude: w.fenceLongitude, radiusMetres: w.fenceRadiusMetres, at: w.fencePinApprovedAt, byId: w.fencePinApprovedById } : null,
  rejected: (w.fencePinRejected ?? null) as { lat: number; lng: number; radius: number | null; at: string; note: string } | null,
  status: pinStatus(w),
})

/** An employee's work locations, primary first: each a company Location (with whether it has a map pin) or a pin. */
export async function workLocationsOf(employeeId: string, tenantId: string) {
  const rows = await prisma.hrWorkLocation.findMany({
    where: { employeeId, tenantId },
    select: { ...ROW_SELECT, location: { select: { id: true, name: true, latitude: true, longitude: true, geofenceRadiusMetres: true, isActive: true, deletedAt: true } } },
    orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
  })
  return rows.map((r) => r.location
    ? {
        id: r.id, kind: 'location' as const,
        locationId: r.locationId,
        name: r.location.name,
        radiusMetres: r.radiusMetres,
        locationRadiusMetres: r.location.geofenceRadiusMetres,
        isPrimary: r.isPrimary,
        hasPin: r.location.latitude != null && r.location.longitude != null,
        live: r.location.isActive && !r.location.deletedAt,
      }
    : {
        id: r.id, kind: 'pin' as const,
        locationId: null,
        name: r.label ?? 'Map pin',
        label: r.label,
        latitude: r.latitude, longitude: r.longitude,
        radiusMetres: r.radiusMetres,
        isPrimary: r.isPrimary,
        hasPin: r.fenceLatitude != null,
        live: true,
        ...pinView(r),
      })
}

/** What moved on a pin (the live pin, not its label or primary flag). */
const pinMoved = (a: { latitude: number | null; longitude: number | null; radiusMetres: number | null }, b: { latitude: number; longitude: number; radiusMetres?: number | null }) =>
  a.latitude !== b.latitude || a.longitude !== b.longitude || (a.radiusMetres ?? null) !== (b.radiusMetres ?? null)

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
    const isCeo = req.staffUser!.role === 'admin'

    const locItems = body.items.filter((i): i is z.infer<typeof locationItem> => !isPin(i))
    const pinItems = body.items.filter(isPin)
    const ids = locItems.map((i) => i.locationId)
    if (new Set(ids).size !== ids.length) throw new AppError('DUPLICATE_LOCATION', 'A location is listed twice', 400)
    const pinIds = pinItems.map((i) => i.id).filter((x): x is string => !!x)
    if (new Set(pinIds).size !== pinIds.length) throw new AppError('DUPLICATE_LOCATION', 'A map pin is listed twice', 400)
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
    const primaryLocationId = locItems.find((i) => i.isPrimary)?.locationId ?? null
    const now = new Date()
    const moved: string[] = []
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`hr-work-locations:${emp.id}`}))`
      const existingPins = await tx.hrWorkLocation.findMany({ where: { employeeId: emp.id, locationId: null }, select: ROW_SELECT })
      // An id must be one of THIS employee's pins (a foreign or company-Location row id is never trusted).
      const unknown = pinIds.filter((id) => !existingPins.some((p) => p.id === id))
      if (unknown.length) throw new AppError('WORK_PIN_NOT_FOUND', 'A map pin in the list is not one of this employee\'s pins', 422, { ids: unknown })

      await tx.hrWorkLocation.deleteMany({ where: { employeeId: emp.id, locationId: { not: null, notIn: ids } } })
      await tx.hrWorkLocation.deleteMany({ where: { employeeId: emp.id, locationId: null, id: { notIn: pinIds } } })
      for (const i of locItems) {
        await tx.hrWorkLocation.upsert({
          where: { employeeId_locationId: { employeeId: emp.id, locationId: i.locationId } },
          create: { tenantId: emp.tenantId, employeeId: emp.id, locationId: i.locationId, radiusMetres: i.radiusMetres ?? null, isPrimary: !!i.isPrimary, createdById: req.staffUser!.id },
          update: { radiusMetres: i.radiusMetres ?? null, isPrimary: !!i.isPrimary },
        })
      }
      for (const i of pinItems) {
        const cur = i.id ? existingPins.find((p) => p.id === i.id)! : null
        const live = { label: i.label, latitude: i.latitude, longitude: i.longitude, radiusMetres: i.radiusMetres ?? null, isPrimary: !!i.isPrimary }
        const changed = !cur || pinMoved(cur, i)
        // The CEO's own add / move is the approval (there is no one above).
        const ceoApproves = isCeo && changed
          ? { fenceLatitude: i.latitude, fenceLongitude: i.longitude, fenceRadiusMetres: i.radiusMetres ?? null, fencePinApprovedAt: now, fencePinApprovedById: req.staffUser!.id, fencePinRejected: Prisma.DbNull }
          : {}
        const row = cur
          ? await tx.hrWorkLocation.update({ where: { id: cur.id }, data: { ...live, ...ceoApproves }, select: ROW_SELECT })
          : await tx.hrWorkLocation.create({ data: { tenantId: emp.tenantId, employeeId: emp.id, ...live, ...ceoApproves, createdById: req.staffUser!.id }, select: ROW_SELECT })
        if (changed && workPinPending(row)) moved.push(row.id)
      }
      // A primary Location is the employee's Branch Location. A primary pin or an empty set leaves the branch as it
      // was (HR clears it on the profile).
      if (primaryLocationId && primaryLocationId !== emp.locationId) {
        await tx.hrEmployee.update({ where: { id: emp.id }, data: { locationId: primaryLocationId } })
      }
    })
    const after = await workLocationsOf(emp.id, emp.tenantId)
    const auditView = (b: typeof after) => b.map((x) => x.kind === 'location'
      ? { locationId: x.locationId, radiusMetres: x.radiusMetres, isPrimary: x.isPrimary }
      : { pinId: x.id, label: x.label, latitude: x.latitude, longitude: x.longitude, radiusMetres: x.radiusMetres, isPrimary: x.isPrimary, status: x.status })
    await audit({
      category: 'identity', action: 'hr.work_locations.update', entity: 'HrEmployee', entityId: emp.id,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId: emp.tenantId,
      before: { items: auditView(before) }, after: { items: auditView(after) },
    })
    // A new / moved pin waits for the CEO (bell + approvals inbox), queued after the commit.
    for (const id of moved) {
      const w = after.find((x) => x.id === id)
      approvalWaiting('work_pin', id, { round: `${id}:${w && w.kind === 'pin' ? `${w.latitude},${w.longitude},${w.radiusMetres ?? ''}` : ''}:${now.toISOString()}`, actorId: req.staffUser!.id })
    }
    return { employeeId: emp.id, tenantId: emp.tenantId, items: after }
  })

  // ── The CEO's queue of employee work pins (approval type work_pin; the same shape as /locations/fence-pins).
  fastify.get<{ Querystring: { status?: string } }>('/work-pins', { preHandler: requireAuth(...HR_TEAM) }, async (req) => {
    const scope = await scopeTenantWhere(req, 'read')
    const rows = await prisma.hrWorkLocation.findMany({
      where: { ...scope, locationId: null },
      select: { ...ROW_SELECT, employee: { select: { fullName: true, employeeCode: true } } },
      orderBy: { updatedAt: 'asc' },
    })
    const items = rows.map((w) => ({
      id: w.id, tenantId: w.tenantId, employeeId: w.employeeId, employeeName: w.employee.fullName, employeeCode: w.employee.employeeCode,
      label: w.label, updatedAt: w.updatedAt, pending: workPinPending(w), ...pinView(w),
    }))
    return { items: req.query.status === 'pending' ? items.filter((i) => i.pending) : items }
  })

  const pinDecision = z.object({
    // The pin the CEO is looking at: refused (409 PIN_CHANGED) if it has moved since.
    latitude: z.number(), longitude: z.number(), radiusMetres: z.number().int().nullable(),
    note: z.string().trim().max(500).optional(),
  })

  async function pinForDecision(req: FastifyRequest, id: string, body: z.infer<typeof pinDecision>) {
    const w = await prisma.hrWorkLocation.findFirst({ where: { id, locationId: null, ...(await scopeTenantWhere(req, 'write')) }, select: ROW_SELECT })
    if (!w) throw new NotFoundError('Work pin', id)
    const s = await approvalSubject('work_pin', w.id)
    if (!s) throw new NotFoundError('Work pin', id)
    const grant = await assertCanApprove(req, approvalInputOf('work_pin', w.id, s))
    if (!workPinPending(w)) throw new AppError('PIN_NOT_PENDING', 'This map pin is not waiting for approval', 409)
    if (pinMoved(w, body)) throw new AppError('PIN_CHANGED', 'The map pin was changed while you were looking — open it again', 409)
    return { w, grant }
  }

  // POST /hr/work-pins/:id/approve — the CEO approves the pin and radius as they are now.
  fastify.post<{ Params: { id: string } }>('/work-pins/:id/approve', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const body = pinDecision.parse(req.body ?? {})
    const { w, grant } = await pinForDecision(req, req.params.id, body)
    const n = await prisma.hrWorkLocation.updateMany({
      where: { id: w.id, locationId: null, latitude: body.latitude, longitude: body.longitude, radiusMetres: body.radiusMetres },
      data: { fenceLatitude: body.latitude, fenceLongitude: body.longitude, fenceRadiusMetres: body.radiusMetres, fencePinApprovedAt: new Date(), fencePinApprovedById: req.staffUser!.id, fencePinRejected: Prisma.DbNull },
    })
    if (n.count === 0) throw new AppError('PIN_CHANGED', 'The map pin was changed while you were looking — open it again', 409)
    await auditApproval(req, {
      type: 'work_pin', id: w.id, tenantId: w.tenantId, decision: 'approve', grant, entity: 'HrWorkLocation',
      metadata: { employeeId: w.employeeId, label: w.label, latitude: body.latitude, longitude: body.longitude, radiusMetres: body.radiusMetres, before: { latitude: w.fenceLatitude, longitude: w.fenceLongitude, radiusMetres: w.fenceRadiusMetres }, note: body.note ?? null },
    })
    return { id: w.id, approved: true }
  })

  // POST /hr/work-pins/:id/reject {note ≥10} — the CEO turns the new pin down: the approved one (if any) stays in
  // force, and this pin leaves the queue until it is changed again.
  fastify.post<{ Params: { id: string } }>('/work-pins/:id/reject', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const body = pinDecision.extend({ note: z.string().trim().min(10).max(500) }).parse(req.body ?? {})
    const { w, grant } = await pinForDecision(req, req.params.id, body)
    const n = await prisma.hrWorkLocation.updateMany({
      where: { id: w.id, locationId: null, latitude: body.latitude, longitude: body.longitude, radiusMetres: body.radiusMetres },
      data: { fencePinRejected: { lat: body.latitude, lng: body.longitude, radius: body.radiusMetres, at: new Date().toISOString(), byId: req.staffUser!.id, note: body.note } },
    })
    if (n.count === 0) throw new AppError('PIN_CHANGED', 'The map pin was changed while you were looking — open it again', 409)
    await auditApproval(req, {
      type: 'work_pin', id: w.id, tenantId: w.tenantId, decision: 'reject', grant, entity: 'HrWorkLocation',
      metadata: { employeeId: w.employeeId, label: w.label, latitude: body.latitude, longitude: body.longitude, radiusMetres: body.radiusMetres, note: body.note },
    })
    return { id: w.id, rejected: true }
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
    await tx.hrWorkLocation.updateMany({ where: { employeeId, OR: [{ locationId: null }, { NOT: { locationId } }] }, data: { isPrimary: false } })
    await tx.hrWorkLocation.upsert({
      where: { employeeId_locationId: { employeeId, locationId } },
      create: { tenantId, employeeId, locationId, isPrimary: true, createdById: actorId },
      update: { isPrimary: true },
    })
  })
}
