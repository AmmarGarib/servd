// Storefront content module API (owner decision 41).
//
// One row per page / pop-up, keyed by slug (see service.ts parseSlug):
//   servd:<page>                  shared servd pages (incl.   tenantId null
//                                 servd:header / servd:footer
//                                 chrome and the servd:feedback
//                                 widget — the feedback button)
//   brand:<slug>[:<page>]         a brand's pages, top bar,   the brand's company
//                                 footer and the owner's own pages
//   brand:<slug>:kit              the brand kit (kind 'kit'): the brand's company
//                                 colours, fonts and images in
//                                 settings.kit; blocks always []
//   page:<slug>                   custom page (/pages/<slug>) tenantId null
//   popup:<key>                   pop-up                      null, or the one company its brands belong to
//
// blocks/settings are the LIVE copy the storefront reads. Every edit goes to
// draftBlocks/draftSettings and nothing reaches the storefront until the CEO
// (role `admin`) approves it — now, or at a scheduled publishAt. Every publish
// writes a SiteLayoutVersion so any version can be rolled back to.
//
// Drafting (and the staff reads) needs the `storefront` module; approve,
// reject, rollback and delete are the CEO's. The old publish-on-save
// PUT /site-layouts/:slug is gone.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { Prisma, type SiteLayout } from '@prisma/client'
import { z } from 'zod'
import jwt from 'jsonwebtoken'
import { prisma } from '../../lib/prisma.js'
import { requireAuth, ADMIN_ONLY } from '../auth/middleware.js'
import { audit } from '../../lib/audit.js'
import { AppError, ConflictError, ForbiddenError, NotFoundError, UnauthorizedError } from '../../lib/errors.js'
import { effectiveModulesForUser } from '../../lib/moduleAccess.js'
import { scopeTenantWhere } from '../../lib/tenantScope.js'
import {
  blocksSchema, pageSettingsSchema, popupRulesSchema, kitSettingsSchema, MAX_CONTENT_BYTES,
} from './schemas.js'
import {
  parseSlug, parseSlugOrThrow, resolveLayoutTenant, assertRowInScope, publishDraft, publishDueLayouts,
  publicShape, resolveFonts, namesById, assertKitFontsInCompany, kitOf, resolveKitFonts,
  kitLiveSettingsTx, syncKitToConceptTx, unapplyKitTx, stripServerSettings,
} from './service.js'

const PREVIEW_TOKEN_TYPE = 'site_preview'
const PREVIEW_TTL = '30m'
const jwtSecret = () => process.env['JWT_SECRET'] as string

type SlugParams = { Params: { slug: string } }

/** brand:<slug>:<part> names the storefront serves from its own routes (the
 *  chrome, and the built-in about/visit/menu pages) or that are not pages at
 *  all (kit = the brand kit); any other part is a page the owner added, at
 *  /brand/<slug>/pages/<part>. */
const BRAND_FIXED_PARTS = new Set(['header', 'footer', 'about', 'visit', 'menu', 'kit'])

const LAYOUT_KINDS = ['page', 'hero', 'header', 'footer', 'widget', 'popup', 'kit'] as const

function slugOf(req: FastifyRequest<SlugParams>): string {
  try { return decodeURIComponent(req.params.slug) } catch { return req.params.slug }
}

// ── Access ───────────────────────────────────────────────────────────────────

async function assertStorefrontModule(req: FastifyRequest, _reply: FastifyReply) {
  const su = req.staffUser!
  if (su.role === 'admin') return
  const u = await prisma.user.findUnique({ where: { id: su.id }, select: { moduleAllow: true, moduleDeny: true } })
  const modules = await effectiveModulesForUser({ role: su.role, moduleAllow: u?.moduleAllow ?? [], moduleDeny: u?.moduleDeny ?? [] })
  if (!modules.has('storefront')) {
    throw new ForbiddenError('Your account does not have access to the Storefront module. Ask the CEO to enable it in Module Access.')
  }
}

const STOREFRONT = { preHandler: [requireAuth(), assertStorefrontModule] }
const CEO = { preHandler: requireAuth(...ADMIN_ONLY) }

