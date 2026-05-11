// Checkout — pick fulfilment, drop notes, place order. Mobile flow assumes
// the customer is authenticated (login screen redirects here when needed).
// On success, navigates to /order/[id] for live tracking.

import { useState } from 'react'
import { View, Text, TouchableOpacity, TextInput, ScrollView, Alert, ActivityIndicator } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { api } from '../../src/lib/api'
import { useCartStore } from '../../src/store/cart'

interface CreatedOrder { id: string; totalCents: number }

export default function CheckoutScreen() {
  const { concept: slug } = useLocalSearchParams<{ concept: string }>()
  const router = useRouter()
  const { items, subtotalCents, clear } = useCartStore()

  const [fulfilment, setFulfilment] = useState<'delivery' | 'pickup'>('delivery')
  const [notes, setNotes] = useState('')
  const [busy, setBusy]   = useState(false)

  if (items.length === 0) {
    router.replace(`/${slug}/menu`)
    return null
  }

  async function place() {
    setBusy(true)
    try {
      const order = await api.post<CreatedOrder>('/storefront/orders', {
        conceptSlug: slug,
        fulfilment,
        notes: notes.trim() || null,
        items: items.map((i) => ({
          menuItemId: i.menuItemId,
          quantity:   i.quantity,
          notes:      i.notes || null,
        })),
      })
      clear()
      router.replace(`/order/${order.id}`)
    } catch (err) {
      Alert.alert('Couldn\'t place order', (err as Error).message)
    } finally { setBusy(false) }
  }

  const subtotal = subtotalCents()
  const tax      = Math.round(subtotal * 0.17)
  const total    = subtotal + tax

  return (
    <View style={{ flex: 1, backgroundColor: '#0b0d12' }}>
      <ScrollView contentContainerStyle={{ padding: 18, paddingBottom: 130 }}>
        <Text style={{ color: '#fff', fontSize: 26, fontWeight: '800', marginBottom: 24 }}>Checkout</Text>

        <Section label="HOW DO YOU WANT IT?">
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <SegmentBtn label="🛵 Delivery" active={fulfilment === 'delivery'} onPress={() => setFulfilment('delivery')} />
            <SegmentBtn label="🚶 Pickup"   active={fulfilment === 'pickup'}   onPress={() => setFulfilment('pickup')} />
          </View>
        </Section>

        <Section label="ORDER NOTES (OPTIONAL)">
          <TextInput
            value={notes} onChangeText={setNotes}
            placeholder="No onions, leave at door, etc."
            placeholderTextColor="rgba(255,255,255,0.3)"
            multiline numberOfLines={3} textAlignVertical="top"
            style={{
              backgroundColor: 'rgba(255,255,255,0.04)', color: '#fff',
              borderRadius: 12, padding: 14, fontSize: 14, minHeight: 80,
            }}
          />
        </Section>

        <Section label="SUMMARY">
          {items.map((i) => (
            <View key={i.id} style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
              <Text style={{ color: 'rgba(255,255,255,0.65)', fontSize: 13 }} numberOfLines={1}>
                {i.quantity} × {i.name}
              </Text>
              <Text style={{ color: '#fff', fontSize: 13, fontWeight: '600' }}>
                Rs. {((i.unitPriceCents * i.quantity) / 100).toFixed(0)}
              </Text>
            </View>
          ))}
          <View style={{ height: 1, backgroundColor: 'rgba(255,255,255,0.08)', marginVertical: 12 }} />
          <Row label="Subtotal"   value={subtotal} />
          <Row label="GST (17%)"  value={tax} />
          <Row label="Total"      value={total} bold />
        </Section>
      </ScrollView>

      <View style={{
        position: 'absolute', bottom: 18, left: 18, right: 18,
      }}>
        <TouchableOpacity onPress={place} disabled={busy}
          style={{
            backgroundColor: '#22c55e', borderRadius: 14, padding: 16, alignItems: 'center',
            opacity: busy ? 0.5 : 1,
          }}>
          {busy ? <ActivityIndicator color="#000" /> :
            <Text style={{ color: '#000', fontSize: 16, fontWeight: '800' }}>
              Place order · Rs. {(total / 100).toFixed(0)}
            </Text>}
        </TouchableOpacity>
      </View>
    </View>
  )
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={{ marginBottom: 24 }}>
      <Text style={{ fontSize: 11, fontWeight: '700', letterSpacing: 1.5, color: 'rgba(255,255,255,0.4)', marginBottom: 10 }}>{label}</Text>
      {children}
    </View>
  )
}
function SegmentBtn({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity onPress={onPress} style={{
      flex: 1, padding: 14, borderRadius: 12, alignItems: 'center',
      backgroundColor: active ? '#22c55e' : 'rgba(255,255,255,0.04)',
      borderWidth: 1, borderColor: active ? '#22c55e' : 'rgba(255,255,255,0.08)',
    }}>
      <Text style={{ color: active ? '#000' : '#fff', fontWeight: '700', fontSize: 14 }}>{label}</Text>
    </TouchableOpacity>
  )
}
function Row({ label, value, bold }: { label: string; value: number; bold?: boolean }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
      <Text style={{ color: bold ? '#fff' : 'rgba(255,255,255,0.6)', fontSize: bold ? 16 : 13, fontWeight: bold ? '800' : '500' }}>{label}</Text>
      <Text style={{ color: bold ? '#22c55e' : '#fff', fontSize: bold ? 18 : 14, fontWeight: bold ? '800' : '600' }}>
        Rs. {(value / 100).toFixed(0)}
      </Text>
    </View>
  )
}
