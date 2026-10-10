// Fleet agreements — the ONE deliberate crossing of company separation
// (owner, 2026-10-10; docs/rider-app.md).
//
// A rider belongs to one company (Rider.tenantId — the employer, GS Foods).
// That company's fleet may deliver another company's orders only while an
// active FleetAgreement { providerTenantId: rider's company, clientTenantId:
// order's company } exists. Every question "may this rider carry that order?"
// is answered here, so the rule cannot drift between the manual assign, the
// auto-dispatcher and the rider's own session.

import { serviceClient as prisma } from './prisma.js'

/** True when `riderTenantId`'s fleet may carry an order of `orderTenantId`. */
export async function fleetMayCarry(riderTenantId: string | null | undefined, orderTenantId: string | null | undefined): Promise<boolean> {
  if (!riderTenantId || !orderTenantId) return false
  if (riderTenantId === orderTenantId) return true
  const a = await prisma.fleetAgreement.findFirst({
    where: { providerTenantId: riderTenantId, clientTenantId: orderTenantId, isActive: true },
    select: { id: true },
  })
  return !!a
}

/** The client companies a provider's fleet currently delivers for (not incl. itself). */
export async function clientTenantIdsOf(providerTenantId: string): Promise<string[]> {
  const rows = await prisma.fleetAgreement.findMany({
    where: { providerTenantId, isActive: true },
    select: { clientTenantId: true },
  })
  return rows.map((r) => r.clientTenantId)
}

/**
 * For each client company, the companies whose riders may carry its orders:
 * itself plus every provider with an active agreement for it.
 */
export async function fleetCompaniesFor(clientTenantIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>(clientTenantIds.map((t) => [t, [t]]))
  if (clientTenantIds.length === 0) return out
  const rows = await prisma.fleetAgreement.findMany({
    where: { clientTenantId: { in: clientTenantIds }, isActive: true },
    select: { providerTenantId: true, clientTenantId: true },
  })
  for (const r of rows) out.get(r.clientTenantId)?.push(r.providerTenantId)
  return out
}
