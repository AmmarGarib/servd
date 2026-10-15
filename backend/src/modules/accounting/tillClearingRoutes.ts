// /accounting/till-clearing — the CEO's one-time 1110 → 1115 till-clearing
// cut-over, per company (accounting/tillClearing.ts). The orchestrator
// registers this plugin at '/accounting/till-clearing', under the existing
// '/accounting' module gate.
//
//   GET  /status   FINANCE_TEAM, every company in the caller's READ scope
//                  (the portfolio header expands it): per company the
//                  marker (cutoverAt), what the cut-over would move (or what
//                  is still on 1110 after it), the 1110 tie-out, and
//                  canCutover (the CEO, the ACTIVE company, not cut over).
//   POST /cutover  ADMIN_ONLY (the CEO), the ACTIVE company only:
//                  { reason ≥ 10 } → the cut-over (201; 200 when the company
//                  was already cut over — nothing posted). A refusal (a
//                  locked period, a missing account) answers its error and is
//                  flagged posting_failed for Reconciliation → Backfill
//                  unposted. Audited.

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { audit } from '../../lib/audit.js'
import { requireAuth, ADMIN_ONLY, FINANCE_TEAM } from '../auth/middleware.js'
import { activeTenantId, resolveTenantScope } from '../../lib/tenantScope.js'
import { cutoverPreview, cutoverTillClearing, tieOutOf } from './tillClearing.js'

const cutoverBody = z.object({
  reason: z.string().trim().min(10, 'Say why, in at least 10 characters (e.g. "CA confirmed on 15 Oct")').max(500),
})

export async function tillClearingRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/status', { preHandler: requireAuth(...FINANCE_TEAM) }, async (req) => {
    const scope = await resolveTenantScope(req)
    const active = req.staffUser!.tenantId ?? null
    const isCeo = req.staffUser!.role === 'admin'
    const companies = []
    for (const tenantId of scope.tenantIds) {
      const [preview, tieOut] = await Promise.all([cutoverPreview(tenantId), tieOutOf(tenantId)])
      companies.push({
        tenantId,
        cutoverAt: preview.cutoverAt ? preview.cutoverAt.toISOString() : null,
        // Before the cut-over: X, what it would move. After: till lines still on 1110 (0 once all moved).
        previewCents: preview.tillOn1110Cents,
        canCutover: isCeo && tenantId === active && !preview.cutoverAt,
        tieOut,
      })
    }
    return { companies }
  })

  fastify.post('/cutover', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req, reply) => {
    const body = cutoverBody.parse(req.body ?? {})
    // The ACTIVE company's own books — never another membership.
    const tenantId = activeTenantId(req, 'the till-clearing cut-over is in one company\'s books')
    const before = await cutoverPreview(tenantId)
    const result = await cutoverTillClearing(tenantId, req.staffUser!.id, { reason: body.reason })
    if (result.status === 'cut_over') {
      await audit({
        category: 'accounting',
        action: 'ledger.till_clearing_cutover',
        entity: 'Tenant',
        entityId: tenantId,
        userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId,
        before: { cutoverAt: null, tillOn1110Cents: before.tillOn1110Cents },
        after: { cutoverAt: result.cutoverAt.toISOString(), entryId: result.entryId, movedCents: result.movedCents },
        metadata: { reason: body.reason },
      })
    }
    reply.code(result.status === 'cut_over' ? 201 : 200)
    return {
      status: result.status,
      cutoverAt: result.cutoverAt.toISOString(),
      entryId: result.entryId,
      movedCents: result.movedCents,
      tieOut: await tieOutOf(tenantId),
    }
  })
}
