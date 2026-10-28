// Rider assignment and delivery — the one implementation.
//
// Every way a rider is put on, taken off or finishes an order comes through
// here: the /dispatch routes (admin /dispatch and /riders pages, tablet
// Dispatch screen), the rider app (/rider/*, modules/rider) and the
// auto-dispatch worker. There used to be a second set of routes
// (/riders/assign, /riders/unassign) with different rules — one accepted
// offline riders, the other skipped the isActive check, one freed the rider
// and the other left them 'busy' forever — and the worker wrote the assignment
// itself with no company check at all, so it could hand one company's order to
// another company's rider.
//
// Company rule (docs/rider-app.md): a rider carries orders of their OWN
// company, or of a company their company has an active FleetAgreement to
// deliver for (lib/fleet.ts). Every step of a job is written to
// RiderJobEvent, stamped with the order's company (the client) and the
// rider's company (the provider).
//
// Database client: this module runs on `serviceClient` (no RLS session vars).
// Callers resolve the order (and, for staff, the rider) through their own
// company scope first — the /dispatch and /trustops routes via
// scopeTenantWhere, the rider app via riderId = the signed-in rider, the
// worker in service mode anyway — and only then hand the id here. It has to:
// a fleet job crosses companies by design, and under enforced RLS a client
// company's staff (B) marking delivered, unassigning or cancelling a B order
// carried by the provider's rider (A) could not see or write A's rider row —
// the delivered claim would roll back and the rider would be left 'busy'.
//
// Every write that decides something is a CLAIM — a conditional update whose
// where-clause carries the state the decision was made on — so the dispatcher,
// the auto-dispatcher, the rider app and the offer timer acting at the same
// moment cannot undo each other.

import type { Prisma, RiderJobEventType } from '@prisma/client'
import { z } from 'zod'
import { serviceClient as prisma } from '../../lib/prisma.js'
import { AppError, ForbiddenError, NotFoundError } from '../../lib/errors.js'
import { fleetMayCarry } from '../../lib/fleet.js'
import { emitRiderLocation } from '../../lib/ws.js'
import { DELIVERY_OTP_MAX_ATTEMPTS, generateDeliveryOtp } from '../../lib/deliveryOtp.js'
import { codeOnlyDelivery } from '../../lib/deliveryRules.js'
import { normalisePhone } from '../auth/otp.js'
import { sendText } from '../../lib/whatsapp.js'
import { audit } from '../../lib/audit.js'
import { flagException } from '../../lib/exceptions.js'
import { orderRefOf } from '../../lib/orderRef.js'
import { formatBrandName } from '../../lib/brandName.js'
import { lockOrderForStock } from '../orders/stock.js'

/** Order statuses in which an assigned rider still has the order to carry. */
export const RIDER_ACTIVE_STATUSES = ['received', 'confirmed', 'preparing', 'ready'] as const

/** How long a 'completed' order handed to a rider stays on their hands. */
const COMPLETED_JOB_WINDOW_MS = 24 * 60 * 60_000

/**
 * THE definition of "an order still on this rider's hands": assigned to them,
 * not dropped off, and either still in service, or already 'completed' (expo
 * completing the order as the bag goes out, or a till-paid order sent out for
 * delivery) and handed to them through the rider flow in the last day. Legacy
 * completed rows with a rider but no riderAssignedAt are history, not jobs.
 *
 * The rider's job list, freeing a rider when their last job ends, the rider
 * guard's company scope, the location fan-out and the dispatch board all read
 * this — they used to disagree, so a rider carrying an expo-completed order
 * who finished another job was set 'available' mid-delivery, and the board
 * lost the order the moment expo completed it.
 */
export function riderOpenOrderWhere(riderId: string, now = Date.now()): Prisma.OrderWhereInput {
  return { riderId, ...stillWithRiderWhere(now) }
}

/**
 * The order-state half of riderOpenOrderWhere, for a filter where the rider is
 * already implied — `rider.orders` on the dispatch board. Never use it on its
 * own against the orders table: without a rider it matches every open order.
 */
export function stillWithRiderWhere(now = Date.now()): Prisma.OrderWhereInput {
  return {
    deletedAt: null,
    deliveredAt: null,
    OR: [
      { status: { in: [...RIDER_ACTIVE_STATUSES] } },
      { status: 'completed', riderAssignedAt: { gte: new Date(now - COMPLETED_JOB_WINDOW_MS) } },
    ],
  }
}

/**
 * Note on an `offered` event written by the auto-dispatcher. Only those offers
 * time out (workers/riderDispatch.ts): a dispatcher who hands an order to a
 * rider by hand — often a rider without the app — is not overruled by a timer.
 */
export const AUTO_OFFER_NOTE = 'auto-dispatch'

type Tx = Prisma.TransactionClient

export interface JobEventInput {
  type: RiderJobEventType
  riderId: string
  orderId: string
  /** The ORDER's company (the client). */
  tenantId: string | null | undefined
  /** The rider's company (the provider). */
  riderTenantId: string | null | undefined
  lat?: number | null
  lng?: number | null
  note?: string | null
  /**
   * The staff user behind an override event (code_rerouted, returned). Null
   * for rider and system steps.
   */
  actorId?: string | null
}

