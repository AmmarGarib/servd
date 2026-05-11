// Tender screen — split between cash/card/wallet, capture amount tendered,
// fire to backend, print receipt, clear cart. Subset of split-tender logic
// (single-tender per fire) but the data model already supports multi-tender
// so the API call accepts an array.

import { useState } from 'react'
import { View, Text, ScrollView, Pressable, Alert } from 'react-native'
import { useRouter } from 'expo-router'
import { useMutation } from '@tanstack/react-query'

import { api } from '../../../src/lib/api'
import { theme } from '../../../src/lib/theme'
import { pkr } from '../../../src/lib/format'
import { usePos } from '../../../src/store/pos'
import { useShift } from '../../../src/store/shift'
import { Button } from '../../../src/components/Button'
import { Keypad } from '../../../src/components/Keypad'
import { Panel } from '../../../src/components/Panel'
import { printReceipt, isPrinterReady } from '../../../src/lib/printer'

type Tender = 'cash' | 'card' | 'jazzcash' | 'easypaisa'

// Maps tender ID to the backend's payment method enum.
const METHOD_FOR_TENDER: Record<Tender, string> = {
  cash:      'cash',
  card:      'card',
  jazzcash:  'jazzcash_wallet',
  easypaisa: 'easypaisa_wallet',
}

export default function TenderScreen() {
  const router = useRouter()
  const pos = usePos()
  const shift = useShift()
  const subtotal = pos.subtotalCents()
  // Tax is computed server-side; for the tender UI we show subtotal as the
  // amount due and let the backend's receipt response carry the actual total.
  const due = subtotal
  const [tender, setTender] = useState<Tender>('cash')
  const [tendered, setTendered] = useState('')

  const tenderCents = (() => {
    const n = parseInt(tendered, 10)
    return Number.isFinite(n) ? n * 100 : 0
  })()
  const changeCents = Math.max(0, tenderCents - due)

  const fire = useMutation({
    mutationFn: async () => {
      if (!pos.conceptId) throw new Error('Pick a brand first')
      if (!shift.shiftId) throw new Error('Open a shift before taking payments')

      // 1. Create the order via the cashier route — handles tax + discount
      //    server-side and binds to the shift.
      const order = await api.post<{ id: string }>('/pos/orders', {
        conceptId: pos.conceptId,
        tableId: pos.tableId,
        customerId: pos.customerId,
        shiftId: shift.shiftId,
        items: pos.lines.map(l => ({
          menuItemId: l.menuItemId,
          name: l.name,
          unitPriceCents: l.unitPriceCents,
          quantity: l.qty,
          notes: l.notes || undefined,
          modifiers: l.modifiers.map(m => ({
            name: m.name,
            priceDeltaCents: m.priceDeltaCents,
            modifierId: m.id,
          })),
        })),
      })

      // 2. Take payment in the same shift.
      await api.post('/pos/payments', {
        orderId: order.id,
        shiftId: shift.shiftId,
        payments: [{
          method: METHOD_FOR_TENDER[tender],
          amountCents: tender === 'cash' ? Math.min(tenderCents, due) : due,
          tenderedCents: tender === 'cash' ? tenderCents : undefined,
        }],
      })
      return order.id
    },
    onSuccess: async (orderId) => {
      // Best-effort receipt print — no transport registered = silent skip.
      try {
        await printReceipt(orderId)
      } catch (err) {
        // Don't block the cashier — they can reprint from the order page.
        Alert.alert('Printer offline', `${(err as Error).message}. Order #${orderId.slice(-6)} saved.`)
      }
      pos.clear()
      router.replace('/(staff)/pos')
    },
    onError: (err: Error) => Alert.alert('Couldn\'t fire order', err.message),
  })

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }}>
      <Pressable onPress={() => router.back()}>
        <Text style={{ color: theme.textDim, fontSize: 14, marginBottom: 8 }}>← Back to cart</Text>
      </Pressable>

      <Text style={{ color: theme.text, fontWeight: '900', fontSize: 26, marginBottom: 16 }}>Tender</Text>

      <View style={{ flexDirection: 'row', gap: 16 }}>
        <View style={{ flex: 1, gap: 12 }}>
          <Panel title="Tender method">
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
              {(['cash', 'card', 'jazzcash', 'easypaisa'] as const).map(t => (
                <Pressable
                  key={t}
                  onPress={() => setTender(t)}
                  style={{
                    flex: 1, minWidth: 120,
                    paddingVertical: 18, alignItems: 'center',
                    borderRadius: 12, borderWidth: 1,
                    borderColor: tender === t ? theme.accent : theme.border,
                    backgroundColor: tender === t ? 'rgba(34,197,94,0.12)' : theme.panelAlt,
                  }}>
                  <Text style={{ color: theme.text, fontWeight: '700', letterSpacing: 0.5 }}>
                    {t.toUpperCase()}
                  </Text>
                </Pressable>
              ))}
            </View>
          </Panel>

          {tender === 'cash' && (
            <Panel title="Cash received (Rs)">
              <Text style={{ color: theme.accent, fontWeight: '900', fontSize: 48, textAlign: 'center', marginBottom: 16 }}>
                Rs {(parseInt(tendered || '0', 10)).toLocaleString('en-PK')}
              </Text>
              <Keypad value={tendered} onChange={setTendered} maxLength={7} extraKey={{ label: '00', onPress: () => setTendered(t => t + '00') }} />
              <View style={{ flexDirection: 'row', justifyContent: 'space-around', marginTop: 16 }}>
                {[500, 1000, 2000, 5000].map(amt => (
                  <Pressable key={amt} onPress={() => setTendered(String(amt))}
                    style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8, borderWidth: 1, borderColor: theme.border }}>
                    <Text style={{ color: theme.text, fontWeight: '700' }}>{amt}</Text>
                  </Pressable>
                ))}
              </View>
            </Panel>
          )}
        </View>

        <View style={{ flex: 1, gap: 12 }}>
          <Panel title="Summary">
            <Row label="Subtotal" value={pkr(subtotal)} />
            <Row label="Due"      value={pkr(due)} highlight />
            {tender === 'cash' && (
              <>
                <Row label="Cash"   value={pkr(tenderCents)} />
                <Row label="Change" value={pkr(changeCents)} highlight />
              </>
            )}
          </Panel>

          <Button
            label={fire.isPending ? 'Firing…' : 'COMPLETE & FIRE'}
            size="xl"
            full
            busy={fire.isPending}
            disabled={tender === 'cash' && tenderCents < due}
            onPress={() => fire.mutate()}
          />

          {!isPrinterReady() && (
            <Text style={{ color: theme.textMuted, fontSize: 12, textAlign: 'center' }}>
              No printer paired — receipt will be saved digitally only.
            </Text>
          )}
        </View>
      </View>
    </ScrollView>
  )
}

function Row({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8 }}>
      <Text style={{ color: theme.textDim, fontSize: highlight ? 18 : 15, fontWeight: highlight ? '700' : '500' }}>{label}</Text>
      <Text style={{ color: highlight ? theme.accent : theme.text, fontSize: highlight ? 24 : 16, fontWeight: '800' }}>{value}</Text>
    </View>
  )
}
