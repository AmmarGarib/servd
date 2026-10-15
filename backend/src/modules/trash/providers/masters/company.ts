// Trash providers — company masters & identity (stream B2; see ../../README.md).
//
//   brand     Concept            soft   CEO only, never erasable (orders, ledger). Restores INACTIVE.
//   location  Location           soft   restores active + its brand links (same company, live brands only).
//   domain    Domain             soft   restores `pending` (must re-verify DNS). Parent: its brand.
//   login     User               soft   CEO only, never erasable (identity in every audit row).
//                                       Restores SUSPENDED; old sessions stay dead.
//   rider     Rider              soft   restores inactive / offline. Erasable only with no jobs.
//   webhook   WebhookSubscription soft  restores inactive. Erasable (its delivery log goes with it).
//
// Each of these keeps its globally-unique value (slug, hostname, email, phone)
// while in the Trash, so a restore never clashes; instead the module's CREATE
// route answers 409 IN_TRASH (inTrashConflict below) so the UI can offer
// "Restore it instead" rather than a second row for the same thing.

import type { TrashEntry } from '@prisma/client'
import { serviceClient } from '../../../../lib/prisma.js'
import { AppError, ForbiddenError } from '../../../../lib/errors.js'
import { revokeAllForSubject } from '../../../../lib/tokenRevocation.js'
import { ADMIN_ONLY, MANAGERS } from '../../../auth/middleware.js'
import { WEBHOOK_ADMINS } from '../../../webhooks/routes.js'
import { syncConceptLocationMirror } from '../../../locations/routes.js'
import type { Reference, TrashProvider, Tx } from '../../types.js'

export const TRASH_COMPANY = {
  brand: 'brand',
  location: 'location',
  domain: 'domain',
  login: 'login',
  rider: 'rider',
  webhook: 'webhook',
} as const

const metaOf = (e: TrashEntry | null) => (e?.meta ?? {}) as Record<string, unknown>
const nonZero = (refs: Reference[]) => refs.filter((r) => r.count > 0)

/**
 * The 409 IN_TRASH a create route answers when the unique value it needs is
 * held by a row sitting in the Trash — or null (the caller keeps its own
 * *_TAKEN answer). `visible` = the holder belongs to a company the caller is
 * in; a holder elsewhere is never named (its id / title stay hidden).
 */
export async function inTrashConflict(
  type: string,
  entityId: string,
  visible: boolean,
  what: string,
): Promise<AppError | null> {
  if (!visible) return null
  const open = await serviceClient.trashEntry.findFirst({
    where: { entityType: type, entityId, restoredAt: null, purgedAt: null },
    select: { entityId: true, title: true },
  })
  if (!open) return null
  return new AppError(
    'IN_TRASH',
    `${what} is in the Trash — restore it instead of adding it again`,
    409,
    { type, id: open.entityId, title: open.title },
  )
}

// ── brand ────────────────────────────────────────────────────────────────────

const brand: TrashProvider = {
  key: TRASH_COMPANY.brand,
  label: 'Brand',
  moduleId: 'brands',
  roles: { list: ADMIN_ONLY, restore: ADMIN_ONLY },
  kind: 'master',
  strategy: 'soft',
  auditCategory: 'identity',
  ceoOnly: true,
  model: 'Concept',
  linkOf: () => '/ceo/brands',
  async restore(tx, _ctx, entry) {
    // Back, but switched OFF: the CEO turns it on in the brand editor.
    await tx.concept.update({ where: { id: entry.entityId }, data: { deletedAt: null, isActive: false } })
    return { id: entry.entityId, link: '/ceo/brands' }
  },
  // Orders, the ledger and fiscal documents name the brand: never erased.
  erasable: () => false,
}

// ── location ─────────────────────────────────────────────────────────────────

