// KDS expediter view — every active order across the venue, live-updating
// via Socket.IO. Tickets are grouped by status (new / fired / ready) into
// horizontal lanes. Tap the bump button to clear when food leaves the pass.

import { useEffect } from 'react'
import { View, Text, ScrollView, RefreshControl } from 'react-native'
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import * as Haptics from 'expo-haptics'

import { api } from '../../../src/lib/api'
import { useSocketEvent } from '../../../src/lib/socket'
import { theme } from '../../../src/lib/theme'
import { OrderTicket, Ticket } from '../../../src/components/OrderTicket'
import { Panel } from '../../../src/components/Panel'

interface ActiveOrdersResp { orders: Ticket[] }

export default function KdsAllScreen() {
  const qc = useQueryClient()

  const q = useQuery({
    queryKey: ['kds', 'all'],
    queryFn:  () => api.get<ActiveOrdersResp>('/orders/active'),
    refetchInterval: 30_000, // backup polling if WS is dead
  })

  // Live updates — any of these events should trigger a refetch.
  useSocketEvent('order:new',     () => qc.invalidateQueries({ queryKey: ['kds'] }))
  useSocketEvent('order:updated', () => qc.invalidateQueries({ queryKey: ['kds'] }))
  useSocketEvent('item:updated',  () => qc.invalidateQueries({ queryKey: ['kds'] }))

  const advance = useMutation({
    mutationFn: (orderId: string) => api.post(`/orders/${orderId}/advance`, {}),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['kds'] }),
  })

  const bump = useMutation({
    mutationFn: (orderId: string) => api.post(`/orders/${orderId}/bump`, {}),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['kds'] }),
  })

  const itemAdvance = useMutation({
    mutationFn: (itemId: string) => api.post(`/orders/items/${itemId}/advance`, {}),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['kds'] }),
  })

  // Haptic ping on new order — instant attention.
  useSocketEvent('order:new', () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined)
  })

  const orders = q.data?.orders ?? []
  const lanes: Record<'new' | 'fired' | 'ready', Ticket[]> = {
    new:   orders.filter(o => o.status === 'new'),
    fired: orders.filter(o => o.status === 'fired'),
    ready: orders.filter(o => o.status === 'ready'),
  }

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: 16 }}
      refreshControl={<RefreshControl refreshing={q.isFetching} onRefresh={q.refetch} tintColor={theme.accent} />}>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 16 }}>
        <Text style={{ color: theme.text, fontWeight: '900', fontSize: 26 }}>Kitchen Display</Text>
        <Text style={{ color: theme.textDim, fontSize: 14 }}>{orders.length} active</Text>
      </View>

      <View style={{ flexDirection: 'row', gap: 16 }}>
        <Lane title="NEW"   count={lanes.new.length}   tone="info">
          {lanes.new.map(t => (
            <OrderTicket key={t.id} ticket={t}
              onAdvance={() => advance.mutate(t.id)}
              onBump={() => bump.mutate(t.id)}
              onItemAdvance={(id) => itemAdvance.mutate(id)} />
          ))}
        </Lane>
        <Lane title="FIRED" count={lanes.fired.length} tone="warn">
          {lanes.fired.map(t => (
            <OrderTicket key={t.id} ticket={t}
              onAdvance={() => advance.mutate(t.id)}
              onBump={() => bump.mutate(t.id)}
              onItemAdvance={(id) => itemAdvance.mutate(id)} />
          ))}
        </Lane>
        <Lane title="READY" count={lanes.ready.length} tone="success">
          {lanes.ready.map(t => (
            <OrderTicket key={t.id} ticket={t}
              onAdvance={() => advance.mutate(t.id)}
              onBump={() => bump.mutate(t.id)}
              onItemAdvance={(id) => itemAdvance.mutate(id)} />
          ))}
        </Lane>
      </View>
    </ScrollView>
  )
}

function Lane({ title, count, tone, children }: {
  title: string
  count: number
  tone: 'info' | 'warn' | 'success'
  children: React.ReactNode
}) {
  const accent = tone === 'info' ? theme.newOrder : tone === 'warn' ? theme.fired : theme.ready
  return (
    <View style={{ flex: 1, minWidth: 0 }}>
      <View style={{
        flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12,
        paddingHorizontal: 4,
      }}>
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: accent }} />
        <Text style={{ color: theme.text, fontWeight: '900', fontSize: 14, letterSpacing: 1 }}>{title}</Text>
        <Text style={{ color: theme.textDim, fontSize: 14, fontWeight: '700' }}>· {count}</Text>
      </View>
      <View style={{ gap: 12 }}>
        {count === 0
          ? <Panel><Text style={{ color: theme.textMuted, textAlign: 'center', padding: 20 }}>Nothing here.</Text></Panel>
          : children}
      </View>
    </View>
  )
}
