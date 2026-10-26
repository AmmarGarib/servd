// ── Kitchen station changes (owner C3, 2026-10-26) in the approvals inbox ──
// GET /stations/requests?status=pending lists the adds / changes the F&B
// manager or the chef raised. Approve / Reject call the module's own routes
// (POST /stations/requests/:id/approve | reject), whose guard decides.
// ADMIN_ONLY, never handed over (APPROVAL_RIGHTS.station_change, section 'ceo').

import type { UserRole } from '@prisma/client'
import { APPROVAL_RIGHTS } from '../../lib/approvalRights.js'
import type { ApprovalItem, ApprovalProvider } from '../approvals/types.js'

const RIGHTS = APPROVAL_RIGHTS.station_change
const LINK = '/kds/config'

interface Changes { name?: string; displayOrder?: number; isActive?: boolean; conceptId?: string }
interface Row {
  id: string
  tenantId: string
  kind: 'create' | 'update'
  changes: Changes
  requestedById: string
  requestedAt: string
  brandName: string | null
  moveToBrandName: string | null
  station: { name: string; displayOrder: number; isActive: boolean } | null
  requestedByName: string | null
}

function describe(r: Row): Array<{ label: string; value: string }> {
  const c = r.changes ?? {}
  if (r.kind === 'create') {
    return [
      { label: 'Brand', value: r.brandName ?? '—' },
      { label: 'New station', value: c.name ?? '—' },
      { label: 'Position', value: String(c.displayOrder ?? 0) },
    ]
  }
  const s = r.station
  const out = [{ label: 'Station', value: `${s?.name ?? '—'} (${r.brandName ?? 'brand'})` }]
  if (c.name !== undefined) out.push({ label: 'Name', value: `${s?.name ?? '—'} → ${c.name}` })
  if (c.displayOrder !== undefined) out.push({ label: 'Position', value: `${s?.displayOrder ?? '—'} → ${c.displayOrder}` })
  if (c.isActive !== undefined) out.push({ label: 'Switch', value: c.isActive ? 'Switch on' : 'Switch off (taken off the kitchen screens)' })
  if (c.conceptId !== undefined) out.push({ label: 'Move to brand', value: r.moveToBrandName ?? c.conceptId })
  return out
}

export const stationChanges: ApprovalProvider = {
  type: 'station_change',
  label: RIGHTS.label,
  module: RIGHTS.queueModule,
  link: LINK,
  approverRoles: RIGHTS.roles as readonly UserRole[],
  delegable: RIGHTS.delegable,
  async load(ctx) {
    const res = await ctx.read<{ items: Row[] }>('/stations/requests?status=pending')
    if (res === null) return null
    return (res.items ?? []).map((r): ApprovalItem => ({
      type: 'station_change',
      id: r.id,
      tenantId: r.tenantId,
      section: RIGHTS.section,
      submittedByIds: [r.requestedById],
      title: r.kind === 'create' ? `New kitchen station — ${r.changes?.name ?? ''}` : `Kitchen station change — ${r.station?.name ?? ''}`,
      subtitle: r.brandName ?? undefined,
      facts: [...describe(r), { label: 'Asked by', value: r.requestedByName ?? '—' }],
      amountCents: null,
      waitingSince: r.requestedAt,
      link: LINK,
      actions: [
        { kind: 'approve', label: 'Approve', method: 'POST', path: `/stations/requests/${r.id}/approve`, body: {},
          confirm: r.kind === 'create' ? 'Add this station? It appears on the kitchen screens at once.' : 'Apply this change to the station now?' },
        { kind: 'reject', label: 'Reject', method: 'POST', path: `/stations/requests/${r.id}/reject`, body: {},
          input: { field: 'note', label: 'Reason (at least 10 characters)', required: true } },
      ],
    }))
  },
}
