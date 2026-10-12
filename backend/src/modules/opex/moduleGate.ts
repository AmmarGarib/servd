// Module Access gate for the roles wave 3 newly let into a route.
//
// Wave 3 (UI-07 / UI-09) let finance into OpEx, petty cash and deposit drops,
// and HR (and finance, read-only) into positions and the staff-meal log —
// routes that used to be MANAGERS-only. None of those prefixes is in
// lib/moduleAccess.ts GATED_PREFIXES, so without this the CEO unticking
// 'capital' / 'accounting' / 'staff_directory' for finance or HR (or a
// per-login moduleDeny) changed only the sidebar: the routes, some of which
// post to the ledger, stayed open (review W3B-RV-1). Owner decision 34 makes
// Module Access THE control.
//
// The manager tiers (MANAGERS) pass exactly as before: they reached these
// routes without a module check, and not every tier that uses the pages holds
// the module (fnb_manager has 'accounting' but not 'capital'). Narrowing them
// is the central GATED_PREFIXES rule's job, an owner call — not this gate's.
//
// Same source of truth as the central gate (effectiveModulesForUser: role
// override ?? role default, + moduleAllow, − moduleDeny). Fails CLOSED: these
// are back-office surfaces, never something a sale or a ticket waits on.
//
// Use AFTER requireAuth:
//   preHandler: [requireAuth(...ROLES), moduleGateForNewRoles(['capital'])]
import type { FastifyRequest } from 'fastify'
import type { UserRole } from '@prisma/client'
import { serviceClient as prisma } from '../../lib/prisma.js'
import { effectiveModulesForUser } from '../../lib/moduleAccess.js'
import { ForbiddenError, UnauthorizedError } from '../../lib/errors.js'
import { MANAGERS } from '../auth/middleware.js'

export function moduleGateForNewRoles(anyOf: readonly string[], exempt: readonly UserRole[] = MANAGERS) {
  return async (req: FastifyRequest) => {
    const su = req.staffUser
    if (!su) throw new UnauthorizedError('Sign in first')
    if (exempt.includes(su.role as UserRole)) return
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
