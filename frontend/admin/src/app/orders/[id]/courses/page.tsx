'use client'

// Course controls for an order. Items are grouped by course; the kitchen
// fires course 2 only after course 1 is done eating. Server hits "Fire
// course N" to flip those items from pending → preparing.
//
// Rules the API enforces (POST /orders/:id/fire-course):
//  - An order expo has not fired yet ('received') can't fire any course here
//    (409 FIRE_FROM_EXPO) — expo's Confirm & Fire starts it.
//  - The first course is PACED: only the dishes due now fire; the rest come
//    back as `paced` with their fire time, and the pacing worker fires them
//    then so the course plates together. The course is not fully fired until
//    those lines go too.
//  - "Fire all now" ({ course, fireAll: true }) overrides the pacing — managers
//    and the expediter only (403 FIRE_ALL_NOT_ALLOWED otherwise).
//
// Pre-orders: one scheduled beyond the prep window is HELD (no kitchen ticket,
// no stock taken) until an hour before its time — even once acknowledged
// ('confirmed'). The server releases it on any fire, so while it is held this
// page offers no Fire: it says when the order reaches the kitchen. A manager or
// the expediter may still send an acknowledged pre-order early, behind a
// confirm step. A held 'received' pre-order joins expo's Awaiting Fire at its
// kitchen time and is fired from there.

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { api } from '../../../../lib/api'
import { useAuthStore } from '../../../../store/auth'
import { FIRE_ALL_EXTRA_ROLES, useManagerRoles } from '../../../../lib/roles'

interface CourseItem {
  id: string
  name: string
  quantity: number
  status: string
  firedAt: string | null
  completedAt: string | null
  /** A paced line's fire time (an older API leaves it out). */
  scheduledFireAt?: string | null
}

interface CourseGroup {
  course: number
  fired: boolean
  complete: boolean
  items: CourseItem[]
}

interface PacedLine { id: string; name: string; scheduledFireAt: string }

interface FireCourseResponse {
  ok: true
  fired: number
  course: number
  paced?: PacedLine[]
  unroutedItems?: Array<{ id: string; name: string }>
}

/** How long before a pre-order's time it reaches the kitchen — the server's PRE_ORDER_PREP_MS. */
const PRE_ORDER_PREP_MS = 60 * 60_000

interface OrderDetail {
  id: string
  status: string
  /** A pre-order's time (null for an order for now). */
  scheduledFor: string | null
  createdAt: string
}

/** Orders that ended without food going out — nothing left to fire. */
const ENDED = ['cancelled', 'rejected', 'refunded']

/** "14:59" in Pakistan time — when a paced line fires. */
function pkClock(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', {
    timeZone: 'Asia/Karachi', hour: '2-digit', minute: '2-digit', hour12: false,
  })
}

/** Pakistan calendar day of an instant, for "is it today?". */
function pkDay(d: Date): string {
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Karachi' })
}

/** "19:30" today, or "Tue 14 Oct, 19:30" on another day (Pakistan time) — same as expo. */
function pkWhen(iso: string): string {
  const d = new Date(iso)
  if (pkDay(d) === pkDay(new Date())) return pkClock(iso)
  const day = d.toLocaleDateString('en-GB', { timeZone: 'Asia/Karachi', weekday: 'short', day: 'numeric', month: 'short' })
  return `${day}, ${pkClock(iso)}`
}

/** A line still waiting to be fired (never fired, not voided). */
function waiting(it: CourseItem): boolean {
  return it.status === 'pending' && !it.firedAt
}

/**
 * The course's paced lines — waiting lines with a fire time, earliest first.
 * Read from the server (GET /orders/:id/courses → scheduledFireAt) once part
 * of the course has fired, so a reload keeps "fires at HH:MM"; the last fire
 * response (`fromFire`) fills in for an older API without the field.
 */
function pacedLinesOf(g: CourseGroup, fromFire: PacedLine[]): PacedLine[] {
  const waitingLines = g.items.filter(waiting)
  const waitingIds = new Set(waitingLines.map((i) => i.id))
  const byId = new Map<string, PacedLine>()
  if (g.fired) {
    for (const it of waitingLines) {
      if (it.scheduledFireAt) byId.set(it.id, { id: it.id, name: it.name, scheduledFireAt: it.scheduledFireAt })
    }
  }
  for (const l of fromFire) if (waitingIds.has(l.id) && !byId.has(l.id)) byId.set(l.id, l)
  return [...byId.values()].sort((a, b) => a.scheduledFireAt.localeCompare(b.scheduledFireAt))
}

