// Practice copy ("sandbox") mode — env SERVD_SANDBOX=1 on the API.
//
// A practice copy is a separate servd (its own admin + API addresses, its own
// database branched from the real one, its own Redis and secrets) where staff
// try anything. Its database starts as a COPY OF REAL DATA — real customers'
// phones and emails, real staff, suppliers, sales and connector settings — so
// in this mode nothing may reach the outside world: no WhatsApp / email /
// push, no fiscal filing, no card machine or payment gateway, no webhooks out,
// no social posts, no Raast bank-SMS effects, no uploads into the live bucket.
//
// Every outbound edge asks `sandboxBlocks(kind, …)` first. On live servd
// (SERVD_SANDBOX unset) it is `false` with no side effect, so live behaviour is
// unchanged. In the practice copy it is `true`, after logging ONE line
// ('[sandbox] blocked <kind> …') and recording the effect in an in-memory ring
// of the last 200 (time, kind, a masked summary). Never a message body, a code,
// a link or a full phone number / email — they hold OTPs and customer data.
//
// Messaging edges RESOLVE with a practice result instead of throwing: OTP,
// procurement (SEND_FAILED) and notify treat a failed send as an error, and a
// practice copy must let every flow run to the end.
//
// The fiscal POS and the card machine use the built-in TEST drivers
// (`practiceConnectorRow`): no network, TEST- numbers, receipts say
// "TEST — NOT A FISCAL INVOICE". connectors/drivers/http.ts refuses as a
// backstop.
//
// Login codes: the practice copy hands back the code it would have sent
// (`practiceCode`) ONLY where the caller has already proven who they are —
// the 2FA code after a correct password (POST /auth/login) and the 2FA
// enrolment code to the signed-in user (POST /auth/2fa/start). A code asked
// for by an UNAUTHENTICATED caller who only names a phone or an email (floor
// staff code sign-in, password reset, rider and customer codes) is never
// echoed: that would let anyone who knows a staff member's number or address
// sign in as them on a server full of real data. The ways in that need no
// message already exist: a manager's "Sign-in code" (POST
// /auth/staff/:id/sign-in-code) and an admin's password reissue (POST
// /auth/users/:id/reissue-password). Password reset answers 503
// RESET_UNAVAILABLE in the practice copy.

import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { PosConnector } from '@prisma/client'
import { AppError } from './errors.js'

export type SandboxKind =
  | 'whatsapp'
  | 'email'
  | 'push'
  | 'webhook'
  | 'social'
  | 'payment'
  | 'raast_sms'
  | 'raast_token'
  | 'storage'
  | 'whatsapp_probe'
  | 'password_reset'
  | 'worker'

/** Is this server a practice copy? Read on every call (cheap; tests flip it). */
export function isSandbox(): boolean {
  return process.env['SERVD_SANDBOX'] === '1'
}

export interface BlockedEffect {
  at: string
  kind: SandboxKind
  /** Masked: last 4 digits of a phone, `s***@domain` for an email, a count or an event name. */
  summary: string
}

const RING_SIZE = 200
const ring: BlockedEffect[] = []
let blockedTotal = 0

/** `…4567` for a phone, `s***@example.com` for an email. */
function maskRecipient(raw: string): string {
  const s = raw.trim()
  if (s.includes('@')) {
    const [local = '', domain = ''] = s.split('@')
    return `${local.slice(0, 1) || '?'}***@${domain || '?'}`
  }
  const digits = s.replace(/\D/g, '')
  return digits.length >= 4 ? `…${digits.slice(-4)}` : '…'
}

/**
 * The guard every outbound edge calls. Live: false, nothing recorded. Practice
 * copy: true, one log line and one ring entry. `summary` must never carry a
 * message body or code — callers pass a length, a count or an event name; runs
 * of 5+ digits are blanked anyway in case one slips through.
 */
export function sandboxBlocks(kind: SandboxKind, detail?: { to?: string | null; summary?: string }): boolean {
  if (!isSandbox()) return false
  const parts: string[] = []
  if (detail?.to) parts.push(`to ${maskRecipient(detail.to)}`)
  if (detail?.summary) parts.push(detail.summary.replace(/\s+/g, ' ').replace(/\d{5,}/g, '…').slice(0, 120))
  const summary = parts.join(', ')
  blockedTotal++
  ring.push({ at: new Date().toISOString(), kind, summary })
  if (ring.length > RING_SIZE) ring.shift()
  console.info(`[sandbox] blocked ${kind}${summary ? ` (${summary})` : ''}`)
  return true
}

/** The last 200 blocked effects, newest first. */
export function recentlyBlocked(): BlockedEffect[] {
  return ring.slice().reverse()
}

/** Blocked effects since this process started (not capped at the ring size). */
export function sandboxBlockedCount(): number {
  return blockedTotal
}

