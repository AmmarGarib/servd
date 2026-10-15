// Which company a customer "belongs" to.
//
// Customers are global rows: one phone number is one customer across every
// company. A company owns its relationship with a customer through what the
// customer did at ITS brands — an order or a reservation. Every CRM, wallet,
// strike/ban and conversation route resolves the customer through this before
// reading or touching anything, so company B cannot read, message, credit,
// strike or ban someone who has only ever dealt with company A.
//
// Strikes and bans carry a tenantId column (wave B, 2026-10-14): a row with it
// set belongs to that company and nothing else. Only legacy rows the migration
// could not stamp (NULL) are attributed through their relations here (source
// order/reservation, the staff member who raised them). Conversations still
// have no company column and are attributed in crm/routes.ts.

import type { FastifyRequest } from 'fastify'
import type { Prisma } from '@prisma/client'
import { prisma } from '../../lib/prisma.js'
import { NotFoundError } from '../../lib/errors.js'
import { scopeTenantWhere, type ScopeMode, type TenantIdWhere } from '../../lib/tenantScope.js'

/** The tenant ids a scope fragment admits, as a plain list. */
export function tenantIdsOf(t: TenantIdWhere): string[] {
  return typeof t.tenantId === 'string' ? [t.tenantId] : t.tenantId.in
}

/** Customers with an order or a reservation at one of these companies' brands. */
export function customerOfCompanies(t: TenantIdWhere): Prisma.CustomerWhereInput {
  return {
    OR: [
      { orders:       { some: { deletedAt: null, concept: { ...t, deletedAt: null } } } },
      { reservations: { some: { concept: { ...t, deletedAt: null } } } },
    ],
  }
}

/** `customerOfCompanies` for the request's companies in `mode`. */
export async function customerScopeWhere(req: FastifyRequest, mode: ScopeMode = 'read'): Promise<Prisma.CustomerWhereInput> {
  return customerOfCompanies(await scopeTenantWhere(req, mode))
}

/**
 * The customer, or 404 when they have never ordered or booked at a brand of
 * the request's companies (in `mode`). 404 rather than 403 so a foreign id
 * does not confirm the customer exists. Use 'create' when binding something
 * NEW to the customer (a wallet credit, a strike, a conversation) so it
 * lands in the active company only.
 */
export async function findCustomerInScope(req: FastifyRequest, id: string, mode: ScopeMode) {
  const customer = await prisma.customer.findFirst({
    where: { id, deletedAt: null, ...(await customerScopeWhere(req, mode)) },
  })
  if (!customer) throw new NotFoundError('Customer', id)
  return customer
}

/** The subset of `ids` that are customers of the request's companies. */
export async function customerIdsInScope(req: FastifyRequest, ids: string[], mode: ScopeMode): Promise<Set<string>> {
  if (ids.length === 0) return new Set()
  const rows = await prisma.customer.findMany({
    where: { id: { in: ids }, deletedAt: null, ...(await customerScopeWhere(req, mode)) },
    select: { id: true },
  })
  return new Set(rows.map((r) => r.id))
}

/** Every company each user belongs to (primary + memberships). */
export async function companiesOfUsers(userIds: string[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>()
  const ids = [...new Set(userIds.filter(Boolean))]
  if (ids.length === 0) return out
  const users = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, tenantId: true, tenantMemberships: { select: { tenantId: true } } },
  })
  for (const u of users) {
    const s = new Set<string>(u.tenantMemberships.map((m) => m.tenantId))
    if (u.tenantId) s.add(u.tenantId)
    out.set(u.id, s)
  }
  return out
}

/** Prisma `where` on a User: a member (primary or TenantMember) of one of these companies. */
export function userOfCompanies(t: TenantIdWhere): Prisma.UserWhereInput {
  return { OR: [t, { tenantMemberships: { some: t } }] }
}

// ─── Strikes ────────────────────────────────────────────────────────────────

type StrikeRow = { id: string; customerId: string; sourceType: string | null; sourceId: string | null; recordedById: string | null; tenantId: string | null }

/**
 * The companies each strike belongs to: its tenantId column when set (the one
 * company). For a legacy NULL row only, by precedence:
 *   source order/reservation → that brand's company;
 *   else (a manual strike) → the companies of the staff member who recorded it;
 *   else (a system strike with no source, legacy) → null, meaning "any company
 *   that serves this customer" — callers gate that on customer scope.
 * Each fallback applies only when the field above it is empty.
 */
