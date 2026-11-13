// Par stock today — expo's screen (owner, 2026-11-13: "Expo station should be
// able to manipulate par stock generally.. so build it in there"). The rules
// (which orders take portions, give back, sold out at 0) are lib/parStock.ts;
// the running count is lib/reservation.ts's `avail:{menuItemId}`. A service
// counter only: never stock, FIFO lots or the ledger.
//
//   GET /expo/par-stock?conceptId=   every dish of the brand: set, left, on/off
//   PUT /expo/par-stock {menuItemId, portions: int ≥ 0 | null}
//       portions = what is LEFT now (expo's count wins over the running one);
//       null = no limit. 0 sells the dish out; > 0 switches it back on only when
//       this counter sold it out and nobody touched it since (a chef's own 86
//       stands). Audited 'menu.par_stock_set' in the brand's company.
//
// Company scope: the brand through assertConceptOwned (read / write); a dish of
// another company is 404.

import type { FastifyInstance } from 'fastify'
import type { UserRole } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, ALL_STAFF, MANAGERS } from '../auth/middleware.js'
import { NotFoundError } from '../../lib/errors.js'
import { assertConceptOwned, scopeTenantWhere } from '../../lib/tenantScope.js'
import { getBatchAvailability, seedAvailability } from '../../lib/reservation.js'
import { PAR_STOCK_SET, sellOut, backOnIfSoldOutByPar, standingParStockOut } from '../../lib/parStock.js'
import { emitAvailabilityChange } from '../../lib/ws.js'

/** Who sets par stock: the expo station's runners and the managers (the label-settings list). */
const PAR_STOCK_EDITORS: UserRole[] = [...MANAGERS, 'expediter']

const setSchema = z.object({
  menuItemId: z.string().uuid(),
  portions: z.number().int().min(0).max(100_000).nullable(),
})

export async function parStockRoutes(fastify: FastifyInstance) {
  fastify.get<{ Querystring: { conceptId?: string } }>(
    '/par-stock',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const conceptId = z.string().uuid().parse(req.query.conceptId)
      await assertConceptOwned(req, conceptId, 'read')
      const dishes = await prisma.menuItem.findMany({
        where: { conceptId, deletedAt: null },
        select: {
          id: true, name: true, isAvailable: true, portionsAvailable: true,
          category: { select: { name: true, sortOrder: true } },
        },
        orderBy: [{ category: { sortOrder: 'asc' } }, { name: 'asc' }],
      })
      const left = await getBatchAvailability(dishes.map((d) => ({ id: d.id, portionsAvailable: d.portionsAvailable ?? null })))
      return {
        items: dishes.map((d) => ({
          menuItemId: d.id,
          name: d.name,
          category: d.category?.name ?? null,
          portionsSet: d.portionsAvailable ?? null,
          left: left.get(d.id) ?? null,
          isAvailable: d.isAvailable,
        })),
      }
    },
  )

  fastify.put(
    '/par-stock',
    { preHandler: requireAuth(...PAR_STOCK_EDITORS) },
    async (req) => {
      const body = setSchema.parse(req.body)
      const dish = await prisma.menuItem.findFirst({
        where: { id: body.menuItemId, deletedAt: null, concept: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) } },
        select: { id: true, name: true, conceptId: true, isAvailable: true, portionsAvailable: true, updatedAt: true, concept: { select: { tenantId: true } } },
      })
      if (!dish) throw new NotFoundError('MenuItem', body.menuItemId)
      await assertConceptOwned(req, dish.conceptId, 'write')
      const [leftBefore] = [...(await getBatchAvailability([{ id: dish.id, portionsAvailable: dish.portionsAvailable ?? null }])).values()]

      // Read BEFORE the write: setting the count touches the dish's updatedAt,
      // which would otherwise read as "someone touched it since the sell-out".
      const standing = !dish.isAvailable ? await standingParStockOut([dish]) : new Set<string>()

      await prisma.menuItem.update({ where: { id: dish.id }, data: { portionsAvailable: body.portions } })
      if (body.portions !== null) {
        await seedAvailability(dish.id, body.portions)
        void emitAvailabilityChange(dish.id, body.portions)
      }

      let switchedOn = false
      if (body.portions === 0) await sellOut([dish.id])
      else if (!dish.isAvailable && standing.has(dish.id)) {
        switchedOn = (await backOnIfSoldOutByPar([dish.id], standing)).length > 0
      }

      const { audit } = await import('../../lib/audit.js')
      await audit({
        category: 'identity', action: PAR_STOCK_SET, entity: 'MenuItem', entityId: dish.id,
        userId: req.staffUser!.id, userEmail: req.staffUser!.email,
        tenantId: dish.concept.tenantId,
        before: { portionsSet: dish.portionsAvailable ?? null, left: leftBefore ?? null, isAvailable: dish.isAvailable },
        after: { portionsSet: body.portions, left: body.portions },
        metadata: { name: dish.name, switchedOn },
      })

      const fresh = await prisma.menuItem.findUniqueOrThrow({ where: { id: dish.id }, select: { isAvailable: true } })
      return { menuItemId: dish.id, name: dish.name, portionsSet: body.portions, left: body.portions, isAvailable: fresh.isAvailable }
    },
  )
}
