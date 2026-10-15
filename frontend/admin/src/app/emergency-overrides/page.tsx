'use client'

// Emergency overrides — a delivery that has gone wrong at the door, once a
// company runs code-only delivery. Contract: backend/src/modules/
// emergencyOverrides/README.md. The page is a thin shell: the rules live in
// the API (send the code to the rider once per order, "Food came back").
// Polls every 8 s. Hidden until the module is granted (see moduleCatalog).

import { useState } from 'react'
import Link from 'next/link'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api, ApiError } from '../../lib/api'
import { fmtPkrWhole } from '../../lib/money'
import { formatBrandName } from '../../lib/brandName'
import { usePermissions } from '../../hooks/useCan'

interface Company { tenantId: string; name: string; codeOnly: boolean; since: string | null }
interface RoadRow {
  orderId: string; ref: string; brand: string; customerName: string | null
  stage: 'assigned' | 'accepted' | 'picked_up' | 'arrived'
  rider: { id: string; name: string; fleetPartner: string | null }
  cashToCollectCents: number
  codeLocked: boolean
  rerouted: { at: string; byName: string | null } | null
  doorProblem: { kind: 'no_code' | 'refused' | 'unreachable'; at: string } | null
  minutesOut: number
  codeOnly: boolean
}
interface RecentRow {
  id: string; type: 'code_rerouted' | 'returned'; at: string; orderId: string; ref: string
  brand: string; riderName: string | null; actorName: string | null; note: string | null
}
interface Overrides { onTheRoad: RoadRow[]; recent: RecentRow[] }
interface Preview { lines: Array<{ name: string; quantity: number }>; codToVoidCents: number; paidCents: number }
interface ReturnResult {
  ok: true; wasteCostCents: number; codVoidedCents: number; refundDueCents: number
  strike: { recorded: boolean; duplicate: boolean } | null
}

type Cause = 'refused' | 'unreachable' | 'other'
const CAUSES: Array<{ id: Cause; label: string }> = [
  { id: 'refused', label: 'Refused or would not pay — records a strike' },
  { id: 'unreachable', label: 'Could not reach the customer' },
  { id: 'other', label: 'Our mistake or other' },
]

const STAGE_LABEL: Record<RoadRow['stage'], string> = {
  assigned: 'Assigned', accepted: 'Accepted', picked_up: 'On the road', arrived: 'At the door',
}
const DOOR_LABEL: Record<NonNullable<RoadRow['doorProblem']>['kind'], string> = {
  no_code: 'Customer has no code', refused: 'Customer refused', unreachable: 'Customer not reachable',
}

/** Every error code the module can answer, in plain words. */
const ERROR_WORDS: Record<string, string> = {
  CODE_ONLY_OFF: "Code-only delivery is off for this company, so these actions are closed. The CEO switches it on at the top of this page.",
  ALREADY_REROUTED: 'The code was already sent to the rider once. It works once per order — use Resend instead.',
  NOT_REROUTED: 'The code has not been sent to the rider yet, so there is nothing to resend.',
  NO_RIDER: 'This order has no rider.',
  RIDER_NOT_AVAILABLE: 'The rider is not available any more.',
  RIDER_OFFLINE: 'The rider is offline, so the code cannot reach them.',
  RIDER_HAS_NO_PHONE: "The rider has no phone number on file, so the code cannot be sent.",
  NOT_PICKED_UP: 'The rider has not picked the order up yet.',
  NOT_READY: 'The order is not ready yet.',
  NOT_A_DELIVERY: 'This is not a delivery order.',
  ALREADY_DELIVERED: 'This order was already delivered.',
  ALREADY_RETURNED: 'This delivery was already logged as returned.',
  ORDER_NOT_ACTIVE: 'This order is no longer active.',
  ORDER_COMPLETED_USE_REFUND: 'This order is already completed. Hand money back from the order page instead.',
  CODE_REQUIRED: 'The order has no hand-over code to send.',
  REASON_REQUIRED: 'Write a reason first.',
  VALIDATION_ERROR: 'Check the form: the reason must be 10 to 300 characters to send a code, 5 or more for food returned.',
  MANAGER_OVERRIDE_REQUIRED: 'A manager has to approve this. Type a manager PIN below.',
  INVALID_MANAGER_PIN: 'That manager PIN is not right.',
  NOT_FOUND: 'That order is not in your companies any more.',
  RATE_LIMITED: 'Too many resends. Wait a few minutes and try again.',
  TOO_MANY_REQUESTS: 'Too many resends. Wait a few minutes and try again.',
  FORBIDDEN: 'You do not have access to this action.',
  ORDER_CHANGED: "This order's rider changed just now. Refresh and try again.",
}
function words(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 429) return ERROR_WORDS['RATE_LIMITED']!
    return ERROR_WORDS[err.code] ?? err.message ?? 'Something went wrong. Try again.'
  }
  return err instanceof Error ? err.message : 'Something went wrong. Try again.'
}

