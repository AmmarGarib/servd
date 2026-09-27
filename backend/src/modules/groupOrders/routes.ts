// Group orders. One initiator opens a shared cart at a brand, shares a code
// with friends. Each friend joins via the code and adds their items as a named
// member. Any member can submit; the resulting Order is one bill, which staff
// can then split across the diners via the existing /check-split flow.
//
// Auth: every route requires a logged-in customer session. The initial design
// allowed anonymous submission, but that path created kitchen tickets with no
// Payment row at all — anyone on the internet could fire free orders. Auth +
// a server-created `pending` Payment closes that hole; staff can still re-
// allocate the bill across diners with /check-split before settlement.

import type { FastifyInstance } from 'fastify'
import { randomBytes } from 'crypto'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireCustomerAuth } from '../auth/middleware.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { ingestOrder } from '../orders/service.js'
import { priceOrder } from '../../lib/pricing.js'
import type { OrderDTO } from '@servd/types'

function genShareCode(): string {
  // 6 chars from an unambiguous alphabet, sampled with CSPRNG (so attackers
  // can't recover the PRNG state from a leaked code and enumerate siblings).
  const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
  const bytes = randomBytes(6)
  let out = ''
  for (let i = 0; i < 6; i++) out += ALPHABET[bytes[i]! % ALPHABET.length]
  return out
}

