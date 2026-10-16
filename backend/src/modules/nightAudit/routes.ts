// /accounting/night-audit — the night audit of SALES days (owner, 2026-10-16;
// sales module only). Under the '/accounting' module gate (module
// 'accounting'). The company is the ACTIVE company (422 NO_ACTIVE_COMPANY
// without one). Contract: ./README.md §7.
//
//   GET  /?month=YYYY-MM          FINANCIALS_VIEWERS  the month's calendar
//   GET  /:day                    FINANCIALS_VIEWERS  DayDetail (live checks)
//   GET  /:day/report?live=1      FINANCIALS_VIEWERS  the stored (or live) report
//   POST /:day/run                admin, finance      open → audited (+ auto settle)
//   POST /:day/settle             admin, finance      audited → closed
//   POST /:day/reopen             admin (the CEO)     → open
//   PUT  /settings                admin (the CEO)     the start day
// `acknowledge { keys, reason ≥ 10 }` on run / settle is the CEO's only
// (403 OVERRIDE_CEO_ONLY).

import type { FastifyInstance } from 'fastify'
import type { UserRole } from '@prisma/client'
import { z } from 'zod'
import { requireAuth, FINANCIALS_VIEWERS } from '../auth/middleware.js'
import { activeTenantId } from '../../lib/tenantScope.js'
import { dayDetail, dayReport, listMonth, reopenDay, runNightAudit, setStartDay, settleDay, assertDay } from './service.js'
import { NIGHT_AUDIT_RUNNERS } from './types.js'

const RUNNERS = [...NIGHT_AUDIT_RUNNERS] as UserRole[]
const CEO = ['admin'] as UserRole[]
const WHY = 'the night audit is per company'

const ackSchema = z.object({
  keys: z.array(z.string().min(1).max(120)).min(1).max(50),
  reason: z.string().max(1000),
}).optional()
const actionBody = z.object({ acknowledge: ackSchema }).optional()
const dayParam = z.object({ day: z.string() })

export async function nightAuditRoutes(fastify: FastifyInstance): Promise<void> {
  const actorOf = (req: { staffUser?: { id: string; role: string; email?: string | null } | null }) =>
    ({ id: req.staffUser!.id, role: req.staffUser!.role, email: req.staffUser!.email ?? null })

  fastify.get('/', { preHandler: requireAuth(...FINANCIALS_VIEWERS) }, async (req) => {
    const q = z.object({ month: z.string().optional() }).parse(req.query ?? {})
    const tenantId = activeTenantId(req, WHY)
    return listMonth({ tenantId, month: q.month, role: req.staffUser!.role })
  })

  fastify.put('/settings', { preHandler: requireAuth(...CEO) }, async (req) => {
    const body = z.object({ startDay: z.string().nullable(), reason: z.string().max(1000) }).parse(req.body ?? {})
    const tenantId = activeTenantId(req, WHY)
    return setStartDay({ tenantId, startDay: body.startDay, reason: body.reason, actor: actorOf(req) })
  })

  fastify.get('/:day', { preHandler: requireAuth(...FINANCIALS_VIEWERS) }, async (req) => {
    const { day } = dayParam.parse(req.params)
    const tenantId = activeTenantId(req, WHY)
    return dayDetail({ tenantId, day: assertDay(day), role: req.staffUser!.role })
  })

  fastify.get('/:day/report', { preHandler: requireAuth(...FINANCIALS_VIEWERS) }, async (req) => {
    const { day } = dayParam.parse(req.params)
    const q = z.object({ live: z.string().optional() }).parse(req.query ?? {})
    const tenantId = activeTenantId(req, WHY)
    return dayReport({ tenantId, day: assertDay(day), live: q.live === '1' || q.live === 'true', actorId: req.staffUser!.id })
  })

  fastify.post('/:day/run', { preHandler: requireAuth(...RUNNERS) }, async (req) => {
    const { day } = dayParam.parse(req.params)
    const body = actionBody.parse(req.body ?? {})
    const tenantId = activeTenantId(req, WHY)
    await runNightAudit({ tenantId, day: assertDay(day), actor: actorOf(req), acknowledge: body?.acknowledge })
    return dayDetail({ tenantId, day, role: req.staffUser!.role })
  })

  fastify.post('/:day/settle', { preHandler: requireAuth(...RUNNERS) }, async (req) => {
    const { day } = dayParam.parse(req.params)
    const body = actionBody.parse(req.body ?? {})
    const tenantId = activeTenantId(req, WHY)
    await settleDay({ tenantId, day: assertDay(day), actor: actorOf(req), acknowledge: body?.acknowledge })
    return dayDetail({ tenantId, day, role: req.staffUser!.role })
  })

  fastify.post('/:day/reopen', { preHandler: requireAuth(...CEO) }, async (req) => {
    const { day } = dayParam.parse(req.params)
    const body = z.object({ reason: z.string().max(1000).default('') }).parse(req.body ?? {})
    const tenantId = activeTenantId(req, WHY)
    await reopenDay({ tenantId, day: assertDay(day), actor: actorOf(req), reason: body.reason })
    return dayDetail({ tenantId, day, role: req.staffUser!.role })
  })
}
