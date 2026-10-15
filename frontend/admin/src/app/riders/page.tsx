'use client'
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { api, ApiError, deleteWithUndo } from '../../lib/api'
import { formatBrandName } from '../../lib/brandName'
import { usePermissions } from '../../hooks/useCan'
import { orderRef } from '../../lib/orderRef'
import { useManagerRoles } from '../../lib/roles'
import { canOpenPath } from '../../lib/moduleCatalog'
import { Select } from '@/components/ui/Select'

// Rider portal: the dispatch board (delivery orders awaiting a rider / with a
// rider), the roster, and the shared-fleet agreements (docs/rider-app.md).
//
// Only delivery orders need a rider: the boards filter on
// fulfilmentType === 'delivery'. (They used to take every non-till order,
// so a storefront pickup or a table order could be handed to a rider.)
//
// "With a rider" also lists 'completed' orders still on the road (expo
// completed the order as the bag went out, or a till-paid order sent out):
// the orders list only takes in-service statuses, so those come from
// GET /dispatch/board, which carries them (the server's rule for an order
// still on a rider's hands).

/** The order's rider-job timestamps (docs/rider-app.md, migration 20261010120000). */
interface StageTimes {
  riderAssignedAt?: string | null
  riderAcceptedAt?: string | null
  pickedUpAt?: string | null
  arrivedAt?: string | null
}
interface ActiveOrder extends StageTimes {
  id: string; status: string; customerName: string | null
  concept: { name: string }; placedAt: string
}
interface Rider {
  id: string; name: string; phone: string; vehicleType: string
  status: 'available' | 'busy' | 'offline'; isActive: boolean
  totalDeliveries: number; notes: string | null
  tenantId?: string | null
  // From GET /riders: the rider's company (their employer) and their latest
  // job event. Until the API sends them, the company name comes from the
  // operator's company list and the stage from the rider's live order.
  tenant?: { name: string } | null
  jobEvents?: Array<{ type: string; createdAt: string }>
  orders: ActiveOrder[]
}
interface DeliveryOrder extends StageTimes {
  id: string; status: string; source?: string; fulfilmentType: string
  customerName: string | null
  deliveryNotes: string | null; totalCents: number; placedAt: string
  completedAt: string | null
  deliveredAt?: string | null
  riderId: string | null
  /** Wrong hand-over codes so far (locks at OTP_MAX_ATTEMPTS). */
  deliveryOtpAttempts?: number
  /** Filled from the dispatch board (the orders list does not carry them). */
  codeOnly?: boolean
  handoverReroutedAt?: string | null
  handoverRerouteByName?: string | null
  doorProblem?: { kind: string; at: string } | null
  concept: { name: string }
  rider?: { id: string; name: string; phone: string } | null
}
/** GET /dispatch/board — read here for the completed orders still with a rider. */
interface BoardRider {
  id: string; name: string; phone: string
  orders: Array<StageTimes & {
    id: string; status: string; totalCents: number; customerName: string | null
    deliveryNotes: string | null; placedAt: string; fulfilmentType?: string
    deliveredAt?: string | null; deliveryOtpAttempts?: number
    /** The order's company runs code-only delivery: no staff "Delivered". */
    codeOnly?: boolean
    handoverReroutedAt?: string | null
    handoverRerouteByName?: string | null
    doorProblem?: { kind: string; at: string } | null
    concept: { name: string }
  }>
}
interface FleetAgreement {
  id: string
  providerTenantId: string; providerName: string
  clientTenantId: string; clientName: string
  isActive: boolean; updatedAt: string
}
interface FleetData { agreements: FleetAgreement[]; companies: Array<{ id: string; name: string }> }
type FleetChange = { providerTenantId: string; clientTenantId: string; isActive: boolean }

const STATUS_COLORS: Record<string, string> = {
  available: 'bg-primary/20 text-primary-ink border border-primary/30',
  busy: 'bg-s-amber/20 text-s-amber border border-s-amber/30',
  offline: 'bg-s-border text-s-muted border border-s-border',
}
const STATUS_DOT: Record<string, string> = {
  available: 'bg-primary',
  busy: 'bg-s-amber',
  offline: 'bg-s-border',
}
const VEHICLE_LABEL: Record<string, string> = {
  bike: 'Bike', car: 'Car', bicycle: 'Bicycle', foot: 'On foot',
}

// Job stages (the rider app's flow) and the job-event types around them.
const STAGE_LABEL: Record<string, string> = {
  offered: 'Offered, not accepted yet',
  accepted: 'Accepted',
  picked_up: 'Picked up',
  arrived: 'At the door',
  delivered: 'Delivered',
  declined: 'Declined',
  timed_out: 'Offer timed out',
  otp_failed: 'Wrong hand-over code',
  unassigned: 'Unassigned',
}
const STAGE_CHIP: Record<string, string> = {
  offered: 'bg-s-amber-dim text-s-amber',
  accepted: 'bg-s-blue-dim text-s-blue',
  picked_up: 'bg-s-indigo-dim text-s-indigo',
  arrived: 'bg-s-teal-dim text-primary-ink',
  delivered: 'bg-s-green-dim text-s-green',
  declined: 'bg-s-red-dim text-s-red',
  timed_out: 'bg-s-red-dim text-s-red',
  otp_failed: 'bg-s-red-dim text-s-red',
  unassigned: 'bg-s-bg-soft text-s-muted',
}

