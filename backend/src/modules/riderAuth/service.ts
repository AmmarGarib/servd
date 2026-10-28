// Rider-app sign-in (docs/rider-app.md): an @gsfoods.pk email + password, same as staff (owner, 2026-10-28:
// "Riders same as staff — Gsfoods email + password"). A manager issues the password on Riders. No WhatsApp code.
//
// A rider is NOT a User. A User with a rider role would inherit every
// ALL_STAFF route — the order lists, the dispatch board, the hand-over codes —
// so riders get their own token types, signed like the rest but rejected by
// every staff guard (auth/service.ts verifyStaffToken allow-lists its types)
// and by the socket handshake (lib/ws.ts), while the rider guard below rejects
// every staff and customer token.
//
//   access  — type 'rider',         JWT_SECRET,         15 minutes
//   refresh — type 'rider_refresh', JWT_REFRESH_SECRET, 30 days, rotated on use
//
// Both carry a random jti, so two tokens minted in the same second are never
// byte-identical (revocation is keyed on the token's hash — without it a
// rotated refresh token could be revoked along with its predecessor).

import crypto from 'crypto'
import jwt, { type SignOptions } from 'jsonwebtoken'
import { serviceClient as prisma } from '../../lib/prisma.js'
import { AppError, UnauthorizedError } from '../../lib/errors.js'
import { normalisePhone } from '../auth/otp.js'
import { isStaffEmail, normaliseStaffEmail } from '../../lib/staffEmail.js'

if (!process.env['JWT_SECRET'] || !process.env['JWT_REFRESH_SECRET']) {
  throw new Error('JWT_SECRET and JWT_REFRESH_SECRET environment variables must be set')
}
const JWT_SECRET = process.env['JWT_SECRET'] as string
const JWT_REFRESH_SECRET = process.env['JWT_REFRESH_SECRET'] as string
const RIDER_ACCESS_EXPIRY: SignOptions['expiresIn'] = '15m'
const RIDER_REFRESH_EXPIRY: SignOptions['expiresIn'] = '30d'

export type RiderTokenType = 'rider' | 'rider_refresh'

export interface RiderTokenPayload {
  sub: string            // rider id
  type: RiderTokenType
  jti: string
  iat?: number
  exp?: number
}

/** The signed-in rider as the app sees it. */
export interface RiderPublic {
  id: string
  name: string
  phone: string
  email: string | null
  vehicleType: string
  status: string
  companyName: string | null
}

const RIDER_SELECT = {
  id: true, name: true, phone: true, email: true, vehicleType: true, status: true, tenantId: true,
  tenant: { select: { name: true } },
} as const

export type SignedInRider = {
  id: string; name: string; phone: string; email: string | null; vehicleType: string; status: string
  tenantId: string; tenant: { name: string } | null
}

export function riderPublic(r: SignedInRider): RiderPublic {
  return {
    id: r.id,
    name: r.name,
    phone: r.phone,
    email: r.email,
    vehicleType: r.vehicleType,
    status: r.status,
    companyName: r.tenant?.name ?? null,
  }
}

/**
 * The rider a sign-in code may go to: exactly one active, non-deleted rider
 * with a company whose phone normalises to this number. Null otherwise — the
 * caller answers the same either way, so this cannot be used to learn which
 * numbers are riders. Two riders sharing one number is a data problem (the
 * 20261010120000 migration leaves such a duplicate un-normalised and names it),
 * not a login to guess at.
 */
export async function findLoginRider(phone: string): Promise<SignedInRider | null> {
  const normalised = normalisePhone(phone)
  if (normalised.length < 11) return null
  // A fleet is dozens of rows, and legacy rows may still be stored in another
  // spelling — compare on the normalised number, as staff code sign-in does.
  const candidates = await prisma.rider.findMany({
    where: { deletedAt: null, isActive: true, tenantId: { not: null } },
    select: RIDER_SELECT,
  })
  const hits = candidates.filter((r) => normalisePhone(r.phone) === normalised)
  if (hits.length !== 1) return null
  const r = hits[0]!
  return { ...r, tenantId: r.tenantId! }
}

/** The active rider who signs in with this email (an @gsfoods.pk address), or null. */
export async function findLoginRiderByEmail(email: string): Promise<SignedInRider | null> {
  const e = normaliseStaffEmail(email)
  if (!isStaffEmail(e)) return null
  const r = await prisma.rider.findFirst({
    where: { email: e, deletedAt: null, isActive: true, tenantId: { not: null } },
    select: RIDER_SELECT,
  })
  return r ? { ...r, tenantId: r.tenantId! } : null
}

/** A rider who may hold a session right now, or null. */
export async function loadActiveRider(riderId: string): Promise<SignedInRider | null> {
  const r = await prisma.rider.findFirst({
    where: { id: riderId, deletedAt: null, isActive: true, tenantId: { not: null } },
    select: RIDER_SELECT,
  })
  return r ? { ...r, tenantId: r.tenantId! } : null
}

export function issueRiderSession(rider: { id: string }) {
  const accessToken = jwt.sign(
    { sub: rider.id, type: 'rider', jti: crypto.randomUUID() } satisfies RiderTokenPayload,
    JWT_SECRET,
    { expiresIn: RIDER_ACCESS_EXPIRY },
  )
  const refreshToken = jwt.sign(
    { sub: rider.id, type: 'rider_refresh', jti: crypto.randomUUID() } satisfies RiderTokenPayload,
    JWT_REFRESH_SECRET,
    { expiresIn: RIDER_REFRESH_EXPIRY },
  )
  return { accessToken, refreshToken }
}

/** Verify a rider token of the expected type. Staff, customer and preview tokens are refused. */
export function verifyRiderToken(token: string, expected: RiderTokenType): RiderTokenPayload {
  let payload: RiderTokenPayload
  try {
    payload = jwt.verify(token, expected === 'rider' ? JWT_SECRET : JWT_REFRESH_SECRET) as RiderTokenPayload
  } catch {
    throw new UnauthorizedError('Invalid or expired token')
  }
  if (!payload || typeof payload !== 'object' || payload.type !== expected || typeof payload.sub !== 'string') {
    throw new AppError('INVALID_TOKEN_TYPE', 'Wrong token type for this endpoint', 401)
  }
  return payload
}

/** The stored password hash of a sign-in rider (null = no password yet). Read apart from RIDER_SELECT so the hash
 *  never travels with the rider shape. */
export async function riderPasswordHash(riderId: string): Promise<string | null> {
  const r = await prisma.rider.findUnique({ where: { id: riderId }, select: { passwordHash: true } })
  return r?.passwordHash ?? null
}
