// POS connector configuration — Dev → API → POS connector (spec §8.1, §17.0,
// §17.7). Prefix /connectors (module gate api_pos).
//
// Every row here belongs to ONE company: reads and writes bind to the
// operator's ACTIVE company (activeTenantId) — the document and charge lists
// too, since the connector is one company's — single-row reads use
// scopeTenantWhere,
// foreign rows are 404 and a settings entry naming another company's outlet
// or brand is 422. Secrets are stored only as secretBox ciphertext and never
// leave the server — responses carry a hint (first 4 + last 4), except a
// freshly generated webhook secret, returned once.
//
// There is NO skip anywhere (§17.0): a real sale is never excluded from
// fiscal filing by an operator. Held documents are released all at once per
// company (or per brand), never by date range.

import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { Prisma, PosConnector } from '@prisma/client'
import { prisma, serviceClient } from '../../lib/prisma.js'
import { isTestTenant } from '../../lib/testCompany.js'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { audit } from '../../lib/audit.js'
import { encryptSecret, secretHint } from '../../lib/secretBox.js'
import { CONNECTOR_ADMINS } from '../../lib/connectorRoles.js'
import { requireAuth } from '../auth/middleware.js'
import { activeTenantId, assertConceptOwned, scopeTenantWhere } from '../../lib/tenantScope.js'
import type { UserRole } from '@prisma/client'
import type { ConnectorKindT, FiscalPayload } from '../../connectors/types.js'
import {
  assertUrlAllowed, fiscalSettingsSchema, terminalSettingsSchema, parseFiscalSettings, parseTerminalSettings, parseRaastSettings,
  reportingRequiredOf, AUTHORITIES, terminalEntrySchema,
} from '../../connectors/config.js'
import { raastOverview } from './raastRoutes.js'
import {
  buildCtx, ensureConnectorRow, getConnectorFresh, invalidateConnector, isKnownDriver, listDrivers, newWebhookToken,
  fiscalDriverOf, terminalDriverOf, connectorNow,
} from '../../connectors/registry.js'
import { fiscalCounts, releaseHeld, retryDocument, retryFailedForTenant, recordManualFiling } from '../../connectors/fiscal/outbox.js'
import { resolveRegistrations, orderRefOf } from '../../connectors/fiscal/payload.js'
import { LEGACY_DRAIN_KEY } from '../../connectors/legacyDrain.js'
import { chargeView } from '../../connectors/terminal/service.js'
import { testApproval } from '../../connectors/drivers/test.js'
import { handleInboundEvent } from '../../connectors/inbound.js'
import { isoPkt, scrubMessage, withTimeout } from '../../connectors/util.js'
import { practiceConnectorRow } from '../../lib/sandbox.js'

const ADMINS = [...CONNECTOR_ADMINS] as UserRole[]
const VIEWERS = [...CONNECTOR_ADMINS, 'management'] as UserRole[]
const CEO = ['admin'] as UserRole[]

const kindParam = z.object({ kind: z.enum(['fiscal', 'terminal']) })
const idParam = z.object({ id: z.string().min(1).max(64) })

function webhookUrl(token: string): string {
  const base = (process.env['API_URL'] ?? 'https://api.servd.pk').replace(/\/+$/, '')
  return `${base}/api/v1/webhooks/pos/${token}`
}

export interface ConnectorView {
  id: string
  kind: ConnectorKindT
  driver: string
  enabled: boolean
  isTest: boolean
  liveSince: string | null
  baseUrl: string | null
  apiKeyHint: string | null
  webhookSecretHint: string | null
  webhookUrl: string
  settings: unknown
  lastTestAt: string | null
  lastTestOk: boolean | null
  lastTestDetail: string | null
  lastOkAt: string | null
  lastError: string | null
  lastErrorAt: string | null
}

function viewOf(row: PosConnector): ConnectorView {
  row = practiceConnectorRow(row) // practice copy: the page shows the test driver it really runs on
  return {
    id: row.id,
    kind: row.kind,
    driver: row.driver,
    enabled: row.enabled,
    isTest: row.driver === 'test',
    liveSince: row.liveSince?.toISOString() ?? null,
    baseUrl: row.baseUrl,
    apiKeyHint: row.apiKeyHint,
    webhookSecretHint: row.webhookSecretHint,
    webhookUrl: webhookUrl(row.webhookToken),
    settings: row.kind === 'fiscal' ? parseFiscalSettings(row.settings) : row.kind === 'raast' ? parseRaastSettings(row.settings) : parseTerminalSettings(row.settings),
    lastTestAt: row.lastTestAt?.toISOString() ?? null,
    lastTestOk: row.lastTestOk,
    lastTestDetail: row.lastTestDetail,
    lastOkAt: row.lastOkAt?.toISOString() ?? null,
    lastError: row.lastError,
    lastErrorAt: row.lastErrorAt?.toISOString() ?? null,
  }
}

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? { ...(v as Record<string, unknown>) } : {}
}

/** The connector row, locked for the rest of the transaction (read-modify-write of its settings). */
async function lockConnectorTx(tx: Prisma.TransactionClient, id: string): Promise<PosConnector> {
  await tx.$queryRaw`SELECT id FROM pos_connectors WHERE id = ${id} FOR UPDATE`
  return tx.posConnector.findUniqueOrThrow({ where: { id } })
}

