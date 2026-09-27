// Per-kitchen palette for the finale surfaces (empty bag, checkout marks,
// tracker mood, brand-aware login). Colours come from the brand books in
// CLAUDE.md; nothing here is fetched, so every surface still looks designed
// with the API down.

import { formatBrandName } from '../../lib/concept'
import { voiceBrand, type VoiceBrand } from '../../lib/voice'

export interface FinaleTheme {
  brand: VoiceBrand
  /** Display name, already through formatBrandName. */
  name: string
  /** Scene field colour. */
  bg: string
  /** Primary text on `bg`. */
  ink: string
  /** Secondary text on `bg`. */
  mute: string
  /** The brand's signal colour (pill crossfade, route line, mood wash). */
  accent: string
  /** Primary button fill + label on `bg`. */
  ctaBg: string
  ctaInk: string
  /** Paper-bag fill + outline on `bg`. */
  bagFill: string
  bagLine: string
  /** Display + body type. */
  display: string
  body: string
  /** Login shader colour and page base. */
  smoke: string
  smokeBase: string
  /** Colour for any text we add on the dark login (simmer: bone, never white). */
  loginInk: string
}

const RAW_NAMES: Record<VoiceBrand, string> = {
  servd: 'servd',
  stackd: 'stackd',
  simmer: 'simmer',
  flipd: 'Flipd',
}

export function brandName(brand: VoiceBrand): string {
  return formatBrandName(RAW_NAMES[brand])
}

const THEMES: Record<VoiceBrand, Omit<FinaleTheme, 'brand' | 'name'>> = {
  servd: {
    bg: '#FFD447', ink: '#2A1A2B', mute: 'rgba(42,26,43,0.72)', accent: '#4E2A4F',
    ctaBg: '#4E2A4F', ctaInk: '#FFF4D6',
    bagFill: '#E9C48F', bagLine: '#2A1A2B',
    display: "var(--font-display), 'Bricolage Grotesque', system-ui, sans-serif",
    body: "var(--font-display), 'Bricolage Grotesque', system-ui, sans-serif",
    smoke: '#4E2A4F', smokeBase: '#1E1420', loginInk: '#FFFFFF',
  },
  stackd: {
    bg: '#7C2946', ink: '#FCE8CE', mute: 'rgba(252,232,206,0.74)', accent: '#9BD3DD',
    ctaBg: '#FCE8CE', ctaInk: '#7C2946',
    bagFill: '#FCE8CE', bagLine: '#3D1122',
    display: "var(--stackd-display), 'Playfair Display', Georgia, serif",
    body: "var(--stackd-body), 'Inter', system-ui, sans-serif",
    smoke: '#7C2946', smokeBase: '#3D1122', loginInk: '#FCE8CE',
  },
  flipd: {
    bg: '#FED561', ink: '#294375', mute: 'rgba(41,67,117,0.78)', accent: '#294375',
    ctaBg: '#294375', ctaInk: '#FED561',
    bagFill: '#F9F0E1', bagLine: '#294375',
    display: "var(--flipd-display), 'Alfa Slab One', Georgia, serif",
    body: "var(--flipd-body), 'Poppins', system-ui, sans-serif",
    smoke: '#294375', smokeBase: '#1D3159', loginInk: '#FED561',
  },
  simmer: {
    bg: '#06392F', ink: '#EDE6D3', mute: 'rgba(237,230,211,0.7)', accent: '#EDE6D3',
    ctaBg: 'transparent', ctaInk: '#EDE6D3',
    bagFill: 'transparent', bagLine: '#EDE6D3',
    display: "var(--simmer-display), 'Amarante', serif",
    body: "var(--simmer-body), 'Times New Roman', Times, serif",
    smoke: '#06392F', smokeBase: '#03261F', loginInk: '#EDE6D3',
  },
}

export function finaleTheme(slug?: string | null): FinaleTheme {
  const brand = voiceBrand(slug)
  return { brand, name: brandName(brand), ...THEMES[brand] }
}

/** Colour a kitchen pill crossfades the scene accent to. */
export const PILL_ACCENT: Record<Exclude<VoiceBrand, 'servd'>, string> = {
  stackd: '#7C2946',
  flipd: '#294375',
  simmer: '#06392F',
}

/** Tracker mood accent: the brand's deep colour (never simmer orange, which
 *  stays the single signal on the page). */
export function moodAccent(brand: VoiceBrand, dbColor?: string | null): string {
  if (brand === 'stackd') return '#7C2946'
  if (brand === 'flipd') return '#294375'
  if (brand === 'simmer') return '#06392F'
  return dbColor || '#4E2A4F'
}

/** Brand slug from a post-auth return path such as `/flipd/checkout`,
 *  `/stackd/order/abc`, `/brand/simmer` or `/reserve/simmer`. Same
 *  same-origin guard as login's postAuthDest. */
export function brandFromReturnPath(p: string | null | undefined): VoiceBrand {
  if (!p || !p.startsWith('/') || p.startsWith('//')) return 'servd'
  const m = /^\/(?:brand\/|reserve\/)?(simmer|stackd|stax|flipd)(?:[/?#]|$)/i.exec(p)
  return voiceBrand(m?.[1] ?? null)
}
