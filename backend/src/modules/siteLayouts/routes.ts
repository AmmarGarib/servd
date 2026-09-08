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
//
// Company ownership: SiteLayout carries no tenantId/conceptId — it is keyed
// purely by slug — so ownership is derived from the slug:
//   "brand:<conceptSlug>[:page]" → owned by the brand's company (Concept.slug
//                                  is globally unique, so this is unambiguous)
//   "servd:*"                    → the shared platform pages; they present every
//                                  company's brands, so only an admin may write
// Anything else cannot be attributed to a company and is rejected on write.

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, MANAGERS, ADMIN_ONLY } from '../auth/middleware.js'
import { audit } from '../../lib/audit.js'
import { AppError, ForbiddenError, NotFoundError } from '../../lib/errors.js'
import { scopeTenantWhere, type ScopeMode } from '../../lib/tenantScope.js'

// Block validation — relaxed (allow extension fields), enforces shape on the
// known discriminator. We trust managers to not put garbage in; the renderer
// also defends with optional-chaining.
const blockSchema = z.object({
  id:         z.string().min(1),
  type:       z.string().min(1),
}).passthrough()

const blocksSchema = z.array(blockSchema).max(80)

type LayoutOwner = { kind: 'platform' } | { kind: 'brand'; conceptSlug: string } | null

function parseLayoutSlug(slug: string): LayoutOwner {
  if (slug.startsWith('servd:')) return { kind: 'platform' }
  if (slug.startsWith('brand:')) {
    const conceptSlug = slug.slice('brand:'.length).split(':')[0] ?? ''
    return conceptSlug ? { kind: 'brand', conceptSlug } : null
  }
  return null
}

/**
 * Throws unless the caller may write the layout at `slug` in `mode`:
 *   • brand:<slug>… — the brand must belong to a company in scope ('create'
 *     = the active company only, 'write' = every company the operator is in).
 *     404 rather than 403 so a foreign slug doesn't confirm the brand exists.
 *   • servd:*       — admin only (the page is shared across every company).
 *   • anything else — 422; it can't be attributed to a company.
 */
async function assertLayoutSlugOwned(req: FastifyRequest, slug: string, mode: ScopeMode): Promise<void> {
  const owner = parseLayoutSlug(slug)
  if (!owner) {
    throw new AppError('LAYOUT_SLUG_INVALID', 'Layout slug must be "servd:<page>" or "brand:<brand-slug>[:page]"', 422)
  }
  if (owner.kind === 'platform') {
    if (!ADMIN_ONLY.includes(req.staffUser!.role)) {
      throw new ForbiddenError('Only an admin can edit the shared servd pages')
    }
    return
  }
  if (mode === 'create' && !req.staffUser!.tenantId) {
    throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company before saving a brand page', 422)
  }
  const concept = await prisma.concept.findFirst({
    where: { slug: owner.conceptSlug, deletedAt: null, ...(await scopeTenantWhere(req, mode)) },
    select: { id: true },
  })
  if (!concept) throw new NotFoundError('SiteLayout', slug)
}

export async function siteLayoutRoutes(fastify: FastifyInstance) {
  // List layouts (admin index) — the shared servd:* pages plus the layouts of
  // brands in the operator's company (every member company in "All
  // companies" view). Brand layouts of other companies never appear.
  fastify.get('/', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const brands = await prisma.concept.findMany({
      where: { deletedAt: null, ...(await scopeTenantWhere(req, 'read')) },
      select: { slug: true },
    })
    return prisma.siteLayout.findMany({
      where: {
        OR: [
          { slug: { startsWith: 'servd:' } },
          ...brands.flatMap((b) => [
            { slug: `brand:${b.slug}` },
            { slug: { startsWith: `brand:${b.slug}:` } },
          ]),
        ],
      },
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

      // Upsert: a first save binds a NEW row to the brand, so it must be a
      // brand of the ACTIVE company; a re-save edits an existing row, so any
      // company the operator belongs to will do.
      const before = await prisma.siteLayout.findUnique({ where: { slug } })
      await assertLayoutSlugOwned(req, slug, before ? 'write' : 'create')

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
      await assertLayoutSlugOwned(req, slug, 'write')
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
