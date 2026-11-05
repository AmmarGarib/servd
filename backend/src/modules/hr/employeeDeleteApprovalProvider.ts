// ── HR's employee deletes (owner, 2026-11-05) in the approvals inbox ─────────
// GET /hr/employee-delete-requests?status=pending lists the deletes HR asked
// for, with what (if anything) blocks each one now. Approve / Reject call the
// module's own routes (POST /hr/employee-delete-requests/:id/approve | reject),
// whose guard decides (and re-checks the history). ADMIN_ONLY, never handed
// over (APPROVAL_RIGHTS.employee_delete, section 'ceo').

import type { UserRole } from '@prisma/client'
import { APPROVAL_RIGHTS } from '../../lib/approvalRights.js'
import type { ApprovalItem, ApprovalProvider } from '../approvals/types.js'

const RIGHTS = APPROVAL_RIGHTS.employee_delete
const LINK = '/hr/employees'

interface Row {
  id: string
  tenantId: string
  employeeId: string
  employeeCode: string
  fullName: string
  reason: string
  requestedById: string
  createdAt: string
  department: string | null
  designation: string | null
  companyName: string | null
  requestedByName: string | null
  blockedBy: string[]
}

export const employeeDeletes: ApprovalProvider = {
  type: 'employee_delete',
  label: RIGHTS.label,
  module: RIGHTS.queueModule,
  link: LINK,
  approverRoles: RIGHTS.roles as readonly UserRole[],
  delegable: RIGHTS.delegable,
  async load(ctx) {
    const res = await ctx.read<{ items: Row[] }>('/hr/employee-delete-requests?status=pending')
    if (res === null) return null
    return (res.items ?? []).map((r): ApprovalItem => ({
      type: 'employee_delete',
      id: r.id,
      tenantId: r.tenantId,
      section: RIGHTS.section,
      submittedByIds: [r.requestedById],
      title: `Delete employee — ${r.fullName} (${r.employeeCode})`,
      subtitle: r.designation ?? undefined,
      facts: [
        { label: 'Person', value: r.fullName },
        { label: 'Code', value: r.employeeCode },
        { label: 'Department', value: r.department ?? '—' },
        { label: 'Company', value: r.companyName ?? '—' },
        { label: 'Reason', value: r.reason },
        { label: 'Asked by', value: r.requestedByName ?? '—' },
        ...(r.blockedBy?.length ? [{ label: 'Blocked by', value: r.blockedBy.join('; ') }] : []),
      ],
      amountCents: null,
      waitingSince: r.createdAt,
      link: `${LINK}/${r.employeeId}`,
      actions: [
        { kind: 'approve', label: 'Approve', method: 'POST', path: `/hr/employee-delete-requests/${r.id}/approve`, body: {},
          confirm: 'Delete this employee now? They go to the Trash, where you can restore them.',
          ...(r.blockedBy?.length ? { disabledReason: `Cannot be deleted: ${r.blockedBy.join('; ')}. Reject it instead.` } : {}) },
        { kind: 'reject', label: 'Reject', method: 'POST', path: `/hr/employee-delete-requests/${r.id}/reject`, body: {},
          input: { field: 'note', label: 'Reason (at least 10 characters)', required: true } },
      ],
    }))
  },
}
