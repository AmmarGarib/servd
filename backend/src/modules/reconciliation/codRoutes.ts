// /reconciliation/cod — cash-on-delivery money with the rider (H5).
//
// Finance's view of delivered COD cash not yet handed in, by the ONE status
// rule (lib/cod.ts), and the "Book as owed by the rider" action
// (accounting/codPosting.ts: own rider Dr 1351 / Cr 1010; a fleet rider of
// another company through the inter-company 'cod' transfer).
//
// OFF by default: a company's rows appear (and can be booked) only while its
// code-only delivery switch is on (lib/deliveryRules.ts). GET /enabled tells
// the admin whether to show the tab at all.
//
// Mounted at /reconciliation/cod by reconciliation/routes.ts; the auth
// middleware's module gate on /reconciliation (module `reconciliation`)
// applies to every route here.

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, FINANCE_TEAM } from '../auth/middleware.js'
import { scopeTenantWhere, type TenantIdWhere } from '../../lib/tenantScope.js'
import { NotFoundError } from '../../lib/errors.js'
import { orderRefOf } from '../../lib/orderRef.js'
import { COD_PAY_IN_HOURS, COD_STATUSES, codDueWhere, codHoursSince, codStatusOf, type CodStatus } from '../../lib/cod.js'
import { DELIVERY_CODE_ONLY_SETTING } from '../../lib/deliveryRules.js'
import { bookCodRiderDebt } from '../accounting/codPosting.js'

/** Who books a rider's debt: the CEO, co-owners, management and finance. */
const COD_BOOKERS = ['admin', 'owner', 'management', 'finance'] as const

const listQuery = z.object({
  status: z.enum(COD_STATUSES as unknown as [CodStatus, ...CodStatus[]]).optional(),
})

const bookBody = z.object({
  reason: z.string().trim().min(5).max(500),
  legacy: z.boolean().optional(),
})

const LIST_LIMIT = 500

/** The companies in `where` whose code-only delivery switch is on. */
async function switchedOnTenants(where: TenantIdWhere): Promise<string[]> {
  const ids = typeof where.tenantId === 'string' ? [where.tenantId] : where.tenantId.in
  if (ids.length === 0) return []
  const rows = await prisma.setting.findMany({
    where: { key: { in: ids.map((t) => `${DELIVERY_CODE_ONLY_SETTING}:${t}`) } },
    select: { key: true },
  })
  const on = new Set(rows.map((r) => r.key.slice(DELIVERY_CODE_ONLY_SETTING.length + 1)))
  return ids.filter((t) => on.has(t))
}

export default async function codRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /reconciliation/cod/enabled — is COD custody on for any company in view?
  fastify.get('/enabled', { preHandler: requireAuth(...FINANCE_TEAM) }, async (req) => {
    const on = await switchedOnTenants(await scopeTenantWhere(req, 'read'))
    return { enabled: on.length > 0 }
  })

  // GET /reconciliation/cod?status=with_rider|overdue|rider_owes|at_counter
  fastify.get('/', { preHandler: requireAuth(...FINANCE_TEAM) }, async (req) => {
    const { status } = listQuery.parse(req.query)
    const tenants = await switchedOnTenants(await scopeTenantWhere(req, 'read'))
    if (tenants.length === 0) return { payInHours: COD_PAY_IN_HOURS, rows: [] }

    const base = codDueWhere({ tenantId: { in: tenants } })
    const orderBase = base.order as Prisma.OrderWhereInput
    const riderOrder: Prisma.OrderWhereInput = { fulfilmentType: 'delivery', riderId: { not: null } }
    let where: Prisma.PaymentWhereInput
    if (status === 'at_counter') {
      where = { ...base, order: { ...orderBase, OR: [{ fulfilmentType: { not: 'delivery' } }, { riderId: null }] } }
    } else if (status === 'rider_owes') {
      where = { ...base, codRiderDebtAt: { not: null }, order: { ...orderBase, ...riderOrder } }
    } else if (status === 'with_rider' || status === 'overdue') {
      where = { ...base, codRiderDebtAt: null, order: { ...orderBase, ...riderOrder } }
    } else {
      where = base
    }

    const rows = await prisma.payment.findMany({
      where,
      select: {
        id: true, amountCents: true, createdAt: true, codRiderDebtAt: true, codRiderDebtById: true,
        order: {
          select: {
            id: true, customerName: true, fulfilmentType: true, riderId: true, deliveredAt: true, completedAt: true,
            concept: { select: { name: true } },
            rider: { select: { id: true, name: true, tenant: { select: { name: true } } } },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
      take: LIST_LIMIT,
    })

    const byIds = Array.from(new Set(rows.map((r) => r.codRiderDebtById).filter((x): x is string => !!x)))
    const users = byIds.length > 0
      ? await prisma.user.findMany({ where: { id: { in: byIds } }, select: { id: true, name: true } })
      : []
    const nameOf = new Map(users.map((u) => [u.id, u.name]))

    const now = new Date()
    const out = rows
      .map((p) => {
        const s = codStatusOf(p, p.order, now)
        return {
          paymentId: p.id,
          orderId: p.order.id,
          ref: orderRefOf(p.order.id),
          brand: p.order.concept.name,
          customerName: p.order.customerName ?? null,
          amountCents: p.amountCents,
          deliveredAt: p.order.deliveredAt ?? p.order.completedAt ?? null,
          hoursSinceDelivered: codHoursSince(p, p.order, now),
          rider: p.order.rider
            ? { id: p.order.rider.id, name: p.order.rider.name, companyName: p.order.rider.tenant?.name ?? null }
            : null,
          status: s,
          riderOwes: p.codRiderDebtAt
            ? { at: p.codRiderDebtAt, byName: (p.codRiderDebtById && nameOf.get(p.codRiderDebtById)) || null }
            : null,
        }
      })
      .filter((r) => !status || r.status === status)
    return { payInHours: COD_PAY_IN_HOURS, rows: out }
  })

  // POST /reconciliation/cod/:paymentId/rider-debt { reason, legacy? }
  fastify.post<{ Params: { paymentId: string } }>(
    '/:paymentId/rider-debt',
    { preHandler: requireAuth(...COD_BOOKERS) },
    async (req) => {
      const body = bookBody.parse(req.body)
      const su = req.staffUser!
      // Write scope through the order's brand: another company's payment is 404.
      const owned = await prisma.payment.findFirst({
        where: { id: req.params.paymentId, order: { concept: await scopeTenantWhere(req, 'write') } },
        select: { id: true },
      })
      if (!owned) throw new NotFoundError('Payment not found')
      return bookCodRiderDebt({
        paymentId: owned.id,
        actor: { id: su.id, role: su.role, memberTenantIds: su.memberTenantIds },
        reason: body.reason,
        ...(body.legacy !== undefined ? { legacy: body.legacy } : {}),
      })
    },
  )
}
