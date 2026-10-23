'use client'

// Reservations — day view with a per-half-hour grid down the side and a
// list-of-reservations grouped by hour. Plus a waitlist sidebar and a quick
// "new reservation" form.
//
// Hosts at the door work this every minute. The flow:
//   • see who's coming next 15 min
//   • walk-in arrives → add to waitlist or seat directly
//   • seat a confirmed booking → table goes "seated", reservation status flips
//   • mark complete on departure → table goes "cleaning"

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowRight, Plus } from 'lucide-react'
import { CompactEmptyState } from '../../components/ui/CompactEmptyState'
import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { format } from 'date-fns'
import { api } from '../../lib/api'
import { todayPktIso, fmtPkrShort } from '../../lib/money'
import { useReservationSocket } from '../../hooks/useReservationSocket'
import { CustomerContextSidebar } from '../../components/customer/CustomerContextSidebar'
import { useBrandFilter } from '../../store/brandFilter'
import {
  bookedLine, overbookFields, overbookReady, overbookRefusalText, policyRefusalText, slotFullPrompt,
  OVERBOOK_REASON_MAX, type CreatedBooking, type SlotFull,
} from './overbook'
import { Select } from '@/components/ui/Select'
import { Modal } from '@/components/ui/Modal'
import { NumberField } from '@/components/ui/NumberField'
import { PasswordInput } from '@/components/ui/PasswordInput'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import { useTrashPrefill } from '../../lib/trash'
import { unwrapPrefill, pStr, pNum, pBool } from '../../lib/trashPrefill'

// Small structural icons (currentColor) in place of emoji.
function Ico({ d, size = 12, className = '' }: { d: string; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden="true" className={`inline-block shrink-0 align-[-2px] ${className}`}>
      <path d={d} />
    </svg>
  )
}
const ICON_STAR = 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z'
const ICON_PHONE = 'M5 4h4l2 5-2.5 1.5a11 11 0 005 5L15 13l5 2v4a2 2 0 01-2 2A16 16 0 013 6a2 2 0 012-2z'
const ICON_MAIL = 'M3 6h18v12H3zM3 7l9 6 9-6'
const ICON_USER = 'M12 12a4 4 0 100-8 4 4 0 000 8zM4 21a8 8 0 0116 0'
const VipMark = () => <Ico d={ICON_STAR} className="text-s-amber mr-1" />

