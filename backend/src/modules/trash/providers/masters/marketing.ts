// Trash providers — marketing & content (stream B4; contract in ../../README.md).
//
//   promo_code        PromoCode         soft      Orders and usages point at a code, so a delete sets deletedAt AND
//                                                 isActive false. lib/promoEval.ts filters deletedAt: null, so a
//                                                 trashed code is never redeemable. Restore -> back to the on / off
//                                                 state it had. Clash: a live code with the same text -> 409 with
//                                                 a suggestion (renamable). A used code is NEVER erased.
//   discount          SectionDiscount   snapshot  Parent: its brand, and its category when it has one.
//   qr_code           QrCode            snapshot  Same id on restore, so a printed code works again.
//   tier_config       TierConfig        snapshot  Clash on (company, tier slug); the slug is immutable, so not renamable.
//   content_event     ContentEvent      snapshot  WITH its social post (finding F8). A post that was waiting to go out
//                                                 comes back as a draft: nothing is published by a restore.
//   media_asset       MediaAsset        snapshot  Row only (the stored file was never deleted).
//   storefront_promo  StorefrontPromo   snapshot  The storefront banner cards.
//   site_layout       SiteLayout        snapshot  CEO only. WITH every version and A/B counter (finding F8). `servd:*`
//                                                 and `page:*` rows have a null company on purpose (the CEO's alone).
//                                                 A scheduled publish comes back as a plain draft; a brand kit that was
//                                                 live is applied to the brand again.
//
// Roles are the module routes' own guards (MARKETING_TEAM / MANAGERS), imported, never retyped.

import { Prisma, type TrashEntry, type UserRole } from '@prisma/client'
import { AppError } from '../../../../lib/errors.js'
import { MARKETING_TEAM, MANAGERS, ADMIN_ONLY } from '../../../auth/middleware.js'
import { restoreSnapshot, type Snapshot } from '../../snapshot.js'
import {
  parseSlug, kitLiveSettingsTx, stripServerSettings, syncKitToConceptTx,
} from '../../../siteLayouts/service.js'
import type { Clash, Reference, RestoreOpts, TrashProvider, Tx } from '../../types.js'

export const TRASH_MARKETING = {
  promo_code: 'promo_code',
  discount: 'discount',
  qr_code: 'qr_code',
  tier_config: 'tier_config',
  content_event: 'content_event',
  media_asset: 'media_asset',
  storefront_promo: 'storefront_promo',
  site_layout: 'site_layout',
} as const

const MARKETING_ROLES = MARKETING_TEAM as readonly UserRole[]
const MANAGER_ROLES = MANAGERS as readonly UserRole[]
const CEO_ROLES = ADMIN_ONLY as readonly UserRole[]

const metaOf = (e: TrashEntry) => (e.meta ?? {}) as Record<string, unknown>
const snapOf = (e: TrashEntry) => e.snapshot as unknown as Snapshot | null
const live = (refs: Reference[]) => refs.filter((r) => r.count > 0)
const parentBrand = (e: TrashEntry) => (e.parentType && e.parentId ? { type: e.parentType, id: e.parentId } : null)

function needSnapshot(entry: TrashEntry): Snapshot {
  const snap = snapOf(entry)
  if (!snap) throw new AppError('PURGED', 'This item was deleted forever', 409)
  return snap
}

/** A brand-anchored row may only come back to a live brand of the SAME company. */
async function assertBrandLive(tx: Tx, tenantId: string | null, conceptId: string | null | undefined): Promise<void> {
  if (!conceptId) return
  const brand = await tx.concept.findUnique({ where: { id: conceptId }, select: { id: true, name: true, tenantId: true, deletedAt: true } })
  if (brand && brand.tenantId === tenantId && !brand.deletedAt) return
  if (brand && brand.tenantId === tenantId && brand.deletedAt) {
    throw new AppError('PARENT_IN_TRASH', `Restore the brand "${brand.name}" first — it is in the Trash too`, 409, {
      parent: { type: 'brand', id: brand.id, title: brand.name },
    })
  }
  throw new AppError('BRAND_NOT_AVAILABLE', 'The brand this belongs to no longer exists in this company — it cannot be restored', 409)
}

/** First `<base>-N` (N from 2) that no LIVE promo of the company uses. */
async function freePromoCode(tx: Tx, tenantId: string | null, base: string): Promise<string> {
  for (let n = 2; n < 100; n++) {
    const candidate = `${base.slice(0, 46)}-${n}`
    const taken = await tx.promoCode.findFirst({ where: { tenantId, code: candidate, deletedAt: null }, select: { id: true } })
    if (!taken) return candidate
  }
  return `${base.slice(0, 40)}-${Date.now() % 100000}`
}

