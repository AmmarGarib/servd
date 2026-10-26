// Overbooking goes to the CEO (owner C10, 2026-10-26: "overbooking should auto
// come to ceo for approval. Manager shouldnt be able to do that without
// approval.").
//
//   • Who raises: the same people as before (ONL-R2-04) — a manager on their
//     own login, or a host with a manager's PIN of the BRAND's company — with
//     a reason. The host stand's POST /reservations and PATCH /reservations/:id
//     (routes.ts) call in here when the booking really goes past capacity.
//   • The CEO's own overbook (a login of role admin, or the CEO's own PIN at
//     the stand) applies at once, as before.
//   • Anyone else: a NEW booking is stored with status pending_approval — off
//     the floor plan, the capacity count, the no-overlap constraint, reminders
//     and the guest's account — and the guest is told NOTHING (no
//     "confirmed" WhatsApp / email). A CHANGE of a live booking is held as the
//     proposed fields; the booking stays as it is. Answer 202
//     { pendingApproval: true, overbookRequestId }.
//   • One row per request (ReservationOverbookRequest, tenantId = the brand's
//     company); one pending per reservation (409 OVERBOOK_PENDING). While it
//     waits the booking cannot be edited, confirmed, seated or completed (409
//     OVERBOOK_PENDING); cancelling the booking withdraws the request.
//   • Approval type reservation_overbook (lib/approvalRights.ts): section ceo,
//     the CEO only, never handed over. Approve: a new booking → booked and the
//     normal confirmation goes to the guest; a change → applied if the booking
//     did not move since (409 RESERVATION_CHANGED). Table clashes are still
//     refused (409 TABLE_CONFLICT). Reject (note ≥10): a new booking is
//     cancelled and the guest is told politely that the time is full; a change
//     is dropped and the booking stays as it was.
//   • Company scope: reads view-aware; a request of another company is 404.
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, ADMIN_ONLY, ALL_STAFF, MANAGERS } from '../auth/middleware.js'
import { AppError, ForbiddenError, NotFoundError } from '../../lib/errors.js'
import { scopeTenantWhere } from '../../lib/tenantScope.js'
import { approvalInputOf, approvalSubject, assertCanApprove, auditApproval } from '../../lib/approvalRights.js'
import { approvalWaiting } from '../approvals/notify.js'
import { audit } from '../../lib/audit.js'
import { sendPhoneMessage, sendEmail } from '../../lib/notify.js'
import { customerScope } from '../../lib/outboundScope.js'
import { formatBrandName } from '../../lib/brandName.js'
import { emitReservationEvent } from '../../lib/ws.js'

type Tx = Prisma.TransactionClient

/** The fields a held change carries (ISO strings for times). */
export interface OverbookChanges {
  startTime?: string
  endTime?: string
  partySize?: number
  tableId?: string | null
  waitlist?: boolean
  guestName?: string
  guestPhone?: string | null
  guestEmail?: string | null
  notes?: string | null
  isVip?: boolean
}

const LIVE = ['booked', 'confirmed', 'seated'] as const

/** Is this overbook the CEO's own (an admin login, or the CEO's PIN at the stand)? */
export async function isCeoOverbook(actorRole: string, approval: { approverId: string; viaPin: boolean }): Promise<boolean> {
  if (actorRole === 'admin') return true
  if (!approval.viaPin) return false
  const u = await prisma.user.findUnique({ where: { id: approval.approverId }, select: { role: true } })
  return u?.role === 'admin'
}

/** 409 OVERBOOK_PENDING when the booking (or a change of it) waits for the CEO. */
export async function assertNoPendingOverbook(r: { id: string; status: string }): Promise<void> {
  if (r.status === 'pending_approval') {
    throw new AppError('OVERBOOK_PENDING', 'This booking goes past capacity and is waiting for the CEO. Wait for the decision, or cancel it.', 409)
  }
  const waiting = await prisma.reservationOverbookRequest.findFirst({ where: { reservationId: r.id, status: 'pending' }, select: { id: true } })
  if (waiting) {
    throw new AppError('OVERBOOK_PENDING', 'A change of this booking past capacity is waiting for the CEO. Wait for the decision, or withdraw it.', 409)
  }
}

