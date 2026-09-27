import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { ScopeMode } from '../../lib/tenantScope.js'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS, ALL_STAFF } from '../auth/middleware.js'
import { NotFoundError, AppError } from '../../lib/errors.js'
import { randomUUID } from 'crypto'
import { deliverToSupplier } from '../../lib/supplier-channels.js'
import { supplierScopeWhere, findSupplierInScope } from './scope.js'

// Company scope: a conversation and a portal token belong to their supplier's
// company, so both scope through the supplier (./scope.ts) — reads 'read',
// replies/new threads/tokens 'write'. Non-managers only ever see their own
// threads. Foreign ids are 404. The public /supplier-portal/:token routes are
// scoped by the token itself (one supplier's threads).

/**
 * The conversation, through its supplier's company, or 404. Non-managers
 * only reach their own threads (the list only ever showed them those).
 */
async function findConversationInScope(req: FastifyRequest, id: string, mode: ScopeMode) {
  const user = req.staffUser!
  const isManager = (MANAGERS as string[]).includes(user.role)
  const conv = await prisma.supplierConversation.findFirst({
    where: {
      id,
      supplier: await supplierScopeWhere(req, mode),
      ...(isManager ? {} : { staffId: user.id }),
    },
    include: { supplier: true },
  })
  if (!conv) throw new NotFoundError('Conversation', id)
  return conv
}

