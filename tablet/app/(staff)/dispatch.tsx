// Dispatch / rider tracking. Two lanes:
//   - Unassigned (active delivery orders, no rider yet)
//   - With rider (assigned, not yet delivered)
// Tap a rider chip to assign; "Delivered" once the kitchen has finished.
//
// Reads the same endpoints as the admin: GET /orders for the active non-till
// orders and GET /dispatch/board for the riders. Every write goes through
// /dispatch — the one set of rider rules (same company, active, not offline,
// the rider freed after their last drop). This screen used to call
// GET /dispatch/orders and GET /dispatch/riders, which never existed, so both
// lists were always empty.

import { View, Text, ScrollView, Pressable, Alert } from 'react-native'
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'

import { api } from '../../src/lib/api'
import { useSocketEvent } from '../../src/lib/socket'
import { theme } from '../../src/lib/theme'
import { pkr, elapsed } from '../../src/lib/format'
import { Panel, Pill } from '../../src/components/Panel'

// GET /dispatch/board
interface BoardRider {
  id: string
  name: string
  status: 'available' | 'busy' | 'offline'
  orders: Array<{ id: string }>
}

// GET /orders (list shape)
interface ActiveOrder {
  id: string
  status: string
  source: string
  customerName: string | null
  deliveryNotes: string | null
  totalCents: number
  placedAt: string
  riderId: string | null
  rider?: { id: string; name: string; phone: string } | null
  concept: { name: string }
  payments: Array<{ method: string; status: string }>
}

export default function DispatchScreen() {
  const qc = useQueryClient()

  const orders = useQuery({
    queryKey: ['dispatch', 'orders'],
    queryFn:  () => api.get<{ data: ActiveOrder[] }>('/orders?status=received,confirmed,preparing,ready&limit=50'),
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

  // Till orders are handed over the counter — only the rest need a rider.
  const o = (orders.data?.data ?? []).filter(x => x.source !== 'pos')
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
          {o.length} active · {idleRiders.length} available riders
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
          {lanes.withRider.map(order => (
            <OrderCard key={order.id} order={order} riders={[]} onAssign={() => undefined}
              onDelivered={order.status === 'ready' ? () => delivered.mutate(order.id) : undefined} />
          ))}
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

function OrderCard({ order, riders, onAssign, onDelivered }: {
  order: ActiveOrder
  riders: BoardRider[]
  onAssign: (riderId: string) => void
  onDelivered?: () => void
}) {
  // Cash still owed at the door: a pending cash payment.
  const cod = order.payments.some(p => p.method === 'cash' && p.status === 'pending')
  return (
    <View style={{
      backgroundColor: theme.panel, borderRadius: theme.radius,
      borderWidth: 1, borderColor: theme.border, padding: 12,
    }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
        <Text style={{ color: theme.text, fontWeight: '900', fontSize: 18 }}>#{order.id.slice(-6).toUpperCase()}</Text>
        <Text style={{ color: theme.textDim, fontSize: 12 }}>{elapsed(order.placedAt)}</Text>
      </View>
      <Text style={{ color: theme.text, fontWeight: '700', fontSize: 14 }}>{order.customerName ?? 'Guest'} · {order.concept.name}</Text>
      <Text style={{ color: theme.textDim, fontSize: 12 }} numberOfLines={2}>{order.deliveryNotes ?? 'No address'}</Text>

      <View style={{ flexDirection: 'row', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
        <Pill label={order.status} />
        <Pill label={pkr(order.totalCents)} tone="info" />
        {cod && <Pill label="COD" tone="warn" />}
      </View>

      {order.rider && (
        <View style={{ marginTop: 10, padding: 8, backgroundColor: theme.panelAlt, borderRadius: 8 }}>
          <Text style={{ color: theme.textDim, fontSize: 11, fontWeight: '700', letterSpacing: 0.5 }}>RIDER</Text>
          <Text style={{ color: theme.text, fontWeight: '700' }}>{order.rider.name}</Text>
        </View>
      )}

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
