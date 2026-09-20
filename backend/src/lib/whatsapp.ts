import { serviceClient as prisma } from './prisma.js'

// WhatsApp delivery via the garibsons.app gateway.
//
// Simple HTTP API: POST { number, message } with an `x-api-key` header.
// Config comes from env (never hard-coded here):
//   WHATSAPP_API_URL  e.g. https://whatsapp.garibsons.app/webhook/<id>/send
//   WHATSAPP_API_KEY  the gateway API key (sk-…)
// In local dev these may be unset — sendText then throws and the OTP service
// (modules/auth/otp.ts) falls back to its dev-echo path.

// Where the gateway settings come from, in order:
//
//   1. the `settings` table  — editable by the CEO in admin
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

async function config(): Promise<{ url: string; key: string }> {
  if (cache && Date.now() - cache.at < CACHE_MS) return { url: cache.url, key: cache.key }

  let dbUrl = ''
  let dbKey = ''
  try {
    const rows = await prisma.setting.findMany({ where: { key: { in: [WA_URL_KEY, WA_KEY_KEY] } } })
    for (const r of rows) {
      if (r.key === WA_URL_KEY) dbUrl = r.value.trim()
      if (r.key === WA_KEY_KEY) dbKey = r.value.trim()
    }
  } catch {
    // A database that cannot be read is not a reason to stop sending: fall
    // through to the environment, which is what every deployment had before.
  }

  const url = dbUrl || (process.env['WHATSAPP_API_URL'] ?? '').trim()
  const key = dbKey || (process.env['WHATSAPP_API_KEY'] ?? '').trim()
  cache = { url, key, at: Date.now() }
  return { url, key }
}

/** Is a gateway configured at all? Used by /health and by the admin screen. */
export async function whatsappConfigured(): Promise<boolean> {
  const { url } = await config()
  return url.length > 0
}

// Core send. `number` is digits-only E.164 without the + (e.g. 923001234567).
async function send(number: string, message: string) {
  const { url, key } = await config()
  if (!url) throw new Error('WhatsApp gateway not configured (set it in admin → Configuration → WhatsApp)')
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

export async function sendText(to: string, text: string) {
  return send(to, text)
}

// The gateway is text-only, so the interactive helpers degrade to a readable
// plain-text rendering (the WhatsApp bot still works, just without tap buttons).
export async function sendInteractiveList(
  to: string,
  headerText: string,
  bodyText: string,
  _buttonLabel: string,
  sections: Array<{ title: string; rows: Array<{ id: string; title: string; description?: string }> }>,
) {
  const lines = [headerText, '', bodyText, '']
  for (const s of sections) {
    lines.push(s.title)
    for (const r of s.rows) lines.push(`• ${r.title}${r.description ? ` — ${r.description}` : ''}`)
    lines.push('')
  }
  return send(to, lines.join('\n').trim())
}

export async function sendButtons(
  to: string,
  bodyText: string,
  buttons: Array<{ id: string; title: string }>,
) {
  const lines = [bodyText, '', ...buttons.map((b, i) => `${i + 1}. ${b.title}`)]
  return send(to, lines.join('\n'))
}
