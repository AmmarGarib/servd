// THE writer of a company's POS connector configuration (D1/D3 B4).
//
// Extracted from PUT /connectors/:kind so the IT change requests
// (changeRequests.ts) apply exactly the same rules when the CEO — or a live
// Dev hand-over — approves one:
//   - the same row lock (SELECT … FOR UPDATE, W1-R10) and read-modify-write;
//   - the same validation (known driver, SSRF guard on the base URL, the
//     settings schemas, outlets / brands / card machines of THIS company only);
//   - secrets sealed with lib/secretBox.ts (503 SECRET_KEY_MISSING without
//     SERVD_SECRET_KEY), stored only as ciphertext + a hint;
//   - a LIVE fiscal connector refuses a driver or address change (409
//     SWITCH_OFF_FIRST: the CEO switches off, IT changes it, the CEO goes live
//     again);
//   - `enabled` is ignored for fiscal (go-live / switch-off are the CEO's own
//     routes), and the company's "Fiscal reporting required" switch is kept
//     exactly as stored.
//
// Usage (both callers):
//   const prepared = await prepareConnectorConfig(tenantId, kind, body)   // outside any transaction (DNS)
//   const out = await prisma.$transaction((tx) => applyConnectorConfig(tx, tenantId, kind, body, actor, prepared))
//   invalidateConnector(tenantId, kind) — then audit.

import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import type { Prisma, PosConnector } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { AppError } from '../../lib/errors.js'
import { encryptSecret, secretHint } from '../../lib/secretBox.js'
import type { ConnectorKindT } from '../../connectors/types.js'
import {
  assertUrlAllowed, fiscalSettingsSchema, terminalSettingsSchema, parseFiscalSettings, parseTerminalSettings, parseRaastSettings,
  terminalEntrySchema,
} from '../../connectors/config.js'
import { ensureConnectorRow, isKnownDriver } from '../../connectors/registry.js'
import { practiceConnectorRow } from '../../lib/sandbox.js'

type Tx = Prisma.TransactionClient

// ─── The view (never a secret) ────────────────────────────────────────────────