export async function groupOrderRoutes(fastify: FastifyInstance) {
  // POST /group-orders — initiator creates
  fastify.post(
    '/',
    {
      preHandler: requireCustomerAuth,
      config: { rateLimit: { max: 20, timeWindow: '1 hour' } },
    },
    async (req, reply) => {
      const body = z.object({
        conceptSlug:    z.string().min(1),
        initiatorName:  z.string().min(1).max(120),
        closingMin:     z.number().int().min(5).max(180).default(45),
      }).parse(req.body)

      const concept = await prisma.concept.findFirst({
        where: { slug: body.conceptSlug, isActive: true, deletedAt: null },
      })
      if (!concept) throw new NotFoundError('Concept', body.conceptSlug)

      let code = genShareCode()
      for (let i = 0; i < 5; i++) {
        const exists = await prisma.groupOrder.findUnique({ where: { shareCode: code } })
        if (!exists) break
        code = genShareCode()
      }

      const go = await prisma.groupOrder.create({
        data: {
          conceptId:           concept.id,
          initiatorName:       body.initiatorName,
          initiatorCustomerId: req.customer!.id,
          shareCode:           code,
          closingAt:           new Date(Date.now() + body.closingMin * 60_000),
          members: {
            create: { displayName: body.initiatorName, customerId: req.customer!.id },
          },
        },
        include: { members: true },
      })
      return reply.status(201).send(go)
    },
  )

  // GET /group-orders/:code — read-only state for participants.
  // Rate-limited: 6-char share codes are the capability token here, so the
  // lookup endpoints must be too slow to enumerate (32^6 ≈ 1.07B codes).
  fastify.get<{ Params: { code: string } }>(
    '/:code',
    { preHandler: requireCustomerAuth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req) => {
      const code = req.params.code.toUpperCase()
      const go = await prisma.groupOrder.findUnique({
        where: { shareCode: code },
        include: {
          concept: { select: { id: true, name: true, slug: true, taxRate: true, taxRateCash: true } },
          members: { orderBy: { joinedAt: 'asc' } },
          items:   { orderBy: { createdAt: 'asc' } },
        },
      })
      if (!go) throw new NotFoundError('GroupOrder', code)
      return go
    },
  )

  // POST /group-orders/:code/join — new member
  fastify.post<{ Params: { code: string } }>(
    '/:code/join',
    { preHandler: requireCustomerAuth, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req) => {
      const code = req.params.code.toUpperCase()
      const body = z.object({ displayName: z.string().min(1).max(60) }).parse(req.body)
      const go = await prisma.groupOrder.findUnique({ where: { shareCode: code } })
      if (!go) throw new NotFoundError('GroupOrder', code)
      if (go.status !== 'open') throw new AppError('GROUP_LOCKED', `Group is ${go.status}`, 422)
      // Idempotency: if this customer already joined, return their existing
      // member row instead of erroring — they probably reloaded the page.
      const existing = await prisma.groupOrderMember.findFirst({
        where: { groupOrderId: go.id, customerId: req.customer!.id },
      })
      if (existing) return existing
      try {
        return await prisma.groupOrderMember.create({
          data: { groupOrderId: go.id, displayName: body.displayName, customerId: req.customer!.id },
        })
      } catch (err) {
        const e = err as { code?: string }
        if (e.code === 'P2002') throw new AppError('NAME_TAKEN', 'Someone in this group already used that name', 409)
        throw err
      }
    },
  )

  // POST /group-orders/:code/items — member adds an item
  fastify.post<{ Params: { code: string } }>(
    '/:code/items',
    // Quantity is capped per line but the number of lines was not, so one
    // member could bury a group — and the kitchen ticket — under thousands of
    // rows. A real table orders dozens of things, not hundreds.
    { preHandler: requireCustomerAuth, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (req) => {
      const code = req.params.code.toUpperCase()
      const body = z.object({
        menuItemId:     z.string().uuid(),
        quantity:       z.number().int().min(1).max(20).default(1),
        notes:          z.string().max(200).optional(),
      }).parse(req.body)

      const go = await prisma.groupOrder.findUnique({ where: { shareCode: code } })
      if (!go) throw new NotFoundError('GroupOrder', code)
      if (go.status !== 'open') throw new AppError('GROUP_LOCKED', `Group is ${go.status}`, 422)

      // Member is derived from the authenticated customer, not the request body.
      // Stops a participant from charging items to another diner's tab.
      const member = await prisma.groupOrderMember.findFirst({
        where: { groupOrderId: go.id, customerId: req.customer!.id },
      })
      if (!member) throw new AppError('NOT_A_MEMBER', 'Join the group before adding items', 403)

      const item = await prisma.menuItem.findFirst({
        where: { id: body.menuItemId, deletedAt: null, isAvailable: true, conceptId: go.conceptId },
        select: { id: true, name: true, priceCents: true },
      })
      if (!item) throw new NotFoundError('MenuItem', body.menuItemId)

      return prisma.groupOrderItem.create({
        data: {
          groupOrderId: go.id,
          memberId:     member.id,
          menuItemId:   item.id,
          name:         item.name,
          unitPriceCents: item.priceCents,
          quantity:     body.quantity,
          notes:        body.notes ?? null,
        },
      })
    },
  )

  // DELETE /group-orders/:code/items/:itemId — only the member who added it
  fastify.delete<{ Params: { code: string; itemId: string } }>(
    '/:code/items/:itemId',
    { preHandler: requireCustomerAuth },
    async (req, reply) => {
      const code = req.params.code.toUpperCase()
      const go = await prisma.groupOrder.findUnique({ where: { shareCode: code } })
      if (!go) throw new NotFoundError('GroupOrder', code)
      if (go.status !== 'open') throw new AppError('GROUP_LOCKED', `Group is ${go.status}`, 422)

      // Authorisation: caller must be the member who added the line.
      const line = await prisma.groupOrderItem.findFirst({
        where: { id: req.params.itemId, groupOrderId: go.id },
        include: { member: { select: { customerId: true } } },
      })
      if (!line) throw new NotFoundError('GroupOrderItem', req.params.itemId)
      if (line.member.customerId !== req.customer!.id) {
        throw new AppError('FORBIDDEN', 'You can only remove your own items', 403)
      }
      await prisma.groupOrderItem.delete({ where: { id: req.params.itemId } })
      return reply.status(204).send()
    },
  )

  // POST /group-orders/:code/lock — close cart for new items, ready to submit
  fastify.post<{ Params: { code: string } }>(
    '/:code/lock',
    { preHandler: requireCustomerAuth },
    async (req) => {
      const go = await prisma.groupOrder.findUnique({
        where: { shareCode: req.params.code.toUpperCase() },
        include: { members: { select: { customerId: true } } },
      })
      if (!go) throw new NotFoundError('GroupOrder', req.params.code)
      // Any member of the group can lock — same trust model as ordering at a
      // table: anyone at the table can call the server over.
      if (!go.members.some((m) => m.customerId === req.customer!.id)) {
        throw new AppError('FORBIDDEN', 'Only group members can lock the cart', 403)
      }
      return prisma.groupOrder.update({
        where: { id: go.id },
        data: { status: 'locked' },
      })
    },
  )

  // POST /group-orders/:code/submit — create the actual Order with all items.
  // Any group member can submit. The Order gets one Payment row in 'pending'
  // status totalling the whole bill — staff then either settle it as one
  // payment, or split it across members via POST /check-split/orders/:id/split.
  fastify.post<{ Params: { code: string } }>(
    '/:code/submit',
    { preHandler: requireCustomerAuth },
    async (req) => {
      const code = req.params.code.toUpperCase()
      const go = await prisma.groupOrder.findUnique({
        where: { shareCode: code },
        include: { items: { include: { member: true } }, members: true, concept: true },
      })
      if (!go) throw new NotFoundError('GroupOrder', code)
      if (go.orderId) {
        return { orderId: go.orderId, alreadySubmitted: true }
      }
      // A cancelled group must not still fire a ticket. Cancel doesn't set
      // orderId, and orderId was the only thing being checked here, so
      // cancel-then-submit sent the order to the kitchen anyway.
      if (go.status === 'cancelled') {
        throw new AppError('GROUP_CANCELLED', 'This group order was cancelled', 422)
      }
      if (go.items.length === 0) throw new AppError('NO_ITEMS', 'Group has no items', 422)

      // The blacklist applies here too. Storefront checkout refuses a banned
      // customer and the public reservation form refuses a banned phone or
      // email, but group-order submit checked neither — so a barred customer
      // could open a group, add the whole order themselves, and fire a kitchen
      // ticket through a door nobody was watching.
      // One mechanism, per company (owner decision 15): an active CustomerBan
      // raised by the group's brand's company blocks the submit.
      const submitter0 = await prisma.customer.findUnique({
        where: { id: req.customer!.id },
        select: { email: true, phone: true },
      })
      const { assertNotBannedAtCompany } = await import('../../lib/strikes.js')
      await assertNotBannedAtCompany({
        customerId: req.customer!.id,
        email:    submitter0?.email ?? null,
        phone:    submitter0?.phone ?? null,
        tenantId: go.concept.tenantId,
        ip:       req.ip ?? null,
        intent:   'order',
      })

      // Auth: submitter must be a group member (joining is required upstream,
      // but a stranger holding the shareCode is otherwise able to submit).
      if (!go.members.some((m) => m.customerId === req.customer!.id)) {
        throw new AppError('FORBIDDEN', 'Only group members can submit the order', 403)
      }

      // THE order pricing (lib/pricing.ts). A group order is one table's bill
      // settled at the till, so it takes the rate of the tender used there
      // (decision 9). That tender isn't known yet: it is priced at the cash
      // rate — the conservative side — and the till re-prices it if the table
      // pays by card (pos/service processPayment). Service charge as for a
      // till sale; item tax classes apply. (concept.taxRate, the legacy 17%,
      // is never read.)
      const lines = go.items.map((i) => ({ menuItemId: i.menuItemId, unitPriceCents: i.unitPriceCents, quantity: i.quantity }))
      const price = await priceOrder(lines, 'cash', 'group', go.concept)
      const taxCents = price.taxCents
      const total    = price.totalCents

      // Submitter is the "responsible diner" recorded on the Order; check-split
      // will re-allocate per-member from here.
      const submitter = await prisma.customer.findUnique({
        where: { id: req.customer!.id },
        select: { id: true, name: true },
      })

      // The order is created by ingestOrder, like every other channel. This
      // route used to insert the Order itself, so a group order skipped
      // everything ingestOrder does: items were never routed to a station
      // (they never showed on the per-station KDS), KDS / expo were never
      // pushed, stock was never deducted, course pacing and the customer
      // receipt never ran, the customer rollups were never bumped, and the
      // brand / unpriced-item guards were never applied.
      const dto: OrderDTO = {
        source: 'servd',
        // Idempotency key: ingestOrder dedupes on (source, external_id), so a
        // double-tapped submit gets the SAME order back instead of a second
        // ticket.
        external_id: `group-${go.shareCode}`,
        concept_id: go.conceptId,
        placed_at: new Date().toISOString(),
        customer_id: submitter?.id ?? null,
        customer_name: submitter?.name ?? go.initiatorName,
        items: go.items.map((i) => ({
          menuItemId: i.menuItemId,
          externalItemId: i.id,
          name: `${i.name} · ${i.member.displayName}`,
          quantity: i.quantity,
          unitPriceCents: i.unitPriceCents,
          notes: i.notes ?? undefined,
          modifiers: [],
        })),
        // No provider: the one Payment row is the pending 'split' created below.
        payment: { provider: null, amountCents: total, status: 'pending' },
        loyalty_points_earned: null,
        delivery_notes: null,
        estimated_pickup: null,
        tax_cents: taxCents,
        // A group bill is one table's bill split at the till (check-split),
        // so it stays dine-in — the fulfilment it has always been stored with.
        fulfilment_type: 'dine_in',
        raw_payload: { channel: 'group_order', shareCode: go.shareCode },
      }
      const { order, created } = await ingestOrder(dto, { price })

      // One pending Payment row so the check-split flow has something to
      // replace, and so an order without any Payment doesn't slip through
      // accounting reconciliation. Only the request that created the order
      // writes it — a concurrent submit got the same order back.
      if (created) {
        await prisma.payment.create({
          data: { orderId: order.id, method: 'split', amountCents: total, status: 'pending' },
        })
      }

      // Claim the group conditionally: only one writer can move it from
      // orderId=null. Both sides of a concurrent submit hold the same order
      // (ingestOrder's idempotency), so the loser just reports it.
      const claimed = await prisma.groupOrder.updateMany({
        where: { id: go.id, orderId: null },
        data: { status: 'submitted', orderId: order.id },
      })
      if (claimed.count === 0) {
        const fresh = await prisma.groupOrder.findUnique({ where: { id: go.id }, select: { orderId: true } })
        return { orderId: fresh?.orderId ?? order.id, alreadySubmitted: true }
      }

      return { orderId: order.id, total }
    },
  )

  // POST /group-orders/:code/cancel — any member can cancel before submit
  fastify.post<{ Params: { code: string } }>(
    '/:code/cancel',
    { preHandler: requireCustomerAuth },
    async (req) => {
      const go = await prisma.groupOrder.findUnique({
        where: { shareCode: req.params.code.toUpperCase() },
        include: { members: { select: { customerId: true } } },
      })
      if (!go) throw new NotFoundError('GroupOrder', req.params.code)
      if (!go.members.some((m) => m.customerId === req.customer!.id)) {
        throw new AppError('FORBIDDEN', 'Only group members can cancel', 403)
      }
      if (go.orderId) {
        throw new AppError('ALREADY_SUBMITTED', 'Order already submitted; cancel via /orders flow', 422)
      }
      return prisma.groupOrder.update({ where: { id: go.id }, data: { status: 'cancelled' } })
    },
  )
}
