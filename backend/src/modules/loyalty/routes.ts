import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireCustomerAuth, requireAuth, MANAGERS } from '../auth/middleware.js'
import { NotFoundError, AppError } from '../../lib/errors.js'

// Points config (configurable per concept — stored in settings)
const POINTS_PER_100_PAISA = 1  // 1 point per PKR 1 spent
const POINTS_VALUE_CENTS = 100  // 100 points = PKR 1 (100 paisa)
const STAMP_THRESHOLD = 9        // buy 9, get 1 free

function calculatePointsEarned(totalCents: number): number {
  return Math.floor(totalCents / 100) * POINTS_PER_100_PAISA
}

function calculatePointsValue(points: number): number {
  return Math.floor(points / 100) * POINTS_VALUE_CENTS
}

export async function loyaltyRoutes(fastify: FastifyInstance) {
  // GET /loyalty/account — authenticated customer's balance
  fastify.get('/account', { preHandler: requireCustomerAuth }, async (req) => {
    const account = await prisma.loyaltyAccount.findUnique({
      where: { customerId: req.customer!.id },
      include: {
        transactions: { orderBy: { createdAt: 'desc' }, take: 20 },
        customer: { select: { name: true, email: true } },
      },
    })
    if (!account) throw new NotFoundError('LoyaltyAccount')

    return {
      ...account,
      pointsValueCents: calculatePointsValue(account.pointsBalance),
    }
  })

  // POST /loyalty/redeem — redeem points against an order
  fastify.post('/redeem', { preHandler: requireCustomerAuth }, async (req, reply) => {
    const { orderId, pointsToRedeem } = z
      .object({ orderId: z.string().uuid(), pointsToRedeem: z.number().int().min(1) })
      .parse(req.body)

    // Verify order belongs to this customer
    const order = await prisma.order.findFirst({ where: { id: orderId, customerId: req.customer!.id } })
    if (!order) throw new NotFoundError('Order', orderId)

    const discountCents = calculatePointsValue(pointsToRedeem)

    // Atomic: conditional update prevents race condition where two concurrent requests
    // both pass a balance check and both decrement, driving balance negative
    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.loyaltyAccount.updateMany({
        where: { customerId: req.customer!.id, pointsBalance: { gte: pointsToRedeem } },
        data: { pointsBalance: { decrement: pointsToRedeem } },
      })
      if (updated.count === 0) throw new AppError('INSUFFICIENT_POINTS', 'Not enough points', 400)

      const account = await tx.loyaltyAccount.findUnique({
        where: { customerId: req.customer!.id },
        select: { id: true, pointsBalance: true },
      })

      const ltx = await tx.loyaltyTransaction.create({
        data: {
          loyaltyAccountId: account!.id,
          orderId,
          type: 'redeem',
          pointsDelta: -pointsToRedeem,
          description: `Redeemed ${pointsToRedeem} pts for PKR ${discountCents / 100} discount`,
        },
      })
      await tx.order.update({
        where: { id: orderId },
        data: { discountCents: { increment: discountCents } },
      })
      return { newBalance: account!.pointsBalance, loyaltyTxId: ltx.id }
    })

    // Fire-and-forget liability discharge — posting failures are non-blocking
    const { postLoyaltyRedeem } = await import('../accounting/loyaltyPosting.js')
    postLoyaltyRedeem(result.loyaltyTxId).catch((err) =>
      req.log.error({ err: (err as Error).message, ltxId: result.loyaltyTxId }, 'postLoyaltyRedeem failed'),
    )

    return reply.status(200).send({
      pointsRedeemed: pointsToRedeem,
      discountCents,
      newBalance: result.newBalance,
    })
  })

  // POST /loyalty/earn (internal — called after order completion)
  fastify.post(
    '/earn',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const { customerId, orderId, totalCents, conceptSlug } = z.object({
        customerId: z.string().uuid(),
        orderId: z.string().uuid(),
        totalCents: z.number().int().positive(),
        conceptSlug: z.string().min(1).max(80),
      }).parse(req.body)

      // Verify the order belongs to one of our tenant's concepts.
      const order = await prisma.order.findFirst({
        where: {
          id: orderId,
          customerId,
          concept: { tenantId: req.staffUser!.tenantFilter, deletedAt: null },
        },
      })
      if (!order) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Order not found in your active company' } })

      let account = await prisma.loyaltyAccount.findUnique({ where: { customerId } })
      if (!account) {
        account = await prisma.loyaltyAccount.create({
          data: { customerId, stampCounts: {} },
        })
      }

      const points = calculatePointsEarned(totalCents)

      // Stamp card logic
      const stampCounts: Record<string, number> =
        account.stampCounts && typeof account.stampCounts === 'object' && !Array.isArray(account.stampCounts)
          ? (account.stampCounts as Record<string, number>)
          : {}
      const currentStamps = stampCounts[conceptSlug] ?? 0
      const newStamps = (currentStamps + 1) % (STAMP_THRESHOLD + 1)
      const earnedFreeItem = newStamps === 0 && currentStamps === STAMP_THRESHOLD
      stampCounts[conceptSlug] = newStamps

      const [, earnTx] = await prisma.$transaction([
        prisma.loyaltyAccount.update({
          where: { id: account.id },
          data: {
            pointsBalance: { increment: points },
            lifetimePoints: { increment: points },
            stampCounts,
          },
        }),
        prisma.loyaltyTransaction.create({
          data: {
            loyaltyAccountId: account.id,
            orderId,
            type: 'earn',
            pointsDelta: points,
            description: `Earned ${points} pts from order`,
          },
        }),
      ])

      // Accrue the liability for the points just issued
      const { postLoyaltyEarn } = await import('../accounting/loyaltyPosting.js')
      postLoyaltyEarn(earnTx.id).catch((err) =>
        req.log.error({ err: (err as Error).message, ltxId: earnTx.id }, 'postLoyaltyEarn failed'),
      )

      return reply.status(200).send({ pointsEarned: points, earnedFreeItem, stamps: stampCounts })
    },
  )
}
