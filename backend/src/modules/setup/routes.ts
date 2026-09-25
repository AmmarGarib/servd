// Aggregated setup module — handles 13 of the 18 newly-shipped configuration
// areas. Some are full CRUD (modifier templates, delivery zones, notification
// templates, bank accounts, kds devices, webhooks, custom fields, scheduled
// reports), some are single-record settings (refund policy, reservation
// policy, receipt config, operations config — service charge, tip pool, tax
// numbering, withholding, brand assets).
//
// Single record settings use the `scope='global'` convention with auto-create
// on first read so the editor always has something to render — one global
// row PER COMPANY (unique on tenantId + scope + scopeId).
//
// Company scoping: everything here is company master data. Rows that carry a
// tenantId (modifier templates, bank accounts, KDS devices, webhooks, the
// four singleton configs) are read through `scopeTenantWhere` and created
// against the ACTIVE company. Rows anchored to a brand (delivery zones,
// notification templates, scheduled reports, service hours, blockouts, brand
// identity) are reached only through brands of a company in scope — a
// guessed id from another company 404s, and a create can never bind to a
// brand of a company other than the one the operator is acting in.

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { randomBytes } from 'crypto'
import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { audit } from '../../lib/audit.js'
import { requireAuth, MANAGERS, ADMIN_ONLY, ALL_STAFF } from '../auth/middleware.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import {
  scopeTenantWhere, assertConceptOwned, conceptIdsInScope, conceptWhere, type ScopeMode,
} from '../../lib/tenantScope.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** The company a create binds to. 422 when the operator has no active company. */
function activeTenantId(req: FastifyRequest): string {
  const tenantId = req.staffUser?.tenantId
  if (!tenantId) throw new AppError('NO_ACTIVE_COMPANY', 'Pick a company before saving this setting', 422)
  return tenantId
}

/**
 * Where-fragment for brand-optional setup rows (delivery zones, notification
 * templates, scheduled reports). Every row carries the owning company
 * (tenantId, migration 20260907140000) — including the "All brands" rows
 * (conceptId=null), which are that company's defaults, never shared. A
 * client-supplied conceptId is validated against the scope (404 when
 * foreign) on top of the company filter.
 */
async function brandRowWhere(
  req: FastifyRequest,
  conceptId: string | undefined,
  mode: ScopeMode,
): Promise<Record<string, unknown>> {
  const tenant = await scopeTenantWhere(req, mode)
  if (conceptId) return { ...tenant, ...(await conceptWhere(req, conceptId, mode)) }
  return { ...tenant }
}

/** 422 unless `conceptId` is a live brand of `tenantId`. */
async function assertBrandOf(tenantId: string, conceptId: string): Promise<void> {
  const concept = await prisma.concept.findFirst({
    where: { id: conceptId, tenantId, deletedAt: null },
    select: { id: true },
  })
  if (!concept) throw new AppError('BRAND_NOT_IN_COMPANY', 'That brand does not belong to this company', 422)
}

/** 422 unless `stationId` is a live station of a brand of `tenantId`. */
async function assertStationOf(tenantId: string, stationId: string): Promise<void> {
  const station = await prisma.station.findFirst({
    where: { id: stationId, deletedAt: null, concept: { tenantId, deletedAt: null } },
    select: { id: true },
  })
  if (!station) throw new AppError('STATION_NOT_IN_COMPANY', 'That station does not belong to this company', 422)
}

async function findOrCreateSingleton<T>(
  modelName: 'refundPolicy' | 'reservationPolicy' | 'receiptConfig' | 'operationsConfig',
  tenantId: string,
  defaults: Partial<T>,
): Promise<T> {
  const model = prisma[modelName] as unknown as { findFirst: (a: unknown) => Promise<T | null>; create: (a: unknown) => Promise<T> }
  // The active company's global row — never a company-less one, and never
  // another company's.
  const existing = await model.findFirst({ where: { scope: 'global', scopeId: null, tenantId } })
  if (existing) return existing
  return model.create({ data: { scope: 'global', scopeId: null, tenantId, ...defaults } })
}

// ─── Routes ──────────────────────────────────────────────────────────────────

