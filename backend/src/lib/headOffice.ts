// Head office (D1, owner 2026-10-11) — reach and link lookups.
//
// A head office is a Tenant of kind 'head_office' with its own HR, payroll and
// books. It serves trading companies through HeadOfficeLink rows (one LIVE link
// per pair: endedAt IS NULL, partial unique head_office_links_one_live) and
// recharges them monthly through the existing inter-company engine. It never
// has brands.
//
// "Reach" = the companies a head-office member may SEE (and submit for
// approval in) because their head office serves them. Every lookup here runs
// on serviceClient: the RLS client would only show the caller's own companies,
// and this file is what decides which other companies they reach.
//
// The request-facing helpers at the bottom (spec §6, amendments A1–A3) read
// what the auth middleware (modules/auth/middleware.ts attachStaffPrincipal)
// worked out for this request. With no live HeadOfficeLink rows every one of
// them answers "this request reaches nothing through a head office", so
// today's behaviour is unchanged until the CEO links a head office.

import type { FastifyRequest } from 'fastify'
import type { PrismaClient, Prisma } from '@prisma/client'
import { serviceClient } from './prisma.js'
import { AppError } from './errors.js'
import { appendRlsTenantIds } from './rlsContext.js'

type Db = PrismaClient | Prisma.TransactionClient

/** A tenant that can be relied on: active and not deleted. */
const LIVE_TENANT = { isActive: true, deletedAt: null } as const

/** The where-clause of a live link whose head office and company are both live. */
function liveLinkWhere(extra: Prisma.HeadOfficeLinkWhereInput = {}): Prisma.HeadOfficeLinkWhereInput {
  return {
    ...extra,
    endedAt: null,
    headOffice: { ...LIVE_TENANT, kind: 'head_office' },
    company: { ...LIVE_TENANT, kind: 'company' },
  }
}

/**
 * The companies the given head offices reach: Map<companyId, hoId[]> over LIVE
 * links whose head office and company are both active and not deleted.
 * `memberIds` are the caller's member tenant ids — only the head offices among
 * them count. One query; never cached (a link ended a second ago stops reach).
 */
export async function headOfficeReach(memberIds: readonly string[], db: Db = serviceClient): Promise<Map<string, string[]>> {
  const reach = new Map<string, string[]>()
  if (memberIds.length === 0) return reach
  const links = await db.headOfficeLink.findMany({
    where: liveLinkWhere({ tenantId: { in: [...new Set(memberIds)] } }),
    select: { tenantId: true, companyTenantId: true },
    orderBy: [{ companyTenantId: 'asc' }, { tenantId: 'asc' }],
  })
  for (const l of links) {
    const hos = reach.get(l.companyTenantId)
    if (hos) { if (!hos.includes(l.tenantId)) hos.push(l.tenantId) } else reach.set(l.companyTenantId, [l.tenantId])
  }
  return reach
}

export interface LiveLink {
  id: string
  tenantId: string
  companyTenantId: string
  chargesAccountId: string | null
  startedAt: Date
}

/** The live link between a head office and a company (both live), or null. */
export async function liveLink(hoId: string, companyId: string, db: Db = serviceClient): Promise<LiveLink | null> {
  if (!hoId || !companyId) return null
  return db.headOfficeLink.findFirst({
    where: liveLinkWhere({ tenantId: hoId, companyTenantId: companyId }),
    select: { id: true, tenantId: true, companyTenantId: true, chargesAccountId: true, startedAt: true },
  })
}

/** Ids of the live head offices that serve a company through a live link. */
export async function liveHeadOfficesOf(companyId: string, db: Db = serviceClient): Promise<string[]> {
  if (!companyId) return []
  const links = await db.headOfficeLink.findMany({
    where: liveLinkWhere({ companyTenantId: companyId }),
    select: { tenantId: true },
    orderBy: { tenantId: 'asc' },
  })
  return [...new Set(links.map((l) => l.tenantId))]
}

/** True when the tenant is a head office (whatever its active state). */
export async function isHeadOfficeTenant(id: string | null | undefined, db: Db = serviceClient): Promise<boolean> {
  if (!id) return false
  const t = await db.tenant.findUnique({ where: { id }, select: { kind: true } })
  return t?.kind === 'head_office'
}

/**
 * Refuse a brand (or anything that makes a tenant trade) on a head office:
 * 422 HEAD_OFFICE_HAS_NO_BRANDS. An unknown id passes — the caller's own
 * company check answers that.
 */
