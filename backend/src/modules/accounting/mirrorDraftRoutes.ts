// /accounting/journal-drafts — journals between companies (owner, 2026-11-12; mirrorDrafts.ts is the contract).
//   GET  /?status=pending|posted|dismissed|withdrawn|all   drafts for or from the companies in view (FINANCIALS_VIEWERS)
//   POST /:id/dismiss {note ≥10}                            this company's pending draft (JOURNAL_POSTERS + accounting)
// Booking a draft is POST /accounting/journal {…, mirrorDraftId} (the ONE manual-journal path).
import type { FastifyInstance } from 'fastify'
import type { UserRole } from '@prisma/client'
import { z } from 'zod'
import { serviceClient } from '../../lib/prisma.js'
import { requireAuth, FINANCIALS_VIEWERS } from '../auth/middleware.js'
import { requireModule } from '../notifications/requireModule.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { audit } from '../../lib/audit.js'
import { resolveTenantScope, scopeTenantWhere } from '../../lib/tenantScope.js'
import { MANUAL_JOURNAL_POSTERS } from './manualJournal.js'
import { draftDecidedNotice } from './mirrorDrafts.js'

const STATUSES = ['pending', 'posted', 'dismissed', 'withdrawn'] as const

export async function mirrorDraftRoutes(fastify: FastifyInstance) {
  fastify.get<{ Querystring: { status?: string } }>('/', { preHandler: requireAuth(...FINANCIALS_VIEWERS) }, async (req) => {
    const status = (STATUSES as readonly string[]).includes(req.query.status ?? '') ? req.query.status! : req.query.status === 'all' ? null : 'pending'
    const { tenantIds } = await resolveTenantScope(req)
    const rows = await serviceClient.intercompanyJournalDraft.findMany({
      where: { OR: [{ tenantId: { in: tenantIds } }, { sourceTenantId: { in: tenantIds } }], ...(status ? { status } : {}) },
      orderBy: { createdAt: 'desc' }, take: 200,
    })
    const names = new Map((await serviceClient.tenant.findMany({ where: { id: { in: [...new Set(rows.flatMap((r) => [r.tenantId, r.sourceTenantId]))] } }, select: { id: true, name: true } })).map((t) => [t.id, t.name]))
    const posted = rows.map((r) => r.postedEntryId).filter((x): x is string => !!x)
    const vno = new Map((posted.length ? await serviceClient.journalEntry.findMany({ where: { id: { in: posted } }, select: { id: true, voucherNo: true } }) : []).map((e) => [e.id, e.voucherNo]))
    return rows.map((r) => ({
      ...r, companyName: names.get(r.tenantId) ?? null, sourceCompanyName: names.get(r.sourceTenantId) ?? null,
      postedVoucherNo: r.postedEntryId ? (vno.get(r.postedEntryId) ?? null) : null,
      /** Mine to book = the draft's company is one I may write in. */
      mine: tenantIds.includes(r.tenantId),
    }))
  })

  fastify.post<{ Params: { id: string } }>('/:id/dismiss', { preHandler: [requireAuth(...(MANUAL_JOURNAL_POSTERS as unknown as UserRole[])), requireModule('accounting')] }, async (req) => {
    const { note } = z.object({ note: z.string().trim().min(10, 'Say why it is not booked (at least 10 characters)').max(500) }).parse(req.body ?? {})
    const where = await scopeTenantWhere(req, 'write')
    const d = await serviceClient.intercompanyJournalDraft.findFirst({ where: { id: req.params.id, ...where } })
    if (!d) throw new NotFoundError('IntercompanyJournalDraft', req.params.id)
    const r = await serviceClient.intercompanyJournalDraft.updateMany({
      where: { id: d.id, status: 'pending' },
      data: { status: 'dismissed', note, decidedById: req.staffUser!.id, decidedAt: new Date() },
    })
    if (r.count === 0) throw new AppError('DRAFT_NOT_PENDING', `This draft is already ${d.status}`, 409)
    await audit({
      category: 'accounting', action: 'journal.intercompany_dismiss', entity: 'IntercompanyJournalDraft', entityId: d.id,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId: d.tenantId,
      metadata: { note, sourceEntryId: d.sourceEntryId, sourceTenantId: d.sourceTenantId, actorRole: req.staffUser!.role },
    })
    await draftDecidedNotice(d.id, req.staffUser!.id).catch(() => undefined)
    return { id: d.id, status: 'dismissed' }
  })
}
