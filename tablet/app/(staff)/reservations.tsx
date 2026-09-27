// Host stand day view. Today's bookings in time-slot rows, seat / no-show /
// arrived buttons inline. Real-time sync via socket so two host iPads stay in
// lock-step.
//
// Same API as the admin /reservations page: GET /reservations?date= (PKT day)
// and POST /reservations/:id/confirm|seat|cancel|no-show. A no-show goes
// through the one no-show path (deposit capture, strike, waitlist promotion).
// This screen used to call /reservations/today and /reservations/:id/transition,
// neither of which exists.

import { useState } from 'react'
import { View, Text, ScrollView, Pressable, Alert, TextInput } from 'react-native'
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'

import { api } from '../../src/lib/api'
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

const ACTION_PATH: Record<string, string> = {
  confirmed: 'confirm', seated: 'seat', cancelled: 'cancel', 'no-show': 'no-show',
}

export default function ReservationsScreen() {
  const qc = useQueryClient()
  const [filter, setFilter] = useState<'all' | 'pending' | 'seated' | 'no-show'>('all')

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
        <Text style={{ color: theme.textDim, fontSize: 14 }}>
          {new Date().toLocaleDateString('en-PK', { weekday: 'long', month: 'long', day: 'numeric' })}
        </Text>
      </View>

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