export async function assertTradingCompany(id: string | null | undefined, db: Db = serviceClient): Promise<void> {
  if (await isHeadOfficeTenant(id, db)) {
    throw new AppError('HEAD_OFFICE_HAS_NO_BRANDS', 'A head office has no brands, menus or sales — pick a trading company', 422)
  }
}

// ─── Allow-lists (spec §6.4 as amended by A1) ────────────────────────────────
//
// A route is `{ method, path }` where `path` is the Fastify route pattern
// WITHOUT the '/api/v1' prefix (req.routeOptions.url minus '/api/v1'). A path
// ending in '/*' matches every route under that prefix. Both lists are tested
// against the registered routes (tests/headOfficeReach.test.ts, an onRoute
// collector), so a renamed route fails the suite instead of silently opening
// or closing a door.

/**
 * Writes a reach-only caller may make in a reached company with the lens header
 * (x-servd-active-tenant = that company). Each one PROPOSES: it creates or edits
 * the module's own pending item, and the route enforces its own condition with
 * `assertHoMayPropose` (own item only, draft only, …). The write binds to the
 * lens company (`scopeTenantWhere(req, 'create')`).
 *
 * NOT here: `POST /stock-transfers` (A1 — a stock transfer is approved by the
 * company's managers and is never routed to the CEO, so it cannot be an HOD
 * submission in v1; a lens POST answers 403 HEAD_OFFICE_SUBMIT_ONLY).
 */
export const HO_SUBMIT_ROUTES: ReadonlyArray<{ method: string; path: string }> = [
  // Procurement
  { method: 'POST',   path: '/procurement/purchase-orders' },                 // draft
  { method: 'POST',   path: '/procurement/purchase-orders/:id/submit' },      // own PO; always pending through HO
  { method: 'POST',   path: '/procurement/purchase-orders/:id/cancel' },      // own PO, draft or pending
  // Operations
  { method: 'POST',   path: '/recipes' },                                     // iteration only
  { method: 'PUT',    path: '/recipes/:id' },                                 // while in iteration
  { method: 'POST',   path: '/recipes/:id/test-attempts' },                   // while in iteration
  { method: 'POST',   path: '/recipes/:id/submit' },
  { method: 'POST',   path: '/auth/staff/invite' },                           // pending login in the lens company, childRoles
  // HR
  { method: 'POST',   path: '/hr/records/:section' },                         // only a section with ≥1 approval step
  { method: 'PATCH',  path: '/hr/records/:section/:id' },                     // own record, not yet acted on
  { method: 'POST',   path: '/hr/records/:section/:id/submit' },
  { method: 'POST',   path: '/hr/records/:section/:id/cancel' },
  { method: 'POST',   path: '/hr/records/offer/:id/create-employee' },        // only after the offer is approved
  { method: 'POST',   path: '/hr/payroll/runs' },                             // payroll preparation, draft only
  { method: 'POST',   path: '/hr/payroll/runs/:id/recalculate' },
  { method: 'PATCH',  path: '/hr/payroll/payslips/:id' },
  { method: 'DELETE', path: '/hr/payroll/runs/:id' },
  // Finance (JournalRequest, wave 2)
  { method: 'POST',   path: '/accounting/journal-requests' },
  { method: 'PATCH',  path: '/accounting/journal-requests/:id' },
  { method: 'POST',   path: '/accounting/journal-requests/:id/submit' },
  { method: 'POST',   path: '/accounting/journal-requests/:id/withdraw' },
  // Marketing (company rows only; `servd:*` rows are never allowed in-route)
  { method: 'PUT',    path: '/site-layouts/:slug/draft' },
  { method: 'DELETE', path: '/site-layouts/:slug/draft' },
  { method: 'POST',   path: '/site-layouts/:slug/submit' },
  // Dev (PosConnectorChange, wave 2; regenerating secrets is refused in-route)
  { method: 'POST',   path: '/connectors/:kind/change-requests' },
  { method: 'POST',   path: '/connectors/change-requests/:id/withdraw' },
]

/**
 * Writes that IGNORE a reached company's lens header: the request runs as the
 * caller's own company and the route resolves the row's company itself
 * (personal routes, approval decisions, head-office and inter-company routes
 * that take their companies from params / body). A reach-only caller reaches
 * nothing extra here: an approve route widens RLS only after
 * `assertCanApprove` has proven the right (lib/approvalRights.ts).
 */