/** The row at `slug`, 404 unless its company is in `mode`'s scope. */
async function loadRow(req: FastifyRequest, slug: string, mode: 'read' | 'write'): Promise<SiteLayout> {
  parseSlugOrThrow(slug)
  const row = await prisma.siteLayout.findUnique({ where: { slug } })
  if (!row) throw new NotFoundError('SiteLayout', slug)
  await assertRowInScope(req, row, mode)
  return row
}

function actor(req: FastifyRequest) {
  const su = req.staffUser
  return { userId: su?.id ?? null, userEmail: su?.email ?? null, tenantId: su?.tenantId ?? null }
}

function editShape(row: SiteLayout) {
  const live = row.liveVersion > 0
  return {
    id: row.id,
    slug: row.slug,
    kind: row.kind,
    title: row.title,
    tenantId: row.tenantId,
    blocks: live ? row.blocks : null,
    settings: live ? stripServerSettings(row.settings) : null,
    draftBlocks: row.draftBlocks,
    draftSettings: row.draftSettings,
    draftStatus: row.draftStatus,
    reviewNote: row.reviewNote,
    publishAt: row.publishAt,
    liveVersion: row.liveVersion,
    publishedAt: row.publishedAt,
    submittedAt: row.submittedAt,
    draftUpdatedAt: row.draftUpdatedAt,
    updatedAt: row.updatedAt,
  }
}

function contentBytes(blocks: unknown, settings: unknown): number {
  return Buffer.byteLength(JSON.stringify(blocks ?? null), 'utf8') + Buffer.byteLength(JSON.stringify(settings ?? null), 'utf8')
}

const jsonOrNull = (v: unknown) => (v === null || v === undefined ? Prisma.DbNull : (v as Prisma.InputJsonValue))

