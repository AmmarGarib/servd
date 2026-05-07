import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS, ALL_STAFF } from '../auth/middleware.js'

const CATEGORIES = ['menu', 'marketing', 'shoot', 'kds', 'general'] as const

export async function mediaRoutes(fastify: FastifyInstance) {
  // GET /media/upload-url?filename&contentType&category
  fastify.get<{
    Querystring: { filename: string; contentType: string; category?: string }
  }>(
    '/upload-url',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const { filename, contentType, category = 'general' } = req.query
      const { getSignedUploadUrl } = await import('../../lib/storage.js')
      const result = await getSignedUploadUrl(filename, contentType, category)

      // Pre-create the MediaAsset record (url is public after upload completes)
      const asset = await prisma.mediaAsset.create({
        data: {
          key:          result.key,
          url:          result.publicUrl,
          filename,
          contentType,
          category,
          uploadedById: req.staffUser!.id,
        },
      })

      return { ...result, assetId: asset.id }
    },
  )

  // GET /media?category=
  fastify.get<{ Querystring: { category?: string; limit?: string; cursor?: string } }>(
    '/',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const limit  = Math.min(parseInt(req.query.limit ?? '50', 10), 200)
      const cat    = req.query.category
      const cursor = req.query.cursor

      const assets = await prisma.mediaAsset.findMany({
        where: {
          ...(cat && CATEGORIES.includes(cat as typeof CATEGORIES[number]) ? { category: cat } : {}),
          ...(cursor ? { id: { lt: cursor } } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: limit + 1,
      })

      const hasMore = assets.length > limit
      if (hasMore) assets.pop()

      return { data: assets, cursor: hasMore ? (assets[assets.length - 1]?.id ?? null) : null, hasMore }
    },
  )

  // DELETE /media/:id — managers only; removes DB record (R2 object stays for CDN cache)
  fastify.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      await prisma.mediaAsset.delete({ where: { id: req.params.id } })
      return reply.status(204).send()
    },
  )
}
