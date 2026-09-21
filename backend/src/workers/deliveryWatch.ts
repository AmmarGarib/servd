// Delivery watchdog — notice the codes stopping before a customer does.
//
// WHY THIS EXISTS. Customer signup, password reset and staff sign-in all hang
// off one WhatsApp gateway, and that gateway is a linked WhatsApp Web session.
// Those sessions drop: if the phone goes offline long enough, or WhatsApp logs
// the device out, the client goes back to INITIALIZING and every code stops.
// It has already happened — two of the six clients on the gateway are sitting
// in that state right now.
//
// When it happened last, /health had been reporting the outage the whole time
// and nobody was reading /health. The way it got found was the CEO trying to
// sign up and failing. That is the gap this closes.
//
// WHAT MAKES AN ALERT USEFUL. "Signup is down" is not actionable — the operator
// already knew something was wrong, that is why they are reading the message.
// So this names the CAUSE and the FIX, because there are only three and each
// has a different thirty-second remedy:
//
//   session dropped    → re-scan the QR on the gateway page (needs the phone)
//   key rejected       → paste the current key into admin → Configuration
//   gateway unreachable→ the gateway host itself is down; not a servd problem
//
// DELIVERY. The obvious trap is alerting about a broken channel THROUGH the
// broken channel. So it tries every channel it has and settles for whichever
// lands; if none do, the state is still recorded and the admin dashboard shows
// it on next sign-in. Something always gets through eventually.

import cron from 'node-cron'
import { serviceClient as prisma } from '../lib/prisma.js'
import { sendText } from '../lib/whatsapp.js'
import { sendEmail, emailConfigured } from '../lib/mailer.js'
import { whatsappConfigured } from '../lib/whatsapp.js'

/** Where the current delivery state is parked for the admin dashboard. */
export const DELIVERY_STATE_KEY = 'integrations.delivery.state'

export interface DeliveryState {
  ok: boolean
  cause: 'ok' | 'unconfigured' | 'session_dropped' | 'bad_key' | 'gateway_unreachable' | 'unknown'
  detail: string
  fix: string
  checkedAt: string
  /** So a flapping session does not send the same alert every ten minutes. */
  lastAlertedAt?: string
}

const HUMAN: Record<DeliveryState['cause'], { detail: string; fix: string }> = {
  ok: { detail: 'Codes are sending.', fix: '' },
  unconfigured: {
    detail: 'No WhatsApp gateway is configured, so no codes can be sent at all.',
    fix: 'Open admin → Configuration → WhatsApp and paste the endpoint and API key from the gateway’s API Info tab.',
  },
  session_dropped: {
    detail: 'The gateway is up but its WhatsApp session is not linked — this is what happens when the phone goes offline or WhatsApp logs the device out.',
    fix: 'Open the gateway page, find the servd app, and scan the QR code with the business WhatsApp phone. Takes about thirty seconds.',
  },
  bad_key: {
    detail: 'The gateway rejected our API key.',
    fix: 'Copy the current key from the gateway’s API Info tab into admin → Configuration → WhatsApp.',
  },
  gateway_unreachable: {
    detail: 'The gateway host itself did not answer.',
    fix: 'The WhatsApp gateway server is down — this one is not fixable from servd. Whoever runs the gateway needs to restart it.',
  },
  unknown: {
    detail: 'Sending failed for a reason we do not recognise.',
    fix: 'Check admin → Configuration → WhatsApp and use Send test to see the gateway’s own error message.',
  },
}

/**
 * Work out whether codes can actually be delivered right now, and if not, why.
 *
 * Deliberately does NOT send a real message. A watchdog that texts somebody
 * every ten minutes to prove it works is its own kind of outage. The gateway's
 * own health endpoint reports session state, which is the thing that breaks.
 */
