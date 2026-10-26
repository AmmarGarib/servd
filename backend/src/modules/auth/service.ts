import bcrypt from 'bcryptjs'
import { normalisePhone } from './otp.js'
import { OTP_LOGIN_ROLES, usesOtpLogin } from './middleware.js'
import type { Prisma } from '@prisma/client'
import jwt from 'jsonwebtoken'
import { staffSessionEndsAt, endedByDrawerClose, MAX_SESSION_MS } from './sessionEnd.js'
import { nanoid } from 'nanoid'
import { serviceClient as prisma } from '../../lib/prisma.js'
import { AppError, NotFoundError, UnauthorizedError } from '../../lib/errors.js'
import { isStaffEmail, normaliseStaffEmail } from '../../lib/staffEmail.js'
import type { UserRole } from '@prisma/client'
import { sendMagicLink } from '../../lib/notify.js'
import { ACTIVE_ACCOUNT_WHERE } from './accountStatus.js'

if (!process.env['JWT_SECRET'] || !process.env['JWT_REFRESH_SECRET']) {
  throw new Error('JWT_SECRET and JWT_REFRESH_SECRET environment variables must be set')
}
const JWT_SECRET = process.env['JWT_SECRET'] as string
const JWT_REFRESH_SECRET = process.env['JWT_REFRESH_SECRET'] as string
// Access tokens: JWT_ACCESS_EXPIRY ('15m', '900', '1h'), default 15 minutes.
// Refresh tokens live exactly until the shift's end (auth/sessionEnd.ts), so
// JWT_REFRESH_EXPIRY is no longer read (owner B1, 2026-10-26).
function durationSec(v: string | undefined, dflt: number): number {
  const m = /^(\d+)\s*([smhd]?)$/.exec((v ?? '').trim())
  if (!m) return dflt
  const n = Number(m[1])
  return n * ({ '': 1, s: 1, m: 60, h: 3600, d: 86400 } as Record<string, number>)[m[2] ?? '']!
}
const JWT_ACCESS_SEC = durationSec(process.env['JWT_ACCESS_EXPIRY'], 15 * 60)

export interface StaffTokenPayload {
  sub: string   // user ID
  // Optional now that User.email can be null — stub staff rows created from
  // /workforce don't have an address yet. Login mints empty string for those.
  email: string | null
  role: string
  type: 'access' | 'refresh'
  /** When this sign-in ends (epoch seconds) — one shift (owner B1, 2026-10-26; auth/sessionEnd.ts). */
  se?: number
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
        where: { email: normaliseStaffEmail(email), ...ACTIVE_ACCOUNT_WHERE },
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

  // Two-step sign-in is retired (owner, 2026-10-26); enrolments were cleared
  // by migration 20261027110000 and nothing reads them. The session lasts one
  // shift (auth/sessionEnd.ts).
  return issueShiftSession(user)
}

/**
 * THE sign-in: works out when this person's session ends (their shift today,
 * else midnight PKT, never over 24 h — auth/sessionEnd.ts) and mints the pair.
 * Every staff sign-in path (password, WhatsApp code, change password) uses it.
 */
export async function issueShiftSession(user: Parameters<typeof issueStaffSession>[0]) {
  const endsAt = await staffSessionEndsAt(user.id)
  return issueStaffSession(user, endsAt)
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
      ...ACTIVE_ACCOUNT_WHERE,
      role: { in: OTP_LOGIN_ROLES },
    },
    select: { id: true, name: true, email: true, role: true, phone: true },
  })
  // Compare on the NORMALISED number: the same phone is stored as 03001234567,
  // +923001234567 and 923001234567 across the admin UI, the signup form and
  // the importer, and a raw equality check silently matches none of them.
  const hits = matches.filter((u) => normalisePhone(u.phone ?? '') === normalised)

  // Two staff sharing one number is a data problem, not a login to guess at —
  // signing in would have to pick one of them arbitrarily. Invite, approve,
  // create, edit and reactivate all refuse a duplicate now (staffAccounts.ts
  // assertPhoneFree); this is for rows that predate that. Logged — without the
  // number — because the caller answers "a code is on its way" either way and
  // otherwise nobody would ever find out why the code never comes.
  if (hits.length > 1) {
    console.warn(`[auth] code sign-in refused: ${hits.length} active floor logins share the number ending ${normalised.slice(-4)} — fix the duplicate on Workforce`)
  }
  if (hits.length !== 1) return null
  return hits[0]!
}

