// Per-station KDS — one tablet per station (cold bar / grill / fry / etc).
// Shows the work routed to this station only, from GET /expo/station/:id/queue
// — the same queue the admin /kds/<station> screen reads (D3). Recipe-step
// work is bumped with POST /expo/steps/:id/bump (which cascades to the next
// station and completes the item through the state machine); items with no
// recipe steps are bumped with PATCH /order-items/:id/status. The screen used
// to call /kds/stations/:id/items and /orders/items/:id/advance, which do not
// exist.
//
// A legacy line's `status` says what kind of work it is: pending / preparing
// (cook it), recalled (a REMAKE — the dish came back from the pass and is
// cooked again; Bump walks it through preparing on the server) and held
// (paused — only on a screen that asks for ?states=all, which this one does
// not, so the server leaves held lines off; shown, never bumpable, if sent).

import { Alert, View, Text, ScrollView, Pressable } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'

import { api } from '../../../src/lib/api'
import { useSocketEvent } from '../../../src/lib/socket'
import { theme } from '../../../src/lib/theme'
import { elapsed } from '../../../src/lib/format'
import { Panel } from '../../../src/components/Panel'

interface QueueOrder {
  id: string
  customerName: string | null
  source: string
  placedAt: string
  tableLabel: string | null
  concept: { name: string }
}
interface QueueStep {
  stepId: string; itemId: string; itemName: string; qty: number; itemNotes: string | null
  status: 'preparing' | 'waiting'; firedAt: string | null; instruction: string | null
  order: QueueOrder
}
interface QueueLegacy {
  itemId: string; itemName: string; qty: number; itemNotes: string | null
  status: LegacyStatus; firedAt: string | null
  order: QueueOrder
}
type LegacyStatus = 'pending' | 'preparing' | 'held' | 'recalled'
interface StationQueue { steps: QueueStep[]; legacy: QueueLegacy[] }

// One card on the screen, whichever way the work was routed.
interface StationItem {
  key: string
  stepId: string | null        // recipe-step work → /expo/steps/:id/bump
  itemId: string               // no-step item → /order-items/:id/status
  orderNumber: string
  conceptName: string
  menuItemName: string
  qty: number
  instruction: string | null
  notes: string | null
  lane: 'now' | 'next'
  /** recalled = a remake of a dish that came back; held = paused, not bumpable. */
  flag: 'remake' | 'held' | null
  firedAt: string | null
  placedAt: string
}

function toItems(q: StationQueue | undefined): StationItem[] {
  if (!q) return []
  return [
    ...q.steps.map((s): StationItem => ({
      key: `s:${s.stepId}`, stepId: s.stepId, itemId: s.itemId,
      orderNumber: s.order.id.slice(0, 6).toUpperCase(), conceptName: s.order.concept.name,
      menuItemName: s.itemName, qty: s.qty, instruction: s.instruction, notes: s.itemNotes,
      lane: s.status === 'waiting' ? 'next' : 'now', flag: null, firedAt: s.firedAt, placedAt: s.order.placedAt,
    })),
    ...q.legacy.map((it): StationItem => ({
      key: `i:${it.itemId}`, stepId: null, itemId: it.itemId,
      orderNumber: it.order.id.slice(0, 6).toUpperCase(), conceptName: it.order.concept.name,
      menuItemName: it.itemName, qty: it.qty, instruction: null, notes: it.itemNotes,
      lane: it.status === 'held' ? 'next' : 'now',
      flag: it.status === 'recalled' ? 'remake' : it.status === 'held' ? 'held' : null,
      firedAt: it.firedAt, placedAt: it.order.placedAt,
    })),
  ]
}

