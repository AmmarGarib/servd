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
      const updated = await prisma.inventoryItem.update({
        where: { id: req.params.id },
        data: { currentStock: { increment: delta } },
      })

      // Emit low-stock webhook if the adjustment pushed stock at or below par level.
      // parLevel === 0 means "no threshold configured" — skip to avoid spurious alerts.
      if (updated.parLevel > 0 && updated.currentStock <= updated.parLevel) {
        void (async () => {
          try {
            const { emitDomainEvent } = await import('../../lib/webhook-events.js')
            await emitDomainEvent('inventory.low_stock', {
              itemId:       updated.id,
              name:         updated.name,
              currentStock: updated.currentStock,
              parLevel:     updated.parLevel,
              unit:         updated.unit,
            })
          } catch {
            console.warn('[inventory] LOW STOCK:', updated.name, updated.currentStock, '/', updated.parLevel)
          }
        })()
      }

      return updated
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

  // GET /inventory/waste-analytics — aggregated waste for the dashboard.
  // Returns:
  //   - totalCostCents over the period
  //   - byReason: cents per cause code (spoilage / over_prep / expired / damaged / other)
  //   - topItems: top 10 most wasteful items (by cost) with qty + cost
  //   - trend: daily cents for the chart
  //   - reasonShare: cause share of total cost (% per reason)
  fastify.get<{ Querystring: { from?: string; to?: string } }>(
    '/waste-analytics',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const to   = req.query.to   ? new Date(req.query.to)   : new Date()
      const from = req.query.from ? new Date(req.query.from) : new Date(to.getTime() - 30 * 86_400_000)

      const logs = await prisma.wasteLog.findMany({
        where: { recordedAt: { gte: from, lte: to } },
        select: {
          quantity: true, reason: true, estimatedCostCents: true, recordedAt: true,
          inventoryItem: { select: { id: true, name: true, unit: true, unitCostCents: true } },
        },
      })

      const costFor = (l: { estimatedCostCents: number | null; quantity: number; inventoryItem: { unitCostCents: number | null } }) =>
        l.estimatedCostCents ?? Math.round(l.quantity * (l.inventoryItem.unitCostCents ?? 0))

      const totalCostCents = logs.reduce((s, l) => s + costFor(l), 0)
      const totalQty       = logs.reduce((s, l) => s + l.quantity, 0)

      // By reason
      const byReason: Record<string, { count: number; quantity: number; costCents: number }> = {}
      for (const l of logs) {
        const r = byReason[l.reason] ?? { count: 0, quantity: 0, costCents: 0 }
        r.count += 1
        r.quantity += l.quantity
        r.costCents += costFor(l)
        byReason[l.reason] = r
      }
      const reasonShare = Object.fromEntries(
        Object.entries(byReason).map(([k, v]) => [k, totalCostCents > 0 ? Number(((v.costCents / totalCostCents) * 100).toFixed(1)) : 0]),
      )

      // Top wasteful items
      const itemMap = new Map<string, { id: string; name: string; unit: string; quantity: number; costCents: number; count: number }>()
      for (const l of logs) {
        const key = l.inventoryItem.id
        const prev = itemMap.get(key) ?? { id: key, name: l.inventoryItem.name, unit: l.inventoryItem.unit, quantity: 0, costCents: 0, count: 0 }
        prev.quantity += l.quantity
        prev.costCents += costFor(l)
        prev.count += 1
        itemMap.set(key, prev)
      }
      const topItems = [...itemMap.values()].sort((a, b) => b.costCents - a.costCents).slice(0, 10)

      // Daily trend
      const trendMap: Record<string, number> = {}
      for (const l of logs) {
        const day = l.recordedAt.toISOString().slice(0, 10)
        trendMap[day] = (trendMap[day] ?? 0) + costFor(l)
      }
      const trend = Object.entries(trendMap).sort(([a], [b]) => a.localeCompare(b)).map(([day, cents]) => ({ day, costCents: cents }))

      return {
        period: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
        totals: { logs: logs.length, totalCostCents, totalQty: Number(totalQty.toFixed(2)) },
        byReason,
        reasonShare,
        topItems,
        trend,
      }
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
