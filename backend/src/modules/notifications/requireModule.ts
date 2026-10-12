// Module Access gate for a single route — the CEO's untick really closes it.
//
// lib/moduleAccess.ts GATED_PREFIXES is the central gate, run by the auth
// middleware on every staff request. The Dev workspace surfaces opened to IT
// in wave 3 (outbound webhooks, staff push, the email settings read) are not
// in that list, so without this a CEO who unticks `integrations` /
// `notifications` for IT — or a per-login moduleDeny — would change only the
// sidebar. Same source of truth as the central gate (effectiveModulesForUser:
// role override ?? role default, + moduleAllow, − moduleDeny; admin = all).
//
// Use AFTER requireAuth: `preHandler: [requireAuth(...ROLES), requireModule('integrations')]`.
// Fails CLOSED: these are configuration surfaces (one is a platform-wide
// delivery channel), never something a sale or a ticket waits on.
import type { FastifyRequest } from 'fastify'
import type { UserRole } from '@prisma/client'
import { serviceClient as prisma } from '../../lib/prisma.js'
import { effectiveModulesForUser } from '../../lib/moduleAccess.js'
import { ForbiddenError, UnauthorizedError } from '../../lib/errors.js'

export function requireModule(...anyOf: string[]) {
  return async (req: FastifyRequest) => {
    const su = req.staffUser
    if (!su) throw new UnauthorizedError('Sign in first')
    if (su.role === 'admin') return
    const u = await prisma.user.findUnique({
      where: { id: su.id },
      select: { moduleAllow: true, moduleDeny: true },
    })
    const modules = await effectiveModulesForUser({
      role: su.role as UserRole,
      moduleAllow: u?.moduleAllow ?? [],
      moduleDeny: u?.moduleDeny ?? [],
    })
    if (!anyOf.some((m) => modules.has(m))) {
      throw new ForbiddenError(`Your account does not have access to this module (${anyOf[0]}). Ask the CEO to enable it in Module Access.`)
    }
  }
}