export default function CoursePage() {
  const { id } = useParams<{ id: string }>()
  const qc = useQueryClient()
  const role = useAuthStore((s) => s.user?.role ?? '')
  // Who may override course pacing ("Fire all now") — the server's
  // FIRE_ALL_ROLES: the managers list (served by the API) + the expediter.
  const canFireAll = useManagerRoles(...FIRE_ALL_EXTRA_ROLES).has(role)

  const [error, setError] = useState<string | null>(null)
  // Two-step "send this pre-order to the kitchen early" (managers / expediter).
  const [confirmEarly, setConfirmEarly] = useState(false)
  // Paced lines the last fire returned, per course — only a bridge until the
  // courses summary refetches: it carries each line's scheduledFireAt, so the
  // fire times survive a reload. Lines drop off as the pacing worker fires them.
  const [pacedByCourse, setPacedByCourse] = useState<Record<number, PacedLine[]>>({})

  const { data, isLoading } = useQuery({
    queryKey: ['order-courses', id],
    queryFn: () => api.get<CourseGroup[]>(`/orders/${id}/courses`),
    refetchInterval: 5000,
  })

  // The order's status decides whether courses can be fired here at all.
  const { data: order } = useQuery({
    queryKey: ['order-detail', id],
    queryFn: () => api.get<OrderDetail>(`/orders/${id}`),
    refetchInterval: 5000,
  })
  const status = order?.status
  const notFired = status === 'received'
  const ended = status ? ENDED.includes(status) : false

  // A HELD pre-order: placed for a time beyond the prep window, the window has
  // not opened yet, and nothing of it has been fired (any fire releases it).
  const scheduledFor = order?.scheduledFor ?? null
  const kitchenAtMs = scheduledFor ? new Date(scheduledFor).getTime() - PRE_ORDER_PREP_MS : null
  const kitchenAt = kitchenAtMs !== null ? new Date(kitchenAtMs).toISOString() : null
  const heldAtCreation = !!scheduledFor && !!order
    && new Date(scheduledFor).getTime() > new Date(order.createdAt).getTime() + PRE_ORDER_PREP_MS
  const anyFired = (data ?? []).some((g) => g.items.some((i) => i.firedAt || (i.status !== 'pending' && i.status !== 'voided')))
  const held = heldAtCreation && kitchenAtMs !== null && kitchenAtMs > Date.now()
    && (status === 'received' || status === 'confirmed') && !anyFired
  // Early send: an acknowledged pre-order only ('received' goes through expo).
  const canFireEarly = held && status === 'confirmed' && canFireAll

  const fire = useMutation({
    mutationFn: (v: { course: number; fireAll?: boolean }) =>
      api.post<FireCourseResponse>(`/orders/${id}/fire-course`, v.fireAll ? { course: v.course, fireAll: true } : { course: v.course }),
    onMutate: () => setError(null),
    onSuccess: (resp, v) => {
      setConfirmEarly(false)
      setPacedByCourse((prev) => ({ ...prev, [v.course]: v.fireAll ? [] : (resp?.paced ?? []) }))
      void qc.invalidateQueries({ queryKey: ['order-courses', id] })
      void qc.invalidateQueries({ queryKey: ['order-detail', id] })
    },
    onError: (e: Error) => setError(e.message || 'Could not fire the course'),
  })

  // The first course with a live (non-voided) line — the one the server paces.
  const firstCourse = (data ?? [])
    .filter((g) => g.items.some((i) => i.status !== 'voided'))
    .reduce<number | null>((min, g) => (min === null || g.course < min ? g.course : min), null)

  return (
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-6 py-4">
        <Link href={`/orders/${id}`} className="text-xs text-s-muted hover:text-s-text">← Order</Link>
        <h1 className="text-xl font-bold text-s-text">Course controls</h1>
        <p className="text-xs text-s-muted">Fire courses one at a time so the kitchen paces with the table.</p>
      </header>

      <div className="p-6 max-w-3xl mx-auto space-y-3">
        {isLoading && <p className="text-s-muted text-sm">Loading…</p>}

        {held && scheduledFor && kitchenAt && (
          <div className="s-card px-4 py-3 text-sm space-y-2">
            <div>
              <p className="font-bold text-s-text">
                Pre-order for {pkWhen(scheduledFor)} — reaches the kitchen at {pkWhen(kitchenAt)}
              </p>
              <p className="text-xs text-s-muted mt-0.5">
                {notFired
                  ? <>It moves to <Link href="/expo" className="underline">expo</Link>&apos;s Awaiting Fire at {pkWhen(kitchenAt)} and is fired from there. Later courses can be fired here after that.</>
                  : <>It is held until then: no kitchen ticket and no stock taken. Courses can be fired here once it reaches the kitchen.</>}
              </p>
            </div>
            {canFireEarly && !ended && (
              confirmEarly ? (
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-xs text-s-text">Send it to the kitchen now? Stock is taken and the first course starts cooking.</p>
                  <button onClick={() => firstCourse !== null && fire.mutate({ course: firstCourse })}
                    disabled={fire.isPending || firstCourse === null} className="s-btn-primary text-xs">
                    {fire.isPending ? 'Sending…' : 'Yes, send now'}
                  </button>
                  <button onClick={() => setConfirmEarly(false)} disabled={fire.isPending} className="s-btn-secondary text-xs">
                    Keep it held
                  </button>
                </div>
              ) : (
                <button onClick={() => setConfirmEarly(true)} disabled={firstCourse === null} className="s-btn-secondary text-xs">
                  Send to the kitchen early…
                </button>
              )
            )}
          </div>
        )}

        {notFired && !held && (
          <div className="s-card px-4 py-3 text-sm">
            <p className="font-bold text-s-text">This order has not been fired yet.</p>
            <p className="text-xs text-s-muted mt-0.5">
              Confirm and fire it from <Link href="/expo" className="underline">expo</Link> first. Later courses can be fired here after that.
            </p>
          </div>
        )}

        {error && (
          <div role="alert" className="s-card px-4 py-3 text-sm flex items-start justify-between gap-3 border-s-red">
            <p className="text-s-red">{error}</p>
            <button onClick={() => setError(null)} className="text-xs text-s-muted hover:text-s-text">Dismiss</button>
          </div>
        )}

        {data?.map((g) => {
          const waitingLines = g.items.filter(waiting)
          const waitingIds = new Set(waitingLines.map((i) => i.id))
          // Paced lines still waiting (the worker fires them at their time):
          // from the server's scheduledFireAt once the course has started (an
          // unfired course's schedule is re-laid when it fires), else from the
          // last fire response.
          const paced = pacedLinesOf(g, pacedByCourse[g.course] ?? [])
          // Some of the course is in the kitchen but dishes are still waiting.
          const partlyFired = g.fired && waitingLines.length > 0
          const fullyFired = g.fired && waitingLines.length === 0
          const canFireHere = !notFired && !ended && !held && !!status
          const showFire = canFireHere && !g.fired && waitingLines.length > 0
          const showFireAll = canFireHere && canFireAll && waitingLines.length > 0
            && (partlyFired || g.course === firstCourse)
          const label = g.complete ? 'complete'
            : partlyFired ? `paced — ${waitingLines.length} dish${waitingLines.length === 1 ? '' : 'es'} still to fire`
            : fullyFired ? 'in kitchen'
            : 'pending'
          const busy = fire.isPending && fire.variables?.course === g.course
          return (
            <section key={g.course} className="s-card overflow-hidden">
              <div className="px-4 py-3 border-b border-s-border bg-s-bg-soft flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2">
                  <span className={`h-3 w-3 rounded-full ${g.complete ? 'bg-s-teal' : g.fired ? 'bg-s-amber' : 'bg-gray-300'}`} />
                  <h2 className="text-sm font-bold">Course {g.course}</h2>
                  <span className="text-xs text-s-muted">{label}</span>
                </div>
                <div className="flex items-center gap-2">
                  {showFire && (
                    <button onClick={() => fire.mutate({ course: g.course })} disabled={fire.isPending} className="s-btn-primary text-xs">
                      {busy && !fire.variables?.fireAll ? 'Firing…' : 'Fire course →'}
                    </button>
                  )}
                  {showFireAll && (
                    <button onClick={() => fire.mutate({ course: g.course, fireAll: true })} disabled={fire.isPending}
                      className="s-btn-secondary text-xs"
                      title="Fire every dish of this course now, without pacing">
                      {busy && fire.variables?.fireAll ? 'Firing…' : 'Fire all now'}
                    </button>
                  )}
                </div>
              </div>
              {paced.length > 0 && (
                <div className="px-4 py-2 border-b border-s-border text-xs text-s-muted space-y-0.5">
                  <p className="font-bold text-s-text">Paced so the course plates together</p>
                  {paced.map((l) => (
                    <p key={l.id}><span className="font-semibold text-s-text">{l.name}</span> fires at {pkClock(l.scheduledFireAt)}</p>
                  ))}
                </div>
              )}
              <div className="divide-y divide-s-border">
                {g.items.map((it) => {
                  const p = paced.find((l) => l.id === it.id)
                  return (
                    <div key={it.id} className="px-4 py-2 flex items-center justify-between text-sm">
                      <span>
                        {it.quantity}× {it.name}
                      </span>
                      <span className="text-xs text-s-muted">
                        {p ? `fires at ${pkClock(p.scheduledFireAt)}`
                          : partlyFired && waitingIds.has(it.id) ? 'waiting (paced)'
                          : it.status}
                      </span>
                    </div>
                  )
                })}
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}
