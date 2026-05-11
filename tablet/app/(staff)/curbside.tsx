// Curbside queue — two columns: "En route" (placed orders with curbside flag,
// customer hasn't arrived yet) and "Cars here" (customer hit the "I'm here"
// button on their phone, server hasn't walked the order out). Tap to mark
// delivered to car.

import { View, Text, ScrollView, Pressable, Alert } from 'react-native'
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'

import { api } from '../../src/lib/api'
import { useSocketEvent } from '../../src/lib/socket'
import { theme } from '../../src/lib/theme'
import { elapsed, shortTime } from '../../src/lib/format'
import { Panel, Pill } from '../../src/components/Panel'
import { Button } from '../../src/components/Button'

interface CurbsideOrder {
  id: string
  number: string
  customerName: string
  customerPhone: string
  carDescription?: string | null
  parkingSpace?: string | null
  status: 'en-route' | 'arrived' | 'delivered'
  placedAt: string
  arrivedAt?: string | null
  conceptName: string
  itemsSummary: string
}

export default function CurbsideScreen() {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['curbside'],
    queryFn:  () => api.get<{ orders: CurbsideOrder[] }>('/orders/curbside/queue'),
    refetchInterval: 30_000,
  })

  useSocketEvent('order:curbsideArrived', () => qc.invalidateQueries({ queryKey: ['curbside'] }))
  useSocketEvent('order:new',             () => qc.invalidateQueries({ queryKey: ['curbside'] }))
  useSocketEvent('order:updated',         () => qc.invalidateQueries({ queryKey: ['curbside'] }))

  const deliver = useMutation({
    mutationFn: (orderId: string) => api.post(`/orders/${orderId}/curbside/delivered`, {}),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['curbside'] }),
    onError:    (err: Error) => Alert.alert('Hmm', err.message),
  })

  const orders = q.data?.orders ?? []
  const arrived = orders.filter(o => o.status === 'arrived')
  const enRoute = orders.filter(o => o.status === 'en-route')

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }}>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 16 }}>
        <Text style={{ color: theme.text, fontWeight: '900', fontSize: 26 }}>Curbside</Text>
        <Text style={{ color: theme.textDim }}>{orders.length} active</Text>
      </View>

      <View style={{ flexDirection: 'row', gap: 16 }}>
        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: theme.accent }} />
            <Text style={{ color: theme.text, fontWeight: '900', fontSize: 16, letterSpacing: 1 }}>
              CARS HERE · {arrived.length}
            </Text>
          </View>
          {arrived.length === 0 ? (
            <Panel><Text style={{ color: theme.textMuted, textAlign: 'center', padding: 20 }}>No cars waiting.</Text></Panel>
          ) : arrived.map(o => (
            <Card key={o.id} order={o} onDeliver={() => deliver.mutate(o.id)} highlight />
          ))}
        </View>

        <View style={{ flex: 1 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: theme.info }} />
            <Text style={{ color: theme.text, fontWeight: '900', fontSize: 16, letterSpacing: 1 }}>
              EN ROUTE · {enRoute.length}
            </Text>
          </View>
          {enRoute.length === 0 ? (
            <Panel><Text style={{ color: theme.textMuted, textAlign: 'center', padding: 20 }}>Nothing on the way.</Text></Panel>
          ) : enRoute.map(o => (
            <Card key={o.id} order={o} onDeliver={() => deliver.mutate(o.id)} />
          ))}
        </View>
      </View>
    </ScrollView>
  )
}

function Card({ order, onDeliver, highlight }: { order: CurbsideOrder; onDeliver: () => void; highlight?: boolean }) {
  return (
    <View style={{
      backgroundColor: theme.panel,
      borderRadius: theme.radius,
      borderWidth: 1, borderColor: highlight ? theme.accent : theme.border,
      padding: 14, marginBottom: 12,
    }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 }}>
        <View>
          <Text style={{ color: theme.text, fontWeight: '900', fontSize: 18 }}>#{order.number}</Text>
          <Text style={{ color: theme.textDim, fontSize: 12 }}>{order.conceptName}</Text>
        </View>
        <View style={{ alignItems: 'flex-end' }}>
          {order.arrivedAt ? (
            <>
              <Text style={{ color: theme.accent, fontWeight: '900', fontSize: 18 }}>
                {elapsed(order.arrivedAt)} waiting
              </Text>
              <Text style={{ color: theme.textDim, fontSize: 11 }}>arrived {shortTime(order.arrivedAt)}</Text>
            </>
          ) : (
            <Text style={{ color: theme.textDim, fontSize: 13 }}>placed {shortTime(order.placedAt)}</Text>
          )}
        </View>
      </View>
      <Text style={{ color: theme.text, fontWeight: '700', fontSize: 15 }}>{order.customerName}</Text>
      <Text style={{ color: theme.textDim, fontSize: 13 }}>{order.customerPhone}</Text>
      {order.carDescription && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 }}>
          <Pill label="🚗" />
          <Text style={{ color: theme.text, fontSize: 13 }}>{order.carDescription}</Text>
        </View>
      )}
      {order.parkingSpace && (
        <Text style={{ color: theme.warn, fontWeight: '700', fontSize: 13, marginTop: 4 }}>
          Spot: {order.parkingSpace}
        </Text>
      )}
      <Text style={{ color: theme.textMuted, fontSize: 12, marginTop: 8, marginBottom: 12 }} numberOfLines={2}>
        {order.itemsSummary}
      </Text>
      <Button label="Mark delivered" full size="md" onPress={onDeliver} />
    </View>
  )
}