export async function probeDelivery(): Promise<DeliveryState> {
  const now = new Date().toISOString()
  const mk = (ok: boolean, cause: DeliveryState['cause']): DeliveryState => ({
    ok, cause, ...HUMAN[cause], checkedAt: now,
  })

  if (!(await whatsappConfigured())) return mk(false, 'unconfigured')

  // The endpoint is .../webhook/<clientId>/send; the gateway exposes /health on
  // its root with every client's state. Derive one from the other rather than
  // asking the operator to configure a second URL that can drift out of step.
  const { url } = await (async () => {
    const rows = await prisma.setting.findMany({ where: { key: 'integrations.whatsapp.apiUrl' } })
    return { url: rows[0]?.value?.trim() || (process.env['WHATSAPP_API_URL'] ?? '').trim() }
  })()

  const m = url.match(/^(https:\/\/[^/]+)\/webhook\/([^/]+)\/send$/)
  if (!m) return mk(false, 'unknown')
  const [, origin, clientId] = m

  let res: Response
  try {
    res = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(10_000) })
  } catch {
    return mk(false, 'gateway_unreachable')
  }
  if (!res.ok) return mk(false, 'gateway_unreachable')

  const body = await res.json().catch(() => null) as { clients?: Record<string, string> } | null
  const state = body?.clients?.[clientId!]
  if (!state) {
    // The app we are pointed at is not on the gateway any more — deleted, or
    // the endpoint is stale. Same remedy as a bad key: go and re-copy it.
    return mk(false, 'bad_key')
  }
  if (state !== 'READY') return mk(false, 'session_dropped')
  return mk(true, 'ok')
}

/** Alert at most once every six hours per distinct cause. */
const REALERT_MS = 6 * 60 * 60 * 1000

async function readState(): Promise<DeliveryState | null> {
  const row = await prisma.setting.findUnique({ where: { key: DELIVERY_STATE_KEY } })
  if (!row) return null
  try { return JSON.parse(row.value) as DeliveryState } catch { return null }
}

async function writeState(s: DeliveryState): Promise<void> {
  await prisma.setting.upsert({
    where: { key: DELIVERY_STATE_KEY },
    create: { key: DELIVERY_STATE_KEY, value: JSON.stringify(s) },
    update: { value: JSON.stringify(s) },
  })
}

/** Everyone who should hear about this: the CEO and the exec. */
async function recipients(): Promise<Array<{ name: string; email: string | null; phone: string | null }>> {
  return prisma.user.findMany({
    where: { role: { in: ['admin', 'management'] }, isActive: true, deletedAt: null, accountStatus: 'active' },
    select: { name: true, email: true, phone: true },
  })
}

async function alert(state: DeliveryState): Promise<void> {
  const people = await recipients()
  const subject = 'servd: customer signup is down'
  const line = `servd alert — ${state.detail}\n\nWhat to do: ${state.fix}`

  for (const p of people) {
    // Try WhatsApp even though WhatsApp is the thing that is broken: the fault
    // may be this one app's session while the operator's own number still
    // works, and when it does this is the fastest thing that reaches them.
    if (p.phone) {
      try { await sendText(p.phone, line); continue } catch { /* fall through to email */ }
    }
    if (p.email && await emailConfigured()) {
      try {
        await sendEmail({
          to: p.email,
          subject,
          html: `<p>${state.detail}</p><p><strong>What to do:</strong> ${state.fix}</p>`,
        })
      } catch { /* nothing left to try; the dashboard banner carries it */ }
    }
  }
}

export async function runDeliveryWatch(): Promise<DeliveryState> {
  const state = await probeDelivery()
  const previous = await readState()

  // Alert on a NEW fault, or when the same fault is still there six hours
  // later. Not every run: a broken session stays broken for as long as nobody
  // is near the phone, and a message every ten minutes trains people to ignore
  // the alerts that matter.
  const isNewFault = !state.ok && previous?.cause !== state.cause
  const isStale = !state.ok && previous?.lastAlertedAt
    ? Date.now() - Date.parse(previous.lastAlertedAt) > REALERT_MS
    : false

  if (isNewFault || isStale) {
    await alert(state)
    state.lastAlertedAt = new Date().toISOString()
  } else if (!state.ok) {
    state.lastAlertedAt = previous?.lastAlertedAt
  }

  // Recovery is worth one message too — otherwise the last thing anyone heard
  // was that it was broken.
  if (state.ok && previous && !previous.ok) {
    const people = await recipients()
    for (const p of people) {
      if (p.phone) { try { await sendText(p.phone, 'servd: codes are sending again. Signup is back up.') } catch { /* ignore */ } }
    }
  }

  await writeState(state)
  return state
}

export function startDeliveryWatch(): void {
  // Every ten minutes. Frequent enough that a dropped session is caught within
  // one order's worth of time; infrequent enough to be invisible.
  cron.schedule('*/10 * * * *', () => {
    runDeliveryWatch().catch((err) => console.error('[deliveryWatch] failed:', (err as Error).message))
  })
  // And once at boot, so a deploy that lands during an outage says so
  // immediately rather than up to ten minutes later.
  runDeliveryWatch().catch(() => {})
  console.log('[deliveryWatch] started — checking delivery every 10 minutes')
}
