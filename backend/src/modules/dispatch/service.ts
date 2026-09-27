// Rider assignment and delivery — the one implementation.
//
// Every way a rider is put on, taken off or finishes an order comes through
// here: the /dispatch routes (admin /dispatch and /riders pages, tablet
// Dispatch screen) and the auto-dispatch worker. There used to be a second
// set of routes (/riders/assign, /riders/unassign) with different rules —
// one accepted offline riders, the other skipped the isActive check, one
// freed the rider and the other left them 'busy' forever — and the worker
// wrote the assignment itself with no company check at all, so it could hand
// one company's order to another company's rider.

import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { AppError, NotFoundError } from '../../lib/errors.js'

/** Order statuses in which an assigned rider still has the order to carry. */
export const RIDER_ACTIVE_STATUSES = ['received', 'confirmed', 'preparing', 'ready'] as const

type Tx = Prisma.TransactionClient

/**
 * Put `riderId` on the order. The rider must be active, not offline, and of
 * the ORDER's company (a head-office operator's scope spans several companies,
 * so "both in scope" is not enough). Marks the rider busy.
 */
export async function assignRider(orderId: string, riderId: string) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, deletedAt: null },
    select: { id: true, status: true, riderId: true, concept: { select: { tenantId: true } } },
  })
  if (!order) throw new NotFoundError('Order', orderId)
  const rider = await prisma.rider.findFirst({ where: { id: riderId, deletedAt: null } })
  if (!rider || !rider.isActive) throw new NotFoundError('Rider', riderId)
  if (rider.tenantId !== order.concept.tenantId) {
    throw new AppError('RIDER_NOT_IN_COMPANY', "Rider does not belong to the order's company", 422)
  }
  if (rider.status === 'offline') throw new AppError('RIDER_OFFLINE', 'Rider is offline', 422)
  // A completed order can still take a rider — a till-paid order can go out
  // for delivery, and the dispatcher may record the rider after the fact.
  if (['cancelled', 'rejected', 'refunded'].includes(order.status)) {
    throw new AppError('ORDER_NOT_ACTIVE', `Order is ${order.status} — there is nothing to deliver`, 409)
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.order.update({ where: { id: order.id }, data: { riderId: rider.id } })
    await tx.rider.update({ where: { id: rider.id }, data: { status: 'busy' } })
    // Re-assigning from another rider frees that one if this was their last.
    if (order.riderId && order.riderId !== rider.id) await releaseIfIdle(tx, order.riderId, order.id)
    return updated
  })
}

/** Take the rider off the order. The rider goes back to 'available' if this was their last active order. */
export async function unassignRider(orderId: string) {
  const order = await prisma.order.findFirst({ where: { id: orderId, deletedAt: null }, select: { id: true, riderId: true } })
  if (!order) throw new NotFoundError('Order', orderId)
  return prisma.$transaction(async (tx) => {
    const updated = await tx.order.update({ where: { id: order.id }, data: { riderId: null } })
    if (order.riderId) await releaseIfIdle(tx, order.riderId, order.id)
    return updated
  })
}

/**
 * The rider dropped the order off — decision 8: THIS is when a delivery is
 * complete (expo handing the bag to the rider is not). Two doors come here:
 * the dispatcher / rider pressing "Mark delivered"
 * (POST /dispatch/orders/:id/delivered) and the customer's OTP being verified
 * at the door (POST /trustops/orders/:id/verify-otp, `otpVerified`).
 *
 *   - The kitchen must have finished it: 'ready' (or already 'completed' — a
 *     till-paid order that went out with a rider); anything earlier is 409.
 *   - A 'ready' order is completed through the canonical updateOrderStatus →
 *     completeOrder (ledger, invoice, FBR/SRB, loyalty, rollups — once). It
 *     used to be written 'completed' directly, with none of that.
 *   - deliveredAt is stamped once (the claim): the rider's delivery is counted
 *     and the rider freed if it was their last active order. The order keeps
 *     its riderId, so it shows in the rider's history.
 *
 * A rider is required for "Mark delivered"; an OTP verified at the door
 * completes the order even when no rider was recorded on it.
 */
export async function markDelivered(
  orderId: string,
  opts: { otpVerified?: boolean; actor?: { id: string; email?: string | null; tenantId?: string | null } | null } = {},
) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, deletedAt: null },
    select: { id: true, status: true, riderId: true, deliveredAt: true },
  })
  if (!order) throw new NotFoundError('Order', orderId)
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
      where: { id: order.id, deliveredAt: null },
      data: { deliveredAt: now },
    })
    if (claimed.count === 0) return false
    if (riderId) {
      await tx.rider.update({ where: { id: riderId }, data: { totalDeliveries: { increment: 1 } } })
      await releaseIfIdle(tx, riderId, order.id)
    }
    return true
  })
  const fresh = await prisma.order.findUniqueOrThrow({ where: { id: order.id } })
  return { order: fresh, alreadyDelivered: !delivered }
}

/** Set the rider's own availability — the one writer (admin /dispatch, /riders, tablet). */
export async function setRiderStatus(riderId: string, status: 'available' | 'busy' | 'offline') {
  return prisma.rider.update({ where: { id: riderId }, data: { status } })
}

async function releaseIfIdle(tx: Tx, riderId: string, exceptOrderId: string): Promise<void> {
  const stillCarrying = await tx.order.count({
    where: {
      riderId,
      id: { not: exceptOrderId },
      deletedAt: null,
      deliveredAt: null,
      status: { in: [...RIDER_ACTIVE_STATUSES] },
    },
  })
  if (stillCarrying === 0) {
    // Only a busy rider is freed — an offline rider stays offline.
    await tx.rider.updateMany({ where: { id: riderId, status: 'busy' }, data: { status: 'available' } })
  }
}
