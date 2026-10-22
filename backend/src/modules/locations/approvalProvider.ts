// ── Time-clock map pins (owner, 2026-10-22) in the approvals inbox ─────────
// GET /locations/fence-pins?status=pending lists the locations whose map pin
// or radius differs from the one the CEO approved. Approve / Reject call the
// module's own routes (POST /locations/:id/fence-pin/approve | reject) with
// the pin shown, so a pin moved in the meantime is refused (PIN_CHANGED).
// ADMIN_ONLY, never handed over (APPROVAL_RIGHTS.location_pin, section 'ceo').

import type { UserRole } from '@prisma/client'
import { APPROVAL_RIGHTS } from '../../lib/approvalRights.js'
import type { ApprovalItem, ApprovalProvider } from '../approvals/types.js'

const RIGHTS = APPROVAL_RIGHTS.location_pin
const LINK = '/configuration/locations'

interface Pin { latitude: number | null; longitude: number | null; radiusMetres: number | null }
interface Row {
  id: string
  name: string
  tenantId: string
  updatedAt: string
  pin: Pin
  approved: (Pin & { at: string | null }) | null
}

const where = (p: Pin) => `${p.latitude?.toFixed(6)}, ${p.longitude?.toFixed(6)} — ${p.radiusMetres != null ? `${p.radiusMetres} m` : 'company radius'}`
const map = (p: Pin) => `https://www.google.com/maps?q=${p.latitude},${p.longitude}`

export const locationPins: ApprovalProvider = {
  type: 'location_pin',
  label: RIGHTS.label,
  module: RIGHTS.queueModule,
  link: LINK,
  approverRoles: RIGHTS.roles as readonly UserRole[],
  delegable: RIGHTS.delegable,
  async load(ctx) {
    const res = await ctx.read<{ items: Row[] }>('/locations/fence-pins?status=pending')
    if (res === null) return null
    return (res.items ?? []).map((r): ApprovalItem => {
      const body = { latitude: r.pin.latitude, longitude: r.pin.longitude, radiusMetres: r.pin.radiusMetres }
      return {
        type: 'location_pin',
        id: r.id,
        tenantId: r.tenantId,
        section: RIGHTS.section,
        submittedByIds: [],
        title: `Time-clock map pin — ${r.name}`,
        subtitle: r.approved ? 'The pin or radius was changed' : 'New pin',
        facts: [
          { label: 'New pin', value: where(r.pin) },
          { label: 'On the map', value: map(r.pin) },
          { label: 'Approved now', value: r.approved ? where(r.approved) : 'None — punches here cannot be placed until a pin is approved' },
        ],
        amountCents: null,
        waitingSince: r.updatedAt,
        link: LINK,
        actions: [
          { kind: 'approve', label: 'Approve pin', method: 'POST', path: `/locations/${r.id}/fence-pin/approve`, body,
            confirm: 'Approve this map pin and radius? Clock-ins at this location are measured from it from now on.' },
          { kind: 'reject', label: 'Reject', method: 'POST', path: `/locations/${r.id}/fence-pin/reject`, body,
            input: { field: 'note', label: 'Reason', required: true } },
        ],
      }
    })
  },
}