/** Withdraw whatever waits on a booking (called when the booking itself is cancelled). */
export async function withdrawPendingOverbooks(reservationId: string): Promise<void> {
  await prisma.reservationOverbookRequest.updateMany({
    where: { reservationId, status: 'pending' },
    data: { status: 'cancelled', decidedAt: new Date() },
  })
}

function pendingClash(err: unknown): boolean {
  return (err as { code?: string }).code === 'P2002'
}

/** Raise a NEW booking's request inside the booking's own transaction (the booking is pending_approval). */
export async function raiseOverbookCreateTx(tx: Tx, input: {
  tenantId: string
  reservationId: string
  conceptId: string
  reason: string
  approval: { approverId: string; viaPin: boolean }
  requestedById: string
}) {
  return tx.reservationOverbookRequest.create({
    data: {
      tenantId: input.tenantId,
      reservationId: input.reservationId,
      conceptId: input.conceptId,
      kind: 'create',
      changes: {},
      reason: input.reason,
      managerApproverId: input.approval.approverId,
      viaPin: input.approval.viaPin,
      requestedById: input.requestedById,
    },
  })
}

/** Raise a CHANGE of a live booking (nothing on the booking moves). 409 OVERBOOK_PENDING when one already waits. */
export async function raiseOverbookEdit(req: FastifyRequest, input: {
  tenantId: string
  reservation: { id: string; conceptId: string; updatedAt: Date }
  changes: OverbookChanges
  reason: string
  approval: { approverId: string; viaPin: boolean }
}) {
  let row
  try {
    row = await prisma.reservationOverbookRequest.create({
      data: {
        tenantId: input.tenantId,
        reservationId: input.reservation.id,
        conceptId: input.reservation.conceptId,
        kind: 'edit',
        changes: input.changes as Prisma.InputJsonValue,
        reason: input.reason,
        managerApproverId: input.approval.approverId,
        viaPin: input.approval.viaPin,
        reservationUpdatedAt: input.reservation.updatedAt,
        requestedById: req.staffUser!.id,
      },
    })
  } catch (err) {
    if (pendingClash(err)) throw new AppError('OVERBOOK_PENDING', 'A change of this booking past capacity is already waiting for the CEO.', 409)
    throw err
  }
  await auditRequested(req, row)
  approvalWaiting('reservation_overbook', row.id, { round: row.requestedAt.toISOString(), actorId: req.staffUser!.id })
  return row
}

/** Audit + bell for a request raised (call after the commit). */
export async function auditRequested(
  req: FastifyRequest,
  row: { id: string; tenantId: string; kind: string; reservationId: string; reason: string; managerApproverId: string | null; viaPin: boolean; requestedAt: Date },
): Promise<void> {
  await audit({
    category: 'identity', action: 'reservation.overbook_requested', entity: 'ReservationOverbookRequest', entityId: row.id,
    userId: req.staffUser!.id, userEmail: req.staffUser!.email ?? null, tenantId: row.tenantId,
    metadata: { kind: row.kind, reservationId: row.reservationId, reason: row.reason, approverId: row.managerApproverId, viaPin: row.viaPin, actorRole: req.staffUser!.role },
  })
}

