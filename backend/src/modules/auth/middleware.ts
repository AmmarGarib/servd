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

export function requireAuth(...allowedRoles: UserRole[]) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    const authHeader = req.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedError('Missing or malformed Authorization header')
    }

    const token = authHeader.slice(7)
    const payload = verifyStaffToken(token)

    if (allowedRoles.length > 0 && !allowedRoles.includes(payload.role as UserRole)) {
      throw new ForbiddenError(`Role '${payload.role}' is not allowed for this resource`)
    }

    // Resolve current tenant — one DB hit per request. Avoids needing JWT
    // rotation when the user switches tenants in the UI.
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
