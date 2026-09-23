import bcrypt from 'bcryptjs'
import { normalisePhone } from './otp.js'
import { OTP_LOGIN_ROLES } from './middleware.js'
import jwt, { type SignOptions } from 'jsonwebtoken'
import { isTwoFactorEnabled, startLoginChallenge } from './twoFactor.js'
import { nanoid } from 'nanoid'
import { serviceClient as prisma } from '../../lib/prisma.js'
import { AppError, NotFoundError, UnauthorizedError } from '../../lib/errors.js'
import { isStaffEmail, normaliseStaffEmail } from '../../lib/staffEmail.js'
import type { UserRole } from '@prisma/client'
import { sendMagicLink } from '../../lib/notify.js'

if (!process.env['JWT_SECRET'] || !process.env['JWT_REFRESH_SECRET']) {
  throw new Error('JWT_SECRET and JWT_REFRESH_SECRET environment variables must be set')
}
const JWT_SECRET = process.env['JWT_SECRET'] as string
const JWT_REFRESH_SECRET = process.env['JWT_REFRESH_SECRET'] as string
const JWT_ACCESS_EXPIRY: SignOptions['expiresIn']  = (process.env['JWT_ACCESS_EXPIRY']  ?? '15m') as SignOptions['expiresIn']
const JWT_REFRESH_EXPIRY: SignOptions['expiresIn'] = (process.env['JWT_REFRESH_EXPIRY'] ?? '7d')  as SignOptions['expiresIn']

export interface StaffTokenPayload {
  sub: string   // user ID
  // Optional now that User.email can be null — stub staff rows created from
  // /workforce don't have an address yet. Login mints empty string for those.
  email: string | null
  role: string
  type: 'access' | 'refresh' | 'mfa'
}

export interface CustomerTokenPayload {
  sub: string   // customer ID
  type: 'customer'
}

// A real bcrypt hash of a value nobody can supply, compared against when the
// account is missing so failure timing matches the wrong-password path.
const DUMMY_PASSWORD_HASH = '$2a$12$C6UzMDM.H6dfI/f/IKcEe.7Zt7Z0y2Nn2Vv9Q8kWzHqjKQ1JZ8lQe'

// ─── Staff auth ───────────────────────────────────────────────────────────────

export async function staffLogin(email: string, password: string) {
  // Domain rule enforced HERE as well as at account creation. Creation-only
  // would leave every pre-existing off-domain row able to sign in, which makes
  // it a suggestion rather than a rule.
  //
  // It still pays the bcrypt cost below rather than returning early, for the
  // same reason an unknown address does: an instant rejection here would tell
  // an attacker which domains are staff domains.
  const onDomain = isStaffEmail(email)

  // accountStatus gate: `pending` (awaiting CEO approval) and `suspended`
  // accounts must not be able to sign in either.
  const user = onDomain
    ? await prisma.user.findFirst({
        where: { email: normaliseStaffEmail(email), isActive: true, deletedAt: null, accountStatus: 'active' },
      })
    : null

  // Always pay the bcrypt cost, even for an unknown address. Returning early
  // made "no such account" answer in ~1ms and "wrong password" in ~100ms,
  // which is a reliable oracle for enumerating staff emails.
  if (!user) {
    await bcrypt.compare(password, DUMMY_PASSWORD_HASH)
    throw new UnauthorizedError('Invalid credentials')
  }

  const valid = await bcrypt.compare(password, user.password)
  if (!valid) throw new UnauthorizedError('Invalid credentials')

  // Second factor, if this account has one. The password is already verified at
  // this point and deliberately so: sending a code before checking it would let
  // anyone who knows an address flood that person's WhatsApp, and the fact that
  // a code was sent at all would confirm the address belongs to a real account.
  //
  // Nothing here keys off role. An account has 2FA because someone enrolled it,
  // full stop — enforcing by role would have locked out every owner the moment
  // this deployed.
  if (isTwoFactorEnabled(user)) {
    const { challengeToken, phoneHint } = await startLoginChallenge(user)
    return { twoFactorRequired: true as const, challengeToken, phoneHint }
  }

  return { twoFactorRequired: false as const, ...issueStaffSession(user) }
}

