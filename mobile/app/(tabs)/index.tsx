import { View, Text, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native'
import { useQuery } from '@tanstack/react-query'
import { useRouter } from 'expo-router'
import { api } from '../../src/lib/api'
import { ContentBlocks } from '../../src/content/BlockRenderer'
import { hasLiveBlocks, useSiteLayout } from '../../src/content/api'
import { reportScroll } from '../../src/content/scroll'

interface Concept {
  id: string
  name: string
  slug: string
  description: string | null
  primaryColor: string | null
  logoUrl: string | null
}

export default function BrowseScreen() {
  const router = useRouter()
  // Public brand list. (This used to call GET /concepts, which is staff-only,
  // so customers always saw "No brands available".) Shares its cache key with
  // the `kitchens` content block.
  const { data: concepts, isLoading } = useQuery({
    queryKey: ['concepts-public'],
    queryFn: () => api.get<Concept[]>('/storefront/concepts'),
  })
  // Owner-built home page (`servd:home`). Its `signature` element is this
  // screen's own browse list; with nothing live the browse list stands alone.
  const { data: layout, isLoading: layoutLoading } = useSiteLayout('servd:home')

  if (isLoading || layoutLoading) {
    return (
      <View style={s.center}>
        <ActivityIndicator color="#00D4B1" size="large" />
      </View>
    )
  }

  const browse = (
    <View>
      <Text style={s.heading}>What are you craving?</Text>
      <View style={s.list}>
        {(concepts ?? []).length === 0 && <Text style={s.empty}>No brands available</Text>}
        {(concepts ?? []).map((item) => (
          <View key={item.id} style={[s.card, { borderColor: item.primaryColor ?? '#00D4B1' }]}>
            <View style={[s.brandColor, { backgroundColor: item.primaryColor ?? '#00D4B1' }]} />
            <View style={s.cardBody}>
              <Text style={s.brandName}>{item.name}</Text>
              {item.description && <Text style={s.brandDesc} numberOfLines={2}>{item.description}</Text>}
              <View style={s.actionRow}>
                <TouchableOpacity onPress={() => router.push(`/${item.slug}/menu`)} style={s.primaryBtn}>
                  <Text style={s.primaryBtnText}>🛍 Order</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => router.push(`/reserve/${item.slug}`)} style={s.secondaryBtn}>
                  <Text style={s.secondaryBtnText}>📅 Book table</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        ))}
      </View>
    </View>
  )

  return (
    <ScrollView style={s.container} onScroll={reportScroll} scrollEventThrottle={100}>
      {hasLiveBlocks(layout)
        ? <ContentBlocks layout={layout} signature={browse} />
        : browse}
    </ScrollView>
  )
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#090a0e' },
  center: { flex: 1, backgroundColor: '#090a0e', alignItems: 'center', justifyContent: 'center' },
  heading: { fontSize: 22, fontWeight: '900', color: '#fff', paddingHorizontal: 20, paddingTop: 20, paddingBottom: 12 },
  list: { padding: 16, gap: 12 },
  card: { flexDirection: 'row', borderRadius: 16, borderWidth: 1, overflow: 'hidden', backgroundColor: '#0d0f15' },
  brandColor: { width: 6 },
  cardBody: { flex: 1, padding: 16 },
  brandName: { fontSize: 18, fontWeight: '800', color: '#fff', marginBottom: 4 },
  brandDesc: { fontSize: 13, color: '#888', marginBottom: 12, lineHeight: 18 },
  actionRow: { flexDirection: 'row', gap: 8 },
  primaryBtn: { flex: 1, backgroundColor: '#22c55e', borderRadius: 10, paddingVertical: 10, alignItems: 'center' },
  primaryBtnText: { color: '#000', fontWeight: '800', fontSize: 13 },
  secondaryBtn: { flex: 1, backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: 10, paddingVertical: 10, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)' },
  secondaryBtnText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  empty: { textAlign: 'center', color: '#555', marginTop: 60 },
})
