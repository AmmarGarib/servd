// Reservation API.
//
// Status flow:
//   booked → confirmed → seated → completed
//                 ↓                  ↓
//              cancelled          no_show
//
// Conflict prevention:
//   When assigning a table, refuse if another booked/confirmed/seated
//   reservation overlaps the time window. Walk-ins (waitlist=true) skip
//   the overlap check by design — host can override.
//
// Notifications:
//   On create + on confirm, send SMS via existing notify lib if guestPhone.
//   Email confirmation via the same notify lib if guestEmail.

import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Prisma } from '@prisma/client'
import { randomBytes } from 'crypto'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS, ALL_STAFF } from '../auth/middleware.js'
import { assertConceptAccess } from '../../lib/conceptAccess.js'
import { assertConceptOwned, conceptWhere, scopeTenantWhere, type ScopeMode } from '../../lib/tenantScope.js'
import { audit } from '../../lib/audit.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { verifyCustomerToken } from '../auth/service.js'
import { normalisePhone } from '../auth/otp.js'
import { sendSms, sendEmail } from '../../lib/notify.js'
import { emitReservationEvent } from '../../lib/ws.js'
import { bumpCustomerRollups } from '../../lib/customerRollups.js'

const DEFAULT_DURATION_MIN = 90

// Public-booking caps, keyed on the guest's phone number. See the block in the
// POST /public handler for why these are per phone and not per IP.
//
// Six upcoming bookings is far past what any real guest holds at once and still
// leaves room for a family booking several occasions. Three an hour is more
// than enough to correct a mistake and retry.
const MAX_UPCOMING_PER_PHONE = 6
const MAX_BOOKINGS_PER_PHONE_PER_HOUR = 3

// ─── Company boundary ────────────────────────────────────────────────────────
// `assertConceptAccess` is a per-user brand whitelist that no-ops for every
// management role, so it is NOT a company check. Every handler below that
// takes a brand / table / customer id from the client also runs one of these,
// so a GS Foods operator can never read or touch a GSX Viva booking, table or
// guest — even by guessing an id.

/**
 * A table may only be attached to a reservation of its own brand. The brand
 * itself has already been resolved inside the operator's companies, so this
 * closes the "foreign tableId" hole on create / patch / seat. Same message
 * whether the table is foreign or missing — never confirms a foreign id.
 */
async function assertTableInConcept(tableId: string, conceptId: string): Promise<void> {
  const table = await prisma.table.findFirst({
    where: { id: tableId, conceptId, deletedAt: null },
    select: { id: true },
  })
  if (!table) throw new AppError('TABLE_NOT_IN_BRAND', 'Table does not belong to this brand', 422)
}

/**
 * Customers are global rows (no tenantId), so "mine" means the company has
 * actually served them: an order or a reservation in one of its brands. Same
 * rule the CRM module uses. 404 on a stranger's id.
 */
async function assertCustomerInScope(req: FastifyRequest, customerId: string, mode: ScopeMode): Promise<void> {
  const concept = { deletedAt: null, ...(await scopeTenantWhere(req, mode)) }
  const customer = await prisma.customer.findFirst({
    where: {
      id: customerId,
      deletedAt: null,
      OR: [
        { orders:       { some: { concept } } },
        { reservations: { some: { concept } } },
      ],
    },
    select: { id: true },
  })
  if (!customer) throw new NotFoundError('Customer', customerId)
}

/**
 * The querystring types below declare `conceptId` / `customerId` as required,
 * but nothing enforces that at runtime — and an `undefined` id falls through
 * Prisma as "no filter", which on a write would hit every brand's rows.
 */
function requireId(value: string | undefined, name: string): string {
  if (!value) throw new AppError('MISSING_ID', `${name} is required`, 400)
  return value
}

/**
 * Wraps a Prisma write that touches `reservations.tableId + startTime/endTime`.
 * The DB-level exclusion constraint `reservations_no_table_overlap` makes
 * double-booking *physically impossible* even under perfect concurrency: the
 * application-level pre-check is just a friendly fast-path. If two concurrent
 * inserts both pass the pre-check, postgres still rejects the loser with
 * sqlstate 23P01 (exclusion_violation), which Prisma surfaces as P2010.
 *
 * This helper catches that and turns it into a clean 409 instead of a 500.
 */
async function withTableOverlapGuard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    const e = err as { code?: string; meta?: { code?: string; message?: string } }
    const isExclusion =
      e?.code === 'P2010' && (e?.meta?.code === '23P01' || /reservations_no_table_overlap/i.test(e?.meta?.message ?? ''))
    if (isExclusion) {
      throw new AppError(
        'TABLE_CONFLICT',
        'Another reservation just claimed that table for the same time. Pick a different table or time.',
        409,
      )
    }
    throw err
  }
}

const createSchema = z.object({
  conceptId:  z.string().uuid(),
  tableId:    z.string().uuid().nullable().optional(),
  customerId: z.string().uuid().nullable().optional(),
  partySize:  z.number().int().min(1).max(50),
  startTime:  z.string().datetime(),
  durationMin: z.number().int().min(15).max(480).default(DEFAULT_DURATION_MIN),
  guestName:  z.string().min(1).max(120),
  guestPhone: z.string().min(7).max(20).nullable().optional(),
  guestEmail: z.string().email().nullable().optional(),
  notes:      z.string().max(500).nullable().optional(),
  isVip:      z.boolean().optional(),
  source:     z.enum(['staff', 'website', 'phone', 'walkin']).default('staff'),
  waitlist:   z.boolean().optional(),
})

async function checkTableConflict(
  tableId: string,
  startTime: Date,
  endTime: Date,
  excludeReservationId?: string,
): Promise<{ conflict: boolean; with?: { id: string; guestName: string; startTime: Date; endTime: Date } }> {
  const overlap = await prisma.reservation.findFirst({
    where: {
      tableId,
      status: { in: ['booked', 'confirmed', 'seated'] },
      ...(excludeReservationId && { id: { not: excludeReservationId } }),
      // Overlap: existing.start < new.end AND existing.end > new.start
      startTime: { lt: endTime },
      endTime:   { gt: startTime },
    },
    select: { id: true, guestName: true, startTime: true, endTime: true },
  })
  return overlap
    ? { conflict: true, with: overlap }
    : { conflict: false }
}

