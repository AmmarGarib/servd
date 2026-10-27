'use client'
import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { formatDistanceToNowStrict } from 'date-fns'
import { api } from '../../lib/api'
import { fmtPkrWhole } from '../../lib/money'
import { orderRef } from '../../lib/orderRef'
import { FIRE_ALL_EXTRA_ROLES, useManagerRoles } from '../../lib/roles'
import { useAuthStore } from '../../store/auth'
import { ArrowLeft, ArrowRight, Bell, BellOff } from 'lucide-react'
import { enableKdsSound, playNewOrderBeep, useKdsAudioState } from '../../hooks/useKdsSocket'
import { useKdsStore } from '../../store/kds'
import { CompactEmptyState } from '../../components/ui/CompactEmptyState'
import { BacklogStat, ReadyPrintControls, StickerSizeMenu, UnstartedAlert, stationQueueOf, useKitchenStatus } from '../../components/kds/ExpoKitchen'

/**
 * Expo — the pass-station's screen. Three columns:
 *
 *   1. Awaiting Fire (received) — confirm/reject. Each card shows
 *      fulfilmentType prominently so expo knows whether to expect a
 *      plate or a package coming out the other end.
 *   2. In Progress (preparing)  — live step counters (e.g. 3/5). Cards
 *      let expo glance the floor and know which orders are about to land.
 *   3. Ready                    — single big handoff button. Copy switches
 *      by fulfilmentType: "Serve to table", "Hand to rider", "Customer
 *      pickup".
 *
 * A till sale paid before its hand-off (a counter sale paid up front) sits in
 * the column its lines put it in with a PAID chip, until expo hands it off;
 * it has no Reject (the customer has paid — refunds go through the till).
 *
 * Per-station KDS screens (Grill, Fry, Pass) still drive the cook side;
 * Expo lives one level up.
 */

// Kitchen screens stay dark (.erp-kitchen-dark) and take their colours from
// the kds-* tokens (tailwind.config.ts) — never a hex in the page. Class
// names are spelled out in full so Tailwind keeps them.
const FULFILMENT_META = {
  dine_in:  {
    label: 'Dine-in', short: 'PLATE',
    chip: 'bg-kds-green/10 text-kds-green', text: 'text-kds-green', bar: 'bg-kds-green',
    border: 'border border-kds-green/25', ready: 'bg-kds-green/10 border-2 border-kds-green',
    button: 'bg-kds-green text-primary-on',
  },
  takeout:  {
    label: 'Takeout', short: 'PACK',
    chip: 'bg-kds-amber/10 text-kds-amber', text: 'text-kds-amber', bar: 'bg-kds-amber',
    border: 'border border-kds-amber/25', ready: 'bg-kds-amber/10 border-2 border-kds-amber',
    button: 'bg-kds-amber text-kds-bg',
  },
  delivery: {
    label: 'Delivery', short: 'PACK+LBL',
    chip: 'bg-kds-blue/10 text-kds-blue', text: 'text-kds-blue', bar: 'bg-kds-blue',
    border: 'border border-kds-blue/25', ready: 'bg-kds-blue/10 border-2 border-kds-blue',
    button: 'bg-kds-blue text-kds-text',
  },
} as const
type FulfilmentType = keyof typeof FULFILMENT_META

const HANDOFF_LABEL: Record<FulfilmentType, string> = {
  dine_in:  'Serve to table',
  takeout:  'Customer pickup',
  delivery: 'Hand to rider',
}

// Quick-pick rejection reasons. Ordered by frequency — 86 (out of an
// ingredient) is by far the most common, followed by kitchen overload
// and customer-side flags. Operator can still type a custom reason.
const REJECT_REASONS = [
  '86 — out of ingredient',
  '86 — out of dish',
  'Kitchen at capacity',
  'Allergen risk',
  'Wrong concept',
  'Closed for service',
  'Customer cancelled',
  'Suspected bad order',
] as const

const SOURCE_BADGE: Record<string, { label: string; cls: string }> = {
  servd:     { label: 'Storefront', cls: 'bg-kds-blue/15 text-kds-blue' },
  pos:       { label: 'POS',        cls: 'bg-kds-amber/15 text-kds-amber' },
  cart:      { label: 'Cart',       cls: 'bg-kds-green/15 text-kds-green' },
  manual:    { label: 'Manual',     cls: 'bg-white/5 text-kds-subtext' },
}