/** The saved form of a base URL (as assertUrlAllowed returns it), without any DNS — for the early live check only. */
function looseUrl(raw: string): string | null {
  const v = raw.trim()
  if (!v) return null
  try { return new URL(v).toString().replace(/\/+$/, '') } catch { return v }
}

function switchOffFirst(what: string): AppError {
  return new AppError('SWITCH_OFF_FIRST', `The fiscal POS is live — the CEO switches it off before ${what} can be changed, and goes live again after a successful test`, 409)
}

async function locationsOfCompany(tenantId: string, ids: string[], db: Prisma.TransactionClient | typeof prisma = prisma): Promise<Set<string>> {
  if (ids.length === 0) return new Set()
  const rows = await db.location.findMany({ where: { id: { in: ids }, tenantId, deletedAt: null }, select: { id: true } })
  return new Set(rows.map((r) => r.id))
}

function notInCompany(what: string): AppError {
  return new AppError('NOT_IN_COMPANY', `${what} does not belong to this company`, 422)
}

/** The brands of the company and their POS ids. */
async function brandPosIds(tenantId: string) {
  const rows = await prisma.concept.findMany({
    where: { tenantId, deletedAt: null },
    select: { id: true, name: true, fbrPosId: true, srbPosId: true, province: true },
    orderBy: { name: 'asc' },
  })
  return rows.map((c) => ({ conceptId: c.id, name: c.name, fbrPosId: c.fbrPosId, srbPosId: c.srbPosId, province: c.province }))
}

// ─── Body schemas ─────────────────────────────────────────────────────────────

const putBody = z.object({
  driver: z.string().min(1).max(40).optional(),
  baseUrl: z.string().max(500).optional(),
  apiKey: z.string().max(1000).optional(),
  webhookSecret: z.string().max(1000).optional(),
  regenerateWebhookSecret: z.boolean().optional(),
  enabled: z.boolean().optional(),
  settings: z.record(z.unknown()).optional(),
}).strict()

const fiscalSettingsPatch = fiscalSettingsSchema.partial().strict()
const terminalSettingsPatch = terminalSettingsSchema.partial().extend({
  terminals: z.array(terminalEntrySchema.extend({ id: z.string().min(1).max(64).optional() })).max(100).optional(),
}).strict()

const docsQuery = z.object({
  status: z.enum(['held', 'waiting', 'pending', 'submitting', 'filed', 'rejected', 'failed', 'skipped', 'manual_required', 'manual_filed']).optional(),
  kind: z.enum(['sale', 'refund']).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  conceptId: z.string().min(1).max(64).optional(),
  q: z.string().trim().min(1).max(64).optional(),
  cursor: z.string().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
})

/** The connector page's note on a held backlog while reporting is OFF (null otherwise). */
export function heldNoteOf(reportingRequired: boolean, held: number): string | null {
  if (reportingRequired || held <= 0) return null
  return `${held} sale${held === 1 ? ' was' : 's were'} held before "Fiscal reporting required" was switched off. They are kept as they are — no sale is ever skipped — and are not counted as a backlog while reporting is off. If reporting is switched back on, they release with the fiscal POS as usual (or record a manual filing for each).`
}

/**
 * THE writer of a company's "Fiscal reporting required" switch (§17.7): the
 * PUT route below and the test-company create / toggle (tenants/routes.ts)
 * all go through it. Same row lock as PUT /connectors/fiscal (W1-R10),
 * audited `fiscal.reporting_required`. Callers decide who may flip it.
 *
 * `underLock(tx)` runs inside the same transaction, after the connector row
 * is locked and before the switch is written — the test-mode toggle writes
 * `Tenant.isTest` there, and the PUT route re-reads isTest there (fr-3), so
 * the flag and the switch can never be left disagreeing by a race.
 *
 * Switching reporting ON after it was off stamps `reportingRequiredSince`
 * (ISO): sales completed before it are never filed by any later path
 * (config.ts saleFileable — fr-2). Switching it OFF drops the stamp (nothing
 * files while off; the next ON stamps afresh). `underLock` may ask for a
 * fresh stamp even when reporting was already on (a test company made real).
 */
export async function setFiscalReportingRequired(
  tenantId: string,
  required: boolean,
  by: { userId: string; userEmail?: string | null; reason: string },
  opts: { underLock?: (tx: Prisma.TransactionClient) => Promise<{ stampSince?: boolean } | void> } = {},
): Promise<{ fiscalReportingRequired: boolean; heldCount: number; heldNote: string | null }> {
  const seeded = await ensureConnectorRow(tenantId, 'fiscal')
  const { row, before } = await prisma.$transaction(async (tx) => {
    const row = await lockConnectorTx(tx, seeded.id)
    const hook = opts.underLock ? await opts.underLock(tx) : undefined
    const before = reportingRequiredOf(row.settings)
    const settings: Record<string, unknown> = { ...asObject(row.settings), fiscalReportingRequired: required }
    if (!required) delete settings.reportingRequiredSince
    else if (!before || hook?.stampSince) settings.reportingRequiredSince = new Date().toISOString()
    await tx.posConnector.update({ where: { id: row.id }, data: { settings: JSON.parse(JSON.stringify(settings)) as Prisma.InputJsonValue, updatedById: by.userId } })
    return { row, before }
  }, { maxWait: 10_000, timeout: 15_000 })
  invalidateConnector(tenantId, 'fiscal')
  // The held backlog is left exactly as it is (no skip, §17.0); the answer
  // says how many there are so the CEO's confirmation can state it.
  const heldCount = await prisma.fiscalDocument.count({ where: { tenantId, status: 'held' } })
  await audit({
    category: 'identity', action: 'fiscal.reporting_required', entity: 'PosConnector', entityId: row.id,
    userId: by.userId, userEmail: by.userEmail ?? undefined, tenantId,
    before: { fiscalReportingRequired: before }, after: { fiscalReportingRequired: required },
    metadata: { reason: by.reason, heldCount },
  })
  return { fiscalReportingRequired: required, heldCount, heldNote: heldNoteOf(required, heldCount) }
}

