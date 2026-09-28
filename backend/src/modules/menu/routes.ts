import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS, ADMIN_ONLY, ALL_STAFF } from '../auth/middleware.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { assertConceptOwned } from '../../lib/tenantScope.js'
import { emitItem86d } from '../../lib/ws.js'
import { seedAvailability } from '../../lib/reservation.js'

const createItemSchema = z.object({
  conceptId: z.string().uuid(),
  categoryId: z.string().uuid(),
  name: z.string().min(1),
  nameUrdu: z.string().optional(),
  description: z.string().optional(),
  instructions: z.string().optional(),
  instructionsUrdu: z.string().optional(),
  priceCents: z.number().int().min(0),
  imageUrl: z.string().url().optional(),
  // Looping video shown in place of the image on the storefront menu.
  // Both fields are independent — operator can set either, neither, or
  // both (storefront prefers video). Either MP4 or WebM is fine; .mov
  // / proprietary formats won't autoplay in mobile Safari.
  videoUrl: z.string().url().optional(),
  isAvailable: z.boolean().default(true),
  displayOrder: z.number().int().default(0),
  stationId: z.string().uuid().nullable().optional(),
  portionsAvailable: z.number().int().min(0).nullable().optional(),
  taxClassification: z.enum(['standard', 'zero_rated', 'exempt', 'custom']).optional(),
  overrideTaxRate: z.number().min(0).max(100).nullable().optional(),
  allergens:  z.array(z.string().max(40)).max(20).optional(),
  dietary:    z.array(z.string().max(40)).max(20).optional(),
  spiceLevel: z.number().int().min(0).max(5).nullable().optional(),
})

const updateItemSchema = createItemSchema.partial()

const createCategorySchema = z.object({
  conceptId: z.string().uuid(),
  name: z.string().min(1),
  sortOrder: z.number().int().default(0),
  timeRestrictionStart: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  timeRestrictionEnd: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
})

const createModifierGroupSchema = z.object({
  menuItemId: z.string().uuid(),
  name: z.string().min(1),
  minSelect: z.number().int().min(0).default(0),
  maxSelect: z.number().int().min(1).default(1),
  isRequired: z.boolean().default(false),
  sortOrder: z.number().int().default(0),
  modifiers: z.array(
    z.object({
      name: z.string().min(1),
      priceDeltaCents: z.number().int().default(0),
      isDefault: z.boolean().default(false),
      sortOrder: z.number().int().default(0),
    }),
  ),
})

// ── Brand integrity ──────────────────────────────────────────────────────────
// A menu item lives under ONE brand, and its category and station must be that
// brand's own. The item/category schemas used to be written straight through,
// so a PATCH could move an item (or a category) into another company's brand,
// or point it at a foreign category or station.

/** 422 unless `categoryId` is a live category of `conceptId`. */
async function assertCategoryOf(conceptId: string, categoryId: string): Promise<void> {
  const cat = await prisma.category.findFirst({
    where: { id: categoryId, conceptId, deletedAt: null },
    select: { id: true },
  })
  if (!cat) throw new AppError('CATEGORY_NOT_IN_BRAND', 'That category is not part of this brand', 422)
}

/** 422 unless `stationId` is a live station of `conceptId`. */
async function assertStationOf(conceptId: string, stationId: string): Promise<void> {
  const st = await prisma.station.findFirst({
    where: { id: stationId, conceptId, deletedAt: null },
    select: { id: true },
  })
  if (!st) throw new AppError('STATION_NOT_IN_BRAND', 'That station is not part of this brand', 422)
}

/** A row's brand never changes from an edit; resending the same id is fine. */
function assertSameConcept(current: string, requested: string | undefined): void {
  if (requested !== undefined && requested !== current) {
    throw new AppError('CONCEPT_IMMUTABLE', 'An item or category cannot be moved to another brand — create it there instead', 422)
  }
}

