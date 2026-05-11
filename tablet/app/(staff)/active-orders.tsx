// Active orders — every order still on the floor (not yet bumped), with the
// power-actions cashiers + managers need: VOID a line, COMP the order, REFUND
// a paid amount. Manager override prompt surfaces automatically if the action
// is above the cashier's cap.

import { useState } from 'react'
import { View, Text, ScrollView, TextInput, Alert, Pressable } from 'react-native'
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'

import { api, ApiError } from '../../src/lib/api'
import { useSocketEvent } from '../../src/lib/socket'
import { theme } from '../../src/lib/theme'
import { pkr, shortTime } from '../../src/lib/format'
import { Panel, Pill } from '../../src/components/Panel'
import { Button } from '../../src/components/Button'
import { useManagerOverridePrompt } from '../../src/components/ManagerOverridePin'
import { printReceipt, isPrinterReady } from '../../src/lib/printer'

interface OrderLine {
  id: string
  name: string
  quantity: number
  unitPriceCents: number
  isVoided: boolean
}
interface ActiveOrder {
  id: string
  number: string
  conceptName: string
  status: string
  totalCents: number
  subtotalCents: number
  source: string
  placedAt: string
  customerName?: string | null
  paidCents: number
  lines: OrderLine[]
}

export default function ActiveOrdersScreen() {
  const qc = useQueryClient()
  const [selected, setSelected] = useState<string | null>(null)
  const { prompt, modal } = useManagerOverridePrompt()

  const q = useQuery({
    queryKey: ['active-orders'],
    queryFn:  () => api.get<{ orders: ActiveOrder[] }>('/orders/active?detailed=1'),
    refetchInterval: 30_000,
  })
  useSocketEvent('order:new',     () => qc.invalidateQueries({ queryKey: ['active-orders'] }))
  useSocketEvent('order:updated', () => qc.invalidateQueries({ queryKey: ['active-orders'] }))

  /**
   * Wraps a void/comp/refund call with the manager-override-on-403 retry.
   * Backend signals "need PIN" via `code: 'MANAGER_OVERRIDE_REQUIRED'`.
   */
  async function withOverride<T>(
    title: string,
    subtitle: string,
    call: (pin?: string) => Promise<T>,
  ): Promise<T | null> {
    try {
      return await call()
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        const body = err.body as { error?: { code?: string; message?: string } } | undefined
        if (body?.error?.code === 'MANAGER_OVERRIDE_REQUIRED') {
          const pin = await prompt(title, subtitle ?? body.error.message)
          if (!pin) return null
          try {
            return await call(pin)
          } catch (err2) {
            Alert.alert('Override rejected', (err2 as Error).message)
            return null
          }
        }
      }
      Alert.alert('Hmm', (err as Error).message)
      return null
    }
  }

  const voidLine = useMutation({
    mutationFn: async ({ orderId, lineId, reason }: { orderId: string; lineId: string; reason: string }) =>
      withOverride('Void requires manager PIN', `Voiding "${reason}"`, (pin) =>
        api.post(`/pos/orders/${orderId}/void`, { orderItemId: lineId, reason, managerOverridePin: pin }),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['active-orders'] }),
  })

  const compOrder = useMutation({
    mutationFn: async ({ orderId, amount, reason }: { orderId: string; amount: number; reason: string }) =>
      withOverride('Comp requires manager PIN', `${pkr(amount * 100)} — ${reason}`, (pin) =>
        api.post(`/pos/orders/${orderId}/comp`, { amountCents: amount * 100, reason, managerOverridePin: pin }),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['active-orders'] }),
  })

  const refundOrder = useMutation({
    mutationFn: async ({ orderId, amount, reason }: { orderId: string; amount: number; reason: string }) =>
      withOverride('Refund requires manager PIN', `${pkr(amount * 100)} — ${reason}`, (pin) =>
        api.post(`/pos/orders/${orderId}/refund`, { amountCents: amount * 100, reason, managerOverridePin: pin }),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['active-orders'] }),
  })

  const orders = q.data?.orders ?? []
  const order = orders.find(o => o.id === selected) ?? null

  return (
    <View style={{ flex: 1, flexDirection: 'row' }}>
      {/* Left — order list */}
      <ScrollView style={{ flex: 1, padding: 16 }}>
        <Text style={{ color: theme.text, fontWeight: '900', fontSize: 22, marginBottom: 12 }}>
          Active orders · {orders.length}
        </Text>

        {orders.length === 0 ? (
          <Panel><Text style={{ color: theme.textMuted, padding: 24, textAlign: 'center' }}>
            All clear.
          </Text></Panel>
        ) : orders.map(o => (
          <Pressable
            key={o.id}
            onPress={() => setSelected(o.id)}
            style={({ pressed }) => ({
              backgroundColor: pressed || selected === o.id ? theme.panelAlt : theme.panel,
              borderRadius: theme.radius,
              borderWidth: 1,
              borderColor: selected === o.id ? theme.accent : theme.border,
              padding: 12, marginBottom: 8,
            })}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Text style={{ color: theme.text, fontWeight: '900', fontSize: 16 }}>#{o.number}</Text>
              <Text style={{ color: theme.accent, fontWeight: '800' }}>{pkr(o.totalCents)}</Text>
            </View>
            <Text style={{ color: theme.textDim, fontSize: 12, marginTop: 4 }}>
              {o.conceptName} · {o.status} · {shortTime(o.placedAt)}
            </Text>
            {o.customerName && (
              <Text style={{ color: theme.textDim, fontSize: 12 }}>{o.customerName}</Text>
            )}
          </Pressable>
        ))}
      </ScrollView>

      {/* Right — detail + actions */}
      <View style={{
        flex: 1, backgroundColor: theme.panel,
        borderLeftWidth: 1, borderLeftColor: theme.border,
        padding: 16,
      }}>
        {!order ? (
          <Text style={{ color: theme.textMuted, textAlign: 'center', marginTop: 80 }}>
            Pick an order on the left.
          </Text>
        ) : (
          <OrderActions
            order={order}
            onVoid={(lineId, reason) => voidLine.mutate({ orderId: order.id, lineId, reason })}
            onComp={(amount, reason) => compOrder.mutate({ orderId: order.id, amount, reason })}
            onRefund={(amount, reason) => refundOrder.mutate({ orderId: order.id, amount, reason })}
          />
        )}
      </View>

      {modal}
    </View>
  )
}

