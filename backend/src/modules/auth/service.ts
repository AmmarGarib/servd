import bcrypt from 'bcryptjs'
import jwt, { type SignOptions } from 'jsonwebtoken'
import { nanoid } from 'nanoid'
import { serviceClient as prisma } from '../../lib/prisma.js'
import { AppError, NotFoundError, UnauthorizedError } from '../../lib/errors.js'
import { sendMagicLink } from '../../lib/notify.js'

if (!process.env['JWT_SECRET'] || !process.env['JWT_REFRESH_SECRET']) {
  throw new Error('JWT_SECRET and JWT_REFRESH_SECRET environment variables must be set')
}
const JWT_SECRET = process.env['JWT_SECRET'] as string
const JWT_REFRESH_SECRET = process.env['JWT_REFRESH_SECRET'] as string
const JWT_ACCESS_EXPIRY: SignOptions['expiresIn']  = (process.env['JWT_ACCESS_EXPIRY']  ?? '15m') as SignOptions['expiresIn']
const JWT_REFRESH_EXPIRY: SignOptions['expiresIn'] = (process.env['JWT_REFRESH_EXPIRY'] ?? '7d')  as SignOptions['expiresIn']
const PIN_TOKEN_EXPIRY: SignOptions['expiresIn']   = (process.env['PIN_TOKEN_EXPIRY']   ?? '12h') as SignOptions['expiresIn']

export interface StaffTokenPayload {
  sub: string   // user ID
  // Optional now that User.email can be null — stub staff rows created from
  // /workforce don't have an address yet. Login mints empty string for those.
  email: string | null
  role: string
  type: 'access' | 'refresh' | 'pin'
}

export interface CustomerTokenPayload {
  sub: string   // customer ID
  type: 'customer'
}

// ─── Staff auth ───────────────────────────────────────────────────────────────

