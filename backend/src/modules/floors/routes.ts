// Floor plan API.
//
// A Floor groups Tables onto a 2D canvas. Operators edit positions through
// the admin UI; the live status board renders the same layout with status
// colors. Multiple floors per concept (Main, Patio, Mezzanine, Bar).
//
// Concept access is enforced — kitchen / cashier roles only see floors for
// concepts they're scoped to.

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS, ALL_STAFF } from '../auth/middleware.js'
import { assertConceptAccess } from '../../lib/conceptAccess.js'
import { NotFoundError } from '../../lib/errors.js'

const floorSchema = z.object({
  conceptId:     z.string().uuid(),
  name:          z.string().min(1).max(64),
  displayOrder:  z.number().int().min(0).default(0),
  width:         z.number().int().min(400).max(4000).default(1200),
  height:        z.number().int().min(300).max(4000).default(800),
  backgroundUrl: z.string().url().nullable().optional(),
})

const positionSchema = z.object({
  shape:    z.enum(['rectangle', 'square', 'round', 'banquette', 'counter', 'barstool']).optional(),
  x:        z.number().int().min(0).max(4000).optional(),
  y:        z.number().int().min(0).max(4000).optional(),
  width:    z.number().int().min(20).max(800).optional(),
  height:   z.number().int().min(20).max(800).optional(),
  rotation: z.number().int().min(0).max(359).optional(),
  floorId:  z.string().uuid().nullable().optional(),
})

// Bulk layout save — fewer round-trips while the operator drags tables around.
const bulkLayoutSchema = z.object({
  floorId: z.string().uuid(),
  tables: z.array(z.object({
    id: z.string().uuid(),
    x:  z.number().int(),
    y:  z.number().int(),
    width:    z.number().int().optional(),
    height:   z.number().int().optional(),
    rotation: z.number().int().optional(),
    shape:    z.enum(['rectangle', 'square', 'round', 'banquette', 'counter', 'barstool']).optional(),
  })).max(200),
})

