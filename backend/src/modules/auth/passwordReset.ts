// Self-service staff password reset.
//
// The gap this closes: until now a forgotten staff password had no
// self-service remedy at all. /auth/password/change needs the password you
// forgot, and /auth/users/:id/reissue-password needs a SIGNED-IN ADMIN — so the
// single account most likely to be locked out, the owner's, could only be
// recovered by another admin or by editing the database on the production box.
// That has now happened twice.
//
// Design notes:
//
//   Link, not a code.  Six digits typed into a form is the right shape for a
//   second factor during a flow you are already in. For "I am locked out on my
//   phone at 11pm" a one-tap link is fewer things to get wrong, and the token
//   can be long enough that guessing is not a threat model.
//
//   Both channels.  The link goes to the account's email (which is also its
//   login identity, so it always exists) AND to WhatsApp when a phone is on
//   file. Either rail being down should not mean nobody can get back in — and
//   this codebase has a documented history of one rail silently not being
//   configured in production.
//
//   Hash at rest.  Only SHA-256 of the token is stored. A dump of
//   staff_password_resets is useless; the token exists only in the message.
//
//   No enumeration oracle.  /forgot returns the same body whether or not the
//   address belongs to an account, matching how failed logins are worded
//   elsewhere in this file's sibling routes.

import crypto from 'crypto'
import { serviceClient as prisma } from '../../lib/prisma.js'
import { sendEmail } from '../../lib/notify.js'
import { emailConfigured } from '../../lib/mailer.js'
import { whatsappConfigured } from '../../lib/whatsapp.js'
import { sendText as sendWhatsApp } from '../../lib/whatsapp.js'
import { normalisePhone } from './otp.js'
import { ACTIVE_ACCOUNT_WHERE, isAccountActive } from './accountStatus.js'

// Long enough to walk to a laptop, short enough that a link left in an inbox
// is not a standing key to the account.
const TTL_MS = 30 * 60_000

