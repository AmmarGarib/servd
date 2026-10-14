// Input validation for the editor frame. Isomorphic (no 'server-only', no
// next/headers): the server action runs it on every render request, and the
// frame client runs the same block / settings / fonts sanitiser on pop-up docs,
// which it renders itself.
//
// The frame renders UNAUTHENTICATED input through the live renderers, so this
// keeps it to the shapes the renderers expect: bounded sizes, plain objects,
// string ids. Everything else still goes through the normal guards
// (sections/safe.ts, fontFaceCss, cssFontFamily, normalizeMotion, blockHref).
// Any value a renderer puts into a SERVER-side URL must be encoded or checked
// here: featured_menu / reviews / kitchens `conceptSlug` must look like a slug.

import type { Block, LibraryFont, PageSettings, PopupRules, SiteLayoutRead } from '../lib/blocks'
import type { FrameRenderCode, FrameRenderInput } from './types'
import { normalizeKit, normalizeKitFonts, type LiveKitEntry } from '../lib/brandKit'

export const MAX_INPUT_BYTES = 600_000
export const MAX_TOP_BLOCKS = 80
export const MAX_COLUMNS = 4
export const MAX_COLUMN_BLOCKS = 40
export const MAX_FONTS = 30

export type LayoutKind = 'page' | 'header' | 'footer' | 'widget' | 'popup'

export type ParsedSlug =
  | { prefix: 'servd'; page: string; kind: LayoutKind }
  | { prefix: 'page'; page: string; kind: 'page' }
  | { prefix: 'popup'; key: string; kind: 'popup' }
  | { prefix: 'brand'; brand: string; part: string | null; kind: LayoutKind }

// A copy of the backend grammar (backend/src/modules/siteLayouts/service.ts
// parseSlug). The layout kind is DERIVED from the slug, never trusted.
const PART = /^[a-z0-9][a-z0-9_-]{0,79}$/i
const SERVD_WIDGETS = new Set(['feedback'])
const chromeKind = (part: string): LayoutKind => (part === 'header' ? 'header' : part === 'footer' ? 'footer' : 'page')

export function parseEditorSlug(slug: unknown): ParsedSlug | null {
  if (typeof slug !== 'string' || slug.length > 200) return null
  const [prefix, a, b, ...rest] = slug.split(':')
  if (rest.length > 0 || !a || !PART.test(a)) return null
  if (prefix === 'servd' && b === undefined) return { prefix, page: a, kind: SERVD_WIDGETS.has(a) ? 'widget' : chromeKind(a) }
  if (prefix === 'page' && b === undefined) return { prefix, page: a, kind: 'page' }
  if (prefix === 'popup' && b === undefined) return { prefix, key: a, kind: 'popup' }
  if (prefix === 'brand') {
    if (b === undefined) return { prefix, brand: a, part: null, kind: 'page' }
    // `brand:<slug>:kit` is the brand kit, never a page: the kit editor
    // previews the brand's home with FrameDoc.kit instead.
    if (PART.test(b) && b.toLowerCase() !== 'kit') return { prefix, brand: a, part: b, kind: chromeKind(b) }
  }
  return null
}

/** A brand (concept) slug as the storefront API knows them. */
export const CONCEPT_SLUG = /^[a-z0-9][a-z0-9-]{0,59}$/

/** UTF-8 size of a string (what the request body really costs). */
export function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

const DATA_SLUG_BLOCKS = new Set(['featured_menu', 'reviews', 'kitchens'])

function sanitizeBlock(v: unknown, nested: boolean): Block | null {
  if (!isPlainObject(v)) return null
  const id = v['id']
  const type = v['type']
  if (typeof id !== 'string' || id.length < 1 || id.length > 100) return null
  if (typeof type !== 'string' || type.length < 1 || type.length > 40) return null
  if (nested && type === 'columns') return null
  const out: Record<string, unknown> = { ...v }
  if (DATA_SLUG_BLOCKS.has(type) && 'conceptSlug' in out) {
    const slug = out['conceptSlug']
    if (!(typeof slug === 'string' && CONCEPT_SLUG.test(slug))) delete out['conceptSlug']
  }
  if (type === 'columns') {
    const cols = Array.isArray(out['columns']) ? (out['columns'] as unknown[]) : []
    out['columns'] = cols.slice(0, MAX_COLUMNS).map((col) =>
      (Array.isArray(col) ? col : []).slice(0, MAX_COLUMN_BLOCKS)
        .map((c) => sanitizeBlock(c, true))
        .filter((c): c is Block => c !== null))
  }
  return out as unknown as Block
}

