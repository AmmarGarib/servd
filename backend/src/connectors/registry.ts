// POS connector — the driver registry and the per-company connector rows
// (spec §3, D1, D2).
//
// One PosConnector row per company per kind (fiscal / terminal / raast). Rows are
// created lazily as driver 'none', disabled, with a random webhook token.
// A real vendor is one file in drivers/ plus one line in each map below.

import { randomBytes } from 'node:crypto'
import { Prisma, type PosConnector } from '@prisma/client'
import { prisma } from '../lib/prisma.js'
import { decryptSecret } from '../lib/secretBox.js'
import type { ConnectorCtx, ConnectorKindT, FiscalDriver, FiscalSettings, RaastDriver, RaastSettings, TerminalDriver, TerminalSettings } from './types.js'
import { parseFiscalSettings, parseRaastSettings, parseTerminalSettings } from './config.js'
import { testFiscalDriver, testTerminalDriver } from './drivers/test.js'
import { httpFiscalDriver, httpTerminalDriver } from './drivers/http.js'

export const FISCAL_DRIVERS: Readonly<Record<string, FiscalDriver>> = {
  test: testFiscalDriver,
  http: httpFiscalDriver,
}

export const TERMINAL_DRIVERS: Readonly<Record<string, TerminalDriver>> = {
  test: testTerminalDriver,
  http: httpTerminalDriver,
}

/**
 * Raast QR (2026-10-12, spec D6): a future bank / aggregator API (dynamic QR
 * with the bill reference, a 'raast.credit' webhook) is one file in drivers/
 * plus one line here. v1 registers none — bank-SMS matching needs no driver
 * (PosConnector(raast).driver stays 'none'; `enabled` = SMS matching ON).
 */
export const RAAST_DRIVERS: Readonly<Record<string, RaastDriver>> = {}

export function raastDriverOf(id: string | null | undefined): RaastDriver | null {
  return id && Object.prototype.hasOwnProperty.call(RAAST_DRIVERS, id) ? RAAST_DRIVERS[id]! : null
}

export function fiscalDriverOf(id: string | null | undefined): FiscalDriver | null {
  return id && Object.prototype.hasOwnProperty.call(FISCAL_DRIVERS, id) ? FISCAL_DRIVERS[id]! : null
}

export function terminalDriverOf(id: string | null | undefined): TerminalDriver | null {
  return id && Object.prototype.hasOwnProperty.call(TERMINAL_DRIVERS, id) ? TERMINAL_DRIVERS[id]! : null
}

export function isKnownDriver(kind: ConnectorKindT, id: string): boolean {
  if (id === 'none') return true
  if (kind === 'fiscal') return !!fiscalDriverOf(id)
  if (kind === 'terminal') return !!terminalDriverOf(id)
  return !!raastDriverOf(id)
}

export interface DriverInfo {
  kind: ConnectorKindT
  id: string
  label: string
  needs: { baseUrl: boolean; apiKey: boolean; webhookSecret: boolean }
}

export function listDrivers(): DriverInfo[] {
  const none = { label: 'None (off)', needs: { baseUrl: false, apiKey: false, webhookSecret: false } }
  return [
    { kind: 'fiscal', id: 'none', ...none },
    ...Object.values(FISCAL_DRIVERS).map((d) => ({ kind: 'fiscal' as const, id: d.id, label: d.label, needs: d.needs })),
    { kind: 'terminal', id: 'none', ...none },
    ...Object.values(TERMINAL_DRIVERS).map((d) => ({ kind: 'terminal' as const, id: d.id, label: d.label, needs: d.needs })),
    { kind: 'raast', id: 'none', label: 'Bank SMS from the counter phone', needs: none.needs },
    ...Object.values(RAAST_DRIVERS).map((d) => ({ kind: 'raast' as const, id: d.id, label: d.label, needs: d.needs })),
  ]
}

// ─── Clock (injectable for tests) ─────────────────────────────────────────────

let clockOverride: (() => Date) | null = null

/** The connector's notion of "now" (ctx.now, backoff, leases' due checks in JS). */
export function connectorNow(): Date {
  return clockOverride ? clockOverride() : new Date()
}

