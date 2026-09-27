// Per-brand surface for the ordering page (/[concept]) and its closed scene.
//
// The ordering page used to sit on #fff with a global "skin" class repainting
// inline white panels through attribute selectors. The film treats this page
// as the brand's own set instead, so each brand gets an explicit palette:
//
//   flipd  → bone field, blue ink, mustard signal (the diner)
//   stackd → red-plum field, cream sticker cards, sky as the one cool accent
//   simmer → tiber field, bone cards, orange as the single signal (no white,
//            no gradients, no characters)
//   servd  → hub cream, ink, plum CTA, butter pop
//
// Everything is exposed as CSS custom properties on the page root, so the
// module CSS (ordering.module.css) reads one set of names for every brand, and
// the legacy --servd-* tokens are remapped too for anything that still reads
// them (the dietary badges, the modifier fieldsets).

import type { CSSProperties } from 'react'

export type OrderingBrand = 'flipd' | 'stackd' | 'simmer' | 'servd'

export function orderingBrand(slug: string | null | undefined): OrderingBrand {
  if (slug === 'flipd' || slug === 'stackd' || slug === 'simmer') return slug
  return 'servd'
}

export interface OrderingTheme {
  brand: OrderingBrand
  /** Page field. */
  bg: string
  /** Text directly on the field. */
  onBg: string
  onBgMute: string
  /** Menu cards, sheets (item modal, basket). */
  card: string
  ink: string
  mute: string
  line: string
  /** CTA fill + the text that sits on it. */
  cta: string
  onCta: string
  /** Price colour on cards. */
  price: string
  /** Colour of the token that flies into the bag when there is no photo. */
  token: string
  /** FAB. */
  fab: string
  onFab: string
  fabBadge: string
  onFabBadge: string
  /** Duotone pair for the hero photo: shadows → dark, highlights → light. */
  duoDark: string
  duoLight: string
  /** Title plate on the hero. */
  plate: string
  onPlate: string
  display: string
  body: string
  /** Lowercase headings (simmer, stackd). */
  lower: boolean
}

const THEMES: Record<OrderingBrand, OrderingTheme> = {
  flipd: {
    brand: 'flipd',
    bg: '#F9F0E1', onBg: '#294375', onBgMute: 'rgba(41,67,117,0.72)',
    card: '#FFFBF3', ink: '#294375', mute: 'rgba(41,67,117,0.72)', line: 'rgba(41,67,117,0.22)',
    cta: '#294375', onCta: '#FED561', price: '#294375', token: '#FED561',
    fab: '#294375', onFab: '#F9F0E1', fabBadge: '#FED561', onFabBadge: '#294375',
    duoDark: '#294375', duoLight: '#FED561',
    plate: '#294375', onPlate: '#FED561',
    display: "var(--flipd-display, 'Alfa Slab One', Georgia, serif)",
    body: "var(--flipd-body, 'Poppins', system-ui, sans-serif)",
    lower: false,
  },
  stackd: {
    brand: 'stackd',
    bg: '#7C2946', onBg: '#FCE8CE', onBgMute: 'rgba(252,232,206,0.74)',
    card: '#FCE8CE', ink: '#3D1122', mute: 'rgba(61,17,34,0.72)', line: 'rgba(61,17,34,0.18)',
    cta: '#7C2946', onCta: '#FCE8CE', price: '#7C2946', token: '#9BD3DD',
    fab: '#FCE8CE', onFab: '#3D1122', fabBadge: '#9BD3DD', onFabBadge: '#3D1122',
    duoDark: '#3D1122', duoLight: '#FCE8CE',
    plate: '#FCE8CE', onPlate: '#7C2946',
    display: "var(--stackd-display, 'Playfair Display', Georgia, serif)",
    body: "var(--stackd-body, 'Inter', system-ui, sans-serif)",
    lower: true,
  },
  simmer: {
    brand: 'simmer',
    bg: '#06392F', onBg: '#EDE6D3', onBgMute: 'rgba(237,230,211,0.66)',
    card: '#EDE6D3', ink: '#06392F', mute: 'rgba(6,57,47,0.70)', line: 'rgba(6,57,47,0.20)',
    // The orange is simmer's single signal, so it is kept off the CTAs and
    // only marks the basket count on the FAB.
    cta: '#06392F', onCta: '#EDE6D3', price: '#06392F', token: '#EDE6D3',
    fab: '#EDE6D3', onFab: '#06392F', fabBadge: '#E94E1B', onFabBadge: '#06392F',
    duoDark: '#06392F', duoLight: '#EDE6D3',
    plate: 'transparent', onPlate: '#EDE6D3',
    display: "var(--simmer-display, 'Amarante', serif)",
    body: "var(--simmer-body, 'Times New Roman', Times, serif)",
    lower: true,
  },
  servd: {
    brand: 'servd',
    bg: '#FFF4D6', onBg: '#2A1A2B', onBgMute: 'rgba(42,26,43,0.72)',
    card: '#FFFBEE', ink: '#2A1A2B', mute: 'rgba(42,26,43,0.70)', line: 'rgba(42,26,43,0.18)',
    cta: '#4E2A4F', onCta: '#FFF4D6', price: '#4E2A4F', token: '#FFD447',
    fab: '#2A1A2B', onFab: '#FFF4D6', fabBadge: '#FFD447', onFabBadge: '#2A1A2B',
    duoDark: '#4E2A4F', duoLight: '#FFD447',
    plate: '#FFD447', onPlate: '#2A1A2B',
    display: "var(--font-display, 'Bricolage Grotesque', system-ui, sans-serif)",
    body: "var(--font-display, 'Inter', system-ui, sans-serif)",
    lower: false,
  },
}

export function orderingTheme(slug: string | null | undefined): OrderingTheme {
  return THEMES[orderingBrand(slug)]
}

type Vars = CSSProperties & Record<`--${string}`, string>

/** The theme as CSS custom properties for the page root. */
export function themeVars(t: OrderingTheme): Vars {
  return {
    '--o-bg': t.bg,
    '--o-on-bg': t.onBg,
    '--o-on-bg-mute': t.onBgMute,
    '--o-card': t.card,
    '--o-ink': t.ink,
    '--o-mute': t.mute,
    '--o-line': t.line,
    '--o-cta': t.cta,
    '--o-on-cta': t.onCta,
    '--o-price': t.price,
    '--o-fab': t.fab,
    '--o-on-fab': t.onFab,
    '--o-fab-badge': t.fabBadge,
    '--o-on-fab-badge': t.onFabBadge,
    '--o-duo-dark': t.duoDark,
    '--o-duo-light': t.duoLight,
    '--o-plate': t.plate,
    '--o-on-plate': t.onPlate,
    '--o-display': t.display,
    '--o-body': t.body,
    '--o-case': t.lower ? 'lowercase' : 'none',
    // Legacy tokens, remapped for anything that still reads them.
    '--servd-ink': t.ink,
    '--servd-mute': t.mute,
    '--servd-line': t.line,
    '--servd-surface': t.card,
    '--servd-green': t.cta,
    '--servd-green-dark': t.cta,
    '--servd-green-soft': t.line,
  }
}
