// Shift corrections (owner, 2026-10-21) — /api/v1/pos/shift-corrections.
// The service (./service.ts) holds the rules; contract in CLAUDE.md
// "Shift corrections". Module-gated `accounting` (lib/moduleAccess.ts
// GATED_PREFIXES — the only gated path under /pos).
//
//   GET  /shift/:shiftId   finance, CEO   a closed drawer's bills / tickets and what may be corrected
//   POST /                 finance, CEO   raise a set {shiftId, reason, items[]} → submitted (bell to the CEO)
//   GET  /                 finance, CEO   ?status ?shiftId
//   GET  /:id              finance, CEO   the set with a preview of each fix
//   POST /:id/approve      CEO            {note?} → applied | failed (the response says which)
//   POST /:id/reject       CEO            {note ≥10} → rejected; nothing changes
//   POST /:id/retry        CEO            a failed set → applied | failed

import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { UserRole } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { NotFoundError } from '../../lib/errors.js'
import { audit } from '../../lib/audit.js'
import { requireAuth, ADMIN_ONLY } from '../auth/middleware.js'
import { scopeTenantWhere, shiftWhere } from '../../lib/tenantScope.js'
import { approvalInputOf, approvalSubject, assertCanApprove, auditApproval } from '../../lib/approvalRights.js'
import { approvalWaiting } from '../approvals/notify.js'
import { TILL_TENDERS } from '../../lib/tenders.js'
import {
  ITEM_KINDS, MAX_ITEMS, MIN_REASON, SHIFT_SELECT, applyCorrection, claimDecision, claimRetry, correctionView,
  createCorrection, loadCorrection, shiftCandidates, type Actor,
} from './service.js'

/** Finance (the accounting module, enforced by the gate) and the CEO raise and read. */
export const SHIFT_CORRECTION_RAISERS = ['admin', 'finance'] as UserRole[]

const itemSchema = z.object({
  orderId: z.string().uuid(),
  kind: z.enum(ITEM_KINDS),
  reason: z.string().trim().min(MIN_REASON).max(500),
  moneyReturned: z.boolean().optional(),
  foodMade: z.boolean().optional(),
  newTender: z.enum(TILL_TENDERS).nullable().optional(),
})

const createSchema = z.object({
  shiftId: z.string().uuid(),
  reason: z.string().trim().min(MIN_REASON).max(1000),
  items: z.array(itemSchema).min(1).max(MAX_ITEMS),
})

const listQuery = z.object({
  status: z.enum(['submitted', 'approved', 'rejected', 'applied', 'failed']).optional(),
  shiftId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
})

const approveSchema = z.object({ note: z.string().trim().max(1000).optional() })
const rejectSchema = z.object({ note: z.string().trim().min(MIN_REASON).max(1000) })

function actorOf(req: FastifyRequest): Actor {
  const su = req.staffUser!
  return { id: su.id, role: su.role, email: su.email ?? null }
}

async function shiftInScope(req: FastifyRequest, id: string, mode: 'read' | 'write') {
  const shift = await prisma.shift.findFirst({ where: { id, ...(await shiftWhere(req, mode)) }, select: SHIFT_SELECT })
  if (!shift) throw new NotFoundError('Shift', id)
  return shift
}

