// Big-thumb button. Four intents:
//   primary   — green, purple text (servd: text on green is purple, never white)
//   secondary — purple, bone text
//   ghost     — outline on bone
//   danger    — red, bone text
// Sizes: md 56 pt, lg 64 pt, xl 72 pt (the job step button).

import { ActivityIndicator, Pressable, Text, type TextStyle, type ViewStyle } from 'react-native'
import { colors, theme } from '../lib/theme'

export type ButtonIntent = 'primary' | 'secondary' | 'ghost' | 'danger'

interface Props {
  label: string
  onPress: () => void
  intent?: ButtonIntent
  size?: 'md' | 'lg' | 'xl'
  disabled?: boolean
  busy?: boolean
  style?: ViewStyle
  full?: boolean
  accessibilityHint?: string
}

const PALETTE: Record<ButtonIntent, { bg: string; fg: string; border: string }> = {
  primary:   { bg: colors.green,       fg: colors.onGreen,  border: colors.green },
  secondary: { bg: colors.purple,      fg: colors.onPurple, border: colors.purple },
  ghost:     { bg: colors.transparent, fg: colors.ink,      border: colors.borderHi },
  danger:    { bg: colors.danger,      fg: colors.onPurple, border: colors.danger },
}

export function Button({
  label, onPress, intent = 'primary', size = 'md', disabled, busy, style, full = true, accessibilityHint,
}: Props) {
  const p = PALETTE[intent]
  const minHeight = size === 'xl' ? 72 : size === 'lg' ? 64 : theme.tapMin
  const fontSize: TextStyle['fontSize'] = size === 'xl' ? 22 : size === 'lg' ? 19 : 17

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !!(disabled || busy), busy: !!busy }}
      hitSlop={6}
      style={({ pressed }) => ({
        backgroundColor: p.bg,
        borderColor: p.border,
        borderWidth: 2,
        borderRadius: theme.radius,
        paddingHorizontal: 20,
        minHeight,
        alignSelf: full ? 'stretch' : 'flex-start',
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.4 : pressed ? 0.82 : 1,
        transform: [{ scale: pressed ? 0.985 : 1 }],
        ...style,
      })}>
      {busy
        ? <ActivityIndicator color={p.fg} />
        : <Text style={{ color: p.fg, fontWeight: '800', fontSize, letterSpacing: 0.2, textAlign: 'center' }}>{label}</Text>}
    </Pressable>
  )
}
