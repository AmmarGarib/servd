// Cards, labels, badges and banners — the small building blocks every screen
// shares. Colours only from ../lib/theme.

import type { ReactNode } from 'react'
import { Pressable, Text, View, type ViewStyle } from 'react-native'
import { colors, theme, type as t } from '../lib/theme'
import type { JobStage } from '../lib/types'

export function Card({ children, style, tone = 'plain' }: {
  children: ReactNode
  style?: ViewStyle
  tone?: 'plain' | 'purple' | 'green'
}) {
  const bg = tone === 'purple' ? colors.purple : tone === 'green' ? colors.successBg : colors.card
  const border = tone === 'purple' ? colors.purple : colors.border
  return (
    <View style={{
      backgroundColor: bg,
      borderColor: border,
      borderWidth: 1,
      borderRadius: theme.radiusLg,
      padding: theme.pad,
      ...style,
    }}>
      {children}
    </View>
  )
}

export function Label({ children, color }: { children: ReactNode; color?: string }) {
  return <Text style={{ ...t.label, ...(color ? { color } : {}), marginBottom: 6 }}>{children}</Text>
}

// ─── Stage badge ────────────────────────────────────────────────────────────

const STAGE: Record<JobStage, { label: string; bg: string; fg: string }> = {
  offered:   { label: 'New job',          bg: colors.purple,   fg: colors.onPurple },
  accepted:  { label: 'Go to kitchen',    bg: colors.green,    fg: colors.onGreen },
  picked_up: { label: 'On the way',       bg: colors.infoBg,   fg: colors.purpleDeep },
  arrived:   { label: 'At the customer',  bg: colors.warnBg,   fg: colors.warn },
}

export function stageLabel(stage: JobStage): string {
  return STAGE[stage]?.label ?? stage
}

export function StageBadge({ stage, large }: { stage: JobStage; large?: boolean }) {
  const s = STAGE[stage] ?? { label: stage, bg: colors.cardSunk, fg: colors.ink }
  return (
    <View style={{
      alignSelf: 'flex-start',
      backgroundColor: s.bg,
      borderRadius: 999,
      paddingHorizontal: large ? 14 : 10,
      paddingVertical: large ? 7 : 4,
    }}>
      <Text style={{ color: s.fg, fontWeight: '900', fontSize: large ? 14 : 12, letterSpacing: 0.8 }}>
        {s.label.toUpperCase()}
      </Text>
    </View>
  )
}

// ─── Banner ─────────────────────────────────────────────────────────────────

export function Banner({ tone, title, body, actionLabel, onAction }: {
  tone: 'info' | 'warn' | 'danger' | 'success'
  title: string
  body?: string
  actionLabel?: string
  onAction?: () => void
}) {
  const palette = {
    info:    { bg: colors.infoBg,    fg: colors.purpleDeep, bar: colors.purple },
    warn:    { bg: colors.warnBg,    fg: colors.warn,       bar: colors.warn },
    danger:  { bg: colors.dangerBg,  fg: colors.danger,     bar: colors.danger },
    success: { bg: colors.successBg, fg: colors.greenText,  bar: colors.green },
  }[tone]
  return (
    <View
      accessibilityRole="alert"
      style={{
        backgroundColor: palette.bg,
        borderLeftWidth: 6,
        borderLeftColor: palette.bar,
        borderRadius: theme.radius,
        padding: 14,
        gap: 4,
      }}>
      <Text style={{ color: palette.fg, fontWeight: '900', fontSize: 16 }}>{title}</Text>
      {body ? <Text style={{ color: colors.ink, fontSize: 15, lineHeight: 21 }}>{body}</Text> : null}
      {actionLabel && onAction ? (
        <Pressable onPress={onAction} hitSlop={10} accessibilityRole="button" style={{ marginTop: 6, alignSelf: 'flex-start', minHeight: 36, justifyContent: 'center' }}>
          <Text style={{ color: palette.fg, fontWeight: '900', fontSize: 15, textDecorationLine: 'underline' }}>{actionLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  )
}

/** A simple filled circle — status dots, list markers. No emoji icons. */
export function Dot({ color, size = 12 }: { color: string; size?: number }) {
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />
}