export const HO_PASSTHROUGH: ReadonlyArray<{ method: string; path: string }> = [
  // Personal: the session, own password / 2FA / PIN, own HR self-service, own
  // device, own time-clock punches, switching the active company (member-only).
  { method: 'POST',   path: '/auth/logout' },
  { method: 'POST',   path: '/auth/refresh' },
  { method: 'POST',   path: '/auth/password/change' },
  { method: 'POST',   path: '/auth/password/change-authed' },
  { method: 'POST',   path: '/auth/2fa/start' },
  { method: 'POST',   path: '/auth/2fa/enable' },
  { method: 'POST',   path: '/auth/2fa/disable' },
  { method: 'POST',   path: '/auth/pin/change' },
  { method: 'POST',   path: '/auth/clock-in' },
  { method: 'POST',   path: '/auth/clock-out' },
  { method: 'POST',   path: '/hr/me/records/:section' },
  { method: 'POST',   path: '/hr/me/swaps/:id/respond' },
  { method: 'POST',   path: '/notifications/register' },
  { method: 'DELETE', path: '/notifications/register' },
  // The bell (2026-10-16): marking your own notifications read (userId wall in the route).
  { method: 'POST',   path: '/notifications/:id/read' },
  { method: 'POST',   path: '/notifications/read-all' },
  { method: 'POST',   path: '/time-clock/punch-in' },
  { method: 'POST',   path: '/time-clock/punch-out' },
  { method: 'POST',   path: '/time-clock/clock-in' },
  { method: 'POST',   path: '/time-clock/clock-out' },
  { method: 'POST',   path: '/tenants/switch/:id' },
  // Approval decisions (spec §7.3): each route's own guard + assertCanApprove decides.
  { method: 'POST',   path: '/procurement/purchase-orders/:id/approve' },
  { method: 'POST',   path: '/procurement/purchase-orders/:id/reject' },
  { method: 'PATCH',  path: '/stock-transfers/:id/approve' },
  { method: 'PATCH',  path: '/stock-transfers/:id/cancel' },
  { method: 'POST',   path: '/recipes/:id/approve' },
  { method: 'POST',   path: '/recipes/:id/reject' },
  { method: 'PATCH',  path: '/auth/staff/:id/approve' },
  { method: 'PATCH',  path: '/auth/staff/:id/reject' },
  { method: 'POST',   path: '/site-layouts/:slug/approve' },
  { method: 'POST',   path: '/site-layouts/:slug/reject' },
  { method: 'POST',   path: '/hr/records/:section/:id/decide' },
  { method: 'POST',   path: '/hr/payroll/runs/:id/approve' },
  { method: 'POST',   path: '/hr/payroll/runs/:id/lock' },
  { method: 'POST',   path: '/hr/payroll/runs/:id/reopen' },
  { method: 'POST',   path: '/hr/payroll/runs/:id/paid' },
  { method: 'POST',   path: '/tip-pools/:id/post' },
  { method: 'POST',   path: '/tip-pools/:id/pay' },
  { method: 'POST',   path: '/accounting/journal-requests/:id/approve' },
  { method: 'POST',   path: '/accounting/journal-requests/:id/reject' },
  { method: 'POST',   path: '/connectors/change-requests/:id/approve' },
  { method: 'POST',   path: '/connectors/change-requests/:id/reject' },
  // Modules that never use the active company (companies from params / body).
  { method: 'POST',   path: '/accounting/intercompany/*' },
  { method: 'PUT',    path: '/accounting/intercompany/*' },
  { method: 'PATCH',  path: '/accounting/intercompany/*' },
  { method: 'DELETE', path: '/accounting/intercompany/*' },
  { method: 'POST',   path: '/head-offices/*' },
  { method: 'PUT',    path: '/head-offices/*' },
  { method: 'PATCH',  path: '/head-offices/*' },
  { method: 'DELETE', path: '/head-offices/*' },
  { method: 'POST',   path: '/approvals/*' },
  { method: 'PUT',    path: '/approvals/*' },
  { method: 'PATCH',  path: '/approvals/*' },
  { method: 'DELETE', path: '/approvals/*' },
]

const API_PREFIX = '/api/v1'

/**
 * The route pattern of this request without '/api/v1' and without a trailing
 * slash (e.g. '/recipes/:id'), or null when Fastify matched no route.
 */
export function routePatternOf(req: FastifyRequest): string | null {
  const url = req.routeOptions?.url
  if (typeof url !== 'string' || url.length === 0) return null
  let path = url.startsWith(API_PREFIX + '/') || url === API_PREFIX ? url.slice(API_PREFIX.length) : url
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1)
  return path || '/'
}

function listMatches(list: ReadonlyArray<{ method: string; path: string }>, method: string, path: string | null): boolean {
  if (!path) return false
  const m = method.toUpperCase()
  for (const e of list) {
    if (e.method.toUpperCase() !== m) continue
    if (e.path.endsWith('/*')) {
      const base = e.path.slice(0, -2)
      if (path === base || path.startsWith(base + '/')) return true
    } else if (e.path === path) {
      return true
    }
  }
  return false
}

