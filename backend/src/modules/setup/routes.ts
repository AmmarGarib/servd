// Aggregated setup module — handles 13 of the 18 newly-shipped configuration
// areas. Some are full CRUD (modifier templates, delivery zones, notification
// templates, bank accounts, kds devices, custom fields, scheduled reports),
// some are single-record settings (refund policy, reservation policy, receipt
// config, operations config — service charge, tip pool, tax numbering,
// withholding, clock-in geofence).
//
// Single record settings use the `scope='global'` convention with auto-create
// on first read so the editor always has something to render — one global
// row PER COMPANY (unique on tenantId + scope + scopeId).
//
// Company scoping: everything here is company master data. Rows that carry a
// tenantId (modifier templates, bank accounts, KDS devices, the four
// singleton configs) are read through `scopeTenantWhere` and created
// against the ACTIVE company. Rows anchored to a brand (delivery zones,
// notification templates, scheduled reports, service hours) are reached only through brands of a company in scope — a
// guessed id from another company 404s, and a create can never bind to a
// brand of a company other than the one the operator is acting in.

import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { Prisma, type UserRole } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { audit } from '../../lib/audit.js'
import { requireAuth, MANAGERS, ADMIN_ONLY, ALL_STAFF, FINANCE_TEAM, APPROVERS } from '../auth/middleware.js'
import { WORKSPACES, WORKSPACE_OF_MODULE } from '../../lib/workspaces.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import {
  scopeTenantWhere, assertConceptOwned, conceptIdsInScope, conceptWhere, type ScopeMode,
  activeTenantId as requireActiveTenant,
} from '../../lib/tenantScope.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** The company a create binds to (lib/tenantScope). 422 when the operator has no active company. */
const activeTenantId = (req: FastifyRequest): string => requireActiveTenant(req, 'settings are saved per company')

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

/** Upper-case letters and digits only — how two banks' copies of an IBAN / account number / Raast ID compare. */
const normId = (v: string | null | undefined): string => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')

/** A Raast ID that is a PK mobile number, written 03…, +92…, 0092… or 92…, as '92' + 10 digits; anything else normId. */
export const canonRaastId = (v: string | null | undefined): string => {
  const m = /^(?:0092|92|0)?(3\d{9})$/.exec(String(v ?? '').replace(/\D/g, ''))
  return m ? `92${m[1]}` : normId(v)
}

type AccountIds = { iban: string | null; accountNumber: string | null; raastId: string | null }

/**
 * RV-CO-2: the same physical account however each company wrote it — any
 * identifier equal after canonicalisation (a mobile Raast ID 03… = +92…), or
 * an IBAN (or an IBAN-shaped Raast ID) that ends with the other side's account
 * number (at least 8 digits, leading zeros ignored): PK IBANs carry the
 * account number zero-padded at the end.
 */
export function sameBankAccount(a: AccountIds, b: AccountIds): boolean {
  const ids = (x: AccountIds) => [normId(x.iban), normId(x.accountNumber), canonRaastId(x.raastId)].filter((v) => v.length >= 4)
  const bIds = ids(b)
  if (ids(a).some((v) => bIds.includes(v))) return true
  const ibans = (x: AccountIds) => [normId(x.iban), normId(x.raastId)].filter((v) => /^[A-Z]{2}\d{2}[A-Z0-9]{8,}$/.test(v))
  const acct = (x: AccountIds) => {
    const n = normId(x.accountNumber).replace(/^0+/, '')
    return /^\d{8,}$/.test(n) ? n : null
  }
  const tail = (x: AccountIds, y: AccountIds) => {
    const n = acct(y)
    return !!n && ibans(x).some((i) => i.endsWith(n))
  }
  return tail(a, b) || tail(b, a)
}

async function assertRaastAccountNotShared(
  tenantId: string,
  acc: { id: string; iban: string | null; accountNumber: string | null; raastId: string | null },
): Promise<void> {
  const mine = [normId(acc.iban), normId(acc.accountNumber), canonRaastId(acc.raastId)].filter((v) => v.length >= 4)
  if (mine.length === 0) return
  const others = await prisma.bankAccount.findMany({
    where: {
      tenantId: { not: tenantId }, id: { not: acc.id }, isActive: true, deletedAt: null,
      OR: [{ raastDefault: true }, { raastConcepts: { some: { deletedAt: null } } }],
    },
    select: { id: true, iban: true, accountNumber: true, raastId: true },
  })
  const clash = others.find((o) => sameBankAccount(acc, o))
  if (clash) {
    throw new AppError(
      'RAAST_ACCOUNT_SHARED',
      'Another company already receives Raast payments on this bank account. One account can receive Raast for one company only — otherwise both companies would book the same transfer.',
      409,
    )
  }
}

