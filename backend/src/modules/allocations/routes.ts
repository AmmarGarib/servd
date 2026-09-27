import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS, ADMIN_ONLY } from '../auth/middleware.js'
import { runAllocationRule } from './service.js'
import { audit } from '../../lib/audit.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { scopeTenantWhere } from '../../lib/tenantScope.js'
import { requireActiveCompany, assertConceptAttachable } from '../financePlanning/companyRefs.js'

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
  // Rules and runs belong to one company each (CostAllocationRule.tenantId,
  // CostAllocationRun.tenantId). Lists are view-aware; edits/deletes/runs
  // reach every company the operator belongs to; a new rule binds to the
  // ACTIVE company only.

  fastify.get('/rules', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    return prisma.costAllocationRule.findMany({
      where: await scopeTenantWhere(req, 'read'),
      include: { weights: { include: { concept: { select: { name: true, slug: true } } } } },
      orderBy: { sourceAccountCode: 'asc' },
    })
  })

  fastify.post('/rules', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req, reply) => {
    const body = ruleSchema.parse(req.body)
    const tenantId = requireActiveCompany(req)

    if (body.driver === 'fixed_pct') {
      const total = body.weights.reduce((s, w) => s + w.weightBps, 0)
      if (total !== 10_000) {
        return reply.status(422).send({ error: { code: 'BAD_WEIGHTS', message: `fixed_pct weights must sum to 10000 bps (got ${total})` } })
      }
    }
    const seen = new Set<string>()
    for (const w of body.weights) {
      if (seen.has(w.conceptId)) throw new AppError('DUPLICATE_WEIGHT', 'Each brand may appear once per rule', 422)
      seen.add(w.conceptId)
      // A rule may only spread a company's cost over that company's brands.
      await assertConceptAttachable(req, w.conceptId)
    }

    // One rule per source account PER COMPANY — both companies can split
    // their own 6010 rent without touching each other's rule.
    const key = { tenantId_sourceAccountCode: { tenantId, sourceAccountCode: body.sourceAccountCode } }
    const before = await prisma.costAllocationRule.findUnique({
      where: key,
      include: { weights: true },
    })
    const rule = await prisma.costAllocationRule.upsert({
      where: key,
      create: {
        tenantId,
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
      userId: req.staffUser!.id, tenantId,
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
      const rule = await prisma.costAllocationRule.findFirst({
        where: { id: req.params.id, ...(await scopeTenantWhere(req, 'write')) },
        select: { id: true },
      })
      if (!rule) throw new NotFoundError('CostAllocationRule', req.params.id)
      await prisma.costAllocationRule.delete({ where: { id: rule.id } })
      return reply.status(204).send()
    },
  )

  fastify.post<{ Params: { id: string } }>(
    '/rules/:id/run',
    { preHandler: requireAuth(...ADMIN_ONLY) },
    async (req, reply) => {
      const body = runSchema.parse(req.body)
      // Resolve the rule inside the operator's companies first; the run then
      // posts to THE RULE'S company's ledger, never the caller's active one.
      const rule = await prisma.costAllocationRule.findFirst({
        where: { id: req.params.id, ...(await scopeTenantWhere(req, 'write')) },
        select: { id: true, tenantId: true },
      })
      if (!rule) throw new NotFoundError('CostAllocationRule', req.params.id)
      if (!rule.tenantId) throw new AppError('RULE_HAS_NO_COMPANY', 'This rule is not bound to a company — recreate it', 422)
      const result = await runAllocationRule({
        tenantId: rule.tenantId,
        ruleId: rule.id,
        periodStart: new Date(body.periodStart),
        periodEnd: new Date(body.periodEnd),
        postedById: req.staffUser!.id,
      })
      return reply.status(201).send(result)
    },
  )

  fastify.get('/runs', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const scope = await scopeTenantWhere(req, 'read')
    return prisma.costAllocationRun.findMany({
      // Runs are stamped with their company; a run from before the column
      // falls back to its rule's company — only when its own column is NULL.
      where: { OR: [scope, { AND: [{ tenantId: null }, { rule: scope }] }] },
      include: { rule: { select: { name: true, sourceAccountCode: true } } },
      orderBy: { postedAt: 'desc' },
      take: 100,
    })
  })
}
