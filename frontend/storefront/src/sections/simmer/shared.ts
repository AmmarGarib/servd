// Simmer section helpers — shared by the server and client sections in this
// group. Plain functions only (no React), so either side can import them.
//
// The simmer-brand SKILL.md rules that an owner-typed field could break are
// held here, in code, rather than trusted to the editor:
//   • no exclamation marks and no emoji      → simmerText()
//   • no white, no colours off the palette   → surface() (a two-value select,
//                                              never a free colour field)

import { str, lines } from '../safe'
import { FALLBACK_CONCEPTS } from '../../lib/fallbackBrands'
import type { Concept } from '../../lib/concept'
import type { SectionContext } from '../types'

const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}]/gu

/** A Simmer text field: emoji dropped, exclamation marks turned into full stops. */
export function simmerText(v: unknown, fallback = ''): string {
  return str(v, fallback).replace(EMOJI, '').replace(/[!¡]+/g, '.')
}

/** A Simmer textarea, split on the editor's line breaks. */
export function simmerLines(v: unknown): string[] {
  return lines(v).map((l) => simmerText(l))
}

/**
 * Tonight's service date in the printed menu's `dd.mm.yy` rhythm. Taken in
 * Karachi time — it is the restaurant's service date, and computing it in one
 * zone keeps the server render and the browser in step.
 */
export function serviceStamp(now: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Karachi', day: '2-digit', month: '2-digit', year: '2-digit',
    }).formatToParts(now)
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
    return `${get('day')}.${get('month')}.${get('year')}`
  } catch {
    const dd = String(now.getDate()).padStart(2, '0')
    const mm = String(now.getMonth() + 1).padStart(2, '0')
    return `${dd}.${mm}.${String(now.getFullYear()).slice(-2)}`
  }
}

/** A stamp field: '' means today's service date. */
export function stampOr(v: unknown): string {
  return simmerText(v).trim() || serviceStamp()
}

export type SurfaceName = 'green' | 'bone'

export interface Surface {
  name: SurfaceName
  background: string
  /** Ink on this surface. */
  color: string
  /** Hairline rule colour on this surface. */
  line: string
}

/** The two Simmer surfaces: tiber green (bone ink) or bone (tiber ink). */
export function surface(v: unknown, fallback: SurfaceName): Surface {
  const name: SurfaceName = v === 'bone' || v === 'green' ? v : fallback
  return name === 'bone'
    ? { name, background: 'var(--simmer-bone)', color: 'var(--simmer-green)', line: 'rgba(6,57,47,0.18)' }
    : { name, background: 'var(--simmer-green)', color: 'var(--simmer-bone)', line: 'rgba(237,230,211,0.18)' }
}

/** The brand this page is about (live), or the bundled Simmer record. */
export function simmerConcept(ctx: SectionContext): Concept {
  return ctx.concept ?? (FALLBACK_CONCEPTS['simmer'] as Concept)
}
