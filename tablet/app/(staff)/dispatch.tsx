// Dispatch / rider tracking. Two lanes:
//   - Unassigned (active delivery orders, no rider yet)
//   - With rider (assigned, not yet delivered) — with the job stage the rider
//     app reports (offered → accepted → picked up → at the door)
// Tap a rider chip to assign. The rider closes a rider-app job with the
// customer's code at the door; "Delivered" here is a manager's override, only
// for a job whose code locked, a rider who is not on the app, or an order from
// before the rider app (deliverGate below).
//
// Reads the same endpoints as the admin: GET /orders for the active delivery
// orders and GET /dispatch/board for the riders. Every write goes through
// /dispatch — the one set of rider rules (the rider's own company or a fleet
// agreement, active, not offline, the rider freed after their last drop).
// This screen used to call GET /dispatch/orders and GET /dispatch/riders,
// which never existed, so both lists were always empty.
//
// Only delivery orders take a rider: the lanes filter on
// fulfilmentType === 'delivery' (they used to take every non-till order, so a
// storefront pickup could be handed to a rider). The board also lists another
// company's rider while they carry one of our orders under a fleet agreement
// (docs/rider-app.md) — marked "partner".

import { View, Text, ScrollView, Pressable, Alert } from 'react-native'
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'

import { api } from '../../src/lib/api'
import { useSessionStore } from '../../src/store/session'
import { useSocketEvent } from '../../src/lib/socket'
import { theme } from '../../src/lib/theme'
import { orderRef } from '../../src/lib/orderRef'
import { pkr, elapsed } from '../../src/lib/format'
import { Panel, Pill } from '../../src/components/Panel'

// GET /dispatch/board
interface BoardRider {
  id: string
  name: string
  status: 'available' | 'busy' | 'offline'
  fleetPartner?: boolean
  orders: Array<{ id: string }>
}

// GET /orders (list shape)
interface ActiveOrder {
  id: string
  status: string
  source: string
  fulfilmentType: string
  customerName: string | null
  deliveryNotes: string | null
  totalCents: number
  placedAt: string
  riderId: string | null
  riderAssignedAt?: string | null
  riderAcceptedAt?: string | null
  pickedUpAt?: string | null
  arrivedAt?: string | null
  /** Wrong hand-over codes so far (locks at OTP_MAX_ATTEMPTS). */
  deliveryOtpAttempts?: number
  rider?: { id: string; name: string; phone: string } | null
  concept: { name: string }
  payments: Array<{ method: string; status: string }>
}

// Where a rider-carried order is, from its timestamps (the rider app's flow).
const STAGE: Record<string, { label: string; tone: 'warn' | 'info' | 'success' }> = {
  offered:   { label: 'OFFERED',     tone: 'warn' },
  accepted:  { label: 'ACCEPTED',    tone: 'info' },
  picked_up: { label: 'PICKED UP',   tone: 'info' },
  arrived:   { label: 'AT THE DOOR', tone: 'success' },
}
function jobStage(o: ActiveOrder): keyof typeof STAGE | null {
  // No rider, or an API without the job timestamps: no stage to show.
  if (!o.riderId || !('riderAssignedAt' in o)) return null
  if (o.arrivedAt) return 'arrived'
  if (o.pickedUpAt) return 'picked_up'
  if (o.riderAcceptedAt) return 'accepted'
  return 'offered'
}

/** Wrong hand-over codes before the job locks — DELIVERY_OTP_MAX_ATTEMPTS in backend lib/deliveryOtp.ts. */
const OTP_MAX_ATTEMPTS = 5
/** The API's MANAGERS (backend modules/auth/middleware.ts). */
const MANAGER_ROLES = new Set(['admin', 'owner', 'manager', 'management', 'foh_management', 'boh_management', 'fnb_manager'])

/**
 * Whether this screen may mark a delivery delivered (docs/rider-app.md, "The
 * hand-over code" — it is what stops anyone delivering without going to the
 * door). Only a manager, and only when the code has locked after
 * OTP_MAX_ATTEMPTS wrong tries, the rider never took the job in the app, or
 * the order predates the rider app.
 */
function deliverGate(o: ActiveOrder, isManager: boolean): { canMark: boolean; locked: boolean; note: string | null } {
  if (o.status !== 'ready') return { canMark: false, locked: false, note: null }
  const locked = (o.deliveryOtpAttempts ?? 0) >= OTP_MAX_ATTEMPTS
  const inApp = !!o.riderAssignedAt && !!o.riderAcceptedAt
  if (inApp && !locked) return { canMark: false, locked, note: "Rider closes it with the customer's code." }
  if (!isManager) {
    return { canMark: false, locked, note: locked ? 'Code locked — a manager marks it delivered.' : 'A manager marks it delivered.' }
  }
  return { canMark: true, locked, note: locked ? `Code locked after ${OTP_MAX_ATTEMPTS} wrong tries.` : null }
}

