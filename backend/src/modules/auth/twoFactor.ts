// RETIRED (owner, 2026-10-26: "remove two-step sign-in; nobody has it on
// today"). /auth/2fa/* answers 410 TWO_STEP_RETIRED, POST /auth/login never asks
// for a code, and migration 20261027110000 cleared every enrolment. The
// verify / enrolment / disable code is gone. Kept only for maskPhone (waitlist)
// and startLoginChallenge, which the outbound tests drive directly as the
// "staff_2fa" code sender.

import jwt from 'jsonwebtoken'
import { AppError } from '../../lib/errors.js'
import { requestSharedCode } from './otp.js'
import { practiceCodeField } from '../../lib/sandbox.js'

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

/**
 * Called after the password has been verified. Sends the code and returns the
 * challenge the client trades back in for a session.
 */
export async function startLoginChallenge(user: {
  id: string
  twoFactorPhone: string | null
  email?: string | null
}): Promise<{ challengeToken: string; phoneHint: string; practiceCode?: string }> {
  const phone = user.twoFactorPhone
  if (!phone) throw new AppError('MFA_NOT_ENROLLED', 'Two-factor is not set up for this account', 400)

  // The same code to the enrolled phone and the account's email, so a dropped
  // WhatsApp session does not lock a manager out. This makes the email inbox an
  // alternative second factor: someone holding BOTH the password and the inbox
  // could sign in. Staff emails are company mailboxes, which is the trade the
  // owner chose over being locked out whenever WhatsApp is down.
  const email = user.email ?? null
  const sent = await requestSharedCode({ phone, email, purpose: 'staff_2fa' })

  const challengeToken = jwt.sign(
    { sub: user.id, type: 'mfa', phone, email } satisfies MfaChallengePayload,
    JWT_SECRET,
    { expiresIn: CHALLENGE_EXPIRY },
  )

  // Practice copy only: the password is already verified, so the code may be shown (lib/sandbox.ts).
  return { challengeToken, phoneHint: maskPhone(phone), ...practiceCodeField(sent.practiceCode) }
}
