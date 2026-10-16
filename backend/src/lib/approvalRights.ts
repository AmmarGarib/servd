// Approval rights (D3, owner 2026-10-11) — WHO may decide an approval item.
//
// The ONE registry of approval types, their sections, the role path, and the
// hand-over (delegation) rules. It is NOT a second approval engine: items,
// states and decisions stay in each module's own row, and each module's own
// approve / reject route calls assertCanApprove before it acts. An
// ApprovalDelegation row only says WHO may decide a section (spec §7 as
// amended by A3, A4, A5, A12, A13, A21, A22, A23).
//
//   APPROVAL_RIGHTS         one entry per approval type (providers, routes and
//                           the delegation catalogue all read it)
//   canApprove              may the caller decide this item? (never throws)
//   assertCanApprove        same, throws 403/404; widens RLS on success
//   approvalQueueTenantIds  companies whose queue of a type the caller may list
//   liveDelegations         the caller's live hand-overs (checked on every use)
//   delegationCovering      the live hand-over that covers one item, or null
//   submittedThroughHeadOffice / throughHeadOfficeIds   A3
//   approvalSubject         A5: an item's companies / submitters on serviceClient
//   auditApproval           the one `approval.decide` audit row
//
// Nothing is cached: expiry, revocation, unlinking, leaving the head office or
// losing the module all bite on the very next request.
//
// With no head office and no delegation rows (today's live state) every check
// here reduces to "the role list, in the caller's member companies" — the
// guards the modules already had.

import type { FastifyRequest } from 'fastify'
import type { Prisma, PrismaClient } from '@prisma/client'
import { serviceClient } from './prisma.js'
import { AppError } from './errors.js'
import { audit } from './audit.js'
import { WORKSPACES } from './workspaces.js'
import { effectiveModulesForUser } from './moduleAccess.js'
import { headOfficeReach, reachTenantIds, widenRls } from './headOffice.js'
import { assertNotAmongSubmitters } from './separation-of-duties.js'
import { resolveTenantScope } from './tenantScope.js'
import { runWithRlsContext } from './rlsContext.js'
import { approvalDecided } from '../modules/approvals/notify.js'
import { ADMIN_ONLY, APPROVERS, MANAGERS, usesOtpLogin } from '../modules/auth/middleware.js'

type Db = PrismaClient | Prisma.TransactionClient

// ─── Types and sections ─────────────────────────────────────────────────────

/** Every approval type the inbox knows. `approvals/types.ts` re-exports it. */
export const APPROVAL_TYPES = [
  'staff_login',
  'storefront_publish',
  'purchase_order',
  'recipe',
  'hr_request',
  'payroll_run',
  'tip_pool',
  'stock_transfer',
  'cash_voucher',
  // Finance wave B (2026-10-14).
  'fixed_asset_request',   // disposal / scrap / write-down / capitalisation — finance asks, the CEO approves
  'intercompany_transfer', // a due-to / due-from transfer between two group companies (incl. head-office pairs)
  'on_account_client',     // a new on-account client or a credit-limit change
  'bad_debt',              // a receivable write-off — the CEO approves every one
  'raast_void',            // a Raast receipt "void, never booked" — CEO only
  'grni_writeoff',         // writing off goods received but never billed
  'cash_request_hod',      // RETIRED 2026-10-15 (the HOD step is gone) — kept so saved links and filters still parse
  'cash_request_finance',  // a cash voucher waiting for finance's approval (2026-10-15 flow)
  'stock_difference',      // a waste / count difference waiting in 1290 for the CEO (H20)
  // Head office (D1/D3, 2026-10-15).
  'journal_request',       // a manual journal finance prepared (kind post / reverse)
  'ho_recharge',           // a head office's monthly recharge run (or true-up)
  'connector_change',      // an IT change to a company's POS connector settings
] as const
export type ApprovalType = (typeof APPROVAL_TYPES)[number]

/**
 * Approval sections (spec §7.1): `ceo` holds the items nobody else may
 * approve; procurement is Operations' "Stock & buying" buying side; the rest
 * are the workspaces. Delegations may name every section except `ceo`
 * (CHECK approval_delegations_section_chk).
 */
export const APPROVAL_SECTIONS = ['ceo', 'operations', 'procurement', 'finance', 'marketing', 'hr', 'dev'] as const
export type ApprovalSection = (typeof APPROVAL_SECTIONS)[number]

/** The sections a delegation may name (never `ceo`). */
export const DELEGABLE_SECTIONS = ['operations', 'procurement', 'finance', 'marketing', 'hr', 'dev'] as const
export type DelegableSection = (typeof DELEGABLE_SECTIONS)[number]

/** Section titles: the workspace's own title (procurement: "Procurement"). */
export const APPROVAL_SECTION_TITLES: Readonly<Record<ApprovalSection, string>> = Object.fromEntries(
  APPROVAL_SECTIONS.map((s) => [s, s === 'procurement' ? 'Procurement' : (WORKSPACES.find((w) => w.id === s)?.title ?? s)]),
) as Record<ApprovalSection, string>

// HR request steps (hr/logic.ts canActOnStep): HR_APPROVERS and MGMT_APPROVERS.
const HR_STEP_ROLES = ['hr', 'admin', 'owner', 'management'] as const
// hr/routes.ts PAYROLL_APPROVERS.
const PAYROLL_APPROVERS = ['admin', 'owner', 'management'] as const

export interface ApprovalRight {
  label: string
  section: ApprovalSection
  /** The module whose queue lists the item (the inbox reads it as the caller). */
  queueModule: string
  /**
   * The role path: roles the module's own approve route admits (members of the
   * item's companies only). A23: the one copy of each approver list. For a
   * per-item type (`perItem`) the roles whose steps it may name.
   */
  roles: readonly string[]
  /** The module decides per item (HR steps, the cash request HOD) — no role list. */
  perItem?: boolean
  /** May the section be handed to a delegate for this type? */
  delegable: boolean
  /** A delegate must also hold this module. */
  mustHoldModule: string | null
  /** Who owns the item for delegation cover (A4): the company, or the head office. */
  ownership: 'company' | 'head_office'
  /** Some items of this type are CEO-only (a password-role login, a journal reversal, a shared page…). */
  itemCeoOnly?: boolean
  /** A delegation must be head-office-wide (ho_recharge). */
  hoWideOnly?: boolean
  /** The through-head-office rule does not apply (stock transfers: the company's managers decide). */
  exemptThroughHeadOffice?: boolean
  /** Which items of the type a delegate may take — shown in the catalogue. */
  delegableNote?: string
}