/**
 * Mints the access + refresh pair for a staff member. Split out of staffLogin
 * so the 2FA path issues a session on exactly the same terms as the direct one
 * — the two must not drift.
 */
/**
 * Find the floor-staff account a sign-in code should go to.
 *
 * Deliberately narrow, because this is reached by an UNAUTHENTICATED caller who
 * chooses the phone number, and the next thing that happens is a WhatsApp
 * message on GS Foods' account. So it only ever resolves to an existing,
 * active, floor-role staff member: an attacker cannot use it to send a message
 * to a number of their choosing, only to re-send a code to a number that is
 * already a cashier's.
 *
 * Returns null rather than throwing — the caller answers identically whether or
 * not a number matched, so this cannot be used to test which numbers belong to
 * staff.
 */
export async function findOtpLoginStaff(phone: string) {
  const normalised = normalisePhone(phone)
  if (normalised.length < 11) return null

  const matches = await prisma.user.findMany({
    where: {
      phone: { not: null },
      isActive: true,
      deletedAt: null,
      accountStatus: 'active',
      role: { in: OTP_LOGIN_ROLES },
    },
    select: { id: true, name: true, email: true, role: true, phone: true },
  })
  // Compare on the NORMALISED number: the same phone is stored as 03001234567,
  // +923001234567 and 923001234567 across the admin UI, the signup form and
  // the importer, and a raw equality check silently matches none of them.
  const hits = matches.filter((u) => normalisePhone(u.phone ?? '') === normalised)

  // Two staff sharing one number is a data problem, not a login to guess at —
  // signing in would have to pick one of them arbitrarily.
  if (hits.length !== 1) return null
  return hits[0]!
}

export function issueStaffSession(user: { id: string; name: string; email: string | null; role: UserRole }) {
  const accessToken = jwt.sign(
    { sub: user.id, email: user.email, role: user.role, type: 'access' } satisfies StaffTokenPayload,
    JWT_SECRET,
    { expiresIn: JWT_ACCESS_EXPIRY },
  )

  const refreshToken = jwt.sign(
    { sub: user.id, email: user.email, role: user.role, type: 'refresh' } satisfies StaffTokenPayload,
    JWT_REFRESH_SECRET,
    { expiresIn: JWT_REFRESH_EXPIRY },
  )

  return {
    accessToken,
    refreshToken,
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
  }
}

// Roles that may NOT sign in with a 4-digit PIN. A PIN is a shared-tablet
// convenience credential: 10^4 keyspace, typed in public, often watched. That
// is an acceptable trade for a line cook clocking in; it is not acceptable for
// an account that can read the P&L, run payroll, or edit roles. These sign in
// with email + password only.
export async function refreshStaffToken(refreshToken: string) {
  let payload: StaffTokenPayload
  try {
    payload = jwt.verify(refreshToken, JWT_REFRESH_SECRET) as StaffTokenPayload
  } catch {
    throw new UnauthorizedError('Invalid or expired refresh token')
  }

  if (payload.type !== 'refresh') throw new UnauthorizedError('Invalid token type')

  // Revocation. Every other authenticated entry point runs this check, but
  // refresh went straight from "the signature is valid" to minting a new access
  // token — so logout did not actually end a session. /auth/logout puts the
  // refresh token on the deny list and bumps the per-user token-valid-after
  // stamp, and both were being ignored here: a token lifted from a shared
  // tablet, or held by someone who has just been let go, kept producing fresh
  // access tokens for the whole life of the refresh token. The same stamp is
  // what a role change and a forced sign-out rely on.
  const { isRevoked } = await import('../../lib/tokenRevocation.js')
  if (await isRevoked(refreshToken, payload.sub, (payload as { iat?: number }).iat)) {
    throw new UnauthorizedError('Session has been signed out')
  }

  // accountStatus was not checked either, so a `suspended` account — the state
  // an operator puts an ex-employee in — could still refresh its way to a live
  // session. Both login paths gate on this; refresh has to as well.
  const user = await prisma.user.findFirst({
    where: { id: payload.sub, isActive: true, deletedAt: null, accountStatus: 'active' },
  })
  if (!user) throw new UnauthorizedError('User not found or inactive')

  const accessToken = jwt.sign(
    { sub: user.id, email: user.email, role: user.role, type: 'access' } satisfies StaffTokenPayload,
    JWT_SECRET,
    { expiresIn: JWT_ACCESS_EXPIRY },
  )

  return { accessToken }
}

