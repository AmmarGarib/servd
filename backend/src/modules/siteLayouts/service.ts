// Storefront content module (decision 41) — slug ownership, publishing and
// the public read shape. Routes live in routes.ts; the scheduled-publish
// worker (workers/sitePublish.ts) and the public read both call
// publishDueLayouts(), which is idempotent: a row publishes only through a
// conditional update on its current version + draft stamp, so two publishers
// racing on the same due row produce exactly one new version.

import { Prisma, type SiteLayout } from '@prisma/client'
import type { FastifyRequest } from 'fastify'
import { serviceClient } from '../../lib/prisma.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { scopeTenantWhere, type ScopeMode } from '../../lib/tenantScope.js'
import { audit } from '../../lib/audit.js'
import { fontFamiliesUsed, brandKitSchema, kitLibraryFontIds, type BrandKit } from './schemas.js'

const db = serviceClient

export type LayoutKind = 'page' | 'header' | 'footer' | 'widget' | 'popup' | 'kit'

export type ParsedSlug =
  | { owner: 'shared'; kind: LayoutKind }
  | { owner: 'brand'; kind: LayoutKind; conceptSlug: string }
  | { owner: 'popup'; kind: 'popup' }

const PART = /^[a-z0-9][a-z0-9_-]{0,79}$/i

/** servd site widgets: chrome that floats over every page rather than being
 *  one (servd:feedback = the feedback button and its sheet). Not pages, so
 *  never in the sitemap list and no SEO / A-B in the editor. servd only —
 *  brand:<b>:feedback is an ordinary page the owner added. */
const SERVD_WIDGETS = new Set(['feedback'])

/**
 * servd:<page>                 → shared (servd:header / servd:footer are the
 *                                site chrome; servd:feedback is a widget —
 *                                the floating feedback button)
 * brand:<conceptSlug>[:<page>] → the brand's company (:header / :footer are
 *                                its chrome; :kit is its brand kit — colours,
 *                                fonts, images, never a page; about, visit,
 *                                menu built-in pages; anything else is a page
 *                                the owner added)
 * page:<slug>                  → shared custom page
 * popup:<key>                  → shared, or the company of the brands it targets
 *
 * Shared = tenantId null on purpose: the servd:* chrome, widgets and pages are
 * platform data shown across every company's brands.
 */
function chromeKind(part: string): LayoutKind {
  return part === 'header' ? 'header' : part === 'footer' ? 'footer' : 'page'
}

/** brand:<b>:kit — the one brand part that is the brand's look, not a page. */
export const KIT_PART = 'kit'

function brandPartKind(part: string): LayoutKind {
  return part === KIT_PART ? 'kit' : chromeKind(part)
}

export function parseSlug(slug: string): ParsedSlug | null {
  const [prefix, a, b, ...rest] = slug.split(':')
  if (rest.length > 0 || !a || !PART.test(a)) return null
  if (prefix === 'servd' && b === undefined) {
    return { owner: 'shared', kind: SERVD_WIDGETS.has(a) ? 'widget' : chromeKind(a) }
  }
  if (prefix === 'page' && b === undefined) return { owner: 'shared', kind: 'page' }
  if (prefix === 'popup' && b === undefined) return { owner: 'popup', kind: 'popup' }
  if (prefix === 'brand') {
    if (b === undefined) return { owner: 'brand', kind: 'page', conceptSlug: a }
    if (PART.test(b)) return { owner: 'brand', kind: brandPartKind(b), conceptSlug: a }
  }
  return null
}

export function parseSlugOrThrow(slug: string): ParsedSlug {
  const p = parseSlug(slug)
  if (!p) {
    throw new AppError('LAYOUT_SLUG_INVALID',
      'Slug must be servd:<page>, brand:<brand>[:<page>], page:<slug> or popup:<key>', 422)
  }
  return p
}

/** Company ids the caller can see (read) or touch (write/create). */
async function tenantIdsFor(req: FastifyRequest, mode: ScopeMode): Promise<string[]> {
  const w = await scopeTenantWhere(req, mode)
  return typeof w.tenantId === 'string' ? [w.tenantId] : w.tenantId.in
}

