// THE budgeted monthly labour figure (owner decision 25) — one rule, used by
// the Projections labour line and the OpEx payroll budget (and, once wired,
// /positions/summary):
//
//   • Seats: open and filled only. Frozen (and archived) seats are out — a
//     frozen seat is one we have decided not to pay for.
//   • Cost: Position.tenantCostShareCents × headcount — this company's share
//     of a shared or JV seat, not the gross salary.
//   • Contributions are NETTED: what another company pays this one towards
//     shared staff comes off, what this company pays out goes on
//     (TenantContribution, active only).
//   • Head office (D1, after the setup wizard): this company's head-office
//     plan charges go on, and — when this tenant IS a head office — what it
//     recharges to its companies comes off. A `head_office` contribution stops
//     counting once either side is linked to a head office. The head-office
//     part is lib/labour-budget.ts headOfficePlanCharges — the same helper
//     budgetedLabour uses, so the two never disagree. Before the wizard has
//     run every figure is exactly what it was.
//   • One company at a time — a scenario or a budget is one company's.
//
// The ProForma module counted frozen seats and the Projections module never
// netted the contribution, so the OpEx payroll budget and the projections
// labour line disagreed for the same company.

import { prisma } from '../../lib/prisma.js'
import { countedContributions, headOfficePlanCharges, planMonth, type HeadOfficePlanCharge } from '../../lib/labour-budget.js'
import { headOfficeSetupApplied } from '../headOffices/books.js'

export const BUDGETED_SEAT_STATUSES = ['open', 'filled'] as const

export interface MonthlyLabour {
  /** Seats tagged with a brand, by brand. */
  byConcept: Map<string, number>
  /** Seats with no brand (commissary; head-office seats until the setup wizard moves them). */
  companyLevelSeatsCents: number
  /** @deprecated alias of companyLevelSeatsCents — kept for the admin until it reads the new key (D5). */
  headOfficeCents: number
  /** Sum of all seats (brand + company-level), before contributions. */
  seatsCents: number
  grossSalaryCents: number
  headcount: number
  openSeats: number
  incomingContributionCents: number
  outgoingContributionCents: number
  /** "Head office charges (plan)": this company's share of its head offices' seats (after setup). */
  headOfficeChargesCents: number
  headOfficeCharges: HeadOfficePlanCharge[]
  /** When this tenant is a head office: what it recharges to its companies (plan). */
  rechargedOutCents: number
  /** seatsCents + outgoing − incoming + head-office charges − recharged out: what lands on this company's P&L. */
  netCents: number
}

export async function monthlyLabourCents(tenantId: string, opts: { month?: string } = {}): Promise<MonthlyLabour> {
  const applied = await headOfficeSetupApplied()
  const [positions, allContributions] = await Promise.all([
    prisma.position.findMany({
      where: { tenantId, status: { in: [...BUDGETED_SEAT_STATUSES] } },
      select: { conceptId: true, tenantCostShareCents: true, monthlySalaryCents: true, headcount: true, status: true },
    }),
    prisma.tenantContribution.findMany({
      where: { isActive: true, OR: [{ destinationTenantId: tenantId }, { sourceTenantId: tenantId }] },
      select: { sourceTenantId: true, destinationTenantId: true, monthlyCents: true, category: true },
    }),
  ])
  const contributions = await countedContributions(allContributions, applied)
  const byConcept = new Map<string, number>()
  let companyLevelSeatsCents = 0, seatsCents = 0, grossSalaryCents = 0, headcount = 0, openSeats = 0
  for (const p of positions) {
    const cost = p.tenantCostShareCents * p.headcount
    seatsCents += cost
    grossSalaryCents += p.monthlySalaryCents * p.headcount
    headcount += p.headcount
    if (p.status === 'open') openSeats += p.headcount
    if (p.conceptId) byConcept.set(p.conceptId, (byConcept.get(p.conceptId) ?? 0) + cost)
    else companyLevelSeatsCents += cost
  }
  let incomingContributionCents = 0, outgoingContributionCents = 0
  for (const c of contributions) {
    if (c.destinationTenantId === tenantId) incomingContributionCents += c.monthlyCents
    if (c.sourceTenantId === tenantId) outgoingContributionCents += c.monthlyCents
  }
  const plan = await headOfficePlanCharges([tenantId], opts.month ?? planMonth(), { applied })
  return {
    byConcept, companyLevelSeatsCents, headOfficeCents: companyLevelSeatsCents, seatsCents, grossSalaryCents, headcount, openSeats,
    incomingContributionCents, outgoingContributionCents,
    headOfficeChargesCents: plan.chargesMonthlyCents,
    headOfficeCharges: plan.charges,
    rechargedOutCents: plan.rechargedOutMonthlyCents,
    netCents: seatsCents + outgoingContributionCents - incomingContributionCents + plan.chargesMonthlyCents - plan.rechargedOutMonthlyCents,
  }
}