/** Column / counter tones — kds-* tokens only. */
type Tone = 'amber' | 'blue' | 'green' | 'neutral'
const TONE_TEXT: Record<Tone, string> = {
  amber: 'text-kds-amber', blue: 'text-kds-blue', green: 'text-kds-green', neutral: 'text-kds-subtext',
}
const TONE_BOX: Record<Tone, string> = {
  amber: 'bg-kds-amber/5 border border-kds-amber/20',
  blue: 'bg-kds-blue/5 border border-kds-blue/20',
  green: 'bg-kds-green/5 border border-kds-green/20',
  neutral: 'bg-white/5 border border-white/15',
}

/** Inline icons (no emoji as structural icons). */
function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  )
}
function WarnIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"
      className="inline-block align-[-2px] mr-1 shrink-0">
      <path d="M8 1.8l6.5 12H1.5z" /><path d="M8 6.3v3.6M8 11.6v.4" strokeLinecap="round" />
    </svg>
  )
}

interface ExpoOrder {
  id: string
  status: string
  source: string
  fulfilmentType: FulfilmentType
  placedAt: string
  customerName: string | null
  totalCents: number
  taxCents: number
  totalSteps: number
  doneSteps: number
  concept: { id: string; name: string; slug: string }
  customer: { id: string; name: string; phone: string | null } | null
  table:    { id: string; label: string } | null
  rider:    { id: string; name: string; phone: string | null } | null
  /** scheduledFireAt: a PACED line (still pending) the pacing worker fires at that time so the course plates together. */
  items: Array<{ id: string; name: string; quantity: number; notes: string | null; status: string; scheduledFireAt?: string | null }>
  /** Already paid at the till (a till sale completes at payment) — not handed off yet. */
  paid?: boolean
}

/** A pre-order before its prep window (GET /expo/queue `upcoming`): not the kitchen's yet. */
interface UpcomingOrder extends ExpoOrder {
  scheduledFor: string
  /** When it joins Awaiting Fire (scheduledFor minus the prep window). */
  kitchenAt: string
}

/** "Paid" chip for a till sale that was paid before expo handed it off: never send the customer back to the counter. */
function PaidBadge() {
  return (
    <span className="text-xs font-black uppercase tracking-wider px-2 py-0.5 rounded-md bg-kds-green/15 text-kds-green border border-kds-green/40"
      title="Paid at the till — hand it over, don't send the customer back to pay">
      Paid
    </span>
  )
}

interface PacedLine { id: string; name: string; scheduledFireAt: string }

/** Lines of an order still waiting for their paced fire time, earliest first. */
function pacedLines(order: ExpoOrder): PacedLine[] {
  return order.items
    .filter((i) => i.status === 'pending' && i.scheduledFireAt)
    .map((i) => ({ id: i.id, name: i.name, scheduledFireAt: i.scheduledFireAt! }))
    .sort((a, b) => a.scheduledFireAt.localeCompare(b.scheduledFireAt))
}

/** "14:59" in Pakistan time — when a paced line fires. */
function fireClock(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'Asia/Karachi', hour: '2-digit', minute: '2-digit', hour12: false })
}

/** Pakistan calendar day of an instant, for "is it today?". */
function pkDay(d: Date): string {
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' })
}

/** "19:30" today, or "Tue 14 Oct, 19:30" on another day (Pakistan time). */
function pkWhen(iso: string): string {
  const d = new Date(iso)
  if (pkDay(d) === pkDay(new Date())) return fireClock(iso)
  const day = d.toLocaleDateString('en-GB', { timeZone: 'Asia/Karachi', weekday: 'short', day: 'numeric', month: 'short' })
  return `${day}, ${fireClock(iso)}`
}

interface StationLoad {
  id: string
  name: string
  conceptSlug: string
  activeItems: number
}

interface ExpoQueue {
  awaitingFire: ExpoOrder[]
  inProgress:   ExpoOrder[]
  ready:        ExpoOrder[]
  /** Pre-orders not in their prep window yet (an older API leaves it out). */
  upcoming?:    UpcomingOrder[]
  stations:     StationLoad[]
}