/** Where the reset form lives. Configurable because the admin host differs per environment. */
function adminOrigin(): string {
  return (process.env['ADMIN_ORIGIN'] ?? 'https://admin.servd.pk').replace(/\/+$/, '')
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

/**
 * Can a reset link reach anybody at all?
 *
 * This is a property of the SERVER, not of any account, so answering it to an
 * unauthenticated caller leaks nothing — which is what lets /forgot be honest
 * about "we cannot send you anything" without becoming the account-existence
 * oracle it otherwise refuses to be.
 *
 * It matters because the failure it describes is invisible: with no transport
 * configured, sendEmail throws and sendWhatsApp throws, and a /forgot that
 * still answered "a link is on its way" would leave someone refreshing an
 * inbox that is never going to receive anything.
 */
export async function deliveryConfigured(): Promise<boolean> {
  // Both channels resolve from the settings table first and the environment
  // second, so this must ask the resolvers rather than read process.env. When
  // it read env directly, configuring the credentials in admin left this
  // returning false: /forgot went on refusing to send while /health, asking the
  // resolvers, reported email as fine.
  const [email, whatsapp] = await Promise.all([emailConfigured(), whatsappConfigured()])
  return email || whatsapp
}

export interface DeliveryOutcome {
  email: 'sent' | 'failed' | 'skipped'
  whatsapp: 'sent' | 'failed' | 'skipped'
  errors: string[]
}

/**
 * Issues a reset link for `email` and sends it. Returns what happened per
 * channel so the ROUTE can log it — the route must not return this to the
 * caller, or it becomes an account-existence oracle.
 *
 * A non-existent / disabled account is a no-op that reports 'skipped'.
 */
export async function requestPasswordReset(email: string, ip: string | null): Promise<DeliveryOutcome> {
  const out: DeliveryOutcome = { email: 'skipped', whatsapp: 'skipped', errors: [] }

  const user = await prisma.user.findUnique({
    where: { email: email.trim().toLowerCase() },
    select: { id: true, name: true, email: true, phone: true, isActive: true, accountStatus: true, deletedAt: true },
  })
  if (!user || !isAccountActive(user) || !user.email) {
    return out
  }

  // Any link issued earlier is dead the moment a new one is asked for, so a
  // forwarded or shoulder-surfed old email stops working.
  await prisma.staffPasswordReset.updateMany({
    where: { userId: user.id, consumedAt: null },
    data: { consumedAt: new Date() },
  })

  const token = crypto.randomBytes(32).toString('base64url')
  await prisma.staffPasswordReset.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + TTL_MS),
      requestedIp: ip,
    },
  })

  const link = `${adminOrigin()}/reset-password?token=${encodeURIComponent(token)}`
  const firstName = (user.name ?? '').trim().split(/\s+/)[0] || 'there'

  // Both sends are attempted even if the first throws — one rail being
  // misconfigured must not take the other down with it.
  try {
    await sendEmail(
      user.email,
      'Reset your servd password',
      resetEmailHtml(firstName, link),
    )
    out.email = 'sent'
  } catch (err) {
    out.email = 'failed'
    out.errors.push(`email: ${err instanceof Error ? err.message : String(err)}`)
  }

  if (user.phone) {
    try {
      await sendWhatsApp(
        normalisePhone(user.phone),
        `Reset your servd password: ${link}\n\n`
        + 'The link works once and expires in 30 minutes. '
        + 'If you did not ask for this, ignore it — your password has not changed.',
      )
      out.whatsapp = 'sent'
    } catch (err) {
      out.whatsapp = 'failed'
      out.errors.push(`whatsapp: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return out
}

/**
 * Trades a token for the user it belongs to. Marks it consumed in the same
 * statement that claims it, so two simultaneous redemptions cannot both win.
 * Returns null for anything unusable — expired, already used, or unknown.
 */
export async function consumeResetToken(token: string): Promise<{ id: string; email: string } | null> {
  const row = await prisma.staffPasswordReset.findUnique({
    where: { tokenHash: hashToken(token) },
    select: { id: true, userId: true, expiresAt: true, consumedAt: true },
  })
  if (!row || row.consumedAt || row.expiresAt < new Date()) return null

  // Claim it before the password moves. updateMany with consumedAt: null in the
  // WHERE makes this a compare-and-set: the loser of a race updates 0 rows.
  const claimed = await prisma.staffPasswordReset.updateMany({
    where: { id: row.id, consumedAt: null },
    data: { consumedAt: new Date() },
  })
  if (claimed.count !== 1) return null

  const user = await prisma.user.findFirst({
    where: { id: row.userId, ...ACTIVE_ACCOUNT_WHERE },
    select: { id: true, email: true },
  })
  if (!user?.email) return null
  return { id: user.id, email: user.email }
}

/** Is a token currently good? Used by the reset page to fail early, before the form. */
export async function checkResetToken(token: string): Promise<boolean> {
  const row = await prisma.staffPasswordReset.findUnique({
    where: { tokenHash: hashToken(token) },
    select: { expiresAt: true, consumedAt: true },
  })
  return Boolean(row && !row.consumedAt && row.expiresAt >= new Date())
}

function resetEmailHtml(firstName: string, link: string): string {
  // Deliberately plain. A password-reset email that looks like marketing is a
  // password-reset email people report as phishing.
  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f6f6f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#171717">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px">
    <p style="margin:0 0 20px;font-size:15px;line-height:1.6">Hi ${escapeHtml(firstName)},</p>
    <p style="margin:0 0 20px;font-size:15px;line-height:1.6">
      Someone asked to reset the password on your servd account. If that was you, use this link:
    </p>
    <p style="margin:0 0 24px">
      <a href="${link}" style="display:inline-block;background:#4E2A4F;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;font-size:15px">Set a new password</a>
    </p>
    <p style="margin:0 0 20px;font-size:13px;line-height:1.6;color:#525252">
      The link works once and expires in 30 minutes. If you did not ask for this,
      ignore this email — your password has not changed.
    </p>
    <p style="margin:0;font-size:12px;line-height:1.6;color:#a3a3a3;word-break:break-all">
      If the button does not work, paste this into your browser:<br>${escapeHtml(link)}
    </p>
  </div>
</body></html>`
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ))
}