export async function reservationRoutes(fastify: FastifyInstance) {
  // List reservations — staff view, filtered by date / concept / status
  fastify.get<{ Querystring: { conceptId?: string; date?: string; status?: string } }>(
    '/',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const { conceptId, date, status } = req.query
      if (conceptId) await assertConceptAccess(req.staffUser!, conceptId)

      // Company boundary: a supplied brand must be one the operator can see
      // (404 otherwise); with none supplied, every brand in view — never
      // every company's bookings.
      const where: Prisma.ReservationWhereInput = { ...(await conceptWhere(req, conceptId, 'read')) }
      if (status)    where.status    = status as Prisma.ReservationWhereInput['status']
      if (date) {
        const start = new Date(`${date.slice(0,10)}T00:00:00+05:00`)   // PKT day
        const end   = new Date(start.getTime() + 86_400_000)
        where.startTime = { gte: start, lt: end }
      }

      return prisma.reservation.findMany({
        where,
        orderBy: { startTime: 'asc' },
        include: {
          table:    { select: { id: true, label: true, capacity: true, floorId: true } },
          customer: { select: { id: true, name: true, totalSpentCents: true, lastOrderAt: true } },
          concept:  { select: { id: true, name: true } },   // host-stand tablet shows the brand
        },
      })
    },
  )

  // Create reservation
  fastify.post('/', { preHandler: requireAuth(...ALL_STAFF) }, async (req, reply) => {
    const body = createSchema.parse(req.body)
    await assertConceptAccess(req.staffUser!, body.conceptId)
    // A new booking binds to a brand of the ACTIVE company only, and any
    // table it names must be that brand's own.
    await assertConceptOwned(req, body.conceptId, 'create')
    if (body.tableId) await assertTableInConcept(body.tableId, body.conceptId)

    const startTime = new Date(body.startTime)
    const endTime   = new Date(startTime.getTime() + body.durationMin * 60_000)

    if (body.tableId && !body.waitlist) {
      const c = await checkTableConflict(body.tableId, startTime, endTime)
      if (c.conflict) {
        throw new AppError(
          'TABLE_CONFLICT',
          `Table is already booked from ${c.with!.startTime.toISOString()} to ${c.with!.endTime.toISOString()} (${c.with!.guestName})`,
          409,
        )
      }
    }

    // Reservation policy enforcement — owner-controlled rules from /setup/reservation-policy.
    // Bypass if the booking is being created as a walk-in (assumed when source='walkin').
    if (body.source !== 'walkin') {
      const { getReservationPolicy, tenantForConcept } = await import('../../lib/setup-config.js')
      const policy = await getReservationPolicy(await tenantForConcept(body.conceptId))

      if (body.partySize > policy.maxPartySize) {
        throw new AppError('PARTY_TOO_LARGE', `Maximum party size is ${policy.maxPartySize}. Contact the venue for larger groups.`, 400)
      }

      const now = new Date()
      const hoursAhead = (startTime.getTime() - now.getTime()) / 3_600_000
      const daysAhead  = hoursAhead / 24

      if (hoursAhead < policy.minAdvanceHours) {
        throw new AppError('TOO_SOON', `Reservations must be made at least ${policy.minAdvanceHours} hours in advance.`, 400)
      }
      // Tier perks: silver/gold can book further out than the standard window.
      // Look up the customer's perks; bronze (or no customer) gets the default.
      let extraDays = 0
      if (body.customerId) {
        const { getCustomerPerks } = await import('../../lib/tierPerks.js')
        extraDays = (await getCustomerPerks(body.customerId)).priorityReservationDays
      }
      const effectiveMaxDays = policy.maxAdvanceDays + extraDays
      if (daysAhead > effectiveMaxDays) {
        throw new AppError(
          'TOO_FAR',
          extraDays > 0
            ? `Reservations cannot be made more than ${effectiveMaxDays} days ahead (your tier gets ${extraDays} bonus days).`
            : `Reservations cannot be made more than ${policy.maxAdvanceDays} days ahead.`,
          400,
        )
      }

      // Deposit requirement — flagged on the response so the caller can collect.
      // Actual payment capture happens in the gateway flow; we just attach the
      // expected amount on the reservation record (notes field for now).
      if (policy.depositRequiredAboveParty != null && body.partySize > policy.depositRequiredAboveParty && policy.depositCents > 0) {
        // Surface in notes so the host UI can prompt for collection on arrival.
        body.notes = (body.notes ? body.notes + ' · ' : '') + `Deposit required: PKR ${(policy.depositCents / 100).toFixed(0)} (party of ${body.partySize})`
      }
    } else if (body.source === 'walkin') {
      const { getReservationPolicy, tenantForConcept } = await import('../../lib/setup-config.js')
      const policy = await getReservationPolicy(await tenantForConcept(body.conceptId))
      if (!policy.walkInsAllowed) {
        throw new AppError('WALKINS_DISABLED', 'Walk-ins are currently not accepted. Please book in advance.', 400)
      }
    }

    // Auto-link to existing customer by phone or email if we have one
    // A customer id from another company is dropped (the phone/email match
    // below still finds the platform customer), never attached blindly.
    let customerId = body.customerId ?? null
    if (customerId) {
      const { customerIdsInScope } = await import('../crm/customerScope.js')
      if (!(await customerIdsInScope(req, [customerId], 'create')).has(customerId)) customerId = null
    }
    if (!customerId && (body.guestPhone || body.guestEmail)) {
      const match = await prisma.customer.findFirst({
        where: {
          deletedAt: null,
          OR: [
            ...(body.guestEmail ? [{ email: body.guestEmail.toLowerCase() }] : []),
            ...(body.guestPhone ? [{ phone: body.guestPhone }] : []),
          ],
        },
        select: { id: true },
      })
      if (match) customerId = match.id
    }

    const r = await withTableOverlapGuard(() =>
      prisma.reservation.create({
        data: {
          conceptId:  body.conceptId,
          tableId:    body.tableId ?? null,
          customerId,
          partySize:  body.partySize,
          startTime,
          endTime,
          guestName:  body.guestName,
          guestPhone: body.guestPhone ?? null,
          guestEmail: body.guestEmail ?? null,
          notes:      body.notes ?? null,
          isVip:      body.isVip ?? false,
          source:     body.source as never,
          waitlist:   body.waitlist ?? false,
          createdById: req.staffUser?.id ?? null,
        },
        include: {
          concept: { select: { name: true } },
          table:   { select: { id: true, label: true } },
        },
      }),
    )

    await audit({ category: 'identity',
      action: 'reservation.create',
      entity: 'Reservation',
      entityId: r.id,
      userId: req.staffUser?.id ?? null, tenantId: req.staffUser?.tenantId ?? null,
      userEmail: req.staffUser?.email ?? null,
      after: { partySize: r.partySize, startTime: r.startTime, status: r.status, guestName: r.guestName },
      metadata: { source: r.source, ip: req.ip },
    })

    emitReservationEvent('reservation:created', {
      reservationId: r.id,
      conceptId: r.conceptId,
      startTime: r.startTime.toISOString(),
      status: r.status,
    })

    // Best-effort confirmation
    const when = startTime.toLocaleString('en-GB', { timeZone: 'Asia/Karachi', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
    if (body.guestPhone) {
      void sendSms(body.guestPhone, `${r.concept.name}: reservation confirmed for ${body.partySize} on ${when} PKT. Reply CANCEL to cancel.`)
        .catch((err) => req.log.error({ err: (err as Error).message }, 'reservation SMS failed'))
    }
    if (body.guestEmail) {
      const html = `<p>Hi ${body.guestName},</p>
        <p>Your table for ${body.partySize} at <strong>${r.concept.name}</strong> is booked for <strong>${when} PKT</strong>.</p>
        ${body.notes ? `<p><em>Notes:</em> ${body.notes}</p>` : ''}
        <p>If you need to cancel, reply to this email or call us.</p>
        <p>— ${r.concept.name}</p>`
      void sendEmail(body.guestEmail, `${r.concept.name} reservation confirmed`, html)
        .catch((err) => req.log.error({ err: (err as Error).message }, 'reservation email failed'))
    }

    return reply.status(201).send(r)
  })

  // Patch — change time, party size, table, etc. Re-runs conflict check.
  fastify.patch<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const body = createSchema.partial().parse(req.body)
      const r = await prisma.reservation.findFirst({ where: { id: req.params.id, concept: { tenantId: req.staffUser!.tenantFilter, deletedAt: null } } })
      if (!r) throw new NotFoundError('Reservation', req.params.id)
      await assertConceptAccess(req.staffUser!, r.conceptId)
      // Reseating may only target a table of the booking's own brand.
      if (body.tableId) await assertTableInConcept(body.tableId, r.conceptId)

      const startTime = body.startTime ? new Date(body.startTime) : r.startTime
      const endTime   = body.durationMin
        ? new Date(startTime.getTime() + body.durationMin * 60_000)
        : (body.startTime ? new Date(startTime.getTime() + (r.endTime.getTime() - r.startTime.getTime())) : r.endTime)
      const tableId   = body.tableId === undefined ? r.tableId : body.tableId

      if (tableId && !(body.waitlist ?? r.waitlist)) {
        const c = await checkTableConflict(tableId, startTime, endTime, r.id)
        if (c.conflict) {
          throw new AppError(
            'TABLE_CONFLICT',
            `Table is already booked from ${c.with!.startTime.toISOString()} to ${c.with!.endTime.toISOString()} (${c.with!.guestName})`,
            409,
          )
        }
      }

      const updated = await withTableOverlapGuard(() =>
        prisma.reservation.update({
          where: { id: r.id },
          data: {
            ...(body.partySize  !== undefined && { partySize:  body.partySize }),
            ...(body.guestName  !== undefined && { guestName:  body.guestName }),
            ...(body.guestPhone !== undefined && { guestPhone: body.guestPhone }),
            ...(body.guestEmail !== undefined && { guestEmail: body.guestEmail }),
            ...(body.notes      !== undefined && { notes:      body.notes }),
            ...(body.isVip      !== undefined && { isVip:      body.isVip }),
            ...(body.waitlist   !== undefined && { waitlist:   body.waitlist }),
            ...(body.startTime  !== undefined && { startTime,  endTime }),
            tableId,
          },
        }),
      )
      emitReservationEvent('reservation:updated', {
        reservationId: updated.id,
        conceptId: updated.conceptId,
        startTime: updated.startTime.toISOString(),
        status: updated.status,
      })
      return updated
    },
  )

  // Status transitions: confirm / seat / complete / no-show / cancel
  fastify.post<{ Params: { id: string }; Body: { reason?: string; tableId?: string } }>(
    '/:id/confirm',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => transition(req.params.id, 'confirmed', req),
  )
  fastify.post<{ Params: { id: string }; Body: { tableId?: string } }>(
    '/:id/seat',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const r = await prisma.reservation.findFirst({ where: { id: req.params.id, concept: { tenantId: req.staffUser!.tenantFilter, deletedAt: null } } })
      if (!r) throw new NotFoundError('Reservation', req.params.id)
      await assertConceptAccess(req.staffUser!, r.conceptId)
      const body = z.object({ tableId: z.string().uuid().optional() }).parse(req.body)
      // Only a table of the booking's own brand may be flipped to 'seated'.
      if (body.tableId) await assertTableInConcept(body.tableId, r.conceptId)
      const tableId = body.tableId ?? r.tableId
      if (!tableId) throw new AppError('TABLE_REQUIRED', 'Cannot seat without a table assignment', 422)

      const overlap = await checkTableConflict(tableId, r.startTime, r.endTime, r.id)
      if (overlap.conflict) {
        throw new AppError('TABLE_CONFLICT', `Table is occupied (${overlap.with!.guestName})`, 409)
      }

      const seated = await withTableOverlapGuard(() =>
        prisma.$transaction(async (tx) => {
          const updated = await tx.reservation.update({
            where: { id: r.id },
            data: { status: 'seated', seatedAt: new Date(), tableId, waitlist: false },
          })
          await tx.table.update({ where: { id: tableId }, data: { status: 'seated' } })
          return updated
        }),
      )
      emitReservationEvent('reservation:seated', {
        reservationId: seated.id, conceptId: seated.conceptId,
        startTime: seated.startTime.toISOString(), status: seated.status,
      })
      bumpCustomerRollups(seated.customerId)
      return seated
    },
  )
  fastify.post<{ Params: { id: string } }>(
    '/:id/complete',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const r = await prisma.reservation.findFirst({ where: { id: req.params.id, concept: { tenantId: req.staffUser!.tenantFilter, deletedAt: null } } })
      if (!r) throw new NotFoundError('Reservation', req.params.id)
      await assertConceptAccess(req.staffUser!, r.conceptId)

      // Completing is a one-way step. There was no status check, so calling
      // this again re-ran the whole block — including the flat 100-point
      // loyalty bonus below, which any staff member could therefore mint in a
      // loop against any customer. Answer idempotently rather than erroring:
      // a host double-tapping "complete" has done nothing wrong.
      if (r.status === 'completed') return r
      if (r.status === 'cancelled' || r.status === 'no_show') {
        throw new AppError('RESERVATION_CLOSED', `This reservation is already marked ${r.status}.`, 422)
      }

      const completed = await prisma.$transaction(async (tx) => {
        // Claim the transition conditionally so two simultaneous completes
        // can't both award the bonus.
        const claimed = await tx.reservation.updateMany({
          where: { id: r.id, status: { not: 'completed' } },
          data: { status: 'completed', completedAt: new Date() },
        })
        if (claimed.count === 0) {
          throw new AppError('ALREADY_COMPLETED', 'This reservation was just completed.', 409)
        }
        const updated = await tx.reservation.findUniqueOrThrow({ where: { id: r.id } })
        if (r.tableId) {
          await tx.table.update({ where: { id: r.tableId }, data: { status: 'cleaning' } })
        }
        // Cross-module: completing a reservation earns the customer a flat
        // 100 loyalty points. Distinct from order-driven points (which scale
        // with spend). This is a "thank you for showing up" gesture and a
        // hook into the same loyalty currency.
        if (r.customerId) {
          const account = await tx.loyaltyAccount.findUnique({ where: { customerId: r.customerId } })
          if (account) {
            const RES_BONUS = 100
            await tx.loyaltyAccount.update({
              where: { id: account.id },
              data: {
                pointsBalance:  { increment: RES_BONUS },
                lifetimePoints: { increment: RES_BONUS },
              },
            })
            await tx.loyaltyTransaction.create({
              data: {
                loyaltyAccountId: account.id,
                type: 'earn',
                pointsDelta: RES_BONUS,
                description: `Completed reservation at ${r.conceptId}`,
              },
            })
          }
        }
        return updated
      })
      emitReservationEvent('reservation:updated', {
        reservationId: completed.id, conceptId: completed.conceptId,
        startTime: completed.startTime.toISOString(), status: completed.status,
      })
      return completed
    },
  )
  fastify.post<{ Params: { id: string }; Body: { reason?: string } }>(
    '/:id/cancel',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const r = await prisma.reservation.findFirst({ where: { id: req.params.id, concept: { tenantId: req.staffUser!.tenantFilter, deletedAt: null } } })
      if (!r) throw new NotFoundError('Reservation', req.params.id)
      await assertConceptAccess(req.staffUser!, r.conceptId)
      const body = z.object({ reason: z.string().max(300).optional() }).parse(req.body ?? {})
      const updated = await prisma.reservation.update({
        where: { id: r.id },
        data: { status: 'cancelled', cancelledAt: new Date(), cancelReason: body.reason ?? null },
      })
      await audit({ category: 'identity',
        action: 'reservation.cancel',
        entity: 'Reservation',
        entityId: r.id,
        userId: req.staffUser?.id ?? null, tenantId: req.staffUser?.tenantId ?? null,
        userEmail: req.staffUser?.email ?? null,
        before: { status: r.status, tableId: r.tableId },
        after:  { status: 'cancelled' },
        metadata: { reason: body.reason },
      })
      emitReservationEvent('reservation:cancelled', {
        reservationId: updated.id, conceptId: updated.conceptId,
        startTime: updated.startTime.toISOString(), status: updated.status,
      })
      // A cancellation may free a table — fire the waitlist promoter.
      // Lazy-imported to avoid a circular dep at module init.
      void (async () => {
        const { tryPromoteWaitlist } = await import('./waitlistPromotion.js')
        tryPromoteWaitlist(r).catch((err) => req.log.warn(
          { err: (err as Error).message }, 'waitlist promotion attempt failed',
        ))
      })()
      return updated
    },
  )
  fastify.post<{ Params: { id: string } }>(
    '/:id/no-show',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => transition(req.params.id, 'no_show', req),
  )

  // Waitlist sidebar — booked-status reservations without a table assignment
  fastify.get<{ Querystring: { conceptId: string } }>(
    '/waitlist',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      await assertConceptAccess(req.staffUser!, req.query.conceptId)
      // Company boundary: foreign brand → 404; absent → every brand in view.
      const scope = await conceptWhere(req, req.query.conceptId, 'read')
      const today = new Date(); today.setHours(0, 0, 0, 0)
      const tomorrow = new Date(today.getTime() + 86_400_000)
      return prisma.reservation.findMany({
        where: {
          ...scope,
          status: { in: ['booked', 'confirmed'] },
          OR: [
            { tableId: null },
            { waitlist: true },
          ],
          startTime: { gte: today, lt: tomorrow },
        },
        orderBy: { startTime: 'asc' },
        select: {
          id: true, partySize: true, startTime: true, guestName: true, guestPhone: true,
          notes: true, isVip: true, status: true, waitlist: true,
        },
      })
    },
  )

  // ─── Kitchen tracker — upcoming arrivals by quarter-hour bucket ────────
  // Powers the kitchen / KDS reservation widget. Returns the next N hours of
  // booked/confirmed reservations grouped by 15-min arrival buckets so the
  // line cooks can see "we have 3 parties hitting at 7:30 = 12 covers" at a
  // glance. Includes special notes (allergies/occasions) flagged on the row.
  //
  // Auth: any staff role — kitchen needs visibility too.
  fastify.get<{ Querystring: { conceptId?: string; hours?: string } }>(
    '/kitchen-tracker',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const conceptId = req.query.conceptId
      const horizonH = Math.min(12, Math.max(1, parseInt(req.query.hours ?? '4', 10)))
      if (conceptId) await assertConceptAccess(req.staffUser!, conceptId)

      const now = new Date()
      const horizon = new Date(now.getTime() + horizonH * 3_600_000)

      // The KDS widget calls this without a conceptId — scope to every brand
      // in view rather than every company's arrivals; a foreign id is a 404.
      const scope = await conceptWhere(req, conceptId, 'read')

      const rows = await prisma.reservation.findMany({
        where: {
          ...scope,
          status: { in: ['booked', 'confirmed', 'seated'] },
          startTime: { gte: now, lt: horizon },
        },
        orderBy: { startTime: 'asc' },
        select: {
          id: true,
          partySize: true,
          startTime: true,
          guestName: true,
          notes: true,
          isVip: true,
          status: true,
          source: true,
          table: { select: { id: true, label: true } },
          concept: { select: { id: true, name: true } },
        },
      })

      // Bucket arrivals into 15-min slots so the kitchen sees pacing.
      // Key = ISO at the floor of the quarter-hour.
      const buckets = new Map<string, {
        slot: string
        slotLabel: string
        parties: number
        covers: number
        vip: number
        hasNotes: boolean
        rows: typeof rows
      }>()
      for (const r of rows) {
        const t = r.startTime
        const minute = Math.floor(t.getMinutes() / 15) * 15
        const slotDate = new Date(t)
        slotDate.setMinutes(minute, 0, 0)
        const slot = slotDate.toISOString()
        const slotLabel = slotDate.toLocaleString('en-GB', {
          timeZone: 'Asia/Karachi',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        })
        const b = buckets.get(slot) ?? {
          slot,
          slotLabel,
          parties: 0,
          covers: 0,
          vip: 0,
          hasNotes: false,
          rows: [] as typeof rows,
        }
        b.parties += 1
        b.covers += r.partySize
        if (r.isVip) b.vip += 1
        if (r.notes && r.notes.trim().length > 0) b.hasNotes = true
        b.rows.push(r)
        buckets.set(slot, b)
      }

      const sortedBuckets = [...buckets.values()].sort((a, b) => a.slot.localeCompare(b.slot))
      const totalCovers   = rows.reduce((s, r) => s + r.partySize, 0)
      const totalParties  = rows.length

      return {
        now: now.toISOString(),
        horizonH,
        totalParties,
        totalCovers,
        buckets: sortedBuckets,
      }
    },
  )

  // ─── Analytics — covers, occupancy, no-show rate, repeat-guest ratio ───
  fastify.get<{ Querystring: { conceptId: string; from: string; to: string } }>(
    '/analytics',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      await assertConceptAccess(req.staffUser!, req.query.conceptId)
      // Company boundary for both the bookings and the table count below.
      const scope = await conceptWhere(req, req.query.conceptId, 'read')
      const from = new Date(req.query.from)
      const to   = new Date(req.query.to)
      const all = await prisma.reservation.findMany({
        where: { ...scope, startTime: { gte: from, lte: to } },
        select: { id: true, status: true, partySize: true, startTime: true, customerId: true, source: true },
      })
      const bookedOrAfter = all.filter((r) => !['cancelled'].includes(r.status))
      const completed = all.filter((r) => r.status === 'completed' || r.status === 'seated')
      const noShow    = all.filter((r) => r.status === 'no_show')
      const covers    = completed.reduce((s, r) => s + r.partySize, 0)

      const tableCount = await prisma.table.count({ where: { ...scope, deletedAt: null } })
      const days = Math.max(1, Math.ceil((to.getTime() - from.getTime()) / 86_400_000))
      // Naive: assume 4 turn-cycles per day per table (lunch + dinner × 2 seatings).
      // Replace with real seat-time tracking once the data exists.
      const seatCapacity = tableCount * 4 * days
      const occupancyPct = seatCapacity > 0 ? (completed.length / seatCapacity) * 100 : 0

      const customerCounts = new Map<string, number>()
      for (const r of all) {
        if (!r.customerId) continue
        customerCounts.set(r.customerId, (customerCounts.get(r.customerId) ?? 0) + 1)
      }
      const repeatGuests = Array.from(customerCounts.values()).filter((c) => c > 1).length
      const totalGuests  = customerCounts.size

      const bySource: Record<string, number> = {}
      for (const r of all) bySource[r.source] = (bySource[r.source] ?? 0) + 1

      return {
        period: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
        totals: {
          bookings: bookedOrAfter.length,
          completed: completed.length,
          noShow: noShow.length,
          cancelled: all.length - bookedOrAfter.length,
          covers,
        },
        rates: {
          noShowPct:   bookedOrAfter.length > 0 ? Number(((noShow.length / bookedOrAfter.length) * 100).toFixed(1)) : 0,
          completePct: bookedOrAfter.length > 0 ? Number(((completed.length / bookedOrAfter.length) * 100).toFixed(1)) : 0,
          occupancyPct: Number(occupancyPct.toFixed(1)),
          repeatGuestPct: totalGuests > 0 ? Number(((repeatGuests / totalGuests) * 100).toFixed(1)) : 0,
        },
        bySource,
      }
    },
  )

  // ─── Public availability search ─────────────────────────────────────────
  // Used by the storefront booking widget. No auth.
  // Returns time slots within service hours for a given date + party size,
  // each marked available / unavailable based on table inventory.
  fastify.get<{ Querystring: { conceptSlug: string; date: string; partySize: string } }>(
    '/availability',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req) => {
      const partySize = parseInt(req.query.partySize, 10)
      if (!partySize || partySize < 1 || partySize > 50) {
        throw new AppError('BAD_PARTY', 'partySize must be 1..50', 400)
      }
      const concept = await prisma.concept.findFirst({
        where: { slug: req.query.conceptSlug, isActive: true, deletedAt: null },
        select: { id: true, name: true, type: true, reservationsEnabled: true, tenantId: true },
      })
      if (!concept) throw new NotFoundError('Concept', req.query.conceptSlug)
      if (!concept.reservationsEnabled) {
        throw new AppError(
          'RESERVATIONS_DISABLED',
          `${concept.name} isn't accepting reservations right now.`,
          403,
        )
      }

      // Day in PKT
      const day = new Date(`${req.query.date.slice(0, 10)}T00:00:00+05:00`)
      const dow = day.getUTCDay()
      const dayEnd = new Date(day.getTime() + 86_400_000)

      // Service hours for this day-of-week. Fallback: a default 11:00–23:00 window
      // if nothing's configured yet.
      const hours = await prisma.serviceHours.findMany({
        where: { conceptId: concept.id, dayOfWeek: dow, isReservable: true },
        orderBy: { openMin: 'asc' },
      })
      const windows = hours.length > 0
        ? hours.map((h) => ({ openMin: h.openMin, closeMin: h.closeMin }))
        : [{ openMin: 11 * 60, closeMin: 23 * 60 }]

      // Pull operator-configured time parameters from ReservationPolicy.
      // The restaurant sets these on /configuration/reservation-policy.
      const { getReservationPolicy } = await import('../../lib/setup-config.js')
      const policy = await getReservationPolicy(concept.tenantId)
      const slotIntervalMin    = policy?.slotIntervalMin    ?? 30
      const defaultDurationMin = policy?.defaultDurationMin ?? 90

      // Generate slots at the configured interval. Last possible slot must
      // fit a full sitting before the close time.
      const candidateSlots: Date[] = []
      for (const w of windows) {
        for (let m = w.openMin; m + defaultDurationMin <= w.closeMin; m += slotIntervalMin) {
          candidateSlots.push(new Date(day.getTime() + m * 60_000))
        }
      }

      // Pull capacity once: tables that fit the party
      const tables = await prisma.table.findMany({
        where: { conceptId: concept.id, deletedAt: null, capacity: { gte: partySize } },
        select: { id: true, capacity: true },
      })

      // Pull active blockouts overlapping the day
      const blockouts = await prisma.conceptBlockout.findMany({
        where: { conceptId: concept.id, startTime: { lt: dayEnd }, endTime: { gt: day } },
        select: { startTime: true, endTime: true, kind: true },
      })

      // Pull existing reservations for the day (for table-occupancy math)
      const existingRes = await prisma.reservation.findMany({
        where: {
          conceptId: concept.id,
          status: { in: ['booked', 'confirmed', 'seated'] },
          startTime: { lt: dayEnd },
          endTime:   { gt: day },
        },
        select: { startTime: true, endTime: true, tableId: true },
      })

      const slotDuration = defaultDurationMin * 60_000
      const slots = candidateSlots.map((s) => {
        const e = new Date(s.getTime() + slotDuration)
        // Closed by blockout?
        const blocked = blockouts.find((b) => b.startTime < e && b.endTime > s && b.kind === 'closure')
        if (blocked) return { time: s.toISOString(), available: false, reason: 'closed' }
        // Capacity: count tables whose schedule has room for this slot
        const fitting = tables.filter((t) => {
          const taken = existingRes.find((r) =>
            r.tableId === t.id && r.startTime < e && r.endTime > s,
          )
          return !taken
        })
        return {
          time: s.toISOString(),
          available: fitting.length > 0,
          tablesAvailable: fitting.length,
        }
      })

      // Daypart grouping comes from policy.dayparts. Storefront uses these
      // to bucket slots under labelled headings (Lunch / Dinner / etc.).
      // Schema is JSON in the DB; we shape it defensively.
      const dayparts: Array<{ label: string; startHour: number; endHour: number }> =
        Array.isArray(policy?.dayparts)
          ? (policy.dayparts as Array<{ label: string; startHour: number; endHour: number }>)
          : []

      return {
        concept: { id: concept.id, name: concept.name, slug: req.query.conceptSlug, type: concept.type },
        date: req.query.date.slice(0, 10),
        partySize,
        slotIntervalMin,
        defaultDurationMin,
        dayparts,
        slots,
      }
    },
  )

  // ─── Public booking (no staff auth — guest creates a booking) ───────────
  fastify.post(
    '/public',
    { config: { rateLimit: { max: 5, timeWindow: '5 minutes' } } },
    async (req, reply) => {
      const body = z.object({
        conceptSlug: z.string().min(1),
        partySize:   z.number().int().min(1).max(20),
        startTime:   z.string().datetime(),
        // Optional — defaults to whatever the operator set on
        // ReservationPolicy.defaultDurationMin. The storefront shouldn't
        // hardcode a number.
        durationMin: z.number().int().min(30).max(240).optional(),
        guestName:   z.string().min(1).max(120),
        guestPhone:  z.string().min(7).max(20),
        guestEmail:  z.string().email().nullable().optional(),
        notes:       z.string().max(500).nullable().optional(),
      }).parse(req.body)

      const concept = await prisma.concept.findFirst({
        where: { slug: body.conceptSlug, isActive: true, deletedAt: null },
      })
      if (!concept) throw new NotFoundError('Concept', body.conceptSlug)
      if (!concept.reservationsEnabled) {
        throw new AppError(
          'RESERVATIONS_DISABLED',
          `${concept.name} isn't accepting reservations right now.`,
          403,
        )
      }

      // Naughty-list gate. Reject the booking outright if the guest's
      // phone or email matches an active ban — they get the same clean
      // 403 a banned signup gets.
      const { assertNotBanned } = await import('../../lib/banCheck.js')
      await assertNotBanned({
        email: body.guestEmail ?? null,
        phone: body.guestPhone,
        ip:    req.ip ?? null,
        intent: 'reservation',
      })

      const { getReservationPolicy: getPolicyForBook } = await import('../../lib/setup-config.js')
      const bookPolicy = await getPolicyForBook(concept.tenantId)
      const durationMin = body.durationMin ?? bookPolicy?.defaultDurationMin ?? DEFAULT_DURATION_MIN

      const startTime = new Date(body.startTime)
      const endTime   = new Date(startTime.getTime() + durationMin * 60_000)

      // ─── The operator's booking rules apply to the public widget too ───────
      //
      // These were enforced on the staff route and NOT here, so the public form
      // was the way around every rule the restaurant had set: a party of 20 at
      // a venue capped at 8, a table held sixteen months out, a booking for a
      // date in 1990. The rules are the operator's, and the person most likely
      // to ignore them is the one not standing in the restaurant.
      const maxParty = bookPolicy?.maxPartySize ?? 20
      if (body.partySize > maxParty) {
        throw new AppError(
          'PARTY_TOO_LARGE',
          `Maximum party size is ${maxParty}. Please call us for larger groups.`,
          400,
        )
      }

      const hoursAhead = (startTime.getTime() - Date.now()) / 3_600_000
      const minAdvanceHours = bookPolicy?.minAdvanceHours ?? 2
      const maxAdvanceDays  = bookPolicy?.maxAdvanceDays ?? 60
      if (hoursAhead < minAdvanceHours) {
        throw new AppError(
          'TOO_SOON',
          hoursAhead < 0
            ? 'That time has already passed.'
            : `Reservations must be made at least ${minAdvanceHours} hours in advance.`,
          400,
        )
      }
      if (hoursAhead / 24 > maxAdvanceDays) {
        throw new AppError('TOO_FAR', `Reservations cannot be made more than ${maxAdvanceDays} days ahead.`, 400)
      }

      // ─── Per-phone limits ─────────────────────────────────────────────────
      //
      // The route's rate limit is per IP, which bounds nothing that matters
      // here. Two things it does not stop:
      //
      //   Slot squatting. One phone number can hold every table on the book;
      //   no confirmation is required for the reservation to occupy a slot.
      //
      //   SMS bombing. Every booking fires an SMS to a phone number the caller
      //   chose, on the operator's Twilio account. Without a per-number cap
      //   this endpoint is a free SMS relay pointed at any number in Pakistan,
      //   billed to GS Foods — and the target need never have heard of us.
      //
      // Both are bounded per phone rather than per IP, because the phone is the
      // thing being protected and the thing being spent.
      // One phone key (auth/otp normalisePhone). The cap matches the number as
      // typed OR any stored spelling ending in the same ten digits, so 0300…,
      // +92300… and 92300… share one allowance.
      const phoneKey = normalisePhone(body.guestPhone)
      const samePhone: Prisma.ReservationWhereInput = phoneKey.length >= 10
        ? { OR: [{ guestPhone: body.guestPhone }, { guestPhone: { endsWith: phoneKey.slice(-10) } }] }
        : { guestPhone: body.guestPhone }
      const [upcomingForPhone, recentForPhone] = await Promise.all([
        prisma.reservation.count({
          where: {
            ...samePhone,
            startTime: { gte: new Date() },
            status: { in: ['booked', 'confirmed'] },
          },
        }),
        prisma.reservation.count({
          where: {
            ...samePhone,
            createdAt: { gte: new Date(Date.now() - 3_600_000) },
          },
        }),
      ])
      if (upcomingForPhone >= MAX_UPCOMING_PER_PHONE) {
        throw new AppError(
          'TOO_MANY_BOOKINGS',
          `This number already has ${upcomingForPhone} upcoming reservations. Cancel one before booking another, or call us.`,
          429,
        )
      }
      if (recentForPhone >= MAX_BOOKINGS_PER_PHONE_PER_HOUR) {
        req.log.warn({ phoneTail: phoneKey.slice(-4) }, 'public booking: per-phone hourly cap hit')
        throw new AppError(
          'TOO_MANY_BOOKINGS',
          'Too many booking attempts for this number. Please try again later or call us.',
          429,
        )
      }

      // Refuse bookings into closures
      const closure = await prisma.conceptBlockout.findFirst({
        where: {
          conceptId: concept.id,
          kind: 'closure',
          startTime: { lt: endTime },
          endTime:   { gt: startTime },
        },
      })
      if (closure) throw new AppError('CLOSED', 'We are closed for this time slot', 409)

      // Link to a customer account ONLY when the caller has proved they are
      // that customer.
      //
      // This route is unauthenticated, and it used to attach the booking to
      // whichever account matched the typed phone or email — neither of which
      // anybody had verified. So knowing a regular's mobile number was enough
      // to book in their name, not turn up, and have the no-show recorded
      // against their real account: recomputeCustomerRollups bumps noShowCount,
      // which is what the naughty list and blacklisting read. You could strike
      // a customer out of their own restaurant from a phone box. It also hung a
      // stranger's booking, with its notes, off their visit history.
      //
      // A booking with no linked account still works perfectly — guestName,
      // guestPhone and guestEmail are stored on the row and are what the host
      // stand actually reads.
      let customerId: string | null = null
      const bearer = req.headers.authorization
      if (bearer?.startsWith('Bearer ')) {
        try {
          const payload = verifyCustomerToken(bearer.slice(7))
          const self = await prisma.customer.findFirst({
            where: { id: payload.sub, deletedAt: null },
            select: { id: true, phone: true, email: true },
          })
          // Only link to the signed-in account, and only if the booking is
          // actually in that person's own contact details.
          const typedEmail = body.guestEmail?.toLowerCase() ?? null
          if (
            self &&
            ((typedEmail && self.email?.toLowerCase() === typedEmail) ||
             (self.phone && self.phone === body.guestPhone))
          ) {
            customerId = self.id
          }
        } catch {
          // Not a valid customer token — book as a guest.
        }
      }

      // Generate confirmation token — CSPRNG, not Math.random (xorshift128+
      // state is recoverable from a single 32-char emission, which would let
      // an attacker predict and cancel any subsequent guest's reservation).
      const confirmToken = randomBytes(16).toString('hex')

      const r = await withTableOverlapGuard(() =>
        prisma.reservation.create({
          data: {
            conceptId:  concept.id,
            customerId,
            partySize:  body.partySize,
            startTime, endTime,
            guestName:  body.guestName,
            guestPhone: body.guestPhone,
            guestEmail: body.guestEmail ?? null,
            notes:      body.notes ?? null,
            source:     'website',
            status:     'booked',
            confirmToken,
            // Public bookings start without a table assignment — host assigns.
            waitlist: false,
          },
          include: { concept: { select: { name: true } } },
        }),
      )

      const storefrontUrl = process.env['STOREFRONT_URL'] ?? 'https://order.servd.pk'
      const confirmUrl = `${storefrontUrl}/reserve/confirm/${confirmToken}`
      const when = startTime.toLocaleString('en-GB', { timeZone: 'Asia/Karachi', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

      void sendSms(body.guestPhone, `${r.concept.name}: reservation request received for ${body.partySize} on ${when} PKT. Confirm/cancel: ${confirmUrl}`)
        .catch((err) => req.log.error({ err: (err as Error).message }, 'public booking SMS failed'))
      if (body.guestEmail) {
        const html = `<p>Hi ${body.guestName},</p>
          <p>Your reservation at <strong>${r.concept.name}</strong> for <strong>${body.partySize} on ${when} PKT</strong> is pending confirmation.</p>
          <p><a href="${confirmUrl}" style="background:#22c55e;color:#000;padding:10px 20px;border-radius:999px;text-decoration:none;font-weight:bold">Confirm or cancel</a></p>
          <p>You'll get a reminder 24 hours and 2 hours before your booking.</p>`
        void sendEmail(body.guestEmail, `${r.concept.name} — confirm your reservation`, html)
          .catch((err) => req.log.error({ err: (err as Error).message }, 'public booking email failed'))
      }

      emitReservationEvent('reservation:created', {
        reservationId: r.id, conceptId: r.conceptId,
        startTime: r.startTime.toISOString(), status: r.status,
      })

      return reply.status(201).send({ id: r.id, confirmToken, startTime: r.startTime, status: r.status })
    },
  )

  // ─── Confirm/cancel via public token ───────────────────────────────────
  fastify.post<{ Params: { token: string }; Body: { action: 'confirm' | 'cancel' } }>(
    '/public/:token',
    async (req) => {
      const action = z.object({ action: z.enum(['confirm', 'cancel']) }).parse(req.body).action
      const r = await prisma.reservation.findUnique({ where: { confirmToken: req.params.token } })
      if (!r) throw new NotFoundError('Reservation token', req.params.token)
      if (r.status === 'cancelled') return { status: 'cancelled' }
      if (action === 'confirm' && r.status === 'booked') {
        const updated = await prisma.reservation.update({
          where: { id: r.id },
          data: { status: 'confirmed', confirmedAt: new Date() },
        })
        emitReservationEvent('reservation:confirmed', {
          reservationId: updated.id, conceptId: updated.conceptId,
          startTime: updated.startTime.toISOString(), status: updated.status,
        })
        return { status: updated.status }
      }
      if (action === 'cancel') {
        const updated = await prisma.reservation.update({
          where: { id: r.id },
          data: { status: 'cancelled', cancelledAt: new Date(), cancelReason: 'Cancelled by guest' },
        })
        emitReservationEvent('reservation:cancelled', {
          reservationId: updated.id, conceptId: updated.conceptId,
          startTime: updated.startTime.toISOString(), status: updated.status,
        })
        // Slot freed — try waitlist promotion.
        void (async () => {
          const { tryPromoteWaitlist } = await import('./waitlistPromotion.js')
          tryPromoteWaitlist(r).catch(() => {})
        })()
        return { status: updated.status }
      }
      return { status: r.status }
    },
  )

  // ─── Waitlist promotion claim (public, no auth) ─────────────────────────
  // Guest gets an SMS/email when a slot opens up. The link points at
  // /reserve/claim/:token on the storefront. The storefront calls these
  // routes to fetch the offer and to claim it.
  fastify.get<{ Params: { token: string } }>(
    '/claim/:token',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req) => {
      const r = await prisma.reservation.findUnique({
        where: { promotionToken: req.params.token },
        include: { concept: { select: { name: true, slug: true } } },
      })
      if (!r || !r.promotionExpiresAt) throw new NotFoundError('Promotion offer', req.params.token)
      const expired = r.promotionExpiresAt < new Date()
      return {
        guestName:        r.guestName,
        partySize:        r.partySize,
        offeredStartTime: r.promotionOfferedStartTime,
        offeredEndTime:   r.promotionOfferedEndTime,
        expiresAt:        r.promotionExpiresAt,
        expired,
        alreadyClaimed:   r.promotedFromWaitlistAt != null && !r.promotionToken,
        concept:          { name: r.concept.name, slug: r.concept.slug },
      }
    },
  )

  fastify.post<{ Params: { token: string } }>(
    '/claim/:token',
    { config: { rateLimit: { max: 5, timeWindow: '5 minutes' } } },
    async (req, reply) => {
      const r = await prisma.reservation.findUnique({
        where: { promotionToken: req.params.token },
      })
      if (!r) throw new NotFoundError('Promotion offer', req.params.token)
      if (!r.promotionExpiresAt || r.promotionExpiresAt < new Date()) {
        throw new AppError('PROMOTION_EXPIRED', 'This offer has expired.', 410)
      }
      if (!r.promotionOfferedStartTime || !r.promotionOfferedEndTime) {
        throw new AppError('PROMOTION_INVALID', 'Offer details missing — please contact the venue.', 422)
      }

      // Atomically apply the offer: copy promoted-* into live booking fields
      // + clear the promotion. Wrapped in the overlap guard so we still
      // reject if a concurrent staff write took the slot.
      const updated = await withTableOverlapGuard(() =>
        prisma.reservation.update({
          where: { id: r.id },
          data: {
            startTime:                 r.promotionOfferedStartTime!,
            endTime:                   r.promotionOfferedEndTime!,
            tableId:                   r.promotionOfferedTableId,
            waitlist:                  false,
            status:                    'confirmed',
            confirmedAt:               new Date(),
            promotedFromWaitlistAt:    new Date(),
            promotionToken:            null,
            promotionExpiresAt:        null,
            promotionOfferedStartTime: null,
            promotionOfferedEndTime:   null,
            promotionOfferedTableId:   null,
          },
          include: { concept: { select: { name: true } } },
        }),
      )

      emitReservationEvent('reservation:waitlist-promoted', {
        reservationId: updated.id,
        conceptId:     updated.conceptId,
        startTime:     updated.startTime.toISOString(),
        status:        updated.status,
      })

      const when = updated.startTime.toLocaleString('en-GB', {
        timeZone: 'Asia/Karachi', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
      })
      if (updated.guestPhone) {
        void sendSms(updated.guestPhone, `${updated.concept.name}: confirmed for ${updated.partySize} on ${when} PKT. See you there.`).catch(() => {})
      }
      if (updated.guestEmail) {
        void sendEmail(
          updated.guestEmail,
          `${updated.concept.name}: confirmed for ${when} PKT`,
          `<p>Hi ${updated.guestName}, you're all set — table for ${updated.partySize} at <strong>${updated.concept.name}</strong> on <strong>${when} PKT</strong>. See you soon.</p>`,
        ).catch(() => {})
      }

      return reply.send({
        status: updated.status,
        startTime: updated.startTime,
        partySize: updated.partySize,
        concept: { name: updated.concept.name },
      })
    },
  )

  // ─── Blockouts CRUD ─────────────────────────────────────────────────────
  fastify.get<{ Querystring: { conceptId: string; from?: string; to?: string } }>(
    '/blockouts',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      await assertConceptAccess(req.staffUser!, req.query.conceptId)
      const scope = await conceptWhere(req, req.query.conceptId, 'read')
      const from = req.query.from ? new Date(req.query.from) : new Date()
      const to   = req.query.to   ? new Date(req.query.to)   : new Date(Date.now() + 90 * 86_400_000)
      return prisma.conceptBlockout.findMany({
        where: { ...scope, startTime: { lt: to }, endTime: { gt: from } },
        orderBy: { startTime: 'asc' },
      })
    },
  )

  fastify.post('/blockouts', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = z.object({
      conceptId:   z.string().uuid(),
      kind:        z.enum(['closure', 'private_event', 'reduced_capacity', 'custom']).default('closure'),
      startTime:   z.string().datetime(),
      endTime:     z.string().datetime(),
      capacityCap: z.number().int().min(1).nullable().optional(),
      reason:      z.string().max(300).nullable().optional(),
    }).parse(req.body)
    await assertConceptAccess(req.staffUser!, body.conceptId)
    // A closure can only be raised on a brand of the ACTIVE company.
    await assertConceptOwned(req, body.conceptId, 'create')
    const created = await prisma.conceptBlockout.create({
      data: {
        conceptId:   body.conceptId,
        kind:        body.kind,   // zod enum mirrors BlockoutKind exactly — no cast
        startTime:   new Date(body.startTime),
        endTime:     new Date(body.endTime),
        capacityCap: body.capacityCap ?? null,
        reason:      body.reason ?? null,
        createdById: req.staffUser?.id ?? null,
      },
    })
    return reply.status(201).send(created)
  })

  fastify.delete<{ Params: { id: string } }>(
    '/blockouts/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      // Resolved through the brand's company so a foreign id is a plain 404.
      const existing = await prisma.conceptBlockout.findFirst({
        where: { id: req.params.id, concept: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) } },
      })
      if (!existing) throw new NotFoundError('Blockout', req.params.id)
      await assertConceptAccess(req.staffUser!, existing.conceptId)
      await prisma.conceptBlockout.delete({ where: { id: existing.id } })
      return reply.status(204).send()
    },
  )

  // Service hours are brand master data with ONE writer: GET/PUT
  // /setup/hours/:conceptId (admin /configuration/hours). Availability search
  // below reads the same ServiceHours rows. The old /reservations/service-hours
  // pair wrote the same table with a different payload shape (D1).

  // ─── Guest tags ─────────────────────────────────────────────────────────
  fastify.get<{ Querystring: { customerId: string } }>(
    '/guest-tags',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      // Without an id the query would return every company's tags.
      const customerId = requireId(req.query.customerId, 'customerId')
      await assertCustomerInScope(req, customerId, 'read')
      return prisma.guestTag.findMany({
        where: { customerId },
        orderBy: { createdAt: 'desc' },
      })
    },
  )

  fastify.post<{ Body: { customerId: string; label: string; color?: string } }>(
    '/guest-tags',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req, reply) => {
      const body = z.object({
        customerId: z.string().uuid(),
        label:      z.string().min(1).max(40),
        color:      z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      }).parse(req.body)
      // Only a guest one of the operator's companies has served can be tagged.
      await assertCustomerInScope(req, body.customerId, 'write')
      const created = await prisma.guestTag.create({
        data: { ...body, createdById: req.staffUser?.id ?? null },
      })
      return reply.status(201).send(created)
    },
  )

  fastify.delete<{ Params: { id: string } }>(
    '/guest-tags/:id',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req, reply) => {
      // Resolved through the tagged guest's company footprint — a bare id
      // from another company's guest is a plain 404, not a delete.
      const concept = { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) }
      const existing = await prisma.guestTag.findFirst({
        where: {
          id: req.params.id,
          customer: {
            OR: [
              { orders:       { some: { concept } } },
              { reservations: { some: { concept } } },
            ],
          },
        },
        select: { id: true },
      })
      if (!existing) throw new NotFoundError('Guest tag', req.params.id)
      await prisma.guestTag.delete({ where: { id: existing.id } })
      return reply.status(204).send()
    },
  )

  // ─── Deposits — hold / release ──────────────────────────────────────────
  // No client calls these yet (the reservations page has no deposit UI); they
  // are the only writers of depositCents, which markNoShow captures.
  // The actual gateway hold/release call is operator-specific (Keenu doesn't
  // expose pre-auth on all rails). For now we record intent + the gateway
  // ref the operator pasted in; the gateway integration can be added later
  // without changing this surface.

  fastify.post<{ Params: { id: string } }>(
    '/:id/deposit-hold',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const body = z.object({
        amountCents: z.number().int().min(100).max(1_000_000),
        gatewayRef:  z.string().min(3).max(120),
      }).parse(req.body)
      const r = await prisma.reservation.findFirst({ where: { id: req.params.id, concept: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) } } })
      if (!r) throw new NotFoundError('Reservation', req.params.id)
      await assertConceptAccess(req.staffUser!, r.conceptId)
      return prisma.reservation.update({
        where: { id: r.id },
        data: { depositCents: body.amountCents, depositRef: body.gatewayRef },
      })
    },
  )

  fastify.post<{ Params: { id: string } }>(
    '/:id/deposit-release',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const r = await prisma.reservation.findFirst({ where: { id: req.params.id, concept: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) } } })
      if (!r) throw new NotFoundError('Reservation', req.params.id)
      await assertConceptAccess(req.staffUser!, r.conceptId)
      await audit({ category: 'identity',
        action: 'reservation.deposit_release', entity: 'Reservation', entityId: r.id,
        userId: req.staffUser?.id ?? null, tenantId: req.staffUser?.tenantId ?? null, userEmail: req.staffUser?.email ?? null,
        before: { depositCents: r.depositCents, depositRef: r.depositRef },
        after:  { depositCents: 0 },
      })
      return prisma.reservation.update({
        where: { id: r.id },
        data: { depositCents: 0, depositRef: null },
      })
    },
  )

  // There is no separate deposit-capture route: a held deposit is captured by
  // the no-show itself (POST /:id/no-show → markNoShow), so capturing can never
  // happen without the strike / waitlist side effects, or twice (D4).
}

