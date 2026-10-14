// Raast QR bank alerts — Dev → API → POS connector → Raast QR (spec §6.7).
// Prefix /connectors/raast (module gate api_pos, like every /connectors path;
// no new module id — Dev → API stays api_whatsapp + api_pos).
//
// Everything here is the operator's ACTIVE company: its raast connector row,
// its counter phones, its bank SMS log. A device / account / outlet of
// another company is 404 (device) or 422 (a settings entry naming it).
// Roles: ADMINS = CONNECTOR_ADMINS (admin, it) configure; VIEWERS (+
// management) read; the CEO (admin) alone switches SMS matching ON and
// reveals a device token again. A device token is shown ONCE (create /
// rotate); stored as a hash + secretBox ciphertext.

import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Prisma, PosConnector, UserRole } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { audit } from '../../lib/audit.js'
import { decryptSecret, secretKeyConfigured } from '../../lib/secretBox.js'
import { CONNECTOR_ADMINS } from '../../lib/connectorRoles.js'
import { activeTenantId } from '../../lib/tenantScope.js'
import { sandboxBlocks } from '../../lib/sandbox.js'
import { toCents } from '../../lib/money.js'
import { requireAuth } from '../auth/middleware.js'
import { parseRaastSettings, raastSenderSchema, raastTemplateSchema, raastSettingsSchema } from '../../connectors/config.js'
import { connectorNow, ensureConnectorRow, invalidateConnector } from '../../connectors/registry.js'
import type { RaastSettings, RaastTemplate } from '../../connectors/types.js'
import { raastAccountsForCompany, resolveRaastAccount } from '../../connectors/raast/accounts.js'
import { compileTemplate, isIgnored, matchTemplate, normalizeSender } from '../../connectors/raast/sms.js'
import { normalizeBankRef, assertValidBankRef } from '../../connectors/raast/reference.js'
import { deviceView, forwarderSetup, newDeviceToken, tokenColumns } from '../../connectors/raast/devices.js'

const ADMINS = [...CONNECTOR_ADMINS] as UserRole[]
const VIEWERS = [...CONNECTOR_ADMINS, 'management'] as UserRole[]
const CEO = ['admin'] as UserRole[]
const TX_OPTS = { maxWait: 10_000, timeout: 15_000 } as const

const idParam = z.object({ id: z.string().min(1).max(64) })

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? { ...(v as Record<string, unknown>) } : {}
}

async function lockConnectorTx(tx: Prisma.TransactionClient, id: string): Promise<PosConnector> {
  await tx.$queryRaw`SELECT id FROM pos_connectors WHERE id = ${id} FOR UPDATE`
  return tx.posConnector.findUniqueOrThrow({ where: { id } })
}

/** The connector row as the page shows it. */
function raastConnectorView(row: PosConnector) {
  const raw = asObject(row.settings)
  return {
    id: row.id,
    kind: row.kind,
    driver: row.driver,
    enabled: row.enabled,
    smsMatching: row.enabled,
    smsOnSince: typeof raw['smsOnSince'] === 'string' ? raw['smsOnSince'] : null,
    settings: parseRaastSettings(row.settings),
    updatedAt: row.updatedAt.toISOString(),
  }
}

function last4Of(accountNumber: string | null, iban: string | null): string | null {
  const d = String(accountNumber ?? iban ?? '').replace(/[^0-9A-Za-z]/g, '')
  return d ? d.slice(-4) : null
}

/** Bank accounts a sender may report on: the company's own, active, not deleted, linked to a chart code. */
async function linkableAccounts(tenantId: string, db: Prisma.TransactionClient | typeof prisma = prisma) {
  return db.bankAccount.findMany({
    where: { tenantId, isActive: true, deletedAt: null, accountCode: { not: null } },
    select: { id: true, name: true, bankName: true, accountNumber: true, iban: true, accountCode: true, raastId: true, raastDefault: true },
    orderBy: { name: 'asc' },
  })
}

