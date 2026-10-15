// The approvals inbox — shared types (owner decision D3, 2026-10-11).
//
// The inbox is a READ-ONLY aggregator. Every item stays in its own module and
// that module's status column is the only record of its state; approving or
// rejecting calls the module's EXISTING route, whose own guard decides. See
// README.md.

import type { UserRole } from '@prisma/client'

// The one list lives in lib/approvalRights.ts with the rights registry
// (APPROVAL_RIGHTS: section, role path, hand-over rules per type).
export { APPROVAL_TYPES, APPROVAL_SECTIONS, type ApprovalType, type ApprovalSection } from '../../lib/approvalRights.js'
import type { ApprovalType, ApprovalSection } from '../../lib/approvalRights.js'

export interface ApprovalFact { label: string; value: string }

/** One button on an item: a call to the module's own route. */
export interface ApprovalAction {
  kind: 'approve' | 'reject'
  label: string
  method: 'POST' | 'PATCH'
  /** The module's existing route, relative to /api/v1. */
  path: string
  /** Sent as-is (plus `input.field` when the user fills it in). */
  body: Record<string, unknown>
  /** A free-text field the route takes (reject reason, note). */
  input?: { field: string; label: string; required: boolean }
  /** Ask before sending. */
  confirm?: string
  /** Shown instead of the button when the route would refuse it now. */
  disabledReason?: string
  /** Tick-boxes sent as `field: true` in the body when ticked (a recharge run's
   *  "post in the open month", "I have read the warnings"). */
  options?: Array<{ field: string; label: string; kind: 'checkbox' }>
}

export interface ApprovalItem {
  type: ApprovalType
  /** The module's own id for the row. */
  id: string
  /** The row's company (null only for the module's own legacy company-less rows). */
  tenantId: string | null
  companyName?: string | null
  title: string
  subtitle?: string | null
  facts: ApprovalFact[]
  amountCents?: number | null
  /** When it started waiting (submitted / requested / raised). */
  waitingSince: string | null
  /** The module's own screen for this item, when it has one. */
  link: string | null
  actions: ApprovalAction[]
  /** The module's own row, when its screen component renders it in place
   *  (HR requests open in the HR record view). */
  record?: unknown
  /** The approval section it is decided in (lib/approvalRights.ts sectionOf). */
  section?: ApprovalSection
  /** Creator / submitter / preparers — never its approver (the CEO excepted). */
  submittedByIds?: string[]
  /** The head office it came through (A3), when known. */
  viaHeadOfficeId?: string | null
  /** Every company it touches, when more than `tenantId` (a transfer's two sides, a run's companies). */
  touchesTenantIds?: string[]
  /** A head-office-owned item's owner (a recharge run's or a head-office pair's head office). */
  ownerTenantId?: string | null
  /** CEO view: a live hand-over covers it — the delegate decides it unless the CEO does first. */
  handedOverTo?: { userId: string; name: string | null; endsAt: string | null; delegationId: string }
}

export interface ApprovalTypeSummary {
  type: ApprovalType
  label: string
  /** The module id whose screen holds the queue. */
  module: string
  /** The module's own queue screen. */
  link: string
  count: number
  /** Items of this type waiting in the user's OTHER companies (outside the
   *  view) — not listed, only counted, so the page can say "switch to All
   *  companies". Absent when there are none. */
  elsewhere?: number
  /** The module's queue could not be read just now (5xx) — the count is unknown. */
  error?: true
  /** The approval section of the type (lib/approvalRights.ts). */
  section?: ApprovalSection
  /** CEO view: items of the type handed over to a delegate (not in `count`). */
  handedOver?: number
}

/** One approval section of the inbox (spec §7.6). */
export interface ApprovalSectionSummary {
  id: ApprovalSection
  title: string
  count: number
  /** CEO view: items covered by a live hand-over (collapsed; not in `count`). */
  handedOver: number
  /** CEO view: who holds the section now. */
  delegates: Array<{ userId: string; name: string | null; endsAt: string | null; headOfficeId: string; companyTenantId: string | null }>
}

export interface ApprovalInbox {
  /** Waiting on this person — handed-over items are never in it. */
  total: number
  /** Sum of `elsewhere` over the types. */
  elsewhere: number
  types: ApprovalTypeSummary[]
  items: ApprovalItem[]
  /** Per section (only sections with a listed type or a hand-over). */
  sections?: ApprovalSectionSummary[]
  /** CEO view: items a live hand-over covers (counted here, not in total). */
  handedOver?: number
  /** CEO default view: the handed-over items, collapsed per section (`?view=all` lists them in `items`). */
  handedOverItems?: ApprovalItem[]
}

/** What a provider gets to read its module's queue as the signed-in user. */
export interface ProviderContext {
  user: { id: string; role: UserRole }
  /** The companies in view (resolveTenantScope: the active company, or every
   *  company the user belongs to in "All companies" view). */
  tenantIds: string[]
  /** Every company the user belongs to (req.staffUser.memberTenantIds) — the
   *  outer bound for a type that spans companies (spansMemberCompanies). */
  memberTenantIds: string[]
  /** Companies the user reaches through a head office (lib/headOffice.ts). Default none. */
  reachTenantIds?: string[]
  /** Per type, the companies a live hand-over covers for this user — kept whatever the view. Default none. */
  delegated?: ReadonlyMap<ApprovalType, ReadonlySet<string>>
  /**
   * GET one of the module's OWN routes as this user (same session, same
   * company headers). Null when that route refuses the user (401/403/404) —
   * so whatever the module would not show, the inbox does not either.
   * Throws on any other failure.
   */
  read<T>(path: string): Promise<T | null>
}

export interface ApprovalProvider {
  type: ApprovalType
  label: string
  module: string
  link: string
  /**
   * Who the module's approve route admits today (its requireAuth role list),
   * or null when the module decides per item (HR request steps: the reporting
   * manager, HR or management). Read from APPROVAL_RIGHTS (the one copy). A
   * live delegation is consulted alongside it — see delegations.ts.
   */
  approverRoles: readonly UserRole[] | null
  /** For per-item types: the roles that see the type even when it is empty. */
  alwaysListFor?: readonly UserRole[]
  /**
   * Keep this type's items from every company the user belongs to, whatever
   * the view — for a module whose own queue deliberately spans them (HR
   * requests: /hr/approvals and /hr/team's "waiting on you" count cover every
   * member company, so a head-office HOD sees each company's step). Items are
   * still bounded by memberTenantIds and labelled by company.
   */
  spansMemberCompanies?: boolean
  /** May the CEO hand this type to a head-office person (D3)? From APPROVAL_RIGHTS. */
  delegable: boolean
  /** The waiting items, or null when the module's queue route refuses this
   *  user (role, module access) — then the type is not theirs at all. */
  load(ctx: ProviderContext): Promise<ApprovalItem[] | null>
}
