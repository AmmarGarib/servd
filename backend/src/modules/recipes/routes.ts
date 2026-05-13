import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS, ADMIN_ONLY, ALL_STAFF } from '../auth/middleware.js'
import { NotFoundError, AppError } from '../../lib/errors.js'

const Q_FACTOR = 0.05 // 5% miscellaneous surcharge (salt, oil, unmeasured items)

const SEASON_KEYS = ['spring', 'summer', 'monsoon', 'autumn', 'winter', 'ramadan', 'year-round'] as const
const SEASON_DATE_RE = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/

const recipeSchema = z.object({
  menuItemId:   z.string().uuid(),
  servings:     z.number().int().min(1).default(1),
  portionSizeG: z.number().positive().optional(),
  laborMinutes: z.number().int().min(0).default(0),
  notes:        z.string().optional(),
  steps:        z.string().optional(),
  stepsUrdu:    z.string().optional(),
  seasons:      z.array(z.enum(SEASON_KEYS)).default([]),
  seasonStart:  z.string().regex(SEASON_DATE_RE, 'Use MM-DD format').nullable().optional(),
  seasonEnd:    z.string().regex(SEASON_DATE_RE, 'Use MM-DD format').nullable().optional(),
  isActive:     z.boolean().default(true),
  ingredients: z.array(z.object({
    inventoryItemId: z.string().uuid(),
    quantity:        z.number().positive(),
    yieldPct:        z.number().min(0.01).max(1).default(1),
    unit:            z.string().min(1),
    notes:           z.string().optional(),
  })).min(1),
})

// Map a calendar month → the seasons that month belongs to. Pakistan-leaning
// (no spring proper; monsoon is mid-Jun → Sep; summer = Apr → mid-Jun + post-monsoon).
function currentSeasonsForDate(d: Date): string[] {
  const m = d.getMonth() + 1   // 1-12
  if (m >= 3 && m <= 4)   return ['spring']
  if (m === 5 || m === 6) return ['summer']
  if (m >= 7 && m <= 9)   return ['monsoon']
  if (m === 10)           return ['autumn']
  if (m >= 11 || m <= 2)  return ['winter']
  return []
}

const poSchema = z.object({
  supplierId:   z.string().uuid(),
  expectedDate: z.string().datetime().optional(),
  reference:    z.string().optional(),
  notes:        z.string().optional(),
  lines: z.array(z.object({
    inventoryItemId: z.string().uuid(),
    quantityOrdered: z.number().positive(),
    unitCostCents:   z.number().int().positive(),
    notes:           z.string().optional(),
  })).min(1),
})