// ─── Customer auth (password-based) ──────────────────────────────────────────

// Generate a fresh 8-char referral code. Hex from md5 of random + timestamp,
// uppercase, with `1` and `0` swapped out for `Y`/`Z` to avoid the
// 0/O / 1/I confusion when guests dictate the code over the phone.
async function generateReferralCode(): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const raw = (await import('crypto')).default.randomBytes(8).toString('hex').slice(0, 8).toUpperCase()
    const friendly = raw.replace(/0/g, 'Y').replace(/1/g, 'Z')
    const taken = await prisma.customer.findUnique({ where: { referralCode: friendly } })
    if (!taken) return friendly
  }
  // Astronomically unlikely after 5 retries; fall back to a longer code.
  return (await import('crypto')).default.randomBytes(12).toString('hex').slice(0, 12).toUpperCase()
}

// F19: signup now requires email + password + phone. Phone gets verified via a
// WhatsApp OTP — the front-end calls `POST /auth/customer/request-otp` first,
// receives a 6-digit code, sends it back here. We re-verify the OTP server-side
// (zero-trust the client) before committing the registration.
export async function customerRegister(
  name: string,
  email: string,
  password: string,
  phone: string | undefined,
  otpVerified: boolean,                            // set true only after verifyOtp succeeded for this phone
  referredByCode?: string,
  emailVerified = false,                           // set true only after verifyEmailOtp succeeded for this email
) {
  const normalisedPhone = phone?.trim() || undefined
  const existing = await prisma.customer.findFirst({
    where: {
      OR: [
        { email: email.toLowerCase() },
        ...(normalisedPhone ? [{ phone: normalisedPhone }] as const : []),
      ],
    },
  })

  // Resolve referral code (case-insensitive) — silently ignored if invalid
  // so a typo doesn't block signup.
  let referredById: string | null = null
  if (referredByCode && referredByCode.trim().length > 0) {
    const referrer = await prisma.customer.findFirst({
      where: { referralCode: referredByCode.trim().toUpperCase() },
      select: { id: true },
    })
    if (referrer) referredById = referrer.id
  }

  // Orphaned magic-link account (no password set). Anyone who signed in via a
  // magic link has one of these, so "register with that email" MUST NOT be a
  // way to take it over — it carries wallet balance, loyalty points and order
  // history. Claiming requires proving control of the account's own phone via
  // OTP; otherwise the real owner signs in with a magic link and sets a
  // password from their account page.
  if (existing && !existing.password) {
    const provedPhone =
      otpVerified && !!normalisedPhone &&
      (!existing.phone || existing.phone === normalisedPhone)
    // A verified signup email proves control of this exact account — it was
    // found BY that email — so it is as good a claim as the phone.
    const provedEmail =
      emailVerified && existing.email?.toLowerCase() === email.toLowerCase()
    if (!provedPhone && !provedEmail) {
      throw new AppError(
        'ACCOUNT_NEEDS_VERIFICATION',
        'An account already exists for this email. Sign in with the emailed link (or verify your phone) to set a password.',
        409,
      )
    }
    const hashed = await bcrypt.hash(password, 12)
    const customer = await prisma.customer.update({
      where: { id: existing.id },
      data: {
        name: name.trim(),
        password: hashed,
        ...(normalisedPhone && { phone: normalisedPhone }),
        ...(otpVerified && normalisedPhone && { phoneVerifiedAt: new Date() }),
        ...(emailVerified && { emailVerifiedAt: new Date() }),
        // Claim the referral too if the orphaned account hasn't been claimed yet.
        ...(referredById && !existing.referredById && {
          referredById,
          referredAt: new Date(),
        }),
        ...(!existing.referralCode && { referralCode: await generateReferralCode() }),
      },
    })
    const token = jwt.sign(
      { sub: customer.id, type: 'customer' } satisfies CustomerTokenPayload,
      JWT_SECRET,
      { expiresIn: '14d' },
    )
    return { token, customer: { id: customer.id, name: customer.name, email: customer.email } }
  }

  if (existing) {
    // F19: distinguish email collision from phone collision so the UI can
    // point at the right field. Phone uniqueness is the rarer case and
    // usually means another user already verified that number.
    if (normalisedPhone && existing.phone === normalisedPhone && existing.email?.toLowerCase() !== email.toLowerCase()) {
      throw new AppError('PHONE_TAKEN', 'A different account already uses this phone number', 409)
    }
    throw new AppError('EMAIL_TAKEN', 'An account with this email already exists', 409)
  }

  const hashed = await bcrypt.hash(password, 12)
  const customer = await prisma.customer.create({
    data: {
      name: name.trim(),
      email: email.toLowerCase(),
      password: hashed,
      // Phone is optional in the schema but the new signup flow always supplies
      // it. If OTP verification succeeded we also stamp phoneVerifiedAt so
      // delivery + WhatsApp marketing flows can rely on it.
      ...(normalisedPhone && { phone: normalisedPhone }),
      ...(otpVerified && normalisedPhone && { phoneVerifiedAt: new Date() }),
      ...(emailVerified && { emailVerifiedAt: new Date() }),
      referralCode: await generateReferralCode(),
      ...(referredById && { referredById, referredAt: new Date() }),
    },
  })

  const token = jwt.sign(
    { sub: customer.id, type: 'customer' } satisfies CustomerTokenPayload,
    JWT_SECRET,
    { expiresIn: '14d' },
  )

  return {
    token,
    customer: { id: customer.id, name: customer.name, email: customer.email },
  }
}

