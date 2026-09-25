import twilio from 'twilio'
import { AppError } from './errors.js'
import { sendEmail as sendMail, emailConfigured } from './mailer.js'

const isProd = process.env['NODE_ENV'] === 'production'

// ─── Startup warnings ─────────────────────────────────────────────────────────
// Loud, visible signal at boot if notification rails aren't configured. Without
// this, prod silently swallows every customer email/SMS and you only find out
// when a customer asks where their order receipt went.
{
  // Env only — the database may well carry credentials this early check cannot
  // see, so the wording below says "check admin" rather than asserting an outage.
  const emailMissing = !process.env['SMTP_USER'] || !process.env['SMTP_PASS']
  const smsMissing = !process.env['TWILIO_SID'] || !process.env['TWILIO_TOKEN']
  if (emailMissing) {
    const msg = '[notify] no SMTP_* in the environment — email will work only if it is configured in admin → Configuration → Email'
    if (isProd) console.error(msg + ' (production — verify at /health that email is configured)')
    else console.warn(msg)
  }
  if (smsMissing) {
    const msg = '[notify] SMS DISABLED — TWILIO_SID/TWILIO_TOKEN not set; sendSms() is a no-op'
    if (isProd) console.error(msg + ' (THIS IS PRODUCTION — customers will not get SMS)')
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
export async function sendEmail(to: string, subject: string, html: string): Promise<void> {
  if (!(await emailConfigured())) {
    if (isProd) {
      // In production a missing transport is an outage, not a benign skip.
      throw new AppError('NOTIFY_NOT_CONFIGURED', 'Email is not configured (set it in admin → Configuration → Email)', 503)
    }
    console.log(`[notify] EMAIL (no SMTP configured) to ${to}: ${subject}`)
    return
  }
  await sendMail({ to, subject, html })
}

// ─── SMS ──────────────────────────────────────────────────────────────────────

function getSmsClient() {
  const sid = process.env['TWILIO_SID']
  const token = process.env['TWILIO_TOKEN']
  if (!sid || !token) return null
  return twilio(sid, token)
}

export async function sendSms(to: string, body: string): Promise<void> {
  const client = getSmsClient()
  if (!client) {
    console.log(`[notify] SMS to ${to}: ${body}`)
    return
  }
  const from = process.env['TWILIO_FROM'] ?? ''
  await client.messages.create({ from, to, body })
}

// ─── Magic link ───────────────────────────────────────────────────────────────

export async function sendMagicLink(
  emailOrPhone: string,
  isEmail: boolean,
  token: string,
): Promise<void> {
  const baseUrl = process.env['STOREFRONT_URL'] ?? 'http://localhost:3002'
  const link = `${baseUrl}/auth/verify?token=${token}`

  if (isEmail) {
    await sendEmail(
      emailOrPhone,
      'Your servd login link',
      `<p>Click to sign in — this link expires in 15 minutes and can only be used once.</p>
       <p><a href="${link}" style="font-size:18px;font-weight:bold;">Sign in to servd</a></p>
       <p style="color:#888;font-size:12px;">If you didn't request this, ignore this email.</p>`,
    )
  } else {
    await sendSms(emailOrPhone, `Your servd login link: ${link}`)
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

  const baseUrl = process.env['STOREFRONT_URL'] ?? 'http://localhost:3002'
  const trackUrl = `${baseUrl}/orders/${opts.orderId}`
  const ref = opts.orderId.slice(0, 8).toUpperCase()

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
    const tpl = await renderTemplate({ event, channel: 'sms', conceptId: opts.conceptId, vars })
    if (tpl) {
      await sendSms(opts.phone, tpl.body)
    } else {
      const fmt = (s: string) => s.toLowerCase()
      await sendSms(opts.phone, `${opts.conceptName}: ${fmt(copy.headline)}. Track: ${trackUrl}`)
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
    await sendSms(opts.phone, `Order confirmed at ${opts.conceptName}. Total ${fmt(opts.totalCents)}. Track: ${trackUrl}`)
  }
}
