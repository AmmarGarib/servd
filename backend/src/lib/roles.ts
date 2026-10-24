import { UserRole as UserRoleEnum, type UserRole } from '@prisma/client'

/**
 * THE staff role list — one source for every role catalogue in the system.
 *
 * It used to be copied into eight places (auth STAFF_ROLE_VALUES, the
 * permission-matrix ROLES, the matrix seed, ALL_STAFF, CONCEPT_BYPASS_ROLES,
 * the module-access defaults, the admin's AppRole list and Workforce's
 * categories) and they had drifted: Workforce offered fnb_manager and
 * brand_manager, the API rejected both with a 400; 'owner' could not be set in
 * Module Access; legacy 'manager' had no admin entry at all.
 *
 * Everything below is derived from the Prisma `UserRole` enum, so a new role
 * added to schema.prisma appears here without anyone remembering to copy it.
 * The admin app reads these lists from GET /permissions/role-modules — it does
 * not keep its own copy of which roles exist or may be assigned.
 */

/** Every role the database knows, in schema order. */
export const ALL_ROLES: readonly UserRole[] = Object.values(UserRoleEnum) as UserRole[]

/**
 * Roles kept only so old rows still parse. Nobody may be GIVEN one of these.
 * 'manager' predates the management tiers; per the owner (decision 7,
 * 2026-09-27) every legacy manager becomes `foh_management` — see the data
 * migration in the reconcile report.
 */
export const LEGACY_ROLES: readonly UserRole[] = ['manager'] as UserRole[]

/**
 * Roles the CEO may assign to a staff account (POST/PATCH /auth/users).
 * Everything except the CEO seat itself and the legacy roles. `admin` is
 * added back only on the CEO-only endpoints, so the founder can name a
 * successor, and never on anything a non-CEO can reach.
 */
export const ASSIGNABLE_ROLES: readonly UserRole[] = ALL_ROLES.filter(
  (r) => r !== 'admin' && !LEGACY_ROLES.includes(r),
)

/**
 * Director logins (owner, 2026-10-18): "a new category of login, 'Director'.
 * For Yusuf and Ali, partners in Flipd, to be able to see how business is
 * doing." Read-only, and only the brands on their login
 * (User.directorConceptIds), through GET /director/*. The role is SECURE BY
 * DEFAULT: the auth middleware refuses it on every route outside a short
 * allow-list (auth/middleware.ts DIRECTOR_ROUTES), it is not in ALL_STAFF,
 * no workspace owner but the CEO may add one (lib/workspaces.ts CHILD_ROLES),
 * and its modules are fixed (lib/moduleAccess.ts DIRECTOR_MODULES).
 */
export const DIRECTOR_ROLE = 'director' as UserRole

export function isDirectorRole(role: string | null | undefined): boolean {
  return role === DIRECTOR_ROLE
}

/** ASSIGNABLE_ROLES plus `admin` — for the CEO-only staff editor. */
export const ASSIGNABLE_ROLES_WITH_ADMIN: readonly UserRole[] = ['admin', ...ASSIGNABLE_ROLES] as UserRole[]

/**
 * Who may approve an over-cap action with their manager PIN: POS discounts,
 * price overrides, voids, comps, refunds, payouts, petty-cash top-ups and
 * staff meals. Owner decision 7 (2026-09-27), verbatim.
 *
 * Also the "manager cap" tier at the till: a member of this list rings up to
 * the manager caps under their own session instead of the cashier caps.
 *
 * Legacy 'manager' is deliberately absent — those accounts are migrated to
 * foh_management in the same deploy.
 */
export const OVERRIDE_APPROVERS: readonly UserRole[] = [
  'admin', 'owner', 'management', 'fnb_manager', 'foh_management', 'boh_management',
] as UserRole[]

/**
 * Who may approve CANCELLING A WHOLE TICKET at the till (POST /orders/:id/cancel), by signing in or by PIN:
 * the override approvers plus finance (owner, 2026-10-24: "Hasnain should also have manager pin to cancel
 * ticket with reason"). Only that action — finance approves no void, refund, comp, discount or pay-out.
 */
export const TICKET_CANCEL_APPROVERS: readonly UserRole[] = [...OVERRIDE_APPROVERS, 'finance'] as UserRole[]

/** May this role hold an override PIN at all (an override approver, or finance for ticket cancels)? */
export function canHoldOverridePin(role: string | null | undefined): boolean {
  return !!role && (TICKET_CANCEL_APPROVERS as readonly string[]).includes(role)
}

export function isOverrideApprover(role: string | null | undefined): boolean {
  return !!role && (OVERRIDE_APPROVERS as readonly string[]).includes(role)
}

/**
 * Who may clock in without the geofence / selfie check: the CEO and the
 * co-owners, who move between sites. Every manager tier still punches at a
 * company location like anyone else (owner decision 37 lets them punch at
 * ANY of the company's locations, which is the relief they need). Widening
 * this to the whole management tier is an owner call, not a code default.
 */
export const GEOFENCE_EXEMPT: readonly UserRole[] = ['admin', 'owner']

export function isGeofenceExempt(role: string | null | undefined): boolean {
  return !!role && (GEOFENCE_EXEMPT as readonly string[]).includes(role)
}

export function isKnownRole(role: string): role is UserRole {
  return (ALL_ROLES as readonly string[]).includes(role)
}

/**
 * Every management tier, including legacy 'manager' until the data migration
 * has moved those accounts to foh_management. The same set as the auth
 * middleware's MANAGERS, for code outside the request path (sockets, workers)
 * that must not import the middleware.
 */
export const MANAGEMENT_TIER: readonly UserRole[] = [...OVERRIDE_APPROVERS, ...LEGACY_ROLES]
