import type { FastifyRequest, FastifyReply } from 'fastify'
import { verifyStaffToken, verifyCustomerToken } from './service.js'
import { ForbiddenError, UnauthorizedError } from '../../lib/errors.js'
import type { UserRole } from '@prisma/client'
// Auth middleware runs BEFORE the RLS context is populated — the whole point
// of these lookups is to figure out who the caller is. Use `serviceClient` so
// the queries don't trip over policies that haven't seen the tenant id yet.
import { serviceClient as prisma } from '../../lib/prisma.js'
import { setRlsContext } from '../../lib/rlsContext.js'
import { isRevoked } from '../../lib/tokenRevocation.js'

// Reject a token that's been logged out or whose subject's sessions were
// invalidated (password change / deactivation / role change). Best-effort:
// see lib/tokenRevocation.ts — a Redis outage fails open.
async function assertNotRevoked(token: string, payload: { sub: string; iat?: number }): Promise<void> {
  if (await isRevoked(token, payload.sub, payload.iat)) {
    throw new UnauthorizedError('Session has been revoked — please sign in again')
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    // tenantId is the *active* tenant — whichever the user has switched to.
    // Always a single string. Used for WRITES (data: { tenantId } in Prisma
    // create) so writes always pin to one company even when the operator is
    // browsing in portfolio mode.
    //
    // tenantFilter is the same value most of the time — except when the user
    // is in portfolio mode (frontend sent `x-servd-portfolio: 1`), in which
    // case it expands to `{ in: [tenant1, tenant2, ...] }`. Drop this into
    // any Prisma `where: { tenantId: req.staffUser!.tenantFilter }` and the
    // single endpoint works in both single-tenant and portfolio contexts.
    staffUser?: {
      // email is nullable post 2026-05-13 — stub workforce rows have no
      // address yet. Routes that fan out notifications must guard on null.
      id: string; email: string | null; name: string | null; role: UserRole
      tenantId: string | null
      tenantFilter: string | { in: string[] } | null
      // Every tenant the user has access to — primary + TenantMember rows,
      // deduped. Use this for PATCH/DELETE gating where the row's tenant is
      // resolved via a relation (e.g. "this category belongs to a concept
      // whose tenant should be one I can access"). `tenantFilter` is for
      // SELECT filters; `memberTenantIds` is for "do I belong here?" checks.
      memberTenantIds: string[]
    }
    customer?: { id: string }
  }
}

// B01: `requireAuth` only ever accepts an `access` token. A PIN-session
// token belongs at the KDS PIN gate (`requirePinSession`), and a refresh
// token belongs at the refresh route (`requireRefresh`). The two helpers
// below share the same role/tenant plumbing.
async function attachStaffPrincipal(req: FastifyRequest, payload: { sub: string; email: string | null; role: string }, allowedRoles: UserRole[]) {
  if (allowedRoles.length > 0 && !allowedRoles.includes(payload.role as UserRole)) {
    throw new ForbiddenError(`Role '${payload.role}' is not allowed for this resource`)
  }
  const u = await prisma.user.findUnique({
    where: { id: payload.sub },
    select: { tenantId: true, name: true, isActive: true, accountStatus: true, deletedAt: true },
  })

  // Revocation-on-deactivation: a JWT outlives its user's employment unless we
  // re-check status on every request. Without this, a fired/suspended staffer
  // keeps full API access until their token expires.
  if (!u || !u.isActive || u.deletedAt !== null || u.accountStatus !== 'active') {
    throw new UnauthorizedError('Account is no longer active')
  }

  // Portfolio mode: when the frontend has flipped "All companies" on, every
  // GET carries `x-servd-portfolio: 1`. Expand the tenant filter to every
  // tenant the user is a member of so cross-tenant rollups (chain, expo
  // queue across both kitchens, etc.) return the full picture.
  const isGet = ['GET', 'HEAD'].includes(req.method?.toUpperCase() ?? 'GET')
  const portfolio = req.headers['x-servd-portfolio'] === '1' && isGet

  // Pull every tenant the operator is a member of — used both for portfolio
  // expansion AND for validating the per-request active-tenant header below.
  const memberships = await prisma.tenantMember.findMany({
    where: { userId: payload.sub },
    select: { tenantId: true },
  })
  const memberTenantIds = new Set<string>(memberships.map((m) => m.tenantId))
  if (u?.tenantId) memberTenantIds.add(u.tenantId)

  // tenantFilter resolves differently for reads vs writes:
  //   • GET in portfolio view → expand to every tenant I belong to
  //   • GET single-tenant view → just my active tenant (view-aware)
  //   • non-GET (PATCH/DELETE/POST gating) → ALWAYS expand to every tenant
  //     I belong to. A head-office staffer editing a row in Bukhari's
  //     concept shouldn't get a 404 just because their primary is Clifton
  //     — they're a member of both, the write should land.
  let tenantFilter: string | { in: string[] } | null = u?.tenantId ?? null
  if (memberTenantIds.size > 1 && (portfolio || !isGet)) {
    tenantFilter = { in: Array.from(memberTenantIds) }
  }

  // Per-request active-tenant override. When the operator is in portfolio
  // view and uses an inline company picker on a create modal, the frontend
  // sends `x-servd-active-tenant: <id>` so the WRITE lands in the picked
  // company without forcing the session out of portfolio mode. Validated
  // against the user's tenant memberships — silently ignored if invalid.
  const headerActive = req.headers['x-servd-active-tenant']
  let effectiveTenantId = u?.tenantId ?? null
  if (typeof headerActive === 'string' && headerActive && memberTenantIds.has(headerActive)) {
    effectiveTenantId = headerActive
  }

  req.staffUser = {
    id:       payload.sub,
    email:    payload.email,
    name:     u?.name ?? null,
    role:     payload.role as UserRole,
    tenantId: effectiveTenantId,
    tenantFilter,
    memberTenantIds: Array.from(memberTenantIds),
  }
  // RLS scope: in single-tenant view, just the active tenant. In portfolio
  // view (or non-GET writes), expand to every tenant the operator belongs
  // to — matches how tenantFilter is computed above. Policies use the same
  // expansion when checking row visibility.
  const rlsTenantIds = (typeof tenantFilter === 'object' && tenantFilter !== null && 'in' in tenantFilter)
    ? tenantFilter.in
    : (effectiveTenantId ? [effectiveTenantId] : [])
  setRlsContext({ tenantIds: rlsTenantIds, staffUserId: payload.sub })
}