/**
 * A brand-new company's fiscal connector row, created inside the caller's
 * transaction with reporting OFF (the test-company create — fr-3: the
 * company and its switch commit together or not at all). The caller audits.
 */
export async function seedFiscalReportingOffTx(tx: Prisma.TransactionClient, tenantId: string, userId: string): Promise<{ id: string }> {
  return tx.posConnector.create({
    data: {
      tenantId, kind: 'fiscal', driver: 'none', enabled: false, webhookToken: newWebhookToken(),
      settings: { fiscalReportingRequired: false }, updatedById: userId,
    },
    select: { id: true },
  })
}

export async function connectorRoutes(fastify: FastifyInstance) {
  // GET /connectors/drivers
  fastify.get('/drivers', { preHandler: requireAuth(...ADMINS) }, async () => listDrivers())

  // GET /connectors — the ACTIVE company's connectors (fiscal, card machine,
  // Raast QR bank alerts), POS ids and backlog.
  fastify.get('/', { preHandler: requireAuth(...VIEWERS) }, async (req) => {
    const tenantId = activeTenantId(req, 'the POS connector belongs to one company')
    const [fiscal, terminal] = await Promise.all([ensureConnectorRow(tenantId, 'fiscal'), ensureConnectorRow(tenantId, 'terminal')])
    const [counts, brands, terminalAttention, raast] = await Promise.all([
      fiscalCounts([tenantId]),
      brandPosIds(tenantId),
      prisma.terminalCharge.count({ where: { tenantId, status: { in: ['needs_attention', 'unknown', 'unverified', 'void_pending'] } } }),
      raastOverview(tenantId),
    ])
    const reportingRequired = reportingRequiredOf(fiscal.settings)
    return {
      fiscal: viewOf(fiscal),
      terminal: viewOf(terminal),
      fiscalReportingRequired: reportingRequired,
      // BOOKS-R2-02 / FOH-R2-02: sales held before reporting was switched off
      // stay listed (never skipped), with this note; /health ignores them.
      heldNote: heldNoteOf(reportingRequired, counts.held),
      legacyDrained: !!(await prisma.setting.findUnique({ where: { key: LEGACY_DRAIN_KEY }, select: { key: true } })),
      brandPosIds: brands,
      counts,
      terminalAttention,
      raast,
    }
  })

  // PUT /connectors/:kind — configure (upsert on the active company).
  //
  // Read-modify-write under a row lock (SELECT … FOR UPDATE), like the CEO's
  // reporting switch below, so a concurrent save can never drop the other's
  // change (W1-R10). DNS for a new base URL is checked before the lock.
  fastify.put('/:kind', { preHandler: requireAuth(...ADMINS) }, async (req) => {
    const { kind } = kindParam.parse(req.params)
    const body = putBody.parse(req.body)
    const tenantId = activeTenantId(req, 'the POS connector belongs to one company')
    const seeded = await ensureConnectorRow(tenantId, kind)
    // Early refusal (re-checked under the lock below) before any DNS work.
    if (kind === 'fiscal' && seeded.enabled) {
      if (body.driver !== undefined && body.driver !== seeded.driver) throw switchOffFirst('the fiscal POS driver')
      if (body.baseUrl !== undefined && looseUrl(body.baseUrl) !== seeded.baseUrl) throw switchOffFirst('the fiscal POS address')
    }
    const checkedUrl = body.baseUrl !== undefined && body.baseUrl.trim() ? await assertUrlAllowed(body.baseUrl) : null
    let newWebhookSecret: string | undefined

    const { row, updated, changed } = await prisma.$transaction(async (tx) => {
      const row = await lockConnectorTx(tx, seeded.id)
      const data: Prisma.PosConnectorUpdateInput = {}
      const changed: string[] = []

      if (body.driver !== undefined && body.driver !== row.driver) {
        if (!isKnownDriver(kind, body.driver)) throw new AppError('UNKNOWN_DRIVER', `No ${kind} driver called '${body.driver}'`, 422)
        // W1-R6: a LIVE fiscal POS is never re-pointed from here — switching
        // the filer (http ↔ test, or to none) bypasses the CEO's switch-off and
        // the go-live readiness check. The CEO switches off, IT changes it, the
        // CEO goes live again.
        if (kind === 'fiscal' && row.enabled) throw switchOffFirst('the fiscal POS driver')
        data.driver = body.driver
        changed.push('driver')
      }
      const driver = body.driver ?? row.driver

      if (body.baseUrl !== undefined) {
        const url = body.baseUrl.trim() ? checkedUrl : null
        if (url !== row.baseUrl) {
          if (kind === 'fiscal' && row.enabled) throw switchOffFirst('the fiscal POS address')
          data.baseUrl = url
          changed.push('baseUrl')
        }
      }
      if (body.apiKey !== undefined) {
        const v = body.apiKey.trim()
        data.apiKeyEnc = v ? encryptSecret(v) : null
        data.apiKeyHint = v ? secretHint(v) : null
        changed.push('apiKey')
      }
      if (body.regenerateWebhookSecret) {
        newWebhookSecret = randomBytes(32).toString('hex')
        data.webhookSecretEnc = encryptSecret(newWebhookSecret)
        data.webhookSecretHint = secretHint(newWebhookSecret)
        changed.push('webhookSecret')
      } else if (body.webhookSecret !== undefined) {
        const v = body.webhookSecret.trim()
        data.webhookSecretEnc = v ? encryptSecret(v) : null
        data.webhookSecretHint = v ? secretHint(v) : null
        changed.push('webhookSecret')
      }

      // Settings: partial merge over the current (locked) values, then the full schema.
      const stored = asObject(row.settings)
      let mergedSettings: Record<string, unknown> | null = null
      if (body.settings !== undefined) {
        if (kind === 'fiscal') {
          const patch = fiscalSettingsPatch.parse(body.settings)
          const next = fiscalSettingsSchema.parse({ ...parseFiscalSettings(stored), ...patch })
          const locs = await locationsOfCompany(tenantId, [...new Set(next.outlets.map((o) => o.locationId))], tx)
          for (const o of next.outlets) {
            if (!locs.has(o.locationId)) throw notInCompany('An outlet in the POS id overrides')
            if (o.conceptId) {
              const c = await tx.concept.findFirst({ where: { id: o.conceptId, tenantId, deletedAt: null }, select: { id: true } })
              if (!c) throw notInCompany('A brand in the POS id overrides')
            }
          }
          // The company switch (§17.7) is not a driver setting: kept as stored (read under the lock), changed only by the CEO's own route.
          mergedSettings = { ...next, ...('fiscalReportingRequired' in stored && { fiscalReportingRequired: stored['fiscalReportingRequired'] }) }
        } else {
          const patch = terminalSettingsPatch.parse(body.settings)
          const terminals = patch.terminals?.map((t) => ({ ...t, id: t.id ?? `trm_${randomBytes(6).toString('hex')}` }))
          const next = terminalSettingsSchema.parse({ ...parseTerminalSettings(stored), ...patch, ...(terminals && { terminals }) })
          const ids = new Set<string>()
          for (const t of next.terminals) {
            if (ids.has(t.id)) throw new AppError('INVALID_SETTINGS', 'Two card machines share an id', 422)
            ids.add(t.id)
          }
          const locs = await locationsOfCompany(tenantId, [...new Set(next.terminals.map((t) => t.locationId))], tx)
          for (const t of next.terminals) if (!locs.has(t.locationId)) throw notInCompany(`The outlet of card machine '${t.label}'`)
          mergedSettings = next
        }
        data.settings = JSON.parse(JSON.stringify(mergedSettings)) as Prisma.InputJsonValue
        changed.push('settings')
      }

      if (kind === 'terminal') {
        const effective = parseTerminalSettings(mergedSettings ?? stored)
        if (driver === 'none' && !effective.allowManualRef) throw new AppError('INVALID_SETTINGS', 'The manual card reference cannot be switched off while no card machine driver is set', 422)
        if (body.enabled !== undefined && body.enabled !== row.enabled) {
          if (body.enabled && driver === 'none') throw new AppError('INVALID_SETTINGS', 'Pick a card machine driver before switching it on', 422)
          data.enabled = body.enabled
          changed.push('enabled')
        } else if (driver === 'none' && row.enabled) {
          data.enabled = false
          changed.push('enabled')
        }
      }
      // body.enabled is ignored for fiscal: go-live / switch-off are the CEO's.

      data.updatedById = req.staffUser!.id
      const updated = await tx.posConnector.update({ where: { id: row.id }, data })
      return { row, updated, changed }
    }, { maxWait: 10_000, timeout: 15_000 })
    invalidateConnector(tenantId, kind)
    await audit({
      category: 'identity', action: 'connectors.update', entity: 'PosConnector', entityId: row.id,
      userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId,
      metadata: { kind, driver: updated.driver, changed },
    })
    return { ...viewOf(updated), ...(newWebhookSecret && { newWebhookSecret }) }
  })

  // POST /connectors/:kind/rotate-webhook-token
  fastify.post('/:kind/rotate-webhook-token', { preHandler: requireAuth(...ADMINS) }, async (req) => {
    const { kind } = kindParam.parse(req.params)
    const tenantId = activeTenantId(req)
    const row = await ensureConnectorRow(tenantId, kind)
    const updated = await prisma.posConnector.update({ where: { id: row.id }, data: { webhookToken: newWebhookToken(), updatedById: req.staffUser!.id } })
    invalidateConnector(tenantId, kind)
    await audit({ category: 'identity', action: 'connectors.rotate_webhook_token', entity: 'PosConnector', entityId: row.id, userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId, metadata: { kind } })
    return { webhookUrl: webhookUrl(updated.webhookToken) }
  })

  // POST /connectors/:kind/test — health (+ a dry-run sale that is never stored).
  fastify.post('/:kind/test', { preHandler: requireAuth(...ADMINS) }, async (req) => {
    const { kind } = kindParam.parse(req.params)
    const body = z.object({ dryRun: z.boolean().optional(), terminalId: z.string().max(64).optional() }).parse(req.body ?? {})
    const tenantId = activeTenantId(req)
    const conn = await getConnectorFresh(tenantId, kind)
    const t0 = Date.now()
    let ok = false
    let detail = ''
    let latencyMs = 0
    let dryRun: { outcome: string; fiscalNumber?: string } | undefined
    if (conn.secretError) {
      detail = `Stored secret cannot be read: ${conn.secretError}`
    } else if (kind === 'fiscal') {
      const driver = fiscalDriverOf(conn.row.driver)
      if (!driver) detail = 'Pick a driver first'
      else {
        const h = await safe(() => driver.health(buildCtx(conn, 5000)), 5000)
        latencyMs = Date.now() - t0
        ok = h.kind === 'ok'
        detail = h.kind === 'ok' ? (h.value.detail ?? 'reachable') : `${h.code}: ${h.message}`
        if (ok && body.dryRun) {
          const brands = await brandPosIds(tenantId)
          const brand = brands.find((b) => b.srbPosId || b.fbrPosId) ?? brands[0]
          const registrations = brand ? resolveRegistrations(conn.fiscalSettings.outlets, { id: brand.conceptId, fbrPosId: brand.fbrPosId, srbPosId: brand.srbPosId }, null) : []
          const payload = dryRunPayload(tenantId, brand?.name ?? 'servd', registrations)
          const out = await safe(() => driver.submitSale(buildCtx(conn, 5000), payload), 5000)
          dryRun = out.kind === 'ok'
            ? { outcome: out.value.state, ...(out.value.state === 'filed' && { fiscalNumber: out.value.result.fiscalNumber }) }
            : { outcome: `${out.kind}: ${out.code}` }
          if (out.kind !== 'ok') { ok = false; detail = `Dry-run sale ${out.kind}: ${out.code} ${out.message}` }
        }
      }
    } else {
      const driver = terminalDriverOf(conn.row.driver)
      if (!driver) detail = 'Pick a driver first'
      else {
        const t = body.terminalId ? conn.terminalSettings.terminals.find((x) => x.id === body.terminalId) : conn.terminalSettings.terminals[0]
        if (body.terminalId && !t) throw new NotFoundError('Card machine', body.terminalId)
        const h = await safe(() => driver.health(buildCtx(conn, 5000), t?.terminalId), 5000)
        latencyMs = Date.now() - t0
        ok = h.kind === 'ok' && h.value.online
        detail = h.kind === 'ok' ? (h.value.online ? 'online' : 'card machine offline') : `${h.code}: ${h.message}`
      }
    }
    detail = scrubMessage(detail, 300)
    await prisma.posConnector.update({ where: { id: conn.row.id }, data: { lastTestAt: connectorNow(), lastTestOk: ok, lastTestDetail: detail } })
    invalidateConnector(tenantId, kind)
    return { ok, latencyMs, detail, ...(dryRun && { dryRun }) }
  })

  // POST /connectors/fiscal/go-live — the CEO only.
  fastify.post('/fiscal/go-live', { preHandler: requireAuth(...CEO) }, async (req) => {
    z.object({ confirm: z.literal('GO LIVE') }).parse(req.body)
    const tenantId = activeTenantId(req)
    const row = await ensureConnectorRow(tenantId, 'fiscal')
    const missing = await goLiveMissing(tenantId, row)
    if (missing.length > 0) throw new AppError('NOT_READY', 'The fiscal POS is not ready to go live', 409, { missing })
    const now = connectorNow()
    const updated = await prisma.posConnector.update({
      where: { id: row.id },
      data: { enabled: true, ...(!row.liveSince && { liveSince: now }), updatedById: req.staffUser!.id },
    })
    invalidateConnector(tenantId, 'fiscal')
    await audit({ category: 'identity', action: 'fiscal.go_live', entity: 'PosConnector', entityId: row.id, userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId, metadata: { driver: updated.driver, liveSince: updated.liveSince?.toISOString() ?? null, firstTime: !row.liveSince } })
    return viewOf(updated)
  })

  // POST /connectors/fiscal/switch-off — the CEO only.
  fastify.post('/fiscal/switch-off', { preHandler: requireAuth(...CEO) }, async (req) => {
    z.object({ confirm: z.literal('SWITCH OFF') }).parse(req.body)
    const tenantId = activeTenantId(req)
    const row = await ensureConnectorRow(tenantId, 'fiscal')
    const updated = await prisma.posConnector.update({ where: { id: row.id }, data: { enabled: false, updatedById: req.staffUser!.id } })
    invalidateConnector(tenantId, 'fiscal')
    await audit({ category: 'identity', action: 'fiscal.switch_off', entity: 'PosConnector', entityId: row.id, userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId, metadata: { driver: updated.driver } })
    return viewOf(updated)
  })

  // PUT /connectors/fiscal/reporting-required — §17.7, the CEO only, whole company.
  fastify.put('/fiscal/reporting-required', { preHandler: requireAuth(...CEO) }, async (req) => {
    const body = z.object({ required: z.boolean(), reason: z.string().trim().min(3).max(300) }).parse(req.body)
    const tenantId = activeTenantId(req)
    // A test company never files (lib/testCompany.ts): switching reporting
    // back ON is refused — turn test mode off on the company first.
    const testRefusal = () => new AppError('TEST_COMPANY_NO_FISCAL', 'This is a test company — its sales are never sent to FBR/SRB. Turn test mode off for the company first (Companies → edit) to make fiscal reporting required.', 409)
    if (body.required && await isTestTenant(tenantId, serviceClient)) throw testRefusal()
    return setFiscalReportingRequired(tenantId, body.required, { userId: req.staffUser!.id, userEmail: req.staffUser!.email, reason: body.reason }, {
      // Re-read under the connector lock (fr-3): a concurrent test-mode ON
      // takes the same lock, so it can never slip between check and write.
      underLock: async (tx) => {
        if (!body.required) return
        const t = await tx.tenant.findUnique({ where: { id: tenantId }, select: { isTest: true } })
        if (t?.isTest) throw testRefusal()
      },
    })
  })

  // PUT /connectors/fiscal/brand-pos-ids — writes the existing Concept columns.
  fastify.put('/fiscal/brand-pos-ids', { preHandler: requireAuth(...ADMINS) }, async (req) => {
    const body = z.object({
      items: z.array(z.object({
        conceptId: z.string().min(1).max(64),
        // Postgres INTEGER columns: a bigger number would fail the write as a 500.
        fbrPosId: z.number().int().positive().max(2147483647).nullable(),
        srbPosId: z.number().int().positive().max(2147483647).nullable(),
      })).max(100),
    }).parse(req.body)
    for (const it of body.items) await assertConceptOwned(req, it.conceptId, 'write')
    const changes: Array<{ conceptId: string; before: { fbrPosId: number | null; srbPosId: number | null }; after: { fbrPosId: number | null; srbPosId: number | null } }> = []
    for (const it of body.items) {
      const before = await prisma.concept.findUniqueOrThrow({ where: { id: it.conceptId }, select: { fbrPosId: true, srbPosId: true, tenantId: true } })
      await prisma.concept.update({ where: { id: it.conceptId }, data: { fbrPosId: it.fbrPosId, srbPosId: it.srbPosId } })
      changes.push({ conceptId: it.conceptId, before: { fbrPosId: before.fbrPosId, srbPosId: before.srbPosId }, after: { fbrPosId: it.fbrPosId, srbPosId: it.srbPosId } })
      await audit({
        category: 'identity', action: 'concept.pos_ids.update', entity: 'Concept', entityId: it.conceptId,
        userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId: before.tenantId,
        before: { fbrPosId: before.fbrPosId, srbPosId: before.srbPosId }, after: { fbrPosId: it.fbrPosId, srbPosId: it.srbPosId },
      })
    }
    return { updated: changes.length, items: changes.map((c) => ({ conceptId: c.conceptId, ...c.after })) }
  })

  // GET /connectors/fiscal/documents — the ACTIVE company only (the connector
  // belongs to one company; a portfolio view would mix two companies' outboxes
  // and counts on one page).
  fastify.get('/fiscal/documents', { preHandler: requireAuth(...VIEWERS) }, async (req) => {
    const q = docsQuery.parse(req.query)
    const tenantId = activeTenantId(req, 'the POS connector belongs to one company')
    if (q.conceptId) {
      const c = await prisma.concept.findFirst({ where: { id: q.conceptId, tenantId }, select: { id: true } })
      if (!c) throw new NotFoundError('Concept', q.conceptId)
    }
    const where: Prisma.FiscalDocumentWhereInput = {
      tenantId,
      ...(q.conceptId && { conceptId: q.conceptId }),
      ...(q.status && { status: q.status }),
      ...(q.kind && { kind: q.kind }),
      ...((q.from || q.to) && { createdAt: { ...(q.from && { gte: new Date(q.from) }), ...(q.to && { lte: new Date(q.to) }) } }),
      ...(q.q && { OR: [{ orderId: { endsWith: q.q.toLowerCase() } }, { fiscalNumber: { contains: q.q, mode: 'insensitive' } }] }),
    }
    const rows = await prisma.fiscalDocument.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
      ...(q.cursor && { cursor: { id: q.cursor }, skip: 1 }),
      select: {
        id: true, tenantId: true, kind: true, status: true, statusReason: true, orderId: true, conceptId: true, amountCents: true, attempts: true,
        fiscalNumber: true, authority: true, isTest: true, driver: true, lastErrorCode: true, lastError: true,
        createdAt: true, filedAt: true, nextAttemptAt: true,
      },
    })
    const page = rows.slice(0, q.limit)
    const concepts = await prisma.concept.findMany({ where: { id: { in: [...new Set(page.map((r) => r.conceptId))] } }, select: { id: true, name: true } })
    const names = new Map(concepts.map((c) => [c.id, c.name]))
    return {
      items: page.map((r) => ({
        ...r,
        orderRef: orderRefOf(r.orderId),
        brand: names.get(r.conceptId) ?? null,
        isTest: r.isTest || r.driver === 'test',
        createdAt: r.createdAt.toISOString(),
        filedAt: r.filedAt?.toISOString() ?? null,
        nextAttemptAt: r.nextAttemptAt.toISOString(),
      })),
      nextCursor: rows.length > q.limit ? page[page.length - 1]!.id : null,
      counts: await fiscalCounts([tenantId]),
    }
  })

  // POST /connectors/fiscal/documents/retry-failed — ACTIVE company.
  fastify.post('/fiscal/documents/retry-failed', { preHandler: requireAuth(...ADMINS) }, async (req) => {
    const tenantId = activeTenantId(req)
    const count = await retryFailedForTenant(tenantId)
    await audit({ category: 'identity', action: 'fiscal.retry_failed', entity: 'PosConnector', userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId, metadata: { count } })
    return { count }
  })

  // POST /connectors/fiscal/documents/release — ALL held of the ACTIVE company (optionally one brand). No date range, no skip.
  fastify.post('/fiscal/documents/release', { preHandler: requireAuth(...CEO) }, async (req) => {
    const body = z.object({ conceptId: z.string().min(1).max(64).optional() }).strict().parse(req.body ?? {})
    const tenantId = activeTenantId(req)
    if (body.conceptId) {
      const c = await prisma.concept.findFirst({ where: { id: body.conceptId, tenantId, deletedAt: null }, select: { id: true } })
      if (!c) throw new NotFoundError('Concept', body.conceptId)
    }
    const r = await releaseHeld(tenantId, { conceptId: body.conceptId ?? null })
    await audit({ category: 'identity', action: 'fiscal.release_held', entity: 'PosConnector', userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId, metadata: { conceptId: body.conceptId ?? null, ...r } })
    return r
  })

  // GET /connectors/fiscal/documents/:id
  fastify.get('/fiscal/documents/:id', { preHandler: requireAuth(...VIEWERS) }, async (req) => {
    const { id } = idParam.parse(req.params)
    const doc = await prisma.fiscalDocument.findFirst({
      where: { id, ...(await scopeTenantWhere(req, 'read')) },
      include: { attemptsLog: { orderBy: { createdAt: 'desc' }, take: 50 } },
    })
    if (!doc) throw new NotFoundError('Fiscal document', id)
    return { ...doc, orderRef: orderRefOf(doc.orderId), isTest: doc.isTest || doc.driver === 'test' }
  })

  // POST /connectors/fiscal/documents/:id/retry
  fastify.post('/fiscal/documents/:id/retry', { preHandler: requireAuth(...VIEWERS) }, async (req) => {
    const { id } = idParam.parse(req.params)
    const doc = await retryDocument(id, await scopeTenantWhere(req, 'write'))
    await audit({ category: 'identity', action: 'fiscal.retry', entity: 'FiscalDocument', entityId: id, userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId: doc.tenantId, metadata: { orderId: doc.orderId } })
    return { id: doc.id, status: doc.status }
  })

  // POST /connectors/fiscal/documents/:id/manual — record an out-of-band filing.
  fastify.post('/fiscal/documents/:id/manual', { preHandler: requireAuth(...ADMINS) }, async (req) => {
    const { id } = idParam.parse(req.params)
    const body = z.object({
      fiscalNumber: z.string().trim().min(1).max(64),
      authority: z.enum(AUTHORITIES),
      qrPayload: z.string().max(1000).optional(),
      verifyUrl: z.string().url().max(1000).optional(),
      note: z.string().max(500).optional(),
    }).parse(req.body)
    const doc = await recordManualFiling(id, await scopeTenantWhere(req, 'write'), {
      fiscalNumber: body.fiscalNumber, authority: body.authority, qrPayload: body.qrPayload ?? null, verifyUrl: body.verifyUrl ?? null, actorId: req.staffUser!.id,
    })
    await audit({
      category: 'identity', action: 'fiscal.manual_filed', entity: 'FiscalDocument', entityId: id, userId: req.staffUser!.id, userEmail: req.staffUser!.email, tenantId: doc.tenantId,
      metadata: { orderId: doc.orderId, fiscalNumber: body.fiscalNumber, authority: body.authority, note: body.note ?? null },
    })
    return { id: doc.id, status: doc.status, fiscalNumber: doc.fiscalNumber, authority: doc.authority }
  })

  // GET /connectors/terminal/charges — reconciliation list, ACTIVE company only.
  fastify.get('/terminal/charges', { preHandler: requireAuth(...VIEWERS) }, async (req) => {
    const q = z.object({
      status: z.enum(['pending', 'sent', 'approved', 'recorded', 'declined', 'cancel_requested', 'cancelled', 'expired', 'unknown', 'unverified', 'void_pending', 'voided', 'needs_attention', 'manual_resolved']).optional(),
      from: z.string().datetime({ offset: true }).optional(),
      to: z.string().datetime({ offset: true }).optional(),
      cursor: z.string().min(1).max(64).optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }).parse(req.query)
    const tenantId = activeTenantId(req, 'the POS connector belongs to one company')
    const rows = await prisma.terminalCharge.findMany({
      where: {
        tenantId,
        ...(q.status && { status: q.status }),
        ...((q.from || q.to) && { createdAt: { ...(q.from && { gte: new Date(q.from) }), ...(q.to && { lte: new Date(q.to) }) } }),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
      ...(q.cursor && { cursor: { id: q.cursor }, skip: 1 }),
    })
    const page = rows.slice(0, q.limit)
    return { items: await Promise.all(page.map(async (r) => ({ ...(await chargeView(r, { staff: true })), tenantId: r.tenantId }))), nextCursor: rows.length > q.limit ? page[page.length - 1]!.id : null }
  })

  // POST /connectors/terminal/test/simulate — test driver only; runs the webhook path.
  fastify.post('/terminal/test/simulate', { preHandler: requireAuth(...ADMINS) }, async (req) => {
    const body = z.object({ chargeId: z.string().min(1).max(64), outcome: z.enum(['approved', 'declined']) }).parse(req.body)
    const tenantId = activeTenantId(req)
    const conn = await getConnectorFresh(tenantId, 'terminal')
    if (conn.row.driver !== 'test') throw new AppError('NOT_TEST_DRIVER', 'Simulation only works with the test card machine driver', 409)
    const charge = await prisma.terminalCharge.findFirst({ where: { id: body.chargeId, tenantId } })
    if (!charge) throw new NotFoundError('Card charge', body.chargeId)
    const state = body.outcome === 'approved' ? testApproval(charge.id, charge.amountCents) : { state: 'declined' as const, reason: 'TEST_DECLINED' }
    const result = await handleInboundEvent(tenantId, { id: `sim_${randomBytes(6).toString('hex')}`, type: 'terminal.charge.updated', chargeId: charge.id, state }, 'simulate')
    const fresh = await prisma.terminalCharge.findUniqueOrThrow({ where: { id: charge.id } })
    return { result, charge: await chargeView(fresh, { staff: true }) }
  })
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function safe<T>(fn: () => Promise<T | { kind: 'transient'; code: string; message: string }>, budgetMs: number): Promise<T | { kind: 'transient'; code: string; message: string }> {
  try {
    return await withTimeout(fn(), budgetMs + 500, 'connector test')
  } catch (err) {
    return { kind: 'transient', code: 'TIMEOUT', message: scrubMessage(err) }
  }
}

function dryRunPayload(tenantId: string, brand: string, registrations: FiscalPayload['registrations']): FiscalPayload {
  const id = `test_${randomBytes(10).toString('hex')}`
  const now = new Date()
  // A synthetic PKR 100 cash sale at 15 %: 86.96 + 13.04. Never stored.
  return {
    version: 1,
    documentId: id,
    kind: 'sale',
    orderId: id,
    orderRef: 'DRYRUN',
    source: 'pos',
    issuedAt: isoPkt(now),
    currency: 'PKR',
    registrations,
    seller: { legalName: brand },
    buyer: null,
    lines: [{ lineId: 'dry-1', itemCode: 'DRYRUN', description: 'servd connector dry run', quantity: 1, unitPriceCents: 8696, grossCents: 8696, discountCents: 0, taxableCents: 8696, taxRatePct: 15, taxCents: 1304 }],
    totals: { saleValueCents: 8696, discountCents: 0, taxableCents: 8696, taxCents: 1304, taxRatePct: 15, serviceChargeCents: 0, tipCents: 0, totalCents: 10000 },
    payment: { mode: 'cash', tenders: [{ method: 'cash', amountCents: 10000 }] },
    test: true,
  }
}

/** Go-live readiness (spec §8.1): driver, a passing test in the last 10 min, every trading brand registered, legacy queues drained. */
export async function goLiveMissing(tenantId: string, row: PosConnector): Promise<string[]> {
  const missing: string[] = []
  if (row.driver === 'none' || !fiscalDriverOf(row.driver)) missing.push('Pick a fiscal POS driver')
  const tenMin = connectorNow().getTime() - 10 * 60_000
  if (!row.lastTestOk || !row.lastTestAt || row.lastTestAt.getTime() < tenMin) missing.push('Run "Test connection" successfully (within the last 10 minutes)')
  const since = new Date(connectorNow().getTime() - 30 * 86_400_000)
  const settings = parseFiscalSettings(row.settings)
  const trading = await prisma.concept.findMany({
    where: { tenantId, deletedAt: null, orders: { some: { createdAt: { gte: since } } } },
    select: { id: true, name: true, fbrPosId: true, srbPosId: true },
  })
  for (const c of trading) {
    const viaBrand = !!(c.fbrPosId || c.srbPosId)
    const viaOutlet = settings.outlets.some((o) => o.conceptId === c.id || o.conceptId === null)
    if (!viaBrand && !viaOutlet) missing.push(`Add the POS id for ${c.name}`)
  }
  const drained = await prisma.setting.findUnique({ where: { key: LEGACY_DRAIN_KEY }, select: { key: true } })
  if (!drained) missing.push('The old direct FBR/SRB queues have not been drained yet (deploy the connector release first)')
  return missing
}

