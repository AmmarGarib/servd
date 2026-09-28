// Concept menu screen. Customer browses a brand's menu, taps to add items
// to the cart. The cart lives in zustand (`useCartStore`), surfaced as a
// sticky bar at the bottom that links to /[concept]/cart.

import { useEffect, useMemo } from 'react'
import { View, Text, FlatList, TouchableOpacity, ActivityIndicator, ScrollView } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../src/lib/api'
import { useCartStore } from '../../src/store/cart'
import { ContentBlocks } from '../../src/content/BlockRenderer'
import { hasLiveBlocks, useSiteLayout } from '../../src/content/api'
import { reportScroll } from '../../src/content/scroll'

interface Category { id: string; name: string; sortOrder: number }
interface MenuItem {
  id: string; categoryId: string | null; name: string; description: string | null
  priceCents: number; imageUrl: string | null; isAvailable: boolean
}
interface MenuResponse {
  concept: { id: string; name: string; slug: string; description?: string | null }
  categories: Array<Category & { items?: MenuItem[] }>
  items?: MenuItem[]
}

export default function ConceptMenuScreen() {
  const { concept: slug } = useLocalSearchParams<{ concept: string }>()
  const router = useRouter()
  const { addItem, items, conceptId, setConceptId, subtotalCents } = useCartStore()

  const { data, isLoading } = useQuery<MenuResponse>({
    queryKey: ['menu', slug],
    queryFn: () => api.get<MenuResponse>(`/storefront/${slug}/menu`),
    enabled: !!slug,
  })
  // Owner-built brand page (`brand:<slug>`): its elements sit around the
  // menu (the menu is the `signature`; with no signature element the blocks
  // go above it).
  const { data: layout } = useSiteLayout(slug ? `brand:${slug}` : undefined)
  const brandCtx = useMemo(
    () => (data ? { name: data.concept.name, description: data.concept.description ?? null, slug: data.concept.slug } : undefined),
    [data],
  )

  // If the user picked a different concept than what's in the cart, reset
  // the cart (we don't mix brands in one cart in mobile).
  useEffect(() => {
    if (data?.concept.id && conceptId !== data.concept.id) {
      setConceptId(data.concept.id)
    }
  }, [data?.concept.id, conceptId, setConceptId])

  if (isLoading) {
    return <View style={{ flex: 1, backgroundColor: '#0b0d12', justifyContent: 'center', alignItems: 'center' }}>
      <ActivityIndicator color="#22c55e" />
    </View>
  }
  if (!data) {
    return <View style={{ flex: 1, backgroundColor: '#0b0d12', padding: 28, justifyContent: 'center' }}>
      <Text style={{ color: '#fff', fontSize: 16 }}>Couldn&rsquo;t load this menu.</Text>
    </View>
  }

  const categories = [...data.categories].sort((a, b) => a.sortOrder - b.sortOrder)
  const itemsByCat: Record<string, MenuItem[]> = {}
  // The API nests items under categories; older responses had a flat list.
  const allItems = data.items ?? data.categories.flatMap((c) => c.items ?? [])
  for (const it of allItems) {
    const key = it.categoryId ?? '__uncat'
    ;(itemsByCat[key] ??= []).push(it)
  }
  const noItems = allItems.length === 0
  const totalQty = items.reduce((s, i) => s + i.quantity, 0)

  const menuBody = (
    <View style={{ padding: 18 }}>
        <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11, fontWeight: '700', letterSpacing: 1.5, marginBottom: 4 }}>MENU</Text>
        <Text style={{ color: '#fff', fontSize: 26, fontWeight: '800', marginBottom: 24 }}>{data.concept.name}</Text>

        {categories.length === 0 && noItems && (
          <Text style={{ color: 'rgba(255,255,255,0.5)' }}>This kitchen is updating their menu — check back shortly.</Text>
        )}

        {categories.map((cat) => {
          const list = itemsByCat[cat.id]
          if (!list || list.length === 0) return null
          return (
            <View key={cat.id} style={{ marginBottom: 28 }}>
              <Text style={{ color: '#fff', fontSize: 14, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 1.2, marginBottom: 12 }}>
                {cat.name}
              </Text>
              <FlatList
                data={list} keyExtractor={(i) => i.id} scrollEnabled={false}
                renderItem={({ item }) => <MenuRow item={item} onAdd={() => addItem({
                  menuItemId: item.id, name: item.name, unitPriceCents: item.priceCents,
                })} />}
                ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: 'rgba(255,255,255,0.06)', marginVertical: 12 }} />}
              />
            </View>
          )
        })}
    </View>
  )

  return (
    <View style={{ flex: 1, backgroundColor: '#0b0d12' }}>
      <ScrollView contentContainerStyle={{ paddingBottom: 120 }} onScroll={reportScroll} scrollEventThrottle={100}>
        {hasLiveBlocks(layout)
          ? <ContentBlocks layout={layout} signature={menuBody} conceptSlug={slug} {...(brandCtx && { brand: brandCtx })} ensureSignature />
          : menuBody}
      </ScrollView>

      {totalQty > 0 && (
        <TouchableOpacity
          onPress={() => router.push(`/${slug}/cart`)}
          style={{
            position: 'absolute', bottom: 18, left: 18, right: 18,
            backgroundColor: '#22c55e', borderRadius: 14, padding: 16,
            flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
          }}>
          <Text style={{ color: '#000', fontSize: 15, fontWeight: '800' }}>
            {totalQty} item{totalQty === 1 ? '' : 's'} in cart
          </Text>
          <Text style={{ color: '#000', fontSize: 15, fontWeight: '800' }}>
            Rs. {(subtotalCents() / 100).toFixed(0)} →
          </Text>
        </TouchableOpacity>
      )}
    </View>
  )
}

function MenuRow({ item, onAdd }: { item: MenuItem; onAdd: () => void }) {
  return (
    <TouchableOpacity onPress={onAdd} disabled={!item.isAvailable}
      style={{ flexDirection: 'row', alignItems: 'flex-start', opacity: item.isAvailable ? 1 : 0.4 }}>
      <View style={{ flex: 1 }}>
        <Text style={{ color: '#fff', fontSize: 15, fontWeight: '700' }}>{item.name}</Text>
        {item.description && (
          <Text numberOfLines={2} style={{ color: 'rgba(255,255,255,0.55)', fontSize: 13, marginTop: 4 }}>
            {item.description}
          </Text>
        )}
        <Text style={{ color: '#22c55e', fontSize: 14, fontWeight: '700', marginTop: 6 }}>
          Rs. {(item.priceCents / 100).toFixed(0)}
          {!item.isAvailable && <Text style={{ color: 'rgba(255,255,255,0.5)' }}> · sold out</Text>}
        </Text>
      </View>
      {item.isAvailable && (
        <View style={{
          width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(34,197,94,0.18)',
          justifyContent: 'center', alignItems: 'center',
        }}>
          <Text style={{ color: '#22c55e', fontSize: 22, fontWeight: '700' }}>+</Text>
        </View>
      )}
    </TouchableOpacity>
  )
}