// ── promo code ───────────────────────────────────────────────────────────────

const promoCode: TrashProvider = {
  key: TRASH_MARKETING.promo_code,
  label: 'Promo code',
  moduleId: 'promos',
  roles: { list: MARKETING_ROLES, restore: MARKETING_ROLES },
  kind: 'master',
  strategy: 'soft',
  auditCategory: 'identity',
  model: 'PromoCode',
  linkOf: () => '/promos',
  parentOf: parentBrand,
  async clashOf(tx, entry, opts) {
    const promo = await tx.promoCode.findUnique({ where: { id: entry.entityId }, select: { code: true, tenantId: true, conceptId: true } })
    if (!promo) throw new AppError('PURGED', 'This item was deleted forever', 409)
    await assertBrandLive(tx, promo.tenantId, promo.conceptId)
    const code = (opts.rename?.code ?? promo.code).trim().toUpperCase()
    if (opts.rename?.code !== undefined && (code.length < 1 || code.length > 50)) {
      throw new AppError('VALIDATION_ERROR', 'A promo code is 1 to 50 characters', 400)
    }
    const other = await tx.promoCode.findFirst({
      where: { tenantId: promo.tenantId, code, deletedAt: null, id: { not: entry.entityId } }, select: { id: true },
    })
    if (!other) return null
    const clash: Clash = {
      field: 'code', value: code, suggestion: await freePromoCode(tx, promo.tenantId, code), renamable: true,
      message: `Your company already has a live promo with the code ${code} — restore this one under another code`,
    }
    return clash
  },
  async restore(tx, _ctx, entry, opts: RestoreOpts) {
    const prev = (metaOf(entry).previous ?? {}) as { isActive?: boolean }
    await tx.promoCode.update({
      where: { id: entry.entityId },
      data: {
        deletedAt: null,
        // Back to the on / off state it had when it was deleted.
        isActive: prev.isActive ?? false,
        ...(opts.rename?.code ? { code: opts.rename.code.trim().toUpperCase() } : {}),
      },
    })
    return { id: entry.entityId, link: '/promos' }
  },
  async references(tx, entry) {
    return live([
      { label: 'Redemptions (usage log)', count: await tx.promoCodeUsage.count({ where: { promoCodeId: entry.entityId } }) },
      { label: 'Orders that used it', count: await tx.order.count({ where: { promoCodeId: entry.entityId } }) },
    ])
  },
  erasable: () => true,
}

// ── section discount ─────────────────────────────────────────────────────────

const discount: TrashProvider = {
  key: TRASH_MARKETING.discount,
  label: 'Section discount',
  moduleId: 'promos',
  roles: { list: MARKETING_ROLES, restore: MARKETING_ROLES },
  kind: 'master',
  strategy: 'snapshot',
  auditCategory: 'identity',
  linkOf: () => '/discounts',
  parentOf: parentBrand,
  async clashOf(tx, entry) {
    const row = needSnapshot(entry).row
    await assertBrandLive(tx, entry.tenantId, row.conceptId as string | null)
    const categoryId = row.categoryId as string | null
    if (categoryId) {
      const cat = await tx.category.findUnique({ where: { id: categoryId }, select: { id: true, name: true, deletedAt: true, conceptId: true } })
      if (!cat) throw new AppError('NOT_RESTORABLE', 'The menu category this discount was on no longer exists — create the discount again', 422)
      if (cat.deletedAt) {
        throw new AppError('PARENT_IN_TRASH', `Restore the category "${cat.name}" first — it is in the Trash too`, 409, {
          parent: { type: 'category', id: cat.id, title: cat.name },
        })
      }
    }
    return null
  },
  async restore(tx, _ctx, entry) {
    await restoreSnapshot(tx, needSnapshot(entry), { tenantId: entry.tenantId })
    return { id: entry.entityId, link: '/discounts' }
  },
  erasable: () => true,
}

// ── QR code ──────────────────────────────────────────────────────────────────

const qrCode: TrashProvider = {
  key: TRASH_MARKETING.qr_code,
  label: 'QR code',
  moduleId: 'promos',
  roles: { list: MARKETING_ROLES, restore: MARKETING_ROLES },
  kind: 'master',
  strategy: 'snapshot',
  auditCategory: 'identity',
  linkOf: () => '/qrcodes',
  parentOf: parentBrand,
  async clashOf(tx, entry) {
    await assertBrandLive(tx, entry.tenantId, needSnapshot(entry).row.conceptId as string | null)
    return null
  },
  async restore(tx, _ctx, entry) {
    const snap = needSnapshot(entry)
    // A table that has been deleted since is dropped from the code (it opens the brand's menu).
    let override: Record<string, unknown> | undefined
    const tableId = snap.row.tableId as string | null
    if (tableId) {
      const table = await tx.table.findFirst({ where: { id: tableId, deletedAt: null }, select: { id: true } })
      if (!table) override = { tableId: null }
    }
    await restoreSnapshot(tx, snap, { tenantId: entry.tenantId, ...(override ? { override } : {}) })
    return { id: entry.entityId, link: '/qrcodes' }
  },
  erasable: () => true,
}

