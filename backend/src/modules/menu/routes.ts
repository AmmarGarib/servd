import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS, ADMIN_ONLY, ALL_STAFF } from '../auth/middleware.js'
import { NotFoundError } from '../../lib/errors.js'
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
  timeRestrictionStart: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  timeRestrictionEnd: z.string().regex(/^\d{2}:\d{2}$/).optional(),
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

export async function menuRoutes(fastify: FastifyInstance) {
  // GET /menu/:conceptId — full menu tree (staff/internal only)
  fastify.get<{ Params: { conceptId: string } }>(
    '/:conceptId',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req, reply) => {
      // Tenant scope: requested concept must belong to the active tenant.
      const concept = await prisma.concept.findFirst({
        where: { id: req.params.conceptId, tenantId: req.staffUser!.tenantId, deletedAt: null },
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
          concept: { tenantId: req.staffUser!.tenantId, deletedAt: null },
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

  // POST /menu/items — verify the concept belongs to the active tenant
  fastify.post('/items', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = createItemSchema.parse(req.body)
    const concept = await prisma.concept.findFirst({
      where: { id: body.conceptId, tenantId: req.staffUser!.tenantId, deletedAt: null },
    })
    if (!concept) return reply.status(403).send({ error: { code: 'CROSS_TENANT', message: 'Concept does not belong to your active company' } })
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
          concept: { tenantId: req.staffUser!.tenantId, deletedAt: null },
        },
      })
      if (!item) throw new NotFoundError('MenuItem', req.params.id)
      const updated = await prisma.menuItem.update({ where: { id: req.params.id }, data: body })
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
          concept: { tenantId: req.staffUser!.tenantId, deletedAt: null },
        },
      })
      if (!item) throw new NotFoundError('MenuItem', req.params.id)

      const updated = await prisma.menuItem.update({
        where: { id: req.params.id },
        data: { isAvailable },
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
          concept: { tenantId: req.staffUser!.tenantId, deletedAt: null },
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
    const concept = await prisma.concept.findFirst({
      where: { id: body.conceptId, tenantId: req.staffUser!.tenantId, deletedAt: null },
    })
    if (!concept) return reply.status(403).send({ error: { code: 'CROSS_TENANT', message: 'Concept does not belong to your active company' } })
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
          concept: { tenantId: req.staffUser!.tenantId, deletedAt: null },
        },
      })
      if (!owned) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Category not found in your active company' } })
      return prisma.category.update({ where: { id: req.params.id }, data: body })
    },
  )

  // ─── Modifier groups ───────────────────────────────────────────────────────

  fastify.post('/modifier-groups', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = createModifierGroupSchema.parse(req.body)
    const ownedItem = await prisma.menuItem.findFirst({
      where: {
        id: body.menuItemId,
        deletedAt: null,
        concept: { tenantId: req.staffUser!.tenantId, deletedAt: null },
      },
    })
    if (!ownedItem) return reply.status(403).send({ error: { code: 'CROSS_TENANT', message: 'Menu item does not belong to your active company' } })
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
          menuItem: { concept: { tenantId: req.staffUser!.tenantId, deletedAt: null } },
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

  // ─── Image upload URL ─────────────────────────────────────────────────────
  // Returns a presigned S3 URL for direct browser → R2 upload

  fastify.get<{ Querystring: { filename: string; contentType: string } }>(
    '/items/upload-url',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const { filename, contentType } = req.query
      // Dynamic import to avoid startup cost when R2 not configured
      const { getSignedUploadUrl } = await import('../../lib/storage.js')
      return getSignedUploadUrl(filename, contentType)
    },
  )
}