async function counts(tenantId: string) {
  const since = new Date(connectorNow().getTime() - 86_400_000)
  const [awaiting, provisional, needsAttention, unmatchedAlerts, unparsed24h] = await Promise.all([
    prisma.raastReceipt.count({ where: { tenantId, status: 'awaiting' } }),
    prisma.raastReceipt.count({ where: { tenantId, status: 'provisional' } }),
    prisma.raastReceipt.count({ where: { tenantId, status: 'needs_attention' } }),
    prisma.bankSmsAlert.count({ where: { tenantId, status: { in: ['unmatched', 'ambiguous', 'needs_attention'] } } }),
    prisma.bankSmsAlert.count({ where: { tenantId, status: 'unparsed', receivedAt: { gte: since } } }),
  ])
  return { awaiting, provisional, needsAttention, unmatchedAlerts, unparsed24h }
}

/** What stops the CEO switching SMS matching ON (spec §6.7). */
export async function raastReadinessMissing(tenantId: string): Promise<string[]> {
  const missing: string[] = []
  const now = connectorNow()
  if (!secretKeyConfigured()) missing.push('SERVD_SECRET_KEY is not set on the server (device tokens cannot be stored)')
  const row = await prisma.posConnector.findUnique({ where: { tenantId_kind: { tenantId, kind: 'raast' } } })
  const s = parseRaastSettings(row?.settings ?? {})
  const seen = await prisma.bankSmsDevice.count({ where: { tenantId, active: true, lastSeenAt: { gte: new Date(now.getTime() - 86_400_000) } } })
  if (seen === 0) missing.push('No counter phone has reached servd in the last 24 hours — add a device and set up the SMS forwarder')
  const credit = new Set(s.templates.filter((t) => t.active && t.kind === 'credit').map((t) => t.id))
  if (!s.senders.some((x) => x.active && x.templateIds.some((id) => credit.has(id)))) missing.push('Add a bank sender with an active credit (money-in) template')
  const accounts = await raastAccountsForCompany(prisma, tenantId)
  if (!accounts.default) {
    const since = new Date(now.getTime() - 30 * 86_400_000)
    const trading = await prisma.concept.findMany({ where: { tenantId, deletedAt: null, orders: { some: { createdAt: { gte: since } } } }, select: { id: true, name: true } })
    if (trading.length === 0) missing.push('Set the company\'s Raast receiving account (Finance → Bank accounts)')
    for (const c of trading) if (!(await resolveRaastAccount(prisma, tenantId, c.id))) missing.push(`Set a Raast receiving account for ${c.name} (Finance → Bank accounts)`)
  }
  const parsedOff = await prisma.bankSmsAlert.count({ where: { tenantId, status: 'off', kind: 'credit', receivedAt: { gte: new Date(now.getTime() - 7 * 86_400_000) } } })
  if (parsedOff === 0) missing.push('No money-in bank SMS has been read correctly in the last 7 days — leave the phone forwarding for a day while SMS matching is off and check the bank SMS log')
  return missing
}

// ─── Settings validation ─────────────────────────────────────────────────────

const settingsPatch = raastSettingsSchema.partial().extend({
  senders: z.array(raastSenderSchema.extend({ id: z.string().min(1).max(64).optional() })).max(20).optional(),
  templates: z.array(raastTemplateSchema.extend({ id: z.string().min(1).max(64).optional() })).max(50).optional(),
}).strict()