/** One entry per approval type (spec §7.2, the 2026-10-15 merged plan). */
export const APPROVAL_RIGHTS: Readonly<Record<ApprovalType, ApprovalRight>> = {
  staff_login: {
    label: 'New logins', section: 'operations', queueModule: 'role_management', roles: ADMIN_ONLY,
    delegable: true, mustHoldModule: 'staff_directory', ownership: 'company', itemCeoOnly: true,
    delegableNote: 'Floor logins only (cashier, FOH, BOH, kitchen, expediter); every password login stays with the CEO',
  },
  storefront_publish: {
    label: 'Website changes', section: 'marketing', queueModule: 'storefront', roles: ADMIN_ONLY,
    delegable: true, mustHoldModule: 'storefront', ownership: 'company', itemCeoOnly: true,
    delegableNote: "A company's own brand pages only; shared servd pages, rollback and delete stay with the CEO",
  },
  purchase_order: {
    label: 'Purchase orders', section: 'procurement', queueModule: 'procurement', roles: ADMIN_ONLY,
    delegable: true, mustHoldModule: 'procurement', ownership: 'company',
  },
  recipe: {
    label: 'Recipes', section: 'operations', queueModule: 'recipes', roles: APPROVERS,
    delegable: true, mustHoldModule: 'recipes', ownership: 'company', itemCeoOnly: true,
    delegableNote: 'A recipe with no company of its own stays with the CEO',
  },
  hr_request: {
    label: 'HR requests', section: 'hr', queueModule: 'staff_hr', roles: HR_STEP_ROLES, perItem: true,
    delegable: true, mustHoldModule: 'staff_hr', ownership: 'company',
    delegableNote: 'The final sign-off step',
  },
  payroll_run: {
    label: 'Payroll', section: 'hr', queueModule: 'staff_hr', roles: PAYROLL_APPROVERS,
    delegable: true, mustHoldModule: 'staff_hr', ownership: 'company',
    delegableNote: 'Approve, lock and reopen (never marking paid); never a run with your own payslip',
  },
  tip_pool: {
    label: 'Tip pools', section: 'finance', queueModule: 'payroll', roles: APPROVERS,
    delegable: true, mustHoldModule: 'payroll', ownership: 'company',
  },
  stock_transfer: {
    label: 'Stock transfers', section: 'operations', queueModule: 'inventory', roles: MANAGERS,
    delegable: false, mustHoldModule: null, ownership: 'company', exemptThroughHeadOffice: true,
  },
  cash_voucher: {
    label: 'Cash requests', section: 'ceo', queueModule: 'accounting', roles: ADMIN_ONLY,
    delegable: false, mustHoldModule: null, ownership: 'company',
  },
  fixed_asset_request: {
    label: 'Fixed assets', section: 'ceo', queueModule: 'accounting', roles: ADMIN_ONLY,
    delegable: false, mustHoldModule: null, ownership: 'company',
  },
  intercompany_transfer: {
    label: 'Inter-company transfers', section: 'finance', queueModule: 'accounting', roles: ADMIN_ONLY,
    delegable: true, mustHoldModule: 'accounting', ownership: 'head_office', itemCeoOnly: true,
    delegableNote: "A head office's own transfers with its linked companies; company ↔ company stays with the CEO",
  },
  on_account_client: {
    label: 'On-account clients', section: 'ceo', queueModule: 'accounting', roles: ADMIN_ONLY,
    delegable: false, mustHoldModule: null, ownership: 'company',
  },
  bad_debt: {
    label: 'Bad-debt write-offs', section: 'ceo', queueModule: 'accounting', roles: ADMIN_ONLY,
    delegable: false, mustHoldModule: null, ownership: 'company',
  },
  raast_void: {
    label: 'Raast voids', section: 'ceo', queueModule: 'reconciliation', roles: ADMIN_ONLY,
    delegable: false, mustHoldModule: null, ownership: 'company',
  },
  grni_writeoff: {
    label: 'Received, never billed', section: 'ceo', queueModule: 'procurement', roles: ADMIN_ONLY,
    delegable: false, mustHoldModule: null, ownership: 'company',
  },
  cash_request_hod: {
    // RETIRED 2026-10-15: finance replaced the HOD signature (cash_request_finance). No provider lists it.
    label: 'Cash requests to sign (HOD)', section: 'finance', queueModule: 'accounting', roles: [], perItem: true,
    delegable: false, mustHoldModule: null, ownership: 'company',
  },
  cash_request_finance: {
    // Finance's approval of a cash voucher (POST /trustops/cash-vouchers/:id/finance-approve): role finance holding
    // the accounting module (the CEO may also act, but then never gives the final approval on the same voucher —
    // the CEO's own step is cash_voucher). Never handed over.
    label: 'Cash vouchers — finance approval', section: 'finance', queueModule: 'accounting', roles: ['finance'],
    delegable: false, mustHoldModule: null, ownership: 'company',
  },
  stock_difference: {
    label: 'Stock differences', section: 'ceo', queueModule: 'accounting', roles: ADMIN_ONLY,
    delegable: false, mustHoldModule: null, ownership: 'company',
  },
  journal_request: {
    label: 'Journal requests', section: 'finance', queueModule: 'accounting', roles: ADMIN_ONLY,
    delegable: true, mustHoldModule: 'accounting', ownership: 'company', itemCeoOnly: true,
    delegableNote: 'Kind post only; reversals stay with the CEO',
  },
  ho_recharge: {
    label: 'Head-office recharges', section: 'finance', queueModule: 'accounting', roles: ADMIN_ONLY,
    delegable: true, mustHoldModule: 'accounting', ownership: 'head_office', hoWideOnly: true,
    delegableNote: 'Head-office-wide hand-overs only; reversal stays with the CEO',
  },
  connector_change: {
    label: 'POS connector changes', section: 'dev', queueModule: 'api_pos', roles: ADMIN_ONLY,
    delegable: true, mustHoldModule: 'api_pos', ownership: 'company',
  },
}

/**
 * Per-type hand-over switches. A delegable type listed `false` here is refused
 * at grant (422 SECTION_NOT_YET_DELEGABLE) and never honoured at use, until the
 * owner says yes and the constant is flipped:
 *  - storefront_publish (spec §7.2: "after the owner confirms");
 *  - journal_request (A22: manual journals were never on the hand-over list).
 * A type not listed is enabled (if `delegable`).
 */
export const DELEGATION_ENABLED: Readonly<Partial<Record<ApprovalType, boolean>>> = {
  storefront_publish: false,
  journal_request: false,
}

export function isApprovalType(t: string): t is ApprovalType {
  return (APPROVAL_TYPES as readonly string[]).includes(t)
}

function rightOf(type: string): ApprovalRight {
  const r = isApprovalType(type) ? APPROVAL_RIGHTS[type] : undefined
  if (!r) throw new AppError('UNKNOWN_APPROVAL_TYPE', `Unknown approval type ${type}`, 500)
  return r
}

/** Delegable AND switched on (DELEGATION_ENABLED). */
export function delegationEnabled(type: string): boolean {
  const r = isApprovalType(type) ? APPROVAL_RIGHTS[type] : undefined
  return !!r && r.delegable && DELEGATION_ENABLED[type as ApprovalType] !== false
}

/** The delegable types of a section (whether or not switched on yet). */
export function delegableTypesOf(section: string): ApprovalType[] {
  return APPROVAL_TYPES.filter((t) => APPROVAL_RIGHTS[t].delegable && APPROVAL_RIGHTS[t].section === section)
}

/**
 * The section an item is decided in. Explicit per type (A23); a few types
 * move an item to `ceo` by what it is.
 */
export function sectionOf(type: string, item?: { role?: string | null; tenantId?: string | null; kind?: string | null }): ApprovalSection {
  const r = rightOf(type)
  if (type === 'staff_login' && item?.role && !usesOtpLogin(item.role)) return 'ceo'
  if (type === 'storefront_publish' && item && item.tenantId === null) return 'ceo'
  if (type === 'journal_request' && item?.kind === 'reverse') return 'ceo'
  if (type === 'recipe' && item && item.tenantId === null) return 'ceo'
  return r.section
}

// ─── Inputs and results ─────────────────────────────────────────────────────

export interface CanApproveInput {
  type: string
  /** The item's owning tenant (a recharge run: its head office). Null = a shared row → CEO only. */
  tenantId: string | null
  /** The served company, when the item belongs to a head office ↔ company pair. */
  companyTenantId?: string | null
  /** Every company the item posts into or changes. Default [tenantId]. */
  touchesTenantIds: string[]
  /** Creator / submitter / preparers / editors — none of them may approve it (the CEO excepted). */
  submittedByIds: Array<string | null | undefined>
  /** Stamped at submit (A3): the head office it came through. */
  viaHeadOfficeId?: string | null
  /** When it was submitted (A3: the link must have been live then). Default: now. */
  submittedAt?: Date | null
  /** Item-level CEO-only (a password-role login, a journal reversal, a company ↔ company transfer…). */
  ceoOnly?: boolean
  /** Override the role path (default: the caller's role is in APPROVAL_RIGHTS[type].roles). */
  roleListAllows?: boolean
  /** For sectionOf: the login's role, the journal request's kind. */
  role?: string | null
  kind?: string | null
  /** For the self-approval flag and the audit. */
  entity?: string
  entityId?: string
  action?: string
}

export type ApprovalGrant = { via: 'role'; delegationId?: undefined } | { via: 'delegation'; delegationId: string }

export type ApprovalDecision =
  | { ok: true; grant: ApprovalGrant; section: ApprovalSection }
  | { ok: false; status: 403 | 404; code: string; message: string; section: ApprovalSection; selfApproval?: boolean }

export interface LiveDelegation {
  id: string
  tenantId: string
  companyTenantId: string | null
  section: DelegableSection
  approvalTypes: string[]
  delegateUserId: string
  startsAt: Date
  endsAt: Date | null
}

export interface ApprovalSubject {
  /** Every company the item belongs to or touches (an empty list = no company: CEO only). */
  companyIds: string[]
  /** The item's owner: its company, or the head office of a run / head-office pair. Null = shared / no company. */
  ownerTenantId: string | null
  /** The served company of a head-office pair (intercompany_transfer), else null. */
  companyTenantId?: string | null
  submitterIds: string[]
  viaHeadOfficeId: string | null
  status: string
  submittedAt?: Date | null
  /** For sectionOf / ceoOnly: a login's role, a journal request's kind, a transfer's kind. */
  role?: string | null
  kind?: string | null
  /** intercompany_transfer: one side is a head office with a live link to the other. */
  headOfficePair?: boolean
}

const uniq = <T>(xs: Iterable<T>) => [...new Set(xs)]
const clean = (ids: Array<string | null | undefined>) => uniq(ids.filter((x): x is string => typeof x === 'string' && x.length > 0))

// ─── Head-office facts (serviceClient; never cached) ────────────────────────

