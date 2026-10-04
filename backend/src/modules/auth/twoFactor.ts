// Two-factor authentication for staff accounts, over WhatsApp.
//
// Why WhatsApp and not an authenticator app: everyone on the floor already has
// WhatsApp, nobody has to be talked through installing Authy, and the gateway
// (lib/whatsapp.ts) is already wired and already used for customer OTPs. It is
// weaker than TOTP — a WhatsApp account can be taken over, and a code in transit
// passes through a third party — but a second factor people actually enrol in
// beats a stronger one they don't.
//
// The shape of the login flow:
//
//   1. POST /auth/login with email + password.
//      Password is checked FIRST. Only then is a code sent. Sending before
//      checking would let anyone who knows an address spam that person's
//      WhatsApp, and would confirm the address exists.
//   2. If the account has 2FA on, no session is issued. The response carries a
//      short-lived challenge token (a JWT of type 'mfa' — the token type union
//      is checked on every guarded route, so this can never be presented as an
//      access token) and a masked hint of the number.
//   3. POST /auth/2fa/verify with the challenge and the code returns the real
//      access and refresh tokens.
//
// Enrolment is deliberately proof-of-possession: the number is only stored
// after a code sent to it has been typed back. Enabling 2FA on a mistyped
// number would lock a person out of their own account, and this codebase has
// already locked its owner out once by tightening auth without a way back in.

import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import { serviceClient as prisma } from '../../lib/prisma.js'
import { AppError, UnauthorizedError } from '../../lib/errors.js'
import { requestOtp, verifyOtp, normalisePhone, requestSharedCode, verifySharedCode } from './otp.js'
import { ACTIVE_ACCOUNT_WHERE } from './accountStatus.js'

const JWT_SECRET = process.env['JWT_SECRET'] ?? ''

// Long enough to read a WhatsApp message and type six digits, short enough that
// a stolen challenge is worthless by the time it is found. The OTP itself
// expires in 5 minutes (otp.ts), so this is the outer bound.
const CHALLENGE_EXPIRY = '10m'

export interface MfaChallengePayload {
  sub: string
  type: 'mfa'
  /** The phone the code went to, so verify doesn't have to trust client input. */
  phone: string
  /** And the email — the same code goes to both (see otp.ts requestSharedCode). */
  email?: string | null
}

/** `923001234568` -> `••••4568`. Enough to recognise your own number, not enough to learn someone else's. */
export function maskPhone(phone: string): string {
  const last4 = phone.slice(-4)
  return `••••${last4}`
}

export function isTwoFactorEnabled(user: { twoFactorEnabledAt: Date | null; twoFactorPhone: string | null }): boolean {
  return Boolean(user.twoFactorEnabledAt && user.twoFactorPhone)
}

/**
 * Called after the password has been verified. Sends the code and returns the
 * challenge the client trades back in for a session.
 */
export async function startLoginChallenge(user: {
  id: string
  twoFactorPhone: string | null
  email?: string | null
}): Promise<{ challengeToken: string; phoneHint: string }> {
  const phone = user.twoFactorPhone
  if (!phone) throw new AppError('MFA_NOT_ENROLLED', 'Two-factor is not set up for this account', 400)

  // The same code to the enrolled phone and the account's email, so a dropped
  // WhatsApp session does not lock a manager out. This makes the email inbox an
  // alternative second factor: someone holding BOTH the password and the inbox
  // could sign in. Staff emails are company mailboxes, which is the trade the
  // owner chose over being locked out whenever WhatsApp is down.
  const email = user.email ?? null
  await requestSharedCode({ phone, email, purpose: 'staff_2fa' })

  const challengeToken = jwt.sign(
    { sub: user.id, type: 'mfa', phone, email } satisfies MfaChallengePayload,
    JWT_SECRET,
    { expiresIn: CHALLENGE_EXPIRY },
  )

  return { challengeToken, phoneHint: maskPhone(phone) }
}

/**
 * Trades a challenge + code for the verified user. The caller issues tokens.
 *
 * The phone is read from the signed challenge, never from the request body —
 * otherwise an attacker with any valid challenge could point verification at a
 * number they control.
 */