const CODE_ONLY_EXPLAIN =
  "Once on, staff can no longer mark deliveries Delivered; the rider app or 'Enter customer's code' completes them, and managers use this page when the code fails."

function fmtWhen(iso: string): string {
  return new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 bg-secondary/50 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}
        className="s-card w-full sm:max-w-lg max-h-[90vh] overflow-y-auto p-5 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-lg font-bold text-s-text">{title}</h2>
          <button onClick={onClose} className="s-btn-secondary text-xs">Close</button>
        </div>
        {children}
      </div>
    </div>
  )
}

export default function EmergencyOverridesPage() {
  const qc = useQueryClient()
  const { data: me } = usePermissions()
  const isCeo = me?.role === 'admin'
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['emergency-overrides'] })
    void qc.invalidateQueries({ queryKey: ['dispatch-board'] })
  }

  const { data: settings } = useQuery({
    queryKey: ['emergency-overrides', 'settings'],
    queryFn: () => api.get<{ companies: Company[] }>('/emergency-overrides/settings'),
    refetchInterval: 8000,
  })
  const { data, isLoading, error } = useQuery({
    queryKey: ['emergency-overrides', 'orders'],
    queryFn: () => api.get<Overrides>('/emergency-overrides/orders'),
    refetchInterval: 8000,
  })

  const [sendFor, setSendFor] = useState<RoadRow | null>(null)
  const [returnFor, setReturnFor] = useState<RoadRow | null>(null)
  const [switchFor, setSwitchFor] = useState<Company | null>(null)

  const companies = settings?.companies ?? []
  const anyOff = companies.some((c) => !c.codeOnly)

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-4 sm:px-6 py-4 flex items-center justify-between gap-3 flex-wrap">
        <div>
          <p className="text-xs text-success">Operations</p>
          <h1 className="text-xl font-bold text-s-text">Emergency overrides</h1>
        </div>
        <span className="text-xs text-s-muted inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-s-teal animate-pulse" />
          polling every 8s
        </span>
      </header>

      <div className="p-4 sm:p-6 max-w-6xl mx-auto space-y-5">
        {/* ── Code-only delivery, per company ── */}
        <section className="s-card p-4 space-y-3">
          <div>
            <h2 className="text-sm font-bold text-s-text">Code-only delivery</h2>
            <p className="text-xs text-s-muted mt-0.5">{CODE_ONLY_EXPLAIN}</p>
          </div>
          {companies.length === 0 && <p className="text-xs text-s-muted">No companies in view.</p>}
          <ul className="divide-y divide-s-border">
            {companies.map((c) => (
              <li key={c.tenantId} className="py-2 flex items-center justify-between gap-3 flex-wrap">
                <div>
                  <p className="text-sm font-semibold text-s-text">{c.name}</p>
                  <p className={`text-xs ${c.codeOnly ? 'text-success' : 'text-s-muted'}`}>
                    {c.codeOnly ? `On${c.since ? ` since ${fmtWhen(c.since)}` : ''}` : 'Off — staff can still mark deliveries Delivered'}
                  </p>
                </div>
                {isCeo ? (
                  <button onClick={() => setSwitchFor(c)}
                    className={c.codeOnly ? 's-btn-secondary text-xs' : 's-btn-primary text-xs'}>
                    {c.codeOnly ? 'Switch off' : 'Switch on'}
                  </button>
                ) : (
                  <span className="text-[11px] text-s-muted">Only the CEO changes this</span>
                )}
              </li>
            ))}
          </ul>
          {anyOff && (
            <p className="text-xs text-s-muted border-t border-s-border pt-2">
              For a company that is off, the actions below are disabled. {CODE_ONLY_EXPLAIN}
            </p>
          )}
        </section>

        {/* ── On the road ── */}
        <section className="space-y-2">
          <h2 className="text-sm font-bold text-s-text">On the road</h2>
          {isLoading && <p className="text-sm text-s-muted">Loading…</p>}
          {error && <p role="alert" className="text-sm text-s-red">{words(error)}</p>}
          {data && data.onTheRoad.length === 0 && (
            <div className="s-card p-8 text-center text-sm text-s-muted">No deliveries are out with a rider right now.</div>
          )}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {data?.onTheRoad.map((r) => (
              <div key={r.orderId} className="s-card p-4 space-y-2">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-xs font-mono text-s-muted">#{r.ref}</span>
                  <span className="text-[11px] text-s-muted">{r.minutesOut} min out · {STAGE_LABEL[r.stage]}</span>
                </div>
                <p className="text-sm font-semibold text-s-text">
                  {formatBrandName(r.brand)} <span className="font-normal text-s-muted">· {r.customerName ?? 'Guest'}</span>
                </p>
                <p className="text-xs text-s-muted flex items-center gap-2 flex-wrap">
                  Rider {r.rider.name}
                  {r.rider.fleetPartner && (
                    <span className="s-badge-purple">Partner fleet · {r.rider.fleetPartner}</span>
                  )}
                </p>
                <p className="text-xs text-s-muted">
                  Cash to collect: <span className="font-semibold text-s-text">{r.cashToCollectCents > 0 ? fmtPkrWhole(r.cashToCollectCents) : 'none'}</span>
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {r.codeLocked && <span className="s-badge-red">Code locked</span>}
                  {r.rerouted && (
                    <span className="s-badge-green">
                      Code sent to rider{r.rerouted.byName ? ` by ${r.rerouted.byName}` : ''} · {fmtWhen(r.rerouted.at)}
                    </span>
                  )}
                  {r.doorProblem && (
                    <span className="s-badge-red">{DOOR_LABEL[r.doorProblem.kind]} · {fmtWhen(r.doorProblem.at)}</span>
                  )}
                </div>
                {!r.codeOnly && (
                  <p className="text-[11px] text-s-muted">Code-only delivery is off for this company, so these actions are closed.</p>
                )}
                <div className="flex gap-2 flex-wrap pt-1">
                  <button disabled={!r.codeOnly} onClick={() => setSendFor(r)}
                    className="s-btn-primary text-xs disabled:opacity-50">
                    {r.rerouted ? 'Resend code to rider' : 'Send code to rider'}
                  </button>
                  <button disabled={!r.codeOnly} onClick={() => setReturnFor(r)}
                    className="s-btn-secondary text-xs disabled:opacity-50">Food came back</button>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* ── Recent log ── */}
        <section className="space-y-2">
          <h2 className="text-sm font-bold text-s-text">Recent overrides · last 14 days</h2>
          <div className="s-card divide-y divide-s-border">
            {data && data.recent.length === 0 && <p className="p-4 text-xs text-s-muted">Nothing yet.</p>}
            {data?.recent.map((e) => (
              <div key={e.id} className="p-3 text-xs flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <span className="text-s-text">
                  <span className="font-semibold">{e.type === 'returned' ? 'Food came back' : 'Code sent to rider'}</span>
                  {' · '}#{e.ref} · {formatBrandName(e.brand)}
                  {e.riderName ? ` · rider ${e.riderName}` : ''}
                  {e.actorName ? ` · by ${e.actorName}` : ''}
                </span>
                <span className="text-s-muted">{fmtWhen(e.at)}</span>
                {e.note && <span className="basis-full text-s-muted italic">{e.note}</span>}
              </div>
            ))}
          </div>
        </section>
      </div>

      {sendFor && <SendCodeDialog row={sendFor} onClose={() => { setSendFor(null); refresh() }} />}
      {returnFor && <ReturnDialog row={returnFor} onClose={() => { setReturnFor(null); refresh() }} />}
      {switchFor && <SwitchDialog company={switchFor} onClose={() => { setSwitchFor(null); refresh() }} />}
    </div>
  )
}

