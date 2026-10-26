// Host stand day view. Today's bookings in time-slot rows, seat / no-show /
// arrived buttons inline. Real-time sync via socket so two host iPads stay in
// lock-step.
//
// Same API as the admin /reservations page: GET /reservations?date= (PKT day)
// and POST /reservations/:id/confirm|seat|cancel|no-show. A no-show goes
// through the one no-show path (deposit capture, strike, waitlist promotion).
// This screen used to call /reservations/today and /reservations/:id/transition,
// neither of which exists.
//
// New booking (ONL-R2-04): POST /reservations, the same call as the admin's
// "New reservation" dialog. When no table fits, the server answers 409
// SLOT_FULL with { overbookAllowed, managerRequired }; the sheet then asks
// for the reason (and a manager's PIN when the signed-in host is not a
// manager) and sends the same booking with { overbook, overbookReason,
// managerOverridePin }. The PIN must be a manager of the brand's own company;
// a refused PIN stores nothing. The table the server picked is shown.
//
// O-RV-1: the server applies the company's reservation policy to every
// booking except a walk-in BEFORE the capacity check — 400 TOO_SOON under
// minAdvanceHours (default 2), TOO_FAR past maxAdvanceDays, PARTY_TOO_LARGE —
// so the sheet has a date as well as a time, and its default slot is now +
// the policy's notice (GET /setup/reservation-policy, the active company's),
// rounded up to the next quarter hour and rolling to tomorrow late at night.
// Those refusals (and WALKINS_DISABLED) are shown in plain words.

import { useEffect, useState } from 'react'
import { View, Text, ScrollView, Pressable, Alert, TextInput, Modal } from 'react-native'
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'

import { api, ApiError } from '../../src/lib/api'
import { useSocketEvent } from '../../src/lib/socket'
import { theme } from '../../src/lib/theme'
import { shortTime } from '../../src/lib/format'
import { Panel, Pill } from '../../src/components/Panel'
import { Button } from '../../src/components/Button'

interface Reservation {
  id: string
  startTime: string
  partySize: number
  customerName: string
  customerPhone: string
  conceptName: string
  status: 'pending' | 'confirmed' | 'seated' | 'no-show' | 'cancelled' | 'completed'
  notes?: string | null
  tableId?: string | null
  depositCents?: number | null
  isWaitlist: boolean
  strikeCount?: number
  isBanned?: boolean
}

interface ApiReservation {
  id: string
  startTime: string
  partySize: number
  status: 'booked' | 'confirmed' | 'seated' | 'completed' | 'no_show' | 'cancelled'
  guestName: string
  guestPhone: string | null
  notes: string | null
  tableId: string | null
  table: { id: string; label: string } | null
  depositCents: number
  waitlist: boolean
  concept?: { name: string } | null
  customer: { name: string | null } | null
}

const STATUS_FROM_API: Record<ApiReservation['status'], Reservation['status']> = {
  booked: 'pending', confirmed: 'confirmed', seated: 'seated',
  completed: 'completed', no_show: 'no-show', cancelled: 'cancelled',
}

function toRow(r: ApiReservation): Reservation {
  return {
    id: r.id,
    startTime: r.startTime,
    partySize: r.partySize,
    customerName: r.customer?.name ?? r.guestName,
    customerPhone: r.guestPhone ?? '',
    conceptName: r.concept?.name ?? '',
    status: STATUS_FROM_API[r.status] ?? 'pending',
    notes: r.notes,
    tableId: r.table?.label ?? null,
    depositCents: r.depositCents > 0 ? r.depositCents : null,
    isWaitlist: r.waitlist,
  }
}

// PKT calendar day — the API reads ?date= as a Karachi day.
function todayPkt(): string {
  return new Date(Date.now() + 5 * 3_600_000).toISOString().slice(0, 10)
}

// ─── New booking + overbook (ONL-R2-04) ─────────────────────────────────────
// Same rules and words as the admin (frontend/admin/src/app/reservations/
// overbook.ts and components/pos/pinErrors.ts).

interface ApiErrorBody { error?: { code?: string; message?: string; details?: unknown } }

