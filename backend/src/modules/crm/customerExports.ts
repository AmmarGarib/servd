// Guest-list downloads go to the CEO (owner, 2026-10-27: "Customer export: downloading the guest list with
// phones / emails … A non-CEO export creates a request; once the CEO approves, the requester may download it
// once within 24 hours; the CEO exports at once").
//
//   • What is gated: every download that carries a customer's phone or email — the CRM guest list
//     (GET /crm/customers/export, built here) and the new-brand waitlist (GET /waitlist/signups.csv, built in
//     waitlist/routes.ts waitlistSignupsCsv). Screens, masked lists and aggregate reports are not affected.
//   • The CEO (role admin) downloads at once: GET /crm/customers/export?format=csv|xlsx|pdf&search=&conceptId=
//     (the companies in view), GET /waitlist/signups.csv. Anyone else gets 403 EXPORT_NEEDS_CEO there and
//     asks instead: POST /crm/exports {kind: customers | waitlist, filters, reason ≥10} → 202
//     { pendingApproval, request }. tenantId = the requester's ACTIVE company (the guests exported are that
//     company's; the waitlist is servd-wide and the request is filed there). The CEO's own ask is 422
//     CEO_EXPORTS_DIRECTLY.
//   • Approval type customer_export (lib/approvalRights.ts): section ceo, the CEO only, not handed over yet
//     (the owner will hand it over later). POST /crm/exports/:id/approve (assertCanApprove + a conditional
//     claim; expiresAt = now + 24 h) | /reject {note ≥10}. The requester may withdraw a pending one
//     (/withdraw). Another company's request is 404.
//   • The download: GET /crm/exports/:id/download?format= — the requester only (403 NOT_YOUR_EXPORT), approved
//     (409 EXPORT_NOT_APPROVED), within 24 h (410 EXPORT_EXPIRED), once (409 EXPORT_ALREADY_DOWNLOADED; the
//     claim is conditional, so two clicks never both download). The list is built AS AT the download, with
//     the filters the CEO approved, in the request's company. Audited customer_export.download (row count,
//     never the rows).
//   • /crm is module-gated ('crm'), so every route here needs the CRM module too.
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, ADMIN_ONLY, MARKETING_TEAM } from '../auth/middleware.js'
import { AppError, ForbiddenError, NotFoundError } from '../../lib/errors.js'
import { scopeTenantWhere, assertConceptOwned } from '../../lib/tenantScope.js'
import { approvalInputOf, approvalSubject, assertCanApprove, auditApproval } from '../../lib/approvalRights.js'
import { approvalWaiting } from '../approvals/notify.js'
import { audit } from '../../lib/audit.js'
import { exportFormatOf, sendReport, companyNamesOf, type ReportTable } from '../../lib/reportExport.js'
import { companyCustomerStats } from './routes.js'
import { tenantIdsOf } from './customerScope.js'
import { waitlistListQuery, waitlistSignupsCsv } from '../waitlist/routes.js'

/** How long an approved download stays open. */
export const EXPORT_TTL_MS = 24 * 60 * 60 * 1000
/** At most this many guests in one file. */
const MAX_ROWS = 10_000

const customerFilters = z.object({
  search: z.string().trim().max(100).optional(),
  conceptId: z.string().uuid().optional(),
}).strict()
type CustomerFilters = z.infer<typeof customerFilters>

const askSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('customers'), filters: customerFilters.default({}), reason: z.string().trim().min(10, 'Say why you need it (at least 10 characters)').max(500) }),
  z.object({ kind: z.literal('waitlist'), filters: waitlistListQuery.omit({ page: true }).default({}), reason: z.string().trim().min(10, 'Say why you need it (at least 10 characters)').max(500) }),
])

const isCeo = (req: FastifyRequest) => req.staffUser?.role === 'admin'

