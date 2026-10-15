// Hand-over of approval sections (D3, owner 2026-10-11; spec §7.5).
//
// The CEO hands a SECTION (optionally narrowed to some of its types) of a
// head office's companies to a head-office person: an ApprovalDelegation row
// says WHO may decide — never items, never decisions. Items, states and
// decisions stay in each module's own row, and each module's own approve route
// asks lib/approvalRights.ts assertCanApprove, which reads these rows live on
// every use (nothing cached, no expiry job).
//
// This file is the inbox's seam (ApprovalDelegations, consulted per type next
// to approverRoles) plus the grant / revoke / list logic the routes in
// delegationRoutes.ts call. Rows are never edited or deleted: change = revoke +
// grant again.
//
// NO_DELEGATIONS is kept as the test default: an inbox built with it behaves
// exactly as before head office existed.

import type { Prisma } from '@prisma/client'
import { serviceClient } from '../../lib/prisma.js'
import { AppError } from '../../lib/errors.js'
import { audit } from '../../lib/audit.js'
import { effectiveModulesForUser } from '../../lib/moduleAccess.js'
import { headOfficeReach, liveLink } from '../../lib/headOffice.js'
import {
  APPROVAL_RIGHTS, APPROVAL_SECTIONS, APPROVAL_SECTION_TITLES, DELEGABLE_SECTIONS, allLiveDelegations, delegableTypesOf,
  delegatedTenantsByType, delegationEnabled, liveDelegationWhere,
  type ApprovalSection, type ApprovalType, type LiveDelegation,
} from '../../lib/approvalRights.js'

export interface HandOverIndex {
  /** Live, eligible delegations of the viewer's head offices, with the types each still covers and the delegate's name. */
  delegations: Array<LiveDelegation & { types: ApprovalType[]; delegateName: string | null }>
  /** Live links: Map<hoId, Set<companyId>>. */
  linked: Map<string, Set<string>>
}

export interface ApprovalDelegations {
  /** Approval types handed to this user (any company, whatever the view), live now. */
  typesFor(userId: string, tenantIds: readonly string[]): Promise<ReadonlySet<ApprovalType>>
  /** Per type, every company this user's live hand-overs cover. */
  tenantsByType?(userId: string): Promise<ReadonlyMap<ApprovalType, ReadonlySet<string>>>
  /** CEO view: the live hand-overs of the head offices the viewer belongs to (null = none). */
  handedOver?(viewer: { id: string; role: string; memberTenantIds: readonly string[] }): Promise<HandOverIndex | null>
}

/** Nobody holds a delegation (the test default; the inbox then behaves exactly as before head office). */
export const NO_DELEGATIONS: ApprovalDelegations = {
  async typesFor() { return new Set<ApprovalType>() },
  async tenantsByType() { return new Map() },
  async handedOver() { return null },
}

/** The live hand-overs, read from approval_delegations through lib/approvalRights.ts. */
export const LIVE_DELEGATIONS: ApprovalDelegations = {
  async typesFor(userId) {
    return new Set((await delegatedTenantsByType(userId)).keys())
  },
  async tenantsByType(userId) {
    return delegatedTenantsByType(userId)
  },
  async handedOver(viewer) {
    if (viewer.role !== 'admin' || viewer.memberTenantIds.length === 0) return null
    const hoIds = (await serviceClient.tenant.findMany({
      where: { id: { in: [...viewer.memberTenantIds] }, kind: 'head_office' }, select: { id: true },
    })).map((t) => t.id)
    if (hoIds.length === 0) return null
    const live = await allLiveDelegations(hoIds)
    if (live.length === 0) return null
    const names = new Map((await serviceClient.user.findMany({
      where: { id: { in: [...new Set(live.map((d) => d.delegateUserId))] } }, select: { id: true, name: true, email: true },
    })).map((u) => [u.id, u.name ?? u.email ?? null]))
    const linked = new Map<string, Set<string>>()
    for (const [company, hos] of await headOfficeReach(hoIds)) {
      for (const ho of hos) { const s = linked.get(ho) ?? new Set<string>(); s.add(company); linked.set(ho, s) }
    }
    return { delegations: live.map((d) => ({ ...d, delegateName: names.get(d.delegateUserId) ?? null })), linked }
  },
}

// ─── Catalogue ───────────────────────────────────────────────────────────────

