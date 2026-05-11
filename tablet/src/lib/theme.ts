// Dark theme tuned for kitchen / counter lighting — high contrast, large hit
// targets, status colors readable from across the line. Designed for landscape
// tablets at arm's length (≈90cm typical kitchen mount distance).

export const theme = {
  bg:        '#0b0d12',
  panel:     '#13161d',
  panelAlt:  '#1a1e27',
  border:    'rgba(255,255,255,0.08)',
  borderHi:  'rgba(255,255,255,0.18)',
  text:      '#ffffff',
  textDim:   'rgba(255,255,255,0.6)',
  textMuted: 'rgba(255,255,255,0.4)',
  accent:    '#22c55e',
  accentHi:  '#16a34a',
  warn:      '#f59e0b',
  danger:    '#ef4444',
  info:      '#3b82f6',

  // KDS status palette — readable at distance
  newOrder:  '#3b82f6',
  fired:     '#f59e0b',
  ready:     '#22c55e',
  late:      '#ef4444',

  radius:    14,
  radiusLg:  20,
  pad:       16,
  padLg:     24,
} as const

export const elevation = {
  panel: {
    backgroundColor: theme.panel,
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: theme.radius,
  },
} as const
