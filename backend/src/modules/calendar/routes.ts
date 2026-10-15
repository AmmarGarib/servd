import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import type { FastifyRequest } from 'fastify'
import { requireAuth, MANAGERS, ALL_STAFF } from '../auth/middleware.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { scopeTenantWhere, assertConceptOwned, type ScopeMode, activeTenantId } from '../../lib/tenantScope.js'
import { moveToTrash, trashReasonOf } from '../../lib/trash.js'
import { takeSnapshot } from '../trash/snapshot.js'
import { TRASH_MARKETING } from '../trash/providers/masters/marketing.js'

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

// ── Company scope ────────────────────────────────────────────────────────────
// A calendar event belongs to ONE company (ContentEvent.tenantId, stamped at
// create). conceptId narrows it to a brand of that company; a null conceptId
// means "all brands of ITS company" — never every company. The old filter,
// `OR: [{ conceptId: null }, { concept: { tenantId } }]`, handed every
// company's brand-less events (and their social posts) to every other company.


/** The event, or 404 when it isn't a row of a company in `mode`. */
async function findEventInScope(req: FastifyRequest, id: string, mode: ScopeMode) {
  const event = await prisma.contentEvent.findFirst({ where: { id, ...(await scopeTenantWhere(req, mode)) } })
  if (!event) throw new NotFoundError('ContentEvent', id)
  return event
}

/** 422 unless the assignee is a staff member of `tenantId`. */
async function assertAssigneeOf(tenantId: string, assigneeId: string): Promise<void> {
  const u = await prisma.user.findFirst({
    where: {
      id: assigneeId,
      deletedAt: null,
      OR: [{ tenantId }, { tenantMemberships: { some: { tenantId } } }],
    },
    select: { id: true },
  })
  if (!u) throw new AppError('ASSIGNEE_NOT_IN_COMPANY', 'That person is not on this company\'s staff', 422)
}

export async function calendarRoutes(fastify: FastifyInstance) {
  // GET /calendar?from=&to=&department=&conceptId=&assigneeId=
  fastify.get<{
    Querystring: { from?: string; to?: string; department?: string; conceptId?: string; assigneeId?: string }
  }>('/', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const { from, to, department, conceptId, assigneeId } = req.query
    const fromDate = from ? new Date(from) : new Date(Date.now() - 7 * 864e5)
    const toDate   = to   ? new Date(to)   : new Date(Date.now() + 60 * 864e5)

    // Company scope (view-aware). Brand-less events are the owning company's
    // cross-brand tasks and are only ever shown to that company.
    return prisma.contentEvent.findMany({
      where: {
        ...(await scopeTenantWhere(req, 'read')),
        startDate: { gte: fromDate, lte: toDate },
        ...(department  ? { department }  : {}),
        ...(conceptId   ? { conceptId }   : {}),
        ...(assigneeId  ? { assigneeId }  : {}),
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
    // A new event binds to the ACTIVE company; its brand (if any) and its
    // assignee must both be of that company.
    const tenantId = activeTenantId(req)
    if (body.conceptId) await assertConceptOwned(req, body.conceptId, 'create')
    if (body.assigneeId) await assertAssigneeOf(tenantId, body.assigneeId)
    const event = await prisma.contentEvent.create({
      data: {
        tenantId,
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
    async (req) => {
      const body = eventSchema.partial().parse(req.body)
      const existing = await findEventInScope(req, req.params.id, 'write')
      // conceptId is not writable here (the data block below never sets it),
      // so the event cannot be moved to another company's brand. The assignee
      // must be staff of the event's OWN company.
      if (body.assigneeId) {
        if (!existing.tenantId) throw new NotFoundError('ContentEvent', req.params.id)
        await assertAssigneeOf(existing.tenantId, body.assigneeId)
      }

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
      const event = await findEventInScope(req, req.params.id, 'write')
      // Hard delete, but the event AND its social post (which cascades) are kept
      // whole in the Trash (finding F8: the post used to be lost with it).
      await prisma.$transaction(async (tx) => {
        const post = await tx.socialPost.findUnique({ where: { eventId: event.id } })
        await moveToTrash(tx, req, {
          type: TRASH_MARKETING.content_event, entityId: event.id, tenantId: event.tenantId, conceptId: event.conceptId,
          title: event.title, subtitle: `${event.type}${post ? ` · ${post.platform} post` : ''}`, reason: trashReasonOf(req),
          parent: event.conceptId ? { type: 'brand', id: event.conceptId } : null,
          snapshot: takeSnapshot('ContentEvent', event, post ? { SocialPost: [post] } : {}),
        })
        await tx.contentEvent.delete({ where: { id: event.id } })
      })
      return reply.status(204).send()
    },
  )

  // POST /calendar/:id/social-post — attach a social post to an event
  fastify.post<{ Params: { id: string } }>(
    '/:id/social-post',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const body = socialPostSchema.parse(req.body)
      await findEventInScope(req, req.params.id, 'write')

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
      where: { event: await scopeTenantWhere(req, 'read') },
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
          event: await scopeTenantWhere(req, 'write'),
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