/** True when (method, route pattern) is on HO_SUBMIT_ROUTES. */
export function isHoSubmitRoute(method: string, path: string | null): boolean {
  return listMatches(HO_SUBMIT_ROUTES, method, path)
}

/** True when (method, route pattern) is on HO_PASSTHROUGH. */
export function isHoPassthrough(method: string, path: string | null): boolean {
  return listMatches(HO_PASSTHROUGH, method, path)
}

// ─── Request-facing helpers ──────────────────────────────────────────────────
//
// The middleware computes the caller's FULL reach map once per request
// (companies → head offices, member companies included, so a dual member's
// submissions can still be stamped with the head office — A3) and remembers it
// here. `req.staffUser.reachTenantIds` holds only the companies reached and NOT
// a member of (the lens set).

const reachByRequest = new WeakMap<FastifyRequest, Map<string, string[]>>()

/** Middleware only: remember this request's full reach map (headOfficeReach of the member ids). */
export function rememberReach(req: FastifyRequest, reach: Map<string, string[]>): void {
  reachByRequest.set(req, reach)
}

/** This request's full reach map, or an empty map (no head office / middleware not run). */
export function reachMapOf(req: FastifyRequest): Map<string, string[]> {
  return reachByRequest.get(req) ?? new Map()
}

/** Every head office (id) through which the caller reaches the company — member companies included. */
export function reachVia(req: FastifyRequest, companyId: string): string[] {
  return [...(reachMapOf(req).get(companyId) ?? [])]
}

/**
 * The head office this caller submits through for the company, stamped on the
 * item as `viaHeadOfficeId` (A3), or null: the id of a head office the caller is
 * a NON-admin member of that has a LIVE link to the company — even when the
 * caller is also a member of the company (a dual-member HOD's submission still
 * goes to the CEO). The CEO (`admin`) never submits "through head office".
 * Read live (one query) so a link ended a moment ago is not stamped.
 */
export async function viaHeadOfficeForSubmit(req: FastifyRequest, companyId: string): Promise<string | null> {
  const su = req.staffUser
  if (!su || !companyId || su.role === 'admin') return null
  const members = su.memberTenantIds ?? []
  if (members.length === 0) return null
  const live = await headOfficeReach(members)
  const hos = live.get(companyId) ?? []
  return hos[0] ?? null
}

/**
 * A reach-only caller may only PROPOSE (draft / submit) in a reached company;
 * anything else is 403 HEAD_OFFICE_SUBMIT_ONLY. `ok` = the action is an
 * allowed proposal; `what` names it in the message. A member of the company
 * (or a caller who does not reach it at all) is never refused here — the
 * route's own rules apply to them.
 */
export async function assertHoMayPropose(req: FastifyRequest, companyId: string, ok: boolean, what: string): Promise<void> {
  if (ok) return
  if (!isReachOnly(req, companyId)) return
  throw new AppError(
    'HEAD_OFFICE_SUBMIT_ONLY',
    `Through head office you can only send this for approval — ${what} needs a member of that company or the CEO.`,
    403,
  )
}

/** Companies the caller reaches through a head office and is NOT a member of (the lens set). */
export function reachTenantIds(req: FastifyRequest): string[] {
  return [...(req.staffUser?.reachTenantIds ?? [])]
}

/** True when the caller sees the company only through a head office (reached, not a member). */
export function isReachOnly(req: FastifyRequest, tenantId: string): boolean {
  const su = req.staffUser
  if (!su || !tenantId) return false
  if ((su.memberTenantIds ?? []).includes(tenantId)) return false
  return (su.reachTenantIds ?? []).includes(tenantId)
}

/** The (first) head office through which the caller reaches the company, or null. */
export function viaHeadOffice(req: FastifyRequest, tenantId: string): string | null {
  if (!tenantId) return null
  if (req.staffUser?.tenantId === tenantId && req.staffUser.viaHeadOfficeIds?.length) {
    return req.staffUser.viaHeadOfficeIds[0] ?? null
  }
  return reachMapOf(req).get(tenantId)?.[0] ?? null
}

/**
 * Widen this request's RLS context to the given companies — ONLY after a right
 * to touch them has been proven (assertCanApprove, a lens submit). Appends;
 * never narrows.
 */
export function widenRls(_req: FastifyRequest, tenantIds: readonly string[]): void {
  appendRlsTenantIds(tenantIds)
}
