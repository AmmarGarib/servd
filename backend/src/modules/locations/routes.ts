import type { FastifyInstance, FastifyRequest } from 'fastify'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma, serviceClient } from '../../lib/prisma.js'
import { requireAuth, ALL_STAFF, MANAGERS, ADMIN_ONLY } from '../auth/middleware.js'
import { approvalInputOf, approvalSubject, assertCanApprove, auditApproval, fencePinPending } from '../../lib/approvalRights.js'
import { approvalWaiting } from '../approvals/notify.js'
import { audit } from '../../lib/audit.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { resolveTenantScope, tenantWhere, scopeTenantWhere } from '../../lib/tenantScope.js'
import { moveToTrash, trashReasonOf } from '../../lib/trash.js'
import { TRASH_COMPANY, locationEverUsed } from '../trash/providers/masters/company.js'
import { publicBrandWhere } from '../../lib/publicBrands.js'

function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)
}

// Locations are company master data (Location.tenantId). Every read here is
// scoped to the operator's active company (or every company they belong to
// in "All companies" view), every write pins the row to one company, and a
// location may only link brands that belong to that same company. Without
// the last rule GS Foods' Bukhari kitchen could carry a GSX Viva brand chip —
// the exact overlap the Locations page used to show.

/**
 * Throws unless every id in `conceptIds` is a live brand of `tenantId`.
 * Returns the ids deduped. Used by both create and update so a stale or
 * cross-company brand id can never be linked to a location.
 */
async function assertConceptsBelongTo(tenantId: string, conceptIds: string[]): Promise<string[]> {
  const ids = Array.from(new Set(conceptIds))
  if (ids.length === 0) return ids
  const owned = await prisma.concept.findMany({
    where: { id: { in: ids }, tenantId, deletedAt: null },
    select: { id: true },
  })
  if (owned.length !== ids.length) {
    throw new AppError('BRAND_NOT_IN_COMPANY', 'One or more brands do not belong to this company', 422)
  }
  return ids
}

/**
 * Keep each brand's Concept.address / latitude / longitude a read-only
 * mirror of its primary Location (owner decision 18: the address and map pin
 * belong to the physical kitchen; phone and WhatsApp stay per brand).
 *
 * Why a mirror rather than moving every reader: the storefront NAP, JSON-LD,
 * the delivery-quote origin and the brand list all read those Concept
 * columns. Mirroring means they now show the Location's values without each
 * reader having to learn about ConceptLocation, and no editor writes the
 * Concept copy any more (PATCH /concepts rejects those fields).
 *
 * "Primary location" for a brand: the link flagged isPrimary, else the oldest
 * link — to an active, non-deleted location. A value the Location does not
 * have yet (no address typed, no pin dropped) leaves the brand's existing
 * value alone, so a half-filled location never blanks a live storefront.
 */
export async function syncConceptLocationMirror(
  conceptIds: string[],
  // A transaction that just changed the links (the Trash's location restore)
  // passes itself, so the mirror reads its own uncommitted links.
  db: Prisma.TransactionClient | typeof serviceClient = serviceClient,
): Promise<void> {
  const ids = Array.from(new Set(conceptIds))
  for (const conceptId of ids) {
    const link = await db.conceptLocation.findFirst({
      where: { conceptId, location: { deletedAt: null, isActive: true } },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
      select: { location: { select: { address: true, latitude: true, longitude: true } } },
    })
    const loc = link?.location
    if (!loc) continue
    const data: { address?: string; latitude?: number; longitude?: number } = {}
    if (loc.address && loc.address.trim()) data.address = loc.address.trim()
    if (loc.latitude != null && loc.longitude != null) { data.latitude = loc.latitude; data.longitude = loc.longitude }
    if (Object.keys(data).length === 0) continue
    await db.concept.updateMany({ where: { id: conceptId, deletedAt: null }, data })
  }
}