/**
 * Who may change the company's operations rules (PATCH /setup/operations-config):
 * the CEO and co-owners (APPROVERS), plus the owner roles of the workspace the
 * 'configuration' module lives in (lib/workspaces.ts — Operations, owned by the
 * CEO). These rules are company-wide: whether clock-in needs a selfie or a
 * geofence at EVERY branch, how tips are split, the service charge,
 * withholding and invoice numbering. A floor manager could switch off the
 * selfie for every branch and re-weight their own team's tips (PPL-09).
 */
const CONFIG_WORKSPACE = WORKSPACES.find((w) => w.id === WORKSPACE_OF_MODULE.get('configuration'))
const OPERATIONS_RULE_EDITORS: UserRole[] = Array.from(
  new Set<UserRole>([...APPROVERS, ...(CONFIG_WORKSPACE?.ownerRoles ?? [])]),
)

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
  //
  // FINANCE_TEAM (managers + finance): Bank accounts is a page of the
  // 'accounting' module, which finance holds by default (lib/moduleAccess.ts),
  // and the Reconciliation and Deposit drops pages read this list. Finance got
  // 403 on all of them while these were MANAGERS-only (BOOKS-02).
  fastify.get('/bank-accounts', { preHandler: requireAuth(...FINANCE_TEAM) }, async (req) => {
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
  fastify.post('/bank-accounts', { preHandler: requireAuth(...FINANCE_TEAM) }, async (req, reply) => {
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
  fastify.patch<{ Params: { id: string } }>('/bank-accounts/:id', { preHandler: requireAuth(...FINANCE_TEAM) }, async (req) => {
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
      // Raast QR (spec §7.5): the Raast ID / alias the till shows, and whether
      // this is the company's default receiving account (one per company).
      raastId:             z.string().trim().max(40).nullable().optional().transform((v) => (v === '' ? null : v)),
      raastDefault:        z.boolean().optional(),
    }).parse(req.body)
    const existing = await prisma.bankAccount.findFirst({
      where: { id: req.params.id, deletedAt: null, ...(await scopeTenantWhere(req, 'write')) },
    })
    if (!existing) throw new NotFoundError('BankAccount', req.params.id)
    if (body.accountCode) {
      if (!existing.tenantId) throw new AppError('NO_COMPANY', 'This bank account has no company — it cannot link to a chart', 422)
      const { linkBankLedgerAccount } = await import('../../lib/bankAccounts.js')
      await linkBankLedgerAccount(existing.tenantId, body.name ?? existing.name, body.accountCode)
    }
    const { raastDefault, ...fields } = body
    const raastTouched = raastDefault !== undefined || body.raastId !== undefined
    const after = { ...existing, ...fields, raastDefault: raastDefault ?? existing.raastDefault }
    // Still (or now) a Raast receiving account once saved: the company default,
    // or a brand's override. Its checks run whenever the change could matter.
    const overrides = await prisma.concept.count({ where: { raastBankAccountId: existing.id, deletedAt: null } })
    const receiving = after.raastDefault || overrides > 0
    if (receiving && (raastDefault === true || ['iban', 'accountNumber', 'raastId', 'isActive', 'accountCode'].some((k) => k in fields))) {
      if (!existing.tenantId) throw new AppError('NO_COMPANY', 'This bank account has no company — it cannot receive Raast payments', 422)
      if (after.raastDefault && !after.isActive) {
        throw new AppError('BANK_ACCOUNT_INACTIVE', 'An inactive bank account cannot be the default Raast account — pick another default first', 422)
      }
      if (after.raastDefault && !after.accountCode) {
        throw new AppError('BANK_ACCOUNT_NOT_LINKED', 'Link this bank account to a chart code first — the ledger debits that code for every Raast payment', 422)
      }
      if (after.accountCode && !(await import('../../connectors/raast/accounts.js')).isRaastBankCode(after.accountCode)) {
        throw new AppError('RAAST_NOT_A_BANK_CODE', `Chart code ${after.accountCode} is not a bank balance (cash, the drawer, card receivable or customer receivable) — a Raast account must post to a bank code`, 422)
      }
      if (after.raastDefault && after.accountCode) {
        const live = await prisma.account.findFirst({ where: { tenantId: existing.tenantId, code: after.accountCode, isActive: true }, select: { id: true } })
        if (!live) throw new AppError('BANK_ACCOUNT_NOT_LINKED', `Chart code ${after.accountCode} is not active in this company's chart`, 422)
      }
      await assertRaastAccountNotShared(existing.tenantId, after)
    }
    const updated = await prisma.$transaction(async (tx) => {
      // One default per company (also a partial unique index): unset the
      // company's other default in the same transaction.
      if (raastDefault === true && existing.tenantId) {
        await tx.bankAccount.updateMany({ where: { tenantId: existing.tenantId, raastDefault: true, id: { not: existing.id } }, data: { raastDefault: false } })
      }
      return tx.bankAccount.update({ where: { id: existing.id }, data: { ...fields, ...(raastDefault !== undefined && { raastDefault }) } })
    })
    if (raastTouched) {
      await audit({
        category: 'accounting', action: 'raast.accounts.update', entity: 'BankAccount', entityId: existing.id,
        userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId: req.staffUser!.tenantId ?? null,
        before: { raastId: existing.raastId, raastDefault: existing.raastDefault },
        after: { raastId: updated.raastId, raastDefault: updated.raastDefault },
        metadata: { bankTenantId: existing.tenantId },
      })
    }
    return updated
  })
  fastify.delete<{ Params: { id: string } }>('/bank-accounts/:id', { preHandler: requireAuth(...FINANCE_TEAM) }, async (req, reply) => {
    const existing = await prisma.bankAccount.findFirst({
      where: { id: req.params.id, deletedAt: null, ...(await scopeTenantWhere(req, 'write')) },
      select: { id: true },
    })
    if (!existing) throw new NotFoundError('BankAccount', req.params.id)
    // A deleted account stops receiving Raast: no longer the company default
    // (brand overrides pointing at it fall back to the default — the resolver
    // ignores deleted accounts).
    await prisma.bankAccount.update({ where: { id: existing.id }, data: { deletedAt: new Date(), isActive: false, raastDefault: false } })
    return reply.status(204).send()
  })

  // ── Raast receiving accounts by brand (spec §7.5) ─────────────────────────
  // The company default is set on the bank account (PATCH raastDefault); a
  // brand may take its own account. Active company only. Edited here and
  // nowhere else (the IT connector page shows them read-only).
  fastify.get('/raast-accounts', { preHandler: requireAuth(...FINANCE_TEAM) }, async (req) => {
    const tenantId = activeTenantId(req)
    const { raastAccountsForCompany } = await import('../../connectors/raast/accounts.js')
    return raastAccountsForCompany(prisma, tenantId)
  })

  fastify.put('/raast-accounts', { preHandler: requireAuth(...FINANCE_TEAM) }, async (req) => {
    const body = z.object({
      brands: z.array(z.object({ conceptId: z.string().min(1), bankAccountId: z.string().min(1).nullable() })).min(1).max(100),
    }).parse(req.body)
    const tenantId = activeTenantId(req)
    // Resolve every brand and account first; write nothing until all pass.
    const plan: Array<{ conceptId: string; name: string; before: string | null; after: string | null }> = []
    for (const b of body.brands) {
      // A brand of the operator's companies (assertConceptOwned 404s a
      // foreign one), and of the ACTIVE company — the page edits one company.
      const owned = await assertConceptOwned(req, b.conceptId, 'write')
      const concept = await prisma.concept.findFirst({
        where: { id: owned.id, deletedAt: null },
        select: { id: true, name: true, tenantId: true, raastBankAccountId: true },
      })
      if (!concept || concept.tenantId !== tenantId) throw new NotFoundError('Concept', b.conceptId)
      if (b.bankAccountId) {
        const bank = await prisma.bankAccount.findFirst({ where: { id: b.bankAccountId, deletedAt: null } })
        if (!bank || bank.tenantId !== tenantId || !bank.isActive) {
          throw new AppError('BANK_ACCOUNT_NOT_IN_COMPANY', 'That bank account is not an active account of this company', 422)
        }
        if (!bank.accountCode) {
          throw new AppError('BANK_ACCOUNT_NOT_LINKED', 'Link that bank account to a chart code first (Finance → Bank accounts)', 422)
        }
        if (!(await import('../../connectors/raast/accounts.js')).isRaastBankCode(bank.accountCode)) {
          throw new AppError('RAAST_NOT_A_BANK_CODE', `Chart code ${bank.accountCode} of that bank account is not a bank balance — a Raast account must post to a bank code`, 422)
        }
        const live = await prisma.account.findFirst({ where: { tenantId, code: bank.accountCode, isActive: true }, select: { id: true } })
        if (!live) throw new AppError('BANK_ACCOUNT_NOT_LINKED', `Chart code ${bank.accountCode} of that bank account is not active in this company's chart`, 422)
        await assertRaastAccountNotShared(tenantId, bank)
      }
      plan.push({ conceptId: concept.id, name: concept.name, before: concept.raastBankAccountId, after: b.bankAccountId })
    }
    await prisma.$transaction(async (tx) => {
      for (const p of plan) await tx.concept.update({ where: { id: p.conceptId }, data: { raastBankAccountId: p.after } })
    })
    await audit({
      category: 'accounting', action: 'raast.accounts.update', entity: 'Concept',
      userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId,
      before: plan.map((p) => ({ conceptId: p.conceptId, bankAccountId: p.before })),
      after: plan.map((p) => ({ conceptId: p.conceptId, bankAccountId: p.after })),
    })
    const { raastAccountsForCompany } = await import('../../connectors/raast/accounts.js')
    return raastAccountsForCompany(prisma, tenantId)
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
  // 6. Webhook subscriptions live in /webhooks/endpoints (modules/webhooks):
  // ONE writer of WebhookSubscription, company-scoped, with the SSRF guard on
  // create / edit / test, a delivery log and a test ping. The copy that lived
  // here (/setup/webhooks) had none of those and was removed with its page.
  // ════════════════════════════════════════════════════════════════════════

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
  // withholding, clock-in geofence)
  // ════════════════════════════════════════════════════════════════════════

  fastify.get('/operations-config', { preHandler: requireAuth(...ALL_STAFF) }, async (req) => {
    return findOrCreateSingleton('operationsConfig', activeTenantId(req), {})
  })
  // Reading stays open to every staff member (the till and the clock-in screen
  // read it); changing it is CEO / owner only, and every change is audited.
  fastify.patch('/operations-config', { preHandler: requireAuth(...OPERATIONS_RULE_EDITORS) }, async (req) => {
    const body = z.object({
      serviceChargePct:               z.number().min(0).max(1).optional(),
      serviceChargeAppliesToChannels: z.array(z.string()).optional(),
      tipPoolEnabled:                 z.boolean().optional(),
      tipPoolDistribution:            z.enum(['equal', 'by_hours', 'by_role_weight']).optional(),
      tipPoolRoleWeights:             z.record(z.string(), z.number().min(0).max(10)).nullable().optional(),
      // Clock-in geofence (decision 37): the anchors are the company's
      // Locations with coordinates; these say whether it is enforced and how wide.
      geofenceEnforced:               z.boolean().optional(),
      geofenceRadiusMetres:           z.number().int().min(10).max(5000).optional(),
      selfieRequiredAtClockIn:        z.boolean().optional(),
      invoiceSequenceReset:           z.enum(['yearly', 'monthly', 'never']).optional(),
      invoiceCreditNotePrefix:        z.string().max(10).nullable().optional(),
      withholdingTaxEnabled:          z.boolean().optional(),
      withholdingTaxPct:              z.number().min(0).max(1).optional(),
      withholdingTaxRecoverable:      z.boolean().optional(),
      // The company-level brand-asset columns (secondaryColors, fonts,
      // brandVoiceNotes, social handles) are no longer written: nothing read
      // them. Brand voice is Concept.brandVoice, the WhatsApp number is
      // Concept.whatsapp (both per brand, on Storefront → Brands), and social
      // links are the brand footer (Storefront → Brand Footers). Columns kept.
    }).parse(req.body)
    const tenantId = activeTenantId(req)
    const cfg = await findOrCreateSingleton<Record<string, unknown> & { id: string; geofenceEnforced: boolean }>('operationsConfig', tenantId, {})
    const { tipPoolRoleWeights, ...rest } = body
    // Switching the geofence on for a company with no located branch would
    // lock every non-exempt login out of clocking in. Refuse it here, with the
    // fix, rather than at 9am on the shop floor.
    if (body.geofenceEnforced === true && !cfg.geofenceEnforced) {
      const located = await prisma.location.count({
        where: { tenantId, isActive: true, deletedAt: null, latitude: { not: null }, longitude: { not: null } },
      })
      if (located === 0) {
        throw new AppError('NO_LOCATED_BRANCH', 'Set the map pin on at least one of this company\'s locations (Configuration → Locations) before enforcing the clock-in geofence', 422)
      }
    }
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
    // Who changed which company-wide rule, from what to what.
    const changed = (Object.keys(body) as Array<keyof typeof body>)
      .filter((k) => JSON.stringify(cfg[k] ?? null) !== JSON.stringify((updated as Record<string, unknown>)[k] ?? null))
    if (changed.length > 0) {
      await audit({ category: 'identity',
        action: 'operations_config.update',
        entity: 'OperationsConfig',
        entityId: updated.id,
        userId: req.staffUser!.id, tenantId,
        userEmail: req.staffUser!.email,
        before: Object.fromEntries(changed.map((k) => [k, cfg[k] ?? null])),
        after: Object.fromEntries(changed.map((k) => [k, (updated as Record<string, unknown>)[k] ?? null])),
        metadata: { ip: req.ip, fields: changed },
      })
    }
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
  //
  // This is THE chart API (GET /accounting/accounts, an active-only copy with
  // no caller, is gone). Readable by every manager tier AND finance — the
  // finance officer works the books and could not open the only chart page
  // while it was MANAGERS-only.
  fastify.get('/chart-of-accounts', { preHandler: requireAuth(...FINANCE_TEAM) }, async (req) => {
    return prisma.account.findMany({
      where: await scopeTenantWhere(req, 'read'),
      orderBy: { code: 'asc' },
    })
  })
  // Adding, renaming or switching off an account changes what can post, so
  // both writes go on the accounting trail (category 'accounting').
  fastify.post('/chart-of-accounts', { preHandler: requireAuth(...ADMIN_ONLY) }, async (req, reply) => {
    const body = z.object({
      code:        z.string().min(1).max(20),
      name:        z.string().min(1).max(120),
      type:        z.enum(['asset', 'liability', 'equity', 'revenue', 'expense']),
      description: z.string().max(500).nullable().optional(),
    }).parse(req.body)
    const tenantId = activeTenantId(req)
    const created = await prisma.account.create({ data: { ...body, tenantId } })
    await audit({ category: 'accounting',
      action: 'account.create',
      entity: 'Account',
      entityId: created.id,
      userId: req.staffUser!.id, tenantId,
      userEmail: req.staffUser!.email,
      after: created,
      metadata: { ip: req.ip },
    })
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
    })
    if (!existing) throw new NotFoundError('Account', req.params.id)
    const updated = await prisma.account.update({ where: { id: existing.id }, data: body })
    await audit({ category: 'accounting',
      action: 'account.update',
      entity: 'Account',
      entityId: updated.id,
      // The account's own company — a head-office editor may be working in
      // another company's view.
      userId: req.staffUser!.id, tenantId: existing.tenantId,
      userEmail: req.staffUser!.email,
      before: existing,
      after: updated,
      metadata: { ip: req.ip },
    })
    return updated
  })

  // ════════════════════════════════════════════════════════════════════════

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
  // The ONE writer of ServiceHours (D1). Storefront open/closed and the
  // reservations availability search both read these rows; a day may carry
  // several windows (split lunch / dinner service).
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
        })).max(50),   // several windows per day (split lunch / dinner) are allowed
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
  // 17. Holidays / closures live in /reservations/blockouts (D2): one writer
  // for ConceptBlockout, validated against the BlockoutKind enum. The old
  // /setup/holidays writer accepted a 'special_hours' kind the enum does not
  // have (cast `as never`), so those rows never saved.
  // ════════════════════════════════════════════════════════════════════════

  // ════════════════════════════════════════════════════════════════════════
  // 18. Brand identity is edited in ONE place: PATCH /concepts/:id, from
  // admin → Storefront → Brands. The PATCH /setup/brand-identity/:conceptId
  // copy here had no caller and was removed.
  // ════════════════════════════════════════════════════════════════════════
}
