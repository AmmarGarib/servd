// Till flow (owner, 2026-10-20) — the service side of the new till screens.
// Contract: ./TILL_FLOW.md. Everything here EXTENDS what exists:
//
//   • waiter        = an HR employee (HrEmployee — login or not, the tip-pool
//                     member rule) of the ORDER's company; "waiter code" = the
//                     employee's own HrEmployee.employeeCode (unique per company).
//   • guest         = the global Customer row, searched only among the company's
//                     own customers (crm/customerScope.ts customerOfCompanies);
//                     a new guest is matched by phone / email first, else created.
//   • table         = Table / Floor (occupancy from the order + Table.currentOrderId).
//   • channel       = Order.settlementChannel ('keenu' | 'servd'): stamped here
//                     before the close; the ledger and the fiscal outbox read it.
//   • delivery fee  = the company's DeliveryZone, through lib/pricing.ts only.

import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { customerOfCompanies } from '../crm/customerScope.js'
import { normalisePhone } from '../auth/otp.js'
import { orderRefOf } from '../../lib/orderRef.js'

type Db = typeof prisma | Prisma.TransactionClient

/** HR statuses of a person who can wait a table. */
const ON_FLOOR = ['active', 'on_leave'] as const

export interface WaiterView { id: string; code: string; name: string }

/**
 * The waiter of a ticket, inside the ORDER's company: by HR employee id or by
 * the code typed at the till (case-insensitive). Another company's employee,
 * an unknown code or a person who has left → 422 (never says they exist elsewhere).
 */
export async function resolveWaiter(
  db: Db,
  tenantId: string,
  input: { waiterEmployeeId?: string | null; waiterCode?: string | null },
): Promise<WaiterView | null> {
  if (input.waiterEmployeeId && input.waiterCode) {
    throw new AppError('WAITER_ONE_OF', 'Pick the waiter from the list OR type their code — not both', 400)
  }
  if (input.waiterEmployeeId) {
    const e = await db.hrEmployee.findFirst({
      where: { id: input.waiterEmployeeId, tenantId, status: { in: [...ON_FLOOR] } },
      select: { id: true, employeeCode: true, fullName: true },
    })
    if (!e) throw new AppError('WAITER_NOT_IN_COMPANY', 'That waiter is not on this company\'s staff', 422)
    return { id: e.id, code: e.employeeCode, name: e.fullName }
  }
  const code = input.waiterCode?.trim()
  if (code) {
    const e = await db.hrEmployee.findFirst({
      where: { tenantId, employeeCode: { equals: code, mode: 'insensitive' }, status: { in: [...ON_FLOOR] } },
      select: { id: true, employeeCode: true, fullName: true },
    })
    if (!e) throw new AppError('WAITER_CODE_UNKNOWN', `No waiter with the code ${code} in this company`, 422)
    return { id: e.id, code: e.employeeCode, name: e.fullName }
  }
  return null
}

/** The waiter list for the till: the company's staff on the floor, by name; `q` matches name or code. */
export async function listWaiters(tenantId: string, q?: string | null, locationId?: string | null): Promise<WaiterView[]> {
  const term = q?.trim()
  const rows = await prisma.hrEmployee.findMany({
    where: {
      tenantId,
      status: { in: [...ON_FLOOR] },
      ...(locationId && { OR: [{ locationId }, { workLocations: { some: { locationId } } }] }),
      ...(term && {
        AND: [{ OR: [{ fullName: { contains: term, mode: 'insensitive' } }, { employeeCode: { startsWith: term, mode: 'insensitive' } }] }],
      }),
    },
    orderBy: { fullName: 'asc' },
    take: 200,
    select: { id: true, employeeCode: true, fullName: true },
  })
  return rows.map((e) => ({ id: e.id, code: e.employeeCode, name: e.fullName }))
}

// ─── Guests ──────────────────────────────────────────────────────────────────

/**
 * A customer a till of `tenantId` may attach: one of the company's own
 * customers (an order or a booking at its brands), or a servd account that has
 * dealt with NO company yet (nothing of another company to read). A customer
 * known only to OTHER companies is refused (422 CUSTOMER_NOT_FOUND — the same
 * answer as an unknown id).
 */
export function attachableCustomerWhere(tenantId: string): Prisma.CustomerWhereInput {
  return {
    deletedAt: null,
    OR: [
      customerOfCompanies({ tenantId }),
      { orders: { none: {} }, reservations: { none: {} } },
    ],
  }
}

export async function assertCustomerAttachable(db: Db, tenantId: string, customerId: string): Promise<void> {
  const c = await db.customer.findFirst({ where: { id: customerId, ...attachableCustomerWhere(tenantId) }, select: { id: true } })
  if (!c) throw new AppError('CUSTOMER_NOT_FOUND', 'That customer does not exist', 422)
}

