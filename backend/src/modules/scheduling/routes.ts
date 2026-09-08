import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS, ALL_STAFF } from '../auth/middleware.js'
import { assertConceptAccess } from '../../lib/conceptAccess.js'
import { NotFoundError } from '../../lib/errors.js'
import { scopeTenantWhere } from '../../lib/tenantScope.js'

const shiftSchema = z.object({
  userId: z.string().uuid(),
  conceptId: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  startTime: z.string().regex(/^\d{2}:\d{2}$/, 'startTime must be HH:MM'),
  endTime: z.string().regex(/^\d{2}:\d{2}$/, 'endTime must be HH:MM'),
  role: z.string().optional(),
  notes: z.string().optional(),
})

/** True when [startA, endA) overlaps [startB, endB) using HH:MM strings */
function timesOverlap(startA: string, endA: string, startB: string, endB: string): boolean {
  return startA < endB && endA > startB
}

/** Build a Mon 00:00 UTC / Sun 23:59:59.999 UTC pair from any date string */
function weekBounds(weekStart: string): { mon: Date; sun: Date } {
  const anchor = new Date(weekStart)
  const dow = anchor.getUTCDay()
  const mon = new Date(anchor)
  mon.setUTCDate(anchor.getUTCDate() - ((dow + 6) % 7))
  mon.setUTCHours(0, 0, 0, 0)
  const sun = new Date(mon)
  sun.setUTCDate(mon.getUTCDate() + 6)
  sun.setUTCHours(23, 59, 59, 999)
  return { mon, sun }
}

