import type { FastifyRequest, FastifyReply } from 'fastify'
import { verifyStaffToken, verifyCustomerToken, sessionEnded } from './service.js'
import { endedByDrawerClose } from './sessionEnd.js'
import { ForbiddenError, UnauthorizedError } from '../../lib/errors.js'
import type { UserRole } from '@prisma/client'
// Auth middleware runs BEFORE the RLS context is populated — the whole point
// of these lookups is to figure out who the caller is. Use `serviceClient` so
// the queries don't trip over policies that haven't seen the tenant id yet.
import { serviceClient as prisma } from '../../lib/prisma.js'
import { setRlsContext } from '../../lib/rlsContext.js'
import { isRevoked } from '../../lib/tokenRevocation.js'
import { readCookie, ACCESS_COOKIE } from '../../lib/cookies.js'
import { enforceModuleAccess } from '../../lib/moduleAccess.js'
import { isAccountActive } from './accountStatus.js'
import { ALL_ROLES, DIRECTOR_ROLE } from '../../lib/roles.js'
import { testTenantIds } from '../../lib/testCompany.js'
import { headOfficeReach, rememberReach, routePatternOf, isHoSubmitRoute, isHoPassthrough } from '../../lib/headOffice.js'
import { AppError } from '../../lib/errors.js'

// Staff access token comes from EITHER a Bearer header (tablet / mobile) OR the
// httpOnly session cookie (manager web). The web app no longer holds the token
// in JS at all — the cookie is its credential.
function tokenFromRequest(req: FastifyRequest): string | null {
  const h = req.headers.authorization
  if (h?.startsWith('Bearer ')) return h.slice(7)
  return readCookie(req, ACCESS_COOKIE)
}

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
      // Head office (D1, spec §6): companies the caller REACHES through a
      // head office they are a member of, and is NOT a member of. Empty
      // unless a live HeadOfficeLink exists. Reads may look at them (the
      // lens, or portfolio); writes only through HO_SUBMIT_ROUTES.
      reachTenantIds: string[]
      // Set when this request views a reached company through the lens
      // header: the head offices through which it is reached.
      viaHeadOfficeIds?: string[]
      // Set on an HO_SUBMIT_ROUTES write through the lens header: the
      // reached company the proposal binds to (also `tenantId`).
      submitTenantId?: string
    }
    customer?: { id: string }
  }
}