async function transition(
  reservationId: string,
  status: 'confirmed' | 'no_show',
  req: FastifyRequest,
) {
  // Company-scoped lookup — `assertConceptAccess` below bypasses for
  // management roles, so this filter is the real boundary.
  const r = await prisma.reservation.findFirst({
    where: {
      id: reservationId,
      concept: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) },
    },
  })
  if (!r) throw new NotFoundError('Reservation', reservationId)
  await assertConceptAccess(req.staffUser!, r.conceptId)

  if (status === 'no_show') {
    // One no-show path for staff and the auto sweep: deposit capture, strike,
    // rollups, waitlist promotion and the socket event all live in markNoShow.
    if (r.status === 'no_show') return r
    const { markNoShow, NO_SHOW_FROM } = await import('./noShow.js')
    if (!(NO_SHOW_FROM as readonly string[]).includes(r.status) || r.seatedAt) {
      throw new AppError('RESERVATION_CLOSED', `This reservation is already ${r.status}; it cannot be marked a no-show.`, 422)
    }
    const res = await markNoShow(r.id, {
      reason: 'No-show',
      actorId: req.staffUser?.id ?? null,
      actorEmail: req.staffUser?.email ?? null,
    })
    if (res.reservation) return res.reservation
    throw new NotFoundError('Reservation', reservationId)
  }

  const updated = await prisma.reservation.update({
    where: { id: r.id },
    data: { status },
  })
  emitReservationEvent('reservation:confirmed', {
    reservationId: updated.id, conceptId: updated.conceptId,
    startTime: updated.startTime.toISOString(), status: updated.status,
  })
  return updated
}
