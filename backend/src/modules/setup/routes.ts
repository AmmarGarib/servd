// Aggregated setup module — handles 13 of the 18 newly-shipped configuration
// areas. Some are full CRUD (modifier templates, delivery zones, notification
// templates, bank accounts, kds devices, webhooks, custom fields, scheduled
// reports), some are single-record settings (refund policy, reservation
// policy, receipt config, operations config — service charge, tip pool, tax
// numbering, withholding, brand assets).
//
// Single record settings use the `scope='global'` convention with auto-create
// on first read so the editor always has something to render.

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { randomBytes } from 'crypto'
import { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { audit } from '../../lib/audit.js'
import { requireAuth, MANAGERS, ADMIN_ONLY, ALL_STAFF } from '../auth/middleware.js'
import { NotFoundError } from '../../lib/errors.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function findOrCreateSingleton<T>(
  modelName: 'refundPolicy' | 'reservationPolicy' | 'receiptConfig' | 'operationsConfig',
  defaults: Partial<T>,
): Promise<T> {
  const model = prisma[modelName] as unknown as { findFirst: (a: unknown) => Promise<T | null>; create: (a: unknown) => Promise<T> }
  const existing = await model.findFirst({ where: { scope: 'global', scopeId: null } })
  if (existing) return existing
  return model.create({ data: { scope: 'global', scopeId: null, ...defaults } })
}

// ─── Routes ──────────────────────────────────────────────────────────────────

