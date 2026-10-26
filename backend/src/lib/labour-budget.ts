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
//   • Inter-company contributions (commissary, shared services, and — until
//     the head-office setup — the JV / shared head office) net off: money
//     another company sends us for shared staff lowers our net; money we send
//     raises it. They are company-level, so a brand-scoped budget leaves them
//     out unless the caller asks (`includeContributions`).
//   • One company per scenario: callers pass the companies in scope; a
//     contribution between two of them cancels out.
//
// Head office (D1, spec §8; switch = the setup wizard's marker):
//   • Until the CEO has run "Set up head office from today's records"
//     (headOffices/books.ts headOfficeSetupApplied() false) every number here
//     is exactly what it was before head offices existed: no plan charges, and
//     every active contribution counts.
//   • After it: a company C in scope bears, for each live link (H, C), its
//     share of H's seats — share(H, C, the % table for the month) ×
//     budgetedLabour([H]).shareMonthlyCents (salaries only, the scope the old
//     contribution had) — as `headOfficeCharges`; a head office H in scope
//     shows what it recharges as `rechargedOut`; a pair with both sides in
//     scope cancels. A `head_office` contribution stops counting as soon as
//     either of its companies has a live head-office link (the plan charge
//     replaces it, so there is no gap and no double count).
//   • headOfficePlanCharges is the one helper; budgetedLabour,
//     projections/labour.ts monthlyLabourCents and the OpEx payroll snapshot
//     all read it.

import type { Prisma, PrismaClient } from '@prisma/client'
import { prisma, serviceClient } from './prisma.js'
import { fmtPktDate } from '../modules/accounting/dates.js'
import { headOfficeSetupApplied } from '../modules/headOffices/books.js'
import { splitByBps, splitForOrNull } from '../modules/headOffices/splits.js'

type Db = PrismaClient | Prisma.TransactionClient

/** The seats that are in a budget: open and filled (frozen and archived are out). */
const BUDGET_STATUSES = ['open', 'filled'] as const

/** Labels the planning screens use (spec §8). */
export const PLAN_LABELS = {
  headOfficeCharges: 'Head office charges (plan)',
  companyLevelSeats: 'Company-level seats',
  rechargedOut: 'Recharged to companies (plan)',
} as const

/** The Karachi month of an instant, 'YYYY-MM'. */
export function planMonth(d: Date = new Date()): string {
  return fmtPktDate(d).slice(0, 7)
}

// ─── Head-office plan charges ────────────────────────────────────────────────

export interface HeadOfficePlanCharge {
  headOfficeId: string
  /** The head office's name. */
  name: string
  companyTenantId: string
  companyName: string
  shareBps: number
  monthlyCents: number
}

export interface HeadOfficePlan {
  /** The setup wizard has run (the switch). False → everything below is empty. */
  applied: boolean
  month: string
  /** Charges INTO in-scope companies from head offices outside the scope. */
  charges: HeadOfficePlanCharge[]
  chargesMonthlyCents: number
  /** Charges OUT of in-scope head offices to companies outside the scope. */
  rechargedOut: HeadOfficePlanCharge[]
  rechargedOutMonthlyCents: number
  /** Pairs with both sides in scope: shown for reference, they cancel. */
  internal: HeadOfficePlanCharge[]
}

const LIVE_TENANT = { isActive: true, deletedAt: null } as const

/** Live links (both sides live) touching any of `ids` on either side. */
async function liveLinksTouching(db: Db, ids: readonly string[]) {
  if (ids.length === 0) return []
  return db.headOfficeLink.findMany({
    where: {
      endedAt: null,
      headOffice: { ...LIVE_TENANT, kind: 'head_office' },
      company: { ...LIVE_TENANT, kind: 'company' },
      OR: [{ tenantId: { in: [...ids] } }, { companyTenantId: { in: [...ids] } }],
    },
    select: {
      tenantId: true, companyTenantId: true,
      headOffice: { select: { name: true } }, company: { select: { name: true } },
    },
    orderBy: [{ tenantId: 'asc' }, { companyTenantId: 'asc' }],
  })
}

/** Σ share × headcount of the open and filled seats of `tenantIds` (the budget's salary base). */
export async function seatShareCents(tenantIds: readonly string[], db: Db = serviceClient): Promise<number> {
  if (tenantIds.length === 0) return 0
  const rows = await db.position.findMany({
    where: { tenantId: { in: [...tenantIds] }, status: { in: [...BUDGET_STATUSES] } },
    select: { tenantCostShareCents: true, headcount: true },
  })
  return rows.reduce((s, p) => s + p.tenantCostShareCents * p.headcount, 0)
}