const conceptInclude = {
  concepts: {
    include: { concept: { select: { id: true, name: true, slug: true } } },
    orderBy: [{ isPrimary: 'desc' as const }, { createdAt: 'asc' as const }],
  },
}

const PIN_SELECT = {
  id: true, latitude: true, longitude: true, geofenceRadiusMetres: true,
  fenceLatitude: true, fenceLongitude: true, fenceRadiusMetres: true, fencePinRejected: true,
} as const

/**
 * After a location's pin or radius changes: the CEO's own edit is the approval (there is no one above); anyone else's
 * waits for the CEO (bell + approvals inbox). Never throws into the save.
 */
async function afterPinChange(req: FastifyRequest, id: string) {
  try {
    const l = await prisma.location.findUnique({ where: { id }, select: { ...PIN_SELECT, tenantId: true, updatedAt: true } })
    if (!l || !fencePinPending(l)) return
    if (req.staffUser!.role === 'admin') {
      await prisma.location.update({
        where: { id },
        data: { fenceLatitude: l.latitude, fenceLongitude: l.longitude, fenceRadiusMetres: l.geofenceRadiusMetres, fencePinApprovedAt: new Date(), fencePinApprovedById: req.staffUser!.id, fencePinRejected: Prisma.DbNull },
      })
      await audit({
        category: 'identity', action: 'location.fence_pin.approve', entity: 'Location', entityId: id, userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId: l.tenantId,
        metadata: { latitude: l.latitude, longitude: l.longitude, radiusMetres: l.geofenceRadiusMetres, via: 'ceo_edit' },
      })
      return
    }
    approvalWaiting('location_pin', id, { round: l.updatedAt.toISOString(), actorId: req.staffUser!.id })
  } catch (err) {
    console.warn('[locations] pin approval hook failed:', (err as Error).message)
  }
}

