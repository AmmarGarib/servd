import { View, Text, FlatList, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native'
import { useQuery } from '@tanstack/react-query'
import { useRouter } from 'expo-router'
import { api } from '../../src/lib/api'
import { formatBrandName } from '../../src/lib/brandName'

interface Order {
  id: string
  orderNumber: string
  status: string
  totalCents: number
  createdAt: string
  concept: { name: string }
}

const STATUS_COLORS: Record<string, string> = {
  received: '#F59E0B',
  confirmed: '#6366F1',
  preparing: '#F59E0B',
  ready: '#00D4B1',
  completed: '#6B7280',
  cancelled: '#EF4444',
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-PK', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export default function OrdersScreen() {
  const router = useRouter()
  const { data, isLoading } = useQuery({
    queryKey: ['my-orders'],
    queryFn: () => api.get<{ data: Order[] }>('/orders?limit=20'),
    refetchInterval: 30_000,
  })

  const orders = data?.data ?? []

  if (isLoading) {
    return <View style={s.center}><ActivityIndicator color="#00D4B1" size="large" /></View>
  }

  return (
    <View style={s.container}>
      <FlatList
        data={orders}
        keyExtractor={item => item.id}
        contentContainerStyle={s.list}
        renderItem={({ item }) => (
          <TouchableOpacity style={s.card} onPress={() => router.push(`/order/${item.id}`)}>
            <View style={s.row}>
              <Text style={s.orderNum}>#{item.orderNumber}</Text>
              <View style={[s.badge, { backgroundColor: `${STATUS_COLORS[item.status] ?? '#888'}22` }]}>
                <Text style={[s.badgeText, { color: STATUS_COLORS[item.status] ?? '#888' }]}>
                  {item.status}
                </Text>
              </View>
            </View>
            <Text style={s.concept}>{formatBrandName(item.concept.name)}</Text>
            <View style={s.row}>
              <Text style={s.date}>{fmtDate(item.createdAt)}</Text>
              <Text style={s.total}>PKR {Math.round(item.totalCents / 100).toLocaleString()}</Text>
            </View>
          </TouchableOpacity>
        )}
        ListEmptyComponent={
          <View style={s.emptyContainer}>
            <Text style={s.emptyIcon}>🛍</Text>
            <Text style={s.emptyText}>No orders yet</Text>
            <Text style={s.emptySubtext}>Your order history will appear here</Text>
          </View>
        }
      />
    </View>
  )
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#090a0e' },
  center: { flex: 1, backgroundColor: '#090a0e', alignItems: 'center', justifyContent: 'center' },
  list: { padding: 16, gap: 10 },
  card: { backgroundColor: '#0d0f15', borderRadius: 14, padding: 14, borderWidth: 1, borderColor: '#1a1d24' },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  orderNum: { fontSize: 15, fontWeight: '800', color: '#fff' },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 20 },
  badgeText: { fontSize: 11, fontWeight: '700', textTransform: 'capitalize' },
  concept: { fontSize: 13, color: '#888', marginTop: 3, marginBottom: 8 },
  date: { fontSize: 12, color: '#555' },
  total: { fontSize: 14, fontWeight: '800', color: '#00D4B1' },
  emptyContainer: { alignItems: 'center', marginTop: 80 },
  emptyIcon: { fontSize: 48, marginBottom: 12 },
  emptyText: { fontSize: 18, fontWeight: '800', color: '#fff', marginBottom: 6 },
  emptySubtext: { fontSize: 13, color: '#555' },
})
