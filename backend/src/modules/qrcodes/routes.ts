import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS } from '../auth/middleware.js'
import { NotFoundError } from '../../lib/errors.js'

const createQrSchema = z.object({
  conceptId: z.string().uuid(),
  tableId: z.string().uuid().optional(),
  orderType: z.enum(['dine-in', 'pickup']).default('dine-in'),
  label: z.string().min(1),
})

export async function qrCodeRoutes(fastify: FastifyInstance) {
  // GET /qrcodes
  fastify.get<{ Querystring: { conceptId?: string } }>(
    '/',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      return prisma.qrCode.findMany({
        where: req.query.conceptId ? { conceptId: req.query.conceptId } : {},
        include: {
          concept: { select: { name: true, slug: true } },
          table: { select: { label: true } },
        },
        orderBy: { createdAt: 'desc' },
      })
    },
  )

  // POST /qrcodes
  fastify.post('/', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = createQrSchema.parse(req.body)
    const qr = await prisma.qrCode.create({ data: body })
    // Build QR URL pointing to storefront with qr param
    const storefrontUrl = process.env['STOREFRONT_URL'] ?? 'http://localhost:3002'
    const concept = await prisma.concept.findUnique({ where: { id: body.conceptId }, select: { slug: true } })
    const qrUrl = `${storefrontUrl}/${concept?.slug ?? 'order'}?qr=${qr.id}&table=${body.tableId ?? ''}&type=${body.orderType}`
    await prisma.qrCode.update({ where: { id: qr.id }, data: { qrImageUrl: qrUrl } })
    return reply.status(201).send({ ...qr, qrImageUrl: qrUrl })
  })

  // POST /qrcodes/:id/scan — increment scan count (called by storefront on QR load)
  fastify.post<{ Params: { id: string } }>(
    '/:id/scan',
    async (req) => {
      const qr = await prisma.qrCode.update({
        where: { id: req.params.id },
        data: { scanCount: { increment: 1 } },
        select: { id: true, scanCount: true, orderType: true, table: { select: { label: true } } },
      })
      return qr
    },
  )

  // POST /qrcodes/:id/convert — increment conversion (called when order placed via QR)
  fastify.post<{ Params: { id: string } }>(
    '/:id/convert',
    async (req) => {
      await prisma.qrCode.update({
        where: { id: req.params.id },
        data: { conversions: { increment: 1 } },
      })
      return { ok: true }
    },
  )

  // PATCH /qrcodes/:id
  fastify.patch<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const body = createQrSchema.partial().omit({ conceptId: true }).parse(req.body)
      return prisma.qrCode.update({ where: { id: req.params.id }, data: body })
    },
  )

  // DELETE /qrcodes/:id
  fastify.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      await prisma.qrCode.delete({ where: { id: req.params.id } })
      return reply.status(204).send()
    },
  )
}
