import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS, ALL_STAFF } from '../auth/middleware.js'
import { NotFoundError } from '../../lib/errors.js'
import { scopeTenantWhere, conceptWhere } from '../../lib/tenantScope.js'
import { isTestTenant } from '../../lib/testCompany.js'
import { issueInvoiceForOrder, issueCreditNoteForOrder, renderInvoiceHtml } from './service.js'

const issueSchema = z.object({
  buyer: z.object({
    name: z.string().optional(),
    strn: z.string().optional(),
    ntn:  z.string().optional(),
    address: z.string().optional(),
  }).optional(),
})

// Company scope (lib/tenantScope.ts): every invoice carries its company
// (TaxInvoice.tenantId). Lists and reads are view-aware ('read'); issuing an
// invoice or a credit note acts on an EXISTING order, so the order must be
// in one of the operator's companies ('write') — the document itself is
// always stamped with the ORDER's company, never the operator's. Anything
// outside the scope is 404, never a hint that it exists.
export async function invoiceRoutes(fastify: FastifyInstance) {
  // List invoices (manager view)
  fastify.get<{ Querystring: { conceptId?: string; from?: string; to?: string } }>(
    '/',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const q = z.object({
        conceptId: z.string().min(1).optional(),
        from: z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'not a date').optional(),
        to:   z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'not a date').optional(),
      }).parse(req.query)
      return prisma.taxInvoice.findMany({
        where: {
          ...(await scopeTenantWhere(req, 'read')),
          // A foreign brand id is 404 (conceptWhere); none = every brand in
          // scope, narrowed by the global brand filter.
          ...(await conceptWhere(req, q.conceptId, 'read')),
          ...(q.from || q.to ? {
            issuedAt: {
              ...(q.from && { gte: new Date(q.from) }),
              ...(q.to   && { lte: new Date(q.to) }),
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
      await orderInScope(req, req.params.orderId)
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
      await orderInScope(req, req.params.orderId)
      const cn = await issueCreditNoteForOrder(req.params.orderId, reason)
      return reply.status(201).send(cn)
    },
  )

  // Get a printable HTML invoice
  fastify.get<{ Params: { id: string } }>(
    '/:id/html',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req, reply) => {
      const invoice = await prisma.taxInvoice.findFirst({
        where: { id: req.params.id, ...(await scopeTenantWhere(req, 'read')) },
        include: { lines: true },
      })
      if (!invoice) throw new NotFoundError('TaxInvoice', req.params.id)
      const html = renderInvoiceHtml({ ...invoice, testCompany: await isTestTenant(invoice.tenantId) })
      reply.header('Content-Type', 'text/html; charset=utf-8')
      return reply.send(html)
    },
  )

  // Get an invoice as JSON
  fastify.get<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const invoice = await prisma.taxInvoice.findFirst({
        where: { id: req.params.id, ...(await scopeTenantWhere(req, 'read')) },
        include: { lines: true, original: { select: { invoiceNumber: true } } },
      })
      if (!invoice) throw new NotFoundError('TaxInvoice', req.params.id)
      return invoice
    },
  )
}

/** 404 unless the order's brand is in one of the operator's companies. */
async function orderInScope(req: FastifyRequest, orderId: string): Promise<void> {
  const order = await prisma.order.findFirst({
    where: { id: orderId, deletedAt: null, concept: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) } },
    select: { id: true },
  })
  if (!order) throw new NotFoundError('Order', orderId)
}