// ── loyalty tier ─────────────────────────────────────────────────────────────

const tierConfig: TrashProvider = {
  key: TRASH_MARKETING.tier_config,
  label: 'Loyalty tier',
  moduleId: 'crm',
  roles: { list: MARKETING_ROLES, restore: MARKETING_ROLES },
  kind: 'master',
  strategy: 'snapshot',
  auditCategory: 'identity',
  linkOf: () => '/loyalty',
  async clashOf(tx, entry) {
    const row = needSnapshot(entry).row
    const other = await tx.tierConfig.findFirst({ where: { tenantId: entry.tenantId, tier: row.tier as string }, select: { id: true } })
    if (!other) return null
    return {
      field: 'tier', value: String(row.tier), renamable: false,
      message: `A tier "${String(row.tier)}" already exists — edit that one, or delete it first`,
    }
  },
  async restore(tx, _ctx, entry) {
    await restoreSnapshot(tx, needSnapshot(entry), { tenantId: entry.tenantId })
    return { id: entry.entityId, link: '/loyalty' }
  },
  erasable: () => true,
}

// ── calendar event ───────────────────────────────────────────────────────────

const contentEvent: TrashProvider = {
  key: TRASH_MARKETING.content_event,
  label: 'Calendar event',
  moduleId: 'calendar',
  roles: { list: MANAGER_ROLES, restore: MANAGER_ROLES },
  kind: 'master',
  strategy: 'snapshot',
  auditCategory: 'identity',
  linkOf: () => '/calendar',
  parentOf: parentBrand,
  async clashOf(tx, entry) {
    await assertBrandLive(tx, entry.tenantId, needSnapshot(entry).row.conceptId as string | null)
    return null
  },
  async restore(tx, _ctx, entry) {
    const snap = needSnapshot(entry)
    // The assignee is dropped when they are no longer staff of this company.
    let override: Record<string, unknown> | undefined
    const assigneeId = snap.row.assigneeId as string | null
    if (assigneeId && entry.tenantId) {
      const staff = await tx.user.findFirst({
        where: { id: assigneeId, deletedAt: null, OR: [{ tenantId: entry.tenantId }, { tenantMemberships: { some: { tenantId: entry.tenantId } } }] },
        select: { id: true },
      })
      if (!staff) override = { assigneeId: null }
    }
    await restoreSnapshot(tx, snap, { tenantId: entry.tenantId, ...(override ? { override } : {}) })
    // Nothing is published by a restore: a post that was still waiting to go out
    // (and whose time may be long past) comes back as a draft to schedule again.
    const post = await tx.socialPost.findUnique({ where: { eventId: entry.entityId }, select: { id: true, status: true } })
    if (post?.status === 'scheduled') {
      await tx.socialPost.update({ where: { id: post.id }, data: { status: 'draft', error: null } })
      await tx.contentEvent.updateMany({ where: { id: entry.entityId, status: 'scheduled' }, data: { status: 'draft' } })
    }
    return { id: entry.entityId, link: '/calendar' }
  },
  erasable: () => true,
}

// ── media asset ──────────────────────────────────────────────────────────────

const mediaAsset: TrashProvider = {
  key: TRASH_MARKETING.media_asset,
  label: 'Library file',
  moduleId: 'media',
  roles: { list: MANAGER_ROLES, restore: MANAGER_ROLES },
  kind: 'master',
  strategy: 'snapshot',
  auditCategory: 'identity',
  linkOf: () => '/storefront',
  parentOf: parentBrand,
  async clashOf(tx, entry) {
    await assertBrandLive(tx, entry.tenantId, needSnapshot(entry).row.conceptId as string | null)
    return null
  },
  async restore(tx, _ctx, entry) {
    await restoreSnapshot(tx, needSnapshot(entry), { tenantId: entry.tenantId })
    return { id: entry.entityId, link: '/storefront' }
  },
  // Row only: the stored file was never deleted, so there is nothing else to lose.
  erasable: () => true,
}

// ── storefront promo banner ──────────────────────────────────────────────────

