// /reconciliation/backfill-petty-cash — put the petty-cash boxes' history on
// the books (1011, finance wave B, H1/H2). The CEO's backfills live under
// /reconciliation (critic): this sits beside /backfill-unposted and shares its
// single-flight slot (withBackfillSlot) and its placement rule (placeAndPost,
// owner decision 6). The work is accounting/pettyCashPosting.ts
// backfillPettyCash; the admin section is Reconciliation → Backfill.
//
// POST /reconciliation/backfill-petty-cash — role admin (CEO) only; the
// /reconciliation module gate applies on top. Body:
//   dryRun               default true — a dry run writes nothing
//   historicTopupSource  'safe' (default, H2) | 'garibsons', for every company
//                        in view, or { [tenantId]: 'safe' | 'garibsons' }
//   picks                { [movementId]: { categoryKey | accountCode | source |
//                        destination, bankAccountId? } } — finance's answers
//                        for needs_category / needs_review rows
//   tenantId             optional: one company in view (else 404)
// The companies in view (resolveTenantScope; empty → 422 NO_ACTIVE_COMPANY).
// A real run is single-flight per company (409 BACKFILL_RUNNING) and writes
// one audit row per company it touched, filed under THAT company.

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requireAuth, ADMIN_ONLY } from '../auth/middleware.js'
import { resolveTenantScope } from '../../lib/tenantScope.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { audit } from '../../lib/audit.js'
import { backfillPettyCash, type BackfillRow } from '../accounting/pettyCashPosting.js'

const SOURCE = z.enum(['safe', 'garibsons'])
const PICK = z.object({
  categoryKey:   z.string().trim().min(1).max(40).optional(),
  accountCode:   z.string().trim().min(1).max(10).optional(),
  source:        z.enum(['safe', 'garibsons', 'bank']).optional(),
  destination:   z.enum(['safe', 'garibsons', 'bank']).optional(),
  bankAccountId: z.string().min(1).optional(),
})

export default async function plugin(fastify: FastifyInstance): Promise<void> {
  fastify.post('/', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const body = z.object({
      dryRun:              z.boolean().default(true),
      historicTopupSource: z.union([SOURCE, z.record(z.string(), SOURCE)]).default('safe'),
      picks:               z.record(z.string(), PICK).default({}),
      tenantId:            z.string().min(1).optional(),
    }).parse(req.body ?? {})
    const scope = await resolveTenantScope(req)
    if (scope.tenantIds.length === 0) throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company first', 422)
    if (body.tenantId && !scope.tenantIds.includes(body.tenantId)) throw new NotFoundError('Company', body.tenantId)
    const tenantIds = body.tenantId ? [body.tenantId] : scope.tenantIds
    const historicTopupSource: Record<string, 'safe' | 'garibsons'> = {}
    for (const t of tenantIds) {
      historicTopupSource[t] = typeof body.historicTopupSource === 'string' ? body.historicTopupSource : (body.historicTopupSource[t] ?? 'safe')
    }

    const { withBackfillSlot, BackfillRunningError } = await import('./backfillOrders.js')
    const runAll = () => backfillPettyCash({ tenantIds, dryRun: body.dryRun, postedBy: req.staffUser!.id, historicTopupSource, picks: body.picks })
    let rows: BackfillRow[]
    try {
      // A dry run writes nothing and never waits; a real run takes the slot
      // the other backfills use.
      rows = body.dryRun ? await runAll() : await withBackfillSlot(tenantIds, runAll)
    } catch (err) {
      if (err instanceof BackfillRunningError) throw new AppError('BACKFILL_RUNNING', err.message, 409)
      throw err
    }

    const summary: Record<string, number> = {}
    for (const r of rows) summary[r.outcome] = (summary[r.outcome] ?? 0) + 1

    if (!body.dryRun) {
      const byCompany = new Map<string, BackfillRow[]>()
      for (const r of rows) byCompany.set(r.tenantId, [...(byCompany.get(r.tenantId) ?? []), r])
      for (const [companyId, companyRows] of byCompany) {
        const counts: Record<string, number> = {}
        for (const r of companyRows) counts[r.outcome] = (counts[r.outcome] ?? 0) + 1
        await audit({
          category: 'accounting',
          action: 'petty_cash.backfill',
          entity: 'PettyCashBox',
          userId: req.staffUser!.id,
          userEmail: req.staffUser!.email,
          tenantId: companyId,
          after: counts,
          metadata: {
            tenantId: companyId,
            historicTopupSource: historicTopupSource[companyId],
            posted: companyRows.filter((r) => r.outcome.startsWith('posted')).map((r) => `${r.kind}:${r.id}`),
            open: companyRows.filter((r) => r.outcome === 'needs_category' || r.outcome === 'needs_review' || r.outcome === 'error')
              .map((r) => ({ kind: r.kind, id: r.id, outcome: r.outcome, detail: r.detail })),
          },
        })
      }
    }
    return { dryRun: body.dryRun, historicTopupSource, rows, summary }
  })
}
