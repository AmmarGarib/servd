// KDS expediter view — every active order of the signed-in company, live-
// updating via Socket.IO. Tickets are grouped into lanes (new / fired / ready).
//
// Reads GET /expo/queue and acts through the ONE set of kitchen writers the
// admin /expo screen uses (D3): FIRE → POST /expo/orders/:id/fire, READY →
// PATCH /orders/:id/status, SERVED / BUMP → POST /expo/orders/:id/handoff, and
// tapping an item → PATCH /order-items/:id/status 'bumped'. The screen used to
// call /orders/active and /orders/:id/advance|bump, none of which exist.
//
// A line's status: pending / preparing (cooking), held (paused), recalled (a
// REMAKE — it came back from the pass and is cooked again). The queue's
// optional `paid` flag marks a till sale already paid at the counter, so the
// pass never sends that guest back to pay (a PAID chip on the ticket).
//
// Pre-orders before their prep window come back as `upcoming` (each with
// scheduledFor and kitchenAt). The server holds them — no kitchen ticket, no
// stock taken — and moves them to NEW when their time comes, so they show in
// their own band with no FIRE button.
//
// A PACED line (pending, with scheduledFireAt) is not cooked yet: the pacing
// worker fires it at its time. Tapping it does nothing but say so (bumping it
// would mark it done uncooked, and the worker would never fire it), and READY
// is refused while any paced line is still waiting — a manager or the
// expediter can "Fire all now" from that prompt instead.

import { Alert, View, Text, ScrollView, RefreshControl } from 'react-native'
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import * as Haptics from 'expo-haptics'

import { api } from '../../../src/lib/api'
import { useSocketEvent } from '../../../src/lib/socket'
import { theme } from '../../../src/lib/theme'
import { useSessionStore } from '../../../src/store/session'
import { OrderTicket, Ticket, TicketStatus } from '../../../src/components/OrderTicket'
import { Panel, Pill } from '../../../src/components/Panel'

type ExpoItemStatus = 'pending' | 'preparing' | 'held' | 'recalled' | 'ready' | 'bumped' | 'voided'
/** scheduledFireAt on a pending line = PACED: the pacing worker fires it then, so the course plates together. */
interface ExpoItem { id: string; name: string; quantity: number; notes: string | null; status: ExpoItemStatus; scheduledFireAt?: string | null }
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
  /** Already paid at the till (an older API leaves it out). */
  paid?: boolean
}
/** A pre-order not yet in its prep window. */
interface UpcomingOrder extends ExpoOrder { scheduledFor: string; kitchenAt: string }
interface ExpoQueue {
  awaitingFire: ExpoOrder[]
  inProgress: ExpoOrder[]
  ready: ExpoOrder[]
  /** Pre-orders before their prep window (an older API leaves it out). */
  upcoming?: UpcomingOrder[]
}

function itemStatus(s: string): TicketStatus {
  if (s === 'ready' || s === 'bumped') return 'ready'
  // A recalled line is being cooked again (a remake).
  if (s === 'preparing' || s === 'recalled') return 'fired'
  return 'new'
}

/** Pakistan is UTC+5 all year (no daylight saving). */
const PK_OFFSET_MS = 5 * 60 * 60 * 1000
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** The instant shifted to Pakistan wall time — read it with the getUTC* methods. */
function pk(d: Date): Date {
  return new Date(d.getTime() + PK_OFFSET_MS)
}

