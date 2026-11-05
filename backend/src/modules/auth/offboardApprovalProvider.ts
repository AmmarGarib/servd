// ── HR's login offboards (owner, 2026-11-05) in the approvals inbox ──
// GET /auth/staff/offboard-requests?status=pending lists the offboards HR asked
// for. Approve / Reject call the module's own routes
// (POST /auth/staff/offboard-requests/:id/approve | reject), whose guard
// decides. ADMIN_ONLY, never handed over (APPROVAL_RIGHTS.staff_offboard,
// section 'ceo').

import type { UserRole } from '@prisma/client'
import { APPROVAL_RIGHTS } from '../../lib/approvalRights.js'
import type { ApprovalItem, ApprovalProvider } from '../approvals/types.js'

const RIGHTS = APPROVAL_RIGHTS.staff_offboard
const LINK = '/workforce'

interface Row {
  id: string
  tenantId: string
  userId: string
  reason: string
  requestedById: string
  createdAt: string
  login: { id: string; name: string | null; email: string | null; role: string } | null
  companyName: string | null
  requestedByName: string | null
}

const human = (s: string | null | undefined) => (s ?? '').replace(/_/g, ' ').trim()

export const staffOffboards: ApprovalProvider = {
  type: 'staff_offboard',
  label: RIGHTS.label,
  module: RIGHTS.queueModule,
  link: LINK,
  approverRoles: RIGHTS.roles as readonly UserRole[],
  delegable: RIGHTS.delegable,
  async load(ctx) {
    const res = await ctx.read<{ items: Row[] }>('/auth/staff/offboard-requests?status=pending')
    if (res === null) return null
    return (res.items ?? []).map((r): ApprovalItem => ({
      type: 'staff_offboard',
      id: r.id,
      tenantId: r.tenantId,
      section: RIGHTS.section,
      submittedByIds: [r.requestedById],
      title: `Offboard login — ${r.login?.name ?? 'a login'}`,
      subtitle: r.login?.role ? human(r.login.role) : undefined,
      facts: [
        { label: 'Person', value: r.login?.name ?? '—' },
        { label: 'Role', value: human(r.login?.role) || '—' },
        { label: 'Email', value: r.login?.email ?? '—' },
        { label: 'Company', value: r.companyName ?? '—' },
        { label: 'Reason', value: r.reason },
        { label: 'Asked by', value: r.requestedByName ?? '—' },
      ],
      amountCents: null,
      waitingSince: r.createdAt,
      link: LINK,
      actions: [
        { kind: 'approve', label: 'Approve', method: 'POST', path: `/auth/staff/offboard-requests/${r.id}/approve`, body: {},
          confirm: 'Switch this login off now? They are signed out everywhere at once.' },
        { kind: 'reject', label: 'Reject', method: 'POST', path: `/auth/staff/offboard-requests/${r.id}/reject`, body: {},
          input: { field: 'note', label: 'Reason (at least 10 characters)', required: true } },
      ],
    }))
  },
}
