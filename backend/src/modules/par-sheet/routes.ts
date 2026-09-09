// Par-sheet routes â€” daily prep tracking.
//
// One row per (tenant Ã— component Ã— date). The prep team updates `actualCount`
// throughout the morning; the orders pipeline decrements it as components
// fire on the line. Expo sees the master sheet in red where actual < 25% of
// target so they can shift labor before service starts.

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, ALL_STAFF, MANAGERS } from '../auth/middleware.js'
import { NotFoundError } from '../../lib/errors.js'

// Midnight UTC of the requested service day (or today if none).
function dayKey(input?: string): Date {
  const d = input ? new Date(input) : new Date()
  d.setUTCHours(0, 0, 0, 0)
  return d
}

export async function parSheetRoutes(fastify: FastifyInstance) {

  // GET /par-sheet?date=YYYY-MM-DD
  // Returns every Component for the tenant + the day's par row (or nulls if
  // the morning rollover hasn't been done yet). Expo sees this on /expo.
  fastify.get<{ Querystring: { date?: string } }>(
    '/',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const tenantId = req.staffUser!.tenantId
      const tenantFilter = req.staffUser!.tenantFilter
      if (!tenantId) return []
      const date = dayKey(req.query.date)

      // Components are shared across tenants today (the Component model has
      // no tenantId yet). Pull all active ones; future migration will scope
      // by tenant via ComponentBrandUse.
      const components = await prisma.component.findMany({
        where: { isActive: true, deletedAt: null },
        orderBy: [{ type: 'asc' }, { name: 'asc' }],
        select: { id: true, name: true, type: true, yieldGrams: true },
      })

      const rows = await prisma.componentParLevel.findMany({
        where: { tenantId, date, componentId: { in: components.map((c) => c.id) } },
      })
      const rowsBy = new Map(rows.map((r) => [r.componentId, r]))

      return components.map((c) => {
        const r = rowsBy.get(c.id)
        return {
          componentId:   c.id,
          name:          c.name,
          type:          c.type,
          target:        r?.targetCount ?? 0,
          actual:        r?.actualCount ?? 0,
          unit:          r?.unit ?? null,
          notes:         r?.notes ?? null,
          updatedAt:     r?.updatedAt ?? null,
          updatedById:   r?.updatedById ?? null,
        }
      })
    },
  )

  // PUT /par-sheet/:componentId â€” upsert today's row. Prep cooks call this
  // when they finish a batch; expo calls it in the morning to set targets.
  fastify.put<{ Params: { componentId: string }; Body: Record<string, unknown> }>(
    '/:componentId',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req, reply) => {
      const body = z.object({
        date:    z.string().optional(),
        target:  z.number().min(0).optional(),
        actual:  z.number().min(0).optional(),
        unit:    z.string().max(40).nullable().optional(),
        notes:   z.string().max(280).nullable().optional(),
      }).parse(req.body)

      const tenantId = req.staffUser!.tenantId
      const tenantFilter = req.staffUser!.tenantFilter
      if (!tenantId) return reply.status(400).send({ error: { code: 'NO_TENANT', message: 'No active tenant' } })

      const date = dayKey(body.date)
      const componentId = req.params.componentId

      // Sanity check the component exists.
      const c = await prisma.component.findUnique({ where: { id: componentId } })
      if (!c) throw new NotFoundError('Component', componentId)

      const updated = await prisma.componentParLevel.upsert({
        where:  { tenantId_componentId_date: { tenantId, componentId, date } },
        create: {
          tenantId, componentId, date,
          targetCount: body.target ?? 0,
          actualCount: body.actual ?? 0,
          unit:        body.unit ?? null,
          notes:       body.notes ?? null,
          updatedById: req.staffUser!.id,
        },
        update: {
          ...(body.target !== undefined && { targetCount: body.target }),
          ...(body.actual !== undefined && { actualCount: body.actual }),
          ...(body.unit !== undefined   && { unit:        body.unit }),
          ...(body.notes !== undefined  && { notes:       body.notes }),
          updatedById: req.staffUser!.id,
        },
      })
      return reply.status(200).send(updated)
    },
  )

  // POST /par-sheet/:componentId/adjust â€” atomic increment/decrement of
  // `actual`. Used by prep cooks to log "made 5 more trays" without a
  // read-modify-write race.
  fastify.post<{ Params: { componentId: string }; Body: { delta: number; date?: string } }>(
    '/:componentId/adjust',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req, reply) => {
      const body = z.object({
        delta: z.number(),
        date:  z.string().optional(),
      }).parse(req.body)
      const tenantId = req.staffUser!.tenantId
      const tenantFilter = req.staffUser!.tenantFilter
      if (!tenantId) return reply.status(400).send({ error: { code: 'NO_TENANT', message: 'No active tenant' } })
      const date = dayKey(body.date)

      // Upsert with the delta â€” if the row doesn't exist, create at delta;
      // else increment.
      const updated = await prisma.componentParLevel.upsert({
        where:  { tenantId_componentId_date: { tenantId, componentId: req.params.componentId, date } },
        create: {
          tenantId, componentId: req.params.componentId, date,
          actualCount: Math.max(0, body.delta),
          updatedById: req.staffUser!.id,
        },
        update: {
          actualCount: { increment: body.delta },
          updatedById: req.staffUser!.id,
        },
      })
      return reply.status(200).send(updated)
    },
  )

  // POST /par-sheet/rollover â€” bulk-create today's rows by copying yesterday's
  // targets. Expo calls this once each morning. Idempotent.
  fastify.post(
    '/rollover',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const tenantId = req.staffUser!.tenantId
      const tenantFilter = req.staffUser!.tenantFilter
      if (!tenantId) return reply.status(400).send({ error: { code: 'NO_TENANT', message: 'No active tenant' } })
      const today = dayKey()
      const yest = new Date(today); yest.setUTCDate(yest.getUTCDate() - 1)

      const yesterdays = await prisma.componentParLevel.findMany({
        where: { tenantId, date: yest },
      })
      let copied = 0
      for (const y of yesterdays) {
        try {
          await prisma.componentParLevel.create({
            data: {
              tenantId, componentId: y.componentId, date: today,
              targetCount: y.targetCount,
              actualCount: 0,
              unit:        y.unit,
              updatedById: req.staffUser!.id,
            },
          })
          copied++
        } catch (e) {
          // Unique constraint â€” row already exists for today, skip.
          if ((e as { code?: string }).code !== 'P2002') throw e
        }
      }
      return reply.status(200).send({ ok: true, copied })
    },
  )
}
