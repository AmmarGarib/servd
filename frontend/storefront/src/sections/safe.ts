// Field values come from the editor, so links and media are checked before
// they reach an href/src. Every section renderer uses these.

import type { LinkValue } from './types'

const SAFE_HREF = /^(https?:\/\/|mailto:|tel:|\/(?!\/)|#|\?)/i
const SAFE_SRC = /^(https:\/\/|\/(?!\/))/i

/** A link target, or '#' when it is empty or unsafe (javascript:, //host …). */
export function safeHref(v: unknown, fallback = '#'): string {
  const s = typeof v === 'string' ? v.trim() : ''
  return s && SAFE_HREF.test(s) ? s : fallback
}

/** An image/video URL, or '' when it is empty or unsafe. */
export function safeSrc(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : ''
  return s && SAFE_SRC.test(s) ? s : ''
}

/** A string field ('' when missing). */
/** Owner, 2026-10-26 (S8): the website shows no Privacy / Terms links for now ("will add later for the app").
 *  True for a link to /privacy or /terms (relative, or on servd's origin, any query / hash). Footer renderers
 *  skip these so links stored in a saved layout are hidden too. */
export function isHiddenLegalHref(v: unknown): boolean {
  if (typeof v !== 'string') return false
  const m = v.trim().replace(/^https?:\/\/(www\.)?servd\.pk/i, '').match(/^\/(privacy|terms)(?:[/?#]|$)/i)
  return !!m
}

export function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

/** A link field ({ text, href }), tolerant of a bare string href. */
export function link(v: unknown, fallback: LinkValue = { text: '', href: '' }): LinkValue {
  if (typeof v === 'string') return { text: fallback.text, href: v }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return { text: str(o.text, fallback.text), href: str(o.href, fallback.href) }
  }
  return fallback
}

/** A list field (array of objects). */
export function list<T = Record<string, unknown>>(v: unknown): T[] {
  return Array.isArray(v) ? (v.filter((x) => x && typeof x === 'object') as T[]) : []
}

/** A CSS colour field, or undefined when empty (use the design's own). */
export function color(v: unknown): string | undefined {
  const s = typeof v === 'string' ? v.trim() : ''
  // Colours only — no url()/expression smuggling into a style.
  return s && /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%deg]+\)|var\(--[a-z0-9-]+\)|[a-z]+)$/i.test(s) ? s : undefined
}

/** Text with editor line breaks (\n) — split for rendering. */
export function lines(v: unknown): string[] {
  return str(v).split('\n')
}