/** 2026-10-15 → "Thu 15 Oct". */
function fmtDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00`)
  return Number.isNaN(d.getTime()) ? iso : format(d, 'EEE d MMM')
}

interface Concept { id: string; name: string }

interface Reservation {
  id: string
  partySize: number
  startTime: string
  endTime: string
  status: 'booked' | 'confirmed' | 'seated' | 'completed' | 'no_show' | 'cancelled'
  source: string
  guestName: string
  guestPhone: string | null
  guestEmail: string | null
  notes: string | null
  isVip: boolean
  waitlist: boolean
  table?: { id: string; label: string; capacity: number } | null
  customer?: { id: string; name: string; totalSpentCents: number; lastOrderAt: string | null } | null
}

interface Floor { id: string; name: string; tables: Array<{ id: string; label: string; capacity: number }> }

const STATUS_BADGE: Record<string, { cls: string; label: string }> = {
  booked:    { cls: 'bg-s-blue-dim text-s-blue',       label: 'Booked' },
  confirmed: { cls: 'bg-s-green-dim text-s-green',     label: 'Confirmed' },
  seated:    { cls: 'bg-primary/10 text-primary-ink',  label: 'Seated' },
  completed: { cls: 'bg-s-elevated text-s-muted',      label: 'Done' },
  no_show:   { cls: 'bg-s-red-dim text-s-red',         label: 'No show' },
  cancelled: { cls: 'bg-s-red-dim text-s-red',         label: 'Cancelled' },
}

export default function ReservationsPage() {
  const qc = useQueryClient()
  const [conceptId, setConceptId] = useState<string>(() => useBrandFilter.getState().brandId ?? '')
  const [date,      setDate]      = useState(todayPktIso())
  const [showNew,   setShowNew]   = useState(false)
  // Customer context drawer: when set, the right-side drawer shows that
  // customer's full cross-module history.
  const [drawerCustomerId, setDrawerCustomerId] = useState<string | null>(null)

  const concepts = useQuery({ queryKey: ['concepts'], queryFn: () => api.get<Concept[]>('/concepts') })

  // "Recover as copy" from the Trash (type `reservation`): open the booking
  // form pre-filled, on the original's brand when it is still one of ours.
  const trashPrefill = unwrapPrefill(useTrashPrefill('reservation'))
  const [prefill, setPrefill] = useState<ReturnType<typeof unwrapPrefill>>(null)
  useEffect(() => {
    if (!trashPrefill) return
    setPrefill(trashPrefill)
    const c = pStr(trashPrefill, 'conceptId', 'brandId')
    if (c) setConceptId(c)
    setShowNew(true)
  }, [trashPrefill])

  useEffect(() => {
    if (!conceptId && concepts.data && concepts.data.length > 0) {
      setConceptId(concepts.data[0]!.id)
    }
  }, [concepts.data, conceptId])

  const reservations = useQuery({
    queryKey: ['reservations', conceptId, date],
    queryFn: () => api.get<Reservation[]>(`/reservations?conceptId=${conceptId}&date=${date}`),
    enabled: !!conceptId,
    refetchInterval: 30_000,
  })

  const floors = useQuery({
    queryKey: ['floors-for-res', conceptId],
    queryFn: () => api.get<Floor[]>(`/floors?conceptId=${conceptId}`),
    enabled: !!conceptId,
  })

  const allTables = useMemo(
    () => (floors.data ?? []).flatMap((f) => f.tables.map((t) => ({ ...t, floorName: f.name }))),
    [floors.data],
  )

  const waitlist = useQuery({
    queryKey: ['waitlist', conceptId],
    queryFn: () => api.get<Array<{ id: string; partySize: number; startTime: string; guestName: string; guestPhone: string | null; notes: string | null; isVip: boolean; status: string; waitlist: boolean }>>(`/reservations/waitlist?conceptId=${conceptId}`),
    enabled: !!conceptId,
    refetchInterval: 30_000,
  })

  // Live updates: reservations day view + waitlist sidebar both refresh on
  // any reservation event. Falls back to the 30s polling above if the
  // socket dies.
  useReservationSocket({
    conceptId,
    queryKeys: [
      ['reservations', conceptId, date],
      ['waitlist',     conceptId],
    ],
  })

  // Group reservations by hour of day
  const byHour = useMemo(() => {
    const map: Record<number, Reservation[]> = {}
    for (const r of reservations.data ?? []) {
      const hour = new Date(r.startTime).getHours()
      if (!map[hour]) map[hour] = []
      map[hour]!.push(r)
    }
    return map
  }, [reservations.data])

  const visibleHours = Object.keys(byHour).map(Number).sort((a, b) => a - b)

  const transition = useMutation({
    mutationFn: ({ id, action, body }: { id: string; action: 'confirm' | 'seat' | 'complete' | 'cancel' | 'no-show'; body?: Record<string, unknown> }) =>
      api.post(`/reservations/${id}/${action}`, body ?? {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['reservations'] })
      void qc.invalidateQueries({ queryKey: ['waitlist'] })
    },
  })

  return (
    <div className="min-h-full bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-6 py-4 flex items-center justify-between flex-wrap gap-3">
        <div>
          <p className="text-xs text-s-muted">Operations</p>
          <h1 className="text-xl font-bold text-s-text">Reservations</h1>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Select value={conceptId} onChange={(e) => setConceptId(e.target.value)}
            className="min-h-11 bg-s-surface border border-s-border rounded px-2 py-1 text-sm">
            {concepts.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
            className="min-h-11 bg-s-surface border border-s-border rounded px-2 py-1 text-sm" />
          <button onClick={() => setDate(todayPktIso())} className="min-h-11 s-btn-secondary text-xs">Today</button>
          <button onClick={() => setShowNew(true)} className="min-h-11 s-btn-primary text-xs"><Plus size={16} aria-hidden="true" /> New booking</button>
        </div>
      </header>

      <div className="p-6 max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4">
        {/* Day view */}
        <div className="space-y-3">
          {!reservations.data && reservations.isLoading && (
            <div className="s-card p-8 text-center text-s-muted text-sm">Loading…</div>
          )}
          {reservations.data && reservations.data.length === 0 && (
            <CompactEmptyState message={`No bookings for ${fmtDay(date)}.`} action={{ label: 'Add booking', onClick: () => setShowNew(true) }} />
          )}
          {visibleHours.map((h) => (
            <div key={h} className="s-card overflow-hidden">
              <div className="px-4 py-2 bg-s-bg-soft border-b border-s-border flex items-baseline justify-between">
                <h2 className="text-sm font-bold">{String(h).padStart(2, '0')}:00</h2>
                <span className="text-xs text-s-muted">{byHour[h]!.length} booking{byHour[h]!.length === 1 ? '' : 's'}</span>
              </div>
              <div className="divide-y divide-s-border">
                {byHour[h]!.sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime()).map((r) => (
                  <ReservationRow
                    key={r.id}
                    r={r}
                    tables={allTables}
                    onTransition={(action, body) => transition.mutate({ id: r.id, action, body })}
                    onViewCustomer={(id) => setDrawerCustomerId(id)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Waitlist sidebar */}
        <aside>
          <div className="s-card overflow-hidden sticky top-24">
            <div className="px-4 py-3 border-b border-s-border bg-s-bg-soft flex items-center justify-between">
              <h2 className="text-sm font-bold">Waitlist & unseated</h2>
              <span className="text-xs text-s-muted">{waitlist.data?.length ?? 0}</span>
            </div>
            <div className="p-3 space-y-2 max-h-[60vh] overflow-y-auto">
              {(waitlist.data ?? []).length === 0 && (
                <p className="text-xs text-s-muted text-center py-4">Nobody waiting.</p>
              )}
              {(waitlist.data ?? []).map((w) => (
                <div key={w.id} className="rounded-lg border border-s-border p-3">
                  <div className="flex items-baseline justify-between mb-1">
                    <p className="text-sm font-semibold">{w.isVip && <VipMark />}{w.guestName}</p>
                    <span className="text-xs text-s-muted">{w.partySize}p</span>
                  </div>
                  <p className="text-xs text-s-muted">
                    {new Date(w.startTime).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })}
                    {w.guestPhone && <> · {w.guestPhone}</>}
                  </p>
                  {w.notes && <p className="text-xs text-s-muted mt-1 italic">{w.notes}</p>}
                  <SeatButton id={w.id} tables={allTables}
                    onSeat={(tableId) => transition.mutate({ id: w.id, action: 'seat', body: { tableId } })} />
                </div>
              ))}
            </div>
          </div>
        </aside>
      </div>

      {showNew && conceptId && (
        <NewReservationModal
          conceptId={conceptId}
          tables={allTables}
          defaultDate={date}
          prefill={prefill}
          onClose={() => setShowNew(false)}
          onCreated={() => {
            void qc.invalidateQueries({ queryKey: ['reservations'] })
            void qc.invalidateQueries({ queryKey: ['waitlist'] })
            setShowNew(false)
          }}
        />
      )}

      <div className="px-6 pb-6 flex flex-wrap items-center gap-3 text-xs text-s-muted">
        <Link href="/reservations/week"      className="inline-flex min-h-11 items-center text-primary-ink hover:underline">Week view</Link>
        <Link href="/reservations/blockouts" className="inline-flex min-h-11 items-center text-primary-ink hover:underline">Closures & blockouts</Link>
        <Link href="/configuration/hours"    className="inline-flex min-h-11 items-center text-primary-ink hover:underline">Service hours</Link>
        <Link href="/reservations/analytics" className="inline-flex min-h-11 items-center text-primary-ink hover:underline">Analytics</Link>
        <Link href="/floorplan"              className="inline-flex min-h-11 items-center text-primary-ink hover:underline">Floor plan</Link>
      </div>

      {/* ── Customer-context drawer (right side, slides in when a customer
            is selected via the "Profile" button on a reservation row) ── */}
      {drawerCustomerId && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex justify-end"
          style={{ background: 'rgb(var(--ink-rgb) / 0.5)' }}
          onClick={() => setDrawerCustomerId(null)}>
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md h-full overflow-y-auto p-5"
            style={{ background: 'var(--surface)' }}>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-sm font-bold uppercase tracking-[0.18em] text-white/80">Customer context</h2>
              <button
                onClick={() => setDrawerCustomerId(null)}
                className="text-white/40 hover:text-white/85 text-lg">×</button>
            </div>
            <CustomerContextSidebar customerId={drawerCustomerId} />
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Row ──────────────────────────────────────────────────────────────────

function ReservationRow({
  r, tables, onTransition, onViewCustomer,
}: {
  r: Reservation
  tables: Array<{ id: string; label: string; capacity: number; floorName: string }>
  onTransition: (action: 'confirm' | 'seat' | 'complete' | 'cancel' | 'no-show', body?: Record<string, unknown>) => void
  onViewCustomer: (id: string) => void
}) {
  const confirm = useConfirm()
  const badge = STATUS_BADGE[r.status]!
  const time = new Date(r.startTime).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })
  return (
    <div className="px-4 py-3 grid grid-cols-[80px_1fr_auto] items-start gap-3">
      <div className="text-sm font-mono text-s-text">{time}</div>
      <div>
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-sm font-semibold">{r.isVip && <VipMark />}{r.guestName}</span>
          <span className="text-xs text-s-muted">{r.partySize} ppl</span>
          <span className={`text-xs uppercase tracking-wider px-1.5 py-0.5 rounded ${badge.cls}`}>{badge.label}</span>
          {r.table && <span className="text-xs text-s-muted font-mono">@ {r.table.label}</span>}
        </div>
        <p className="text-xs text-s-muted mt-0.5">
          {r.guestPhone && <span><Ico d={ICON_PHONE} className="mr-1" />{r.guestPhone}</span>}
          {r.guestEmail && <span> · <Ico d={ICON_MAIL} className="mr-1" />{r.guestEmail}</span>}
          {r.notes && <span className="italic"> · {r.notes}</span>}
          {r.customer && r.customer.totalSpentCents > 0 && <span> · returning · {fmtPkrShort(r.customer.totalSpentCents)} LTV</span>}
        </p>
      </div>
      <div className="flex gap-1.5 flex-wrap justify-end">
        {r.customer && (
          <button onClick={() => onViewCustomer(r.customer!.id)}
            className="min-h-11 text-xs font-bold px-3 rounded bg-primary/10 text-primary-ink border border-primary/30">
            <Ico d={ICON_USER} className="mr-1" />Profile
          </button>
        )}
        {r.status === 'booked' && (
          <button onClick={() => onTransition('confirm')} className="min-h-11 text-xs font-bold px-3 rounded bg-primary text-primary-on">Confirm</button>
        )}
        {(r.status === 'booked' || r.status === 'confirmed') && (
          <SeatButton id={r.id} tables={tables} preselect={r.table?.id}
            onSeat={(tableId) => onTransition('seat', { tableId })} />
        )}
        {r.status === 'seated' && (
          <button onClick={() => onTransition('complete')} className="min-h-11 text-xs font-bold px-3 rounded bg-secondary text-secondary-on">Complete</button>
        )}
        {(r.status === 'booked' || r.status === 'confirmed') && (
          <button onClick={async () => {
            const res = await confirm({
              title: `Cancel ${r.guestName}'s booking?`, body: `${r.partySize} ppl at ${time}.`,
              confirmLabel: 'Cancel booking', cancelLabel: 'Keep booking', danger: true,
              reason: { label: 'Reason for cancelling', minLength: 3 },
            })
            if (res && res.reason) onTransition('cancel', { reason: res.reason })
          }} className="min-h-11 text-xs text-s-red px-3">Cancel</button>
        )}
        {(r.status === 'booked' || r.status === 'confirmed') && new Date(r.endTime).getTime() < Date.now() && (
          <button onClick={async () => {
            const res = await confirm({
              title: `Mark ${r.guestName} as a no-show?`, body: `${r.partySize} ppl booked for ${time}. This counts against the guest.`,
              confirmLabel: 'Mark no-show', danger: true,
            })
            if (res) onTransition('no-show')
          }} className="min-h-11 text-xs text-s-red px-3">No-show</button>
        )}
      </div>
    </div>
  )
}