export interface GuestView { id: string; name: string; phone: string | null; altPhone: string | null; email: string | null }

/**
 * Guest search at the till — the company's OWN customers only (never another
 * company's): name, mobile (Customer.phone), phone (Customer.altPhone) or email.
 * At least 2 characters; 20 rows.
 */
export async function searchGuests(tenantId: string, q: string): Promise<GuestView[]> {
  const term = q.trim()
  if (term.length < 2) return []
  const digits = term.replace(/\D/g, '')
  const phoneTerms = digits.length >= 4
    ? [...new Set([digits, digits.startsWith('0') ? `92${digits.slice(1)}` : digits])]
    : []
  const rows = await prisma.customer.findMany({
    where: {
      deletedAt: null,
      AND: [
        customerOfCompanies({ tenantId }),
        {
          OR: [
            { name: { contains: term, mode: 'insensitive' } },
            { email: { contains: term, mode: 'insensitive' } },
            ...phoneTerms.flatMap((d) => [{ phone: { contains: d } }, { altPhone: { contains: d } }]),
          ],
        },
      ],
    },
    orderBy: [{ lastOrderAt: { sort: 'desc', nulls: 'last' } }, { name: 'asc' }],
    take: 20,
    select: { id: true, name: true, phone: true, altPhone: true, email: true },
  })
  return rows
}

export interface GuestInput {
  name: string
  email?: string | null
  /** Mobile — stored as Customer.phone (the WhatsApp number). */
  mobile?: string | null
  /** A second (landline) number — Customer.altPhone. */
  phone?: string | null
  registrationNo?: string | null
}

/**
 * A guest typed at the till → a customer id. Matched by mobile (normalised),
 * then email, among customers the company may attach (attachableCustomerWhere);
 * a match only gains the fields it lacks (a stored name / email is never
 * overwritten from the till). No match → a new customer. A mobile or email
 * that belongs to a customer of ANOTHER company only is not linked (that would
 * hand this till their account) — the guest is kept on the order by name.
 */
export async function resolveGuest(db: Db, tenantId: string, g: GuestInput): Promise<{ customerId: string | null; name: string }> {
  const name = g.name.trim()
  if (!name) throw new AppError('GUEST_NAME_REQUIRED', 'Enter the guest\'s name', 400)
  const mobile = g.mobile?.trim() ? normalisePhone(g.mobile) : null
  const email = g.email?.trim() ? g.email.trim().toLowerCase() : null
  const altPhone = g.phone?.trim() ? normalisePhone(g.phone) : null
  if (mobile && mobile.length < 10) throw new AppError('INVALID_PHONE', 'That mobile number is too short', 400)

  const found = mobile || email
    ? await db.customer.findFirst({
        where: { OR: [...(mobile ? [{ phone: mobile }] : []), ...(email ? [{ email }] : [])] },
        select: { id: true, name: true, email: true, phone: true, altPhone: true, deletedAt: true },
      })
    : null
  if (found) {
    const ok = await db.customer.findFirst({ where: { id: found.id, ...attachableCustomerWhere(tenantId) }, select: { id: true } })
    if (!ok) return { customerId: null, name }
    const fill: Prisma.CustomerUpdateInput = {
      ...(!found.email && email && { email }),
      ...(!found.phone && mobile && { phone: mobile }),
      ...(!found.altPhone && altPhone && { altPhone }),
    }
    if (Object.keys(fill).length > 0) {
      // A fill that would collide with another customer's unique email / phone is skipped, never an error.
      await db.customer.update({ where: { id: found.id }, data: fill }).catch(() => undefined)
    }
    return { customerId: found.id, name: found.name || name }
  }
  const created = await db.customer.create({
    data: { name, email, phone: mobile, altPhone },
    select: { id: true },
  })
  return { customerId: created.id, name }
}

// ─── Menu search (item name or code / SKU) ───────────────────────────────────

export async function searchMenu(conceptId: string, q: string, categoryId?: string | null) {
  const term = q.trim()
  const rows = await prisma.menuItem.findMany({
    where: {
      conceptId,
      deletedAt: null,
      ...(categoryId && { categoryId }),
      ...(term && {
        OR: [
          { name: { contains: term, mode: 'insensitive' } },
          { itemCode: { startsWith: term, mode: 'insensitive' } },
        ],
      }),
    },
    orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
    take: 50,
    select: { id: true, name: true, itemCode: true, priceCents: true, isAvailable: true, categoryId: true, category: { select: { name: true } } },
  })
  // An exact code match first.
  const exact = (r: (typeof rows)[number]) => (r.itemCode && r.itemCode.toLowerCase() === term.toLowerCase() ? 0 : 1)
  return rows
    .sort((a, b) => exact(a) - exact(b))
    .map((r) => ({ id: r.id, name: r.name, itemCode: r.itemCode, priceCents: r.priceCents, isAvailable: r.isAvailable, categoryId: r.categoryId, categoryName: r.category.name }))
}