function OrderActions({
  order, onVoid, onComp, onRefund,
}: {
  order: ActiveOrder
  onVoid: (lineId: string, reason: string) => void
  onComp: (amount: number, reason: string) => void
  onRefund: (amount: number, reason: string) => void
}) {
  const [compReason, setCompReason] = useState('')
  const [refundAmt, setRefundAmt]   = useState('')
  const [refundReason, setRefundReason] = useState('')
  const [reprintBusy, setReprintBusy] = useState(false)

  async function reprint() {
    setReprintBusy(true)
    try {
      await printReceipt(order.id)
      if (!isPrinterReady()) {
        Alert.alert('No printer paired', 'Receipt was rebuilt but no Bluetooth printer is set up. Pair one in Settings.')
      }
    } catch (err) {
      Alert.alert('Reprint failed', (err as Error).message)
    } finally {
      setReprintBusy(false)
    }
  }

  function askVoid(line: OrderLine) {
    Alert.prompt?.('Reason for void', `Voiding ${line.name}`, (reason) => {
      if (reason?.trim()) onVoid(line.id, reason.trim())
    })
    // Android fallback: Alert.prompt is iOS-only. Use a quick canned reason.
    if (typeof Alert.prompt !== 'function') {
      Alert.alert('Void this line?', `${line.name} — Rs ${Math.round(line.unitPriceCents * line.quantity / 100)}`, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Make error', onPress: () => onVoid(line.id, 'Make error') },
        { text: 'Customer changed mind', onPress: () => onVoid(line.id, 'Customer changed mind') },
      ])
    }
  }

  return (
    <ScrollView>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: theme.text, fontWeight: '900', fontSize: 22 }}>
            Order #{order.number}
          </Text>
          <Text style={{ color: theme.textDim, fontSize: 13, marginBottom: 16 }}>
            {order.conceptName} · {pkr(order.totalCents)} · paid {pkr(order.paidCents)}
          </Text>
        </View>
        <Button
          label={reprintBusy ? 'Printing…' : '🧾 Reprint'}
          intent="ghost"
          size="md"
          busy={reprintBusy}
          onPress={reprint}
        />
      </View>

      <Text style={{ color: theme.textDim, fontWeight: '700', fontSize: 12, letterSpacing: 1, marginBottom: 6 }}>
        LINES
      </Text>
      {order.lines.map(line => (
        <View key={line.id} style={{
          flexDirection: 'row', alignItems: 'center', gap: 8,
          paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: theme.border,
          opacity: line.isVoided ? 0.4 : 1,
        }}>
          <View style={{ flex: 1 }}>
            <Text style={{
              color: theme.text, fontWeight: '700',
              textDecorationLine: line.isVoided ? 'line-through' : 'none',
            }}>{line.quantity}× {line.name}</Text>
            <Text style={{ color: theme.textDim, fontSize: 12 }}>
              {pkr(line.unitPriceCents * line.quantity)}
            </Text>
          </View>
          {!line.isVoided && (
            <Button label="Void" intent="danger" size="md" onPress={() => askVoid(line)} />
          )}
          {line.isVoided && <Pill label="VOIDED" tone="danger" />}
        </View>
      ))}

      <Text style={{ color: theme.textDim, fontWeight: '700', fontSize: 12, letterSpacing: 1, marginTop: 24, marginBottom: 6 }}>
        COMP ENTIRE ORDER
      </Text>
      <TextInput
        value={compReason} onChangeText={setCompReason}
        placeholder="Reason (e.g. service recovery)" placeholderTextColor={theme.textMuted}
        style={inputStyle}
      />
      <Button
        label={`Comp ${pkr(order.totalCents)}`}
        intent="warn" full
        disabled={!compReason.trim()}
        onPress={() => {
          onComp(Math.round(order.totalCents / 100), compReason.trim())
          setCompReason('')
        }}
      />

      {order.paidCents > 0 && (
        <>
          <Text style={{ color: theme.textDim, fontWeight: '700', fontSize: 12, letterSpacing: 1, marginTop: 24, marginBottom: 6 }}>
            REFUND
          </Text>
          <TextInput
            value={refundAmt} onChangeText={setRefundAmt}
            placeholder="Amount (Rs)" placeholderTextColor={theme.textMuted}
            keyboardType="number-pad" style={inputStyle}
          />
          <TextInput
            value={refundReason} onChangeText={setRefundReason}
            placeholder="Reason" placeholderTextColor={theme.textMuted}
            style={inputStyle}
          />
          <Button
            label={`Refund ${refundAmt ? `Rs ${refundAmt}` : ''}`}
            intent="danger" full
            disabled={!refundAmt || !refundReason.trim()}
            onPress={() => {
              const amt = parseInt(refundAmt, 10)
              if (!Number.isFinite(amt) || amt <= 0) return
              onRefund(amt, refundReason.trim())
              setRefundAmt(''); setRefundReason('')
            }}
          />
        </>
      )}
    </ScrollView>
  )
}

const inputStyle = {
  color: theme.text, backgroundColor: theme.panelAlt,
  borderWidth: 1, borderColor: theme.border, borderRadius: 10,
  padding: 12, fontSize: 14, marginBottom: 10,
} as const
