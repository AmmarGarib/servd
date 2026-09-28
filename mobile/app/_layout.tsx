import { View } from 'react-native'
import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { PopupHost } from '../src/content/PopupHost'

const queryClient = new QueryClient()

export default function RootLayout() {
  return (
    <QueryClientProvider client={queryClient}>
      <StatusBar style="light" />
      <View style={{ flex: 1 }}>
        <Stack screenOptions={{ headerStyle: { backgroundColor: '#0C0D10' }, headerTintColor: '#fff', headerTitleStyle: { fontWeight: '900' } }}>
          <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
          <Stack.Screen name="order/[id]" options={{ title: 'Order Tracking' }} />
          <Stack.Screen name="pages/[slug]" options={{ title: '' }} />
        </Stack>
        <PopupHost />
      </View>
    </QueryClientProvider>
  )
}