function SwitchDialog({ company, onClose }: { company: Company; onClose: () => void }) {
  const [reason, setReason] = useState('')
  const turnOn = !company.codeOnly
  const m = useMutation({
    mutationFn: () => api.put('/emergency-overrides/settings', { tenantId: company.tenantId, codeOnly: turnOn, reason: reason.trim() }),
    onSuccess: onClose,
  })
  const ok = reason.trim().length >= 10
  return (
    <Modal title={`${turnOn ? 'Switch on' : 'Switch off'} code-only delivery · ${company.name}`} onClose={onClose}>
      <p className="text-xs text-s-muted">{CODE_ONLY_EXPLAIN}</p>
      <label className="block text-xs font-medium text-s-text">
        Reason (required, 10 to 500 characters)
        <textarea className="s-input mt-1 w-full" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      {m.error && <p role="alert" className="text-xs text-s-red">{words(m.error)}</p>}
      <button disabled={!ok || m.isPending} onClick={() => m.mutate()} className="s-btn-primary w-full disabled:opacity-50">
        {m.isPending ? 'Saving…' : turnOn ? 'Switch on' : 'Switch off'}
      </button>
    </Modal>
  )
}

function SendCodeDialog({ row, onClose }: { row: RoadRow; onClose: () => void }) {
  const [reason, setReason] = useState('')
  const [hint, setHint] = useState<string | null>(null)
  // null = not sent from this dialog yet; true/false = did WhatsApp reach the rider.
  const [sentOk, setSentOk] = useState<boolean | null>(null)
  const [resentOk, setResentOk] = useState<boolean | null>(null)
  const base = `/emergency-overrides/orders/${row.orderId}/send-code-to-rider`
  const send = useMutation({
    mutationFn: () => api.post<{ ok: true; sentToRider: boolean; riderPhoneHint: string }>(base, { reason: reason.trim() }),
    onSuccess: (r) => { setHint(r.riderPhoneHint); setSentOk(r.sentToRider) },
  })
  const resend = useMutation({
    mutationFn: () => api.post<{ ok: true; sentToRider: boolean; riderPhoneHint?: string }>(`${base}/resend`, {}),
    onSuccess: (r) => { setResentOk(r.sentToRider); if (r.riderPhoneHint) setHint(r.riderPhoneHint) },
  })
  const already = !!row.rerouted || send.isSuccess
  const len = reason.trim().length
  return (
    <Modal title={`Send code to rider · #${row.ref}`} onClose={onClose}>
      <p className="text-xs text-s-muted">
        This makes a new code, so the customer's old one stops working, and sends it by WhatsApp to {row.rider.name}'s own phone.
        Once per order. Every send is reviewed.
      </p>
      {!already && (
        <>
          <label className="block text-xs font-medium text-s-text">
            Reason (10 to 300 characters)
            <textarea className="s-input mt-1 w-full" rows={3} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <button disabled={len < 10 || send.isPending} onClick={() => send.mutate()} className="s-btn-primary w-full disabled:opacity-50">
            {send.isPending ? 'Sending…' : 'Send code to rider'}
          </button>
        </>
      )}
      {send.error && <p role="alert" className="text-xs text-s-red">{words(send.error)}</p>}
      {already && (
        <div className="space-y-2">
          {sentOk === false && resentOk !== true ? (
            <p role="alert" className="text-sm text-s-red font-medium">
              The new code was made but WhatsApp did not reach {row.rider.name}{hint ? ` (${hint})` : ''} — use Resend.
            </p>
          ) : (
            <p className="text-sm text-success font-medium">
              Code sent to {row.rider.name}{hint ? ` (${hint})` : ''}.
            </p>
          )}
          <button disabled={resend.isPending} onClick={() => resend.mutate()} className="s-btn-secondary w-full disabled:opacity-50">
            {resend.isPending ? 'Resending…' : 'Resend the same code'}
          </button>
          {resentOk === true && <p className="text-xs text-success">Sent again.</p>}
          {resentOk === false && (
            <p role="alert" className="text-xs text-s-red">WhatsApp did not reach {row.rider.name} this time either. Try Resend again in a moment.</p>
          )}
          {resend.error && <p role="alert" className="text-xs text-s-red">{words(resend.error)}</p>}
        </div>
      )}
    </Modal>
  )
}