export default function ExpoPage() {
  const qc = useQueryClient()
  const [rejecting, setRejecting] = useState<string | null>(null)
  const [rejectReason, setRejectReason] = useState('')

  const { data, isLoading } = useQuery<ExpoQueue>({
    queryKey: ['expo', 'queue'],
    queryFn:  () => api.get<ExpoQueue>('/expo/queue'),
    refetchInterval: 5_000,
    staleTime: 2_000,
  })
  // Backlog counter + the 60-second "not started" alert (owner B12).
  const { data: kitchen } = useKitchenStatus()

  // The new-order chime lives on expo only (owner 2026-10-27: "kitchen chime is ok, but expo only").
  // An order id not seen in the previous poll chimes once; the first load only sets the baseline.
  const soundEnabled = useKdsStore((s) => s.soundEnabled)
  const setSoundEnabled = useKdsStore((s) => s.setSoundEnabled)
  const audio = useKdsAudioState()
  const seenOrders = useRef<Set<string> | null>(null)
  useEffect(() => {
    if (!data) return
    const ids = [...data.awaitingFire, ...data.inProgress, ...data.ready].map((o) => o.id)
    const seen = seenOrders.current
    if (seen && soundEnabled && ids.some((id) => !seen.has(id))) playNewOrderBeep()
    seenOrders.current = new Set([...(seen ?? []), ...ids])
  }, [data, soundEnabled])

  // Toast for items that fired but have no live station (none assigned, or
  // the station was retired). Surfaces the 'I clicked Fire and nothing
  // happened at the line' confusion — the order DID fire, those specific
  // items just aren't routed. Stays up for 8s so the operator can read the names.
  const [unroutedToast, setUnroutedToast] = useState<Array<{ id: string; name: string }>>([])
  useEffect(() => {
    if (unroutedToast.length === 0) return
    const t = setTimeout(() => setUnroutedToast([]), 8_000)
    return () => clearTimeout(t)
  }, [unroutedToast])

  // Fire sends the first course only; later courses wait to be fired from
  // the order's Courses page. Tell expo which courses are still held.
  const [heldNotice, setHeldNotice] = useState<{ orderId: string; courses: number[] } | null>(null)
  useEffect(() => {
    if (!heldNotice) return
    const t = setTimeout(() => setHeldNotice(null), 8_000)
    return () => clearTimeout(t)
  }, [heldNotice])

  // Course pacing: Fire starts the longest dish of the course now; shorter
  // ones come back as `paced` and the pacing worker fires them at their time
  // so the course plates together. Tell expo when they will fire.
  const [pacedNotice, setPacedNotice] = useState<{ orderId: string; lines: PacedLine[] } | null>(null)
  useEffect(() => {
    if (!pacedNotice) return
    const t = setTimeout(() => setPacedNotice(null), 10_000)
    return () => clearTimeout(t)
  }, [pacedNotice])

  // Who may override course pacing ("Fire all now") — the server's
  // FIRE_ALL_ROLES: the managers list (served by the API) + the expediter.
  const role = useAuthStore((s) => s.user?.role ?? '')
  const canFireAll = useManagerRoles(...FIRE_ALL_EXTRA_ROLES).has(role)

  // An action the server refused (the order moved on — e.g. 409
  // INVALID_TRANSITION / NOTHING_TO_FIRE / FIRE_ALL_NOT_ALLOWED). Without it
  // the button just re-enabled and expo believed the dishes went to the line.
  const [actionError, setActionError] = useState<string | null>(null)
  const failed = (what: string) => (e: Error) => {
    setActionError(`${what}: ${e.message || 'the server refused it'}`)
    void qc.invalidateQueries({ queryKey: ['expo'] })
  }

  const fire = useMutation({
    mutationFn: (orderId: string) =>
      api.post<{ ok: true; fired: number; course: number | null; paced?: PacedLine[]; heldCourses?: number[]; unroutedItems: Array<{ id: string; name: string }> }>(
        `/expo/orders/${orderId}/fire`, {},
      ),
    onSuccess: (resp, orderId) => {
      if (resp?.paced && resp.paced.length > 0) {
        setPacedNotice({ orderId, lines: resp.paced })
      }
      if (resp?.unroutedItems && resp.unroutedItems.length > 0) {
        setUnroutedToast(resp.unroutedItems)
      }
      if (resp?.heldCourses && resp.heldCourses.length > 0) {
        setHeldNotice({ orderId, courses: resp.heldCourses })
      }
      void qc.invalidateQueries({ queryKey: ['expo'] })
    },
    onMutate: () => setActionError(null),
    onError: failed('Could not fire the order'),
  })

  // "Fire all now": override pacing — every pending line of the course fires
  // at once (manager tiers and the expediter; audited server-side).
  const fireAll = useMutation({
    mutationFn: (orderId: string) => api.post(`/expo/orders/${orderId}/fire`, { fireAll: true }),
    onSuccess: () => {
      setPacedNotice(null)
      void qc.invalidateQueries({ queryKey: ['expo'] })
    },
    onMutate: () => setActionError(null),
    onError: failed('Could not fire the paced dishes'),
  })

  const reject = useMutation({
    mutationFn: ({ orderId, reason }: { orderId: string; reason: string }) =>
      api.post(`/expo/orders/${orderId}/reject`, { reason }),
    onSuccess: () => {
      setRejecting(null); setRejectReason('')
      void qc.invalidateQueries({ queryKey: ['expo'] })
    },
    onMutate: () => setActionError(null),
    onError: failed('Could not reject the order'),
  })

  const handoff = useMutation({
    mutationFn: (orderId: string) => api.post(`/expo/orders/${orderId}/handoff`, {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['expo'] }),
    onMutate: () => setActionError(null),
    onError: failed('Could not hand off the order'),
  })

  const awaitingFire = data?.awaitingFire ?? []
  const inProgress   = data?.inProgress ?? []
  const ready        = data?.ready ?? []
  const stations     = data?.stations ?? []
  // Soonest to reach the kitchen first.
  const upcoming     = [...(data?.upcoming ?? [])].sort((a, b) => a.kitchenAt.localeCompare(b.kitchenAt))

  const stationsByConcept = stations.reduce<Record<string, StationLoad[]>>((acc, s) => {
    (acc[s.conceptSlug] ??= []).push(s); return acc
  }, {})

  return (
    <div className="erp-kitchen-dark h-screen h-dvh overflow-y-auto bg-kds-bg">
      {/* Unrouted-items toast — fires when the order was confirmed but some
          items have no station, so the line will never see them. */}
      {unroutedToast.length > 0 && (
        <div role="alert" className="fixed top-4 right-4 z-50 max-w-sm rounded-xl p-4 pr-8 shadow-2xl bg-kds-card border border-kds-amber">
          <p className="text-sm font-black text-kds-amber"><WarnIcon />Fired, but {unroutedToast.length} item{unroutedToast.length === 1 ? '' : 's'} have no live station</p>
          <p className="text-xs text-kds-subtext mt-1">
            The line won't see these because their menu item has no station, or its station was retired. Open Menu Editor → Edit item → pick a station.
          </p>
          <ul className="mt-2 space-y-0.5">
            {unroutedToast.slice(0, 6).map((it) => (
              <li key={it.id} className="text-xs text-white/85">· {it.name}</li>
            ))}
            {unroutedToast.length > 6 && (
              <li className="text-xs text-white/50">+ {unroutedToast.length - 6} more</li>
            )}
          </ul>
          <button onClick={() => setUnroutedToast([])} aria-label="Dismiss"
            className="absolute top-0 right-0 flex h-11 w-11 items-center justify-center text-kds-subtext hover:text-kds-text"><CloseIcon /></button>
        </div>
      )}
      {heldNotice && (
        <div className={`fixed right-4 z-50 max-w-sm rounded-xl p-4 shadow-2xl bg-kds-card border border-kds-blue ${unroutedToast.length > 0 ? 'top-48' : 'top-4'}`}>
          <p className="text-sm font-black text-kds-text">
            First course fired. Course{heldNotice.courses.length === 1 ? '' : 's'} {heldNotice.courses.join(', ')} held
          </p>
          <p className="text-xs text-kds-subtext mt-1">
            Fire the next course when the table is ready, from the order&apos;s{' '}
            <Link href={`/orders/${heldNotice.orderId}/courses`} className="underline text-kds-blue">Courses</Link> page.
          </p>
          <button onClick={() => setHeldNotice(null)} aria-label="Dismiss"
            className="absolute top-0 right-0 flex h-11 w-11 items-center justify-center text-kds-subtext hover:text-kds-text"><CloseIcon /></button>
        </div>
      )}
      {actionError && (
        <div role="alert" className="fixed bottom-4 left-4 z-50 max-w-sm rounded-xl p-4 pr-8 shadow-2xl bg-kds-card border border-kds-red">
          <p className="text-sm font-black text-kds-red">Not done</p>
          <p className="text-xs text-kds-subtext mt-1">{actionError}</p>
          <button onClick={() => setActionError(null)} aria-label="Dismiss"
            className="absolute top-0 right-0 flex h-11 w-11 items-center justify-center text-kds-subtext hover:text-kds-text"><CloseIcon /></button>
        </div>
      )}
      {pacedNotice && (
        <div className="fixed bottom-4 right-4 z-50 max-w-sm rounded-xl p-4 shadow-2xl bg-kds-card border border-kds-blue">
          <p className="text-sm font-black text-kds-text">Fired — paced so the course plates together</p>
          <ul className="mt-1 space-y-0.5">
            {pacedNotice.lines.map((l) => (
              <li key={l.id} className="text-xs text-kds-subtext">{l.name} fires at {fireClock(l.scheduledFireAt)}</li>
            ))}
          </ul>
          {canFireAll && (
            <button onClick={() => fireAll.mutate(pacedNotice.orderId)} disabled={fireAll.isPending}
              className="mt-2 min-h-11 rounded-lg px-3 py-1.5 text-xs font-black border border-kds-blue text-kds-blue disabled:opacity-40">
              Fire all now
            </button>
          )}
          <button onClick={() => setPacedNotice(null)} aria-label="Dismiss"
            className="absolute top-0 right-0 flex h-11 w-11 items-center justify-center text-kds-subtext hover:text-kds-text"><CloseIcon /></button>
        </div>
      )}
      {soundEnabled && audio === 'suspended' && (
        <button type="button" onClick={enableKdsSound}
          className="flex min-h-11 w-full items-center justify-center gap-2 border-b border-kds-amber/40 bg-kds-amber/15 px-4 text-sm font-bold text-kds-amber">
          Tap to enable sound. New-order chimes stay silent until you do.
        </button>
      )}
      <header className="px-6 py-4 border-b border-white/5">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <Link href="/w" className="mb-1 inline-flex min-h-11 items-center gap-1.5 text-xs font-bold text-kds-subtext hover:text-kds-text">
              <ArrowLeft size={16} aria-hidden="true" /> Workspace
            </Link>
            <h1 className="text-2xl font-black text-white/95">Expo Station</h1>
            <p className="text-xs text-white/45 mt-0.5">
              Confirm incoming → watch progress → hand off ready.
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <BacklogStat status={kitchen} />
            <Stat label="Awaiting" count={awaitingFire.length} tone="amber" />
            <Stat label="In progress" count={inProgress.length} tone="blue" />
            <Stat label="Ready" count={ready.length} tone="green" />
            {upcoming.length > 0 && <Stat label="Pre-orders" count={upcoming.length} tone="neutral" />}
            <StickerSizeMenu />
            <button type="button" onClick={() => setSoundEnabled(!soundEnabled)}
              title={soundEnabled ? 'Mute new-order chime' : 'Unmute new-order chime'}
              aria-label="New-order chime" aria-pressed={soundEnabled}
              className={`flex min-h-11 min-w-11 items-center justify-center rounded-lg border px-3 transition-colors ${
                soundEnabled ? 'border-kds-green bg-kds-green text-primary-on' : 'border-kds-border text-kds-subtext hover:text-kds-text'}`}>
              {soundEnabled ? <Bell size={20} aria-hidden="true" /> : <BellOff size={20} aria-hidden="true" />}
            </button>
          </div>
        </div>
      </header>
      <UnstartedAlert status={kitchen} />

      {/* ── Upcoming pre-orders ─────────────────────────────────────────
          Scheduled orders before their prep window. The server holds them
          (no kitchen ticket, no stock taken) and moves them to Awaiting
          Fire when their time comes — so no Fire button here. */}
      {upcoming.length > 0 && (
        <section className="px-6 pt-5 space-y-3">
          <SectionHeader title="Upcoming pre-orders" count={upcoming.length} tone="neutral" />
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
            {upcoming.map((order) => {
              const fm = FULFILMENT_META[order.fulfilmentType]
              const live = order.items.filter((it) => it.status !== 'voided')
              return (
                <article key={order.id} className={`rounded-2xl p-3.5 ${TONE_BOX.neutral}`}>
                  <p className="text-sm font-black text-white/90">
                    Pre-order for {pkWhen(order.scheduledFor)} — reaches the kitchen at {pkWhen(order.kitchenAt)}
                  </p>
                  <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                    <span className={`text-xs font-black uppercase tracking-wider px-2 py-0.5 rounded-md ${fm.chip}`}>
                      {fm.label}
                    </span>
                    {order.paid && <PaidBadge />}
                    <span className="text-xs text-white/55">
                      {order.customer?.name ?? order.customerName ?? 'Walk-in'} · {order.concept.name}
                    </span>
                    <span className="text-xs text-white/30 font-mono ml-auto">#{orderRef(order.id)}</span>
                  </div>
                  <p className="text-xs text-white/45 mt-1.5">
                    {live.map((it) => `${it.quantity}× ${it.name}`).join(' · ')}
                  </p>
                </article>
              )
            })}
          </div>
        </section>
      )}

      <div className="px-6 py-5 grid grid-cols-1 lg:grid-cols-3 xl:grid-cols-[1fr_1fr_1fr_280px] gap-4">

        {/* ── Awaiting Fire ───────────────────────────────────────────── */}
        <section className="space-y-3">
          <SectionHeader title="Awaiting Fire" count={awaitingFire.length} tone="amber" />

          {isLoading && <div className="text-sm text-white/40">Loading…</div>}

          {!isLoading && awaitingFire.length === 0 && (
            <EmptyState text="Queue clear" sub="New orders appear here for confirmation." />
          )}

          {awaitingFire.map((order) => {
            const fm = FULFILMENT_META[order.fulfilmentType]
            const src = SOURCE_BADGE[order.source] ?? SOURCE_BADGE.manual!
            const isRejecting = rejecting === order.id
            return (
              <article key={order.id} className={`rounded-2xl p-4 bg-white/[0.025] ${fm.border}`}>

                {/* Fulfilment banner — the loudest thing on the card */}
                <div className="flex items-center justify-between mb-3 -mt-1 -mx-1">
                  <span className={`text-xs font-black uppercase tracking-[0.2em] px-3 py-1 rounded-md ${fm.chip}`}>
                    {fm.label} · {fm.short}
                  </span>
                  <span className="text-xs text-white/35">
                    {formatDistanceToNowStrict(new Date(order.placedAt), { addSuffix: true })}
                  </span>
                </div>

                {/* Source + table + customer */}
                <div className="flex items-center gap-2 mb-2 flex-wrap">
                  <span className={`text-xs font-black uppercase tracking-wider px-2 py-0.5 rounded-md ${src.cls}`}>
                    {src.label}
                  </span>
                  {order.paid && <PaidBadge />}
                  <span className="text-xs text-white/45">{order.concept.name}</span>
                  {order.table && (
                    <span className="text-xs font-bold rounded-md px-2 py-0.5 bg-kds-green/10 text-kds-green">
                      Table {order.table.label}
                    </span>
                  )}
                  <span className="text-xs text-white/30 font-mono ml-auto">#{orderRef(order.id)}</span>
                </div>

                <div className="flex items-baseline gap-3 mb-2">
                  <p className="font-bold text-white/90">{order.customer?.name ?? order.customerName ?? 'Walk-in'}</p>
                  {order.customer?.phone && <p className="text-xs text-white/40">{order.customer.phone}</p>}
                  <p className="ml-auto text-sm font-black text-kds-green">{fmtPkrWhole(order.totalCents)}</p>
                </div>

                <div className="space-y-1 mb-4">
                  {order.items.map((it) => (
                    <div key={it.id} className="flex items-baseline gap-2 text-[13px]">
                      <span className="font-bold text-white/55 tabular-nums w-6">{it.quantity}×</span>
                      <span className="text-white/85 flex-1">{it.name}</span>
                      {it.notes && <span className="text-xs text-kds-amber italic">{it.notes}</span>}
                    </div>
                  ))}
                </div>

                {!isRejecting ? (
                  <div className="flex gap-2">
                    {/* A paid till sale can't be rejected — the customer has
                        paid; a refund goes through the till. */}
                    {!order.paid && (
                      <button onClick={() => setRejecting(order.id)} disabled={reject.isPending}
                        className="min-h-11 rounded-xl px-4 text-xs font-bold transition-colors disabled:opacity-40 bg-kds-red/10 text-kds-red border border-kds-red/25">
                        Reject
                      </button>
                    )}
                    <button onClick={() => fire.mutate(order.id)} disabled={fire.isPending}
                      className="flex-1 min-h-11 rounded-xl text-sm font-black transition-all disabled:opacity-40 bg-kds-green text-primary-on">
                      {fire.isPending && fire.variables === order.id ? 'Firing…' : 'Fire'}
                    </button>
                  </div>
                ) : (
                  <form className="space-y-2" onSubmit={(e) => {
                    e.preventDefault()
                    if (rejectReason.trim() && !reject.isPending) reject.mutate({ orderId: order.id, reason: rejectReason })
                  }}>
                    {/* Quick-reason chips — most rejects on the pass fall into
                        a handful of buckets. Tap a chip → the reason fills in,
                        edit before confirming if needed. Saves the expo from
                        typing "86 sea bass" 12 times a service. */}
                    <div className="flex flex-wrap gap-1.5">
                      {REJECT_REASONS.map((preset) => (
                        <button
                          key={preset}
                          type="button"
                          onClick={() => setRejectReason(preset)}
                          className={`text-xs font-bold rounded-full px-3 min-h-11 transition-colors border ${rejectReason === preset
                            ? 'bg-kds-red/20 text-kds-red border-kds-red/50'
                            : 'bg-white/[0.04] text-white/60 border-white/10'}`}>
                          {preset}
                        </button>
                      ))}
                    </div>
                    <input value={rejectReason} onChange={(e) => setRejectReason(e.target.value)}
                      autoFocus aria-label="Reject reason" autoComplete="off" enterKeyHint="send"
                      onKeyDown={(e) => { if (e.key === 'Escape') { setRejecting(null); setRejectReason('') } }}
                      placeholder="…or type a custom reason"
                      className="w-full min-h-11 rounded-lg px-3 py-2 text-sm font-semibold focus:outline-none bg-black/40 border border-kds-red/20 text-white/90" />
                    <div className="flex gap-2">
                      <button type="button" onClick={() => { setRejecting(null); setRejectReason('') }}
                        className="min-h-11 rounded-lg px-4 text-xs font-bold transition-colors bg-white/[0.04] text-white/60">
                        Cancel
                      </button>
                      <button type="submit"
                        disabled={!rejectReason.trim() || reject.isPending}
                        className="flex-1 min-h-11 rounded-lg text-xs font-black transition-colors disabled:opacity-40 bg-kds-red text-kds-text">
                        Confirm reject
                      </button>
                    </div>
                  </form>
                )}
              </article>
            )
          })}
        </section>

        {/* ── In Progress ─────────────────────────────────────────────── */}
        <section className="space-y-3">
          <SectionHeader title="In Progress" count={inProgress.length} tone="blue" />

          {!isLoading && inProgress.length === 0 && (
            <EmptyState text="Nothing cooking" sub="Fired orders appear here with live step counts." />
          )}

          {inProgress.map((order) => {
            const fm = FULFILMENT_META[order.fulfilmentType]
            const pct = order.totalSteps > 0 ? Math.round((order.doneSteps / order.totalSteps) * 100) : 0
            const paced = pacedLines(order)
            return (
              <article key={order.id} className={`rounded-2xl p-3.5 bg-white/[0.02] ${fm.border}`}>
                <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
                  <span className={`text-xs font-black uppercase tracking-wider px-2 py-0.5 rounded-md ${fm.chip}`}>
                    {fm.label} · {fm.short}
                  </span>
                  {order.table && (
                    <span className="text-xs font-bold text-kds-green">Table {order.table.label}</span>
                  )}
                  {order.paid && <PaidBadge />}
                  <span className="text-xs text-white/40 ml-auto">
                    {formatDistanceToNowStrict(new Date(order.placedAt), { addSuffix: false })}
                  </span>
                </div>
                <p className="font-bold text-white/90 text-sm mb-1">
                  {order.customer?.name ?? order.customerName ?? 'Walk-in'} · {order.concept.name}
                </p>
                <p className="text-xs text-white/45 mb-2">
                  {order.items.length} item{order.items.length === 1 ? '' : 's'} · #{orderRef(order.id)}
                </p>

                {/* Step progress */}
                <div className="space-y-1.5">
                  <div className="flex items-baseline justify-between text-xs font-bold">
                    <span className="text-white/55">Steps</span>
                    <span className={`tabular-nums ${fm.text}`}>
                      {order.doneSteps} / {order.totalSteps}
                    </span>
                  </div>
                  <div className="h-1.5 rounded-full overflow-hidden bg-white/[0.06]">
                    <div className={`h-full transition-all duration-500 ${fm.bar}`}
                      style={{ width: `${pct}%` }} />
                  </div>
                </div>

                {/* Paced lines: shorter dishes the pacing worker fires later
                    so the course plates together. */}
                {paced.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {paced.map((l) => (
                      <p key={l.id} className="text-xs text-white/60">
                        <span className="font-bold text-white/80">{l.name}</span> fires at {fireClock(l.scheduledFireAt)}
                      </p>
                    ))}
                    {canFireAll && (
                      <button onClick={() => fireAll.mutate(order.id)} disabled={fireAll.isPending}
                        className="w-full min-h-11 rounded-lg py-1.5 text-xs font-black border border-white/15 text-white/80 disabled:opacity-40">
                        Fire all now
                      </button>
                    )}
                  </div>
                )}
              </article>
            )
          })}
        </section>

        {/* ── Ready ────────────────────────────────────────────────────── */}
        <section className="space-y-3">
          <SectionHeader title="Ready" count={ready.length} tone="green" />

          {!isLoading && ready.length === 0 && (
            <EmptyState text="Nothing ready yet" sub="Completed cooks land here for handoff." />
          )}

          {ready.map((order) => {
            const fm = FULFILMENT_META[order.fulfilmentType]
            return (
              <article key={order.id} className={`rounded-2xl p-4 ${fm.ready}`}>
                {/* Loud fulfilment banner — cook + expo + server all see this */}
                <div className="flex items-center justify-between mb-3">
                  <span className={`text-sm font-black uppercase tracking-[0.18em] ${fm.text}`}>
                    {fm.label}
                  </span>
                  <span className="flex items-center gap-2">
                    {order.paid && <PaidBadge />}
                    <span className="text-xs text-white/40 font-mono">#{orderRef(order.id)}</span>
                  </span>
                </div>

                <p className="font-bold text-white/95 text-base mb-1">
                  {order.customer?.name ?? order.customerName ?? 'Walk-in'}
                </p>
                <div className="text-xs text-white/55 mb-3 space-y-0.5">
                  <p>{order.concept.name} · {order.items.length} item{order.items.length === 1 ? '' : 's'}</p>
                  {order.fulfilmentType === 'dine_in' && order.table && (
                    <p className="flex items-center gap-1 text-kds-green"><ArrowRight size={12} aria-hidden="true" /> Table {order.table.label}</p>
                  )}
                  {order.fulfilmentType === 'delivery' && order.rider && (
                    <p className="flex items-center gap-1 text-kds-blue"><ArrowRight size={12} aria-hidden="true" /> {order.rider.name} ({order.rider.phone ?? 'no phone'})</p>
                  )}
                  {order.fulfilmentType === 'delivery' && !order.rider && (
                    <p className="text-kds-red"><WarnIcon />No rider assigned yet</p>
                  )}
                </div>

                <ReadyPrintControls orderId={order.id} paid={!!order.paid} />

                <button onClick={() => handoff.mutate(order.id)} disabled={handoff.isPending}
                  className={`w-full min-h-11 rounded-xl py-3 text-sm font-black transition-all disabled:opacity-40 ${fm.button}`}>
                  {handoff.isPending && handoff.variables === order.id ? 'Handing off…' : HANDOFF_LABEL[order.fulfilmentType]}
                </button>
              </article>
            )
          })}
        </section>

        {/* ── Sidebar: station load ───────────────────────────────────── */}
        <aside>
          <h2 className="text-xs uppercase tracking-[0.2em] font-black text-white/40 mb-3">
            Station load
          </h2>
          {Object.entries(stationsByConcept).map(([slug, list]) => (
            <div key={slug} className="mb-5">
              <p className="text-xs uppercase tracking-wider font-black text-white/45 mb-2 capitalize">{slug}</p>
              <div className="space-y-1.5">
                {list.map((s) => {
                  const busy = s.activeItems > 0
                  const q = stationQueueOf(kitchen, s.id)
                  return (
                    <Link key={s.id} href={`/kds/${s.id}`}
                      className={`flex min-h-11 items-center gap-3 rounded-lg px-3 py-2 transition-colors border ${busy
                        ? 'bg-kds-amber/5 border-kds-amber/20' : 'bg-white/[0.02] border-white/5'}`}>
                      <span className={`text-xs font-bold flex-1 ${busy ? 'text-kds-amber' : 'text-white/75'}`}>
                        {s.name}
                      </span>
                      {q && q.queued > 0 && (
                        <span className="rounded-md bg-kds-red/15 px-1.5 py-0.5 text-xs font-black text-kds-red tabular-nums" title="Orders waiting behind the cook's screen">
                          +{q.queued} waiting
                        </span>
                      )}
                      <span className={`text-sm font-black tabular-nums ${busy ? 'text-kds-amber' : 'text-white/30'}`}>
                        {s.activeItems}
                      </span>
                    </Link>
                  )
                })}
              </div>
            </div>
          ))}
        </aside>
      </div>
    </div>
  )
}

function Stat({ label, count, tone }: { label: string; count: number; tone: Tone }) {
  return (
    <div className={`rounded-xl px-3 py-2 text-center min-w-[80px] ${TONE_BOX[tone]} ${TONE_TEXT[tone]}`}>
      <p className="text-xs uppercase tracking-wider font-black">{label}</p>
      <p className="text-xl font-black leading-none mt-0.5 tabular-nums">{count}</p>
    </div>
  )
}

function SectionHeader({ title, count, tone }: { title: string; count: number; tone: Tone }) {
  return (
    <div className={`flex items-baseline justify-between ${TONE_TEXT[tone]}`}>
      <h2 className="text-xs uppercase tracking-[0.2em] font-black">
        {title}
      </h2>
      <span className="text-xs font-black tabular-nums opacity-70">{count}</span>
    </div>
  )
}

function EmptyState({ text, sub }: { text: string; sub: string }) {
  return (
    <CompactEmptyState tone="dark" message={text} detail={sub} />
  )
}