export function issueStaffSession(user: {
  id: string; name: string; email: string | null; role: UserRole
  /** Set when the password was generated or reissued by someone else and not yet changed. */
  mustChangePassword?: boolean | null
}, sessionEndsAt?: Date) {
  // One shift (owner B1, 2026-10-26). Sign-in paths pass the computed end
  // (issueShiftSession); without one (tests, tooling) it is 24 h — the cap.
  const endMs = Math.min(sessionEndsAt?.getTime() ?? Date.now() + MAX_SESSION_MS, Date.now() + MAX_SESSION_MS)
  const se = Math.floor(endMs / 1000)
  const accessToken = signAccess(user, se)
  const refreshToken = jwt.sign(
    { sub: user.id, email: user.email, role: user.role, type: 'refresh', se } satisfies StaffTokenPayload,
    JWT_REFRESH_SECRET,
    { expiresIn: Math.max(1, se - Math.floor(Date.now() / 1000)) },
  )

  return {
    accessToken,
    refreshToken,
    sessionEndsAt: new Date(se * 1000).toISOString(),
    user: {
      id: user.id, name: user.name, email: user.email, role: user.role,
      // The admin's "choose your own password" nudge reads this. It was never
      // sent, so everyone kept the password the CEO had seen. Floor roles have
      // no password to change (they sign in with a code), so never for them.
      mustChangePassword: !!user.mustChangePassword && !usesOtpLogin(user.role),
    },
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
  } catch (err) {
    // The refresh token's exp IS the shift's end (owner B1): say so, so the admin shows "Your shift ended".
    if ((err as Error)?.name === 'TokenExpiredError') throw sessionEnded()
    throw new UnauthorizedError('Invalid or expired refresh token')
  }

  if (payload.type !== 'refresh') throw new UnauthorizedError('Invalid token type')
  // A refresh token minted before sign-ins lasted one shift has no end: sign in again (once).
  if (typeof payload.se !== 'number' || payload.se * 1000 <= Date.now()) throw sessionEnded()

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
    where: { id: payload.sub, ...ACTIVE_ACCOUNT_WHERE },
  })
  if (!user) throw new UnauthorizedError('User not found or inactive')
  // Their till drawer closed: the session is over (auth/sessionEnd.ts).
  if (endedByDrawerClose(user.sessionsEndedAt, (payload as { iat?: number }).iat)) throw sessionEnded()

  // Never outlives the sign-in's shift end.
  const accessToken = signAccess(user, payload.se)

  return { accessToken, sessionEndsAt: new Date(payload.se * 1000).toISOString() }
}

/** 401 SESSION_ENDED — the admin answers "Your shift ended — sign in again". */
export function sessionEnded(): AppError {
  return new AppError('SESSION_ENDED', 'Your shift ended — sign in again.', 401)
}

/** An access token: 15 minutes, never past the session's end. */
function signAccess(user: { id: string; email: string | null; role: UserRole }, se: number): string {
  const nowSec = Math.floor(Date.now() / 1000)
  const left = Math.max(1, se - nowSec)
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role, type: 'access', se } satisfies StaffTokenPayload,
    JWT_SECRET,
    { expiresIn: Math.min(left, JWT_ACCESS_SEC) },
  )
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
// A link for a contact that has no account yet. It carries the contact itself,
// signed, instead of a row: the account is created only when the link is
// FOLLOWED, which proves control of the contact. Creating it at request time
// let anyone with the endpoint fill the customer table with strangers' numbers
// (and, with un-normalised phones, a second empty account beside a real one).
const MAGIC_SIGNUP_TYPE = 'magic_signup'
interface MagicSignupPayload {
  type: typeof MAGIC_SIGNUP_TYPE
  ch: 'email' | 'phone'
  c: string          // the normalised contact
  n?: string         // the name typed at request time, if any
  jti: string        // single-use key, burned into magic_links.token on verify
  exp?: number
}

