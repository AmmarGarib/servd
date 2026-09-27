// Component library — the hero / supporting / trim-waste utilisation matrix per
// base ingredient (seeded from the GS Foods PDF by scripts/seed-gs-components.ts),
// with shelf life and which brands use each item.
//
// READ-ONLY planning reference (owner decision 29, 2026-09-27). The catalogue of
// things the kitchen preps is the recipe library's sub-recipes; the par sheet
// lists those and prep is logged through prep batches. The create / edit /
// delete / clone endpoints were removed with that decision (they had no caller
// in any app). Brand-use chips only show the operator's own companies' brands.

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, ALL_STAFF } from '../auth/middleware.js'
import { NotFoundError } from '../../lib/errors.js'
import { conceptIdsInScope, assertConceptOwned } from '../../lib/tenantScope.js'

async function brandUseInclude(req: FastifyRequest) {
  const ids = await conceptIdsInScope(req, 'read')
  return {
    where: { conceptId: { in: ids } },
    include: { concept: { select: { id: true, name: true, slug: true, primaryColor: true } } },
  }
}

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
      if (brandConceptId) await assertConceptOwned(req, brandConceptId, 'read')
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
          brands: await brandUseInclude(req),
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
          brands: await brandUseInclude(req),
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
          baseIngredient: { select: { id: true, name: true, unit: true, notes: true } },
          brands: await brandUseInclude(req),
        },
      })
      if (!c) throw new NotFoundError('Component', req.params.id)
      return c
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
