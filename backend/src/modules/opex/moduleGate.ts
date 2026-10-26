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
// Manager tiers are NOT exempt (owner C2, 2026-10-26: "Make my Module Access
// ticks apply to managers too"): the CEO's ticks on OpEx ('capital'),
// Positions ('staff_directory' | 'capital'), petty cash and deposit drops
// ('accounting') and the staff-meal log ('staff_directory') bind every role
// the same way. The CEO (role admin) holds every module. A manager who lacks
// the module was already refused the PAGE (admin canOpenPath has no manager
// exemption), so only direct API calls change. A box's custodian keeps its
// own non-keeper paths (petty-cash ?mine=1, top-up / spend of a box they hold).
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

export function moduleGateForNewRoles(anyOf: readonly string[], exempt: readonly UserRole[] = []) {
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
