// Push + local notifications.
//
// Tablets keep their screen awake via expo-keep-awake, but the app can still
// be backgrounded (manager hits home button while plating, kiosk auto-locks
// at night, etc). We want a chime + visible banner when a new order arrives
// even when the foreground isn't ours.
//
// Two channels:
//   1. LOCAL alerts — fired by us when realtime delivers `order:new` while
//      the app is backgrounded. No server involvement, instant. (Works the
//      same whether the live transport underneath is Supabase Realtime or
//      the socket.io fallback — see realtime.ts.)
//   2. PUSH alerts — admin can broadcast "kitchen has 30 mins to go" or
//      "manager needs you" from the backend. We register the Expo token via
//      `/notifications/register` (a route the backend either has or can add
//      trivially via expo-server-sdk).
//
// Both are opt-in. Default ON. User can toggle in Settings.

import * as Notifications from 'expo-notifications'
import { Platform, AppState } from 'react-native'
import Constants from 'expo-constants'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { createStore } from 'zustand/vanilla'
import { useStore } from 'zustand'

import { api } from './api'
import { getRealtime } from './realtime'

const LOCAL_ALERTS_KEY = 'servd_local_alerts'

// ─── Foreground display config ──────────────────────────────────────────────
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
})

// ─── Push token store ───────────────────────────────────────────────────────
interface PushTokenState {
  token: string | null
  setToken: (t: string | null) => void
}
const _store = createStore<PushTokenState>((set) => ({
  token: null,
  setToken: (t) => set({ token: t }),
}))
export const pushTokenStore = Object.assign(_store, {
  use: <T>(selector: (s: PushTokenState) => T) => useStore(_store, selector),
})

// ─── Local alert toggle ─────────────────────────────────────────────────────
export async function getLocalAlertsEnabled(): Promise<boolean> {
  const raw = await AsyncStorage.getItem(LOCAL_ALERTS_KEY)
  return raw !== 'false'   // default on
}
export async function setLocalAlertsEnabled(v: boolean): Promise<void> {
  await AsyncStorage.setItem(LOCAL_ALERTS_KEY, v ? 'true' : 'false')
}

// ─── Push registration ──────────────────────────────────────────────────────
export async function registerPushNotifications(): Promise<string | null> {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'New orders',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#22c55e',
    })
  }

  const perm = await Notifications.requestPermissionsAsync()
  if (perm.status !== 'granted') return null

  try {
    const projectId =
      (Constants.expoConfig?.extra?.eas as { projectId?: string } | undefined)?.projectId
      ?? Constants.easConfig?.projectId

    const token = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined)
    pushTokenStore.getState().setToken(token.data)

    // Best-effort register with backend — silently skip if route isn't wired.
    try {
      await api.post('/notifications/register', {
        token: token.data,
        platform: Platform.OS,
        device: 'tablet',
      })
    } catch (err) {
      console.warn('[push] register failed:', (err as Error).message)
    }

    return token.data
  } catch (err) {
    console.warn('[push] token fetch failed:', err)
    return null
  }
}

// ─── Local order alert wiring ───────────────────────────────────────────────
/**
 * Subscribe to realtime order:new events and fire a local notification when
 * the app is backgrounded. Called once from app/_layout.tsx during boot.
 */
export async function attachLocalOrderAlerts(): Promise<() => void> {
  const handle = getRealtime()
  const handler = async (payload: { orderId?: string; source?: string }) => {
    const enabled = await getLocalAlertsEnabled()
    if (!enabled) return
    if (AppState.currentState === 'active') return  // realtime already chimes in-app

    await Notifications.scheduleNotificationAsync({
      content: {
        title: '🍳 New order',
        body:  payload.source ? `Source: ${payload.source}` : 'A new order is on the line.',
        sound: 'default',
        data:  { orderId: payload.orderId },
      },
      trigger: null,
    })
  }
  return handle.on('order:new', handler)
}