/** Live links of these head offices: Map<hoId, Set<companyId>> (both sides live). */
async function liveCompaniesOf(hoIds: readonly string[], db: Db = serviceClient): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>()
  if (hoIds.length === 0) return out
  const reach = await headOfficeReach(uniq(hoIds), db)
  for (const [company, hos] of reach) {
    for (const ho of hos) {
      const set = out.get(ho) ?? new Set<string>()
      set.add(company)
      out.set(ho, set)
    }
  }
  return out
}

/** The head offices each user belongs to (TenantMember ∪ User.tenantId), non-admins only. */
async function headOfficesOfUsers(userIds: readonly string[], db: Db = serviceClient): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>()
  if (userIds.length === 0) return out
  const users = await db.user.findMany({ where: { id: { in: uniq(userIds) } }, select: { id: true, role: true, tenantId: true } })
  const nonAdmin = users.filter((u) => u.role !== 'admin')
  if (nonAdmin.length === 0) return out
  const [members, primaries] = await Promise.all([
    db.tenantMember.findMany({
      where: { userId: { in: nonAdmin.map((u) => u.id) }, tenant: { kind: 'head_office' } },
      select: { userId: true, tenantId: true },
    }),
    db.tenant.findMany({
      where: { id: { in: clean(nonAdmin.map((u) => u.tenantId)) }, kind: 'head_office' },
      select: { id: true },
    }),
  ])
  const hoPrimary = new Set(primaries.map((t) => t.id))
  const add = (u: string, t: string) => { const s = out.get(u) ?? new Set<string>(); s.add(t); out.set(u, s) }
  for (const m of members) add(m.userId, m.tenantId)
  for (const u of nonAdmin) if (u.tenantId && hoPrimary.has(u.tenantId)) add(u.id, u.tenantId)
  return out
}

export interface ThroughItem {
  tenantId: string | null
  submittedByIds: Array<string | null | undefined>
  submittedAt?: Date | string | null
  viaHeadOfficeId?: string | null
}

/**
 * A3, batched: for each item, the head offices it came through — its stored
 * viaHeadOfficeId, plus the head office of every submitter who is a non-admin
 * member of a head office whose link to the item's company was live at submit
 * time (link.startedAt ≤ submittedAt < coalesce(endedAt, ∞)). Being a member
 * of the company too does NOT exempt them. Two queries for the whole batch;
 * with no head office anywhere they return nothing.
 */
export async function throughHeadOfficeBatch(items: readonly ThroughItem[], db: Db = serviceClient): Promise<string[][]> {
  const out: string[][] = items.map((i) => (i.viaHeadOfficeId ? [i.viaHeadOfficeId] : []))
  const submitters = clean(items.flatMap((i) => (i.tenantId ? i.submittedByIds : [])))
  if (submitters.length === 0) return out
  const hosOf = await headOfficesOfUsers(submitters, db)
  if (hosOf.size === 0) return out
  const hoIds = uniq([...hosOf.values()].flatMap((s) => [...s]))
  const companies = clean(items.map((i) => i.tenantId))
  const links = await db.headOfficeLink.findMany({
    where: { tenantId: { in: hoIds }, companyTenantId: { in: companies } },
    select: { tenantId: true, companyTenantId: true, startedAt: true, endedAt: true },
  })
  const now = new Date()
  items.forEach((item, i) => {
    if (!item.tenantId) return
    const at = item.submittedAt ? new Date(item.submittedAt) : now
    const matched = new Set(out[i])
    for (const sid of clean(item.submittedByIds)) {
      for (const ho of hosOf.get(sid) ?? []) {
        const live = links.some((l) => l.tenantId === ho && l.companyTenantId === item.tenantId
          && l.startedAt <= at && (l.endedAt === null || l.endedAt > at))
        if (live) matched.add(ho)
      }
    }
    out[i] = [...matched]
  })
  return out
}

/** The head offices one item came through (A3), or []. */
export async function throughHeadOfficeIds(item: ThroughItem): Promise<string[]> {
  return (await throughHeadOfficeBatch([item]))[0] ?? []
}

/**
 * A3: some submitter is a non-admin member of a head office whose link to the
 * item's company was live at submit time (or the item carries viaHeadOfficeId).
 */
export async function submittedThroughHeadOffice(item: {
  tenantId: string
  submittedByIds: Array<string | null | undefined>
  submittedAt?: Date | null
  viaHeadOfficeId?: string | null
}): Promise<boolean> {
  return (await throughHeadOfficeIds(item)).length > 0
}

// ─── Delegations ─────────────────────────────────────────────────────────────

const LIVE_HO = { isActive: true, deletedAt: null, kind: 'head_office' } as const

/** The where-clause of a delegation row that is live NOW (not revoked, inside its window, head office live). */
export function liveDelegationWhere(now = new Date()): Prisma.ApprovalDelegationWhereInput {
  return {
    revokedAt: null,
    startsAt: { lte: now },
    OR: [{ endsAt: null }, { endsAt: { gt: now } }],
    headOffice: LIVE_HO,
  }
}

type DelegationRow = {
  id: string; tenantId: string; companyTenantId: string | null; section: string; approvalTypes: string[]
  delegateUserId: string; startsAt: Date; endsAt: Date | null
}

const DELEGATION_SELECT = {
  id: true, tenantId: true, companyTenantId: true, section: true, approvalTypes: true,
  delegateUserId: true, startsAt: true, endsAt: true,
} as const

/** The types a delegation row names that are in its section and delegable ([] = every delegable type of the section). */
function typesOfRow(d: { section: string; approvalTypes: string[] }): ApprovalType[] {
  const inSection = delegableTypesOf(d.section)
  return d.approvalTypes.length === 0 ? inSection : inSection.filter((t) => d.approvalTypes.includes(t))
}

/**
 * Keep the rows whose delegate is still eligible NOW: an active, non-admin
 * login, still a member of the head office, holding the module of at least one
 * type the row names; a company-scoped row also needs its link live.
 * Returns each row with the types the delegate still holds the module for.
 */
async function stillEligible(rows: DelegationRow[], db: Db = serviceClient): Promise<Array<DelegationRow & { types: ApprovalType[] }>> {
  if (rows.length === 0) return []
  const userIds = uniq(rows.map((r) => r.delegateUserId))
  const [users, members, links] = await Promise.all([
    db.user.findMany({
      where: { id: { in: userIds }, isActive: true, deletedAt: null, accountStatus: 'active' },
      select: { id: true, role: true, tenantId: true, moduleAllow: true, moduleDeny: true },
    }),
    db.tenantMember.findMany({ where: { userId: { in: userIds }, tenantId: { in: uniq(rows.map((r) => r.tenantId)) } }, select: { userId: true, tenantId: true } }),
    liveCompaniesOf(uniq(rows.map((r) => r.tenantId)), db),
  ])
  const userById = new Map(users.map((u) => [u.id, u]))
  const modulesOf = new Map<string, Set<string>>()
  for (const u of users) modulesOf.set(u.id, await effectiveModulesForUser({ role: u.role, moduleAllow: u.moduleAllow, moduleDeny: u.moduleDeny }))
  const out: Array<DelegationRow & { types: ApprovalType[] }> = []
  for (const r of rows) {
    const u = userById.get(r.delegateUserId)
    if (!u || u.role === 'admin') continue
    const member = u.tenantId === r.tenantId || members.some((m) => m.userId === u.id && m.tenantId === r.tenantId)
    if (!member) continue
    if (r.companyTenantId && !links.get(r.tenantId)?.has(r.companyTenantId)) continue
    const mods = modulesOf.get(u.id)!
    const types = typesOfRow(r).filter((t) => { const m = APPROVAL_RIGHTS[t].mustHoldModule; return !m || mods.has(m) })
    if (types.length === 0) continue
    out.push({ ...r, types })
  }
  return out
}

/** The caller's live (started, not ended, not revoked, still eligible) delegations, on serviceClient. */
export async function liveDelegations(userId: string): Promise<LiveDelegation[]> {
  if (!userId) return []
  const rows = await serviceClient.approvalDelegation.findMany({
    where: { delegateUserId: userId, ...liveDelegationWhere() },
    select: DELEGATION_SELECT,
    orderBy: { createdAt: 'asc' },
  })
  return (await stillEligible(rows)).map(({ types: _t, ...d }) => ({ ...d, section: d.section as DelegableSection }))
}

/** Every live, eligible delegation (any delegate) — the CEO's handed-over view. Optionally only these head offices. */
export async function allLiveDelegations(hoIds?: readonly string[]): Promise<Array<LiveDelegation & { types: ApprovalType[] }>> {
  const rows = await serviceClient.approvalDelegation.findMany({
    where: { ...liveDelegationWhere(), ...(hoIds ? { tenantId: { in: [...hoIds] } } : {}) },
    select: DELEGATION_SELECT,
    orderBy: { createdAt: 'asc' },
  })
  return (await stillEligible(rows)).map((d) => ({ ...d, section: d.section as DelegableSection }))
}

