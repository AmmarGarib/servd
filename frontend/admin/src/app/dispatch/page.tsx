'use client'

// Dispatch board — every active rider, their assigned orders (with the job
// stage from the rider app), last GPS fix age, and a stale indicator. Polls
// every 8s.
//
// The board is our own fleet plus another company's rider while — and only
// while — they carry one of our orders under a fleet agreement (the API marks
// them `fleetPartner`; docs/rider-app.md). Their availability belongs to
// their own company, so it is shown, not edited, here.
//
// Only delivery orders take a rider. An order of any other fulfilment type
// on a rider (possible before the boards filtered on fulfilmentType) is
// flagged so it can be unassigned.
//
// A rider's orders include 'completed' ones still on the road (expo completed
// the order as the bag went out, or a till-paid order sent out for delivery):
// the job ends when the customer has the food, not when the order is paid.
//
// "Delivered" is a manager's override, not a routine button: the rider closes
// a rider-app job with the customer's code at the door (deliverGate below).

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/api'
import { fmtPkrWhole } from '../../lib/money'
import { formatBrandName } from '../../lib/brandName'
import { usePermissions } from '../../hooks/useCan'
import { orderRef } from '../../lib/orderRef'
import { useManagerRoles } from '../../lib/roles'
import { Select } from '@/components/ui/Select'

interface RiderRow {
  id: string; name: string; phone: string
  vehicleType: string; status: 'available' | 'busy' | 'offline'
  lastLat: number | null; lastLng: number | null; lastReportedAt: string | null
  lastFixAgeMs: number | null; stale: boolean
  fleetPartner?: boolean
  orders: Array<{
    id: string; status: string; totalCents: number; customerName: string | null
    deliveryNotes: string | null; placedAt: string
    fulfilmentType?: string
    riderAssignedAt?: string | null; riderAcceptedAt?: string | null
    pickedUpAt?: string | null; arrivedAt?: string | null
    /** Set once the customer has it; the board only carries undelivered orders. */
    deliveredAt?: string | null
    /** Wrong hand-over codes so far (locks at OTP_MAX_ATTEMPTS). */
    deliveryOtpAttempts?: number
    concept: { name: string; slug: string }
  }>
}
type BoardOrder = RiderRow['orders'][number]

const STATUS_DOT: Record<RiderRow['status'], string> = {
  available: 'bg-s-teal',
  busy:      'bg-s-amber',
  offline:   'bg-s-border-strong',
}

const STAGE: Record<string, { label: string; chip: string }> = {
  offered:   { label: 'Offered, not accepted yet', chip: 'bg-s-amber-dim text-s-amber' },
  accepted:  { label: 'Accepted',                  chip: 'bg-s-blue-dim text-s-blue' },
  picked_up: { label: 'Picked up',                 chip: 'bg-s-indigo-dim text-s-indigo' },
  arrived:   { label: 'At the door',               chip: 'bg-s-teal-dim text-primary-ink' },
}

/** Where the job is, from the order's rider timestamps; null when the API didn't send them. */
function jobStage(o: BoardOrder): { stage: string; at: string | null } | null {
  if (!('riderAssignedAt' in o) && !('riderAcceptedAt' in o)) return null
  if (o.arrivedAt) return { stage: 'arrived', at: o.arrivedAt }
  if (o.pickedUpAt) return { stage: 'picked_up', at: o.pickedUpAt }
  if (o.riderAcceptedAt) return { stage: 'accepted', at: o.riderAcceptedAt }
  return { stage: 'offered', at: o.riderAssignedAt ?? null }
}

/** Wrong hand-over codes before the job locks — DELIVERY_OTP_MAX_ATTEMPTS in backend lib/deliveryOtp.ts. */
const OTP_MAX_ATTEMPTS = 5

/** The kitchen is done ('ready', or 'completed' as it went out) and the customer does not have it yet. */
function onTheRoad(o: BoardOrder): boolean {
  return (o.status === 'ready' || o.status === 'completed') && !o.deliveredAt
}

/**
 * Whether this board may mark a delivery delivered — the API's rule for
 * POST /dispatch/orders/:id/delivered (docs/rider-app.md, "The hand-over
 * code"): a manager only, and only when the hand-over code has locked after
 * OTP_MAX_ATTEMPTS wrong tries or the rider never accepted the job in the app
 * (riderAcceptedAt unset: assigned by hand to a rider not on the app, or an
 * order from before the app). Otherwise the rider closes it with the
 * customer's code and the API answers 409 RIDER_CLOSES_WITH_CODE.
 */
