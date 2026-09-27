// Budgeted labour — the ONE calculation of what a company's positions commit
// it to each month. Workforce → Positions, OpEx "budgeted payroll", the
// pro-forma labour line and projections all read this; none re-implement it.
//
// Rules (owner decision 25):
//   • Frozen seats are NOT in the budget — they are not being hired or paid.
//     They are still counted, separately, so a screen can show them.
//   • Archived seats are out entirely.
//   • Cost is the company's share (tenantCostShareCents) × headcount; gross is
//     what the people are paid, for reference.
//   • Inter-company contributions (the JV / shared head office) net off: money
//     another company sends us for shared staff lowers our net; money we send
//     raises it. They are company-level, so a brand-scoped budget leaves them
//     out unless the caller asks (`includeContributions`).
//   • One company per scenario: callers pass the companies in scope; a
//     contribution between two of them cancels out.

import { prisma } from './prisma.js'

export interface LabourBudgetOptions {
  /** Only seats of this brand (null = only company-level seats). Undefined = all seats. */
  conceptId?: string | null
  /** Only seats of these brands. */
  conceptIds?: string[]
  /** Net off inter-company contributions. Default: true when no brand filter is set. */
  includeContributions?: boolean
}

export interface LabourBudget {
  /** Seats in the budget (open + filled). */
  headcount: number
  openSeats: number
  filledSeats: number
  /** Frozen seats — NOT in any total below. */
  frozenSeats: number
  frozenShareMonthlyCents: number
  grossMonthlyCents: number
  shareMonthlyCents: number
  incomingContributionMonthlyCents: number
  outgoingContributionMonthlyCents: number
  /** share + outgoing − incoming: what hits the P&L. */
  netMonthlyCents: number
  positions: number
  byConcept: Array<{ id: string | null; name: string; grossCents: number; shareCents: number; count: number }>
  byDepartment: Array<{ id: string; name: string; emoji: string | null; isHeadOffice: boolean; grossCents: number; shareCents: number; count: number }>
  contributions: Array<{
    id: string; label: string; category: string; monthlyCents: number; internalSplit: unknown
    direction: 'incoming' | 'outgoing'
    sourceTenant: { id: string; name: string }; destinationTenant: { id: string; name: string }
  }>
}

export async function budgetedLabour(tenantIds: string[], opts: LabourBudgetOptions = {}): Promise<LabourBudget> {
  const brandScoped = opts.conceptId !== undefined || opts.conceptIds !== undefined
  const includeContributions = opts.includeContributions ?? !brandScoped
  const positions = tenantIds.length === 0 ? [] : await prisma.position.findMany({
    where: {
      tenantId: { in: tenantIds },
      status: { in: ['open', 'filled', 'frozen'] },
      ...(opts.conceptId !== undefined && { conceptId: opts.conceptId }),
      ...(opts.conceptIds !== undefined && { conceptId: { in: opts.conceptIds } }),
    },
    select: {
      conceptId: true, status: true, headcount: true, monthlySalaryCents: true, tenantCostShareCents: true,
      concept: { select: { id: true, name: true } },
      department: { select: { id: true, name: true, emoji: true, isHeadOffice: true } },
    },
  })

  const out: LabourBudget = {
    headcount: 0, openSeats: 0, filledSeats: 0, frozenSeats: 0, frozenShareMonthlyCents: 0,
    grossMonthlyCents: 0, shareMonthlyCents: 0,
    incomingContributionMonthlyCents: 0, outgoingContributionMonthlyCents: 0, netMonthlyCents: 0,
    positions: 0, byConcept: [], byDepartment: [], contributions: [],
  }
  const byConcept = new Map<string, LabourBudget['byConcept'][number]>()
  const byDept = new Map<string, LabourBudget['byDepartment'][number]>()
  for (const p of positions) {
    const share = p.tenantCostShareCents * p.headcount
    if (p.status === 'frozen') {
      out.frozenSeats += p.headcount
      out.frozenShareMonthlyCents += share
      continue
    }
    const gross = p.monthlySalaryCents * p.headcount
    out.positions += 1
    out.headcount += p.headcount
    if (p.status === 'open') out.openSeats += p.headcount
    else out.filledSeats += p.headcount
    out.grossMonthlyCents += gross
    out.shareMonthlyCents += share
    const ck = p.conceptId ?? 'tenant'
    const c = byConcept.get(ck) ?? { id: p.conceptId, name: p.concept?.name ?? 'Company-wide / head office', grossCents: 0, shareCents: 0, count: 0 }
    c.grossCents += gross; c.shareCents += share; c.count += p.headcount
    byConcept.set(ck, c)
    if (p.department) {
      const d = byDept.get(p.department.id) ?? { ...p.department, grossCents: 0, shareCents: 0, count: 0 }
      d.grossCents += gross; d.shareCents += share; d.count += p.headcount
      byDept.set(p.department.id, d)
    }
  }

  if (includeContributions && tenantIds.length) {
    const rows = await prisma.tenantContribution.findMany({
      where: { isActive: true, OR: [{ destinationTenantId: { in: tenantIds } }, { sourceTenantId: { in: tenantIds } }] },
      include: { sourceTenant: { select: { id: true, name: true } }, destinationTenant: { select: { id: true, name: true } } },
    })
    for (const c of rows) {
      const inbound = tenantIds.includes(c.destinationTenantId)
      const outbound = tenantIds.includes(c.sourceTenantId)
      // Between two companies both in scope, it is money moving inside the
      // scenario: it nets to nothing either way.
      if (inbound) out.incomingContributionMonthlyCents += c.monthlyCents
      if (outbound) out.outgoingContributionMonthlyCents += c.monthlyCents
      out.contributions.push({
        id: c.id, label: c.label, category: c.category, monthlyCents: c.monthlyCents, internalSplit: c.internalSplit,
        direction: inbound ? 'incoming' : 'outgoing', sourceTenant: c.sourceTenant, destinationTenant: c.destinationTenant,
      })
    }
  }
  out.netMonthlyCents = out.shareMonthlyCents + out.outgoingContributionMonthlyCents - out.incomingContributionMonthlyCents
  out.byConcept = Array.from(byConcept.values()).sort((a, b) => b.shareCents - a.shareCents)
  out.byDepartment = Array.from(byDept.values()).sort((a, b) => b.shareCents - a.shareCents)
  return out
}
