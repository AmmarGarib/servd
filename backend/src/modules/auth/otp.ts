// F19: phone OTP service. Delivers a 6-digit code over WhatsApp (free via
// Meta Cloud API for the first 1k conversations/month, vs Twilio's per-SMS
// cost). Codes are valid for 5 minutes and may be attempted at most 5 times
// before the row is invalidated and the caller must request a new one.

import crypto from 'crypto'
import { serviceClient as prisma } from '../../lib/prisma.js'
import { sendText } from '../../lib/whatsapp.js'
import { sendEmail } from '../../lib/mailer.js'
import { AppError } from '../../lib/errors.js'

const OTP_TTL_MS = 5 * 60_000
const MAX_ATTEMPTS = 5
const RESEND_COOLDOWN_MS = 30_000        // can't spam-request OTPs

export type OtpPurpose =
  | 'signup'
  | 'phone_verify'
  | 'password_reset'
  | 'staff_login'      // the ONLY factor for floor staff, who have no password
  | 'staff_2fa'        // second factor on a staff sign-in
  | 'staff_2fa_enrol'  // proving a number before 2FA is switched on for it

/** Normalise a Pakistani-style phone number to digits-only (E.164 minus the +). */
export function normalisePhone(raw: string): string {
  // Strip everything that's not a digit. Map a leading 0 (locally-dialed) to
  // the country code 92 so the same number entered three different ways still
  // resolves to one canonical key.
  const digits = raw.replace(/\D/g, '')
  if (digits.startsWith('92')) return digits
  if (digits.startsWith('0')) return '92' + digits.slice(1)
  if (digits.length === 10) return '92' + digits        // 3001234567 form
  return digits
}