/** Where a rider-carried order is, from its timestamps; null when the API didn't send them. */
function jobStage(o: StageTimes): { stage: string; at: string | null } | null {
  if (!('riderAssignedAt' in o) && !('riderAcceptedAt' in o)) return null
  if (o.arrivedAt) return { stage: 'arrived', at: o.arrivedAt }
  if (o.pickedUpAt) return { stage: 'picked_up', at: o.pickedUpAt }
  if (o.riderAcceptedAt) return { stage: 'accepted', at: o.riderAcceptedAt }
  return { stage: 'offered', at: o.riderAssignedAt ?? null }
}

/** Wrong hand-over codes before the job locks — DELIVERY_OTP_MAX_ATTEMPTS in backend lib/deliveryOtp.ts. */
const OTP_MAX_ATTEMPTS = 5

/**
 * "Enter customer's code" — staff type the customer's 4-digit hand-over code
 * for a rider without the app. POST /trustops/orders/:id/verify-otp: a right
 * code delivers the order; a wrong one answers 403 OTP_MISMATCH with
 * attemptsLeft; once locked it answers 423 OTP_LOCKED (a manager then uses
 * Emergency overrides when the company is code-only).
 */
function EnterCode({ orderId, onDone }: { orderId: string; onDone: () => void }) {
  const [open, setOpen] = useState(false)
  const [code, setCode] = useState('')
  const [msg, setMsg] = useState<{ tone: 'bad' | 'info'; text: string } | null>(null)
  const verify = useMutation({
    mutationFn: () => api.post(`/trustops/orders/${orderId}/verify-otp`, { otp: code }),
    onSuccess: () => { setOpen(false); setCode(''); setMsg(null); onDone() },
    onError: (err: unknown) => {
      setCode('')
      if (err instanceof ApiError && err.status === 423) {
        setMsg({ tone: 'bad', text: 'Ask a manager to send the code to the rider.' })
      } else if (err instanceof ApiError && err.code === 'OTP_MISMATCH') {
        const left = (err.details as { attemptsLeft?: number } | undefined)?.attemptsLeft
        setMsg({ tone: 'bad', text: left != null ? `Wrong code. ${left} ${left === 1 ? 'try' : 'tries'} left.` : 'Wrong code.' })
      } else {
        setMsg({ tone: 'bad', text: err instanceof Error ? err.message : 'Could not check the code.' })
      }
      onDone()
    },
  })
  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="text-[11px] text-primary-ink hover:underline">Enter customer's code</button>
    )
  }
  return (
    <div className="w-full space-y-1">
      <div className="flex gap-2 items-center">
        <input inputMode="numeric" autoComplete="off" maxLength={4} aria-label="Customer's 4-digit code"
          value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 4))}
          className="s-input w-24 text-center tracking-widest" placeholder="0000" />
        <button disabled={code.length !== 4 || verify.isPending} onClick={() => verify.mutate()}
          className="s-btn-primary text-xs disabled:opacity-50">{verify.isPending ? 'Checking…' : 'Check'}</button>
        <button onClick={() => { setOpen(false); setMsg(null) }} className="text-[11px] text-s-muted hover:underline">Cancel</button>
      </div>
      {msg && <p role="alert" className={`text-[11px] ${msg.tone === 'bad' ? 'text-s-red' : 'text-s-muted'}`}>{msg.text}</p>}
    </div>
  )
}

/**
 * Who may mark a delivery delivered from this board — the API's rule for
 * POST /dispatch/orders/:id/delivered (docs/rider-app.md, "The hand-over
 * code"). The rider closes a rider-app job with the customer's code at the
 * door — that code is what stops anyone "delivering" without going there — so
 * the board only steps in for a manager, and only when:
 *   - the code has locked after OTP_MAX_ATTEMPTS wrong tries, or
 *   - the rider never accepted the job in the app (riderAcceptedAt unset:
 *     assigned by hand to a rider not on the app, or an order from before
 *     the app).
 * Otherwise the API answers 409 RIDER_CLOSES_WITH_CODE. Other staff never get
 * the button. The order must be on the road: 'ready', or 'completed' (it went
 * out paid) and not delivered yet.
 */