/**
 * THE head-office part of planning (spec §8). For the companies / head offices
 * in `tenantIds`, for `month` ('YYYY-MM', default this Karachi month):
 *   • company C in scope, each live link (H, C):
 *       charge = C's part of splitByBps(H's seat share, H's % table for the month)
 *     (the same rounding the recharge uses, so at 100% the head office nets to 0);
 *   • head office H in scope: rechargedOut = Σ of its charges;
 *   • a pair with both sides in scope cancels (listed under `internal`).
 * A link with no % table in force yet charges nothing (the head office keeps it).
 * Reads run on serviceClient: a company's plan needs its head office's seats,
 * which the company's own (RLS) context cannot see; only aggregates leave here.
 * Before the setup wizard has run it returns an empty plan (today's numbers).
 */
export async function headOfficePlanCharges(
  tenantIds: readonly string[],
  month: string = planMonth(),
  opts: { db?: Db; applied?: boolean } = {},
): Promise<HeadOfficePlan> {
  const db = opts.db ?? serviceClient
  const applied = opts.applied ?? await headOfficeSetupApplied(db)
  const plan: HeadOfficePlan = { applied, month, charges: [], chargesMonthlyCents: 0, rechargedOut: [], rechargedOutMonthlyCents: 0, internal: [] }
  if (!applied || tenantIds.length === 0) return plan
  const scope = new Set(tenantIds)
  const links = await liveLinksTouching(db, tenantIds)
  const hoIds = [...new Set(links.map((l) => l.tenantId))]
  for (const hoId of hoIds) {
    const hoLinks = links.filter((l) => l.tenantId === hoId)
    const split = await splitForOrNull(db, hoId, month)
    if (!split) continue
    const base = await seatShareCents([hoId], db)
    const amounts = new Map(splitByBps(base, split.lines).map((a) => [a.companyTenantId, a]))
    for (const l of hoLinks) {
      const a = amounts.get(l.companyTenantId)
      if (!a) continue
      const row: HeadOfficePlanCharge = {
        headOfficeId: hoId, name: l.headOffice.name, companyTenantId: l.companyTenantId, companyName: l.company.name,
        shareBps: a.shareBps, monthlyCents: a.amountCents,
      }
      const coIn = scope.has(l.companyTenantId)
      const hoIn = scope.has(hoId)
      if (coIn && hoIn) plan.internal.push(row)
      else if (coIn) { plan.charges.push(row); plan.chargesMonthlyCents += row.monthlyCents }
      else if (hoIn) { plan.rechargedOut.push(row); plan.rechargedOutMonthlyCents += row.monthlyCents }
    }
  }
  return plan
}

/** Companies among `ids` that have a live head-office link (the contribution-retirement test). */
export async function companiesWithLiveHeadOffice(ids: readonly string[], db: Db = serviceClient): Promise<Set<string>> {
  const out = new Set<string>()
  if (ids.length === 0) return out
  const rows = await db.headOfficeLink.findMany({
    where: {
      endedAt: null, companyTenantId: { in: [...new Set(ids)] },
      headOffice: { ...LIVE_TENANT, kind: 'head_office' }, company: { ...LIVE_TENANT, kind: 'company' },
    },
    select: { companyTenantId: true },
  })
  for (const r of rows) out.add(r.companyTenantId)
  return out
}

/**
 * Does an (active) contribution count in planning? Every category always does
 * — except a `head_office` one once the setup wizard has run and either of its
 * companies has a live head-office link (the plan charge replaces it).
 */
export function contributionCounts(
  c: { category: string; sourceTenantId: string; destinationTenantId: string },
  applied: boolean,
  linked: ReadonlySet<string>,
): boolean {
  if (!applied || c.category !== 'head_office') return true
  return !linked.has(c.sourceTenantId) && !linked.has(c.destinationTenantId)
}

/** Active contributions touching `tenantIds` that count in planning (see contributionCounts). */
export async function countedContributions<T extends { category: string; sourceTenantId: string; destinationTenantId: string }>(
  rows: T[],
  applied: boolean,
): Promise<T[]> {
  if (!applied || !rows.some((r) => r.category === 'head_office')) return rows
  const parties = rows.filter((r) => r.category === 'head_office').flatMap((r) => [r.sourceTenantId, r.destinationTenantId])
  const linked = await companiesWithLiveHeadOffice(parties)
  return rows.filter((r) => contributionCounts(r, applied, linked))
}

