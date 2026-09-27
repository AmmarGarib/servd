// The cut: every page change on the storefront plays as a set-piece cut.
//
// This module is the store between the one <SceneCut/> mounted in the root
// layout and everything that wants to navigate with a cut. SceneCut registers
// its runner here; `requestCut` hands work to it; `onCut` lets sfx/crowd hooks
// observe the phases. It also owns the naming: which theme a route cuts in,
// and the title card (kicker + title) it shows.
//
// Pure module — no React, safe to import from server components (the loaders
// call cutTitleFor to render the same title card the cut holds on).

import { formatBrandName } from '../concept'

export type CutTheme = 'servd' | 'simmer' | 'stackd' | 'flipd'
export type CutPhase = 'cover' | 'hold' | 'reveal' | 'done'

export interface CutOptions {
  kicker?: string          // small mono line above the title, e.g. "now ordering"
  title?: string           // big line; brand names already passed through formatBrandName
  stamp?: string           // optional rubber-stamp text (the order total on "that's a wrap")
  origin?: DOMRect | null  // rect the slate grows from; default = viewport centre, 1px
  theme?: CutTheme         // default cutThemeFor(href)
  replace?: boolean        // router.replace instead of push
}

type Runner = (href: string, opts: CutOptions) => boolean
type Listener = (phase: CutPhase, href: string, theme: CutTheme) => void

let runner: Runner | null = null
const listeners = new Set<Listener>()

/** @internal SceneCut registers itself here on mount (null on unmount). */
export function __registerCutRunner(r: Runner | null): void {
  runner = r
}

/** @internal SceneCut reports each phase; listeners never break the cut. */
export function __emitCut(phase: CutPhase, href: string, theme: CutTheme): void {
  listeners.forEach((cb) => {
    try { cb(phase, href, theme) } catch { /* an observer must never stall the cut */ }
  })
}

/** Programmatic navigation with the cut. Returns false when SceneCut isn't mounted, reduced motion is on,
 *  or a cut is already running; the caller must then router.push itself. */
export function requestCut(href: string, opts: CutOptions = {}): boolean {
  if (!runner || typeof window === 'undefined') return false
  try {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return false
    return runner(href, opts)
  } catch {
    return false
  }
}

/** Observe cut phases (sfx/crowd hooks). Returns unsubscribe. */
export function onCut(cb: (phase: CutPhase, href: string, theme: CutTheme) => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

/* ── Naming ─────────────────────────────────────────────────────────── */

const THEME_RE = /^\/(brand\/|reserve\/)?(simmer|stackd|flipd)(\/|$|\?|#)/

/** Path (+ search/hash) of an href, relative or absolute. */
function pathOf(href: string): string {
  if (!href) return '/'
  if (href.startsWith('/')) return href
  try {
    const u = new URL(href, 'http://servd.local')
    return `${u.pathname}${u.search}${u.hash}`
  } catch {
    return '/'
  }
}

export function cutThemeFor(href: string): CutTheme {
  const m = THEME_RE.exec(pathOf(href).toLowerCase())
  return (m?.[2] as CutTheme | undefined) ?? 'servd'
}

/** The three brands' display names; everything else renders as its slug. */
const BRAND_NAMES: Record<string, string> = { stackd: 'stackd', simmer: 'simmer', flipd: 'Flipd' }
const brandName = (slug: string) => formatBrandName(BRAND_NAMES[slug] ?? slug)

/** Top-level segments that are servd pages, not a concept slug. Mirrors the
 *  reserved list in StorefrontNav / FeedbackWidget. */
export const RESERVED_SEGMENTS: readonly string[] = [
  'order', 'browse', 'account', 'orders', 'login', 'signup',
  'checkout', 'brand', 'reserve', 'auth', 'api',
]

/** Title cards are lowercase; the only capital on the storefront is Flipd's F. */
export function filmCase(t: string): string {
  return t.toLowerCase().replace(/\bflipd\b/g, 'Flipd')
}

export function cutTitleFor(href: string): { kicker: string; title: string } {
  const path = pathOf(href).split(/[?#]/)[0] ?? '/'
  const seg = path.split('/').filter(Boolean).map((s) => {
    try { return decodeURIComponent(s).toLowerCase() } catch { return s.toLowerCase() }
  })
  const [a, b, c] = seg

  if (!a) return { kicker: 'servd presents', title: 'every kitchen, one place' }
  switch (a) {
    case 'browse': return { kicker: 'scene two', title: 'pick your craving' }
    case 'order': return { kicker: 'the lineup', title: 'pick a kitchen' }
    case 'brand': return b ? { kicker: 'now showing', title: brandName(b) } : { kicker: 'next scene', title: '' }
    case 'checkout': return { kicker: 'the bag', title: 'closing the tab' }
    case 'account': return { kicker: 'your reel', title: 'welcome back' }
    case 'orders': return { kicker: 'the archive', title: 'past orders' }
    case 'reserve': return { kicker: 'a table', title: 'for later' }
    case 'login':
    case 'signup': return { kicker: 'backstage', title: 'come on in' }
  }
  if (RESERVED_SEGMENTS.includes(a)) return { kicker: 'next scene', title: '' }

  // /<slug>…
  if (!b) return { kicker: 'now ordering', title: brandName(a) }
  if (b === 'checkout') {
    return a === 'simmer'
      ? { kicker: 'the bill', title: 'settling up' }
      : { kicker: 'the bag', title: 'closing the tab' }
  }
  if (b === 'order' && c) return { kicker: "that's a wrap", title: 'your order' }
  return { kicker: 'next scene', title: '' }
}

/** The loader's status line for a destination, or undefined for the default
 *  cycle. Lowercase, no exclamation marks — safe on every brand. */
export function statusFor(href: string): string | undefined {
  const path = pathOf(href).split(/[?#]/)[0] ?? '/'
  const seg = path.split('/').filter(Boolean).map((s) => s.toLowerCase())
  if (seg[0] === 'browse') return 'scouting three kitchens…'
  if (seg[0] === 'checkout' || (seg.length === 2 && seg[1] === 'checkout' && !RESERVED_SEGMENTS.includes(seg[0] ?? ''))) {
    return 'writing the ticket…'
  }
  if (seg.length >= 3 && seg[1] === 'order' && !RESERVED_SEGMENTS.includes(seg[0] ?? '')) return 'opening the kitchen doors…'
  return undefined
}
