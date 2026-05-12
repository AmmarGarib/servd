import type { FastifyRequest, FastifyReply } from 'fastify'
import { verifyStaffToken, verifyCustomerToken } from './service.js'
import { ForbiddenError, UnauthorizedError } from '../../lib/errors.js'
import type { UserRole } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'

declare module 'fastify' {
  interface FastifyRequest {
    // tenantId is the *active* tenant — whichever the user has switched to.
    // Routes scope their queries by this so a logged-in operator viewing
    // company A doesn't see data from company B that they also own.
    staffUser?: { id: string; email: string; name: string | null; role: UserRole; tenantId: string | null }
    customer?: { id: string }
  }
}

// B01: `requireAuth` only ever accepts an `access` token. A PIN-session
// token belongs at the KDS PIN gate (`requirePinSession`), and a refresh
// token belongs at the refresh route (`requireRefresh`). The two helpers
// below share the same role/tenant plumbing.
async function attachStaffPrincipal(req: FastifyRequest, payload: { sub: string; email: string; role: string }, allowedRoles: UserRole[]) {
  if (allowedRoles.length > 0 && !allowedRoles.includes(payload.role as UserRole)) {
    throw new ForbiddenError(`Role '${payload.role}' is not allowed for this resource`)
  }
  const u = await prisma.user.findUnique({
    where: { id: payload.sub },
    select: { tenantId: true, name: true },
  })
  req.staffUser = {
    id:       payload.sub,
    email:    payload.email,
    name:     u?.name ?? null,
    role:     payload.role as UserRole,
    tenantId: u?.tenantId ?? null,
  }
}

export function requireAuth(...allowedRoles: UserRole[]) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    const authHeader = req.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedError('Missing or malformed Authorization header')
    }
    const token = authHeader.slice(7)
    const payload = verifyStaffToken(token, 'access')
    await attachStaffPrincipal(req, payload, allowedRoles)
  }
}

/**
 * For endpoints that should only accept a short-lived PIN session — typically
 * the KDS station controls. Use this on every `kds/*` route that takes
 * destructive actions (bump/recall/hold/fire).
 */
export function requirePinSession(...allowedRoles: UserRole[]) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    const authHeader = req.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedError('Missing or malformed Authorization header')
    }
    const token = authHeader.slice(7)
    const payload = verifyStaffToken(token, 'pin')
    await attachStaffPrincipal(req, payload, allowedRoles)
  }
}

/**
 * Refresh-token-only gate. Wire this on `POST /auth/refresh` and nowhere
 * else — a refresh token must never authenticate a regular API call.
 */
export async function requireRefresh(req: FastifyRequest, _reply: FastifyReply) {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) {
    throw new UnauthorizedError('Missing or malformed Authorization header')
  }
  const token = authHeader.slice(7)
  const payload = verifyStaffToken(token, 'refresh')
  // No role gate — every staff member should be able to refresh their own session.
  await attachStaffPrincipal(req, payload, [])
}

/**
 * Accepts either an `access` token (for managers/admins browsing) OR a `pin`
 * session token (for KDS / POS-station screens). Use on routes that legitimately
 * serve both contexts — refusing a PIN session here would be a UX regression for
 * line cooks; refusing an access token would block managers from spot-checking.
 */
export function requireAuthOrPin(...allowedRoles: UserRole[]) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    const authHeader = req.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedError('Missing or malformed Authorization header')
    }
    const token = authHeader.slice(7)
    let payload
    try {
      payload = verifyStaffToken(token, 'access')
    } catch (e: unknown) {
      // Fall through to PIN if it wasn't an access token. Anything else
      // (signature mismatch, expired, etc.) is rethrown.
      if ((e as { code?: string }).code !== 'INVALID_TOKEN_TYPE') throw e
      payload = verifyStaffToken(token, 'pin')
    }
    await attachStaffPrincipal(req, payload, allowedRoles)
  }
}

export async function requireCustomerAuth(req: FastifyRequest, _reply: FastifyReply) {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) {
    throw new UnauthorizedError('Missing or malformed Authorization header')
  }

  const token = authHeader.slice(7)
  const payload = verifyCustomerToken(token)
  req.customer = { id: payload.sub }
}

// Roles hierarchy for convenience
export const ADMIN_ONLY: UserRole[] = ['admin']
export const MANAGERS: UserRole[] = ['admin', 'manager']
export const CASHIERS: UserRole[] = ['admin', 'manager', 'cashier']
export const KITCHEN_STAFF: UserRole[] = ['admin', 'manager', 'kitchen', 'expediter']
export const MARKETING_TEAM: UserRole[] = ['admin', 'manager', 'marketing']
export const ALL_STAFF: UserRole[] = ['admin', 'manager', 'cashier', 'kitchen', 'expediter', 'marketing']
