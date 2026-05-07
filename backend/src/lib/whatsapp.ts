// Meta WhatsApp Business Cloud API client

const BASE = 'https://graph.facebook.com/v19.0'

function token() {
  return process.env['WHATSAPP_TOKEN'] ?? ''
}

function phoneNumberId() {
  return process.env['WHATSAPP_PHONE_NUMBER_ID'] ?? ''
}

async function post(path: string, body: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`WhatsApp API error ${res.status}: ${err}`)
  }
  return res.json()
}

export async function sendText(to: string, text: string) {
  return post(`/${phoneNumberId()}/messages`, {
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body: text },
  })
}

export async function sendInteractiveList(
  to: string,
  headerText: string,
  bodyText: string,
  buttonLabel: string,
  sections: Array<{ title: string; rows: Array<{ id: string; title: string; description?: string }> }>,
) {
  return post(`/${phoneNumberId()}/messages`, {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      header: { type: 'text', text: headerText },
      body: { text: bodyText },
      action: { button: buttonLabel, sections },
    },
  })
}

export async function sendButtons(
  to: string,
  bodyText: string,
  buttons: Array<{ id: string; title: string }>,
) {
  return post(`/${phoneNumberId()}/messages`, {
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: bodyText },
      action: {
        buttons: buttons.map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title } })),
      },
    },
  })
}
