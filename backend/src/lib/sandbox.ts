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
// RESET_UNAVAILABLE in the practice copy, and every route that would SEND a
// code to a typed phone / email answers 503 OTP_UNAVAILABLE up front
// (`refuseCodeRequestInPractice`) instead of "a code is on its way".
//
// Who can reach it: the practice copy holds real personal data and echoes the
// 2FA code, so it must sit behind Cloudflare Access (both addresses). In
// production the API refuses to start without the Access settings and refuses
// every request that did not come through Access (`registerPracticeAccessGuard`).
// Its CORS / socket allowlist is its own admin only (`practiceOriginAllowed`).
//
// The copied data: on the first boot of each copy, `sandboxScrub` rotates the
// copied POS-connector webhook tokens and switches off the copied bank-SMS
// devices, outbound webhooks, push tokens and stored gateway / social / SMTP
// credentials (marker setting `sandbox.scrubbedAt`, which a Neon "Reset from
// parent" wipes, so a fresh copy is scrubbed again).

import { createPublicKey, randomBytes, type JsonWebKey, type KeyObject } from 'node:crypto'
import jwt from 'jsonwebtoken'
import type { FastifyInstance } from 'fastify'
import type { PosConnector } from '@prisma/client'
import { AppError } from './errors.js'
import { isInternalRequest } from './internalRequest.js'

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
  | 'geocode'

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
 * row on live servd, pass through untouched. sandboxScrub also writes the
 * same change to the copied rows once, at the first practice boot; this
 * runtime view still covers a row added or edited after that.
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
  // NOT trimmed: this judges the very string isSandbox() reads (=== '1'). A
  // '1 ' or '1\r' (a CRLF .env) used to pass here as the practice copy while
  // isSandbox() said live — every guard off, on copied live data.
  const raw = env['SERVD_SANDBOX'] ?? ''
  if (raw === '' || raw === '0' || raw.toLowerCase() === 'false') return
  if (raw !== '1') {
    throw new Error(`SERVD_SANDBOX must be exactly '1' (practice copy) or unset, not ${JSON.stringify(raw)}. Refusing to start.`)
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
  // A practice copy on the internet without Cloudflare Access would hand a
  // 2FA code to anyone holding a leaked live password (the code is echoed).
  if (env['NODE_ENV'] === 'production') {
    const access = accessConfig(env)
    if (!access) {
      throw new Error(`Practice copy refused to start: ${ACCESS_TEAM_ENV} and ${ACCESS_AUD_ENV} must be set (Cloudflare Access in front of the practice copy, SETUP.md step 2).`)
    }
    if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(access.team)) {
      throw new Error(`Practice copy refused to start: ${ACCESS_TEAM_ENV} must be the Zero Trust team domain, <team>.cloudflareaccess.com (got '${access.team}').`)
    }
  }
  console.warn('[sandbox] PRACTICE COPY: messages, fiscal filing, card payments, webhooks, social posts and live-bucket uploads are blocked.')
}

/** GET /api/v1/meta/sandbox (no auth) → { sandbox }. */
export async function sandboxMetaRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/sandbox', async () => ({ sandbox: isSandbox() }))
}

// ── Code requests ────────────────────────────────────────────────────────────

const CODE_REFUSALS = {
  staff: 'Practice copy: sign-in codes are not sent here. Ask a manager for a sign-in code (Workforce, "Sign-in code" next to your name) and enter it here.',
  customer: 'Practice copy: codes and sign-in links are not sent here, so customer sign-up and contact checks are switched off.',
  rider: 'Practice copy: rider sign-in codes are not sent here.',
  waitlist: 'Practice copy: codes are not sent here, so the waitlist is switched off.',
} as const

/**
 * First line of every route that would SEND a code or a sign-in link to a
 * typed phone / email: floor-staff code sign-in, customer sign-up, contact
 * check and magic link, rider sign-in, waitlist. The practice copy blocks the
 * send, so "a code is on its way" would leave someone waiting for nothing:
 * refuse with 503 OTP_UNAVAILABLE before any lookup — the same answer for
 * every number, so it says nothing about who is staff. Live: returns.
 */
export function refuseCodeRequestInPractice(who: keyof typeof CODE_REFUSALS): void {
  if (isSandbox()) throw new AppError('OTP_UNAVAILABLE', CODE_REFUSALS[who], 503)
}

// ── Browser origins ──────────────────────────────────────────────────────────

const normOrigin = (v: string): string => v.trim().replace(/\/+$/, '').toLowerCase()

/**
 * The practice copy's CORS + socket.io origin check (corsAllowlist.ts asks
 * this instead of the live allowlist when `isSandbox()`): its OWN admin
 * (WEB_URL) only — never live servd's admin, storefront or brand sites, which
 * the live allowlist trusts. No Origin (server-to-server, the healthcheck)
 * passes, as on live.
 */
