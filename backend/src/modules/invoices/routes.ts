import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS, ALL_STAFF } from '../auth/middleware.js'
import { issueInvoiceForOrder, issueCreditNoteForOrder, renderInvoiceHtml } from './service.js'

const issueSchema = z.object({
  buyer: z.object({
    name: z.string().optional(),
    strn: z.string().optional(),
    ntn:  z.string().optional(),
    address: z.string().optional(),
  }).optional(),
})

export async function invoiceRoutes(fastify: FastifyInstance) {
  // List invoices (manager view)
  fastify.get<{ Querystring: { conceptId?: string; from?: string; to?: string } }>(
    '/',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      // Tenant scope: only invoices for concepts under the active tenant.
      const tenantConcepts = await prisma.concept.findMany({
        where: { tenantId: req.staffUser!.tenantFilter, deletedAt: null },
        select: { id: true },
      })
      const tenantConceptIds = tenantConcepts.map((c) => c.id)
      return prisma.taxInvoice.findMany({
        where: {
          conceptId: req.query.conceptId
            ? (tenantConceptIds.includes(req.query.conceptId) ? req.query.conceptId : '__none__')
            : { in: tenantConceptIds },
          ...(req.query.from || req.query.to ? {
            issuedAt: {
              ...(req.query.from && { gte: new Date(req.query.from) }),
              ...(req.query.to   && { lte: new Date(req.query.to) }),
            },
          } : {}),
        },
        orderBy: { issuedAt: 'desc' },
        take: 200,
        include: { lines: true },
      })
    },
  )

  // Issue an invoice for a specific order (auto-issues if missing)
  fastify.post<{ Params: { orderId: string } }>(
    '/orders/:orderId/issue',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req, reply) => {
      const body = issueSchema.parse(req.body ?? {})
      const order = await prisma.order.findFirst({
        where: {
          id: req.params.orderId,
          concept: { tenantId: req.staffUser!.tenantFilter, deletedAt: null },
        },
      })
      if (!order) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Order not found in your active company' } })
      const invoice = await issueInvoiceForOrder({
        orderId: req.params.orderId,
        buyer: body.buyer,
      })
      return reply.status(201).send(invoice)
    },
  )

  // Issue a credit note (refund/cancellation)
  fastify.post<{ Params: { orderId: string } }>(
    '/orders/:orderId/credit-note',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const { reason } = z.object({ reason: z.string().min(1) }).parse(req.body)
      const order = await prisma.order.findFirst({
        where: {
          id: req.params.orderId,
          concept: { tenantId: req.staffUser!.tenantFilter, deletedAt: null },
        },
      })
      if (!order) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Order not found in your active company' } })
      const cn = await issueCreditNoteForOrder(req.params.orderId, reason)
      return reply.status(201).send(cn)
    },
  )

  // Get a printable HTML invoice
  fastify.get<{ Params: { id: string } }>(
    '/:id/html',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req, reply) => {
      const tenantConcepts = await prisma.concept.findMany({
        where: { tenantId: req.staffUser!.tenantFilter, deletedAt: null },
        select: { id: true },
      })
      const tenantConceptIds = tenantConcepts.map((c) => c.id)
      const invoice = await prisma.taxInvoice.findFirst({
        where: { id: req.params.id, conceptId: { in: tenantConceptIds } },
        include: { lines: true },
      })
      if (!invoice) return reply.status(404).send({ error: { code: 'NOT_FOUND' } })
      const html = renderInvoiceHtml(invoice)
      reply.header('Content-Type', 'text/html; charset=utf-8')
      return reply.send(html)
    },
  )

  // Get an invoice as JSON
  fastify.get<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req, reply) => {
      const tenantConcepts = await prisma.concept.findMany({
        where: { tenantId: req.staffUser!.tenantFilter, deletedAt: null },
        select: { id: true },
      })
      const tenantConceptIds = tenantConcepts.map((c) => c.id)
      const invoice = await prisma.taxInvoice.findFirst({
        where: { id: req.params.id, conceptId: { in: tenantConceptIds } },
        include: { lines: true, original: { select: { invoiceNumber: true } } },
      })
      if (!invoice) return reply.status(404).send({ error: { code: 'NOT_FOUND' } })
      return invoice
    },
  )
}
