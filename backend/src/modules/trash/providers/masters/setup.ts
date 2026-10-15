// Trash providers — setup & configuration (stream B3; see ../../README.md).
//
//   modifier_template      ModifierTemplate        soft      options stay on the row; erasable.
//   delivery_zone          DeliveryZone            snapshot  parent: its brand (when pinned to one).
//   notification_template  NotificationTemplate    snapshot  clash on the scope key (brand, channel, event, language).
//   bank_account           BankAccount             soft      NEVER erasable (it names a chart code). Restore never
//                                                            makes it the Raast default again.
//   custom_field           CustomFieldDefinition   snapshot  WITH every stored value (finding F8); clash on the key
//                                                            renames it.
//   scheduled_report       ScheduledReport         soft      restore re-checks mayScheduleReport for its creator.
//
// KDS devices are not here (a pairing credential: re-pair). Roles are the
// module routes' own guards (MANAGERS / FINANCE_TEAM), imported, never retyped.
// The three config pages with no module of their own (templates, custom
// fields, scheduled reports) are gated by 'dashboard', which every MANAGERS
// role holds, on top of the role list.

import type { TrashEntry, UserRole } from '@prisma/client'
import { AppError } from '../../../../lib/errors.js'
import { mayScheduleReport } from '../../../../lib/moduleAccess.js'
import { MANAGERS, FINANCE_TEAM } from '../../../auth/middleware.js'
import { restoreSnapshot, type Snapshot } from '../../snapshot.js'
import type { Reference, TrashProvider, Tx } from '../../types.js'

export const TRASH_SETUP = {
  modifier_template: 'modifier_template',
  delivery_zone: 'delivery_zone',
  notification_template: 'notification_template',
  bank_account: 'bank_account',
  custom_field: 'custom_field',
  scheduled_report: 'scheduled_report',
} as const

const metaOf = (e: TrashEntry) => (e.meta ?? {}) as Record<string, unknown>
const snapOf = (e: TrashEntry) => e.snapshot as unknown as Snapshot | null
const parentOf = (e: TrashEntry) => (e.parentType && e.parentId ? { type: e.parentType, id: e.parentId } : null)

/** A brand-anchored row may only come back to a brand that is still live in the SAME company. */
async function assertBrandLive(tx: Tx, tenantId: string | null, conceptId: string | null | undefined): Promise<void> {
  if (!conceptId) return
  const brand = await tx.concept.findFirst({ where: { id: conceptId, tenantId, deletedAt: null }, select: { id: true } })
  if (!brand) {
    throw new AppError('BRAND_NOT_AVAILABLE', 'The brand this belongs to no longer exists in this company — it cannot be restored', 409)
  }
}

const MANAGER_ROLES = MANAGERS as readonly UserRole[]
const FINANCE_ROLES = FINANCE_TEAM as readonly UserRole[]

// ── modifier template ────────────────────────────────────────────────────────

const modifierTemplate: TrashProvider = {
  key: TRASH_SETUP.modifier_template,
  label: 'Modifier template',
  moduleId: 'menu',
  roles: { list: MANAGER_ROLES, restore: MANAGER_ROLES },
  kind: 'master',
  strategy: 'soft',
  auditCategory: 'identity',
  model: 'ModifierTemplate',
  linkOf: () => '/configuration/modifiers',
  async restore(tx, _ctx, entry) {
    const prev = (metaOf(entry).previous ?? {}) as { isActive?: boolean }
    await tx.modifierTemplate.update({ where: { id: entry.entityId }, data: { deletedAt: null, isActive: prev.isActive ?? true } })
    return { id: entry.entityId, link: '/configuration/modifiers' }
  },
  // Applying a template clones its options into a menu item, so nothing points back at it.
  erasable: () => true,
}

// ── delivery zone ────────────────────────────────────────────────────────────