export async function setupRoutes(fastify: FastifyInstance) {

  // ════════════════════════════════════════════════════════════════════════
  // 1. Modifier templates
  // ════════════════════════════════════════════════════════════════════════

  fastify.get('/modifier-templates', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    return prisma.modifierTemplate.findMany({
      where: { deletedAt: null, ...(await scopeTenantWhere(req, 'read')) },
      include: { options: { orderBy: { sortOrder: 'asc' } } },
      orderBy: { sortOrder: 'asc' },
    })
  })

  fastify.post('/modifier-templates', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = z.object({
      name:        z.string().min(1).max(80),
      description: z.string().max(500).optional(),
      isRequired:  z.boolean().default(false),
      minSelect:   z.number().int().min(0).default(0),
      maxSelect:   z.number().int().min(1).default(1),
      options: z.array(z.object({
        name:            z.string().min(1).max(80),
        priceDeltaCents: z.number().int().default(0),
        isDefault:       z.boolean().default(false),
      })).default([]),
    }).parse(req.body)
    const { options, ...rest } = body
    const created = await prisma.modifierTemplate.create({
      data: { ...rest, tenantId: activeTenantId(req), options: { create: options.map((o, i) => ({ ...o, sortOrder: i })) } },
      include: { options: true },
    })
    return reply.status(201).send(created)
  })

  fastify.patch<{ Params: { id: string } }>('/modifier-templates/:id', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const body = z.object({
      name:        z.string().min(1).max(80).optional(),
      description: z.string().max(500).nullable().optional(),
      isRequired:  z.boolean().optional(),
      minSelect:   z.number().int().min(0).optional(),
      maxSelect:   z.number().int().min(1).optional(),
      isActive:    z.boolean().optional(),
      options: z.array(z.object({
        name:            z.string().min(1).max(80),
        priceDeltaCents: z.number().int(),
        isDefault:       z.boolean(),
      })).optional(),
    }).parse(req.body)
    const { options, ...rest } = body
    const existing = await prisma.modifierTemplate.findFirst({
      where: { id: req.params.id, deletedAt: null, ...(await scopeTenantWhere(req, 'write')) },
      select: { id: true },
    })
    if (!existing) throw new NotFoundError('ModifierTemplate', req.params.id)
    if (options) {
      await prisma.modifierTemplateOption.deleteMany({ where: { templateId: existing.id } })
      await prisma.modifierTemplateOption.createMany({
        data: options.map((o, i) => ({ ...o, templateId: existing.id, sortOrder: i })),
      })
    }
    return prisma.modifierTemplate.update({
      where: { id: existing.id }, data: rest,
      include: { options: { orderBy: { sortOrder: 'asc' } } },
    })
  })

  fastify.delete<{ Params: { id: string } }>('/modifier-templates/:id', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const existing = await prisma.modifierTemplate.findFirst({
      where: { id: req.params.id, deletedAt: null, ...(await scopeTenantWhere(req, 'write')) },
      select: { id: true },
    })
    if (!existing) throw new NotFoundError('ModifierTemplate', req.params.id)
    await prisma.modifierTemplate.update({ where: { id: existing.id }, data: { deletedAt: new Date(), isActive: false } })
    return reply.status(204).send()
  })

  // POST /setup/modifier-templates/:id/apply — clone the template's options
  // into a new ModifierGroup attached to the given menu item. Templates and
  // groups have different shapes (templates are shared; groups are per-item),
  // so this is a one-way materialisation. This creates a row under the item's
  // brand, so both the template and the item must belong to the ACTIVE
  // company — never materialise one company's template onto another's menu.
  fastify.post<{ Params: { id: string } }>('/modifier-templates/:id/apply', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = z.object({ menuItemId: z.string().uuid() }).parse(req.body)
    const tpl = await prisma.modifierTemplate.findFirst({
      where: { id: req.params.id, deletedAt: null, ...(await scopeTenantWhere(req, 'create')) },
      include: { options: true },
    })
    if (!tpl) throw new NotFoundError('ModifierTemplate', req.params.id)
    const item = await prisma.menuItem.findFirst({
      where: { id: body.menuItemId, deletedAt: null, concept: { deletedAt: null, ...(await scopeTenantWhere(req, 'create')) } },
      select: { id: true },
    })
    if (!item) throw new NotFoundError('MenuItem', body.menuItemId)

    const group = await prisma.modifierGroup.create({
      data: {
        menuItemId: body.menuItemId,
        name: tpl.name,
        minSelect: tpl.minSelect,
        maxSelect: tpl.maxSelect,
        isRequired: tpl.isRequired,
        modifiers: {
          create: tpl.options.map((o, i) => ({
            name: o.name,
            priceDeltaCents: o.priceDeltaCents,
            isDefault: o.isDefault,
            sortOrder: i,
          })),
        },
      },
      include: { modifiers: true },
    })
    return reply.status(201).send(group)
  })

  // ════════════════════════════════════════════════════════════════════════
  // 2. Delivery zones
  // ════════════════════════════════════════════════════════════════════════

  fastify.get('/delivery-zones', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const conceptId = (req.query as { conceptId?: string }).conceptId
    return prisma.deliveryZone.findMany({
      where: await brandRowWhere(req, conceptId, 'read'),
      orderBy: [{ conceptId: 'asc' }, { sortOrder: 'asc' }, { radiusKmMin: 'asc' }],
    })
  })

  fastify.post('/delivery-zones', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = z.object({
      conceptId:        z.string().uuid().nullable().optional(),
      name:             z.string().min(1).max(80),
      radiusKmMin:      z.number().min(0).nullable().optional(),
      radiusKmMax:      z.number().min(0).nullable().optional(),
      feeCents:         z.number().int().min(0).default(0),
      freeAboveCents:   z.number().int().min(0).nullable().optional(),
      minOrderCents:    z.number().int().min(0).default(0),
      estimatedMinutes: z.number().int().min(0).nullable().optional(),
    }).parse(req.body)
    // A zone may only be pinned to a brand of the company the operator is
    // acting in. (conceptId=null is the "All brands" default — see brandRowWhere.)
    if (body.conceptId) await assertConceptOwned(req, body.conceptId, 'create')
    const created = await prisma.deliveryZone.create({ data: { ...body, tenantId: activeTenantId(req) } })
    return reply.status(201).send(created)
  })

  fastify.patch<{ Params: { id: string } }>('/delivery-zones/:id', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const body = z.object({
      name:             z.string().min(1).max(80).optional(),
      radiusKmMin:      z.number().min(0).nullable().optional(),
      radiusKmMax:      z.number().min(0).nullable().optional(),
      feeCents:         z.number().int().min(0).optional(),
      freeAboveCents:   z.number().int().min(0).nullable().optional(),
      minOrderCents:    z.number().int().min(0).optional(),
      estimatedMinutes: z.number().int().min(0).nullable().optional(),
      isActive:         z.boolean().optional(),
    }).parse(req.body)
    const existing = await prisma.deliveryZone.findFirst({
      where: { id: req.params.id, ...(await brandRowWhere(req, undefined, 'write')) },
      select: { id: true },
    })
    if (!existing) throw new NotFoundError('DeliveryZone', req.params.id)
    return prisma.deliveryZone.update({ where: { id: existing.id }, data: body })
  })

  fastify.delete<{ Params: { id: string } }>('/delivery-zones/:id', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const existing = await prisma.deliveryZone.findFirst({
      where: { id: req.params.id, ...(await brandRowWhere(req, undefined, 'write')) },
      select: { id: true },
    })
    if (!existing) throw new NotFoundError('DeliveryZone', req.params.id)
    await prisma.deliveryZone.delete({ where: { id: existing.id } })
    return reply.status(204).send()
  })

  // ════════════════════════════════════════════════════════════════════════
  // 3. Notification templates
  // ════════════════════════════════════════════════════════════════════════

  fastify.get('/notification-templates', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const conceptId = (req.query as { conceptId?: string }).conceptId
    return prisma.notificationTemplate.findMany({
      where: await brandRowWhere(req, conceptId, 'read'),
      orderBy: [{ event: 'asc' }, { channel: 'asc' }, { language: 'asc' }],
    })
  })

  fastify.post('/notification-templates', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = z.object({
      conceptId: z.string().uuid().nullable().optional(),
      channel:   z.enum(['email', 'sms', 'whatsapp', 'push']),
      event:     z.string().min(1).max(60),
      subject:   z.string().nullable().optional(),
      body:      z.string().min(1),
      language:  z.enum(['en', 'ur']).default('en'),
      notes:     z.string().nullable().optional(),
    }).parse(req.body)
    if (body.conceptId) await assertConceptOwned(req, body.conceptId, 'create')
    const created = await prisma.notificationTemplate.create({ data: { ...body, tenantId: activeTenantId(req) } })
    return reply.status(201).send(created)
  })

  fastify.patch<{ Params: { id: string } }>('/notification-templates/:id', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const body = z.object({
      subject:  z.string().nullable().optional(),
      body:     z.string().min(1).optional(),
      isActive: z.boolean().optional(),
      notes:    z.string().nullable().optional(),
    }).parse(req.body)
    const existing = await prisma.notificationTemplate.findFirst({
      where: { id: req.params.id, ...(await brandRowWhere(req, undefined, 'write')) },
      select: { id: true },
    })
    if (!existing) throw new NotFoundError('NotificationTemplate', req.params.id)
    return prisma.notificationTemplate.update({ where: { id: existing.id }, data: body })
  })

  fastify.delete<{ Params: { id: string } }>('/notification-templates/:id', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const existing = await prisma.notificationTemplate.findFirst({
      where: { id: req.params.id, ...(await brandRowWhere(req, undefined, 'write')) },
      select: { id: true },
    })
    if (!existing) throw new NotFoundError('NotificationTemplate', req.params.id)
    await prisma.notificationTemplate.delete({ where: { id: existing.id } })
    return reply.status(204).send()
  })

  // ════════════════════════════════════════════════════════════════════════
  // 4. Bank accounts
  // ════════════════════════════════════════════════════════════════════════

  // A bank account is the bank DETAILS of a chart-of-accounts code
  // (lib/bankAccounts.ts): the ledger holds the balance. Each row carries its
  // accountCode and that code's ledger balance; openingBalanceCents is the
  // figure typed at setup, shown read-only, and read by nothing else.
  fastify.get('/bank-accounts', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const rows = await prisma.bankAccount.findMany({
      where: { deletedAt: null, ...(await scopeTenantWhere(req, 'read')) },
      orderBy: { name: 'asc' },
    })
    const { ledgerBalancesByCode } = await import('../../lib/bankAccounts.js')
    const byTenant = new Map<string, string[]>()
    for (const r of rows) {
      if (r.tenantId && r.accountCode) byTenant.set(r.tenantId, [...(byTenant.get(r.tenantId) ?? []), r.accountCode])
    }
    const balances = new Map<string, Map<string, number>>()
    for (const [tenantId, codes] of byTenant) balances.set(tenantId, await ledgerBalancesByCode(tenantId, codes))
    return rows.map((r) => ({
      ...r,
      ledgerBalanceCents: r.tenantId && r.accountCode ? balances.get(r.tenantId)?.get(r.accountCode) ?? null : null,
    }))
  })
  fastify.post('/bank-accounts', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = z.object({
      name:                z.string().min(1).max(120),
      bankName:            z.string().nullable().optional(),
      accountTitle:        z.string().nullable().optional(),
      accountNumber:       z.string().nullable().optional(),
      iban:                z.string().nullable().optional(),
      branchCode:          z.string().nullable().optional(),
      swiftCode:           z.string().nullable().optional(),
      currency:            z.string().length(3).default('PKR'),
      // Link to an existing asset account; omitted → 1020 for the first bank,
      // else a new 102x child account named after this bank.
      accountCode:         z.string().min(1).max(20).nullable().optional(),
      notes:               z.string().nullable().optional(),
    }).parse(req.body)
    const tenantId = activeTenantId(req)
    const { linkBankLedgerAccount } = await import('../../lib/bankAccounts.js')
    const accountCode = await linkBankLedgerAccount(tenantId, body.name, body.accountCode)
    const created = await prisma.bankAccount.create({ data: { ...body, accountCode, tenantId } })
    return reply.status(201).send(created)
  })
  fastify.patch<{ Params: { id: string } }>('/bank-accounts/:id', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const body = z.object({
      name:                z.string().min(1).max(120).optional(),
      bankName:            z.string().nullable().optional(),
      accountTitle:        z.string().nullable().optional(),
      accountNumber:       z.string().nullable().optional(),
      iban:                z.string().nullable().optional(),
      branchCode:          z.string().nullable().optional(),
      swiftCode:           z.string().nullable().optional(),
      // Re-point the bank at another asset account in the same chart.
      accountCode:         z.string().min(1).max(20).optional(),
      isActive:            z.boolean().optional(),
      notes:               z.string().nullable().optional(),
    }).parse(req.body)
    const existing = await prisma.bankAccount.findFirst({
      where: { id: req.params.id, deletedAt: null, ...(await scopeTenantWhere(req, 'write')) },
      select: { id: true, tenantId: true, name: true },
    })
    if (!existing) throw new NotFoundError('BankAccount', req.params.id)
    if (body.accountCode) {
      if (!existing.tenantId) throw new AppError('NO_COMPANY', 'This bank account has no company — it cannot link to a chart', 422)
      const { linkBankLedgerAccount } = await import('../../lib/bankAccounts.js')
      await linkBankLedgerAccount(existing.tenantId, body.name ?? existing.name, body.accountCode)
    }
    return prisma.bankAccount.update({ where: { id: existing.id }, data: body })
  })
  fastify.delete<{ Params: { id: string } }>('/bank-accounts/:id', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const existing = await prisma.bankAccount.findFirst({
      where: { id: req.params.id, deletedAt: null, ...(await scopeTenantWhere(req, 'write')) },
      select: { id: true },
    })
    if (!existing) throw new NotFoundError('BankAccount', req.params.id)
    await prisma.bankAccount.update({ where: { id: existing.id }, data: { deletedAt: new Date(), isActive: false } })
    return reply.status(204).send()
  })

  // ════════════════════════════════════════════════════════════════════════
  // 5. KDS devices
  // ════════════════════════════════════════════════════════════════════════

  // Every device registration is owned by one company (KdsDevice.tenantId);
  // the station / brand it points at must be that company's too.
  fastify.get('/kds-devices', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    return prisma.kdsDevice.findMany({ where: await scopeTenantWhere(req, 'read'), orderBy: { name: 'asc' } })
  })
  fastify.post('/kds-devices', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = z.object({
      name:              z.string().min(1).max(80),
      stationId:         z.string().uuid().nullable().optional(),
      conceptId:         z.string().uuid().nullable().optional(),
      deviceFingerprint: z.string().nullable().optional(),
      notes:             z.string().nullable().optional(),
    }).parse(req.body)
    const tenantId = activeTenantId(req)
    if (body.conceptId) await assertBrandOf(tenantId, body.conceptId)
    if (body.stationId) await assertStationOf(tenantId, body.stationId)
    const created = await prisma.kdsDevice.create({ data: { ...body, tenantId } })
    return reply.status(201).send(created)
  })
  fastify.patch<{ Params: { id: string } }>('/kds-devices/:id', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const body = z.object({
      name:              z.string().min(1).max(80).optional(),
      stationId:         z.string().uuid().nullable().optional(),
      conceptId:         z.string().uuid().nullable().optional(),
      isActive:          z.boolean().optional(),
      notes:             z.string().nullable().optional(),
    }).parse(req.body)
    const existing = await prisma.kdsDevice.findFirst({
      where: { id: req.params.id, ...(await scopeTenantWhere(req, 'write')) },
      select: { id: true, tenantId: true },
    })
    if (!existing) throw new NotFoundError('KdsDevice', req.params.id)
    // Re-pointing the device: the new station / brand must belong to the
    // device's own company, not merely some company the operator is in.
    const tenantId = existing.tenantId ?? activeTenantId(req)
    if (body.conceptId) await assertBrandOf(tenantId, body.conceptId)
    if (body.stationId) await assertStationOf(tenantId, body.stationId)
    return prisma.kdsDevice.update({ where: { id: existing.id }, data: body })
  })
  fastify.delete<{ Params: { id: string } }>('/kds-devices/:id', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const existing = await prisma.kdsDevice.findFirst({
      where: { id: req.params.id, ...(await scopeTenantWhere(req, 'write')) },
      select: { id: true },
    })
    if (!existing) throw new NotFoundError('KdsDevice', req.params.id)
    await prisma.kdsDevice.delete({ where: { id: existing.id } })
    return reply.status(204).send()
  })

  // ════════════════════════════════════════════════════════════════════════
  // 6. Webhook subscriptions
  // ════════════════════════════════════════════════════════════════════════

  fastify.get('/webhooks', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const list = await prisma.webhookSubscription.findMany({
      where: { deletedAt: null, ...(await scopeTenantWhere(req, 'read')) },
      orderBy: { createdAt: 'desc' },
    })
    // Don't ship the secret in plaintext on list
    return list.map((w) => ({ ...w, secret: w.secret ? `${w.secret.slice(0, 8)}…` : null }))
  })
  fastify.post('/webhooks', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req, reply) => {
    const body = z.object({
      url:    z.string().url(),
      events: z.array(z.string()).min(1),
      notes:  z.string().nullable().optional(),
    }).parse(req.body)
    const secret = 'whsec_' + randomBytes(24).toString('base64url')
    const created = await prisma.webhookSubscription.create({
      data: { ...body, secret, createdById: req.staffUser!.id, tenantId: activeTenantId(req) },
    })
    // Return the full secret on create — UI shows once, then truncates after
    return reply.status(201).send(created)
  })
  fastify.patch<{ Params: { id: string } }>('/webhooks/:id', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const body = z.object({
      events:   z.array(z.string()).min(1).optional(),
      isActive: z.boolean().optional(),
      notes:    z.string().nullable().optional(),
    }).parse(req.body)
    const existing = await prisma.webhookSubscription.findFirst({
      where: { id: req.params.id, deletedAt: null, ...(await scopeTenantWhere(req, 'write')) },
      select: { id: true },
    })
    if (!existing) throw new NotFoundError('WebhookSubscription', req.params.id)
    return prisma.webhookSubscription.update({ where: { id: existing.id }, data: body })
  })
  fastify.delete<{ Params: { id: string } }>('/webhooks/:id', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req, reply) => {
    const existing = await prisma.webhookSubscription.findFirst({
      where: { id: req.params.id, deletedAt: null, ...(await scopeTenantWhere(req, 'write')) },
      select: { id: true },
    })
    if (!existing) throw new NotFoundError('WebhookSubscription', req.params.id)
    await prisma.webhookSubscription.update({ where: { id: existing.id }, data: { deletedAt: new Date(), isActive: false } })
    return reply.status(204).send()
  })

  // ════════════════════════════════════════════════════════════════════════
  // 7. Custom fields
  // ════════════════════════════════════════════════════════════════════════

  fastify.get('/custom-fields', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    return prisma.customFieldDefinition.findMany({
      where: await scopeTenantWhere(req, 'read'),
      orderBy: [{ scope: 'asc' }, { sortOrder: 'asc' }],
    })
  })
  fastify.post('/custom-fields', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = z.object({
      scope:      z.enum(['customer', 'order', 'menu_item', 'supplier']),
      key:        z.string().min(1).max(40).regex(/^[a-z][a-z0-9_]*$/, 'Use snake_case (a–z, 0–9, _)'),
      label:      z.string().min(1).max(80),
      type:       z.enum(['text', 'number', 'date', 'select', 'boolean']),
      options:    z.array(z.string()).default([]),
      helpText:   z.string().max(200).nullable().optional(),
      isRequired: z.boolean().default(false),
      showInList: z.boolean().default(false),
    }).parse(req.body)
    const created = await prisma.customFieldDefinition.create({ data: { ...body, tenantId: activeTenantId(req) } })
    return reply.status(201).send(created)
  })
  fastify.patch<{ Params: { id: string } }>('/custom-fields/:id', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const body = z.object({
      label:      z.string().min(1).max(80).optional(),
      options:    z.array(z.string()).optional(),
      helpText:   z.string().max(200).nullable().optional(),
      isRequired: z.boolean().optional(),
      showInList: z.boolean().optional(),
      isActive:   z.boolean().optional(),
    }).parse(req.body)
    const existing = await prisma.customFieldDefinition.findFirst({
      where: { id: req.params.id, ...(await scopeTenantWhere(req, 'write')) },
      select: { id: true },
    })
    if (!existing) throw new NotFoundError('CustomField', req.params.id)
    return prisma.customFieldDefinition.update({ where: { id: existing.id }, data: body })
  })
  fastify.delete<{ Params: { id: string } }>('/custom-fields/:id', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const existing = await prisma.customFieldDefinition.findFirst({
      where: { id: req.params.id, ...(await scopeTenantWhere(req, 'write')) },
      select: { id: true },
    })
    if (!existing) throw new NotFoundError('CustomField', req.params.id)
    await prisma.customFieldDefinition.delete({ where: { id: existing.id } })
    return reply.status(204).send()
  })

  // ════════════════════════════════════════════════════════════════════════
  // 8. Scheduled reports
  // ════════════════════════════════════════════════════════════════════════

  fastify.get('/scheduled-reports', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const conceptId = (req.query as { conceptId?: string }).conceptId
    return prisma.scheduledReport.findMany({
      where: { deletedAt: null, ...(await brandRowWhere(req, conceptId, 'read')) },
      orderBy: { name: 'asc' },
    })
  })
  fastify.post('/scheduled-reports', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = z.object({
      name:       z.string().min(1).max(80),
      reportType: z.enum(['sales_daily', 'shift_summary', 'low_stock', 'food_cost', 'ap_aging', 'menu_engineering']),
      cron:       z.string().min(1).max(60),
      recipients: z.array(z.string().email()).min(1),
      conceptId:  z.string().uuid().nullable().optional(),
      notes:      z.string().nullable().optional(),
    }).parse(req.body)
    // Never let a schedule email out another company's brand data.
    if (body.conceptId) await assertConceptOwned(req, body.conceptId, 'create')
    const created = await prisma.scheduledReport.create({ data: { ...body, createdById: req.staffUser!.id, tenantId: activeTenantId(req) } })
    return reply.status(201).send(created)
  })
  fastify.patch<{ Params: { id: string } }>('/scheduled-reports/:id', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const body = z.object({
      name:       z.string().min(1).max(80).optional(),
      cron:       z.string().min(1).max(60).optional(),
      recipients: z.array(z.string().email()).min(1).optional(),
      isActive:   z.boolean().optional(),
      notes:      z.string().nullable().optional(),
    }).parse(req.body)
    const existing = await prisma.scheduledReport.findFirst({
      where: { id: req.params.id, deletedAt: null, ...(await brandRowWhere(req, undefined, 'write')) },
      select: { id: true },
    })
    if (!existing) throw new NotFoundError('ScheduledReport', req.params.id)
    return prisma.scheduledReport.update({ where: { id: existing.id }, data: body })
  })
  fastify.delete<{ Params: { id: string } }>('/scheduled-reports/:id', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const existing = await prisma.scheduledReport.findFirst({
      where: { id: req.params.id, deletedAt: null, ...(await brandRowWhere(req, undefined, 'write')) },
      select: { id: true },
    })
    if (!existing) throw new NotFoundError('ScheduledReport', req.params.id)
    await prisma.scheduledReport.update({ where: { id: existing.id }, data: { deletedAt: new Date(), isActive: false } })
    return reply.status(204).send()
  })

  // ════════════════════════════════════════════════════════════════════════
  // 9. Refund / void / comp policy (singleton)
  // ════════════════════════════════════════════════════════════════════════

  fastify.get('/refund-policy', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    return findOrCreateSingleton('refundPolicy', activeTenantId(req), {})
  })
  fastify.patch('/refund-policy', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const body = z.object({
      cashierVoidLimitCents:    z.number().int().min(0).optional(),
      cashierCompLimitCents:    z.number().int().min(0).optional(),
      cashierRefundLimitCents:  z.number().int().min(0).optional(),
      managerVoidLimitCents:    z.number().int().min(0).optional(),
      managerCompLimitCents:    z.number().int().min(0).optional(),
      managerRefundLimitCents:  z.number().int().min(0).optional(),
      requireReason:            z.boolean().optional(),
      requirePhotoEvidence:     z.boolean().optional(),
      notifyOwnerAboveCents:    z.number().int().nullable().optional(),
      approverEmail:            z.string().email().nullable().optional(),
      notes:                    z.string().nullable().optional(),
    }).parse(req.body)
    const policy = await findOrCreateSingleton<{ id: string }>('refundPolicy', activeTenantId(req), {})
    const updated = await prisma.refundPolicy.update({
      where: { id: policy.id },
      data: { ...body, updatedById: req.staffUser!.id },
    })
    // The till reads these caps through the cached setup-config reader —
    // drop the cache so a tightened void / comp / refund cap applies to the
    // very next ring-up, not up to a minute later.
    const { invalidateSetupCache } = await import('../../lib/setup-config.js')
    invalidateSetupCache()
    return updated
  })

  // ════════════════════════════════════════════════════════════════════════
  // 10. Reservation policy (singleton)
  // ════════════════════════════════════════════════════════════════════════

  fastify.get('/reservation-policy', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    return findOrCreateSingleton('reservationPolicy', activeTenantId(req), {})
  })
  fastify.patch('/reservation-policy', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const body = z.object({
      depositRequiredAboveParty:  z.number().int().nullable().optional(),
      depositCents:               z.number().int().min(0).optional(),
      noShowGraceMinutes:         z.number().int().min(0).optional(),
      cancellationWindowHours:    z.number().int().min(0).optional(),
      maxAdvanceDays:             z.number().int().min(1).optional(),
      minAdvanceHours:            z.number().int().min(0).optional(),
      maxPartySize:               z.number().int().min(1).optional(),
      walkInsAllowed:             z.boolean().optional(),
      remindersEnabled:           z.boolean().optional(),
      reminderHoursBefore:        z.number().int().min(1).optional(),
      // Slot generation: granularity (15 / 30 / 60), default booking duration
      // (60 / 90 / 120 / 150 / 180), and the daypart grouping used by the
      // public widget.
      slotIntervalMin:            z.number().int().refine((n) => [15, 30, 60].includes(n)).optional(),
      defaultDurationMin:         z.number().int().min(30).max(240).optional(),
      dayparts:                   z.array(z.object({
        label:     z.string().min(1).max(40),
        startHour: z.number().int().min(0).max(23),
        endHour:   z.number().int().min(1).max(24),
      })).max(8).optional().refine((d) => {
        if (!d) return true
        // Validate ordering: each daypart must be a non-empty range, and the
        // collection must cover non-overlapping hours sorted by startHour.
        for (let i = 0; i < d.length; i++) {
          const cur = d[i]!
          if (cur.endHour <= cur.startHour) return false
          if (i > 0 && cur.startHour < d[i - 1]!.endHour) return false
        }
        return true
      }, { message: 'dayparts must be ordered, non-empty, non-overlapping' }),
      notes:                      z.string().nullable().optional(),
    }).parse(req.body)
    const policy = await findOrCreateSingleton<{ id: string }>('reservationPolicy', activeTenantId(req), {})
    const updated = await prisma.reservationPolicy.update({
      where: { id: policy.id },
      data: { ...body, updatedById: req.staffUser!.id },
    })
    // Invalidate the 60-second cache so policy changes take effect on the
    // next public availability fetch instead of waiting up to a minute.
    const { invalidateSetupCache } = await import('../../lib/setup-config.js')
    invalidateSetupCache()
    return updated
  })

  // ════════════════════════════════════════════════════════════════════════
  // 11. Receipt config (singleton)
  // ════════════════════════════════════════════════════════════════════════

  fastify.get('/receipt-config', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    return findOrCreateSingleton('receiptConfig', activeTenantId(req), {})
  })
  fastify.patch('/receipt-config', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const body = z.object({
      paperWidthMm:           z.number().int().refine((n) => n === 58 || n === 80).optional(),
      showLogo:               z.boolean().optional(),
      logoUrl:                z.string().url().nullable().optional(),
      headerText:             z.string().max(200).nullable().optional(),
      footerText:             z.string().max(500).nullable().optional(),
      legalDisclaimer:        z.string().max(500).nullable().optional(),
      showTaxBreakdown:       z.boolean().optional(),
      showFbrInvoice:         z.boolean().optional(),
      printerIp:              z.string().nullable().optional(),
      printerPort:            z.number().int().min(1).max(65535).optional(),
      autoPrintOnOrder:       z.boolean().optional(),
      autoPrintOnPay:         z.boolean().optional(),
      drawerKickEnabled:      z.boolean().optional(),
      cashVarianceLimitCents: z.number().int().min(0).optional(),
    }).parse(req.body)
    const cfg = await findOrCreateSingleton<{ id: string }>('receiptConfig', activeTenantId(req), {})
    const updated = await prisma.receiptConfig.update({
      where: { id: cfg.id },
      data: { ...body, updatedById: req.staffUser!.id },
    })
    // Receipts and the shift-close variance check read the cached reader.
    const { invalidateSetupCache } = await import('../../lib/setup-config.js')
    invalidateSetupCache()
    return updated
  })

  // ════════════════════════════════════════════════════════════════════════
  // 12. Operations config (singleton — service charge, tip pool, tax numbering,
  // withholding, brand assets)
  // ════════════════════════════════════════════════════════════════════════

  fastify.get('/operations-config', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    return findOrCreateSingleton('operationsConfig', activeTenantId(req), {})
  })
  fastify.patch('/operations-config', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const body = z.object({
      serviceChargePct:               z.number().min(0).max(1).optional(),
      serviceChargeAppliesToChannels: z.array(z.string()).optional(),
      tipPoolEnabled:                 z.boolean().optional(),
      tipPoolDistribution:            z.enum(['equal', 'by_hours', 'by_role_weight']).optional(),
      tipPoolRoleWeights:             z.record(z.string(), z.number()).nullable().optional(),
      invoiceSequenceReset:           z.enum(['yearly', 'monthly', 'never']).optional(),
      invoiceCreditNotePrefix:        z.string().max(10).nullable().optional(),
      withholdingTaxEnabled:          z.boolean().optional(),
      withholdingTaxPct:              z.number().min(0).max(1).optional(),
      withholdingTaxRecoverable:      z.boolean().optional(),
      secondaryColors:                z.array(z.string()).optional(),
      fontHeading:                    z.string().nullable().optional(),
      fontBody:                       z.string().nullable().optional(),
      brandVoiceNotes:                z.string().nullable().optional(),
      socialInstagramHandle:          z.string().nullable().optional(),
      socialTiktokHandle:             z.string().nullable().optional(),
      socialFacebookUrl:              z.string().url().nullable().optional(),
    }).parse(req.body)
    const cfg = await findOrCreateSingleton<{ id: string }>('operationsConfig', activeTenantId(req), {})
    const { tipPoolRoleWeights, ...rest } = body
    const updated = await prisma.operationsConfig.update({
      where: { id: cfg.id },
      data: {
        ...rest,
        ...(tipPoolRoleWeights !== undefined && {
          tipPoolRoleWeights: tipPoolRoleWeights === null ? Prisma.JsonNull : (tipPoolRoleWeights as Prisma.InputJsonValue),
        }),
        updatedById: req.staffUser!.id,
      },
    })
    // Discount caps and the service charge are read through the cached reader.
    const { invalidateSetupCache } = await import('../../lib/setup-config.js')
    invalidateSetupCache()
    return updated
  })

  // ════════════════════════════════════════════════════════════════════════
  // 13. Chart of accounts — passes through to existing Account model
  // ════════════════════════════════════════════════════════════════════════

  // Each company keeps its own chart of accounts — the same code means a
  // different account in a different company's books.
  fastify.get('/chart-of-accounts', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    return prisma.account.findMany({
      where: await scopeTenantWhere(req, 'read'),
      orderBy: { code: 'asc' },
    })
  })
  fastify.post('/chart-of-accounts', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req, reply) => {
    const body = z.object({
      code:        z.string().min(1).max(20),
      name:        z.string().min(1).max(120),
      type:        z.enum(['asset', 'liability', 'equity', 'revenue', 'expense']),
      description: z.string().max(500).nullable().optional(),
    }).parse(req.body)
    const created = await prisma.account.create({ data: { ...body, tenantId: activeTenantId(req) } })
    return reply.status(201).send(created)
  })
  fastify.patch<{ Params: { id: string } }>('/chart-of-accounts/:id', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const body = z.object({
      name:        z.string().min(1).max(120).optional(),
      description: z.string().max(500).nullable().optional(),
      isActive:    z.boolean().optional(),
    }).parse(req.body)
    const existing = await prisma.account.findFirst({
      where: { id: req.params.id, ...(await scopeTenantWhere(req, 'write')) },
      select: { id: true },
    })
    if (!existing) throw new NotFoundError('Account', req.params.id)
    return prisma.account.update({ where: { id: existing.id }, data: body })
  })

  // ════════════════════════════════════════════════════════════════════════
  // 14. Period locks — passes through to existing PeriodLock model
  // ════════════════════════════════════════════════════════════════════════

  // Closing a period freezes THIS company's books only.
  fastify.get('/period-locks', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    return prisma.periodLock.findMany({
      where: await scopeTenantWhere(req, 'read'),
      orderBy: { lockedThrough: 'desc' },
    })
  })
  fastify.post('/period-locks', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req, reply) => {
    const body = z.object({
      lockedThrough: z.string(),                                 // ISO date — books are closed up to and including this
      note:          z.string().max(500).optional(),
    }).parse(req.body)
    const created = await prisma.periodLock.create({
      data: {
        tenantId: activeTenantId(req),
        lockedThrough: new Date(body.lockedThrough),
        note:          body.note,
        lockedBy:      req.staffUser!.id,
      },
    })
    return reply.status(201).send(created)
  })
  fastify.delete<{ Params: { id: string } }>('/period-locks/:id', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req, reply) => {
    const lock = await prisma.periodLock.findFirst({
      where: { id: req.params.id, ...(await scopeTenantWhere(req, 'write')) },
    })
    if (!lock) throw new NotFoundError('PeriodLock', req.params.id)
    await prisma.periodLock.delete({ where: { id: lock.id } })

    // Reopening a closed period is the single most-abused accounting move
    // when someone wants to backdate a fix. Flag every removal for review.
    if (lock) {
      const { flagException } = await import('../../lib/exceptions.js')
      await flagException({
        kind: 'period_reopened',
        severity: 'high',
        title: `Period reopened — books unlocked through ${lock.lockedThrough.toISOString().slice(0, 10)}`,
        description: `${req.staffUser!.email} removed a period lock. Postings dated on/before ${lock.lockedThrough.toISOString().slice(0, 10)} are now allowed again. Audit any new entries before re-locking.`,
        entityType: 'PeriodLock',
        entityId: req.params.id,
        actorId: req.staffUser!.id,
        metadata: { lockedThrough: lock.lockedThrough, originalLockedBy: lock.lockedBy, note: lock.note },
      })
      await audit({ category: 'identity',
        action: 'period_lock.removed',
        entity: 'PeriodLock',
        entityId: req.params.id,
        userId: req.staffUser!.id, tenantId: req.staffUser?.tenantId ?? null,
        userEmail: req.staffUser!.email,
        before: lock,
      })
    }

    return reply.status(204).send()
  })

  // ════════════════════════════════════════════════════════════════════════
  // 15. Dietary tags + allergens — stored as JSON in two Setting key-value rows.
  // Lightweight taxonomy operators define once and pick from on every menu item.
  // Keyed per company (`taxonomy.<list>:<tenantId>`) so one company's edits
  // never rewrite another's picklist; the legacy company-less key is the read
  // fallback until the company saves its own list.
  // ════════════════════════════════════════════════════════════════════════

  const DEFAULT_DIETARY = ['Vegetarian', 'Vegan', 'Halal', 'Gluten-free', 'Dairy-free', 'Nut-free', 'Keto', 'Low-carb']
  const DEFAULT_ALLERGENS = ['Dairy', 'Eggs', 'Gluten', 'Peanuts', 'Tree nuts', 'Soy', 'Fish', 'Shellfish', 'Sesame', 'Mustard', 'Sulphites']

  async function readListSetting(key: string, tenantId: string, defaults: string[]): Promise<string[]> {
    const row =
      (await prisma.setting.findUnique({ where: { key: `${key}:${tenantId}` } })) ??
      (await prisma.setting.findUnique({ where: { key } }))
    if (!row) return defaults
    try { return JSON.parse(row.value) as string[] } catch { return defaults }
  }
  async function writeListSetting(key: string, tenantId: string, value: string[]): Promise<void> {
    const tenantKey = `${key}:${tenantId}`
    await prisma.setting.upsert({
      where: { key: tenantKey },
      create: { key: tenantKey, value: JSON.stringify(value) },
      update: { value: JSON.stringify(value) },
    })
  }

  fastify.get('/dietary-taxonomy', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const tenantId = activeTenantId(req)
    return {
      dietaryTags: await readListSetting('taxonomy.dietary', tenantId, DEFAULT_DIETARY),
      allergens:   await readListSetting('taxonomy.allergens', tenantId, DEFAULT_ALLERGENS),
    }
  })
  fastify.put('/dietary-taxonomy', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const body = z.object({
      dietaryTags: z.array(z.string().min(1).max(40)).max(50),
      allergens:   z.array(z.string().min(1).max(40)).max(50),
    }).parse(req.body)
    const tenantId = activeTenantId(req)
    await writeListSetting('taxonomy.dietary', tenantId, body.dietaryTags)
    await writeListSetting('taxonomy.allergens', tenantId, body.allergens)
    return body
  })

  // ════════════════════════════════════════════════════════════════════════
  // 16. Hours of operation — per-concept day-of-week windows
  // ════════════════════════════════════════════════════════════════════════

  fastify.get<{ Params: { conceptId: string } }>('/hours/:conceptId',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
      await assertConceptOwned(req, req.params.conceptId, 'read')
      return prisma.serviceHours.findMany({
        where: { conceptId: req.params.conceptId },
        orderBy: [{ dayOfWeek: 'asc' }, { openMin: 'asc' }],
      })
    },
  )

  fastify.put<{ Params: { conceptId: string } }>('/hours/:conceptId',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const body = z.object({
        hours: z.array(z.object({
          dayOfWeek:    z.number().int().min(0).max(6),
          openMin:      z.number().int().min(0).max(1440),
          closeMin:     z.number().int().min(0).max(1440),
          isReservable: z.boolean().default(true),
        })),
      }).parse(req.body)
      await assertConceptOwned(req, req.params.conceptId, 'write')
      // Replace-all so the editor's "uncheck a day" actually removes it.
      await prisma.$transaction([
        prisma.serviceHours.deleteMany({ where: { conceptId: req.params.conceptId } }),
        prisma.serviceHours.createMany({
          data: body.hours.map((h) => ({ ...h, conceptId: req.params.conceptId })),
        }),
      ])
      return { saved: body.hours.length }
    },
  )

  // ════════════════════════════════════════════════════════════════════════
  // 17. Holidays / closures — concept blackout windows
  // ════════════════════════════════════════════════════════════════════════

  fastify.get('/holidays', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    const conceptId = (req.query as { conceptId?: string }).conceptId
    return prisma.conceptBlockout.findMany({
      where: await conceptWhere(req, conceptId, 'read'),
      orderBy: { startTime: 'desc' },
      include: { concept: { select: { id: true, name: true, slug: true } } },
    })
  })

  fastify.post('/holidays', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = z.object({
      conceptId:   z.string().uuid(),
      kind:        z.enum(['closure', 'reduced_capacity', 'special_hours']).default('closure'),
      startTime:   z.string(),                 // ISO date or datetime
      endTime:     z.string(),
      capacityCap: z.number().int().min(0).nullable().optional(),
      reason:      z.string().max(200).nullable().optional(),
    }).parse(req.body)
    await assertConceptOwned(req, body.conceptId, 'create')
    const created = await prisma.conceptBlockout.create({
      data: {
        conceptId:   body.conceptId,
        kind:        body.kind as never,
        startTime:   new Date(body.startTime),
        endTime:     new Date(body.endTime),
        capacityCap: body.capacityCap ?? null,
        reason:      body.reason ?? null,
        createdById: req.staffUser!.id,
      },
    })
    return reply.status(201).send(created)
  })

  fastify.delete<{ Params: { id: string } }>('/holidays/:id', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const existing = await prisma.conceptBlockout.findFirst({
      where: { id: req.params.id, concept: { deletedAt: null, ...(await scopeTenantWhere(req, 'write')) } },
      select: { id: true },
    })
    if (!existing) throw new NotFoundError('ConceptBlockout', req.params.id)
    await prisma.conceptBlockout.delete({ where: { id: existing.id } })
    return reply.status(204).send()
  })

  // ════════════════════════════════════════════════════════════════════════
  // 18. Brand identity — logo / hero / palette / fonts (per concept)
  // Operates on Concept fields directly so the storefront picks up changes
  // without a separate join.
  // ════════════════════════════════════════════════════════════════════════

  fastify.patch<{ Params: { conceptId: string } }>('/brand-identity/:conceptId',
    { preHandler: requireAuth(...MANAGERS) },
    async (req) => {
      const body = z.object({
        logoUrl:            z.string().url().nullable().optional(),
        primaryColor:       z.string().nullable().optional(),
        heroTagline:        z.string().max(140).nullable().optional(),
        announcementBanner: z.string().max(280).nullable().optional(),
        description:        z.string().max(1000).nullable().optional(),
      }).parse(req.body)
      const concept = await assertConceptOwned(req, req.params.conceptId, 'write')
      return prisma.concept.update({ where: { id: concept.id }, data: body })
    },
  )
}
