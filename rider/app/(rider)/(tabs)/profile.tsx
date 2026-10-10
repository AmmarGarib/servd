// Profile — who is signed in, for which company, and sign out.
//
// Signing out goes off shift first (stops location sharing and tells
// dispatch). If the rider is carrying a job the server refuses to take them
// off shift; they can still sign out after a warning, which stops sharing.

import { useState } from 'react'
import { Alert, ScrollView, Text, View } from 'react-native'
import { useQueryClient } from '@tanstack/react-query'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import Constants from 'expo-constants'

import { Button } from '../../../src/components/Button'
import { Card, Label } from '../../../src/components/Card'
import { api, ApiError, API_URL } from '../../../src/lib/api'
import { formatPhone, initials, vehicleLabel } from '../../../src/lib/format'
import { stopTracking } from '../../../src/lib/location'
import { useMe, useOnShift } from '../../../src/lib/queries'
import { ACTIVE_JOBS_MESSAGE } from '../../../src/lib/shift'
import { colors, theme } from '../../../src/lib/theme'
import { sessionStore, useSessionStore } from '../../../src/store/session'

function ask(title: string, body: string, ok: string): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(title, body, [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
      { text: ok, style: 'destructive', onPress: () => resolve(true) },
    ], { cancelable: true, onDismiss: () => resolve(false) })
  })
}

export default function ProfileScreen() {
  const insets = useSafeAreaInsets()
  const qc = useQueryClient()
  const me = useMe()
  const cached = useSessionStore(s => s.rider)
  const rider = me.data?.rider ?? cached
  const onShift = useOnShift()
  const [busy, setBusy] = useState(false)

  async function signOut() {
    if (!(await ask('Sign out?', 'You will need a new WhatsApp code to sign back in.', 'Sign out'))) return
    setBusy(true)
    try {
      if (onShift) {
        try {
          await api.post('/rider/shift', { online: false })
        } catch (err) {
          const carrying = err instanceof ApiError && (err.code === 'ACTIVE_JOBS' || err.status === 409)
          const msg = carrying
            ? `${ACTIVE_JOBS_MESSAGE}\n\nSigning out now stops sharing your location while you still have it.`
            : 'Could not take you off shift. Signing out stops sharing your location.'
          if (!(await ask('Still on shift', msg, 'Sign out anyway'))) return
        }
      }
      await stopTracking()
      try {
        // Built at send time: if the access token had expired, the refresh
        // inside api.ts rotates the refresh token, and the retry must revoke
        // the new one, not the one that was just replaced.
        await api.postLazy('/rider-auth/logout', () => {
          const refreshToken = sessionStore.getState().refreshToken
          return refreshToken ? { refreshToken } : {}
        })
      } catch {
        // Already expired / offline — the local session is cleared regardless.
      }
      qc.clear()
      await sessionStore.getState().clear()
    } finally {
      setBusy(false)
    }
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.bg }}
      contentContainerStyle={{ paddingBottom: 32 }}>
      <View style={{
        backgroundColor: colors.purple,
        paddingTop: insets.top + 24,
        paddingBottom: 28,
        paddingHorizontal: theme.padLg,
        alignItems: 'center',
        gap: 10,
        borderBottomLeftRadius: 24,
        borderBottomRightRadius: 24,
      }}>
        <View style={{
          width: 84, height: 84, borderRadius: 42, backgroundColor: colors.green,
          alignItems: 'center', justifyContent: 'center',
        }}>
          <Text style={{ color: colors.onGreen, fontSize: 32, fontWeight: '900' }}>{initials(rider?.name)}</Text>
        </View>
        <Text style={{ color: colors.onPurple, fontSize: 26, fontWeight: '900', textAlign: 'center' }}>
          {rider?.name ?? 'Rider'}
        </Text>
        <Text style={{ color: colors.onPurpleDim, fontSize: 15, fontWeight: '700' }}>
          {onShift ? 'On shift' : 'Off shift'}
        </Text>
      </View>

      <View style={{ padding: theme.pad, gap: 12 }}>
        <Card>
          <Row label="PHONE" value={formatPhone(rider?.phone) || '—'} />
          <Divider />
          <Row label="COMPANY" value={rider?.companyName || '—'} />
          <Divider />
          <Row label="VEHICLE" value={vehicleLabel(rider?.vehicleType) || '—'} />
        </Card>

        <Text style={{ color: colors.textDim, fontSize: 14, lineHeight: 20, paddingHorizontal: 4 }}>
          Wrong name, number or vehicle? Ask your manager to change it in servd (Riders).
        </Text>

        <Button label="Sign out" intent="danger" size="lg" busy={busy} onPress={() => void signOut()} style={{ marginTop: 12 }} />

        <Text style={{ color: colors.textMuted, fontSize: 12, textAlign: 'center', marginTop: 8 }}>
          servd rider {Constants.expoConfig?.version ?? ''} · {API_URL.replace(/^https?:\/\//, '')}
        </Text>
      </View>
    </ScrollView>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ paddingVertical: 6 }}>
      <Label>{label}</Label>
      <Text style={{ color: colors.ink, fontSize: 19, fontWeight: '700' }}>{value}</Text>
    </View>
  )
}

function Divider() {
  return <View style={{ height: 1, backgroundColor: colors.border, marginVertical: 6 }} />
}