/** Tests only: replace the connector clock (null restores the real one). */
export function setConnectorClock(fn: (() => Date) | null): void {
  clockOverride = fn
}

// ─── Rows ─────────────────────────────────────────────────────────────────────

export interface LoadedConnector {
  row: PosConnector
  kind: ConnectorKindT
  apiKey: string | null
  webhookSecret: string | null
  /** Decrypt failure (missing / wrong SERVD_SECRET_KEY) — the connector cannot authenticate. */
  secretError: string | null
  fiscalSettings: FiscalSettings
  terminalSettings: TerminalSettings
  /** kind 'raast' only meaningful; always parsed (lenient) so callers never see a raw blob. */
  raastSettings: RaastSettings
}

const CACHE_TTL_MS = 30_000
const cache = new Map<string, { at: number; value: LoadedConnector }>()

export function newWebhookToken(): string {
  return randomBytes(32).toString('hex')
}

function load(row: PosConnector): LoadedConnector {
  let apiKey: string | null = null
  let webhookSecret: string | null = null
  let secretError: string | null = null
  try {
    apiKey = row.apiKeyEnc ? decryptSecret(row.apiKeyEnc) : null
    webhookSecret = row.webhookSecretEnc ? decryptSecret(row.webhookSecretEnc) : null
  } catch (err) {
    secretError = (err as Error).message
  }
  return {
    row,
    kind: row.kind,
    apiKey,
    webhookSecret,
    secretError,
    fiscalSettings: parseFiscalSettings(row.settings),
    terminalSettings: parseTerminalSettings(row.settings),
    raastSettings: parseRaastSettings(row.settings),
  }
}

/** The company's connector row for `kind`, created lazily (driver none, off). Never cached. */
export async function ensureConnectorRow(tenantId: string, kind: ConnectorKindT): Promise<PosConnector> {
  const existing = await prisma.posConnector.findUnique({ where: { tenantId_kind: { tenantId, kind } } })
  if (existing) return existing
  try {
    return await prisma.posConnector.create({
      data: { tenantId, kind, driver: 'none', enabled: false, webhookToken: newWebhookToken(), settings: {} },
    })
  } catch (err) {
    // Two first reads at once: the loser reads the winner's row.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return prisma.posConnector.findUniqueOrThrow({ where: { tenantId_kind: { tenantId, kind } } })
    }
    throw err
  }
}

/** Loaded (decrypted) connector, cached per company + kind for 30 s. */
export async function getConnector(tenantId: string, kind: ConnectorKindT): Promise<LoadedConnector> {
  const key = `${tenantId}:${kind}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value
  const value = load(await ensureConnectorRow(tenantId, kind))
  cache.set(key, { at: Date.now(), value })
  return value
}

/** Fresh read (no cache) — for the sender, which must see a switch-off at once. */
export async function getConnectorFresh(tenantId: string, kind: ConnectorKindT): Promise<LoadedConnector> {
  const value = load(await ensureConnectorRow(tenantId, kind))
  cache.set(`${tenantId}:${kind}`, { at: Date.now(), value })
  return value
}

export function invalidateConnector(tenantId: string, kind: ConnectorKindT): void {
  cache.delete(`${tenantId}:${kind}`)
}

/** Tests only. */
export function clearConnectorCache(): void {
  cache.clear()
}

/** A ConnectorCtx bounded by `budgetMs` (AbortSignal.timeout). */
export function buildCtx(c: LoadedConnector, budgetMs: number, log?: ConnectorCtx['log']): ConnectorCtx {
  return {
    tenantId: c.row.tenantId,
    connectorId: c.row.id,
    driver: c.row.driver,
    isTest: c.row.driver === 'test',
    baseUrl: c.row.baseUrl,
    apiKey: c.apiKey,
    webhookSecret: c.webhookSecret,
    settings: c.kind === 'fiscal' ? c.fiscalSettings : c.kind === 'raast' ? c.raastSettings : c.terminalSettings,
    signal: AbortSignal.timeout(Math.max(1, Math.round(budgetMs))),
    now: connectorNow,
    log: log ?? ((obj, msg) => console.info(`[connector:${c.kind}] ${msg}`, obj)),
  }
}
