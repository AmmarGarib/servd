// ── Void a paid cash voucher (owner, 2026-11-18) in the approvals inbox ──────
// GET /trustops/cash-vouchers/void-requests?status=pending lists what finance asked to void, with what (if anything)
// blocks it now. Approve / Reject call the module's own routes (POST /trustops/cash-vouchers/void-requests/:id/
// approve | reject), whose guard decides. ADMIN_ONLY, never handed over (APPROVAL_RIGHTS.cash_voucher_void).

import type { UserRole } from '@prisma/client'
import { APPROVAL_RIGHTS } from '../../lib/approvalRights.js'
import type { ApprovalItem, ApprovalProvider } from '../approvals/types.js'

const RIGHTS = APPROVAL_RIGHTS.cash_voucher_void
const LINK = '/finance/cash-vouchers'

interface Row {
  id: string
  tenantId: string
  voucherId: string
  reason: string
  correctTaxCents?: number | null
  requestedById: string
  createdAt: string
  voucherNumber: string | null
  payeeName: string | null
  purpose: string | null
  amountCents: number | null
  paySource: string | null
  boxName: string | null
  paidAccountCode: string | null
  companyName: string | null
  requestedByName: string | null
  blockedBy: string | null
}

const fromLabel = (r: Row) =>
  r.paySource === 'box' ? `Petty cash${r.boxName ? ` — ${r.boxName}` : ''}` : r.paySource === 'cash_on_hand' ? 'Cash on hand' : r.paySource === 'bank' ? 'Bank' : '—'
const undoLabel = (r: Row) =>
  r.paySource === 'box' ? `The cash goes back into ${r.boxName ?? 'the box'}; the expense${r.paidAccountCode ? ` (${r.paidAccountCode})` : ''} is undone`
    : 'The payment entry is reversed; the expense is undone'

export const cashVoucherVoids: ApprovalProvider = {
  type: 'cash_voucher_void',
  label: RIGHTS.label,
  module: RIGHTS.queueModule,
  link: LINK,
  approverRoles: RIGHTS.roles as readonly UserRole[],
  delegable: RIGHTS.delegable,
  async load(ctx) {
    const res = await ctx.read<{ items: Row[] }>('/trustops/cash-vouchers/void-requests?status=pending')
    if (res === null) return null
    return (res.items ?? []).map((r): ApprovalItem => ({
      type: 'cash_voucher_void',
      id: r.id,
      tenantId: r.tenantId,
      section: RIGHTS.section,
      submittedByIds: [r.requestedById],
      title: `Void cash voucher ${r.voucherNumber ?? ''} — ${r.payeeName ?? ''}`.trim(),
      subtitle: r.purpose ?? undefined,
      facts: [
        { label: 'Paid from', value: fromLabel(r) },
        { label: 'What happens', value: undoLabel(r) },
        ...(r.correctTaxCents != null ? [{ label: 'Sales tax corrected to', value: `PKR ${(r.correctTaxCents / 100).toLocaleString('en-PK')} — the extra is credited on the bill and a new pay-back voucher is raised for the right amount` }] : []),
        { label: 'Company', value: r.companyName ?? '—' },
        { label: 'Reason', value: r.reason },
        { label: 'Asked by', value: r.requestedByName ?? '—' },
        ...(r.blockedBy ? [{ label: 'Blocked by', value: r.blockedBy }] : []),
      ],
      amountCents: r.amountCents,
      waitingSince: r.createdAt,
      link: `${LINK}/${r.voucherId}`,
      actions: [
        { kind: 'approve', label: 'Approve void', method: 'POST', path: `/trustops/cash-vouchers/void-requests/${r.id}/approve`, body: {},
          confirm: 'Void this voucher now? The cash goes back where it came from and the expense is undone.',
          ...(r.blockedBy ? { disabledReason: `Cannot be voided: ${r.blockedBy}. Reject it instead.` } : {}) },
        { kind: 'reject', label: 'Reject', method: 'POST', path: `/trustops/cash-vouchers/void-requests/${r.id}/reject`, body: {},
          input: { field: 'note', label: 'Reason (at least 10 characters)', required: true } },
      ],
    }))
  },
}
