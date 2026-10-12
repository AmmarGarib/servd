// POS connector alerts (spec §9.3, D16).
//
// An alert is an ExceptionFlag in the company's owner Inbox plus a
// best-effort WhatsApp notice to the people who can fix it:
//   fiscal   → active users of the company with role admin / it
//   terminal → active users of the company with role admin / foh_management
// Messages name the cause AND the fix. Deduped per entity through the row's
// own alertedAt, so a document retried 60 times raises one flag.
//
// The connector's exception kinds are written as plain strings
// (ExceptionFlag.kind is a String column) through this typed helper, so the
// shared ExceptionKind union in lib/exceptions.ts can gain them separately.

import type { ExceptionSeverity } from '@prisma/client'
import { prisma } from '../lib/prisma.js'

export type ConnectorExceptionKind =
  | 'fiscal_failed'
  | 'fiscal_rejected'
  | 'fiscal_auth'
  | 'fiscal_manual_refund'
  | 'terminal_void_failed'
  | 'terminal_unreconciled'

export interface ConnectorFlagInput {
  tenantId: string
  kind: ConnectorExceptionKind
  severity: ExceptionSeverity
  title: string
  description: string
  entityType: 'FiscalDocument' | 'TerminalCharge' | 'PosConnector'
  entityId: string
  conceptId?: string | null
  amountCents?: number | null
  metadata?: Record<string, string | number | boolean | null>
}

/** Write the ExceptionFlag. Never throws: an alert must not break the flow that raised it. */
export async function flagConnectorException(input: ConnectorFlagInput): Promise<{ id: string } | null> {
  try {
    return await prisma.exceptionFlag.create({
      data: {
        tenantId: input.tenantId,
        kind: input.kind,
        severity: input.severity,
        title: input.title,
        description: input.description,
        entityType: input.entityType,
        entityId: input.entityId,
        conceptId: input.conceptId ?? null,
        amountCents: input.amountCents ?? null,
        ...(input.metadata && { metadata: input.metadata }),
      },
      select: { id: true },
    })
  } catch (err) {
    console.warn(`[connectors] flag ${input.kind} failed:`, (err as Error).message)
    return null
  }
}

const FISCAL_ROLES = ['admin', 'it'] as const
const TERMINAL_ROLES = ['admin', 'foh_management'] as const

/** WhatsApp the company's people who can fix it. Best effort, never throws, never awaited by money paths. */
export async function notifyConnectorPeople(tenantId: string, audience: 'fiscal' | 'terminal', text: string): Promise<number> {
  try {
    const roles = audience === 'fiscal' ? [...FISCAL_ROLES] : [...TERMINAL_ROLES]
    const users = await prisma.user.findMany({
      where: {
        role: { in: roles },
        isActive: true,
        accountStatus: 'active',
        deletedAt: null,
        phone: { not: null },
        OR: [{ tenantId }, { tenantMemberships: { some: { tenantId } } }],
      },
      select: { phone: true },
      take: 20,
    })
    if (users.length === 0) return 0
    const { sendText } = await import('../lib/whatsapp.js')
    let sent = 0
    for (const u of users) {
      const to = (u.phone ?? '').replace(/\D/g, '')
      if (!to) continue
      try { await sendText(to, text); sent++ } catch { /* gateway down — the Inbox flag still stands */ }
    }
    return sent
  } catch (err) {
    console.warn('[connectors] notify failed:', (err as Error).message)
    return 0
  }
}

/**
 * Claim the alert for a fiscal document (alertedAt null → now) and raise it.
 * Returns false when it had already been alerted (dedupe across retries and
 * processes).
 */
export async function alertFiscalDocument(doc: { id: string; tenantId: string; conceptId: string; amountCents: number }, kind: ConnectorExceptionKind, severity: ExceptionSeverity, title: string, description: string, opts: { notify?: boolean } = {}): Promise<boolean> {
  const claimed = await prisma.fiscalDocument.updateMany({ where: { id: doc.id, tenantId: doc.tenantId, alertedAt: null }, data: { alertedAt: new Date() } })
  if (claimed.count === 0) return false
  await flagConnectorException({
    tenantId: doc.tenantId, kind, severity, title, description,
    entityType: 'FiscalDocument', entityId: doc.id, conceptId: doc.conceptId, amountCents: doc.amountCents,
  })
  if (opts.notify !== false) void notifyConnectorPeople(doc.tenantId, 'fiscal', `servd: ${title}. ${description}`)
  return true
}

/** Same for a card-machine charge. */
export async function alertTerminalCharge(charge: { id: string; tenantId: string; amountCents: number }, kind: ConnectorExceptionKind, title: string, description: string): Promise<boolean> {
  const claimed = await prisma.terminalCharge.updateMany({ where: { id: charge.id, tenantId: charge.tenantId, alertedAt: null }, data: { alertedAt: new Date() } })
  if (claimed.count === 0) return false
  await flagConnectorException({
    tenantId: charge.tenantId, kind, severity: 'high', title, description,
    entityType: 'TerminalCharge', entityId: charge.id, amountCents: charge.amountCents,
  })
  void notifyConnectorPeople(charge.tenantId, 'terminal', `servd: ${title}. ${description}`)
  return true
}

// Per-company "at most once per hour" for the AUTH alert. In-process memory
// plus the connector's lastErrorAt (set by the sender) keeps it to one per
// hour even across restarts in practice; the flag itself is the record.
const lastAuthAlert = new Map<string, number>()

export async function alertFiscalAuth(tenantId: string, connectorId: string, message: string, now: Date): Promise<boolean> {
  const last = lastAuthAlert.get(tenantId) ?? 0
  if (now.getTime() - last < 3_600_000) return false
  const recent = await prisma.exceptionFlag.findFirst({
    where: { tenantId, kind: 'fiscal_auth', createdAt: { gte: new Date(now.getTime() - 3_600_000) } },
    select: { id: true },
  })
  lastAuthAlert.set(tenantId, now.getTime())
  if (recent) return false
  await flagConnectorException({
    tenantId, kind: 'fiscal_auth', severity: 'high',
    title: 'Fiscal POS refused servd\'s API key',
    description: `The fiscal POS answered "${message}". Sales are queued, nothing is lost. Fix: paste the current key in Dev → API → POS connector.`,
    entityType: 'PosConnector', entityId: connectorId,
  })
  void notifyConnectorPeople(tenantId, 'fiscal', 'servd: the fiscal POS refused the API key. Sales are queued, nothing is lost. Paste the current key in Dev → API → POS connector.')
  return true
}

/** Tests only. */
export function resetAlertMemory(): void {
  lastAuthAlert.clear()
}