export function practiceOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return true
  const own = normOrigin(process.env['WEB_URL'] ?? '')
  return own !== '' && normOrigin(origin) === own
}

// ── Cloudflare Access in front of the practice copy ─────────────────────────

/** The Zero Trust team domain, `<team>.cloudflareaccess.com`. */
const ACCESS_TEAM_ENV = 'SERVD_SANDBOX_ACCESS_TEAM'
/** The Access application's Application Audience (AUD) tag. */
const ACCESS_AUD_ENV = 'SERVD_SANDBOX_ACCESS_AUD'

interface AccessConfig { team: string; aud: string }

function accessConfig(env: NodeJS.ProcessEnv = process.env): AccessConfig | null {
  const team = (env[ACCESS_TEAM_ENV] ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '')
  const aud = (env[ACCESS_AUD_ENV] ?? '').trim()
  return team && aud ? { team, aud } : null
}

const ACCESS_KEYS_TTL_MS = 60 * 60 * 1000
const ACCESS_KEYS_REFETCH_MS = 30 * 1000
let accessKeys: { team: string; at: number; keys: Map<string, KeyObject> } | null = null
let accessKeysFetchedAt = 0

/**
 * The team's public signing key `kid`: cached for an hour; an unknown kid (a
 * rotation) or an expired cache refetches at most every 30 s. A read-only GET
 * of PUBLIC keys — nothing about the practice copy is sent. If the fetch
 * fails, a key already held keeps working.
 */
