import { serviceClient as prisma } from './prisma.js'
import { decryptSecret, encryptSecret, isEncrypted, secretHint, secretKeyConfigured } from './secretBox.js'
import { isSandbox, practiceId, sandboxBlocks } from './sandbox.js'
import { testCompanyBlocks, testCompanyResult, type SendScope } from './outboundScope.js'

// WhatsApp delivery via the garibsons.app gateway (Hasham's connector — admin
// Dev → API → WhatsApp connector, /connectors/whatsapp).
//
// Simple HTTP API: POST { number, message } with an `x-api-key` header.
// Config comes from env (never hard-coded here):
//   WHATSAPP_API_URL  e.g. https://whatsapp.garibsons.app/webhook/<id>/send
//   WHATSAPP_API_KEY  the gateway API key (sk-…)
// In local dev these may be unset — sendText then throws and the OTP service
// (modules/auth/otp.ts) falls back to its dev-echo path.
//
// PLATFORM-WIDE ON PURPOSE (owner flag c, spec D14). GS Foods runs ONE gateway
// for every company: customer signup codes, staff sign-in codes, order
// messages and connector alerts all go out through the same sender number.
// The two values live in the `settings` table, which has no tenantId — they
// are deliberate platform rows, not a company's data, and the admin screen
// says so ("Platform-wide: one gateway for every company"). Per-company sender
// numbers are a later decision; when they come, they get their own
// tenant-scoped rows, not a tenantId bolted onto these two.

// Where the gateway settings come from, in order:
//
//   1. the `settings` table  — editable by the CEO / IT in admin
//   2. environment variables — the original mechanism, kept as a fallback
//
// The DB comes first on purpose. These two values being env-only meant the one
// person who needed to change them could not: customer signup, password reset
// and staff sign-in were all down together, the values were sitting in a
// browser tab, and the only way to apply them was a text editor on the
// Windows box. Config that the operator is expected to own should not need
// filesystem access to a server to change.
//
// The env vars still work and still win nothing — they are read only when the
// DB has no value — so existing deployments that set them keep working with no
// migration and no coordination.
//
// ENCRYPTION AT REST (spec D15). The stored key is `enc:v1:…` (lib/secretBox,
// SERVD_SECRET_KEY). A key saved before encryption existed is plaintext; it is
// re-encrypted the first time it is read on a server that has
// SERVD_SECRET_KEY (idempotent: a conditional update on the old value). On a
// server WITHOUT the key a plaintext key keeps working and /health warns
// (whatsappSecretHealth); an encrypted key there cannot be read, sending falls
// back to the WHATSAPP_API_KEY env (if any) and /health warns too.
// ROLLBACK: an image older than this one sends the stored value verbatim, i.e.
// the ciphertext, so after rolling back the key must be re-entered in the old
// /configuration/whatsapp screen (docs/TAX_SETUP.md §4 step 0, CLAUDE.md).
export const WA_URL_KEY = 'integrations.whatsapp.apiUrl'
export const WA_KEY_KEY = 'integrations.whatsapp.apiKey'

// Cached because sendText runs on the OTP path, and a DB round-trip per
// message for a value that changes once a year is a poor trade. Short enough
// that saving in admin takes effect without a restart.
const CACHE_MS = 30_000
let cache: { url: string; key: string; at: number } | null = null

/** Drop the cache so a save in admin takes effect immediately. */
export function invalidateWhatsappConfig(): void {
  cache = null
}

/** How the stored (database) key is held. 'none' = no stored key. */
export type WhatsappKeyAtRest = 'none' | 'encrypted' | 'plaintext' | 'unreadable'

interface StoredKey { plain: string; atRest: WhatsappKeyAtRest }

/**
 * Turn the raw `settings` value into the usable key, re-encrypting a legacy
 * plaintext key when SERVD_SECRET_KEY is available. Never throws.
 */
