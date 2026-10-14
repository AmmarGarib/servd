// "Box given" — the packaging rule's button (owner's FINAL rule, 2026-10-13).
//
// A dine-in line at a PLATE brand uses its dish's Packaging section only when
// staff tap "Box given" (the leftovers were boxed). Takeaway / delivery lines
// and a packaging-vessel brand's lines (e.g. Stackd) already count their
// packaging, so they never need it (409 BOX_NOT_NEEDED). The rule itself is
// lib/recipeCost.ts packagingApplies; the stock and the books move in
// markBoxGiven (lib/recipeCost.ts → modules/orders/stock.ts): FIFO out of the
// packaging lots, and, when the order's cost of sales is already booked, its
// own Dr 5030 / Cr 1230 ('order_item.box_given:<line>@<tap ms>'; an undo
// 'order_item.box_given_undo'). This file is only the door.
//
//   POST /pos/orders/:orderId/items/:itemId/box-given { undo?: boolean }
//     → { boxGiven, depleted }
//
// Who: any staff who work the till, the floor or the kitchen pass (CASHIERS ∪
// KITCHEN_STAFF) of the ORDER's company — 'write' scope (every company the
// login belongs to). /pos is not module-gated (the till). A foreign order, or
// a line that is not on that order → 404 (never a hint that it exists).
// 409: BOX_NOT_NEEDED (takeaway / delivery / a packaging-vessel line),
// ORDER_COMPLETED (an undo once the order is complete), LINE_VOIDED,
// ORDER_ENDED (cancelled / rejected / refunded). Undo is allowed until the
// order completes. Audited in the order's company (markBoxGiven).
//
// Wave Z registers it: app.register(posBoxGivenRoutes, { prefix: '/pos' }).

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, CASHIERS, KITCHEN_STAFF } from '../auth/middleware.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { scopeTenantWhere } from '../../lib/tenantScope.js'
import { markBoxGiven } from '../../lib/recipeCost.js'
import { flagOrderStockFailure } from '../orders/stock.js'

/** The till, the floor and the pass: whoever can see a dine-in line being boxed. */
const BOX_GIVEN_ROLES = [...new Set([...CASHIERS, ...KITCHEN_STAFF])]

const paramsSchema = z.object({ orderId: z.string().uuid(), itemId: z.string().uuid() })
const bodySchema = z.object({ undo: z.boolean().optional() })

export default async function posBoxGivenRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Params: { orderId: string; itemId: string } }>(
    '/orders/:orderId/items/:itemId/box-given',
    { preHandler: requireAuth(...BOX_GIVEN_ROLES) },
    async (req) => {
      const params = paramsSchema.safeParse(req.params)
      if (!params.success) throw new NotFoundError('OrderItem', String(req.params.itemId))
      const { orderId, itemId } = params.data
      const body = bodySchema.parse(req.body ?? {})
      const su = req.staffUser!

      // The order must be one of the login's companies' ('write' scope —
      // orders have no tenantId: through the brand), and the line on it.
      const order = await prisma.order.findFirst({
        where: { id: orderId, deletedAt: null, concept: await scopeTenantWhere(req, 'write') },
        select: { id: true },
      })
      if (!order) throw new NotFoundError('Order', orderId)
      const line = await prisma.orderItem.findFirst({ where: { id: itemId, orderId: order.id }, select: { id: true } })
      if (!line) throw new NotFoundError('OrderItem', itemId)

      try {
        return await markBoxGiven(line.id, { id: su.id, tenantIds: su.memberTenantIds }, { undo: body.undo === true })
      } catch (err) {
        if (err instanceof AppError) {
          // The route's contract names an undo after completion ORDER_COMPLETED.
          if (err.code === 'BOX_GIVEN_FINAL') {
            throw new AppError('ORDER_COMPLETED', 'This order is complete — "Box given" can no longer be undone.', 409)
          }
          throw err
        }
        // The stock or the books refused the tap (it rolled back): flag it on
        // the line for the kitchen / finance, then answer the error.
        if (body.undo !== true) await flagOrderStockFailure(order.id, 'box_given', err, su.id, line.id)
        throw err
      }
    },
  )
}