function eventData(e: JobEventInput): Prisma.RiderJobEventUncheckedCreateInput | null {
  if (!e.tenantId || !e.riderTenantId) {
    // A legacy company-less order or rider. The event table is per company by
    // construction, so there is no row to write — say so rather than guess.
    console.warn(`[dispatch] ${e.type} event for order ${e.orderId.slice(0, 8)} not recorded — order or rider has no company`)
    return null
  }
  return {
    type: e.type,
    riderId: e.riderId,
    orderId: e.orderId,
    tenantId: e.tenantId,
    riderTenantId: e.riderTenantId,
    lat: e.lat ?? null,
    lng: e.lng ?? null,
    note: e.note ? e.note.slice(0, 500) : null,
    actorId: e.actorId ?? null,
  }
}

/** Write a job event inside a transaction. */
export async function jobEventTx(tx: Tx, e: JobEventInput): Promise<void> {
  const data = eventData(e)
  if (data) await tx.riderJobEvent.create({ data })
}

/** Write a job event on its own. */
export async function recordJobEvent(e: JobEventInput): Promise<void> {
  const data = eventData(e)
  if (data) await prisma.riderJobEvent.create({ data })
}

function alreadyDelivered(): AppError {
  return new AppError('ALREADY_DELIVERED', 'This order has already been delivered', 409)
}

function orderChanged(): AppError {
  return new AppError('ORDER_CHANGED', "This order's rider changed just now — refresh and try again", 409)
}

function codeWithRider(): AppError {
  return new AppError(
    'CODE_WITH_RIDER',
    "The customer's hand-over code was sent to this order's rider, so the order stays with that rider until it is delivered or returned",
    409,
  )
}

/**
 * A rerouted, undelivered order is pinned to the rider who holds the code
 * (rerouteHandoverCode). The where-clause half of that rule, for the claims:
 * the order may move only to `riderId` (or nowhere, when undefined).
 */
function notPinnedAwayWhere(riderId?: string): Prisma.OrderWhereInput {
  return riderId
    ? { OR: [{ handoverReroutedAt: null }, { handoverRerouteRiderId: riderId }] }
    : { handoverReroutedAt: null }
}

const ENDED_STATUSES = ['cancelled', 'rejected', 'refunded'] as const

/**
 * Offer the order to `riderId`. The rider must be active, not offline, and of
 * the ORDER's company — or of a company with an active fleet agreement to
 * deliver for it (a head-office operator's scope spans several companies, so
 * "both in scope" is not enough). Marks the rider busy, stamps
 * riderAssignedAt and writes an `offered` event. Handing the order to the
 * rider who already has it is a no-op, not a second offer. A delivered order
 * takes no rider (its history and the nightly scoring belong to whoever
 * delivered it).
 *
 *   expectRiderId     act only if the order's rider is still this one (null =
 *                     only if it has none). The auto-dispatcher passes null:
 *                     a dispatcher who assigned by hand between the sweep's
 *                     read and this call is never overwritten.
 *   requireAvailable  the rider must be 'available', not merely on shift —
 *                     the auto-dispatcher never stacks a second offer on a
 *                     rider a dispatcher has just made busy. A dispatcher may.
 */
export async function assignRider(
  orderId: string,
  riderId: string,
  opts: { note?: string | null; expectRiderId?: string | null; requireAvailable?: boolean } = {},
) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, deletedAt: null },
    select: {
      id: true, status: true, riderId: true, deliveredAt: true,
      handoverReroutedAt: true, handoverRerouteRiderId: true,
      concept: { select: { tenantId: true } },
    },
  })
  if (!order) throw new NotFoundError('Order', orderId)
  if (order.deliveredAt) throw alreadyDelivered()
  if (opts.expectRiderId !== undefined && order.riderId !== opts.expectRiderId) throw orderChanged()
  // The code was sent to a rider: the order stays with that rider.
  if (order.handoverReroutedAt && order.handoverRerouteRiderId !== riderId) throw codeWithRider()
  const rider = await prisma.rider.findFirst({ where: { id: riderId, deletedAt: null } })
  if (!rider || !rider.isActive) throw new NotFoundError('Rider', riderId)
  const orderTenantId = order.concept.tenantId
  if (!(await fleetMayCarry(rider.tenantId, orderTenantId))) {
    throw new AppError(
      'RIDER_NOT_IN_COMPANY',
      "Rider does not belong to the order's company, and their company has no active fleet agreement to deliver for it",
      422,
    )
  }
  if (rider.status === 'offline') throw new AppError('RIDER_OFFLINE', 'Rider is offline', 422)
  if (opts.requireAvailable && rider.status !== 'available') {
    throw new AppError('RIDER_NOT_AVAILABLE', 'Rider is no longer available', 409)
  }
  // A completed order can still take a rider — a till-paid order can go out
  // for delivery, and the dispatcher may record the rider after the fact.
  if ((ENDED_STATUSES as readonly string[]).includes(order.status)) {
    throw new AppError('ORDER_NOT_ACTIVE', `Order is ${order.status} — there is nothing to deliver`, 409)
  }
  if (order.riderId === rider.id) return prisma.order.findUniqueOrThrow({ where: { id: order.id } })

  const now = new Date()
  return prisma.$transaction(async (tx) => {
    // The claim: conditional on the rider we read (so the auto-dispatcher and
    // a dispatcher pressing Assign at the same moment cannot both "win"), and
    // on the order still being undelivered and not ended.
    const claimed = await tx.order.updateMany({
      where: {
        id: order.id, riderId: order.riderId, deletedAt: null, deliveredAt: null,
        status: { notIn: [...ENDED_STATUSES] },
        ...notPinnedAwayWhere(rider.id),
      },
      data: { riderId: rider.id, riderAssignedAt: now, riderAcceptedAt: null, pickedUpAt: null, arrivedAt: null },
    })
    if (claimed.count === 0) {
      const fresh = await tx.order.findUnique({
        where: { id: order.id }, select: { handoverReroutedAt: true, handoverRerouteRiderId: true, deliveredAt: true },
      })
      if (fresh?.handoverReroutedAt && !fresh.deliveredAt && fresh.handoverRerouteRiderId !== rider.id) throw codeWithRider()
      throw orderChanged()
    }
    // …and the rider, on the status we checked: one who went off shift (or,
    // for the auto-dispatcher, got busy) since that read is not put back to
    // work. Throwing rolls the order claim back.
    const riderClaim = await tx.rider.updateMany({
      where: {
        id: rider.id, isActive: true, deletedAt: null,
        status: opts.requireAvailable ? 'available' : { not: 'offline' },
      },
      data: { status: 'busy' },
    })
    if (riderClaim.count === 0) {
      throw opts.requireAvailable
        ? new AppError('RIDER_NOT_AVAILABLE', 'Rider is no longer available', 409)
        : new AppError('RIDER_OFFLINE', 'Rider is offline', 422)
    }
    await jobEventTx(tx, {
      type: 'offered', riderId: rider.id, orderId: order.id,
      tenantId: orderTenantId, riderTenantId: rider.tenantId, note: opts.note ?? null,
    })
    // Re-assigning from another rider frees that one if this was their last.
    if (order.riderId && order.riderId !== rider.id) {
      const prev = await tx.rider.findUnique({ where: { id: order.riderId }, select: { tenantId: true } })
      await jobEventTx(tx, {
        type: 'unassigned', riderId: order.riderId, orderId: order.id,
        tenantId: orderTenantId, riderTenantId: prev?.tenantId, note: 'reassigned to another rider',
      })
      await releaseIfIdle(tx, order.riderId, order.id)
    }
    return tx.order.findUniqueOrThrow({ where: { id: order.id } })
  })
}