export async function siteLayoutRoutes(fastify: FastifyInstance) {
  // ── Public ────────────────────────────────────────────────────────────────

  // Live pop-ups inside their window. Static paths (/popups/live,
  // /pages/live) are registered before /:slug; find-my-way prefers static
  // segments either way.
  fastify.get(
    '/popups/live',
    { config: { rateLimit: { max: 240, timeWindow: '1 minute' } } },
    async () => {
      await publishDueLayouts({ kind: 'popup' })
      const rows = await prisma.siteLayout.findMany({
        where: { kind: 'popup', liveVersion: { gt: 0 } },
        orderBy: { slug: 'asc' },
      })
      const now = Date.now()
      const out = []
      for (const row of rows) {
        const settings = (row.settings ?? {}) as Record<string, unknown>
        const rules = popupRulesSchema.safeParse(settings['popup'])
        if (!rules.success) continue
        if (rules.data.startsAt && new Date(rules.data.startsAt).getTime() > now) continue
        if (rules.data.endsAt && new Date(rules.data.endsAt).getTime() <= now) continue
        out.push({
          slug: row.slug,
          version: row.liveVersion,
          title: row.title,
          blocks: row.blocks,
          rules: rules.data,
          ab: settings['ab'] ?? null,
          fonts: await resolveFonts(row.blocks, row.settings, row.tenantId),
        })
      }
      return out
    },
  )

  // Every page with a live copy, for the storefront's sitemap: the slug and
  // when it was published — never blocks, settings or anything from a draft.
  // Pages only (servd:<page>, page:<slug>, brand:<slug>[:<page>]); pop-ups,
  // the header/footer chrome and widgets (servd:feedback) are not pages. A
  // draft, a draft waiting for the CEO or a scheduled one whose time hasn't
  // come has no live copy, so it is not listed; a scheduled draft that has
  // come due is published first, as on the live read. Like popups/live this
  // spans companies on purpose: the public storefront lists every company's
  // brands (/storefront/concepts).
  // A brand's pages are listed only while that brand is on the storefront.
  // A page the owner added (page:<slug>, brand:<slug>:<page>) whose live copy
  // is empty is a 404 on the storefront, so it is not listed; a built-in page
  // (servd:<page>, the brand home, about/visit/menu) shows its default design
  // when empty, so it stays, with the date it was cleared.
  fastify.get(
    '/pages/live',
    { config: { rateLimit: { max: 240, timeWindow: '1 minute' } } },
    async () => {
      await publishDueLayouts({ kind: 'page' })
      const live = { kind: 'page', liveVersion: { gt: 0 } }
      const [rows, emptyRows] = await Promise.all([
        prisma.siteLayout.findMany({ where: live, select: { slug: true, publishedAt: true }, orderBy: { slug: 'asc' } }),
        prisma.siteLayout.findMany({ where: { ...live, blocks: { equals: [] } }, select: { slug: true } }),
      ])
      const empty = new Set(emptyRows.map((r) => r.slug))
      // The slug decides, not just the stored kind: a row written before the
      // kind column existed defaulted to 'page' whatever its slug.
      const pages = rows.flatMap((r) => {
        const parsed = parseSlug(r.slug)
        if (parsed?.kind !== 'page') return []
        const part = parsed.owner === 'brand' ? r.slug.split(':')[2] : undefined
        // brand:<b>:About / :Header — slugs are case-sensitive, so this is
        // not the brand's about page or chrome, and the storefront refuses
        // the reserved name at /pages/<page> whatever its case: no URL.
        if (part !== undefined && part !== part.toLowerCase() && BRAND_FIXED_PARTS.has(part.toLowerCase())) return []
        const ownerPage = r.slug.startsWith('page:') || (part !== undefined && !BRAND_FIXED_PARTS.has(part))
        if (ownerPage && empty.has(r.slug)) return []
        return [{ row: r, brand: parsed.owner === 'brand' ? parsed.conceptSlug : null }]
      })
      const brandSlugs = [...new Set(pages.flatMap((p) => (p.brand ? [p.brand] : [])))]
      const visible = new Set(brandSlugs.length === 0 ? [] : (await prisma.concept.findMany({
        where: { slug: { in: brandSlugs }, isActive: true, storefrontVisible: true, deletedAt: null },
        select: { slug: true },
      })).map((c) => c.slug))
      return pages
        .filter((p) => p.brand === null || visible.has(p.brand))
        .map((p) => ({ slug: p.row.slug, publishedAt: p.row.publishedAt }))
    },
  )

  // Every LIVE brand kit of a brand on the storefront (active, visible, not
  // deleted), keyed by brand slug, for the storefront's root layout. Spans
  // companies like /pages/live (the public storefront lists every company's
  // brands); a kit paints only the brand of its OWN company. `fonts` resolves
  // the kit's library fonts inside that company. Registered before /:slug.
  fastify.get(
    '/kits/live',
    { config: { rateLimit: { max: 240, timeWindow: '1 minute' } } },
    async () => {
      await publishDueLayouts({ kind: 'kit' })
      const rows = await prisma.siteLayout.findMany({
        where: { kind: 'kit', liveVersion: { gt: 0 } },
        select: { slug: true, tenantId: true, settings: true, liveVersion: true },
        orderBy: { slug: 'asc' },
      })
      const bySlug = new Map<string, (typeof rows)[number]>()
      for (const r of rows) {
        const p = parseSlug(r.slug)
        if (p?.owner === 'brand' && p.kind === 'kit' && r.tenantId) bySlug.set(p.conceptSlug, r)
      }
      const kits: Record<string, { kit: unknown; version: number; fonts: unknown[] }> = {}
      if (bySlug.size === 0) return { kits }
      const brands = await prisma.concept.findMany({
        where: { slug: { in: [...bySlug.keys()] }, isActive: true, storefrontVisible: true, deletedAt: null },
        select: { slug: true, tenantId: true },
      })
      for (const b of brands) {
        const row = bySlug.get(b.slug)
        if (!row || row.tenantId !== b.tenantId) continue
        const kit = kitOf(row.settings)
        if (!kit) continue
        kits[b.slug] = { kit, version: row.liveVersion, fonts: await resolveKitFonts(kit, row.tenantId) }
      }
      return { kits }
    },
  )

  // Draft preview for the storefront's /preview/<token> page. A wildcard, not
  // `:token`: a JWT is longer than the router's 100-char param limit (414).
  fastify.get<{ Params: { '*': string } }>(
    '/preview/*',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (req, reply) => {
      let payload: { type?: string; slug?: string }
      try {
        payload = jwt.verify(req.params['*'], jwtSecret()) as typeof payload
      } catch {
        throw new UnauthorizedError('This preview link has expired. Open a new one from the editor.')
      }
      if (payload.type !== PREVIEW_TOKEN_TYPE || typeof payload.slug !== 'string') {
        throw new UnauthorizedError('Not a preview link')
      }
      const row = await prisma.siteLayout.findUnique({ where: { slug: payload.slug } })
      reply.header('Cache-Control', 'no-store')
      return publicShape(payload.slug, row, true)
    },
  )

  // Live read — the storefront fetches this per render. A slug with no row
  // (or nothing live yet) returns blocks null and the storefront falls back
  // to its built-in design. A scheduled draft that has come due is published
  // here first, so the page never waits for the worker.
  fastify.get<SlugParams>(
    '/:slug',
    { config: { rateLimit: { max: 240, timeWindow: '1 minute' } } },
    async (req) => {
      const slug = slugOf(req)
      let row = await prisma.siteLayout.findUnique({ where: { slug } })
      // A brand's rows (its pages, chrome and kit) are public only while the
      // brand is on the storefront — active, visible, not deleted, and the
      // row's own company (as /kits/live and /pages/live). Otherwise the
      // empty shape, as if nothing were live. Staff read through /:slug/edit.
      const parsed = parseSlug(slug)
      if (row && parsed?.owner === 'brand') {
        const brand = await prisma.concept.findFirst({
          where: { slug: parsed.conceptSlug, isActive: true, storefrontVisible: true, deletedAt: null },
          select: { tenantId: true },
        })
        if (!brand || (row.tenantId !== null && row.tenantId !== brand.tenantId)) return publicShape(slug, null)
      }
      if (row && row.draftStatus === 'scheduled' && row.publishAt && row.publishAt <= new Date()) {
        await publishDueLayouts({ slug })
        row = await prisma.siteLayout.findUnique({ where: { slug } })
      }
      return publicShape(slug, row)
    },
  )

  // A/B counters. Unknown slugs / versions are ignored (still 204) so the
  // storefront never has to care whether a page is live.
  fastify.post<SlugParams>(
    '/:slug/track',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = z.object({
        version: z.number().int().min(1),
        variant: z.enum(['a', 'b']),
        event:   z.enum(['view', 'convert']),
      }).parse(req.body)
      const row = await prisma.siteLayout.findUnique({ where: { slug: slugOf(req) }, select: { id: true, liveVersion: true } })
      if (!row || body.version > row.liveVersion) return reply.status(204).send()
      const exists = await prisma.siteLayoutVersion.findUnique({
        where: { layoutId_version: { layoutId: row.id, version: body.version } },
        select: { id: true },
      })
      if (!exists) return reply.status(204).send()

      const views = body.event === 'view' ? 1 : 0
      const conversions = body.event === 'convert' ? 1 : 0
      const key = { layoutId_version_variant: { layoutId: row.id, version: body.version, variant: body.variant } }
      const upsert = () => prisma.siteLayoutStat.upsert({
        where: key,
        create: { layoutId: row.id, version: body.version, variant: body.variant, views, conversions },
        update: { views: { increment: views }, conversions: { increment: conversions } },
      })
      try {
        await upsert()
      } catch (err) {
        // Two first-hits racing on the create: the loser retries as an update.
        if ((err as { code?: string }).code !== 'P2002') throw err
        await upsert()
      }
      return reply.status(204).send()
    },
  )

  // ── Staff ─────────────────────────────────────────────────────────────────

  // Index: the shared rows plus the rows of companies in view.
  fastify.get<{ Querystring: { status?: string; kind?: string } }>(
    '/',
    STOREFRONT,
    async (req) => {
      const q = z.object({
        status: z.enum(['pending', 'draft', 'scheduled', 'all']).default('all'),
        kind:   z.enum(LAYOUT_KINDS).optional(),
      }).parse(req.query)
      const rows = await prisma.siteLayout.findMany({
        where: {
          OR: [{ tenantId: null }, await scopeTenantWhere(req, 'read')],
          ...(q.status !== 'all' ? { draftStatus: q.status } : {}),
          ...(q.kind ? { kind: q.kind } : {}),
        },
        orderBy: { slug: 'asc' },
      })
      const names = await namesById(rows.map((r) => r.submittedById))
      // Brand kits are listed as "Brand kit — <Brand>" (the approvals inbox
      // and the Storefront → Approvals tab show `label` when set).
      const kitBrand = new Map<string, string>()
      for (const r of rows) {
        const p = parseSlug(r.slug)
        if (p?.owner === 'brand' && p.kind === 'kit') kitBrand.set(r.slug, p.conceptSlug)
      }
      const brandNames = new Map<string, string>()
      if (kitBrand.size > 0) {
        const concepts = await prisma.concept.findMany({
          where: { slug: { in: [...new Set(kitBrand.values())] } },
          select: { slug: true, name: true, tenantId: true },
        })
        for (const c of concepts) brandNames.set(`${c.tenantId}:${c.slug}`, c.name)
      }
      const labelOf = (r: (typeof rows)[number]) => {
        const b = kitBrand.get(r.slug)
        return b === undefined ? null : `Brand kit — ${brandNames.get(`${r.tenantId}:${b}`) ?? b}`
      }
      return rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        kind: r.kind,
        title: r.title,
        label: labelOf(r),
        tenantId: r.tenantId,
        draftStatus: r.draftStatus,
        liveVersion: r.liveVersion,
        publishedAt: r.publishedAt,
        publishAt: r.publishAt,
        submittedAt: r.submittedAt,
        submittedBy: r.submittedById ? (names.get(r.submittedById) ?? { id: r.submittedById, name: null }) : null,
        reviewNote: r.reviewNote,
        updatedAt: r.updatedAt,
        draftUpdatedAt: r.draftUpdatedAt,
      }))
    },
  )

  // Full row for the editor; a slug with no row returns a skeleton.
  fastify.get<SlugParams>('/:slug/edit', STOREFRONT, async (req) => {
    const slug = slugOf(req)
    const parsed = parseSlugOrThrow(slug)
    const row = await prisma.siteLayout.findUnique({ where: { slug } })
    if (row) {
      await assertRowInScope(req, row, 'read')
      return editShape(row)
    }
    const tenantId = await resolveLayoutTenant(req, slug, 'read')
    return {
      slug, kind: parsed.kind, title: null, tenantId,
      blocks: null, settings: null, draftBlocks: null, draftSettings: null,
      draftStatus: 'none', reviewNote: null, publishAt: null, liveVersion: 0, publishedAt: null,
      submittedAt: null, draftUpdatedAt: null, updatedAt: null,
    }
  })

  // Save the working copy. Editing a pending or scheduled draft drops it back
  // to 'draft' (the CEO approved something else).
  fastify.put<SlugParams>('/:slug/draft', STOREFRONT, async (req) => {
    const slug = slugOf(req)
    const parsed = parseSlugOrThrow(slug)
    const body = z.object({
      title:    z.string().max(120).nullish(),
      kind:     z.enum(LAYOUT_KINDS).optional(), // derived from the slug; accepted for the contract
      blocks:   blocksSchema,
      settings: z.unknown().optional(),
    }).parse(req.body)

    // A brand kit is `{ kit }` only, no blocks; a page never carries a kit.
    const isKit = parsed.kind === 'kit'
    if (isKit && body.blocks.length > 0) {
      throw new AppError('KIT_NO_BLOCKS', 'A brand kit has no page blocks', 422)
    }
    if (isKit && (body.settings === undefined || body.settings === null)) {
      throw new AppError('KIT_REQUIRED', 'A brand kit needs settings.kit', 422)
    }
    const kitSettings = isKit ? kitSettingsSchema.parse(body.settings) : null
    const pageSettings = isKit ? null : (pageSettingsSchema.nullish().parse(body.settings) ?? null)
    if (pageSettings && 'kit' in pageSettings) {
      throw new AppError('KIT_NOT_ALLOWED', 'Only a brand kit (brand:<brand>:kit) carries a kit', 422)
    }
    const settings = kitSettings ?? pageSettings

    if (contentBytes(body.blocks, settings) > MAX_CONTENT_BYTES) {
      throw new AppError('LAYOUT_TOO_LARGE', 'This page is over 200KB. Slim it down.', 413)
    }
    if (parsed.kind === 'popup' && !pageSettings?.popup) {
      throw new AppError('POPUP_RULES_REQUIRED', 'A pop-up needs its display rules (settings.popup)', 422)
    }
    if (parsed.kind !== 'popup' && pageSettings?.popup) {
      throw new AppError('POPUP_RULES_NOT_ALLOWED', 'Only a pop-up carries pop-up rules', 422)
    }

    const before = await prisma.siteLayout.findUnique({ where: { slug } })
    if (before) await assertRowInScope(req, before, 'write')
    const tenantId = await resolveLayoutTenant(req, slug, before ? 'write' : 'create', pageSettings?.popup?.brands)
    if (kitSettings) await assertKitFontsInCompany(kitSettings.kit, tenantId)

    const now = new Date()
    const draft = {
      kind: parsed.kind,
      tenantId,
      draftBlocks: body.blocks as Prisma.InputJsonValue,
      draftSettings: jsonOrNull(settings),
      draftStatus: 'draft',
      draftUpdatedById: req.staffUser!.id,
      draftUpdatedAt: now,
      submittedById: null,
      submittedAt: null,
      publishAt: null,
    }
    const saved = before
      ? await prisma.siteLayout.update({
          where: { id: before.id },
          data: { ...draft, ...(body.title != null ? { title: body.title } : {}) },
        })
      : await prisma.siteLayout.create({
          data: { ...draft, slug, title: body.title ?? slug, blocks: [], liveVersion: 0 },
        })

    await audit({
      category: 'identity', ...actor(req),
      action: 'site_layout.draft_save', entity: 'SiteLayout', entityId: saved.id,
      before: before ? { draftStatus: before.draftStatus, publishAt: before.publishAt } : null,
      after: { slug, blockCount: body.blocks.length, tenantId },
    })
    return editShape(saved)
  })

  // Throw the working copy away. A page that was never published has nothing
  // else in it, so the row goes too.
  fastify.delete<SlugParams>('/:slug/draft', STOREFRONT, async (req, reply) => {
    const slug = slugOf(req)
    const row = await loadRow(req, slug, 'write')
    if (row.liveVersion === 0) {
      // Conditional: a first publish landing between the read and the delete
      // (it already synced a kit to the brand) must not lose its row.
      const gone = await prisma.siteLayout.deleteMany({ where: { id: row.id, liveVersion: 0 } })
      if (gone.count === 0) throw new ConflictError('This was published while you were discarding it. Reload and try again.')
    } else {
      await prisma.siteLayout.update({
        where: { id: row.id },
        data: {
          draftBlocks: Prisma.DbNull, draftSettings: Prisma.DbNull, draftStatus: 'none',
          draftUpdatedAt: null, draftUpdatedById: null, submittedAt: null, submittedById: null,
          publishAt: null, reviewNote: null,
        },
      })
    }
    await audit({
      category: 'identity', ...actor(req),
      action: 'site_layout.draft_discard', entity: 'SiteLayout', entityId: row.id,
      before: { draftStatus: row.draftStatus, publishAt: row.publishAt }, metadata: { slug },
    })
    return reply.status(204).send()
  })

  // Send the draft to the CEO.
  fastify.post<SlugParams>('/:slug/submit', STOREFRONT, async (req) => {
    const slug = slugOf(req)
    const row = await loadRow(req, slug, 'write')
    if (row.draftBlocks === null || row.draftStatus !== 'draft') {
      throw new ConflictError(row.draftStatus === 'none' ? 'There is no draft to submit' : `This draft is already ${row.draftStatus}`)
    }
    const saved = await prisma.siteLayout.update({
      where: { id: row.id },
      data: { draftStatus: 'pending', submittedById: req.staffUser!.id, submittedAt: new Date(), reviewNote: null },
    })
    await audit({
      category: 'identity', ...actor(req),
      action: 'site_layout.submit', entity: 'SiteLayout', entityId: row.id, after: { slug },
    })
    return editShape(saved)
  })

  // CEO: publish now, or schedule for publishAt.
  fastify.post<SlugParams>('/:slug/approve', CEO, async (req) => {
    const slug = slugOf(req)
    const body = z.object({
      publishAt: z.preprocess((v) => (v === '' || v === null ? undefined : v), z.string().datetime({ offset: true }).optional()),
    }).parse(req.body ?? {})
    const row = await loadRow(req, slug, 'write')
    if (row.draftBlocks === null || row.draftStatus === 'none') throw new ConflictError('There is no draft to approve')

    const publishAt = body.publishAt ? new Date(body.publishAt) : null
    const approver = req.staffUser!.id
    if (publishAt && publishAt.getTime() > Date.now()) {
      const saved = await prisma.siteLayout.update({
        where: { id: row.id },
        data: {
          draftStatus: 'scheduled', publishAt, reviewedById: approver, reviewedAt: new Date(), reviewNote: null,
          // The approval is of the draft as it stands; keep a submitter on record.
          submittedById: row.submittedById ?? row.draftUpdatedById, submittedAt: row.submittedAt ?? new Date(),
        },
      })
      await audit({
        category: 'identity', ...actor(req),
        action: 'site_layout.schedule', entity: 'SiteLayout', entityId: row.id,
        after: { slug, publishAt: publishAt.toISOString() },
      })
      return editShape(saved)
    }

    const version = await publishDraft(row.id, { approvedById: approver, expect: ['draft', 'pending', 'scheduled'] })
    if (version === null) throw new ConflictError('The draft changed while you were approving it. Reload and try again.')
    await audit({
      category: 'identity', ...actor(req),
      action: 'site_layout.publish', entity: 'SiteLayout', entityId: row.id,
      before: { liveVersion: row.liveVersion }, after: { slug, version },
    })
    return editShape(await prisma.siteLayout.findUniqueOrThrow({ where: { id: row.id } }))
  })

  // CEO: send it back with a note.
  fastify.post<SlugParams>('/:slug/reject', CEO, async (req) => {
    const slug = slugOf(req)
    const body = z.object({ note: z.string().trim().min(1).max(2000) }).parse(req.body)
    const row = await loadRow(req, slug, 'write')
    if (row.draftStatus !== 'pending' && row.draftStatus !== 'scheduled') {
      throw new ConflictError('Only a submitted or scheduled draft can be sent back')
    }
    const saved = await prisma.siteLayout.update({
      where: { id: row.id },
      data: { draftStatus: 'draft', reviewNote: body.note, reviewedById: req.staffUser!.id, reviewedAt: new Date(), publishAt: null },
    })
    await audit({
      category: 'identity', ...actor(req),
      action: 'site_layout.reject', entity: 'SiteLayout', entityId: row.id,
      before: { draftStatus: row.draftStatus }, after: { slug, note: body.note },
    })
    return editShape(saved)
  })

  fastify.get<SlugParams>('/:slug/versions', STOREFRONT, async (req) => {
    const slug = slugOf(req)
    const row = await prisma.siteLayout.findUnique({ where: { slug } })
    if (!row) { await resolveLayoutTenant(req, slug, 'read'); return [] }
    await assertRowInScope(req, row, 'read')
    const versions = await prisma.siteLayoutVersion.findMany({ where: { layoutId: row.id }, orderBy: { version: 'desc' } })
    const names = await namesById(versions.flatMap((v) => [v.publishedById, v.approvedById]))
    const who = (id: string | null) => (id ? (names.get(id) ?? { id, name: null }) : null)
    return versions.map((v) => ({
      version: v.version,
      publishedAt: v.publishedAt,
      publishedBy: who(v.publishedById),
      approvedBy: who(v.approvedById),
      note: v.note,
      blocks: v.blocks,
      settings: stripServerSettings(v.settings),
    }))
  })

  // CEO: put an old version back live — as a NEW version, so history only grows.
  fastify.post<SlugParams>('/:slug/rollback', CEO, async (req) => {
    const slug = slugOf(req)
    const body = z.object({ version: z.number().int().min(1) }).parse(req.body)
    const row = await loadRow(req, slug, 'write')
    const target = await prisma.siteLayoutVersion.findUnique({
      where: { layoutId_version: { layoutId: row.id, version: body.version } },
    })
    if (!target) throw new NotFoundError('SiteLayoutVersion', String(body.version))

    const version = row.liveVersion + 1
    const now = new Date()
    const admin = req.staffUser!.id
    const ok = await prisma.$transaction(async (tx) => {
      // A kit row keeps its pre-kit Concept snapshot on the live settings.
      const live = await kitLiveSettingsTx(tx, row, target.settings)
      const claimed = await tx.siteLayout.updateMany({
        where: { id: row.id, liveVersion: row.liveVersion },
        data: {
          blocks: target.blocks as Prisma.InputJsonValue,
          settings: jsonOrNull(live.settings),
          liveVersion: version, publishedAt: now, updatedById: admin,
        },
      })
      if (claimed.count === 0) return false
      // A brand kit's rollback syncs the brand's Concept like any publish.
      // (fields the version leaves unset go back to the pre-kit values).
      await syncKitToConceptTx(tx, row, row.liveVersion > 0 ? row.settings : null, target.settings, live.before)
      await tx.siteLayoutVersion.create({
        data: {
          layoutId: row.id, version, blocks: target.blocks as Prisma.InputJsonValue, settings: jsonOrNull(target.settings),
          publishedById: admin, approvedById: admin, note: `Rollback to version ${target.version}`, publishedAt: now,
        },
      })
      return true
    })
    if (!ok) throw new ConflictError('The page was published again while you were rolling back. Reload and try again.')
    await audit({
      category: 'identity', ...actor(req),
      action: 'site_layout.rollback', entity: 'SiteLayout', entityId: row.id,
      before: { liveVersion: row.liveVersion }, after: { slug, version, from: target.version },
    })
    return editShape(await prisma.siteLayout.findUniqueOrThrow({ where: { id: row.id } }))
  })

  fastify.get<SlugParams>('/:slug/stats', STOREFRONT, async (req) => {
    const slug = slugOf(req)
    const row = await prisma.siteLayout.findUnique({ where: { slug } })
    if (!row) { await resolveLayoutTenant(req, slug, 'read'); return [] }
    await assertRowInScope(req, row, 'read')
    const stats = await prisma.siteLayoutStat.findMany({
      where: { layoutId: row.id },
      orderBy: [{ version: 'desc' }, { variant: 'asc' }],
    })
    return stats.map((s) => ({ version: s.version, variant: s.variant, views: s.views, conversions: s.conversions }))
  })

  // Short-lived link for the storefront's /preview/<token> page. The token is
  // `type: 'site_preview'`, which every staff/customer token check refuses.
  fastify.post<SlugParams>('/:slug/preview-token', STOREFRONT, async (req) => {
    const slug = slugOf(req)
    const row = await prisma.siteLayout.findUnique({ where: { slug } })
    if (row) await assertRowInScope(req, row, 'read')
    else await resolveLayoutTenant(req, slug, 'read')
    const token = jwt.sign({ type: PREVIEW_TOKEN_TYPE, slug }, jwtSecret(), { expiresIn: PREVIEW_TTL })
    return { token }
  })

  // CEO: remove the page entirely; the storefront falls back to its built-in design.
  fastify.delete<SlugParams>('/:slug', CEO, async (req, reply) => {
    const slug = slugOf(req)
    const row = await loadRow(req, slug, 'write')
    // Removing a brand kit puts the brand's Concept back to its pre-kit
    // values in the same transaction (the conditional delete makes a
    // concurrent publish lose cleanly).
    const restored = await prisma.$transaction(async (tx) => {
      const gone = await tx.siteLayout.deleteMany({ where: { id: row.id, liveVersion: row.liveVersion } })
      if (gone.count === 0) return null
      return unapplyKitTx(tx, row)
    })
    if (restored === null) throw new ConflictError('The page was published again while you were removing it. Reload and try again.')
    await audit({
      category: 'identity', ...actor(req),
      action: 'site_layout.delete', entity: 'SiteLayout', entityId: row.id,
      before: { slug, liveVersion: row.liveVersion, draftStatus: row.draftStatus },
      ...(restored.length > 0 ? { metadata: { conceptRestored: restored } } : {}),
    })
    return reply.status(204).send()
  })
}
