// Servd sales to file by hand (till flow, owner 2026-10-20).
//
// A till bill CLOSED IN SERVD (Order.settlementChannel 'servd') is not sent to
// the Keenu fiscal POS. Its sale FiscalDocument — and every return of it — is
// created by the ONE outbox (completeOrder → enqueueFiscalSaleTx, and the
// refund engine → enqueueFiscalRefundTx) as 'manual_required' / statusReason
// 'servd_channel' (connectors/fiscal/outbox.ts SERVD_CHANNEL), never skipped.
// The owner files these bills on the SRB / FBR portal daily, weekly or monthly
// (owner confirmed this is allowed) and finance records each filing HERE —
// through the existing "record manual filing" path (outbox.recordManualFiling),
// never a second filing table. A company with "Fiscal reporting required" OFF
// has no documents at all, so nothing to file.
//
//   GET  /accounting/servd-filings          FINANCIALS_VIEWERS  the documents (read scope), unfiled first
//   POST /accounting/servd-filings/record   CEO + finance (with the accounting module, the /accounting gate)
//        { documentIds[1..500], portalReference, authority 'srb'|'fbr', filedOn YYYY-MM-DD, note? }
//        → every document must be a servd-channel document of a company the
//          caller may write (foreign / unknown → 404 for the whole call, nothing
//          recorded) still waiting to be filed (409 NOT_MANUALLY_FILABLE).
//
// The month close BLOCKS while a servd-channel document dated on or before the
// lock is still unfiled (close check 'servd_sales_unfiled', CEO-overridable
// with acknowledge) — servdFilingsCloseCheck below, listed in CLOSE_CHECKS.
//
// SRB direct (owner, 2026-10-30): when a company's fiscal driver files
// directly (connectors/registry.ts DIRECT_FISCAL_DRIVERS — 'srb'), its
// servd-closed bills are filed AUTOMATICALLY by the outbox and are not hand
// filings. This page and the close check then see only the hand-filed rows
// (statusReason 'servd_channel' still unfiled, 'servd_portal' recorded) —
// rows created before the switch, which finance can still record. The
// automatic ones are watched where every fiscal document is (Dev → API → POS
// connector → Submissions, /health, the fiscal_* flags).

import type { FastifyInstance } from 'fastify'
import type { Prisma, UserRole } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, FINANCIALS_VIEWERS } from '../auth/middleware.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { scopeTenantWhere } from '../../lib/tenantScope.js'
import { audit } from '../../lib/audit.js'
import { orderRefOf } from '../../lib/orderRef.js'
import { MANUAL_FILABLE, recordManualFiling, SERVD_CHANNEL } from '../../connectors/fiscal/outbox.js'
import { DIRECT_FISCAL_DRIVERS } from '../../connectors/registry.js'
import { fmtPktDate, parsePktEndOfDay, parsePktStartOfDay } from './dates.js'
import type { CloseCheck } from './closeCheckTypes.js'

/** Who records a portal filing: the CEO and finance (the /accounting module gate holds finance to 'accounting'). */
export const SERVD_FILERS = ['admin', 'finance'] as UserRole[]

/** Document statuses that still owe a portal filing (MANUAL_FILABLE: everything but filed / manual_filed / skipped / submitting). */
export const SERVD_UNFILED_STATUSES = MANUAL_FILABLE

/**
 * Fiscal documents of bills closed in servd that are filed BY HAND, in a
 * company scope: every one of a company whose fiscal driver is a fiscal POS;
 * under a direct driver (SRB direct) only the hand-filed rows (servd_channel /
 * servd_portal) — the rest are filed automatically.
 */
