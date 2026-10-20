// Till flow routes (owner, 2026-10-20) — registered at /pos next to posRoutes.
// Contract: ./TILL_FLOW.md. Not module-gated (/pos never is); roles CASHIERS.
// Every id from the client is resolved inside the company of the brand / order
// it is used with: a foreign brand / order is 404, a foreign waiter / customer /
// zone / table is 422.

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, CASHIERS } from '../auth/middleware.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { assertConceptOwned, assertShiftOf, scopeTenantWhere, shiftWhere } from '../../lib/tenantScope.js'
import { assertConceptAccess } from '../../lib/conceptAccess.js'
import { audit } from '../../lib/audit.js'
import { assertDrawerOperator, lockOrderTx, getZReport } from './service.js'
import {
  listWaiters, searchGuests, searchMenu, deliveryZonesFor, resolveWaiter, resolveGuest, assertCustomerAttachable,
  stampSettlementChannelTx, ORDER_INFO_SELECT, orderInfoView, assertTableFree, occupyTableTx, releaseTablesOf,
} from './tillFlow.js'
import { pushToKeenu, checkKeenuPush, keenuPushView } from './keenuPush.js'

const conceptQuery = z.object({ conceptId: z.string().uuid() })

/** The brand of a till lookup → its company (404 for a brand outside the caller's companies). */
async function brandCompany(req: FastifyRequest, conceptId: string): Promise<string> {
  const c = await assertConceptOwned(req, conceptId, 'write')
  await assertConceptAccess(req.staffUser!, conceptId)
  if (!c.tenantId) throw new AppError('NO_COMPANY', 'This brand is not bound to a company', 422)
  return c.tenantId
}

/** An order of the caller's companies ('write'), with its company — else 404. */
async function orderInScope(req: FastifyRequest, orderId: string) {
  const o = await prisma.order.findFirst({
    where: { id: orderId, deletedAt: null, concept: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) } },
    select: { id: true, conceptId: true, status: true, concept: { select: { tenantId: true } } },
  })
  if (!o?.concept.tenantId) throw new NotFoundError('Order', orderId)
  return { ...o, tenantId: o.concept.tenantId }
}

const OPEN = new Set(['received', 'confirmed', 'preparing', 'ready'])

export const guestBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(200).nullable().optional(),
  mobile: z.string().trim().max(30).nullable().optional(),
  phone: z.string().trim().max(30).nullable().optional(),
  registrationNo: z.string().trim().max(64).nullable().optional(),
})

const infoSchema = z.object({
  waiterEmployeeId: z.string().uuid().nullable().optional(),
  waiterCode: z.string().trim().min(1).max(40).optional(),
  partySize: z.number().int().min(1).max(500).nullable().optional(),
  customerId: z.string().uuid().nullable().optional(),
  guest: guestBodySchema.optional(),
  tableId: z.string().uuid().optional(),
  // A till delivery: switch cash-on-delivery ⇄ pay now (only while nothing is paid and the rider has not picked it up).
  delivery: z.object({ cod: z.boolean() }).optional(),
})

