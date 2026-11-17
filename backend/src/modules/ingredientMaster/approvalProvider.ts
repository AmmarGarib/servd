// ── Ingredients sheet changes (owner, 2026-11-17) in the approvals inbox ──
// GET /ingredient-master/requests?status=pending lists the changes people asked for on servd's Ingredients sheet.
// Approve / Reject call the module's own routes (POST /ingredient-master/requests/:id/approve | reject), whose guard
// decides. ADMIN_ONLY, never handed over, no company (APPROVAL_RIGHTS.ingredient_change, section 'ceo').

import type { UserRole } from '@prisma/client'
import { APPROVAL_RIGHTS } from '../../lib/approvalRights.js'
import type { ApprovalItem, ApprovalProvider } from '../approvals/types.js'

const RIGHTS = APPROVAL_RIGHTS.ingredient_change
const LINK = '/kitchen/ingredients'

interface Row {
  id: string
  ingredient: string | null
  requestedById: string
  requestedByName: string | null
  requestedAt: string
  changes: Array<{ label: string; from: string; to: string }>
}

export const ingredientChanges: ApprovalProvider = {
  type: 'ingredient_change',
  label: RIGHTS.label,
  module: RIGHTS.queueModule,
  link: LINK,
  approverRoles: RIGHTS.roles as readonly UserRole[],
  delegable: RIGHTS.delegable,
  async load(ctx) {
    const res = await ctx.read<{ items: Row[] }>('/ingredient-master/requests?status=pending')
    if (res === null) return null
    return (res.items ?? []).map((r): ApprovalItem => ({
      type: 'ingredient_change',
      id: r.id,
      tenantId: null,
      section: RIGHTS.section,
      submittedByIds: [r.requestedById],
      title: `Ingredients sheet — ${r.ingredient ?? 'an ingredient'}`,
      subtitle: 'servd-wide',
      facts: [
        ...r.changes.map((c) => ({ label: c.label, value: `${c.from} → ${c.to}` })),
        { label: 'Asked by', value: r.requestedByName ?? '—' },
      ],
      amountCents: null,
      waitingSince: r.requestedAt,
      link: LINK,
      actions: [
        { kind: 'approve', label: 'Approve', method: 'POST', path: `/ingredient-master/requests/${r.id}/approve`, body: {},
          confirm: 'Apply this change to servd\'s Ingredients sheet now?' },
        { kind: 'reject', label: 'Reject', method: 'POST', path: `/ingredient-master/requests/${r.id}/reject`, body: {},
          input: { field: 'note', label: 'Reason (at least 10 characters)', required: true } },
      ],
    }))
  },
}