export interface TakeOffOptions {
  /** Why (a dispatcher's unassign, the rider declining, an offer timing out). */
  event?: Extract<RiderJobEventType, 'unassigned' | 'declined' | 'timed_out'>
  note?: string | null
  lat?: number | null
  lng?: number | null
  /** No-op when the order has meanwhile gone to someone else. */
  onlyIfRiderId?: string
  /**
   * Withdraw an OFFER only: a no-op once the rider has accepted. The offer
   * timer, a rider going off shift and an ended fleet agreement pass it — an
   * accepted job is under way and is the rider's to finish.
   */
  onlyIfNotAccepted?: boolean
  /** A no-op once the rider has the bag (a decline). */
  onlyIfNotPickedUp?: boolean
}

/**
 * Take the rider off the order — the claim is guarded on everything `opts`
 * says, so a no-op is a no-op (no event, rider untouched). The rider goes back
 * to 'available' if this was their last order in hand. A delivered order is
 * 409: its rider is history.
 *
 * A rerouted order (the customer's code was sent to its rider —
 * rerouteHandoverCode) is pinned to that rider until delivered: a plain call
 * (a dispatcher's unassign) is 409 CODE_WITH_RIDER; a guarded call (any
 * onlyIf* — the offer timer, a rider going off shift, an ended fleet
 * agreement, a decline) is a quiet no-op, never an error, so the system loops
 * carry on.
 */
export async function takeRiderOff(orderId: string, opts: TakeOffOptions = {}) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, deletedAt: null },
    select: {
      id: true, riderId: true, riderAcceptedAt: true, pickedUpAt: true, deliveredAt: true,
      handoverReroutedAt: true,
      concept: { select: { tenantId: true } },
    },
  })
  if (!order) throw new NotFoundError('Order', orderId)
  if (order.deliveredAt) throw alreadyDelivered()
  const guarded = !!(opts.onlyIfRiderId || opts.onlyIfNotAccepted || opts.onlyIfNotPickedUp)
  if (order.handoverReroutedAt && order.riderId) {
    if (!guarded) throw codeWithRider()
    return { order: await prisma.order.findUniqueOrThrow({ where: { id: order.id } }), changed: false }
  }
  const prevRiderId = order.riderId
  const skip =
    !prevRiderId
    || (opts.onlyIfRiderId && prevRiderId !== opts.onlyIfRiderId)
    || (opts.onlyIfNotAccepted && order.riderAcceptedAt)
    || (opts.onlyIfNotPickedUp && order.pickedUpAt)
  if (skip) {
    return { order: await prisma.order.findUniqueOrThrow({ where: { id: order.id } }), changed: false }
  }
  return prisma.$transaction(async (tx) => {
    const res = await tx.order.updateMany({
      where: {
        id: order.id, riderId: prevRiderId, deliveredAt: null, handoverReroutedAt: null,
        ...(opts.onlyIfNotAccepted ? { riderAcceptedAt: null } : {}),
        ...(opts.onlyIfNotPickedUp ? { pickedUpAt: null } : {}),
      },
      data: { riderId: null, riderAssignedAt: null, riderAcceptedAt: null, pickedUpAt: null, arrivedAt: null },
    })
    if (res.count === 0 && !guarded) {
      // Rerouted between the read and the claim: pinned now.
      const fresh = await tx.order.findUnique({ where: { id: order.id }, select: { handoverReroutedAt: true, deliveredAt: true } })
      if (fresh?.handoverReroutedAt && !fresh.deliveredAt) throw codeWithRider()
    }
    if (res.count > 0) {
      const prev = await tx.rider.findUnique({ where: { id: prevRiderId! }, select: { tenantId: true } })
      await jobEventTx(tx, {
        type: opts.event ?? 'unassigned', riderId: prevRiderId!, orderId: order.id,
        tenantId: order.concept.tenantId, riderTenantId: prev?.tenantId,
        lat: opts.lat, lng: opts.lng, note: opts.note,
      })
      await releaseIfIdle(tx, prevRiderId!, order.id)
    }
    return { order: await tx.order.findUniqueOrThrow({ where: { id: order.id } }), changed: res.count > 0 }
  })
}

