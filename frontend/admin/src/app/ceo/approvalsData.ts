'use client'
// Shared by the Approvals inbox (/ceo/approvals), the hand-over page, the CEO
// home (/ceo) and the sidebar badge. The API (backend modules/approvals) is
// the only source.

import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'

/** The approval sections (backend lib/approvalRights.ts APPROVAL_SECTIONS). */
export type ApprovalSectionId = 'ceo' | 'operations' | 'procurement' | 'finance' | 'marketing' | 'hr' | 'dev'

/** `elsewhere`: waiting in the login's OTHER companies — counted, not listed. */
export interface ApprovalTypeSummary {
  type: string; label: string; module: string; link: string; count: number
  elsewhere?: number; error?: true
  section?: ApprovalSectionId
  /** CEO view: items of the type handed over (not in `count`). */
  handedOver?: number
}
export interface ApprovalSectionSummary {
  id: ApprovalSectionId
  title: string
  count: number
  handedOver: number
  delegates: Array<{ userId: string; name: string | null; endsAt: string | null; headOfficeId: string; companyTenantId: string | null }>
}

export interface ApprovalOption { field: string; label: string; kind: 'checkbox' }
export interface ApprovalAction {
  kind: 'approve' | 'reject' | 'return'
  label: string
  method: 'POST' | 'PATCH'
  path: string
  body: Record<string, unknown>
  input?: { field: string; label: string; required: boolean }
  confirm?: string
  disabledReason?: string
  /** Tick-boxes sent as `field: true` when ticked. */
  options?: ApprovalOption[]
  /** The button pays money out: the dialog asks Official / Unofficial / Unclassified. */
  classification?: boolean
}
export interface ApprovalHandedOverTo { userId: string; name: string | null; endsAt: string | null; delegationId: string }

export interface ApprovalCounts {
  total: number
  elsewhere?: number
  types: ApprovalTypeSummary[]
  sections?: ApprovalSectionSummary[]
  handedOver?: number
}

/** Every approvals query starts with this, so one invalidation refreshes all. */
export const APPROVALS_ROOT = 'approvals'
export const APPROVALS_INBOX_KEY = [APPROVALS_ROOT, 'inbox'] as const
export const APPROVALS_COUNTS_KEY = [APPROVALS_ROOT, 'counts'] as const
export const APPROVALS_DELEGATIONS_KEY = [APPROVALS_ROOT, 'delegations'] as const
export const APPROVALS_CATALOG_KEY = [APPROVALS_ROOT, 'catalog'] as const

/** GET /approvals/counts — what is waiting on the signed-in login, per type. */
export function useApprovalCounts(enabled = true) {
  return useQuery({
    queryKey: APPROVALS_COUNTS_KEY,
    queryFn: () => api.get<ApprovalCounts>('/approvals/counts'),
    enabled,
    refetchInterval: 60_000,
    staleTime: 30_000,
  })
}

// ── Hand-over (delegations) ──────────────────────────────────────────────────

export interface CatalogType { type: string; label: string; enabled: boolean; mustHoldModule: string | null; hoWideOnly: boolean; note: string | null }
export interface CatalogSection { id: ApprovalSectionId; title: string; delegable: boolean; notYet: boolean; types: CatalogType[] }

export type DelegationState = 'live' | 'not_started' | 'expired' | 'revoked'
export interface Delegation {
  id: string
  tenantId: string
  companyTenantId: string | null
  section: string
  approvalTypes: string[]
  delegateUserId: string
  startsAt: string
  endsAt: string | null
  note: string | null
  revokedAt: string | null
  revokeReason: string | null
  createdAt: string
  headOfficeName: string | null
  companyName: string | null
  scopeName: string
  sectionTitle: string
  delegateName: string | null
  grantedByName: string | null
  revokedByName: string | null
  state: DelegationState
}
export interface EligibleDelegate { id: string; name: string | null; role: string; types: string[]; lacks: string[] }
export interface HeadOfficeOption { id: string; name: string; companies: Array<{ id: string; name: string }> }

/** The CEO's head offices (GET /head-offices). */
export function useHeadOffices(enabled = true) {
  return useQuery({
    queryKey: [APPROVALS_ROOT, 'head-offices'],
    queryFn: async () => (await api.get<{ headOffices: HeadOfficeOption[] }>('/head-offices')).headOffices,
    enabled,
  })
}
