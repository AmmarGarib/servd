// Root layout. Hydrates the session from SecureStore, then gates everything
// behind the auth check: no token -> /login, token -> the rider area.
//
// No persisted query cache (unlike the tablet): a rider must never act on a
// job list from yesterday, so jobs always come from the server.

import { useEffect, useState } from 'react'
import { ActivityIndicator, AppState, Platform, View } from 'react-native'
import { Stack, useRouter, useSegments } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query'
import { SafeAreaProvider } from 'react-native-safe-area-context'

import { sessionStore, useSessionStore } from '../src/store/session'
import { theme } from '../src/lib/theme'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      retry: 2,
    },
  },
})

// React Native has no window focus events: tell React Query when the app is
// in front, so polling pauses in the background (the location task carries
// on by itself) and jobs refresh the moment the rider opens the app again.
focusManager.setEventListener((setFocused) => {
  if (Platform.OS === 'web') return undefined
  const sub = AppState.addEventListener('change', (state) => setFocused(state === 'active'))
  return () => sub.remove()
})

export default function RootLayout() {
  const [hydrated, setHydrated] = useState(false)
  useEffect(() => {
    sessionStore.getState().hydrate().then(() => setHydrated(true))
  }, [])

  // Signed out (here or by a refused refresh): drop every cached job so the
  // next rider on this phone never sees the last one's orders.
  useEffect(() => sessionStore.subscribe((s, prev) => {
    if (prev.token && !s.token) queryClient.clear()
  }), [])

  if (!hydrated) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.bg, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={theme.purple} size="large" />
      </View>
    )
  }

  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        {/* Every screen opens on a purple band or header -> light status bar */}
        <StatusBar style="light" />
        <AuthGate />
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.bg } }}>
          <Stack.Screen name="login" />
          <Stack.Screen name="(rider)" />
        </Stack>
      </QueryClientProvider>
    </SafeAreaProvider>
  )
}

function AuthGate() {
  const router   = useRouter()
  const segments = useSegments()
  const token    = useSessionStore(s => s.token)

  useEffect(() => {
    const inRiderArea = segments[0] === '(rider)'
    if (!token && inRiderArea) router.replace('/login')
    else if (token && !inRiderArea) router.replace('/')
  }, [token, segments, router])

  return null
}
