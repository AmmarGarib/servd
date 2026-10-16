import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, FINANCE_TEAM, ADMIN_ONLY } from '../auth/middleware.js'
import { runAllocationRule } from './service.js'
import { audit } from '../../lib/audit.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { scopeTenantWhere } from '../../lib/tenantScope.js'
import { requireActiveCompany, assertConceptAttachable } from '../financePlanning/companyRefs.js'
import { moveToTrash, trashReasonOf } from '../../lib/trash.js'
import { parsePktStartOfDay, parsePktEndOfDay } from '../accounting/dates.js'

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

// Pakistan calendar days (YYYY-MM-DD). The run covers periodStart 00:00 PKT
// through periodEnd 23:59:59.999 PKT — a bare date parsed as UTC midnight
// (05:00 PKT) used to drop the last day's evening from every run and from
// the next one too.
const pktDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a YYYY-MM-DD date')
const runSchema = z.object({
  periodStart: pktDay,
  periodEnd: pktDay,
})

// Running a rule stays the CEO's (ADMIN_ONLY), like defining or deleting
// one: allocation runs were not among the jobs the owner handed to finance
// on 2026-10-16. The admin page shows the Run button to the CEO only.

export async function allocationRoutes(fastify: FastifyInstance) {
  // Rules and runs belong to one company each (CostAllocationRule.tenantId,
  // CostAllocationRun.tenantId). Lists are view-aware and readable by finance
  // too (MANAGERS left the finance officer out); edits/deletes/runs
  // reach every company the operator belongs to; a new rule binds to the
  // ACTIVE company only.

  fastify.get('/rules', { preHandler: requireAuth(...FINANCE_TEAM) }, async (req) => {
    return prisma.costAllocationRule.findMany({
      where: { deletedAt: null, ...(await scopeTenantWhere(req, 'read')) },
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

    // One LIVE rule per source account PER COMPANY — both companies can split
    // their own 6010 rent without touching each other's rule. A rule in the
    // Trash does not count (partial unique cost_allocation_rules_tenant_source_live_key
    // WHERE "deletedAt" IS NULL): saving makes a new rule, and restoring the
    // old one later answers 409 while this one is live.
    const before = await prisma.costAllocationRule.findFirst({
      where: { tenantId, sourceAccountCode: body.sourceAccountCode, deletedAt: null },
      include: { weights: true },
    })
    const rule = before
      ? await prisma.costAllocationRule.update({
          where: { id: before.id },
          data: {
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
      : await prisma.costAllocationRule.create({
          data: {
            tenantId,
            name: body.name,
            sourceAccountCode: body.sourceAccountCode,
            driver: body.driver,
            isActive: body.isActive,
            weights: { create: body.weights },
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
        where: { id: req.params.id, deletedAt: null, ...(await scopeTenantWhere(req, 'write')) },
        select: { id: true, tenantId: true, name: true, sourceAccountCode: true, isActive: true, _count: { select: { runs: true } } },
      })
      if (!rule) throw new NotFoundError('CostAllocationRule', req.params.id)
      // Soft delete into the Trash (modules/trash). A hard delete of a rule
      // with runs used to 500 on the runs' FK; its runs posted to the ledger,
      // so such a rule is never erased. isActive goes off too, so an older
      // image (after a rollback) can never run it.
      await prisma.$transaction(async (tx) => {
        await moveToTrash(tx, req, {
          type: 'cost_allocation_rule', entityId: rule.id, tenantId: rule.tenantId,
          title: rule.name, subtitle: `Splits ${rule.sourceAccountCode}`, reason: trashReasonOf(req),
          meta: { previous: { isActive: rule.isActive }, hasRuns: rule._count.runs > 0 },
        })
        await tx.costAllocationRule.update({ where: { id: rule.id }, data: { deletedAt: new Date(), isActive: false } })
      })
      await audit({ category: 'accounting',
        action: 'allocation.delete', entity: 'CostAllocationRule', entityId: rule.id,
        userId: req.staffUser!.id, tenantId: rule.tenantId, userEmail: req.staffUser!.email,
        before: { name: rule.name, sourceAccountCode: rule.sourceAccountCode }, after: null,
        metadata: { ip: req.ip },
      })
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
        where: { id: req.params.id, deletedAt: null, ...(await scopeTenantWhere(req, 'write')) },
        select: { id: true, tenantId: true },
      })
      if (!rule) throw new NotFoundError('CostAllocationRule', req.params.id)
      if (!rule.tenantId) throw new AppError('RULE_HAS_NO_COMPANY', 'This rule is not bound to a company — recreate it', 422)
      const result = await runAllocationRule({
        tenantId: rule.tenantId,
        ruleId: rule.id,
        periodStart: parsePktStartOfDay(body.periodStart),
        periodEnd: parsePktEndOfDay(body.periodEnd),
        postedById: req.staffUser!.id,
      })
      await audit({ category: 'accounting',
        action: 'allocation.run', entity: 'CostAllocationRun', entityId: result.runId,
        userId: req.staffUser!.id, tenantId: rule.tenantId, userEmail: req.staffUser!.email,
        before: null, after: { ruleId: rule.id, periodStart: body.periodStart, periodEnd: body.periodEnd, totalAmountCents: result.totalAmountCents },
        metadata: { ip: req.ip, actorRole: req.staffUser!.role },
      })
      return reply.status(201).send(result)
    },
  )

  fastify.get('/runs', { preHandler: requireAuth(...FINANCE_TEAM) }, async (req) => {
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
