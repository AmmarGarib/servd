// THE budgeted monthly labour figure (owner decision 25) — one rule, used by
// the Projections labour line and the OpEx payroll budget (and, once wired,
// /positions/summary):
//
//   • Seats: open and filled only. Frozen (and archived) seats are out — a
//     frozen seat is one we have decided not to pay for.
//   • Cost: Position.tenantCostShareCents × headcount — this company's share
//     of a shared or JV seat, not the gross salary.
//   • JV / head-office contributions are NETTED: what another company pays
//     this one towards shared staff comes off, what this company pays out
//     goes on (TenantContribution, active only).
//   • One company at a time — a scenario or a budget is one company's.
//
// The ProForma module counted frozen seats and the Projections module never
// netted the contribution, so the OpEx payroll budget and the projections
// labour line disagreed for the same company.

import { prisma } from '../../lib/prisma.js'

export const BUDGETED_SEAT_STATUSES = ['open', 'filled'] as const

export interface MonthlyLabour {
  /** Seats tagged with a brand, by brand. */
  byConcept: Map<string, number>
  /** Seats with no brand (head office, commissary). */
  headOfficeCents: number
  /** Sum of all seats (brand + head office), before contributions. */
  seatsCents: number
  grossSalaryCents: number
  headcount: number
  openSeats: number
  incomingContributionCents: number
  outgoingContributionCents: number
  /** seatsCents + outgoing − incoming: what lands on this company's P&L. */
  netCents: number
}

export async function monthlyLabourCents(tenantId: string): Promise<MonthlyLabour> {
  const [positions, contributions] = await Promise.all([
    prisma.position.findMany({
      where: { tenantId, status: { in: [...BUDGETED_SEAT_STATUSES] } },
      select: { conceptId: true, tenantCostShareCents: true, monthlySalaryCents: true, headcount: true, status: true },
    }),
    prisma.tenantContribution.findMany({
      where: { isActive: true, OR: [{ destinationTenantId: tenantId }, { sourceTenantId: tenantId }] },
      select: { sourceTenantId: true, destinationTenantId: true, monthlyCents: true },
    }),
  ])
  const byConcept = new Map<string, number>()
  let headOfficeCents = 0, seatsCents = 0, grossSalaryCents = 0, headcount = 0, openSeats = 0
  for (const p of positions) {
    const cost = p.tenantCostShareCents * p.headcount
    seatsCents += cost
    grossSalaryCents += p.monthlySalaryCents * p.headcount
    headcount += p.headcount
    if (p.status === 'open') openSeats += p.headcount
    if (p.conceptId) byConcept.set(p.conceptId, (byConcept.get(p.conceptId) ?? 0) + cost)
    else headOfficeCents += cost
  }
  let incomingContributionCents = 0, outgoingContributionCents = 0
  for (const c of contributions) {
    if (c.destinationTenantId === tenantId) incomingContributionCents += c.monthlyCents
    if (c.sourceTenantId === tenantId) outgoingContributionCents += c.monthlyCents
  }
  return {
    byConcept, headOfficeCents, seatsCents, grossSalaryCents, headcount, openSeats,
    incomingContributionCents, outgoingContributionCents,
    netCents: seatsCents + outgoingContributionCents - incomingContributionCents,
  }
}