/** What still points at a location. Stock, orders and shifts make it never erasable. */
async function locationRefs(tx: Tx, id: string): Promise<Reference[]> {
  const w = { locationId: id }
  const [lots, moves, orders, shifts, receipts, counts, waste, prep, assets, pools, capex, fiscal, prebills, fin, transfers, clocks, staff] =
    await Promise.all([
      tx.stockLot.count({ where: w }),
      tx.stockMovement.count({ where: w }),
      tx.order.count({ where: w }),
      tx.shift.count({ where: w }),
      tx.goodsReceipt.count({ where: w }),
      tx.physicalCount.count({ where: w }),
      tx.wasteLog.count({ where: w }),
      tx.prepBatch.count({ where: w }),
      tx.fixedAsset.count({ where: w }),
      tx.fixedAssetPool.count({ where: w }),
      tx.capexProject.count({ where: w }),
      tx.fiscalDocument.count({ where: w }),
      tx.preBill.count({ where: w }),
      tx.financialEntry.count({ where: w }),
      tx.stockTransfer.count({ where: { OR: [{ fromLocationId: id }, { toLocationId: id }] } }),
      tx.clockLog.count({ where: w }),
      tx.hrEmployee.count({ where: w }),
    ])
  // Money / tax / HR rows that also carry the location (no FK on most, so a
  // purge would leave them dangling; HrWorkLocation's FK would 500).
  const [deps, petty, workLocs, foodSafety, cleaning, smsDevices, smsAlerts] = await Promise.all([
    tx.fixedAssetDepreciation.count({ where: w }),
    tx.pettyCashSpendLine.count({ where: w }),
    tx.hrWorkLocation.count({ where: w }),
    tx.foodSafetyUnit.count({ where: w }),
    tx.cleaningTask.count({ where: w }),
    tx.bankSmsDevice.count({ where: w }),
    tx.bankSmsAlert.count({ where: w }),
  ])
  return [
    { label: 'Stock lots', count: lots },
    { label: 'Stock movements', count: moves },
    { label: 'Orders', count: orders },
    { label: 'Till shifts', count: shifts },
    { label: 'Goods receipts', count: receipts },
    { label: 'Stock counts', count: counts },
    { label: 'Waste logs', count: waste },
    { label: 'Prep batches', count: prep },
    { label: 'Fixed assets', count: assets },
    { label: 'Asset pools', count: pools },
    { label: 'CapEx projects', count: capex },
    { label: 'Fiscal documents', count: fiscal },
    { label: 'Pre-bills', count: prebills },
    { label: 'Financial entries', count: fin },
    { label: 'Stock transfers', count: transfers },
    { label: 'Clock-ins', count: clocks },
    { label: 'Employees', count: staff },
    { label: 'Depreciation lines', count: deps },
    { label: 'Petty cash lines', count: petty },
    { label: 'HR work locations', count: workLocs },
    { label: 'Food safety units', count: foodSafety },
    { label: 'Cleaning tasks', count: cleaning },
    { label: 'Bank SMS devices', count: smsDevices },
    { label: 'Bank SMS alerts', count: smsAlerts },
  ]
}

// Books, tax and stock records: once any exists the location is never erased.
const BOOKS_REFS = new Set([
  'Stock lots', 'Stock movements', 'Orders', 'Till shifts', 'Goods receipts', 'Stock counts', 'Waste logs',
  'Prep batches', 'Fixed assets', 'Asset pools', 'CapEx projects', 'Fiscal documents', 'Pre-bills',
  'Financial entries', 'Stock transfers', 'Depreciation lines', 'Petty cash lines', 'Bank SMS alerts',
])

/** Called by DELETE /locations/:id: did this location ever touch stock, orders or shifts? */
export async function locationEverUsed(tx: Tx, id: string): Promise<boolean> {
  const [lots, moves, orders, shifts] = await Promise.all([
    tx.stockLot.count({ where: { locationId: id }, take: 1 }),
    tx.stockMovement.count({ where: { locationId: id }, take: 1 }),
    tx.order.count({ where: { locationId: id }, take: 1 }),
    tx.shift.count({ where: { locationId: id }, take: 1 }),
  ])
  return lots + moves + orders + shifts > 0
}