/** Take the rider off the order (see takeRiderOff); returns the order. */
export async function unassignRider(orderId: string, opts: TakeOffOptions = {}) {
  return (await takeRiderOff(orderId, opts)).order
}

/**
 * Withdraw `riderId`'s offer on the order — only if it is still theirs and
 * still not accepted. True when it was withdrawn.
 */
export async function withdrawOffer(
  orderId: string,
  riderId: string,
  opts: { event: 'unassigned' | 'timed_out'; note: string },
): Promise<boolean> {
  const r = await takeRiderOff(orderId, { ...opts, onlyIfRiderId: riderId, onlyIfNotAccepted: true })
  return r.changed
}

/**
 * The order ended without a delivery — cancelled, rejected (orders/service.ts
 * cancelOrder) or refunded in full: its rider is freed and an `unassigned`
 * event says why. The order keeps its riderId — like a delivered one — so the
 * rider's history and the nightly rider scoring still see it; it is off the
 * rider's job list because it is no longer an open status.
 */
export async function releaseRiderFromEndedOrder(orderId: string, reason: string): Promise<void> {
  const order = await prisma.order.findFirst({
    where: { id: orderId },
    select: { id: true, riderId: true, deliveredAt: true, concept: { select: { tenantId: true } } },
  })
  if (!order?.riderId || order.deliveredAt) return
  const riderId = order.riderId
  await prisma.$transaction(async (tx) => {
    const r = await tx.rider.findUnique({ where: { id: riderId }, select: { tenantId: true } })
    await jobEventTx(tx, {
      type: 'unassigned', riderId, orderId: order.id,
      tenantId: order.concept.tenantId, riderTenantId: r?.tenantId, note: reason,
    })
    await releaseIfIdle(tx, riderId, order.id)
  })
}

// ─── Staff closing a rider-app job ───────────────────────────────────────────
//
// A rider-app job (riderAssignedAt set — every assignment since the rider app
// stamps it) is closed by the rider with the customer's code: that code is the
// proof the food reached the door. "Mark delivered" without it would let
// anyone at the till close a delivery the customer never got, so on such a job
// it is a manager's override, and only for the two cases the code cannot
// cover: the code has locked (DELIVERY_OTP_MAX_ATTEMPTS wrong tries — the
// rider app's 423 says "a manager marks it delivered"), or the rider never
// accepted (a rider without the app, handed the order by the dispatcher).
// Orders from before the rider app (no riderAssignedAt) keep the old rule.
//
// All of this applies ONLY to a company whose code-only switch is OFF
// (lib/deliveryRules.ts codeOnlyDelivery, the default). With it ON a delivery
// completes only with the customer's code (owner rule 2026-10-13): markDelivered
// refuses any call without a verified code (409 CODE_REQUIRED), and a locked
// code is resolved by sending it to the rider (rerouteHandoverCode). The staff
// path and these helpers are deleted once every live company is switched on.

type StaffCloseState = { riderAssignedAt: Date | null; riderAcceptedAt: Date | null; deliveryOtpAttempts: number }

function managerRequired(): AppError {
  return new ForbiddenError('Only a manager can mark a rider-app delivery as delivered')
}

function riderClosesWithCode(): AppError {
  return new AppError(
    'RIDER_CLOSES_WITH_CODE',
    "The rider closes this delivery with the customer's code. A manager can mark it delivered only once the code has locked "
    + `(${DELIVERY_OTP_MAX_ATTEMPTS} wrong tries) or if the rider never accepted the job.`,
    409,
  )
}

/** Throws unless staff may close an undelivered order in this state. */
function assertStaffMayClose(o: StaffCloseState, manager: boolean): void {
  if (!o.riderAssignedAt) return                     // pre-rider-app: today's rule
  if (!manager) throw managerRequired()
  if (!o.riderAcceptedAt) return                      // the rider never took it
  if (o.deliveryOtpAttempts >= DELIVERY_OTP_MAX_ATTEMPTS) return   // the code locked
  throw riderClosesWithCode()
}

/** assertStaffMayClose as a where-clause, for the delivered claim. */
function staffMayCloseWhere(manager: boolean): Prisma.OrderWhereInput {
  if (!manager) return { riderAssignedAt: null }
  return {
    OR: [
      { riderAssignedAt: null },
      { riderAcceptedAt: null },
      { deliveryOtpAttempts: { gte: DELIVERY_OTP_MAX_ATTEMPTS } },
    ],
  }
}

/** 409 CODE_REQUIRED: a code-only company's delivery closed without the customer's code. */
function codeRequired(): AppError {
  return new AppError('CODE_REQUIRED', "A delivery completes only with the customer's code", 409)
}

