// Staff shell — persistent left rail nav + content slot. All staff routes
// live under this layout so the rail is always visible and the socket
// connection persists across screen switches.

import { useEffect } from 'react'
import { View, Text, Pressable, Alert } from 'react-native'
import { Slot, useRouter, usePathname } from 'expo-router'

import { theme } from '../../src/lib/theme'
import { useSessionStore, sessionStore } from '../../src/store/session'
import { getSocket } from '../../src/lib/socket'
import { StatusDot } from '../../src/components/StatusDot'
import { initials } from '../../src/lib/format'

const NAV = [
  { key: 'kds',          label: 'KDS',          icon: '🍳', path: '/(staff)/kds' },
  { key: 'pos',          label: 'POS',          icon: '🧾', path: '/(staff)/pos' },
  { key: 'reservations', label: 'Reservations', icon: '📅', path: '/(staff)/reservations' },
  { key: 'curbside',     label: 'Curbside',     icon: '🚗', path: '/(staff)/curbside' },
  { key: 'dispatch',     label: 'Dispatch',     icon: '🛵', path: '/(staff)/dispatch' },
  { key: 'inventory',    label: 'Inventory',    icon: '📦', path: '/(staff)/inventory' },
  { key: 'customer',     label: 'Customer',     icon: '👤', path: '/(staff)/customer' },
  { key: 'time-clock',   label: 'Time clock',   icon: '⏱️', path: '/(staff)/time-clock' },
] as const

export default function StaffLayout() {
  const router   = useRouter()
  const pathname = usePathname()
  const user     = useSessionStore(s => s.user)

  // Boot the socket as soon as we enter the staff area.
  useEffect(() => { getSocket() }, [])

  function signOut() {
    Alert.alert('Sign out?', `End shift for ${user?.name ?? 'this user'}?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: async () => {
        await sessionStore.getState().clear()
        router.replace('/login')
      }},
    ])
  }

  return (
    <View style={{ flex: 1, flexDirection: 'row', backgroundColor: theme.bg }}>
      {/* Side rail */}
      <View style={{
        width: 132, backgroundColor: theme.panel,
        borderRightWidth: 1, borderRightColor: theme.border,
        paddingVertical: 16,
      }}>
        <View style={{ alignItems: 'center', paddingVertical: 12, gap: 6 }}>
          <Text style={{ color: theme.text, fontWeight: '900', fontSize: 20, letterSpacing: -0.5 }}>servd</Text>
          <StatusDot />
        </View>

        <View style={{ height: 1, backgroundColor: theme.border, marginVertical: 12 }} />

        {NAV.map((item) => {
          const active = pathname.startsWith(item.path)
          return (
            <Pressable
              key={item.key}
              onPress={() => router.push(item.path as never)}
              style={({ pressed }) => ({
                paddingVertical: 14, paddingHorizontal: 8,
                marginHorizontal: 8, marginBottom: 6,
                borderRadius: 12,
                backgroundColor: active ? theme.accent : pressed ? 'rgba(255,255,255,0.06)' : 'transparent',
                alignItems: 'center', gap: 4,
              })}>
              <Text style={{ fontSize: 22 }}>{item.icon}</Text>
              <Text style={{
                color: active ? '#0a0a0a' : theme.textDim,
                fontSize: 11, fontWeight: '700', letterSpacing: 0.3,
                textAlign: 'center',
              }}>{item.label.toUpperCase()}</Text>
            </Pressable>
          )
        })}

        <View style={{ flex: 1 }} />

        {/* User avatar + sign out */}
        <Pressable onPress={signOut} style={{ alignItems: 'center', paddingVertical: 12, gap: 6 }}>
          <View style={{
            width: 44, height: 44, borderRadius: 22,
            backgroundColor: theme.accent, alignItems: 'center', justifyContent: 'center',
          }}>
            <Text style={{ color: '#0a0a0a', fontWeight: '900', fontSize: 16 }}>
              {user ? initials(user.name) : '?'}
            </Text>
          </View>
          <Text style={{ color: theme.textMuted, fontSize: 10, fontWeight: '700', letterSpacing: 0.5 }}>
            END SHIFT
          </Text>
        </Pressable>
      </View>

      {/* Content */}
      <View style={{ flex: 1 }}>
        <Slot />
      </View>
    </View>
  )
}
