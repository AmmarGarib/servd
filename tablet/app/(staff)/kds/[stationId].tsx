// Per-station KDS — one tablet per station (cold bar / grill / fry / etc).
//
// The 4-card station board (owner B12, 2026-10-26; owner 2026-10-30: "make
// standard 4 cards on screen for all kitchen stations"). The SAME board the
// admin /kds/<station> screen reads — contract in
// backend/src/modules/expo/kitchenBoard.ts:
//   GET  /expo/station/:id/board                 at most 4 order cards, oldest
//        first (the rest wait behind them), the on-deck steps, running timers
//        and the server's clock. Reading it stamps a card "shown" once, which
//        starts the expo's 60-second "not started" alert.
//   POST /expo/station/:id/cards/:orderId/start  the cook starts the card.
//   POST /expo/station/:id/cards/:orderId/done   the tick: every dish of the
//        card at this station is bumped (a recipe step cascades to the next
//        station). A card holding a held dish answers 409 CARD_ON_HOLD.
//   POST  /expo/kitchen-timers {stationId, entryId, durationSeconds, label}
//   PATCH /expo/kitchen-timers/:id {addSeconds}   (+ / − 30 s)
//   POST  /expo/kitchen-timers/:id/stop
// A finished timer makes its card blink red. NO sound, anywhere.
// This screen used to read the old list (/expo/station/:id/queue), so tablet
// stations never got the 4-card cap, Start, timers or the expo alert.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Animated, Modal, View, Text, ScrollView, Pressable } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'

import { api } from '../../../src/lib/api'
import { useSocketEvent } from '../../../src/lib/socket'
import { theme } from '../../../src/lib/theme'
import { Panel } from '../../../src/components/Panel'

interface BoardEntry {
  kind: 'step' | 'line'
  /** OrderItemStep id (step) or OrderItem id (line) — what a timer is started on. */
  id: string
  itemId: string
  itemName: string
  qty: number
  notes: string | null
  modifiers: string[]
  /** step: preparing; line: pending / preparing / held / recalled. */
  status: string
  firedAt: string | null
  startedAt: string | null
  instruction: string | null
  estimatedSeconds: number | null
}
interface BoardCard {
  order: {
    id: string; ref: string; brand: string; channel: string; fulfilmentType: string
    tableLabel: string | null; customerName: string | null; placedAt: string
  }
  firedAt: string
  started: boolean
  held: boolean
  /** Shown and not started for 60 s+ (the expo's alert). */
  unstarted: boolean
  entries: BoardEntry[]
}
interface KitchenTimer {
  id: string; orderId: string; orderItemId: string; orderItemStepId: string | null
  label: string; durationSeconds: number; startedAt: string; endsAt: string
}
interface Board {
  station: { id: string; name: string; brand: string; visibleCards: number }
  visible: BoardCard[]
  queuedCount: number
  onDeck: Array<{ stepId: string; itemName: string; qty: number; order: { id: string; ref: string } }>
  timers: KitchenTimer[]
  serverNow: string
}

const DEFAULT_LINE_TIMER = 120
const CHANNEL_LABEL: Record<string, string> = { pos: 'Till', servd: 'Online', whatsapp: 'WhatsApp', manual: 'Phone', reservation: 'Booking' }
const FULFILMENT_LABEL: Record<string, string> = { dine_in: 'DINE', takeout: 'PACK', delivery: 'PACK+LBL' }

/** mm:ss (negative = over by). */
function clock(seconds: number): string {
  const s = Math.abs(Math.round(seconds))
  const m = Math.floor(s / 60)
  return `${seconds < 0 ? '+' : ''}${m}:${String(s % 60).padStart(2, '0')}`
}

