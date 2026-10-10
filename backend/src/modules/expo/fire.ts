// Firing engine — THE place an order line goes from `pending` to `preparing`
// on its station(s). Expo's "Confirm & Fire" (POST /expo/orders/:id/fire)
// calls it for the order's first course; firing a later course should call it
// too, so a step-routed item gets its OrderItemStep rows and every station
// hears about it, whichever door fired it.
//
// Rules (2026-10-10 kitchen audit, BOH-01 / BOH-05 / BOH-03):
//   - Only a line that is still `pending` and was never voided is fired. The
//     claim is a conditional update, so a line voided a moment before (or a
//     second Fire racing this one) is left alone — Fire used to flip a voided
//     line back to `preparing`, the grill cooked it and the books counted it
//     as sold.
//   - A line routed to a station that has been retired (deleted or switched
//     off) is reported as unrouted, exactly like a line with no station: no
//     screen shows that station, so expo has to know.

import { prisma } from '../../lib/prisma.js'
import { getIOSafe, emitItemUpdated } from '../../lib/ws.js'

type Liveness = { isActive: boolean; deletedAt: Date | null } | null

/** A line with no course number belongs to course 1 (same as GET /orders/:id/courses). */
export function courseOf(item: { course: number | null }): number {
  return item.course ?? 1
}

/** Part of the meal: never voided. */
export function isLiveLine(item: { status: string; voidedAt: Date | null }): boolean {
  return item.status !== 'voided' && item.voidedAt == null
}

/** Can be fired now: pending and never voided. */
export function isFireable(item: { status: string; voidedAt: Date | null }): boolean {
  return item.status === 'pending' && item.voidedAt == null
}

/**
 * The course "Fire" sends when the request names none: the lowest course that
 * still has live lines the kitchen hasn't finished. Null when nothing is open.
 */
export function firstOpenCourse(items: Array<{ status: string; voidedAt: Date | null; course: number | null }>): number | null {
  const open = items.filter((i) => isLiveLine(i) && i.status !== 'bumped')
  if (open.length === 0) return null
  return Math.min(...open.map(courseOf))
}

function stationIsLive(station: Liveness): boolean {
  return !!station && station.isActive && station.deletedAt == null
}

export interface UnroutedItem {
  id: string
  name: string
  /** no_station: the menu item has no station; station_retired: it points at a deleted / switched-off station. */
  reason: 'no_station' | 'station_retired'
}

/**
 * Fire these lines of one order. Lines that are not pending-and-unvoided by
 * the time each is claimed are skipped. Returns what actually fired and which
 * fired lines no live station will show.
 */
export async function fireOrderItems(
  orderId: string,
  itemIds: string[],
  now: Date = new Date(),
): Promise<{ fired: Array<{ id: string; name: string }>; unroutedItems: UnroutedItem[] }> {
  if (itemIds.length === 0) return { fired: [], unroutedItems: [] }

  const items = await prisma.orderItem.findMany({
    where: { id: { in: itemIds }, orderId },
    include: {
      station: { select: { isActive: true, deletedAt: true } },
      menuItem: {
        include: {
          recipe: {
            include: { recipeSteps: { include: { station: { select: { isActive: true, deletedAt: true } } } } },
          },
        },
      },
    },
  })
  const byId = new Map(items.map((i) => [i.id, i]))

  const ws = getIOSafe()
  const fired: Array<{ id: string; name: string }> = []
  const unroutedItems: UnroutedItem[] = []

  for (const id of itemIds) {
    const item = byId.get(id)
    if (!item || !isFireable(item)) continue
    const steps = item.menuItem?.recipe?.recipeSteps ?? []
    const serviceSteps = steps.filter((s) => s.phase === 'service_cook' || s.phase === 'service_assemble')

    // Claim the line and (step flow) lay out its steps together: a line is
    // never `preparing` without its steps, and never fired twice.
    const claimed = await prisma.$transaction(async (tx) => {
      const r = await tx.orderItem.updateMany({
        where: { id: item.id, status: 'pending', voidedAt: null },
        data: { status: 'preparing', firedAt: now },
      })
      if (r.count === 0) return false
      if (serviceSteps.length > 0) {
        await tx.orderItemStep.createMany({
          data: serviceSteps.map((s) => ({
            orderItemId:      item.id,
            recipeStepId:     s.id,
            stationId:        s.stationId,
            dependsOnStepIds: s.dependsOnIds,
            status:           s.dependsOnIds.length === 0 ? 'preparing' as const : 'waiting' as const,
            firedAt:          s.dependsOnIds.length === 0 ? now : null,
          })),
        })
      }
      return true
    })
    if (!claimed) continue
    fired.push({ id: item.id, name: item.name })
    emitItemUpdated(item.id, 'preparing', item.stationId)

    if (serviceSteps.length > 0) {
      // ─── Step flow: first steps start on their stations ──────────────────
      for (const step of serviceSteps.filter((s) => s.dependsOnIds.length === 0)) {
        if (!step.stationId || !ws) continue
        ws.to(`station:${step.stationId}`).emit('expo:fire', {
          orderId,
          itemId:     item.id,
          stepId:     step.id,
          stationId:  step.stationId,
          instruction: step.instruction,
          estimatedSeconds: step.estimatedSeconds,
        })
      }
      if (serviceSteps.some((s) => s.stationId && !stationIsLive(s.station))) {
        unroutedItems.push({ id: item.id, name: item.name, reason: 'station_retired' })
      }
    } else {
      // ─── Legacy flow: the line lands on the menu item's station ──────────
      if (!item.stationId) {
        unroutedItems.push({ id: item.id, name: item.name, reason: 'no_station' })
      } else if (!stationIsLive(item.station)) {
        unroutedItems.push({ id: item.id, name: item.name, reason: 'station_retired' })
      } else if (ws) {
        ws.to(`station:${item.stationId}`).emit('expo:fire', {
          orderId,
          itemId:     item.id,
          stepId:     null,
          stationId:  item.stationId,
          instruction: item.name,
          estimatedSeconds: null,
        })
      }
    }
  }

  return { fired, unroutedItems }
}
