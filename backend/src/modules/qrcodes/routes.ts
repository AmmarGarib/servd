import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MARKETING_TEAM } from '../auth/middleware.js'
import { requireModule } from '../notifications/requireModule.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { assertConceptOwned, conceptWhere, scopeTenantWhere, type ScopeMode } from '../../lib/tenantScope.js'
import { moveToTrash, trashReasonOf } from '../../lib/trash.js'
import { takeSnapshot } from '../trash/snapshot.js'
import { TRASH_MARKETING } from '../trash/providers/masters/marketing.js'

// Company scoping: QR codes are brand-anchored (conceptId), so ownership is
// resolved through the brand: qrCode → concept → tenant. Every operator
// handler goes through `scopeTenantWhere` (reads are view-aware, edits span
// every company the operator belongs to, creates bind to the active company
// only). A QR may only point at a table of its own brand — otherwise a
// guessed tableId would print another company's table onto the code.
//
// `/:id/scan` and `/:id/convert` are public, unauthenticated counters hit by
// the storefront on QR load; there is no operator context to scope them by.

const createQrSchema = z.object({
  conceptId: z.string().uuid(),
  tableId: z.string().uuid().optional(),
  orderType: z.enum(['dine-in', 'pickup']).default('dine-in'),
  label: z.string().min(1),
})

/**
 * Resolve a QR code the operator may act on in `mode`, or 404. Ownership is
 * through the brand (qrCode.concept.tenantId); a foreign id never confirms
 * the code exists.
 */
async function findOwnedQr(req: FastifyRequest, id: string, mode: ScopeMode) {
  const qr = await prisma.qrCode.findFirst({
    where: {
      id,
      concept: { deletedAt: null, ...(await scopeTenantWhere(req, mode)) },
    },
  })
  if (!qr) throw new NotFoundError('QrCode', id)
  return qr
}

/**
 * Throws unless `tableId` is a live table of `conceptId`. The brand itself
 * has already been checked against the company, so same-brand implies
 * same-company.
 */
async function assertTableOfConcept(tableId: string, conceptId: string): Promise<void> {
  const table = await prisma.table.findFirst({
    where: { id: tableId, conceptId, deletedAt: null },
    select: { id: true },
  })
  if (!table) throw new NotFoundError('Table', tableId)
}

// Module Access really closes these staff routes (W3A-RV-03): the role array
// lets the Marketing team in, and the CEO's Module Access (decision 34)
// narrows it to logins holding promos (QR codes page) or configuration (the hub's QR tile). Same source of truth as the
// central gate (lib/moduleAccess.ts effectiveModulesForUser).
const marketingGuard = [requireAuth(...MARKETING_TEAM), requireModule('promos', 'configuration')]