/** Top-level blocks (≤ 80; columns ≤ 4 × 40; no nested columns). */
export function sanitizeBlocks(v: unknown): Block[] {
  if (!Array.isArray(v)) return []
  return v.slice(0, MAX_TOP_BLOCKS)
    .map((b) => sanitizeBlock(b, false))
    .filter((b): b is Block => b !== null)
}

const cap = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' && v.length <= max ? v : undefined

const oneOf = <T extends string>(v: unknown, list: readonly T[], dflt: T): T =>
  typeof v === 'string' && (list as readonly string[]).includes(v) ? v as T : dflt

const POPUP_KINDS = ['signup', 'login', 'offer', 'announcement'] as const
const DISPLAYS = ['modal', 'bar', 'corner'] as const
const TRIGGERS = ['before_page', 'after_seconds', 'exit_intent', 'scroll'] as const
const AUDIENCES = ['everyone', 'signed_out', 'signed_in', 'never_ordered'] as const
const FREQUENCIES = ['once', 'daily', 'every_visit'] as const

export function sanitizePopupRules(v: unknown): PopupRules | undefined {
  if (!isPlainObject(v)) return undefined
  const strings = (x: unknown, re?: RegExp) =>
    (Array.isArray(x) ? x : []).filter((s): s is string => typeof s === 'string' && s.length <= 200 && (!re || re.test(s))).slice(0, 50)
  return {
    popupKind: oneOf(v['popupKind'], POPUP_KINDS, 'announcement'),
    display: oneOf(v['display'], DISPLAYS, 'modal'),
    trigger: oneOf(v['trigger'], TRIGGERS, 'before_page'),
    pages: strings(v['pages']),
    brands: strings(v['brands'], CONCEPT_SLUG),
    audience: oneOf(v['audience'], AUDIENCES, 'everyone'),
    frequency: oneOf(v['frequency'], FREQUENCIES, 'every_visit'),
  }
}

/** Keeps only what rendering reads: fonts, the A/B variant, pop-up rules. */
export function sanitizeSettings(v: unknown, kind: LayoutKind): PageSettings | null {
  if (!isPlainObject(v)) return null
  const out: PageSettings = {}
  const fonts = v['fonts']
  if (isPlainObject(fonts)) {
    const heading = cap(fonts['heading'], 120)
    const body = cap(fonts['body'], 120)
    if (heading !== undefined || body !== undefined) out.fonts = { ...(heading !== undefined && { heading }), ...(body !== undefined && { body }) }
  }
  const ab = v['ab']
  if (isPlainObject(ab) && Array.isArray(ab['blocks'])) {
    const pct = ab['splitPct']
    out.ab = { splitPct: typeof pct === 'number' && Number.isFinite(pct) ? pct : 0, blocks: sanitizeBlocks(ab['blocks']) }
  }
  if (kind === 'popup') {
    const popup = sanitizePopupRules(v['popup'])
    if (popup) out.popup = popup
  }
  return out
}

export function sanitizeFonts(v: unknown): LibraryFont[] {
  if (!Array.isArray(v)) return []
  const out: LibraryFont[] = []
  for (const f of v) {
    if (out.length >= MAX_FONTS) break
    if (!isPlainObject(f)) continue
    const family = cap(f['family'], 120)
    const url = cap(f['url'], 2000)
    if (family && url) out.push({ family, url })
  }
  return out
}

/** The page a pop-up is shown over in the frame: the one brand it targets
 *  (exactly one), else the servd home page. */
export function popupContextSlug(settings: PageSettings | null): string {
  const brands = settings?.popup?.brands ?? []
  return brands.length === 1 && CONCEPT_SLUG.test(brands[0]!) ? `brand:${brands[0]}` : 'servd:home'
}