const location: TrashProvider = {
  key: TRASH_COMPANY.location,
  label: 'Location',
  moduleId: 'business_info',
  roles: { list: MANAGERS, restore: MANAGERS },
  kind: 'master',
  strategy: 'soft',
  auditCategory: 'identity',
  model: 'Location',
  linkOf: () => '/configuration/locations',
  async restore(tx, _ctx, entry) {
    const loc = await tx.location.update({
      where: { id: entry.entityId },
      data: { deletedAt: null, isActive: true },
      select: { id: true, tenantId: true },
    })
    // Brand links come back only for brands still of THIS company and live.
    const links = (Array.isArray(metaOf(entry).brandLinks) ? metaOf(entry).brandLinks : []) as Array<{ conceptId?: string; isPrimary?: boolean }>
    const wanted = links.filter((l) => typeof l.conceptId === 'string')
    const live = loc.tenantId && wanted.length
      ? await tx.concept.findMany({
          where: { id: { in: wanted.map((l) => l.conceptId!) }, tenantId: loc.tenantId, deletedAt: null },
          select: { id: true },
        })
      : []
    const liveIds = new Set(live.map((c) => c.id))
    const keep = wanted.filter((l) => liveIds.has(l.conceptId!))
    if (keep.length) {
      // A brand that got another primary kitchen while this one was in the
      // Trash keeps it: the restored link comes back as a secondary.
      const primaries = await tx.conceptLocation.findMany({
        where: { conceptId: { in: keep.map((l) => l.conceptId!) }, isPrimary: true, locationId: { not: loc.id } },
        select: { conceptId: true },
      })
      const hasPrimary = new Set(primaries.map((p) => p.conceptId))
      await tx.conceptLocation.createMany({
        data: keep.map((l) => ({ conceptId: l.conceptId!, locationId: loc.id, isPrimary: !!l.isPrimary && !hasPrimary.has(l.conceptId!) })),
        skipDuplicates: true,
      })
      await syncConceptLocationMirror(keep.map((l) => l.conceptId!), tx)
    }
    return { id: loc.id, link: '/configuration/locations' }
  },
  references: (tx, entry) => locationRefs(tx, entry.entityId).then(nonZero),
  erasable(entry, refs) {
    if (metaOf(entry).everUsed === true) return false
    return !refs.some((r) => BOOKS_REFS.has(r.label) && r.count > 0)
  },
  async purge(tx, entry) {
    await tx.conceptLocation.deleteMany({ where: { locationId: entry.entityId } })
    await tx.location.delete({ where: { id: entry.entityId } })
  },
}

// ── domain ───────────────────────────────────────────────────────────────────

const domain: TrashProvider = {
  key: TRASH_COMPANY.domain,
  label: 'Domain',
  moduleId: 'tenants',
  roles: { list: MANAGERS, restore: MANAGERS },
  kind: 'master',
  strategy: 'soft',
  auditCategory: 'identity',
  model: 'Domain',
  linkOf: () => '/configuration/domains',
  parentOf: (entry) => (entry.conceptId ? { type: TRASH_COMPANY.brand, id: entry.conceptId } : null),
  async restore(tx, _ctx, entry) {
    // Back as `pending`: DNS may have moved while it was gone, so it re-verifies
    // before the API trusts it as an origin again.
    await tx.domain.update({ where: { id: entry.entityId }, data: { deletedAt: null, status: 'pending' } })
    return { id: entry.entityId, link: '/configuration/domains' }
  },
  erasable: () => true,
}

// ── login ────────────────────────────────────────────────────────────────────