export interface CatalogType {
  type: ApprovalType
  label: string
  /** Switched on now (DELEGATION_ENABLED): a grant may name it. */
  enabled: boolean
  mustHoldModule: string | null
  hoWideOnly: boolean
  note: string | null
}

/** Sections → their delegable types, with labels (GET /approvals/catalog). */
export function delegationCatalog() {
  return APPROVAL_SECTIONS.map((id) => {
    const types: CatalogType[] = delegableTypesOf(id).map((t) => ({
      type: t, label: APPROVAL_RIGHTS[t].label, enabled: delegationEnabled(t),
      mustHoldModule: APPROVAL_RIGHTS[t].mustHoldModule, hoWideOnly: !!APPROVAL_RIGHTS[t].hoWideOnly,
      note: APPROVAL_RIGHTS[t].delegableNote ?? null,
    }))
    return {
      id: id as ApprovalSection,
      title: APPROVAL_SECTION_TITLES[id],
      delegable: id !== 'ceo' && types.length > 0,
      notYet: id !== 'ceo' && types.length > 0 && types.every((t) => !t.enabled),
      types,
    }
  })
}

// ─── Grant / revoke ──────────────────────────────────────────────────────────

export interface GrantInput {
  headOfficeId: string
  companyTenantId?: string | null
  section: string
  approvalTypes?: string[]
  delegateUserId: string
  endsAt?: Date | null
  note: string
}

export interface Actor { id: string; email: string | null; role: string; memberTenantIds: readonly string[] }

async function isMember(userId: string, tenantId: string, primary: string | null): Promise<boolean> {
  if (primary === tenantId) return true
  return !!(await serviceClient.tenantMember.findFirst({ where: { userId, tenantId }, select: { id: true } }))
}

/** The head office the CEO may grant in: kind head_office, not deleted, the CEO a member — else 404. */
async function headOfficeForCeo(actor: Actor, hoId: string) {
  const ho = await serviceClient.tenant.findFirst({ where: { id: hoId, kind: 'head_office', deletedAt: null }, select: { id: true, name: true, isActive: true } })
  if (!ho || !actor.memberTenantIds.includes(ho.id)) throw new AppError('NOT_FOUND', 'Head office not found', 404)
  return ho
}

const companyOwned = (types: readonly string[]) => types.filter((t) => APPROVAL_RIGHTS[t as ApprovalType]?.ownership === 'company')
const typesOrAll = (row: { section: string; approvalTypes: string[] }) =>
  row.approvalTypes.length ? row.approvalTypes : delegableTypesOf(row.section)

/**
 * POST /approvals/delegations (spec §7.5; checks in this order). Returns the
 * new row. One head office per (company, section) for company-owned types
 * (A4), under pg_advisory_xact_lock(hashtext('delegation:'||section)).
 */