/** A card whose timer ended blinks red — a looping fade, no sound. */
function useBlink(on: boolean): Animated.Value {
  const v = useRef(new Animated.Value(0)).current
  useEffect(() => {
    if (!on) { v.stopAnimation(); v.setValue(0); return }
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(v, { toValue: 1, duration: 450, useNativeDriver: false }),
      Animated.timing(v, { toValue: 0, duration: 450, useNativeDriver: false }),
    ]))
    loop.start()
    return () => loop.stop()
  }, [on, v])
  return v
}

export default function KdsStationScreen() {
  const { stationId } = useLocalSearchParams<{ stationId: string }>()
  const router = useRouter()
  const qc = useQueryClient()
  const boardKey = ['kds', 'station', stationId, 'board']

  // ONE interval ticks every age / countdown once a second.
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  const q = useQuery({
    queryKey: boardKey,
    queryFn:  () => api.get<Board>(`/expo/station/${stationId}/board`),
    refetchInterval: 5_000,
    staleTime: 2_000,
    enabled: !!stationId,
  })
  // Server clock offset, so a timer reads the same on every tablet.
  const offsetMs = useMemo(() => (q.data ? new Date(q.data.serverNow).getTime() - Date.now() : 0), [q.data])
  const serverNow = nowMs + offsetMs

  const refresh = () => qc.invalidateQueries({ queryKey: ['kds', 'station', stationId] })
  useSocketEvent('item:updated', refresh, { room: `station:${stationId}` })
  useSocketEvent('order:new',    refresh, { room: `station:${stationId}` })
  useSocketEvent('expo:fire',    refresh, { room: `station:${stationId}` })

  const onError = (err: unknown) => Alert.alert('Kitchen', (err as Error).message)
  const start = useMutation({
    mutationFn: (orderId: string) => api.post(`/expo/station/${stationId}/cards/${orderId}/start`, {}),
    onSuccess: refresh, onError,
  })
  const done = useMutation({
    mutationFn: (orderId: string) => api.post(`/expo/station/${stationId}/cards/${orderId}/done`, {}),
    onSuccess: refresh, onError,
  })
  const startTimer = useMutation({
    mutationFn: (v: { entryId: string; durationSeconds: number; label?: string }) =>
      api.post('/expo/kitchen-timers', { stationId, ...v }),
    onSuccess: refresh, onError,
  })
  const adjustTimer = useMutation({
    mutationFn: (v: { id: string; addSeconds: number }) => api.patch(`/expo/kitchen-timers/${v.id}`, { addSeconds: v.addSeconds }),
    onSuccess: refresh, onError,
  })
  const stopTimer = useMutation({
    mutationFn: (id: string) => api.post(`/expo/kitchen-timers/${id}/stop`, {}),
    onSuccess: refresh, onError,
  })

  const cards = q.data?.visible ?? []
  const timers = q.data?.timers ?? []
  const [openOrderId, setOpenOrderId] = useState<string | null>(null)
  const openCard = cards.find((c) => c.order.id === openOrderId) ?? null
  // The card left the screen (done elsewhere) → close its pop-up.
  useEffect(() => { if (openOrderId && q.data && !openCard) setOpenOrderId(null) }, [openOrderId, q.data, openCard])

  const timersOf = (orderId: string) => timers.filter((t) => t.orderId === orderId)
  const remaining = (t: KitchenTimer) => (new Date(t.endsAt).getTime() - serverNow) / 1000
  const busyOrder = (orderId: string) =>
    (done.isPending && done.variables === orderId) || (start.isPending && start.variables === orderId)
  const limit = q.data?.station.visibleCards ?? 4

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }}>
      <Pressable onPress={() => router.back()}>
        <Text style={{ color: theme.textDim, fontSize: 14, marginBottom: 8 }}>← Back to KDS</Text>
      </Pressable>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
        <Text style={{ color: theme.text, fontWeight: '900', fontSize: 26 }}>{q.data?.station.name ?? 'Station'}</Text>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {(q.data?.queuedCount ?? 0) > 0 && (
            <Text style={{ color: theme.warn, fontWeight: '800', fontSize: 13 }}>{q.data!.queuedCount} more waiting</Text>
          )}
          {(q.data?.onDeck.length ?? 0) > 0 && (
            <Text style={{ color: theme.info, fontWeight: '800', fontSize: 13 }}>{q.data!.onDeck.length} on deck</Text>
          )}
        </View>
      </View>

      {q.isError && (
        <Panel><Text style={{ color: theme.danger, padding: 8 }}>Could not load this station: {(q.error as Error).message}</Text></Panel>
      )}
      {q.isLoading && <Text style={{ color: theme.textDim }}>Loading…</Text>}
      {!q.isLoading && !q.isError && cards.length === 0 && (
        <Panel>
          <Text style={{ color: theme.text, textAlign: 'center', fontWeight: '800', fontSize: 18, paddingTop: 16 }}>All clear</Text>
          <Text style={{ color: theme.textMuted, textAlign: 'center', paddingBottom: 16, marginTop: 4 }}>New orders appear here when expo fires them.</Text>
        </Panel>
      )}

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
        {cards.map((c) => (
          <CardView key={c.order.id} card={c} timers={timersOf(c.order.id)} remaining={remaining} serverNow={serverNow}
            busy={busyOrder(c.order.id)} onOpen={() => setOpenOrderId(c.order.id)}
            onStart={() => start.mutate(c.order.id)} onDone={() => done.mutate(c.order.id)} />
        ))}
      </View>

      {(q.data?.queuedCount ?? 0) > 0 && (
        <Text style={{ color: theme.textDim, textAlign: 'center', fontWeight: '700', marginTop: 16 }}>
          {q.data!.queuedCount} more {q.data!.queuedCount === 1 ? 'order is' : 'orders are'} waiting — each appears when a card above is done.
        </Text>
      )}

      {(q.data?.onDeck.length ?? 0) > 0 && (
        <View style={{ marginTop: 20 }}>
          <Text style={{ color: theme.textDim, fontWeight: '700', fontSize: 12, letterSpacing: 1, marginBottom: 8 }}>
            ON DECK — WAITING ON ANOTHER STATION · {q.data!.onDeck.length}
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {q.data!.onDeck.map((d) => (
              <Text key={d.stepId} style={{
                color: theme.textDim, fontSize: 14, borderWidth: 1, borderStyle: 'dashed', borderColor: theme.borderHi,
                borderRadius: theme.radius, paddingHorizontal: 12, paddingVertical: 8,
              }}>
                #{d.order.ref} · {d.qty > 1 ? `${d.qty}× ` : ''}{d.itemName}
              </Text>
            ))}
          </View>
        </View>
      )}

      <Text style={{ color: theme.textMuted, textAlign: 'center', fontSize: 12, marginTop: 16 }}>
        Shows {limit} orders at a time · updates live
      </Text>

      <Modal visible={!!openCard} transparent animationType="fade" onRequestClose={() => setOpenOrderId(null)}>
        {openCard && (
          <OrderPopup card={openCard} timers={timersOf(openCard.order.id)} remaining={remaining}
            busy={start.isPending || done.isPending || startTimer.isPending}
            onClose={() => setOpenOrderId(null)}
            onStart={() => start.mutate(openCard.order.id)}
            onDone={() => { done.mutate(openCard.order.id); setOpenOrderId(null) }}
            onStartTimer={(entryId, durationSeconds, label) => startTimer.mutate({ entryId, durationSeconds, label })}
            onAdjust={(id, addSeconds) => adjustTimer.mutate({ id, addSeconds })}
            onStop={(id) => stopTimer.mutate(id)} />
        )}
      </Modal>
    </ScrollView>
  )
}