export function webhookUrl(token: string): string {
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

export function viewOf(row: PosConnector): ConnectorView {
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

// ─── Schemas ─────────────────────────────────────────────────────────────────

/** The PUT /connectors/:kind body. */
export const putBody = z.object({
  driver: z.string().min(1).max(40).optional(),
  baseUrl: z.string().max(500).optional(),
  apiKey: z.string().max(1000).optional(),
  webhookSecret: z.string().max(1000).optional(),
  regenerateWebhookSecret: z.boolean().optional(),
  enabled: z.boolean().optional(),
  settings: z.record(z.unknown()).optional(),
}).strict()
export type ConnectorConfigBody = z.infer<typeof putBody>

export const fiscalSettingsPatch = fiscalSettingsSchema.partial().strict()
export const terminalSettingsPatch = terminalSettingsSchema.partial().extend({
  terminals: z.array(terminalEntrySchema.extend({ id: z.string().min(1).max(64).optional() })).max(100).optional(),
}).strict()

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? { ...(v as Record<string, unknown>) } : {}
}

/** The connector row, locked for the rest of the transaction (read-modify-write of its settings). */
export async function lockConnectorTx(tx: Tx, id: string): Promise<PosConnector> {
  await tx.$queryRaw`SELECT id FROM pos_connectors WHERE id = ${id} FOR UPDATE`
  return tx.posConnector.findUniqueOrThrow({ where: { id } })
}

/** The saved form of a base URL (as assertUrlAllowed returns it), without any DNS — for the early live check only. */
function looseUrl(raw: string): string | null {
  const v = raw.trim()
  if (!v) return null
  try { return new URL(v).toString().replace(/\/+$/, '') } catch { return v }
}

export function switchOffFirst(what: string): AppError {
  return new AppError('SWITCH_OFF_FIRST', `The fiscal POS is live — the CEO switches it off before ${what} can be changed, and goes live again after a successful test`, 409)
}

async function locationsOfCompany(tenantId: string, ids: string[], db: Tx | typeof prisma = prisma): Promise<Set<string>> {
  if (ids.length === 0) return new Set()
  const rows = await db.location.findMany({ where: { id: { in: ids }, tenantId, deletedAt: null }, select: { id: true } })
  return new Set(rows.map((r) => r.id))
}

function notInCompany(what: string): AppError {
  return new AppError('NOT_IN_COMPANY', `${what} does not belong to this company`, 422)
}

// ─── Prepare (outside the transaction) + apply (inside it) ───────────────────

export interface PreparedConnectorConfig {
  /** The company's connector row (created lazily, as GET does). */
  connectorId: string
  /** The SSRF-checked base URL (null = none given / cleared). */
  checkedUrl: string | null
}

/**
 * Before the transaction: seed the row, refuse early on a live fiscal
 * connector (re-checked under the lock), and run the SSRF guard (DNS) on a
 * new base URL — never inside a transaction holding the row lock.
 */
export async function prepareConnectorConfig(tenantId: string, kind: ConnectorKindT, body: ConnectorConfigBody): Promise<PreparedConnectorConfig> {
  const seeded = await ensureConnectorRow(tenantId, kind)
  if (kind === 'fiscal' && seeded.enabled) {
    if (body.driver !== undefined && body.driver !== seeded.driver) throw switchOffFirst('the fiscal POS driver')
    if (body.baseUrl !== undefined && looseUrl(body.baseUrl) !== seeded.baseUrl) throw switchOffFirst('the fiscal POS address')
  }
  const checkedUrl = body.baseUrl !== undefined && body.baseUrl.trim() ? await assertUrlAllowed(body.baseUrl) : null
  return { connectorId: seeded.id, checkedUrl }
}

export interface ApplyConnectorResult {
  /** The row as it was, read under the lock. */
  row: PosConnector
  updated: PosConnector
  changed: string[]
  /** Only on regenerateWebhookSecret (PUT) — returned once, never stored in clear. */
  newWebhookSecret?: string
}

/**
 * Apply a configuration body to the company's connector inside `tx`, under
 * the row lock. Throws (rolling the caller's transaction back) on every
 * refusal PUT /connectors/:kind gives. `prepared` comes from
 * prepareConnectorConfig; without it the row must already exist and a new
 * base URL is SSRF-checked here.
 */
export async function applyConnectorConfig(
  tx: Tx,
  tenantId: string,
  kind: ConnectorKindT,
  body: ConnectorConfigBody,
  actor: { userId: string },
  prepared?: PreparedConnectorConfig,
): Promise<ApplyConnectorResult> {
  let connectorId = prepared?.connectorId
  if (!connectorId) {
    const found = await tx.posConnector.findUnique({ where: { tenantId_kind: { tenantId, kind } }, select: { id: true } })
    if (!found) throw new AppError('CONNECTOR_MISSING', 'The connector row does not exist yet — open the POS connector page first', 409)
    connectorId = found.id
  }
  const checkedUrl = prepared
    ? prepared.checkedUrl
    : (body.baseUrl !== undefined && body.baseUrl.trim() ? await assertUrlAllowed(body.baseUrl) : null)

  const row = await lockConnectorTx(tx, connectorId)
  if (row.tenantId !== tenantId || row.kind !== kind) throw new AppError('CONNECTOR_MISMATCH', 'The connector does not belong to this company', 409)
  const data: Prisma.PosConnectorUpdateInput = {}
  const changed: string[] = []
  let newWebhookSecret: string | undefined

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
      const prev = parseFiscalSettings(stored)
      const next = fiscalSettingsSchema.parse({ ...prev, ...patch })
      // SRB direct (2026-10-30): the POS user and the Test / Live switch decide where and how
      // servd files — like the driver and address, never changed on a LIVE connector.
      if (row.enabled && (next.srb?.posUser !== prev.srb?.posUser || (next.srb?.live ?? false) !== (prev.srb?.live ?? false))) {
        throw switchOffFirst('the SRB POS user or Test / Live mode')
      }
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

  data.updatedById = actor.userId
  const updated = await tx.posConnector.update({ where: { id: row.id }, data })
  return { row, updated, changed, ...(newWebhookSecret && { newWebhookSecret }) }
}