/** Is this live delegation's cover over this item (ownership rules, A4 / A13)? Pure, given the live links. */
export function delegationCovers(
  d: { tenantId: string; companyTenantId: string | null; section: string; types: readonly string[] },
  type: string,
  item: { tenantId: string | null; companyTenantId?: string | null; touchesTenantIds: string[]; section?: ApprovalSection; throughHeadOfficeIds?: string[] },
  linked: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  const r = rightOf(type)
  if (!delegationEnabled(type)) return false
  const section = item.section ?? r.section
  if (section === 'ceo' || d.section !== section) return false
  if (!d.types.includes(type)) return false
  const companies = linked.get(d.tenantId) ?? new Set<string>()
  if (r.ownership === 'head_office') {
    // A4: the head office that owns the item.
    if (r.hoWideOnly) return item.tenantId === d.tenantId && d.companyTenantId === null
    // intercompany_transfer: one side is this head office, the other a company it serves now.
    const touches = uniq([...(item.tenantId ? [item.tenantId] : []), ...item.touchesTenantIds])
    if (!touches.includes(d.tenantId)) return false
    const other = item.companyTenantId ?? touches.find((t) => t !== d.tenantId) ?? null
    if (!other || !companies.has(other)) return false
    return d.companyTenantId === null || d.companyTenantId === other
  }
  // Company-owned: the one delegation covers EVERY touched tenant.
  const touches = uniq(item.touchesTenantIds.length ? item.touchesTenantIds : (item.tenantId ? [item.tenantId] : []))
  if (touches.length === 0) return false
  const covers = (t: string) => (d.companyTenantId ? t === d.companyTenantId && companies.has(t) : t === d.tenantId || companies.has(t))
  if (!touches.every(covers)) return false
  // A13: an item that came through a head office goes only to THAT head office's delegate.
  const through = item.throughHeadOfficeIds ?? []
  if (through.length > 0 && !through.includes(d.tenantId)) return false
  return true
}

/** The live delegation that covers this type for the item (A4 ownership, A13), or null. */
export async function delegationCovering(
  userId: string,
  type: string,
  item: {
    tenantId: string | null; companyTenantId?: string | null; touchesTenantIds: string[]
    section?: ApprovalSection; throughHeadOfficeIds?: string[]
  },
): Promise<LiveDelegation | null> {
  if (!delegationEnabled(type)) return null
  if ((item.section ?? rightOf(type).section) === 'ceo') return null
  const rows = await serviceClient.approvalDelegation.findMany({
    where: { delegateUserId: userId, ...liveDelegationWhere() },
    select: DELEGATION_SELECT,
    orderBy: { createdAt: 'asc' },
  })
  const live = await stillEligible(rows)
  if (live.length === 0) return null
  const linked = await liveCompaniesOf(uniq(live.map((d) => d.tenantId)))
  const hit = live.find((d) => delegationCovers(d, type, item, linked))
  if (!hit) return null
  const { types: _t, ...d } = hit
  return { ...d, section: d.section as DelegableSection }
}

/**
 * The viewer AS DELEGATE: their live, still-eligible delegations (with the
 * types each covers) and the live links of those head offices — what the inbox
 * runs delegationCovers against, so it lists exactly what delegationCovering
 * would let the approve route accept. Null when they hold none.
 */
export async function liveDelegationsOfDelegate(userId: string): Promise<{
  delegations: Array<LiveDelegation & { types: ApprovalType[] }>
  linked: Map<string, Set<string>>
} | null> {
  if (!userId) return null
  const rows = await serviceClient.approvalDelegation.findMany({
    where: { delegateUserId: userId, ...liveDelegationWhere() },
    select: DELEGATION_SELECT,
    orderBy: { createdAt: 'asc' },
  })
  const live = await stillEligible(rows)
  if (live.length === 0) return null
  const linked = await liveCompaniesOf(uniq(live.map((d) => d.tenantId)))
  return { delegations: live.map((d) => ({ ...d, section: d.section as DelegableSection })), linked }
}

/** The tenants each live delegation covers for each type (the HO itself + its live companies, or the one company). */
function coverOf(d: { tenantId: string; companyTenantId: string | null; types: readonly ApprovalType[] }, linked: ReadonlyMap<string, ReadonlySet<string>>): Map<ApprovalType, Set<string>> {
  const out = new Map<ApprovalType, Set<string>>()
  const companies = [...(linked.get(d.tenantId) ?? [])]
  for (const t of d.types) {
    if (!delegationEnabled(t)) continue
    const r = APPROVAL_RIGHTS[t]
    if (r.hoWideOnly && d.companyTenantId) continue
    const set = new Set<string>()
    if (d.companyTenantId) {
      set.add(d.companyTenantId)
      if (r.ownership === 'head_office') set.add(d.tenantId)
    } else {
      set.add(d.tenantId)
      for (const c of companies) set.add(c)
    }
    out.set(t, set)
  }
  return out
}

/** Per type, every tenant the user's live delegations cover — whatever the view. */
export async function delegatedTenantsByType(userId: string): Promise<Map<ApprovalType, Set<string>>> {
  const out = new Map<ApprovalType, Set<string>>()
  if (!userId) return out
  const rows = await serviceClient.approvalDelegation.findMany({
    where: { delegateUserId: userId, ...liveDelegationWhere() },
    select: DELEGATION_SELECT,
  })
  if (rows.length === 0) return out
  const live = await stillEligible(rows)
  const linked = await liveCompaniesOf(uniq(live.map((d) => d.tenantId)))
  for (const d of live) {
    for (const [t, set] of coverOf(d, linked)) {
      const cur = out.get(t) ?? new Set<string>()
      for (const id of set) cur.add(id)
      out.set(t, cur)
    }
  }
  return out
}

// ─── The decision ────────────────────────────────────────────────────────────

function deny(status: 403 | 404, section: ApprovalSection, ceoOnly: boolean): ApprovalDecision {
  if (status === 404) return { ok: false, status, code: 'NOT_FOUND', message: 'Not found', section }
  return {
    ok: false, status, code: 'APPROVAL_NOT_YOURS', section,
    message: ceoOnly || section === 'ceo' ? 'This needs the CEO' : `This needs the ${APPROVAL_SECTION_TITLES[section]} approver`,
  }
}

/**
 * The full decision for one item (spec §7.4 as amended). Pure read: no flag,
 * no RLS change. `assertCanApprove` acts on it.
 */
export async function decideApproval(req: FastifyRequest, input: CanApproveInput): Promise<ApprovalDecision> {
  const r = rightOf(input.type)
  const actor = req.staffUser
  const section = sectionOf(input.type, { role: input.role, tenantId: input.tenantId, kind: input.kind })
  const ceoOnly = !!input.ceoOnly || input.tenantId === null || section === 'ceo'
  if (!actor) return deny(404, section, ceoOnly)
  const touches = clean(input.touchesTenantIds.length ? input.touchesTenantIds : [input.tenantId])
  const members = new Set(actor.memberTenantIds ?? [])
  const isAdmin = actor.role === 'admin'
  const submitters = clean(input.submittedByIds)
  const selfSubmitted = !isAdmin && submitters.includes(actor.id)

  // 1. Role path: the module's role list, in the caller's member companies,
  //    and (non-admins) not an item that came through a head office.
  const roleAllows = input.roleListAllows ?? (r.roles as readonly string[]).includes(actor.role)
  let through: string[] | null = null
  const throughIds = async () => (through ??= input.tenantId
    ? await throughHeadOfficeIds({ tenantId: input.tenantId, submittedByIds: submitters, submittedAt: input.submittedAt, viaHeadOfficeId: input.viaHeadOfficeId })
    : [])
  if (roleAllows) {
    const inMembers = touches.length > 0 ? touches.every((t) => members.has(t)) : isAdmin
    if (inMembers && (isAdmin || r.exemptThroughHeadOffice || (await throughIds()).length === 0)) {
      return selfSubmitted
        ? { ok: false, status: 403, code: 'SELF_APPROVAL_BLOCKED', message: "You can't approve something you submitted or prepared. Have a colleague or the CEO decide it.", section, selfApproval: true }
        : { ok: true, grant: { via: 'role' }, section }
    }
  }

  // 2. Delegation path.
  if (!ceoOnly && delegationEnabled(input.type)) {
    const d = await delegationCovering(actor.id, input.type, {
      tenantId: input.tenantId, companyTenantId: input.companyTenantId ?? null, touchesTenantIds: touches,
      section, throughHeadOfficeIds: r.ownership === 'company' ? await throughIds() : [],
    })
    if (d) {
      return selfSubmitted
        ? { ok: false, status: 403, code: 'SELF_APPROVAL_BLOCKED', message: "You can't approve something you submitted or prepared. Have a colleague or the CEO decide it.", section, selfApproval: true }
        : { ok: true, grant: { via: 'delegation', delegationId: d.id }, section }
    }
  }

  // 3. Denied: 403 when the company is one the caller can see (member, reach or
  //    a delegation's cover), else 404 so the id is not confirmed.
  const visible = new Set<string>([...members, ...reachTenantIds(req)])
  for (const set of (await delegatedTenantsByType(actor.id)).values()) for (const t of set) visible.add(t)
  const seen = touches.some((t) => visible.has(t)) || (input.tenantId === null && members.size > 0 && roleAllows)
  return deny(seen ? 403 : 404, section, ceoOnly)
}