async function accessKey(team: string, kid: string): Promise<KeyObject | null> {
  const held = accessKeys?.team === team ? accessKeys : null
  if (held && Date.now() - held.at < ACCESS_KEYS_TTL_MS && held.keys.has(kid)) return held.keys.get(kid)!
  if (Date.now() - accessKeysFetchedAt < ACCESS_KEYS_REFETCH_MS) return held?.keys.get(kid) ?? null
  accessKeysFetchedAt = Date.now()
  try {
    const res = await fetch(`https://${team}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = (await res.json()) as { keys?: Array<JsonWebKey & { kid?: string }> }
    const keys = new Map<string, KeyObject>()
    for (const k of body.keys ?? []) {
      if (!k.kid || k.kty !== 'RSA') continue
      try { keys.set(k.kid, createPublicKey({ key: k, format: 'jwk' })) } catch { /* not a usable key */ }
    }
    accessKeys = { team, at: Date.now(), keys }
    return keys.get(kid) ?? null
  } catch (err) {
    console.warn(`[sandbox] could not read the Cloudflare Access keys: ${(err as Error).message}`)
    return held?.keys.get(kid) ?? null
  }
}

/** Tests only. */
export function resetAccessKeyCache(): void {
  accessKeys = null
  accessKeysFetchedAt = 0
}

/**
 * Is `token` a Cloudflare Access token for this practice copy? RS256, signed
 * by one of the team's keys, this application's audience, the team as issuer,
 * not expired.
 */
export async function verifyAccessToken(token: string, cfg: AccessConfig | null = accessConfig()): Promise<boolean> {
  if (!cfg) return false
  const decoded = jwt.decode(token, { complete: true })
  const kid = decoded?.header.kid
  if (!decoded || decoded.header.alg !== 'RS256' || !kid) return false
  const key = await accessKey(cfg.team, kid)
  if (!key) return false
  try {
    jwt.verify(token, key, { algorithms: ['RS256'], audience: cfg.aud, issuer: `https://${cfg.team}` })
    return true
  } catch {
    return false
  }
}

/**
 * Practice copy only: every request that came in from the internet must carry
 * a valid Cloudflare Access token (Cf-Access-Jwt-Assertion, added by Access
 * after its own sign-in). A missing or broken Access setup then CLOSES the
 * practice copy, instead of opening a copy of real data — and its 2FA echo —
 * to anyone holding a leaked password, with a login rate limit of its own.
 * Exempt: CORS preflights (Access passes them to the origin without a token)
 * and requests from inside the practice network with no forwarding headers
 * (the container healthcheck). Live: not registered. Without the Access
 * settings (development, tests — production refuses to boot without them)
 * nothing is checked.
 */
export function registerPracticeAccessGuard(fastify: FastifyInstance): void {
  if (!isSandbox()) return
  const cfg = accessConfig()
  if (!cfg) {
    console.warn(`[sandbox] ${ACCESS_TEAM_ENV} / ${ACCESS_AUD_ENV} are not set: requests are NOT checked for Cloudflare Access.`)
    return
  }
  fastify.addHook('onRequest', async (req) => {
    if (req.method === 'OPTIONS' || isInternalRequest(req)) return
    const token = req.headers['cf-access-jwt-assertion']
    if (typeof token === 'string' && token !== '' && (await verifyAccessToken(token, cfg))) return
    throw new AppError('ACCESS_REQUIRED', 'Practice copy: sign in through Cloudflare Access first. Open this address in your browser, sign in, then try again.', 403)
  })
}

// ── The copied live data ─────────────────────────────────────────────────────

/** Set once a copy has been scrubbed. A Neon "Reset from parent" wipes it. */
export const SANDBOX_SCRUB_KEY = 'sandbox.scrubbedAt'

/**
 * Stored credentials copied from live: the Facebook / Instagram page, the
 * WhatsApp gateway (lib/whatsapp.ts WA_URL_KEY / WA_KEY_KEY) and the SMTP
 * login (lib/mailer.ts SMTP_USER_KEY / SMTP_PASS_KEY). Literal here: those
 * modules import this one.
 */
const SCRUBBED_SETTINGS = [
  'fb_page_id', 'fb_page_name', 'fb_page_token', 'ig_user_id',
  'integrations.whatsapp.apiUrl', 'integrations.whatsapp.apiKey',
  'integrations.smtp.user', 'integrations.smtp.pass',
]

export interface SandboxScrubResult {
  connectorTokens: number
  /** Copied vendor POS connectors ('http', '<vendor>') turned into the built-in test driver, address and secrets gone. */
  vendorConnectors: number
  /** Copied outbound webhook subscriptions given a fresh random signing secret. */
  webhookSecrets: number
  smsDevices: number
  webhooks: number
  pushTokens: number
  settings: number
}

/**
 * Practice copy, at boot before the API listens, once per copy of the data:
 * every POS connector gets a NEW webhook token (the admin connector page shows
 * it, and the copied one is live's), a copied VENDOR connector ('http',
 * '<vendor>') becomes the built-in test driver with no address and no secrets
 * (what practiceConnectorRow already shows at runtime — now true in the
 * database too, so even an API image without practice mode pointed at this
 * copy has no real card machine or fiscal POS to call), the copied outbound
 * webhooks get a fresh signing secret, the copied bank-SMS counter phones,
 * outbound webhooks and push tokens are switched off, and the stored gateway /
 * social / SMTP credentials are deleted. The outbound edges are blocked anyway
 * (`sandboxBlocks`); this keeps live's identifiers and credentials out of the
 * practice copy's screens and database. Every step is idempotent; the marker
 * is written last, so an interrupted scrub runs again on the next boot.
 * Returns null when nothing ran (live, or this copy is already scrubbed).
 */
export async function sandboxScrub(): Promise<SandboxScrubResult | null> {
  if (!isSandbox()) return null
  const { serviceClient: db } = await import('./prisma.js')
  if (await db.setting.findUnique({ where: { key: SANDBOX_SCRUB_KEY }, select: { key: true } })) return null
  const { newWebhookToken } = await import('../connectors/registry.js')

  const connectors = await db.posConnector.findMany({ select: { id: true } })
  for (const c of connectors) {
    await db.posConnector.update({ where: { id: c.id }, data: { webhookToken: newWebhookToken() } })
  }
  const vendors = await db.posConnector.updateMany({
    where: { driver: { notIn: ['none', 'test'] } },
    data: { driver: 'test', baseUrl: null, apiKeyEnc: null, apiKeyHint: null, webhookSecretEnc: null, webhookSecretHint: null },
  })
  const subscriptions = await db.webhookSubscription.findMany({ select: { id: true } })
  for (const w of subscriptions) {
    await db.webhookSubscription.update({ where: { id: w.id }, data: { secret: randomBytes(32).toString('hex') } })
  }
  const now = new Date()
  const sms = await db.bankSmsDevice.updateMany({ where: { active: true }, data: { active: false } })
  const hooks = await db.webhookSubscription.updateMany({ where: { isActive: true }, data: { isActive: false } })
  const push = await db.expoPushToken.updateMany({ where: { revokedAt: null }, data: { revokedAt: now } })
  const settings = await db.setting.deleteMany({ where: { key: { in: SCRUBBED_SETTINGS } } })
  await db.setting.upsert({
    where: { key: SANDBOX_SCRUB_KEY },
    create: { key: SANDBOX_SCRUB_KEY, value: now.toISOString() },
    update: { value: now.toISOString() },
  })

  const result: SandboxScrubResult = {
    connectorTokens: connectors.length,
    vendorConnectors: vendors.count,
    webhookSecrets: subscriptions.length,
    smsDevices: sms.count,
    webhooks: hooks.count,
    pushTokens: push.count,
    settings: settings.count,
  }
  console.warn(
    `[sandbox] scrubbed the copied live data: ${result.connectorTokens} connector webhook token(s) rotated, ` +
    `${result.vendorConnectors} vendor connector(s) set to the test driver, ${result.webhookSecrets} webhook secret(s) replaced, ` +
    `${result.smsDevices} bank-SMS phone(s), ${result.webhooks} webhook(s) and ${result.pushTokens} push token(s) switched off, ` +
    `${result.settings} stored credential(s) deleted`,
  )
  return result
}