/**
 * Who a challenge belongs to — for attributing a FAILED code in the audit
 * trail only. The signature is checked (an unsigned token could otherwise pin
 * failures on anyone); expiry is not, so an expired challenge still names its
 * owner. Never use this to authenticate.
 */
export function challengeSubject(challengeToken: string): string | null {
  try {
    const p = jwt.verify(challengeToken, JWT_SECRET, { ignoreExpiration: true }) as MfaChallengePayload
    return p.type === 'mfa' && typeof p.sub === 'string' ? p.sub : null
  } catch {
    return null
  }
}

export async function verifyLoginChallenge(challengeToken: string, code: string) {
  let payload: MfaChallengePayload
  try {
    payload = jwt.verify(challengeToken, JWT_SECRET) as MfaChallengePayload
  } catch {
    throw new UnauthorizedError('Your sign-in request expired. Enter your password again.')
  }
  if (payload.type !== 'mfa') {
    const err = new UnauthorizedError('Wrong token type for this endpoint') as UnauthorizedError & { code?: string }
    err.code = 'INVALID_TOKEN_TYPE'
    throw err
  }

  // verifyOtp throws on a wrong/expired/exhausted code.
  await verifySharedCode({ phone: payload.phone, email: payload.email ?? null, code, purpose: 'staff_2fa' })

  const user = await prisma.user.findFirst({
    where: { id: payload.sub, ...ACTIVE_ACCOUNT_WHERE },
  })
  // The account could have been suspended between password and code.
  if (!user) throw new UnauthorizedError('Invalid credentials')

  // And 2FA could have been turned off, or the number changed, in that window —
  // in which case this challenge is for a factor that no longer applies.
  if (!isTwoFactorEnabled(user) || user.twoFactorPhone !== payload.phone) {
    throw new UnauthorizedError('Your sign-in request expired. Enter your password again.')
  }

  return user
}

// ─── Enrolment ───────────────────────────────────────────────────────────────

/**
 * Step 1 of enrolment: send a code to the number the staff member wants to use.
 * Nothing is written to the account yet.
 */
export async function startEnrolment(userId: string, rawPhone: string): Promise<{ phoneHint: string }> {
  const phone = normalisePhone(rawPhone)
  if (phone.length < 11) throw new AppError('INVALID_PHONE', 'That phone number looks too short', 400)

  const user = await prisma.user.findFirst({ where: { id: userId, deletedAt: null } })
  if (!user) throw new UnauthorizedError('Invalid credentials')

  await requestOtp({ phone, purpose: 'staff_2fa_enrol' })
  return { phoneHint: maskPhone(phone) }
}

/**
 * Step 2: the code came back, so the staff member demonstrably receives
 * messages on that number. Now it is safe to store it and switch 2FA on.
 */
export async function completeEnrolment(userId: string, rawPhone: string, code: string): Promise<{ phoneHint: string }> {
  const phone = normalisePhone(rawPhone)
  await verifyOtp({ phone, code, purpose: 'staff_2fa_enrol' })

  await prisma.user.update({
    where: { id: userId },
    data: { twoFactorPhone: phone, twoFactorEnabledAt: new Date() },
  })

  return { phoneHint: maskPhone(phone) }
}

/**
 * Turning 2FA off requires the account password.
 *
 * Without that, anyone who walks up to an unlocked laptop — or who has stolen a
 * session token — could strip the second factor off the account and keep the
 * access they already have. Re-asking for the password makes disabling cost as
 * much as signing in.
 */
export async function disable(userId: string, password: string): Promise<void> {
  const user = await prisma.user.findFirst({ where: { id: userId, deletedAt: null } })
  if (!user) throw new UnauthorizedError('Invalid credentials')

  const ok = await bcrypt.compare(password, user.password)
  if (!ok) throw new UnauthorizedError('That password is not right')

  await prisma.user.update({
    where: { id: userId },
    data: { twoFactorPhone: null, twoFactorEnabledAt: null },
  })
}