export async function locationRoutes(fastify: FastifyInstance) {
  // GET /locations — this company's locations (portfolio view: every company
  // the operator belongs to). Brand chips are restricted to brands of the
  // location's own company so a stale cross-company link can never surface.
  fastify.get('/', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const scope = await resolveTenantScope(req)
    if (scope.tenantIds.length === 0) return []
    return prisma.location.findMany({
      where: { deletedAt: null, ...tenantWhere(scope) },
      include: {
        concepts: {
          where: { concept: { deletedAt: null, ...tenantWhere(scope) } },
          include: { concept: { select: { id: true, name: true, slug: true, tenantId: true } } },
          orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
        },
        _count: { select: { orders: true, shifts: true } },
        ...(scope.portfolio ? { tenant: { select: { id: true, name: true, slug: true } } } : {}),
      },
      orderBy: { name: 'asc' },
    })
  })

  // GET /locations/public?brand=<slug> — the storefront's view of where a
  // brand is: its active linked kitchens, primary first. Public (it is the
  // address on the shop door), so only public fields are returned — never the
  // company, counts or the kitchen's internal phone line (a brand's public
  // phone and WhatsApp are on the brand, decision 18).
  fastify.get<{ Querystring: { brand?: string } }>('/public', async (req, reply) => {
    const slug = (req.query.brand ?? '').trim().toLowerCase()
    if (!slug) return reply.status(400).send({ error: { code: 'BRAND_REQUIRED', message: 'brand is required' } })
    const concept = await serviceClient.concept.findFirst({
      where: { slug, deletedAt: null, isActive: true, storefrontVisible: true, ...publicBrandWhere() },
      select: { id: true },
    })
    if (!concept) return []
    const links = await serviceClient.conceptLocation.findMany({
      where: { conceptId: concept.id, location: { deletedAt: null, isActive: true } },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
      select: {
        isPrimary: true,
        location: { select: { slug: true, name: true, address: true, city: true, latitude: true, longitude: true } },
      },
    })
    reply.header('cache-control', 'public, max-age=60')
    return links.map((l, i) => ({ ...l.location, isPrimary: i === 0 }))
  })

  // POST /locations — create a new physical location in the active company
  fastify.post('/', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = z.object({
      name:    z.string().min(1).max(100),
      address: z.string().max(500).optional(),
      city:    z.string().max(100).optional(),
      phone:   z.string().max(50).optional(),
      latitude:  z.number().nullable().optional(),
      longitude: z.number().nullable().optional(),
      geofenceRadiusMetres: z.number().int().min(10).max(5000).nullable().optional(),
      isActive:  z.boolean().optional(),
      conceptIds: z.array(z.string().uuid()).default([]),
    }).parse(req.body)

    const tenantId = req.staffUser!.tenantId
    if (!tenantId) throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company before adding a location', 422)
    const conceptIds = await assertConceptsBelongTo(tenantId, body.conceptIds)

    let slug = slugify(body.name) || 'location'
    let i = 1
    while (await prisma.location.findUnique({ where: { slug } })) {
      i++; slug = `${slugify(body.name)}-${i}`
    }

    const location = await prisma.location.create({
      data: {
        slug, name: body.name, address: body.address, city: body.city,
        phone: body.phone, latitude: body.latitude, longitude: body.longitude,
        geofenceRadiusMetres: body.geofenceRadiusMetres ?? null,
        isActive: body.isActive ?? true,
        tenantId,
        // First linked brand becomes the primary — it's what orders fall
        // back to when they don't name a location.
        concepts: { create: conceptIds.map((cid, idx) => ({ conceptId: cid, isPrimary: idx === 0 })) },
      },
      include: conceptInclude,
    })
    await syncConceptLocationMirror(conceptIds)
    await afterPinChange(req, location.id)
    return reply.status(201).send(location)
  })

  // PATCH /locations/:id — must belong to a company the operator is in
  fastify.patch<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const body = z.object({
        name:     z.string().min(1).max(100).optional(),
        address:  z.string().max(500).optional(),
        city:     z.string().max(100).optional(),
        phone:    z.string().max(50).optional(),
        latitude:  z.number().nullable().optional(),
        longitude: z.number().nullable().optional(),
        geofenceRadiusMetres: z.number().int().min(10).max(5000).nullable().optional(),
        isActive: z.boolean().optional(),
        conceptIds: z.array(z.string().uuid()).optional(),
      }).parse(req.body)

      // tenantFilter on a non-GET expands to every company the operator
      // belongs to, so a head-office manager can edit either kitchen.
      const existing = await prisma.location.findFirst({
        where: { id: req.params.id, deletedAt: null, tenantId: req.staffUser!.tenantFilter },
      })
      if (!existing) throw new NotFoundError('Location', req.params.id)

      // Legacy rows predating the tenant column: claim for the active company
      // on first edit. The migration backfills these, so this is a belt.
      const tenantId = existing.tenantId ?? req.staffUser!.tenantId
      if (!tenantId) throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company before editing a location', 422)

      const previouslyLinked = (await prisma.conceptLocation.findMany({
        where: { locationId: existing.id }, select: { conceptId: true },
      })).map((l) => l.conceptId)

      // Sync brand links if provided — only brands of the same company.
      if (body.conceptIds) {
        const conceptIds = await assertConceptsBelongTo(tenantId, body.conceptIds)
        const keepPrimary = await prisma.conceptLocation.findFirst({
          where: { locationId: existing.id, isPrimary: true, conceptId: { in: conceptIds } },
          select: { conceptId: true },
        })
        const primaryId = keepPrimary?.conceptId ?? conceptIds[0]
        await prisma.$transaction([
          prisma.conceptLocation.deleteMany({ where: { locationId: existing.id } }),
          prisma.conceptLocation.createMany({
            data: conceptIds.map((cid) => ({ conceptId: cid, locationId: existing.id, isPrimary: cid === primaryId })),
            skipDuplicates: true,
          }),
        ])
      }

      const { conceptIds: _ignored, ...rest } = body
      void _ignored
      const updated = await prisma.location.update({
        where: { id: existing.id },
        data: { ...rest, tenantId },
        include: conceptInclude,
      })
      // The brands linked now, plus any just unlinked (their primary kitchen
      // may have changed to another location).
      await syncConceptLocationMirror([...updated.concepts.map((c) => c.conceptId), ...previouslyLinked])
      await afterPinChange(req, updated.id)
      return updated
    },
  )

  // ── Time-clock map pins (owner's card, 2026-10-22: "each location gets a map pin and a radius, approved by the
  // CEO"). The time clock measures from the APPROVED pin (Location.fence*); an edited pin waits here and the old
  // approved one stays in force meanwhile. Approval type location_pin: the CEO only, never handed over.

  // GET /locations/fence-pins — every located location of the caller's companies with its live and approved pin;
  // ?status=pending = only those waiting for the CEO (the approvals inbox reads this).
  fastify.get<{ Querystring: { status?: string } }>('/fence-pins', { preHandler: requireAuth(...MANAGERS, 'hr') }, async (req) => {
    const scope = await scopeTenantWhere(req, 'read')
    const rows = await prisma.location.findMany({
      where: { deletedAt: null, ...scope, latitude: { not: null }, longitude: { not: null } },
      select: { ...PIN_SELECT, name: true, tenantId: true, updatedAt: true, fencePinApprovedAt: true, fencePinApprovedById: true },
      orderBy: { name: 'asc' },
    })
    const items = rows.map((l) => ({
      id: l.id, name: l.name, tenantId: l.tenantId, updatedAt: l.updatedAt,
      pin: { latitude: l.latitude, longitude: l.longitude, radiusMetres: l.geofenceRadiusMetres },
      approved: l.fenceLatitude != null ? { latitude: l.fenceLatitude, longitude: l.fenceLongitude, radiusMetres: l.fenceRadiusMetres, at: l.fencePinApprovedAt, byId: l.fencePinApprovedById } : null,
      rejected: l.fencePinRejected ?? null,
      pending: fencePinPending(l),
    }))
    return { items: req.query.status === 'pending' ? items.filter((i) => i.pending) : items }
  })

  const pinDecision = z.object({
    // The pin the CEO is looking at: refused (409 PIN_CHANGED) if it has moved since.
    latitude: z.number(), longitude: z.number(), radiusMetres: z.number().int().nullable(),
    note: z.string().trim().max(500).optional(),
  })

  async function pinForDecision(req: FastifyRequest, id: string, body: z.infer<typeof pinDecision>) {
    const l = await prisma.location.findFirst({ where: { id, deletedAt: null, ...(await scopeTenantWhere(req, 'write')) }, select: { ...PIN_SELECT, tenantId: true, updatedAt: true } })
    if (!l || !l.tenantId) throw new NotFoundError('Location', id)
    const s = await approvalSubject('location_pin', l.id)
    if (!s) throw new NotFoundError('Location', id)
    const grant = await assertCanApprove(req, approvalInputOf('location_pin', l.id, s))
    if (!fencePinPending(l)) throw new AppError('PIN_NOT_PENDING', 'This map pin is not waiting for approval', 409)
    if (l.latitude !== body.latitude || l.longitude !== body.longitude || (l.geofenceRadiusMetres ?? null) !== body.radiusMetres) {
      throw new AppError('PIN_CHANGED', 'The map pin was changed while you were looking — open it again', 409)
    }
    return { l, grant }
  }

  // POST /locations/:id/fence-pin/approve — the CEO approves the pin and radius as they are now.
  fastify.post<{ Params: { id: string } }>('/:id/fence-pin/approve', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const body = pinDecision.parse(req.body ?? {})
    const { l, grant } = await pinForDecision(req, req.params.id, body)
    const n = await prisma.location.updateMany({
      where: { id: l.id, latitude: body.latitude, longitude: body.longitude, geofenceRadiusMetres: body.radiusMetres },
      data: { fenceLatitude: body.latitude, fenceLongitude: body.longitude, fenceRadiusMetres: body.radiusMetres, fencePinApprovedAt: new Date(), fencePinApprovedById: req.staffUser!.id, fencePinRejected: Prisma.DbNull },
    })
    if (n.count === 0) throw new AppError('PIN_CHANGED', 'The map pin was changed while you were looking — open it again', 409)
    await auditApproval(req, {
      type: 'location_pin', id: l.id, tenantId: l.tenantId, decision: 'approve', grant, entity: 'Location',
      metadata: { latitude: body.latitude, longitude: body.longitude, radiusMetres: body.radiusMetres, before: { latitude: l.fenceLatitude, longitude: l.fenceLongitude, radiusMetres: l.fenceRadiusMetres }, note: body.note ?? null },
    })
    return { id: l.id, approved: true }
  })

  // POST /locations/:id/fence-pin/reject {note} — the CEO turns the new pin down: the approved one stays in force,
  // and this pin leaves the queue until it is changed again.
  fastify.post<{ Params: { id: string } }>('/:id/fence-pin/reject', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const body = pinDecision.extend({ note: z.string().trim().min(3).max(500) }).parse(req.body ?? {})
    const { l, grant } = await pinForDecision(req, req.params.id, body)
    const n = await prisma.location.updateMany({
      where: { id: l.id, latitude: body.latitude, longitude: body.longitude, geofenceRadiusMetres: body.radiusMetres },
      data: { fencePinRejected: { lat: body.latitude, lng: body.longitude, radius: body.radiusMetres, at: new Date().toISOString(), byId: req.staffUser!.id, note: body.note } },
    })
    if (n.count === 0) throw new AppError('PIN_CHANGED', 'The map pin was changed while you were looking — open it again', 409)
    await auditApproval(req, {
      type: 'location_pin', id: l.id, tenantId: l.tenantId, decision: 'reject', grant, entity: 'Location',
      metadata: { latitude: body.latitude, longitude: body.longitude, radiusMetres: body.radiusMetres, note: body.note },
    })
    return { id: l.id, rejected: true }
  })

  // DELETE /locations/:id (soft delete — keeps historical orders/shifts intact)
  fastify.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const existing = await serviceClient.location.findFirst({
        where: { id: req.params.id, deletedAt: null, ...(await scopeTenantWhere(req, 'write')) },
        select: { id: true, name: true, city: true, tenantId: true, concepts: { select: { conceptId: true, isPrimary: true } } },
      })
      if (!existing) throw new NotFoundError('Location', req.params.id)

      // To the Trash (type `location`): the brand links are kept in the entry
      // so a restore can put them back (same company, live brands only).
      await serviceClient.$transaction(async (tx) => {
        await moveToTrash(tx, req, {
          type: TRASH_COMPANY.location, entityId: existing.id, tenantId: existing.tenantId,
          title: existing.name, subtitle: existing.city ?? null, reason: trashReasonOf(req),
          meta: {
            brandLinks: existing.concepts.map((c) => ({ conceptId: c.conceptId, isPrimary: c.isPrimary })),
            everUsed: await locationEverUsed(tx, existing.id),
          },
        })
        // Unlink brands so the location stops being a candidate anywhere
        // (nearest-branch picker, order fallback) — the row itself stays.
        await tx.conceptLocation.deleteMany({ where: { locationId: existing.id } })
        await tx.location.update({
          where: { id: existing.id },
          data: { deletedAt: new Date(), isActive: false },
        })
      })
      // Brands that were here fall back to their next kitchen, if any.
      await syncConceptLocationMirror(existing.concepts.map((c) => c.conceptId))
      return reply.status(204).send()
    },
  )
}