// ─── Guest messages ──────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function whenOf(startTime: Date): string {
  return startTime.toLocaleString('en-GB', { timeZone: 'Asia/Karachi', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

interface GuestBooking {
  guestName: string
  guestPhone: string | null
  guestEmail: string | null
  partySize: number
  startTime: Date
  notes: string | null
  concept: { name: string; tenantId: string | null }
}

/** The host stand's "reservation confirmed" WhatsApp / email (best effort, never throws). */
export function sendBookingConfirmation(r: GuestBooking, log?: { error: (o: unknown, m: string) => void }): void {
  const brand = formatBrandName(r.concept.name)
  const when = whenOf(r.startTime)
  if (r.guestPhone) {
    void sendPhoneMessage(r.guestPhone, `${brand}: reservation confirmed for ${r.partySize} on ${when} PKT. Reply CANCEL to cancel.`, 'reservation.confirmed', customerScope(r.concept.tenantId))
      .catch((err) => log?.error({ err: (err as Error).message }, 'reservation SMS failed'))
  }
  if (r.guestEmail) {
    const html = `<p>Hi ${escapeHtml(r.guestName)},</p>
        <p>Your table for ${r.partySize} at <strong>${escapeHtml(brand)}</strong> is booked for <strong>${when} PKT</strong>.</p>
        ${r.notes ? `<p><em>Notes:</em> ${escapeHtml(r.notes)}</p>` : ''}
        <p>If you need to cancel, reply to this email or call us.</p>
        <p>— ${escapeHtml(brand)}</p>`
    void sendEmail(r.guestEmail, `${brand} reservation confirmed`, html, 'reservation.confirmed', customerScope(r.concept.tenantId))
      .catch((err) => log?.error({ err: (err as Error).message }, 'reservation email failed'))
  }
}

/** The polite "that time is full" when the CEO turns an overbook down (best effort, never throws). */
function sendFullyBooked(r: GuestBooking, log?: { error: (o: unknown, m: string) => void }): void {
  const brand = formatBrandName(r.concept.name)
  const when = whenOf(r.startTime)
  if (r.guestPhone) {
    void sendPhoneMessage(r.guestPhone, `${brand}: we are sorry — we are fully booked for ${r.partySize} on ${when} PKT and could not hold a table. Please call us or book another time.`, 'reservation.cancelled', customerScope(r.concept.tenantId))
      .catch((err) => log?.error({ err: (err as Error).message }, 'reservation SMS failed'))
  }
  if (r.guestEmail) {
    const html = `<p>Hi ${escapeHtml(r.guestName)},</p>
        <p>We are sorry — <strong>${escapeHtml(brand)}</strong> is fully booked for ${r.partySize} on <strong>${when} PKT</strong>, so we could not hold a table for you.</p>
        <p>Please call us or book another time. We would love to see you.</p>
        <p>— ${escapeHtml(brand)}</p>`
    void sendEmail(r.guestEmail, `${brand} — we are fully booked at that time`, html, 'reservation.cancelled', customerScope(r.concept.tenantId))
      .catch((err) => log?.error({ err: (err as Error).message }, 'reservation email failed'))
  }
}

// ─── Routes (registered by reservationRoutes, prefix /reservations) ─────────

export async function overbookApprovalRoutes(fastify: FastifyInstance) {
  // GET /reservations/overbook-requests?status=pending — the companies in view
  // (the approvals inbox reads this as the CEO; the host stand reads it too).
  fastify.get<{ Querystring: { status?: string } }>('/overbook-requests', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const scope = await scopeTenantWhere(req, 'read')
    const status = req.query.status && ['pending', 'approved', 'rejected', 'cancelled'].includes(req.query.status) ? req.query.status : undefined
    const rows = await prisma.reservationOverbookRequest.findMany({
      where: { ...scope, ...(status ? { status } : {}) },
      orderBy: { requestedAt: 'desc' },
      take: 200,
    })
    const resIds = [...new Set(rows.map((r) => r.reservationId))]
    const userIds = [...new Set(rows.flatMap((r) => [r.requestedById, r.managerApproverId].filter((x): x is string => !!x)))]
    const tableIds = new Set<string>()
    for (const r of rows) { const t = (r.changes as OverbookChanges).tableId; if (t) tableIds.add(t) }
    const [reservations, users] = await Promise.all([
      prisma.reservation.findMany({
        where: { id: { in: resIds } },
        select: {
          id: true, guestName: true, partySize: true, startTime: true, endTime: true, status: true, tableId: true,
          concept: { select: { id: true, name: true } }, table: { select: { id: true, label: true } },
        },
      }),
      prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }),
    ])
    const tables = tableIds.size
      ? await prisma.table.findMany({ where: { id: { in: [...tableIds] } }, select: { id: true, label: true } })
      : []
    const res = new Map(reservations.map((r) => [r.id, r]))
    const uName = new Map(users.map((u) => [u.id, u.name]))
    const tLabel = new Map(tables.map((t) => [t.id, t.label]))
    return {
      items: rows.map((r) => {
        const c = r.changes as OverbookChanges
        return {
          ...r,
          reservation: res.get(r.reservationId) ?? null,
          newTableLabel: c.tableId ? tLabel.get(c.tableId) ?? null : null,
          requestedByName: uName.get(r.requestedById) ?? null,
          managerName: r.managerApproverId ? uName.get(r.managerApproverId) ?? null : null,
        }
      }),
    }
  })

  async function forDecision(req: FastifyRequest, id: string) {
    const scope = await scopeTenantWhere(req, 'write')
    const r = await prisma.reservationOverbookRequest.findFirst({ where: { id, ...scope } })
    if (!r) throw new NotFoundError('Overbook request', id)
    return r
  }

  async function grantFor(req: FastifyRequest, id: string) {
    const s = await approvalSubject('reservation_overbook', id)
    if (!s) throw new NotFoundError('Overbook request', id)
    return assertCanApprove(req, approvalInputOf('reservation_overbook', id, s))
  }

  const notPending = () => new AppError('NOT_PENDING', 'This booking is no longer waiting for approval.', 409)
  const changed = () => new AppError('RESERVATION_CHANGED', 'The booking was changed or closed since this was raised — it cannot be applied. Reject it.', 409)

  // POST /reservations/overbook-requests/:id/approve — the CEO books it past capacity.
  fastify.post<{ Params: { id: string } }>('/overbook-requests/:id/approve', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const body = z.object({ note: z.string().trim().max(500).optional() }).parse(req.body ?? {})
    const r = await forDecision(req, req.params.id)
    const grant = await grantFor(req, r.id)
    if (r.status !== 'pending') throw notPending()
    const { withTableOverlapGuard } = await import('./routes.js')
    const decided = { status: 'approved', decidedById: req.staffUser!.id, decidedAt: new Date(), decisionNote: body.note ?? null }

    const updated = await withTableOverlapGuard(() => prisma.$transaction(async (tx) => {
      const claimed = await tx.reservationOverbookRequest.updateMany({ where: { id: r.id, status: 'pending' }, data: decided })
      if (claimed.count === 0) throw notPending()
      if (r.kind === 'create') {
        const moved = await tx.reservation.updateMany({ where: { id: r.reservationId, status: 'pending_approval' }, data: { status: 'booked' } })
        if (moved.count === 0) throw changed()
      } else {
        const cur = await tx.reservation.findFirst({ where: { id: r.reservationId, concept: { tenantId: r.tenantId, deletedAt: null } } })
        if (!cur || !(LIVE as readonly string[]).includes(cur.status)
          || !r.reservationUpdatedAt || cur.updatedAt.getTime() !== r.reservationUpdatedAt.getTime()) throw changed()
        const c = r.changes as OverbookChanges
        const startTime = c.startTime ? new Date(c.startTime) : cur.startTime
        const endTime = c.endTime ? new Date(c.endTime) : cur.endTime
        const tableId = c.tableId === undefined ? cur.tableId : c.tableId
        const waitlist = c.waitlist ?? cur.waitlist
        if (tableId && !waitlist) {
          const clash = await tx.reservation.findFirst({
            where: { tableId, status: { in: [...LIVE] }, id: { not: cur.id }, startTime: { lt: endTime }, endTime: { gt: startTime } },
            select: { guestName: true },
          })
          if (clash) throw new AppError('TABLE_CONFLICT', `That table is now booked at that time (${clash.guestName}). Reject this change.`, 409)
        }
        const baseNotes = c.notes !== undefined ? c.notes : cur.notes
        await tx.reservation.update({
          where: { id: cur.id },
          data: {
            ...(c.partySize !== undefined && { partySize: c.partySize }),
            ...(c.guestName !== undefined && { guestName: c.guestName }),
            ...(c.guestPhone !== undefined && { guestPhone: c.guestPhone }),
            ...(c.guestEmail !== undefined && { guestEmail: c.guestEmail }),
            ...(c.isVip !== undefined && { isVip: c.isVip }),
            ...(c.waitlist !== undefined && { waitlist: c.waitlist }),
            notes: (baseNotes ? baseNotes + ' · ' : '') + `Overbooked: ${r.reason}`,
            startTime, endTime, tableId,
          },
        })
      }
      return tx.reservation.findUniqueOrThrow({
        where: { id: r.reservationId },
        include: { concept: { select: { name: true, tenantId: true } } },
      })
    }))

    await audit({
      category: 'identity', action: 'reservation.overbook', entity: 'Reservation', entityId: updated.id,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email ?? null, tenantId: r.tenantId,
      after: { partySize: updated.partySize, startTime: updated.startTime, endTime: updated.endTime, tableId: updated.tableId, status: updated.status },
      metadata: { reason: r.reason, approverId: req.staffUser!.id, viaPin: false, requestId: r.id, raisedBy: r.requestedById, managerApproverId: r.managerApproverId, ...(r.kind === 'edit' && { via: 'edit' }) },
    })
    await auditApproval(req, {
      type: 'reservation_overbook', id: r.id, tenantId: r.tenantId, decision: 'approve', grant, entity: 'ReservationOverbookRequest',
      metadata: { kind: r.kind, reservationId: r.reservationId, note: body.note ?? null },
    })
    emitReservationEvent(r.kind === 'create' ? 'reservation:created' : 'reservation:updated', {
      reservationId: updated.id, conceptId: updated.conceptId, startTime: updated.startTime.toISOString(), status: updated.status,
    })
    // Only now is the guest told the booking stands.
    if (r.kind === 'create') sendBookingConfirmation(updated, req.log)
    return { id: r.id, approved: true, reservation: updated }
  })

  // POST /reservations/overbook-requests/:id/reject {note ≥10} — the CEO turns it down.
  fastify.post<{ Params: { id: string } }>('/overbook-requests/:id/reject', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const body = z.object({ note: z.string().trim().min(10, 'Give a reason of at least 10 characters').max(500) }).parse(req.body ?? {})
    const r = await forDecision(req, req.params.id)
    const grant = await grantFor(req, r.id)
    const now = new Date()
    const cancelled = await prisma.$transaction(async (tx) => {
      const claimed = await tx.reservationOverbookRequest.updateMany({
        where: { id: r.id, status: 'pending' },
        data: { status: 'rejected', decidedById: req.staffUser!.id, decidedAt: now, decisionNote: body.note },
      })
      if (claimed.count === 0) throw notPending()
      if (r.kind !== 'create') return null
      // A new booking past capacity that the CEO turned down is cancelled
      // (only while it still waits — a booking staff already cancelled stays as it is).
      const moved = await tx.reservation.updateMany({
        where: { id: r.reservationId, status: 'pending_approval' },
        data: { status: 'cancelled', cancelledAt: now, cancelReason: 'Fully booked — booking past capacity not approved' },
      })
      if (moved.count === 0) return null
      return tx.reservation.findUniqueOrThrow({ where: { id: r.reservationId }, include: { concept: { select: { name: true, tenantId: true } } } })
    })
    if (cancelled) {
      await audit({
        category: 'identity', action: 'reservation.cancel', entity: 'Reservation', entityId: cancelled.id,
        userId: req.staffUser!.id, userEmail: req.staffUser!.email ?? null, tenantId: r.tenantId,
        before: { status: 'pending_approval', tableId: cancelled.tableId }, after: { status: 'cancelled' },
        metadata: { reason: 'overbook_rejected', requestId: r.id, note: body.note },
      })
      emitReservationEvent('reservation:cancelled', {
        reservationId: cancelled.id, conceptId: cancelled.conceptId, startTime: cancelled.startTime.toISOString(), status: cancelled.status,
      })
      // The guest is told politely that the time is full (never the CEO's note).
      sendFullyBooked(cancelled, req.log)
    }
    await auditApproval(req, {
      type: 'reservation_overbook', id: r.id, tenantId: r.tenantId, decision: 'reject', grant, entity: 'ReservationOverbookRequest',
      metadata: { kind: r.kind, reservationId: r.reservationId, note: body.note },
    })
    return { id: r.id, rejected: true, bookingCancelled: !!cancelled }
  })

  // POST /reservations/overbook-requests/:id/withdraw — the raiser (or a manager of
  // the company) takes a held CHANGE back; a new booking is withdrawn by cancelling it.
  fastify.post<{ Params: { id: string } }>('/overbook-requests/:id/withdraw', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const r = await forDecision(req, req.params.id)
    if (r.kind === 'create') throw new AppError('CANCEL_THE_BOOKING', 'To withdraw a new booking past capacity, cancel the booking.', 409)
    const isManager = (MANAGERS as readonly string[]).includes(req.staffUser!.role)
    if (!isManager && r.requestedById !== req.staffUser!.id) throw new ForbiddenError('Only the person who raised it, or a manager, may withdraw it')
    const claimed = await prisma.reservationOverbookRequest.updateMany({ where: { id: r.id, status: 'pending' }, data: { status: 'cancelled', decidedAt: new Date() } })
    if (claimed.count === 0) throw notPending()
    await audit({
      category: 'identity', action: 'reservation.overbook_withdrawn', entity: 'ReservationOverbookRequest', entityId: r.id,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email ?? null, tenantId: r.tenantId, metadata: { reservationId: r.reservationId },
    })
    return { id: r.id, withdrawn: true }
  })
}
