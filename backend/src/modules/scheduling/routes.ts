import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS, ALL_STAFF } from '../auth/middleware.js'
import { assertConceptAccess } from '../../lib/conceptAccess.js'
import { NotFoundError } from '../../lib/errors.js'

const shiftSchema = z.object({
  userId: z.string().uuid(),
  conceptId: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  startTime: z.string().regex(/^\d{2}:\d{2}$/, 'startTime must be HH:MM'),
  endTime: z.string().regex(/^\d{2}:\d{2}$/, 'endTime must be HH:MM'),
  role: z.string().optional(),
  notes: z.string().optional(),
})

export async function schedulingRoutes(fastify: FastifyInstance) {
  // GET /scheduling?conceptId=X&weekStart=YYYY-MM-DD
  fastify.get<{ Querystring: { conceptId: string; weekStart?: string } }>(
    '/',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const { conceptId, weekStart } = req.query
      await assertConceptAccess(req.staffUser!, conceptId)

      // Default to current week (Mon–Sun). All arithmetic in UTC to avoid
      // timezone-induced off-by-one when the server runs in a non-UTC TZ.
      const anchor = weekStart ? new Date(weekStart) : new Date()
      const dow = anchor.getUTCDay()
      const mon = new Date(anchor)
      mon.setUTCDate(anchor.getUTCDate() - ((dow + 6) % 7))
      mon.setUTCHours(0, 0, 0, 0)
      const sun = new Date(mon)
      sun.setUTCDate(mon.getUTCDate() + 6)
      sun.setUTCHours(23, 59, 59, 999)

      const shifts = await prisma.scheduledShift.findMany({
        where: { conceptId, date: { gte: mon, lte: sun } },
        include: { user: { select: { id: true, name: true, role: true } } },
        orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
      })

      // Staff roster for the concept (for the assignment UI)
      const staff = await prisma.user.findMany({
        where: {
          deletedAt: null,
          OR: [{ conceptIds: { isEmpty: true } }, { conceptIds: { has: conceptId } }],
        },
        select: { id: true, name: true, role: true },
        orderBy: { name: 'asc' },
      })

      return {
        weekStart: mon.toISOString().slice(0, 10),
        weekEnd: sun.toISOString().slice(0, 10),
        shifts,
        staff,
      }
    },
  )

  // POST /scheduling
  fastify.post(
    '/',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const body = shiftSchema.parse(req.body)
      await assertConceptAccess(req.staffUser!, body.conceptId)

      const shift = await prisma.scheduledShift.create({
        data: {
          userId: body.userId,
          conceptId: body.conceptId,
          date: new Date(body.date),
          startTime: body.startTime,
          endTime: body.endTime,
          role: body.role,
          notes: body.notes,
        },
        include: { user: { select: { id: true, name: true, role: true } } },
      })
      return reply.status(201).send(shift)
    },
  )

  // PATCH /scheduling/:id
  fastify.patch<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const body = shiftSchema.partial().parse(req.body)
      const existing = await prisma.scheduledShift.findUnique({ where: { id: req.params.id } })
      if (!existing) throw new NotFoundError('ScheduledShift', req.params.id)
      await assertConceptAccess(req.staffUser!, existing.conceptId)

      return prisma.scheduledShift.update({
        where: { id: req.params.id },
        data: {
          ...(body.userId && { userId: body.userId }),
          ...(body.date && { date: new Date(body.date) }),
          ...(body.startTime && { startTime: body.startTime }),
          ...(body.endTime && { endTime: body.endTime }),
          ...(body.role !== undefined && { role: body.role }),
          ...(body.notes !== undefined && { notes: body.notes }),
        },
        include: { user: { select: { id: true, name: true, role: true } } },
      })
    },
  )

  // DELETE /scheduling/:id
  fastify.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const existing = await prisma.scheduledShift.findUnique({ where: { id: req.params.id } })
      if (!existing) throw new NotFoundError('ScheduledShift', req.params.id)
      await assertConceptAccess(req.staffUser!, existing.conceptId)
      await prisma.scheduledShift.delete({ where: { id: req.params.id } })
      return reply.status(204).send()
    },
  )
}