const deliveryZone: TrashProvider = {
  key: TRASH_SETUP.delivery_zone,
  label: 'Delivery zone',
  moduleId: 'business_info',
  roles: { list: MANAGER_ROLES, restore: MANAGER_ROLES },
  kind: 'master',
  strategy: 'snapshot',
  auditCategory: 'identity',
  linkOf: () => '/configuration/delivery-zones',
  parentOf,
  async restore(tx, _ctx, entry) {
    const snap = snapOf(entry)
    if (!snap) throw new AppError('PURGED', 'This item was deleted forever', 409)
    await assertBrandLive(tx, entry.tenantId, snap.row.conceptId as string | null)
    await restoreSnapshot(tx, snap, { tenantId: entry.tenantId })
    return { id: entry.entityId, link: '/configuration/delivery-zones' }
  },
  erasable: () => true,
}

// ── notification template ────────────────────────────────────────────────────

const notificationTemplate: TrashProvider = {
  key: TRASH_SETUP.notification_template,
  label: 'Message template',
  moduleId: 'dashboard',
  roles: { list: MANAGER_ROLES, restore: MANAGER_ROLES },
  kind: 'master',
  strategy: 'snapshot',
  auditCategory: 'identity',
  linkOf: () => '/configuration/templates',
  parentOf,
  async clashOf(tx, entry) {
    const row = snapOf(entry)?.row
    if (!row) return null
    // One template per (company, brand or all brands, channel, event, language).
    const live = await tx.notificationTemplate.findFirst({
      where: {
        tenantId: entry.tenantId, conceptId: (row.conceptId as string | null) ?? null,
        channel: row.channel as string, event: row.event as string, language: (row.language as string) ?? 'en',
      },
      select: { id: true },
    })
    if (!live) return null
    return {
      field: 'event', value: `${row.event as string} (${row.channel as string}, ${(row.language as string) ?? 'en'})`,
      renamable: false,
      message: 'A template for this event, channel and language already exists — edit that one, or delete it first',
    }
  },
  async restore(tx, _ctx, entry) {
    const snap = snapOf(entry)
    if (!snap) throw new AppError('PURGED', 'This item was deleted forever', 409)
    await assertBrandLive(tx, entry.tenantId, snap.row.conceptId as string | null)
    await restoreSnapshot(tx, snap, { tenantId: entry.tenantId })
    return { id: entry.entityId, link: '/configuration/templates' }
  },
  erasable: () => true,
}

// ── bank account ─────────────────────────────────────────────────────────────

const bankAccount: TrashProvider = {
  key: TRASH_SETUP.bank_account,
  label: 'Bank account',
  moduleId: 'accounting',
  roles: { list: FINANCE_ROLES, restore: FINANCE_ROLES },
  kind: 'master',
  strategy: 'soft',
  auditCategory: 'accounting',
  model: 'BankAccount',
  linkOf: () => '/configuration/bank-accounts',
  async restore(tx, _ctx, entry) {
    const row = await tx.bankAccount.findUnique({ where: { id: entry.entityId }, select: { accountCode: true, tenantId: true } })
    if (!row) throw new AppError('PURGED', 'This item was deleted forever', 409)
    // Its chart code must still be a live account of ITS company.
    if (row.accountCode) {
      const acc = await tx.account.findFirst({ where: { tenantId: row.tenantId, code: row.accountCode, isActive: true }, select: { id: true } })
      if (!acc) {
        throw new AppError('BANK_ACCOUNT_NOT_LINKED', `Chart code ${row.accountCode} is no longer an active account in this company's chart — relink it first`, 409)
      }
    }
    // Back, active — but NEVER the Raast default again: the finance team picks that on purpose.
    await tx.bankAccount.update({ where: { id: entry.entityId }, data: { deletedAt: null, isActive: true, raastDefault: false } })
    return { id: entry.entityId, link: '/configuration/bank-accounts' }
  },
  async references(tx, entry): Promise<Reference[]> {
    const [receipts, brands] = await Promise.all([
      tx.raastReceipt.count({ where: { bankAccountId: entry.entityId } }),
      tx.concept.count({ where: { raastBankAccountId: entry.entityId } }),
    ])
    return [{ label: 'Raast receipts', count: receipts }, { label: 'Brand Raast overrides', count: brands }]
  },
  // A bank account names a chart code and its ledger history: never erased.
  erasable: () => false,
}

