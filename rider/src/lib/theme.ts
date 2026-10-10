// The rider app's ONE colour file. Every colour on every screen comes from
// here — never hard-code a hex in a screen or component.
//
// servd tokens (owner, 2026-10-05), the same set the storefront and admin use:
//   bone   #f3e7cd  background
//   green  #87c540  primary — text ON green is purple, never white
//   purple #5a2156  secondary (bands, purple buttons); deep shade #3f1640
//   ink    #3d1f3b  text
// Green used as TEXT on bone is #4f7a1c (the bright green fails contrast).
//
// Sized for a rider on a bike: big type, big tap targets (min 64 pt for the
// step button), high contrast in daylight.

export const colors = {
  // Surfaces
  bone:        '#f3e7cd',
  card:        '#fbf4e3',   // a lifted bone for cards / inputs
  cardSunk:    '#ead9b8',   // a pressed / sunk bone

  // Brand
  green:       '#87c540',
  greenText:   '#4f7a1c',   // green as text on bone
  purple:      '#5a2156',
  purpleDeep:  '#3f1640',
  ink:         '#3d1f3b',

  // Text
  text:        '#3d1f3b',
  textDim:     'rgba(61,31,59,0.72)',
  textMuted:   'rgba(61,31,59,0.52)',
  onGreen:     '#5a2156',   // text on green = purple
  onPurple:    '#f3e7cd',   // text on purple = bone
  onPurpleDim: 'rgba(243,231,205,0.62)',

  // Lines
  border:      'rgba(61,31,59,0.14)',
  borderHi:    'rgba(61,31,59,0.32)',

  // Status
  danger:      '#a3261f',
  dangerBg:    '#f6d4cc',
  warn:        '#8a5300',
  warnBg:      '#f5dca6',
  infoBg:      '#e4d3e2',   // a pale purple wash
  successBg:   '#dcebc4',   // a pale green wash

  transparent: 'transparent',
} as const

export const theme = {
  ...colors,
  bg:       colors.bone,
  primary:  colors.green,
  secondary: colors.purple,

  radius:   14,
  radiusLg: 22,
  pad:      16,
  padLg:    24,

  // Tap targets — a gloved thumb on a moving bike.
  tapMin:   56,
  tapStep:  68,
} as const

export const type = {
  title:   { fontSize: 28, fontWeight: '900' as const, color: colors.text, letterSpacing: -0.5 },
  heading: { fontSize: 20, fontWeight: '800' as const, color: colors.text },
  body:    { fontSize: 17, fontWeight: '500' as const, color: colors.text },
  label:   { fontSize: 12, fontWeight: '800' as const, color: colors.textMuted, letterSpacing: 1.4 },
  small:   { fontSize: 14, fontWeight: '500' as const, color: colors.textDim },
} as const
