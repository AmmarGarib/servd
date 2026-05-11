import { View, Text, ScrollView, StyleSheet, ActivityIndicator, TouchableOpacity } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../src/lib/api'

interface OrderDetail {
  id: string
  orderNumber: string
  status: string
  totalCents: number
  taxCents: number
  discountCents: number
  createdAt: string
  concept: { name: string }
  items: Array<{
    id: string
    name: string
    quantity: number
    unitPriceCents: number
    modifiers: Array<{ name: string; priceDeltaCents: number }>
  }>
}

const STATUS_STEPS = ['received', 'confirmed', 'preparing', 'ready', 'completed']
const STATUS_LABELS: Record<string, string> = {
  received: 'Order Received', confirmed: 'Confirmed', preparing: 'Preparing',
  ready: 'Ready for Pickup', completed: 'Completed', cancelled: 'Cancelled',
}

export default function OrderTrackingScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const { data: order, isLoading } = useQuery({
    queryKey: ['order', id],
    queryFn: () => api.get<OrderDetail>(`/orders/${id}`),
    refetchInterval: 15_000,
  })

  if (isLoading) {
    return <View style={s.center}><ActivityIndicator color="#00D4B1" size="large" /></View>
  }
  if (!order) {
    return <View style={s.center}><Text style={s.notFound}>Order not found</Text></View>
  }

  const currentStep = STATUS_STEPS.indexOf(order.status)
  const isCancelled = order.status === 'cancelled'

  return (
    <ScrollView style={s.container} contentContainerStyle={s.content}>
      {/* Status header */}
      <View style={s.statusHeader}>
        <Text style={s.orderNum}>#{order.orderNumber}</Text>
        <Text style={[s.statusLabel, isCancelled && { color: '#EF4444' }]}>
          {STATUS_LABELS[order.status] ?? order.status}
        </Text>
        <Text style={s.conceptName}>{order.concept.name}</Text>
      </View>

      {/* Progress steps */}
      {!isCancelled && (
        <View style={s.stepsContainer}>
          {STATUS_STEPS.slice(0, -1).map((step, i) => {
            const done = i <= currentStep
            const active = i === currentStep
            return (
              <View key={step} style={s.stepRow}>
                <View style={[s.stepDot, done && s.stepDotDone, active && s.stepDotActive]} />
                <Text style={[s.stepLabel, done && s.stepLabelDone]}>{STATUS_LABELS[step]}</Text>
                {i < STATUS_STEPS.length - 2 && (
                  <View style={[s.stepLine, done && i < currentStep && s.stepLineDone]} />
                )}
              </View>
            )
          })}
        </View>
      )}

      {/* Items */}
      <View style={s.section}>
        <Text style={s.sectionTitle}>Items</Text>
        {order.items.map(item => (
          <View key={item.id} style={s.itemRow}>
            <View style={s.itemInfo}>
              <Text style={s.itemName}>{item.name}</Text>
              {item.modifiers.length > 0 && (
                <Text style={s.itemMods}>{item.modifiers.map(m => m.name).join(', ')}</Text>
              )}
            </View>
            <Text style={s.itemQty}>×{item.quantity}</Text>
            <Text style={s.itemPrice}>PKR {Math.round(item.unitPriceCents * item.quantity / 100).toLocaleString()}</Text>
          </View>
        ))}
      </View>

      {/* Totals */}
      <View style={s.totals}>
        {order.discountCents > 0 && (
          <View style={s.totalRow}>
            <Text style={s.totalLabel}>Discount</Text>
            <Text style={[s.totalValue, { color: '#EF4444' }]}>-PKR {Math.round(order.discountCents / 100).toLocaleString()}</Text>
          </View>
        )}
        <View style={s.totalRow}>
          <Text style={s.totalLabel}>Tax</Text>
          <Text style={s.totalValue}>PKR {Math.round(order.taxCents / 100).toLocaleString()}</Text>
        </View>
        <View style={[s.totalRow, s.totalRowFinal]}>
          <Text style={s.totalLabelFinal}>Total</Text>
          <Text style={s.totalValueFinal}>PKR {Math.round(order.totalCents / 100).toLocaleString()}</Text>
        </View>
      </View>

      {order.status === 'completed' && (
        <TouchableOpacity
          onPress={() => router.push(`/order/${id}/review`)}
          style={s.rateCta}>
          <Text style={s.rateCtaText}>★ Rate your meal · +50 loyalty pts</Text>
        </TouchableOpacity>
      )}
    </ScrollView>
  )
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#090a0e' },
  content: { padding: 20, gap: 16 },
  center: { flex: 1, backgroundColor: '#090a0e', alignItems: 'center', justifyContent: 'center' },
  notFound: { color: '#888', fontSize: 16 },
  statusHeader: { backgroundColor: '#0d0f15', borderRadius: 16, padding: 20, borderWidth: 1, borderColor: '#1a1d24', alignItems: 'center' },
  orderNum: { fontSize: 13, color: '#888', marginBottom: 6 },
  statusLabel: { fontSize: 22, fontWeight: '900', color: '#00D4B1', textAlign: 'center' },
  conceptName: { fontSize: 13, color: '#888', marginTop: 4 },
  stepsContainer: { backgroundColor: '#0d0f15', borderRadius: 16, padding: 16, borderWidth: 1, borderColor: '#1a1d24' },
  stepRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 },
  stepDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: '#1a1d24', borderWidth: 2, borderColor: '#333' },
  stepDotDone: { backgroundColor: '#1a2e28', borderColor: '#00D4B1' },
  stepDotActive: { backgroundColor: '#00D4B1', borderColor: '#00D4B1' },
  stepLabel: { fontSize: 13, color: '#555', flex: 1 },
  stepLabelDone: { color: '#00D4B1', fontWeight: '600' },
  stepLine: { position: 'absolute', left: 5, top: 14, width: 2, height: 12, backgroundColor: '#222' },
  stepLineDone: { backgroundColor: '#00D4B1' },
  section: { backgroundColor: '#0d0f15', borderRadius: 16, padding: 16, borderWidth: 1, borderColor: '#1a1d24' },
  sectionTitle: { fontSize: 13, fontWeight: '700', color: '#888', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 12 },
  itemRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginBottom: 10 },
  itemInfo: { flex: 1 },
  itemName: { fontSize: 14, fontWeight: '700', color: '#fff' },
  itemMods: { fontSize: 12, color: '#666', marginTop: 2 },
  itemQty: { fontSize: 13, color: '#888', minWidth: 28, textAlign: 'center' },
  itemPrice: { fontSize: 13, fontWeight: '700', color: '#fff', minWidth: 80, textAlign: 'right' },
  totals: { backgroundColor: '#0d0f15', borderRadius: 16, padding: 16, borderWidth: 1, borderColor: '#1a1d24' },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 },
  totalLabel: { fontSize: 13, color: '#888' },
  totalValue: { fontSize: 13, color: '#ccc' },
  totalRowFinal: { borderTopWidth: 1, borderTopColor: '#1a1d24', paddingTop: 10, marginTop: 4 },
  totalLabelFinal: { fontSize: 15, fontWeight: '800', color: '#fff' },
  totalValueFinal: { fontSize: 15, fontWeight: '900', color: '#00D4B1' },
  rateCta: {
    backgroundColor: '#fde68a', borderRadius: 14, padding: 16, alignItems: 'center',
    borderWidth: 1, borderColor: '#fbbf24', marginTop: 4,
  },
  rateCtaText: { color: '#78350f', fontWeight: '800', fontSize: 14 },
})