function deliverGate(o: BoardOrder, isManager: boolean): { canMark: boolean; locked: boolean; note: string | null } {
  if (!onTheRoad(o)) return { canMark: false, locked: false, note: null }
  const locked = (o.deliveryOtpAttempts ?? 0) >= OTP_MAX_ATTEMPTS
  if (o.riderAcceptedAt && !locked) {
    return { canMark: false, locked, note: "Rider closes it with the customer's code." }
  }
  if (!isManager) {
    return {
      canMark: false, locked,
      note: locked ? 'Code locked — a manager marks it delivered.' : 'Not taken in the rider app — a manager marks it delivered.',
    }
  }
  return {
    canMark: true, locked,
    note: locked ? `Code locked after ${OTP_MAX_ATTEMPTS} wrong tries.` : 'Not taken in the rider app.',
  }
}

const FULFILMENT_LABEL: Record<string, string> = { dine_in: 'dine-in', takeout: 'pickup' }

function fmtAge(ms: number | null): string {
  if (ms == null) return 'never'
  if (ms < 60_000)    return `${Math.round(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`
  return `${Math.round(ms / 3_600_000)}h`
}

function fmtTime(iso: string | null): string {
  return iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
}

/** 923001234567 → +92 300 1234567 (riders' phones are stored normalised). */
function fmtPhone(p: string): string {
  const m = /^92(\d{3})(\d{7})$/.exec(p)
  return m ? `+92 ${m[1]} ${m[2]}` : p
}

