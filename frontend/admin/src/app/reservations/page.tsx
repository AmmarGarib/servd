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
import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { api } from '../../lib/api'
import { todayPktIso, fmtPkrShort } from '../../lib/money'
import { useReservationSocket } from '../../hooks/useReservationSocket'
import { CustomerContextSidebar } from '../../components/customer/CustomerContextSidebar'
import { useBrandFilter } from '../../store/brandFilter'

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

const STATUS_BADGE: Record<string, { bg: string; text: string; label: string }> = {
  booked:    { bg: 'rgba(59,130,246,0.12)',  text: '#1d4ed8', label: 'Booked' },
  confirmed: { bg: 'rgba(34,197,94,0.14)',   text: '#15803d', label: 'Confirmed' },
  seated:    { bg: 'rgba(99,102,241,0.18)',  text: '#4338ca', label: 'Seated' },
  completed: { bg: 'rgba(0,0,0,0.06)',       text: 'rgba(0,0,0,0.5)', label: 'Done' },
  no_show:   { bg: 'rgba(239,68,68,0.12)',   text: '#b91c1c', label: 'No show' },
  cancelled: { bg: 'rgba(239,68,68,0.12)',   text: '#b91c1c', label: 'Cancelled' },
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
    <div className="min-h-screen bg-s-bg">
      <header className="sticky top-0 z-10 bg-s-bg/80 backdrop-blur border-b border-s-border px-6 py-4 flex items-center justify-between flex-wrap gap-3">
        <div>
          <p className="text-xs text-s-muted">Operations</p>
          <h1 className="text-xl font-bold text-s-text">Reservations</h1>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <select value={conceptId} onChange={(e) => setConceptId(e.target.value)}
            className="bg-white border border-s-border rounded px-2 py-1 text-sm">
            {concepts.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
            className="bg-white border border-s-border rounded px-2 py-1 text-sm" />
          <button onClick={() => setDate(todayPktIso())} className="s-btn-secondary text-xs">Today</button>
          <button onClick={() => setShowNew(true)} className="s-btn-primary text-xs">+ New booking</button>
        </div>
      </header>

      <div className="p-6 max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4">
        {/* Day view */}
        <div className="space-y-3">
          {!reservations.data && reservations.isLoading && (
            <div className="s-card p-8 text-center text-s-muted text-sm">Loading…</div>
          )}
          {reservations.data && reservations.data.length === 0 && (
            <div className="s-card p-12 text-center">
              <h3 className="text-lg font-semibold mb-2">Nothing on the books for {date}</h3>
              <p className="text-s-muted text-sm mb-4">Quiet day, or it&rsquo;s time to push some marketing.</p>
              <button onClick={() => setShowNew(true)} className="s-btn-primary text-sm">+ Add booking</button>
            </div>
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
                    <p className="text-sm font-semibold">{w.isVip ? '⭐ ' : ''}{w.guestName}</p>
                    <span className="text-[11px] text-s-muted">{w.partySize}p</span>
                  </div>
                  <p className="text-[11px] text-s-muted">
                    {new Date(w.startTime).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })}
                    {w.guestPhone && <> · {w.guestPhone}</>}
                  </p>
                  {w.notes && <p className="text-[11px] text-s-muted mt-1 italic">{w.notes}</p>}
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
          onClose={() => setShowNew(false)}
          onCreated={() => {
            void qc.invalidateQueries({ queryKey: ['reservations'] })
            void qc.invalidateQueries({ queryKey: ['waitlist'] })
            setShowNew(false)
          }}
        />
      )}

      <div className="px-6 pb-6 flex flex-wrap items-center gap-3 text-xs text-s-muted">
        <Link href="/reservations/week"      className="text-s-teal hover:underline">📅 Week view</Link>
        <Link href="/reservations/blockouts" className="text-s-teal hover:underline">🚫 Closures & blockouts</Link>
        <Link href="/configuration/hours"    className="text-s-teal hover:underline">🕐 Service hours</Link>
        <Link href="/reservations/analytics" className="text-s-teal hover:underline">📊 Analytics</Link>
        <Link href="/floorplan"              className="text-s-teal hover:underline">🪑 Floor plan</Link>
      </div>

      {/* ── Customer-context drawer (right side, slides in when a customer
            is selected via the "Profile" button on a reservation row) ── */}
      {drawerCustomerId && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex justify-end"
          style={{ background: 'rgba(0,0,0,0.4)' }}
          onClick={() => setDrawerCustomerId(null)}>
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md h-full overflow-y-auto p-5"
            style={{ background: '#0e1014' }}>
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
  const badge = STATUS_BADGE[r.status]!
  const time = new Date(r.startTime).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })
  return (
    <div className="px-4 py-3 grid grid-cols-[80px_1fr_auto] items-start gap-3">
      <div className="text-sm font-mono text-s-text">{time}</div>
      <div>
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-sm font-semibold">{r.isVip ? '⭐ ' : ''}{r.guestName}</span>
          <span className="text-xs text-s-muted">{r.partySize} ppl</span>
          <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded" style={{ background: badge.bg, color: badge.text }}>{badge.label}</span>
          {r.table && <span className="text-[11px] text-s-muted font-mono">@ {r.table.label}</span>}
        </div>
        <p className="text-[11px] text-s-muted mt-0.5">
          {r.guestPhone && <span>📞 {r.guestPhone}</span>}
          {r.guestEmail && <span> · ✉ {r.guestEmail}</span>}
          {r.notes && <span className="italic"> · {r.notes}</span>}
          {r.customer && r.customer.totalSpentCents > 0 && <span> · returning · {fmtPkrShort(r.customer.totalSpentCents)} LTV</span>}
        </p>
      </div>
      <div className="flex gap-1.5 flex-wrap justify-end">
        {r.customer && (
          <button onClick={() => onViewCustomer(r.customer!.id)}
            className="text-[11px] font-bold px-2 py-1 rounded bg-indigo-50 text-indigo-700 border border-indigo-200">
            👤 Profile
          </button>
        )}
        {r.status === 'booked' && (
          <button onClick={() => onTransition('confirm')} className="text-[11px] font-bold px-2 py-1 rounded bg-s-teal text-white">Confirm</button>
        )}
        {(r.status === 'booked' || r.status === 'confirmed') && (
          <SeatButton id={r.id} tables={tables} preselect={r.table?.id}
            onSeat={(tableId) => onTransition('seat', { tableId })} />
        )}
        {r.status === 'seated' && (
          <button onClick={() => onTransition('complete')} className="text-[11px] font-bold px-2 py-1 rounded bg-black text-white">Complete</button>
        )}
        {(r.status === 'booked' || r.status === 'confirmed') && (
          <button onClick={() => {
            const reason = prompt('Cancel reason?'); if (reason !== null) onTransition('cancel', { reason })
          }} className="text-[11px] text-s-red px-2 py-1">Cancel</button>
        )}
        {(r.status === 'booked' || r.status === 'confirmed') && new Date(r.endTime).getTime() < Date.now() && (
          <button onClick={() => onTransition('no-show')} className="text-[11px] text-s-red px-2 py-1">No-show</button>
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
      <button onClick={() => setOpen(!open)} className="text-[11px] font-bold px-2 py-1 rounded bg-indigo-600 text-white">
        Seat →
      </button>
      {open && (
        <span className="absolute right-0 top-full mt-1 z-20 bg-white border border-s-border rounded shadow-lg p-1 min-w-[180px]">
          {tables.map((t) => (
            <button
              key={t.id}
              onClick={() => { onSeat(t.id); setOpen(false) }}
              className={`block w-full text-left text-xs px-2 py-1 rounded hover:bg-s-bg-soft ${preselect === t.id ? 'font-bold' : ''}`}
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
  conceptId, tables, defaultDate, onClose, onCreated,
}: {
  conceptId: string
  tables: Array<{ id: string; label: string; capacity: number; floorName: string }>
  defaultDate: string
  onClose: () => void
  onCreated: () => void
}) {
  const [partySize, setPartySize] = useState(2)
  const [startDate, setStartDate] = useState(defaultDate)
  const [startTime, setStartTime] = useState('19:00')
  const [durationMin, setDurationMin] = useState(90)
  const [tableId, setTableId] = useState('')
  const [waitlist, setWaitlist] = useState(false)
  const [guestName, setGuestName] = useState('')
  const [guestPhone, setGuestPhone] = useState('')
  const [guestEmail, setGuestEmail] = useState('')
  const [notes, setNotes] = useState('')
  const [isVip, setIsVip] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const create = useMutation({
    mutationFn: () => {
      const startIso = new Date(`${startDate}T${startTime}:00+05:00`).toISOString()
      return api.post('/reservations', {
        conceptId, partySize, startTime: startIso, durationMin,
        tableId: tableId || null, waitlist,
        guestName: guestName.trim(), guestPhone: guestPhone.trim() || null,
        guestEmail: guestEmail.trim() || null, notes: notes.trim() || null,
        isVip, source: 'staff',
      })
    },
    onSuccess: onCreated,
    onError: (e: { message?: string }) => setErr(e.message ?? 'Could not create reservation'),
  })

  return (
    <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-s-border flex justify-between items-center">
          <h2 className="text-lg font-bold">New reservation</h2>
          <button onClick={onClose} aria-label="Close" className="text-2xl leading-none text-s-muted">×</button>
        </div>
        <div className="p-5 space-y-3 text-sm">
          <Field label="Guest name *">
            <input autoFocus required value={guestName} onChange={(e) => setGuestName(e.target.value)} className="w-full bg-white border border-s-border rounded px-2 py-1.5" />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Phone">
              <input value={guestPhone} onChange={(e) => setGuestPhone(e.target.value)} placeholder="+92 …" className="w-full bg-white border border-s-border rounded px-2 py-1.5" />
            </Field>
            <Field label="Email">
              <input type="email" value={guestEmail} onChange={(e) => setGuestEmail(e.target.value)} className="w-full bg-white border border-s-border rounded px-2 py-1.5" />
            </Field>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <Field label="Party">
              <input type="number" min={1} max={50} value={partySize} onChange={(e) => setPartySize(parseInt(e.target.value, 10) || 1)} className="w-full bg-white border border-s-border rounded px-2 py-1.5" />
            </Field>
            <Field label="Date">
              <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="w-full bg-white border border-s-border rounded px-2 py-1.5" />
            </Field>
            <Field label="Time">
              <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} className="w-full bg-white border border-s-border rounded px-2 py-1.5" />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Duration (min)">
              <input type="number" min={15} max={480} value={durationMin} onChange={(e) => setDurationMin(parseInt(e.target.value, 10) || 90)} className="w-full bg-white border border-s-border rounded px-2 py-1.5" />
            </Field>
            <Field label="Table">
              <select value={tableId} onChange={(e) => setTableId(e.target.value)} className="w-full bg-white border border-s-border rounded px-2 py-1.5">
                <option value="">— Waitlist (assign later) —</option>
                {tables.map((t) => (
                  <option key={t.id} value={t.id}>{t.label} ({t.capacity}p · {t.floorName})</option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Notes (allergies, occasion, requests)">
            <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} className="w-full bg-white border border-s-border rounded px-2 py-1.5" />
          </Field>
          <div className="flex items-center gap-4 text-xs">
            <label className="inline-flex items-center gap-1.5"><input type="checkbox" checked={isVip} onChange={(e) => setIsVip(e.target.checked)} /> ⭐ VIP</label>
            {!tableId && <label className="inline-flex items-center gap-1.5"><input type="checkbox" checked={waitlist} onChange={(e) => setWaitlist(e.target.checked)} /> Mark as waitlist</label>}
          </div>
          {err && <p className="text-xs text-s-red">{err}</p>}
        </div>
        <div className="px-5 py-3 border-t border-s-border flex justify-end gap-2">
          <button onClick={onClose} className="s-btn-secondary text-sm">Cancel</button>
          <button onClick={() => create.mutate()} disabled={create.isPending || !guestName.trim()} className="s-btn-primary text-sm">
            {create.isPending ? 'Booking…' : 'Confirm booking'}
          </button>
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[11px] text-s-muted mb-1">{label}</span>
      {children}
    </label>
  )
}
