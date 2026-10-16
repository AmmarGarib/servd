import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Prisma, UserRole } from '@prisma/client'
import { requireModule } from '../notifications/requireModule.js'
import { orderRefOf } from '../../lib/orderRef.js'
import { zBackdatedReason } from '../nightAudit/backdate.js'
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
/** Who may LIST the register (finance audit 2026-10-17 item 23): the
 *  managers, and finance — finance with its 'accounting' module, to tie the
 *  sales tax return to the invoice and credit-note numbers issued. Read-only:
 *  issuing stays with the order routes below. */
const REGISTER_READERS = [...MANAGERS, 'finance'] as UserRole[]
const financeNeedsAccounting = async (req: FastifyRequest) => {
  if (req.staffUser?.role === 'finance') await requireModule('accounting')(req)
}

const listQuery = z.object({
  conceptId: z.string().min(1).optional(),
  from: z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'not a date').optional(),
  to:   z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'not a date').optional(),
  type: z.enum(['invoice', 'credit_note']).optional(),
  q:    z.string().trim().max(80).optional(),
})
type ListQuery = z.infer<typeof listQuery>

/** The register's filter, in the caller's read scope (a foreign brand id is 404). */
async function registerWhere(req: FastifyRequest, q: ListQuery): Promise<Prisma.TaxInvoiceWhereInput> {
  return {
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
    ...(q.type && { type: q.type }),
    ...(q.q && { OR: [
      { invoiceNumber: { contains: q.q, mode: 'insensitive' as const } },
      { buyerName: { contains: q.q, mode: 'insensitive' as const } },
    ] }),
  }
}

const csvCell = (v: unknown): string => {
  const t = v === null || v === undefined ? '' : String(v)
  // Never let a spreadsheet run a cell as a formula.
  const safe = /^[=+\-@\t\r]/.test(t) ? `'${t}` : t
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

export async function invoiceRoutes(fastify: FastifyInstance) {
  // List invoices (managers; finance with accounting)
  fastify.get<{ Querystring: Record<string, string | undefined> }>(
    '/',
    { preHandler: [requireAuth(...REGISTER_READERS), financeNeedsAccounting] },
    async (req) => {
      const q = listQuery.parse(req.query)
      return prisma.taxInvoice.findMany({
        where: await registerWhere(req, q),
        orderBy: { issuedAt: 'desc' },
        take: 200,
        include: { lines: true },
      })
    },
  )

  // The register as CSV — the same filter and scope, up to 10,000 rows.
  fastify.get<{ Querystring: Record<string, string | undefined> }>(
    '/register.csv',
    { preHandler: [requireAuth(...REGISTER_READERS), financeNeedsAccounting] },
    async (req, reply) => {
      const q = listQuery.parse(req.query)
      const rows = await prisma.taxInvoice.findMany({
        where: await registerWhere(req, q),
        orderBy: { issuedAt: 'asc' },
        take: 10_000,
        select: {
          invoiceNumber: true, type: true, issuedAt: true, orderId: true, conceptId: true, tenantId: true,
          sellerLegalName: true, sellerStrn: true, sellerNtn: true, buyerName: true, buyerStrn: true, buyerNtn: true,
          taxableValueCents: true, fbrTaxCents: true, provincialTaxCents: true, serviceChargeCents: true,
          deliveryFeeCents: true, discountCents: true, totalCents: true, originalInvoiceId: true,
        },
      })
      const originals = rows.filter((r) => r.originalInvoiceId).map((r) => r.originalInvoiceId!)
      const origNo = new Map((originals.length
        ? await prisma.taxInvoice.findMany({ where: { id: { in: originals } }, select: { id: true, invoiceNumber: true } })
        : []).map((o) => [o.id, o.invoiceNumber]))
      const brands = new Map((await prisma.concept.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.conceptId))] } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]))
      const rs = (c: number) => (c / 100).toFixed(2)
      const pkt = (d: Date) => new Date(d.getTime() + 5 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ')
      const lines = [
        ['Number', 'Type', 'Issued (PKT)', 'Brand', 'Seller', 'Seller STRN', 'Seller NTN', 'Buyer', 'Buyer STRN', 'Buyer NTN', 'Order ref', 'Taxable value', 'FBR tax', 'Provincial tax', 'Service charge', 'Delivery charge', 'Discount', 'Total', 'Credit note for'],
        ...rows.map((r) => [
          r.invoiceNumber, r.type === 'credit_note' ? 'Credit note' : 'Invoice', pkt(r.issuedAt), brands.get(r.conceptId) ?? '',
          r.sellerLegalName, r.sellerStrn, r.sellerNtn, r.buyerName, r.buyerStrn, r.buyerNtn, orderRefOf(r.orderId),
          rs(r.taxableValueCents), rs(r.fbrTaxCents), rs(r.provincialTaxCents), rs(r.serviceChargeCents),
          rs(r.deliveryFeeCents), rs(r.discountCents), rs(r.totalCents), r.originalInvoiceId ? origNo.get(r.originalInvoiceId) ?? '' : '',
        ]),
      ].map((l) => l.map(csvCell).join(',')).join('\n')
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', 'attachment; filename="tax-invoices.csv"')
        .send(lines)
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
      // backdatedReason: the CEO's reason for a bill of an earlier sales day (night audit; 403 CEO_ONLY_BACKDATED otherwise).
      const { reason, backdatedReason } = z.object({ reason: z.string().min(1), backdatedReason: zBackdatedReason }).parse(req.body)
      await orderInScope(req, req.params.orderId)
      const cn = await issueCreditNoteForOrder(req.params.orderId, reason, {
        actor: { id: req.staffUser!.id, role: req.staffUser!.role, email: req.staffUser!.email }, backdatedReason,
      })
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
