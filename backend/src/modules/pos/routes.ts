import type { FastifyInstance } from 'fastify'
import { zBackdatedReason } from '../nightAudit/backdate.js'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, CASHIERS, MANAGERS, FINANCE_TEAM } from '../auth/middleware.js'
import { createPosOrder, processPayment, settlePayment, openShift, closeShift, getZReport, voidOrderItem, refundOrder, compOrder, recordCashMovement, quoteOrderForTender, quotePosOrder, assertDrawerOperator, openTicketsOnDrawer, keenuQrRetired, addItemsToPosOrder } from './service.js'
import { EXPENSE_PAYOUT_CATEGORIES, EXPENSE_PAYOUT_KEYS, type PayoutCategory } from '../accounting/expenseCategories.js'
import { assertConceptAccess } from '../../lib/conceptAccess.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { scopeTenantWhere, assertConceptOwned, shiftWhere, findShiftInScope, assertShiftOf } from '../../lib/tenantScope.js'
import { buildReceiptHtml, buildReceiptData } from './receipt.js'
import { assertShiftHasNoActiveCharges } from '../../connectors/terminal/guard.js'
import { audit } from '../../lib/audit.js'
import { REFUND_TENDERS, legacyRingUpTender } from '../../lib/tenders.js'
import { resolveWaiter, resolveGuest } from './tillFlow.js'
import { guestBodySchema } from './tillFlowRoutes.js'
import type { RaastTenderMeta } from './raastTender.js'
import { COD_PAY_IN_HOURS, codDueWhere, codStatusOf, codHoursSince } from '../../lib/cod.js'

// ─── Company scoping ──────────────────────────────────────────────────────────
//
// Which company a shift belongs to is answered by lib/tenantScope.ts
// (shiftOfCompany / findShiftInScope / assertShiftOf): Shift.tenantId, with the
// location and then the cashier as fallbacks ONLY for rows that predate it.
// A guessed shift id from another company 404s exactly like a foreign order.

// One line of a ring-up. Add-on prices are taken from the menu server-side
// (resolvePosLines — FOH-08); a client priceDeltaCents only matters for a
// free-text add-on, which may not lower the price.
const posItemSchema = z.object({
  // menuItemId may legitimately be null for manual line items (open-priced
  // walk-in orders); validate as uuid only when set.
  menuItemId: z.string().uuid().nullable().default(null),
  name: z.string(),
  quantity: z.number().int().min(1),
  unitPriceCents: z.number().int().min(0),
  notes: z.string().optional(),
  course: z.number().int().optional(),
  modifiers: z
    .array(
      z.object({
        name: z.string(),
        priceDeltaCents: z.number().int().default(0),
        modifierId: z.string().uuid().optional(),
      }),
    )
    .default([]),
  // Removals ("No onions", owner 2026-10-27): lines of the dish's approved plate recipe to leave out — from
  // GET /menu/items/:id/removable. Checked by orders/service prepareOrderLines (422 INGREDIENT_NOT_ON_RECIPE).
  removedIngredients: z
    .array(
      z.object({
        masterIngredientId: z.string().uuid().nullish(),
        inventoryItemId: z.string().uuid().nullish(),
        prepRecipeId: z.string().uuid().nullish(),
        key: z.string().max(80).nullish(),
        name: z.string().max(200).nullish(),
      }),
    )
    .max(40)
    .optional(),
})

// The tender the bill is priced for (decision 9: cash 15% / card or Raast QR —
// the digital group — 8%). Not chosen → cash; the payment re-prices if the
// customer pays the other way. Ring-up and the ring-up quote accept the
// retired 'keenu_qr' ONLY as a legacy alias of the digital rate, so an
// offline-queued pre-deploy ring-up never 400s: it is priced as 'raast'.
const ringUpTenderSchema = z.enum(['cash', 'card', 'raast', 'keenu_qr']).transform((m): 'cash' | 'card' | 'raast' => {
  const t = legacyRingUpTender(m)
  return t === 'keenu_qr' ? 'raast' : t
})

// A tender money is taken with (payments, settles, the quote for a payment).
// 'keenu_qr' parses, so the service can answer 422 KEENU_QR_RETIRED rather
// than a bare validation error.
const tillTenderSchema = z.enum(['cash', 'card', 'raast', 'keenu_qr'])

/**
 * Raast QR (spec D9): the cashier checked the money arrived on the COUNTER
 * device (bank SMS / merchant app — never the customer's screen) and ticks it.
 * Required with every Raast reference the till types (400 RAAST_NOT_VERIFIED
 * without it). Only `true` is accepted.
 */
const raastVerifiedSchema = z.literal(true).optional()

/** The server-side Raast meta of a cashier-typed reference (never a client body's own `raast`). */
function cashierRaast(raastVerified: true | undefined): RaastTenderMeta {
  return { via: 'cashier', cashierVerified: raastVerified === true }
}


