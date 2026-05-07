import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS } from '../auth/middleware.js'
import { requireCustomerAuth } from '../auth/middleware.js'
import { AppError, NotFoundError } from '../../lib/errors.js'

async function creditWallet(customerId: string, amountCents: number, description: string, orderId?: string) {
  return prisma.$transaction(async (tx) => {
    const customer = await tx.customer.update({
      where: { id: customerId },
      data: { walletBalance: { increment: amountCents } },
      select: { walletBalance: true },
    })
    await tx.walletTransaction.create({
      data: {
        customerId,
        type: 'topup',
        amountCents,
        balanceAfter: customer.walletBalance,
        description,
        orderId: orderId ?? null,
      },
    })
    return customer.walletBalance
  })
}

export async function walletRoutes(fastify: FastifyInstance) {
  // GET /wallet — customer: own wallet balance + history
  fastify.get('/me', { preHandler: requireCustomerAuth }, async (req) => {
    const customer = await prisma.customer.findUnique({
      where: { id: req.customer!.id },
      select: { walletBalance: true },
    })
    const history = await prisma.walletTransaction.findMany({
      where: { customerId: req.customer!.id },
      orderBy: { createdAt: 'desc' },
      take: 30,
    })
    return { balance: customer?.walletBalance ?? 0, history }
  })

  // POST /wallet/topup — staff: top up a customer wallet
  fastify.post<{ Body: { customerId: string; amountCents: number; description?: string } }>(
    '/topup',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const { customerId, amountCents, description } = z.object({
        customerId: z.string().uuid(),
        amountCents: z.number().int().positive(),
        description: z.string().optional(),
      }).parse(req.body)

      const customer = await prisma.customer.findUnique({ where: { id: customerId } })
      if (!customer) throw new NotFoundError('Customer', customerId)

      const newBalance = await creditWallet(customerId, amountCents, description ?? 'Admin top-up')
      return reply.status(201).send({ newBalance })
    },
  )

  // POST /wallet/bulk-topup — top up multiple customers
  fastify.post<{ Body: { customerIds: string[]; amountCents: number; description?: string } }>(
    '/bulk-topup',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const { customerIds, amountCents, description } = z.object({
        customerIds: z.array(z.string().uuid()).min(1).max(500),
        amountCents: z.number().int().positive(),
        description: z.string().optional(),
      }).parse(req.body)

      let success = 0
      for (const id of customerIds) {
        try {
          await creditWallet(id, amountCents, description ?? 'Bulk top-up')
          success++
        } catch {
          // skip invalid IDs
        }
      }
      return { success, total: customerIds.length }
    },
  )

  // GET /wallet/customers/:id — staff: view customer wallet
  fastify.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    '/customers/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const limit = Math.min(parseInt(req.query.limit ?? '50', 10), 200)
      const customer = await prisma.customer.findUnique({
        where: { id: req.params.id },
        select: { walletBalance: true, name: true },
      })
      if (!customer) throw new NotFoundError('Customer', req.params.id)
      const history = await prisma.walletTransaction.findMany({
        where: { customerId: req.params.id },
        orderBy: { createdAt: 'desc' },
        take: limit,
      })
      return { ...customer, history }
    },
  )
}