/**
 * The rider dropped the order off — decision 8: THIS is when a delivery is
 * complete (expo handing the bag to the rider is not). Three doors come here:
 * the dispatcher pressing "Mark delivered" (POST /dispatch/orders/:id/delivered),
 * the customer's OTP being verified by staff (POST /trustops/orders/:id/verify-otp)
 * and the rider entering it in the rider app (POST /rider/jobs/:id/deliver);
 * the last two pass `otpVerified`.
 *
 *   - The kitchen must have finished it: 'ready' (or already 'completed' — a
 *     till-paid order that went out with a rider); anything earlier is 409.
 *   - A 'ready' order is completed through the canonical updateOrderStatus →
 *     completeOrder (ledger, invoice, FBR/SRB, loyalty, rollups — once). It
 *     used to be written 'completed' directly, with none of that.
 *   - deliveredAt is stamped once (the claim): the rider's delivery is counted,
 *     a `delivered` event written and the rider freed if it was their last
 *     order in hand. The order keeps its riderId, so it shows in the rider's
 *     history.
 *
 * A rider is required for "Mark delivered"; an OTP verified at the door
 * completes the order even when no rider was recorded on it.
 *
 *   staffClose  the dispatcher's "Mark delivered" (no code). On a rider-app
 *               job the rider closes it with the customer's code; staff may
 *               only step in as a manager, and only when the code has locked
 *               or the rider never accepted (staffMayClose). Checked before
 *               anything is written, and again in the delivered claim, so a
 *               rider accepting at the same moment wins.
 *
 * Code-only companies (lib/deliveryRules.ts codeOnlyDelivery ON): any call
 * without `otpVerified: true` is 409 CODE_REQUIRED, before anything is read
 * or written — staffClose included.
 */
export async function markDelivered(
  orderId: string,
  opts: {
    otpVerified?: boolean
    actor?: { id: string; email?: string | null; tenantId?: string | null } | null
    lat?: number | null
    lng?: number | null
    staffClose?: { manager: boolean }
  } = {},
) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, deletedAt: null },
    select: {
      id: true, status: true, riderId: true, deliveredAt: true,
      riderAssignedAt: true, riderAcceptedAt: true, deliveryOtpAttempts: true, handoverReroutedAt: true,
      concept: { select: { tenantId: true } },
    },
  })
  if (!order) throw new NotFoundError('Order', orderId)
  if (opts.otpVerified !== true && (await codeOnlyDelivery(prisma, order.concept.tenantId))) throw codeRequired()
  const staffClose = opts.staffClose
  if (staffClose) {
    // The role first: on a rider-app job this is a manager's call, delivered
    // or not. Still undelivered, it must also be one staff may close.
    if (order.riderAssignedAt && !staffClose.manager) throw managerRequired()
    if (!order.deliveredAt) assertStaffMayClose(order, staffClose.manager)
  }
  if (!order.riderId && !opts.otpVerified) {
    throw new AppError('NO_RIDER', 'Assign a rider before marking the order delivered', 422)
  }
  if (order.status !== 'ready' && order.status !== 'completed') {
    throw new AppError(
      'NOT_READY',
      ['received', 'confirmed', 'preparing'].includes(order.status)
        ? `Order is ${order.status} — the kitchen has not finished it yet.`
        : `Order is ${order.status} — it cannot be delivered.`,
      409,
    )
  }

  // Complete first (idempotent), so a drop-off that was stamped before a
  // failed completion is still completed on the retry.
  if (order.status === 'ready') {
    const { updateOrderStatus } = await import('../orders/service.js')
    await updateOrderStatus(order.id, 'completed', {
      actor: opts.actor ?? null,
      via: opts.otpVerified ? 'otp_verified' : 'rider_delivered',
    })
  }

  const riderId = order.riderId
  const now = new Date()
  const delivered = await prisma.$transaction(async (tx) => {
    if (opts.otpVerified) {
      await tx.order.updateMany({
        where: { id: order.id, deliveryOtpVerifiedAt: null },
        data: { deliveryOtpVerifiedAt: now },
      })
    }
    const claimed = await tx.order.updateMany({
      where: { id: order.id, deliveredAt: null, ...(staffClose ? staffMayCloseWhere(staffClose.manager) : {}) },
      data: { deliveredAt: now },
    })
    if (claimed.count === 0) {
      if (!staffClose) return false
      // Delivered meanwhile (the rider's code, a retry) → idempotent. Not
      // delivered → the rider accepted (or the job was handed out) since the
      // check above: theirs to close. A 'ready' order was already completed
      // above; it stays on the rider's hands (riderOpenOrderWhere) either way.
      const fresh = await tx.order.findUniqueOrThrow({
        where: { id: order.id },
        select: { deliveredAt: true, riderAssignedAt: true, riderAcceptedAt: true, deliveryOtpAttempts: true },
      })
      if (fresh.deliveredAt) return false
      assertStaffMayClose(fresh, staffClose.manager)
      throw riderClosesWithCode()
    }
    if (riderId) {
      const r = await tx.rider.update({
        where: { id: riderId },
        data: { totalDeliveries: { increment: 1 } },
        select: { tenantId: true },
      })
      await jobEventTx(tx, {
        type: 'delivered', riderId, orderId: order.id,
        tenantId: order.concept.tenantId, riderTenantId: r.tenantId,
        lat: opts.lat, lng: opts.lng,
        note: opts.otpVerified
          ? `hand-over code verified${order.handoverReroutedAt ? ' (code sent to the rider by a manager)' : ''}`
          : staffClose && order.riderAssignedAt
            ? `marked delivered by a manager — ${order.riderAcceptedAt ? 'hand-over code locked' : 'rider never accepted'}`
            : 'marked delivered by staff',
      })
      await releaseIfIdle(tx, riderId, order.id)
    }
    return true
  })
  const fresh = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
  return { order: fresh, alreadyDelivered: !delivered }
}

