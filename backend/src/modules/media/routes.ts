import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS, ALL_STAFF } from '../auth/middleware.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { scopeTenantWhere } from '../../lib/tenantScope.js'

const CATEGORIES = ['menu', 'marketing', 'shoot', 'kds', 'general'] as const

// Media assets are company property: MediaAsset.tenantId is stamped with the
// uploader's ACTIVE company, the library lists only the companies in view, and
// delete is 404 for another company's asset. The table used to be global —
// any staff member browsed, and any manager deleted, every company's imagery.

export async function mediaRoutes(fastify: FastifyInstance) {
  // GET /media/upload-url?filename&contentType&category
  fastify.get<{
    Querystring: { filename: string; contentType: string; category?: string }
  }>(
    '/upload-url',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      const { filename, contentType, category = 'general' } = req.query
      const tenantId = req.staffUser?.tenantId
      if (!tenantId) throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company first', 422)
      const { getSignedUploadUrl } = await import('../../lib/storage.js')
      const result = await getSignedUploadUrl(filename, contentType, category)

      // Pre-create the MediaAsset record (url is public after upload completes)
      const asset = await prisma.mediaAsset.create({
        data: {
          tenantId,
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
          ...(await scopeTenantWhere(req, 'read')),
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
      const asset = await prisma.mediaAsset.findFirst({
        where: { id: req.params.id, ...(await scopeTenantWhere(req, 'write')) },
        select: { id: true },
      })
      if (!asset) throw new NotFoundError('MediaAsset', req.params.id)
      await prisma.mediaAsset.delete({ where: { id: asset.id } })
      return reply.status(204).send()
    },
  )
}