function deliverGate(o: DeliveryOrder, isManager: boolean): { canMark: boolean; locked: boolean; note: string | null } {
  if (o.deliveredAt) return { canMark: false, locked: false, note: null }
  if (o.status !== 'ready' && o.status !== 'completed') {
    return { canMark: false, locked: false, note: `Kitchen still on it (${o.status}) — deliverable once ready` }
  }
  const locked = (o.deliveryOtpAttempts ?? 0) >= OTP_MAX_ATTEMPTS
  // Code-only delivery: no staff "Delivered". The rider app or "Enter
  // customer's code" completes it; a locked code goes to a manager on Emergency
  // overrides. Unknown (board loading / errored / rider not on the board) keeps
  // today's behaviour — the API refuses staff Delivered for a code-only company.
  if (o.codeOnly === true) {
    return {
      canMark: false, locked,
      note: locked ? 'Code locked — a manager can send the code to the rider.' : "Closed with the customer's code only.",
    }
  }
  if (o.riderAcceptedAt && !locked) {
    return { canMark: false, locked, note: "The rider closes this with the customer's code at the door." }
  }
  if (!isManager) {
    return {
      canMark: false, locked,
      note: locked
        ? `The hand-over code locked after ${OTP_MAX_ATTEMPTS} wrong tries — a manager marks it delivered.`
        : 'Not taken in the rider app — a manager marks it delivered once the customer has it.',
    }
  }
  return {
    canMark: true, locked,
    note: locked
      ? `The hand-over code locked after ${OTP_MAX_ATTEMPTS} wrong tries. Confirm with the customer first.`
      : 'Not taken in the rider app. Confirm with the customer first.',
  }
}

/** 923001234567 → +92 300 1234567 (riders' phones are stored normalised). */
function fmtPhone(p: string): string {
  const m = /^92(\d{3})(\d{7})$/.exec(p)
  return m ? `+92 ${m[1]} ${m[2]}` : p
}

function fmtTime(iso: string | null): string {
  return iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
}

function initials(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('') || '?'
}

