// What the rider needs to know about location sharing, only while on shift:
// sharing in the background (quiet one-liner), only while the app is open
// (warning + Settings), or not at all (red + fix it).

import { useEffect, useState } from 'react'
import { Linking, Text, View } from 'react-native'

import { Banner, Dot } from './Card'
import { permissionState, startTracking, useTracking } from '../lib/location'
import { colors } from '../lib/theme'

function agoLabel(ts: number | null, now: number): string {
  if (!ts) return 'waiting for the first fix'
  const s = Math.max(0, Math.round((now - ts) / 1_000))
  if (s < 60) return `last sent ${s} s ago`
  return `last sent ${Math.floor(s / 60)} min ago`
}

export function LocationStatus({ onShift }: { onShift: boolean }) {
  const mode = useTracking(s => s.mode)
  const lastSentAt = useTracking(s => s.lastSentAt)
  const lastError = useTracking(s => s.lastError)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    if (!onShift) return
    const t = setInterval(() => setNow(Date.now()), 5_000)
    return () => clearInterval(t)
  }, [onShift])

  if (!onShift) return null

  async function fixPermission() {
    const p = await permissionState().catch(() => null)
    if (p && p.foreground !== 'granted' && p.foregroundCanAsk) {
      await startTracking({ askForeground: true, askBackground: false })
      return
    }
    void Linking.openSettings()
  }

  if (mode === 'denied') {
    return (
      <Banner
        tone="danger"
        title="Location is off"
        body="The kitchen cannot see you, so jobs may go to other riders. Turn location on for servd rider."
        actionLabel="Turn on location"
        onAction={() => void fixPermission()}
      />
    )
  }

  if (mode === 'foreground') {
    return (
      <Banner
        tone="warn"
        title="Sharing only while the app is open"
        body={'Keep servd rider open on your phone, or allow location "All the time" / "Always" in Settings so it keeps sharing with the phone locked.'}
        actionLabel="Open Settings"
        onAction={() => void Linking.openSettings()}
      />
    )
  }

  if (mode === 'background') {
    const stale = !!lastError && (!lastSentAt || now - lastSentAt > 60_000)
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4 }}>
        <Dot color={stale ? colors.danger : colors.green} />
        <Text style={{ color: stale ? colors.danger : colors.textDim, fontSize: 14, fontWeight: '600', flex: 1 }}>
          {stale ? `Location not reaching servd: ${lastError}` : `Sharing location — ${agoLabel(lastSentAt, now)}`}
        </Text>
      </View>
    )
  }

  return null
}