// ── custom field ─────────────────────────────────────────────────────────────

const customField: TrashProvider = {
  key: TRASH_SETUP.custom_field,
  label: 'Custom field',
  moduleId: 'dashboard',
  roles: { list: MANAGER_ROLES, restore: MANAGER_ROLES },
  kind: 'master',
  strategy: 'snapshot',
  auditCategory: 'identity',
  linkOf: () => '/configuration/custom-fields',
  async clashOf(tx, entry, opts) {
    const row = snapOf(entry)?.row
    if (!row) return null
    const key = opts.rename?.key ?? (row.key as string)
    if (opts.rename?.key && !/^[a-z][a-z0-9_]{0,39}$/.test(opts.rename.key)) {
      throw new AppError('VALIDATION_ERROR', 'Use snake_case (a–z, 0–9, _), up to 40 characters', 400)
    }
    const live = await tx.customFieldDefinition.findFirst({
      where: { tenantId: entry.tenantId, scope: row.scope as string, key }, select: { id: true },
    })
    if (!live) return null
    return { field: 'key', value: key, suggestion: `${key}_2`.slice(0, 40), renamable: true }
  },
  async restore(tx, _ctx, entry, opts) {
    const snap = snapOf(entry)
    if (!snap) throw new AppError('PURGED', 'This item was deleted forever', 409)
    // The stored values come back with the field (same ids).
    await restoreSnapshot(tx, snap, {
      tenantId: entry.tenantId,
      ...(opts.rename?.key ? { override: { key: opts.rename.key } } : {}),
    })
    return { id: entry.entityId, link: '/configuration/custom-fields' }
  },
  erasable: () => true,
}

// ── scheduled report ─────────────────────────────────────────────────────────

const scheduledReport: TrashProvider = {
  key: TRASH_SETUP.scheduled_report,
  label: 'Scheduled report',
  moduleId: 'dashboard',
  roles: { list: MANAGER_ROLES, restore: MANAGER_ROLES },
  kind: 'master',
  strategy: 'soft',
  auditCategory: 'identity',
  model: 'ScheduledReport',
  linkOf: () => '/configuration/scheduled-reports',
  parentOf,
  async restore(tx, ctx, entry) {
    const row = await tx.scheduledReport.findUnique({
      where: { id: entry.entityId }, select: { reportType: true, conceptId: true, tenantId: true, createdById: true },
    })
    if (!row) throw new AppError('PURGED', 'This item was deleted forever', 409)
    await assertBrandLive(tx, row.tenantId, row.conceptId)
    // The report emails data of a module (food cost, AP aging): its creator
    // must still hold that module, as at creation and on every run. A report
    // with no known creator is checked against the person restoring it.
    const who = row.createdById ?? ctx.user.id
    const u = await tx.user.findFirst({
      where: { id: who, deletedAt: null }, select: { role: true, moduleAllow: true, moduleDeny: true },
    })
    if (!u || !(await mayScheduleReport({ role: u.role, moduleAllow: u.moduleAllow ?? [], moduleDeny: u.moduleDeny ?? [] }, row.reportType))) {
      throw new AppError('REPORT_MODULE_REQUIRED', 'The person who set this report up no longer has access to the module it reports on, so it cannot be restored', 403)
    }
    const prev = (metaOf(entry).previous ?? {}) as { isActive?: boolean }
    await tx.scheduledReport.update({ where: { id: entry.entityId }, data: { deletedAt: null, isActive: prev.isActive ?? true } })
    return { id: entry.entityId, link: '/configuration/scheduled-reports' }
  },
  erasable: () => true,
}

export const SETUP_TRASH_PROVIDERS: TrashProvider[] = [
  modifierTemplate, deliveryZone, notificationTemplate, bankAccount, customField, scheduledReport,
]