async function resolveStoredKey(raw: string): Promise<StoredKey> {
  const value = raw.trim()
  if (!value) return { plain: '', atRest: 'none' }
  if (isEncrypted(value)) {
    try {
      return { plain: decryptSecret(value).trim(), atRest: 'encrypted' }
    } catch {
      // Key missing or wrong: the stored value is useless here. Never send the
      // ciphertext as an API key — report it instead (/health).
      return { plain: '', atRest: 'unreadable' }
    }
  }
  if (!secretKeyConfigured()) return { plain: value, atRest: 'plaintext' }
  try {
    const enc = encryptSecret(value)
    // Conditional on the value we read, so two processes racing this both end
    // with one encrypted row and a concurrent save in admin is never undone.
    await prisma.setting.updateMany({ where: { key: WA_KEY_KEY, value: raw }, data: { value: enc } })
    return { plain: value, atRest: 'encrypted' }
  } catch {
    // Could not write it back (DB blip): still usable as plaintext this time;
    // the next read tries again.
    return { plain: value, atRest: 'plaintext' }
  }
}

async function readDb(): Promise<{ url: string; rawKey: string } | null> {
  try {
    const rows = await prisma.setting.findMany({ where: { key: { in: [WA_URL_KEY, WA_KEY_KEY] } } })
    let url = ''
    let rawKey = ''
    for (const r of rows) {
      if (r.key === WA_URL_KEY) url = r.value.trim()
      if (r.key === WA_KEY_KEY) rawKey = r.value
    }
    return { url, rawKey }
  } catch {
    return null
  }
}

async function config(): Promise<{ url: string; key: string }> {
  if (cache && Date.now() - cache.at < CACHE_MS) return { url: cache.url, key: cache.key }

  let dbUrl = ''
  let dbKey = ''
  // A database that cannot be read is not a reason to stop sending: fall
  // through to the environment, which is what every deployment had before.
  const db = await readDb()
  if (db) {
    dbUrl = db.url
    dbKey = (await resolveStoredKey(db.rawKey)).plain
  }

  const url = dbUrl || (process.env['WHATSAPP_API_URL'] ?? '').trim()
  const key = dbKey || (process.env['WHATSAPP_API_KEY'] ?? '').trim()
  cache = { url, key, at: Date.now() }
  return { url, key }
}

/** Is a gateway configured at all? Used by /health and by the admin screen. */
export async function whatsappConfigured(): Promise<boolean> {
  if (isSandbox()) return true // practice copy: send() answers a practice result
  const { url } = await config()
  return url.length > 0
}

/**
 * What the admin screen shows (GET /auth/integrations/whatsapp). Never the key
 * itself — a hint (first 4 + last 4) so the screen can show which one is saved.
 */
export async function whatsappSettingsView(): Promise<{
  apiUrl: string
  apiKeyHint: string
  keyAtRest: WhatsappKeyAtRest
  source: 'database' | 'environment' | 'unset'
  configured: boolean
  scope: 'platform'
}> {
  const db = (await readDb()) ?? { url: '', rawKey: '' }
  const stored = await resolveStoredKey(db.rawKey)
  // Where the value in force actually comes from — without this the screen
  // cannot explain why sending works when both fields look empty.
  const envUrl = (process.env['WHATSAPP_API_URL'] ?? '').trim()
  const envKey = (process.env['WHATSAPP_API_KEY'] ?? '').trim()
  const apiKeyHint = stored.atRest === 'unreadable'
    ? 'saved, but unreadable on this server (SERVD_SECRET_KEY missing)'
    : stored.plain ? secretHint(stored.plain) : (envKey ? 'set in environment' : '')
  return {
    apiUrl: db.url,
    apiKeyHint,
    keyAtRest: stored.atRest,
    source: db.url || db.rawKey.trim() ? 'database' : (envUrl || envKey ? 'environment' : 'unset'),
    configured: Boolean(db.url || envUrl),
    scope: 'platform',
  }
}

/**
 * Save the gateway settings (PUT /auth/integrations/whatsapp). `apiKey`
 * undefined leaves the stored key alone; '' clears it (falls back to env).
 * A non-empty key is encrypted — without SERVD_SECRET_KEY this throws 503
 * SECRET_KEY_MISSING before anything is written.
 */
