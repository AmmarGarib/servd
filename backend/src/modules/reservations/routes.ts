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
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS, ALL_STAFF } from '../auth/middleware.js'
import { assertConceptAccess } from '../../lib/conceptAccess.js'
import { audit } from '../../lib/audit.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { sendSms, sendEmail } from '../../lib/notify.js'

const DEFAULT_DURATION_MIN = 90

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

      const where: Prisma.ReservationWhereInput = {}
      if (conceptId) where.conceptId = conceptId
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
        },
      })
    },
  )

  // Create reservation
  fastify.post('/', { preHandler: requireAuth(...ALL_STAFF) }, async (req, reply) => {
    const body = createSchema.parse(req.body)
    await assertConceptAccess(req.staffUser!, body.conceptId)

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
      const { getReservationPolicy } = await import('../../lib/setup-config.js')
      const policy = await getReservationPolicy()

      if (body.partySize > policy.maxPartySize) {
        throw new AppError('PARTY_TOO_LARGE', `Maximum party size is ${policy.maxPartySize}. Contact the venue for larger groups.`, 400)
      }

      const now = new Date()
      const hoursAhead = (startTime.getTime() - now.getTime()) / 3_600_000
      const daysAhead  = hoursAhead / 24

      if (hoursAhead < policy.minAdvanceHours) {
        throw new AppError('TOO_SOON', `Reservations must be made at least ${policy.minAdvanceHours} hours in advance.`, 400)
      }
      if (daysAhead > policy.maxAdvanceDays) {
        throw new AppError('TOO_FAR', `Reservations cannot be made more than ${policy.maxAdvanceDays} days ahead.`, 400)
      }

      // Deposit requirement — flagged on the response so the caller can collect.
      // Actual payment capture happens in the gateway flow; we just attach the
      // expected amount on the reservation record (notes field for now).
      if (policy.depositRequiredAboveParty != null && body.partySize > policy.depositRequiredAboveParty && policy.depositCents > 0) {
        // Surface in notes so the host UI can prompt for collection on arrival.
        body.notes = (body.notes ? body.notes + ' · ' : '') + `Deposit required: PKR ${(policy.depositCents / 100).toFixed(0)} (party of ${body.partySize})`
      }
    } else if (body.source === 'walkin') {
      const { getReservationPolicy } = await import('../../lib/setup-config.js')
      const policy = await getReservationPolicy()
      if (!policy.walkInsAllowed) {
        throw new AppError('WALKINS_DISABLED', 'Walk-ins are currently not accepted. Please book in advance.', 400)
      }
    }

    // Auto-link to existing customer by phone or email if we have one
    let customerId = body.customerId ?? null
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

    const r = await prisma.reservation.create({
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
    })

    await audit({
      action: 'reservation.create',
      entity: 'Reservation',
      entityId: r.id,
      userId: req.staffUser?.id ?? null,
      userEmail: req.staffUser?.email ?? null,
      after: { partySize: r.partySize, startTime: r.startTime, status: r.status, guestName: r.guestName },
      metadata: { source: r.source, ip: req.ip },
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
      const r = await prisma.reservation.findUnique({ where: { id: req.params.id } })
      if (!r) throw new NotFoundError('Reservation', req.params.id)
      await assertConceptAccess(req.staffUser!, r.conceptId)

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

      const updated = await prisma.reservation.update({
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
      const r = await prisma.reservation.findUnique({ where: { id: req.params.id } })
      if (!r) throw new NotFoundError('Reservation', req.params.id)
      await assertConceptAccess(req.staffUser!, r.conceptId)
      const body = z.object({ tableId: z.string().uuid().optional() }).parse(req.body)
      const tableId = body.tableId ?? r.tableId
      if (!tableId) throw new AppError('TABLE_REQUIRED', 'Cannot seat without a table assignment', 422)

      const overlap = await checkTableConflict(tableId, r.startTime, r.endTime, r.id)
      if (overlap.conflict) {
        throw new AppError('TABLE_CONFLICT', `Table is occupied (${overlap.with!.guestName})`, 409)
      }

      return prisma.$transaction(async (tx) => {
        const updated = await tx.reservation.update({
          where: { id: r.id },
          data: { status: 'seated', seatedAt: new Date(), tableId, waitlist: false },
        })
        await tx.table.update({ where: { id: tableId }, data: { status: 'seated' } })
        return updated
      })
    },
  )
  fastify.post<{ Params: { id: string } }>(
    '/:id/complete',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const r = await prisma.reservation.findUnique({ where: { id: req.params.id } })
      if (!r) throw new NotFoundError('Reservation', req.params.id)
      await assertConceptAccess(req.staffUser!, r.conceptId)
      return prisma.$transaction(async (tx) => {
        const updated = await tx.reservation.update({
          where: { id: r.id },
          data: { status: 'completed', completedAt: new Date() },
        })
        if (r.tableId) {
          await tx.table.update({ where: { id: r.tableId }, data: { status: 'cleaning' } })
        }
        return updated
      })
    },
  )
  fastify.post<{ Params: { id: string }; Body: { reason?: string } }>(
    '/:id/cancel',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const r = await prisma.reservation.findUnique({ where: { id: req.params.id } })
      if (!r) throw new NotFoundError('Reservation', req.params.id)
      await assertConceptAccess(req.staffUser!, r.conceptId)
      const body = z.object({ reason: z.string().max(300).optional() }).parse(req.body ?? {})
      const updated = await prisma.reservation.update({
        where: { id: r.id },
        data: { status: 'cancelled', cancelledAt: new Date(), cancelReason: body.reason ?? null },
      })
      await audit({
        action: 'reservation.cancel',
        entity: 'Reservation',
        entityId: r.id,
        userId: req.staffUser?.id ?? null,
        userEmail: req.staffUser?.email ?? null,
        before: { status: r.status, tableId: r.tableId },
        after:  { status: 'cancelled' },
        metadata: { reason: body.reason },
      })
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
      const today = new Date(); today.setHours(0, 0, 0, 0)
      const tomorrow = new Date(today.getTime() + 86_400_000)
      return prisma.reservation.findMany({
        where: {
          conceptId: req.query.conceptId,
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

  // ─── Analytics — covers, occupancy, no-show rate, repeat-guest ratio ───
  fastify.get<{ Querystring: { conceptId: string; from: string; to: string } }>(
    '/analytics',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      await assertConceptAccess(req.staffUser!, req.query.conceptId)
      const from = new Date(req.query.from)
      const to   = new Date(req.query.to)
      const all = await prisma.reservation.findMany({
        where: { conceptId: req.query.conceptId, startTime: { gte: from, lte: to } },
        select: { id: true, status: true, partySize: true, startTime: true, customerId: true, source: true },
      })
      const bookedOrAfter = all.filter((r) => !['cancelled'].includes(r.status))
      const completed = all.filter((r) => r.status === 'completed' || r.status === 'seated')
      const noShow    = all.filter((r) => r.status === 'no_show')
      const covers    = completed.reduce((s, r) => s + r.partySize, 0)

      const tableCount = await prisma.table.count({ where: { conceptId: req.query.conceptId, deletedAt: null } })
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
        select: { id: true, name: true, type: true },
      })
      if (!concept) throw new NotFoundError('Concept', req.query.conceptSlug)

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

      // Generate 30-minute slots within each window
      const slotMs = 30 * 60_000
      const candidateSlots: Date[] = []
      for (const w of windows) {
        for (let m = w.openMin; m + 90 <= w.closeMin; m += 30) {
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

      const slotDuration = 90 * 60_000
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

      return {
        concept: { id: concept.id, name: concept.name, slug: req.query.conceptSlug, type: concept.type },
        date: req.query.date.slice(0, 10),
        partySize,
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
        durationMin: z.number().int().min(30).max(240).default(DEFAULT_DURATION_MIN),
        guestName:   z.string().min(1).max(120),
        guestPhone:  z.string().min(7).max(20),
        guestEmail:  z.string().email().nullable().optional(),
        notes:       z.string().max(500).nullable().optional(),
      }).parse(req.body)

      const concept = await prisma.concept.findFirst({
        where: { slug: body.conceptSlug, isActive: true, deletedAt: null },
      })
      if (!concept) throw new NotFoundError('Concept', body.conceptSlug)

      const startTime = new Date(body.startTime)
      const endTime   = new Date(startTime.getTime() + body.durationMin * 60_000)

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

      // Auto-link to existing customer
      let customerId: string | null = null
      const match = await prisma.customer.findFirst({
        where: {
          deletedAt: null,
          OR: [
            ...(body.guestEmail ? [{ email: body.guestEmail.toLowerCase() }] : []),
            { phone: body.guestPhone },
          ],
        },
        select: { id: true },
      })
      if (match) customerId = match.id

      // Generate confirmation token (32 chars)
      const confirmToken = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('')

      const r = await prisma.reservation.create({
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
      })

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
        return { status: updated.status }
      }
      if (action === 'cancel') {
        const updated = await prisma.reservation.update({
          where: { id: r.id },
          data: { status: 'cancelled', cancelledAt: new Date(), cancelReason: 'Cancelled by guest' },
        })
        return { status: updated.status }
      }
      return { status: r.status }
    },
  )

  // ─── Blockouts CRUD ─────────────────────────────────────────────────────
  fastify.get<{ Querystring: { conceptId: string; from?: string; to?: string } }>(
    '/blockouts',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      await assertConceptAccess(req.staffUser!, req.query.conceptId)
      const from = req.query.from ? new Date(req.query.from) : new Date()
      const to   = req.query.to   ? new Date(req.query.to)   : new Date(Date.now() + 90 * 86_400_000)
      return prisma.conceptBlockout.findMany({
        where: { conceptId: req.query.conceptId, startTime: { lt: to }, endTime: { gt: from } },
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
    const created = await prisma.conceptBlockout.create({
      data: {
        conceptId:   body.conceptId,
        kind:        body.kind as never,
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
      const existing = await prisma.conceptBlockout.findUnique({ where: { id: req.params.id } })
      if (!existing) throw new NotFoundError('Blockout', req.params.id)
      await assertConceptAccess(req.staffUser!, existing.conceptId)
      await prisma.conceptBlockout.delete({ where: { id: req.params.id } })
      return reply.status(204).send()
    },
  )

  // ─── Service hours CRUD ─────────────────────────────────────────────────
  fastify.get<{ Querystring: { conceptId: string } }>(
    '/service-hours',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      await assertConceptAccess(req.staffUser!, req.query.conceptId)
      return prisma.serviceHours.findMany({
        where: { conceptId: req.query.conceptId },
        orderBy: [{ dayOfWeek: 'asc' }, { openMin: 'asc' }],
      })
    },
  )

  fastify.put<{ Querystring: { conceptId: string } }>(
    '/service-hours',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const body = z.object({
        windows: z.array(z.object({
          dayOfWeek: z.number().int().min(0).max(6),
          openMin:   z.number().int().min(0).max(1440),
          closeMin:  z.number().int().min(0).max(1440),
          isReservable: z.boolean().default(true),
        })).max(50),
      }).parse(req.body)
      await assertConceptAccess(req.staffUser!, req.query.conceptId)
      await prisma.$transaction([
        prisma.serviceHours.deleteMany({ where: { conceptId: req.query.conceptId } }),
        prisma.serviceHours.createMany({
          data: body.windows.map((w) => ({ conceptId: req.query.conceptId, ...w })),
        }),
      ])
      return { ok: true, count: body.windows.length }
    },
  )

  // ─── Guest tags ─────────────────────────────────────────────────────────
  fastify.get<{ Querystring: { customerId: string } }>(
    '/guest-tags',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => prisma.guestTag.findMany({
      where: { customerId: req.query.customerId },
      orderBy: { createdAt: 'desc' },
    }),
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
      await prisma.guestTag.delete({ where: { id: req.params.id } })
      return reply.status(204).send()
    },
  )

  // ─── Deposits — hold / release / capture (no-show fee) ─────────────────
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
      const r = await prisma.reservation.findUnique({ where: { id: req.params.id } })
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
      const r = await prisma.reservation.findUnique({ where: { id: req.params.id } })
      if (!r) throw new NotFoundError('Reservation', req.params.id)
      await assertConceptAccess(req.staffUser!, r.conceptId)
      await audit({
        action: 'reservation.deposit_release', entity: 'Reservation', entityId: r.id,
        userId: req.staffUser?.id ?? null, userEmail: req.staffUser?.email ?? null,
        before: { depositCents: r.depositCents, depositRef: r.depositRef },
        after:  { depositCents: 0 },
      })
      return prisma.reservation.update({
        where: { id: r.id },
        data: { depositCents: 0, depositRef: null },
      })
    },
  )

  // Capture = no-show, charge the deposit. Posts a journal entry:
  // Dr Bank / Cr Service Charges Revenue (4100) since this is forfeit fee
  // revenue, NOT a sale of food.
  fastify.post<{ Params: { id: string } }>(
    '/:id/deposit-capture',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const r = await prisma.reservation.findUnique({
        where: { id: req.params.id },
        include: { concept: { select: { name: true } } },
      })
      if (!r) throw new NotFoundError('Reservation', req.params.id)
      if (r.depositCents <= 0) throw new AppError('NO_DEPOSIT', 'No deposit on file', 422)
      await assertConceptAccess(req.staffUser!, r.conceptId)

      const { postJournalEntry, ACCT } = await import('../accounting/journal.js')
      await postJournalEntry({
        sourceType: 'reservation.deposit_capture',
        sourceId: r.id,
        description: `No-show fee · ${r.concept.name} · ${r.guestName}`,
        postedBy: req.staffUser?.id ?? 'system',
        lines: [
          { accountCode: ACCT.BANK,                   type: 'debit',  amountCents: r.depositCents },
          { accountCode: ACCT.SERVICE_CHARGE_REVENUE, type: 'credit', amountCents: r.depositCents, memo: 'No-show forfeit' },
        ],
      })

      return prisma.reservation.update({
        where: { id: r.id },
        data: { status: 'no_show', cancelReason: 'No-show — deposit captured' },
      })
    },
  )
}

async function transition(
  reservationId: string,
  status: 'confirmed' | 'no_show',
  req: FastifyRequest,
) {
  const r = await prisma.reservation.findUnique({ where: { id: reservationId } })
  if (!r) throw new NotFoundError('Reservation', reservationId)
  await assertConceptAccess(req.staffUser!, r.conceptId)
  return prisma.reservation.update({
    where: { id: r.id },
    data: { status, ...(status === 'no_show' && { cancelReason: 'No-show' }) },
  })
}