/** May the caller approve this item? Never throws for a plain "no" (nor flags). */
export async function canApprove(req: FastifyRequest, input: CanApproveInput): Promise<boolean> {
  return (await decideApproval(req, input)).ok
}

/**
 * Throws 403/404 unless the caller may approve; on success widens RLS to the
 * item's companies. A non-admin among the submitters gets 403
 * SELF_APPROVAL_BLOCKED and a `self_approval` flag (separation of duties).
 */
export async function assertCanApprove(req: FastifyRequest, input: CanApproveInput): Promise<ApprovalGrant> {
  const d = await decideApproval(req, input)
  if (d.ok) {
    const touches = clean(input.touchesTenantIds.length ? input.touchesTenantIds : [input.tenantId])
    widenRls(req, touches)
    return d.grant
  }
  if (d.selfApproval) {
    await assertNotAmongSubmitters(req.staffUser!, input.submittedByIds, {
      tenantId: input.tenantId,
      action: input.action ?? `approve ${APPROVAL_RIGHTS[input.type as ApprovalType]?.label.toLowerCase() ?? input.type}`,
      entity: input.entity ?? input.type,
      entityId: input.entityId ?? '',
    })
  }
  throw new AppError(d.code, d.message, d.status)
}

/**
 * Companies whose queue of this type the caller may list: (the companies in
 * view ∩ members, when the role list admits the caller) ∪ the companies a
 * live delegation covers for the type, whatever the view. Widens RLS to the
 * delegated part. An empty list with no right anywhere → the queue route
 * answers 403 (so the inbox drops the type).
 */
export async function approvalQueueTenantIds(req: FastifyRequest, type: string): Promise<string[]> {
  const r = rightOf(type)
  const actor = req.staffUser
  if (!actor) return []
  const out = new Set<string>()
  if ((r.roles as readonly string[]).includes(actor.role)) {
    const members = new Set(actor.memberTenantIds ?? [])
    for (const t of (await resolveTenantScope(req)).tenantIds) if (members.has(t)) out.add(t)
  }
  const delegated = (await delegatedTenantsByType(actor.id)).get(type as ApprovalType)
  if (delegated && delegated.size > 0) {
    for (const t of delegated) out.add(t)
    widenRls(req, [...delegated])
  }
  return [...out]
}

/** The one audit row of an approval decision (`approval.decide`): accounting for money types, identity otherwise. */
export async function auditApproval(
  req: FastifyRequest,
  e: { type: string; id: string; tenantId: string | null; decision: string; grant: ApprovalGrant; entity?: string; metadata?: Record<string, unknown> },
): Promise<void> {
  const section = isApprovalType(e.type) ? APPROVAL_RIGHTS[e.type].section : 'ceo'
  const money = section === 'finance' || ['purchase_order', 'cash_voucher', 'fixed_asset_request', 'bad_debt', 'raast_void', 'grni_writeoff', 'stock_difference', 'on_account_client', 'payroll_run'].includes(e.type)
  await audit({
    category: money ? 'accounting' : 'identity',
    action: 'approval.decide',
    entity: e.entity ?? e.type,
    entityId: e.id,
    userId: req.staffUser?.id ?? null,
    userEmail: req.staffUser?.email ?? null,
    tenantId: e.tenantId,
    metadata: {
      type: e.type, decision: e.decision, via: e.grant.via,
      ...(e.grant.via === 'delegation' ? { delegationId: e.grant.delegationId } : {}),
      ...(e.metadata ?? {}),
    },
  })
  // The bell (owner, 2026-10-16): tell the people waiting on this decision.
  // Every caller runs after its business transaction has committed; the
  // notice is queued (never awaited) and can never fail the decision.
  try {
    const actorId = req.staffUser?.id
    if (actorId && isApprovalType(e.type)) {
      const m = e.metadata ?? {}
      const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
      const at = m['decidedAt']
      const decidedAt = at instanceof Date ? at.toISOString() : (str(at) ?? new Date().toISOString())
      approvalDecided({
        type: e.type, id: e.id, tenantId: e.tenantId, decision: e.decision, actorId,
        note: str(m['reason']) ?? str(m['note']), decidedAt,
        ...(typeof m['final'] === 'boolean' && { final: m['final'] as boolean }),
        ...(str(m['publishAt']) && { publishAt: str(m['publishAt']) }),
      })
    }
  } catch (err) {
    console.warn(`[staff-notify] approval.decided not queued: ${(err as Error)?.message ?? String(err)}`)
  }
}

// ─── A5: an item's facts, on serviceClient, BEFORE assertCanApprove ─────────

/** Recipe companies (A21): a plate's / add-on's brand company; a component's users (walking up) and stock. */
async function recipeCompanies(id: string, db: Db): Promise<string[] | null> {
  const r = await db.recipe.findUnique({
    where: { id },
    select: {
      id: true, kind: true, pendingMenuItem: true,
      menuItem: { select: { concept: { select: { tenantId: true } } } },
      modifier: { select: { group: { select: { menuItem: { select: { concept: { select: { tenantId: true } } } } } } } },
    },
  })
  if (!r) return null
  const out = new Set<string>()
  const pendingTenant = async (p: unknown) => {
    const cid = (p as { conceptId?: string } | null)?.conceptId
    if (!cid) return null
    return (await db.concept.findUnique({ where: { id: cid }, select: { tenantId: true } }))?.tenantId ?? null
  }
  if (r.kind === 'plate') {
    const t = r.menuItem?.concept.tenantId ?? (await pendingTenant(r.pendingMenuItem))
    if (t) out.add(t)
    return [...out]
  }
  if (r.kind === 'modifier') {
    const t = r.modifier?.group.menuItem.concept.tenantId
    if (t) out.add(t)
    return [...out]
  }
  // Component: the companies of the dishes / add-ons above it (cycle-safe) + its own stock.
  const stock = await db.recipeIngredient.findMany({ where: { recipeId: id }, select: { inventoryItem: { select: { tenantId: true } } } })
  for (const s of stock) if (s.inventoryItem?.tenantId) out.add(s.inventoryItem.tenantId)
  const seen = new Set<string>([id])
  let frontier = [id]
  for (let depth = 0; frontier.length && depth < 20; depth++) {
    const ups = await db.recipeIngredient.findMany({ where: { prepRecipeId: { in: frontier } }, select: { recipeId: true } })
    const next = uniq(ups.map((u) => u.recipeId)).filter((x) => !seen.has(x))
    next.forEach((x) => seen.add(x))
    if (next.length === 0) break
    const parents = await db.recipe.findMany({
      where: { id: { in: next } },
      select: {
        id: true, kind: true, pendingMenuItem: true,
        menuItem: { select: { concept: { select: { tenantId: true } } } },
        modifier: { select: { group: { select: { menuItem: { select: { concept: { select: { tenantId: true } } } } } } } },
      },
    })
    frontier = []
    for (const p of parents) {
      if (p.kind === 'plate') { const t = p.menuItem?.concept.tenantId ?? (await pendingTenant(p.pendingMenuItem)); if (t) out.add(t) }
      else if (p.kind === 'modifier') { const t = p.modifier?.group.menuItem.concept.tenantId; if (t) out.add(t) }
      else frontier.push(p.id)
    }
  }
  return [...out]
}

/**
 * A21 for many recipes at once (the inbox's recipe provider): id → the
 * companies approvalSubject('recipe') will derive for it, so the inbox's
 * section and hand-over checks match the approve route. Missing ids → [].
 */
export async function recipeCompaniesBatch(ids: readonly string[], db: Db = serviceClient): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  await Promise.all(uniq([...ids]).map(async (id) => { out.set(id, (await recipeCompanies(id, db)) ?? []) }))
  return out
}

/** The owner company approvalSubject('recipe') picks from an A21 set (null = CEO only). */
export function recipeOwnerOf(companies: readonly string[]): string | null {
  return companies.length === 1 ? companies[0]! : (companies.length ? [...companies].sort()[0]! : null)
}

const subject = (s: Omit<ApprovalSubject, 'companyIds' | 'submitterIds'> & { companyIds: Array<string | null | undefined>; submitterIds: Array<string | null | undefined> }): ApprovalSubject => ({
  ...s, companyIds: clean(s.companyIds), submitterIds: clean(s.submitterIds),
})

