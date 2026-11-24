// ── Merge two ledger accounts (owner, 2026-11-24) in the approvals inbox ─────
// GET /accounting/account-merges?status=pending lists what finance asked to merge. Approve / Reject call the module's
// own routes, whose guard decides. ADMIN_ONLY, never handed over (APPROVAL_RIGHTS.account_merge).

import type { UserRole } from '@prisma/client'
import { APPROVAL_RIGHTS } from '../../lib/approvalRights.js'
import { fmtPkrCents } from '../../lib/money.js'
import type { ApprovalItem, ApprovalProvider } from '../approvals/types.js'

const RIGHTS = APPROVAL_RIGHTS.account_merge
const LINK = '/configuration/chart-of-accounts'

interface Row {
  id: string; tenantId: string; reason: string; requestedById: string; createdAt: string
  fromCode: string; fromName: string; intoCode: string; intoName: string; lineCount: number; debitCents: number; creditCents: number
  companyName: string | null; requestedByName: string | null; blockedBy: string | null
}

export const accountMerges: ApprovalProvider = {
  type: 'account_merge',
  label: RIGHTS.label,
  module: RIGHTS.queueModule,
  link: LINK,
  approverRoles: RIGHTS.roles as readonly UserRole[],
  delegable: RIGHTS.delegable,
  async load(ctx) {
    const res = await ctx.read<{ items: Row[] }>('/accounting/account-merges?status=pending')
    if (res === null) return null
    return (res.items ?? []).map((r): ApprovalItem => ({
      type: 'account_merge',
      id: r.id,
      tenantId: r.tenantId,
      section: RIGHTS.section,
      submittedByIds: [r.requestedById],
      title: `Merge ${r.fromCode} ${r.fromName} into ${r.intoCode} ${r.intoName}`,
      subtitle: r.reason,
      facts: [
        { label: 'Company', value: r.companyName ?? '—' },
        { label: 'Entries to move', value: `${r.lineCount} line${r.lineCount === 1 ? '' : 's'} — debits ${fmtPkrCents(r.debitCents)}, credits ${fmtPkrCents(r.creditCents)}` },
        { label: 'What happens', value: `Every entry of ${r.fromCode} moves to ${r.intoCode} as posted (same date, narration and voucher number). ${r.fromCode} ends empty and is switched off. Nothing is posted.` },
        { label: 'Asked by', value: r.requestedByName ?? '—' },
        ...(r.blockedBy ? [{ label: 'Blocked by', value: r.blockedBy }] : []),
      ],
      waitingSince: r.createdAt,
      link: LINK,
      actions: [
        { kind: 'approve', label: 'Merge the accounts', method: 'POST', path: `/accounting/account-merges/${r.id}/approve`, body: {},
          confirm: `Move every entry of ${r.fromCode} ${r.fromName} to ${r.intoCode} ${r.intoName} and switch ${r.fromCode} off?`,
          ...(r.blockedBy ? { disabledReason: `Cannot be merged now: ${r.blockedBy}` } : {}) },
        { kind: 'reject', label: 'Reject', method: 'POST', path: `/accounting/account-merges/${r.id}/reject`, body: {},
          input: { field: 'note', label: 'Reason (at least 10 characters)', required: true } },
      ],
    }))
  },
}
