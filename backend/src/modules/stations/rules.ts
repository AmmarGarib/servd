// Station rules shared by the station routes and the CEO's approval of a
// raised change (./changeRequests.ts, owner C3 2026-10-26) — one copy.
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { AppError, NotFoundError } from '../../lib/errors.js'

export const createStationSchema = z.object({
  conceptId: z.string().uuid(),
  name: z.string().min(1),
  displayOrder: z.number().int().default(0),
})

// isActive is the KDS Config on/off switch. It was missing here, so zod
// stripped it and the toggle silently did nothing.
export const updateStationSchema = createStationSchema.partial().extend({
  isActive: z.boolean().optional(),
})

/**
 * 409 STATION_IN_USE (with the counts) while anything still routes work to
 * the station: a live menu item, a recipe step of a live dish (or of an
 * active sub-recipe), or an open ticket. A station that is deleted or
 * switched off is on no kitchen screen, so taking one out of service while
 * dishes still pointed at it sent every new ticket for them into a queue
 * nobody could see (2026-10-10 audit, BOH-03). Refusing is the safe choice
 * over silently un-routing: the operator moves each dish to the station that
 * will really cook it, and open tickets finish where the cooks can see them.
 */
export async function assertStationIdle(station: { id: string; name: string }, action: string): Promise<void> {
  const [menuItems, recipeSteps, openItems, openSteps] = await Promise.all([
    prisma.menuItem.count({ where: { stationId: station.id, deletedAt: null } }),
    prisma.recipeStep.count({
      where: {
        stationId: station.id,
        recipe: { OR: [{ menuItem: { is: { deletedAt: null } } }, { menuItemId: null, isActive: true }] },
      },
    }),
    prisma.orderItem.count({
      where: { stationId: station.id, status: { in: ['pending', 'preparing', 'held', 'recalled'] }, steps: { none: {} } },
    }),
    prisma.orderItemStep.count({ where: { stationId: station.id, status: { in: ['pending', 'waiting', 'preparing'] } } }),
  ])
  const tickets = openItems + openSteps
  if (menuItems + recipeSteps + tickets === 0) return
  const parts = [
    menuItems   ? `${menuItems} menu item${menuItems === 1 ? '' : 's'}` : null,
    recipeSteps ? `${recipeSteps} recipe step${recipeSteps === 1 ? '' : 's'}` : null,
    tickets     ? `${tickets} open ticket${tickets === 1 ? '' : 's'}` : null,
  ].filter(Boolean).join(', ')
  throw new AppError(
    'STATION_IN_USE',
    `${station.name} still has ${parts}. Move the dishes to another station (Menu → item → Station, and the recipe's steps), `
      + `let open tickets finish, then ${action}.`,
    409,
    { menuItems, recipeSteps, openTickets: tickets },
  )
}

/**
 * The rules a station change must pass — at the edit, and again when the CEO
 * approves a raised one (./changeRequests.ts): switching off or moving brand
 * needs an idle station; a brand move stays inside the station's company.
 */
export async function checkStationUpdate(
  owned: { id: string; name: string; isActive: boolean; conceptId: string; concept: { tenantId: string | null } },
  body: z.infer<typeof updateStationSchema>,
): Promise<void> {
  if (body.isActive === false && owned.isActive) await assertStationIdle(owned, 'switch it off')

  if (body.conceptId && body.conceptId !== owned.conceptId) {
    // A station may move between brands, but only within its own company —
    // never across to a brand of another company the operator also belongs
    // to. The write-scope lookup only matches brands of a member company, so
    // the home tenant is never null in practice; guard anyway so a null could
    // never widen the filter to company-less brands.
    const homeTenantId = owned.concept.tenantId
    if (!homeTenantId) throw new NotFoundError('Concept', body.conceptId)
    const target = await prisma.concept.findFirst({
      where: { id: body.conceptId, deletedAt: null, tenantId: homeTenantId },
      select: { id: true },
    })
    if (!target) throw new AppError('BRAND_NOT_IN_COMPANY', "Brand does not belong to this station's company", 422)
    // The old brand's dishes and tickets still point here.
    await assertStationIdle(owned, 'move it to another brand')
  }
}

