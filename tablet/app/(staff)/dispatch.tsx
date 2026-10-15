// Dispatch / rider tracking. Two lanes:
//   - Unassigned (active delivery orders, no rider yet)
//   - With rider (assigned, not yet delivered) — with the job stage the rider
//     app reports (offered → accepted → picked up → at the door)
// Tap a rider chip to assign. The rider closes a rider-app job with the
// customer's code at the door. "Enter customer's code" (POST
// /trustops/orders/:id/verify-otp) is the way to close a delivery from here.
// "Delivered" is only offered while the order's company is NOT code-only (the
// board says `codeOnly`), for a job whose code locked, a rider who is not on
// the app, or an order from before the rider app (deliverGate below); the
// server decides who may (managers only) and answers 404 once the company is
// code-only. A locked code: ask a manager (Emergency overrides).
//
// Reads the same endpoints as the admin: GET /orders for the active delivery
// orders and GET /dispatch/board for the riders. Every write goes through
// /dispatch — the one set of rider rules (the rider's own company or a fleet
// agreement, active, not offline, the rider freed after their last drop).
// This screen used to call GET /dispatch/orders and GET /dispatch/riders,
// which never existed, so both lists were always empty.
//
// Only delivery orders take a rider: the lanes filter on
// fulfilmentType === 'delivery' (they used to take every non-till order, so a
// storefront pickup could be handed to a rider). The board also lists another
// company's rider while they carry one of our orders under a fleet agreement
// (docs/rider-app.md) — marked "partner".

import { useState } from 'react'
import { View, Text, ScrollView, Pressable, Alert, TextInput } from 'react-native'
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'

import { api, ApiError } from '../../src/lib/api'
import { useSessionStore } from '../../src/store/session'
import { useSocketEvent } from '../../src/lib/socket'
import { theme } from '../../src/lib/theme'
import { orderRef } from '../../src/lib/orderRef'
import { pkr, elapsed } from '../../src/lib/format'
import { Panel, Pill } from '../../src/components/Panel'

// GET /dispatch/board
interface BoardRider {
  id: string
  name: string
  status: 'available' | 'busy' | 'offline'
  fleetPartner?: boolean
  orders: Array<{ id: string; codeOnly?: boolean }>
}

// GET /orders (list shape)
interface ActiveOrder {
  id: string
  status: string
  source: string
  fulfilmentType: string
  customerName: string | null
  deliveryNotes: string | null
  totalCents: number
  placedAt: string
  riderId: string | null
  riderAssignedAt?: string | null
  riderAcceptedAt?: string | null
  pickedUpAt?: string | null
  arrivedAt?: string | null
  /** Wrong hand-over codes so far (locks at OTP_MAX_ATTEMPTS). */
  deliveryOtpAttempts?: number
  rider?: { id: string; name: string; phone: string } | null
  concept: { name: string }
  payments: Array<{ method: string; status: string }>
}

// Where a rider-carried order is, from its timestamps (the rider app's flow).
const STAGE: Record<string, { label: string; tone: 'warn' | 'info' | 'success' }> = {
  offered:   { label: 'OFFERED',     tone: 'warn' },
  accepted:  { label: 'ACCEPTED',    tone: 'info' },
  picked_up: { label: 'PICKED UP',   tone: 'info' },
  arrived:   { label: 'AT THE DOOR', tone: 'success' },
}
function jobStage(o: ActiveOrder): keyof typeof STAGE | null {
  // No rider, or an API without the job timestamps: no stage to show.
  if (!o.riderId || !('riderAssignedAt' in o)) return null
  if (o.arrivedAt) return 'arrived'
  if (o.pickedUpAt) return 'picked_up'
  if (o.riderAcceptedAt) return 'accepted'
  return 'offered'
}