export async function grantDelegation(actor: Actor, input: GrantInput) {
  if (actor.role !== 'admin') throw new AppError('FORBIDDEN', 'Only the CEO hands over approvals', 403)
  const ho = await headOfficeForCeo(actor, input.headOfficeId)

  const companyId = input.companyTenantId || null
  if (companyId && !(await liveLink(ho.id, companyId))) {
    throw new AppError('COMPANY_NOT_LINKED', 'That company is not served by this head office now', 422)
  }

  // Section, then its types.
  const section = input.section
  const inSection = (DELEGABLE_SECTIONS as readonly string[]).includes(section) ? delegableTypesOf(section) : []
  if (inSection.length === 0) {
    throw new AppError('SECTION_NOT_DELEGABLE', section === 'ceo' ? 'CEO approvals are never handed over' : `The ${section} section cannot be handed over`, 422)
  }
  const enabled = inSection.filter((t) => delegationEnabled(t))
  if (enabled.length === 0) {
    throw new AppError('SECTION_NOT_YET_DELEGABLE', `${APPROVAL_SECTION_TITLES[section as ApprovalSection]} approvals cannot be handed over until the owner confirms`, 422)
  }
  const asked = [...new Set(input.approvalTypes ?? [])]
  const foreign = asked.filter((t) => !(inSection as string[]).includes(t))
  if (foreign.length) throw new AppError('TYPE_NOT_IN_SECTION', `Not a delegable ${section} approval: ${foreign.join(', ')}`, 422)
  const locked = asked.filter((t) => !delegationEnabled(t))
  if (locked.length) throw new AppError('SECTION_NOT_YET_DELEGABLE', `Not handed over until the owner confirms: ${locked.join(', ')}`, 422)
  if (companyId && asked.some((t) => APPROVAL_RIGHTS[t as ApprovalType].hoWideOnly)) {
    throw new AppError('TYPE_NOT_IN_SECTION', 'Head-office recharges are handed over head-office-wide only (no company)', 422)
  }
  // "All types" while some type of the section is still locked: store the
  // switched-on ones explicitly, so flipping a constant later never widens
  // an existing grant on its own.
  const types: ApprovalType[] = (asked.length ? asked : (enabled.length === inSection.length ? [] : enabled)) as ApprovalType[]
  const effectiveTypes = types.length ? types : enabled

  // The delegate: an active, non-admin login, a member of the head office.
  const u = await serviceClient.user.findUnique({
    where: { id: input.delegateUserId },
    select: { id: true, name: true, role: true, tenantId: true, isActive: true, deletedAt: true, accountStatus: true, moduleAllow: true, moduleDeny: true },
  })
  if (!u || !u.isActive || u.deletedAt || u.accountStatus !== 'active' || u.role === 'admin' || !(await isMember(u.id, ho.id, u.tenantId))) {
    throw new AppError('DELEGATE_NOT_ELIGIBLE', 'The delegate must be an active, non-CEO member of this head office', 422)
  }
  const mods = await effectiveModulesForUser({ role: u.role, moduleAllow: u.moduleAllow, moduleDeny: u.moduleDeny })
  for (const t of effectiveTypes) {
    const m = APPROVAL_RIGHTS[t].mustHoldModule
    if (m && !mods.has(m)) throw new AppError('DELEGATE_LACKS_MODULE', `The delegate does not hold the ${m} module (needed for ${APPROVAL_RIGHTS[t].label})`, 422)
  }

  const now = new Date()
  if (input.endsAt && !(input.endsAt.getTime() > now.getTime())) {
    throw new AppError('ENDS_AT_IN_PAST', 'The hand-over must end in the future', 422)
  }

  const row = await serviceClient.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'delegation:' + section}))`
    if (companyOwned(effectiveTypes).length > 0) {
      const others = await tx.approvalDelegation.findMany({
        where: { section, tenantId: { not: ho.id }, ...liveDelegationWhere(now) },
        select: { tenantId: true, companyTenantId: true, section: true, approvalTypes: true },
      })
      const clashing = others.filter((o) => companyOwned(typesOrAll(o)).length > 0)
      if (clashing.length) {
        const mine = companyId ? new Set([companyId]) : await linkedCompanies(ho.id, tx)
        const theirs = await Promise.all(clashing.map(async (o) => (o.companyTenantId ? new Set([o.companyTenantId]) : await linkedCompanies(o.tenantId, tx))))
        if (theirs.some((set) => [...set].some((c) => mine.has(c)))) {
          throw new AppError('SECTION_HANDED_TO_OTHER_HEAD_OFFICE', 'Another head office already holds this section for that company — revoke it first', 409)
        }
      }
    }
    return tx.approvalDelegation.create({
      data: {
        tenantId: ho.id, companyTenantId: companyId, section, approvalTypes: types, delegateUserId: u.id,
        grantedById: actor.id, note: input.note, startsAt: now, endsAt: input.endsAt ?? null,
      },
    })
  })

  await audit({
    category: 'identity', action: 'approval.delegation.grant', entity: 'ApprovalDelegation', entityId: row.id,
    userId: actor.id, userEmail: actor.email, tenantId: ho.id,
    after: { headOfficeId: ho.id, companyTenantId: companyId, section, approvalTypes: types, delegateUserId: u.id, endsAt: row.endsAt, note: input.note },
  })
  return row
}

async function linkedCompanies(hoId: string, db: Prisma.TransactionClient): Promise<Set<string>> {
  const links = await db.headOfficeLink.findMany({
    where: { tenantId: hoId, endedAt: null, company: { isActive: true, deletedAt: null, kind: 'company' } },
    select: { companyTenantId: true },
  })
  return new Set(links.map((l) => l.companyTenantId))
}

/** POST /approvals/delegations/:id/revoke {reason}. A second revoke → 409. */
export async function revokeDelegation(actor: Actor, id: string, reason: string) {
  if (actor.role !== 'admin') throw new AppError('FORBIDDEN', 'Only the CEO revokes a hand-over', 403)
  const row = await serviceClient.approvalDelegation.findUnique({ where: { id } })
  if (!row || !actor.memberTenantIds.includes(row.tenantId)) throw new AppError('NOT_FOUND', 'Hand-over not found', 404)
  const done = await serviceClient.approvalDelegation.updateMany({
    where: { id, revokedAt: null },
    data: { revokedAt: new Date(), revokedById: actor.id, revokeReason: reason },
  })
  if (done.count === 0) throw new AppError('ALREADY_REVOKED', 'This hand-over is already revoked', 409)
  await audit({
    category: 'identity', action: 'approval.delegation.revoke', entity: 'ApprovalDelegation', entityId: id,
    userId: actor.id, userEmail: actor.email, tenantId: row.tenantId,
    before: { revokedAt: null }, after: { reason },
  })
  return serviceClient.approvalDelegation.findUniqueOrThrow({ where: { id } })
}

/** GET /approvals/delegations: the CEO sees every hand-over of their head offices; anyone else their own. */
export async function listDelegations(actor: Actor) {
  const where: Prisma.ApprovalDelegationWhereInput = actor.role === 'admin'
    ? { tenantId: { in: [...actor.memberTenantIds] } }
    : { delegateUserId: actor.id }
  const rows = await serviceClient.approvalDelegation.findMany({ where, orderBy: { createdAt: 'desc' }, take: 500 })
  const now = Date.now()
  const userIds = [...new Set(rows.flatMap((r) => [r.delegateUserId, r.grantedById, r.revokedById].filter((x): x is string => !!x)))]
  const tenantIds = [...new Set(rows.flatMap((r) => [r.tenantId, r.companyTenantId].filter((x): x is string => !!x)))]
  const [users, tenants] = await Promise.all([
    serviceClient.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } }),
    serviceClient.tenant.findMany({ where: { id: { in: tenantIds } }, select: { id: true, name: true } }),
  ])
  const uName = new Map(users.map((u) => [u.id, u.name ?? u.email ?? null]))
  const tName = new Map(tenants.map((t) => [t.id, t.name]))
  return rows.map((r) => ({
    ...r,
    headOfficeName: tName.get(r.tenantId) ?? null,
    companyName: r.companyTenantId ? (tName.get(r.companyTenantId) ?? null) : null,
    scopeName: r.companyTenantId ? (tName.get(r.companyTenantId) ?? null) : `${tName.get(r.tenantId) ?? 'Head office'} and every company it serves`,
    sectionTitle: APPROVAL_SECTION_TITLES[r.section as ApprovalSection] ?? r.section,
    delegateName: uName.get(r.delegateUserId) ?? null,
    grantedByName: uName.get(r.grantedById) ?? null,
    revokedByName: r.revokedById ? (uName.get(r.revokedById) ?? null) : null,
    state: r.revokedAt ? 'revoked' : r.startsAt.getTime() > now ? 'not_started' : r.endsAt && r.endsAt.getTime() <= now ? 'expired' : 'live',
  }))
}

/** GET /approvals/delegations/eligible?headOfficeId&section: who could hold it, and which types they hold the module for. */
export async function eligibleDelegates(actor: Actor, headOfficeId: string, section: string) {
  if (actor.role !== 'admin') throw new AppError('FORBIDDEN', 'Only the CEO hands over approvals', 403)
  const ho = await headOfficeForCeo(actor, headOfficeId)
  const members = await serviceClient.tenantMember.findMany({ where: { tenantId: ho.id }, select: { userId: true } })
  const users = await serviceClient.user.findMany({
    where: {
      OR: [{ id: { in: members.map((m) => m.userId) } }, { tenantId: ho.id }],
      isActive: true, deletedAt: null, accountStatus: 'active', role: { not: 'admin' },
    },
    select: { id: true, name: true, email: true, role: true, moduleAllow: true, moduleDeny: true },
    orderBy: { name: 'asc' },
  })
  const types = delegableTypesOf(section)
  const out = []
  for (const u of users) {
    const mods = await effectiveModulesForUser({ role: u.role, moduleAllow: u.moduleAllow, moduleDeny: u.moduleDeny })
    const holds = types.filter((t) => { const m = APPROVAL_RIGHTS[t].mustHoldModule; return !m || mods.has(m) })
    out.push({ id: u.id, name: u.name ?? u.email, role: u.role, types: holds, lacks: types.filter((t) => !holds.includes(t)) })
  }
  return out
}