function errorOf(err: unknown): { code: string; message: string; details: unknown } {
  const body = err instanceof ApiError ? (err.body as ApiErrorBody | null) : null
  return {
    code: body?.error?.code ?? '',
    message: body?.error?.message ?? (err instanceof Error ? err.message : 'Something went wrong'),
    details: body?.error?.details,
  }
}

interface SlotFull { message: string; managerRequired: boolean }

/** 409 SLOT_FULL with an overbook allowed → the prompt; anything else → null. */
function slotFullOf(err: unknown): SlotFull | null {
  const e = errorOf(err)
  const d = e.details as { overbookAllowed?: unknown; managerRequired?: unknown } | null | undefined
  if (e.code !== 'SLOT_FULL' || d?.overbookAllowed !== true) return null
  return { message: e.message, managerRequired: d.managerRequired !== false }
}

/** Plain words for a refused overbook / PIN / policy rule; the server's message otherwise. */
function bookingErrorText(err: unknown, minAdvanceHours?: number | null): string {
  const e = errorOf(err)
  switch (e.code) {
    case 'MANAGER_PIN_LOCKED': {
      const sec = (e.details as { retryAfterSec?: unknown } | null | undefined)?.retryAfterSec
      const mins = typeof sec === 'number' && Number.isFinite(sec) ? Math.max(1, Math.ceil(sec / 60)) : null
      return `Too many wrong PINs. A manager must sign in, or ${mins == null ? 'try again in a few minutes' : `try again in ${mins} minute${mins === 1 ? '' : 's'}`}.`
    }
    case 'INVALID_MANAGER_PIN': return 'That PIN is not right. Check it with the manager and try again.'
    case 'MANAGER_OVERRIDE_REQUIRED': return 'Booking past capacity needs a manager — a manager signs in, or enters their PIN here.'
    default: return policyRefusalText(e.code, e.message, { minAdvanceHours, canWalkIn: true }) ?? e.message
  }
}

interface CreatedBooking { table?: { id: string; label: string } | null; overbooked?: boolean; waitlist?: boolean; pendingApproval?: boolean }

function bookedLine(r: CreatedBooking): string {
  if (r.waitlist) return 'Added to the waiting list — no table is held.'
  // Owner C10 (2026-10-26): unless the CEO books it, an overbook waits for the CEO (202).
  if (r.pendingApproval) return 'Sent to the CEO for approval — it goes past capacity. The guest is not told anything until the CEO approves.'
  const label = r.table?.label
  if (r.overbooked) {
    return label
      ? `Booked past capacity on table ${label}. The reason is on the booking and in the audit log.`
      : 'Booked past capacity — no table is assigned yet. Push tables together and seat the party when they arrive.'
  }
  return label ? `Booked — table ${label}.` : 'Booked — no table assigned yet.'
}

// <booking-policy-helpers> — pure, no imports: backend/tests/opsRound5.test.ts
// lifts this block out verbatim and runs it against the real route. Same
// rules and words as defaultBookingSlot / policyRefusalText in the admin's
// app/reservations/overbook.ts.

const PKT_OFFSET_MS = 5 * 3_600_000
const QUARTER_MS = 15 * 60_000
/** Slack on top of the notice period, so a few minutes filling the form never tips the default into TOO_SOON. */
const DEFAULT_SLACK_MS = 5 * 60_000
/** The schema default for ReservationPolicy.minAdvanceHours, until the policy loads. */
const DEFAULT_MIN_ADVANCE_HOURS = 2

/** The first bookable slot: now + notice (+ slack), rounded UP to the quarter hour, as a Karachi date and time. */
function defaultBookingSlot(minAdvanceHours: number, nowMs: number = Date.now()): { date: string; time: string } {
  const notice = Number.isFinite(minAdvanceHours) && minAdvanceHours > 0 ? minAdvanceHours : 0
  const earliest = nowMs + notice * 3_600_000 + DEFAULT_SLACK_MS
  const slot = Math.ceil(earliest / QUARTER_MS) * QUARTER_MS
  const iso = new Date(slot + PKT_OFFSET_MS).toISOString()
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) }
}

