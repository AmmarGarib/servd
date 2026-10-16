// Stock differences waiting for the CEO (H20) — service.ts has the rules.
//
// A plugin registered at /accounting/stock-differences (index.ts), so
// it sits under the accounting module gate like the rest of /accounting.
//
//   GET  /                 FINANCIALS_VIEWERS, read scope
//                          ?status=pending|cleared (default pending) &tenantId
//                          (one company inside the read scope) &from&to
//                          (YYYY-MM-DD, Pakistan) &cursor &limit
//                          → { rows, nextCursor, totals, canApprove }
//   POST /approve          CEO (admin) — { lineIds: string[] (1–500) }, write
//                          scope, one company per call → { …ApproveResult,
//                          rows, canApprove }; 404 foreign / unknown id, 409
//                          ALREADY_CLEARED, 422 ONE_COMPANY / PERIOD_LOCKED
//   POST /:lineId/query    CEO (admin) — { note: 3–500 } "send back", write
//                          scope → { row, canApprove }; 404, 409 ALREADY_CLEARED
//
// Every response carries `canApprove` (the caller is the CEO).

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { requireAuth, FINANCIALS_VIEWERS } from '../auth/middleware.js'
import { scopeTenantWhere, type TenantIdWhere } from '../../lib/tenantScope.js'
import { audit } from '../../lib/audit.js'
import { auditApproval } from '../../lib/approvalRights.js'
import { parsePktEndOfDay, parsePktStartOfDay } from '../accounting/dates.js'
import {
  approveStockDifferences, listStockDifferences, queryStockDifference, stockDifferencesByIds, STOCK_DIFFERENCE_APPROVERS,
} from './service.js'

const DATE = /^\d{4}-\d{2}-\d{2}$/

/** The company ids of a scope fragment. */
const idsOf = (w: TenantIdWhere): string[] => (typeof w.tenantId === 'string' ? [w.tenantId] : w.tenantId.in)

const canApprove = (req: FastifyRequest) => (STOCK_DIFFERENCE_APPROVERS as readonly string[]).includes(req.staffUser?.role ?? '')

export async function stockDifferenceRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/', { preHandler: requireAuth(...FINANCIALS_VIEWERS) }, async (req) => {
    const q = z.object({
      status: z.enum(['pending', 'cleared']).default('pending'),
      tenantId: z.string().trim().min(1).max(64).optional(),
      from: z.string().regex(DATE).optional(),
      to: z.string().regex(DATE).optional(),
      cursor: z.string().max(200).optional(),
      limit: z.coerce.number().int().min(1).max(500).optional(),
    }).parse(req.query ?? {})
    let tenantIds = idsOf(await scopeTenantWhere(req, 'read'))
    // A company filter narrows the read scope — never widens it (another
    // company's id reads nothing).
    if (q.tenantId) tenantIds = tenantIds.filter((t) => t === q.tenantId)
    const page = await listStockDifferences({
      tenantIds,
      status: q.status,
      from: q.from ? parsePktStartOfDay(q.from) : null,
      to: q.to ? parsePktEndOfDay(q.to) : null,
      cursor: q.cursor ?? null,
      limit: q.limit,
    })
    return { ...page, canApprove: canApprove(req) }
  })

  fastify.post('/approve', { preHandler: requireAuth(...STOCK_DIFFERENCE_APPROVERS) }, async (req) => {
    const body = z.object({ lineIds: z.array(z.string().trim().min(1).max(64)).min(1).max(500) }).parse(req.body ?? {})
    // Editing existing rows: every company the CEO belongs to; the lines
    // decide which ONE company the clearings post in.
    const tenantIds = idsOf(await scopeTenantWhere(req, 'write'))
    const result = await approveStockDifferences({ tenantIds, lineIds: body.lineIds, actorId: req.staffUser!.id })
    await audit({
      category: 'accounting',
      action: 'stock_difference.approve',
      entity: 'JournalLine',
      entityId: result.cleared[0]?.lineId ?? null,
      userId: req.staffUser!.id,
      userEmail: req.staffUser!.email,
      tenantId: result.tenantId,
      after: { cleared: result.cleared, alreadyCleared: result.alreadyCleared, clearedCents: result.clearedCents },
      metadata: { ip: req.ip, lineIds: body.lineIds },
    })
    // approval.decide per cleared line (the one funnel; grant 'role': the guard is a plain CEO role list) and the
    // "approved" notice to whoever posted the difference (none for a system posting). After the commit; never fails it.
    const decidedAt = new Date().toISOString()
    for (const c of result.cleared) {
      try {
        await auditApproval(req, {
          type: 'stock_difference', id: c.lineId, tenantId: result.tenantId, decision: 'approve', grant: { via: 'role' }, entity: 'JournalLine',
          metadata: { decidedAt },
        })
      } catch (err) {
        console.warn(`[stock-differences] approval.decide not recorded: ${(err as Error).message}`)
      }
    }
    const rows = await stockDifferencesByIds([result.tenantId], body.lineIds)
    return { ...result, rows, canApprove: true }
  })

  fastify.post<{ Params: { lineId: string } }>('/:lineId/query', { preHandler: requireAuth(...STOCK_DIFFERENCE_APPROVERS) }, async (req) => {
    const body = z.object({ note: z.string().trim().min(3).max(500) }).parse(req.body ?? {})
    const tenantIds = idsOf(await scopeTenantWhere(req, 'write'))
    const row = await queryStockDifference({
      tenantIds, lineId: req.params.lineId, note: body.note,
      actor: { id: req.staffUser!.id, email: req.staffUser!.email },
    })
    // approval.decide row for the CEO's query (decision 'query' writes the audit row only: no "decided" notice).
    try {
      await auditApproval(req, {
        type: 'stock_difference', id: req.params.lineId, tenantId: tenantIds[0] ?? null, decision: 'query', grant: { via: 'role' }, entity: 'JournalLine',
        metadata: { note: body.note },
      })
    } catch (err) {
      console.warn(`[stock-differences] approval.decide not recorded: ${(err as Error).message}`)
    }
    return { row, canApprove: true }
  })
}
