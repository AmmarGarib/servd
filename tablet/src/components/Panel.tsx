import { View, Text, ViewStyle } from 'react-native'
import { theme } from '../lib/theme'

export function Panel({ title, action, children, style }: {
  title?: string
  action?: React.ReactNode
  children: React.ReactNode
  style?: ViewStyle
}) {
  return (
    <View style={{
      backgroundColor: theme.panel,
      borderWidth: 1,
      borderColor: theme.border,
      borderRadius: theme.radius,
      padding: theme.pad,
      ...style,
    }}>
      {(title || action) && (
        <View style={{
          flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
          marginBottom: title ? theme.pad : 0,
        }}>
          {title ? <Text style={{ color: theme.text, fontWeight: '800', fontSize: 18 }}>{title}</Text> : <View />}
          {action}
        </View>
      )}
      {children}
    </View>
  )
}

export function Pill({ label, tone = 'neutral' }: { label: string; tone?: 'neutral' | 'success' | 'warn' | 'danger' | 'info' }) {
  const colors = {
    neutral: { bg: 'rgba(255,255,255,0.08)',  fg: theme.textDim },
    success: { bg: 'rgba(34,197,94,0.18)',    fg: '#86efac' },
    warn:    { bg: 'rgba(245,158,11,0.18)',   fg: '#fcd34d' },
    danger:  { bg: 'rgba(239,68,68,0.18)',    fg: '#fca5a5' },
    info:    { bg: 'rgba(59,130,246,0.18)',   fg: '#93c5fd' },
  }[tone]
  return (
    <View style={{ backgroundColor: colors.bg, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 }}>
      <Text style={{ color: colors.fg, fontWeight: '700', fontSize: 12, letterSpacing: 0.5 }}>{label}</Text>
    </View>
  )
}