/** A slug popupContextSlug() can return: servd:home or brand:<concept slug>. */
export function isBackdropSlug(parsed: ParsedSlug): boolean {
  if (parsed.prefix === 'servd') return parsed.page === 'home'
  if (parsed.prefix === 'brand') return parsed.part === null && CONCEPT_SLUG.test(parsed.brand)
  return false
}

/** A brand's unsaved kit to paint the frame with (protocol FrameKit). */
export interface FrameKitInput { brand: string; entry: LiveKitEntry }

/** FrameKit → the shape resolveKit reads; null when absent or malformed
 *  (the page then paints with the live kits). Values go through the same
 *  validation as live kits (lib/brandKit.ts normalizeKit). */
export function sanitizeFrameKit(v: unknown): FrameKitInput | null {
  if (!isPlainObject(v)) return null
  const brand = v['brand']
  if (typeof brand !== 'string' || !CONCEPT_SLUG.test(brand) || !isPlainObject(v['kit'])) return null
  return { brand, entry: { kit: normalizeKit(v['kit']), version: 0, fonts: normalizeKitFonts(v['fonts']) } }
}

export interface SanitizedFrameInput {
  rev: number
  slug: string
  parsed: ParsedSlug
  /** The working copy as the public read shape; null = render `slug` live. */
  draft: SiteLayoutRead | null
  variant: 'a' | 'b'
  /** A draft brand kit overriding that brand's live kit; null = live kits. */
  kit: FrameKitInput | null
}

export type SanitizeResult =
  | { ok: true; value: SanitizedFrameInput; bytes: number }
  | { ok: false; code: Extract<FrameRenderCode, 'BAD_INPUT' | 'TOO_LARGE'>; rev: number; bytes: number }

/** The rev of a request, for error replies (0 when unreadable). */
export function revOf(input: unknown): number {
  const rev = isPlainObject(input) ? input['rev'] : undefined
  return typeof rev === 'number' && Number.isSafeInteger(rev) && rev >= 0 ? rev : 0
}

export function sanitizeFrameInput(input: unknown): SanitizeResult {
  const rev = revOf(input)
  let bytes: number
  try {
    bytes = utf8Bytes(JSON.stringify(input) ?? '')
  } catch {
    return { ok: false, code: 'BAD_INPUT', rev, bytes: 0 }
  }
  if (bytes > MAX_INPUT_BYTES) return { ok: false, code: 'TOO_LARGE', rev, bytes }
  if (!isPlainObject(input)) return { ok: false, code: 'BAD_INPUT', rev, bytes }
  const i = input as Partial<Record<keyof FrameRenderInput, unknown>>
  const parsed = parseEditorSlug(i.slug)
  const variant = i.variant
  if (!parsed || (variant !== 'a' && variant !== 'b') || i.rev !== rev) return { ok: false, code: 'BAD_INPUT', rev, bytes }
  const slug = i.slug as string

  let draft: SiteLayoutRead | null = null
  if (i.edited === null) {
    // Only the pop-up backdrop asks for a live page, and it is always one of
    // popupContextSlug()'s answers. Anything else would let a caller make the
    // server fetch (and cache) arbitrary slugs.
    if (!isBackdropSlug(parsed)) return { ok: false, code: 'BAD_INPUT', rev, bytes }
  } else {
    const e = i.edited
    if (!isPlainObject(e) || !Array.isArray(e['blocks'])) return { ok: false, code: 'BAD_INPUT', rev, bytes }
    if (e['settings'] !== null && !isPlainObject(e['settings'])) return { ok: false, code: 'BAD_INPUT', rev, bytes }
    const title = typeof e['title'] === 'string' ? e['title'].slice(0, 120) : null
    draft = {
      slug, kind: parsed.kind, title, version: 0,
      blocks: sanitizeBlocks(e['blocks']),
      settings: sanitizeSettings(e['settings'], parsed.kind),
      fonts: sanitizeFonts(e['fonts']),
      publishedAt: null, updatedAt: null,
    }
  }
  return { ok: true, value: { rev, slug, parsed, draft, variant, kit: sanitizeFrameKit(i.kit) }, bytes }
}
