// /health checks for the POS connector (spec §8.4). Each is ok / warn / off —
// never fail: a fiscal POS or card machine being down must not mark the API
// unhealthy (sales keep working; filing catches up).
//
// Companies that do not report sales (§17.7) are never counted. They create no
// new documents; sales HELD before the CEO switched reporting off are kept
// (never skipped — there is no operator skip of a real sale) and shown on the
// connector page, but they are not a backlog to warn about (BOOKS-R2-02 /
// FOH-R2-02). Switched back on, they count again and release as usual.

import { prisma } from '../lib/prisma.js'
import { secretKeyConfigured } from '../lib/secretBox.js'
import { connectorNow } from './registry.js'
import { reportingRequiredOf } from './config.js'

/** Companies whose CEO switched "Fiscal reporting required" OFF. */
export async function reportingOffTenantIds(): Promise<string[]> {
  const rows = await prisma.posConnector.findMany({ where: { kind: 'fiscal' }, select: { tenantId: true, settings: true } })
  return rows.filter((r) => !reportingRequiredOf(r.settings)).map((r) => r.tenantId)
}

export type ConnectorCheck = 'ok' | 'warn' | 'off'

export interface ConnectorHealth {
  checks: { fiscalConnector: ConnectorCheck; cardTerminal: ConnectorCheck; connectorSecretKey: ConnectorCheck }
  details: Record<string, string>
}

export async function connectorHealthChecks(): Promise<ConnectorHealth> {
  const details: Record<string, string> = {}
  const checks: ConnectorHealth['checks'] = { fiscalConnector: 'off', cardTerminal: 'off', connectorSecretKey: 'off' }
  const now = connectorNow()

  // ── Fiscal ──
  try {
    const live = await prisma.posConnector.findMany({
      where: { kind: 'fiscal', enabled: true, driver: { not: 'none' } },
      select: { tenantId: true, driver: true, lastError: true, lastErrorAt: true },
    })
    const reasons: string[] = []
    const off = await reportingOffTenantIds()
    const notOff = off.length > 0 ? { tenantId: { notIn: off } } : {}
    const heldAll = await prisma.fiscalDocument.count({ where: { ...notOff, status: 'held' } })
    if (live.length > 0) {
      checks.fiscalConnector = 'ok'
      const liveIds = live.map((c) => c.tenantId)
      const scope = { tenantId: { in: liveIds } }
      const [held, stale, failed, manual] = await Promise.all([
        prisma.fiscalDocument.count({ where: { tenantId: { in: liveIds.filter((id) => !off.includes(id)) }, status: 'held' } }),
        prisma.fiscalDocument.count({ where: { ...scope, status: { in: ['pending', 'submitting'] }, createdAt: { lt: new Date(now.getTime() - 15 * 60_000) } } }),
        prisma.fiscalDocument.count({ where: { ...scope, status: { in: ['failed', 'rejected'] } } }),
        prisma.fiscalDocument.count({ where: { ...scope, status: 'manual_required' } }),
      ])
      if (held > 0) reasons.push(`${held} held (release them in Dev → API → POS connector)`)
      if (stale > 0) reasons.push(`${stale} not filed for 15+ min`)
      if (failed > 0) reasons.push(`${failed} failed or rejected`)
      if (manual > 0) reasons.push(`${manual} refunds to file by hand`)
      const hourAgo = now.getTime() - 3_600_000
      const auth = live.filter((c) => c.lastError?.startsWith('AUTH') && c.lastErrorAt && c.lastErrorAt.getTime() > hourAgo).length
      if (auth > 0) reasons.push(`${auth} compan${auth === 1 ? 'y' : 'ies'}: fiscal POS refused the API key`)
      const test = live.filter((c) => c.driver === 'test').length
      if (test > 0) reasons.push(`${test} compan${test === 1 ? 'y is' : 'ies are'} live on the TEST driver — nothing is really filed`)
      if (reasons.length > 0) checks.fiscalConnector = 'warn'
    }
    if (heldAll > 0) reasons.push(`${heldAll} sales held in total until go-live / registration`)
    details['fiscalConnector'] = reasons.length > 0 ? reasons.join('; ') : (live.length > 0 ? `${live.length} compan${live.length === 1 ? 'y' : 'ies'} live` : 'No company is live with a fiscal POS')
  } catch (err) {
    checks.fiscalConnector = 'warn'
    details['fiscalConnector'] = `check failed: ${(err as Error).message}`
  }

  // ── Card terminal ──
  try {
    const enabled = await prisma.posConnector.count({ where: { kind: 'terminal', enabled: true, driver: { not: 'none' } } })
    const [attention, unknown] = await Promise.all([
      prisma.terminalCharge.count({ where: { status: 'needs_attention' } }),
      prisma.terminalCharge.count({ where: { status: 'unknown', createdAt: { lt: new Date(now.getTime() - 10 * 60_000) } } }),
    ])
    if (enabled > 0 || attention > 0 || unknown > 0) checks.cardTerminal = 'ok'
    const reasons: string[] = []
    if (attention > 0) reasons.push(`${attention} card charge(s) need a manager`)
    if (unknown > 0) reasons.push(`${unknown} card charge(s) with an unknown outcome for 10+ min`)
    if (reasons.length > 0) checks.cardTerminal = 'warn'
    details['cardTerminal'] = reasons.length > 0 ? reasons.join('; ') : (enabled > 0 ? `${enabled} compan${enabled === 1 ? 'y' : 'ies'} with a card machine` : 'No card machine connected')
  } catch (err) {
    checks.cardTerminal = 'warn'
    details['cardTerminal'] = `check failed: ${(err as Error).message}`
  }

  // ── Secret key ──
  try {
    const encrypted = await prisma.posConnector.count({ where: { OR: [{ apiKeyEnc: { startsWith: 'enc:v1:' } }, { webhookSecretEnc: { startsWith: 'enc:v1:' } }] } })
      + await prisma.setting.count({ where: { value: { startsWith: 'enc:v1:' } } })
    if (secretKeyConfigured()) {
      checks.connectorSecretKey = 'ok'
      details['connectorSecretKey'] = 'SERVD_SECRET_KEY is set'
    } else if (encrypted > 0) {
      checks.connectorSecretKey = 'warn'
      details['connectorSecretKey'] = `${encrypted} stored secret(s) cannot be read — SERVD_SECRET_KEY is missing or invalid on this server`
    } else {
      details['connectorSecretKey'] = 'SERVD_SECRET_KEY not set (no connector secrets stored yet)'
    }
  } catch (err) {
    checks.connectorSecretKey = 'warn'
    details['connectorSecretKey'] = `check failed: ${(err as Error).message}`
  }

  return { checks, details }
}
