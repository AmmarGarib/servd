import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS, APPROVERS } from '../auth/middleware.js'
import { resolveDateRange } from '../accounting/dates.js'
import { audit } from '../../lib/audit.js'
import { AppError } from '../../lib/errors.js'
import { resolveTenantScope } from '../../lib/tenantScope.js'
import {
  computeHoursForPeriod,
  computePayrollRun,
  adjustPayrollLine,
  postPayrollRun,
  payPayrollRun,
  labourPctReport,
} from './service.js'

const computeSchema = z.object({
  periodStart: z.string(),
  periodEnd: z.string(),
  notes: z.string().optional(),
})

const adjustSchema = z.object({
  adjustmentCents: z.number().int(),
  notes: z.string().optional(),
})

const paySchema = z.object({
  paidFromAccountCode: z.string().optional(),
})

const wageRateSchema = z.object({
  hourlyRateCents: z.number().int().min(0).nullable(),
  wageAccountCode: z.string().optional(),
})

export async function payrollRoutes(fastify: FastifyInstance) {
  // ─── Wage rate management ────────────────────────────────────────────────

  fastify.put<{ Params: { userId: string } }>(
    '/users/:userId/wage',
    { preHandler: requireAuth(...APPROVERS) },
    async (req, reply) => {
      const body = wageRateSchema.parse(req.body)
      // Verify the target user belongs to the active tenant.
      const target = await prisma.user.findFirst({
        where: { id: req.params.userId, tenantId: req.staffUser!.tenantId },
      })
      if (!target) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'User not found in your active company' } })
      const before = await prisma.user.findUnique({
        where: { id: req.params.userId },
        select: { id: true, name: true, hourlyRateCents: true, wageAccountCode: true },
      })
      const after = await prisma.user.update({
        where: { id: req.params.userId },
        data: {
          hourlyRateCents: body.hourlyRateCents,
          ...(body.wageAccountCode !== undefined && { wageAccountCode: body.wageAccountCode }),
        },
        select: { id: true, name: true, role: true, hourlyRateCents: true, wageAccountCode: true },
      })
      await audit({ category: 'accounting',
        action: 'wage.update',
        entity: 'User',
        entityId: req.params.userId,
        userId: req.staffUser!.id, tenantId: req.staffUser?.tenantId ?? null,
        userEmail: req.staffUser!.email,
        before, after,
        metadata: { ip: req.ip },
      })

      // Wage edits — flag any change. Self-edit is a particularly damning
      // signal so we elevate severity when the actor is also the target.
      const isSelfEdit = req.params.userId === req.staffUser!.id
      const beforeRate = before?.hourlyRateCents ?? 0
      const afterRate = after.hourlyRateCents ?? 0
      const deltaPct = beforeRate > 0 ? ((afterRate - beforeRate) / beforeRate) * 100 : 100
      const { flagException } = await import('../../lib/exceptions.js')
      await flagException({
        kind: 'wage_change',
        severity: isSelfEdit ? 'critical' : Math.abs(deltaPct) > 20 ? 'high' : 'medium',
        title: isSelfEdit
          ? `SELF-EDIT: ${after.name} changed their own wage`
          : `Wage changed for ${after.name}: ${(beforeRate / 100).toFixed(0)} → ${(afterRate / 100).toFixed(0)} PKR/h`,
        description: `${req.staffUser!.email} ${isSelfEdit ? 'edited their OWN wage' : `edited ${after.name}'s wage`}. ${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(0)}%${isSelfEdit ? ' — investigate immediately.' : ''}`,
        entityType: 'User',
        entityId: req.params.userId,
        actorId: req.staffUser!.id,
        metadata: { isSelfEdit, beforeRate, afterRate, deltaPct, ip: req.ip },
      })
      return after
    },
  )

  // ─── Hours preview (no DB write) ─────────────────────────────────────────

  fastify.get<{ Querystring: { periodStart: string; periodEnd: string } }>(
    '/hours-preview',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      return computeHoursForPeriod(new Date(req.query.periodStart), new Date(req.query.periodEnd))
    },
  )

  // ─── Payroll runs ────────────────────────────────────────────────────────

  fastify.get('/runs', { preHandler: requireAuth(...MANAGERS) }, async () => {
    return prisma.payrollRun.findMany({
      orderBy: { periodStart: 'desc' },
      include: { _count: { select: { lines: true } } },
      take: 100,
    })
  })

  fastify.get<{ Params: { id: string } }>(
    '/runs/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      return prisma.payrollRun.findUnique({
        where: { id: req.params.id },
        include: { lines: { orderBy: { userName: 'asc' } } },
      })
    },
  )

  fastify.post('/runs', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = computeSchema.parse(req.body)
    const run = await computePayrollRun({
      periodStart: new Date(body.periodStart),
      periodEnd: new Date(body.periodEnd),
      createdById: req.staffUser!.id,
      notes: body.notes,
    })
    return reply.status(201).send(run)
  })

  fastify.patch<{ Params: { lineId: string } }>(
    '/lines/:lineId',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const body = adjustSchema.parse(req.body)
      return adjustPayrollLine(req.params.lineId, body.adjustmentCents, body.notes)
    },
  )

  fastify.post<{ Params: { id: string } }>(
    '/runs/:id/post',
    { preHandler: requireAuth(...APPROVERS) },
    async (req) => {
      const tenantId = req.staffUser!.tenantId
      if (!tenantId) throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company first — payroll posts to that company\'s books', 422)
      return postPayrollRun(req.params.id, req.staffUser!.id, tenantId)
    },
  )

  fastify.post<{ Params: { id: string } }>(
    '/runs/:id/pay',
    { preHandler: requireAuth(...APPROVERS) },
    async (req) => {
      const body = paySchema.parse(req.body ?? {})
      const tenantId = req.staffUser!.tenantId
      if (!tenantId) throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company first — payroll posts to that company\'s books', 422)
      return payPayrollRun(req.params.id, req.staffUser!.id, tenantId, body.paidFromAccountCode)
    },
  )

  // ─── Labour as % of revenue ──────────────────────────────────────────────

  fastify.get<{ Querystring: { dateFrom?: string; dateTo?: string } }>(
    '/labour-pct',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const { from, to } = resolveDateRange(req.query.dateFrom, req.query.dateTo)
      return labourPctReport((await resolveTenantScope(req)).tenantIds, from, to)
    },
  )
}