/** The guest list of these companies' brands (optionally one brand / a search), as the one export table. */
export async function customerExportTable(tenantIds: string[], f: CustomerFilters): Promise<ReportTable> {
  const concepts = tenantIds.length
    ? await prisma.concept.findMany({ where: { tenantId: { in: tenantIds }, deletedAt: null }, select: { id: true } })
    : []
  let conceptIds = concepts.map((c) => c.id)
  if (f.conceptId) {
    if (!conceptIds.includes(f.conceptId)) throw new NotFoundError('Concept', f.conceptId)
    conceptIds = [f.conceptId]
  }
  const search = f.search?.trim()
  const customers = conceptIds.length === 0 ? [] : await prisma.customer.findMany({
    where: {
      deletedAt: null,
      ...(search && {
        OR: [
          { name: { contains: search, mode: 'insensitive' } },
          { email: { contains: search, mode: 'insensitive' } },
          { phone: { contains: search } },
          { memberCode: { equals: search.toUpperCase() } },
          { nickname: { equals: search, mode: 'insensitive' } },
        ],
      }),
      // The company's guests: people who ordered at its brands (as the CRM list).
      orders: { some: { conceptId: { in: conceptIds }, deletedAt: null } },
    },
    select: { id: true, name: true, phone: true, email: true, memberCode: true, marketingOptIn: true },
    orderBy: { createdAt: 'desc' },
    take: MAX_ROWS,
  })
  const stats = new Map((await companyCustomerStats(conceptIds, customers.map((c) => c.id))).map((s) => [s.id, s]))
  const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : '')
  return {
    title: 'Guest list',
    companies: await companyNamesOf(tenantIds),
    columns: [
      { key: 'name', label: 'Name' }, { key: 'phone', label: 'Phone' }, { key: 'email', label: 'Email' },
      { key: 'member_code', label: 'Member code' }, { key: 'orders', label: 'Orders', type: 'number' },
      { key: 'spent_pkr', label: 'Spent (PKR)', type: 'pkr' }, { key: 'first_order', label: 'First order' },
      { key: 'last_order', label: 'Last order' }, { key: 'marketing_opt_in', label: 'Marketing opt-in' },
    ],
    rows: customers.map((c) => {
      const s = stats.get(c.id)
      return {
        name: c.name ?? '', phone: c.phone ?? '', email: c.email ?? '', member_code: c.memberCode ?? '',
        orders: s?.n ?? 0, spent_pkr: (s?.spent ?? 0) / 100, first_order: day(s?.firstAt), last_order: day(s?.lastAt),
        marketing_opt_in: c.marketingOptIn ? 'yes' : 'no',
      }
    }),
  }
}

async function auditDownload(req: FastifyRequest, tenantId: string | null, e: { kind: string; rows: number; requestId?: string; filters: unknown }) {
  await audit({
    category: 'identity', action: 'customer_export.download', entity: e.requestId ? 'CustomerExportRequest' : 'Customer', entityId: e.requestId ?? null,
    userId: req.staffUser!.id, userEmail: req.staffUser!.email ?? null, tenantId,
    metadata: { kind: e.kind, rowCount: e.rows, filters: e.filters, viaRequest: !!e.requestId, actorRole: req.staffUser!.role },
  })
}

function sendWaitlistCsv(reply: FastifyReply, text: string) {
  return reply
    .header('content-type', 'text/csv; charset=utf-8')
    .header('content-disposition', `attachment; filename="servd-waitlist-${new Date().toISOString().slice(0, 10)}.csv"`)
    .send(text)
}

