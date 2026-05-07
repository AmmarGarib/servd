import bcrypt from 'bcryptjs'
import jwt, { type SignOptions } from 'jsonwebtoken'
import { nanoid } from 'nanoid'
import { prisma } from '../../lib/prisma.js'
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
  email: string
  role: string
  type: 'access' | 'refresh' | 'pin'
}

export interface CustomerTokenPayload {
  sub: string   // customer ID
  type: 'customer'
}

// ─── Staff auth ───────────────────────────────────────────────────────────────

export async function staffLogin(email: string, password: string) {
  const user = await prisma.user.findFirst({
    where: { email: email.toLowerCase(), isActive: true, deletedAt: null },
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

export async function staffPinLogin(pin: string) {
  const users = await prisma.user.findMany({
    where: { isActive: true, pin: { not: null }, deletedAt: null },
  })

  // Run all bcrypt comparisons in parallel — O(n) sequential was ~100ms * n staff
  const results = await Promise.all(
    users.map(async (user) => ({
      user,
      match: user.pin ? await bcrypt.compare(pin, user.pin) : false,
    })),
  )
  const matchedUser = results.find((r) => r.match)?.user ?? null

  if (!matchedUser) throw new UnauthorizedError('Invalid PIN')

  // Short-lived PIN session token (12h) — for KDS/POS devices
  const pinToken = jwt.sign(
    { sub: matchedUser.id, email: matchedUser.email, role: matchedUser.role, type: 'pin' } satisfies StaffTokenPayload,
    JWT_SECRET,
    { expiresIn: PIN_TOKEN_EXPIRY },
  )

  return {
    token: pinToken,
    user: { id: matchedUser.id, name: matchedUser.name, role: matchedUser.role },
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

export async function customerRegister(name: string, email: string, password: string) {
  const existing = await prisma.customer.findFirst({ where: { email: email.toLowerCase() } })

  // Orphaned magic-link account (no password set) — claim it by setting a password
  if (existing && !existing.password) {
    const hashed = await bcrypt.hash(password, 12)
    const customer = await prisma.customer.update({
      where: { id: existing.id },
      data: { name: name.trim(), password: hashed },
    })
    const token = jwt.sign(
      { sub: customer.id, type: 'customer' } satisfies CustomerTokenPayload,
      JWT_SECRET,
      { expiresIn: '30d' },
    )
    return { token, customer: { id: customer.id, name: customer.name, email: customer.email } }
  }

  if (existing) throw new AppError('EMAIL_TAKEN', 'An account with this email already exists', 409)

  const hashed = await bcrypt.hash(password, 12)
  const customer = await prisma.customer.create({
    data: { name: name.trim(), email: email.toLowerCase(), password: hashed },
  })

  const token = jwt.sign(
    { sub: customer.id, type: 'customer' } satisfies CustomerTokenPayload,
    JWT_SECRET,
    { expiresIn: '30d' },
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
    { expiresIn: '30d' },
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
    { expiresIn: '30d' },
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

export function verifyStaffToken(token: string): StaffTokenPayload {
  try {
    const payload = jwt.verify(token, JWT_SECRET) as StaffTokenPayload
    if (!['access', 'refresh', 'pin'].includes(payload.type)) {
      throw new UnauthorizedError('Invalid token type')
    }
    return payload
  } catch (err) {
    if (err instanceof UnauthorizedError) throw err
    throw new UnauthorizedError('Invalid or expired token')
  }
}

export function verifyCustomerToken(token: string): CustomerTokenPayload {
  try {
    return jwt.verify(token, JWT_SECRET) as CustomerTokenPayload
  } catch {
    throw new UnauthorizedError('Invalid or expired token')
  }
}

// ─── Password/PIN hashing ─────────────────────────────────────────────────────

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12)
}

export async function hashPin(pin: string): Promise<string> {
  return bcrypt.hash(pin, 10)
}