export default function DispatchScreen() {
  const qc = useQueryClient()
  const role = useSessionStore(s => s.user?.role)
  const isManager = MANAGER_ROLES.has(role ?? '')

  const orders = useQuery({
    queryKey: ['dispatch', 'orders'],
    // The list API has no fulfilment filter: take its maximum page so a busy
    // dine-in floor can't push deliveries off it, then keep the deliveries.
    queryFn:  () => api.get<{ data: ActiveOrder[] }>('/orders?status=received,confirmed,preparing,ready&limit=200'),
    refetchInterval: 20_000,
  })

  const riders = useQuery({
    queryKey: ['dispatch', 'riders'],
    queryFn:  () => api.get<BoardRider[]>('/dispatch/board'),
    refetchInterval: 20_000,
  })

  useSocketEvent('order:updated', () => qc.invalidateQueries({ queryKey: ['dispatch'] }))
  useSocketEvent('rider:location', () => qc.invalidateQueries({ queryKey: ['dispatch', 'riders'] }))

  const assign = useMutation({
    mutationFn: ({ orderId, riderId }: { orderId: string; riderId: string }) =>
      api.post(`/dispatch/orders/${orderId}/assign`, { riderId }),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['dispatch'] }),
    onError:    (err: Error) => Alert.alert('Hmm', err.message),
  })

  const delivered = useMutation({
    mutationFn: (orderId: string) => api.post(`/dispatch/orders/${orderId}/delivered`, {}),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['dispatch'] }),
    onError:    (err: Error) => Alert.alert('Hmm', err.message),
  })

  // A manager closing a delivery without the customer's code (deliverGate).
  function confirmDelivered(order: ActiveOrder) {
    Alert.alert(
      'Mark delivered without the code?',
      'Only do this once you have confirmed with the customer that they have the food.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Mark delivered', style: 'destructive', onPress: () => delivered.mutate(order.id) },
      ],
    )
  }

  // Only delivery orders need a rider (pickup and table orders never do,
  // whichever channel they came in on).
  const o = (orders.data?.data ?? []).filter(x => x.fulfilmentType === 'delivery')
  const lanes = {
    unassigned: o.filter(x => !x.riderId),
    withRider:  o.filter(x => !!x.riderId),
  }

  const roster = riders.data ?? []
  const idleRiders = roster.filter(r => r.status === 'available')

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }}>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
        <Text style={{ color: theme.text, fontWeight: '900', fontSize: 26 }}>Dispatch</Text>
        <Text style={{ color: theme.textDim }}>
          {o.length} active {o.length === 1 ? 'delivery' : 'deliveries'} · {idleRiders.length} available riders
        </Text>
      </View>

      {/* Rider roster strip */}
      <Panel style={{ marginBottom: 16 }}>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          {roster.map(r => (
            <View key={r.id} style={{
              paddingHorizontal: 12, paddingVertical: 8,
              borderRadius: 999, borderWidth: 1,
              borderColor:
                r.status === 'available' ? theme.accent :
                r.status === 'busy' ? theme.warn : theme.border,
              flexDirection: 'row', gap: 8, alignItems: 'center',
            }}>
              <View style={{
                width: 8, height: 8, borderRadius: 4,
                backgroundColor:
                  r.status === 'available' ? theme.accent :
                  r.status === 'busy' ? theme.warn : theme.textMuted,
              }} />
              <Text style={{ color: theme.text, fontWeight: '700', fontSize: 13 }}>{r.name}</Text>
              {r.fleetPartner && (
                <Text style={{ color: theme.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 0.5 }}>PARTNER</Text>
              )}
              {r.status !== 'offline' && (
                <Text style={{ color: theme.textDim, fontSize: 11 }}>
                  {r.orders.length > 0 ? `${r.orders.length} active` : 'available'}
                </Text>
              )}
            </View>
          ))}
          {roster.length === 0 && (
            <Text style={{ color: theme.textMuted, padding: 8 }}>No riders on shift.</Text>
          )}
        </View>
      </Panel>

      <View style={{ flexDirection: 'row', gap: 16 }}>
        <Lane title="UNASSIGNED" count={lanes.unassigned.length} tone="danger">
          {lanes.unassigned.map(order => (
            <OrderCard key={order.id} order={order} riders={idleRiders}
              onAssign={(riderId) => assign.mutate({ orderId: order.id, riderId })} />
          ))}
        </Lane>
        <Lane title="WITH RIDER" count={lanes.withRider.length} tone="warn">
          {lanes.withRider.map(order => {
            const gate = deliverGate(order, isManager)
            return (
              <OrderCard key={order.id} order={order} riders={[]} onAssign={() => undefined}
                deliverNote={gate.note} deliverLocked={gate.locked}
                onDelivered={gate.canMark ? () => confirmDelivered(order) : undefined} />
            )
          })}
        </Lane>
      </View>
    </ScrollView>
  )
}