/** Wrong hand-over codes before the job locks — DELIVERY_OTP_MAX_ATTEMPTS in backend lib/deliveryOtp.ts. */
const OTP_MAX_ATTEMPTS = 5
/** The API's MANAGERS (backend modules/auth/middleware.ts). */
const MANAGER_ROLES = new Set(['admin', 'owner', 'manager', 'management', 'foh_management', 'boh_management', 'fnb_manager'])

/**
 * What this screen offers on a delivery (docs/rider-app.md, "The hand-over
 * code"). The server owns who may do what; this only decides what to show.
 *  - code-only company: never "Delivered" (the route answers 404). A locked
 *    code points to Emergency overrides.
 *  - otherwise "Delivered" only when the code locked, the rider never took the
 *    job in the app, or the order predates the rider app.
 */
function deliverGate(o: ActiveOrder, codeOnly: boolean, isManager: boolean): { canMark: boolean; locked: boolean; note: string | null } {
  if (o.status !== 'ready') return { canMark: false, locked: false, note: null }
  const locked = (o.deliveryOtpAttempts ?? 0) >= OTP_MAX_ATTEMPTS
  if (codeOnly) {
    return { canMark: false, locked, note: locked ? 'Code locked. Ask a manager: Emergency overrides.' : null }
  }
  if (!isManager) {
    return { canMark: false, locked, note: locked ? 'Code locked — a manager marks it delivered.' : 'A manager marks it delivered.' }
  }
  const inApp = !!o.riderAssignedAt && !!o.riderAcceptedAt
  if (inApp && !locked) return { canMark: false, locked, note: "Rider closes it with the customer's code." }
  return { canMark: true, locked, note: locked ? `Code locked after ${OTP_MAX_ATTEMPTS} wrong tries.` : null }
}

/** Wrong-code error: the attempts left, whichever way the API envelope carries it. */
function attemptsLeftOf(err: unknown): number | null {
  if (!(err instanceof ApiError)) return null
  const e = (err.body as { error?: { attemptsLeft?: unknown; details?: { attemptsLeft?: unknown } } } | null)?.error
  const v = e?.details?.attemptsLeft ?? e?.attemptsLeft
  return typeof v === 'number' ? v : null
}
export default function DispatchScreen() {
  const role = useSessionStore(s => s.user?.role)
  const isManager = MANAGER_ROLES.has(role ?? '')
  const qc = useQueryClient()

  const orders = useQuery({
    queryKey: ['dispatch', 'orders'],
    // The list API has no fulfilment filter: take its maximum page so a busy
    // dine-in floor can't push deliveries off it, then keep the deliveries.
    queryFn:  () => api.get<{ data: ActiveOrder[] }>('/orders?status=received,confirmed,preparing,ready&limit=200'),
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
    onError:    (err: Error) => {
      // Code-only company: the override route is gone (404).
      if (err instanceof ApiError && err.status === 404) Alert.alert('Hmm', "Use Enter customer's code.")
      else Alert.alert('Hmm', err.message)
    },
  })

  // Staff entering the customer's code for a rider without the app.
  async function verifyCode(orderId: string, otp: string) {
    await api.post(`/trustops/orders/${orderId}/verify-otp`, { otp })
    qc.invalidateQueries({ queryKey: ['dispatch'] })
  }

  // A manager closing a delivery without the customer's code (deliverGate).
  function confirmDelivered(order: ActiveOrder) {
    Alert.alert(
      'Mark delivered without the code?',
      'Only do this once you have confirmed with the customer that they have the food.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Mark delivered', style: 'destructive', onPress: () => delivered.mutate(order.id) },
      ],
    )
  }

  // Only delivery orders need a rider (pickup and table orders never do,
  // whichever channel they came in on).
  const o = (orders.data?.data ?? []).filter(x => x.fulfilmentType === 'delivery')
  const lanes = {
    unassigned: o.filter(x => !x.riderId),
    withRider:  o.filter(x => !!x.riderId),
  }

  const roster = riders.data ?? []
  // The board says per order whether its company is code-only.
  const codeOnlyIds = new Set(roster.flatMap(r => r.orders.filter(x => x.codeOnly).map(x => x.id)))
  const idleRiders = roster.filter(r => r.status === 'available')

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }}>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
        <Text style={{ color: theme.text, fontWeight: '900', fontSize: 26 }}>Dispatch</Text>
        <Text style={{ color: theme.textDim }}>
          {o.length} active {o.length === 1 ? 'delivery' : 'deliveries'} · {idleRiders.length} available riders
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
              {r.fleetPartner && (
                <Text style={{ color: theme.textMuted, fontSize: 11, fontWeight: '700', letterSpacing: 0.5 }}>PARTNER</Text>
              )}
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
          {lanes.withRider.map(order => {
            const gate = deliverGate(order, codeOnlyIds.has(order.id), isManager)
            return (
              <OrderCard key={order.id} order={order} riders={[]} onAssign={() => undefined}
                onVerify={order.status === 'ready' ? (otp) => verifyCode(order.id, otp) : undefined}
                deliverNote={gate.note} deliverLocked={gate.locked}
                onDelivered={gate.canMark ? () => confirmDelivered(order) : undefined} />
            )
          })}
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

