// Cart review screen — quantity adjustments + tap-through to checkout.

import { View, Text, FlatList, TouchableOpacity, ScrollView } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useCartStore } from '../../src/store/cart'

export default function CartScreen() {
  const { concept: slug } = useLocalSearchParams<{ concept: string }>()
  const router = useRouter()
  const { items, updateQty, removeItem, subtotalCents, clear } = useCartStore()

  if (items.length === 0) {
    return (
      <View style={{ flex: 1, backgroundColor: '#0b0d12', justifyContent: 'center', alignItems: 'center', padding: 28 }}>
        <Text style={{ fontSize: 38, marginBottom: 12 }}>🍽</Text>
        <Text style={{ color: '#fff', fontSize: 20, fontWeight: '800', marginBottom: 8 }}>Cart&rsquo;s empty</Text>
        <Text style={{ color: 'rgba(255,255,255,0.55)', textAlign: 'center', marginBottom: 24 }}>
          Pick something delicious from the menu.
        </Text>
        <TouchableOpacity onPress={() => router.replace(`/${slug}/menu`)}
          style={{ backgroundColor: '#22c55e', borderRadius: 12, paddingHorizontal: 24, paddingVertical: 14 }}>
          <Text style={{ color: '#000', fontWeight: '700' }}>Browse menu</Text>
        </TouchableOpacity>
      </View>
    )
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#0b0d12' }}>
      <ScrollView contentContainerStyle={{ padding: 18, paddingBottom: 130 }}>
        <Text style={{ color: '#fff', fontSize: 26, fontWeight: '800', marginBottom: 4 }}>Your cart</Text>
        <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 13, marginBottom: 24 }}>
          {items.length} item{items.length === 1 ? '' : 's'}
        </Text>

        <FlatList
          data={items} keyExtractor={(i) => i.id} scrollEnabled={false}
          renderItem={({ item }) => (
            <View style={{ flexDirection: 'row', alignItems: 'center', padding: 14, backgroundColor: 'rgba(255,255,255,0.04)', borderRadius: 12, marginBottom: 8 }}>
              <View style={{ flex: 1 }}>
                <Text style={{ color: '#fff', fontSize: 15, fontWeight: '700' }}>{item.name}</Text>
                <Text style={{ color: '#22c55e', fontSize: 13, fontWeight: '700', marginTop: 4 }}>
                  Rs. {(item.unitPriceCents / 100).toFixed(0)} ea
                </Text>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <QtyBtn label="−" onPress={() => updateQty(item.id, item.quantity - 1)} />
                <Text style={{ color: '#fff', fontSize: 16, fontWeight: '800', minWidth: 24, textAlign: 'center' }}>{item.quantity}</Text>
                <QtyBtn label="+" onPress={() => updateQty(item.id, item.quantity + 1)} />
              </View>
              <TouchableOpacity onPress={() => removeItem(item.id)} style={{ marginLeft: 12, padding: 4 }}>
                <Text style={{ color: 'rgba(244,63,94,0.7)', fontSize: 18 }}>×</Text>
              </TouchableOpacity>
            </View>
          )}
        />

        <TouchableOpacity onPress={clear} style={{ alignSelf: 'flex-start', marginTop: 12 }}>
          <Text style={{ color: 'rgba(255,255,255,0.4)', fontSize: 12 }}>Clear cart</Text>
        </TouchableOpacity>
      </ScrollView>

      <View style={{
        position: 'absolute', bottom: 18, left: 18, right: 18,
        backgroundColor: 'rgba(11,13,18,0.94)', borderRadius: 14, padding: 14,
        borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)',
      }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 12 }}>
          <Text style={{ color: 'rgba(255,255,255,0.6)', fontSize: 13 }}>Subtotal</Text>
          <Text style={{ color: '#fff', fontSize: 16, fontWeight: '800' }}>Rs. {(subtotalCents() / 100).toFixed(0)}</Text>
        </View>
        <TouchableOpacity onPress={() => router.push(`/${slug}/checkout`)}
          style={{ backgroundColor: '#22c55e', borderRadius: 12, padding: 14, alignItems: 'center' }}>
          <Text style={{ color: '#000', fontWeight: '800', fontSize: 15 }}>Checkout →</Text>
        </TouchableOpacity>
      </View>
    </View>
  )
}

function QtyBtn({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <TouchableOpacity onPress={onPress} style={{
      width: 30, height: 30, borderRadius: 15,
      backgroundColor: 'rgba(34,197,94,0.18)',
      justifyContent: 'center', alignItems: 'center',
    }}>
      <Text style={{ color: '#22c55e', fontSize: 18, fontWeight: '700' }}>{label}</Text>
    </TouchableOpacity>
  )
}
