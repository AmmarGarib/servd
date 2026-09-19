import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS, ADMIN_ONLY } from '../auth/middleware.js'
import { runAllocationRule } from './service.js'
import { audit } from '../../lib/audit.js'
import { AppError } from '../../lib/errors.js'

const ruleSchema = z.object({
  name: z.string().min(1),
  sourceAccountCode: z.string().min(1),
  driver: z.enum(['fixed_pct', 'revenue_share']),
  isActive: z.boolean().default(true),
  weights: z.array(z.object({
    conceptId: z.string().uuid(),
    weightBps: z.number().int().min(0).max(10_000),
    targetAccountCode: z.string().optional(),
  })).min(1),
})

const runSchema = z.object({
  periodStart: z.string(),
  periodEnd: z.string(),
})

export async function allocationRoutes(fastify: FastifyInstance) {
  fastify.get('/rules', { preHandler: requireAuth(...MANAGERS) }, async () => {
    return prisma.costAllocationRule.findMany({
      include: { weights: { include: { concept: { select: { name: true, slug: true } } } } },
      orderBy: { sourceAccountCode: 'asc' },
    })
  })

  fastify.post('/rules', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req, reply) => {
    const body = ruleSchema.parse(req.body)

    if (body.driver === 'fixed_pct') {
      const total = body.weights.reduce((s, w) => s + w.weightBps, 0)
      if (total !== 10_000) {
        return reply.status(422).send({ error: { code: 'BAD_WEIGHTS', message: `fixed_pct weights must sum to 10000 bps (got ${total})` } })
      }
    }

    const before = await prisma.costAllocationRule.findUnique({
      where: { sourceAccountCode: body.sourceAccountCode },
      include: { weights: true },
    })
    const rule = await prisma.costAllocationRule.upsert({
      where: { sourceAccountCode: body.sourceAccountCode },
      create: {
        name: body.name,
        sourceAccountCode: body.sourceAccountCode,
        driver: body.driver,
        isActive: body.isActive,
        weights: { create: body.weights },
      },
      update: {
        name: body.name,
        driver: body.driver,
        isActive: body.isActive,
        weights: {
          deleteMany: {},
          create: body.weights,
        },
      },
      include: { weights: true },
    })
    await audit({ category: 'accounting',
      action: before ? 'allocation.update' : 'allocation.create',
      entity: 'CostAllocationRule',
      entityId: rule.id,
      userId: req.staffUser!.id, tenantId: req.staffUser?.tenantId ?? null,
      userEmail: req.staffUser!.email,
      before, after: rule,
      metadata: { ip: req.ip },
    })
    return reply.status(201).send(rule)
  })

  fastify.delete<{ Params: { id: string } }>(
    '/rules/:id',
    { preHandler: requireAuth(...ADMIN_ONLY) },
    async (req, reply) => {
      await prisma.costAllocationRule.delete({ where: { id: req.params.id } })
      return reply.status(204).send()
    },
  )

  fastify.post<{ Params: { id: string } }>(
    '/rules/:id/run',
    { preHandler: requireAuth(...ADMIN_ONLY) },
    async (req, reply) => {
      const body = runSchema.parse(req.body)
      const tenantId = req.staffUser!.tenantId
      if (!tenantId) throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company first — the ledger is per company', 422)
      const result = await runAllocationRule({
        tenantId,
        ruleId: req.params.id,
        periodStart: new Date(body.periodStart),
        periodEnd: new Date(body.periodEnd),
        postedById: req.staffUser!.id,
      })
      return reply.status(201).send(result)
    },
  )

  fastify.get('/runs', { preHandler: requireAuth(...MANAGERS) }, async () => {
    return prisma.costAllocationRun.findMany({
      include: { rule: { select: { name: true, sourceAccountCode: true } } },
      orderBy: { postedAt: 'desc' },
      take: 100,
    })
  })
}