// ─── Emergency override: send the hand-over code to the rider ───────────────
//
// Owner rule 2026-10-13: a delivery completes only with the customer's code.
// When the customer cannot (or will not) give it at the door — the code
// locked, the customer's phone is dead — a manager sends the code to the
// RIDER's own number (Emergency overrides). The rider collects any cash first
// and enters the code in the app as usual, so the order still closes through
// markDelivered with a verified code. Once per order; the order is then pinned
// to that rider (assignRider / takeRiderOff → CODE_WITH_RIDER).
//
// The route lives in the Emergency overrides module; it resolves the order
// through the operator's write scope (foreign → 404) before calling here.
// Reads and writes go through serviceClient: a fleet rider's row belongs to
// another company and is hidden by RLS.

export interface OverrideActor {
  id: string
  email?: string | null
  tenantId?: string | null
}

function rerouteMessage(brand: string, orderId: string, code: string): string {
  return `${brand} order ${orderRefOf(orderId)}: the customer's hand-over code is ${code}. `
    + 'Collect any cash first, then enter the code in the rider app.'
}

/** Best-effort WhatsApp to the rider (staff: no customer scope; the sandbox funnel still applies). */
async function sendCodeToRider(phone: string, brand: string, orderId: string, code: string): Promise<boolean> {
  try {
    await sendText(phone, rerouteMessage(brand, orderId, code))
    return true
  } catch (err) {
    console.warn(`[dispatch] hand-over code to rider failed for order ${orderRefOf(orderId)}: ${(err as Error).message}`)
    return false
  }
}

/**
 * Send the customer's hand-over code to the order's rider. A fresh code is
 * minted (the old one stops working), the wrong-code count is reset (the old
 * count kept in handoverRerouteAttempts), a `code_rerouted` job event names the
 * manager, and a high exception + audit row land in the ORDER's company.
 */
export async function rerouteHandoverCode(
  orderId: string,
  a: { actor: OverrideActor; reason: string },
): Promise<{ ok: true; sentToRider: boolean; riderPhoneHint: string }> {
  const order = await prisma.order.findFirst({
    where: { id: orderId, deletedAt: null },
    select: {
      id: true, status: true, fulfilmentType: true, deliveredAt: true, riderId: true,
      riderAssignedAt: true, pickedUpAt: true, handoverReroutedAt: true, deliveryOtpAttempts: true,
      conceptId: true, totalCents: true,
      concept: { select: { name: true, tenantId: true } },
    },
  })
  if (!order) throw new NotFoundError('Order', orderId)
  if (order.fulfilmentType !== 'delivery') {
    throw new AppError('NOT_A_DELIVERY', 'Only a delivery order has a hand-over code to send to a rider', 422)
  }
  if (order.deliveredAt) throw alreadyDelivered()
  if (order.status !== 'ready') {
    throw new AppError('NOT_READY', `Order is ${order.status} — the code can only be sent while the order is out for delivery`, 409)
  }
  if (!order.riderId) throw new AppError('NO_RIDER', 'This order has no rider to send the code to', 422)
  if (order.riderAssignedAt && !order.pickedUpAt) {
    throw new AppError('NOT_PICKED_UP', 'The rider has not picked this order up yet', 409)
  }
  if (order.handoverReroutedAt) {
    throw new AppError('ALREADY_REROUTED', 'The code was already sent to the rider for this order — use Resend', 409)
  }
  const riderId = order.riderId
  const rider = await prisma.rider.findUnique({ where: { id: riderId }, select: { id: true, phone: true, tenantId: true } })
  if (!rider) throw new AppError('NO_RIDER', 'This order has no rider to send the code to', 422)
  const phone = rider.phone ? normalisePhone(rider.phone) : ''
  if (phone.length < 11) {
    throw new AppError('RIDER_HAS_NO_PHONE', "The rider has no usable phone number to send the code to", 422)
  }
  const reason = a.reason.trim().slice(0, 500)
  let attemptsBefore = order.deliveryOtpAttempts
  const code = generateDeliveryOtp()
  const now = new Date()

  await prisma.$transaction(async (tx) => {
    await lockOrderForStock(tx, order.id)
    // The count under the order lock, not the earlier read: a rider's guess
    // in between must not be lost from the snapshot.
    const locked = await tx.order.findUnique({ where: { id: order.id }, select: { deliveryOtpAttempts: true } })
    attemptsBefore = locked?.deliveryOtpAttempts ?? attemptsBefore
    const claimed = await tx.order.updateMany({
      where: { id: order.id, handoverReroutedAt: null, deliveredAt: null, riderId, status: 'ready', deletedAt: null },
      data: {
        deliveryOtp: code,
        handoverReroutedAt: now,
        handoverRerouteRiderId: riderId,
        handoverRerouteAttempts: attemptsBefore,
        deliveryOtpAttempts: 0,
      },
    })
    if (claimed.count === 0) throw orderChanged()
    await jobEventTx(tx, {
      type: 'code_rerouted', riderId, orderId: order.id,
      tenantId: order.concept.tenantId, riderTenantId: rider.tenantId,
      actorId: a.actor.id, note: reason || 'hand-over code sent to the rider',
    })
  })

  const brand = formatBrandName(order.concept.name)
  const sentToRider = await sendCodeToRider(phone, brand, order.id, code)
  const ref = orderRefOf(order.id)
  await audit({
    category: 'identity',
    action: 'delivery.code_rerouted',
    entity: 'Order',
    entityId: order.id,
    userId: a.actor.id,
    userEmail: a.actor.email ?? null,
    tenantId: order.concept.tenantId,
    metadata: { reason, riderId, riderTenantId: rider.tenantId, attemptsBefore, sentToRider },
  })
  await flagException({
    tenantId: order.concept.tenantId,
    conceptId: order.conceptId,
    kind: 'delivery_code_rerouted',
    severity: 'high',
    title: `Hand-over code sent to the rider on order ${ref}`,
    description: `A manager sent the customer's hand-over code to the rider's own number (reason: ${reason || 'none given'}). `
      + 'Check that the customer really received the food and that any cash was collected.',
    entityType: 'Order',
    entityId: order.id,
    actorId: a.actor.id,
    amountCents: order.totalCents,
    metadata: { riderId, attemptsBefore, sentToRider },
  })
  return { ok: true, sentToRider, riderPhoneHint: phone.slice(-3) }
}

