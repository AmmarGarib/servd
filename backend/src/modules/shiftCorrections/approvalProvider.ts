// ── Shift corrections (owner, 2026-10-21) in the approvals inbox ───────────
// GET /pos/shift-corrections?status=submitted (finance + CEO; module
// accounting) lists the sets waiting for the CEO. Approve / Reject call the
// module's own routes (POST /pos/shift-corrections/:id/approve | reject
// {note}) — ADMIN_ONLY, never handed over (APPROVAL_RIGHTS.shift_correction,
// section 'ceo').

import type { UserRole } from '@prisma/client'
import { APPROVAL_RIGHTS } from '../../lib/approvalRights.js'
import type { ApprovalItem, ApprovalProvider } from '../approvals/types.js'

const RIGHTS = APPROVAL_RIGHTS.shift_correction
const BASE = '/pos/shift-corrections'
const LINK = '/finance/shift-corrections'

const KIND_LABEL: Record<string, string> = { void_bill: 'Void bill', cancel_kot: 'Cancel KOT', void_reissue: 'Void & re-issue' }

interface Row {
  id: string
  tenantId: string
  shiftId: string
  businessDay: string
  status: string
  reason: string
  createdAt: string
  requestedBy: { id: string; name: string | null }
  shift: { cashierName: string | null; locationName: string | null } | null
  items: Array<{ kind: string; orderRef: string; reason: string; moneyReturned: boolean; foodMade: boolean }>
}

export const shiftCorrections: ApprovalProvider = {
  type: 'shift_correction',
  label: RIGHTS.label,
  module: RIGHTS.queueModule,
  link: LINK,
  approverRoles: RIGHTS.roles as readonly UserRole[],
  delegable: RIGHTS.delegable,
  async load(ctx) {
    const res = await ctx.read<{ items: Row[] }>(`${BASE}?status=submitted`)
    if (res === null) return null
    return (res.items ?? []).map((r): ApprovalItem => {
      const drawer = r.shiftId.slice(-8).toUpperCase()
      const fixes = r.items.map((i) => `${KIND_LABEL[i.kind] ?? i.kind} #${i.orderRef}${i.moneyReturned ? ' (money returned)' : ''}${i.foodMade ? ' (food made)' : ''} — ${i.reason}`)
      return {
        type: 'shift_correction',
        id: r.id,
        tenantId: r.tenantId,
        section: RIGHTS.section,
        submittedByIds: [r.requestedBy.id],
        title: `Shift correction — drawer ${drawer}, ${r.businessDay} — ${r.items.length} fix${r.items.length === 1 ? '' : 'es'}`,
        subtitle: r.reason,
        facts: [
          { label: 'Business day', value: r.businessDay },
          { label: 'Drawer', value: `${drawer}${r.shift?.cashierName ? ` (${r.shift.cashierName})` : ''}` },
          ...(r.shift?.locationName ? [{ label: 'Outlet', value: r.shift.locationName }] : []),
          { label: 'Requested by', value: r.requestedBy.name ?? '—' },
          ...fixes.map((f, n) => ({ label: `Fix ${n + 1}`, value: f })),
        ],
        amountCents: null,
        waitingSince: r.createdAt,
        link: `${LINK}?id=${encodeURIComponent(r.id)}`,
        actions: [
          {
            kind: 'approve', label: 'Approve and apply', method: 'POST', path: `${BASE}/${r.id}/approve`, body: {},
            input: { field: 'note', label: 'Note', required: false },
            confirm: 'Approve this correction? The drawer\'s close is reversed and re-posted on its business day, the bills are voided / the KOTs cancelled and parked in the Trash, and the fiscal void documents are queued.',
          },
          {
            kind: 'reject', label: 'Reject', method: 'POST', path: `${BASE}/${r.id}/reject`, body: {},
            input: { field: 'note', label: 'Reason', required: true },
          },
        ],
      }
    })
  },
}
