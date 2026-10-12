import { AppError } from './errors.js'
import { sendEmail as sendMail, emailConfigured } from './mailer.js'
import { formatBrandName } from './brandName.js'
import { orderRefOf } from './orderRef.js'

const isProd = process.env['NODE_ENV'] === 'production'

// ─── Startup warnings ─────────────────────────────────────────────────────────
// Loud, visible signal at boot if notification rails aren't configured. Without
// this, prod silently swallows every customer email and you only find out
// when a customer asks where their order receipt went. (Phone messages go
// through the WhatsApp gateway, configured in admin and checked by /health.)
{
  // Env only — the database may well carry credentials this early check cannot
  // see, so the wording below says "check admin" rather than asserting an outage.
  const emailMissing = !process.env['SMTP_USER'] || !process.env['SMTP_PASS']
  if (emailMissing) {
    const msg = '[notify] no SMTP_* in the environment — email will work only if it is configured in admin → Configuration → Email'
    if (isProd) console.error(msg + ' (production — verify at /health that email is configured)')
    else console.warn(msg)
  }
}

// ─── Email ────────────────────────────────────────────────────────────────────

// Delivery goes through lib/mailer.ts, which resolves credentials from the
// settings table first and the environment second.
//
// This used to build its own transporter from process.env at MODULE LOAD, which
// had two consequences worth remembering. The transport was frozen at boot, so
// changing the credentials meant restarting the API; and once the settings moved
// into the database, this path kept reading env and silently skipped email while
// /health — reading the new resolver — reported everything fine. A health check
// that disagrees with the code it is reporting on is worse than no health check.
// ─── What a skipped send may log ─────────────────────────────────────────────
//
// When a channel is not configured the message is dropped, and the drop is
// logged. Only ever the channel, a masked recipient and what KIND of message it
// was — never the body or subject. Bodies carry sign-in links, booking
// confirm/cancel tokens and tracking URLs; logged in plain text they were a
// working credential for anyone who could read the server log (a customer
// session from one grep). Anything that needs the token in development reads
// it from the database (magic_links, reservations), which is where it lives.

/** `…4567` — enough to tell two recipients apart, not enough to message one. */
export function maskPhoneForLog(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  return digits.length >= 4 ? `…${digits.slice(-4)}` : '…'
}

/** `s***@example.com` */
export function maskEmailForLog(raw: string): string {
  const [local = '', domain = ''] = raw.trim().split('@')
  return `${local.slice(0, 1) || '?'}***@${domain || '?'}`
}

export async function sendEmail(to: string, subject: string, html: string, purpose = 'message'): Promise<void> {
  if (!(await emailConfigured())) {
    if (isProd) {
      // In production a missing transport is an outage, not a benign skip.
      throw new AppError('NOTIFY_NOT_CONFIGURED', 'Email is not configured (set it in admin → Configuration → Email)', 503)
    }
    console.log(`[notify] email not sent (no SMTP configured) — to ${maskEmailForLog(to)}, ${purpose}`)
    return
  }
  await sendMail({ to, subject, html })
}

// ─── Phone (WhatsApp) ─────────────────────────────────────────────────────────
//
// Owner decision 17: the phone channel is WhatsApp (plus email) only. Twilio
// SMS is gone — it had no admin configuration and, with TWILIO_* unset in
// production, every order-status text, reservation confirmation, review
// prompt and birthday / win-back text was logged and dropped while OTPs
// arrived fine over the WhatsApp gateway.

/** A stored phone number as the WhatsApp gateway wants it: digits only, E.164 without the +. */
export function whatsappNumber(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  if (digits.startsWith('92')) return digits
  if (digits.startsWith('0')) return '92' + digits.slice(1)
  if (digits.length === 10) return '92' + digits
  return digits
}

export async function sendPhoneMessage(to: string, body: string, purpose = 'message'): Promise<void> {
  const { sendText, whatsappConfigured } = await import('./whatsapp.js')
  if (!(await whatsappConfigured())) {
    // Never the body: see "What a skipped send may log" above.
    console.log(`[notify] WhatsApp not sent (not configured) — to ${maskPhoneForLog(to)}, ${purpose}`)
    return
  }
  await sendText(whatsappNumber(to), body)
}

/**
 * @deprecated Same as sendPhoneMessage — WhatsApp, not SMS. Kept only so the
 * callers outside this batch (reservations, waitlist, review prompt,
 * reservation reminders) keep compiling until they are renamed.
 */

// ─── Magic link ───────────────────────────────────────────────────────────────

export async function sendMagicLink(
  emailOrPhone: string,
  isEmail: boolean,
  token: string,
): Promise<void> {
  const baseUrl = process.env['STOREFRONT_URL'] ?? 'http://localhost:3002'
  const link = `${baseUrl}/auth/verify?token=${encodeURIComponent(token)}`

  if (isEmail) {
    await sendEmail(
      emailOrPhone,
      'Your servd login link',
      `<p>Click to sign in — this link expires in 15 minutes and can only be used once.</p>
       <p><a href="${link}" style="font-size:18px;font-weight:bold;">Sign in to servd</a></p>
       <p style="color:#888;font-size:12px;">If you didn't request this, ignore this email.</p>`,
      'magic_link',
    )
  } else {
    await sendPhoneMessage(emailOrPhone, `Your servd login link: ${link}`, 'magic_link')
  }
}

// ─── Order status update ──────────────────────────────────────────────────────