export async function floorRoutes(fastify: FastifyInstance) {
  // List floors for a concept, with their tables embedded — tenant-scoped
  fastify.get<{ Querystring: { conceptId?: string } }>(
    '/',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const { conceptId } = req.query
      if (conceptId) await assertConceptAccess(req.staffUser!, conceptId)
      return prisma.floor.findMany({
        where: {
          deletedAt: null,
          isActive: true,
          // Active-tenant scope: floor's concept must belong to the active tenant.
          concept: { tenantId: req.staffUser!.tenantId, deletedAt: null },
          ...(conceptId && { conceptId }),
        },
        include: {
          tables: { where: { deletedAt: null }, orderBy: { label: 'asc' } },
        },
        orderBy: { displayOrder: 'asc' },
      })
    },
  )

  // Create a floor — verify concept is in active tenant
  fastify.post('/', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = floorSchema.parse(req.body)
    await assertConceptAccess(req.staffUser!, body.conceptId)
    const concept = await prisma.concept.findFirst({
      where: { id: body.conceptId, tenantId: req.staffUser!.tenantId, deletedAt: null },
    })
    if (!concept) return reply.status(403).send({ error: { code: 'CROSS_TENANT', message: 'Concept does not belong to your active company' } })
    const floor = await prisma.floor.create({ data: body })
    return reply.status(201).send(floor)
  })

  // Update a floor — must belong to active tenant
  fastify.patch<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const body = floorSchema.partial().parse(req.body)
      const existing = await prisma.floor.findFirst({
        where: {
          id: req.params.id,
          concept: { tenantId: req.staffUser!.tenantId, deletedAt: null },
        },
      })
      if (!existing) throw new NotFoundError('Floor', req.params.id)
      await assertConceptAccess(req.staffUser!, existing.conceptId)
      return prisma.floor.update({ where: { id: req.params.id }, data: body })
    },
  )

  // Soft-delete a floor — tables are unassigned (floorId set null), not deleted
  fastify.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const existing = await prisma.floor.findFirst({
        where: {
          id: req.params.id,
          concept: { tenantId: req.staffUser!.tenantId, deletedAt: null },
        },
      })
      if (!existing) throw new NotFoundError('Floor', req.params.id)
      await assertConceptAccess(req.staffUser!, existing.conceptId)
      await prisma.$transaction([
        prisma.table.updateMany({ where: { floorId: req.params.id }, data: { floorId: null } }),
        prisma.floor.update({ where: { id: req.params.id }, data: { deletedAt: new Date(), isActive: false } }),
      ])
      return reply.status(204).send()
    },
  )

  // Update a single table's position / shape — fast feedback during drag.
  fastify.patch<{ Params: { id: string } }>(
    '/tables/:id/position',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const body = positionSchema.parse(req.body)
      const existing = await prisma.table.findFirst({
        where: {
          id: req.params.id,
          concept: { tenantId: req.staffUser!.tenantId, deletedAt: null },
        },
      })
      if (!existing) throw new NotFoundError('Table', req.params.id)
      await assertConceptAccess(req.staffUser!, existing.conceptId)
      return prisma.table.update({ where: { id: req.params.id }, data: body })
    },
  )

  // Apply a layout template — bulk-creates tables on a floor from a template.
  // Optional `clearExisting=true` deletes current tables on the floor first
  // (operator confirms in UI). Used by the "Layouts" gallery to drop-in a
  // pre-built configuration: QSR / café / fine-dining / cloud-kitchen.
  fastify.post<{ Params: { id: string } }>('/:id/apply-layout',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const body = z.object({
        clearExisting: z.boolean().default(false),
        tables: z.array(z.object({
          label:    z.string().min(1).max(20),
          capacity: z.number().int().min(1).max(50),
          shape:    z.enum(['rectangle', 'square', 'round', 'banquette', 'counter']).default('rectangle'),
          x:        z.number().int().min(0),
          y:        z.number().int().min(0),
          width:    z.number().int().min(40).max(400).default(120),
          height:   z.number().int().min(40).max(400).default(80),
          rotation: z.number().int().min(0).max(359).default(0),
          floorSection: z.string().max(40).optional(),
        })).min(1).max(100),
      }).parse(req.body)

      const floor = await prisma.floor.findFirst({
        where: {
          id: req.params.id,
          concept: { tenantId: req.staffUser!.tenantId, deletedAt: null },
        },
      })
      if (!floor) throw new NotFoundError('Floor', req.params.id)
      await assertConceptAccess(req.staffUser!, floor.conceptId)

      await prisma.$transaction(async (tx) => {
        if (body.clearExisting) {
          await tx.table.deleteMany({ where: { floorId: req.params.id } })
        }
        for (const t of body.tables) {
          await tx.table.create({
            data: {
              conceptId: floor.conceptId,
              floorId: req.params.id,
              label: t.label,
              capacity: t.capacity,
              shape: t.shape,
              x: t.x, y: t.y, width: t.width, height: t.height, rotation: t.rotation,
              floorSection: t.floorSection ?? '',
            },
          })
        }
      })

      return reply.status(201).send({ ok: true, count: body.tables.length })
    },
  )

  // Bulk save layout — one transaction, used on the editor's "Save layout" button.
  fastify.put('/layout', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const body = bulkLayoutSchema.parse(req.body)
    const floor = await prisma.floor.findFirst({
      where: {
        id: body.floorId,
        concept: { tenantId: req.staffUser!.tenantId, deletedAt: null },
      },
    })
    if (!floor) throw new NotFoundError('Floor', body.floorId)
    await assertConceptAccess(req.staffUser!, floor.conceptId)

    await prisma.$transaction(
      body.tables.map((t) =>
        prisma.table.update({
          where: { id: t.id },
          data: {
            x: t.x, y: t.y,
            ...(t.width    !== undefined && { width:    t.width }),
            ...(t.height   !== undefined && { height:   t.height }),
            ...(t.rotation !== undefined && { rotation: t.rotation }),
            ...(t.shape    !== undefined && { shape:    t.shape }),
            floorId: body.floorId,
          },
        }),
      ),
    )
    return { ok: true, count: body.tables.length }
  })

  // Live status — combines tables + currently-open orders + active reservations.
  // The live floor plan polls this every 5–10s.
  fastify.get<{ Querystring: { conceptId: string; floorId?: string } }>(
    '/status',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const { conceptId, floorId } = req.query
      await assertConceptAccess(req.staffUser!, conceptId)

      const tables = await prisma.table.findMany({
        where: {
          conceptId,
          deletedAt: null,
          ...(floorId && { floorId }),
        },
        select: { id: true, label: true, capacity: true, status: true, floorId: true, shape: true, x: true, y: true, width: true, height: true, rotation: true },
      })

      // Open orders per table (lookup by tableId)
      const tableIds = tables.map((t) => t.id)
      const openOrders = tableIds.length > 0
        ? await prisma.order.findMany({
            where: {
              tableId: { in: tableIds },
              status:  { in: ['received', 'confirmed', 'preparing', 'ready'] },
              deletedAt: null,
            },
            select: { id: true, tableId: true, status: true, totalCents: true, placedAt: true, customerName: true },
            orderBy: { placedAt: 'desc' },
          })
        : []
      const orderByTable = new Map<string, typeof openOrders>()
      for (const o of openOrders) {
        if (!o.tableId) continue
        const arr = orderByTable.get(o.tableId) ?? ([] as typeof openOrders)
        arr.push(o)
        orderByTable.set(o.tableId, arr)
      }

      // Imminent reservations (next 2 hours)
      const now    = new Date()
      const horizon = new Date(now.getTime() + 2 * 3600_000)
      const reservations = tableIds.length > 0
        ? await prisma.reservation.findMany({
            where: {
              tableId: { in: tableIds },
              status:  { in: ['booked', 'confirmed', 'seated'] },
              endTime: { gte: now },
              startTime: { lte: horizon },
            },
            select: { id: true, tableId: true, partySize: true, startTime: true, endTime: true, status: true, guestName: true, isVip: true },
          })
        : []
      const resByTable = new Map<string, typeof reservations>()
      for (const r of reservations) {
        if (!r.tableId) continue
        const arr = resByTable.get(r.tableId) ?? ([] as typeof reservations)
        arr.push(r)
        resByTable.set(r.tableId, arr)
      }

      return tables.map((t) => ({
        ...t,
        openOrders:    orderByTable.get(t.id) ?? [],
        reservations:  resByTable.get(t.id)   ?? [],
      }))
    },
  )
}