const posOrderSchema = z.object({
  conceptId: z.string().uuid(),
  // B08: tighten FK fields. Sending "not-a-uuid" used to bubble up as a 500
  // because Prisma rejected the value mid-transaction; now the Zod gate
  // rejects with a clear 400.
  tableId: z.string().uuid().nullable().optional(),
  customerId: z.string().uuid().nullable().optional(),
  shiftId: z.string().uuid().nullable().optional(),
  items: z.array(posItemSchema),
  discountCents: z.number().int().min(0).default(0),
  discountReason: z.string().optional(),
  managerOverridePin: z.string().min(4).max(8).optional(),     // required when discount/override exceeds cashier cap
  // Client-generated key, stable across retries of the SAME ring-up, so a
  // double-tap or an offline-queue resend dedupes to ONE order instead of
  // firing duplicate tickets. Absent → the server generates a UUID (FOH-06).
  idempotencyKey: z.string().min(8).max(100).optional(),
  paymentMethod: ringUpTenderSchema.optional(),
  // ── Till flow (owner, 2026-10-20; TILL_FLOW.md) ──
  fulfilmentType: z.enum(['dine_in', 'takeout', 'delivery']).optional(),
  waiterEmployeeId: z.string().uuid().optional(),
  waiterCode: z.string().trim().min(1).max(40).optional(),
  partySize: z.number().int().min(1).max(500).optional(),
  guest: guestBodySchema.optional(),
  delivery: z.object({
    name: z.string().trim().min(1).max(120),
    phone: z.string().trim().min(7).max(30),
    address: z.string().trim().min(3).max(400),
    notes: z.string().trim().max(400).nullable().optional(),
    zoneId: z.string().min(1).max(64).nullable().optional(),
    cod: z.boolean(),
  }).optional(),
})

const posQuoteSchema = z.object({
  conceptId: z.string().uuid(),
  items: z.array(posItemSchema).min(1),
  discountCents: z.number().int().min(0).default(0),
  paymentMethod: ringUpTenderSchema.optional(),
  // Till flow: a delivery's fee (before GST) from its zone, GST on top (H9).
  fulfilmentType: z.enum(['dine_in', 'takeout', 'delivery']).optional(),
  zoneId: z.string().min(1).max(64).nullable().optional(),
})

const paymentSchema = z.object({
  orderId: z.string().uuid(),
  shiftId: z.string().uuid(),
  payments: z.array(
    z.object({
      // F-PAY02: dropped wallet methods. No 'comp': a comp is not a tender,
      // it goes through POST /pos/orders/:id/comp (caps, PIN, audit). No
      // 'split': that is the group-order placeholder, not money — split the
      // bill (check-split) and settle each portion.
      method: tillTenderSchema,
      // What this tender takes: its share of the bill PLUS its tip.
      amountCents: z.number().int().min(0),
      tenderedCents: z.number().int().min(0).optional(),
      // The card terminal's reference number — required for card (owner
      // decision 4); for Raast QR the bank reference (transaction ID) from
      // the bank SMS / merchant app on the counter phone — required,
      // validated, unique per company.
      gatewayRef: z.string().trim().max(120).optional(),
      // Raast QR: "I saw it arrive on the counter phone" — required with a
      // Raast reference (spec D9).
      raastVerified: raastVerifiedSchema,
      // Till flow (2026-10-20): cash handed over above the bill kept as a TIP
      // (cashier chose tip, not change) — added to amountCents and tipCents.
      excessAsTip: z.boolean().optional(),
      gateway: z.enum(['keenu', 'jazzcash', 'easypaisa', 'none']).optional(),
      // FOH-14: the part of amountCents that is a tip (→ Order.tipCents).
      tipCents: z.number().int().min(0).optional(),
      // The card machine is connected but offline: the cashier keyed the
      // slip reference by hand (spec §7.13) — recorded in gatewayMeta and
      // audited with the payment. (terminalChargeId / gateway 'card_terminal'
      // are never accepted from a client: only the server records a charge.)
      manualReason: z.enum(['terminal_offline']).optional(),
    }),
  ),
  // FOH-04: one key per "Pay" submission, reused by its retries.
  idempotencyKey: z.string().min(8).max(100).optional(),
  // Till flow (2026-10-20): 'servd' = close this bill in servd (its revenue to
  // the brand's servd sub-account; its fiscal document filed by hand).
  settlementChannel: z.literal('servd').optional(),
})

const openShiftSchema = z.object({
  openingFloatCents: z.number().int().min(0).default(0),
})

const closeShiftSchema = z.object({
  closingFloatCents: z.number().int().min(0),
  notes: z.string().optional(),
  // FOH-21: close although unpaid tickets are still open on the drawer
  // (409 OPEN_TICKETS lists them otherwise).
  confirmOpenTickets: z.boolean().optional(),
})