function StageChip({ stage, at }: { stage: string; at?: string | null }) {
  return (
    <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium ${STAGE_CHIP[stage] ?? 'bg-s-bg-soft text-s-muted'}`}>
      {STAGE_LABEL[stage] ?? stage}
      {at && <span className="opacity-70">· {fmtTime(at)}</span>}
    </span>
  )
}

function Switch({ value, onChange, disabled, label }: { value: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={value} aria-label={label} title={label}
      disabled={disabled} onClick={() => onChange(!value)}
      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50 ${value ? 'bg-accent' : 'bg-s-border'}`}>
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-s-surface shadow transition-transform ${value ? 'translate-x-5' : 'translate-x-0.5'}`} />
    </button>
  )
}

export default function RidersPage() {
  const qc = useQueryClient()
  const { data: me } = usePermissions()
  // The API's MANAGERS (served by GET /permissions/role-modules; lib/roles.ts).
  const managerRoles = useManagerRoles()
  const isManager = managerRoles.has(me?.role ?? '')
  const canOverrides = canOpenPath('/emergency-overrides', me?.role, me?.modules ?? [])
  const [tab, setTab] = useState<'dispatch' | 'roster' | 'fleet'>('dispatch')
  const [showAdd, setShowAdd] = useState(false)
  const [viewingHistory, setViewingHistory] = useState<string | null>(null)
  const [addForm, setAddForm] = useState({ name: '', phone: '', vehicleType: 'bike', notes: '' })
  const [assigningOrder, setAssigningOrder] = useState<string | null>(null)
  const [fleetError, setFleetError] = useState<string | null>(null)

  const { data: riders = [], isLoading: ridersLoading } = useQuery({
    queryKey: ['riders'],
    queryFn: () => api.get<Rider[]>('/riders'),
    refetchInterval: 15_000,
  })

  // Active delivery orders. The list API has no fulfilment filter, so take
  // its maximum page (200) — a busy dine-in floor must not push deliveries
  // off a 50-order page — and keep only deliveries.
  const { data: deliveryOrders = [] } = useQuery({
    queryKey: ['orders-delivery'],
    queryFn: () => api.get<{ data: DeliveryOrder[] }>('/orders?status=received,confirmed,preparing,ready&limit=200')
      .then((r) => r.data.filter((o) => o.fulfilmentType === 'delivery')),
    refetchInterval: 10_000,
  })

  // The dispatch board (same cache as /dispatch): the source of 'completed'
  // orders still on the road with a rider.
  const { data: board = [] } = useQuery({
    queryKey: ['dispatch-board'],
    queryFn: () => api.get<BoardRider[]>('/dispatch/board'),
    refetchInterval: 10_000,
  })

  const { data: history } = useQuery({
    queryKey: ['rider-history', viewingHistory],
    queryFn: () => api.get<{ rider: Rider; orders: DeliveryOrder[]; totalDeliveries: number }>(`/riders/${viewingHistory}/history`),
    enabled: !!viewingHistory,
  })

  // Company names for the roster (same cache as the sidebar's company switcher).
  const { data: myCompanies = [] } = useQuery({
    queryKey: ['my-tenants'],
    queryFn: () => api.get<Array<{ id: string; name: string }>>('/tenants/mine'),
    staleTime: 60_000,
  })

  // Fleet agreements are managers-only; anyone else gets a 403 and no Fleet tab.
  const { data: fleet } = useQuery({
    queryKey: ['fleet-agreements'],
    queryFn: () => api.get<FleetData>('/riders/fleet/agreements'),
    retry: false,
    staleTime: 30_000,
  })

  const addMutation = useMutation({
    mutationFn: (body: typeof addForm) => api.post<Rider>('/riders', body),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['riders'] }); setShowAdd(false); setAddForm({ name: '', phone: '', vehicleType: 'bike', notes: '' }) },
  })

  // Assigning, delivering and rider availability all go through /dispatch —
  // the one set of rider rules (the rider's own company or a fleet agreement,
  // active, not offline; the rider is freed after their last drop).
  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => api.post(`/dispatch/riders/${id}/status`, { status }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['riders'] }),
    onError: (err: Error) => alert(err.message),
  })

  const assignMutation = useMutation({
    mutationFn: ({ orderId, riderId }: { orderId: string; riderId: string }) =>
      api.post(`/dispatch/orders/${orderId}/assign`, { riderId }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['riders'] }); void qc.invalidateQueries({ queryKey: ['orders-delivery'] }); setAssigningOrder(null) },
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
  const refreshBoards = () => {
    void qc.invalidateQueries({ queryKey: ['riders'] })
    void qc.invalidateQueries({ queryKey: ['orders-delivery'] })
    void qc.invalidateQueries({ queryKey: ['dispatch-board'] })
  }

  const deliveredMutation = useMutation({
    mutationFn: (orderId: string) => api.post(`/dispatch/orders/${orderId}/delivered`, {}),
    onMutate: (orderId) => setOrderError(orderId, null),
    onSuccess: refreshBoards,
    onError: (err: Error, orderId) => {
      setOrderError(orderId, err.message || 'Could not mark it delivered.')
      // The job may have moved on (the rider accepted it): refresh the button.
      refreshBoards()
    },
  })

  // A manager closing a delivery without the customer's code (deliverGate).
  function markDelivered(order: DeliveryOrder) {
    if (!window.confirm(
      `Mark ${order.customerName ? `${order.customerName}'s order` : 'this order'} delivered without the customer's code?\n\n` +
      'Only do this once you have confirmed with the customer that they have the food.',
    )) return
    deliveredMutation.mutate(order.id)
  }

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteWithUndo(`/riders/${id}`, { trashType: 'rider', id, onRestored: () => void qc.invalidateQueries({ queryKey: ['riders'] }) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['riders'] }),
  })

  const fleetMutation = useMutation({
    mutationFn: (body: FleetChange) => api.put<FleetAgreement>('/riders/fleet/agreements', body),
    onMutate: () => setFleetError(null),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['fleet-agreements'] }); void qc.invalidateQueries({ queryKey: ['riders'] }) },
    onError: (err: Error) => setFleetError(err.message),
  })

  const companyNames = new Map<string, string>()
  for (const c of myCompanies) companyNames.set(c.id, c.name)
  for (const c of fleet?.companies ?? []) companyNames.set(c.id, c.name)
  const companyOf = (r: Rider): string | null =>
    r.tenant?.name ?? (r.tenantId ? companyNames.get(r.tenantId) ?? null : null)
  // More than one company in view → name the company on each rider.
  const multiCompany = new Set(riders.map((r) => r.tenantId ?? '')).size > 1

  /** The rider's latest job stage: a job event when the API sends one, else their live order's stage. */
  const lastStageOf = (r: Rider): { stage: string; at: string | null } | null => {
    const ev = r.jobEvents?.[0]
    if (ev) return { stage: ev.type, at: ev.createdAt }
    const live = withRider.find((o) => o.riderId === r.id) ?? r.orders[0]
    return live ? jobStage(live) : null
  }

  const available = riders.filter((r) => r.status === 'available')
  const busy = riders.filter((r) => r.status === 'busy')
  const offline = riders.filter((r) => r.status === 'offline')
  const unassigned = deliveryOrders.filter((o) => !o.riderId)
  const inService = deliveryOrders.filter((o) => o.riderId)
  const listed = new Set(inService.map((o) => o.id))
  // Completed but not delivered yet, from the board (each order under the
  // rider carrying it — ours, or a partner fleet's under an agreement).
  const outCompleted: DeliveryOrder[] = board.flatMap((r) => r.orders
    .filter((o) => o.status === 'completed' && !o.deliveredAt && !listed.has(o.id)
      && (!o.fulfilmentType || o.fulfilmentType === 'delivery'))
    .map((o) => ({
      ...o,
      fulfilmentType: 'delivery',
      completedAt: null,
      riderId: r.id,
      rider: { id: r.id, name: r.name, phone: r.phone },
    })))
  // The orders list does not carry code-only / reroute / door problem: take
  // them from the board (same order id). Not on the board → codeOnly unknown,
  // which the gate treats as today's behaviour (the API still refuses staff
  // Delivered for a code-only company).
  const boardOrders = new Map(board.flatMap((r) => r.orders.map((o) => [o.id, o] as const)))
  const withRider: DeliveryOrder[] = [...inService, ...outCompleted].map((o) => {
    const b = boardOrders.get(o.id)
    return {
      ...o,
      ...(b ? {
        codeOnly: b.codeOnly ?? false,
        handoverReroutedAt: b.handoverReroutedAt ?? null,
        handoverRerouteByName: b.handoverRerouteByName ?? null,
        doorProblem: b.doorProblem ?? null,
        riderAcceptedAt: o.riderAcceptedAt ?? b.riderAcceptedAt ?? null,
      } : {}),
    }
  })

  function toggleFleet(change: FleetChange, providerName: string, clientName: string) {
    if (change.isActive && !window.confirm(
      `Let ${providerName} riders carry ${clientName} delivery orders?\n\n` +
      `They will see the customer's name, phone and address for the orders they carry. ` +
      `Each of those deliveries is recorded against ${clientName}.`,
    )) return
    fleetMutation.mutate(change)
  }

  const tabs = (['dispatch', 'roster', ...(fleet ? ['fleet'] as const : [])] as const)

  return (
    <div className="min-h-screen bg-s-bg p-6">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-black text-s-text mt-1">Rider Portal</h1>
        </div>
        <button onClick={() => setShowAdd(true)}
          className="rounded-xl bg-primary text-primary-on font-bold px-4 py-2 text-sm hover:opacity-90">
          + Add Rider
        </button>
      </header>

      {/* Stats row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
        {[
          { label: 'Available', value: available.length, color: 'text-primary-ink' },
          { label: 'On Delivery', value: busy.length, color: 'text-s-amber' },
          { label: 'Offline', value: offline.length, color: 'text-s-muted' },
          { label: 'Deliveries awaiting a rider', value: unassigned.length, color: unassigned.length > 0 ? 'text-s-red' : 'text-success' },
        ].map((s) => (
          <div key={s.label} className="rounded-xl border border-s-border bg-s-surface p-4">
            <p className="text-xs text-s-muted">{s.label}</p>
            <p className={`text-3xl font-black ${s.color}`}>{s.value}</p>
          </div>
        ))}
      </div>

      {/* Add rider form */}
      {showAdd && (
        <div className="mb-6 rounded-xl border border-primary bg-s-surface p-4 space-y-3 max-w-lg">
          <h3 className="font-bold text-s-text">Add Rider</h3>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-s-muted">Name</label>
              <input value={addForm.name} onChange={(e) => setAddForm({ ...addForm, name: e.target.value })}
                placeholder="Full name" className={inp} />
            </div>
            <div>
              <label className="text-xs text-s-muted">Phone (WhatsApp)</label>
              <input value={addForm.phone} onChange={(e) => setAddForm({ ...addForm, phone: e.target.value })}
                placeholder="+92 3XX XXXXXXX" inputMode="tel" autoComplete="off" className={inp} />
            </div>
            <div>
              <label className="text-xs text-s-muted">Vehicle</label>
              <Select value={addForm.vehicleType} onChange={(e) => setAddForm({ ...addForm, vehicleType: e.target.value })} className={inp}>
                <option value="bike">Bike</option>
                <option value="car">Car</option>
                <option value="bicycle">Bicycle</option>
                <option value="foot">On foot</option>
              </Select>
            </div>
            <div>
              <label className="text-xs text-s-muted">Notes (optional)</label>
              <input value={addForm.notes} onChange={(e) => setAddForm({ ...addForm, notes: e.target.value })}
                placeholder="Area, shift, etc." className={inp} />
            </div>
          </div>
          <p className="text-xs text-s-muted">
            The rider signs in to the rider app with this number and a code sent on WhatsApp.
          </p>
          {addMutation.isError && (
            <p className="text-xs text-s-red">{(addMutation.error as Error).message}</p>
          )}
          <div className="flex gap-2">
            <button onClick={() => addMutation.mutate(addForm)} disabled={!addForm.name.trim() || !addForm.phone.trim() || addMutation.isPending}
              className="rounded-lg bg-primary text-primary-on font-bold px-4 py-2 text-sm disabled:opacity-50">
              {addMutation.isPending ? 'Saving…' : 'Add Rider'}
            </button>
            <button onClick={() => { setShowAdd(false); addMutation.reset() }} className="rounded-lg border border-s-border text-s-muted px-4 py-2 text-sm">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 mb-6 border-b border-s-border pb-0">
        {tabs.map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium rounded-t-lg border-b-2 transition-colors
              ${tab === t ? 'border-accent text-primary-ink bg-s-surface' : 'border-transparent text-s-muted hover:text-s-text'}`}>
            {t === 'dispatch'
              ? `Dispatch Board${unassigned.length > 0 ? ` (${unassigned.length} pending)` : ''}`
              : t === 'roster' ? 'Rider Roster' : 'Fleet'}
          </button>
        ))}
      </div>

      {/* ══════════════ DISPATCH TAB ══════════════ */}
      {tab === 'dispatch' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Delivery orders with no rider */}
          <div>
            <h2 className="text-sm font-bold text-s-muted uppercase tracking-widest mb-3">
              Awaiting Rider ({unassigned.length})
            </h2>
            <div className="space-y-3">
              {unassigned.length === 0 && (
                <div className="rounded-xl border border-s-border p-6 text-center text-s-muted text-sm">
                  Every delivery has a rider
                </div>
              )}
              {unassigned.map((order) => (
                <div key={order.id} className="rounded-xl border border-s-red/30 bg-s-surface p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="font-bold text-s-text">
                        {order.customerName ?? 'Guest'} · {formatBrandName(order.concept.name)}
                      </p>
                      <p className="text-xs text-s-muted mt-0.5">
                        {order.deliveryNotes ?? 'No address'} · PKR {(order.totalCents / 100).toFixed(0)}
                      </p>
                      <p className="text-xs text-s-muted">
                        {new Date(order.placedAt).toLocaleTimeString()} · #{orderRef(order.id)}
                      </p>
                    </div>
                    <span className={`text-xs px-2 py-1 rounded-full font-medium capitalize
                      ${order.status === 'ready' ? 'bg-primary/20 text-primary-ink' : 'bg-s-amber/20 text-s-amber'}`}>
                      {order.status}
                    </span>
                  </div>
                  {assigningOrder === order.id ? (
                    <div className="mt-3">
                      <p className="text-xs text-s-muted mb-2">Choose a rider:</p>
                      <div className="space-y-1.5 max-h-40 overflow-y-auto">
                        {available.length === 0 && (
                          <p className="text-xs text-s-red">No available riders right now</p>
                        )}
                        {available.map((r) => (
                          <button key={r.id}
                            onClick={() => assignMutation.mutate({ orderId: order.id, riderId: r.id })}
                            disabled={assignMutation.isPending}
                            className="w-full flex items-center gap-3 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-left hover:bg-primary/20 transition-colors disabled:opacity-50">
                            <span className="text-[11px] font-semibold text-s-muted w-14 shrink-0">{VEHICLE_LABEL[r.vehicleType] ?? r.vehicleType}</span>
                            <div className="min-w-0">
                              <p className="text-sm font-semibold text-s-text">{r.name}</p>
                              <p className="text-xs text-s-muted">
                                {fmtPhone(r.phone)}{multiCompany && companyOf(r) ? ` · ${companyOf(r)}` : ''}
                              </p>
                            </div>
                          </button>
                        ))}
                      </div>
                      <button onClick={() => setAssigningOrder(null)}
                        className="mt-2 text-xs text-s-muted hover:text-s-text">
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button onClick={() => setAssigningOrder(order.id)}
                      className="mt-3 w-full rounded-lg bg-primary text-primary-on font-bold py-2 text-sm hover:opacity-90">
                      Assign Rider →
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Delivery orders with a rider */}
          <div>
            <h2 className="text-sm font-bold text-s-muted uppercase tracking-widest mb-3">
              With a Rider ({withRider.length})
            </h2>
            <div className="space-y-3">
              {withRider.length === 0 && (
                <div className="rounded-xl border border-s-border p-6 text-center text-s-muted text-sm">
                  No deliveries in progress
                </div>
              )}
              {withRider.map((order) => {
                const stage = jobStage(order)
                const gate = deliverGate(order, isManager)
                const rider = riders.find((r) => r.id === order.riderId)
                return (
                  <div key={order.id} className="rounded-xl border border-s-amber/30 bg-s-surface p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="font-bold text-s-text">
                          {order.customerName ?? 'Guest'} · {formatBrandName(order.concept.name)}
                        </p>
                        <p className="text-xs text-s-muted mt-0.5">
                          {order.deliveryNotes ?? 'No address'} · PKR {(order.totalCents / 100).toFixed(0)}
                          {order.status === 'completed' && ' · completed, not delivered yet'}
                        </p>
                        {order.rider && (
                          <p className="text-xs text-s-amber mt-1">
                            {order.rider.name} · {fmtPhone(order.rider.phone)}
                            {rider ? ` · ${VEHICLE_LABEL[rider.vehicleType] ?? rider.vehicleType}` : ''}
                            {/* Not in our roster → a fleet-agreement rider of another company. */}
                            {!rider && riders.length > 0 ? ' · partner fleet' : ''}
                          </p>
                        )}
                      </div>
                      {stage
                        ? <StageChip stage={stage.stage} at={stage.at} />
                        : <span className="text-xs px-2 py-1 rounded-full bg-s-amber/20 text-s-amber font-medium">With rider</span>}
                    </div>
                    {gate.note && (
                      <p className={`mt-3 text-center text-xs ${gate.locked ? 'text-s-red' : 'text-s-muted'}`}>{gate.note}</p>
                    )}
                    {deliverError[order.id] && (
                      <p role="alert" className="mt-2 text-center text-xs text-s-red">{deliverError[order.id]}</p>
                    )}
                    {order.handoverReroutedAt && (
                      <p className="mt-2 text-center text-xs text-success">
                        Code sent to the rider{order.handoverRerouteByName ? ` by ${order.handoverRerouteByName}` : ' by a manager'}
                      </p>
                    )}
                    {canOverrides && order.codeOnly && (gate.locked || order.doorProblem) && (
                      <p className="mt-2 text-center text-xs">
                        <Link href="/emergency-overrides" className="text-primary-ink underline">Open Emergency overrides</Link>
                      </p>
                    )}
                    {(order.status === 'ready' || order.status === 'completed') && order.codeOnly === true && (
                      <div className="mt-3 flex justify-center">
                        <EnterCode orderId={order.id} onDone={refreshBoards} />
                      </div>
                    )}
                    {gate.canMark && (
                      <button onClick={() => markDelivered(order)}
                        disabled={deliveredMutation.isPending}
                        className="mt-3 w-full rounded-lg border border-primary text-primary-ink font-bold py-2 text-sm hover:bg-primary/10 transition-colors disabled:opacity-50">
                        Mark Delivered
                      </button>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}

      {/* ══════════════ ROSTER TAB ══════════════ */}
      {tab === 'roster' && (
        <div className="space-y-3">
          {ridersLoading && <p className="text-s-muted text-sm">Loading riders…</p>}
          {riders.length === 0 && !ridersLoading && (
            <div className="rounded-xl border border-dashed border-s-border p-12 text-center">
              <p className="font-semibold text-s-text">No riders yet</p>
              <p className="text-sm text-s-muted mt-1">Add your first rider to start dispatching deliveries</p>
              <button onClick={() => setShowAdd(true)}
                className="mt-4 rounded-xl bg-primary text-primary-on font-bold px-6 py-2.5 hover:opacity-90">
                Add Rider
              </button>
            </div>
          )}
          {riders.map((rider) => {
            const company = companyOf(rider)
            const last = lastStageOf(rider)
            return (
              <div key={rider.id} className="rounded-xl border border-s-border bg-s-surface p-4">
                <div className="flex items-center gap-4 flex-wrap">
                  {/* Avatar */}
                  <div className="h-12 w-12 rounded-full bg-s-bg border border-s-border flex items-center justify-center text-sm font-bold text-s-text shrink-0">
                    {initials(rider.name)}
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-bold text-s-text">{rider.name}</p>
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS_COLORS[rider.status]}`}>
                        <span className={`inline-block h-1.5 w-1.5 rounded-full mr-1 ${STATUS_DOT[rider.status]}`} />
                        {rider.status}
                      </span>
                      {last && <StageChip stage={last.stage} at={last.at} />}
                    </div>
                    <p className="text-sm text-s-muted">
                      {fmtPhone(rider.phone)} · {VEHICLE_LABEL[rider.vehicleType] ?? rider.vehicleType}
                      {company && <> · <span className="text-s-text">{company}</span></>}
                    </p>
                    <div className="flex items-center gap-3 mt-1 flex-wrap">
                      <span className="text-xs text-s-muted">{rider.totalDeliveries} deliveries</span>
                      {rider.notes && <span className="text-xs text-s-muted">· {rider.notes}</span>}
                      {rider.orders[0] && (
                        <span className="text-xs text-s-amber">· On: {formatBrandName(rider.orders[0].concept.name)} order</span>
                      )}
                    </div>
                  </div>

                  {/* Status controls */}
                  <div className="flex items-center gap-2 shrink-0 flex-wrap">
                    {(['available', 'busy', 'offline'] as const).map((s) => (
                      <button key={s} onClick={() => statusMutation.mutate({ id: rider.id, status: s })}
                        disabled={rider.status === s || statusMutation.isPending}
                        className={`rounded-lg px-3 py-1.5 text-xs font-medium capitalize transition-colors
                          ${rider.status === s ? STATUS_COLORS[s] : 'border border-s-border text-s-muted hover:border-primary hover:text-primary-ink'}`}>
                        {s}
                      </button>
                    ))}
                    <button onClick={() => setViewingHistory(viewingHistory === rider.id ? null : rider.id)}
                      className="rounded-lg border border-s-border text-s-muted px-3 py-1.5 text-xs hover:text-s-text transition-colors">
                      History
                    </button>
                    <button onClick={() => { if (window.confirm(`Remove ${rider.name}? Their rider-app sign-in ends now.`)) deleteMutation.mutate(rider.id) }}
                      className="rounded-lg border border-s-border text-s-red px-3 py-1.5 text-xs hover:border-s-red transition-colors">
                      Remove
                    </button>
                  </div>
                </div>

                {/* Delivery history inline */}
                {viewingHistory === rider.id && history && (
                  <div className="mt-4 border-t border-s-border pt-4">
                    <p className="text-xs font-bold text-s-muted uppercase tracking-widest mb-2">
                      Last 50 deliveries ({history.totalDeliveries} total)
                    </p>
                    {history.orders.length === 0 && <p className="text-xs text-s-muted">No deliveries yet</p>}
                    <div className="space-y-1 max-h-48 overflow-y-auto">
                      {history.orders.map((o) => (
                        <div key={o.id} className="flex items-center justify-between text-xs py-1 border-b border-s-border/50 last:border-0">
                          <span className="text-s-text">{o.customerName ?? 'Guest'} · {formatBrandName(o.concept.name)}</span>
                          <span className="text-s-muted">PKR {(o.totalCents / 100).toFixed(0)} · {o.completedAt ? new Date(o.completedAt).toLocaleDateString() : '—'}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* ══════════════ FLEET TAB ══════════════ */}
      {tab === 'fleet' && fleet && (
        <FleetPanel
          fleet={fleet}
          riders={riders}
          pending={fleetMutation.isPending ? fleetMutation.variables ?? null : null}
          error={fleetError}
          onToggle={toggleFleet}
        />
      )}
    </div>
  )
}

// ─── Fleet agreements ────────────────────────────────────────────────────────
// "This company's riders also deliver for …" — one switch per ordered company
// pair among the companies the operator belongs to (the API only lets someone
// who belongs to both sides start or end one). Agreements with a company the
// operator is not in are listed read-only.

function FleetPanel({ fleet, riders, pending, error, onToggle }: {
  fleet: FleetData
  riders: Rider[]
  pending: FleetChange | null
  error: string | null
  onToggle: (change: FleetChange, providerName: string, clientName: string) => void
}) {
  const { companies, agreements } = fleet
  const byPair = new Map(agreements.map((a) => [`${a.providerTenantId}>${a.clientTenantId}`, a]))
  const memberIds = new Set(companies.map((c) => c.id))
  const external = agreements.filter((a) => !memberIds.has(a.providerTenantId) || !memberIds.has(a.clientTenantId))
  const ridersIn = (tenantId: string) => riders.filter((r) => r.tenantId === tenantId).length
  const fmtDate = (iso: string) => new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })

  return (
    <div className="max-w-3xl space-y-4">
      <div className="s-card p-4">
        <h2 className="font-bold text-s-text">Shared fleet</h2>
        <p className="text-sm text-s-muted mt-1">
          Riders stay staff of the company that employs them; each delivery is recorded against the company whose order it is, for the cost split.
        </p>
      </div>

      {error && (
        <div className="rounded-xl border border-s-red/30 bg-s-red-dim px-4 py-3 text-sm text-s-red">{error}</div>
      )}

      {companies.length < 2 ? (
        <div className="s-card p-4 text-sm text-s-muted">
          You belong to one company, so there is no other company to deliver for. A fleet agreement is switched on by someone who belongs to both companies.
        </div>
      ) : (
        companies.map((provider) => {
          const count = ridersIn(provider.id)
          return (
            <div key={provider.id} className="s-card overflow-hidden">
              <div className="px-4 py-3 border-b border-s-border bg-s-bg-soft flex items-center justify-between gap-3">
                <p className="font-bold text-s-text">{provider.name} riders</p>
                {count > 0 && <span className="text-xs text-s-muted">{count} {count === 1 ? 'rider' : 'riders'}</span>}
              </div>
              <ul className="divide-y divide-s-border">
                {companies.filter((c) => c.id !== provider.id).map((client) => {
                  const a = byPair.get(`${provider.id}>${client.id}`)
                  const on = !!a?.isActive
                  const busy = pending?.providerTenantId === provider.id && pending.clientTenantId === client.id
                  return (
                    <li key={client.id} className="flex items-center justify-between gap-3 px-4 py-3">
                      <div className="min-w-0">
                        <p className="text-sm text-s-text">
                          Also deliver for <span className="font-semibold">{client.name}</span>
                        </p>
                        <p className="text-xs text-s-muted">
                          {busy ? 'Saving…' : a ? `${on ? 'On' : 'Off'} · changed ${fmtDate(a.updatedAt)}` : 'Not set up'}
                        </p>
                      </div>
                      <Switch
                        value={busy ? !!pending?.isActive : on}
                        disabled={!!pending}
                        label={`${provider.name} riders deliver for ${client.name}`}
                        onChange={(v) => onToggle(
                          { providerTenantId: provider.id, clientTenantId: client.id, isActive: v },
                          provider.name, client.name,
                        )}
                      />
                    </li>
                  )
                })}
              </ul>
            </div>
          )
        })
      )}

      {external.length > 0 && (
        <div className="s-card overflow-hidden">
          <div className="px-4 py-3 border-b border-s-border bg-s-bg-soft">
            <p className="font-bold text-s-text">With other companies</p>
            <p className="text-xs text-s-muted">Changed only by someone who belongs to both companies.</p>
          </div>
          <ul className="divide-y divide-s-border">
            {external.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <p className="text-sm text-s-text">
                  <span className="font-semibold">{a.providerName}</span> riders deliver for <span className="font-semibold">{a.clientName}</span>
                </p>
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${a.isActive ? 'bg-s-teal-dim text-primary-ink' : 'bg-s-bg-soft text-s-muted'}`}>
                  {a.isActive ? 'On' : 'Off'}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

const inp = 'w-full rounded-lg bg-s-bg border border-s-border px-3 py-2 text-s-text text-sm focus:border-primary focus:outline-none mt-1'
