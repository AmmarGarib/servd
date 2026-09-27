// Check splitting at POS.
//
// Strategy: an Order is one bill, but its Payment rows can be split across
// multiple diners. Each diner gets a Payment with the same orderId but a
// distinct splitGroup integer. Sum of all splits' amountCents must equal
// order total.
//
// This module only ALLOCATES the bill into portions. Taking the money for a
// portion is the ONE settle (settlePayment in pos/service.ts): an open drawer
// of the order's company, the card terminal's reference for card / QR, and
// the one coverage rule — the bill completes when the last portion is paid,
// and the group order's 'split' placeholder is voided. The settle here used
// to mark a portion paid on no drawer (group and storefront orders carry no
// shiftId), with no reference, never completing the order.

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, ALL_STAFF, CASHIERS } from '../auth/middleware.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { scopeTenantWhere } from '../../lib/tenantScope.js'
import { settlePayment } from '../pos/service.js'

/** The order, in the operator's companies (write scope) — never the raw tenantFilter. */
async function orderInScope(req: FastifyRequest, id: string) {
  return prisma.order.findFirst({
    where: { id, concept: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) } },
    include: { payments: true },
  })
}

export async function checkSplitRoutes(fastify: FastifyInstance) {
  // POST /check-split/orders/:id/split — replace any existing splits with
  // these. Each entry will become a Payment with status='pending'. POS then
  // settles each one independently.
  fastify.post<{ Params: { id: string } }>(
    '/orders/:id/split',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const body = z.object({
        splits: z.array(z.object({
          label:       z.string().max(40).optional(),
          amountCents: z.number().int().min(1),
          // F-PAY02. No 'comp': a comp is not a split tender — it goes through
          // POST /pos/orders/:id/comp (caps, manager PIN, audit, drawer). No
          // 'split': a portion is paid with a real tender.
          method:      z.enum(['cash', 'card', 'keenu_qr']).default('card'),
        })).min(2).max(20),
      }).parse(req.body)

      const order = await orderInScope(req, req.params.id)
      if (!order) throw new NotFoundError('Order', req.params.id)

      const total = body.splits.reduce((s, x) => s + x.amountCents, 0)
      if (total !== order.totalCents) {
        throw new AppError(
          'SPLIT_TOTAL_MISMATCH',
          `Splits sum to ${total}, order total is ${order.totalCents}`,
          422,
        )
      }
      if (order.payments.some((p) => p.status === 'paid')) {
        throw new AppError('ALREADY_PAID', 'At least one payment on this order is already settled — cannot re-split', 409)
      }

      return prisma.$transaction(async (tx) => {
        // Replace the pending rows (the group placeholder, an earlier split)
        // so we don't double-up.
        await tx.payment.deleteMany({
          where: { orderId: order.id, status: 'pending' },
        })
        // Create new splits
        const created = await Promise.all(
          body.splits.map((s, i) => tx.payment.create({
            data: {
              orderId:     order.id,
              // The drawer is the one that takes the money, set at settle.
              shiftId:     null,
              method:      s.method,
              amountCents: s.amountCents,
              status:      'pending',
              splitGroup:  i + 1,
              splitLabel:  s.label ?? `Split ${i + 1}`,
            },
          })),
        )
        return created
      })
    },
  )

  // POST /check-split/payments/:id/settle — take the money for one portion,
  // through the one settle. The drawer is the operator's open shift.
  fastify.post<{ Params: { id: string } }>(
    '/payments/:id/settle',
    { preHandler: requireAuth(...CASHIERS) },
    async (req) => {
      const body = z.object({
        shiftId: z.string().uuid(),
        gatewayRef: z.string().trim().max(120).optional(),
        tenderedCents: z.number().int().min(0).optional(),
      }).parse(req.body)
      const p = await prisma.payment.findFirst({
        where: {
          id: req.params.id,
          order: { concept: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) } },
        },
        select: { id: true, status: true },
      })
      if (!p) throw new NotFoundError('Payment', req.params.id)
      if (p.status !== 'pending') throw new AppError('ALREADY_SETTLED', 'Payment is not pending', 422)
      const result = await settlePayment({
        paymentId: p.id, via: 'till', shiftId: body.shiftId, gatewayRef: body.gatewayRef, tenderedCents: body.tenderedCents,
      })
      return { ...result.payment, orderCompleted: result.orderCompleted }
    },
  )

  // Even-split helper — divide the bill among N equal portions.
  fastify.post<{ Params: { id: string }; Body: { ways: number; method?: string } }>(
    '/orders/:id/split-evenly',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const body = z.object({
        ways:   z.number().int().min(2).max(20),
        method: z.enum(['cash', 'card', 'keenu_qr']).default('card'),   // F-PAY02
      }).parse(req.body)
      const order = await orderInScope(req, req.params.id)
      if (!order) throw new NotFoundError('Order', req.params.id)
      if (order.payments.some((p) => p.status === 'paid')) {
        throw new AppError('ALREADY_PAID', 'At least one payment on this order is already settled — cannot re-split', 409)
      }

      const base   = Math.floor(order.totalCents / body.ways)
      const remainder = order.totalCents - base * body.ways
      const splits = Array.from({ length: body.ways }, (_, i) => ({
        label: `Diner ${i + 1}`,
        amountCents: base + (i < remainder ? 1 : 0),  // residue to first N
        method: body.method,
      }))

      // Reuse the main split endpoint logic via direct transaction
      return prisma.$transaction(async (tx) => {
        await tx.payment.deleteMany({ where: { orderId: order.id, status: 'pending' } })
        return Promise.all(
          splits.map((s, i) => tx.payment.create({
            data: {
              orderId: order.id,
              shiftId: null,
              method: s.method,
              amountCents: s.amountCents,
              status: 'pending',
              splitGroup: i + 1,
              splitLabel: s.label,
            },
          })),
        )
      })
    },
  )
}
