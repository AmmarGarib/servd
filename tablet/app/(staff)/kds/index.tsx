// KDS expediter view — every active order of the signed-in company, live-
// updating via Socket.IO. Tickets are grouped into lanes (new / fired / ready).
//
// Reads GET /expo/queue and acts through the ONE set of kitchen writers the
// admin /expo screen uses (D3): FIRE → POST /expo/orders/:id/fire, READY →
// PATCH /orders/:id/status, SERVED / BUMP → POST /expo/orders/:id/handoff, and
// tapping an item → PATCH /order-items/:id/status 'bumped'. The screen used to
// call /orders/active and /orders/:id/advance|bump, none of which exist.

import { Alert, View, Text, ScrollView, RefreshControl } from 'react-native'
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import * as Haptics from 'expo-haptics'

import { api } from '../../../src/lib/api'
import { useSocketEvent } from '../../../src/lib/socket'
import { theme } from '../../../src/lib/theme'
import { OrderTicket, Ticket, TicketStatus } from '../../../src/components/OrderTicket'
import { Panel } from '../../../src/components/Panel'

interface ExpoItem { id: string; name: string; quantity: number; notes: string | null; status: string }
interface ExpoOrder {
  id: string
  status: string
  source: string
  placedAt: string
  customerName: string | null
  concept: { name: string }
  customer: { name: string | null } | null
  table: { label: string } | null
  items: ExpoItem[]
}
interface ExpoQueue { awaitingFire: ExpoOrder[]; inProgress: ExpoOrder[]; ready: ExpoOrder[] }

function itemStatus(s: string): TicketStatus {
  if (s === 'ready' || s === 'bumped') return 'ready'
  if (s === 'preparing') return 'fired'
  return 'new'
}

function toTicket(o: ExpoOrder, status: TicketStatus): Ticket {
  return {
    id: o.id,
    number: o.id.slice(0, 6).toUpperCase(),
    conceptName: o.concept.name,
    source: o.source,
    table: o.table?.label ?? null,
    customerName: o.customer?.name ?? o.customerName,
    placedAt: o.placedAt,
    status,
    items: o.items
      .filter((it) => it.status !== 'voided')
      .map((it) => ({ id: it.id, name: it.name, qty: it.quantity, notes: it.notes, status: itemStatus(it.status) })),
  }
}

export default function KdsAllScreen() {
  const qc = useQueryClient()

  const q = useQuery({
    queryKey: ['kds', 'all'],
    queryFn:  () => api.get<ExpoQueue>('/expo/queue'),
    refetchInterval: 30_000, // backup polling if WS is dead
  })

  // Live updates — any of these events should trigger a refetch.
  useSocketEvent('order:new',     () => qc.invalidateQueries({ queryKey: ['kds'] }))
  useSocketEvent('order:updated', () => qc.invalidateQueries({ queryKey: ['kds'] }))
  useSocketEvent('item:updated',  () => qc.invalidateQueries({ queryKey: ['kds'] }))

  const refresh = () => qc.invalidateQueries({ queryKey: ['kds'] })
  const fail = (err: unknown) => Alert.alert('Kitchen', (err as Error).message)

  // FIRE / READY / SERVED, by lane.
  const advance = useMutation({
    mutationFn: (t: Ticket) =>
      t.status === 'new'   ? api.post(`/expo/orders/${t.id}/fire`, {}) :
      t.status === 'fired' ? api.patch(`/orders/${t.id}/status`, { status: 'ready' }) :
                             api.post(`/expo/orders/${t.id}/handoff`, {}),
    onSuccess: refresh,
    onError: fail,
  })

  // BUMP clears a ready ticket off the pass (same hand-off as SERVED). The
  // server refuses an order that is not ready yet, and says why.
  const bump = useMutation({
    mutationFn: (orderId: string) => api.post(`/expo/orders/${orderId}/handoff`, {}),
    onSuccess: refresh,
    onError: fail,
  })

  const itemAdvance = useMutation({
    mutationFn: (itemId: string) => api.patch(`/order-items/${itemId}/status`, { status: 'bumped' }),
    onSuccess: refresh,
    onError: fail,
  })

  // Haptic ping on new order — instant attention.
  useSocketEvent('order:new', () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined)
  })

  const lanes: Record<'new' | 'fired' | 'ready', Ticket[]> = {
    new:   (q.data?.awaitingFire ?? []).map((o) => toTicket(o, 'new')),
    fired: (q.data?.inProgress ?? []).map((o) => toTicket(o, 'fired')),
    ready: (q.data?.ready ?? []).map((o) => toTicket(o, 'ready')),
  }
  const total = lanes.new.length + lanes.fired.length + lanes.ready.length

  const card = (t: Ticket) => (
    <OrderTicket key={t.id} ticket={t}
      onAdvance={() => advance.mutate(t)}
      onBump={() => bump.mutate(t.id)}
      onItemAdvance={(id) => itemAdvance.mutate(id)} />
  )

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: 16 }}
      refreshControl={<RefreshControl refreshing={q.isFetching} onRefresh={q.refetch} tintColor={theme.accent} />}>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 16 }}>
        <Text style={{ color: theme.text, fontWeight: '900', fontSize: 26 }}>Kitchen Display</Text>
        <Text style={{ color: theme.textDim, fontSize: 14 }}>{total} active</Text>
      </View>

      <View style={{ flexDirection: 'row', gap: 16 }}>
        <Lane title="NEW"   count={lanes.new.length}   tone="info">{lanes.new.map(card)}</Lane>
        <Lane title="FIRED" count={lanes.fired.length} tone="warn">{lanes.fired.map(card)}</Lane>
        <Lane title="READY" count={lanes.ready.length} tone="success">{lanes.ready.map(card)}</Lane>
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
