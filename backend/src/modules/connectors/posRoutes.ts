// Till side of the POS connector (spec §8.2): the card machine at the till
// and each order's fiscal documents. Prefix /pos (registered beside the
// existing pos plugin; the paths do not overlap). Company scope: every order,
// drawer, charge and payment is resolved through the operator's companies
// first (foreign → 404, another company's drawer → 422).

import { zBackdatedReason } from '../nightAudit/backdate.js'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { UserRole } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { NotFoundError } from '../../lib/errors.js'
import { scopeTenantWhere } from '../../lib/tenantScope.js'
import { CASHIERS, MANAGERS, requireAuth } from '../auth/middleware.js'
import {
  terminalConfigForShift, startTerminalCharge, chargeInScope, chargeView, refreshCharge, isFinalStatus,
  cancelTerminalCharge, resolveTerminalCharge, manualReverseCharge, startTerminalRefund, chargesForOrder,
} from '../../connectors/terminal/service.js'
import { fiscalViewsForOrder } from '../../connectors/fiscal/view.js'
import { retryDocument } from '../../connectors/fiscal/outbox.js'
import { audit } from '../../lib/audit.js'

const isManager = (role: string) => (MANAGERS as readonly string[]).includes(role)
const idParam = z.object({ id: z.string().min(1).max(64) })
const orderParam = z.object({ orderId: z.string().min(1).max(64) })
// The order's fiscal panel: the till plus finance and management (read only;
// lastError stays managers-only through isManager).
const FISCAL_READERS = [...new Set<UserRole>([...CASHIERS, 'finance', 'management'])]

export async function connectorPosRoutes(fastify: FastifyInstance) {
  // GET /pos/terminal/config?shiftId=
  fastify.get('/terminal/config', { preHandler: requireAuth(...CASHIERS) }, async (req) => {
    const { shiftId } = z.object({ shiftId: z.string().min(1).max(64) }).parse(req.query)
    return terminalConfigForShift(req, shiftId)
  })

  // POST /pos/terminal/charges — start a charge on the card machine.
  fastify.post('/terminal/charges', { preHandler: requireAuth(...CASHIERS) }, async (req, reply) => {
    const body = z.object({
      orderId: z.string().min(1).max(64),
      shiftId: z.string().min(1).max(64),
      terminalId: z.string().min(1).max(64),
      tipCents: z.number().int().min(0).default(0),
      expectedDueCents: z.number().int().min(0),
      idempotencyKey: z.string().min(8).max(100),
      paymentId: z.string().min(1).max(64).optional(),
    }).parse(req.body)
    const { view, replay } = await startTerminalCharge(req, body)
    return reply.status(replay ? 200 : 201).send(view)
  })

  // GET /pos/terminal/charges?orderId=&active=1
  fastify.get('/terminal/charges', { preHandler: requireAuth(...CASHIERS) }, async (req) => {
    const q = z.object({ orderId: z.string().min(1).max(64), active: z.enum(['0', '1']).optional() }).parse(req.query)
    return chargesForOrder(req, q.orderId, q.active === '1')
  })

  // GET /pos/terminal/charges/:id — refreshed from the machine when stale.
  fastify.get('/terminal/charges/:id', { preHandler: requireAuth(...CASHIERS) }, async (req) => {
    const { id } = idParam.parse(req.params)
    let c = await chargeInScope(req, id, 'write')
    if (!isFinalStatus(c.status)) c = (await refreshCharge(c.id, { via: 'poll' })) ?? c
    return chargeView(c, { staff: isManager(req.staffUser!.role) })
  })

  // POST /pos/terminal/charges/:id/cancel — own charge, or a manager.
  fastify.post('/terminal/charges/:id/cancel', { preHandler: requireAuth(...CASHIERS) }, async (req) => {
    const { id } = idParam.parse(req.params)
    return cancelTerminalCharge(req, id)
  })

  // POST /pos/terminal/charges/:id/resolve — the cashier reads the machine.
  fastify.post('/terminal/charges/:id/resolve', { preHandler: requireAuth(...CASHIERS) }, async (req) => {
    const { id } = idParam.parse(req.params)
    const body = z.discriminatedUnion('outcome', [
      z.object({ outcome: z.literal('approved_manual'), gatewayRef: z.string().trim().min(3).max(64) }),
      z.object({ outcome: z.literal('not_charged'), note: z.string().max(300).optional() }),
    ]).parse(req.body)
    return resolveTerminalCharge(req, id, body)
  })

  // POST /pos/terminal/charges/:id/reverse — managers, from needs_attention.
  fastify.post('/terminal/charges/:id/reverse', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const { id } = idParam.parse(req.params)
    // backdatedReason: the CEO's reason for a charge of an earlier sales day (night audit; 403 CEO_ONLY_BACKDATED otherwise).
    const body = z.object({ markRefundedOnMachine: z.boolean().optional(), note: z.string().max(300).optional(), backdatedReason: zBackdatedReason }).parse(req.body ?? {})
    return manualReverseCharge(req, id, body)
  })

  // POST /pos/terminal/refunds — refund a card-machine payment to the card.
  fastify.post('/terminal/refunds', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = z.object({
      paymentId: z.string().min(1).max(64),
      amountCents: z.number().int().positive(),
      terminalId: z.string().min(1).max(64),
      idempotencyKey: z.string().min(8).max(100),
      reason: z.string().trim().min(3).max(300),
      // Required when the company's RefundPolicy demands photo evidence (checked before the machine is asked).
      photoUrl: z.string().url().max(1000).optional(),
    }).parse(req.body)
    const { view, replay } = await startTerminalRefund(req, body)
    return reply.status(replay ? 200 : 201).send(view)
  })

  // GET /pos/orders/:orderId/fiscal — the order's fiscal documents.
  fastify.get('/orders/:orderId/fiscal', { preHandler: requireAuth(...FISCAL_READERS) }, async (req) => {
    const { orderId } = orderParam.parse(req.params)
    const order = await prisma.order.findFirst({ where: { id: orderId, concept: await scopeTenantWhere(req, 'write') }, select: { id: true } })
    if (!order) throw new NotFoundError('Order', orderId)
    return fiscalViewsForOrder(order.id, { staff: isManager(req.staffUser!.role) })
  })

  // POST /pos/orders/:orderId/fiscal/retry — managers: retry its failed / rejected documents.
  fastify.post('/orders/:orderId/fiscal/retry', { preHandler: requireAuth(...(MANAGERS as UserRole[])) }, async (req) => {
    const { orderId } = orderParam.parse(req.params)
    const scope = await scopeTenantWhere(req, 'write')
    const order = await prisma.order.findFirst({ where: { id: orderId, concept: scope }, select: { id: true } })
    if (!order) throw new NotFoundError('Order', orderId)
    const docs = await prisma.fiscalDocument.findMany({ where: { orderId, ...scope, status: { in: ['failed', 'rejected'] } }, select: { id: true, tenantId: true } })
    for (const d of docs) {
      await retryDocument(d.id, scope)
      await audit({ category: 'identity', action: 'fiscal.retry', entity: 'FiscalDocument', entityId: d.id, userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId: d.tenantId, metadata: { orderId } })
    }
    return { retried: docs.length, fiscal: await fiscalViewsForOrder(orderId, { staff: true }) }
  })
}
