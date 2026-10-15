// Head-office setup, the people and planning half (D1, spec §8 and §14.3).
// Used by the CEO's setup wizard (headOffices/setup.ts) — preview, then apply
// inside the wizard's ONE transaction.
//
// What "today's records" are:
//   • departments flagged Department.isHeadOffice in the companies (the old HO
//     badge inside one company) and their brand-less seats (conceptId null) —
//     the shared head-office staff the companies carry today;
//   • active TenantContribution rows of category head_office (the old "the JV
//     pays 500k towards head-office salaries" planning figure);
//   • seats whose cost share differs from gross (the retired cost-share input).
//
// What apply does with them (applyHeadOfficePeople):
//   1. copies each head-office department into the head office (by name);
//   2. moves the head-office seats into the head office at share = gross (their
//      shift band and designation follow by name, so the seat stays editable);
//   3. normalises every other listed seat to share = gross;
//   4. ends the head_office contributions (isActive false, endedAt now) — the
//      rows stay, read-only.
// Planning totals are the same before and after when the old records were
// consistent (the HO seats' gross = what the companies bore between them):
// the head office's % split then charges each company exactly what its
// contribution netting gave it before. The preview shows both, per company.
//
// Company separation: every read is limited to the companies the caller names
// (the wizard passes only the CEO's own member companies); nothing here
// decides who may run it.

import type { Prisma, PrismaClient } from '@prisma/client'
import { AppError } from '../../lib/errors.js'
import { budgetedLabour, PLAN_LABELS } from '../../lib/labour-budget.js'
import { FULL_BPS, splitByBps, type SplitLineInput } from '../headOffices/splits.js'

type Db = PrismaClient | Prisma.TransactionClient
type Tx = Prisma.TransactionClient

/** Planning seats: open and filled (frozen and archived are not in a budget). */
const BUDGET_STATUSES = new Set(['open', 'filled'])

/**
 * The owner's answer (2026-10-15): GS Foods 37.5% / GS x Viva 62.5% (500k of
 * 800k). Used only when the split cannot be worked out from today's records.
 */
export const OWNER_DEFAULT_SPLIT: ReadonlyArray<{ slug: string; shareBps: number }> = [
  { slug: 'gs-foods-bukhari', shareBps: 3750 },
  { slug: 'gs-x-viva-clifton', shareBps: 6250 },
]

export interface PlanningRow {
  tenantId: string
  name: string
  seatsMonthlyCents: number
  /** Contributions out − in (planning only). */
  contributionsNetMonthlyCents: number
  headOfficeChargesMonthlyCents: number
  rechargedOutMonthlyCents: number
  netMonthlyCents: number
}

export interface HeadOfficePeoplePlan {
  hoName: string
  companies: Array<{ id: string; name: string; slug: string; isTest: boolean }>
  contributions: Array<{
    id: string; label: string; monthlyCents: number; description: string | null
    sourceTenantId: string; sourceName: string; destinationTenantId: string; destinationName: string
  }>
  departments: Array<{
    id: string; tenantId: string; companyName: string; name: string; emoji: string | null
    seats: Array<{ id: string; title: string; status: string; headcount: number; monthlySalaryCents: number; tenantCostShareCents: number; filledByUserId: string | null }>
    employees: Array<{ id: string; employeeCode: string; fullName: string; status: string; userId: string | null }>
  }>
  seatsShareNotGross: Array<{ id: string; tenantId: string; title: string; monthlySalaryCents: number; tenantCostShareCents: number; headcount: number; moves: boolean }>
  suggestedSplit: { lines: Array<SplitLineInput & { name: string }>; source: 'records' | 'owner_default' | 'equal'; note: string }
  /** The split the "after" figures use (the one passed in, else the suggestion). */
  split: SplitLineInput[]
  planning: {
    labels: typeof PLAN_LABELS
    before: { companies: PlanningRow[]; portfolioNetMonthlyCents: number }
    after: { companies: PlanningRow[]; headOffice: PlanningRow; portfolioNetMonthlyCents: number }
  }
  /** Logins of the head-office employees and seat holders — candidates for "add as head-office members now" (A3). */
  hodCandidates: Array<{ userId: string; name: string; email: string | null }>
  warnings: string[]
}