async function validateSettings(tenantId: string, next: RaastSettings, tx: Prisma.TransactionClient): Promise<void> {
  if (next.refMinLength > next.refMaxLength) throw new AppError('INVALID_SETTINGS', 'The shortest reference cannot be longer than the longest', 422)
  const tIds = new Set<string>()
  for (const t of next.templates) {
    if (tIds.has(t.id)) throw new AppError('INVALID_SETTINGS', 'Two templates share an id', 422)
    tIds.add(t.id)
    const c = compileTemplate(t)
    if (!c.ok) throw new AppError('INVALID_TEMPLATE', `Template "${t.label}": ${c.problems[0]}`, 422, { templateId: t.id, problem: c.problems[0], problems: c.problems })
  }
  const linkable = new Set((await linkableAccounts(tenantId, tx)).map((a) => a.id))
  const sIds = new Set<string>()
  for (const x of next.senders) {
    if (sIds.has(x.id)) throw new AppError('INVALID_SETTINGS', 'Two senders share an id', 422)
    sIds.add(x.id)
    if (!x.senderId) throw new AppError('INVALID_SETTINGS', 'A sender needs its SMS sender id or number', 422)
    if (!linkable.has(x.bankAccountId)) {
      throw new AppError('BANK_ACCOUNT_NOT_IN_COMPANY', `The bank account for sender ${x.senderId} is not an active, ledger-linked account of this company`, 422, { senderId: x.senderId })
    }
    for (const id of x.templateIds) if (!tIds.has(id)) throw new AppError('INVALID_SETTINGS', `Sender ${x.senderId} names a template that does not exist`, 422, { templateId: id })
  }
  // Several accounts on one sender must be told apart by their last 4 digits.
  const bySender = new Map<string, number>()
  for (const x of next.senders.filter((y) => y.active)) bySender.set(x.senderId, (bySender.get(x.senderId) ?? 0) + 1)
  for (const x of next.senders) {
    if (x.active && (bySender.get(x.senderId) ?? 0) > 1 && !x.accountLast4) {
      throw new AppError('INVALID_SETTINGS', `Sender ${x.senderId} reports on several accounts — give each entry the account's last 4 digits`, 422, { senderId: x.senderId })
    }
  }
}

