// Custom storefront page (`page:<slug>`), the app's counterpart of the web
// storefront's /pages/<slug>. Rendered natively from the live block JSON.

import { View, Text, ScrollView, ActivityIndicator } from 'react-native'
import { Stack, useLocalSearchParams } from 'expo-router'
import { ContentBlocks } from '../../src/content/BlockRenderer'
import { hasLiveBlocks, useSiteLayout } from '../../src/content/api'
import { reportScroll } from '../../src/content/scroll'

export default function ContentPageScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>()
  const { data: layout, isLoading } = useSiteLayout(slug ? `page:${slug}` : undefined)

  if (isLoading) {
    return (
      <View style={{ flex: 1, backgroundColor: '#0b0d12', justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator color="#ECE2EC" />
      </View>
    )
  }
  if (!hasLiveBlocks(layout)) {
    return (
      <View style={{ flex: 1, backgroundColor: '#0b0d12', padding: 28, justifyContent: 'center' }}>
        <Stack.Screen options={{ title: '' }} />
        <Text style={{ color: '#fff', fontSize: 16 }}>This page isn&rsquo;t available right now.</Text>
      </View>
    )
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#0b0d12' }}>
      <Stack.Screen options={{ title: layout.title ?? '' }} />
      <ScrollView contentContainerStyle={{ paddingBottom: 40 }} onScroll={reportScroll} scrollEventThrottle={100}>
        <ContentBlocks layout={layout} />
      </ScrollView>
    </View>
  )
}