type Seat = {
  id: string; tenantId: string; conceptId: string | null; departmentId: string | null; title: string; status: string
  headcount: number; monthlySalaryCents: number; tenantCostShareCents: number; filledByUserId: string | null
}

/** Today's records for the companies: departments, seats, contributions. */
async function readRecords(db: Db, companyIds: readonly string[]) {
  const ids = [...new Set(companyIds)]
  const [companies, departments, seats, contributions] = await Promise.all([
    db.tenant.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, slug: true, isTest: true, kind: true }, orderBy: { name: 'asc' } }),
    db.department.findMany({
      where: { tenantId: { in: ids }, isHeadOffice: true, archivedAt: null },
      select: { id: true, tenantId: true, name: true, emoji: true, order: true },
      orderBy: [{ order: 'asc' }, { name: 'asc' }],
    }),
    db.position.findMany({
      where: { tenantId: { in: ids }, status: { not: 'archived' } },
      select: {
        id: true, tenantId: true, conceptId: true, departmentId: true, title: true, status: true, headcount: true,
        monthlySalaryCents: true, tenantCostShareCents: true, filledByUserId: true,
      },
      orderBy: [{ tenantId: 'asc' }, { title: 'asc' }],
    }),
    db.tenantContribution.findMany({
      where: { isActive: true, OR: [{ sourceTenantId: { in: ids } }, { destinationTenantId: { in: ids } }] },
      select: {
        id: true, category: true, label: true, monthlyCents: true, description: true, sourceTenantId: true, destinationTenantId: true,
        sourceTenant: { select: { name: true } }, destinationTenant: { select: { name: true } },
      },
      orderBy: { startedAt: 'asc' },
    }),
  ])
  const hoDeptIds = new Set(departments.map((d) => d.id))
  const moving = seats.filter((p) => p.conceptId === null && p.departmentId !== null && hoDeptIds.has(p.departmentId))
  const movingIds = new Set(moving.map((p) => p.id))
  return { ids, companies, departments, seats: seats as Seat[], moving: moving as Seat[], movingIds, contributions }
}

/** Σ share × headcount of the planning seats. */
function seatCost(seats: readonly Seat[], share: (s: Seat) => number): number {
  return seats.filter((s) => BUDGET_STATUSES.has(s.status)).reduce((t, s) => t + share(s) * s.headcount, 0)
}

/**
 * The suggested % table. From the records when they are consistent: each
 * company's burden = its head-office seats' share + head_office contributions
 * it pays − those it receives; the burdens must add up to the seats' gross.
 * Otherwise the owner's answer (GS Foods 3750 / GS x Viva 6250) when exactly
 * those two companies are set up; otherwise equal shares.
 */
