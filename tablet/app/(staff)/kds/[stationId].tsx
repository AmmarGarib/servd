// Per-station KDS — one tablet per station (cold bar / grill / fry / etc).
// Filters to items routed to this station only. Same advance/bump actions as
// the expediter view but item-level instead of order-level.

import { useEffect } from 'react'
import { View, Text, ScrollView, Pressable } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'

import { api } from '../../../src/lib/api'
import { useSocketEvent } from '../../../src/lib/socket'
import { theme } from '../../../src/lib/theme'
import { elapsed } from '../../../src/lib/format'
import { Panel, Pill } from '../../../src/components/Panel'

interface StationItem {
  itemId: string
  orderNumber: string
  conceptName: string
  menuItemName: string
  qty: number
  modifiers: string[]
  notes?: string | null
  status: 'new' | 'fired' | 'ready'
  firedAt?: string | null
  placedAt: string
}

export default function KdsStationScreen() {
  const { stationId } = useLocalSearchParams<{ stationId: string }>()
  const router = useRouter()
  const qc = useQueryClient()

  const q = useQuery({
    queryKey: ['kds', 'station', stationId],
    queryFn:  () => api.get<{ items: StationItem[]; stationName: string }>(`/kds/stations/${stationId}/items`),
    refetchInterval: 30_000,
    enabled: !!stationId,
  })

  useSocketEvent('item:updated', () => qc.invalidateQueries({ queryKey: ['kds', 'station', stationId] }),
    { room: `station:${stationId}` })
  useSocketEvent('order:new',    () => qc.invalidateQueries({ queryKey: ['kds', 'station', stationId] }),
    { room: `station:${stationId}` })

  const advance = useMutation({
    mutationFn: (itemId: string) => api.post(`/orders/items/${itemId}/advance`, {}),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['kds', 'station', stationId] }),
  })

  const items = q.data?.items ?? []
  const lanes = {
    new:   items.filter(i => i.status === 'new'),
    fired: items.filter(i => i.status === 'fired'),
    ready: items.filter(i => i.status === 'ready'),
  }

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }}>
      <Pressable onPress={() => router.back()}>
        <Text style={{ color: theme.textDim, fontSize: 14, marginBottom: 8 }}>← Back to KDS</Text>
      </Pressable>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 16 }}>
        <Text style={{ color: theme.text, fontWeight: '900', fontSize: 26 }}>{q.data?.stationName ?? 'Station'}</Text>
        <Text style={{ color: theme.textDim, fontSize: 14 }}>{items.length} items</Text>
      </View>

      <View style={{ flexDirection: 'row', gap: 16 }}>
        {(['new', 'fired', 'ready'] as const).map(status => (
          <View key={status} style={{ flex: 1 }}>
            <Text style={{ color: theme.textDim, fontWeight: '700', fontSize: 12, letterSpacing: 1, marginBottom: 10 }}>
              {status.toUpperCase()} · {lanes[status].length}
            </Text>
            <View style={{ gap: 10 }}>
              {lanes[status].map((item) => (
                <Pressable
                  key={item.itemId}
                  onPress={() => advance.mutate(item.itemId)}
                  style={({ pressed }) => ({
                    backgroundColor: pressed ? theme.panelAlt : theme.panel,
                    borderRadius: theme.radius, borderWidth: 1, borderColor: theme.border,
                    padding: 14,
                  })}>
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
                  {item.modifiers.map((m, i) => (
                    <Text key={i} style={{ color: theme.textDim, fontSize: 13, marginTop: 2 }}>+ {m}</Text>
                  ))}
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