export async function setupRoutes(fastify: FastifyInstance) {

  // ════════════════════════════════════════════════════════════════════════
  // 1. Modifier templates
  // ════════════════════════════════════════════════════════════════════════

  fastify.get('/modifier-templates', { preHandler: requireAuth(...MANAGERS) }, async () => {
    return prisma.modifierTemplate.findMany({
      where: { deletedAt: null },
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
      data: { ...rest, options: { create: options.map((o, i) => ({ ...o, sortOrder: i })) } },
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
    if (options) {
      await prisma.modifierTemplateOption.deleteMany({ where: { templateId: req.params.id } })
      await prisma.modifierTemplateOption.createMany({
        data: options.map((o, i) => ({ ...o, templateId: req.params.id, sortOrder: i })),
      })
    }
    return prisma.modifierTemplate.update({
      where: { id: req.params.id }, data: rest,
      include: { options: { orderBy: { sortOrder: 'asc' } } },
    })
  })

  fastify.delete<{ Params: { id: string } }>('/modifier-templates/:id', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    await prisma.modifierTemplate.update({ where: { id: req.params.id }, data: { deletedAt: new Date(), isActive: false } })
    return reply.status(204).send()
  })

  // POST /setup/modifier-templates/:id/apply — clone the template's options
  // into a new ModifierGroup attached to the given menu item. Templates and
  // groups have different shapes (templates are shared; groups are per-item),
  // so this is a one-way materialisation.
  fastify.post<{ Params: { id: string } }>('/modifier-templates/:id/apply', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = z.object({ menuItemId: z.string().uuid() }).parse(req.body)
    const tpl = await prisma.modifierTemplate.findUnique({ where: { id: req.params.id }, include: { options: true } })
    if (!tpl) throw new NotFoundError('ModifierTemplate', req.params.id)
    const item = await prisma.menuItem.findUnique({ where: { id: body.menuItemId }, select: { id: true } })
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
      where: { ...(conceptId && { conceptId }) },
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
    const created = await prisma.deliveryZone.create({ data: body })
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
    return prisma.deliveryZone.update({ where: { id: req.params.id }, data: body })
  })

  fastify.delete<{ Params: { id: string } }>('/delivery-zones/:id', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    await prisma.deliveryZone.delete({ where: { id: req.params.id } })
    return reply.status(204).send()
  })

  // ════════════════════════════════════════════════════════════════════════
  // 3. Notification templates
  // ════════════════════════════════════════════════════════════════════════

  fastify.get('/notification-templates', { preHandler: requireAuth(...MANAGERS) }, async () => {
    return prisma.notificationTemplate.findMany({
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
    const created = await prisma.notificationTemplate.create({ data: body })
    return reply.status(201).send(created)
  })

  fastify.patch<{ Params: { id: string } }>('/notification-templates/:id', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const body = z.object({
      subject:  z.string().nullable().optional(),
      body:     z.string().min(1).optional(),
      isActive: z.boolean().optional(),
      notes:    z.string().nullable().optional(),
    }).parse(req.body)
    return prisma.notificationTemplate.update({ where: { id: req.params.id }, data: body })
  })

  fastify.delete<{ Params: { id: string } }>('/notification-templates/:id', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    await prisma.notificationTemplate.delete({ where: { id: req.params.id } })
    return reply.status(204).send()
  })

  // ════════════════════════════════════════════════════════════════════════
  // 4. Bank accounts
  // ════════════════════════════════════════════════════════════════════════

  fastify.get('/bank-accounts', { preHandler: requireAuth(...MANAGERS) }, async () => {
    return prisma.bankAccount.findMany({ where: { deletedAt: null }, orderBy: { name: 'asc' } })
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
      openingBalanceCents: z.number().int().default(0),
      notes:               z.string().nullable().optional(),
    }).parse(req.body)
    const created = await prisma.bankAccount.create({ data: body })
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
      openingBalanceCents: z.number().int().optional(),
      isActive:            z.boolean().optional(),
      notes:               z.string().nullable().optional(),
    }).parse(req.body)
    return prisma.bankAccount.update({ where: { id: req.params.id }, data: body })
  })
  fastify.delete<{ Params: { id: string } }>('/bank-accounts/:id', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    await prisma.bankAccount.update({ where: { id: req.params.id }, data: { deletedAt: new Date(), isActive: false } })
    return reply.status(204).send()
  })

  // ════════════════════════════════════════════════════════════════════════
  // 5. KDS devices
  // ════════════════════════════════════════════════════════════════════════

  fastify.get('/kds-devices', { preHandler: requireAuth(...MANAGERS) }, async () => {
    return prisma.kdsDevice.findMany({ orderBy: { name: 'asc' } })
  })
  fastify.post('/kds-devices', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    const body = z.object({
      name:              z.string().min(1).max(80),
      stationId:         z.string().uuid().nullable().optional(),
      conceptId:         z.string().uuid().nullable().optional(),
      deviceFingerprint: z.string().nullable().optional(),
      notes:             z.string().nullable().optional(),
    }).parse(req.body)
    const created = await prisma.kdsDevice.create({ data: body })
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
    return prisma.kdsDevice.update({ where: { id: req.params.id }, data: body })
  })
  fastify.delete<{ Params: { id: string } }>('/kds-devices/:id', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    await prisma.kdsDevice.delete({ where: { id: req.params.id } })
    return reply.status(204).send()
  })

  // ════════════════════════════════════════════════════════════════════════
  // 6. Webhook subscriptions
  // ════════════════════════════════════════════════════════════════════════

  fastify.get('/webhooks', { preHandler: requireAuth(...ADMIN_ONLY) }, async () => {
    const list = await prisma.webhookSubscription.findMany({
      where: { deletedAt: null },
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
      data: { ...body, secret, createdById: req.staffUser!.id },
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
    return prisma.webhookSubscription.update({ where: { id: req.params.id }, data: body })
  })
  fastify.delete<{ Params: { id: string } }>('/webhooks/:id', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req, reply) => {
    await prisma.webhookSubscription.update({ where: { id: req.params.id }, data: { deletedAt: new Date(), isActive: false } })
    return reply.status(204).send()
  })

  // ════════════════════════════════════════════════════════════════════════
  // 7. Custom fields
  // ════════════════════════════════════════════════════════════════════════

  fastify.get('/custom-fields', { preHandler: requireAuth(...MANAGERS) }, async () => {
    return prisma.customFieldDefinition.findMany({ orderBy: [{ scope: 'asc' }, { sortOrder: 'asc' }] })
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
    const created = await prisma.customFieldDefinition.create({ data: body })
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
    return prisma.customFieldDefinition.update({ where: { id: req.params.id }, data: body })
  })
  fastify.delete<{ Params: { id: string } }>('/custom-fields/:id', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    await prisma.customFieldDefinition.delete({ where: { id: req.params.id } })
    return reply.status(204).send()
  })

  // ════════════════════════════════════════════════════════════════════════
  // 8. Scheduled reports
  // ════════════════════════════════════════════════════════════════════════

  fastify.get('/scheduled-reports', { preHandler: requireAuth(...MANAGERS) }, async () => {
    return prisma.scheduledReport.findMany({ where: { deletedAt: null }, orderBy: { name: 'asc' } })
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
    const created = await prisma.scheduledReport.create({ data: { ...body, createdById: req.staffUser!.id } })
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
    return prisma.scheduledReport.update({ where: { id: req.params.id }, data: body })
  })
  fastify.delete<{ Params: { id: string } }>('/scheduled-reports/:id', { preHandler: requireAuth(...MANAGERS) }, async (req, reply) => {
    await prisma.scheduledReport.update({ where: { id: req.params.id }, data: { deletedAt: new Date(), isActive: false } })
    return reply.status(204).send()
  })

  // ════════════════════════════════════════════════════════════════════════
  // 9. Refund / void / comp policy (singleton)
  // ════════════════════════════════════════════════════════════════════════

  fastify.get('/refund-policy', { preHandler: requireAuth(...ALL_STAFF) }, async () => {
    return findOrCreateSingleton('refundPolicy', {})
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
    const policy = await findOrCreateSingleton<{ id: string }>('refundPolicy', {})
    return prisma.refundPolicy.update({
      where: { id: policy.id },
      data: { ...body, updatedById: req.staffUser!.id },
    })
  })

  // ════════════════════════════════════════════════════════════════════════
  // 10. Reservation policy (singleton)
  // ════════════════════════════════════════════════════════════════════════

  fastify.get('/reservation-policy', { preHandler: requireAuth(...ALL_STAFF) }, async () => {
    return findOrCreateSingleton('reservationPolicy', {})
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
    const policy = await findOrCreateSingleton<{ id: string }>('reservationPolicy', {})
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

  fastify.get('/receipt-config', { preHandler: requireAuth(...ALL_STAFF) }, async () => {
    return findOrCreateSingleton('receiptConfig', {})
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
    const cfg = await findOrCreateSingleton<{ id: string }>('receiptConfig', {})
    return prisma.receiptConfig.update({
      where: { id: cfg.id },
      data: { ...body, updatedById: req.staffUser!.id },
    })
  })

  // ════════════════════════════════════════════════════════════════════════
  // 12. Operations config (singleton — service charge, tip pool, tax numbering,
  // withholding, brand assets)
  // ════════════════════════════════════════════════════════════════════════

  fastify.get('/operations-config', { preHandler: requireAuth(...ALL_STAFF) }, async () => {
    return findOrCreateSingleton('operationsConfig', {})
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
    const cfg = await findOrCreateSingleton<{ id: string }>('operationsConfig', {})
    const { tipPoolRoleWeights, ...rest } = body
    return prisma.operationsConfig.update({
      where: { id: cfg.id },
      data: {
        ...rest,
        ...(tipPoolRoleWeights !== undefined && {
          tipPoolRoleWeights: tipPoolRoleWeights === null ? Prisma.JsonNull : (tipPoolRoleWeights as Prisma.InputJsonValue),
        }),
        updatedById: req.staffUser!.id,
      },
    })
  })

  // ════════════════════════════════════════════════════════════════════════
  // 13. Chart of accounts — passes through to existing Account model
  // ════════════════════════════════════════════════════════════════════════

  fastify.get('/chart-of-accounts', { preHandler: requireAuth(...MANAGERS) }, async () => {
    return prisma.account.findMany({ orderBy: { code: 'asc' } })
  })
  fastify.post('/chart-of-accounts', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req, reply) => {
    const body = z.object({
      code:        z.string().min(1).max(20),
      name:        z.string().min(1).max(120),
      type:        z.enum(['asset', 'liability', 'equity', 'revenue', 'expense']),
      description: z.string().max(500).nullable().optional(),
    }).parse(req.body)
    const created = await prisma.account.create({ data: body })
    return reply.status(201).send(created)
  })
  fastify.patch<{ Params: { id: string } }>('/chart-of-accounts/:id', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req) => {
    const body = z.object({
      name:        z.string().min(1).max(120).optional(),
      description: z.string().max(500).nullable().optional(),
      isActive:    z.boolean().optional(),
    }).parse(req.body)
    return prisma.account.update({ where: { id: req.params.id }, data: body })
  })

  // ════════════════════════════════════════════════════════════════════════
  // 14. Period locks — passes through to existing PeriodLock model
  // ════════════════════════════════════════════════════════════════════════

  fastify.get('/period-locks', { preHandler: requireAuth(...MANAGERS) }, async () => {
    return prisma.periodLock.findMany({ orderBy: { lockedThrough: 'desc' } })
  })
  fastify.post('/period-locks', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req, reply) => {
    const body = z.object({
      lockedThrough: z.string(),                                 // ISO date — books are closed up to and including this
      note:          z.string().max(500).optional(),
    }).parse(req.body)
    const created = await prisma.periodLock.create({
      data: {
        lockedThrough: new Date(body.lockedThrough),
        note:          body.note,
        lockedBy:      req.staffUser!.id,
      },
    })
    return reply.status(201).send(created)
  })
  fastify.delete<{ Params: { id: string } }>('/period-locks/:id', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req, reply) => {
    const lock = await prisma.periodLock.findUnique({ where: { id: req.params.id } })
    await prisma.periodLock.delete({ where: { id: req.params.id } })

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
      await audit({
        action: 'period_lock.removed',
        entity: 'PeriodLock',
        entityId: req.params.id,
        userId: req.staffUser!.id,
        userEmail: req.staffUser!.email,
        before: lock,
      })
    }

    return reply.status(204).send()
  })

  // ════════════════════════════════════════════════════════════════════════
  // 15. Dietary tags + allergens — stored as JSON in two Setting key-value rows.
  // Lightweight taxonomy operators define once and pick from on every menu item.
  // ════════════════════════════════════════════════════════════════════════

  const DEFAULT_DIETARY = ['Vegetarian', 'Vegan', 'Halal', 'Gluten-free', 'Dairy-free', 'Nut-free', 'Keto', 'Low-carb']
  const DEFAULT_ALLERGENS = ['Dairy', 'Eggs', 'Gluten', 'Peanuts', 'Tree nuts', 'Soy', 'Fish', 'Shellfish', 'Sesame', 'Mustard', 'Sulphites']

  async function readListSetting(key: string, defaults: string[]): Promise<string[]> {
    const row = await prisma.setting.findUnique({ where: { key } })
    if (!row) return defaults
    try { return JSON.parse(row.value) as string[] } catch { return defaults }
  }
  async function writeListSetting(key: string, value: string[]): Promise<void> {
    await prisma.setting.upsert({
      where: { key },
      create: { key, value: JSON.stringify(value) },
      update: { value: JSON.stringify(value) },
    })
  }

  fastify.get('/dietary-taxonomy', { preHandler: requireAuth(...ALL_STAFF) }, async () => {
    return {
      dietaryTags: await readListSetting('taxonomy.dietary', DEFAULT_DIETARY),
      allergens:   await readListSetting('taxonomy.allergens', DEFAULT_ALLERGENS),
    }
  })
  fastify.put('/dietary-taxonomy', { preHandler: requireAuth(...MANAGERS) }, async (req) => {
    const body = z.object({
      dietaryTags: z.array(z.string().min(1).max(40)).max(50),
      allergens:   z.array(z.string().min(1).max(40)).max(50),
    }).parse(req.body)
    await writeListSetting('taxonomy.dietary', body.dietaryTags)
    await writeListSetting('taxonomy.allergens', body.allergens)
    return body
  })

  // ════════════════════════════════════════════════════════════════════════
  // 16. Hours of operation — per-concept day-of-week windows
  // ════════════════════════════════════════════════════════════════════════

  fastify.get<{ Params: { conceptId: string } }>('/hours/:conceptId',
    { preHandler: requireAuth(...ALL_STAFF) },
    async (req) => {
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
      where: { ...(conceptId && { conceptId }) },
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
    await prisma.conceptBlockout.delete({ where: { id: req.params.id } })
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
      return prisma.concept.update({ where: { id: req.params.conceptId }, data: body })
    },
  )
}
