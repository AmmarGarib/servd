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
  //
  // Per-IP rate-limited and de-duplicated: an IP can only register one scan
  // per QR per minute. Without this an attacker could spam either endpoint
  // and inflate the conversion-rate KPI that managers use to decide where
  // to spend their next QR-tabletop printing budget.
  fastify.post<{ Params: { id: string } }>(
    '/:id/scan',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req) => {
      const ip = req.ip ?? 'unknown'
      const dedupKey = `qrscan:${req.params.id}:${ip}`
      try {
        const { redis } = await import('../../lib/redis.js')
        const fresh = await redis.set(dedupKey, '1', 'EX', 60, 'NX')
        // Already counted this IP in the last minute — skip the write but
        // still return the QR shape the storefront expects.
        if (fresh !== 'OK') {
          const cached = await prisma.qrCode.findUnique({
            where: { id: req.params.id },
            select: { id: true, scanCount: true, orderType: true, table: { select: { label: true } } },
          })
          if (!cached) throw new NotFoundError('QrCode', req.params.id)
          return cached
        }
      } catch (err) {
        // Redis down → fall through to the increment. Worst case we count a
        // duplicate scan; better than 500ing the QR-landing page.
        if (err instanceof NotFoundError) throw err
      }
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
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req) => {
      // Same dedup approach as /scan — one conversion per (IP, QR) per minute.
      const ip = req.ip ?? 'unknown'
      const dedupKey = `qrconvert:${req.params.id}:${ip}`
      try {
        const { redis } = await import('../../lib/redis.js')
        const fresh = await redis.set(dedupKey, '1', 'EX', 60, 'NX')
        if (fresh !== 'OK') return { ok: true, dedup: true }
      } catch { /* Redis down → fall through */ }
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