export function suggestSplit(input: {
  companies: ReadonlyArray<{ id: string; name: string; slug: string }>
  moving: readonly Seat[]
  headOfficeContributions: ReadonlyArray<{ sourceTenantId: string; destinationTenantId: string; monthlyCents: number }>
}): HeadOfficePeoplePlan['suggestedSplit'] {
  const ids = input.companies.map((c) => c.id)
  const nameOf = (id: string) => input.companies.find((c) => c.id === id)?.name ?? id
  const total = seatCost(input.moving, (s) => s.monthlySalaryCents)
  const burden = new Map(ids.map((id) => [id, 0]))
  for (const s of input.moving) if (BUDGET_STATUSES.has(s.status)) burden.set(s.tenantId, (burden.get(s.tenantId) ?? 0) + s.tenantCostShareCents * s.headcount)
  let crossesOut = false
  for (const c of input.headOfficeContributions) {
    if (!burden.has(c.sourceTenantId) || !burden.has(c.destinationTenantId)) { crossesOut = true; continue }
    burden.set(c.sourceTenantId, burden.get(c.sourceTenantId)! + c.monthlyCents)
    burden.set(c.destinationTenantId, burden.get(c.destinationTenantId)! - c.monthlyCents)
  }
  const sum = [...burden.values()].reduce((a, b) => a + b, 0)
  const consistent = total > 0 && !crossesOut && sum === total && [...burden.values()].every((b) => b >= 0)
  if (consistent) {
    const lines = ids.map((id) => ({ companyTenantId: id, shareBps: Math.floor((burden.get(id)! * FULL_BPS) / total) }))
    let residue = FULL_BPS - lines.reduce((a, l) => a + l.shareBps, 0)
    // Residue to the largest burden (ties: lowest company id).
    const order = [...lines].sort((a, b) => (burden.get(b.companyTenantId)! - burden.get(a.companyTenantId)!) || (a.companyTenantId < b.companyTenantId ? -1 : 1))
    for (let i = 0; residue > 0; i = (i + 1) % order.length, residue--) order[i]!.shareBps += 1
    const kept = lines.filter((l) => l.shareBps > 0)
    return {
      lines: kept.map((l) => ({ ...l, name: nameOf(l.companyTenantId) })),
      source: 'records',
      note: `Worked out from today's records: each company's share of the head-office salaries (${(total / 100).toLocaleString('en-PK')} PKR a month) after the head-office contributions`,
    }
  }
  const bySlug = new Map(input.companies.map((c) => [c.slug, c.id]))
  if (ids.length === OWNER_DEFAULT_SPLIT.length && OWNER_DEFAULT_SPLIT.every((d) => bySlug.has(d.slug))) {
    return {
      lines: OWNER_DEFAULT_SPLIT.map((d) => ({ companyTenantId: bySlug.get(d.slug)!, shareBps: d.shareBps, name: nameOf(bySlug.get(d.slug)!) })),
      source: 'owner_default',
      note: "The owner's split (GS Foods 37.5% / GS x Viva 62.5%) — today's records did not add up to one",
    }
  }
  if (ids.length === 0) return { lines: [], source: 'equal', note: 'No companies to split between' }
  const each = Math.floor(FULL_BPS / ids.length)
  const lines = [...ids].sort().map((id, i) => ({ companyTenantId: id, shareBps: each + (i === 0 ? FULL_BPS - each * ids.length : 0), name: nameOf(id) }))
  return { lines, source: 'equal', note: "Equal shares — today's records did not add up to one; set the shares before applying" }
}

/**
 * The preview (spec §14.3): today's head-office records for `companyIds`, the
 * suggested split, and planning before and after, per company and for the
 * portfolio of those companies. "After" is what budgetedLabour returns once
 * applyHeadOfficePeople and the split have been applied (tested).
 */
