// Email delivery, configurable without touching the server.
//
// Same shape as lib/whatsapp.ts and for the same reason: these settings were
// read only from process.env, so the one person who owns them could not apply
// them. That cost a day of downtime on customer signup. Config the operator
// owns belongs somewhere the operator can reach.
//
// Resolution order is database first, environment second. Existing deployments
// that set SMTP_* keep working untouched; the database simply wins when a value
// is present.
//
// Why email matters here even though WhatsApp is the primary channel: the
// gateway is a linked WhatsApp Web session, and those drop. When one does,
// signup, password reset and staff sign-in all stop together, because today
// there is no second way to reach anyone. This is that second way.

import { serviceClient as prisma } from './prisma.js'

export const SMTP_HOST_KEY = 'integrations.smtp.host'
export const SMTP_PORT_KEY = 'integrations.smtp.port'
export const SMTP_USER_KEY = 'integrations.smtp.user'
export const SMTP_PASS_KEY = 'integrations.smtp.pass'
export const SMTP_FROM_KEY = 'integrations.smtp.from'

export interface MailConfig {
  host: string
  port: number
  user: string
  pass: string
  from: string
}

const CACHE_MS = 30_000
let cache: { cfg: MailConfig; at: number } | null = null

/** Drop the cache so a save in admin takes effect without a restart. */
export function invalidateMailConfig(): void {
  cache = null
}

export async function mailConfig(): Promise<MailConfig> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.cfg

  const db = new Map<string, string>()
  try {
    const rows = await prisma.setting.findMany({
      where: { key: { in: [SMTP_HOST_KEY, SMTP_PORT_KEY, SMTP_USER_KEY, SMTP_PASS_KEY, SMTP_FROM_KEY] } },
    })
    for (const r of rows) db.set(r.key, r.value.trim())
  } catch {
    // An unreadable database is not a reason to stop sending: fall through to
    // the environment, which is what every deployment had before.
  }

  const env = (k: string) => (process.env[k] ?? '').trim()
  const cfg: MailConfig = {
    // Default host kept from the previous inline sender so nothing that worked
    // before needs a value it did not need before.
    host: db.get(SMTP_HOST_KEY) || env('SMTP_HOST') || 'email-smtp.eu-north-1.amazonaws.com',
    port: parseInt(db.get(SMTP_PORT_KEY) || env('SMTP_PORT') || '587', 10),
    user: db.get(SMTP_USER_KEY) || env('SMTP_USER'),
    pass: db.get(SMTP_PASS_KEY) || env('SMTP_PASS'),
    from: db.get(SMTP_FROM_KEY) || env('SMTP_FROM') || 'noreply@servd.pk',
  }
  cache = { cfg, at: Date.now() }
  return cfg
}

/** Can we actually send? Used by /health and the admin screen. */
export async function emailConfigured(): Promise<boolean> {
  const { user, pass } = await mailConfig()
  return Boolean(user && pass)
}

/**
 * Send one email. Throws on failure so callers can fall back to another
 * channel — a silent no-op is how "the reset link never arrived" happens.
 */
export async function sendEmail(opts: {
  to: string
  subject: string
  html: string
  replyTo?: string | null
}): Promise<void> {
  const cfg = await mailConfig()
  if (!cfg.user || !cfg.pass) {
    throw new Error('Email is not configured (set it in admin → Configuration → Email)')
  }
  const nodemailer = await import('nodemailer')
  const transporter = nodemailer.default.createTransport({
    host: cfg.host,
    port: cfg.port,
    // 465 is implicit TLS; 587 upgrades with STARTTLS. Getting this wrong is
    // the single most common cause of a transport that hangs rather than
    // failing, so it is derived rather than configured separately.
    secure: cfg.port === 465,
    auth: { user: cfg.user, pass: cfg.pass },
  })
  await transporter.sendMail({
    from: `servd <${cfg.from}>`,
    to: opts.to,
    subject: opts.subject,
    html: opts.html,
    ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
  })
}
