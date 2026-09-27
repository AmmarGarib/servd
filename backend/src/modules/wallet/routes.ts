import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS } from '../auth/middleware.js'
import { requireCustomerAuth } from '../auth/middleware.js'
import { findCustomerInScope, customerIdsInScope } from '../crm/customerScope.js'
import { conceptIdsInScope } from '../../lib/tenantScope.js'

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

      // Only a customer of the ACTIVE company (ordered or booked at one of its
      // brands); anyone else is a 404, so a foreign id is not confirmed.
      await findCustomerInScope(req, customerId, 'create')

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

      // Customers the active company has never served are skipped, not credited.
      const allowed = await customerIdsInScope(req, [...new Set(customerIds)], 'create')
      let success = 0
      for (const id of customerIds) {
        if (!allowed.has(id)) continue
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
      const found = await findCustomerInScope(req, req.params.id, 'read')
      const customer = { walletBalance: found.walletBalance, name: found.name }
      // Wallet lines tied to an order show only when that order was at one of
      // this company's brands; another company's spend is not ours to show.
      // (Top-ups carry no order and no company column yet — shown as is.)
      const rows = await prisma.walletTransaction.findMany({
        where: { customerId: req.params.id },
        orderBy: { createdAt: 'desc' },
        take: limit * 2,
      })
      const orderIds = [...new Set(rows.map((r) => r.orderId).filter((x): x is string => !!x))]
      const ours = orderIds.length
        ? new Set((await prisma.order.findMany({
            where: { id: { in: orderIds }, conceptId: { in: await conceptIdsInScope(req, 'read') } },
            select: { id: true },
          })).map((o) => o.id))
        : new Set<string>()
      const history = rows.filter((r) => !r.orderId || ours.has(r.orderId)).slice(0, limit)
      return { ...customer, history }
    },
  )
}
