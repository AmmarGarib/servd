// Site layout API.
//
// Storefront pages are stored as `Block[]` JSON keyed by slug.
//   "servd:home"     → the marketing homepage
//   "brand:simmer"   → Simmer microsite home
//   "brand:stax"     → Stax microsite home
//   etc.
//
// Reads are public (no auth) so the storefront can fetch without leaking
// credentials. Writes are manager-only and audit-logged.

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS } from '../auth/middleware.js'
import { audit } from '../../lib/audit.js'
import { AppError } from '../../lib/errors.js'

// Block validation — relaxed (allow extension fields), enforces shape on the
// known discriminator. We trust managers to not put garbage in; the renderer
// also defends with optional-chaining.
const blockSchema = z.object({
  id:         z.string().min(1),
  type:       z.string().min(1),
}).passthrough()

const blocksSchema = z.array(blockSchema).max(80)

export async function siteLayoutRoutes(fastify: FastifyInstance) {
  // List all layouts (admin index)
  fastify.get('/', { preHandler: requireAuth(...MANAGERS) }, async () => {
    return prisma.siteLayout.findMany({
      orderBy: { slug: 'asc' },
      select: { id: true, slug: true, title: true, updatedAt: true, publishedAt: true },
    })
  })

  // Public read — storefront fetches this on each page render (with revalidate)
  fastify.get<{ Params: { slug: string } }>(
    '/:slug',
    { config: { rateLimit: { max: 240, timeWindow: '1 minute' } } },
    async (req) => {
      const slug = decodeURIComponent(req.params.slug)
      const row = await prisma.siteLayout.findUnique({ where: { slug } })
      // Returning null lets the storefront fall back to its hard-coded default.
      // (Avoids 404 noise in logs.)
      return row ?? { slug, title: null, blocks: null, publishedAt: null, updatedAt: null }
    },
  )

  // Upsert — the operator hits "Save" in the dashboard editor.
  fastify.put<{ Params: { slug: string } }>(
    '/:slug',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const slug = decodeURIComponent(req.params.slug)
      const body = z.object({
        title:  z.string().max(120).optional(),
        blocks: blocksSchema,
      }).parse(req.body)

      // Defensive: don't allow more than 200KB of JSON
      if (JSON.stringify(body.blocks).length > 200_000) {
        throw new AppError('LAYOUT_TOO_LARGE', 'Layout exceeds 200KB. Slim it down.', 413)
      }

      const before = await prisma.siteLayout.findUnique({ where: { slug } })
      const saved = await prisma.siteLayout.upsert({
        where: { slug },
        create: {
          slug,
          title: body.title ?? slug,
          blocks: body.blocks as never,
          updatedById: req.staffUser?.id ?? null,
          publishedAt: new Date(),
        },
        update: {
          ...(body.title !== undefined && { title: body.title }),
          blocks: body.blocks as never,
          updatedById: req.staffUser?.id ?? null,
          publishedAt: new Date(),
        },
      })

      await audit({
        action: before ? 'layout.update' : 'layout.create',
        entity: 'SiteLayout',
        entityId: saved.id,
        userId: req.staffUser?.id ?? null,
        userEmail: req.staffUser?.email ?? null,
        before: before ? { blockCount: Array.isArray(before.blocks) ? (before.blocks as unknown[]).length : 0 } : null,
        after:  { slug: saved.slug, blockCount: body.blocks.length },
      })

      return saved
    },
  )

  // Reset to default (delete the row → storefront falls back to defaults)
  fastify.delete<{ Params: { slug: string } }>(
    '/:slug',
    { preHandler: requireAuth(...MANAGERS) },
    async (req, reply) => {
      const slug = decodeURIComponent(req.params.slug)
      await prisma.siteLayout.deleteMany({ where: { slug } })
      await audit({
        action: 'layout.reset', entity: 'SiteLayout',
        userId: req.staffUser?.id ?? null, userEmail: req.staffUser?.email ?? null,
        metadata: { slug },
      })
      return reply.status(204).send()
    },
  )
}