/** "14:59" in Pakistan time — when a paced line fires. */
function fireClock(iso: string): string {
  const d = pk(new Date(iso))
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

/** "19:30" today, or "Tue 14 Oct, 19:30" on another day (Pakistan time). */
function pkWhen(iso: string): string {
  const d = pk(new Date(iso))
  const today = pk(new Date())
  const sameDay = d.getUTCFullYear() === today.getUTCFullYear()
    && d.getUTCMonth() === today.getUTCMonth() && d.getUTCDate() === today.getUTCDate()
  if (sameDay) return fireClock(iso)
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${fireClock(iso)}`
}

/** A paced line: still pending, waiting for the pacing worker to fire it at scheduledFireAt. */
function isPaced(it: ExpoItem): it is ExpoItem & { scheduledFireAt: string } {
  return it.status === 'pending' && !!it.scheduledFireAt
}

/** Who may override course pacing ("Fire all now") — the server's FIRE_ALL_ROLES (manager tiers + expediter). */
const FIRE_ALL_ROLES = ['admin', 'owner', 'manager', 'management', 'foh_management', 'boh_management', 'fnb_manager', 'expediter']

/**
 * The line's name with its kitchen state: REMAKE (recalled), HELD (paused), or
 * when a paced line fires. The fire time shows only once the order is fired —
 * an unfired order's schedule is re-set when expo fires it.
 */
function itemLabel(it: ExpoItem, lane: TicketStatus): string {
  if (it.status === 'recalled') return `REMAKE · ${it.name}`
  if (it.status === 'held') return `HELD · ${it.name}`
  if (lane === 'fired' && isPaced(it)) return `${it.name} · fires at ${fireClock(it.scheduledFireAt)}`
  return it.name
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
      .map((it) => ({ id: it.id, name: itemLabel(it, status), qty: it.quantity, notes: it.notes, status: itemStatus(it.status) })),
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

  // "Fire all now": every paced line of the course fires at once (manager
  // tiers and the expediter; the server re-checks and audits it).
  const fireAll = useMutation({
    mutationFn: (orderId: string) => api.post(`/expo/orders/${orderId}/fire`, { fireAll: true }),
    onSuccess: refresh,
    onError: fail,
  })
  const role = useSessionStore((s) => s.user?.role ?? '')
  const canFireAll = FIRE_ALL_ROLES.includes(role)

  // Haptic ping on new order — instant attention.
  useSocketEvent('order:new', () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined)
  })

  // Paced lines (not cooked yet) of fired orders, by line id and by order id.
  // An unfired order's schedule is re-set when expo fires it, so NEW tickets
  // carry no fire times.
  const activeOrders = [...(q.data?.inProgress ?? []), ...(q.data?.ready ?? [])]
  const pacedById = new Map<string, ExpoItem & { scheduledFireAt: string }>()
  const pacedByOrder = new Map<string, Array<ExpoItem & { scheduledFireAt: string }>>()
  for (const o of activeOrders) {
    const paced = o.items.filter(isPaced).sort((a, b) => a.scheduledFireAt.localeCompare(b.scheduledFireAt))
    for (const it of paced) pacedById.set(it.id, it)
    if (paced.length > 0) pacedByOrder.set(o.id, paced)
  }

  // Tapping a line bumps it — but a paced line has not been cooked: bumping
  // it would mark it done and the pacing worker would never fire it.
  const onItemTap = (itemId: string) => {
    const paced = pacedById.get(itemId)
    if (paced) {
      Alert.alert('Not cooked yet', `${paced.name} fires at ${fireClock(paced.scheduledFireAt)} so the course plates together. It can be bumped once it has been cooked.`)
      return
    }
    itemAdvance.mutate(itemId)
  }

  // READY on a fired ticket is refused while paced dishes still wait to fire —
  // the order would go out without them.
  const onTicketAdvance = (t: Ticket) => {
    const paced = t.status === 'fired' ? pacedByOrder.get(t.id) : undefined
    if (paced && paced.length > 0) {
      const n = paced.length
      const list = paced.map((it) => `${it.name} at ${fireClock(it.scheduledFireAt)}`).join(', ')
      Alert.alert(
        'Dishes still paced',
        `${n} dish${n === 1 ? ' is' : 'es are'} still waiting to fire: ${list}. Mark the order ready once they are cooked.`,
        canFireAll
          ? [{ text: 'Close', style: 'cancel' }, { text: 'Fire all now', onPress: () => fireAll.mutate(t.id) }]
          : [{ text: 'OK' }],
      )
      return
    }
    advance.mutate(t)
  }

  const lanes: Record<'new' | 'fired' | 'ready', Ticket[]> = {
    new:   (q.data?.awaitingFire ?? []).map((o) => toTicket(o, 'new')),
    fired: (q.data?.inProgress ?? []).map((o) => toTicket(o, 'fired')),
    ready: (q.data?.ready ?? []).map((o) => toTicket(o, 'ready')),
  }
  const total = lanes.new.length + lanes.fired.length + lanes.ready.length
  // Soonest to reach the kitchen first.
  const upcoming = [...(q.data?.upcoming ?? [])].sort((a, b) => a.kitchenAt.localeCompare(b.kitchenAt))
  const paidIds = new Set(
    [...(q.data?.awaitingFire ?? []), ...(q.data?.inProgress ?? []), ...(q.data?.ready ?? [])]
      .filter((o) => o.paid === true)
      .map((o) => o.id),
  )

  const card = (t: Ticket) => (
    <View key={t.id} style={{ gap: 6 }}>
      {paidIds.has(t.id) && (
        <View style={{ flexDirection: 'row' }}>
          <Pill label="PAID" tone="success" />
        </View>
      )}
      <OrderTicket ticket={t}
        onAdvance={() => onTicketAdvance(t)}
        onBump={() => bump.mutate(t.id)}
        onItemAdvance={onItemTap} />
    </View>
  )

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={{ padding: 16 }}
      refreshControl={<RefreshControl refreshing={q.isFetching} onRefresh={q.refetch} tintColor={theme.accent} />}>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 16 }}>
        <Text style={{ color: theme.text, fontWeight: '900', fontSize: 26 }}>Kitchen Display</Text>
        <Text style={{ color: theme.textDim, fontSize: 14 }}>
          {total} active{upcoming.length > 0 ? ` · ${upcoming.length} pre-order${upcoming.length === 1 ? '' : 's'}` : ''}
        </Text>
      </View>

      {upcoming.length > 0 && (
        <View style={{ marginBottom: 16 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12, paddingHorizontal: 4 }}>
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: theme.textDim }} />
            <Text style={{ color: theme.text, fontWeight: '900', fontSize: 14, letterSpacing: 1 }}>UPCOMING PRE-ORDERS</Text>
            <Text style={{ color: theme.textDim, fontSize: 14, fontWeight: '700' }}>· {upcoming.length}</Text>
          </View>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
            {upcoming.map((o) => (
              <Panel key={o.id} style={{ width: 320 }}>
                <Text style={{ color: theme.text, fontWeight: '800', fontSize: 15 }}>
                  Pre-order for {pkWhen(o.scheduledFor)} — reaches the kitchen at {pkWhen(o.kitchenAt)}
                </Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                  {o.paid === true && <Pill label="PAID" tone="success" />}
                  <Text style={{ color: theme.textDim, fontSize: 13 }}>
                    {o.customer?.name ?? o.customerName ?? 'Walk-in'} · {o.concept.name} · #{o.id.slice(0, 6).toUpperCase()}
                  </Text>
                </View>
                <Text style={{ color: theme.textMuted, fontSize: 12, marginTop: 6 }}>
                  {o.items.filter((it) => it.status !== 'voided').map((it) => `${it.quantity}× ${it.name}`).join(' · ')}
                </Text>
              </Panel>
            ))}
          </View>
        </View>
      )}

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
