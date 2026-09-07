import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
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
      return prisma.location.update({
        where: { id: existing.id },
        data: { ...rest, tenantId },
        include: conceptInclude,
      })
    },
  )

  // DELETE /locations/:id (soft delete — keeps historical orders/shifts intact)
  fastify.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const existing = await prisma.location.findFirst({
        where: { id: req.params.id, deletedAt: null, tenantId: req.staffUser!.tenantFilter },
        select: { id: true },
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
      return reply.status(204).send()
    },
  )
}