/** The head_office contributions the setup wizard ended (from the applied setup's summary). */
/**
 * The two companies' names on contribution rows the caller can already see.
 * Read through serviceClient: under the company lock (RLS) a request in one
 * company cannot read the counterparty's `tenants` row, so a Prisma include
 * of it came back null and the planning screen answered 500. Only the id and
 * name are taken, of rows the request's own query returned.
 */
async function withContributionTenants<T extends { sourceTenantId: string; destinationTenantId: string }>(rows: T[]) {
  const ids = [...new Set(rows.flatMap((r) => [r.sourceTenantId, r.destinationTenantId]))]
  const tenants = ids.length ? await serviceClient.tenant.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : []
  const byId = new Map(tenants.map((t) => [t.id, t]))
  const named = (id: string) => byId.get(id) ?? { id, name: '' }
  return rows.map((r) => ({ ...r, sourceTenant: named(r.sourceTenantId), destinationTenant: named(r.destinationTenantId) }))
}

async function setupEndedContributionIds(): Promise<string[]> {
  const books = await serviceClient.headOfficeBooks.findMany({
    where: { setupAppliedAt: { not: null }, tenant: { isTest: false } },
    select: { setupSummary: true },
  })
  const ids: string[] = []
  for (const b of books) {
    const ended = (b.setupSummary as { people?: { contributionsEnded?: Array<{ id?: unknown }> } } | null)?.people?.contributionsEnded
    if (Array.isArray(ended)) for (const c of ended) if (typeof c?.id === 'string') ids.push(c.id)
  }
  return ids
}

// ─── The budget ──────────────────────────────────────────────────────────────

export interface LabourBudgetOptions {
  /** Only seats of this brand (null = only company-level seats). Undefined = all seats. */
  conceptId?: string | null
  /** Only seats of these brands. */
  conceptIds?: string[]
  /** Net off inter-company contributions and head-office charges. Default: true when no brand filter is set. */
  includeContributions?: boolean
  /** The month whose head-office % table applies ('YYYY-MM'; default this Karachi month). */
  month?: string
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
  /** Head-office plan charges into the companies in scope (after the setup wizard). */
  headOfficeCharges: HeadOfficePlanCharge[]
  headOfficeChargesMonthlyCents: number
  /** What the head offices in scope recharge to companies outside it (after the setup wizard). */
  rechargedOutMonthlyCents: number
  /** share + outgoing − incoming + head-office charges − recharged out: what hits the P&L. */
  netMonthlyCents: number
  positions: number
  byConcept: Array<{ id: string | null; name: string; grossCents: number; shareCents: number; count: number }>
  byDepartment: Array<{
    id: string; name: string; emoji: string | null
    /** A head-office department: the tenant is a head office (after setup); the old isHeadOffice flag before it. */
    headOffice: boolean
    /** Same value as `headOffice` — kept for the admin until it reads `headOffice`. */
    isHeadOffice: boolean
    grossCents: number; shareCents: number; count: number
  }>
  contributions: Array<{
    id: string; label: string; category: string; monthlyCents: number; internalSplit: unknown; description: string | null
    direction: 'incoming' | 'outgoing'
    sourceTenant: { id: string; name: string }; destinationTenant: { id: string; name: string }
    /**
     * true = a head_office contribution the head-office setup retired (ended by
     * the wizard, or still active but replaced by a live head-office link).
     * Listed for the record only — never in incoming / outgoing / net.
     */
    ended?: true
  }>
}