function OrderCard({ order, riders, onAssign, onVerify, onDelivered, deliverNote, deliverLocked }: {
  order: ActiveOrder
  riders: BoardRider[]
  onAssign: (riderId: string) => void
  onVerify?: (otp: string) => Promise<void>
  onDelivered?: () => void
  deliverNote?: string | null
  deliverLocked?: boolean
}) {
  // Cash still owed at the door: a pending cash payment.
  const cod = order.payments.some(p => p.method === 'cash' && p.status === 'pending')
  const stage = jobStage(order)
  const [entering, setEntering] = useState(false)
  const [otp, setOtp] = useState('')
  const [busy, setBusy] = useState(false)
  const [codeMsg, setCodeMsg] = useState<string | null>(null)
  const [codeLocked, setCodeLocked] = useState((order.deliveryOtpAttempts ?? 0) >= OTP_MAX_ATTEMPTS)
  const [attemptsLeft, setAttemptsLeft] = useState<number | null>(
    typeof order.deliveryOtpAttempts === 'number' ? Math.max(0, OTP_MAX_ATTEMPTS - order.deliveryOtpAttempts) : null,
  )
  const locked = codeLocked || !!deliverLocked

  async function submitCode() {
    if (!onVerify || busy || otp.length !== 4) return
    setBusy(true)
    setCodeMsg(null)
    try {
      await onVerify(otp)
      setEntering(false)
      setOtp('')
    } catch (err) {
      setOtp('')
      if (err instanceof ApiError && (err.status === 423 || (err.body as { error?: { code?: string } } | null)?.error?.code === 'OTP_LOCKED')) {
        setCodeLocked(true)
        setAttemptsLeft(0)
        setEntering(false)
      } else if (err instanceof ApiError && err.status === 403) {
        const left = attemptsLeftOf(err)
        if (left !== null) setAttemptsLeft(left)
        if (left === 0) { setCodeLocked(true); setEntering(false) }
        else setCodeMsg(left === null ? 'Wrong code.' : `Wrong code. ${left} ${left === 1 ? 'try' : 'tries'} left.`)
      } else {
        setCodeMsg(err instanceof Error ? err.message : 'Could not check the code.')
      }
    } finally {
      setBusy(false)
    }
  }
  return (
    <View style={{
      backgroundColor: theme.panel, borderRadius: theme.radius,
      borderWidth: 1, borderColor: theme.border, padding: 12,
    }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
        <Text style={{ color: theme.text, fontWeight: '900', fontSize: 18 }}>#{orderRef(order.id)}</Text>
        <Text style={{ color: theme.textDim, fontSize: 12 }}>{elapsed(order.placedAt)}</Text>
      </View>
      <Text style={{ color: theme.text, fontWeight: '700', fontSize: 14 }}>{order.customerName ?? 'Guest'} · {order.concept.name}</Text>
      <Text style={{ color: theme.textDim, fontSize: 12 }} numberOfLines={2}>{order.deliveryNotes ?? 'No address'}</Text>

      <View style={{ flexDirection: 'row', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
        <Pill label={order.status} />
        <Pill label={pkr(order.totalCents)} tone="info" />
        {cod && <Pill label="COD" tone="warn" />}
        {stage && <Pill label={STAGE[stage]!.label} tone={STAGE[stage]!.tone} />}
      </View>

      {order.rider && (
        <View style={{ marginTop: 10, padding: 8, backgroundColor: theme.panelAlt, borderRadius: 8 }}>
          <Text style={{ color: theme.textDim, fontSize: 11, fontWeight: '700', letterSpacing: 0.5 }}>RIDER</Text>
          <Text style={{ color: theme.text, fontWeight: '700' }}>{order.rider.name}</Text>
        </View>
      )}

      {deliverNote ? (
        <Text style={{ marginTop: 8, color: locked ? theme.danger : theme.textDim, fontSize: 12, fontWeight: '700' }}>
          {deliverNote}
        </Text>
      ) : null}

      {onVerify && !locked && (
        entering ? (
          <View style={{ marginTop: 10 }}>
            <Text style={{ color: theme.textDim, fontSize: 11, fontWeight: '700', letterSpacing: 0.5, marginBottom: 6 }}>
              CUSTOMER'S CODE{attemptsLeft !== null ? ` · ${attemptsLeft} ${attemptsLeft === 1 ? 'TRY' : 'TRIES'} LEFT` : ''}
            </Text>
            <TextInput
              value={otp}
              onChangeText={t => { setOtp(t.replace(/\D/g, '').slice(0, 4)); if (codeMsg) setCodeMsg(null) }}
              keyboardType="number-pad"
              maxLength={4}
              editable={!busy}
              placeholder="0000"
              placeholderTextColor={theme.textMuted}
              style={{
                color: theme.text, fontSize: 24, fontWeight: '900', letterSpacing: 8, textAlign: 'center',
                borderWidth: 1, borderColor: codeMsg ? theme.danger : theme.border, borderRadius: 8, paddingVertical: 8,
              }}
            />
            {codeMsg ? <Text style={{ marginTop: 6, color: theme.danger, fontSize: 12, fontWeight: '700' }}>{codeMsg}</Text> : null}
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
              <Pressable
                onPress={() => { setEntering(false); setOtp(''); setCodeMsg(null) }}
                style={{ flex: 1, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: theme.border, alignItems: 'center' }}>
                <Text style={{ color: theme.textDim, fontWeight: '700', fontSize: 13 }}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={() => void submitCode()}
                disabled={busy || otp.length !== 4}
                style={{
                  flex: 1, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: theme.accent, alignItems: 'center',
                  opacity: busy || otp.length !== 4 ? 0.5 : 1,
                }}>
                <Text style={{ color: theme.text, fontWeight: '800', fontSize: 13 }}>{busy ? 'Checking...' : 'Check code'}</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <Pressable
            onPress={() => setEntering(true)}
            style={({ pressed }) => ({
              marginTop: 10, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: theme.accent,
              alignItems: 'center', backgroundColor: pressed ? theme.accent : 'rgba(34,197,94,0.12)',
            })}>
            <Text style={{ color: theme.text, fontWeight: '800', fontSize: 13 }}>Enter customer's code</Text>
          </Pressable>
        )
      )}

      {onVerify && locked && !deliverNote ? (
        <Text style={{ marginTop: 8, color: theme.danger, fontSize: 12, fontWeight: '700' }}>
          Code locked. Ask a manager: Emergency overrides.
        </Text>
      ) : null}

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
