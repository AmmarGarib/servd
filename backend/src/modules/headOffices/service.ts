// Head office (D1) — create a head office, link and unlink the companies it
// serves, switch it off. Every function runs inside the CALLER's transaction
// (routes.ts, and the setup wizard in headOffices/setup.ts) so a head office
// and everything it needs exist together or not at all.
//
// The money side reuses the existing inter-company engine (owner, 2026-10-15):
// linking creates the pair's Due-from / Due-to through
// intercompany/accounts.ts ensurePairAccounts (1450–1499 / 2150–2199) — there
// are no 'head_office' due accounts and no second transfer table.
//
// Company separation: the CEO acts only on a head office and companies they
// are a member of (404 otherwise — isMemberOfBoth); a test company and a real
// head office never mix (422 TEST_COMPANY_MIX), so practice numbers never reach
// real books.

import type { Prisma, PrismaClient } from '@prisma/client'
import { AppError, NotFoundError } from '../../lib/errors.js'
import { isMemberOfBoth } from '../../lib/companyPairs.js'
import { revokeDelegationsForUnlinkTx } from '../../lib/approvalRights.js'
import { ensurePairAccounts, counterpartiesOf, pairBalances } from '../intercompany/accounts.js'
import { addMonths, assertMonth, monthOf } from '../intercompany/fleet.js'
import { isTestTenant } from '../../lib/testCompany.js'
import { DEFAULT_HR_SETTINGS } from '../hr/logic.js'
import { saveSettings } from '../hr/service.js'
import { createChargesAccount, ensureChartInTx, resolveRechargeAccount, chargesAccountCodeFor } from './accounts.js'
import { invalidateConfirmation, lockBooks, DEFAULT_COST_POOL, type Invalidation } from './books.js'
import { createSplitVersion, markDraftRunsStale, splitForOrNull, type SplitVersion } from './splits.js'

export type Tx = Prisma.TransactionClient
export { chargesAccountCodeFor }

/** Employee codes of a head office ("HO-0001"), so its staff never look like a company's. */
export const HEAD_OFFICE_EMPLOYEE_CODE_PREFIX = 'HO-'

/** A slug for a new tenant (unique across tenants), as tenants/routes.ts does for companies. */
async function uniqueTenantSlug(tx: Tx, name: string): Promise<string> {
  const base = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'head-office'
  let slug = base
  for (let i = 2; await tx.tenant.findUnique({ where: { slug }, select: { id: true } }); i++) slug = `${base}-${i}`
  return slug
}

/** Every company the user belongs to, read on the transaction (sees a head office created in it). */
async function membersOf(tx: Tx, userId: string): Promise<string[]> {
  const [u, m] = await Promise.all([
    tx.user.findUnique({ where: { id: userId }, select: { tenantId: true } }),
    tx.tenantMember.findMany({ where: { userId }, select: { tenantId: true } }),
  ])
  const ids = new Set(m.map((r) => r.tenantId))
  if (u?.tenantId) ids.add(u.tenantId)
  return [...ids]
}

/** Make sure a head office has its books row (the recharge account mapped to 6990). */
export async function ensureBooks(tx: Tx, hoId: string, actorId: string): Promise<void> {
  const have = await tx.headOfficeBooks.findUnique({ where: { tenantId: hoId }, select: { tenantId: true } })
  if (have) return
  const recharge = await resolveRechargeAccount(tx, hoId)
  await tx.headOfficeBooks.create({ data: { tenantId: hoId, rechargeAccountId: recharge.id, costPool: DEFAULT_COST_POOL, updatedById: actorId } })
}

// ─── Create ──────────────────────────────────────────────────────────────────

export interface CreatedHeadOffice {
  id: string
  name: string
  slug: string
  isTest: boolean
  rechargeAccountId: string
  accountsAdded: number
}