export async function budgetedLabour(tenantIds: string[], opts: LabourBudgetOptions = {}): Promise<LabourBudget> {
  const brandScoped = opts.conceptId !== undefined || opts.conceptIds !== undefined
  const includeContributions = opts.includeContributions ?? !brandScoped
  const applied = tenantIds.length === 0 ? false : await headOfficeSetupApplied()
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
      tenant: { select: { kind: true } },
    },
  })

  const out: LabourBudget = {
    headcount: 0, openSeats: 0, filledSeats: 0, frozenSeats: 0, frozenShareMonthlyCents: 0,
    grossMonthlyCents: 0, shareMonthlyCents: 0,
    incomingContributionMonthlyCents: 0, outgoingContributionMonthlyCents: 0,
    headOfficeCharges: [], headOfficeChargesMonthlyCents: 0, rechargedOutMonthlyCents: 0,
    netMonthlyCents: 0,
    positions: 0, byConcept: [], byDepartment: [], contributions: [],
  }
  const companyWide = applied ? PLAN_LABELS.companyLevelSeats : 'Company-wide / head office'
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
    const c = byConcept.get(ck) ?? { id: p.conceptId, name: p.concept?.name ?? companyWide, grossCents: 0, shareCents: 0, count: 0 }
    c.grossCents += gross; c.shareCents += share; c.count += p.headcount
    byConcept.set(ck, c)
    if (p.department) {
      // D1: after the setup wizard a head-office department is one that lives
      // in a head office; Department.isHeadOffice is no longer read.
      const headOffice = applied ? p.tenant.kind === 'head_office' : p.department.isHeadOffice
      const d = byDept.get(p.department.id) ?? {
        id: p.department.id, name: p.department.name, emoji: p.department.emoji,
        headOffice, isHeadOffice: headOffice, grossCents: 0, shareCents: 0, count: 0,
      }
      d.grossCents += gross; d.shareCents += share; d.count += p.headcount
      byDept.set(p.department.id, d)
    }
  }

  if (includeContributions && tenantIds.length) {
    const all = await withContributionTenants(await prisma.tenantContribution.findMany({
      where: { isActive: true, OR: [{ destinationTenantId: { in: tenantIds } }, { sourceTenantId: { in: tenantIds } }] },
    }))
    const rows = await countedContributions(all, applied)
    for (const c of rows) {
      const inbound = tenantIds.includes(c.destinationTenantId)
      const outbound = tenantIds.includes(c.sourceTenantId)
      // Between two companies both in scope, it is money moving inside the
      // scenario: it nets to nothing either way.
      if (inbound) out.incomingContributionMonthlyCents += c.monthlyCents
      if (outbound) out.outgoingContributionMonthlyCents += c.monthlyCents
      out.contributions.push({
        id: c.id, label: c.label, category: c.category, monthlyCents: c.monthlyCents, internalSplit: c.internalSplit,
        // The edit form opens from this row; without it a save wiped the note.
        description: c.description,
        direction: inbound ? 'incoming' : 'outgoing', sourceTenant: c.sourceTenant, destinationTenant: c.destinationTenant,
      })
    }
    if (applied) {
      // Retired head_office rows: shown as "ended", never summed. Active ones
      // the head-office link replaced, plus the ones the setup wizard ended
      // (their ids are in the setup summary — not every inactive row ever).
      const counted = new Set(rows.map((c) => c.id))
      const replaced = all.filter((c) => !counted.has(c.id))
      const endedIds = (await setupEndedContributionIds()).filter((id) => !all.some((c) => c.id === id))
      const endedBySetup = endedIds.length ? await withContributionTenants(await prisma.tenantContribution.findMany({
        where: {
          id: { in: endedIds }, isActive: false, category: 'head_office',
          OR: [{ destinationTenantId: { in: tenantIds } }, { sourceTenantId: { in: tenantIds } }],
        },
        orderBy: { startedAt: 'asc' },
      })) : []
      for (const c of [...replaced, ...endedBySetup]) {
        out.contributions.push({
          id: c.id, label: c.label, category: c.category, monthlyCents: c.monthlyCents, internalSplit: c.internalSplit,
          description: c.description,
          direction: tenantIds.includes(c.destinationTenantId) ? 'incoming' : 'outgoing',
          sourceTenant: c.sourceTenant, destinationTenant: c.destinationTenant,
          ended: true,
        })
      }
    }
    if (applied) {
      const plan = await headOfficePlanCharges(tenantIds, opts.month ?? planMonth(), { applied })
      out.headOfficeCharges = plan.charges
      out.headOfficeChargesMonthlyCents = plan.chargesMonthlyCents
      out.rechargedOutMonthlyCents = plan.rechargedOutMonthlyCents
    }
  }
  out.netMonthlyCents = out.shareMonthlyCents + out.outgoingContributionMonthlyCents - out.incomingContributionMonthlyCents
    + out.headOfficeChargesMonthlyCents - out.rechargedOutMonthlyCents
  out.byConcept = Array.from(byConcept.values()).sort((a, b) => b.shareCents - a.shareCents)
  out.byDepartment = Array.from(byDept.values()).sort((a, b) => b.shareCents - a.shareCents)
  return out
}
