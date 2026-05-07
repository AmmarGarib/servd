// Component library — master file of preps / sauces / sub-recipes built from
// raw ingredients. Filter by ingredient, type (hero/supporting/trim_waste),
// or season. CRUD per component, plus brand-use tagging.

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS, ALL_STAFF } from '../auth/middleware.js'
import { NotFoundError } from '../../lib/errors.js'

const COMPONENT_TYPES = ['hero', 'supporting', 'trim_waste'] as const
const SEASONS = ['spring', 'summer', 'monsoon', 'autumn', 'winter', 'ramadan', 'year-round'] as const

const componentInput = z.object({
  name:             z.string().min(1).max(120),
  type:             z.enum(COMPONENT_TYPES),
  baseIngredientId: z.string().uuid().nullable().optional(),
  description:      z.string().max(500).nullable().optional(),
  preparation:      z.string().nullable().optional(),
  seasons:          z.array(z.enum(SEASONS)).default([]),
  yieldGrams:       z.number().positive().nullable().optional(),
  shelfLifeHours:   z.number().int().min(0).nullable().optional(),
  laborMinutes:     z.number().int().min(0).nullable().optional(),
  isActive:         z.boolean().default(true),
  notes:            z.string().nullable().optional(),
  brandConceptIds:  z.array(z.string().uuid()).default([]),    // brands that currently use this component
})

export async function componentRoutes(fastify: FastifyInstance) {

  // GET /components — full list with filters
  // ?type=hero|supporting|trim_waste
  // ?season=current|spring|summer|...
  // ?ingredientId=…
  // ?brandConceptId=…
  // ?q=search
  // ?activeOnly=true
  fastify.get<{ Querystring: {
    type?: string; season?: string; ingredientId?: string; brandConceptId?: string;
    q?: string; activeOnly?: string;
  }}>(
    '/',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const { type, ingredientId, brandConceptId, q, activeOnly } = req.query
      let { season } = req.query
      if (season === 'current') season = currentSeason(new Date())

      const components = await prisma.component.findMany({
        where: {
          deletedAt: null,
          ...(type && { type: type as never }),
          ...(ingredientId && { baseIngredientId: ingredientId }),
          ...(activeOnly === 'true' && { isActive: true }),
          ...(season && {
            OR: [
              { seasons: { has: season } },
              { seasons: { has: 'year-round' } },
              { seasons: { isEmpty: true } },
            ],
          }),
          ...(q && {
            OR: [
              { name:        { contains: q, mode: 'insensitive' } },
              { description: { contains: q, mode: 'insensitive' } },
              { preparation: { contains: q, mode: 'insensitive' } },
            ],
          }),
          ...(brandConceptId && {
            brands: { some: { conceptId: brandConceptId } },
          }),
        },
        include: {
          baseIngredient: { select: { id: true, name: true, unit: true, notes: true } },
          brands: { include: { concept: { select: { id: true, name: true, slug: true, primaryColor: true } } } },
        },
        orderBy: [{ baseIngredient: { name: 'asc' } }, { type: 'asc' }, { name: 'asc' }],
      })

      return components
    },
  )

  // GET /components/by-ingredient/:ingredientId — convenient for ingredient detail pages
  fastify.get<{ Params: { ingredientId: string } }>(
    '/by-ingredient/:ingredientId',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      return prisma.component.findMany({
        where: { baseIngredientId: req.params.ingredientId, deletedAt: null },
        include: {
          brands: { include: { concept: { select: { id: true, name: true, slug: true } } } },
        },
        orderBy: [{ type: 'asc' }, { name: 'asc' }],
      })
    },
  )

  // GET /components/:id
  fastify.get<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const c = await prisma.component.findUnique({
        where: { id: req.params.id },
        include: {
          baseIngredient: true,
          brands: { include: { concept: { select: { id: true, name: true, slug: true, primaryColor: true } } } },
        },
      })
      if (!c) throw new NotFoundError('Component', req.params.id)
      return c
    },
  )

  // POST /components — create
  fastify.post('/', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = componentInput.parse(req.body)
    const { brandConceptIds, ...rest } = body
    const created = await prisma.component.create({
      data: {
        ...rest,
        brands: { create: brandConceptIds.map((cid) => ({ conceptId: cid })) },
      },
      include: {
        baseIngredient: { select: { id: true, name: true, unit: true } },
        brands: { include: { concept: { select: { id: true, name: true, slug: true, primaryColor: true } } } },
      },
    })
    return reply.status(201).send(created)
  })

  // PATCH /components/:id — partial update + replace brand uses if provided
  fastify.patch<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const body = componentInput.partial().parse(req.body)
      const { brandConceptIds, ...rest } = body

      if (brandConceptIds) {
        await prisma.componentBrandUse.deleteMany({ where: { componentId: req.params.id } })
        if (brandConceptIds.length > 0) {
          await prisma.componentBrandUse.createMany({
            data: brandConceptIds.map((cid) => ({ componentId: req.params.id, conceptId: cid })),
            skipDuplicates: true,
          })
        }
      }

      return prisma.component.update({
        where: { id: req.params.id },
        data: rest,
        include: {
          baseIngredient: { select: { id: true, name: true, unit: true } },
          brands: { include: { concept: { select: { id: true, name: true, slug: true, primaryColor: true } } } },
        },
      })
    },
  )

  // DELETE /components/:id — soft delete
  fastify.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      await prisma.component.update({
        where: { id: req.params.id },
        data: { deletedAt: new Date(), isActive: false },
      })
      return reply.status(204).send()
    },
  )

  // POST /components/:id/clone — duplicate (e.g. seasonal variant)
  fastify.post<{ Params: { id: string } }>(
    '/:id/clone',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const body = z.object({ name: z.string().min(1).max(120) }).parse(req.body)
      const src = await prisma.component.findUnique({
        where: { id: req.params.id },
        include: { brands: true },
      })
      if (!src) throw new NotFoundError('Component', req.params.id)
      const cloned = await prisma.component.create({
        data: {
          name: body.name,
          type: src.type,
          baseIngredientId: src.baseIngredientId,
          description: src.description,
          preparation: src.preparation,
          seasons: src.seasons,
          yieldGrams: src.yieldGrams,
          shelfLifeHours: src.shelfLifeHours,
          laborMinutes: src.laborMinutes,
          notes: src.notes,
          brands: { create: src.brands.map((b) => ({ conceptId: b.conceptId, isPrimary: b.isPrimary })) },
        },
        include: { brands: true, baseIngredient: { select: { id: true, name: true, unit: true } } },
      })
      return reply.status(201).send(cloned)
    },
  )
}

// Pakistan-leaning calendar; same logic as in recipe routes
function currentSeason(d: Date): string {
  const m = d.getMonth() + 1
  if (m >= 3 && m <= 4)   return 'spring'
  if (m === 5 || m === 6) return 'summer'
  if (m >= 7 && m <= 9)   return 'monsoon'
  if (m === 10)           return 'autumn'
  return 'winter'
}
