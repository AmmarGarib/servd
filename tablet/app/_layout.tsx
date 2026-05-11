// Root layout. Hydrates session from SecureStore, locks orientation to
// landscape, keeps the screen awake (tablets on the line should never dim),
// and gates everything behind the auth check. React Query has an
// AsyncStorage-backed persister so cached menus / orders survive Wi-Fi drops.

import { useEffect, useState } from 'react'
import { Stack, useRouter, useSegments } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { View, ActivityIndicator } from 'react-native'
import * as ScreenOrientation from 'expo-screen-orientation'
import { useKeepAwake } from 'expo-keep-awake'
import { QueryClient } from '@tanstack/react-query'
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client'
import { createAsyncStoragePersister } from '@tanstack/query-async-storage-persister'
import AsyncStorage from '@react-native-async-storage/async-storage'

import { sessionStore, useSessionStore } from '../src/store/session'
import { theme } from '../src/lib/theme'
import { initBluetoothTransport } from '../src/lib/printerTransport'
import { attachLocalOrderAlerts } from '../src/lib/notifications'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime:    24 * 60 * 60 * 1_000,
      retry: 2,
    },
  },
})

const persister = createAsyncStoragePersister({ storage: AsyncStorage })

export default function RootLayout() {
  useKeepAwake()

  // Lock landscape on Android tablets. iOS handles this via app.json
  // requireFullScreen — Android needs the runtime call.
  useEffect(() => {
    ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.LANDSCAPE).catch(() => undefined)
  }, [])

  const [hydrated, setHydrated] = useState(false)
  useEffect(() => {
    sessionStore.getState().hydrate().then(() => setHydrated(true))
  }, [])

  // Hook up persistent printer transport + local order alerts once the session
  // is ready. Both safe to call even if no token yet — they short-circuit.
  useEffect(() => {
    if (!hydrated) return
    let cleanup: (() => void) | null = null
    initBluetoothTransport()
    attachLocalOrderAlerts().then((fn) => { cleanup = fn })
    return () => { cleanup?.() }
  }, [hydrated])

  if (!hydrated) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.bg, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color={theme.accent} size="large" />
      </View>
    )
  }

  return (
    <PersistQueryClientProvider client={queryClient} persistOptions={{ persister, maxAge: 24 * 60 * 60 * 1_000 }}>
      <StatusBar style="light" />
      <AuthGate />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: theme.bg } }}>
        <Stack.Screen name="login" />
        <Stack.Screen name="(staff)" />
      </Stack>
    </PersistQueryClientProvider>
  )
}

// Redirects between /login and /(staff) based on whether we have a token.
// Living as a sibling component so the Stack mounts cleanly underneath.
function AuthGate() {
  const router   = useRouter()
  const segments = useSegments()
  const token    = useSessionStore(s => s.token)

  useEffect(() => {
    const inAuthGroup = segments[0] === '(staff)'
    if (!token && inAuthGroup) {
      router.replace('/login')
    } else if (token && !inAuthGroup) {
      router.replace('/(staff)/kds')
    }
  }, [token, segments, router])

  return null
}