/** 404 unless a row's company is in scope (shared rows are everyone's). */
export async function assertRowInScope(req: FastifyRequest, row: Pick<SiteLayout, 'tenantId' | 'slug'>, mode: ScopeMode) {
  if (row.tenantId === null) return
  const ids = await tenantIdsFor(req, mode)
  if (!ids.includes(row.tenantId)) throw new NotFoundError('SiteLayout', row.slug)
}

/**
 * The company a layout belongs to, resolved from its slug (and, for pop-ups,
 * the brands it targets). Throws 404 for a brand outside `mode`'s scope and
 * 422 for a pop-up whose brands span companies or aren't all in scope.
 */
export async function resolveLayoutTenant(
  req: FastifyRequest,
  slug: string,
  mode: ScopeMode,
  popupBrands?: string[],
): Promise<string | null> {
  const parsed = parseSlugOrThrow(slug)
  if (parsed.owner === 'shared') return null
  if (parsed.owner === 'brand') {
    if (mode === 'create' && !req.staffUser?.tenantId) {
      throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company before creating a brand page', 422)
    }
    const concept = await db.concept.findFirst({
      where: { slug: parsed.conceptSlug, deletedAt: null, ...(await scopeTenantWhere(req, mode)) },
      select: { tenantId: true },
    })
    if (!concept) throw new NotFoundError('SiteLayout', slug)
    return concept.tenantId
  }
  // Pop-up.
  const brands = [...new Set(popupBrands ?? [])]
  if (brands.length === 0) return null
  const concepts = await db.concept.findMany({
    where: { slug: { in: brands }, deletedAt: null, ...(await scopeTenantWhere(req, mode)) },
    select: { slug: true, tenantId: true },
  })
  const tenants = new Set(concepts.map((c) => c.tenantId))
  if (concepts.length !== brands.length || tenants.size !== 1 || concepts[0]!.tenantId === null) {
    throw new AppError('POPUP_BRANDS_INVALID',
      'A pop-up can only target brands of one company you work in', 422)
  }
  return concepts[0]!.tenantId
}

// ── Publishing ───────────────────────────────────────────────────────────────

type DraftStatus = 'none' | 'draft' | 'pending' | 'scheduled'

/**
 * Copy the draft to the live copy as a new version, in one transaction.
 * Returns the new version, or null when the row changed underneath us (another
 * publisher won, or the draft was edited) — callers treat null as "nothing to
 * do". `expect` lists the draft states this publish is allowed from;
 * `dueOnly` additionally requires publishAt <= now (scheduled publishing).
 */
export async function publishDraft(
  layoutId: string,
  opts: { approvedById: string | null; expect: DraftStatus[]; dueOnly?: boolean; note?: string | null },
): Promise<number | null> {
  return db.$transaction(async (tx) => {
    const row = await tx.siteLayout.findUnique({ where: { id: layoutId } })
    if (!row || row.draftBlocks === null) return null
    if (!opts.expect.includes(row.draftStatus as DraftStatus)) return null
    const now = new Date()
    if (opts.dueOnly && (!row.publishAt || row.publishAt > now)) return null

    const version = row.liveVersion + 1
    const claimed = await tx.siteLayout.updateMany({
      where: {
        id: row.id,
        liveVersion: row.liveVersion,
        draftStatus: row.draftStatus,
        draftUpdatedAt: row.draftUpdatedAt,
        ...(opts.dueOnly ? { publishAt: { lte: now } } : {}),
      },
      data: {
        blocks:           row.draftBlocks as Prisma.InputJsonValue,
        settings:         row.draftSettings === null ? Prisma.DbNull : (row.draftSettings as Prisma.InputJsonValue),
        liveVersion:      version,
        publishedAt:      now,
        updatedById:      row.draftUpdatedById,
        draftBlocks:      Prisma.DbNull,
        draftSettings:    Prisma.DbNull,
        draftStatus:      'none',
        draftUpdatedAt:   null,
        draftUpdatedById: null,
        submittedAt:      null,
        submittedById:    null,
        publishAt:        null,
        reviewNote:       null,
        reviewedById:     opts.approvedById,
        reviewedAt:       now,
      },
    })
    if (claimed.count === 0) return null

    // A brand kit goes live with the brand's Concept fields in the SAME
    // transaction (ordering pages, ERP chips and the mobile app read those).
    await applyKitToConceptTx(tx, row, row.draftSettings)

    await tx.siteLayoutVersion.create({
      data: {
        layoutId:      row.id,
        version,
        blocks:        row.draftBlocks as Prisma.InputJsonValue,
        settings:      row.draftSettings === null ? Prisma.DbNull : (row.draftSettings as Prisma.InputJsonValue),
        publishedById: row.submittedById ?? row.draftUpdatedById,
        approvedById:  opts.approvedById,
        note:          opts.note ?? null,
        publishedAt:   now,
      },
    })
    return version
  })
}