/**
 * Create a head office in one transaction: the Tenant (kind head_office), the
 * CEO as its owner member, the standard chart, HeadOfficeBooks with the
 * recharge account = its own 6990 (never 6991+, A1.2) and recharge OFF, and HR
 * settings with employee codes 'HO-'. A head office has no fiscal POS
 * (connectors/registry.ts ensureConnectorRow skips head offices).
 *
 * The HR settings go through the HR module's own writer (hr/service.ts
 * saveSettings), which uses its own client: the row is keyed by the new id and
 * has no foreign key, so a rolled-back create leaves at most one unread
 * settings row for an id that never exists.
 */
export async function createHeadOffice(tx: Tx, input: { name: string; actorId: string; isTest?: boolean }): Promise<CreatedHeadOffice> {
  const name = input.name.trim()
  if (name.length < 2 || name.length > 200) throw new AppError('INVALID_NAME', 'Give the head office a name (2–200 characters)', 422)
  const slug = await uniqueTenantSlug(tx, name)
  const t = await tx.tenant.create({
    data: {
      slug, name, kind: 'head_office', isTest: input.isTest === true,
      countryCode: 'PK', currency: 'PKR', timezone: 'Asia/Karachi',
    },
    select: { id: true, name: true, slug: true, isTest: true },
  })
  await tx.tenantMember.create({ data: { userId: input.actorId, tenantId: t.id, role: 'owner' } })
  const accountsAdded = await ensureChartInTx(tx, t.id)
  const recharge = await resolveRechargeAccount(tx, t.id)
  await tx.headOfficeBooks.create({
    data: { tenantId: t.id, rechargeAccountId: recharge.id, costPool: DEFAULT_COST_POOL, updatedById: input.actorId },
  })
  await saveSettings(t.id, { ...DEFAULT_HR_SETTINGS, employeeCodePrefix: HEAD_OFFICE_EMPLOYEE_CODE_PREFIX })
  return { ...t, rechargeAccountId: recharge.id, accountsAdded }
}

// ─── Link ────────────────────────────────────────────────────────────────────

export interface LinkInput {
  hoId: string
  companyId: string
  actorId: string
  /** A12: live head-office-wide hand-overs the CEO keeps (they will cover the new company). */
  extendDelegationIds?: string[]
  /** A12: live head-office-wide hand-overs the CEO revokes now, in this transaction. */
  revokeDelegationIds?: string[]
}

export interface LinkResult extends Invalidation {
  link: { id: string; tenantId: string; companyTenantId: string; chargesAccountId: string | null; startedAt: Date }
  hoName: string
  companyName: string
  pairAccounts: { hoDueFrom: string; hoDueTo: string; companyDueFrom: string; companyDueTo: string }
  chargesAccount: { id: string; code: string; reused: boolean }
  extendedDelegationIds: string[]
  revokedDelegationIds: string[]
}