// ─── Seat button (table picker dropdown) ──────────────────────────────────

function SeatButton({
  id, tables, preselect, onSeat,
}: {
  id: string
  tables: Array<{ id: string; label: string; capacity: number; floorName: string }>
  preselect?: string
  onSeat: (tableId: string) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <span className="relative">
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="min-h-11 text-xs font-bold px-3 rounded bg-secondary text-secondary-on">
        Seat <ArrowRight size={12} aria-hidden="true" className="inline-block align-[-2px]" />
      </button>
      {open && (
        <span className="absolute right-0 top-full mt-1 z-20 bg-s-surface border border-s-border rounded shadow-lg p-1 min-w-[180px]">
          {tables.map((t) => (
            <button
              key={t.id}
              onClick={() => { onSeat(t.id); setOpen(false) }}
              className={`block w-full min-h-11 text-left text-xs px-2 py-1 rounded hover:bg-s-bg-soft ${preselect === t.id ? 'font-bold' : ''}`}
            >
              {t.label} <span className="text-s-muted">({t.capacity}p · {t.floorName})</span>
            </button>
          ))}
          {tables.length === 0 && (
            <p className="text-xs text-s-muted px-2 py-2">No tables yet — set up the floor plan first.</p>
          )}
        </span>
      )}
      {void id}
    </span>
  )
}

