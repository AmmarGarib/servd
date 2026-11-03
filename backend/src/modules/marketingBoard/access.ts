import type { ScopeMode } from '../../lib/tenantScope.js'
// Who may do what on the marketing board and tracker (owner, 2026-11-03). Contract: ./README.md.
//
//   BOARD_ROLES    — the board's role list (marketing, the brand manager, the executive tier and the intern), on top
//                    of the `marketing_board` module gate (lib/moduleAccess.ts GATED_PREFIXES). Every other role —
//                    ops, kitchen, floor, finance, HR, procurement, IT, director — is refused by the role list.
//   lead           — moves cards between stages and manages boards: the CEO (role admin) or a person the CEO ticked
//                    `marketing_lead` for (per person, never a role). Never an intern (their modules are fixed).
//   intern         — role marketing_intern: sees and works ONLY on cards they are a resource or the owner of.
//   TRACKER_ROLES  — the tracker's manager side, on top of the per-person `marketing_tracker` module.

import type { FastifyRequest } from 'fastify'
import type { UserRole } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { effectiveModulesForUser } from '../../lib/moduleAccess.js'
import { INTERN_ROLE } from '../../lib/roles.js'
import { AppError } from '../../lib/errors.js'

export const BOARD_ROLES = ['admin', 'owner', 'management', 'manager', 'marketing', 'brand_manager', INTERN_ROLE] as UserRole[]
/** The board without the intern: creating cards, deleting, linking library files, the weekly report. */
export const BOARD_STAFF = BOARD_ROLES.filter((r) => r !== INTERN_ROLE) as UserRole[]
export const TRACKER_ROLES = ['admin', 'owner', 'management', 'manager', 'marketing', 'brand_manager'] as UserRole[]
/** Whose own progress page exists: interns, plus marketing staff who may themselves be tracked (designers). */
export const PROGRESS_ROLES = ['marketing', 'brand_manager', INTERN_ROLE] as UserRole[]

export function isIntern(req: FastifyRequest): boolean {
  return req.staffUser?.role === INTERN_ROLE
}

/** The caller's live module set (moduleAllow / moduleDeny read now, never the token). */
export async function modulesOf(userId: string, role: UserRole): Promise<Set<string>> {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { role: true, moduleAllow: true, moduleDeny: true } })
  return effectiveModulesForUser({ role: u?.role ?? role, moduleAllow: u?.moduleAllow ?? [], moduleDeny: u?.moduleDeny ?? [] })
}

/** May the caller move cards between stages / manage boards? The CEO, or a `marketing_lead` holder. */
export async function isLead(req: FastifyRequest): Promise<boolean> {
  const su = req.staffUser
  if (!su) return false
  if (su.role === 'admin') return true
  if (su.role === INTERN_ROLE) return false
  return (await modulesOf(su.id, su.role)).has('marketing_lead')
}

/** Does the caller see board cards (the calendar's board cards follow the board module)? */
export async function seesBoard(req: FastifyRequest): Promise<boolean> {
  const su = req.staffUser
  if (!su) return false
  if (su.role === 'admin') return true
  if (!(BOARD_ROLES as string[]).includes(su.role)) return false
  return (await modulesOf(su.id, su.role)).has('marketing_board')
}

/** Card visibility for an intern: a resource on it or its owner. Empty object for everyone else. */
export function internCardWhere(req: FastifyRequest): Record<string, unknown> {
  if (!isIntern(req)) return {}
  const me = req.staffUser!.id
  return { OR: [{ assigneeId: me }, { resources: { some: { userId: me } } }] }
}

/** 422 unless every id is an active staff member of `tenantId` (its primary company or a membership). */
export async function assertCompanyMembers(tenantId: string, userIds: string[], code = 'RESOURCE_NOT_IN_COMPANY'): Promise<void> {
  const ids = Array.from(new Set(userIds))
  if (ids.length === 0) return
  const found = await prisma.user.findMany({
    where: {
      id: { in: ids }, deletedAt: null, isActive: true,
      OR: [{ tenantId }, { tenantMemberships: { some: { tenantId } } }],
    },
    select: { id: true },
  })
  if (found.length !== ids.length) {
    throw new AppError(code, 'Everyone on a card must be on the staff of the board\'s company', 422)
  }
}

/**
 * One marketing team works for every brand of every company (owner, 2026-11-03: "why are you not showing beanzbakes
 * and Flipd boards? the marketing is done by the same team for them too"): the board, report and tracker read across
 * EVERY company the person belongs to ('write' scope), whatever company view the header is on — never another
 * company's. A card / board write lands in the board's own company. Creating a BOARD still binds the active company.
 */
export function teamMode(mode: ScopeMode): ScopeMode {
  return mode === 'create' ? 'create' : 'write'
}
