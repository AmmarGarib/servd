// Curbside queue — two columns: "En route" (placed orders with curbside flag,
// customer hasn't arrived yet) and "Cars here" (customer hit the "I'm here"
// button on their phone, server hasn't walked the order out). Tap when a
// runner takes the bag out to the car.
//
// Same API as the admin /orders/curbside screen: GET /orders/curbside and
// POST /orders/:id/curbside/running-out. This screen used to call
// /orders/curbside/queue and /orders/:id/curbside/delivered, neither of which
// exists.

import { View, Text, ScrollView, Pressable, Alert } from 'react-native'
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'

import { api } from '../../src/lib/api'
import { useSocketEvent } from '../../src/lib/socket'
import { theme } from '../../src/lib/theme'
import { elapsed, shortTime, pkr } from '../../src/lib/format'
import { Panel, Pill } from '../../src/components/Panel'
import { Button } from '../../src/components/Button'

interface CurbsideRow {
  id: string
  status: string
  totalCents: number
  placedAt: string
  customerName: string | null
  curbsideVehicle: string | null
  curbsidePlate: string | null
  curbsideSpot: string | null
  curbsideArrivedAt: string | null
  concept: { name: string; slug: string }
}
interface CurbsideResp { arrived: CurbsideRow[]; enRoute: CurbsideRow[] }

interface CurbsideOrder {
  id: string
  number: string
  customerName: string
  carDescription?: string | null
  parkingSpace?: string | null
  placedAt: string
  arrivedAt?: string | null
  conceptName: string
  summary: string
}

function toCard(r: CurbsideRow): CurbsideOrder {
  return {
    id: r.id,
    number: r.id.slice(0, 6).toUpperCase(),
    customerName: r.customerName ?? 'Guest',
    carDescription: [r.curbsideVehicle, r.curbsidePlate].filter(Boolean).join(' · ') || null,
    parkingSpace: r.curbsideSpot,
    placedAt: r.placedAt,
    arrivedAt: r.curbsideArrivedAt,
    conceptName: r.concept.name,
    summary: `${r.status} · ${pkr(r.totalCents)}`,
  }
}

export default function CurbsideScreen() {
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['curbside'],
    queryFn:  () => api.get<CurbsideResp>('/orders/curbside'),
    refetchInterval: 30_000,
  })

  useSocketEvent('order:curbsideArrived', () => qc.invalidateQueries({ queryKey: ['curbside'] }))
  useSocketEvent('order:new',             () => qc.invalidateQueries({ queryKey: ['curbside'] }))
  useSocketEvent('order:updated',         () => qc.invalidateQueries({ queryKey: ['curbside'] }))

  const deliver = useMutation({
    mutationFn: (orderId: string) => api.post(`/orders/${orderId}/curbside/running-out`, {}),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['curbside'] }),
    onError:    (err: Error) => Alert.alert('Hmm', err.message),
  })

  const arrived = (q.data?.arrived ?? []).map(toCard)
  const enRoute = (q.data?.enRoute ?? []).map(toCard)
  const orders = [...arrived, ...enRoute]

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
        {order.summary}
      </Text>
      <Button label="Running it out" full size="md" onPress={onDeliver} />
    </View>
  )
}