export function requireAuth(...allowedRoles: UserRole[]) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    const authHeader = req.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedError('Missing or malformed Authorization header')
    }
    const token = authHeader.slice(7)
    const payload = verifyStaffToken(token, 'access')
    await assertNotRevoked(token, payload)
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
    await assertNotRevoked(token, payload)
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
  await assertNotRevoked(token, payload)
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
    await assertNotRevoked(token, payload)
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
  await assertNotRevoked(token, payload)
  req.customer = { id: payload.sub }
  setRlsContext({ customerId: payload.sub })
}

// Role groupings. `manager` is the legacy alias retained for back-compat with
// accounts created before the enum expansion — every new "management"-tier
// staff member should be either `management`, `foh_management`, or
// `boh_management`. The groupings below all include `manager` so old accounts
// keep working.
//
// `as UserRole[]` is needed at construction time because Prisma's generated
// UserRole type only refreshes when `prisma generate` succeeds (which can fail
// transiently on Windows if a dev process holds the DLL). The migration adds
// the values; the cast keeps TS happy until the next clean generate.
export const ADMIN_ONLY = ['admin'] as UserRole[]
// fnb_manager is a full ops manager (BOH + FOH) — folded into MANAGERS so it
// passes every manager-tier endpoint (reports, kds, inventory, reservations…).
export const MANAGERS = ['admin', 'manager', 'management', 'foh_management', 'boh_management', 'fnb_manager'] as UserRole[]
export const CASHIERS = [...MANAGERS, 'cashier', 'foh'] as UserRole[]
export const KITCHEN_STAFF = [...MANAGERS, 'kitchen', 'expediter', 'boh', 'boh_management'] as UserRole[]
// brand_manager is marketing-tier (NOT a full ops manager) — added to the
// marketing team only, so it reaches CRM/reviews/campaigns + the Brand
// dashboard endpoints without inheriting refund/comp/PO authority.
export const MARKETING_TEAM = [...MANAGERS, 'marketing', 'brand_manager'] as UserRole[]
export const PROCUREMENT_TEAM = [...MANAGERS, 'procurement'] as UserRole[]
export const FINANCE_TEAM = [...MANAGERS, 'finance'] as UserRole[]
// Narrow tier for COMPANY-LEVEL FINANCIALS (P&L, ledger, exec revenue dashboards,
// revenue reports). Per owner policy: finance officer, CEO/exec, and the F&B
// manager only — operational managers (manager / foh_management / boh_management)
// are deliberately excluded. 'management' is the CEO/exec role; 'admin' is the
// owner superuser. Keep this DISTINCT from FINANCE_TEAM (which is intentionally
// broad: MANAGERS + finance, for non-confidential finance-adjacent endpoints).
export const FINANCIALS_VIEWERS = ['admin', 'management', 'finance', 'fnb_manager'] as UserRole[]
export const HR_TEAM = [...MANAGERS, 'hr'] as UserRole[]
export const ALL_STAFF = [
  'admin', 'manager', 'management', 'foh_management', 'boh_management',
  'foh', 'boh', 'kitchen', 'expediter', 'cashier',
  'procurement', 'marketing', 'brand_manager', 'fnb_manager', 'finance', 'hr',
] as UserRole[]