export default function KdsStationScreen() {
  const { stationId } = useLocalSearchParams<{ stationId: string }>()
  const router = useRouter()
  const qc = useQueryClient()

  const q = useQuery({
    queryKey: ['kds', 'station', stationId],
    queryFn:  () => api.get<StationQueue>(`/expo/station/${stationId}/queue`),
    refetchInterval: 30_000,
    enabled: !!stationId,
  })
  const stations = useQuery({
    queryKey: ['kds', 'stations'],
    queryFn:  () => api.get<Array<{ id: string; name: string }>>('/kds/stations'),
    staleTime: 5 * 60_000,
  })
  const stationName = stations.data?.find((st) => st.id === stationId)?.name

  useSocketEvent('item:updated', () => qc.invalidateQueries({ queryKey: ['kds', 'station', stationId] }),
    { room: `station:${stationId}` })
  useSocketEvent('order:new',    () => qc.invalidateQueries({ queryKey: ['kds', 'station', stationId] }),
    { room: `station:${stationId}` })
  useSocketEvent('expo:fire',    () => qc.invalidateQueries({ queryKey: ['kds', 'station', stationId] }),
    { room: `station:${stationId}` })

  const bump = useMutation({
    mutationFn: (item: StationItem) => item.stepId
      ? api.post(`/expo/steps/${item.stepId}/bump`, {})
      : api.patch(`/order-items/${item.itemId}/status`, { status: 'bumped' }),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['kds', 'station', stationId] }),
    onError:    (err) => Alert.alert('Kitchen', (err as Error).message),
  })

  const items = toItems(q.data)
  const lanes = {
    now:  items.filter(i => i.lane === 'now'),
    next: items.filter(i => i.lane === 'next'),
  }

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }}>
      <Pressable onPress={() => router.back()}>
        <Text style={{ color: theme.textDim, fontSize: 14, marginBottom: 8 }}>← Back to KDS</Text>
      </Pressable>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 16 }}>
        <Text style={{ color: theme.text, fontWeight: '900', fontSize: 26 }}>{stationName ?? 'Station'}</Text>
        <Text style={{ color: theme.textDim, fontSize: 14 }}>{items.length} items</Text>
      </View>

      <View style={{ flexDirection: 'row', gap: 16 }}>
        {(['now', 'next'] as const).map(status => (
          <View key={status} style={{ flex: 1 }}>
            <Text style={{ color: theme.textDim, fontWeight: '700', fontSize: 12, letterSpacing: 1, marginBottom: 10 }}>
              {status === 'now' ? 'ON NOW' : 'UP NEXT'} · {lanes[status].length}
            </Text>
            <View style={{ gap: 10 }}>
              {lanes[status].map((item) => (
                <Pressable
                  key={item.key}
                  disabled={item.lane === 'next' || item.flag === 'held'}
                  onPress={() => bump.mutate(item)}
                  style={({ pressed }) => ({
                    backgroundColor: pressed ? theme.panelAlt : theme.panel,
                    borderRadius: theme.radius, borderWidth: item.flag === 'remake' ? 2 : 1,
                    borderColor: item.flag === 'remake' ? theme.danger : theme.border,
                    padding: 14,
                  })}>
                  {item.flag && (
                    <Text style={{
                      alignSelf: 'flex-start', marginBottom: 6, paddingHorizontal: 8, paddingVertical: 2,
                      borderRadius: 6, overflow: 'hidden', fontSize: 11, fontWeight: '900', letterSpacing: 1,
                      color: theme.text, backgroundColor: item.flag === 'remake' ? theme.danger : theme.info,
                    }}>
                      {item.flag === 'remake' ? 'REMAKE' : 'HELD'}
                    </Text>
                  )}
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
                    <Text style={{ color: theme.textDim, fontSize: 12, fontWeight: '700' }}>
                      #{item.orderNumber} · {item.conceptName}
                    </Text>
                    <Text style={{ color: theme.text, fontWeight: '900', fontSize: 16 }}>
                      {elapsed(item.firedAt ?? item.placedAt)}
                    </Text>
                  </View>
                  <Text style={{ color: theme.text, fontWeight: '800', fontSize: 18 }}>
                    {item.qty}× {item.menuItemName}
                  </Text>
                  {item.instruction && (
                    <Text style={{ color: theme.textDim, fontSize: 13, marginTop: 2 }}>{item.instruction}</Text>
                  )}
                  {item.notes && (
                    <Text style={{ color: theme.warn, fontSize: 13, marginTop: 4, fontStyle: 'italic' }}>{item.notes}</Text>
                  )}
                </Pressable>
              ))}
              {lanes[status].length === 0 && (
                <Panel><Text style={{ color: theme.textMuted, textAlign: 'center', padding: 16 }}>Clear.</Text></Panel>
              )}
            </View>
          </View>
        ))}
      </View>
    </ScrollView>
  )
}
