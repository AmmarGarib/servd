// Reusable numeric keypad — used for PIN entry and cash tender amounts. The
// 3×4 grid is sized to fill the available column comfortably on a 10"+ tablet.

import { View, Text, Pressable } from 'react-native'
import * as Haptics from 'expo-haptics'
import { theme } from '../lib/theme'

const KEYS = ['1','2','3','4','5','6','7','8','9','clear','0','del'] as const

export function Keypad({ value, onChange, onSubmit, maxLength = 6, extraKey }: {
  value: string
  onChange: (v: string) => void
  onSubmit?: () => void
  maxLength?: number
  extraKey?: { label: string; onPress: () => void } // e.g. "00" or "."
}) {
  function press(k: typeof KEYS[number]) {
    Haptics.selectionAsync().catch(() => undefined)
    if (k === 'clear') return onChange('')
    if (k === 'del')   return onChange(value.slice(0, -1))
    if (value.length >= maxLength) return
    onChange(value + k)
  }
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12, maxWidth: 360, alignSelf: 'center' }}>
      {KEYS.map((k) => (
        <Pressable
          key={k}
          onPress={() => press(k)}
          onLongPress={k === 'del' ? () => onChange('') : undefined}
          style={({ pressed }) => ({
            width: 108, height: 84,
            borderRadius: theme.radius,
            backgroundColor: pressed ? 'rgba(255,255,255,0.12)' : theme.panelAlt,
            borderWidth: 1, borderColor: theme.border,
            alignItems: 'center', justifyContent: 'center',
          })}>
          <Text style={{
            color: theme.text, fontSize: k === 'clear' || k === 'del' ? 14 : 28,
            fontWeight: '800', letterSpacing: 0.5,
          }}>
            {k === 'clear' ? 'CLR' : k === 'del' ? '⌫' : k}
          </Text>
        </Pressable>
      ))}
      {extraKey && (
        <Pressable
          onPress={extraKey.onPress}
          style={({ pressed }) => ({
            width: 108, height: 60,
            borderRadius: theme.radius,
            backgroundColor: pressed ? 'rgba(255,255,255,0.12)' : theme.panelAlt,
            borderWidth: 1, borderColor: theme.border,
            alignItems: 'center', justifyContent: 'center',
          })}>
          <Text style={{ color: theme.text, fontSize: 18, fontWeight: '800' }}>{extraKey.label}</Text>
        </Pressable>
      )}
      {onSubmit && (
        <Pressable
          onPress={onSubmit}
          disabled={value.length === 0}
          style={({ pressed }) => ({
            width: 228, height: 60,
            borderRadius: theme.radius,
            backgroundColor: pressed ? theme.accentHi : theme.accent,
            alignItems: 'center', justifyContent: 'center',
            opacity: value.length === 0 ? 0.3 : 1,
          })}>
          <Text style={{ color: '#0a0a0a', fontSize: 18, fontWeight: '800', letterSpacing: 0.5 }}>OK</Text>
        </Pressable>
      )}
    </View>
  )
}