export async function shiftCorrectionRoutes(app: FastifyInstance): Promise<void> {
  const raisers = { preHandler: requireAuth(...SHIFT_CORRECTION_RAISERS) }
  const ceo = { preHandler: requireAuth(...ADMIN_ONLY) }

  app.get<{ Params: { shiftId: string } }>('/shift/:shiftId', raisers, async (req) => {
    const shiftId = z.string().uuid().parse(req.params.shiftId)
    return shiftCandidates(await shiftInScope(req, shiftId, 'read'))
  })

  app.post('/', raisers, async (req, reply) => {
    const body = createSchema.parse(req.body ?? {})
    // The shift's company must be one the caller is in ('write' — a member, never a view).
    const shift = await shiftInScope(req, body.shiftId, 'write')
    const created = await createCorrection({ shift, reason: body.reason, items: body.items, actor: actorOf(req) })
    // The bell: the CEO(s) of the shift's company (APPROVAL_RIGHTS.shift_correction — section 'ceo').
    approvalWaiting('shift_correction', created.id, { round: created.createdAt.toISOString(), actorId: req.staffUser!.id })
    const full = await loadCorrection(prisma, created.id, { tenantId: created.tenantId })
    return reply.code(201).send(await correctionView(full, { preview: true }))
  })

  app.get('/', raisers, async (req) => {
    const q = listQuery.parse(req.query ?? {})
    const rows = await prisma.shiftCorrection.findMany({
      where: {
        ...(await scopeTenantWhere(req, 'read')),
        ...(q.status ? { status: q.status } : {}),
        ...(q.shiftId ? { shiftId: q.shiftId } : {}),
      },
      include: { items: { orderBy: { createdAt: 'asc' } } },
      orderBy: { createdAt: 'desc' },
      take: q.limit ?? 100,
    })
    return { items: await Promise.all(rows.map((r) => correctionView(r, { preview: false }))) }
  })

  app.get<{ Params: { id: string } }>('/:id', raisers, async (req) => {
    const id = z.string().uuid().parse(req.params.id)
    const c = await loadCorrection(prisma, id, await scopeTenantWhere(req, 'read'))
    return correctionView(c, { preview: true })
  })

  /** The CEO's decision: APPROVAL_RIGHTS (CEO only, never handed over), then the claim, then the apply. */
  async function decide(req: FastifyRequest, id: string) {
    const found = await loadCorrection(prisma, id, await scopeTenantWhere(req, 'write'))
    const s = await approvalSubject('shift_correction', found.id)
    if (!s) throw new NotFoundError('ShiftCorrection', id)
    const grant = await assertCanApprove(req, approvalInputOf('shift_correction', found.id, s))
    return { found, grant }
  }

  app.post<{ Params: { id: string } }>('/:id/approve', ceo, async (req) => {
    const id = z.string().uuid().parse(req.params.id)
    const body = approveSchema.parse(req.body ?? {})
    const { found, grant } = await decide(req, id)
    const claimed = await claimDecision(found.id, 'approved', actorOf(req), body.note?.trim() || null)
    await auditApproval(req, {
      type: 'shift_correction', id: found.id, tenantId: found.tenantId, decision: 'approve', grant, entity: 'ShiftCorrection',
      metadata: { note: body.note?.trim() || null, decidedAt: claimed.decidedAt, actorRole: req.staffUser!.role, shiftId: found.shiftId },
    })
    await applyCorrection(found.id, actorOf(req))
    return correctionView(await loadCorrection(prisma, found.id, { tenantId: found.tenantId }), { preview: false })
  })

  app.post<{ Params: { id: string } }>('/:id/reject', ceo, async (req) => {
    const id = z.string().uuid().parse(req.params.id)
    const body = rejectSchema.parse(req.body ?? {})
    const { found, grant } = await decide(req, id)
    const claimed = await claimDecision(found.id, 'rejected', actorOf(req), body.note)
    await auditApproval(req, {
      type: 'shift_correction', id: found.id, tenantId: found.tenantId, decision: 'reject', grant, entity: 'ShiftCorrection',
      metadata: { note: body.note, decidedAt: claimed.decidedAt, actorRole: req.staffUser!.role, shiftId: found.shiftId },
    })
    return correctionView(await loadCorrection(prisma, found.id, { tenantId: found.tenantId }), { preview: false })
  })

  app.post<{ Params: { id: string } }>('/:id/retry', ceo, async (req) => {
    const id = z.string().uuid().parse(req.params.id)
    const found = await loadCorrection(prisma, id, await scopeTenantWhere(req, 'write'))
    await claimRetry(found.id)
    await audit({
      category: 'accounting', action: 'shift_correction.retry', entity: 'ShiftCorrection', entityId: found.id,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email ?? null, tenantId: found.tenantId,
      before: { status: 'failed', error: found.error }, after: { status: 'approved' }, metadata: { actorRole: req.staffUser!.role },
    })
    await applyCorrection(found.id, actorOf(req))
    return correctionView(await loadCorrection(prisma, found.id, { tenantId: found.tenantId }), { preview: false })
  })
}
