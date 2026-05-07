// Check splitting at POS.
//
// Strategy: an Order is one bill, but its Payment rows can be split across
// multiple diners. Each diner gets a Payment with the same orderId but a
// distinct splitGroup integer. Sum of all splits' amountCents must equal
// order total before the order is marked complete.

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, ALL_STAFF } from '../auth/middleware.js'
import { AppError, NotFoundError } from '../../lib/errors.js'

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
          method:      z.enum(['cash', 'card', 'jazzcash_wallet', 'easypaisa_wallet', 'keenu_qr', 'split', 'comp']).default('card'),
        })).min(2).max(20),
      }).parse(req.body)

      const order = await prisma.order.findFirst({
        where: {
          id: req.params.id,
          concept: { tenantId: req.staffUser!.tenantId, deletedAt: null },
        },
        include: { payments: true },
      })
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
        // Wipe pending payments so we don't double-up
        await tx.payment.deleteMany({
          where: { orderId: order.id, status: 'pending' },
        })
        // Create new splits
        const created = await Promise.all(
          body.splits.map((s, i) => tx.payment.create({
            data: {
              orderId:     order.id,
              shiftId:     order.shiftId ?? null,
              method:      s.method as never,
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

  // POST /check-split/payments/:id/settle — mark this split paid + record txn
  fastify.post<{ Params: { id: string } }>(
    '/payments/:id/settle',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const body = z.object({
        gatewayRef: z.string().optional(),
        tenderedCents: z.number().int().optional(),
      }).parse(req.body)
      const p = await prisma.payment.findFirst({
        where: {
          id: req.params.id,
          order: { concept: { tenantId: req.staffUser!.tenantId, deletedAt: null } },
        },
      })
      if (!p) throw new NotFoundError('Payment', req.params.id)
      if (p.status !== 'pending') throw new AppError('ALREADY_SETTLED', 'Payment is not pending', 422)

      return prisma.payment.update({
        where: { id: p.id },
        data: {
          status: 'paid',
          gatewayRef: body.gatewayRef ?? null,
          tenderedCents: body.tenderedCents ?? null,
          changeCents: body.tenderedCents != null ? Math.max(0, body.tenderedCents - p.amountCents) : null,
          processedAt: new Date(),
        },
      })
    },
  )

  // Even-split helper — divide the bill among N equal portions.
  fastify.post<{ Params: { id: string }; Body: { ways: number; method?: string } }>(
    '/orders/:id/split-evenly',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const body = z.object({
        ways:   z.number().int().min(2).max(20),
        method: z.enum(['cash', 'card', 'jazzcash_wallet', 'easypaisa_wallet', 'keenu_qr']).default('card'),
      }).parse(req.body)
      const order = await prisma.order.findFirst({
        where: {
          id: req.params.id,
          concept: { tenantId: req.staffUser!.tenantId, deletedAt: null },
        },
      })
      if (!order) throw new NotFoundError('Order', req.params.id)

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
              shiftId: order.shiftId ?? null,
              method: s.method as never,
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