export async function servdDocumentWhere(
  tenant: { tenantId: string } | { tenantId: { in: string[] } },
  db: Pick<typeof prisma, 'posConnector'> = prisma,
): Promise<Prisma.FiscalDocumentWhereInput> {
  const direct = (await db.posConnector.findMany({
    where: { kind: 'fiscal', driver: { in: [...DIRECT_FISCAL_DRIVERS] } },
    select: { tenantId: true },
  })).map((r) => r.tenantId)
  return {
    ...tenant,
    order: { settlementChannel: 'servd' },
    ...(direct.length > 0 && { OR: [{ statusReason: { in: [SERVD_CHANNEL, 'servd_portal'] } }, { tenantId: { notIn: direct } }] }),
  }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/

export async function servdFilingRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/', { preHandler: requireAuth(...FINANCIALS_VIEWERS) }, async (req) => {
    const q = z.object({
      status: z.enum(['unfiled', 'filed', 'all']).default('unfiled'),
      dateFrom: z.string().regex(DATE).optional(),
      dateTo: z.string().regex(DATE).optional(),
      conceptId: z.string().uuid().optional(),
      limit: z.coerce.number().int().min(1).max(1000).default(500),
    }).parse(req.query ?? {})
    const scope = await scopeTenantWhere(req, 'read')
    const servdWhere = await servdDocumentWhere(scope)
    const where: Prisma.FiscalDocumentWhereInput = {
      ...servdWhere,
      ...(q.conceptId && { conceptId: q.conceptId }),
      ...(q.status === 'unfiled' && { status: { in: SERVD_UNFILED_STATUSES } }),
      ...(q.status === 'filed' && { status: 'manual_filed' }),
      ...((q.dateFrom || q.dateTo) && {
        createdAt: {
          ...(q.dateFrom && { gte: parsePktStartOfDay(q.dateFrom) }),
          ...(q.dateTo && { lte: parsePktEndOfDay(q.dateTo) }),
        },
      }),
    }
    const [rows, unfiled] = await Promise.all([
      prisma.fiscalDocument.findMany({
        where,
        orderBy: [{ createdAt: 'asc' }],
        take: q.limit,
        select: {
          id: true, tenantId: true, kind: true, orderId: true, conceptId: true, status: true, statusReason: true,
          amountCents: true, createdAt: true, fiscalNumber: true, authority: true, fiscalAt: true, resolvedById: true,
        },
      }),
      prisma.fiscalDocument.aggregate({
        where: { ...servdWhere, status: { in: SERVD_UNFILED_STATUSES }, ...(q.conceptId && { conceptId: q.conceptId }) },
        _count: true, _sum: { amountCents: true },
      }),
    ])
    const brands = new Map((await prisma.concept.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.conceptId))] } }, select: { id: true, name: true },
    })).map((c) => [c.id, c.name]))
    return {
      documents: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        orderId: r.orderId,
        orderRef: orderRefOf(r.orderId),
        conceptId: r.conceptId,
        brandName: brands.get(r.conceptId) ?? null,
        // A return is a negative supply on the portal.
        amountCents: r.kind === 'refund' ? -r.amountCents : r.amountCents,
        saleDay: fmtPktDate(r.createdAt),
        status: r.status === 'manual_filed' ? 'filed' : 'unfiled',
        rawStatus: r.status,
        portalReference: r.status === 'manual_filed' ? r.fiscalNumber : null,
        authority: r.status === 'manual_filed' ? r.authority : null,
        filedOn: r.status === 'manual_filed' && r.fiscalAt ? fmtPktDate(r.fiscalAt) : null,
      })),
      unfiled: { count: unfiled._count, amountCents: Number(unfiled._sum.amountCents ?? 0) },
    }
  })

  fastify.post('/record', { preHandler: requireAuth(...SERVD_FILERS) }, async (req) => {
    const body = z.object({
      documentIds: z.array(z.string().min(1).max(64)).min(1).max(500),
      portalReference: z.string().trim().min(1).max(64),
      authority: z.enum(['srb', 'fbr']),
      filedOn: z.string().regex(DATE),
      note: z.string().trim().max(500).optional(),
    }).parse(req.body ?? {})
    const ids = [...new Set(body.documentIds)]
    const filedOn = parsePktStartOfDay(body.filedOn)
    if (Number.isNaN(filedOn.getTime()) || fmtPktDate(filedOn) !== body.filedOn) throw new AppError('INVALID_DATE', 'filedOn must be a date (YYYY-MM-DD)', 400)
    if (filedOn.getTime() > Date.now()) throw new AppError('FILED_IN_FUTURE', 'The portal filing date cannot be in the future', 422)
    const scope = await scopeTenantWhere(req, 'write')
    const docs = await prisma.fiscalDocument.findMany({
      where: { id: { in: ids }, ...(await servdDocumentWhere(scope)) },
      select: { id: true, status: true, tenantId: true, orderId: true, kind: true, amountCents: true },
    })
    // All or nothing: one foreign / unknown / non-servd id and nothing is recorded.
    if (docs.length !== ids.length) {
      const found = new Set(docs.map((d) => d.id))
      throw new NotFoundError('Servd fiscal document', ids.find((id) => !found.has(id))!)
    }
    const notFilable = docs.filter((d) => !SERVD_UNFILED_STATUSES.includes(d.status))
    if (notFilable.length > 0) {
      throw new AppError('NOT_MANUALLY_FILABLE', `${notFilable.length} of these documents ${notFilable.length === 1 ? 'is' : 'are'} already filed (${notFilable.map((d) => d.status).join(', ')}) — leave ${notFilable.length === 1 ? 'it' : 'them'} out`, 409)
    }
    const recorded: string[] = []
    for (const d of docs) {
      await recordManualFiling(d.id, { tenantId: d.tenantId }, {
        fiscalNumber: body.portalReference, authority: body.authority, actorId: req.staffUser!.id,
        filedOn, reason: 'servd_portal',
      })
      recorded.push(d.id)
    }
    // One audit row per company the filing touched.
    for (const tenantId of new Set(docs.map((d) => d.tenantId))) {
      const mine = docs.filter((d) => d.tenantId === tenantId)
      await audit({
        category: 'accounting', action: 'fiscal.servd_portal_filed', entity: 'FiscalDocument', entityId: mine[0]!.id,
        userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId,
        metadata: {
          actorRole: req.staffUser!.role, portalReference: body.portalReference, authority: body.authority, filedOn: body.filedOn,
          note: body.note ?? null, documentIds: mine.map((d) => d.id), orderIds: [...new Set(mine.map((d) => d.orderId))],
          amountCents: mine.reduce((s, d) => s + (d.kind === 'refund' ? -d.amountCents : d.amountCents), 0),
        },
      })
    }
    return { recorded: recorded.length, documentIds: recorded }
  })
}

