// The rider's own jobs (docs/rider-app.md). Everything here acts for ONE
// signed-in rider on orders with riderId = that rider — never by a client
// order id alone. Assigning, taking a rider off and completing a delivery go
// through dispatch/service.ts, the one set of rules the dispatcher and the
// auto-dispatcher use too.

import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { formatBrandName } from '../../lib/brandName.js'
import { flagException } from '../../lib/exceptions.js'
import { sendText } from '../../lib/whatsapp.js'
import { DELIVERY_OTP_MAX_ATTEMPTS, deliveryOtpMatches, generateDeliveryOtp } from '../../lib/deliveryOtp.js'
import { fleetMayCarry } from '../../lib/fleet.js'
import { normalisePhone } from '../auth/otp.js'
import {
  claimHandoverAttempt, markDelivered, recordJobEvent, releaseHandoverAttempt, riderOpenOrderWhere,
  setRiderStatus, takeRiderOff, withdrawOffer,
} from '../dispatch/service.js'
import { riderPublic, type RiderPublic, type SignedInRider } from '../riderAuth/service.js'

type Rider = Pick<SignedInRider, 'id' | 'tenantId'>
type Pos = { lat?: number | null; lng?: number | null }

/**
 * Orders still on the rider's hands — dispatch/service riderOpenOrderWhere,
 * the one definition (the guard's company scope, freeing a rider and the
 * location fan-out read it too).
 */
export function openJobWhere(riderId: string): Prisma.OrderWhereInput {
  return riderOpenOrderWhere(riderId)
}

const JOB_SELECT = {
  id: true, conceptId: true, status: true, placedAt: true, customerName: true, deliveryNotes: true, rawPayload: true,
  riderAssignedAt: true, riderAcceptedAt: true, pickedUpAt: true, arrivedAt: true, deliveredAt: true,
  deliveryOtp: true, deliveryOtpAttempts: true,
  concept: {
    select: {
      name: true, slug: true, phone: true, address: true, addressLocality: true, latitude: true, longitude: true,
      tenantId: true, tenant: { select: { id: true, name: true } },
    },
  },
  location: { select: { name: true, address: true, latitude: true, longitude: true, phone: true } },
  customer: { select: { name: true, phone: true } },
  items: { select: { name: true, quantity: true, status: true }, orderBy: { createdAt: 'asc' } },
  payments: { select: { method: true, status: true, amountCents: true } },
} satisfies Prisma.OrderSelect

type JobRow = Prisma.OrderGetPayload<{ select: typeof JOB_SELECT }>

export type JobStage = 'offered' | 'accepted' | 'picked_up' | 'arrived'

export interface Job {
  orderId: string
  orderNumber: string
  status: string
  stage: JobStage
  brand: { name: string; slug: string }
  company: { id: string | null; name: string | null }
  pickup: { name: string; address: string | null; lat: number | null; lng: number | null; phone: string | null }
  dropoff: { name: string | null; phone: string | null; address: string | null; lat: number | null; lng: number | null }
  itemCount: number
  items: Array<{ name: string; qty: number }>
  cashToCollectCents: number
  notes: string | null
  assignedAt: Date | null
  acceptedAt: Date | null
  pickedUpAt: Date | null
  arrivedAt: Date | null
  otpAttemptsLeft: number
}

