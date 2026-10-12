// Pre-bill routes (spec §17.3). Two plugins, registered by
// registerPreBillPlugins() inside the /api/v1 block of index.ts:
//
//   preBillPosRoutes      prefix /pos
//     POST /pos/orders/:orderId/pre-bill   print a pre-bill (CASHIERS — the
//                                          till roles, waiters (foh) included)
//     GET  /pos/pre-bills/:id/html         printable pre-bill (same roles)
//
//   preBillFinanceRoutes  prefix /pre-bills
//     GET  /pre-bills[?format=csv]         Finance → Voided pre bills
//
// There is NO delete, hide, edit or exclude endpoint: a pre-bill is a
// permanent record. Pre-bills never reach the fiscal POS, the ledger or any
// revenue / tax report.

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { UserRole } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { NotFoundError } from '../../lib/errors.js'
import { requireAuth, CASHIERS } from '../auth/middleware.js'
import { resolveTenantScope } from '../../lib/tenantScope.js'
import { reportDateRange } from '../reports/service.js'
import { toCsv } from '../accounting/csv.js'
import { createPreBill, renderPreBillHtml, listPreBills, preBillsCsvRows } from './service.js'

/**
 * Who reads Finance → Voided pre bills: the CEO, co-owners, management and
 * finance (spec §17.3). The module id `voided_prebills` (lib/moduleAccess.ts
 * GATED_PREFIXES `/pre-bills`) is added by W2; until then this role list is
 * the only gate.
 */
export const PREBILL_FINANCE_ROLES = ['admin', 'owner', 'management', 'finance'] as UserRole[]

const tenderSchema = z.object({ tender: z.enum(['cash', 'card']).default('cash') })

const listQuerySchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  conceptId: z.string().min(1).optional(),
  printedById: z.string().min(1).optional(),
  status: z.enum(['open', 'superseded', 'converted', 'cancelled']).optional(),
  flagged: z.enum(['0', '1', 'true', 'false']).optional(),
  format: z.enum(['json', 'csv']).optional(),
})

export async function preBillPosRoutes(fastify: FastifyInstance) {
  // POST /pos/orders/:orderId/pre-bill — print a pre-bill for an open order.
  // Body { tender?: 'cash'|'card' } (default cash: the cash headline plus the
  // card total line). 201 { preBill, receipt }. 404 foreign order; 409
  // ALREADY_FINAL / ORDER_NOT_OPEN / ORDER_CHANGED.
  fastify.post<{ Params: { orderId: string } }>(
    '/orders/:orderId/pre-bill',
    { preHandler: requireAuth(...CASHIERS) },
    async (req, reply) => {
      const { tender } = tenderSchema.parse(req.body ?? {})
      const su = req.staffUser!
      const result = await createPreBill({
        orderId: req.params.orderId,
        actor: { id: su.id, role: su.role, email: su.email },
        tender,
        req,
      })
      return reply.status(201).send(result)
    },
  )

  // GET /pos/pre-bills/:id/html — the pre-bill as printable HTML (receipt
  // look, PRE-BILL — NOT A TAX INVOICE). Foreign → 404.
  fastify.get<{ Params: { id: string } }>(
    '/pre-bills/:id/html',
    { preHandler: requireAuth(...CASHIERS) },
    async (req, reply) => {
      const html = await renderPreBillHtml(req.params.id, req)
      return reply.type('text/html').send(html)
    },
  )
}

export async function preBillFinanceRoutes(fastify: FastifyInstance) {
  // GET /pre-bills — every pre-bill of the companies in view, flagged.
  // Query: from, to (YYYY-MM-DD, PKT days; default the last 30 days),
  // conceptId, printedById, status, flagged=1, format=csv.
  fastify.get(
    '/',
    { preHandler: requireAuth(...PREBILL_FINANCE_ROLES) },
    async (req, reply) => {
      const q = listQuerySchema.parse(req.query)
      const { from, to } = reportDateRange(q.from, q.to, 30)
      const scope = await resolveTenantScope(req)
      if (q.conceptId) {
        // A brand of a company in view (a deleted brand's pre-bills are never
        // hidden, so deleted brands count); anything else 404s.
        const owned = await prisma.concept.findFirst({
          where: { id: q.conceptId, tenantId: { in: scope.tenantIds } },
          select: { id: true },
        })
        if (!owned) throw new NotFoundError('Concept', q.conceptId)
      }
      const list = await listPreBills({
        tenantIds: scope.tenantIds,
        from,
        to,
        conceptId: q.conceptId,
        printedById: q.printedById,
        status: q.status,
        flaggedOnly: q.flagged === '1' || q.flagged === 'true',
      })
      if (q.format === 'csv') {
        const day = (d: Date) => new Date(d.getTime() + 5 * 3600_000).toISOString().slice(0, 10)
        return reply
          .header('Content-Type', 'text/csv; charset=utf-8')
          .header('Content-Disposition', `attachment; filename="voided-pre-bills-${day(from)}-to-${day(to)}.csv"`)
          .send(toCsv(preBillsCsvRows(list.rows)))
      }
      return list
    },
  )
}

/**
 * Register both pre-bill plugins on `app` (the /api/v1 scope in index.ts):
 * `/pos/orders/:orderId/pre-bill`, `/pos/pre-bills/:id/html` and `/pre-bills`.
 */
export async function registerPreBillPlugins(app: FastifyInstance): Promise<void> {
  await app.register(preBillPosRoutes, { prefix: '/pos' })
  await app.register(preBillFinanceRoutes, { prefix: '/pre-bills' })
}