export async function customerLogin(email: string, password: string) {
  const customer = await prisma.customer.findFirst({ where: { email: email.toLowerCase() } })

  if (!customer || !customer.password) {
    throw new UnauthorizedError('Invalid email or password')
  }

  const valid = await bcrypt.compare(password, customer.password)
  if (!valid) throw new UnauthorizedError('Invalid email or password')

  const token = jwt.sign(
    { sub: customer.id, type: 'customer' } satisfies CustomerTokenPayload,
    JWT_SECRET,
    { expiresIn: '14d' },
  )

  return {
    token,
    customer: { id: customer.id, name: customer.name, email: customer.email },
  }
}

// ─── Customer auth (magic link — kept for future "forgot password" use) ───────

const MAGIC_LINK_EXPIRY_MINUTES = 15

export async function requestMagicLink(emailOrPhone: string, name?: string) {
  const isEmail = emailOrPhone.includes('@')

  let customer = await prisma.customer.findFirst({
    where: isEmail
      ? { email: emailOrPhone.toLowerCase() }
      : { phone: emailOrPhone },
  })

  if (!customer) {
    customer = await prisma.customer.create({
      data: isEmail
        ? { name: name?.trim() || 'Guest', email: emailOrPhone.toLowerCase() }
        : { name: name?.trim() || 'Guest', phone: emailOrPhone },
    })
  } else if (name?.trim() && customer.name === 'Guest') {
    customer = await prisma.customer.update({
      where: { id: customer.id },
      data: { name: name.trim() },
    })
  }

  const token = nanoid(32)
  const expiresAt = new Date(Date.now() + MAGIC_LINK_EXPIRY_MINUTES * 60 * 1000)

  await prisma.magicLink.create({
    data: { customerId: customer.id, token, expiresAt, channel: isEmail ? 'email' : 'phone' },
  })

  try {
    await sendMagicLink(emailOrPhone, isEmail, token)
  } catch (err) {
    console.error('[auth] sendMagicLink failed:', err)
  }

  return { customerId: customer.id, token, expiresAt, isEmail }
}

