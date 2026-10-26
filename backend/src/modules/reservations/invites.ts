// "Invite your table" (owner, 2026-10-26: "allow them to get ppl to join group
// or simmer booking with link. To join the group ppl have to make an account").
//
// The booker of a booking makes an invite link; anyone who opens it must sign
// in to (or create) their servd account, then joins the booking as a guest.
// Built for every brand's bookings; Simmer's page leads with it.
//
//   POST   /reservations/mine/:id/invite            booker: new link (the old one dies) → 201 { token, inviteUrl, … }
//   GET    /reservations/mine/:id/invite            booker: is a link live, who joined (never the token)
//   DELETE /reservations/mine/:id/invite            booker: revoke the link → 204
//   DELETE /reservations/mine/:id/guests/:guestId   booker: remove a guest → 204
//   GET    /reservations/invites/:token             anyone: what the invite is for (brand, time, seats left, host's nickname)
//   POST   /reservations/invites/:token/join        signed-in member joins → 201 (200 already in) | 409 BOOKING_FULL | 410 BOOKING_CLOSED | 409 HOST_IS_BOOKER
//   DELETE /reservations/joined/:reservationId      a guest leaves → 204
//   GET    /reservations/:id/guests                 staff: the guest list (company-scoped, foreign 404)
//
// Rules:
//   * The token is 32 random bytes (base64url); only its sha256 is stored
//     (Reservation.inviteTokenHash), shown once. Unknown / revoked → 404.
//   * A guest row (ReservationGuest) carries the BRAND's company (tenantId),
//     RLS, and is in the company-merge repoint list. ≤ partySize − 1 guests
//     (the booker holds the first seat), counted under a per-booking advisory
//     lock. A cancelled / no-show / finished booking → 410 BOOKING_CLOSED.
//   * Customer routes act only for the signed-in customer (read from the
//     session, never the body); the invitee's servd ban is checked at join.
//   * Nothing is sent: the booker shares the link themselves.
//   * Guests are shown to the booker and to other guests by nickname ("the
//     servd name") or first name only — never a contact detail.

import type { FastifyInstance } from 'fastify'
import { createHash, randomBytes } from 'crypto'
import { serviceClient } from '../../lib/prisma.js'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, ALL_STAFF } from '../auth/middleware.js'
import { assertConceptOwned } from '../../lib/tenantScope.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { formatBrandName } from '../../lib/brandName.js'
import { signedInCustomer } from './routes.js'

const CLOSED_STATUSES = new Set(['cancelled', 'no_show', 'completed'])
const SIGN_IN_TO_JOIN = 'Sign in to your servd account to join this table.'

export function inviteTokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

function storefrontOrigin(): string {
  return (process.env['STOREFRONT_URL'] ?? 'https://servd.pk').replace(/\/+$/, '')
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? ''
}

function isClosed(r: { status: string; endTime: Date }): boolean {
  return CLOSED_STATUSES.has(r.status) || r.endTime.getTime() < Date.now()
}

function closedError(): AppError {
  return new AppError('BOOKING_CLOSED', 'This booking has been cancelled or has already happened.', 410)
}

/** The signed-in customer's own booking, or 404 (another customer's is the same 404). */
async function ownBooking(customerId: string, id: string) {
  const r = await serviceClient.reservation.findFirst({
    where: { id, customerId },
    select: { id: true, partySize: true, status: true, endTime: true, inviteTokenHash: true, inviteTokenCreatedAt: true, concept: { select: { tenantId: true } } },
  })
  if (!r) throw new NotFoundError('Reservation', id)
  return r
}

async function guestList(reservationId: string) {
  const rows = await serviceClient.reservationGuest.findMany({
    where: { reservationId },
    orderBy: { joinedAt: 'asc' },
    select: { id: true, joinedAt: true, customer: { select: { name: true, nickname: true } } },
  })
  return rows.map((g) => ({ id: g.id, nickname: g.customer.nickname, firstName: firstName(g.customer.name), joinedAt: g.joinedAt }))
}