const STATUS_COPY: Record<string, { subject: string; headline: string; body: string } | undefined> = {
  preparing: {
    subject: 'Your order is being prepared',
    headline: 'Being prepared 🍳',
    body: "The kitchen has picked up your order. It'll be with you shortly!",
  },
  ready: {
    subject: 'Your order is ready!',
    headline: 'Ready for pickup 🎉',
    body: 'Your order is ready — please come collect it now.',
  },
  completed: {
    subject: 'Thanks for your order!',
    headline: 'Order complete ✅',
    body: 'Thank you for dining with us. We hope to see you again soon!',
  },
  cancelled: {
    subject: 'Your order has been cancelled',
    headline: 'Order cancelled',
    body: 'Your order has been cancelled. If you have questions, please contact us.',
  },
  // Expo declined the order at intake. It used to end silently — the customer
  // was never told their order would not arrive.
  rejected: {
    subject: "We couldn't accept your order",
    headline: "Order not accepted",
    body: "The restaurant couldn't take your order this time. Any wallet credit or gift card balance you used on it has been returned. If you have questions, please contact us.",
  },
}

export async function sendOrderStatusUpdate(opts: {
  email?: string | null
  phone?: string | null
  conceptName: string
  conceptId?: string | null
  orderId: string
  status: string
  customerName?: string | null
}): Promise<void> {
  const copy = STATUS_COPY[opts.status]
  if (!copy) return
  opts = { ...opts, conceptName: formatBrandName(opts.conceptName) }

  const baseUrl = process.env['STOREFRONT_URL'] ?? 'http://localhost:3002'
  const trackUrl = `${baseUrl}/orders/${opts.orderId}`
  const ref = orderRefOf(opts.orderId)

  // Operator-defined template override — if one exists for this event, it wins.
  const { renderTemplate } = await import('./notification-templates.js')
  const event = `order.${opts.status}`
  const vars = {
    customerName: opts.customerName ?? 'there',
    conceptName: opts.conceptName,
    orderId: opts.orderId,
    ref,
    trackUrl,
    headline: copy.headline,
    status: opts.status,
  }

  if (opts.email) {
    const tpl = await renderTemplate({ event, channel: 'email', conceptId: opts.conceptId, vars })
    if (tpl) {
      await sendEmail(opts.email, tpl.subject ?? `${copy.subject} — ${opts.conceptName}`, tpl.body)
    } else {
      const html = `
        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb">
          <div style="background:#16a34a;padding:28px 24px;text-align:center">
            <h1 style="color:#fff;margin:0;font-size:22px;font-weight:900">${opts.conceptName}</h1>
          </div>
          <div style="padding:28px 24px">
            <p style="color:#374151;margin-top:0">Hi ${opts.customerName ?? 'there'},</p>
            <h2 style="color:#111827;margin-top:0">${copy.headline}</h2>
            <p style="color:#374151">${copy.body}</p>
            <p style="margin-top:24px"><a href="${trackUrl}" style="background:#16a34a;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;">Track order →</a></p>
            <p style="color:#9ca3af;font-size:12px;margin-top:24px">Ref: ${ref}</p>
          </div>
        </div>`
      await sendEmail(opts.email, `${copy.subject} — ${opts.conceptName}`, html)
    }
  } else if (opts.phone) {
    // The operator's WhatsApp template wins; an old 'sms' template is the fallback copy.
    const tpl = (await renderTemplate({ event, channel: 'whatsapp', conceptId: opts.conceptId, vars }))
      ?? (await renderTemplate({ event, channel: 'sms', conceptId: opts.conceptId, vars }))
    if (tpl) {
      await sendPhoneMessage(opts.phone, tpl.body, event)
    } else {
      const fmt = (s: string) => s.toLowerCase()
      await sendPhoneMessage(opts.phone, `${opts.conceptName}: ${fmt(copy.headline)}. Track: ${trackUrl}`, event)
    }
  }
}

// ─── Order receipt ────────────────────────────────────────────────────────────

export async function sendOrderReceipt(opts: {
  email?: string | null
  phone?: string | null
  orderId: string
  conceptName: string
  totalCents: number
  items: Array<{ name: string; quantity: number; unitPriceCents: number }>
}): Promise<void> {
  opts = { ...opts, conceptName: formatBrandName(opts.conceptName) }
  const baseUrl = process.env['STOREFRONT_URL'] ?? 'http://localhost:3002'
  const trackUrl = `${baseUrl}/orders/${opts.orderId}`
  const fmt = (cents: number) => `Rs. ${(cents / 100).toLocaleString()}`

  const itemRows = opts.items
    .map(i => `<tr><td>${i.quantity}× ${i.name}</td><td align="right">${fmt(i.unitPriceCents * i.quantity)}</td></tr>`)
    .join('')

  const html = `
    <h2>Order confirmed — ${opts.conceptName}</h2>
    <table width="100%" cellspacing="0" cellpadding="4">
      ${itemRows}
      <tr><td colspan="2" style="border-top:1px solid #eee;padding-top:8px;font-weight:bold;">
        Total ${fmt(opts.totalCents)}
      </td></tr>
    </table>
    <p><a href="${trackUrl}">Track your order →</a></p>`

  if (opts.email) {
    await sendEmail(opts.email, `Order confirmed — ${opts.conceptName}`, html)
  } else if (opts.phone) {
    await sendPhoneMessage(opts.phone, `Order confirmed at ${opts.conceptName}. Total ${fmt(opts.totalCents)}. Track: ${trackUrl}`, 'order.receipt')
  }
}