/** A Karachi date (YYYY-MM-DD) + time (HH:MM) → the ISO instant the API takes; null when either is not a real one. */
function bookingStartIso(date: string, time: string): string | null {
  if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return null
  const d = new Date(`${date}T${time}:00+05:00`)
  if (Number.isNaN(d.getTime())) return null
  // 2026-02-31 parses as 3 March: refuse a day the calendar does not have.
  if (new Date(d.getTime() + PKT_OFFSET_MS).toISOString().slice(0, 10) !== date) return null
  return d.toISOString()
}

/** Plain words for a booking the reservation policy refused; null when it is not one of these. */
function policyRefusalText(code: string, message: string, opts: { minAdvanceHours?: number | null; canWalkIn?: boolean } = {}): string | null {
  const n = (re: RegExp) => { const m = re.exec(message); return m ? Number(m[1]) : null }
  switch (code) {
    case 'TOO_SOON': {
      const h = opts.minAdvanceHours ?? n(/at least (\d+) hours?/)
      const notice = h == null ? 'more notice' : `at least ${h} hour${h === 1 ? '' : 's'}’ notice`
      return `Bookings need ${notice} — pick a later time${opts.canWalkIn ? ', or tick Walk-in for a party being seated now' : ''}.`
    }
    case 'TOO_FAR': {
      const d = n(/more than (\d+) days/)
      return `That is too far ahead — bookings open ${d == null ? 'a limited number of' : d} days in advance. Pick an earlier date.`
    }
    case 'PARTY_TOO_LARGE': {
      const max = n(/Maximum party size is (\d+)/)
      return `That party is larger than one booking takes${max == null ? '' : ` (at most ${max})`}. Split it into two bookings, or a manager raises the limit in Reservation policy.`
    }
    case 'WALKINS_DISABLED':
      return 'Walk-ins are switched off for this restaurant — untick Walk-in and book it for a time, or a manager turns walk-ins on in Reservation policy.'
    default: return null
  }
}
// </booking-policy-helpers>

const ACTION_PATH: Record<string, string> = {
  confirmed: 'confirm', seated: 'seat', cancelled: 'cancel', 'no-show': 'no-show',
}

