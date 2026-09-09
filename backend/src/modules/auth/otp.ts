// F19: phone OTP service. Delivers a 6-digit code over WhatsApp (free via
// Meta Cloud API for the first 1k conversations/month, vs Twilio's per-SMS
// cost). Codes are valid for 5 minutes and may be attempted at most 5 times
// before the row is invalidated and the caller must request a new one.

import crypto from 'crypto'
import { serviceClient as prisma } from '../../lib/prisma.js'
import { sendText } from '../../lib/whatsapp.js'
import { AppError } from '../../lib/errors.js'

const OTP_TTL_MS = 5 * 60_000
const MAX_ATTEMPTS = 5
const RESEND_COOLDOWN_MS = 30_000        // can't spam-request OTPs

export type OtpPurpose =
  | 'signup'
  | 'phone_verify'
  | 'password_reset'
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

  await prisma.phoneOtp.create({
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
  await prisma.phoneOtp.update({ where: { id: row.id }, data: { consumedAt: new Date() } })
  return { customerId: row.customerId }
}