export async function saveWhatsappSettings(input: { apiUrl: string; apiKey?: string }): Promise<void> {
  const url = input.apiUrl.trim()
  const key = input.apiKey?.trim()
  // Encrypt first so a missing SERVD_SECRET_KEY refuses the whole save.
  const keyValue = key === undefined ? undefined : (key ? encryptSecret(key) : '')
  await prisma.$transaction([
    prisma.setting.upsert({ where: { key: WA_URL_KEY }, create: { key: WA_URL_KEY, value: url }, update: { value: url } }),
    ...(keyValue === undefined ? [] : [
      prisma.setting.upsert({ where: { key: WA_KEY_KEY }, create: { key: WA_KEY_KEY, value: keyValue }, update: { value: keyValue } }),
    ]),
  ])
  invalidateWhatsappConfig()
}

/**
 * /health: is the gateway key held safely? ok = encrypted (or none stored);
 * warn = plaintext at rest without SERVD_SECRET_KEY, or an encrypted key this
 * server cannot read; off = no key stored in the database. Never 'error' —
 * whether sending works is customerSignup / staffCodeLogin's job.
 */
export async function whatsappSecretHealth(): Promise<{ check: 'ok' | 'warn' | 'off'; detail: string }> {
  const db = await readDb()
  if (!db) return { check: 'warn', detail: 'Could not read the WhatsApp gateway settings.' }
  const stored = await resolveStoredKey(db.rawKey)
  switch (stored.atRest) {
    case 'none': return { check: 'off', detail: 'No WhatsApp key stored in the database (environment or unset).' }
    case 'encrypted': return { check: 'ok', detail: 'WhatsApp gateway key is encrypted at rest.' }
    case 'plaintext': return { check: 'warn', detail: 'The WhatsApp gateway key is stored in plain text because SERVD_SECRET_KEY is not set on this server. Set it and the key is encrypted on the next read.' }
    case 'unreadable': return { check: 'warn', detail: 'The stored WhatsApp gateway key is encrypted but SERVD_SECRET_KEY is missing or wrong on this server, so it cannot be used. Sending falls back to WHATSAPP_API_KEY, if set.' }
  }
}

// Core send. `number` is digits-only E.164 without the + (e.g. 923001234567).
async function send(number: string, message: string, scope?: SendScope | null) {
  // Practice copy: never the gateway (the copied settings hold the real URL).
  if (sandboxBlocks('whatsapp', { to: number, summary: `${message.length} chars` })) return { id: practiceId(), practice: true }
  // A test company never messages a customer (staff codes pass no scope).
  if (await testCompanyBlocks('whatsapp', scope)) return testCompanyResult()
  const { url, key } = await config()
  if (!url) throw new Error('WhatsApp gateway not configured (set it in admin → Dev → API → WhatsApp connector)')
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({ number, message }),
  })
  if (!res.ok) {
    const err = await res.text().catch(() => '')
    throw new Error(`WhatsApp gateway error ${res.status}: ${err}`)
  }
  return res.json().catch(() => ({}))
}

export type { SendScope }

/** `scope` names the company and audience — every customer send passes `{ tenantId, audience: 'customer' }`. */
export async function sendText(to: string, text: string, scope?: SendScope | null) {
  return send(to, text, scope)
}

// The gateway is text-only, so the interactive helpers degrade to a readable
// plain-text rendering (the WhatsApp bot still works, just without tap buttons).
export async function sendInteractiveList(
  to: string,
  headerText: string,
  bodyText: string,
  _buttonLabel: string,
  sections: Array<{ title: string; rows: Array<{ id: string; title: string; description?: string }> }>,
  scope?: SendScope | null,
) {
  // Rows are numbered across sections in order, so a customer on the text-only
  // gateway can reply with the number (adapters/whatsapp matchOption reads it).
  const lines = [headerText, '', bodyText, '']
  let n = 0
  for (const s of sections) {
    lines.push(s.title)
    for (const r of s.rows) lines.push(`${++n}. ${r.title}${r.description ? ` — ${r.description}` : ''}`)
    lines.push('')
  }
  return send(to, lines.join('\n').trim(), scope)
}

export async function sendButtons(
  to: string,
  bodyText: string,
  buttons: Array<{ id: string; title: string }>,
  scope?: SendScope | null,
) {
  const lines = [bodyText, '', ...buttons.map((b, i) => `${i + 1}. ${b.title}`)]
  return send(to, lines.join('\n'), scope)
}
