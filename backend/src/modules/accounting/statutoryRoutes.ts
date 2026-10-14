// /accounting/statutory — statutory payroll payables, accrued vs paid (finance
// wave B, H7). Under the '/accounting' module gate. Payments themselves are
// recorded, linked and voided through the tax payments register
// (POST /accounting/sales-tax-return/payments … with authority salary_tax |
// eobi | sessi) — never a second payment engine.
//
//   GET  /         FINANCIALS_VIEWERS, the ACTIVE company: ?from=YYYY-MM&to=YYYY-MM
//                  (default: the last six months) → statutorySummary + canPay.
//   GET  /reclass  FINANCIALS_VIEWERS, the ACTIVE company → reclassPreview + canPost.
//   POST /reclass  admin, finance (TAX_PAYER_ROLES), the ACTIVE company:
//                  { eobiCents, sessiCents, salaryTaxCents, note } → the
//                  one-time 'statutory.reclass:<tenantId>' entry (201).
//                  409 RECLASS_DONE; 422 RECLASS_OVER_BALANCE,
//                  NOTHING_TO_RECLASS, PERIOD_LOCKED, ACCOUNT_*; audited.

import type { FastifyInstance } from 'fastify'
import type { UserRole } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { audit } from '../../lib/audit.js'
import { zMoneyCents } from '../../lib/money.js'
import { requireAuth, FINANCIALS_VIEWERS } from '../auth/middleware.js'
import { activeTenantId } from '../../lib/tenantScope.js'
import { fmtPktDate, pktToday } from './dates.js'
import { TAX_PAYER_ROLES } from './taxPayments.js'
import { statutorySummary, reclassPreview, postReclass } from './statutory.js'

const TAX_PAYERS = [...TAX_PAYER_ROLES] as UserRole[]
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/

/** 'YYYY-MM' `n` months before `month`. */
function monthsBefore(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number]
  const idx = y * 12 + (m - 1) - n
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`
}

const rangeQuery = z.object({
  from: z.string().regex(MONTH, 'Give the month as YYYY-MM').optional(),
  to: z.string().regex(MONTH, 'Give the month as YYYY-MM').optional(),
})

const reclassBody = z.object({
  eobiCents: zMoneyCents('The EOBI amount'),
  sessiCents: zMoneyCents('The SESSI amount'),
  salaryTaxCents: zMoneyCents('The salary tax amount'),
  note: z.string().trim().min(5, 'Say why, in a few words').max(500),
})

export async function statutoryRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/', { preHandler: requireAuth(...FINANCIALS_VIEWERS) }, async (req) => {
    const q = rangeQuery.parse(req.query ?? {})
    const tenantId = activeTenantId(req, 'statutory payables are per company')
    const thisMonth = fmtPktDate(pktToday().from).slice(0, 7)
    const to = q.to ?? thisMonth
    const from = q.from ?? monthsBefore(to, 5)
    const summary = await statutorySummary(prisma, tenantId, from, to)
    return { ...summary, canPay: TAX_PAYERS.includes(req.staffUser!.role) }
  })

  fastify.get('/reclass', { preHandler: requireAuth(...FINANCIALS_VIEWERS) }, async (req) => {
    const tenantId = activeTenantId(req, 'statutory payables are per company')
    const preview = await reclassPreview(prisma, tenantId)
    return { ...preview, canPost: TAX_PAYERS.includes(req.staffUser!.role) && !preview.done }
  })

  fastify.post('/reclass', { preHandler: requireAuth(...TAX_PAYERS) }, async (req, reply) => {
    const body = reclassBody.parse(req.body ?? {})
    // The ACTIVE company's own books — never another membership.
    const tenantId = activeTenantId(req, 'the statutory reclass is in one company\'s books')
    const result = await postReclass(tenantId, {
      eobiCents: body.eobiCents, sessiCents: body.sessiCents, salaryTaxCents: body.salaryTaxCents,
    }, req.staffUser!.id, body.note)
    await audit({ category: 'accounting',
      action: 'statutory.reclass',
      entity: 'JournalEntry',
      entityId: result.entryId,
      userId: req.staffUser!.id, tenantId,
      userEmail: req.staffUser!.email,
      after: result,
      metadata: { ip: req.ip, note: body.note },
    })
    return reply.status(201).send(result)
  })
}

export default statutoryRoutes