// ─── Delivery zones and fee ──────────────────────────────────────────────────

/** The brand's live zones (its own + its company's "all brands" ones) — never another company's. */
export async function deliveryZonesFor(conceptId: string, tenantId: string) {
  return prisma.deliveryZone.findMany({
    where: { isActive: true, tenantId, OR: [{ conceptId: null }, { conceptId }] },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    select: { id: true, name: true, feeCents: true, freeAboveCents: true, minOrderCents: true, estimatedMinutes: true, conceptId: true },
  })
}

/**
 * The delivery fee BEFORE GST for a till delivery (its GST is added by
 * lib/pricing.ts at the tender's rate — H9). A zone must be picked when the
 * brand has zones (422 DELIVERY_ZONE_REQUIRED); a zone of another brand /
 * company is 422 DELIVERY_ZONE_NOT_FOUND; the zone's minimum and free-above
 * rules apply. A brand with no zones delivers at no fee.
 */
export async function tillDeliveryFee(conceptId: string, tenantId: string, zoneId: string | null | undefined, itemTotalCents: number): Promise<{ feeCents: number; zoneId: string | null; zoneName: string | null }> {
  const zones = await deliveryZonesFor(conceptId, tenantId)
  if (!zoneId) {
    if (zones.length > 0) throw new AppError('DELIVERY_ZONE_REQUIRED', 'Pick the delivery zone', 422)
    return { feeCents: 0, zoneId: null, zoneName: null }
  }
  const z = zones.find((x) => x.id === zoneId)
  if (!z) throw new AppError('DELIVERY_ZONE_NOT_FOUND', 'That delivery zone is not one of this brand\'s', 422)
  if (itemTotalCents < z.minOrderCents) {
    throw new AppError('BELOW_ZONE_MINIMUM', `The food must come to at least PKR ${(z.minOrderCents / 100).toFixed(0)} for ${z.name}`, 422)
  }
  const free = z.freeAboveCents != null && itemTotalCents >= z.freeAboveCents
  return { feeCents: free ? 0 : z.feeCents, zoneId: z.id, zoneName: z.name }
}

// ─── Settlement channel ──────────────────────────────────────────────────────

export type SettlementChannelT = 'keenu' | 'servd'

const ENDED = new Set(['completed', 'refunded', 'cancelled', 'rejected'])

/**
 * Stamp how the bill will be closed, inside the caller's (order-locked)
 * transaction. 'servd' over a bill already pushed to Keenu (a live or settled
 * push) is 409 SETTLED_AT_KEENU; once money is taken the channel cannot change
 * (409 CHANNEL_LOCKED). A completed order keeps what it has (409 ORDER_ENDED).
 * Same value again is a no-op.
 */
export async function stampSettlementChannelTx(tx: Prisma.TransactionClient, orderId: string, channel: SettlementChannelT): Promise<void> {
  const o = await tx.order.findUnique({
    where: { id: orderId },
    select: { status: true, settlementChannel: true, settlementMeta: true, payments: { select: { status: true, amountCents: true } } },
  })
  if (!o) throw new NotFoundError('Order', orderId)
  if (o.settlementChannel === channel) return
  if (ENDED.has(o.status)) throw new AppError('ORDER_ENDED', `This order is ${o.status} — its settlement cannot change`, 409)
  const paid = o.payments.some((p) => p.status === 'paid' && p.amountCents > 0)
  if (o.settlementChannel === 'keenu') {
    const state = (o.settlementMeta as { keenu?: { state?: string } } | null)?.keenu?.state
    if (state === 'pending' || state === 'settled' || paid) {
      throw new AppError('SETTLED_AT_KEENU', 'This bill was pushed to Keenu — it is settled there', 409)
    }
  } else if (o.settlementChannel && paid) {
    throw new AppError('CHANNEL_LOCKED', 'Money is already taken on this bill — its settlement cannot change', 409)
  }
  await tx.order.update({ where: { id: orderId }, data: { settlementChannel: channel } })
}

// ─── Order information (the till's "Order information" panel) ────────────────