// ─── One order card ─────────────────────────────────────────────────────────

function CardView({ card: c, timers, remaining, serverNow, busy, onOpen, onStart, onDone }: {
  card: BoardCard
  timers: KitchenTimer[]
  remaining: (t: KitchenTimer) => number
  serverNow: number
  busy: boolean
  onOpen: () => void
  onStart: () => void
  onDone: () => void
}) {
  const rang = timers.some((t) => remaining(t) <= 0)
  const blink = useBlink(rang)
  const ageSec = (serverNow - new Date(c.firedAt).getTime()) / 1000
  const bg = blink.interpolate({ inputRange: [0, 1], outputRange: [theme.panel, 'rgba(239,68,68,0.45)'] })
  const borderColor = rang ? theme.danger : c.unstarted ? theme.warn : theme.border

  return (
    <Animated.View style={{
      flexBasis: '48%', flexGrow: 1, minWidth: 300, backgroundColor: rang ? bg : theme.panel,
      borderRadius: theme.radius, borderWidth: 2, borderColor,
    }}>
      <Pressable onPress={onOpen} accessibilityLabel={`Order ${c.order.ref}${rang ? ', timer finished' : ''}`} style={{ padding: 14 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
          <View style={{ flexShrink: 1 }}>
            <Text style={{ color: theme.text, fontWeight: '900', fontSize: 24 }}>#{c.order.ref}</Text>
            <Text numberOfLines={1} style={{ color: theme.textDim, fontSize: 12, marginTop: 2 }}>
              {c.order.brand} · {CHANNEL_LABEL[c.order.channel] ?? c.order.channel}
              {c.order.customerName ? ` · ${c.order.customerName}` : ''}
            </Text>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <Text style={{ color: ageSec > 600 ? theme.danger : theme.warn, fontWeight: '900', fontSize: 18 }}>{clock(ageSec)}</Text>
            <Text style={{ color: theme.textDim, fontSize: 11, fontWeight: '900', letterSpacing: 1, marginTop: 2 }}>
              {FULFILMENT_LABEL[c.order.fulfilmentType] ?? c.order.fulfilmentType.toUpperCase()}
              {c.order.tableLabel ? ` · ${c.order.tableLabel}` : ''}
            </Text>
          </View>
        </View>

        <View style={{ marginTop: 10, gap: 8 }}>
          {c.entries.map((e) => (
            <View key={e.id}>
              {(e.status === 'recalled' || e.status === 'held') && (
                <Text style={{
                  alignSelf: 'flex-start', marginBottom: 4, paddingHorizontal: 8, paddingVertical: 2,
                  borderRadius: 6, overflow: 'hidden', fontSize: 11, fontWeight: '900', letterSpacing: 1,
                  color: theme.text, backgroundColor: e.status === 'recalled' ? theme.danger : theme.info,
                }}>
                  {e.status === 'recalled' ? 'REMAKE' : 'HELD'}
                </Text>
              )}
              <Text style={{ color: theme.text, fontWeight: '800', fontSize: 18, opacity: e.status === 'held' ? 0.6 : 1 }}>
                {e.qty > 1 ? `${e.qty}× ` : ''}{e.itemName}
              </Text>
              {e.modifiers.length > 0 && <Text style={{ color: theme.textDim, fontSize: 13 }}>{e.modifiers.join(', ')}</Text>}
              {e.notes && <Text style={{ color: theme.warn, fontSize: 13, fontStyle: 'italic' }}>{e.notes}</Text>}
              {e.instruction && <Text numberOfLines={2} style={{ color: theme.accent, fontSize: 13, fontWeight: '600' }}>{e.instruction}</Text>}
            </View>
          ))}
        </View>

        {timers.length > 0 && (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
            {timers.map((t) => {
              const r = remaining(t)
              return (
                <Text key={t.id} style={{
                  color: theme.text, fontWeight: '900', fontSize: 13, borderRadius: 8, overflow: 'hidden',
                  paddingHorizontal: 8, paddingVertical: 4, backgroundColor: r <= 0 ? theme.danger : 'rgba(255,255,255,0.1)',
                }}>
                  {t.label} {r <= 0 ? 'Done' : clock(r)}
                </Text>
              )
            })}
          </View>
        )}
        {c.unstarted && !rang && (
          <Text style={{ color: theme.warn, fontWeight: '900', fontSize: 12, letterSpacing: 1, marginTop: 8 }}>NOT STARTED</Text>
        )}
      </Pressable>

      <View style={{ flexDirection: 'row', gap: 8, padding: 14, paddingTop: 0 }}>
        {!c.started && !c.held && (
          <CardButton label="Start" onPress={onStart} disabled={busy} intent="ghost" />
        )}
        {!c.held && <CardButton label="Done" onPress={onDone} disabled={busy} intent="primary" />}
        {c.held && (
          <Text style={{ flex: 1, color: theme.textDim, textAlign: 'center', paddingVertical: 14, fontSize: 13 }}>
            On hold — resume it on the expo screen
          </Text>
        )}
      </View>
    </Animated.View>
  )
}

function CardButton({ label, onPress, disabled, intent }: { label: string; onPress: () => void; disabled?: boolean; intent: 'primary' | 'ghost' }) {
  return (
    <Pressable onPress={onPress} disabled={disabled}
      style={({ pressed }) => ({
        flex: 1, minHeight: 56, borderRadius: theme.radius, alignItems: 'center', justifyContent: 'center',
        backgroundColor: intent === 'primary' ? (pressed ? theme.accentHi : theme.accent) : (pressed ? theme.panelAlt : 'rgba(255,255,255,0.1)'),
        opacity: disabled ? 0.4 : 1,
      })}>
      <Text style={{ color: intent === 'primary' ? '#0a0a0a' : theme.text, fontWeight: '900', fontSize: intent === 'primary' ? 18 : 16 }}>{label}</Text>
    </Pressable>
  )
}

// ─── The order pop-up ───────────────────────────────────────────────────────
//
// Tap a card: every dish of the order at this station with its instruction,
// and a timer per dish (default = the step's estimated time, else 2:00;
// − / + 30 s before starting; several may run at once).

function OrderPopup({ card, timers, remaining, busy, onClose, onStart, onDone, onStartTimer, onAdjust, onStop }: {
  card: BoardCard
  timers: KitchenTimer[]
  remaining: (t: KitchenTimer) => number
  busy: boolean
  onClose: () => void
  onStart: () => void
  onDone: () => void
  onStartTimer: (entryId: string, durationSeconds: number, label?: string) => void
  onAdjust: (id: string, addSeconds: number) => void
  onStop: (id: string) => void
}) {
  return (
    <Pressable onPress={onClose} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'center', padding: 24 }}>
      <Pressable onPress={() => { /* keep taps inside */ }} style={{
        backgroundColor: theme.panel, borderRadius: theme.radiusLg, borderWidth: 1, borderColor: theme.borderHi,
        maxHeight: '92%', width: '100%', maxWidth: 720, alignSelf: 'center',
      }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', padding: 16, borderBottomWidth: 1, borderBottomColor: theme.border }}>
          <View style={{ flexShrink: 1 }}>
            <Text style={{ color: theme.text, fontWeight: '900', fontSize: 24 }}>#{card.order.ref}</Text>
            <Text numberOfLines={1} style={{ color: theme.textDim, fontSize: 12, marginTop: 2 }}>
              {card.order.brand} · {CHANNEL_LABEL[card.order.channel] ?? card.order.channel}
              {card.order.tableLabel ? ` · Table ${card.order.tableLabel}` : ''}
              {card.order.customerName ? ` · ${card.order.customerName}` : ''}
            </Text>
          </View>
          <Pressable onPress={onClose} accessibilityLabel="Close"
            style={{ minHeight: 48, minWidth: 48, borderRadius: theme.radius, backgroundColor: 'rgba(255,255,255,0.1)', alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ color: theme.text, fontWeight: '900', fontSize: 16 }}>Close</Text>
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
          {card.entries.map((e) => (
            <EntryBlock key={e.id} entry={e}
              timers={timers.filter((t) => (e.kind === 'step' ? t.orderItemStepId === e.id : t.orderItemId === e.itemId && !t.orderItemStepId))}
              remaining={remaining} busy={busy} onStartTimer={onStartTimer} onAdjust={onAdjust} onStop={onStop} />
          ))}
        </ScrollView>

        <View style={{ flexDirection: 'row', gap: 8, padding: 12, borderTopWidth: 1, borderTopColor: theme.border }}>
          {!card.started && !card.held && <CardButton label="Start" onPress={onStart} disabled={busy} intent="ghost" />}
          {!card.held && <CardButton label="Done" onPress={onDone} disabled={busy} intent="primary" />}
        </View>
      </Pressable>
    </Pressable>
  )
}

function EntryBlock({ entry: e, timers, remaining, busy, onStartTimer, onAdjust, onStop }: {
  entry: BoardEntry
  timers: KitchenTimer[]
  remaining: (t: KitchenTimer) => number
  busy: boolean
  onStartTimer: (entryId: string, durationSeconds: number, label?: string) => void
  onAdjust: (id: string, addSeconds: number) => void
  onStop: (id: string) => void
}) {
  const [seconds, setSeconds] = useState(e.estimatedSeconds && e.estimatedSeconds > 0 ? e.estimatedSeconds : DEFAULT_LINE_TIMER)
  const small = (label: string, onPress: () => void, disabled?: boolean) => (
    <Pressable onPress={onPress} disabled={disabled}
      style={{ minHeight: 44, minWidth: 56, paddingHorizontal: 10, borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.1)', alignItems: 'center', justifyContent: 'center', opacity: disabled ? 0.4 : 1 }}>
      <Text style={{ color: theme.text, fontWeight: '800' }}>{label}</Text>
    </Pressable>
  )

  return (
    <View style={{ borderWidth: 1, borderColor: theme.border, borderRadius: theme.radius, padding: 12, backgroundColor: theme.panelAlt }}>
      <Text style={{ color: theme.text, fontWeight: '900', fontSize: 18 }}>{e.qty > 1 ? `${e.qty}× ` : ''}{e.itemName}</Text>
      {e.modifiers.length > 0 && <Text style={{ color: theme.textDim, fontSize: 14 }}>{e.modifiers.join(', ')}</Text>}
      {e.notes && <Text style={{ color: theme.warn, fontSize: 14, fontStyle: 'italic' }}>{e.notes}</Text>}
      {e.instruction && <Text style={{ color: theme.accent, fontSize: 15, fontWeight: '600', marginTop: 4 }}>{e.instruction}</Text>}

      {timers.map((t) => {
        const r = remaining(t)
        return (
          <View key={t.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            <Text style={{ color: r <= 0 ? theme.danger : theme.text, fontWeight: '900', fontSize: 20, minWidth: 80 }}>
              {r <= 0 ? 'Done' : clock(r)}
            </Text>
            {small('−30s', () => onAdjust(t.id, -30), busy || r <= 30)}
            {small('+30s', () => onAdjust(t.id, 30), busy)}
            {small('Stop', () => onStop(t.id), busy)}
          </View>
        )
      })}

      {e.status !== 'held' && (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
          {small('−30s', () => setSeconds((s) => Math.max(30, s - 30)), seconds <= 30)}
          <Text style={{ color: theme.text, fontWeight: '900', fontSize: 18, minWidth: 64, textAlign: 'center' }}>{clock(seconds)}</Text>
          {small('+30s', () => setSeconds((s) => Math.min(4 * 3600, s + 30)))}
          <Pressable onPress={() => onStartTimer(e.id, seconds, e.itemName)} disabled={busy}
            style={{ minHeight: 44, paddingHorizontal: 14, borderRadius: 10, backgroundColor: theme.info, alignItems: 'center', justifyContent: 'center', opacity: busy ? 0.4 : 1 }}>
            <Text style={{ color: theme.text, fontWeight: '900' }}>Start timer</Text>
          </Pressable>
        </View>
      )}
    </View>
  )
}