/**
 * A5: resolve an item's companies / submitters / status on serviceClient
 * BEFORE assertCanApprove (the RLS client would hide a delegated item until
 * the right is proven). Selects only those facts; the module's handler
 * re-reads the row through `prisma` after the RLS context is widened.
 * Null = no such row. Storefront items take their id or slug.
 */
export async function approvalSubject(type: string, id: string, db: Db = serviceClient): Promise<ApprovalSubject | null> {
  rightOf(type)
  if (!id) return null
  switch (type as ApprovalType) {
    case 'staff_login': {
      const u = await db.user.findUnique({ where: { id }, select: { tenantId: true, invitedById: true, accountStatus: true, viaHeadOfficeId: true, createdAt: true, role: true } })
      return u && subject({ companyIds: [u.tenantId], ownerTenantId: u.tenantId, submitterIds: [u.invitedById], viaHeadOfficeId: u.viaHeadOfficeId, status: u.accountStatus, submittedAt: u.createdAt, role: u.role })
    }
    case 'storefront_publish': {
      const s = await db.siteLayout.findFirst({ where: { OR: [{ id }, { slug: id }] }, select: { tenantId: true, submittedById: true, draftUpdatedById: true, draftStatus: true, submittedAt: true, viaHeadOfficeId: true } })
      return s && subject({ companyIds: [s.tenantId], ownerTenantId: s.tenantId, submitterIds: [s.submittedById, s.draftUpdatedById], viaHeadOfficeId: s.viaHeadOfficeId, status: s.draftStatus, submittedAt: s.submittedAt })
    }
    case 'purchase_order': {
      const p = await db.purchaseOrder.findUnique({ where: { id }, select: { status: true, createdBy: true, viaHeadOfficeId: true, updatedAt: true, supplier: { select: { tenantId: true } } } })
      return p && subject({ companyIds: [p.supplier.tenantId], ownerTenantId: p.supplier.tenantId, submitterIds: [p.createdBy], viaHeadOfficeId: p.viaHeadOfficeId, status: p.status, submittedAt: null })
    }
    case 'recipe': {
      const r = await db.recipe.findUnique({ where: { id }, select: { status: true, submittedById: true, submittedAt: true, createdById: true, editedByIds: true, viaHeadOfficeId: true } })
      if (!r) return null
      const companies = (await recipeCompanies(id, db)) ?? []
      // A21: an empty set = no company of its own → CEO only (owner null).
      return subject({
        companyIds: companies, ownerTenantId: recipeOwnerOf(companies),
        submitterIds: [r.submittedById, r.createdById, ...r.editedByIds], viaHeadOfficeId: r.viaHeadOfficeId, status: r.status, submittedAt: r.submittedAt,
      })
    }
    case 'hr_request': {
      const h = await db.hrRecord.findUnique({ where: { id }, select: { tenantId: true, createdById: true, status: true, viaHeadOfficeId: true, createdAt: true, section: true } })
      return h && subject({ companyIds: [h.tenantId], ownerTenantId: h.tenantId, submitterIds: [h.createdById], viaHeadOfficeId: h.viaHeadOfficeId, status: h.status, submittedAt: h.createdAt, kind: h.section })
    }
    case 'payroll_run': {
      const p = await db.hrPayrollRun.findUnique({ where: { id }, select: { tenantId: true, createdById: true, preparedByIds: true, status: true, viaHeadOfficeId: true, updatedAt: true } })
      return p && subject({ companyIds: [p.tenantId], ownerTenantId: p.tenantId, submitterIds: [p.createdById, ...p.preparedByIds], viaHeadOfficeId: p.viaHeadOfficeId, status: p.status, submittedAt: null })
    }
    case 'tip_pool': {
      const t = await db.tipPool.findUnique({ where: { id }, select: { tenantId: true, createdById: true, status: true } })
      return t && subject({ companyIds: [t.tenantId], ownerTenantId: t.tenantId, submitterIds: [t.createdById], viaHeadOfficeId: null, status: t.status })
    }
    case 'stock_transfer': {
      const s = await db.stockTransfer.findUnique({ where: { id }, select: { fromLocationId: true, toLocationId: true, requestedById: true, status: true, requestedAt: true } })
      if (!s) return null
      const locs = await db.location.findMany({ where: { id: { in: [s.fromLocationId, s.toLocationId] } }, select: { id: true, tenantId: true } })
      const from = locs.find((l) => l.id === s.fromLocationId)?.tenantId ?? null
      return subject({ companyIds: locs.map((l) => l.tenantId), ownerTenantId: from, submitterIds: [s.requestedById], viaHeadOfficeId: null, status: s.status, submittedAt: s.requestedAt })
    }
    case 'cash_voucher':
    case 'cash_request_hod':
    case 'cash_request_finance': {
      const c = await db.cashVoucher.findUnique({ where: { id }, select: { tenantId: true, preparedById: true, payeeUserId: true, status: true, createdAt: true } })
      return c && subject({ companyIds: [c.tenantId], ownerTenantId: c.tenantId, submitterIds: [c.preparedById, c.payeeUserId], viaHeadOfficeId: null, status: c.status, submittedAt: c.createdAt })
    }
    case 'fixed_asset_request': {
      const e = await db.fixedAssetEvent.findUnique({ where: { id }, select: { tenantId: true, requestedById: true, status: true, requestedAt: true, kind: true } })
      return e && subject({ companyIds: [e.tenantId], ownerTenantId: e.tenantId, submitterIds: [e.requestedById], viaHeadOfficeId: null, status: e.status, submittedAt: e.requestedAt, kind: e.kind })
    }
    case 'intercompany_transfer': {
      const t = await db.intercompanyTransfer.findUnique({ where: { id }, select: { tenantId: true, counterpartyTenantId: true, preparedById: true, status: true, createdAt: true, kind: true } })
      if (!t) return null
      // A4: a head-office pair is owned by its head office; the other side is the served company.
      const kinds = await db.tenant.findMany({ where: { id: { in: [t.tenantId, t.counterpartyTenantId] } }, select: { id: true, kind: true } })
      const ho = kinds.find((k) => k.kind === 'head_office')?.id ?? null
      const other = ho ? (ho === t.tenantId ? t.counterpartyTenantId : t.tenantId) : null
      const pair = !!(ho && other && (await liveCompaniesOf([ho], db)).get(ho)?.has(other))
      return subject({
        companyIds: [t.tenantId, t.counterpartyTenantId], ownerTenantId: ho ?? t.tenantId, companyTenantId: other,
        submitterIds: [t.preparedById], viaHeadOfficeId: null, status: t.status, submittedAt: t.createdAt, kind: t.kind, headOfficePair: pair,
      })
    }
    case 'on_account_client': {
      const c = await db.customerAccount.findUnique({ where: { id }, select: { tenantId: true, createdById: true, limitRequestedById: true, status: true, createdAt: true } })
      return c && subject({ companyIds: [c.tenantId], ownerTenantId: c.tenantId, submitterIds: [c.createdById, c.limitRequestedById], viaHeadOfficeId: null, status: c.status, submittedAt: c.createdAt })
    }
    case 'bad_debt': {
      const w = await db.receivableWriteOff.findUnique({ where: { id }, select: { tenantId: true, requestedById: true, status: true, requestedAt: true } })
      return w && subject({ companyIds: [w.tenantId], ownerTenantId: w.tenantId, submitterIds: [w.requestedById], viaHeadOfficeId: null, status: w.status, submittedAt: w.requestedAt })
    }
    case 'raast_void': {
      const r = await db.raastReceipt.findUnique({ where: { id }, select: { tenantId: true, voidRequestedById: true, status: true, voidRequestedAt: true } })
      return r && subject({ companyIds: [r.tenantId], ownerTenantId: r.tenantId, submitterIds: [r.voidRequestedById], viaHeadOfficeId: null, status: r.status, submittedAt: r.voidRequestedAt })
    }
    case 'grni_writeoff': {
      const l = await db.goodsReceiptLine.findUnique({ where: { id }, select: { writeOffRequestedById: true, writeOffRequestedAt: true, writtenOffAt: true, receipt: { select: { tenantId: true } } } })
      return l && subject({
        companyIds: [l.receipt.tenantId], ownerTenantId: l.receipt.tenantId, submitterIds: [l.writeOffRequestedById], viaHeadOfficeId: null,
        status: l.writtenOffAt ? 'written_off' : l.writeOffRequestedAt ? 'requested' : 'open', submittedAt: l.writeOffRequestedAt,
      })
    }
    case 'stock_difference': {
      const l = await db.journalLine.findUnique({ where: { id }, select: { journalEntry: { select: { tenantId: true, postedBy: true, createdAt: true } } } })
      return l && subject({ companyIds: [l.journalEntry.tenantId], ownerTenantId: l.journalEntry.tenantId, submitterIds: [l.journalEntry.postedBy === 'system' ? null : l.journalEntry.postedBy], viaHeadOfficeId: null, status: 'pending', submittedAt: l.journalEntry.createdAt })
    }
    case 'journal_request': {
      const j = await db.journalRequest.findUnique({ where: { id }, select: { tenantId: true, kind: true, status: true, preparedById: true, preparedByIds: true, submittedById: true, submittedAt: true, viaHeadOfficeId: true } })
      return j && subject({ companyIds: [j.tenantId], ownerTenantId: j.tenantId, submitterIds: [j.preparedById, j.submittedById, ...j.preparedByIds], viaHeadOfficeId: j.viaHeadOfficeId, status: j.status, submittedAt: j.submittedAt, kind: j.kind })
    }
    case 'ho_recharge': {
      const r = await db.rechargeRun.findUnique({ where: { id }, select: { tenantId: true, status: true, kind: true, preparedById: true, preparedByIds: true, submittedById: true, submittedAt: true, lines: { select: { companyTenantId: true } } } })
      return r && subject({
        companyIds: [r.tenantId, ...r.lines.map((l) => l.companyTenantId)], ownerTenantId: r.tenantId,
        submitterIds: [r.preparedById, r.submittedById, ...r.preparedByIds], viaHeadOfficeId: null, status: r.status, submittedAt: r.submittedAt, kind: r.kind,
      })
    }
    case 'connector_change': {
      const c = await db.posConnectorChange.findUnique({ where: { id }, select: { tenantId: true, status: true, preparedById: true, preparedByIds: true, preparedAt: true, viaHeadOfficeId: true, kind: true } })
      return c && subject({ companyIds: [c.tenantId], ownerTenantId: c.tenantId, submitterIds: [c.preparedById, ...c.preparedByIds], viaHeadOfficeId: c.viaHeadOfficeId, status: c.status, submittedAt: c.preparedAt, kind: c.kind })
    }
  }
  return null
}