export async function raastConnectorRoutes(fastify: FastifyInstance) {
  // GET /connectors/raast/settings
  fastify.get('/settings', { preHandler: requireAuth(...VIEWERS) }, async (req) => {
    const tenantId = activeTenantId(req, 'the Raast connector belongs to one company')
    const row = await ensureConnectorRow(tenantId, 'raast')
    const [devices, accounts, bankAccounts, c, missing] = await Promise.all([
      prisma.bankSmsDevice.findMany({ where: { tenantId }, orderBy: { createdAt: 'asc' } }),
      raastAccountsForCompany(prisma, tenantId),
      linkableAccounts(tenantId),
      counts(tenantId),
      raastReadinessMissing(tenantId),
    ])
    return {
      connector: raastConnectorView(row),
      devices: devices.map(deviceView),
      receivingAccounts: {
        ...accounts,
        bankAccounts: bankAccounts.map((a) => ({ id: a.id, name: a.name, bankName: a.bankName, last4: last4Of(a.accountNumber, a.iban), accountCode: a.accountCode, raastId: a.raastId })),
      },
      counts: c,
      readiness: { ready: missing.length === 0, missing },
      secretKeyConfigured: secretKeyConfigured(),
    }
  })

  // PUT /connectors/raast/settings — partial merge under the row lock.
  fastify.put('/settings', { preHandler: requireAuth(...ADMINS) }, async (req) => {
    const patch = settingsPatch.parse(req.body ?? {})
    const tenantId = activeTenantId(req, 'the Raast connector belongs to one company')
    const seeded = await ensureConnectorRow(tenantId, 'raast')
    const { updated, changed } = await prisma.$transaction(async (tx) => {
      const row = await lockConnectorTx(tx, seeded.id)
      const stored = asObject(row.settings)
      const current = parseRaastSettings(stored)
      const templates = patch.templates?.map((t) => ({ ...t, id: t.id ?? `tpl_${randomBytes(6).toString('hex')}` }))
      const senders = patch.senders?.map((x) => ({ ...x, id: x.id ?? `snd_${randomBytes(6).toString('hex')}`, senderId: normalizeSender(x.senderId) }))
      const next = raastSettingsSchema.parse({ ...current, ...patch, ...(templates && { templates }), ...(senders && { senders }) }) as RaastSettings
      await validateSettings(tenantId, next, tx)
      const changed = Object.keys(patch)
      // smsOnSince is not a setting (the CEO's switch stamps it) — kept as stored.
      const merged = { ...next, ...('smsOnSince' in stored && { smsOnSince: stored['smsOnSince'] }) }
      const updated = await tx.posConnector.update({
        where: { id: row.id },
        data: { settings: JSON.parse(JSON.stringify(merged)) as Prisma.InputJsonValue, updatedById: req.staffUser!.id },
      })
      return { updated, changed }
    }, TX_OPTS)
    invalidateConnector(tenantId, 'raast')
    await audit({
      category: 'identity', action: 'raast.settings.update', entity: 'PosConnector', entityId: updated.id,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId, metadata: { changed },
    })
    return raastConnectorView(updated)
  })

  // POST /connectors/raast/sms-on — the CEO, after the readiness check.
  fastify.post('/sms-on', { preHandler: requireAuth(...CEO) }, async (req) => {
    z.object({ confirm: z.literal('SMS ON') }).parse(req.body)
    const tenantId = activeTenantId(req)
    const seeded = await ensureConnectorRow(tenantId, 'raast')
    const missing = await raastReadinessMissing(tenantId)
    if (missing.length > 0) throw new AppError('NOT_READY', 'Bank-SMS matching is not ready to switch on', 409, { missing })
    const updated = await prisma.$transaction(async (tx) => {
      const row = await lockConnectorTx(tx, seeded.id)
      const settings = { ...asObject(row.settings), smsOnSince: connectorNow().toISOString() }
      return tx.posConnector.update({ where: { id: row.id }, data: { enabled: true, settings: JSON.parse(JSON.stringify(settings)) as Prisma.InputJsonValue, updatedById: req.staffUser!.id } })
    }, TX_OPTS)
    invalidateConnector(tenantId, 'raast')
    await audit({ category: 'identity', action: 'raast.sms_on', entity: 'PosConnector', entityId: updated.id, userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId })
    return raastConnectorView(updated)
  })

  // POST /connectors/raast/sms-off — admins. Awaiting intents stay (confirm by hand or they expire).
  fastify.post('/sms-off', { preHandler: requireAuth(...ADMINS) }, async (req) => {
    z.object({ confirm: z.literal('SMS OFF') }).parse(req.body)
    const tenantId = activeTenantId(req)
    const row = await ensureConnectorRow(tenantId, 'raast')
    const updated = await prisma.posConnector.update({ where: { id: row.id }, data: { enabled: false, updatedById: req.staffUser!.id } })
    invalidateConnector(tenantId, 'raast')
    const awaiting = await prisma.raastReceipt.count({ where: { tenantId, status: 'awaiting' } })
    await audit({ category: 'identity', action: 'raast.sms_off', entity: 'PosConnector', entityId: row.id, userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId, metadata: { awaiting } })
    return { ...raastConnectorView(updated), awaiting }
  })

  // ── Devices ──
  fastify.get('/devices', { preHandler: requireAuth(...ADMINS) }, async (req) => {
    const tenantId = activeTenantId(req, 'the Raast connector belongs to one company')
    const rows = await prisma.bankSmsDevice.findMany({ where: { tenantId }, orderBy: { createdAt: 'asc' } })
    return rows.map(deviceView)
  })

  fastify.post('/devices', { preHandler: requireAuth(...ADMINS) }, async (req, reply) => {
    const body = z.object({
      label: z.string().trim().min(1).max(80),
      locationId: z.string().min(1).max(64).nullable().optional(),
      allowPathToken: z.boolean().optional(),
    }).strict().parse(req.body)
    const tenantId = activeTenantId(req)
    if (body.locationId) {
      const loc = await prisma.location.findFirst({ where: { id: body.locationId, tenantId, deletedAt: null }, select: { id: true } })
      if (!loc) throw new AppError('NOT_IN_COMPANY', 'That outlet does not belong to this company', 422)
    }
    const conn = await ensureConnectorRow(tenantId, 'raast')
    const token = newDeviceToken()
    const cols = tokenColumns(token) // 503 SECRET_KEY_MISSING without SERVD_SECRET_KEY
    const d = await prisma.bankSmsDevice.create({
      data: {
        tenantId, connectorId: conn.id, locationId: body.locationId ?? null, label: body.label, ...cols,
        allowPathToken: body.allowPathToken ?? false, createdById: req.staffUser!.id,
      },
    })
    await audit({ category: 'identity', action: 'raast.device.create', entity: 'BankSmsDevice', entityId: d.id, userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId, metadata: { label: d.label, locationId: d.locationId } })
    return reply.status(201).send({ device: deviceView(d), token, ...forwarderSetup(token, d.allowPathToken) })
  })

  fastify.post('/devices/:id/rotate', { preHandler: requireAuth(...ADMINS) }, async (req) => {
    const { id } = idParam.parse(req.params)
    const tenantId = activeTenantId(req)
    const d = await prisma.bankSmsDevice.findFirst({ where: { id, tenantId } })
    if (!d) throw new NotFoundError('Device', id)
    const token = newDeviceToken()
    const cols = tokenColumns(token)
    const updated = await prisma.bankSmsDevice.update({ where: { id: d.id }, data: { ...cols, rotatedAt: connectorNow() } })
    await audit({ category: 'identity', action: 'raast.device.rotate', entity: 'BankSmsDevice', entityId: d.id, userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId })
    return { device: deviceView(updated), token, ...forwarderSetup(token, updated.allowPathToken) }
  })

  fastify.patch('/devices/:id', { preHandler: requireAuth(...ADMINS) }, async (req) => {
    const { id } = idParam.parse(req.params)
    const body = z.object({
      label: z.string().trim().min(1).max(80).optional(),
      locationId: z.string().min(1).max(64).nullable().optional(),
      active: z.boolean().optional(),
      allowPathToken: z.boolean().optional(),
    }).strict().parse(req.body ?? {})
    const tenantId = activeTenantId(req)
    const d = await prisma.bankSmsDevice.findFirst({ where: { id, tenantId } })
    if (!d) throw new NotFoundError('Device', id)
    if (body.locationId) {
      const loc = await prisma.location.findFirst({ where: { id: body.locationId, tenantId, deletedAt: null }, select: { id: true } })
      if (!loc) throw new AppError('NOT_IN_COMPANY', 'That outlet does not belong to this company', 422)
    }
    const updated = await prisma.bankSmsDevice.update({
      where: { id: d.id },
      data: {
        ...(body.label !== undefined && { label: body.label }),
        ...(body.locationId !== undefined && { locationId: body.locationId }),
        ...(body.active !== undefined && { active: body.active }),
        ...(body.allowPathToken !== undefined && { allowPathToken: body.allowPathToken }),
      },
    })
    await audit({
      category: 'identity', action: 'raast.device.update', entity: 'BankSmsDevice', entityId: d.id, userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId,
      before: { label: d.label, locationId: d.locationId, active: d.active, allowPathToken: d.allowPathToken },
      after: { label: updated.label, locationId: updated.locationId, active: updated.active, allowPathToken: updated.allowPathToken },
    })
    return deviceView(updated)
  })

  // POST /connectors/raast/devices/:id/reveal — the CEO only, audited.
  fastify.post('/devices/:id/reveal', { preHandler: requireAuth(...CEO) }, async (req) => {
    const { id } = idParam.parse(req.params)
    // Practice copy: a copied token could be a LIVE counter phone's (forged bank SMS into live servd).
    if (sandboxBlocks('raast_token')) throw new AppError('SANDBOX', 'Practice copy: device tokens are never shown here — rotate the device to get a practice token', 403)
    const tenantId = activeTenantId(req)
    const d = await prisma.bankSmsDevice.findFirst({ where: { id, tenantId } })
    if (!d) throw new NotFoundError('Device', id)
    const token = decryptSecret(d.tokenEnc)
    await audit({ category: 'identity', action: 'raast.device.reveal', entity: 'BankSmsDevice', entityId: d.id, userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId })
    return { device: deviceView(d), token, ...forwarderSetup(token, d.allowPathToken) }
  })

  // POST /connectors/raast/test-parse — writes nothing.
  fastify.post('/test-parse', { preHandler: requireAuth(...VIEWERS) }, async (req) => {
    const body = z.object({
      sender: z.string().trim().min(1).max(64),
      body: z.string().min(1).max(2000),
      templates: z.array(raastTemplateSchema.extend({ id: z.string().min(1).max(64).optional() })).max(50).optional(),
    }).strict().parse(req.body)
    const tenantId = activeTenantId(req, 'the Raast connector belongs to one company')
    const row = await prisma.posConnector.findUnique({ where: { tenantId_kind: { tenantId, kind: 'raast' } }, select: { settings: true } })
    const s = parseRaastSettings(row?.settings ?? {})
    const sender = normalizeSender(body.sender)
    const entries = s.senders.filter((x) => x.active && normalizeSender(x.senderId) === sender)
    let templates: RaastTemplate[]
    if (body.templates) {
      templates = body.templates.map((t, i) => ({ ...t, id: t.id ?? `draft_${i + 1}` }))
    } else {
      const ids = new Set(entries.flatMap((x) => x.templateIds))
      templates = entries.length > 0 ? s.templates.filter((t) => ids.has(t.id)) : s.templates
    }
    const now = connectorNow()
    return {
      sender,
      senderAllowed: entries.length > 0,
      ignoredByKeyword: isIgnored(body.body, s.ignoreKeywords),
      results: templates.map((t) => {
        const m = matchTemplate(body.body, t, { now })
        let refValid = false
        if (m.parsed?.bankRef) {
          try { assertValidBankRef(normalizeBankRef(m.parsed.bankRef), { min: s.refMinLength, max: s.refMaxLength }); refValid = true } catch { refValid = false }
        }
        return {
          templateId: t.id,
          label: t.label,
          kind: t.kind,
          active: t.active,
          matched: !!m.parsed,
          fields: m.parsed
            ? {
                amountCents: m.parsed.amountCents, bankRef: m.parsed.bankRef, refValid, occurredAt: m.parsed.occurredAt.toISOString(),
                occurredAtSource: m.parsed.occurredAtSource, accountLast4: m.parsed.accountLast4, payer: m.parsed.payer,
              }
            : null,
          problems: m.problems,
        }
      }),
    }
  })

  // GET /connectors/raast/sms?status&cursor&limit — the bank SMS log.
  fastify.get('/sms', { preHandler: requireAuth(...VIEWERS) }, async (req) => {
    const q = z.object({
      status: z.enum(['received', 'processing', 'unparsed', 'off', 'debit', 'duplicate', 'matched', 'confirmed', 'unmatched', 'ambiguous', 'needs_attention', 'attached', 'dismissed']).optional(),
      cursor: z.string().min(1).max(64).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }).parse(req.query)
    const tenantId = activeTenantId(req, 'the Raast connector belongs to one company')
    const rows = await prisma.bankSmsAlert.findMany({
      where: { tenantId, ...(q.status && { status: q.status }) },
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
      ...(q.cursor && { cursor: { id: q.cursor }, skip: 1 }),
      include: { device: { select: { label: true } }, receipt: { select: { id: true, orderId: true, status: true } } },
    })
    const page = rows.slice(0, q.limit)
    return {
      items: page.map((a) => ({
        id: a.id,
        status: a.status,
        sender: a.sender,
        body: a.body,
        device: a.device.label,
        locationId: a.locationId,
        receivedAt: a.receivedAt.toISOString(),
        kind: a.kind,
        templateId: a.templateId,
        amountCents: toCents(a.amountCents),
        bankRef: a.bankRef,
        occurredAt: a.occurredAt?.toISOString() ?? null,
        payer: a.payer,
        accountLast4: a.accountLast4,
        bankAccountId: a.bankAccountId,
        resolution: a.resolution,
        receipt: a.receipt ? { id: a.receipt.id, orderId: a.receipt.orderId, status: a.receipt.status } : null,
      })),
      nextCursor: rows.length > q.limit ? page[page.length - 1]!.id : null,
    }
  })
}

/** The /connectors overview's raast block (modules/connectors/routes.ts). */
export async function raastOverview(tenantId: string) {
  const row = await ensureConnectorRow(tenantId, 'raast')
  const [devices, last, c] = await Promise.all([
    prisma.bankSmsDevice.count({ where: { tenantId, active: true } }),
    prisma.bankSmsDevice.findFirst({ where: { tenantId, lastSmsAt: { not: null } }, orderBy: { lastSmsAt: 'desc' }, select: { lastSmsAt: true } }),
    counts(tenantId),
  ])
  return { enabled: row.enabled, devices, lastSmsAt: last?.lastSmsAt?.toISOString() ?? null, counts: c }
}
