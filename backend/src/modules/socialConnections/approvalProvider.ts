// ── Social pages per brand (owner C18, 2026-10-26) in the approvals inbox ─────
// GET /social-connections/requests?status=pending lists the brands' page
// connections Marketing made. Approve / Reject call the module's own routes
// (POST /social-connections/requests/:id/approve | reject) with the page shown,
// so a brand reconnected in the meantime is refused (CONNECTION_CHANGED).
// ADMIN_ONLY, never handed over (APPROVAL_RIGHTS.social_connection, section 'ceo').

import type { UserRole } from '@prisma/client'
import { APPROVAL_RIGHTS } from '../../lib/approvalRights.js'
import type { ApprovalItem, ApprovalProvider } from '../approvals/types.js'

const RIGHTS = APPROVAL_RIGHTS.social_connection
const LINK = '/calendar/social'

interface Row {
  id: string
  tenantId: string
  conceptId: string
  pageId: string
  pageName: string | null
  igUserId: string | null
  tokenHint: string | null
  requestedById: string | null
  requestedAt: string
  brandName: string | null
  requestedByName: string | null
  currentApproved: { pageId: string; pageName: string | null } | null
}

export const socialConnections: ApprovalProvider = {
  type: 'social_connection',
  label: RIGHTS.label,
  module: RIGHTS.queueModule,
  link: LINK,
  approverRoles: RIGHTS.roles as readonly UserRole[],
  delegable: RIGHTS.delegable,
  async load(ctx) {
    const res = await ctx.read<{ items: Row[] }>('/social-connections/requests?status=pending')
    if (res === null) return null
    return (res.items ?? []).map((r): ApprovalItem => ({
      type: 'social_connection',
      id: r.id,
      tenantId: r.tenantId,
      section: RIGHTS.section,
      submittedByIds: r.requestedById ? [r.requestedById] : [],
      title: `Facebook / Instagram page — ${r.brandName ?? 'brand'}`,
      subtitle: r.currentApproved ? 'Replaces the page connected now' : 'First page for this brand',
      facts: [
        { label: 'Facebook page', value: `${r.pageName ?? 'Page'} (ID ${r.pageId})` },
        { label: 'Instagram', value: r.igUserId ? `Business account ${r.igUserId}` : 'No Instagram business account on this page' },
        { label: 'Connected now', value: r.currentApproved ? `${r.currentApproved.pageName ?? 'Page'} (ID ${r.currentApproved.pageId})` : 'None — nothing posts for this brand until you approve' },
        { label: 'Asked by', value: r.requestedByName ?? 'servd (moved from the old connection)' },
      ],
      amountCents: null,
      waitingSince: r.requestedAt,
      link: LINK,
      actions: [
        { kind: 'approve', label: 'Approve page', method: 'POST', path: `/social-connections/requests/${r.id}/approve`, body: { pageId: r.pageId },
          confirm: `Approve this page for ${r.brandName ?? 'the brand'}? Its scheduled posts publish to it from now on.` },
        { kind: 'reject', label: 'Reject', method: 'POST', path: `/social-connections/requests/${r.id}/reject`, body: { pageId: r.pageId },
          input: { field: 'note', label: 'Reason', required: true } },
      ],
    }))
  },
}