// Access (wave 3, UI-06): QR codes sit under Promotions (module promos), so
// the operator routes are MARKETING_TEAM — MANAGERS plus marketing and
// brand_manager. Company scope is unchanged (see above).
export async function qrCodeRoutes(fastify: FastifyInstance) {
  // GET /qrcodes — view-aware company scope; a client conceptId narrows the
  // list but is validated (404 for a foreign brand) rather than trusted.
  fastify.get<{ Querystring: { conceptId?: string } }>(
    '/',
    { preHandler: marketingGuard },
    async (req) => {
      return prisma.qrCode.findMany({
        where: await conceptWhere(req, req.query.conceptId, 'read'),
        include: {
          concept: { select: { name: true, slug: true } },
          table: { select: { label: true } },
        },
        orderBy: { createdAt: 'desc' },
      })
    },
  )

  // POST /qrcodes — the brand must belong to the ACTIVE company, and the
  // table (if any) to that brand.
  fastify.post('/', { preHandler: marketingGuard }, async (req, reply) => {
    const body = createQrSchema.parse(req.body)
    if (!req.staffUser!.tenantId) {
      throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company before generating a QR code', 422)
    }
    // 'create' mode: the active company only — never let a new code land
    // under a brand of another company the operator happens to belong to.
    await assertConceptOwned(req, body.conceptId, 'create')
    if (body.tableId) await assertTableOfConcept(body.tableId, body.conceptId)
    const qr = await prisma.qrCode.create({ data: body })
    // Build QR URL pointing to storefront with qr param
    const storefrontUrl = process.env['STOREFRONT_URL'] ?? 'http://localhost:3002'
    const concept = await prisma.concept.findUnique({ where: { id: body.conceptId }, select: { slug: true } })
    const qrUrl = `${storefrontUrl}/${concept?.slug ?? 'order'}?qr=${qr.id}&table=${body.tableId ?? ''}&type=${body.orderType}`
    await prisma.qrCode.update({ where: { id: qr.id }, data: { qrImageUrl: qrUrl } })
    return reply.status(201).send({ ...qr, qrImageUrl: qrUrl })
  })

  // POST /qrcodes/:id/scan — increment scan count (called by storefront on QR load)
  //
  // Per-IP rate-limited and de-duplicated: an IP can only register one scan
  // per QR per minute. Without this an attacker could spam either endpoint
  // and inflate the conversion-rate KPI that managers use to decide where
  // to spend their next QR-tabletop printing budget.
  fastify.post<{ Params: { id: string } }>(
    '/:id/scan',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req) => {
      const ip = req.ip ?? 'unknown'
      const dedupKey = `qrscan:${req.params.id}:${ip}`
      try {
        const { redis } = await import('../../lib/redis.js')
        const fresh = await redis.set(dedupKey, '1', 'EX', 60, 'NX')
        // Already counted this IP in the last minute — skip the write but
        // still return the QR shape the storefront expects.
        if (fresh !== 'OK') {
          const cached = await prisma.qrCode.findUnique({
            where: { id: req.params.id },
            select: { id: true, scanCount: true, orderType: true, table: { select: { label: true } } },
          })
          if (!cached) throw new NotFoundError('QrCode', req.params.id)
          return cached
        }
      } catch (err) {
        // Redis down → fall through to the increment. Worst case we count a
        // duplicate scan; better than 500ing the QR-landing page.
        if (err instanceof NotFoundError) throw err
      }
      const qr = await prisma.qrCode.update({
        where: { id: req.params.id },
        data: { scanCount: { increment: 1 } },
        select: { id: true, scanCount: true, orderType: true, table: { select: { label: true } } },
      })
      return qr
    },
  )

  // POST /qrcodes/:id/convert — increment conversion (called when order placed via QR)
  fastify.post<{ Params: { id: string } }>(
    '/:id/convert',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req) => {
      // Same dedup approach as /scan — one conversion per (IP, QR) per minute.
      const ip = req.ip ?? 'unknown'
      const dedupKey = `qrconvert:${req.params.id}:${ip}`
      try {
        const { redis } = await import('../../lib/redis.js')
        const fresh = await redis.set(dedupKey, '1', 'EX', 60, 'NX')
        if (fresh !== 'OK') return { ok: true, dedup: true }
      } catch { /* Redis down → fall through */ }
      await prisma.qrCode.update({
        where: { id: req.params.id },
        data: { conversions: { increment: 1 } },
      })
      return { ok: true }
    },
  )

  // PATCH /qrcodes/:id — must belong to a company the operator is in. The
  // brand is fixed at creation (conceptId is stripped from the body); a new
  // tableId must be a table of that same brand.
  fastify.patch<{ Params: { id: string } }>(
    '/:id',
    { preHandler: marketingGuard },
    async (req) => {
      const body = createQrSchema.partial().omit({ conceptId: true }).parse(req.body)
      const existing = await findOwnedQr(req, req.params.id, 'write')
      if (body.tableId) await assertTableOfConcept(body.tableId, existing.conceptId)
      return prisma.qrCode.update({ where: { id: existing.id }, data: body })
    },
  )

  // DELETE /qrcodes/:id — must belong to a company the operator is in
  fastify.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: marketingGuard },
    async (req, reply) => {
      const existing = await findOwnedQr(req, req.params.id, 'write')
      // Hard delete, kept whole in the Trash (same id on restore, so a printed code works again).
      await prisma.$transaction(async (tx) => {
        const brand = await tx.concept.findUnique({ where: { id: existing.conceptId }, select: { tenantId: true, name: true } })
        await moveToTrash(tx, req, {
          type: TRASH_MARKETING.qr_code, entityId: existing.id, tenantId: brand?.tenantId ?? null, conceptId: existing.conceptId,
          title: existing.label, subtitle: `${brand?.name ?? 'Brand'} · ${existing.scanCount} scans`, reason: trashReasonOf(req),
          parent: { type: 'brand', id: existing.conceptId },
          snapshot: takeSnapshot('QrCode', existing),
        })
        await tx.qrCode.delete({ where: { id: existing.id } })
      })
      return reply.status(204).send()
    },
  )
}