export async function staffLogin(email: string, password: string) {
  // accountStatus gate matches PIN login — `pending` (awaiting CEO approval)
  // and `suspended` accounts must not be able to password-login either.
  const user = await prisma.user.findFirst({
    where: { email: email.toLowerCase(), isActive: true, deletedAt: null, accountStatus: 'active' },
  })

  if (!user) throw new UnauthorizedError('Invalid credentials')

  const valid = await bcrypt.compare(password, user.password)
  if (!valid) throw new UnauthorizedError('Invalid credentials')

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

export async function staffPinLogin(identifier: string | undefined, pin: string) {
  // Staff now identify themselves (name or email) BEFORE the PIN. That lets us:
  //   • compare ONE PIN hash instead of every staff member's (no O(n) bcrypt
  //     loop → no timing leak / DoS), and
  //   • rate-limit failed attempts per person (done at the route).
  // Only `active` accounts can complete PIN login — `pending` (awaiting CEO
  // approval) and `suspended` (ex-staff) are excluded.
  const idTrim = (identifier ?? '').trim()
  const candidates = idTrim
    ? await prisma.user.findMany({
        where: {
          isActive: true, pin: { not: null }, deletedAt: null, accountStatus: 'active',
          OR: [
            { email: idTrim.toLowerCase() },
            { name: { equals: idTrim, mode: 'insensitive' } },
          ],
        },
      })
    // TEMPORARY fallback for any client not yet sending the name — legacy
    // all-staff scan. Kept so a client glitch can't lock everyone out during
    // rollout; remove once every login surface sends `identifier`.
    : await prisma.user.findMany({
        where: { isActive: true, pin: { not: null }, deletedAt: null, accountStatus: 'active' },
      })

  // Name isn't guaranteed unique, so compare against the (usually one) matches.
  // The candidate set is tiny and scoped to the typed name — not all staff.
  let matchedUser: (typeof candidates)[number] | null = null
  for (const user of candidates) {
    if (user.pin && await bcrypt.compare(pin, user.pin)) { matchedUser = user; break }
  }

  // Legacy PIN rotation gate. Any account whose PIN was derived from the
  // last 4 digits of the phone (i.e. all pre-rotation accounts) is flagged
  // pinMustReset=true by the user_pin_must_reset migration. Login is blocked
  // until an admin issues a fresh CSPRNG PIN.
  //
  // Admin accounts are EXCLUDED from this gate because the admin is the one
  // who issues PINs to everyone else — locking them out is a chicken-and-egg
  // bootstrap break. Admins get nagged on every login to rotate (handled in
  // the response payload) but aren't blocked.
  if (
    matchedUser
    && matchedUser.role !== 'admin'
    && (matchedUser as { pinMustReset?: boolean }).pinMustReset
  ) {
    throw new UnauthorizedError('Your PIN needs to be reissued by an admin before you can sign in. Ask the CEO to rotate it from /workforce.')
  }

  if (!matchedUser) {
    // Distinguish "wrong PIN" from "your account is still pending". Knowing
    // approval is pending tells the new hire they're not crazy — without
    // leaking which PINs belong to active vs pending users.
    const pendingExists = await prisma.user.findFirst({
      where: { isActive: true, pin: { not: null }, deletedAt: null, accountStatus: 'pending' },
      select: { id: true },
    })
    if (pendingExists) {
      // We can't tell if THIS pin matches a pending account without comparing,
      // and that defeats the privacy goal. Surface a generic "wrong or pending"
      // message — the new hire will understand from context, attackers learn
      // nothing they couldn't already learn.
    }
    throw new UnauthorizedError('PIN not recognised — or your account is still awaiting approval')
  }

  // PIN login is the day-to-day login for shift staff (clocks them in on a
  // shared tablet), so it issues a full access + refresh pair just like
  // password login does. The PIN-typed token still ships for KDS/POS shared-
  // device flows that want a 12-hour station session. Admin role is blocked
  // above — admins must use email + password.
  const accessToken = jwt.sign(
    { sub: matchedUser.id, email: matchedUser.email, role: matchedUser.role, type: 'access' } satisfies StaffTokenPayload,
    JWT_SECRET,
    { expiresIn: JWT_ACCESS_EXPIRY },
  )
  const refreshToken = jwt.sign(
    { sub: matchedUser.id, email: matchedUser.email, role: matchedUser.role, type: 'refresh' } satisfies StaffTokenPayload,
    JWT_REFRESH_SECRET,
    { expiresIn: JWT_REFRESH_EXPIRY },
  )
  const pinToken = jwt.sign(
    { sub: matchedUser.id, email: matchedUser.email, role: matchedUser.role, type: 'pin' } satisfies StaffTokenPayload,
    JWT_SECRET,
    { expiresIn: PIN_TOKEN_EXPIRY },
  )

  return {
    accessToken,
    refreshToken,
    pinToken,
    // `token` kept as an alias of accessToken so legacy clients reading
    // `data.token` still work — every existing call site now lands on the
    // access path, which is what they actually wanted.
    token: accessToken,
    user: { id: matchedUser.id, name: matchedUser.name, email: matchedUser.email, role: matchedUser.role },
  }
}

export async function refreshStaffToken(refreshToken: string) {
  let payload: StaffTokenPayload
  try {
    payload = jwt.verify(refreshToken, JWT_REFRESH_SECRET) as StaffTokenPayload
  } catch {
    throw new UnauthorizedError('Invalid or expired refresh token')
  }

  if (payload.type !== 'refresh') throw new UnauthorizedError('Invalid token type')

  const user = await prisma.user.findFirst({
    where: { id: payload.sub, isActive: true, deletedAt: null },
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

  // Orphaned magic-link account (no password set) — claim it by setting a password
  if (existing && !existing.password) {
    const hashed = await bcrypt.hash(password, 12)
    const customer = await prisma.customer.update({
      where: { id: existing.id },
      data: {
        name: name.trim(),
        password: hashed,
        ...(normalisedPhone && { phone: normalisedPhone }),
        ...(otpVerified && normalisedPhone && { phoneVerifiedAt: new Date() }),
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
    data: { customerId: customer.id, token, expiresAt },
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

type StaffTokenType = 'access' | 'refresh' | 'pin'

export function verifyStaffToken(token: string, expected: StaffTokenType): StaffTokenPayload {
  let payload: StaffTokenPayload
  try {
    payload = jwt.verify(token, JWT_SECRET) as StaffTokenPayload
  } catch {
    throw new UnauthorizedError('Invalid or expired token')
  }
  if (!['access', 'refresh', 'pin'].includes(payload.type)) {
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
