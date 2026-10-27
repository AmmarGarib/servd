// ── Employee work map pins (owner, 2026-10-27) in the approvals inbox ───────
// GET /hr/work-pins?status=pending lists the custom work pins whose pin or
// radius differs from the one the CEO approved (and from the one the CEO
// turned down). Approve / Reject call the module's own routes
// (POST /hr/work-pins/:id/approve | reject) with the pin shown, so a pin
// moved in the meantime is refused (PIN_CHANGED). ADMIN_ONLY, never handed
// over (APPROVAL_RIGHTS.work_pin, section 'ceo'). Mirrors locations/approvalProvider.ts.

import type { UserRole } from '@prisma/client'
import { APPROVAL_RIGHTS } from '../../lib/approvalRights.js'
import type { ApprovalItem, ApprovalProvider } from '../approvals/types.js'

const RIGHTS = APPROVAL_RIGHTS.work_pin

interface Pin { latitude: number | null; longitude: number | null; radiusMetres: number | null }
interface Row {
  id: string
  tenantId: string
  employeeId: string
  employeeName: string
  employeeCode: string | null
  label: string | null
  updatedAt: string
  pin: Pin
  approved: (Pin & { at: string | null }) | null
}

const where = (p: Pin) => `${p.latitude?.toFixed(6)}, ${p.longitude?.toFixed(6)} — ${p.radiusMetres != null ? `${p.radiusMetres} m` : 'company radius'}`
const map = (p: Pin) => `https://www.google.com/maps?q=${p.latitude},${p.longitude}`

export const workPins: ApprovalProvider = {
  type: 'work_pin',
  label: RIGHTS.label,
  module: RIGHTS.queueModule,
  link: '/hr/employees',
  approverRoles: RIGHTS.roles as readonly UserRole[],
  delegable: RIGHTS.delegable,
  async load(ctx) {
    const res = await ctx.read<{ items: Row[] }>('/hr/work-pins?status=pending')
    if (res === null) return null
    return (res.items ?? []).map((r): ApprovalItem => {
      const body = { latitude: r.pin.latitude, longitude: r.pin.longitude, radiusMetres: r.pin.radiusMetres }
      const link = `/hr/employees/${encodeURIComponent(r.employeeId)}`
      return {
        type: 'work_pin',
        id: r.id,
        tenantId: r.tenantId,
        section: RIGHTS.section,
        submittedByIds: [],
        title: `Work map pin — ${r.label ?? 'pin'} (${r.employeeName})`,
        subtitle: r.approved ? 'The pin or radius was changed' : 'New pin',
        facts: [
          { label: 'Employee', value: r.employeeCode ? `${r.employeeName} (${r.employeeCode})` : r.employeeName },
          { label: 'New pin', value: where(r.pin) },
          { label: 'On the map', value: map(r.pin) },
          { label: 'Approved now', value: r.approved ? where(r.approved) : 'None — punches here are out of area until a pin is approved' },
        ],
        amountCents: null,
        waitingSince: r.updatedAt,
        link,
        actions: [
          { kind: 'approve', label: 'Approve pin', method: 'POST', path: `/hr/work-pins/${r.id}/approve`, body,
            confirm: 'Approve this map pin and radius? This person\'s clock-ins are measured from it from now on.' },
          { kind: 'reject', label: 'Reject', method: 'POST', path: `/hr/work-pins/${r.id}/reject`, body,
            input: { field: 'note', label: 'Reason (at least 10 characters)', required: true } },
        ],
      }
    })
  },
}