/** A head office's live HEAD-OFFICE-WIDE hand-overs (not revoked, not ended; started or not) — they would cover a new company. */
export async function liveHoWideDelegationIds(tx: Tx | PrismaClient, hoId: string): Promise<string[]> {
  const now = new Date()
  const rows = await tx.approvalDelegation.findMany({
    where: { tenantId: hoId, companyTenantId: null, revokedAt: null, OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  })
  return rows.map((r) => r.id)
}

/**
 * Link a company to a head office (POST /head-offices/:id/companies).
 *   404                          the CEO is not a member of both, or :id is not a head office
 *   422 LINK_TARGET_NOT_A_COMPANY the target is a head office, inactive, deleted or the head office itself
 *   422 HEAD_OFFICE_INACTIVE      the head office is switched off
 *   422 TEST_COMPANY_MIX          a test company with a real head office, or the reverse
 *   409 ALREADY_LINKED            a live link exists
 *   422 DELEGATIONS_UNANSWERED    a live head-office-wide hand-over is in neither list (A12)
 * Then: the pair accounts, the company's charges account, a NEW link row, the
 * listed hand-overs revoked, and the books' confirmation cleared + recharge OFF.
 */
export async function linkCompany(tx: Tx, input: LinkInput): Promise<LinkResult> {
  const { hoId, companyId, actorId } = input
  if (hoId === companyId) throw new AppError('LINK_TARGET_NOT_A_COMPANY', 'A head office cannot serve itself — pick a trading company', 422)
  const members = await membersOf(tx, actorId)
  if (!isMemberOfBoth({ id: actorId, memberTenantIds: members }, hoId, companyId)) throw new NotFoundError('Company', companyId)

  const [ho, co] = await Promise.all([
    tx.tenant.findUnique({ where: { id: hoId }, select: { id: true, name: true, kind: true, isActive: true, deletedAt: true } }),
    tx.tenant.findUnique({ where: { id: companyId }, select: { id: true, name: true, kind: true, isActive: true, deletedAt: true } }),
  ])
  if (!ho || ho.kind !== 'head_office' || ho.deletedAt) throw new NotFoundError('Head office', hoId)
  if (!co || co.deletedAt) throw new NotFoundError('Company', companyId)
  if (!ho.isActive) throw new AppError('HEAD_OFFICE_INACTIVE', 'Switch the head office back on before linking a company', 422)
  if (co.kind !== 'company' || !co.isActive) {
    throw new AppError('LINK_TARGET_NOT_A_COMPANY', `${co.name} is not an active trading company — a head office only serves companies (never another head office)`, 422)
  }
  // lib/testCompany.ts is the one test-company predicate; with `tx` it reads
  // fresh, so a head office created earlier in this transaction is seen.
  const [hoIsTest, coIsTest] = await Promise.all([isTestTenant(hoId, tx), isTestTenant(companyId, tx)])
  if (hoIsTest !== coIsTest) {
    throw new AppError(
      'TEST_COMPANY_MIX',
      hoIsTest ? 'A test head office serves only test companies' : 'A test company cannot sit under a real head office — practice numbers must never reach real books',
      422,
    )
  }

  // One live link per pair: serialise, then check (the partial unique index head_office_links_one_live is the backstop).
  const key = `ho.link:${hoId}:${companyId}`
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}::text))`
  const live = await tx.headOfficeLink.findFirst({ where: { tenantId: hoId, companyTenantId: companyId, endedAt: null }, select: { id: true } })
  if (live) throw new AppError('ALREADY_LINKED', `${co.name} is already linked to ${ho.name}`, 409)

  // A12: every live HO-wide hand-over must be answered (extend or revoke).
  const extend = [...new Set(input.extendDelegationIds ?? [])]
  const revoke = [...new Set(input.revokeDelegationIds ?? [])]
  const both = extend.filter((id) => revoke.includes(id))
  if (both.length > 0) throw new AppError('DELEGATIONS_UNANSWERED', 'A hand-over cannot be both extended and revoked', 422, { delegationIds: both })
  const hoWide = await liveHoWideDelegationIds(tx, hoId)
  const unknown = [...extend, ...revoke].filter((id) => !hoWide.includes(id))
  if (unknown.length > 0) {
    throw new AppError('UNKNOWN_DELEGATION', "Those hand-overs are not live head-office-wide hand-overs of this head office — reload and try again", 422, { delegationIds: unknown })
  }
  const unanswered = hoWide.filter((id) => !extend.includes(id) && !revoke.includes(id))
  if (unanswered.length > 0) {
    throw new AppError(
      'DELEGATIONS_UNANSWERED',
      `${unanswered.length} head-office-wide hand-over(s) would also cover ${co.name} — choose, for each, to extend it or revoke it`,
      422,
      { delegationIds: unanswered },
    )
  }
  if (revoke.length > 0) {
    await tx.approvalDelegation.updateMany({
      where: { id: { in: revoke }, tenantId: hoId, revokedAt: null },
      data: { revokedAt: new Date(), revokedById: actorId, revokeReason: `revoked when ${co.name} was linked` },
    })
  }

  await ensureBooks(tx, hoId, actorId)
  const pair = await ensurePairAccounts(tx, hoId, companyId)
  const chargesAccount = await createChargesAccount(tx, { companyId, hoId, hoName: ho.name })
  const link = await tx.headOfficeLink.create({
    data: { tenantId: hoId, companyTenantId: companyId, chargesAccountId: chargesAccount.id, createdById: actorId },
    select: { id: true, tenantId: true, companyTenantId: true, chargesAccountId: true, startedAt: true },
  })
  const inv = await invalidateConfirmation(tx, hoId, actorId)
  return {
    link,
    hoName: ho.name,
    companyName: co.name,
    pairAccounts: { hoDueFrom: pair.aDueFrom, hoDueTo: pair.aDueTo, companyDueFrom: pair.bDueFrom, companyDueTo: pair.bDueTo },
    chargesAccount,
    extendedDelegationIds: extend,
    revokedDelegationIds: revoke,
    ...inv,
  }
}

// ─── End a link ──────────────────────────────────────────────────────────────

export interface EndLinkInput {
  hoId: string
  companyId: string
  reason: string
  /** 'YYYY-MM': the last month the head office charges this company. */
  lastChargedPeriod: string
  actorId: string
}

export interface EndLinkResult extends Invalidation {
  linkId: string
  companyName: string
  revokedDelegationIds: string[]
  autoSplit: SplitVersion | null
  staleRuns: number
  warnings: string[]
}

/**
 * End a link (POST /head-offices/:id/companies/:companyId/end). Reach and
 * hand-over cover stop at once; balances and history stay.
 *   404                         not a member of both / no live link
 *   422 INVALID_MONTH           lastChargedPeriod is not YYYY-MM
 *   422 LAST_CHARGED_IN_FUTURE  lastChargedPeriod is after this (Karachi) month
 *   422 RUN_AFTER_LAST_CHARGED  a draft, submitted or posted run line for the
 *                               company exists after lastChargedPeriod (A11; listed)
 *   409 SPLIT_PERIOD_IN_USE     the automatic version (below) would start in a used month
 * Then, in the same transaction: endedAt + lastChargedPeriod; the company-
 * scoped hand-overs revoked ('company unlinked', A12); when no version starts
 * in lastChargedPeriod+1 and the version in force then still lists the company,
 * a new version without it (through createSplitVersion — "re-spread the
 * shares"); the head office's later draft runs marked stale; the books'
 * confirmation cleared + recharge OFF.
 */
export async function endLink(tx: Tx, input: EndLinkInput): Promise<EndLinkResult> {
  const { hoId, companyId, actorId, lastChargedPeriod } = input
  assertMonth(lastChargedPeriod, 'lastChargedPeriod')
  // §9: a run for a month after lastChargedPeriod never charges the company, so
  // a future month would leave an ended company chargeable until then.
  if (lastChargedPeriod > monthOf(new Date())) {
    throw new AppError('LAST_CHARGED_IN_FUTURE', 'The last charged month cannot be after this month', 422)
  }
  const reason = input.reason.trim()
  if (reason.length < 3) throw new AppError('REASON_REQUIRED', 'Say why the link ends', 422)
  const members = await membersOf(tx, actorId)
  if (!isMemberOfBoth({ id: actorId, memberTenantIds: members }, hoId, companyId)) throw new NotFoundError('Company', companyId)
  const key = `ho.link:${hoId}:${companyId}`
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}::text))`
  const link = await tx.headOfficeLink.findFirst({
    where: { tenantId: hoId, companyTenantId: companyId, endedAt: null },
    select: { id: true, company: { select: { name: true } } },
  })
  if (!link) throw new NotFoundError('Head office link', companyId)

  // A11: never end before a month that already has a run line for the company.
  const later = await tx.rechargeRunLine.findMany({
    where: { tenantId: hoId, companyTenantId: companyId, run: { status: { in: ['draft', 'submitted', 'posted'] }, period: { gt: lastChargedPeriod } } },
    select: { run: { select: { id: true, period: true, status: true } } },
    orderBy: { run: { period: 'asc' } },
  })
  if (later.length > 0) {
    const runs = later.map((l) => l.run)
    throw new AppError(
      'RUN_AFTER_LAST_CHARGED',
      `${link.company.name} is already on recharge runs after ${lastChargedPeriod}: ${runs.map((r) => `${r.period} (${r.status})`).join(', ')} — withdraw or reverse them, or choose a later last month`,
      422,
      { runs },
    )
  }

  const ended = await tx.headOfficeLink.updateMany({
    where: { id: link.id, endedAt: null },
    data: { endedAt: new Date(), endedById: actorId, endReason: reason, lastChargedPeriod },
  })
  if (ended.count === 0) throw new AppError('LINK_ALREADY_ENDED', 'This link has just been ended', 409)

  const revokedDelegationIds = await revokeDelegationsForUnlinkTx(tx, hoId, companyId, actorId)

  const warnings: string[] = []
  const next = addMonths(lastChargedPeriod, 1)
  let autoSplit: SplitVersion | null = null
  let staleRuns = 0
  const startsNext = await tx.rechargeSplit.findUnique({
    where: { tenantId_effectiveFrom: { tenantId: hoId, effectiveFrom: next } },
    include: { lines: { select: { companyTenantId: true } } },
  })
  if (!startsNext) {
    const inForce = await splitForOrNull(tx, hoId, next)
    if (inForce && inForce.lines.some((l) => l.companyTenantId === companyId)) {
      const liveCompanies = new Set((await tx.headOfficeLink.findMany({
        where: { tenantId: hoId, endedAt: null }, select: { companyTenantId: true },
      })).map((l) => l.companyTenantId))
      const kept = inForce.lines.filter((l) => l.companyTenantId !== companyId && liveCompanies.has(l.companyTenantId))
      if (kept.length < inForce.lines.length - 1) warnings.push('Companies no longer linked were left out of the new % table too')
      const created = await createSplitVersion(tx, {
        hoId,
        effectiveFrom: next,
        lines: kept,
        note: `Automatic: ${link.company.name} unlinked after ${lastChargedPeriod} — re-spread the shares`,
        actorId,
      })
      autoSplit = created.split
      staleRuns += created.staleRuns
      warnings.push(`A new % table starts in ${next} without ${link.company.name}; its share now stays with the head office — re-spread the shares`)
    }
  } else if (startsNext.lines.some((l) => l.companyTenantId === companyId)) {
    warnings.push(`The % table starting ${next} still lists ${link.company.name}; it is never charged after ${lastChargedPeriod} — replace that version`)
  }
  staleRuns += await markDraftRunsStale(tx, hoId, lastChargedPeriod, { after: true })
  const inv = await invalidateConfirmation(tx, hoId, actorId)
  return { linkId: link.id, companyName: link.company.name, revokedDelegationIds, autoSplit, staleRuns, warnings, ...inv }
}

// ─── Switch off ──────────────────────────────────────────────────────────────

/**
 * PATCH isActive=false: 409 HEAD_OFFICE_IN_USE while it has a live link or any
 * non-zero pair balance with a company (the inter-company Due-from / Due-to).
 */
export async function assertHeadOfficeMayDeactivate(tx: Tx, hoId: string): Promise<void> {
  const liveLinks = await tx.headOfficeLink.count({ where: { tenantId: hoId, endedAt: null } })
  if (liveLinks > 0) {
    throw new AppError('HEAD_OFFICE_IN_USE', `The head office still serves ${liveLinks} compan${liveLinks === 1 ? 'y' : 'ies'} — end those links first`, 409)
  }
  for (const other of await counterpartiesOf(tx, hoId)) {
    const b = await pairBalances(tx, hoId, other)
    if (b.aDueFromB !== 0 || b.aDueToB !== 0 || b.bDueFromA !== 0 || b.bDueToA !== 0) {
      throw new AppError('HEAD_OFFICE_IN_USE', 'The head office still has inter-company balances — settle them first (Accounting → Inter-company)', 409)
    }
  }
}

/** Lock-and-read the books (re-exported for the routes). */
export { lockBooks }