type Db = Prisma.TransactionClient | typeof prisma

/**
 * A customer contact the way signup stores it: email lowercased, phone as
 * normalised digits (92XXXXXXXXXX). Throws 400 on a phone that cannot be one.
 */
export function normaliseCustomerContact(raw: string): { isEmail: boolean; contact: string } {
  if (raw.includes('@')) return { isEmail: true, contact: raw.trim().toLowerCase() }
  const phone = normalisePhone(raw)
  if (phone.length < 11 || phone.length > 15) throw new AppError('INVALID_PHONE', 'Phone number looks too short', 400)
  return { isEmail: false, contact: phone }
}

// Spellings the same number has been stored under on customer rows (signup
// writes the normalised form; older rows and imports carry 0300… or +92…).
export function phoneSpellings(n: string): string[] {
  const out = new Set([n, `+${n}`])
  if (n.startsWith('92') && n.length === 12) { out.add(`0${n.slice(2)}`); out.add(n.slice(2)) }
  return [...out]
}

async function findCustomerByContact(isEmail: boolean, contact: string, db: Db = prisma) {
  if (isEmail) return db.customer.findFirst({ where: { email: contact } })
  const rows = await db.customer.findMany({ where: { phone: { in: phoneSpellings(contact) } }, orderBy: { createdAt: 'asc' } })
  return rows.find((r) => r.phone === contact) ?? rows[0] ?? null
}

/**
 * Send a sign-in link. Never creates an account (see MAGIC_SIGNUP_TYPE) and
 * never returns the token. The per-contact daily cap is applied by the route
 * before this is called.
 */
export async function requestMagicLink(emailOrPhone: string, name?: string): Promise<{ isEmail: boolean; expiresAt: Date }> {
  const { isEmail, contact } = normaliseCustomerContact(emailOrPhone)
  const expiresAt = new Date(Date.now() + MAGIC_LINK_EXPIRY_MINUTES * 60 * 1000)
  const customer = await findCustomerByContact(isEmail, contact)

  let token: string
  if (customer) {
    token = nanoid(32)
    await prisma.magicLink.create({
      data: { customerId: customer.id, token, expiresAt, channel: isEmail ? 'email' : 'phone' },
    })
  } else {
    const trimmed = name?.trim().slice(0, 80)
    token = jwt.sign(
      { type: MAGIC_SIGNUP_TYPE, ch: isEmail ? 'email' : 'phone', c: contact, ...(trimmed ? { n: trimmed } : {}), jti: nanoid(32) } satisfies MagicSignupPayload,
      JWT_SECRET,
      { expiresIn: `${MAGIC_LINK_EXPIRY_MINUTES}m` },
    )
  }

  try {
    await sendMagicLink(contact, isEmail, token)
  } catch (err) {
    // The message only — an error object here can carry the request it failed on.
    console.error('[auth] sendMagicLink failed:', (err as Error).message)
  }

  return { isEmail, expiresAt }
}