export async function posTillFlowRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /pos/waiters?conceptId&q&locationId — the brand's company's staff on the floor.
  fastify.get('/waiters', { preHandler: requireAuth(...CASHIERS) }, async (req) => {
    const q = conceptQuery.extend({ q: z.string().max(60).optional(), locationId: z.string().uuid().optional() }).parse(req.query ?? {})
    const tenantId = await brandCompany(req, q.conceptId)
    return { waiters: await listWaiters(tenantId, q.q, q.locationId ?? null) }
  })

  // GET /pos/guests?conceptId&q — the company's OWN customers by name / mobile / phone / email.
  fastify.get('/guests', { preHandler: requireAuth(...CASHIERS) }, async (req) => {
    const q = conceptQuery.extend({ q: z.string().max(100).default('') }).parse(req.query ?? {})
    const tenantId = await brandCompany(req, q.conceptId)
    return { guests: await searchGuests(tenantId, q.q) }
  })

  // GET /pos/menu/search?conceptId&q&categoryId — by item name or item code / SKU.
  fastify.get('/menu/search', { preHandler: requireAuth(...CASHIERS) }, async (req) => {
    const q = conceptQuery.extend({ q: z.string().max(100).default(''), categoryId: z.string().uuid().optional() }).parse(req.query ?? {})
    await brandCompany(req, q.conceptId)
    return { items: await searchMenu(q.conceptId, q.q, q.categoryId ?? null) }
  })

  // GET /pos/delivery-zones?conceptId — the brand's live delivery zones (fee before GST).
  fastify.get('/delivery-zones', { preHandler: requireAuth(...CASHIERS) }, async (req) => {
    const q = conceptQuery.parse(req.query ?? {})
    const tenantId = await brandCompany(req, q.conceptId)
    return { zones: await deliveryZonesFor(q.conceptId, tenantId) }
  })

  // GET /pos/orders/:orderId/info — the ticket's "Order information".
  fastify.get<{ Params: { orderId: string } }>('/orders/:orderId/info', { preHandler: requireAuth(...CASHIERS) }, async (req) => {
    const o = await orderInScope(req, z.string().uuid().parse(req.params.orderId))
    return orderInfoView(await prisma.order.findUniqueOrThrow({ where: { id: o.id }, select: ORDER_INFO_SELECT }))
  })

  // PATCH /pos/orders/:orderId/info — waiter (id or code), pax, guest (id or
  // new), table move. Open tickets only (409 ORDER_ENDED).
  fastify.patch<{ Params: { orderId: string } }>('/orders/:orderId/info', { preHandler: requireAuth(...CASHIERS) }, async (req) => {
    const body = infoSchema.parse(req.body ?? {})
    if (body.customerId && body.guest) throw new AppError('GUEST_ONE_OF', 'Pick a guest from the search OR enter a new one — not both', 400)
    const o = await orderInScope(req, z.string().uuid().parse(req.params.orderId))
    if (!OPEN.has(o.status)) throw new AppError('ORDER_ENDED', `This order is ${o.status} — its information cannot change`, 409)
    const waiter = body.waiterEmployeeId === null
      ? null
      : await resolveWaiter(prisma, o.tenantId, { waiterEmployeeId: body.waiterEmployeeId ?? null, waiterCode: body.waiterCode ?? null })
    if (body.customerId) await assertCustomerAttachable(prisma, o.tenantId, body.customerId)
    if (body.tableId) {
      const t = await prisma.table.findFirst({ where: { id: body.tableId, conceptId: o.conceptId, deletedAt: null }, select: { id: true } })
      if (!t) throw new AppError('TABLE_NOT_IN_BRAND', 'That table does not belong to this brand', 422)
    }
    const updated = await prisma.$transaction(async (tx) => {
      await lockOrderTx(tx, o.id)
      const cur = await tx.order.findUniqueOrThrow({ where: { id: o.id }, select: { status: true, tableId: true, partySize: true, fulfilmentType: true } })
      if (!OPEN.has(cur.status)) throw new AppError('ORDER_ENDED', `This order is ${cur.status} — its information cannot change`, 409)
      if (body.delivery) await switchCodTx(tx, o.id, body.delivery.cod)
      const guest = body.guest ? await resolveGuest(tx, o.tenantId, body.guest) : null
      if (body.tableId && body.tableId !== cur.tableId) {
        if (cur.fulfilmentType === 'delivery') throw new AppError('DELIVERY_HAS_NO_TABLE', 'A delivery is not seated at a table', 400)
        await assertTableFree(tx, body.tableId, o.id)
      }
      const data = {
        ...(waiter && { waiterEmployeeId: waiter.id }),
        ...(body.waiterEmployeeId === null && { waiterEmployeeId: null }),
        ...(body.partySize !== undefined && { partySize: body.partySize }),
        ...(body.customerId !== undefined && { customerId: body.customerId }),
        ...(guest && { customerId: guest.customerId, customerName: guest.name, ...(body.guest?.registrationNo !== undefined && { guestRegistrationNo: body.guest.registrationNo?.trim() || null }) }),
        ...(body.tableId && { tableId: body.tableId, fulfilmentType: 'dine_in' as const }),
      }
      await tx.order.update({ where: { id: o.id }, data })
      const tableId = body.tableId ?? cur.tableId
      if (body.tableId && cur.tableId && body.tableId !== cur.tableId) {
        await tx.table.updateMany({ where: { id: cur.tableId, currentOrderId: o.id }, data: { status: 'available', currentOrderId: null, currentPartySize: null } })
      }
      if (tableId) await occupyTableTx(tx, tableId, o.id, body.partySize !== undefined ? body.partySize : cur.partySize)
      return tx.order.findUniqueOrThrow({ where: { id: o.id }, select: ORDER_INFO_SELECT })
    })
    return orderInfoView(updated)
  })

  // PUT /pos/orders/:orderId/settlement-channel { channel: 'servd' } — close this
  // bill in servd (before taking money through any tender path: Pay, the card
  // machine, a Raast request, a split, on account).
  fastify.put<{ Params: { orderId: string } }>('/orders/:orderId/settlement-channel', { preHandler: requireAuth(...CASHIERS) }, async (req) => {
    const body = z.object({ channel: z.literal('servd') }).parse(req.body ?? {})
    const o = await orderInScope(req, z.string().uuid().parse(req.params.orderId))
    await prisma.$transaction(async (tx) => {
      await lockOrderTx(tx, o.id)
      await stampSettlementChannelTx(tx, o.id, body.channel)
    })
    return { orderId: o.id, settlementChannel: body.channel }
  })

  // POST /pos/orders/:orderId/keenu-push { shiftId, method, tipCents? } — Push to Keenu.
  fastify.post<{ Params: { orderId: string } }>('/orders/:orderId/keenu-push', { preHandler: requireAuth(...CASHIERS) }, async (req, reply) => {
    const body = z.object({
      shiftId: z.string().uuid(),
      method: z.enum(['cash', 'card']),
      tipCents: z.number().int().min(0).max(10_000_000).optional(),
    }).parse(req.body ?? {})
    const o = await orderInScope(req, z.string().uuid().parse(req.params.orderId))
    // The drawer: an OPEN shift of the order's company, the caller's own unless a manager.
    await assertShiftOf(o.tenantId, body.shiftId, true)
    await assertDrawerOperator(body.shiftId, req.staffUser!)
    const r = await pushToKeenu({ orderId: o.id, shiftId: body.shiftId, method: body.method, tipCents: body.tipCents, actor: req.staffUser! })
    if (r.state === 'settled' && !r.replayed) {
      await audit({
        category: 'accounting', action: 'order.keenu_push', entity: 'Order', entityId: o.id, userId: req.staffUser!.id, userEmail: req.staffUser!.email,
        tenantId: o.tenantId, metadata: { pushId: r.pushId, method: body.method, approvalRef: r.approvalRef },
      })
    }
    return reply.status(r.state === 'settled' ? 201 : 202).send(r)
  })

  // GET /pos/shifts/current/summary — "Order Summary": the CALLER's own open
  // drawer (never another cashier's), cashier-safe: no expected cash or
  // variance (the count stays blind). Totals, by tender, by settlement channel.
  fastify.get('/shifts/current/summary', { preHandler: requireAuth(...CASHIERS) }, async (req) => {
    const shift = await prisma.shift.findFirst({
      where: { userId: req.staffUser!.id, status: 'open', ...(await shiftWhere(req, 'write')) },
      orderBy: { openedAt: 'desc' },
      select: { id: true },
    })
    if (!shift) return { shift: null }
    return { shift: await drawerSummary(shift.id) }
  })

  // GET /pos/orders/:orderId/keenu-push — the push's state.
  fastify.get<{ Params: { orderId: string } }>('/orders/:orderId/keenu-push', { preHandler: requireAuth(...CASHIERS) }, async (req) => {
    const o = await orderInScope(req, z.string().uuid().parse(req.params.orderId))
    return keenuPushView(o.id)
  })

  // POST /pos/orders/:orderId/keenu-push/check — look a pending push up at Keenu and apply it.
  fastify.post<{ Params: { orderId: string } }>('/orders/:orderId/keenu-push/check', { preHandler: requireAuth(...CASHIERS) }, async (req, reply) => {
    const o = await orderInScope(req, z.string().uuid().parse(req.params.orderId))
    const r = await checkKeenuPush(o.id)
    return reply.status(r.state === 'settled' ? 200 : 202).send(r)
  })
}

