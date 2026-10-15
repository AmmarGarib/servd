// Trash — cancelled and no-show bookings (stream B7, spec §1c).
//
//   reservation  Reservation `cancelled` / `no_show`. Copy = PREFILL of the
//                booking form: brand, party size, guest, phone, email, notes,
//                VIP. Date / time (blank), table, deposit and status are never
//                copied; the new booking goes through POST /reservations as
//                usual (guest messages as usual).
//
// Company: the brand's (concept.tenantId). Roles = the managers (MANAGERS —
// the bookings screen's own manager guard); module `reservations`.

import type { Prisma } from '@prisma/client'
import { serviceClient as db } from '../../../../lib/prisma.js'
import { NotFoundError } from '../../../../lib/errors.js'
import { MANAGERS } from '../../../auth/middleware.js'
import type { TrashCtx, TrashProvider, TrashRow } from '../../types.js'
import { atWhere, prefill, qWhere, roles, scopeIds } from './common.js'

export const TRASH_RESERVATIONS = { reservation: 'reservation' } as const

const MGR = roles(MANAGERS)
const scope = (ctx: TrashCtx): Prisma.ReservationWhereInput => ({ concept: { tenantId: { in: scopeIds(ctx.readScope) } } })

const SELECT = {
  id: true, status: true, conceptId: true, guestName: true, partySize: true, startTime: true,
  cancelledAt: true, cancelReason: true, updatedAt: true, concept: { select: { tenantId: true } },
} satisfies Prisma.ReservationSelect
type Sel = Prisma.ReservationGetPayload<{ select: typeof SELECT }>

function row(r: Sel): TrashRow {
  return {
    id: r.id,
    tenantId: r.concept.tenantId ?? null,
    conceptId: r.conceptId,
    title: `${r.guestName} — party of ${r.partySize}`,
    subtitle: `Booked for ${r.startTime.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    at: r.cancelledAt ?? r.updatedAt,
    reason: r.cancelReason,
    statusLabel: r.status === 'no_show' ? 'No-show' : 'Cancelled',
  }
}

const reservation: TrashProvider = {
  key: TRASH_RESERVATIONS.reservation,
  label: 'Reservation',
  moduleId: 'reservations',
  roles: { list: MGR, restore: MGR, copy: MGR },
  kind: 'transaction',
  strategy: 'none',
  auditCategory: 'identity',
  linkOf: () => '/reservations',
  async list(ctx, f) {
    // A no-show has no cancelledAt: it is dated by its last change.
    const rows = await db.reservation.findMany({
      where: {
        AND: [
          scope(ctx),
          { status: { in: ['cancelled', 'no_show'] } },
          atWhere('updatedAt', f),
          qWhere(f.q, ['guestName', 'guestPhone', 'cancelReason']),
        ],
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: f.limit,
      select: SELECT,
    })
    // `at` is updatedAt for both, so the cursor and the order agree.
    return rows.map((r) => ({ ...row(r), at: r.updatedAt }))
  },
  async get(ctx, id) {
    const r = await db.reservation.findFirst({ where: { id, ...scope(ctx), status: { in: ['cancelled', 'no_show'] } }, select: SELECT })
    return r ? { ...row(r), at: r.updatedAt } : null
  },
  async copy(ctx, id) {
    const r = await db.reservation.findFirst({
      where: { id, ...scope(ctx), status: { in: ['cancelled', 'no_show'] } },
      select: { conceptId: true, partySize: true, guestName: true, guestPhone: true, guestEmail: true, notes: true, isVip: true, customerId: true },
    })
    if (!r) throw new NotFoundError('Trash item', id)
    return prefill('/reservations', {
      conceptId: r.conceptId,
      partySize: r.partySize,
      guestName: r.guestName,
      guestPhone: r.guestPhone,
      guestEmail: r.guestEmail,
      notes: r.notes,
      isVip: r.isVip,
      customerId: r.customerId,
      // Never: date / time, table, deposit, status.
      startTime: null,
      tableId: null,
    })
  },
  erasable: () => false,
}

export const RESERVATION_TRASH_PROVIDERS: readonly TrashProvider[] = [reservation]
