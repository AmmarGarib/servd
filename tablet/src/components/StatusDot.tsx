// Live realtime connection indicator — small dot in the corner of the side
// rail so staff can tell at a glance whether the tablet is talking to the
// server. Driver-agnostic: connected means "all realtime channels are up",
// whether that's Supabase broadcast channels or the socket.io fallback.

import { useEffect, useState } from 'react'
import { View } from 'react-native'
import { getRealtime } from '../lib/realtime'

export function StatusDot() {
  const [connected, setConnected] = useState(false)
  useEffect(() => {
    const handle = getRealtime()
    return handle.onStatus(setConnected)
  }, [])
  return (
    <View style={{
      width: 10, height: 10, borderRadius: 5,
      backgroundColor: connected ? '#22c55e' : '#ef4444',
    }} />
  )
}