export { releaseTablesOf }

/** The cashier-safe Order Summary of one drawer (the Z-report's sales figures + the settlement split). */
async function drawerSummary(shiftId: string) {
  const z = await getZReport(shiftId)
  const paid = await prisma.payment.findMany({
    where: { shiftId, status: 'paid', amountCents: { gt: 0 }, method: { not: 'comp' } },
    select: { amountCents: true, orderId: true, order: { select: { settlementChannel: true } } },
  })
  const by = { keenu: { orders: 0, amountCents: 0 }, servd: { orders: 0, amountCents: 0 }, none: { orders: 0, amountCents: 0 } }
  const seen = { keenu: new Set<string>(), servd: new Set<string>(), none: new Set<string>() }
  for (const p of paid) {
    const k = (p.order.settlementChannel ?? 'none') as keyof typeof by
    by[k].amountCents += p.amountCents
    if (!seen[k].has(p.orderId)) { seen[k].add(p.orderId); by[k].orders += 1 }
  }
  return {
    shiftId: z.shiftId,
    openedAt: z.openedAt,
    ordersCount: z.ordersCount,
    grossCents: z.grossCents,
    salesExTipsCents: z.salesExTipsCents,
    taxCents: z.taxCents,
    tipsCents: z.tipsCents,
    serviceChargeCents: z.serviceChargeCents,
    discountCents: z.discountCents,
    compCents: z.compCents,
    refundsCents: z.refundsCents,
    byTender: {
      cashCents: z.cashSales, cardCents: z.cardSales, raastCents: z.raastSales, onAccountCents: z.onAccountSales,
      walletCents: z.walletSales, giftCardCents: z.giftCardCents,
    },
    bySettlement: by,
    openTickets: z.openTickets,
  }
}

