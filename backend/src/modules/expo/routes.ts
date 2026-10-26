// Expo routes — the kitchen pass-station's view of incoming work.
//
// Pre-confirm (status='received'): every new order sits here until the expo
// hits "Confirm & Fire". That triggers item dispatch to whichever station
// their recipe's first step says, marks the order `preparing`.
//
// Post-fire: items walk through their RecipeStep graph — when a step is
// bumped, its dependents fire. The whole thing is intentionally simple:
// we don't try to predict; we just notify when the deps clear.

import type { FastifyInstance } from 'fastify'
import { Prisma, type UserRole } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, ALL_STAFF, MANAGERS } from '../auth/middleware.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { scopeTenantWhere } from '../../lib/tenantScope.js'
import { redactDeliveryOtp } from '../../lib/deliveryOtp.js'
import { codeOnlyDelivery } from '../../lib/deliveryRules.js'
import { SERVICE_PHASES } from './fire.js'

const HANDOFF_ACTION = 'expo.handoff'
/** Who may override course pacing ("fire all now"): the manager tiers and the expediter. */
const FIRE_ALL_ROLES: UserRole[] = [...MANAGERS, 'expediter']

/**
 * Ids of the orders still on the pass, newest first, at most `take` — with
 * the handed-off ones removed INSIDE the query (R1). The old helpers loaded
 * the oldest N first and dropped the handed-off ones afterwards, so once a
 * company had N till sales in the window every new paid order was cut off
 * and never reached expo. Newest first so the cap, if it ever bites, drops
 * the stalest tickets, never the one a customer just paid for.
 *   ready — status 'ready', not handed off (a delivery with its rider and a
 *           served-but-unpaid tab stay 'ready'; the hand-off row is what
 *           takes them off the pass).
 *   paid  — till sales (POS, group bill) completed at payment in the last 12
 *           hours, not handed off, with at least one line that needs the
 *           kitchen (R3: a paid sale of nothing to cook never joins expo).
 */