export async function schedulingRoutes(fastify: FastifyInstance) {
  // GET /scheduling?conceptId=X&weekStart=YYYY-MM-DD
  fastify.get<{ Querystring: { conceptId: string; weekStart?: string } }>(
    '/',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const { conceptId, weekStart } = req.query
      await assertConceptAccess(req.staffUser!, conceptId)

      const { mon, sun } = weekBounds(weekStart ?? new Date().toISOString().slice(0, 10))

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

      // Conflict detection: check for any overlapping shift for this user on this date
      const conflict = await prisma.scheduledShift.findFirst({
        where: {
          userId: body.userId,
          date: new Date(body.date),
        },
      })
      if (conflict && timesOverlap(body.startTime, body.endTime, conflict.startTime, conflict.endTime)) {
        return reply.status(409).send({
          error: {
            code: 'SHIFT_CONFLICT',
            message: `Staff already scheduled ${conflict.startTime}–${conflict.endTime} on this date`,
          },
        })
      }

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
    async (req, reply) => {
      const body = shiftSchema.partial().parse(req.body)
      // Scope the lookup itself. assertConceptAccess below is a per-user brand
      // whitelist that no-ops for every management role, so on its own it let a
      // manager at one company edit another company's rota.
      const existing = await prisma.scheduledShift.findFirst({
        where: { id: req.params.id, concept: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) } },
      })
      if (!existing) throw new NotFoundError('ScheduledShift', req.params.id)
      await assertConceptAccess(req.staffUser!, existing.conceptId)

      // Resolve effective values after patch for overlap check
      const effectiveUserId = body.userId ?? existing.userId
      const effectiveDate = body.date ? new Date(body.date) : existing.date
      const effectiveStart = body.startTime ?? existing.startTime
      const effectiveEnd = body.endTime ?? existing.endTime

      // Conflict detection: exclude this shift itself
      const conflict = await prisma.scheduledShift.findFirst({
        where: {
          userId: effectiveUserId,
          date: effectiveDate,
          id: { not: req.params.id },
        },
      })
      if (conflict && timesOverlap(effectiveStart, effectiveEnd, conflict.startTime, conflict.endTime)) {
        return reply.status(409).send({
          error: {
            code: 'SHIFT_CONFLICT',
            message: `Staff already scheduled ${conflict.startTime}–${conflict.endTime} on this date`,
          },
        })
      }

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
      const existing = await prisma.scheduledShift.findFirst({
        where: { id: req.params.id, concept: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) } },
      })
      if (!existing) throw new NotFoundError('ScheduledShift', req.params.id)
      await assertConceptAccess(req.staffUser!, existing.conceptId)
      await prisma.scheduledShift.delete({ where: { id: existing.id } })
      return reply.status(204).send()
    },
  )

  // POST /scheduling/copy-week
  const copyWeekSchema = z.object({
    conceptId: z.string().uuid(),
    sourceWeekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    targetWeekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })

  fastify.post(
    '/copy-week',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const body = copyWeekSchema.parse(req.body)
      await assertConceptAccess(req.staffUser!, body.conceptId)

      const sourceStart = new Date(body.sourceWeekStart)
      const targetStart = new Date(body.targetWeekStart)

      // Verify both are Mondays (day of week = 1 in UTC)
      if (sourceStart.getUTCDay() !== 1) {
        return reply.status(400).send({
          error: { code: 'INVALID_WEEK_START', message: 'sourceWeekStart must be a Monday (YYYY-MM-DD)' },
        })
      }
      if (targetStart.getUTCDay() !== 1) {
        return reply.status(400).send({
          error: { code: 'INVALID_WEEK_START', message: 'targetWeekStart must be a Monday (YYYY-MM-DD)' },
        })
      }

      const offsetDays = Math.round(
        (targetStart.getTime() - sourceStart.getTime()) / (1000 * 60 * 60 * 24),
      )

      const { mon: sourceMon, sun: sourceSun } = weekBounds(body.sourceWeekStart)

      const sourceShifts = await prisma.scheduledShift.findMany({
        where: { conceptId: body.conceptId, date: { gte: sourceMon, lte: sourceSun } },
      })

      let created = 0
      let skipped = 0

      for (const shift of sourceShifts) {
        const newDate = new Date(shift.date)
        newDate.setUTCDate(newDate.getUTCDate() + offsetDays)

        try {
          await prisma.scheduledShift.create({
            data: {
              userId: shift.userId,
              conceptId: shift.conceptId,
              date: newDate,
              startTime: shift.startTime,
              endTime: shift.endTime,
              role: shift.role,
              notes: shift.notes,
            },
          })
          created++
        } catch (err: any) {
          // Unique/constraint violations are counted as skipped; other errors bubble up
          const code: string = err?.code ?? ''
          if (code === 'P2002' || code === 'P2003' || code === 'P2004') {
            skipped++
          } else {
            throw err
          }
        }
      }

      return reply.status(200).send({ created, skipped })
    },
  )

  // GET /scheduling/labor-cost?conceptId=X&weekStart=YYYY-MM-DD
  fastify.get<{ Querystring: { conceptId: string; weekStart: string } }>(
    '/labor-cost',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const { conceptId, weekStart } = req.query
      if (!conceptId || !weekStart) {
        return reply.status(400).send({ error: { code: 'MISSING_PARAMS', message: 'conceptId and weekStart are required' } })
      }
      await assertConceptAccess(req.staffUser!, conceptId)

      const { mon, sun } = weekBounds(weekStart)

      const shifts = await prisma.scheduledShift.findMany({
        where: { conceptId, date: { gte: mon, lte: sun } },
        include: { user: { select: { id: true, name: true, hourlyRateCents: true } } },
      })

      /** Parse HH:MM into total minutes */
      const toMinutes = (hhmm: string): number => {
        const parts = hhmm.split(':').map(Number)
        return (parts[0] ?? 0) * 60 + (parts[1] ?? 0)
      }

      type ByUserEntry = {
        userId: string
        name: string
        hours: number
        rateCents: number
        totalCents: number
        rateUnset: boolean
      }

      const byUserMap = new Map<string, ByUserEntry>()

      let totalHours = 0
      let totalCents = 0

      for (const shift of shifts) {
        const durationMinutes = toMinutes(shift.endTime) - toMinutes(shift.startTime)
        const hours = durationMinutes / 60
        const rateUnset = shift.user.hourlyRateCents == null
        const rateCents = shift.user.hourlyRateCents ?? 0
        const shiftCost = Math.round(hours * rateCents)

        totalHours += hours
        totalCents += shiftCost

        const existing = byUserMap.get(shift.userId)
        if (existing) {
          existing.hours += hours
          existing.totalCents += shiftCost
          // propagate rateUnset if any shift for this user is unset
          if (rateUnset) existing.rateUnset = true
        } else {
          byUserMap.set(shift.userId, {
            userId: shift.userId,
            name: shift.user.name,
            hours,
            rateCents,
            totalCents: shiftCost,
            rateUnset,
          })
        }
      }

      // Round accumulated hours to 2 decimal places for each user
      const byUser = Array.from(byUserMap.values()).map((u) => ({
        ...u,
        hours: Math.round(u.hours * 100) / 100,
        totalCents: u.totalCents,
      }))

      return {
        totalHours: Math.round(totalHours * 100) / 100,
        totalCents,
        byUser,
      }
    },
  )

  // POST /scheduling/swap-request
  const swapRequestSchema = z.object({
    shiftId: z.string().uuid(),                                  // B08
    requestedFromUserId: z.string().uuid(),
    notes: z.string().optional(),
  })

  fastify.post(
    '/swap-request',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req, reply) => {
      const body = swapRequestSchema.parse(req.body)
      const requestedByUserId = req.staffUser!.id

      const shift = await prisma.scheduledShift.findUnique({ where: { id: body.shiftId } })
      if (!shift) throw new NotFoundError('ScheduledShift', body.shiftId)
      await assertConceptAccess(req.staffUser!, shift.conceptId)

      const swapRequest = await prisma.shiftSwapRequest.create({
        data: {
          shiftId: body.shiftId,
          requestedByUserId,
          requestedFromUserId: body.requestedFromUserId,
          notes: body.notes,
          status: 'pending',
        },
      })

      return reply.status(201).send(swapRequest)
    },
  )

  // GET /scheduling/swap-requests?conceptId=X
  fastify.get<{ Querystring: { conceptId: string } }>(
    '/swap-requests',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const { conceptId } = req.query
      await assertConceptAccess(req.staffUser!, conceptId)

      const requests = await prisma.shiftSwapRequest.findMany({
        where: { shift: { conceptId } },
        include: {
          shift: {
            select: { id: true, date: true, startTime: true, endTime: true, userId: true, conceptId: true },
          },
        },
        orderBy: { createdAt: 'desc' },
      })

      return requests
    },
  )

  // PATCH /scheduling/swap-requests/:id
  const swapActionSchema = z.object({
    action: z.enum(['approve', 'reject']),
  })

  fastify.patch<{ Params: { id: string } }>(
    '/swap-requests/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const { action } = swapActionSchema.parse(req.body)

      const swapRequest = await prisma.shiftSwapRequest.findFirst({
        where: {
          id: req.params.id,
          shift: { concept: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) } },
        },
        include: { shift: true },
      })
      if (!swapRequest) throw new NotFoundError('ShiftSwapRequest', req.params.id)
      await assertConceptAccess(req.staffUser!, swapRequest.shift.conceptId)

      if (swapRequest.status !== 'pending') {
        return reply.status(409).send({
          error: { code: 'ALREADY_RESOLVED', message: `Swap request is already ${swapRequest.status}` },
        })
      }

      if (action === 'reject') {
        const updated = await prisma.shiftSwapRequest.update({
          where: { id: req.params.id },
          data: { status: 'rejected' },
        })
        return updated
      }

      // action === 'approve'
      const { shift } = swapRequest

      // Look for a matching shift owned by the "from" user on the same date+time
      const fromUserShift = await prisma.scheduledShift.findFirst({
        where: {
          userId: swapRequest.requestedFromUserId,
          conceptId: shift.conceptId,
          date: shift.date,
          startTime: shift.startTime,
          endTime: shift.endTime,
        },
      })

      if (fromUserShift) {
        // Swap userIds between the two shifts
        await prisma.$transaction([
          prisma.scheduledShift.update({
            where: { id: shift.id },
            data: { userId: swapRequest.requestedFromUserId },
          }),
          prisma.scheduledShift.update({
            where: { id: fromUserShift.id },
            data: { userId: swapRequest.requestedByUserId },
          }),
        ])
      } else {
        // No matching shift for the other user — just reassign the original shift to them
        await prisma.scheduledShift.update({
          where: { id: shift.id },
          data: { userId: swapRequest.requestedFromUserId },
        })
      }

      const updated = await prisma.shiftSwapRequest.update({
        where: { id: req.params.id },
        data: { status: 'approved' },
      })

      return updated
    },
  )
}