/**
 * The CanApproveInput of a resolved subject — the usual call is
 *   const s = await approvalSubject(type, id); if (!s) 404
 *   const grant = await assertCanApprove(req, approvalInputOf(type, id, s, { ceoOnly }))
 */
export function approvalInputOf(type: ApprovalType, id: string, s: ApprovalSubject, extra: Partial<CanApproveInput> = {}): CanApproveInput {
  const ceoOnlyByItem =
    (type === 'staff_login' && !usesOtpLogin(s.role ?? null))
    || (type === 'journal_request' && s.kind === 'reverse')
    || (type === 'intercompany_transfer' && !s.headOfficePair)
    || ((type === 'recipe' || type === 'storefront_publish') && s.companyIds.length === 0)
  return {
    type,
    tenantId: s.ownerTenantId,
    companyTenantId: s.companyTenantId ?? null,
    touchesTenantIds: s.companyIds,
    submittedByIds: s.submitterIds,
    viaHeadOfficeId: s.viaHeadOfficeId,
    submittedAt: s.submittedAt ?? null,
    role: s.role ?? null,
    kind: s.kind ?? null,
    entity: type,
    entityId: id,
    ...extra,
    ceoOnly: !!extra.ceoOnly || ceoOnlyByItem,
  }
}

// ─── A12: a link's end revokes its company-scoped hand-overs ────────────────

/**
 * Call inside the transaction that ends a head-office link (A12): revokes
 * every unrevoked delegation of that head office scoped to that company
 * (revokeReason 'company unlinked'). Returns the revoked ids; the caller
 * audits them (approval.delegation.revoke) with its own link audit.
 */
export async function revokeDelegationsForUnlinkTx(tx: Prisma.TransactionClient, hoId: string, companyId: string, actorId: string): Promise<string[]> {
  const rows = await tx.approvalDelegation.findMany({ where: { tenantId: hoId, companyTenantId: companyId, revokedAt: null }, select: { id: true } })
  if (rows.length === 0) return []
  await tx.approvalDelegation.updateMany({
    where: { id: { in: rows.map((r) => r.id) }, revokedAt: null },
    data: { revokedAt: new Date(), revokedById: actorId, revokeReason: 'company unlinked' },
  })
  return rows.map((r) => r.id)
}

/** A12: the head-office-wide hand-overs that would extend to a company linked now (the link dialog lists them). */
export async function hoWideDelegationsOf(hoId: string, db: Db = serviceClient): Promise<LiveDelegation[]> {
  const rows = await db.approvalDelegation.findMany({
    where: { tenantId: hoId, companyTenantId: null, ...liveDelegationWhere() },
    select: DELEGATION_SELECT,
    orderBy: { createdAt: 'asc' },
  })
  return rows.map((d) => ({ ...d, section: d.section as DelegableSection }))
}

// ─── The bell (owner, 2026-10-16): who is told an item is waiting ───────────
//
// "Whoever must act next" (owner decision): exactly the people the approve
// route would admit (decideApproval / hr decideRight) and whose inbox would
// list the item (they hold the type's queue module). The CEO is told only
// about items waiting at the CEO's end — a CEO-only type or item, an item that
// came through a head office (A3), an item handed over to a head-office
// delegate (owner: "Delegate and CEO"), or a type with no other active
// approver — never about every recipe or stock transfer a manager decides.
// Read on serviceClient, never cached. Runs inside queueStaffNotify's fresh
// RLS context (lib/staffNotify.ts); it also opens its own, so a synthetic
// request's widenRls can never touch a caller's context.

/** The statuses in which the module's queue lists an item of the type. */
const WAITING_STATUS: Partial<Record<ApprovalType, readonly string[]>> = {
  staff_login: ['pending'],
  storefront_publish: ['pending'],
  purchase_order: ['pending_approval'],
  recipe: ['pending_approval'],
  hr_request: ['submitted'],
  payroll_run: ['draft'],
  stock_transfer: ['requested'],
  cash_request_finance: ['submitted', 'draft'],
  cash_voucher: ['finance_approved', 'hod_signed'],
  fixed_asset_request: ['pending'],
  intercompany_transfer: ['submitted'],
  bad_debt: ['requested'],
  grni_writeoff: ['requested'],
  journal_request: ['submitted'],
  ho_recharge: ['submitted'],
  connector_change: ['submitted'],
}

/**
 * Is the item still in its queue now? A notice queued after a submit re-checks
 * this when it runs: an item decided (or rolled back) in the meantime is not
 * announced. Event-less types (tip_pool, stock_difference) answer true; the
 * retired cash_request_hod never waits.
 */
export async function approvalStillWaiting(type: ApprovalType, id: string, s: ApprovalSubject): Promise<boolean> {
  switch (type) {
    case 'cash_request_hod': return false
    case 'tip_pool':
    case 'stock_difference': return true
    case 'raast_void': return !!s.submittedAt && s.status === 'provisional'
    case 'on_account_client': {
      if (s.status === 'pending') return true
      const c = await serviceClient.customerAccount.findUnique({ where: { id }, select: { requestedCreditLimitCents: true, limitRequestedAt: true } })
      return !!c && c.requestedCreditLimitCents != null && c.limitRequestedAt != null
    }
    default: return (WAITING_STATUS[type] ?? []).includes(s.status)
  }
}

interface NotifyCandidate { id: string; role: string; email: string | null; memberTenantIds: string[]; reachTenantIds: string[] }

/** A stand-in request for a candidate: its REAL memberships and head-office reach (no lens, no view). */
function syntheticReq(c: NotifyCandidate): FastifyRequest {
  return {
    staffUser: { id: c.id, role: c.role, email: c.email, tenantId: c.memberTenantIds[0] ?? null, memberTenantIds: c.memberTenantIds, reachTenantIds: c.reachTenantIds, tenantIds: c.memberTenantIds },
    headers: {},
  } as unknown as FastifyRequest
}

/** Load active logins by id, with their member companies and head-office reach (as the auth middleware computes them). */
async function loadCandidates(ids: readonly string[]): Promise<NotifyCandidate[]> {
  const want = uniq(ids.filter(Boolean))
  if (want.length === 0) return []
  const users = await serviceClient.user.findMany({
    where: { id: { in: want }, isActive: true, accountStatus: 'active', deletedAt: null },
    select: { id: true, role: true, email: true, tenantId: true, tenantMemberships: { select: { tenantId: true } } },
    orderBy: { id: 'asc' },
  })
  const membersOf = new Map(users.map((u) => [u.id, clean([u.tenantId, ...u.tenantMemberships.map((m) => m.tenantId)])]))
  const reach = await headOfficeReach(uniq([...membersOf.values()].flat()))
  return users.map((u) => {
    const members = membersOf.get(u.id) ?? []
    const mine = new Set(members)
    const reached: string[] = []
    for (const [company, hos] of reach) if (!mine.has(company) && hos.some((h) => mine.has(h))) reached.push(company)
    return { id: u.id, role: u.role, email: u.email, memberTenantIds: members, reachTenantIds: reached }
  })
}