export const ORDER_INFO_SELECT = {
  id: true, status: true, conceptId: true, tableId: true, partySize: true, guestRegistrationNo: true, source: true, rawPayload: true, deliveryFeeCents: true, deliveryNotes: true,
  customerId: true, customerName: true, fulfilmentType: true, settlementChannel: true, totalCents: true,
  waiter: { select: { id: true, employeeCode: true, fullName: true } },
  customer: { select: { id: true, name: true, phone: true, altPhone: true, email: true } },
  table: { select: { id: true, label: true, floorId: true } },
} satisfies Prisma.OrderSelect

export function orderInfoView(o: Prisma.OrderGetPayload<{ select: typeof ORDER_INFO_SELECT }>) {
  return {
    orderId: o.id,
    orderRef: orderRefOf(o.id),
    status: o.status,
    fulfilmentType: o.fulfilmentType,
    settlementChannel: o.settlementChannel,
    table: o.table ? { id: o.table.id, label: o.table.label, floorId: o.table.floorId } : null,
    partySize: o.partySize,
    waiter: o.waiter ? { id: o.waiter.id, code: o.waiter.employeeCode, name: o.waiter.fullName } : null,
    guest: o.customer
      ? { id: o.customer.id, name: o.customer.name, mobile: o.customer.phone, phone: o.customer.altPhone, email: o.customer.email, registrationNo: o.guestRegistrationNo }
      : o.customerName || o.guestRegistrationNo ? { id: null, name: o.customerName, mobile: null, phone: null, email: null, registrationNo: o.guestRegistrationNo } : null,
    totalCents: o.totalCents,
    // A till delivery: its details and cash-on-delivery flag (rawPayload.delivery).
    delivery: deliveryOf(o),
  }
}

/** A till delivery's stored details (rawPayload.delivery), or null. */
export function deliveryOf(o: { source: string; rawPayload: unknown; deliveryFeeCents?: number; deliveryNotes?: string | null }) {
  const raw = o.rawPayload as { channel?: unknown; delivery?: Record<string, unknown> } | null
  if (o.source !== 'manual' || raw?.channel !== 'till_delivery' || !raw.delivery) return null
  const d = raw.delivery
  return {
    cod: d.cod === true,
    name: typeof d.name === 'string' ? d.name : null,
    phone: typeof d.phone === 'string' ? d.phone : null,
    address: typeof d.address === 'string' ? d.address : null,
    notes: typeof d.notes === 'string' ? d.notes : null,
    zoneId: typeof d.zoneId === 'string' ? d.zoneId : null,
    zoneName: typeof d.zoneName === 'string' ? d.zoneName : null,
    feeCents: o.deliveryFeeCents ?? 0,
  }
}

/** Seat the ticket on its table (Table.status 'ordered', currentOrderId, currentPartySize). */
export async function occupyTableTx(tx: Prisma.TransactionClient, tableId: string, orderId: string, partySize: number | null): Promise<void> {
  await tx.table.update({ where: { id: tableId }, data: { status: 'ordered', currentOrderId: orderId, currentPartySize: partySize } })
}

/** Free every table this order holds (completion / cancel). Never throws. */
export async function releaseTablesOf(orderId: string): Promise<void> {
  try {
    const held = await prisma.table.findMany({ where: { currentOrderId: orderId }, select: { id: true } })
    for (const t of held) {
      // Another round still open on the table keeps it occupied.
      const next = await prisma.order.findFirst({
        where: { tableId: t.id, id: { not: orderId }, status: { in: [...OPEN_TICKET_STATUSES] }, deletedAt: null },
        orderBy: { placedAt: 'asc' },
        select: { id: true, partySize: true },
      })
      await prisma.table.updateMany({
        where: { id: t.id, currentOrderId: orderId },
        data: next
          ? { currentOrderId: next.id, currentPartySize: next.partySize }
          : { status: 'available', currentOrderId: null, currentPartySize: null, estimatedDepartureAt: null },
      })
    }
  } catch (err) {
    console.error(`[tables] release failed for order ${orderId}:`, (err as Error).message)
  }
}

/** Open orders (still on a table) — the one definition the board and the info panel share. */
export const OPEN_TICKET_STATUSES = ['received', 'confirmed', 'preparing', 'ready'] as const

/** 409 TABLE_OCCUPIED when another open order sits on the table. */
export async function assertTableFree(db: Db, tableId: string, exceptOrderId: string | null): Promise<void> {
  const other = await db.order.findFirst({
    where: { tableId, status: { in: [...OPEN_TICKET_STATUSES] }, deletedAt: null, ...(exceptOrderId && { id: { not: exceptOrderId } }) },
    select: { id: true },
  })
  if (other) throw new AppError('TABLE_OCCUPIED', `That table already has an open ticket (#${orderRefOf(other.id)})`, 409)
}
