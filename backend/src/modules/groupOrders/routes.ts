// Group orders. One initiator opens a shared cart at a brand. Friends join
// via a share code, each adds their own items as a named member. Whoever
// closes the cart submits as one Order; the bill can then be split via the
// existing /check-split flow.

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { AppError, NotFoundError } from '../../lib/errors.js'

function genShareCode(): string {
  // 6 chars, alphabet without ambiguous letters
  const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
  return Array.from({ length: 6 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('')
}

export async function groupOrderRoutes(fastify: FastifyInstance) {
  // POST /group-orders — initiator creates
  fastify.post(
    '/',
    { config: { rateLimit: { max: 20, timeWindow: '1 hour' } } },
    async (req, reply) => {
      const body = z.object({
        conceptSlug:    z.string().min(1),
        initiatorName:  z.string().min(1).max(120),
        initiatorCustomerId: z.string().uuid().nullable().optional(),
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
          initiatorCustomerId: body.initiatorCustomerId ?? null,
          shareCode:           code,
          closingAt:           new Date(Date.now() + body.closingMin * 60_000),
          members: {
            create: { displayName: body.initiatorName, customerId: body.initiatorCustomerId ?? null },
          },
        },
        include: { members: true },
      })
      return reply.status(201).send(go)
    },
  )

  // GET /group-orders/:code — read-only state for participants
  fastify.get<{ Params: { code: string } }>(
    '/:code',
    async (req) => {
      const code = req.params.code.toUpperCase()
      const go = await prisma.groupOrder.findUnique({
        where: { shareCode: code },
        include: {
          concept: { select: { id: true, name: true, slug: true, taxRate: true } },
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
    async (req) => {
      const code = req.params.code.toUpperCase()
      const body = z.object({ displayName: z.string().min(1).max(60), customerId: z.string().uuid().nullable().optional() }).parse(req.body)
      const go = await prisma.groupOrder.findUnique({ where: { shareCode: code } })
      if (!go) throw new NotFoundError('GroupOrder', code)
      if (go.status !== 'open') throw new AppError('GROUP_LOCKED', `Group is ${go.status}`, 422)
      try {
        return await prisma.groupOrderMember.create({
          data: { groupOrderId: go.id, displayName: body.displayName, customerId: body.customerId ?? null },
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
    async (req) => {
      const code = req.params.code.toUpperCase()
      const body = z.object({
        memberId:       z.string().uuid(),
        menuItemId:     z.string().uuid(),
        quantity:       z.number().int().min(1).max(20).default(1),
        notes:          z.string().max(200).optional(),
      }).parse(req.body)

      const go = await prisma.groupOrder.findUnique({ where: { shareCode: code } })
      if (!go) throw new NotFoundError('GroupOrder', code)
      if (go.status !== 'open') throw new AppError('GROUP_LOCKED', `Group is ${go.status}`, 422)

      const item = await prisma.menuItem.findFirst({
        where: { id: body.menuItemId, deletedAt: null, isAvailable: true, conceptId: go.conceptId },
        select: { id: true, name: true, priceCents: true },
      })
      if (!item) throw new NotFoundError('MenuItem', body.menuItemId)

      return prisma.groupOrderItem.create({
        data: {
          groupOrderId: go.id,
          memberId:     body.memberId,
          menuItemId:   item.id,
          name:         item.name,
          unitPriceCents: item.priceCents,
          quantity:     body.quantity,
          notes:        body.notes ?? null,
        },
      })
    },
  )

  // DELETE /group-orders/:code/items/:itemId
  fastify.delete<{ Params: { code: string; itemId: string } }>(
    '/:code/items/:itemId',
    async (req, reply) => {
      const code = req.params.code.toUpperCase()
      const go = await prisma.groupOrder.findUnique({ where: { shareCode: code } })
      if (!go) throw new NotFoundError('GroupOrder', code)
      if (go.status !== 'open') throw new AppError('GROUP_LOCKED', `Group is ${go.status}`, 422)
      await prisma.groupOrderItem.delete({ where: { id: req.params.itemId } })
      return reply.status(204).send()
    },
  )

  // POST /group-orders/:code/lock — close cart for new items, ready to submit
  fastify.post<{ Params: { code: string } }>('/:code/lock', async (req) => {
    const go = await prisma.groupOrder.findUnique({ where: { shareCode: req.params.code.toUpperCase() } })
    if (!go) throw new NotFoundError('GroupOrder', req.params.code)
    return prisma.groupOrder.update({
      where: { id: go.id },
      data: { status: 'locked' },
    })
  })

  // POST /group-orders/:code/submit — create the actual Order with all items
  fastify.post<{ Params: { code: string } }>(
    '/:code/submit',
    async (req) => {
      const code = req.params.code.toUpperCase()
      const go = await prisma.groupOrder.findUnique({
        where: { shareCode: code },
        include: { items: { include: { member: true } }, concept: true },
      })
      if (!go) throw new NotFoundError('GroupOrder', code)
      if (go.orderId) {
        return { orderId: go.orderId, alreadySubmitted: true }
      }
      if (go.items.length === 0) throw new AppError('NO_ITEMS', 'Group has no items', 422)

      const subtotal = go.items.reduce((s, i) => s + i.unitPriceCents * i.quantity, 0)
      const taxRate  = go.concept.taxRate / 100
      const taxCents = Math.round(subtotal * taxRate)
      const total    = subtotal + taxCents

      const order = await prisma.order.create({
        data: {
          conceptId:    go.conceptId,
          source:       'servd',
          externalId:   `group-${go.shareCode}`,
          status:       'received',
          totalCents:   total,
          taxCents,
          customerName: go.initiatorName,
          placedAt:     new Date(),
          items: {
            create: go.items.map((i) => ({
              menuItemId:    i.menuItemId,
              externalItemId: i.id,
              name:          `${i.name} · ${i.member.displayName}`,
              quantity:      i.quantity,
              unitPriceCents: i.unitPriceCents,
              notes:         i.notes ?? null,
              status:        'pending' as never,
            })),
          },
        },
      })

      await prisma.groupOrder.update({
        where: { id: go.id },
        data: { status: 'submitted', orderId: order.id },
      })
      return { orderId: order.id, total }
    },
  )

  // POST /group-orders/:code/cancel
  fastify.post<{ Params: { code: string } }>('/:code/cancel', async (req) => {
    const go = await prisma.groupOrder.findUnique({ where: { shareCode: req.params.code.toUpperCase() } })
    if (!go) throw new NotFoundError('GroupOrder', req.params.code)
    return prisma.groupOrder.update({ where: { id: go.id }, data: { status: 'cancelled' } })
  })
}