function Lane({ title, count, tone, children }: {
  title: string
  count: number
  tone: 'danger' | 'warn' | 'info'
  children: React.ReactNode
}) {
  const dot = tone === 'danger' ? theme.danger : tone === 'warn' ? theme.warn : theme.info
  return (
    <View style={{ flex: 1, minWidth: 0 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: dot }} />
        <Text style={{ color: theme.text, fontWeight: '900', fontSize: 13, letterSpacing: 1 }}>{title} · {count}</Text>
      </View>
      <View style={{ gap: 10 }}>
        {count === 0
          ? <Panel><Text style={{ color: theme.textMuted, padding: 16, textAlign: 'center' }}>Empty.</Text></Panel>
          : children}
      </View>
    </View>
  )
}

function OrderCard({ order, riders, onAssign, onDelivered, deliverNote, deliverLocked }: {
  order: ActiveOrder
  riders: BoardRider[]
  onAssign: (riderId: string) => void
  onDelivered?: () => void
  deliverNote?: string | null
  deliverLocked?: boolean
}) {
  // Cash still owed at the door: a pending cash payment.
  const cod = order.payments.some(p => p.method === 'cash' && p.status === 'pending')
  const stage = jobStage(order)
  return (
    <View style={{
      backgroundColor: theme.panel, borderRadius: theme.radius,
      borderWidth: 1, borderColor: theme.border, padding: 12,
    }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
        <Text style={{ color: theme.text, fontWeight: '900', fontSize: 18 }}>#{orderRef(order.id)}</Text>
        <Text style={{ color: theme.textDim, fontSize: 12 }}>{elapsed(order.placedAt)}</Text>
      </View>
      <Text style={{ color: theme.text, fontWeight: '700', fontSize: 14 }}>{order.customerName ?? 'Guest'} · {order.concept.name}</Text>
      <Text style={{ color: theme.textDim, fontSize: 12 }} numberOfLines={2}>{order.deliveryNotes ?? 'No address'}</Text>

      <View style={{ flexDirection: 'row', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
        <Pill label={order.status} />
        <Pill label={pkr(order.totalCents)} tone="info" />
        {cod && <Pill label="COD" tone="warn" />}
        {stage && <Pill label={STAGE[stage]!.label} tone={STAGE[stage]!.tone} />}
      </View>

      {order.rider && (
        <View style={{ marginTop: 10, padding: 8, backgroundColor: theme.panelAlt, borderRadius: 8 }}>
          <Text style={{ color: theme.textDim, fontSize: 11, fontWeight: '700', letterSpacing: 0.5 }}>RIDER</Text>
          <Text style={{ color: theme.text, fontWeight: '700' }}>{order.rider.name}</Text>
        </View>
      )}

      {deliverNote ? (
        <Text style={{ marginTop: 8, color: deliverLocked ? theme.danger : theme.textDim, fontSize: 12, fontWeight: '700' }}>
          {deliverNote}
        </Text>
      ) : null}

      {onDelivered && (
        <Pressable
          onPress={onDelivered}
          style={({ pressed }) => ({
            marginTop: 10, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: theme.accent,
            alignItems: 'center', backgroundColor: pressed ? theme.accent : 'rgba(34,197,94,0.12)',
          })}>
          <Text style={{ color: theme.text, fontWeight: '800', fontSize: 13 }}>Delivered</Text>
        </Pressable>
      )}

      {!order.riderId && riders.length > 0 && (
        <View style={{ marginTop: 10 }}>
          <Text style={{ color: theme.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 0.5, marginBottom: 6 }}>
            ASSIGN TO
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
            {riders.map(r => (
              <Pressable
                key={r.id}
                onPress={() => onAssign(r.id)}
                style={({ pressed }) => ({
                  paddingHorizontal: 10, paddingVertical: 6,
                  borderRadius: 8, borderWidth: 1, borderColor: theme.accent,
                  backgroundColor: pressed ? theme.accent : 'rgba(34,197,94,0.12)',
                })}>
                <Text style={{ color: theme.text, fontWeight: '700', fontSize: 13 }}>{r.name}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      )}
    </View>
  )
}
