'use client'
// Shared by the Approvals inbox (/ceo/approvals), the CEO home (/ceo) and the
// sidebar badge. The API (backend modules/approvals) is the only source.

import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/api'

/** `elsewhere`: waiting in the login's OTHER companies — counted, not listed. */
export interface ApprovalTypeSummary { type: string; label: string; module: string; link: string; count: number; elsewhere?: number; error?: true }
export interface ApprovalCounts { total: number; elsewhere?: number; types: ApprovalTypeSummary[] }

/** Every approvals query starts with this, so one invalidation refreshes all. */
export const APPROVALS_ROOT = 'approvals'
export const APPROVALS_INBOX_KEY = [APPROVALS_ROOT, 'inbox'] as const
export const APPROVALS_COUNTS_KEY = [APPROVALS_ROOT, 'counts'] as const

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