const storefrontPromo: TrashProvider = {
  key: TRASH_MARKETING.storefront_promo,
  label: 'Storefront promo card',
  moduleId: 'storefront',
  roles: { list: MANAGER_ROLES, restore: MANAGER_ROLES },
  kind: 'master',
  strategy: 'snapshot',
  auditCategory: 'identity',
  linkOf: () => '/storefront',
  async restore(tx, _ctx, entry) {
    await restoreSnapshot(tx, needSnapshot(entry), { tenantId: entry.tenantId })
    return { id: entry.entityId, link: '/storefront' }
  },
  erasable: () => true,
}

// ── site layout (storefront page) ────────────────────────────────────────────

/** Slug -> its brand's slug, for `brand:<slug>[:<part>]` rows. */
function brandSlugOf(slug: string): string | null {
  const parsed = parseSlug(slug)
  return parsed && parsed.owner === 'brand' ? parsed.conceptSlug ?? null : null
}

const siteLayout: TrashProvider = {
  key: TRASH_MARKETING.site_layout,
  label: 'Storefront page',
  moduleId: 'storefront',
  roles: { list: CEO_ROLES, restore: CEO_ROLES },
  // The CEO's alone: nothing reaches the storefront without them, and the
  // shared pages (servd:*, page:*) belong to no company.
  ceoOnly: true,
  kind: 'master',
  strategy: 'snapshot',
  auditCategory: 'identity',
  linkOf: () => '/storefront',
  async clashOf(tx, entry, opts) {
    const row = needSnapshot(entry).row
    const slug = String(row.slug)
    // A brand page needs its brand: live in the entry's company, else the brand is in the Trash.
    const brandSlug = brandSlugOf(slug)
    if (brandSlug) {
      const brand = await tx.concept.findFirst({ where: { slug: brandSlug, tenantId: entry.tenantId }, select: { id: true, name: true, deletedAt: true } })
      if (!brand) throw new AppError('BRAND_NOT_AVAILABLE', 'The brand this page belongs to no longer exists in this company — it cannot be restored', 409)
      if (brand.deletedAt) {
        throw new AppError('PARENT_IN_TRASH', `Restore the brand "${brand.name}" first — it is in the Trash too`, 409, {
          parent: { type: 'brand', id: brand.id, title: brand.name },
        })
      }
    }
    const target = opts.rename?.slug ?? slug
    if (opts.rename?.slug) {
      // Only a CEO's own custom page may take another address.
      const parsed = parseSlug(target)
      if (!slug.startsWith('page:') || !target.startsWith('page:') || !parsed) {
        throw new AppError('VALIDATION_ERROR', 'Only a custom page (page:<name>) can be restored under another address', 400)
      }
    }
    const other = await tx.siteLayout.findUnique({ where: { slug: target }, select: { id: true } })
    if (!other) return null
    return {
      field: 'slug', value: target, renamable: slug.startsWith('page:'),
      ...(slug.startsWith('page:') ? { suggestion: `${slug}-2` } : {}),
      message: `A page at ${target} already exists — edit that one, or delete it first`,
    }
  },
  async restore(tx, _ctx, entry, opts) {
    const snap = needSnapshot(entry)
    const row = snap.row
    // A publish that was scheduled for a time long gone must not fire by itself.
    const override: Record<string, unknown> = {}
    if (row.draftStatus === 'scheduled') Object.assign(override, { draftStatus: 'draft', publishAt: null, submittedAt: null, submittedById: null })
    if (opts.rename?.slug) override.slug = opts.rename.slug
    await restoreSnapshot(tx, snap, { tenantId: entry.tenantId, ...(Object.keys(override).length ? { override } : {}) })

    // A brand kit that was live is applied to the brand again. Its pre-kit
    // snapshot is stale (the brand may have been edited since the kit was
    // removed), so it is dropped and taken from the brand as it is NOW.
    const restored = await tx.siteLayout.findUniqueOrThrow({ where: { id: entry.entityId } })
    const parsed = parseSlug(restored.slug)
    if (parsed?.owner === 'brand' && parsed.kind === 'kit' && restored.liveVersion > 0
        && restored.settings && typeof restored.settings === 'object' && !Array.isArray(restored.settings)) {
      const clean = stripServerSettings(restored.settings)
      await tx.siteLayout.update({ where: { id: restored.id }, data: { settings: clean as Prisma.InputJsonValue } })
      const liveSettings = await kitLiveSettingsTx(tx, { ...restored, settings: clean }, clean)
      await tx.siteLayout.update({ where: { id: restored.id }, data: { settings: liveSettings.settings as Prisma.InputJsonValue } })
      await syncKitToConceptTx(tx, restored, null, liveSettings.settings, liveSettings.before)
    }
    return { id: entry.entityId, link: '/storefront' }
  },
  erasable: () => true,
}

export const MARKETING_TRASH_PROVIDERS: TrashProvider[] = [
  promoCode, discount, qrCode, tierConfig, contentEvent, mediaAsset, storefrontPromo, siteLayout,
]