// ─── New reservation modal ────────────────────────────────────────────────

function NewReservationModal({
  conceptId, tables, defaultDate, prefill, onClose, onCreated,
}: {
  prefill?: ReturnType<typeof unwrapPrefill>
  conceptId: string
  tables: Array<{ id: string; label: string; capacity: number; floorName: string }>
  defaultDate: string
  onClose: () => void
  onCreated: () => void
}) {
  const [partySize, setPartySize] = useState<number | null>(() => {
    const n = pNum(prefill ?? null, 'partySize', 'party')
    return n && n >= 1 && n <= 50 ? Math.round(n) : 2
  })
  const [startDate, setStartDate] = useState(defaultDate)
  const [startTime, setStartTime] = useState('19:00')
  const [durationMin, setDurationMin] = useState<number | null>(90)
  const [tableId, setTableId] = useState('')
  const [waitlist, setWaitlist] = useState(false)
  const [guestName, setGuestName] = useState(pStr(prefill ?? null, 'guestName', 'name') ?? '')
  const [guestPhone, setGuestPhone] = useState(pStr(prefill ?? null, 'guestPhone', 'phone') ?? '')
  const [guestEmail, setGuestEmail] = useState(pStr(prefill ?? null, 'guestEmail', 'email') ?? '')
  const [notes, setNotes] = useState(pStr(prefill ?? null, 'notes') ?? '')
  const [isVip, setIsVip] = useState(pBool(prefill ?? null, 'isVip', 'vip') ?? false)
  const [err, setErr] = useState<string | null>(null)
  // ONL-R2-04: the server said no table fits (409 SLOT_FULL) and a manager
  // may book past capacity — ask for the reason (and a manager PIN when the
  // signed-in user is not a manager), then send the same booking again.
  const [slotFull, setSlotFull] = useState<SlotFull | null>(null)
  const [overReason, setOverReason] = useState('')
  const [overPin, setOverPin] = useState('')
  const [booked, setBooked] = useState<CreatedBooking | null>(null)
  const today = todayPktIso()
  // Empty or out of range while typing is fine; the booking can't be sent until both are real numbers.
  const sizeOk = partySize != null && partySize >= 1 && partySize <= 50
  const durOk = durationMin != null && durationMin >= 15 && durationMin <= 480
  const dateOk = startDate >= today
  const formOk = !!guestName.trim() && sizeOk && durOk && dateOk
  const dirty = !!(guestName || guestPhone || guestEmail || notes || tableId || isVip || waitlist)
    || partySize !== 2 || durationMin !== 90 || startTime !== '19:00' || startDate !== defaultDate

  const create = useMutation({
    mutationFn: (override: ReturnType<typeof overbookFields> | null) => {
      const startIso = new Date(`${startDate}T${startTime}:00+05:00`).toISOString()
      return api.post<CreatedBooking>('/reservations', {
        conceptId, partySize: partySize ?? 1, startTime: startIso, durationMin: durationMin ?? 90,
        tableId: tableId || null, waitlist,
        guestName: guestName.trim(), guestPhone: guestPhone.trim() || null,
        guestEmail: guestEmail.trim() || null, notes: notes.trim() || null,
        isVip, source: 'staff',
        ...(override ?? {}),
      })
    },
    onSuccess: (r) => { setErr(null); setSlotFull(null); setOverPin(''); setBooked(r) },
    onError: (e: unknown, override) => {
      setOverPin('')
      const full = slotFullPrompt(e)
      // A refused overbook keeps the prompt open with the plain reason.
      if (override) {
        const refusal = overbookRefusalText(e)
        if (refusal) { setErr(refusal); return }
      }
      if (full) { setSlotFull(full); setErr(null); return }
      setSlotFull(null)
      setErr(overbookRefusalText(e) ?? policyRefusalText(e) ?? ((e as { message?: string }).message || 'Could not create reservation'))
    },
  })

  // Any change to when / who / which table is a new question: drop the prompt.
  useEffect(() => { setSlotFull(null) }, [partySize, startDate, startTime, durationMin, tableId, waitlist])

  if (booked) {
    return (
      <Modal title="Booking made" onClose={onCreated}
        footer={<div className="flex justify-end"><button autoFocus onClick={onCreated} className="min-h-11 s-btn-primary min-h-11 text-sm">Done</button></div>}>
        <p className="text-sm text-s-text">{guestName.trim()} · {partySize} ppl · {fmtDay(startDate)} {startTime}</p>
        <p className={`text-sm ${booked.overbooked ? 'text-s-amber' : 'text-s-text'}`}>{bookedLine(booked)}</p>
      </Modal>
    )
  }

  const submit = () => {
    if (create.isPending || !formOk) return
    if (slotFull) {
      if (!overbookReady(overReason, overPin, slotFull.managerRequired)) return
      create.mutate(overbookFields(overReason, overPin, slotFull.managerRequired))
    } else create.mutate(null)
  }

  return (
    <Modal title="New reservation" wide onClose={onClose} dirty={dirty} dismissible={!create.isPending}
      footer={
        <div className="flex justify-end gap-2 flex-wrap">
          <button type="button" onClick={onClose} className="min-h-11 s-btn-secondary min-h-11 text-sm">Cancel</button>
          {slotFull ? (
            <button type="submit" form="new-reservation-form"
              disabled={create.isPending || !formOk || !overbookReady(overReason, overPin, slotFull.managerRequired)}
              className="min-h-11 s-btn-primary min-h-11 text-sm">
              {create.isPending ? 'Booking…' : 'Book past capacity'}
            </button>
          ) : (
            <button type="submit" form="new-reservation-form" disabled={create.isPending || !formOk} className="min-h-11 s-btn-primary min-h-11 text-sm">
              {create.isPending ? 'Booking…' : 'Confirm booking'}
            </button>
          )}
        </div>
      }>
      <form id="new-reservation-form" className="space-y-3 text-sm" onSubmit={(e) => { e.preventDefault(); submit() }}>
          <Field label="Guest name *">
            <input autoFocus required autoComplete="name" value={guestName} onChange={(e) => setGuestName(e.target.value)} className="min-h-11 w-full bg-s-surface border border-s-border rounded px-2 py-1.5" />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Phone">
              <input type="tel" inputMode="tel" autoComplete="tel" value={guestPhone} onChange={(e) => setGuestPhone(e.target.value)} placeholder="+92 …" className="min-h-11 w-full bg-s-surface border border-s-border rounded px-2 py-1.5" />
            </Field>
            <Field label="Email">
              <input type="email" inputMode="email" autoComplete="email" value={guestEmail} onChange={(e) => setGuestEmail(e.target.value)} className="min-h-11 w-full bg-s-surface border border-s-border rounded px-2 py-1.5" />
            </Field>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <Field label="Party">
              <NumberField min={1} max={50} value={partySize} onValueChange={setPartySize} aria-invalid={!sizeOk} className="w-full bg-s-surface border border-s-border rounded px-2 py-1.5" />
            </Field>
            <Field label="Date">
              <input type="date" min={today} value={startDate} onChange={(e) => setStartDate(e.target.value)} className="min-h-11 w-full bg-s-surface border border-s-border rounded px-2 py-1.5" />
            </Field>
            <Field label="Time">
              <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} className="min-h-11 w-full bg-s-surface border border-s-border rounded px-2 py-1.5" />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Duration (min)">
              <NumberField min={15} max={480} value={durationMin} onValueChange={setDurationMin} aria-invalid={!durOk} className="w-full bg-s-surface border border-s-border rounded px-2 py-1.5" />
            </Field>
            <Field label="Table">
              <Select value={tableId} onChange={(e) => setTableId(e.target.value)} className="min-h-11 w-full bg-s-surface border border-s-border rounded px-2 py-1.5">
                <option value="">— Waitlist (assign later) —</option>
                {tables.map((t) => (
                  <option key={t.id} value={t.id}>{t.label} ({t.capacity}p · {t.floorName})</option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Notes (allergies, occasion, requests)">
            <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} className="min-h-11 w-full bg-s-surface border border-s-border rounded px-2 py-1.5" />
          </Field>
          <div className="flex items-center gap-4 text-xs">
            <label className="inline-flex items-center gap-1.5"><input type="checkbox" checked={isVip} onChange={(e) => setIsVip(e.target.checked)} /> VIP</label>
            {!tableId && <label className="inline-flex items-center gap-1.5"><input type="checkbox" checked={waitlist} onChange={(e) => setWaitlist(e.target.checked)} /> Mark as waitlist</label>}
          </div>
          {slotFull && (
            <div className="rounded-lg border border-s-amber/40 bg-s-amber-dim p-3 space-y-2">
              <p className="text-xs font-semibold text-s-amber">No table fits this booking</p>
              <p className="text-xs text-s-text">{slotFull.message}</p>
              <p className="text-xs text-s-muted">
                A manager can book it past capacity anyway (for example tables pushed together).
                {slotFull.managerRequired ? ' Enter the manager’s PIN and the reason.' : ' Say why.'} It is recorded with the reason.
              </p>
              <Field label="Reason for booking past capacity *">
                <input value={overReason} onChange={(e) => setOverReason(e.target.value)} maxLength={OVERBOOK_REASON_MAX}
                  placeholder="e.g. Regular, two 4-tops pushed together"
                  className="min-h-11 w-full bg-s-surface border border-s-border rounded px-2 py-1.5" />
              </Field>
              {slotFull.managerRequired && (
                <Field label="Manager PIN *">
                  <PasswordInput numeric autoComplete="off" value={overPin} maxLength={8}
                    onChange={(e) => setOverPin(e.target.value)} wrapperClassName="max-w-[200px]"
                    className="w-full bg-s-surface border border-s-border rounded px-2 py-1.5 font-mono" />
                </Field>
              )}
            </div>
          )}
          {!dateOk && <p className="text-xs text-s-red">Pick today or a later date.</p>}
          {err && <p className="text-xs text-s-red" role="alert">{err}</p>}
      </form>
    </Modal>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs text-s-muted mb-1">{label}</span>
      {children}
    </label>
  )
}