export async function posRoutes(fastify: FastifyInstance) {
  // POST /pos/orders — create an order at the till
  // Cashier must have access to the concept they're ringing under (IDOR §C6).
  fastify.post('/orders', { preHandler: requireAuth(...CASHIERS) }, async (req, reply) => {
    const body = posOrderSchema.parse(req.body)
    await assertConceptAccess(req.staffUser!, body.conceptId)
    // A ring-up binds a NEW order to a brand, so the brand must belong to the
    // company the operator is acting in — not merely one they're a member of.
    const tenantId = req.staffUser!.tenantId
    if (!tenantId) throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company before ringing up an order', 422)
    await assertConceptOwned(req, body.conceptId, 'create')

    // Everything the order attaches to must be that brand's / company's own:
    // the table (brand-anchored), every catalogue line (brand-anchored — a
    // foreign item would route the ticket to the other brand's KDS station)
    // and the drawer.
    if (body.tableId) {
      const table = await prisma.table.findFirst({
        where: { id: body.tableId, conceptId: body.conceptId, deletedAt: null },
        select: { id: true },
      })
      if (!table) throw new AppError('TABLE_NOT_IN_BRAND', 'That table does not belong to this brand', 422)
    }
    // Till flow (2026-10-20): the waiter and the guest inside the brand's company.
    if (body.customerId && body.guest) throw new AppError('GUEST_ONE_OF', 'Pick a guest from the search OR enter a new one — not both', 400)
    if (body.delivery && body.fulfilmentType !== 'delivery') throw new AppError('DELIVERY_NEEDS_FULFILMENT', 'Send fulfilmentType "delivery" with the delivery details', 400)
    const waiter = await resolveWaiter(prisma, tenantId, { waiterEmployeeId: body.waiterEmployeeId ?? null, waiterCode: body.waiterCode ?? null })
    let customerId = body.customerId ?? null
    let customerName: string | null = null
    if (body.guest) {
      const g = await resolveGuest(prisma, tenantId, body.guest)
      customerId = g.customerId
      customerName = g.name
    } else if (body.delivery) {
      // A delivery's customer: the name and phone typed for it.
      const g = await resolveGuest(prisma, tenantId, { name: body.delivery.name, mobile: body.delivery.phone })
      customerId = customerId ?? g.customerId
      customerName = g.name
    }
    const menuItemIds = Array.from(new Set(body.items.map((i) => i.menuItemId).filter((x): x is string => !!x)))
    if (menuItemIds.length > 0) {
      const owned = await prisma.menuItem.count({
        where: { id: { in: menuItemIds }, conceptId: body.conceptId, deletedAt: null },
      })
      if (owned !== menuItemIds.length) throw new AppError('ITEM_NOT_IN_BRAND', 'One or more items do not belong to this brand', 422)
    }
    if (body.shiftId) await assertShiftOf(tenantId, body.shiftId, false)

    const { guest, waiterCode: _code, waiterEmployeeId: _wid, ...rest } = body
    const order = await createPosOrder({
      ...rest,
      customerId,
      customerName,
      waiterEmployeeId: waiter?.id ?? null,
      guestRegistrationNo: guest?.registrationNo ?? null,
      staffId: req.staffUser!.id,
      staffRole: req.staffUser!.role,
    })
    return reply.status(201).send(order)
  })

  // POST /pos/orders/:orderId/items — more items on a ticket already sent to
  // the kitchen, on the SAME ticket (owner, 2026-10-22; TILL_FLOW.md §4).
  // Only an open till ticket with no money on it yet; the rules are the
  // ring-up's (service.ts addItemsToPosOrder). Foreign order → 404.
  fastify.post<{ Params: { orderId: string } }>('/orders/:orderId/items', { preHandler: requireAuth(...CASHIERS) }, async (req, reply) => {
    const orderId = z.string().uuid().parse(req.params.orderId)
    const body = z.object({
      items: z.array(posItemSchema).min(1).max(50),
      managerOverridePin: z.string().min(4).max(8).optional(),
      reason: z.string().trim().max(300).optional(),
      idempotencyKey: z.string().min(8).max(100).optional(),
    }).parse(req.body)
    const order = await prisma.order.findFirst({
      where: { id: orderId, concept: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) } },
      select: { id: true, conceptId: true },
    })
    if (!order) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Order not found in your active company' } })
    await assertConceptAccess(req.staffUser!, order.conceptId)
    const r = await addItemsToPosOrder({
      orderId: order.id,
      items: body.items,
      staffId: req.staffUser!.id,
      staffRole: req.staffUser!.role,
      managerOverridePin: body.managerOverridePin ?? null,
      reason: body.reason ?? null,
      idempotencyKey: body.idempotencyKey ?? null,
    })
    return reply.status(r.replayed ? 200 : 201).send(r)
  })

  // POST /pos/payments — take tenders at the till for what is due. Returns
  // `fiscal` (the sale's FiscalView once the bill completes; the till's
  // bounded attempt to file it), the deprecated `srb` alias (spec §8.4) and
  // `raast` ([{receiptId, status, bankRef, confirmedVia, smsConfirmed}] for a
  // Raast QR tender — 'provisional' until the bank statement matches it).
  // 409 TERMINAL_CHARGE_ACTIVE while the card machine works on this bill;
  // 409 RAAST_AWAITING while a Raast request waits for the customer's
  // transfer; 422 KEENU_QR_RETIRED for the retired Keenu QR.
  fastify.post('/payments', { preHandler: requireAuth(...CASHIERS) }, async (req, reply) => {
    const body = paymentSchema.parse(req.body)
    const order = await prisma.order.findFirst({
      where: {
        id: body.orderId,
        concept: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) },
      },
      select: { id: true, concept: { select: { tenantId: true } } },
    })
    if (!order?.concept.tenantId) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Order not found in your active company' } })
    // The drawer must be an OPEN shift of the order's own company, and the
    // caller's own unless they are a manager (FOH-15).
    await assertShiftOf(order.concept.tenantId, body.shiftId, true)
    await assertDrawerOperator(body.shiftId, req.staffUser!)
    const result = await processPayment({
      orderId: body.orderId,
      shiftId: body.shiftId,
      idempotencyKey: body.idempotencyKey,
      actorId: req.staffUser!.id,
      ...(body.settlementChannel && { settlementChannel: body.settlementChannel }),
      // A Raast reference typed at the till is the cashier's, with their
      // counter-device tick — the server sets the tender's Raast meta.
      payments: body.payments.map(({ raastVerified, ...p }) => ({
        ...p,
        ...(p.method === 'raast' && { raast: cashierRaast(raastVerified) }),
      })),
    })
    // A card slip keyed by hand while the card machine is offline (spec §7.13): audited.
    const keyed = body.payments.filter((p) => p.manualReason)
    if (keyed.length > 0 && !result.replayed) {
      await audit({
        category: 'identity', action: 'terminal.manual_reference', entity: 'Order', entityId: order.id,
        userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId: order.concept.tenantId,
        metadata: { reason: 'terminal_offline', tenders: keyed.map((p) => ({ method: p.method, amountCents: p.amountCents, gatewayRef: p.gatewayRef ?? null })), paymentIds: result.payments.map((p) => p.id) },
      })
    }
    return reply.status(201).send(result)
  })

  // GET /pos/orders/:orderId/quote?method=cash|card|raast — what POST
  // /pos/payments will demand for this order paid that way (re-priced for the
  // tender while nothing is paid yet; Raast QR at the card rate). Read-only;
  // the same function the payment prices with (quoteOrderForTender /
  // tenderPriceOf). keenu_qr → 422 KEENU_QR_RETIRED (a quote for a payment).
  fastify.get<{ Params: { orderId: string }; Querystring: { method?: string } }>(
    '/orders/:orderId/quote',
    { preHandler: requireAuth(...CASHIERS) },
    async (req, reply) => {
      const { method } = z.object({ method: tillTenderSchema.default('cash') }).parse(req.query)
      if (method === 'keenu_qr') throw keenuQrRetired()
      const order = await prisma.order.findFirst({
        where: { id: req.params.orderId, concept: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) } },
        select: { id: true },
      })
      if (!order) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Order not found in your active company' } })
      return quoteOrderForTender(order.id, method)
    },
  )

  // POST /pos/quote — what a ring-up WOULD be billed (add-ons at menu price,
  // THE pricing function, the tender's GST). Writes nothing.
  fastify.post('/quote', { preHandler: requireAuth(...CASHIERS) }, async (req) => {
    const body = posQuoteSchema.parse(req.body)
    // Priced for the brand as a ring-up would bind it: the ACTIVE company's
    // (a foreign brand 404s).
    await assertConceptOwned(req, body.conceptId, 'create')
    await assertConceptAccess(req.staffUser!, body.conceptId)
    const menuItemIds = Array.from(new Set(body.items.map((i) => i.menuItemId).filter((x): x is string => !!x)))
    if (menuItemIds.length > 0) {
      const owned = await prisma.menuItem.count({
        where: { id: { in: menuItemIds }, conceptId: body.conceptId, deletedAt: null },
      })
      if (owned !== menuItemIds.length) throw new AppError('ITEM_NOT_IN_BRAND', 'One or more items do not belong to this brand', 422)
    }
    return quotePosOrder({ ...body, delivery: body.fulfilmentType === 'delivery' ? { zoneId: body.zoneId ?? null } : null })
  })

  // POST /pos/payments/:id/settle — take the money for ONE pending payment row
  // on an open drawer: a check-split portion, or a storefront cash-on-delivery
  // amount the rider pays into the till (owner decision 4 — it lands on this
  // drawer's Z-report). The one settle (settlePayment), shared with
  // /check-split and the Keenu webhook. A Raast QR portion takes its bank
  // reference and `raastVerified: true` (the counter-device tick); a pending
  // Keenu QR portion → 422 KEENU_QR_RETIRED (take the rest with Pay).
  fastify.post<{ Params: { id: string } }>(
    '/payments/:id/settle',
    { preHandler: requireAuth(...CASHIERS) },
    async (req) => {
      const body = z.object({
        shiftId: z.string().uuid(),
        gatewayRef: z.string().trim().max(120).optional(),
        tenderedCents: z.number().int().min(0).optional(),
        raastVerified: raastVerifiedSchema,
      }).parse(req.body)
      const payment = await prisma.payment.findFirst({
        where: { id: req.params.id, order: { concept: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) } } },
        select: { id: true, order: { select: { concept: { select: { tenantId: true } } } } },
      })
      if (!payment) throw new NotFoundError('Payment', req.params.id)
      // TILL-R7: the drawer must be an open one of the ORDER's company before
      // anything is said about whose it is — another company's drawer and a
      // made-up id answer the same (422), never "that is someone's drawer".
      await assertShiftOf(payment.order.concept.tenantId, body.shiftId, true)
      // FOH-15: onto the caller's own drawer, unless a manager.
      await assertDrawerOperator(body.shiftId, req.staffUser!)
      return settlePayment({
        paymentId: payment.id, via: 'till', shiftId: body.shiftId, gatewayRef: body.gatewayRef, tenderedCents: body.tenderedCents,
        actorId: req.staffUser!.id, raast: cashierRaast(body.raastVerified),
      })
    },
  )

  // GET /pos/cod-due — delivered cash-on-delivery orders whose cash has not
  // been paid into a drawer yet, for the rider pay-in screen. What counts as
  // COD and its status come from the ONE definition, lib/cod.ts (codDueWhere,
  // codStatusOf, COD_PAY_IN_HOURS). Each row names the rider holding the cash,
  // how long it has been out (hoursSinceDelivered, from the drop-off — else
  // completion), its `status` (with_rider / overdue / rider_owes /
  // at_counter) and, when finance booked it as owed by the rider (H5, 1351),
  // `riderOwes` { at, byName }. `overdue` stays for older clients. Nothing
  // posts from here.
  fastify.get('/cod-due', { preHandler: requireAuth(...CASHIERS) }, async (req) => {
    const rows = await prisma.payment.findMany({
      where: codDueWhere({ deletedAt: null, ...(await scopeTenantWhere(req, 'write')) }),
      select: {
        id: true, amountCents: true, createdAt: true, codRiderDebtAt: true, codRiderDebtById: true,
        order: {
          select: {
            id: true, completedAt: true, deliveredAt: true, customerName: true, fulfilmentType: true, riderId: true,
            concept: { select: { name: true } },
            rider: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
      take: 200,
    })
    const bookerIds = [...new Set(rows.map((p) => p.codRiderDebtById).filter((id): id is string => !!id))]
    const bookers = new Map(bookerIds.length === 0 ? [] : (await prisma.user.findMany({
      where: { id: { in: bookerIds } }, select: { id: true, name: true },
    })).map((u) => [u.id, u.name]))
    const now = new Date()
    return {
      overdueAfterHours: COD_PAY_IN_HOURS,
      payments: rows.map(({ codRiderDebtById, ...p }) => {
        const status = codStatusOf(p, p.order, now)
        const hoursSinceDelivered = codHoursSince(p, p.order, now)
        return {
          ...p,
          rider: p.order.rider ?? null,
          hoursSinceDelivered,
          status,
          riderOwes: p.codRiderDebtAt ? { at: p.codRiderDebtAt, byName: (codRiderDebtById && bookers.get(codRiderDebtById)) || null } : null,
          // Older clients: past the pay-in time (whatever the status says now).
          overdue: hoursSinceDelivered >= COD_PAY_IN_HOURS,
        }
      }),
    }
  })

  // GET /pos/shifts/current — the caller's open drawer, or null.
  //
  // The server is the source of truth for "which drawer am I on". Each device
  // used to keep its own shiftId in local storage, so a drawer closed from
  // anywhere else (a manager closing it from /reconciliation, the other till)
  // stranded it: every payment 422'd and every close 400'd with no way out.
  // Clients re-sync from here on launch and focus, and whenever a call comes
  // back SHIFT_CLOSED or SHIFT_NOT_IN_COMPANY. A cashier has at most one open
  // shift (openShift refuses a second), in any company they belong to.
  fastify.get('/shifts/current', { preHandler: requireAuth(...CASHIERS) }, async (req) => {
    const shift = await prisma.shift.findFirst({
      where: { userId: req.staffUser!.id, status: 'open', ...(await shiftWhere(req, 'write')) },
      orderBy: { openedAt: 'desc' },
      select: { id: true, openedAt: true, openingFloatCents: true, tenantId: true },
    })
    return { shift }
  })

  // POST /pos/shifts/open
  fastify.post('/shifts/open', { preHandler: requireAuth(...CASHIERS) }, async (req, reply) => {
    const { openingFloatCents } = openShiftSchema.parse(req.body)
    const shift = await openShift(req.staffUser!.id, openingFloatCents, req.staffUser!.tenantId)
    return reply.status(201).send(shift)
  })

  // POST /pos/shifts/close
  fastify.post<{ Params: { id: string } }>(
    '/shifts/:id/close',
    { preHandler: requireAuth(...CASHIERS) },
    async (req, reply) => {
      const { closingFloatCents, notes, confirmOpenTickets } = closeShiftSchema.parse(req.body)
      // Closing an EXISTING drawer: any company the operator belongs to.
      const shift = await findShiftInScope(req, req.params.id, 'write')
      // Ownership: a cashier may only close their OWN shift. Closing someone
      // else's drawer (to bury a variance or shift blame onto the closer) is a
      // manager-tier action.
      if (shift.userId !== req.staffUser!.id && !MANAGERS.includes(req.staffUser!.role)) {
        return reply.status(403).send({ error: { code: 'NOT_YOUR_SHIFT', message: 'Only the shift owner or a manager can close this shift' } })
      }
      // §7.10: a drawer with a card-machine charge (or card refund) still in
      // flight cannot close — 409 SHIFT_HAS_ACTIVE_CHARGE {charges}.
      await assertShiftHasNoActiveCharges(shift.id)
      const closed = await closeShift(req.params.id, closingFloatCents, notes, { confirmOpenTickets })
      // Who closed the drawer (the Shift row keeps only who ran it). Read by
      // shift corrections: finance never corrects a drawer it ran or closed
      // (shiftCorrections/service.ts assertNotOwnDrawer).
      await audit({
        category: 'accounting', action: 'pos.shift.close', entity: 'Shift', entityId: shift.id,
        userId: req.staffUser!.id, userEmail: req.staffUser!.email ?? null, tenantId: shift.tenantId ?? null,
        after: { status: 'closed', closingFloatCents }, metadata: { actorRole: req.staffUser!.role, shiftUserId: shift.userId },
      })
      // A sign-in lasts one shift (owner B1, 2026-10-26): the drawer's cashier
      // is signed out once its close has had time to show the Z-report.
      const { endSessionsForClosedDrawer } = await import('../auth/sessionEnd.js')
      const row = await prisma.shift.findUnique({ where: { id: shift.id }, select: { closedAt: true } })
      await endSessionsForClosedDrawer(shift.userId, row?.closedAt ?? new Date())
      return closed
    },
  )

  // GET /pos/shifts/:id/open-tickets — the unpaid tickets that hold this
  // drawer's close (409 OPEN_TICKETS), so the till can name them before the
  // cashier confirms "close anyway". Same access as the close: the drawer's
  // own cashier or a manager, in a company the operator belongs to.
  fastify.get<{ Params: { id: string } }>(
    '/shifts/:id/open-tickets',
    { preHandler: requireAuth(...CASHIERS) },
    async (req, reply) => {
      const shift = await findShiftInScope(req, req.params.id, 'write')
      if (shift.userId !== req.staffUser!.id && !MANAGERS.includes(req.staffUser!.role)) {
        return reply.status(403).send({ error: { code: 'NOT_YOUR_SHIFT', message: 'Only the shift owner or a manager can see this drawer' } })
      }
      return openTicketsOnDrawer(shift.id)
    },
  )

  // GET /pos/shifts/:id/zreport — managers, and finance (BOOKS-02: the
  // reconciliation module finance holds by default reads drawers' Z-reports).
  fastify.get<{ Params: { id: string } }>(
    '/shifts/:id/zreport',
    { preHandler: requireAuth(...FINANCE_TEAM) },
    async (req) => {
      // View-aware: the active company, or every company in "All companies".
      const shift = await findShiftInScope(req, req.params.id, 'read')
      return getZReport(shift.id)
    },
  )

  // GET /pos/receipt/:orderId — the FULL & FINAL bill as printable HTML. Same
  // data as /pos/orders/:orderId/receipt-data (one builder, pos/receipt.ts).
  // An open order answers 409 PRE_BILL_REQUIRED (§17.1) — print a pre-bill
  // (POST /pos/orders/:id/pre-bill). ?duplicate=1 marks a reprint (FOH-23); a
  // refunded / cancelled order is always bannered.
  fastify.get<{ Params: { orderId: string }; Querystring: { duplicate?: string } }>(
    '/receipt/:orderId',
    { preHandler: requireAuth(...CASHIERS) },
    async (req, reply) => {
      const order = await prisma.order.findFirst({
        where: {
          id: req.params.orderId,
          concept: { deletedAt: null, ...(await scopeTenantWhere(req, 'read')) },
        },
        select: { id: true },
      })
      if (!order) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Order not found in your active company' } })
      const duplicate = ['1', 'true', 'yes'].includes(String(req.query.duplicate ?? '').toLowerCase())
      const html = await buildReceiptHtml(order.id, { duplicate })
      return reply.type('text/html').send(html)
    },
  )

  // POST /pos/orders/:orderId/void — void a single line item.
  // §17.4: EVERY void needs a manager — the signed-in user is one, or a valid
  // manager PIN of the order's company is sent (403 MANAGER_OVERRIDE_REQUIRED
  // / INVALID_MANAGER_PIN). The manager cap (RefundPolicy.managerVoidLimitCents)
  // still applies; the approver is always recorded. On a paid, still-open bill
  // whose line goes back by Raast QR, the manager sends it from the bank first
  // and `refundReference` is that outgoing transfer's reference (409
  // RAAST_REFUND_REFERENCE_REQUIRED {amountCents} without it).
  fastify.post<{ Params: { orderId: string } }>(
    '/orders/:orderId/void',
    { preHandler: requireAuth(...CASHIERS) },
    async (req, reply) => {
      const body = z.object({
        orderItemId: z.string().uuid(),
        reason: z.string().min(1).max(200),
        managerOverridePin: z.string().optional(),     // required unless the signed-in user is a manager
        refundReference: z.string().trim().max(120).optional(),
        // The CEO's reason when the bill is from an earlier sales day (night audit; 403 CEO_ONLY_BACKDATED otherwise).
        backdatedReason: zBackdatedReason,
      }).parse(req.body)
      // Company scope through the shared helper — a null tenantFilter would
      // otherwise match every company-less brand.
      const order = await prisma.order.findFirst({
        where: {
          id: req.params.orderId,
          concept: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) },
        },
      })
      if (!order) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Order not found in your active company' } })
      const result = await voidOrderItem({
        orderId: req.params.orderId,
        orderItemId: body.orderItemId,
        reason: body.reason,
        actorId: req.staffUser!.id,
        actorRole: req.staffUser!.role,
        managerOverridePin: body.managerOverridePin,
        refundReference: body.refundReference,
        backdatedReason: body.backdatedReason,
      })
      return reply.status(200).send(result)
    },
  )

  // POST /pos/orders/:orderId/comp — comp the entire order (or a portion).
  // Comp = on-the-house, no payment expected, but tracked as a P&L line.
  fastify.post<{ Params: { orderId: string } }>(
    '/orders/:orderId/comp',
    { preHandler: requireAuth(...CASHIERS) },
    async (req, reply) => {
      const body = z.object({
        amountCents: z.number().int().min(1),
        reason: z.string().min(1).max(200),
        // The open drawer the comp is rung on — the Z-report's comps and the
        // shift journal entry's 7030 line only see comps that sit on a shift.
        shiftId: z.string().uuid(),
        photoUrl: z.string().url().optional(),
        managerOverridePin: z.string().optional(),
        // A staff meal (owner decision 11): who ate. The meal is comped in
        // full with a manager PIN and appears in the staff-meal log.
        // Either a login id or the HR employee code — the till only knows the code.
        staffMealFor: z.string().min(1).max(64).optional(),
        // The CEO's reason when the bill is from an earlier sales day (night audit).
        backdatedReason: zBackdatedReason,
      }).parse(req.body)
      const order = await prisma.order.findFirst({
        where: {
          id: req.params.orderId,
          concept: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) },
        },
        select: { id: true, concept: { select: { tenantId: true } } },
      })
      if (!order) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Order not found in your active company' } })
      // Like a payment: the drawer must be an OPEN shift of the order's own
      // company, and the caller's own unless they are a manager (FOH-15).
      await assertShiftOf(order.concept.tenantId, body.shiftId, true)
      await assertDrawerOperator(body.shiftId, req.staffUser!)
      // A staff meal names a member of THIS company: resolve a code or a login
      // id to the staff member's login, never trust a foreign id.
      let staffMealUserId: string | undefined
      if (body.staffMealFor) {
        const tenantId = order.concept.tenantId
        if (!tenantId) return reply.status(422).send({ error: { code: 'NO_COMPANY', message: 'This brand belongs to no company; a staff meal needs one' } })
        const emp = await prisma.hrEmployee.findFirst({
          where: { tenantId, status: { in: ['active', 'on_leave'] }, OR: [{ employeeCode: body.staffMealFor }, { userId: body.staffMealFor }] },
          select: { userId: true, fullName: true },
        })
        const user = !emp && /^[0-9a-f-]{36}$/i.test(body.staffMealFor)
          ? await prisma.user.findFirst({ where: { id: body.staffMealFor, OR: [{ tenantId }, { tenantMemberships: { some: { tenantId } } }] }, select: { id: true } })
          : null
        staffMealUserId = emp?.userId ?? user?.id ?? undefined
        if (!staffMealUserId) return reply.status(422).send({ error: { code: 'STAFF_NOT_IN_COMPANY', message: `No staff member "${body.staffMealFor}" with a login in this company — check the employee code` } })
      }
      const result = await compOrder({
        orderId: req.params.orderId,
        shiftId: body.shiftId,
        amountCents: body.amountCents,
        reason: body.reason,
        photoUrl: body.photoUrl,
        actorId: req.staffUser!.id,
        actorRole: req.staffUser!.role,
        managerOverridePin: body.managerOverridePin,
        backdatedReason: body.backdatedReason,
        ...(staffMealUserId && { staffMeal: { staffId: staffMealUserId } }),
      })
      return reply.status(200).send(result)
    },
  )

  // ─── Mid-shift cash movements ──────────────────────────────────────────
  // POST /pos/shifts/:id/cash-movements
  // GET  /pos/shifts/:id/cash-movements
  //
  // Cashier can log a drop (cash to safe), add (small bills in), payout
  // (paid a vendor from drawer), or payin (refund from vendor). Each
  // affects the expected drawer total at close.
  fastify.post<{ Params: { id: string } }>(
    '/shifts/:id/cash-movements',
    { preHandler: requireAuth(...CASHIERS) },
    async (req, reply) => {
      const body = z.object({
        type:        z.enum(['drop', 'add', 'payout', 'payin']),
        amountCents: z.number().int().min(1),
        reason:      z.string().min(1).max(200),
        managerOverridePin: z.string().min(4).max(8).optional(),
        // Pay-out to a vendor (owner decision 5): what it paid for, or the
        // supplier bill it pays. Manager PIN and the pay-out cap apply. Only
        // the 'expense' categories: the 'cogs' keys (kitchen food / drinks /
        // packaging) are petty-cash history-backfill picks, never a pay-out.
        category:       z.enum(EXPENSE_PAYOUT_KEYS).optional(),
        supplierBillId: z.string().uuid().nullable().optional(),
        vendorName:     z.string().max(120).nullable().optional(),
        receiptUrl:     z.string().url().nullable().optional(),
      }).parse(req.body)

      // Recording against an EXISTING drawer: any company the operator belongs to.
      const shift = await findShiftInScope(req, req.params.id, 'write')
      if (shift.status !== 'open') {
        return reply.status(400).send({ error: { code: 'SHIFT_CLOSED', message: 'Cannot record cash movements on a closed shift' } })
      }
      // Ownership: cash drops/payouts hit the drawer the cashier is accountable
      // for — only the shift owner or a manager may record them.
      if (shift.userId !== req.staffUser!.id && !MANAGERS.includes(req.staffUser!.role)) {
        return reply.status(403).send({ error: { code: 'NOT_YOUR_SHIFT', message: 'Only the shift owner or a manager can record cash movements' } })
      }

      // The PIN is verified, never stored (the old route wrote it to the row).
      const movement = await recordCashMovement({
        shiftId: shift.id,
        type: body.type,
        amountCents: body.amountCents,
        reason: body.reason,
        actorId: req.staffUser!.id,
        actorRole: req.staffUser!.role,
        managerOverridePin: body.managerOverridePin,
        // zod checked it against the 'expense' PAYOUT_CATEGORIES above.
        category: body.category as PayoutCategory | undefined,
        supplierBillId: body.supplierBillId ?? null,
        vendorName: body.vendorName ?? null,
        receiptUrl: body.receiptUrl ?? null,
      })
      return reply.status(201).send(movement)
    },
  )

  // GET /pos/payout-categories — what a till pay-out can be for: the
  // 'expense' PAYOUT_CATEGORIES only (the 'cogs' keys are history picks).
  fastify.get('/payout-categories', { preHandler: requireAuth(...CASHIERS) }, async () => ({ categories: EXPENSE_PAYOUT_CATEGORIES }))

  fastify.get<{ Params: { id: string } }>(
    '/shifts/:id/cash-movements',
    { preHandler: requireAuth(...CASHIERS) },
    async (req) => {
      const shift = await findShiftInScope(req, req.params.id, 'read')
      const movements = await prisma.cashMovement.findMany({
        where: { shiftId: shift.id },
        orderBy: { recordedAt: 'desc' },
        include: { recordedBy: { select: { name: true } } },
      })
      return { movements }
    },
  )

  // GET /pos/orders/:orderId/receipt-data — the full & final bill as data, for
  // the tablet's thermal printer (ReceiptOrder in tablet/src/lib/printer.ts).
  // Same builder as the HTML receipt: stored tax and total, modifiers in the
  // subtotal, heading FULL & FINAL BILL, the sale's fiscal document, the card
  // slip, and the legacy fbr / srb keys for installed tablets. 409
  // PRE_BILL_REQUIRED for an open order (§17.1).
  fastify.get<{ Params: { orderId: string } }>(
    '/orders/:orderId/receipt-data',
    { preHandler: requireAuth(...CASHIERS) },
    async (req, reply) => {
      const order = await prisma.order.findFirst({
        where: {
          id: req.params.orderId,
          concept: { deletedAt: null, ...(await scopeTenantWhere(req, 'read')) },
        },
        select: { id: true },
      })
      if (!order) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Order not found in your active company' } })
      return buildReceiptData(order.id)
    },
  )

  // POST /pos/orders/:orderId/refund — THE refund engine's route (refundOrder).
  // /refunds, the order page and the till all call this. Caps + manager PIN
  // (403 MANAGER_OVERRIDE_REQUIRED → prompt for a PIN and resend), any amount
  // up to what is still refundable, the cash out of an OPEN drawer (owner
  // decision 3), its own journal entry, the fiscal return document
  // (`fiscalRefund`; `srbReturnInvoiceNo` is deprecated, always null), and
  // status 'refunded' once in full. A Raast QR refund is sent from the bank
  // first: `gatewayRef` is the outgoing transfer's reference (400
  // RAAST_REFUND_REF_REQUIRED) and a manager always approves it. An old Keenu
  // QR sale is refunded by keenu_qr, exactly as before.
  fastify.post<{ Params: { orderId: string } }>(
    '/orders/:orderId/refund',
    { preHandler: requireAuth(...CASHIERS) },
    async (req, reply) => {
      const body = z.object({
        amountCents: z.number().int().min(1),
        reason: z.string().trim().min(3).max(200),
        photoUrl: z.string().url().optional(),
        managerOverridePin: z.string().optional(),
        // How the money goes back (defaults to the tender of the sale). Only
        // a tender the order was actually paid with (ONL-16).
        method: z.enum(REFUND_TENDERS).optional(),
        // Raast QR: the outgoing bank transfer's reference.
        gatewayRef: z.string().trim().max(120).optional(),
        // The open drawer a cash refund leaves from (defaults to the
        // refunder's own open drawer).
        shiftId: z.string().uuid().optional(),
      }).parse(req.body)
      // Refunding an EXISTING order: any company the operator belongs to,
      // through the shared helper (never the raw tenantFilter).
      const order = await prisma.order.findFirst({
        where: {
          id: req.params.orderId,
          concept: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) },
        },
        select: { id: true, concept: { select: { tenantId: true } } },
      })
      if (!order) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Order not found in your active company' } })
      // A named drawer must be an OPEN drawer of the order's company — and
      // the caller's own unless they are a manager: cash must not leave
      // another cashier's drawer (FOH-15).
      if (body.shiftId) {
        await assertShiftOf(order.concept.tenantId, body.shiftId, true)
        await assertDrawerOperator(body.shiftId, req.staffUser!)
      }
      const result = await refundOrder({
        orderId: order.id,
        amountCents: body.amountCents,
        reason: body.reason,
        photoUrl: body.photoUrl,
        actorId: req.staffUser!.id,
        actorRole: req.staffUser!.role,
        managerOverridePin: body.managerOverridePin,
        method: body.method,
        gatewayRef: body.gatewayRef,
        shiftId: body.shiftId ?? null,
      })
      return reply.status(200).send(result)
    },
  )
}