export async function verifyMagicLink(token: string) {
  const link = await prisma.magicLink.findUnique({
    where: { token },
    include: { customer: true },
  })

  if (!link) throw new AppError('INVALID_TOKEN', 'Invalid or already-used link', 401)
  if (link.usedAt) throw new AppError('TOKEN_USED', 'This link has already been used', 401)
  if (link.expiresAt < new Date()) throw new AppError('TOKEN_EXPIRED', 'This link has expired', 401)

  await prisma.magicLink.update({ where: { id: link.id }, data: { usedAt: new Date() } })

  // Following the link proves control of wherever it was sent. Links issued
  // before `channel` existed carry null and verify nothing.
  if (link.channel === 'email' && !link.customer.emailVerifiedAt && link.customer.email) {
    await prisma.customer.update({ where: { id: link.customer.id }, data: { emailVerifiedAt: new Date() } })
  } else if (link.channel === 'phone' && !link.customer.phoneVerifiedAt && link.customer.phone) {
    await prisma.customer.update({ where: { id: link.customer.id }, data: { phoneVerifiedAt: new Date() } })
  }

  const customerToken = jwt.sign(
    { sub: link.customer.id, type: 'customer' } satisfies CustomerTokenPayload,
    JWT_SECRET,
    { expiresIn: '14d' },
  )

  return {
    token: customerToken,
    customer: {
      id: link.customer.id,
      name: link.customer.name,
      email: link.customer.email,
      phone: link.customer.phone,
    },
  }
}

// ─── Token verification (used by middleware) ──────────────────────────────────
//
// B01: every caller must declare which token type it expects. A PIN-session
// token must not authenticate an `access`-only endpoint, a refresh token must
// not pass `requireAuth`, etc. We throw a distinct `INVALID_TOKEN_TYPE` so the
// audit log makes it obvious when a confused-deputy attempt happens.

type StaffTokenType = 'access' | 'refresh'

export function verifyStaffToken(token: string, expected: StaffTokenType): StaffTokenPayload {
  let payload: StaffTokenPayload
  try {
    payload = jwt.verify(token, JWT_SECRET) as StaffTokenPayload
  } catch {
    throw new UnauthorizedError('Invalid or expired token')
  }
  if (!['access', 'refresh', 'mfa'].includes(payload.type)) {
    throw new UnauthorizedError('Invalid token type')
  }
  if (payload.type !== expected) {
    // Distinct code so an attacker shoving a refresh token at a regular API
    // endpoint shows up clearly in the logs / response.
    const err = new UnauthorizedError('Wrong token type for this endpoint') as UnauthorizedError & { code?: string }
    err.code = 'INVALID_TOKEN_TYPE'
    throw err
  }
  return payload
}

// B16: customer tokens must also carry `type: 'customer'`. Older tokens minted
// before this check are now invalid — customers re-login once.
export function verifyCustomerToken(token: string): CustomerTokenPayload {
  let payload: CustomerTokenPayload
  try {
    payload = jwt.verify(token, JWT_SECRET) as CustomerTokenPayload
  } catch {
    throw new UnauthorizedError('Invalid or expired token')
  }
  if (payload.type !== 'customer') {
    const err = new UnauthorizedError('Not a customer token') as UnauthorizedError & { code?: string }
    err.code = 'INVALID_TOKEN_TYPE'
    throw err
  }
  return payload
}

// ─── Password/PIN hashing ─────────────────────────────────────────────────────

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12)
}

export async function hashPin(pin: string): Promise<string> {
  return bcrypt.hash(pin, 10)
}