function seatsLeft(partySize: number, guests: number): number {
  return Math.max(0, partySize - 1 - guests)
}

async function bookingByToken(token: string) {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) throw new NotFoundError('Invite', 'invite')
  const r = await serviceClient.reservation.findFirst({
    where: { inviteTokenHash: inviteTokenHash(token) },
    select: {
      id: true, customerId: true, partySize: true, startTime: true, endTime: true, status: true,
      concept: { select: { id: true, name: true, slug: true, tenantId: true } },
      customer: { select: { nickname: true } },
    },
  })
  if (!r) throw new NotFoundError('Invite', 'invite')
  return r
}

/** The signed-in customer when a valid session is sent; null otherwise (never an error). */
async function maybeCustomer(req: Parameters<typeof signedInCustomer>[0]) {
  if (!req.headers.authorization) return null
  try { return await signedInCustomer(req) } catch { return null }
}

export async function reservationInviteRoutes(fastify: FastifyInstance) {
  // ── Booker ────────────────────────────────────────────────────────────────
  fastify.post<{ Params: { id: string } }>(
    '/mine/:id/invite',
    { config: { rateLimit: { max: 20, timeWindow: '1 hour' } } },
    async (req, reply) => {
      const self = await signedInCustomer(req, 'Sign in to your servd account to invite your table.')
      const r = await ownBooking(self.id, req.params.id)
      if (isClosed(r)) throw closedError()
      if (!r.concept.tenantId) throw new AppError('INVITES_UNAVAILABLE', 'Invites are not available for this booking.', 409)
      if (r.partySize < 2) throw new AppError('PARTY_OF_ONE', 'This booking is for one. Change the party size to invite your table.', 409)
      const token = randomBytes(32).toString('base64url')
      await serviceClient.reservation.update({
        where: { id: r.id },
        data: { inviteTokenHash: inviteTokenHash(token), inviteTokenCreatedAt: new Date() },
      })
      const guests = await guestList(r.id)
      return reply.status(201).send({
        token,
        inviteUrl: `${storefrontOrigin()}/reserve/invite/${token}`,
        partySize: r.partySize,
        seatsLeft: seatsLeft(r.partySize, guests.length),
        guests,
      })
    },
  )

  fastify.get<{ Params: { id: string } }>('/mine/:id/invite', async (req) => {
    const self = await signedInCustomer(req, 'Sign in to your servd account to invite your table.')
    const r = await ownBooking(self.id, req.params.id)
    const guests = await guestList(r.id)
    return {
      active: !!r.inviteTokenHash && !isClosed(r),
      createdAt: r.inviteTokenHash ? r.inviteTokenCreatedAt : null,
      partySize: r.partySize,
      seatsLeft: seatsLeft(r.partySize, guests.length),
      guests,
    }
  })

  fastify.delete<{ Params: { id: string } }>('/mine/:id/invite', async (req, reply) => {
    const self = await signedInCustomer(req, 'Sign in to your servd account to invite your table.')
    const r = await ownBooking(self.id, req.params.id)
    await serviceClient.reservation.update({ where: { id: r.id }, data: { inviteTokenHash: null, inviteTokenCreatedAt: null } })
    return reply.status(204).send()
  })

  fastify.delete<{ Params: { id: string; guestId: string } }>('/mine/:id/guests/:guestId', async (req, reply) => {
    const self = await signedInCustomer(req, 'Sign in to your servd account to manage your table.')
    const r = await ownBooking(self.id, req.params.id)
    const gone = await serviceClient.reservationGuest.deleteMany({ where: { id: req.params.guestId, reservationId: r.id } })
    if (gone.count === 0) throw new NotFoundError('Guest', req.params.guestId)
    return reply.status(204).send()
  })

  // ── Invitee ───────────────────────────────────────────────────────────────
  fastify.get<{ Params: { token: string } }>(
    '/invites/:token',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req) => {
      const r = await bookingByToken(req.params.token)
      if (isClosed(r)) throw closedError()
      const self = await maybeCustomer(req)
      const count = await serviceClient.reservationGuest.count({ where: { reservationId: r.id } })
      const joined = self
        ? (await serviceClient.reservationGuest.count({ where: { reservationId: r.id, customerId: self.id } })) > 0
        : false
      return {
        brand: { name: formatBrandName(r.concept.name), slug: r.concept.slug },
        startTime: r.startTime,
        partySize: r.partySize,
        seatsLeft: seatsLeft(r.partySize, count),
        host: r.customer?.nickname ?? null,
        status: r.status,
        joined,
        isHost: !!self && self.id === r.customerId,
      }
    },
  )

  fastify.post<{ Params: { token: string } }>(
    '/invites/:token/join',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const self = await signedInCustomer(req, SIGN_IN_TO_JOIN)
      const r = await bookingByToken(req.params.token)
      if (isClosed(r)) throw closedError()
      if (r.customerId === self.id) throw new AppError('HOST_IS_BOOKER', 'This is your own booking — share the link with your table.', 409)
      if (!r.concept.tenantId) throw new AppError('INVITES_UNAVAILABLE', 'Invites are not available for this booking.', 409)
      const { assertNotBannedAtCompany } = await import('../../lib/strikes.js')
      await assertNotBannedAtCompany({
        customerId: self.id, email: self.email, phone: self.phone,
        tenantId: r.concept.tenantId, ip: req.ip ?? null, intent: 'reservation',
      })
      const tenantId = r.concept.tenantId
      const out = await serviceClient.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`reservation-guests:${r.id}`}::text))`
        const existing = await tx.reservationGuest.findFirst({ where: { reservationId: r.id, customerId: self.id } })
        if (existing) return { guest: existing, created: false }
        // Re-read under the lock: a cancel or a party-size change may have landed.
        const fresh = await tx.reservation.findUnique({ where: { id: r.id }, select: { status: true, endTime: true, partySize: true, inviteTokenHash: true } })
        if (!fresh || fresh.inviteTokenHash !== inviteTokenHash(req.params.token)) throw new NotFoundError('Invite', 'invite')
        if (isClosed(fresh)) throw closedError()
        const count = await tx.reservationGuest.count({ where: { reservationId: r.id } })
        if (count >= fresh.partySize - 1) {
          throw new AppError('BOOKING_FULL', 'This table is full. Ask the host to add seats.', 409, { partySize: fresh.partySize })
        }
        const guest = await tx.reservationGuest.create({ data: { tenantId, reservationId: r.id, customerId: self.id } })
        return { guest, created: true }
      })
      return reply.status(out.created ? 201 : 200).send({
        reservationId: r.id,
        guest: { id: out.guest.id, nickname: self.nickname, firstName: firstName(self.name), joinedAt: out.guest.joinedAt },
      })
    },
  )

  fastify.delete<{ Params: { reservationId: string } }>('/joined/:reservationId', async (req, reply) => {
    const self = await signedInCustomer(req, SIGN_IN_TO_JOIN)
    const gone = await serviceClient.reservationGuest.deleteMany({ where: { reservationId: req.params.reservationId, customerId: self.id } })
    if (gone.count === 0) throw new NotFoundError('Reservation', req.params.reservationId)
    return reply.status(204).send()
  })

  // ── Staff ─────────────────────────────────────────────────────────────────
  fastify.get<{ Params: { id: string } }>('/:id/guests', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const r = await prisma.reservation.findUnique({ where: { id: req.params.id }, select: { id: true, conceptId: true } })
    if (!r) throw new NotFoundError('Reservation', req.params.id)
    await assertConceptOwned(req, r.conceptId, 'read') // another company's booking → 404
    const rows = await prisma.reservationGuest.findMany({
      where: { reservationId: r.id },
      orderBy: { joinedAt: 'asc' },
      select: { id: true, customerId: true, joinedAt: true, customer: { select: { name: true, nickname: true, memberCode: true } } },
    })
    return {
      data: rows.map((g) => ({
        id: g.id, customerId: g.customerId, joinedAt: g.joinedAt,
        name: g.customer.name, nickname: g.customer.nickname, memberCode: g.customer.memberCode,
      })),
    }
  })
}