export function jobStage(o: Pick<JobRow, 'riderAcceptedAt' | 'pickedUpAt' | 'arrivedAt'>): JobStage {
  if (o.arrivedAt) return 'arrived'
  if (o.pickedUpAt) return 'picked_up'
  if (o.riderAcceptedAt) return 'accepted'
  return 'offered'
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** The Job shape (docs/rider-app.md). Never carries the hand-over code. */
export function toJob(o: JobRow): Job {
  const raw = (o.rawPayload && typeof o.rawPayload === 'object' ? o.rawPayload : {}) as Record<string, unknown>
  const brandName = formatBrandName(o.concept.name)
  const loc = o.location
  const conceptAddress = [o.concept.address, o.concept.addressLocality].filter(Boolean).join(', ') || null
  const items = o.items.filter((i) => i.status !== 'voided').map((i) => ({ name: i.name, qty: i.quantity }))
  const cashToCollectCents = o.payments
    .filter((p) => p.method === 'cash' && p.status === 'pending')
    .reduce((sum, p) => sum + p.amountCents, 0)
  const notes = typeof raw['deliveryInstructions'] === 'string' ? (raw['deliveryInstructions'] as string) : null
  return {
    orderId: o.id,
    // The reference the customer sees in their messages (lib/notify.ts).
    orderNumber: o.id.slice(0, 8).toUpperCase(),
    status: o.status,
    stage: jobStage(o),
    brand: { name: brandName, slug: o.concept.slug },
    company: { id: o.concept.tenant?.id ?? o.concept.tenantId ?? null, name: o.concept.tenant?.name ?? null },
    pickup: {
      name: loc ? `${brandName} — ${loc.name}` : brandName,
      address: loc?.address ?? conceptAddress,
      lat: loc?.latitude ?? o.concept.latitude ?? null,
      lng: loc?.longitude ?? o.concept.longitude ?? null,
      phone: loc?.phone ?? o.concept.phone ?? null,
    },
    dropoff: {
      name: o.customer?.name ?? o.customerName ?? null,
      phone: o.customer?.phone ?? null,
      address: o.deliveryNotes ?? null,
      lat: num(raw['deliveryLat']),
      lng: num(raw['deliveryLng']),
    },
    itemCount: items.reduce((n, i) => n + i.qty, 0),
    items,
    cashToCollectCents,
    notes,
    assignedAt: o.riderAssignedAt,
    acceptedAt: o.riderAcceptedAt,
    pickedUpAt: o.pickedUpAt,
    arrivedAt: o.arrivedAt,
    otpAttemptsLeft: Math.max(0, DELIVERY_OTP_MAX_ATTEMPTS - o.deliveryOtpAttempts),
  }
}

export async function listJobs(riderId: string): Promise<Job[]> {
  const rows = await prisma.order.findMany({
    where: openJobWhere(riderId),
    select: JOB_SELECT,
    orderBy: [{ placedAt: 'asc' }],
    take: 50,
  })
  return rows.map(toJob)
}

async function loadJobRow(riderId: string, orderId: string): Promise<JobRow> {
  const row = await prisma.order.findFirst({ where: { id: orderId, ...openJobWhere(riderId) }, select: JOB_SELECT })
  if (!row) throw new NotFoundError('Job', orderId)
  return row
}

export async function getJob(riderId: string, orderId: string): Promise<Job> {
  return toJob(await loadJobRow(riderId, orderId))
}

function event(rider: Rider, row: JobRow, type: 'accepted' | 'picked_up' | 'arrived' | 'otp_failed', pos: Pos, note?: string) {
  return recordJobEvent({
    type, riderId: rider.id, orderId: row.id,
    tenantId: row.concept.tenantId, riderTenantId: rider.tenantId,
    lat: pos.lat, lng: pos.lng, note: note ?? null,
  })
}

// ─── Shift ───────────────────────────────────────────────────────────────────

/**
 * Going on shift is the rider's own action: online → 'available' ('busy' when
 * already carrying a job). Going off shift is refused while carrying an
 * accepted job; offers not yet accepted are handed back to dispatch.
 */
export async function setShift(rider: SignedInRider, online: boolean): Promise<RiderPublic> {
  if (online) {
    const carrying = await prisma.order.count({ where: openJobWhere(rider.id) })
    const updated = await setRiderStatus(rider.id, carrying > 0 ? 'busy' : 'available')
    return riderPublic({ ...rider, status: updated.status })
  }
  const acceptedJobs = () => prisma.order.count({ where: { ...openJobWhere(rider.id), riderAcceptedAt: { not: null } } })
  const refused = () => new AppError('ACTIVE_JOBS', 'Finish (or hand back) your accepted deliveries before going off shift.', 409)
  if ((await acceptedJobs()) > 0) throw refused()
  // Offline FIRST, then hand the offers back: the other way round, the
  // auto-dispatcher could offer a new job in between (assignRider never
  // offers to an offline rider). Handing back never frees an offline rider.
  let updated = await setRiderStatus(rider.id, 'offline')
  const offers = await prisma.order.findMany({
    where: { ...openJobWhere(rider.id), riderAcceptedAt: null },
    select: { id: true },
  })
  for (const o of offers) {
    await withdrawOffer(o.id, rider.id, { event: 'unassigned', note: 'rider went off shift' })
  }
  // An offer accepted (on another device) while this ran is now a job in hand:
  // stay on shift for it.
  if ((await acceptedJobs()) > 0) {
    updated = await setRiderStatus(rider.id, 'busy')
    throw refused()
  }
  return riderPublic({ ...rider, status: updated.status })
}

// ─── Job steps ───────────────────────────────────────────────────────────────

/**
 * offered → accepted. Accepting twice is not an error. An offer of another
 * company's order is only good while the fleet agreement that allowed it is
 * still active: once it has ended the offer is withdrawn here (an accepted job
 * is under way and is finished — decision 3 — but an offer is not).
 */
export async function acceptJob(rider: Rider, orderId: string, pos: Pos): Promise<Job> {
  const row = await loadJobRow(rider.id, orderId)
  if (row.riderAcceptedAt) return toJob(row)
  if (!(await fleetMayCarry(rider.tenantId, row.concept.tenantId))) {
    await takeRiderOff(row.id, {
      event: 'unassigned', note: 'fleet agreement ended', onlyIfRiderId: rider.id, onlyIfNotAccepted: true,
    })
    const company = row.concept.tenant?.name ?? 'that company'
    throw new AppError(
      'OFFER_WITHDRAWN',
      `Your fleet no longer delivers for ${company}, so this offer has been withdrawn.`,
      409,
    )
  }
  const res = await prisma.order.updateMany({
    where: { id: row.id, riderId: rider.id, riderAcceptedAt: null, deliveredAt: null },
    data: { riderAcceptedAt: new Date() },
  })
  if (res.count > 0) {
    await event(rider, row, 'accepted', pos)
    // On a job now, whatever the dispatcher last set.
    await prisma.rider.updateMany({ where: { id: rider.id, status: 'available' }, data: { status: 'busy' } })
  }
  return getJob(rider.id, row.id)
}

/**
 * The rider hands the job back (before pick-up). The order is unassigned with
 * a `declined` event, and the auto-dispatcher never offers it to this rider
 * again (workers/riderDispatch.ts).
 */
export async function declineJob(rider: Rider, orderId: string, opts: Pos & { reason?: string | null }): Promise<void> {
  const row = await loadJobRow(rider.id, orderId)
  if (row.pickedUpAt) {
    throw new AppError('ALREADY_PICKED_UP', 'You have this order already — take it back to the kitchen and ask the dispatcher to reassign it.', 409)
  }
  const r = await takeRiderOff(row.id, {
    event: 'declined', note: opts.reason ?? null, lat: opts.lat, lng: opts.lng,
    onlyIfRiderId: rider.id, onlyIfNotPickedUp: true,
  })
  if (!r.changed) {
    // Picked up (on another device) or taken off by the dispatcher meanwhile.
    if (r.order.riderId === rider.id && r.order.pickedUpAt) {
      throw new AppError('ALREADY_PICKED_UP', 'You have this order already — take it back to the kitchen and ask the dispatcher to reassign it.', 409)
    }
    throw new NotFoundError('Job', row.id)
  }
}

/**
 * accepted → picked up. The kitchen must have finished it ('ready', or a
 * till-paid order already 'completed'). The customer gets their hand-over code
 * on WhatsApp — best effort, never failing or slowing the request.
 */
export async function pickUpJob(rider: Rider, orderId: string, pos: Pos): Promise<Job> {
  const row = await loadJobRow(rider.id, orderId)
  if (row.pickedUpAt) return toJob(row)
  if (!row.riderAcceptedAt) throw new AppError('NOT_ACCEPTED', 'Accept the job before picking it up.', 409)
  if (row.status !== 'ready' && row.status !== 'completed') {
    throw new AppError('NOT_READY', `The order is ${row.status} — the kitchen has not finished it yet.`, 409)
  }
  // Every delivery needs a code at the door. An order that somehow has none
  // (placed before codes, or by a channel that did not issue one) gets one now.
  if (!row.deliveryOtp) {
    await prisma.order.updateMany({ where: { id: row.id, deliveryOtp: null }, data: { deliveryOtp: generateDeliveryOtp() } })
  }
  const res = await prisma.order.updateMany({
    where: { id: row.id, riderId: rider.id, pickedUpAt: null, deliveredAt: null },
    data: { pickedUpAt: new Date() },
  })
  if (res.count > 0) {
    await event(rider, row, 'picked_up', pos)
    void sendHandoverCode(row.id)
  }
  return getJob(rider.id, row.id)
}

/** picked up → at the door. */
export async function arriveJob(rider: Rider, orderId: string, pos: Pos): Promise<Job> {
  const row = await loadJobRow(rider.id, orderId)
  if (!row.pickedUpAt) throw new AppError('NOT_PICKED_UP', 'Pick the order up first.', 409)
  if (row.arrivedAt) return toJob(row)
  const res = await prisma.order.updateMany({
    where: { id: row.id, riderId: rider.id, arrivedAt: null, deliveredAt: null },
    data: { arrivedAt: new Date() },
  })
  if (res.count > 0) await event(rider, row, 'arrived', pos)
  return getJob(rider.id, row.id)
}

/** Thrown for a wrong hand-over code; the route sends `attemptsLeft` with it. */
export class OtpMismatchError extends AppError {
  constructor(public readonly attemptsLeft: number) {
    super(
      'OTP_MISMATCH',
      attemptsLeft > 0
        ? `That is not the customer's code. ${attemptsLeft} ${attemptsLeft === 1 ? 'try' : 'tries'} left.`
        : "That is not the customer's code, and there are no tries left. Call the dispatcher.",
      403,
      { attemptsLeft },
    )
  }
}

/**
 * The hand-over: the rider types the customer's code. Constant-time compare,
 * DELIVERY_OTP_MAX_ATTEMPTS tries in total — each try claims an attempt slot
 * BEFORE the compare, so concurrent guesses cannot get past the limit — and
 * then 423 OTP_LOCKED (a manager marks it delivered from admin → Dispatch).
 * The right code completes the order through markDelivered, exactly once.
 */
export async function deliverJob(rider: Rider, orderId: string, input: Pos & { otp: string }) {
  const done = await prisma.order.findFirst({
    where: { id: orderId, riderId: rider.id, deletedAt: null, deliveredAt: { not: null } },
    select: { id: true },
  })
  if (done) throw new AppError('ALREADY_DELIVERED', 'This order has already been delivered.', 409)
  const row = await loadJobRow(rider.id, orderId)
  if (!row.pickedUpAt) throw new AppError('NOT_PICKED_UP', 'Pick the order up first.', 409)
  if (!row.deliveryOtp) {
    throw new AppError('NO_OTP', 'This order has no hand-over code. Call the dispatcher to mark it delivered.', 409)
  }

  const slot = await claimHandoverAttempt(row.id, DELIVERY_OTP_MAX_ATTEMPTS, { riderId: rider.id })
  if (!slot.claimed) {
    throw new AppError(
      'OTP_LOCKED',
      'Too many wrong codes. The dispatcher has to mark this order delivered.',
      423,
    )
  }

  if (!deliveryOtpMatches(row.deliveryOtp, input.otp)) {
    const attempts = slot.attempts
    const attemptsLeft = Math.max(0, DELIVERY_OTP_MAX_ATTEMPTS - attempts)
    await event(rider, row, 'otp_failed', input, `attempt ${attempts}/${DELIVERY_OTP_MAX_ATTEMPTS}`)
    // Same threshold as the staff verify (trustops): three misses is a
    // possible lost package; the lock-out needs a manager either way.
    if (attempts === 3 || attemptsLeft === 0) {
      await flagException({
        tenantId: row.concept.tenantId,
        conceptId: row.conceptId,
        kind: 'lost_package',
        severity: 'high',
        title: attemptsLeft === 0
          ? `Hand-over locked on order ${row.id.slice(0, 8)} after ${attempts} wrong codes`
          : `OTP failed ${attempts} times on order ${row.id.slice(0, 8)}`,
        description: attemptsLeft === 0
          ? 'The rider entered the wrong hand-over code too many times and the order is locked. Confirm with the customer, then mark it delivered from Dispatch.'
          : 'The rider has entered the wrong hand-over code three times. Either the customer is disputing the delivery or the rider is at the wrong door. Check before it is marked delivered.',
        entityType: 'Order',
        entityId: row.id,
        actorId: null,
        metadata: { attempts, riderId: rider.id, riderTenantId: rider.tenantId },
      })
    }
    throw new OtpMismatchError(attemptsLeft)
  }

  // The right code: give the slot back — a clean hand-over is not a failed
  // attempt (nightly rider scoring counts deliveryOtpAttempts).
  await releaseHandoverAttempt(row.id)
  const r = await markDelivered(row.id, { otpVerified: true, actor: null, lat: input.lat, lng: input.lng })
  return { orderId: row.id, status: r.order.status, deliveredAt: r.order.deliveredAt, alreadyDelivered: r.alreadyDelivered }
}

// ─── The customer's code on WhatsApp ─────────────────────────────────────────

/** Best effort: never throws, never awaited by the request. */
export async function sendHandoverCode(orderId: string): Promise<void> {
  try {
    const o = await prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true, deliveryOtp: true,
        customer: { select: { phone: true } },
        concept: { select: { name: true } },
      },
    })
    const phone = o?.customer?.phone ? normalisePhone(o.customer.phone) : ''
    if (!o?.deliveryOtp || phone.length < 11) return
    const ref = o.id.slice(0, 8).toUpperCase()
    const brand = formatBrandName(o.concept.name)
    await sendText(
      phone,
      `Your ${brand} order ${ref} is on its way. When your rider arrives, give them this code: ${o.deliveryOtp}. `
      + 'Only share it once you have your order in hand.',
    )
  } catch (err) {
    console.warn(`[rider] hand-over code WhatsApp failed for order ${orderId.slice(0, 8)}: ${(err as Error).message}`)
  }
}