/** Active logins of these companies (primary or member), optionally only these roles. */
async function staffOfCompanies(companyIds: readonly string[], roles?: readonly string[]): Promise<string[]> {
  if (companyIds.length === 0) return []
  const rows = await serviceClient.user.findMany({
    where: {
      isActive: true, accountStatus: 'active', deletedAt: null,
      ...(roles ? { role: { in: [...roles] as never[] } } : {}),
      OR: [{ tenantId: { in: [...companyIds] } }, { tenantMemberships: { some: { tenantId: { in: [...companyIds] } } } }],
    },
    select: { id: true },
  })
  return rows.map((r) => r.id)
}

/** Active members of the head offices with a LIVE link to any of these companies. */
async function headOfficeStaffServing(companyIds: readonly string[], roles?: readonly string[]): Promise<string[]> {
  if (companyIds.length === 0) return []
  const links = await serviceClient.headOfficeLink.findMany({ where: { companyTenantId: { in: [...companyIds] }, endedAt: null }, select: { tenantId: true } })
  if (links.length === 0) return []
  const reach = await headOfficeReach(uniq(links.map((l) => l.tenantId)))
  const hos = uniq(companyIds.flatMap((c) => reach.get(c) ?? []))
  return staffOfCompanies(hos, roles)
}

/** Keep the ids whose effective modules include `module` (admin always). */
async function holdingModule(ids: readonly string[], module: string): Promise<Set<string>> {
  const out = new Set<string>()
  if (ids.length === 0) return out
  const users = await serviceClient.user.findMany({ where: { id: { in: uniq(ids) } }, select: { id: true, role: true, moduleAllow: true, moduleDeny: true } })
  for (const u of users) {
    if (u.role === 'admin') { out.add(u.id); continue }
    if ((await effectiveModulesForUser({ role: u.role, moduleAllow: u.moduleAllow, moduleDeny: u.moduleDeny })).has(module)) out.add(u.id)
  }
  return out
}

/** Live delegates whose hand-overs name this type (eligibility re-checked by decideApproval / decideRight). */
async function delegatesNaming(type: ApprovalType): Promise<string[]> {
  if (!delegationEnabled(type)) return []
  return uniq((await allLiveDelegations()).filter((d) => d.types.includes(type)).map((d) => d.delegateUserId))
}

/**
 * Every active login who may decide this item NOW and whose inbox would list
 * it — the bell's "approval.waiting" recipients. Null when the item is gone
 * or no longer waiting (nothing is sent). Never throws for a plain "nobody".
 */
export async function approverIdsFor(type: ApprovalType, id: string): Promise<{ subject: ApprovalSubject; userIds: string[] } | null> {
  return runWithRlsContext({ tenantIds: [], customerId: null, staffUserId: null }, async () => {
    if (!isApprovalType(type)) return null
    const s = await approvalSubject(type, id)
    if (!s || !(await approvalStillWaiting(type, id, s))) return null
    if (type === 'hr_request') return { subject: s, userIds: await hrStepApprovers(id) }
    const r = APPROVAL_RIGHTS[type]
    if (r.perItem) return { subject: s, userIds: [] }
    const input = approvalInputOf(type, id, s)
    const section = sectionOf(type, { role: input.role, tenantId: input.tenantId, kind: input.kind })
    const ids = uniq([
      ...(await staffOfCompanies(s.companyIds, uniq([...r.roles, 'admin']))),
      ...(s.companyIds.length === 0 ? (await serviceClient.user.findMany({ where: { role: 'admin', isActive: true, accountStatus: 'active', deletedAt: null }, select: { id: true } })).map((u) => u.id) : []),
      ...(await delegatesNaming(type)),
    ])
    const admins: string[] = []
    const byRole: string[] = []
    const byDelegation: string[] = []
    // Only people whose inbox would list the type (they hold its queue module) count —
    // also for the CEO rule below: an approver who cannot see the queue is no approver.
    const cands = await loadCandidates(ids)
    const listing = await holdingModule(cands.map((c) => c.id), r.queueModule)
    for (const c of cands) {
      if (!listing.has(c.id)) continue
      const d = await decideApproval(syntheticReq(c), input)
      if (!d.ok) continue
      if (c.role === 'admin') admins.push(c.id)
      else if (d.grant.via === 'delegation') byDelegation.push(c.id)
      else byRole.push(c.id)
    }
    const through = input.tenantId && !r.exemptThroughHeadOffice
      ? await throughHeadOfficeIds({ tenantId: input.tenantId, submittedByIds: input.submittedByIds, submittedAt: input.submittedAt, viaHeadOfficeId: input.viaHeadOfficeId })
      : []
    const ceoEnd = section === 'ceo' || !!input.ceoOnly || input.tenantId === null || through.length > 0
    const keepCeo = ceoEnd || byRole.length === 0 || byDelegation.length > 0
    return { subject: s, userIds: uniq([...(keepCeo ? admins : []), ...byRole, ...byDelegation]) }
  })
}

/**
 * hr_request: the people who may decide the CURRENT step without an override
 * (hr decideRight, the decide route's own check). The CEO's override on every
 * step is not counted (it would send the CEO every leave request at the HOD
 * step) — the CEO is told when the step is theirs without override and no one
 * else's, on the final step of a record that came through a head office (A3),
 * with a live HR hand-over (owner: "Delegate and CEO"), or when nobody else
 * can decide the step at all. HR's own work needs the staff_hr module, the
 * same rule /hr/approvals applies (PPL-R2-01).
 */
async function hrStepApprovers(id: string): Promise<string[]> {
  const rec = await serviceClient.hrRecord.findUnique({ where: { id } })
  if (!rec || rec.status !== 'submitted') return []
  // The record's company only: getFormat / the HR helpers read through it.
  return runWithRlsContext({ tenantIds: [rec.tenantId], customerId: null, staffUserId: null }, async () => {
    const { getFormat, managerUserIdOfEmployee } = await import('../modules/hr/service.js')
    const { decideRight } = await import('../modules/hr/logic.js')
    const fmt = await getFormat(rec.tenantId, rec.section, rec.formVersion).catch(() => getFormat(rec.tenantId, rec.section))
    const step = fmt.workflow[rec.currentStep]
    if (!step) return []
    const isLast = rec.currentStep >= fmt.workflow.length - 1
    const [emp, managerUserId] = rec.employeeId
      ? await Promise.all([
        serviceClient.hrEmployee.findFirst({ where: { id: rec.employeeId, tenantId: rec.tenantId }, select: { userId: true } }),
        managerUserIdOfEmployee(rec.tenantId, rec.employeeId, serviceClient),
      ])
      : [null, null]
    const prior = Array.isArray(rec.approvals) ? (rec.approvals as Array<{ byUserId?: string }>).map((a) => a?.byUserId).filter((x): x is string => typeof x === 'string') : []
    const subject = { employeeUserId: emp?.userId ?? null, managerUserId: managerUserId ?? null, createdById: rec.createdById, priorApproverIds: prior }
    const ids = uniq([
      ...(await staffOfCompanies([rec.tenantId], HR_STEP_ROLES)),
      ...(managerUserId ? [managerUserId] : []),
      ...(await headOfficeStaffServing([rec.tenantId], HR_STEP_ROLES)),
      ...(await delegatesNaming('hr_request')),
    ])
    const through = await throughHeadOfficeIds({ tenantId: rec.tenantId, submittedByIds: [rec.createdById], submittedAt: rec.createdAt, viaHeadOfficeId: rec.viaHeadOfficeId })
    const cands = await loadCandidates(ids)
    const staffHr = await holdingModule(cands.map((c) => c.id), 'staff_hr')
    const admins: string[] = []
    const overrideAdmins: string[] = []
    const others: string[] = []
    const delegates: string[] = []
    for (const c of cands) {
      const right = await decideRight(syntheticReq(c), rec, step, isLast, { subject, decision: null, through })
      if (!right.ok) continue
      // HR back-office work (an 'hr' step, or HR standing in for a missing HOD) needs staff_hr.
      const hrWork = c.role !== 'admin' && (step.role === 'hr' || (step.role === 'hod' && !(managerUserId && managerUserId === c.id)))
      if (hrWork && !staffHr.has(c.id)) continue
      if (c.role === 'admin') (right.override ? overrideAdmins : admins).push(c.id)
      else if (right.via === 'delegation') delegates.push(c.id)
      else if (!right.override) others.push(c.id)
    }
    // The CEO: the step's own approver when nobody else is; every CEO on a
    // handed-over item or the final step of one that came through a head office.
    const ceoEnd = isLast && through.length > 0
    const ceo = others.length === 0 && delegates.length === 0
      ? (admins.length > 0 ? admins : overrideAdmins)
      : (ceoEnd || delegates.length > 0 ? [...admins, ...overrideAdmins] : [])
    return uniq([...ceo, ...others, ...delegates])
  })
}