/** Follow a link for a contact that had no account when it was requested. */
async function verifySignupLink(token: string) {
  let p: MagicSignupPayload
  try {
    p = jwt.verify(token, JWT_SECRET) as MagicSignupPayload
  } catch {
    throw new AppError('INVALID_TOKEN', 'This link has expired or is not valid. Request a new one.', 401)
  }
  if (!p || p.type !== MAGIC_SIGNUP_TYPE || typeof p.c !== 'string' || typeof p.jti !== 'string' || p.jti.length !== 32
    || (p.ch !== 'email' && p.ch !== 'phone')) {
    throw new AppError('INVALID_TOKEN', 'Invalid or already-used link', 401)
  }
  const isEmail = p.ch === 'email'
  // The common replay, answered without a failed insert. A simultaneous one
  // still loses on the unique token below.
  if (await prisma.magicLink.findUnique({ where: { token: p.jti }, select: { id: true } })) {
    throw new AppError('TOKEN_USED', 'This link has already been used', 401)
  }
  const run = () => prisma.$transaction(async (tx) => {
    const now = new Date()
    // Someone may have signed up with this contact since the link was sent —
    // following the link proves control of it, so that account is the one.
    let c = await findCustomerByContact(isEmail, p.c, tx)
    if (!c) {
      c = await tx.customer.create({
        data: {
          name: p.n?.trim() || 'Guest',
          ...(isEmail ? { email: p.c, emailVerifiedAt: now } : { phone: p.c, phoneVerifiedAt: now }),
        },
      })
    } else if (isEmail ? !c.emailVerifiedAt : !c.phoneVerifiedAt) {
      c = await tx.customer.update({ where: { id: c.id }, data: isEmail ? { emailVerifiedAt: now } : { phoneVerifiedAt: now } })
    }
    // Single use: the jti becomes a spent magic-link row. magic_links.token is
    // unique, so a second follow of the same link fails here and rolls back.
    await tx.magicLink.create({
      data: { customerId: c.id, token: p.jti, expiresAt: new Date((p.exp ?? 0) * 1000 || now.getTime()), usedAt: now, channel: p.ch },
    })
    return c
  })

  let customer: Awaited<ReturnType<typeof run>>
  try {
    customer = await run()
  } catch (err) {
    if ((err as { code?: string }).code !== 'P2002') throw err
    if (await prisma.magicLink.findUnique({ where: { token: p.jti }, select: { id: true } })) {
      throw new AppError('TOKEN_USED', 'This link has already been used', 401)
    }
    // Lost a race creating the account (same contact, two links at once): the
    // other request made it, so this one now finds it.
    customer = await run()
  }

  const customerToken = jwt.sign(
    { sub: customer.id, type: 'customer' } satisfies CustomerTokenPayload,
    JWT_SECRET,
    { expiresIn: '14d' },
  )
  return {
    token: customerToken,
    customer: { id: customer.id, name: customer.name, email: customer.email, phone: customer.phone },
  }
}

export async function verifyMagicLink(token: string) {
  // A signed link for a contact with no account yet (longer than 32, has dots).
  if (token.length !== 32 || token.includes('.')) return verifySignupLink(token)

  const link = await prisma.magicLink.findUnique({
    where: { token },
    include: { customer: true },
  })

  if (!link) throw new AppError('INVALID_TOKEN', 'Invalid or already-used link', 401)
  if (link.usedAt) throw new AppError('TOKEN_USED', 'This link has already been used', 401)
  if (link.expiresAt < new Date()) throw new AppError('TOKEN_EXPIRED', 'This link has expired', 401)

  // Claim it, rather than read-then-write: two simultaneous follows of one link
  // both passed the usedAt check above and both got a session.
  const claimed = await prisma.magicLink.updateMany({ where: { id: link.id, usedAt: null }, data: { usedAt: new Date() } })
  if (claimed.count !== 1) throw new AppError('TOKEN_USED', 'This link has already been used', 401)

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
  // An allow-list, not a deny-list: customer tokens ('customer'), rider-app
  // tokens ('rider' / 'rider_refresh', modules/riderAuth) and preview links
  // are signed with the same secret and must never pass as a staff session —
  // a rider is not a User, and a staff guard (or the socket handshake in
  // lib/ws.ts, which calls this) accepting one would hand them every
  // ALL_STAFF route, the hand-over codes included.
  // ('mfa' challenge tokens are gone with two-step sign-in, owner 2026-10-26.)
  if (!['access', 'refresh'].includes(payload.type)) {
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