/**
 * Resend the rerouted code — the SAME code, to the SAME rider
 * (handoverRerouteRiderId). Accepts the actor itself or `{ actor }`.
 */
export async function resendReroutedCode(
  orderId: string,
  actorOrArgs: OverrideActor | { actor: OverrideActor },
): Promise<{ ok: true; sentToRider: boolean }> {
  const actor: OverrideActor = 'actor' in actorOrArgs ? actorOrArgs.actor : actorOrArgs
  const order = await prisma.order.findFirst({
    where: { id: orderId, deletedAt: null },
    select: {
      id: true, deliveredAt: true, deliveryOtp: true, handoverReroutedAt: true, handoverRerouteRiderId: true,
      concept: { select: { name: true, tenantId: true } },
    },
  })
  if (!order) throw new NotFoundError('Order', orderId)
  if (!order.handoverReroutedAt || !order.handoverRerouteRiderId || !order.deliveryOtp) {
    throw new AppError('NOT_REROUTED', 'The code has not been sent to a rider on this order yet', 409)
  }
  if (order.deliveredAt) throw alreadyDelivered()
  const rider = await prisma.rider.findUnique({ where: { id: order.handoverRerouteRiderId }, select: { phone: true } })
  const phone = rider?.phone ? normalisePhone(rider.phone) : ''
  if (phone.length < 11) {
    throw new AppError('RIDER_HAS_NO_PHONE', 'The rider has no usable phone number to send the code to', 422)
  }
  const sentToRider = await sendCodeToRider(phone, formatBrandName(order.concept.name), order.id, order.deliveryOtp)
  await audit({
    category: 'identity',
    action: 'delivery.code_resent',
    entity: 'Order',
    entityId: order.id,
    userId: actor.id,
    userEmail: actor.email ?? null,
    tenantId: order.concept.tenantId,
    metadata: { riderId: order.handoverRerouteRiderId, sentToRider },
  })
  return { ok: true, sentToRider }
}

/** Set the rider's own availability — the one writer (admin /dispatch, /riders, tablet, rider app). */
export async function setRiderStatus(riderId: string, status: 'available' | 'busy' | 'offline') {
  // Never the password hash (riders/routes.ts withoutSecret).
  const { passwordHash, ...row } = await prisma.rider.update({ where: { id: riderId }, data: { status } })
  return { ...row, hasPassword: !!passwordHash }
}

/** Free a busy rider whose last order in hand (other than `exceptOrderId`) just ended. */
async function releaseIfIdle(tx: Tx, riderId: string, exceptOrderId: string): Promise<void> {
  const stillCarrying = await tx.order.count({
    where: { ...riderOpenOrderWhere(riderId), id: { not: exceptOrderId } },
  })
  if (stillCarrying === 0) {
    // Only a busy rider is freed — an offline rider stays offline.
    await tx.rider.updateMany({ where: { id: riderId, status: 'busy' }, data: { status: 'available' } })
  }
}

// ─── The hand-over code: attempt slots ───────────────────────────────────────

/**
 * Take one hand-over-code attempt on the order BEFORE comparing — the rider
 * app and the staff verify share the budget (lib/deliveryOtp.ts
 * DELIVERY_OTP_MAX_ATTEMPTS). The conditional increment is the claim, so
 * parallel guesses cannot get past the limit and no writer ever stores a
 * stale absolute count. False when the order is locked.
 */
export async function claimHandoverAttempt(
  orderId: string,
  max: number,
  where: Prisma.OrderWhereInput = {},
): Promise<{ claimed: boolean; attempts: number }> {
  const slot = await prisma.order.updateMany({
    where: { ...where, id: orderId, deliveryOtpAttempts: { lt: max } },
    data: { deliveryOtpAttempts: { increment: 1 } },
  })
  const after = await prisma.order.findUnique({ where: { id: orderId }, select: { deliveryOtpAttempts: true } })
  return { claimed: slot.count > 0, attempts: after?.deliveryOtpAttempts ?? max }
}

/** The right code: hand the slot back — a clean hand-over is not a failed attempt. */
export async function releaseHandoverAttempt(orderId: string): Promise<void> {
  await prisma.order.updateMany({
    where: { id: orderId, deliveryOtpAttempts: { gt: 0 } },
    data: { deliveryOtpAttempts: { decrement: 1 } },
  })
}

// ─── Location fixes ──────────────────────────────────────────────────────────

/** One validation for a location fix — the staff relay and the rider app share it. */
export const riderFixSchema = z.object({
  lat:      z.number().min(-90).max(90),
  lng:      z.number().min(-180).max(180),
  heading:  z.number().min(0).max(359).optional(),
  accuracy: z.number().min(0).max(10_000).optional(),
  speedMps: z.number().min(0).optional(),
  orderId:  z.string().uuid().optional(),
})
export type RiderFix = z.infer<typeof riderFixSchema>