/**
 * Publish every scheduled draft whose publishAt has passed (optionally only
 * the given slug / kind). Safe to call from any number of processes at once.
 */
export async function publishDueLayouts(filter: { slug?: string; kind?: string } = {}): Promise<number> {
  const due = await db.siteLayout.findMany({
    where: { draftStatus: 'scheduled', publishAt: { lte: new Date() }, ...filter },
    select: { id: true, slug: true, tenantId: true, reviewedById: true },
  })
  let published = 0
  for (const row of due) {
    try {
      const version = await publishDraft(row.id, { approvedById: row.reviewedById, expect: ['scheduled'], dueOnly: true })
      if (version === null) continue
      published++
      await audit({
        category: 'identity',
        action: 'site_layout.publish_scheduled',
        entity: 'SiteLayout',
        entityId: row.id,
        userId: row.reviewedById,
        tenantId: row.tenantId,
        after: { slug: row.slug, version },
      })
    } catch (err) {
      console.warn(`[sitePublish] ${row.slug} failed:`, (err as Error).message)
    }
  }
  return published
}

// ── Brand kit ────────────────────────────────────────────────────────────────

/** The kit inside a kit row's settings, or null (not a kit / invalid). */
export function kitOf(settings: unknown): BrandKit | null {
  if (!settings || typeof settings !== 'object') return null
  const r = brandKitSchema.safeParse((settings as Record<string, unknown>)['kit'])
  return r.success ? r.data : null
}

/**
 * When a published row is a brand kit, copy the fields it SETS onto the
 * brand's Concept — primaryColor ← roles.ordering, logoUrl ← images.logo,
 * wordmarkUrl ← images.wordmark, mascotUrl ← images.mascot. A field the kit
 * leaves empty is never written (no null over today's value). The brand is
 * found by slug inside the row's OWN company, never another's. The one sync
 * path: publishDraft (approve now + scheduled) and the rollback route call it
 * inside their publishing transaction. Returns the fields written.
 */
export async function applyKitToConceptTx(
  tx: Prisma.TransactionClient,
  row: Pick<SiteLayout, 'slug' | 'tenantId'>,
  settings: unknown,
): Promise<string[]> {
  const parsed = parseSlug(row.slug)
  if (!parsed || parsed.owner !== 'brand' || parsed.kind !== 'kit' || !row.tenantId) return []
  const kit = kitOf(settings)
  if (!kit) return []
  const data: Prisma.ConceptUpdateManyMutationInput = {}
  if (kit.roles?.ordering) data.primaryColor = kit.roles.ordering
  if (kit.images?.logo) data.logoUrl = kit.images.logo
  if (kit.images?.wordmark) data.wordmarkUrl = kit.images.wordmark
  if (kit.images?.mascot) data.mascotUrl = kit.images.mascot
  const fields = Object.keys(data)
  if (fields.length === 0) return []
  await tx.concept.updateMany({
    where: { slug: parsed.conceptSlug, tenantId: row.tenantId, deletedAt: null },
    data,
  })
  return fields
}

/** A `library:` kit font must be a font of the layout's own company (422). */
export async function assertKitFontsInCompany(kit: BrandKit, tenantId: string | null): Promise<void> {
  const ids = kitLibraryFontIds(kit)
  if (ids.length === 0) return
  const found = tenantId === null ? [] : await db.mediaAsset.findMany({
    where: { id: { in: ids }, kind: 'font', tenantId, url: { not: '' } },
    select: { id: true },
  })
  if (found.length !== ids.length) {
    throw new AppError('KIT_FONT_NOT_IN_COMPANY',
      "A Library font in this brand kit is not a font of the brand's company. Upload it to that company's Library.", 422)
  }
}