export default function DispatchPage() {
  const qc = useQueryClient()
  const { data: me } = usePermissions()
  // The API's MANAGERS (served by GET /permissions/role-modules; lib/roles.ts).
  const managerRoles = useManagerRoles()
  const isManager = managerRoles.has(me?.role ?? '')

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['dispatch-board'],
    queryFn: () => api.get<RiderRow[]>('/dispatch/board'),
    refetchInterval: 8000,
  })

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: RiderRow['status'] }) =>
      api.post(`/dispatch/riders/${id}/status`, { status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['dispatch-board'] }),
    onError: (err: Error) => alert(err.message),
  })

  const unassign = useMutation({
    mutationFn: (orderId: string) => api.post(`/dispatch/orders/${orderId}/unassign`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['dispatch-board'] }),
    onError: (err: Error) => alert(err.message),
  })

  // The API's refusal (e.g. 409 RIDER_CLOSES_WITH_CODE once the rider has
  // taken the job in the app) is shown on the order, not in an alert.
  const [deliverError, setDeliverError] = useState<Record<string, string>>({})
  const setOrderError = (orderId: string, msg: string | null) => setDeliverError((e) => {
    const next = { ...e }
    if (msg) next[orderId] = msg
    else delete next[orderId]
    return next
  })

  const delivered = useMutation({
    mutationFn: (orderId: string) => api.post(`/dispatch/orders/${orderId}/delivered`, {}),
    onMutate: (orderId) => setOrderError(orderId, null),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['dispatch-board'] }),
    onError: (err: Error, orderId) => {
      setOrderError(orderId, err.message || 'Could not mark it delivered.')
      // The job may have moved on (the rider accepted it): refresh the button.
      void qc.invalidateQueries({ queryKey: ['dispatch-board'] })
    },
  })

  // A manager closing a delivery without the customer's code (deliverGate).
  function markDelivered(o: BoardOrder) {
    if (!window.confirm(
      `Mark ${o.customerName ? `${o.customerName}'s order` : 'this order'} delivered without the customer's code?\n\n` +
      'Only do this once you have confirmed with the customer that they have the food.',
    )) return
    delivered.mutate(o.id)
  }

  const isDelivery = (o: BoardOrder) => !o.fulfilmentType || o.fulfilmentType === 'delivery'
  const deliveriesOut = (data ?? []).reduce((n, r) => n + r.orders.filter(isDelivery).length, 0)

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-6 py-4 flex items-center justify-between">
        <div>
          <p className="text-xs text-s-muted">Operations</p>
          <h1 className="text-xl font-bold text-s-text">Dispatch board</h1>
        </div>
        <div className="text-xs text-s-muted flex items-center gap-3">
          {data && <span>{deliveriesOut} {deliveriesOut === 1 ? 'delivery' : 'deliveries'} with riders</span>}
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-s-teal animate-pulse" />
            polling every 8s
          </span>
          <button onClick={() => refetch()} className="s-btn-secondary text-xs">Refresh</button>
        </div>
      </header>

      <div className="p-6 max-w-6xl mx-auto space-y-3">
        {isLoading && <p className="text-s-muted text-sm">Loading…</p>}
        {data && data.length === 0 && (
          <div className="s-card p-12 text-center">
            <h3 className="text-lg font-semibold mb-2">No riders configured.</h3>
            <p className="text-s-muted text-sm">Add a rider via /riders to get started.</p>
          </div>
        )}
        {data?.map((r) => (
          <div key={r.id} className="s-card overflow-hidden">
            <div className="px-4 py-3 border-b border-s-border bg-s-bg-soft flex items-center justify-between flex-wrap gap-3">
              <div className="flex items-center gap-3">
                <span className={`h-3 w-3 rounded-full ${STATUS_DOT[r.status]}`} />
                <div>
                  <p className="text-sm font-bold flex items-center gap-2">
                    {r.name}
                    {r.fleetPartner && (
                      <span className="text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-s-purple-dim text-s-purple">
                        Partner fleet
                      </span>
                    )}
                  </p>
                  <p className="text-[11px] text-s-muted">{fmtPhone(r.phone)} · {r.vehicleType}</p>
                </div>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`text-[11px] ${r.stale ? 'text-s-red' : 'text-s-muted'}`}>
                  fix: {fmtAge(r.lastFixAgeMs)}{r.stale && r.lastFixAgeMs != null ? ' (stale)' : ''}
                </span>
                {r.lastLat != null && r.lastLng != null && (
                  <a target="_blank" rel="noopener noreferrer"
                    href={`https://www.google.com/maps?q=${r.lastLat},${r.lastLng}`}
                    className="text-[11px] text-primary-ink hover:underline">map ↗</a>
                )}
                {r.fleetPartner ? (
                  <span className="text-[11px] text-s-muted capitalize">{r.status}</span>
                ) : (
                  <Select
                    value={r.status}
                    onChange={(e) => setStatus.mutate({ id: r.id, status: e.target.value as RiderRow['status'] })}
                    className="text-xs bg-s-surface border border-s-border rounded px-2 py-1"
                  >
                    <option value="available">available</option>
                    <option value="busy">busy</option>
                    <option value="offline">offline</option>
                  </Select>
                )}
              </div>
            </div>

            <div className="p-3">
              {r.orders.length === 0 ? (
                <p className="text-xs text-s-muted text-center py-3">No active deliveries.</p>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {r.orders.map((o) => {
                    const stage = isDelivery(o) ? jobStage(o) : null
                    const meta = stage ? STAGE[stage.stage] : null
                    const gate = isDelivery(o) ? deliverGate(o, isManager) : null
                    return (
                      <div key={o.id} className={`rounded-lg border p-2 bg-s-bg-soft ${isDelivery(o) ? 'border-s-border' : 'border-s-red/40'}`}>
                        <div className="flex justify-between items-baseline mb-1">
                          <span className="text-xs font-mono text-s-muted">#{orderRef(o.id)}</span>
                          <span className="text-[10px] uppercase tracking-wider font-bold text-s-muted">
                            {o.status === 'completed' ? 'completed · not delivered' : o.status}
                          </span>
                        </div>
                        <p className="text-sm font-semibold">{formatBrandName(o.concept.name)}</p>
                        <p className="text-[11px] text-s-muted">{o.customerName ?? 'Guest'} · {fmtPkrWhole(o.totalCents)}</p>
                        {o.deliveryNotes && <p className="text-[11px] italic text-s-muted mt-1">{o.deliveryNotes}</p>}
                        {meta && stage && (
                          <span className={`mt-1.5 inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full font-medium ${meta.chip}`}>
                            {meta.label}
                            {stage.at && <span className="opacity-70">· {fmtTime(stage.at)}</span>}
                          </span>
                        )}
                        {!isDelivery(o) && (
                          <p className="text-[11px] text-s-red mt-1">
                            Not a delivery ({FULFILMENT_LABEL[o.fulfilmentType ?? ''] ?? o.fulfilmentType}) — unassign the rider.
                          </p>
                        )}
                        {gate?.note && (
                          <p className={`text-[11px] mt-1 ${gate.locked ? 'text-s-red' : 'text-s-muted'}`}>{gate.note}</p>
                        )}
                        {deliverError[o.id] && (
                          <p role="alert" className="text-[11px] mt-1 text-s-red">{deliverError[o.id]}</p>
                        )}
                        <div className="mt-2 flex gap-3">
                          {gate?.canMark && (
                            <button onClick={() => markDelivered(o)} disabled={delivered.isPending}
                              className="text-[11px] text-primary-ink hover:underline disabled:opacity-50">Delivered</button>
                          )}
                          <button onClick={() => unassign.mutate(o.id)} disabled={unassign.isPending}
                            className="text-[11px] text-s-red hover:underline disabled:opacity-50">Unassign</button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