export async function strikeCompanies(strikes: StrikeRow[]): Promise<Map<string, Set<string> | null>> {
  const out = new Map<string, Set<string> | null>()
  for (const s of strikes) if (s.tenantId) out.set(s.id, new Set([s.tenantId]))
  const legacy = strikes.filter((s) => !s.tenantId)
  if (legacy.length === 0) return out
  const orderIds = legacy.filter((s) => s.sourceType === 'order' && s.sourceId).map((s) => s.sourceId!)
  const resIds = legacy.filter((s) => s.sourceType === 'reservation' && s.sourceId).map((s) => s.sourceId!)
  const [orders, reservations, users] = await Promise.all([
    orderIds.length ? prisma.order.findMany({ where: { id: { in: orderIds } }, select: { id: true, concept: { select: { tenantId: true } } } }) : [],
    resIds.length ? prisma.reservation.findMany({ where: { id: { in: resIds } }, select: { id: true, concept: { select: { tenantId: true } } } }) : [],
    companiesOfUsers(legacy.filter((s) => !s.sourceType && s.recordedById).map((s) => s.recordedById!)),
  ])
  const orderT = new Map(orders.map((o) => [o.id, o.concept.tenantId]))
  const resT = new Map(reservations.map((r) => [r.id, r.concept.tenantId]))
  for (const s of legacy) {
    if (s.sourceType === 'order' && s.sourceId) {
      const t = orderT.get(s.sourceId)
      out.set(s.id, new Set(t ? [t] : []))
    } else if (s.sourceType === 'reservation' && s.sourceId) {
      const t = resT.get(s.sourceId)
      out.set(s.id, new Set(t ? [t] : []))
    } else if (s.recordedById) {
      out.set(s.id, users.get(s.recordedById) ?? new Set())
    } else {
      out.set(s.id, null)
    }
  }
  return out
}

/** True when a strike attributed to `companies` falls in `scope`. `null` = legacy/unattributable, allowed only for an in-scope customer. */
export function inCompanies(companies: Set<string> | null | undefined, scope: string[], customerInScope: boolean): boolean {
  if (companies === null) return customerInScope
  if (!companies) return false
  return scope.some((t) => companies.has(t))
}

// ─── Bans ───────────────────────────────────────────────────────────────────

type BanRow = { id: string; customerId: string | null; bannedById: string | null; tenantId: string | null }

/**
 * The companies each ban belongs to: its tenantId column when set. For a legacy
 * NULL row only: a staff-raised ban → the companies of the
 * staff member who raised it; an auto-ban (bannedById null, promoted from
 * strikes) → the companies of that customer's strikes. Decision 15: a ban
 * applies only to — and is only liftable by — the company that raised it.
 */
export async function banCompanies(bans: BanRow[]): Promise<Map<string, Set<string> | null>> {
  const out = new Map<string, Set<string> | null>()
  for (const b of bans) if (b.tenantId) out.set(b.id, new Set([b.tenantId]))
  const legacy = bans.filter((b) => !b.tenantId)
  if (legacy.length === 0) return out
  const users = await companiesOfUsers(legacy.filter((b) => b.bannedById).map((b) => b.bannedById!))
  const autoCustomers = [...new Set(legacy.filter((b) => !b.bannedById && b.customerId).map((b) => b.customerId!))]
  const strikes = autoCustomers.length
    ? await prisma.customerStrike.findMany({
        where: { customerId: { in: autoCustomers }, reversedAt: null },
        select: { id: true, customerId: true, sourceType: true, sourceId: true, recordedById: true, tenantId: true },
      })
    : []
  const sc = await strikeCompanies(strikes)
  const byCustomer = new Map<string, Set<string> | null>()
  for (const s of strikes) {
    const c = sc.get(s.id)
    const cur = byCustomer.get(s.customerId)
    if (c === null || cur === null) { byCustomer.set(s.customerId, null); continue }
    const merged = cur ?? new Set<string>()
    for (const t of c ?? []) merged.add(t)
    byCustomer.set(s.customerId, merged)
  }
  for (const b of legacy) {
    if (b.bannedById) out.set(b.id, users.get(b.bannedById) ?? new Set())
    else if (b.customerId) out.set(b.id, byCustomer.has(b.customerId) ? byCustomer.get(b.customerId)! : null)
    else out.set(b.id, new Set())
  }
  return out
}
