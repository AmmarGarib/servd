import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS, ALL_STAFF } from '../auth/middleware.js'

const EVENT_TYPES = ['social_post','menu_change','seasonal_ingredient','deal','shoot','event_promo','reminder','task'] as const
const EVENT_STATUSES = ['draft','scheduled','live','done','cancelled'] as const

const eventSchema = z.object({
  title:       z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  type:        z.enum(EVENT_TYPES),
  startDate:   z.string().datetime(),
  endDate:     z.string().datetime().optional(),
  allDay:      z.boolean().default(true),
  status:      z.enum(EVENT_STATUSES).default('draft'),
  conceptId:   z.string().uuid().optional(),
  assigneeId:  z.string().uuid().optional(),
  department:  z.string().max(50).optional(),
  color:       z.string().max(20).optional(),
  metadata:    z.record(z.unknown()).optional(),
})

const socialPostSchema = z.object({
  platform:     z.enum(['instagram','facebook','tiktok']),
  caption:      z.string().min(1).max(2200),
  mediaUrls:    z.array(z.string().url()).max(10).default([]),
  scheduledFor: z.string().datetime(),
})

export async function calendarRoutes(fastify: FastifyInstance) {
  // GET /calendar?from=&to=&department=&conceptId=&assigneeId=
  fastify.get<{
    Querystring: { from?: string; to?: string; department?: string; conceptId?: string; assigneeId?: string }
  }>('/', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const { from, to, department, conceptId, assigneeId } = req.query
    const fromDate = from ? new Date(from) : new Date(Date.now() - 7 * 864e5)
    const toDate   = to   ? new Date(to)   : new Date(Date.now() + 60 * 864e5)

    // Tenant scope: include events scoped to a concept under the active
    // tenant, or events with no concept (cross-brand internal tasks).
    return prisma.contentEvent.findMany({
      where: {
        startDate: { gte: fromDate, lte: toDate },
        ...(department  ? { department }  : {}),
        ...(conceptId   ? { conceptId }   : {}),
        ...(assigneeId  ? { assigneeId }  : {}),
        OR: [
          { conceptId: null },
          { concept: { tenantId: req.staffUser!.tenantId, deletedAt: null } },
        ],
      },
      include: {
        assignee:   { select: { id: true, name: true } },
        createdBy:  { select: { id: true, name: true } },
        socialPost: true,
      },
      orderBy: { startDate: 'asc' },
    })
  })

  // POST /calendar
  fastify.post('/', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = eventSchema.parse(req.body)
    // If a concept is referenced, verify it's in the active tenant.
    if (body.conceptId) {
      const concept = await prisma.concept.findFirst({
        where: { id: body.conceptId, tenantId: req.staffUser!.tenantId, deletedAt: null },
      })
      if (!concept) return reply.status(403).send({ error: { code: 'CROSS_TENANT', message: 'Concept does not belong to your active company' } })
    }
    const event = await prisma.contentEvent.create({
      data: {
        title:       body.title,
        description: body.description,
        type:        body.type,
        status:      body.status,
        allDay:      body.allDay,
        department:  body.department,
        color:       body.color,
        conceptId:   body.conceptId,
        assigneeId:  body.assigneeId,
        metadata:    body.metadata as never ?? undefined,
        startDate:   new Date(body.startDate),
        endDate:     body.endDate ? new Date(body.endDate) : null,
        createdById: req.staffUser!.id,
      },
      include: {
        assignee:  { select: { id: true, name: true } },
        createdBy: { select: { id: true, name: true } },
        socialPost: true,
      },
    })
    return reply.status(201).send(event)
  })

  // PATCH /calendar/:id
  fastify.patch<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const body = eventSchema.partial().parse(req.body)
      const existing = await prisma.contentEvent.findFirst({
        where: {
          id: req.params.id,
          OR: [
            { conceptId: null },
            { concept: { tenantId: req.staffUser!.tenantId, deletedAt: null } },
          ],
        },
      })
      if (!existing) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Event not found in your active company' } })

      return prisma.contentEvent.update({
        where: { id: req.params.id },
        data: {
          title:       body.title,
          description: body.description,
          type:        body.type,
          status:      body.status,
          allDay:      body.allDay,
          department:  body.department,
          color:       body.color,
          metadata:    body.metadata as never ?? undefined,
          assigneeId:  body.assigneeId,
          startDate:   body.startDate ? new Date(body.startDate) : undefined,
          endDate:     body.endDate   ? new Date(body.endDate)   : undefined,
        },
        include: {
          assignee:  { select: { id: true, name: true } },
          createdBy: { select: { id: true, name: true } },
          socialPost: true,
        },
      })
    },
  )

  // DELETE /calendar/:id
  fastify.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const existing = await prisma.contentEvent.findFirst({
        where: {
          id: req.params.id,
          OR: [
            { conceptId: null },
            { concept: { tenantId: req.staffUser!.tenantId, deletedAt: null } },
          ],
        },
      })
      if (!existing) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Event not found in your active company' } })
      await prisma.contentEvent.delete({ where: { id: req.params.id } })
      return reply.status(204).send()
    },
  )

  // POST /calendar/:id/social-post — attach a social post to an event
  fastify.post<{ Params: { id: string } }>(
    '/:id/social-post',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const body = socialPostSchema.parse(req.body)
      const event = await prisma.contentEvent.findFirst({
        where: {
          id: req.params.id,
          OR: [
            { conceptId: null },
            { concept: { tenantId: req.staffUser!.tenantId, deletedAt: null } },
          ],
        },
      })
      if (!event) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Event not found in your active company' } })

      const post = await prisma.socialPost.upsert({
        where:  { eventId: req.params.id },
        create: {
          eventId:      req.params.id,
          platform:     body.platform,
          caption:      body.caption,
          mediaUrls:    body.mediaUrls,
          scheduledFor: new Date(body.scheduledFor),
          status:       'scheduled',
        },
        update: {
          platform:     body.platform,
          caption:      body.caption,
          mediaUrls:    body.mediaUrls,
          scheduledFor: new Date(body.scheduledFor),
          status:       'scheduled',
        },
      })
      // Also mark the parent event as scheduled
      await prisma.contentEvent.update({
        where: { id: req.params.id },
        data:  { status: 'scheduled' },
      })
      return reply.status(201).send(post)
    },
  )

  // GET /calendar/social/status — social posts under the active tenant
  fastify.get('/social/status', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const posts = await prisma.socialPost.findMany({
      where: {
        event: {
          OR: [
            { conceptId: null },
            { concept: { tenantId: req.staffUser!.tenantId, deletedAt: null } },
          ],
        },
      },
      include: { event: { select: { id: true, title: true, startDate: true } } },
      orderBy: { scheduledFor: 'desc' },
      take: 100,
    })
    return posts
  })

  // POST /calendar/social/:id/retry — re-queue a failed post
  fastify.post<{ Params: { id: string } }>(
    '/social/:id/retry',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const post = await prisma.socialPost.findFirst({
        where: {
          id: req.params.id,
          event: {
            OR: [
              { conceptId: null },
              { concept: { tenantId: req.staffUser!.tenantId, deletedAt: null } },
            ],
          },
        },
      })
      if (!post) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Social post not found in your active company' } })
      return prisma.socialPost.update({
        where: { id: req.params.id },
        data:  { status: 'scheduled', error: null },
      })
    },
  )
}