/**
 * Close check (till flow, owner 2026-10-20): every servd-channel sale (and
 * return) dated on or before the lock must be filed on the portal. BLOCK,
 * CEO-overridable with acknowledge {keys, reason ≥10}. A company with fiscal
 * reporting OFF has no such documents, so it never blocks there.
 */
export const servdFilingsCloseCheck: CloseCheck = {
  key: 'servd_sales_unfiled',
  severity: 'block',
  overridable: true,
  async run(ctx) {
    const agg = await ctx.db.fiscalDocument.aggregate({
      where: { ...(await servdDocumentWhere({ tenantId: ctx.tenantId }, ctx.db)), status: { in: SERVD_UNFILED_STATUSES }, createdAt: { lte: ctx.newLock } },
      _count: true,
      _sum: { amountCents: true },
    })
    const count = agg._count
    if (count === 0) return null
    const cents = Number(agg._sum.amountCents ?? 0)
    return {
      key: 'servd_sales_unfiled',
      severity: 'block',
      title: 'Sales closed in servd not filed on the portal',
      detail: `${count} fiscal document${count === 1 ? '' : 's'} (PKR ${(cents / 100).toLocaleString('en-PK', { maximumFractionDigits: 0 })}) of bills closed in servd on or before ${fmtPktDate(ctx.newLock)} ${count === 1 ? 'has' : 'have'} not been recorded as filed on the SRB / FBR portal. `
        + 'File them on the portal, then record the filing on Finance → Servd sales to file — or close anyway (CEO, with a reason).',
      count,
      cents,
      link: '/finance/servd-filings',
      overridable: true,
    }
  },
}

/** The unfiled count of one company (the servd docs the close check counts) — for tests and the page. */
export async function servdUnfiledCount(tenantId: string, through: Date): Promise<number> {
  return prisma.fiscalDocument.count({
    where: { ...(await servdDocumentWhere({ tenantId })), status: { in: SERVD_UNFILED_STATUSES }, createdAt: { lte: through } },
  })
}

export { SERVD_CHANNEL }