export interface KitFont { id: string; family: string; url: string; format: string | null }

function fontFormat(nameOrUrl: string): string | null {
  const ext = nameOrUrl.split('?')[0]!.split('.').pop()?.toLowerCase()
  return ext === 'woff2' ? 'woff2' : ext === 'woff' ? 'woff' : ext === 'ttf' ? 'truetype' : ext === 'otf' ? 'opentype' : null
}

/** The `library:` fonts a kit names, resolved inside the kit row's company
 *  (`id` is the kit's ref, `library:<assetId>`). Missing ones are skipped —
 *  the storefront falls back to the brand's default font. */
export async function resolveKitFonts(kit: BrandKit | null, tenantId: string | null): Promise<KitFont[]> {
  if (!kit || !tenantId) return []
  const ids = kitLibraryFontIds(kit)
  if (ids.length === 0) return []
  const assets = await db.mediaAsset.findMany({
    where: { id: { in: ids }, kind: 'font', tenantId, url: { not: '' } },
    select: { id: true, url: true, fontFamily: true, name: true, filename: true },
  })
  return assets.map((a) => ({
    id: `library:${a.id}`,
    family: a.fontFamily || a.name || a.filename,
    url: a.url,
    format: fontFormat(a.filename) ?? fontFormat(a.url),
  }))
}

// ── Read shapes ──────────────────────────────────────────────────────────────

/**
 * Library fonts for the families a page uses. A company's page reads its own
 * company's fonts; shared pages may use any company's. Newest upload wins
 * when two assets claim the same family.
 */
export async function resolveFonts(blocks: unknown, settings: unknown, tenantId: string | null) {
  const families = fontFamiliesUsed(blocks, settings)
  if (families.length === 0) return []
  const assets = await db.mediaAsset.findMany({
    where: {
      kind: 'font',
      fontFamily: { in: families },
      url: { not: '' },
      ...(tenantId ? { tenantId } : {}),
    },
    orderBy: { createdAt: 'desc' },
    select: { fontFamily: true, url: true },
  })
  const seen = new Map<string, string>()
  for (const a of assets) if (a.fontFamily && !seen.has(a.fontFamily)) seen.set(a.fontFamily, a.url)
  return [...seen].map(([family, url]) => ({ family, url }))
}

export function kindForSlug(slug: string): LayoutKind {
  return parseSlug(slug)?.kind ?? 'page'
}

/** The public read shape; `draft` = the preview (draft, falling back to live). */
export async function publicShape(slug: string, row: SiteLayout | null, draft = false) {
  if (!row) {
    return {
      slug, kind: kindForSlug(slug), title: null, version: 0,
      blocks: null, settings: null, fonts: [], publishedAt: null, updatedAt: null,
    }
  }
  const live = row.liveVersion > 0
  const useDraft = draft && row.draftBlocks !== null
  const blocks = useDraft ? row.draftBlocks : (live ? row.blocks : null)
  const settings = useDraft ? row.draftSettings : (live ? row.settings : null)
  return {
    slug: row.slug,
    kind: row.kind,
    title: row.title,
    version: row.liveVersion,
    blocks,
    settings: settings ?? null,
    fonts: !blocks ? []
      : parseSlug(row.slug)?.kind === 'kit' ? await resolveKitFonts(kitOf(settings), row.tenantId)
      : await resolveFonts(blocks, settings, row.tenantId),
    publishedAt: row.publishedAt,
    updatedAt: useDraft ? row.draftUpdatedAt : row.updatedAt,
  }
}

export async function namesById(ids: Array<string | null | undefined>): Promise<Map<string, { id: string; name: string | null }>> {
  const unique = [...new Set(ids.filter((x): x is string => !!x))]
  if (unique.length === 0) return new Map()
  const users = await db.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } })
  return new Map(users.map((u) => [u.id, u]))
}