/** Tests only. */
export function resetSandboxLog(): void {
  ring.length = 0
  blockedTotal = 0
}

/** The id a practice send reports instead of a provider's. */
export function practiceId(): string {
  return `sandbox-${randomBytes(6).toString('hex')}`
}

export const PRACTICE_NOTE = 'Practice copy: nothing was sent'

/**
 * `{ practiceCode }` in the practice copy, `{}` on live servd — spread into a
 * response so a live response is exactly what it was. Only for callers who
 * have already proven who they are (see the header).
 */
export function practiceCodeField(code: string | null | undefined): { practiceCode?: string } {
  return isSandbox() && code ? { practiceCode: code } : {}
}

/** /health additions: `{ sandbox: true, sandboxBlocked }` in the practice copy, `{}` live. */
export function sandboxHealthFields(): { sandbox?: true; sandboxBlocked?: number } {
  return isSandbox() ? { sandbox: true, sandboxBlocked: blockedTotal } : {}
}

/**
 * The POS connector as the practice copy sees it: a row that names a real
 * vendor driver ('http', later '<vendor>') is presented as the built-in TEST
 * driver with no address and no secrets, so every fiscal and card-machine path
 * (sender, sweeper, reconciler, till, receipts, connector test, the admin
 * connector page) runs on the test driver. 'none' and 'test' rows, and every
 * row on live servd, pass through untouched. The stored row is never changed.
 */
export function practiceConnectorRow(row: PosConnector): PosConnector {
  if (!isSandbox() || row.driver === 'none' || row.driver === 'test') return row
  return { ...row, driver: 'test', baseUrl: null, apiKeyEnc: null, apiKeyHint: null, webhookSecretEnc: null, webhookSecretHint: null }
}

/** The live media bucket(s): 'servd-media' (the code default) plus SERVD_LIVE_R2_BUCKET if named. */
function liveBuckets(): Set<string> {
  const named = (process.env['SERVD_LIVE_R2_BUCKET'] ?? '').trim()
  return new Set(['servd-media', ...(named ? [named] : [])])
}

/**
 * Upload key for the presigner. Live: unchanged. Practice copy: prefixed
 * `sandbox/`, and refused (503 STORAGE_NOT_CONFIGURED) while the bucket is the
 * live one — the practice copy needs its own R2 bucket.
 */
export function sandboxUploadKey(key: string, bucket: string): string {
  if (!isSandbox()) return key
  if (!bucket || liveBuckets().has(bucket)) {
    sandboxBlocks('storage', { summary: 'upload to the live bucket refused' })
    throw new AppError(
      'STORAGE_NOT_CONFIGURED',
      'Practice copy: uploads need the practice bucket. Ask IT to set R2_BUCKET_NAME (and R2_PUBLIC_URL) to the practice copy’s own bucket.',
      503,
    )
  }
  return `sandbox/${key}`
}

function hostOf(url: string | undefined): string | null {
  if (!url) return null
  try { return new URL(url).hostname.toLowerCase() || null } catch { return null }
}

/**
 * Boot check, before anything else runs. Refuses to start when SERVD_SANDBOX
 * holds anything but '1' / '0' / 'false' / unset (a box meant to be a practice
 * copy that is not in practice mode would message real customers), and — in
 * the practice copy — when DATABASE_URL or REDIS_URL points at a host listed in
 * SERVD_PROD_HOSTS (comma-separated live hostnames). Sharing live Redis would
 * let LIVE workers run practice jobs with live connectors.
 */
export function assertSandboxBoot(env: NodeJS.ProcessEnv = process.env): void {
  const raw = (env['SERVD_SANDBOX'] ?? '').trim()
  if (raw === '' || raw === '0' || raw.toLowerCase() === 'false') return
  if (raw !== '1') {
    throw new Error(`SERVD_SANDBOX must be '1' (practice copy) or unset, not '${raw}'. Refusing to start.`)
  }
  const prodHosts = (env['SERVD_PROD_HOSTS'] ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  for (const name of ['DATABASE_URL', 'REDIS_URL'] as const) {
    const host = hostOf(env[name])
    if (host && prodHosts.includes(host)) {
      throw new Error(`Practice copy refused to start: ${name} points at a live host (${host}). Give the practice copy its own database branch and Redis.`)
    }
  }
  if (prodHosts.length === 0) {
    console.warn('[sandbox] SERVD_PROD_HOSTS is not set, so the boot check cannot tell the live database / Redis from the practice ones.')
  }
  console.warn('[sandbox] PRACTICE COPY: messages, fiscal filing, card payments, webhooks, social posts and live-bucket uploads are blocked.')
}

/** GET /api/v1/meta/sandbox (no auth) → { sandbox }. */
export async function sandboxMetaRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/sandbox', async () => ({ sandbox: isSandbox() }))
}
