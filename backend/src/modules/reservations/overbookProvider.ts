// ── Bookings past capacity (owner C10, 2026-10-26) in the approvals inbox ──
// GET /reservations/overbook-requests?status=pending lists the bookings (and
// changes of bookings) a manager took past capacity. Approve / Reject call the
// module's own routes (POST /reservations/overbook-requests/:id/approve |
// reject), whose guard decides. ADMIN_ONLY, never handed over
// (APPROVAL_RIGHTS.reservation_overbook, section 'ceo').

import type { UserRole } from '@prisma/client'
import { APPROVAL_RIGHTS } from '../../lib/approvalRights.js'
import type { ApprovalItem, ApprovalProvider } from '../approvals/types.js'

const RIGHTS = APPROVAL_RIGHTS.reservation_overbook
const LINK = '/reservations'

interface Changes { startTime?: string; endTime?: string; partySize?: number; tableId?: string | null; waitlist?: boolean }
interface Row {
  id: string
  tenantId: string
  kind: 'create' | 'edit'
  changes: Changes
  reason: string
  viaPin: boolean
  requestedById: string
  requestedAt: string
  requestedByName: string | null
  managerName: string | null
  newTableLabel: string | null
  reservation: {
    id: string; guestName: string; partySize: number; startTime: string; endTime: string
    concept: { name: string }; table: { label: string } | null
  } | null
}

const when = (iso: string) => new Date(iso).toLocaleString('en-GB', {
  timeZone: 'Asia/Karachi', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
})

function describe(r: Row): Array<{ label: string; value: string }> {
  const b = r.reservation
  const out = [
    { label: 'Guest', value: b ? `${b.guestName} · party of ${b.partySize}` : '—' },
    { label: 'When', value: b ? `${when(b.startTime)} PKT` : '—' },
  ]
  if (r.kind === 'edit') {
    const c = r.changes ?? {}
    if (c.startTime) out.push({ label: 'New time', value: `${when(c.startTime)} PKT` })
    if (c.partySize !== undefined) out.push({ label: 'New party size', value: String(c.partySize) })
    if (c.tableId !== undefined) out.push({ label: 'New table', value: c.tableId ? (r.newTableLabel ?? 'a table') : 'No table' })
  } else {
    out.push({ label: 'Table', value: b?.table?.label ?? 'No table — tables pushed together on arrival' })
  }
  out.push({ label: 'Reason', value: r.reason })
  out.push({ label: 'Asked by', value: `${r.requestedByName ?? '—'}${r.viaPin && r.managerName ? ` (manager PIN: ${r.managerName})` : ''}` })
  return out
}

export const reservationOverbooks: ApprovalProvider = {
  type: 'reservation_overbook',
  label: RIGHTS.label,
  module: RIGHTS.queueModule,
  link: LINK,
  approverRoles: RIGHTS.roles as readonly UserRole[],
  delegable: RIGHTS.delegable,
  async load(ctx) {
    const res = await ctx.read<{ items: Row[] }>('/reservations/overbook-requests?status=pending')
    if (res === null) return null
    return (res.items ?? []).map((r): ApprovalItem => ({
      type: 'reservation_overbook',
      id: r.id,
      tenantId: r.tenantId,
      section: RIGHTS.section,
      submittedByIds: [r.requestedById],
      title: `${r.kind === 'create' ? 'Booking past capacity' : 'Booking change past capacity'} — ${r.reservation?.guestName ?? ''}`,
      subtitle: r.reservation?.concept.name ?? undefined,
      facts: describe(r),
      amountCents: null,
      waitingSince: r.requestedAt,
      link: LINK,
      actions: [
        { kind: 'approve', label: 'Approve', method: 'POST', path: `/reservations/overbook-requests/${r.id}/approve`, body: {},
          confirm: r.kind === 'create' ? 'Book this past capacity? The guest is sent the confirmation now.' : 'Apply this change past capacity now?' },
        { kind: 'reject', label: 'Reject', method: 'POST', path: `/reservations/overbook-requests/${r.id}/reject`, body: {},
          input: { field: 'note', label: 'Reason (at least 10 characters)', required: true } },
      ],
    }))
  },
}