export async function supplierChatRoutes(fastify: FastifyInstance) {
  // ─── Conversations ──────────────────────────────────────────────────────────

  // GET /procurement/conversations — list all conversations for this user
  fastify.get('/conversations', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const user = req.staffUser!
    const isManager = (MANAGERS as string[]).includes(user.role)

    return prisma.supplierConversation.findMany({
      where: {
        supplier: await supplierScopeWhere(req, 'read'),
        ...(isManager ? {} : { staffId: user.id }),
      },
      include: {
        supplier: { select: { id: true, name: true, category: true } },
        staff:    { select: { id: true, name: true } },
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
        _count: { select: { messages: true } },
      },
      orderBy: { updatedAt: 'desc' },
    })
  })

  // POST /procurement/conversations — start a conversation
  fastify.post(
    '/conversations',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req, reply) => {
      const body = z.object({
        supplierId: z.string().uuid(),
        subject:    z.string().max(200).optional(),
        message:    z.string().min(1).max(5000),
      }).parse(req.body)

      // Messaging a supplier emails/WhatsApps it on this company's behalf —
      // only a supplier of a company the operator belongs to.
      const supplier = await findSupplierInScope(req, body.supplierId, 'write', { live: true })

      const conversation = await prisma.supplierConversation.create({
        data: {
          supplierId: body.supplierId,
          staffId:    req.staffUser!.id,
          subject:    body.subject,
          messages: {
            create: {
              fromStaff: true,
              senderId:  req.staffUser!.id,
              body:      body.message,
              channel:   'web_portal',
            },
          },
        },
        include: {
          supplier: { select: { id: true, name: true, category: true } },
          staff:    { select: { id: true, name: true } },
          messages: true,
        },
      })

      // Fire-and-forget: notify supplier via email + WhatsApp on the side. We
      // don't block the 201 response or fail the request if delivery hits
      // network errors — the canonical message is already saved and the
      // supplier will see it when they open the portal anyway.
      void deliverToSupplier({
        conversation: { id: conversation.id, subject: conversation.subject },
        supplier:     { id: supplier.id, name: supplier.name, email: supplier.email, whatsappPhone: supplier.whatsappPhone, phone: supplier.phone },
        body:         body.message,
        fromStaffName: req.staffUser!.name ?? 'servd',
        isFirstMessage: true,
      }).catch((err) => console.error(`[chat] fan-out failed for conv=${conversation.id}:`, (err as Error).message))

      return reply.status(201).send(conversation)
    },
  )

  // GET /procurement/conversations/:id/messages
  fastify.get<{ Params: { id: string } }>(
    '/conversations/:id/messages',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const conv = await findConversationInScope(req, req.params.id, 'read')

      // Mark supplier messages seen
      await prisma.supplierMessage.updateMany({
        where: { conversationId: conv.id, fromStaff: false, seenAt: null },
        data:  { seenAt: new Date() },
      })

      return prisma.supplierMessage.findMany({
        where:   { conversationId: conv.id },
        orderBy: { createdAt: 'asc' },
      })
    },
  )

  // POST /procurement/conversations/:id/messages — staff sends a message
  fastify.post<{ Params: { id: string } }>(
    '/conversations/:id/messages',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req, reply) => {
      const body = z.object({
        body:     z.string().min(1).max(5000),
        mediaUrl: z.string().url().optional(),
      }).parse(req.body)

      const conv = await findConversationInScope(req, req.params.id, 'write')

      const message = await prisma.supplierMessage.create({
        data: {
          conversationId: req.params.id,
          fromStaff:      true,
          senderId:       req.staffUser!.id,
          body:           body.body,
          mediaUrl:       body.mediaUrl,
          channel:        'web_portal',
        },
      })
      await prisma.supplierConversation.update({
        where: { id: req.params.id },
        data:  { updatedAt: new Date() },
      })

      // Best-effort fan-out — see POST /conversations above for rationale.
      void deliverToSupplier({
        conversation: { id: conv.id, subject: conv.subject },
        supplier:     { id: conv.supplier.id, name: conv.supplier.name, email: conv.supplier.email, whatsappPhone: conv.supplier.whatsappPhone, phone: conv.supplier.phone },
        body:         body.body,
        fromStaffName: req.staffUser!.name ?? 'servd',
        isFirstMessage: false,
      }).catch((err) => console.error(`[chat] fan-out failed for conv=${conv.id}:`, (err as Error).message))

      return reply.status(201).send(message)
    },
  )

  // ─── Supplier portal tokens ─────────────────────────────────────────────────

  // POST /procurement/suppliers/:id/portal-token — generate invite link
  fastify.post<{ Params: { id: string } }>(
    '/suppliers/:id/portal-token',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const body = z.object({ label: z.string().optional() }).parse(req.body ?? {})
      // A token opens the supplier's threads to anyone holding the link —
      // only for a supplier of a company the operator belongs to.
      await findSupplierInScope(req, req.params.id, 'write', { live: true })

      const token = await prisma.supplierPortalToken.create({
        data: { supplierId: req.params.id, label: body.label },
      })
      return reply.status(201).send(token)
    },
  )

  // GET /procurement/suppliers/:id/portal-tokens — list all tokens for a supplier
  fastify.get<{ Params: { id: string } }>(
    '/suppliers/:id/portal-tokens',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      // The tokens are live secrets: only for a supplier in scope.
      await findSupplierInScope(req, req.params.id, 'read')
      return prisma.supplierPortalToken.findMany({
        where: { supplierId: req.params.id },
        orderBy: { createdAt: 'desc' },
      })
    },
  )

  // ─── Supplier portal (public — token auth only) ─────────────────────────────

  // GET /supplier-portal/:token — verify token + get conversation list
  fastify.get<{ Params: { token: string } }>(
    '/supplier-portal/:token',
    async (req) => {
      const tokenRow = await prisma.supplierPortalToken.findUnique({
        where: { token: req.params.token },
        include: { supplier: { select: { id: true, name: true, category: true } } },
      })
      if (!tokenRow) throw new AppError('INVALID_TOKEN', 'Invalid portal link', 404)
      if (tokenRow.expiresAt && tokenRow.expiresAt < new Date()) {
        throw new AppError('TOKEN_EXPIRED', 'This portal link has expired', 410)
      }

      await prisma.supplierPortalToken.update({
        where: { id: tokenRow.id },
        data:  { lastUsedAt: new Date() },
      })

      const conversations = await prisma.supplierConversation.findMany({
        where: { supplierId: tokenRow.supplierId },
        include: {
          staff:   { select: { id: true, name: true } },
          messages: { orderBy: { createdAt: 'desc' }, take: 1 },
          _count:  { select: { messages: true } },
        },
        orderBy: { updatedAt: 'desc' },
      })

      return { supplier: tokenRow.supplier, conversations }
    },
  )

  // GET /supplier-portal/:token/conversations/:id — supplier reads a conversation
  fastify.get<{ Params: { token: string; id: string } }>(
    '/supplier-portal/:token/conversations/:id',
    async (req) => {
      const tokenRow = await prisma.supplierPortalToken.findUnique({ where: { token: req.params.token } })
      if (!tokenRow) throw new AppError('INVALID_TOKEN', 'Invalid portal link', 404)

      const conv = await prisma.supplierConversation.findUnique({ where: { id: req.params.id } })
      if (!conv || conv.supplierId !== tokenRow.supplierId) throw new NotFoundError('Conversation', req.params.id)

      // Mark staff messages as seen by supplier
      await prisma.supplierMessage.updateMany({
        where: { conversationId: req.params.id, fromStaff: true, seenAt: null },
        data:  { seenAt: new Date() },
      })

      return prisma.supplierMessage.findMany({
        where:   { conversationId: req.params.id },
        orderBy: { createdAt: 'asc' },
      })
    },
  )

  // POST /supplier-portal/:token/conversations/:id — supplier sends a reply
  fastify.post<{ Params: { token: string; id: string } }>(
    '/supplier-portal/:token/conversations/:id',
    async (req, reply) => {
      const tokenRow = await prisma.supplierPortalToken.findUnique({ where: { token: req.params.token } })
      if (!tokenRow) throw new AppError('INVALID_TOKEN', 'Invalid portal link', 404)
      if (tokenRow.expiresAt && tokenRow.expiresAt < new Date()) throw new AppError('TOKEN_EXPIRED', 'Link expired', 410)

      const body = z.object({ body: z.string().min(1).max(5000) }).parse(req.body)
      const conv = await prisma.supplierConversation.findUnique({ where: { id: req.params.id } })
      if (!conv || conv.supplierId !== tokenRow.supplierId) throw new NotFoundError('Conversation', req.params.id)

      const message = await prisma.supplierMessage.create({
        data: {
          conversationId: req.params.id,
          fromStaff:      false,
          senderId:       null,
          body:           body.body,
        },
      })
      await prisma.supplierConversation.update({
        where: { id: req.params.id },
        data:  { updatedAt: new Date() },
      })
      return reply.status(201).send(message)
    },
  )
}