export default function ReservationsScreen() {
  const qc = useQueryClient()
  const [filter, setFilter] = useState<'all' | 'pending' | 'seated' | 'no-show'>('all')
  const [showNew, setShowNew] = useState(false)

  const q = useQuery({
    queryKey: ['reservations', 'today'],
    queryFn:  async () => (await api.get<ApiReservation[]>(`/reservations?date=${todayPkt()}`)).map(toRow),
    refetchInterval: 60_000,
  })

  // Refetch on any reservation event.
  useSocketEvent('reservation:created',           () => qc.invalidateQueries({ queryKey: ['reservations'] }))
  useSocketEvent('reservation:updated',           () => qc.invalidateQueries({ queryKey: ['reservations'] }))
  useSocketEvent('reservation:cancelled',         () => qc.invalidateQueries({ queryKey: ['reservations'] }))
  useSocketEvent('reservation:seated',            () => qc.invalidateQueries({ queryKey: ['reservations'] }))
  useSocketEvent('reservation:no-show',           () => qc.invalidateQueries({ queryKey: ['reservations'] }))
  useSocketEvent('reservation:confirmed',         () => qc.invalidateQueries({ queryKey: ['reservations'] }))
  useSocketEvent('reservation:waitlist-promoted', () => qc.invalidateQueries({ queryKey: ['reservations'] }))

  const transition = useMutation({
    mutationFn: ({ id, to }: { id: string; to: string }) =>
      api.post(`/reservations/${id}/${ACTION_PATH[to] ?? to}`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['reservations'] }),
    onError:   (err: Error) => Alert.alert('Hmm', err.message),
  })

  const reservations = (q.data ?? []).filter(r =>
    filter === 'all' ? true
    : filter === 'pending'  ? r.status === 'pending' || r.status === 'confirmed'
    : r.status === filter,
  )

  // Sort by start time
  const sorted = [...reservations].sort((a, b) => a.startTime.localeCompare(b.startTime))

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }}>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
        <Text style={{ color: theme.text, fontWeight: '900', fontSize: 26 }}>Reservations</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <Text style={{ color: theme.textDim, fontSize: 14 }}>
            {new Date().toLocaleDateString('en-PK', { weekday: 'long', month: 'long', day: 'numeric' })}
          </Text>
          <Button label="New booking" intent="primary" size="md" onPress={() => setShowNew(true)} />
        </View>
      </View>
      {showNew && (
        <NewBookingSheet
          onClose={() => setShowNew(false)}
          onBooked={() => void qc.invalidateQueries({ queryKey: ['reservations'] })}
        />
      )}

      <View style={{ flexDirection: 'row', gap: 8, marginBottom: 16 }}>
        {(['all', 'pending', 'seated', 'no-show'] as const).map(f => (
          <Pressable
            key={f}
            onPress={() => setFilter(f)}
            style={{
              paddingHorizontal: 14, paddingVertical: 8,
              borderRadius: 999, borderWidth: 1,
              borderColor: filter === f ? theme.accent : theme.border,
              backgroundColor: filter === f ? theme.accent : 'transparent',
            }}>
            <Text style={{
              color: filter === f ? '#0a0a0a' : theme.text,
              fontWeight: '700', fontSize: 13, letterSpacing: 0.5,
            }}>{f.toUpperCase()}</Text>
          </Pressable>
        ))}
      </View>

      {sorted.length === 0 ? (
        <Panel><Text style={{ color: theme.textMuted, textAlign: 'center', padding: 32 }}>No reservations match.</Text></Panel>
      ) : sorted.map(r => (
        <ReservationRow key={r.id} r={r}
          onSeat={() => transition.mutate({ id: r.id, to: 'seated' })}
          onNoShow={() => Alert.alert('Mark no-show?', 'This will record a strike on the customer\'s account.', [
            { text: 'Cancel', style: 'cancel' },
            { text: 'No-show', style: 'destructive', onPress: () => transition.mutate({ id: r.id, to: 'no-show' }) },
          ])}
          onConfirm={() => transition.mutate({ id: r.id, to: 'confirmed' })}
          onCancel={() => transition.mutate({ id: r.id, to: 'cancelled' })}
        />
      ))}
    </ScrollView>
  )
}

