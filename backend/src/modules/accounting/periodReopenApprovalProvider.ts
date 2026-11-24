// ── Reopen a closed period (owner, 2026-11-24) in the approvals inbox ────────
// GET /accounting/period-close/reopen-requests?status=pending lists what finance asked to reopen. Approve / Reject
// call the module's own routes, whose guard decides. ADMIN_ONLY, never handed over (APPROVAL_RIGHTS.period_reopen).

import type { UserRole } from '@prisma/client'
import { APPROVAL_RIGHTS } from '../../lib/approvalRights.js'
import type { ApprovalItem, ApprovalProvider } from '../approvals/types.js'

const RIGHTS = APPROVAL_RIGHTS.period_reopen
const LINK = '/accounting/period-close'

interface Row {
  id: string; tenantId: string; reason: string; requestedById: string; createdAt: string
  lockedThroughLabel: string; reopenFromLabel: string | null; companyName: string | null; requestedByName: string | null; blockedBy: string | null
}

export const periodReopens: ApprovalProvider = {
  type: 'period_reopen',
  label: RIGHTS.label,
  module: RIGHTS.queueModule,
  link: LINK,
  approverRoles: RIGHTS.roles as readonly UserRole[],
  delegable: RIGHTS.delegable,
  async load(ctx) {
    const res = await ctx.read<{ items: Row[] }>('/accounting/period-close/reopen-requests?status=pending')
    if (res === null) return null
    return (res.items ?? []).map((r): ApprovalItem => ({
      type: 'period_reopen',
      id: r.id,
      tenantId: r.tenantId,
      section: RIGHTS.section,
      submittedByIds: [r.requestedById],
      title: r.reopenFromLabel ? `Reopen the books from ${r.reopenFromLabel} to ${r.lockedThroughLabel}` : `Reopen the books closed through ${r.lockedThroughLabel}`,
      subtitle: r.reason,
      facts: [
        { label: 'Company', value: r.companyName ?? '—' },
        { label: 'Period to open', value: r.reopenFromLabel ? `${r.reopenFromLabel} to ${r.lockedThroughLabel} — earlier days stay closed` : `The latest close only (through ${r.lockedThroughLabel})` },
        { label: 'What happens', value: 'You and finance may post, edit and cancel entries dated in that period until the books are closed again.' },
        { label: 'Asked by', value: r.requestedByName ?? '—' },
        ...(r.blockedBy ? [{ label: 'Blocked by', value: r.blockedBy }] : []),
      ],
      waitingSince: r.createdAt,
      link: LINK,
      actions: [
        { kind: 'approve', label: 'Reopen the period', method: 'POST', path: `/accounting/period-close/reopen-requests/${r.id}/approve`, body: {},
          confirm: `Reopen the books ${r.reopenFromLabel ? `from ${r.reopenFromLabel} to ${r.lockedThroughLabel}` : `closed through ${r.lockedThroughLabel}`}? Finance will be able to post into that period until it is closed again.`,
          ...(r.blockedBy ? { disabledReason: `Cannot be reopened as asked: ${r.blockedBy}. Reject it instead.` } : {}) },
        { kind: 'reject', label: 'Reject', method: 'POST', path: `/accounting/period-close/reopen-requests/${r.id}/reject`, body: {},
          input: { field: 'note', label: 'Reason (at least 10 characters)', required: true } },
      ],
    }))
  },
}
