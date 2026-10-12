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
//
// THE PASSWORD AT REST (ops round 5). integrations.smtp.pass is kept the way
// lib/whatsapp.ts keeps the gateway key: `enc:v1:…` (lib/secretBox,
// SERVD_SECRET_KEY) when the box has the key — encrypted on save, and a plain
// value saved before this is encrypted the first time it is read (conditional
// update on the value read, so a concurrent save is never undone). Unlike the
// WhatsApp key, a box WITHOUT SERVD_SECRET_KEY still saves and reads the
// password in plain text — email is the second way to reach people when
// WhatsApp drops, so a missing key must never block it — and /health
// (smtpPassAtRest) plus the save answer say so. An encrypted password this
// server cannot read is never sent as the password: sending falls back to the
// SMTP_PASS env (if any) and /health warns.
// ROLLBACK: an image older than this one reads the stored value verbatim, i.e.
// sends the ciphertext as the SMTP password, so after rolling back the
// password must be re-entered in Configuration → Email.

import { serviceClient as prisma } from './prisma.js'
import { decryptSecret, encryptSecret, isEncrypted, secretKeyConfigured } from './secretBox.js'

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

/** How the stored (database) SMTP password is held. 'none' = no stored password. */
export type SmtpPassAtRest = 'none' | 'encrypted' | 'plaintext' | 'unreadable'

interface StoredPass { plain: string; atRest: SmtpPassAtRest }

/**
 * Turn the raw `settings` value into the usable password, encrypting a plain
 * one when SERVD_SECRET_KEY is available. Never throws.
 */
async function resolveStoredPass(raw: string): Promise<StoredPass> {
  const value = raw.trim()
  if (!value) return { plain: '', atRest: 'none' }
  if (isEncrypted(value)) {
    try {
      return { plain: decryptSecret(value), atRest: 'encrypted' }
    } catch {
      // Key missing or wrong: never hand the ciphertext to SMTP AUTH.
      return { plain: '', atRest: 'unreadable' }
    }
  }
  if (!secretKeyConfigured()) return { plain: value, atRest: 'plaintext' }
  try {
    const enc = encryptSecret(value)
    // Conditional on the value read: two processes racing both end with one
    // encrypted row, and a save in admin made meanwhile is never overwritten.
    await prisma.setting.updateMany({ where: { key: SMTP_PASS_KEY, value: raw }, data: { value: enc } })
    return { plain: value, atRest: 'encrypted' }
  } catch {
    // Could not write it back (DB blip): usable as plain text this time; the
    // next read tries again.
    return { plain: value, atRest: 'plaintext' }
  }
}

/**
 * The value PUT /auth/integrations/email stores for a new password: encrypted
 * when SERVD_SECRET_KEY is set, else as typed — never refused (see the header).
 * '' stays '' (cleared → falls back to the SMTP_PASS env).
 */
export function sealSmtpPass(plain: string): { value: string; atRest: SmtpPassAtRest } {
  const p = plain.trim()
  if (!p) return { value: '', atRest: 'none' }
  if (!secretKeyConfigured()) return { value: p, atRest: 'plaintext' }
  return { value: encryptSecret(p), atRest: 'encrypted' }
}

async function readDb(): Promise<{ values: Map<string, string>; rawPass: string } | null> {
  try {
    const rows = await prisma.setting.findMany({
      where: { key: { in: [SMTP_HOST_KEY, SMTP_PORT_KEY, SMTP_USER_KEY, SMTP_PASS_KEY, SMTP_FROM_KEY] } },
    })
    const values = new Map<string, string>()
    let rawPass = ''
    for (const r of rows) {
      if (r.key === SMTP_PASS_KEY) rawPass = r.value
      else values.set(r.key, r.value.trim())
    }
    return { values, rawPass }
  } catch {
    return null
  }
}

export async function mailConfig(): Promise<MailConfig> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.cfg

  // An unreadable database is not a reason to stop sending: fall through to
  // the environment, which is what every deployment had before.
  const db = await readDb()
  const values = db?.values ?? new Map<string, string>()
  const dbPass = db ? (await resolveStoredPass(db.rawPass)).plain : ''

  const env = (k: string) => (process.env[k] ?? '').trim()
  const cfg: MailConfig = {
    // Default host kept from the previous inline sender so nothing that worked
    // before needs a value it did not need before.
    host: values.get(SMTP_HOST_KEY) || env('SMTP_HOST') || 'email-smtp.eu-north-1.amazonaws.com',
    port: parseInt(values.get(SMTP_PORT_KEY) || env('SMTP_PORT') || '587', 10),
    user: values.get(SMTP_USER_KEY) || env('SMTP_USER'),
    pass: dbPass || env('SMTP_PASS'),
    from: values.get(SMTP_FROM_KEY) || env('SMTP_FROM') || 'noreply@servd.pk',
  }
  cache = { cfg, at: Date.now() }
  return cfg
}

/**
 * What the admin screen shows about the password (GET /auth/integrations/email).
 * Never the password itself, nor any part of it.
 */
export async function smtpPassView(): Promise<{ passSet: boolean; passAtRest: SmtpPassAtRest; passSource: 'database' | 'environment' | 'unset' }> {
  const db = await readDb()
  const stored = await resolveStoredPass(db?.rawPass ?? '')
  const envPass = (process.env['SMTP_PASS'] ?? '').trim()
  return {
    passSet: stored.atRest !== 'none' || Boolean(envPass),
    passAtRest: stored.atRest,
    passSource: stored.atRest !== 'none' ? 'database' : envPass ? 'environment' : 'unset',
  }
}

/**
 * /health: is the SMTP password held safely? The WhatsApp key's levels
 * (whatsappSecretHealth): ok = encrypted; warn = plain text without
 * SERVD_SECRET_KEY, or encrypted but unreadable here; off = none stored in the
 * database. Never 'error' — whether email works is passwordRecovery's job.
 */
export async function smtpSecretHealth(): Promise<{ check: 'ok' | 'warn' | 'off'; detail: string }> {
  const db = await readDb()
  if (!db) return { check: 'warn', detail: 'Could not read the email (SMTP) settings.' }
  const stored = await resolveStoredPass(db.rawPass)
  switch (stored.atRest) {
    case 'none': return { check: 'off', detail: 'No SMTP password stored in the database (environment or unset).' }
    case 'encrypted': return { check: 'ok', detail: 'The SMTP password is encrypted at rest.' }
    case 'plaintext': return { check: 'warn', detail: 'The SMTP password is stored in plain text because SERVD_SECRET_KEY is not set on this server. Set it and the password is encrypted on the next read.' }
    case 'unreadable': return { check: 'warn', detail: 'The stored SMTP password is encrypted but SERVD_SECRET_KEY is missing or wrong on this server, so it cannot be used. Sending falls back to SMTP_PASS, if set.' }
  }
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