const login: TrashProvider = {
  key: TRASH_COMPANY.login,
  label: 'Login',
  moduleId: 'staff_directory',
  roles: { list: ADMIN_ONLY, restore: ADMIN_ONLY },
  kind: 'master',
  strategy: 'soft',
  auditCategory: 'identity',
  ceoOnly: true,
  model: 'User',
  linkOf: () => '/workforce?status=suspended',
  async restore(tx, ctx, entry) {
    const u = await tx.user.findUnique({
      where: { id: entry.entityId },
      select: { id: true, tenantId: true, tenantMemberships: { select: { tenantId: true } } },
    })
    if (!u) throw new AppError('NOT_FOUND', 'This login no longer exists', 404)
    // Same rule as every staff-admin write (staffAccounts.ts findManagedStaff):
    // a login that also works for a company the restorer is not in is not
    // theirs to bring back.
    const companies = [...new Set([u.tenantId, ...u.tenantMemberships.map((m) => m.tenantId)].filter(Boolean) as string[])]
    const mine = new Set(ctx.req.staffUser?.memberTenantIds ?? [])
    if (companies.some((t) => !mine.has(t))) {
      throw new ForbiddenError('This login also works for a company you are not part of — ask the group owner')
    }
    // Back SUSPENDED: the CEO activates it on Workforce. Sessions were revoked
    // at delete; revoke again so nothing issued before now ever works.
    await tx.user.update({
      where: { id: u.id },
      data: { deletedAt: null, accountStatus: 'suspended', isActive: false },
    })
    await revokeAllForSubject(u.id)
    return { id: u.id, link: '/workforce?status=suspended' }
  },
  // Identity is in every audit row: never erased.
  erasable: () => false,
}

// ── rider ────────────────────────────────────────────────────────────────────

const rider: TrashProvider = {
  key: TRASH_COMPANY.rider,
  label: 'Rider',
  moduleId: 'riders',
  roles: { list: MANAGERS, restore: MANAGERS },
  kind: 'master',
  strategy: 'soft',
  auditCategory: 'identity',
  model: 'Rider',
  linkOf: () => '/riders',
  async restore(tx, _ctx, entry) {
    // Back inactive and off shift; a manager switches them on.
    await tx.rider.update({ where: { id: entry.entityId }, data: { deletedAt: null, isActive: false, status: 'offline' } })
    await revokeAllForSubject(entry.entityId)
    return { id: entry.entityId, link: '/riders' }
  },
  async references(tx, entry) {
    const id = entry.entityId
    const [jobs, orders, ratings] = await Promise.all([
      tx.riderJobEvent.count({ where: { riderId: id } }),
      tx.order.count({ where: { OR: [{ riderId: id }, { handoverRerouteRiderId: id }] } }),
      tx.riderRating.count({ where: { riderId: id } }),
    ])
    return nonZero([
      { label: 'Delivery job events', count: jobs },
      { label: 'Orders', count: orders },
      { label: 'Ratings', count: ratings },
    ])
  },
  erasable(entry, refs) {
    if (metaOf(entry).everUsed === true) return false
    return !refs.some((r) => r.count > 0)
  },
  async purge(tx, entry) {
    await tx.riderLocation.deleteMany({ where: { riderId: entry.entityId } })
    await tx.rider.delete({ where: { id: entry.entityId } })
  },
}

// ── webhook ──────────────────────────────────────────────────────────────────

const webhook: TrashProvider = {
  key: TRASH_COMPANY.webhook,
  label: 'Webhook',
  moduleId: 'integrations',
  roles: { list: WEBHOOK_ADMINS, restore: WEBHOOK_ADMINS },
  kind: 'master',
  strategy: 'soft',
  auditCategory: 'identity',
  model: 'WebhookSubscription',
  linkOf: () => '/configuration/webhooks',
  async restore(tx, _ctx, entry) {
    // Back switched off: nothing is sent until someone turns it on again.
    await tx.webhookSubscription.update({ where: { id: entry.entityId }, data: { deletedAt: null, isActive: false } })
    return { id: entry.entityId, link: '/configuration/webhooks' }
  },
  // The delivery log cascades with it (WebhookDelivery onDelete: Cascade).
  erasable: () => true,
}

export const COMPANY_TRASH_PROVIDERS: TrashProvider[] = [brand, location, domain, login, rider, webhook]