// Constant-time compare. Attempt limits already bound brute force, so this is
// belt-and-braces rather than the main defence — but a length-and-content
// dependent `!==` on a secret is the kind of thing that gets copied into
// somewhere it does matter.
function codesMatch(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(provided, 'utf8')
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

function generateCode(): string {
  // Cryptographically-strong 6-digit. randomInt(0, 1_000_000) padded is fine —
  // it's not used for anything else.
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0')
}

// The message says what the code is FOR. A staff member who gets a sign-in code
// they didn't ask for should be able to tell immediately that someone has their
// password, rather than assuming it's the usual signup noise.
function messageFor(purpose: OtpPurpose, code: string): string {
  const tail = 'It expires in 5 minutes. Do not share this code with anyone.'
  switch (purpose) {
    case 'staff_login':
      // Worded for someone on the floor about to start a shift. It is their
      // whole credential, not a second factor, so it does not talk about a
      // password they do not have.
      return `${code} is your servd sign-in code. ${tail} If you did not just try to sign in, tell your manager.`
    case 'staff_2fa':
      return `${code} is your servd sign-in code. ${tail} If you did not just try to sign in, your password is known to someone else — change it now.`
    case 'staff_2fa_enrol':
      return `${code} is your servd code to turn on two-factor sign-in for this number. ${tail}`
    default:
      return `Your servd verification code is ${code}. ${tail}`
  }
}

/**
 * Issues a new OTP, sends it via WhatsApp, returns once dispatched. Throws on
 * resend cooldown or send failure (caller surfaces these to the UI).
 */
export async function requestOtp(opts: {
  phone: string
  purpose: OtpPurpose
  customerId?: string
}): Promise<{ phone: string; expiresAt: Date }> {
  const phone = normalisePhone(opts.phone)
  if (phone.length < 11) throw new AppError('INVALID_PHONE', 'Phone number looks too short', 400)

  // Cooldown: don't allow another OTP for the same (phone, purpose) within
  // the last 30s.
  const recent = await prisma.phoneOtp.findFirst({
    where: { phone, purpose: opts.purpose, createdAt: { gt: new Date(Date.now() - RESEND_COOLDOWN_MS) } },
    orderBy: { createdAt: 'desc' },
  })
  if (recent) throw new AppError('OTP_COOLDOWN', 'Please wait a few seconds before requesting another code', 429)

  const code = generateCode()
  const expiresAt = new Date(Date.now() + OTP_TTL_MS)

  const created = await prisma.phoneOtp.create({
    data: {
      phone, code, purpose: opts.purpose,
      customerId: opts.customerId ?? null,
      expiresAt,
    },
  })

  // Send via WhatsApp. If the call fails (e.g. WHATSAPP_TOKEN missing in dev),
  // we still keep the row so the developer can read the code from the DB.
  try {
    await sendText(phone, messageFor(opts.purpose, code))
  } catch (err) {
    // Don't leak the WA error to the client — surface a generic message. The
    // dev-only fallback below lets us continue testing locally without WA.
    if (process.env['NODE_ENV'] === 'production') {
      // Drop the undelivered code. Signup requires verifying every channel
      // that holds a live code, so leaving this row would demand a WhatsApp
      // code the customer never received — exactly when WhatsApp is down and
      // email is meant to carry them through.
      await prisma.phoneOtp.delete({ where: { id: created.id } }).catch(() => {})
      throw new AppError('OTP_SEND_FAILED', 'Could not send verification code. Try again in a moment.', 503)
    }
    // Never print the OTP (or full phone) into logs by default — container/CI
    // logs outlive the moment. Echo requires an explicit local-dev opt-in.
    if (process.env['OTP_DEV_ECHO'] === '1') {
      console.warn(`[otp] WhatsApp send failed — dev echo: ${code} (phone ending ${phone.slice(-4)})`)
    } else {
      console.warn('[otp] WhatsApp send failed — set OTP_DEV_ECHO=1 to echo codes in local dev')
    }
  }

  return { phone, expiresAt }
}

/**
 * Validates an OTP. Returns the customerId stored on the row (if any) so the
 * caller can complete the signup / verification in the same request.
 */
export async function verifyOtp(opts: {
  phone: string
  code: string
  purpose: OtpPurpose
  /** false = check only; the code stays usable. Wrong attempts still count. */
  consume?: boolean
}): Promise<{ customerId: string | null }> {
  const phone = normalisePhone(opts.phone)
  const row = await prisma.phoneOtp.findFirst({
    where: { phone, purpose: opts.purpose, consumedAt: null },
    orderBy: { createdAt: 'desc' },
  })
  if (!row) throw new AppError('OTP_NOT_FOUND', 'No active code for this number — request a new one', 404)
  if (row.expiresAt < new Date()) throw new AppError('OTP_EXPIRED', 'Code has expired — request a new one', 410)
  if (row.attempts >= MAX_ATTEMPTS) {
    throw new AppError('OTP_LOCKED', 'Too many wrong attempts — request a new code', 429)
  }
  if (!codesMatch(row.code, opts.code.trim())) {
    // Wrong code: bump counter so brute-force is bounded.
    await prisma.phoneOtp.update({ where: { id: row.id }, data: { attempts: { increment: 1 } } })
    const left = MAX_ATTEMPTS - (row.attempts + 1)
    throw new AppError('OTP_WRONG', left > 0 ? `Wrong code. ${left} attempts left.` : 'Wrong code — request a new one', 400)
  }
  if (opts.consume !== false) {
    await prisma.phoneOtp.update({ where: { id: row.id }, data: { consumedAt: new Date() } })
  }
  return { customerId: row.customerId }
}

// ─── Email codes ─────────────────────────────────────────────────────────────
//
// The second channel. WhatsApp here is an unofficial linked-device session, and
// when it drops every WhatsApp code stops at once — so customer verification
// runs over email as well, with the same lifetime, attempt limit and cooldown
// as the phone codes above.

export type EmailOtpPurpose = 'signup' | 'email_verify' | 'staff_login' | 'staff_2fa' | 'password_reset'

export function normaliseEmail(raw: string): string {
  return raw.trim().toLowerCase()
}

function emailHtmlFor(code: string, text?: string): string {
  if (text) {
    return `
    <div style="font-family:system-ui,-apple-system,sans-serif;max-width:420px">
      <p style="font-size:32px;font-weight:800;letter-spacing:6px;margin:8px 0;color:#4E2A4F">${code}</p>
      <p style="font-size:14px;color:#333">${text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>
      <p style="font-size:12px;color:#777">You may also get this code on WhatsApp — it is the same code. Use whichever arrives first.</p>
    </div>`
  }
  return `
    <div style="font-family:system-ui,-apple-system,sans-serif;max-width:420px">
      <p style="font-size:15px;color:#111">Your servd verification code is</p>
      <p style="font-size:32px;font-weight:800;letter-spacing:6px;margin:8px 0;color:#4E2A4F">${code}</p>
      <p style="font-size:13px;color:#555">It expires in 5 minutes. Do not share this code with anyone.
      If you did not just create a servd account, you can ignore this email.</p>
    </div>`
}

export async function requestEmailOtp(opts: {
  email: string
  purpose: EmailOtpPurpose
  customerId?: string
}): Promise<{ email: string; expiresAt: Date }> {
  const email = normaliseEmail(opts.email)
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new AppError('INVALID_EMAIL', 'Email address looks invalid', 400)

  const recent = await prisma.emailOtp.findFirst({
    where: { email, purpose: opts.purpose, createdAt: { gt: new Date(Date.now() - RESEND_COOLDOWN_MS) } },
    orderBy: { createdAt: 'desc' },
  })
  if (recent) throw new AppError('OTP_COOLDOWN', 'Please wait a few seconds before requesting another code', 429)

  const code = generateCode()
  const expiresAt = new Date(Date.now() + OTP_TTL_MS)
  const row = await prisma.emailOtp.create({
    data: { email, code, purpose: opts.purpose, customerId: opts.customerId ?? null, expiresAt },
  })

  try {
    await sendEmail({ to: email, subject: `${code} is your servd code`, html: emailHtmlFor(code) })
  } catch {
    if (process.env['NODE_ENV'] === 'production') {
      // Same rule as the WhatsApp path: an undelivered code must not stay live,
      // or signup would demand a code that never arrived.
      await prisma.emailOtp.delete({ where: { id: row.id } }).catch(() => {})
      throw new AppError('OTP_SEND_FAILED', 'Could not send the email code. Try again in a moment.', 503)
    }
    // Local dev without SMTP: keep the row so the code can be read, as the
    // WhatsApp path does.
    if (process.env['OTP_DEV_ECHO'] === '1') {
      console.warn(`[otp] email send failed — dev echo: ${code} (${email})`)
    } else {
      console.warn('[otp] email send failed — set OTP_DEV_ECHO=1 to echo codes in local dev')
    }
  }
  return { email, expiresAt }
}

export async function verifyEmailOtp(opts: {
  email: string
  code: string
  purpose: EmailOtpPurpose
  consume?: boolean
}): Promise<{ customerId: string | null }> {
  const email = normaliseEmail(opts.email)
  const row = await prisma.emailOtp.findFirst({
    where: { email, purpose: opts.purpose, consumedAt: null },
    orderBy: { createdAt: 'desc' },
  })
  if (!row) throw new AppError('EMAIL_OTP_NOT_FOUND', 'No active email code — request a new one', 404)
  if (row.expiresAt < new Date()) throw new AppError('EMAIL_OTP_EXPIRED', 'Email code has expired — request a new one', 410)
  if (row.attempts >= MAX_ATTEMPTS) {
    throw new AppError('EMAIL_OTP_LOCKED', 'Too many wrong attempts — request a new email code', 429)
  }
  if (!codesMatch(row.code, opts.code.trim())) {
    await prisma.emailOtp.update({ where: { id: row.id }, data: { attempts: { increment: 1 } } })
    const left = MAX_ATTEMPTS - (row.attempts + 1)
    throw new AppError('EMAIL_OTP_WRONG', left > 0 ? `Wrong email code. ${left} attempts left.` : 'Wrong email code — request a new one', 400)
  }
  if (opts.consume !== false) {
    await prisma.emailOtp.update({ where: { id: row.id }, data: { consumedAt: new Date() } })
  }
  return { customerId: row.customerId }
}

/**
 * Is there a live, unused signup code on this channel? Used to enforce that a
 * customer verifies EVERY channel a code actually reached — not just the one
 * they find easiest.
 */
export async function hasLivePhoneCode(phoneRaw: string, purpose: OtpPurpose): Promise<boolean> {
  const phone = normalisePhone(phoneRaw)
  const row = await prisma.phoneOtp.findFirst({
    where: { phone, purpose, consumedAt: null, expiresAt: { gt: new Date() }, attempts: { lt: MAX_ATTEMPTS } },
    select: { id: true },
  })
  return !!row
}

export async function hasLiveEmailCode(emailRaw: string, purpose: EmailOtpPurpose): Promise<boolean> {
  const email = normaliseEmail(emailRaw)
  const row = await prisma.emailOtp.findFirst({
    where: { email, purpose, consumedAt: null, expiresAt: { gt: new Date() }, attempts: { lt: MAX_ATTEMPTS } },
    select: { id: true },
  })
  return !!row
}

// ─── One code, both channels ─────────────────────────────────────────────────
//
// The same six digits go to WhatsApp AND email at once, and whichever arrives
// first can be typed in. The person enters one code; the second channel is a
// backup for delivery, not a second hoop. WhatsApp here is an unofficial
// linked-device session, so when it drops, the email copy still gets people in.
//
// Stored as one row per channel with the SAME code, so each channel keeps its
// own cooldown and attempt count, and entering the code consumes both rows —
// a code that worked cannot be replayed from the other inbox.
//
// What entering it proves: control of at least one of the two. When both were
// delivered we cannot tell which one the person read, so callers that care
// about a specific channel (referral payouts gate on the phone) should know
// that `delivered` means "a copy arrived there", not "they read it there".

export type ChannelStatus = 'sent' | 'cooldown' | 'failed' | 'skipped'

export async function requestSharedCode(opts: {
  phone?: string | null
  email?: string | null
  purpose: OtpPurpose & EmailOtpPurpose
  customerId?: string
}): Promise<{ phone: ChannelStatus; email: ChannelStatus; expiresAt: Date }> {
  const phone = opts.phone ? normalisePhone(opts.phone) : null
  const email = opts.email ? normaliseEmail(opts.email) : null
  if (!phone && !email) throw new AppError('NO_CONTACT', 'No phone or email to send a code to', 400)
  if (phone && phone.length < 11) throw new AppError('INVALID_PHONE', 'Phone number looks too short', 400)
  if (email && !/^\S+@\S+\.\S+$/.test(email)) throw new AppError('INVALID_EMAIL', 'Email address looks invalid', 400)

  // One cooldown across both: a resend within 30s would otherwise issue a
  // second code while the first is still arriving, and the person types
  // whichever they see first into a screen expecting the other.
  const since = new Date(Date.now() - RESEND_COOLDOWN_MS)
  const [recentPhone, recentEmail] = await Promise.all([
    phone ? prisma.phoneOtp.findFirst({ where: { phone, purpose: opts.purpose, createdAt: { gt: since } } }) : null,
    email ? prisma.emailOtp.findFirst({ where: { email, purpose: opts.purpose, createdAt: { gt: since } } }) : null,
  ])
  if (recentPhone || recentEmail) {
    throw new AppError('OTP_COOLDOWN', 'Please wait a few seconds before requesting another code', 429)
  }

  const code = generateCode()
  const expiresAt = new Date(Date.now() + OTP_TTL_MS)
  const text = messageFor(opts.purpose, code)

  const deliver = async (
    make: () => Promise<{ id: string }>,
    send: () => Promise<unknown>,
    drop: (id: string) => Promise<unknown>,
  ): Promise<ChannelStatus> => {
    const row = await make()
    try { await send(); return 'sent' }
    catch {
      // Production: an undelivered copy must not stay live. Dev: keep it so the
      // code can be read from the database.
      if (process.env['NODE_ENV'] === 'production') await drop(row.id).catch(() => {})
      return 'failed'
    }
  }

  const [phoneStatus, emailStatus] = await Promise.all([
    phone
      ? deliver(
          () => prisma.phoneOtp.create({ data: { phone, code, purpose: opts.purpose, customerId: opts.customerId ?? null, expiresAt } }),
          () => sendText(phone, text),
          (id) => prisma.phoneOtp.delete({ where: { id } }),
        )
      : Promise.resolve<ChannelStatus>('skipped'),
    email
      ? deliver(
          () => prisma.emailOtp.create({ data: { email, code, purpose: opts.purpose, customerId: opts.customerId ?? null, expiresAt } }),
          () => sendEmail({ to: email, subject: `${code} is your servd code`, html: emailHtmlFor(code, text) }),
          (id) => prisma.emailOtp.delete({ where: { id } }),
        )
      : Promise.resolve<ChannelStatus>('skipped'),
  ])

  const anySent = phoneStatus === 'sent' || emailStatus === 'sent'
  if (!anySent && process.env['NODE_ENV'] === 'production') {
    throw new AppError('OTP_SEND_FAILED', 'We could not send a code to your WhatsApp or your email. Try again in a moment.', 503)
  }
  if (!anySent && process.env['OTP_DEV_ECHO'] === '1') {
    console.warn(`[otp] shared code delivery failed — dev echo: ${code}`)
  }
  return { phone: phoneStatus, email: emailStatus, expiresAt }
}

/**
 * Check a shared code against every live copy. Returns which channels a copy
 * was DELIVERED to (see the note above on what that does and does not prove).
 * `consume: false` checks without burning it.
 */
export async function verifySharedCode(opts: {
  phone?: string | null
  email?: string | null
  code: string
  purpose: OtpPurpose & EmailOtpPurpose
  consume?: boolean
}): Promise<{ deliveredToPhone: boolean; deliveredToEmail: boolean; customerId: string | null }> {
  const phone = opts.phone ? normalisePhone(opts.phone) : null
  const email = opts.email ? normaliseEmail(opts.email) : null
  const now = new Date()
  const live = { consumedAt: null, expiresAt: { gt: now }, attempts: { lt: MAX_ATTEMPTS } }
  const [p, e] = await Promise.all([
    phone ? prisma.phoneOtp.findFirst({ where: { phone, purpose: opts.purpose, ...live }, orderBy: { createdAt: 'desc' } }) : null,
    email ? prisma.emailOtp.findFirst({ where: { email, purpose: opts.purpose, ...live }, orderBy: { createdAt: 'desc' } }) : null,
  ])
  if (!p && !e) throw new AppError('OTP_NOT_FOUND', 'No active code — request a new one', 404)

  const given = opts.code.trim()
  const ok = (p && codesMatch(p.code, given)) || (e && codesMatch(e.code, given))
  if (!ok) {
    await Promise.all([
      p ? prisma.phoneOtp.update({ where: { id: p.id }, data: { attempts: { increment: 1 } } }) : null,
      e ? prisma.emailOtp.update({ where: { id: e.id }, data: { attempts: { increment: 1 } } }) : null,
    ])
    const used = Math.max(p?.attempts ?? 0, e?.attempts ?? 0) + 1
    const left = MAX_ATTEMPTS - used
    throw new AppError('OTP_WRONG', left > 0 ? `Wrong code. ${left} attempts left.` : 'Wrong code — request a new one', 400)
  }

  if (opts.consume !== false) {
    await Promise.all([
      p ? prisma.phoneOtp.update({ where: { id: p.id }, data: { consumedAt: now } }) : null,
      e ? prisma.emailOtp.update({ where: { id: e.id }, data: { consumedAt: now } }) : null,
    ])
  }
  return { deliveredToPhone: !!p, deliveredToEmail: !!e, customerId: p?.customerId ?? e?.customerId ?? null }
}