export async function planHeadOfficePeople(
  db: Db,
  input: { hoName: string; companyIds: string[]; split?: SplitLineInput[] },
): Promise<HeadOfficePeoplePlan> {
  const r = await readRecords(db, input.companyIds)
  const warnings: string[] = []
  const notCompanies = r.companies.filter((c) => c.kind !== 'company')
  if (notCompanies.length) warnings.push(`${notCompanies.map((c) => c.name).join(', ')} ${notCompanies.length === 1 ? 'is' : 'are'} not a trading company and cannot be linked`)
  const hoContribs = r.contributions.filter((c) => c.category === 'head_office')
  const suggestedSplit = suggestSplit({ companies: r.companies, moving: r.moving, headOfficeContributions: hoContribs })
  const split = (input.split ?? suggestedSplit.lines.map((l) => ({ companyTenantId: l.companyTenantId, shareBps: l.shareBps })))
  const splitTotal = split.reduce((a, l) => a + l.shareBps, 0)
  if (splitTotal < FULL_BPS) warnings.push(`The split adds up to ${(splitTotal / 100).toFixed(2)}% — ${((FULL_BPS - splitTotal) / 100).toFixed(2)}% stays with the head office`)
  if (hoContribs.some((c) => !r.ids.includes(c.sourceTenantId) || !r.ids.includes(c.destinationTenantId))) {
    warnings.push('A head-office contribution involves a company outside this setup — it is ended too')
  }
  const filledBy = r.moving.filter((s) => s.filledByUserId)
  if (filledBy.length) warnings.push(`${filledBy.length} moving seat(s) are filled — the people stay on their company's payroll until they are moved with "Move to head office"`)

  // Other live head-office links: their charges start counting once the marker is set.
  const otherLinks = await db.headOfficeLink.count({ where: { endedAt: null, companyTenantId: { in: r.ids } } })
  if (otherLinks) warnings.push(`${otherLinks} live head-office link(s) already exist for these companies — their plan charges count from setup on too`)

  // ── Before: today's planning, through the real function ──
  const nameOf = (id: string) => r.companies.find((c) => c.id === id)?.name ?? id
  const beforeRows: PlanningRow[] = []
  for (const c of r.companies) {
    const b = await budgetedLabour([c.id])
    beforeRows.push({
      tenantId: c.id, name: c.name, seatsMonthlyCents: b.shareMonthlyCents,
      contributionsNetMonthlyCents: b.outgoingContributionMonthlyCents - b.incomingContributionMonthlyCents,
      headOfficeChargesMonthlyCents: b.headOfficeChargesMonthlyCents, rechargedOutMonthlyCents: b.rechargedOutMonthlyCents,
      netMonthlyCents: b.netMonthlyCents,
    })
  }
  const portfolioBefore = r.ids.length ? (await budgetedLabour(r.companies.map((c) => c.id))).netMonthlyCents : 0

  // ── After: the same rules on the records as they will be ──
  const hoBase = seatCost(r.moving, (s) => s.monthlySalaryCents)
  const charges = new Map(splitByBps(hoBase, split).map((a) => [a.companyTenantId, a.amountCents]))
  const otherContribs = r.contributions.filter((c) => c.category !== 'head_office')
  const afterRows: PlanningRow[] = r.companies.map((c) => {
    const seats = seatCost(r.seats.filter((s) => s.tenantId === c.id && !r.movingIds.has(s.id)), (s) => s.monthlySalaryCents)
    let contrib = 0
    for (const k of otherContribs) {
      if (k.sourceTenantId === c.id) contrib += k.monthlyCents
      if (k.destinationTenantId === c.id) contrib -= k.monthlyCents
    }
    const charge = charges.get(c.id) ?? 0
    return {
      tenantId: c.id, name: c.name, seatsMonthlyCents: seats, contributionsNetMonthlyCents: contrib,
      headOfficeChargesMonthlyCents: charge, rechargedOutMonthlyCents: 0, netMonthlyCents: seats + contrib + charge,
    }
  })
  let portfolioContrib = 0
  for (const k of otherContribs) {
    const inS = r.ids.includes(k.sourceTenantId), inD = r.ids.includes(k.destinationTenantId)
    if (inS && !inD) portfolioContrib += k.monthlyCents
    if (inD && !inS) portfolioContrib -= k.monthlyCents
  }
  const portfolioAfter = afterRows.reduce((a, x) => a + x.seatsMonthlyCents + x.headOfficeChargesMonthlyCents, 0) + portfolioContrib
  const rechargedOut = [...charges.values()].reduce((a, b) => a + b, 0)
  const headOffice: PlanningRow = {
    tenantId: '', name: input.hoName, seatsMonthlyCents: hoBase, contributionsNetMonthlyCents: 0,
    headOfficeChargesMonthlyCents: 0, rechargedOutMonthlyCents: rechargedOut, netMonthlyCents: hoBase - rechargedOut,
  }

  // ── People in the head-office departments ──
  const deptIds = r.departments.map((d) => d.id)
  const employees = deptIds.length ? await db.hrEmployee.findMany({
    where: { tenantId: { in: r.ids }, departmentId: { in: deptIds }, status: { in: ['active', 'on_leave'] } },
    select: { id: true, tenantId: true, departmentId: true, employeeCode: true, fullName: true, status: true, userId: true },
    orderBy: { fullName: 'asc' },
  }) : []
  const userIds = [...new Set([...employees.map((e) => e.userId), ...r.moving.map((s) => s.filledByUserId)].filter((u): u is string => !!u))]
  const users = userIds.length ? await db.user.findMany({ where: { id: { in: userIds }, deletedAt: null }, select: { id: true, name: true, email: true }, orderBy: { name: 'asc' } }) : []

  return {
    hoName: input.hoName,
    companies: r.companies.map((c) => ({ id: c.id, name: c.name, slug: c.slug, isTest: c.isTest })),
    contributions: hoContribs.map((c) => ({
      id: c.id, label: c.label, monthlyCents: c.monthlyCents, description: c.description,
      sourceTenantId: c.sourceTenantId, sourceName: c.sourceTenant.name, destinationTenantId: c.destinationTenantId, destinationName: c.destinationTenant.name,
    })),
    departments: r.departments.map((d) => ({
      id: d.id, tenantId: d.tenantId!, companyName: nameOf(d.tenantId!), name: d.name, emoji: d.emoji,
      seats: r.moving.filter((s) => s.departmentId === d.id).map((s) => ({
        id: s.id, title: s.title, status: s.status, headcount: s.headcount, monthlySalaryCents: s.monthlySalaryCents,
        tenantCostShareCents: s.tenantCostShareCents, filledByUserId: s.filledByUserId,
      })),
      employees: employees.filter((e) => e.departmentId === d.id).map((e) => ({ id: e.id, employeeCode: e.employeeCode, fullName: e.fullName, status: e.status, userId: e.userId })),
    })),
    seatsShareNotGross: r.seats.filter((s) => s.tenantCostShareCents !== s.monthlySalaryCents).map((s) => ({
      id: s.id, tenantId: s.tenantId, title: s.title, monthlySalaryCents: s.monthlySalaryCents,
      tenantCostShareCents: s.tenantCostShareCents, headcount: s.headcount, moves: r.movingIds.has(s.id),
    })),
    suggestedSplit,
    split,
    planning: {
      labels: PLAN_LABELS,
      before: { companies: beforeRows, portfolioNetMonthlyCents: portfolioBefore },
      after: { companies: afterRows, headOffice, portfolioNetMonthlyCents: portfolioAfter },
    },
    hodCandidates: users.map((u) => ({ userId: u.id, name: u.name, email: u.email })),
    warnings,
  }
}