async function onPassIds(kind: 'ready' | 'paid', conceptIds: string[], take: number): Promise<string[]> {
  if (conceptIds.length === 0) return []
  const which = kind === 'ready'
    ? Prisma.sql`o.status = 'ready'`
    : Prisma.sql`o.status = 'completed'
        AND o."placedAt" >= ${new Date(Date.now() - 12 * 3_600_000)}
        AND (o.source = 'pos' OR o."rawPayload"->>'channel' = 'group_order')
        AND EXISTS (
          SELECT 1 FROM order_items oi
          WHERE oi."orderId" = o.id AND oi.status <> 'voided' AND oi."voidedAt" IS NULL
            AND (
              oi."stationId" IS NOT NULL
              OR EXISTS (SELECT 1 FROM order_item_steps s WHERE s."orderItemId" = oi.id)
              OR EXISTS (
                SELECT 1 FROM recipes r JOIN recipe_steps rs ON rs."recipeId" = r.id
                WHERE r."menuItemId" = oi."menuItemId" AND rs.phase::text IN (${Prisma.join([...SERVICE_PHASES])})
              )
            )
        )`
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT o.id FROM orders o
    WHERE o."conceptId" IN (${Prisma.join(conceptIds)})
      AND o."deletedAt" IS NULL
      AND ${which}
      AND NOT EXISTS (
        SELECT 1 FROM audit_logs a
        WHERE a.entity = 'Order' AND a."entityId" = o.id AND a.action = ${HANDOFF_ACTION}
      )
    ORDER BY o."placedAt" DESC
    LIMIT ${take}
  `
  return rows.map((r) => r.id)
}

/**
 * Expo's ready column: 'ready' orders expo has not handed over yet. A
 * delivery handed to its rider, or a till sale served but not yet paid, stays
 * 'ready' until the rider drops it off / the till takes payment (decision 8)
 * — the hand-off audit row is what takes it off the pass.
 */
async function readyNotHandedOff<I extends Prisma.OrderInclude>(conceptIds: string[], include: I) {
  const ids = await onPassIds('ready', conceptIds, 60)
  return prisma.order.findMany({ where: { id: { in: ids } }, include, orderBy: { placedAt: 'asc' } })
}

/** A line the kitchen is finished with (same rule as the all-bumped → 'ready' check). */
const lineDone = (i: { status: string }) => i.status === 'bumped' || i.status === 'voided'

/**
 * Till sales PAID before expo handed them off (UI-05). A till sale completes
 * at payment (decision 8) — at a counter that is before the kitchen has
 * cooked it — so its status says nothing about the pass: the old queue keyed
 * only on status and a paid order vanished from expo while its ticket was
 * still on the grill. Kitchen progress is read from its lines instead, and it
 * stays on the pass until expo hands it off ('expo.handoff' audit row). Only
 * the last 12 hours, so a paid order nobody handed off doesn't sit there
 * forever, and only a sale with something to cook (onPassIds). Payment's own
 * completion path (ledger, rollups, loyalty, invoice) is untouched — this is
 * a read.
 */
async function paidNotHandedOff<I extends Prisma.OrderInclude>(conceptIds: string[], include: I) {
  const ids = await onPassIds('paid', conceptIds, 120)
  return prisma.order.findMany({ where: { id: { in: ids } }, include, orderBy: { placedAt: 'asc' } })
}

export async function expoRoutes(fastify: FastifyInstance) {
  // Station board, Start, cook timers, the expo backlog + 60-second alert,
  // bag stickers (owner B12, 2026-10-26) — ./kitchenBoard.ts.
  const { kitchenBoardRoutes } = await import('./kitchenBoard.js')
  await fastify.register(kitchenBoardRoutes)


  // GET /expo/queue — everything expo needs in one round-trip:
  //   • awaitingFire — `received` (not yet confirmed); each row has the
  //     fulfilmentType so expo knows what they're committing to.
  //   • inProgress   — `preparing`; each item carries its step counters
  //     (done/total) so expo sees a per-order progress like 3/5, 4/5.
  //   • ready        — `ready`; expo's "Served / Dispatch / Picked up"
  //     button lives here, copy switches by fulfilmentType.
  //   • stations     — live load per station (already on the right sidebar).
  // A till sale PAID before its hand-off (status 'completed') sits in the
  // column its lines put it in until expo hands it off (paidNotHandedOff).
  fastify.get(
    '/queue',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const tenantId = (await scopeTenantWhere(req, 'read')).tenantId
      const conceptScope = { tenantId, deletedAt: null }
      // The company's brands, resolved once: the on-pass queries filter on
      // them (an empty scope → no ids → nothing, never everything).
      const conceptIds = (await prisma.concept.findMany({ where: conceptScope, select: { id: true } })).map((c) => c.id)
      const orderInclude = {
        concept:  { select: { id: true, name: true, slug: true, tenantId: true } },
        customer: { select: { id: true, name: true, phone: true } },
        table:    { select: { id: true, label: true } },
        rider:    { select: { id: true, name: true, phone: true } },
        items: {
          select: {
            id: true, name: true, quantity: true, notes: true, status: true, firedAt: true,
            // A paced line (pending, fire time set) — the screen shows "fires at 14:59".
            scheduledFireAt: true,
            steps: { select: { id: true, status: true } },
          },
        },
      } as const

      // Pre-orders (O-RV-3): an order scheduled beyond the prep window is not
      // the kitchen's yet — it stays out of awaiting-fire and in-progress (and
      // out of their caps: a week of pre-orders used to push every order for
      // now off the 50-row awaiting-fire list) and is listed under `upcoming`
      // with its time instead. An order already cooking ('preparing') always
      // shows, even if it was fired early.
      const { PRE_ORDER_PREP_MS } = await import('../orders/service.js')
      const horizon = new Date(Date.now() + PRE_ORDER_PREP_MS)
      const kitchenDue = [{ scheduledFor: null }, { scheduledFor: { lte: horizon } }]

      const [awaitingFireUnpaid, inProgressUnpaid, readyUnpaid, paid, stations, upcomingRows] = await Promise.all([
        prisma.order.findMany({
          where: { status: 'received', concept: conceptScope, deletedAt: null, OR: kitchenDue },
          include: orderInclude,
          orderBy: { placedAt: 'asc' },
          take: 50,
        }),
        prisma.order.findMany({
          where: {
            status: { in: ['confirmed', 'preparing'] }, concept: conceptScope, deletedAt: null,
            OR: [...kitchenDue, { status: 'preparing' }],
          },
          include: orderInclude,
          orderBy: { placedAt: 'asc' },
          take: 80,
        }),
        readyNotHandedOff(conceptIds, orderInclude),
        paidNotHandedOff(conceptIds, orderInclude),
        prisma.station.findMany({
          where: { concept: conceptScope, isActive: true, deletedAt: null },
          select: {
            id: true, name: true,
            concept: { select: { slug: true } },
            // A held pre-order's pending lines are not load yet.
            _count: { select: { orderItems: { where: {
              status: { in: ['pending', 'preparing', 'held', 'recalled'] },
              OR: [{ status: { not: 'pending' } }, { order: { OR: kitchenDue } }],
            } } } },
          },
          orderBy: { displayOrder: 'asc' },
        }),
        // Pre-orders not yet in their prep window, soonest first.
        prisma.order.findMany({
          where: {
            status: { in: ['received', 'confirmed'] }, concept: conceptScope, deletedAt: null,
            scheduledFor: { gt: horizon },
          },
          include: orderInclude,
          orderBy: { scheduledFor: 'asc' },
          take: 50,
        }),
      ])

      // Paid till sales join the column their kitchen progress puts them in:
      // nothing fired yet → awaiting fire; still cooking → in progress; every
      // line done → ready for the hand-off.
      const byPlaced = (a: { placedAt: Date }, b: { placedAt: Date }) => a.placedAt.getTime() - b.placedAt.getTime()
      const paidLive = paid.filter((o) => o.items.some((i) => i.status !== 'voided'))
      const paidUnfired = paidLive.filter((o) => o.items.every((i) => i.status === 'voided' || (i.status === 'pending' && !i.firedAt)))
      const paidReady = paidLive.filter((o) => o.items.every(lineDone))
      const paidCooking = paidLive.filter((o) => !paidUnfired.includes(o) && !paidReady.includes(o))
      const awaitingFire = [...awaitingFireUnpaid, ...paidUnfired].sort(byPlaced)
      const inProgress = [...inProgressUnpaid, ...paidCooking].sort(byPlaced)
      const ready = [...readyUnpaid, ...paidReady].sort(byPlaced)

      // Per-order step roll-up: counts steps across all items + a "current
      // station" string for the inProgress row. Items without recipe steps
      // contribute 1 implicit step each (legacy routing).
      function summarise(order: typeof inProgress[number]) {
        let totalSteps = 0
        let doneSteps  = 0
        const activeStations = new Set<string>()
        for (const it of order.items) {
          if (it.steps.length > 0) {
            totalSteps += it.steps.length
            for (const s of it.steps) {
              if (s.status === 'done' || s.status === 'voided') doneSteps++
              if (s.status === 'preparing') {
                // Pull the station name from the existing /stations cache below.
              }
            }
          } else {
            // Legacy item: treat as 1 step; complete when item is bumped.
            totalSteps += 1
            if (it.status === 'bumped' || it.status === 'voided') doneSteps += 1
          }
        }
        return { totalSteps, doneSteps, activeStations: Array.from(activeStations) }
      }

      // The customer's hand-over code stays off the pass: expo hands the bag
      // to the rider. Only admin / management may read it, and nobody (the
      // CEO included) when the order's company has code-only delivery on
      // (lib/deliveryOtp.ts, lib/deliveryRules.ts codeOnlyDelivery).
      const role = req.staffUser!.role
      const shownTenants = new Set<string>()
      for (const o of [...awaitingFire, ...inProgress, ...ready, ...upcomingRows]) {
        if (o.concept?.tenantId) shownTenants.add(o.concept.tenantId)
      }
      const codeOnlyTenants = new Set<string>()
      for (const t of shownTenants) if (await codeOnlyDelivery(prisma, t)) codeOnlyTenants.add(t)
      const codeOnlyOf = (o: { concept?: { tenantId: string | null } | null }) =>
        !!o.concept?.tenantId && codeOnlyTenants.has(o.concept.tenantId)
      return {
        // `paid` = already paid at the till (completed at payment), so the
        // pass knows not to send the customer back to the counter.
        awaitingFire: awaitingFire.map((o) => redactDeliveryOtp({ ...o, ...summarise(o), paid: o.status === 'completed' }, role, codeOnlyOf(o))),
        inProgress:   inProgress.map((o)   => redactDeliveryOtp({ ...o, ...summarise(o), paid: o.status === 'completed' }, role, codeOnlyOf(o))),
        ready:        ready.map((o)        => redactDeliveryOtp({ ...o, ...summarise(o), paid: o.status === 'completed' }, role, codeOnlyOf(o))),
        // Pre-orders before their prep window: shown with `scheduledFor` and
        // `kitchenAt` (when they join awaiting fire). Not to be cooked yet.
        upcoming:     upcomingRows.map((o) => redactDeliveryOtp({
          ...o, ...summarise(o), paid: o.status === 'completed',
          kitchenAt: new Date(o.scheduledFor!.getTime() - PRE_ORDER_PREP_MS).toISOString(),
        }, role, codeOnlyOf(o))),
        stations: stations.map((s) => ({
          id:    s.id,
          name:  s.name,
          conceptSlug: s.concept.slug,
          activeItems: s._count.orderItems,
        })),
      }
    },
  )

  // POST /expo/orders/:id/fire — expo confirms an incoming order. Moves the
  // order from `received` → `preparing` and fires its FIRST course: the
  // lowest course that still has unfinished lines (no course number = course
  // 1). Later courses stay `pending` until someone fires them (the order's
  // Courses page → POST /orders/:id/fire-course). The body may name a course
  // to fire instead of the first one. Only pending lines that were never
  // voided are fired — see fire.ts. Each fired line goes through its recipe
  // steps (first steps to their stations), or, with no steps, straight onto
  // the menu item's station.
  //
  // Course pacing (BOH-R2-01). Within the course only the lines that are due
  // fire: scheduledFireAt null or already passed. A shorter dish paced to
  // finish with the longest one (orders/service scheduleCoursePacing) stays
  // `pending` and the pacing worker (processCoursePacingTick) fires it at its
  // time; it comes back under `paced` with that time so the screen can say
  // "Fries fire at 14:59". The schedule is re-anchored to this fire first,
  // so the longest dish is always due now. Fire used to send every line of
  // the course at once and pacing never took effect.
  //
  // `fireAll: true` — expo's explicit "fire all now": every pending line of
  // the course fires immediately, paced or not. Manager tiers and the
  // expediter only (FIRE_ALL_ROLES), audited. It also works on an order that
  // is already fired (its paced lines are still waiting), which a plain Fire
  // refuses.
  fastify.post<{ Params: { id: string }; Body: { note?: string; course?: number; fireAll?: boolean } }>(
    '/orders/:id/fire',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req, reply) => {
      const tenantId = (await scopeTenantWhere(req, 'write')).tenantId
      const body = z.object({
        note:    z.string().max(280).optional(),
        course:  z.number().int().min(1).max(20).optional(),
        fireAll: z.boolean().optional(),
      }).parse(req.body ?? {})
      const fireAll = body.fireAll === true
      if (fireAll && !FIRE_ALL_ROLES.includes(req.staffUser!.role)) {
        throw new AppError('FIRE_ALL_NOT_ALLOWED', 'Only a manager or the expediter can fire paced dishes early.', 403)
      }

      const order = await prisma.order.findFirst({
        where: {
          id: req.params.id,
          concept: { tenantId, deletedAt: null },
          deletedAt: null,
        },
        include: {
          items: { select: { id: true, name: true, status: true, voidedAt: true, course: true } },
          // The order's own company: the fire-all audit row is stamped with it,
          // not the operator's active company ('write' scope spans every
          // company the operator belongs to).
          concept: { select: { tenantId: true } },
        },
      })
      if (!order) throw new NotFoundError('Order', req.params.id)
      // A till sale paid before expo fired it is 'completed' (decision 8) but
      // its kitchen work hasn't started (UI-05): expo fires its lines and the
      // order's status stays where payment put it.
      const { isTillSale, scheduleCoursePacing } = await import('../orders/service.js')
      const paidAtTill = order.status === 'completed' && isTillSale(order)
      // "Fire all now" may also finish an order already fired whose paced
      // lines are still waiting.
      const alreadyFired = fireAll && (order.status === 'confirmed' || order.status === 'preparing')
      if (order.status !== 'received' && !paidAtTill && !alreadyFired) {
        throw new AppError(
          'INVALID_TRANSITION',
          `Order is already ${order.status} — only 'received' orders can be fired`,
          409,
        )
      }

      const { courseOf, isLiveLine, isFireable, firstOpenCourse, fireOrderItems } = await import('./fire.js')
      if (!order.items.some(isLiveLine)) {
        throw new AppError('NOTHING_TO_FIRE', 'Every line on this order is voided — reject the order instead of firing it.', 409)
      }
      const course = body.course ?? firstOpenCourse(order.items)
      const inCourse = order.items.filter((i) => isFireable(i) && courseOf(i) === course)
      if (body.course !== undefined && inCourse.length === 0) {
        throw new AppError('NO_ITEMS', `No pending items at course ${body.course}`, 409)
      }

      // A pre-order fired before its prep window opened (O-RV-3): it was held
      // off the kitchen, so the kitchen is told and its stock taken now —
      // once (releasePreOrder is a no-op for an order that was never held or
      // is already released).
      if (order.scheduledFor) {
        // Early only by a manager or the expediter: releasing takes the stock now.
        if (!FIRE_ALL_ROLES.includes(req.staffUser!.role)) {
          const { preOrderHeldUntil, preOrderHeldError } = await import('../orders/service.js')
          const heldUntil = await preOrderHeldUntil(order.id)
          if (heldUntil) throw preOrderHeldError(heldUntil)
        }
        const { releasePreOrder } = await import('../orders/service.js')
        await releasePreOrder(order.id, 'expo_fire').catch((err: Error) =>
          req.log.error({ orderId: order.id, err }, 'expo.fire: pre-order release failed'),
        )
      }

      // Re-anchor the course's pacing to this fire and WAIT for it, BEFORE the
      // order leaves 'received': a schedule laid at creation may have expired
      // while the order waited, and the pacing worker may fire anything due on
      // a 'preparing' order — re-anchoring after the transition left a window
      // in which it would fire the whole course at once. The split below reads
      // the new times. A paid till sale is re-anchored only while none of the
      // course has started; once the worker has fired its longest dish the
      // schedule stands. A failure here is logged, not fatal: the split then
      // falls back to the times on the rows (and the safety net below).
      const courseStarted = order.items.some((i) => isLiveLine(i) && courseOf(i) === course && i.status !== 'pending')
      if (!fireAll && (order.status === 'received' || (paidAtTill && !courseStarted))) {
        try {
          await scheduleCoursePacing(order.id)
        } catch (err) {
          req.log.error({ orderId: order.id, err }, 'expo.fire: course pacing re-anchor failed')
        }
      }

      // Use the existing state machine path so audit + WS events fire correctly.
      // updateOrderStatus enforces the legal transition. (Its own background
      // re-anchor only shifts the paced times by milliseconds.)
      const { updateOrderStatus } = await import('../orders/service.js')
      if (order.status === 'received') await updateOrderStatus(req.params.id, 'preparing')

      // Due now vs paced for later. Read after the re-anchor; `now` is taken
      // after the read, so the anchor line (fire time = the re-anchor) is due.
      const schedule = inCourse.length === 0 ? [] : await prisma.orderItem.findMany({
        where: { id: { in: inCourse.map((i) => i.id) } },
        select: { id: true, name: true, scheduledFireAt: true },
      })
      const now = new Date()
      const fireAt = new Map(schedule.map((s) => [s.id, s.scheduledFireAt]))
      const isDue = (id: string) => {
        const at = fireAt.get(id)
        return at == null || at.getTime() <= now.getTime()
      }
      let dueIds = fireAll ? inCourse.map((i) => i.id) : inCourse.filter((i) => isDue(i.id)).map((i) => i.id)
      // Safety net: nothing due and nothing of this course started yet means
      // the schedule has no anchor (stale times) — the earliest line(s) start
      // now, or the course would never begin. Never when a dish of the course
      // is already cooking: then the rest is genuinely waiting for its time.
      if (!fireAll && dueIds.length === 0 && inCourse.length > 0) {
        if (!courseStarted) {
          const earliest = Math.min(...inCourse.map((i) => fireAt.get(i.id)?.getTime() ?? 0))
          dueIds = inCourse.filter((i) => (fireAt.get(i.id)?.getTime() ?? 0) === earliest).map((i) => i.id)
        }
      }
      const dueSet = new Set(dueIds)

      const { fired, unroutedItems } = await fireOrderItems(order.id, dueIds)

      // Lines of this course left to the pacing worker, with their time.
      const firedIds = new Set(fired.map((f) => f.id))
      const paced = fireAll ? [] : schedule
        .filter((s) => !dueSet.has(s.id) && s.scheduledFireAt != null)
        .sort((a, b) => a.scheduledFireAt!.getTime() - b.scheduledFireAt!.getTime())
        .map((s) => ({ id: s.id, name: s.name, scheduledFireAt: s.scheduledFireAt!.toISOString() }))
      const pacedIds = new Set(paced.map((p) => p.id))

      // Courses still waiting to be fired — expo's cue that this order isn't
      // done when the first course is. (This course's paced lines are not a
      // held course: the worker fires them.)
      const heldCourses = [...new Set(
        order.items.filter((i) => isFireable(i) && !firedIds.has(i.id) && !pacedIds.has(i.id) && courseOf(i) !== course).map(courseOf),
      )].sort((a, b) => a - b)

      // Nothing left to cook (every live line was bumped before expo
      // confirmed): hand the order straight to the ready column instead of
      // leaving it in `preparing` with no bump left to move it.
      if (order.status === 'received' && fired.length === 0 && paced.length === 0 && heldCourses.length === 0 && order.items.every((i) => !isLiveLine(i) || i.status === 'bumped')) {
        await updateOrderStatus(req.params.id, 'ready')
      }

      if (fireAll) {
        try {
          const { audit } = await import('../../lib/audit.js')
          await audit({ category: 'identity',
            userId:   req.staffUser!.id,
            userEmail: req.staffUser!.email,
            tenantId: order.concept.tenantId ?? null,
            entity:   'Order',
            entityId: order.id,
            action:   'expo.fire_all',
            metadata: { course, fired: fired.map((f) => f.id) },
          })
        } catch {
          // Non-fatal, like the note breadcrumb below.
        }
      }

      // Soft warning back to the caller. The order DID fire, but these lines
      // have no live station (none assigned, or it was retired) so the line
      // will never see them. Operator should fix the station assignment.
      if (unroutedItems.length > 0) {
        req.log.warn({ orderId: order.id, unroutedItems }, 'expo.fire: items have no live station — fix in /menu')
      }

      // Audit trail picks up `expo.fire` events with the note for context.
      if (body.note) {
        try {
          const { audit } = await import('../../lib/audit.js')
          await audit({ category: 'identity',
            userId:   req.staffUser!.id,
            entity:   'Order',
            entityId: order.id,
            action:   'expo.fire',
            metadata: { note: body.note, course },
          })
        } catch {
          // Audit failures are non-fatal — we'd rather lose the breadcrumb than
          // block the kitchen.
        }
      }

      return reply.status(200).send({
        ok: true,
        fired: fired.length,   // lines actually sent to the kitchen
        course,                // the course that fired (null: nothing open)
        paced,                 // this course's lines the pacing worker fires later: [{ id, name, scheduledFireAt }]
        heldCourses,           // later courses still pending, in order
        unroutedItems,         // empty unless some fired lines have no live station
      })
    },
  )

  // GET /expo/station/:stationId/queue — what does this station currently
  // need to cook? Unions two things so the migration to step-routing can
  // be gradual:
  //
  //   1. New flow: active OrderItemSteps fired to this station.
  //   2. Legacy:   OrderItems whose `stationId` is this and status is still
  //                pending/preparing (no recipe steps configured yet), plus
  //                recalled ones (a remake) — `status` tells the card which.
  //                HELD lines only with `?states=all` (the admin KDS, which
  //                shows them marked HELD with Resume): a screen that can't
  //                show a hold (the tablet, Bump only) would offer a paused
  //                line as ordinary work (R4). A held line comes back the
  //                moment it is resumed.
  //
  // Each entry carries enough order context for the KDS card to render.
  fastify.get<{ Params: { stationId: string }; Querystring: { states?: string } }>(
    '/station/:stationId/queue',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const tenantId = (await scopeTenantWhere(req, 'read')).tenantId
      // The queries live in kitchenBoard.ts (loadStationQueue) — the station
      // board (owner B12) reads the same two lists.
      const { loadStationQueue } = await import('./kitchenBoard.js')
      const { steps, legacy } = await loadStationQueue(req.params.stationId, tenantId, req.query.states === 'all')

      return {
        steps: steps.map((s) => ({
          stepId:           s.id,
          itemId:           s.orderItemId,
          // MenuItem id is what /recipes/by-item/:id keys on — the expandable
          // instruction panel on the card needs it to fetch the recipe.
          menuItemId:       s.orderItem.menuItemId,
          itemName:         s.orderItem.name,
          qty:              s.orderItem.quantity,
          itemNotes:        s.orderItem.notes,
          status:           s.status,
          firedAt:          s.firedAt,
          instruction:      s.recipeStep.instruction,
          instructionUrdu:  s.recipeStep.instructionUrdu,
          phase:            s.recipeStep.phase,
          estimatedSeconds: s.recipeStep.estimatedSeconds,
          order: {
            id:             s.orderItem.order.id,
            customerName:   s.orderItem.order.customer?.name ?? s.orderItem.order.customerName,
            source:         s.orderItem.order.source,
            placedAt:       s.orderItem.order.placedAt,
            fulfilmentType: s.orderItem.order.fulfilmentType,
            tableLabel:     s.orderItem.order.table?.label ?? null,
            concept:        s.orderItem.order.concept,
          },
        })),
        legacy: legacy.map((it) => ({
          itemId:    it.id,
          menuItemId: it.menuItemId,
          itemName:  it.name,
          qty:       it.quantity,
          itemNotes: it.notes,
          status:    it.status,
          firedAt:   it.firedAt,
          order: {
            id:             it.order.id,
            customerName:   it.order.customer?.name ?? it.order.customerName,
            source:         it.order.source,
            placedAt:       it.order.placedAt,
            fulfilmentType: it.order.fulfilmentType,
            tableLabel:     it.order.table?.label ?? null,
            concept:        it.order.concept,
          },
        })),
      }
    },
  )

  // POST /expo/steps/:id/bump — a station confirms its step. The cascade
  // engine flips this step to `done`, promotes any newly-eligible
  // dependants to `preparing`, and emits expo:fire to their stations.
  fastify.post<{ Params: { id: string } }>(
    '/steps/:id/bump',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req, reply) => {
      const { completeStepBump } = await import('./stepCascade.js')
      const step = await prisma.orderItemStep.findUnique({
        where: { id: req.params.id },
        include: { orderItem: { include: { order: { include: { concept: true } } } } },
      })
      // Cross-company guard — a cook at one company can't bump a step on
      // another company's order even with a guessed id. 404, not 403, so a
      // foreign id doesn't confirm the step exists.
      const stepTenant = step?.orderItem.order.concept.tenantId ?? null
      if (!step || !stepTenant || stepTenant !== req.staffUser!.tenantId) {
        throw new NotFoundError('OrderItemStep', req.params.id)
      }

      // Cascade + broadcast + the item's own bump when its last step is done
      // (stepCascade.ts completeStepBump — the one path, shared with the
      // station card's "done" tick).
      const result = await completeStepBump(req.params.id, step.orderItemId, req.staffUser!.id)

      return reply.status(200).send(result)
    },
  )

  // POST /expo/orders/:id/handoff — expo signs off a `ready` order to the
  // next stage of the journey (server takes it to the table / customer
  // collects at the counter / rider takes the bag). What that means for the
  // order is decision 8 (orders/service completionDoor):
  //   - pickup / dine-in ordered online → COMPLETED here, through the one
  //     completion routine (ledger, invoice, FBR/SRB, loyalty, rollups).
  //   - delivery → NOT completed: the bag is with the rider; the order
  //     completes when the customer's hand-over code is entered (rider app
  //     POST /rider/jobs/:id/deliver, or staff /trustops verify-otp). Only a
  //     company with code-only delivery OFF (lib/deliveryRules.ts) still has
  //     the staff "Delivered" (POST /dispatch/orders/:id/delivered).
  //   - a till sale (rung at the POS, or a group bill) → NOT completed: it
  //     completes when it is paid at the till.
  // Either way the hand-off is recorded ('expo.handoff' audit row), which is
  // what takes the order off expo's ready column.
  fastify.post<{ Params: { id: string } }>(
    '/orders/:id/handoff',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req, reply) => {
      const tenantId = (await scopeTenantWhere(req, 'write')).tenantId
      const order = await prisma.order.findFirst({
        where: { id: req.params.id, concept: { tenantId, deletedAt: null }, deletedAt: null },
      })
      if (!order) throw new NotFoundError('Order', req.params.id)
      const { updateOrderStatus, completionDoor, isTillSale } = await import('../orders/service.js')
      // Only `ready` orders can be handed off. If expo presses too early,
      // refuse with a clear 409 — better than handing over an order with
      // un-bumped items. A till sale paid before the hand-off is 'completed'
      // (decision 8), not 'ready' (UI-05): it is handed off once every line
      // is bumped, and the hand-off only records it (payment completed it).
      const paidAtTill = order.status === 'completed' && isTillSale(order)
      const stillCooking = paidAtTill
        ? await prisma.orderItem.count({ where: { orderId: order.id, status: { notIn: ['bumped', 'voided'] } } })
        : 0
      if ((order.status !== 'ready' && !paidAtTill) || stillCooking > 0) {
        throw new AppError(
          'NOT_READY',
          `Order is ${stillCooking > 0 ? 'still cooking' : order.status} — wait for the kitchen to finish before handing off.`,
          409,
        )
      }
      const door = completionDoor(order)
      const actor = { id: req.staffUser!.id, email: req.staffUser!.email, tenantId: req.staffUser!.tenantId ?? null }
      if (door === 'handoff') {
        await updateOrderStatus(order.id, 'completed', { actor, via: 'expo_handoff' })
      }
      const { audit } = await import('../../lib/audit.js')
      await audit({ category: 'identity',
        userId:   req.staffUser!.id,
        userEmail: req.staffUser!.email,
        tenantId: req.staffUser!.tenantId ?? null,
        entity:   'Order',
        entityId: order.id,
        action:   HANDOFF_ACTION,
        metadata: { fulfilmentType: order.fulfilmentType, completed: door === 'handoff', completesOn: door },
      })
      return reply.status(200).send({ ok: true, fulfilmentType: order.fulfilmentType, completed: door === 'handoff', completesOn: door })
    },
  )

  // POST /expo/orders/:id/reject — expo declines an incoming order (out of
  // stock, blacklisted customer, etc.). Goes through cancelOrder as a
  // 'rejected' order: the reason is stamped on the order (not only the audit
  // log), the customer is told, and anything they paid with wallet / gift
  // card is given back.
  fastify.post<{ Params: { id: string }; Body: { reason: string } }>(
    '/orders/:id/reject',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const { zBackdatedReason } = await import('../nightAudit/backdate.js')
      // backdatedReason: the CEO's reason when the order is from an earlier,
      // night-audited sales day (403 CEO_ONLY_BACKDATED otherwise).
      const body = z.object({ reason: z.string().trim().min(1).max(280), backdatedReason: zBackdatedReason }).parse(req.body)
      // Company scope through the shared helper: tenantFilter is null for a
      // staff user with no company, and `tenantId: null` would match every
      // company-less brand instead of nothing.
      const { scopeTenantWhere } = await import('../../lib/tenantScope.js')
      const order = await prisma.order.findFirst({
        where: {
          id: req.params.id,
          concept: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) },
          deletedAt: null,
        },
        select: { id: true, status: true, source: true, rawPayload: true },
      })
      if (!order) throw new NotFoundError('Order', req.params.id)
      const { cancelOrder, isTillSale } = await import('../orders/service.js')
      // A till sale paid before expo fired it sits in awaiting-fire (UI-05)
      // but the customer has paid: it can't be rejected, only refunded at
      // the till (R4 — this used to be a bare completed → rejected 409).
      if (order.status === 'completed' && isTillSale(order)) {
        throw new AppError('PAID_AT_TILL', 'This order is already paid at the till — refund it from the till instead of rejecting it.', 409)
      }
      await cancelOrder(order.id, {
        status: 'rejected',
        reason: body.reason,
        actor: { id: req.staffUser!.id, email: req.staffUser!.email, tenantId: req.staffUser!.tenantId ?? null },
        action: 'expo.reject',
        backdatedReason: body.backdatedReason,
      })
      return reply.status(200).send({ ok: true })
    },
  )
}
