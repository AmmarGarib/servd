// Big-finger touch target. Three intents — primary (default), danger, ghost.
// Sizes tuned for landscape tablet at arm's length (min hit 56pt).

import { ActivityIndicator, Pressable, Text, ViewStyle, TextStyle } from 'react-native'
import { theme } from '../lib/theme'

interface Props {
  label: string
  onPress: () => void
  intent?: 'primary' | 'danger' | 'ghost' | 'warn'
  size?: 'md' | 'lg' | 'xl'
  disabled?: boolean
  busy?: boolean
  style?: ViewStyle
  full?: boolean
}

export function Button({ label, onPress, intent = 'primary', size = 'md', disabled, busy, style, full }: Props) {
  const bg =
    intent === 'primary' ? theme.accent :
    intent === 'danger'  ? theme.danger :
    intent === 'warn'    ? theme.warn   : 'transparent'
  const fg = intent === 'ghost' ? theme.text : '#0a0a0a'
  const border = intent === 'ghost' ? theme.borderHi : 'transparent'

  const minH = size === 'xl' ? 72 : size === 'lg' ? 60 : 52
  const fontSize: TextStyle['fontSize'] = size === 'xl' ? 22 : size === 'lg' ? 18 : 16

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => ({
        backgroundColor: bg,
        borderRadius: theme.radius,
        borderWidth: 1,
        borderColor: border,
        paddingHorizontal: 24,
        minHeight: minH,
        alignSelf: full ? 'stretch' : 'flex-start',
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.35 : pressed ? 0.85 : 1,
        ...style,
      })}>
      {busy
        ? <ActivityIndicator color={fg} />
        : <Text style={{ color: fg, fontWeight: '700', fontSize, letterSpacing: 0.3 }}>{label}</Text>}
    </Pressable>
  )
}
