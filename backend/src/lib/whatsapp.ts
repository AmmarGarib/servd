// WhatsApp delivery via the garibsons.app gateway.
//
// Simple HTTP API: POST { number, message } with an `x-api-key` header.
// Config comes from env (never hard-coded here):
//   WHATSAPP_API_URL  e.g. https://whatsapp.garibsons.app/webhook/<id>/send
//   WHATSAPP_API_KEY  the gateway API key (sk-…)
// In local dev these may be unset — sendText then throws and the OTP service
// (modules/auth/otp.ts) falls back to its dev-echo path.

function apiUrl() {
  return process.env['WHATSAPP_API_URL'] ?? ''
}
function apiKey() {
  return process.env['WHATSAPP_API_KEY'] ?? ''
}

// Core send. `number` is digits-only E.164 without the + (e.g. 923001234567).
async function send(number: string, message: string) {
  const url = apiUrl()
  if (!url) throw new Error('WHATSAPP_API_URL not configured')
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey() },
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