export async function customerExportRoutes(fastify: FastifyInstance) {
  // GET /crm/customers/export — the CEO's own download, at once (companies in view).
  fastify.get<{ Querystring: { format?: string; search?: string; conceptId?: string } }>('/customers/export', { preHandler: requireAuth(...MARKETING_TEAM) }, async (req, reply) => {
    if (!isCeo(req)) throw new AppError('EXPORT_NEEDS_CEO', 'Downloading the guest list with phones and emails needs the CEO — ask the CEO to export.', 403)
    const format = exportFormatOf(req.query.format, 'csv')!
    const f = customerFilters.parse({ ...(req.query.search ? { search: req.query.search } : {}), ...(req.query.conceptId ? { conceptId: req.query.conceptId } : {}) })
    if (f.conceptId) await assertConceptOwned(req, f.conceptId, 'read')
    const tenantIds = tenantIdsOf(await scopeTenantWhere(req, 'read'))
    const t = await customerExportTable(tenantIds, f)
    await auditDownload(req, req.staffUser!.tenantId ?? null, { kind: 'customers', rows: t.rows.length, filters: f })
    return sendReport(reply, format, 'guest-list', t)
  })

  // POST /crm/exports — anyone but the CEO asks the CEO for a download (202).
  fastify.post('/exports', { preHandler: requireAuth(...MARKETING_TEAM) }, async (req, reply) => {
    if (isCeo(req)) throw new AppError('CEO_EXPORTS_DIRECTLY', 'The CEO downloads the list directly — no request needed.', 422)
    const body = askSchema.parse(req.body ?? {})
    const tenantId = req.staffUser!.tenantId
    if (!tenantId) throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company before asking for a download', 422)
    if (body.kind === 'customers' && body.filters.conceptId) await assertConceptOwned(req, body.filters.conceptId, 'create')
    const row = await prisma.customerExportRequest.create({
      data: { tenantId, kind: body.kind, filters: body.filters, reason: body.reason, requestedById: req.staffUser!.id },
    })
    await audit({
      category: 'identity', action: 'customer_export.requested', entity: 'CustomerExportRequest', entityId: row.id,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email ?? null, tenantId,
      metadata: { kind: row.kind, filters: body.filters, actorRole: req.staffUser!.role },
    })
    // The bell: the CEO is told (queued, after the commit).
    approvalWaiting('customer_export', row.id, { round: row.requestedAt.toISOString(), actorId: req.staffUser!.id })
    return reply.status(202).send({ pendingApproval: true, request: shape(row, req) })
  })

  // GET /crm/exports?status= — the CEO: every request of the companies in view; anyone else: their own.
  fastify.get<{ Querystring: { status?: string } }>('/exports', { preHandler: requireAuth(...MARKETING_TEAM) }, async (req) => {
    const scope = await scopeTenantWhere(req, 'read')
    const status = req.query.status && ['pending', 'approved', 'rejected', 'cancelled'].includes(req.query.status) ? req.query.status : undefined
    const rows = await prisma.customerExportRequest.findMany({
      where: { ...scope, ...(status ? { status } : {}), ...(!isCeo(req) && { requestedById: req.staffUser!.id }) },
      orderBy: { requestedAt: 'desc' },
      take: 100,
    })
    const userIds = [...new Set(rows.map((r) => r.requestedById))]
    const conceptIds = [...new Set(rows.map((r) => (r.filters as { conceptId?: string } | null)?.conceptId).filter((x): x is string => !!x))]
    const [users, concepts] = await Promise.all([
      prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }),
      prisma.concept.findMany({ where: { id: { in: conceptIds } }, select: { id: true, name: true } }),
    ])
    const uName = new Map(users.map((u) => [u.id, u.name]))
    const cName = new Map(concepts.map((c) => [c.id, c.name]))
    return {
      items: rows.map((r) => ({
        ...shape(r, req),
        requestedByName: uName.get(r.requestedById) ?? null,
        brandName: (r.filters as { conceptId?: string } | null)?.conceptId ? cName.get((r.filters as { conceptId: string }).conceptId) ?? null : null,
      })),
    }
  })

  async function forDecision(req: FastifyRequest, id: string) {
    const scope = await scopeTenantWhere(req, 'write')
    const r = await prisma.customerExportRequest.findFirst({ where: { id, ...scope } })
    if (!r) throw new NotFoundError('Download request', id)
    return r
  }

  async function grantFor(req: FastifyRequest, id: string) {
    const s = await approvalSubject('customer_export', id)
    if (!s) throw new NotFoundError('Download request', id)
    return assertCanApprove(req, approvalInputOf('customer_export', id, s))
  }

  const notPending = () => new AppError('NOT_PENDING', 'This download request is no longer waiting for approval.', 409)

  // POST /crm/exports/:id/approve — the CEO: one download within 24 hours.
  fastify.post<{ Params: { id: string } }>('/exports/:id/approve', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const body = z.object({ note: z.string().trim().max(500).optional() }).parse(req.body ?? {})
    const r = await forDecision(req, req.params.id)
    const grant = await grantFor(req, r.id)
    const now = new Date()
    const expiresAt = new Date(now.getTime() + EXPORT_TTL_MS)
    const claimed = await prisma.customerExportRequest.updateMany({
      where: { id: r.id, status: 'pending' },
      data: { status: 'approved', decidedById: req.staffUser!.id, decidedAt: now, decisionNote: body.note ?? null, expiresAt },
    })
    if (claimed.count === 0) throw notPending()
    await auditApproval(req, {
      type: 'customer_export', id: r.id, tenantId: r.tenantId, decision: 'approve', grant, entity: 'CustomerExportRequest',
      metadata: { kind: r.kind, expiresAt: expiresAt.toISOString(), decidedAt: now.toISOString(), note: body.note ?? null },
    })
    return { id: r.id, approved: true, expiresAt }
  })

  // POST /crm/exports/:id/reject {note ≥10} — the CEO turns it down.
  fastify.post<{ Params: { id: string } }>('/exports/:id/reject', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const body = z.object({ note: z.string().trim().min(10, 'Give a reason of at least 10 characters').max(500) }).parse(req.body ?? {})
    const r = await forDecision(req, req.params.id)
    const grant = await grantFor(req, r.id)
    const now = new Date()
    const claimed = await prisma.customerExportRequest.updateMany({
      where: { id: r.id, status: 'pending' },
      data: { status: 'rejected', decidedById: req.staffUser!.id, decidedAt: now, decisionNote: body.note },
    })
    if (claimed.count === 0) throw notPending()
    await auditApproval(req, {
      type: 'customer_export', id: r.id, tenantId: r.tenantId, decision: 'reject', grant, entity: 'CustomerExportRequest',
      metadata: { kind: r.kind, note: body.note, decidedAt: now.toISOString() },
    })
    return { id: r.id, rejected: true }
  })

  // POST /crm/exports/:id/withdraw — the requester takes back their own pending request.
  fastify.post<{ Params: { id: string } }>('/exports/:id/withdraw', { preHandler: requireAuth(...MARKETING_TEAM) }, async (req) => {
    const r = await forDecision(req, req.params.id)
    if (r.requestedById !== req.staffUser!.id) throw new ForbiddenError('Only the person who asked may withdraw it')
    const claimed = await prisma.customerExportRequest.updateMany({ where: { id: r.id, status: 'pending' }, data: { status: 'cancelled', decidedAt: new Date() } })
    if (claimed.count === 0) throw notPending()
    await audit({
      category: 'identity', action: 'customer_export.withdrawn', entity: 'CustomerExportRequest', entityId: r.id,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email ?? null, tenantId: r.tenantId, metadata: { kind: r.kind },
    })
    return { id: r.id, cancelled: true }
  })

  // GET /crm/exports/:id/download?format= — the requester's one download within 24 hours of the approval.
  fastify.get<{ Params: { id: string }; Querystring: { format?: string } }>('/exports/:id/download', { preHandler: requireAuth(...MARKETING_TEAM) }, async (req, reply) => {
    const r = await forDecision(req, req.params.id)
    if (r.requestedById !== req.staffUser!.id) throw new AppError('NOT_YOUR_EXPORT', 'Only the person who asked may download it', 403)
    if (r.status !== 'approved' || !r.expiresAt) throw new AppError('EXPORT_NOT_APPROVED', 'This download has not been approved by the CEO', 409)
    if (r.downloadedAt) throw new AppError('EXPORT_ALREADY_DOWNLOADED', 'This list was already downloaded — ask the CEO again for another copy', 409)
    if (r.expiresAt.getTime() <= Date.now()) throw new AppError('EXPORT_EXPIRED', 'The 24 hours to download this list have passed — ask the CEO again', 410)
    // Built first, claimed second: a failure while building never uses up the one download.
    let file: { kind: 'table'; t: ReportTable } | { kind: 'csv'; text: string; rows: number }
    if (r.kind === 'waitlist') {
      const q = waitlistListQuery.parse(r.filters ?? {})
      const c = await waitlistSignupsCsv(q, true)
      file = { kind: 'csv', ...c }
    } else {
      file = { kind: 'table', t: await customerExportTable([r.tenantId], customerFilters.parse(r.filters ?? {})) }
    }
    const rows = file.kind === 'csv' ? file.rows : file.t.rows.length
    const claimed = await prisma.customerExportRequest.updateMany({
      where: { id: r.id, status: 'approved', downloadedAt: null, expiresAt: { gt: new Date() } },
      data: { downloadedAt: new Date(), rowCount: rows },
    })
    if (claimed.count === 0) throw new AppError('EXPORT_ALREADY_DOWNLOADED', 'This list was already downloaded or the 24 hours have passed — ask the CEO again', 409)
    await auditDownload(req, r.tenantId, { kind: r.kind, rows, requestId: r.id, filters: r.filters })
    if (file.kind === 'csv') return sendWaitlistCsv(reply, file.text)
    return sendReport(reply, exportFormatOf(req.query.format, 'csv')!, 'guest-list', file.t)
  })
}

/** A request as the screens read it: its state (waiting / ready / downloaded / expired / …) and what the caller may do. */
function shape(r: {
  id: string; tenantId: string; kind: string; filters: unknown; reason: string; status: string; requestedById: string
  requestedAt: Date; decidedAt: Date | null; decisionNote: string | null; expiresAt: Date | null; downloadedAt: Date | null; rowCount: number | null
}, req: FastifyRequest) {
  const expired = r.status === 'approved' && !r.downloadedAt && !!r.expiresAt && r.expiresAt.getTime() <= Date.now()
  const state = r.status === 'approved' ? (r.downloadedAt ? 'downloaded' : expired ? 'expired' : 'ready') : r.status
  const mine = r.requestedById === req.staffUser!.id
  return {
    id: r.id, tenantId: r.tenantId, kind: r.kind, filters: r.filters, reason: r.reason, status: r.status, state,
    requestedById: r.requestedById, requestedAt: r.requestedAt, decidedAt: r.decidedAt, decisionNote: r.decisionNote,
    expiresAt: r.expiresAt, downloadedAt: r.downloadedAt, rowCount: r.rowCount,
    canDownload: mine && state === 'ready', canWithdraw: mine && r.status === 'pending',
  }
}
