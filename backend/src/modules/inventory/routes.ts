import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS } from '../auth/middleware.js'
import { AppError, NotFoundError } from '../../lib/errors.js'

const wasteSchema = z.object({
  quantity: z.number().positive(),
  unit: z.string().min(1),
  reason: z.enum(['spoilage', 'over_prep', 'expired', 'damaged', 'other']),
  estimatedCostCents: z.number().int().min(0).optional(),
  photoUrl: z.string().url().nullable().optional(),
  notes: z.string().optional(),
})

const createItemSchema = z.object({
  name: z.string().min(1),
  unit: z.string().min(1),
  parLevel: z.number().min(0).default(0),
  currentStock: z.number().min(0).default(0),
  supplierId: z.string().uuid().nullable().optional(),
  notes: z.string().optional(),
})

const updateStockSchema = z.object({
  currentStock: z.number().min(0),
  notes: z.string().optional(),
})

const adjustStockSchema = z.object({
  delta: z.number(),
})

export async function inventoryRoutes(fastify: FastifyInstance) {
  // GET /inventory — list with low-stock alerts
  fastify.get('/', { preHandler: requireAuth(...MANAGERS) }, async () => {
    const items = await prisma.inventoryItem.findMany({
      where: { deletedAt: null },
      include: { supplier: { select: { name: true } } },
      orderBy: { name: 'asc' },
    })

    return items.map((item) => ({
      ...item,
      isLowStock: item.currentStock <= item.parLevel,
      stockPercentage: item.parLevel > 0 ? (item.currentStock / item.parLevel) * 100 : 100,
    }))
  })

  fastify.post('/', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = createItemSchema.parse(req.body)
    const item = await prisma.inventoryItem.create({ data: body })
    return reply.status(201).send(item)
  })

  // PATCH /inventory/:id — set stock to absolute value
  fastify.patch<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const { currentStock } = updateStockSchema.parse(req.body)
      const item = await prisma.inventoryItem.findFirst({ where: { id: req.params.id, deletedAt: null } })
      if (!item) throw new NotFoundError('InventoryItem', req.params.id)
      return prisma.inventoryItem.update({ where: { id: req.params.id }, data: { currentStock } })
    },
  )

  // PATCH /inventory/:id/adjust — increment or decrement stock by delta
  fastify.patch<{ Params: { id: string } }>(
    '/:id/adjust',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const { delta } = adjustStockSchema.parse(req.body)
      const item = await prisma.inventoryItem.findFirst({ where: { id: req.params.id, deletedAt: null } })
      if (!item) throw new NotFoundError('InventoryItem', req.params.id)
      if (item.currentStock + delta < 0) {
        throw new AppError('NEGATIVE_STOCK', `Adjustment would leave ${item.name} at ${item.currentStock + delta} ${item.unit ?? ''} (have ${item.currentStock})`, 422)
      }
      return prisma.inventoryItem.update({
        where: { id: req.params.id },
        data: { currentStock: { increment: delta } },
      })
    },
  )

  // GET /inventory/alerts — items at or below par level
  fastify.get('/alerts', { preHandler: requireAuth(...MANAGERS) }, async () => {
    const all = await prisma.inventoryItem.findMany({
      where: { deletedAt: null },
      include: { supplier: { select: { name: true, phone: true } } },
      orderBy: { name: 'asc' },
    })
    return all.filter((item) => item.currentStock <= item.parLevel)
  })

  // GET /inventory/waste-logs — waste history with optional filters
  fastify.get<{ Querystring: { inventoryItemId?: string; dateFrom?: string; dateTo?: string; limit?: string } }>(
    '/waste-logs',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const limit = Math.min(parseInt(req.query.limit ?? '100', 10), 500)
      const from = req.query.dateFrom ? new Date(req.query.dateFrom) : undefined
      const to = req.query.dateTo ? new Date(req.query.dateTo) : undefined
      return prisma.wasteLog.findMany({
        where: {
          ...(req.query.inventoryItemId && { inventoryItemId: req.query.inventoryItemId }),
          ...(from || to ? { recordedAt: { ...(from && { gte: from }), ...(to && { lte: to }) } } : {}),
        },
        include: {
          inventoryItem: { select: { name: true, unit: true, unitCostCents: true } },
          recordedBy: { select: { name: true } },
        },
        orderBy: { recordedAt: 'desc' },
        take: limit,
      })
    },
  )

  // POST /inventory/:id/waste — record spoilage / wastage
  fastify.post<{ Params: { id: string } }>(
    '/:id/waste',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const body = wasteSchema.parse(req.body)
      const item = await prisma.inventoryItem.findFirst({ where: { id: req.params.id, deletedAt: null } })
      if (!item) throw new NotFoundError('InventoryItem', req.params.id)

      const cost = body.estimatedCostCents ?? (item.unitCostCents ? Math.round(item.unitCostCents * body.quantity) : undefined)

      // Photo enforcement — above the threshold a photo is REQUIRED. Inflated
      // waste logs are a classic theft cover-up; making the photo mandatory
      // above PKR X eliminates the easiest version of that abuse.
      const { getOperationsConfig } = await import('../../lib/setup-config.js')
      const ops = await getOperationsConfig()
      const threshold = ops?.photoRequiredAboveCents ?? 50000
      if (cost && cost >= threshold && !body.photoUrl) {
        throw new AppError(
          'PHOTO_REQUIRED',
          `Waste above PKR ${(threshold / 100).toFixed(0)} requires a photo. Snap the wasted product before logging.`,
          400,
        )
      }

      const [wasteLog] = await prisma.$transaction([
        prisma.wasteLog.create({
          data: {
            inventoryItemId: req.params.id,
            quantity: body.quantity,
            unit: body.unit,
            reason: body.reason,
            estimatedCostCents: cost,
            photoUrl: body.photoUrl ?? null,
            notes: body.notes,
            recordedById: req.staffUser?.id,
          },
          include: { inventoryItem: { select: { name: true, unit: true } } },
        }),
        prisma.inventoryItem.update({
          where: { id: req.params.id },
          data: { currentStock: { decrement: body.quantity } },
        }),
      ])

      const { postWasteLog } = await import('../accounting/supplierPosting.js')
      postWasteLog(wasteLog.id).catch((err) =>
        req.log.error({ err: (err as Error).message, wasteLogId: wasteLog.id }, 'postWasteLog failed'),
      )

      return reply.status(201).send(wasteLog)
    },
  )
}