/**
 * A till delivery's cash on delivery ⇄ pay now (till flow, 2026-10-20), inside
 * the info PATCH's order-locked transaction. Only a till delivery (400
 * NOT_A_TILL_DELIVERY), with no money paid (409 ALREADY_PAID) and not yet
 * picked up by the rider (409 ALREADY_PICKED_UP).
 *   cod true  → one PENDING cash payment for the bill (lib/cod.ts COD money once
 *               delivered), the bill closed in servd;
 *   cod false → the pending COD cash row is marked 'failed' with
 *               gatewayMeta.voided (never COD money again); the bill is paid at
 *               the counter (any settlement).
 */
async function switchCodTx(tx: import('@prisma/client').Prisma.TransactionClient, orderId: string, cod: boolean): Promise<void> {
  const { isTillDelivery } = await import('../../lib/tillDelivery.js')
  const o = await tx.order.findUniqueOrThrow({
    where: { id: orderId },
    select: { source: true, rawPayload: true, totalCents: true, pickedUpAt: true, payments: { select: { id: true, method: true, status: true, amountCents: true, gatewayMeta: true } } },
  })
  if (!isTillDelivery(o)) throw new AppError('NOT_A_TILL_DELIVERY', 'Only a delivery rung up at the till has cash on delivery', 400)
  if (o.pickedUpAt) throw new AppError('ALREADY_PICKED_UP', 'The rider already has this order — its payment cannot change now', 409)
  if (o.payments.some((p) => p.status === 'paid' && p.amountCents > 0)) throw new AppError('ALREADY_PAID', 'Money is already taken on this bill', 409)
  const raw = (o.rawPayload ?? {}) as { delivery?: Record<string, unknown> } & Record<string, unknown>
  const pendingCash = o.payments.filter((p) => p.method === 'cash' && p.status === 'pending' && p.amountCents > 0)
  if (cod) {
    if (pendingCash.length === 0) {
      await tx.payment.create({ data: { orderId, method: 'cash', amountCents: o.totalCents, status: 'pending' } })
    }
    await stampSettlementChannelTx(tx, orderId, 'servd')
  } else {
    for (const p of pendingCash) {
      const meta = (p.gatewayMeta && typeof p.gatewayMeta === 'object' && !Array.isArray(p.gatewayMeta)) ? p.gatewayMeta as Record<string, unknown> : {}
      await tx.payment.update({
        where: { id: p.id },
        data: { status: 'failed', processedAt: new Date(), gatewayMeta: { ...meta, voided: { reason: 'cod_switched_to_pay_now', at: new Date().toISOString() } } },
      })
    }
  }
  await tx.order.update({ where: { id: orderId }, data: { rawPayload: { ...raw, delivery: { ...(raw.delivery ?? {}), cod } } } })
}
