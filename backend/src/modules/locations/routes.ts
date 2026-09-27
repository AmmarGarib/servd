import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma, serviceClient } from '../../lib/prisma.js'
import { requireAuth, ALL_STAFF, MANAGERS } from '../auth/middleware.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { resolveTenantScope, tenantWhere } from '../../lib/tenantScope.js'

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
export async function syncConceptLocationMirror(conceptIds: string[]): Promise<void> {
  const ids = Array.from(new Set(conceptIds))
  for (const conceptId of ids) {
    const link = await serviceClient.conceptLocation.findFirst({
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
    await serviceClient.concept.updateMany({ where: { id: conceptId, deletedAt: null }, data })
  }
}

const conceptInclude = {
  concepts: {
    include: { concept: { select: { id: true, name: true, slug: true } } },
    orderBy: [{ isPrimary: 'desc' as const }, { createdAt: 'asc' as const }],
  },
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
      where: { slug, deletedAt: null, isActive: true, storefrontVisible: true },
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
        isActive: body.isActive ?? true,
        tenantId,
        // First linked brand becomes the primary — it's what orders fall
        // back to when they don't name a location.
        concepts: { create: conceptIds.map((cid, idx) => ({ conceptId: cid, isPrimary: idx === 0 })) },
      },
      include: conceptInclude,
    })
    await syncConceptLocationMirror(conceptIds)
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
      return updated
    },
  )

  // DELETE /locations/:id (soft delete — keeps historical orders/shifts intact)
  fastify.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const existing = await prisma.location.findFirst({
        where: { id: req.params.id, deletedAt: null, tenantId: req.staffUser!.tenantFilter },
        select: { id: true, concepts: { select: { conceptId: true } } },
      })
      if (!existing) throw new NotFoundError('Location', req.params.id)

      await prisma.$transaction([
        // Unlink brands so the location stops being a candidate anywhere
        // (nearest-branch picker, order fallback) — the row itself stays.
        prisma.conceptLocation.deleteMany({ where: { locationId: existing.id } }),
        prisma.location.update({
          where: { id: existing.id },
          data: { deletedAt: new Date(), isActive: false },
        }),
      ])
      // Brands that were here fall back to their next kitchen, if any.
      await syncConceptLocationMirror(existing.concepts.map((c) => c.conceptId))
      return reply.status(204).send()
    },
  )
}