// B01: `requireAuth` only ever accepts an `access` token. A PIN-session
// token belongs at the KDS PIN gate (`requirePinSession`), and a refresh
// token belongs at the refresh route (`requireRefresh`). The two helpers
// below share the same role/tenant plumbing.
async function attachStaffPrincipal(req: FastifyRequest, payload: { sub: string; email: string | null; role: string; iat?: number }, allowedRoles: UserRole[]) {
  const u = await prisma.user.findUnique({
    where: { id: payload.sub },
    select: { tenantId: true, name: true, role: true, isActive: true, accountStatus: true, deletedAt: true, moduleAllow: true, moduleDeny: true, sessionsEndedAt: true },
  })
  // A sign-in lasts one shift (owner B1, 2026-10-26): the login's till drawer
  // closed, so every session issued before it is over (auth/sessionEnd.ts).
  if (u && endedByDrawerClose(u.sessionsEndedAt, payload.iat)) throw sessionEnded()

  // Authorise on the role stored in the DB, never the one embedded in the JWT.
  // A token minted while someone was an admin keeps saying "admin" until it
  // expires, so demoting them left their existing session at full power —
  // role revocation failed open. The DB is the only live source of truth.
  const liveRole = (u?.role ?? payload.role) as UserRole
  if (allowedRoles.length > 0 && !allowedRoles.includes(liveRole)) {
    throw new ForbiddenError(`Role '${liveRole}' is not allowed for this resource`)
  }
  // Director logins (owner, 2026-10-18) are refused on EVERY route outside
  // DIRECTOR_ROUTES — whatever the route's own role list says (a bare
  // requireAuth(), a catch-all list, the refresh gate). Secure by default: a
  // route added tomorrow is closed to directors without anyone remembering.
  if (liveRole === DIRECTOR_ROLE && !isDirectorRoute(req)) {
    throw new AppError('DIRECTOR_READ_ONLY', 'A director login opens only the Director pages.', 403)
  }

  // Revocation-on-deactivation: a JWT outlives its user's employment unless we
  // re-check status on every request. Without this, a fired/suspended staffer
  // keeps full API access until their token expires.
  if (!u || !isAccountActive(u)) {
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

  // Head-office reach (D1, spec §6.1): companies served by a head office the
  // caller is a member of. One serviceClient query, never cached (an ended
  // link stops reach on the next request), only for callers with
  // memberships. `reachTenantIds` = reached and NOT a member (the lens set).
  const reach = memberTenantIds.size > 0 ? await headOfficeReach(Array.from(memberTenantIds)) : new Map<string, string[]>()
  rememberReach(req, reach)
  const reachTenantIds = Array.from(reach.keys()).filter((id) => !memberTenantIds.has(id))
  const reachSet = new Set(reachTenantIds)

  // Per-request active-tenant override. When the operator is in portfolio
  // view and uses an inline company picker on a create modal, the frontend
  // sends `x-servd-active-tenant: <id>` so the WRITE lands in the picked
  // company without forcing the session out of portfolio mode. Validated
  // against the user's tenant memberships.
  //
  // A REACHED company in the header is the head-office lens (spec §6.2):
  //   • GET/HEAD           → read that company (effective = header)
  //   • HO_SUBMIT_ROUTES   → propose in it (effective = submitTenantId = header)
  //   • HO_PASSTHROUGH     → header ignored (the route resolves the company)
  //   • anything else      → 403 HEAD_OFFICE_SUBMIT_ONLY
  // Any OTHER company in the header on a write answers 403
  // COMPANY_HEADER_NOT_ALLOWED — but only for a caller who has reach (so
  // nothing changes for anyone until a head office is linked); otherwise it
  // is ignored as before.
  const headerRaw = req.headers['x-servd-active-tenant']
  const header = typeof headerRaw === 'string' && headerRaw ? headerRaw : null
  const method = (req.method ?? 'GET').toUpperCase()
  let effectiveTenantId = u?.tenantId ?? null
  let viaHeadOfficeIds: string[] | undefined
  let submitTenantId: string | undefined
  let lensRead = false
  if (header && memberTenantIds.has(header)) {
    effectiveTenantId = header
  } else if (header && reachSet.has(header)) {
    const route = routePatternOf(req)
    if (isGet) {
      effectiveTenantId = header
      viaHeadOfficeIds = [...(reach.get(header) ?? [])]
      lensRead = true
    } else if (isHoSubmitRoute(method, route)) {
      effectiveTenantId = header
      submitTenantId = header
      viaHeadOfficeIds = [...(reach.get(header) ?? [])]
    } else if (isHoPassthrough(method, route)) {
      // ignored: effective stays the caller's own company
    } else {
      throw await headOfficeSubmitOnly(header, reach.get(header) ?? [])
    }
  } else if (header && !isGet) {
    const route = routePatternOf(req)
    if (reachTenantIds.length > 0 && !isHoPassthrough(method, route)) {
      throw new AppError(
        'COMPANY_HEADER_NOT_ALLOWED',
        'You are not a member of the company this change was sent for — pick one of your companies and try again.',
        403,
      )
    }
    req.log?.debug?.({ userId: payload.sub, route }, 'x-servd-active-tenant names a company the caller is not a member of — ignored')
  }

  // tenantFilter resolves differently for reads vs writes:
  //   • GET in portfolio view → every tenant I belong to, plus every company
  //     I reach through a head office (the lens, read-only)
  //   • GET single-tenant view → my primary company; the reached company
  //     when the head-office lens header names one
  //   • non-GET (PATCH/DELETE/POST gating) → ALWAYS expand to every tenant
  //     I belong to (plus the lens company on a head-office submit route).
  //     A head-office staffer editing a row in Bukhari's concept shouldn't
  //     get a 404 just because their primary is Clifton — they're a member
  //     of both, the write should land. Reach never widens a write.
  let tenantFilter: string | { in: string[] } | null = u?.tenantId ?? null
  if (lensRead && !portfolio) {
    tenantFilter = effectiveTenantId
  } else if (portfolio) {
    const ids = new Set<string>([...memberTenantIds, ...reachTenantIds])
    if (ids.size > 1) tenantFilter = { in: Array.from(ids) }
  } else if (!isGet) {
    const ids = new Set<string>(memberTenantIds)
    if (submitTenantId) ids.add(submitTenantId)
    if (ids.size > 1) tenantFilter = { in: Array.from(ids) }
  }

  // Test companies (lib/testCompany.ts) are left out of a portfolio READ
  // ("All companies" totals) — every one, the active company included, and
  // every reached company. If that leaves nothing (the caller belongs to
  // test companies only), fall back to the active company so the page isn't
  // empty-scoped by accident. Writes (non-GET) keep every member company,
  // exactly as before.
  if (portfolio && typeof tenantFilter === 'object' && tenantFilter !== null) {
    const tests = await testTenantIds()
    if (tests.size > 0) {
      const kept = tenantFilter.in.filter((id) => !tests.has(id))
      if (kept.length === 0 && effectiveTenantId) kept.push(effectiveTenantId)
      tenantFilter = { in: kept }
    }
  }

  req.staffUser = {
    id:       payload.sub,
    email:    payload.email,
    name:     u?.name ?? null,
    role:     liveRole,
    tenantId: effectiveTenantId,
    tenantFilter,
    memberTenantIds: Array.from(memberTenantIds),
    reachTenantIds,
    ...(viaHeadOfficeIds ? { viaHeadOfficeIds } : {}),
    ...(submitTenantId ? { submitTenantId } : {}),
  }

  // Module-access gate — narrows access on the sensitive financial/reporting
  // surfaces according to the CEO's Module Access matrix + this user's own
  // moduleAllow/moduleDeny. Runs AFTER the role gate above; no-ops for admin
  // and for ungated paths. See lib/moduleAccess.ts.
  await enforceModuleAccess(req.url, {
    role: liveRole,
    moduleAllow: u.moduleAllow,
    moduleDeny: u.moduleDeny,
  }, req.method)
  // RLS scope: in single-tenant view, just the active tenant (the reached
  // company through the lens). In portfolio view (or non-GET writes), the
  // same set as tenantFilter above: member ∪ reach for a portfolio read,
  // member ∪ [submitTenantId] for a write. Policies use the same expansion
  // when checking row visibility.
  const rlsTenantIds = (typeof tenantFilter === 'object' && tenantFilter !== null && 'in' in tenantFilter)
    ? tenantFilter.in
    : (effectiveTenantId ? [effectiveTenantId] : [])
  setRlsContext({ tenantIds: rlsTenantIds, staffUserId: payload.sub })
}

// ─── Director logins (owner, 2026-10-18) ────────────────────────────────────
// The ONLY routes a director login reaches: the read-only Director API
// (modules/director — GET only) and the login's own session and password.
// Route PATTERNS (routeOptions.url without /api/v1), method-exact; a `/*`
// entry covers the path and everything under it. Nothing else — not the bell,
// not the time clock, not /hr/me, not any list a catch-all role array admits.
export const DIRECTOR_ROUTES: ReadonlyArray<{ method: string; path: string }> = [
  { method: 'GET',  path: '/director/*' },
  { method: 'HEAD', path: '/director/*' },
  { method: 'GET',  path: '/permissions/me' },
  { method: 'GET',  path: '/auth/account' },
  { method: 'POST', path: '/auth/refresh' },
  { method: 'POST', path: '/auth/logout' },
  { method: 'POST', path: '/auth/password/change-authed' },
]

function isDirectorRoute(req: FastifyRequest): boolean {
  const path = routePatternOf(req)
  if (!path) return false
  const method = (req.method ?? 'GET').toUpperCase()
  return DIRECTOR_ROUTES.some((e) => {
    if (e.method !== method) return false
    if (e.path.endsWith('/*')) {
      const base = e.path.slice(0, -2)
      return path === base || path.startsWith(base + '/')
    }
    return path === e.path
  })
}

// 403 HEAD_OFFICE_SUBMIT_ONLY for a write through the lens that is not a
// head-office submit route. Names the company and head office (one query, on
// the refusal path only).
async function headOfficeSubmitOnly(companyId: string, hoIds: string[]): Promise<AppError> {
  const rows = await prisma.tenant.findMany({ where: { id: { in: [companyId, ...hoIds] } }, select: { id: true, name: true } })
  const name = (id: string) => rows.find((r) => r.id === id)?.name ?? 'that company'
  const company = name(companyId)
  const ho = hoIds.length > 0 ? hoIds.map(name).join(', ') : 'head office'
  return new AppError(
    'HEAD_OFFICE_SUBMIT_ONLY',
    `You are viewing ${company} through ${ho}: this change needs a member of ${company} or the CEO. Use 'Send for approval' where the screen offers it.`,
    403,
  )
}

export function requireAuth(...allowedRoles: UserRole[]) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    const token = tokenFromRequest(req)
    if (!token) {
      throw new UnauthorizedError('Missing authentication')
    }
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
// ADMIN_ONLY stays literally the CEO. This guards the powers that define
// "final boss": roles & module access, staff accounts, and location config.
// `owner` is deliberately EXCLUDED — an owner who could edit roles could
// promote itself to admin and escape the escalation rule below.
export const ADMIN_ONLY = ['admin'] as UserRole[]
// APPROVERS — who may sign off on a submission (recipes, payroll runs,
// reconciliation, tip-pool posting, capex). The CEO plus co-owners. Owners
// approve STAFF work; anything an owner submitted escalates to the CEO, which
// is enforced per-request by assertNotSelfApproval() in lib/separation-of-duties.ts.
export const APPROVERS = ['admin', 'owner'] as UserRole[]
// fnb_manager is a full ops manager (BOH + FOH) — folded into MANAGERS so it
// passes every manager-tier endpoint (reports, kds, inventory, reservations…).
export const MANAGERS = ['admin', 'owner', 'manager', 'management', 'foh_management', 'boh_management', 'fnb_manager'] as UserRole[]
// finance runs the till too (owner, 2026-10-20: "Give finance access to POS"); voids still need a manager.
export const CASHIERS = [...MANAGERS, 'cashier', 'foh', 'finance'] as UserRole[]
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
export const FINANCIALS_VIEWERS = ['admin', 'owner', 'management', 'finance', 'fnb_manager'] as UserRole[]
export const HR_TEAM = [...MANAGERS, 'hr'] as UserRole[]
/**
 * HOW EACH ROLE SIGNS IN.
 *
 * Floor roles hold a shift, not the business: they take orders, cook them and
 * take payment. They sign in with a one-time code sent to their WhatsApp when
 * they ask for it — nothing to remember, nothing to write on a sticker by the
 * till, and nothing that keeps working after they leave and someone else keeps
 * using their number. There is no password on these accounts at all.
 *
 * Everyone else — every manager tier, plus finance, HR, procurement, marketing
 * and the owners — reaches money, payroll, cost and company-wide data. Those
 * sign in with a password, and may add WhatsApp 2FA on top per account.
 *
 * The split is deliberately drawn at "holds a shift" vs "holds the business",
 * because the failure modes are opposite. A floor code that cannot be
 * delivered stops one person starting one shift. A password-holder who can be
 * signed in by anyone holding a phone is a different kind of problem — which
 * is why a manager CANNOT sign in with a code, even though they have a phone
 * on file. Widening this set weakens the strong side; it does not strengthen
 * the weak one.
 */
export const OTP_LOGIN_ROLES = ['cashier', 'foh', 'boh', 'kitchen', 'expediter'] as UserRole[]

/** True when this role signs in with a WhatsApp code instead of a password. */
export function usesOtpLogin(role: UserRole | string | null | undefined): boolean {
  return !!role && (OTP_LOGIN_ROLES as string[]).includes(role)
}

// Every staff role — derived from the Prisma enum (lib/roles.ts), so a role
// added to the schema can sign in without anyone remembering this list —
// EXCEPT `director` (owner, 2026-10-18): a director is read-only on its own
// brands and is admitted only where a route names it (and DIRECTOR_ROUTES
// above lists it). A catch-all list must never let a director in.
export const ALL_STAFF = ALL_ROLES.filter((r) => r !== DIRECTOR_ROLE) as UserRole[]
// Every login, directors included — only for the login's OWN session and
// password routes (each also in DIRECTOR_ROUTES).
export const EVERY_LOGIN = [...ALL_ROLES] as UserRole[]

// The owner-escalation / separation-of-duties rule lives in ONE place:
// lib/separation-of-duties.ts assertNotSelfApproval (CEO exempt, flags every
// blocked attempt). The second copy that used to live here is gone.