/**
 * 409 OFF_SHIFT: the rider app's own fix while the rider is 'offline'. Both
 * clients stop sharing on it — a rider off shift is not tracked.
 */
export function offShiftError(): AppError {
  return new AppError('OFF_SHIFT', 'You are off shift, so your location is not shared. Go on shift to share it.', 409)
}

/**
 * Store a fix and fan it out. The caller has already checked that `fix.orderId`
 * (if any) is an order this rider is carrying. A fix never changes the rider's
 * status: it used to flip an admin-set 'offline' rider back to 'available' —
 * going on shift is the rider's own action now (POST /rider/shift).
 *
 *   onShiftOnly  the rider app's own fix: stored only while the rider is not
 *                'offline' (the rider-row update is the claim — nothing is
 *                written for a rider who went off shift), else OFF_SHIFT.
 *                The staff relay does not pass it.
 */
export async function recordRiderFix(
  rider: { id: string; tenantId: string | null },
  fix: RiderFix,
  opts: { onShiftOnly?: boolean } = {},
) {
  const now = new Date()
  await prisma.$transaction(async (tx) => {
    const updated = await tx.rider.updateMany({
      where: { id: rider.id, ...(opts.onShiftOnly ? { status: { not: 'offline' as const } } : {}) },
      data: {
        lastLat: fix.lat, lastLng: fix.lng,
        lastHeading: fix.heading ?? null,
        lastAccuracy: fix.accuracy ?? null,
        lastReportedAt: now,
      },
    })
    if (updated.count === 0) throw opts.onShiftOnly ? offShiftError() : new NotFoundError('Rider', rider.id)
    await tx.riderLocation.create({
      data: {
        riderId: rider.id,
        orderId: fix.orderId ?? null,
        lat: fix.lat, lng: fix.lng,
        heading: fix.heading ?? null,
        accuracy: fix.accuracy ?? null,
        speedMps: fix.speedMps ?? null,
        recordedAt: now,
      },
    })
  })

  // Realtime: never let the fan-out fail (or slow) the fix itself. Every
  // company whose order the rider has in hand (riderOpenOrderWhere — incl. an
  // expo-completed order on its last leg) sees the pin.
  void (async () => {
    const jobs = await prisma.order.findMany({
      where: {
        OR: [
          riderOpenOrderWhere(rider.id, now.getTime()),
          ...(fix.orderId ? [{ id: fix.orderId, riderId: rider.id, deletedAt: null }] : []),
        ],
      },
      select: { id: true, concept: { select: { tenantId: true } } },
      take: 20,
    })
    const withCompany = jobs.map((j) => ({ id: j.id, tenantId: j.concept.tenantId }))
    emitRiderLocation({
      fix: { riderId: rider.id, lat: fix.lat, lng: fix.lng, heading: fix.heading ?? null, recordedAt: now.toISOString() },
      riderTenantId: rider.tenantId,
      fixOrder: fix.orderId ? (withCompany.find((j) => j.id === fix.orderId) ?? null) : null,
      jobs: withCompany,
    })
  })().catch((err) => console.warn('[dispatch] rider:location fan-out failed:', (err as Error).message))

  return { ok: true, recordedAt: now.toISOString() }
}

// ─── Board read-only extras ──────────────────────────────────────────────────

const BOARD_DOOR_KINDS = ['no_code', 'refused', 'unreachable'] as const

/**
 * Read-only extras for GET /dispatch/board, for orders on a rider's hands:
 * who sent the hand-over code to the rider (the latest `code_rerouted` event's
 * staff user) and the rider's latest door problem (by the order's CURRENT
 * rider). Writes nothing.
 */
export async function boardOverrideInfo(
  orders: { id: string; riderId: string }[],
): Promise<Map<string, { handoverRerouteByName: string | null; doorProblem: { kind: string; at: Date } | null }>> {
  const out = new Map<string, { handoverRerouteByName: string | null; doorProblem: { kind: string; at: Date } | null }>()
  if (orders.length === 0) return out
  const riderOf = new Map(orders.map((o) => [o.id, o.riderId]))
  const events = await prisma.riderJobEvent.findMany({
    where: { orderId: { in: [...riderOf.keys()] }, type: { in: ['door_problem', 'code_rerouted'] } },
    orderBy: { createdAt: 'desc' },
    select: { orderId: true, riderId: true, type: true, note: true, createdAt: true, actorId: true },
  })
  const by = new Map<string, string | null>()
  const door = new Map<string, { kind: string; at: Date }>()
  for (const e of events) {
    if (e.type === 'code_rerouted' && !by.has(e.orderId)) by.set(e.orderId, e.actorId)
    if (e.type === 'door_problem' && !door.has(e.orderId) && e.riderId === riderOf.get(e.orderId)) {
      const kind = BOARD_DOOR_KINDS.find((k) => e.note === k || e.note?.startsWith(`${k}:`))
      if (kind) door.set(e.orderId, { kind, at: e.createdAt })
    }
  }
  const actorIds = [...new Set([...by.values()].filter((x): x is string => !!x))]
  const users = actorIds.length === 0 ? [] : await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } })
  const nameOf = new Map(users.map((u) => [u.id, u.name]))
  for (const id of riderOf.keys()) {
    const actor = by.get(id)
    out.set(id, {
      handoverRerouteByName: actor ? (nameOf.get(actor) ?? null) : null,
      doorProblem: door.get(id) ?? null,
    })
  }
  return out
}