function ReturnDialog({ row, onClose }: { row: RoadRow; onClose: () => void }) {
  const [cause, setCause] = useState<Cause>('other')
  const [reason, setReason] = useState('')
  const [pin, setPin] = useState('')
  const [needPin, setNeedPin] = useState(false)
  const { data: preview } = useQuery({
    queryKey: ['emergency-overrides', 'preview', row.orderId],
    queryFn: () => api.get<Preview>(`/emergency-overrides/orders/${row.orderId}/return-preview`),
  })
  const m = useMutation({
    mutationFn: () => api.post<ReturnResult>(`/emergency-overrides/orders/${row.orderId}/food-returned`, {
      cause, reason: reason.trim(), ...(needPin && pin.trim() ? { managerOverridePin: pin.trim() } : {}),
    }),
    onError: (err) => { if (err instanceof ApiError && err.code === 'MANAGER_OVERRIDE_REQUIRED') setNeedPin(true) },
  })
  const res = m.data
  return (
    <Modal title={`Food came back · #${row.ref}`} onClose={onClose}>
      {res ? (
        <div className="space-y-2 text-sm">
          <p className="text-success font-medium">Logged as returned.</p>
          <p className="text-s-text">Waste cost: <span className="font-semibold">{fmtPkrWhole(res.wasteCostCents)}</span></p>
          {res.codVoidedCents > 0 && <p className="text-s-muted text-xs">Cash on delivery voided: {fmtPkrWhole(res.codVoidedCents)}</p>}
          {res.strike?.recorded && <p className="text-s-muted text-xs">A strike was recorded against the customer.</p>}
          {res.refundDueCents > 0 && (
            <p className="text-xs text-s-text">
              {fmtPkrWhole(res.refundDueCents)} is due back to the customer.{' '}
              <Link href={`/orders/${row.orderId}`} className="text-primary-ink underline">Open the order to hand it back</Link>
            </p>
          )}
          <button onClick={onClose} className="s-btn-primary w-full">Done</button>
        </div>
      ) : (
        <>
          <fieldset className="space-y-1.5">
            <legend className="text-xs font-medium text-s-text mb-1">Why did it come back?</legend>
            {CAUSES.map((c) => (
              <label key={c.id} className="flex items-start gap-2 text-sm text-s-text">
                <input type="radio" name="cause" className="mt-1" checked={cause === c.id} onChange={() => setCause(c.id)} />
                {c.label}
              </label>
            ))}
          </fieldset>
          <label className="block text-xs font-medium text-s-text">
            Reason (5 to 500 characters)
            <textarea className="s-input mt-1 w-full" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <div className="rounded-lg border border-s-border bg-s-bg-soft p-3 text-xs space-y-1">
            <p className="font-semibold text-s-text">What this will do</p>
            {!preview && <p className="text-s-muted">Loading…</p>}
            {preview && (
              <>
                <p className="text-s-muted">Booked as waste:</p>
                <ul className="list-disc pl-4 text-s-text">
                  {preview.lines.map((l, i) => <li key={i}>{l.quantity} × {l.name}</li>)}
                  {preview.lines.length === 0 && <li>No lines</li>}
                </ul>
                <p className="text-s-muted">
                  Cash on delivery voided: <span className="text-s-text font-medium">{fmtPkrWhole(preview.codToVoidCents)}</span>
                </p>
                {preview.paidCents > 0 && (
                  <p className="text-s-muted">Already paid: <span className="text-s-text font-medium">{fmtPkrWhole(preview.paidCents)}</span> — you will be pointed to the order to hand it back.</p>
                )}
              </>
            )}
          </div>
          {needPin && (
            <label className="block text-xs font-medium text-s-text">
              Manager PIN
              <input type="password" inputMode="numeric" autoComplete="off" className="s-input mt-1 w-full" maxLength={12}
                value={pin} onChange={(e) => setPin(e.target.value)} />
            </label>
          )}
          {m.error && <p role="alert" className="text-xs text-s-red">{words(m.error)}</p>}
          <button disabled={reason.trim().length < 5 || m.isPending || (needPin && !pin.trim())} onClick={() => m.mutate()}
            className="s-btn-primary w-full disabled:opacity-50">
            {m.isPending ? 'Saving…' : 'Log food as returned'}
          </button>
        </>
      )}
    </Modal>
  )
}