export async function menuRoutes(fastify: FastifyInstance) {
  // GET /menu/:conceptId — full menu tree (staff/internal only)
  fastify.get<{ Params: { conceptId: string } }>(
    '/:conceptId',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req, reply) => {
      // Tenant scope: requested concept must belong to the active tenant.
      const concept = await prisma.concept.findFirst({
        where: { id: req.params.conceptId, tenantId: req.staffUser!.tenantFilter, deletedAt: null },
      })
      if (!concept) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Concept not found in your active company' } })
      const categories = await prisma.category.findMany({
        where: { conceptId: req.params.conceptId, deletedAt: null, isActive: true },
        orderBy: { sortOrder: 'asc' },
        include: {
          items: {
            where: { deletedAt: null },
            orderBy: { displayOrder: 'asc' },
            include: {
              modifierGroups: {
                where: { deletedAt: null },
                orderBy: { sortOrder: 'asc' },
                include: {
                  modifiers: {
                    where: { deletedAt: null },
                    orderBy: { sortOrder: 'asc' },
                  },
                },
              },
            },
          },
        },
      })
      return categories
    },
  )

  // GET /menu/items — flat list for internal tools (recipe builder etc.)
  fastify.get<{ Querystring: { conceptId?: string } }>(
    '/items',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      return prisma.menuItem.findMany({
        where: {
          deletedAt: null,
          // Tenant scope via concept relation
          concept: { tenantId: req.staffUser!.tenantFilter, deletedAt: null },
          ...(req.query.conceptId && { conceptId: req.query.conceptId }),
        },
        select: {
          id: true,
          name: true,
          priceCents: true,
          conceptId: true,
          concept: { select: { name: true } },
        },
        orderBy: [{ conceptId: 'asc' }, { name: 'asc' }],
      })
    },
  )

  // POST /menu/items — the brand must be one of the ACTIVE company's, and the
  // category and station must be that brand's.
  fastify.post('/items', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = createItemSchema.parse(req.body)
    await assertConceptOwned(req, body.conceptId, 'create')
    await assertCategoryOf(body.conceptId, body.categoryId)
    if (body.stationId) await assertStationOf(body.conceptId, body.stationId)
    const item = await prisma.menuItem.create({ data: body })
    return reply.status(201).send(item)
  })

  // PATCH /menu/items/:id
  fastify.patch<{ Params: { id: string } }>(
    '/items/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const body = updateItemSchema.parse(req.body)
      const item = await prisma.menuItem.findFirst({
        where: {
          id: req.params.id,
          deletedAt: null,
          concept: { tenantId: req.staffUser!.tenantFilter, deletedAt: null },
        },
      })
      if (!item) throw new NotFoundError('MenuItem', req.params.id)
      // The item stays under its brand; a new category or station must be
      // that brand's own.
      const { conceptId, ...data } = body
      assertSameConcept(item.conceptId, conceptId)
      if (data.categoryId) await assertCategoryOf(item.conceptId, data.categoryId)
      if (data.stationId) await assertStationOf(item.conceptId, data.stationId)
      const updated = await prisma.menuItem.update({ where: { id: req.params.id }, data })
      // Seed Redis availability whenever portionsAvailable is set
      if (typeof body.portionsAvailable === 'number') {
        await seedAvailability(req.params.id, body.portionsAvailable)
      }
      return updated
    },
  )

  // PATCH /menu/items/:id/availability — 86 an item
  fastify.patch<{ Params: { id: string }; Body: { isAvailable: boolean } }>(
    '/items/:id/availability',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const { isAvailable } = z.object({ isAvailable: z.boolean() }).parse(req.body)
      const item = await prisma.menuItem.findFirst({
        where: {
          id: req.params.id,
          deletedAt: null,
          concept: { tenantId: req.staffUser!.tenantFilter, deletedAt: null },
        },
      })
      if (!item) throw new NotFoundError('MenuItem', req.params.id)

      const updated = await prisma.menuItem.update({
        where: { id: req.params.id },
        data: {
          isAvailable,
          // Clear sync timestamp so the inventorySync worker picks up the
          // change on its next tick (both directions — 86 and un-86).
          lastSyncedAt: null,
        },
      })

      // Broadcast 86 event to all KDS clients
      emitItem86d(item.id, item.conceptId, isAvailable)

      return updated
    },
  )

  // DELETE /menu/items/:id
  fastify.delete<{ Params: { id: string } }>(
    '/items/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const owned = await prisma.menuItem.findFirst({
        where: {
          id: req.params.id,
          deletedAt: null,
          concept: { tenantId: req.staffUser!.tenantFilter, deletedAt: null },
        },
      })
      if (!owned) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Item not found in your active company' } })
      await prisma.menuItem.update({
        where: { id: req.params.id },
        data: { deletedAt: new Date() },
      })
      return reply.status(204).send()
    },
  )

  // ─── Categories ────────────────────────────────────────────────────────────

  fastify.post('/categories', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = createCategorySchema.parse(req.body)
    // CREATE pins to the operator's ACTIVE company; PATCH/DELETE on existing
    // rows below use memberTenantIds because the operator might be editing a
    // row in a company that isn't their primary (head-office staff servicing
    // multiple restaurants — common pattern for procurement + finance).
    await assertConceptOwned(req, body.conceptId, 'create')
    const category = await prisma.category.create({ data: body })
    return reply.status(201).send(category)
  })

  fastify.patch<{ Params: { id: string } }>(
    '/categories/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const body = createCategorySchema.partial().parse(req.body)
      const owned = await prisma.category.findFirst({
        where: {
          id: req.params.id,
          deletedAt: null,
          concept: { tenantId: { in: req.staffUser!.memberTenantIds }, deletedAt: null },
        },
      })
      if (!owned) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Category not found in a company you have access to' } })
      const { conceptId, ...data } = body
      assertSameConcept(owned.conceptId, conceptId)
      return prisma.category.update({ where: { id: req.params.id }, data })
    },
  )

  // DELETE /menu/categories/:id — soft-delete a category. Refuses if the
  // category still has live menu items so the operator clears them first
  // (otherwise the storefront would show orphans). Soft-deletes any items
  // ALREADY soft-deleted are ignored — we only count active items.
  fastify.delete<{ Params: { id: string } }>(
    '/categories/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const owned = await prisma.category.findFirst({
        where: {
          id: req.params.id,
          deletedAt: null,
          concept: { tenantId: { in: req.staffUser!.memberTenantIds }, deletedAt: null },
        },
        include: { _count: { select: { items: { where: { deletedAt: null } } } } },
      })
      if (!owned) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Category not found in a company you have access to' } })
      if (owned._count.items > 0) {
        return reply.status(409).send({ error: {
          code: 'CATEGORY_NOT_EMPTY',
          message: `Delete or move the ${owned._count.items} item(s) in this category first.`,
        }})
      }
      await prisma.category.update({ where: { id: req.params.id }, data: { deletedAt: new Date() } })
      return reply.status(204).send()
    },
  )

  // ─── Modifier groups ───────────────────────────────────────────────────────

  fastify.post('/modifier-groups', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = createModifierGroupSchema.parse(req.body)
    const ownedItem = await prisma.menuItem.findFirst({
      where: {
        id: body.menuItemId,
        deletedAt: null,
        concept: { tenantId: req.staffUser!.tenantFilter, deletedAt: null },
      },
    })
    if (!ownedItem) throw new NotFoundError('MenuItem', body.menuItemId)
    const { modifiers, ...groupData } = body
    const group = await prisma.modifierGroup.create({
      data: { ...groupData, modifiers: { create: modifiers } },
      include: { modifiers: true },
    })
    return reply.status(201).send(group)
  })

  fastify.delete<{ Params: { id: string } }>(
    '/modifier-groups/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const owned = await prisma.modifierGroup.findFirst({
        where: {
          id: req.params.id,
          deletedAt: null,
          menuItem: { concept: { tenantId: req.staffUser!.tenantFilter, deletedAt: null } },
        },
      })
      if (!owned) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Modifier group not found in your active company' } })
      await prisma.modifierGroup.update({
        where: { id: req.params.id },
        data: { deletedAt: new Date() },
      })
      return reply.status(204).send()
    },
  )

}
