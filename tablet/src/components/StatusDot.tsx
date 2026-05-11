// Live socket connection indicator — small dot in the corner of the side rail
// so staff can tell at a glance whether the tablet is talking to the server.

import { useEffect, useState } from 'react'
import { View } from 'react-native'
import { getSocket } from '../lib/socket'

export function StatusDot() {
  const [connected, setConnected] = useState(false)
  useEffect(() => {
    const sock = getSocket()
    setConnected(sock.connected)
    const on  = () => setConnected(true)
    const off = () => setConnected(false)
    sock.on('connect',    on)
    sock.on('disconnect', off)
    return () => { sock.off('connect', on); sock.off('disconnect', off) }
  }, [])
  return (
    <View style={{
      width: 10, height: 10, borderRadius: 5,
      backgroundColor: connected ? '#22c55e' : '#ef4444',
    }} />
  )
}