function ReservationRow({ r, onSeat, onNoShow, onConfirm, onCancel }: {
  r: Reservation
  onSeat: () => void
  onNoShow: () => void
  onConfirm: () => void
  onCancel: () => void
}) {
  const statusTone =
    r.status === 'seated'    ? 'success' :
    r.status === 'confirmed' ? 'info' :
    r.status === 'no-show'   ? 'danger' :
    r.status === 'cancelled' ? 'neutral' : 'warn'

  return (
    <View style={{
      backgroundColor: theme.panel, borderRadius: theme.radius,
      borderWidth: 1, borderColor: r.isBanned ? theme.danger : theme.border,
      padding: 14, marginBottom: 10,
      flexDirection: 'row', alignItems: 'center', gap: 16,
    }}>
      {/* Time block */}
      <View style={{ alignItems: 'center', width: 80 }}>
        <Text style={{ color: theme.text, fontWeight: '900', fontSize: 20 }}>{shortTime(r.startTime)}</Text>
        <Text style={{ color: theme.textDim, fontSize: 12 }}>party of {r.partySize}</Text>
      </View>

      <View style={{ width: 1, height: 40, backgroundColor: theme.border }} />

      {/* Customer + meta */}
      <View style={{ flex: 1, gap: 4 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Text style={{ color: theme.text, fontWeight: '800', fontSize: 16 }}>{r.customerName}</Text>
          <Pill label={r.conceptName} />
          <Pill label={r.status.toUpperCase()} tone={statusTone as never} />
          {r.isWaitlist && <Pill label="WAITLIST" tone="warn" />}
          {r.isBanned && <Pill label="🚫 BANNED" tone="danger" />}
          {(r.strikeCount ?? 0) > 0 && !r.isBanned && (
            <Pill label={`⚠ ${r.strikeCount}/3`} tone="warn" />
          )}
        </View>
        <Text style={{ color: theme.textDim, fontSize: 13 }}>
          {r.customerPhone}
          {r.tableId && ` · Table ${r.tableId}`}
          {r.depositCents && ` · Deposit Rs ${Math.round(r.depositCents/100).toLocaleString('en-PK')}`}
        </Text>
        {r.notes && <Text style={{ color: theme.warn, fontSize: 13, fontStyle: 'italic' }}>{r.notes}</Text>}
      </View>

      {/* Actions */}
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {r.status === 'pending' && <Button label="Confirm" size="md" intent="ghost" onPress={onConfirm} />}
        {(r.status === 'pending' || r.status === 'confirmed') && (
          <>
            <Button label="Seat" intent="primary" size="md" onPress={onSeat} />
            <Button label="No-show" intent="danger" size="md" onPress={onNoShow} />
          </>
        )}
        {r.status === 'seated' && <Pill label="ON FLOOR" tone="success" />}
      </View>
    </View>
  )
}

// ─── New booking sheet ───────────────────────────────────────────────────────

interface Brand { id: string; name: string }
interface ReservationPolicy { minAdvanceHours: number; maxAdvanceDays: number; maxPartySize: number; walkInsAllowed: boolean }

function NewBookingSheet({ onClose, onBooked }: { onClose: () => void; onBooked: () => void }) {
  const brands = useQuery({
    queryKey: ['reservation-brands'],
    queryFn: () => api.get<Brand[]>('/concepts?view=picker'),
    staleTime: 60_000,
  })
  const [conceptId, setConceptId] = useState<string | null>(null)
  useEffect(() => { if (!conceptId && brands.data?.[0]) setConceptId(brands.data[0].id) }, [brands.data, conceptId])
  const [guestName, setGuestName] = useState('')
  const [guestPhone, setGuestPhone] = useState('')
  const [party, setParty] = useState('2')
  // The active company's policy (a brand of another company may have its own;
  // the server's answer is then shown in plain words).
  const policy = useQuery({
    queryKey: ['reservation-policy'],
    queryFn: () => api.get<ReservationPolicy>('/setup/reservation-policy'),
    staleTime: 5 * 60_000,
  })
  const minAdvanceHours = policy.data?.minAdvanceHours ?? null
  const [slot, setSlot] = useState(() => defaultBookingSlot(DEFAULT_MIN_ADVANCE_HOURS))
  const [slotTouched, setSlotTouched] = useState(false)
  // Until the host picks a time, the default follows the real notice period.
  useEffect(() => {
    if (!slotTouched && minAdvanceHours != null) setSlot(defaultBookingSlot(minAdvanceHours))
  }, [minAdvanceHours, slotTouched])
  const date = slot.date
  const time = slot.time
  const setDate = (v: string) => { setSlotTouched(true); setSlot((s) => ({ ...s, date: v })) }
  const setTime = (v: string) => { setSlotTouched(true); setSlot((s) => ({ ...s, time: v })) }
  const shiftDay = (days: number) => {
    const base = new Date(`${todayPkt()}T00:00:00Z`).getTime() + days * 86_400_000
    setDate(new Date(base).toISOString().slice(0, 10))
  }
  const [walkIn, setWalkIn] = useState(false)
  const [notes, setNotes] = useState('')
  const [slotFull, setSlotFull] = useState<SlotFull | null>(null)
  const [reason, setReason] = useState('')
  const [pin, setPin] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [booked, setBooked] = useState<CreatedBooking | null>(null)

  const partySize = parseInt(party, 10)
  const startIso = walkIn ? null : bookingStartIso(date, time)
  const timeOk = walkIn || startIso != null
  const formOk = !!conceptId && guestName.trim().length > 0 && Number.isInteger(partySize) && partySize >= 1 && partySize <= 50 && timeOk
  const reasonOk = reason.trim().length >= 3 && reason.trim().length <= 300
  const pinOk = !slotFull?.managerRequired || (pin.trim().length >= 4 && pin.trim().length <= 8)

  // A change to when / who is a new question: drop the overbook prompt.
  useEffect(() => { setSlotFull(null) }, [conceptId, party, date, time, walkIn])

  const create = useMutation({
    mutationFn: (overbook: boolean) => api.post<CreatedBooking>('/reservations', {
      conceptId,
      partySize,
      startTime: walkIn ? new Date().toISOString() : startIso,
      durationMin: 90,
      guestName: guestName.trim(),
      guestPhone: guestPhone.trim() || null,
      notes: notes.trim() || null,
      source: walkIn ? 'walkin' : 'staff',
      ...(overbook && slotFull && {
        overbook: true,
        overbookReason: reason.trim(),
        ...(slotFull.managerRequired && pin.trim() && { managerOverridePin: pin.trim() }),
      }),
    }),
    onSuccess: (r) => { setErr(null); setSlotFull(null); setPin(''); setBooked(r); onBooked() },
    onError: (e: unknown, overbook) => {
      setPin('')
      const full = slotFullOf(e)
      const code = errorOf(e).code
      if (overbook && ['MANAGER_PIN_LOCKED', 'INVALID_MANAGER_PIN', 'MANAGER_OVERRIDE_REQUIRED'].includes(code)) {
        setErr(bookingErrorText(e, minAdvanceHours)); return
      }
      if (full) { setSlotFull(full); setErr(null); return }
      setSlotFull(null)
      setErr(bookingErrorText(e, minAdvanceHours))
    },
  })

  const input = {
    color: theme.text, backgroundColor: theme.panelAlt,
    borderWidth: 1, borderColor: theme.border, borderRadius: 12,
    padding: 12, fontSize: 16,
  } as const
  const label = { color: theme.textDim, fontWeight: '700', fontSize: 12, letterSpacing: 1, marginBottom: 4 } as const

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <Pressable onPress={onClose} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <Pressable onPress={() => undefined} style={{
          backgroundColor: theme.panel, borderRadius: theme.radiusLg,
          borderWidth: 1, borderColor: theme.borderHi, padding: 24,
          width: 620, maxWidth: '100%', maxHeight: '95%',
        }}>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ gap: 12 }}>
            <Text style={{ color: theme.text, fontWeight: '900', fontSize: 24 }}>{booked ? 'Booking made' : 'New booking'}</Text>

            {booked ? (
              <>
                <Text style={{ color: theme.text, fontSize: 16 }}>{guestName.trim()} · party of {partySize}</Text>
                <Text style={{ color: booked.overbooked ? theme.warn : theme.text, fontSize: 16 }}>{bookedLine(booked)}</Text>
                <View style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
                  <Button label="Done" intent="primary" onPress={onClose} />
                </View>
              </>
            ) : (
              <>
                <View>
                  <Text style={label}>BRAND</Text>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                    {(brands.data ?? []).map((b) => (
                      <Pressable key={b.id} onPress={() => setConceptId(b.id)} style={{
                        paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: 1,
                        borderColor: conceptId === b.id ? theme.accent : theme.border,
                        backgroundColor: conceptId === b.id ? theme.accent : 'transparent',
                      }}>
                        <Text style={{ color: conceptId === b.id ? '#0a0a0a' : theme.text, fontWeight: '700', fontSize: 13 }}>{b.name}</Text>
                      </Pressable>
                    ))}
                    {brands.isLoading && <Text style={{ color: theme.textMuted }}>Loading brands…</Text>}
                  </View>
                </View>
                <View>
                  <Text style={label}>GUEST NAME</Text>
                  <TextInput value={guestName} onChangeText={setGuestName} placeholder="Name" placeholderTextColor={theme.textMuted} style={input} />
                </View>
                <View style={{ flexDirection: 'row', gap: 12 }}>
                  <View style={{ flex: 2 }}>
                    <Text style={label}>PHONE</Text>
                    <TextInput value={guestPhone} onChangeText={setGuestPhone} placeholder="+92 …" placeholderTextColor={theme.textMuted} keyboardType="phone-pad" style={input} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={label}>PARTY</Text>
                    <TextInput value={party} onChangeText={setParty} keyboardType="number-pad" maxLength={2} style={input} />
                  </View>
                </View>
                <View style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-end' }}>
                  <View style={{ flex: 2 }}>
                    <Text style={label}>DATE</Text>
                    <TextInput value={walkIn ? 'Today' : date} onChangeText={setDate} editable={!walkIn} placeholder="2026-10-14" placeholderTextColor={theme.textMuted} maxLength={10} style={[input, walkIn && { opacity: 0.5 }]} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={label}>TIME</Text>
                    <TextInput value={walkIn ? 'Now' : time} onChangeText={setTime} editable={!walkIn} placeholder="19:30" placeholderTextColor={theme.textMuted} maxLength={5} style={[input, walkIn && { opacity: 0.5 }]} />
                  </View>
                  {!walkIn && (
                    <View style={{ flexDirection: 'row', gap: 6, paddingBottom: 4 }}>
                      <Button label="Today" size="md" intent="ghost" onPress={() => shiftDay(0)} />
                      <Button label="Tomorrow" size="md" intent="ghost" onPress={() => shiftDay(1)} />
                    </View>
                  )}
                </View>
                {!walkIn && !timeOk && (
                  <Text style={{ color: theme.warn, fontSize: 13 }}>Date as YYYY-MM-DD and time as HH:MM (24-hour), Karachi time.</Text>
                )}
                {!walkIn && minAdvanceHours != null && minAdvanceHours > 0 && (
                  <Text style={{ color: theme.textDim, fontSize: 13 }}>
                    Bookings need at least {minAdvanceHours} hour{minAdvanceHours === 1 ? '' : 's'}’ notice. For a party being seated now, tick Walk-in.
                  </Text>
                )}
                <Pressable onPress={() => setWalkIn(!walkIn)} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <View style={{ width: 22, height: 22, borderRadius: 6, borderWidth: 2, borderColor: walkIn ? theme.accent : theme.borderHi, backgroundColor: walkIn ? theme.accent : 'transparent' }} />
                  <Text style={{ color: theme.text, fontSize: 15 }}>Walk-in, seating now</Text>
                </Pressable>
                <View>
                  <Text style={label}>NOTES</Text>
                  <TextInput value={notes} onChangeText={setNotes} placeholder="Allergies, occasion, requests" placeholderTextColor={theme.textMuted} style={input} />
                </View>

                {slotFull && (
                  <View style={{ borderWidth: 1, borderColor: theme.warn, borderRadius: 12, padding: 12, gap: 8 }}>
                    <Text style={{ color: theme.warn, fontWeight: '800' }}>No table fits this booking</Text>
                    <Text style={{ color: theme.text, fontSize: 14 }}>{slotFull.message}</Text>
                    <Text style={{ color: theme.textDim, fontSize: 13 }}>
                      A manager can book it past capacity anyway (for example tables pushed together).
                      {slotFull.managerRequired ? ' Enter the manager’s PIN and the reason.' : ' Say why.'} It is recorded with the reason.
                    </Text>
                    <View>
                      <Text style={label}>REASON</Text>
                      <TextInput value={reason} onChangeText={setReason} maxLength={300} placeholder="e.g. Regular, two 4-tops pushed together" placeholderTextColor={theme.textMuted} style={input} />
                    </View>
                    {slotFull.managerRequired && (
                      <View>
                        <Text style={label}>MANAGER PIN</Text>
                        <TextInput value={pin} onChangeText={setPin} secureTextEntry keyboardType="number-pad" maxLength={8} style={[input, { width: 160 }]} />
                      </View>
                    )}
                  </View>
                )}

                {err && <Text style={{ color: theme.danger, fontSize: 14 }}>{err}</Text>}

                <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 8 }}>
                  <Button label="Cancel" intent="ghost" onPress={onClose} />
                  {slotFull ? (
                    <Button label="Book past capacity" intent="warn" busy={create.isPending}
                      disabled={!formOk || !reasonOk || !pinOk} onPress={() => create.mutate(true)} />
                  ) : (
                    <Button label="Book" intent="primary" busy={create.isPending}
                      disabled={!formOk} onPress={() => create.mutate(false)} />
                  )}
                </View>
              </>
            )}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  )
}
