// Bank-SMS forwarding devices (spec §6.7, D5, amendment S2).
//
// A device is a counter phone (with the SIM the bank texts) running an SMS
// forwarder app that POSTs each bank SMS to servd. It authenticates with a
// bearer token `sms_<64 hex>`:
//   - stored as a SHA-256 lookup hash (BankSmsDevice.tokenHash — a credential,
//     globally unique like PosConnector.webhookToken) plus secretBox
//     ciphertext (tokenEnc, so the CEO can reveal it once more) and a hint;
//   - shown ONCE when created or rotated; rotating kills the old token;
//   - checked for its format before any database lookup (a garbage token
//     costs nothing).
// A device belongs to ONE company (its raast PosConnector's) and optionally
// one of that company's outlets.

import { createHash, randomBytes } from 'node:crypto'
import type { BankSmsDevice } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { encryptSecret, secretHint } from '../../lib/secretBox.js'

export const DEVICE_TOKEN_RE = /^sms_[0-9a-f]{64}$/

/** A new device token: 'sms_' + 32 random bytes in hex. */
export function newDeviceToken(): string {
  return `sms_${randomBytes(32).toString('hex')}`
}

/** The lookup hash of a device token (sha256 hex). */
export function hashDeviceToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** The cheap format check done before any DB lookup. */
export function isDeviceTokenShape(token: string | null | undefined): token is string {
  return typeof token === 'string' && DEVICE_TOKEN_RE.test(token)
}

/** What to store for a token: hash, ciphertext (503 SECRET_KEY_MISSING without SERVD_SECRET_KEY) and hint. */
export function tokenColumns(token: string): { tokenHash: string; tokenEnc: string; tokenHint: string } {
  return { tokenHash: hashDeviceToken(token), tokenEnc: encryptSecret(token), tokenHint: secretHint(token) }
}

/**
 * The ACTIVE device for a bearer token, or null (bad shape, unknown, inactive,
 * or its connector is not the company's raast connector). Never says why.
 */
export async function deviceByToken(token: string | null | undefined): Promise<BankSmsDevice | null> {
  if (!isDeviceTokenShape(token)) return null
  const d = await prisma.bankSmsDevice.findUnique({ where: { tokenHash: hashDeviceToken(token) } })
  if (!d || !d.active) return null
  const conn = await prisma.posConnector.findUnique({ where: { id: d.connectorId }, select: { tenantId: true, kind: true } })
  if (!conn || conn.kind !== 'raast' || conn.tenantId !== d.tenantId) return null
  return d
}

export interface DeviceView {
  id: string
  label: string
  locationId: string | null
  active: boolean
  allowPathToken: boolean
  tokenHint: string
  lastSeenAt: string | null
  lastSmsAt: string | null
  ignoredCount: number
  lastIgnoredAt: string | null
  rotatedAt: string | null
  createdAt: string
}

export function deviceView(d: BankSmsDevice): DeviceView {
  return {
    id: d.id,
    label: d.label,
    locationId: d.locationId,
    active: d.active,
    allowPathToken: d.allowPathToken,
    tokenHint: d.tokenHint,
    lastSeenAt: d.lastSeenAt?.toISOString() ?? null,
    lastSmsAt: d.lastSmsAt?.toISOString() ?? null,
    ignoredCount: d.ignoredCount,
    lastIgnoredAt: d.lastIgnoredAt?.toISOString() ?? null,
    rotatedAt: d.rotatedAt?.toISOString() ?? null,
    createdAt: d.createdAt.toISOString(),
  }
}

function apiBase(): string {
  return (process.env['API_URL'] ?? 'https://api.servd.pk').replace(/\/+$/, '')
}

/** Where the forwarder posts (header auth — preferred). */
export function smsPostUrl(): string {
  return `${apiBase()}/api/v1/webhooks/pos/sms`
}

/**
 * How the forwarder authenticates — returned ONCE with a new / rotated token.
 * The path-token URL is offered only when the device allows it (a token in a
 * URL lands in request logs; S2).
 */
export function forwarderSetup(token: string, allowPathToken: boolean): { postUrl: string; header: string; pathUrl: string | null } {
  return {
    postUrl: smsPostUrl(),
    header: `Authorization: Bearer ${token}`,
    pathUrl: allowPathToken ? `${smsPostUrl()}/${token}` : null,
  }
}
