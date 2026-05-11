// Dispatch / rider tracking. Three lanes:
//   - Unassigned (orders ready, no rider yet)
//   - In progress (assigned, en-route)
//   - Returning (back-to-shop after drop)
// Tap a rider chip to assign. We poll riders' last-known-location every 20s
// for the "x mins away" display — proper map view is on the backlog.

import { View, Text, ScrollView, Pressable, Alert } from 'react-native'
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'

import { api } from '../../src/lib/api'
import { useSocketEvent } from '../../src/lib/socket'
import { theme } from '../../src/lib/theme'
import { pkr, elapsed } from '../../src/lib/format'
import { Panel, Pill } from '../../src/components/Panel'

interface Rider {
  id: string
  name: string
  status: 'idle' | 'delivering' | 'returning' | 'off-shift'
  lastLat?: number | null
  lastLng?: number | null
  lastUpdateAt?: string | null
  activeOrderCount: number
}

interface DispatchOrder {
  id: string
  number: string
  status: 'awaiting-rider' | 'with-rider' | 'returning'
  customerName: string
  customerPhone: string
  addressLine: string
  distanceKm?: number | null
  totalCents: number
  paymentMethod: 'cod' | 'prepaid'
  riderId?: string | null
  riderName?: string | null
  placedAt: string
  assignedAt?: string | null
  conceptName: string
}

export default function DispatchScreen() {
  const qc = useQueryClient()

  const orders = useQuery({
    queryKey: ['dispatch', 'orders'],
    queryFn:  () => api.get<{ orders: DispatchOrder[] }>('/dispatch/orders'),
    refetchInterval: 20_000,
  })

  const riders = useQuery({
    queryKey: ['dispatch', 'riders'],
    queryFn:  () => api.get<{ riders: Rider[] }>('/dispatch/riders'),
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

  const o = orders.data?.orders ?? []
  const lanes = {
    unassigned: o.filter(x => x.status === 'awaiting-rider'),
    progress:   o.filter(x => x.status === 'with-rider'),
    returning:  o.filter(x => x.status === 'returning'),
  }

  const idleRiders = (riders.data?.riders ?? []).filter(r => r.status === 'idle')

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }}>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
        <Text style={{ color: theme.text, fontWeight: '900', fontSize: 26 }}>Dispatch</Text>
        <Text style={{ color: theme.textDim }}>
          {o.length} active · {idleRiders.length} idle riders
        </Text>
      </View>

      {/* Rider roster strip */}
      <Panel style={{ marginBottom: 16 }}>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          {(riders.data?.riders ?? []).map(r => (
            <View key={r.id} style={{
              paddingHorizontal: 12, paddingVertical: 8,
              borderRadius: 999, borderWidth: 1,
              borderColor:
                r.status === 'idle' ? theme.accent :
                r.status === 'delivering' ? theme.warn :
                r.status === 'returning' ? theme.info : theme.border,
              flexDirection: 'row', gap: 8, alignItems: 'center',
            }}>
              <View style={{
                width: 8, height: 8, borderRadius: 4,
                backgroundColor:
                  r.status === 'idle' ? theme.accent :
                  r.status === 'delivering' ? theme.warn :
                  r.status === 'returning' ? theme.info : theme.textMuted,
              }} />
              <Text style={{ color: theme.text, fontWeight: '700', fontSize: 13 }}>{r.name}</Text>
              {r.status !== 'off-shift' && (
                <Text style={{ color: theme.textDim, fontSize: 11 }}>
                  {r.activeOrderCount > 0 ? `${r.activeOrderCount} active` : 'idle'}
                </Text>
              )}
            </View>
          ))}
          {(riders.data?.riders ?? []).length === 0 && (
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
        <Lane title="WITH RIDER" count={lanes.progress.length} tone="warn">
          {lanes.progress.map(order => (
            <OrderCard key={order.id} order={order} riders={[]} onAssign={() => undefined} />
          ))}
        </Lane>
        <Lane title="RETURNING" count={lanes.returning.length} tone="info">
          {lanes.returning.map(order => (
            <OrderCard key={order.id} order={order} riders={[]} onAssign={() => undefined} />
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

function OrderCard({ order, riders, onAssign }: {
  order: DispatchOrder
  riders: Rider[]
  onAssign: (riderId: string) => void
}) {
  return (
    <View style={{
      backgroundColor: theme.panel, borderRadius: theme.radius,
      borderWidth: 1, borderColor: theme.border, padding: 12,
    }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
        <Text style={{ color: theme.text, fontWeight: '900', fontSize: 18 }}>#{order.number}</Text>
        <Text style={{ color: theme.textDim, fontSize: 12 }}>{elapsed(order.placedAt)}</Text>
      </View>
      <Text style={{ color: theme.text, fontWeight: '700', fontSize: 14 }}>{order.customerName}</Text>
      <Text style={{ color: theme.textDim, fontSize: 12 }} numberOfLines={2}>{order.addressLine}</Text>

      <View style={{ flexDirection: 'row', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
        {order.distanceKm != null && <Pill label={`${order.distanceKm.toFixed(1)} km`} />}
        <Pill label={pkr(order.totalCents)} tone="info" />
        {order.paymentMethod === 'cod' && <Pill label="COD" tone="warn" />}
      </View>

      {order.riderName && (
        <View style={{ marginTop: 10, padding: 8, backgroundColor: theme.panelAlt, borderRadius: 8 }}>
          <Text style={{ color: theme.textDim, fontSize: 11, fontWeight: '700', letterSpacing: 0.5 }}>RIDER</Text>
          <Text style={{ color: theme.text, fontWeight: '700' }}>{order.riderName}</Text>
        </View>
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