export interface HeadOfficePeopleSummary {
  departments: Array<{ name: string; fromDepartmentIds: string[]; headOfficeDepartmentId: string }>
  seatsMoved: Array<{ id: string; title: string; fromTenantId: string; monthlySalaryCents: number; shareBefore: number; headcount: number; filledByUserId: string | null }>
  seatsNormalised: Array<{ id: string; title: string; tenantId: string; monthlySalaryCents: number; shareBefore: number }>
  contributionsEnded: Array<{ id: string; label: string; monthlyCents: number; sourceTenantId: string; destinationTenantId: string }>
  designationsCopied: string[]
  shiftBandsCopied: string[]
}

/**
 * Apply the people half of the setup inside the wizard's transaction (see the
 * file header). Every write names the head office or one of `companyIds`.
 */
export async function applyHeadOfficePeople(tx: Tx, input: { hoId: string; companyIds: string[] }): Promise<HeadOfficePeopleSummary> {
  const ho = await tx.tenant.findUnique({ where: { id: input.hoId }, select: { kind: true } })
  if (!ho || ho.kind !== 'head_office') throw new AppError('NOT_A_HEAD_OFFICE', 'Seats move only into a head office', 422)
  const r = await readRecords(tx, input.companyIds)
  const summary: HeadOfficePeopleSummary = { departments: [], seatsMoved: [], seatsNormalised: [], contributionsEnded: [], designationsCopied: [], shiftBandsCopied: [] }

  // 1. Departments, by name (two companies' "Finance" become one).
  const deptTwin = new Map<string, string>() // source department id → head-office department id
  for (const d of r.departments) {
    const twin = await tx.department.upsert({
      where: { tenantId_name: { tenantId: input.hoId, name: d.name } },
      create: { tenantId: input.hoId, name: d.name, emoji: d.emoji, order: d.order },
      update: {},
      select: { id: true },
    })
    deptTwin.set(d.id, twin.id)
    const row = summary.departments.find((x) => x.name === d.name)
    if (row) row.fromDepartmentIds.push(d.id)
    else summary.departments.push({ name: d.name, fromDepartmentIds: [d.id], headOfficeDepartmentId: twin.id })
  }

  // 2. Seats move with share = gross; their shift band and designation follow by name.
  const seatMeta = r.moving.length ? await tx.position.findMany({
    where: { id: { in: r.moving.map((s) => s.id) } },
    select: { id: true, shiftBand: { select: { name: true, startTime: true, endTime: true, order: true } } },
  }) : []
  const bandOf = new Map(seatMeta.map((m) => [m.id, m.shiftBand]))
  const bandTwin = new Map<string, string>()
  for (const s of r.moving) {
    let shiftBandId: string | null = null
    const band = bandOf.get(s.id)
    if (band) {
      if (!bandTwin.has(band.name)) {
        const twin = await tx.shiftBand.upsert({
          where: { tenantId_name: { tenantId: input.hoId, name: band.name } },
          create: { tenantId: input.hoId, name: band.name, startTime: band.startTime, endTime: band.endTime, order: band.order },
          update: {},
          select: { id: true },
        })
        bandTwin.set(band.name, twin.id)
        summary.shiftBandsCopied.push(band.name)
      }
      shiftBandId = bandTwin.get(band.name)!
    }
    const designation = await tx.hrOrgUnit.findFirst({ where: { tenantId: s.tenantId, kind: 'designation', name: s.title }, select: { name: true, code: true } })
    if (designation && !summary.designationsCopied.includes(designation.name)) {
      await tx.hrOrgUnit.upsert({
        where: { tenantId_kind_name: { tenantId: input.hoId, kind: 'designation', name: designation.name } },
        create: { tenantId: input.hoId, kind: 'designation', name: designation.name, code: designation.code },
        update: {},
      })
      summary.designationsCopied.push(designation.name)
    }
    await tx.position.update({
      where: { id: s.id },
      data: { tenantId: input.hoId, departmentId: deptTwin.get(s.departmentId!)!, shiftBandId, tenantCostShareCents: s.monthlySalaryCents },
    })
    summary.seatsMoved.push({
      id: s.id, title: s.title, fromTenantId: s.tenantId, monthlySalaryCents: s.monthlySalaryCents,
      shareBefore: s.tenantCostShareCents, headcount: s.headcount, filledByUserId: s.filledByUserId,
    })
  }

  // 3. Every other listed seat: share = gross (shown in the preview first).
  for (const s of r.seats) {
    if (r.movingIds.has(s.id) || s.tenantCostShareCents === s.monthlySalaryCents) continue
    await tx.position.update({ where: { id: s.id }, data: { tenantCostShareCents: s.monthlySalaryCents } })
    summary.seatsNormalised.push({ id: s.id, title: s.title, tenantId: s.tenantId, monthlySalaryCents: s.monthlySalaryCents, shareBefore: s.tenantCostShareCents })
  }

  // 4. End the head_office contributions (kept, read-only).
  const ended = r.contributions.filter((c) => c.category === 'head_office')
  if (ended.length) {
    await tx.tenantContribution.updateMany({
      where: { id: { in: ended.map((c) => c.id) }, isActive: true },
      data: { isActive: false, endedAt: new Date() },
    })
  }
  summary.contributionsEnded = ended.map((c) => ({ id: c.id, label: c.label, monthlyCents: c.monthlyCents, sourceTenantId: c.sourceTenantId, destinationTenantId: c.destinationTenantId }))
  return summary
}