export async function recipeRoutes(fastify: FastifyInstance) {

  // ── Recipes ────────────────────────────────────────────────────────────────

  // GET /recipes — list all with cost calc.
  // Filters:
  //   ?conceptId=…          — only recipes belonging to this concept
  //   ?season=summer        — only recipes tagged for this season (or year-round)
  //   ?season=current       — auto-detect current season from server date
  //   ?q=mango              — substring search on menu item name + recipe notes
  //   ?activeOnly=true      — exclude isActive=false (off-season seasonal items)
  fastify.get<{ Querystring: { conceptId?: string; season?: string; q?: string; activeOnly?: string } }>(
    '/',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const { conceptId, q, activeOnly } = req.query
      let { season } = req.query
      if (season === 'current') season = currentSeasonsForDate(new Date())[0]

      const recipes = await prisma.recipe.findMany({
        where: {
          ...(conceptId && { menuItem: { conceptId } }),
          ...(activeOnly === 'true' && { isActive: true }),
          // Season filter: include the requested season OR explicit "year-round" OR
          // empty seasons array (which we treat as year-round).
          ...(season && {
            OR: [
              { seasons: { has: season } },
              { seasons: { has: 'year-round' } },
              { seasons: { isEmpty: true } },
            ],
          }),
          ...(q && {
            OR: [
              { menuItem: { name: { contains: q, mode: 'insensitive' } } },
              { notes: { contains: q, mode: 'insensitive' } },
            ],
          }),
        },
        include: {
          menuItem: {
            select: {
              id: true, name: true, priceCents: true, conceptId: true,
              concept: {
                select: {
                  name: true, tenantId: true,
                  tenant: { select: { id: true, name: true, slug: true } },
                },
              },
            },
          },
          ingredients: {
            include: { inventoryItem: { select: { name: true, unit: true, unitCostCents: true } } },
          },
        },
        orderBy: { menuItem: { name: 'asc' } },
      })

      // Recipe library is the operator's IP. Bulk reads above the threshold
      // signal exfiltration and fire a flag.
      if (recipes.length >= 50) {
        const { getOperationsConfig } = await import('../../lib/setup-config.js')
        const ops = await getOperationsConfig()
        const threshold = ops?.pii_export_row_threshold ?? 100
        if (recipes.length >= threshold) {
          const { flagException } = await import('../../lib/exceptions.js')
          await flagException({
            kind: 'pii_export',
            severity: recipes.length >= 200 ? 'high' : 'medium',
            title: `Bulk recipe read: ${recipes.length} recipes`,
            description: `${req.staffUser!.email} read ${recipes.length} recipes in one request from IP ${req.ip}. Recipes are operator IP — investigate if unexpected.`,
            actorId: req.staffUser!.id,
            metadata: { rowCount: recipes.length, conceptId: conceptId ?? null, q: q ?? null, ip: req.ip },
          })
        }
      }

      return recipes.map((r) => {
        const ingDetails = r.ingredients.map((ing) => {
          const costPerUnit  = ing.inventoryItem.unitCostCents ?? 0
          const yp           = ing.yieldPct > 0 ? ing.yieldPct : 1
          const purchaseQty  = ing.quantity / yp          // what you actually buy
          const ingredientCostCents = Math.round(costPerUnit * purchaseQty)
          return { ...ing, purchaseQty, ingredientCostCents }
        })

        const ingredientCostCents = ingDetails.reduce((s, i) => s + i.ingredientCostCents, 0)
        const qFactorCents        = Math.round(ingredientCostCents * Q_FACTOR)
        const laborCostCents      = Math.round((r.laborMinutes / 60) * 50_00) // PKR 50/hr
        const totalCostCents      = ingredientCostCents + qFactorCents + laborCostCents
        const costPerPortionCents = r.servings > 0 ? Math.round(totalCostCents / r.servings) : totalCostCents
        const priceCents          = r.menuItem.priceCents
        const grossMarginPct      = priceCents > 0 ? Math.round(((priceCents - costPerPortionCents) / priceCents) * 100) : null
        const foodCostPct         = priceCents > 0 ? Math.round((costPerPortionCents / priceCents) * 100) : null

        return {
          ...r,
          ingredients: ingDetails,
          ingredientCostCents,
          qFactorCents,
          laborCostCents,
          totalCostCents,
          costPerPortionCents,
          grossMarginPct,
          foodCostPct,
        }
      })
    },
  )

  // GET /recipes/:id
  fastify.get<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const recipe = await prisma.recipe.findUnique({
        where: { id: req.params.id },
        include: {
          menuItem: { select: { id: true, name: true, priceCents: true, concept: { select: { name: true } } } },
          ingredients: {
            include: { inventoryItem: { select: { id: true, name: true, unit: true, unitCostCents: true, currentStock: true } } },
          },
        },
      })
      if (!recipe) throw new NotFoundError('Recipe', req.params.id)
      return recipe
    },
  )

  // GET /recipes/by-item/:menuItemId — KDS instruction modal fetches this
  fastify.get<{ Params: { menuItemId: string } }>(
    '/by-item/:menuItemId',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const recipe = await prisma.recipe.findUnique({
        where: { menuItemId: req.params.menuItemId },
        include: {
          ingredients: {
            include: { inventoryItem: { select: { name: true, unit: true } } },
            orderBy: { inventoryItem: { name: 'asc' } },
          },
        },
      })
      if (!recipe) return null
      return {
        id:          recipe.id,
        steps:       recipe.steps,
        stepsUrdu:   recipe.stepsUrdu,
        notes:       recipe.notes,
        servings:    recipe.servings,
        laborMinutes: recipe.laborMinutes,
        ingredients: recipe.ingredients.map((ing) => ({
          id:           ing.id,
          quantity:     ing.quantity,
          yieldPct:     ing.yieldPct,
          unit:         ing.unit,
          notes:        ing.notes,
          name:         ing.inventoryItem.name,
        })),
      }
    },
  )

  // POST /recipes
  fastify.post('/', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = recipeSchema.parse(req.body)
    const existing = await prisma.recipe.findUnique({ where: { menuItemId: body.menuItemId } })
    if (existing) throw new AppError('RECIPE_EXISTS', 'Recipe for this menu item already exists', 409)

    const recipe = await prisma.recipe.create({
      data: {
        menuItemId:   body.menuItemId,
        servings:     body.servings,
        portionSizeG: body.portionSizeG,
        laborMinutes: body.laborMinutes,
        notes:        body.notes,
        steps:        body.steps,
        stepsUrdu:    body.stepsUrdu,
        seasons:      body.seasons,
        seasonStart:  body.seasonStart ?? null,
        seasonEnd:    body.seasonEnd ?? null,
        isActive:     body.isActive,
        ingredients:  { create: body.ingredients },
      },
      include: { ingredients: { include: { inventoryItem: true } }, menuItem: true },
    })
    return reply.status(201).send(recipe)
  })

  // PUT /recipes/:id — full replace
  fastify.put<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const body = recipeSchema.partial().parse(req.body)
      return prisma.$transaction(async (tx) => {
        if (body.ingredients) {
          await tx.recipeIngredient.deleteMany({ where: { recipeId: req.params.id } })
        }
        return tx.recipe.update({
          where: { id: req.params.id },
          data: {
            ...(body.servings     != null && { servings: body.servings }),
            ...(body.portionSizeG != null && { portionSizeG: body.portionSizeG }),
            ...(body.laborMinutes != null && { laborMinutes: body.laborMinutes }),
            ...(body.notes        != null && { notes: body.notes }),
            ...(body.steps        != null && { steps: body.steps }),
            ...(body.stepsUrdu    != null && { stepsUrdu: body.stepsUrdu }),
            ...(body.seasons      != null && { seasons: body.seasons }),
            ...(body.seasonStart  !== undefined && { seasonStart: body.seasonStart }),
            ...(body.seasonEnd    !== undefined && { seasonEnd: body.seasonEnd }),
            ...(body.isActive     != null && { isActive: body.isActive }),
            ...(body.ingredients  && { ingredients: { create: body.ingredients } }),
          },
          include: { ingredients: { include: { inventoryItem: true } }, menuItem: true },
        })
      })
    },
  )

  // DELETE /recipes/:id
  fastify.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      await prisma.recipe.delete({ where: { id: req.params.id } })
      return reply.status(204).send()
    },
  )

  // ── Food Cost Analysis ─────────────────────────────────────────────────────

  // GET /recipes/food-cost?conceptId&dateFrom&dateTo
  fastify.get<{ Querystring: { conceptId?: string; dateFrom?: string; dateTo?: string } }>(
    '/food-cost',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const { conceptId, dateFrom, dateTo } = req.query
      const from = dateFrom ? new Date(dateFrom) : new Date(Date.now() - 30 * 86_400_000)
      const to   = dateTo   ? new Date(dateTo)   : new Date()

      // Sales in period
      const salesData = await prisma.financialEntry.aggregate({
        where: {
          ...(conceptId && { conceptId }),
          entryDate: { gte: from, lte: to },
        },
        _sum: { grossCents: true, netCents: true },
        _count: true,
      })
      const grossRevenue = salesData._sum.grossCents ?? 0
      const netRevenue   = salesData._sum.netCents   ?? 0

      // Items sold in period
      const soldItems = await prisma.orderItem.groupBy({
        by: ['menuItemId', 'name'],
        where: {
          order: {
            ...(conceptId && { conceptId }),
            status: 'completed',
            placedAt: { gte: from, lte: to },
          },
          menuItemId: { not: null },
        },
        _sum: { quantity: true },
      })

      // Recipes with costs
      const recipes = await prisma.recipe.findMany({
        where: { menuItem: { ...(conceptId && { conceptId }) } },
        include: {
          menuItem: { select: { id: true, name: true, priceCents: true } },
          ingredients: { include: { inventoryItem: { select: { unitCostCents: true } } } },
        },
      })

      const recipeMap = new Map(recipes.map((r) => [r.menuItemId, r]))

      let theoreticalCostCents = 0
      const byItem: Array<{
        menuItemId: string; name: string; qtySold: number
        costPerPortion: number; totalCost: number
        revenue: number; foodCostPct: number; marginPct: number
      }> = []

      for (const sold of soldItems) {
        if (!sold.menuItemId) continue
        const qty = sold._sum.quantity ?? 0
        const recipe = recipeMap.get(sold.menuItemId)
        if (!recipe) continue

        const ingCost = recipe.ingredients.reduce((s, ing) => {
          const yp = ing.yieldPct > 0 ? ing.yieldPct : 1
          return s + Math.round((ing.inventoryItem.unitCostCents ?? 0) * (ing.quantity / yp))
        }, 0)
        const totalWithQ     = Math.round(ingCost * (1 + Q_FACTOR))
        const costPerPortion = recipe.servings > 0 ? Math.round(totalWithQ / recipe.servings) : totalWithQ
        const totalCost = costPerPortion * qty
        const itemRevenue = recipe.menuItem.priceCents * qty

        theoreticalCostCents += totalCost
        byItem.push({
          menuItemId:   sold.menuItemId,
          name:         sold.name,
          qtySold:      qty,
          costPerPortion,
          totalCost,
          revenue:      itemRevenue,
          foodCostPct:  itemRevenue > 0 ? Math.round((totalCost / itemRevenue) * 100) : 0,
          marginPct:    itemRevenue > 0 ? Math.round(((itemRevenue - totalCost) / itemRevenue) * 100) : 0,
        })
      }

      byItem.sort((a, b) => b.totalCost - a.totalCost)

      // Actual food cost from purchases in period
      const purchases = await prisma.purchaseOrderLine.aggregate({
        where: {
          purchaseOrder: {
            status: 'received',
            receivedDate: { gte: from, lte: to },
          },
        },
        _sum: { unitCostCents: true },
      })
      const actualPurchasesCents = purchases._sum.unitCostCents ?? 0

      const theoreticalFoodCostPct = grossRevenue > 0
        ? parseFloat(((theoreticalCostCents / grossRevenue) * 100).toFixed(1))
        : 0

      return {
        period:     { from: from.toISOString(), to: to.toISOString() },
        revenue:    { grossCents: grossRevenue, netCents: netRevenue },
        cost: {
          theoreticalCents:       theoreticalCostCents,
          actualPurchasesCents,
          theoreticalFoodCostPct,
          targetFoodCostPct:      30,   // industry standard for restaurant
          variance:               parseFloat((theoreticalFoodCostPct - 30).toFixed(1)),
          status:                 theoreticalFoodCostPct <= 30 ? 'good' : theoreticalFoodCostPct <= 35 ? 'warning' : 'critical',
        },
        byItem,
        itemsWithoutRecipe: soldItems.filter((s) => s.menuItemId && !recipeMap.has(s.menuItemId)).map((s) => ({
          menuItemId: s.menuItemId,
          name: s.name,
          qtySold: s._sum.quantity ?? 0,
        })),
      }
    },
  )

  // ── Vendors / Purchase Orders ──────────────────────────────────────────────

  // GET /recipes/vendors
  fastify.get('/vendors', { preHandler: requireAuth(...MANAGERS) }, async () => {
    return prisma.supplier.findMany({
      where: { deletedAt: null },
      include: { _count: { select: { purchaseOrders: true, inventoryItems: true } } },
      orderBy: { name: 'asc' },
    })
  })

  // POST /recipes/vendors
  fastify.post('/vendors', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = z.object({
      name:    z.string().min(1),
      phone:   z.string().optional(),
      email:   z.string().email().optional(),
      address: z.string().optional(),
      taxId:   z.string().optional(),
      notes:   z.string().optional(),
    }).parse(req.body)
    const vendor = await prisma.supplier.create({ data: body })
    return reply.status(201).send(vendor)
  })

  // PATCH /recipes/vendors/:id
  fastify.patch<{ Params: { id: string } }>(
    '/vendors/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const body = z.object({
        name:    z.string().min(1).optional(),
        phone:   z.string().optional(),
        email:   z.string().email().optional(),
        address: z.string().optional(),
        taxId:   z.string().optional(),
        notes:   z.string().optional(),
      }).parse(req.body)
      return prisma.supplier.update({ where: { id: req.params.id }, data: body })
    },
  )

  // GET /recipes/purchase-orders
  fastify.get<{ Querystring: { supplierId?: string; status?: string; limit?: string } }>(
    '/purchase-orders',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const limit = Math.min(parseInt(req.query.limit ?? '50', 10), 200)
      return prisma.purchaseOrder.findMany({
        where: {
          ...(req.query.supplierId && { supplierId: req.query.supplierId }),
          ...(req.query.status    && { status: req.query.status }),
        },
        include: {
          supplier: { select: { name: true } },
          lines:    { include: { inventoryItem: { select: { name: true, unit: true } } } },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
      })
    },
  )

  // POST /recipes/purchase-orders
  fastify.post('/purchase-orders', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = poSchema.parse(req.body)
    const totalCents = body.lines.reduce((s, l) => s + Math.round(l.unitCostCents * l.quantityOrdered), 0)
    const po = await prisma.purchaseOrder.create({
      data: {
        supplierId:   body.supplierId,
        expectedDate: body.expectedDate ? new Date(body.expectedDate) : null,
        reference:    body.reference,
        notes:        body.notes,
        totalCents,
        createdBy:    req.staffUser!.id,
        lines: { create: body.lines },
      },
      include: { supplier: true, lines: { include: { inventoryItem: true } } },
    })
    return reply.status(201).send(po)
  })

  // POST /recipes/purchase-orders/:id/receive — mark as received, update inventory + costs
  fastify.post<{ Params: { id: string }; Body: { lines: { lineId: string; quantityReceived: number }[] } }>(
    '/purchase-orders/:id/receive',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const { lines } = z.object({
        lines: z.array(z.object({
          lineId:           z.string().uuid(),
          quantityReceived: z.number().positive(),
        })),
      }).parse(req.body)

      const po = await prisma.purchaseOrder.findUnique({
        where: { id: req.params.id },
        include: { lines: true },
      })
      if (!po) throw new NotFoundError('PurchaseOrder', req.params.id)
      if (po.status === 'cancelled') throw new AppError('PO_CANCELLED', 'Cannot receive a cancelled PO', 400)

      await prisma.$transaction(async (tx) => {
        for (const recv of lines) {
          const poLine = po.lines.find((l) => l.id === recv.lineId)
          if (!poLine) continue

          // Update line received qty
          await tx.purchaseOrderLine.update({
            where: { id: recv.lineId },
            data: { quantityReceived: { increment: recv.quantityReceived } },
          })

          // Update inventory stock + unit cost (weighted average)
          const item = await tx.inventoryItem.findUnique({ where: { id: poLine.inventoryItemId } })
          if (item) {
            const oldStock   = item.currentStock
            const newStock   = oldStock + recv.quantityReceived
            const oldCost    = item.unitCostCents ?? poLine.unitCostCents
            const newUnitCost = newStock > 0
              ? Math.round((oldCost * oldStock + poLine.unitCostCents * recv.quantityReceived) / newStock)
              : poLine.unitCostCents

            await tx.inventoryItem.update({
              where: { id: poLine.inventoryItemId },
              data: { currentStock: { increment: recv.quantityReceived }, unitCostCents: newUnitCost },
            })
          }
        }

        const allReceived = po.lines.every((l) => {
          const recv = lines.find((r) => r.lineId === l.id)
          const total = l.quantityReceived + (recv?.quantityReceived ?? 0)
          return total >= l.quantityOrdered
        })

        await tx.purchaseOrder.update({
          where: { id: req.params.id },
          data: {
            status:       allReceived ? 'received' : 'partial',
            receivedDate: new Date(),
          },
        })
      })

      return prisma.purchaseOrder.findUnique({
        where: { id: req.params.id },
        include: { supplier: true, lines: { include: { inventoryItem: true } } },
      })
    },
  )

  // PATCH /recipes/purchase-orders/:id/cancel
  fastify.patch<{ Params: { id: string } }>(
    '/purchase-orders/:id/cancel',
    { preHandler: requireAuth(...ADMIN_ONLY) },
    async (req) => {
      return prisma.purchaseOrder.update({
        where: { id: req.params.id },
        data: { status: 'cancelled' },
      })
    },
  )

  // ─── Recipe steps (per-station service sequence) ────────────────────────
  //
  // A recipe has 0..n steps. Each step is tagged by phase (mise/MOP/cook/
  // assemble), pinned to a station, has an instruction, an ETA, and may
  // depend on prior steps. The expo-fire engine reads these on order
  // confirmation; the cascade engine walks them on each bump.

  // GET /recipes/:recipeId/steps — list ordered by phase then ordinal
  fastify.get<{ Params: { recipeId: string } }>(
    '/:recipeId/steps',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      return prisma.recipeStep.findMany({
        where: { recipeId: req.params.recipeId },
        orderBy: [{ phase: 'asc' }, { ordinal: 'asc' }],
        include: { station: { select: { id: true, name: true } } },
      })
    },
  )

  const stepInputSchema = z.object({
    phase:            z.enum(['prep_mep', 'prep_mop', 'service_cook', 'service_assemble']),
    ordinal:          z.number().int().min(0).default(0),
    stationId:        z.string().uuid().nullable().optional(),
    instruction:      z.string().min(1).max(2000),
    instructionUrdu:  z.string().max(2000).nullable().optional(),
    estimatedSeconds: z.number().int().min(0).default(60),
    // Other step IDs (from the same recipe) that must complete first.
    dependsOnIds:     z.array(z.string().uuid()).default([]),
  })

  // POST /recipes/:recipeId/steps
  fastify.post<{ Params: { recipeId: string } }>(
    '/:recipeId/steps',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const body = stepInputSchema.parse(req.body)
      const recipe = await prisma.recipe.findUnique({ where: { id: req.params.recipeId } })
      if (!recipe) throw new NotFoundError('Recipe', req.params.recipeId)
      // Dependency-self / cycle guard: only allow deps that already exist on
      // this recipe. Future steps in the editor will be added one-at-a-time
      // so cycles are impossible by construction.
      if (body.dependsOnIds.length > 0) {
        const valid = await prisma.recipeStep.findMany({
          where: { recipeId: req.params.recipeId, id: { in: body.dependsOnIds } },
          select: { id: true },
        })
        if (valid.length !== body.dependsOnIds.length) {
          throw new AppError('INVALID_DEPS', 'One or more dependency step IDs do not belong to this recipe', 400)
        }
      }
      const created = await prisma.recipeStep.create({
        data: { ...body, recipeId: req.params.recipeId },
        include: { station: { select: { id: true, name: true } } },
      })
      return reply.status(201).send(created)
    },
  )

  // PATCH /recipes/steps/:stepId
  fastify.patch<{ Params: { stepId: string } }>(
    '/steps/:stepId',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const body = stepInputSchema.partial().parse(req.body)
      const existing = await prisma.recipeStep.findUnique({ where: { id: req.params.stepId } })
      if (!existing) throw new NotFoundError('RecipeStep', req.params.stepId)
      // No self-dependency.
      if (body.dependsOnIds?.includes(existing.id)) {
        throw new AppError('SELF_DEP', 'A step cannot depend on itself', 400)
      }
      const updated = await prisma.recipeStep.update({
        where: { id: req.params.stepId },
        data:  body,
        include: { station: { select: { id: true, name: true } } },
      })
      return reply.status(200).send(updated)
    },
  )

  // DELETE /recipes/steps/:stepId — refuses if other steps depend on this one
  // so the editor surfaces a clear "remove this dep first" error.
  fastify.delete<{ Params: { stepId: string } }>(
    '/steps/:stepId',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const step = await prisma.recipeStep.findUnique({ where: { id: req.params.stepId } })
      if (!step) throw new NotFoundError('RecipeStep', req.params.stepId)
      const dependents = await prisma.recipeStep.findMany({
        where: { recipeId: step.recipeId, dependsOnIds: { has: req.params.stepId } },
        select: { id: true, instruction: true },
      })
      if (dependents.length > 0) {
        return reply.status(409).send({
          error: {
            code: 'HAS_DEPENDENTS',
            message: `${dependents.length} other step(s) depend on this one — remove those deps first.`,
            dependents,
          },
        })
      }
      await prisma.recipeStep.delete({ where: { id: req.params.stepId } })
      return reply.status(204).send()
    },
  )
}
