// Design tokens for the storefront.
//
// Two palettes:
//   • SERVD_TOKENS — used on the aggregator (home, browse, checkout, account)
//   • BRAND_TOKENS — used on the brand microsites under /brand/[slug]
//
// Brands will eventually get per-brand colors from a brand book; until then
// they all share the same green/white palette as a placeholder. Per-brand
// overrides will live in `BRAND_OVERRIDES` keyed by slug.

export const SERVD_TOKENS = {
  // Primary servd green — richer than the prior #4ade80, still reads as
  // "light green" but is legible against white as text and as a button bg.
  green:        '#22c55e',
  greenDark:    '#16a34a',
  greenSoft:    '#dcfce7',   // subtle backgrounds
  greenInk:     '#052e16',   // for text on green
  black:        '#0a0a0a',
  ink:          '#171717',
  mute:         '#525252',
  dim:          '#a3a3a3',
  line:         'rgba(0,0,0,0.08)',
  bg:           '#ffffff',
  surface:      '#fafafa',
  red:          '#dc2626',
  amber:        '#d97706',
} as const

export const BRAND_TOKENS = {
  green:        '#16a34a',
  greenDark:    '#15803d',
  greenSoft:    '#dcfce7',
  black:        '#0a0a0a',
  ink:          '#171717',
  mute:         '#525252',
  dim:          '#a3a3a3',
  line:         'rgba(0,0,0,0.08)',
  bg:           '#ffffff',
  surface:      '#fafafa',
} as const

// Per-brand overrides — populated when a brand book is delivered. Keys are
// concept slugs. Until set, each brand falls back to BRAND_TOKENS.
export const BRAND_OVERRIDES: Record<string, Partial<typeof BRAND_TOKENS>> = {
  // Example shape, all commented out until brand books arrive:
  // simmer: { green: '#2D4A3E', greenDark: '#1d3328', greenSoft: '#e6efe9' },
  // stax:   { green: '#dc2626', greenDark: '#991b1b', greenSoft: '#fee2e2' },
}

export function tokensForBrand(slug: string): typeof BRAND_TOKENS {
  return { ...BRAND_TOKENS, ...(BRAND_OVERRIDES[slug] ?? {}) }
}

// Spacing & radius scales — used inline; keep them small.
export const SPACE = {
  xs: '0.5rem', sm: '0.75rem', md: '1rem', lg: '1.5rem', xl: '2rem', '2xl': '3rem', '3xl': '4.5rem', '4xl': '6rem',
} as const

export const RADIUS = {
  sm: '0.5rem', md: '0.75rem', lg: '1rem', xl: '1.5rem', pill: '999px',
} as const

export const SHADOW = {
  sm: '0 1px 2px rgba(0,0,0,0.06)',
  md: '0 4px 14px rgba(0,0,0,0.08)',
  lg: '0 12px 40px rgba(0,0,0,0.12)',
} as const

// Layout breakpoints (mirrors Tailwind defaults; we use these in JS only)
export const BP = {
  sm: 640, md: 768, lg: 1024, xl: 1280,
} as const

export const FONT = {
  sans: '"Inter", system-ui, -apple-system, "Segoe UI", sans-serif',
  display: '"Inter", system-ui, -apple-system, "Segoe UI", sans-serif',
}
